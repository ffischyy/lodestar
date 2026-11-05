"""Independent, testable analysis modules.

Each module consumes bars that end at the evaluation bar (no future data) and
returns a ``SignalResult``. These are *technical/statistical descriptions*, not
forecasts; the ML forecaster (``lodestar.ml``) is separate, and explanations are
generated from these outputs, never the other way round.
"""
from __future__ import annotations

from .. import clock as _clock

import math
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone

import numpy as np
import pandas as pd

from . import indicators as ind


@dataclass
class SignalResult:
    key: str
    name: str
    category: str              # technical | statistical | regime | event | sentiment
    score: float               # -1 (bearish) .. +1 (bullish); 0 for non-directional modules
    direction: str             # bullish | bearish | neutral | info
    summary: str
    values: dict = field(default_factory=dict)
    flags: list[str] = field(default_factory=list)

    def to_dict(self) -> dict:
        d = asdict(self)
        d["score"] = round(float(self.score), 3)
        d["values"] = {k: (round(float(v), 4) if isinstance(v, (float, np.floating)) and math.isfinite(v) else v)
                       for k, v in self.values.items()}
        return d


def _dir(score: float, thr: float = 0.15) -> str:
    return "bullish" if score > thr else "bearish" if score < -thr else "neutral"


def _clip(x: float, lo: float = -1.0, hi: float = 1.0) -> float:
    if x is None or not math.isfinite(x):
        return 0.0
    return max(lo, min(hi, x))


def _last(s: pd.Series) -> float:
    s = s.dropna()
    return float(s.iloc[-1]) if len(s) else float("nan")


def momentum(df: pd.DataFrame) -> SignalResult:
    c = df["close"]
    if len(c) < 130:
        return SignalResult("momentum", "Momentum", "technical", 0, "neutral", "Insufficient history (<130 bars).", flags=["insufficient_data"])
    r_6m_skip = c.iloc[-6] / c.iloc[-127] - 1          # 6-month return skipping the last week
    r_3m = c.iloc[-1] / c.iloc[-64] - 1
    vol = _last(ind.realized_vol(c, 63)) or 0.2
    adj = r_6m_skip / (vol * math.sqrt(0.5) + 1e-9)
    m = ind.macd(c)
    score = _clip(0.6 * math.tanh(adj / 1.5) + 0.4 * math.tanh(r_3m / (vol * 0.5 + 1e-9)))
    return SignalResult("momentum", "Momentum", "technical", score, _dir(score),
                        f"6-month return (ex last week) {r_6m_skip:+.1%}, 3-month {r_3m:+.1%}; volatility-adjusted strength {adj:+.2f}.",
                        {"ret_6m_skip": r_6m_skip, "ret_3m": r_3m, "vol_adj": adj, "macd_hist": _last(m["hist"])})


def mean_reversion(df: pd.DataFrame) -> SignalResult:
    c = df["close"]
    if len(c) < 60:
        return SignalResult("mean_reversion", "Mean reversion", "statistical", 0, "neutral", "Insufficient history.", flags=["insufficient_data"])
    z = _last(ind.zscore(c, 20))
    r = _last(ind.rsi(c, 14))
    r2 = _last(ind.rsi(c, 2))
    bb = ind.bollinger(c)
    pb = _last(bb["pct_b"])
    long_trend_up = len(c) >= 200 and c.iloc[-1] > _last(ind.sma(c, 200))
    raw = -math.tanh(z / 2.0)
    # reversion bets are more reliable with the long trend than against it
    raw *= 1.0 if (raw > 0) == long_trend_up else 0.5
    score = _clip(raw)
    state = "oversold" if z < -1.5 or r2 < 10 else "overbought" if z > 1.5 or r2 > 90 else "within normal range"
    return SignalResult("mean_reversion", "Mean reversion", "statistical", score, _dir(score),
                        f"Price is {z:+.2f}σ from its 20-day mean (RSI14 {r:.0f}, RSI2 {r2:.0f}) — {state}.",
                        {"zscore20": z, "rsi14": r, "rsi2": r2, "pct_b": pb, "with_long_trend": long_trend_up})


def trend(df: pd.DataFrame) -> SignalResult:
    c = df["close"]
    if len(c) < 200:
        return SignalResult("trend", "Trend following", "technical", 0, "neutral", "Needs 200 bars.", flags=["insufficient_data"])
    e20, e50, s200 = _last(ind.ema(c, 20)), _last(ind.ema(c, 50)), _last(ind.sma(c, 200))
    px = float(c.iloc[-1])
    align = (np.sign(px - e20) + np.sign(e20 - e50) + np.sign(e50 - s200) + np.sign(px - s200)) / 4
    a = ind.adx(df)
    adx_v = _last(a["adx"])
    strength = min(1.0, (adx_v or 0) / 35)
    slope = (_last(ind.sma(c, 50)) / float(ind.sma(c, 50).dropna().iloc[-11]) - 1) if len(c) > 60 else 0
    score = _clip(align * (0.4 + 0.6 * strength))
    desc = "aligned up" if align >= 0.75 else "aligned down" if align <= -0.75 else "mixed"
    return SignalResult("trend", "Trend following", "technical", score, _dir(score),
                        f"Moving averages {desc} (price vs EMA20/EMA50/SMA200); ADX {adx_v:.0f} ({'trending' if adx_v > 25 else 'weak trend'}).",
                        {"ema20": e20, "ema50": e50, "sma200": s200, "adx": adx_v, "alignment": align, "sma50_slope_10d": slope})


