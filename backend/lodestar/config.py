"""Configuration.

Two layers:
  * Secrets and machine paths come from environment variables / the ``.env`` file
    (never from the database, never returned unmasked over the API).
  * User preferences (risk limits, costs, scanner weights, ...) live in the SQLite
    ``settings`` table and are merged over ``DEFAULT_SETTINGS`` at read time.
"""
from __future__ import annotations

import copy
import os
from pathlib import Path

from dotenv import load_dotenv, set_key

BACKEND_DIR = Path(__file__).resolve().parent.parent
PROJECT_DIR = BACKEND_DIR.parent
ENV_FILE = Path(os.environ.get("LODESTAR_ENV_FILE", PROJECT_DIR / ".env"))
load_dotenv(ENV_FILE, override=False)

DATA_DIR = Path(os.environ.get("LODESTAR_DATA_DIR", PROJECT_DIR / "data"))
MODELS_DIR = DATA_DIR / "models"
LOG_DIR = DATA_DIR / "logs"
for _d in (DATA_DIR, MODELS_DIR, LOG_DIR):
    _d.mkdir(parents=True, exist_ok=True)

DB_URL = os.environ.get("LODESTAR_DB_URL", f"sqlite:///{(DATA_DIR / 'lodestar.db').as_posix()}")
HOST = os.environ.get("LODESTAR_HOST", "127.0.0.1")
PORT = int(os.environ.get("LODESTAR_PORT", "8765"))
FRONTEND_DIST = Path(os.environ.get("LODESTAR_FRONTEND_DIST", PROJECT_DIR / "frontend" / "dist"))
# For running the engine behind a separately hosted site. Leave both empty on your own computer.
CORS_ORIGINS = [o.strip() for o in os.environ.get("LODESTAR_CORS_ORIGINS", "").split(",") if o.strip()]
API_TOKEN = os.environ.get("LODESTAR_API_TOKEN", "").strip()

SECRET_KEYS = (
    "ALPACA_API_KEY_ID",
    "ALPACA_API_SECRET_KEY",
    "ANTHROPIC_API_KEY",
)


def get_secret(name: str) -> str | None:
    val = os.environ.get(name)
    return val.strip() if val and val.strip() else None


def set_secret(name: str, value: str | None) -> None:
    """Persist a secret to the local .env file and the current process."""
    if name not in SECRET_KEYS:
        raise KeyError(name)
    if not ENV_FILE.exists():
        ENV_FILE.touch()
    set_key(str(ENV_FILE), name, value or "", quote_mode="never")
    if value:
        os.environ[name] = value
    else:
        os.environ.pop(name, None)


def mask(value: str | None) -> str | None:
    if not value:
        return None
    return value[:3] + "…" + value[-2:] if len(value) > 8 else "•" * len(value)


