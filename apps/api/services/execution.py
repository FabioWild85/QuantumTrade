"""
Execution Engine — main asyncio loop.
Event-driven via Hyperliquid WebSocket candle close.
Every 4h close: fetch data → features → Chronos-2 → LightGBM → decide → execute → log.
LightGBM is retrained automatically every 120 cycles (~30 days).
"""

import asyncio
import copy
import logging
import math
import os
import uuid
from dataclasses import dataclass
from datetime import datetime, timezone, timedelta
from typing import Optional

import numpy as np
import pandas as pd

from services.hl_websocket import HLWebSocket
from services.hyperliquid_data import HyperliquidData
from services.smc import build_all_features, ALL_FEATURES, build_4h_context_for_1h
from services.chronos_model import ChronosForecaster
from services.decision import DecisionEngine, DecisionResult, compute_qt_score
from services.risk import RiskManager, apply_structural_sl, apply_fvg_sl, apply_swing_sl
from services.notifications import TelegramNotifier
from services.trainer import LGBMTrainer, load_model, load_correct_model, load_1h_model, _retrain_lock, _retrain_1h_lock
from services.covariates import update_covariates, get_latest_covariates
from services.supabase_client import get_supabase
from services.regime_detector import RegimeDetector, RegimeSignal

HL_TAKER_FEE = 0.00035  # 0.035% per side

log = logging.getLogger(__name__)

SYMBOL    = "BTC"
INTERVAL  = "4h"
CANDLE_MS = 14_400_000  # 4h in ms

HL_TESTNET        = os.getenv("HL_TESTNET", "true").lower() == "true"
HL_AGENT_PRIVKEY  = os.getenv("HL_AGENT_PRIVATE_KEY", "")  # for live order signing

# Retrain every N completed cycles (~30 days on 4h bars)
RETRAIN_INTERVAL = 120  # default — ora configurabile via BotConfig.retrain_every_n_cycles

CIRCUIT_BREAKER_THRESHOLD = 5   # stop bot after N consecutive cycle errors

# Concept drift: check every N cycles (~4 days on 4H), cooldown 24h between retrains
DRIFT_CHECK_INTERVAL     = 24
DRIFT_RETRAIN_COOLDOWN_H = 24


# ── Pullback Entry state ──────────────────────────────────────────────────────

@dataclass
class PendingPullback:
    """Active pullback pending signal — created when a strong impulse candle is detected."""
    direction:      str            # "long" | "short"
    close_4h:       float          # 4H close price at signal time
    atr_at_signal:  float          # ATR_14 at signal time (anchors all zone calculations)
    pullback_zone:  float          # target entry price (OB level or ATR-based)
    fallback_limit: float          # price beyond which signal decays (opposite direction)
    expires_at:     datetime       # absolute expiry timestamp
    decision_result: object        # original DecisionResult (size_factor, reasoning, etc.)
    ob_sl_price:    Optional[float] = None  # structural SL when OB mode active
    ob_order_id:    Optional[str]   = None  # HL GTC order ID (live mode only)


@dataclass
class PendingBounceFade:
    """
    Active bounce-fade pending — created when a counter-trend signal fires in a
    bouncing market. Instead of entering at market, waits for the bounce to climb
    toward overhead resistance and fills with a tighter SL → better R:R.
    Single limit entry (NOT laddered); market fallback at expiry if signal persists.
    """
    direction:       str            # "long" | "short"
    close_4h:        float          # 4H close at signal time
    atr_at_signal:   float          # ATR_14 at signal time
    entry_limit:     float          # computed limit price (penetration toward resistance)
    resistance:      float          # nearest overhead resistance / underlying support used
    bounce_extreme:  float          # running high (short) / low (long) reached during window
    orig_tp:         float          # original absolute TP from the signal (kept on fill)
    orig_size_usd:   float          # original risk-based size (frozen — prevents size explosion)
    sl_buffer_atr:   float          # SL buffer above resistance, in ATR
    sl_min_atr:      float          # SL distance floor, in ATR (anti-noise)
    min_rr:          float          # minimum R:R to accept the limit fill
    expires_at:      datetime       # absolute expiry timestamp
    decision_result: object         # original DecisionResult (for market fallback)
    market_fallback: bool           # enter at market on expiry if signal still valid


# ── Config dataclass ──────────────────────────────────────────────────────────

class BotConfig:
    def __init__(self, **kw):
        self.sl_atr_mult            = kw.get("sl_atr_mult", 2.0)
        self.tp_atr_mult            = kw.get("tp_atr_mult", 3.5)
        self.position_size_pct      = kw.get("position_size_pct", 1.5)
        self.max_daily_dd_pct       = kw.get("max_daily_dd_pct", 3.0)
        self.directional_threshold  = kw.get("directional_threshold", 0.62)
        self.adx_gate               = kw.get("adx_gate", 20.0)
        self.confluence_gate        = kw.get("confluence_gate", 60.0)
        self.max_consecutive_losses = kw.get("max_consecutive_losses", 4)
        self.mode                   = kw.get("mode", "paper")
        # ── Advanced exit strategies ──────────────────────────────────────────
        # Partial TP: close partial_tp_pct% of position at partial_tp_atr_mult×ATR
        self.partial_tp_enabled     = kw.get("partial_tp_enabled", False)
        self.partial_tp_atr_mult    = kw.get("partial_tp_atr_mult", 1.5)
        self.partial_tp_pct         = kw.get("partial_tp_pct", 50.0)
        # Trailing SL: move SL to break-even once price moves trailing_sl_activation×ATR in our favour
        self.trailing_sl_enabled    = kw.get("trailing_sl_enabled", False)
        self.trailing_sl_activation = kw.get("trailing_sl_activation", 1.5)
        # LightGBM mid-trade exit: exit only after N consecutive bars below threshold
        self.lgbm_exit_enabled       = kw.get("lgbm_exit_enabled",       False)
        self.lgbm_exit_threshold     = kw.get("lgbm_exit_threshold",     0.30)
        self.lgbm_exit_min_hold_bars = kw.get("lgbm_exit_min_hold_bars", 6)
        self.lgbm_exit_confirm_bars  = kw.get("lgbm_exit_confirm_bars",  2)
        self.enhanced_exit_enabled   = kw.get("enhanced_exit_enabled",   False)
        # ── Advanced signal controls ──────────────────────────────────────────
        self.chronos_enabled         = kw.get("chronos_enabled",         True)
        self.chronos_weight          = kw.get("chronos_weight",          0.40)
        self.adx_gate_enabled        = kw.get("adx_gate_enabled",        True)
        self.sweep_gate_enabled      = kw.get("sweep_gate_enabled",      True)
        self.sweep_gate_directional  = kw.get("sweep_gate_directional",  False)
        self.fvg_filter_enabled      = kw.get("fvg_filter_enabled",      True)
        self.mtf_alignment_enabled   = kw.get("mtf_alignment_enabled",   True)
        # ── Advanced exit ─────────────────────────────────────────────────────
        self.be_sl_enabled           = kw.get("be_sl_enabled",           False)
        self.be_sl_activation        = kw.get("be_sl_activation",        1.0)
        self.max_hold_bars_enabled      = kw.get("max_hold_bars_enabled",      False)
        self.max_hold_bars              = kw.get("max_hold_bars",              48)
        # Chronos-2 adaptive features
        self.c2_uncertainty_gate_enabled = kw.get("c2_uncertainty_gate_enabled", False)
        self.c2_uncertainty_threshold    = kw.get("c2_uncertainty_threshold",    0.05)
        self.c2_cont_prob_gate_enabled   = kw.get("c2_cont_prob_gate_enabled",   False)
        self.c2_cont_prob_threshold      = kw.get("c2_cont_prob_threshold",      0.25)
        self.dynamic_sl_tp_enabled       = kw.get("dynamic_sl_tp_enabled",       False)
        self.dynamic_sl_tp_blend         = kw.get("dynamic_sl_tp_blend",         0.50)
        self.p10_sl_floor_enabled        = kw.get("p10_sl_floor_enabled",        False)
        # Thresholds calibration flag (used in risk.calculate_trade_params)
        self.recalibrated_uncertainty_thresholds = kw.get("recalibrated_uncertainty_thresholds", True)
        # Regime Bias: asymmetric threshold by market direction
        self.regime_bias_enabled     = kw.get("regime_bias_enabled",     False)
        self.regime_bias_delta       = kw.get("regime_bias_delta",       0.08)
        self.regime_bias_size_factor = kw.get("regime_bias_size_factor", 1.0)
        self.forced_regime           = kw.get("forced_regime",           "auto")
        self.regime_bias_enhanced    = kw.get("regime_bias_enhanced",    False)
        # CVD Absorption Filter
        self.absorption_filter_enabled = kw.get("absorption_filter_enabled", False)
        self.absorption_z_threshold    = kw.get("absorption_z_threshold",    2.0)
        # Binance Cross-Exchange CVD
        self.binance_cvd_enabled       = kw.get("binance_cvd_enabled",       False)
        # Options IV Bias (Phase 1)
        self.options_bias_enabled      = kw.get("options_bias_enabled",      False)
        self.iv_high_percentile        = kw.get("iv_high_percentile",        80.0)
        self.iv_low_percentile         = kw.get("iv_low_percentile",         20.0)
        self.iv_size_factor            = kw.get("iv_size_factor",            0.7)
        # Signal quality filters
        self.exhaustion_guard_enabled  = kw.get("exhaustion_guard_enabled",  True)
        self.structural_sl_enabled     = kw.get("structural_sl_enabled",     True)
        # Structural SL/TP — OB, FVG, Swing (C4: were missing, silently lost on restart)
        self.ob_buffer_pct             = kw.get("ob_buffer_pct",             0.3)
        self.ob_buffer_min_atr         = kw.get("ob_buffer_min_atr",         0.0)
        self.ob_tp_enabled             = kw.get("ob_tp_enabled",             False)
        self.ob_tp_blend               = kw.get("ob_tp_blend",               1.0)
        self.fvg_sl_enabled            = kw.get("fvg_sl_enabled",            False)
        self.fvg_tp_enabled            = kw.get("fvg_tp_enabled",            False)
        self.fvg_tp_blend              = kw.get("fvg_tp_blend",              1.0)
        self.swing_sl_enabled          = kw.get("swing_sl_enabled",          False)
        self.swing_tp_enabled          = kw.get("swing_tp_enabled",          False)
        self.swing_tp_blend            = kw.get("swing_tp_blend",            1.0)
        # Signal quality — entry filters (C4b: were missing, caused AttributeError on direct access)
        self.dual_atr_enabled          = kw.get("dual_atr_enabled",          False)
        self.late_entry_filter_enabled = kw.get("late_entry_filter_enabled", False)
        self.late_entry_max_ob_dist    = kw.get("late_entry_max_ob_dist",    3.0)
        self.path_obstruction_enabled  = kw.get("path_obstruction_enabled",  False)
        self.path_obstruction_max_dist = kw.get("path_obstruction_max_dist", 1.5)
        self.consec_bars_filter_enabled= kw.get("consec_bars_filter_enabled",False)
        self.consec_bars_max_long      = kw.get("consec_bars_max_long",      8)
        self.consec_bars_max_short     = kw.get("consec_bars_max_short",     8)
        # Walk-forward & retraining parameters
        self.retrain_every_n_cycles  = kw.get("retrain_every_n_cycles",  120)
        self.wf_n_splits             = kw.get("wf_n_splits",             5)
        self.wf_purge_gap            = kw.get("wf_purge_gap",            5)
        # Feature Importance Pruning
        self.use_feature_pruning            = kw.get("use_feature_pruning",            False)
        self.feature_pruning_min_importance = kw.get("feature_pruning_min_importance", 0.005)
        # Isotonic calibration on c2_dir_prob
        self.use_chronos_calibration        = kw.get("use_chronos_calibration",        False)
        # Gate LightGBM 1H — confirmation model on 1H timeframe
        self.use_1h_lgbm_gate               = kw.get("use_1h_lgbm_gate",               False)
        # Optuna hyperparameter tuning (manual/deep retrains only — skipped for auto/drift)
        self.use_optuna                     = kw.get("use_optuna",                     False)
        self.optuna_n_trials                = kw.get("optuna_n_trials",                50)
        self.lgbm_1h_min_agreement          = kw.get("lgbm_1h_min_agreement",          0.52)
        self.lgbm_1h_block_threshold        = kw.get("lgbm_1h_block_threshold",        0.45)
        # Macro Event Pause — block new entries (and optionally close) during high-impact events
        self.macro_pause_enabled        = kw.get("macro_pause_enabled",        False)
        self.macro_pause_window_min     = kw.get("macro_pause_window_min",     60)
        self.macro_pause_close_position = kw.get("macro_pause_close_position", False)
        self.macro_pause_fomc           = kw.get("macro_pause_fomc",           True)
        self.macro_pause_cpi            = kw.get("macro_pause_cpi",            True)
        self.macro_pause_nfp            = kw.get("macro_pause_nfp",            True)
        self.macro_pause_ppi            = kw.get("macro_pause_ppi",            False)
        self.macro_pause_jolts          = kw.get("macro_pause_jolts",          False)
        # Funding Rate Bias
        self.funding_gate_enabled  = kw.get("funding_gate_enabled",  False)
        self.funding_gate_lookback = kw.get("funding_gate_lookback", 6)
        self.funding_high_thr      = kw.get("funding_high_thr",      0.00010)
        self.funding_extreme_thr   = kw.get("funding_extreme_thr",   0.00030)
        self.funding_bias_delta    = kw.get("funding_bias_delta",    0.03)
        # Fear & Greed Bias
        self.fng_gate_enabled      = kw.get("fng_gate_enabled",      False)
        self.fng_extreme_fear_thr  = kw.get("fng_extreme_fear_thr",  20.0)
        self.fng_fear_thr          = kw.get("fng_fear_thr",          35.0)
        self.fng_greed_thr         = kw.get("fng_greed_thr",         65.0)
        self.fng_extreme_greed_thr = kw.get("fng_extreme_greed_thr", 80.0)
        self.fng_bias_delta        = kw.get("fng_bias_delta",        0.03)
        # Exhaustion Guard — configurable thresholds
        self.exhaustion_rsi_low    = kw.get("exhaustion_rsi_low",    28.0)
        self.exhaustion_rsi_high   = kw.get("exhaustion_rsi_high",   72.0)
        self.exhaustion_ret48_pct  = kw.get("exhaustion_ret48_pct",   6.0)
        self.exhaustion_boost      = kw.get("exhaustion_boost",       0.06)
        # ATR% Volatility Gate
        self.atr_pct_gate_enabled  = kw.get("atr_pct_gate_enabled",  False)
        self.atr_pct_min           = kw.get("atr_pct_min",           0.008)
        self.atr_pct_mode          = kw.get("atr_pct_mode",          "scale")
        # OI Spike Gate (Squeeze Protection A)
        self.oi_spike_gate_enabled = kw.get("oi_spike_gate_enabled", False)
        self.oi_spike_thr          = kw.get("oi_spike_thr",          2.0)
        self.oi_spike_mode         = kw.get("oi_spike_mode",         "scale")
        self.oi_spike_lookback     = kw.get("oi_spike_lookback",     2)
        # Long/Short Ratio Gate (Squeeze Protection B)
        self.ls_gate_enabled       = kw.get("ls_gate_enabled",       False)
        self.ls_long_block_pct     = kw.get("ls_long_block_pct",     67.0)
        self.ls_short_block_pct    = kw.get("ls_short_block_pct",    33.0)
        self.ls_gate_mode          = kw.get("ls_gate_mode",          "scale")
        self.ls_gate_scale_factor  = kw.get("ls_gate_scale_factor",  0.50)
        self.ls_lookback_bars      = kw.get("ls_lookback_bars",      1)
        # Liquidation Spike Gate (Squeeze Protection C)
        self.liq_spike_gate_enabled = kw.get("liq_spike_gate_enabled", False)
        self.liq_spike_thr          = kw.get("liq_spike_thr",          2.5)
        self.liq_spike_lookback     = kw.get("liq_spike_lookback",     2)
        self.liq_spike_mode         = kw.get("liq_spike_mode",         "block")
        self.liq_spike_scale_factor = kw.get("liq_spike_scale_factor", 0.40)
        # Weekend Gate — block entries on Sat/Sun (UTC)
        self.weekend_gate_block_saturday = kw.get("weekend_gate_block_saturday", False)
        self.weekend_gate_block_sunday   = kw.get("weekend_gate_block_sunday",   False)
        # Exhaustion Guard — proportional boost (Feature A)
        self.exhaustion_prop_enabled = kw.get("exhaustion_prop_enabled", False)
        self.exhaustion_prop_scale   = kw.get("exhaustion_prop_scale",   0.06)
        # Daily RSI Gate (Feature B)
        self.daily_rsi_gate_enabled  = kw.get("daily_rsi_gate_enabled",  False)
        self.daily_rsi_short_block   = kw.get("daily_rsi_short_block",   18.0)
        self.daily_rsi_long_block    = kw.get("daily_rsi_long_block",    82.0)
        # Volume Climax Gate (Feature C)
        self.vol_climax_gate_enabled = kw.get("vol_climax_gate_enabled", False)
        self.vol_climax_gate_z       = kw.get("vol_climax_gate_z",       2.5)
        self.vol_climax_gate_rsi     = kw.get("vol_climax_gate_rsi",     30.0)
        # C2 Forecast Inversion Gate (Feature D)
        self.c2_inversion_gate_enabled = kw.get("c2_inversion_gate_enabled", False)
        self.c2_inversion_pct          = kw.get("c2_inversion_pct",          0.005)
        # Exhaustion Max Hold (Feature E)
        self.exhaustion_max_hold_enabled = kw.get("exhaustion_max_hold_enabled", False)
        self.exhaustion_max_hold_bars    = kw.get("exhaustion_max_hold_bars",    2)
        # Pullback Entry — delayed entry on strong impulse candles
        self.pullback_entry_enabled    = kw.get("pullback_entry_enabled",    False)
        self.pullback_impulse_atr_mult = kw.get("pullback_impulse_atr_mult", 1.2)
        self.pullback_zone_atr         = kw.get("pullback_zone_atr",         0.3)
        self.pullback_window_h         = kw.get("pullback_window_h",         3)
        self.pullback_fallback_atr     = kw.get("pullback_fallback_atr",     0.5)
        # Bounce-Fade Entry — resistance-anchored limit on counter-trend signals
        self.bounce_fade_enabled            = kw.get("bounce_fade_enabled",            False)
        self.bounce_fade_counter_trend_only = kw.get("bounce_fade_counter_trend_only", True)
        self.bounce_fade_penetration_pct    = kw.get("bounce_fade_penetration_pct",    0.50)
        self.bounce_fade_offset_atr         = kw.get("bounce_fade_offset_atr",         0.50)
        self.bounce_fade_window_bars        = kw.get("bounce_fade_window_bars",        2)
        self.bounce_fade_market_fallback    = kw.get("bounce_fade_market_fallback",    True)
        self.bounce_fade_min_rr             = kw.get("bounce_fade_min_rr",             1.5)
        self.bounce_fade_sl_buffer_atr      = kw.get("bounce_fade_sl_buffer_atr",      0.30)
        self.bounce_fade_sl_min_atr         = kw.get("bounce_fade_sl_min_atr",         0.80)
        # ── Reversal Zone Detector ────────────────────────────────────────────
        # Defaults recalibrated on BTC 4H 3y (2023-06 → 2026-06, 6575 bars) + HL 2y:
        # - score_threshold 0.34: raw weighted score caps at ~0.53 (P99=0.40); 0.38 fired
        #   only 1.0-1.2% of bars. min_components 4→3 since <2.3% of bars reach 4 active.
        # - funding_extreme_thr 0.000028: P90 of funding_cum48 / 48 (default 0.00025 was 9× too high)
        # - wick_threshold 0.50: 7.4% → 14.6% of bars (still selective)
        # - limit_retest + wick_pct 0.25: avg R:R 1.88 (close-mode avg R:R = 1.01, never passes rr_min)
        self.reversal_mode_enabled        = kw.get("reversal_mode_enabled",        False)
        self.reversal_score_threshold     = kw.get("reversal_score_threshold",     0.34)   # recal BTC 4H 3y: 0.38 fired 1.0% of bars, P99=0.40
        self.reversal_min_components      = kw.get("reversal_min_components",      3)      # was 4; only 2% of bars reach 4 active components
        self.reversal_component_min_score = kw.get("reversal_component_min_score", 0.40)   # was 0.50
        self.reversal_size_factor         = kw.get("reversal_size_factor",         0.50)   # was 0.70; conservative until validated
        self.reversal_sl_atr_mult         = kw.get("reversal_sl_atr_mult",         1.2)
        self.reversal_tp_atr_mult         = kw.get("reversal_tp_atr_mult",         2.0)    # was 2.5; 2.0 ATR ≈ 2.4% achievable in 2-3 bars
        self.reversal_rr_min              = kw.get("reversal_rr_min",              1.5)    # was 1.8; wick_pct=0.25 gives avg R:R 1.88
        self.reversal_conflict_block      = kw.get("reversal_conflict_block",      True)
        self.reversal_trend_hold_only     = kw.get("reversal_trend_hold_only",     True)
        self.reversal_max_hold_bars       = kw.get("reversal_max_hold_bars",       4)      # was 6; BTC reversals resolve in <16h or fail
        # Sotto-componenti
        self.reversal_ob_dist_max         = kw.get("reversal_ob_dist_max",         2.0)
        self.reversal_consec_bars_min     = kw.get("reversal_consec_bars_min",     5)
        self.reversal_adx_peak_min        = kw.get("reversal_adx_peak_min",        35.0)   # was 32; >32 fires 33.7% of bars (too common)
        self.reversal_ema50_dist_extreme  = kw.get("reversal_ema50_dist_extreme",  3.0)
        self.reversal_ret48_extreme       = kw.get("reversal_ret48_extreme",       0.08)
        self.reversal_transition_risk_min = kw.get("reversal_transition_risk_min", 0.55)
        self.reversal_bars_in_regime_min  = kw.get("reversal_bars_in_regime_min",  40)
        self.reversal_funding_extreme_thr = kw.get("reversal_funding_extreme_thr", 0.000028)  # was 0.00025; P90/48 on actual BTC data
        self.reversal_absorption_z        = kw.get("reversal_absorption_z",        1.8)
        self.reversal_wick_threshold      = kw.get("reversal_wick_threshold",      0.50)   # was 0.60; 7.4% → 14.6% of bars
        self.reversal_vol_climax_z        = kw.get("reversal_vol_climax_z",        2.0)
        self.reversal_stoch_ob            = kw.get("reversal_stoch_ob",            0.65)
        self.reversal_stoch_os            = kw.get("reversal_stoch_os",            0.35)
        self.reversal_rsi_div_threshold   = kw.get("reversal_rsi_div_threshold",   0.03)
        # Amplificatori Daily
        self.reversal_daily_rsi_extreme_high = kw.get("reversal_daily_rsi_extreme_high", 75.0)
        self.reversal_daily_rsi_extreme_low  = kw.get("reversal_daily_rsi_extreme_low",  25.0)
        self.reversal_daily_ema_dist_extreme = kw.get("reversal_daily_ema_dist_extreme",   4.0)
        # Amplificatore IV
        self.reversal_iv_exhaustion_high  = kw.get("reversal_iv_exhaustion_high",  80.0)
        # Pending reversal / limit retest
        self.reversal_entry_mode          = kw.get("reversal_entry_mode",          "limit_retest")
        self.reversal_retest_wick_pct     = kw.get("reversal_retest_wick_pct",     0.25)   # was 0.50; R:R 1.88 vs 1.49 at 0.50
        self.reversal_retest_expiry_bars  = kw.get("reversal_retest_expiry_bars",  3)      # was 2; 12h window instead of 8h
        self.reversal_guard_only          = kw.get("reversal_guard_only",          False)  # True → solo conflict-block, niente trade contro trend

    def model_dump(self) -> dict:
        return self.__dict__


