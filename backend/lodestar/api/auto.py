"""Autopilot and turbo-simulator endpoints."""
from __future__ import annotations

from dataclasses import asdict

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import delete, select

from .. import autopilot, turbo
from ..analysis import jsonable
from ..db import TurboRun, as_utc, session_scope
from ..ml.models import METHODS
from ..settings_store import get_settings, update_settings

router = APIRouter(prefix="/api")


# --------------------------------------------------------------- autopilot
@router.get("/autopilot")
def ap_status():
    return jsonable({**autopilot.status(), "settings": get_settings()["autopilot"]})


class APToggle(BaseModel):
    enabled: bool


@router.post("/autopilot/enable")
def ap_enable(t: APToggle):
    autopilot.set_enabled(t.enabled)
    return ap_status()


class APPause(BaseModel):
    minutes: float | None = Field(None, gt=0, le=60 * 24 * 30)
    until: str | None = None
    clear: bool = False


@router.post("/autopilot/pause")
def ap_pause(p: APPause):
    """Hold the AI off for a while (it stays switched on and resumes by itself)."""
    try:
        autopilot.pause(None if p.clear else p.minutes, None if p.clear else p.until)
    except ValueError:
        raise HTTPException(400, "until must be an ISO date-time")
    return ap_status()


class APStopAt(BaseModel):
    at: str | None = None


@router.post("/autopilot/stop-at")
def ap_stop_at(p: APStopAt):
    try:
        autopilot.set_stop_at(p.at)
    except ValueError:
        raise HTTPException(400, "at must be an ISO date-time")
    return ap_status()


class APSettings(BaseModel):
    mode: str | None = None
    schedule: str | None = None
    custom_start: str | None = Field(None, pattern=r"^([01]\d|2[0-3]):[0-5]\d$")
    custom_end: str | None = Field(None, pattern=r"^([01]\d|2[0-3]):[0-5]\d$")
    days: list[int] | None = None
    interval_seconds: int | None = Field(None, ge=10, le=3600)
    min_score: float | None = Field(None, ge=0, le=100)
    max_trades_per_day: int | None = Field(None, ge=0, le=1000)
    max_open_positions: int | None = Field(None, ge=0, le=100)
    max_position_pct: float | None = Field(None, gt=0, le=100)
    max_capital_pct: float | None = Field(None, gt=0, le=100)
    allow_short: bool | None = None
    use_brackets: bool | None = None
    exit_on_signal_flip: bool | None = None
    max_hold_days: int | None = Field(None, ge=0, le=250)
    symbols_mode: str | None = None
    watchlist_id: int | None = None
    stop_on_daily_loss_pct: float | None = Field(None, gt=0, le=50)
    proposal_ttl_minutes: int | None = Field(None, ge=1, le=1440)
    rotate_for_better: bool | None = None
    rotate_margin: float | None = Field(None, ge=0, le=100)
    practice_mode: bool | None = None
    pickiness: str | None = None


@router.patch("/autopilot/settings")
def ap_settings(p: APSettings):
    patch = {k: v for k, v in p.model_dump().items() if v is not None or k == "watchlist_id"}
    if "watchlist_id" in patch and patch["watchlist_id"] is None and "symbols_mode" not in patch:
        patch.pop("watchlist_id")
    if patch.get("pickiness") not in (None, "strict", "balanced", "active"):
        raise HTTPException(400, "pickiness must be strict, balanced or active")
    if patch.get("mode") not in (None, "auto", "approve"):
        raise HTTPException(400, "mode must be auto or approve")
    if patch.get("schedule") not in (None, "auto", "market_hours", "always", "custom"):
        raise HTTPException(400, "schedule must be auto, market_hours, always or custom")
    if patch.get("symbols_mode") not in (None, "universe", "watchlist"):
        raise HTTPException(400, "symbols_mode must be universe or watchlist")
    if patch.get("days") is not None and any(d not in range(7) for d in patch["days"]):
        raise HTTPException(400, "days must be weekday numbers 0 (Mon) to 6 (Sun)")
    update_settings({"autopilot": patch})
    return ap_status()


