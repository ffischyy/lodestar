from datetime import datetime, timezone

import numpy as np
import pytest

from lodestar.paper import engine as paper
from lodestar.settings_store import update_settings


@pytest.fixture
def acct(clean_settings, fixed_quotes):
    paper.reset(100_000)
    update_settings({"paper": {"trading_enabled": True, "sandbox": True}})
    fixed_quotes.update({"AAPL": 100.0, "MSFT": 200.0, "JPM": 100.0, "XOM": 50.0})
    return fixed_quotes


# ---------------------------------------------------------------- money, deposits, sandbox
def test_sandbox_deposit_any_amount(acct):
    s = paper.deposit(250_000)
    assert s["cash"] == pytest.approx(350_000)
    m = s["money"]
    assert m["deposits"] == 250_000 and m["net_deposits"] == pytest.approx(350_000)
    assert s["total_pnl"] == pytest.approx(0.0)           # a deposit is not profit
    assert s["day_pnl"] == pytest.approx(0.0) and s["drawdown_pct"] == pytest.approx(0.0)


def test_deposit_refused_outside_sandbox(acct):
    paper.set_sandbox(False)
    with pytest.raises(paper.OrderError) as e:
        paper.deposit(1000)
    assert "Sandbox" in str(e.value)


def test_cannot_buy_more_than_cash_outside_sandbox(acct):
    paper.set_sandbox(False)
    update_settings({"risk": {"max_position_pct": 100.0, "max_sector_pct": 100.0}})
    with pytest.raises(paper.OrderError):
        paper.submit("MSFT", "buy", 600)                  # $120k > $100k cash


def test_withdraw_limited_to_available_cash(acct):
    update_settings({"risk": {"max_position_pct": 100.0, "max_sector_pct": 100.0}})
    paper.submit("AAPL", "buy", 900)                      # $90k invested
    with pytest.raises(paper.OrderError):
        paper.withdraw(20_000)
    s = paper.withdraw(5_000)
    assert s["cash"] == pytest.approx(5_000) and s["money"]["withdrawals"] == 5_000


def test_open_limit_orders_reserve_cash(acct):
    update_settings({"risk": {"max_position_pct": 100.0, "max_sector_pct": 100.0, "max_gross_exposure_pct": 400.0}})
    paper.submit("AAPL", "buy", 800, order_type="limit", limit_price=99)   # reserves $79.2k
    s = paper.snapshot()
    assert s["money"]["reserved_for_orders"] == pytest.approx(79_200)
    with pytest.raises(paper.OrderError):
        paper.submit("MSFT", "buy", 150)                   # $30k > $20.8k still free


def test_money_summary_after_round_trip(acct):
    paper.submit("AAPL", "buy", 100)
    acct["AAPL"] = 110.0
    paper.submit("AAPL", "sell", 100)
    m = paper.snapshot()["money"]
    assert m["total_bought"] == pytest.approx(10_000) and m["total_sold"] == pytest.approx(11_000)
    assert m["profit"] == pytest.approx(1_000) and m["win_rate_pct"] == 100 and m["closed_trades"] == 1


def test_reset_clears_deposits(acct):
    paper.deposit(5_000)
    s = paper.reset(50_000)
    assert s["money"]["deposits"] == 0 and s["cash"] == pytest.approx(50_000)


# ---------------------------------------------------------------- autopilot
def _candidate(sym, score=80.0, price=100.0, qty=50, direction="long"):
    return {"symbol": sym, "direction": direction, "score": score, "price": price, "rejected": False, "strategy": "Trend following",
            "net_exp_return": 0.02, "horizon_days": 10, "p_target_first": 0.45, "base_target_first": 0.33,
            "sizing": {"qty": qty}, "plan": {"stop": price * 0.95, "targets": [price * 1.08]}}


@pytest.fixture
def ap(acct, monkeypatch):
    from lodestar import autopilot, scanner
    from lodestar.ml.engine import predictor
    monkeypatch.setattr(predictor, "info", lambda: {"passed": True, "run_id": 1})
    monkeypatch.setattr(predictor, "predict_all", lambda max_age=120: {})
    cands = [_candidate("AAPL", 90), _candidate("MSFT", 70, price=200.0, qty=20), _candidate("JPM", 40)]
    monkeypatch.setattr(scanner, "last_result", lambda: {"candidates": cands})
    update_settings({"autopilot": {"enabled": True, "mode": "auto", "schedule": "always", "min_score": 60, "max_trades_per_day": 10,
                                   "max_open_positions": 5, "max_position_pct": 10, "max_capital_pct": 50},
                     "risk": {"max_sector_pct": 100.0}})
    return autopilot


def test_autopilot_buys_qualified_ideas_with_brackets(ap):
    res = ap.run_cycle()
    done = [a for a in res["actions"] if a["status"] == "done"]
    assert {a["symbol"] for a in done} == {"AAPL", "MSFT"}          # JPM below min score
    snap = paper.snapshot()
    assert {p["symbol"] for p in snap["positions"]} == {"AAPL", "MSFT"}
    assert sum(1 for o in snap["orders"] if o["parent_id"]) == 4      # stop + target for each
    assert sum(v for k, v in res["skipped"].items() if k.startswith("score below")) == 1   # balanced caps the minimum at 45
    assert {p["symbol"] for p in ap.owned_positions(snap)} == {"AAPL", "MSFT"}


def test_autopilot_respects_position_cap(ap):
    ap.run_cycle()
    for p in paper.snapshot()["positions"]:
        assert abs(p["market_value"]) <= 10_000 + 1e-6               # 10% of $100k


