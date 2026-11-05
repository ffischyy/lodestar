"""Background loops and the WebSocket hub.

Loops (all started in the FastAPI lifespan, each isolated so one failure cannot stop the others):
  quotes     every ``data.quote_poll_seconds`` (>= 30s for Yahoo): refresh quotes, match paper orders,
             evaluate price alerts, broadcast ``quotes`` / ``paper_fill`` / ``alert`` events
  scanner    every ``scanner.interval_minutes``: full scan, broadcast ``scan``
  news       every 10 minutes: ingest provider news
  maintenance every 30 minutes: resolve elapsed predictions, auto-retrain stale models
"""
from __future__ import annotations

import asyncio
import json
import logging
import time
from datetime import datetime, timedelta, timezone

from fastapi import WebSocket
from sqlalchemy import select

from . import alerts, news, scanner
from . import clock as _clock
from . import universe as U
from .db import ModelRun, Watchlist, as_utc, session_scope
from .ml import engine as ml
from .paper import engine as paper
from .providers.manager import data
from .settings_store import get_settings

log = logging.getLogger("lodestar.live")


class Hub:
    def __init__(self):
        self.clients: set[WebSocket] = set()
        self.last_quotes: dict = {}

    async def connect(self, ws: WebSocket):
        await ws.accept()
        self.clients.add(ws)
        if self.last_quotes:
            await ws.send_text(json.dumps({"type": "quotes", "data": self.last_quotes}))

    def disconnect(self, ws: WebSocket):
        self.clients.discard(ws)

    async def broadcast(self, type_: str, payload) -> None:
        if not self.clients:
            return
        msg = json.dumps({"type": type_, "data": payload, "ts": datetime.now(timezone.utc).isoformat()}, default=str)
        dead = []
        for ws in list(self.clients):
            try:
                await ws.send_text(msg)
            except Exception:
                dead.append(ws)
        for ws in dead:
            self.clients.discard(ws)


hub = Hub()
loop_stats: dict[str, dict] = {}


def _stat(name: str, ok: bool, dt: float, err: str | None = None):
    s = loop_stats.setdefault(name, {"runs": 0, "errors": 0, "last_run": None, "last_duration_s": None, "last_error": None})
    s["runs"] += 1
    s["last_run"] = datetime.now(timezone.utc).isoformat()
    s["last_duration_s"] = round(dt, 3)
    if not ok:
        s["errors"] += 1
        s["last_error"] = err


def tracked_symbols() -> list[str]:
    st = get_settings()
    syms = set(U.universe(st)) | set(U.INDEXES) | set(U.SECTOR_ETFS)
    with session_scope() as s:
        for w in s.execute(select(Watchlist)).scalars():
            syms |= {x.upper() for x in (w.symbols or [])}
    try:
        syms |= {p["symbol"] for p in paper.snapshot()["positions"]}
    except Exception:
        pass
    return sorted(syms)


async def quotes_loop():
    while True:
        st = get_settings()["data"]
        interval = float(st["quote_poll_seconds"])
        if data.provider().name == "yahoo":
            interval = max(interval, 30.0)
        if _clock.replay_active():
            interval = 1.0          # replayed time moves fast: keep prices and order fills smooth
        t0 = time.time()
        try:
            syms = tracked_symbols()
            qs = await asyncio.to_thread(data.quotes, syms)
            payload = {s: q.to_dict() for s, q in qs.items()}
            hub.last_quotes = payload
            await hub.broadcast("quotes", payload)
            fills = await asyncio.to_thread(paper.process_quotes, qs)
            for f in fills:
                await hub.broadcast("paper_fill", f)
                who = {"ai": "AI autopilot", "stop-loss": "Stop-loss", "take-profit": "Take-profit"}.get(f.get("source"), "Your order")
                ev = alerts.notify(f"{who}: {f['side']} {f['qty']:.0f} {f['symbol']} at {f['price']:.2f}",
                                   f.get("reason") or f"{f['type']} order filled", "info", f["symbol"])
                await hub.broadcast("alert", ev)
            for ev in await asyncio.to_thread(alerts.evaluate_quotes, qs):
                await hub.broadcast("alert", ev)
            _stat("quotes", True, time.time() - t0)
        except Exception as e:
            log.warning("quotes loop: %s", e)
            _stat("quotes", False, time.time() - t0, str(e))
            await hub.broadcast("provider_error", {"message": str(e)})
        await asyncio.sleep(max(1.0, interval - (time.time() - t0)))


def _replay_due(key: str, every_sim_seconds: float) -> bool:
    """During a replay, run periodic work by *replayed* time, not wall-clock time."""
    now = _clock.now()
    last = _replay_marks.get(key)
    if last is None or now < last or (now - last).total_seconds() >= every_sim_seconds or now.date() != last.date():
        _replay_marks[key] = now
        return True
    return False


_replay_marks: dict = {}