def breakout(df: pd.DataFrame) -> SignalResult:
    if len(df) < 60:
        return SignalResult("breakout", "Breakout", "technical", 0, "neutral", "Insufficient history.", flags=["insufficient_data"])
    c = df["close"]
    d20 = ind.donchian(df, 20)
    d55 = ind.donchian(df, 55)
    vol_ratio = float(df["volume"].iloc[-1] / (df["volume"].iloc[-21:-1].mean() + 1e-9))
    px = float(c.iloc[-1])
    up20, lo20 = _last(d20["upper"]), _last(d20["lower"])
    up55, lo55 = _last(d55["upper"]), _last(d55["lower"])
    bbw = ind.bollinger(c)["width"]
    squeeze = _last(ind.percentile_rank(bbw, 252))
    score, txt = 0.0, "No breakout: price inside its 20-day range."
    if px > up20:
        score = 0.5 + (0.25 if px > up55 else 0) + (0.25 if vol_ratio > 1.5 else 0)
        txt = f"Closed above the prior 20-day high ({up20:.2f}){' and 55-day high' if px > up55 else ''}; volume {vol_ratio:.1f}× 20-day average."
    elif px < lo20:
        score = -(0.5 + (0.25 if px < lo55 else 0) + (0.25 if vol_ratio > 1.5 else 0))
        txt = f"Closed below the prior 20-day low ({lo20:.2f}){' and 55-day low' if px < lo55 else ''}; volume {vol_ratio:.1f}× average."
    elif math.isfinite(squeeze) and squeeze < 0.15:
        txt = "Volatility compression (Bollinger width in bottom 15% of the year) — breakout setup, direction undetermined."
    flags = ["low_volume_breakout"] if score != 0 and vol_ratio < 1.0 else []
    return SignalResult("breakout", "Breakout", "technical", _clip(score), _dir(score), txt,
                        {"donchian20_high": up20, "donchian20_low": lo20, "donchian55_high": up55, "donchian55_low": lo55,
                         "volume_ratio": vol_ratio, "bb_width_pctile": squeeze}, flags)


def relative_strength(df: pd.DataFrame, bench: pd.DataFrame | None, sector: pd.DataFrame | None = None) -> SignalResult:
    if bench is None or len(df) < 70 or len(bench) < 70:
        return SignalResult("relative_strength", "Relative strength", "statistical", 0, "neutral", "Benchmark unavailable.", flags=["insufficient_data"])
    c = df["close"]
    b = bench["close"].reindex(c.index).ffill()
    rs63 = (c.iloc[-1] / c.iloc[-64]) / (b.iloc[-1] / b.iloc[-64]) - 1
    rs21 = (c.iloc[-1] / c.iloc[-22]) / (b.iloc[-1] / b.iloc[-22]) - 1
    vals = {"rs_vs_spy_63d": rs63, "rs_vs_spy_21d": rs21}
    txt = f"vs S&P 500: {rs63:+.1%} over 3 months, {rs21:+.1%} over 1 month"
    sc = 0.65 * math.tanh(rs63 / 0.10) + 0.35 * math.tanh(rs21 / 0.05)
    if sector is not None and len(sector) >= 64:
        s = sector["close"].reindex(c.index).ffill()
        rss = (c.iloc[-1] / c.iloc[-64]) / (s.iloc[-1] / s.iloc[-64]) - 1
        vals["rs_vs_sector_63d"] = rss
        txt += f"; vs sector {rss:+.1%} (3 months)"
        sc = 0.7 * sc + 0.3 * math.tanh(rss / 0.08)
    sc = _clip(sc)
    return SignalResult("relative_strength", "Relative strength", "statistical", sc, _dir(sc), txt + ".", vals)


def volatility(df: pd.DataFrame) -> SignalResult:
    c = df["close"]
    if len(c) < 60:
        return SignalResult("volatility", "Volatility", "statistical", 0, "info", "Insufficient history.", flags=["insufficient_data"])
    a = _last(ind.atr(df))
    atr_pct = a / float(c.iloc[-1])
    rv20 = _last(ind.realized_vol(c, 20))
    rv_pct = _last(ind.percentile_rank(ind.realized_vol(c, 20), 252))
    regime = "high" if rv_pct > 0.8 else "low" if rv_pct < 0.2 else "normal"
    flags = ["high_volatility"] if regime == "high" else []
    return SignalResult("volatility", "Volatility", "statistical", 0.0, "info",
                        f"ATR {a:.2f} ({atr_pct:.2%} of price); 20-day realized volatility {rv20:.0%} annualized, {regime} vs its 1-year history.",
                        {"atr": a, "atr_pct": atr_pct, "realized_vol_20d": rv20, "vol_percentile_1y": rv_pct, "vol_regime": regime}, flags)


