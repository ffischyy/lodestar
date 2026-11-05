import numpy as np
import pandas as pd
import pytest

from lodestar import risk as R
from lodestar.backtest import engine as bt

from .conftest import make_bars

RISK = {"risk_per_trade_pct": 1.0, "max_position_pct": 20.0, "max_gross_exposure_pct": 100.0, "max_sector_pct": 30.0,
        "max_correlation": 0.8, "max_daily_loss_pct": 2.0, "max_drawdown_pct": 15.0}
COSTS = {"commission_per_share": 0.0, "min_commission": 0.0, "default_spread_bps": 0.0, "slippage_bps": 0.0}


def test_position_size_uses_risk_budget():
    s = R.position_size(100_000, entry=50, stop=48, risk=RISK, buying_power=100_000, costs=COSTS)
    assert s["qty"] == 400                      # 1% of 100k = 1000 / $2 risk per share
    assert s["risk_at_stop"] == pytest.approx(800)
    assert s["binding_constraint"] == "max position size"   # 500 shares by risk would exceed 20% = 400 shares


def test_position_size_respects_risk_when_binding():
    s = R.position_size(100_000, entry=50, stop=45, risk=RISK, buying_power=100_000, costs=COSTS)
    assert s["qty"] == 200 and s["binding_constraint"] == "risk budget"


def test_position_size_capped_by_buying_power():
    s = R.position_size(100_000, entry=50, stop=45, risk=RISK, buying_power=1_000, costs=COSTS)
    assert s["qty"] == 20 and s["binding_constraint"] == "buying power"


def test_costs_reduce_size():
    c = {**COSTS, "slippage_bps": 50.0}
    s = R.position_size(100_000, entry=50, stop=45, risk=RISK, buying_power=100_000, costs=c)
    assert s["qty"] < 200


def test_trade_plan_geometry():
    p = R.trade_plan("long", 100.0, 2.0, 1.5, 2.0)
    assert p.stop == pytest.approx(97.0) and p.targets[0] == pytest.approx(104.0)
    assert p.reward_risk == pytest.approx(4 / 3)
    s = R.trade_plan("short", 100.0, 2.0, 1.5, 2.0)
    assert s.stop == pytest.approx(103.0) and s.targets[0] == pytest.approx(96.0)
    with pytest.raises(ValueError):
        R.trade_plan("long", 100.0, 0.0, 1.5, 2.0)


def test_pre_trade_checks():
    pos = {"AAPL": {"qty": 100, "price": 200.0}}
    kw = dict(equity=100_000, cash=80_000, positions=pos, risk=RISK, halted_reason=None, returns=None)
    assert R.pre_trade_checks(symbol="XOM", side="buy", qty=10, price=100, is_exit=False, **kw).ok
    big = R.pre_trade_checks(symbol="XOM", side="buy", qty=1000, price=100, is_exit=False, **kw)
    assert not big.ok and any("Insufficient buying power" in v for v in big.violations)
    sector = R.pre_trade_checks(symbol="MSFT", side="buy", qty=60, price=200, is_exit=False, **kw)  # tech 20k + 12k > 30%
    assert not sector.ok and any("Technology exposure" in v for v in sector.violations)
    halted = R.pre_trade_checks(symbol="XOM", side="buy", qty=1, price=100, is_exit=False, **{**kw, "halted_reason": "x"})
    assert not halted.ok
    exit_ok = R.pre_trade_checks(symbol="AAPL", side="sell", qty=100, price=200, is_exit=True, **{**kw, "halted_reason": "x"})
    assert exit_ok.ok
    no_short = R.pre_trade_checks(symbol="XOM", side="sell", qty=5, price=100, is_exit=False, allow_short=False, **kw)
    assert not no_short.ok


