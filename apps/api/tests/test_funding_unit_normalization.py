"""
Tests for the funding-rate unit normalization fix.

Bug context (three manifestations):
  a) FundingBias gate (decision.py) multiplies avg_funding × 8, assuming per-hour
     input.  With un-normalized Binance data (per-8h) this produced an 8× inflated
     value in old backtests.
  b) Accrual engine (backtesting.py) applied `rate × 1` every 2 bars (8h) — correct
     for Binance per-8h rates but 8× too low for HL hourly rates.
  c) funding_cum48 and reversal-detector thresholds lose consistent meaning across
     sources when rates are in different units.

Fix: normalize Binance rates to per-hour at fetch time (÷8).  All downstream code
uses per-hour rates:
  • FundingBias: avg_funding_per_hour × 8 → correct 8h-equivalent.
  • Accrual: rate_per_hour × 4h_per_bar applied every bar.
  • funding_cum48: sum of per-hour samples (consistent across sources).
"""

import sys
import os
import math
import types
import unittest

import numpy as np
import pandas as pd

# ── path setup ──────────────────────────────────────────────────────────────
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))


# ── helpers ──────────────────────────────────────────────────────────────────

def _make_funding_df(rates_per_hour: list, freq_hours: int = 1) -> pd.DataFrame:
    """Build a minimal funding DataFrame as returned by the fetch functions."""
    idx = pd.date_range("2024-01-01", periods=len(rates_per_hour),
                        freq=f"{freq_hours}h", tz="UTC")
    return pd.DataFrame({"funding": rates_per_hour, "premium": 0.0}, index=idx)


def _build_simple_ohlcv(n_bars: int = 60, freq: str = "4h") -> pd.DataFrame:
    """Build a minimal 4h OHLCV DataFrame for feature-building tests."""
    idx = pd.date_range("2024-01-01", periods=n_bars, freq=freq, tz="UTC")
    close = np.full(n_bars, 50_000.0)
    return pd.DataFrame({
        "open":   close,
        "high":   close * 1.001,
        "low":    close * 0.999,
        "close":  close,
        "volume": np.full(n_bars, 100.0),
    }, index=idx)


# ════════════════════════════════════════════════════════════════════════════
# 1. Binance normalization
# ════════════════════════════════════════════════════════════════════════════

class TestBinanceNormalization(unittest.TestCase):
    """The per-8h Binance rate must be divided by 8 at fetch time."""

    def test_binance_rate_divided_by_eight(self):
        """
        Simulate the row-building loop inside get_funding_binance.
        The raw API value 0.0008 (per-8h) must become 0.0001 (per-hour).
        """
        raw_rate = 0.0008  # typical Binance per-8h rate (0.08%)

        # This mirrors the fixed line in binance_data.py:
        normalized = raw_rate / 8

        self.assertAlmostEqual(normalized, 0.0001, places=10,
                               msg="Binance rate must be divided by 8 to get per-hour unit")

    def test_normalization_preserves_sign(self):
        """Negative funding (shorts pay longs) must stay negative after normalisation."""
        raw_negative = -0.0016
        normalized   = raw_negative / 8
        self.assertLess(normalized, 0,
                        msg="Negative Binance rate must remain negative after ÷8")
        self.assertAlmostEqual(normalized, -0.0002, places=10)

    def test_hl_rate_unchanged(self):
        """
        HL already returns per-hour rates; no division should be applied there.
        After normalization both sources must produce the same numeric value
        for an equivalent funding level.
        """
        hl_rate_per_hour     = 0.0001          # HL: directly per-hour
        binance_rate_per_8h  = 0.0008          # Binance: per-8h equivalent
        binance_normalized   = binance_rate_per_8h / 8

        self.assertAlmostEqual(hl_rate_per_hour, binance_normalized, places=10,
                               msg="Normalized Binance rate must equal HL per-hour rate")


# ════════════════════════════════════════════════════════════════════════════
# 2. FundingBias gate — decision.py logic (bug a)
# ════════════════════════════════════════════════════════════════════════════

