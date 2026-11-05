"""SQLite persistence (SQLAlchemy 2.x)."""
from __future__ import annotations

from contextlib import contextmanager
from datetime import datetime, timezone

from sqlalchemy import (
    JSON, Boolean, DateTime, Float, ForeignKey, Index, Integer, String, Text,
    UniqueConstraint, create_engine, event,
)
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, sessionmaker

from . import config


def utcnow() -> datetime:
    from . import clock
    return clock.now()


class Base(DeclarativeBase):
    pass


class Setting(Base):
    __tablename__ = "settings"
    key: Mapped[str] = mapped_column(String(64), primary_key=True)
    value: Mapped[dict] = mapped_column(JSON, default=dict)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, onupdate=utcnow)


class BarCache(Base):
    """Cached OHLCV bars. One row per (symbol, timeframe, ts, source)."""
    __tablename__ = "bars"
    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    symbol: Mapped[str] = mapped_column(String(16))
    timeframe: Mapped[str] = mapped_column(String(8))
    ts: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    open: Mapped[float] = mapped_column(Float)
    high: Mapped[float] = mapped_column(Float)
    low: Mapped[float] = mapped_column(Float)
    close: Mapped[float] = mapped_column(Float)
    volume: Mapped[float] = mapped_column(Float)
    source: Mapped[str] = mapped_column(String(16))
    fetched_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    __table_args__ = (
        UniqueConstraint("symbol", "timeframe", "ts", "source", name="uq_bar"),
        Index("ix_bar_lookup", "source", "symbol", "timeframe", "ts"),
    )


class Watchlist(Base):
    __tablename__ = "watchlists"
    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    name: Mapped[str] = mapped_column(String(80))
    symbols: Mapped[list] = mapped_column(JSON, default=list)
    sort_order: Mapped[int] = mapped_column(Integer, default=0)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class ModelRun(Base):
    __tablename__ = "model_runs"
    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    finished_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    status: Mapped[str] = mapped_column(String(16), default="running")  # running|done|failed
    source: Mapped[str] = mapped_column(String(16))
    config: Mapped[dict] = mapped_column(JSON, default=dict)
    metrics: Mapped[dict] = mapped_column(JSON, default=dict)
    champion: Mapped[str | None] = mapped_column(String(32), nullable=True)
    passed_validation: Mapped[bool] = mapped_column(Boolean, default=False)
    is_active: Mapped[bool] = mapped_column(Boolean, default=False)
    artifact_path: Mapped[str | None] = mapped_column(String(255), nullable=True)
    error: Mapped[str | None] = mapped_column(Text, nullable=True)
    progress: Mapped[float] = mapped_column(Float, default=0.0)
    message: Mapped[str] = mapped_column(String(255), default="")


class Prediction(Base):
    __tablename__ = "predictions"
    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    symbol: Mapped[str] = mapped_column(String(16), index=True)
    asof: Mapped[datetime] = mapped_column(DateTime(timezone=True))     # bar timestamp the forecast used
    horizon_days: Mapped[int] = mapped_column(Integer)
    model_run_id: Mapped[int | None] = mapped_column(Integer, nullable=True)
    model_name: Mapped[str] = mapped_column(String(32))
    source: Mapped[str] = mapped_column(String(16))
    price: Mapped[float] = mapped_column(Float)
    p_up: Mapped[float] = mapped_column(Float)
    p_target_first: Mapped[float] = mapped_column(Float)
    exp_return: Mapped[float] = mapped_column(Float)
    q10: Mapped[float] = mapped_column(Float)
    q90: Mapped[float] = mapped_column(Float)
    target_price: Mapped[float] = mapped_column(Float)
    stop_price: Mapped[float] = mapped_column(Float)
    # outcome (filled when horizon elapses)
    resolved: Mapped[bool] = mapped_column(Boolean, default=False)
    realized_return: Mapped[float | None] = mapped_column(Float, nullable=True)
    hit: Mapped[str | None] = mapped_column(String(8), nullable=True)  # target|stop|timeout
    __table_args__ = (UniqueConstraint("symbol", "asof", "horizon_days", "model_run_id", "source", name="uq_pred"),)


class BacktestRun(Base):
    __tablename__ = "backtests"
    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    name: Mapped[str] = mapped_column(String(120))
    status: Mapped[str] = mapped_column(String(16), default="running")
    source: Mapped[str] = mapped_column(String(16))
    config: Mapped[dict] = mapped_column(JSON, default=dict)
    metrics: Mapped[dict] = mapped_column(JSON, default=dict)
    equity: Mapped[list] = mapped_column(JSON, default=list)
    trades: Mapped[list] = mapped_column(JSON, default=list)
    error: Mapped[str | None] = mapped_column(Text, nullable=True)
    progress: Mapped[float] = mapped_column(Float, default=0.0)


