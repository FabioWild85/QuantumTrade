"""
Tests for the liq_spike_lookback and oi_spike_lookback fixes.

Bug: both parameters were partially dead.
  - liq_spike_lookback: gate always used hardcoded cur+lag1 regardless of config.
  - oi_spike_lookback:  lags only up to 3 existed; values 4–6 silently capped.

Fix:
  - smc.py: generates oi_delta_z_lag1..6 and liq_{short,long}_z_lag1..6.
  - decision.py: liq gate uses a loop over `self.liq_spike_lookback`, mirroring
    the existing OI gate pattern.

These tests verify:
  1. liq gate with lookback=2 produces identical results to the old hardcoded logic.
  2. liq gate with lookback>2 correctly uses the extended lags.
  3. oi gate with lookback=4,5,6 no longer silently caps at 3.
  4. Default configs (liq=2, oi=2) are completely unaffected.
"""

import sys
import os
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from services.decision import DecisionEngine


# ── helpers ──────────────────────────────────────────────────────────────────

_BASE_FEATURES = {
    "adx_14": 30.0, "sweep": 0.0, "fvg_bear": 0.0, "fvg_bull": 0.0,
    "rsi_14": 50.0, "ret_48": 0.0, "d_regime": 0, "d_rsi": 50.0,
    "vol_z_50": 0.0, "regime_state": "neutral",
    "regime_confidence": 0.5, "transition_risk": 0.0,
    "oi_delta": 0.0,
}

_NEUTRAL_C2 = {
    "c2_dir_prob": 0.5, "c2_p10": 50000.0, "c2_p50": 50000.0,
    "c2_p90": 50000.0, "c2_uncertainty": 0.0, "c2_cont_prob": 1.0,
}

def _engine_liq(lookback: int, mode: str = "block") -> DecisionEngine:
    return DecisionEngine(
        adx_gate_enabled=False,
        sweep_gate_enabled=False,
        fvg_filter_enabled=False,
        mtf_alignment_enabled=False,
        exhaustion_guard_enabled=False,
        confluence_gate=0,
        chronos_weight=0.0,
        liq_spike_gate_enabled=True,
        liq_spike_thr=2.0,
        liq_spike_lookback=lookback,
        liq_spike_mode=mode,
        liq_spike_scale_factor=0.5,
    )

def _engine_oi(lookback: int, mode: str = "block") -> DecisionEngine:
    return DecisionEngine(
        adx_gate_enabled=False,
        sweep_gate_enabled=False,
        fvg_filter_enabled=False,
        mtf_alignment_enabled=False,
        exhaustion_guard_enabled=False,
        confluence_gate=0,
        chronos_weight=0.0,
        oi_spike_gate_enabled=True,
        oi_spike_thr=2.0,
        oi_spike_lookback=lookback,
        oi_spike_mode=mode,
    )

def _decide(engine: DecisionEngine, features: dict, lgbm_prob: float = 0.35):
    return engine.decide(
        features=features,
        c2_output=_NEUTRAL_C2,
        lgbm_prob=lgbm_prob,
        current_price=50000.0,
    )

def _features(**kw) -> dict:
    f = {**_BASE_FEATURES}
    f.update(kw)
    return f


# ════════════════════════════════════════════════════════════════════════════
# 1. liq_spike_lookback — backward-compatibility (default=2)
# ════════════════════════════════════════════════════════════════════════════

class TestLiqLookbackDefault(unittest.TestCase):
    """lookback=2 must reproduce the old hardcoded cur+lag1 behaviour exactly."""

    def test_no_spike_no_block(self):
        """Neither current nor lag1 spike → short fires normally."""
        engine = _engine_liq(lookback=2)
        feat = _features(liq_short_z=0.5, liq_short_z_lag1=0.5)
        result = _decide(engine, feat, lgbm_prob=0.35)
        self.assertEqual(result.action, "short",
                         "No spike: gate must not block the short")

    def test_current_bar_spike_blocks(self):
        """Current bar z > threshold → short must be blocked."""
        engine = _engine_liq(lookback=2)
        feat = _features(liq_short_z=3.0, liq_short_z_lag1=0.5)
        result = _decide(engine, feat, lgbm_prob=0.35)
        self.assertEqual(result.action, "no_trade",
                         "Current-bar spike must block the short")

    def test_lag1_spike_blocks(self):
        """Lag-1 z > threshold → short must be blocked (lookback covers lag1)."""
        engine = _engine_liq(lookback=2)
        feat = _features(liq_short_z=0.5, liq_short_z_lag1=3.0)
        result = _decide(engine, feat, lgbm_prob=0.35)
        self.assertEqual(result.action, "no_trade",
                         "Lag-1 spike must block the short (lookback=2 covers lag1)")

    def test_long_side_uses_long_z(self):
        """For a long entry, liq_long_z (not liq_short_z) is checked."""
        engine = _engine_liq(lookback=2)
        feat = _features(
            liq_long_z=3.0, liq_long_z_lag1=0.5,
            liq_short_z=0.5, liq_short_z_lag1=0.5,
        )
        result = _decide(engine, feat, lgbm_prob=0.70)
        self.assertEqual(result.action, "no_trade",
                         "Long-side spike must block the long entry")


