"""Feature and label construction.

Look-ahead rules (enforced by tests):
  * Every feature at row t is computed from bars with index <= t.
  * Labels at row t use bars t+1 .. t+h only, and are NaN for the last h rows.
  * Cross-sectional features (ranks, breadth) only combine values from the same date.
"""
from __future__ import annotations

import numpy as np
import pandas as pd

from ..analytics import indicators as ind

FEATURES = [
    "r1", "r5", "r21", "r63", "r126_skip5", "vol20", "vol60", "vol_ratio", "atr_pct", "rsi14", "rsi2", "z20", "pct_b",
    "dist_ema20", "dist_sma50", "dist_sma200", "adx", "macd_hist_n", "logvol_ratio", "donchian_pos",
    "rs21", "rs63", "spy_r21", "spy_vol20", "spy_dist200", "xs_rank_r21", "xs_rank_r63", "xs_rank_vol20", "breadth50",
]


def symbol_features(df: pd.DataFrame, spy: pd.DataFrame) -> pd.DataFrame:
    c = df["close"]
    lc = np.log(c)
    f = pd.DataFrame(index=df.index)
    f["r1"] = lc.diff(1)
    f["r5"] = lc.diff(5)
    f["r21"] = lc.diff(21)
    f["r63"] = lc.diff(63)
    f["r126_skip5"] = lc.shift(5) - lc.shift(126)
    f["vol20"] = ind.realized_vol(c, 20)
    f["vol60"] = ind.realized_vol(c, 60)
    f["vol_ratio"] = f["vol20"] / f["vol60"]
    a = ind.atr(df)
    f["atr_pct"] = a / c
    f["rsi14"] = ind.rsi(c, 14) / 100
    f["rsi2"] = ind.rsi(c, 2) / 100
    f["z20"] = ind.zscore(c, 20)
    f["pct_b"] = ind.bollinger(c)["pct_b"]
    f["dist_ema20"] = c / ind.ema(c, 20) - 1
    f["dist_sma50"] = c / ind.sma(c, 50) - 1
    f["dist_sma200"] = c / ind.sma(c, 200) - 1
    f["adx"] = ind.adx(df)["adx"] / 100
    f["macd_hist_n"] = ind.macd(c)["hist"] / c
    f["logvol_ratio"] = np.log((df["volume"] + 1) / (df["volume"].rolling(20).mean() + 1))
    d = ind.donchian(df, 20)
    f["donchian_pos"] = (c - d["lower"]) / (d["upper"] - d["lower"])
    sc = spy["close"].reindex(df.index).ffill()
    lsc = np.log(sc)
    f["rs21"] = f["r21"] - lsc.diff(21)
    f["rs63"] = f["r63"] - lsc.diff(63)
    f["spy_r21"] = lsc.diff(21)
    f["spy_vol20"] = ind.realized_vol(sc, 20)
    f["spy_dist200"] = sc / ind.sma(sc, 200) - 1
    f["_above50"] = (c > ind.sma(c, 50)).astype(float).where(ind.sma(c, 50).notna())
    return f.replace([np.inf, -np.inf], np.nan)


def labels(df: pd.DataFrame, horizon: int, k_target: float, k_stop: float) -> pd.DataFrame:
    """Forward-looking targets. Barrier distances use ATR known at t."""
    c = df["close"].to_numpy()
    h_ = df["high"].to_numpy()
    l_ = df["low"].to_numpy()
    atrp = (ind.atr(df) / df["close"]).to_numpy()
    n = len(df)
    fwd = np.full(n, np.nan)
    tb_long = np.full(n, np.nan)
    tb_short = np.full(n, np.nan)
    mfe = np.full(n, np.nan)
    mae = np.full(n, np.nan)
    for t in range(n - horizon):
        if not np.isfinite(atrp[t]):
            continue
        p = c[t]
        hi = h_[t + 1:t + 1 + horizon]
        lo = l_[t + 1:t + 1 + horizon]
        fwd[t] = c[t + horizon] / p - 1
        mfe[t] = hi.max() / p - 1
        mae[t] = lo.min() / p - 1
        up, dn = p * (1 + k_target * atrp[t]), p * (1 - k_stop * atrp[t])
        tb_long[t] = _first_touch(hi, lo, up, dn)
        # short: target below, stop above (mirror)
        s_t, s_s = p * (1 - k_target * atrp[t]), p * (1 + k_stop * atrp[t])
        tb_short[t] = _first_touch_short(hi, lo, s_t, s_s)
    return pd.DataFrame({"fwd_ret": fwd, "y_up": np.where(np.isfinite(fwd), (fwd > 0).astype(float), np.nan),
                         "y_tb_long": tb_long, "y_tb_short": tb_short, "mfe": mfe, "mae": mae}, index=df.index)


def _first_touch(hi, lo, up, dn) -> float:
    for a, b in zip(hi, lo):
        hit_up, hit_dn = a >= up, b <= dn
        if hit_dn:            # conservative: same-bar touch counts as stop
            return 0.0
        if hit_up:
            return 1.0
    return 0.0                # timeout counts as failure to reach target first


def _first_touch_short(hi, lo, tgt, stp) -> float:
    for a, b in zip(hi, lo):
        if a >= stp:
            return 0.0
        if b <= tgt:
            return 1.0
    return 0.0


def build_panel(bars: dict[str, pd.DataFrame], spy: pd.DataFrame, horizon: int, k_target: float, k_stop: float,
                with_labels: bool = True) -> pd.DataFrame:
    frames = []
    for sym, df in bars.items():
        if len(df) < 260:
            continue
        f = symbol_features(df, spy)
        if with_labels:
            f = f.join(labels(df, horizon, k_target, k_stop))
        f["symbol"] = sym
        f["close"] = df["close"]
        frames.append(f)
    if not frames:
        return pd.DataFrame()
    p = pd.concat(frames)
    p.index.name = "date"
    p = p.reset_index()
    g = p.groupby("date")
    p["xs_rank_r21"] = g["r21"].rank(pct=True)
    p["xs_rank_r63"] = g["r63"].rank(pct=True)
    p["xs_rank_vol20"] = g["vol20"].rank(pct=True)
    p["breadth50"] = g["_above50"].transform("mean")
    p = p.drop(columns=["_above50"])
    return p.sort_values(["date", "symbol"]).reset_index(drop=True)
