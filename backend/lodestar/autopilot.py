"""AI autopilot: lets the model place PAPER trades on its own, inside limits you set.

Each cycle (every ``interval_seconds`` while allowed by the schedule):
  1. Safety gates: master switch, paper trading enabled, no risk halt, schedule window,
     the autopilot's own daily-loss pause.
  2. Exits for positions the autopilot opened: close when the forecast has turned against
     the position (if enabled) or the holding limit is reached. Stop-loss and take-profit
     brackets placed at entry handle the rest automatically.
  3. Entries: the scanner's qualified candidates (which already passed every rejection rule:
     fresh data, edge after costs, uncertainty, liquidity, earnings, validated model),
     filtered by your minimum score, direction, symbol list, trade and position limits and
     capital budget, sized by the normal risk rules, best score first.
  4. In "approve" mode the same decisions become proposals that wait for your click.

Every decision, including trades it chose not to take, is written to the activity log.
Only the simulated paper account is ever touched. There is no real-money path.
"""
from __future__ import annotations

import logging
import threading
import uuid
from datetime import datetime, time as dtime, timedelta, timezone

from sqlalchemy import func, select

from . import market_hours, scanner
from . import universe as U
from .db import AutopilotEvent, PaperPosition, Watchlist, as_utc, session_scope
from .ml.engine import predictor
from .paper import engine as paper
from .providers.manager import data
from .settings_store import get_settings, update_settings

log = logging.getLogger("lodestar.autopilot")
_lock = threading.Lock()
state = {"last_cycle": None, "last_summary": "", "next_cycle": None, "paused_reason": None, "cycles": 0}


def _now() -> datetime:
    from . import clock
    return clock.now()


def _log(kind: str, reason: str, symbol: str | None = None, qty: float | None = None, price: float | None = None,
         order_id: int | None = None, status: str = "done", payload: dict | None = None) -> dict:
    with session_scope() as s:
        e = AutopilotEvent(kind=kind, symbol=symbol, qty=qty, price=price, reason=reason[:2000], order_id=order_id,
                           status=status, payload=payload or {})
        s.add(e)
        s.flush()
        return event_dict(e)


def event_dict(e: AutopilotEvent) -> dict:
    return {"id": e.id, "ts": as_utc(e.ts).isoformat(), "kind": e.kind, "symbol": e.symbol, "qty": e.qty, "price": e.price,
            "reason": e.reason, "order_id": e.order_id, "status": e.status, "payload": e.payload}


# ----------------------------------------------------------------- schedule
def _hhmm(s: str) -> dtime:
    h, m = s.split(":")
    return dtime(int(h), int(m))


def schedule_allows(cfg: dict, now: datetime | None = None) -> tuple[bool, str]:
    now = now or _now()
    et = now.astimezone(market_hours.ET)
    mode = cfg.get("schedule", "auto")
    if mode == "auto":
        mode = "always" if data.is_simulated() else "market_hours"
    if mode == "always":
        return True, "Runs at any time (simulated prices update around the clock)."
    if mode == "market_hours":
        sess = market_hours.session(now)
        return (sess == "regular", "Inside regular market hours." if sess == "regular" else "Waiting for regular market hours (9:30–16:00 ET).")
    # custom window on chosen weekdays
    if et.weekday() not in cfg.get("days", [0, 1, 2, 3, 4]):
        return False, "Today is not one of the allowed days."
    start, end = _hhmm(cfg.get("custom_start", "09:45")), _hhmm(cfg.get("custom_end", "15:45"))
    ok = start <= et.time() <= end
    return ok, f"Allowed {cfg.get('custom_start')}–{cfg.get('custom_end')} ET." if ok else f"Outside your window ({cfg.get('custom_start')}–{cfg.get('custom_end')} ET)."


# ----------------------------------------------------------------- bookkeeping
def _day_start_utc() -> datetime:
    et = _now().astimezone(market_hours.ET)
    return datetime(et.year, et.month, et.day, tzinfo=market_hours.ET).astimezone(timezone.utc)


