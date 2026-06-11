"""
Tests for the threshold-floor fix in DecisionEngine.decide().

Bug: accumulated biases (FundingBias + FNG + SweepConf + MTF) could push
threshold_long or threshold_short below 0.50, allowing entries when the model
is neutral or slightly against the trade direction.

Fix: `max(threshold, 0.52)` applied after all bias adjustments and before the
entry comparisons.

These tests verify:
  1. The floor is enforced in every worst-case bias combination.
  2. Normal operation (threshold well above 0.52) is unaffected.
  3. The model-agreement invariant holds: long fires only when P(up) > 0.52,
     short fires only when P(down) > 0.52 (P(up) < 0.48).
"""

import sys
import os
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from services.decision import DecisionEngine


# ── helpers ──────────────────────────────────────────────────────────────────

_NEUTRAL_FEATURES = {
    "adx_14": 30.0, "sweep": 0.0, "fvg_bear": 0.0, "fvg_bull": 0.0,
    "rsi_14": 50.0, "ret_48": 0.0, "d_regime": 0, "d_rsi": 50.0,
    "vol_z_50": 0.0, "regime_state": "neutral",
    "regime_confidence": 0.5, "transition_risk": 0.0,
}

_NEUTRAL_C2 = {
    "c2_dir_prob": 0.5, "c2_p10": 50000.0, "c2_p50": 50000.0,
    "c2_p90": 50000.0, "c2_uncertainty": 0.0, "c2_cont_prob": 1.0,
}

def _engine(**kw) -> DecisionEngine:
    defaults = dict(
        adx_gate_enabled=False,
        sweep_gate_enabled=False,
        fvg_filter_enabled=False,
        mtf_alignment_enabled=False,
        exhaustion_guard_enabled=False,
        absorption_filter_enabled=False,
        confluence_gate=0,       # disable confluence gate
        chronos_weight=0.0,
        regime_bias_enabled=False,
        funding_gate_enabled=False,
        fng_gate_enabled=False,
        c2_inversion_gate_enabled=False,
    )
    defaults.update(kw)
    return DecisionEngine(**defaults)


def _decide(engine: DecisionEngine, lgbm_prob: float,
            avg_funding: float = 0.0, fng: float = 50.0) -> tuple:
    """Returns (action, threshold_long_effective, threshold_short_effective)."""
    covariates = {"fear_greed": fng}
    result = engine.decide(
        features=_NEUTRAL_FEATURES,
        c2_output=_NEUTRAL_C2,
        lgbm_prob=lgbm_prob,
        avg_funding=avg_funding,
        covariates=covariates,
        current_price=50000.0,
    )
    # Extract the effective thresholds from the reasoning log
    for line in result.reasoning:
        if line.startswith("LONG:") or line.startswith("SHORT:") or line.startswith("NO-TRADE:"):
            break
    for line in result.reasoning:
        if "long>" in line:  # NO-TRADE line
            parts = line.split("|")
            long_thr  = float(parts[1].split(">")[1].split(",")[0].strip())
            short_thr = float(parts[1].split("short>")[1].strip())
            return result.action, long_thr, short_thr
    return result.action, None, None


# ════════════════════════════════════════════════════════════════════════════
# 1. Floor enforcement
# ════════════════════════════════════════════════════════════════════════════

