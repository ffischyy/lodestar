"""Event-driven daily backtester.

Execution model (documented assumptions):
  * Signals are evaluated at the close of day t; entries fill at the open of day t+1 with
    half-spread + slippage against us. Stop and target are set from ATR known at t.
  * Exits are checked on every subsequent bar. If the open gaps through the stop, the exit fills
    at the open (worse than the stop). If a bar touches both stop and target, the stop is assumed
    first (conservative). Targets fill at the target price (or the open if gapped through).
  * Position size = risk budget / stop distance, capped by max position % and available cash.
    No leverage; short sale proceeds are not reusable for new entries.
  * Bars are split/dividend-adjusted by the provider where supported; borrow fees and
    dividends paid on shorts are not modelled.
"""
from __future__ import annotations

import math
import threading
import traceback
from dataclasses import dataclass
from datetime import datetime, timezone

import numpy as np
import pandas as pd
from sqlalchemy import update

from .. import universe as U
from ..analytics import indicators as ind
from ..db import BacktestRun, session_scope
from ..ml.engine import completed_bars, load_universe_bars
from ..providers.manager import data
from ..settings_store import get_settings
from . import strategies as STR


@dataclass
class BTConfig:
    strategy: str = "momentum"
    params: dict | None = None
    symbols: list[str] | None = None
    start: str | None = None
    end: str | None = None
    initial_capital: float = 100_000.0
    risk_per_trade_pct: float = 0.75
    max_position_pct: float = 15.0
    max_positions: int = 10
    stop_atr: float = 1.5
    target_atr: float = 2.0
    max_hold_days: int = 10
    slippage_bps: float = 5.0
    spread_bps: float = 3.0
    commission_per_share: float = 0.0
    allow_short: bool = True
    oos_fraction: float = 0.3


