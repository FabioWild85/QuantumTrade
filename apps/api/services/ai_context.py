"""
AI Decision Layer — context builder.

Trasforma OHLCV (4H) + feature + covariate + verdetto del modello in un DOSSIER
testuale/JSON, deterministico, che l'LLM giudica (vedi `ai_analyst.evaluate`).

Tre strati:
  1. Struttura calcolata (ciò che il modello NON vede): swing HH/HL/LH/LL,
     ultimo evento strutturale BOS/CHoCH, livelli S/R, liquidità, posizione nel
     range, estensione del movimento.
  2. Macro esterno: Fear&Greed, BTC dominance, funding, (OI se disponibile).
  3. Verdetto del modello: azione proposta, prob, entry/SL/TP, R:R, regime.

`build_dossier` è PURA, None-safe e non solleva: in caso di dati insufficienti
ritorna un dossier parziale (i campi mancanti diventano None). La robustezza è
deliberata — il chiamante è in un ciclo di trading e non deve mai rompersi.
"""
from __future__ import annotations

import logging
from datetime import datetime, timezone
from typing import Optional

import numpy as np
import pandas as pd

log = logging.getLogger(__name__)


def _f(x, default=None):
    """float() difensivo."""
    try:
        v = float(x)
        if np.isnan(v) or np.isinf(v):
            return default
        return v
    except (TypeError, ValueError):
        return default


def _detect_swings(df: pd.DataFrame, left: int = 2, right: int = 2, max_swings: int = 6) -> list[dict]:
    """Pivot fractali: un pivot high ha `left` barre più basse a sx e `right` a dx
    (inverso per i low). Ritorna gli ultimi `max_swings` swing in ordine cronologico."""
    if df is None or len(df) < left + right + 1:
        return []
    highs = df["high"].values
    lows = df["low"].values
    n = len(df)
    swings: list[dict] = []
    for i in range(left, n - right):
        wh = highs[i - left:i + right + 1]
        wl = lows[i - left:i + right + 1]
        if highs[i] == wh.max() and (wh == highs[i]).sum() == 1:
            swings.append({"type": "high", "price": round(_f(highs[i], 0.0), 1), "bars_ago": n - 1 - i})
        elif lows[i] == wl.min() and (wl == lows[i]).sum() == 1:
            swings.append({"type": "low", "price": round(_f(lows[i], 0.0), 1), "bars_ago": n - 1 - i})
    return swings[-max_swings:]


def _label_structure(swings: list[dict]) -> str:
    """uptrend = HH+HL, downtrend = LH+LL, altrimenti range/transition."""
    highs = [s["price"] for s in swings if s["type"] == "high"]
    lows = [s["price"] for s in swings if s["type"] == "low"]
    if len(highs) >= 2 and len(lows) >= 2:
        hh = highs[-1] > highs[-2]
        hl = lows[-1] > lows[-2]
        lh = highs[-1] < highs[-2]
        ll = lows[-1] < lows[-2]
        if hh and hl:
            return "uptrend"
        if lh and ll:
            return "downtrend"
        return "range"
    return "undetermined"


def _last_structural_event(swings: list[dict], last_close: float) -> Optional[dict]:
    """BOS = rottura dell'ultimo swing nella direzione del trend; CHoCH = rottura
    contro il trend (primo segnale d'inversione)."""
    if not swings or last_close is None:
        return None
    label = _label_structure(swings)
    last_high = next((s for s in reversed(swings) if s["type"] == "high"), None)
    last_low = next((s for s in reversed(swings) if s["type"] == "low"), None)
    if label == "uptrend":
        if last_high and last_close > last_high["price"]:
            return {"type": "BOS", "direction": "bullish", "level": last_high["price"]}
        if last_low and last_close < last_low["price"]:
            return {"type": "CHoCH", "direction": "bearish", "level": last_low["price"]}
    elif label == "downtrend":
        if last_low and last_close < last_low["price"]:
            return {"type": "BOS", "direction": "bearish", "level": last_low["price"]}
        if last_high and last_close > last_high["price"]:
            return {"type": "CHoCH", "direction": "bullish", "level": last_high["price"]}
    return None


