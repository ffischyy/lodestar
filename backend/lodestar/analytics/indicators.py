"""Technical indicators. All functions are causal: the value at bar t uses only bars <= t."""
from __future__ import annotations

import numpy as np
import pandas as pd


def unix_seconds(idx: pd.DatetimeIndex) -> list[int]:
    i = pd.DatetimeIndex(idx)
    if i.tz is not None:
        i = i.tz_convert("UTC").tz_localize(None)
    return i.values.astype("datetime64[s]").astype("int64").tolist()


def sma(s: pd.Series, n: int) -> pd.Series:
    return s.rolling(n, min_periods=n).mean()


def ema(s: pd.Series, n: int) -> pd.Series:
    return s.ewm(span=n, adjust=False, min_periods=n).mean()


def rsi(close: pd.Series, n: int = 14) -> pd.Series:
    """Wilder's RSI."""
    d = close.diff()
    up = d.clip(lower=0).ewm(alpha=1 / n, adjust=False, min_periods=n).mean()
    dn = (-d.clip(upper=0)).ewm(alpha=1 / n, adjust=False, min_periods=n).mean()
    rs = up / dn.replace(0, np.nan)
    out = 100 - 100 / (1 + rs)
    out = out.where(dn != 0, 100.0)
    return out.where(up.notna())


def macd(close: pd.Series, fast: int = 12, slow: int = 26, signal: int = 9) -> pd.DataFrame:
    line = ema(close, fast) - ema(close, slow)
    sig = line.ewm(span=signal, adjust=False, min_periods=signal).mean()
    return pd.DataFrame({"macd": line, "signal": sig, "hist": line - sig})


def true_range(df: pd.DataFrame) -> pd.Series:
    pc = df["close"].shift(1)
    return pd.concat([df["high"] - df["low"], (df["high"] - pc).abs(), (df["low"] - pc).abs()], axis=1).max(axis=1)


def atr(df: pd.DataFrame, n: int = 14) -> pd.Series:
    """Wilder's ATR."""
    return true_range(df).ewm(alpha=1 / n, adjust=False, min_periods=n).mean()


def bollinger(close: pd.Series, n: int = 20, k: float = 2.0) -> pd.DataFrame:
    m = sma(close, n)
    sd = close.rolling(n, min_periods=n).std(ddof=0)
    up, lo = m + k * sd, m - k * sd
    return pd.DataFrame({"mid": m, "upper": up, "lower": lo, "pct_b": (close - lo) / (up - lo), "width": (up - lo) / m})


def adx(df: pd.DataFrame, n: int = 14) -> pd.DataFrame:
    up = df["high"].diff()
    dn = -df["low"].diff()
    plus_dm = np.where((up > dn) & (up > 0), up, 0.0)
    minus_dm = np.where((dn > up) & (dn > 0), dn, 0.0)
    tr = true_range(df).ewm(alpha=1 / n, adjust=False, min_periods=n).mean()
    pdi = 100 * pd.Series(plus_dm, index=df.index).ewm(alpha=1 / n, adjust=False, min_periods=n).mean() / tr
    mdi = 100 * pd.Series(minus_dm, index=df.index).ewm(alpha=1 / n, adjust=False, min_periods=n).mean() / tr
    dx = 100 * (pdi - mdi).abs() / (pdi + mdi).replace(0, np.nan)
    return pd.DataFrame({"adx": dx.ewm(alpha=1 / n, adjust=False, min_periods=n).mean(), "plus_di": pdi, "minus_di": mdi})


def donchian(df: pd.DataFrame, n: int = 20) -> pd.DataFrame:
    """Channel of the *previous* n bars (excludes the current bar, so a breakout is detectable)."""
    hi = df["high"].rolling(n, min_periods=n).max().shift(1)
    lo = df["low"].rolling(n, min_periods=n).min().shift(1)
    return pd.DataFrame({"upper": hi, "lower": lo})


def realized_vol(close: pd.Series, n: int = 20, annualize: int = 252) -> pd.Series:
    r = np.log(close).diff()
    return r.rolling(n, min_periods=n).std() * np.sqrt(annualize)


def zscore(s: pd.Series, n: int = 20) -> pd.Series:
    m = s.rolling(n, min_periods=n).mean()
    sd = s.rolling(n, min_periods=n).std()
    return (s - m) / sd.replace(0, np.nan)


def obv(df: pd.DataFrame) -> pd.Series:
    sign = np.sign(df["close"].diff()).fillna(0)
    return (sign * df["volume"]).cumsum()


def vwap_rolling(df: pd.DataFrame, n: int = 20) -> pd.Series:
    tp = (df["high"] + df["low"] + df["close"]) / 3
    return (tp * df["volume"]).rolling(n).sum() / df["volume"].rolling(n).sum()


def percentile_rank(s: pd.Series, n: int = 252) -> pd.Series:
    """Rank of the current value within the trailing window (0..1)."""
    return s.rolling(n, min_periods=max(20, n // 4)).apply(lambda w: (w[:-1] < w[-1]).mean() if len(w) > 1 else np.nan, raw=True)


INDICATORS = {
    "sma20": lambda d: sma(d["close"], 20), "sma50": lambda d: sma(d["close"], 50), "sma200": lambda d: sma(d["close"], 200),
    "ema9": lambda d: ema(d["close"], 9), "ema21": lambda d: ema(d["close"], 21),
    "bb": lambda d: bollinger(d["close"]), "rsi": lambda d: rsi(d["close"]), "macd": lambda d: macd(d["close"]),
    "atr": lambda d: atr(d), "adx": lambda d: adx(d), "donchian": lambda d: donchian(d, 20), "vwap20": lambda d: vwap_rolling(d, 20),
}


def compute(df: pd.DataFrame, names: list[str]) -> dict:
    """Return indicator series as JSON-friendly {name: [{time, value...}]}."""
    out = {}
    t = unix_seconds(df.index)
    for n in names:
        if n not in INDICATORS:
            continue
        r = INDICATORS[n](df)
        if isinstance(r, pd.Series):
            out[n] = [{"time": ti, "value": round(float(v), 4)} for ti, v in zip(t, r.to_numpy()) if np.isfinite(v)]
        else:
            out[n] = {c: [{"time": ti, "value": round(float(v), 4)} for ti, v in zip(t, r[c].to_numpy()) if np.isfinite(v)] for c in r.columns}
    return out
