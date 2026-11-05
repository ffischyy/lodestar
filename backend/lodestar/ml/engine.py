"""Training (purged walk-forward), model selection and live inference."""
from __future__ import annotations

import logging
import math
import threading
import time
import traceback
from datetime import datetime, timezone
from pathlib import Path

import joblib
import numpy as np
import pandas as pd
from sklearn.inspection import permutation_importance
from sqlalchemy import select, update

from .. import config, market_hours
from .. import universe as U
from ..db import ModelRun, session_scope
from ..providers.manager import data
from ..settings_store import get_settings
from . import evaluation as ev
from .features import FEATURES, build_panel
from .models import METHODS, fit_calibrated, make_regressor

log = logging.getLogger("lodestar.ml")
_train_lock = threading.Lock()


# ----------------------------------------------------------------- data loading
def completed_bars(df: pd.DataFrame) -> pd.DataFrame:
    """Drop the in-progress session bar so features never mix partial and full days."""
    if df.empty:
        return df
    from .. import market_hours
    if data.is_simulated():
        return df.iloc[:-1] if not data.sim._fixed_end else df
    from .. import clock
    today_et = clock.now().astimezone(market_hours.ET).date()
    if df.index[-1].date() == today_et and market_hours.session() in ("pre", "regular"):
        return df.iloc[:-1]
    return df


def load_universe_bars(symbols: list[str], progress=None) -> tuple[dict[str, pd.DataFrame], pd.DataFrame, list[str]]:
    bars, problems = {}, []
    spy, _ = data.bars(U.BENCHMARK, "1D")
    spy = completed_bars(spy)
    for i, s in enumerate(symbols):
        try:
            df, meta = data.bars(s, "1D")
            bars[s] = completed_bars(df)
        except Exception as e:  # keep going; report
            problems.append(f"{s}: {e}")
        if progress:
            progress(i + 1, len(symbols))
    return bars, spy, problems


# ----------------------------------------------------------------- walk-forward
def walk_forward_splits(dates: np.ndarray, horizon: int, min_fit: int = 504, cal: int = 126, test: int = 63):
    """Yield (fit_dates, cal_dates, test_dates). Gaps of ``horizon`` days separate the
    windows so no label in an earlier window overlaps a later window (purging)."""
    n = len(dates)
    i = min_fit + horizon + cal + horizon
    while i < n:
        fit_end = i - horizon - cal - horizon
        cal_start, cal_end = fit_end + horizon, i - horizon
        yield dates[:fit_end], dates[cal_start:cal_end], dates[i:min(n, i + test)]
        i += test


def _z(df: pd.DataFrame, col: str, horizon: int) -> np.ndarray:
    scale = (df["vol20"].clip(lower=0.05) * math.sqrt(horizon / 252)).to_numpy()
    return df[col].to_numpy() / scale


def train(run_id: int | None = None) -> int:
    """Run the full training job synchronously. Returns ModelRun id."""
    if not _train_lock.acquire(blocking=False):
        raise RuntimeError("A training job is already running")
    try:
        return _train(run_id)
    finally:
        _train_lock.release()


def _set(run_id: int, **kw):
    with session_scope() as s:
        s.execute(update(ModelRun).where(ModelRun.id == run_id).values(**kw))


