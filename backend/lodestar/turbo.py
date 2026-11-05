"""Turbo simulator: vectorised, high-throughput strategy simulation.

Where the event-driven backtester replays one market carefully, the turbo engine runs
many complete markets fast, so you can see the *distribution* of outcomes rather than
one lucky (or unlucky) history.

Pipeline per market (all NumPy, arrays shaped days x symbols):
  1. Prices: either the cached history of your universe ("history" mode), or a freshly
     generated synthetic market ("monte_carlo" mode, a new random seed every time).
  2. Features: 6-month momentum (ex last week), 1-day reversal, 63-day relative strength,
     distance to the 200-day average, ATR%.
  3. Signals, decided at the close of day t using only data up to t:
       ai        walk-forward logistic model on the features, retrained every quarter on
                 earlier data with a purge gap (never sees the period it trades)
       momentum  top-decile 6-month momentum
       reversal  biggest 1-day losers above their 200-day average
       random    random entries: the baseline any strategy must beat
  4. Trades: enter at the next open plus costs; exit at the first touch of the ATR stop
     (stop wins if both are touched on one bar, gaps fill at the open) or target, or at the
     close after the holding limit. All candidate exits are computed at once with a
     strided window search; a single pass then enforces one position per symbol and a
     maximum number of open positions.
  5. Equity: fixed-fractional risk per trade, compounded by exit date.

Throughput is reported as trades simulated per minute of engine time.
"""
from __future__ import annotations

import heapq
import logging
import math
import threading
import warnings
import time
import traceback
from dataclasses import asdict, dataclass

import numpy as np
from sklearn.linear_model import LogisticRegression
from sqlalchemy import update

from .db import TurboRun, session_scope

log = logging.getLogger("lodestar.turbo")
_lock = threading.Lock()
_cancel = threading.Event()


@dataclass
class TurboConfig:
    mode: str = "monte_carlo"        # monte_carlo | history
    strategy: str = "ai"             # ai | momentum | reversal | random
    markets: int = 20                # number of synthetic markets (monte_carlo)
    symbols: int = 200               # stocks per synthetic market
    years: float = 8.0               # history length per synthetic market
    pattern_strength: str = "weak"   # none | weak | medium  (how much structure the simulator plants)
    horizon_days: int = 10
    stop_atr: float = 1.5
    target_atr: float = 2.0
    min_prob_edge: float = 0.03      # ai: P(target first) minus base rate
    max_positions: int = 20
    risk_per_trade_pct: float = 0.5
    max_position_pct: float = 10.0
    slippage_bps: float = 5.0
    spread_bps: float = 3.0
    allow_short: bool = False
    starting_cash: float = 100_000.0  # every simulated market starts with this much play money
    seed: int | None = None


# ----------------------------------------------------------------- market generation
_STRENGTH = {"none": (0.0, 0.0), "weak": (0.00020, 0.06), "medium": (0.00035, 0.10)}


