"""The market snapshot behind the map and screener, and the access token for a separately hosted engine."""
import pytest
from fastapi.testclient import TestClient

from lodestar import config
from lodestar.api import market
from lodestar.main import app


@pytest.fixture
def client():
    app.state.no_background = True
    with TestClient(app) as c:
        yield c


def test_snapshot_rows_have_screener_fields(client):
    market._snapshot_cache = (0.0, [], [])
    rows = client.get("/api/market/snapshot").json()
    assert len(rows) >= 30
    r = rows[0]
    for key in ("symbol", "sector", "price", "rsi14", "atr_pct", "ret_1m", "dist_sma50", "dist_52w_high", "market_cap", "next_earnings"):
        assert key in r
    assert 0 <= r["rsi14"] <= 100
    assert r["atr_pct"] > 0
    assert r["dist_52w_high"] <= 0.05  # a live price can sit just above the last completed bar's high


def test_token_guards_api_and_websocket(client, monkeypatch):
    monkeypatch.setattr(config, "API_TOKEN", "s3cret")
    assert client.get("/api/status").status_code == 401
    assert client.get("/api/status", headers={"Authorization": "Bearer wrong"}).status_code == 401
    assert client.get("/api/status", headers={"Authorization": "Bearer s3cret"}).status_code == 200
    with pytest.raises(Exception):
        with client.websocket_connect("/ws?token=wrong") as ws:
            ws.receive_text()


def test_no_token_means_open_for_local_use(client, monkeypatch):
    monkeypatch.setattr(config, "API_TOKEN", "")
    assert client.get("/api/status").status_code == 200