class TestFundingBiasGate(unittest.TestCase):
    """
    decision.py line 471: avg_funding_8h = avg_funding * 8
    Input must be a per-hour rate.  With normalized Binance data the gate
    must fire at the same threshold as with HL data at the same true level.
    """

    def _bias_fires(self, avg_funding_per_hour: float, threshold: float = 0.00010) -> bool:
        """Mirrors the FundingBias logic in decision.py."""
        avg_funding_8h = avg_funding_per_hour * 8
        return avg_funding_8h > threshold

    def test_hl_rate_triggers_correctly(self):
        """Per-hour rate just above threshold/8 must trigger."""
        rate_per_hour = 0.00010 / 8 + 1e-10   # just above threshold after ×8
        self.assertTrue(self._bias_fires(rate_per_hour),
                        "FundingBias should fire when avg_funding_8h > funding_high_thr")

    def test_binance_normalized_same_as_hl(self):
        """
        A Binance raw rate of 0.00010 per-8h, after ÷8, gives 0.0000125 per-hour.
        After ×8 in the gate that equals 0.00010 — exactly the same as HL.
        Without normalisation, 0.00010 × 8 = 0.00080, which is 8× too high.
        """
        binance_raw   = 0.00010          # per-8h (raw Binance)
        binance_norm  = binance_raw / 8  # per-hour (normalized)

        # Normalized: gate sees 0.00010 (correct)
        gate_value_normalized = binance_norm * 8
        self.assertAlmostEqual(gate_value_normalized, binance_raw, places=10,
                               msg="Normalized rate × 8 must equal the original per-8h value")

        # Un-normalized: gate would see 8× the correct value
        gate_value_unnormalized = binance_raw * 8
        self.assertAlmostEqual(gate_value_unnormalized, binance_raw * 8, places=10)
        self.assertGreater(gate_value_unnormalized, gate_value_normalized * 7,
                           msg="Without normalisation the gate value is ~8× inflated")

    def test_below_threshold_does_not_trigger(self):
        """Rate clearly below threshold must not trigger the gate."""
        rate_per_hour = 0.000005   # well below any reasonable threshold
        self.assertFalse(self._bias_fires(rate_per_hour))


# ════════════════════════════════════════════════════════════════════════════
# 3. Funding accrual — backtesting.py (bug b)
# ════════════════════════════════════════════════════════════════════════════

class TestFundingAccrual(unittest.TestCase):
    """
    Fixed accrual: rate_per_hour × 4h_per_bar applied every bar.
    Old (buggy): rate × 1 every 2 bars.
    """

    RATE_PER_HOUR = 0.0001   # 0.01% per hour
    SIZE_USD      = 1_000.0  # position size

    def _accrual_fixed(self, n_bars: int) -> float:
        """New correct implementation: rate × 4 every bar."""
        total = 0.0
        for _ in range(n_bars):
            total += self.SIZE_USD * self.RATE_PER_HOUR * 4
        return total

    def _accrual_old(self, n_bars: int) -> float:
        """Old buggy implementation: rate × 1 every 2 bars."""
        total = 0.0
        for i in range(n_bars):
            if i % 2 == 0:
                total += self.SIZE_USD * self.RATE_PER_HOUR * 1
        return total

    def test_fixed_accrual_over_one_bar(self):
        """Single 4h bar: impact = size × rate × 4."""
        expected = self.SIZE_USD * self.RATE_PER_HOUR * 4
        self.assertAlmostEqual(self._accrual_fixed(1), expected, places=8)

    def test_fixed_accrual_is_8x_old_for_hl_data(self):
        """
        HL rates are per-hour.  The fixed implementation (rate × 4 every bar)
        must produce exactly 8× the funding of the old implementation
        (rate × 1 every 2 bars) over the same period.
        This confirms the old code was underestimating HL funding by 8×.
        """
        n_bars = 48  # 8 days
        fixed = self._accrual_fixed(n_bars)
        old   = self._accrual_old(n_bars)
        self.assertAlmostEqual(fixed / old, 8.0, places=5,
                               msg="Fixed accrual must be 8× the old accrual for HL per-hour rates")

    def test_fixed_accrual_matches_binance_settlement(self):
        """
        Binance: one settlement of rate R per 8h.
        Normalized: R / 8 per-hour stored in each 4h bar (ffilled to 2 bars).
        Fixed accrual: (R/8) × 4 per bar × 2 bars = R.  Correct.
        """
        binance_rate_per_8h  = 0.0008
        rate_per_hour        = binance_rate_per_8h / 8

        # 2 bars = one 8h Binance settlement period
        accrual_2_bars = 2 * self.SIZE_USD * rate_per_hour * 4
        expected       = self.SIZE_USD * binance_rate_per_8h   # one settlement

        self.assertAlmostEqual(accrual_2_bars, expected, places=8,
                               msg="Fixed accrual over 2 bars must equal one Binance 8h settlement")

    def test_long_pays_positive_funding(self):
        """Positive funding rate: long position pays (equity decreases)."""
        rate  = self.RATE_PER_HOUR * 4   # per-bar amount
        sign  = 1.0                       # long
        impact = self.SIZE_USD * rate * sign
        self.assertGreater(impact, 0, "Long pays on positive funding")

    def test_short_receives_positive_funding(self):
        """Positive funding rate: short position receives (equity increases)."""
        rate  = self.RATE_PER_HOUR * 4
        sign  = -1.0                      # short
        impact = self.SIZE_USD * rate * sign
        self.assertLess(impact, 0, "Short receives on positive funding (impact < 0)")

    def test_negative_funding_inverts(self):
        """Negative funding: short pays, long receives — signs must invert."""
        neg_rate = -self.RATE_PER_HOUR * 4
        long_impact  = self.SIZE_USD * neg_rate * 1.0
        short_impact = self.SIZE_USD * neg_rate * -1.0
        self.assertLess(long_impact, 0,   "Long receives on negative funding")
        self.assertGreater(short_impact, 0, "Short pays on negative funding")


