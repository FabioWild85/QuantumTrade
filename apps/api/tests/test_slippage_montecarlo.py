"""
Tests for the Slippage Model and Monte Carlo backtest validation features (June 2026).

Both features are toggle-based (default OFF) and additive:
  - Slippage: `_apply_slippage()` adjusts the execution price adversely on market
    fills (entry, SL, liquidation ×sl_mult) and leaves passive limit fills
    (tp, partial, entry_limit) untouched when `limit_favorable=True`.
  - Monte Carlo: `_monte_carlo_analysis()` is a pure post-backtest function over
    the trades list — bootstrap/shuffle resampling of pnl_pct sequences.

Non-regression guarantee: with the toggles OFF the engine never calls the helper
(`_slip` returns the input price immediately) and `montecarlo_result` stays None.
"""

import time

import numpy as np
import pytest

from services.backtesting import _apply_slippage, _monte_carlo_analysis


BPS = 3.0          # 3 basis points
SL_MULT = 2.0
FRAC = BPS / 10_000.0


# ─────────────────────────────────────────────────────────────────────────────
# Slippage — direction and magnitude
# ─────────────────────────────────────────────────────────────────────────────

class TestSlippageDirection:
    """Adverse slippage must always worsen the price for the executing side."""

    def test_entry_long_pays_more(self):
        px = _apply_slippage(100.0, "long", "entry", BPS, SL_MULT, True)
        assert px == pytest.approx(100.0 * (1 + FRAC))

    def test_entry_short_sells_lower(self):
        px = _apply_slippage(100.0, "short", "entry", BPS, SL_MULT, True)
        assert px == pytest.approx(100.0 * (1 - FRAC))

    def test_sl_long_exits_lower_with_multiplier(self):
        px = _apply_slippage(100.0, "long", "sl", BPS, SL_MULT, True)
        assert px == pytest.approx(100.0 * (1 - FRAC * SL_MULT))

    def test_sl_short_exits_higher_with_multiplier(self):
        px = _apply_slippage(100.0, "short", "sl", BPS, SL_MULT, True)
        assert px == pytest.approx(100.0 * (1 + FRAC * SL_MULT))

    def test_liquidation_uses_sl_multiplier(self):
        px_liq = _apply_slippage(100.0, "long", "liquidation", BPS, SL_MULT, True)
        px_sl  = _apply_slippage(100.0, "long", "sl",          BPS, SL_MULT, True)
        assert px_liq == px_sl  # same forced-execution penalty

    def test_market_close_long_normal_bps(self):
        px = _apply_slippage(100.0, "long", "market_close", BPS, SL_MULT, True)
        assert px == pytest.approx(100.0 * (1 - FRAC))  # no sl_mult

    def test_market_close_short_normal_bps(self):
        px = _apply_slippage(100.0, "short", "market_close", BPS, SL_MULT, True)
        assert px == pytest.approx(100.0 * (1 + FRAC))


class TestSlippageLimitFavorable:
    """Passive limit executions must be exempt when limit_favorable=True."""

    @pytest.mark.parametrize("kind", ["tp", "partial", "entry_limit"])
    def test_limit_kinds_exempt(self, kind):
        for side in ("long", "short"):
            assert _apply_slippage(100.0, side, kind, BPS, SL_MULT, True) == 100.0

    def test_tp_not_exempt_when_flag_off(self):
        px = _apply_slippage(100.0, "long", "tp", BPS, SL_MULT, False)
        assert px == pytest.approx(100.0 * (1 - FRAC))  # exit adverse

    def test_entry_limit_not_exempt_when_flag_off(self):
        px = _apply_slippage(100.0, "long", "entry_limit", BPS, SL_MULT, False)
        assert px == pytest.approx(100.0 * (1 + FRAC))  # entry adverse

    def test_partial_not_exempt_when_flag_off(self):
        px = _apply_slippage(100.0, "short", "partial", BPS, SL_MULT, False)
        assert px == pytest.approx(100.0 * (1 + FRAC))