def trades_today() -> int:
    with session_scope() as s:
        return s.execute(select(func.count()).select_from(AutopilotEvent).where(
            AutopilotEvent.kind.in_(("buy", "sell")), AutopilotEvent.status == "done",
            AutopilotEvent.ts >= _day_start_utc().replace(tzinfo=None))).scalar() or 0


def owned_positions(snap: dict) -> list[dict]:
    """Positions whose current lot was opened by an autopilot entry."""
    out = []
    with session_scope() as s:
        for p in snap["positions"]:
            opened = datetime.fromisoformat(p["opened_at"])
            e = s.execute(select(AutopilotEvent).where(
                AutopilotEvent.symbol == p["symbol"], AutopilotEvent.kind.in_(("buy", "sell")),
                AutopilotEvent.status == "done", AutopilotEvent.payload["action"].as_string() == "entry",
                AutopilotEvent.ts >= (opened - timedelta(seconds=10)).replace(tzinfo=None))).scalars().first()
            if e:
                out.append({**p, "entry_event": e.id, "entered_at": as_utc(e.ts).isoformat()})
    return out


def _allowed_symbols(cfg: dict) -> set[str] | None:
    if cfg.get("symbols_mode") != "watchlist" or not cfg.get("watchlist_id"):
        return None
    with session_scope() as s:
        w = s.get(Watchlist, int(cfg["watchlist_id"]))
        return {x.upper() for x in (w.symbols if w else [])}


# ----------------------------------------------------------------- how picky
PICKINESS = {
    "strict": {"label": "Strict", "min_score": None,
               "about": "Only ideas that pass every one of the scanner's quality thresholds. Few trades; it can wait days."},
    "balanced": {"label": "Balanced", "min_score": 45.0,
                 "about": "Ideas the model rates positive after costs (expected return > 0.1%, edge > 0.5 points), even if they miss the scanner's stricter thresholds."},
    "active": {"label": "Active", "min_score": 30.0,
               "about": "Any idea with a positive expected result after costs and a better-than-base-rate chance of hitting its target. Most trades, lowest conviction."},
}
_SOFT = ("Expected return after costs", "Probability edge", "Forecast interval", "Model reliability")


def eligible(c: dict, pick: str) -> bool:
    """Is a scanned idea good enough to trade at this pickiness level? Hard safety rules (stale data,
    illiquid, wide spread, earnings blackout, shorting disabled, no model) always apply."""
    if not c["rejected"]:
        return True                       # fully qualified ideas are good enough at every level
    if pick == "strict":
        return False
    soft = _SOFT + (("Technical signals",) if pick == "active" else ())
    if any(not r.startswith(soft) for r in c.get("reasons", [])):
        return False
    net, edge = c.get("net_exp_return") or 0.0, c.get("prob_edge") or 0.0
    if pick == "balanced":
        return net > 0.001 and edge > 0.005
    return net > 0 and edge > 0


def effective_min_score(cfg: dict) -> float:
    cap = PICKINESS.get(cfg.get("pickiness", "balanced"), PICKINESS["balanced"])["min_score"]
    return float(cfg["min_score"]) if cap is None else min(float(cfg["min_score"]), cap)


# ----------------------------------------------------------------- one cycle
def run_cycle(force: bool = False) -> dict:
    """Evaluate exits and entries once. ``force`` skips the schedule (used by "Run now")."""
    if not _lock.acquire(blocking=False):
        return {"skipped": "A cycle is already running."}
    try:
        return _cycle(force)
    finally:
        _lock.release()