def _key_levels(df: pd.DataFrame, last_close: float, lookback: int = 120, max_each: int = 3) -> dict:
    """Resistenze sopra / supporti sotto, dai pivot dell'ultimo `lookback`."""
    out = {"resistance_above": [], "support_below": []}
    if df is None or last_close is None or len(df) < 10:
        return out
    sub = df.tail(lookback)
    pivots = _detect_swings(sub, left=2, right=2, max_swings=40)
    above = sorted([s["price"] for s in pivots if s["price"] > last_close])
    below = sorted([s["price"] for s in pivots if s["price"] < last_close], reverse=True)
    out["resistance_above"] = [round(p, 1) for p in above[:max_each]]
    out["support_below"] = [round(p, 1) for p in below[:max_each]]
    return out


def _liquidity(df: pd.DataFrame, atr: Optional[float]) -> dict:
    """Estremi recenti (massimo/minimo) come pool di liquidità verso cui il prezzo
    tende; equal highs/lows entro tolleranza ATR."""
    out = {"recent_high": None, "recent_low": None, "equal_highs": False, "equal_lows": False}
    if df is None or len(df) < 20:
        return out
    sub = df.tail(60)
    out["recent_high"] = round(_f(sub["high"].max(), 0.0), 1)
    out["recent_low"] = round(_f(sub["low"].min(), 0.0), 1)
    if atr and atr > 0:
        tol = 0.25 * atr
        top2 = sorted(sub["high"].values)[-2:]
        bot2 = sorted(sub["low"].values)[:2]
        out["equal_highs"] = bool(len(top2) == 2 and abs(top2[0] - top2[1]) < tol)
        out["equal_lows"] = bool(len(bot2) == 2 and abs(bot2[0] - bot2[1]) < tol)
    return out


def _range_metrics(df: pd.DataFrame, last_close: float) -> dict:
    """Posizione % nel range, distanza % dall'estremo recente, barre dall'estremo."""
    out = {"range_position_pct": None, "dist_from_recent_extreme_pct": None, "bars_since_extreme": None}
    if df is None or last_close is None or len(df) < 20:
        return out
    sub = df.tail(60)
    hi = _f(sub["high"].max(), 0.0)
    lo = _f(sub["low"].min(), 0.0)
    if hi and lo and hi > lo:
        out["range_position_pct"] = round((last_close - lo) / (hi - lo) * 100, 1)
    # estremo più vicino e da quante barre
    hi_idx = int(sub["high"].values.argmax())
    lo_idx = int(sub["low"].values.argmin())
    n = len(sub)
    if abs(last_close - hi) <= abs(last_close - lo):
        out["dist_from_recent_extreme_pct"] = round((last_close - hi) / hi * 100, 2) if hi else None
        out["bars_since_extreme"] = n - 1 - hi_idx
    else:
        out["dist_from_recent_extreme_pct"] = round((last_close - lo) / lo * 100, 2) if lo else None
        out["bars_since_extreme"] = n - 1 - lo_idx
    return out


def _tf_block(df: pd.DataFrame, last_close: float, atr: Optional[float]) -> dict:
    swings = _detect_swings(df)
    return {
        "structure_label": _label_structure(swings),
        "swings": swings,
        "last_structural_event": _last_structural_event(swings, last_close),
        "key_levels": _key_levels(df, last_close),
        "liquidity": _liquidity(df, atr),
        **_range_metrics(df, last_close),
    }


def _resample_daily(df: pd.DataFrame) -> Optional[pd.DataFrame]:
    """Resample 4h→1d. Scarta la giornata in corso (incompleta) per non falsare
    high/low/close del Daily. Ritorna None se dati insufficienti."""
    if df is None or len(df) < 12 or not isinstance(df.index, pd.DatetimeIndex):
        return None
    try:
        d = df.resample("1D").agg(
            {"open": "first", "high": "max", "low": "min", "close": "last", "volume": "sum"}
        ).dropna()
        if len(d) >= 2:
            d = d.iloc[:-1]            # esclude la candela daily in corso
        return d if len(d) >= 5 else None
    except Exception:
        return None


