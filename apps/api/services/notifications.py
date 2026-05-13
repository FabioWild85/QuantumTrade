"""
Telegram notification service.
All templates match the roadmap spec: bot started, trade opened/closed, error, killed.
"""

import asyncio
import logging
import os
from datetime import datetime, timezone
from typing import Optional

import httpx

log = logging.getLogger(__name__)

TELEGRAM_BOT_TOKEN = os.getenv("TELEGRAM_BOT_TOKEN", "")
TELEGRAM_CHAT_ID   = os.getenv("TELEGRAM_CHAT_ID", "")
TG_API = "https://api.telegram.org"


class TelegramNotifier:
    def __init__(self):
        self._token = TELEGRAM_BOT_TOKEN
        self._chat  = TELEGRAM_CHAT_ID

    def _enabled(self) -> bool:
        return bool(self._token and self._chat)

    async def _send(self, text: str):
        if not self._enabled():
            log.info(f"[TELEGRAM STUB] {text}")
            return
        try:
            async with httpx.AsyncClient() as client:
                await client.post(
                    f"{TG_API}/bot{self._token}/sendMessage",
                    json={
                        "chat_id": self._chat,
                        "text": text,
                        "parse_mode": "HTML",
                    },
                    timeout=10.0,
                )
        except Exception as e:
            log.warning(f"Telegram send failed: {e}")

    # ── Message templates ─────────────────────────────────────────────────────

    async def send_bot_started(self, mode: str):
        now = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC")
        await self._send(
            f"🟢 <b>AI Trading Hub — AVVIATO</b>\n"
            f"Mode: <code>{mode.upper()}</code>\n"
            f"Time: {now}"
        )

    async def send_bot_stopped(self, reason: str = "manual"):
        await self._send(
            f"⏹ <b>AI Trading Hub — FERMATO</b>\n"
            f"Motivo: <code>{reason}</code>"
        )

    async def send_trade_opened(
        self,
        side: str,
        symbol: str,
        size_usd: float,
        entry_price: float,
        stop_loss: float,
        take_profit: float,
        rr: float,
        dir_prob: float,
        inference_id: str,
    ):
        emoji = "📈" if side == "long" else "📉"
        await self._send(
            f"{emoji} <b>TRADE APERTO — {side.upper()} {symbol}</b>\n"
            f"Entry:    <code>${entry_price:,.2f}</code>\n"
            f"Size:     <code>${size_usd:,.0f}</code>\n"
            f"SL:       <code>${stop_loss:,.2f}</code>\n"
            f"TP:       <code>${take_profit:,.2f}</code>\n"
            f"R:R:      <code>{rr:.2f}</code>\n"
            f"P(dir):   <code>{dir_prob:.1%}</code>\n"
            f"ID:       <code>{inference_id}</code>"
        )

    async def send_trade_closed(
        self,
        side: str,
        symbol: str,
        pnl_usd: float,
        pnl_pct: float,
        reason: str,
        holding_hours: float,
    ):
        emoji = "✅" if pnl_usd >= 0 else "❌"
        sign  = "+" if pnl_usd >= 0 else ""
        await self._send(
            f"{emoji} <b>TRADE CHIUSO — {side.upper()} {symbol}</b>\n"
            f"PnL:      <code>{sign}${pnl_usd:,.2f} ({sign}{pnl_pct:.2f}%)</code>\n"
            f"Motivo:   <code>{reason}</code>\n"
            f"Durata:   <code>{holding_hours:.1f}h</code>"
        )

    async def send_error(self, error: str, context: str = ""):
        await self._send(
            f"⚠️ <b>AI Trading Hub — ERRORE</b>\n"
            f"Contesto: <code>{context}</code>\n"
            f"Errore:   <code>{error[:400]}</code>"
        )

    async def send_kill_alert(self, details: dict):
        await self._send(
            f"🔴 <b>AI Trading Hub — KILL SWITCH ATTIVATO</b>\n"
            f"Ordini cancellati: <code>{details.get('orders_cancelled', 0)}</code>\n"
            f"Posizioni chiuse: <code>{details.get('positions_closed', 0)}</code>"
        )

    async def send_heartbeat_missing(self, last_seen_ago_hours: float):
        await self._send(
            f"💔 <b>HEARTBEAT MANCANTE</b>\n"
            f"Ultimo heartbeat: <code>{last_seen_ago_hours:.1f}h fa</code>\n"
            f"Il bot potrebbe essere bloccato. Verifica immediatamente."
        )

    async def send_daily_summary(
        self,
        date: str,
        equity: float,
        daily_pnl_pct: float,
        trades_today: int,
        win_rate: float,
    ):
        sign = "+" if daily_pnl_pct >= 0 else ""
        emoji = "📊"
        await self._send(
            f"{emoji} <b>Daily Summary — {date}</b>\n"
            f"Equity:   <code>${equity:,.2f}</code>\n"
            f"PnL:      <code>{sign}{daily_pnl_pct:.2f}%</code>\n"
            f"Trades:   <code>{trades_today}</code>\n"
            f"Win rate: <code>{win_rate:.1%}</code>"
        )
