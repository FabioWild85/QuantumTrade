"""
AI Decision Layer — analyst (multi-provider abstraction).

Un LLM giudica la decisione del modello quantitativo PRIMA del trade usando il
dossier strutturale/macro costruito da `ai_context.build_dossier`, e restituisce
un verdetto strutturato (`AIVerdict`).

Design:
  • Solo testo (niente immagini). Dossier curato dal server, NON agentico.
  • Multi-provider via httpx (Anthropic / Gemini / OpenAI / DeepSeek) — nessun SDK
    aggiuntivo: tutte REST. La chiave di ciascun provider vive in env.
  • FAIL-OPEN: qualsiasi errore/timeout/JSON invalido → `evaluate()` ritorna None
    e il chiamante prosegue col solo modello (comportamento attuale validato).
  • temperature=0 + output JSON forzato + parsing/validazione difensivi.

Questo modulo NON ha effetti collaterali sulla decisione: si limita a produrre il
verdetto. L'applicazione del verdetto avviene in `execution.py`.
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
import re
from dataclasses import dataclass, field, asdict
from typing import Optional

import httpx

log = logging.getLogger(__name__)

# ── Catalogo modelli per provider ─────────────────────────────────────────────
# Aggiornabile senza toccare la logica. La UI lo legge via /ai-layer/providers,
# filtrato per chiavi presenti in env.
MODEL_CATALOG: dict[str, list[dict]] = {
    "anthropic": [
        {"id": "claude-opus-4-8",            "label": "Claude Opus 4.8 (max qualità)"},
        {"id": "claude-sonnet-4-6",          "label": "Claude Sonnet 4.6 (bilanciato)"},
        {"id": "claude-haiku-4-5-20251001",  "label": "Claude Haiku 4.5 (veloce/economico)"},
    ],
    "gemini": [
        {"id": "gemini-2.5-pro",   "label": "Gemini 2.5 Pro"},
        {"id": "gemini-2.5-flash", "label": "Gemini 2.5 Flash"},
    ],
    "openai": [
        {"id": "gpt-4o",      "label": "GPT-4o"},
        {"id": "gpt-4o-mini", "label": "GPT-4o mini"},
    ],
    "deepseek": [
        {"id": "deepseek-chat",     "label": "DeepSeek Chat (V3)"},
        {"id": "deepseek-reasoner", "label": "DeepSeek Reasoner (R1)"},
    ],
}

_ENV_KEY = {
    "anthropic": "ANTHROPIC_API_KEY",
    "gemini":    "GEMINI_API_KEY",
    "openai":    "OPENAI_API_KEY",
    "deepseek":  "DEEPSEEK_API_KEY",
}


def _key(provider: str) -> str:
    return (os.environ.get(_ENV_KEY.get(provider, ""), "") or "").strip()


def provider_available(provider: str) -> bool:
    """True se la chiave del provider è presente in env (non vuota)."""
    return bool(_key(provider))


def available_providers() -> dict:
    """Catalogo arricchito con flag `available` per la UI."""
    out = {}
    for prov, models in MODEL_CATALOG.items():
        out[prov] = {"available": provider_available(prov), "models": models}
    return out


# ── Verdetto ──────────────────────────────────────────────────────────────────
@dataclass
class AIVerdict:
    agreement: str = "neutral"          # "confirm" | "neutral" | "veto"
    conviction: int = 0                 # 0-100
    bias: str = "neutral"               # "long" | "short" | "neutral"
    threshold_adjustment: float = 0.0   # delta grezzo (clampato a valle)
    invalidation_level: Optional[float] = None
    flags: list[str] = field(default_factory=list)
    report_it: str = ""                 # report sintetico in italiano (UX)
    raw: dict = field(default_factory=dict)
    latency_ms: int = 0

    def to_dict(self) -> dict:
        d = asdict(self)
        return d


# ── System prompt ─────────────────────────────────────────────────────────────
AI_ANALYST_SYSTEM_PROMPT = """\
You are a senior market-structure analyst auditing a single proposed trade from
a quantitative trading bot on BTC/USD (4-hour timeframe). The bot uses a LightGBM
model that outputs a directional probability but is STRUCTURALLY BLIND: it does
not perceive market geometry (swing highs/lows), where price sits inside the
broader range, liquidity pools, or whether a move is already exhausted.

YOUR JOB: judge whether the proposed trade makes structural sense, using ONLY the
dossier provided. You are a SANITY FILTER, not the trader. The model already
decided; you confirm, dampen, or veto.

THE #1 FAILURE MODE YOU MUST CATCH:
A late entry AGAINST an exhausted move — e.g. the model proposes a SHORT after
price has been falling for days, just printed a NEW LOW, ADX has collapsed
(trend exhausted), and price is already bouncing. That is "selling the low":
structurally wrong, terrible risk/reward, high reversal risk. VETO these.
The symmetric case (buying the high after an exhausted rally) applies equally.

