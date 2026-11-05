import numpy as np
import pandas as pd
import pytest

from lodestar.analytics import indicators as ind
from lodestar.analytics import signals as S
from lodestar.analytics.sentiment import score

from .conftest import make_bars, random_walk


def test_sma_ema_known_values():
    s = pd.Series([1, 2, 3, 4, 5], dtype=float)
    assert ind.sma(s, 3).tolist()[2:] == [2.0, 3.0, 4.0]
    assert np.isnan(ind.sma(s, 3).iloc[1])
    e = ind.ema(s, 3)  # alpha = 0.5, seeded at first value
    assert e.iloc[-1] == pytest.approx(4.0625)


def test_rsi_bounds_and_extremes():
    up = pd.Series(np.arange(1, 40, dtype=float))
    assert ind.rsi(up, 14).iloc[-1] == pytest.approx(100.0)
    down = pd.Series(np.arange(40, 1, -1, dtype=float))
    assert ind.rsi(down, 14).iloc[-1] == pytest.approx(0.0, abs=1e-9)
    r = ind.rsi(pd.Series(random_walk(300)), 14).dropna()
    assert ((r >= 0) & (r <= 100)).all()


def test_atr_constant_range():
    df = make_bars(np.full(50, 100.0), spread=0.01)  # high-low = 2.0 every bar
    assert ind.atr(df, 14).iloc[-1] == pytest.approx(2.0, rel=1e-6)


@pytest.mark.parametrize("fn", [lambda d: ind.rsi(d["close"]), lambda d: ind.atr(d), lambda d: ind.adx(d)["adx"],
                                lambda d: ind.bollinger(d["close"])["pct_b"], lambda d: ind.donchian(d)["upper"],
                                lambda d: ind.macd(d["close"])["hist"], lambda d: ind.realized_vol(d["close"])])
def test_indicators_are_causal(bars, fn):
    """Value at t must not change when bars after t are altered."""
    full = fn(bars)
    t = 400
    altered = bars.copy()
    altered.iloc[t + 1:, :4] *= 1.5
    assert np.allclose(full.iloc[:t + 1].to_numpy(), fn(altered).iloc[:t + 1].to_numpy(), equal_nan=True)


def test_donchian_excludes_current_bar():
    df = make_bars([10, 11, 12, 13, 50], spread=0)
    d = ind.donchian(df, 3)
    assert d["upper"].iloc[-1] == 13.0  # breakout bar not in its own channel


def test_signal_scores_bounded_and_directional():
    up = make_bars(100 * np.exp(np.linspace(0, 0.6, 300)))
    m = S.momentum(up)
    t = S.trend(up)
    assert -1 <= m.score <= 1 and m.direction == "bullish"
    assert t.direction == "bullish"
    down = make_bars(100 * np.exp(np.linspace(0, -0.6, 300)))
    assert S.momentum(down).direction == "bearish"


def test_insufficient_history_flagged():
    r = S.trend(make_bars(random_walk(50)))
    assert "insufficient_data" in r.flags and r.score == 0


def test_breakout_detects_close_above_channel():
    c = np.concatenate([np.full(80, 100.0), [110.0]])
    df = make_bars(c, spread=0.001)
    df.iloc[-1, df.columns.get_loc("volume")] = 3_000_000
    r = S.breakout(df)
    assert r.direction == "bullish" and r.values["volume_ratio"] > 2


def test_sentiment_lexicon_and_negation():
    pos, _ = score("Company beats estimates and raises guidance")
    neg, _ = score("Company misses estimates, cuts guidance")
    negated, terms = score("Company did not beat estimates")
    assert pos > 0 > neg
    assert negated < 0 and any(t.startswith("¬") for t in terms)
    assert score("Company schedules meeting")[0] == 0