async def scanner_loop():
    await asyncio.sleep(5)
    while True:
        if _clock.replay_active():
            st = get_settings()
            every = min(float(st["scanner"]["interval_minutes"]) * 60, float(st["autopilot"]["interval_seconds"]))
            if ml.predictor.art is None or ml.is_training() or not _replay_due("scan", max(60.0, every)):
                await asyncio.sleep(1.0)
                continue
        t0 = time.time()
        try:
            if ml.predictor.art is None and not ml.is_training():
                await asyncio.sleep(10)
                continue
            if ml.is_training():
                await asyncio.sleep(15)
                continue
            res = await asyncio.to_thread(scanner.run_scan)
            await hub.broadcast("scan", {"scanned_at": res.get("scanned_at"), "candidates": len(res.get("candidates", []))})
            for ev in await asyncio.to_thread(alerts.evaluate_scan, res):
                await hub.broadcast("alert", ev)
            _stat("scanner", True, time.time() - t0)
        except Exception as e:
            log.exception("scanner loop")
            _stat("scanner", False, time.time() - t0, str(e))
        if _clock.replay_active():
            await asyncio.sleep(1.0)
            continue
        st = get_settings()
        wait = float(st["scanner"]["interval_minutes"]) * 60
        if st["autopilot"]["enabled"]:          # keep ideas fresh for the autopilot
            wait = min(wait, max(60.0, float(st["autopilot"]["interval_seconds"])))
        await _sleep_unless_replay(max(60.0, wait))


async def news_loop():
    await asyncio.sleep(3)
    while True:
        t0 = time.time()
        if _clock.replay_active():       # replays have no news feed
            await asyncio.sleep(10)
            continue
        try:
            n = await asyncio.to_thread(news.refresh, U.universe(get_settings()), 50)
            if n:
                await hub.broadcast("news", {"new": n})
            _stat("news", True, time.time() - t0)
        except Exception as e:
            _stat("news", False, time.time() - t0, str(e))
        await asyncio.sleep(600)


async def maintenance_loop():
    await asyncio.sleep(2)
    while True:
        t0 = time.time()
        try:
            await asyncio.to_thread(maybe_auto_train)
            n = await asyncio.to_thread(scanner.resolve_predictions)
            if n:
                await hub.broadcast("predictions_resolved", {"count": n})
            _stat("maintenance", True, time.time() - t0)
        except Exception as e:
            log.exception("maintenance loop")
            _stat("maintenance", False, time.time() - t0, str(e))
        await _sleep_unless_replay(1800, replay_seconds=20)


async def _sleep_unless_replay(seconds: float, replay_seconds: float = 1.0):
    """Sleep, but wake early if a replay starts (replays run their loops on replayed time)."""
    end = time.time() + seconds
    while time.time() < end:
        if _clock.replay_active():
            await asyncio.sleep(replay_seconds)
            return
        await asyncio.sleep(min(2.0, end - time.time()))


def maybe_auto_train() -> int | None:
    """Train if no usable model exists for the active provider or it is older than retrain_days."""
    if ml.is_training():
        return None
    src = data.provider().name
    days = int(get_settings()["model"]["retrain_days"])
    with session_scope() as s:
        r = s.execute(select(ModelRun).where(ModelRun.is_active.is_(True))).scalars().first()
        recent_fail = s.execute(select(ModelRun).where(ModelRun.status == "failed", ModelRun.source == src)
                                .order_by(ModelRun.id.desc())).scalars().first()
        if recent_fail and _clock.now() - as_utc(recent_fail.created_at) < timedelta(hours=6) and (r is None or r.source != src):
            return None
        need = r is None or r.source != src or (_clock.now() - as_utc(r.created_at)) > timedelta(days=days)
    if need:
        log.info("auto-training model for provider %s", src)
        return ml.start_training_async()
    return None


async def autopilot_loop():
    from . import autopilot
    await asyncio.sleep(8)
    while True:
        cfg = get_settings()["autopilot"]
        t0 = time.time()
        replay = _clock.replay_active()
        if replay and not (cfg["enabled"] and _replay_due("autopilot", max(30.0, float(cfg["interval_seconds"])))):
            await asyncio.sleep(0.5)
            continue
        if cfg["enabled"]:
            try:
                res = await asyncio.to_thread(autopilot.run_cycle)
                for a in res.get("actions", []):
                    await hub.broadcast("autopilot", a)
                    if a.get("status") == "done":
                        title = f"Autopilot {a['kind']} {a.get('qty') or 0:.0f} {a.get('symbol')}"
                        await hub.broadcast("alert", alerts.notify(title, a.get("reason", ""), "info", a.get("symbol")))
                    elif a.get("status") == "pending":
                        await hub.broadcast("alert", alerts.notify(f"Autopilot proposes {a['payload'].get('side')} {a.get('qty') or 0:.0f} {a.get('symbol')}",
                                                                   "Approve or reject it on the Autopilot screen.", "info", a.get("symbol")))
                _stat("autopilot", True, time.time() - t0)
            except Exception as e:
                log.exception("autopilot loop")
                _stat("autopilot", False, time.time() - t0, str(e))
        if replay:
            autopilot.state["next_cycle"] = (_clock.now() + timedelta(seconds=float(cfg["interval_seconds"]))).isoformat()
            await asyncio.sleep(0.5)
            continue
        autopilot.state["next_cycle"] = datetime.fromtimestamp(time.time() + float(cfg["interval_seconds"]), timezone.utc).isoformat()
        await _sleep_unless_replay(max(10.0, float(cfg["interval_seconds"])))


async def start_all() -> list[asyncio.Task]:
    return [asyncio.create_task(c(), name=c.__name__) for c in (quotes_loop, scanner_loop, news_loop, maintenance_loop, autopilot_loop)]
