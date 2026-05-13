"""
Phase 4 — Enhanced Feature Engineering
Aggiunge: CVD, Order Blocks (OB) SMC completi, Multi-Timeframe (MTF)
Re-esegue walk-forward LightGBM e confronta con baseline 53.8%
"""

import warnings
warnings.filterwarnings("ignore")

import numpy as np
import pandas as pd
import ta
import lightgbm as lgb
from sklearn.metrics import accuracy_score, log_loss
import json
from datetime import datetime

# ─── 1. LOAD DATA ────────────────────────────────────────────────────────────

print("=" * 60)
print("  PHASE 4 — ENHANCED FEATURES  (CVD + OB + MTF)")
print("=" * 60)

df = pd.read_parquet("poc/data_ohlcv.parquet")
df_fund = pd.read_parquet("poc/data_funding.parquet")
df_oi = pd.read_parquet("poc/data_oi.parquet")
df_liq = pd.read_parquet("poc/data_liq.parquet")
df_c2 = pd.read_parquet("poc/data_c2_features.parquet")

# Allinea indice UTC
for d in [df_fund, df_oi, df_liq]:
    d.index = d.index.tz_localize("UTC") if d.index.tz is None else d.index.tz_convert("UTC")
df_c2.index = df_c2.index.tz_localize("UTC") if df_c2.index.tz is None else df_c2.index.tz_convert("UTC")
df.index = df.index.tz_localize("UTC") if df.index.tz is None else df.index.tz_convert("UTC")

print(f"\nOHLCV: {df.shape[0]} candele 4h ({df.index[0].date()} → {df.index[-1].date()})")
print(f"Chronos-2 features: {df_c2.shape[0]} punti")
print(f"OI non-NaN: {df_oi['oi'].notna().sum()}")


# ─── 2. BASE INDICATORS (identiche al POC originale) ─────────────────────────

def build_base_features(df: pd.DataFrame) -> pd.DataFrame:
    """Indicatori tecnici base: RSI, ATR, ADX, MACD, BB, returns, volatilità."""
    d = df.copy()
    close, high, low, vol = d["close"], d["high"], d["low"], d["volume"]

    d["rsi_14"]     = ta.momentum.RSIIndicator(close, 14).rsi()
    d["adx_14"]     = ta.trend.ADXIndicator(high, low, close, 14).adx()
    d["atr_14"]     = ta.volatility.AverageTrueRange(high, low, close, 14).average_true_range()
    d["macd_hist"]  = ta.trend.MACD(close).macd_diff()
    bb              = ta.volatility.BollingerBands(close, 20)
    d["bb_width"]   = (bb.bollinger_hband() - bb.bollinger_lband()) / close
    d["ema20"]      = ta.trend.EMAIndicator(close, 20).ema_indicator()
    d["ema50_dist"] = (close - ta.trend.EMAIndicator(close, 50).ema_indicator()) / d["atr_14"]

    for lag in [1, 3, 6, 12, 24, 48]:
        d[f"ret_{lag}"] = close.pct_change(lag)
    for w in [24, 72]:
        d[f"rv_{w}"] = d["ret_1"].rolling(w).std()

    d["vol_ma"]    = vol.rolling(20).mean()
    d["vol_ratio"] = vol / d["vol_ma"].replace(0, np.nan)
    d["hl_range"]  = (high - low) / close

    return d


# ─── 3. VOLUME DELTA / CVD ───────────────────────────────────────────────────
# Stima buy/sell volume da OHLCV (Haas approximation):
# buy_vol  = vol * (close - low) / (high - low + ε)
# sell_vol = vol - buy_vol
# delta    = buy_vol - sell_vol
# CVD      = cumsum(delta)

