"""Market data, overview, research, scanner, news and predictions endpoints."""
from __future__ import annotations

import re
import threading
import time

import numpy as np
from fastapi import APIRouter, HTTPException, Query
from sqlalchemy import func, select

from .. import analysis, llm, news, scanner
from .. import universe as U
from ..analytics import indicators as ind
from ..db import Prediction, as_utc, session_scope
from ..ml.engine import completed_bars, predictor
from ..providers.base import ProviderError
from ..providers.manager import data
from ..settings_store import get_settings

router = APIRouter(prefix="/api")
SYM = re.compile(r"^[A-Z][A-Z0-9.\-]{0,9}$")


def _sym(s: str) -> str:
    s = s.upper().strip()
    if not SYM.match(s):
        raise HTTPException(400, f"Invalid symbol '{s}'")
    return s


def _provider_error(e: Exception):
    raise HTTPException(502, f"Data provider error: {e}")


@router.get("/market/quotes")
def quotes(symbols: str):
    syms = [_sym(s) for s in symbols.split(",") if s.strip()][:200]
    try:
        return {s: q.to_dict() for s, q in data.quotes(syms).items()}
    except ProviderError as e:
        _provider_error(e)


@router.get("/market/bars/{symbol}")
def bars(symbol: str, tf: str = "1D", days: int | None = None, indicators: str = ""):
    symbol = _sym(symbol)
    if tf not in ("1D", "1H", "15Min", "5Min", "1Min"):
        raise HTTPException(400, "tf must be 1D, 1H, 15Min, 5Min or 1Min")
    default_days = {"1D": 365 * 5, "1H": 120, "15Min": 30, "5Min": 10, "1Min": 3}[tf]
    try:
        df, meta = data.bars(symbol, tf, days or default_days)
    except ProviderError as e:
        _provider_error(e)
    if df.empty:
        raise HTTPException(404, f"No bars for {symbol}")
    t = ind.unix_seconds(df.index)
    candles = [{"time": ti, "open": round(r.open, 4), "high": round(r.high, 4), "low": round(r.low, 4), "close": round(r.close, 4),
                "volume": float(r.volume)} for ti, r in zip(t, df.itertuples())]
    names = [n for n in indicators.split(",") if n]
    return {"symbol": symbol, "timeframe": tf, "meta": meta, "candles": candles, "indicators": ind.compute(df, names)}


@router.get("/market/search")
def search(q: str = "", limit: int = 25):
    q = q.upper().strip()
    st = get_settings()
    pool = {s: U.meta(s) for s in list(U.universe(st)) + list(U.INDEXES) + list(U.SECTOR_ETFS)}
    out = [{"symbol": s, "name": m[0], "sector": m[1]} for s, m in pool.items() if q in s or q.lower() in m[0].lower()]
    out.sort(key=lambda x: (not x["symbol"].startswith(q), x["symbol"]))
    if q and SYM.match(q) and q not in pool:
        out.append({"symbol": q, "name": "Look up symbol", "sector": "—"})
    return out[:max(1, min(limit, 1000))]


@router.get("/market/overview")
def overview():
    st = get_settings()
    uni = U.universe(st)
    try:
        qs = data.quotes(list(U.INDEXES) + list(U.SECTOR_ETFS) + uni)
    except ProviderError as e:
        _provider_error(e)

    def spark(s, n=40):
        try:
            c = data.bars(s)[0]["close"].tail(n)
            return [round(float(x), 4) for x in c]
        except Exception:
            return []

    indexes = [{"symbol": s, "name": n, "quote": qs[s].to_dict() if s in qs else None, "spark": spark(s)} for s, n in U.INDEXES.items()]
    ctx = analysis.market_context()
    sectors = []
    for etf, name in U.SECTOR_ETFS.items():
        q = qs.get(etf)
        sx = ctx["sectors"].get(name, {})
        sectors.append({"symbol": etf, "sector": name, "change_pct": q.change_pct if q else None, "ret_1m": sx.get("ret_1m"),
                        "ret_3m": sx.get("ret_3m"), "status": q.status.value if q else None})
    rows = []
    for s in uni:
        q = qs.get(s)
        if q and q.change_pct is not None:
            rows.append({"symbol": s, "name": U.meta(s)[0], "sector": U.sector_of(s), "price": q.price, "change_pct": q.change_pct,
                         "volume": q.volume, "status": q.status.value})
    rows.sort(key=lambda r: r["change_pct"])
    adv = sum(1 for r in rows if r["change_pct"] > 0)
    dec = sum(1 for r in rows if r["change_pct"] < 0)
    last = scanner.last_result() or {}
    return analysis.jsonable({
        "indexes": indexes, "sectors": sectors, "gainers": rows[::-1][:6], "losers": rows[:6],
        "breadth": {"advancers": adv, "decliners": dec, "unchanged": len(rows) - adv - dec,
                    "above_50d": ctx["regime"]["values"].get("breadth_above_50d")},
        "regime": ctx["regime"], "top_opportunities": (last.get("candidates") or [])[:5], "scanned_at": last.get("scanned_at"),
        "news": news.serialize(news.query(days=3, limit=8)), "status": data.status(), "model": predictor.info(),
    })


