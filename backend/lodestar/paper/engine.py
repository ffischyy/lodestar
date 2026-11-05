"""Paper-trading engine: virtual cash, simulated fills against provider quotes, brackets/OCO,
risk checks, halts and a kill switch. No real orders are ever sent anywhere."""
from __future__ import annotations

import logging
import threading
import time
import uuid
from datetime import datetime, timezone

import numpy as np
from sqlalchemy import delete, select

from .. import clock, market_hours
from .. import risk as R
from sqlalchemy import func

from ..db import AutopilotEvent, CashTransfer, EquitySnapshot, PaperAccount, PaperFill, PaperOrder, PaperPosition, as_utc, session_scope
from ..providers.base import DataStatus
from ..providers.manager import data
from ..settings_store import get_settings

log = logging.getLogger("lodestar.paper")
_lock = threading.RLock()
_last_snapshot = [0.0]
USABLE = {DataStatus.LIVE, DataStatus.DELAYED, DataStatus.SIMULATED, DataStatus.REPLAY}


class OrderError(Exception):
    def __init__(self, msg: str, violations: list[str] | None = None):
        super().__init__(msg)
        self.violations = violations or [msg]


def _account(s) -> PaperAccount:
    a = s.execute(select(PaperAccount).order_by(PaperAccount.id)).scalars().first()
    if a is None:
        cash = float(get_settings()["paper"]["starting_cash"])
        a = PaperAccount(starting_cash=cash, cash=cash, peak_equity=cash, day_start_equity=cash, day_key=_day_key())
        s.add(a)
        s.flush()
    return a


def _day_key() -> str:
    return clock.now().astimezone(market_hours.ET).strftime("%Y-%m-%d")


def _positions(s, acct_id: int) -> list[PaperPosition]:
    return list(s.execute(select(PaperPosition).where(PaperPosition.account_id == acct_id)).scalars())


def _marks(symbols: list[str]) -> dict:
    if not symbols:
        return {}
    try:
        return data.quotes(symbols)
    except Exception:
        return {}


def _state(s, acct: PaperAccount, quotes: dict | None = None) -> dict:
    pos = _positions(s, acct.id)
    quotes = quotes if quotes is not None else _marks([p.symbol for p in pos])
    from .. import universe as U
    rows, mv, short_mv = [], 0.0, 0.0
    for p in pos:
        q = quotes.get(p.symbol)
        mark = q.price if q else p.avg_price
        val = p.qty * mark
        mv += val
        if p.qty < 0:
            short_mv += -val
        unreal = (mark - p.avg_price) * p.qty
        rows.append({"symbol": p.symbol, "qty": p.qty, "side": "long" if p.qty > 0 else "short", "avg_price": p.avg_price,
                     "mark": mark, "market_value": val, "unrealized": unreal,
                     "unrealized_pct": (mark / p.avg_price - 1) * (1 if p.qty > 0 else -1) * 100 if p.avg_price else 0,
                     "sector": U.sector_of(p.symbol), "data_status": q.status.value if q else "unavailable",
                     "opened_at": as_utc(p.opened_at).isoformat(), "day_change_pct": q.change_pct if q else None})
    equity = acct.cash + mv
    reserved = 0.0
    for o in s.execute(select(PaperOrder).where(PaperOrder.account_id == acct.id, PaperOrder.status == "open",
                                                PaperOrder.side == "buy", PaperOrder.parent_id.is_(None))).scalars():
        reserved += o.qty * float(o.limit_price or o.stop_price or 0.0)
    return {"positions": rows, "equity": equity, "cash": acct.cash, "market_value": mv, "reserved": reserved,
            "buying_power": max(0.0, acct.cash - short_mv - reserved), "short_market_value": short_mv}