def synthetic_market(n_sym: int, n_days: int, seed: int, strength: str = "weak") -> dict[str, np.ndarray]:
    """Factor model with regime switching, volatility clustering, a slowly varying
    stock-specific drift (momentum) and short-term reversal. ``strength='none'`` gives a
    pure random walk with no exploitable pattern."""
    rng = np.random.default_rng(seed)
    drift_sd, rev = _STRENGTH.get(strength, _STRENGTH["weak"])
    P = np.array([[0.985, 0.012, 0.003], [0.02, 0.97, 0.01], [0.02, 0.03, 0.95]])
    mu_r = np.array([0.0003, -0.0001, -0.0014])
    vol_r = np.array([0.008, 0.011, 0.022])
    u = rng.random(n_days)
    reg = np.zeros(n_days, dtype=np.int64)
    cum = P.cumsum(1)
    for t in range(1, n_days):
        reg[t] = np.searchsorted(cum[reg[t - 1]], u[t])
    mkt = mu_r[reg] + vol_r[reg] * rng.standard_t(5, n_days) / math.sqrt(5 / 3)
    beta = 0.7 + 0.8 * rng.random(n_sym)
    ivol = 0.008 + 0.014 * rng.random(n_sym)
    shocks = rng.standard_normal((n_days, n_sym)) * ivol * np.where(reg == 2, 1.6, 1.0)[:, None]
    dshock = rng.normal(0, drift_sd, (n_days, n_sym)) if drift_sd > 0 else np.zeros((n_days, n_sym))
    r = np.empty((n_days, n_sym))
    drift = np.zeros(n_sym)
    resid_prev = np.zeros(n_sym)
    for t in range(n_days):
        drift = 0.985 * drift + dshock[t]
        resid = shocks[t] - rev * resid_prev
        r[t] = beta * mkt[t] + drift + resid
        resid_prev = resid
    base = 20 + 180 * rng.random(n_sym)
    close = base * np.exp(np.cumsum(r, axis=0))
    gap = rng.normal(0, 0.003, (n_days, n_sym))
    opn = np.vstack([base[None, :], close[:-1] * np.exp(gap[1:])])
    rng_ = np.abs(r) + np.abs(rng.normal(0, 0.006, (n_days, n_sym)))
    high = np.maximum(opn, close) * (1 + rng_ * rng.random((n_days, n_sym)))
    low = np.minimum(opn, close) * (1 - rng_ * rng.random((n_days, n_sym)))
    return {"open": opn, "high": high, "low": low, "close": close}


def history_market() -> dict[str, np.ndarray]:
    """Cached daily bars of the configured universe, aligned on common dates."""
    import pandas as pd

    from . import universe as U
    from .ml.engine import completed_bars
    from .providers.manager import data
    from .settings_store import get_settings
    frames = {}
    for s in U.universe(get_settings()):
        try:
            df = completed_bars(data.bars(s)[0])
            if len(df) > 300:
                frames[s] = df
        except Exception:
            continue
    if len(frames) < 5:
        raise RuntimeError("Not enough cached history for the universe (need at least 5 stocks with 300+ days).")
    idx = sorted(set.intersection(*(set(f.index) for f in frames.values())))
    out = {k: np.column_stack([frames[s].loc[idx, k].to_numpy(float) for s in frames]) for k in ("open", "high", "low", "close")}
    out["symbols"] = list(frames)
    out["dates"] = [str(pd.Timestamp(d).date()) for d in idx]
    return out


# ----------------------------------------------------------------- features & labels
def _shift(a: np.ndarray, k: int) -> np.ndarray:
    out = np.full_like(a, np.nan)
    if k < a.shape[0]:
        out[k:] = a[:-k] if k else a
    return out


def _rolling_mean(a: np.ndarray, n: int) -> np.ndarray:
    c = np.cumsum(np.nan_to_num(a), axis=0)
    out = np.full_like(a, np.nan)
    out[n - 1:] = c[n - 1:] - np.vstack([np.zeros((1, a.shape[1])), c[:-n]])
    out[n - 1:] /= n
    return out


def features(m: dict[str, np.ndarray]) -> dict[str, np.ndarray]:
    c, h, l = m["close"], m["high"], m["low"]
    lc = np.log(c)
    pc = _shift(c, 1)
    tr = np.nanmax(np.stack([h - l, np.abs(h - pc), np.abs(l - pc)]), axis=0)
    atr = _rolling_mean(tr, 14)
    r63 = lc - _shift(lc, 63)
    with np.errstate(all="ignore"), warnings.catch_warnings():
        warnings.simplefilter("ignore", RuntimeWarning)     # the first 63 days have no history yet: NaN is expected
        xs_mean = np.nanmean(r63, axis=1, keepdims=True)
    return {
        "mom": _shift(lc, 5) - _shift(lc, 126),
        "rev": lc - _shift(lc, 1),
        "rs": r63 - xs_mean,
        "trend": c / _rolling_mean(c, 200) - 1,
        "atr": atr,
    }