class PaperAccount(Base):
    __tablename__ = "paper_accounts"
    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    starting_cash: Mapped[float] = mapped_column(Float)
    cash: Mapped[float] = mapped_column(Float)
    realized_pnl: Mapped[float] = mapped_column(Float, default=0.0)
    peak_equity: Mapped[float] = mapped_column(Float)
    day_start_equity: Mapped[float] = mapped_column(Float)
    day_key: Mapped[str] = mapped_column(String(10), default="")
    halted_reason: Mapped[str | None] = mapped_column(String(255), nullable=True)


class PaperOrder(Base):
    __tablename__ = "paper_orders"
    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    account_id: Mapped[int] = mapped_column(ForeignKey("paper_accounts.id"))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    client_order_id: Mapped[str] = mapped_column(String(64), unique=True)  # duplicate-order protection
    symbol: Mapped[str] = mapped_column(String(16))
    side: Mapped[str] = mapped_column(String(4))           # buy|sell
    qty: Mapped[float] = mapped_column(Float)
    order_type: Mapped[str] = mapped_column(String(8))     # market|limit|stop
    limit_price: Mapped[float | None] = mapped_column(Float, nullable=True)
    stop_price: Mapped[float | None] = mapped_column(Float, nullable=True)
    status: Mapped[str] = mapped_column(String(12), default="open")  # open|filled|cancelled|rejected
    filled_price: Mapped[float | None] = mapped_column(Float, nullable=True)
    filled_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    parent_id: Mapped[int | None] = mapped_column(Integer, nullable=True)  # bracket legs
    oco_group: Mapped[str | None] = mapped_column(String(64), nullable=True)
    bracket_stop: Mapped[float | None] = mapped_column(Float, nullable=True)     # child stop-loss created on fill
    bracket_target: Mapped[float | None] = mapped_column(Float, nullable=True)   # child take-profit created on fill
    commission: Mapped[float] = mapped_column(Float, default=0.0)
    note: Mapped[str] = mapped_column(String(255), default="")
    data_status: Mapped[str] = mapped_column(String(12), default="")


class PaperPosition(Base):
    __tablename__ = "paper_positions"
    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    account_id: Mapped[int] = mapped_column(ForeignKey("paper_accounts.id"))
    symbol: Mapped[str] = mapped_column(String(16))
    qty: Mapped[float] = mapped_column(Float)                # negative = short
    avg_price: Mapped[float] = mapped_column(Float)
    opened_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    __table_args__ = (UniqueConstraint("account_id", "symbol", name="uq_pos"),)


class PaperFill(Base):
    __tablename__ = "paper_fills"
    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    account_id: Mapped[int] = mapped_column(ForeignKey("paper_accounts.id"))
    order_id: Mapped[int] = mapped_column(Integer)
    ts: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    symbol: Mapped[str] = mapped_column(String(16))
    side: Mapped[str] = mapped_column(String(4))
    qty: Mapped[float] = mapped_column(Float)
    price: Mapped[float] = mapped_column(Float)
    commission: Mapped[float] = mapped_column(Float, default=0.0)
    realized_pnl: Mapped[float] = mapped_column(Float, default=0.0)


class CashTransfer(Base):
    """Deposits and withdrawals into the paper account (play money)."""
    __tablename__ = "cash_transfers"
    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    account_id: Mapped[int] = mapped_column(Integer)
    ts: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    kind: Mapped[str] = mapped_column(String(12))          # deposit | withdrawal
    amount: Mapped[float] = mapped_column(Float)
    sandbox: Mapped[bool] = mapped_column(Boolean, default=True)
    note: Mapped[str] = mapped_column(String(255), default="")


class AutopilotEvent(Base):
    """Every decision the autopilot makes, including the trades it decided not to take."""
    __tablename__ = "autopilot_events"
    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    ts: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    kind: Mapped[str] = mapped_column(String(16))          # buy | sell | skip | proposal | info | error
    symbol: Mapped[str | None] = mapped_column(String(16), nullable=True)
    qty: Mapped[float | None] = mapped_column(Float, nullable=True)
    price: Mapped[float | None] = mapped_column(Float, nullable=True)
    reason: Mapped[str] = mapped_column(Text, default="")
    order_id: Mapped[int | None] = mapped_column(Integer, nullable=True)
    status: Mapped[str] = mapped_column(String(12), default="done")   # done | pending | approved | rejected | expired
    payload: Mapped[dict] = mapped_column(JSON, default=dict)


class TurboRun(Base):
    __tablename__ = "turbo_runs"
    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    status: Mapped[str] = mapped_column(String(16), default="running")
    config: Mapped[dict] = mapped_column(JSON, default=dict)
    result: Mapped[dict] = mapped_column(JSON, default=dict)
    progress: Mapped[float] = mapped_column(Float, default=0.0)
    error: Mapped[str | None] = mapped_column(Text, nullable=True)


class EquitySnapshot(Base):
    __tablename__ = "equity_snapshots"
    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    account_id: Mapped[int] = mapped_column(Integer)
    ts: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    equity: Mapped[float] = mapped_column(Float)
    cash: Mapped[float] = mapped_column(Float)