def snapshot() -> dict:
    with _lock, session_scope() as s:
        a = _account(s)
        st = _state(s, a)
        orders = s.execute(select(PaperOrder).where(PaperOrder.account_id == a.id).order_by(PaperOrder.id.desc()).limit(200)).scalars().all()
        fills = s.execute(select(PaperFill).where(PaperFill.account_id == a.id).order_by(PaperFill.id.desc()).limit(200)).scalars().all()
        omap = {o.id: o for o in orders}
        missing = [f.order_id for f in fills if f.order_id not in omap]
        if missing:
            omap.update({o.id: o for o in s.execute(select(PaperOrder).where(PaperOrder.id.in_(missing))).scalars()})
        sett = get_settings()
        unreal = sum(p["unrealized"] for p in st["positions"])
        m = _money(s, a, st)
        return {
            "account_id": a.id, "starting_cash": a.starting_cash, "cash": a.cash, "equity": st["equity"],
            "buying_power": st["buying_power"], "market_value": st["market_value"], "realized_pnl": a.realized_pnl,
            "unrealized_pnl": unreal, "total_pnl": st["equity"] - m["net_deposits"],
            "total_return_pct": (st["equity"] / m["net_deposits"] - 1) * 100 if m["net_deposits"] > 0 else 0.0,
            "money": m, "sandbox": bool(sett["paper"]["sandbox"]),
            "day_pnl": st["equity"] - a.day_start_equity, "day_pnl_pct": (st["equity"] / a.day_start_equity - 1) * 100 if a.day_start_equity else 0,
            "drawdown_pct": (st["equity"] / a.peak_equity - 1) * 100 if a.peak_equity else 0, "peak_equity": a.peak_equity,
            "halted_reason": a.halted_reason, "trading_enabled": sett["paper"]["trading_enabled"],
            "positions": st["positions"],
            "orders": [{**_order_dict(o), "source": order_source(o)} for o in orders],
            "fills": [_fill_dict(f, omap.get(f.order_id), s) for f in fills], "account_label": account_label(),
        }


def _money(s, a: PaperAccount, st: dict) -> dict:
    """Every number someone tracking a brokerage account usually wants, in one place."""
    dep = s.execute(select(func.coalesce(func.sum(CashTransfer.amount), 0.0))
                    .where(CashTransfer.account_id == a.id, CashTransfer.kind == "deposit")).scalar() or 0.0
    wd = s.execute(select(func.coalesce(func.sum(CashTransfer.amount), 0.0))
                   .where(CashTransfer.account_id == a.id, CashTransfer.kind == "withdrawal")).scalar() or 0.0
    fills = s.execute(select(PaperFill).where(PaperFill.account_id == a.id)).scalars().all()
    bought = sum(f.qty * f.price for f in fills if f.side == "buy")
    sold = sum(f.qty * f.price for f in fills if f.side == "sell")
    fees = sum(f.commission for f in fills)
    closes = [f for f in fills if abs(f.realized_pnl + f.commission) > 1e-9]
    wins = [f for f in closes if f.realized_pnl > 0]
    longs = [p for p in st["positions"] if p["qty"] > 0]
    shorts = [p for p in st["positions"] if p["qty"] < 0]
    invested = sum(p["qty"] * p["avg_price"] for p in longs)
    long_value = sum(p["market_value"] for p in longs)
    net_dep = a.starting_cash + dep - wd
    eq = st["equity"]
    return {
        "starting_cash": a.starting_cash, "deposits": dep, "withdrawals": wd, "net_deposits": net_dep,
        "cash": a.cash, "reserved_for_orders": st.get("reserved", 0.0), "available_to_trade": st["buying_power"],
        "invested_cost": invested, "long_market_value": long_value, "short_market_value": -sum(p["market_value"] for p in shorts),
        "equity": eq, "profit": eq - net_dep, "return_pct": (eq / net_dep - 1) * 100 if net_dep > 0 else 0.0,
        "total_bought": bought, "total_sold": sold, "fees_paid": fees, "trades": len(fills), "closed_trades": len(closes),
        "win_rate_pct": len(wins) / len(closes) * 100 if closes else None,
        "cash_pct": a.cash / eq * 100 if eq > 0 else 0.0, "invested_pct": long_value / eq * 100 if eq > 0 else 0.0,
        "open_positions": len(st["positions"]),
    }


