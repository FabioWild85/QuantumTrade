# Reversal Zone Detector — Piano di Implementazione

**Data:** 2026-06-01  
**Autore:** Claude Sonnet 4.6  
**Priorità:** Alta  
**Stima effort:** 8–10 ore di sviluppo  

---

## 1. Obiettivo

Aggiungere al sistema un modulo di **rilevamento inversioni** che operi in parallelo al trend-following esistente, senza interferire con esso. Il modulo:

- Calcola un `reversal_score` (0.0–1.0) aggregando 7 componenti indipendenti
- Identifica direzione dell'inversione probabile (`long` o `short`)
- Apre un trade **contrarian** solo quando il punteggio supera una soglia configurabile **E** un numero minimo di componenti si attiva
- Ha SL/TP dedicati calibrati per la geometria reversal (non quelli del trend-following)
- È completamente disattivabile via toggle sia in live/paper che nel backtest
- Non modifica una riga del codice trend-following esistente

---

## 2. Architettura generale

```
_cycle() / run_backtest()
│
├── build_all_features()                   ← invariato
├── ReversalZoneDetector.score(df, regime) ← NUOVO
│     → ReversalResult(
│           score: float,          # 0.0–1.0 aggregato
│           direction: str|None,   # "long" | "short" | None
│           components: dict,      # punteggio per componente (debug/UI)
│           reasoning: list[str],  # testo leggibile per log
│       )
│
├── DecisionEngine.decide()                ← invariato
│     → DecisionResult (trend signal)
│
└── _apply_reversal_logic()                ← NUOVO (funzione inline in _cycle)
      Regole di routing:
      ┌─────────────────────────────────────────────────────────────────┐
      │ Trend = hold   + reversal_score ≥ threshold → apre reversal    │
      │ Trend = long/short + reversal concorde  → boost confidence      │
      │ Trend = long/short + reversal discorde  → hold (conflitto)      │
      │ reversal_score < threshold              → routing normale       │
      └─────────────────────────────────────────────────────────────────┘
```

**Principio chiave:** Il modulo reversal non sovrascrive mai il trend-following — agisce solo nella finestra in cui il trend dice "hold" o è in conflitto. Se il trend è ancora forte e chiaro, rimane silenzioso.

---

## 2b. Strategia timeframe

Il sistema gira interamente su **4H — incluso il reversal detector in questa fase**. Questa scelta è coerente con il loop esistente e semplifica backtesting e calibrazione.

Tuttavia la pratica professionale prevede una logica **top-down**: identificare la zona di inversione sul timeframe superiore (Daily/Weekly), confermare l'esaurimento sul 4H, ed entrare sul 1H per un SL più stretto. Il vantaggio concreto è un **R:R migliore a parità di stop strutturale** — entrare sul 1H dopo aver visto il setup 4H permette SL del 30–50% più corti.

### Fase 1 — Già implementabile ora: 2 feature Daily

Il sistema calcola già feature Daily in `build_mtf_features()` (`d_rsi`, `d_ema20_dist`, `d_adx`, `d_regime`). Due di queste vengono usate direttamente come **amplificatori del componente `exhaustion`** nel detector:

**`daily_rsi_extreme`** — RSI Daily in zona estrema (>75 o <25). Segnala che non solo il 4H è overextended, ma anche il timeframe superiore conferma l'estremo. Già disponibile come `d_rsi` nelle MTF features.

```python
# Nel ReversalZoneDetector, componente exhaustion:
# Se d_rsi > 75 (top) o d_rsi < 25 (bottom) → moltiplicatore +0.20 sul componente exhaustion
_daily_rsi_extreme_bear = float(features.get("d_rsi", 50) > 75)
_daily_rsi_extreme_bull = float(features.get("d_rsi", 50) < 25)
```

**`daily_ema_dist_extreme`** — Distanza percentuale dal EMA20 Daily in zona storicamente estrema. Un prezzo molto distante dalla media daily segnala overextension cross-timeframe. Già disponibile come `d_ema20_dist`.

```python
# Se |d_ema20_dist| > reversal_daily_ema_dist_extreme (default 4.0 ATR equivalenti)
# → moltiplicatore +0.15 sul componente exhaustion
_daily_ema_extreme = float(abs(features.get("d_ema20_dist", 0)) > cfg.reversal_daily_ema_dist_extreme)
```

Questi due amplificatori **non aggiungono feature al LGBM** e non richiedono calcoli extra — leggono dati già presenti. L'effetto netto: quando sia il 4H che il Daily confermano l'estremo, il componente `exhaustion` riceve un boost, alzando il `reversal_score` finale. Quando solo il 4H è estremo (Daily ancora neutro), il boost non scatta e il detector rimane più cauto.

**Nuovi parametri:**
- `reversal_daily_ema_dist_extreme`: float = 4.0, range 2.0–8.0 — soglia distanza EMA20 Daily
- `reversal_daily_rsi_extreme_high`: float = 75.0, range 70–85 — RSI Daily overbought
- `reversal_daily_rsi_extreme_low`: float = 25.0, range 15–30 — RSI Daily oversold

### Fase 2 — Futura: 1H entry trigger (post-validazione)

Da implementare **solo dopo aver validato il detector 4H in backtest**. La logica: il detector 4H identifica il setup, poi il sistema aspetta un trigger sul 1H (Break of Structure bearish/bullish, FVG fill, OB touch) prima di aprire. Vantaggi: SL più corto, entry più preciso. Richiede che il loop sia event-driven su 1H per i soli trade reversal — refactor non banale, da pianificare separatamente.

---

## 3. Nuove feature da aggiungere a `smc.py` → `build_all_features()`

Le seguenti feature sono necessarie al `ReversalZoneDetector` e vengono aggiunte alla fine di `build_all_features()`. Sono feature pure (no lookahead) calcolate su dati storici.

### 3.1 Divergenza RSI (bearish e bullish)

```python
# RSI Bearish Divergence: price fa nuovo High ma RSI non conferma (segnale top)
# Finestra rolling N barre (default 10) per trovare pivot locali
_rsi_window = 10
_price_high_roll  = d["high"].rolling(_rsi_window).max()
_rsi_high_roll    = d["rsi_14"].rolling(_rsi_window).max()
d["rsi_div_bear"] = (
    (d["high"] >= _price_high_roll) &
    (d["rsi_14"] < _rsi_high_roll * 0.97)  # RSI non raggiunge il max precedente
).astype(float)

# RSI Bullish Divergence: price fa nuovo Low ma RSI non conferma (segnale bottom)
_price_low_roll  = d["low"].rolling(_rsi_window).min()
_rsi_low_roll    = d["rsi_14"].rolling(_rsi_window).min()
d["rsi_div_bull"] = (
    (d["low"] <= _price_low_roll) &
    (d["rsi_14"] > _rsi_low_roll * 1.03)
).astype(float)
```

**Parametro regolabile:** `rsi_div_window` (default 10, range 5–20) — finestra per pivot locali.  
**Parametro regolabile:** `rsi_div_threshold` (default 0.03, range 0.01–0.08) — slack minima tra RSI attuale e suo massimo/minimo.

### 3.2 Divergenza MACD histogram

```python
# MACD Bearish Divergence: price HH ma macd_hist LH
_macd_window = 10
_price_hh     = d["high"].rolling(_macd_window).max()
_macd_prev_hh = d["macd_hist"].rolling(_macd_window).max()
d["macd_div_bear"] = (
    (d["high"] >= _price_hh) &
    (d["macd_hist"] < _macd_prev_hh * 0.90) &
    (d["macd_hist"] < 0)  # già in territorio negativo = conferma
).astype(float)

# MACD Bullish Divergence: price LL ma macd_hist HL
_price_ll     = d["low"].rolling(_macd_window).min()
_macd_prev_ll = d["macd_hist"].rolling(_macd_window).min()
d["macd_div_bull"] = (
    (d["low"] <= _price_ll) &
    (d["macd_hist"] > _macd_prev_ll * 0.90) &
    (d["macd_hist"] > 0)
).astype(float)
```

### 3.3 Volume climax Z-score

```python
# Z-score del volume su finestra rolling 50 barre
# Un volume anomalo (>2.5σ) durante un movimento direzionale estremo
# segnala capitolazione (bottom) o distribuzione (top)
_vol_window = 50
d["vol_z_50"] = (
    (d["volume"] - d["volume"].rolling(_vol_window).mean()) /
    (d["volume"].rolling(_vol_window).std() + 1e-9)
)

# Volume climax bearish (top): spike di volume + prezzo in zona alta + candle bearish
d["vol_climax_bear"] = (
    (d["vol_z_50"] > 2.0) &
    (d["rsi_14"] > 65) &
    (d["close"] < d["open"])  # chiude in rosso su volume estremo = distribuzione
).astype(float)

# Volume climax bullish (bottom): spike di volume + prezzo in zona bassa + candle bullish
d["vol_climax_bull"] = (
    (d["vol_z_50"] > 2.0) &
    (d["rsi_14"] < 35) &
    (d["close"] > d["open"])  # chiude in verde su volume estremo = capitolazione assorbita
).astype(float)
```

**Parametro regolabile:** `vol_climax_z_threshold` (default 2.0, range 1.5–4.0).  
**Parametro regolabile:** `vol_climax_rsi_high` (default 65, range 60–80).  
**Parametro regolabile:** `vol_climax_rsi_low` (default 35, range 20–40).

### 3.4 Wick Rejection Ratio (candela di rigetto)

```python
# Rapporto wick/range totale della candela
# Upper wick dominante = rigetto al rialzo (potenziale top)
# Lower wick dominante = rigetto al ribasso (potenziale bottom)
_candle_range = (d["high"] - d["low"]).replace(0, np.nan)
_body_top     = d[["open", "close"]].max(axis=1)
_body_bot     = d[["open", "close"]].min(axis=1)
_upper_wick   = d["high"] - _body_top
_lower_wick   = _body_bot - d["low"]

d["wick_reject_bear"] = (_upper_wick / _candle_range).clip(0, 1)  # 1.0 = candela tutto wick sopra
d["wick_reject_bull"] = (_lower_wick / _candle_range).clip(0, 1)  # 1.0 = candela tutto wick sotto
```

