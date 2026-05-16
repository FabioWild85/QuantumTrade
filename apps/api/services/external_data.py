"""
External data sources: Coinglass (OI + liquidations) and Coinalyze (aggregated OI).
Used to enrich backtest features with real historical OI and liquidation data.
"""

import logging
import os
from datetime import datetime, timezone, timedelta
from typing import Optional

import httpx
import pandas as pd

log = logging.getLogger(__name__)

COINGLASS_KEY  = os.getenv("COINGLASS_API_KEY", "")
COINALYZE_KEY  = os.getenv("COINALYZE_API_KEY", "")

COINGLASS_BASE  = "https://open-api-v3.coinglass.com"
COINALYZE_BASE  = "https://api.coinalyze.net/v1"


# ── Coinglass ──────────────────────────────────────────────────────────────────

async def get_coinglass_oi(
    symbol: str = "BTC",
    interval: str = "4h",
    start_date: Optional[str] = None,
    end_date: Optional[str] = None,
) -> pd.DataFrame:
    """
    Fetch Open Interest history from Coinglass.
    Returns DataFrame indexed by UTC timestamp with column 'oi'.
    """
    if not COINGLASS_KEY:
        log.warning("COINGLASS_API_KEY not set — returning empty OI")
        return pd.DataFrame()

    end_ts   = int((datetime.strptime(end_date, "%Y-%m-%d").replace(tzinfo=timezone.utc).timestamp())) if end_date else int(datetime.now(timezone.utc).timestamp())
    start_ts = int((datetime.strptime(start_date, "%Y-%m-%d").replace(tzinfo=timezone.utc).timestamp())) if start_date else end_ts - 90 * 86400

    try:
        async with httpx.AsyncClient(base_url=COINGLASS_BASE, timeout=20.0) as client:
            resp = await client.get(
                "/api/futures/openInterest/history",
                params={
                    "symbol":      symbol,
                    "interval":    interval,
                    "startTime":   start_ts * 1000,
                    "endTime":     end_ts * 1000,
                },
                headers={"CG-API-KEY": COINGLASS_KEY},
            )
            resp.raise_for_status()
            data = resp.json()

        rows = data.get("data", [])
        if not rows:
            return pd.DataFrame()

        df = pd.DataFrame([{
            "time": pd.Timestamp(int(r["t"]), unit="ms", tz="UTC"),
            "oi":   float(r.get("openInterest", r.get("o", 0))),
        } for r in rows]).set_index("time").sort_index()
        log.info("Coinglass OI %s: %d rows", symbol, len(df))
        return df

    except Exception as e:
        log.warning("Coinglass OI fetch failed: %s", e)
        return pd.DataFrame()


async def get_coinglass_liquidations(
    symbol: str = "BTC",
    interval: str = "4h",
    start_date: Optional[str] = None,
    end_date: Optional[str] = None,
) -> pd.DataFrame:
    """
    Fetch liquidation history from Coinglass.
    Returns DataFrame with columns: liq_long, liq_short (USD notional).
    """
    if not COINGLASS_KEY:
        return pd.DataFrame()

    end_ts   = int((datetime.strptime(end_date, "%Y-%m-%d").replace(tzinfo=timezone.utc).timestamp())) if end_date else int(datetime.now(timezone.utc).timestamp())
    start_ts = int((datetime.strptime(start_date, "%Y-%m-%d").replace(tzinfo=timezone.utc).timestamp())) if start_date else end_ts - 90 * 86400

    try:
        async with httpx.AsyncClient(base_url=COINGLASS_BASE, timeout=20.0) as client:
            resp = await client.get(
                "/api/futures/liquidation/history",
                params={
                    "symbol":    symbol,
                    "interval":  interval,
                    "startTime": start_ts * 1000,
                    "endTime":   end_ts * 1000,
                },
                headers={"CG-API-KEY": COINGLASS_KEY},
            )
            resp.raise_for_status()
            data = resp.json()

        rows = data.get("data", [])
        if not rows:
            return pd.DataFrame()

        df = pd.DataFrame([{
            "time":      pd.Timestamp(int(r["t"]), unit="ms", tz="UTC"),
            "liq_long":  float(r.get("longLiquidationUsd", r.get("buyUsd", 0))),
            "liq_short": float(r.get("shortLiquidationUsd", r.get("sellUsd", 0))),
        } for r in rows]).set_index("time").sort_index()
        log.info("Coinglass Liq %s: %d rows", symbol, len(df))
        return df

    except Exception as e:
        log.warning("Coinglass liquidations fetch failed: %s", e)
        return pd.DataFrame()


# ── Coinalyze ──────────────────────────────────────────────────────────────────

async def get_coinalyze_oi(
    symbol: str = "BTC",
    interval: str = "4hour",
    start_date: Optional[str] = None,
    end_date: Optional[str] = None,
) -> pd.DataFrame:
    """
    Fetch aggregated Open Interest from Coinalyze across all exchanges.
    Returns DataFrame indexed by UTC timestamp with column 'oi'.
    """
    if not COINALYZE_KEY:
        log.warning("COINALYZE_API_KEY not set — returning empty OI")
        return pd.DataFrame()

    end_ts   = int((datetime.strptime(end_date, "%Y-%m-%d").replace(tzinfo=timezone.utc).timestamp())) if end_date else int(datetime.now(timezone.utc).timestamp())
    start_ts = int((datetime.strptime(start_date, "%Y-%m-%d").replace(tzinfo=timezone.utc).timestamp())) if start_date else end_ts - 90 * 86400

    # Coinalyze uses symbols like "BTCUSDT_PERP.A" (aggregated)
    coinalyze_symbol = f"{symbol}USDT_PERP.A"

    try:
        async with httpx.AsyncClient(base_url=COINALYZE_BASE, timeout=20.0) as client:
            resp = await client.get(
                "/open-interest-history",
                params={
                    "symbols":   coinalyze_symbol,
                    "interval":  interval,
                    "from":      start_ts,
                    "to":        end_ts,
                    "convert_to_usd": True,
                },
                headers={"api_key": COINALYZE_KEY},
            )
            resp.raise_for_status()
            data = resp.json()

        if not data or not isinstance(data, list) or not data[0].get("history"):
            return pd.DataFrame()

        rows = data[0]["history"]
        df = pd.DataFrame([{
            "time": pd.Timestamp(int(r["t"]), unit="s", tz="UTC"),
            # Coinalyze returns OHLC OI; use close value
            "oi":   float(r.get("c", r.get("v", 0))),
        } for r in rows]).set_index("time").sort_index()
        log.info("Coinalyze OI %s: %d rows", symbol, len(df))
        return df

    except Exception as e:
        log.warning("Coinalyze OI fetch failed: %s", e)
        return pd.DataFrame()


async def get_best_oi(symbol: str = "BTC", start_date: Optional[str] = None, end_date: Optional[str] = None) -> pd.DataFrame:
    """Coinalyze is primary (reliable); Coinglass as fallback."""
    df = await get_coinalyze_oi(symbol, start_date=start_date, end_date=end_date)
    if df.empty:
        df = await get_coinglass_oi(symbol, start_date=start_date, end_date=end_date)
    return df


async def get_best_liquidations(symbol: str = "BTC", start_date: Optional[str] = None, end_date: Optional[str] = None) -> pd.DataFrame:
    """Liquidation data from Coinglass (Coinalyze doesn't provide liquidations)."""
    return await get_coinglass_liquidations(symbol, start_date=start_date, end_date=end_date)