def transfers(limit: int = 100) -> list[dict]:
    with session_scope() as s:
        rows = s.execute(select(CashTransfer).order_by(CashTransfer.id.desc()).limit(limit)).scalars().all()
        return [{"id": r.id, "ts": as_utc(r.ts).isoformat(), "kind": r.kind, "amount": r.amount, "sandbox": r.sandbox, "note": r.note}
                for r in rows]


def deposit(amount: float, note: str = "") -> dict:
    """Add play money. Only possible in Sandbox mode; outside it you trade the cash you have."""
    sett = get_settings()["paper"]
    if not sett.get("sandbox"):
        raise OrderError("Deposits are only available in Sandbox mode. Outside Sandbox you can only use the cash already in the account.")
    if not (amount > 0) or amount != amount:
        raise OrderError("Deposit amount must be greater than zero.")
    if amount > float(sett.get("max_sandbox_deposit", 1e9)):
        raise OrderError(f"The largest single deposit is ${float(sett.get('max_sandbox_deposit', 1e9)):,.0f}.")
    amount = round(float(amount), 2)
    with _lock, session_scope() as s:
        a = _account(s)
        a.cash += amount
        a.peak_equity += amount          # a deposit is not a gain: keep drawdown and today's P&L honest
        a.day_start_equity += amount
        s.add(CashTransfer(account_id=a.id, kind="deposit", amount=amount, sandbox=True, note=note[:255]))
    return snapshot()


def withdraw(amount: float, note: str = "") -> dict:
    if not (amount > 0) or amount != amount:
        raise OrderError("Withdrawal amount must be greater than zero.")
    amount = round(float(amount), 2)
    with _lock, session_scope() as s:
        a = _account(s)
        st = _state(s, a)
        if amount > st["buying_power"] + 1e-9:
            raise OrderError(f"You can withdraw at most ${st['buying_power']:,.2f}: the rest is invested or reserved for open orders.")
        a.cash -= amount
        a.peak_equity = max(0.0, a.peak_equity - amount)
        a.day_start_equity = max(0.0, a.day_start_equity - amount)
        s.add(CashTransfer(account_id=a.id, kind="withdrawal", amount=amount,
                           sandbox=bool(get_settings()["paper"].get("sandbox")), note=note[:255]))
    return snapshot()


def _order_dict(o: PaperOrder) -> dict:
    return {"id": o.id, "created_at": as_utc(o.created_at).isoformat(), "client_order_id": o.client_order_id, "symbol": o.symbol,
            "side": o.side, "qty": o.qty, "type": o.order_type, "limit_price": o.limit_price, "stop_price": o.stop_price,
            "status": o.status, "filled_price": o.filled_price, "filled_at": as_utc(o.filled_at).isoformat() if o.filled_at else None,
            "parent_id": o.parent_id, "oco_group": o.oco_group, "bracket_stop": o.bracket_stop, "bracket_target": o.bracket_target, "commission": o.commission, "note": o.note, "data_status": o.data_status}


def order_source(o: PaperOrder | None, parent: PaperOrder | None = None) -> str:
    """Who or what placed an order: you, the AI autopilot, or an automatic bracket exit."""
    if o is None:
        return "you"
    if o.parent_id:
        return "stop-loss" if o.order_type == "stop" else "take-profit"
    if (o.client_order_id or "").startswith("auto-") or (o.note or "").startswith("autopilot"):
        return "ai"
    return "you"


def _reason(s, o: PaperOrder, src: str, parent: PaperOrder | None) -> str:
    if src == "stop-loss":
        return f"Stop-loss at {o.stop_price:.2f} was hit" + (" (protecting an AI trade)" if parent is not None and order_source(parent) == "ai" else "")
    if src == "take-profit":
        return f"Take-profit at {o.limit_price:.2f} was reached" + (" (AI trade)" if parent is not None and order_source(parent) == "ai" else "")
    if src == "ai":
        e = s.execute(select(AutopilotEvent).where(AutopilotEvent.order_id == o.id)).scalars().first()
        return e.reason if e else "Placed by the AI autopilot"
    return o.note or ""