**Parametro regolabile:** `wick_reject_threshold` (default 0.60, range 0.40–0.85) — rapporto minimo per considerare il wick "dominante".

### 3.5 Stochastic RSI (oscillatore supplementare)

```python
# StochRSI: RSI normalizzato su finestra, poi smoothing %K e %D
# Utile per confermare overbought/oversold quando RSI è già estremo
_stoch_rsi = ta.momentum.StochRSIIndicator(d["close"], window=14, smooth1=3, smooth2=3)
d["stoch_rsi_k"] = _stoch_rsi.stochrsi_k()
d["stoch_rsi_d"] = _stoch_rsi.stochrsi_d()
# Cross bullish: %K attraversa %D dal basso in zona oversold
d["stoch_cross_bull"] = (
    (d["stoch_rsi_k"] > d["stoch_rsi_d"]) &
    (d["stoch_rsi_k"].shift(1) <= d["stoch_rsi_d"].shift(1)) &
    (d["stoch_rsi_k"] < 0.35)
).astype(float)
# Cross bearish: %K attraversa %D dall'alto in zona overbought
d["stoch_cross_bear"] = (
    (d["stoch_rsi_k"] < d["stoch_rsi_d"]) &
    (d["stoch_rsi_k"].shift(1) >= d["stoch_rsi_d"].shift(1)) &
    (d["stoch_rsi_k"] > 0.65)
).astype(float)
```

**Parametro regolabile:** `stoch_rsi_ob` (default 0.65, range 0.60–0.90) — soglia overbought.  
**Parametro regolabile:** `stoch_rsi_os` (default 0.35, range 0.10–0.40) — soglia oversold.

### 3.6 Feature da aggiungere a `FEATURE_GROUPS` e `ALL_FEATURES`

```python
"reversal": [
    "rsi_div_bear", "rsi_div_bull",
    "macd_div_bear", "macd_div_bull",
    "vol_climax_bear", "vol_climax_bull",
    "vol_z_50",
    "wick_reject_bear", "wick_reject_bull",
    "stoch_rsi_k", "stoch_rsi_d",
    "stoch_cross_bull", "stoch_cross_bear",
]
```

> **Nota LGBM:** queste 13 feature vengono aggiunte alla matrice LGBM automaticamente. Il modello le apprende al prossimo retrain. Nessun impatto sulla logica esistente fino al retrain — `getattr(features, key, 0.0)` gestisce il missing safe.

---

## 4. Nuovo file: `services/reversal_detector.py`

### 4.1 Struttura del file

```python
"""
ReversalZoneDetector — identifica zone di top/bottom con alta probabilità.
Calcola un reversal_score aggregando 7 componenti indipendenti.
Operativamente separato dal trend-following: non modifica DecisionEngine.
"""

from dataclasses import dataclass, field
from typing import Optional
import numpy as np
import pandas as pd
import logging

log = logging.getLogger(__name__)


@dataclass
class ReversalResult:
    score: float                     # 0.0–1.0 aggregato pesato
    direction: Optional[str]         # "long" | "short" | None
    components: dict                 # {"structural": 0.8, "momentum": 0.6, ...}
    component_count: int             # numero di componenti che superano soglia
    reasoning: list[str] = field(default_factory=list)


class ReversalZoneDetector:
    """
    Stateless: accetta df già arricchito da build_all_features() + RegimeSignal.
    Restituisce ReversalResult per la barra corrente (ultima riga del df).
    """
    # Pesi per componente (somma = 1.0)
    WEIGHTS = {
        "structural":  0.22,   # OB/FVG/Swing opposto in zona
        "momentum":    0.20,   # Divergenza RSI/MACD/CVD
        "exhaustion":  0.18,   # ADX + consecutive bars + bars_in_regime
        "volume":      0.15,   # Volume climax / capitolazione
        "regime":      0.12,   # transition_risk dal RegimeDetector
        "funding":     0.08,   # Funding estremo (trade affollato)
        "candle":      0.05,   # Wick rejection / Stochastic cross
    }
```

### 4.2 I 7 componenti — logica dettagliata

#### Componente 1: `structural` (peso 0.22)

Valuta se il prezzo si trova in una zona strutturale opposta al trend attuale — il luogo dove il mercato "dovrebbe" rimbalzare secondo la SMC.

**Segnali bear (top):**
- `ob_bear_inside = 1.0` → prezzo dentro OB bearish (zona di offerta istituzionale)
- `ob_bear_dist < reversal_ob_dist_max` → OB bearish entro N×ATR
- `fvg_bear = 1.0` → FVG bearish riempita o in via di riempimento
- `swing_high_px` presente e prezzo vicino al recente swing high (`|price - swing_high_px| < ob_dist_max × ATR`)

**Segnali bull (bottom):**
- `ob_bull_inside = 1.0` → prezzo dentro OB bullish
- `ob_bull_dist < reversal_ob_dist_max` → OB bullish entro N×ATR
- `fvg_bull = 1.0` → FVG bullish in zona
- `swing_low_px` presente e prezzo vicino al recente swing low

Score parziale: media dei segnali attivi, normalizzata 0–1.

#### Componente 2: `momentum` (peso 0.20)

Divergenza tra price action e momentum — il segnale più affidabile per identificare massimi/minimi maturi.

**Segnali bear (top):**
- `rsi_div_bear = 1.0` (RSI non conferma nuovo massimo)
- `macd_div_bear = 1.0` (MACD histogram declina su nuovo massimo)
- `delta_price_div < -0.5` (CVD diverge dal price: acquisti calano su nuovi massimi)

**Segnali bull (bottom):**
- `rsi_div_bull = 1.0`
- `macd_div_bull = 1.0`
- `delta_price_div > 0.5` (vendite calano su nuovi minimi)

**Moltiplicatore aggiuntivo:** Se tutti e 3 i segnali sono attivi nella stessa direzione → score × 1.3 (capped a 1.0). La convergenza tripla è molto rara ma altamente significativa.

#### Componente 3: `exhaustion` (peso 0.18)

Misura l'esaurimento del trend attuale attraverso fattori di durata e intensità.

**Segnali:**
- `consec_bars ≥ reversal_consec_bars_min` (es. ≥ 5 candele consecutive = trend overextended)
- `adx_14 ≥ reversal_adx_peak_min` (ADX in zona picco, es. ≥ 35) — se ADX inizia a scendere dal picco, peso doppio
- ADX declining: `adx_14 < adx_14_lag3` (ADX attuale < ADX 3 barre fa)
- `ema50_dist` in zona estrema: `|ema50_dist| > reversal_ema50_dist_extreme` (prezzo molto distante dalla media)
- `ret_48 > reversal_ret48_extreme` per top o `< -reversal_ret48_extreme` per bottom (rendimento a 48 barre, ~8 giorni, in territorio estremo)

#### Componente 4: `volume` (peso 0.15)

Spike anomali di volume agli estremi segnalano capitolazione (bottom) o distribuzione (top).

**Segnali bear (top):**
- `vol_climax_bear = 1.0` (spike volume + RSI alto + candle rossa)
- `vol_z_50 > vol_climax_z_threshold` (volume anomalo indipendente da direzione)
- `absorption_z > reversal_absorption_z` (alto volume, basso movimento = accumulo/distribuzione)

**Segnali bull (bottom):**
- `vol_climax_bull = 1.0` (spike volume + RSI basso + candle verde)
- `liq_long_z > 1.5` (spike liquidazioni long = capitolazione = classico bottom da cascata)

#### Componente 5: `regime` (peso 0.12)

Sfrutta il `RegimeDetector` già esistente. Alta `transition_risk` indica che il regime sta per cambiare — terreno fertile per un'inversione.

**Segnali:**
- `transition_risk > reversal_transition_risk_min` (es. > 0.55)
- `regime == "transition"` (regime già classificato in transizione)
- `bars_in_regime > reversal_bars_in_regime_min` (es. > 40 barre = trend molto maturo, fragile)

Questo componente è puramente estratto da `RegimeSignal` passato come parametro — zero calcoli extra.

#### Componente 6: `funding` (peso 0.08)

Funding rate estremo segnala un trade affollato. I trade affollati si invertono violentemente quando il consensus si rompe.

**Segnali bear (top, funding positivo estremo = tutti long):**
- `funding_cum48 > reversal_funding_extreme_thr × 48` (funding estremo accumulato su 48 barre)
- `funding_z > 2.0` (funding molto sopra la media)

**Segnali bull (bottom, funding negativo estremo = tutti short):**
- `funding_cum48 < -reversal_funding_extreme_thr × 48`
- `funding_z < -2.0`

#### Componente 7: `candle` (peso 0.05)

Conferma finale sulla singola candela corrente — il "trigger" visivo del setup.