def first_touch(m: dict[str, np.ndarray], t_idx: np.ndarray, s_idx: np.ndarray, sgn: np.ndarray, atr: np.ndarray,
                cfg: TurboConfig) -> dict[str, np.ndarray]:
    """Vectorised exit search for many trades at once. Entry at open[t+1]; window t+1..t+h."""
    h = cfg.horizon_days
    side_cost = (cfg.spread_bps / 2 + cfg.slippage_bps) / 1e4
    o, hi, lo, c = m["open"], m["high"], m["low"], m["close"]
    entry_raw = o[t_idx + 1, s_idx]
    entry = entry_raw * (1 + sgn * side_cost)
    stop = entry - sgn * cfg.stop_atr * atr
    tgt = entry + sgn * cfg.target_atr * atr
    steps = np.arange(1, h + 1)
    rows = t_idx[:, None] + steps[None, :]                  # n x h day indices
    cols = s_idx[:, None]
    H, L, O = hi[rows, cols], lo[rows, cols], o[rows, cols]
    up = sgn[:, None] > 0
    hit_stop = np.where(up, L <= stop[:, None], H >= stop[:, None])
    hit_tgt = np.where(up, H >= tgt[:, None], L <= tgt[:, None])
    any_stop, any_tgt = hit_stop.any(1), hit_tgt.any(1)
    k_stop = np.where(any_stop, hit_stop.argmax(1), h)
    k_tgt = np.where(any_tgt, hit_tgt.argmax(1), h)
    stop_first = k_stop <= k_tgt                           # same bar -> stop (conservative)
    k = np.where(stop_first, k_stop, k_tgt)
    reason = np.where(k >= h, 2, np.where(stop_first, 0, 1))   # 0 stop, 1 target, 2 time
    kk = np.minimum(k, h - 1)
    open_k = O[np.arange(len(k)), kk]
    gap_stop = np.where(up[:, 0], open_k <= stop, open_k >= stop) & (kk > 0)
    gap_tgt = np.where(up[:, 0], open_k >= tgt, open_k <= tgt) & (kk > 0)
    exit_px = np.where(reason == 2, c[t_idx + h, s_idx],
                       np.where(reason == 0, np.where(gap_stop, open_k, stop), np.where(gap_tgt, open_k, tgt)))
    exit_fill = exit_px * (1 - sgn * side_cost)
    ret = (exit_fill / entry - 1) * sgn
    r_mult = ret * entry / np.abs(entry - stop)
    return {"exit_day": t_idx + 1 + kk, "ret": ret, "r": r_mult, "reason": reason, "stop_dist": np.abs(entry - stop) / entry,
            "hit": (reason == 1).astype(float), "entry": entry, "exit_fill": exit_fill}


# ----------------------------------------------------------------- signals
def _ai_scores(F: dict[str, np.ndarray], m: dict[str, np.ndarray], cfg: TurboConfig, start: int, retrain: int = 63
               ) -> tuple[np.ndarray, np.ndarray]:
    """Walk-forward logistic on the 4 factor features. Returns (p_long - base_long, p_short - base_short)."""
    D, S = m["close"].shape
    X = np.stack([F["mom"], F["rev"], F["rs"], F["trend"]], axis=-1)        # D x S x 4
    ok = np.isfinite(X).all(-1) & np.isfinite(F["atr"])
    h = cfg.horizon_days
    # labels for every (t, s) where the full horizon exists
    T, Sx = np.nonzero(ok[: D - h - 1])
    edge_l = np.full((D, S), np.nan)
    edge_s = np.full((D, S), np.nan)
    if len(T) == 0:
        return edge_l, edge_s
    lab_l = first_touch(m, T, Sx, np.ones(len(T)), F["atr"][T, Sx], cfg)["hit"]
    lab_s = first_touch(m, T, Sx, -np.ones(len(T)), F["atr"][T, Sx], cfg)["hit"] if cfg.allow_short else None
    Xf = X[T, Sx]
    for c0 in range(start, D - 1, retrain):
        c1 = min(D - 1, c0 + retrain)
        train = T < c0 - h - 1                         # purge: labels must end before the chunk
        if train.sum() < 2000:
            continue
        if train.sum() > 40000:                        # recent-weighted subsample keeps retraining fast
            idx = np.nonzero(train)[0]
            keep = np.concatenate([idx[-20000:], np.random.default_rng(c0).choice(idx[:-20000], 20000, replace=False)])
            train = np.zeros_like(train)
            train[keep] = True
        mu, sd = Xf[train].mean(0), Xf[train].std(0) + 1e-9
        rows = np.nonzero(ok[c0:c1])
        if len(rows[0]) == 0:
            continue
        Xt = (X[rows[0] + c0, rows[1]] - mu) / sd
        for lab, out in ((lab_l, edge_l), (lab_s, edge_s)):
            if lab is None:
                continue
            y = lab[train]
            if y.min() == y.max():
                continue
            model = LogisticRegression(C=1.0, max_iter=200).fit((Xf[train] - mu) / sd, y)
            out[rows[0] + c0, rows[1]] = model.predict_proba(Xt)[:, 1] - y.mean()
    return edge_l, edge_s