IF THE PROPOSED ACTION IS "no_trade":
The model decided to stand aside (threshold not met, or a hard gate fired).
Still produce a full judgment: do you AGREE with standing aside, or do you see a
high-quality structural setup the model is missing? Use "agreement":
- "confirm"  = standing aside is correct (no clean setup, choppy, mid-range).
- "neutral"  = no strong opinion.
- "veto"     = (here it means) you see a genuinely strong setup the model missed;
               set "bias" to the direction. NOTE: in v1 this is informational only
               and will NOT open a trade unless easing is explicitly enabled.
Be conservative: prefer "confirm" on no_trade unless the setup is clearly strong.

HARD RULES:
1. Use ONLY the data in the dossier. NEVER invent price levels, news, or facts
   not present. If a field is missing, reason without it — do not fabricate.
2. Do NOT re-judge the model's edge from its probability. Judge STRUCTURE and
   CONTEXT only — the things the model cannot see.
3. Be conservative. Default to "neutral" unless the structure clearly supports
   (confirm) or clearly contradicts (veto) the trade.
4. A trade WITH the higher-timeframe structure and toward liquidity is good.
   A trade AGAINST structure, chasing an extended move, or into a strong opposing
   level is bad.
5. Output STRICT JSON matching the schema. No prose outside JSON. Be deterministic.

EVALUATE, in order:
- Higher-timeframe structure (Daily/4H): is the trade with or against it?
- Is the move already extended? (bars_since_extreme, dist_from_recent_extreme)
  Is the bot entering right at a fresh extreme it helped create?
- Last structural event: BOS (continuation, supports trade) vs CHoCH (reversal,
  warns against continuation trades).
- Range position: is the trade selling the bottom / buying the top of the range?
- Liquidity: is price heading toward unswept liquidity (good) or away from it?
- Key levels & reference_levels (prior day/week high-low): is entry right into
  strong opposing S/R? Is the intended stop behind a valid level or in the void?
  Is the intended target before a wall? Judge the risk_reward.
- recent_candles: look for rejection wicks (e.g. a long lower wick on the last
  bar = a bounce in progress → warns against shorting into it, and vice-versa).
- Order-flow (orderflow block) — ORTHOGONAL to price, weigh it:
    · cvd_slope / delta_price_div: is order-flow confirming the move or diverging
      from price (bearish/bullish divergence = warning)?
    · oi_delta_z / oi_ma_ratio: rising OI with price = healthy; rising OI with
      flat/exhausted price = squeeze risk on the proposed side.
    · ls_ratio / long_pct: extreme crowd positioning = contrarian risk.
    · vol_z_50 / absorption_z: climax volume or absorption = exhaustion evidence.
- Macro: funding extremes (over-crowded side), Fear & Greed extremes (contrarian).

NOTE: if the dossier is in "orthogonal" mode it will NOT contain the model's own
probabilities or reasoning — judge purely on the objective data above. If in
"full" mode, you may see lgbm_prob / model_reasoning as context, but STILL judge
structure independently — do not merely rubber-stamp the model.

OUTPUT — return EXACTLY this JSON object and nothing else:
{
  "agreement": "confirm | neutral | veto",
  "conviction": <int 0-100>,
  "bias": "long | short | neutral",
  "threshold_adjustment": <float, + = harder, - = easier, your raw proposal>,
  "invalidation_level": <price number or null>,
  "flags": [<machine tags>],
  "report_it": "<2-4 sentences in ITALIAN explaining your call for the human>"
}

Tag vocabulary for flags: counter_structure, with_structure, chasing_extended,
selling_the_low, buying_the_high, into_resistance, into_support, exhaustion,
clean_trend, toward_liquidity, away_from_liquidity, funding_extreme, sentiment_extreme.
"""

_MAX_TOKENS = 1024


# ── Parsing / validazione difensivi ───────────────────────────────────────────
def _extract_json(text: str) -> dict:
    """Estrae il primo oggetto JSON dal testo, tollerando ```json fences e prosa."""
    if not text:
        raise ValueError("empty response")
    t = text.strip()
    # rimuove eventuali code-fence
    t = re.sub(r"^```(?:json)?\s*", "", t)
    t = re.sub(r"\s*```$", "", t)
    try:
        return json.loads(t)
    except Exception:
        pass
    # fallback: primo {...} bilanciato
    start = t.find("{")
    if start == -1:
        raise ValueError("no JSON object found")
    depth = 0
    for i in range(start, len(t)):
        if t[i] == "{":
            depth += 1
        elif t[i] == "}":
            depth -= 1
            if depth == 0:
                return json.loads(t[start:i + 1])
    raise ValueError("unbalanced JSON object")