**Segnali bear (top):**
- `wick_reject_bear > reversal_wick_threshold` (wick superiore dominante = rigetto del rialzo)
- `stoch_cross_bear = 1.0` (StochRSI %K through %D dall'alto in zona overbought)

**Segnali bull (bottom):**
- `wick_reject_bull > reversal_wick_threshold` (wick inferiore dominante = rigetto del ribasso)
- `stoch_cross_bull = 1.0` (StochRSI %K through %D dal basso in zona oversold)

### 4.3 Aggregazione finale e direzione

```python
def score(self, df, regime_signal, cfg) -> ReversalResult:
    f = df.iloc[-1].to_dict()  # ultima barra
    
    # Calcola punteggio per ciascun componente
    bear_scores = {comp: self._score_bear(comp, f, regime_signal, cfg) for comp in WEIGHTS}
    bull_scores = {comp: self._score_bull(comp, f, regime_signal, cfg) for comp in WEIGHTS}
    
    bear_total = sum(WEIGHTS[c] * bear_scores[c] for c in WEIGHTS)
    bull_total = sum(WEIGHTS[c] * bull_scores[c] for c in WEIGHTS)
    
    # Direzione dominante
    if bear_total >= bull_total and bear_total >= cfg.reversal_score_threshold:
        direction = "short"
        score_val = bear_total
        components = bear_scores
    elif bull_total > bear_total and bull_total >= cfg.reversal_score_threshold:
        direction = "long"
        score_val = bull_total
        components = bull_scores
    else:
        direction = None
        score_val = max(bear_total, bull_total)
        components = bear_scores if bear_total >= bull_total else bull_scores
    
    # Conta componenti che superano soglia minima (es. > 0.5)
    active = sum(1 for v in components.values() if v > cfg.reversal_component_min_score)
    
    return ReversalResult(
        score=round(score_val, 4),
        direction=direction,
        components=components,
        component_count=active,
        reasoning=self._build_reasoning(direction, components, cfg),
    )
```

**Gate finale:** il trade apre solo se:
1. `reversal_score ≥ cfg.reversal_score_threshold` (es. 0.72)
2. `component_count ≥ cfg.reversal_min_components` (es. 4 su 7)
3. `direction is not None`

> **Modifica a `decision.py`:** Aggiungere `_is_reversal: bool = False` a `DecisionResult`. Il campo viene settato a `True` dal routing reversal in `_cycle()` (sezione 6.2) quando il segnale proviene dal detector — senza di esso il blocco SL/TP dedicato (sezione 6.3) non scatta mai.
> ```python
> @dataclass
> class DecisionResult:
>     action: Action
>     confidence: float
>     reasoning: list[str]
>     features_snapshot: dict
>     directional_prob: float
>     forecast_p10: float
>     forecast_p50: float
>     forecast_p90: float
>     forecast_uncertainty: float = 0.0
>     size_factor: float = 1.0
>     _is_reversal: bool = False   # ← NUOVO: True quando originato da ReversalZoneDetector
> ```
> Nel routing (caso 1, trend=hold), aggiungere `_is_reversal=True` al `DecisionResult` costruito.

### 4.4 Pending Reversal State — logica "limit retest"

#### Il problema dell'entry a chiusura di candela 4H

Quando il sistema rileva un reversal segnale alla chiusura della candela 4H, due scenari negativi sono possibili:

- **Scenario A — inversione già violenta:** il bottom/top è stato toccato durante la candela 4H. Alla chiusura il prezzo si è già mosso del 2–3% nella direzione contraria. Entrare a mercato qui significa: SL lontano (deve coprire tutto il movimento già avvenuto) e TP proporzionalmente distante → R:R invariato ma rischio assoluto più alto.
- **Scenario B — fakeout:** la candela 4H segnala un bottom ma il prezzo continua a scendere ulteriormente nella candela successiva, prima di rimbalzare davvero. Entry a chiusura 4H viene stoppata.

#### La soluzione: entry su retest del wick

Invece di aprire subito a chiusura della candela, il sistema registra un **pending reversal** — un ordine limite interno che attende un pullback (retest) verso la zona del wick della candela segnale.

```
Esempio: inversione bullish
─────────────────────────────────────────────────────────────────
  Candela 4H segnale:
    High:   97,000
    Open:   96,500
    Close:  97,000   ← close (candela bullish su wick enorme)
    Low:    94,800   ← wick_extreme (minimo del wick inferiore)

  wick_range = close - low = 97,000 - 94,800 = 2,200 punti

  entry_limit  = low + wick_range × reversal_retest_wick_pct
               = 94,800 + (2,200 × 0.50) = 95,900
  sl           = low - reversal_sl_atr_mult × ATR
               = 94,800 - (1.2 × 250) = 94,500
  tp           = candle_close + reversal_tp_atr_mult × ATR    ← ancorato alla close, non all'entry
               = 97,000 + (2.5 × 250) = 97,625

  R:R = (97,625 - 95,900) / (95,900 - 94,500) = 1,725 / 1,400 = 1.23

  # Con reversal_tp_atr_mult = 3.0:
  # tp = 97,000 + 750 = 97,750
  # R:R = 1,850 / 1,400 = 1.32  → ancora sotto rr_min = 1.8 con wick molto grande
  #
  # Per superare rr_min = 1.8 su wick estremi serve alzare tp_atr_mult oppure
  # abbassare reversal_retest_wick_pct (entry più vicina al low).
  # Con wick_pct = 0.30: entry = 94,800 + 660 = 95,460
  # R:R = (97,625 - 95,460) / (95,460 - 94,500) = 2,165 / 960 = 2.26 ✓
  #
  # Raccomandazione: calibrare wick_pct e tp_atr_mult insieme in backtest.
─────────────────────────────────────────────────────────────────
```

Il beneficio principale: **il rischio assoluto si riduce significativamente**. Entrando a 95,900 invece di 97,000, si risparmiano 1,100 punti di rischio a parità di SL strutturale (94,500). Con `reversal_size_factor = 0.70` e risk budget fisso, questo permette una size effettiva più alta.

#### State machine

```
IDLE
  │  (reversal signal fires: score ≥ threshold, components ≥ min)
  ▼
PENDING ──────────────────────────────────────────────── expiry_bar raggiunto → EXPIRED → IDLE
  │                                                      oppure: trend trade apre → CANCELLED → IDLE
  │  (price scende/sale dentro entry_limit zone nella candela attuale o entro N barre)
  ▼
TRIGGERED → _open_position() con entry_limit price
```

Lo stato `_reversal_pending` è un dict in memoria (non persistito tra sessioni — se il bot riavvia il pending si perde, ma questo è accettabile per la natura dell'operazione):

```python
_reversal_pending: Optional[dict] = None

# Struttura quando attivo:
{
    "direction":      "long" | "short",
    "entry_limit":    float,       # prezzo entry target
    "sl":             float,       # SL strutturale (sotto wick_extreme)
    "tp":             float,       # TP (sopra entry_limit + N×ATR)
    "wick_extreme":   float,       # low (bull) o high (bear) della candela segnale
    "wick_range":     float,       # |close - wick_extreme| della candela segnale
    "expiry_bar":     int,         # ciclo_corrente + reversal_retest_expiry_bars
    "signal_bar":     int,         # ciclo in cui il segnale è scattato
    "reversal_result": ReversalResult,  # snapshot per logging
    "atr_at_signal":  float,       # ATR al momento del segnale
    "size_factor":    float,       # cfg.reversal_size_factor al momento del segnale
}
```

#### Calcolo `entry_limit` e SL/TP in pending mode

```python
def _build_pending_reversal(direction, candle, reversal_result, cfg, atr, bar_idx) -> dict:
    if direction == "long":
        wick_extreme  = candle["low"]
        candle_close  = candle["close"]
        wick_range    = candle_close - wick_extreme          # positivo
        entry_limit   = wick_extreme + wick_range * cfg.reversal_retest_wick_pct
        sl            = wick_extreme - cfg.reversal_sl_atr_mult * atr
        # TP ancorato alla close della candela segnale (livello naturale del retest)
        # + estensione ATR per margine. Evita il problema del TP ATR-based dall'entry
        # che fallirebbe sempre il R:R check su wick grandi.
        tp            = candle_close + cfg.reversal_tp_atr_mult * atr
    else:  # "short"
        wick_extreme  = candle["high"]
        candle_close  = candle["close"]
        wick_range    = wick_extreme - candle_close          # positivo
        entry_limit   = wick_extreme - wick_range * cfg.reversal_retest_wick_pct
        sl            = wick_extreme + cfg.reversal_sl_atr_mult * atr
        tp            = candle_close - cfg.reversal_tp_atr_mult * atr

    # R:R check preventivo
    rr = abs(tp - entry_limit) / abs(entry_limit - sl + 1e-9)
    if rr < cfg.reversal_rr_min:
        return None  # setup non soddisfa il R:R minimo → non creare pending

    return {
        "direction":      direction,
        "entry_limit":    entry_limit,
        "sl":             sl,
        "tp":             tp,
        "wick_extreme":   wick_extreme,
        "wick_range":     wick_range,
        "expiry_bar":     bar_idx + cfg.reversal_retest_expiry_bars,
        "signal_bar":     bar_idx,
        "reversal_result": reversal_result,
        "atr_at_signal":  atr,
        "size_factor":    cfg.reversal_size_factor,
    }
```

#### Verifica del trigger — paper mode vs live mode

**Questo è il punto più delicato dell'implementazione.** Il `_paper_watchdog` chiama `consume_period_extremes()` ogni 5s — quel metodo **azzera** i valori. Se il pending check chiamasse `consume_period_extremes()` separatamente (es. all'inizio del ciclo 4H), troverebbe sempre `None` perché il watchdog li ha già consumati decine di volte nelle ultime 4 ore.

**Soluzione paper mode — integrare il check dentro `_paper_watchdog`:**

Il check pending va aggiunto direttamente nel body del watchdog, dove `period_low`/`period_high` sono già disponibili (dopo il consume):

```python
# Dentro _paper_watchdog(), dopo la riga:
#   period_low, period_high = self._ws.consume_period_extremes()
# e dopo aver calcolato check_low / check_high:

# ── Pending reversal trigger ──────────────────────────────────────────────────
if self._reversal_pending and not self._position:
    p = self._reversal_pending
    if self._cycle_count >= p["expiry_bar"]:
        log.info("Reversal pending EXPIRED (cycle %d, dir=%s)", self._cycle_count, p["direction"])
        self._reversal_pending = None
        self._persist_reversal_pending(None)
    else:
        triggered = (
            (p["direction"] == "long"  and check_low  <= p["entry_limit"]) or
            (p["direction"] == "short" and check_high >= p["entry_limit"])
        )
        if triggered:
            log.info("Reversal pending TRIGGERED: dir=%s entry=%.2f sl=%.2f tp=%.2f",
                     p["direction"], p["entry_limit"], p["sl"], p["tp"])
            self._reversal_pending = None
            self._persist_reversal_pending(None)
            asyncio.create_task(self._open_reversal_pending_position(p))
    continue  # nessuna posizione aperta, skip SL/TP check
```

Questo sfrutta il `consume` già fatto dal watchdog — nessun secondo consumo, nessun conflitto con SL/TP.

**Soluzione live mode — check al ciclo 4H con `latest_mark`:**

In live il watchdog non gira (l'exchange gestisce SL/TP via trigger orders). Il pending check si aggiunge all'inizio di `_cycle()`, usando `self._ws.latest_mark` come approssimazione:

```python
# All'inizio di _cycle(), prima del decision routing:
if self._reversal_pending and not self._position and self.mode == "live":
    p = self._reversal_pending
    mark = self._ws.latest_mark
    if self._cycle_count >= p["expiry_bar"]:
        log.info("Reversal pending EXPIRED (live, cycle %d)", self._cycle_count)
        self._reversal_pending = None
        self._persist_reversal_pending(None)
    elif mark:
        # In live: approssimazione con mark corrente alla chiusura 4H.
        # Per precisione intracandle in live si userebbe un exchange limit order (Fase 2).
        triggered = (
            (p["direction"] == "long"  and mark <= p["entry_limit"]) or
            (p["direction"] == "short" and mark >= p["entry_limit"])
        )
        if triggered:
            self._reversal_pending = None
            self._persist_reversal_pending(None)
            await self._open_reversal_pending_position(p)
```

> **Nota live mode:** il mark check alla chiusura 4H è meno preciso del monitoraggio intracandle. In pratica questo significa che se il prezzo tocca la zona entry durante la candela ma chiude sopra, il trigger scatta al ciclo successivo (se il prezzo è ancora in zona). Accettabile per la Fase 1 — la Fase 2 può aggiungere un vero exchange limit order per precisione al tick.

#### Compatibilità con `reversal_entry_mode = "close"`

Quando `reversal_entry_mode == "close"`, il sistema ignora completamente la pending state machine e apre subito a mercato alla chiusura della candela segnale — identico al comportamento originale. Questa opzione rende il toggle 100% backward-compatible e permette di testare i due approcci in parallelo con backtest separati.

---

## 5. Parametri configurabili — `BotConfig`

### 5.1 Nuovi campi in `execution.py → class BotConfig`

```python
# ── Reversal Zone Detector ────────────────────────────────────────────────────
self.reversal_mode_enabled       = kw.get("reversal_mode_enabled",       False)  # master toggle
self.reversal_score_threshold    = kw.get("reversal_score_threshold",    0.72)   # soglia score [0.50–0.95]
self.reversal_min_components     = kw.get("reversal_min_components",     4)      # componenti minime [2–7]
self.reversal_component_min_score= kw.get("reversal_component_min_score",0.50)   # score minimo per componente [0.30–0.80]
self.reversal_size_factor        = kw.get("reversal_size_factor",        0.70)   # riduzione size vs trend [0.20–1.00]
self.reversal_sl_atr_mult        = kw.get("reversal_sl_atr_mult",        1.2)    # SL in ATR (più stretto del trend) [0.5–3.0]
self.reversal_tp_atr_mult        = kw.get("reversal_tp_atr_mult",        2.5)    # TP in ATR [1.0–6.0]
self.reversal_rr_min             = kw.get("reversal_rr_min",             1.8)    # R:R minimo accettato [1.0–4.0]
self.reversal_conflict_block     = kw.get("reversal_conflict_block",     True)   # blocca se trend e reversal sono opposti
self.reversal_trend_hold_only    = kw.get("reversal_trend_hold_only",    True)   # solo su segnale trend="hold" (non su trend attivo)
# Parametri dei sotto-componenti
self.reversal_ob_dist_max        = kw.get("reversal_ob_dist_max",        2.0)    # distanza max da OB in ATR [0.5–5.0]
self.reversal_consec_bars_min    = kw.get("reversal_consec_bars_min",    5)      # barre consecutive minime per exhaustion [3–10]
self.reversal_adx_peak_min       = kw.get("reversal_adx_peak_min",       32.0)   # ADX picco minimo [20–50]
self.reversal_ema50_dist_extreme = kw.get("reversal_ema50_dist_extreme", 3.0)    # distanza EMA50 in ATR [1.5–6.0]
self.reversal_ret48_extreme      = kw.get("reversal_ret48_extreme",      0.08)   # rendimento 48-barre estremo [0.03–0.20]
self.reversal_transition_risk_min= kw.get("reversal_transition_risk_min",0.55)   # soglia transition_risk [0.30–0.90]
self.reversal_bars_in_regime_min = kw.get("reversal_bars_in_regime_min", 40)     # maturità minima regime [10–100]
self.reversal_funding_extreme_thr= kw.get("reversal_funding_extreme_thr",0.00025)# soglia funding estremo [0.00010–0.00050]
self.reversal_absorption_z       = kw.get("reversal_absorption_z",       1.8)    # soglia absorption Z [1.0–4.0]
self.reversal_wick_threshold     = kw.get("reversal_wick_threshold",     0.60)   # rapporto wick/range [0.40–0.85]
self.reversal_vol_climax_z       = kw.get("reversal_vol_climax_z",       2.0)    # Z-score volume climax [1.5–4.0]
self.reversal_stoch_ob           = kw.get("reversal_stoch_ob",           0.65)   # StochRSI overbought [0.60–0.90]
self.reversal_stoch_os           = kw.get("reversal_stoch_os",           0.35)   # StochRSI oversold [0.10–0.40]
self.reversal_rsi_div_threshold  = kw.get("reversal_rsi_div_threshold",  0.03)   # slack RSI divergenza [0.01–0.08]
# Amplificatori Daily (usano d_rsi e d_ema20_dist già presenti nelle MTF features)
self.reversal_daily_rsi_extreme_high = kw.get("reversal_daily_rsi_extreme_high", 75.0)  # RSI Daily overbought [70–85]
self.reversal_daily_rsi_extreme_low  = kw.get("reversal_daily_rsi_extreme_low",  25.0)  # RSI Daily oversold [15–30]
self.reversal_daily_ema_dist_extreme = kw.get("reversal_daily_ema_dist_extreme",  4.0)  # distanza EMA20 Daily in ATR [2.0–8.0]
# Pending reversal / limit retest
self.reversal_entry_mode         = kw.get("reversal_entry_mode",         "limit_retest")  # "close" | "limit_retest"
self.reversal_retest_wick_pct    = kw.get("reversal_retest_wick_pct",    0.50)            # zona entry nel wick [0.0–1.0]
self.reversal_retest_expiry_bars = kw.get("reversal_retest_expiry_bars", 2)               # barre prima dell'expiry [1–6]
```

### 5.2 Nuovi campi nel Pydantic `BotConfig` in `main.py`

```python
# Reversal Zone Detector
reversal_mode_enabled:        bool  = Field(False)
reversal_score_threshold:     float = Field(0.72,   ge=0.50, le=0.95)
reversal_min_components:      int   = Field(4,      ge=2,    le=7)
reversal_component_min_score: float = Field(0.50,   ge=0.30, le=0.80)
reversal_size_factor:         float = Field(0.70,   ge=0.20, le=1.00)
reversal_sl_atr_mult:         float = Field(1.2,    ge=0.50, le=3.00)
reversal_tp_atr_mult:         float = Field(2.5,    ge=1.00, le=6.00)
reversal_rr_min:              float = Field(1.8,    ge=1.00, le=4.00)
reversal_conflict_block:      bool  = Field(True)
reversal_trend_hold_only:     bool  = Field(True)
reversal_ob_dist_max:         float = Field(2.0,    ge=0.50, le=5.00)
reversal_consec_bars_min:     int   = Field(5,      ge=3,    le=10)
reversal_adx_peak_min:        float = Field(32.0,   ge=20.0, le=50.0)
reversal_ema50_dist_extreme:  float = Field(3.0,    ge=1.50, le=6.00)
reversal_ret48_extreme:       float = Field(0.08,   ge=0.03, le=0.20)
reversal_transition_risk_min: float = Field(0.55,   ge=0.30, le=0.90)
reversal_bars_in_regime_min:  int   = Field(40,     ge=10,   le=100)
reversal_funding_extreme_thr: float = Field(0.00025,ge=0.00010, le=0.00050)
reversal_absorption_z:        float = Field(1.8,    ge=1.00, le=4.00)
reversal_wick_threshold:      float = Field(0.60,   ge=0.40, le=0.85)
reversal_vol_climax_z:        float = Field(2.0,    ge=1.50, le=4.00)
reversal_stoch_ob:            float = Field(0.65,   ge=0.60, le=0.90)
reversal_stoch_os:            float = Field(0.35,   ge=0.10, le=0.40)
reversal_rsi_div_threshold:        float = Field(0.03,  ge=0.01, le=0.08)
# Amplificatori Daily (zero calcoli extra — leggono d_rsi e d_ema20_dist già presenti)
reversal_daily_rsi_extreme_high:   float = Field(75.0, ge=70.0, le=85.0)
reversal_daily_rsi_extreme_low:    float = Field(25.0, ge=15.0, le=30.0)
reversal_daily_ema_dist_extreme:   float = Field(4.0,  ge=2.00, le=8.00)
# Pending reversal / limit retest
reversal_entry_mode:               Literal["close", "limit_retest"] = Field("limit_retest")
reversal_retest_wick_pct:          float = Field(0.50, ge=0.0,  le=1.0)
reversal_retest_expiry_bars:       int   = Field(2,    ge=1,    le=6)
```

---

## 6. Integrazione in `execution.py → _cycle()`

### 6.1 Punto di inserimento

Subito dopo il calcolo del `RegimeSignal` e prima della `DecisionEngine.decide()`, all'interno del normale flusso del ciclo.

```python
# ── Reversal Zone Detection ───────────────────────────────────────────────────
reversal_result = None
if self.config.reversal_mode_enabled and not self._position:
    from services.reversal_detector import ReversalZoneDetector
    reversal_result = ReversalZoneDetector().score(
        df_feat, self._regime_signal, self.config
    )
    # Inietta il score nelle features per LGBM (feature aggiuntiva)
    latest["reversal_score"]     = reversal_result.score
    latest["reversal_dir_long"]  = 1.0 if reversal_result.direction == "long"  else 0.0
    latest["reversal_dir_short"] = 1.0 if reversal_result.direction == "short" else 0.0
    log.debug("Reversal score=%.3f dir=%s components=%d",
              reversal_result.score, reversal_result.direction,
              reversal_result.component_count)
```

### 6.2 Routing post-decisione

```python
# ── Signal routing: trend vs reversal ────────────────────────────────────────
final_result = result  # default: usa il segnale trend-following

if (reversal_result is not None
    and reversal_result.direction is not None
    and reversal_result.score >= self.config.reversal_score_threshold
    and reversal_result.component_count >= self.config.reversal_min_components):

    trend_action = result.action

    # Caso 1: trend dice hold → reversal prende il controllo
    if trend_action == "hold":
        final_result = DecisionResult(
            action            = reversal_result.direction,
            confidence        = reversal_result.score,
            reasoning         = ["[REVERSAL] " + r for r in reversal_result.reasoning],
            features_snapshot = result.features_snapshot,
            directional_prob  = reversal_result.score,
            forecast_p10      = result.forecast_p10,
            forecast_p50      = result.forecast_p50,
            forecast_p90      = result.forecast_p90,
            forecast_uncertainty = 0.0,
            size_factor       = self.config.reversal_size_factor,
            _is_reversal      = True,   # ← segnala al blocco 6.3/6.4 che è un trade reversal
        )
        log.info("Reversal signal active: %s (score=%.3f, components=%d)",
                 reversal_result.direction.upper(),
                 reversal_result.score, reversal_result.component_count)

    # Caso 2: trend e reversal concordano → boost al trend (raro ma potente)
    elif (trend_action == reversal_result.direction
          and not self.config.reversal_trend_hold_only):
        boost = min(1.0, result.confidence + 0.05)
        final_result = DecisionResult(**{**result.__dict__, "confidence": boost})
        final_result.reasoning.append(
            f"[REVERSAL BOOST] Score={reversal_result.score:.2f}")

    # Caso 3: trend e reversal in conflitto → blocca se configurato
    elif (trend_action != reversal_result.direction
          and self.config.reversal_conflict_block):
        final_result = DecisionResult(
            **{**result.__dict__, "action": "hold"}
        )
        final_result.reasoning.append(
            f"[REVERSAL CONFLICT BLOCK] Trend={trend_action} vs Reversal={reversal_result.direction}")
        log.info("Reversal conflict block: trend=%s, reversal=%s",
                 trend_action, reversal_result.direction)
```

### 6.3 SL/TP dedicati per il trade reversal

Quando `final_result` proviene dal modulo reversal, vengono usati `reversal_sl_atr_mult` e `reversal_tp_atr_mult` invece dei valori di default del trend-following. Questo viene gestito passando una copia temporanea del config con i parametri reversal:

```python
if getattr(final_result, "_is_reversal", False):
    _rev_cfg = copy.copy(self.config)
    _rev_cfg.sl_atr_mult = self.config.reversal_sl_atr_mult
    _rev_cfg.tp_atr_mult = self.config.reversal_tp_atr_mult
    await self._open_position(final_result, snap, atr, inference_id, cfg=_rev_cfg)
else:
    await self._open_position(final_result, snap, atr, inference_id)
```

R:R check: prima di aprire, verificare che `tp_distance / sl_distance ≥ reversal_rr_min`. Se non soddisfatto → hold.

### 6.4 Gestione pending state in `_cycle()`

Il trigger check è descritto nella sezione 4.4. Qui il dettaglio di cosa va aggiunto a `_cycle()`:

```python
# ── All'inizio di _cycle(): cancella pending se nel frattempo è aperta una posizione trend ──
if self._position and self._reversal_pending:
    log.info("Reversal pending CANCELLED: trend position opened")
    self._reversal_pending = None
    self._persist_reversal_pending(None)
```

Il trigger intracandle (paper) è gestito nel `_paper_watchdog` (sezione 4.4).
Il trigger al ciclo (live) è il secondo blocco in sezione 4.4.

#### Cancellazione pending su macro pause

La macro pause blocca correttamente le aperture reversal da `_open_reversal_pending_position()`. Ma un pending già attivo deve essere **cancellato** esplicitamente quando scatta la pausa — altrimenti tenterebbe di aprire nel ciclo successivo (post-evento) su uno setup ormai invalidato:

```python
# Nel blocco macro_pause di _cycle(), dove ora si chiama solo _close_position:
if self._macro_pause_active is None and _macro_event:
    self._macro_pause_active = _macro_event
    if self._reversal_pending:
        log.info("Reversal pending CANCELLED: macro pause (%s)", _macro_event)
        self._reversal_pending = None
        self._persist_reversal_pending(None)
```

#### Persistenza del pending state

`_persist_position_state()` ha un early-return su `not self._position` — non può essere usato direttamente. Va aggiunto un metodo dedicato:

```python
def _persist_reversal_pending(self, pending: Optional[dict]):
    """
    Salva/cancella _reversal_pending su Supabase così sopravvive ai restart.
    Chiamato ogni volta che lo stato cambia (set, triggered, expired, cancelled).
    """
    try:
        db = get_supabase()
        row = db.table("bot_configs").select("params").eq("name", "default").execute()
        existing = (row.data[0].get("params") or {}) if row.data else {}
        existing["_reversal_pending"] = pending  # None = cancella
        db.table("bot_configs").update({"params": existing}).eq("name", "default").execute()
    except Exception as exc:
        log.warning("Could not persist reversal pending state: %s", exc)
```

Il ripristino all'avvio del bot (in `__init__` o `_reconcile_position`):
```python
params = db.table("bot_configs").select("params").eq("name", "default").execute()
self._reversal_pending = (params.data[0].get("params") or {}).get("_reversal_pending")
if self._reversal_pending:
    log.info("Restored reversal pending state: dir=%s entry=%.2f expiry_bar=%d",
             self._reversal_pending["direction"],
             self._reversal_pending["entry_limit"],
             self._reversal_pending["expiry_bar"])
```

#### Routing reversal: set pending vs open immediato

Il blocco di routing in 6.2 viene modificato per rispettare `reversal_entry_mode`:

```python
# Dopo final_result determinato come reversal...
if getattr(final_result, "_is_reversal", False):
    if self.config.reversal_entry_mode == "close":
        # Apertura immediata a mercato (comportamento originale)
        await self._open_position(final_result, snap, atr, inference_id, cfg=_rev_cfg)

    elif self.config.reversal_entry_mode == "limit_retest":
        # Registra il pending invece di aprire subito
        latest_candle = df_feat.iloc[-1].to_dict()
        pending = _build_pending_reversal(
            direction=reversal_result.direction,
            candle=latest_candle,
            reversal_result=reversal_result,
            cfg=self.config,
            atr=atr,
            bar_idx=self._cycle_count,
        )
        if pending:
            self._reversal_pending = pending
            log.info(
                "Reversal PENDING set: dir=%s entry=%.2f sl=%.2f tp=%.2f expiry_bar=%d",
                pending["direction"], pending["entry_limit"],
                pending["sl"], pending["tp"], pending["expiry_bar"],
            )
        else:
            log.info("Reversal signal skipped: R:R < %.1f (%.2f)",
                     self.config.reversal_rr_min, 0.0)
```

#### `_open_reversal_pending_position` — helper

```python
async def _open_reversal_pending_position(self, pending: dict):
    """Apre la posizione reversal con i parametri salvati nel pending dict."""
    # Ricrea un DecisionResult-like con i parametri del segnale originale
    # entry_price = pending["entry_limit"] (al retest, non alla chiusura del segnale)
    # SL e TP già calcolati
    _rev_cfg = copy.copy(self.config)
    _rev_cfg.sl_atr_mult = self.config.reversal_sl_atr_mult
    _rev_cfg.tp_atr_mult = self.config.reversal_tp_atr_mult

    _mock_result = DecisionResult(
        action               = pending["direction"],
        confidence           = pending["reversal_result"].score,
        reasoning            = ["[REVERSAL RETEST TRIGGERED]"] + pending["reversal_result"].reasoning,
        features_snapshot    = {},
        directional_prob     = pending["reversal_result"].score,
        forecast_p10=None, forecast_p50=None, forecast_p90=None,
        forecast_uncertainty = 0.0,
        size_factor          = pending["size_factor"],
        _is_reversal         = True,   # ← necessario per trigger SL/TP dedicati in 6.3
    )
    # Passa SL/TP override espliciti (già calcolati in _build_pending_reversal)
    await self._open_position(
        _mock_result,
        snap=None,                     # price preso da latest_mark al momento del trigger
        atr=pending["atr_at_signal"],
        inference_id=None,
        cfg=_rev_cfg,
        sl_override=pending["sl"],
        tp_override=pending["tp"],
    )
```

> **Nota:** `_open_position` va aggiornato per accettare `sl_override` e `tp_override` opzionali che bypassano il calcolo ATR interno — necessario perché SL/TP sono stati fissati al momento del segnale (candela 4H), non al momento dell'entry (retest).
>
> Quando `sl_override` e `tp_override` sono presenti, saltare la chiamata a `calculate_trade_params()` per il calcolo di SL/TP **e** bypassare i structural TP (`ob_tp_enabled`, `fvg_tp_enabled`, `swing_tp_enabled`) che girerebbero altrimenti in quella funzione — i valori assoluti del pending hanno precedenza assoluta.
> Stessa logica per `dynamic_sl_tp_enabled` e `p10_sl_floor_enabled`: se override presenti, non ricalcolare.

### 6.5 Exit management per trade reversal

**Problema critico:** `_rev_cfg` è una variabile locale usata solo per aprire la posizione. Dopo l'apertura, `_manage_position()` usa `self.config` direttamente. Questo significa che il trailing SL e il BE SL userebbero `self.config.sl_atr_mult` (il moltiplicatore del trend-following), non `reversal_sl_atr_mult`. Il trade aprirebbe con SL corretto ma il trailing lo calcolerà con i parametri sbagliati.

**Fix: store reversal metadata nel position dict**

In `_open_position()`, quando viene chiamato con `cfg._is_reversal = True` (o rilevato dal `DecisionResult`), aggiungere al position dict:

```python
self._position = {
    # ... campi esistenti ...
    "is_reversal":     True,
    "rev_sl_atr_mult": cfg.reversal_sl_atr_mult,   # preserved per trailing SL
    "rev_max_hold":    cfg.reversal_max_hold_bars,  # max hold dedicato
}
```

In `_manage_position()`, leggere i valori dal position dict invece di `self.config`:

```python
_sl_atr = (
    self._position.get("rev_sl_atr_mult", self.config.sl_atr_mult)
    if self._position.get("is_reversal") else self.config.sl_atr_mult
)
_max_hold = (
    self._position.get("rev_max_hold", self.config.max_hold_bars_long)
    if self._position.get("is_reversal") else self.config.max_hold_bars_long
)
```

**Comportamento di default per i meccanismi di exit:**

| Meccanismo | Comportamento reversal |
|------------|----------------------|
| Trailing SL | Attivo se `sl_trailing_enabled = True`, usa `rev_sl_atr_mult` stored nel position dict |
| BE SL | Attivo se `be_sl_enabled = True`, applica stesso shift del trend (non serve moltiplicatore separato) |
| Partial TP | Attivo se `partial_tp_enabled = True` — per reversal potrebbe essere preferibile disabilitarlo via `reversal_partial_tp_enabled` (parametro futuro opzionale) |
| Max hold bars | Usa `reversal_max_hold_bars` (default 6 = 24h) invece di `max_hold_bars_long/short` (tipicamente più lungo) |
| Exit su segnale opposto | Stessa logica trend: se arriva segnale opposto forte, il trade viene chiuso |
| **`lgbm_exit`** | **SKIPPA** — il modello è addestrato su dati trend-following; durante un trade reversal (counter-trend) la probabilità LGBM sarà sistematicamente bassa, causando uscite premature. Fix: `if self._position.get("is_reversal"): skip lgbm_exit block` |
| **`dynamic_sl_tp` / `p10_sl_floor`** | **NON SI APPLICANO** se il trade è aperto con `sl_override`/`tp_override` (override già skippa `calculate_trade_params`) |
| **`ob_tp` / `fvg_tp` / `swing_tp`** | **NON SI APPLICANO** se override presenti (valori assoluti hanno precedenza) |

**Nuovo parametro aggiunto:**
```python
self.reversal_max_hold_bars = kw.get("reversal_max_hold_bars", 6)   # max 24h in 4H bars [2–20]
```

E in `main.py`:
```python
reversal_max_hold_bars: int = Field(6, ge=2, le=20)
```

### 6.6 Compatibilità con i parametri BotConfig esistenti

| Parametro esistente | Comportamento con reversal | Tipo |
|--------------------|---------------------------|------|
| `exhaustion_guard_enabled` | Forza trend=hold → Case 1 reversal fires. **Allineato.** | ✅ Compatibile |
| `consec_bars_filter_enabled` | Blocca trend in direzione esaurita → hold → Case 1. **Allineato.** | ✅ Compatibile |
| `late_entry_filter_enabled` | Gira solo in DecisionEngine (trend signal). Reversal bypassa DecisionEngine. | ✅ Compatibile |
| `path_obstruction_enabled` | Idem — solo DecisionEngine, non raggiunge il reversal. | ✅ Compatibile |
| `adx_gate_enabled` | Idem — solo DecisionEngine. | ✅ Compatibile |
| `sweep_gate_enabled` | Idem — solo DecisionEngine. | ✅ Compatibile |
| `fvg_filter_enabled` | Idem — solo DecisionEngine. | ✅ Compatibile |
| `mtf_alignment_enabled` | Idem — solo DecisionEngine. | ✅ Compatibile |
| `regime_bias_enabled` | Rafforza il trend signal → più casi in cui trend≠hold → meno reversal sul trend attivo. Per design con `reversal_trend_hold_only=True`. | ✅ Compatibile (by design) |
| `fng_gate_enabled` | Extreme fear/greed aggiusta threshold trend → hold → Case 1. Allineato coi segnali reversal. | ✅ Compatibile |
| `funding_gate_enabled` | Allineato col componente funding del detector. Entrambi leggono le stesse condizioni. | ✅ Compatibile |
| `absorption_filter_enabled` | Solo DecisionEngine. | ✅ Compatibile |
| `macro_pause_enabled` | Blocca aperture reversal + cancella pending attivo (sezione 6.4). | ✅ Compatibile (fix applicato) |
| `be_sl_enabled` | Si applica al trade reversal normalmente via position dict. | ✅ Compatibile |
| `trailing_sl_enabled` | Si applica usando `rev_sl_atr_mult` dal position dict (sezione 6.5). | ✅ Compatibile |
| `lgbm_exit_enabled` | LGBM addestrato su trend-following → esce prematuramente dai trade reversal. | ⚠️ Bypassato quando `is_reversal=True` |
| `dynamic_sl_tp_enabled` | Sovrascrive SL/TP reversal. | ⚠️ Bypassato quando override presenti |
| `p10_sl_floor_enabled` | Sovrascrive SL floor reversal. | ⚠️ Bypassato quando override presenti |
| `ob_tp_enabled` / `fvg_tp_enabled` / `swing_tp_enabled` | TP strutturale sovrascrive il TP pre-calcolato. | ⚠️ Bypassato quando override presenti |
| `partial_tp_enabled` | Applicabile ma potenzialmente problematico (TP più stretto per reversal). Da valutare. | ⚠️ Da monitorare in backtest |
| `max_hold_bars_enabled` | Usa `reversal_max_hold_bars` invece di `max_hold_bars` per i trade reversal. | ✅ Compatibile (fix in 6.5) |

---

## 7. Integrazione in `backtesting.py`

### 7.1 Nuovi parametri estratti da `cfg`

```python
# Reversal Zone Detector
reversal_mode_enabled        = getattr(cfg, "reversal_mode_enabled",        False)
reversal_score_threshold     = getattr(cfg, "reversal_score_threshold",     0.72)
reversal_min_components      = getattr(cfg, "reversal_min_components",      4)
reversal_component_min_score = getattr(cfg, "reversal_component_min_score", 0.50)
reversal_size_factor         = getattr(cfg, "reversal_size_factor",         0.70)
reversal_sl_atr_mult         = getattr(cfg, "reversal_sl_atr_mult",         1.2)
reversal_tp_atr_mult         = getattr(cfg, "reversal_tp_atr_mult",         2.5)
reversal_rr_min              = getattr(cfg, "reversal_rr_min",              1.8)
reversal_conflict_block      = getattr(cfg, "reversal_conflict_block",      True)
reversal_trend_hold_only     = getattr(cfg, "reversal_trend_hold_only",     True)
# ... tutti i parametri sotto-componente identicamente
```

### 7.2 Loop per-barra

Nel loop principale del backtest (dopo `decision_engine.decide()`), aggiungere:

```python
# ── Reversal check (per-barra, se abilitato) ──────────────────────────────
reversal_result = None
if reversal_mode_enabled and position is None:
    from services.reversal_detector import ReversalZoneDetector
    reversal_result = ReversalZoneDetector().score(
        df_feat.iloc[:i+1],  # solo dati fino alla barra corrente (no lookahead)
        regime_sig,
        cfg,
    )
```

> **Importante:** il backtester deve passare `df_feat.iloc[:i+1]` (dati fino a `i` incluso) per evitare lookahead bias. Il `ReversalZoneDetector` usa `.iloc[-1]` sull'input.

### 7.3 Statistiche separate nel report backtest

Il risultato del backtest distinguerà i trade per origine:

```python
# Nel dict result finale:
"reversal_stats": {
    "total_trades":   len([t for t in trades if t.get("origin") == "reversal"]),
    "win_rate":       ...,
    "avg_pnl":        ...,
    "total_pnl_usd":  ...,
    "avg_rr":         ...,
},
"trend_stats": {
    "total_trades":   len([t for t in trades if t.get("origin") != "reversal"]),
    # ...
}
```

Ogni trade nel `trades` list ha un campo `"origin": "reversal" | "trend"` aggiunto al momento dell'apertura.

### 7.5 Simulazione pending state nel loop backtest

Nel backtest il pending state è simulabile con precisione usando i dati OHLC per-barra. Non serve il WebSocket — si usano i dati della barra corrente.

```python
# Stato pending (analogo a _reversal_pending in execution.py)
reversal_pending: Optional[dict] = None

# All'interno del loop per-barra, prima del decision routing:
# ── Check pending reversal ────────────────────────────────────────────────────
if reversal_pending and position is None:
    p = reversal_pending

    if i >= p["expiry_bar"]:
        # Expired
        reversal_pending = None
    else:
        bar_low  = df_feat.iloc[i]["low"]
        bar_high = df_feat.iloc[i]["high"]

        triggered = (
            (p["direction"] == "long"  and bar_low  <= p["entry_limit"]) or
            (p["direction"] == "short" and bar_high >= p["entry_limit"])
        )
        if triggered:
            # Apertura trade con parametri del pending
            entry_price = p["entry_limit"]
            position = _open_trade(
                direction = p["direction"],
                entry     = entry_price,
                sl        = p["sl"],
                tp        = p["tp"],
                size_factor = p["size_factor"],
                origin    = "reversal_retest",
                bar_idx   = i,
            )
            reversal_pending = None

# Cancella pending se trend trade apre
if position is not None and reversal_pending is not None:
    reversal_pending = None

# ── Routing segnale reversal → set pending o open immediato ──────────────────
if (reversal_result is not None
    and reversal_result.direction is not None
    and reversal_result.score >= reversal_score_threshold
    and reversal_result.component_count >= reversal_min_components
    and position is None):

    if reversal_entry_mode == "close":
        position = _open_trade(direction=reversal_result.direction, ...)
    elif reversal_entry_mode == "limit_retest":
        _pending = _build_pending_reversal(
            direction=reversal_result.direction,
            candle=df_feat.iloc[i].to_dict(),
            reversal_result=reversal_result,
            cfg=cfg,
            atr=current_atr,
            bar_idx=i,
        )
        if _pending:
            reversal_pending = _pending
```

**Statistica aggiuntiva nel report backtest:**

```python
"reversal_stats": {
    "total_trades":        len([t for t in trades if "reversal" in t.get("origin", "")]),
    "win_rate":            ...,
    "avg_pnl":             ...,
    "total_pnl_usd":       ...,
    "avg_rr":              ...,
    "retest_trigger_rate": len([t for t in trades if t.get("origin") == "reversal_retest"])
                           / max(1, reversal_signals_fired),  # % segnali che hanno trovato il retest
    "expiry_rate":         reversal_expired_count
                           / max(1, reversal_signals_fired),  # % segnali scaduti senza trigger
},
```

`retest_trigger_rate` e `expiry_rate` sono metriche chiave per calibrare `reversal_retest_wick_pct` e `reversal_retest_expiry_bars`: se l'expiry rate è > 60%, la zona entry è troppo aggressiva (wick_pct troppo basso) o il tempo è troppo corto.

### 7.4 Toggle in `BacktestRequest`

`BacktestRequest` in `main.py` ottiene il reversal toggle tramite il campo `config: BotConfig` già esistente — non serve un campo top-level aggiuntivo. L'utente imposta `config.reversal_mode_enabled = True` nel payload, esattamente come tutti gli altri parametri.

---

## 8. UI — `BacktestPanel.tsx`

### 8.1 Sezione da aggiungere

Nella sezione impostazioni avanzate del backtest, aggiungere un gruppo collassabile "Reversal Zone Detector":

```tsx
{/* Reversal Zone Detector */}
<CollapsibleSection title="Reversal Zone Detector" icon="↩">
  <Toggle
    label="Abilita Reversal Mode"
    param="reversal_mode_enabled"
    tooltip="Apre trade contrarian quando il trend si esaurisce in zona strutturale"
  />
  {config.reversal_mode_enabled && (
    <>
      <SliderParam
        label="Score minimo"
        param="reversal_score_threshold"
        min={0.50} max={0.95} step={0.01}
        tooltip="Soglia aggregata (0.72 = alta selettività). Abbassare per più trade, alzare per più precisione."
      />
      <SliderParam
        label="Componenti minime"
        param="reversal_min_components"
        min={2} max={7} step={1}
        tooltip="Numero minimo di conferme indipendenti richieste (4/7 = robusto)"
      />
      <SliderParam
        label="Size factor"
        param="reversal_size_factor"
        min={0.20} max={1.00} step={0.05}
        tooltip="Riduzione size rispetto al trade normale (0.70 = 70%)"
      />
      <SliderParam label="SL ATR mult"    param="reversal_sl_atr_mult"    min={0.5} max={3.0} step={0.1} />
      <SliderParam label="TP ATR mult"    param="reversal_tp_atr_mult"    min={1.0} max={6.0} step={0.1} />
      <SliderParam label="R:R minimo"     param="reversal_rr_min"         min={1.0} max={4.0} step={0.1} />
      <Toggle      label="Blocca conflitti trend/reversal" param="reversal_conflict_block" />
      <Toggle      label="Solo su trend hold"              param="reversal_trend_hold_only" />
    </>
  )}
</CollapsibleSection>
```

### 8.1b Sezione pending reversal (aggiunta all'interno della sezione backtest)

All'interno del gruppo collassabile "Reversal Zone Detector", dopo i parametri di base:

```tsx
{/* Entry mode — toggle dedicato per pending reversal */}
<SegmentedControl
  label="Modalità entry"
  param="reversal_entry_mode"
  options={[
    { value: "limit_retest", label: "Limit Retest",  tooltip: "Aspetta il pullback nel wick prima di entrare — SL più stretto, R:R migliore" },
    { value: "close",        label: "Chiusura 4H",   tooltip: "Entra a mercato alla chiusura della candela segnale (comportamento originale)" },
  ]}
/>
{config.reversal_entry_mode === "limit_retest" && (
  <>
    <SliderParam
      label="% Wick entry"
      param="reversal_retest_wick_pct"
      min={0.0} max={1.0} step={0.05}
      tooltip="Posizione dell'entry nel wick della candela segnale. 0.50 = metà del wick (default). 0.0 = estremo del wick (più aggressivo). 1.0 = chiusura candela (equivalente a mode close)"
    />
    <SliderParam
      label="Scadenza (barre)"
      param="reversal_retest_expiry_bars"
      min={1} max={6} step={1}
      tooltip="Numero di candele 4H entro cui il retest deve avvenire. Se superate senza trigger, il setup viene annullato."
    />
  </>
)}
```

### 8.2 Sezione BotConfig UI (live/paper)

Identica struttura della sezione backtest, nella pagina configurazione bot. I parametri sottostante (ADX peak, OB dist, ecc.) possono essere nascosti in una sezione "parametri avanzati reversal" collassata di default — esposta solo per utenti che vogliono calibrazione fine.

---

### 8.3 ReversalPanel — tab di monitoraggio in tempo reale

Una nuova tab **"Reversal"** nel Trading Hub (accanto alla tab "Regime" già esistente), con una struttura visiva e un flusso dati speculare a `RegimePanel.tsx`.

#### 8.3.1 Struttura dati — interfacce TypeScript

```typescript
interface ReversalComponentScores {
  structural:  number;   // 0.0–1.0
  momentum:    number;
  exhaustion:  number;
  volume:      number;
  regime:      number;
  funding:     number;
  candle:      number;
}

interface ReversalSignal {
  score:           number;                     // 0.0–1.0 aggregato
  direction:       "long" | "short" | null;
  component_count: number;                     // componenti che superano soglia
  components:      ReversalComponentScores;
  reasoning:       string[];
  ts:              string;                     // ISO timestamp dell'ultimo calcolo
  mode_enabled:    boolean;                    // riflette reversal_mode_enabled
}

interface ReversalPendingState {
  direction:      "long" | "short";
  entry_limit:    number;
  sl:             number;
  tp:             number;
  rr:             number;                      // calcolato: |tp-entry| / |entry-sl|
  bars_remaining: number;                      // expiry_bar - cycle_count corrente
  signal_bar:     number;
  wick_extreme:   number;
}

interface ReversalHistoryEntry {
  ts:              string;
  score:           number;
  direction:       "long" | "short" | null;
  component_count: number;
  fired:           boolean;                    // il trade ha aperto (o il pending si è triggerato)
  outcome:         "win" | "loss" | "pending" | "expired" | null;
}
```

#### 8.3.2 API endpoints — `main.py`

```python
@app.get("/reversal/current")
async def get_reversal_current():
    """Ultimo ReversalSignal calcolato + eventuale pending state."""
    # Legge l'ultimo snapshot da Supabase (salvato al termine di ogni _cycle())
    # Restituisce: { signal: ReversalSignal, pending: ReversalPendingState | null }

@app.get("/reversal/history")
async def get_reversal_history(limit: int = 20):
    """Ultimi N segnali reversal con outcome."""
    # Legge da inference_logs filtrando origin="reversal" | "reversal_retest"
    # Restituisce: ReversalHistoryEntry[]
```

Il backend salva un snapshot `ReversalSignal` su Supabase (`bot_configs.params["_reversal_last_signal"]`) alla fine di ogni ciclo quando `reversal_mode_enabled = True`. Se il modulo è disabilitato, l'endpoint restituisce `{ signal: null, pending: null }`.

Polling frontend: **30 secondi** (identico a RegimePanel).

#### 8.3.3 Layout del pannello — `ReversalPanel.tsx`

```
┌─────────────────────────────────────────────────────────────────────┐
│  ↩ Reversal Detection                              [↻ Refresh]      │
│  Monitoraggio zona inversione — aggiornato ogni 4H candle close     │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│  ┌── STATUS CARD (colore dinamico) ────────────────────────────┐   │
│  │                                                              │   │
│  │  ● LONG REVERSAL     Score: 0.74        4/7 componenti      │   │
│  │  ▓▓▓▓▓▓▓▓▓▓▓▓▓░░░░░  74%               ████████░░ soglia   │   │
│  │                                                              │   │
│  │  ┌─ Componenti ───────────────────────────────────────────┐ │   │
│  │  │  Structural   ▓▓▓▓▓▓▓▓░░  0.82  │  Volume    ▓▓▓▓░░░░  0.41│ │
│  │  │  Momentum     ▓▓▓▓▓▓░░░░  0.71  │  Regime    ▓▓▓▓▓░░░  0.58│ │
│  │  │  Exhaustion   ▓▓▓▓▓▓▓░░░  0.77  │  Funding   ▓▓░░░░░░  0.22│ │
│  │  │  Candle       ▓▓▓░░░░░░░  0.35  │                         │ │
│  │  └────────────────────────────────────────────────────────┘ │   │
│  │                                                              │   │
│  │  ▾ Motivazioni (collassabile)                                │   │
│  │    • Divergenza RSI bullish attiva (price LL, RSI HL)        │   │
│  │    • OB bullish a 94,200 — prezzo dentro zona                │   │
│  │    • ADX 38.2 in calo da 3 barre — trend in esaurimento      │   │
│  └──────────────────────────────────────────────────────────────┘   │
│                                                                     │
│  ┌── PENDING STATE (visibile solo se attivo) ──────────────────┐   │
│  │  ⏳ Attesa retest                                             │   │
│  │                                                              │   │
│  │  Entry limit   95,900       SL      94,500                   │   │
│  │  TP            97,750       R:R     1.32                     │   │
│  │  Scadenza: tra 1 barra (≈ 4h)  ████████░░  barra 2/2        │   │
│  └──────────────────────────────────────────────────────────────┘   │
│                                                                     │
│  ┌── STORICO SEGNALI ──────────────────────────────────────────┐   │
│  │  Data/ora         Dir    Score  Comp  Fired  Outcome         │   │
│  │  2026-06-02 08:00  LONG   0.74   4/7    ✓    Win (+2.1%)    │   │
│  │  2026-05-28 20:00  SHORT  0.68   3/7    ✗    Expired        │   │
│  │  2026-05-21 04:00  LONG   0.81   5/7    ✓    Loss (-0.8%)   │   │
│  └──────────────────────────────────────────────────────────────┘   │
│                                                                     │
│  ─ Info ─────────────────────────────────────────────────────────   │
│  Structural 0.22 · Momentum 0.20 · Exhaustion 0.18 · Volume 0.15   │
│  Regime 0.12 · Funding 0.08 · Candle 0.05                          │
└─────────────────────────────────────────────────────────────────────┘
```

#### 8.3.4 Logica colore del status card

| Condizione | Colore | Label |
|-----------|--------|-------|
| `direction == "long" && score ≥ threshold` | Emerald (verde) | LONG REVERSAL |
| `direction == "short" && score ≥ threshold` | Red (rosso) | SHORT REVERSAL |
| `direction != null && score < threshold` | Amber (giallo) | SEGNALE DEBOLE |
| `pending != null` | Blue (blu) | IN ATTESA RETEST |
| `mode_enabled == false` | Slate (grigio) | MODULO DISABILITATO |
| `direction == null` | Slate (grigio) | NESSUN SEGNALE |

#### 8.3.5 Dettaglio componente pending state card

Visibile **solo** quando `pending != null`. Mostra:
- Entry limit, SL, TP come prezzi assoluti
- R:R calcolato dinamicamente
- Barra di progresso scadenza: `bars_remaining / reversal_retest_expiry_bars`
- Countdown testuale: "Scade tra N barra/e (≈ Xh)"

Se il modulo è in modalità `reversal_entry_mode = "close"`, la pending card non appare mai (i trade aprono direttamente).

#### 8.3.6 Integrazione in TradingHubTab

```tsx
// In TradingHubTab.tsx, aggiungere alla navigazione:
{ id: "reversal", label: "Reversal", icon: ArrowUturnLeftIcon }

// Nel render condizionale:
{activeTab === "reversal" && <ReversalPanel apiBase={apiBase} />}
```

La tab è visibile sempre, indipendentemente da `reversal_mode_enabled` — quando disabilitata mostra il pannello grigio con il messaggio "Modulo disabilitato — attiva Reversal Mode in BotConfig".

---

## 9. Modifiche file per file — riepilogo

| File | Tipo modifica | Dettaglio |
|------|--------------|-----------|
| `services/reversal_detector.py` | **NUOVO** | ~350 righe, `ReversalZoneDetector` + `ReversalResult` + `_build_pending_reversal()` |
| `services/decision.py` | **MODIFICA** | +1 campo `_is_reversal: bool = False` a `DecisionResult` |
| `services/smc.py` | **MODIFICA** | +13 feature: RSI div, MACD div, vol climax, wick, StochRSI. Aggiunte a `FEATURE_GROUPS["reversal"]` |
| `services/execution.py` | **MODIFICA** | +31 parametri in `BotConfig.__init__`, routing in `_cycle()` con pending state machine, pending trigger in `_paper_watchdog()`, `_open_position()` accetta `sl_override`/`tp_override` e salva `is_reversal`/`rev_sl_atr_mult`/`rev_max_hold` nel position dict, `_manage_position()` usa valori dal position dict per trailing SL e max hold, `_open_reversal_pending_position()` + `_persist_reversal_pending()` helper |
| `services/backtesting.py` | **MODIFICA** | +31 parametri estratti da cfg, pending state per-barra, `origin` nei trade, `reversal_stats` con `retest_trigger_rate` e `expiry_rate`, max hold basato su `rev_max_hold` per trade reversal |
| `apps/api/main.py` | **MODIFICA** | +31 campi Pydantic in `BotConfig` (aggiunta `Literal` import per `reversal_entry_mode`) |
| `apps/web/components/.../BacktestPanel.tsx` | **MODIFICA** | Sezione UI collapsable "Reversal Zone Detector" con `SegmentedControl` per `reversal_entry_mode` |
| `apps/web/components/.../BotConfigPanel.tsx` | **MODIFICA** | Sezione UI identica per live/paper |
| `apps/web/components/trading-hub/ReversalPanel.tsx` | **NUOVO** | Tab monitoraggio: status card, component breakdown, pending state, storico segnali |
| `apps/web/components/trading-hub/TradingHubTab.tsx` | **MODIFICA** | Aggiunta tab "Reversal" alla navigazione del Trading Hub |

---

## 10. Ordine di implementazione (sequenza raccomandata)

### Fase 1 — Reversal detector 4H + amplificatori Daily

1. **`services/decision.py`** — aggiungere `_is_reversal: bool = False` a `DecisionResult`. Modifica minimale, zero rischi, prerequisito per tutto il resto.
2. **`services/smc.py`** — aggiunta delle 13 nuove feature di base. Testabile in isolamento, no side effects.
3. **`services/reversal_detector.py`** — nuovo file. Include gli amplificatori Daily (`d_rsi`, `d_ema20_dist`) nel componente `exhaustion` e la funzione `_build_pending_reversal()`.
4. **`services/execution.py` + `main.py`** — aggiunta dei 30 parametri BotConfig (24 base + 3 daily + 3 pending). Nessuna logica ancora — solo struttura dati.
5. **`services/execution.py`** — integrazione routing in `_cycle()`, pending trigger in `_paper_watchdog()`, `_open_position()` con `sl_override`/`tp_override` + salvataggio `is_reversal`/`rev_sl_atr_mult`/`rev_max_hold` nel position dict, `_manage_position()` aggiornato per leggere multiplier dal position dict, `_open_reversal_pending_position()` + `_persist_reversal_pending()`. Test su paper mode con `reversal_mode_enabled = False`.
6. **`services/backtesting.py`** — integrazione nel loop per-barra + pending state simulation + statistiche `reversal_stats` con `retest_trigger_rate`/`expiry_rate`.
7. **UI config** — sezioni collassabili in BacktestPanel e BotConfigPanel con `SegmentedControl` per `reversal_entry_mode` e slider condizionali.
8. **UI monitoring** — `ReversalPanel.tsx` + tab "Reversal" in TradingHubTab. Endpoint `GET /reversal/current` e `GET /reversal/history` in `main.py`. Snapshot del segnale salvato su Supabase a ogni ciclo.
9. **Retrain LGBM** — dopo il deploy, avviare un retrain manuale. Prima del retrain il detector funziona in modalità logic-based pura.

### Fase 2 — 1H entry trigger (futura, post-validazione)

Da pianificare in un documento separato **solo dopo** aver verificato in backtest che il detector 4H produce un win rate ≥ 50% e R:R medio ≥ 1.6 sui trade reversal. Prerequisiti tecnici:

- Loop secondario event-driven su 1H (solo per trade reversal in attesa di trigger)
- Rilevamento BOS (Break of Structure) su 1H — nuova funzione in `smc.py`
- Stato `reversal_waiting_1h_trigger` nella posizione per gestire il timeout (max N barre 1H, poi cancella setup)

Stimare separatamente prima di iniziare.

---

## 11. Considerazioni anti-lookahead

Tutte le feature vanno calcolate su dati passati:
- Le divergenze RSI/MACD usano `rolling().max()` su finestre passate → OK
- I pivot swing usano la tecnica già esistente in `smc.py` (`.shift(_sw_n)`) → pattern da replicare
- Lo StochRSI usa solo dati storici → OK
- Nel backtest, passare sempre `df_feat.iloc[:i+1]` al detector → zero lookahead

---

## 12. Calibrazione suggerita per i test iniziali

Per un **profilo conservativo** (pochi trade, alta precisione):
```
reversal_score_threshold    = 0.78
reversal_min_components     = 5
reversal_size_factor        = 0.50
reversal_rr_min             = 2.0
reversal_trend_hold_only    = True
reversal_conflict_block     = True
```

Per un **profilo moderato** (buon bilanciamento):
```
reversal_score_threshold    = 0.72
reversal_min_components     = 4
reversal_size_factor        = 0.70
reversal_rr_min             = 1.8
reversal_trend_hold_only    = True
reversal_conflict_block     = True
```

Per un **profilo aggressivo** (più opportunità, backtest-first):
```
reversal_score_threshold    = 0.62
reversal_min_components     = 3
reversal_size_factor        = 1.00
reversal_rr_min             = 1.5
reversal_trend_hold_only    = False
reversal_conflict_block     = False
```

**Raccomandazione:** iniziare con il profilo conservativo su backtest 2022–2024, verificare le statistiche `reversal_stats` separate, poi calibrare iterativamente prima di abilitare in paper mode.

---

## 13. Note finali

- **Zero interferenza con trend-following:** il routing avviene dopo che `DecisionEngine.decide()` ha già completato. Il trend-following non sa nulla del modulo reversal.
- **Retrain LGBM dopo deploy:** le 13 nuove feature non vengono usate da LGBM fino al primo retrain. Il modello pre-esistente le ignora (feature padding). Non è un problema — il logic-based detector funziona indipendentemente da LGBM.
- **Performance backtesting:** `ReversalZoneDetector.score()` è una funzione Python pura su numpy/pandas, ~0.5ms per barra. Non impatta i tempi di backtest.
- **Toggle sicuro:** `reversal_mode_enabled = False` (default) → il detector non viene mai istanziato e il codice di routing non viene mai eseguito. Zero overhead in produzione quando disattivato.
- **`reversal_entry_mode = "close"` è 100% backward-compatible:** disabilita la pending state machine completamente. Utile per confrontare in backtest le due strategie di entry su periodi identici senza altre variabili.
- **Pending state persistito su Supabase:** `_persist_reversal_pending()` salva il pending dict su `bot_configs.params["_reversal_pending"]` ad ogni cambio di stato (set/triggered/expired/cancelled). Al riavvio, il pending viene ripristinato in `__init__`/`_reconcile_position`. `_persist_position_state()` non può essere usato direttamente perché ha un early-return su `not self._position`.
- **`consume_period_extremes()` chiamato una sola volta per polling interval:** il trigger pending (paper) vive dentro `_paper_watchdog` e usa i valori già consumati dal watchdog stesso — nessun secondo consume, nessun conflitto con il check SL/TP. In live il check avviene a ciclo 4H con `latest_mark` (meno preciso, accettabile per Fase 1).
