"""
Smart Money Concepts (SMC) + Enhanced Feature Engineering.
Production version of poc/phase4_enhanced_features.py.
Includes: FVG, Liquidity Sweep, Market Structure, CVD, Order Blocks, MTF.
"""

import logging
from typing import Optional

import numpy as np
import pandas as pd
import ta

log = logging.getLogger(__name__)


# ─── FVG — Fair Value Gap ─────────────────────────────────────────────────────

def detect_fvg(df: pd.DataFrame, min_gap_pct: float = 0.001) -> pd.DataFrame:
    """
    Bullish FVG: low[i+1] > high[i-1] (gap up — zone di squilibrio rialzista).
    Bearish FVG: high[i+1] < low[i-1] (gap down — zone di squilibrio ribassista).
    """
    d = df.copy()
    gap = (d["low"].shift(-1) - d["high"].shift(1)).abs() / d["close"]
    raw_bull = ((d["low"].shift(-1) > d["high"].shift(1)) & (gap > min_gap_pct)).astype(float)
    raw_bear = ((d["high"].shift(-1) < d["low"].shift(1)) & (gap > min_gap_pct)).astype(float)
    # FVG is only confirmed once the third candle closes (bar i+1).
    # Shift by 1 so the signal is available starting from bar i+1, eliminating lookahead bias.
    d["fvg_bull"] = raw_bull.shift(1).fillna(0.0)
    d["fvg_bear"] = raw_bear.shift(1).fillna(0.0)

    # Absolute price levels of each FVG zone (NaN where no FVG, ffill to carry forward).
    # Bull FVG at bar i: gap between high[i-2] (bot) and low[i] (top).
    # Bear FVG at bar i: gap between high[i] (bot) and low[i-2] (top).
    d["fvg_bull_top_px"] = d["low"].where(d["fvg_bull"] == 1.0).ffill()
    d["fvg_bull_bot_px"] = d["high"].shift(2).where(d["fvg_bull"] == 1.0).ffill()
    d["fvg_bear_top_px"] = d["low"].shift(2).where(d["fvg_bear"] == 1.0).ffill()
    d["fvg_bear_bot_px"] = d["high"].where(d["fvg_bear"] == 1.0).ffill()
    return d


# ─── Liquidity Sweep ─────────────────────────────────────────────────────────

def detect_liquidity_sweep(df: pd.DataFrame, lookback: int = 20) -> pd.DataFrame:
    """
    Price takes swing high/low then closes in the opposite direction.
    Signals potential reversal after retail stop hunt.
    """
    d = df.copy()
    swing_high = d["high"].rolling(lookback).max().shift(1)
    swing_low  = d["low"].rolling(lookback).min().shift(1)
    buyside  = (d["high"] > swing_high) & (d["close"] < swing_high)
    sellside = (d["low"]  < swing_low)  & (d["close"] > swing_low)
    d["sweep"] = (buyside | sellside).astype(float)
    d["sweep_dir"] = np.where(buyside, "buyside", np.where(sellside, "sellside", "none"))
    return d


# ─── Market Structure ─────────────────────────────────────────────────────────

def classify_market_structure(df: pd.DataFrame, lookback: int = 10) -> pd.DataFrame:
    """
    BOS_up   = close > rolling max (last N bars) — bullish continuation.
    BOS_down = close < rolling min (last N bars) — bearish continuation.
    CHoCH is detected when a BOS occurs opposite to the recent trend direction.
    """
    d = df.copy()
    d["bos_up"]   = (d["close"] > d["high"].rolling(lookback).max().shift(1)).astype(float)
    d["bos_down"] = (d["close"] < d["low"].rolling(lookback).min().shift(1)).astype(float)

    structure = []
    last = "ranging"
    for up, down in zip(d["bos_up"], d["bos_down"]):
        if up:
            new = "CHoCH_up" if last in ("BOS_down", "CHoCH_down") else "BOS_up"
        elif down:
            new = "CHoCH_down" if last in ("BOS_up", "CHoCH_up") else "BOS_down"
        else:
            new = last
        structure.append(new)
        last = new

    d["structure"] = structure
    return d


# ─── CVD — Cumulative Volume Delta ───────────────────────────────────────────