def build_cvd_features(df: pd.DataFrame) -> pd.DataFrame:
    d = df.copy()
    hl = (d["high"] - d["low"]).replace(0, np.nan)
    buy_vol  = d["volume"] * (d["close"] - d["low"]) / hl
    sell_vol = d["volume"] - buy_vol
    delta    = buy_vol - sell_vol          # positivo = pressione acquirenti

    d["delta_raw"]    = delta
    d["delta_ma8"]    = delta.rolling(8).mean()
    d["delta_ma24"]   = delta.rolling(24).mean()
    d["cvd"]          = delta.cumsum()
    d["cvd_slope"]    = d["cvd"].diff(6) / (d["atr_14"] * d["volume"].rolling(6).mean() + 1e-9)
    # Imbalance: frazione del volume che è buy (0.5 = neutro, >0.7 = forte buying)
    d["vol_imbalance"] = buy_vol / (d["volume"].replace(0, np.nan))
    # Divergenza: prezzo sale ma delta scende (segnale di debolezza)
    price_slope = d["close"].diff(6)
    delta_slope = d["delta_ma8"].diff(6)
    d["delta_price_div"] = np.where(
        (price_slope > 0) & (delta_slope < 0), -1,   # bearish divergence
        np.where((price_slope < 0) & (delta_slope > 0), 1, 0)  # bullish divergence
    )

    print(f"\n[CVD] Features aggiunte: delta_raw, delta_ma8, delta_ma24, cvd, cvd_slope, vol_imbalance, delta_price_div")
    return d


# ─── 4. ORDER BLOCKS (OB) ────────────────────────────────────────────────────
# Bullish OB: ultima candela bearish (open>close) prima di un impulso bullish
#             che rompe il previous swing high (lookback candles)
# Bearish OB: ultima candela bullish (close>open) prima di un impulso bearish
#             che rompe il previous swing low

