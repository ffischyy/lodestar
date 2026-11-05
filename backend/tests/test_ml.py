import numpy as np
import pandas as pd
import pytest

from lodestar.ml import evaluation as ev
from lodestar.ml.engine import walk_forward_splits
from lodestar.ml.features import FEATURES, build_panel, labels, symbol_features
from lodestar.ml.models import fit_calibrated

from .conftest import make_bars, random_walk


def test_features_do_not_use_future_data():
    spy = make_bars(random_walk(600, seed=9))
    df = make_bars(random_walk(600, seed=3))
    f1 = symbol_features(df, spy)
    t = 450
    df2, spy2 = df.copy(), spy.copy()
    df2.iloc[t + 1:, :4] *= 0.5
    spy2.iloc[t + 1:, :4] *= 2.0
    f2 = symbol_features(df2, spy2)
    cols = [c for c in f1.columns if not c.startswith("_")]
    assert np.allclose(f1[cols].iloc[:t + 1].to_numpy(), f2[cols].iloc[:t + 1].to_numpy(), equal_nan=True)


def test_labels_are_nan_for_last_horizon_rows():
    df = make_bars(random_walk(100))
    lab = labels(df, 10, 2.0, 1.5)
    assert lab["fwd_ret"].iloc[-10:].isna().all()
    assert lab["fwd_ret"].iloc[20:-10].notna().all()


def test_triple_barrier_target_first_and_stop_precedence():
    closes = np.full(40, 100.0)
    df = make_bars(closes, spread=0.0)
    df["high"] = df["low"] = 100.0
    # ATR will be ~0 with a flat path; inject a known ATR via ranges in the warm-up then flat
    df.iloc[:30, df.columns.get_loc("high")] = 101.0
    df.iloc[:30, df.columns.get_loc("low")] = 99.0
    t = 30
    df.iloc[t + 2, df.columns.get_loc("high")] = 200.0   # target hit on day 2
    lab = labels(df, 5, 2.0, 1.5)
    assert lab["y_tb_long"].iloc[t] == 1.0
    df.iloc[t + 2, df.columns.get_loc("low")] = 1.0       # same bar also hits stop -> stop wins
    lab = labels(df, 5, 2.0, 1.5)
    assert lab["y_tb_long"].iloc[t] == 0.0


def test_walk_forward_windows_are_ordered_and_purged():
    dates = np.arange(1500)
    h = 10
    splits = list(walk_forward_splits(dates, h))
    assert splits
    for fit, cal, test in splits:
        assert fit.max() + h <= cal.min()          # label of last fit row ends before calibration starts
        assert cal.max() + h <= test.min()         # same for calibration -> test
        assert len(set(fit) & set(test)) == 0
    tests = np.concatenate([t for _, _, t in splits])
    assert len(tests) == len(set(tests))           # each test date used once


def test_metrics_perfect_and_baseline():
    y = np.array([0, 1] * 500, float)
    m = ev.classification_metrics(y, y * 0.98 + 0.01, 0.5)
    assert m["auc"] == pytest.approx(1.0) and m["brier_skill"] > 0.9
    base = ev.classification_metrics(y, np.full_like(y, 0.5), 0.5)
    assert base["brier_skill"] == pytest.approx(0.0)
    assert ev.reliability_score(base) < 0.2


def test_calibration_improves_overconfident_model():
    rng = np.random.default_rng(0)
    n = 24000
    X = pd.DataFrame({"a": rng.normal(size=n)})
    p_true = 1 / (1 + np.exp(-0.4 * X["a"]))
    y = (rng.random(n) < p_true.to_numpy()).astype(float)
    cal = fit_calibrated("logistic", X[:8000], y[:8000], X[8000:14000], y[8000:14000])
    p = cal.predict(X[14000:])
    r = ev.reliability(y[14000:], p)
    assert r["ece"] < 0.05


def test_panel_cross_sectional_features():
    spy = make_bars(random_walk(400, seed=1))
    bars = {f"S{i}": make_bars(random_walk(400, seed=i + 10)) for i in range(5)}
    p = build_panel(bars, spy, 10, 2.0, 1.5)
    assert set(FEATURES) <= set(p.columns)
    g = p.dropna(subset=["xs_rank_r21"]).groupby("date")["xs_rank_r21"]
    assert (g.max() <= 1.0).all() and (g.min() > 0).all()