# ════════════════════════════════════════════════════════════════════════════
# 2. liq_spike_lookback — extended values (3, 4, 5, 6)
# ════════════════════════════════════════════════════════════════════════════

class TestLiqLookbackExtended(unittest.TestCase):
    """Values > 2 must now correctly use the extended lag columns."""

    def test_lookback_3_uses_lag2(self):
        """lookback=3: cur + lag1 + lag2. Spike only at lag2 → must block."""
        engine = _engine_liq(lookback=3)
        feat = _features(
            liq_short_z=0.5, liq_short_z_lag1=0.5, liq_short_z_lag2=3.0
        )
        result = _decide(engine, feat, lgbm_prob=0.35)
        self.assertEqual(result.action, "no_trade",
                         "lookback=3: spike at lag2 must block (was silently ignored before)")

    def test_lookback_3_lag2_below_threshold_no_block(self):
        """lookback=3 with lag2 below threshold → short fires."""
        engine = _engine_liq(lookback=3)
        feat = _features(
            liq_short_z=0.5, liq_short_z_lag1=0.5, liq_short_z_lag2=1.0
        )
        result = _decide(engine, feat, lgbm_prob=0.35)
        self.assertEqual(result.action, "short")

    def test_lookback_4_uses_lag3(self):
        """lookback=4: spike only at lag3 → must block."""
        engine = _engine_liq(lookback=4)
        feat = _features(
            liq_short_z=0.5, liq_short_z_lag1=0.5,
            liq_short_z_lag2=0.5, liq_short_z_lag3=3.0
        )
        result = _decide(engine, feat, lgbm_prob=0.35)
        self.assertEqual(result.action, "no_trade")

    def test_lookback_6_uses_lag5(self):
        """lookback=6: spike only at lag5 → must block."""
        engine = _engine_liq(lookback=6)
        feat = _features(
            liq_short_z=0.5,
            liq_short_z_lag1=0.5, liq_short_z_lag2=0.5,
            liq_short_z_lag3=0.5, liq_short_z_lag4=0.5,
            liq_short_z_lag5=3.0,
        )
        result = _decide(engine, feat, lgbm_prob=0.35)
        self.assertEqual(result.action, "no_trade")

    def test_lookback_2_ignores_lag2(self):
        """lookback=2: spike at lag2 must be IGNORED (outside window)."""
        engine = _engine_liq(lookback=2)
        feat = _features(
            liq_short_z=0.5, liq_short_z_lag1=0.5, liq_short_z_lag2=5.0
        )
        result = _decide(engine, feat, lgbm_prob=0.35)
        self.assertEqual(result.action, "short",
                         "lookback=2: lag2 spike must be ignored (outside window)")

    def test_lookback_1_only_checks_current(self):
        """lookback=1: only current bar. Lag1 spike must be ignored."""
        engine = _engine_liq(lookback=1)
        feat = _features(liq_short_z=0.5, liq_short_z_lag1=5.0)
        result = _decide(engine, feat, lgbm_prob=0.35)
        self.assertEqual(result.action, "short",
                         "lookback=1: lag1 spike must be ignored")

    def test_scale_mode_with_extended_lookback(self):
        """Scale mode with lookback=3 and spike at lag2 → size reduced."""
        engine = _engine_liq(lookback=3, mode="scale")
        feat = _features(
            liq_short_z=0.5, liq_short_z_lag1=0.5, liq_short_z_lag2=3.0
        )
        result = _decide(engine, feat, lgbm_prob=0.35)
        self.assertEqual(result.action, "short",
                         "Scale mode: spike reduces size but does not block")
        self.assertLess(result.size_factor, 1.0,
                        "Size factor must be reduced on spike in scale mode")


# ════════════════════════════════════════════════════════════════════════════
# 3. oi_spike_lookback — extended values (4, 5, 6)
# ════════════════════════════════════════════════════════════════════════════

