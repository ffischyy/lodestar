"""Deterministic synthetic market used when no live provider is configured.

Everything this adapter returns is labelled SIMULATED. The generator is a
factor model (market + sector + idiosyncratic) with Markov regime switching and
GARCH-like volatility clustering. It deliberately plants *weak* structure
(short-term reversal, medium-term momentum) so the ML pipeline has something
non-trivial to detect; real markets are noisier and may have no such edge.
"""
from __future__ import annotations

import hashlib
import math
import threading
import time
from datetime import date, datetime, timedelta, timezone

import numpy as np
import pandas as pd

from .. import universe as U
from .base import DataStatus, MarketDataProvider, NewsArticle, Profile, Quote

START = date(2019, 1, 2)
SEED = 20240632
TRADING_DAYS = 252


def _h(s: str) -> int:
    return int(hashlib.sha1(s.encode()).hexdigest()[:8], 16)


def _bdays(start: date, end: date) -> pd.DatetimeIndex:
    return pd.bdate_range(start, end, tz="UTC")


class SimulatedProvider(MarketDataProvider):
    name = "simulation"
    label = "Simulation"
    rate_limit_per_min = 100000
    quote_status = DataStatus.SIMULATED
    supports_news = True
    notes = "Synthetic prices for testing. Never real market data."

    def __init__(self, end: date | None = None):
        self._lock = threading.Lock()
        self._fixed_end = end
        self._panel: dict[str, pd.DataFrame] | None = None
        self._panel_end: date | None = None
        self._live: dict[str, dict] = {}
        self._rng = np.random.default_rng(SEED + 7)

    # ------------------------------------------------------------------ history
    def _last_complete_day(self) -> date:
        if self._fixed_end:
            return self._fixed_end
        from ..market_hours import ET
        now_et = datetime.now(timezone.utc).astimezone(ET)
        d = now_et.date() if now_et.hour >= 16 else now_et.date() - timedelta(days=1)
        while d.weekday() >= 5:
            d -= timedelta(days=1)
        return d

    def _all_symbols(self) -> list[str]:
        return list(U.DEFAULT_UNIVERSE) + list(U.INDEXES) + list(U.SECTOR_ETFS)

    def _build_panel(self) -> dict[str, pd.DataFrame]:
        end = self._last_complete_day()
        if self._panel is not None and self._panel_end == end:
            return self._panel
        idx = _bdays(START, end)
        n = len(idx)
        rng = np.random.default_rng(SEED)

        # --- regimes: 0 calm bull, 1 choppy, 2 stressed bear
        P = np.array([[0.985, 0.012, 0.003], [0.02, 0.97, 0.01], [0.02, 0.03, 0.95]])
        mu_r = np.array([0.0003, -0.0001, -0.0014])
        vol_r = np.array([0.008, 0.011, 0.022])
        reg = np.zeros(n, dtype=int)
        for t in range(1, n):
            reg[t] = rng.choice(3, p=P[reg[t - 1]])
        # GARCH-ish market vol
        mkt = np.zeros(n)
        sig = vol_r[reg[0]]
        for t in range(n):
            target = vol_r[reg[t]]
            sig = math.sqrt(0.90 * sig**2 + 0.08 * (mkt[t - 1] ** 2 if t else target**2) + 0.02 * target**2)
            mkt[t] = mu_r[reg[t]] + sig * rng.standard_t(5) / math.sqrt(5 / 3)

        sectors = sorted(set(v[1] for v in U.DEFAULT_UNIVERSE.values()))
        sec_ret = {}
        for s in sectors:
            r = rng.normal(0, 0.006, n)
            # sector momentum: slow-moving drift component
            drift = np.zeros(n)
            for t in range(1, n):
                drift[t] = 0.995 * drift[t - 1] + rng.normal(0, 0.00004)
            sec_ret[s] = r + drift

        out: dict[str, pd.DataFrame] = {}
        rets: dict[str, np.ndarray] = {}
        for sym, (_, sector) in U.DEFAULT_UNIVERSE.items():
            r2 = np.random.default_rng(SEED + _h(sym) % 100000)
            beta = 0.7 + 0.8 * r2.random()
            idio_vol = 0.008 + 0.014 * r2.random()
            alpha = r2.normal(0.0001, 0.0002)
            idio = r2.normal(0, 1, n)
            # persistent, slowly-varying stock-specific drift (what momentum features can pick up)
            dshock = r2.normal(0, 0.00030, n)
            drift = np.zeros(n)
            for t in range(1, n):
                drift[t] = 0.985 * drift[t - 1] + dshock[t]
            r = np.zeros(n)
            resid_hist = np.zeros(n)
            for t in range(n):
                e = idio_vol * idio[t] * (1.6 if reg[t] == 2 else 1.0)
                rev = -0.10 * resid_hist[t - 1] if t > 0 else 0.0           # 1-day reversal
                mom = 0.0
                if t > 63:
                    mom = 0.04 * resid_hist[t - 63:t - 5].sum() / 58       # medium-term momentum
                resid_hist[t] = e + rev + mom
                r[t] = alpha + drift[t] + beta * mkt[t] + sec_ret[sector][t] + resid_hist[t]
            rets[sym] = r
            out[sym] = self._ohlcv(sym, idx, r, base=12 + (_h(sym) % 110), r2=r2)

        for etf, sector in U.SECTOR_ETFS.items():
            r = mkt + sec_ret.get(sector, np.zeros(n))
            out[etf] = self._ohlcv(etf, idx, r, base=60 + _h(etf) % 80, r2=np.random.default_rng(_h(etf)))
        betas = {"SPY": 1.0, "QQQ": 1.2, "IWM": 1.15, "DIA": 0.9}
        for ix, b in betas.items():
            r2 = np.random.default_rng(_h(ix))
            r = b * mkt + r2.normal(0, 0.0015 if ix != "SPY" else 0.0004, n) + (0.00008 if ix == "QQQ" else 0)
            out[ix] = self._ohlcv(ix, idx, r, base={"SPY": 250, "QQQ": 170, "IWM": 150, "DIA": 240}[ix], r2=r2, liquid=True)

        self._panel, self._panel_end = out, end
        self._regimes = pd.Series(reg, index=idx)
        return out

    @staticmethod
    def _ohlcv(sym, idx, r, base, r2, liquid=False) -> pd.DataFrame:
        n = len(r)
        close = base * np.exp(np.cumsum(r))
        gap = r2.normal(0, 0.003, n)
        open_ = np.empty(n)
        open_[0] = base
        open_[1:] = close[:-1] * np.exp(gap[1:])
        rng_ = np.abs(r) + np.abs(r2.normal(0, 0.006, n))
        high = np.maximum(open_, close) * (1 + rng_ * r2.random(n))
        low = np.minimum(open_, close) * (1 - rng_ * r2.random(n))
        avgvol = (8e7 if liquid else 2e6 + (_h(sym) % 30) * 1e6)
        vol = avgvol * np.exp(r2.normal(0, 0.3, n) + 15 * np.abs(r))
        return pd.DataFrame({"open": open_, "high": high, "low": low, "close": close, "volume": vol.round()}, index=idx)

    def _extra_symbol(self, symbol: str) -> pd.DataFrame:
        panel = self._build_panel()
        if symbol in panel:
            return panel[symbol]
        idx = panel["SPY"].index
        r2 = np.random.default_rng(_h(symbol))
        spy = np.log(panel["SPY"]["close"]).diff().fillna(0).to_numpy()
        r = (0.6 + r2.random()) * spy + r2.normal(0, 0.015, len(idx))
        df = self._ohlcv(symbol, idx, r, base=20 + _h(symbol) % 200, r2=r2)
        panel[symbol] = df
        return df

    def regimes(self) -> pd.Series:
        self._build_panel()
        return self._regimes

    # ------------------------------------------------------------------ live
    def _live_state(self, symbol: str) -> dict:
        with self._lock:
            st = self._live.get(symbol)
            daily = self._extra_symbol(symbol)
            last_close = float(daily["close"].iloc[-1])
            if st is None or st["prev_close"] != last_close:
                r2 = np.random.default_rng(_h(symbol + str(self._panel_end)))
                o = last_close * math.exp(r2.normal(0, 0.004))
                ret = np.log(daily["close"]).diff().dropna().tail(60)
                st = {"prev_close": last_close, "open": o, "price": o, "high": o, "low": o,
                      "volume": 0.0, "t": time.time(), "dvol": float(ret.std() or 0.015),
                      "avgvol": float(daily["volume"].tail(20).mean())}
                self._live[symbol] = st
            now = time.time()
            dt = min(now - st["t"], 3600.0)
            if dt > 0.5:
                # one simulated trading day == 6.5 wall-clock hours; drift-free walk
                frac = dt / (6.5 * 3600)
                step = st["dvol"] * math.sqrt(frac) * self._rng.standard_normal()
                st["price"] *= math.exp(step)
                st["high"] = max(st["high"], st["price"])
                st["low"] = min(st["low"], st["price"])
                st["volume"] += st["avgvol"] * frac * (0.5 + self._rng.random())
                st["t"] = now
            return dict(st)

    def get_quotes(self, symbols: list[str]) -> dict[str, Quote]:
        out = {}
        now = datetime.now(timezone.utc)
        for s in symbols:
            st = self._live_state(s.upper())
            p = st["price"]
            half_spread = p * (1.5 if s in U.INDEXES else 4.0) / 1e4
            out[s.upper()] = Quote(
                symbol=s.upper(), price=round(p, 4), ts=now, status=DataStatus.SIMULATED, source=self.name,
                prev_close=st["prev_close"], open=st["open"], high=st["high"], low=st["low"],
                volume=round(st["volume"]), bid=round(p - half_spread, 4), ask=round(p + half_spread, 4),
                session="simulated", venue_note="synthetic",
            )
        return out

    def get_bars(self, symbol: str, timeframe: str, start: datetime, end: datetime) -> pd.DataFrame:
        daily = self._extra_symbol(symbol.upper()).copy()
        st = self._live_state(symbol.upper())
        completed = daily.copy()
        if not self._fixed_end:
            # the simulated "current session" is the next business day after the last completed one
            nxt = daily.index[-1] + pd.offsets.BDay(1)
            daily.loc[nxt] = [st["open"], st["high"], st["low"], st["price"], st["volume"]]
        if timeframe == "1D":
            df = daily
        else:
            df = self._intraday(symbol.upper(), completed, timeframe, start)
        s, e = pd.Timestamp(start), pd.Timestamp(end)
        s = s.tz_localize("UTC") if s.tzinfo is None else s.tz_convert("UTC")
        e = e.tz_localize("UTC") if e.tzinfo is None else e.tz_convert("UTC")
        return df[(df.index >= s.normalize() if timeframe == "1D" else df.index >= s) & (df.index <= e + pd.Timedelta(days=1))]

    def _intraday(self, symbol: str, daily: pd.DataFrame, timeframe: str, start: datetime) -> pd.DataFrame:
        minutes = {"1H": 60, "15Min": 15, "5Min": 5, "1Min": 1}[timeframe]
        per_day = 390 // minutes
        s = pd.Timestamp(start)
        s = s.tz_localize("UTC") if s.tzinfo is None else s.tz_convert("UTC")
        days = daily[daily.index >= s.normalize()].tail(30 if minutes < 60 else 120)
        frames = []
        for d, row in days.iterrows():
            r2 = np.random.default_rng(_h(symbol + d.strftime("%Y%m%d") + timeframe))
            # Brownian bridge from open to close
            steps = r2.normal(0, 1, per_day)
            w = np.cumsum(steps)
            w = w - np.linspace(0, 1, per_day) * w[-1]
            lo, hi = math.log(row.open), math.log(row.close)
            scale = (math.log(row.high) - math.log(row.low)) / (w.max() - w.min() + 1e-9) * 0.6
            path = np.exp(np.linspace(lo, hi, per_day) + w * scale)
            opens = np.concatenate([[row.open], path[:-1]])
            noise = np.abs(r2.normal(0, 0.0008, per_day))
            highs = np.maximum(opens, path) * (1 + noise)
            lows = np.minimum(opens, path) * (1 - noise)
            vols = row.volume / per_day * np.exp(r2.normal(0, 0.4, per_day))
            ts = pd.date_range(d + pd.Timedelta(hours=13, minutes=30), periods=per_day, freq=f"{minutes}min")
            frames.append(pd.DataFrame({"open": opens, "high": highs, "low": lows, "close": path, "volume": vols.round()}, index=ts))
        return pd.concat(frames) if frames else pd.DataFrame(columns=["open", "high", "low", "close", "volume"])

    # ------------------------------------------------------------------ news/profile
    _POS = ["beats estimates", "raises full-year guidance", "wins major contract", "announces buyback expansion",
            "upgraded by analysts on strong demand", "reports record revenue growth"]
    _NEG = ["misses revenue estimates", "cuts guidance amid weak demand", "faces regulatory probe",
            "downgraded on margin pressure", "announces layoffs and restructuring", "recalls product after defects"]
    _NEU = ["to present at industry conference", "names new chief financial officer", "completes previously announced acquisition",
            "schedules quarterly earnings call", "files annual report"]

    def get_news(self, symbols: list[str], limit: int = 50) -> list[NewsArticle]:
        panel = self._build_panel()
        out = []
        now = datetime.now(timezone.utc)
        for sym in symbols:
            if sym not in panel:
                continue
            df = panel[sym].tail(15)
            r = np.log(df["close"]).diff().dropna()
            for i, (ts, ret) in enumerate(r.items()):
                rng = np.random.default_rng(_h(sym + str(ts)))
                if abs(ret) < 0.012 and rng.random() > 0.15:
                    continue
                pool = self._POS if ret > 0.012 else self._NEG if ret < -0.012 else self._NEU
                text = pool[int(rng.integers(len(pool)))]
                name = U.meta(sym)[0]
                out.append(NewsArticle(
                    ext_id=f"sim-{sym}-{ts:%Y%m%d}", ts=(ts + pd.Timedelta(hours=13 + int(rng.integers(8)))).to_pydatetime(),
                    headline=f"{name} {text}", summary=f"[SIMULATED] Synthetic headline generated from the simulated price path of {sym}.",
                    url="", publisher="Simulation", symbols=[sym], simulated=True))
        out = [a for a in out if a.ts <= now]
        out.sort(key=lambda a: a.ts, reverse=True)
        return out[:limit]

    def get_profile(self, symbol: str) -> Profile:
        name, sector = U.meta(symbol)
        r = np.random.default_rng(_h("prof" + symbol))
        df = self._extra_symbol(symbol.upper())
        price = float(df["close"].iloc[-1])
        eps = price / (12 + 25 * r.random())
        last = df.index[-1].date()
        # earnings every ~63 sessions, phase by symbol
        phase = _h(symbol) % 63
        k = (len(df) - phase) // 63 + 1
        next_idx = phase + 63 * k
        next_e = pd.bdate_range(last, periods=max(1, next_idx - len(df) + 2))[-1].to_pydatetime()
        yr = df.tail(252)
        return Profile(symbol=symbol.upper(), name=name, sector=sector, industry=f"{sector} (simulated)",
                       market_cap=price * (1e8 + r.random() * 3e9), pe_ratio=price / eps, forward_pe=price / (eps * 1.08),
                       eps=eps, dividend_yield=float(r.random() * 3), beta=float(0.6 + r.random()),
                       fifty_two_week_high=float(yr["high"].max()), fifty_two_week_low=float(yr["low"].min()),
                       next_earnings=next_e.replace(tzinfo=timezone.utc),
                       description="[SIMULATED] Synthetic company profile. Fundamentals are generated and are not real.",
                       source=self.name, simulated=True)
