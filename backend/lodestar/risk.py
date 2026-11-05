"""Risk management: trade plans, position sizing, cost estimates and pre-trade checks.

Position size (shares) =
    floor( min( risk_budget / per_share_risk,
                max_position_value / entry,
                buying_power / entry ) )
where risk_budget = equity * risk_per_trade_pct / 100 and per_share_risk = |entry - stop|
(+ estimated per-share costs). Stops are *not* guaranteed: gaps and fast markets can fill
a stop far beyond its price, so realised loss can exceed the risk budget.
"""
from __future__ import annotations

import math
from dataclasses import asdict, dataclass, field

import numpy as np
import pandas as pd

from . import universe as U

STOP_DISCLAIMER = ("Stop levels are not guaranteed: an opening gap or fast market can fill a stop well beyond its price, "
                   "so the realised loss can exceed the planned risk.")


@dataclass
class TradePlan:
    direction: str
    entry: float
    entry_low: float
    entry_high: float
    stop: float
    targets: list[float]
    atr: float
    risk_per_share: float
    reward_risk: float
    invalidation: str

    def to_dict(self) -> dict:
        return {k: (round(v, 4) if isinstance(v, float) else [round(x, 4) for x in v] if isinstance(v, list) else v)
                for k, v in asdict(self).items()}


def trade_plan(direction: str, price: float, atr: float, stop_atr: float, target_atr: float, extra_r: float = 2.5) -> TradePlan:
    if price <= 0 or not math.isfinite(atr) or atr <= 0:
        raise ValueError("price and ATR must be positive")
    sgn = 1 if direction == "long" else -1
    stop = price - sgn * stop_atr * atr
    r = abs(price - stop)
    t1 = price + sgn * target_atr * atr
    t2 = price + sgn * extra_r * r
    targets = sorted({round(t1, 4), round(t2, 4)}, reverse=(sgn < 0))
    lo, hi = (price - 0.25 * atr, price + 0.10 * atr) if sgn > 0 else (price - 0.10 * atr, price + 0.25 * atr)
    inval = (f"Close {'below' if sgn > 0 else 'above'} {stop:.2f} (stop), or the setup's supporting signals reverse "
             f"before entry. Do not chase beyond {hi if sgn > 0 else lo:.2f}.")
    return TradePlan(direction, price, lo, hi, stop, targets, atr, r, abs(t1 - price) / r, inval)


def cost_estimate(price: float, qty: float, spread_bps: float | None, costs: dict) -> dict:
    """Round-trip cost estimate: half-spread + slippage on each side + commissions."""
    sp = spread_bps if spread_bps is not None else costs["default_spread_bps"]
    per_side_bps = sp / 2 + costs["slippage_bps"]
    comm = max(costs["min_commission"], costs["commission_per_share"] * qty) if qty else 0.0
    notional = abs(price * qty)
    total = notional * 2 * per_side_bps / 1e4 + 2 * comm
    pct = 2 * per_side_bps / 1e4 + (2 * costs["commission_per_share"] / price if price else 0)
    return {"spread_bps": sp, "slippage_bps": costs["slippage_bps"], "round_trip_pct": pct, "round_trip_cost": total,
            "commission_round_trip": 2 * comm, "spread_source": "quote" if spread_bps is not None else "default estimate"}


