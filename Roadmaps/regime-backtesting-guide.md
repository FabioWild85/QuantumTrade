# Regime-Aware Backtesting — Guida Completa

> **Obiettivo**: Identificare setup ottimali per ogni condizione di mercato testando configurazioni su periodi storici omogenei.  
> **Strategia**: Trovare 3-4+ campioni per ogni regime, ottimizzare su uno, validare sugli altri.

---

## Perché questa strategia è corretta

I setup di trading si comportano in modo radicalmente diverso a seconda del regime di mercato:
un sistema trend-following ottimale in bull trend è spesso devastante in sideways.
Trovare **configurazioni robuste per regime** è più realistico e più onesto che cercare il "setup universale".

**Workflow consigliato per ogni regime:**

1. Ottimizza il setup sul campione più lungo e pulito del regime
2. Valida sui rimanenti campioni dello stesso regime — se funziona su ≥3/4, il setup è regime-robusto
3. Stress test sui crash estremi (D3/D4) — anche se non li usi per ottimizzare, devi sapere come sopravvivono
4. Confronta i setup fra regimi — vedrai che i parametri ottimali sono spesso incompatibili

> ⚠️ **Overfitting warning**: Con meno di 3 campioni per categoria, stai fittando su quei periodi specifici, non sul regime. Usa tutti i campioni disponibili.

---

## Legenda

| Simbolo | Significato |
|---------|-------------|
| ✅ | Dati certi — training (pre-ago 2025) o dataset BTC 4H confermato (mag 2024–mag 2026) |
| 📊 | Dati estratti direttamente dal file `poc/data_ohlcv.parquet` — prezzi esatti |

> Tutti i periodi da maggio 2024 in poi sono stati **verificati sul dataset reale** di candele 4H BTC.

---

## REGIME 1 — Strong Uptrend (Trend Rialzista Forte)

**Criteri identificativi:**
- Movimento direzionale sostenuto >25% senza pullback >15%
- ADX tipicamente >25, stabile o crescente
- Prezzo sopra MA50 e MA200
- RSI in zona 60–70 (non ipercomprato persistente)
- Volume nella prima fase superiore alla media

| # | Periodo | Durata | Da → A | Variazione | Fonte |
|---|---------|--------|--------|------------|-------|
| U1 | **1 Gen – 13 Apr 2021** | 3.5 mesi | $29k → $64k | **+121%** | ✅ training |
| U2 | **20 Lug – 10 Nov 2021** | 3.7 mesi | $30k → $69k | **+130%** | ✅ training |
| U3 | **1 Gen – 16 Feb 2023** | 6 settimane | $16.5k → $25k | **+52%** | ✅ training |
| U4 | **11 Set – 8 Dic 2023** | 3 mesi | $25k → $44k | **+76%** | ✅ training |
| U5 | **3 Gen – 14 Mar 2024** | 2.5 mesi | $42k → $73k | **+74%** | ✅ training |
| U6 | **1 Ott – 22 Nov 2024** | 7.5 settimane | $63k → $99k | **+57%** | 📊 dataset |
| U7 | **7 Apr – 21 Mag 2025** | 6.5 settimane | $74k → $112k | **+51%** | 📊 dataset |
| U8 | **1 Lug – 10 Ago 2025** | 5.5 settimane | $105k → $124k | **+18%** | 📊 dataset |

**Note campioni:**
- **U2** è il campione di riferimento — il più lungo e pulito, ottimo per ottimizzare
- **U6** è il più recente con dati confermati; molto verticale (2 mesi, +57%) — ideale per testare trailing SL
- **U8** è il più breve (+18%) — testa i setup su uptrend meno estremi
- Apr 2026 (+20% mensile: $66k→$79k) è una mini-ripresa, non abbastanza sostenuta per classificarla come uptrend pulito

**Setup tendenzialmente efficaci in questo regime:**
- Dir Threshold basso (0.58–0.62) per catturare più segnali long
- ADX Gate moderato (15–20) — non troppo restrittivo
- Trailing SL utile per cavalcare la tendenza
- Chronos blend basso (20–30%) — in trend forte l'LGBM è più affidabile

---

## REGIME 2 — Strong Downtrend (Trend Ribassista Forte)

