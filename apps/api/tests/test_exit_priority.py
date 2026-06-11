"""
Tests for the SL/TP vs Liquidation exit priority fix (June 2026).

Before the fix, the liquidation check ran BEFORE the SL/TP check. A single large
bar that crossed both the SL level and the liquidation level would be incorrectly
tagged as "liquidation" (worse exit price) instead of "stop_loss" (closer to entry).

After the fix the priority order is:
  1. SL/TP  (closest to entry → fires first in any real move)
  2. Liquidation (fallback — fires only when SL is beyond liq, or the position had
     no SL due to an edge case)
  3. LGBM exit
  4. Max-hold

Each test drives a minimal stub of the position-management loop and asserts the
correct exit reason and exit price.
"""

import math
import pytest

# ─────────────────────────────────────────────────────────────────────────────
# Helpers that replicate the exact formulas used in backtesting.py
# ─────────────────────────────────────────────────────────────────────────────

_HL_MM_RATE = 0.005


def _liq_price(side: str, entry: float, leverage: int) -> float:
    if leverage <= 1:
        return 0.0
    if side == "long":
        return entry * (1.0 - 1.0 / leverage + _HL_MM_RATE)
    return entry * (1.0 + 1.0 / leverage - _HL_MM_RATE)


def _simulate_bar(
    side: str,
    entry: float,
    sl: float,
    tp: float,
    leverage: int,
    bar_low: float,
    bar_high: float,
) -> dict:
    """
    Minimal replica of the position-management block in backtesting.py.
    Returns {"reason": str, "exit_price": float}.
    Only handles SL/TP and liquidation (not LGBM / max-hold).
    """
    liq_px = _liq_price(side, entry, leverage)
    size_usd = 1000.0  # nominal — not relevant for reason/exit_price

    already_closed = False
    result = {}

    # ── 1. SL/TP check (FIRST — as per the fix) ──────────────────────────────
    hit_sl = (side == "long"  and bar_low  <= sl) or \
             (side == "short" and bar_high >= sl)
    hit_tp = (side == "long"  and bar_high >= tp) or \
             (side == "short" and bar_low  <= tp)
    if hit_sl and hit_tp:
        hit_tp = False  # conservative

    # Liq-override: SL set beyond liq level → let liq handle it
    if hit_sl and liq_px > 0.0:
        sl_beyond_liq = (
            (side == "long"  and sl <= liq_px) or
            (side == "short" and sl >= liq_px)
        )
        if sl_beyond_liq:
            hit_sl = False

    if hit_sl or hit_tp:
        result["reason"]     = "stop_loss" if hit_sl else "take_profit"
        result["exit_price"] = sl if hit_sl else tp
        already_closed = True

    # ── 2. Liquidation check (FALLBACK) ──────────────────────────────────────
    if not already_closed and liq_px > 0.0:
        hit_liq = (
            (side == "long"  and bar_low  <= liq_px) or
            (side == "short" and bar_high >= liq_px)
        )
        if hit_liq:
            result["reason"]     = "liquidation"
            result["exit_price"] = liq_px
            already_closed = True

    if not already_closed:
        result["reason"]     = "open"
        result["exit_price"] = None

    return result


# ─────────────────────────────────────────────────────────────────────────────
# Normal-SL tests (SL is between entry and liq — the common case)
# ─────────────────────────────────────────────────────────────────────────────

