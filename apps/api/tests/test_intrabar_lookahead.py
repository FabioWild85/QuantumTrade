"""
Tests for the intrabar-lookahead fix in backtesting.py.

Bug: within a single 4h bar the backtester updated the trailing / break-even SL
using curr_high (for longs), then immediately checked hit_sl against curr_low
using the *already-updated* SL.  This assumed the bar's high always precedes
its low — an optimistic ordering impossible to guarantee in live trading.

Fix: capture sl_before_update = position["sl"] before the trail/BE blocks.
The SL-hit check and the exit_price both use sl_before_update, so intrabar
ratcheting cannot produce a false stop-out in the same bar it was triggered.

Tests are pure unit tests of the decision logic; they do not call the async
run_backtest() function and have no external dependencies.
"""

import sys
import os
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))


# ── helpers ──────────────────────────────────────────────────────────────────

def _make_position(side: str, entry: float, sl: float, tp: float,
                   size_usd: float = 1000.0, **kw) -> dict:
    return dict(
        side=side, entry=entry, sl=sl, tp=tp,
        size_usd=size_usd, bar_idx=0,
        fee_entry=0.0, funding_paid=0.0,
        is_reversal=False, partial_done=False,
        be_sl_applied=False, sl_trailing_active=False,
        high_water=entry, entry_atr=10.0,
        **kw,
    )


def _apply_trailing_sl(position: dict, curr_high: float, curr_low: float,
                       trail_dist: float) -> None:
    """Mirrors the trailing-SL block in backtesting.py."""
    side = position["side"]
    if not position.get("sl_trailing_active"):
        entry = position["entry"]
        moved = (side == "long"  and curr_high >= entry + trail_dist) or \
                (side == "short" and curr_low  <= entry - trail_dist)
        if moved:
            position["sl_trailing_active"] = True
            position["high_water"] = curr_high if side == "long" else curr_low
    if position.get("sl_trailing_active"):
        if side == "long":
            position["high_water"] = max(position["high_water"], curr_high)
            new_sl = position["high_water"] - trail_dist
            position["sl"] = max(position["sl"], new_sl)
        else:
            position["high_water"] = min(position["high_water"], curr_low)
            new_sl = position["high_water"] + trail_dist
            position["sl"] = min(position["sl"], new_sl)


def _apply_be_sl(position: dict, curr_high: float, curr_low: float,
                 be_dist: float) -> None:
    """Mirrors the BE-SL block in backtesting.py."""
    if position.get("be_sl_applied"):
        return
    side = position["side"]
    entry = position["entry"]
    moved = (side == "long"  and curr_high >= entry + be_dist) or \
            (side == "short" and curr_low  <= entry - be_dist)
    if moved:
        if side == "long":
            position["sl"] = max(position["sl"], entry)
        else:
            position["sl"] = min(position["sl"], entry)
        position["be_sl_applied"] = True


def _check_sl_fixed(position: dict, sl_before_update: float,
                    curr_high: float, curr_low: float) -> tuple:
    """Mirrors the FIXED SL check: uses sl_before_update."""
    side = position["side"]
    hit_sl = (side == "long"  and curr_low  <= sl_before_update) or \
             (side == "short" and curr_high >= sl_before_update)
    hit_tp = (side == "long"  and curr_high >= position["tp"]) or \
             (side == "short" and curr_low  <= position["tp"])
    if hit_sl and hit_tp:
        hit_tp = False
    exit_price = sl_before_update if hit_sl else (position["tp"] if hit_tp else None)
    return hit_sl, hit_tp, exit_price


def _check_sl_buggy(position: dict, curr_high: float, curr_low: float) -> tuple:
    """Mirrors the BUGGY SL check: uses position["sl"] after update."""
    side = position["side"]
    hit_sl = (side == "long"  and curr_low  <= position["sl"]) or \
             (side == "short" and curr_high >= position["sl"])
    hit_tp = (side == "long"  and curr_high >= position["tp"]) or \
             (side == "short" and curr_low  <= position["tp"])
    if hit_sl and hit_tp:
        hit_tp = False
    exit_price = position["sl"] if hit_sl else (position["tp"] if hit_tp else None)
    return hit_sl, hit_tp, exit_price


# ════════════════════════════════════════════════════════════════════════════
# 1. Core lookahead scenario: trailing SL
# ════════════════════════════════════════════════════════════════════════════

