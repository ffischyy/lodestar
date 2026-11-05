"""Provider manager: selection, rate limiting, retries, caching, freshness labels, health."""
from __future__ import annotations

import logging
import threading
import time
from collections import deque
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone

import pandas as pd
from sqlalchemy import select
from sqlalchemy.dialects.sqlite import insert as sqlite_insert

from .. import config, market_hours
from ..db import BarCache, session_scope
from ..settings_store import get_settings
from .base import BAR_COLUMNS, DataStatus, MarketDataProvider, NewsArticle, Profile, ProviderError, Quote, validate_bars
from .simulated import SimulatedProvider

log = logging.getLogger("lodestar.data")


class RateLimiter:
    """Token bucket; blocks briefly instead of letting the provider return 429s."""

    def __init__(self, per_minute: int):
        self.capacity = max(1, per_minute)
        self.tokens = float(self.capacity)
        self.rate = self.capacity / 60.0
        self.t = time.monotonic()
        self.lock = threading.Lock()
        self.waits = 0

    def acquire(self, max_wait: float = 20.0) -> None:
        deadline = time.monotonic() + max_wait
        while True:
            with self.lock:
                now = time.monotonic()
                self.tokens = min(self.capacity, self.tokens + (now - self.t) * self.rate)
                self.t = now
                if self.tokens >= 1:
                    self.tokens -= 1
                    return
                need = (1 - self.tokens) / self.rate
            if time.monotonic() + need > deadline:
                raise ProviderError("Local rate limit budget exhausted; request deferred", retryable=True, status=429)
            self.waits += 1
            time.sleep(min(need, 1.0))


