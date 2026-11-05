"""Read/write user preferences stored in SQLite, merged over defaults."""
from __future__ import annotations

import threading

from . import config
from .db import Setting, session_scope

_lock = threading.Lock()
_cache: dict | None = None


def get_settings() -> dict:
    global _cache
    with _lock:
        if _cache is None:
            with session_scope() as s:
                row = s.get(Setting, "user")
                _cache = config.deep_merge(config.DEFAULT_SETTINGS, row.value if row else {})
        return config.deep_merge(_cache, {})


def update_settings(patch: dict) -> dict:
    global _cache
    validate_patch(patch)
    with _lock:
        with session_scope() as s:
            row = s.get(Setting, "user")
            current = row.value if row else {}
            merged = config.deep_merge(current, patch)
            if row:
                row.value = merged
            else:
                s.add(Setting(key="user", value=merged))
        _cache = None
    return get_settings()


def reset_settings(section: str | None = None) -> dict:
    global _cache
    with _lock:
        with session_scope() as s:
            row = s.get(Setting, "user")
            if row:
                if section:
                    v = dict(row.value)
                    v.pop(section, None)
                    row.value = v
                else:
                    s.delete(row)
        _cache = None
    return get_settings()


_BOUNDS = {
    ("risk", "risk_per_trade_pct"): (0.01, 10.0),
    ("risk", "max_position_pct"): (0.5, 100.0),
    ("risk", "max_gross_exposure_pct"): (1.0, 400.0),
    ("risk", "max_sector_pct"): (1.0, 100.0),
    ("risk", "max_correlation"): (0.0, 1.0),
    ("risk", "max_daily_loss_pct"): (0.1, 50.0),
    ("risk", "max_drawdown_pct"): (0.5, 90.0),
    ("risk", "stop_atr_mult"): (0.25, 10.0),
    ("costs", "slippage_bps"): (0.0, 500.0),
    ("costs", "default_spread_bps"): (0.0, 500.0),
    ("costs", "commission_per_share"): (0.0, 1.0),
    ("scanner", "horizon_days"): (1, 60),
    ("model", "horizon_days"): (1, 60),
    ("data", "quote_poll_seconds"): (1, 3600),
    ("paper", "starting_cash"): (100.0, 1e9),
    ("general", "fx_rate_to_base"): (0.0001, 10000.0),
}


def validate_patch(patch: dict) -> None:
    for (sec, key), (lo, hi) in _BOUNDS.items():
        if sec in patch and isinstance(patch[sec], dict) and key in patch[sec]:
            v = patch[sec][key]
            if v is None:
                continue
            if not isinstance(v, (int, float)) or not (lo <= v <= hi):
                raise ValueError(f"{sec}.{key} must be a number between {lo} and {hi}")
    prov = patch.get("data", {}).get("provider") if isinstance(patch.get("data"), dict) else None
    if prov is not None and prov not in ("simulation", "alpaca", "yahoo"):
        raise ValueError("data.provider must be simulation, alpaca or yahoo")
    if isinstance(patch.get("live_trading"), dict) and patch["live_trading"].get("enabled"):
        raise ValueError("Live (real-money) trading is not implemented in this build and cannot be enabled.")
    mdl = patch.get("model") if isinstance(patch.get("model"), dict) else {}
    if "methods" in mdl:
        from .ml.models import METHODS
        ms = mdl["methods"]
        if not isinstance(ms, list) or not ms or any(m not in METHODS or m == "base_rate" for m in ms):
            raise ValueError("model.methods must be a non-empty list of: " + ", ".join(k for k in METHODS if k != "base_rate"))
        if "ensemble" in ms and not all(m in ms for m in ("logistic", "gbm", "forest")):
            raise ValueError("The ensemble needs logistic, gbm and forest selected too.")
    if "selection" in mdl:
        from .ml.models import METHODS
        if mdl["selection"] != "auto" and mdl["selection"] not in METHODS:
            raise ValueError("model.selection must be 'auto' or a method name")
    w = patch.get("scanner", {}).get("weights") if isinstance(patch.get("scanner"), dict) else None
    if w is not None:
        if any((not isinstance(x, (int, float))) or x < 0 for x in w.values()):
            raise ValueError("scanner weights must be non-negative numbers")
