import os
import tempfile
from datetime import datetime, timezone

import numpy as np
import pandas as pd
import pytest

# Isolate every test run in a throwaway data directory BEFORE lodestar is imported.
_tmp = tempfile.mkdtemp(prefix="lodestar-test-")
os.environ["LODESTAR_DATA_DIR"] = _tmp
os.environ["LODESTAR_ENV_FILE"] = os.path.join(_tmp, "test.env")
for k in ("ALPACA_API_KEY_ID", "ALPACA_API_SECRET_KEY", "ANTHROPIC_API_KEY"):
    os.environ.pop(k, None)

from lodestar.db import init_db  # noqa: E402

init_db()


def make_bars(closes, start="2024-01-01", spread=0.01, volume=1_000_000):
    closes = np.asarray(closes, float)
    idx = pd.bdate_range(start, periods=len(closes), tz="UTC")
    opens = np.concatenate([[closes[0]], closes[:-1]])
    return pd.DataFrame({"open": opens, "high": np.maximum(opens, closes) * (1 + spread),
                         "low": np.minimum(opens, closes) * (1 - spread), "close": closes,
                         "volume": np.full(len(closes), float(volume))}, index=idx)


def random_walk(n=600, seed=1, drift=0.0003, vol=0.015, start=100.0):
    rng = np.random.default_rng(seed)
    return start * np.exp(np.cumsum(rng.normal(drift, vol, n)))


@pytest.fixture
def bars():
    return make_bars(random_walk())


@pytest.fixture
def fixed_quotes(monkeypatch):
    """Replace live quotes with a controllable dict of prices (status: simulated)."""
    from lodestar.providers.base import DataStatus, Quote
    from lodestar.providers.manager import data
    prices: dict[str, float] = {}

    def fake(symbols, max_age=None):
        now = datetime.now(timezone.utc)
        return {s.upper(): Quote(symbol=s.upper(), price=prices[s.upper()], ts=now, status=DataStatus.SIMULATED,
                                 source="test", prev_close=prices[s.upper()], bid=prices[s.upper()], ask=prices[s.upper()])
                for s in symbols if s.upper() in prices}
    monkeypatch.setattr(data, "quotes", fake)
    return prices


@pytest.fixture
def clean_settings():
    from lodestar.settings_store import reset_settings, update_settings
    reset_settings()
    update_settings({"costs": {"slippage_bps": 0.0, "default_spread_bps": 0.0}})
    yield
    reset_settings()
