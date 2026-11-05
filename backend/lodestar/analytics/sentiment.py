"""Lexicon-based financial headline sentiment.

A transparent, deterministic scorer (not a language model): finance-specific
positive/negative terms in the spirit of the Loughran-McDonald dictionaries,
with simple negation and intensifier handling. Returns a score in [-1, 1] and
the terms that produced it, so every score can be audited.
"""
from __future__ import annotations

import re

POSITIVE = {
    "beat": 1.0, "beats": 1.0, "exceeds": 0.9, "exceeded": 0.9, "surpass": 0.9, "surpasses": 0.9, "record": 0.6,
    "raises": 0.7, "raised": 0.6, "upgrade": 0.9, "upgraded": 0.9, "outperform": 0.8, "strong": 0.6, "growth": 0.5,
    "profit": 0.5, "profitable": 0.6, "gain": 0.5, "gains": 0.5, "surge": 0.8, "surges": 0.8, "soar": 0.8, "soars": 0.8,
    "rally": 0.6, "rallies": 0.6, "jump": 0.6, "jumps": 0.6, "rise": 0.4, "rises": 0.4, "approval": 0.7, "approved": 0.7,
    "wins": 0.7, "win": 0.6, "contract": 0.3, "buyback": 0.6, "dividend": 0.3, "expands": 0.5, "expansion": 0.4,
    "partnership": 0.4, "boost": 0.5, "boosts": 0.5, "optimistic": 0.6, "bullish": 0.7, "accelerate": 0.5,
    "accelerating": 0.5, "robust": 0.6, "momentum": 0.3, "tops": 0.7, "breakthrough": 0.7, "demand": 0.2,
}
NEGATIVE = {
    "miss": -1.0, "misses": -1.0, "missed": -1.0, "cut": -0.7, "cuts": -0.7, "lowers": -0.7, "lowered": -0.7,
    "downgrade": -0.9, "downgraded": -0.9, "underperform": -0.8, "weak": -0.6, "weakness": -0.6, "loss": -0.6,
    "losses": -0.6, "decline": -0.5, "declines": -0.5, "drop": -0.5, "drops": -0.5, "plunge": -0.9, "plunges": -0.9,
    "slump": -0.8, "slumps": -0.8, "fall": -0.4, "falls": -0.4, "tumble": -0.8, "tumbles": -0.8, "probe": -0.7,
    "investigation": -0.7, "lawsuit": -0.7, "sued": -0.7, "fraud": -1.0, "recall": -0.8, "recalls": -0.8,
    "layoffs": -0.6, "restructuring": -0.4, "bankruptcy": -1.0, "default": -0.9, "warning": -0.6, "warns": -0.7,
    "pressure": -0.4, "concern": -0.4, "concerns": -0.4, "delay": -0.5, "delays": -0.5, "halt": -0.7, "halts": -0.7,
    "bearish": -0.7, "fine": -0.5, "fined": -0.7, "penalty": -0.6, "resigns": -0.5, "shortfall": -0.8, "defects": -0.7,
    "slowdown": -0.6, "headwinds": -0.5, "volatile": -0.3, "sell-off": -0.7, "selloff": -0.7,
}
NEGATORS = {"not", "no", "never", "without", "fails", "failed", "despite"}
INTENSIFIERS = {"sharply": 1.4, "significantly": 1.3, "strongly": 1.3, "slightly": 0.6, "modestly": 0.7}
_TOKEN = re.compile(r"[a-z][a-z\-']*")


def score(text: str) -> tuple[float, list[str]]:
    tokens = _TOKEN.findall((text or "").lower())
    total, hits, n = 0.0, [], 0
    for i, tok in enumerate(tokens):
        w = POSITIVE.get(tok) or NEGATIVE.get(tok)
        if w is None:
            continue
        window = tokens[max(0, i - 3):i]
        if any(t in NEGATORS for t in window):
            w = -w * 0.8
        for t in window:
            w *= INTENSIFIERS.get(t, 1.0)
        total += w
        n += 1
        hits.append(("¬" if any(t in NEGATORS for t in window) else "") + tok)
    if n == 0:
        return 0.0, []
    s = total / (n + 1.0)  # shrink toward 0 for single-term headlines
    return max(-1.0, min(1.0, s)), hits