def _fill_dict(f: PaperFill, o: PaperOrder | None = None, s=None) -> dict:
    d = {"id": f.id, "order_id": f.order_id, "ts": as_utc(f.ts).isoformat(), "symbol": f.symbol, "side": f.side, "qty": f.qty,
         "price": f.price, "commission": f.commission, "realized_pnl": f.realized_pnl, "total": f.qty * f.price}
    if o is not None:
        parent = s.get(PaperOrder, o.parent_id) if (s is not None and o.parent_id) else None
        src = order_source(o, parent)
        d.update({"type": o.order_type, "source": src, "reason": _reason(s, o, src, parent) if s is not None else (o.note or ""),
                  "closing": abs(f.realized_pnl + f.commission) > 1e-9, "account": account_label()})
    return d


def account_label() -> str:
    from .. import clock
    if clock.replay_active():
        from ..replay import controller
        try:
            start = controller.days[controller.start_i].date().isoformat()
        except Exception:
            start = "?"
        return f"Practice account (real market data from {start})"
    return "Paper account"


def activity(limit: int = 100) -> dict:
    """What has been traded, by whom, where and why, plus orders still waiting to fill."""
    with _lock, session_scope() as s:
        a = _account(s)
        fills = s.execute(select(PaperFill).where(PaperFill.account_id == a.id).order_by(PaperFill.id.desc()).limit(limit)).scalars().all()
        orders = {o.id: o for o in s.execute(select(PaperOrder).where(PaperOrder.id.in_([f.order_id for f in fills]))).scalars()} if fills else {}
        rows = [_fill_dict(f, orders.get(f.order_id), s) for f in fills]
        working = []
        for o in s.execute(select(PaperOrder).where(PaperOrder.account_id == a.id, PaperOrder.status == "open")
                           .order_by(PaperOrder.id.desc())).scalars():
            parent = s.get(PaperOrder, o.parent_id) if o.parent_id else None
            src = order_source(o, parent)
            working.append({**_order_dict(o), "source": src,
                            "owner": order_source(parent) if parent is not None else src,
                            "trigger": o.stop_price if o.order_type == "stop" else o.limit_price})
        return {"account": account_label(), "fills": rows, "working": working,
                "trading_enabled": get_settings()["paper"]["trading_enabled"]}


# ------------------------------------------------------------------ order flow
def _returns_for(symbols: list[str]) -> dict:
    out = {}
    for s in symbols:
        try:
            c = data.bars(s)[0]["close"]
            out[s] = np.log(c).diff()
        except Exception:
            pass
    return out


def _checks(s, a, symbol, side, qty, price) -> tuple[R.CheckResult, dict]:
    sett = get_settings()
    st = _state(s, a)
    positions = {p["symbol"]: {"qty": p["qty"], "price": p["mark"]} for p in st["positions"]}
    cur = positions.get(symbol, {}).get("qty", 0.0)
    is_exit = (cur > 0 and side == "sell" and qty <= cur + 1e-9) or (cur < 0 and side == "buy" and qty <= -cur + 1e-9)
    rets = _returns_for(list(positions) + [symbol]) if positions else None
    chk = R.pre_trade_checks(symbol=symbol, side=side, qty=qty, price=price, equity=st["equity"], cash=st["buying_power"],
                             positions=positions, risk=sett["risk"], halted_reason=a.halted_reason, is_exit=is_exit,
                             returns=rets, allow_short=sett["general"]["allow_short"], trading_enabled=sett["paper"]["trading_enabled"])
    return chk, st


def _fill_price(q, side: str) -> float:
    costs = get_settings()["costs"]
    slip = costs["slippage_bps"] / 1e4
    if side == "buy":
        base = q.ask if q.ask else q.price * (1 + costs["default_spread_bps"] / 2e4)
        return base * (1 + slip)
    base = q.bid if q.bid else q.price * (1 - costs["default_spread_bps"] / 2e4)
    return base * (1 - slip)