def _train(run_id: int | None) -> int:
    st = get_settings()
    mc = st["model"]
    h, kt, ks = int(mc["horizon_days"]), float(mc["barrier_target_atr"]), float(mc["barrier_stop_atr"])
    src = data.provider().name
    symbols = U.universe(st)
    cfg = {"horizon_days": h, "barrier_target_atr": kt, "barrier_stop_atr": ks, "symbols": symbols, "features": FEATURES}
    if run_id is None:
        with session_scope() as s:
            r = ModelRun(source=src, config=cfg, status="running", message="Loading market data")
            s.add(r)
            s.flush()
            run_id = r.id
    else:
        _set(run_id, config=cfg, source=src)
    t0 = time.time()
    try:
        bars, spy, problems = load_universe_bars(symbols, lambda i, n: _set(run_id, progress=0.25 * i / n, message=f"Loading data {i}/{n}"))
        _set(run_id, progress=0.27, message="Building features and labels")
        panel = build_panel(bars, spy, h, kt, ks)
        if panel.empty:
            raise RuntimeError("No symbols with enough history (need >= 260 daily bars)")
        lab = panel.dropna(subset=["y_tb_long", "fwd_ret", "vol20"]).reset_index(drop=True)
        if len(lab) < int(mc.get("min_train_rows", 3000)):
            raise RuntimeError(f"Only {len(lab)} labelled rows; need {mc.get('min_train_rows', 3000)}")
        lab["z"] = _z(lab, "fwd_ret", h)
        lab["z_mfe"] = _z(lab, "mfe", h)
        lab["z_mae"] = _z(lab, "mae", h)
        dates = np.array(sorted(lab["date"].unique()))
        splits = list(walk_forward_splits(dates, h))
        if not splits:
            raise RuntimeError("Not enough history for walk-forward validation (need ~3 years)")
        chosen = [k for k in mc.get("methods", list(METHODS)) if k in METHODS and k != "base_rate"] or ["logistic"]
        kinds = ["base_rate"] + chosen
        cfg["methods"] = kinds
        oos = []
        fold_info = []
        for fi, (fd, cd, td) in enumerate(splits):
            _set(run_id, progress=0.3 + 0.5 * fi / len(splits), message=f"Walk-forward fold {fi + 1}/{len(splits)}")
            F, C, T = lab[lab.date.isin(fd)], lab[lab.date.isin(cd)], lab[lab.date.isin(td)]
            if len(T) == 0 or len(F) < 500:
                continue
            out = T[["date", "symbol", "fwd_ret", "y_up", "y_tb_long", "y_tb_short", "z"]].copy()
            out["fold"] = fi + 1
            XF, XC, XT = F[FEATURES], C[FEATURES], T[FEATURES]
            members = {}
            for k in kinds:
                if k == "ensemble" and all(m in members for m in ("logistic", "gbm", "forest")):
                    # reuse the member fits instead of training them twice
                    out["tb_ensemble"] = out[["tb_logistic", "tb_gbm", "tb_forest"]].mean(axis=1)
                    out["up_ensemble"] = out[["up_logistic", "up_gbm", "up_forest"]].mean(axis=1)
                    out["ret_ensemble"] = out[["ret_logistic", "ret_gbm", "ret_forest"]].mean(axis=1)
                    continue
                out[f"tb_{k}"] = fit_calibrated(k, XF, F.y_tb_long, XC, C.y_tb_long).predict(XT)
                out[f"up_{k}"] = fit_calibrated(k, XF, F.y_up, XC, C.y_up).predict(XT)
                out[f"ret_{k}"] = make_regressor(k).fit(XF, F.z).predict(XT)
                members[k] = True
            out["q10_gbm"] = make_regressor("gbm", 0.1).fit(XF, F.z).predict(XT)
            out["q90_gbm"] = make_regressor("gbm", 0.9).fit(XF, F.z).predict(XT)
            fold_info.append({"fold": fi + 1, "train_end": str(pd.Timestamp(fd[-1]).date()), "test_start": str(pd.Timestamp(td[0]).date()),
                              "test_end": str(pd.Timestamp(td[-1]).date()), "train_rows": int(len(F)), "test_rows": int(len(T))})
            oos.append(out)
        O = pd.concat(oos, ignore_index=True)
        _set(run_id, progress=0.82, message="Scoring out-of-sample predictions")
        metrics = {"folds": fold_info, "models": {}, "oos_rows": int(len(O)), "oos_start": str(pd.Timestamp(O.date.min()).date()),
                   "oos_end": str(pd.Timestamp(O.date.max()).date()), "data_problems": problems}
        for k in kinds:
            m = {
                "target_first": ev.classification_metrics(O.y_tb_long, O[f"tb_{k}"], O["tb_base_rate"]),
                "positive_return": ev.classification_metrics(O.y_up, O[f"up_{k}"], O["up_base_rate"]),
                "expected_return": ev.return_metrics(O, f"ret_{k}", "z"),
            }
            # per-fold stability of the barrier model
            per = []
            for fi_, g in O.groupby("fold"):
                cm = ev.classification_metrics(g.y_tb_long, g[f"tb_{k}"], g["tb_base_rate"])
                if "auc" in cm:
                    per.append({"fold": int(fi_), "test_start": str(pd.Timestamp(g.date.min()).date()), "auc": round(cm["auc"], 4), "brier_skill": round(cm["brier_skill"], 4)})
            m["per_fold"] = per
            metrics["models"][k] = m
        cov = ev.interval_coverage(O.z.to_numpy(), O.q10_gbm.to_numpy(), O.q90_gbm.to_numpy())
        metrics["interval_80_coverage"] = cov

        cands = {k: metrics["models"][k]["target_first"].get("brier_skill", -1) for k in chosen}
        forced = mc.get("selection", "auto")
        champion = forced if forced in chosen else max(cands, key=cands.get)
        cm = metrics["models"][champion]["target_first"]
        gates = {
            "brier_skill_gt_0": cm.get("brier_skill", -1) > 0,
            "auc_gt_0.52": cm.get("auc", 0) > 0.52,
            "ece_lt_0.05": cm.get("ece", 1) < 0.05,
            "oos_rows_ge_1000": cm.get("n", 0) >= 1000,
        }
        passed = all(gates.values())
        reliability = ev.reliability_score(cm) if passed else min(0.2, ev.reliability_score(cm))
        ret_k = max(chosen, key=lambda k: metrics["models"][k]["expected_return"].get("ic_mean") or -1)
        metrics.update({"champion": champion, "return_model": ret_k, "selection": forced, "methods": kinds,
                        "method_info": {k: METHODS[k] for k in kinds}, "gates": gates, "passed": passed, "reliability": reliability,
                        "baseline_comparison": {k: {"brier_skill": metrics["models"][k]["target_first"].get("brier_skill"),
                                                    "auc": metrics["models"][k]["target_first"].get("auc"),
                                                    "ic": metrics["models"][k]["expected_return"].get("ic_mean")} for k in kinds}})

        # ---- final fit on all labelled data
        _set(run_id, progress=0.86, message="Fitting final models on full history")
        cal_n = 126
        fd, cd = dates[:-(cal_n + h)], dates[-cal_n:]
        F, C = lab[lab.date.isin(fd)], lab[lab.date.isin(cd)]
        XF, XC = F[FEATURES], C[FEATURES]
        art = {
            "tb_long": fit_calibrated(champion, XF, F.y_tb_long, XC, C.y_tb_long),
            "tb_short": fit_calibrated(champion, XF, F.y_tb_short, XC, C.y_tb_short),
            "up": fit_calibrated(champion, XF, F.y_up, XC, C.y_up),
            "ret": make_regressor(ret_k).fit(lab[FEATURES], lab.z),
            "q10": make_regressor("gbm", 0.1).fit(lab[FEATURES], lab.z),
            "q90": make_regressor("gbm", 0.9).fit(lab[FEATURES], lab.z),
            "mfe": make_regressor("gbm").fit(lab[FEATURES], lab.z_mfe),
            "mae": make_regressor("gbm").fit(lab[FEATURES], lab.z_mae),
        }
        _set(run_id, progress=0.9, message="Fitting every method for side-by-side forecasts")
        by_method = {}
        for k in chosen:
            if k == champion:
                by_method[k] = {"tb_long": art["tb_long"], "tb_short": art["tb_short"], "up": art["up"]}
            elif k == "ensemble" and all(m in by_method for m in ("logistic", "gbm", "forest")):
                from .models import EnsembleClassifier
                by_method[k] = {t: EnsembleClassifier([by_method[m][t] for m in ("logistic", "gbm", "forest")]) for t in ("tb_long", "tb_short", "up")}
            else:
                by_method[k] = {"tb_long": fit_calibrated(k, XF, F.y_tb_long, XC, C.y_tb_long),
                                "tb_short": fit_calibrated(k, XF, F.y_tb_short, XC, C.y_tb_short),
                                "up": fit_calibrated(k, XF, F.y_up, XC, C.y_up)}
        art["by_method"] = by_method
        _set(run_id, progress=0.95, message="Computing feature importance")
        last = lab[lab.date.isin(splits[-1][2])]
        sample = last.sample(min(4000, len(last)), random_state=1) if len(last) else lab.tail(4000)
        try:
            pi = permutation_importance(art["tb_long"].model, sample[FEATURES], sample.y_tb_long, scoring="neg_brier_score",
                                        n_repeats=3, random_state=1)
            imp = sorted(({"feature": f, "importance": float(v)} for f, v in zip(FEATURES, pi.importances_mean)),
                         key=lambda x: -x["importance"])
        except Exception:
            imp = []
        metrics["feature_importance"] = imp
        # empirical, per-symbol history used by the explainer ("relevant historical performance")
        metrics["label_base_rates"] = {"target_first_long": float(lab.y_tb_long.mean()), "target_first_short": float(lab.y_tb_short.mean()),
                                       "positive_return": float(lab.y_up.mean())}
        metrics["train_rows"] = int(len(lab))
        metrics["trained_through"] = str(pd.Timestamp(dates[-1]).date())
        metrics["duration_s"] = round(time.time() - t0, 1)
        from ..db import replay_db_active
        path = config.MODELS_DIR / f"{'replay_' if replay_db_active() else ''}model_{run_id}.joblib"
        joblib.dump({"models": art, "features": FEATURES, "config": cfg, "champion": champion, "return_model": ret_k,
                     "reliability": reliability, "passed": passed, "source": src, "run_id": run_id,
                     "trained_through": metrics["trained_through"]}, path)
        with session_scope() as s:
            s.execute(update(ModelRun).values(is_active=False))
            s.execute(update(ModelRun).where(ModelRun.id == run_id).values(
                status="done", finished_at=datetime.now(timezone.utc), metrics=_jsonable(metrics), champion=champion,
                passed_validation=passed, is_active=True, artifact_path=str(path), progress=1.0,
                message=f"Done in {metrics['duration_s']}s — champion {champion}, {'PASSED' if passed else 'FAILED'} validation gates"))
        predictor.reload()
        log.info("model run %s done: champion=%s passed=%s", run_id, champion, passed)
        return run_id
    except Exception as e:
        log.error("training failed: %s", traceback.format_exc())
        _set(run_id, status="failed", error=str(e), finished_at=datetime.now(timezone.utc), message=f"Failed: {e}")
        return run_id