class TestNormalSLPriority:
    """In the typical configuration SL is always closer to entry than liq_px."""

    def test_long_sl_fires_not_liq_on_large_bar(self):
        """
        LONG, entry=7000, SL=6860 (2%), liq≈5635 (lev=5).
        Bar low=5500 — crosses BOTH SL and liq.
        Must exit as stop_loss at 6860, NOT liquidation at 5635.
        """
        entry, sl, tp, lev = 7000.0, 6860.0, 8050.0, 5
        liq = _liq_price("long", entry, lev)  # ≈ 5635
        assert sl > liq, "SL must be closer to entry than liq for this test"

        bar_low, bar_high = 5500.0, 7000.0
        res = _simulate_bar("long", entry, sl, tp, lev, bar_low, bar_high)

        assert res["reason"] == "stop_loss"
        assert res["exit_price"] == pytest.approx(sl)

    def test_short_sl_fires_not_liq_on_large_bar(self):
        """
        SHORT, entry=6200, SL=6386 (3%), liq≈7409 (lev=5).
        Bar high=7500 — crosses BOTH SL and liq.
        Must exit as stop_loss at 6386, NOT liquidation at 7409.
        This is the October-15-2018 pump scenario.
        """
        entry, sl, tp, lev = 6200.0, 6386.0, 5270.0, 5
        liq = _liq_price("short", entry, lev)  # ≈ 7409
        assert sl < liq, "SL must be closer to entry than liq for this test"

        bar_low, bar_high = 6000.0, 7500.0
        res = _simulate_bar("short", entry, sl, tp, lev, bar_low, bar_high)

        assert res["reason"] == "stop_loss"
        assert res["exit_price"] == pytest.approx(sl)

    def test_long_sl_fires_not_liq_on_exact_liq_bar(self):
        """Bar low equals exactly the liq price (not below SL). Edge case."""
        entry, sl, tp, lev = 7000.0, 6860.0, 8050.0, 5
        liq = _liq_price("long", entry, lev)
        # Set bar_low just at liq price (below SL → SL must fire, not liq)
        bar_low, bar_high = liq, 7000.0
        res = _simulate_bar("long", entry, sl, tp, lev, bar_low, bar_high)

        assert res["reason"] == "stop_loss"
        assert res["exit_price"] == pytest.approx(sl)

    def test_short_sl_fires_not_liq_on_exact_liq_bar(self):
        """Bar high equals exactly the liq price (above SL). Edge case."""
        entry, sl, tp, lev = 6200.0, 6386.0, 5270.0, 5
        liq = _liq_price("short", entry, lev)
        bar_low, bar_high = 6000.0, liq  # high == liq, above SL → SL fires first
        res = _simulate_bar("short", entry, sl, tp, lev, bar_low, bar_high)

        assert res["reason"] == "stop_loss"
        assert res["exit_price"] == pytest.approx(sl)

    def test_long_tp_fires_normally(self):
        """Normal TP — bar high reaches TP, low nowhere near SL/liq."""
        entry, sl, tp, lev = 7000.0, 6860.0, 8050.0, 5
        bar_low, bar_high = 7050.0, 8100.0
        res = _simulate_bar("long", entry, sl, tp, lev, bar_low, bar_high)

        assert res["reason"] == "take_profit"
        assert res["exit_price"] == pytest.approx(tp)

    def test_short_tp_fires_normally(self):
        """Normal TP — bar low reaches TP, high nowhere near SL/liq."""
        entry, sl, tp, lev = 6200.0, 6386.0, 5270.0, 5
        bar_low, bar_high = 5200.0, 6150.0
        res = _simulate_bar("short", entry, sl, tp, lev, bar_low, bar_high)

        assert res["reason"] == "take_profit"
        assert res["exit_price"] == pytest.approx(tp)

    def test_no_exit_when_bar_stays_inside_range(self):
        """Quiet bar — price doesn't reach SL or TP."""
        entry, sl, tp, lev = 7000.0, 6860.0, 8050.0, 5
        bar_low, bar_high = 6950.0, 7100.0
        res = _simulate_bar("long", entry, sl, tp, lev, bar_low, bar_high)

        assert res["reason"] == "open"

    def test_sl_wins_over_tp_when_both_hit_same_bar(self):
        """Both SL and TP touched in same bar → SL wins (conservative)."""
        entry, sl, tp, lev = 7000.0, 6860.0, 8050.0, 5
        bar_low, bar_high = 6850.0, 8100.0  # wicks below SL and above TP
        res = _simulate_bar("long", entry, sl, tp, lev, bar_low, bar_high)

        assert res["reason"] == "stop_loss"
        assert res["exit_price"] == pytest.approx(sl)


