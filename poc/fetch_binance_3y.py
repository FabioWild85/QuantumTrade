"""
Fetch ~3 years of BTC 4H klines + funding rate from Binance (public, no auth).
Saves poc/btc3y_ohlcv.parquet and poc/btc3y_funding.parquet aligned to the 4H index.

Tries USD-M futures (fapi, perp + real funding) first, falls back to spot klines
(api.binance.com) if futures is geo-blocked. Funding is resampled to the 4H grid.
"""

import json
import os
import time
import urllib.request

import numpy as np
import pandas as pd

PDIR = os.path.dirname(os.path.abspath(__file__))
YEARS = 3
NOW_MS = int(time.time() * 1000)
START_MS = NOW_MS - int(YEARS * 365.25 * 24 * 3600 * 1000)

FAPI = "https://fapi.binance.com"
SPOT = "https://api.binance.com"


def _get(url: str):
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.loads(r.read().decode())


def fetch_klines(base: str, path: str, symbol: str, interval: str = "4h"):
    rows = []
    start = START_MS
    while start < NOW_MS:
        url = f"{base}{path}?symbol={symbol}&interval={interval}&startTime={start}&limit=1000"
        data = _get(url)
        if not data:
            break
        rows.extend(data)
        last_open = data[-1][0]
        nxt = last_open + 1
        if nxt <= start:
            break
        start = nxt
        if len(data) < 1000:
            break
        time.sleep(0.25)
    return rows


def fetch_funding(symbol: str):
    rows = []
    start = START_MS
    while start < NOW_MS:
        url = f"{FAPI}/fapi/v1/fundingRate?symbol={symbol}&startTime={start}&limit=1000"
        data = _get(url)
        if not data:
            break
        rows.extend(data)
        last_t = data[-1]["fundingTime"]
        nxt = last_t + 1
        if nxt <= start:
            break
        start = nxt
        if len(data) < 1000:
            break
        time.sleep(0.25)
    return rows


def main():
    base, path, src = FAPI, "/fapi/v1/klines", "futures"
    try:
        klines = fetch_klines(FAPI, "/fapi/v1/klines", "BTCUSDT")
        if not klines:
            raise RuntimeError("empty futures klines")
    except Exception as e:
        print(f"[warn] futures klines failed ({e}); falling back to spot")
        base, path, src = SPOT, "/api/v3/klines", "spot"
        klines = fetch_klines(SPOT, "/api/v3/klines", "BTCUSDT")

    k = pd.DataFrame(klines, columns=[
        "open_time", "open", "high", "low", "close", "volume",
        "close_time", "qav", "trades", "tbv", "tqv", "ignore",
    ])
    k["open_time"] = pd.to_datetime(k["open_time"], unit="ms", utc=True)
    k = k.set_index("open_time")[["open", "high", "low", "close", "volume"]].astype(float)
    k = k[~k.index.duplicated(keep="first")].sort_index()
    k.to_parquet(os.path.join(PDIR, "btc3y_ohlcv.parquet"))
    print(f"OHLCV ({src}): {len(k)} bars  {k.index.min()} -> {k.index.max()}")

    # Funding (futures only). Resample 8h funding onto the 4H grid.
    try:
        fr = fetch_funding("BTCUSDT")
        f = pd.DataFrame(fr)
        f["fundingTime"] = pd.to_datetime(f["fundingTime"], unit="ms", utc=True)
        f["fundingRate"] = f["fundingRate"].astype(float)
        f = f.set_index("fundingTime")["fundingRate"].sort_index()
        # Map 8h funding to 4H bars: reindex onto 4H grid, forward-fill, halve
        # so per-4H-bar funding ~ matches the existing HL per-bar convention.
        grid = k.index
        f4 = f.reindex(grid.union(f.index)).sort_index().ffill().reindex(grid)
        funding = pd.DataFrame({"funding": (f4 / 2.0).fillna(0.0), "premium": 0.0})
        funding.to_parquet(os.path.join(PDIR, "btc3y_funding.parquet"))
        print(f"Funding: {len(funding)} bars (8h->4H resampled)")
    except Exception as e:
        print(f"[warn] funding fetch failed ({e}); writing zero funding")
        funding = pd.DataFrame({"funding": 0.0, "premium": 0.0}, index=k.index)
        funding.to_parquet(os.path.join(PDIR, "btc3y_funding.parquet"))


if __name__ == "__main__":
    main()
