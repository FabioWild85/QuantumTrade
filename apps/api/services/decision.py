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
    ):
        self.directional_threshold = directional_threshold
        self.adx_gate = adx_gate
        self.confluence_gate = confluence_gate
        self.adx_gate_enabled = adx_gate_enabled
        self.sweep_gate_enabled = sweep_gate_enabled

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

        dir_prob = c2_output.get("c2_dir_prob", 0.5)
        p10      = c2_output.get("c2_p10", current_price)
        p50      = c2_output.get("c2_p50", current_price)
        p90      = c2_output.get("c2_p90", current_price)

        # ── Gating Level 1: ADX / volatility regime ──────────────────────────
        if self.adx_gate_enabled and adx < self.adx_gate:
            reasoning.append(f"GATE: ADX {adx:.1f} < {self.adx_gate} — market compressing, no-trade")
            return self._no_trade(reasoning, dir_prob, p10, p50, p90, features)

        # ── Gating Level 2: Liquidity sweep (potential reversal) ─────────────
        if self.sweep_gate_enabled and sweep == 1.0:
            reasoning.append("GATE: Liquidity sweep in last candle — waiting for direction confirmation")
            return self._no_trade(reasoning, dir_prob, p10, p50, p90, features)

        # ── Ensemble probability (Chronos-2 + LightGBM blend) ────────────────
        # Weighted blend: 60% LightGBM (trained), 40% Chronos-2 (zero-shot prior)
        ensemble_prob = 0.60 * lgbm_prob + 0.40 * dir_prob
        reasoning.append(f"Ensemble P(up): {ensemble_prob:.3f} (LGBM={lgbm_prob:.3f}, C2={dir_prob:.3f})")

        # ── MTF alignment bonus: if daily trend agrees, lower threshold ───────
        effective_threshold = self.directional_threshold
        if d_regime == 1 and ensemble_prob > 0.5:
            effective_threshold -= 0.02
            reasoning.append(f"MTF: Daily bull regime — threshold relaxed to {effective_threshold:.2f}")
        elif d_regime == -1 and ensemble_prob < 0.5:
            effective_threshold -= 0.02
            reasoning.append(f"MTF: Daily bear regime — short threshold relaxed to {effective_threshold:.2f}")

        # ── Confluence gate ───────────────────────────────────────────────────
        if confluence_score is not None and confluence_score < self.confluence_gate:
            reasoning.append(f"GATE: Confluence {confluence_score:.0f} < {self.confluence_gate:.0f}")
            return self._no_trade(reasoning, dir_prob, p10, p50, p90, features)

        # ── Long signal ───────────────────────────────────────────────────────
        if ensemble_prob > effective_threshold:
            # Anti-FVG filter: don't enter long into a bearish FVG zone overhead
            if fvg_bear == 1.0:
                reasoning.append("FILTER: Bearish FVG detected overhead — skipping long entry")
                return self._no_trade(reasoning, dir_prob, p10, p50, p90, features)
            # Pessimistic scenario must be positive
            if p10 < current_price * 0.995:
                reasoning.append(f"FILTER: p10 ({p10:.1f}) < current price — risk too wide for long")
                return self._no_trade(reasoning, dir_prob, p10, p50, p90, features)

            reasoning.append(f"LONG: P(up)={ensemble_prob:.3f} > {effective_threshold:.2f}, p10={p10:.1f} ≥ price")
            return DecisionResult(
                action="long",
                confidence=ensemble_prob,
                reasoning=reasoning,
                features_snapshot=features,
                directional_prob=dir_prob,
                forecast_p10=p10,
                forecast_p50=p50,
                forecast_p90=p90,
            )

        # ── Short signal ──────────────────────────────────────────────────────
        short_prob = 1.0 - ensemble_prob
        if short_prob > effective_threshold:
            if fvg_bull == 1.0:
                reasoning.append("FILTER: Bullish FVG detected below — skipping short entry")
                return self._no_trade(reasoning, dir_prob, p10, p50, p90, features)
            if p90 > current_price * 1.005:
                reasoning.append(f"FILTER: p90 ({p90:.1f}) > current price — risk too wide for short")
                return self._no_trade(reasoning, dir_prob, p10, p50, p90, features)

            reasoning.append(f"SHORT: P(down)={short_prob:.3f} > {effective_threshold:.2f}")
            return DecisionResult(
                action="short",
                confidence=short_prob,
                reasoning=reasoning,
                features_snapshot=features,
                directional_prob=dir_prob,
                forecast_p10=p10,
                forecast_p50=p50,
                forecast_p90=p90,
            )

        # ── No signal ─────────────────────────────────────────────────────────
        reasoning.append(f"NO-TRADE: P(up)={ensemble_prob:.3f} in neutral zone [{1-effective_threshold:.2f}–{effective_threshold:.2f}]")
        return self._no_trade(reasoning, dir_prob, p10, p50, p90, features)

    def _no_trade(self, reasoning, dir_prob, p10, p50, p90, features) -> DecisionResult:
        return DecisionResult(
            action="no_trade",
            confidence=0.0,
            reasoning=reasoning,
            features_snapshot=features,
            directional_prob=dir_prob,
            forecast_p10=p10,
            forecast_p50=p50,
            forecast_p90=p90,
        )