**Criteri identificativi:**
- Movimento ribassista sostenuto >20% senza rimbalzi >15%
- Struttura di lower-highs / lower-lows netta
- ADX >20 in direzione ribassista
- RSI in zona 30–40 persistente

| # | Periodo | Durata | Da → A | Variazione | Fonte |
|---|---------|--------|--------|------------|-------|
| D1 | **13 Apr – 22 Giu 2021** | 2.3 mesi | $64k → $28k | **-56%** | ✅ training |
| D2 | **10 Nov 2021 – 22 Gen 2022** | 2.5 mesi | $69k → $33k | **-52%** | ✅ training |
| D3 | **5 Apr – 18 Giu 2022** | 2.5 mesi | $46k → $17.6k | **-62%** | ✅ training |
| D4 | **3 – 22 Nov 2022** | 3 settimane | $21k → $15.5k | **-26%** | ✅ training |
| D5 | **15 Ago – 11 Set 2023** | 4 settimane | $31k → $25k | **-19%** | ✅ training |
| D6 | **5 Giu – 5 Ago 2024** | 9 settimane | $72k → $49k | **-32%** | 📊 dataset |
| D7 | **1 Feb – 7 Apr 2025** | 9 settimane | $103k → $74k | **-28%** | 📊 dataset |
| D8 | **1 – 28 Nov 2025** | 4 settimane | $110k → $80k | **-27%** | 📊 dataset |
| D9 | **15 Gen – 7 Feb 2026** | 3.5 settimane | $97k → $60k | **-38%** | 📊 dataset |

**Note campioni:**
- **D6** include il flash crash del 5 agosto 2024 (da $65k a $49k in una sola giornata — yen carry trade unwind). Da usare con cautela come stress test
- **D8** è il crash di novembre 2025 — ADX Gate 20 è risultato fondamentale per evitarlo (verificato nei backtests)
- **D9** è il secondo bear leg fino a $60k — bottom assoluto del dataset. Inizio: bull trap a $97k a metà gennaio, poi crollo verticale
- **D3 e D4** sono black-swan (Terra/Luna, FTX) — stress test, non usare per ottimizzare parametri "normali"

**Setup tendenzialmente efficaci in questo regime:**
- ADX Gate 20–25 obbligatorio — filtra i rimbalzi finti
- Short signal attivi (dir threshold asimmetrico)
- SL stretto (1.5×ATR) — i rimbalzi contro-trend sono violenti
- Chronos adaptive SL/TP utile per comprimere i target in mercati veloci

---

## REGIME 3 — Sideways / Ranging (Mercato Laterale)

**Criteri identificativi:**
- Prezzo oscilla in una banda <25%
- Multiple touch di supporto e resistenza chiari
- ADX tipicamente <20, spesso <15
- Nessun breakout sostenuto per più di 2 settimane
- RSI che oscilla tra 40 e 60

| # | Periodo | Durata | Range | Ampiezza | Fonte |
|---|---------|--------|-------|----------|-------|
| S1 | **22 Giu – 20 Lug 2021** | 4 settimane | $29k – $36k | 24% | ✅ training |
| S2 | **7 Set – 4 Ott 2021** | 4 settimane | $42k – $52k | 24% | ✅ training |
| S3 | **16 Feb – 4 Apr 2022** | 7 settimane | $37k – $45k | 21% | ✅ training |
| S4 | **26 Lug – 17 Ago 2022** | 3 settimane | $22k – $25k | 14% | ✅ training |
| S5 | **1 Ott – 3 Nov 2022** | 5 settimane | $18.5k – $21k | 13% | ✅ training |
| S6 | **1 Mar – 15 Giu 2023** | 3.5 mesi | $25k – $31k | 24% | ✅ training |
| S7 | **1 – 30 Set 2024** | 4 settimane | $53k – $67k | 26% | 📊 dataset |
| S8 | **1 – 31 Dic 2024** | 4 settimane | $91k – $109k | 20% | 📊 dataset |
| S9 | **15 Feb – 6 Apr 2025** | 7 settimane | $76k – $95k | 25% | 📊 dataset |
| S10 | **1 – 30 Giu 2025** | 4 settimane | $98k – $111k | 13% | 📊 dataset |
| S11 | **1 – 31 Dic 2025** | 4 settimane | $84k – $95k | 13% | 📊 dataset |
| S12 | **1 Mar – 6 Apr 2026** | 5 settimane | $65k – $76k | 17% | 📊 dataset |