def preview(symbol: str, side: str, qty: float | None, order_type: str = "market", limit_price: float | None = None,
            stop_loss: float | None = None, take_profit: float | None = None) -> dict:
    symbol = symbol.upper()
    q = data.quotes([symbol]).get(symbol)
    if not q:
        raise OrderError(f"No quote available for {symbol}")
    sett = get_settings()
    est = limit_price if order_type == "limit" and limit_price else _fill_price(q, side)
    with _lock, session_scope() as s:
        a = _account(s)
        st = _state(s, a)
        sizing = None
        if stop_loss:
            held = next((p for p in st["positions"] if p["symbol"] == symbol), None)
            same_dir = held and ((held["qty"] > 0) == (side == "buy"))
            sizing = R.position_size(sett["risk"]["account_equity_override"] or st["equity"], est, stop_loss, sett["risk"],
                                     st["buying_power"], sett["costs"], q.spread_bps,
                                     existing_value=abs(held["market_value"]) if same_dir else 0.0)
        use_qty = qty if qty else (sizing["qty"] if sizing else 0)
        chk, _ = _checks(s, a, symbol, side, use_qty, est) if use_qty else (R.CheckResult(False, ["Quantity is zero."]), st)
    warn = list(chk.warnings)
    if q.status not in USABLE:
        chk.violations.append(f"Quote is {q.status.value}; market orders need a fresh price.")
    if stop_loss and ((side == "buy" and stop_loss >= est) or (side == "sell" and stop_loss <= est)):
        chk.violations.append("Stop-loss is on the wrong side of the entry price.")
    if take_profit and ((side == "buy" and take_profit <= est) or (side == "sell" and take_profit >= est)):
        chk.violations.append("Take-profit is on the wrong side of the entry price.")
    cost = R.cost_estimate(est, use_qty, q.spread_bps, sett["costs"])
    risk_amt = abs(est - stop_loss) * use_qty if stop_loss else None
    return {"symbol": symbol, "side": side, "qty": use_qty, "est_price": est, "notional": est * use_qty, "quote": q.to_dict(),
            "sizing": sizing, "costs": cost, "risk_at_stop": risk_amt,
            "reward_at_target": abs(take_profit - est) * use_qty if take_profit else None,
            "ok": not chk.violations, "violations": chk.violations, "warnings": warn + [R.STOP_DISCLAIMER] if stop_loss else warn,
            "simulated_data": q.status in (DataStatus.SIMULATED, DataStatus.REPLAY)}


def submit(symbol: str, side: str, qty: float, order_type: str = "market", limit_price: float | None = None,
           stop_price: float | None = None, stop_loss: float | None = None, take_profit: float | None = None,
           client_order_id: str | None = None, note: str = "") -> dict:
    symbol = symbol.upper()
    if side not in ("buy", "sell"):
        raise OrderError("side must be buy or sell")
    if order_type not in ("market", "limit", "stop"):
        raise OrderError("type must be market, limit or stop")
    if order_type == "limit" and not limit_price:
        raise OrderError("limit orders need a limit price")
    if order_type == "stop" and not stop_price:
        raise OrderError("stop orders need a stop price")
    qty = float(qty)
    if qty <= 0 or qty != int(qty):
        raise OrderError("quantity must be a positive whole number of shares")
    ref = limit_price or stop_price
    if ref is None:
        q0 = data.quotes([symbol]).get(symbol)
        ref = q0.price if q0 else None
    if ref and stop_loss and ((side == "buy" and stop_loss >= ref) or (side == "sell" and stop_loss <= ref)):
        raise OrderError("Stop-loss is on the wrong side of the entry price")
    if ref and take_profit and ((side == "buy" and take_profit <= ref) or (side == "sell" and take_profit >= ref)):
        raise OrderError("Take-profit is on the wrong side of the entry price")
    coid = client_order_id or uuid.uuid4().hex
    with _lock, session_scope() as s:
        dup =s.execute(select(PaperOrder).where(PaperOrder.client_order_id == coid)).scalars().first()
        if dup:
            return {**_order_dict(dup), "duplicate": True}
        a = _account(s)
        _update_halts(s, a)
        q = data.quotes([symbol]).get(symbol)
        if not q:
            raise OrderError(f"No quote for {symbol}")
        est = _fill_price(q, side) if order_type == "market" else (limit_price or stop_price)
        chk, _ = _checks(s, a, symbol, side, qty, est)
        if order_type == "market" and q.status not in USABLE:
            chk.violations.append(f"Quote is {q.status.value}; refusing to fill a market order on it.")
        if not chk.ok or chk.violations:
            s.add(PaperOrder(account_id=a.id, client_order_id=coid, symbol=symbol, side=side, qty=qty, order_type=order_type,
                             limit_price=limit_price, stop_price=stop_price, status="rejected",
                             note="; ".join(chk.violations)[:255], data_status=q.status.value))
            rejection = chk.violations
        else:
            rejection = None
    if rejection:   # raised after commit so the rejected order is kept for the audit trail
        raise OrderError("Order rejected: " + "; ".join(rejection), rejection)
    with _lock, session_scope() as s:
        a = _account(s)
        o = PaperOrder(account_id=a.id, client_order_id=coid, symbol=symbol, side=side, qty=qty, order_type=order_type,
                       limit_price=limit_price, stop_price=stop_price, status="open", note=note[:255], data_status=q.status.value,
                       bracket_stop=stop_loss, bracket_target=take_profit)
        s.add(o)
        s.flush()
        if order_type == "market":
            _fill(s, a, o, _fill_price(q, side))
            _spawn_bracket(s, a, o, stop_loss, take_profit)
        res = _order_dict(o)
        res["warnings"] = chk.warnings
        return res