class Alert(Base):
    __tablename__ = "alerts"
    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    name: Mapped[str] = mapped_column(String(120))
    kind: Mapped[str] = mapped_column(String(24))  # price_above|price_below|pct_change|scanner_hit|prob_above|stale_data
    symbol: Mapped[str | None] = mapped_column(String(16), nullable=True)
    threshold: Mapped[float | None] = mapped_column(Float, nullable=True)
    enabled: Mapped[bool] = mapped_column(Boolean, default=True)
    cooldown_minutes: Mapped[int] = mapped_column(Integer, default=60)
    last_fired_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)


class AlertEvent(Base):
    __tablename__ = "alert_events"
    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    alert_id: Mapped[int | None] = mapped_column(Integer, nullable=True)
    ts: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    level: Mapped[str] = mapped_column(String(8), default="info")  # info|warn|error
    title: Mapped[str] = mapped_column(String(160))
    body: Mapped[str] = mapped_column(Text, default="")
    symbol: Mapped[str | None] = mapped_column(String(16), nullable=True)
    read: Mapped[bool] = mapped_column(Boolean, default=False)


class Dashboard(Base):
    __tablename__ = "dashboards"
    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    name: Mapped[str] = mapped_column(String(80))
    layout: Mapped[list] = mapped_column(JSON, default=list)   # [{i, widget, x, y, w, h, config}]
    is_default: Mapped[bool] = mapped_column(Boolean, default=False)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, onupdate=utcnow)


class Theme(Base):
    __tablename__ = "themes"
    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    name: Mapped[str] = mapped_column(String(80))
    base: Mapped[str] = mapped_column(String(32))
    tokens: Mapped[dict] = mapped_column(JSON, default=dict)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, onupdate=utcnow)


class NewsItem(Base):
    __tablename__ = "news"
    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    ext_id: Mapped[str] = mapped_column(String(128))
    source: Mapped[str] = mapped_column(String(16))
    ts: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    headline: Mapped[str] = mapped_column(String(500))
    summary: Mapped[str] = mapped_column(Text, default="")
    url: Mapped[str] = mapped_column(String(500), default="")
    publisher: Mapped[str] = mapped_column(String(120), default="")
    symbols: Mapped[list] = mapped_column(JSON, default=list)
    sentiment: Mapped[float] = mapped_column(Float, default=0.0)
    sentiment_terms: Mapped[list] = mapped_column(JSON, default=list)
    __table_args__ = (UniqueConstraint("source", "ext_id", name="uq_news"),)


engine = create_engine(config.DB_URL, connect_args={"check_same_thread": False, "timeout": 30})


@event.listens_for(engine, "connect")
def _sqlite_pragmas(dbapi_conn, _):
    cur = dbapi_conn.cursor()
    cur.execute("PRAGMA journal_mode=WAL")
    cur.execute("PRAGMA synchronous=NORMAL")
    cur.execute("PRAGMA foreign_keys=ON")
    cur.close()


SessionLocal = sessionmaker(bind=engine, expire_on_commit=False)

# ---- Sandbox replay isolation -------------------------------------------------------------
# While a historical replay runs, everything that belongs to "the trading account and its model"
# lives in a separate SQLite file, so replayed (past-dated) trades never mix with your normal
# paper account. Settings, watchlists, cached bars, themes and dashboards stay shared.
_replay_engine = None


def _replay_models() -> tuple:
    return (ModelRun, Prediction, PaperAccount, PaperOrder, PaperPosition, PaperFill, CashTransfer,
            AutopilotEvent, EquitySnapshot)


def use_replay_db(path: str | None, fresh: bool = False) -> None:
    """Route account/model tables to ``path`` (or back to the main database when None)."""
    global _replay_engine
    if path is None:
        if _replay_engine is not None:
            _replay_engine.dispose()
        _replay_engine = None
        return
    eng = create_engine(f"sqlite:///{path}", connect_args={"check_same_thread": False, "timeout": 30})
    event.listen(eng, "connect", _sqlite_pragmas)
    tables = [m.__table__ for m in _replay_models()]
    if fresh:
        Base.metadata.drop_all(eng, tables=tables)
    Base.metadata.create_all(eng, tables=tables)
    _replay_engine = eng


def replay_db_active() -> bool:
    return _replay_engine is not None


def _new_session():
    if _replay_engine is None:
        return SessionLocal()
    from sqlalchemy.orm import Session
    return Session(bind=engine, binds={m: _replay_engine for m in _replay_models()}, expire_on_commit=False)


def init_db() -> None:
    Base.metadata.create_all(engine)


@contextmanager
def session_scope():
    s = _new_session()
    try:
        yield s
        s.commit()
    except Exception:
        s.rollback()
        raise
    finally:
        s.close()


def get_session():
    """FastAPI dependency."""
    s = _new_session()
    try:
        yield s
    finally:
        s.close()


def as_utc(dt: datetime | None) -> datetime | None:
    """SQLite drops tzinfo; normalise everything we read back to UTC-aware."""
    if dt is None:
        return None
    return dt.replace(tzinfo=timezone.utc) if dt.tzinfo is None else dt.astimezone(timezone.utc)