def _daily_block(features: dict, df_4h: pd.DataFrame, last_close: float) -> dict:
    """Struttura Daily COMPLETA (resample 4h→1d, giornata in corso esclusa) +
    sintesi dai feature. Il Daily è la struttura HTF dominante: spesso disambigua
    ciò che il 4H da solo non vede (es. nuovo minimo 4H = supporto daily o vuoto?)."""
    d_regime = features.get("d_regime", 0)
    regime_label = {1: "uptrend", -1: "downtrend"}.get(
        int(d_regime) if d_regime is not None else 0, "neutral")
    block = {
        "daily_regime": regime_label,            # da d_regime (EMA/ADX daily)
        "daily_rsi": _f(features.get("d_rsi"), None),
        "regime_state": str(features.get("regime_state", "neutral")),
        "transition_risk": _f(features.get("transition_risk"), 0.0),
    }
    d = _resample_daily(df_4h)
    if d is None:
        block["structure_label"] = regime_label
        return block
    atr_d = _f((d["high"] - d["low"]).tail(14).mean(), None)   # ATR daily semplificato
    swings = _detect_swings(d)
    block.update({
        "structure_label": _label_structure(swings),          # da swing daily reali
        "swings": swings,
        "last_structural_event": _last_structural_event(swings, last_close),
        "key_levels": _key_levels(d, last_close),
        "liquidity": _liquidity(d, atr_d),
        **_range_metrics(d, last_close),
    })
    return block


def _reference_levels(df: pd.DataFrame, last_close: float) -> dict:
    """Massimi/minimi del giorno e settimana precedenti (livelli di riferimento
    classici, su orizzonte più lungo dei pivot 4h). Resample interno, no fonti
    esterne. Posizione del prezzo relativa a ciascuno."""
    out = {"prior_day_high": None, "prior_day_low": None,
           "prior_week_high": None, "prior_week_low": None}
    if df is None or len(df) < 12 or not isinstance(df.index, pd.DatetimeIndex):
        return out
    try:
        d = df.resample("1D").agg({"high": "max", "low": "min"}).dropna()
        if len(d) >= 2:
            out["prior_day_high"] = round(_f(d["high"].iloc[-2], 0.0), 1)
            out["prior_day_low"]  = round(_f(d["low"].iloc[-2], 0.0), 1)
        w = df.resample("1W").agg({"high": "max", "low": "min"}).dropna()
        if len(w) >= 2:
            out["prior_week_high"] = round(_f(w["high"].iloc[-2], 0.0), 1)
            out["prior_week_low"]  = round(_f(w["low"].iloc[-2], 0.0), 1)
    except Exception:
        pass
    return out


def _recent_candles(df: pd.DataFrame, k: int = 6) -> list[dict]:
    """Ultime k candele in forma compatta con frazione di wick — per leggere i
    rifiuti (es. rimbalzo da un minimo: wick inferiore lungo sull'ultima barra)."""
    if df is None or len(df) < k:
        return []
    out = []
    for _, r in df.tail(k).iterrows():
        o, h, l, c = _f(r.get("open")), _f(r.get("high")), _f(r.get("low")), _f(r.get("close"))
        if None in (o, h, l, c):
            continue
        rng = h - l
        upper = max(0.0, h - max(o, c))   # clamp: difende da OHLCV malformato
        lower = max(0.0, min(o, c) - l)
        out.append({
            "close": round(c, 1),
            "range_pct": round(rng / c * 100, 2) if c else None,
            "upper_wick_frac": round(upper / rng, 2) if rng > 0 else 0.0,
            "lower_wick_frac": round(lower / rng, 2) if rng > 0 else 0.0,
            "dir": "up" if c >= o else "down",
        })
    return out


def _orderflow_block(features: dict) -> dict:
    """Order-flow / posizionamento — ORTOGONALE al prezzo. Tutto già calcolato
    nelle feature (CVD da trade HL+Binance, OI, L/S da Coinalyze, volume)."""
    return {
        # CVD: pressione netta dei taker e divergenza col prezzo
        "cvd_slope": _f(features.get("cvd_slope"), None),
        "delta_price_div": _f(features.get("delta_price_div"), None),
        "cross_cvd_div": _f(features.get("cross_cvd_div"), None),
        # Open Interest: variazione e rapporto vs media
        "oi_delta_z": _f(features.get("oi_delta_z"), None),
        "oi_ma_ratio": _f(features.get("oi_ma_ratio"), None),
        # Long/Short ratio (crowd positioning — contrarian agli estremi)
        "ls_ratio": _f(features.get("ls_ratio"), None),
        "long_pct": _f(features.get("long_pct"), None),
        # Volume: anomalia e assorbimento (climax / esaurimento)
        "vol_z_50": _f(features.get("vol_z_50"), None),
        "absorption_z": _f(features.get("absorption_z"), None),
    }


