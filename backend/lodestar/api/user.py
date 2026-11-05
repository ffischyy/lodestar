"""Watchlists, alerts, dashboards, themes, settings, providers, status and diagnostics."""
from __future__ import annotations

import os
import platform
import re
import sys
from datetime import datetime, timezone

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import func, select, update

from .. import __version__, alerts, config, live, scanner
from .. import universe as U
from ..db import (Alert, AlertEvent, BarCache, Dashboard, ModelRun, NewsItem, PaperOrder, Prediction, Theme, Watchlist,
                  as_utc, session_scope)
from ..ml import engine as ml
from ..providers.manager import data
from ..settings_store import get_settings, reset_settings, update_settings

router = APIRouter(prefix="/api")
SYM = re.compile(r"^[A-Z][A-Z0-9.\-]{0,9}$")


def _syms(lst: list[str]) -> list[str]:
    out = []
    for s in lst:
        s = s.upper().strip()
        if not SYM.match(s):
            raise HTTPException(400, f"Invalid symbol '{s}'")
        if s not in out:
            out.append(s)
    return out


# --------------------------------------------------------------- watchlists
class WatchlistIn(BaseModel):
    name: str = Field(min_length=1, max_length=80)
    symbols: list[str] = []


def _wl(w: Watchlist) -> dict:
    return {"id": w.id, "name": w.name, "symbols": w.symbols or [], "sort_order": w.sort_order}


@router.get("/watchlists")
def watchlists():
    with session_scope() as s:
        return [_wl(w) for w in s.execute(select(Watchlist).order_by(Watchlist.sort_order, Watchlist.id)).scalars()]


@router.post("/watchlists")
def create_watchlist(w: WatchlistIn):
    with session_scope() as s:
        n = s.execute(select(func.count()).select_from(Watchlist)).scalar()
        row = Watchlist(name=w.name.strip(), symbols=_syms(w.symbols), sort_order=n)
        s.add(row)
        s.flush()
        return _wl(row)


@router.put("/watchlists/{wid}")
def update_watchlist(wid: int, w: WatchlistIn):
    with session_scope() as s:
        row = s.get(Watchlist, wid)
        if not row:
            raise HTTPException(404, "not found")
        row.name, row.symbols = w.name.strip(), _syms(w.symbols)
        return _wl(row)


@router.delete("/watchlists/{wid}")
def delete_watchlist(wid: int):
    with session_scope() as s:
        row = s.get(Watchlist, wid)
        if row:
            s.delete(row)
    return {"deleted": wid}


