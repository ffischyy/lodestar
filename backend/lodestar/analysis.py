"""Per-symbol analysis bundle: signals, market context, forecast, trade plan, evidence."""
from __future__ import annotations

from . import clock as _clock

import math
import time
from datetime import datetime, timezone

import numpy as np
import pandas as pd

from . import news as news_svc
from . import risk as R
from . import universe as U
from .analytics import indicators as ind
from .analytics import signals as S
from .ml.engine import completed_bars, predictor
from .ml.features import labels as make_labels
from .providers.manager import data
from .settings_store import get_settings

_ctx_cache: tuple[float, dict] | None = None


def market_context(max_age: float = 120) -> dict:
    """Regime, breadth and sector context shared by every symbol in a scan."""
    global _ctx_cache
    if _ctx_cache and time.time() - _ctx_cache[0] < max_age:
        return _ctx_cache[1]
    spy = completed_bars(data.bars(U.BENCHMARK)[0])
    closes = {}
    for s in U.universe(get_settings()):
        try:
            closes[s] = completed_bars(data.bars(s)[0])["close"]
        except Exception:
            pass
    regime = S.market_regime(spy, closes)
    sectors = {}
    for etf, name in U.SECTOR_ETFS.items():
        try:
            c = completed_bars(data.bars(etf)[0])["close"]
            sectors[name] = {"etf": etf, "ret_1m": float(c.iloc[-1] / c.iloc[-22] - 1), "ret_3m": float(c.iloc[-1] / c.iloc[-64] - 1),
                             "above_50d": bool(c.iloc[-1] > c.rolling(50).mean().iloc[-1])}
        except Exception:
            continue
    ctx = {"regime": regime.to_dict(), "sectors": sectors, "spy": spy, "closes": closes}
    _ctx_cache = (time.time(), ctx)
    return ctx


def symbol_signals(symbol: str, df: pd.DataFrame, ctx: dict, news_items: list[dict] | None, next_earnings) -> list[S.SignalResult]:
    st = get_settings()
    sector = U.sector_of(symbol)
    etf = U.sector_etf_for(sector)
    sec_df = None
    if etf:
        try:
            sec_df = completed_bars(data.bars(etf)[0])
        except Exception:
            sec_df = None
    return [
        S.momentum(df), S.mean_reversion(df), S.trend(df), S.breakout(df),
        S.relative_strength(df, ctx["spy"], sec_df), S.volatility(df),
        S.event_risk(df, next_earnings, st["scanner"]["event_blackout_days"]),
        S.news_sentiment(news_items or []),
    ]


def signal_agreement(signals: list[S.SignalResult], direction: str) -> float:
    w = {"momentum": 1.0, "trend": 1.0, "relative_strength": 0.8, "breakout": 0.7, "mean_reversion": 0.7, "news": 0.4, "event": 0.3}
    sgn = 1 if direction == "long" else -1
    num = sum(w[s.key] * s.score * sgn for s in signals if s.key in w and "insufficient_data" not in s.flags)
    den = sum(w[s.key] for s in signals if s.key in w and "insufficient_data" not in s.flags)
    return num / den if den else 0.0


