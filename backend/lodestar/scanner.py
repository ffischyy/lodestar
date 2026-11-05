"""Opportunity scanner: evaluates the universe, applies hard rejection rules, then ranks
survivors with a transparent weighted score. An empty result is a valid result."""
from __future__ import annotations

from . import clock as _clock

import logging
import math
import threading
import time
from datetime import datetime, timedelta, timezone

import numpy as np
import pandas as pd
from sqlalchemy.dialects.sqlite import insert as sqlite_insert

from . import news as news_svc
from . import risk as R
from . import universe as U
from .analysis import evidence, market_context, risks_for, signal_agreement, symbol_signals
from .analytics import indicators as ind
from .db import Prediction, session_scope
from .ml.engine import completed_bars, predictor
from .providers.manager import data
from .settings_store import get_settings

log = logging.getLogger("lodestar.scanner")

COMPONENT_LABELS = {
    "net_expected_return": "Expected net return", "prob_edge": "Probability edge", "reward_risk": "Reward / risk",
    "model_reliability": "Model reliability", "signal_agreement": "Signal agreement", "liquidity": "Liquidity",
    "regime_fit": "Regime fit", "data_quality": "Data quality",
}

STRATEGY_NAMES = {"momentum": "Momentum continuation", "trend": "Trend following", "breakout": "Breakout",
                  "mean_reversion": "Mean reversion", "relative_strength": "Relative strength", "news": "News-driven",
                  "event": "Post-event drift"}

_state = {"result": None, "running": False, "lock": threading.Lock()}


def _clip01(x: float) -> float:
    return 0.0 if not math.isfinite(x) else max(0.0, min(1.0, x))