_snapshot_cache: tuple[float, list, list] = (0.0, [], [])


@router.get("/market/snapshot")
def snapshot():
    """One row per universe stock for the market map, screener and calendar. Cached 30 s: it reads every symbol's bars."""
    global _snapshot_cache
    uni = U.universe(get_settings())
    if time.time() - _snapshot_cache[0] < 30 and _snapshot_cache[1] == uni:
        return _snapshot_cache[2]
    try:
        qs = data.quotes(uni)
    except ProviderError as e:
        _provider_error(e)
    rows = []
    for s in uni:
        try:
            df = data.bars(s)[0]
        except ProviderError:
            continue
        if len(df) < 30:
            continue
        rows.append(_snapshot_row(s, df, qs.get(s)))
    _snapshot_cache = (time.time(), uni, analysis.jsonable(rows))
    return _snapshot_cache[2]


def _snapshot_row(symbol: str, df, q) -> dict:
    close, high, low = df["close"], df["high"], df["low"]
    px = q.price if q else float(close.iloc[-1])
    delta = close.diff()
    gain = delta.clip(lower=0).ewm(alpha=1 / 14, adjust=False).mean().iloc[-1]
    loss = (-delta.clip(upper=0)).ewm(alpha=1 / 14, adjust=False).mean().iloc[-1]
    tr = (high - low).combine((high - close.shift()).abs(), max).combine((low - close.shift()).abs(), max)
    year_high, year_low = float(high.tail(252).max()), float(low.tail(252).min())
    avg_vol = float(df["volume"].iloc[-21:-1].mean())
    p = data.profile(symbol)

    def ret(n):
        return px / float(close.iloc[-1 - n]) - 1 if len(close) > n else None

    def dist(n):
        return px / float(close.tail(n).mean()) - 1 if len(close) >= n else None

    return {"symbol": symbol, "name": U.meta(symbol)[0], "sector": U.sector_of(symbol), "price": px,
            "change_pct": q.change_pct if q else None, "volume": q.volume if q else None, "avg_volume": avg_vol,
            "rel_volume": q.volume / avg_vol if q and q.volume and avg_vol else None, "avg_dollar_volume": avg_vol * px,
            "market_cap": p.market_cap if p else None, "pe_ratio": p.pe_ratio if p else None,
            "dividend_yield": p.dividend_yield if p else None, "beta": p.beta if p else None,
            "next_earnings": p.next_earnings if p else None, "rsi14": 100.0 if loss == 0 else 100 - 100 / (1 + gain / loss),
            "atr_pct": float(tr.ewm(alpha=1 / 14, adjust=False).mean().iloc[-1]) / px * 100, "ret_5d": ret(5), "ret_1m": ret(21),
            "ret_3m": ret(63), "ret_1y": ret(252), "dist_sma50": dist(50), "dist_sma200": dist(200),
            "dist_52w_high": px / year_high - 1, "dist_52w_low": px / year_low - 1,
            "status": q.status.value if q else "unavailable"}


@router.get("/research/{symbol}")
def research(symbol: str):
    symbol = _sym(symbol)
    try:
        r = analysis.research(symbol)
    except ProviderError as e:
        _provider_error(e)
    except ValueError as e:
        raise HTTPException(404, str(e))
    with session_scope() as s:
        rows = s.execute(select(Prediction).where(Prediction.symbol == symbol, Prediction.source == data.provider().name)
                         .order_by(Prediction.asof.desc()).limit(60)).scalars().all()
        r["prediction_history"] = [_pred(p) for p in rows]
    r["narrative"] = analysis.narrative(r)
    r["llm_available"] = llm.available()
    return analysis.jsonable(r)