def build_order_block_features(df: pd.DataFrame, lookback: int = 20, min_move: float = 0.005) -> pd.DataFrame:
    d = df.copy()
    close, high, low, open_ = d["close"], d["high"], d["low"], d["open"]
    atr = d["atr_14"].copy()

    bull_ob_top    = pd.Series(np.nan, index=d.index)
    bull_ob_bot    = pd.Series(np.nan, index=d.index)
    bull_ob_age    = pd.Series(np.nan, index=d.index)
    bear_ob_top    = pd.Series(np.nan, index=d.index)
    bear_ob_bot    = pd.Series(np.nan, index=d.index)
    bear_ob_age    = pd.Series(np.nan, index=d.index)

    # Dizionari per tenere traccia degli OB attivi più recenti
    active_bull_ob = None  # (top, bot, formed_at)
    active_bear_ob = None

    for i in range(lookback + 1, len(d)):
        # Swing high/low nel lookback precedente
        swing_high = high.iloc[i - lookback: i - 1].max()
        swing_low  = low.iloc[i - lookback: i - 1].min()
        curr_close = close.iloc[i]
        curr_high  = high.iloc[i]
        curr_low   = low.iloc[i]

        # ── Bullish OB: candle corrente rompe swing high dopo una sequenza bearish
        if curr_close > swing_high * (1 + min_move / 2):
            # Cerca l'ultima candela bearish nelle ultime lookback/2 candele
            window = d.iloc[max(0, i - lookback // 2): i]
            bearish_mask = window["open"] > window["close"]
            if bearish_mask.any():
                last_bear_idx = bearish_mask[::-1].idxmax()
                ob_top = d.loc[last_bear_idx, "open"]
                ob_bot = d.loc[last_bear_idx, "low"]
                ob_age_candles = i - d.index.get_loc(last_bear_idx)
                active_bull_ob = (ob_top, ob_bot, i, ob_age_candles)

        # ── Bearish OB: candle corrente rompe swing low dopo sequenza bullish
        if curr_close < swing_low * (1 - min_move / 2):
            window = d.iloc[max(0, i - lookback // 2): i]
            bullish_mask = window["close"] > window["open"]
            if bullish_mask.any():
                last_bull_idx = bullish_mask[::-1].idxmax()
                ob_top = d.loc[last_bull_idx, "high"]
                ob_bot = d.loc[last_bull_idx, "close"]
                ob_age_candles = i - d.index.get_loc(last_bull_idx)
                active_bear_ob = (ob_top, ob_bot, i, ob_age_candles)

        # Propaga OB attivi
        if active_bull_ob is not None:
            top, bot, formed_i, _ = active_bull_ob
            age = i - formed_i
            bull_ob_top.iloc[i] = top
            bull_ob_bot.iloc[i] = bot
            bull_ob_age.iloc[i] = age
            # Invalida OB se il prezzo chiude SOTTO il bot (mitigato e violato)
            if curr_close < bot * 0.998:
                active_bull_ob = None

        if active_bear_ob is not None:
            top, bot, formed_i, _ = active_bear_ob
            age = i - formed_i
            bear_ob_top.iloc[i] = top
            bear_ob_bot.iloc[i] = bot
            bear_ob_age.iloc[i] = age
            if curr_close > top * 1.002:
                active_bear_ob = None

    # Features derivate in unità ATR (normalizzate)
    atr_safe = atr.replace(0, np.nan)
    d["ob_bull_dist"]   = (close - (bull_ob_top + bull_ob_bot) / 2) / atr_safe   # >0 = sopra OB
    d["ob_bear_dist"]   = ((bear_ob_top + bear_ob_bot) / 2 - close) / atr_safe   # >0 = sotto OB
    d["ob_bull_age"]    = bull_ob_age.clip(0, 100)
    d["ob_bear_age"]    = bear_ob_age.clip(0, 100)
    # Flags: prezzo dentro la zona OB (interessante come zona di reazione)
    d["ob_bull_inside"] = ((close >= bull_ob_bot) & (close <= bull_ob_top)).astype(float)
    d["ob_bear_inside"] = ((close >= bear_ob_bot) & (close <= bear_ob_top)).astype(float)
    # Quante ore fa è l'OB più recente di ciascun tipo
    d["ob_bull_active"] = bull_ob_top.notna().astype(float)
    d["ob_bear_active"] = bear_ob_top.notna().astype(float)

    n_bull = bull_ob_top.notna().sum()
    n_bear = bear_ob_top.notna().sum()
    print(f"\n[OB] Bullish OB attivi: {n_bull} candele ({n_bull/len(d)*100:.1f}%)")
    print(f"[OB] Bearish OB attivi: {n_bear} candele ({n_bear/len(d)*100:.1f}%)")

    return d


# ─── 5. MULTI-TIMEFRAME (MTF) ─────────────────────────────────────────────────
# Ricampiona 4h → 1D, calcola EMA20, ADX, RSI giornalieri
# Forward-fill sul 4h per allineare (usa solo dati passati, no lookahead)

def build_mtf_features(df: pd.DataFrame) -> pd.DataFrame:
    d = df.copy()

    # Ricampiona a 1D (usa OHLCV aggregazione canonica)
    daily = df.resample("1D").agg({
        "open":   "first",
        "high":   "max",
        "low":    "min",
        "close":  "last",
        "volume": "sum",
    }).dropna()

    # Indicatori daily
    daily["d_ema20"]  = ta.trend.EMAIndicator(daily["close"], 20).ema_indicator()
    daily["d_adx"]    = ta.trend.ADXIndicator(daily["high"], daily["low"], daily["close"], 14).adx()
    daily["d_rsi"]    = ta.momentum.RSIIndicator(daily["close"], 14).rsi()
    daily["d_atr"]    = ta.volatility.AverageTrueRange(daily["high"], daily["low"], daily["close"], 14).average_true_range()

    # Regime giornaliero
    daily["d_regime"] = np.where(
        (daily["close"] > daily["d_ema20"]) & (daily["d_adx"] > 20), 1,    # bull trend
        np.where((daily["close"] < daily["d_ema20"]) & (daily["d_adx"] > 20), -1, 0)  # bear trend / ranging
    )
    daily["d_ema20_dist"] = (daily["close"] - daily["d_ema20"]) / (daily["d_atr"] + 1e-9)

    # Allinea daily → 4h con forward fill (garantisce no-lookahead: prende il daily CHIUSO)
    daily_4h = daily[["d_ema20", "d_adx", "d_rsi", "d_regime", "d_ema20_dist"]].reindex(
        d.index, method="ffill"
    )

    for col in daily_4h.columns:
        d[col] = daily_4h[col]

    # Feature aggiuntiva: allineamento trend 4h con trend daily
    bos_up   = d["close"] > d["close"].rolling(20).max().shift(1)
    bos_down = d["close"] < d["close"].rolling(20).min().shift(1)
    d["mtf_aligned"] = np.where(
        (bos_up & (d["d_regime"] == 1)) | (bos_down & (d["d_regime"] == -1)), 1.0,
        np.where((bos_up & (d["d_regime"] == -1)) | (bos_down & (d["d_regime"] == 1)), -1.0, 0.0)
    )

    bull_pct = (d["d_regime"] == 1).mean()
    bear_pct = (d["d_regime"] == -1).mean()
    print(f"\n[MTF] Regime daily → 4h: bull={bull_pct:.1%}, ranging={1-bull_pct-bear_pct:.1%}, bear={bear_pct:.1%}")

    return d


# ─── 6. SMC BASE (FVG + Sweep — identici al POC) ────────────────────────────

def build_smc_features(df: pd.DataFrame) -> pd.DataFrame:
    d = df.copy()
    # FVG bullish: low[i-1] > high[i+1]
    d["fvg_bull"] = ((d["low"].shift(-1) > d["high"].shift(1)) &
                     ((d["low"].shift(-1) - d["high"].shift(1)).abs() / d["close"] > 0.001)).astype(float)
    d["fvg_bear"] = ((d["high"].shift(-1) < d["low"].shift(1)) &
                     ((d["high"].shift(-1) - d["low"].shift(1)).abs() / d["close"] > 0.001)).astype(float)
    swing_high = d["high"].rolling(20).max().shift(1)
    swing_low  = d["low"].rolling(20).min().shift(1)
    d["sweep"]  = (((d["high"] > swing_high) & (d["close"] < swing_high)) |
                   ((d["low"] < swing_low) & (d["close"] > swing_low))).astype(float)
    return d


# ─── 7. BUILD FULL FEATURE MATRIX ───────────────────────────────────────────

print("\n→ Costruzione feature matrix...")
df_feat = build_base_features(df)
df_feat = build_cvd_features(df_feat)
df_feat = build_order_block_features(df_feat)
df_feat = build_mtf_features(df_feat)
df_feat = build_smc_features(df_feat)

# Merge dati esterni
df_feat = df_feat.join(df_fund, how="left")
df_feat = df_feat.join(df_oi.rename(columns={"oi": "oi_raw"}), how="left")
df_feat = df_feat.join(df_liq, how="left")

# Feature funding
df_feat["funding_ma24"]  = df_feat["funding"].rolling(24).mean()
df_feat["funding_z"]     = (df_feat["funding"] - df_feat["funding_ma24"]) / (df_feat["funding"].rolling(24).std() + 1e-9)
df_feat["funding_std12"] = df_feat["funding"].rolling(12).std()
df_feat["funding_cum48"] = df_feat["funding"].rolling(48).sum()
df_feat["premium_ma12"]  = df_feat["premium"].rolling(12).mean()
df_feat["premium_z"]     = (df_feat["premium"] - df_feat["premium_ma12"]) / (df_feat["premium"].rolling(12).std() + 1e-9)

# Feature OI
df_feat["oi_ma8"]     = df_feat["oi_raw"].rolling(8).mean()
df_feat["oi_ma_ratio"]= df_feat["oi_raw"] / (df_feat["oi_ma8"].replace(0, np.nan))
df_feat["oi_delta"]   = df_feat["oi_raw"].diff(1)
df_feat["oi_delta_z"] = df_feat["oi_delta"] / (df_feat["oi_raw"].rolling(24).std() + 1e-9)
df_feat["oi_ma24"]    = df_feat["oi_raw"].rolling(24).mean()

# Feature liquidations
df_feat["liq_total"]   = df_feat["liq_long"] + df_feat["liq_short"]
df_feat["liq_sum_24h"] = df_feat["liq_total"].rolling(6).sum()
df_feat["liq_z"]       = (df_feat["liq_total"] - df_feat["liq_total"].rolling(24).mean()) / (df_feat["liq_total"].rolling(24).std() + 1e-9)
df_feat["liq_ratio"]   = df_feat["liq_long"] / (df_feat["liq_total"].replace(0, np.nan))
df_feat["liq_long_z"]  = (df_feat["liq_long"] - df_feat["liq_long"].rolling(24).mean()) / (df_feat["liq_long"].rolling(24).std() + 1e-9)
df_feat["liq_short_z"] = (df_feat["liq_short"] - df_feat["liq_short"].rolling(24).mean()) / (df_feat["liq_short"].rolling(24).std() + 1e-9)

# Merge Chronos-2 (sparse → forward fill limitato a stride=15)
df_feat = df_feat.join(df_c2, how="left")
for col in df_c2.columns:
    df_feat[col] = df_feat[col].ffill(limit=14)

# Target: rialzo in 3 candele (12h)
df_feat["target"] = (df_feat["close"].shift(-3) > df_feat["close"]).astype(int)

# ─── 8. FEATURE SELECTION ────────────────────────────────────────────────────

BASE_FEATURES = [
    "rsi_14", "adx_14", "atr_14", "macd_hist", "bb_width", "ema50_dist",
    "ret_1", "ret_3", "ret_6", "ret_12", "ret_24", "ret_48",
    "rv_24", "rv_72", "vol_ma", "vol_ratio", "hl_range",
]
CVD_FEATURES = [
    "delta_raw", "delta_ma8", "delta_ma24", "cvd_slope",
    "vol_imbalance", "delta_price_div",
]
OB_FEATURES = [
    "ob_bull_dist", "ob_bear_dist", "ob_bull_age", "ob_bear_age",
    "ob_bull_inside", "ob_bear_inside", "ob_bull_active", "ob_bear_active",
]
MTF_FEATURES = [
    "d_ema20_dist", "d_adx", "d_rsi", "d_regime", "mtf_aligned",
]
SMC_FEATURES = ["fvg_bull", "fvg_bear", "sweep"]
FUND_FEATURES = ["funding", "funding_ma24", "funding_z", "funding_std12", "funding_cum48", "premium_z"]
OI_FEATURES   = ["oi_raw", "oi_ma_ratio", "oi_delta", "oi_delta_z", "oi_ma24"]
LIQ_FEATURES  = ["liq_total", "liq_sum_24h", "liq_z", "liq_ratio", "liq_long_z", "liq_short_z"]
C2_FEATURES   = ["c2_dir_prob", "c2_vol_prob", "c2_p10", "c2_p50", "c2_p90",
                  "c2_uncertainty", "c2_cont_prob", "c2_p50_vs_atr"]

ALL_FEATURES = BASE_FEATURES + CVD_FEATURES + OB_FEATURES + MTF_FEATURES + \
               SMC_FEATURES + FUND_FEATURES + OI_FEATURES + LIQ_FEATURES + C2_FEATURES

# Solo feature presenti nel DataFrame
FEATURES = [f for f in ALL_FEATURES if f in df_feat.columns]
print(f"\nFeature totali: {len(FEATURES)} (baseline era 51)")
print(f"  Base: {len(BASE_FEATURES)}  CVD: {len(CVD_FEATURES)}  OB: {len(OB_FEATURES)}  MTF: {len(MTF_FEATURES)}")
print(f"  SMC: {len(SMC_FEATURES)}  Funding: {len(FUND_FEATURES)}  OI: {len(OI_FEATURES)}  Liq: {len(LIQ_FEATURES)}  C2: {len(C2_FEATURES)}")


# ─── 9. WALK-FORWARD VALIDATION ──────────────────────────────────────────────

# Taglia i dati con Chronos-2: solo candles con c2_dir_prob non-NaN
df_valid = df_feat.dropna(subset=["c2_dir_prob", "target"] + BASE_FEATURES)
print(f"\nCandele valide (con C2): {len(df_valid)}")

TRAIN_INIT   = 180    # candele iniziali training (30 giorni)
RETRAIN_STEP = 120    # retraining ogni 120 candele (~20 giorni)

lgb_params = {
    "objective":     "binary",
    "metric":        "binary_logloss",
    "n_estimators":  300,
    "learning_rate": 0.03,
    "max_depth":     4,
    "num_leaves":    31,
    "min_child_samples": 20,
    "subsample":     0.8,
    "colsample_bytree": 0.8,
    "reg_alpha":     0.1,
    "reg_lambda":    0.5,
    "verbose":       -1,
    "random_state":  42,
}

preds_all  = []
labels_all = []
indices_all = []

n = len(df_valid)
train_end = TRAIN_INIT
n_retrain = 0

print(f"\n→ Walk-forward (init={TRAIN_INIT}, step={RETRAIN_STEP})...")

while train_end < n - 3:
    test_end = min(train_end + RETRAIN_STEP, n - 3)
    X_train = df_valid.iloc[:train_end][FEATURES].fillna(0)
    y_train = df_valid.iloc[:train_end]["target"]
    X_test  = df_valid.iloc[train_end:test_end][FEATURES].fillna(0)
    y_test  = df_valid.iloc[train_end:test_end]["target"]

    if len(X_train) < 50 or len(X_test) == 0:
        train_end = test_end
        continue

    model = lgb.LGBMClassifier(**lgb_params)
    model.fit(X_train, y_train)
    proba = model.predict_proba(X_test)[:, 1]

    preds_all.extend(proba)
    labels_all.extend(y_test.tolist())
    indices_all.extend(df_valid.iloc[train_end:test_end].index.tolist())
    n_retrain += 1
    train_end = test_end

preds_arr  = np.array(preds_all)
labels_arr = np.array(labels_all)
pred_binary = (preds_arr > 0.5).astype(int)

acc       = accuracy_score(labels_arr, pred_binary)
ll        = log_loss(labels_arr, preds_arr)
always_long = labels_arr.mean()

print(f"\n{'='*60}")
print(f"  RISULTATI WALK-FORWARD — ENHANCED MODEL")
print(f"{'='*60}")
print(f"  Test rows:        {len(labels_arr):,}")
print(f"  Retraining steps: {n_retrain}")
print(f"  Always-Long base: {always_long:.3f} ({always_long:.1%})")
print(f"  Accuracy:         {acc:.4f} ({acc:.2%})  ← baseline 53.77%")
print(f"  Log-loss:         {ll:.4f}  ← baseline 0.8596")
delta = acc - 0.5377
print(f"  Delta vs baseline: {delta:+.4f} ({delta*100:+.2f}pp)")

# EV con R:R 1.75:1
ev = acc * 1.75 - (1 - acc) * 1.0
print(f"  EV per trade (R:R 1.75): {ev:+.4f}  (break-even > 0)")

# Feature importance (ultimo modello)
fi = pd.Series(model.feature_importances_, index=FEATURES).sort_values(ascending=False)
fi_pct = fi / fi.sum()

print(f"\n  Top 15 feature per importanza:")
for i, (feat, imp) in enumerate(fi_pct.head(15).items()):
    tag = ""
    if feat in CVD_FEATURES: tag = " [CVD]"
    elif feat in OB_FEATURES: tag = " [OB]"
    elif feat in MTF_FEATURES: tag = " [MTF]"
    elif feat in C2_FEATURES: tag = " [C2]"
    elif feat in SMC_FEATURES: tag = " [SMC]"
    print(f"  {i+1:2d}. {feat:<22} {imp:.2%}{tag}")

# Importanza per gruppo
groups = {
    "Chronos-2": C2_FEATURES,
    "OB (nuovo)": OB_FEATURES,
    "CVD (nuovo)": CVD_FEATURES,
    "MTF (nuovo)": MTF_FEATURES,
    "OI": OI_FEATURES,
    "Liquidations": LIQ_FEATURES,
    "Funding": FUND_FEATURES,
    "SMC base": SMC_FEATURES,
    "Base indicators": BASE_FEATURES,
}
print(f"\n  Importanza per gruppo:")
group_imp = {}
for grp, cols in groups.items():
    present = [c for c in cols if c in fi.index]
    imp_grp = fi_pct[present].sum() if present else 0.0
    group_imp[grp] = float(imp_grp)
    print(f"    {grp:<20}: {imp_grp:.1%}")

# ─── 10. CONFRONTO BASELINE ──────────────────────────────────────────────────

print(f"\n  {'─'*50}")
print(f"  CONFRONTO vs POC ORIGINALE (51 feature):")
print(f"  {'─'*50}")
print(f"  Accuracy originale:   53.77%")
print(f"  Accuracy enhanced:    {acc:.2%}")
print(f"  Miglioramento:        {(acc-0.5377)*100:+.2f}pp")
print(f"  Feature aggiunte:     {len(FEATURES)-51:+d} ({len(FEATURES)} totali)")

# Periodo test
idx = pd.DatetimeIndex(indices_all)
print(f"\n  Periodo OOS testato: {idx[0].date()} → {idx[-1].date()}")

# ─── 11. SALVA RISULTATI ────────────────────────────────────────────────────

results = {
    "date": datetime.now().strftime("%Y-%m-%d"),
    "phase": "phase4_enhanced",
    "n_features": len(FEATURES),
    "n_test_rows": len(labels_arr),
    "n_retrain": n_retrain,
    "accuracy": round(float(acc), 4),
    "logloss": round(float(ll), 4),
    "always_long": round(float(always_long), 4),
    "delta_vs_baseline_pp": round((acc - 0.5377) * 100, 2),
    "ev_per_trade_rr175": round(float(ev), 4),
    "group_importance": {k: round(v, 4) for k, v in group_imp.items()},
    "top_features": fi_pct.head(15).index.tolist(),
    "test_date_range": f"{idx[0].date()} → {idx[-1].date()}",
    "new_feature_groups": {
        "CVD": len(CVD_FEATURES),
        "OB": len(OB_FEATURES),
        "MTF": len(MTF_FEATURES),
    }
}

with open("poc/phase4_results.json", "w") as f:
    json.dump(results, f, indent=2)

print(f"\n  Risultati salvati → poc/phase4_results.json")
print(f"{'='*60}\n")