def _spawn_bracket(s, a, parent: PaperOrder, stop_loss, take_profit):
    if not (stop_loss or take_profit):
        return
    exit_side = "sell" if parent.side == "buy" else "buy"
    grp = f"oco-{parent.id}"
    if stop_loss:
        s.add(PaperOrder(account_id=a.id, client_order_id=f"{parent.client_order_id}-sl", symbol=parent.symbol, side=exit_side,
                         qty=parent.qty, order_type="stop", stop_price=stop_loss, status="open", parent_id=parent.id, oco_group=grp,
                         note="bracket stop-loss"))
    if take_profit:
        s.add(PaperOrder(account_id=a.id, client_order_id=f"{parent.client_order_id}-tp", symbol=parent.symbol, side=exit_side,
                         qty=parent.qty, order_type="limit", limit_price=take_profit, status="open", parent_id=parent.id,
                         oco_group=grp, note="bracket take-profit"))


def _fill(s, a: PaperAccount, o: PaperOrder, price: float) -> None:
    costs = get_settings()["costs"]
    comm = max(costs["min_commission"], costs["commission_per_share"] * o.qty) if costs["commission_per_share"] > 0 else 0.0
    dq = o.qty if o.side == "buy" else -o.qty
    pos = s.execute(select(PaperPosition).where(PaperPosition.account_id == a.id, PaperPosition.symbol == o.symbol)).scalars().first()
    realized = 0.0
    if pos is None:
        pos = PaperPosition(account_id=a.id, symbol=o.symbol, qty=dq, avg_price=price)
        s.add(pos)
    elif pos.qty == 0 or np.sign(pos.qty) == np.sign(dq):
        pos.avg_price = (pos.qty * pos.avg_price + dq * price) / (pos.qty + dq)
        pos.qty += dq
    else:
        closing = min(abs(dq), abs(pos.qty))
        realized = closing * (price - pos.avg_price) * np.sign(pos.qty)
        remaining = pos.qty + dq
        if abs(remaining) < 1e-9:
            s.delete(pos)
        elif np.sign(remaining) != np.sign(pos.qty):
            pos.qty, pos.avg_price, pos.opened_at = remaining, price, clock.now()
        else:
            pos.qty = remaining
    a.cash -= dq * price + comm
    a.realized_pnl += realized - comm
    o.status, o.filled_price, o.filled_at, o.commission = "filled", price, clock.now(), comm
    s.add(PaperFill(account_id=a.id, order_id=o.id, symbol=o.symbol, side=o.side, qty=o.qty, price=price, commission=comm,
                    realized_pnl=float(realized - comm)))
    if o.oco_group:
        for sib in s.execute(select(PaperOrder).where(PaperOrder.oco_group == o.oco_group, PaperOrder.id != o.id,
                                                      PaperOrder.status == "open")).scalars():
            sib.status = "cancelled"
            sib.note = (sib.note + " (OCO sibling filled)")[:255]
    s.flush()