def _cycle(force: bool) -> dict:
    st = get_settings()
    cfg = st["autopilot"]
    state["last_cycle"] = datetime.now(timezone.utc).isoformat()     # wall-clock: "last checked 20s ago"
    state["cycles"] += 1
    actions: list[dict] = []
    if not cfg["enabled"] and not force:
        state["last_summary"] = "Autopilot is off."
        return {"actions": actions, "summary": state["last_summary"]}
    if cfg.get("stop_at") and not force:
        try:
            if _now() >= datetime.fromisoformat(cfg["stop_at"]):
                update_settings({"autopilot": {"enabled": False, "stop_at": None}})
                _log("info", "Autopilot switched itself OFF at the stop time you set.")
                state["last_summary"] = "Stopped at the time you chose."
                return {"actions": actions, "summary": state["last_summary"]}
        except ValueError:
            pass
    if cfg.get("pause_until") and not force:
        try:
            until = datetime.fromisoformat(cfg["pause_until"])
            if _now() < until:
                state["last_summary"] = f"Paused by you until {until.astimezone(market_hours.ET):%b %d %H:%M} ET."
                return {"actions": actions, "summary": state["last_summary"]}
            update_settings({"autopilot": {"pause_until": None}})
        except ValueError:
            pass
    if not st["paper"]["trading_enabled"]:
        state["last_summary"] = "Trading is switched off (top bar). The AI will carry on when you switch trading back on."
        return {"actions": actions, "summary": state["last_summary"]}
    ok, why = schedule_allows(cfg)
    if not ok and not force:
        state["last_summary"] = why
        return {"actions": actions, "summary": why}
    snap = paper.snapshot()
    if snap["halted_reason"]:
        state["last_summary"] = f"Account halted: {snap['halted_reason']}"
        return {"actions": actions, "summary": state["last_summary"]}
    if snap["day_pnl_pct"] <= -abs(cfg["stop_on_daily_loss_pct"]):
        state["paused_reason"] = f"Paused for today: down {snap['day_pnl_pct']:.2f}% (your limit is {cfg['stop_on_daily_loss_pct']}%)."
        state["last_summary"] = state["paused_reason"]
        return {"actions": actions, "summary": state["last_summary"]}
    state["paused_reason"] = None
    _expire_proposals(cfg)

    fcs = predictor.predict_all()
    info = predictor.info()
    practice = scanner.practice_mode(st)
    model_ok = bool(info and (info.get("passed") or practice))
    approve = cfg["mode"] == "approve"

    # ---------------- exits
    for p in owned_positions(snap):
        fc = fcs.get(p["symbol"])
        held_days = (_now() - datetime.fromisoformat(p["entered_at"])).total_seconds() / 86400
        reason = None
        if cfg["max_hold_days"] and held_days >= cfg["max_hold_days"] * 7 / 5:     # trading days -> calendar
            reason = f"Held {held_days:.1f} days, past your {cfg['max_hold_days']}-trading-day limit."
        elif cfg["exit_on_signal_flip"] and fc:
            long = p["qty"] > 0
            exp = fc["exp_return"] if long else -fc["exp_return"]
            p_tf = fc["p_target_first_long"] if long else fc["p_target_first_short"]
            breakeven = fc["barrier_stop_atr"] / (fc["barrier_target_atr"] + fc["barrier_stop_atr"])
            if exp < 0 and p_tf < breakeven:
                reason = (f"Forecast turned against the position: expected {exp:+.2%} over {fc['horizon_days']} days, "
                          f"P(target first) {p_tf:.0%}.")
        if reason:
            actions.append(_act(approve, "sell" if p["qty"] > 0 else "buy", p["symbol"], abs(p["qty"]), p["mark"], reason,
                                {"action": "exit"}, cfg))

    # ---------------- entries
    res = scanner.last_result() or {}
    pick = cfg.get("pickiness", "balanced")
    pool = list(res.get("candidates", [])) + list(res.get("rejected", []))   # the scanner keeps rejected ideas separately
    strict_n = len([c for c in pool if not c["rejected"]])
    cands = [c for c in pool if eligible(c, pick)]
    min_score = effective_min_score(cfg)
    allowed = _allowed_symbols(cfg)
    held = {p["symbol"] for p in snap["positions"]}
    pending = _pending_symbols()
    open_auto = len(owned_positions(snap))
    used_today = trades_today()
    eq = snap["equity"]
    auto_value = sum(abs(p["market_value"]) for p in owned_positions(snap))
    skipped: dict[str, int] = {}

    def skip(r: str):
        skipped[r] = skipped.get(r, 0) + 1

    if not info:
        skip("no trained model")
    elif not model_ok:
        skip("model failed validation")
    # ---------------- swap: free a slot for a clearly better idea
    if (cfg.get("rotate_for_better", True) and model_ok and open_auto >= cfg["max_open_positions"]
            and cfg["max_open_positions"] > 0):
        scored = {c["symbol"]: c for c in pool}
        owned = [p for p in owned_positions(snap) if p["symbol"] not in {a.get("symbol") for a in actions}]
        fresh = [c for c in sorted(cands, key=lambda c: -c["score"])
                 if c["symbol"] not in held and c["symbol"] not in pending and c["score"] >= min_score
                 and (c["direction"] == "long" or cfg["allow_short"]) and (allowed is None or c["symbol"] in allowed)]

        def held_score(p):
            c = scored.get(p["symbol"])
            if not c:
                return None                       # not re-scored this time: never swap on missing information
            if (c["direction"] == "long") != (p["qty"] > 0):
                return 0.0                        # the model now favours the opposite direction
            return float(c["score"])

        # only positions held for at least one full trading day can be swapped (avoids churning on noise)
        swappable = [p for p in owned if held_score(p) is not None
                     and (_now() - datetime.fromisoformat(p["entered_at"])).total_seconds() >= 86400]
        if swappable and fresh:
            weakest = min(swappable, key=held_score)
            ws, best = held_score(weakest), fresh[0]
            if best["score"] - ws >= float(cfg.get("rotate_margin", 15.0)):
                note = "its forecast has turned against it" if ws == 0 else f"it now scores {ws:.0f}"
                why = f"Swapped out to make room for {best['symbol']} (score {best['score']:.0f}); {note}."
                act = _act(approve, "sell" if weakest["qty"] > 0 else "buy", weakest["symbol"], abs(weakest["qty"]),
                           weakest["mark"], why, {"action": "exit", "swap_for": best["symbol"]}, cfg)
                actions.append(act)
                if act.get("status") == "done":
                    open_auto -= 1
                    snap = paper.snapshot()
                    eq = snap["equity"]
                    auto_value = sum(abs(p["market_value"]) for p in owned_positions(snap))

    for c in sorted(cands, key=lambda c: -c["score"]):
        if not model_ok:
            break
        if c["score"] < min_score:
            skip(f"score below {min_score:.0f}")
            continue
        if c["direction"] == "short" and not cfg["allow_short"]:
            skip("shorts not allowed")
            continue
        if allowed is not None and c["symbol"] not in allowed:
            skip("not on the chosen watchlist")
            continue
        if c["symbol"] in held or c["symbol"] in pending:
            skip("already held or proposed")
            continue
        if used_today + len([a for a in actions if a.get("action") == "entry"]) >= cfg["max_trades_per_day"]:
            skip("daily trade limit reached")
            continue
        if open_auto >= cfg["max_open_positions"]:
            skip("max open positions reached")
            continue
        price = c["price"]
        qty = int(c["sizing"]["qty"])
        cap_pos = eq * min(cfg["max_position_pct"], st["risk"]["max_position_pct"]) / 100
        qty = min(qty, int(cap_pos // price)) if price > 0 else 0
        budget = eq * cfg["max_capital_pct"] / 100 - auto_value
        qty = min(qty, int(max(0.0, budget) // price)) if price > 0 else 0
        qty = min(qty, int(snap["buying_power"] // price)) if price > 0 else 0
        if qty < 1:
            skip("no capital left within your limits")
            continue
        why = ("[Practice mode: model not validated] " if practice and not info.get("passed") else "") + \
              (f"[{pick.title()}: below the scanner's strict thresholds] " if c["rejected"] else "") + (f"{c['strategy']}: score {c['score']:.0f}, expected {c['net_exp_return']:+.2%} after costs over {c['horizon_days']} days, "
               f"P(target before stop) {c['p_target_first']:.0%} vs {c['base_target_first']:.0%} base rate.")
        a = _act(approve, "buy" if c["direction"] == "long" else "sell", c["symbol"], qty, price, why,
                 {"action": "entry", "stop": round(c["plan"]["stop"], 2), "target": round(c["plan"]["targets"][0], 2),
                  "score": c["score"], "direction": c["direction"]}, cfg)
        actions.append(a)
        if a.get("status") in ("done", "pending"):
            open_auto += 1
            auto_value += qty * price
            held.add(c["symbol"])
    n_entry = len([a for a in actions if a.get("action") == "entry" and a.get("status") == "done"])
    n_exit = len([a for a in actions if a.get("action") == "exit" and a.get("status") == "done"])
    n_prop = len([a for a in actions if a.get("status") == "pending"])
    parts = [f"Found {len(cands)} idea(s) good enough at '{PICKINESS[pick]['label']}' ({strict_n} pass the scanner's strict rules)"]
    if n_entry or n_exit:
        parts.append(f"opened {n_entry}, closed {n_exit}")
    if n_prop:
        parts.append(f"{n_prop} proposal(s) waiting for approval")
    if skipped:
        parts.append("skipped: " + ", ".join(f"{v} {k}" for k, v in sorted(skipped.items(), key=lambda x: -x[1])))
    if not cands:
        parts.append("nothing currently has a positive expected result after costs" if pick != "strict"
                     else "the scanner has nothing that passes its rules right now")
    state["last_summary"] = "; ".join(parts) + "."
    if actions or state.get("_last_logged") != state["last_summary"]:
        _log("info", state["last_summary"], payload={"skipped": skipped})
        state["_last_logged"] = state["last_summary"]
    return {"actions": actions, "summary": state["last_summary"], "skipped": skipped}


def _act(approve: bool, side: str, symbol: str, qty: float, price: float, reason: str, payload: dict, cfg: dict) -> dict:
    if approve:
        e = _log("proposal", reason, symbol, qty, price, status="pending", payload={**payload, "side": side})
        return {**e, "action": payload["action"], "status": "pending"}
    return _execute(side, symbol, qty, price, reason, payload, cfg)


def _execute(side: str, symbol: str, qty: float, price: float, reason: str, payload: dict, cfg: dict) -> dict:
    stop = payload.get("stop") if payload["action"] == "entry" and cfg.get("use_brackets", True) else None
    target = payload.get("target") if payload["action"] == "entry" and cfg.get("use_brackets", True) else None
    try:
        if payload["action"] == "exit":
            o = paper.close_position(symbol, client_order_id=f"auto-{uuid.uuid4().hex[:16]}", note="autopilot exit")
        else:
            o = paper.submit(symbol, side, qty, stop_loss=stop, take_profit=target,
                             client_order_id=f"auto-{uuid.uuid4().hex[:16]}", note=f"autopilot {payload['action']}")
        e = _log(side, reason, symbol, o.get("qty", qty), o.get("filled_price") or price, order_id=o.get("id"), payload=payload)
        return {**e, "action": payload["action"], "status": "done"}
    except paper.OrderError as err:
        e = _log("skip", f"{side} {qty:.0f} {symbol} blocked by risk checks: {'; '.join(err.violations)}", symbol, qty, price,
                 status="done", payload=payload)
        return {**e, "action": payload["action"], "status": "blocked"}


# ----------------------------------------------------------------- approvals
def _pending_symbols() -> set[str]:
    with session_scope() as s:
        return {e.symbol for e in s.execute(select(AutopilotEvent).where(AutopilotEvent.status == "pending")).scalars()}


def _expire_proposals(cfg: dict) -> None:
    cutoff = (_now() - timedelta(minutes=cfg.get("proposal_ttl_minutes", 30))).replace(tzinfo=None)
    with session_scope() as s:
        for e in s.execute(select(AutopilotEvent).where(AutopilotEvent.status == "pending", AutopilotEvent.ts < cutoff)).scalars():
            e.status = "expired"


def decide(event_id: int, approve: bool) -> dict:
    with session_scope() as s:
        e = s.get(AutopilotEvent, event_id)
        if not e or e.status != "pending":
            raise ValueError("This proposal is no longer pending.")
        e.status = "approved" if approve else "rejected"
        p = dict(e.payload)
        sym, qty, price, reason = e.symbol, e.qty, e.price, e.reason
    if not approve:
        return {"status": "rejected"}
    return _execute(p["side"], sym, qty, price, f"Approved by you. {reason}", p, get_settings()["autopilot"])


# ----------------------------------------------------------------- control
def set_enabled(on: bool) -> None:
    update_settings({"autopilot": {"enabled": bool(on), **({} if on else {"pause_until": None})}})
    _log("info", "Autopilot switched ON." if on else "Autopilot switched OFF.")


def pause(minutes: float | None = None, until: str | None = None) -> None:
    """Hold the autopilot off for a while without switching it off (``minutes`` of market time)."""
    if minutes is None and until is None:
        update_settings({"autopilot": {"pause_until": None}})
        _log("info", "Pause cleared: the autopilot is active again.")
        return
    t = _now() + timedelta(minutes=float(minutes)) if minutes is not None else datetime.fromisoformat(until)
    if t.tzinfo is None:
        t = t.replace(tzinfo=timezone.utc)
    update_settings({"autopilot": {"pause_until": t.isoformat()}})
    _log("info", f"Paused by you until {t.astimezone(market_hours.ET):%b %d %H:%M} ET.")


def set_stop_at(at: str | None) -> None:
    if at:
        t = datetime.fromisoformat(at)
        if t.tzinfo is None:
            t = t.replace(tzinfo=timezone.utc)
        update_settings({"autopilot": {"stop_at": t.isoformat()}})
        _log("info", f"Will switch itself off at {t.astimezone(market_hours.ET):%b %d %H:%M} ET.")
    else:
        update_settings({"autopilot": {"stop_at": None}})


def events(limit: int = 200, kind: str | None = None) -> list[dict]:
    with session_scope() as s:
        q = select(AutopilotEvent).order_by(AutopilotEvent.id.desc()).limit(min(limit, 1000))
        if kind == "trades":
            q = q.where(AutopilotEvent.kind.in_(("buy", "sell")))
        elif kind == "pending":
            q = q.where(AutopilotEvent.status == "pending")
        return [event_dict(e) for e in s.execute(q).scalars()]


def status() -> dict:
    cfg = get_settings()["autopilot"]
    ok, why = schedule_allows(cfg)
    snap = paper.snapshot()
    owned = owned_positions(snap)
    with session_scope() as s:
        pnl = 0.0
        # realised P&L of autopilot trades = fills on orders the autopilot placed
        from .db import PaperFill, PaperOrder
        rows = s.execute(select(PaperFill.realized_pnl).join(PaperOrder, PaperOrder.id == PaperFill.order_id)
                         .where(PaperOrder.client_order_id.like("auto-%") | PaperOrder.note.like("autopilot%"))).all()
        pnl = float(sum(r[0] for r in rows))
    return {
        "enabled": cfg["enabled"], "mode": cfg["mode"], "schedule_ok": ok, "schedule_note": why,
        "paused_reason": state.get("paused_reason"), "last_cycle": state["last_cycle"], "last_summary": state["last_summary"],
        "trades_today": trades_today(), "max_trades_per_day": cfg["max_trades_per_day"],
        "open_positions": len(owned), "max_open_positions": cfg["max_open_positions"],
        "invested": sum(abs(p["market_value"]) for p in owned), "unrealized": sum(p["unrealized"] for p in owned),
        "realized": pnl, "pending": len(_pending_symbols()), "positions": owned,
        "model": predictor.info(), "paper_trading_enabled": get_settings()["paper"]["trading_enabled"],
        "pause_until": cfg.get("pause_until"), "stop_at": cfg.get("stop_at"), "now": _now().isoformat(),
        "practice_mode": scanner.practice_mode(), "sandbox": bool(get_settings()["paper"]["sandbox"]),
        "pickiness": cfg.get("pickiness", "balanced"), "pickiness_options": PICKINESS, "effective_min_score": effective_min_score(cfg),
        "next_cycle": state.get("next_cycle"),
        "universe": len(U.universe(get_settings())),
    }
