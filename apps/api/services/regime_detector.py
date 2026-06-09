"""
Regime Detector — classifies current market regime from 4H OHLCV data.

Uses 5 primary indicators (ADX, ATR percentile, EMA20 slope, BB width, RSI)
with deterministic rules. Called every 4 cycles (~16h) by the execution engine.

Also implements all transition signals from the regime-backtesting-guide.md
"Zone di Transizione — Consigli Avanzati" section:
  - ADX picca >35 e scende → TRANSITION override
  - RSI divergenza bearish/rialzista → +0.25 transition risk
  - Volume in calo su nuovi massimi → +0.15 (topping signal)
  - Liquidity sweep in downtrend → +0.15 (capitolazione imminente)
  - ADX slope > +1.0/bar in sideways → +0.20 (breakout imminente)
  - Grey zone ADX [18,22] → +0.15 baseline instability
  - Regime durata > 60 barre → crescente fragility

Regime hierarchy:
  flat       → ADX < 15  (compression)
  sideways   → ADX 15–22 (range-bound)
  uptrend    → ADX ≥ 22 AND slope > +0.5%/candle
  downtrend  → ADX ≥ 22 AND slope < -0.5%/candle
  transition → ADX era >35 e scende veloce (fine regime in corso)
"""

from __future__ import annotations

import logging
import math
from dataclasses import dataclass, field
from typing import Literal

import numpy as np
import pandas as pd
import ta

log = logging.getLogger(__name__)

Regime = Literal["uptrend", "downtrend", "sideways", "flat", "transition"]


# ── Utility ───────────────────────────────────────────────────────────────────

def _safe(v, default: float) -> float:
    """
    Convert a pandas scalar or Python value to float.
    Returns `default` for NaN/Inf/None — necessary because
    float(np.nan) is truthy in Python, so `float(v) or default` does NOT work.
    """
    try:
        f = float(v)
        return default if (math.isnan(f) or math.isinf(f)) else f
    except (TypeError, ValueError):
        return default


# ── Data classes ──────────────────────────────────────────────────────────────

@dataclass
class RegimeSignal:
    regime: Regime
    confidence: float            # 0.0–1.0
    adx: float
    atr_percentile: float        # 0–100, relative volatility rank vs last 90 bars
    trend_slope_pct: float       # EMA20 slope in % per candle (positive = up)
    bb_width_pct: float          # (upper−lower)/middle in %
    bars_in_regime: int          # consecutive 4H candles in same regime
    transition_risk: float       # 0–1, probability of imminent regime change
    reasoning: list[str] = field(default_factory=list)


# ── Main class ────────────────────────────────────────────────────────────────