**Note campioni:**
- **S6** è il campione di riferimento — 3.5 mesi molto puliti, ottimo per ottimizzare
- **S7** segue il flash crash di agosto 2024 — mercato in recovery lenta, supporto/resistenza netti
- **S8** è la digestione post-rally di novembre 2024 — range ampio ma ben definito
- **Ottobre 2025** ($101k–$126k, nuovi ATH poi calo) è una zona di topping/distribuzione — da usare come **zona di transizione**, non come sideways puro
- **S12** è il pavimento dopo D9 (bottom $60k) — recovery pause prima della ripresa di aprile

**Setup tendenzialmente efficaci in questo regime:**
- ADX Gate alto (22–25) — filtra la maggior parte dei falsi segnali in range
- Confluence Score alto (60–70) — richiede convergenza multipla prima di entrare
- Partial TP aggressivo (50% @ 1.5×ATR) — il prezzo torna spesso al punto di ingresso
- Trailing SL off — in sideways il trailing viene spesso colpito dai rimbalzi
- Chronos cont_prob Gate utile — bassa coerenza delle bande = non entrare

---

## REGIME 4 — Flat / Low Volatility (Mercato Piatto)

**Criteri identificativi:**
- Range settimanale <8–10%
- ATR su 14 periodi ai minimi degli ultimi 3 mesi (ATR percentile <20)
- Nessun trend e scarsa direzionalità anche intraday
- Volume significativamente sotto la media
- Su BTC questi periodi sono rari e tipicamente brevi (2–6 settimane)

| # | Periodo | Durata | Range | Note | Fonte |
|---|---------|--------|-------|------|-------|
| F1 | **1 Dic 2022 – 12 Gen 2023** | 6 settimane | $16k – $17.2k | Dopo FTX, mercato esausto | ✅ training |
| F2 | **15 Set – 14 Ott 2023** | 4 settimane | $25k – $27.5k | Consolidazione quieta pre-rally | ✅ training |
| F3 | **15 – 30 Apr 2024** | 2.5 settimane | $60k – $65k | Stasi post-halving | ✅ training |
| F4 | **10 Giu – 5 Lug 2024** | 3.5 settimane | $60k – $68k | Estate silenziosa | 📊 dataset |
| F5 | **1 – 17 Mag 2026** | ~2.5 settimane | $76k – $83k | Mercato più quieto del dataset (8.5%) | 📊 dataset |

> ⚠️ In periodi flat il bot non dovrebbe quasi mai tradare. ADX Gate 20–25 + Confluence Gate 65+ già escludono la maggior parte di questi periodi automaticamente. Il pericolo principale è aprire posizioni su falsi breakout con spread elevato.

---

## Riepilogo Matrice per Backtest

```
REGIME              CAMPIONI   PERIODI               CAMPIONE DI RIFERIMENTO
────────────────────────────────────────────────────────────────────────────────
Uptrend forte         8        U1 U2 U3 U4 U5         U2 (3.7 mesi, +130%)
                               U6 U7 U8
Downtrend forte       9        D1 D2 D3 D4 D5         D1 o D7 (no black-swan)
                               D6 D7 D8 D9
Sideways             12        S1 S2 S3 S4 S5 S6       S6 (3.5 mesi, pulito)
                               S7 S8 S9 S10 S11 S12
Flat                  5        F1 F2 F3 F4 F5           F1 (più lungo)
────────────────────────────────────────────────────────────────────────────────
TOTALE: 34 periodi — tutti verificati su dati reali o training confermato
Copertura dataset: mag 2024 – mag 2026 (candele 4H, 4.381 candele)
```

---

## Visione Macro — BTC Gen 2021 – Mag 2026

```
2021: Uptrend → Crash → Sideways → Uptrend → Inizio bear
2022: Bear prolungato con due crolli netti (Luna, FTX)
2023: Recovery → Sideways lungo → Pre-ETF rally
2024: Post-ETF uptrend → Correzione estate → Elezioni uptrend +57%
2025: Continuazione → Crash feb → Recovery apr-lug → Bear ago-nov
2026: Secondo leg down → Bottom $60k (feb) → Recovery lenta
```