def evaluate(symbol: str, direction: str, *, df: pd.DataFrame, quote, fc: dict | None, ctx: dict, sigs, prof, st: dict,
             base_rates: dict, positions: dict, equity: float, cash: float) -> dict:
    sc, costs, risk = st["scanner"], st["costs"], st["risk"]
    sgn = 1 if direction == "long" else -1
    reasons: list[str] = []
    price = quote.price if quote else float(df["close"].iloc[-1])
    status = quote.status.value if quote else "historical"
    atr = float(ind.atr(df).iloc[-1])
    cfg = predictor.info() or {"barrier_stop_atr": risk["stop_atr_mult"], "barrier_target_atr": 2.0, "horizon_days": sc["horizon_days"]}
    plan = R.trade_plan(direction, price, atr, cfg["barrier_stop_atr"], cfg["barrier_target_atr"])
    spread = quote.spread_bps if quote else None
    held = positions.get(symbol)
    same_dir = held and ((held["qty"] > 0) == (direction == "long"))
    sizing = R.position_size(equity, plan.entry, plan.stop, risk, cash, costs, spread,
                             existing_value=abs(held["qty"] * held["price"]) if same_dir else 0.0)
    cost = R.cost_estimate(price, sizing["qty"], spread, costs)
    adv = float((df["close"] * df["volume"]).tail(20).mean())
    agree = signal_agreement(sigs, direction)
    flags = {f for s in sigs for f in s.flags}

    if fc:
        exp = fc["exp_return"] * sgn
        p_tf = fc["p_target_first_long"] if sgn > 0 else fc["p_target_first_short"]
        base = base_rates.get("target_first_long" if sgn > 0 else "target_first_short", p_tf)
        prob_edge = p_tf - base
        p_profit = fc["p_up"] if sgn > 0 else 1 - fc["p_up"]
        unc = fc["uncertainty"]
        practice = practice_mode(st)
        rel = fc["reliability"] if (fc["validated"] or practice) else min(fc["reliability"], 0.2)
        mfe, mae = (fc["exp_favorable_excursion"], -fc["exp_adverse_excursion"]) if sgn > 0 else (-fc["exp_adverse_excursion"], fc["exp_favorable_excursion"])
        model_rr = mfe / mae if mae > 0 else 0.0
        q_lo, q_hi = (fc["q10"], fc["q90"]) if sgn > 0 else (-fc["q90"], -fc["q10"])
        asof = pd.Timestamp(fc["asof"])
    else:
        exp = prob_edge = unc = model_rr = 0.0
        p_tf = p_profit = base = float("nan")
        rel = 0.0
        q_lo = q_hi = float("nan")
        asof = df.index[-1]
        reasons.append("No validated model is active (train one on the Models screen).")
    net = exp - cost["round_trip_pct"]

    # ---- hard rejection rules
    if status in ("stale", "cached"):
        reasons.append(f"Price data is {status}.")
    if (pd.Timestamp(df.index[-1]) - asof).days > 4:
        reasons.append("Forecast is older than the latest completed bar (model data stale).")
    if price < sc["min_price"]:
        reasons.append(f"Price {price:.2f} below minimum {sc['min_price']:.2f}.")
    if adv < sc["min_avg_dollar_volume"]:
        reasons.append(f"Average dollar volume ${adv / 1e6:,.1f}M below ${sc['min_avg_dollar_volume'] / 1e6:,.0f}M.")
    if spread is not None and spread > sc["max_spread_bps"]:
        reasons.append(f"Spread {spread:.1f} bps above {sc['max_spread_bps']:.0f} bps.")
    if fc:
        if net * 100 < sc["min_net_expected_return_pct"]:
            reasons.append(f"Expected return after costs {net:+.2%} below {sc['min_net_expected_return_pct']:.2f}%.")
        if prob_edge < sc["min_prob_edge"]:
            reasons.append(f"Probability edge {prob_edge:+.1%} below {sc['min_prob_edge']:.0%} (target-first {p_tf:.0%} vs base {base:.0%}).")
        if unc * 100 > sc["max_uncertainty_pct"]:
            reasons.append(f"Forecast interval {unc:.1%} wider than {sc['max_uncertainty_pct']:.0f}%.")
        if rel < sc["min_model_reliability"] and not practice:
            reasons.append(f"Model reliability {rel:.2f} below {sc['min_model_reliability']:.2f}" + ("" if fc["validated"] else " (model failed validation gates)") + ".")
    if "earnings_imminent" in flags:
        reasons.append("Earnings inside the event blackout window.")
    if direction == "short" and not st["general"]["allow_short"]:
        reasons.append("Short selling disabled in settings.")
    if agree < -0.4:
        reasons.append(f"Technical signals strongly contradict the direction (agreement {agree:+.2f}).")
    if sizing["qty"] < 1:
        reasons.append("Position size rounds to zero under current risk limits.")

    # ---- portfolio concentration (soft)
    notes = []
    sector = U.sector_of(symbol)
    sec_val = sum(abs(p["qty"]) * p["price"] for s, p in positions.items() if U.sector_of(s) == sector)
    if equity > 0 and sec_val / equity * 100 > risk["max_sector_pct"] * 0.8:
        notes.append(f"{sector} exposure already {sec_val / equity:.0%} of equity.")
    if symbol in positions:
        notes.append("Already held in the paper portfolio.")

    reg = ctx["regime"]["values"].get("label", "unknown")
    regime_fit = ctx["regime"]["score"] * sgn
    dq = 1.0 if status in ("live", "delayed", "simulated", "replay", "historical") else 0.4
    dq -= 0.1 * min(3, len(data.bars(symbol)[1].get("issues", [])))
    comps = {
        "net_expected_return": _clip01(net / 0.03),
        "prob_edge": _clip01(prob_edge / 0.10),
        "reward_risk": _clip01(model_rr / 2.0),
        "model_reliability": _clip01(rel),
        "signal_agreement": _clip01((agree + 1) / 2),
        "liquidity": _clip01((math.log10(max(adv, 1)) - 7) / 2),
        "regime_fit": _clip01((regime_fit + 1) / 2),
        "data_quality": _clip01(dq),
    }
    w = sc["weights"]
    tw = sum(w.get(k, 0) for k in comps) or 1
    score = 100 * sum(comps[k] * w.get(k, 0) for k in comps) / tw
    directional = [s for s in sigs if s.key in STRATEGY_NAMES and s.score * sgn > 0.15]
    lead = max(directional, key=lambda s: s.score * sgn, default=None)
    strategy = (STRATEGY_NAMES[lead.key] + " + ML forecast") if lead else "ML forecast"
    ev = evidence(sigs, direction, fc, ctx, symbol)
    return {
        "symbol": symbol, "name": U.meta(symbol)[0] if not prof else prof.name, "sector": sector, "direction": direction,
        "strategy": strategy, "price": price, "data_status": status, "horizon_days": cfg["horizon_days"],
        "exp_return": exp, "net_exp_return": net, "q10": q_lo, "q90": q_hi, "uncertainty": unc,
        "p_profit": p_profit, "p_target_first": p_tf, "base_target_first": base, "prob_edge": prob_edge,
        "reward_risk": plan.reward_risk, "model_reward_risk": model_rr, "model_reliability": rel,
        "signal_agreement": agree, "avg_dollar_volume": adv, "spread_bps": spread, "regime": reg,
        "plan": plan.to_dict(), "sizing": sizing, "costs": cost, "score": round(score, 2),
        "components": {k: round(v, 3) for k, v in comps.items()}, "supporting": ev["supporting"],
        "contradicting": ev["contradicting"], "risks": risks_for(sigs, fc, status, direction), "notes": notes,
        "rejected": bool(reasons), "reasons": reasons, "forecast_asof": asof.isoformat(),
        "signals": {s.key: round(s.score, 3) for s in sigs},
        "next_earnings": prof.next_earnings.isoformat() if prof and prof.next_earnings else None,
    }