@dataclass
class Health:
    calls: int = 0
    errors: int = 0
    rate_limited: int = 0
    last_success: datetime | None = None
    last_error: str | None = None
    last_error_at: datetime | None = None
    latency_ms: deque = field(default_factory=lambda: deque(maxlen=200))
    calls_window: deque = field(default_factory=lambda: deque(maxlen=2000))
    events: deque = field(default_factory=lambda: deque(maxlen=100))

    def to_dict(self) -> dict:
        now = time.time()
        lat = sorted(self.latency_ms)
        return {
            "calls": self.calls, "errors": self.errors, "rate_limited": self.rate_limited,
            "calls_last_min": sum(1 for t in self.calls_window if now - t < 60),
            "last_success": self.last_success.isoformat() if self.last_success else None,
            "last_error": self.last_error, "last_error_at": self.last_error_at.isoformat() if self.last_error_at else None,
            "latency_p50_ms": lat[len(lat) // 2] if lat else None,
            "latency_p95_ms": lat[int(len(lat) * 0.95)] if lat else None,
            "events": list(self.events)[-30:],
        }


class DataManager:
    def __init__(self):
        self._lock = threading.RLock()
        self._provider: MarketDataProvider | None = None
        self._provider_sig: tuple | None = None
        self._limiter: RateLimiter | None = None
        self.health: dict[str, Health] = {}
        self._quotes: dict[str, tuple[float, Quote]] = {}
        self._frames: dict[tuple, tuple[float, pd.DataFrame, dict]] = {}
        self._profiles: dict[str, tuple[float, Profile]] = {}
        self._sim = SimulatedProvider()
        self._yahoo_fallback = None

    # ---------------------------------------------------------- provider selection
    def provider(self) -> MarketDataProvider:
        from .. import clock
        if clock.replay_active():
            from ..replay import controller
            return controller.provider
        s = get_settings()["data"]
        name = s["provider"]
        sig = (name, s.get("alpaca_feed"), config.get_secret("ALPACA_API_KEY_ID"), config.get_secret("ALPACA_API_SECRET_KEY"))
        with self._lock:
            if self._provider is None or sig != self._provider_sig:
                self._provider = self._build(name, s)
                self._provider_sig = sig
                self._limiter = RateLimiter(self._provider.rate_limit_per_min)
                self._quotes.clear()
                self._frames.clear()
                self._event(self._provider.name, "info", f"Active provider: {self._provider.label}")
            return self._provider

    def _build(self, name: str, s: dict) -> MarketDataProvider:
        if name == "alpaca":
            from .alpaca import AlpacaProvider
            try:
                return AlpacaProvider(config.get_secret("ALPACA_API_KEY_ID") or "", config.get_secret("ALPACA_API_SECRET_KEY") or "",
                                      feed=s.get("alpaca_feed", "iex"))
            except ProviderError as e:
                self._event("alpaca", "error", f"{e} — falling back to SIMULATION (clearly labelled)")
                return self._sim
        if name == "yahoo":
            from .yahoo import YahooProvider
            return YahooProvider()
        return self._sim

    @property
    def sim(self) -> SimulatedProvider:
        return self._sim

    def is_local(self, p: MarketDataProvider) -> bool:
        """Providers that generate data in-process (no rate limits, no bar cache)."""
        return p is self._sim or p.name == "replay"

    def reset_caches(self) -> None:
        with self._lock:
            self._quotes.clear()
            self._frames.clear()
            self._profiles.clear()

    def is_simulated(self) -> bool:
        return self.provider().name == "simulation"

    def _h(self, name: str) -> Health:
        return self.health.setdefault(name, Health())

    def _event(self, name: str, level: str, msg: str) -> None:
        self._h(name).events.append({"ts": datetime.now(timezone.utc).isoformat(), "level": level, "msg": msg})
        getattr(log, "error" if level == "error" else "info")(f"[{name}] {msg}")

    def call(self, fn, *args, provider: MarketDataProvider | None = None, attempts: int = 3):
        p = provider or self.provider()
        h = self._h(p.name)
        delay = 0.6
        for i in range(attempts):
            if not self.is_local(p) and self._limiter:
                self._limiter.acquire()
            t0 = time.perf_counter()
            h.calls += 1
            h.calls_window.append(time.time())
            try:
                res = fn(*args)
                h.latency_ms.append(round((time.perf_counter() - t0) * 1000, 1))
                h.last_success = datetime.now(timezone.utc)
                return res
            except ProviderError as e:
                h.errors += 1
                h.last_error, h.last_error_at = str(e), datetime.now(timezone.utc)
                if e.status == 429:
                    h.rate_limited += 1
                if not e.retryable or i == attempts - 1:
                    self._event(p.name, "error", str(e))
                    raise
                time.sleep(delay)
                delay *= 2.5
            except Exception as e:  # unexpected adapter bug: surface, do not retry forever
                h.errors += 1
                h.last_error, h.last_error_at = f"{type(e).__name__}: {e}", datetime.now(timezone.utc)
                self._event(p.name, "error", h.last_error)
                raise ProviderError(h.last_error, retryable=False) from e

    # ---------------------------------------------------------- bars
    def bars(self, symbol: str, timeframe: str = "1D", lookback_days: int | None = None) -> tuple[pd.DataFrame, dict]:
        symbol = symbol.upper()
        p = self.provider()
        years = get_settings()["data"].get("history_years", 5)
        lookback_days = lookback_days or int(365 * years)
        key = (p.name, symbol, timeframe, lookback_days)
        ttl = 1.0 if p.name == "replay" else 20 if p is self._sim else (300 if timeframe == "1D" else 60)
        with self._lock:
            hit = self._frames.get(key)
            if hit and time.time() - hit[0] < ttl:
                return hit[1], hit[2]
        from .. import clock
        end = clock.now()
        start = end - timedelta(days=lookback_days)
        meta = {"symbol": symbol, "timeframe": timeframe, "source": p.name, "issues": [],
                "status": DataStatus.SIMULATED.value if p is self._sim else DataStatus.REPLAY.value if p.name == "replay" else DataStatus.HISTORICAL.value,
                "fetched_at": end.isoformat()}
        if self.is_local(p):
            df = p.get_bars(symbol, timeframe, start, end)
        elif timeframe == "1D":
            df = self._daily_with_cache(p, symbol, start, end, meta)
        else:
            df = self.call(p.get_bars, symbol, timeframe, start, end)
        df, issues = validate_bars(df)
        meta["issues"] += issues
        meta["bars"] = len(df)
        meta["last_bar"] = df.index[-1].isoformat() if len(df) else None
        with self._lock:
            self._frames[key] = (time.time(), df, meta)
        return df, meta

    def _daily_with_cache(self, p, symbol, start, end, meta) -> pd.DataFrame:
        cached = self._read_cache(p.name, symbol, start)
        fetch_from = start
        if len(cached):
            last = cached.index[-1]
            first = cached.index[0]
            if first <= pd.Timestamp(start) + pd.Timedelta(days=7):
                fetch_from = (last - pd.Timedelta(days=5)).to_pydatetime()   # re-pull recent bars (revisions, partial day)
        try:
            fresh = self.call(p.get_bars, symbol, "1D", fetch_from, end)
            fresh, _ = validate_bars(fresh)
            if len(fresh):
                self._write_cache(p.name, symbol, fresh)
            df = pd.concat([cached[cached.index < fresh.index[0]], fresh]) if len(cached) and len(fresh) else (fresh if len(fresh) else cached)
        except ProviderError as e:
            if not len(cached):
                raise
            meta["status"] = DataStatus.CACHED.value
            meta["issues"].append(f"provider unavailable, serving cache: {e}")
            df = cached
        return df

    def _read_cache(self, source, symbol, start) -> pd.DataFrame:
        with session_scope() as s:
            rows = s.execute(select(BarCache.ts, BarCache.open, BarCache.high, BarCache.low, BarCache.close, BarCache.volume)
                             .where(BarCache.source == source, BarCache.symbol == symbol, BarCache.timeframe == "1D",
                                    BarCache.ts >= start.replace(tzinfo=None) if start.tzinfo else start)
                             .order_by(BarCache.ts)).all()
        if not rows:
            return pd.DataFrame(columns=BAR_COLUMNS)
        df = pd.DataFrame(rows, columns=["ts"] + BAR_COLUMNS).set_index("ts")
        df.index = pd.DatetimeIndex(df.index).tz_localize("UTC") if pd.DatetimeIndex(df.index).tz is None else pd.DatetimeIndex(df.index)
        return df

    def _write_cache(self, source, symbol, df) -> None:
        now = datetime.now(timezone.utc)
        recs = [{"symbol": symbol, "timeframe": "1D", "ts": ts.to_pydatetime().replace(tzinfo=None), "open": r.open,
                 "high": r.high, "low": r.low, "close": r.close, "volume": r.volume, "source": source, "fetched_at": now}
                for ts, r in df.iterrows()]
        with session_scope() as s:
            for i in range(0, len(recs), 500):
                stmt = sqlite_insert(BarCache).values(recs[i:i + 500])
                stmt = stmt.on_conflict_do_update(index_elements=["symbol", "timeframe", "ts", "source"],
                                                  set_={c: stmt.excluded[c] for c in ("open", "high", "low", "close", "volume", "fetched_at")})
                s.execute(stmt)

    # ---------------------------------------------------------- quotes
    def quotes(self, symbols: list[str], max_age: float | None = None) -> dict[str, Quote]:
        p = self.provider()
        st = get_settings()["data"]
        max_age = max_age if max_age is not None else max(1.0, float(st["quote_poll_seconds"]) * 0.9)
        if p.name == "replay":
            max_age = 0.3
        symbols = [s.upper() for s in symbols]
        now = time.time()
        need = [s for s in symbols if s not in self._quotes or now - self._quotes[s][0] > max_age]
        if need:
            try:
                got = self.call(p.get_quotes, need)
                for s, q in got.items():
                    self._quotes[s] = (now, q)
            except ProviderError as e:
                self._event(p.name, "warn", f"quote refresh failed, serving cached quotes: {e}")
                for s in need:
                    if s in self._quotes:
                        old = self._quotes[s][1]
                        old.status = DataStatus.CACHED
        out = {}
        stale_s = float(st.get("stale_quote_seconds", 120))
        sess = market_hours.session()
        for s in symbols:
            if s in self._quotes:
                q = self._quotes[s][1]
                if q.status in (DataStatus.LIVE, DataStatus.DELAYED) and sess == "regular":
                    age = (datetime.now(timezone.utc) - q.ts).total_seconds()
                    if age > stale_s + (900 if q.status == DataStatus.DELAYED else 0):
                        q.status = DataStatus.STALE
                out[s] = q
        return out

    # ---------------------------------------------------------- news / profile
    def news(self, symbols: list[str], limit: int = 50) -> list[NewsArticle]:
        p = self.provider()
        if not p.supports_news:
            return []
        return self.call(p.get_news, symbols, limit)

    def profile(self, symbol: str) -> Profile | None:
        symbol = symbol.upper()
        hit = self._profiles.get(symbol)
        if hit and time.time() - hit[0] < 6 * 3600:
            return hit[1]
        p = self.provider()
        prof = None
        try:
            prof = self.call(p.get_profile, symbol, attempts=1)
        except ProviderError:
            prof = None
        if p.name == "alpaca" and (prof is None or prof.fields_unavailable):
            try:
                from .yahoo import YahooProvider
                self._yahoo_fallback = self._yahoo_fallback or YahooProvider()
                yp = self.call(self._yahoo_fallback.get_profile, symbol, provider=self._yahoo_fallback, attempts=1)
                if yp:
                    yp.source = "yahoo (fundamentals fallback)"
                    prof = yp
            except ProviderError:
                pass
        if prof:
            self._profiles[symbol] = (time.time(), prof)
        return prof

    def status(self) -> dict:
        p = self.provider()
        return {"provider": p.capabilities(), "simulated": p is self._sim, "replay": p.name == "replay", "clock": market_hours.clock(),
                "health": {k: v.to_dict() for k, v in self.health.items()},
                "limiter_waits": self._limiter.waits if self._limiter else 0}

    def test_connection(self, name: str) -> dict:
        s = get_settings()["data"]
        try:
            p = self._build(name, s)
            if p is self._sim and name != "simulation":
                return {"ok": False, "message": "Missing API keys; cannot connect."}
            t0 = time.perf_counter()
            q = p.get_quotes(["SPY"])
            dt = (time.perf_counter() - t0) * 1000
            if "SPY" not in q:
                return {"ok": False, "message": "Connected but no SPY quote returned."}
            qq = q["SPY"]
            return {"ok": True, "message": f"SPY {qq.price:.2f} ({qq.status.value}, {qq.venue_note}) in {dt:.0f} ms",
                    "status": qq.status.value}
        except ProviderError as e:
            return {"ok": False, "message": str(e)}
        except Exception as e:  # pragma: no cover
            return {"ok": False, "message": f"{type(e).__name__}: {e}"}


data = DataManager()
