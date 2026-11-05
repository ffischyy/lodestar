"""Alpaca Market Data v2 adapter (REST).

Free "Basic" plan: real-time quotes from the IEX venue only (a single exchange,
not the consolidated tape), historical bars since 2016, 200 requests/min, and
consolidated (SIP) history only when older than 15 minutes. We therefore pull
daily bars from SIP with an end time >= 16 minutes ago and quotes from the
configured feed (default IEX), labelling them accordingly.
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone

import httpx
import pandas as pd

from .. import market_hours
from .base import DataStatus, MarketDataProvider, NewsArticle, Profile, ProviderError, Quote

DATA_URL = "https://data.alpaca.markets"
TRADING_URL = "https://paper-api.alpaca.markets"
TF = {"1D": "1Day", "1H": "1Hour", "15Min": "15Min", "5Min": "5Min", "1Min": "1Min"}


def _ts(s: str) -> datetime:
    return pd.Timestamp(s).tz_convert("UTC").to_pydatetime() if pd.Timestamp(s).tzinfo else pd.Timestamp(s).tz_localize("UTC").to_pydatetime()


class AlpacaProvider(MarketDataProvider):
    name = "alpaca"
    label = "Alpaca Market Data"
    requires_keys = ("ALPACA_API_KEY_ID", "ALPACA_API_SECRET_KEY")
    rate_limit_per_min = 190
    quote_status = DataStatus.LIVE
    supports_news = True
    notes = ("Free plan: real-time IEX venue only (not the full consolidated tape); SIP history delayed 15 min; "
             "200 requests/min. No fundamentals — profile fields come from Yahoo when available.")

    def __init__(self, key_id: str, secret: str, feed: str = "iex", transport: httpx.BaseTransport | None = None):
        if not key_id or not secret:
            raise ProviderError("Alpaca API key and secret are required", retryable=False)
        self.feed = feed
        self._client = httpx.Client(
            headers={"APCA-API-KEY-ID": key_id, "APCA-API-SECRET-KEY": secret, "Accept": "application/json"},
            timeout=httpx.Timeout(15.0, connect=8.0), transport=transport)

    def _get(self, url: str, params: dict | None = None) -> dict:
        try:
            r = self._client.get(url, params=params)
        except httpx.HTTPError as e:
            raise ProviderError(f"Alpaca network error: {e}", retryable=True) from e
        if r.status_code == 429:
            raise ProviderError("Alpaca rate limit reached (HTTP 429)", retryable=True, status=429)
        if r.status_code in (401, 403):
            raise ProviderError(f"Alpaca rejected the request (HTTP {r.status_code}): {r.text[:200]}", retryable=False, status=r.status_code)
        if r.status_code >= 500:
            raise ProviderError(f"Alpaca server error HTTP {r.status_code}", retryable=True, status=r.status_code)
        if r.status_code >= 400:
            raise ProviderError(f"Alpaca HTTP {r.status_code}: {r.text[:200]}", retryable=False, status=r.status_code)
        return r.json()

    def get_bars(self, symbol: str, timeframe: str, start: datetime, end: datetime) -> pd.DataFrame:
        feed = "sip" if self.feed == "iex" else self.feed
        latest_allowed = datetime.now(timezone.utc) - timedelta(minutes=16)
        if feed == "sip" and self.feed == "iex":
            end = min(end, latest_allowed)
        rows: list[dict] = []
        params = {"timeframe": TF[timeframe], "start": start.astimezone(timezone.utc).isoformat().replace("+00:00", "Z"),
                  "end": end.astimezone(timezone.utc).isoformat().replace("+00:00", "Z"),
                  "limit": 10000, "adjustment": "all", "feed": feed}
        token = None
        for _ in range(50):
            if token:
                params["page_token"] = token
            try:
                data = self._get(f"{DATA_URL}/v2/stocks/{symbol}/bars", params)
            except ProviderError as e:
                if e.status == 403 and feed == "sip":   # plan does not allow SIP -> retry on IEX
                    feed = params["feed"] = "iex"
                    continue
                raise
            rows.extend(data.get("bars") or [])
            token = data.get("next_page_token")
            if not token:
                break
        if not rows:
            return pd.DataFrame(columns=["open", "high", "low", "close", "volume"])
        df = pd.DataFrame(rows)
        idx = pd.to_datetime(df["t"], utc=True)
        if timeframe == "1D":
            idx = idx.dt.tz_convert(market_hours.ET).dt.normalize().dt.tz_localize(None).dt.tz_localize("UTC")
        out = pd.DataFrame({"open": df["o"].values, "high": df["h"].values, "low": df["l"].values,
                            "close": df["c"].values, "volume": df["v"].values}, index=pd.DatetimeIndex(idx))
        return out

    def get_quotes(self, symbols: list[str]) -> dict[str, Quote]:
        out: dict[str, Quote] = {}
        sess = market_hours.session()
        for i in range(0, len(symbols), 100):
            chunk = symbols[i:i + 100]
            data = self._get(f"{DATA_URL}/v2/stocks/snapshots", {"symbols": ",".join(chunk), "feed": self.feed})
            for sym, snap in (data or {}).items():
                if not snap:
                    continue
                trade = snap.get("latestTrade") or {}
                q = snap.get("latestQuote") or {}
                daily = snap.get("dailyBar") or {}
                prev = snap.get("prevDailyBar") or {}
                price = trade.get("p") or daily.get("c")
                if not price:
                    continue
                ts = _ts(trade["t"]) if trade.get("t") else datetime.now(timezone.utc)
                out[sym] = Quote(
                    symbol=sym, price=float(price), ts=ts,
                    status=DataStatus.LIVE if sess != "closed" else DataStatus.HISTORICAL, source=self.name,
                    prev_close=prev.get("c"), open=daily.get("o"), high=daily.get("h"), low=daily.get("l"),
                    volume=daily.get("v"), bid=q.get("bp") or None, ask=q.get("ap") or None, session=sess,
                    venue_note="IEX only" if self.feed == "iex" else "SIP consolidated")
        return out

    def get_news(self, symbols: list[str], limit: int = 50) -> list[NewsArticle]:
        params = {"limit": min(limit, 50), "sort": "desc", "include_content": "false"}
        if symbols:
            params["symbols"] = ",".join(symbols[:50])
        data = self._get(f"{DATA_URL}/v1beta1/news", params)
        out = []
        for n in data.get("news", []):
            out.append(NewsArticle(ext_id=str(n.get("id")), ts=_ts(n.get("created_at")), headline=n.get("headline", ""),
                                   summary=n.get("summary", "") or "", url=n.get("url", "") or "",
                                   publisher=n.get("source", "") or n.get("author", ""), symbols=n.get("symbols", [])))
        return out

    def get_profile(self, symbol: str) -> Profile | None:
        try:
            a = self._get(f"{TRADING_URL}/v2/assets/{symbol}")
        except ProviderError:
            return None
        from .. import universe as U
        name, sector = U.meta(symbol)
        return Profile(symbol=symbol, name=a.get("name") or name, sector=sector, source=self.name,
                       fields_unavailable=["market_cap", "pe_ratio", "eps", "dividend_yield", "beta", "next_earnings"])

    def check(self) -> dict:
        d = self._get(f"{DATA_URL}/v2/stocks/snapshots", {"symbols": "SPY", "feed": self.feed})
        return {"ok": "SPY" in d, "feed": self.feed}
