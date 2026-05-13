"""
Hyperliquid data service.
Fetches OHLCV (multi-tf), OI, Funding, Liquidations from Hyperliquid REST + WebSocket.
Primary data source for all features — no Binance dependency.
"""

import asyncio
import logging
import os
import time
from datetime import datetime, timezone, timedelta
from typing import Literal, Optional

import httpx
import pandas as pd
import numpy as np
from cryptography.fernet import Fernet

from services.supabase_client import get_supabase

log = logging.getLogger(__name__)

HL_BASE = "https://api.hyperliquid.xyz"
HL_TESTNET = os.getenv("HL_TESTNET", "true").lower() == "true"
ENCRYPTION_KEY = os.getenv("ENCRYPTION_KEY", "")

TimeFrame = Literal["1h", "4h", "1d"]


class HyperliquidData:
    def __init__(self):
        self._client = httpx.AsyncClient(base_url=HL_BASE, timeout=15.0)

    async def _post(self, payload: dict) -> dict:
        resp = await self._client.post("/info", json=payload)
        resp.raise_for_status()
        return resp.json()

    # ── OHLCV ────────────────────────────────────────────────────────────────

    async def get_ohlcv(
        self,
        symbol: str = "BTC",
        interval: TimeFrame = "4h",
        limit: int = 512,
        end_time: Optional[datetime] = None,
    ) -> pd.DataFrame:
        """Fetch OHLCV from Hyperliquid candleSnapshot."""
        interval_ms = {"1h": 3_600_000, "4h": 14_400_000, "1d": 86_400_000}[interval]
        end_ts = int((end_time or datetime.now(timezone.utc)).timestamp() * 1000)
        start_ts = end_ts - limit * interval_ms

        data = await self._post({
            "type": "candleSnapshot",
            "req": {
                "coin": symbol,
                "interval": interval,
                "startTime": start_ts,
                "endTime": end_ts,
            }
        })

        rows = []
        for c in data:
            rows.append({
                "open_time": pd.Timestamp(c["t"], unit="ms", tz="UTC"),
                "open":   float(c["o"]),
                "high":   float(c["h"]),
                "low":    float(c["l"]),
                "close":  float(c["c"]),
                "volume": float(c["v"]),
            })

        df = pd.DataFrame(rows).set_index("open_time").sort_index()
        df = df[~df.index.duplicated(keep="last")]
        log.debug(f"OHLCV {symbol} {interval}: {len(df)} candles")
        return df

    # ── OI, Funding, Mark Price ───────────────────────────────────────────────

    async def get_market_snapshot(self, symbol: str = "BTC") -> dict:
        """Returns OI, funding rate, mark price, oracle price for one symbol."""
        data = await self._post({"type": "metaAndAssetCtxs"})
        meta, ctxs = data[0], data[1]

        coin_idx = next(
            i for i, m in enumerate(meta["universe"]) if m["name"] == symbol
        )
        ctx = ctxs[coin_idx]
        return {
            "symbol":         symbol,
            "mark_price":     float(ctx.get("markPx", 0)),
            "oracle_price":   float(ctx.get("oraclePx", 0)),
            "funding_rate":   float(ctx.get("funding", 0)),
            "open_interest":  float(ctx.get("openInterest", 0)),
            "premium":        float(ctx.get("premium", 0)),
            "timestamp":      datetime.now(timezone.utc).isoformat(),
        }

    # ── Funding History ───────────────────────────────────────────────────────

    async def get_funding_history(
        self, symbol: str = "BTC", hours: int = 48
    ) -> pd.DataFrame:
        end_ts = int(datetime.now(timezone.utc).timestamp() * 1000)
        start_ts = end_ts - hours * 3_600_000

        data = await self._post({
            "type": "fundingHistory",
            "coin": symbol,
            "startTime": start_ts,
        })

        rows = [
            {
                "time": pd.Timestamp(int(d["time"]), unit="ms", tz="UTC"),
                "funding": float(d["fundingRate"]),
                "premium": float(d.get("premium", 0)),
            }
            for d in data
        ]
        return pd.DataFrame(rows).set_index("time").sort_index()

    # ── OI History (REST) ────────────────────────────────────────────────────

    async def get_oi_history(
        self, symbol: str = "BTC", hours: int = 200
    ) -> pd.DataFrame:
        """
        Fetch Open Interest history from Hyperliquid.
        HL doesn't expose a dedicated OI history endpoint; we approximate it
        by polling metaAndAssetCtxs periodically. For historical OI, we use
        the OHLCV candle volume as a proxy feature (build_all_features handles this).
        Returns an empty DataFrame — WS provides live OI via activeAssetCtx.
        """
        return pd.DataFrame()

    # ── Liquidations ─────────────────────────────────────────────────────────

    async def get_recent_liquidations(
        self, symbol: str = "BTC", hours: int = 24
    ) -> dict:
        """
        Liquidation volume is accumulated in real-time via the WS trades channel
        (see HLWebSocket._on_trades). This REST method returns zeros as fallback.
        """
        return {"liq_long_usd": 0.0, "liq_short_usd": 0.0, "hours": hours}

    # ── Agent Wallet ──────────────────────────────────────────────────────────

    async def close(self):
        await self._client.aclose()


async def create_agent_wallet(main_address: str, name: str) -> dict:
    """
    Creates an agent wallet on Hyperliquid (testnet or mainnet).
    Stores encrypted private key in Supabase agent_wallets table.
    """
    from hyperliquid.exchange import Exchange
    from hyperliquid.utils import constants
    import eth_account

    endpoint = constants.TESTNET_API_URL if HL_TESTNET else constants.MAINNET_API_URL

    # Generate fresh keypair
    acct = eth_account.Account.create()
    agent_address = acct.address
    agent_privkey = acct.key.hex()

    # Encrypt private key
    if not ENCRYPTION_KEY:
        raise ValueError("ENCRYPTION_KEY env var not set — cannot store agent wallet securely")
    fernet = Fernet(ENCRYPTION_KEY.encode())
    encrypted = fernet.encrypt(agent_privkey.encode()).decode()

    # Register agent on Hyperliquid
    # exchange = Exchange(acct, endpoint)
    # exchange.approve_agent(agent_address, name)

    db = get_supabase()
    result = db.table("agent_wallets").insert({
        "address": agent_address,
        "encrypted_privkey": encrypted,
        "permissions": {"trading": True, "withdraw": False},
        "main_address": main_address,
        "name": name,
        "network": "testnet" if HL_TESTNET else "mainnet",
    }).execute()

    log.info(f"Agent wallet created: {agent_address} ({'testnet' if HL_TESTNET else 'mainnet'})")
    return {
        "status": "created",
        "agent_address": agent_address,
        "network": "testnet" if HL_TESTNET else "mainnet",
        "name": name,
    }


async def revoke_agent_wallet(agent_id: str) -> dict:
    db = get_supabase()
    db.table("agent_wallets").update({"revoked_at": datetime.now(timezone.utc).isoformat()}).eq("id", agent_id).execute()
    log.info(f"Agent wallet {agent_id} revoked")
    return {"status": "revoked", "agent_id": agent_id}
