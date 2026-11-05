import json
from datetime import datetime, timedelta, timezone

import httpx
import numpy as np
import pandas as pd
import pytest

from lodestar.paper import engine as paper
from lodestar.providers.base import DataStatus, Quote, validate_bars


# ---------------------------------------------------------------- paper trading
@pytest.fixture
def acct(clean_settings, fixed_quotes):
    paper.reset(100_000)
    from lodestar.settings_store import update_settings
    update_settings({"paper": {"trading_enabled": True}, "general": {"allow_short": True}})
    fixed_quotes.update({"AAPL": 100.0, "XOM": 50.0, "JPM": 100.0})
    return fixed_quotes


def test_buy_then_partial_sell_realizes_pnl(acct):
    paper.submit("AAPL", "buy", 100)
    acct["AAPL"] = 110.0
    paper.submit("AAPL", "sell", 40)
    s = paper.snapshot()
    assert s["realized_pnl"] == pytest.approx(400.0)
    pos = s["positions"][0]
    assert pos["qty"] == 60 and pos["avg_price"] == pytest.approx(100.0)
    assert s["equity"] == pytest.approx(100_000 + 400 + 60 * 10)


def test_short_and_cover(acct):
    paper.submit("XOM", "sell", 100)
    acct["XOM"] = 45.0
    s = paper.snapshot()
    assert s["positions"][0]["unrealized"] == pytest.approx(500.0)
    paper.submit("XOM", "buy", 100)
    s = paper.snapshot()
    assert not s["positions"] and s["realized_pnl"] == pytest.approx(500.0)
    assert s["cash"] == pytest.approx(100_500.0)


def test_bracket_oco_take_profit(acct):
    paper.submit("AAPL", "buy", 50, stop_loss=95.0, take_profit=108.0)
    s = paper.snapshot()
    legs = [o for o in s["orders"] if o["parent_id"]]
    assert {o["type"] for o in legs} == {"stop", "limit"}
    acct["AAPL"] = 109.0
    fills = paper.process_quotes(paper.data.quotes(["AAPL"]))
    assert len(fills) == 1 and fills[0]["type"] == "limit"
    s = paper.snapshot()
    assert not s["positions"]
    stop_leg = next(o for o in s["orders"] if o["type"] == "stop" and o["parent_id"])
    assert stop_leg["status"] == "cancelled"


def test_stop_gap_fills_at_market_not_stop(acct):
    paper.submit("AAPL", "buy", 10, stop_loss=95.0)
    acct["AAPL"] = 80.0
    fills = paper.process_quotes(paper.data.quotes(["AAPL"]))
    assert fills[0]["price"] == pytest.approx(80.0)


def test_duplicate_client_order_id(acct):
    a = paper.submit("AAPL", "buy", 1, client_order_id="abc-1")
    b = paper.submit("AAPL", "buy", 1, client_order_id="abc-1")
    assert b.get("duplicate") and a["id"] == b["id"]
    assert paper.snapshot()["positions"][0]["qty"] == 1


def test_risk_rejection_is_recorded(acct):
    with pytest.raises(paper.OrderError) as e:
        paper.submit("AAPL", "buy", 5000)   # $500k > cash and > position limit
    assert e.value.violations
    assert paper.snapshot()["orders"][0]["status"] == "rejected"


def test_kill_switch_blocks_new_orders(acct):
    paper.submit("JPM", "buy", 10, order_type="limit", limit_price=90)
    r = paper.kill_switch(flatten=False)
    assert r["cancelled"] == 1
    with pytest.raises(paper.OrderError):
        paper.submit("AAPL", "buy", 1)


def test_wrong_side_stop_rejected(acct):
    with pytest.raises(paper.OrderError):
        paper.submit("AAPL", "buy", 1, stop_loss=105.0)


def test_daily_loss_halt(acct):
    from lodestar.settings_store import update_settings
    update_settings({"risk": {"max_daily_loss_pct": 1.0, "max_position_pct": 100.0, "max_sector_pct": 100.0}})
    paper.submit("AAPL", "buy", 500)
    acct["AAPL"] = 95.0       # -2.5% of equity
    paper.process_quotes(paper.data.quotes(["AAPL"]))
    assert paper.snapshot()["halted_reason"]
    with pytest.raises(paper.OrderError):
        paper.submit("XOM", "buy", 1)
    paper.submit("AAPL", "sell", 500)  # exits still allowed


