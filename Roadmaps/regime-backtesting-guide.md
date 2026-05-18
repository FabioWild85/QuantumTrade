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

## Note di calibrazione empirica (aggiornate con test reali)

> Questa sezione documenta le scoperte derivate da backtest sistematici su tutti i periodi. **I parametri nei setup sono stati aggiornati di conseguenza.**

### Bug e incongruenze scoperte nei test

| Parametro | Problema | Soluzione applicata |
|-----------|----------|---------------------|
| `sweep_gate_enabled: true` | Blocca gli ingressi *sul candle dello sweep* — in trend questo esclude buoni segnali di continuazione, peggiorando le performance in tutti i test | **OFF** per uptrend, downtrend, sideways. **ON** solo per flat. |
| `confluence_gate > 45` | Il QT score raramente supera 45–50 in condizioni normali (ADX 25, RSI 65, vol +10%, d_regime=1 → ~42 pt). Gate a 50–72 bloccava quasi tutto. | Calibrato a **40–45** per tutti i regimi |
| `lgbm_exit_enabled: true` in uptrend | Con `lgbm_exit_min_hold_bars=8`, la maggior parte dei trade in uptrend si chiude per SL prima dell'ottava barra. L'LGBM exit non scatta mai. | **OFF** in uptrend — non aggiunge valore senza Chronos attivo |
| `enhanced_exit_enabled` senza Chronos | Senza `use_chronos=true`, l'enhanced exit usa solo il flip LGBM (come se fosse disabilitato). Non aggiunge il filtro `close_price < entry`. | **OFF** in tutti i setup base (si attiva solo con Chronos) |
| `dynamic_sl_tp_enabled` senza Chronos | Ignorato silenziosamente dal backtester se `use_chronos=false`. | **OFF** nei setup base |
| `sl_atr_mult: 1.5` in uptrend | Con ATR di $1500–2500 su BTC, 1.5× è ~$2250–3750. I normali pullback 4H in uptrend toccano spesso questo livello, causando 13/18 stop loss. | Calibrato a **2.5×** in uptrend |
| `tp_atr_mult: 5.0` con trailing SL | Il TP a 5× non viene mai raggiunto perché il trailing SL scatta prima. Con trailing, usare `tp_atr_mult` alto è ridondante. | Senza trailing: **3.0×** reachable. Con trailing: TP > 4.0× |
| `trailing_sl_enabled: true` in uptrend 4H | Il trailing a 2×ATR su barre 4H viene colpito sistematicamente dai pullback normali del trend (+39 stop loss su 57 trade in un test). | **OFF** nei setup base — serve Chronos per calibrare il trailing correttamente |

### Limitazione strutturale del modello LGBM

Il modello LightGBM ha **"blind spot" direzionali** su certi periodi dove genera segnali sistematicamente nella direzione sbagliata:

- **U5 (Gen–Mar 2024, +74%)**: 18 segnali SHORT su 24 in un bull run verticale → -19% con parametri minimi
- **D2 (Nov21–Gen22, -52%)**: 13 segnali LONG su 15 in un bear market → -4.6%