def position_size(equity: float, entry: float, stop: float, risk: dict, buying_power: float, costs: dict,
                  spread_bps: float | None = None, existing_value: float = 0.0) -> dict:
    """``existing_value``: absolute value already held in this symbol in the same direction;
    it counts against the max-position cap so suggestions never breach the limit."""
    per_share = abs(entry - stop)
    notes = []
    if per_share <= 0 or entry <= 0 or equity <= 0:
        return {"qty": 0, "notes": ["invalid entry/stop/equity"], "risk_budget": 0.0}
    sp = spread_bps if spread_bps is not None else costs["default_spread_bps"]
    per_share_cost = entry * (sp / 2 + costs["slippage_bps"]) / 1e4 * 2 + 2 * costs["commission_per_share"]
    budget = equity * risk["risk_per_trade_pct"] / 100
    by_risk = budget / (per_share + per_share_cost)
    by_pos = max(0.0, equity * risk["max_position_pct"] / 100 - abs(existing_value)) / entry
    by_bp = max(0.0, buying_power) / entry
    qty = math.floor(min(by_risk, by_pos, by_bp))
    binding = min((by_risk, "risk budget"), (by_pos, "max position size"), (by_bp, "buying power"))[1]
    if binding != "risk budget":
        notes.append(f"size capped by {binding}")
    qty = max(qty, 0)
    return {"qty": qty, "risk_budget": budget, "per_share_risk": per_share, "per_share_cost": per_share_cost,
            "position_value": qty * entry, "risk_at_stop": qty * (per_share + per_share_cost),
            "risk_pct_of_equity": qty * (per_share + per_share_cost) / equity * 100, "binding_constraint": binding,
            "limits": {"by_risk": math.floor(by_risk), "by_max_position": math.floor(by_pos), "by_buying_power": math.floor(by_bp)},
            "notes": notes}


@dataclass
class CheckResult:
    ok: bool
    violations: list[str] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)


def pre_trade_checks(*, symbol: str, side: str, qty: float, price: float, equity: float, cash: float,
                     positions: dict[str, dict], risk: dict, halted_reason: str | None, is_exit: bool,
                     returns: dict[str, pd.Series] | None = None, allow_short: bool = True, trading_enabled: bool = True) -> CheckResult:
    """``positions``: {symbol: {"qty": signed qty, "price": mark}}. Exits (reducing an existing
    position) are always allowed, even while trading is switched off."""
    r = CheckResult(True)
    if not trading_enabled and not is_exit:
        r.violations.append("Trading is switched off. Turn it on with the Trading switch in the top bar (closing positions is still allowed).")
    if qty <= 0:
        r.violations.append("Quantity must be positive.")
    if is_exit:
        r.ok = not r.violations
        return r
    if halted_reason:
        r.violations.append(f"New entries halted: {halted_reason}")
    cur = positions.get(symbol, {}).get("qty", 0.0)
    new_qty = cur + (qty if side == "buy" else -qty)
    if new_qty < 0 and not allow_short:
        r.violations.append("Short selling is disabled in settings.")
    notional = qty * price
    if side == "buy" and notional > cash + 1e-6:
        r.violations.append(f"Insufficient buying power: need {notional:,.2f}, have {cash:,.2f}.")
    # Shorts are collateralised by the gross-exposure limit below (no separate margin model).
    pos_val = abs(new_qty) * price
    if pos_val > equity * risk["max_position_pct"] / 100 + 1e-6:
        r.violations.append(f"Position would be {pos_val / equity:.1%} of equity (limit {risk['max_position_pct']:.0f}%).")
    gross_after = _gross(positions, exclude=symbol) + pos_val
    if gross_after > equity * risk["max_gross_exposure_pct"] / 100 + 1e-6:
        r.violations.append(f"Gross exposure would be {gross_after / equity:.0%} (limit {risk['max_gross_exposure_pct']:.0f}%).")
    sector = U.sector_of(symbol)
    sec_val = sum(abs(p["qty"]) * p["price"] for s, p in positions.items() if s != symbol and U.sector_of(s) == sector) + pos_val
    if sec_val > equity * risk["max_sector_pct"] / 100 + 1e-6:
        r.violations.append(f"{sector} exposure would be {sec_val / equity:.0%} (limit {risk['max_sector_pct']:.0f}%).")
    if returns and symbol in returns:
        mine = returns[symbol]
        for s, p in positions.items():
            if s == symbol or s not in returns or p["qty"] == 0:
                continue
            c = mine.tail(60).corr(returns[s].tail(60))
            same_dir = (p["qty"] > 0) == (side == "buy")
            if np.isfinite(c) and c > risk["max_correlation"] and same_dir:
                r.warnings.append(f"High correlation with existing {s} position ({c:.2f} over 60 days) — risks are additive.")
    r.ok = not r.violations
    return r


def _gross(positions: dict[str, dict], exclude: str | None) -> float:
    return sum(abs(p["qty"]) * p["price"] for s, p in positions.items() if s != exclude)
