"""Yahoo Finance adapter via the community ``yfinance`` package.

No API key. Unofficial: Yahoo can change or throttle the endpoints without
notice, and quotes are typically delayed (exchange-dependent, often ~15 min for
some venues). Everything from this adapter is labelled DELAYED, never LIVE.
Use for personal research only; check Yahoo's terms before any other use.
"""
from __future__ import annotations

from datetime import datetime, timezone

import pandas as pd

from .. import market_hours
from .base import DataStatus, MarketDataProvider, NewsArticle, Profile, ProviderError, Quote

INTERVAL = {"1D": "1d", "1H": "60m", "15Min": "15m", "5Min": "5m", "1Min": "1m"}


def _yf():
    try:
        import yfinance as yf  # noqa: WPS433
    except ImportError as e:  # pragma: no cover
        raise ProviderError("yfinance is not installed", retryable=False) from e
    return yf


class YahooProvider(MarketDataProvider):
    name = "yahoo"
    label = "Yahoo Finance (unofficial)"
    rate_limit_per_min = 60
    quote_status = DataStatus.DELAYED
    supports_news = True
    notes = "No key needed. Unofficial and may break or throttle; quotes treated as delayed. Personal use only."

    def get_bars(self, symbol: str, timeframe: str, start: datetime, end: datetime) -> pd.DataFrame:
        yf = _yf()
        try:
            df = yf.Ticker(symbol).history(start=start, end=end + pd.Timedelta(days=1), interval=INTERVAL[timeframe],
                                           auto_adjust=True, actions=False, raise_errors=True)
        except Exception as e:  # yfinance raises many types
            raise ProviderError(f"Yahoo bars failed for {symbol}: {e}", retryable=True) from e
        if df is None or df.empty:
            return pd.DataFrame(columns=["open", "high", "low", "close", "volume"])
        df = df.rename(columns=str.lower)[["open", "high", "low", "close", "volume"]]
        idx = pd.DatetimeIndex(df.index)
        if timeframe == "1D":
            idx = idx.tz_localize(None).normalize().tz_localize("UTC") if idx.tz is not None else idx.normalize().tz_localize("UTC")
        else:
            idx = idx.tz_convert("UTC") if idx.tz is not None else idx.tz_localize("UTC")
        df.index = idx
        return df

    def get_quotes(self, symbols: list[str]) -> dict[str, Quote]:
        yf = _yf()
        out = {}
        sess = market_hours.session()
        now = datetime.now(timezone.utc)
        tickers = yf.Tickers(" ".join(symbols))
        errors = 0
        for s in symbols:
            try:
                fi = tickers.tickers[s].fast_info
                price = getattr(fi, "last_price", None)
                if not price:
                    continue

                def g(attr, _fi=fi):
                    try:
                        v = getattr(_fi, attr, None)
                        return float(v) if v is not None else None
                    except Exception:
                        return None
                out[s] = Quote(symbol=s, price=float(price), ts=now, status=DataStatus.DELAYED, source=self.name,
                               prev_close=g("previous_close"), open=g("open"),
                               high=g("day_high"), low=g("day_low"),
                               volume=g("last_volume"), session=sess,
                               venue_note="Yahoo, delay varies; timestamp = fetch time")
            except Exception:
                errors += 1
        if errors == len(symbols) and symbols:
            raise ProviderError("Yahoo quotes failed for all symbols", retryable=True)
        return out

    def get_news(self, symbols: list[str], limit: int = 50) -> list[NewsArticle]:
        yf = _yf()
        out: list[NewsArticle] = []
        for s in symbols[:15]:
            try:
                items = yf.Ticker(s).news or []
            except Exception:
                continue
            for n in items:
                c = n.get("content") if isinstance(n.get("content"), dict) else n
                title = c.get("title") or ""
                if not title:
                    continue
                ts_raw = c.get("pubDate") or c.get("providerPublishTime")
                ts = (datetime.fromtimestamp(ts_raw, timezone.utc) if isinstance(ts_raw, (int, float))
                      else pd.Timestamp(ts_raw).tz_convert("UTC").to_pydatetime() if ts_raw else datetime.now(timezone.utc))
                url = (c.get("canonicalUrl") or {}).get("url") if isinstance(c.get("canonicalUrl"), dict) else c.get("link", "")
                pub = (c.get("provider") or {}).get("displayName") if isinstance(c.get("provider"), dict) else c.get("publisher", "")
                out.append(NewsArticle(ext_id=str(n.get("id") or c.get("uuid") or title[:60]), ts=ts, headline=title,
                                       summary=c.get("summary") or "", url=url or "", publisher=pub or "", symbols=[s]))
        out.sort(key=lambda a: a.ts, reverse=True)
        return out[:limit]

    def get_profile(self, symbol: str) -> Profile | None:
        yf = _yf()
        try:
            t = yf.Ticker(symbol)
            info = t.info or {}
        except Exception as e:
            raise ProviderError(f"Yahoo profile failed: {e}", retryable=True) from e
        nxt = None
        try:
            cal = t.calendar
            ed = cal.get("Earnings Date") if isinstance(cal, dict) else None
            if ed:
                d = ed[0] if isinstance(ed, (list, tuple)) else ed
                nxt = datetime(d.year, d.month, d.day, tzinfo=timezone.utc)
        except Exception:
            pass
        from .. import universe as U
        name, sector = U.meta(symbol)
        dy = info.get("dividendYield")
        if dy is not None and dy < 1:   # older yfinance returns a fraction
            dy = dy * 100
        return Profile(symbol=symbol, name=info.get("longName") or info.get("shortName") or name,
                       sector=info.get("sector") or sector, industry=info.get("industry") or "",
                       market_cap=info.get("marketCap"), pe_ratio=info.get("trailingPE"), forward_pe=info.get("forwardPE"),
                       eps=info.get("trailingEps"), dividend_yield=dy, beta=info.get("beta"),
                       fifty_two_week_high=info.get("fiftyTwoWeekHigh"), fifty_two_week_low=info.get("fiftyTwoWeekLow"),
                       next_earnings=nxt, description=info.get("longBusinessSummary") or "", source=self.name)