def process_quotes(quotes: dict) -> list[dict]:
    """Match open limit/stop orders against new quotes. Returns fills made."""
    events = []
    with _lock, session_scope() as s:
        a = _account(s)
        enabled = get_settings()["paper"]["trading_enabled"]
        opens = s.execute(select(PaperOrder).where(PaperOrder.account_id == a.id, PaperOrder.status == "open")).scalars().all()
        if not enabled:   # switched off: only protective exits (stop-loss / take-profit) keep working
            opens = [o for o in opens if o.parent_id]
        slip = get_settings()["costs"]["slippage_bps"] / 1e4
        for o in opens:
            q = quotes.get(o.symbol)
            if not q or q.status not in USABLE:
                continue
            px = q.price
            fill = None
            if o.order_type == "limit":
                if o.side == "buy" and (q.ask or px) <= o.limit_price:
                    fill = min(o.limit_price, q.ask or px)
                elif o.side == "sell" and (q.bid or px) >= o.limit_price:
                    fill = max(o.limit_price, q.bid or px)
            elif o.order_type == "stop":
                if o.side == "buy" and px >= o.stop_price:
                    fill = max(px, o.stop_price) * (1 + slip)
                elif o.side == "sell" and px <= o.stop_price:
                    fill = min(px, o.stop_price) * (1 - slip)   # gap-through fills at market, not at the stop
            if fill is None:
                continue
            if o.parent_id:  # exit leg: ensure the position still exists and size matches
                pos = s.execute(select(PaperPosition).where(PaperPosition.account_id == a.id, PaperPosition.symbol == o.symbol)).scalars().first()
                if pos is None:
                    o.status, o.note = "cancelled", (o.note + " (position already closed)")[:255]
                    continue
                o.qty = min(o.qty, abs(pos.qty))
            else:
                chk, _ = _checks(s, a, o.symbol, o.side, o.qty, fill)
                if not chk.ok:
                    o.status, o.note = "rejected", ("; ".join(chk.violations))[:255]
                    continue
            _fill(s, a, o, fill)
            if not o.parent_id:
                _spawn_bracket(s, a, o, o.bracket_stop, o.bracket_target)
            f = s.execute(select(PaperFill).where(PaperFill.order_id == o.id).order_by(PaperFill.id.desc())).scalars().first()
            events.append(_fill_dict(f, o, s) if f else {"order_id": o.id, "symbol": o.symbol, "side": o.side, "qty": o.qty,
                                                         "price": fill, "type": o.order_type})
        _update_halts(s, a, quotes)
        now = clock.now().timestamp()
        every = 900 if clock.replay_active() else 60      # replayed time: one point per 15 market minutes
        if now - _last_snapshot[0] > every or now < _last_snapshot[0]:
            _last_snapshot[0] = now
            st = _state(s, a, quotes)
            s.add(EquitySnapshot(account_id=a.id, equity=st["equity"], cash=a.cash))
    return events


def _update_halts(s, a: PaperAccount, quotes: dict | None = None) -> None:
    st = _state(s, a, quotes)
    eq = st["equity"]
    risk = get_settings()["risk"]
    dk = _day_key()
    if a.day_key != dk:
        a.day_key, a.day_start_equity = dk, eq
        if a.halted_reason and a.halted_reason.startswith("Daily loss"):
            a.halted_reason = None
    a.peak_equity = max(a.peak_equity, eq)
    day = (eq / a.day_start_equity - 1) * 100 if a.day_start_equity else 0
    dd = (eq / a.peak_equity - 1) * 100 if a.peak_equity else 0
    if day <= -risk["max_daily_loss_pct"] and not a.halted_reason:
        a.halted_reason = f"Daily loss limit hit ({day:.2f}% ≤ -{risk['max_daily_loss_pct']}%). Exits only until next session."
    elif dd <= -risk["max_drawdown_pct"] and not a.halted_reason:
        a.halted_reason = f"Max drawdown hit ({dd:.2f}% ≤ -{risk['max_drawdown_pct']}%). Exits only until manually cleared."


