"""Model families. Every family exposes the same interface so baselines and
advanced models are evaluated identically.

  * ``BaseRate``   — predicts the training-set frequency / quantiles (the bar to beat).
  * ``Logistic``   — standardized L2 logistic regression / ridge regression.
  * ``GBM``        — scikit-learn HistGradientBoosting (handles NaN natively).
  * ``Forest``     — extremely randomised trees (bagged, decorrelated; robust to noise).
  * ``KNN``        — k-nearest-neighbour "pattern analog": finds the most similar past setups
                     across the universe and uses how they turned out.
  * ``Factor``     — a 4-factor statistical model (momentum, short-term reversal, relative
                     strength, trend distance): few parameters, hard to over-fit.
  * ``Ensemble``   — average of the calibrated logistic, boosting and forest probabilities.

Classifiers are calibrated (Platt scaling by default; isotonic optional) on a later, disjoint
calibration window (never the rows they were trained on).
"""
from __future__ import annotations

import numpy as np
from sklearn.compose import ColumnTransformer
from sklearn.ensemble import (ExtraTreesClassifier, ExtraTreesRegressor, HistGradientBoostingClassifier,
                              HistGradientBoostingRegressor)
from sklearn.neighbors import KNeighborsClassifier, KNeighborsRegressor
from sklearn.impute import SimpleImputer
from sklearn.isotonic import IsotonicRegression
from sklearn.linear_model import LogisticRegression, Ridge
from sklearn.pipeline import make_pipeline
from sklearn.preprocessing import StandardScaler


class BaseRateClassifier:
    name = "base_rate"

    def fit(self, X, y):
        self.p = float(np.mean(y))
        return self

    def predict_proba(self, X):
        p = np.full(len(X), self.p)
        return np.column_stack([1 - p, p])


class QuantileBaseline:
    def __init__(self, q: float | None = None):
        self.q = q

    def fit(self, X, y):
        self.v = float(np.quantile(y, self.q)) if self.q is not None else float(np.mean(y))
        return self

    def predict(self, X):
        return np.full(len(X), self.v)


METHODS = {
    "base_rate": {"name": "Base rate (baseline)", "family": "baseline",
                  "about": "Always predicts how often the outcome happened in training. Every other method must beat it."},
    "logistic": {"name": "Logistic regression", "family": "linear",
                 "about": "Weighted sum of all 29 features, regularised. Fast, stable, easy to calibrate."},
    "gbm": {"name": "Gradient boosting", "family": "trees",
            "about": "Hundreds of shallow decision trees, each correcting the last. Captures non-linear effects."},
    "forest": {"name": "Random forest (extra trees)", "family": "trees",
               "about": "Many randomised trees averaged together. Robust to noise, rarely over-confident."},
    "knn": {"name": "Pattern analog (k-nearest neighbours)", "family": "analog",
            "about": "Finds the 200 most similar past setups across all stocks and uses how they turned out."},
    "factor": {"name": "4-factor statistical model", "family": "statistical",
               "about": "Only momentum, short-term reversal, relative strength and trend distance. Few parameters, hard to over-fit."},
    "ensemble": {"name": "Ensemble (average)", "family": "ensemble",
                 "about": "Average of the logistic, boosting and forest probabilities. Usually steadier than any single model."},
}
ENSEMBLE_MEMBERS = ("logistic", "gbm", "forest")
FACTOR_FEATURES = ["r126_skip5", "r1", "rs63", "dist_sma200"]


def _factor_cols():
    return ColumnTransformer([("f", "passthrough", FACTOR_FEATURES)], remainder="drop")


class SubsampledKNN:
    """k-NN fitted on at most ``cap`` recent rows so prediction stays fast on large panels."""

    def __init__(self, regress: bool = False, k: int = 200, cap: int = 20000):
        self.regress, self.k, self.cap = regress, k, cap

    def fit(self, X, y):
        X = np.asarray(X, float)
        y = np.asarray(y, float)
        if len(X) > self.cap:
            X, y = X[-self.cap:], y[-self.cap:]
        self.med = np.nanmedian(X, axis=0)
        X = np.where(np.isnan(X), self.med, X)
        self.mu, self.sd = X.mean(0), X.std(0) + 1e-9
        Z = (X - self.mu) / self.sd
        est = KNeighborsRegressor if self.regress else KNeighborsClassifier
        self.m = est(n_neighbors=min(self.k, len(Z)), weights="distance", n_jobs=-1).fit(Z, y)
        return self

    def _z(self, X):
        X = np.asarray(X, float)
        return (np.where(np.isnan(X), self.med, X) - self.mu) / self.sd

    def predict_proba(self, X):
        p = self.m.predict_proba(self._z(X))
        return p if p.shape[1] == 2 else np.column_stack([1 - p[:, 0], p[:, 0]])

    def predict(self, X):
        return self.m.predict(self._z(X))