def evidence(signals: list[S.SignalResult], direction: str, forecast: dict | None, ctx: dict, symbol: str) -> dict:
    sgn = 1 if direction == "long" else -1
    sup, opp = [], []
    for s in signals:
        if s.direction in ("info", "neutral") and s.key not in ("volatility",):
            continue
        if s.key == "volatility":
            continue
        (sup if s.score * sgn > 0 else opp).append({"source": s.name, "category": s.category, "text": s.summary, "score": round(s.score * sgn, 2)})
    reg = ctx["regime"]
    reg_score = reg["score"] * sgn
    (sup if reg_score > 0.1 else opp if reg_score < -0.1 else []).append(
        {"source": "Market regime", "category": "regime", "text": reg["summary"], "score": round(reg_score, 2)})
    sector = U.sector_of(symbol)
    sec = ctx["sectors"].get(sector)
    if sec:
        ss = math.tanh(sec["ret_1m"] / 0.04) * sgn
        (sup if ss > 0.1 else opp if ss < -0.1 else []).append(
            {"source": "Sector", "category": "context", "text": f"{sector} sector ({sec['etf']}) {sec['ret_1m']:+.1%} over 1 month, {sec['ret_3m']:+.1%} over 3 months.",
             "score": round(ss, 2)})
    if forecast:
        e = forecast["exp_return"] * sgn
        txt = (f"ML forecast ({forecast['model']}, {forecast['horizon_days']}-day): expected return {forecast['exp_return']:+.2%} "
               f"(80% interval {forecast['q10']:+.1%} to {forecast['q90']:+.1%}).")
        (sup if e > 0 else opp).append({"source": "ML forecast", "category": "ml", "text": txt, "score": round(math.tanh(e / 0.02), 2)})
    sup.sort(key=lambda x: -abs(x["score"]))
    opp.sort(key=lambda x: -abs(x["score"]))
    return {"supporting": sup, "contradicting": opp}


def risks_for(signals: list[S.SignalResult], forecast: dict | None, quote_status: str, direction: str) -> list[str]:
    out = []
    flags = {f for s in signals for f in s.flags}
    vol = next((s for s in signals if s.key == "volatility"), None)
    if "earnings_imminent" in flags:
        out.append("Earnings announcement inside the blackout window — overnight gap risk is high and model inputs are unreliable.")
    if "high_volatility" in flags or (vol and vol.values.get("vol_regime") == "high"):
        out.append("Volatility is elevated vs the past year; stops are wider and gap risk higher.")
    if "recent_gap" in flags:
        out.append("A recent price gap suggests news-driven trading; follow-through is uncertain.")
    if "low_volume_breakout" in flags:
        out.append("Breakout volume is below average, raising the risk of a false breakout.")
    if forecast and forecast["uncertainty"] > 0.10:
        out.append(f"Wide forecast interval ({forecast['uncertainty']:.1%}) — the model's central estimate is low-confidence.")
    if forecast and not forecast.get("validated"):
        out.append("The active model did not pass out-of-sample validation gates; treat its numbers as unproven.")
    if direction == "short":
        out.append("Short positions have theoretically unlimited loss and can be squeezed; borrow costs are not modelled.")
    if quote_status in ("stale", "cached"):
        out.append(f"Price data is {quote_status}; levels may not reflect the current market.")
    if quote_status == "simulated":
        out.append("All prices are SIMULATED; nothing here reflects real market conditions.")
    out.append(R.STOP_DISCLAIMER)
    return out


def symbol_history_stats(df: pd.DataFrame, cfg: dict) -> dict:
    """How often this symbol's own history hit the target barrier first (unconditional, last 2y)."""
    lab = make_labels(df.tail(520), cfg["horizon_days"], cfg["barrier_target_atr"], cfg["barrier_stop_atr"]).dropna()
    if lab.empty:
        return {}
    return {"window_days": int(len(lab)), "long_target_first_rate": float(lab.y_tb_long.mean()),
            "short_target_first_rate": float(lab.y_tb_short.mean()), "positive_return_rate": float(lab.y_up.mean()),
            "median_fwd_return": float(lab.fwd_ret.median())}