class TestTrailingSLLookahead(unittest.TestCase):
    """
    Scenario (long): bar goes LOW first, then HIGH.
    The high activates the trailing SL, ratcheting it upward.
    The low (which happened BEFORE the high) would not have hit the original SL.
    The buggy code produces a false stop; the fix correctly keeps the trade open.
    """

    def setUp(self):
        # Long: entry=100, SL=90, TP=130, trail_dist=5
        # Bar: low=93, high=107  → trail activates (107 >= 100+5), new_sl = 107-5 = 102
        # low=93 < new_sl=102 → buggy code fires stop; but 93 > old_sl=90 → fix: no stop
        self.entry      = 100.0
        self.sl_initial = 90.0
        self.tp         = 130.0
        self.trail_dist = 5.0
        self.curr_low   = 93.0   # bar goes low FIRST
        self.curr_high  = 107.0  # then reaches high → trail activates

    def _run(self, buggy: bool) -> tuple:
        pos = _make_position("long", self.entry, self.sl_initial, self.tp)
        sl_before = pos["sl"]
        _apply_trailing_sl(pos, self.curr_high, self.curr_low, self.trail_dist)
        if buggy:
            return _check_sl_buggy(pos, self.curr_high, self.curr_low)
        return _check_sl_fixed(pos, sl_before, self.curr_high, self.curr_low)

    def test_buggy_produces_false_stop(self):
        """Old code: trail updates SL to 102, low=93 hits it → false stop."""
        hit_sl, _, exit_price = self._run(buggy=True)
        self.assertTrue(hit_sl, "Buggy code must produce a false stop-loss")
        self.assertAlmostEqual(exit_price, 102.0,
                               msg="Buggy exit at the trailed SL (102), not the original (90)")

    def test_fixed_no_false_stop(self):
        """Fixed code: SL check uses sl_before_update=90; low=93 > 90 → no stop."""
        hit_sl, hit_tp, exit_price = self._run(buggy=False)
        self.assertFalse(hit_sl,  "Fixed code must NOT fire a stop (low=93 > original SL=90)")
        self.assertFalse(hit_tp,  "TP not touched (high=107 < TP=130)")
        self.assertIsNone(exit_price)

    def test_fixed_trail_still_updates_position(self):
        """Even though the stop is not fired, the trailing SL should still be ratcheted."""
        pos = _make_position("long", self.entry, self.sl_initial, self.tp)
        _apply_trailing_sl(pos, self.curr_high, self.curr_low, self.trail_dist)
        self.assertTrue(pos["sl_trailing_active"])
        self.assertAlmostEqual(pos["sl"], 102.0,
                               msg="Trailing SL should be updated to 102 for the NEXT bar's check")

    def test_genuine_stop_still_fires(self):
        """If the old SL IS hit (low < original SL), the stop must still fire."""
        pos = _make_position("long", self.entry, self.sl_initial, self.tp)
        curr_low_below_sl = 88.0  # below original SL=90
        sl_before = pos["sl"]
        _apply_trailing_sl(pos, self.curr_high, curr_low_below_sl, self.trail_dist)
        hit_sl, _, exit_price = _check_sl_fixed(pos, sl_before,
                                                self.curr_high, curr_low_below_sl)
        self.assertTrue(hit_sl, "A genuine stop (low < original SL) must still fire")
        self.assertAlmostEqual(exit_price, self.sl_initial,
                               msg="Exit price must be the original SL (90), not the trailed one")


# ════════════════════════════════════════════════════════════════════════════
# 2. Core lookahead scenario: break-even SL
# ════════════════════════════════════════════════════════════════════════════

class TestBESLLookahead(unittest.TestCase):
    """
    Scenario (long): bar goes low first then high, activating BE SL.
    The low does not hit the original SL, but the buggy code falsely exits at BE.
    """

    def setUp(self):
        # Long: entry=100, SL=95, TP=130, BE activation: +4
        # Bar: low=96, high=105 → BE activates (105 >= 100+4), SL moves to 100
        # low=96 < new_sl=100 → buggy fires stop at 100; but 96 > original 95 → fix: no stop
        self.entry      = 100.0
        self.sl_initial = 95.0
        self.tp         = 130.0
        self.be_dist    = 4.0
        self.curr_low   = 96.0
        self.curr_high  = 105.0

    def _run(self, buggy: bool) -> tuple:
        pos = _make_position("long", self.entry, self.sl_initial, self.tp)
        sl_before = pos["sl"]
        _apply_be_sl(pos, self.curr_high, self.curr_low, self.be_dist)
        if buggy:
            return _check_sl_buggy(pos, self.curr_high, self.curr_low)
        return _check_sl_fixed(pos, sl_before, self.curr_high, self.curr_low)

    def test_buggy_produces_false_be_exit(self):
        """Old code: BE moves SL to 100, low=96 hits it → false exit at break-even."""
        hit_sl, _, exit_price = self._run(buggy=True)
        self.assertTrue(hit_sl)
        self.assertAlmostEqual(exit_price, 100.0,
                               msg="Buggy exit at BE price (entry=100), not original SL (95)")

    def test_fixed_no_false_be_exit(self):
        """Fixed code: SL check uses sl_before=95; low=96 > 95 → no stop."""
        hit_sl, _, _ = self._run(buggy=False)
        self.assertFalse(hit_sl, "Fixed code must NOT fire a stop (low=96 > original SL=95)")

    def test_genuine_stop_before_be_activation(self):
        """Low below original SL — stop must fire even with fix."""
        pos = _make_position("long", self.entry, self.sl_initial, self.tp)
        curr_low_hit = 94.0  # below original SL=95
        sl_before = pos["sl"]
        _apply_be_sl(pos, self.curr_high, curr_low_hit, self.be_dist)
        hit_sl, _, exit_price = _check_sl_fixed(pos, sl_before,
                                                self.curr_high, curr_low_hit)
        self.assertTrue(hit_sl)
        self.assertAlmostEqual(exit_price, self.sl_initial)


