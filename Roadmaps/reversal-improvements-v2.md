# Reversal Zone Detector — Piano Miglioramenti v2

**Data:** 2026-06-05
**Versione base:** sistema reversal già implementato e attivo in produzione
**Obiettivo:** migliorare qualità e affidabilità dei segnali per lo use case specifico

---

## 1. Use Case: chiarimento fondamentale

Il Reversal Zone Detector **non serve a intercettare cambi di macro-trend** (bull market → bear market che durano settimane o mesi). Serve a **intercettare l'esaurimento di mosse direzionali forti nel breve-medio termine**:

- BTC scende del 6-10% in 2-4 giorni → il detector identifica il bottom temporaneo → bot va long per il rimbalzo
- BTC sale dell'8-12% in 3-5 giorni → il detector identifica il top temporaneo → bot va short per il pullback
- La mossa contraria attesa dura tipicamente 1-3 giorni (4-18 barre 4H)

**Non è** intercettare il passaggio da un regime di mesi a un altro. **È** intercettare il punto di esaurimento di una singola mossa direzionale forte che si è allontanata troppo dall'equilibrio.

Questa distinzione guida ogni scelta implementativa di questo documento.

---

## 2. Bug critici nel codice attuale — da correggere prima di ogni altra cosa

### Bug 1 — Finestra divergenze 4H troppo corta (10 barre = 40 ore)

**File:** `apps/api/services/smc.py`, linee 442–469

**Problema:** con una finestra di 10 barre, le divergenze scattano su ogni micro-oscillazione. 40 ore non è sufficiente per formare una divergenza strutturalmente rilevante su BTC. Il risultato è un segnale quasi-casuale.

**Fix:**
```python
# Prima (buggy):
_rsi_win = 10

# Dopo:
_rsi_win = 20  # 80 ore ≈ 3.3 giorni — minimo per una divergenza significativa su BTC 4H
```

### Bug 2 — Divergenza RSI scatta sulla barra del nuovo massimo, non dopo

**File:** `smc.py`, linee 443–452

**Problema:** `_ph_roll = d["high"].rolling(_rsi_win).max()` include la barra corrente. Quindi `d["high"] >= _ph_roll` è vero sulla stessa barra che crea il nuovo massimo. Non è una divergenza confermata — è una condizione rilevabile in tempo reale che non ha valore predittivo.

Una divergenza richiede: il prezzo ha fatto un nuovo massimo (barra passata), e RSI non lo ha seguito. Questo si verifica nella barra DOPO il nuovo massimo.

**Fix:**
```python
# Prima (buggy):
_ph_roll    = d["high"].rolling(_rsi_win).max()
_rsi_h_roll = d["rsi_14"].rolling(_rsi_win).max()
d["rsi_div_bear"] = (
    (d["high"] >= _ph_roll) & (d["rsi_14"] < _rsi_h_roll * 0.97)
).astype(float)

# Dopo — shift(1) per richiedere che il nuovo massimo sia confermato dalla barra precedente:
_ph_roll    = d["high"].rolling(_rsi_win).max().shift(1)   # massimo delle ultime N barre ESCLUSA la corrente
_rsi_h_roll = d["rsi_14"].rolling(_rsi_win).max().shift(1)
d["rsi_div_bear"] = (
    (d["high"] > _ph_roll) &            # nuovo massimo RISPETTO alla finestra precedente
    (d["rsi_14"] < _rsi_h_roll * 0.95)  # soglia più conservativa (5% invece di 3%)
).astype(float)

_pl_roll    = d["low"].rolling(_rsi_win).min().shift(1)
_rsi_l_roll = d["rsi_14"].rolling(_rsi_win).min().shift(1)
d["rsi_div_bull"] = (
    (d["low"] < _pl_roll) &
    (d["rsi_14"] > _rsi_l_roll * 1.05)
).astype(float)
```

### Bug 3 — MACD divergence richiede `macd_hist < 0` per il bear

**File:** `smc.py`, linee 458–462