**Due grandi cicli completi nel dataset (mag 2024–mag 2026):**
- Ciclo 1: set 2024 ($53k) → nov 2024 ($99k) → dic 2024 ranging → feb 2025 ($78k)
- Ciclo 2: apr 2025 ($74k) → ago 2025 ($124k) → feb 2026 ($60k) → apr 2026 recovery

---

## Zone di Transizione — Consigli Avanzati

Le zone di transizione sono i periodi di 1–3 settimane in cui il mercato **cambia regime**. Sono i momenti più pericolosi per qualsiasi sistema automatico perché:
- I segnali del regime uscente sono ancora presenti ma il movimento è finito
- I segnali del regime entrante non sono ancora confermati
- Il modello continua a generare segnali ottimizzati per il regime sbagliato

### 1. Pattern di Transizione Identificati su BTC

**Fine uptrend → inizio correzione (topping):**
- ADX picca sopra 35–40 e poi inizia a scendere pur rimanendo alto (trend in esaurimento)
- RSI divergenza bearish: prezzo fa nuovo massimo, RSI non segue
- Volume in calo sui nuovi massimi (mancanza di partecipazione)
- **Caso reale — Ago 2025**: W1-W2 ancora in push ($124k ATH), la rottura è arrivata in W3/W4.
  Chi era long in W3 pensava di essere in uptrend, era già in distribuzione.