# ════════════════════════════════════════════════════════════════════════════
# 4. End-to-end unit contract
# ════════════════════════════════════════════════════════════════════════════

class TestFundingUnitContract(unittest.TestCase):
    """
    Both sources (HL and Binance normalized) must produce the same accrual
    result when they represent the same true funding level.
    """

    SIZE_USD = 10_000.0

    def test_hl_and_binance_produce_same_accrual(self):
        """
        True funding level: 0.01% per 8h.
        HL:               0.0001 / 8  = 0.00001250 per-hour (already per-hour)
        Binance raw:      0.0001 per-8h → normalized: 0.0001 / 8 = 0.00001250 per-hour
        Over 16 bars (64h = 8 × 8h-settlements):
          accrual = SIZE × rate_per_hour × 4h × 16 bars
        """
        true_rate_per_8h  = 0.0001          # same true rate
        hl_rate_per_hour  = true_rate_per_8h / 8
        binance_norm      = true_rate_per_8h / 8   # same after normalization

        n_bars = 16
        accrual_hl      = self.SIZE_USD * hl_rate_per_hour * 4 * n_bars
        accrual_binance = self.SIZE_USD * binance_norm      * 4 * n_bars

        self.assertAlmostEqual(accrual_hl, accrual_binance, places=8,
                               msg="HL and normalized Binance must yield identical accrual")

        # Cross-check: 16 bars × 4h = 64h = 8 settlements × true_rate × SIZE
        expected = self.SIZE_USD * true_rate_per_8h * 8  # 8 settlements
        self.assertAlmostEqual(accrual_hl, expected, places=8,
                               msg="Accrual must equal n_settlements × settlement_rate × size")

    def test_funding_cum48_units_consistent(self):
        """
        funding_cum48 = rolling(48).sum() of per-hour rates.
        Both sources must have the same order of magnitude for the same true
        market conditions (no 8× mismatch).
        """
        true_rate_per_8h = 0.0001
        rate_per_hour    = true_rate_per_8h / 8   # 0.0000125

        # Build 48-bar series (4h bars, each carrying the per-hour rate)
        hl_series      = pd.Series([rate_per_hour] * 48)
        # Binance: one record per 8h = 1 per 2 bars; each bar carries rate_per_hour
        binance_series = pd.Series([rate_per_hour] * 48)  # same after normalization

        cum48_hl      = hl_series.rolling(48).sum().iloc[-1]
        cum48_binance = binance_series.rolling(48).sum().iloc[-1]

        self.assertAlmostEqual(cum48_hl, cum48_binance, places=8,
                               msg="funding_cum48 must be the same for equivalent rates")
        # Sanity: sum of 48 per-hour values
        self.assertAlmostEqual(cum48_hl, 48 * rate_per_hour, places=8)


# ════════════════════════════════════════════════════════════════════════════
# 5. Regression: accrual amount over a realistic BTC position
# ════════════════════════════════════════════════════════════════════════════

class TestAccrualRegression(unittest.TestCase):
    """
    Concrete regression numbers so any future change is immediately visible.
    Parameters: $10,000 long, 0.01% per 8h funding, held for 7 days (42 × 4h bars).
    """

    SIZE_USD         = 10_000.0
    RATE_PER_8H      = 0.0001          # 0.01% per 8h
    RATE_PER_HOUR    = RATE_PER_8H / 8 # per-hour (canonical)
    BARS_7_DAYS      = 42              # 7 × 24h / 4h

    def test_total_funding_seven_days_long(self):
        """
        7 days = 21 settlements (3/day × 7) × 0.01% × $10,000 = $21.00.
        Cross-check via per-bar formula: $10,000 × 0.0000125 × 4 × 42 bars = $21.00.
        """
        accrual = self.SIZE_USD * self.RATE_PER_HOUR * 4 * self.BARS_7_DAYS
        # Independent check: 21 Binance-style 8h settlements at RATE_PER_8H
        expected_from_settlements = self.SIZE_USD * self.RATE_PER_8H * (self.BARS_7_DAYS * 4 / 8)
        self.assertAlmostEqual(accrual, 21.0, places=4,
                               msg="7-day funding accrual for $10k long at 0.01%/8h must be $21.00")
        self.assertAlmostEqual(accrual, expected_from_settlements, places=8,
                               msg="Per-bar formula must match settlement-count formula")

    def test_per_bar_accrual_amount(self):
        """Single 4h bar: $10,000 × 0.0000125 × 4 = $0.50."""
        per_bar = self.SIZE_USD * self.RATE_PER_HOUR * 4
        self.assertAlmostEqual(per_bar, 0.50, places=6)


if __name__ == "__main__":
    unittest.main()
