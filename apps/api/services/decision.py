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
    size_factor: float = 1.0  # 1.0 = full size; <1.0 = reduced for counter-trend trades


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
        sweep_gate_directional: bool = False,
        fvg_filter_enabled: bool = True,
        mtf_alignment_enabled: bool = True,
        chronos_weight: float = 0.40,
        c2_uncertainty_gate_enabled: bool = False,
        c2_uncertainty_threshold: float = 0.05,
        c2_cont_prob_gate_enabled: bool = False,
        c2_cont_prob_threshold: float = 0.25,
        regime_bias_enabled: bool = False,
        regime_bias_delta: float = 0.08,
        regime_bias_size_factor: float = 1.0,
        forced_regime: str = "auto",
        regime_bias_enhanced: bool = False,
        absorption_filter_enabled: bool = False,
        absorption_z_threshold: float = 2.0,
        exhaustion_guard_enabled: bool = True,
        late_entry_filter_enabled: bool = False,
        late_entry_max_ob_dist: float = 3.0,
        path_obstruction_enabled: bool = False,
        path_obstruction_max_dist: float = 1.5,
        consec_bars_filter_enabled: bool = False,
        consec_bars_max_long: int = 8,
        consec_bars_max_short: int = 8,
        # Funding Rate Bias
        funding_gate_enabled: bool = False,
        funding_gate_lookback: int = 6,
        funding_high_thr: float = 0.00010,
        funding_extreme_thr: float = 0.00030,
        funding_bias_delta: float = 0.03,
        # Fear & Greed Bias
        fng_gate_enabled: bool = False,
        fng_extreme_fear_thr: float = 20.0,
        fng_fear_thr: float = 35.0,
        fng_greed_thr: float = 65.0,
        fng_extreme_greed_thr: float = 80.0,
        fng_bias_delta: float = 0.03,
        # Options IV Bias (Phase 1)
        options_bias_enabled: bool = False,
        iv_high_percentile: float = 80.0,
        iv_low_percentile: float = 20.0,
        iv_size_factor: float = 0.7,
        # Exhaustion Guard — configurable thresholds
        exhaustion_rsi_low:   float = 28.0,
        exhaustion_rsi_high:  float = 72.0,
        exhaustion_ret48_pct: float = 6.0,
        exhaustion_boost:     float = 0.06,
    ):
        self.directional_threshold       = directional_threshold
        self.adx_gate                    = adx_gate
        self.confluence_gate             = confluence_gate
        self.adx_gate_enabled            = adx_gate_enabled
        self.sweep_gate_enabled          = sweep_gate_enabled
        self.sweep_gate_directional      = sweep_gate_directional
        self.fvg_filter_enabled          = fvg_filter_enabled
        self.mtf_alignment_enabled       = mtf_alignment_enabled
        self.chronos_weight              = chronos_weight
        self.c2_uncertainty_gate_enabled = c2_uncertainty_gate_enabled
        self.c2_uncertainty_threshold    = c2_uncertainty_threshold
        self.c2_cont_prob_gate_enabled   = c2_cont_prob_gate_enabled
        self.c2_cont_prob_threshold      = c2_cont_prob_threshold
        self.regime_bias_enabled         = regime_bias_enabled
        self.regime_bias_delta           = regime_bias_delta
        self.regime_bias_size_factor     = regime_bias_size_factor
        self.forced_regime               = forced_regime
        self.regime_bias_enhanced        = regime_bias_enhanced
        self.absorption_filter_enabled   = absorption_filter_enabled
        self.absorption_z_threshold      = absorption_z_threshold
        self.exhaustion_guard_enabled    = exhaustion_guard_enabled
        self.late_entry_filter_enabled    = late_entry_filter_enabled
        self.late_entry_max_ob_dist       = late_entry_max_ob_dist
        self.path_obstruction_enabled      = path_obstruction_enabled
        self.path_obstruction_max_dist     = path_obstruction_max_dist
        self.consec_bars_filter_enabled    = consec_bars_filter_enabled
        self.consec_bars_max_long          = consec_bars_max_long
        self.consec_bars_max_short         = consec_bars_max_short
        # Funding Rate Bias
        self.funding_gate_enabled  = funding_gate_enabled
        self.funding_gate_lookback = funding_gate_lookback
        self.funding_high_thr      = funding_high_thr
        self.funding_extreme_thr   = funding_extreme_thr
        self.funding_bias_delta    = funding_bias_delta
        # Fear & Greed Bias
        self.fng_gate_enabled      = fng_gate_enabled
        self.fng_extreme_fear_thr  = fng_extreme_fear_thr
        self.fng_fear_thr          = fng_fear_thr
        self.fng_greed_thr         = fng_greed_thr
        self.fng_extreme_greed_thr = fng_extreme_greed_thr
        self.fng_bias_delta        = fng_bias_delta
        # Options IV Bias
        self.options_bias_enabled  = options_bias_enabled
        self.iv_high_percentile    = iv_high_percentile
        self.iv_low_percentile     = iv_low_percentile
        self.iv_size_factor        = iv_size_factor
        self.exhaustion_rsi_low    = exhaustion_rsi_low
        self.exhaustion_rsi_high   = exhaustion_rsi_high
        self.exhaustion_ret48_pct  = exhaustion_ret48_pct
        self.exhaustion_boost      = exhaustion_boost

    def decide(
        self,
        features: dict,
        c2_output: dict,
        lgbm_prob: float,
        confluence_score: Optional[float] = None,
        current_price: float = 0.0,
        avg_funding: float = 0.0,
        covariates: Optional[dict] = None,
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
        adx      = features.get("adx_14", 0.0)
        sweep    = features.get("sweep", 0.0)
        fvg_bear = features.get("fvg_bear", 0.0)
        fvg_bull = features.get("fvg_bull", 0.0)
        rsi_14   = features.get("rsi_14", 50.0)
        ret_48   = features.get("ret_48", 0.0)
        d_regime = features.get("d_regime", 0)

        # Manual override: forced_regime takes precedence over auto-detected d_regime
        # for the Regime Bias logic. MTF alignment always uses the auto d_regime.
        if self.forced_regime == "bull":
            bias_regime = 1
        elif self.forced_regime == "bear":
            bias_regime = -1
        elif self.forced_regime == "neutral":
            bias_regime = 0
        elif self.regime_bias_enhanced:
            # Enhanced Auto: use RegimeDetector signal injected into features.
            # transition/flat/sideways → 0 (no directional bias).
            _rstate = str(features.get("regime_state", "neutral"))
            if _rstate == "uptrend":
                bias_regime = 1
            elif _rstate == "downtrend":
                bias_regime = -1
            else:
                bias_regime = 0
        else:
            # Simple Auto: daily EMA20 + ADX > 20 proxy.
            bias_regime = int(d_regime)

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
        # In directional mode: pass through and defer the direction check until
        # ensemble_prob is computed (below). The flag _sweep_dir_pending carries
        # the detected sweep direction into the SweepConfluence block.
        _sweep_dir_pending: Optional[str] = None
        if self.sweep_gate_enabled and sweep == 1.0:
            if self.sweep_gate_directional:
                _sweep_dir_pending = str(features.get("sweep_dir") or "none")
                reasoning.append(
                    f"SweepDetect: {_sweep_dir_pending} sweep — evaluating direction alignment"
                )
            else:
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
                f"— quantile bands too incoherent, no-trade"
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

        # ── Regime Bias: asymmetric threshold by direction ────────────────────
        # Uses bias_regime (manual override, enhanced Auto, or simple Auto d_regime).
        # MTF alignment above always uses the raw auto d_regime from features.
        threshold_long  = effective_threshold
        threshold_short = effective_threshold
        counter_trend_size_factor = 1.0

        if self.forced_regime != "auto":
            _regime_source = "manuale"
        elif self.regime_bias_enhanced:
            _regime_source = "enhanced"
        else:
            _regime_source = "auto"

        # Enhanced Auto: modulate delta continuously by regime confidence and
        # transition risk so the bias evaporates gracefully when the regime is
        # ambiguous or ending — no hard threshold cutoffs.
        if self.regime_bias_enabled and self.forced_regime == "auto" and self.regime_bias_enhanced:
            _conf      = float(features.get("regime_confidence", 0.5))
            _tr_risk   = float(features.get("transition_risk",   0.0))
            _eff_delta = self.regime_bias_delta * _conf * (1.0 - _tr_risk * 0.8)
        else:
            _eff_delta = self.regime_bias_delta

        if self.regime_bias_enabled and _eff_delta > 0.001:
            if bias_regime == 1:
                threshold_short = effective_threshold + _eff_delta
                counter_trend_size_factor = self.regime_bias_size_factor
                if self.regime_bias_enhanced and _regime_source == "enhanced":
                    _conf_pct  = int(float(features.get("regime_confidence", 0.5)) * 100)
                    _tr_pct    = int(float(features.get("transition_risk", 0.0)) * 100)
                    reasoning.append(
                        f"RegimeBias[Enhanced]: regime=UPTREND conf={_conf_pct}% tr_risk={_tr_pct}% → "
                        f"threshold_long={threshold_long:.2f}, "
                        f"threshold_short={threshold_short:.2f} (+{_eff_delta:.3f})"
                    )
                else:
                    reasoning.append(
                        f"RegimeBias: regime=BULL ({_regime_source}) → "
                        f"threshold_long={threshold_long:.2f}, "
                        f"threshold_short={threshold_short:.2f} (+{_eff_delta:.2f})"
                    )
            elif bias_regime == -1:
                threshold_long = effective_threshold + _eff_delta
                counter_trend_size_factor = self.regime_bias_size_factor
                if self.regime_bias_enhanced and _regime_source == "enhanced":
                    _conf_pct  = int(float(features.get("regime_confidence", 0.5)) * 100)
                    _tr_pct    = int(float(features.get("transition_risk", 0.0)) * 100)
                    reasoning.append(
                        f"RegimeBias[Enhanced]: regime=DOWNTREND conf={_conf_pct}% tr_risk={_tr_pct}% → "
                        f"threshold_long={threshold_long:.2f} (+{_eff_delta:.3f}), "
                        f"threshold_short={threshold_short:.2f}"
                    )
                else:
                    reasoning.append(
                        f"RegimeBias: regime=BEAR ({_regime_source}) → "
                        f"threshold_long={threshold_long:.2f} (+{_eff_delta:.2f}), "
                        f"threshold_short={threshold_short:.2f}"
                    )
            elif bias_regime == 0 and self.regime_bias_enhanced and _regime_source == "enhanced":
                _rstate  = str(features.get("regime_state", "neutral")).upper()
                _tr_risk = float(features.get("transition_risk", 0.0))
                if _tr_risk > 0.5:
                    reasoning.append(
                        f"RegimeBias[Enhanced]: regime={_rstate} · transition_risk={_tr_risk:.2f} "
                        f"— bias neutralizzato"
                    )
                else:
                    reasoning.append(
                        f"RegimeBias[Enhanced]: regime={_rstate} — nessun bias direzionale"
                    )

        # ── Funding Rate Bias ─────────────────────────────────────────────────
        # High positive funding = market over-long → raise long threshold.
        # High negative funding = market over-short → lower long threshold.
        # Effect doubles at extreme levels (2× multiplier).
        if self.funding_gate_enabled and avg_funding != 0.0:
            _fund_mult = 2.0 if abs(avg_funding) > self.funding_extreme_thr else 1.0
            _fund_adj  = self.funding_bias_delta * _fund_mult
            if avg_funding > self.funding_high_thr:
                threshold_long  += _fund_adj
                threshold_short -= _fund_adj
                reasoning.append(
                    f"FundingBias: avg={avg_funding * 10000:.2f}bps/8h (×{_fund_mult:.0f}) "
                    f"— over-long market → long +{_fund_adj:.2f}, short −{_fund_adj:.2f}"
                )
            elif avg_funding < -self.funding_high_thr:
                threshold_long  -= _fund_adj
                threshold_short += _fund_adj
                reasoning.append(
                    f"FundingBias: avg={avg_funding * 10000:.2f}bps/8h (×{_fund_mult:.0f}) "
                    f"— over-short market → long −{_fund_adj:.2f}, short +{_fund_adj:.2f}"
                )

        # ── Fear & Greed Bias ─────────────────────────────────────────────────
        # Contrarian: extreme fear = oversold from panic → favour longs.
        # Extreme greed = overbought from euphoria → favour shorts.
        # Only extreme zones (>80 / <20) apply the full delta; fear/greed zones use 0.5×.
        if self.fng_gate_enabled and covariates:
            fng = float(covariates.get("fear_greed", 50.0))
            if fng < self.fng_extreme_fear_thr:
                delta = self.fng_bias_delta
                threshold_long  -= delta
                threshold_short += delta
                reasoning.append(
                    f"FNG: Extreme Fear {fng:.0f} < {self.fng_extreme_fear_thr:.0f} "
                    f"→ long −{delta:.2f}, short +{delta:.2f}"
                )
            elif fng < self.fng_fear_thr:
                half = self.fng_bias_delta * 0.5
                threshold_long  -= half
                threshold_short += half
                reasoning.append(
                    f"FNG: Fear {fng:.0f} < {self.fng_fear_thr:.0f} "
                    f"→ long −{half:.2f}, short +{half:.2f}"
                )
            elif fng > self.fng_extreme_greed_thr:
                delta = self.fng_bias_delta
                threshold_long  += delta
                threshold_short -= delta
                reasoning.append(
                    f"FNG: Extreme Greed {fng:.0f} > {self.fng_extreme_greed_thr:.0f} "
                    f"→ long +{delta:.2f}, short −{delta:.2f}"
                )
            elif fng > self.fng_greed_thr:
                half = self.fng_bias_delta * 0.5
                threshold_long  += half
                threshold_short -= half
                reasoning.append(
                    f"FNG: Greed {fng:.0f} > {self.fng_greed_thr:.0f} "
                    f"→ long +{half:.2f}, short −{half:.2f}"
                )

        # ── Options IV Bias ───────────────────────────────────────────────────
        # High IV percentile = market expects explosive moves → reduce size.
        # iv_7d_percentile is 50.0 (neutral) when options are disabled or fetch failed.
        # Does NOT modify thresholds — only affects position size via iv_sf multiplier
        # applied to the DecisionResult.size_factor at the long/short return points.
        iv_sf = 1.0
        if self.options_bias_enabled:
            _iv_pct = float(features.get("iv_7d_percentile", 50.0))
            if _iv_pct > self.iv_high_percentile:
                iv_sf = self.iv_size_factor
                reasoning.append(
                    f"IVBias: iv_7d_pct={_iv_pct:.0f}% > {self.iv_high_percentile:.0f}% "
                    f"→ size×{iv_sf:.2f} (high-IV regime, volatility compression)"
                )
            elif _iv_pct < self.iv_low_percentile:
                reasoning.append(
                    f"IVBias: iv_7d_pct={_iv_pct:.0f}% < {self.iv_low_percentile:.0f}% "
                    f"→ size×1.00 (low-IV regime, full size)"
                )

        # ── Exhaustion Guard: RSI extreme + extended ret_48 ──────────────────
        if self.exhaustion_guard_enabled:
            _exh_short_conds: list[str] = []
            _exh_long_conds:  list[str] = []
            _ret48_thr = self.exhaustion_ret48_pct / 100.0

            if rsi_14 < self.exhaustion_rsi_low:
                _exh_short_conds.append(f"RSI {rsi_14:.1f} < {self.exhaustion_rsi_low:.0f}")
            if ret_48 < -_ret48_thr:
                _exh_short_conds.append(f"ret_48 {ret_48*100:.1f}% < -{self.exhaustion_ret48_pct:.0f}%")
            if rsi_14 > self.exhaustion_rsi_high:
                _exh_long_conds.append(f"RSI {rsi_14:.1f} > {self.exhaustion_rsi_high:.0f}")
            if ret_48 > _ret48_thr:
                _exh_long_conds.append(f"ret_48 {ret_48*100:.1f}% > +{self.exhaustion_ret48_pct:.0f}%")

            _exh_boost = self.exhaustion_boost
            _exh_short_boost = _exh_boost if _exh_short_conds else 0.0
            _exh_long_boost  = _exh_boost if _exh_long_conds  else 0.0

            if _exh_short_conds:
                reasoning.append(
                    f"ExhaustionGuard [{' & '.join(_exh_short_conds)}] → "
                    f"short threshold +{_exh_short_boost:.2f} (bounce/pullback risk)"
                )
            if _exh_long_conds:
                reasoning.append(
                    f"ExhaustionGuard [{' & '.join(_exh_long_conds)}] → "
                    f"long threshold +{_exh_long_boost:.2f} (pullback risk)"
                )

            threshold_short += _exh_short_boost
            threshold_long  += _exh_long_boost

        # ── Absorption Filter ─────────────────────────────────────────────────
        # High volume + low price movement → institutions absorbing order flow.
        # absorption_z > threshold means anomalous volume-to-move ratio; raises
        # conviction requirement by +0.03 in both directions.
        absorption_z = float(features.get("absorption_z") or 0.0)
        if self.absorption_filter_enabled and absorption_z > self.absorption_z_threshold:
            threshold_long  += 0.03
            threshold_short += 0.03
            reasoning.append(
                f"AbsorptionFilter: absorption_z={absorption_z:.2f} > "
                f"{self.absorption_z_threshold:.2f} — threshold +0.03 (high vol, low move)"
            )

        # ── Sweep Confluence (directional mode) ──────────────────────────────
        # Deferred from Gate Level 2: now that ensemble_prob is known, resolve
        # whether the sweep direction confirms or conflicts with the model signal.
        #
        # buyside sweep  = smart money hunted retail stops ABOVE → bearish reversal expected
        # sellside sweep = smart money hunted retail stops BELOW → bullish reversal expected
        #
        # Confirmed alignment  → threshold bonus −0.03 (higher-conviction entry)
        # Direction conflicts  → block (sweep is a warning, not a green light)
        if _sweep_dir_pending is not None:
            if _sweep_dir_pending == "buyside" and ensemble_prob < 0.5:
                threshold_short -= 0.03
                reasoning.append(
                    f"SweepConf: buyside sweep + bearish ({ensemble_prob:.3f}) → "
                    f"short threshold −0.03 (liquidity above collected, reversal signal)"
                )
            elif _sweep_dir_pending == "sellside" and ensemble_prob > 0.5:
                threshold_long -= 0.03
                reasoning.append(
                    f"SweepConf: sellside sweep + bullish ({ensemble_prob:.3f}) → "
                    f"long threshold −0.03 (liquidity below collected, reversal signal)"
                )
            else:
                reasoning.append(
                    f"GATE: Sweep ({_sweep_dir_pending}) conflicts with ensemble "
                    f"({ensemble_prob:.3f}) — no-trade"
                )
                return self._no_trade(reasoning, dir_prob, p10, p50, p90, features, c2_uncertainty)

        # ── Confluence gate ───────────────────────────────────────────────────
        if confluence_score is not None and confluence_score < self.confluence_gate:
            reasoning.append(f"GATE: Confluence {confluence_score:.0f} < {self.confluence_gate:.0f}")
            return self._no_trade(reasoning, dir_prob, p10, p50, p90, features, c2_uncertainty)

        # ── Long signal ───────────────────────────────────────────────────────
        if ensemble_prob > threshold_long:
            # Anti-FVG filter: don't enter long into a bearish FVG zone overhead
            if self.fvg_filter_enabled and fvg_bear == 1.0:
                reasoning.append("FILTER: Bearish FVG detected overhead — skipping long entry")
                return self._no_trade(reasoning, dir_prob, p10, p50, p90, features, c2_uncertainty)

            # Late entry filter: skip if price is too far above the bull OB midpoint.
            # ob_bull_dist = (close - OB_mid) / ATR_14 — large positive = late entry.
            # Only active when a bull OB is present (ob_bull_active == 1.0); ignored otherwise
            # to avoid blocking legitimate trades with no nearby structure.
            if self.late_entry_filter_enabled:
                _ob_bull_active = float(features.get("ob_bull_active") or 0.0)
                _ob_bull_dist   = float(features.get("ob_bull_dist")   or 0.0)
                if _ob_bull_active == 1.0 and _ob_bull_dist > self.late_entry_max_ob_dist:
                    reasoning.append(
                        f"FILTER: LateEntry — ob_bull_dist={_ob_bull_dist:.2f} ATR > "
                        f"{self.late_entry_max_ob_dist:.1f} — entry too far from OB, skipping long"
                    )
                    return self._no_trade(reasoning, dir_prob, p10, p50, p90, features, c2_uncertainty)

            # Path obstruction: skip long if a bear OB (resistance) is too close overhead.
            # ob_bear_dist = (bear_OB_mid - close) / ATR_14 — small positive = just above entry.
            # Only active when a bear OB is present (ob_bear_active == 1.0).
            if self.path_obstruction_enabled:
                _obs_bear_active = float(features.get("ob_bear_active") or 0.0)
                _obs_bear_dist   = float(features.get("ob_bear_dist")   or 999.0)
                if _obs_bear_active == 1.0 and 0 < _obs_bear_dist < self.path_obstruction_max_dist:
                    reasoning.append(
                        f"FILTER: PathObstruction — bear OB at {_obs_bear_dist:.2f} ATR overhead "
                        f"< {self.path_obstruction_max_dist:.1f} — resistance blocks long path"
                    )
                    return self._no_trade(reasoning, dir_prob, p10, p50, p90, features, c2_uncertainty)

            if self.consec_bars_filter_enabled:
                _consec = float(features.get("consec_bars") or 0.0)
                # Block long when N+ consecutive BULL bars: trend is overextended, reversal risk high.
                if _consec >= self.consec_bars_max_long:
                    reasoning.append(
                        f"FILTER: ConsecBars — {int(_consec)} consecutive bull bars ≥ "
                        f"{self.consec_bars_max_long} — trend extended, skip long"
                    )
                    return self._no_trade(reasoning, dir_prob, p10, p50, p90, features, c2_uncertainty)

            # C2 p50 note: logged for transparency but does NOT veto the trade.
            # A hard p50 veto was found to cancel valid LGBM signals whenever Chronos
            # was slightly off, costing ~8% performance versus Chronos-off in backtests.
            if p50 > 0 and p50 < current_price:
                reasoning.append(f"NOTE: C2 median ({p50:.1f}) below entry — minor bearish bias in forecast")

            is_counter_trend = (bias_regime == -1)
            sf = (counter_trend_size_factor if is_counter_trend else 1.0) * iv_sf
            thr_used = threshold_long
            reasoning.append(
                f"LONG: P(up)={ensemble_prob:.3f} > {thr_used:.2f}, C2_p50={p50:.1f}"
                + (f" [size×{sf:.2f}]" if sf < 1.0 else "")
            )
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
                size_factor=sf,
            )

        # ── Short signal ──────────────────────────────────────────────────────
        short_prob = 1.0 - ensemble_prob
        if short_prob > threshold_short:
            if self.fvg_filter_enabled and fvg_bull == 1.0:
                reasoning.append("FILTER: Bullish FVG detected below — skipping short entry")
                return self._no_trade(reasoning, dir_prob, p10, p50, p90, features, c2_uncertainty)

            # Late entry filter: skip if price is too far below the bear OB midpoint.
            # ob_bear_dist = (OB_mid - close) / ATR_14 — large positive = late entry.
            # Only active when a bear OB is present (ob_bear_active == 1.0); ignored otherwise
            # to avoid blocking legitimate trades with no nearby structure.
            if self.late_entry_filter_enabled:
                _ob_bear_active = float(features.get("ob_bear_active") or 0.0)
                _ob_bear_dist   = float(features.get("ob_bear_dist")   or 0.0)
                if _ob_bear_active == 1.0 and _ob_bear_dist > self.late_entry_max_ob_dist:
                    reasoning.append(
                        f"FILTER: LateEntry — ob_bear_dist={_ob_bear_dist:.2f} ATR > "
                        f"{self.late_entry_max_ob_dist:.1f} — entry too far from OB, skipping short"
                    )
                    return self._no_trade(reasoning, dir_prob, p10, p50, p90, features, c2_uncertainty)

            # Path obstruction: skip short if a bull OB (support) is too close below.
            # ob_bull_dist = (close - bull_OB_mid) / ATR_14 — small positive = just below entry.
            # Only active when a bull OB is present (ob_bull_active == 1.0).
            if self.path_obstruction_enabled:
                _obs_bull_active = float(features.get("ob_bull_active") or 0.0)
                _obs_bull_dist   = float(features.get("ob_bull_dist")   or 999.0)
                if _obs_bull_active == 1.0 and 0 < _obs_bull_dist < self.path_obstruction_max_dist:
                    reasoning.append(
                        f"FILTER: PathObstruction — bull OB at {_obs_bull_dist:.2f} ATR below "
                        f"< {self.path_obstruction_max_dist:.1f} — support blocks short path"
                    )
                    return self._no_trade(reasoning, dir_prob, p10, p50, p90, features, c2_uncertainty)

            if self.consec_bars_filter_enabled:
                _consec = float(features.get("consec_bars") or 0.0)
                # Block short when N+ consecutive BEAR bars: trend is overextended, reversal risk high.
                if _consec <= -self.consec_bars_max_short:
                    reasoning.append(
                        f"FILTER: ConsecBars — {int(abs(_consec))} consecutive bear bars ≥ "
                        f"{self.consec_bars_max_short} — trend extended, skip short"
                    )
                    return self._no_trade(reasoning, dir_prob, p10, p50, p90, features, c2_uncertainty)

            # C2 p50 note: same reasoning as above — logged but does not veto.
            if p50 > 0 and p50 > current_price:
                reasoning.append(f"NOTE: C2 median ({p50:.1f}) above entry — minor bullish bias in forecast")

            is_counter_trend = (bias_regime == 1)
            sf = (counter_trend_size_factor if is_counter_trend else 1.0) * iv_sf
            thr_used = threshold_short
            reasoning.append(
                f"SHORT: P(down)={short_prob:.3f} > {thr_used:.2f}, C2_p50={p50:.1f}"
                + (f" [size×{sf:.2f}]" if sf < 1.0 else "")
            )
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
                size_factor=sf,
            )

        # ── No signal ─────────────────────────────────────────────────────────
        reasoning.append(
            f"NO-TRADE: P(up)={ensemble_prob:.3f} | "
            f"long>{threshold_long:.2f}, short>{threshold_short:.2f}"
        )
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