@router.post("/autopilot/run")
def ap_run():
    """Run one cycle now, even outside the schedule (still inside every risk limit)."""
    return jsonable(autopilot.run_cycle(force=True))


@router.get("/autopilot/events")
def ap_events(limit: int = 200, kind: str | None = None):
    return autopilot.events(limit, kind)


@router.post("/autopilot/proposals/{event_id}")
def ap_decide(event_id: int, approve: bool):
    try:
        return jsonable(autopilot.decide(event_id, approve))
    except ValueError as e:
        raise HTTPException(400, str(e))


@router.get("/methods")
def methods():
    return METHODS


# --------------------------------------------------------------- turbo simulator
class TurboIn(BaseModel):
    mode: str = "monte_carlo"
    strategy: str = "ai"
    markets: int = Field(20, ge=1, le=500)
    symbols: int = Field(200, ge=10, le=3000)
    years: float = Field(8.0, ge=2, le=30)
    pattern_strength: str = "weak"
    horizon_days: int = Field(10, ge=2, le=40)
    stop_atr: float = Field(1.5, gt=0, le=10)
    target_atr: float = Field(2.0, gt=0, le=20)
    min_prob_edge: float = Field(0.03, ge=0, le=0.5)
    max_positions: int = Field(20, ge=1, le=500)
    risk_per_trade_pct: float = Field(0.5, gt=0, le=5)
    max_position_pct: float = Field(10.0, gt=0, le=100)
    slippage_bps: float = Field(5.0, ge=0, le=200)
    spread_bps: float = Field(3.0, ge=0, le=200)
    allow_short: bool = False
    starting_cash: float = Field(100_000.0, ge=100, le=1e9)
    seed: int | None = Field(None, ge=0, le=2**31 - 1)


@router.post("/turbo/run")
def turbo_run(t: TurboIn):
    if t.mode not in ("monte_carlo", "history"):
        raise HTTPException(400, "mode must be monte_carlo or history")
    if t.strategy not in ("ai", "momentum", "reversal", "random"):
        raise HTTPException(400, "strategy must be ai, momentum, reversal or random")
    if t.pattern_strength not in ("none", "weak", "medium"):
        raise HTTPException(400, "pattern_strength must be none, weak or medium")
    if t.markets * t.symbols * t.years > 400_000:
        raise HTTPException(400, "That run is too large for one go (markets × stocks × years must be under 400,000). Reduce one of them.")
    try:
        return {"id": turbo.start_async(turbo.TurboConfig(**t.model_dump()))}
    except RuntimeError as e:
        raise HTTPException(409, str(e))


@router.post("/turbo/cancel")
def turbo_cancel():
    turbo.cancel()
    return {"cancelling": True}


def _run(r: TurboRun, full: bool) -> dict:
    res = r.result or {}
    d = {"id": r.id, "created_at": as_utc(r.created_at).isoformat(), "status": r.status, "progress": r.progress, "error": r.error,
         "config": r.config, "summary": {k: res.get(k) for k in ("trades", "trades_per_minute_engine", "trades_per_minute_total",
                                                                   "median_return_pct", "pct_markets_profitable", "win_rate_pct",
                                                                   "markets_done", "wall_seconds")}}
    if full:
        d["result"] = res
    return d


@router.get("/turbo/runs")
def turbo_runs():
    with session_scope() as s:
        return {"running": turbo.is_running(),
                "runs": [_run(r, False) for r in s.execute(select(TurboRun).order_by(TurboRun.id.desc()).limit(50)).scalars()]}


@router.get("/turbo/runs/{rid}")
def turbo_get(rid: int):
    with session_scope() as s:
        r = s.get(TurboRun, rid)
        if not r:
            raise HTTPException(404, "not found")
        return _run(r, True)


@router.delete("/turbo/runs/{rid}")
def turbo_delete(rid: int):
    with session_scope() as s:
        s.execute(delete(TurboRun).where(TurboRun.id == rid))
    return {"deleted": rid}


@router.get("/turbo/defaults")
def turbo_defaults():
    return asdict(turbo.TurboConfig())