class TestOiLookbackExtended(unittest.TestCase):
    """oi_spike_lookback values 4-6 were silently capping at 3. Now they work."""

    def test_lookback_4_uses_lag3(self):
        """lookback=4: spike at lag3 must block. (Before fix: lag3 existed but
        range(4) = [0,1,2,3] → did check lag3. Verify it still works.)"""
        engine = _engine_oi(lookback=4)
        feat = _features(
            oi_delta=-1.0,
            oi_delta_z=0.5, oi_delta_z_lag1=0.5,
            oi_delta_z_lag2=0.5, oi_delta_z_lag3=3.0
        )
        result = _decide(engine, feat, lgbm_prob=0.70)
        self.assertEqual(result.action, "no_trade",
                         "lookback=4: spike at lag3 must block long entry")

    def test_lookback_5_uses_lag4(self):
        """lookback=5: spike only at lag4 → must block (was silently missing before fix)."""
        engine = _engine_oi(lookback=5)
        feat = _features(
            oi_delta=-1.0,
            oi_delta_z=0.5, oi_delta_z_lag1=0.5, oi_delta_z_lag2=0.5,
            oi_delta_z_lag3=0.5, oi_delta_z_lag4=3.0,
        )
        result = _decide(engine, feat, lgbm_prob=0.70)
        self.assertEqual(result.action, "no_trade",
                         "lookback=5: spike at lag4 must now block (lag4 previously missing)")

    def test_lookback_6_uses_lag5(self):
        """lookback=6: spike only at lag5 → must block."""
        engine = _engine_oi(lookback=6)
        feat = _features(
            oi_delta=-1.0,
            oi_delta_z=0.5, oi_delta_z_lag1=0.5, oi_delta_z_lag2=0.5,
            oi_delta_z_lag3=0.5, oi_delta_z_lag4=0.5, oi_delta_z_lag5=3.0,
        )
        result = _decide(engine, feat, lgbm_prob=0.70)
        self.assertEqual(result.action, "no_trade",
                         "lookback=6: spike at lag5 must now block")

    def test_lookback_5_lag4_was_ignored_before_fix(self):
        """
        Regression: before the fix, lookback=5 would try oi_delta_z_lag4 but
        get None (feature didn't exist in smc.py) → filtered out → acted as
        lookback=4.  After the fix, lag4 exists and is checked correctly.
        This test verifies the NEW behavior is correct (spike IS detected).
        """
        engine = _engine_oi(lookback=5)
        feat_with_lag4_spike = _features(
            oi_delta=-1.0,
            oi_delta_z=0.5, oi_delta_z_lag1=0.5, oi_delta_z_lag2=0.5,
            oi_delta_z_lag3=0.5, oi_delta_z_lag4=3.0,
        )
        feat_without_lag4 = _features(
            oi_delta=-1.0,
            oi_delta_z=0.5, oi_delta_z_lag1=0.5, oi_delta_z_lag2=0.5,
            oi_delta_z_lag3=0.5,
            # lag4 absent → features.get returns None → 0.0 fallback
        )
        result_with    = _decide(engine, feat_with_lag4_spike, lgbm_prob=0.70)
        result_without = _decide(engine, feat_without_lag4,    lgbm_prob=0.70)

        self.assertEqual(result_with.action, "no_trade",
                         "Spike at lag4 must be detected")
        self.assertEqual(result_without.action, "long",
                         "Without lag4 spike, long must proceed normally")


# ════════════════════════════════════════════════════════════════════════════
# 4. Default configs untouched (lookback=2 for both)
# ════════════════════════════════════════════════════════════════════════════

class TestDefaultConfigsUnchanged(unittest.TestCase):
    """The default lookback values (liq=2, oi=2) must behave identically
    before and after the fix."""

    def test_liq_default_no_spike(self):
        engine = _engine_liq(lookback=2)
        feat = _features(liq_short_z=0.0, liq_short_z_lag1=0.0)
        result = _decide(engine, feat, lgbm_prob=0.35)
        self.assertEqual(result.action, "short")

    def test_liq_default_spike_current(self):
        engine = _engine_liq(lookback=2)
        feat = _features(liq_short_z=5.0, liq_short_z_lag1=0.0)
        result = _decide(engine, feat, lgbm_prob=0.35)
        self.assertEqual(result.action, "no_trade")

    def test_oi_default_no_spike(self):
        engine = _engine_oi(lookback=2)
        feat = _features(oi_delta=-1.0, oi_delta_z=0.5, oi_delta_z_lag1=0.5)
        result = _decide(engine, feat, lgbm_prob=0.70)
        self.assertEqual(result.action, "long")

    def test_oi_default_spike_current(self):
        engine = _engine_oi(lookback=2)
        feat = _features(oi_delta=-1.0, oi_delta_z=3.0, oi_delta_z_lag1=0.5)
        result = _decide(engine, feat, lgbm_prob=0.70)
        self.assertEqual(result.action, "no_trade")

    def test_oi_default_spike_lag1(self):
        engine = _engine_oi(lookback=2)
        feat = _features(oi_delta=-1.0, oi_delta_z=0.5, oi_delta_z_lag1=3.0)
        result = _decide(engine, feat, lgbm_prob=0.70)
        self.assertEqual(result.action, "no_trade")


if __name__ == "__main__":
    unittest.main()