def run_scan(log_predictions: bool = True) -> dict:
    with _state["lock"]:
        if _state["running"]:
            return _state["result"] or {}
        _state["running"] = True
    t0 = time.time()
    try:
        st = get_settings()
        from .paper import engine as paper
        acct = paper.snapshot()
        positions = {p["symbol"]: {"qty": p["qty"], "price": p["mark"]} for p in acct["positions"]}
        equity = st["risk"]["account_equity_override"] or acct["equity"]
        cash = acct["buying_power"]
        syms = U.universe(st)
        ctx = market_context(max_age=0)
        fcs = predictor.predict_all(max_age=0)
        info = predictor.info()
        base_rates = {}
        if info:
            from .db import ModelRun
            with session_scope() as s:
                r = s.get(ModelRun, info["run_id"])
                base_rates = (r.metrics or {}).get("label_base_rates", {}) if r else {}
        quotes = data.quotes(syms)
        try:
            news_svc.refresh(syms, 50)
        except Exception as e:
            log.warning("news refresh failed: %s", e)
        all_news = news_svc.query(days=7, limit=2000)
        by_sym: dict[str, list] = {}
        for it in all_news:
            for s in it["symbols"]:
                by_sym.setdefault(s, []).append(it)
        cands, rejected, errors = [], [], []
        for sym in syms:
            try:
                df = completed_bars(data.bars(sym)[0])
                if len(df) < 220:
                    errors.append({"symbol": sym, "error": "insufficient history"})
                    continue
                prof = data.profile(sym)
                sigs = symbol_signals(sym, df, ctx, by_sym.get(sym, []), prof.next_earnings if prof else None)
                for d in (("long", "short") if st["general"]["allow_short"] else ("long",)):
                    c = evaluate(sym, d, df=df, quote=quotes.get(sym), fc=fcs.get(sym), ctx=ctx, sigs=sigs, prof=prof, st=st,
                                 base_rates=base_rates, positions=positions, equity=equity, cash=cash)
                    (rejected if c["rejected"] else cands).append(c)
            except Exception as e:
                log.exception("scan failed for %s", sym)
                errors.append({"symbol": sym, "error": str(e)})
        cands.sort(key=lambda c: -c["score"])
        # keep only the better direction per symbol among rejects to keep the list readable
        best_rej = {}
        for c in rejected:
            k = c["symbol"]
            if k not in best_rej or c["score"] > best_rej[k]["score"]:
                best_rej[k] = c
        rej = sorted(best_rej.values(), key=lambda c: -c["score"])
        from .analysis import jsonable
        res = jsonable({
            "scanned_at": _clock.now().isoformat(), "duration_s": round(time.time() - t0, 2),
            "universe_size": len(syms), "candidates": cands, "rejected": rej, "errors": errors,
            "regime": ctx["regime"], "model": info, "provider": data.provider().name,
            "simulated": data.is_simulated(), "settings": st["scanner"],
            "reason_counts": _reason_counts(rejected),
        })
        if log_predictions and fcs:
            _log_predictions(fcs, quotes)
        _state["result"] = res
        return res
    finally:
        _state["running"] = False


