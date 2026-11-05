"""Sandbox historical replay: real past market data played back on a fast simulated clock.

How it works
------------
* History: about ten years of real daily bars (split/dividend adjusted) for the universe, the
  index ETFs and the sector ETFs. They come from the local bar cache when it already holds
  them, otherwise from Yahoo Finance (or Alpaca when your keys are set). Only if no real data
  can be loaded does it fall back to the simulated market, and then it says so everywhere.
* Clock: you pick a start date and a speed (1x, 10x, 25x, 50x, 75x or 100x). At 100x one
  trading day (6.5 hours) passes in about 3.9 minutes. Nights, weekends and holidays are
  skipped. The clock pauses by itself while a model is being trained.
* Prices inside a day: the real open, high, low and close of each day are fixed; the path
  between them is a synthetic random bridge that starts at the open, touches the day's real
  high and low and ends at the close. So daily results are real history; the minute-by-minute
  wiggles are not.
* No peeking ahead: bars, quotes, features and the model only ever see data up to the replay
  clock. The model is trained on history before the start date when the replay begins and is
  retrained on schedule as replayed time passes.
* Isolation: the replay uses its own paper account (its own database file), so your normal
  paper account, its trades and its model are untouched. Stopping the replay switches back.
"""
from __future__ import annotations

import hashlib
import logging
import math
import threading
import time
from datetime import date, datetime, time as dtime, timedelta, timezone

import numpy as np
import pandas as pd

from . import clock, config, market_hours
from . import universe as U
from .providers.base import BAR_COLUMNS, DataStatus, MarketDataProvider, Profile, ProviderError, Quote, validate_bars

log = logging.getLogger("lodestar.replay")

SPEEDS = (1, 10, 25, 50, 75, 100)
MINUTES = 390                       # 9:30 to 16:00
HISTORY_YEARS = 10
MIN_TRAIN_YEARS = 3                 # walk-forward validation needs this much before the start date
OPEN_ET = dtime(9, 30)


def _h(s: str) -> int:
    return int(hashlib.sha1(s.encode()).hexdigest()[:8], 16)


def bridge_path(o: float, h: float, l: float, c: float, seed: int, n: int = MINUTES + 1) -> np.ndarray:
    """Synthetic minute path for one day that starts at the open, ends at the close and touches
    exactly the day's high and low (in price, not log, terms at the extremes)."""
    o, h, l, c = (max(1e-6, float(x)) for x in (o, h, l, c))
    h, l = max(h, o, c), min(l, o, c)
    rng = np.random.default_rng(seed)
    t = np.linspace(0.0, 1.0, n)
    w = np.concatenate([[0.0], np.cumsum(rng.normal(0, 1, n - 1))])
    w = w - t * w[-1]
    base = math.log(o) + t * (math.log(c) - math.log(o))
    lh, ll = math.log(h), math.log(l)
    path = base.copy()
    inner = slice(1, n - 1)
    dev = w[inner]
    if dev.size:
        ip, il = int(np.argmax(dev)), int(np.argmin(dev))
        b_in = base[inner]
        a = (lh - b_in[ip]) / dev[ip] if dev[ip] > 1e-12 else 0.0
        b = (ll - b_in[il]) / dev[il] if dev[il] < -1e-12 else 0.0
        path[inner] = b_in + np.where(dev > 0, a * dev, b * dev)
        path = np.clip(path, ll, lh)
        if h > max(o, c) * (1 + 1e-9):
            path[1 + ip] = lh
        if l < min(o, c) * (1 - 1e-9):
            path[1 + il] = ll
    path[0], path[-1] = math.log(o), math.log(c)
    return np.exp(path)


_VOL_PROFILE = None


def volume_fraction(minute: float) -> float:
    """Share of the day's volume traded by ``minute`` (U-shaped intraday profile)."""
    global _VOL_PROFILE
    if _VOL_PROFILE is None:
        t = np.linspace(0, 1, MINUTES)
        w = 1 + 1.5 * ((t - 0.5) * 2) ** 2
        _VOL_PROFILE = np.concatenate([[0.0], np.cumsum(w) / w.sum()])
    m = min(MINUTES, max(0.0, minute))
    i = int(m)
    if i >= MINUTES:
        return 1.0
    return float(_VOL_PROFILE[i] + (_VOL_PROFILE[i + 1] - _VOL_PROFILE[i]) * (m - i))


