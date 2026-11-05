"""Strategy interface and built-in strategies.

A strategy turns per-symbol daily bars into entry signals evaluated at the *close* of
bar t; the engine executes them at the *open* of bar t+1. Signals may only use data
up to and including bar t.
"""
from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np
import pandas as pd

from ..analytics import indicators as ind
from ..ml.features import FEATURES, build_panel
from ..ml.models import fit_calibrated


@dataclass
class StrategyInfo:
    key: str
    name: str
    description: str
    params: dict
    exit_rule: str
    long_short: str
    tags: list[str] = field(default_factory=list)


STRATEGIES: dict[str, StrategyInfo] = {
    "momentum": StrategyInfo("momentum", "Cross-sectional momentum",
        "Buys stocks in the top fraction of the universe by 6-month return (skipping the most recent week) that are above "
        "their 200-day average; shorts the bottom fraction below it when shorting is enabled.",
        {"top_pct": 0.2, "lookback": 126}, "ATR stop/target or max holding period", "long/short", ["technical", "trend"]),
    "mean_reversion": StrategyInfo("mean_reversion", "Short-term mean reversion",
        "Buys when 2-day RSI is deeply oversold while the stock is above its 200-day average (pullback in an uptrend); "
        "the mirror for shorts. Exits early when RSI(2) recovers.",
        {"rsi2_entry": 10, "rsi2_exit": 70}, "RSI(2) recovery, ATR stop/target or max hold", "long/short", ["statistical"]),
    "trend": StrategyInfo("trend", "Trend following",
        "Enters when EMA20 > EMA50 > SMA200 becomes aligned with ADX above a threshold (strong, established trend).",
        {"adx_min": 25}, "ATR stop/target or max hold", "long/short", ["technical", "trend"]),
    "breakout": StrategyInfo("breakout", "Channel breakout",
        "Enters when price closes beyond the prior N-day high (low) on volume at least a multiple of its 20-day average.",
        {"channel": 20, "volume_mult": 1.5}, "ATR stop/target or max hold", "long/short", ["technical"]),
    "ml_forecast": StrategyInfo("ml_forecast", "ML forecast (walk-forward)",
        "Re-trains a calibrated logistic model every quarter using only data available at that time (purged windows), "
        "then trades when the calibrated probability of reaching the target before the stop exceeds the training base rate "
        "by a margin. Every trade is out-of-sample.",
        {"min_prob_edge": 0.03}, "ATR barrier stop/target or max hold", "long/short", ["ml"]),
}


def _rule_signals(key: str, bars: dict[str, pd.DataFrame], params: dict) -> dict[str, pd.DataFrame]:
    out = {}
    if key == "momentum":
        lb = int(params.get("lookback", 126))
        mom = pd.DataFrame({s: np.log(d["close"]).shift(5) - np.log(d["close"]).shift(lb) for s, d in bars.items()})
        rank = mom.rank(axis=1, pct=True)
        top = float(params.get("top_pct", 0.2))
        for s, d in bars.items():
            above = d["close"] > ind.sma(d["close"], 200)
            r = rank[s].reindex(d.index)
            prev = r.shift(1)
            out[s] = pd.DataFrame({"long": (r >= 1 - top) & above & ~(prev >= 1 - top),
                                   "short": (r <= top) & ~above & ~(prev <= top),
                                   "score": (r - 0.5).abs(), "exit": pd.Series(False, index=d.index)}, index=d.index)
    elif key == "mean_reversion":
        e, x = float(params.get("rsi2_entry", 10)), float(params.get("rsi2_exit", 70))
        for s, d in bars.items():
            r2 = ind.rsi(d["close"], 2)
            above = d["close"] > ind.sma(d["close"], 200)
            out[s] = pd.DataFrame({"long": (r2 < e) & above, "short": (r2 > 100 - e) & ~above,
                                   "score": (50 - r2).abs() / 50, "exit_long": r2 > x, "exit_short": r2 < 100 - x}, index=d.index)
    elif key == "trend":
        amin = float(params.get("adx_min", 25))
        for s, d in bars.items():
            c = d["close"]
            e20, e50, s200 = ind.ema(c, 20), ind.ema(c, 50), ind.sma(c, 200)
            a = ind.adx(d)["adx"]
            up = (e20 > e50) & (e50 > s200) & (a > amin)
            dn = (e20 < e50) & (e50 < s200) & (a > amin)
            out[s] = pd.DataFrame({"long": up & ~up.shift(1, fill_value=False), "short": dn & ~dn.shift(1, fill_value=False),
                                   "score": a / 100}, index=d.index)
    elif key == "breakout":
        n, vm = int(params.get("channel", 20)), float(params.get("volume_mult", 1.5))
        for s, d in bars.items():
            ch = ind.donchian(d, n)
            vr = d["volume"] / d["volume"].rolling(20).mean().shift(1)
            out[s] = pd.DataFrame({"long": (d["close"] > ch["upper"]) & (vr > vm), "short": (d["close"] < ch["lower"]) & (vr > vm),
                                   "score": vr.fillna(0) / 5}, index=d.index)
    return out