class TestSlippageNoOpGuards:
    """bps<=0 must be a strict no-op — guarantees baseline identity."""

    @pytest.mark.parametrize("kind", ["entry", "entry_limit", "sl", "tp",
                                      "liquidation", "partial", "market_close"])
    @pytest.mark.parametrize("side", ["long", "short"])
    def test_zero_bps_is_identity(self, kind, side):
        assert _apply_slippage(12345.6789, side, kind, 0.0, SL_MULT, True) == 12345.6789

    def test_negative_bps_is_identity(self):
        assert _apply_slippage(100.0, "long", "entry", -1.0, SL_MULT, True) == 100.0


class TestSlippageEconomics:
    """Slippage must always erode (or leave unchanged) the round-trip PnL."""

    @pytest.mark.parametrize("side", ["long", "short"])
    @pytest.mark.parametrize("exit_kind", ["sl", "tp", "market_close", "liquidation"])
    def test_round_trip_pnl_never_improves(self, side, exit_kind):
        entry_raw, exit_raw = 100.0, 105.0 if side == "long" else 95.0
        entry_px = _apply_slippage(entry_raw, side, "entry", BPS, SL_MULT, True)
        exit_px  = _apply_slippage(exit_raw,  side, exit_kind, BPS, SL_MULT, True)

        def pnl(e, x):
            return (x - e) / e if side == "long" else (e - x) / e

        assert pnl(entry_px, exit_px) <= pnl(entry_raw, exit_raw) + 1e-12


# ─────────────────────────────────────────────────────────────────────────────
# Monte Carlo
# ─────────────────────────────────────────────────────────────────────────────

def _make_trades(pnls, initial_capital=10_000.0, size_frac=1.0):
    """
    Build coherent trade records the way run_backtest does: each record carries
    pnl_usd and equity_after. `pnls` are price-move percentages on the notional;
    `size_frac` is size_usd/equity (1.0 = full equity per trade).
    The MC derives the per-trade equity return as pnl_usd / (equity_after - pnl_usd).
    """
    trades, equity = [], initial_capital
    for p in pnls:
        pnl_usd = equity * size_frac * p / 100.0
        equity += pnl_usd
        trades.append({"pnl_pct": p, "pnl_usd": round(pnl_usd, 6),
                       "equity_after": round(equity, 6)})
    return trades