# ---------------------------------------------------------------- backtest engine
def _engine_case(path_after_entry, monkeypatch, gap_bar=None, **cfgkw):
    """One symbol, a forced long signal on the last warm-up day, then a scripted path."""
    warm = 260
    path_after_entry = np.concatenate([path_after_entry, np.full(25, path_after_entry[-1])])
    closes = np.concatenate([np.full(warm, 100.0), path_after_entry])
    df = make_bars(closes, spread=0.0)
    if gap_bar is not None:   # open at that bar equals its close: an overnight gap from the prior close
        df.iloc[warm + gap_bar, df.columns.get_loc("open")] = closes[warm + gap_bar]
    df["high"] = df[["open", "close"]].max(axis=1) + 1.0   # constant ATR ≈ 1 + small
    df["low"] = df[["open", "close"]].min(axis=1) - 1.0
    spy = df.copy()
    sig = pd.DataFrame({"long": False, "short": False, "score": 1.0}, index=df.index)
    sig.iloc[warm - 1, 0] = True

    def fake_generate(*a, **k):
        return {"X": sig}
    monkeypatch.setattr(bt.STR, "generate", fake_generate)
    cfg = bt.BTConfig(strategy="momentum", start=str(df.index[warm - 5].date()), oos_fraction=0, slippage_bps=0, spread_bps=0,
                      **cfgkw)
    return bt.run(cfg, {"X": df}, spy)


def test_backtest_stop_exit(monkeypatch):
    res = _engine_case(np.array([100, 99, 97, 90, 90, 90, 90]), monkeypatch, stop_atr=1.5, target_atr=2.0)
    t = res["trades"][0]
    assert t["exit_reason"].startswith("stop") and t["pnl"] < 0


def test_backtest_target_exit(monkeypatch):
    res = _engine_case(np.array([100, 101, 103, 110, 110, 110]), monkeypatch, stop_atr=1.5, target_atr=2.0)
    t = res["trades"][0]
    assert t["exit_reason"].startswith("target") and t["pnl"] > 0


def test_backtest_gap_through_stop_fills_at_open(monkeypatch):
    res = _engine_case(np.array([100, 100, 80, 80, 80]), monkeypatch, gap_bar=2, stop_atr=1.5, target_atr=5.0)
    t = res["trades"][0]
    assert t["exit_reason"] == "stop (gap)"
    assert t["exit"] < 98  # worse than the stop price


def test_backtest_time_exit(monkeypatch):
    res = _engine_case(np.full(20, 100.0), monkeypatch, stop_atr=5, target_atr=10, max_hold_days=5)
    assert res["trades"][0]["exit_reason"] == "time exit"


def test_backtest_costs_reduce_pnl(monkeypatch):
    a = _engine_case(np.array([100, 101, 103, 110, 110]), monkeypatch)["trades"][0]
    warm = 260
    closes = np.concatenate([np.full(warm, 100.0), [100, 101, 103, 110], np.full(25, 110.0)])
    df = make_bars(closes, spread=0.0)
    df["high"] = df[["open", "close"]].max(axis=1) + 1.0
    df["low"] = df[["open", "close"]].min(axis=1) - 1.0
    sig = pd.DataFrame({"long": False, "short": False, "score": 1.0}, index=df.index)
    sig.iloc[warm - 1, 0] = True
    monkeypatch.setattr(bt.STR, "generate", lambda *x, **k: {"X": sig})
    b = bt.run(bt.BTConfig(start=str(df.index[warm - 5].date()), oos_fraction=0, slippage_bps=20, spread_bps=10,
                           commission_per_share=0.01), {"X": df}, df)["trades"][0]
    assert b["pnl"] < a["pnl"]


def test_metrics_known_series():
    idx = pd.bdate_range("2024-01-01", periods=5, tz="UTC")
    eq = pd.Series([100, 110, 99, 120, 120.0], index=idx)
    m = bt.metrics(eq, [{"pnl": 10, "r_multiple": 1.0, "bars": 2}, {"pnl": -5, "r_multiple": -0.5, "bars": 1}], 100, 0, None)
    assert m["total_return_pct"] == pytest.approx(20.0)
    assert m["max_drawdown_pct"] == pytest.approx(-10.0)
    assert m["win_rate_pct"] == 50 and m["profit_factor"] == pytest.approx(2.0) and m["expectancy"] == pytest.approx(2.5)


def test_position_size_counts_existing_holding():
    s = R.position_size(100_000, entry=50, stop=48, risk=RISK, buying_power=100_000, costs=COSTS, existing_value=15_000)
    assert s["qty"] == 100   # 20% cap = $20k, $15k already held -> $5k / $50
