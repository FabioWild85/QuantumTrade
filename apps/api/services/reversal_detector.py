"""
ReversalZoneDetector — identifica zone di top/bottom con alta probabilità.
Calcola un reversal_score aggregando 7 componenti indipendenti pesati.
Operativamente separato dal trend-following: non modifica DecisionEngine.
Stateless: ogni chiamata a score() legge solo l'ultima barra del DataFrame.
"""

import logging
from dataclasses import dataclass, field
from typing import Optional

import numpy as np
import pandas as pd

log = logging.getLogger(__name__)


@dataclass
class ReversalResult:
    score: float                       # 0.0–1.0 aggregato pesato
    direction: Optional[str]           # "long" | "short" | None
    components: dict                   # {"structural": 0.8, "momentum": 0.6, ...}
    component_count: int               # componenti che superano la soglia minima
    reasoning: list[str] = field(default_factory=list)


class ReversalZoneDetector:
    """
    Stateless reversal scorer.
    Accetta il df già arricchito da build_all_features() + un RegimeSignal opzionale.
    Restituisce ReversalResult per l'ultima barra del df.
    """

    WEIGHTS = {
        "structural": 0.22,
        "momentum":   0.20,
        "exhaustion": 0.18,
        "volume":     0.15,
        "regime":     0.12,
        "funding":    0.08,
        "candle":     0.05,
    }

    # ── Punteggi per ogni componente ──────────────────────────────────────────

    def _structural_bear(self, f: dict, cfg) -> float:
        atr = float(f.get("atr_14") or 1.0)
        hits = 0.0
        count = 0

        ob_inside = float(f.get("ob_bear_inside") or 0.0)
        ob_dist   = float(f.get("ob_bear_dist")   or 999.0)
        hits  += ob_inside
        count += 1
        if ob_dist < getattr(cfg, "reversal_ob_dist_max", 2.0):
            hits += 0.5
            count += 0.5

        if float(f.get("fvg_bear") or 0.0) == 1.0:
            hits += 1.0
            count += 1

        swing_high = float(f.get("swing_high_px") or 0.0)
        price      = float(f.get("close") or 0.0)
        if swing_high > 0 and abs(price - swing_high) < getattr(cfg, "reversal_ob_dist_max", 2.0) * atr:
            hits += 1.0
            count += 1

        return min(1.0, hits / max(count, 1))

    def _structural_bull(self, f: dict, cfg) -> float:
        atr = float(f.get("atr_14") or 1.0)
        hits = 0.0
        count = 0

        ob_inside = float(f.get("ob_bull_inside") or 0.0)
        ob_dist   = float(f.get("ob_bull_dist")   or 999.0)
        hits  += ob_inside
        count += 1
        if ob_dist < getattr(cfg, "reversal_ob_dist_max", 2.0):
            hits += 0.5
            count += 0.5

        if float(f.get("fvg_bull") or 0.0) == 1.0:
            hits += 1.0
            count += 1

        swing_low = float(f.get("swing_low_px") or 0.0)
        price     = float(f.get("close") or 0.0)
        if swing_low > 0 and abs(price - swing_low) < getattr(cfg, "reversal_ob_dist_max", 2.0) * atr:
            hits += 1.0
            count += 1

        return min(1.0, hits / max(count, 1))

    def _momentum_bear(self, f: dict) -> float:
        hits = 0.0

        # 4H divergences — local signal (weight 1.0 each)
        if float(f.get("rsi_div_bear")  or 0.0) == 1.0:
            hits += 1.0
        if float(f.get("macd_div_bear") or 0.0) == 1.0:
            hits += 1.0
        if float(f.get("delta_price_div") or 0.0) < -0.5:
            hits += 1.0

        # Daily divergences — structural signal (weight 1.5 each, more reliable)
        # They capture exhaustion of multi-day directional moves (the primary use case).
        d_rsi_div  = float(f.get("d_rsi_div_bear")  or 0.0) == 1.0
        d_macd_div = float(f.get("d_macd_div_bear") or 0.0) == 1.0
        if d_rsi_div:
            hits += 1.5
        if d_macd_div:
            hits += 1.5

        # Normalise over max possible score (3×1.0 + 2×1.5 = 6.0)
        score = hits / 6.0

        # Dual-timeframe confluence boost: both daily AND 4H RSI divergence active
        # simultaneously — the rarest and most reliable setup for this use case.
        if d_rsi_div and float(f.get("rsi_div_bear") or 0.0) == 1.0:
            score = min(1.0, score + 0.20)

        return min(1.0, score)

    def _momentum_bull(self, f: dict) -> float:
        hits = 0.0

        # 4H divergences
        if float(f.get("rsi_div_bull")   or 0.0) == 1.0:
            hits += 1.0
        if float(f.get("macd_div_bull")  or 0.0) == 1.0:
            hits += 1.0
        if float(f.get("delta_price_div") or 0.0) > 0.5:
            hits += 1.0

        # Daily divergences
        d_rsi_div  = float(f.get("d_rsi_div_bull")  or 0.0) == 1.0
        d_macd_div = float(f.get("d_macd_div_bull") or 0.0) == 1.0
        if d_rsi_div:
            hits += 1.5
        if d_macd_div:
            hits += 1.5

        score = hits / 6.0

        # Dual-timeframe confluence boost
        if d_rsi_div and float(f.get("rsi_div_bull") or 0.0) == 1.0:
            score = min(1.0, score + 0.20)

        return min(1.0, score)

    def _exhaustion(self, f: dict, cfg, direction: str = "bear") -> float:
        hits  = 0.0
        count = 5  # added RSI 4H extreme as a 5th sub-check

        consec  = float(f.get("consec_bars") or 0.0)
        adx     = float(f.get("adx_14")      or 0.0)
        adx_l3  = float(f.get("adx_14_lag3") or adx)
        em_dist = abs(float(f.get("ema50_dist") or 0.0))
        ret48   = float(f.get("ret_48") or 0.0)
        rsi_4h  = float(f.get("rsi_14") or 50.0)

        if abs(consec) >= getattr(cfg, "reversal_consec_bars_min", 5):
            hits += 1.0

        adx_peak = getattr(cfg, "reversal_adx_peak_min", 32.0)
        if adx >= adx_peak:
            hits += 1.0 if adx < adx_l3 else 0.5  # declining ADX = stronger signal

        if em_dist > getattr(cfg, "reversal_ema50_dist_extreme", 3.0):
            hits += 1.0

        ret_thr = getattr(cfg, "reversal_ret48_extreme", 0.08)
        if abs(ret48) > ret_thr:
            hits += 1.0

        # RSI 4H extreme gate: for the use case (end of a strong directional move),
        # RSI must be actually overextended. Without this, exhaustion can fire mid-move.
        if direction == "bear" and rsi_4h > 65.0:
            hits += 1.0
        elif direction == "bull" and rsi_4h < 35.0:
            hits += 1.0

        base_score = hits / count

        # ── Amplifiers (additive boosts, capped at 1.0) ─────────────────────────

        # IV: high implied volatility = market prices explosive moves = exhaustion signal
        iv_pct = float(f.get("iv_7d_percentile") or 50.0)
        if iv_pct > getattr(cfg, "reversal_iv_exhaustion_high", 80.0):
            base_score = min(1.0, base_score + 0.15)

        # Daily RSI extreme — directional: overbought confirms top, oversold confirms bottom
        d_rsi      = float(f.get("d_rsi") or 50.0)
        d_rsi_high = getattr(cfg, "reversal_daily_rsi_extreme_high", 75.0)
        d_rsi_low  = getattr(cfg, "reversal_daily_rsi_extreme_low",  25.0)
        if direction == "bear" and d_rsi > d_rsi_high:
            base_score = min(1.0, base_score + 0.20)
        elif direction == "bull" and d_rsi < d_rsi_low:
            base_score = min(1.0, base_score + 0.20)

        # Daily EMA distance — direction-agnostic overextension confirmation
        d_ema_dist = abs(float(f.get("d_ema20_dist") or 0.0))
        if d_ema_dist > getattr(cfg, "reversal_daily_ema_dist_extreme", 4.0):
            base_score = min(1.0, base_score + 0.15)

        return base_score

    def _volume_bear(self, f: dict, cfg) -> float:
        hits = 0.0
        count = 3

        if float(f.get("vol_climax_bear") or 0.0) == 1.0:
            hits += 1.0
        vol_z = float(f.get("vol_z_50") or 0.0)
        if vol_z > getattr(cfg, "reversal_vol_climax_z", 2.0):
            hits += 1.0
        absorption_z = float(f.get("absorption_z") or 0.0)
        if absorption_z > getattr(cfg, "reversal_absorption_z", 1.8):
            hits += 1.0

        return hits / count

    def _volume_bull(self, f: dict, cfg) -> float:
        hits  = 0.0
        count = 3

        if float(f.get("vol_climax_bull") or 0.0) == 1.0:
            hits += 1.0
        vol_z = float(f.get("vol_z_50") or 0.0)
        if vol_z > getattr(cfg, "reversal_vol_climax_z", 2.0):
            hits += 1.0
        # Replaced liq_long_z (unreliable HL data with gaps) with absorption_z:
        # high absorption on a bottom = large volume enters but price doesn't fall further
        # = institutional accumulation, same logic as bear side.
        absorption_z = float(f.get("absorption_z") or 0.0)
        if absorption_z > getattr(cfg, "reversal_absorption_z", 1.8):
            hits += 1.0

        return hits / count

    def _regime(self, f: dict, regime_signal, cfg) -> float:
        hits = 0.0
        count = 3

        transition_risk = (
            float(regime_signal.transition_risk) if regime_signal else
            float(f.get("transition_risk") or 0.0)
        )
        regime_state = (
            regime_signal.regime if regime_signal else
            str(f.get("regime_state") or "neutral")
        )
        bars_in_regime = (
            int(regime_signal.bars_in_regime) if regime_signal else
            int(f.get("bars_in_regime") or 0)
        )

        if transition_risk > getattr(cfg, "reversal_transition_risk_min", 0.55):
            hits += 1.0
        if regime_state == "transition":
            hits += 1.0
        if bars_in_regime > getattr(cfg, "reversal_bars_in_regime_min", 40):
            hits += 1.0

        return hits / count

    def _funding_bear(self, f: dict, cfg) -> float:
        """High positive funding = everyone is long = crowded trade = top risk."""
        hits = 0.0
        thr = getattr(cfg, "reversal_funding_extreme_thr", 0.00025)
        if float(f.get("funding_cum48") or 0.0) > thr * 48:
            hits += 1.0
        if float(f.get("funding_z") or 0.0) > 2.0:
            hits += 1.0
        return hits / 2.0

    def _funding_bull(self, f: dict, cfg) -> float:
        """High negative funding = everyone is short = crowded trade = bottom risk."""
        hits = 0.0
        thr = getattr(cfg, "reversal_funding_extreme_thr", 0.00025)
        if float(f.get("funding_cum48") or 0.0) < -thr * 48:
            hits += 1.0
        if float(f.get("funding_z") or 0.0) < -2.0:
            hits += 1.0
        return hits / 2.0

    def _candle_bear(self, f: dict, cfg) -> float:
        hits = 0.0
        wick_thr = getattr(cfg, "reversal_wick_threshold", 0.60)
        if float(f.get("wick_reject_bear") or 0.0) > wick_thr:
            hits += 1.0
        if float(f.get("stoch_cross_bear") or 0.0) == 1.0:
            hits += 1.0
        return hits / 2.0

    def _candle_bull(self, f: dict, cfg) -> float:
        hits = 0.0
        wick_thr = getattr(cfg, "reversal_wick_threshold", 0.60)
        if float(f.get("wick_reject_bull") or 0.0) > wick_thr:
            hits += 1.0
        if float(f.get("stoch_cross_bull") or 0.0) == 1.0:
            hits += 1.0
        return hits / 2.0

    # ── Aggregazione ──────────────────────────────────────────────────────────

    def score(self, df: pd.DataFrame, regime_signal, cfg) -> ReversalResult:
        f = df.iloc[-1].to_dict()

        bear = {
            "structural": self._structural_bear(f, cfg),
            "momentum":   self._momentum_bear(f),
            "exhaustion": self._exhaustion(f, cfg, direction="bear"),
            "volume":     self._volume_bear(f, cfg),
            "regime":     self._regime(f, regime_signal, cfg),
            "funding":    self._funding_bear(f, cfg),
            "candle":     self._candle_bear(f, cfg),
        }
        bull = {
            "structural": self._structural_bull(f, cfg),
            "momentum":   self._momentum_bull(f),
            "exhaustion": self._exhaustion(f, cfg, direction="bull"),
            "volume":     self._volume_bull(f, cfg),
            "regime":     self._regime(f, regime_signal, cfg),
            "funding":    self._funding_bull(f, cfg),
            "candle":     self._candle_bull(f, cfg),
        }

        bear_total = sum(self.WEIGHTS[c] * bear[c] for c in self.WEIGHTS)
        bull_total = sum(self.WEIGHTS[c] * bull[c] for c in self.WEIGHTS)

        score_thr = getattr(cfg, "reversal_score_threshold", 0.72)
        if bear_total >= bull_total and bear_total >= score_thr:
            direction  = "short"
            score_val  = bear_total
            components = bear
        elif bull_total > bear_total and bull_total >= score_thr:
            direction  = "long"
            score_val  = bull_total
            components = bull
        else:
            direction  = None
            score_val  = max(bear_total, bull_total)
            components = bear if bear_total >= bull_total else bull

        comp_min = getattr(cfg, "reversal_component_min_score", 0.50)
        active   = sum(1 for v in components.values() if v > comp_min)

        reasoning = self._build_reasoning(direction, components, score_val, active, cfg)
        return ReversalResult(
            score          = round(score_val, 4),
            direction      = direction,
            components     = components,
            component_count = active,
            reasoning      = reasoning,
        )

    def _build_reasoning(self, direction, components, score, active, cfg) -> list[str]:
        reasons = []
        comp_min = getattr(cfg, "reversal_component_min_score", 0.50)
        dir_label = direction.upper() if direction else "NO SIGNAL"
        reasons.append(
            f"ReversalScore={score:.3f} dir={dir_label} active_components={active}/7"
        )
        for comp, val in sorted(components.items(), key=lambda x: -x[1]):
            if val > comp_min:
                reasons.append(f"  [{comp}] score={val:.2f} weight={self.WEIGHTS[comp]:.2f}")
        return reasons


