"""
Decision service — dual gating + long/short/no-trade logic.
Implements the pipeline from roadmap §1.3 with Phase 4 enhanced features.
"""

import logging
from dataclasses import dataclass
from typing import Literal, Optional

import numpy as np
import pandas as pd

log = logging.getLogger(__name__)

Action = Literal["long", "short", "no_trade"]


@dataclass
class DecisionResult:
    action: Action
    confidence: float
    reasoning: list[str]
    features_snapshot: dict
    directional_prob: float
    forecast_p10: float
    forecast_p50: float
    forecast_p90: float
    forecast_uncertainty: float = 0.0


class DecisionEngine:
    """
    Translates model output + features into a trading decision.
    All parameters come from BotConfig (settable via /bot PUT).
    """

    def __init__(
        self,
        directional_threshold: float = 0.62,
        adx_gate: float = 20.0,
        confluence_gate: float = 60.0,
        adx_gate_enabled: bool = True,
        sweep_gate_enabled: bool = True,
        fvg_filter_enabled: bool = True,
        mtf_alignment_enabled: bool = True,
        chronos_weight: float = 0.40,
        c2_uncertainty_gate_enabled: bool = False,
        c2_uncertainty_threshold: float = 0.05,
        c2_cont_prob_gate_enabled: bool = False,
        c2_cont_prob_threshold: float = 0.25,
    ):
        self.directional_threshold       = directional_threshold
        self.adx_gate                    = adx_gate
        self.confluence_gate             = confluence_gate
        self.adx_gate_enabled            = adx_gate_enabled
        self.sweep_gate_enabled          = sweep_gate_enabled
        self.fvg_filter_enabled          = fvg_filter_enabled
        self.mtf_alignment_enabled       = mtf_alignment_enabled
        self.chronos_weight              = chronos_weight
        self.c2_uncertainty_gate_enabled = c2_uncertainty_gate_enabled
        self.c2_uncertainty_threshold    = c2_uncertainty_threshold
        self.c2_cont_prob_gate_enabled   = c2_cont_prob_gate_enabled
        self.c2_cont_prob_threshold      = c2_cont_prob_threshold

    def decide(
        self,
        features: dict,
        c2_output: dict,
        lgbm_prob: float,
        confluence_score: Optional[float] = None,
        current_price: float = 0.0,
    ) -> DecisionResult:
        """
        Args:
            features:         dict of current feature values (from smc.build_all_features)
            c2_output:        dict from ChronosForecaster.forecast()
            lgbm_prob:        LightGBM P(up) from the stacked model
            confluence_score: QT confluence score (0-100), optional
            current_price:    current mark price

        Returns DecisionResult with action and full reasoning audit trail.
        """
        reasoning = []
        adx    = features.get("adx_14", 0.0)
        rv_72  = features.get("rv_72", 0.0)
        sweep  = features.get("sweep", 0.0)
        fvg_bear = features.get("fvg_bear", 0.0)
        fvg_bull = features.get("fvg_bull", 0.0)
        d_regime = features.get("d_regime", 0)

        dir_prob       = c2_output.get("c2_dir_prob", 0.5)
        p10            = c2_output.get("c2_p10", current_price)
        p50            = c2_output.get("c2_p50", current_price)
        p90            = c2_output.get("c2_p90", current_price)
        c2_uncertainty = c2_output.get("c2_uncertainty", 0.0)
        c2_cont_prob   = c2_output.get("c2_cont_prob", 0.0)

        # ── Gating Level 1: ADX / volatility regime ──────────────────────────
        if self.adx_gate_enabled and adx < self.adx_gate:
            reasoning.append(f"GATE: ADX {adx:.1f} < {self.adx_gate} — market compressing, no-trade")
            return self._no_trade(reasoning, dir_prob, p10, p50, p90, features, c2_uncertainty)

        # ── Gating Level 2: Liquidity sweep (potential reversal) ─────────────
        if self.sweep_gate_enabled and sweep == 1.0:
            reasoning.append("GATE: Liquidity sweep in last candle — waiting for direction confirmation")
            return self._no_trade(reasoning, dir_prob, p10, p50, p90, features, c2_uncertainty)

        # ── Gating Level 3: Chronos-2 uncertainty gate ───────────────────────
        if self.c2_uncertainty_gate_enabled and c2_uncertainty > 0:
            if c2_uncertainty > self.c2_uncertainty_threshold:
                reasoning.append(
                    f"GATE: C2 uncertainty {c2_uncertainty:.3f} > {self.c2_uncertainty_threshold:.3f} "
                    f"— forecast dispersion too wide, no-trade"
                )
                return self._no_trade(reasoning, dir_prob, p10, p50, p90, features, c2_uncertainty)

        # ── Gating Level 4: Chronos-2 continuation coherence gate ────────────
        if self.c2_cont_prob_gate_enabled and c2_cont_prob < self.c2_cont_prob_threshold:
            reasoning.append(
                f"GATE: C2 cont_prob {c2_cont_prob:.2f} < {self.c2_cont_prob_threshold:.2f} "
                f"— forecast paths too incoherent, no-trade"
            )
            return self._no_trade(reasoning, dir_prob, p10, p50, p90, features, c2_uncertainty)

        # ── Ensemble probability (Chronos-2 + LightGBM blend) ────────────────
        lgbm_weight   = 1.0 - self.chronos_weight
        ensemble_prob = lgbm_weight * lgbm_prob + self.chronos_weight * dir_prob
        reasoning.append(
            f"Ensemble P(up): {ensemble_prob:.3f} "
            f"(LGBM×{lgbm_weight:.2f}={lgbm_prob:.3f}, C2×{self.chronos_weight:.2f}={dir_prob:.3f})"
        )

        # ── MTF alignment bonus: if daily trend agrees, lower threshold ───────
        effective_threshold = self.directional_threshold
        if self.mtf_alignment_enabled:
            if d_regime == 1 and ensemble_prob > 0.5:
                effective_threshold -= 0.02
                reasoning.append(f"MTF: Daily bull regime — threshold relaxed to {effective_threshold:.2f}")
            elif d_regime == -1 and ensemble_prob < 0.5:
                effective_threshold -= 0.02
                reasoning.append(f"MTF: Daily bear regime — short threshold relaxed to {effective_threshold:.2f}")

        # ── Confluence gate ───────────────────────────────────────────────────
        if confluence_score is not None and confluence_score < self.confluence_gate:
            reasoning.append(f"GATE: Confluence {confluence_score:.0f} < {self.confluence_gate:.0f}")
            return self._no_trade(reasoning, dir_prob, p10, p50, p90, features, c2_uncertainty)

        # ── Long signal ───────────────────────────────────────────────────────
        if ensemble_prob > effective_threshold:
            # Anti-FVG filter: don't enter long into a bearish FVG zone overhead
            if self.fvg_filter_enabled and fvg_bear == 1.0:
                reasoning.append("FILTER: Bearish FVG detected overhead — skipping long entry")
                return self._no_trade(reasoning, dir_prob, p10, p50, p90, features, c2_uncertainty)
            # C2 directional confirmation: median forecast must be bullish
            if p50 > 0 and p50 < current_price:
                reasoning.append(f"FILTER: C2 median ({p50:.1f}) below entry — C2 bearish, skipping long")
                return self._no_trade(reasoning, dir_prob, p10, p50, p90, features, c2_uncertainty)

            reasoning.append(f"LONG: P(up)={ensemble_prob:.3f} > {effective_threshold:.2f}, C2_p50={p50:.1f}")
            return DecisionResult(
                action="long",
                confidence=ensemble_prob,
                reasoning=reasoning,
                features_snapshot=features,
                directional_prob=dir_prob,
                forecast_p10=p10,
                forecast_p50=p50,
                forecast_p90=p90,
                forecast_uncertainty=c2_uncertainty,
            )

        # ── Short signal ──────────────────────────────────────────────────────
        short_prob = 1.0 - ensemble_prob
        if short_prob > effective_threshold:
            if self.fvg_filter_enabled and fvg_bull == 1.0:
                reasoning.append("FILTER: Bullish FVG detected below — skipping short entry")
                return self._no_trade(reasoning, dir_prob, p10, p50, p90, features, c2_uncertainty)
            # C2 directional confirmation: median forecast must be bearish
            if p50 > 0 and p50 > current_price:
                reasoning.append(f"FILTER: C2 median ({p50:.1f}) above entry — C2 bullish, skipping short")
                return self._no_trade(reasoning, dir_prob, p10, p50, p90, features, c2_uncertainty)

            reasoning.append(f"SHORT: P(down)={short_prob:.3f} > {effective_threshold:.2f}, C2_p50={p50:.1f}")
            return DecisionResult(
                action="short",
                confidence=short_prob,
                reasoning=reasoning,
                features_snapshot=features,
                directional_prob=dir_prob,
                forecast_p10=p10,
                forecast_p50=p50,
                forecast_p90=p90,
                forecast_uncertainty=c2_uncertainty,
            )

        # ── No signal ─────────────────────────────────────────────────────────
        reasoning.append(f"NO-TRADE: P(up)={ensemble_prob:.3f} in neutral zone [{1-effective_threshold:.2f}–{effective_threshold:.2f}]")
        return self._no_trade(reasoning, dir_prob, p10, p50, p90, features, c2_uncertainty)

    def _no_trade(self, reasoning, dir_prob, p10, p50, p90, features, uncertainty=0.0) -> DecisionResult:
        return DecisionResult(
            action="no_trade",
            confidence=0.0,
            reasoning=reasoning,
            features_snapshot=features,
            directional_prob=dir_prob,
            forecast_p10=p10,
            forecast_p50=p50,
            forecast_p90=p90,
            forecast_uncertainty=uncertainty,
        )


