"""User alert rules evaluated by the live loop, plus system notifications."""
from __future__ import annotations

from . import clock as _clock

from datetime import datetime, timedelta, timezone

from sqlalchemy import select

from .db import Alert, AlertEvent, as_utc, session_scope

KINDS = {
    "price_above": "Price rises above",
    "price_below": "Price falls below",
    "pct_change": "Daily move exceeds ±%",
    "scanner_hit": "Appears in scanner (score ≥)",
    "prob_above": "Target-first probability ≥",
    "data_issue": "Data provider problem",
}


def notify(title: str, body: str = "", level: str = "info", symbol: str | None = None, alert_id: int | None = None) -> dict:
    with session_scope() as s:
        e = AlertEvent(title=title[:160], body=body, level=level, symbol=symbol, alert_id=alert_id)
        s.add(e)
        s.flush()
        return event_dict(e)


def event_dict(e: AlertEvent) -> dict:
    return {"id": e.id, "alert_id": e.alert_id, "ts": as_utc(e.ts).isoformat(), "level": e.level, "title": e.title, "body": e.body,
            "symbol": e.symbol, "read": e.read}


def alert_dict(a: Alert) -> dict:
    return {"id": a.id, "name": a.name, "kind": a.kind, "kind_label": KINDS.get(a.kind, a.kind), "symbol": a.symbol,
            "threshold": a.threshold, "enabled": a.enabled, "cooldown_minutes": a.cooldown_minutes,
            "last_fired_at": as_utc(a.last_fired_at).isoformat() if a.last_fired_at else None,
            "created_at": as_utc(a.created_at).isoformat()}


def _due(a: Alert, now: datetime) -> bool:
    return a.enabled and (a.last_fired_at is None or now - as_utc(a.last_fired_at) > timedelta(minutes=a.cooldown_minutes))


def evaluate_quotes(quotes: dict) -> list[dict]:
    fired = []
    now = _clock.now()
    with session_scope() as s:
        for a in s.execute(select(Alert).where(Alert.kind.in_(("price_above", "price_below", "pct_change")))).scalars():
            if not _due(a, now) or not a.symbol or a.symbol not in quotes or a.threshold is None:
                continue
            q = quotes[a.symbol]
            hit = ((a.kind == "price_above" and q.price >= a.threshold) or (a.kind == "price_below" and q.price <= a.threshold)
                   or (a.kind == "pct_change" and q.change_pct is not None and abs(q.change_pct) >= a.threshold))
            if hit:
                a.last_fired_at = now
                tag = " [SIMULATED]" if q.status.value == "simulated" else ""
                body = f"{a.symbol} at {q.price:.2f} ({q.change_pct:+.2f}% today, {q.status.value}){tag}." if q.change_pct is not None else f"{a.symbol} at {q.price:.2f}."
                e = AlertEvent(alert_id=a.id, title=f"{a.name}", body=body, level="info", symbol=a.symbol)
                s.add(e)
                s.flush()
                fired.append(event_dict(e))
    return fired


def evaluate_scan(result: dict) -> list[dict]:
    fired = []
    now = _clock.now()
    cands = {c["symbol"]: c for c in result.get("candidates", [])}
    with session_scope() as s:
        for a in s.execute(select(Alert).where(Alert.kind.in_(("scanner_hit", "prob_above")))).scalars():
            if not _due(a, now):
                continue
            hits = []
            for sym, c in cands.items():
                if a.symbol and sym != a.symbol:
                    continue
                if a.kind == "scanner_hit" and c["score"] >= (a.threshold or 0):
                    hits.append(f"{sym} {c['direction']} score {c['score']:.0f}")
                if a.kind == "prob_above" and c["p_target_first"] is not None and c["p_target_first"] >= (a.threshold or 0.5):
                    hits.append(f"{sym} {c['direction']} P(target first) {c['p_target_first']:.0%}")
            if hits:
                a.last_fired_at = now
                e = AlertEvent(alert_id=a.id, title=a.name, body="; ".join(hits[:8]), level="info", symbol=a.symbol)
                s.add(e)
                s.flush()
                fired.append(event_dict(e))
    return fired