def test_autopilot_off_does_nothing(ap):
    update_settings({"autopilot": {"enabled": False}})
    assert ap.run_cycle()["actions"] == []
    assert not paper.snapshot()["positions"]


def test_autopilot_daily_trade_limit(ap):
    update_settings({"autopilot": {"max_trades_per_day": 1}})
    res = ap.run_cycle()
    assert len([a for a in res["actions"] if a["status"] == "done"]) == 1
    assert ap.run_cycle()["skipped"].get("daily trade limit reached", 0) >= 1


def test_autopilot_approval_mode(ap):
    update_settings({"autopilot": {"mode": "approve"}})
    res = ap.run_cycle()
    pend = [a for a in res["actions"] if a["status"] == "pending"]
    assert len(pend) == 2 and not paper.snapshot()["positions"]
    ap.decide(pend[0]["id"], True)
    ap.decide(pend[1]["id"], False)
    assert len(paper.snapshot()["positions"]) == 1
    with pytest.raises(ValueError):
        ap.decide(pend[0]["id"], True)                                # can't approve twice


def test_autopilot_needs_validated_model(ap, monkeypatch):
    from lodestar.ml.engine import predictor
    monkeypatch.setattr(predictor, "info", lambda: {"passed": False})
    res = ap.run_cycle()
    assert not [a for a in res["actions"] if a["status"] == "done"]
    assert "model failed validation" in res["skipped"]


def test_kill_switch_turns_autopilot_off(ap):
    from lodestar.settings_store import get_settings
    paper.kill_switch()
    assert get_settings()["autopilot"]["enabled"] is False


def test_schedule_custom_window():
    from lodestar.autopilot import schedule_allows
    cfg = {"schedule": "custom", "custom_start": "10:00", "custom_end": "11:00", "days": [1]}
    tue_1030_et = datetime(2026, 10, 27, 14, 30, tzinfo=timezone.utc)
    tue_1200_et = datetime(2026, 10, 27, 16, 0, tzinfo=timezone.utc)
    assert schedule_allows(cfg, tue_1030_et)[0] and not schedule_allows(cfg, tue_1200_et)[0]
    assert not schedule_allows({**cfg, "days": [0]}, tue_1030_et)[0]


# ---------------------------------------------------------------- turbo simulator
def test_turbo_throughput_and_honesty():
    from lodestar.turbo import TurboConfig, run
    r = run(TurboConfig(strategy="momentum", markets=3, symbols=100, years=4, pattern_strength="none", seed=3))
    assert r["trades"] > 1000
    assert r["trades_per_minute_engine"] > 1000 and r["trades_per_minute_total"] > 1000
    rnd = run(TurboConfig(strategy="random", markets=3, symbols=100, years=4, pattern_strength="none", seed=3))
    assert rnd["avg_r"] < 0                                          # costs make random trading lose


def test_turbo_first_touch_stop_and_gap():
    from lodestar.turbo import TurboConfig, first_touch
    D, S = 30, 1
    c = np.full((D, S), 100.0)
    m = {"open": c.copy(), "high": c + 0.5, "low": c - 0.5, "close": c.copy()}
    m["open"][6] = m["close"][6] = m["high"][6] = m["low"][6] = 90.0       # gap down on day 6
    cfg = TurboConfig(horizon_days=10, stop_atr=1.0, target_atr=2.0, slippage_bps=0, spread_bps=0)
    ex = first_touch(m, np.array([3]), np.array([0]), np.array([1.0]), np.array([2.0]), cfg)
    assert ex["reason"][0] == 0 and ex["exit_day"][0] == 6
    assert ex["ret"][0] == pytest.approx(-0.10)                          # filled at the gap open, not the stop


def test_turbo_ai_signals_are_out_of_sample():
    """Altering prices after day t must not change AI scores up to t (walk-forward, purged)."""
    from lodestar.turbo import TurboConfig, _ai_scores, features, synthetic_market
    cfg = TurboConfig(horizon_days=5)
    m = synthetic_market(60, 700, seed=11, strength="weak")
    a, _ = _ai_scores(features(m), m, cfg, start=300)
    m2 = {k: v.copy() for k, v in m.items()}
    for k in m2:
        m2[k][500:] *= 1.3
    b, _ = _ai_scores(features(m2), m2, cfg, start=300)
    assert np.allclose(np.nan_to_num(a[:480]), np.nan_to_num(b[:480]))


# ---------------------------------------------------------------- prediction methods
def test_all_methods_fit_and_predict():
    import pandas as pd
    from lodestar.ml.features import FEATURES
    from lodestar.ml.models import METHODS, fit_calibrated, make_regressor
    rng = np.random.default_rng(0)
    X = pd.DataFrame(rng.normal(size=(3000, len(FEATURES))), columns=FEATURES)
    y = (rng.random(3000) < 1 / (1 + np.exp(-X["rs63"]))).astype(float)
    for k in METHODS:
        p = fit_calibrated(k, X[:2000], y[:2000], X[2000:2500], y[2000:2500]).predict(X[2500:])
        assert ((p > 0) & (p < 1)).all(), k
        assert make_regressor(k).fit(X[:2000], y[:2000]).predict(X[2500:]).shape == (500,)


def test_methods_settings_validation():
    from lodestar.settings_store import reset_settings
    with pytest.raises(ValueError):
        update_settings({"model": {"methods": ["ensemble", "logistic"]}})     # ensemble needs its members
    with pytest.raises(ValueError):
        update_settings({"model": {"methods": ["magic"]}})
    update_settings({"model": {"methods": ["logistic", "factor"], "selection": "factor"}})
    reset_settings()