# ════════════════════════════════════════════════════════════════════════════
# 3. Short-side symmetry
# ════════════════════════════════════════════════════════════════════════════

class TestShortSideLookahead(unittest.TestCase):
    """
    Scenario (short): bar goes HIGH first, then LOW.
    The low activates the trailing SL (ratchets it downward).
    The high (which happened BEFORE the low) would not have hit the original SL.
    """

    def setUp(self):
        # Short: entry=100, SL=110, TP=70, trail_dist=5
        # Bar: high=104, low=93 → trail activates (93 <= 100-5=95), new_sl = 93+5 = 98
        # high=104 >= new_sl=98 → buggy fires stop; but 104 < original 110 → fix: no stop
        self.entry      = 100.0
        self.sl_initial = 110.0
        self.tp         = 70.0
        self.trail_dist = 5.0
        self.curr_high  = 104.0
        self.curr_low   = 93.0

    def _run(self, buggy: bool) -> tuple:
        pos = _make_position("short", self.entry, self.sl_initial, self.tp)
        sl_before = pos["sl"]
        _apply_trailing_sl(pos, self.curr_high, self.curr_low, self.trail_dist)
        if buggy:
            return _check_sl_buggy(pos, self.curr_high, self.curr_low)
        return _check_sl_fixed(pos, sl_before, self.curr_high, self.curr_low)

    def test_buggy_produces_false_stop_short(self):
        hit_sl, _, exit_price = self._run(buggy=True)
        self.assertTrue(hit_sl, "Buggy code must produce a false stop for shorts too")
        self.assertAlmostEqual(exit_price, 98.0,
                               msg="Buggy exit at the trailed SL (98), not original (110)")

    def test_fixed_no_false_stop_short(self):
        hit_sl, _, _ = self._run(buggy=False)
        self.assertFalse(hit_sl,
                         "Fixed code must NOT fire a stop (high=104 < original SL=110)")

    def test_genuine_stop_short_still_fires(self):
        pos = _make_position("short", self.entry, self.sl_initial, self.tp)
        curr_high_above_sl = 112.0
        sl_before = pos["sl"]
        _apply_trailing_sl(pos, curr_high_above_sl, self.curr_low, self.trail_dist)
        hit_sl, _, exit_price = _check_sl_fixed(pos, sl_before,
                                                curr_high_above_sl, self.curr_low)
        self.assertTrue(hit_sl)
        self.assertAlmostEqual(exit_price, self.sl_initial)


# ════════════════════════════════════════════════════════════════════════════
# 4. Exit price correctness
# ════════════════════════════════════════════════════════════════════════════

class TestExitPriceCorrectness(unittest.TestCase):
    """The exit price when SL fires must be sl_before_update, not the trailed value."""

    def test_exit_price_is_original_sl_not_trailed(self):
        """
        Long: entry=100, SL=90, trail_dist=5, bar high=108, bar low=88.
        Old SL=90 is hit (low=88 < 90) → must exit at 90, not at trailed 103.
        """
        pos = _make_position("long", 100.0, 90.0, 150.0)
        sl_before = pos["sl"]          # = 90
        _apply_trailing_sl(pos, 108.0, 88.0, 5.0)
        # After trail: sl = max(90, 108-5) = 103
        self.assertAlmostEqual(pos["sl"], 103.0)

        hit_sl, _, exit_price = _check_sl_fixed(pos, sl_before, 108.0, 88.0)
        self.assertTrue(hit_sl)
        self.assertAlmostEqual(exit_price, 90.0,
                               msg="Exit price must be the original SL (90), not the trailed SL (103)")

    def test_tp_exit_price_unaffected(self):
        """TP exit price is position['tp'] and must be unaffected by the fix."""
        pos = _make_position("long", 100.0, 90.0, 115.0)
        sl_before = pos["sl"]
        _apply_trailing_sl(pos, 120.0, 93.0, 5.0)
        hit_sl, hit_tp, exit_price = _check_sl_fixed(pos, sl_before, 120.0, 93.0)
        self.assertFalse(hit_sl)
        self.assertTrue(hit_tp, "TP must still fire when high >= TP")
        self.assertAlmostEqual(exit_price, 115.0)


