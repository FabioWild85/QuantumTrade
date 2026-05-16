"""
Hyperliquid WebSocket client.
Subscribes to candle(4h), trades, activeAssetCtx.
Provides event-driven candle close trigger + real-time CVD / OI accumulation.
"""

import asyncio
import json
import logging
from typing import Optional

import websockets

log = logging.getLogger(__name__)

# Market data feed always connects to mainnet — real prices are needed in both
# paper and live modes. HL_TESTNET controls only order execution (in execution.py),
# not the data feed.
WS_URL = "wss://api.hyperliquid.xyz/ws"
RECONNECT_BASE_S = 5.0
CANDLE_CLOSE_TIMEOUT_S = 14_430.0  # 4h + 30s fallback


class HLWebSocket:
    """
    Persistent WebSocket connection to Hyperliquid.

    Detects 4h candle closes via open_time change and exposes a
    wait_for_candle_close() awaitable that unblocks the execution loop.
    Accumulates CVD (buy vol − sell vol) and OI between cycle reads.
    """

    def __init__(self, symbol: str = "BTC"):
        self.symbol = symbol
        self._running = False
        self._task: Optional[asyncio.Task] = None
        self._connected = asyncio.Event()

        # Candle close queue — items are raw candle dicts
        self._candle_queue: asyncio.Queue = asyncio.Queue()
        self._last_candle_t: int = 0

        # Accumulators — reset by get_snapshot_and_reset()
        self._cvd_delta: float = 0.0        # buy_usd − sell_usd since last read
        self._liq_long_usd: float = 0.0     # USD value of long liquidations
        self._liq_short_usd: float = 0.0    # USD value of short liquidations
        self._latest_oi: float = 0.0
        self._latest_mark: float = 0.0
        self._lock = asyncio.Lock()

    # ── Lifecycle ─────────────────────────────────────────────────────────────

    async def start(self):
        self._running = True
        self._task = asyncio.create_task(self._run_forever())
        log.info("HLWebSocket started (mainnet data feed)")

    async def stop(self):
        self._running = False
        if self._task:
            self._task.cancel()
        log.info("HLWebSocket stopped")

    @property
    def is_connected(self) -> bool:
        return self._connected.is_set()

    @property
    def latest_mark(self) -> Optional[float]:
        return self._latest_mark if self._latest_mark > 0 else None

    # ── Public interface ──────────────────────────────────────────────────────

    async def wait_for_candle_close(self) -> Optional[dict]:
        """
        Block until the next 4h candle closes (detected by open_time change).
        Falls back to None after CANDLE_CLOSE_TIMEOUT_S so the caller can use
        time-based scheduling as a safety net.
        """
        try:
            return await asyncio.wait_for(
                self._candle_queue.get(), timeout=CANDLE_CLOSE_TIMEOUT_S
            )
        except asyncio.TimeoutError:
            log.warning("WS candle close timeout — time-based fallback will handle this cycle")
            return None

    def get_snapshot_and_reset(self) -> dict:
        """
        Snapshot current accumulators then reset CVD and liquidation counters.
        Called once per cycle, right before building features.
        OI and mark price are NOT reset (they reflect the current live value).
        """
        snapshot = {
            "ws_cvd_delta":     self._cvd_delta,
            "ws_liq_long_usd":  self._liq_long_usd,
            "ws_liq_short_usd": self._liq_short_usd,
            "ws_latest_oi":     self._latest_oi,
            "ws_latest_mark":   self._latest_mark,
        }
        self._cvd_delta = 0.0
        self._liq_long_usd = 0.0
        self._liq_short_usd = 0.0
        return snapshot

    # ── Connection loop ───────────────────────────────────────────────────────

    async def _run_forever(self):
        backoff = RECONNECT_BASE_S
        while self._running:
            try:
                self._connected.clear()
                await self._connect()
                backoff = RECONNECT_BASE_S
            except asyncio.CancelledError:
                break
            except Exception as exc:
                log.error("WS connection error: %s", exc)
                if self._running:
                    log.info("WS reconnecting in %.0fs…", backoff)
                    await asyncio.sleep(backoff)
                    backoff = min(backoff * 2, 60.0)

    async def _connect(self):
        log.info("WS connecting to %s", WS_URL)
        async with websockets.connect(
            WS_URL,
            ping_interval=20,
            ping_timeout=10,
            close_timeout=5,
        ) as ws:
            await self._subscribe(ws)
            self._connected.set()
            log.info("WS subscribed: candle(%s/4h), trades, activeAssetCtx", self.symbol)
            async for raw in ws:
                if not self._running:
                    break
                await self._handle(raw)

    async def _subscribe(self, ws):
        subs = [
            {"type": "candle",         "coin": self.symbol, "interval": "4h"},
            {"type": "trades",         "coin": self.symbol},
            {"type": "activeAssetCtx", "coin": self.symbol},
        ]
        for sub in subs:
            await ws.send(json.dumps({"method": "subscribe", "subscription": sub}))

    # ── Message handling ──────────────────────────────────────────────────────

    async def _handle(self, raw: str):
        try:
            msg = json.loads(raw)
        except json.JSONDecodeError:
            return

        channel = msg.get("channel")
        data    = msg.get("data")
        if data is None:
            return

        if channel == "candle":
            await self._on_candle(data)
        elif channel == "trades":
            await self._on_trades(data)
        elif channel == "activeAssetCtx":
            self._on_asset_ctx(data)

    async def _on_candle(self, data: dict):
        try:
            t = int(data.get("t", 0))
        except (TypeError, ValueError):
            return

        if t == 0:
            return

        if self._last_candle_t == 0:
            # First message — record baseline; don't trigger a cycle yet
            self._last_candle_t = t
            log.debug("WS candle baseline t=%d", t)
        elif t > self._last_candle_t:
            # New candle open time detected → previous candle just closed
            log.info("WS: 4h candle closed (prev_t=%d → new_t=%d)", self._last_candle_t, t)
            self._last_candle_t = t
            await self._candle_queue.put(data)

    async def _on_trades(self, data):
        trades = data if isinstance(data, list) else [data]
        async with self._lock:
            for trade in trades:
                try:
                    px   = float(trade.get("px", 0))
                    sz   = float(trade.get("sz", 0))
                    usd  = px * sz
                    side = trade.get("side", "")

                    if side == "B":
                        self._cvd_delta += usd
                    elif side == "A":
                        self._cvd_delta -= usd

                    # Liquidation flag (present in some HL feed versions)
                    if trade.get("liquidation"):
                        if side == "B":    # short liquidation squeezed upward
                            self._liq_short_usd += usd
                        elif side == "A":  # long liquidation dumped downward
                            self._liq_long_usd += usd
                except (ValueError, TypeError):
                    continue

    def _on_asset_ctx(self, data: dict):
        ctx = data.get("ctx", {})
        try:
            if "openInterest" in ctx:
                self._latest_oi = float(ctx["openInterest"])
            if "markPx" in ctx:
                self._latest_mark = float(ctx["markPx"])
        except (ValueError, TypeError):
            pass
