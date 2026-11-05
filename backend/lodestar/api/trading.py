"""Paper trading, portfolio analytics, backtests, strategies and model endpoints."""
from __future__ import annotations

from datetime import datetime, timezone

import numpy as np
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import delete, select

from .. import universe as U
from ..analysis import jsonable
from ..backtest import engine as bt
from ..backtest.strategies import STRATEGIES
from ..db import BacktestRun, ModelRun, PaperFill, PaperOrder, as_utc, session_scope
from ..ml import engine as ml
from ..paper import engine as paper
from ..providers.base import ProviderError
from ..providers.manager import data
from ..settings_store import get_settings, update_settings

router = APIRouter(prefix="/api")


# --------------------------------------------------------------- paper trading
class OrderIn(BaseModel):
    symbol: str
    side: str
    qty: float | None = Field(default=None, gt=0)
    type: str = "market"
    limit_price: float | None = Field(default=None, gt=0)
    stop_price: float | None = Field(default=None, gt=0)
    stop_loss: float | None = Field(default=None, gt=0)
    take_profit: float | None = Field(default=None, gt=0)
    client_order_id: str | None = Field(default=None, max_length=64)
    note: str = ""


@router.get("/paper/account")
def account():
    return jsonable(paper.snapshot())


@router.post("/paper/preview")
def preview(o: OrderIn):
    try:
        return jsonable(paper.preview(o.symbol, o.side, o.qty, o.type, o.limit_price, o.stop_loss, o.take_profit))
    except paper.OrderError as e:
        raise HTTPException(400, {"message": str(e), "violations": e.violations})
    except ProviderError as e:
        raise HTTPException(502, str(e))


@router.post("/paper/orders")
def submit(o: OrderIn):
    if not o.qty:
        raise HTTPException(400, {"message": "Quantity is required", "violations": ["Quantity is required"]})
    try:
        return jsonable(paper.submit(o.symbol, o.side, o.qty, o.type, o.limit_price, o.stop_price, o.stop_loss, o.take_profit,
                                     o.client_order_id, o.note))
    except paper.OrderError as e:
        raise HTTPException(400, {"message": str(e), "violations": e.violations})
    except ProviderError as e:
        raise HTTPException(502, str(e))


@router.delete("/paper/orders/{order_id}")
def cancel(order_id: int):
    try:
        return paper.cancel(order_id)
    except paper.OrderError as e:
        raise HTTPException(400, str(e))


@router.post("/paper/positions/{symbol}/close")
def close(symbol: str):
    try:
        return jsonable(paper.close_position(symbol))
    except paper.OrderError as e:
        raise HTTPException(400, {"message": str(e), "violations": e.violations})


@router.post("/paper/kill")
def kill(flatten: bool = False):
    return jsonable(paper.kill_switch(flatten))


@router.post("/paper/enable")
def enable():
    return paper.set_trading(True)


class TradingIn(BaseModel):
    enabled: bool


@router.post("/paper/trading")
def trading_switch(t: TradingIn):
    """The top-bar Trading on/off switch."""
    return paper.set_trading(t.enabled)


@router.get("/paper/activity")
def activity(limit: int = 100):
    return jsonable(paper.activity(min(max(limit, 1), 500)))


@router.post("/paper/clear-halt")
def clear_halt():
    paper.clear_halt()
    return jsonable(paper.snapshot())


class TransferIn(BaseModel):
    amount: float = Field(gt=0, le=1e9)
    note: str = Field("", max_length=255)


@router.post("/paper/deposit")
def deposit(t: TransferIn):
    try:
        return jsonable(paper.deposit(t.amount, t.note))
    except paper.OrderError as e:
        raise HTTPException(400, str(e))


@router.post("/paper/withdraw")
def withdraw(t: TransferIn):
    try:
        return jsonable(paper.withdraw(t.amount, t.note))
    except paper.OrderError as e:
        raise HTTPException(400, str(e))


@router.get("/paper/transfers")
def transfers():
    return paper.transfers()