def _jsonable(o):
    if isinstance(o, dict):
        return {str(k): _jsonable(v) for k, v in o.items()}
    if isinstance(o, (list, tuple)):
        return [_jsonable(v) for v in o]
    if isinstance(o, (np.floating, float)):
        return None if not math.isfinite(float(o)) else round(float(o), 6)
    if isinstance(o, (np.integer,)):
        return int(o)
    if isinstance(o, (np.bool_,)):
        return bool(o)
    return o


def start_training_async() -> int:
    if _train_lock.locked():
        raise RuntimeError("A training job is already running")
    st = get_settings()
    with session_scope() as s:
        r = ModelRun(source=data.provider().name, config={"horizon_days": st["model"]["horizon_days"]}, status="running",
                     message="Queued")
        s.add(r)
        s.flush()
        rid = r.id
    threading.Thread(target=lambda: train(rid), daemon=True, name=f"train-{rid}").start()
    return rid


def is_training() -> bool:
    return _train_lock.locked()


# ----------------------------------------------------------------- inference
class Predictor:
    def __init__(self):
        self.art = None
        self._lock = threading.Lock()
        self._cache: tuple[float, dict] | None = None

    def reload(self):
        with self._lock:
            self.art = None
            self._cache = None
            src = data.provider().name
            with session_scope() as s:
                # a model is only valid for the data source it was trained on
                r = s.execute(select(ModelRun).where(ModelRun.is_active.is_(True), ModelRun.source == src)
                              .order_by(ModelRun.id.desc())).scalars().first()
                if r is None:
                    r = s.execute(select(ModelRun).where(ModelRun.status == "done", ModelRun.source == src)
                                  .order_by(ModelRun.id.desc())).scalars().first()
                    if r is not None:
                        s.execute(update(ModelRun).values(is_active=False))
                        r.is_active = True
                if r and r.artifact_path and Path(r.artifact_path).exists():
                    try:
                        self.art = joblib.load(r.artifact_path)
                    except Exception as e:  # incompatible pickle after an upgrade, etc.
                        log.error("could not load model %s: %s", r.artifact_path, e)

    def info(self) -> dict | None:
        if not self.art or self.art.get("source") != data.provider().name:
            return None
        a = self.art
        return {"run_id": a["run_id"], "champion": a["champion"], "passed": a["passed"], "reliability": a["reliability"],
                "source": a["source"], "trained_through": a["trained_through"], "horizon_days": a["config"]["horizon_days"],
                "barrier_target_atr": a["config"]["barrier_target_atr"], "barrier_stop_atr": a["config"]["barrier_stop_atr"]}

    def predict_all(self, max_age: float = 120) -> dict[str, dict]:
        """Forecast for every universe symbol from the last *completed* daily bar."""
        from .. import clock
        day = clock.now().astimezone(market_hours.ET).date()
        if self._cache and time.time() - self._cache[0] < max_age and (len(self._cache) < 3 or self._cache[2] == day):
            return self._cache[1]
        if not self.art or self.art.get("source") != data.provider().name:
            self.reload()
        if not self.art or self.art.get("source") != data.provider().name:
            return {}
        a = self.art
        cfg = a["config"]
        st = get_settings()
        symbols = U.universe(st)
        bars, spy, _ = load_universe_bars(symbols)
        panel = build_panel(bars, spy, cfg["horizon_days"], cfg["barrier_target_atr"], cfg["barrier_stop_atr"], with_labels=False)
        if panel.empty:
            return {}
        latest = panel.sort_values("date").groupby("symbol").tail(1).set_index("symbol")
        X = latest[a["features"]]
        m = a["models"]
        h = cfg["horizon_days"]
        scale = (latest["vol20"].clip(lower=0.05) * math.sqrt(h / 252)).to_numpy()
        res = {
            "p_up": m["up"].predict(X), "p_tb_long": m["tb_long"].predict(X), "p_tb_short": m["tb_short"].predict(X),
            "exp_ret": m["ret"].predict(X) * scale, "q10": m["q10"].predict(X) * scale, "q90": m["q90"].predict(X) * scale,
            "mfe": m["mfe"].predict(X) * scale, "mae": m["mae"].predict(X) * scale,
        }
        per = {}
        for k, mm in (m.get("by_method") or {}).items():
            try:
                per[k] = {"p_up": mm["up"].predict(X), "p_long": mm["tb_long"].predict(X), "p_short": mm["tb_short"].predict(X)}
            except Exception:   # one broken method must not take down the forecast
                continue
        out = {}
        for i, sym in enumerate(latest.index):
            q10, q90 = float(min(res["q10"][i], res["q90"][i])), float(max(res["q10"][i], res["q90"][i]))
            out[sym] = {
                "symbol": sym, "asof": pd.Timestamp(latest["date"].iloc[i]).isoformat(), "price_asof": float(latest["close"].iloc[i]),
                "horizon_days": h, "model": a["champion"], "model_run_id": a["run_id"], "validated": a["passed"],
                "reliability": a["reliability"], "source": a["source"],
                "p_up": float(res["p_up"][i]), "p_target_first_long": float(res["p_tb_long"][i]),
                "p_target_first_short": float(res["p_tb_short"][i]),
                "exp_return": float(res["exp_ret"][i]), "q10": q10, "q90": q90, "uncertainty": q90 - q10,
                "exp_volatility": float(latest["vol20"].iloc[i] * math.sqrt(h / 252)),
                "exp_favorable_excursion": float(max(0.0, res["mfe"][i])), "exp_adverse_excursion": float(min(0.0, res["mae"][i])),
                "potential_downside": q10, "barrier_target_atr": cfg["barrier_target_atr"], "barrier_stop_atr": cfg["barrier_stop_atr"],
                "atr_pct": float(latest["atr_pct"].iloc[i]),
                "by_method": {k: {"p_up": float(v["p_up"][i]), "p_target_first_long": float(v["p_long"][i]),
                                  "p_target_first_short": float(v["p_short"][i])} for k, v in per.items()},
            }
        self._cache = (time.time(), out, day)
        return out

    def invalidate(self):
        self._cache = None


predictor = Predictor()
