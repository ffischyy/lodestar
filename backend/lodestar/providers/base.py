"""Provider-independent market data contracts."""
from __future__ import annotations

import abc
from dataclasses import asdict, dataclass, field
from datetime import datetime
from enum import Enum

import pandas as pd


class DataStatus(str, Enum):
    LIVE = "live"            # real-time from an exchange feed (may be a single venue, e.g. IEX)
    DELAYED = "delayed"      # real market data with a known/likely delay
    CACHED = "cached"        # served from local cache because the provider was unavailable
    HISTORICAL = "historical"  # end-of-period bars, not a current quote
    SIMULATED = "simulated"  # synthetic, never real market prices
    REPLAY = "replay"        # real past prices replayed on a simulated clock (Sandbox only)
    STALE = "stale"          # real data that is older than the freshness threshold


@dataclass
class Quote:
    symbol: str
    price: float
    ts: datetime                      # provider timestamp (UTC)
    status: DataStatus
    source: str
    prev_close: float | None = None
    open: float | None = None
    high: float | None = None
    low: float | None = None
    volume: float | None = None
    bid: float | None = None
    ask: float | None = None
    session: str = "regular"          # pre|regular|post|closed
    venue_note: str = ""              # e.g. "IEX only"

    @property
    def change(self) -> float | None:
        return None if not self.prev_close else self.price - self.prev_close

    @property
    def change_pct(self) -> float | None:
        return None if not self.prev_close else (self.price / self.prev_close - 1.0) * 100.0

    @property
    def spread_bps(self) -> float | None:
        if self.bid and self.ask and self.ask >= self.bid > 0:
            mid = (self.bid + self.ask) / 2
            return (self.ask - self.bid) / mid * 1e4
        return None

    def to_dict(self) -> dict:
        d = asdict(self)
        d["ts"] = self.ts.isoformat()
        d["status"] = self.status.value
        d["change"] = self.change
        d["change_pct"] = self.change_pct
        d["spread_bps"] = self.spread_bps
        return d


@dataclass
class NewsArticle:
    ext_id: str
    ts: datetime
    headline: str
    summary: str
    url: str
    publisher: str
    symbols: list[str] = field(default_factory=list)
    simulated: bool = False


@dataclass
class Profile:
    symbol: str
    name: str
    sector: str
    industry: str = ""
    market_cap: float | None = None
    pe_ratio: float | None = None
    forward_pe: float | None = None
    eps: float | None = None
    dividend_yield: float | None = None
    beta: float | None = None
    fifty_two_week_high: float | None = None
    fifty_two_week_low: float | None = None
    next_earnings: datetime | None = None
    description: str = ""
    source: str = ""
    simulated: bool = False
    fields_unavailable: list[str] = field(default_factory=list)

    def to_dict(self) -> dict:
        d = asdict(self)
        d["next_earnings"] = self.next_earnings.isoformat() if self.next_earnings else None
        return d


class ProviderError(Exception):
    """Raised for provider failures. ``retryable`` marks transient errors."""

    def __init__(self, msg: str, retryable: bool = True, status: int | None = None):
        super().__init__(msg)
        self.retryable = retryable
        self.status = status


BAR_COLUMNS = ["open", "high", "low", "close", "volume"]


class MarketDataProvider(abc.ABC):
    """Every adapter returns bars as a DataFrame indexed by UTC timestamps with
    BAR_COLUMNS, sorted ascending, without duplicate timestamps. Daily bars are
    stamped at 00:00 UTC of the trading date and are split/dividend adjusted where
    the provider supports it (see ``adjusted``)."""

    name: str = "base"
    label: str = "Base"
    requires_keys: tuple[str, ...] = ()
    rate_limit_per_min: int = 60
    quote_status: DataStatus = DataStatus.DELAYED
    adjusted: bool = True
    supports_news: bool = False
    supports_intraday: bool = True
    notes: str = ""

    @abc.abstractmethod
    def get_bars(self, symbol: str, timeframe: str, start: datetime, end: datetime) -> pd.DataFrame:
        """timeframe: '1D' | '1H' | '15Min' | '5Min' | '1Min'"""

    @abc.abstractmethod
    def get_quotes(self, symbols: list[str]) -> dict[str, Quote]:
        ...

    def get_news(self, symbols: list[str], limit: int = 50) -> list[NewsArticle]:
        return []

    def get_profile(self, symbol: str) -> Profile | None:
        return None

    def capabilities(self) -> dict:
        return {
            "name": self.name,
            "label": self.label,
            "requires_keys": list(self.requires_keys),
            "rate_limit_per_min": self.rate_limit_per_min,
            "quote_status": self.quote_status.value,
            "adjusted": self.adjusted,
            "news": self.supports_news,
            "intraday": self.supports_intraday,
            "notes": self.notes,
        }


def validate_bars(df: pd.DataFrame) -> tuple[pd.DataFrame, list[str]]:
    """Clean a bar frame and report what was fixed. Never invents prices."""
    issues: list[str] = []
    if df is None or df.empty:
        return pd.DataFrame(columns=BAR_COLUMNS), issues
    df = df.copy()
    df = df[BAR_COLUMNS].astype(float)
    if df.index.tz is None:
        df.index = df.index.tz_localize("UTC")
    else:
        df.index = df.index.tz_convert("UTC")
    n0 = len(df)
    df = df[~df.index.duplicated(keep="last")].sort_index()
    if len(df) != n0:
        issues.append(f"removed {n0 - len(df)} duplicate bars")
    bad = df[["open", "high", "low", "close"]].isna().any(axis=1) | (df[["open", "high", "low", "close"]] <= 0).any(axis=1)
    if bad.any():
        issues.append(f"dropped {int(bad.sum())} bars with missing/non-positive prices")
        df = df[~bad]
    # repair inconsistent high/low envelopes (provider rounding) rather than drop
    hi = df[["open", "close", "high"]].max(axis=1)
    lo = df[["open", "close", "low"]].min(axis=1)
    fixed = int(((hi != df["high"]) | (lo != df["low"])).sum())
    if fixed:
        issues.append(f"repaired high/low envelope on {fixed} bars")
        df["high"], df["low"] = hi, lo
    df["volume"] = df["volume"].fillna(0).clip(lower=0)
    return df, issues