class SandboxIn(BaseModel):
    enabled: bool
    simulated_data: bool | None = None   # optionally switch the market data source too


@router.post("/paper/sandbox")
def sandbox(b: SandboxIn):
    from ..replay import controller
    if not b.enabled and controller.active:
        try:
            controller.stop()          # replays only exist inside Sandbox mode
        except ValueError as e:
            raise HTTPException(400, str(e))
    if b.simulated_data is not None:
        from ..settings_store import update_settings
        update_settings({"data": {"provider": "simulation"}} if b.simulated_data else {})
        ml.predictor.reload()
    return jsonable(paper.set_sandbox(b.enabled))


class ResetIn(BaseModel):
    starting_cash: float | None = Field(default=None, ge=100, le=1e9)
    confirm: bool = False


@router.post("/paper/reset")
def reset(r: ResetIn):
    if not r.confirm:
        raise HTTPException(400, "Reset deletes all paper orders, fills and positions. Send confirm=true.")
    return jsonable(paper.reset(r.starting_cash))


# --------------------------------------------------------------- portfolio analytics
@router.get("/portfolio/analytics")
def portfolio():
    snap = paper.snapshot()
    eq = snap["equity"] or 1.0
    st = get_settings()
    hist = paper.equity_history()
    if hist:
        vals = np.array([h["equity"] for h in hist])
        dd = vals / np.maximum.accumulate(vals) - 1
        for h, d in zip(hist, dd):
            h["drawdown"] = float(d)
    sectors: dict[str, dict] = {}
    for p in snap["positions"]:
        s = sectors.setdefault(p["sector"], {"sector": p["sector"], "long": 0.0, "short": 0.0})
        s["long" if p["qty"] > 0 else "short"] += abs(p["market_value"])
    for s in sectors.values():
        s["net_pct"] = (s["long"] - s["short"]) / eq * 100
        s["gross_pct"] = (s["long"] + s["short"]) / eq * 100
    syms = [p["symbol"] for p in snap["positions"]]
    corr, beta = None, None
    if syms:
        rets = {}
        for s in syms + [U.BENCHMARK]:
            try:
                c = ml.completed_bars(data.bars(s)[0])["close"]
                rets[s] = np.log(c).diff().tail(60)
            except Exception:
                pass
        import pandas as pd
        R = pd.DataFrame(rets).dropna()
        if len(syms) > 1 and len(R) > 20:
            cm = R[[s for s in syms if s in R]].corr()
            corr = {"symbols": list(cm.columns), "matrix": [[round(float(x), 3) for x in row] for row in cm.to_numpy()]}
        if len(R) > 20 and U.BENCHMARK in R:
            w = {p["symbol"]: p["market_value"] / eq for p in snap["positions"] if p["symbol"] in R}
            port = sum(R[s] * wt for s, wt in w.items())
            v = R[U.BENCHMARK].var()
            beta = float(port.cov(R[U.BENCHMARK]) / v) if v > 0 else None
    with session_scope() as s:
        fills = s.execute(select(PaperFill).order_by(PaperFill.ts)).scalars().all()
        stops = s.execute(select(PaperOrder).where(PaperOrder.status == "open", PaperOrder.order_type == "stop",
                                                   PaperOrder.parent_id.is_not(None))).scalars().all()
    closing = [f for f in fills if abs(f.realized_pnl + f.commission) > 1e-9]
    wins = [f.realized_pnl for f in closing if f.realized_pnl > 0]
    losses = [f.realized_pnl for f in closing if f.realized_pnl <= 0]
    stop_map = {o.symbol: o.stop_price for o in stops}
    open_risk = 0.0
    unprotected = []
    for p in snap["positions"]:
        sp = stop_map.get(p["symbol"])
        if sp:
            open_risk += max(0.0, (p["mark"] - sp) * p["qty"])
        else:
            unprotected.append(p["symbol"])
    gross = sum(abs(p["market_value"]) for p in snap["positions"])
    net = sum(p["market_value"] for p in snap["positions"])
    risk = st["risk"]
    return jsonable({
        "account": {k: snap[k] for k in ("equity", "cash", "starting_cash", "realized_pnl", "unrealized_pnl", "total_pnl",
                                         "total_return_pct", "day_pnl", "day_pnl_pct", "drawdown_pct", "halted_reason")},
        "equity_history": hist, "sectors": sorted(sectors.values(), key=lambda x: -x["gross_pct"]),
        "exposure": {"gross_pct": gross / eq * 100, "net_pct": net / eq * 100, "long": sum(p["market_value"] for p in snap["positions"] if p["qty"] > 0),
                     "short": -sum(p["market_value"] for p in snap["positions"] if p["qty"] < 0), "positions": len(snap["positions"])},
        "correlation": corr, "beta": beta,
        "risk": {"open_risk_to_stops": open_risk, "open_risk_pct": open_risk / eq * 100, "unprotected_positions": unprotected,
                 "limits": {"max_gross_exposure_pct": risk["max_gross_exposure_pct"], "max_sector_pct": risk["max_sector_pct"],
                            "max_daily_loss_pct": risk["max_daily_loss_pct"], "max_drawdown_pct": risk["max_drawdown_pct"],
                            "max_position_pct": risk["max_position_pct"]}},
        "trade_stats": {"closing_fills": len(closing), "win_rate_pct": len(wins) / len(closing) * 100 if closing else None,
                        "avg_win": float(np.mean(wins)) if wins else None, "avg_loss": float(np.mean(losses)) if losses else None,
                        "profit_factor": float(sum(wins) / -sum(losses)) if losses and sum(losses) < 0 else None,
                        "commissions": float(sum(f.commission for f in fills))},
        "positions": snap["positions"],
    })


