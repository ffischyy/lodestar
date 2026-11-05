"""News ingestion, de-duplication, sentiment scoring and querying."""
from __future__ import annotations

import logging
from datetime import datetime, timedelta, timezone

from sqlalchemy import select
from sqlalchemy.dialects.sqlite import insert as sqlite_insert

from .analytics.sentiment import score
from .db import NewsItem, as_utc, session_scope
from .providers.manager import data

log = logging.getLogger("lodestar.news")


def refresh(symbols: list[str], limit: int = 50) -> int:
    p = data.provider()
    arts = data.news(symbols, limit)
    if not arts:
        return 0
    rows = []
    seen = set()
    for a in arts:
        key = (p.name, a.ext_id)
        if key in seen:
            continue
        seen.add(key)
        s, terms = score(f"{a.headline}. {a.summary if not a.simulated else ''}")
        rows.append({"ext_id": a.ext_id[:128], "source": p.name, "ts": a.ts.astimezone(timezone.utc).replace(tzinfo=None),
                     "headline": a.headline[:500], "summary": (a.summary or "")[:4000], "url": (a.url or "")[:500],
                     "publisher": (a.publisher or "")[:120], "symbols": a.symbols, "sentiment": s, "sentiment_terms": terms})
    with session_scope() as s:
        stmt = sqlite_insert(NewsItem).values(rows).on_conflict_do_nothing(index_elements=["source", "ext_id"])
        res = s.execute(stmt)
    return res.rowcount or 0


def query(symbol: str | None = None, days: int = 7, limit: int = 200, sentiment: str | None = None) -> list[dict]:
    src = data.provider().name
    since = (datetime.now(timezone.utc) - timedelta(days=days)).replace(tzinfo=None)
    with session_scope() as s:
        q = select(NewsItem).where(NewsItem.source == src, NewsItem.ts >= since).order_by(NewsItem.ts.desc()).limit(2000)
        rows = s.execute(q).scalars().all()
    out = []
    for r in rows:
        if symbol and symbol.upper() not in (r.symbols or []):
            continue
        if sentiment == "positive" and r.sentiment <= 0.05:
            continue
        if sentiment == "negative" and r.sentiment >= -0.05:
            continue
        if sentiment == "neutral" and abs(r.sentiment) > 0.05:
            continue
        out.append({"id": r.id, "ts": as_utc(r.ts), "headline": r.headline, "summary": r.summary, "url": r.url,
                    "publisher": r.publisher, "symbols": r.symbols, "sentiment": r.sentiment, "terms": r.sentiment_terms,
                    "simulated": src == "simulation"})
        if len(out) >= limit:
            break
    return out


def serialize(items: list[dict]) -> list[dict]:
    return [{**i, "ts": i["ts"].isoformat()} for i in items]


def summary_by_symbol(days: int = 7) -> list[dict]:
    agg: dict[str, dict] = {}
    for it in query(days=days, limit=2000):
        for s in it["symbols"]:
            a = agg.setdefault(s, {"symbol": s, "articles": 0, "sum": 0.0, "pos": 0, "neg": 0, "latest": it["ts"]})
            a["articles"] += 1
            a["sum"] += it["sentiment"]
            a["pos"] += it["sentiment"] > 0.05
            a["neg"] += it["sentiment"] < -0.05
    out = []
    for a in agg.values():
        out.append({"symbol": a["symbol"], "articles": a["articles"], "avg_sentiment": a["sum"] / a["articles"],
                    "positive": a["pos"], "negative": a["neg"], "latest": a["latest"].isoformat()})
    return sorted(out, key=lambda x: -x["articles"])