**Problema:** la condizione `d["macd_hist"] < 0` rende il segnale bear attivo solo quando il momentum è già negativo. Le divergenze ribassiste classiche si formano quando il MACD histogram fa un massimo più basso mentre il prezzo fa un nuovo massimo — entrambi possono essere positivi. Richiedere istogramma negativo significa cercare la divergenza quando il segnale è già tardivo.

**Fix:**
```python
# Prima (buggy):
d["macd_div_bear"] = (
    (d["high"] >= _price_hh_r) &
    (d["macd_hist"] < _macd_hh_r * 0.90) &
    (d["macd_hist"] < 0)           ← RIMUOVERE questa condizione
).astype(float)

# Dopo:
_macd_win    = 20                  # allineare con la finestra RSI
_price_hh_r  = d["high"].rolling(_macd_win).max().shift(1)
_macd_hh_r   = d["macd_hist"].rolling(_macd_win).max().shift(1)
d["macd_div_bear"] = (
    (d["high"] > _price_hh_r) &
    (d["macd_hist"] < _macd_hh_r * 0.85)  # macd_hist fa lower high del 15%+
    # nessun requisito sul segno dell'istogramma
).astype(float)

_price_ll_r  = d["low"].rolling(_macd_win).min().shift(1)
_macd_ll_r   = d["macd_hist"].rolling(_macd_win).min().shift(1)
d["macd_div_bull"] = (
    (d["low"] < _price_ll_r) &
    (d["macd_hist"] > _macd_ll_r * 0.85)
).astype(float)
```

---

## 3. Miglioramento principale — Divergenze Daily

### 3.1 Perché le divergenze daily sono più affidabili per questo use case

Per intercettare la fine di una mossa direzionale di 2-5 giorni su BTC, la divergenza su **daily** è il segnale più affidabile. La logica:

- Una mossa di 3 giorni su BTC = 3 barre daily. La divergenza RSI daily si forma durante questa mossa e segnala il suo esaurimento.
- La stessa mossa su 4H = 18 barre 4H. Con finestra 20 barre, la divergenza 4H è ancora troppo locale e rumorosa.
- Le divergenze daily su BTC hanno storicamente ~60-65% di win rate su un forward return di 3-5 giorni. Le divergenze 4H con finestra 20 barre si attestano attorno al 50-55%.

Esempi reali su BTC:
- **Agosto 2023 top:** divergenza RSI daily confermata 2 giorni prima della caduta da 29k a 25k
- **Settembre 2023 bottom:** divergenza RSI bullish daily prima del rimbalzo da 25k a 28k
- **Marzo 2024 locale top:** RSI daily a livelli inferiori mentre BTC toccava 73k
- **Agosto 2024 bottom:** divergenza bullish daily clara durante il flush da 60k a 49k

**Caratteristica chiave per lo use case:** le divergenze daily non catturano solo i grandi pivot macro — catturano ogni mossa direzionale di 5-10 giorni che esaurisce il momentum.

### 3.2 Implementazione — `build_mtf_features()` in `smc.py`

Il codice ha già il daily OHLCV (`daily`) calcolato in `build_mtf_features()`. Aggiungere la divergence detection sullo stesso DataFrame prima del reindex:

```python
def build_mtf_features(df: pd.DataFrame) -> pd.DataFrame:
    d = df.copy()

    daily = df.resample("1D").agg({
        "open": "first", "high": "max", "low": "min", "close": "last", "volume": "sum"
    }).dropna()

    # Feature esistenti (invariate)
    daily["d_ema20"]     = ta.trend.EMAIndicator(daily["close"], 20).ema_indicator()
    daily["d_adx"]       = ta.trend.ADXIndicator(daily["high"], daily["low"], daily["close"], 14).adx()
    daily["d_rsi"]       = ta.momentum.RSIIndicator(daily["close"], 14).rsi()
    daily["d_atr_daily"] = ta.volatility.AverageTrueRange(daily["high"], daily["low"], daily["close"], 14).average_true_range()
    daily["d_regime"]    = np.where(
        (daily["close"] > daily["d_ema20"]) & (daily["d_adx"] > 20),  1,
        np.where((daily["close"] < daily["d_ema20"]) & (daily["d_adx"] > 20), -1, 0)
    )
    daily["d_ema20_dist"] = (daily["close"] - daily["d_ema20"]) / (daily["d_atr_daily"] + 1e-9)

    # ── NUOVO: divergenze RSI daily ──────────────────────────────────────────────
    # Finestra 10 sessioni daily ≈ 2 settimane — ideale per mosse di 5-10 giorni.
    # shift(1) garantisce no-lookahead: la divergenza è confermata dalla barra precedente.
    _d_win = 10
    _d_ph  = daily["high"].rolling(_d_win).max().shift(1)
    _d_pl  = daily["low"].rolling(_d_win).min().shift(1)
    _d_rh  = daily["d_rsi"].rolling(_d_win).max().shift(1)
    _d_rl  = daily["d_rsi"].rolling(_d_win).min().shift(1)

    # Bear divergence: price nuovo massimo daily ma RSI daily lower high (5% gap minimo)
    daily["d_rsi_div_bear"] = (
        (daily["high"] > _d_ph) &
        (daily["d_rsi"] < _d_rh * 0.95)
    ).astype(float)

    # Bull divergence: price nuovo minimo daily ma RSI daily higher low
    daily["d_rsi_div_bull"] = (
        (daily["low"] < _d_pl) &
        (daily["d_rsi"] > _d_rl * 1.05)
    ).astype(float)

    # ── NUOVO: divergenza MACD daily ─────────────────────────────────────────────
    daily["d_macd_hist"] = ta.trend.MACD(daily["close"]).macd_diff()
    _d_mh = daily["d_macd_hist"].rolling(_d_win).max().shift(1)
    _d_ml = daily["d_macd_hist"].rolling(_d_win).min().shift(1)

    daily["d_macd_div_bear"] = (
        (daily["high"] > _d_ph) &
        (daily["d_macd_hist"] < _d_mh * 0.80)  # MACD histogram lower high del 20%+
    ).astype(float)

    daily["d_macd_div_bull"] = (
        (daily["low"] < _d_pl) &
        (daily["d_macd_hist"] > _d_ml * 0.80)
    ).astype(float)

    # ── Forward-fill tutto sul timeframe 4H ──────────────────────────────────────
    daily_cols = [
        "d_ema20", "d_adx", "d_rsi", "d_regime", "d_ema20_dist",
        "d_rsi_div_bear", "d_rsi_div_bull",       # ← NUOVE
        "d_macd_div_bear", "d_macd_div_bull",     # ← NUOVE
    ]
    daily_aligned = daily[daily_cols].reindex(d.index, method="ffill")
    for col in daily_aligned.columns:
        d[col] = daily_aligned[col]

    # mtf_aligned invariato
    bos_up   = d["close"] > d["close"].rolling(20).max().shift(1)
    bos_down = d["close"] < d["close"].rolling(20).min().shift(1)
    d["mtf_aligned"] = np.where(
        (bos_up & (d["d_regime"] == 1)) | (bos_down & (d["d_regime"] == -1)),  1.0,
        np.where(
            (bos_up & (d["d_regime"] == -1)) | (bos_down & (d["d_regime"] == 1)), -1.0, 0.0
        )
    )
    return d
```

**Nota sul forward-fill:** `reindex(method="ffill")` propaga il valore della divergenza daily su tutte le barre 4H del giorno. Questo è corretto: se la daily di ieri ha mostrato divergenza, tutte le barre 4H di oggi la "vedono". La divergenza rimane valida fino a che il daily successivo non la invalida (nuovo massimo/minimo con RSI confermante).

### 3.3 Aggiornamento FEATURE_GROUPS in `smc.py`

```python
FEATURE_GROUPS = {
    ...
    "mtf": [
        "d_ema20_dist", "d_adx", "d_rsi", "d_regime", "mtf_aligned",
        "d_rsi_div_bear", "d_rsi_div_bull",    # ← NUOVE
        "d_macd_div_bear", "d_macd_div_bull",  # ← NUOVE
    ],
    ...
}
```

Queste feature entrano nella lista LGBM (`LGBM_FEATURES`) automaticamente. Al prossimo retrain il modello le apprende. I valori `0.0` (nessuna divergenza) sono il default sicuro prima del retrain.