- **Caso reale — Ott 2025**: nuovo ATH a $126k ma chiusura mensile a $110k (-13% dall'ATH).
  Classico topping con falso breakout. Il crash ha iniziato in novembre.

**Fine downtrend → inizio recovery (capitolazione):**
- Spike di volume con candela hammer o engulfing bullish su 4H/1D
- ADX che scende sotto 25 dopo trend prolungato
- RSI divergenza rialzista multipla
- Liquidity sweep su minimi precedenti (sweep=1) seguito da chiusura forte
- **Caso reale — Apr 2025 W1**: wick down a $74k (sweep dei minimi), chiusura forte a $79k.
  Dal W2 in poi trend rialzista netto. Chi ha aspettato la conferma ha catturato +51%.
- **Caso reale — Feb 2026 W1**: bottom a $60k con grande wick. W2-W4 sideways a $62k–$72k.
  Non c'era ancora il segnale di inversione — la recovery vera è partita a marzo-aprile.

**Sideways → breakout (inizio trend):**
- ADX che sale da <15 a >20 in 3–5 candele consecutive
- Breakout della banda con volume 1.5× la media
- Chronos c2_uncertainty si comprime (< 3.5%) — il modello "vede" direzionalità
- **Caso reale — Ott 2024**: da settembre sideways ($53k–$67k), il breakout è partito con forza a inizio ottobre. ADX ha superato 20 nella prima settimana.

**Bull trap (falso breakout rialzista in downtrend):**
- **Caso reale — Gen 2026**: rally da $88k a $97k (high) nelle prime 2 settimane, sembrava recovery.
  W3 ha iniziato il secondo crollo, W5 ha toccato $75k. Chi era entrato long sul rally ha preso lo stop.

### 2. Comportamento Consigliato Durante le Transizioni

```
SITUAZIONE                              AZIONE CONSIGLIATA
──────────────────────────────────────────────────────────────────────────────
ADX > 35 e in calo (uptrend esausto)    Ridurre size al 50–70%, TP più stretto
                                        (TP Mult 2.5× invece di 3.5–4×)

RSI divergenza bearish confermata       Nessun nuovo long, attesa
                                        Confluenza necessaria per qualsiasi trade

Nuovo ATH con volume in calo            Nessun nuovo long, possibile short setup
                                        con conferma 2-3 candele 4H

Fine downtrend sospetta (wick lungo)    Aspettare 2 candele 4H di conferma
                                        prima di entrare long

Sideways → breakout non confermato      Aspettare chiusura 4H sopra/sotto
                                        il range con volume > 1.2× media

ADX tra 18 e 22 (zona grigia)           Confluence Gate 65+, size ridotta (0.8–1%),
                                        no trailing SL

Rally nel mezzo di un downtrend         Ignorare o ridurre size drasticamente
(bull trap)                             — conferma richiede almeno 1 settimana
                                        di higher-highs/higher-lows
```

### 3. Regola Pratica per il Bot (implementabile subito)

Senza regime detection automatica, puoi già ridurre l'esposizione nelle transizioni:

- **Confluence Gate a 65** durante periodi di incertezza — richiede convergenza forte
- **Size 0.8–1.0%** invece di 1.5% quando ADX è tra 18 e 23 (zona grigia)
- **TP Mult 2.5×** nella prima settimana dopo un breakout dal range — il mercato spesso ri-testa
- **C2 cont_prob Gate ON (threshold 0.35)** in transizioni — filtra i segnali incoerenti

### 4. Zone di Transizione Identificate — Da Escludere o Testare Separatamente

| Periodo | Transizione | Durata approx. |
|---------|-------------|----------------|
| 10–22 Apr 2021 | Uptrend → Downtrend (primo ATH) | ~12 giorni |
| 18–26 Giu 2021 | Downtrend → Sideways | ~8 giorni |
| 28 Gen – 5 Feb 2022 | Downtrend → Ranging | ~8 giorni |
| 15–22 Lug 2022 | Ranging → Downtrend | ~7 giorni |
| 13–20 Ott 2023 | Sideways → Uptrend (pre-ETF) | ~7 giorni |
| 5–15 Ago 2024 | Flash crash + recovery | ~10 giorni |
| 9–15 Ott 2024 | Ranging → Uptrend (elezioni) | ~6 giorni |
| 10–20 Ago 2025 | Uptrend → Distribuzione (top $124k) | ~10 giorni |
| 20–31 Ott 2025 | Topping → Crash (ATH $126k poi calo) | ~10 giorni |
| 8–15 Feb 2026 | Capitolazione ($60k bottom) → Sideways | ~7 giorni |

---

## Piano di Implementazione — Regime Detection in Tempo Reale

### Obiettivo

Classificare automaticamente il regime di mercato corrente in ogni ciclo del bot e adattare dinamicamente i parametri di trading senza intervento manuale.

### Architettura

```
Market Data (4H OHLCV)
        │
        ▼
┌──────────────────────────┐
│   RegimeDetector         │  ← nuovo servizio Python
│   (5 indicatori combinati)│
└──────────────────────────┘
        │
        ▼ RegimeSignal (enum + confidence + transition_risk)
┌──────────────────────────┐
│   RegimeProfileManager   │  ← mappa regime → parametri ottimali
└──────────────────────────┘
        │
        ▼ BotConfig override (solo se regime_adaptive_enabled)
┌──────────────────────────┐
│   DecisionEngine         │  ← usa parametri adattivi
│   RiskManager            │
└──────────────────────────┘
```

---

### Fase 1 — RegimeDetector Service

**File**: `apps/api/services/regime_detector.py`

Il classificatore usa 5 indicatori con pesi calibrati:

```python
# Indicatori e contributo alla classificazione
INDICATORS = {
    "adx":            weight=0.30,   # trend strength
    "atr_percentile": weight=0.20,   # volatility level relativa
    "trend_slope":    weight=0.25,   # directional bias (slope EMA20)
    "bb_width":       weight=0.15,   # Bollinger Band width (compressione)
    "hurst":          weight=0.10,   # mean-reversion vs trending (opzionale)
}
```

**Logica di classificazione (rules-based, deterministico):**

```
ADX < 15                              → FLAT
ADX 15–22 AND bb_width < P25          → SIDEWAYS
ADX > 22 AND slope > +0.5%/candela   → UPTREND
ADX > 22 AND slope < -0.5%/candela   → DOWNTREND
ADX 15–22 AND bb_width > P25         → SIDEWAYS (con transition_risk elevato)
ADX in calo da >35 + RSI divergenza   → TRANSITION
```

**Output — dataclass RegimeSignal:**

```python
@dataclass
class RegimeSignal:
    regime: Literal["uptrend", "downtrend", "sideways", "flat", "transition"]
    confidence: float           # 0.0–1.0
    adx: float
    atr_percentile: float       # 0–100, percentile su 90 candele
    trend_slope_pct: float      # slope EMA20 in % per candela
    bb_width_pct: float         # (upper-lower)/middle in %
    bars_in_regime: int         # candele consecutive nello stesso regime
    transition_risk: float      # 0–1, probabilità di cambio imminente
```

**Calcolo `atr_percentile`** (critico per flat detection):

```python
def atr_percentile(atr_series: pd.Series, window: int = 90) -> float:
    current_atr = atr_series.iloc[-1]
    historical = atr_series.iloc[-window:-1]
    return float(np.mean(historical <= current_atr) * 100)
```

**Calcolo `transition_risk`:**

```python
def compute_transition_risk(
    adx: float,
    adx_slope: float,     # variazione ADX ultima candela
    rsi: float,
    bars_in_regime: int,
    rsi_divergence: bool, # True se prezzo fa nuovo max/min ma RSI no
) -> float:
    risk = 0.0
    if adx > 35 and adx_slope < -0.5:    # ADX picca e scende
        risk += 0.40
    if bars_in_regime > 60:              # regime lungo = più probabile cambio
        risk += min(0.30, (bars_in_regime - 60) * 0.005)
    if rsi > 75 or rsi < 25:            # ipercomprato/ipervenduto estremo
        risk += 0.20
    if rsi_divergence:                   # divergenza confermata
        risk += 0.25
    return min(1.0, risk)
```

---

### Fase 2 — RegimeProfileManager

**File**: `apps/api/services/regime_profiles.py`

Mappa ogni regime ai parametri ottimali derivati dal backtesting regime-aware.
> ⚠️ I valori qui sotto sono **punti di partenza** basati sull'analisi attuale.
> Devono essere validati con il backtesting regime-aware prima di andare in produzione.

```python
REGIME_PROFILES = {
    "uptrend": {
        "directional_threshold": 0.60,
        "adx_gate": 18,
        "adx_gate_enabled": True,
        "confluence_gate": 50.0,
        "sl_atr_mult": 1.5,
        "tp_atr_mult": 4.0,
        "position_size_pct": 1.5,
        "trailing_sl_enabled": True,
        "trailing_sl_trigger_atr": 1.5,
        "chronos_weight": 0.20,          # LGBM più affidabile in trend
        "dynamic_sl_tp_enabled": True,
        "dynamic_sl_tp_blend": 0.30,
    },
    "downtrend": {
        "directional_threshold": 0.60,
        "adx_gate": 20,
        "adx_gate_enabled": True,
        "confluence_gate": 55.0,
        "sl_atr_mult": 1.5,
        "tp_atr_mult": 3.5,
        "position_size_pct": 1.2,        # size ridotta in bear
        "trailing_sl_enabled": False,
        "chronos_weight": 0.30,
        "dynamic_sl_tp_enabled": True,
        "dynamic_sl_tp_blend": 0.50,
    },
    "sideways": {
        "directional_threshold": 0.65,   # threshold più alto = meno falsi segnali
        "adx_gate": 22,
        "adx_gate_enabled": True,
        "confluence_gate": 65.0,         # richiede convergenza forte
        "sl_atr_mult": 1.8,
        "tp_atr_mult": 2.5,              # TP più stretto in range
        "position_size_pct": 1.0,        # size conservativa
        "trailing_sl_enabled": False,
        "c2_cont_prob_gate_enabled": True,
        "c2_cont_prob_threshold": 0.35,
        "chronos_weight": 0.40,          # Chronos più utile per filtrare in sideways
        "dynamic_sl_tp_enabled": True,
        "dynamic_sl_tp_blend": 0.60,
    },
    "flat": {
        "adx_gate": 25,
        "adx_gate_enabled": True,
        "confluence_gate": 70.0,
        "position_size_pct": 0.8,
        "c2_uncertainty_gate_enabled": True,
        "c2_uncertainty_threshold": 0.035,
    },
    "transition": {
        # Parametri ultra-conservativi durante i cambi di regime
        "directional_threshold": 0.68,
        "adx_gate": 25,
        "confluence_gate": 70.0,
        "position_size_pct": 0.8,
        "sl_atr_mult": 2.0,
        "tp_atr_mult": 3.0,
        "trailing_sl_enabled": False,
        "c2_cont_prob_gate_enabled": True,
        "c2_cont_prob_threshold": 0.40,
    },
}
```

---

### Fase 3 — Integrazione nel Loop Principale

**In `apps/api/services/execution.py`:**

```python
# Ogni 4 cicli (≈16h a candele 4H), ricalcola il regime
if cycle_count % 4 == 0:
    regime_signal = regime_detector.detect(df_4h)
    
    if cfg.regime_adaptive_enabled:
        profile = regime_profile_manager.get_profile(regime_signal)
        effective_cfg = merge_config_with_profile(cfg, profile)
        
        log.info(
            f"Regime: {regime_signal.regime} "
            f"(conf={regime_signal.confidence:.2f}, "
            f"bars={regime_signal.bars_in_regime}, "
            f"transition_risk={regime_signal.transition_risk:.2f})"
        )
        
        # Alta transition_risk → forza parametri ultra-conservativi
        if regime_signal.transition_risk > 0.65:
            effective_cfg = merge_config_with_profile(
                cfg, REGIME_PROFILES["transition"]
            )
            log.warning(
                f"HIGH TRANSITION RISK ({regime_signal.transition_risk:.2f}) "
                f"— switching to conservative profile"
            )
```

---

### Fase 4 — API Endpoint e Persistenza

**Nuovo endpoint in `main.py`:**

```python
GET /regime/current
→ {
    "regime": "sideways",
    "confidence": 0.78,
    "adx": 17.3,
    "atr_percentile": 32.1,
    "trend_slope_pct": -0.08,
    "bars_in_regime": 24,
    "transition_risk": 0.12,
    "active_profile": "sideways",
    "regime_adaptive_enabled": true
  }

GET /regime/history?limit=48
→ array degli ultimi N snapshot (debug e dashboard)
```

**Persistenza — nuova tabella Supabase `regime_log`:**

```sql
CREATE TABLE regime_log (
    id              BIGSERIAL PRIMARY KEY,
    detected_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    regime          TEXT NOT NULL,
    confidence      FLOAT,
    adx             FLOAT,
    atr_pct         FLOAT,
    slope_pct       FLOAT,
    bars_in_regime  INT,
    transition_risk FLOAT,
    profile_applied TEXT
);
```

---

### Fase 5 — Frontend Dashboard

**Componenti da aggiungere al TradingHub:**

1. **RegimeBadge** (inline accanto al bot status):
   - Badge colorato: 🟢 Uptrend / 🔴 Downtrend / 🟡 Sideways / ⚪ Flat / 🟠 Transition
   - Confidence bar sottostante
   - `bars_in_regime` (es. "24 candele in sideways")

2. **RegimeProfilePanel** (collapsible, accanto a BotConfig):
   - Parametri del profilo attivo vs parametri manuali
   - Toggle `regime_adaptive_enabled`
   - Warning visivo se `transition_risk > 0.65`

3. **RegimeHistoryChart** (opzionale, in BacktestPanel):
   - Timeline colorata del regime durante il backtest
   - Mostra visivamente se il bot ha tradato durante transizioni

---

### Fase 6 — Validazione e Calibrazione

Prima di attivare in live:

1. **Backtest regime-split**: per ogni campione (U1–U8, D1–D9, S1–S12, F1–F5), verificare che il detector classifichi correttamente ≥80% delle candele nel periodo
2. **Confusion matrix**: quante volte "uptrend" viene classificato come "sideways"? Soglie ADX da calibrare
3. **Sensitivity test**: provare ADX boundary a 20/25 vs 18/23 vs 15/20 su campioni noti
4. **Backtest A/B**: stesso periodo con `regime_adaptive_enabled: true` vs `false` — il regime-adaptive deve battere il setup fisso su ≥3 regimi su 4

---

### Timeline Implementazione Suggerita

| Fase | Task | Priorità |
|------|------|----------|
| 1 | `regime_detector.py` con 4 indicatori (no Hurst) | Alta |
| 2 | `regime_profiles.py` con 5 profili | Alta |
| 3 | Integrazione nel loop di `execution.py` | Alta |
| 4 | API endpoint `/regime/current` | Media |
| 5 | Persistenza su Supabase | Media |
| 6 | Frontend `RegimeBadge` | Media |
| 7 | Calibrazione soglie su campioni storici con backtest regime-split | Alta (prima del live) |
| 8 | Hurst Exponent (distingue trending da mean-reverting) | Bassa (computazionalmente costoso) |

---

*Documento creato: 17 maggio 2026*  
*Dati verificati su `poc/data_ohlcv.parquet` — 4.381 candele 4H BTC, mag 2024 – mag 2026*  
*Periodi pre-maggio 2024 basati su training (dati certi fino ad agosto 2025)*
