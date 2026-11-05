"""Optional language-model narrative (Anthropic Claude API).

The model receives only the structured analysis bundle and is instructed to explain it,
not to add facts, prices or predictions of its own. Output is labelled as AI-written.
Disabled unless the user enables it and supplies ANTHROPIC_API_KEY.
"""
from __future__ import annotations

import json

import httpx

from . import config
from .settings_store import get_settings

SYSTEM = (
    "You explain a stock analysis to a self-directed investor. Use ONLY the JSON provided. Do not invent prices, "
    "news, numbers or events. Do not recommend buying or selling; describe what the evidence and statistics say, "
    "including contradicting evidence, uncertainty and risks. Probabilities are model estimates with stated "
    "validation results; say so. If data is marked simulated, say clearly that it is synthetic. "
    "Write 4 short paragraphs in plain English, no headings, under 280 words."
)


def available() -> bool:
    st = get_settings()["explanations"]
    return bool(st.get("llm_enabled") and config.get_secret("ANTHROPIC_API_KEY"))


def narrate(bundle: dict, direction: str) -> str:
    key = config.get_secret("ANTHROPIC_API_KEY")
    if not key:
        raise RuntimeError("ANTHROPIC_API_KEY is not configured")
    st = get_settings()["explanations"]
    slim = {
        "symbol": bundle["symbol"], "name": bundle["name"], "sector": bundle["sector"], "direction_considered": direction,
        "quote": {k: bundle["quote"].get(k) for k in ("price", "change_pct", "status")} if bundle.get("quote") else None,
        "regime": bundle["regime"]["summary"], "forecast": bundle.get("forecast"), "model": bundle.get("model"),
        "signals": [{k: s[k] for k in ("name", "score", "summary")} for s in bundle["signals"]],
        "plan": bundle["plans"][direction]["plan"], "evidence": bundle["plans"][direction]["evidence"],
        "risks": bundle["plans"][direction]["risks"], "symbol_history": bundle.get("history"),
        "headlines": [n["headline"] for n in bundle.get("news", [])[:6]],
    }
    r = httpx.post("https://api.anthropic.com/v1/messages", timeout=60,
                   headers={"x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json"},
                   json={"model": st.get("llm_model", "claude-sonnet-5-5"), "max_tokens": 700, "system": SYSTEM,
                         "messages": [{"role": "user", "content": json.dumps(slim, default=str)}]})
    if r.status_code >= 400:
        raise RuntimeError(f"Claude API error HTTP {r.status_code}: {r.text[:200]}")
    return "".join(b.get("text", "") for b in r.json().get("content", []) if b.get("type") == "text").strip()