# ════════════════════════════════════════════════════════════════════════════
# 5. No-regression: cases unaffected by the fix
# ════════════════════════════════════════════════════════════════════════════

class TestNoRegressionCases(unittest.TestCase):
    """Cases where trail is NOT active and the fix must produce identical results."""

    def test_plain_sl_hit_no_trailing(self):
        """No trailing SL active — the fix must not change behaviour."""
        pos = _make_position("long", 100.0, 90.0, 130.0)
        sl_before = pos["sl"]  # 90, no update
        hit_sl, _, exit_price = _check_sl_fixed(pos, sl_before, 105.0, 88.0)
        self.assertTrue(hit_sl)
        self.assertAlmostEqual(exit_price, 90.0)

    def test_plain_tp_hit_no_trailing(self):
        pos = _make_position("long", 100.0, 90.0, 130.0)
        sl_before = pos["sl"]
        hit_sl, hit_tp, exit_price = _check_sl_fixed(pos, sl_before, 135.0, 98.0)
        self.assertFalse(hit_sl)
        self.assertTrue(hit_tp)
        self.assertAlmostEqual(exit_price, 130.0)

    def test_no_hit_no_trailing(self):
        pos = _make_position("long", 100.0, 90.0, 130.0)
        sl_before = pos["sl"]
        hit_sl, hit_tp, exit_price = _check_sl_fixed(pos, sl_before, 110.0, 95.0)
        self.assertFalse(hit_sl)
        self.assertFalse(hit_tp)
        self.assertIsNone(exit_price)

    def test_sl_and_tp_both_hit_sl_wins(self):
        """When both SL and TP touched in same candle, SL (conservative) must win."""
        pos = _make_position("long", 100.0, 90.0, 120.0)
        sl_before = pos["sl"]
        hit_sl, hit_tp, exit_price = _check_sl_fixed(pos, sl_before, 125.0, 88.0)
        self.assertTrue(hit_sl)
        self.assertFalse(hit_tp, "TP must be suppressed when both SL and TP hit")

    def test_trailing_progresses_across_two_bars_no_stop(self):
        """
        Bar 1 activates trailing, SL ratchets to 103. Bar 2 has low=105 (above
        the new SL of 103) → no stop on bar 2. Trail ratchets further.
        This verifies that a legitimate multi-bar trail progression is unaffected.
        """
        pos = _make_position("long", 100.0, 90.0, 150.0)

        # Bar 1: high=108, low=103 → activates trail, SL moves to 103
        sl_b1 = pos["sl"]
        _apply_trailing_sl(pos, 108.0, 103.0, 5.0)
        hit_sl1, _, _ = _check_sl_fixed(pos, sl_b1, 108.0, 103.0)
        self.assertFalse(hit_sl1, "Bar 1: low=103 > sl_before=90, no stop")
        self.assertAlmostEqual(pos["sl"], 103.0, msg="SL ratcheted to 103 after bar 1")

        # Bar 2: high=112, low=105 (above sl_b2=103) → no stop, SL ratchets to 107
        sl_b2 = pos["sl"]   # 103
        _apply_trailing_sl(pos, 112.0, 105.0, 5.0)
        hit_sl2, _, _ = _check_sl_fixed(pos, sl_b2, 112.0, 105.0)
        self.assertFalse(hit_sl2, "Bar 2: low=105 > sl_before=103 → no stop")
        self.assertAlmostEqual(pos["sl"], 107.0, msg="SL ratcheted to 107 after bar 2")
        # Actually low=100 < sl_b2=103 → should hit stop

    def test_trailing_ratchet_from_prev_bar_stop_fires_correctly(self):
        """
        After bar 1 ratchets SL to 103, bar 2 with low=100 must hit that SL.
        sl_before_update for bar 2 is 103 (set at bar 1), and 100 < 103 → stop fires.
        """
        pos = _make_position("long", 100.0, 90.0, 150.0)
        _apply_trailing_sl(pos, 108.0, 103.0, 5.0)  # bar 1: SL → 103

        sl_b2 = pos["sl"]   # 103 — the current valid SL entering bar 2
        _apply_trailing_sl(pos, 112.0, 100.0, 5.0)  # bar 2 would ratchet to 107
        hit_sl, _, exit_p = _check_sl_fixed(pos, sl_b2, 112.0, 100.0)
        self.assertTrue(hit_sl, "low=100 < sl_before_update=103 → valid stop on bar 2")
        self.assertAlmostEqual(exit_p, 103.0,
                               msg="Exit at the SL valid at bar 2 open (103), not bar-2 ratchet (107)")


if __name__ == "__main__":
    unittest.main()