def _validate_verdict(data: dict) -> AIVerdict:
    """Valida schema + range. Solleva su input non conforme (→ fail-open a monte)."""
    agreement = str(data.get("agreement", "neutral")).lower().strip()
    if agreement not in ("confirm", "neutral", "veto"):
        agreement = "neutral"
    bias = str(data.get("bias", "neutral")).lower().strip()
    if bias not in ("long", "short", "neutral"):
        bias = "neutral"
    conviction = int(round(float(data.get("conviction", 0))))
    conviction = max(0, min(100, conviction))
    adj = float(data.get("threshold_adjustment", 0.0) or 0.0)
    adj = max(-1.0, min(1.0, adj))   # sanity clamp grezzo (il clamp fine è a valle)
    inval = data.get("invalidation_level", None)
    try:
        inval = float(inval) if inval is not None else None
    except (TypeError, ValueError):
        inval = None
    flags = data.get("flags", []) or []
    if not isinstance(flags, list):
        flags = [str(flags)]
    flags = [str(f) for f in flags][:12]
    report = str(data.get("report_it", "") or "").strip()
    return AIVerdict(
        agreement=agreement,
        conviction=conviction,
        bias=bias,
        threshold_adjustment=adj,
        invalidation_level=inval,
        flags=flags,
        report_it=report,
        raw=data,
    )


# ── Provider calls (httpx, async) ─────────────────────────────────────────────
async def _call_anthropic(client, model, system, user, timeout_s) -> str:
    r = await client.post(
        "https://api.anthropic.com/v1/messages",
        headers={
            "x-api-key": _key("anthropic"),
            "anthropic-version": "2023-06-01",
            "content-type": "application/json",
        },
        json={
            "model": model,
            "max_tokens": _MAX_TOKENS,
            # NB: `temperature` NON inviato — i modelli recenti (es. claude-opus-4-8)
            # lo rifiutano come deprecato (400). La consistenza è garantita da
            # schema JSON rigido + clamp a valle.
            "system": system,
            "messages": [{"role": "user", "content": user}],
        },
        timeout=timeout_s,
    )
    r.raise_for_status()
    data = r.json()
    return "".join(b.get("text", "") for b in data.get("content", []) if b.get("type") == "text")


async def _call_gemini(client, model, system, user, timeout_s) -> str:
    url = (f"https://generativelanguage.googleapis.com/v1beta/models/"
           f"{model}:generateContent?key={_key('gemini')}")
    r = await client.post(
        url,
        headers={"content-type": "application/json"},
        json={
            "systemInstruction": {"parts": [{"text": system}]},
            "contents": [{"role": "user", "parts": [{"text": user}]}],
            "generationConfig": {
                "temperature": 0,
                "responseMimeType": "application/json",
                "maxOutputTokens": _MAX_TOKENS,
            },
        },
        timeout=timeout_s,
    )
    r.raise_for_status()
    data = r.json()
    parts = (data.get("candidates", [{}])[0].get("content", {}).get("parts", []))
    return "".join(p.get("text", "") for p in parts)


async def _call_openai_compatible(client, base_url, api_key, model, system, user, timeout_s) -> str:
    r = await client.post(
        f"{base_url}/chat/completions",
        headers={"Authorization": f"Bearer {api_key}", "content-type": "application/json"},
        json={
            "model": model,
            "temperature": 0,
            "max_tokens": _MAX_TOKENS,
            "response_format": {"type": "json_object"},
            "messages": [
                {"role": "system", "content": system},
                {"role": "user", "content": user},
            ],
        },
        timeout=timeout_s,
    )
    r.raise_for_status()
    data = r.json()
    return data.get("choices", [{}])[0].get("message", {}).get("content", "")


async def _dispatch(provider: str, model: str, system: str, user: str, timeout_s: float) -> str:
    async with httpx.AsyncClient() as client:
        if provider == "anthropic":
            return await _call_anthropic(client, model, system, user, timeout_s)
        if provider == "gemini":
            return await _call_gemini(client, model, system, user, timeout_s)
        if provider == "openai":
            return await _call_openai_compatible(
                client, "https://api.openai.com/v1", _key("openai"), model, system, user, timeout_s)
        if provider == "deepseek":
            return await _call_openai_compatible(
                client, "https://api.deepseek.com", _key("deepseek"), model, system, user, timeout_s)
        raise ValueError(f"unknown provider: {provider}")


# ── API pubblica ──────────────────────────────────────────────────────────────
async def evaluate(
    *,
    dossier: dict,
    provider: str,
    model: str,
    timeout_s: float = 30.0,
    system_prompt: str = AI_ANALYST_SYSTEM_PROMPT,
) -> Optional[AIVerdict]:
    """
    Valuta il dossier con l'LLM scelto. Ritorna AIVerdict, oppure None su QUALSIASI
    errore/timeout/JSON invalido (fail-open). NON solleva mai.
    """
    import time
    if not provider_available(provider):
        log.warning("AI Layer: provider '%s' senza API key → fail-open", provider)
        return None
    t0 = time.monotonic()
    try:
        user_payload = json.dumps(dossier, ensure_ascii=False, default=str)
        raw_text = await asyncio.wait_for(
            _dispatch(provider, model, system_prompt, user_payload, timeout_s),
            timeout=timeout_s + 2.0,   # guard oltre il timeout httpx
        )
        verdict = _validate_verdict(_extract_json(raw_text))
        verdict.latency_ms = int((time.monotonic() - t0) * 1000)
        return verdict
    except Exception as exc:
        log.warning("AI Layer evaluate fail-open (%s/%s): %s", provider, model, exc)
        return None