# ─────────────────────────────────────────────────────────────────────────────
# Liq-override tests (SL widened past liq — structural SL edge case)
# ─────────────────────────────────────────────────────────────────────────────

class TestLiqOverride:
    """
    Edge case: structural SL widens the SL beyond the liquidation price.
    In this case the exchange liquidates before the SL order fires.
    The liq-override should suppress the SL and let liq fire.
    """

    def test_long_liq_fires_when_sl_beyond_liq(self):
        """
        LONG, entry=7000, lev=5 → liq≈5635.
        Structural SL widened to 5500 (BELOW liq) — liq must fire, not SL.
        """
        entry, lev = 7000.0, 5
        liq = _liq_price("long", entry, lev)  # ≈ 5635
        sl_wide = liq - 135.0  # 5500 — beyond liq
        tp = 8050.0

        assert sl_wide < liq, "Precondition: SL is below liq for long"

        bar_low, bar_high = 5400.0, 7000.0  # low below both sl_wide and liq
        res = _simulate_bar("long", entry, sl_wide, tp, lev, bar_low, bar_high)

        assert res["reason"] == "liquidation"
        assert res["exit_price"] == pytest.approx(liq)

    def test_short_liq_fires_when_sl_beyond_liq(self):
        """
        SHORT, entry=6200, lev=5 → liq≈7409.
        Structural SL widened to 7600 (ABOVE liq) — liq must fire, not SL.
        """
        entry, lev = 6200.0, 5
        liq = _liq_price("short", entry, lev)  # ≈ 7409
        sl_wide = liq + 191.0  # 7600 — beyond liq
        tp = 5270.0

        assert sl_wide > liq, "Precondition: SL is above liq for short"

        bar_low, bar_high = 6000.0, 7700.0  # high above both sl_wide and liq
        res = _simulate_bar("short", entry, sl_wide, tp, lev, bar_low, bar_high)

        assert res["reason"] == "liquidation"
        assert res["exit_price"] == pytest.approx(liq)

    def test_long_sl_exactly_at_liq_triggers_liq(self):
        """SL == liq_px: the override treats equality as 'beyond', liq fires."""
        entry, lev = 7000.0, 5
        liq = _liq_price("long", entry, lev)
        sl_at_liq = liq  # exactly equal

        bar_low, bar_high = liq - 1.0, 7000.0
        res = _simulate_bar("long", entry, sl_at_liq, 8050.0, lev, bar_low, bar_high)

        assert res["reason"] == "liquidation"


# ─────────────────────────────────────────────────────────────────────────────
# Leverage=1 (no liquidation possible)
# ─────────────────────────────────────────────────────────────────────────────

class TestNoLeverage:
    """With lev=1, liq_price returns 0.0 — liquidation can never fire."""

    def test_lev1_long_sl_fires(self):
        entry, sl, tp, lev = 7000.0, 6800.0, 8000.0, 1
        assert _liq_price("long", entry, lev) == 0.0

        bar_low, bar_high = 6700.0, 7000.0
        res = _simulate_bar("long", entry, sl, tp, lev, bar_low, bar_high)

        assert res["reason"] == "stop_loss"
        assert res["exit_price"] == pytest.approx(sl)

    def test_lev1_short_sl_fires(self):
        entry, sl, tp, lev = 6200.0, 6500.0, 5500.0, 1
        assert _liq_price("short", entry, lev) == 0.0

        bar_low, bar_high = 5900.0, 6600.0
        res = _simulate_bar("short", entry, sl, tp, lev, bar_low, bar_high)

        assert res["reason"] == "stop_loss"
        assert res["exit_price"] == pytest.approx(sl)