def make_classifier(kind: str, seed: int = 7):
    if kind == "base_rate":
        return BaseRateClassifier()
    if kind == "logistic":
        return make_pipeline(SimpleImputer(strategy="median"), StandardScaler(), LogisticRegression(C=0.05, max_iter=500))
    if kind == "gbm":
        return HistGradientBoostingClassifier(max_depth=3, learning_rate=0.05, max_iter=150, min_samples_leaf=200,
                                              l2_regularization=1.0, random_state=seed)
    if kind == "forest":
        return make_pipeline(SimpleImputer(strategy="median"),
                             ExtraTreesClassifier(n_estimators=150, max_depth=8, min_samples_leaf=150, max_features=0.5,
                                                  n_jobs=-1, random_state=seed))
    if kind == "knn":
        return SubsampledKNN()
    if kind == "factor":
        return make_pipeline(_factor_cols(), SimpleImputer(strategy="median"), StandardScaler(), LogisticRegression(C=1.0, max_iter=300))
    raise ValueError(kind)


def make_regressor(kind: str, quantile: float | None = None, seed: int = 7):
    if kind == "base_rate":
        return QuantileBaseline(quantile)
    if kind == "logistic":  # linear family for returns
        if quantile is not None:
            return QuantileBaseline(quantile)
        return make_pipeline(SimpleImputer(strategy="median"), StandardScaler(), Ridge(alpha=50.0))
    if kind == "gbm":
        if quantile is not None:
            return HistGradientBoostingRegressor(loss="quantile", quantile=quantile, max_depth=3, learning_rate=0.05,
                                                 max_iter=120, min_samples_leaf=300, random_state=seed)
        return HistGradientBoostingRegressor(max_depth=3, learning_rate=0.05, max_iter=120, min_samples_leaf=300,
                                             l2_regularization=1.0, random_state=seed)
    if quantile is not None:     # only boosting and the baseline estimate quantiles
        return QuantileBaseline(quantile)
    if kind == "forest":
        return make_pipeline(SimpleImputer(strategy="median"),
                             ExtraTreesRegressor(n_estimators=120, max_depth=8, min_samples_leaf=200, max_features=0.5,
                                                 n_jobs=-1, random_state=seed))
    if kind == "knn":
        return SubsampledKNN(regress=True)
    if kind == "factor":
        return make_pipeline(_factor_cols(), SimpleImputer(strategy="median"), StandardScaler(), Ridge(alpha=10.0))
    if kind == "ensemble":
        return EnsembleRegressor()
    raise ValueError(kind)


class EnsembleRegressor:
    def fit(self, X, y):
        self.members = [make_regressor(k).fit(X, y) for k in ENSEMBLE_MEMBERS]
        return self

    def predict(self, X):
        return np.mean([m.predict(X) for m in self.members], axis=0)


class EnsembleClassifier:
    """Averages already-calibrated member probabilities (an average of calibrated
    probabilities stays close to calibrated, and is re-calibrated in validation anyway)."""

    def __init__(self, members):
        self.members = members
        self.model = members[0].model   # used for feature importance

    def predict(self, X) -> np.ndarray:
        return np.mean([m.predict(X) for m in self.members], axis=0)

    def raw(self, X) -> np.ndarray:
        return self.predict(X)


class CalibratedClassifier:
    """Raw model + isotonic map fitted on a later window."""

    def __init__(self, model, calibrator: IsotonicRegression | None):
        self.model = model
        self.calibrator = calibrator

    def raw(self, X) -> np.ndarray:
        return self.model.predict_proba(X)[:, 1]

    def predict(self, X) -> np.ndarray:
        r = self.raw(X)
        if self.calibrator is None:
            return r
        return np.clip(self.calibrator.predict(r), 0.001, 0.999)


class PlattCalibrator:
    """Logistic map on the logit of the raw score: smooth, monotone, and hard to overfit
    (two parameters), unlike isotonic regression which produces probability plateaus."""

    def fit(self, raw, y):
        z = np.log(np.clip(raw, 1e-6, 1 - 1e-6) / (1 - np.clip(raw, 1e-6, 1 - 1e-6))).reshape(-1, 1)
        self.lr = LogisticRegression(C=1e4, max_iter=1000).fit(z, y)
        return self

    def predict(self, raw):
        z = np.log(np.clip(raw, 1e-6, 1 - 1e-6) / (1 - np.clip(raw, 1e-6, 1 - 1e-6))).reshape(-1, 1)
        return self.lr.predict_proba(z)[:, 1]


def fit_calibrated(kind: str, X_fit, y_fit, X_cal, y_cal, method: str = "platt"):
    if kind == "ensemble":
        return EnsembleClassifier([fit_calibrated(k, X_fit, y_fit, X_cal, y_cal, method) for k in ENSEMBLE_MEMBERS])
    m = make_classifier(kind).fit(X_fit, y_fit)
    cal = None
    if kind != "base_rate" and len(np.unique(y_cal)) == 2 and len(y_cal) >= 200:
        raw = m.predict_proba(X_cal)[:, 1]
        cal = (PlattCalibrator() if method == "platt" else IsotonicRegression(out_of_bounds="clip", y_min=0.0, y_max=1.0)).fit(raw, y_cal)
    return CalibratedClassifier(m, cal)