def market_regime(spy: pd.DataFrame, universe_closes: dict[str, pd.Series] | None = None) -> SignalResult:
    """Rule-based market regime from the benchmark plus breadth."""
    c = spy["close"]
    if len(c) < 210:
        return SignalResult("regime", "Market regime", "regime", 0, "neutral", "Insufficient benchmark history.", values={"label": "unknown"})
    s50, s200 = _last(ind.sma(c, 50)), _last(ind.sma(c, 200))
    px = float(c.iloc[-1])
    rv = ind.realized_vol(c, 20)
    rv_pct = _last(ind.percentile_rank(rv, 504))
    dd = px / float(c.tail(252).max()) - 1
    breadth = None
    if universe_closes:
        above = [float(s.iloc[-1] > s.rolling(50).mean().iloc[-1]) for s in universe_closes.values() if len(s) > 55]
        breadth = sum(above) / len(above) if above else None
    if rv_pct > 0.85 and px < s200:
        label, score = "risk_off", -0.8
    elif rv_pct > 0.85:
        label, score = "high_volatility", -0.3
    elif px > s200 and s50 > s200:
        label, score = "risk_on_trend", 0.7
    elif px < s200 and s50 < s200:
        label, score = "downtrend", -0.6
    else:
        label, score = "range_bound", 0.0
    if breadth is not None:
        score = _clip(score + (breadth - 0.5) * 0.4)
    names = {"risk_on_trend": "Risk-on uptrend", "range_bound": "Range-bound / transition", "high_volatility": "High volatility",
             "downtrend": "Downtrend", "risk_off": "Risk-off (falling, volatile)", "unknown": "Unknown"}
    txt = (f"{names[label]}: S&P 500 proxy {'above' if px > s200 else 'below'} its 200-day average, "
           f"volatility at the {rv_pct:.0%} percentile of 2 years, {dd:.1%} from 1-year high"
           + (f"; {breadth:.0%} of universe above 50-day average." if breadth is not None else "."))
    return SignalResult("regime", "Market regime", "regime", score, _dir(score), txt,
                        {"label": label, "label_name": names[label], "vol_percentile_2y": rv_pct, "drawdown_1y": dd,
                         "breadth_above_50d": breadth, "spy_vs_200d": px / s200 - 1})


def event_risk(df: pd.DataFrame, next_earnings: datetime | None, blackout_days: int = 2) -> SignalResult:
    flags, vals, parts = [], {}, []
    score = 0.0
    if next_earnings:
        days = (next_earnings.date() - _clock.now().date()).days
        vals["days_to_earnings"] = days
        if 0 <= days <= blackout_days:
            flags.append("earnings_imminent")
            parts.append(f"Earnings in {days} day(s) — gap risk; signals around earnings are unreliable.")
        elif days >= 0:
            parts.append(f"Next earnings in ~{days} days.")
    else:
        vals["days_to_earnings"] = None
        parts.append("Earnings date unavailable from the data provider.")
    if len(df) > 22:
        gaps = (df["open"] / df["close"].shift(1) - 1).tail(10)
        g = gaps.abs().idxmax()
        if abs(gaps[g]) > 0.03:
            vr = df["volume"].loc[g] / df["volume"].iloc[-30:-10].mean()
            vals["recent_gap"] = float(gaps[g])
            parts.append(f"Recent {gaps[g]:+.1%} gap on {g.date()} with {vr:.1f}× volume.")
            score = _clip(math.tanh(gaps[g] / 0.05) * 0.5)  # post-event drift tendency, weak
            flags.append("recent_gap")
    return SignalResult("event", "Event-driven", "event", score, _dir(score) if score else "info", " ".join(parts), vals, flags)


def news_sentiment(items: list[dict], now: datetime | None = None) -> SignalResult:
    now = now or _clock.now()
    if not items:
        return SignalResult("news", "News sentiment", "sentiment", 0, "neutral", "No recent news from the provider.", {"articles": 0})
    num = den = 0.0
    for it in items:
        age_h = max(0.0, (now - it["ts"]).total_seconds() / 3600)
        w = 0.5 ** (age_h / 48)  # 48h half-life
        num += w * it["sentiment"]
        den += w
    s = num / den if den else 0
    sim = any(it.get("simulated") for it in items)
    return SignalResult("news", "News sentiment", "sentiment", _clip(s * 1.5), _dir(s * 1.5, 0.1),
                        f"{len(items)} articles in 7 days; recency-weighted lexicon sentiment {s:+.2f}" + (" (simulated headlines)." if sim else "."),
                        {"articles": len(items), "weighted_sentiment": s}, ["simulated_news"] if sim else [])


DIRECTIONAL = ("momentum", "mean_reversion", "trend", "breakout", "relative_strength", "event", "news")