# ─────────────────────────────────────────────────────────────────────────────
# Liq price formula sanity checks
# ─────────────────────────────────────────────────────────────────────────────

class TestLiqPriceFormula:
    """Verify the liquidation price formula for correctness."""

    def test_long_liq_price_5x(self):
        """lev=5: liq = entry × (1 - 0.2 + 0.005) = entry × 0.805"""
        liq = _liq_price("long", 7000.0, 5)
        assert liq == pytest.approx(7000.0 * 0.805)

    def test_short_liq_price_5x(self):
        """lev=5: liq = entry × (1 + 0.2 - 0.005) = entry × 1.195"""
        liq = _liq_price("short", 6200.0, 5)
        assert liq == pytest.approx(6200.0 * 1.195)

    def test_liq_is_always_further_from_entry_than_1pct_sl(self):
        """With 5x leverage, a 1%-ATR SL is always CLOSER to entry than liq_px."""
        entry, lev = 6000.0, 5
        sl_long  = entry * 0.99   # 1% below entry for long
        sl_short = entry * 1.01   # 1% above entry for short
        liq_long  = _liq_price("long",  entry, lev)  # 19.5% below entry
        liq_short = _liq_price("short", entry, lev)  # 19.5% above entry

        assert sl_long  > liq_long,  "Long SL must be above (closer than) liq"
        assert sl_short < liq_short, "Short SL must be below (closer than) liq"

    def test_lev1_returns_zero(self):
        assert _liq_price("long",  5000.0, 1) == 0.0
        assert _liq_price("short", 5000.0, 1) == 0.0


# ─────────────────────────────────────────────────────────────────────────────
# Isolated-margin loss semantics (Bug #1: not losing all capital on liq)
# ─────────────────────────────────────────────────────────────────────────────

class TestIsolatedMarginPnL:
    """
    Liquidation in isolated margin burns only the margin for that position,
    NOT the entire account balance.  The PnL at liq ≈ –(margin × 0.975).
    """

    def _pnl_at_liq(self, side, entry, leverage, size_usd):
        liq = _liq_price(side, entry, leverage)
        if side == "long":
            pnl_pct = (liq - entry) / entry
        else:
            pnl_pct = (entry - liq) / entry
        return size_usd * pnl_pct

    def test_long_liq_loss_equals_approx_margin(self):
        entry, lev = 7000.0, 5
        margin     = 1000.0          # dollars deposited as collateral
        size_usd   = margin * lev    # notional = 5000

        pnl = self._pnl_at_liq("long", entry, lev, size_usd)

        # Expected: pnl ≈ –margin × (1 – MM_rate × leverage)
        expected = -(margin * (1.0 - _HL_MM_RATE * lev))
        assert pnl == pytest.approx(expected, rel=1e-4)

    def test_short_liq_loss_equals_approx_margin(self):
        entry, lev = 6200.0, 5
        margin     = 800.0
        size_usd   = margin * lev

        pnl = self._pnl_at_liq("short", entry, lev, size_usd)

        expected = -(margin * (1.0 - _HL_MM_RATE * lev))
        assert pnl == pytest.approx(expected, rel=1e-4)

    def test_remaining_equity_is_positive_after_liq(self):
        """After a single liquidation event, remaining capital > 0."""
        initial_equity = 10_000.0
        entry, lev     = 7000.0, 5
        pos_size_pct   = 1.5 / 100      # 1.5% risk per trade
        sl_pct         = 0.02           # 2% SL distance
        risk_usd       = initial_equity * pos_size_pct * lev
        size_usd       = risk_usd / sl_pct  # notional

        # Cap: margin ≤ 95% of equity
        margin = size_usd / lev
        if margin > initial_equity * 0.95:
            size_usd = initial_equity * 0.95 * lev

        pnl = self._pnl_at_liq("long", entry, lev, size_usd)
        equity_after = initial_equity + pnl

        assert equity_after > 0, f"Expected positive equity, got {equity_after:.2f}"