# --------------------------------------------------------------- strategies
@router.get("/strategies")
def strategies():
    st = get_settings()["strategies"]
    out = []
    for k, info in STRATEGIES.items():
        cfg = st.get(k, {})
        out.append({**info.__dict__, "enabled": cfg.get("enabled", True), "params": {**info.params, **cfg.get("params", {})},
                    "default_params": info.params})
    return out


class StrategyPatch(BaseModel):
    enabled: bool | None = None
    params: dict | None = None


@router.put("/strategies/{key}")
def update_strategy(key: str, p: StrategyPatch):
    if key not in STRATEGIES:
        raise HTTPException(404, "unknown strategy")
    patch: dict = {}
    if p.enabled is not None:
        patch["enabled"] = p.enabled
    if p.params is not None:
        allowed = STRATEGIES[key].params
        bad = [k for k in p.params if k not in allowed]
        if bad:
            raise HTTPException(400, f"unknown parameter(s): {', '.join(bad)}")
        for k, v in p.params.items():
            if not isinstance(v, (int, float)) or v < 0:
                raise HTTPException(400, f"{k} must be a non-negative number")
        patch["params"] = p.params
    update_settings({"strategies": {key: patch}})
    return strategies()


# --------------------------------------------------------------- backtests
class BacktestIn(BaseModel):
    name: str | None = None
    strategy: str = "momentum"
    params: dict | None = None
    symbols: list[str] | None = None
    start: str | None = None
    end: str | None = None
    initial_capital: float = Field(100_000.0, ge=1000, le=1e9)
    risk_per_trade_pct: float = Field(0.75, gt=0, le=10)
    max_position_pct: float = Field(15.0, gt=0, le=100)
    max_positions: int = Field(10, ge=1, le=100)
    stop_atr: float = Field(1.5, gt=0, le=10)
    target_atr: float = Field(2.0, gt=0, le=20)
    max_hold_days: int = Field(10, ge=1, le=250)
    slippage_bps: float = Field(5.0, ge=0, le=500)
    spread_bps: float = Field(3.0, ge=0, le=500)
    commission_per_share: float = Field(0.0, ge=0, le=1)
    allow_short: bool = False
    oos_fraction: float = Field(0.3, ge=0, lt=1)