# ── Pending reversal helper ───────────────────────────────────────────────────

def build_pending_reversal(
    direction: str,
    candle: dict,
    reversal_result: ReversalResult,
    cfg,
    atr: float,
    bar_idx: int,
) -> Optional[dict]:
    """
    Calcola i parametri del pending reversal (limit-retest mode).
    Restituisce None se il setup non supera il gate R:R minimo.
    """
    if direction == "long":
        wick_extreme = float(candle.get("low", 0.0))
        candle_close = float(candle.get("close", 0.0))
        wick_range   = candle_close - wick_extreme
        if wick_range <= 0:
            return None
        entry_limit  = wick_extreme + wick_range * getattr(cfg, "reversal_retest_wick_pct", 0.50)
        sl           = wick_extreme - getattr(cfg, "reversal_sl_atr_mult", 1.2) * atr
        tp           = candle_close + getattr(cfg, "reversal_tp_atr_mult", 2.5) * atr
    else:  # "short"
        wick_extreme = float(candle.get("high", 0.0))
        candle_close = float(candle.get("close", 0.0))
        wick_range   = wick_extreme - candle_close
        if wick_range <= 0:
            return None
        entry_limit  = wick_extreme - wick_range * getattr(cfg, "reversal_retest_wick_pct", 0.50)
        sl           = wick_extreme + getattr(cfg, "reversal_sl_atr_mult", 1.2) * atr
        tp           = candle_close - getattr(cfg, "reversal_tp_atr_mult", 2.5) * atr

    sl_dist = abs(entry_limit - sl)
    tp_dist = abs(tp - entry_limit)
    if sl_dist <= 0:
        return None

    rr = tp_dist / sl_dist
    rr_min = getattr(cfg, "reversal_rr_min", 1.8)
    if rr < rr_min:
        log.info(
            "Reversal pending skipped: R:R=%.2f < %.1f (entry=%.2f sl=%.2f tp=%.2f)",
            rr, rr_min, entry_limit, sl, tp,
        )
        return None

    return {
        "direction":       direction,
        "entry_limit":     entry_limit,
        "sl":              sl,
        "tp":              tp,
        "wick_extreme":    wick_extreme,
        "wick_range":      wick_range,
        "expiry_bar":      bar_idx + getattr(cfg, "reversal_retest_expiry_bars", 2),
        "signal_bar":      bar_idx,
        "reversal_result": reversal_result,
        "atr_at_signal":   atr,
        "size_factor":     getattr(cfg, "reversal_size_factor", 0.70),
    }