def compute_qt_score(features: dict) -> float:
    """
    Composite 0-100 QT confluence score from available bar features.
    Shared by both the backtest engine and the live execution engine so that
    confluence_gate has an identical effect in both contexts.

    Components:
        ADX trend strength  0-25 pts   (ADX 15→0 / 40→25)
        RSI extremity       0-20 pts   (distance from neutral 50)
        Volume surge        0-20 pts   (vol_ratio > 1× → adds up to 20)
        CVD momentum        0-15 pts   (absolute cvd_slope strength)
        MTF alignment       0-20 pts   (daily regime + 4h/1d alignment)
    """
    score = 0.0

    adx = float(features.get("adx_14") or 0)
    score += min(25.0, max(0.0, (adx - 15.0) * 1.25))

    rsi = float(features.get("rsi_14") or 50)
    score += min(20.0, abs(rsi - 50.0) * 0.5)

    vol_ratio = float(features.get("vol_ratio") or 1)
    score += min(20.0, max(0.0, (vol_ratio - 1.0) * 15.0))

    cvd_slope = float(features.get("cvd_slope") or 0)
    score += min(15.0, abs(cvd_slope) * 10.0)

    if float(features.get("d_regime") or 0) != 0:
        score += 10.0
    if float(features.get("mtf_aligned") or 0) != 0:
        score += 10.0

    return round(min(100.0, max(0.0, score)), 1)
