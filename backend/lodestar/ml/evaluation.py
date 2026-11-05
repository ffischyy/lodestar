"""Out-of-sample evaluation metrics for probabilistic and return forecasts."""
from __future__ import annotations

import numpy as np
import pandas as pd
from sklearn.metrics import brier_score_loss, log_loss, roc_auc_score


def classification_metrics(y: np.ndarray, p: np.ndarray, base_rate) -> dict:
    """``base_rate`` may be a scalar or the baseline model's per-row out-of-sample predictions."""
    y = np.asarray(y, float)
    p = np.clip(np.asarray(p, float), 1e-6, 1 - 1e-6)
    if len(np.unique(y)) < 2:
        return {"n": int(len(y)), "error": "single class in test set"}
    brier = brier_score_loss(y, p)
    ref = np.clip(np.broadcast_to(np.asarray(base_rate, float), p.shape), 1e-6, 1 - 1e-6)
    brier_ref = brier_score_loss(y, ref)
    rel = reliability(y, p)
    return {
        "n": int(len(y)),
        "auc": float(roc_auc_score(y, p)),
        "brier": float(brier),
        "brier_baseline": float(brier_ref),
        "brier_skill": float(1 - brier / brier_ref) if brier_ref > 0 else 0.0,
        "log_loss": float(log_loss(y, p)),
        "ece": float(rel["ece"]),
        "positive_rate": float(y.mean()),
        "mean_prob": float(p.mean()),
        "reliability": rel["bins"],
    }


def reliability(y: np.ndarray, p: np.ndarray, n_bins: int = 10) -> dict:
    """Equal-count bins so every bin has data; ECE = weighted |observed - predicted|."""
    order = np.argsort(p)
    bins = np.array_split(order, n_bins)
    out, ece = [], 0.0
    for b in bins:
        if len(b) == 0:
            continue
        mp, mo = float(p[b].mean()), float(y[b].mean())
        ece += len(b) / len(p) * abs(mp - mo)
        out.append({"pred": round(mp, 4), "obs": round(mo, 4), "n": int(len(b))})
    return {"ece": ece, "bins": out}


def return_metrics(df: pd.DataFrame, pred_col: str, real_col: str = "fwd_ret") -> dict:
    """Information coefficient (mean per-date Spearman), long-short spread, hit-rate of sign."""
    d = df[["date", pred_col, real_col]].dropna()
    if d.empty:
        return {}
    ics = []
    spreads = []
    for _, g in d.groupby("date"):
        if len(g) < 8 or g[pred_col].nunique() < 2:
            continue
        ics.append(g[pred_col].rank().corr(g[real_col].rank()))
        q = g[pred_col].quantile([0.2, 0.8])
        top = g[g[pred_col] >= q.iloc[1]][real_col].mean()
        bot = g[g[pred_col] <= q.iloc[0]][real_col].mean()
        spreads.append(top - bot)
    ics = np.array([x for x in ics if np.isfinite(x)])
    return {
        "ic_mean": float(ics.mean()) if len(ics) else None,
        "ic_t_stat": float(ics.mean() / (ics.std(ddof=1) / np.sqrt(len(ics)))) if len(ics) > 2 and ics.std() > 0 else None,
        "ic_positive_share": float((ics > 0).mean()) if len(ics) else None,
        "top_minus_bottom_quintile": float(np.nanmean(spreads)) if spreads else None,
        "sign_accuracy": float((np.sign(d[pred_col]) == np.sign(d[real_col])).mean()),
        "dates": int(len(ics)),
    }


def interval_coverage(real: np.ndarray, lo: np.ndarray, hi: np.ndarray) -> float:
    m = np.isfinite(real) & np.isfinite(lo) & np.isfinite(hi)
    return float(((real[m] >= lo[m]) & (real[m] <= hi[m])).mean()) if m.any() else float("nan")


def reliability_score(m: dict) -> float:
    """Collapse validation results into 0..1 for the scanner's 'model reliability' factor.
    0 means 'no demonstrated out-of-sample skill'."""
    if not m or "brier_skill" not in m:
        return 0.0
    bss = max(0.0, min(1.0, m["brier_skill"] / 0.03))
    auc = max(0.0, min(1.0, (m["auc"] - 0.5) / 0.08))
    cal = max(0.0, min(1.0, 1 - m["ece"] / 0.05))
    if m["brier_skill"] <= 0 or m["auc"] <= 0.5:
        return round(0.15 * cal, 3)
    return round(0.5 * bss + 0.3 * auc + 0.2 * cal, 3)
