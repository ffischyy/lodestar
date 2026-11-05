"""US equity session clock (NYSE/Nasdaq). Holidays are listed explicitly for 2025-2027."""
from __future__ import annotations

from datetime import date, datetime, time, timezone
from zoneinfo import ZoneInfo

ET = ZoneInfo("America/New_York")


def _now() -> datetime:
    from . import clock
    return clock.now()

HOLIDAYS = {
    date(2025, 1, 1), date(2025, 1, 9), date(2025, 1, 20), date(2025, 2, 17), date(2025, 4, 18), date(2025, 5, 26),
    date(2025, 6, 19), date(2025, 7, 4), date(2025, 9, 1), date(2025, 11, 27), date(2025, 12, 25),
    date(2026, 1, 1), date(2026, 1, 19), date(2026, 2, 16), date(2026, 4, 3), date(2026, 5, 25), date(2026, 6, 19),
    date(2026, 7, 3), date(2026, 9, 7), date(2026, 11, 26), date(2026, 12, 25),
    date(2027, 1, 1), date(2027, 1, 18), date(2027, 2, 15), date(2027, 3, 26), date(2027, 5, 31), date(2027, 6, 18),
    date(2027, 7, 5), date(2027, 9, 6), date(2027, 11, 25), date(2027, 12, 24),
}
EARLY_CLOSE = {date(2025, 7, 3), date(2025, 11, 28), date(2025, 12, 24), date(2026, 11, 27), date(2026, 12, 24), date(2027, 11, 26)}


def is_trading_day(d: date) -> bool:
    return d.weekday() < 5 and d not in HOLIDAYS


def session(now: datetime | None = None) -> str:
    """Return 'pre' | 'regular' | 'post' | 'closed' for the given UTC instant."""
    now = now or _now()
    et = now.astimezone(ET)
    if not is_trading_day(et.date()):
        return "closed"
    t = et.time()
    close = time(13, 0) if et.date() in EARLY_CLOSE else time(16, 0)
    if time(4, 0) <= t < time(9, 30):
        return "pre"
    if time(9, 30) <= t < close:
        return "regular"
    if close <= t < time(20, 0):
        return "post"
    return "closed"


def clock(now: datetime | None = None) -> dict:
    now = now or _now()
    return {"now_utc": now.isoformat(), "now_et": now.astimezone(ET).strftime("%Y-%m-%d %H:%M:%S"),
            "session": session(now), "trading_day": is_trading_day(now.astimezone(ET).date())}
