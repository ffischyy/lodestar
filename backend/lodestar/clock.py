"""The app's notion of "now".

Normally this is the real UTC time. During a Sandbox historical replay it is the replay's
simulated market time, so every timestamp (orders, fills, autopilot decisions, which bar is
"today") follows the replayed market instead of the wall clock. Nothing here imports the rest
of the app, so any module can use it.
"""
from __future__ import annotations

from datetime import datetime, timezone

_source = None   # an object with ``.active`` and ``.sim_now()`` (the replay controller)


def set_source(src) -> None:
    global _source
    _source = src


def replay_active() -> bool:
    return bool(_source is not None and getattr(_source, "active", False))


def now() -> datetime:
    if replay_active():
        return _source.sim_now()
    return datetime.now(timezone.utc)


def speed() -> float:
    """How many market seconds pass per real second (1 outside replay or while paused)."""
    if replay_active():
        return float(_source.effective_speed())
    return 1.0