# --------------------------------------------------------------- alerts
class AlertIn(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    kind: str
    symbol: str | None = None
    threshold: float | None = None
    enabled: bool = True
    cooldown_minutes: int = Field(60, ge=1, le=10080)


def _validate_alert(a: AlertIn):
    if a.kind not in alerts.KINDS:
        raise HTTPException(400, f"kind must be one of {', '.join(alerts.KINDS)}")
    if a.kind in ("price_above", "price_below", "pct_change") and (not a.symbol or a.threshold is None):
        raise HTTPException(400, "price alerts need a symbol and threshold")
    if a.kind == "prob_above" and a.threshold is not None and not (0 < a.threshold < 1):
        raise HTTPException(400, "probability threshold must be between 0 and 1")
    if a.symbol:
        a.symbol = _syms([a.symbol])[0]


@router.get("/alerts")
def list_alerts():
    with session_scope() as s:
        return {"kinds": alerts.KINDS, "alerts": [alerts.alert_dict(a) for a in s.execute(select(Alert).order_by(Alert.id.desc())).scalars()]}


@router.post("/alerts")
def create_alert(a: AlertIn):
    _validate_alert(a)
    with session_scope() as s:
        row = Alert(**a.model_dump())
        s.add(row)
        s.flush()
        return alerts.alert_dict(row)


@router.put("/alerts/{aid}")
def update_alert(aid: int, a: AlertIn):
    _validate_alert(a)
    with session_scope() as s:
        row = s.get(Alert, aid)
        if not row:
            raise HTTPException(404, "not found")
        for k, v in a.model_dump().items():
            setattr(row, k, v)
        return alerts.alert_dict(row)


@router.delete("/alerts/{aid}")
def delete_alert(aid: int):
    with session_scope() as s:
        row = s.get(Alert, aid)
        if row:
            s.delete(row)
    return {"deleted": aid}


@router.get("/alerts/events")
def events(limit: int = 200, unread_only: bool = False):
    with session_scope() as s:
        q = select(AlertEvent).order_by(AlertEvent.id.desc()).limit(min(limit, 1000))
        if unread_only:
            q = q.where(AlertEvent.read.is_(False))
        unread = s.execute(select(func.count()).select_from(AlertEvent).where(AlertEvent.read.is_(False))).scalar()
        return {"unread": unread, "events": [alerts.event_dict(e) for e in s.execute(q).scalars()]}


@router.post("/alerts/events/read")
def mark_read():
    with session_scope() as s:
        s.execute(update(AlertEvent).values(read=True))
    return {"ok": True}


# --------------------------------------------------------------- dashboards
WIDGETS = {"account", "autopilot", "indices", "sectors", "movers", "regime", "opportunities", "news", "watchlist", "positions", "chart", "equity",
           "alerts", "breadth", "model", "quote"}


class DashboardIn(BaseModel):
    name: str = Field(min_length=1, max_length=80)
    layout: list[dict] = []


def _validate_layout(layout: list[dict]):
    ids = set()
    for w in layout:
        if w.get("widget") not in WIDGETS:
            raise HTTPException(400, f"unknown widget '{w.get('widget')}'")
        for k in ("x", "y", "w", "h"):
            if not isinstance(w.get(k), int) or w[k] < 0 or w[k] > 200:
                raise HTTPException(400, f"widget {k} must be a small non-negative integer")
        if w.get("i") in ids:
            raise HTTPException(400, "duplicate widget id")
        ids.add(w.get("i"))


DEFAULT_LAYOUT = [
    {"i": "w1", "widget": "indices", "x": 0, "y": 0, "w": 12, "h": 4, "config": {}},
    {"i": "w2", "widget": "regime", "x": 0, "y": 4, "w": 4, "h": 6, "config": {}},
    {"i": "w3", "widget": "opportunities", "x": 4, "y": 4, "w": 8, "h": 6, "config": {}},
    {"i": "w4", "widget": "chart", "x": 0, "y": 10, "w": 8, "h": 9, "config": {"symbol": "SPY"}},
    {"i": "w5", "widget": "sectors", "x": 8, "y": 10, "w": 4, "h": 9, "config": {}},
    {"i": "w6", "widget": "movers", "x": 0, "y": 19, "w": 6, "h": 7, "config": {}},
    {"i": "w7", "widget": "news", "x": 6, "y": 19, "w": 6, "h": 7, "config": {}},
]


def _db(d: Dashboard) -> dict:
    return {"id": d.id, "name": d.name, "layout": d.layout, "is_default": d.is_default, "updated_at": as_utc(d.updated_at).isoformat()}


def ensure_default_dashboard():
    with session_scope() as s:
        if not s.execute(select(func.count()).select_from(Dashboard)).scalar():
            s.add(Dashboard(name="Main desk", layout=DEFAULT_LAYOUT, is_default=True))


@router.get("/dashboards")
def dashboards():
    ensure_default_dashboard()
    with session_scope() as s:
        return {"widgets": sorted(WIDGETS), "default_layout": DEFAULT_LAYOUT,
                "dashboards": [_db(d) for d in s.execute(select(Dashboard).order_by(Dashboard.id)).scalars()]}


@router.post("/dashboards")
def create_dashboard(d: DashboardIn):
    _validate_layout(d.layout)
    with session_scope() as s:
        row = Dashboard(name=d.name, layout=d.layout or DEFAULT_LAYOUT)
        s.add(row)
        s.flush()
        return _db(row)


@router.put("/dashboards/{did}")
def update_dashboard(did: int, d: DashboardIn):
    _validate_layout(d.layout)
    with session_scope() as s:
        row = s.get(Dashboard, did)
        if not row:
            raise HTTPException(404, "not found")
        row.name, row.layout = d.name, d.layout
        return _db(row)


@router.post("/dashboards/{did}/duplicate")
def duplicate_dashboard(did: int):
    with session_scope() as s:
        row = s.get(Dashboard, did)
        if not row:
            raise HTTPException(404, "not found")
        new = Dashboard(name=f"{row.name} (copy)"[:80], layout=row.layout)
        s.add(new)
        s.flush()
        return _db(new)


@router.post("/dashboards/{did}/default")
def default_dashboard(did: int):
    with session_scope() as s:
        if not s.get(Dashboard, did):
            raise HTTPException(404, "not found")
        s.execute(update(Dashboard).values(is_default=False))
        s.execute(update(Dashboard).where(Dashboard.id == did).values(is_default=True))
    return dashboards()


@router.post("/dashboards/{did}/restore")
def restore_dashboard(did: int):
    with session_scope() as s:
        row = s.get(Dashboard, did)
        if not row:
            raise HTTPException(404, "not found")
        row.layout = DEFAULT_LAYOUT
        return _db(row)


@router.delete("/dashboards/{did}")
def delete_dashboard(did: int):
    with session_scope() as s:
        if s.execute(select(func.count()).select_from(Dashboard)).scalar() <= 1:
            raise HTTPException(400, "Keep at least one dashboard")
        row = s.get(Dashboard, did)
        if row:
            was_default = row.is_default
            s.delete(row)
            s.flush()
            if was_default:
                first = s.execute(select(Dashboard).order_by(Dashboard.id)).scalars().first()
                first.is_default = True
    return {"deleted": did}


# --------------------------------------------------------------- themes (custom only; built-ins ship with the UI)
class ThemeIn(BaseModel):
    name: str = Field(min_length=1, max_length=80)
    base: str = "meridian"
    tokens: dict


HEX = re.compile(r"^#[0-9a-fA-F]{6}$")


def _theme(t: Theme) -> dict:
    return {"id": t.id, "name": t.name, "base": t.base, "tokens": t.tokens, "updated_at": as_utc(t.updated_at).isoformat()}


def _validate_tokens(tokens: dict):
    if len(tokens) > 200:
        raise HTTPException(400, "too many tokens")
    for k, v in tokens.items():
        if not re.match(r"^[a-zA-Z0-9\-]{1,48}$", k):
            raise HTTPException(400, f"invalid token name {k}")
        if not isinstance(v, (str, int, float)) or (isinstance(v, str) and (len(v) > 120 or any(c in v for c in "<>{};"))):
            raise HTTPException(400, f"invalid value for {k}")


@router.get("/themes")
def themes():
    with session_scope() as s:
        return [_theme(t) for t in s.execute(select(Theme).order_by(Theme.id)).scalars()]


@router.post("/themes")
def create_theme(t: ThemeIn):
    _validate_tokens(t.tokens)
    with session_scope() as s:
        row = Theme(name=t.name, base=t.base, tokens=t.tokens)
        s.add(row)
        s.flush()
        return _theme(row)


@router.put("/themes/{tid}")
def update_theme(tid: int, t: ThemeIn):
    _validate_tokens(t.tokens)
    with session_scope() as s:
        row = s.get(Theme, tid)
        if not row:
            raise HTTPException(404, "not found")
        row.name, row.base, row.tokens = t.name, t.base, t.tokens
        return _theme(row)


@router.delete("/themes/{tid}")
def delete_theme(tid: int):
    with session_scope() as s:
        row = s.get(Theme, tid)
        if row:
            s.delete(row)
    return {"deleted": tid}


# --------------------------------------------------------------- settings
@router.get("/settings")
def settings():
    return {"settings": get_settings(), "defaults": config.DEFAULT_SETTINGS, "default_universe": list(U.DEFAULT_UNIVERSE)}


@router.patch("/settings")
def patch_settings(patch: dict):
    if "universe" in patch and isinstance(patch["universe"], dict) and "symbols" in patch["universe"]:
        patch["universe"]["symbols"] = _syms(patch["universe"]["symbols"])
    prev = get_settings()["data"]["provider"]
    try:
        st = update_settings(patch)
    except ValueError as e:
        raise HTTPException(400, str(e))
    if st["data"]["provider"] != prev:
        ml.predictor.reload()
        scanner._state["result"] = None
        from .. import analysis
        analysis._ctx_cache = None
        live.maybe_auto_train()
    return {"settings": st}


@router.post("/settings/reset")
def reset(section: str | None = None):
    return {"settings": reset_settings(section)}


# --------------------------------------------------------------- providers
class KeysIn(BaseModel):
    ALPACA_API_KEY_ID: str | None = None
    ALPACA_API_SECRET_KEY: str | None = None
    ANTHROPIC_API_KEY: str | None = None


PROVIDERS = [
    {"name": "alpaca", "label": "Alpaca Market Data", "kind": "Real-time (IEX venue on free plan)", "keys": ["ALPACA_API_KEY_ID", "ALPACA_API_SECRET_KEY"],
     "signup": "https://alpaca.markets", "limits": "Free plan: 200 requests/min, IEX real-time, consolidated history delayed 15 min, news included.",
     "caveats": "IEX is a single exchange (a few % of volume): prices are real but volume and bid/ask are partial. Fundamentals come from Yahoo."},
    {"name": "yahoo", "label": "Yahoo Finance (unofficial)", "kind": "Delayed", "keys": [], "signup": None,
     "limits": "No key; unofficial access that Yahoo may throttle or break. Quotes polled every 30 s at most.",
     "caveats": "Treated as delayed data. For personal research only — check Yahoo's terms of service."},
    {"name": "simulation", "label": "Simulation", "kind": "Synthetic", "keys": [], "signup": None,
     "limits": "Unlimited, offline.", "caveats": "Generated prices for learning the app. Never real market data."},
]


@router.get("/providers")
def providers():
    active = get_settings()["data"]["provider"]
    keys = {k: {"set": bool(config.get_secret(k)), "masked": config.mask(config.get_secret(k))} for k in config.SECRET_KEYS}
    return {"active": active, "effective": data.provider().name, "providers": PROVIDERS, "keys": keys,
            "status": data.status(), "alpaca_feed": get_settings()["data"]["alpaca_feed"]}


@router.put("/providers/keys")
def set_keys(k: KeysIn):
    for name, v in k.model_dump().items():
        if v is None:
            continue
        v = v.strip()
        if v and (len(v) > 200 or not re.match(r"^[A-Za-z0-9_\-]+$", v)):
            raise HTTPException(400, f"{name} contains unexpected characters")
        config.set_secret(name, v or None)
    data.provider()  # rebuild if keys changed
    ml.predictor.reload()
    return providers()


@router.post("/providers/test")
def test_provider(name: str):
    if name not in ("alpaca", "yahoo", "simulation"):
        raise HTTPException(400, "unknown provider")
    return data.test_connection(name)


# --------------------------------------------------------------- status & diagnostics
@router.get("/status")
def status():
    info = ml.predictor.info()
    with session_scope() as s:
        unread = s.execute(select(func.count()).select_from(AlertEvent).where(AlertEvent.read.is_(False))).scalar()
        running = s.execute(select(ModelRun).where(ModelRun.status == "running").order_by(ModelRun.id.desc())).scalars().first()
    p = data.provider()
    return {"version": __version__, "provider": p.name, "provider_label": p.label, "simulated": p.name == "simulation",
            "quote_status": p.quote_status.value, "clock": data.status()["clock"], "model": info, "training": ml.is_training(),
            "training_run": {"id": running.id, "progress": running.progress, "message": running.message} if running else None,
            "scanner_running": scanner.is_running(), "unread_alerts": unread,
            "paper_trading_enabled": get_settings()["paper"]["trading_enabled"], "live_trading_enabled": False,
            "sandbox": bool(get_settings()["paper"]["sandbox"]), "autopilot_enabled": bool(get_settings()["autopilot"]["enabled"]),
            "autopilot_mode": get_settings()["autopilot"]["mode"],
            "autopilot_paused_until": get_settings()["autopilot"].get("pause_until"),
            "replay": _replay_brief()}


def _replay_brief() -> dict:
    from ..replay import controller
    st = controller.state()
    return {k: st.get(k) for k in ("active", "status", "speed", "playing", "sim_time_et", "current_date", "progress",
                                   "message", "simulated_history", "source_label", "day_progress")}


@router.get("/health")
def health():
    db_path = config.DB_URL.replace("sqlite:///", "")
    size = os.path.getsize(db_path) if os.path.exists(db_path) else None
    counts = {}
    with session_scope() as s:
        for name, model in (("bars", BarCache), ("predictions", Prediction), ("news", NewsItem), ("orders", PaperOrder),
                            ("model_runs", ModelRun), ("alert_events", AlertEvent)):
            counts[name] = s.execute(select(func.count()).select_from(model)).scalar()
    log_file = config.LOG_DIR / "lodestar.log"
    tail = []
    if log_file.exists():
        with open(log_file, "rb") as f:
            f.seek(max(0, os.path.getsize(log_file) - 20000))
            tail = f.read().decode("utf-8", "replace").splitlines()[-80:]
    import numpy, pandas, sklearn, fastapi
    return {"time": datetime.now(timezone.utc).isoformat(), "version": __version__, "data": data.status(),
            "loops": live.loop_stats, "ws_clients": len(live.hub.clients), "db": {"path": db_path, "size_bytes": size, "rows": counts},
            "model": ml.predictor.info(), "training": ml.is_training(),
            "scanner": {"running": scanner.is_running(), "last": (scanner.last_result() or {}).get("scanned_at"),
                        "last_duration_s": (scanner.last_result() or {}).get("duration_s"), "errors": (scanner.last_result() or {}).get("errors")},
            "versions": {"python": sys.version.split()[0], "platform": platform.platform(), "numpy": numpy.__version__,
                         "pandas": pandas.__version__, "scikit_learn": sklearn.__version__, "fastapi": fastapi.__version__},
            "paths": {"data_dir": str(config.DATA_DIR), "env_file": str(config.ENV_FILE)}, "log_tail": tail}