class RegimeDetector:
    """
    Stateless regime classifier. Accepts a feature-enriched or raw OHLCV DataFrame
    and returns a RegimeSignal for the most recent bar.

    When standard indicator columns (adx_14, atr_14, bb_width, ema20, rsi_14)
    are already present — as they are from build_all_features() — they are
    reused verbatim. Otherwise they are computed on the fly from OHLCV columns.
    """

    def __init__(self, atr_window: int = 90, slope_window: int = 3):
        self.atr_window   = atr_window    # bars for ATR / BB percentile baseline
        self.slope_window = slope_window  # candles over which EMA slope is measured

    # ── Public API ────────────────────────────────────────────────────────────

    def detect(self, df: pd.DataFrame) -> RegimeSignal:
        """Classify the most recent bar and return a RegimeSignal."""
        min_bars = max(self.atr_window, 30) + self.slope_window + 5
        if len(df) < min_bars:
            log.warning("RegimeDetector: insufficient data (%d bars, need %d)", len(df), min_bars)
            return RegimeSignal(
                regime="sideways", confidence=0.30, adx=0.0,
                atr_percentile=50.0, trend_slope_pct=0.0, bb_width_pct=0.0,
                bars_in_regime=0, transition_risk=0.5,
                reasoning=["Insufficient data for regime detection"],
            )

        d = self._ensure_indicators(df)

        # ── Extract current values (NaN-safe) ─────────────────────────────
        adx           = _safe(d["adx_14"].iloc[-1],  0.0)
        atr_current   = _safe(d["atr_14"].iloc[-1],  0.0)
        bb_width_curr = _safe(d["bb_width"].iloc[-1], 0.0)
        rsi           = _safe(d["rsi_14"].iloc[-1],  50.0)
        ema20_now     = _safe(d["ema20"].iloc[-1],    1.0)

        # EMA back-reference — use _safe so NaN in early history doesn't corrupt slope
        ema20_back    = _safe(d["ema20"].iloc[-(1 + self.slope_window)], ema20_now)
        ema20_back    = ema20_back if ema20_back > 0 else ema20_now

        # EMA20 slope: % change per candle over slope_window bars
        trend_slope = (ema20_now - ema20_back) / ema20_back / self.slope_window * 100

        # ATR percentile vs last atr_window bars (excludes current bar)
        atr_hist = d["atr_14"].iloc[-(self.atr_window + 1):-1].dropna()
        atr_pct  = float(np.mean(atr_hist <= atr_current) * 100) if len(atr_hist) > 0 else 50.0

        # BB width P25 threshold (used to distinguish clean range from wide sideways)
        bb_hist = d["bb_width"].iloc[-(self.atr_window + 1):-1].dropna()
        bb_p25  = float(np.percentile(bb_hist, 25)) if len(bb_hist) >= 4 else bb_width_curr

        # ADX series (already dropna'd for reliability)
        adx_series = d["adx_14"].dropna()
        adx_prev3  = _safe(adx_series.iloc[-4] if len(adx_series) >= 4 else adx_series.iloc[0], adx)
        adx_slope  = (adx - adx_prev3) / 3.0  # mean change per bar over last 3 bars

        # ── RSI divergence (guide §1 — topping/capitulation signal) ──────
        price_window    = d["close"].iloc[-21:-1]
        rsi_window      = d["rsi_14"].iloc[-21:-1].dropna()
        close_last      = _safe(d["close"].iloc[-1], 0.0)
        price_new_high  = (close_last > float(price_window.max())) if len(price_window) > 0 else False
        price_new_low   = (close_last < float(price_window.min())) if len(price_window) > 0 else False
        rsi_new_high    = (rsi > float(rsi_window.max())) if len(rsi_window) > 0 else False
        rsi_new_low     = (rsi < float(rsi_window.min())) if len(rsi_window) > 0 else False
        rsi_divergence  = (price_new_high and not rsi_new_high) or (price_new_low and not rsi_new_low)

        # ── Optional transition-signal features (guide §1) ────────────────
        # These columns are present in df_feat from build_all_features() but
        # may be absent if the detector is called with raw OHLCV.
        vol_ratio = _safe(d["vol_ratio"].iloc[-1] if "vol_ratio" in d.columns else 1.0, 1.0)
        sweep_val = _safe(d["sweep"].iloc[-1]     if "sweep"     in d.columns else 0.0, 0.0)

        reasoning: list[str] = [
            f"ADX={adx:.1f} slope={adx_slope:+.2f}/bar | "
            f"EMA_slope={trend_slope:+.3f}%/bar | "
            f"ATR_pct={atr_pct:.0f} | "
            f"BB_width={bb_width_curr:.4f} (P25={bb_p25:.4f}) | "
            f"RSI={rsi:.1f} | vol_ratio={vol_ratio:.2f}"
        ]

        # ── Classification rules ───────────────────────────────────────────
        regime:     Regime
        confidence: float

        if adx < 15:
            regime     = "flat"
            confidence = 0.50 + min(0.40, (15.0 - adx) / 15.0 * 0.80)
            reasoning.append(f"FLAT: ADX {adx:.1f} < 15 — low-volatility compression")

        elif adx >= 22 and trend_slope > 0.5:
            regime     = "uptrend"
            slope_c    = min(0.30, (trend_slope - 0.5) / 2.0 * 0.30)
            adx_c      = min(0.25, (adx - 22.0) / 20.0 * 0.25)
            confidence = 0.55 + slope_c + adx_c
            reasoning.append(
                f"UPTREND: ADX {adx:.1f} ≥ 22, slope +{trend_slope:.3f}%/bar ≥ +0.5"
            )

        elif adx >= 22 and trend_slope < -0.5:
            regime     = "downtrend"
            slope_c    = min(0.30, (abs(trend_slope) - 0.5) / 2.0 * 0.30)
            adx_c      = min(0.25, (adx - 22.0) / 20.0 * 0.25)
            confidence = 0.55 + slope_c + adx_c
            reasoning.append(
                f"DOWNTREND: ADX {adx:.1f} ≥ 22, slope {trend_slope:.3f}%/bar ≤ −0.5"
            )

        elif adx >= 22:
            # Strong ADX but near-flat slope — coiling or breakout imminent.
            # High-energy coiling (ADX > 40) is more uncertain than mild coiling:
            # confidence decreases as ADX rises above 40 (max −0.13 at ADX=90).
            regime     = "sideways"
            confidence = 0.48 - max(0.0, (adx - 40.0) * 0.003) if adx > 40 else 0.48
            confidence = max(0.35, confidence)
            reasoning.append(
                f"SIDEWAYS (coiling): ADX {adx:.1f} ≥ 22, slope near-zero ({trend_slope:+.3f}%/bar)"
            )

        elif 15 <= adx < 22 and bb_width_curr < bb_p25:
            # Compressed BB + mid ADX → clean range (guide: bb_width < P25)
            regime     = "sideways"
            bb_ratio   = (bb_p25 - bb_width_curr) / max(bb_p25, 1e-6)
            confidence = 0.55 + min(0.25, bb_ratio * 0.25)
            reasoning.append(
                f"SIDEWAYS: ADX {adx:.1f} ∈ [15,22), BB {bb_width_curr:.4f} < P25 {bb_p25:.4f}"
            )

        else:
            # ADX [15,22), wide BB — ambiguous zone (guide: "grey zone")
            regime     = "sideways"
            confidence = 0.43
            reasoning.append(
                f"SIDEWAYS (grey zone): ADX {adx:.1f} ∈ [15,22), BB {bb_width_curr:.4f} ≥ P25 — "
                "instability elevated"
            )

        # ── Transition override (guide §1 — topping pattern) ──────────────
        # ADX peaked >35 in the last 12 bars AND is now falling fast → regime ending.
        # Examples from guide: Ago 2025 ATH push, Ott 2025 $126k false breakout.
        # Extended to cover high-energy "sideways (coiling)" with ADX > 40: when
        # ADX is very high but slope is flat and the ADX is declining, the prior
        # trend is exhausting itself — the same transition pattern as uptrend/downtrend.
        adx_recent_12 = adx_series.iloc[-12:].dropna()
        adx_peak_12   = float(adx_recent_12.max()) if len(adx_recent_12) > 0 else adx
        _coiling_transition = regime == "sideways" and adx > 40
        _transition_eligible = regime in ("uptrend", "downtrend") or _coiling_transition
        if adx_peak_12 > 35 and adx_slope < -0.5 and _transition_eligible:
            regime     = "transition"
            confidence = min(0.82, 0.55 + abs(adx_slope) * 0.08)
            reasoning.append(
                f"TRANSITION: ADX peaked {adx_peak_12:.1f} within 12 bars, "
                f"now declining {adx_slope:+.2f}/bar"
                + (" [high-energy coiling]" if _coiling_transition else "")
            )

        # ── Bars in same regime (consecutive count) ────────────────────────
        bars_in_regime = self._count_bars_in_regime(d, regime)

        # ── Transition risk (all guide signals combined) ───────────────────
        transition_risk = _compute_transition_risk(
            adx=adx, adx_slope=adx_slope, rsi=rsi,
            bars_in_regime=bars_in_regime,
            rsi_divergence=rsi_divergence,
            vol_ratio=vol_ratio,
            sweep=sweep_val,
            price_new_high_20=price_new_high,
            price_new_low_20=price_new_low,
            regime=regime,
            reasoning=reasoning,
        )

        confidence = round(min(1.0, max(0.0, confidence)), 3)

        signal = RegimeSignal(
            regime=regime,
            confidence=confidence,
            adx=round(adx, 2),
            atr_percentile=round(atr_pct, 1),
            trend_slope_pct=round(trend_slope, 4),
            bb_width_pct=round(bb_width_curr * 100, 3),
            bars_in_regime=bars_in_regime,
            transition_risk=round(transition_risk, 3),
            reasoning=reasoning,
        )

        log.info(
            "Regime: %s (conf=%.2f ADX=%.1f slope=%+.3f%%/bar bars=%d t_risk=%.2f)",
            regime, confidence, adx, trend_slope, bars_in_regime, transition_risk,
        )
        return signal

    # ── Internal helpers ──────────────────────────────────────────────────────

    def _ensure_indicators(self, df: pd.DataFrame) -> pd.DataFrame:
        """Reuse pre-computed indicator columns, or compute from raw OHLCV."""
        d = df.copy()
        if "adx_14" not in d.columns:
            d["adx_14"] = ta.trend.ADXIndicator(d["high"], d["low"], d["close"], 14).adx()
        if "atr_14" not in d.columns:
            d["atr_14"] = ta.volatility.AverageTrueRange(d["high"], d["low"], d["close"], 14).average_true_range()
        if "bb_width" not in d.columns:
            bb = ta.volatility.BollingerBands(d["close"], 20)
            d["bb_width"] = (bb.bollinger_hband() - bb.bollinger_lband()) / d["close"]
        if "ema20" not in d.columns:
            d["ema20"] = ta.trend.EMAIndicator(d["close"], 20).ema_indicator()
        if "rsi_14" not in d.columns:
            d["rsi_14"] = ta.momentum.RSIIndicator(d["close"], 14).rsi()
        return d

    def _count_bars_in_regime(self, d: pd.DataFrame, current_regime: Regime) -> int:
        """
        Count consecutive trailing bars classified in the same regime.
        Uses a simplified two-indicator check (ADX + EMA slope) for speed.
        Looks back at most 120 bars.
        """
        lookback = min(120, len(d) - self.slope_window - 5)
        if lookback < 2:
            return 1

        adx_arr = d["adx_14"].iloc[-lookback:].values
        ema_arr = d["ema20"].iloc[-lookback:].values

        # Forward-fill NaN in EMA (first ~19 bars may be NaN from the 20-period calc)
        # then compute per-bar gradient. We divide by the absolute EMA value to get
        # a % slope consistent with the detect() threshold of ±0.5%/bar.
        ema_series = pd.Series(ema_arr).ffill().bfill().values
        with np.errstate(divide="ignore", invalid="ignore"):
            slopes = np.gradient(ema_series) / (np.abs(ema_series) + 1e-9) * 100
        slopes = np.nan_to_num(slopes, nan=0.0)

        count = 0
        for i in range(len(adx_arr) - 1, -1, -1):
            a = _safe(adx_arr[i], 0.0)
            s = _safe(slopes[i],  0.0)

            if a < 15:
                bar_regime = "flat"
            elif a >= 22 and s > 0.5:
                bar_regime = "uptrend"
            elif a >= 22 and s < -0.5:
                bar_regime = "downtrend"
            else:
                bar_regime = "sideways"

            if current_regime == "transition":
                # Transition extends back through the preceding directional regime
                if bar_regime in ("uptrend", "downtrend", "transition"):
                    count += 1
                    continue
                else:
                    break

            if bar_regime == current_regime:
                count += 1
            else:
                break

        return max(count, 1)