def build_cvd_features(df: pd.DataFrame) -> pd.DataFrame:
    """
    Estimate buy/sell volume from OHLCV (Haas approximation).
    buy_vol  = volume × (close − low) / (high − low)
    sell_vol = volume − buy_vol
    delta    = buy_vol − sell_vol  (positive = buying pressure)
    cvd      = cumulative delta
    """
    d = df.copy()
    hl = (d["high"] - d["low"]).replace(0, np.nan)
    buy_vol  = d["volume"] * (d["close"] - d["low"]) / hl
    sell_vol = d["volume"] - buy_vol
    delta    = buy_vol - sell_vol

    d["delta_raw"]     = delta
    d["delta_ma8"]     = delta.rolling(8).mean()
    d["delta_ma24"]    = delta.rolling(24).mean()
    d["cvd"]           = delta.cumsum()
    d["cvd_slope"]     = d["cvd"].diff(6) / (d["atr_14"] * d["volume"].rolling(6).mean() + 1e-9)
    d["vol_imbalance"] = buy_vol / (d["volume"].replace(0, np.nan))

    price_slope = d["close"].diff(6)
    delta_slope = d["delta_ma8"].diff(6)
    d["delta_price_div"] = np.where(
        (price_slope > 0) & (delta_slope < 0), -1.0,
        np.where((price_slope < 0) & (delta_slope > 0), 1.0, 0.0),
    )

    # ── Absorption Score ──────────────────────────────────────────────────────
    # High volume / low price movement = institutions absorbing order flow.
    # Z-scored on a 24-bar rolling window so values are temporally comparable.
    body_size       = (d["close"] - d["open"]).abs()
    atr_floor       = d["atr_14"] * 0.01          # prevents division by near-zero on doji
    raw_absorption  = d["volume"] / (body_size + atr_floor)
    roll_mean       = raw_absorption.rolling(24, min_periods=6).mean()
    roll_std        = raw_absorption.rolling(24, min_periods=6).std().replace(0, np.nan)
    d["absorption_z"] = (raw_absorption - roll_mean) / roll_std
    return d


# ─── Binance Cross-Exchange CVD ──────────────────────────────────────────────

def build_binance_cvd_features(df_4h: pd.DataFrame, df_binance: pd.DataFrame) -> pd.DataFrame:
    """
    Compute cross-exchange CVD features using Binance taker_buy_vol from klines (column c[9]).
    Produces 3 features:
      - binance_cvd_slope:     momentum of net taker pressure on Binance (60%+ of BTC perp volume)
      - binance_absorption_z:  institutional absorption z-score on Binance volume
      - cross_cvd_div:         rolling divergence between Binance and HL CVD slopes.
                               Positive = Binance buying > HL buying (HL catching up → bullish lead).
                               Negative = Binance selling > HL selling (HL catching up → bearish lead).

    Requires df_binance to have 'taker_buy_vol' and 'volume' columns (from get_ohlcv_binance).
    Both Binance and HL use round UTC 4H boundaries — alignment via reindex+ffill is safe.
    """
    d = df_4h.copy()

    bn = df_binance[["volume", "taker_buy_vol"]].reindex(d.index, method="ffill")
    bn_vol = bn["volume"].replace(0, np.nan)
    bn_delta = 2.0 * bn["taker_buy_vol"] - bn_vol

    bn_cvd = bn_delta.cumsum()
    atr = d["atr_14"].replace(0, np.nan)
    vol_ma6 = bn_vol.rolling(6).mean().replace(0, np.nan)
    d["binance_cvd_slope"] = bn_cvd.diff(6) / (atr * vol_ma6 + 1e-9)

    # Absorption: anomalous volume relative to price body (same logic as HL absorption_z)
    body_size = (d["close"] - d["open"]).abs()
    atr_floor = atr * 0.01
    bn_abs_raw = bn_vol / (body_size + atr_floor)
    bn_roll_mean = bn_abs_raw.rolling(24, min_periods=6).mean()
    bn_roll_std = bn_abs_raw.rolling(24, min_periods=6).std().replace(0, np.nan)
    d["binance_absorption_z"] = (bn_abs_raw - bn_roll_mean) / bn_roll_std

    # Cross-exchange divergence: Binance slope vs HL slope, 4-bar smoothed
    hl_slope = d.get("cvd_slope", pd.Series(0.0, index=d.index))
    d["cross_cvd_div"] = (d["binance_cvd_slope"] - hl_slope).rolling(4).mean()

    return d