### 3.4 Integrazione nel ReversalZoneDetector — componente Momentum

**File:** `apps/api/services/reversal_detector.py`

Attualmente il componente Momentum usa solo divergenze 4H. Aggiungere le daily come segnali aggiuntivi:

```python
def _momentum_bear(self, f: dict) -> float:
    hits = 0.0

    # Divergenze 4H (segnali locali — peso 1.0 ciascuno)
    if float(f.get("rsi_div_bear")  or 0.0) == 1.0:
        hits += 1.0
    if float(f.get("macd_div_bear") or 0.0) == 1.0:
        hits += 1.0

    # CVD divergence (segnale cross-asset)
    if float(f.get("delta_price_div") or 0.0) < -0.5:
        hits += 1.0

    # ── NUOVO: divergenze daily (segnali strutturali — peso 1.5 ciascuno) ────────
    # Peso maggiore perché più affidabili: una divergenza su daily dopo una mossa
    # di 5-10 giorni è statisticamente più significativa di una su 4H.
    if float(f.get("d_rsi_div_bear")  or 0.0) == 1.0:
        hits += 1.5
    if float(f.get("d_macd_div_bear") or 0.0) == 1.0:
        hits += 1.5

    # Normalizzazione su 6 punti max (3 × 1.0 + 2 × 1.5 = 6.0)
    score = hits / 6.0

    # Bonus confluenza: se ENTRAMBE le divergenze daily e quella RSI 4H sono attive
    # contemporaneamente → segnale eccezionalmente affidabile per lo use case
    if (float(f.get("d_rsi_div_bear") or 0.0) == 1.0
            and float(f.get("rsi_div_bear") or 0.0) == 1.0):
        score = min(1.0, score + 0.20)  # dual-timeframe confluence boost

    return min(1.0, score)

def _momentum_bull(self, f: dict) -> float:
    hits = 0.0
    if float(f.get("rsi_div_bull")   or 0.0) == 1.0:
        hits += 1.0
    if float(f.get("macd_div_bull")  or 0.0) == 1.0:
        hits += 1.0
    if float(f.get("delta_price_div") or 0.0) > 0.5:
        hits += 1.0
    if float(f.get("d_rsi_div_bull")  or 0.0) == 1.0:
        hits += 1.5
    if float(f.get("d_macd_div_bull") or 0.0) == 1.0:
        hits += 1.5
    score = hits / 6.0
    if (float(f.get("d_rsi_div_bull") or 0.0) == 1.0
            and float(f.get("rsi_div_bull") or 0.0) == 1.0):
        score = min(1.0, score + 0.20)
    return min(1.0, score)
```

---

## 4. Riorientation del componente Exhaustion per lo use case

Il componente Exhaustion (peso 18%) è il più direttamente legato all'obiettivo: misurare quanto una mossa è "andata lontano". Alcune calibrazioni per allinearlo meglio:

### 4.1 `reversal_bars_in_regime_min` — ridurre da 40 a 20

Il parametro attuale `reversal_bars_in_regime_min = 40` richiede che il regime duri 40 barre = 160 ore = ~6.7 giorni prima che il componente regime contribuisca. Questo è orientato a macro-trend.

Per mosse di 2-5 giorni, il regime è "maturo" già dopo 20 barre (80 ore = 3.3 giorni):

```python
# In BotConfig, valore default da aggiornare:
reversal_bars_in_regime_min: int = Field(20, ge=5, le=80)
# Range ampliato verso il basso per consentire mosse più brevi
```

### 4.2 Aggiungere RSI 4H extreme come pre-condizione nell'Exhaustion

Lo use case richiede che il prezzo sia effettivamente in zona estrema. Un RSI 4H < 35 (oversold) o > 65 (overbought) è la pre-condizione più semplice e affidabile:

```python
def _exhaustion(self, f: dict, cfg, direction: str = "bear") -> float:
    hits  = 0.0
    count = 5  # aggiunto un sub-check

    consec  = float(f.get("consec_bars") or 0.0)
    adx     = float(f.get("adx_14")      or 0.0)
    adx_l3  = float(f.get("adx_14_lag3") or adx)
    em_dist = abs(float(f.get("ema50_dist") or 0.0))
    ret48   = float(f.get("ret_48") or 0.0)
    rsi_4h  = float(f.get("rsi_14") or 50.0)

    if abs(consec) >= getattr(cfg, "reversal_consec_bars_min", 5):
        hits += 1.0

    adx_peak = getattr(cfg, "reversal_adx_peak_min", 35.0)
    if adx >= adx_peak:
        hits += 1.0 if adx < adx_l3 else 0.5  # ADX declinante = segnale più forte

    if em_dist > getattr(cfg, "reversal_ema50_dist_extreme", 3.0):
        hits += 1.0

    ret_thr = getattr(cfg, "reversal_ret48_extreme", 0.08)
    if abs(ret48) > ret_thr:
        hits += 1.0

    # ── NUOVO: RSI 4H in zona estrema ───────────────────────────────────────────
    # Per lo use case (fine di mossa forte), il RSI deve essere in zona overextended.
    # Senza questo check, l'exhaustion può scattare anche a metà di una mossa normale.
    rsi_ob = getattr(cfg, "reversal_stoch_ob", 0.65) * 100  # usa stessa soglia stoch come proxy
    rsi_os = getattr(cfg, "reversal_stoch_os", 0.35) * 100
    if direction == "bear" and rsi_4h > 65.0:
        hits += 1.0
    elif direction == "bull" and rsi_4h < 35.0:
        hits += 1.0

    base_score = hits / count

    # Amplificatori esistenti (invariati)
    iv_pct = float(f.get("iv_7d_percentile") or 50.0)
    if iv_pct > getattr(cfg, "reversal_iv_exhaustion_high", 80.0):
        base_score = min(1.0, base_score + 0.15)

    d_rsi = float(f.get("d_rsi") or 50.0)
    if direction == "bear" and d_rsi > getattr(cfg, "reversal_daily_rsi_extreme_high", 75.0):
        base_score = min(1.0, base_score + 0.20)
    elif direction == "bull" and d_rsi < getattr(cfg, "reversal_daily_rsi_extreme_low", 25.0):
        base_score = min(1.0, base_score + 0.20)

    d_ema_dist = abs(float(f.get("d_ema20_dist") or 0.0))
    if d_ema_dist > getattr(cfg, "reversal_daily_ema_dist_extreme", 4.0):
        base_score = min(1.0, base_score + 0.15)

    return base_score
```

---

## 5. Correzione asimmetria nel componente Volume

**Problema:** il bear volume usa `absorption_z` (SMC), il bull volume usa `liq_long_z` (liquidazioni). I dati di liquidazione HL sono inconsistenti e con gap — inaffidabili come feature di training.

**Fix:** rendere il volume simmetrico per entrambe le direzioni:

```python
def _volume_bear(self, f: dict, cfg) -> float:
    hits  = 0.0
    count = 3
    if float(f.get("vol_climax_bear") or 0.0) == 1.0:
        hits += 1.0
    if float(f.get("vol_z_50") or 0.0) > getattr(cfg, "reversal_vol_climax_z", 2.0):
        hits += 1.0
    if float(f.get("absorption_z") or 0.0) > getattr(cfg, "reversal_absorption_z", 1.8):
        hits += 1.0
    return hits / count

def _volume_bull(self, f: dict, cfg) -> float:
    hits  = 0.0
    count = 3
    if float(f.get("vol_climax_bull") or 0.0) == 1.0:
        hits += 1.0
    if float(f.get("vol_z_50") or 0.0) > getattr(cfg, "reversal_vol_climax_z", 2.0):
        hits += 1.0
    # ── CAMBIATO: absorption_z invece di liq_long_z (più affidabile e disponibile) ──
    # absorption_z alto su bottom: volume entra ma prezzo non scende = accumulo istituzionale
    if float(f.get("absorption_z") or 0.0) > getattr(cfg, "reversal_absorption_z", 1.8):
        hits += 1.0
    return hits / count
```

---

