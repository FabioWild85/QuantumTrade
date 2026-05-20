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
        ensemble_pct: float = 0.0,
        reasoning: Optional[list] = None,
    ):
        emoji = "📈" if side == "long" else "📉"
        lines = [
            f"{emoji} <b>TRADE APERTO — {side.upper()} {symbol}</b>",
            f"Entry:    <code>${entry_price:,.2f}</code>",
            f"Size:     <code>${size_usd:,.0f}</code>",
            f"SL:       <code>${stop_loss:,.2f}</code>",
            f"TP:       <code>${take_profit:,.2f}</code>",
            f"R:R:      <code>{rr:.2f}</code>",
            f"Ensemble: <code>{ensemble_pct:.1f}%</code>",
            f"P(dir):   <code>{dir_prob:.1%}</code>",
            f"ID:       <code>{inference_id}</code>",
        ]
        if reasoning:
            # Show last 3 decision lines (most specific context)
            sig_lines = [r for r in reasoning if r] [-3:]
            lines.append(f"\n<b>Segnali:</b>")
            for r in sig_lines:
                lines.append(f"• <i>{r}</i>")
        await self._send("\n".join(lines))

    async def send_trade_closed(
        self,
        side: str,
        symbol: str,
        pnl_usd: float,
        pnl_pct: float,
        reason: str,
        holding_hours: float,
        equity_usd: float = 0.0,
        partial_pnl_usd: float = 0.0,
    ):
        total_pnl = pnl_usd + partial_pnl_usd
        emoji = "✅" if total_pnl >= 0 else "❌"
        sign  = "+" if total_pnl >= 0 else ""
        reason_labels = {
            "stop_loss":    "Stop Loss",
            "take_profit":  "Take Profit",
            "manual":       "Chiusura manuale",
            "lgbm_exit":    "LightGBM Exit",
            "max_hold_bars": "Max Hold Time",
            "kill":         "Kill Switch",
            "macro_pause":  "Pausa Macro Evento",
        }
        reason_label = reason_labels.get(reason, reason)
        lines = [
            f"{emoji} <b>TRADE CHIUSO — {side.upper()} {symbol}</b>",
            f"PnL close:  <code>{sign}${pnl_usd:,.2f} ({sign}{pnl_pct:.2f}%)</code>",
        ]
        if partial_pnl_usd != 0.0:
            sp = "+" if partial_pnl_usd >= 0 else ""
            st = "+" if total_pnl >= 0 else ""
            lines.append(f"PnL parziale: <code>{sp}${partial_pnl_usd:,.2f}</code>")
            lines.append(f"PnL totale:   <code>{st}${total_pnl:,.2f}</code>")
        lines += [
            f"Motivo:     <code>{reason_label}</code>",
            f"Durata:     <code>{holding_hours:.1f}h</code>",
        ]
        if equity_usd > 0:
            lines.append(f"Equity:     <code>${equity_usd:,.2f}</code>")
        await self._send("\n".join(lines))

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

    async def send_partial_tp(
        self,
        side: str,
        symbol: str,
        pct: float,
        price: float,
        pnl_usd: float,
        pnl_pct: float,
        remaining_usd: float,
        new_sl: float,
    ):
        sign = "+" if pnl_usd >= 0 else ""
        await self._send(
            f"⚡ <b>PARTIAL TP ESEGUITO — {side.upper()} {symbol}</b>\n"
            f"Eseguito:  <code>{pct:.0f}% @ ${price:,.2f}</code>\n"
            f"PnL leg:   <code>{sign}${pnl_usd:,.2f} ({sign}{pnl_pct:.2f}%)</code>\n"
            f"Restante:  <code>${remaining_usd:,.0f}</code>\n"
            f"SL → BE:   <code>${new_sl:,.2f}</code>"
        )

    async def send_sl_moved(
        self,
        side: str,
        symbol: str,
        old_sl: float,
        new_sl: float,
        high_water: float,
        reason: str = "trailing",
    ):
        diff = new_sl - old_sl if side == "long" else old_sl - new_sl
        sign = "+" if diff >= 0 else ""
        await self._send(
            f"🔔 <b>TRAILING SL AGGIORNATO — {side.upper()} {symbol}</b>\n"
            f"SL prec.:  <code>${old_sl:,.2f}</code>\n"
            f"Nuovo SL:  <code>${new_sl:,.2f} ({sign}${abs(diff):,.0f})</code>\n"
            f"High water: <code>${high_water:,.2f}</code>"
        )

    async def send_breakeven_sl(
        self,
        side: str,
        symbol: str,
        entry_price: float,
    ):
        await self._send(
            f"🔒 <b>BREAKEVEN SL ATTIVATO — {side.upper()} {symbol}</b>\n"
            f"SL → entry: <code>${entry_price:,.2f}</code>\n"
            f"<i>Trade ora a rischio zero</i>"
        )

    async def send_signal_blocked_opposite(
        self,
        signal_side: str,
        open_side: str,
        ensemble_pct: float,
        reasoning: list,
        mark_price: float = 0.0,
        dir_prob: float = 0.0,
        hyp_sl: float = 0.0,
        hyp_tp: float = 0.0,
        hyp_rr: float = 0.0,
    ):
        last_reason = reasoning[-1] if reasoning else "—"
        await self._send(
            f"⚠️ <b>SEGNALE CONTRARIO BLOCCATO — {signal_side.upper()}</b>\n"
            f"Pos. aperta:  <code>{open_side.upper()}</code>\n"
            f"Entry (ip.):  <code>${mark_price:,.2f}</code>\n"
            f"SL (ip.):     <code>${hyp_sl:,.2f}</code>\n"
            f"TP (ip.):     <code>${hyp_tp:,.2f}</code>\n"
            f"R:R (ip.):    <code>{hyp_rr:.2f}</code>\n"
            f"Ensemble:     <code>{ensemble_pct:.1f}%</code>\n"
            f"P(dir):       <code>{dir_prob:.1%}</code>\n"
            f"Motivo:       <code>{last_reason}</code>\n"
            f"<i>Segnale ignorato — posizione {open_side.upper()} in corso</i>"
        )

    async def send_macro_pause_start(self, event_name: str, window_min: int):
        await self._send(
            f"⏸ <b>PAUSA MACRO ATTIVATA</b>\n"
            f"Evento:   <code>{event_name}</code>\n"
            f"Finestra: <code>±{window_min} min</code>\n"
            f"<i>Nuove aperture bloccate durante la finestra evento</i>"
        )

    async def send_macro_pause_end(self, event_name: str):
        await self._send(
            f"▶️ <b>PAUSA MACRO TERMINATA</b>\n"
            f"Evento: <code>{event_name}</code>\n"
            f"<i>Bot ripreso — aperture normali al prossimo ciclo</i>"
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