def run(cfg: BTConfig, bars: dict[str, pd.DataFrame], spy: pd.DataFrame, progress=None) -> dict:
    syms = [s for s in (cfg.symbols or list(bars)) if s in bars and len(bars[s]) > 250]
    bars = {s: bars[s] for s in syms}
    dates = spy.index
    start = pd.Timestamp(cfg.start, tz="UTC") if cfg.start else dates[min(len(dates) - 1, 252)]
    end = pd.Timestamp(cfg.end, tz="UTC") if cfg.end else dates[-1]
    params = {**STR.STRATEGIES[cfg.strategy].params, **(cfg.params or {})}
    sig = STR.generate(cfg.strategy, bars, spy, params, cfg.max_hold_days, cfg.target_atr, cfg.stop_atr, start,
                       progress=(lambda i, n: progress(0.1 + 0.4 * i / n)) if progress else None)
    atr = {s: ind.atr(d) for s, d in bars.items()}
    days = dates[(dates >= start) & (dates <= end)]
    if len(days) < 20:
        raise ValueError("Backtest window is too short (need at least 20 trading days)")
    side_cost = (cfg.spread_bps / 2 + cfg.slippage_bps) / 1e4
    cash = cfg.initial_capital
    pos: dict[str, dict] = {}
    pending: list[dict] = []
    trades, equity = [], []
    costs_paid = 0.0
    for i, d in enumerate(days):
        if progress and i % 50 == 0:
            progress(0.5 + 0.45 * i / len(days))
        # 1) fill pending entries at today's open
        for p in pending:
            s = p["symbol"]
            b = bars[s]
            if d not in b.index:
                continue
            o = float(b.at[d, "open"])
            sgn = p["sgn"]
            px = o * (1 + sgn * side_cost)
            a = p["atr"]
            stop = px - sgn * cfg.stop_atr * a
            tgt = px + sgn * cfg.target_atr * a
            eq_now = cash + sum(q["qty"] * float(bars[x].at[d, "open"]) if d in bars[x].index else q["qty"] * q["last"] for x, q in pos.items())
            risk_budget = eq_now * cfg.risk_per_trade_pct / 100
            qty = math.floor(min(risk_budget / max(1e-9, abs(px - stop)), eq_now * cfg.max_position_pct / 100 / px,
                                 max(0.0, cash - sum(-q["qty"] * q["last"] for q in pos.values() if q["qty"] < 0)) / px))
            if qty < 1:
                continue
            comm = cfg.commission_per_share * qty
            cash -= sgn * qty * px + comm
            costs_paid += qty * o * side_cost + comm
            pos[s] = {"qty": sgn * qty, "entry": px, "stop": stop, "target": tgt, "entry_date": d, "held": 0, "last": px,
                      "comm": comm, "risk": abs(px - stop) * qty}
        pending = []
        # 2) exits on today's bar
        for s in list(pos):
            b = bars[s]
            if d not in b.index:
                continue
            q = pos[s]
            o, h, l, c = (float(b.at[d, k]) for k in ("open", "high", "low", "close"))
            sgn = 1 if q["qty"] > 0 else -1
            is_entry_day = q["entry_date"] == d
            exit_px, why = None, None
            if q.get("exit_next_open"):
                exit_px, why = o, "signal exit"
            elif sgn > 0:
                if not is_entry_day and o <= q["stop"]:
                    exit_px, why = o, "stop (gap)"
                elif l <= q["stop"]:
                    exit_px, why = q["stop"], "stop"
                elif not is_entry_day and o >= q["target"]:
                    exit_px, why = o, "target (gap)"
                elif h >= q["target"]:
                    exit_px, why = q["target"], "target"
            else:
                if not is_entry_day and o >= q["stop"]:
                    exit_px, why = o, "stop (gap)"
                elif h >= q["stop"]:
                    exit_px, why = q["stop"], "stop"
                elif not is_entry_day and o <= q["target"]:
                    exit_px, why = o, "target (gap)"
                elif l <= q["target"]:
                    exit_px, why = q["target"], "target"
            if exit_px is None:
                q["held"] += 1
                sg = sig.get(s)
                ex_col = "exit_long" if sgn > 0 else "exit_short"
                if sg is not None and ex_col in sg.columns and d in sg.index and bool(sg.at[d, ex_col]):
                    q["exit_next_open"] = True   # decided at today's close, executed at tomorrow's open
                if q["held"] >= cfg.max_hold_days:
                    exit_px, why = c, "time exit"
            q["last"] = c
            if exit_px is not None:
                fill = exit_px * (1 - sgn * side_cost)
                qty = abs(q["qty"])
                comm = cfg.commission_per_share * qty
                cash += sgn * qty * fill - comm
                costs_paid += qty * exit_px * side_cost + comm
                gross = (exit_px - q["entry"]) * q["qty"]
                net = (fill - q["entry"]) * q["qty"] - comm - q["comm"]
                trades.append({"symbol": s, "side": "long" if sgn > 0 else "short", "entry_date": str(q["entry_date"].date()),
                               "exit_date": str(d.date()), "entry": round(q["entry"], 4), "exit": round(fill, 4), "qty": qty,
                               "pnl": round(net, 2), "gross_pnl": round(gross, 2), "return_pct": round((fill / q["entry"] - 1) * sgn * 100, 3),
                               "r_multiple": round(net / q["risk"], 3) if q["risk"] else None, "bars": q["held"] + 1, "exit_reason": why})
                del pos[s]
        # 3) mark to market
        mv = sum(q["qty"] * q["last"] for q in pos.values())
        equity.append({"date": d, "equity": cash + mv, "exposure": sum(abs(q["qty"] * q["last"]) for q in pos.values())})
        # 4) signals at today's close -> tomorrow
        if i == len(days) - 1:
            break
        slots = cfg.max_positions - len(pos)
        if slots <= 0:
            continue
        cands = []
        for s, sg in sig.items():
            if s in pos or d not in sg.index:
                continue
            a = atr[s].get(d, np.nan)
            if not np.isfinite(a):
                continue
            if bool(sg.at[d, "long"]):
                cands.append({"symbol": s, "sgn": 1, "score": float(sg.at[d, "score"]), "atr": float(a)})
            elif cfg.allow_short and bool(sg.at[d, "short"]):
                cands.append({"symbol": s, "sgn": -1, "score": float(sg.at[d, "score"]), "atr": float(a)})
        cands.sort(key=lambda x: -x["score"])
        pending = cands[:slots]

    eq = pd.DataFrame(equity).set_index("date")
    b = spy["close"].reindex(eq.index).ffill()
    bench = cfg.initial_capital * b / float(spy["open"].reindex(eq.index).iloc[0])
    split = eq.index[int(len(eq) * (1 - cfg.oos_fraction))] if 0 < cfg.oos_fraction < 1 else None
    res = {
        "metrics": metrics(eq["equity"], trades, cfg.initial_capital, costs_paid, eq["exposure"]),
        "benchmark": metrics(bench, [], cfg.initial_capital, 0.0, None),
        "equity": [{"date": str(ix.date()), "equity": round(float(v), 2), "benchmark": round(float(bv), 2),
                    "drawdown": round(float(dd), 4)} for ix, v, bv, dd in zip(eq.index, eq["equity"], bench, eq["equity"] / eq["equity"].cummax() - 1)],
        "trades": trades,
        "by_year": by_period(eq["equity"], trades),
        "params": params,
    }
    if split is not None and cfg.strategy != "ml_forecast":
        res["in_sample"] = metrics(eq["equity"][eq.index < split], [t for t in trades if t["entry_date"] < str(split.date())], cfg.initial_capital, None, None)
        res["out_of_sample"] = metrics(eq["equity"][eq.index >= split], [t for t in trades if t["entry_date"] >= str(split.date())],
                                       float(eq["equity"][eq.index < split].iloc[-1]) if (eq.index < split).any() else cfg.initial_capital, None, None)
        res["split_date"] = str(split.date())
    return res