DEFAULT_SETTINGS: dict = {
    "general": {
        "base_currency": "USD",
        "fx_rate_to_base": 1.0,          # price currency (USD) -> base currency, user supplied
        "timezone": "America/New_York",
        "allow_short": False,             # shorting is riskier; enable in Settings
    },
    "data": {
        "provider": "simulation",       # simulation | alpaca | yahoo
        "alpaca_feed": "iex",           # iex (free, real-time, single venue) | sip (paid)
        "quote_poll_seconds": 5,
        "stale_quote_seconds": 120,      # live/delayed quotes older than this are treated as stale
        "history_years": 5,
    },
    "universe": {
        "symbols": [],                   # empty -> built-in default universe
    },
    "costs": {
        "commission_per_share": 0.0,
        "min_commission": 0.0,
        "default_spread_bps": 3.0,       # used when no bid/ask is available
        "slippage_bps": 5.0,
    },
    "risk": {
        "account_equity_override": None,  # None -> use paper account equity
        "risk_per_trade_pct": 0.75,       # % of equity lost if stop is hit (before gaps)
        "max_position_pct": 15.0,         # % of equity in one position
        "max_gross_exposure_pct": 100.0,  # sum of |position value| / equity
        "max_sector_pct": 35.0,
        "max_correlation": 0.80,          # with any existing position (60d returns)
        "max_daily_loss_pct": 2.0,
        "max_drawdown_pct": 15.0,
        "stop_atr_mult": 1.5,
        "target_r_multiples": [1.5, 2.5],
    },
    "scanner": {
        "interval_minutes": 15,
        "horizon_days": 10,
        "min_price": 5.0,
        "min_avg_dollar_volume": 20_000_000,
        "max_spread_bps": 25.0,
        "min_prob_edge": 0.03,            # calibrated P(target before stop) minus break-even probability
        "min_net_expected_return_pct": 0.25,
        "max_uncertainty_pct": 20.0,      # q90 - q10 width of the forecast return interval
        "min_model_reliability": 0.35,
        "stale_after_minutes": 30,
        "event_blackout_days": 2,
        "weights": {
            "net_expected_return": 0.20,
            "prob_edge": 0.20,
            "reward_risk": 0.10,
            "model_reliability": 0.15,
            "signal_agreement": 0.15,
            "liquidity": 0.08,
            "regime_fit": 0.07,
            "data_quality": 0.05,
        },
    },
    "model": {
        "horizon_days": 10,
        "barrier_target_atr": 2.0,
        "barrier_stop_atr": 1.5,
        "retrain_days": 7,
        "min_train_rows": 3000,
        # prediction methods to train and compare (base rate is always included as the bar to beat)
        "methods": ["logistic", "gbm", "forest", "knn", "factor", "ensemble"],
        "selection": "auto",              # auto = best validated method; or force one of the methods above
    },
    "strategies": {
        "momentum": {"enabled": True, "params": {"top_pct": 0.2, "lookback": 126}},
        "mean_reversion": {"enabled": True, "params": {"rsi2_entry": 10, "rsi2_exit": 70}},
        "trend": {"enabled": True, "params": {"adx_min": 25}},
        "breakout": {"enabled": True, "params": {"channel": 20, "volume_mult": 1.5}},
        "ml_forecast": {"enabled": True, "params": {"min_prob_edge": 0.03}},
    },
    "paper": {
        "starting_cash": 100_000.0,
        "trading_enabled": True,          # kill switch for the paper engine
        "sandbox": True,                  # play-money mode: deposits of any amount allowed
        "max_sandbox_deposit": 1_000_000_000.0,
    },
    "autopilot": {
        "enabled": False,                 # master switch: the AI may place paper trades by itself
        "mode": "auto",                   # auto = trades immediately | approve = proposes, you confirm
        "schedule": "auto",               # auto (market hours on real data, always on simulated) | market_hours | always | custom
        "custom_start": "09:45",          # ET, used when schedule == custom
        "custom_end": "15:45",
        "days": [0, 1, 2, 3, 4],          # Mon..Fri
        "interval_seconds": 60,
        "min_score": 60.0,
        "max_trades_per_day": 10,
        "max_open_positions": 5,
        "max_position_pct": 10.0,         # of equity, never above the global risk limit
        "max_capital_pct": 50.0,          # total equity the autopilot may have invested
        "allow_short": False,
        "use_brackets": True,             # attach stop-loss + take-profit to every entry
        "exit_on_signal_flip": True,      # sell when the forecast turns against the position
        "max_hold_days": 10,
        "symbols_mode": "universe",       # universe | watchlist
        "watchlist_id": None,
        "stop_on_daily_loss_pct": 2.0,    # pause itself after this loss today
        "proposal_ttl_minutes": 30,
        "rotate_for_better": True,        # when full, swap the weakest AI position for a clearly better idea
        "rotate_margin": 15.0,            # ...only if the new idea scores at least this many points higher
        "pause_until": None,              # ISO time: hold off until then (switch stays on)
        "stop_at": None,                  # ISO time: switch the autopilot off automatically at this time
        "practice_mode": False,           # Sandbox only: trade even when the model has not passed validation
        "pickiness": "balanced",          # strict (scanner-qualified only) | balanced | active
    },
    "live_trading": {
        "enabled": False,                 # real-money execution is not implemented; flag reserved
    },
    "explanations": {
        "llm_enabled": False,
        "llm_model": "claude-sonnet-5-5",
    },
}


def deep_merge(base: dict, override: dict) -> dict:
    out = copy.deepcopy(base)
    for k, v in (override or {}).items():
        if isinstance(v, dict) and isinstance(out.get(k), dict):
            out[k] = deep_merge(out[k], v)
        else:
            out[k] = v
    return out