class TestMonteCarlo:

    def test_insufficient_trades(self):
        out = _monte_carlo_analysis(_make_trades([1.0] * 9), 10_000.0)
        assert out["status"] == "insufficient_trades"
        assert out["n_trades"] == 9

    def test_ok_structure(self):
        rng = np.random.default_rng(0)
        out = _monte_carlo_analysis(_make_trades(rng.normal(0.5, 2.0, 100)),
                                    10_000.0, runs=2000)
        assert out["status"] == "ok"
        assert out["runs"] == 2000
        assert out["n_trades"] == 100
        assert set(out["max_dd"]) == {"p5", "p25", "p50", "p95"}
        assert set(out["final_pnl_pct"]) == {"p5", "p50", "p95"}
        # Percentile ordering — DD values are negative, p5 is the worst
        dd = out["max_dd"]
        assert dd["p5"] <= dd["p25"] <= dd["p50"] <= dd["p95"] <= 0.0
        pnl = out["final_pnl_pct"]
        assert pnl["p5"] <= pnl["p50"] <= pnl["p95"]
        assert 0.0 <= out["prob_negative_year"] <= 100.0
        assert 0.0 <= out["prob_dd_gt_20"] <= 100.0

    def test_seed_reproducibility(self):
        trades = _make_trades(np.random.default_rng(1).normal(0.3, 1.5, 80))
        a = _monte_carlo_analysis(trades, 10_000.0, runs=1500)
        b = _monte_carlo_analysis(trades, 10_000.0, runs=1500)
        assert a == b

    def test_all_winning_trades_zero_negative_prob(self):
        out = _monte_carlo_analysis(_make_trades([0.5] * 50), 10_000.0, runs=1000)
        assert out["prob_negative_year"] == 0.0
        assert out["prob_dd_gt_20"] == 0.0
        assert out["max_dd"]["p50"] == 0.0

    def test_shuffle_preserves_final_pnl(self):
        """Shuffle reorders the SAME trades → final PnL identical in every run."""
        pnls = list(np.random.default_rng(2).normal(0.2, 1.0, 40))
        out = _monte_carlo_analysis(_make_trades(pnls), 10_000.0,
                                    runs=1000, method="shuffle")
        # All percentiles of final pnl collapse to the single deterministic value
        assert out["final_pnl_pct"]["p5"] == out["final_pnl_pct"]["p95"]
        expected = (np.prod(1 + np.array(pnls) / 100.0) - 1) * 100
        assert out["final_pnl_pct"]["p50"] == pytest.approx(expected, abs=0.01)

    def test_convergence_small_vs_large_runs(self):
        """Percentiles must converge between 1k and 20k runs (stability check)."""
        trades = _make_trades(np.random.default_rng(3).normal(0.4, 2.5, 200))
        small = _monte_carlo_analysis(trades, 10_000.0, runs=1000)
        large = _monte_carlo_analysis(trades, 10_000.0, runs=20000)
        assert small["max_dd"]["p50"] == pytest.approx(large["max_dd"]["p50"], abs=2.0)
        # Final PnL is compounded over 200 trades → wide distribution; the p50
        # estimate from 1k samples carries sampling error ∝ distribution width.
        assert small["final_pnl_pct"]["p50"] == pytest.approx(
            large["final_pnl_pct"]["p50"], rel=0.10)

    def test_performance_5000_runs_under_2s(self):
        trades = _make_trades(np.random.default_rng(4).normal(0.3, 2.0, 300))
        t0 = time.perf_counter()
        out = _monte_carlo_analysis(trades, 10_000.0, runs=5000)
        elapsed = time.perf_counter() - t0
        assert out["status"] == "ok"
        assert elapsed < 2.0, f"Monte Carlo too slow: {elapsed:.2f}s"

    def test_trades_without_pnl_fields_are_skipped(self):
        trades = _make_trades([1.0] * 20) + [{"reason": "weird"}] * 5
        out = _monte_carlo_analysis(trades, 10_000.0, runs=1000)
        assert out["n_trades"] == 20

    def test_fractional_sizing_matches_real_total_pnl(self):
        """Regression (bug 12/06/2026): MC componeva pnl_pct (variazione prezzo
        sul nozionale) come se il 100% dell'equity fosse in ogni trade — con
        size ≈ 30% dell'equity riportava ~+390% contro un reale +68%. Usando i
        rendimenti-equity, lo shuffle deve riprodurre il PnL reale per QUALSIASI
        sizing."""
        pnls = list(np.random.default_rng(5).normal(0.8, 2.0, 120))
        trades = _make_trades(pnls, size_frac=0.3)
        real_total = (trades[-1]["equity_after"] / 10_000.0 - 1) * 100
        out = _monte_carlo_analysis(trades, 10_000.0, runs=500, method="shuffle")
        assert out["final_pnl_pct"]["p5"] == out["final_pnl_pct"]["p95"]  # ordine ininfluente
        assert out["final_pnl_pct"]["p50"] == pytest.approx(real_total, abs=0.05)
        # Il vecchio calcolo full-equity avrebbe prodotto un numero gonfiato e diverso
        inflated = (np.prod(1 + np.array(pnls) / 100.0) - 1) * 100
        assert abs(inflated - real_total) > 30

    def test_dd_scales_with_position_size(self):
        """Il DD simulato deve riflettere la size reale: con size al 30%
        dell'equity il drawdown è ~1/3 di quello full-equity, mai uguale."""
        pnls = list(np.random.default_rng(6).normal(0.0, 2.0, 100))
        full = _monte_carlo_analysis(_make_trades(pnls, size_frac=1.0), 10_000.0, runs=2000)
        frac = _monte_carlo_analysis(_make_trades(pnls, size_frac=0.3), 10_000.0, runs=2000)
        assert abs(frac["max_dd"]["p50"]) < abs(full["max_dd"]["p50"]) * 0.5