# ── Module-level transition risk calculator ───────────────────────────────────

def _compute_transition_risk(
    adx: float,
    adx_slope: float,
    rsi: float,
    bars_in_regime: int,
    rsi_divergence: bool,
    # Optional context — present in df_feat but may be absent with raw OHLCV
    vol_ratio: float = 1.0,
    sweep: float = 0.0,
    price_new_high_20: bool = False,
    price_new_low_20: bool = False,
    regime: str = "sideways",
    reasoning: list[str] | None = None,
) -> float:
    """
    Composite 0–1 transition risk score incorporating all patterns documented in
    regime-backtesting-guide.md §"Zone di Transizione — Consigli Avanzati".

    Component                                       Max contribution
    ────────────────────────────────────────────────────────────────
    ADX peaked >35 AND declining fast               +0.40  (trend exhaustion)
    Regime duration > 60 bars                       +0.30  (fragility over time)
    RSI extreme (>75 or <25)                        +0.20  (overbought/oversold)
    RSI divergence (price/RSI mismatch)             +0.25  (guide §1 — topping/cap.)
    Volume declining on new high (topping)          +0.15  (guide §1 — mancanza partecipazione)
    Liquidity sweep in downtrend (capitolazione)    +0.15  (guide §1 — wick su minimi)
    ADX slope > +1.0/bar from sideways              +0.20  (guide §1 — breakout imminente)
    Grey zone ADX [18,22]                           +0.15  (guide §3 — zona grigia)
    ────────────────────────────────────────────────────────────────
    Capped at 1.0
    """
    risk = 0.0
    triggers: list[str] = []

    # 1. ADX peaked >35 and declining — classic topping/bottoming exhaustion
    if adx > 35 and adx_slope < -0.5:
        risk += 0.40
        triggers.append(f"ADX {adx:.1f}>35 declining {adx_slope:+.2f}/bar")

    # 2. Regime duration fragility — longer regimes are more likely to end
    if bars_in_regime > 60:
        contribution = min(0.30, (bars_in_regime - 60) * 0.005)
        risk += contribution
        triggers.append(f"{bars_in_regime} bars in regime (>{contribution:.2f} fragility)")

    # 3. RSI extreme — overbought/oversold
    if rsi > 75 or rsi < 25:
        risk += 0.20
        triggers.append(f"RSI extreme: {rsi:.1f}")

    # 4. RSI divergence — price makes new extreme but RSI doesn't confirm
    # Guide §1: "RSI divergenza bearish: prezzo fa nuovo massimo, RSI non segue"
    if rsi_divergence:
        risk += 0.25
        triggers.append("RSI divergence detected")

    # 5. Volume declining on new highs (topping signal, guide §1)
    # "Volume in calo sui nuovi massimi (mancanza di partecipazione)"
    # Applies in uptrend: if price made a new 20-bar high but volume is below average
    if regime == "uptrend" and price_new_high_20 and vol_ratio < 0.85:
        risk += 0.15
        triggers.append(f"Volume decline on new high: vol_ratio={vol_ratio:.2f}")

    # 6. Liquidity sweep in downtrend (capitolazione imminente, guide §1)
    # "Spike di volume con candela hammer o engulfing bullish su 4H/1D"
    # "Caso reale Apr 2025 W1: wick down a $74k (sweep dei minimi)"
    if regime == "downtrend" and sweep > 0:
        risk += 0.15
        triggers.append("Liquidity sweep detected in downtrend — possible capitulation")

    # 7. ADX rising fast in sideways = breakout imminent (guide §1)
    # "Sideways → breakout: ADX che sale da <15 a >20 in 3–5 candele consecutive"
    if regime in ("sideways", "flat") and adx_slope > 1.0:
        risk += 0.20
        triggers.append(f"ADX slope +{adx_slope:.2f}/bar in {regime} — breakout imminent")

    # 8. Grey zone ADX [18,22] — inherently unstable (guide §3)
    # "ADX tra 18 e 22 (zona grigia): Confluence Gate 65+, size ridotta"
    if 18.0 <= adx <= 22.0:
        risk += 0.15
        triggers.append(f"ADX grey zone: {adx:.1f} ∈ [18,22]")

    total = min(1.0, risk)

    if triggers and reasoning is not None:
        reasoning.append(f"Transition risk {total:.2f}: " + " | ".join(triggers))

    return total