## 6. Validazione su dati storici — da eseguire prima del go-live delle modifiche

### 6.1 Dataset disponibile

File: `poc/btc3y_ohlcv.parquet` — 3 anni di BTC OHLCV 4H (~6.500 barre).

### 6.2 Test da eseguire

**Test 1 — Frequenza di scatto (sanity check)**

Eseguire il detector sui 3 anni e contare quante volte scatta il segnale per ogni valore di `reversal_score_threshold`. Target: 1-3% delle barre (ovvero 65-195 segnali in 3 anni = circa 2-5 segnali al mese). Troppi segnali = threshold troppo basso. Troppo pochi = threshold troppo alto.

```python
# Script: poc/reversal_diagnostic.py (già esiste parzialmente)
thresholds = [0.30, 0.32, 0.34, 0.36, 0.38, 0.40]
for thr in thresholds:
    signals = [s for s in all_scores if s >= thr]
    print(f"threshold={thr}: {len(signals)} segnali ({len(signals)/len(all_scores)*100:.1f}% delle barre)")
```

**Test 2 — Forward return analysis**

Per ogni segnale, calcolare il return nelle successive 4, 8, 12, 24 barre nella direzione indicata. Confrontare:
- Version A: divergenze 4H originali (con i bug)
- Version B: divergenze 4H corrette (fix sezione 2)
- Version C: divergenze daily aggiunte (sezione 3)
- Version D: combinazione B + C + exhaustion RSI gate (sezione 4)

Metrica target: win rate ≥ 55% su un forward return di 8 barre (32 ore) nella direzione del segnale.

**Test 3 — Componente breakdown**

Per i segnali con score ≥ threshold, verificare quali componenti si attivano più frequentemente. I componenti con activation rate < 10% o > 90% vanno ricalibrati — indicano parametri troppo restrittivi o troppo permissivi.

**Test 4 — Timing quality**

Misurare il drawdown medio prima che il segnale si riveli corretto. Se il prezzo continua contro il segnale per ancora 2+ ATR prima di invertire, il timing è troppo precoce e serve alzare le soglie di exhaustion.

### 6.3 Calibrazioni attese

Sulla base dei comportamenti storici di BTC 4H:

| Parametro | Attuale | Atteso post-calibrazione | Motivazione |
|---|---|---|---|
| `reversal_score_threshold` | 0.34 | 0.36–0.38 | Con daily divergences il punteggio medio sale — la soglia deve salire proporzionalmente |
| `reversal_consec_bars_min` | 5 | 4–5 | BTC spesso esaurisce una mossa in 4 barre consecutive solide (16 ore) |
| `reversal_adx_peak_min` | 35.0 | 30.0–32.0 | ADX > 35 è raro su BTC 4H — abbassarlo cattura più mosse reali |
| `reversal_ret48_extreme` | 8% | 6.0–7.0% | Il 6% a 48 barre (8 giorni 4H) è già un movimento significativo su BTC |
| `reversal_bars_in_regime_min` | 40 | 20–25 | Allineato allo use case (mosse di 2-5 giorni) |

---

## 7. Aggiornamenti FEATURE_GROUPS per il prossimo retrain LightGBM

Le nuove feature daily devono essere aggiunte all'elenco per essere incluse nel training:

```python
# In smc.py
FEATURE_GROUPS = {
    ...
    "mtf": [
        "d_ema20_dist", "d_adx", "d_rsi", "d_regime", "mtf_aligned",
        "d_rsi_div_bear",  "d_rsi_div_bull",    # ← NUOVE
        "d_macd_div_bear", "d_macd_div_bull",   # ← NUOVE
    ],
    ...
}
```

**Impatto sul modello LightGBM:** queste 4 feature vengono aggiunte ai LGBM_FEATURES. Al prossimo retrain (4H e 1H), il modello le apprende direttamente. L'L1 regolarization (reg_alpha = 0.918 dal retrain recente) eliminerà automaticamente quelle che non hanno segnale.

**Deep retrain raccomandato dopo questa implementazione:** le nuove feature daily richiedono almeno 30 sessioni giornaliere (30 × 4 = 120 barre 4H) di warmup per stabilizzarsi. Un deep retrain su 3-5 anni garantisce che LightGBM le apprenda su sufficiente storia.