def cancel(order_id: int) -> dict:
    with _lock, session_scope() as s:
        o = s.get(PaperOrder, order_id)
        if not o:
            raise OrderError("order not found")
        if o.status != "open":
            raise OrderError(f"order is {o.status}, cannot cancel")
        o.status = "cancelled"
        return _order_dict(o)


def close_position(symbol: str, client_order_id: str | None = None, note: str = "close position") -> dict:
    symbol = symbol.upper()
    with _lock, session_scope() as s:
        a = _account(s)
        pos = s.execute(select(PaperPosition).where(PaperPosition.account_id == a.id, PaperPosition.symbol == symbol)).scalars().first()
        if not pos:
            raise OrderError("no position")
        for o in s.execute(select(PaperOrder).where(PaperOrder.account_id == a.id, PaperOrder.symbol == symbol,
                                                    PaperOrder.status == "open")).scalars():
            o.status = "cancelled"
        qty, side = abs(pos.qty), ("sell" if pos.qty > 0 else "buy")
    return submit(symbol, side, qty, note=note, client_order_id=client_order_id)


def kill_switch(flatten: bool = False) -> dict:
    """Emergency stop: disable trading, cancel every open order, optionally flatten."""
    from ..settings_store import update_settings
    closed = []
    if flatten:
        snap = snapshot()
        for p in snap["positions"]:
            try:
                closed.append(close_position(p["symbol"]))
            except OrderError as e:
                closed.append({"symbol": p["symbol"], "error": str(e)})
    update_settings({"paper": {"trading_enabled": False}, "autopilot": {"enabled": False}})
    n = 0
    with _lock, session_scope() as s:
        for o in s.execute(select(PaperOrder).where(PaperOrder.status == "open")).scalars():
            o.status, o.note = "cancelled", (o.note + " (kill switch)")[:255]
            n += 1
    return {"cancelled": n, "closed": closed, "trading_enabled": False}


def set_trading(on: bool) -> dict:
    """The top-bar Trading switch. Off: no new orders (yours or the AI's) are accepted or filled;
    stop-loss/take-profit exits on positions you already hold keep protecting you, and you can
    still close positions. On: everything resumes, including the AI autopilot if it is switched on."""
    from ..settings_store import update_settings
    update_settings({"paper": {"trading_enabled": bool(on)}})
    return {"trading_enabled": bool(on)}


def clear_halt() -> None:
    with _lock, session_scope() as s:
        a = _account(s)
        a.halted_reason = None
        st = _state(s, a)
        a.peak_equity = st["equity"]


def reset(starting_cash: float | None = None) -> dict:
    with _lock, session_scope() as s:
        s.execute(delete(PaperFill))
        s.execute(delete(CashTransfer))
        s.execute(delete(AutopilotEvent))        # its trades referred to the orders being deleted
        s.execute(delete(PaperOrder))
        s.execute(delete(PaperPosition))
        s.execute(delete(EquitySnapshot))
        s.execute(delete(PaperAccount))
    if starting_cash:
        from ..settings_store import update_settings
        update_settings({"paper": {"starting_cash": float(starting_cash)}})
    return snapshot()


def equity_history() -> list[dict]:
    with session_scope() as s:
        rows = s.execute(select(EquitySnapshot).order_by(EquitySnapshot.ts)).scalars().all()
        return [{"ts": as_utc(r.ts).isoformat(), "equity": r.equity, "cash": r.cash} for r in rows]


def set_sandbox(on: bool) -> dict:
    from ..settings_store import update_settings
    update_settings({"paper": {"sandbox": bool(on)}})
    return snapshot()