# ---------------------------------------------------------------- data validation & providers
def test_validate_bars_cleans_duplicates_and_bad_rows():
    idx = pd.DatetimeIndex(["2024-01-02", "2024-01-02", "2024-01-03", "2024-01-04"], tz="UTC")
    df = pd.DataFrame({"open": [10, 10, np.nan, 11], "high": [9, 9, 12, 12], "low": [9.5, 9.5, 9, 10],
                       "close": [10, 10.5, 11, 11.5], "volume": [1, 1, 1, -5]}, index=idx)
    out, issues = validate_bars(df)
    assert len(out) == 2 and out.index.is_unique
    assert (out["high"] >= out[["open", "close"]].max(axis=1)).all()
    assert (out["volume"] >= 0).all() and issues


def _alpaca(handler):
    from lodestar.providers.alpaca import AlpacaProvider
    return AlpacaProvider("k", "s", "iex", transport=httpx.MockTransport(handler))


def test_alpaca_bars_pagination_and_sip_fallback():
    calls = []

    def handler(req: httpx.Request):
        calls.append(dict(req.url.params))
        assert req.headers["APCA-API-KEY-ID"] == "k"
        if req.url.params.get("feed") == "sip":
            return httpx.Response(403, json={"message": "subscription does not permit querying recent SIP data"})
        if "page_token" not in req.url.params:
            return httpx.Response(200, json={"bars": [{"t": "2024-01-02T05:00:00Z", "o": 1, "h": 2, "l": 0.5, "c": 1.5, "v": 100}],
                                             "next_page_token": "p2"})
        return httpx.Response(200, json={"bars": [{"t": "2024-01-03T05:00:00Z", "o": 1.5, "h": 2, "l": 1, "c": 1.8, "v": 120}],
                                         "next_page_token": None})
    p = _alpaca(handler)
    df = p.get_bars("AAPL", "1D", datetime(2024, 1, 1, tzinfo=timezone.utc), datetime(2024, 1, 5, tzinfo=timezone.utc))
    assert list(df["close"]) == [1.5, 1.8]
    assert str(df.index[0].date()) == "2024-01-02" and df.index.tz is not None
    assert calls[0]["feed"] == "sip" and calls[-1]["feed"] == "iex"


def test_alpaca_snapshots_and_errors():
    from lodestar.providers.base import ProviderError

    def handler(req):
        if "snapshots" in req.url.path:
            return httpx.Response(200, json={"SPY": {"latestTrade": {"t": "2024-01-02T15:00:00Z", "p": 470.1},
                                                     "latestQuote": {"bp": 470.0, "ap": 470.2}, "dailyBar": {"o": 468, "h": 471, "l": 467, "c": 470, "v": 1e6},
                                                     "prevDailyBar": {"c": 465}}})
        return httpx.Response(429, json={})
    p = _alpaca(handler)
    q = p.get_quotes(["SPY"])["SPY"]
    assert q.price == 470.1 and q.prev_close == 465 and q.spread_bps == pytest.approx(4.25, rel=0.01)
    assert q.venue_note == "IEX only"
    with pytest.raises(ProviderError) as e:
        p.get_news(["SPY"])
    assert e.value.retryable and e.value.status == 429


def test_yahoo_news_parses_both_formats(monkeypatch):
    from lodestar.providers import yahoo

    class T:
        def __init__(self, s):
            self.news = [
                {"id": "a1", "content": {"title": "New format headline", "summary": "s", "pubDate": "2024-05-01T12:00:00Z",
                                         "canonicalUrl": {"url": "https://x"}, "provider": {"displayName": "Pub"}}},
                {"uuid": "b2", "title": "Old format headline", "providerPublishTime": 1714564800, "link": "https://y", "publisher": "P2"},
            ]

    class FakeYF:
        Ticker = T
    monkeypatch.setattr(yahoo, "_yf", lambda: FakeYF)
    arts = yahoo.YahooProvider().get_news(["AAPL"])
    assert {a.headline for a in arts} == {"New format headline", "Old format headline"}
    assert all(a.ts.tzinfo is not None for a in arts)


def test_simulation_is_deterministic_and_labelled():
    from lodestar.providers.simulated import SimulatedProvider
    from datetime import date
    a = SimulatedProvider(end=date(2024, 6, 28))
    b = SimulatedProvider(end=date(2024, 6, 28))
    s, e = datetime(2023, 1, 1, tzinfo=timezone.utc), datetime(2024, 7, 1, tzinfo=timezone.utc)
    pd.testing.assert_frame_equal(a.get_bars("AAPL", "1D", s, e), b.get_bars("AAPL", "1D", s, e))
    assert all(q.status == DataStatus.SIMULATED for q in a.get_quotes(["AAPL", "SPY"]).values())
    assert all(n.simulated for n in a.get_news(["AAPL", "MSFT", "NVDA"]))


