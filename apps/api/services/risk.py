"""
Risk management service.
SL/TP calculation, position sizing, drawdown guard, heartbeat writer.
Double-layer SL: bot-side + native Hyperliquid SL order.
"""

import asyncio
import logging
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Literal, Optional

from services.supabase_client import get_supabase

log = logging.getLogger(__name__)

Side = Literal["long", "short"]


@dataclass
class TradeParams:
    side: Side
    entry_price: float
    stop_loss: float
    take_profit: float
    size_usd: float
    size_contracts: float
    rr_ratio: float
    atr: float


class RiskManager:
    def __init__(
        self,
        sl_atr_mult: float = 2.0,
        tp_atr_mult: float = 3.5,
        position_size_pct: float = 1.5,
        max_daily_dd_pct: float = 3.0,
        max_consecutive_losses: int = 4,
    ):
        self.sl_atr_mult = sl_atr_mult
        self.tp_atr_mult = tp_atr_mult
        self.position_size_pct = position_size_pct
        self.max_daily_dd_pct = max_daily_dd_pct
        self.max_consecutive_losses = max_consecutive_losses

        self._daily_pnl_pct: float = 0.0
        self._consecutive_losses: int = 0
        self._daily_reset_date: Optional[str] = None

    def update_limits(
        self,
        sl_atr_mult: float,
        tp_atr_mult: float,
        position_size_pct: float,
        max_daily_dd_pct: float,
        max_consecutive_losses: int,
    ) -> None:
        """Update configurable limits in-place without resetting runtime counters."""
        self.sl_atr_mult            = sl_atr_mult
        self.tp_atr_mult            = tp_atr_mult
        self.position_size_pct      = position_size_pct
        self.max_daily_dd_pct       = max_daily_dd_pct
        self.max_consecutive_losses = max_consecutive_losses

    # ── Trade Parameter Calculation ───────────────────────────────────────────

    def calculate_trade_params(
        self,
        side: Side,
        entry_price: float,
        atr: float,
        equity_usd: float,
        c2_p10: Optional[float] = None,
        c2_p90: Optional[float] = None,
        c2_uncertainty: Optional[float] = None,
        dynamic_sl_tp_enabled: bool = False,
        dynamic_sl_tp_blend: float = 0.50,
    ) -> TradeParams:
        atr_sl_dist = self.sl_atr_mult * atr
        atr_tp_dist = self.tp_atr_mult * atr

        if dynamic_sl_tp_enabled and c2_p10 is not None and c2_p90 is not None:
            # Chronos-derived distance from entry to each percentile
            if side == "long":
                c2_sl_dist = max(entry_price - c2_p10, 1e-6)
                c2_tp_dist = max(c2_p90 - entry_price, 1e-6)
            else:
                c2_sl_dist = max(c2_p90 - entry_price, 1e-6)
                c2_tp_dist = max(entry_price - c2_p10, 1e-6)

            # Weighted blend: (1-blend)×ATR + blend×Chronos
            sl_dist = (1.0 - dynamic_sl_tp_blend) * atr_sl_dist + dynamic_sl_tp_blend * c2_sl_dist
            tp_dist = (1.0 - dynamic_sl_tp_blend) * atr_tp_dist + dynamic_sl_tp_blend * c2_tp_dist

            # Floors: SL and TP never narrower than 1×ATR (prevents stop-hunt noise)
            sl_dist = max(sl_dist, 1.0 * atr)
            tp_dist = max(tp_dist, 1.0 * atr)
        else:
            sl_dist = atr_sl_dist
            tp_dist = atr_tp_dist

        # Uncertainty-based size scaling (only when real Chronos data is present)
        size_mult = 1.0
        if dynamic_sl_tp_enabled and c2_uncertainty is not None and c2_uncertainty > 0:
            if c2_uncertainty < 0.02:
                size_mult = 1.20   # tight band → high confidence
            elif c2_uncertainty < 0.04:
                size_mult = 1.00
            elif c2_uncertainty < 0.06:
                size_mult = 0.75
            else:
                size_mult = 0.50   # wide band → high uncertainty

        if side == "long":
            stop_loss   = entry_price - sl_dist
            take_profit = entry_price + tp_dist
        else:
            stop_loss   = entry_price + sl_dist
            take_profit = entry_price - tp_dist

        # Risk-based sizing: position_size_pct = % of equity AT RISK per trade.
        sl_pct   = sl_dist / entry_price if entry_price > 0 else 0.02
        risk_usd = equity_usd * (self.position_size_pct / 100) * size_mult
        size_usd = risk_usd / sl_pct if sl_pct > 1e-6 else risk_usd

        size_contracts = size_usd / entry_price
        rr_ratio       = tp_dist / sl_dist

        log.info(
            f"Trade params: {side.upper()} entry={entry_price:.2f} "
            f"SL={stop_loss:.2f} TP={take_profit:.2f} "
            f"size=${size_usd:.0f} ({size_contracts:.4f} BTC) R:R={rr_ratio:.2f}"
            + (f" [adaptive: uncertainty={c2_uncertainty:.3f} size_mult={size_mult:.2f}]"
               if dynamic_sl_tp_enabled and c2_uncertainty is not None else "")
        )
        return TradeParams(
            side=side,
            entry_price=entry_price,
            stop_loss=stop_loss,
            take_profit=take_profit,
            size_usd=size_usd,
            size_contracts=size_contracts,
            rr_ratio=rr_ratio,
            atr=atr,
        )

    # ── Guards ────────────────────────────────────────────────────────────────

    def _reset_daily_if_needed(self):
        today = datetime.now(timezone.utc).date().isoformat()
        if self._daily_reset_date != today:
            self._daily_pnl_pct = 0.0
            self._daily_reset_date = today
            log.info("Daily PnL counter reset")

    def can_trade(self) -> tuple[bool, str]:
        """Returns (allowed, reason). Call before every new position."""
        self._reset_daily_if_needed()

        if self._daily_pnl_pct <= -self.max_daily_dd_pct:
            return False, f"Max daily drawdown reached: {self._daily_pnl_pct:.2f}%"

        if self._consecutive_losses >= self.max_consecutive_losses:
            return False, f"Max consecutive losses: {self._consecutive_losses}"

        return True, "ok"

    def record_trade_result(self, pnl_pct: float):
        """Called by execution engine after a trade closes."""
        self._daily_pnl_pct += pnl_pct
        if pnl_pct < 0:
            self._consecutive_losses += 1
        else:
            self._consecutive_losses = 0
        log.info(f"Trade result recorded: {pnl_pct:+.2f}% | daily={self._daily_pnl_pct:.2f}% | consec_losses={self._consecutive_losses}")

    # ── SL Check (bot-side) ───────────────────────────────────────────────────

    def should_stop_loss(self, side: Side, current_price: float, stop_loss: float) -> bool:
        """Bot-side SL check (secondary layer; HL native SL is primary)."""
        if side == "long":
            return current_price <= stop_loss
        return current_price >= stop_loss

    def should_take_profit(self, side: Side, current_price: float, take_profit: float) -> bool:
        if side == "long":
            return current_price >= take_profit
        return current_price <= take_profit

    # ── Heartbeat ─────────────────────────────────────────────────────────────

    async def write_heartbeat(self, bot_id: str = "default"):
        """Updates last_heartbeat in Supabase every loop cycle."""
        try:
            db = get_supabase()
            now = datetime.now(timezone.utc).isoformat()
            db.table("bot_configs").update({"last_heartbeat": now}).eq("name", bot_id).execute()
        except Exception as e:
            log.warning(f"Heartbeat write failed: {e}")
