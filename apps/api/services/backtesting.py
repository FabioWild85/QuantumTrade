"""
Backtesting engine — Settimana 3.
Runs the full 64-feature pipeline + LightGBM decision loop on historical data.
Chronos-2 is skipped for speed (uses neutral 0.5 prior); the ensemble still applies.
Fees: HL taker 0.035% per side, funding accrued every 2 candles (8h cycle).
"""

import logging
import math
import threading
from datetime import datetime, timezone
from typing import Optional

import numpy as np
import pandas as pd

from services.hyperliquid_data import HyperliquidData
from services.smc import build_all_features
from services.decision import DecisionEngine, DecisionResult, compute_qt_score
from services.risk import RiskManager, apply_structural_sl, apply_fvg_sl, apply_swing_sl
from services.trainer import load_correct_model

log = logging.getLogger(__name__)

HL_TAKER_FEE = 0.00035   # 0.035% per trade side
FUNDING_INTERVAL_BARS = 2  # funding paid every 2×4h bars (8h cycle)


async def run_backtest(req, cancel_event: Optional[threading.Event] = None) -> dict:
    """
    Main entry point, called from FastAPI /backtest endpoint.
    req: BacktestRequest with symbol, from_date, to_date, initial_capital, config.
    """
    symbol  = req.symbol
    capital = float(req.initial_capital)
    cfg     = req.config

    # Strategy parameters
    sl_atr_mult   = cfg.sl_atr_mult            if cfg else 2.0
    tp_atr_mult   = cfg.tp_atr_mult            if cfg else 3.5
    pos_size_pct  = cfg.position_size_pct      if cfg else 1.5
    dir_threshold = cfg.directional_threshold  if cfg else 0.62
    adx_gate      = cfg.adx_gate               if cfg else 20.0
    # Advanced exit strategy flags
    partial_tp_enabled       = getattr(cfg, "partial_tp_enabled",       False)
    partial_tp_atr_mult      = getattr(cfg, "partial_tp_atr_mult",      1.5)
    partial_tp_pct           = getattr(cfg, "partial_tp_pct",           50.0)
    trailing_sl_enabled      = getattr(cfg, "trailing_sl_enabled",      False)
    trailing_sl_activation   = getattr(cfg, "trailing_sl_activation",   1.5)
    lgbm_exit_enabled        = getattr(cfg, "lgbm_exit_enabled",        False)
    lgbm_exit_threshold      = getattr(cfg, "lgbm_exit_threshold",      0.30)
    lgbm_exit_min_hold_bars  = getattr(cfg, "lgbm_exit_min_hold_bars",  6)
    lgbm_exit_confirm_bars   = getattr(cfg, "lgbm_exit_confirm_bars",   2)
    enhanced_exit_enabled    = getattr(cfg, "enhanced_exit_enabled",    False)
    use_binance              = getattr(req,  "use_binance",              True)
    use_chronos              = getattr(req,  "use_chronos",              False)
    # Advanced signal controls
    confluence_gate        = getattr(cfg, "confluence_gate",        60.0)
    adx_gate_enabled       = getattr(cfg, "adx_gate_enabled",       True)
    sweep_gate_enabled         = getattr(cfg, "sweep_gate_enabled",         True)
    sweep_gate_directional     = getattr(cfg, "sweep_gate_directional",     False)
    fvg_filter_enabled     = getattr(cfg, "fvg_filter_enabled",     True)
    mtf_alignment_enabled  = getattr(cfg, "mtf_alignment_enabled",  True)
    chronos_weight         = getattr(cfg, "chronos_weight",         0.40)
    # Advanced position management
    be_sl_enabled          = getattr(cfg, "be_sl_enabled",          False)
    be_sl_activation       = getattr(cfg, "be_sl_activation",       1.0)
    max_hold_bars_enabled  = getattr(cfg, "max_hold_bars_enabled",  False)
    max_hold_bars_val      = getattr(cfg, "max_hold_bars",          48)
    # Chronos-2 adaptive features
    c2_uncertainty_gate_enabled = getattr(cfg, "c2_uncertainty_gate_enabled", False)
    c2_uncertainty_threshold    = getattr(cfg, "c2_uncertainty_threshold",    0.05)
    c2_cont_prob_gate_enabled   = getattr(cfg, "c2_cont_prob_gate_enabled",   False)
    c2_cont_prob_threshold      = getattr(cfg, "c2_cont_prob_threshold",      0.25)
    dynamic_sl_tp_enabled               = getattr(cfg, "dynamic_sl_tp_enabled",               False)
    dynamic_sl_tp_blend                 = getattr(cfg, "dynamic_sl_tp_blend",                 0.50)
    recalibrated_uncertainty_thresholds = getattr(cfg, "recalibrated_uncertainty_thresholds", True)
    p10_sl_floor_enabled                = getattr(cfg, "p10_sl_floor_enabled",                False)
    # Regime Bias
    regime_bias_enabled     = getattr(cfg, "regime_bias_enabled",     False)
    regime_bias_delta       = getattr(cfg, "regime_bias_delta",       0.08)
    regime_bias_size_factor = getattr(cfg, "regime_bias_size_factor", 1.0)
    forced_regime           = getattr(cfg, "forced_regime",           "auto")
    regime_bias_enhanced    = getattr(cfg, "regime_bias_enhanced",    False)
    # CVD Absorption Filter
    absorption_filter_enabled = getattr(cfg, "absorption_filter_enabled", False)
    absorption_z_threshold    = getattr(cfg, "absorption_z_threshold",    2.0)
    # Binance Cross-Exchange CVD
    binance_cvd_enabled       = getattr(cfg, "binance_cvd_enabled",       False)
    # Signal quality filters
    exhaustion_guard_enabled  = getattr(cfg, "exhaustion_guard_enabled",  True)
    structural_sl_enabled     = getattr(cfg, "structural_sl_enabled",     True)
    ob_buffer_pct             = getattr(cfg, "ob_buffer_pct",             0.3)
    ob_buffer_min_atr         = getattr(cfg, "ob_buffer_min_atr",         0.0)
    ob_tp_enabled             = getattr(cfg, "ob_tp_enabled",             False)
    ob_tp_blend               = getattr(cfg, "ob_tp_blend",               1.0)
    fvg_sl_enabled            = getattr(cfg, "fvg_sl_enabled",            False)
    fvg_tp_enabled            = getattr(cfg, "fvg_tp_enabled",            False)
    fvg_tp_blend              = getattr(cfg, "fvg_tp_blend",              1.0)
    swing_sl_enabled          = getattr(cfg, "swing_sl_enabled",          False)
    swing_tp_enabled          = getattr(cfg, "swing_tp_enabled",          False)
    swing_tp_blend            = getattr(cfg, "swing_tp_blend",            1.0)
    # Dual ATR for SL
    dual_atr_enabled          = getattr(cfg, "dual_atr_enabled",          False)
    # Late Entry Distance Filter
    late_entry_filter_enabled = getattr(cfg, "late_entry_filter_enabled", False)
    late_entry_max_ob_dist    = getattr(cfg, "late_entry_max_ob_dist",    3.0)
    # Path Obstruction Gate
    path_obstruction_enabled  = getattr(cfg, "path_obstruction_enabled",  False)
    path_obstruction_max_dist = getattr(cfg, "path_obstruction_max_dist", 1.5)
    consec_bars_filter_enabled = getattr(cfg, "consec_bars_filter_enabled", False)
    consec_bars_max_long       = getattr(cfg, "consec_bars_max_long",       8)
    consec_bars_max_short      = getattr(cfg, "consec_bars_max_short",      8)
    # Funding Rate Bias
    funding_gate_enabled  = getattr(cfg, "funding_gate_enabled",  False)
    funding_gate_lookback = getattr(cfg, "funding_gate_lookback", 6)
    funding_high_thr      = getattr(cfg, "funding_high_thr",      0.00010)
    funding_extreme_thr   = getattr(cfg, "funding_extreme_thr",   0.00030)
    funding_bias_delta    = getattr(cfg, "funding_bias_delta",    0.03)
    # Fear & Greed Bias
    fng_gate_enabled      = getattr(cfg, "fng_gate_enabled",      False)
    # Exhaustion Guard thresholds
    exhaustion_rsi_low    = getattr(cfg, "exhaustion_rsi_low",    28.0)
    exhaustion_rsi_high   = getattr(cfg, "exhaustion_rsi_high",   72.0)
    exhaustion_ret48_pct  = getattr(cfg, "exhaustion_ret48_pct",   6.0)
    exhaustion_boost      = getattr(cfg, "exhaustion_boost",       0.06)
    # Pullback Entry
    pullback_entry_enabled    = getattr(cfg, "pullback_entry_enabled",    False)
    pullback_impulse_atr_mult = getattr(cfg, "pullback_impulse_atr_mult", 1.5)
    pullback_zone_atr         = getattr(cfg, "pullback_zone_atr",         0.3)
    pullback_window_h         = getattr(cfg, "pullback_window_h",         3)
    pullback_fallback_atr     = getattr(cfg, "pullback_fallback_atr",     0.5)
    # Reversal Zone Detector
    reversal_mode_enabled        = getattr(cfg, "reversal_mode_enabled",        False)
    # Fallbacks MUST match the BotConfig pydantic defaults (apps/api/main.py).
    # The old 0.72 fallback was above the empirical max reversal score (~0.52),
    # so any cfg missing this attr made reversals mathematically impossible.
    reversal_score_threshold     = getattr(cfg, "reversal_score_threshold",     0.34)
    reversal_min_components      = getattr(cfg, "reversal_min_components",      3)
    reversal_size_factor         = getattr(cfg, "reversal_size_factor",         0.50)
    reversal_sl_atr_mult         = getattr(cfg, "reversal_sl_atr_mult",         1.2)
    reversal_tp_atr_mult         = getattr(cfg, "reversal_tp_atr_mult",         2.0)
    reversal_rr_min              = getattr(cfg, "reversal_rr_min",              1.5)
    reversal_conflict_block      = getattr(cfg, "reversal_conflict_block",      True)
    reversal_trend_hold_only     = getattr(cfg, "reversal_trend_hold_only",     True)
    reversal_max_hold_bars_val   = getattr(cfg, "reversal_max_hold_bars",       4)
    reversal_entry_mode          = getattr(cfg, "reversal_entry_mode",          "limit_retest")
    reversal_retest_wick_pct     = getattr(cfg, "reversal_retest_wick_pct",     0.25)
    reversal_retest_expiry_bars  = getattr(cfg, "reversal_retest_expiry_bars",  3)
    fng_extreme_fear_thr  = getattr(cfg, "fng_extreme_fear_thr",  20.0)
    fng_fear_thr          = getattr(cfg, "fng_fear_thr",          35.0)
    fng_greed_thr         = getattr(cfg, "fng_greed_thr",         65.0)
    fng_extreme_greed_thr = getattr(cfg, "fng_extreme_greed_thr", 80.0)
    fng_bias_delta        = getattr(cfg, "fng_bias_delta",        0.03)

    hl = HyperliquidData()

    # ── 1. Fetch OHLCV ───────────────────────────────────────────────────────
    from datetime import datetime
    dt_from = datetime.strptime(req.from_date, "%Y-%m-%d").replace(tzinfo=timezone.utc)
    dt_to   = datetime.strptime(req.to_date,   "%Y-%m-%d").replace(tzinfo=timezone.utc)
    days    = (dt_to - dt_from).days + 1
    limit   = days * 6 + 200

    # Use Binance for periods older than ~11 months (HL data limit)
    from datetime import timedelta
    hl_cutoff = datetime.now(timezone.utc) - timedelta(days=330)
    if use_binance and dt_from < hl_cutoff:
        from services.binance_data import get_ohlcv_binance
        df_ohlcv = await get_ohlcv_binance(symbol, "4h", start_date=req.from_date, end_date=req.to_date)
        log.info("Using Binance OHLCV: %d candles", len(df_ohlcv))
    else:
        df_ohlcv = await hl.get_ohlcv(symbol, "4h", limit=limit, end_time=dt_to)
        df_ohlcv = df_ohlcv[df_ohlcv.index >= dt_from]

    if len(df_ohlcv) < 100:
        return {"error": f"Dati insufficienti per il periodo {req.from_date}→{req.to_date}"}

    df_fund = await hl.get_funding_history(symbol, hours=min(days * 24 + 200, 8760))

    # Try to enrich with real OI + liquidation data from Coinglass/Coinalyze
    try:
        from services.external_data import get_best_oi, get_best_liquidations
        df_oi  = await get_best_oi(symbol, start_date=req.from_date, end_date=req.to_date)
        df_liq = await get_best_liquidations(symbol, start_date=req.from_date, end_date=req.to_date)
        if not df_oi.empty:
            log.info("External OI data: %d rows", len(df_oi))
        if not df_liq.empty:
            log.info("External liquidation data: %d rows", len(df_liq))
    except Exception as e:
        log.warning("External data fetch failed (non-blocking): %s", e)
        df_oi  = pd.DataFrame()
        df_liq = pd.DataFrame()

    # ── 1b. Historical Fear & Greed (fetched once, cached in-process) ────────
    fng_history: dict[str, float] = {}
    if fng_gate_enabled:
        try:
            from services.covariates import fetch_historical_fng
            fng_history = await fetch_historical_fng()
            if not fng_history:
                log.warning("Historical F&G fetch returned empty — F&G gate disabled for this backtest")
                fng_gate_enabled = False
        except Exception as _fng_e:
            log.warning("Historical F&G fetch failed — F&G gate disabled for this backtest: %s", _fng_e)
            fng_gate_enabled = False

    # ── 1c. Binance cross-exchange CVD data ──────────────────────────────────
    # When use_binance=True, df_ohlcv already comes from Binance and has taker_buy_vol.
    # When use_binance=False (HL data), fetch Binance separately for the same period.
    df_binance = None
    if binance_cvd_enabled:
        if use_binance and "taker_buy_vol" in df_ohlcv.columns:
            df_binance = df_ohlcv   # already the Binance df with taker_buy_vol
        else:
            try:
                from services.binance_data import get_ohlcv_binance
                df_binance = await get_ohlcv_binance(
                    symbol, "4h", start_date=req.from_date, end_date=req.to_date
                )
                log.info("Binance CVD data for backtest: %d candles", len(df_binance))
            except Exception as _bnc_err:
                log.warning("Binance CVD fetch for backtest failed (non-blocking): %s", _bnc_err)

    # ── 2. Build features ────────────────────────────────────────────────────
    df_feat = build_all_features(
        df_ohlcv, df_fund, df_oi, df_liq,
        df_binance=df_binance,
        binance_cvd_enabled=binance_cvd_enabled,
        reversal_mode_enabled=reversal_mode_enabled,
    )

    # ── 2b. Validate F&G date format against the actual feature index ────────
    if fng_gate_enabled and fng_history:
        _sample_idx = min(64, len(df_feat) - 1)
        _sample_date = str(df_feat.index[_sample_idx].date()) if hasattr(df_feat.index[_sample_idx], "date") else ""
        if _sample_date and _sample_date not in fng_history:
            _first_key = next(iter(fng_history), "N/A")
            log.warning(
                "F&G date format mismatch — bar_date=%s not found in fng_history "
                "(first history key=%s). F&G gate will fall back to neutral 50 on every bar.",
                _sample_date, _first_key,
            )
        else:
            log.info("F&G history loaded: %d days, date format OK (sample=%s)", len(fng_history), _sample_date)

    # ── 3. Load LightGBM model ───────────────────────────────────────────────
    _use_pruning = getattr(cfg, "use_feature_pruning", False)
    model_result = load_correct_model(_use_pruning)
    if model_result is None:
        return {"error": "Nessun modello LightGBM trovato. Avvia il bot almeno una volta o esegui POST /retrain."}
    lgbm_model, lgbm_features = model_result

    # ── 4. Build feature matrix for all candles ──────────────────────────────
    # reindex garantisce esattamente le feature su cui il modello è stato trainato.
    # Feature mancanti (es. CVD Binance quando toggle è off) vengono riempite con 0.
    X_all = df_feat.reindex(columns=lgbm_features, fill_value=0).fillna(0)

    # ── 5. Run decision loop ─────────────────────────────────────────────────
    decision_engine = DecisionEngine(
        directional_threshold=dir_threshold,
        adx_gate=adx_gate,
        confluence_gate=confluence_gate,
        adx_gate_enabled=adx_gate_enabled,
        sweep_gate_enabled=sweep_gate_enabled,
        sweep_gate_directional=sweep_gate_directional,
        fvg_filter_enabled=fvg_filter_enabled,
        mtf_alignment_enabled=mtf_alignment_enabled,
        chronos_weight=chronos_weight if use_chronos else 0.0,
        c2_uncertainty_gate_enabled=c2_uncertainty_gate_enabled if use_chronos else False,
        c2_uncertainty_threshold=c2_uncertainty_threshold,
        c2_cont_prob_gate_enabled=c2_cont_prob_gate_enabled if use_chronos else False,
        c2_cont_prob_threshold=c2_cont_prob_threshold,
        regime_bias_enabled=regime_bias_enabled,
        regime_bias_delta=regime_bias_delta,
        regime_bias_size_factor=regime_bias_size_factor,
        forced_regime=forced_regime,
        regime_bias_enhanced=regime_bias_enhanced,
        absorption_filter_enabled=absorption_filter_enabled,
        absorption_z_threshold=absorption_z_threshold,
        exhaustion_guard_enabled=exhaustion_guard_enabled,
        late_entry_filter_enabled=late_entry_filter_enabled,
        late_entry_max_ob_dist=late_entry_max_ob_dist,
        path_obstruction_enabled=path_obstruction_enabled,
        path_obstruction_max_dist=path_obstruction_max_dist,
        consec_bars_filter_enabled=consec_bars_filter_enabled,
        consec_bars_max_long=consec_bars_max_long,
        consec_bars_max_short=consec_bars_max_short,
        funding_gate_enabled=funding_gate_enabled,
        funding_gate_lookback=funding_gate_lookback,
        funding_high_thr=funding_high_thr,
        funding_extreme_thr=funding_extreme_thr,
        funding_bias_delta=funding_bias_delta,
        fng_gate_enabled=fng_gate_enabled,
        fng_extreme_fear_thr=fng_extreme_fear_thr,
        fng_fear_thr=fng_fear_thr,
        fng_greed_thr=fng_greed_thr,
        fng_extreme_greed_thr=fng_extreme_greed_thr,
        fng_bias_delta=fng_bias_delta,
        # Exhaustion Guard thresholds
        exhaustion_rsi_low=exhaustion_rsi_low,
        exhaustion_rsi_high=exhaustion_rsi_high,
        exhaustion_ret48_pct=exhaustion_ret48_pct,
        exhaustion_boost=exhaustion_boost,
    )
    risk = RiskManager(
        sl_atr_mult=sl_atr_mult,
        tp_atr_mult=tp_atr_mult,
        position_size_pct=pos_size_pct,
    )

    # Chronos-2: load once and reuse across all candles (slow on CPU, ~3s/candle)
    chronos_forecaster = None
    if use_chronos:
        from services.chronos_model import ChronosForecaster
        chronos_forecaster = ChronosForecaster()
        log.info("Chronos-2 ENABLED for backtest — ~%ds expected", len(df_feat) * 3)
    else:
        log.info("Chronos-2 disabled — using corrected neutral prior (p10=p50=p90=price)")

    equity        = capital
    position      = None   # {side, entry, sl, tp, size_usd, bar_idx, partial_done, entry_atr}
    pending_pb    = None   # pending pullback dict when pullback_entry_enabled
    pending_rev   = None   # pending reversal dict when reversal_entry_mode == "limit_retest"
    trades        = []
    equity_curve  = [{"bar": 0, "equity": equity}]
    funding_col   = "funding" in df_feat.columns

    # Reversal detector — instantiated once, reused across all bars
    _bt_rev_detector = None
    if reversal_mode_enabled:
        from services.reversal_detector import ReversalZoneDetector, build_pending_reversal
        _bt_rev_detector = ReversalZoneDetector()

    # ── Parameter activity counters ───────────────────────────────────────────
    param_stats: dict = {
        # Signal volume
        "bars_evaluated":           0,
        "signals_long":             0,
        "signals_short":            0,
        "no_trade":                 0,
        # Hard gates (blocked a potential trade entirely)
        "gate_adx":                 0,
        "gate_sweep":               0,
        "gate_confluence":          0,
        "gate_c2_uncertainty":      0,
        "gate_c2_cont":             0,
        "gate_fvg_long":            0,
        "gate_fvg_short":           0,
        "gate_late_entry":          0,
        "gate_path_obstruction":    0,
        "gate_consec_bars":         0,
        # Bias / threshold modifiers
        "mod_mtf_alignment":        0,
        "mod_regime_bias":          0,
        "mod_counter_trend_size":   0,
        "mod_funding_bias":         0,
        "mod_fng_bias":             0,
        "mod_iv_size_reduction":    0,
        "mod_exhaustion_guard":     0,
        "mod_absorption_filter":    0,
        "mod_sweep_conf_bonus":     0,
        # Entry — structural SL/TP overrides
        "sl_structural_ob":         0,
        "sl_fvg":                   0,
        "sl_swing":                 0,
        "tp_ob":                    0,
        # Position management
        "pm_trailing_sl":           0,
        "pm_be_sl":                 0,
        "pm_partial_tp":            0,
        "pm_lgbm_exit":             0,
        "pm_max_hold":              0,
        # Trade exit reasons
        "exit_stop_loss":           0,
        "exit_take_profit":         0,
        "exit_end_of_period":       0,
        # Pullback entry
        "pb_activated":             0,
        "pb_filled_zone":           0,
        "pb_filled_fallback":       0,
        "pb_decayed":               0,
        # Reversal Zone Detector
        "rev_signals":              0,
        "rev_pending_set":          0,
        "rev_pending_triggered":    0,
        "rev_pending_expired":      0,
        "rev_conflict_block":       0,
        "rev_trend_boost":          0,
    }

    # Enhanced regime detection — mirrors live behavior (every 4 bars, cached between).
    # Instantiated once before the loop; detect() called on the growing slice df_feat[:i+1].
    # Requires at least 120 bars of history before first call.
    _bt_regime_detector = None
    _bt_regime_sig      = None
    if regime_bias_enhanced and forced_regime == "auto":
        from services.regime_detector import RegimeDetector as _RegimeDetector
        _bt_regime_detector = _RegimeDetector()

    for i in range(len(df_feat)):
        if cancel_event and cancel_event.is_set():
            raise RuntimeError("backtest_cancelled")
        row = df_feat.iloc[i]
        features = row.to_dict()

        # ── Pending reversal: check limit-retest fill/expiry ────────────────────
        if pending_rev is not None and position is None:
            _bar_high = float(row.get("high", row["close"]))
            _bar_low  = float(row.get("low",  row["close"]))
            _rp       = pending_rev
            if i >= _rp["expiry_bar"]:
                param_stats["rev_pending_expired"] += 1
                pending_rev = None
            else:
                _rev_triggered = (
                    (_rp["direction"] == "long"  and _bar_low  <= _rp["entry_limit"]) or
                    (_rp["direction"] == "short" and _bar_high >= _rp["entry_limit"])
                )
                if _rev_triggered:
                    param_stats["rev_pending_triggered"] += 1
                    _rev_entry_px = _rp["entry_limit"]
                    _rev_size_usd = _rp["size_usd"]
                    fee_entry_rev = _rev_size_usd * HL_TAKER_FEE
                    equity -= fee_entry_rev
                    position = {
                        "side":               _rp["direction"],
                        "entry":              _rev_entry_px,
                        "sl":                 _rp["sl"],
                        "tp":                 _rp["tp"],
                        "size_usd":           _rev_size_usd,
                        "bar_idx":            i,
                        "entry_atr":          _rp["atr_at_signal"],
                        "partial_done":       False,
                        "sl_trailing_active": False,
                        "high_water":         _rev_entry_px,
                        "be_sl_applied":      False,
                        "lgbm_strikes":       0,
                        "fee_entry":          fee_entry_rev,
                        "funding_paid":       0.0,
                        "entry_mode":         "reversal_retest",
                        "origin":             "reversal",
                        "is_reversal":        True,
                        "rev_sl_atr_mult":    reversal_sl_atr_mult,
                        "rev_max_hold":       reversal_max_hold_bars_val,
                    }
                    pending_rev = None

        # ── Pending pullback: check fill/decay BEFORE funding and position mgmt ──
        if pending_pb is not None and position is None:
            curr_high_pb = float(row.get("high", row["close"]))
            curr_low_pb  = float(row.get("low",  row["close"]))
            pb_dir       = pending_pb["direction"]
            pb_zone      = pending_pb["pullback_zone"]
            pb_fallback  = pending_pb["fallback_limit"]
            pb_expires   = pending_pb["expires_bar"]
            pb_atr       = pending_pb["atr_at_signal"]
            pb_close_4h  = pending_pb["close_4h"]
            pb_ob_sl     = pending_pb.get("ob_sl_price")

            # Check decay: price broke hard opposite direction (worst-case intrabar)
            _decay = (
                (pb_dir == "long"  and curr_high_pb > pb_fallback) or
                (pb_dir == "short" and curr_low_pb  < pb_fallback)
            )
            # Check fill: price touched pullback zone intrabar
            _filled = (
                (pb_dir == "long"  and curr_low_pb  <= pb_zone) or
                (pb_dir == "short" and curr_high_pb >= pb_zone)
            )

            if _decay and not _filled:
                pending_pb = None
                param_stats["pb_decayed"] += 1
            elif _filled:
                param_stats["pb_filled_zone"] += 1
                # Entry at the pullback zone price (limit-like fill)
                _entry_px = pb_zone
                _orig_sl_dist = (
                    abs(pending_pb["orig_sl"] - pb_close_4h) / pb_atr
                    if pb_atr > 0 else getattr(cfg, "sl_atr_mult", 2.0)
                )
                if pb_ob_sl is not None:
                    _pb_sl = pb_ob_sl
                else:
                    # Reanchor SL from actual entry
                    if pb_dir == "long":
                        _pb_sl = _entry_px - _orig_sl_dist * pb_atr
                    else:
                        _pb_sl = _entry_px + _orig_sl_dist * pb_atr
                _pb_tp       = pending_pb["orig_tp"]
                _pb_size_usd = pending_pb["size_usd"]
                fee_entry = _pb_size_usd * HL_TAKER_FEE
                equity   -= fee_entry
                position  = {
                    "side":              pb_dir,
                    "entry":             _entry_px,
                    "sl":                _pb_sl,
                    "tp":                _pb_tp,
                    "size_usd":          _pb_size_usd,
                    "bar_idx":           i,
                    "entry_atr":         pb_atr,
                    "partial_done":      False,
                    "sl_trailing_active": False,
                    "high_water":        _entry_px,
                    "be_sl_applied":     False,
                    "lgbm_strikes":      0,
                    "fee_entry":         fee_entry,
                    "funding_paid":      0.0,
                    "entry_mode":        "pullback",
                }
                pending_pb = None
            elif i >= pending_pb["expires_bar"]:
                # Timeout: fallback entry if still in range
                _cur_px = float(row["close"])
                _in_range = (
                    (pb_dir == "long"  and _cur_px <= pb_fallback) or
                    (pb_dir == "short" and _cur_px >= pb_fallback)
                )
                if _in_range:
                    param_stats["pb_filled_fallback"] += 1
                    _entry_px = _cur_px
                    if pb_ob_sl is not None:
                        _pb_sl = pb_ob_sl
                    else:
                        _orig_sl_dist = (
                            abs(pending_pb["orig_sl"] - pb_close_4h) / pb_atr
                            if pb_atr > 0 else getattr(cfg, "sl_atr_mult", 2.0)
                        )
                        _pb_sl = (_entry_px - _orig_sl_dist * pb_atr if pb_dir == "long"
                                  else _entry_px + _orig_sl_dist * pb_atr)
                    fee_entry = pending_pb["size_usd"] * HL_TAKER_FEE
                    equity   -= fee_entry
                    position  = {
                        "side":              pb_dir,
                        "entry":             _entry_px,
                        "sl":                _pb_sl,
                        "tp":                pending_pb["orig_tp"],
                        "size_usd":          pending_pb["size_usd"],
                        "bar_idx":           i,
                        "entry_atr":         pb_atr,
                        "partial_done":      False,
                        "sl_trailing_active": False,
                        "high_water":        _entry_px,
                        "be_sl_applied":     False,
                        "lgbm_strikes":      0,
                        "fee_entry":         fee_entry,
                        "funding_paid":      0.0,
                        "entry_mode":        "pullback_fallback",
                    }
                else:
                    param_stats["pb_decayed"] += 1
                pending_pb = None

        # Inject RegimeDetector signal — update every 4 bars (matching live cadence).
        if _bt_regime_detector is not None and i % 4 == 0 and i >= 120:
            try:
                _bt_regime_sig = _bt_regime_detector.detect(df_feat.iloc[: i + 1])
            except Exception:
                pass
        if _bt_regime_sig is not None:
            features["regime_state"]      = _bt_regime_sig.regime
            features["regime_confidence"] = _bt_regime_sig.confidence
            features["transition_risk"]   = _bt_regime_sig.transition_risk
            features["bars_in_regime"]    = float(_bt_regime_sig.bars_in_regime)
        atr_raw  = features.get("atr_14")
        atr      = float(atr_raw) if (atr_raw is not None and pd.notna(atr_raw) and atr_raw > 0) else float(row["close"]) * 0.01
        atr_21_raw = features.get("atr_21")
        atr_sl   = (float(atr_21_raw) if (dual_atr_enabled and atr_21_raw is not None and pd.notna(atr_21_raw) and float(atr_21_raw) > 0) else None)

        # ── Funding accrual while in position ────────────────────────────────
        if position and i % FUNDING_INTERVAL_BARS == 0 and funding_col:
            fund_val = df_feat.iloc[i].get("funding")
            if fund_val is not None and pd.notna(fund_val):
                # Positive funding rate → longs pay shorts; negative → shorts pay longs.
                # funding_impact > 0 means this position pays; < 0 means it receives.
                rate  = float(fund_val)
                sign  = 1.0 if position["side"] == "long" else -1.0
                funding_impact = position["size_usd"] * rate * sign
                if funding_impact > 0:
                    equity -= funding_impact
                    position["funding_paid"] = position.get("funding_paid", 0.0) + funding_impact
                else:
                    equity += abs(funding_impact)
                    position["funding_paid"] = position.get("funding_paid", 0.0) + funding_impact  # negative = received

        # ── Manage existing position ──────────────────────────────────────────
        if position:
            close_price = float(row["close"])
            curr_high   = float(row.get("high", close_price))
            curr_low    = float(row.get("low",  close_price))
            side        = position["side"]
            entry       = position["entry"]
            entry_atr   = position["entry_atr"]

            # ── Trailing SL: dynamic trail once activated (high water mark) ──
            # Reversal trades use rev_sl_atr_mult as trail distance (mirrors live engine).
            if trailing_sl_enabled:
                _trail_mult = position.get("rev_sl_atr_mult", trailing_sl_activation) if position.get("is_reversal") else trailing_sl_activation
                trail_dist  = _trail_mult * atr  # current ATR, not entry_atr
                if not position.get("sl_trailing_active"):
                    moved_enough = (side == "long"  and curr_high >= entry + trail_dist) or \
                                   (side == "short" and curr_low  <= entry - trail_dist)
                    if moved_enough:
                        position["sl_trailing_active"] = True
                        position["high_water"] = curr_high if side == "long" else curr_low
                        param_stats["pm_trailing_sl"] += 1
                if position.get("sl_trailing_active"):
                    if side == "long":
                        position["high_water"] = max(position["high_water"], curr_high)
                        new_sl = position["high_water"] - trail_dist
                        position["sl"] = max(position["sl"], new_sl)
                    else:
                        position["high_water"] = min(position["high_water"], curr_low)
                        new_sl = position["high_water"] + trail_dist
                        position["sl"] = min(position["sl"], new_sl)

            # ── Break-even SL: move SL to entry price after activation ────────
            # Use current ATR (matches live engine behavior).
            if be_sl_enabled and not position.get("be_sl_applied"):
                be_dist = be_sl_activation * atr  # current ATR, not entry_atr
                moved_enough = (side == "long"  and curr_high >= entry + be_dist) or \
                               (side == "short" and curr_low  <= entry - be_dist)
                if moved_enough:
                    if side == "long":
                        position["sl"] = max(position["sl"], entry)
                    else:
                        position["sl"] = min(position["sl"], entry)
                    position["be_sl_applied"] = True
                    param_stats["pm_be_sl"] += 1

            # ── Partial TP: close partial_tp_pct% at partial_tp_atr_mult×ATR ──
            # Use high/low for detection; exit at the target price, not close.
            if partial_tp_enabled and not position.get("partial_done"):
                partial_target = entry + partial_tp_atr_mult * entry_atr if side == "long" \
                                 else entry - partial_tp_atr_mult * entry_atr
                hit_partial = (side == "long"  and curr_high >= partial_target) or \
                              (side == "short" and curr_low  <= partial_target)
                if hit_partial:
                    partial_exit_price = partial_target
                    partial_frac = partial_tp_pct / 100.0
                    partial_size = position["size_usd"] * partial_frac
                    pnl_pct_p = (partial_exit_price - entry) / entry * 100 if side == "long" \
                                else (entry - partial_exit_price) / entry * 100
                    pnl_usd_p = partial_size * pnl_pct_p / 100
                    fee_p     = partial_size * HL_TAKER_FEE
                    equity   += pnl_usd_p - fee_p
                    # Assign all entry fee + funding accrued so far to this first close leg
                    entry_fee_used   = position.get("fee_entry", 0.0)
                    funding_used     = position.get("funding_paid", 0.0)
                    position["fee_entry"]    = 0.0  # consumed — don't double-count on final close
                    position["funding_paid"] = 0.0  # reset after assignment
                    position["size_usd"]   *= (1.0 - partial_frac)
                    position["partial_done"] = True
                    param_stats["pm_partial_tp"] += 1
                    trades.append({
                        "side": side, "entry": entry, "exit": partial_exit_price,
                        "pnl_pct": round(pnl_pct_p, 4),
                        "pnl_usd": round(pnl_usd_p - fee_p - entry_fee_used - funding_used, 2),
                        "fee_entry": round(entry_fee_used, 2),
                        "funding_paid": round(funding_used, 2),
                        "reason": "partial_tp", "holding_bars": i - position["bar_idx"], "bar": i,
                        "origin": position.get("origin", "trend"),
                    })
                    equity_curve.append({"bar": i, "equity": round(equity, 2)})

            bars_held      = i - position["bar_idx"]
            already_closed = False

            # ── LightGBM mid-trade exit (consecutive-bar confirmation) ─────────
            # Skip lgbm_exit for reversal trades — LGBM is trend-following and would exit early
            if lgbm_exit_enabled and bars_held >= lgbm_exit_min_hold_bars and not position.get("is_reversal"):
                row_x          = X_all.iloc[[i]]
                lgbm_p_current = float(lgbm_model.predict_proba(row_x)[0, 1])
                if enhanced_exit_enabled and use_chronos:
                    # Chronos runs only at entry in backtest; use close_price as c2_p50 proxy.
                    # This is conservative: both LGBM flip and price-crossed-entry must hold.
                    flip_long  = side == "long"  and lgbm_p_current < lgbm_exit_threshold  and close_price < entry
                    flip_short = side == "short" and lgbm_p_current > (1.0 - lgbm_exit_threshold) and close_price > entry
                else:
                    flip_long  = side == "long"  and lgbm_p_current < lgbm_exit_threshold
                    flip_short = side == "short" and lgbm_p_current > (1.0 - lgbm_exit_threshold)
                if flip_long or flip_short:
                    position["lgbm_strikes"] = position.get("lgbm_strikes", 0) + 1
                else:
                    position["lgbm_strikes"] = 0
                if position.get("lgbm_strikes", 0) >= lgbm_exit_confirm_bars:
                    param_stats["pm_lgbm_exit"] += 1
                    pnl_pct_e  = (close_price - entry) / entry * 100 if side == "long" \
                                 else (entry - close_price) / entry * 100
                    pnl_usd_e  = position["size_usd"] * pnl_pct_e / 100
                    fee_e      = position["size_usd"] * HL_TAKER_FEE
                    equity    += pnl_usd_e - fee_e
                    entry_fee_used = position.get("fee_entry", 0.0)
                    funding_used   = position.get("funding_paid", 0.0)
                    trades.append({
                        "side": side, "entry": entry, "exit": close_price,
                        "pnl_pct":     round(pnl_pct_e, 4),
                        "pnl_usd":     round(pnl_usd_e - fee_e - entry_fee_used - funding_used, 2),
                        "fee_entry":   round(entry_fee_used, 2),
                        "funding_paid": round(funding_used, 2),
                        "reason":      "lgbm_exit",
                        "holding_bars": bars_held,
                        "bar":         i,
                        "origin":      position.get("origin", "trend"),
                    })
                    equity_curve.append({"bar": i, "equity": round(equity, 2)})
                    position       = None
                    already_closed = True

            # ── Max hold bars: time-based force exit ──────────────────────────
            # Reversal trades: always enforce rev_max_hold; trend trades: only if max_hold_bars_enabled.
            # Guard: a previous exit (lgbm_exit) may have set position=None / already_closed=True —
            # never access position.get() before this check or it crashes with NoneType.get.
            _is_rev_pos = position.get("is_reversal", False) if (position and not already_closed) else False
            _max_hold_limit_bt = position.get("rev_max_hold", reversal_max_hold_bars_val) if _is_rev_pos else max_hold_bars_val
            _max_hold_active_bt = _is_rev_pos or max_hold_bars_enabled
            if not already_closed and position is not None and _max_hold_active_bt and bars_held >= _max_hold_limit_bt:
                param_stats["pm_max_hold"] += 1
                pnl_pct_m  = (close_price - entry) / entry * 100 if side == "long" \
                             else (entry - close_price) / entry * 100
                pnl_usd_m  = position["size_usd"] * pnl_pct_m / 100
                fee_m      = position["size_usd"] * HL_TAKER_FEE
                equity    += pnl_usd_m - fee_m
                entry_fee_used = position.get("fee_entry", 0.0)
                funding_used   = position.get("funding_paid", 0.0)
                trades.append({
                    "side": side, "entry": entry, "exit": close_price,
                    "pnl_pct":     round(pnl_pct_m, 4),
                    "pnl_usd":     round(pnl_usd_m - fee_m - entry_fee_used - funding_used, 2),
                    "fee_entry":   round(entry_fee_used, 2),
                    "funding_paid": round(funding_used, 2),
                    "reason":      "max_hold",
                    "holding_bars": bars_held,
                    "bar":         i,
                    "origin":      position.get("origin", "trend"),
                })
                equity_curve.append({"bar": i, "equity": round(equity, 2)})
                position       = None
                already_closed = True

            # ── Full SL/TP check using intrabar high/low ──────────────────────
            # Exit at the actual SL/TP price, not at close. When both SL and TP
            # are touched in the same candle (SL wick and TP wick), apply SL
            # (conservative worst-case — we cannot resolve order without tick data).
            if not already_closed:
                hit_sl = (side == "long"  and curr_low  <= position["sl"]) or \
                         (side == "short" and curr_high >= position["sl"])
                hit_tp = (side == "long"  and curr_high >= position["tp"]) or \
                         (side == "short" and curr_low  <= position["tp"])
                if hit_sl and hit_tp:
                    hit_tp = False  # conservative: SL wins when ambiguous
            else:
                hit_sl = hit_tp = False

            if hit_sl or hit_tp:
                if hit_sl: param_stats["exit_stop_loss"]   += 1
                else:       param_stats["exit_take_profit"] += 1
                reason     = "stop_loss" if hit_sl else "take_profit"
                exit_price = position["sl"] if hit_sl else position["tp"]
                pnl_pct    = (exit_price - entry) / entry * 100 if side == "long" \
                             else (entry - exit_price) / entry * 100
                pnl_usd    = position["size_usd"] * pnl_pct / 100
                fee_exit   = position["size_usd"] * HL_TAKER_FEE
                entry_fee_used = position.get("fee_entry", 0.0)
                funding_used   = position.get("funding_paid", 0.0)

                equity += pnl_usd - fee_exit
                trades.append({
                    "side": side, "entry": entry, "exit": exit_price,
                    "pnl_pct":    round(pnl_pct, 4),
                    "pnl_usd":    round(pnl_usd - fee_exit - entry_fee_used - funding_used, 2),
                    "fee_entry":  round(entry_fee_used, 2),
                    "funding_paid": round(funding_used, 2),
                    "reason":     reason,
                    "holding_bars": i - position["bar_idx"],
                    "bar":        i,
                    "origin":     position.get("origin", "trend"),
                })
                equity_curve.append({"bar": i, "equity": round(equity, 2)})
                position = None

        # ── New signal decision ───────────────────────────────────────────────
        if position is None and i >= 64:  # skip warm-up rows
            # LightGBM probability (non-C2 features)
            row_x    = X_all.iloc[[i]]
            lgbm_p   = float(lgbm_model.predict_proba(row_x)[0, 1])
            cur_px   = float(row["close"])

            # Chronos-2: real forecast OR neutral prior.
            # Neutral prior sets all keys so cont_prob/uncertainty gates never
            # accidentally block trades when Chronos is disabled.
            # Deterministic seed = bar timestamp → same run always = same trades.
            if use_chronos and chronos_forecaster is not None:
                close_so_far   = df_feat["close"].values[:i + 1]
                volume_so_far  = df_feat["volume"].values[:i + 1]    if "volume"    in df_feat.columns else None
                oi_so_far      = df_feat["oi_raw"].values[:i + 1]    if "oi_raw"    in df_feat.columns else None
                funding_so_far = df_feat["funding"].values[:i + 1]   if "funding"   in df_feat.columns else None
                cvd_so_far     = df_feat["delta_raw"].values[:i + 1] if "delta_raw" in df_feat.columns else None
                c2_out = chronos_forecaster.forecast(
                    close_so_far, horizon=3, atr=atr,
                    volume_series=volume_so_far,
                    oi_series=oi_so_far,
                    funding_series=funding_so_far,
                    cvd_series=cvd_so_far,
                    use_calibration=getattr(cfg, "use_chronos_calibration", False),
                )
                # Guard: forecast() should always return a dict, but if a model/inference
                # edge case returns None, fall back to the neutral prior instead of crashing
                # decide() with "'NoneType' object has no attribute 'get'".
                if c2_out is None:
                    log.warning("Chronos forecast returned None at bar %d — using neutral prior", i)
                    c2_out = {
                        "c2_dir_prob": 0.5, "c2_p10": cur_px, "c2_p50": cur_px, "c2_p90": cur_px,
                        "c2_uncertainty": 0.0, "c2_vol_prob": 0.0, "c2_cont_prob": 1.0, "c2_p50_vs_atr": 0.0,
                    }
            else:
                c2_out = {
                    "c2_dir_prob":    0.5,
                    "c2_p10":         cur_px,
                    "c2_p50":         cur_px,
                    "c2_p90":         cur_px,
                    "c2_uncertainty": 0.0,
                    "c2_vol_prob":    0.0,
                    "c2_cont_prob":   1.0,  # neutral = fully coherent, never triggers cont gate
                    "c2_p50_vs_atr":  0.0,
                }

            # Compute QT confluence score so confluence_gate is active in backtest
            qt_score = compute_qt_score(features) if confluence_gate > 0 else None

            # Funding Rate: rolling mean of last N closed bars at this point in time.
            avg_funding_bt = 0.0
            if funding_gate_enabled:
                _lb = min(funding_gate_lookback, i + 1)   # include bar i (match live behaviour)
                _fund_vals = df_feat["funding"].values[i + 1 - _lb:i + 1] if "funding" in df_feat.columns else None
                if _fund_vals is not None and len(_fund_vals) > 0 and not np.all(np.isnan(_fund_vals)):
                    avg_funding_bt = float(np.nanmean(_fund_vals))

            # Fear & Greed: look up the value for this bar's date.
            # Neutral 50.0 if not available (no effect on thresholds).
            covars_bt: dict | None = None
            if fng_gate_enabled:
                bar_date = str(row.name.date()) if hasattr(row.name, "date") else ""
                fng_val  = fng_history.get(bar_date, 50.0)
                covars_bt = {"fear_greed": fng_val}

            result = decision_engine.decide(
                features=features,
                c2_output=c2_out,
                lgbm_prob=lgbm_p,
                confluence_score=qt_score,
                current_price=cur_px,
                avg_funding=avg_funding_bt,
                covariates=covars_bt,
            )

            # ── Reversal Zone Detection (mirrors live _cycle logic) ───────────
            _rev_res = None  # reset each bar; used by build_pending_reversal below
            if _bt_rev_detector is not None and pending_rev is None:
                try:
                    _rev_slice = df_feat.iloc[:i + 1]
                    _rev_res   = _bt_rev_detector.score(_rev_slice, _bt_regime_sig, cfg)
                    # Routing: same 3-case logic as execution._cycle()
                    if (
                        _rev_res.direction is not None
                        and _rev_res.score >= reversal_score_threshold
                        and _rev_res.component_count >= reversal_min_components
                    ):
                        _trend_action = result.action
                        if _trend_action == "no_trade":
                            # Case 1: trend hold → reversal takes control
                            result = DecisionResult(
                                action               = _rev_res.direction,
                                confidence           = _rev_res.score,
                                reasoning            = ["[REVERSAL] " + r for r in _rev_res.reasoning],
                                features_snapshot    = result.features_snapshot,
                                directional_prob     = _rev_res.score,
                                forecast_p10         = result.forecast_p10,
                                forecast_p50         = result.forecast_p50,
                                forecast_p90         = result.forecast_p90,
                                forecast_uncertainty = 0.0,
                                size_factor          = reversal_size_factor,
                                _is_reversal         = True,
                            )
                            param_stats["rev_signals"] += 1
                        elif _trend_action == _rev_res.direction and not reversal_trend_hold_only:
                            # Case 2: boost
                            result.confidence = min(1.0, result.confidence + 0.05)
                            param_stats["rev_trend_boost"] += 1
                        elif _trend_action != _rev_res.direction and reversal_conflict_block:
                            # Case 3: conflict block
                            result.action = "no_trade"
                            param_stats["rev_conflict_block"] += 1
                except Exception as _rev_exc:
                    log.debug("Reversal detector failed at bar %d: %s", i, _rev_exc)

            # ── Parameter activity tracking — parse reasoning string ──────────
            # Gate loop: gates are mutually exclusive — at most one per evaluation.
            # Uses `break` to stop at the first gate match (gates cause immediate return).
            param_stats["bars_evaluated"] += 1
            for _line in result.reasoning:
                if "GATE: ADX"               in _line: param_stats["gate_adx"]             += 1; break
                if "GATE: Liquidity sweep"   in _line or ("GATE: Sweep" in _line and "conflicts" in _line):
                    param_stats["gate_sweep"] += 1; break
                if "GATE: Confluence"        in _line: param_stats["gate_confluence"]        += 1; break
                if "GATE: C2 uncertainty"    in _line: param_stats["gate_c2_uncertainty"]    += 1; break
                if "GATE: C2 cont_prob"      in _line: param_stats["gate_c2_cont"]           += 1; break
                if "FILTER: Bearish FVG"     in _line: param_stats["gate_fvg_long"]          += 1; break
                if "FILTER: Bullish FVG"     in _line: param_stats["gate_fvg_short"]         += 1; break
                if "FILTER: LateEntry"       in _line: param_stats["gate_late_entry"]        += 1; break
                if "FILTER: PathObstruction" in _line: param_stats["gate_path_obstruction"]  += 1; break
                if "FILTER: ConsecBars"      in _line: param_stats["gate_consec_bars"]       += 1; break
            # Modifier loop: per-evaluation flags avoid double-count from multi-line modifiers
            # (e.g. ExhaustionGuard adds up to 2 lines when both long and short conditions fire).
            _mods_seen: set = set()
            for _line in result.reasoning:
                if "MTF:"             in _line and "regime" in _line.lower() and "mod_mtf" not in _mods_seen:
                    param_stats["mod_mtf_alignment"]    += 1; _mods_seen.add("mod_mtf")
                if "RegimeBias"       in _line and "nessun" not in _line and "neutralizzato" not in _line and "mod_regime" not in _mods_seen:
                    param_stats["mod_regime_bias"]      += 1; _mods_seen.add("mod_regime")
                if "FundingBias:"     in _line and "mod_funding" not in _mods_seen:
                    param_stats["mod_funding_bias"]     += 1; _mods_seen.add("mod_funding")
                if "FNG:"             in _line and "mod_fng" not in _mods_seen:
                    param_stats["mod_fng_bias"]         += 1; _mods_seen.add("mod_fng")
                if "ExhaustionGuard"  in _line and "mod_exhaust" not in _mods_seen:
                    param_stats["mod_exhaustion_guard"] += 1; _mods_seen.add("mod_exhaust")
                if "AbsorptionFilter:" in _line and "mod_abs" not in _mods_seen:
                    param_stats["mod_absorption_filter"]+= 1; _mods_seen.add("mod_abs")
                if "SweepConf:"       in _line and "mod_sweep" not in _mods_seen:
                    param_stats["mod_sweep_conf_bonus"] += 1; _mods_seen.add("mod_sweep")
            if result.action == "long":
                param_stats["signals_long"]  += 1
                if result.size_factor < 0.99: param_stats["mod_counter_trend_size"] += 1
            elif result.action == "short":
                param_stats["signals_short"] += 1
                if result.size_factor < 0.99: param_stats["mod_counter_trend_size"] += 1
            else:
                param_stats["no_trade"] += 1

            if result.action != "no_trade" and pending_pb is not None:
                # Already in pullback wait mode — skip new signal
                pass
            elif result.action != "no_trade":
                close_price = float(row["close"])
                _use_dynamic = dynamic_sl_tp_enabled and use_chronos
                _p10_available = use_chronos
                # Pass c2 quantiles when EITHER adaptive SL/TP or P10 floor needs them
                _needs_quantiles = _use_dynamic or (p10_sl_floor_enabled and _p10_available)

                # For reversal trades in "close" mode, override risk multipliers to match live engine.
                # Live uses _rev_cfg with reversal_sl_atr_mult/reversal_tp_atr_mult; backtest must too.
                _is_rev_now = getattr(result, "_is_reversal", False)
                _orig_risk_sl = risk.sl_atr_mult
                _orig_risk_tp = risk.tp_atr_mult
                if _is_rev_now:
                    risk.sl_atr_mult = reversal_sl_atr_mult
                    risk.tp_atr_mult = reversal_tp_atr_mult

                params = risk.calculate_trade_params(
                    side=result.action,
                    entry_price=close_price,
                    atr=atr,
                    equity_usd=equity,
                    sl_atr=atr_sl,
                    c2_p10=c2_out.get("c2_p10") if _needs_quantiles else None,
                    c2_p90=c2_out.get("c2_p90") if _needs_quantiles else None,
                    c2_uncertainty=c2_out.get("c2_uncertainty") if _use_dynamic else None,
                    dynamic_sl_tp_enabled=_use_dynamic,
                    dynamic_sl_tp_blend=dynamic_sl_tp_blend,
                    recalibrated_uncertainty_thresholds=recalibrated_uncertainty_thresholds,
                    p10_sl_floor_enabled=p10_sl_floor_enabled and _p10_available,
                    ob_tp_enabled=ob_tp_enabled,
                    ob_tp_blend=ob_tp_blend,
                    ob_bear_top_px=float(v) if (v := result.features_snapshot.get("ob_bear_top_px")) is not None and pd.notna(v) and float(v) > 0 else None,
                    ob_bull_bot_px=float(v) if (v := result.features_snapshot.get("ob_bull_bot_px")) is not None and pd.notna(v) and float(v) > 0 else None,
                    fvg_tp_enabled=fvg_tp_enabled,
                    fvg_tp_blend=fvg_tp_blend,
                    fvg_bear_bot_px=float(v) if (v := result.features_snapshot.get("fvg_bear_bot_px")) is not None and pd.notna(v) and float(v) > 0 else None,
                    fvg_bull_top_px=float(v) if (v := result.features_snapshot.get("fvg_bull_top_px")) is not None and pd.notna(v) and float(v) > 0 else None,
                    swing_tp_enabled=swing_tp_enabled,
                    swing_tp_blend=swing_tp_blend,
                    swing_high_px=float(v) if (v := result.features_snapshot.get("swing_high_px")) is not None and pd.notna(v) and float(v) > 0 else None,
                    swing_low_px=float(v) if (v := result.features_snapshot.get("swing_low_px")) is not None and pd.notna(v) and float(v) > 0 else None,
                )
                # Restore original risk multipliers after reversal override
                if _is_rev_now:
                    risk.sl_atr_mult = _orig_risk_sl
                    risk.tp_atr_mult = _orig_risk_tp

                # Structural SL: mirror live execution — place SL behind OB when within 2%.
                if structural_sl_enabled:
                    _sl_applied, _ = apply_structural_sl(
                        params, result.features_snapshot, close_price,
                        ob_buffer_pct=ob_buffer_pct,
                        ob_buffer_min_atr=ob_buffer_min_atr,
                    )
                    if _sl_applied: param_stats["sl_structural_ob"] += 1
                if fvg_sl_enabled:
                    _fvg_applied, _ = apply_fvg_sl(
                        params, result.features_snapshot, close_price,
                        ob_buffer_pct=ob_buffer_pct,
                        ob_buffer_min_atr=ob_buffer_min_atr,
                    )
                    if _fvg_applied: param_stats["sl_fvg"] += 1
                if swing_sl_enabled:
                    _sw_applied, _ = apply_swing_sl(
                        params, result.features_snapshot, close_price,
                    )
                    if _sw_applied: param_stats["sl_swing"] += 1
                # OB TP (tracked via params change — check if ob_tp produced a different TP)
                if ob_tp_enabled and result.features_snapshot.get(
                    "ob_bear_top_px" if result.action == "long" else "ob_bull_bot_px"
                ):
                    param_stats["tp_ob"] += 1
                effective_size_usd = params.size_usd * result.size_factor
                # ── Pullback Entry simulation ─────────────────────────────────
                # Skip pullback for reversal trades: they have their own entry logic (pending_rev).
                if pullback_entry_enabled and not getattr(result, "_is_reversal", False):
                    # Impulso = corpo candela (abs(close-open)), NON range totale (high-low).
                    # Il range include doji e shadow che non indicano un vero impulso direzionale.
                    _open_bt = float(row.get("open", close_price))
                    _impulse = abs(close_price - _open_bt) / atr if atr > 0 else 0.0
                    if _impulse >= pullback_impulse_atr_mult:
                        pb_dist = pullback_zone_atr * atr
                        fb_dist = pullback_fallback_atr * atr
                        sl_buf  = atr * 0.05
                        if result.action == "long":
                            ob_top    = float(v) if (v := result.features_snapshot.get("ob_bull_top_px")) is not None and pd.notna(v) and float(v) > 0 else None
                            ob_bot    = float(v) if (v := result.features_snapshot.get("ob_bull_bot_px")) is not None and pd.notna(v) and float(v) > 0 else None
                            ob_active = bool(result.features_snapshot.get("ob_bull_active"))
                            if ob_active and ob_top and ob_top < close_price:
                                _pb_zone = ob_top
                                _ob_sl   = (ob_bot - sl_buf) if ob_bot else (ob_top - sl_buf * 4)
                            else:
                                _pb_zone = close_price - pb_dist
                                _ob_sl   = None
                            _fb_limit = close_price + fb_dist
                        else:
                            ob_bot    = float(v) if (v := result.features_snapshot.get("ob_bear_bot_px")) is not None and pd.notna(v) and float(v) > 0 else None
                            ob_top    = float(v) if (v := result.features_snapshot.get("ob_bear_top_px")) is not None and pd.notna(v) and float(v) > 0 else None
                            ob_active = bool(result.features_snapshot.get("ob_bear_active"))
                            if ob_active and ob_bot and ob_bot > close_price:
                                _pb_zone = ob_bot
                                _ob_sl   = (ob_top + sl_buf) if ob_top else (ob_bot + sl_buf * 4)
                            else:
                                _pb_zone = close_price + pb_dist
                                _ob_sl   = None
                            _fb_limit = close_price - fb_dist
                        # expires_bar: window is in hours, bars are 4H → divide by 4
                        # ceil so that e.g. 3h → 1 bar, 5h → 2 bars, 8h → 2 bars
                        _expire_bars = max(1, math.ceil(pullback_window_h / 4))
                        param_stats["pb_activated"] += 1
                        pending_pb = {
                            "direction":    result.action,
                            "close_4h":     close_price,
                            "atr_at_signal": atr,
                            "pullback_zone": _pb_zone,
                            "fallback_limit": _fb_limit,
                            "expires_bar":  i + _expire_bars,  # converted from hours to 4H bars
                            "orig_sl":      params.stop_loss,
                            "orig_tp":      params.take_profit,
                            "size_usd":     effective_size_usd,
                            "ob_sl_price":  _ob_sl,
                        }
                        continue  # skip immediate entry — wait for pullback

                # ── Reversal entry: limit-retest mode ─────────────────────────
                if getattr(result, "_is_reversal", False) and reversal_entry_mode == "limit_retest":
                    _rev_candle = df_feat.iloc[i].to_dict()
                    _rev_pending = build_pending_reversal(
                        direction       = result.action,
                        candle          = _rev_candle,
                        reversal_result = _rev_res,   # snapshot del segnale per logging/debug
                        cfg             = cfg,
                        atr             = atr,
                        bar_idx         = i,
                    )
                    if _rev_pending:
                        _rev_pending["size_usd"] = effective_size_usd
                        pending_rev = _rev_pending
                        param_stats["rev_pending_set"] += 1
                    continue  # wait for retest

                # Immediate entry (pullback not enabled or impulse below threshold)
                _is_rev_entry = getattr(result, "_is_reversal", False)
                fee_entry = effective_size_usd * HL_TAKER_FEE
                equity   -= fee_entry
                position  = {
                    "side":          result.action,
                    "entry":         close_price,
                    "sl":            params.stop_loss,
                    "tp":            params.take_profit,
                    "size_usd":      effective_size_usd,
                    "bar_idx":       i,
                    "entry_atr":     atr,
                    "partial_done":      False,
                    "sl_trailing_active": False,
                    "high_water":        close_price,
                    "be_sl_applied":     False,
                    "lgbm_strikes":      0,
                    "fee_entry":         fee_entry,
                    "funding_paid":      0.0,
                    "entry_mode":        "reversal_close" if _is_rev_entry else "immediate",
                    "origin":            "reversal" if _is_rev_entry else "trend",
                    "is_reversal":       _is_rev_entry,
                    "rev_sl_atr_mult":   reversal_sl_atr_mult if _is_rev_entry else sl_atr_mult,
                    "rev_max_hold":      reversal_max_hold_bars_val,
                }

    # ── 6. Close any open position at last price ──────────────────────────────
    if position:
        last_price = float(df_feat.iloc[-1]["close"])
        side       = position["side"]
        pnl_pct = (
            (last_price - position["entry"]) / position["entry"] * 100 if side == "long"
            else (position["entry"] - last_price) / position["entry"] * 100
        )
        fee_last       = position["size_usd"] * HL_TAKER_FEE
        entry_fee_used = position.get("fee_entry", 0.0)
        funding_used   = position.get("funding_paid", 0.0)
        gross_pnl      = position["size_usd"] * pnl_pct / 100
        pnl_usd        = gross_pnl - fee_last
        equity        += pnl_usd
        param_stats["exit_end_of_period"] += 1
        trades.append({
            "side": side, "entry": position["entry"], "exit": last_price,
            "pnl_pct": round(pnl_pct, 4),
            "pnl_usd": round(gross_pnl - fee_last - entry_fee_used - funding_used, 2),
            "fee_entry": round(entry_fee_used, 2),
            "funding_paid": round(funding_used, 2),
            "reason": "end_of_period", "holding_bars": len(df_feat) - position["bar_idx"],
            "bar": len(df_feat) - 1,
            "origin": position.get("origin", "trend"),
        })
        equity_curve.append({"bar": len(df_feat) - 1, "equity": round(equity, 2)})

    # ── 7. Calculate statistics ───────────────────────────────────────────────
    stats = _calculate_stats(trades, equity_curve, capital)
    duration_days = (
        datetime.fromisoformat(req.to_date) - datetime.fromisoformat(req.from_date)
    ).days

    # param_config: which parameters were ENABLED for this backtest run.
    # Used by the frontend to distinguish "disabled" from "enabled but never triggered".
    param_config: dict = {
        # Gates
        "gate_adx":               adx_gate_enabled,
        "gate_sweep":             sweep_gate_enabled and not sweep_gate_directional,
        "gate_confluence":        (confluence_gate or 0) > 0,
        "gate_c2_uncertainty":    c2_uncertainty_gate_enabled and use_chronos,
        "gate_c2_cont":           c2_cont_prob_gate_enabled and use_chronos,
        "gate_fvg_long":          fvg_filter_enabled,
        "gate_fvg_short":         fvg_filter_enabled,
        "gate_late_entry":        late_entry_filter_enabled,
        "gate_path_obstruction":  path_obstruction_enabled,
        "gate_consec_bars":       consec_bars_filter_enabled,
        # Modifiers
        "mod_mtf_alignment":      mtf_alignment_enabled,
        "mod_regime_bias":        regime_bias_enabled,
        "mod_counter_trend_size": regime_bias_enabled and getattr(cfg, "regime_bias_size_factor", 1.0) < 1.0,
        "mod_funding_bias":       funding_gate_enabled,
        "mod_fng_bias":           fng_gate_enabled,
        "mod_iv_size_reduction":  False,  # options IV not simulated in backtest
        "mod_exhaustion_guard":   exhaustion_guard_enabled,
        "mod_absorption_filter":  absorption_filter_enabled,
        "mod_sweep_conf_bonus":   sweep_gate_directional,
        # Structural SL/TP
        "sl_structural_ob":       structural_sl_enabled,
        "sl_fvg":                 fvg_sl_enabled,
        "sl_swing":               swing_sl_enabled,
        "tp_ob":                  ob_tp_enabled,
        # Position management
        "pm_trailing_sl":         trailing_sl_enabled,
        "pm_be_sl":               be_sl_enabled,
        "pm_partial_tp":          partial_tp_enabled,
        "pm_lgbm_exit":           lgbm_exit_enabled,
        "pm_max_hold":            max_hold_bars_enabled,
        # Pullback entry
        "pb_activated":           pullback_entry_enabled,
        "pb_filled_zone":         pullback_entry_enabled,
        "pb_filled_fallback":     pullback_entry_enabled,
        "pb_decayed":             pullback_entry_enabled,
        # Reversal Zone Detector
        "rev_signals":            reversal_mode_enabled,
        "rev_pending_set":        reversal_mode_enabled and reversal_entry_mode == "limit_retest",
        "rev_pending_triggered":  reversal_mode_enabled and reversal_entry_mode == "limit_retest",
        "rev_pending_expired":    reversal_mode_enabled and reversal_entry_mode == "limit_retest",
        "rev_conflict_block":     reversal_mode_enabled and reversal_conflict_block,
        "rev_trend_boost":        reversal_mode_enabled and not reversal_trend_hold_only,
        # Data sources (no runtime counter — on/off only)
        "data_binance_cvd":       binance_cvd_enabled,
    }

    # ── Reversal stats (separati da trend stats) ─────────────────────────────
    rev_trades   = [t for t in trades if t.get("origin") == "reversal"]
    trend_trades = [t for t in trades if t.get("origin") != "reversal"]
    reversal_stats = _calculate_stats(rev_trades,   equity_curve, capital) if rev_trades   else None
    trend_stats    = _calculate_stats(trend_trades, equity_curve, capital) if trend_trades else None

    result = {
        "symbol":          symbol,
        "from_date":       req.from_date,
        "to_date":         req.to_date,
        "initial_capital": capital,
        "final_equity":    round(equity, 2),
        "total_bars":      len(df_feat),
        "stats":           stats,
        "reversal_stats":  reversal_stats,
        "trend_stats":     trend_stats,
        "trades":          trades,
        "equity_curve":    equity_curve,
        "param_stats":     param_stats,
        "param_config":    param_config,
    }
    clean = _sanitize(result)

    # ── 8. Persist to Supabase ────────────────────────────────────────────────
    try:
        from services.supabase_client import get_supabase
        cfg_snapshot = req.config.model_dump() if req.config else {}
        summary = {
            "total_trades":    stats.get("total_trades", 0),
            "win_rate":        stats.get("win_rate", 0),
            "total_pnl_usd":   stats.get("total_pnl_usd", 0),
            "total_pnl_pct":   stats.get("total_pnl_pct", 0),
            "sharpe":          stats.get("sharpe", 0),
            "max_drawdown_pct": stats.get("max_drawdown_pct", 0),
            "profit_factor":   stats.get("profit_factor", 0),
            "final_equity":    round(equity, 2),
            "use_chronos":     getattr(req, "use_chronos", False),
        }
        record = {
            "symbol":          symbol,
            "from_date":       req.from_date,
            "to_date":         req.to_date,
            "initial_capital": capital,
            "duration_days":   duration_days,
            "config":          cfg_snapshot,
            "summary":         summary,
            "results":         clean,
        }
        _name = getattr(req, "name", None)
        if _name:
            record["name"] = _name
        db = get_supabase()
        db.table("backtest_results").insert(record).execute()
    except Exception as exc:
        log.warning("Backtest save to DB failed: %s", exc)

    return clean