def test_rate_limiter_blocks_when_empty():
    from lodestar.providers.manager import RateLimiter
    from lodestar.providers.base import ProviderError
    rl = RateLimiter(2)
    rl.acquire()
    rl.acquire()
    with pytest.raises(ProviderError):
        rl.acquire(max_wait=0.05)


# ---------------------------------------------------------------- API
@pytest.fixture
def client():
    from fastapi.testclient import TestClient
    from lodestar.main import app
    app.state.no_background = True
    with TestClient(app) as c:
        yield c


def test_api_settings_validation(client):
    r = client.patch("/api/settings", json={"live_trading": {"enabled": True}})
    assert r.status_code == 400 and "not implemented" in r.json()["detail"]
    r = client.patch("/api/settings", json={"risk": {"risk_per_trade_pct": 50}})
    assert r.status_code == 400
    r = client.patch("/api/settings", json={"risk": {"risk_per_trade_pct": 0.5}})
    assert r.status_code == 200 and r.json()["settings"]["risk"]["risk_per_trade_pct"] == 0.5
    client.post("/api/settings/reset")


def test_api_watchlist_crud_persists(client):
    r = client.post("/api/watchlists", json={"name": "Core", "symbols": ["aapl", "msft", "AAPL"]})
    wid = r.json()["id"]
    assert r.json()["symbols"] == ["AAPL", "MSFT"]
    assert client.post("/api/watchlists", json={"name": "Bad", "symbols": ["<script>"]}).status_code == 400
    client.put(f"/api/watchlists/{wid}", json={"name": "Core 2", "symbols": ["NVDA"]})
    assert any(w["name"] == "Core 2" and w["symbols"] == ["NVDA"] for w in client.get("/api/watchlists").json())
    client.delete(f"/api/watchlists/{wid}")


def test_api_dashboards(client):
    d = client.get("/api/dashboards").json()
    assert d["dashboards"] and any(x["is_default"] for x in d["dashboards"])
    first = d["dashboards"][0]["id"]
    dup = client.post(f"/api/dashboards/{first}/duplicate").json()
    bad = client.put(f"/api/dashboards/{dup['id']}", json={"name": "x", "layout": [{"i": "a", "widget": "nope", "x": 0, "y": 0, "w": 1, "h": 1}]})
    assert bad.status_code == 400
    ok = client.put(f"/api/dashboards/{dup['id']}", json={"name": "Mine", "layout": [{"i": "a", "widget": "news", "x": 0, "y": 0, "w": 6, "h": 4}]})
    assert ok.status_code == 200
    client.post(f"/api/dashboards/{dup['id']}/default")
    assert next(x for x in client.get("/api/dashboards").json()["dashboards"] if x["id"] == dup["id"])["is_default"]
    client.post(f"/api/dashboards/{first}/default")
    client.delete(f"/api/dashboards/{dup['id']}")


def test_api_theme_rejects_injection(client):
    r = client.post("/api/themes", json={"name": "Evil", "tokens": {"bg": "red;}</style><script>"}})
    assert r.status_code == 400
    r = client.post("/api/themes", json={"name": "Mine", "base": "meridian", "tokens": {"bg": "#101418", "accent": "#4fb3ff"}})
    assert r.status_code == 200


def test_api_alert_validation(client):
    assert client.post("/api/alerts", json={"name": "x", "kind": "price_above"}).status_code == 400
    r = client.post("/api/alerts", json={"name": "AAPL > 1", "kind": "price_above", "symbol": "aapl", "threshold": 1})
    assert r.status_code == 200 and r.json()["symbol"] == "AAPL"


def test_api_keys_are_masked(client):
    r = client.put("/api/providers/keys", json={"ANTHROPIC_API_KEY": "sk-test-1234567890"})
    k = r.json()["keys"]["ANTHROPIC_API_KEY"]
    assert k["set"] and "1234567890" not in k["masked"]
    assert client.put("/api/providers/keys", json={"ANTHROPIC_API_KEY": "bad key with spaces"}).status_code == 400
    client.put("/api/providers/keys", json={"ANTHROPIC_API_KEY": ""})


def test_api_market_endpoints(client):
    assert client.get("/api/market/bars/AAPL?indicators=sma20,rsi").json()["candles"]
    assert client.get("/api/market/bars/bad$sym").status_code == 400
    assert client.get("/api/market/overview").status_code == 200
    assert client.get("/api/health").status_code == 200