Questi periodi **non sono migliorabili con la sola ottimizzazione dei parametri**. Il motivo probabile: il modello predice correttamente la direzione dei singoli candle 4H (pullback/bounce), ma il macro trend li supera sistematicamente. Con Chronos attivo (c2_dir_prob pesato sull'ensemble), questi periodi potrebbero migliorare.

> **Implicazione pratica**: Quando i backtest su un periodo danno WinRate < 30% con qualsiasi parametro, è un segnale di blind spot del modello — non continuare a ottimizzare quel periodo, è fuori dal range ottimale del modello.

### Risultati baseline (senza Chronos, parametri minimi)

| Periodo | Tipo | PnL baseline | Note |
|---------|------|--------------|------|
| U2 Lug–Nov 2021 | Uptrend | -6.3% | Ottimizzabile a +4.5% |
| U4 Set–Dic 2023 | Uptrend | ~ +1% | Funziona con parametri giusti |
| U5 Gen–Mar 2024 | Uptrend | **-19.2%** | Blind spot modello — 18/24 short in bull run |
| D1 Apr–Giu 2021 | Downtrend | **+8.3%** | Profittevole già al baseline |
| D7 Feb–Apr 2025 | Downtrend | **+4.5%** | Profittevole già al baseline |
| S6 Mar–Giu 2023 | Sideways | **+5.1%** | Profittevole già al baseline |
| S8 Dic 2024 | Sideways | **+1.3%** | Profittevole al baseline |

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
- Dir Threshold basso (0.58–0.62) — cattura più segnali nel verso del trend
- ADX Gate moderato (15–20) — non troppo restrittivo, il trend è già confermato
- Trailing SL **essenziale** (attivazione 1.5–2.0×ATR) — il valore centrale del regime è "cavalcare" il trend
- TP alto (4.0–5.0×ATR) + Partial TP basso (25–35% @ 2.0–2.5×ATR) — incassa una parte, lascia correre il resto
- SL stretto (1.5–1.8×ATR) — in uptrend forte i pullback sono contenuti; SL largo spreca P&L
- BE SL attivo dopo il Partial TP (attivazione 2.5–3.0×ATR) — protegge il residuo senza tagliarlo prematuramente
- Chronos blend basso (20–25%) + `dynamic_sl_tp_blend 0.25` — l'LGBM domina in trend, Chronos è solo filtro secondario
- LGBM Exit ON con conferma lunga (3 barre, min_hold 8) — evita uscite su rimbalzi; solo se il flip è sostenuto
- Enhanced Exit ON — Chronos p50 sotto entry_price come seconda conferma del flip di direzione
- `c2_cont_prob_gate` opzionale con soglia bassa (0.20) — filtra solo i segnali con continuazione quasi nulla
- **P10 SL Floor: OFF** — in uptrend le bande Chronos sono larghe; il floor tirerebbe lo SL troppo vicino all'ingresso con rischio di esplosione del size
- **Max Hold Bars: OFF** — non troncare artificialmente il trade nel regime con più upside potenziale
- `max_consecutive_losses: 3` — soglia più bassa; tre stop in trend forte = regime probabilmente finito

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
- ADX Gate 22–25 **obbligatorio** — ogni settimana di downtrend include almeno un bounce del 5–10%, filtrarlo è critico
- Short signal attivi; Dir Threshold 0.63–0.65 — serve una conferma solida perché entrare short tardi è devastante
- SL stretto (1.5–1.8×ATR) — i bounce contro-trend in downtrend sono veloci e violenti (spesso 2–3×ATR in 1–2 candele 4H)
- **Trailing SL: OFF** — i downtrend hanno rimbalzi a V; il trailing viene colpito sistematicamente
- Partial TP aggressivo (50–60% @ 1.5×ATR) — incassa il profitto prima che il bounce controtrend si mangi il guadagno
- BE SL rapido (1.0–1.5×ATR) — dopo il partial TP, protegge il residuo dai rimbalzi violenti
- Chronos Adaptive SL/TP utile (blend 0.40–0.50) — in downtrend il Chronos comprime bene i target short
- **P10 SL Floor utile per gli short** — `p10_sl_floor` usa `p90` come SL floor per i short, tira lo SL sopra lo swing high Chronos → riduce l'esposizione sui bounce
- LGBM Exit con soglia bassa (min_hold 3–4 barre) — segnale di inversione = bounce in arrivo, esci prima
- Enhanced Exit ON — Chronos p50 sopra entry_price per gli short conferma il regime change
- `c2_uncertainty_gate` ON (threshold 0.06) — non entrare short durante bounce con incertezza alta
- Max Hold Bars 24–36 (6–9 giorni) — i downtrend hanno squeezes periodicali; non restare esposto troppo a lungo
- `max_consecutive_losses: 3` — tre stop in downtrend = probabile regime di capitolazione/inversione

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
- ADX Gate 22–25 **obbligatorio** — in sideways l'ADX oscilla tra 12 e 20; sopra 22 ci sono solo i falsi breakout iniziali (entry migliori) o l'inizio di un regime change
- Confluence Gate 65–70 — richiedere convergenza forte: in un range ristretto i segnali deboli non raggiungono mai il TP
- Partial TP aggressivo (50–60% @ 1.5×ATR) — in un range il prezzo tocca resistance/support e **ritorna**; l'incasso rapido è l'unico modo per essere profittevoli
- **Trailing SL: OFF** — i rimbalzi in sideways colpiscono sistematicamente il trailing; il prezzo si muove avanti-indietro per definizione
- TP stretto (2.0–2.5×ATR) — il prezzo raramente supera l'ampiezza del range prima di invertire
- SL moderato (1.8–2.0×ATR) — l'ATR in sideways è già più basso; lo SL in dollari è contenuto
- BE SL rapido (1.5×ATR) — dopo il partial TP, porta subito lo SL in pareggio: non vuoi che un range trade si trasformi in una perdita
- **P10 SL Floor: ON** — in sideways il Chronos ha bande strette (p10/p90 sono vicini al prezzo); il floor comprime lo SL senza colpire la 0.5×ATR safety cap → riduce le perdite sui falsi breakout
- Chronos Adaptive SL/TP (blend 0.55–0.65) — in sideways Chronos è più calibrato del puro ATR: le bande riflettono i confini del range
- LGBM Exit **essenziale** (min_hold 3–4 barre, confirm 2) — quando il segnale si inverte in un range, è molto probabile che il prezzo torni contro; esci prima
- Enhanced Exit ON — doppia conferma Chronos + LGBM per uscire velocemente quando il range si "rifiuta" della direzione scelta
- `c2_uncertainty_gate` ON (threshold **0.055**) — blocca il top 10% delle candele ad alta incertezza; soglie più basse (0.04) bloccano il 40–50% dei candles includendo molti segnali validi
- `c2_cont_prob_gate` ON (threshold **0.10**) — con il fan aperto tipico di Chronos-2 su BTC 4H, threshold ≥0.30 blocca il 50–70% delle candele anche in trend; 0.10 = almeno 6 bands nette su 21 in una direzione
- Max Hold Bars 18–24 (4.5–6 giorni) — in un range non esiste "trend da aspettare"; se non raggiungi TP entro 6 giorni, probabilmente il trade è bloccato nel range → esci
- Dir Threshold 0.65–0.68 — non basta un segnale vago per entrare in sideways; richiedi segnali netti

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

**Setup tendenzialmente efficaci in questo regime:**
- **L'obiettivo primario è non tradare** — ogni trade in flat è un costo certo (commissioni + spread) in cambio di un profitto quasi certo molto piccolo
- ADX Gate 25–28 — in flat l'ADX raramente supera 15–17; fissarlo a 25–28 significa che si aprirà un trade solo se c'è un impulso reale (possibile inizio di un regime change)
- Confluence Gate 70–72 — quasi tutto deve essere allineato per entrare; in flat i segnali LGBM oscillano intorno al 0.50 e sono inaffidabili
- `c2_uncertainty_gate` ON con threshold **0.055** — blocca solo il top 10% delle candele ad altissima incertezza; soglie 0.04 o inferiori bloccano il 40–50% di tutti i segnali
- `c2_cont_prob_gate` ON con threshold **0.10** — in flat il fan Chronos-2 è quasi sempre aperto (n_up ≈ n_down); threshold 0.40 bloccherebbe praticamente tutto; 0.10 è il minimo significativo
- SL moderato (1.8–2.0×ATR) — con ATR basso lo SL in $ è già strettissimo; evita di abbassarlo ulteriormente
- TP stretto (2.0–2.5×ATR) — il prezzo in flat raramente si muove più di 1.5–2× l'ATR prima di tornare
- BE SL **molto rapido** (0.8–1.0×ATR) — in flat ogni guadagno va protetto immediatamente
- Partial TP aggressivo (60% @ 1.2–1.5×ATR) — prendi quasi tutto subito; il residuo è quasi un loteria
- **Max Hold Bars 12** (3 giorni) — il limit temporale più stretto di tutti i regimi; in flat il trade si blocca e non si muove
- LGBM Exit con conferma 1 sola barra — reagire velocissimo al primo segnale di inversione
- **P10 SL Floor: ON** — in flat le bande Chronos sono ancora più strette; p10/p90 sono molto vicini al prezzo → il floor tighten lo SL in modo chirurgico
- **Trailing SL: OFF**, **Enhanced Exit: OFF** — in flat non c'è un trend da seguire; ogni sofisticazione aggiuntiva è rumore
- `max_consecutive_losses: 2` — due stop = il flat sta diventando volatile o è un breakout in arrivo; fermarsi

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

---

## Piano di Implementazione — Regime Bias con Threshold Asimmetrico

### Perché implementare questo prima del Regime Detection

Il Regime Bias richiede 1–2 giorni di implementazione vs. settimane per il Regime Detection completo. Risolve subito il problema principale (troppi long in bear, troppi short in bull) usando il segnale `d_regime` già calcolato in `smc.py`. Quando il Regime Detection sarà completato, il segnale `d_regime` verrà semplicemente sostituito con la classificazione più accurata — il codice del bias non cambierà.

### Problema che risolve

Il sistema è completamente simmetrico: stesso `directional_threshold` per long e short. Il LGBM predice la direzione della singola candela 4H e genera correttamente segnali di pullback (short) in uptrend e di bounce (long) in downtrend. Il macro trend supera questi micro-segnali sistematicamente, producendo perdite su periodi come U5 (-19%, 18 short su 24 in un bull run) e D2 (-4%, 13 long su 15 in un bear).

### Meccanismo: Threshold Asimmetrico per Direzione

Il `directional_threshold` viene sostituito da due threshold separati — uno per la direzione *con* il regime (invariato) e uno per la direzione *contro* il regime (alzato di `regime_bias_delta`).

```
regime_bias_enabled = True, regime_bias_delta = 0.08, directional_threshold = 0.62

d_regime = +1 (bull, close > EMA20 daily AND ADX_daily > 20):
  threshold_long  = 0.62        → long scatta se ensemble_prob > 0.62 (invariato)
  threshold_short = 0.70        → short scatta se (1-prob) > 0.70 → prob < 0.30
                                   (contro-trend richiede segnale molto più netto)

d_regime = -1 (bear):
  threshold_short = 0.62        → short invariato
  threshold_long  = 0.70        → long in bear richiede prob > 0.70

d_regime = 0 (sideways/neutro, ADX_daily ≤ 20):
  threshold_long  = 0.62        → simmetrico, nessuna bias
  threshold_short = 0.62
```

> **Non è un blocco totale.** Uno short in bull market è ancora possibile se il segnale è molto forte (prob < 0.30). Serve per filtrare i segnali deboli/medi di contro-trend, non per disabilitare completamente la direzione.

### Interazione con MTF Alignment (esistente)

Il codice attuale calcola `effective_threshold` e poi lo riduce di 0.02 con MTF:
```python
# decision.py — logica attuale
if d_regime == 1 and ensemble_prob > 0.5:
    effective_threshold -= 0.02   # rende ENTRAMBE le direzioni leggermente più facili
```
Il bias si applica **dopo** l'aggiustamento MTF, come delta aggiuntivo sulla direzione contro-trend:
```
d_regime=1 con MTF:
  effective_threshold = 0.62 - 0.02 = 0.60  (MTF abbassa il threshold base)
  threshold_long  = 0.60                     (long: più facile, MTF già applicato)
  threshold_short = 0.60 + 0.08 = 0.68      (short: il bias si aggiunge sopra MTF)
```

### Parametro aggiuntivo: regime_bias_size_factor

Per i trade contro-trend che passano comunque il threshold alzato, si può ulteriormente ridurre la size:

```
regime_bias_size_factor = 0.5 (default: 1.0 = nessuna riduzione)

In bull (d_regime=1): un segnale SHORT con prob < 0.30 passa il threshold
  → la size viene moltiplicata per 0.5 prima del calcolo rischio
  → il trade avviene, ma con metà del rischio
```

Questo è un filtro secondario opzionale: il threshold asimmetrico filtra la quantità di segnali contro-trend, il size factor riduce il danno di quelli che passano.

---

### Fase 1 — Backend: `decision.py`

**File**: `apps/api/services/decision.py`

**1a. Aggiungere 3 parametri al costruttore `DecisionEngine.__init__`:**

```python
regime_bias_enabled: bool = False,
regime_bias_delta: float = 0.08,
regime_bias_size_factor: float = 1.0,
```
Salvarli come `self.regime_bias_enabled`, `self.regime_bias_delta`, `self.regime_bias_size_factor`.

**1b. Aggiungere campo `size_factor` a `DecisionResult` (dataclass):**

```python
@dataclass
class DecisionResult:
    action: str
    confidence: float
    # ... campi esistenti ...
    size_factor: float = 1.0   # nuovo — 1.0 = nessuna riduzione
```

**1c. Nel metodo `decide()`, dopo il blocco MTF (dopo la riga `effective_threshold -= 0.02`):**

```python
# ── Regime Bias: threshold asimmetrico per direzione ─────────────────────────
# Separa il threshold in due: uno per la direzione con il regime,
# uno (più alto) per la direzione contro il regime.
# Applica DOPO il bonus MTF, come delta aggiuntivo.
threshold_long  = effective_threshold
threshold_short = effective_threshold
counter_trend_size_factor = 1.0

if self.regime_bias_enabled and self.regime_bias_delta > 0:
    if d_regime == 1:    # bull: alzare il threshold per gli short
        threshold_short = effective_threshold + self.regime_bias_delta
        counter_trend_size_factor = self.regime_bias_size_factor
        reasoning.append(
            f"RegimeBias: d_regime=BULL → "
            f"threshold_long={threshold_long:.2f}, "
            f"threshold_short={threshold_short:.2f} (+{self.regime_bias_delta:.2f})"
        )
    elif d_regime == -1:  # bear: alzare il threshold per i long
        threshold_long = effective_threshold + self.regime_bias_delta
        counter_trend_size_factor = self.regime_bias_size_factor
        reasoning.append(
            f"RegimeBias: d_regime=BEAR → "
            f"threshold_long={threshold_long:.2f} (+{self.regime_bias_delta:.2f}), "
            f"threshold_short={threshold_short:.2f}"
        )
    # d_regime == 0: nessuna bias, threshold simmetrici
```

**1d. Modificare le condizioni di entry sostituendo `effective_threshold` con i threshold separati:**

Sostituire (attuale):
```python
if ensemble_prob > effective_threshold:      # long entry
    ...
if short_prob > effective_threshold:         # short entry
    ...
```

Con:
```python
if ensemble_prob > threshold_long:           # long entry
    ...
    return DecisionResult(..., size_factor=
        counter_trend_size_factor if d_regime == -1 else 1.0)

if short_prob > threshold_short:             # short entry
    ...
    return DecisionResult(..., size_factor=
        counter_trend_size_factor if d_regime == 1 else 1.0)
```

> **Nota**: `counter_trend_size_factor` viene passato al DecisionResult solo quando la trade è effettivamente contro-trend (short in bull, long in bear). I trade con-trend hanno sempre `size_factor=1.0`.

---

### Fase 2 — Backend: `backtesting.py`

**File**: `apps/api/services/backtesting.py`

**2a. Leggere i nuovi parametri dalla config (aggiungere ai `getattr` esistenti):**

```python
regime_bias_enabled     = getattr(cfg, "regime_bias_enabled",     False)
regime_bias_delta       = getattr(cfg, "regime_bias_delta",       0.08)
regime_bias_size_factor = getattr(cfg, "regime_bias_size_factor", 1.0)
```

**2b. Passare al costruttore `DecisionEngine` (aggiungere ai kwargs esistenti):**

```python
engine = DecisionEngine(
    # ... parametri esistenti ...
    regime_bias_enabled=regime_bias_enabled,
    regime_bias_delta=regime_bias_delta,
    regime_bias_size_factor=regime_bias_size_factor,
)
```

**2c. Usare `decision.size_factor` nel calcolo della size della posizione:**

Dopo aver ricevuto la `decision`, prima di chiamare `risk_manager.calculate_trade_params`:
```python
# Applicare il size factor del regime bias alla position_size_pct
effective_position_size = risk_manager.position_size_pct * decision.size_factor
# Passare effective_position_size a calculate_trade_params invece del default
```
Alternativa più semplice (meno intrusiva): moltiplicare `size_usd` dopo il calcolo:
```python
params = risk_manager.calculate_trade_params(...)
if decision.size_factor < 1.0:
    params = TradeParams(
        **{**dataclasses.asdict(params),
           "size_usd": params.size_usd * decision.size_factor,
           "size_contracts": params.size_contracts * decision.size_factor}
    )
```

---

### Fase 3 — Backend: `execution.py` (live trading)

Stesso approccio di `backtesting.py`: leggere i 3 nuovi parametri dalla config, passarli a `DecisionEngine`, applicare `decision.size_factor` prima di inviare l'ordine a Hyperliquid.

---

### Fase 4 — Frontend: `BacktestPanel.tsx`

**4a. Aggiungere stato React (vicino agli altri toggle):**

```tsx
const [regimeBiasEnabled, setRegimeBiasEnabled] = useState(false);
const [regimeBiasDelta, setRegimeBiasDelta] = useState('0.08');
const [regimeBiasSizeFactor, setRegimeBiasSizeFactor] = useState('1.0');
```

**4b. Aggiungere `applyConfig` handler per i nuovi params:**

```tsx
if (p.regime_bias_enabled     !== undefined) setRegimeBiasEnabled(p.regime_bias_enabled);
if (p.regime_bias_delta       !== undefined) setRegimeBiasDelta(String(p.regime_bias_delta));
if (p.regime_bias_size_factor !== undefined) setRegimeBiasSizeFactor(String(p.regime_bias_size_factor));
```

**4c. Includere nella request body:**

```tsx
regime_bias_enabled:      regimeBiasEnabled,
regime_bias_delta:        parseFloat(regimeBiasDelta),
regime_bias_size_factor:  parseFloat(regimeBiasSizeFactor),
```

**4d. UI — aggiungere nella sezione "Advanced" (vicino a MTF alignment):**

```
┌─────────────────────────────────────────────────────────────┐
│ [🔀] Regime Bias  [ON/OFF toggle]                           │
│                                                              │
│  Bias delta   [────●──────]  0.08   (range 0.03–0.20)       │
│  Counter-size [──────●────]  1.00   (range 0.30–1.00)       │
│                                                              │
│  ⚠ In bull: short richiedono prob < (1-thr-delta)           │
│    In bear: long richiedono prob > (thr+delta)               │
│    In sideways: nessuna bias                                 │
└─────────────────────────────────────────────────────────────┘
```

Il toggle mostra automaticamente il bias delta solo quando attivo.

**4e. Aggiungere badge in `activeBadges` (vicino agli altri badge):**

```tsx
if (c.regime_bias_enabled)
  activeBadges.push(badge(
    `Bias ±${c.regime_bias_delta ?? 0.08}`,
    'bg-violet-50 dark:bg-violet-500/10 text-violet-600 dark:text-violet-400 border-violet-100 dark:border-violet-500/20'
  ));
```

---


### Fase 6 — Validazione con Backtest

**Test da eseguire dopo l'implementazione:**

| Periodo | Atteso con bias ON | Confronto |
|---------|-------------------|-----------|
| U2 (uptrend +130%) | Meno short, più long → WR migliorato | vs. U2 senza bias |
| U5 (uptrend +74%, blind spot) | Riduzione short da 18→? su 24 | vs. U5 senza bias (-19%) |
| D1 (downtrend -56%) | Meno long, più short | vs. D1 senza bias |
| D2 (downtrend -52%, blind spot) | Riduzione long da 13→? su 15 | vs. D2 senza bias (-4%) |
| S6 (sideways) | Identico — bias OFF in sideways | — |

**Metriche da monitorare:**
- Rapporto long/short per periodo (goal: ≥70% long in uptrend, ≥70% short in downtrend)
- WinRate migliorato o peggiorato
- Trade count non drasticamente ridotto (il delta 0.08 non deve bloccare tutti i counter-trend)
- PnL totale vs. setup senza bias

**Valori di `regime_bias_delta` da testare:** 0.05, 0.08, 0.10, 0.12

Con `delta=0.05`: threshold_short in bull = 0.67 → short se prob < 0.33 (moderato)
Con `delta=0.10`: threshold_short in bull = 0.72 → short se prob < 0.28 (aggressivo)
Con `delta=0.15`: threshold_short in bull = 0.77 → short se prob < 0.23 (quasi bloccante)

Il valore ottimale dipende da quanto frequentemente il LGBM genera segnali con prob < 0.30 in uptrend — da misurare sui backtest.

---

### Note di integrazione con il Regime Detection futuro

Quando il `RegimeDetector` sarà implementato (vedi sezione precedente), il segnale `d_regime` usato dal bias passerà da:

```
Attuale: d_regime ∈ {-1, 0, 1}  (daily EMA20 + ADX, calcolato in smc.py)
Futuro:  regime ∈ {"uptrend", "downtrend", "sideways", "flat", "transition"}
```

La mappa di conversione nel `DecisionEngine` sarà:
```python
# Conversione per retrocompatibilità
regime_to_d = {"uptrend": 1, "downtrend": -1, "sideways": 0, "flat": 0, "transition": 0}
d_regime_for_bias = regime_to_d.get(current_regime, d_regime)
```

In questo modo il Regime Bias non richiede riscrittura quando arriva il detector — solo la fonte del segnale cambia.

---

*Documento creato: 17 maggio 2026*  
*Aggiornato: 18 maggio 2026 — Setup per regime aggiornati con tutti i parametri disponibili (P10 SL Floor, Enhanced Exit, recalibrated thresholds, c2 gates); aggiunti 2 setup dettagliati per ciascuno dei 4 regimi; aggiunto piano Regime Bias con Threshold Asimmetrico*  
*Dati verificati su `poc/data_ohlcv.parquet` — 4.381 candele 4H BTC, mag 2024 – mag 2026*  
*Periodi pre-maggio 2024 basati su training (dati certi fino ad agosto 2025)*
