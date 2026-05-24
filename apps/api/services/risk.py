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
        recalibrated_uncertainty_thresholds: bool = True,
        p10_sl_floor_enabled: bool = False,
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

        # ── P10 SL Floor (Fase 5) ─────────────────────────────────────────────
        # Tighten SL using Chronos quantile as a probabilistic floor.
        # For long: if p10 > ATR-based SL, use p10 (Chronos says 90% of outcomes above p10).
        # For short: if p90 < ATR-based SL, use p90.
        # Safety cap: sl_dist never < 0.5×ATR to prevent position-size explosion.
        p10_floor_applied = False
        if p10_sl_floor_enabled and c2_p10 is not None and c2_p90 is not None:
            if side == "long":
                p10_sl = entry_price - sl_dist          # current SL price
                if c2_p10 > p10_sl and c2_p10 < entry_price:
                    candidate_dist = entry_price - c2_p10
                    sl_dist = max(candidate_dist, 0.5 * atr)
                    p10_floor_applied = True
            else:
                p90_sl = entry_price + sl_dist          # current SL price
                if c2_p90 < p90_sl and c2_p90 > entry_price:
                    candidate_dist = c2_p90 - entry_price
                    sl_dist = max(candidate_dist, 0.5 * atr)
                    p10_floor_applied = True

        # Uncertainty-based size scaling (only when real Chronos data is present).
        # Two calibrations selectable at runtime:
        #   recalibrated=True  → thresholds fitted on real BTC 4h data (2.5%–4.6% range)
        #   recalibrated=False → original theoretical thresholds (for comparison / backtest)
        size_mult = 1.0
        if dynamic_sl_tp_enabled and c2_uncertainty is not None and c2_uncertainty > 0:
            if recalibrated_uncertainty_thresholds:
                # Calibrated on observed distribution — all four buckets reachable
                if c2_uncertainty < 0.030:
                    size_mult = 1.20
                elif c2_uncertainty < 0.042:
                    size_mult = 1.00
                elif c2_uncertainty < 0.055:
                    size_mult = 0.75
                else:
                    size_mult = 0.50
            else:
                # Original theoretical thresholds (kept for backtest comparison)
                if c2_uncertainty < 0.02:
                    size_mult = 1.20
                elif c2_uncertainty < 0.04:
                    size_mult = 1.00
                elif c2_uncertainty < 0.06:
                    size_mult = 0.75
                else:
                    size_mult = 0.50

        # ── Guard B1: P10 floor + uncertainty size boost interaction ─────────
        # When P10 tightens the SL and size_mult > 1.0 (low uncertainty boost),
        # risk-based sizing automatically increases position size (smaller sl_pct).
        # These two amplify each other — log a warning for transparency.
        if p10_floor_applied and size_mult > 1.0:
            log.warning(
                "Guard B1: P10 SL floor tightened SL (sl_dist=%.4f atr=%.4f) "
                "AND uncertainty size_mult=%.2f — position may be larger than expected. "
                "Consider disabling one or using conservative settings.",
                sl_dist, atr, size_mult,
            )

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
            + (" [P10 SL floor applied]" if p10_floor_applied else "")
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


# ── Structural SL helper (shared by live execution and backtesting) ────────────

def apply_structural_sl(
    params: TradeParams,
    features: dict,
    entry_price: float,
    ob_proximity_atr: float = 2.0,
    ob_buffer_pct: float = 0.3,
) -> tuple[bool, str]:
    """
    Widens params.stop_loss when an active Order Block is within ob_proximity_atr
    ATR units of entry in the SL direction, placing the SL ob_buffer_pct beyond
    the OB absolute price level.

    ob_dist fields are ATR-normalized (not percentage); ob_proximity_atr is the
    max distance in ATR units to trigger the override.

    Only ever widens — never tightens — the SL.
    Rescales params.size_usd and params.size_contracts proportionally to keep
    dollar risk constant after the SL adjustment.

    Returns (applied: bool, log_msg: str) for caller logging/reasoning.
    Modifies params in-place.
    """
    is_short = params.side == "short"
    orig_sl  = params.stop_loss

    if is_short:
        ob_active = float(features.get("ob_bear_active") or 0)
        ob_dist   = features.get("ob_bear_dist")    # ATR-normalized distance above entry
        ob_inside = float(features.get("ob_bear_inside") or 0)
        ob_top_px = features.get("ob_bear_top_px")  # absolute top price of the bear OB
        _ob_dist_f  = float(ob_dist)  if ob_dist  is not None else -1.0
        _ob_top_f   = float(ob_top_px) if ob_top_px is not None else 0.0
        if (
            ob_active == 1.0
            and ob_inside == 0.0
            and 0 < _ob_dist_f < ob_proximity_atr   # within N ATR
            and _ob_top_f > 0                        # valid price level (NaN → 0.0 cast → False)
        ):
            ob_sl = _ob_top_f * (1.0 + ob_buffer_pct / 100.0)
            if ob_sl > params.stop_loss:
                params.stop_loss = ob_sl
                msg = (
                    f"StructuralSL: bear OB top={_ob_top_f:.2f} ({_ob_dist_f:.2f} ATR above) → "
                    f"SL={ob_sl:.2f} (was {orig_sl:.2f})"
                )
                _rescale_size(params, orig_sl, entry_price)
                return True, msg
    else:
        ob_active = float(features.get("ob_bull_active") or 0)
        ob_dist   = features.get("ob_bull_dist")    # ATR-normalized distance below entry
        ob_inside = float(features.get("ob_bull_inside") or 0)
        ob_bot_px = features.get("ob_bull_bot_px")  # absolute bottom price of the bull OB
        _ob_dist_f = float(ob_dist)  if ob_dist  is not None else -1.0
        _ob_bot_f  = float(ob_bot_px) if ob_bot_px is not None else 0.0
        if (
            ob_active == 1.0
            and ob_inside == 0.0
            and 0 < _ob_dist_f < ob_proximity_atr
            and _ob_bot_f > 0
        ):
            ob_sl = _ob_bot_f * (1.0 - ob_buffer_pct / 100.0)
            if ob_sl < params.stop_loss:
                params.stop_loss = ob_sl
                msg = (
                    f"StructuralSL: bull OB bot={_ob_bot_f:.2f} ({_ob_dist_f:.2f} ATR below) → "
                    f"SL={ob_sl:.2f} (was {orig_sl:.2f})"
                )
                _rescale_size(params, orig_sl, entry_price)
                return True, msg

    return False, ""


def _rescale_size(params: TradeParams, orig_sl: float, entry_price: float) -> None:
    """Scale down position size proportionally to a widened SL, keeping dollar risk constant."""
    orig_dist = abs(orig_sl - entry_price)
    new_dist  = abs(params.stop_loss - entry_price)
    if orig_dist > 0 and new_dist > 0:
        scale                 = orig_dist / new_dist
        params.size_usd       *= scale
        params.size_contracts *= scale
