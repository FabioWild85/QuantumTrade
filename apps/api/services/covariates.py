"""
External covariate fetcher.
Pulls Fear & Greed index (alternative.me) and BTC dominance (CoinGecko free API).
Stores timestamped rows to Supabase covariates table and returns values for in-cycle use.
"""

import logging
from datetime import datetime, timezone
from typing import Optional

import httpx

from services.supabase_client import get_supabase

log = logging.getLogger(__name__)

_FNG_URL         = "https://api.alternative.me/fng/?limit=1&format=json"
_FNG_HISTORY_URL = "https://api.alternative.me/fng/?limit=0&format=json&date_format=us"
_GECKO_URL       = "https://api.coingecko.com/api/v3/global"
_TIMEOUT         = 30.0

# Module-level cache for historical F&G — fetched once per process lifetime.
_fng_cache: dict[str, float] = {}


# ── Fetchers ──────────────────────────────────────────────────────────────────

async def _fetch_fear_greed() -> Optional[dict]:
    async with httpx.AsyncClient(timeout=_TIMEOUT) as client:
        resp = await client.get(_FNG_URL)
        resp.raise_for_status()
        d = resp.json()["data"][0]
        return {
            "value":          int(d["value"]),
            "classification": d["value_classification"],
        }


async def _fetch_btc_dominance() -> Optional[float]:
    async with httpx.AsyncClient(timeout=_TIMEOUT) as client:
        resp = await client.get(_GECKO_URL)
        resp.raise_for_status()
        pct = resp.json()["data"]["market_cap_percentage"].get("btc")
        return round(float(pct), 4) if pct is not None else None


# ── Public API ────────────────────────────────────────────────────────────────

async def fetch_historical_fng() -> dict[str, float]:
    """
    Fetch the full Fear & Greed history from alternative.me (2018–today).
    Returns {date_str: fng_value} e.g. {"2024-01-15": 45.0, ...}.
    Cached in-process: subsequent calls return the same dict without re-fetching.
    On any error returns {} — callers must handle gracefully.
    """
    global _fng_cache
    if _fng_cache:
        return _fng_cache
    try:
        async with httpx.AsyncClient(timeout=_TIMEOUT) as client:
            resp = await client.get(_FNG_HISTORY_URL)
            resp.raise_for_status()
            rows = resp.json().get("data", [])
        result: dict[str, float] = {}
        for row in rows:
            # date_format=us gives "timestamp" as "MM-DD-YYYY"
            date_str = row.get("timestamp", "")
            if date_str:
                try:
                    # Normalise to ISO YYYY-MM-DD for dict key
                    parts = date_str.split("-")
                    if len(parts) == 3:
                        iso = f"{parts[2]}-{parts[0]}-{parts[1]}"
                        result[iso] = float(row["value"])
                except (ValueError, KeyError):
                    pass
        _fng_cache = result
        log.info("Historical F&G loaded: %d days", len(result))
        return result
    except Exception as exc:
        log.warning("fetch_historical_fng failed: %s", exc)
        return {}


async def update_covariates(symbol: str = "BTC") -> dict:
    """
    Fetch Fear & Greed and BTC dominance, persist to Supabase, return values.
    Failures are logged and skipped — never raises.
    """
    now     = datetime.now(timezone.utc).isoformat()
    results = {}

    # Fear & Greed
    try:
        fng = await _fetch_fear_greed()
        if fng:
            results["fear_greed"]       = float(fng["value"])
            results["fear_greed_class"] = fng["classification"]
            _insert_row(now, symbol, "alternative.me", "fear_greed", fng["value"])
            log.debug("Fear & Greed: %d (%s)", fng["value"], fng["classification"])
    except Exception as exc:
        log.warning("Fear & Greed fetch failed: %s", exc)

    # BTC dominance
    try:
        dom = await _fetch_btc_dominance()
        if dom is not None:
            results["btc_dominance"] = dom
            _insert_row(now, symbol, "coingecko", "btc_dominance", dom)
            log.debug("BTC dominance: %.2f%%", dom)
    except Exception as exc:
        log.warning("BTC dominance fetch failed: %s", exc)

    return results


def get_latest_covariates(keys: Optional[list] = None) -> dict:
    """
    Read the most recent value per key from Supabase covariates.
    Returns a flat dict {key: value}.
    """
    _default_keys = ["fear_greed", "btc_dominance", "confluence_score"]
    target_keys   = keys or _default_keys
    try:
        db   = get_supabase()
        rows = (
            db.table("covariates")
            .select("key,value")
            .in_("key", target_keys)
            .order("time", desc=True)
            .limit(len(target_keys) * 5)   # a few rows per key to guarantee coverage
            .execute()
            .data
        )
        result: dict = {}
        for r in rows:
            k = r["key"]
            if k not in result:   # first seen = most recent
                result[k] = float(r["value"])
        return result
    except Exception as exc:
        log.warning("get_latest_covariates failed: %s", exc)
        return {}


# ── Internal ──────────────────────────────────────────────────────────────────

def _insert_row(time: str, symbol: str, source: str, key: str, value: float):
    try:
        db = get_supabase()
        db.table("covariates").insert({
            "time":   time,
            "symbol": symbol,
            "source": source,
            "key":    key,
            "value":  float(value),
        }).execute()
    except Exception as exc:
        log.warning("Covariate insert failed (%s/%s): %s", source, key, exc)