def research(symbol: str) -> dict:
    symbol = symbol.upper()
    st = get_settings()
    df_all, meta = data.bars(symbol, "1D")
    if df_all.empty:
        raise ValueError(f"No data for {symbol}")
    df = completed_bars(df_all)
    q = data.quotes([symbol]).get(symbol)
    prof = data.profile(symbol)
    try:
        news_svc.refresh([symbol], 30)
    except Exception:
        pass
    items = news_svc.query(symbol, days=7, limit=40)
    ctx = market_context()
    sigs = symbol_signals(symbol, df, ctx, items, prof.next_earnings if prof else None)
    fc = predictor.predict_all().get(symbol)
    info = predictor.info()
    cfg = info or {"horizon_days": st["model"]["horizon_days"], "barrier_target_atr": st["model"]["barrier_target_atr"],
                   "barrier_stop_atr": st["model"]["barrier_stop_atr"]}
    price = q.price if q else float(df_all["close"].iloc[-1])
    atr = float(ind.atr(df).iloc[-1])
    plans = {}
    for d in ("long", "short"):
        plan = R.trade_plan(d, price, atr, cfg["barrier_stop_atr"], cfg["barrier_target_atr"])
        plans[d] = {"plan": plan.to_dict(), "agreement": round(signal_agreement(sigs, d), 3),
                    "evidence": evidence(sigs, d, fc, ctx, symbol),
                    "risks": risks_for(sigs, fc, q.status.value if q else meta["status"], d)}
    lean = "long" if plans["long"]["agreement"] + (fc["exp_return"] * 20 if fc else 0) >= plans["short"]["agreement"] - (fc["exp_return"] * 20 if fc else 0) else "short"
    return {
        "symbol": symbol, "name": U.meta(symbol)[0] if not prof else prof.name, "sector": U.sector_of(symbol),
        "quote": q.to_dict() if q else None, "bars_meta": meta, "profile": prof.to_dict() if prof else None,
        "signals": [s.to_dict() for s in sigs], "regime": ctx["regime"], "forecast": fc, "model": info,
        "plans": plans, "lean": lean, "history": symbol_history_stats(df, cfg),
        "news": news_svc.serialize(items[:15]),
        "generated_at": _clock.now().isoformat(),
    }


def narrative(r: dict, direction: str | None = None) -> str:
    """Deterministic, rule-generated summary built only from the bundle's numbers."""
    d = direction or r["lean"]
    p = r["plans"][d]
    fc = r["forecast"]
    lines = [f"{r['symbol']} ({r['name']}, {r['sector']}). Market regime: {r['regime']['values'].get('label_name', 'unknown')}."]
    if fc:
        pt = fc["p_target_first_long"] if d == "long" else fc["p_target_first_short"]
        lines.append(f"Over the next {fc['horizon_days']} trading days the {fc['model']} model estimates a "
                     f"{fc['p_up']:.0%} chance of a positive return and a {pt:.0%} chance that the {d} target "
                     f"({fc['barrier_target_atr']}×ATR) is reached before the stop ({fc['barrier_stop_atr']}×ATR). "
                     f"Central return estimate {fc['exp_return']:+.2%}, 80% range {fc['q10']:+.1%} to {fc['q90']:+.1%}.")
        if r.get("history"):
            base = r["history"]["long_target_first_rate"] if d == "long" else r["history"]["short_target_first_rate"]
            lines.append(f"For context, this stock reached the same {d} target first {base:.0%} of the time over the last ~2 years (unconditional).")
    else:
        lines.append("No trained model is active, so there is no statistical forecast.")
    sup = p["evidence"]["supporting"][:3]
    opp = p["evidence"]["contradicting"][:3]
    if sup:
        lines.append("Supporting: " + " ".join(f"{e['source']}: {e['text']}" for e in sup))
    if opp:
        lines.append("Contradicting: " + " ".join(f"{e['source']}: {e['text']}" for e in opp))
    pl = p["plan"]
    lines.append(f"A {d} plan would enter around {pl['entry_low']:.2f}–{pl['entry_high']:.2f}, stop {pl['stop']:.2f}, "
                 f"targets {', '.join(f'{t:.2f}' for t in pl['targets'])}. {pl['invalidation']}")
    lines.append("Main risks: " + " ".join(p["risks"][:3]))
    lines.append("This is a statistical estimate, not a prediction of what will happen.")
    return "\n\n".join(lines)


def jsonable(o):
    if isinstance(o, dict):
        return {k: jsonable(v) for k, v in o.items()}
    if isinstance(o, (list, tuple)):
        return [jsonable(v) for v in o]
    if isinstance(o, (np.floating,)):
        o = float(o)
    if isinstance(o, float):
        return o if math.isfinite(o) else None
    if isinstance(o, (np.integer,)):
        return int(o)
    if isinstance(o, (np.bool_,)):
        return bool(o)
    if isinstance(o, (datetime, pd.Timestamp)):
        return o.isoformat()
    return o