def ml_signals(bars: dict[str, pd.DataFrame], spy: pd.DataFrame, horizon: int, kt: float, ks: float, params: dict,
               start: pd.Timestamp, progress=None) -> dict[str, pd.DataFrame]:
    """Walk-forward: for each quarter after ``start`` fit on data whose labels end before it."""
    panel = build_panel(bars, spy, horizon, kt, ks)
    lab = panel.dropna(subset=["y_tb_long", "vol20"])
    dates = np.array(sorted(panel["date"].unique()))
    test_dates = dates[dates >= start]
    edge = float(params.get("min_prob_edge", 0.03))
    preds = []
    chunks = [test_dates[i:i + 63] for i in range(0, len(test_dates), 63)]
    for ci, chunk in enumerate(chunks):
        t0 = chunk[0]
        idx = np.searchsorted(dates, t0)
        cal_end = dates[max(0, idx - horizon)]
        cal_start = dates[max(0, idx - horizon - 126)]
        fit_end = dates[max(0, idx - 2 * horizon - 126)]
        F = lab[lab.date < fit_end]
        C = lab[(lab.date >= cal_start) & (lab.date < cal_end)]
        if len(F) < 2000 or len(C) < 200:
            continue
        T = panel[panel.date.isin(chunk)]
        ml = fit_calibrated("logistic", F[FEATURES], F.y_tb_long, C[FEATURES], C.y_tb_long)
        ms = fit_calibrated("logistic", F[FEATURES], F.y_tb_short, C[FEATURES], C.y_tb_short)
        pl, ps = ml.predict(T[FEATURES]), ms.predict(T[FEATURES])
        preds.append(pd.DataFrame({"date": T["date"].reset_index(drop=True), "symbol": T["symbol"].reset_index(drop=True),
                                   "el": pl - F.y_tb_long.mean(), "es": ps - F.y_tb_short.mean()}))
        if progress:
            progress(ci + 1, len(chunks))
    if not preds:
        return {}
    P = pd.concat(preds)
    out = {}
    for s, g in P.groupby("symbol"):
        g = g.set_index("date").reindex(bars[s].index)
        out[s] = pd.DataFrame({"long": g.el > edge, "short": g.es > edge, "score": np.maximum(g.el, g.es).fillna(0)}, index=bars[s].index)
    return out


def generate(key: str, bars: dict[str, pd.DataFrame], spy: pd.DataFrame, params: dict, horizon: int, kt: float, ks: float,
             start: pd.Timestamp, progress=None) -> dict[str, pd.DataFrame]:
    if key == "ml_forecast":
        return ml_signals(bars, spy, horizon, kt, ks, params, start, progress)
    if key not in STRATEGIES:
        raise ValueError(f"unknown strategy {key}")
    sig = _rule_signals(key, bars, params)
    for s, df in sig.items():
        for c in ("long", "short"):
            df[c] = df[c].fillna(False).astype(bool)
        df["score"] = df["score"].fillna(0.0)
    return sig
