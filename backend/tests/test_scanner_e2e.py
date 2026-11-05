from datetime import datetime, timezone

import pytest

from lodestar import scanner
from lodestar.analytics import signals as S
from lodestar.providers.base import DataStatus, Quote
from lodestar.settings_store import get_settings

from .conftest import make_bars, random_walk

CTX = {"regime": {"score": 0.5, "summary": "test regime", "values": {"label": "risk_on_trend"}}, "sectors": {}}


def _fc(**kw):
    base = {"exp_return": 0.04, "p_target_first_long": 0.55, "p_target_first_short": 0.2, "p_up": 0.6, "uncertainty": 0.08,
            "reliability": 0.8, "validated": True, "exp_favorable_excursion": 0.05, "exp_adverse_excursion": -0.02,
            "q10": -0.02, "q90": 0.06, "asof": None, "model": "logistic", "horizon_days": 10}
    base.update(kw)
    return base


def _eval(df, quote, fc):
    st = get_settings()
    sigs = [S.momentum(df), S.trend(df), S.volatility(df)]
    if fc and fc["asof"] is None:
        fc["asof"] = df.index[-1].isoformat()
    return scanner.evaluate("AAPL", "long", df=df, quote=quote, fc=fc, ctx=CTX, sigs=sigs, prof=None, st=st,
                            base_rates={"target_first_long": 0.35}, positions={}, equity=100_000, cash=100_000)


def _q(df, status=DataStatus.SIMULATED):
    p = float(df["close"].iloc[-1])
    return Quote("AAPL", p, datetime.now(timezone.utc), status, "test", prev_close=p, bid=p * 0.9999, ask=p * 1.0001)


@pytest.fixture
def df():
    return make_bars(random_walk(400, seed=5, drift=0.001), volume=5_000_000)


def test_good_candidate_passes(df):
    c = _eval(df, _q(df), _fc())
    assert not c["rejected"], c["reasons"]
    assert 0 <= c["score"] <= 100 and c["sizing"]["qty"] > 0
    assert c["plan"]["stop"] < c["price"] < c["plan"]["targets"][0]


def test_stale_data_rejected(df):
    c = _eval(df, _q(df, DataStatus.STALE), _fc())
    assert c["rejected"] and any("stale" in r for r in c["reasons"])


def test_no_model_rejected(df):
    c = _eval(df, _q(df), None)
    assert c["rejected"] and any("No validated model" in r for r in c["reasons"])


def test_unvalidated_model_rejected(df):
    c = _eval(df, _q(df), _fc(validated=False, reliability=0.9))
    assert c["rejected"] and any("reliability" in r for r in c["reasons"])


def test_edge_after_costs_rejected(df):
    c = _eval(df, _q(df), _fc(exp_return=0.001))
    assert c["rejected"] and any("after costs" in r for r in c["reasons"])


def test_excess_uncertainty_rejected(df):
    c = _eval(df, _q(df), _fc(uncertainty=0.5))
    assert c["rejected"] and any("interval" in r for r in c["reasons"])


def test_illiquid_rejected():
    d = make_bars(random_walk(400, seed=5, drift=0.001), volume=1_000)
    c = _eval(d, _q(d), _fc())
    assert c["rejected"] and any("dollar volume" in r for r in c["reasons"])


@pytest.mark.slow
def test_end_to_end_training_and_scan():
    """Full pipeline on the simulated market: train -> validate -> predict -> scan -> log predictions."""
    from lodestar.db import ModelRun, Prediction, session_scope
    from lodestar.ml import engine
    rid = engine.train()
    with session_scope() as s:
        r = s.get(ModelRun, rid)
        assert r.status == "done", r.error
        m = r.metrics
        assert set(m["models"]) == {"base_rate", "logistic", "gbm", "forest", "knn", "factor", "ensemble"}
        assert m["models"]["base_rate"]["target_first"]["brier_skill"] == pytest.approx(0.0, abs=1e-9)
        assert m["oos_rows"] > 1000 and m["folds"]
    preds = engine.predictor.predict_all(max_age=0)
    assert preds and all(0 < p["p_up"] < 1 and p["q10"] <= p["q90"] for p in preds.values())
    assert all(len(p["by_method"]) == 6 for p in preds.values())       # every method forecasts every stock
    res = scanner.run_scan()
    assert len(res["candidates"]) + len(res["rejected"]) > 0
    for c in res["candidates"]:
        assert not c["reasons"]
    with session_scope() as s:
        assert s.query(Prediction).count() >= len(preds)