def candidates(F: dict[str, np.ndarray], m: dict[str, np.ndarray], cfg: TurboConfig, start: int, rng: np.random.Generator):
    D, S = m["close"].shape
    h = cfg.horizon_days
    valid = np.zeros((D, S), bool)
    valid[start: D - h - 1] = True
    valid &= np.isfinite(F["atr"]) & (F["atr"] > 0)
    longs = np.zeros((D, S), bool)
    shorts = np.zeros((D, S), bool)
    score = np.zeros((D, S))
    if cfg.strategy == "ai":
        el, es = _ai_scores(F, m, cfg, start)
        longs = valid & (el >= cfg.min_prob_edge)
        score = np.nan_to_num(el)
        if cfg.allow_short:
            shorts = valid & (es >= cfg.min_prob_edge) & ~longs
            score = np.where(shorts, np.nan_to_num(es), score)
    elif cfg.strategy == "momentum":
        q = np.nanquantile(F["mom"], [0.1, 0.9], axis=1)
        longs = valid & (F["mom"] >= q[1][:, None]) & (F["trend"] > 0)
        shorts = valid & (F["mom"] <= q[0][:, None]) & (F["trend"] < 0) if cfg.allow_short else shorts
        score = np.abs(np.nan_to_num(F["mom"]))
    elif cfg.strategy == "reversal":
        q = np.nanquantile(F["rev"], [0.05, 0.95], axis=1)
        longs = valid & (F["rev"] <= q[0][:, None]) & (F["trend"] > 0)
        shorts = valid & (F["rev"] >= q[1][:, None]) & (F["trend"] < 0) if cfg.allow_short else shorts
        score = np.abs(np.nan_to_num(F["rev"]))
    elif cfg.strategy == "random":
        p = min(1.0, cfg.max_positions / max(1, S) / max(1, h) * 3)
        longs = valid & (rng.random((D, S)) < p)
        if cfg.allow_short:
            shorts = valid & (rng.random((D, S)) < p) & ~longs
        score = rng.random((D, S))
    else:
        raise ValueError(f"unknown strategy {cfg.strategy}")
    T, Sx = np.nonzero(longs | shorts)
    sgn = np.where(longs[T, Sx], 1.0, -1.0)
    return T, Sx, sgn, score[T, Sx]


def select_portfolio(T, Sx, score, exit_day, max_positions: int) -> np.ndarray:
    """One position per symbol, at most ``max_positions`` open, best scores first each day."""
    order = np.lexsort((-score, T))
    busy = {}
    active: list[int] = []
    keep = np.zeros(len(T), bool)
    for i in order:
        t = T[i] + 1                                   # entry day
        while active and active[0] < t:
            heapq.heappop(active)
        s = Sx[i]
        if busy.get(s, -1) >= t or len(active) >= max_positions:
            continue
        keep[i] = True
        busy[s] = exit_day[i]
        heapq.heappush(active, exit_day[i])
    return keep