# ── Execution Engine ──────────────────────────────────────────────────────────

class ExecutionEngine:
    def __init__(self):
        self.config  = BotConfig()
        self.running = False
        self.mode    = "paper"

        # Services
        self._hl        = HyperliquidData()
        self._ws        = HLWebSocket(SYMBOL)
        self._chronos   = ChronosForecaster()
        self._notifier  = TelegramNotifier()
        self._trainer   = LGBMTrainer()

        # Persistent risk manager — must survive across cycles to track daily PnL
        self._risk = self._build_risk_manager()

        # Model cache — load immediately if available on disk
        self._lgbm_model    = None
        self._lgbm_features = None
        self._lgbm_1h          = None
        self._lgbm_1h_features = None
        self._load_model_from_disk()

        # Regime detection
        self._regime_detector        = RegimeDetector()
        self._regime_signal: Optional[RegimeSignal] = None

        # State
        self._position: Optional[dict]         = None   # active position dict
        self._pending_pullback: Optional[PendingPullback] = None  # pending pullback signal
        self._pending_bounce_fade: Optional[PendingBounceFade] = None  # pending bounce-fade signal
        self._reversal_pending: Optional[dict] = None   # pending reversal (limit-retest mode)
        self._last_reversal_result = None                # cached for /reversal/current endpoint
        self._equity: float             = 10_000.0  # paper equity (USD)
        self._cycle_count: int          = 0
        self._consecutive_errors: int   = 0
        self._retrain_task: Optional[asyncio.Task] = None
        self._task: Optional[asyncio.Task]         = None
        self._last_retrain_metrics: Optional[dict]     = None
        self._last_cycle_signals:   Optional[dict]     = None
        self._macro_pause_active:   Optional[str]      = None
        self._last_drift_retrain:   Optional[datetime] = None
        self._last_drift_result:    Optional[dict]     = None
        self._retrain_due:          bool               = False

        # Economic calendar (loaded once at startup)
        from services.economic_calendar import get_calendar
        self._calendar = get_calendar()
        # Kick off FOMC auto-refresh for next year in the background
        asyncio.create_task(self._calendar.try_refresh_fomc())

    # ── Config ────────────────────────────────────────────────────────────────

    def update_config(self, cfg):
        for k, v in cfg.model_dump().items():
            setattr(self.config, k, v)
        self._risk.update_limits(
            sl_atr_mult=self.config.sl_atr_mult,
            tp_atr_mult=self.config.tp_atr_mult,
            position_size_pct=self.config.position_size_pct,
            max_daily_dd_pct=self.config.max_daily_dd_pct,
            max_consecutive_losses=self.config.max_consecutive_losses,
        )
        log.info("Config updated: %s", cfg.model_dump())

    # ── Lifecycle ─────────────────────────────────────────────────────────────

    async def start(self, mode: str = "paper"):
        if self.running:
            return
        self.mode    = mode
        self.running = True
        self._consecutive_errors = 0

        # Load model from disk if available
        self._load_model_from_disk()

        # Restore paper equity from last DB snapshot (avoids reset to $10k on every restart)
        if mode == "paper":
            await self._restore_paper_state()

        # Start WebSocket
        await self._ws.start()

        # Live only: reconcile open positions before starting the loop
        if mode == "live":
            await self._reconcile_position()

        # Kick off the main loop
        self._task = asyncio.create_task(self._loop())

        # Paper mode: real-time SL/TP watchdog (live mode relies on exchange trigger orders)
        if mode == "paper":
            asyncio.create_task(self._paper_watchdog())

        log.info("Execution engine starting in %s mode", mode.upper())
        await self._notifier.send_bot_started(mode)

    async def stop(self):
        if not self.running:
            return
        self.running = False
        if self._task:
            self._task.cancel()
        await self._ws.stop()
        log.info("Execution engine stopped")
        await self._notifier.send_bot_stopped("manual")

    async def close_position_manual(self) -> dict:
        """Close the current position at mark price without stopping the bot."""
        if not self._position:
            return {"closed": False, "reason": "no_position"}

        # Snapshot entry_price before the await so we have a safe fallback
        # even if _cycle() closes the position concurrently during the network call.
        fallback_price = self._position["entry_price"]
        snap  = await self._hl.get_market_snapshot(SYMBOL)
        price = snap.get("mark_price", fallback_price)
        await self._close_position(price, "manual")  # _close_position guards None internally
        return {"closed": True, "exit_price": price}

    async def open_manual_trade(
        self,
        side: str,
        sl_pct: float,
        tp_pct: float,
        size_usd: float,
        mode_override: Optional[str] = None,
    ) -> dict:
        """Open a manual test trade without going through the ML pipeline."""
        if self._position:
            return {"ok": False, "error": "Position già aperta — chiudila prima di aprire un trade manuale"}

        snap  = await self._hl.get_market_snapshot(SYMBOL)
        price = snap.get("mark_price")
        if not price:
            return {"ok": False, "error": "Impossibile ottenere il prezzo di mercato"}

        # Temporarily switch mode if an override was requested
        _original_mode = self.mode
        if mode_override and mode_override in ("paper", "live"):
            self.mode = mode_override

        try:
            is_long  = (side == "long")
            sl_price = round(price * (1 - sl_pct / 100) if is_long else price * (1 + sl_pct / 100), 1)
            tp_price = round(price * (1 + tp_pct / 100) if is_long else price * (1 - tp_pct / 100), 1)
            rr       = round(tp_pct / sl_pct, 2)

            size_contracts = max(round(size_usd / price, 3), 0.001)
            eff_size_usd   = round(size_contracts * price, 2)
            inference_id   = str(uuid.uuid4())
            hl_order_id    = None

            _atr = price * 0.01  # 1% ATR estimate — not ML-derived
            _is_long = (side == "long")
            _partial_tp_price = (
                (price + self.config.partial_tp_atr_mult * _atr) if _is_long
                else (price - self.config.partial_tp_atr_mult * _atr)
            ) if self.config.partial_tp_enabled else None

            if self.mode == "live":
                hl_order_id = await self._submit_open_order(
                    side, size_contracts, price, sl_price, inference_id,
                    take_profit=tp_price,
                    partial_tp_price=_partial_tp_price,
                    partial_tp_pct=self.config.partial_tp_pct,
                )
                if hl_order_id is None:
                    return {"ok": False, "error": "Invio ordine live fallito — controlla HL_AGENT_PRIVATE_KEY"}

            import hashlib as _mh
            _sl_cloid = (
                "0x" + _mh.md5((inference_id or "").encode() + b"_sl").hexdigest()
                if self.mode == "live" else None
            )

            self._position = {
                "side":                         side,
                "entry_price":                  price,
                "stop_loss":                    sl_price,
                "take_profit":                  tp_price,
                "sl_original":                  sl_price,
                "size_usd":                     eff_size_usd,
                "original_size_usd":            eff_size_usd,
                "size_contracts":               size_contracts,
                "entry_atr":                    _atr,
                "inference_id":                 inference_id,
                "hl_order_id":                  hl_order_id,
                "opened_at":                    datetime.now(timezone.utc).isoformat(),
                "bars_held":                    0,
                "lgbm_strikes":                 0,
                "be_sl_applied":                False,
                "sl_trailing_active":           False,
                "high_water":                   price,
                "partial_done":                 False,
                "partial_realized_pnl":         0.0,
                "entry_reasoning":              [
                    f"[MANUAL] {side.upper()} @ {price:.2f}",
                    f"SL={sl_price:.2f} (−{sl_pct:.1f}%)  TP={tp_price:.2f} (+{tp_pct:.1f}%)  R:R={rr:.2f}",
                    f"Size={eff_size_usd:.2f} USD  Mode={self.mode.upper()}",
                ],
                "partial_tp_price":             _partial_tp_price,
                "trailing_sl_activation_price": None,
                "trailing_sl_dist":             None,
                "current_sl_cloid":             _sl_cloid,
                "manual_trade":                 True,
            }

            if self.mode == "paper":
                self._save_paper_position()

            try:
                db = get_supabase()
                order_res = db.table("orders").insert({
                    "bot_id":       "default",
                    "hl_order_id":  hl_order_id,
                    "symbol":       SYMBOL,
                    "side":         side,
                    "size":         size_contracts,
                    "price":        round(price, 2),
                    "status":       "filled" if self.mode == "paper" else "pending",
                    "inference_id": inference_id,
                }).execute()
                if order_res.data:
                    self._position["trade_id"] = order_res.data[0].get("id")
                    if self.mode == "paper":
                        self._save_paper_position()
                db.table("events").insert({
                    "severity": "info",
                    "kind":     "trade_opened",
                    "message":  f"[MANUAL {self.mode.upper()}] {side.upper()} {size_contracts} BTC @ {price:.2f} | SL={sl_price:.2f} TP={tp_price:.2f} R:R={rr:.2f}",
                    "payload":  {
                        "side": side, "symbol": SYMBOL, "size": size_contracts,
                        "price": round(price, 2), "sl": sl_price, "tp": tp_price,
                        "rr": rr, "size_usd": eff_size_usd, "mode": self.mode, "manual": True,
                    },
                }).execute()
            except Exception as exc:
                log.warning("Manual trade DB insert failed: %s", exc)

            log.info("Manual trade opened: %s %s @ %.2f | SL=%.2f TP=%.2f mode=%s",
                     side.upper(), SYMBOL, price, sl_price, tp_price, self.mode)

            return {
                "ok":             True,
                "side":           side,
                "mode":           self.mode,
                "entry_price":    round(price, 2),
                "stop_loss":      sl_price,
                "take_profit":    tp_price,
                "rr":             rr,
                "size_contracts": size_contracts,
                "size_usd":       eff_size_usd,
            }

        except Exception as exc:
            # Restore mode on unexpected error and clear any partial state
            self.mode      = _original_mode
            self._position = None
            log.error("open_manual_trade failed: %s", exc, exc_info=True)
            return {"ok": False, "error": str(exc)}

    async def kill(self) -> dict:
        """Emergency: cancel open orders, close positions immediately."""
        self.running = False
        if self._task:
            self._task.cancel()
        await self._ws.stop()

        # Cancel pending reversal state
        if self._reversal_pending is not None:
            log.info("Kill switch: cancelling pending reversal (%s)", self._reversal_pending["direction"])
            self._reversal_pending = None
            self._persist_reversal_pending(None)

        # Cancel any active GTC limit order and pending pullback signal
        if self._pending_pullback is not None:
            pb = self._pending_pullback
            if pb.ob_order_id is not None and self.mode == "live":
                try:
                    await self._cancel_ob_limit_order(pb.ob_order_id)
                except Exception as _ke:
                    log.warning("Kill: cancel OB limit order failed: %s", _ke)
            log.info("Kill switch: cancelled pending pullback (%s)", pb.direction)
            self._pending_pullback = None

        if self._pending_bounce_fade is not None:
            log.info("Kill switch: cancelled pending bounce-fade (%s)",
                     self._pending_bounce_fade.direction)
            self._pending_bounce_fade = None

        orders_cancelled = 0
        positions_closed = 0

        if self._position:
            try:
                snap  = await self._hl.get_market_snapshot(SYMBOL)
                price = snap.get("mark_price", self._position["entry_price"])
                await self._close_position(price, "kill")
                positions_closed = 1
            except Exception as exc:
                log.error("Kill: close position failed: %s", exc)

        self._position = None  # safety net if _close_position was never reached
        log.warning("KILL SWITCH activated")
        return {"orders_cancelled": orders_cancelled, "positions_closed": positions_closed}

    async def _reconcile_position(self):
        """
        On live startup: query HL for any existing open position and restore
        self._position from it, preventing a double-open on restart.
        """
        wallet = os.getenv("HL_WALLET_ADDRESS", "")
        if not wallet:
            log.warning("Reconciliation skipped: HL_WALLET_ADDRESS not set")
            return

        hl_pos = await self._hl.get_open_position(wallet, SYMBOL)
        if hl_pos is None:
            log.info("Reconciliation: no open position on HL")
            return

        # Restore in-memory position from HL state (HL is authoritative for size/entry)
        self._position = {
            "side":               hl_pos["side"],
            "entry_price":        hl_pos["entry_price"],
            "stop_loss":          0.0,   # overwritten below if we have saved state
            "take_profit":        0.0,   # overwritten below if we have saved state
            "size_usd":           hl_pos["size_contracts"] * hl_pos["entry_price"],
            "size_contracts":     hl_pos["size_contracts"],
            "entry_atr":          None,
            "inference_id":       None,
            "hl_order_id":        None,
            "opened_at":          datetime.now(timezone.utc).isoformat(),
            "bars_held":              0,
            "lgbm_strikes":           0,
            "be_sl_applied":          False,
            "sl_trailing_active":     False,
            "high_water":             hl_pos["entry_price"],
            "partial_done":           False,
            "partial_realized_pnl":   0.0,
            "reconciled":             True,   # flag: position was re-read from HL on restart
        }

        # Merge saved in-flight state from DB (trailing SL progress, partial TP status, etc.)
        try:
            db = get_supabase()
            cfg_row = db.table("bot_configs").select("params").eq("name", "default").execute()
            saved_state = (cfg_row.data[0].get("params") or {}).get("_live_position_state") if cfg_row.data else None
            if saved_state and saved_state.get("stop_loss", 0.0) > 0.0:
                self._position.update({
                    "stop_loss":               saved_state.get("stop_loss", 0.0),
                    "take_profit":             saved_state.get("take_profit", 0.0),
                    "bars_held":               saved_state.get("bars_held", 0),
                    "lgbm_strikes":            saved_state.get("lgbm_strikes", 0),
                    "be_sl_applied":           saved_state.get("be_sl_applied", False),
                    "sl_trailing_active":      saved_state.get("sl_trailing_active", False),
                    "high_water":              saved_state.get("high_water") or hl_pos["entry_price"],
                    "partial_done":            saved_state.get("partial_done", False),
                    "partial_realized_pnl":    saved_state.get("partial_realized_pnl", 0.0),
                    "sl_original":             saved_state.get("sl_original"),
                    "entry_atr":               saved_state.get("entry_atr"),
                    "inference_id":            saved_state.get("inference_id"),
                    "hl_order_id":             saved_state.get("hl_order_id"),
                    "opened_at":               saved_state.get("opened_at") or self._position["opened_at"],
                    "partial_tp_price":        saved_state.get("partial_tp_price"),
                    "trailing_sl_activation_price": saved_state.get("trailing_sl_activation_price"),
                    "trailing_sl_dist":        saved_state.get("trailing_sl_dist"),
                    "trade_id":                saved_state.get("trade_id"),
                    "current_sl_cloid":        saved_state.get("current_sl_cloid"),
                    # Use HL-authoritative values for size (partial TP may have updated on exchange)
                    "size_usd":                saved_state.get("size_usd") or self._position["size_usd"],
                    "size_contracts":          saved_state.get("size_contracts") or self._position["size_contracts"],
                    "original_size_usd":       saved_state.get("original_size_usd"),
                })
                log.info(
                    "Reconciliation: restored in-flight state from DB — "
                    "bars_held=%d sl=%.2f partial_done=%s trailing=%s",
                    self._position["bars_held"], self._position["stop_loss"],
                    self._position["partial_done"], self._position["sl_trailing_active"],
                )
        except Exception as exc:
            log.warning("Could not restore live position state from DB: %s", exc)

        sl_tp_note = (
            f"SL={self._position['stop_loss']:.2f} TP={self._position['take_profit']:.2f}"
            if self._position["stop_loss"] > 0.0
            else "SL/TP non noti — verificare manualmente"
        )
        log.warning(
            "Reconciliation: restored %s position %.4f BTC @ %.2f (unrealized PnL: $%.2f). %s",
            hl_pos["side"].upper(), hl_pos["size_contracts"],
            hl_pos["entry_price"], hl_pos["unrealized_pnl"], sl_tp_note,
        )
        try:
            db = get_supabase()
            db.table("events").insert({
                "severity": "warning",
                "kind":     "position_reconciled",
                "message":  (
                    f"Posizione esistente rilevata su HL al restart: "
                    f"{hl_pos['side'].upper()} {hl_pos['size_contracts']} BTC @ {hl_pos['entry_price']:.2f}"
                ),
                "payload":  hl_pos,
            }).execute()
        except Exception:
            pass
        await self._notifier.send_error(
            f"⚠️ Posizione esistente rilevata su HL al restart: "
            f"{hl_pos['side'].upper()} {hl_pos['size_contracts']} BTC @ {hl_pos['entry_price']:.2f}. "
            f"{sl_tp_note}",
            "reconciliation"
        )

    async def _restore_paper_state(self):
        """
        Paper mode startup: restore equity from last DB snapshot and
        rehydrate any open paper position from bot_configs.params.
        Prevents equity reset to $10k and open-trade loss on every restart.
        """
        try:
            db = get_supabase()

            # 1. Restore equity from most recent snapshot
            snap = db.table("equity_snapshots") \
                     .select("equity_usd") \
                     .order("time", desc=True) \
                     .limit(1).execute()
            if snap.data:
                self._equity = float(snap.data[0]["equity_usd"])
                log.info("Paper equity restored from DB: $%.2f", self._equity)

            # 2. Restore open paper position if saved in bot_configs
            cfg_row = db.table("bot_configs") \
                        .select("params") \
                        .eq("name", "default").execute()
            if cfg_row.data:
                saved_pos = (cfg_row.data[0].get("params") or {}).get("_paper_position")
                if saved_pos:
                    self._position = saved_pos
                    log.info(
                        "Paper position restored: %s %.4f BTC @ %.2f",
                        saved_pos["side"].upper(), saved_pos["size_contracts"], saved_pos["entry_price"],
                    )
                    # Re-add partial TP PnL realized during this trade to the restored equity.
                    # equity_snapshots is only written on trade close, so any partial PnL
                    # realized after the last snapshot is not included in the restored equity.
                    _partial_pnl = float(saved_pos.get("partial_realized_pnl") or 0.0)
                    if _partial_pnl != 0.0:
                        self._equity += _partial_pnl
                        log.info(
                            "Equity adjusted for restored partial TP PnL: +$%.2f → $%.2f",
                            _partial_pnl, self._equity,
                        )
                    # Backfill UI-display fields added after this position was saved.
                    # _manage_position() recomputes these independently; these copies
                    # exist only so the Monitor card can show them immediately.
                    _e    = self._position.get("entry_price", 0)
                    _atr  = self._position.get("entry_atr") or _e * 0.01
                    _long = self._position.get("side", "long") == "long"
                    if "sl_original" not in self._position:
                        self._position["sl_original"] = self._position.get("stop_loss")
                    if "partial_tp_price" not in self._position:
                        self._position["partial_tp_price"] = (
                            (_e + self.config.partial_tp_atr_mult * _atr) if _long
                            else (_e - self.config.partial_tp_atr_mult * _atr)
                        ) if self.config.partial_tp_enabled else None
                    if "trailing_sl_activation_price" not in self._position:
                        self._position["trailing_sl_activation_price"] = (
                            (_e + self.config.trailing_sl_activation * _atr) if _long
                            else (_e - self.config.trailing_sl_activation * _atr)
                        ) if self.config.trailing_sl_enabled else None
                    if "trailing_sl_dist" not in self._position:
                        self._position["trailing_sl_dist"] = (
                            self.config.trailing_sl_activation * _atr
                        ) if self.config.trailing_sl_enabled else None

                # 3. Restore pending reversal state
                saved_rev = (cfg_row.data[0].get("params") or {}).get("_reversal_pending")
                if saved_rev and not self._position:
                    self._reversal_pending = saved_rev
                    log.info(
                        "Reversal pending restored: dir=%s entry=%.2f expiry_bar=%d",
                        saved_rev.get("direction", "?"),
                        saved_rev.get("entry_limit", 0.0),
                        saved_rev.get("expiry_bar", 0),
                    )
        except Exception as exc:
            log.warning("Could not restore paper state: %s", exc)

    def _save_paper_position(self):
        """Persist current paper position (or None) to bot_configs.params._paper_position."""
        try:
            db = get_supabase()
            row = db.table("bot_configs").select("params").eq("name", "default").execute()
            existing = (row.data[0].get("params") or {}) if row.data else {}
            existing["_paper_position"] = self._position  # None clears it
            db.table("bot_configs").update({"params": existing}).eq("name", "default").execute()
        except Exception as exc:
            log.warning("Could not save paper position: %s", exc)

    def _persist_position_state(self):
        """
        Persist in-flight position state (trailing SL, partial_done, be_sl_applied, etc.)
        so that bot restarts can fully restore mid-trade state.

        Paper mode: reuses _paper_position (same key, same restore path).
        Live mode:  saves to _live_position_state (restored in _reconcile_position).
        """
        if not self._position:
            return
        try:
            db = get_supabase()
            row = db.table("bot_configs").select("params").eq("name", "default").execute()
            existing = (row.data[0].get("params") or {}) if row.data else {}
            if self.mode == "paper":
                existing["_paper_position"] = self._position
            else:
                existing["_live_position_state"] = {
                    "bars_held":               self._position.get("bars_held", 0),
                    "lgbm_strikes":            self._position.get("lgbm_strikes", 0),
                    "be_sl_applied":           self._position.get("be_sl_applied", False),
                    "sl_trailing_active":      self._position.get("sl_trailing_active", False),
                    "high_water":              self._position.get("high_water"),
                    "partial_done":            self._position.get("partial_done", False),
                    "partial_realized_pnl":    self._position.get("partial_realized_pnl", 0.0),
                    "stop_loss":               self._position.get("stop_loss", 0.0),
                    "take_profit":             self._position.get("take_profit", 0.0),
                    "sl_original":             self._position.get("sl_original"),
                    "size_usd":                self._position.get("size_usd"),
                    "size_contracts":          self._position.get("size_contracts"),
                    "original_size_usd":       self._position.get("original_size_usd"),
                    "entry_atr":               self._position.get("entry_atr"),
                    "inference_id":            self._position.get("inference_id"),
                    "hl_order_id":             self._position.get("hl_order_id"),
                    "opened_at":               self._position.get("opened_at"),
                    "partial_tp_price":        self._position.get("partial_tp_price"),
                    "trailing_sl_activation_price": self._position.get("trailing_sl_activation_price"),
                    "trailing_sl_dist":        self._position.get("trailing_sl_dist"),
                    "trade_id":                self._position.get("trade_id"),
                    "current_sl_cloid":        self._position.get("current_sl_cloid"),
                }
            db.table("bot_configs").update({"params": existing}).eq("name", "default").execute()
        except Exception as exc:
            log.warning("Could not persist position state: %s", exc)

    def _persist_reversal_pending(self, pending: Optional[dict]):
        """
        Salva/cancella _reversal_pending su Supabase.
        Chiamato ogni volta che lo stato cambia (set, triggered, expired, cancelled).
        _persist_position_state() non può essere usato — ha un early-return su not self._position.
        """
        try:
            db = get_supabase()
            row = db.table("bot_configs").select("params").eq("name", "default").execute()
            existing = (row.data[0].get("params") or {}) if row.data else {}
            # ReversalResult non è JSON-serializzabile: salva solo i campi primitivi
            if pending is not None:
                _p = copy.copy(pending)
                _p.pop("reversal_result", None)
                existing["_reversal_pending"] = _p
            else:
                existing.pop("_reversal_pending", None)
            db.table("bot_configs").update({"params": existing}).eq("name", "default").execute()
        except Exception as exc:
            log.warning("Could not persist reversal pending state: %s", exc)

    async def _open_reversal_pending_position(self, pending: dict):
        """
        Apre la posizione reversal con i parametri calcolati al momento del segnale.
        Chiamato quando il prezzo raggiunge entry_limit (paper watchdog o cycle live).
        """
        _rev_cfg = copy.copy(self.config)
        _rev_cfg.sl_atr_mult = self.config.reversal_sl_atr_mult
        _rev_cfg.tp_atr_mult = self.config.reversal_tp_atr_mult

        _rev_result = pending.get("reversal_result")
        _mock_result = DecisionResult(
            action               = pending["direction"],
            confidence           = _rev_result.score if _rev_result else 0.72,
            reasoning            = (["[REVERSAL RETEST TRIGGERED]"] + (_rev_result.reasoning if _rev_result else [])),
            features_snapshot    = {},
            directional_prob     = _rev_result.score if _rev_result else 0.72,
            forecast_p10         = 0.0,
            forecast_p50         = 0.0,
            forecast_p90         = 0.0,
            forecast_uncertainty = 0.0,
            size_factor          = pending["size_factor"],
            _is_reversal         = True,
        )
        # Usa entry_limit come prezzo di esecuzione (il prezzo al retest, non il mark corrente)
        _mock_snap = {"mark_price": pending["entry_limit"]}
        await self._open_position(
            _mock_result,
            snap         = _mock_snap,
            atr          = pending["atr_at_signal"],
            inference_id = None,
            cfg          = _rev_cfg,
            sl_override  = pending["sl"],
            tp_override  = pending["tp"],
        )

    async def get_status(self) -> dict:
        regime_data = None
        if self._regime_signal is not None:
            s = self._regime_signal
            regime_data = {
                "regime":           s.regime,
                "confidence":       s.confidence,
                "adx":              s.adx,
                "atr_percentile":   s.atr_percentile,
                "trend_slope_pct":  s.trend_slope_pct,
                "bb_width_pct":     s.bb_width_pct,
                "bars_in_regime":   s.bars_in_regime,
                "transition_risk":  s.transition_risk,
                "reasoning":        s.reasoning,
            }
        return {
            "running":                  self.running,
            "mode":                     self.mode,
            "hl_testnet":               HL_TESTNET,
            "equity":                   self._equity,
            "position":                 self._position,
            "mark_price":               self._ws.latest_mark,
            "cycle_count":              self._cycle_count,
            "ws_connected":             self._ws.is_connected,
            "model_loaded":             self._lgbm_model is not None,
            "lgbm_1h_loaded":           self._lgbm_1h is not None,
            "retrain_in_progress":      _retrain_lock.locked(),
            "retrain_1h_in_progress":   _retrain_1h_lock.locked(),
            "retrain_due":              self._retrain_due,
            "last_retrain":             self._last_retrain_metrics,
            "last_cycle_signals":       self._last_cycle_signals,
            "macro_pause_active":       self._macro_pause_active,
            "config":                   self.config.model_dump(),
            "regime_signal":            regime_data,
            "last_drift_check":         self._last_drift_result,
            "pending_pullback": (
                {
                    "direction":     self._pending_pullback.direction,
                    "pullback_zone": self._pending_pullback.pullback_zone,
                    "fallback_limit": self._pending_pullback.fallback_limit,
                    "expires_at":    self._pending_pullback.expires_at.isoformat(),
                    "ob_order_id":   self._pending_pullback.ob_order_id,
                    "ob_sl_price":   self._pending_pullback.ob_sl_price,
                    "close_4h":      self._pending_pullback.close_4h,
                    "atr_at_signal": self._pending_pullback.atr_at_signal,
                }
                if self._pending_pullback is not None
                else None
            ),
        }

    # ── Main Loop ─────────────────────────────────────────────────────────────

    async def _loop(self):
        """
        Event-driven loop: waits for WS candle close, then runs a full cycle.
        Falls back to time-based sleep if WS times out (e.g. connection issue).
        """
        while self.running:
            try:
                # Wait for next 4h candle close (WS event-driven)
                ws_data = await self._ws.wait_for_candle_close()

                if ws_data is None:
                    # WS timeout — fall back to time-based alignment
                    await self._sleep_until_next_candle()

                await self._cycle()
                self._consecutive_errors = 0  # reset on successful cycle

            except asyncio.CancelledError:
                break
            except Exception as exc:
                self._consecutive_errors += 1
                log.error(
                    "Cycle error [%d/%d]: %s",
                    self._consecutive_errors, CIRCUIT_BREAKER_THRESHOLD,
                    exc, exc_info=True,
                )
                await self._notifier.send_error(str(exc), "main loop")
                try:
                    db = get_supabase()
                    db.table("events").insert({
                        "severity": "error",
                        "kind": "cycle_error",
                        "message": f"Errore nel ciclo di trading [{self._consecutive_errors}/{CIRCUIT_BREAKER_THRESHOLD}]: {type(exc).__name__}: {exc}",
                        "payload": {
                            "error": str(exc), "type": type(exc).__name__,
                            "consecutive": self._consecutive_errors,
                        },
                    }).execute()
                except Exception:
                    pass

                if self._consecutive_errors >= CIRCUIT_BREAKER_THRESHOLD:
                    log.critical(
                        "Circuit breaker triggered after %d consecutive errors — stopping bot.",
                        self._consecutive_errors,
                    )
                    try:
                        db = get_supabase()
                        db.table("events").insert({
                            "severity": "critical",
                            "kind":     "circuit_breaker",
                            "message":  f"Circuit breaker attivato dopo {self._consecutive_errors} errori consecutivi. Bot fermato automaticamente.",
                            "payload":  {"consecutive_errors": self._consecutive_errors},
                        }).execute()
                    except Exception:
                        pass
                    await self._notifier.send_error(
                        f"🚨 Circuit breaker attivato dopo {self._consecutive_errors} errori consecutivi. "
                        "Bot fermato automaticamente. Controlla i log.",
                        "circuit_breaker"
                    )
                    self.running = False
                    # Persist stopped state so no auto-resume until manually restarted
                    try:
                        db = get_supabase()
                        db.table("bot_configs").update({"running": False}).eq("name", "default").execute()
                    except Exception:
                        pass
                    break

                await asyncio.sleep(60)  # brief pause before retry

    async def _paper_watchdog(self):
        """
        Real-time SL/TP monitor for paper mode. Runs every 5s between candle closes.
        Live mode does not need this — the exchange enforces SL/TP via trigger orders.

        Uses period_low/period_high from the WebSocket (updated on every markPx event
        and every individual trade tick) so brief wicks between polls are not missed.
        Also checks partial_tp_price intracandle — previously only checked on 4H close.
        """
        POLL_S = 5
        log.info("Paper watchdog started (poll every %ds)", POLL_S)
        while self.running:
            await asyncio.sleep(POLL_S)

            # Always consume period extremes so they don't accumulate between polls
            period_low, period_high = self._ws.consume_period_extremes()
            mark = self._ws.latest_mark

            if not self.running:
                continue

            check_high = period_high if period_high else (mark or 0.0)
            check_low  = period_low  if period_low  else (mark or 0.0)

            # ── Pending reversal trigger (paper mode, intracandle) ────────────
            # Runs here, using already-consumed period extremes — no double-consume.
            if self._reversal_pending and not self._position:
                _rp = self._reversal_pending
                if self._cycle_count >= _rp["expiry_bar"]:
                    log.info(
                        "Reversal pending EXPIRED (paper, cycle %d, dir=%s)",
                        self._cycle_count, _rp["direction"],
                    )
                    self._reversal_pending = None
                    self._persist_reversal_pending(None)
                elif check_low > 0 and check_high > 0:
                    _triggered = (
                        (_rp["direction"] == "long"  and check_low  <= _rp["entry_limit"]) or
                        (_rp["direction"] == "short" and check_high >= _rp["entry_limit"])
                    )
                    if _triggered:
                        log.info(
                            "Reversal pending TRIGGERED (paper): dir=%s entry=%.2f sl=%.2f tp=%.2f",
                            _rp["direction"], _rp["entry_limit"], _rp["sl"], _rp["tp"],
                        )
                        self._reversal_pending = None
                        self._persist_reversal_pending(None)
                        asyncio.create_task(self._open_reversal_pending_position(_rp))
                continue  # nessuna posizione — skip SL/TP check

            # ── Pending bounce-fade trigger (paper mode, intracandle) ──────────
            if self._pending_bounce_fade is not None and not self._position:
                _bf_snap = {"mark_price": mark or 0.0}
                await self._check_bounce_fade_entry(
                    mark or 0.0, _bf_snap, None,
                    check_high=check_high, check_low=check_low,
                )
                continue  # nessuna posizione — skip SL/TP check

            if not self._position:
                continue
            if not mark or mark <= 0:
                continue

            sl   = self._position.get("stop_loss",  0.0)
            tp   = self._position.get("take_profit", 0.0)
            side = self._position.get("side")
            if not side:
                continue

            # Use the worst-case price for each direction:
            # SL for shorts is above (use period_high), TP for shorts is below (use period_low).

            # ── Partial TP (intracandle, mirrors live bracket order behavior) ──
            if (self.config.partial_tp_enabled
                    and not self._position.get("partial_done", False)):
                partial_tp_price = self._position.get("partial_tp_price")
                if partial_tp_price and partial_tp_price > 0:
                    hit_partial = (
                        (side == "long"  and check_high >= partial_tp_price) or
                        (side == "short" and check_low  <= partial_tp_price)
                    )
                    if hit_partial:
                        frac             = self.config.partial_tp_pct / 100.0
                        partial_size_usd = self._position["size_usd"] * frac
                        partial_contracts = round(self._position["size_contracts"] * frac, 4)
                        entry            = self._position["entry_price"]
                        pnl_pct_p = ((partial_tp_price - entry) / entry * 100 if side == "long"
                                     else (entry - partial_tp_price) / entry * 100)
                        fee_p     = partial_size_usd * HL_TAKER_FEE
                        pnl_usd_p = partial_size_usd * pnl_pct_p / 100 - fee_p

                        self._equity                         += pnl_usd_p
                        self._position["size_usd"]           *= (1.0 - frac)
                        self._position["size_contracts"]      = round(
                            self._position["size_contracts"] * (1.0 - frac), 4)
                        self._position["partial_done"]        = True
                        self._position["partial_realized_pnl"] = (
                            self._position.get("partial_realized_pnl", 0.0) + pnl_usd_p)
                        if not self._position.get("be_sl_applied", False):
                            if side == "long":
                                self._position["stop_loss"] = max(self._position["stop_loss"], entry)
                            else:
                                self._position["stop_loss"] = min(self._position["stop_loss"], entry)
                            self._position["be_sl_applied"] = True
                            sl = self._position["stop_loss"]  # refresh for SL check below

                        self._save_paper_position()
                        log.info(
                            "[PAPER watchdog] Partial TP %.0f%% @ %.2f | pnl=+%.2f%% ($%.2f)",
                            self.config.partial_tp_pct, partial_tp_price, pnl_pct_p, pnl_usd_p,
                        )
                        asyncio.create_task(self._emit_trade_event("partial_tp", {
                            "price":                partial_tp_price,
                            "pct_closed":           self.config.partial_tp_pct,
                            "pnl_usd":              round(pnl_usd_p, 2),
                            "pnl_pct":              round(pnl_pct_p, 4),
                            "remaining_usd":        self._position["size_usd"],
                            "remaining_contracts":  self._position["size_contracts"],
                            "new_sl":               self._position["stop_loss"],
                        }))
                        asyncio.create_task(self._notifier.send_partial_tp(
                            side=side, symbol=SYMBOL,
                            pct=self.config.partial_tp_pct,
                            price=partial_tp_price,
                            pnl_usd=pnl_usd_p,
                            pnl_pct=pnl_pct_p,
                            remaining_usd=self._position["size_usd"],
                            new_sl=self._position["stop_loss"],
                        ))

            # ── SL / full TP ──────────────────────────────────────────────────
            reason     = None
            exit_price = mark
            if side == "short":
                if sl > 0.0 and check_high >= sl:
                    reason, exit_price = "stop_loss", sl
                elif tp > 0.0 and check_low <= tp:
                    reason, exit_price = "take_profit", tp
            else:  # long
                if sl > 0.0 and check_low <= sl:
                    reason, exit_price = "stop_loss", sl
                elif tp > 0.0 and check_high >= tp:
                    reason, exit_price = "take_profit", tp

            if reason:
                log.info(
                    "Paper watchdog: %s triggered | side=%s exit=%.2f "
                    "sl=%.2f tp=%.2f (period low=%.2f high=%.2f)",
                    reason, side, exit_price, sl, tp,
                    check_low, check_high,
                )
                await self._close_position(exit_price, reason)

    async def _cycle(self):
        """One full inference cycle: fetch → features → C2 → LGBM → decide → execute → log."""
        cycle_start = datetime.now(timezone.utc)
        log.info("Cycle %d starting at %s", self._cycle_count + 1, cycle_start.isoformat())

        # 1. WS snapshot (CVD, liquidations, live OI) — reset accumulators
        ws_snap = self._ws.get_snapshot_and_reset()

        # 2. Fetch OHLCV + market snapshot from REST (ground truth)
        df_4h   = await self._hl.get_ohlcv(SYMBOL, "4h", limit=512)
        # Drop the still-forming candle so the decision bar is the last CLOSED 4H
        # candle. HL's candleSnapshot includes the candle that just opened (only a
        # few seconds of data); its near-zero accumulated volume corrupts every
        # volume-derived feature (volume, vol_ratio, vol_z_50, absorption_z,
        # vol_climax) on the exact bar used for the decision. Using the completed
        # candle also restores parity with the backtest, which only ever evaluates
        # closed candles. Entry/SL/TP prices come from the live mark_price (snap),
        # so dropping the forming candle does not affect execution pricing.
        if len(df_4h) >= 2:
            df_4h = df_4h.iloc[:-1]
        snap    = await self._hl.get_market_snapshot(SYMBOL)
        df_fund = await self._hl.get_funding_history(SYMBOL, hours=200)

        # Prefer live WS OI if available, fall back to REST snapshot
        if ws_snap["ws_latest_oi"] > 0:
            snap["open_interest"] = ws_snap["ws_latest_oi"]

        # ── Live: detect exchange-closed positions ────────────────────────────
        # If the exchange fired a trigger order (SL/TP) between cycles, HL will
        # show no open position while self._position is still set in memory.
        # Without this check the bot would hold a ghost position indefinitely.
        if self.mode == "live" and self._position:
            wallet = os.getenv("HL_WALLET_ADDRESS", "")
            if wallet:
                try:
                    hl_pos = await self._hl.get_open_position(wallet, SYMBOL)
                    if hl_pos is None:
                        # Position is gone on exchange — determine which level fired
                        mark = snap["mark_price"]
                        sl   = self._position.get("stop_loss",  0.0)
                        tp   = self._position.get("take_profit", 0.0)
                        side = self._position["side"]
                        if sl > 0.0 and tp > 0.0:
                            sl_dist = abs(mark - sl)
                            tp_dist = abs(mark - tp)
                            if sl_dist <= tp_dist:
                                reason, exit_px = "stop_loss", sl
                            else:
                                reason, exit_px = "take_profit", tp
                        elif sl > 0.0:
                            reason, exit_px = "stop_loss", sl
                        elif tp > 0.0:
                            reason, exit_px = "take_profit", tp
                        else:
                            reason, exit_px = "exchange_close", mark
                        log.warning(
                            "Live sync: position gone on HL — exchange fired %s "
                            "near %.2f (mark=%.2f). Closing internally.",
                            reason, exit_px, mark,
                        )
                        await self._close_position(exit_px, reason, exchange_already_closed=True)
                        self._cycle_count += 1
                        return   # skip inference for this cycle; nothing to manage

                    elif (hl_pos is not None
                          and not self._position.get("partial_done", False)
                          and self.config.partial_tp_enabled):
                        # Check if partial TP trigger fired between cycles:
                        # HL position size should be ~50% of our expected size.
                        hl_sz       = hl_pos.get("size_contracts", 0.0)
                        expected_sz = self._position.get("size_contracts", 0.0)
                        if expected_sz > 0 and hl_sz < expected_sz * 0.75:
                            # Partial TP fired on exchange — sync internal state
                            frac             = 1.0 - (hl_sz / expected_sz)
                            partial_size_usd = self._position["size_usd"] * frac
                            entry            = self._position["entry_price"]
                            side             = self._position["side"]
                            ptp_price        = self._position.get("partial_tp_price") or snap["mark_price"]
                            pnl_pct_p = ((ptp_price - entry) / entry * 100 if side == "long"
                                         else (entry - ptp_price) / entry * 100)
                            fee_p     = partial_size_usd * HL_TAKER_FEE
                            pnl_usd_p = partial_size_usd * pnl_pct_p / 100 - fee_p

                            self._equity                           += pnl_usd_p
                            self._position["size_usd"]             *= (hl_sz / expected_sz)
                            self._position["size_contracts"]        = hl_sz
                            self._position["partial_done"]          = True
                            self._position["partial_realized_pnl"]  = (
                                self._position.get("partial_realized_pnl", 0.0) + pnl_usd_p)
                            if not self._position.get("be_sl_applied", False):
                                if side == "long":
                                    self._position["stop_loss"] = max(self._position["stop_loss"], entry)
                                else:
                                    self._position["stop_loss"] = min(self._position["stop_loss"], entry)
                                self._position["be_sl_applied"] = True
                                # Move the exchange SL trigger to break-even
                                _old_sl_cloid = self._position.get("current_sl_cloid")
                                # Clear optimistically — task will store the new cloid via callback
                                async def _do_be_sl_update(_oc=_old_sl_cloid, _sd=side, _sz=hl_sz, _sl=self._position["stop_loss"]):
                                    new_cloid = await self._update_sl_trigger(
                                        None, _sd, _sz, _sl, old_cloid=_oc,
                                    )
                                    if new_cloid and self._position:
                                        self._position["current_sl_cloid"] = new_cloid
                                        self._persist_position_state()
                                asyncio.create_task(_do_be_sl_update())

                            log.info(
                                "Live sync: partial TP detected (HL=%.4f < expected=%.4f) | pnl=$%.2f",
                                hl_sz, expected_sz, pnl_usd_p,
                            )
                            asyncio.create_task(self._emit_trade_event("partial_tp", {
                                "price":               ptp_price,
                                "pct_closed":          round(frac * 100, 1),
                                "pnl_usd":             round(pnl_usd_p, 2),
                                "pnl_pct":             round(pnl_pct_p, 4),
                                "remaining_usd":       self._position["size_usd"],
                                "remaining_contracts": self._position["size_contracts"],
                                "new_sl":              self._position["stop_loss"],
                            }))
                            asyncio.create_task(self._notifier.send_partial_tp(
                                side=side, symbol=SYMBOL,
                                pct=round(frac * 100, 1),
                                price=ptp_price,
                                pnl_usd=pnl_usd_p,
                                pnl_pct=pnl_pct_p,
                                remaining_usd=self._position["size_usd"],
                                new_sl=self._position["stop_loss"],
                            ))
                except Exception as _exc:
                    log.warning("Live position sync check failed: %s", _exc)

        # Build liquidation df from WS accumulators (approximate)
        df_liq = _make_liq_df(ws_snap)

        # Fetch real OI history for Chronos-2 covariate (non-blocking: empty df on failure)
        try:
            from services.external_data import get_best_oi
            from datetime import date, timedelta
            _today  = date.today().isoformat()
            _from_d = (date.today() - timedelta(days=90)).isoformat()
            df_oi = await get_best_oi(SYMBOL, start_date=_from_d, end_date=_today)
        except Exception:
            df_oi = pd.DataFrame()

        # Long/Short ratio (Coinalyze, ultimo aggiornamento ogni 4H) — feed Long/Short Ratio Gate
        df_ls = pd.DataFrame()
        try:
            from services.external_data import get_coinalyze_ls
            from datetime import date, timedelta
            _ls_today = date.today().isoformat()
            _ls_from  = (date.today() - timedelta(days=7)).isoformat()
            df_ls = await get_coinalyze_ls(SYMBOL, start_date=_ls_from, end_date=_ls_today)
        except Exception as _ls_exc:
            log.warning("L/S ratio fetch failed: %s — using defaults", _ls_exc)
            df_ls = pd.DataFrame()

        # Binance cross-exchange CVD data (non-blocking: skip on failure)
        df_binance = None
        if self.config.binance_cvd_enabled:
            try:
                from services.binance_data import get_ohlcv_binance
                df_binance = await get_ohlcv_binance("BTC", "4h", limit=200)
            except Exception as _bnc_err:
                log.warning("Binance CVD fetch failed (non-blocking): %s", _bnc_err)

        # Options IV data — fetch from Deribit when options_bias_enabled OR reversal_mode_enabled.
        # Returns last cached value on failure so the cycle is never blocked.
        _iv_7d_value = None
        _need_iv = self.config.options_bias_enabled or getattr(self.config, "reversal_mode_enabled", False)
        if _need_iv:
            try:
                from services.deribit_data import get_deribit_atm_iv
                _iv_7d_value = await get_deribit_atm_iv("BTC")
            except Exception as _iv_err:
                log.warning("Deribit IV fetch failed (non-blocking): %s", _iv_err)

        # 3. Build full feature matrix
        df_feat = build_all_features(
            df_4h, df_fund, df_oi, df_liq,
            df_ls=df_ls,
            df_binance=df_binance,
            binance_cvd_enabled=self.config.binance_cvd_enabled,
            options_bias_enabled=self.config.options_bias_enabled,
            reversal_mode_enabled=getattr(self.config, "reversal_mode_enabled", False),
            iv_7d_value=_iv_7d_value,
        )
        latest  = df_feat.iloc[-1].to_dict()
        atr     = latest.get("atr_14")

        # Inject live WS CVD into features (overrides Haas approximation with real data)
        latest["cvd_delta"] = ws_snap["ws_cvd_delta"]

        # 4. Chronos-2 inference (skip if disabled — use neutral prior)
        cur_px = float(df_4h["close"].iloc[-1])
        if self.config.chronos_enabled:
            c2_out = self._chronos.forecast(
                df_feat["close"].values,
                horizon=3,
                atr=atr,
                volume_series=   (df_feat["vol_ratio"].values
                                  if "vol_ratio"  in df_feat.columns else
                                  df_feat["volume"].values
                                  if "volume"     in df_feat.columns else None),
                oi_series=       df_feat["oi_raw"].values    if "oi_raw"    in df_feat.columns else None,
                funding_series=  df_feat["funding"].values   if "funding"   in df_feat.columns else None,
                cvd_series=      df_feat["delta_raw"].values if "delta_raw" in df_feat.columns else None,
                liq_series=      df_feat["liq_ratio"].values if "liq_ratio" in df_feat.columns else None,
                premium_series=  (df_feat["premium_z"].values
                                  if self.config.chronos_premium_covariate
                                  and "premium_z" in df_feat.columns else None),
                timestamps=      df_feat.index,
                interval_hours=  4,
                calendar_covariates= self.config.chronos_calendar_covariates,
                use_calibration= self.config.use_chronos_calibration,
            )
        else:
            mark = snap["mark_price"]
            c2_out = {
                "c2_dir_prob":    0.5,
                "c2_p10":         mark,
                "c2_p50":         mark,
                "c2_p90":         mark,
                "c2_uncertainty": 0.0,
                "c2_vol_prob":    0.0,
                "c2_cont_prob":   1.0,
                "c2_p50_vs_atr":  0.0,
            }

        # 5. LightGBM probability (non-C2 features)
        lgbm_prob = self._get_lgbm_prob(df_feat)

        # 6. External covariates (F&G, BTC dominance)
        await update_covariates()
        covars = get_latest_covariates()

        # 6b. Regime detection — every 4 cycles (~16h on 4H bars)
        if self._cycle_count % 4 == 0:
            try:
                sig = self._regime_detector.detect(df_feat)
                self._regime_signal = sig
                asyncio.create_task(self._log_regime(sig))
            except Exception as _re:
                log.warning("Regime detection failed: %s", _re)

        # Inject cached RegimeDetector signal into feature dict for enhanced Auto mode.
        # Always injected when available — decision.py only uses them when
        # regime_bias_enhanced=True, so this is harmless in the default case.
        if self._regime_signal is not None:
            latest["regime_state"]      = self._regime_signal.regime
            latest["regime_confidence"] = self._regime_signal.confidence
            latest["transition_risk"]   = self._regime_signal.transition_risk
            latest["bars_in_regime"]    = float(self._regime_signal.bars_in_regime)

        # ── Reversal Zone Detection ───────────────────────────────────────────
        # Always runs when reversal_mode_enabled — regardless of open position.
        # This keeps _last_reversal_result fresh for the /reversal/current endpoint
        # and the ReversalPanel UI. Trade opening is gated separately (not self._position
        # check stays in the signal routing block below).
        _reversal_result = None
        if getattr(self.config, "reversal_mode_enabled", False):
            try:
                from services.reversal_detector import ReversalZoneDetector
                _reversal_result = ReversalZoneDetector().score(
                    df_feat, self._regime_signal, self.config
                )
                latest["reversal_score"]     = _reversal_result.score
                latest["reversal_dir_long"]  = 1.0 if _reversal_result.direction == "long"  else 0.0
                latest["reversal_dir_short"] = 1.0 if _reversal_result.direction == "short" else 0.0
                self._last_reversal_result   = _reversal_result  # per endpoint /reversal/current
                log.debug(
                    "Reversal score=%.3f dir=%s components=%d position=%s",
                    _reversal_result.score, _reversal_result.direction,
                    _reversal_result.component_count,
                    "OPEN" if self._position else "none",
                )
            except Exception as _rev_exc:
                log.warning("Reversal detector failed (non-blocking): %s", _rev_exc)

        cfg = self.config

        # Dual ATR: ATR_21 for SL when enabled (smoother, less affected by single-candle spikes).
        # atr_sl = None when disabled → calculate_trade_params falls back to atr_14 for both SL and TP.
        _atr_21_raw = latest.get("atr_21")
        try:
            _atr_21_val = float(_atr_21_raw) if _atr_21_raw is not None else None
        except (TypeError, ValueError):
            _atr_21_val = None
        atr_sl = (
            _atr_21_val
            if (cfg.dual_atr_enabled and _atr_21_val is not None and _atr_21_val > 0)
            else None
        )

        # Confluence score: computed from bar features (same formula as backtest)
        # so confluence_gate has identical effect live vs. simulated.
        confluence = (compute_qt_score(latest)
                      if cfg.confluence_gate > 0 else None)

        # Funding Rate: rolling mean of last N bars for FundingBias in DecisionEngine.
        _fund_lb  = getattr(cfg, "funding_gate_lookback", 6)
        _fund_col = df_feat["funding"].values if "funding" in df_feat.columns else None
        avg_funding = (
            float(np.nanmean(_fund_col[-_fund_lb:])) if _fund_col is not None and len(_fund_col) >= _fund_lb
            else 0.0
        )

        # 7. Decision gate
        allowed, block_reason = self._risk.can_trade()
        decision_engine = DecisionEngine(
            directional_threshold       = cfg.directional_threshold,
            adx_gate                    = cfg.adx_gate,
            confluence_gate             = cfg.confluence_gate,
            adx_gate_enabled            = cfg.adx_gate_enabled,
            sweep_gate_enabled          = cfg.sweep_gate_enabled,
            sweep_gate_directional      = cfg.sweep_gate_directional,
            fvg_filter_enabled          = cfg.fvg_filter_enabled,
            mtf_alignment_enabled       = cfg.mtf_alignment_enabled,
            chronos_weight              = cfg.chronos_weight if self.config.chronos_enabled else 0.0,
            c2_uncertainty_gate_enabled = cfg.c2_uncertainty_gate_enabled if self.config.chronos_enabled else False,
            c2_uncertainty_threshold    = cfg.c2_uncertainty_threshold,
            c2_cont_prob_gate_enabled   = cfg.c2_cont_prob_gate_enabled if self.config.chronos_enabled else False,
            c2_cont_prob_threshold      = cfg.c2_cont_prob_threshold,
            regime_bias_enabled         = cfg.regime_bias_enabled,
            regime_bias_delta           = cfg.regime_bias_delta,
            regime_bias_size_factor     = cfg.regime_bias_size_factor,
            forced_regime               = cfg.forced_regime,
            regime_bias_enhanced        = cfg.regime_bias_enhanced,
            absorption_filter_enabled   = cfg.absorption_filter_enabled,
            absorption_z_threshold      = cfg.absorption_z_threshold,
            exhaustion_guard_enabled    = cfg.exhaustion_guard_enabled,
            late_entry_filter_enabled   = cfg.late_entry_filter_enabled,
            late_entry_max_ob_dist      = cfg.late_entry_max_ob_dist,
            path_obstruction_enabled    = cfg.path_obstruction_enabled,
            path_obstruction_max_dist   = cfg.path_obstruction_max_dist,
            consec_bars_filter_enabled  = cfg.consec_bars_filter_enabled,
            consec_bars_max_long        = cfg.consec_bars_max_long,
            consec_bars_max_short       = cfg.consec_bars_max_short,
            funding_gate_enabled        = getattr(cfg, "funding_gate_enabled",  False),
            funding_gate_lookback       = getattr(cfg, "funding_gate_lookback", 6),
            funding_high_thr            = getattr(cfg, "funding_high_thr",      0.00010),
            funding_extreme_thr         = getattr(cfg, "funding_extreme_thr",   0.00030),
            funding_bias_delta          = getattr(cfg, "funding_bias_delta",    0.03),
            fng_gate_enabled            = getattr(cfg, "fng_gate_enabled",      False),
            fng_extreme_fear_thr        = getattr(cfg, "fng_extreme_fear_thr",  20.0),
            fng_fear_thr                = getattr(cfg, "fng_fear_thr",          35.0),
            fng_greed_thr               = getattr(cfg, "fng_greed_thr",         65.0),
            fng_extreme_greed_thr       = getattr(cfg, "fng_extreme_greed_thr", 80.0),
            fng_bias_delta              = getattr(cfg, "fng_bias_delta",        0.03),
            # Options IV Bias
            options_bias_enabled        = getattr(cfg, "options_bias_enabled",  False),
            iv_high_percentile          = getattr(cfg, "iv_high_percentile",    80.0),
            iv_low_percentile           = getattr(cfg, "iv_low_percentile",     20.0),
            iv_size_factor              = getattr(cfg, "iv_size_factor",        0.7),
            # Exhaustion Guard thresholds
            exhaustion_rsi_low          = getattr(cfg, "exhaustion_rsi_low",    28.0),
            exhaustion_rsi_high         = getattr(cfg, "exhaustion_rsi_high",   72.0),
            exhaustion_ret48_pct        = getattr(cfg, "exhaustion_ret48_pct",   6.0),
            exhaustion_boost            = getattr(cfg, "exhaustion_boost",       0.06),
            atr_pct_gate_enabled        = getattr(cfg, "atr_pct_gate_enabled",  False),
            atr_pct_min                 = getattr(cfg, "atr_pct_min",           0.008),
            atr_pct_mode                = getattr(cfg, "atr_pct_mode",          "scale"),
            # Squeeze Protection Gates
            oi_spike_gate_enabled       = getattr(cfg, "oi_spike_gate_enabled", False),
            oi_spike_thr                = getattr(cfg, "oi_spike_thr",          2.0),
            oi_spike_mode               = getattr(cfg, "oi_spike_mode",         "scale"),
            oi_spike_lookback           = getattr(cfg, "oi_spike_lookback",     2),
            ls_gate_enabled             = getattr(cfg, "ls_gate_enabled",       False),
            ls_long_block_pct           = getattr(cfg, "ls_long_block_pct",     67.0),
            ls_short_block_pct          = getattr(cfg, "ls_short_block_pct",    33.0),
            ls_gate_mode                = getattr(cfg, "ls_gate_mode",          "scale"),
            ls_gate_scale_factor        = getattr(cfg, "ls_gate_scale_factor",  0.50),
            ls_lookback_bars            = getattr(cfg, "ls_lookback_bars",      1),
            liq_spike_gate_enabled      = getattr(cfg, "liq_spike_gate_enabled", False),
            liq_spike_thr               = getattr(cfg, "liq_spike_thr",          2.5),
            liq_spike_lookback          = getattr(cfg, "liq_spike_lookback",     2),
            liq_spike_mode              = getattr(cfg, "liq_spike_mode",         "block"),
            liq_spike_scale_factor      = getattr(cfg, "liq_spike_scale_factor", 0.40),
            weekend_gate_block_saturday = getattr(cfg, "weekend_gate_block_saturday", False),
            weekend_gate_block_sunday   = getattr(cfg, "weekend_gate_block_sunday",   False),
            # Feature A: proportional boost
            exhaustion_prop_enabled     = getattr(cfg, "exhaustion_prop_enabled", False),
            exhaustion_prop_scale       = getattr(cfg, "exhaustion_prop_scale",   0.06),
            # Feature B: Daily RSI Gate
            daily_rsi_gate_enabled      = getattr(cfg, "daily_rsi_gate_enabled",  False),
            daily_rsi_short_block       = getattr(cfg, "daily_rsi_short_block",   18.0),
            daily_rsi_long_block        = getattr(cfg, "daily_rsi_long_block",    82.0),
            # Feature C: Volume Climax Gate
            vol_climax_gate_enabled     = getattr(cfg, "vol_climax_gate_enabled", False),
            vol_climax_gate_z           = getattr(cfg, "vol_climax_gate_z",       2.5),
            vol_climax_gate_rsi         = getattr(cfg, "vol_climax_gate_rsi",     30.0),
            # Feature D: C2 Inversion Gate
            c2_inversion_gate_enabled   = getattr(cfg, "c2_inversion_gate_enabled", False),
            c2_inversion_pct            = getattr(cfg, "c2_inversion_pct",          0.005),
            # Feature E: Exhaustion Max Hold (DecisionResult flag only — consumed by open_position)
            exhaustion_max_hold_enabled = getattr(cfg, "exhaustion_max_hold_enabled", False),
            exhaustion_max_hold_bars    = getattr(cfg, "exhaustion_max_hold_bars",    2),
        )
        result = decision_engine.decide(
            features=latest,
            c2_output=c2_out,
            lgbm_prob=lgbm_prob,
            confluence_score=confluence,
            current_price=snap["mark_price"],
            avg_funding=avg_funding,
            covariates=covars,
            bar_time=df_feat.index[-1],
        )

        # ── 7b. Gate LightGBM 1H ─────────────────────────────────────────────
        # Applied BEFORE inference logging so the log reflects the final decision.
        # Fail-safe: any exception skips the gate and lets the trade proceed normally.
        if (
            cfg.use_1h_lgbm_gate
            and self._lgbm_1h is not None
            and result.action in ("long", "short")
        ):
            try:
                df_1h_raw  = await self._hl.get_ohlcv(SYMBOL, "1h", limit=720)
                # Drop the forming 1H candle for the same reason as the 4H cycle:
                # the just-opened candle has near-zero volume and corrupts the
                # volume-derived features on the bar the 1H gate evaluates.
                if len(df_1h_raw) >= 2:
                    df_1h_raw = df_1h_raw.iloc[:-1]
                df_1h_fund = await self._hl.get_funding_history(SYMBOL, hours=720)
                df_1h_feat = build_all_features(
                    df_1h_raw, df_1h_fund, pd.DataFrame(), pd.DataFrame()
                )
                # Add 4H context features used by the enhanced 1H gate model.
                # Must be applied before slicing so the resampler has enough bars.
                df_1h_feat = build_4h_context_for_1h(df_1h_feat).iloc[64:]

                lgbm_1h_prob   = self._get_lgbm_1h_prob(df_1h_feat)
                min_agr         = cfg.lgbm_1h_min_agreement
                block_thr       = cfg.lgbm_1h_block_threshold
                # P(trade direction is correct) on 1H timeframe
                gate_side_prob  = lgbm_1h_prob if result.action == "long" else (1.0 - lgbm_1h_prob)
                original_action = result.action

                if gate_side_prob < block_thr:
                    result.action = "no_trade"
                    result.reasoning.append(
                        f"1H gate BLOCK: P({original_action})_1h={gate_side_prob:.3f} < {block_thr}"
                    )
                elif gate_side_prob < min_agr:
                    result.size_factor *= 0.70
                    result.reasoning.append(
                        f"1H gate REDUCE ×0.70: P({original_action})_1h={gate_side_prob:.3f} < {min_agr}"
                    )

                log.info(
                    "1H gate [%s]: p1h=%.3f p_dir=%.3f → action=%s size_factor=%.2f",
                    original_action, lgbm_1h_prob, gate_side_prob,
                    result.action, result.size_factor,
                )
            except Exception as _exc:
                log.warning("1H gate skipped (error): %s", _exc)

        # 8. Execute
        _raw_id = str(uuid.uuid4())[:12]
        inference_id = await self._log_inference(_raw_id, latest, c2_out, lgbm_prob, result, covars)
        # inference_id is None if log write failed; orders insert will use NULL FK (safe)

        # ── Macro Event Pause ─────────────────────────────────────────────────
        # Override result.action → no_trade if we're inside a pause window.
        # Position management (SL/TP/trailing) continues normally during pause.
        _macro_event = self._calendar.is_in_pause_window(datetime.now(timezone.utc), cfg)
        if _macro_event:
            _pre_macro_action = result.action   # capture signal before override
            result.action = "no_trade"
            result.reasoning.append(f"Macro pause: {_macro_event}")
            if self._macro_pause_active is None:
                # Entered pause — notify once
                self._macro_pause_active = _macro_event
                asyncio.create_task(self._notifier.send_macro_pause_start(
                    _macro_event, cfg.macro_pause_window_min
                ))
            # Notify specifically if a real trading signal is being suppressed
            if _pre_macro_action in ("long", "short") and self._position is None and allowed:
                log.info(
                    "Macro pause suppressed %s signal (event=%s mark=%.2f ens=%.1f%%)",
                    _pre_macro_action.upper(), _macro_event,
                    snap["mark_price"], result.confidence * 100,
                )
                try:
                    db = get_supabase()
                    db.table("events").insert({
                        "severity": "warning",
                        "kind":     "macro_trade_blocked",
                        "message":  (
                            f"⏸ Segnale {_pre_macro_action.upper()} bloccato da pausa macro "
                            f"({_macro_event}) @ ${snap['mark_price']:,.2f}"
                        ),
                        "payload": {
                            "event_name":   _macro_event,
                            "signal":       _pre_macro_action,
                            "mark_price":   snap["mark_price"],
                            "ensemble_pct": round(result.confidence * 100, 1),
                            "dir_prob":     round(result.directional_prob, 4),
                        },
                    }).execute()
                except Exception as _exc:
                    log.warning("macro_trade_blocked event insert failed: %s", _exc)
                asyncio.create_task(self._notifier.send_macro_trade_blocked(
                    event_name=_macro_event,
                    signal_side=_pre_macro_action,
                    ensemble_pct=result.confidence * 100,
                    dir_prob=result.directional_prob,
                    mark_price=snap["mark_price"],
                ))
            if cfg.macro_pause_close_position and self._position:
                log.info("Macro pause: closing open position as configured")
                await self._close_position(snap["mark_price"], "macro_pause")
        elif self._macro_pause_active is not None:
            # Exited pause — notify once
            asyncio.create_task(self._notifier.send_macro_pause_end(self._macro_pause_active))
            self._macro_pause_active = None

        # ── Reversal: cancella pending se una posizione trend è appena aperta ──
        if self._position and self._reversal_pending:
            log.info("Reversal pending CANCELLED: trend position opened")
            self._reversal_pending = None
            self._persist_reversal_pending(None)

        # ── Reversal: cancella pending su macro pause ─────────────────────────
        # Nota: self._macro_pause_active è già settato dentro il blocco macro sopra,
        # quindi la condizione viene semplicemente: se c'è un macro event e un pending.
        if _macro_event and self._reversal_pending:
            log.info("Reversal pending CANCELLED: macro pause (%s)", _macro_event)
            self._reversal_pending = None
            self._persist_reversal_pending(None)

        # ── Reversal: check pending trigger in live mode (al ciclo 4H) ────────
        if self._reversal_pending and not self._position and self.mode == "live":
            _rp = self._reversal_pending
            if self._cycle_count >= _rp["expiry_bar"]:
                log.info("Reversal pending EXPIRED (live, cycle %d)", self._cycle_count)
                self._reversal_pending = None
                self._persist_reversal_pending(None)
            else:
                _mark = self._ws.latest_mark
                if _mark:
                    _triggered = (
                        (_rp["direction"] == "long"  and _mark <= _rp["entry_limit"]) or
                        (_rp["direction"] == "short" and _mark >= _rp["entry_limit"])
                    )
                    if _triggered:
                        log.info(
                            "Reversal pending TRIGGERED (live): dir=%s entry=%.2f",
                            _rp["direction"], _rp["entry_limit"],
                        )
                        self._reversal_pending = None
                        self._persist_reversal_pending(None)
                        await self._open_reversal_pending_position(_rp)

        # ── Signal routing: trend vs reversal ─────────────────────────────────
        _final_result = result  # default: usa il segnale trend-following
        if (
            _reversal_result is not None
            and _reversal_result.direction is not None
            and _reversal_result.score >= self.config.reversal_score_threshold
            and _reversal_result.component_count >= self.config.reversal_min_components
            and not self._position
        ):
            _trend_action = result.action

            _guard_only = getattr(self.config, "reversal_guard_only", False)

            # Caso 1: trend = no_trade/hold → reversal prende il controllo (skipped in guard_only)
            if _trend_action == "no_trade" and not _guard_only:
                _final_result = DecisionResult(
                    action               = _reversal_result.direction,
                    confidence           = _reversal_result.score,
                    reasoning            = ["[REVERSAL] " + r for r in _reversal_result.reasoning],
                    features_snapshot    = result.features_snapshot,
                    directional_prob     = _reversal_result.score,
                    forecast_p10         = result.forecast_p10,
                    forecast_p50         = result.forecast_p50,
                    forecast_p90         = result.forecast_p90,
                    forecast_uncertainty = 0.0,
                    size_factor          = self.config.reversal_size_factor,
                    _is_reversal         = True,
                )
                log.info(
                    "Reversal signal active: %s (score=%.3f components=%d)",
                    _reversal_result.direction.upper(),
                    _reversal_result.score, _reversal_result.component_count,
                )

            # Caso 2: trend e reversal concordano → boost confidence (skipped in guard_only)
            elif (
                _trend_action == _reversal_result.direction
                and not getattr(self.config, "reversal_trend_hold_only", True)
                and not _guard_only
            ):
                _boost = min(1.0, result.confidence + 0.05)
                _final_result = copy.copy(result)
                _final_result.confidence = _boost
                _final_result.reasoning  = list(result.reasoning) + [
                    f"[REVERSAL BOOST] score={_reversal_result.score:.2f}"
                ]

            # Caso 3: trend e reversal in conflitto → blocca se configurato (sempre attivo)
            elif (
                _trend_action != _reversal_result.direction
                and _trend_action != "no_trade"
                and getattr(self.config, "reversal_conflict_block", True)
            ):
                _final_result = copy.copy(result)
                _final_result.action   = "no_trade"
                _final_result.reasoning = list(result.reasoning) + [
                    f"[REVERSAL CONFLICT BLOCK] trend={_trend_action} vs reversal={_reversal_result.direction}"
                ]
                log.info(
                    "Reversal conflict block: trend=%s reversal=%s",
                    _trend_action, _reversal_result.direction,
                )

        # Usa _final_result al posto di result per tutto ciò che segue
        result = _final_result

        # ── Pullback entry: check pending signal every cycle ─────────────────────
        # Called before the new-position block so that a pullback fill sets
        # self._position = ... and the block below correctly skips opening a second trade.
        if self._pending_pullback is not None:
            _pb_price = self._ws.latest_mark or snap["mark_price"]
            await self._check_pullback_entry(_pb_price, snap, atr)

        if self._pending_bounce_fade is not None:
            _bf_price = self._ws.latest_mark or snap["mark_price"]
            await self._check_bounce_fade_entry(_bf_price, snap, atr)

        if result.action != "no_trade" and allowed and self._position is None:
            # ── Reversal entry: limit-retest mode sets pending instead of opening immediately ──
            if getattr(result, "_is_reversal", False):
                _rev_cfg = copy.copy(self.config)
                if getattr(self.config, "reversal_entry_mode", "limit_retest") == "limit_retest":
                    from services.reversal_detector import build_pending_reversal
                    _atr_v = atr or snap["mark_price"] * 0.01
                    _pending = build_pending_reversal(
                        direction        = result.action,
                        candle           = latest,
                        reversal_result  = _reversal_result,
                        cfg              = self.config,
                        atr              = _atr_v,
                        bar_idx          = self._cycle_count,
                    )
                    if _pending:
                        self._reversal_pending = _pending
                        self._persist_reversal_pending(_pending)
                        log.info(
                            "Reversal PENDING set: dir=%s entry=%.2f sl=%.2f tp=%.2f expiry_bar=%d",
                            _pending["direction"], _pending["entry_limit"],
                            _pending["sl"], _pending["tp"], _pending["expiry_bar"],
                        )
                    else:
                        log.info("Reversal signal skipped: R:R gate failed (entry_mode=limit_retest)")
                else:
                    # "close" mode: apri subito a mercato con parametri reversal
                    _rev_cfg.sl_atr_mult = self.config.reversal_sl_atr_mult
                    _rev_cfg.tp_atr_mult = self.config.reversal_tp_atr_mult
                    await self._open_position(result, snap, atr, inference_id, cfg=_rev_cfg)

            else:
                # ── Trend entry ───────────────────────────────────────────────────
                # Bounce-Fade: counter-trend signal → resistance-anchored limit entry.
                # Checked BEFORE pullback; if it creates a pending, everything else is
                # skipped (the two cannot coexist on the same signal).
                _bf_created = False
                if (
                    getattr(self.config, "bounce_fade_enabled", False)
                    and self._pending_bounce_fade is None
                    and self._pending_pullback is None
                ):
                    _ret6     = self._safe_float(latest.get("ret_6") or 0.0)
                    _ct_only  = getattr(self.config, "bounce_fade_counter_trend_only", True)
                    _counter  = (result.action == "short" and _ret6 > 0) or \
                                (result.action == "long"  and _ret6 < 0)
                    if _counter or not _ct_only:
                        _bf = await self._create_pending_bounce_fade(
                            result, latest, atr, snap, inference_id, atr_sl
                        )
                        if _bf is not None:
                            self._pending_bounce_fade = _bf
                            _bf_created = True
                            result.reasoning.append(
                                f"BounceFade: limite {_bf.entry_limit:.0f} "
                                f"(resistenza {_bf.resistance:.0f}, TP {_bf.orig_tp:.0f}, "
                                f"scade {_bf.expires_at.strftime('%H:%M UTC')})"
                            )
                            log.info(
                                "BounceFade activated: %s limit=%.2f resistance=%.2f "
                                "orig_tp=%.2f size=$%.0f expires=%s",
                                result.action, _bf.entry_limit, _bf.resistance,
                                _bf.orig_tp, _bf.orig_size_usd,
                                _bf.expires_at.strftime("%H:%M UTC"),
                            )

                if _bf_created:
                    pass  # pending created — fill/expiry handled by watchdog + cycle
                else:
                    # ── Pullback entry (comportamento originale) ───────────────────
                    _pb_enabled = getattr(self.config, "pullback_entry_enabled", False)
                    if _pb_enabled and self._pending_pullback is not None:
                        log.info("Pullback wait active (%s) — new %s signal queued but skipped",
                                 self._pending_pullback.direction, result.action)
                    elif _pb_enabled:
                        _close_px = float(latest.get("close") or snap["mark_price"])
                        _open_px  = float(latest.get("open")  or _close_px)
                        _atr_v    = atr or snap["mark_price"] * 0.01
                        _impulse  = abs(_close_px - _open_px) / _atr_v if _atr_v > 0 else 0.0
                        if _impulse >= getattr(self.config, "pullback_impulse_atr_mult", 1.5):
                            self._pending_pullback = await self._create_pending_pullback(
                                result, latest, _atr_v, snap
                            )
                            log.info(
                                "Pullback mode activated: %s body_ratio=%.2f ≥ %.2f "
                                "(body=%.0f open=%.0f close=%.0f) | "
                                "zone=%.2f fallback=%.2f expires=%s",
                                result.action, _impulse,
                                getattr(self.config, "pullback_impulse_atr_mult", 1.5),
                                abs(_close_px - _open_px), _open_px, _close_px,
                                self._pending_pullback.pullback_zone,
                                self._pending_pullback.fallback_limit,
                                self._pending_pullback.expires_at.strftime("%H:%M UTC"),
                            )
                        else:
                            await self._open_position(result, snap, atr, inference_id, atr_sl=atr_sl)
                    else:
                        await self._open_position(result, snap, atr, inference_id, atr_sl=atr_sl)
        elif not allowed:
            log.info("Trade blocked: %s", block_reason)
        elif result.action != "no_trade" and self._position is not None:
            open_side    = self._position["side"]
            signal_side  = result.action
            ensemble_pct = round(result.confidence * 100, 1)
            is_opposite  = (signal_side != open_side)

            # Hypothetical SL/TP the blocked trade would have used (ATR-based, same as _open_position)
            _atr_bl  = atr or snap["mark_price"] * 0.01
            _px_bl   = snap["mark_price"]
            _sl_dist = cfg.sl_atr_mult * _atr_bl
            _tp_dist = cfg.tp_atr_mult * _atr_bl
            if signal_side == "long":
                hyp_sl = _px_bl - _sl_dist
                hyp_tp = _px_bl + _tp_dist
            else:
                hyp_sl = _px_bl + _sl_dist
                hyp_tp = _px_bl - _tp_dist
            hyp_rr = round(_tp_dist / _sl_dist, 2)

            kind  = "signal_blocked_opposite" if is_opposite else "signal_blocked_same"
            label = "SEGNALE CONTRARIO IGNORATO" if is_opposite else "Segnale uguale ignorato"
            log.info(
                "[%s] %s — %s mentre posizione %s aperta | ensemble=%.1f%% | %s",
                self.mode.upper(), label, signal_side.upper(), open_side.upper(),
                ensemble_pct, result.reasoning[-1] if result.reasoning else "—",
            )
            try:
                db = get_supabase()
                db.table("events").insert({
                    "severity": "warning" if is_opposite else "info",
                    "kind":     kind,
                    "message":  (
                        f"{'⚠️' if is_opposite else 'ℹ️'} {label}: {signal_side.upper()} "
                        f"@ {ensemble_pct}% (posizione {open_side.upper()} aperta)"
                    ),
                    "payload": {
                        "signal":       signal_side,
                        "open_side":    open_side,
                        "ensemble_pct": ensemble_pct,
                        "dir_prob":     round(result.directional_prob * 100, 1),
                        "mark_price":   _px_bl,
                        "hyp_sl":       round(hyp_sl, 2),
                        "hyp_tp":       round(hyp_tp, 2),
                        "hyp_rr":       hyp_rr,
                        "is_opposite":  is_opposite,
                        "reasoning":    result.reasoning,
                        "inference_id": inference_id,
                    },
                }).execute()
            except Exception as exc:
                log.warning("signal_blocked event insert failed: %s", exc)

            if is_opposite:
                asyncio.create_task(self._notifier.send_signal_blocked_opposite(
                    signal_side=signal_side,
                    open_side=open_side,
                    ensemble_pct=ensemble_pct,
                    reasoning=result.reasoning,
                    mark_price=_px_bl,
                    dir_prob=result.directional_prob,
                    hyp_sl=hyp_sl,
                    hyp_tp=hyp_tp,
                    hyp_rr=hyp_rr,
                ))

        # 9. Manage existing position (SL/TP + optional LightGBM mid-trade exit).
        # Use the freshest available mark price: the WS value is updated continuously
        # and may differ significantly from snap["mark_price"] if Chronos inference was slow.
        if self._position:
            fresh_mark = self._ws.latest_mark or snap["mark_price"]
            await self._manage_position(fresh_mark, df_feat, c2_out)

        # 10. Heartbeat
        await self._risk.write_heartbeat()

        # 11. Auto-retrain (background — never blocks the loop)
        self._cycle_count += 1
        if self._cycle_count % self.config.retrain_every_n_cycles == 0:
            if self.config.auto_retrain_enabled:
                asyncio.create_task(self._retrain_background())
            else:
                self._retrain_due = True

        # 12. Concept drift check (background — every DRIFT_CHECK_INTERVAL cycles)
        if self._cycle_count % DRIFT_CHECK_INTERVAL == 0:
            asyncio.create_task(self._drift_check_background())

        # Store latest signal snapshot for status endpoint and Monitor UI
        self._last_cycle_signals = {
            "action":       result.action,
            "ensemble_pct": round(result.confidence * 100, 1),
            "lgbm_pct":     round(lgbm_prob * 100, 1),
            "c2_dir_pct":   round(c2_out.get("c2_dir_prob", 0.5) * 100, 1),
            "c2_p50":       c2_out.get("c2_p50"),
            "c2_cont_prob": round(c2_out.get("c2_cont_prob", 0.0) * 100, 1),
            "reasoning":    result.reasoning,
            "updated_at":   datetime.now(timezone.utc).isoformat(),
        }

        elapsed_ms = (datetime.now(timezone.utc) - cycle_start).total_seconds() * 1000
        log.info("Cycle %d done in %.0fms | action=%s", self._cycle_count, elapsed_ms, result.action)

    # ── LightGBM ──────────────────────────────────────────────────────────────

    def _load_model_from_disk(self):
        result = load_correct_model(self.config.use_feature_pruning)
        if result:
            self._lgbm_model, self._lgbm_features = result
            log.info(
                "LightGBM model loaded from disk (%d features, pruning=%s)",
                len(self._lgbm_features), self.config.use_feature_pruning,
            )
        else:
            log.warning("No LightGBM model on disk — using neutral probability (0.5) until first retrain")
        self._load_1h_model()

    def _load_1h_model(self):
        result = load_1h_model()
        if result:
            self._lgbm_1h, self._lgbm_1h_features = result
            log.info("1H LightGBM gate loaded (%d features)", len(self._lgbm_1h_features))
        else:
            self._lgbm_1h          = None
            self._lgbm_1h_features = None
            if self.config.use_1h_lgbm_gate:
                log.warning("1H LGBM model not found — gate will be skipped until POST /retrain/1h is called")

    def _get_lgbm_prob(self, df_feat: pd.DataFrame) -> float:
        if self._lgbm_model is None:
            return 0.5  # neutral prior before first model is trained

        features = self._lgbm_features or [f for f in ALL_FEATURES if f in df_feat.columns]
        row = df_feat.reindex(columns=features, fill_value=0).iloc[[-1]].fillna(0)
        try:
            return float(self._lgbm_model.predict_proba(row)[0, 1])
        except Exception as exc:
            log.warning("LightGBM predict failed: %s — using 0.5", exc)
            return 0.5

    def _get_lgbm_1h_prob(self, df_feat: pd.DataFrame) -> float:
        """Predict P(up on 1H) using the 1H gate model. Returns 0.5 if model unavailable."""
        if self._lgbm_1h is None:
            return 0.5
        available = [f for f in (self._lgbm_1h_features or []) if f in df_feat.columns]
        if not available:
            return 0.5
        row = df_feat.iloc[[-1]][available].fillna(0)
        try:
            return float(self._lgbm_1h.predict_proba(row)[0, 1])
        except Exception as exc:
            log.warning("1H LightGBM predict failed: %s — using 0.5", exc)
            return 0.5

    # ── Retraining ────────────────────────────────────────────────────────────

    async def _reload_model_after_retrain(self, metrics: dict, trigger: str = "auto"):
        """Common post-retrain logic: reload model, persist metrics, log to Supabase."""
        result = load_correct_model(self.config.use_feature_pruning)
        if result:
            self._lgbm_model, self._lgbm_features = result
        # Reload calibrator from disk when retrain updated it
        if (metrics.get("calibrator") or {}).get("status") == "ok":
            self._chronos.reload_calibrator()
        # Reload 1H model from disk when retrain updated it
        if (metrics.get("lgbm_1h") or {}).get("status") == "ok":
            self._load_1h_model()
        self._last_retrain_metrics = metrics
        self._retrain_due = False
        log.info(
            "LightGBM model reloaded (%s): OOS acc=%.2f%%, ll=%.4f",
            trigger, metrics["oos_accuracy"] * 100, metrics["oos_log_loss"],
        )
        try:
            db = get_supabase()
            db.table("events").insert({
                "severity": "info",
                "kind":     "lgbm_retrained",
                "message":  f"LightGBM retrained ({trigger}): OOS acc={metrics['oos_accuracy']:.2%}",
                "payload":  {**metrics, "trigger": trigger},
            }).execute()
        except Exception:
            pass

    async def _retrain_background(self):
        log.info("Auto-retraining triggered (cycle %d)", self._cycle_count)
        try:
            metrics = await self._trainer.retrain(
                SYMBOL,
                lookback_candles=500,
                wf_n_splits=self.config.wf_n_splits,
                wf_purge_gap=self.config.wf_purge_gap,
                use_feature_pruning=self.config.use_feature_pruning,
                feature_pruning_min_importance=self.config.feature_pruning_min_importance,
                use_chronos_calibration=self.config.use_chronos_calibration,
                use_1h_lgbm_gate=self.config.use_1h_lgbm_gate,
                binance_cvd_enabled=self.config.binance_cvd_enabled,
                reversal_mode_enabled=getattr(self.config, "reversal_mode_enabled", False),
            )
            if metrics.get("status") == "ok":
                await self._reload_model_after_retrain(metrics, trigger="auto")
        except Exception as exc:
            log.error("Retraining failed: %s", exc, exc_info=True)

    async def _drift_check_background(self):
        """
        Runs check_drift() in background every DRIFT_CHECK_INTERVAL cycles.
        If drift is detected and the DRIFT_RETRAIN_COOLDOWN_H window has passed,
        triggers an emergency retrain and logs a 'concept_drift' event to Supabase.
        """
        try:
            result = await self._trainer.check_drift(SYMBOL, use_pruning=self.config.use_feature_pruning)
            self._last_drift_result = {**result, "checked_at": datetime.now(timezone.utc).isoformat()}

            if not result.get("drift"):
                log.info(
                    "Drift check OK: ll=%.4f (threshold=%.4f) [%d samples]",
                    result.get("recent_ll", 0.0),
                    result.get("threshold", 0.0),
                    result.get("n_samples", 0),
                )
                return

            # Drift detected — enforce cooldown to avoid retrain storms
            now = datetime.now(timezone.utc)
            if (
                self._last_drift_retrain is not None
                and (now - self._last_drift_retrain).total_seconds() < DRIFT_RETRAIN_COOLDOWN_H * 3600
            ):
                log.warning(
                    "Concept drift detected (ll=%.4f > %.4f) — cooldown active, skipping retrain",
                    result["recent_ll"], result["threshold"],
                )
                return

            log.warning(
                "Concept drift detected (ll=%.4f > %.4f) — triggering emergency retrain (cycle %d)",
                result["recent_ll"], result["threshold"], self._cycle_count,
            )

            # Persist drift event to Supabase for UI visibility
            try:
                db = get_supabase()
                db.table("events").insert({
                    "severity": "warning",
                    "kind":     "concept_drift",
                    "message":  (
                        f"Concept drift: ll={result['recent_ll']:.4f} > "
                        f"threshold={result['threshold']:.4f}. Emergency retrain triggered."
                    ),
                    "payload":  {**result, "cycle": self._cycle_count},
                }).execute()
            except Exception:
                pass

            self._last_drift_retrain = now
            metrics = await self._trainer.retrain(
                SYMBOL,
                lookback_candles=500,
                wf_n_splits=self.config.wf_n_splits,
                wf_purge_gap=self.config.wf_purge_gap,
                use_feature_pruning=self.config.use_feature_pruning,
                feature_pruning_min_importance=self.config.feature_pruning_min_importance,
                use_chronos_calibration=self.config.use_chronos_calibration,
                use_1h_lgbm_gate=self.config.use_1h_lgbm_gate,
                binance_cvd_enabled=self.config.binance_cvd_enabled,
                reversal_mode_enabled=getattr(self.config, "reversal_mode_enabled", False),
            )
            if metrics.get("status") == "ok":
                await self._reload_model_after_retrain(metrics, trigger="drift")
            elif metrics.get("status") == "busy":
                log.info("Drift retrain skipped — another retrain already in progress")

        except Exception as exc:
            log.error("Drift check failed: %s", exc, exc_info=True)

    async def retrain_manual(
        self,
        from_date: Optional[str] = None,
        use_optuna_override: Optional[bool] = None,
        optuna_n_trials_override: Optional[int] = None,
    ) -> dict:
        """
        Manual retrain triggered from the UI.
        from_date: "YYYY-MM-DD" for deep training (uses Binance historical data).
        use_optuna_override / optuna_n_trials_override: per-request overrides that take
          precedence over config values without mutating engine.config permanently.
          Auto/drift retrains always pass use_optuna=False (speed priority).
        Returns {"status": "busy"} immediately if a retrain is already in progress.
        """
        use_optuna      = use_optuna_override      if use_optuna_override      is not None else self.config.use_optuna
        optuna_n_trials = optuna_n_trials_override if optuna_n_trials_override is not None else self.config.optuna_n_trials

        metrics = await self._trainer.retrain(
            SYMBOL,
            lookback_candles=500,
            from_date=from_date,
            wf_n_splits=self.config.wf_n_splits,
            wf_purge_gap=self.config.wf_purge_gap,
            use_feature_pruning=self.config.use_feature_pruning,
            feature_pruning_min_importance=self.config.feature_pruning_min_importance,
            use_chronos_calibration=self.config.use_chronos_calibration,
            use_1h_lgbm_gate=self.config.use_1h_lgbm_gate,
            use_optuna=use_optuna,
            optuna_n_trials=optuna_n_trials,
            binance_cvd_enabled=self.config.binance_cvd_enabled,
            reversal_mode_enabled=getattr(self.config, "reversal_mode_enabled", False),
        )
        if metrics.get("status") == "ok":
            await self._reload_model_after_retrain(metrics, trigger="manual" if not from_date else "deep")
        return metrics

    # ── Position management ───────────────────────────────────────────────────

    async def _open_position(
        self,
        result: DecisionResult,
        snap: Optional[dict],
        atr: Optional[float],
        inference_id: Optional[str],
        cfg: Optional[BotConfig] = None,
        atr_sl: Optional[float] = None,
        sl_override: Optional[float] = None,
        tp_override: Optional[float] = None,
        size_usd_override: Optional[float] = None,
    ):
        # cfg holds the effective config for this trade (may include regime overrides).
        # _manage_position continues to read self.config throughout the trade lifetime.
        cfg   = cfg or self.config
        price = (snap or {}).get("mark_price") or (self._ws.latest_mark or 0.0)
        atr   = atr or price * 0.01  # fallback 1% ATR

        # When sl_override/tp_override are provided (pending reversal fill), bypass all
        # dynamic SL/TP calculation — the structural levels were fixed at signal time.
        _has_overrides = sl_override is not None and tp_override is not None

        if _has_overrides:
            # Build TradeParams from override values (reversal pending fill).
            # SL/TP are structural prices fixed at signal time — not ATR-derived.
            from services.risk import TradeParams
            _sl_dist   = abs(price - sl_override)
            _tp_dist   = abs(tp_override - price)
            _rr        = _tp_dist / _sl_dist if _sl_dist > 0 else 0.0
            # size_usd_override (bounce-fade): use the frozen risk-based size from the
            # signal — prevents the position-size explosion that recomputing with a
            # tight resistance SL would cause. Falls back to the notional sizing used
            # by reversal pending fills when no override is given.
            if size_usd_override is not None and size_usd_override > 0:
                _size_usd = size_usd_override
            else:
                _size_usd = self._risk.position_size_pct / 100.0 * self._equity * result.size_factor
            _size_ctr  = _size_usd / price if price > 0 else 0.001
            params     = TradeParams(
                side           = result.action,
                entry_price    = price,
                stop_loss      = sl_override,
                take_profit    = tp_override,
                size_usd       = _size_usd,
                size_contracts = _size_ctr,
                rr_ratio       = round(_rr, 2),
                atr            = atr,
            )
        else:
            _use_dynamic   = cfg.dynamic_sl_tp_enabled and self.config.chronos_enabled
            _p10_available = self.config.chronos_enabled and (result.forecast_p10 or 0) > 0
            _needs_quantiles = _use_dynamic or (cfg.p10_sl_floor_enabled and _p10_available)

            # Temporarily apply cfg overrides to the risk manager for this trade calculation.
            # async is cooperative — no concurrent access risk within this coroutine.
            _orig_sl  = self._risk.sl_atr_mult
            _orig_tp  = self._risk.tp_atr_mult
            _orig_sz  = self._risk.position_size_pct
            self._risk.sl_atr_mult       = cfg.sl_atr_mult
            self._risk.tp_atr_mult       = cfg.tp_atr_mult
            self._risk.position_size_pct = cfg.position_size_pct

            params = self._risk.calculate_trade_params(
                side=result.action,
                entry_price=price,
                atr=atr,
                equity_usd=self._equity,
                sl_atr=atr_sl,
                c2_p10=result.forecast_p10 if _needs_quantiles else None,
                c2_p90=result.forecast_p90 if _needs_quantiles else None,
                c2_uncertainty=result.forecast_uncertainty if (_use_dynamic and result.forecast_uncertainty > 0) else None,
                dynamic_sl_tp_enabled=_use_dynamic,
                dynamic_sl_tp_blend=cfg.dynamic_sl_tp_blend,
                recalibrated_uncertainty_thresholds=getattr(cfg, "recalibrated_uncertainty_thresholds", True),
                p10_sl_floor_enabled=cfg.p10_sl_floor_enabled and _p10_available,
                ob_tp_enabled=getattr(cfg, "ob_tp_enabled", False),
                ob_tp_blend=getattr(cfg, "ob_tp_blend", 1.0),
                ob_bear_top_px=self._safe_float((result.features_snapshot or {}).get("ob_bear_top_px")),
                ob_bull_bot_px=self._safe_float((result.features_snapshot or {}).get("ob_bull_bot_px")),
                fvg_tp_enabled=getattr(cfg, "fvg_tp_enabled", False),
                fvg_tp_blend=getattr(cfg, "fvg_tp_blend", 1.0),
                fvg_bear_bot_px=self._safe_float((result.features_snapshot or {}).get("fvg_bear_bot_px")),
                fvg_bull_top_px=self._safe_float((result.features_snapshot or {}).get("fvg_bull_top_px")),
                swing_tp_enabled=getattr(cfg, "swing_tp_enabled", False),
                swing_tp_blend=getattr(cfg, "swing_tp_blend", 1.0),
                swing_high_px=self._safe_float((result.features_snapshot or {}).get("swing_high_px")),
                swing_low_px=self._safe_float((result.features_snapshot or {}).get("swing_low_px")),
            )

            # Restore original risk manager state
            self._risk.sl_atr_mult       = _orig_sl
            self._risk.tp_atr_mult       = _orig_tp
            self._risk.position_size_pct = _orig_sz

        # ── Structural SL override (OB-aware) ─────────────────────────────────
        # Skipped when sl_override/tp_override are provided (reversal pending fill) —
        # the structural levels were fixed at signal time and must not be overwritten.
        if cfg.structural_sl_enabled and not _has_overrides:
            _ob_applied, _ob_msg = apply_structural_sl(
                params, result.features_snapshot, price,
                ob_buffer_pct=getattr(cfg, "ob_buffer_pct", 0.3),
                ob_buffer_min_atr=getattr(cfg, "ob_buffer_min_atr", 0.0),
            )
            if _ob_applied:
                log.info("StructuralSL [%s]: %s", result.action, _ob_msg)
                result.reasoning.append(_ob_msg)

        if getattr(cfg, "fvg_sl_enabled", False) and not _has_overrides:
            _fvg_applied, _fvg_msg = apply_fvg_sl(
                params, result.features_snapshot or {}, price,
                ob_buffer_pct=getattr(cfg, "ob_buffer_pct", 0.3),
                ob_buffer_min_atr=getattr(cfg, "ob_buffer_min_atr", 0.0),
            )
            if _fvg_applied:
                log.info("FVG_SL [%s]: %s", result.action, _fvg_msg)
                result.reasoning.append(_fvg_msg)

        if getattr(cfg, "swing_sl_enabled", False) and not _has_overrides:
            _sw_applied, _sw_msg = apply_swing_sl(
                params, result.features_snapshot or {}, price,
            )
            if _sw_applied:
                log.info("SwingSL [%s]: %s", result.action, _sw_msg)
                result.reasoning.append(_sw_msg)

        # Apply regime bias size reduction for counter-trend trades
        eff_size_usd       = params.size_usd       * result.size_factor
        eff_size_contracts = params.size_contracts * result.size_factor

        # Round to 4 decimal places (HL BTC min size = 0.001)
        size = max(round(eff_size_contracts, 4), 0.001)

        # Pre-calculate level prices (needed before order submission for bracket orders)
        _atr = atr or price * 0.01
        _is_long = result.action == "long"
        _partial_tp_price = (
            (price + cfg.partial_tp_atr_mult * _atr) if _is_long
            else (price - cfg.partial_tp_atr_mult * _atr)
        ) if cfg.partial_tp_enabled else None
        _trailing_activation_price = (
            (price + cfg.trailing_sl_activation * _atr) if _is_long
            else (price - cfg.trailing_sl_activation * _atr)
        ) if cfg.trailing_sl_enabled else None

        if self.mode == "live":
            # Idempotency guard: abort if a position already exists on HL
            wallet = os.getenv("HL_WALLET_ADDRESS", "")
            if wallet:
                existing = await self._hl.get_open_position(wallet, SYMBOL)
                if existing is not None:
                    log.warning(
                        "Idempotency guard: position already open on HL (%s %.4f BTC). Skipping order.",
                        existing["side"].upper(), existing["size_contracts"],
                    )
                    # Reconcile in-memory state instead of opening a duplicate
                    await self._reconcile_position()
                    return
            hl_order_id = await self._submit_open_order(
                result.action, size, price, params.stop_loss, inference_id,
                take_profit=params.take_profit,
                partial_tp_price=_partial_tp_price if cfg.partial_tp_enabled else None,
                partial_tp_pct=cfg.partial_tp_pct,
            )
        else:
            hl_order_id = None
            _regime_tag = f" [regime={self._regime_signal.regime}]" if self._regime_signal else ""
            log.info(
                "[PAPER] %s %.4f BTC @ %.2f | SL=%.2f TP=%.2f R:R=%.2f%s",
                result.action.upper(), size, price,
                params.stop_loss, params.take_profit, params.rr_ratio, _regime_tag,
            )

        # Derive initial SL cloid for live mode (used to cancel/replace SL trigger on trailing move)
        import hashlib as _hl_hash
        _sl_cloid = (
            "0x" + _hl_hash.md5((inference_id or "").encode() + b"_sl").hexdigest()
            if self.mode == "live" else None
        )

        self._position = {
            "side":              result.action,
            "entry_price":       price,
            "stop_loss":         params.stop_loss,
            "take_profit":       params.take_profit,
            "sl_original":       params.stop_loss,
            "size_usd":          eff_size_usd,
            "original_size_usd": eff_size_usd,  # preserved even after partial TP reduces size_usd
            "size_contracts":    size,
            "entry_atr":         _atr,
            "inference_id":      inference_id,
            "hl_order_id":       hl_order_id,
            "opened_at":         datetime.now(timezone.utc).isoformat(),
            "bars_held":              0,
            "lgbm_strikes":           0,
            "be_sl_applied":          False,
            "sl_trailing_active":     False,
            "high_water":             price,
            "partial_done":           False,
            "partial_realized_pnl":   0.0,
            "entry_reasoning":        list(result.reasoning),
            # Pre-calculated level prices for UI
            "partial_tp_price":              _partial_tp_price,
            "trailing_sl_activation_price":  _trailing_activation_price,
            "trailing_sl_dist":              (self.config.trailing_sl_activation * _atr) if self.config.trailing_sl_enabled else None,
            # Live: tracks the active SL trigger cloid so we can cancel it when trailing moves the SL
            "current_sl_cloid":              _sl_cloid,
            # Reversal metadata (stored so _manage_position can use correct multipliers)
            "is_reversal":     getattr(result, "_is_reversal", False),
            "rev_sl_atr_mult": getattr(cfg, "reversal_sl_atr_mult", self.config.sl_atr_mult),
            "rev_max_hold":    getattr(cfg, "reversal_max_hold_bars", getattr(self.config, "max_hold_bars", 48)),
            # Feature E: Exhaustion Max Hold — shorter exit when ExhaustionGuard was active at entry
            "exhaust_max_hold": (
                getattr(cfg, "exhaustion_max_hold_bars", getattr(self.config, "exhaustion_max_hold_bars", 2))
                if getattr(result, "_exhaustion_triggered", False)
                   and getattr(cfg, "exhaustion_max_hold_enabled", getattr(self.config, "exhaustion_max_hold_enabled", False))
                else None
            ),
        }

        # Persist paper position immediately so it survives a restart
        if self.mode == "paper":
            self._save_paper_position()

        try:
            db = get_supabase()
            order_res = db.table("orders").insert({
                "bot_id":       "default",
                "hl_order_id":  hl_order_id,
                "symbol":       SYMBOL,
                "side":         result.action,
                "size":         size,
                "price":        price,
                "status":       "filled" if self.mode == "paper" else "pending",
                "inference_id": inference_id,
            }).execute()
            # Capture the generated order ID and store it in the position
            # so _emit_trade_event() can link events to this trade.
            if order_res.data:
                self._position["trade_id"] = order_res.data[0].get("id")
                # Re-persist with trade_id now populated (first persist at line above had no ID yet)
                if self.mode == "paper":
                    self._save_paper_position()
            db.table("events").insert({
                "severity": "info",
                "kind": "trade_opened",
                "message": f"[{self.mode.upper()}] {result.action.upper()} {size} BTC @ {price:.2f} | SL={params.stop_loss:.2f} TP={params.take_profit:.2f} R:R={params.rr_ratio:.2f}",
                "payload": {
                    "side": result.action, "symbol": SYMBOL, "size": size,
                    "price": price, "sl": params.stop_loss, "tp": params.take_profit,
                    "rr": params.rr_ratio, "size_usd": eff_size_usd, "mode": self.mode,
                    "size_factor": result.size_factor,
                },
            }).execute()
        except Exception as exc:
            log.warning("Order DB insert failed: %s", exc)

        await self._notifier.send_trade_opened(
            side=result.action,
            symbol=SYMBOL,
            size_usd=eff_size_usd,
            entry_price=price,
            stop_loss=params.stop_loss,
            take_profit=params.take_profit,
            rr=params.rr_ratio,
            ensemble_pct=round(result.confidence * 100, 1),
            dir_prob=result.directional_prob,
            inference_id=inference_id,
            reasoning=result.reasoning,
        )

    async def _emit_trade_event(self, kind: str, payload: dict):
        """Insert a trade lifecycle event into Supabase trade_events table (best-effort)."""
        if not self._position:
            return
        try:
            db = get_supabase()
            db.table("trade_events").insert({
                "trade_id": self._position.get("trade_id"),
                "kind":     kind,
                "payload":  payload,
                "time":     datetime.now(timezone.utc).isoformat(),
            }).execute()
        except Exception as exc:
            log.debug("trade_event insert skipped: %s", exc)

    async def _manage_position(self, current_price: float, df_feat: pd.DataFrame, c2_out: dict = None):
        if not self._position:
            return

        self._position["bars_held"] = self._position.get("bars_held", 0) + 1
        side    = self._position["side"]
        entry   = self._position["entry_price"]
        atr_val = float(df_feat.iloc[-1].get("atr_14") or current_price * 0.01)

        # Reversal-specific multipliers (stored in position dict at open time)
        _is_rev      = self._position.get("is_reversal", False)
        _rev_sl_mult = self._position.get("rev_sl_atr_mult", self.config.sl_atr_mult)
        _rev_max_h   = self._position.get("rev_max_hold",   getattr(self.config, "max_hold_bars", 48))

        # ── 1. Trailing SL update (always first, before any exit) ─────────────
        if self.config.trailing_sl_enabled:
            _trail_mult = _rev_sl_mult if _is_rev else self.config.trailing_sl_activation
            trail_dist  = _trail_mult * atr_val
            if not self._position.get("sl_trailing_active"):
                moved = (side == "long"  and current_price >= entry + trail_dist) or \
                        (side == "short" and current_price <= entry - trail_dist)
                if moved:
                    self._position["sl_trailing_active"] = True
                    self._position["high_water"] = current_price
                    log.info("Trailing SL activated — high_water=%.2f trail_dist=%.2f", current_price, trail_dist)
            if self._position.get("sl_trailing_active"):
                if side == "long":
                    self._position["high_water"] = max(self._position["high_water"], current_price)
                    new_sl = self._position["high_water"] - trail_dist
                    if new_sl > self._position["stop_loss"]:
                        old_sl = self._position["stop_loss"]
                        log.info("Trailing SL updated: %.2f → %.2f", old_sl, new_sl)
                        self._position["stop_loss"] = new_sl
                        if self.mode == "live":
                            _oc = self._position.get("current_sl_cloid")
                            _sz = self._position.get("size_contracts", 0)
                            async def _trail_sl_long(_oc=_oc, _sz=_sz, _ns=new_sl):
                                nc = await self._update_sl_trigger(None, side, _sz, _ns, old_cloid=_oc)
                                if nc and self._position:
                                    self._position["current_sl_cloid"] = nc
                                    self._persist_position_state()
                            asyncio.create_task(_trail_sl_long())
                        asyncio.create_task(self._emit_trade_event("sl_moved", {
                            "sl_old": old_sl, "sl_new": new_sl,
                            "high_water": self._position["high_water"],
                            "current_price": current_price, "reason": "trailing",
                        }))
                        asyncio.create_task(self._notifier.send_sl_moved(
                            side, SYMBOL, old_sl=old_sl, new_sl=new_sl,
                            high_water=self._position["high_water"], reason="trailing",
                        ))
                else:
                    self._position["high_water"] = min(self._position["high_water"], current_price)
                    new_sl = self._position["high_water"] + trail_dist
                    if new_sl < self._position["stop_loss"]:
                        old_sl = self._position["stop_loss"]
                        log.info("Trailing SL updated: %.2f → %.2f", old_sl, new_sl)
                        self._position["stop_loss"] = new_sl
                        if self.mode == "live":
                            _oc = self._position.get("current_sl_cloid")
                            _sz = self._position.get("size_contracts", 0)
                            async def _trail_sl_short(_oc=_oc, _sz=_sz, _ns=new_sl):
                                nc = await self._update_sl_trigger(None, side, _sz, _ns, old_cloid=_oc)
                                if nc and self._position:
                                    self._position["current_sl_cloid"] = nc
                                    self._persist_position_state()
                            asyncio.create_task(_trail_sl_short())
                        asyncio.create_task(self._emit_trade_event("sl_moved", {
                            "sl_old": old_sl, "sl_new": new_sl,
                            "high_water": self._position["high_water"],
                            "current_price": current_price, "reason": "trailing",
                        }))
                        asyncio.create_task(self._notifier.send_sl_moved(
                            side, SYMBOL, old_sl=old_sl, new_sl=new_sl,
                            high_water=self._position["high_water"], reason="trailing",
                        ))

        # ── 2. Break-even SL ──────────────────────────────────────────────────
        if self.config.be_sl_enabled and not self._position.get("be_sl_applied", False):
            activation_dist = self.config.be_sl_activation * atr_val
            if side == "long" and current_price >= entry + activation_dist:
                self._position["stop_loss"] = max(self._position["stop_loss"], entry)
                self._position["be_sl_applied"] = True
                log.info("Break-even SL activated (long) — SL moved to entry %.2f", entry)
                asyncio.create_task(self._emit_trade_event("be_sl", {
                    "sl_new": entry, "current_price": current_price,
                }))
                asyncio.create_task(self._notifier.send_breakeven_sl(side, SYMBOL, entry_price=entry))
            elif side == "short" and current_price <= entry - activation_dist:
                self._position["stop_loss"] = min(self._position["stop_loss"], entry)
                self._position["be_sl_applied"] = True
                log.info("Break-even SL activated (short) — SL moved to entry %.2f", entry)
                asyncio.create_task(self._emit_trade_event("be_sl", {
                    "sl_new": entry, "current_price": current_price,
                }))
                asyncio.create_task(self._notifier.send_breakeven_sl(side, SYMBOL, entry_price=entry))

        # ── 3. Partial TP (partial close, does not fully exit) ────────────────
        if self.config.partial_tp_enabled and not self._position.get("partial_done", False):
            entry_atr    = self._position.get("entry_atr") or atr_val
            partial_tgt  = (entry + self.config.partial_tp_atr_mult * entry_atr
                            if side == "long"
                            else entry - self.config.partial_tp_atr_mult * entry_atr)
            hit_partial  = ((side == "long"  and current_price >= partial_tgt) or
                            (side == "short" and current_price <= partial_tgt))
            if hit_partial:
                frac              = self.config.partial_tp_pct / 100.0
                partial_size_usd  = self._position["size_usd"] * frac
                partial_contracts = round(self._position["size_contracts"] * frac, 4)
                pnl_pct_p  = ((current_price - entry) / entry * 100 if side == "long"
                              else (entry - current_price) / entry * 100)
                fee_p      = partial_size_usd * HL_TAKER_FEE
                pnl_usd_p  = partial_size_usd * pnl_pct_p / 100 - fee_p

                self._equity                       += pnl_usd_p
                self._position["size_usd"]         *= (1.0 - frac)
                self._position["size_contracts"]    = round(self._position["size_contracts"] * (1.0 - frac), 4)
                self._position["partial_done"]      = True
                self._position["partial_realized_pnl"] = (
                    self._position.get("partial_realized_pnl", 0.0) + pnl_usd_p
                )
                # Auto-move SL to break-even after partial TP (protects remaining position)
                if not self._position.get("be_sl_applied", False):
                    if side == "long":
                        self._position["stop_loss"] = max(self._position["stop_loss"], entry)
                    else:
                        self._position["stop_loss"] = min(self._position["stop_loss"], entry)
                    self._position["be_sl_applied"] = True

                if self.mode == "live":
                    # Fallback path: bracket trigger didn't fire intracandle, firing at 4H close.
                    # Cancel the now-stale partial TP bracket trigger, send market partial close,
                    # and move the exchange SL to break-even.
                    import hashlib as _ph
                    _seed     = (self._position.get("inference_id") or "").encode()
                    _ptp_cloid = "0x" + _ph.md5(_seed + b"_ptp").hexdigest()
                    try:
                        from hyperliquid.exchange import Exchange
                        from hyperliquid.utils import constants
                        import eth_account
                        _w  = eth_account.Account.from_key(HL_AGENT_PRIVKEY)
                        _ep = constants.TESTNET_API_URL if HL_TESTNET else constants.MAINNET_API_URL
                        _ex = Exchange(_w, _ep, account_address=os.getenv("HL_WALLET_ADDRESS"))
                        await asyncio.to_thread(_ex.cancel_by_cloid, SYMBOL, _ptp_cloid)
                        log.info("Stale partial-TP bracket trigger canceled (fallback close path)")
                    except Exception as _pce:
                        log.debug("Cancel stale partial-TP trigger skipped: %s", _pce)

                    await self._submit_partial_close(partial_contracts, current_price, side)

                    # Also update exchange SL to break-even
                    _oc = self._position.get("current_sl_cloid")
                    _rem_sz = self._position.get("size_contracts", 0)
                    _new_sl = self._position["stop_loss"]
                    async def _be_sl_after_ptp(_oc=_oc, _rem_sz=_rem_sz, _ns=_new_sl):
                        nc = await self._update_sl_trigger(None, side, _rem_sz, _ns, old_cloid=_oc)
                        if nc and self._position:
                            self._position["current_sl_cloid"] = nc
                            self._persist_position_state()
                    asyncio.create_task(_be_sl_after_ptp())

                log.info(
                    "[%s] Partial TP %.0f%% @ %.2f | pnl=+%.2f%% ($%.2f)",
                    self.mode.upper(), self.config.partial_tp_pct, current_price,
                    pnl_pct_p, pnl_usd_p,
                )
                asyncio.create_task(self._emit_trade_event("partial_tp", {
                    "price": current_price,
                    "pct_closed": self.config.partial_tp_pct,
                    "pnl_usd": round(pnl_usd_p, 2),
                    "pnl_pct": round(pnl_pct_p, 4),
                    "remaining_usd": self._position["size_usd"],
                    "remaining_contracts": self._position["size_contracts"],
                    "new_sl": self._position["stop_loss"],
                }))
                asyncio.create_task(self._notifier.send_partial_tp(
                    side=side, symbol=SYMBOL,
                    pct=self.config.partial_tp_pct,
                    price=current_price,
                    pnl_usd=pnl_usd_p,
                    pnl_pct=pnl_pct_p,
                    remaining_usd=self._position["size_usd"],
                    new_sl=self._position["stop_loss"],
                ))

        # ── 4. LightGBM mid-trade exit ────────────────────────────────────────
        # Skipped for reversal trades: LGBM is trained on trend-following data and
        # will systematically produce low confidence on counter-trend positions,
        # causing premature exits.
        if (self.config.lgbm_exit_enabled and self._lgbm_model is not None
                and self._position["bars_held"] >= self.config.lgbm_exit_min_hold_bars
                and not _is_rev):
            lgbm_p   = self._get_lgbm_prob(df_feat)
            entry_px = self._position["entry_price"]

            if self.config.enhanced_exit_enabled and c2_out:
                c2_p50 = c2_out.get("c2_p50", 0.0)
                # Guard: only use c2_p50 when it's not trivially equal to current price
                c2_available = c2_p50 > 0.0 and abs(c2_p50 - current_price) > (0.001 * current_price)
                if c2_available:
                    # Both LGBM signal flip AND c2_p50 must confirm direction
                    flip_long  = side == "long"  and lgbm_p < self.config.lgbm_exit_threshold and c2_p50 < entry_px
                    flip_short = side == "short" and lgbm_p > (1.0 - self.config.lgbm_exit_threshold) and c2_p50 > entry_px
                else:
                    # c2_p50 unavailable — fall back to LGBM-only
                    flip_long  = side == "long"  and lgbm_p < self.config.lgbm_exit_threshold
                    flip_short = side == "short" and lgbm_p > (1.0 - self.config.lgbm_exit_threshold)
            else:
                flip_long  = side == "long"  and lgbm_p < self.config.lgbm_exit_threshold
                flip_short = side == "short" and lgbm_p > (1.0 - self.config.lgbm_exit_threshold)

            if flip_long or flip_short:
                self._position["lgbm_strikes"] = self._position.get("lgbm_strikes", 0) + 1
            else:
                self._position["lgbm_strikes"] = 0
            if self._position.get("lgbm_strikes", 0) >= self.config.lgbm_exit_confirm_bars:
                log.info(
                    "LightGBM mid-trade exit: %s | p=%.3f | bars_held=%d | strikes=%d",
                    side, lgbm_p, self._position["bars_held"], self._position["lgbm_strikes"],
                )
                await self._close_position(current_price, "lgbm_exit")
                return

        # ── 5. Max hold bars: time-based exit ─────────────────────────────────
        # Priority: exhaust_max_hold (Feature E) > rev_max_hold (reversals) > max_hold_bars (trend).
        _exhaust_max_h = self._position.get("exhaust_max_hold")  # None if not set
        if _exhaust_max_h is not None:
            _max_hold_limit  = _exhaust_max_h
            _max_hold_active = True
        elif _is_rev:
            _max_hold_limit  = _rev_max_h
            _max_hold_active = True
        else:
            _max_hold_limit  = getattr(self.config, "max_hold_bars", 48)
            _max_hold_active = self.config.max_hold_bars_enabled
        if (_max_hold_active and self._position["bars_held"] >= _max_hold_limit):
            _hold_reason = "exhaust_max_hold" if _exhaust_max_h is not None else "max_hold_bars"
            log.info("Max hold bars reached (%d, reason=%s, reversal=%s) — closing position", _max_hold_limit, _hold_reason, _is_rev)
            await self._close_position(current_price, _hold_reason)
            return

        # ── 6. Standard SL / TP check ─────────────────────────────────────────
        sl = self._position["stop_loss"]
        tp = self._position["take_profit"]
        # Skip SL/TP checks when values are 0.0 (unknown after reconciliation).
        # The native HL trigger order still protects capital in live mode.
        # Values get recalculated from ATR on the next new-trade cycle.
        reason = None
        if sl > 0.0 or tp > 0.0:
            if sl > 0.0 and self._risk.should_stop_loss(side, current_price, sl):
                reason = "stop_loss"
            elif tp > 0.0 and self._risk.should_take_profit(side, current_price, tp):
                reason = "take_profit"

        if reason:
            await self._close_position(current_price, reason)
        else:
            # Position is still open — persist any in-flight state changes (trailing SL,
            # partial_done, be_sl_applied, lgbm_strikes, bars_held, high_water, etc.)
            self._persist_position_state()

    async def _close_position(self, exit_price: float, reason: str, exchange_already_closed: bool = False):
        if not self._position:
            return

        side              = self._position["side"]
        entry             = self._position["entry_price"]
        size              = self._position["size_usd"]             # remaining after any partial TP
        original_size_usd = self._position.get("original_size_usd") or size

        price_pct = (
            (exit_price - entry) / entry * 100 if side == "long"
            else (entry - exit_price) / entry * 100
        )
        fee_exit = size * HL_TAKER_FEE
        pnl_usd  = size * price_pct / 100 - fee_exit

        opened    = datetime.fromisoformat(self._position["opened_at"])
        holding_h = (datetime.now(timezone.utc) - opened).total_seconds() / 3600

        # Compute total PnL (final leg + any partial TP already realized) before
        # updating risk guards and sending notifications, so both use the true
        # trade result rather than only the final-leg price return.
        partial_pnl   = self._position.get("partial_realized_pnl", 0.0) or 0.0
        total_pnl_usd = pnl_usd + partial_pnl
        # pnl_pct as % of original position size (consistent with pnl_usd being total)
        total_pnl_pct = total_pnl_usd / original_size_usd * 100 if original_size_usd else price_pct

        if self.mode == "live" and not exchange_already_closed:
            # exchange_already_closed=True when called from _cycle's trigger-detection path:
            # the position was already closed by a native SL/TP order, no market close needed.
            try:
                await self._submit_close_order()
            except Exception as exc:
                log.error("Close order failed: %s", exc)

        self._equity += pnl_usd
        self._risk.record_trade_result(total_pnl_pct)

        log.info(
            "Position closed: %s | %s | PnL %+.2f%% ($%+.2f) [price_pct=%+.2f%%]",
            side.upper(), reason, total_pnl_pct, total_pnl_usd, price_pct,
        )

        await self._notifier.send_trade_closed(
            side=side,
            symbol=SYMBOL,
            pnl_usd=total_pnl_usd,
            pnl_pct=total_pnl_pct,
            reason=reason,
            holding_hours=holding_h,
            equity_usd=self._equity,
            partial_pnl_usd=partial_pnl,
        )

        try:
            db = get_supabase()
            db.table("equity_snapshots").insert({
                "bot_id":         "default",
                "equity_usd":     self._equity,
                "unrealized_pnl": 0.0,
                "realized_pnl":   total_pnl_usd,
                "drawdown_pct":   min(0.0, total_pnl_pct),
            }).execute()
            severity = "info" if total_pnl_usd >= 0 else "warning"
            db.table("events").insert({
                "severity": severity,
                "kind": "trade_closed",
                "message": f"[{self.mode.upper()}] {side.upper()} chiuso ({reason}) | PnL {total_pnl_pct:+.2f}% (${total_pnl_usd:+.2f}) in {holding_h:.1f}h",
                "payload": {
                    "side": side, "symbol": SYMBOL, "reason": reason,
                    "pnl_pct": round(total_pnl_pct, 4), "pnl_usd": round(total_pnl_usd, 2),
                    "entry": entry, "exit": exit_price, "holding_h": round(holding_h, 2),
                    "partial_pnl_usd": round(partial_pnl, 2),
                    "mode": self.mode,
                },
            }).execute()
            # Insert completed trade into trades table (feeds TradeLog UI)
            _valid_reasons = {"stop_loss", "take_profit", "manual", "kill", "lgbm_exit", "max_hold_bars", "macro_pause", "exchange_close"}
            _reason_close = reason if reason in _valid_reasons else "manual"
            db.table("trades").insert({
                "bot_id":          "default",
                "entry_order_id":  self._position.get("trade_id"),
                "symbol":          SYMBOL,
                "side":            side,
                "entry_price":     round(entry, 2),
                "exit_price":      round(exit_price, 2),
                "pnl_usd":         round(total_pnl_usd, 2),
                "pnl_pct":         round(total_pnl_pct, 4),
                "partial_pnl_usd": round(partial_pnl, 2),
                "holding_sec":     int(holding_h * 3600),
                "reason_close":    _reason_close,
                "opened_at":       self._position["opened_at"],
                "closed_at":       datetime.now(timezone.utc).isoformat(),
                "mode":            self.mode,
                # FK to inference_logs — enables calibrator join on c2_dir_prob
                "inference_id":    self._position.get("inference_id"),
            }).execute()
        except Exception as exc:
            log.warning("Equity/trade snapshot write failed: %s", exc)

        self._position = None

        # Clear persisted position state now that the trade is closed
        if self.mode == "paper":
            self._save_paper_position()
        else:
            # Live mode: clear saved in-flight state so a future restart doesn't
            # re-apply stale state from the closed trade to a new position.
            try:
                db = get_supabase()
                row = db.table("bot_configs").select("params").eq("name", "default").execute()
                existing = (row.data[0].get("params") or {}) if row.data else {}
                existing.pop("_live_position_state", None)
                db.table("bot_configs").update({"params": existing}).eq("name", "default").execute()
            except Exception as exc:
                log.warning("Could not clear live position state: %s", exc)

    # ── Pullback Entry methods ────────────────────────────────────────────────

    async def _create_pending_pullback(
        self, result, latest: dict, atr: float, snap: dict
    ) -> "PendingPullback":
        """
        Creates a PendingPullback after a strong impulse candle.
        In paper mode: passive monitoring with the OB level (or ATR zone) as target.
        In live mode:  places a real GTC limit order on HL when an OB is active.
        """
        close   = float(latest.get("close") or snap["mark_price"])
        pb_dist = getattr(self.config, "pullback_zone_atr",     0.3) * atr
        fb_dist = getattr(self.config, "pullback_fallback_atr", 0.5) * atr
        window  = getattr(self.config, "pullback_window_h",     3)
        expires = datetime.now(timezone.utc) + timedelta(hours=window)
        sl_buf  = atr * 0.05   # tiny buffer so SL sits just outside the OB boundary
        ob_order_id: Optional[str] = None
        ob_sl_price: Optional[float] = None

        if result.action == "long":
            ob_top    = self._safe_float(latest.get("ob_bull_top_px"))
            ob_bot    = self._safe_float(latest.get("ob_bull_bot_px"))
            ob_active = bool(latest.get("ob_bull_active"))
            if ob_active and ob_top and ob_top < close:
                pullback_zone = ob_top
                ob_sl_price   = (ob_bot - sl_buf) if ob_bot else (ob_top - sl_buf * 4)
                if self.mode == "live":
                    try:
                        eff_size = (
                            self._risk.calculate_trade_params(
                                result.action, close, atr, self._equity
                            ).size_contracts * result.size_factor
                        )
                        ob_order_id = await self._place_ob_limit_order("long", ob_top, eff_size)
                        log.info("OB GTC limit (long): oid=%s px=%.2f sl=%.2f", ob_order_id, ob_top, ob_sl_price)
                    except Exception as _e:
                        log.warning("OB limit order failed (fallback to passive): %s", _e)
            else:
                pullback_zone = close - pb_dist
            fallback_limit = close + fb_dist   # price runs up → signal decays
        else:   # short
            ob_bot    = self._safe_float(latest.get("ob_bear_bot_px"))
            ob_top    = self._safe_float(latest.get("ob_bear_top_px"))
            ob_active = bool(latest.get("ob_bear_active"))
            if ob_active and ob_bot and ob_bot > close:
                pullback_zone = ob_bot
                ob_sl_price   = (ob_top + sl_buf) if ob_top else (ob_bot + sl_buf * 4)
                if self.mode == "live":
                    try:
                        eff_size = (
                            self._risk.calculate_trade_params(
                                result.action, close, atr, self._equity
                            ).size_contracts * result.size_factor
                        )
                        ob_order_id = await self._place_ob_limit_order("short", ob_bot, eff_size)
                        log.info("OB GTC limit (short): oid=%s px=%.2f sl=%.2f", ob_order_id, ob_bot, ob_sl_price)
                    except Exception as _e:
                        log.warning("OB limit order failed (fallback to passive): %s", _e)
            else:
                pullback_zone = close + pb_dist
            fallback_limit = close - fb_dist   # price drops hard → signal decays

        return PendingPullback(
            direction=result.action,
            close_4h=close,
            atr_at_signal=atr,
            pullback_zone=pullback_zone,
            fallback_limit=fallback_limit,
            expires_at=expires,
            decision_result=result,
            ob_sl_price=ob_sl_price,
            ob_order_id=ob_order_id,
        )

    async def _check_pullback_entry(self, price: float, snap: dict, atr: Optional[float]):
        """
        Evaluates the active pending pullback. Called every cycle with current mark price.
        Opens a position when conditions are met; clears pending on decay or timeout.
        Paper mode: simulates fill by comparing mark price vs. pullback_zone.
        Live mode (OB order placed): queries HL order status.
        """
        if self._pending_pullback is None:
            return
        pb = self._pending_pullback

        # If a position was opened in the same cycle (race-guard), cancel pending
        if self._position:
            if pb.ob_order_id is not None and self.mode == "live":
                await self._cancel_ob_limit_order(pb.ob_order_id)
                log.info("Pullback OB order cancelled: position already open (oid=%s)", pb.ob_order_id)
            self._pending_pullback = None
            return

        now       = datetime.now(timezone.utc)
        direction = pb.direction

        # ── Live mode with active GTC order ────────────────────────────────
        if pb.ob_order_id is not None and self.mode == "live":
            order_status = await self._get_ob_order_status(pb.ob_order_id)
            if order_status == "filled":
                log.info("OB GTC order filled (live): oid=%s dir=%s", pb.ob_order_id, direction)
                await self._register_ob_limit_fill(pb, snap, atr)
                return
            # Decay: price broke hard opposite direction
            decay = (
                (direction == "long"  and price > pb.fallback_limit) or
                (direction == "short" and price < pb.fallback_limit)
            )
            if decay:
                await self._cancel_ob_limit_order(pb.ob_order_id)
                log.info("OB GTC cancelled: decay opposite breakout (%s price=%.2f)", direction, price)
                self._pending_pullback = None
                return
            if now >= pb.expires_at:
                await self._cancel_ob_limit_order(pb.ob_order_id)
                in_range = (
                    (direction == "long"  and price <= pb.fallback_limit) or
                    (direction == "short" and price >= pb.fallback_limit)
                )
                if in_range:
                    log.info("OB GTC timeout — fallback market (live): price=%.2f", price)
                    await self._execute_pullback_entry(pb, snap, atr, use_atr_sl=True)
                else:
                    log.info("OB GTC timeout + price too far — signal decayed (live): price=%.2f", price)
                    self._pending_pullback = None
            return

        # ── Paper mode / passive monitoring (no live GTC order) ────────────
        # In paper mode, OB zone is used as the passive monitoring target too.
        # Price touched the pullback zone → enter immediately
        hit_zone = (
            (direction == "long"  and price <= pb.pullback_zone) or
            (direction == "short" and price >= pb.pullback_zone)
        )
        if hit_zone:
            log.info("Pullback entry triggered (%s): price=%.2f zone=%.2f", direction, price, pb.pullback_zone)
            # use_atr_sl=False: OB mode → "ob_market_fill"; passive → "pullback_market"
            # Timeout fallbacks use use_atr_sl=True → "pullback_fallback"
            await self._execute_pullback_entry(pb, snap, atr, use_atr_sl=False)
            return

        # Decay: price broke hard opposite direction
        decay = (
            (direction == "long"  and price > pb.fallback_limit) or
            (direction == "short" and price < pb.fallback_limit)
        )
        if decay:
            log.info("Pullback decayed (%s): opposite breakout price=%.2f fallback=%.2f",
                     direction, price, pb.fallback_limit)
            self._pending_pullback = None
            return

        # Timeout: check fallback
        if now >= pb.expires_at:
            in_range = (
                (direction == "long"  and price <= pb.fallback_limit) or
                (direction == "short" and price >= pb.fallback_limit)
            )
            if in_range:
                log.info("Pullback fallback (%s): timeout, price=%.2f still near close=%.2f",
                         direction, price, pb.close_4h)
                await self._execute_pullback_entry(pb, snap, atr, use_atr_sl=True)
            else:
                log.info("Pullback decayed (%s): timeout + price too far (%.2f)", direction, price)
                self._pending_pullback = None

    async def _execute_pullback_entry(
        self, pb: "PendingPullback", snap: dict, atr: Optional[float], use_atr_sl: bool = False
    ):
        """
        Opens a position from a triggered pullback (market order at current price).

        SL note: _open_position always recomputes SL via calculate_trade_params(entry_price=snap[mark_price])
        so it is naturally re-anchored to the actual entry price using config.sl_atr_mult.
        For OB mode, apply_structural_sl() inside _open_position handles the OB-based SL automatically.
        No manual SL override is needed here.

        entry_mode labels:
          "pullback_market"  — zone hit, passive monitoring (no OB)
          "ob_market_fill"   — zone hit, OB level was the target (paper simulated as passive)
          "pullback_fallback"— timeout fallback entry
        """
        actual_entry = snap["mark_price"]
        _atr = atr or actual_entry * 0.01

        if use_atr_sl:
            entry_mode = "pullback_fallback"
        elif pb.ob_sl_price is not None:
            entry_mode = "ob_market_fill"
        else:
            entry_mode = "pullback_market"

        improvement = abs(pb.close_4h - actual_entry)
        pb.decision_result.reasoning.append(
            f"PullbackEntry: {entry_mode} | signal_close={pb.close_4h:.2f} "
            f"actual_entry={actual_entry:.2f} improvement={improvement:.2f} "
            f"impulse_ratio={(improvement / pb.atr_at_signal if pb.atr_at_signal > 0 else 0):.2f}×ATR"
        )

        inf_id = getattr(pb.decision_result, "inference_id", None)
        await self._open_position(pb.decision_result, snap, _atr, inf_id)
        self._pending_pullback = None

    # ── Bounce-Fade Entry ───────────────────────────────────────────────────────

    async def _create_pending_bounce_fade(
        self, result, latest: dict, atr: Optional[float],
        snap: dict, inference_id: Optional[str], atr_sl: Optional[float] = None,
    ) -> "Optional[PendingBounceFade]":
        """
        Builds a PendingBounceFade for a counter-trend signal. Computes the limit
        entry as a fraction (penetration_pct) of the distance toward the nearest
        overhead resistance (short) / underlying support (long), capped at
        offset_atr × ATR. Freezes the original risk-based size and absolute TP so
        the fill cannot inflate the position. Returns None if no sensible limit
        above (below) the current price can be formed.
        """
        cfg   = self.config
        close = float(latest.get("close") or snap["mark_price"])
        _atr  = atr or close * 0.01
        if _atr <= 0 or close <= 0:
            return None

        pen   = getattr(cfg, "bounce_fade_penetration_pct", 0.50)
        cap   = getattr(cfg, "bounce_fade_offset_atr",      0.50) * _atr
        win   = getattr(cfg, "bounce_fade_window_bars",     2)
        ema50 = close - self._safe_float(latest.get("ema50_dist") or 0.0) * _atr

        if result.action == "short":
            cands = [lv for lv in (
                self._safe_float(latest.get("ob_bear_top_px")),
                self._safe_float(latest.get("fvg_bear_bot_px")),
                self._safe_float(latest.get("swing_high_px")),
                ema50,
            ) if lv and close < lv < close * 1.05]
            resistance  = min(cands) if cands else close + cap
            offset      = min(cap, pen * (resistance - close))
            entry_limit = close + offset
        else:  # long counter-trend
            cands = [lv for lv in (
                self._safe_float(latest.get("ob_bull_bot_px")),
                self._safe_float(latest.get("fvg_bull_top_px")),
                self._safe_float(latest.get("swing_low_px")),
                ema50,
            ) if lv and close * 0.95 < lv < close]
            support     = max(cands) if cands else close - cap
            offset      = min(cap, pen * (close - support))
            entry_limit = close - offset
            resistance  = support

        if offset <= 0:
            return None  # no room for a better entry — fall through to normal entry

        # Freeze the original market-entry params (size + absolute TP) so the fill
        # reuses them. This is what prevents the risk-based size explosion when the
        # fill later uses a tighter resistance SL.
        _orig_sl_mult = self._risk.sl_atr_mult
        _orig_tp_mult = self._risk.tp_atr_mult
        _orig_sz_pct  = self._risk.position_size_pct
        self._risk.sl_atr_mult       = cfg.sl_atr_mult
        self._risk.tp_atr_mult       = cfg.tp_atr_mult
        self._risk.position_size_pct = cfg.position_size_pct
        try:
            _orig = self._risk.calculate_trade_params(
                side=result.action, entry_price=close, atr=_atr,
                equity_usd=self._equity, sl_atr=atr_sl,
            )
        finally:
            self._risk.sl_atr_mult       = _orig_sl_mult
            self._risk.tp_atr_mult       = _orig_tp_mult
            self._risk.position_size_pct = _orig_sz_pct

        return PendingBounceFade(
            direction       = result.action,
            close_4h        = close,
            atr_at_signal   = _atr,
            entry_limit     = entry_limit,
            resistance      = resistance,
            bounce_extreme  = close,
            orig_tp         = _orig.take_profit,
            orig_size_usd   = _orig.size_usd * result.size_factor,
            sl_buffer_atr   = getattr(cfg, "bounce_fade_sl_buffer_atr", 0.30),
            sl_min_atr      = getattr(cfg, "bounce_fade_sl_min_atr",    0.80),
            min_rr          = getattr(cfg, "bounce_fade_min_rr",        1.5),
            expires_at      = datetime.now(timezone.utc) + timedelta(hours=win * 4),
            decision_result = result,
            market_fallback = getattr(cfg, "bounce_fade_market_fallback", True),
        )

    async def _check_bounce_fade_entry(
        self, price: float, snap: dict, atr: Optional[float],
        check_high: Optional[float] = None, check_low: Optional[float] = None,
    ):
        """
        Evaluates the active pending bounce-fade. Fills at the limit when the bounce
        reaches it (tight resistance SL + original absolute TP + frozen size), or
        enters at market on expiry if market_fallback is set and the signal persists.
        check_high/check_low: intracandle extremes from the paper watchdog; default
        to `price` when called from the 4H cycle.
        """
        bf = self._pending_bounce_fade
        if bf is None:
            return
        if self._position:           # race-guard: position already opened this cycle
            self._pending_bounce_fade = None
            return

        hi = check_high if (check_high and check_high > 0) else price
        lo = check_low  if (check_low  and check_low  > 0) else price
        if hi <= 0 or lo <= 0:
            return

        _atr = bf.atr_at_signal
        # Track the running bounce extreme (for the SL anchor)
        bf.bounce_extreme = max(bf.bounce_extreme, hi) if bf.direction == "short" else min(bf.bounce_extreme, lo)

        _reached = (bf.direction == "short" and hi >= bf.entry_limit) or \
                   (bf.direction == "long"  and lo <= bf.entry_limit)

        if _reached:
            entry = bf.entry_limit
            sl_buf = bf.sl_buffer_atr * _atr
            sl_min = bf.sl_min_atr    * _atr
            if bf.direction == "short":
                sl = max(bf.bounce_extreme, bf.resistance) + sl_buf
                sl = max(sl, entry + sl_min)              # enforce SL distance floor
                rr = (entry - bf.orig_tp) / (sl - entry) if sl > entry else 0.0
            else:
                sl = min(bf.bounce_extreme, bf.resistance) - sl_buf
                sl = min(sl, entry - sl_min)
                rr = (bf.orig_tp - entry) / (entry - sl) if entry > sl else 0.0

            if rr < bf.min_rr:
                log.info(
                    "BounceFade fill skipped: R:R %.2f < %.2f (entry=%.2f sl=%.2f tp=%.2f)",
                    rr, bf.min_rr, entry, sl, bf.orig_tp,
                )
                self._pending_bounce_fade = None
                return

            bf.decision_result.reasoning.append(
                f"BounceFadeFill: entry={entry:.2f} (vs close {bf.close_4h:.2f}) "
                f"SL={sl:.2f} TP={bf.orig_tp:.2f} R:R={rr:.2f}"
            )
            _fill_snap = {**snap, "mark_price": entry}
            inf_id = getattr(bf.decision_result, "inference_id", None)
            await self._open_position(
                bf.decision_result, _fill_snap, _atr, inf_id,
                sl_override=sl, tp_override=bf.orig_tp, size_usd_override=bf.orig_size_usd,
            )
            log.info(
                "BounceFade FILLED: %s entry=%.2f SL=%.2f TP=%.2f R:R=%.2f size=$%.0f",
                bf.direction, entry, sl, bf.orig_tp, rr, bf.orig_size_usd,
            )
            self._pending_bounce_fade = None
            return

        # Expiry: market fallback (if enabled) or abandon
        if datetime.now(timezone.utc) >= bf.expires_at:
            if bf.market_fallback:
                bf.decision_result.reasoning.append(
                    f"BounceFadeFallback: limite {bf.entry_limit:.0f} non raggiunto "
                    f"(max {bf.bounce_extreme:.0f}) → entry a mercato"
                )
                inf_id = getattr(bf.decision_result, "inference_id", None)
                await self._open_position(bf.decision_result, snap, _atr, inf_id)
                log.info(
                    "BounceFade fallback market entry: %s @ %.2f (limit %.2f never reached)",
                    bf.direction, price, bf.entry_limit,
                )
            else:
                log.info(
                    "BounceFade expired without fill (fallback off): %s limit=%.2f",
                    bf.direction, bf.entry_limit,
                )
            self._pending_bounce_fade = None

    async def _register_ob_limit_fill(
        self, pb: "PendingPullback", snap: dict, atr: Optional[float]
    ):
        """
        Called when a live GTC limit order was filled by HL. Registers the trade internally.
        SL is handled by apply_structural_sl() inside _open_position (OB-aware).
        """
        _atr = atr or snap["mark_price"] * 0.01
        _ob_sl_str = f"{pb.ob_sl_price:.2f}" if pb.ob_sl_price is not None else "atr_based"
        pb.decision_result.reasoning.append(
            f"PullbackEntry: ob_limit_filled | signal_close={pb.close_4h:.2f} "
            f"limit_px={pb.pullback_zone:.2f} ob_sl={_ob_sl_str} oid={pb.ob_order_id}"
        )
        inf_id = getattr(pb.decision_result, "inference_id", None)
        await self._open_position(pb.decision_result, snap, _atr, inf_id)
        self._pending_pullback = None

    async def _place_ob_limit_order(self, direction: str, limit_px: float, size: float) -> str:
        """Places a GTC limit order on HL. Returns the order ID. Raises on failure."""
        if not HL_AGENT_PRIVKEY:
            raise RuntimeError("HL_AGENT_PRIVATE_KEY not set — cannot place OB limit order")
        from hyperliquid.exchange import Exchange
        from hyperliquid.utils import constants
        import eth_account
        wallet   = eth_account.Account.from_key(HL_AGENT_PRIVKEY)
        endpoint = constants.TESTNET_API_URL if HL_TESTNET else constants.MAINNET_API_URL
        exchange = Exchange(wallet, endpoint, account_address=os.getenv("HL_WALLET_ADDRESS"))
        is_buy   = (direction == "long")
        result   = await asyncio.to_thread(
            exchange.order,
            SYMBOL, is_buy, size, round(limit_px, 1),
            {"limit": {"tif": "Gtc"}},
            False,  # reduce_only
        )
        oid = str(
            result.get("response", {}).get("data", {}).get("statuses", [{}])[0]
            .get("resting", {}).get("oid", "")
        )
        if not oid:
            raise RuntimeError(f"OB limit order returned no oid: {result}")
        return oid

    async def _cancel_ob_limit_order(self, oid: str):
        """Cancels a GTC limit order on HL. Non-fatal if already filled or not found."""
        try:
            if not HL_AGENT_PRIVKEY:
                return
            from hyperliquid.exchange import Exchange
            from hyperliquid.utils import constants
            import eth_account
            wallet   = eth_account.Account.from_key(HL_AGENT_PRIVKEY)
            endpoint = constants.TESTNET_API_URL if HL_TESTNET else constants.MAINNET_API_URL
            exchange = Exchange(wallet, endpoint, account_address=os.getenv("HL_WALLET_ADDRESS"))
            await asyncio.to_thread(exchange.cancel, SYMBOL, int(oid))
            log.info("OB GTC order cancelled: oid=%s", oid)
        except Exception as _e:
            log.warning("Cancel OB limit order oid=%s failed (may already be filled): %s", oid, _e)

    async def _get_ob_order_status(self, oid: str) -> str:
        """Returns 'filled', 'open', or 'cancelled' for a live GTC order."""
        try:
            wallet = os.getenv("HL_WALLET_ADDRESS", "")
            if not wallet:
                return "open"
            import httpx
            endpoint = (
                "https://api.hyperliquid-testnet.xyz/info"
                if HL_TESTNET else
                "https://api.hyperliquid.xyz/info"
            )
            async with httpx.AsyncClient(timeout=5.0) as client:
                resp = await client.post(
                    endpoint,
                    json={"type": "orderStatus", "user": wallet, "oid": int(oid)},
                )
                resp.raise_for_status()
                data = resp.json()
                # HL response: {"order": {"order": {...}, "status": "open"/"filled"/...}, "status": "order"}
                # The outer "status" is always "order" — the actual order status is nested inside
                order_status = (data.get("order") or {}).get("status", "open")
                if order_status == "filled":
                    return "filled"
                if order_status in ("cancelled", "rejected"):
                    return "cancelled"
                return "open"
        except Exception as _e:
            log.warning("OB order status fetch failed (assuming open): %s", _e)
            return "open"

    async def cancel_pending_pullback(self) -> dict:
        """Cancel the active pending pullback signal (also cancels live GTC order if present)."""
        if self._pending_pullback is None:
            return {"cancelled": False, "reason": "no_pending_pullback"}
        pb = self._pending_pullback
        if pb.ob_order_id is not None and self.mode == "live":
            await self._cancel_ob_limit_order(pb.ob_order_id)
        self._pending_pullback = None
        log.info("Pending pullback cancelled manually (dir=%s)", pb.direction)
        return {"cancelled": True, "direction": pb.direction}

    # ── Live order submission (Hyperliquid SDK) ───────────────────────────────

    async def _submit_open_order(
        self, side: str, size: float, mark_price: float, stop_loss: float,
        inference_id: Optional[str] = None,
        take_profit: Optional[float] = None,
        partial_tp_price: Optional[float] = None,
        partial_tp_pct: float = 50.0,
    ) -> Optional[str]:
        """
        Submit a market-like IOC entry + native SL + native TP trigger orders via HL SDK.
        If partial_tp_price is provided, also places a partial TP trigger for partial_tp_pct%
        of the position, and sizes the main TP to the remaining contracts.
        Uses HL_AGENT_PRIVATE_KEY env var.
        Returns the HL order ID string, or None on failure.
        """
        if not HL_AGENT_PRIVKEY:
            log.error("HL_AGENT_PRIVATE_KEY not set — cannot submit live order")
            return None

        try:
            from hyperliquid.exchange import Exchange
            from hyperliquid.utils import constants
            import eth_account

            wallet   = eth_account.Account.from_key(HL_AGENT_PRIVKEY)
            endpoint = constants.TESTNET_API_URL if HL_TESTNET else constants.MAINNET_API_URL
            exchange = Exchange(wallet, endpoint, account_address=os.getenv("HL_WALLET_ADDRESS"))

            # Derive deterministic cloid from inference_id for deduplication
            # HL expects a 16-byte hex string prefixed with "0x"
            import hashlib
            _seed = (inference_id or str(uuid.uuid4())).encode()
            cloid = "0x" + hashlib.md5(_seed).hexdigest()  # 16 bytes = 32 hex chars

            is_buy  = (side == "long")
            # IOC at 50bps slippage for market-like fill
            slip_px = mark_price * (1.005 if is_buy else 0.995)
            slip_px = round(slip_px, 1)

            result = await asyncio.to_thread(
                exchange.order,
                SYMBOL, is_buy, size, slip_px,
                {"limit": {"tif": "Ioc"}},
                False,   # reduce_only
                cloid,   # client order ID for deduplication
            )
            log.info("Live entry order submitted: %s", result)

            # Extract actual filled size — IOC orders may fill partially
            try:
                status_0 = result.get("response", {}).get("data", {}).get("statuses", [{}])[0]
                filled_info = status_0.get("filled", {})
                filled_sz = float(filled_info.get("totalSz", 0)) if filled_info else 0.0
            except (ValueError, TypeError, IndexError):
                filled_sz = 0.0

            if filled_sz <= 0:
                log.warning("Live entry IOC: zero fill — aborting position open")
                return None

            if abs(filled_sz - size) > 1e-6:
                log.warning("Live entry IOC partial fill: requested %.4f, filled %.4f — SL sized to fill", size, filled_sz)
                size = filled_sz

            close_is_buy = not is_buy  # closing direction (opposite of entry)

            # ── Native SL trigger order ───────────────────────────────────────
            _sl_seed = (_seed + b"_sl")
            sl_cloid = "0x" + hashlib.md5(_sl_seed).hexdigest()
            sl_result = await asyncio.to_thread(
                exchange.order,
                SYMBOL, close_is_buy, size, stop_loss,
                {"trigger": {"triggerPx": round(stop_loss, 1), "isMarket": True, "tpsl": "sl"}},
                True,    # reduce_only
                sl_cloid,
            )
            log.info("Native SL order submitted: %s", sl_result)

            # ── Native TP trigger orders ──────────────────────────────────────
            if take_profit and take_profit > 0:
                frac         = partial_tp_pct / 100.0
                partial_sz   = round(size * frac, 4)        if partial_tp_price else 0.0
                main_tp_sz   = round(size * (1.0 - frac), 4) if partial_tp_price else size

                # Partial TP trigger (fires first — closes partial_tp_pct% of position)
                if partial_tp_price and partial_sz >= 0.001:
                    _ptp_seed = (_seed + b"_ptp")
                    ptp_cloid = "0x" + hashlib.md5(_ptp_seed).hexdigest()
                    ptp_result = await asyncio.to_thread(
                        exchange.order,
                        SYMBOL, close_is_buy, partial_sz, partial_tp_price,
                        {"trigger": {"triggerPx": round(partial_tp_price, 1), "isMarket": True, "tpsl": "tp"}},
                        True,   # reduce_only
                        ptp_cloid,
                    )
                    log.info("Native partial-TP order (%.0f%% @ %.2f) submitted: %s",
                             partial_tp_pct, partial_tp_price, ptp_result)

                # Main TP trigger (remaining size after partial TP, or full size)
                if main_tp_sz >= 0.001:
                    _tp_seed = (_seed + b"_tp")
                    tp_cloid = "0x" + hashlib.md5(_tp_seed).hexdigest()
                    tp_result = await asyncio.to_thread(
                        exchange.order,
                        SYMBOL, close_is_buy, main_tp_sz, take_profit,
                        {"trigger": {"triggerPx": round(take_profit, 1), "isMarket": True, "tpsl": "tp"}},
                        True,   # reduce_only
                        tp_cloid,
                    )
                    log.info("Native TP order (%.4f BTC @ %.2f) submitted: %s",
                             main_tp_sz, take_profit, tp_result)

            oid = str(result.get("response", {}).get("data", {}).get("statuses", [{}])[0].get("resting", {}).get("oid", ""))
            return oid or None

        except Exception as exc:
            log.error("Live open order failed: %s", exc, exc_info=True)
            return None

    async def _submit_partial_close(self, partial_contracts: float, price: float, side: str):
        """Submit a reduce-only IOC order to close partial_contracts of the position."""
        if not HL_AGENT_PRIVKEY:
            return
        try:
            from hyperliquid.exchange import Exchange
            from hyperliquid.utils import constants
            import eth_account

            wallet    = eth_account.Account.from_key(HL_AGENT_PRIVKEY)
            endpoint  = constants.TESTNET_API_URL if HL_TESTNET else constants.MAINNET_API_URL
            exchange  = Exchange(wallet, endpoint, account_address=os.getenv("HL_WALLET_ADDRESS"))
            is_buy    = (side == "short")  # closing long = sell, closing short = buy
            close_px  = round(price * (1.005 if is_buy else 0.995), 1)
            size      = max(round(partial_contracts, 4), 0.001)

            result = await asyncio.to_thread(
                exchange.order,
                SYMBOL, is_buy, size, close_px,
                {"limit": {"tif": "Ioc"}},
                True,  # reduce_only
            )
            log.info("Partial TP close order submitted: %s", result)
        except Exception as exc:
            log.error("Partial TP close order failed: %s", exc, exc_info=True)

    async def _update_sl_trigger(
        self, inference_id: Optional[str], side: str, remaining_sz: float, new_sl: float,
        old_cloid: Optional[str] = None,
    ) -> Optional[str]:
        """
        Cancel the current SL trigger and place a new one at new_sl.
        Returns the new cloid, or None on failure.
        Used when: partial TP fires (move SL to BE) and trailing SL moves the stop.
        old_cloid: the cloid to cancel; if None, derives it from inference_id + "_sl".
        """
        if not HL_AGENT_PRIVKEY:
            return None
        try:
            import hashlib
            from hyperliquid.exchange import Exchange
            from hyperliquid.utils import constants
            import eth_account

            wallet   = eth_account.Account.from_key(HL_AGENT_PRIVKEY)
            endpoint = constants.TESTNET_API_URL if HL_TESTNET else constants.MAINNET_API_URL
            exchange = Exchange(wallet, endpoint, account_address=os.getenv("HL_WALLET_ADDRESS"))

            # Cancel old SL (ignore errors — it may already be filled/canceled)
            if old_cloid:
                try:
                    cancel_res = await asyncio.to_thread(
                        exchange.cancel_by_cloid, SYMBOL, old_cloid,
                    )
                    log.info("Old SL trigger canceled: %s", cancel_res)
                except Exception as _ce:
                    log.warning("Cancel old SL failed (may be already gone): %s", _ce)

            # Place new SL trigger for remaining size
            close_is_buy = (side == "short")
            new_cloid = "0x" + hashlib.md5(
                (old_cloid or "").encode() + str(new_sl).encode()
            ).hexdigest()
            sl_result = await asyncio.to_thread(
                exchange.order,
                SYMBOL, close_is_buy, remaining_sz, new_sl,
                {"trigger": {"triggerPx": round(new_sl, 1), "isMarket": True, "tpsl": "sl"}},
                True,   # reduce_only
                new_cloid,
            )
            log.info("New SL trigger placed @ %.2f for %.4f BTC: %s", new_sl, remaining_sz, sl_result)
            return new_cloid

        except Exception as exc:
            log.error("_update_sl_trigger failed: %s", exc, exc_info=True)
            return None

    async def _submit_close_order(self):
        """Submit a market close order for the current position."""
        if not self._position or not HL_AGENT_PRIVKEY:
            return

        try:
            from hyperliquid.exchange import Exchange
            from hyperliquid.utils import constants
            import eth_account

            wallet   = eth_account.Account.from_key(HL_AGENT_PRIVKEY)
            endpoint = constants.TESTNET_API_URL if HL_TESTNET else constants.MAINNET_API_URL
            exchange = Exchange(wallet, endpoint, account_address=os.getenv("HL_WALLET_ADDRESS"))

            side     = self._position["side"]
            size     = self._position["size_contracts"]
            snap     = await self._hl.get_market_snapshot(SYMBOL)
            price    = snap["mark_price"]
            is_buy   = (side == "short")  # closing: opposite of position side
            close_px = round(price * (1.005 if is_buy else 0.995), 1)

            result = await asyncio.to_thread(
                exchange.order,
                SYMBOL, is_buy, size, close_px,
                {"limit": {"tif": "Ioc"}},
                True,    # reduce_only = True for close
            )
            log.info("Live close order submitted: %s", result)

        except Exception as exc:
            log.error("Live close order failed: %s", exc, exc_info=True)

    # ── Inference logging ─────────────────────────────────────────────────────

    @staticmethod
    def _safe_float(v):
        """Convert to float, returning None for NaN/Inf/None/non-numeric (not JSON-safe or DB-safe)."""
        if v is None:
            return None
        if hasattr(v, "__float__"):
            f = float(v)
            return None if (math.isnan(f) or math.isinf(f)) else f
        log.warning("_safe_float: non-numeric value dropped: %r (%s)", v, type(v).__name__)
        return None

    async def _log_inference(
        self,
        inference_id: str,
        features: dict,
        c2: dict,
        lgbm_prob: float,
        result: DecisionResult,
        covars: dict,
    ) -> Optional[str]:
        """Write inference log. Returns inference_id on success, None on failure."""
        try:
            safe_lgbm = self._safe_float(lgbm_prob)
            db = get_supabase()
            db.table("inference_logs").insert({
                "id":              inference_id,
                "bot_id":          None,
                "model":           "chronos2_lgbm_ensemble_v2",
                # Top-level probability columns — used by IsotonicCalibrator join
                "c2_dir_prob":     self._safe_float(c2.get("c2_dir_prob")),
                "c2_dir_prob_raw": self._safe_float(c2.get("c2_dir_prob_raw")),
                "c2_uncertainty":  self._safe_float(c2.get("c2_uncertainty")),
                "c2_cont_prob":    self._safe_float(c2.get("c2_cont_prob")),
                "features": {
                    k: self._safe_float(v)
                    for k, v in {**features, **covars}.items()
                },
                "forecast": {
                    **{k: (self._safe_float(v) if isinstance(v, float) else v)
                       for k, v in c2.items()},
                    "lgbm_prob": safe_lgbm,
                },
                "decision":   result.action,
                "reasoning":  result.reasoning,
                "latency_ms": c2.get("latency_ms", 0),
            }).execute()
            return inference_id
        except Exception as exc:
            log.warning("Inference log write failed: %s", exc)
            return None

    # ── Helpers ───────────────────────────────────────────────────────────────

    def _build_risk_manager(self) -> RiskManager:
        return RiskManager(
            sl_atr_mult=self.config.sl_atr_mult,
            tp_atr_mult=self.config.tp_atr_mult,
            position_size_pct=self.config.position_size_pct,
            max_daily_dd_pct=self.config.max_daily_dd_pct,
            max_consecutive_losses=self.config.max_consecutive_losses,
        )

    async def _log_regime(self, signal: RegimeSignal):
        """Persist regime snapshot to regime_log table (best-effort; table may not exist)."""
        try:
            db = get_supabase()
            db.table("regime_log").insert({
                "regime":          signal.regime,
                "confidence":      signal.confidence,
                "adx":             signal.adx,
                "atr_pct":         signal.atr_percentile,
                "slope_pct":       signal.trend_slope_pct,
                "bars_in_regime":  signal.bars_in_regime,
                "transition_risk": signal.transition_risk,
                "profile_applied": None,
            }).execute()
        except Exception as exc:
            log.debug("regime_log write skipped (table may not exist yet): %s", exc)

    async def _sleep_until_next_candle(self):
        """Fallback: sleep until next 4h UTC candle close."""
        import time as _time
        now_ms    = _time.time() * 1000
        next_ms   = ((now_ms // CANDLE_MS) + 1) * CANDLE_MS + 5_000  # +5s buffer
        wait_s    = (next_ms - now_ms) / 1000
        log.info("Fallback sleep %.1f min until next candle", wait_s / 60)
        await asyncio.sleep(max(wait_s, 1))


# ── Utility ───────────────────────────────────────────────────────────────────

def _make_liq_df(ws_snap: dict) -> pd.DataFrame:
    """
    Convert WS-accumulated liquidation totals into a single-row DataFrame
    compatible with build_all_features() liq input signature.
    """
    now = datetime.now(timezone.utc)
    return pd.DataFrame([{
        "time":         now,
        "liq_long_usd": ws_snap.get("ws_liq_long_usd", 0.0),
        "liq_short_usd": ws_snap.get("ws_liq_short_usd", 0.0),
    }]).set_index("time")