def _reason_counts(rejected: list[dict]) -> list[dict]:
    cats = [("Model reliability", "Model not reliable enough"), ("No validated model", "No model"),
            ("Expected return after costs", "Edge too small after costs"), ("Probability edge", "Probability edge too small"),
            ("Forecast interval", "Forecast too uncertain"), ("Earnings", "Earnings blackout"), ("Price data is", "Stale data"),
            ("Forecast is older", "Stale data"), ("Average dollar volume", "Illiquid"), ("Spread", "Spread too wide"),
            ("Price ", "Price too low"), ("Technical signals", "Signals contradict"), ("Position size", "Size rounds to zero"),
            ("Short selling", "Shorts disabled")]
    counts: dict[str, int] = {}
    for c in rejected:
        seen = set()
        for r in c["reasons"]:
            key = next((lab for pre, lab in cats if r.startswith(pre)), "Other")
            if key not in seen:
                counts[key] = counts.get(key, 0) + 1
                seen.add(key)
    return sorted(({"reason": k, "count": v} for k, v in counts.items()), key=lambda x: -x["count"])


def _log_predictions(fcs: dict, quotes: dict) -> None:
    rows = []
    for sym, f in fcs.items():
        atrp = f["atr_pct"]
        px = f["price_asof"]
        rows.append({"symbol": sym, "asof": pd.Timestamp(f["asof"]).to_pydatetime().replace(tzinfo=None), "horizon_days": f["horizon_days"],
                     "model_run_id": f["model_run_id"], "model_name": f["model"], "source": f["source"], "price": px,
                     "p_up": f["p_up"], "p_target_first": f["p_target_first_long"], "exp_return": f["exp_return"],
                     "q10": f["q10"], "q90": f["q90"], "target_price": px * (1 + f["barrier_target_atr"] * atrp),
                     "stop_price": px * (1 - f["barrier_stop_atr"] * atrp), "created_at": _clock.now()})
    if not rows:
        return
    with session_scope() as s:
        s.execute(sqlite_insert(Prediction).values(rows).on_conflict_do_nothing(
            index_elements=["symbol", "asof", "horizon_days", "model_run_id", "source"]))


def resolve_predictions() -> int:
    """Fill realised outcomes for predictions whose horizon has fully elapsed."""
    from sqlalchemy import select
    from .db import as_utc
    n = 0
    src = data.provider().name
    with session_scope() as s:
        rows = s.execute(select(Prediction).where(Prediction.resolved.is_(False), Prediction.source == src)).scalars().all()
        by_sym: dict[str, list] = {}
        for r in rows:
            by_sym.setdefault(r.symbol, []).append(r)
        for sym, preds in by_sym.items():
            df = completed_bars(data.bars(sym)[0])
            for p in preds:
                asof = pd.Timestamp(as_utc(p.asof))
                after = df[df.index > asof]
                if len(after) < p.horizon_days:
                    continue
                win = after.iloc[:p.horizon_days]
                p.realized_return = float(win["close"].iloc[-1] / p.price - 1)
                hit = "timeout"
                for _, b in win.iterrows():
                    if b.low <= p.stop_price:
                        hit = "stop"
                        break
                    if b.high >= p.target_price:
                        hit = "target"
                        break
                p.hit = hit
                p.resolved = True
                n += 1
    return n


def practice_mode(st: dict | None = None) -> bool:
    """Sandbox practice: let the AI act on a model that has not passed validation (clearly labelled)."""
    from .settings_store import get_settings
    st = st or get_settings()
    return bool(st["paper"].get("sandbox") and st["autopilot"].get("practice_mode"))


def reset_state() -> None:
    """Forget the last scan (used when the data source switches, e.g. entering/leaving a replay)."""
    _state["result"] = None


def last_result() -> dict | None:
    return _state["result"]


def is_running() -> bool:
    return _state["running"]