# ----------------------------------------------------------------- one market
def simulate_market(m: dict[str, np.ndarray], cfg: TurboConfig, rng: np.random.Generator) -> dict:
    D, S = m["close"].shape
    F = features(m)
    start = max(260, int(D * 0.3)) if cfg.strategy == "ai" else 220
    t_sig = time.perf_counter()
    T, Sx, sgn, score = candidates(F, m, cfg, start, rng)
    sig_s = time.perf_counter() - t_sig
    t0 = time.perf_counter()
    if len(T) == 0:
        return {"trades": 0, "candidates": 0, "engine_s": 0.0, "signal_s": sig_s, "equity": [1.0], "days": D - start,
                "start_cash": float(cfg.starting_cash), "final_value": float(cfg.starting_cash), "profit": 0.0, "tape": []}
    ex = first_touch(m, T, Sx, sgn, F["atr"][T, Sx], cfg)
    keep = select_portfolio(T, Sx, score, ex["exit_day"], cfg.max_positions)
    engine_s = time.perf_counter() - t0 + 1e-9
    r = ex["r"][keep]
    # position cap: the risk budget may imply a position larger than allowed
    risk = cfg.risk_per_trade_pct / 100
    size_scale = np.minimum(1.0, (cfg.max_position_pct / 100) / (risk / np.maximum(ex["stop_dist"][keep], 1e-6)))
    pnl_frac = r * risk * size_scale
    days = ex["exit_day"][keep]
    daily = np.zeros(D)
    np.add.at(daily, days, pnl_frac)
    eq = np.cumprod(1 + np.clip(daily[start:], -0.99, None))
    dd = eq / np.maximum.accumulate(eq) - 1
    dr = np.diff(np.concatenate([[1.0], eq])) / np.concatenate([[1.0], eq[:-1]])
    wins = r[r > 0]
    losses = r[r <= 0]
    money = _money_tape(cfg, start, eq, pnl_frac, days, T[keep] + 1, Sx[keep], sgn[keep], ex["entry"][keep],
                        ex["exit_fill"][keep], ex["reason"][keep], risk * size_scale / np.maximum(ex["stop_dist"][keep], 1e-6))
    return {
        "trades": int(keep.sum()), "candidates": int(len(T)), "engine_s": engine_s, "signal_s": sig_s, "days": int(D - start),
        "total_return_pct": float((eq[-1] - 1) * 100), "max_drawdown_pct": float(dd.min() * 100),
        "sharpe": float(dr.mean() / dr.std() * math.sqrt(252)) if dr.std() > 0 else 0.0,
        "win_rate_pct": float((r > 0).mean() * 100) if len(r) else None,
        "avg_r": float(r.mean()) if len(r) else None,
        "profit_factor": float(wins.sum() / -losses.sum()) if len(losses) and losses.sum() < 0 else None,
        "exit_reasons": {"stop": int((ex["reason"][keep] == 0).sum()), "target": int((ex["reason"][keep] == 1).sum()),
                         "time": int((ex["reason"][keep] == 2).sum())},
        "r_values": r, "equity": eq, **money,
    }