def _sanitize(obj):
    """Recursively replace nan/inf with 0 so the result is JSON-serializable."""
    if isinstance(obj, float):
        return 0.0 if not np.isfinite(obj) else obj
    if isinstance(obj, dict):
        return {k: _sanitize(v) for k, v in obj.items()}
    if isinstance(obj, list):
        return [_sanitize(v) for v in obj]
    return obj


def _calculate_stats(trades: list, equity_curve: list, capital: float) -> dict:
    if not trades:
        return {
            "total_trades": 0, "win_rate": 0.0, "avg_win_pct": 0.0, "avg_loss_pct": 0.0,
            "profit_factor": 0.0, "total_pnl_usd": 0.0, "total_pnl_pct": 0.0,
            "sharpe": 0.0, "sortino": 0.0, "calmar": 0.0, "max_drawdown_pct": 0.0,
            "avg_holding_h": 0.0, "best_trade_pct": 0.0, "worst_trade_pct": 0.0,
        }

    pnls     = [t["pnl_pct"] for t in trades]
    pnls_usd = [t["pnl_usd"] for t in trades]
    wins     = [p for p in pnls if p > 0]
    losses   = [p for p in pnls if p <= 0]

    total_pnl_usd = sum(pnls_usd)
    win_rate      = len(wins) / len(trades)
    avg_win       = np.mean(wins)  if wins   else 0.0
    avg_loss      = np.mean(losses) if losses else 0.0
    profit_factor = abs(sum(wins) / sum(losses)) if losses else 99.0

    # Build bar-by-bar equity by forward-filling the sparse equity_curve.
    # equity_curve has entries only at trade events; flat (no-trade) bars must
    # be filled with the last known equity so Sharpe/Sortino treat them as
    # zero-return periods rather than ignoring them entirely.
    total_pnl_pct = total_pnl_usd / capital * 100
    ann = np.sqrt(365 * 6)  # annualization factor for 4h bars
    if len(equity_curve) >= 2:
        n_bars = equity_curve[-1]["bar"] + 1
        filled = np.empty(n_bars)
        ec_idx = 0
        for b in range(n_bars):
            while ec_idx + 1 < len(equity_curve) and equity_curve[ec_idx + 1]["bar"] <= b:
                ec_idx += 1
            filled[b] = equity_curve[ec_idx]["equity"]
        eq_arr = np.diff(filled) / (filled[:-1] + 1e-9)
    else:
        n_bars = 1
        eq_arr = np.array([0.0])

    sharpe  = float(np.mean(eq_arr) / (np.std(eq_arr) + 1e-9) * ann) if len(eq_arr) > 1 else 0.0

    # Sortino: penalise only downside returns
    neg_rets = eq_arr[eq_arr < 0]
    sortino  = float(np.mean(eq_arr) / (np.std(neg_rets) + 1e-9) * ann) if len(neg_rets) > 0 else sharpe

    # Sanitize: replace inf/nan with 0
    sharpe  = sharpe  if np.isfinite(sharpe)  else 0.0
    sortino = sortino if np.isfinite(sortino) else 0.0

    # Max drawdown from equity curve
    peak = capital
    max_dd = 0.0
    for e in equity_curve:
        v = e["equity"]
        if v > peak:
            peak = v
        dd = (peak - v) / peak * 100
        if dd > max_dd:
            max_dd = dd

    # Calmar: annualized return / max drawdown (B5 fix — annualize before dividing)
    duration_days = n_bars * 4 / 24  # each bar = 4h
    annual_return = ((1 + total_pnl_pct / 100) ** (365.0 / max(duration_days, 1)) - 1) * 100
    calmar = round(annual_return / max_dd, 3) if max_dd > 0 else 0.0

    avg_holding_h = np.mean([t["holding_bars"] * 4 for t in trades])

    return {
        "total_trades":    len(trades),
        "win_rate":        round(win_rate * 100, 2),
        "avg_win_pct":     round(avg_win, 4),
        "avg_loss_pct":    round(avg_loss, 4),
        "profit_factor":   round(profit_factor, 3),
        "total_pnl_usd":   round(total_pnl_usd, 2),
        "total_pnl_pct":   round(total_pnl_pct, 2),
        "sharpe":          round(sharpe, 3),
        "sortino":         round(sortino, 3),
        "calmar":          calmar,
        "max_drawdown_pct": round(max_dd, 2),
        "avg_holding_h":   round(avg_holding_h, 1),
        "best_trade_pct":  round(max(pnls), 4),
        "worst_trade_pct": round(min(pnls), 4),
    }