def _forget_market_state() -> None:
    """Drop in-memory results computed from the previous data source."""
    from . import analysis, scanner
    scanner.reset_state()
    analysis._ctx_cache = None
    try:
        from .live import hub
        hub.last_quotes = {}
    except Exception:  # pragma: no cover
        pass


class ReplayProvider(MarketDataProvider):
    """Market data adapter that serves the replay's history up to the replay clock only."""

    name = "replay"
    label = "Practice trading (real past data)"
    rate_limit_per_min = 100000
    quote_status = DataStatus.REPLAY
    supports_news = False
    notes = "Real past daily prices replayed on a simulated clock. Intraday moves between the real open/high/low/close are synthetic."

    def __init__(self, ctl: "ReplayController"):
        self.ctl = ctl

    # ------------------------------------------------------------ bars
    def get_bars(self, symbol: str, timeframe: str, start: datetime, end: datetime) -> pd.DataFrame:
        c = self.ctl
        symbol = symbol.upper()
        if symbol not in c.arrays:
            raise ProviderError(f"{symbol} is not part of this replay's history", retryable=False)
        s = pd.Timestamp(start)
        s = s.tz_localize("UTC") if s.tzinfo is None else s.tz_convert("UTC")
        with c.lock:
            di, minute = c.day_i, c.minute
        if timeframe == "1D":
            arr = c.arrays[symbol]
            lo = int(np.searchsorted(c.days.values, s.normalize().to_datetime64()))
            lo = max(0, min(lo, di))
            idx = c.days[lo:di + 1]
            o, h, l, cl, v = (arr[k][lo:di + 1].copy() for k in range(5))
            # today's bar so far
            p = c.path(symbol, di)
            if p is not None:
                k = int(min(MINUTES, max(0, minute)))
                h[-1], l[-1], cl[-1] = float(p[:k + 1].max()), float(p[:k + 1].min()), float(p[k])
                v[-1] = arr[4][di] * volume_fraction(minute)
            elif len(cl):
                cl[-1] = np.nan          # no data for this symbol today: never expose the full-day bar early
            df = pd.DataFrame({"open": o, "high": h, "low": l, "close": cl, "volume": v}, index=idx)
            return df.dropna(subset=["close"])
        mins = {"1H": 60, "15Min": 15, "5Min": 5, "1Min": 1}[timeframe]
        first = max(0, di - (30 if mins < 60 else 90))
        lo = max(first, int(np.searchsorted(c.days.values, s.normalize().to_datetime64())))
        frames = []
        for d in range(lo, di + 1):
            p = c.path(symbol, d)
            if p is None:
                continue
            upto = MINUTES if d < di else int(min(MINUTES, max(0, minute)))
            if upto < 1:
                continue
            seg = p[:upto + 1]
            nb = int(math.ceil(upto / mins))
            opens, highs, lows, closes = [], [], [], []
            for b in range(nb):
                w = seg[b * mins: min(upto, (b + 1) * mins) + 1]
                opens.append(w[0]); highs.append(w.max()); lows.append(w.min()); closes.append(w[-1])
            dayv = float(c.arrays[symbol][4][d] or 0.0)
            vols = [dayv * (volume_fraction(min(upto, (b + 1) * mins)) - volume_fraction(b * mins)) for b in range(nb)]
            t0 = c.open_utc(d)
            ts = pd.date_range(t0, periods=nb, freq=f"{mins}min")
            frames.append(pd.DataFrame({"open": opens, "high": highs, "low": lows, "close": closes, "volume": vols}, index=ts))
        return pd.concat(frames) if frames else pd.DataFrame(columns=BAR_COLUMNS)

    # ------------------------------------------------------------ quotes
    def get_quotes(self, symbols: list[str]) -> dict[str, Quote]:
        c = self.ctl
        out = {}
        with c.lock:
            di, minute = c.day_i, c.minute
        now = c.sim_now()
        k = int(min(MINUTES, max(0, minute)))
        frac = min(MINUTES, max(0.0, minute)) - k
        for sym in symbols:
            sym = sym.upper()
            arr = c.arrays.get(sym)
            p = c.path(sym, di) if arr is not None else None
            if p is None:
                continue
            px = float(p[k] + (p[min(MINUTES, k + 1)] - p[k]) * frac)
            prev = float(arr[3][di - 1]) if di > 0 and not math.isnan(arr[3][di - 1]) else float(arr[0][di])
            half = px * (1.0 if sym in U.INDEXES else 2.5) / 1e4
            out[sym] = Quote(symbol=sym, price=round(px, 4), ts=now, status=DataStatus.REPLAY, source=self.name,
                             prev_close=prev, open=float(arr[0][di]), high=float(p[:k + 1].max()), low=float(p[:k + 1].min()),
                             volume=round(float(arr[4][di]) * volume_fraction(minute)), bid=round(px - half, 4),
                             ask=round(px + half, 4), session="replay", venue_note=f"replay · {c.source_label}")
        return out

    def get_profile(self, symbol: str) -> Profile | None:
        name, sector = U.meta(symbol)
        return Profile(symbol=symbol.upper(), name=name, sector=sector, source="replay",
                       description="Historical replay: fundamentals are not replayed (today's figures would leak the future).",
                       fields_unavailable=["market_cap", "pe_ratio", "forward_pe", "eps", "dividend_yield", "beta", "next_earnings"])

    def capabilities(self) -> dict:
        d = super().capabilities()
        d["label"] = f"Practice trading on {self.ctl.source_label}"
        return d