def _bt(r: BacktestRun, full: bool) -> dict:
    d = {"id": r.id, "name": r.name, "created_at": as_utc(r.created_at).isoformat(), "status": r.status, "source": r.source,
         "config": r.config, "progress": r.progress, "error": r.error,
         "summary": {k: (r.metrics or {}).get("metrics", {}).get(k) for k in ("total_return_pct", "sharpe", "max_drawdown_pct", "trades", "win_rate_pct")},
         "benchmark_return_pct": (r.metrics or {}).get("benchmark", {}).get("total_return_pct")}
    if full:
        d.update({"results": r.metrics, "equity": r.equity, "trades": r.trades})
    return d


@router.get("/backtests")
def backtests():
    with session_scope() as s:
        return [_bt(r, False) for r in s.execute(select(BacktestRun).order_by(BacktestRun.id.desc()).limit(100)).scalars()]


@router.get("/backtests/{bid}")
def backtest(bid: int):
    with session_scope() as s:
        r = s.get(BacktestRun, bid)
        if not r:
            raise HTTPException(404, "not found")
        return _bt(r, True)


@router.post("/backtests")
def start_backtest(b: BacktestIn):
    if b.strategy not in STRATEGIES:
        raise HTTPException(400, "unknown strategy")
    for d in (b.start, b.end):
        if d:
            try:
                datetime.strptime(d, "%Y-%m-%d")
            except ValueError:
                raise HTTPException(400, "dates must be YYYY-MM-DD")
    if b.start and b.end and b.start >= b.end:
        raise HTTPException(400, "start must be before end")
    cfg = bt.BTConfig(**{k: v for k, v in b.model_dump().items() if k != "name"})
    if cfg.symbols:
        cfg.symbols = [s.upper() for s in cfg.symbols]
    return {"id": bt.start_async(cfg, b.name)}


@router.delete("/backtests/{bid}")
def delete_backtest(bid: int):
    with session_scope() as s:
        s.execute(delete(BacktestRun).where(BacktestRun.id == bid))
    return {"deleted": bid}


# --------------------------------------------------------------- models
def _run(r: ModelRun, full: bool) -> dict:
    m = r.metrics or {}
    d = {"id": r.id, "created_at": as_utc(r.created_at).isoformat(), "finished_at": as_utc(r.finished_at).isoformat() if r.finished_at else None,
         "status": r.status, "source": r.source, "champion": r.champion, "passed": r.passed_validation, "active": r.is_active,
         "progress": r.progress, "message": r.message, "error": r.error, "reliability": m.get("reliability"),
         "baseline_comparison": m.get("baseline_comparison"), "trained_through": m.get("trained_through"),
         "horizon_days": (r.config or {}).get("horizon_days")}
    if full:
        d["metrics"] = m
        d["config"] = r.config
    return d


@router.get("/models")
def models():
    with session_scope() as s:
        runs = [_run(r, False) for r in s.execute(select(ModelRun).order_by(ModelRun.id.desc()).limit(50)).scalars()]
    return {"runs": runs, "training": ml.is_training(), "active": ml.predictor.info(), "provider": data.provider().name}


@router.get("/models/{rid}")
def model(rid: int):
    with session_scope() as s:
        r = s.get(ModelRun, rid)
        if not r:
            raise HTTPException(404, "not found")
        return _run(r, True)


@router.post("/models/train")
def train():
    try:
        return {"id": ml.start_training_async()}
    except RuntimeError as e:
        raise HTTPException(409, str(e))


@router.post("/models/{rid}/activate")
def activate(rid: int):
    from sqlalchemy import update
    with session_scope() as s:
        r = s.get(ModelRun, rid)
        if not r or r.status != "done":
            raise HTTPException(400, "Only completed runs can be activated")
        if r.source != data.provider().name:
            raise HTTPException(400, f"This model was trained on '{r.source}' data; the active provider is '{data.provider().name}'.")
        s.execute(update(ModelRun).values(is_active=False))
        r.is_active = True
    ml.predictor.reload()
    return {"active": rid}
