"""
Deribit options data fetcher — Phase 1: ATM Implied Volatility.

Uses get_book_summary_by_currency which returns mark_iv for all active instruments
in a single call. Expiry is parsed from the instrument_name field.
Cached in-process; returns last known value on failure. Never blocks the main cycle.
"""

import logging
import time
from datetime import datetime, timezone
from typing import Optional

import httpx

log = logging.getLogger(__name__)

_iv_cache: tuple[Optional[float], float] = (None, 0.0)
_CACHE_TTL_S = 3600

DERIBIT_BASE = "https://www.deribit.com/api/v2/public"
_MONTH_MAP = {
    "JAN": 1, "FEB": 2, "MAR": 3, "APR": 4, "MAY": 5, "JUN": 6,
    "JUL": 7, "AUG": 8, "SEP": 9, "OCT": 10, "NOV": 11, "DEC": 12,
}


def _parse_expiry(instrument_name: str) -> Optional[datetime]:
    """Parse expiry from Deribit instrument name, e.g. 'BTC-25DEC26-65000-C'."""
    try:
        parts = instrument_name.split("-")
        if len(parts) < 4:
            return None
        raw = parts[1]           # e.g. "25DEC26"
        day   = int(raw[:2])
        month = _MONTH_MAP.get(raw[2:5].upper())
        year  = 2000 + int(raw[5:7])
        if month is None:
            return None
        return datetime(year, month, day, 8, 0, tzinfo=timezone.utc)  # Deribit settles at 08:00 UTC
    except Exception:
        return None


def _parse_strike(instrument_name: str) -> Optional[float]:
    """Parse strike from 'BTC-25DEC26-65000-C' → 65000.0"""
    try:
        return float(instrument_name.split("-")[2])
    except Exception:
        return None


async def get_deribit_atm_iv(symbol: str = "BTC") -> Optional[float]:
    """
    Returns the ATM IV (annualised, decimal) for the nearest weekly expiry 5–14 days out.
    Single API call. Caches result for CACHE_TTL_S seconds.
    Returns last cached value on failure (forward-fill), or None if never fetched.
    """
    global _iv_cache

    cached_iv, cached_at = _iv_cache
    if cached_iv is not None and (time.time() - cached_at) < _CACHE_TTL_S:
        return cached_iv

    currency = symbol.upper()
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            resp = await client.get(
                f"{DERIBIT_BASE}/get_book_summary_by_currency",
                params={"currency": currency, "kind": "option"},
            )
            resp.raise_for_status()
            instruments = resp.json().get("result", [])

        now = datetime.now(timezone.utc)
        now_s = now.timestamp()

        # Filter: 5–14 days to expiry, valid mark_iv > 0, valid underlying_price
        candidates = []
        spot = None
        for ins in instruments:
            exp = _parse_expiry(ins.get("instrument_name", ""))
            iv  = ins.get("mark_iv")
            if exp is None or iv is None or iv <= 0:
                continue
            days = (exp.timestamp() - now_s) / 86400
            if not (5 <= days <= 14):
                continue
            candidates.append(ins)
            if spot is None:
                spot = ins.get("underlying_price")

        if not candidates:
            # Fallback: 14–30 days
            for ins in instruments:
                exp = _parse_expiry(ins.get("instrument_name", ""))
                iv  = ins.get("mark_iv")
                if exp is None or iv is None or iv <= 0:
                    continue
                days = (exp.timestamp() - now_s) / 86400
                if 14 < days <= 30:
                    candidates.append(ins)
                    if spot is None:
                        spot = ins.get("underlying_price")

        if not candidates or spot is None:
            log.warning("Deribit: no suitable options for %s (candidates=%d)", currency, len(candidates))
            return cached_iv

        # Group by expiry, pick closest (smallest days_to_exp)
        def days_to_exp(ins):
            exp = _parse_expiry(ins["instrument_name"])
            return (exp.timestamp() - now_s) / 86400 if exp else 999

        best_exp_date = min(
            set(_parse_expiry(i["instrument_name"]) for i in candidates if _parse_expiry(i["instrument_name"])),
            key=lambda e: e.timestamp(),
        )
        exp_instruments = [
            i for i in candidates
            if _parse_expiry(i.get("instrument_name", "")) == best_exp_date
        ]

        # Find ATM strike (closest to spot)
        strikes_iv: dict[float, list[float]] = {}
        for ins in exp_instruments:
            strike = _parse_strike(ins.get("instrument_name", ""))
            iv = ins.get("mark_iv")
            if strike is not None and iv and iv > 0:
                strikes_iv.setdefault(strike, []).append(float(iv) / 100.0)

        if not strikes_iv:
            log.warning("Deribit: no valid strikes parsed for %s", currency)
            return cached_iv

        atm_strike = min(strikes_iv.keys(), key=lambda s: abs(s - spot))
        iv_values = strikes_iv[atm_strike]
        iv_7d = float(sum(iv_values) / len(iv_values))

        days_left = (best_exp_date.timestamp() - now_s) / 86400
        _iv_cache = (iv_7d, time.time())
        log.info(
            "Deribit ATM IV (%s, %.0fd expiry): %.1f%% (spot=%.0f strike=%.0f)",
            currency, days_left, iv_7d * 100, spot, atm_strike,
        )
        return iv_7d

    except Exception as exc:
        log.warning("Deribit IV fetch failed (non-blocking): %s", exc)
        return cached_iv


def get_cached_iv() -> Optional[float]:
    """Returns the last successfully fetched IV without a network call."""
    return _iv_cache[0]