class TestThresholdFloor(unittest.TestCase):

    def test_floor_prevents_sub_50_threshold_long(self):
        """
        Without floor, worst-case biases push threshold_long < 0.50.
        With floor, it must stay ≥ 0.52.
        """
        engine = _engine(
            directional_threshold=0.62,
            funding_gate_enabled=True,
            funding_high_thr=0.00010,
            funding_extreme_thr=0.00030,
            funding_bias_delta=0.03,
            fng_gate_enabled=True,
            fng_extreme_fear_thr=20.0,
            fng_bias_delta=0.03,
            mtf_alignment_enabled=True,
            sweep_gate_enabled=True,
            sweep_gate_directional=True,
        )
        # Worst case: extremely negative funding (extreme → ×2 = −0.06),
        # extreme fear FNG (−0.03), MTF alignment (−0.02). No sweep here
        # (sellside sweep requires ensemble_prob > 0.5, which we set below).
        # Total reduction: 0.62 - 0.06 - 0.03 - 0.02 = 0.51 → floor at 0.52.
        #
        # Use a prob that would produce NO-TRADE so we can read the thresholds.
        # P(up) = 0.515 → above floor 0.52? No, so no-trade lets us see the threshold.
        features_mtf = {**_NEUTRAL_FEATURES, "d_regime": 1}  # bull daily for MTF
        avg_fund_neg = -(0.00030 / 8) * 2   # extreme negative per-hour (after /8 normalization)
        result = engine.decide(
            features=features_mtf,
            c2_output=_NEUTRAL_C2,
            lgbm_prob=0.51,
            avg_funding=avg_fund_neg,
            covariates={"fear_greed": 10.0},  # extreme fear
            current_price=50000.0,
        )
        # At p=0.51 with threshold ≥ 0.52, must be no-trade
        self.assertEqual(result.action, "no_trade",
                         "With threshold floor, p=0.51 must not trigger a long "
                         "(threshold pushed to floor 0.52)")

    def test_floor_prevents_sub_50_threshold_short(self):
        """
        Symmetric check for threshold_short with positive funding + extreme greed.
        p(down) = 0.51 (p_up = 0.49) must NOT trigger a short.
        """
        engine = _engine(
            directional_threshold=0.62,
            funding_gate_enabled=True,
            funding_high_thr=0.00010,
            funding_extreme_thr=0.00030,
            funding_bias_delta=0.03,
            fng_gate_enabled=True,
            fng_extreme_greed_thr=80.0,
            fng_bias_delta=0.03,
            mtf_alignment_enabled=True,
        )
        features_mtf = {**_NEUTRAL_FEATURES, "d_regime": -1}  # bear daily for MTF
        avg_fund_pos = (0.00030 / 8) * 2   # extreme positive per-hour
        result = engine.decide(
            features=features_mtf,
            c2_output=_NEUTRAL_C2,
            lgbm_prob=0.49,   # P(up) = 0.49, P(down) = 0.51
            avg_funding=avg_fund_pos,
            covariates={"fear_greed": 90.0},  # extreme greed
            current_price=50000.0,
        )
        self.assertEqual(result.action, "no_trade",
                         "With threshold floor, P(down)=0.51 must not trigger a short")

    def test_floor_value_is_exactly_052(self):
        """Verify the floor is 0.52, not 0.50 or 0.55."""
        engine = _engine(
            directional_threshold=0.62,
            funding_gate_enabled=True,
            funding_high_thr=0.00010,
            funding_extreme_thr=0.00030,
            funding_bias_delta=0.10,  # large delta to definitely push below 0.52
        )
        # Extreme negative funding → threshold_long -= 0.10 * 2 = −0.20 → 0.62-0.20=0.42
        # Floor should clamp to 0.52.
        avg_fund_neg = -(0.00030 / 8) * 2

        # P(up) = 0.53 → just above floor 0.52 → must trigger long
        result_above = engine.decide(
            features=_NEUTRAL_FEATURES,
            c2_output=_NEUTRAL_C2,
            lgbm_prob=0.53,
            avg_funding=avg_fund_neg,
            covariates={"fear_greed": 50.0},
            current_price=50000.0,
        )
        self.assertEqual(result_above.action, "long",
                         "P(up)=0.53 must trigger long (just above floor 0.52)")

        # P(up) = 0.51 → below floor 0.52 → must NOT trigger long
        result_below = engine.decide(
            features=_NEUTRAL_FEATURES,
            c2_output=_NEUTRAL_C2,
            lgbm_prob=0.51,
            avg_funding=avg_fund_neg,
            covariates={"fear_greed": 50.0},
            current_price=50000.0,
        )
        self.assertEqual(result_below.action, "no_trade",
                         "P(up)=0.51 must NOT trigger long (below floor 0.52)")


# ════════════════════════════════════════════════════════════════════════════
# 2. Normal operation unaffected
# ════════════════════════════════════════════════════════════════════════════