@router.post("/research/{symbol}/narrative")
def narrative(symbol: str, direction: str = "long", use_llm: bool = False):
    symbol = _sym(symbol)
    r = analysis.research(symbol)
    if direction not in ("long", "short"):
        raise HTTPException(400, "direction must be long or short")
    if use_llm:
        if not llm.available():
            raise HTTPException(400, "AI narratives are off. Enable them and add an Anthropic API key in Settings → Data providers.")
        try:
            return {"kind": "llm", "label": "AI-written narrative (Claude) — generated only from the data shown",
                    "text": llm.narrate(analysis.jsonable(r), direction)}
        except Exception as e:
            raise HTTPException(502, str(e))
    return {"kind": "rules", "label": "Rule-generated summary — deterministic template over the computed signals",
            "text": analysis.narrative(r, direction)}


# --------------------------------------------------------------- scanner
_scan_thread: list[threading.Thread | None] = [None]


@router.get("/scanner")
def scan_result():
    r = scanner.last_result()
    return {"running": scanner.is_running(), "result": r, "has_model": predictor.info() is not None}


@router.post("/scanner/run")
def scan_now():
    if scanner.is_running():
        return {"started": False, "message": "A scan is already running"}
    t = threading.Thread(target=scanner.run_scan, daemon=True)
    t.start()
    _scan_thread[0] = t
    return {"started": True}


# --------------------------------------------------------------- news
@router.get("/news")
def news_list(symbol: str | None = None, sentiment: str | None = None, days: int = 7, limit: int = 100):
    return news.serialize(news.query(_sym(symbol) if symbol else None, days=days, limit=limit, sentiment=sentiment))


@router.get("/news/summary")
def news_summary(days: int = 7):
    return news.summary_by_symbol(days)


@router.post("/news/refresh")
def news_refresh():
    try:
        return {"new": news.refresh(U.universe(get_settings()), 50)}
    except ProviderError as e:
        _provider_error(e)


# --------------------------------------------------------------- predictions
def _pred(p: Prediction) -> dict:
    return {"id": p.id, "symbol": p.symbol, "asof": as_utc(p.asof).isoformat(), "created_at": as_utc(p.created_at).isoformat(),
            "horizon_days": p.horizon_days, "model": p.model_name, "model_run_id": p.model_run_id, "price": p.price, "p_up": p.p_up,
            "p_target_first": p.p_target_first, "exp_return": p.exp_return, "q10": p.q10, "q90": p.q90,
            "target_price": p.target_price, "stop_price": p.stop_price, "resolved": p.resolved,
            "realized_return": p.realized_return, "hit": p.hit, "source": p.source}


@router.get("/predictions")
def predictions(symbol: str | None = None, resolved: bool | None = None, limit: int = Query(300, le=2000)):
    with session_scope() as s:
        q = select(Prediction).where(Prediction.source == data.provider().name)
        if symbol:
            q = q.where(Prediction.symbol == _sym(symbol))
        if resolved is not None:
            q = q.where(Prediction.resolved.is_(resolved))
        rows = s.execute(q.order_by(Prediction.asof.desc(), Prediction.symbol).limit(limit)).scalars().all()
        total = s.execute(select(func.count()).select_from(Prediction).where(Prediction.source == data.provider().name)).scalar()
        return {"total": total, "items": [_pred(p) for p in rows]}


@router.get("/predictions/calibration")
def prediction_calibration():
    """Calibration of *logged live* predictions once their horizon has elapsed."""
    with session_scope() as s:
        rows = s.execute(select(Prediction).where(Prediction.resolved.is_(True), Prediction.source == data.provider().name)).scalars().all()
    if not rows:
        return {"n": 0, "bins": [], "message": "No predictions have reached their horizon yet."}
    p = np.array([r.p_target_first for r in rows])
    y = np.array([1.0 if r.hit == "target" else 0.0 for r in rows])
    pu = np.array([r.p_up for r in rows])
    yu = np.array([1.0 if (r.realized_return or 0) > 0 else 0.0 for r in rows])
    from ..ml.evaluation import reliability
    rel = reliability(y, p, n_bins=min(10, max(2, len(rows) // 20)))
    relu = reliability(yu, pu, n_bins=min(10, max(2, len(rows) // 20)))
    return {"n": len(rows), "target_first": {"ece": rel["ece"], "bins": rel["bins"], "hit_rate": float(y.mean()), "mean_prob": float(p.mean())},
            "positive_return": {"ece": relu["ece"], "bins": relu["bins"], "hit_rate": float(yu.mean()), "mean_prob": float(pu.mean())},
            "brier_target_first": float(np.mean((p - y) ** 2))}