class ReplayController:
    def __init__(self):
        self.lock = threading.RLock()
        self.active = False
        self.status = "idle"             # idle | loading | training | ready | playing | paused | ended | error
        self.message = ""
        self.progress = 0.0
        self.speed = 10
        self.playing = False
        self.days = pd.DatetimeIndex([], tz="UTC")
        self.arrays: dict[str, np.ndarray] = {}
        self.day_i = 0
        self.minute = 0.0
        self.start_i = 0
        self.source = ""
        self.source_label = ""
        self.start_cash = 100000.0
        self.started_wall: float | None = None
        self.sim_seconds = 0.0
        self.trained_days: set[int] = set()
        self._paths: dict[tuple[str, int], np.ndarray] = {}
        self._thread: threading.Thread | None = None
        self._stop = threading.Event()
        self._job: threading.Thread | None = None
        self.provider = ReplayProvider(self)
        clock.set_source(self)

    # ------------------------------------------------------------ clock
    def open_utc(self, di: int) -> datetime:
        d = self.days[di].date()
        return datetime.combine(d, OPEN_ET, tzinfo=market_hours.ET).astimezone(timezone.utc)

    def sim_now(self) -> datetime:
        with self.lock:
            if not len(self.days):
                return datetime.now(timezone.utc)
            return self.open_utc(self.day_i) + timedelta(minutes=min(self.minute, MINUTES - 1e-3))

    def effective_speed(self) -> float:
        return float(self.speed) if self.playing and self.status == "playing" else 0.0

    def path(self, sym: str, di: int) -> np.ndarray | None:
        key = (sym, di)
        p = self._paths.get(key)
        if p is not None:
            return p
        arr = self.arrays.get(sym)
        if arr is None or di < 0 or di >= arr.shape[1] or any(math.isnan(arr[k][di]) for k in range(4)):
            return None
        p = bridge_path(arr[0][di], arr[1][di], arr[2][di], arr[3][di], _h(f"{sym}|{self.days[di].date()}"))
        if len(self._paths) > 20000:
            self._paths.clear()
        self._paths[key] = p
        return p

    def _tick_loop(self):
        last = time.monotonic()
        while not self._stop.is_set():
            time.sleep(0.2)
            now = time.monotonic()
            dt = min(1.0, now - last)
            last = now
            try:
                self._advance(dt)
            except Exception:   # pragma: no cover - never let the clock thread die silently
                log.exception("replay tick")

    def _advance(self, dt: float):
        from .ml import engine as ml
        with self.lock:
            if not self.active:
                return
            if ml.is_training():
                if self.status in ("playing", "ready", "paused"):
                    self._prev_status = self.status
                    self.status = "training"
                    self.message = "Clock paused while the model trains on the history seen so far."
                return
            if self.status == "training":
                self.status = getattr(self, "_prev_status", "paused")
                self.message = ""
            if self.status == "ready":
                self.status = "playing" if self.playing else "paused"
            if not (self.playing and self.status == "playing"):
                return
            add = dt * self.speed / 60.0
            self.sim_seconds += dt * self.speed
            self.minute += add
            while self.minute >= MINUTES:
                if self.day_i >= len(self.days) - 1:
                    self.minute = MINUTES - 1e-3
                    self.playing = False
                    self.status = "ended"
                    self.message = "Reached the end of the available history."
                    return
                self.minute -= MINUTES
                self.minute = min(self.minute, MINUTES - 1)
                self.day_i += 1
                self._paths = {k: v for k, v in self._paths.items() if k[1] >= self.day_i - 35}

    # ------------------------------------------------------------ data
    def _symbols(self) -> list[str]:
        from .settings_store import get_settings
        return sorted(set(U.universe(get_settings())) | set(U.INDEXES) | set(U.SECTOR_ETFS))

    def _load_history(self, source: str) -> tuple[dict[str, pd.DataFrame], str, str]:
        """Return (frames, source_name, human label). Tries cache, then a real provider, then simulation."""
        from .providers.manager import data
        syms = self._symbols()
        end = datetime.now(timezone.utc)
        start = end - timedelta(days=int(365.25 * HISTORY_YEARS))
        need_days = int(252 * (MIN_TRAIN_YEARS + 0.5))
        if source != "simulation":
            order = ["alpaca", "yahoo"] if source == "auto" else [source]
            for src in order:
                frames = {}
                for i, s in enumerate(syms):
                    df = data._read_cache(src, s, start)
                    if len(df) >= need_days:
                        frames[s] = df
                self.progress = 0.05
                if U.BENCHMARK in frames and len(frames) >= 0.8 * len(syms):
                    return frames, src, f"real {src.title()} history (from local cache)"
            # download what is missing
            for src in order:
                prov = self._real_provider(src)
                if prov is None:
                    continue
                frames, fails = {}, 0
                for i, s in enumerate(syms):
                    self.message = f"Downloading real price history from {prov.label}: {s} ({i + 1}/{len(syms)})"
                    self.progress = 0.05 + 0.75 * (i / len(syms))
                    cached = data._read_cache(src, s, start)
                    try:
                        if len(cached) >= need_days and cached.index[0] <= pd.Timestamp(start) + pd.Timedelta(days=30):
                            df = cached
                        else:
                            df = self._fetch_with_retry(prov, s, start, end)
                            df, _ = validate_bars(df)
                            if len(df):
                                data._write_cache(src, s, df)
                        if len(df) >= need_days:
                            frames[s] = df
                    except ProviderError as e:
                        fails += 1
                        log.warning("replay history %s/%s: %s", src, s, e)
                        if fails >= 5 and not frames:
                            break
                if U.BENCHMARK in frames and len(frames) >= 0.6 * len(syms):
                    return frames, src, f"real {src.title()} history"
        # fallback: the simulated market (clearly labelled)
        self.message = "Real history unavailable; using the simulated market's history instead."
        sim = data.sim
        frames = {s: sim.get_bars(s, "1D", start, end) for s in syms}
        frames = {s: df.iloc[:-1] for s, df in frames.items() if len(df)}
        return frames, "simulation", "SIMULATED history (real data could not be downloaded)"

    @staticmethod
    def _fetch_with_retry(prov, symbol: str, start, end, attempts: int = 3) -> pd.DataFrame:
        """Free data sources throttle bursts; back off a little instead of giving up on a symbol."""
        delay = 2.0
        for i in range(attempts):
            try:
                return prov.get_bars(symbol, "1D", start, end)
            except ProviderError as e:
                if i == attempts - 1 or not e.retryable:
                    raise
                time.sleep(delay)
                delay *= 2.5
        return pd.DataFrame(columns=BAR_COLUMNS)

    @staticmethod
    def _real_provider(src: str):
        try:
            if src == "alpaca":
                key, sec = config.get_secret("ALPACA_API_KEY_ID"), config.get_secret("ALPACA_API_SECRET_KEY")
                if not (key and sec):
                    return None
                from .providers.alpaca import AlpacaProvider
                from .settings_store import get_settings
                return AlpacaProvider(key, sec, feed=get_settings()["data"].get("alpaca_feed", "iex"))
            if src == "yahoo":
                from .providers.yahoo import YahooProvider
                return YahooProvider()
        except ProviderError:
            return None
        return None

    def _build_arrays(self, frames: dict[str, pd.DataFrame]):
        spy = frames[U.BENCHMARK] if U.BENCHMARK in frames else max(frames.values(), key=len)
        days = pd.DatetimeIndex(spy.index).normalize()
        days = days.tz_localize("UTC") if days.tz is None else days.tz_convert("UTC")
        days = days[~days.duplicated()]
        arrays = {}
        for s, df in frames.items():
            d = df.copy()
            ix = pd.DatetimeIndex(d.index).normalize()
            d.index = ix.tz_localize("UTC") if ix.tz is None else ix.tz_convert("UTC")
            d = d[~d.index.duplicated(keep="last")].reindex(days)
            arrays[s] = d[BAR_COLUMNS].to_numpy(dtype=float).T.copy()
        return days, arrays

    # ------------------------------------------------------------ lifecycle
    def bounds(self) -> dict:
        """Earliest/latest start dates for the history currently loaded (or the default window)."""
        today = datetime.now(timezone.utc).date()
        if len(self.days):
            first, last = self.days[0].date(), self.days[-1].date()
        else:
            first, last = today - timedelta(days=int(365.25 * HISTORY_YEARS)), today - timedelta(days=1)
        earliest = first + timedelta(days=int(365.25 * MIN_TRAIN_YEARS))
        latest = last - timedelta(days=7)
        return {"earliest_start": earliest.isoformat(), "latest_start": latest.isoformat(),
                "default_start": max(earliest, last - timedelta(days=365)).isoformat()}

    def start(self, start_date: str | None, speed: int, starting_cash: float, source: str = "auto") -> dict:
        from .ml import engine as ml
        from .settings_store import get_settings
        if not get_settings()["paper"]["sandbox"]:
            raise ValueError("Practice trading on real data uses play money, so it needs Sandbox mode. Turn Sandbox mode on first.")
        if speed not in SPEEDS:
            raise ValueError(f"Speed must be one of {', '.join(f'{s}x' for s in SPEEDS)}.")
        if ml.is_training():
            raise ValueError("A model is training right now. Try again when it finishes.")
        if self._job and self._job.is_alive():
            raise ValueError("A replay is already being prepared.")
        if self.active:
            self.stop()
        self.status, self.progress, self.message = "loading", 0.0, "Loading price history"
        self.speed, self.start_cash = int(speed), float(starting_cash)
        self._job = threading.Thread(target=self._prepare, args=(start_date, source), daemon=True, name="replay-prepare")
        self._job.start()
        return self.state()

    def _prepare(self, start_date: str | None, source: str):
        from . import db
        from .ml import engine as ml
        from .providers.manager import data
        try:
            frames, src, label = self._load_history(source)
            days, arrays = self._build_arrays(frames)
            if len(days) < 252 * (MIN_TRAIN_YEARS + 0.2):
                raise ValueError(f"Only {len(days)} trading days of history were found; at least about {MIN_TRAIN_YEARS} years are needed.")
            want = pd.Timestamp(start_date).tz_localize("UTC") if start_date else days[-1] - pd.Timedelta(days=365)
            earliest = days[0] + pd.Timedelta(days=int(365.25 * MIN_TRAIN_YEARS))
            want = min(max(want, earliest), days[-1] - pd.Timedelta(days=7))
            si = int(np.searchsorted(days.values, want.to_datetime64()))
            with self.lock:
                self.days, self.arrays, self.source, self.source_label = days, arrays, src, label
                self.start_i = self.day_i = si
                self.minute = 0.0
                self.sim_seconds = 0.0
                self._paths = {}
                self.playing = True          # starts playing as soon as the first model is trained
            # isolate the replay's account and model, then switch the data source
            self.progress, self.message = 0.85, "Preparing the replay account"
            db.use_replay_db(str(config.DATA_DIR / "replay.db"), fresh=True)
            with self.lock:
                self.active = True
            data.reset_caches()
            self._seed_account()
            ml.predictor.invalidate()
            ml.predictor.reload()
            _forget_market_state()
            if self._thread is None or not self._thread.is_alive():
                self._stop.clear()
                self._thread = threading.Thread(target=self._tick_loop, daemon=True, name="replay-clock")
                self._thread.start()
            self.progress = 0.9
            self.message = "Training the model on history before the start date (the clock waits for it)."
            try:
                ml.start_training_async()
            except RuntimeError:
                pass
            self.started_wall = time.time()
            self.progress = 1.0
            with self.lock:
                self.status = "ready"
            log.info("replay ready: %s from %s at %sx", label, days[si].date(), self.speed)
        except Exception as e:
            log.exception("replay prepare failed")
            with self.lock:
                self.status, self.message, self.active = "error", str(e), False
            db.use_replay_db(None)
            data.reset_caches()

    def _seed_account(self):
        from .db import PaperAccount, session_scope
        from .paper.engine import _day_key
        with session_scope() as s:
            s.add(PaperAccount(starting_cash=self.start_cash, cash=self.start_cash, peak_equity=self.start_cash,
                               day_start_equity=self.start_cash, day_key=_day_key()))

    def play(self):
        with self.lock:
            if not self.active:
                raise ValueError("No practice session is running.")
            if self.status == "ended":
                raise ValueError("This practice session reached the end of the available market history. Start a new one.")
            self.playing = True
            if self.status in ("ready", "paused"):
                self.status = "playing"
            elif self.status == "training":
                self._prev_status = "playing"
        return self.state()

    def pause(self):
        with self.lock:
            self.playing = False
            if self.status == "playing":
                self.status = "paused"
            elif self.status == "training":
                self._prev_status = "paused"
        return self.state()

    def set_speed(self, speed: int):
        if int(speed) not in SPEEDS:
            raise ValueError(f"Speed must be one of {', '.join(f'{s}x' for s in SPEEDS)}.")
        with self.lock:
            self.speed = int(speed)
        return self.state()

    def stop(self) -> dict:
        from . import db
        from .ml import engine as ml
        from .providers.manager import data
        if ml.is_training() and self.active:
            raise ValueError("The model for this practice session is still training. Try stopping again in a moment.")
        summary = self.summary() if self.active else None
        with self.lock:
            self.active = False
            self.playing = False
            self.status = "idle"
            self.message = ""
        self._stop.set()
        db.use_replay_db(None)
        data.reset_caches()
        ml.predictor.invalidate()
        ml.predictor.reload()
        _forget_market_state()
        self.last_summary = summary
        return self.state()

    # ------------------------------------------------------------ reporting
    def summary(self) -> dict | None:
        if not self.active:
            return getattr(self, "last_summary", None)
        try:
            from .paper import engine as paper
            snap = paper.snapshot()
            spy = self.arrays.get(U.BENCHMARK)
            spy_ret = None
            if spy is not None:
                q = self.provider.get_quotes([U.BENCHMARK]).get(U.BENCHMARK)
                start_px = spy[0][self.start_i]
                if q and start_px and not math.isnan(start_px):
                    spy_ret = (q.price / start_px - 1) * 100
            m = snap["money"]
            return {"equity": snap["equity"], "profit": m["profit"], "return_pct": m["return_pct"], "trades": m["trades"],
                    "win_rate_pct": m["win_rate_pct"], "spy_return_pct": spy_ret,
                    "days_replayed": self.day_i - self.start_i, "from": self.days[self.start_i].date().isoformat(),
                    "to": self.days[self.day_i].date().isoformat()}
        except Exception as e:  # pragma: no cover
            return {"error": str(e)}

    def state(self) -> dict:
        with self.lock:
            has = bool(len(self.days))
            out = {
                "active": self.active, "status": self.status, "message": self.message, "progress": round(self.progress, 3),
                "speed": self.speed, "speeds": list(SPEEDS), "playing": self.playing,
                "source": self.source, "source_label": self.source_label, "simulated_history": self.source == "simulation",
                "start_cash": self.start_cash,
                "start_date": self.days[self.start_i].date().isoformat() if has else None,
                "current_date": self.days[self.day_i].date().isoformat() if has else None,
                "last_date": self.days[-1].date().isoformat() if has else None,
                "sim_time": self.sim_now().isoformat() if has and self.active else None,
                "sim_time_et": self.sim_now().astimezone(market_hours.ET).strftime("%a %b %d, %Y %H:%M") if has and self.active else None,
                "day_progress": round(min(1.0, self.minute / MINUTES), 4),
                "days_replayed": (self.day_i - self.start_i) if has else 0,
                "days_left": (len(self.days) - 1 - self.day_i) if has else 0,
                "real_seconds_per_day": round(MINUTES * 60 / self.speed, 1),
                **self.bounds(),
            }
        out["summary"] = self.summary() if self.active else getattr(self, "last_summary", None)
        return out


controller = ReplayController()