def metrics(equity: pd.Series, trades: list[dict], initial: float, costs: float | None, exposure: pd.Series | None) -> dict:
    if len(equity) < 2:
        return {}
    e = equity.astype(float)
    r = e.pct_change().dropna()
    years = max(1 / 252, len(e) / 252)
    total = e.iloc[-1] / e.iloc[0] - 1 if e.iloc[0] else 0
    dd = e / e.cummax() - 1
    downside = r[r < 0]
    pnl = np.array([t["pnl"] for t in trades]) if trades else np.array([])
    wins, losses = pnl[pnl > 0], pnl[pnl <= 0]
    m = {
        "start": str(e.index[0].date()), "end": str(e.index[-1].date()),
        "total_return_pct": total * 100, "cagr_pct": ((1 + total) ** (1 / years) - 1) * 100 if total > -1 else -100,
        "max_drawdown_pct": float(dd.min() * 100),
        "sharpe": float(r.mean() / r.std() * math.sqrt(252)) if r.std() > 0 else 0.0,
        "sortino": float(r.mean() / downside.std() * math.sqrt(252)) if len(downside) > 1 and downside.std() > 0 else 0.0,
        "volatility_pct": float(r.std() * math.sqrt(252) * 100),
        "trades": int(len(pnl)),
        "win_rate_pct": float(len(wins) / len(pnl) * 100) if len(pnl) else None,
        "profit_factor": float(wins.sum() / -losses.sum()) if len(losses) and losses.sum() < 0 else (None if not len(wins) else float("inf")),
        "expectancy": float(pnl.mean()) if len(pnl) else None,
        "expectancy_r": float(np.mean([t["r_multiple"] for t in trades if t.get("r_multiple") is not None])) if trades else None,
        "avg_win": float(wins.mean()) if len(wins) else None, "avg_loss": float(losses.mean()) if len(losses) else None,
        "avg_bars_held": float(np.mean([t["bars"] for t in trades])) if trades else None,
        "net_profit": float(e.iloc[-1] - initial),
    }
    if costs is not None:
        m["costs_paid"] = float(costs)
        m["gross_profit_before_costs"] = m["net_profit"] + float(costs)
    if exposure is not None:
        m["avg_exposure_pct"] = float((exposure / equity).mean() * 100)
    if m["profit_factor"] == float("inf"):
        m["profit_factor"] = None
    return m


def by_period(equity: pd.Series, trades: list[dict]) -> list[dict]:
    out = []
    for y, g in equity.groupby(equity.index.year):
        if len(g) < 5:
            continue
        tr = [t for t in trades if t["exit_date"].startswith(str(y))]
        out.append({"year": int(y), "return_pct": float((g.iloc[-1] / g.iloc[0] - 1) * 100),
                    "max_drawdown_pct": float((g / g.cummax() - 1).min() * 100), "trades": len(tr),
                    "win_rate_pct": float(np.mean([t["pnl"] > 0 for t in tr]) * 100) if tr else None})
    return out


def _clean(o):
    if isinstance(o, dict):
        return {k: _clean(v) for k, v in o.items()}
    if isinstance(o, list):
        return [_clean(v) for v in o]
    if isinstance(o, (float, np.floating)):
        f = float(o)
        return round(f, 6) if math.isfinite(f) else None
    if isinstance(o, np.integer):
        return int(o)
    return o


def start_async(cfg: BTConfig, name: str | None = None) -> int:
    st = get_settings()
    with session_scope() as s:
        r = BacktestRun(name=name or f"{STR.STRATEGIES[cfg.strategy].name}", status="running", source=data.provider().name,
                        config=cfg.__dict__)
        s.add(r)
        s.flush()
        rid = r.id

    def job():
        def prog(p):
            with session_scope() as s2:
                s2.execute(update(BacktestRun).where(BacktestRun.id == rid).values(progress=round(p, 3)))
        try:
            syms = cfg.symbols or U.universe(st)
            bars, spy, _ = load_universe_bars(syms, lambda i, n: prog(0.1 * i / n))
            res = _clean(run(cfg, bars, spy, prog))
            with session_scope() as s2:
                s2.execute(update(BacktestRun).where(BacktestRun.id == rid).values(
                    status="done", progress=1.0, metrics={k: res[k] for k in res if k not in ("equity", "trades")},
                    equity=res["equity"], trades=res["trades"]))
        except Exception as e:
            with session_scope() as s2:
                s2.execute(update(BacktestRun).where(BacktestRun.id == rid).values(status="failed", error=f"{e}\n{traceback.format_exc()[-800:]}"))
    threading.Thread(target=job, daemon=True, name=f"bt-{rid}").start()
    return rid