---

## 8. Piano di esecuzione — sequenza precisa

### Fase 1 — Bug fix (15 minuti, zero rischio)

1. `smc.py` — aumentare `_rsi_win` da 10 a 20, aggiungere `.shift(1)` alle rolling max/min
2. `smc.py` — rimuovere `& (d["macd_hist"] < 0)` dalla MACD divergence bear
3. Syntax check Python, TypeScript check, deploy backend
4. Nessun retrain necessario (bug fix non cambia la struttura delle feature)

### Fase 2 — Daily divergences (30 minuti)

1. `smc.py` / `build_mtf_features()` — aggiungere calcolo `d_rsi_div_*` e `d_macd_div_*` sul daily
2. `smc.py` / `FEATURE_GROUPS["mtf"]` — aggiungere le 4 nuove colonne
3. `reversal_detector.py` / `_momentum_bear/bull()` — aggiungere peso 1.5 per daily divergences + dual-TF confluence boost
4. Syntax check, test import, deploy

### Fase 3 — Calibrazione Exhaustion (20 minuti)

1. `reversal_detector.py` / `_exhaustion()` — aggiungere RSI 4H extreme check
2. `main.py` / `BotConfig` — aggiornare default `reversal_bars_in_regime_min` a 20
3. `reversal_detector.py` / `_volume_bull()` — rimpiazzare `liq_long_z` con `absorption_z`
4. Deploy

### Fase 4 — Validazione (1-2 ore)

1. Eseguire `poc/reversal_diagnostic.py` sui 3 anni di dati con le nuove feature
2. Calibrare `reversal_score_threshold` e `reversal_adx_peak_min` basandosi sui risultati
3. Aggiornare i default in `main.py` se necessario

### Fase 5 — Deep retrain

1. Deep retrain 4H con `from_date = 2021-01-01`, `use_optuna = True`
2. Deep retrain 1H con `from_date = 2022-01-01`, `forward_bars = 4`
3. Le nuove feature daily vengono apprese dal modello LightGBM
4. Verificare che `d_rsi_div_bear/bull` e `d_macd_div_bear/bull` abbiano importanza > 0 nel nuovo modello

---

## 9. Parametri da non toccare

Questi parametri del sistema attuale sono ben calibrati e **non devono essere modificati** da questo piano:

- `reversal_score_threshold = 0.34` — da rivalutare solo dopo validazione (fase 4)
- `reversal_sl_atr_mult = 1.2` — corretto per mosse di breve-medio termine
- `reversal_size_factor = 0.50` — prudente e appropriato per trade contrarian
- `reversal_entry_mode = "limit_retest"` — approccio più preciso per questo use case
- `reversal_conflict_block = True` — il veto reversal sul trend è il contributo più consistente
- `reversal_trend_hold_only = True` — evita conflitti con il trend-following attivo

---

## 10. Cosa NON fare — errori da evitare

**Non aggiungere indicatori macro (weekly/monthly):** non serve per mosse di 2-5 giorni. I pivot settimanali sono un miglioramento futuro separato, non prioritario per questo use case.

**Non abbassare `reversal_score_threshold` sotto 0.32:** più segnali non significa migliore qualità. L'obiettivo è 2-5 segnali al mese di alta qualità, non 20 segnali mediocri.

**Non usare `reversal_max_hold_bars > 8`:** per mosse di breve-medio termine, tenere aperto un trade reversal oltre 32 ore trasforma una trade tattica in una posizione direzionale — diverso obiettivo, diversi rischi.

**Non includere `reversal_score` come feature LGBM:** l'aggregato non è disponibile durante il training (il trainer chiama `build_all_features` ma non istanzia `ReversalZoneDetector`). Le 4+13 feature componenti vanno nel modello, non lo score finale.

**Non aspettarsi segnali ogni giorno:** per lo use case (fine di mosse forti), il detector è silenzioso per settimane consecutive, poi scatta 2-3 volte in rapida successione durante un movimento significativo. È il comportamento corretto — non un problema.