class TestNormalOperationUnchanged(unittest.TestCase):
    """Floor must not affect standard operation where threshold stays above 0.52."""

    def test_standard_long_still_fires(self):
        """P(up) = 0.65 > default threshold 0.62 → long must fire."""
        engine = _engine(directional_threshold=0.62)
        result = engine.decide(
            features=_NEUTRAL_FEATURES,
            c2_output=_NEUTRAL_C2,
            lgbm_prob=0.65,
            avg_funding=0.0,
            covariates={"fear_greed": 50.0},
            current_price=50000.0,
        )
        self.assertEqual(result.action, "long")

    def test_standard_short_still_fires(self):
        """P(up) = 0.35 → P(down) = 0.65 > 0.62 → short must fire."""
        engine = _engine(directional_threshold=0.62)
        result = engine.decide(
            features=_NEUTRAL_FEATURES,
            c2_output=_NEUTRAL_C2,
            lgbm_prob=0.35,
            avg_funding=0.0,
            covariates={"fear_greed": 50.0},
            current_price=50000.0,
        )
        self.assertEqual(result.action, "short")

    def test_moderate_bias_below_threshold_still_no_trade(self):
        """
        With a small negative funding bias: threshold_long drops to ~0.59.
        P(up) = 0.57 < 0.59 → still no-trade. Floor doesn't interfere.
        """
        engine = _engine(
            directional_threshold=0.62,
            funding_gate_enabled=True,
            funding_high_thr=0.00010,
            funding_extreme_thr=0.00030,
            funding_bias_delta=0.03,
        )
        avg_fund_neg = -(0.00015 / 8)  # moderate negative, not extreme (multiplier=1)
        result = engine.decide(
            features=_NEUTRAL_FEATURES,
            c2_output=_NEUTRAL_C2,
            lgbm_prob=0.57,
            avg_funding=avg_fund_neg,
            covariates={"fear_greed": 50.0},
            current_price=50000.0,
        )
        self.assertEqual(result.action, "no_trade")

    def test_moderate_bias_above_adjusted_threshold_fires(self):
        """
        Moderate negative funding: threshold_long drops from 0.62 to 0.59.
        P(up) = 0.61 > 0.59 → long fires (floor doesn't block this).
        """
        engine = _engine(
            directional_threshold=0.62,
            funding_gate_enabled=True,
            funding_high_thr=0.00010,
            funding_extreme_thr=0.00030,
            funding_bias_delta=0.03,
        )
        avg_fund_neg = -(0.00015 / 8)  # moderate negative, multiplier=1, delta=0.03
        result = engine.decide(
            features=_NEUTRAL_FEATURES,
            c2_output=_NEUTRAL_C2,
            lgbm_prob=0.61,  # 0.61 > 0.62 - 0.03 = 0.59
            avg_funding=avg_fund_neg,
            covariates={"fear_greed": 50.0},
            current_price=50000.0,
        )
        self.assertEqual(result.action, "long",
                         "Moderate bias should still reduce threshold and allow entry "
                         "when model has sufficient edge")


# ════════════════════════════════════════════════════════════════════════════
# 3. Model-agreement invariant
# ════════════════════════════════════════════════════════════════════════════

class TestModelAgreementInvariant(unittest.TestCase):
    """
    The fundamental invariant: the model must agree with the trade direction.
    Long  requires P(up)   > 0.52 (model is bullish enough).
    Short requires P(down) > 0.52, i.e. P(up) < 0.48 (model is bearish enough).
    """

    def test_long_never_fires_when_model_bearish(self):
        """P(up) = 0.49 — model is bearish — long must never fire regardless of biases."""
        engine = _engine(
            directional_threshold=0.62,
            funding_gate_enabled=True,
            funding_high_thr=0.00010,
            funding_extreme_thr=0.00030,
            funding_bias_delta=0.15,  # extreme: would push threshold to 0.62-0.30=0.32 without floor
        )
        avg_fund_neg = -(0.00050 / 8)  # well above extreme threshold
        result = engine.decide(
            features=_NEUTRAL_FEATURES,
            c2_output=_NEUTRAL_C2,
            lgbm_prob=0.49,
            avg_funding=avg_fund_neg,
            covariates={"fear_greed": 50.0},
            current_price=50000.0,
        )
        self.assertNotEqual(result.action, "long",
                            "Long must NEVER fire when P(up) = 0.49 (model is bearish)")

    def test_short_never_fires_when_model_bullish(self):
        """P(up) = 0.51 — model is bullish — short must never fire regardless of biases."""
        engine = _engine(
            directional_threshold=0.62,
            funding_gate_enabled=True,
            funding_high_thr=0.00010,
            funding_extreme_thr=0.00030,
            funding_bias_delta=0.15,
        )
        avg_fund_pos = (0.00050 / 8)  # extreme positive
        result = engine.decide(
            features=_NEUTRAL_FEATURES,
            c2_output=_NEUTRAL_C2,
            lgbm_prob=0.51,   # P(up) = 0.51, model slightly bullish
            avg_funding=avg_fund_pos,
            covariates={"fear_greed": 50.0},
            current_price=50000.0,
        )
        self.assertNotEqual(result.action, "short",
                            "Short must NEVER fire when P(up) = 0.51 (model is bullish)")

    def test_boundary_above_floor(self):
        """P(up) = 0.53 (just above floor 0.52) → long fires when all biases present."""
        engine = _engine(
            directional_threshold=0.62,
            funding_gate_enabled=True,
            funding_high_thr=0.00010,
            funding_extreme_thr=0.00030,
            funding_bias_delta=0.15,
        )
        avg_fund_neg = -(0.00050 / 8)
        result = engine.decide(
            features=_NEUTRAL_FEATURES,
            c2_output=_NEUTRAL_C2,
            lgbm_prob=0.53,
            avg_funding=avg_fund_neg,
            covariates={"fear_greed": 50.0},
            current_price=50000.0,
        )
        self.assertEqual(result.action, "long",
                         "P(up)=0.53 should trigger long even with extreme biases "
                         "(above the floor, model confirms direction)")


if __name__ == "__main__":
    unittest.main()