# ─── Order Blocks ────────────────────────────────────────────────────────────

def build_order_block_features(
    df: pd.DataFrame, lookback: int = 20, min_move: float = 0.005
) -> pd.DataFrame:
    """
    Bullish OB: last bearish candle before a significant bullish move that breaks swing high.
    Bearish OB: last bullish candle before a significant bearish move that breaks swing low.
    Features are distance (ATR-normalized) and whether price is inside the OB zone.
    """
    d = df.copy()
    atr_safe = d["atr_14"].replace(0, np.nan)

    bull_ob_top = pd.Series(np.nan, index=d.index)
    bull_ob_bot = pd.Series(np.nan, index=d.index)
    bull_ob_age = pd.Series(np.nan, index=d.index)
    bear_ob_top = pd.Series(np.nan, index=d.index)
    bear_ob_bot = pd.Series(np.nan, index=d.index)
    bear_ob_age = pd.Series(np.nan, index=d.index)

    active_bull = None
    active_bear = None

    for i in range(lookback + 1, len(d)):
        swing_high = d["high"].iloc[i - lookback: i - 1].max()
        swing_low  = d["low"].iloc[i - lookback: i - 1].min()
        curr_close = d["close"].iloc[i]

        if curr_close > swing_high * (1 + min_move / 2):
            win = d.iloc[max(0, i - lookback // 2): i]
            mask = win["open"] > win["close"]
            if mask.any():
                idx = mask[::-1].idxmax()
                active_bull = (d.loc[idx, "open"], d.loc[idx, "low"], i)

        if curr_close < swing_low * (1 - min_move / 2):
            win = d.iloc[max(0, i - lookback // 2): i]
            mask = win["close"] > win["open"]
            if mask.any():
                idx = mask[::-1].idxmax()
                active_bear = (d.loc[idx, "high"], d.loc[idx, "close"], i)

        if active_bull:
            top, bot, formed = active_bull
            bull_ob_top.iloc[i] = top
            bull_ob_bot.iloc[i] = bot
            bull_ob_age.iloc[i] = i - formed
            if curr_close < bot * 0.998:
                active_bull = None

        if active_bear:
            top, bot, formed = active_bear
            bear_ob_top.iloc[i] = top
            bear_ob_bot.iloc[i] = bot
            bear_ob_age.iloc[i] = i - formed
            if curr_close > top * 1.002:
                active_bear = None

    d["ob_bull_dist"]   = (d["close"] - (bull_ob_top + bull_ob_bot) / 2) / atr_safe
    d["ob_bear_dist"]   = ((bear_ob_top + bear_ob_bot) / 2 - d["close"]) / atr_safe
    d["ob_bull_age"]    = bull_ob_age.clip(0, 100)
    d["ob_bear_age"]    = bear_ob_age.clip(0, 100)
    d["ob_bull_inside"] = ((d["close"] >= bull_ob_bot) & (d["close"] <= bull_ob_top)).astype(float)
    d["ob_bear_inside"] = ((d["close"] >= bear_ob_bot) & (d["close"] <= bear_ob_top)).astype(float)
    d["ob_bull_active"] = bull_ob_top.notna().astype(float)
    d["ob_bear_active"] = bear_ob_top.notna().astype(float)
    # Absolute price levels — used by apply_structural_sl() and pullback entry.
    # Not included in LGBM features (absolute prices are non-stationary).
    d["ob_bull_top_px"] = bull_ob_top
    d["ob_bull_bot_px"] = bull_ob_bot
    d["ob_bear_top_px"] = bear_ob_top
    d["ob_bear_bot_px"] = bear_ob_bot
    return d


# ─── Multi-Timeframe (MTF) ────────────────────────────────────────────────────

def build_mtf_features(df: pd.DataFrame) -> pd.DataFrame:
    """
    Resample 4h → 1D, compute daily EMA20, ADX14, RSI14.
    Forward-fill daily values onto 4h index (no lookahead bias).
    The daily trend context is the single most important predictor (phase4: 20.1% importance).
    """
    d = df.copy()

    daily = df.resample("1D").agg({
        "open": "first", "high": "max", "low": "min", "close": "last", "volume": "sum"
    }).dropna()

    daily["d_ema20"]     = ta.trend.EMAIndicator(daily["close"], 20).ema_indicator()
    daily["d_adx"]       = ta.trend.ADXIndicator(daily["high"], daily["low"], daily["close"], 14).adx()
    daily["d_rsi"]       = ta.momentum.RSIIndicator(daily["close"], 14).rsi()
    daily["d_atr_daily"] = ta.volatility.AverageTrueRange(daily["high"], daily["low"], daily["close"], 14).average_true_range()

    daily["d_regime"] = np.where(
        (daily["close"] > daily["d_ema20"]) & (daily["d_adx"] > 20),  1,
        np.where((daily["close"] < daily["d_ema20"]) & (daily["d_adx"] > 20), -1, 0)
    )
    daily["d_ema20_dist"] = (daily["close"] - daily["d_ema20"]) / (daily["d_atr_daily"] + 1e-9)

    daily_aligned = daily[["d_ema20", "d_adx", "d_rsi", "d_regime", "d_ema20_dist"]].reindex(
        d.index, method="ffill"
    )
    for col in daily_aligned.columns:
        d[col] = daily_aligned[col]

    bos_up   = d["close"] > d["close"].rolling(20).max().shift(1)
    bos_down = d["close"] < d["close"].rolling(20).min().shift(1)
    d["mtf_aligned"] = np.where(
        (bos_up & (d["d_regime"] == 1)) | (bos_down & (d["d_regime"] == -1)),  1.0,
        np.where(
            (bos_up & (d["d_regime"] == -1)) | (bos_down & (d["d_regime"] == 1)), -1.0, 0.0
        )
    )
    return d


# ─── Full Feature Pipeline ────────────────────────────────────────────────────

def build_options_features(
    df: pd.DataFrame,
    iv_7d_value: Optional[float],
    lookback_bars: int = 540,  # 90 days × 6 bars/day
) -> pd.DataFrame:
    """
    Adds options-derived features to df using a single scalar IV value (current bar).
    iv_7d_value: ATM 7-day IV in decimal (e.g. 0.62 = 62% annualised). None = skip.
    The rolling percentile is computed from the iv_7d column itself once enough history
    accumulates in the live process; for early bars it defaults to 50 (neutral).
    """
    d = df.copy()
    if iv_7d_value is None:
        d["iv_7d"]            = np.nan
        d["iv_7d_percentile"] = 50.0
        return d

    # Stamp the current value on the last bar; earlier bars remain NaN (forward-filled downstream).
    # In live/paper use, the column accumulates across cycles via the persistent df_feat window.
    if "iv_7d" not in d.columns:
        d["iv_7d"] = np.nan
    d.iloc[-1, d.columns.get_loc("iv_7d")] = iv_7d_value

    # Rolling percentile rank over lookback_bars (90-day window at 4H resolution).
    # min_periods=30 so it starts producing values after 5 days of data.
    iv_series = d["iv_7d"].ffill()
    rank = iv_series.rolling(lookback_bars, min_periods=30).rank(pct=True) * 100.0
    d["iv_7d_percentile"] = rank.fillna(50.0)  # neutral default until enough history

    return d


def build_all_features(
    df_4h: pd.DataFrame,
    df_funding: pd.DataFrame,
    df_oi: pd.DataFrame,
    df_liq: pd.DataFrame,
    df_binance: Optional[pd.DataFrame] = None,
    binance_cvd_enabled: bool = False,
    options_bias_enabled: bool = False,
    reversal_mode_enabled: bool = False,
    iv_7d_value: Optional[float] = None,
) -> pd.DataFrame:
    """
    Builds the complete feature matrix used by LightGBM.
    Input: aligned DataFrames indexed by UTC timestamp.
    df_binance: optional Binance klines DataFrame with 'taker_buy_vol' column.
                When provided and binance_cvd_enabled=True, adds 3 cross-exchange CVD features.
    iv_7d_value: current ATM 7-day IV from Deribit (decimal). Added when options_bias_enabled
                 OR reversal_mode_enabled, so both modules can use iv_7d_percentile independently.
    """
    d = df_4h.copy()
    close, high, low, vol = d["close"], d["high"], d["low"], d["volume"]

    # ── Base indicators ──────────────────────────────────────────────────────
    d["rsi_14"]    = ta.momentum.RSIIndicator(close, 14).rsi()
    d["adx_14"]    = ta.trend.ADXIndicator(high, low, close, 14).adx()
    d["atr_14"]    = ta.volatility.AverageTrueRange(high, low, close, 14).average_true_range()
    d["atr_21"]    = ta.volatility.AverageTrueRange(high, low, close, 21).average_true_range()

    # Swing High / Low: centered rolling max/min shifted N bars to avoid lookahead.
    # Identifies the most recent confirmed swing pivot (price that was the N-bar extreme).
    _sw_n = 5
    _sh   = d["high"].rolling(2 * _sw_n + 1, center=True).max()
    _sl_r = d["low"].rolling(2 * _sw_n + 1, center=True).min()
    d["swing_high_px"] = d["high"].where(d["high"] == _sh).shift(_sw_n).ffill()
    d["swing_low_px"]  = d["low"].where(d["low"] == _sl_r).shift(_sw_n).ffill()

    d["macd_hist"] = ta.trend.MACD(close).macd_diff()
    bb             = ta.volatility.BollingerBands(close, 20)
    d["bb_width"]  = (bb.bollinger_hband() - bb.bollinger_lband()) / close
    d["ema20"]     = ta.trend.EMAIndicator(close, 20).ema_indicator()
    d["ema50_dist"]= (close - ta.trend.EMAIndicator(close, 50).ema_indicator()) / (d["atr_14"] + 1e-9)

    for lag in [1, 3, 6, 12, 24, 48]:
        d[f"ret_{lag}"] = close.pct_change(lag)
    for w in [24, 72]:
        d[f"rv_{w}"] = d["ret_1"].rolling(w).std()

    d["vol_ma"]    = vol.rolling(20).mean()
    d["vol_ratio"] = vol / (d["vol_ma"].replace(0, np.nan))
    d["hl_range"]  = (high - low) / close

    # ── SMC + CVD + OB + MTF ─────────────────────────────────────────────────
    d = detect_fvg(d)
    d = detect_liquidity_sweep(d)
    d = classify_market_structure(d)
    d = build_cvd_features(d)
    d = build_order_block_features(d)
    d = build_mtf_features(d)

    # ── Funding ───────────────────────────────────────────────────────────────
    # Funding history is 8h-sampled; reindex onto 4h candle timestamps with ffill
    # so every candle inherits the most recent funding rate (no lookahead bias).
    if not df_funding.empty:
        df_funding_aligned = df_funding.reindex(d.index, method="ffill")
        d = d.join(df_funding_aligned, how="left")
    else:
        d["funding"] = np.nan
        d["premium"] = np.nan
    d["funding_ma24"]  = d["funding"].rolling(24).mean()
    d["funding_z"]     = (d["funding"] - d["funding_ma24"]) / (d["funding"].rolling(24).std() + 1e-9)
    d["funding_std12"] = d["funding"].rolling(12).std()
    d["funding_cum48"] = d["funding"].rolling(48).sum()
    d["premium_z"]     = (d["premium"] - d["premium"].rolling(12).mean()) / (d["premium"].rolling(12).std() + 1e-9)

    # ── Open Interest ─────────────────────────────────────────────────────────
    if "oi" in df_oi.columns:
        d = d.join(df_oi.rename(columns={"oi": "oi_raw"}), how="left")
    d["oi_ma8"]      = d.get("oi_raw", pd.Series(dtype=float)).rolling(8).mean()
    d["oi_ma_ratio"] = d.get("oi_raw", pd.Series(dtype=float)) / (d["oi_ma8"].replace(0, np.nan))
    d["oi_delta"]    = d.get("oi_raw", pd.Series(dtype=float)).diff(1)
    d["oi_delta_z"]  = d["oi_delta"] / (d.get("oi_raw", pd.Series(dtype=float)).rolling(24).std() + 1e-9)
    d["oi_ma24"]     = d.get("oi_raw", pd.Series(dtype=float)).rolling(24).mean()

    # ── Liquidations ──────────────────────────────────────────────────────────
    d = d.join(df_liq, how="left")
    if "liq_long" in d.columns and "liq_short" in d.columns:
        d["liq_total"]   = d["liq_long"] + d["liq_short"]
        d["liq_sum_24h"] = d["liq_total"].rolling(6).sum()
        d["liq_z"]       = (d["liq_total"] - d["liq_total"].rolling(24).mean()) / (d["liq_total"].rolling(24).std() + 1e-9)
        d["liq_ratio"]   = d["liq_long"] / (d["liq_total"].replace(0, np.nan))
        d["liq_long_z"]  = (d["liq_long"]  - d["liq_long"].rolling(24).mean())  / (d["liq_long"].rolling(24).std()  + 1e-9)
        d["liq_short_z"] = (d["liq_short"] - d["liq_short"].rolling(24).mean()) / (d["liq_short"].rolling(24).std() + 1e-9)

    # ── Consecutive directional closes ──────────────────────────────────────
    # Positive = consecutive bullish closes, negative = consecutive bearish.
    # Resets to ±1 on direction change; 0 on doji (open == close).
    _closes = d["close"].values
    _opens  = d["open"].values
    _consec = np.zeros(len(d))
    for _ci in range(1, len(d)):
        if _closes[_ci] > _opens[_ci]:
            _consec[_ci] = max(_consec[_ci - 1], 0.0) + 1.0
        elif _closes[_ci] < _opens[_ci]:
            _consec[_ci] = min(_consec[_ci - 1], 0.0) - 1.0
    d["consec_bars"] = _consec

    # ── Binance cross-exchange CVD (optional, requires binance_cvd_enabled + df_binance) ──
    if binance_cvd_enabled and df_binance is not None and not df_binance.empty:
        if "taker_buy_vol" in df_binance.columns:
            d = build_binance_cvd_features(d, df_binance)
        else:
            log.warning("binance_cvd_enabled=True but df_binance has no 'taker_buy_vol' column — skipping")

    # ── Options IV features (optional — active when options_bias_enabled OR reversal_mode_enabled) ──
    if options_bias_enabled or reversal_mode_enabled:
        d = build_options_features(d, iv_7d_value)

    log.debug("Feature matrix: %d columns, %d rows", d.shape[1], len(d))
    return d


# ─── Feature column lists (sync with phase4) ────────────────────────────────

FEATURE_GROUPS = {
    "base": [
        "rsi_14", "adx_14", "atr_14", "macd_hist", "bb_width", "ema50_dist",
        "ret_1", "ret_3", "ret_6", "ret_12", "ret_24", "ret_48",
        "rv_24", "rv_72", "vol_ma", "vol_ratio", "hl_range",
    ],
    "cvd": ["delta_raw", "delta_ma8", "delta_ma24", "cvd_slope", "vol_imbalance", "delta_price_div", "absorption_z"],
    # Cross-exchange CVD (Binance taker flow). Only populated when binance_cvd_enabled=True.
    # Ignored by LightGBM until a retrain with these features is run.
    "cvd_x": ["binance_cvd_slope", "binance_absorption_z", "cross_cvd_div"],
    "ob":  ["ob_bull_dist", "ob_bear_dist", "ob_bull_age", "ob_bear_age",
             "ob_bull_inside", "ob_bear_inside", "ob_bull_active", "ob_bear_active"],
    "mtf": ["d_ema20_dist", "d_adx", "d_rsi", "d_regime", "mtf_aligned"],
    "smc": ["fvg_bull", "fvg_bear", "sweep"],
    "funding": ["funding", "funding_ma24", "funding_z", "funding_std12", "funding_cum48", "premium_z"],
    "oi":  ["oi_raw", "oi_ma_ratio", "oi_delta", "oi_delta_z", "oi_ma24"],
    "liq": ["liq_total", "liq_sum_24h", "liq_z", "liq_ratio", "liq_long_z", "liq_short_z"],
    "c2":  ["c2_dir_prob", "c2_vol_prob", "c2_p10", "c2_p50", "c2_p90",
             "c2_uncertainty", "c2_cont_prob", "c2_p50_vs_atr"],
    # Options IV features (Phase 1). Only populated when options_bias_enabled OR reversal_mode_enabled.
    # Included in LGBM training automatically on next retrain when those flags are active.
    "options_phase1": ["iv_7d", "iv_7d_percentile"],
}

ALL_FEATURES = [f for group in FEATURE_GROUPS.values() for f in group]