def _money_tape(cfg, start, eq, pnl_frac, exit_days, entry_days, syms, sgn, entry, exit_fill, reason, pos_frac) -> dict:
    """Dollar view of one simulated market: how the starting cash moved, trade by trade.

    Each trade's profit is its share of that day's portfolio return applied to the balance
    before that day, so the running balance adds up exactly to the equity curve."""
    cash0 = float(cfg.starting_cash)
    eq_before = np.concatenate([[1.0], eq])                  # equity multiple at the start of each sim day
    order = np.lexsort((entry_days, exit_days))
    bal = cash0
    tape, pnl_all = [], np.zeros(len(order))
    every = max(1, len(order) // 400)                        # keep at most ~400 trades for the live display
    reason_txt = {0: "stop-loss", 1: "take-profit", 2: "time limit"}
    for j, i in enumerate(order):
        before = cash0 * eq_before[max(0, exit_days[i] - start)]
        pnl = float(pnl_frac[i] * before)
        value = float(pos_frac[i] * before)
        shares = max(1, int(value / max(entry[i], 1e-6)))
        bal += pnl
        pnl_all[j] = pnl
        if j % every == 0 or j == len(order) - 1:
            tape.append({"n": j + 1, "day": int(entry_days[i] - start), "exit_day": int(exit_days[i] - start),
                         "symbol": f"SIM-{int(syms[i]):03d}", "side": "long" if sgn[i] > 0 else "short", "shares": shares,
                         "entry": round(float(entry[i]), 2), "exit": round(float(exit_fill[i]), 2), "cost": round(shares * float(entry[i]), 2),
                         "pnl": round(pnl, 2), "balance": round(bal, 2), "why_exit": reason_txt.get(int(reason[i]), "")})
    final = cash0 * float(eq[-1]) if len(eq) else cash0
    wins = pnl_all[pnl_all > 0]
    losses = pnl_all[pnl_all <= 0]
    return {"start_cash": cash0, "final_value": round(final, 2), "profit": round(final - cash0, 2),
            "gross_profit": round(float(wins.sum()), 2), "gross_loss": round(float(losses.sum()), 2),
            "avg_profit_per_trade": round(float(pnl_all.mean()), 2) if len(pnl_all) else None,
            "best_trade": round(float(pnl_all.max()), 2) if len(pnl_all) else None,
            "worst_trade": round(float(pnl_all.min()), 2) if len(pnl_all) else None,
            "tape": tape}


# ----------------------------------------------------------------- orchestration
def _downsample(a: np.ndarray, n: int = 160) -> list[float]:
    if len(a) <= n:
        return [round(float(x), 5) for x in a]
    idx = np.linspace(0, len(a) - 1, n).astype(int)
    return [round(float(a[i]), 5) for i in idx]


def run(cfg: TurboConfig, progress=None) -> dict:
    t_all = time.perf_counter()
    seed = cfg.seed if cfg.seed is not None else int(time.time() * 1000) % 2**31
    rng = np.random.default_rng(seed)
    results, curves, all_r, tapes = [], [], [], []
    n_markets = 1 if cfg.mode == "history" else max(1, cfg.markets)
    hist = history_market() if cfg.mode == "history" else None
    n_days = int(252 * cfg.years)
    bars_total = 0
    for i in range(n_markets):
        if _cancel.is_set():
            break
        m = hist if hist is not None else synthetic_market(cfg.symbols, n_days, seed + 1000 * (i + 1), cfg.pattern_strength)
        bars_total += m["close"].size
        res = simulate_market(m, cfg, np.random.default_rng(seed + i))
        all_r.append(res.pop("r_values", np.array([])))
        curves.append(res.pop("equity"))
        res["market"] = i + 1
        tapes.append(res.pop("tape", []))
        results.append(res)
        if progress:
            progress((i + 1) / n_markets, _summary(results, curves, all_r, cfg, seed, t_all, bars_total, partial=True, tapes=tapes))
    return _summary(results, curves, all_r, cfg, seed, t_all, bars_total, partial=False, tapes=tapes)


def _money_summary(results, cfg, tapes) -> dict:
    cash0 = float(cfg.starting_cash)
    finals = np.array([r.get("final_value", cash0) for r in results]) if results else np.array([cash0])
    med_i = int(np.argsort(finals)[len(finals) // 2])
    profits = finals - cash0
    total_trades = sum(r["trades"] for r in results) or 0
    return {
        "start_cash": cash0, "markets": len(results),
        "median_final": float(np.median(finals)), "median_profit": float(np.median(profits)),
        "median_margin_pct": float(np.median(profits) / cash0 * 100) if cash0 else 0.0,
        "average_profit": float(profits.mean()), "best_final": float(finals.max()), "worst_final": float(finals.min()),
        "profitable_markets": int((profits > 0).sum()),
        "total_profit_all_markets": float(profits.sum()),
        "avg_profit_per_trade": float(profits.sum() / total_trades) if total_trades else None,
        "gross_profit": float(sum(r.get("gross_profit", 0.0) for r in results)),
        "gross_loss": float(sum(r.get("gross_loss", 0.0) for r in results)),
        "latest_market": results[-1]["market"] if results else None,
        "latest_tape": tapes[-1] if tapes else [],
        "median_market": results[med_i]["market"] if results else None,
        "median_tape": tapes[med_i] if tapes and len(tapes) == len(results) else [],
    }


def _summary(results, curves, all_r, cfg, seed, t_all, bars_total, partial, tapes=None) -> dict:
    trades = sum(r["trades"] for r in results)
    engine_s = sum(r["engine_s"] for r in results)
    wall_s = time.perf_counter() - t_all
    R = np.concatenate(all_r) if all_r else np.array([])
    rets = np.array([r.get("total_return_pct", 0.0) for r in results])
    hist_counts, edges = np.histogram(np.clip(R, -3, 5), bins=32, range=(-3, 5)) if len(R) else (np.array([]), np.array([]))
    med_i = int(np.argsort(rets)[len(rets) // 2]) if len(rets) else 0
    out = {
        "partial": partial, "seed": seed, "config": asdict(cfg),
        "markets_done": len(results), "trades": trades, "candidates": sum(r["candidates"] for r in results),
        "bars_processed": int(bars_total),
        "engine_seconds": round(engine_s, 4), "wall_seconds": round(wall_s, 3),
        "trades_per_minute_engine": round(trades / engine_s * 60) if engine_s > 0 else 0,
        "trades_per_minute_total": round(trades / wall_s * 60) if wall_s > 0 else 0,
        "win_rate_pct": float((R > 0).mean() * 100) if len(R) else None,
        "avg_r": float(R.mean()) if len(R) else None,
        "profit_factor": float(R[R > 0].sum() / -R[R <= 0].sum()) if len(R) and R[R <= 0].sum() < 0 else None,
        "median_return_pct": float(np.median(rets)) if len(rets) else None,
        "p05_return_pct": float(np.percentile(rets, 5)) if len(rets) else None,
        "p95_return_pct": float(np.percentile(rets, 95)) if len(rets) else None,
        "pct_markets_profitable": float((rets > 0).mean() * 100) if len(rets) else None,
        "median_max_drawdown_pct": float(np.median([r.get("max_drawdown_pct", 0.0) for r in results])) if results else None,
        "median_sharpe": float(np.median([r.get("sharpe", 0.0) for r in results])) if results else None,
        "r_histogram": {"counts": hist_counts.tolist(), "edges": [round(float(e), 2) for e in edges]},
        "markets": [{k: v for k, v in r.items()} for r in results],
        "curves": [_downsample(c) for c in curves[:12]],
        "median_curve": _downsample(curves[med_i]) if curves else [],
        "money": _money_summary(results, cfg, tapes or []),
    }
    return _clean(out)


def _clean(o):
    if isinstance(o, dict):
        return {k: _clean(v) for k, v in o.items()}
    if isinstance(o, (list, tuple)):
        return [_clean(v) for v in o]
    if isinstance(o, (float, np.floating)):
        f = float(o)
        return round(f, 6) if math.isfinite(f) else None
    if isinstance(o, np.integer):
        return int(o)
    return o


def start_async(cfg: TurboConfig) -> int:
    if _lock.locked():
        raise RuntimeError("A turbo simulation is already running")
    with session_scope() as s:
        r = TurboRun(config=asdict(cfg), status="running")
        s.add(r)
        s.flush()
        rid = r.id
    _cancel.clear()

    def job():
        with _lock:
            last = [0.0]

            def prog(p, partial):
                now = time.time()
                if now - last[0] < 0.4 and p < 1:
                    return
                last[0] = now
                with session_scope() as s2:
                    s2.execute(update(TurboRun).where(TurboRun.id == rid).values(progress=round(p, 4), result=partial))
            try:
                res = run(cfg, prog)
                with session_scope() as s2:
                    s2.execute(update(TurboRun).where(TurboRun.id == rid).values(
                        status="cancelled" if _cancel.is_set() else "done", progress=1.0, result=res))
            except Exception as e:
                log.error("turbo failed: %s", traceback.format_exc())
                with session_scope() as s2:
                    s2.execute(update(TurboRun).where(TurboRun.id == rid).values(status="failed", error=str(e)))
    threading.Thread(target=job, daemon=True, name=f"turbo-{rid}").start()
    return rid


def cancel() -> None:
    _cancel.set()


def is_running() -> bool:
    return _lock.locked()