def build_dossier(
    *,
    features: dict,
    df_4h: pd.DataFrame,
    covariates: Optional[dict],
    avg_funding: float,
    decision_result,            # DecisionResult
    current_price: float,
    c2_output: Optional[dict],
    lgbm_prob: float,
    df_1h: Optional[pd.DataFrame] = None,
    dossier_mode: str = "full",          # "full" | "orthogonal"
    intended_sl: Optional[float] = None,  # SL ATR-based stimato (geometria del trade)
    intended_tp: Optional[float] = None,
) -> dict:
    """
    Assembla il dossier. PURA, None-safe, non solleva.

    dossier_mode:
      • "full"       → include anche le OPINIONI del modello (lgbm_prob, c2_dir_prob,
                       model_reasoning): più contesto, ma rischio di anchoring.
      • "orthogonal" → SOLO fatti oggettivi (struttura, livelli, liquidità, order-flow,
                       macro): giudizio AI indipendente dal modello.
    I dati oggettivi (struttura, order-flow, livelli, SL/TP) sono presenti in ENTRAMBE.
    """
    features = features or {}
    covariates = covariates or {}
    c2_output = c2_output or {}
    orthogonal = (dossier_mode == "orthogonal")
    last_close = _f(current_price, None) or _f(features.get("close"), None)
    atr = _f(features.get("atr_14"), None) or _f(features.get("atr"), None)

    # ── Strato 1: struttura ───────────────────────────────────────────────────
    try:
        structure = {
            "daily": _daily_block(features, df_4h, last_close),
            "4h": _tf_block(df_4h, last_close, atr),
            "reference_levels": _reference_levels(df_4h, last_close),
            "recent_candles": _recent_candles(df_4h),
        }
        if df_1h is not None and len(df_1h) > 10:
            structure["1h"] = _tf_block(df_1h, last_close, atr)
    except Exception as exc:
        log.warning("AI Layer build_dossier structure error: %s", exc)
        structure = {"error": str(exc)}

    # ── Strato 2: macro + order-flow ──────────────────────────────────────────
    macro = {
        "fear_greed": _f(covariates.get("fear_greed"), None),
        "fear_greed_class": covariates.get("fear_greed_class"),
        "btc_dominance": _f(covariates.get("btc_dominance"), None),
        "funding_8h_bps": round(_f(avg_funding, 0.0) * 8 * 10000, 2),
    }
    orderflow = _orderflow_block(features)

    # ── Strato 3: verdetto modello ────────────────────────────────────────────
    action = getattr(decision_result, "action", "no_trade")
    # SL/TP: usa quelli stimati (geometria ATR del trade proposto) per dare all'AI
    # il rapporto rischio/rendimento da giudicare. Nota: è la geometria base, non
    # l'eventuale SL strutturale finale.
    sl, tp = _f(intended_sl, None), _f(intended_tp, None)
    rr = None
    if sl and tp and last_close:
        risk = abs(last_close - sl)
        reward = abs(tp - last_close)
        rr = round(reward / risk, 2) if risk > 0 else None

    model_verdict = {
        "proposed_action": action,
        "entry": last_close,
        "intended_stop_loss": sl,
        "intended_take_profit": tp,
        "risk_reward": rr,
        # misure OGGETTIVE (non opinioni del modello) — sempre incluse
        "regime_state": str(features.get("regime_state", "neutral")),
        "adx_14": _f(features.get("adx_14"), None),
        "rsi_14": _f(features.get("rsi_14"), None),
        "atr_pct": round(atr / last_close * 100, 3) if (atr and last_close) else None,
    }
    # OPINIONI del modello — solo in modalità "full"
    if not orthogonal:
        model_verdict["lgbm_prob"] = round(_f(lgbm_prob, 0.0), 4)
        model_verdict["c2_dir_prob"] = _f(c2_output.get("c2_dir_prob"), None)
        model_verdict["threshold_long"] = _f(getattr(decision_result, "threshold_long", None), None)
        model_verdict["threshold_short"] = _f(getattr(decision_result, "threshold_short", None), None)
        model_verdict["model_reasoning"] = list(getattr(decision_result, "reasoning", []) or [])[-12:]

    return {
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "symbol": "BTC",
        "timeframe": "4h",
        "dossier_mode": dossier_mode,
        "structure": structure,
        "macro": macro,
        "orderflow": orderflow,
        "model_verdict": model_verdict,
    }
