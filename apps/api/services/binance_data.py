"""
Binance public REST — historical OHLCV.
Used to extend the backtest window beyond Hyperliquid's ~1-year history.
No API key required for OHLCV.
"""

import logging
from datetime import datetime, timezone
from typing import Optional

import httpx
import pandas as pd

log = logging.getLogger(__name__)

BINANCE_BASE = "https://api.binance.com"
_INTERVAL_MAP = {"1h": "1h", "4h": "4h", "1d": "1d"}

# Binance symbol mapping (HL uses BTC, Binance uses BTCUSDT)
_SYMBOL_MAP = {"BTC": "BTCUSDT", "ETH": "ETHUSDT", "SOL": "SOLUSDT"}


async def get_ohlcv_binance(
    symbol: str = "BTC",
    interval: str = "4h",
    start_date: Optional[str] = None,   # "YYYY-MM-DD"
    end_date: Optional[str] = None,
    limit: int = 1000,
) -> pd.DataFrame:
    """
    Fetch historical OHLCV from Binance.
    Returns same schema as HyperliquidData.get_ohlcv().
    Paginates automatically to cover multi-year ranges.
    """
    bn_symbol  = _SYMBOL_MAP.get(symbol, symbol + "USDT")
    bn_interval = _INTERVAL_MAP.get(interval, interval)
    interval_ms = {"1h": 3_600_000, "4h": 14_400_000, "1d": 86_400_000}[interval]

    end_ts   = int((datetime.strptime(end_date, "%Y-%m-%d").replace(tzinfo=timezone.utc).timestamp() * 1000)) if end_date else int(datetime.now(timezone.utc).timestamp() * 1000)
    start_ts = int((datetime.strptime(start_date, "%Y-%m-%d").replace(tzinfo=timezone.utc).timestamp() * 1000)) if start_date else end_ts - limit * interval_ms

    all_rows = []
    cursor   = start_ts

    async with httpx.AsyncClient(base_url=BINANCE_BASE, timeout=20.0) as client:
        while cursor < end_ts:
            resp = await client.get("/api/v3/klines", params={
                "symbol":    bn_symbol,
                "interval":  bn_interval,
                "startTime": cursor,
                "endTime":   end_ts,
                "limit":     1000,
            })
            resp.raise_for_status()
            data = resp.json()
            if not data:
                break

            for c in data:
                all_rows.append({
                    "open_time": pd.Timestamp(int(c[0]), unit="ms", tz="UTC"),
                    "open":   float(c[1]),
                    "high":   float(c[2]),
                    "low":    float(c[3]),
                    "close":  float(c[4]),
                    "volume": float(c[5]),
                })

            last_ts = int(data[-1][0])
            if last_ts <= cursor:
                break
            cursor = last_ts + interval_ms

    if not all_rows:
        log.warning("Binance returned no data for %s %s", symbol, interval)
        return pd.DataFrame(columns=["open", "high", "low", "close", "volume"])

    df = pd.DataFrame(all_rows).set_index("open_time").sort_index()
    df = df[~df.index.duplicated(keep="last")]
    log.info("Binance OHLCV %s %s: %d candles (%s → %s)", symbol, interval, len(df), df.index[0].date(), df.index[-1].date())
    return df
