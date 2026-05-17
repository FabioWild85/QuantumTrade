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

### Setup Consigliati — Regime 1 (Uptrend Forte)

#### Setup A — "Trend Rider" *(aggressivo, massimizza il rendimento sul trend)*

> Filosofia: pochi trade, size piena, trailing SL per catturare l'intera gamba. LGBM + Chronos confermano l'uscita solo quando la tendenza è strutturalmente invertita.

| Parametro | Valore | Motivazione |
|-----------|--------|-------------|
| `directional_threshold` | **0.58** | Bassa soglia — in trend LGBM segnala spesso >0.80, serve poco filtro |
| `adx_gate` | **18** | Permette l'ingresso quando il trend si sta ancora formando |
| `adx_gate_enabled` | true | |
| `confluence_gate` | **50.0** | Non servono 4 conferme — il trend è già evidente |
| `sl_atr_mult` | **1.5** | SL stretto: pullback in uptrend sono shallow, SL largo brucia P&L |
| `tp_atr_mult` | **5.0** | TP aggressivo — il trend forte sposta il prezzo 4–6×ATR prima di invertire |
| `position_size_pct` | **1.8** | Regime ad alta affidabilità — size leggermente sopra la norma |
| `trailing_sl_enabled` | true | Nucleo del setup: cavalcare il trend fino alla fine |
| `trailing_sl_activation` | **2.0** | Attivazione a 2×ATR — evita di scattare sul primo impulso, poi segue fedelmente |
| `partial_tp_enabled` | true | |
| `partial_tp_atr_mult` | **2.5** | Incassa il 30% a 2.5×ATR — il trend in genere continua oltre |
| `partial_tp_pct` | **30** | Solo 30% chiuso — lascia il 70% correre col trailing |
| `be_sl_enabled` | true | |
| `be_sl_activation` | **3.0** | Attivo solo dopo che il prezzo ha già mosso 3×ATR — non disturba il trailing |
| `lgbm_exit_enabled` | true | |
| `lgbm_exit_threshold` | **0.25** | Threshold basso: uscita solo su flip netto, non su oscillazioni |
| `lgbm_exit_min_hold_bars` | **8** | Non uscire prima di 32h (8×4h) — filtra l'inizio del trend |
| `lgbm_exit_confirm_bars` | **3** | 3 barre consecutive di flip = 12h — segnale robusto, non rumore |
| `enhanced_exit_enabled` | true | Chronos p50 sotto entry_price = conferma che il trend si è invertito |
| `chronos_enabled` | true | |
| `chronos_weight` | **0.20** | LGBM domina in trend — Chronos pesa poco sul segnale di entrata |
| `dynamic_sl_tp_enabled` | true | |
| `dynamic_sl_tp_blend` | **0.25** | 25% Chronos, 75% ATR — i range Chronos in trend sono instabili |
| `recalibrated_uncertainty_thresholds` | true | |
| `p10_sl_floor_enabled` | **false** | Bande larghe in uptrend → floor aggraverebbe il size e il rischio |
| `sweep_gate_enabled` | true | Entra dopo sweep di liquidità (common in trend continuations) |
| `fvg_filter_enabled` | true | Ingresso su FVG fill nella direzione del trend |
| `mtf_alignment_enabled` | true | Conferma direzionale su 1D |
| `c2_uncertainty_gate_enabled` | false | Non filtrare in trend forte — l'incertezza Chronos è strutturalmente alta |
| `c2_cont_prob_gate_enabled` | true | |
| `c2_cont_prob_threshold` | **0.20** | Filtra solo se la prob. di continuazione è quasi zero |
| `max_hold_bars_enabled` | **false** | Non troncare il trend artificialmente |
| `max_daily_dd_pct` | **3.5** | Leggermente più largo — il regime richiede di "sopportare" i rimbalzi |
| `max_consecutive_losses` | **3** | 3 stop = forse il trend si è esaurito, pausa obbligatoria |

---

#### Setup B — "Trend Conservative" *(bilanciato, per chi preferisce più protezione sul capitale)*

> Filosofia: partecipa al trend, ma con più filtri e size ridotta. Meno rendimento massimo, meno volatilità dei risultati. Preferibile nella prima settimana del trend quando non è ancora certo.

| Parametro | Valore | Motivazione |
|-----------|--------|-------------|
| `directional_threshold` | **0.60** | Un po' più selettivo — aspetta segnali più netti |
| `adx_gate` | **20** | Solo trend già confermati dall'ADX |
| `adx_gate_enabled` | true | |
| `confluence_gate` | **55.0** | Un filtro aggiuntivo rispetto a Setup A |
| `sl_atr_mult` | **1.8** | Leggermente più largo — meno stop su rimbalzi intermedi |
| `tp_atr_mult` | **4.0** | TP realistico su trend di media intensità |
| `position_size_pct` | **1.5** | Size standard — non si espone eccessivamente |
| `trailing_sl_enabled` | true | |
| `trailing_sl_activation` | **1.5** | Attivazione più rapida — inizia a proteggere prima |
| `partial_tp_enabled` | true | |
| `partial_tp_atr_mult` | **2.0** | Incassa il 50% già a 2×ATR — recupera subito le commissioni |
| `partial_tp_pct` | **50** | 50% chiuso a 2×ATR, 50% con trailing SL |
| `be_sl_enabled` | true | |
| `be_sl_activation` | **2.5** | Dopo che il prezzo ha mosso 2.5×ATR — prima del TP completo |
| `lgbm_exit_enabled` | true | |
| `lgbm_exit_threshold` | **0.28** | Leggermente più sensibile di Setup A |
| `lgbm_exit_min_hold_bars` | **6** | 24h minimo prima di considerare l'uscita LGBM |
| `lgbm_exit_confirm_bars` | **2** | 2 barre di conferma (8h) — più reattivo di Setup A |
| `enhanced_exit_enabled` | true | |
| `chronos_enabled` | true | |
| `chronos_weight` | **0.25** | Peso leggermente più alto — conferma il segnale LGBM |
| `dynamic_sl_tp_enabled` | true | |
| `dynamic_sl_tp_blend` | **0.30** | Più ATR-centrico, piccola influenza Chronos |
| `recalibrated_uncertainty_thresholds` | true | |
| `p10_sl_floor_enabled` | **false** | |
| `sweep_gate_enabled` | true | |
| `fvg_filter_enabled` | true | |
| `mtf_alignment_enabled` | true | |
| `c2_uncertainty_gate_enabled` | false | |
| `c2_cont_prob_gate_enabled` | true | |
| `c2_cont_prob_threshold` | **0.22** | Filtra i segnali con continuazione quasi assente |
| `max_hold_bars_enabled` | **false** | |
| `max_daily_dd_pct` | **3.0** | |
| `max_consecutive_losses` | **4** | |

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

### Setup Consigliati — Regime 2 (Downtrend Forte)

#### Setup A — "Bear Rider" *(aggressivo, cattura la gamba ribassista completa)*

> Filosofia: short dopo conferma ADX + sweep di liquidità, incassa 50% velocemente, BE SL e LGBM Exit gestiscono il residuo. Chronos P10 Floor tira lo SL sopra il recente swing high.

| Parametro | Valore | Motivazione |
|-----------|--------|-------------|
| `directional_threshold` | **0.63** | Selettivo: in downtrend LGBM short segnala >0.78, il threshold filtra i falsi segnali di rimbalzo |
| `adx_gate` | **22** | Obbligatorio in downtrend — filtra i periodi di squeeze/consolidazione |
| `adx_gate_enabled` | true | |
| `confluence_gate` | **58.0** | Richiede convergenza decente — evita di shortare in oversold estremo senza conferme |
| `sl_atr_mult` | **1.5** | Stretto: i bounce durano 1–2 candele 4H, non di più. SL largo = stop garantito su bounce |
| `tp_atr_mult` | **3.0** | Realistico: le gambe short si esauriscono spesso a 2.5–3.5×ATR prima del bounce |
| `position_size_pct` | **1.2** | Leggermente ridotto vs uptrend — volatilità più alta, errori più costosi |
| `trailing_sl_enabled` | **false** | Bounce a V colpiscono sempre il trailing in downtrend |
| `partial_tp_enabled` | true | |
| `partial_tp_atr_mult` | **1.5** | Incassa il 50% a 1.5×ATR — il bounce può arrivare da un momento all'altro |
| `partial_tp_pct` | **50** | Metà posizione chiusa velocemente, l'altra metà gestita da BE SL |
| `be_sl_enabled` | true | |
| `be_sl_activation` | **1.5** | BE SL dopo 1.5×ATR — si attiva dopo o in concomitanza del partial TP |
| `lgbm_exit_enabled` | true | |
| `lgbm_exit_threshold` | **0.30** | Soglia standard — uscita quando LGBM vede inversione |
| `lgbm_exit_min_hold_bars` | **4** | 16h minimo — evita di uscire sui micropullback iniziali |
| `lgbm_exit_confirm_bars` | **2** | 2 barre (8h) di conferma — più reattivo che in uptrend |
| `enhanced_exit_enabled` | true | Chronos p50 > entry_price per short = segnale che il downtrend si è esaurito |
| `chronos_enabled` | true | |
| `chronos_weight` | **0.35** | Più peso al Chronos vs uptrend — utile per leggere la struttura delle bande in downtrend |
| `dynamic_sl_tp_enabled` | true | |
| `dynamic_sl_tp_blend` | **0.40** | 40% Chronos blend — comprime i target nei downtrend veloci |
| `recalibrated_uncertainty_thresholds` | true | |
| `p10_sl_floor_enabled` | **true** | Per i short: usa `p90` come SL floor → SL posizionato sopra lo swing high Chronos |
| `sweep_gate_enabled` | true | Short ideale dopo sweep di liquidità sui massimi precedenti |
| `fvg_filter_enabled` | true | Conferma strutturale — FVG ribassisti nella direzione del downtrend |
| `mtf_alignment_enabled` | true | Il daily deve essere allineato short — fondamentale in downtrend |
| `c2_uncertainty_gate_enabled` | true | |
| `c2_uncertainty_threshold` | **0.06** | Non shortare durante bounce ad alta incertezza (Chronos vede indecisione) |
| `c2_cont_prob_gate_enabled` | false | Il cont_prob è orientato ai long — in short è meno calibrato |
| `max_hold_bars_enabled` | true | |
| `max_hold_bars` | **36** | 9 giorni max — dopo 9 giorni in short il rischio di squeeze aumenta significativamente |
| `max_daily_dd_pct` | **3.0** | |
| `max_consecutive_losses` | **3** | Tre stop = probabile fase di distribuzione/inversione |

---

#### Setup B — "Bear Conservative" *(pochi trade ma precisi, priorità alla protezione del capitale)*

> Filosofia: ADX gate più alto, soglie più stringenti. Meno trade, meno esposizione alle trappole. Preferibile quando il downtrend mostra segnali di rallentamento (ADX in calo da >35) o nella fase finale del bear.

| Parametro | Valore | Motivazione |
|-----------|--------|-------------|
| `directional_threshold` | **0.65** | Solo i segnali short molto netti |
| `adx_gate` | **25** | Solo downtrend con momentum forte confermato |
| `adx_gate_enabled` | true | |
| `confluence_gate` | **62.0** | Alta convergenza richiesta — filtra i segnali marginali |
| `sl_atr_mult` | **1.8** | Leggermente più largo — meno stop su spike intracandle |
| `tp_atr_mult` | **2.5** | TP conservativo — prendi il profitto sicuro prima del bounce |
| `position_size_pct` | **1.0** | Size ridotta — in regime incerto meglio ridurre l'esposizione |
| `trailing_sl_enabled` | **false** | |
| `partial_tp_enabled` | true | |
| `partial_tp_atr_mult` | **1.5** | |
| `partial_tp_pct` | **60** | Incassa il 60% subito — il residuo è quasi un free trade |
| `be_sl_enabled` | true | |
| `be_sl_activation` | **1.0** | BE SL molto rapido — appena il prezzo si muove a favore, proteggi |
| `lgbm_exit_enabled` | true | |
| `lgbm_exit_threshold` | **0.25** | Più sensibile — esci prima in caso di potenziale inversione |
| `lgbm_exit_min_hold_bars` | **3** | Solo 12h minimo — in downtrend le cose cambiano velocemente |
| `lgbm_exit_confirm_bars` | **2** | |
| `enhanced_exit_enabled` | **false** | Più conservativo — non usare Chronos per l'uscita (rischio falsi positivi in downtrend accelerato) |
| `chronos_enabled` | true | |
| `chronos_weight` | **0.30** | |
| `dynamic_sl_tp_enabled` | true | |
| `dynamic_sl_tp_blend` | **0.45** | |
| `recalibrated_uncertainty_thresholds` | true | |
| `p10_sl_floor_enabled` | **false** | Approccio conservativo — non aggiungere complessità in setup già stretto |
| `sweep_gate_enabled` | true | |
| `fvg_filter_enabled` | true | |
| `mtf_alignment_enabled` | true | |
| `c2_uncertainty_gate_enabled` | true | |
| `c2_uncertainty_threshold` | **0.07** | Ancora più restrittivo — filtra più situazioni ambigue |
| `c2_cont_prob_gate_enabled` | true | |
| `c2_cont_prob_threshold` | **0.30** | Richiede prob. di continuazione — evita di shortare all'oversold estremo |
| `max_hold_bars_enabled` | true | |
| `max_hold_bars` | **24** | 6 giorni max — uscita forzata; in downtrend i bounce settimanali sono frequenti |
| `max_daily_dd_pct` | **2.5** | DD giornaliero più stretto — protezione capital in regime ad alto rischio |
| `max_consecutive_losses` | **3** | |

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
- `c2_uncertainty_gate` ON (threshold 0.04–0.05) — incertezza alta in sideways = Chronos vede indecisione = non entrare; è il filtro più potente per questo regime
- `c2_cont_prob_gate` ON (threshold 0.30–0.35) — bassa probabilità di continuazione = il range sta per invertire = non entrare
- Max Hold Bars 18–24 (4.5–6 giorni) — in un range non esiste "trend da aspettare"; se non raggiungi TP entro 6 giorni, probabilmente il trade è bloccato nel range → esci
- Dir Threshold 0.65–0.68 — non basta un segnale vago per entrare in sideways; richiedi segnali netti

---

### Setup Consigliati — Regime 3 (Sideways / Ranging)

#### Setup A — "Range Trader" *(ottimizzato per range trading attivo con rotazioni frequenti)*

> Filosofia: entra solo quando tutti i filtri sono allineati, incassa subito il 50%, BE SL protegge il residuo, LGBM + Chronos eseguono l'uscita rapida se il trade si blocca. Il P10 Floor comprime lo SL per i falsi breakout.

| Parametro | Valore | Motivazione |
|-----------|--------|-------------|
| `directional_threshold` | **0.65** | Range richiede segnali più netti — LGBM in sideways produce più rumore |
| `adx_gate` | **22** | Filtra la fase centrale del range (ADX <20), permette l'ingresso ai bordi (ADX 20–24) |
| `adx_gate_enabled` | true | |
| `confluence_gate` | **65.0** | Alta convergenza — in sideways solo le setup con 3–4 conferme sono affidabili |
| `sl_atr_mult` | **2.0** | Moderato — ATR già basso in ranging; lo SL in $ è contenuto |
| `tp_atr_mult` | **2.0** | TP stretto uguale a SL: RR 1:1 compensato dall'alto partial TP early |
| `position_size_pct` | **1.0** | Regime a bassa affidabilità — size ridotta per limitare i danni sui falsi breakout |
| `trailing_sl_enabled` | **false** | |
| `partial_tp_enabled` | true | |
| `partial_tp_atr_mult` | **1.5** | Incassa a 1.5×ATR — metà del TP finale, ma con probabilità molto alta |
| `partial_tp_pct` | **50** | |
| `be_sl_enabled` | true | |
| `be_sl_activation` | **1.5** | Contemporaneo al partial TP — appena tocca 1.5×ATR, sia incasso che protezione |
| `lgbm_exit_enabled` | true | |
| `lgbm_exit_threshold` | **0.35** | Threshold alto: in sideways i segnali oscillano — vuoi solo i flip netti |
| `lgbm_exit_min_hold_bars` | **4** | 16h minimo — evita di uscire su fakeout del range |
| `lgbm_exit_confirm_bars` | **2** | 2 barre (8h) — reattivo ma non impulsivo |
| `enhanced_exit_enabled` | true | Chronos + LGBM entrambi confermano il rifiuto della direzione → uscita immediata |
| `chronos_enabled` | true | |
| `chronos_weight` | **0.45** | Chronos più utile in sideways — le bande definiscono i confini del range |
| `dynamic_sl_tp_enabled` | true | |
| `dynamic_sl_tp_blend` | **0.60** | Blend alto verso Chronos — le bande p10/p90 mappano meglio i limiti del range rispetto all'ATR puro |
| `recalibrated_uncertainty_thresholds` | true | |
| `p10_sl_floor_enabled` | **true** | In sideways le bande sono strette → p10/p90 vicini → floor tighten lo SL efficacemente |
| `sweep_gate_enabled` | true | In sideways i fake sweep ai bordi del range sono frequenti — li filtra |
| `fvg_filter_enabled` | true | FVG ai bordi del range = setup di alta qualità |
| `mtf_alignment_enabled` | true | Assicura che il segnale sia allineato con il daily — evita segnali contro il trend di fondo |
| `c2_uncertainty_gate_enabled` | true | |
| `c2_uncertainty_threshold` | **0.05** | Incertezza alta in sideways = non entrare; le bande larghe segnalano confusione |
| `c2_cont_prob_gate_enabled` | true | |
| `c2_cont_prob_threshold` | **0.30** | Bassa continuazione = il range sta invertendo → non entrare |
| `max_hold_bars_enabled` | true | |
| `max_hold_bars` | **24** | 6 giorni max — se in 6 giorni il trade è ancora aperto in range, esci |
| `max_daily_dd_pct` | **2.5** | Più stretto del trend — sideways genera più stop piccoli, limitare il DD totale |
| `max_consecutive_losses` | **3** | In sideways 3 stop consecutivi = setup non funziona su questo range specifico |

---

#### Setup B — "Range Sniper" *(ultra-selettivo, pochi trade ma solo ai confini del range con alta probabilità)*

> Filosofia: aspetta i setup perfetti — bordi del range + sweep + FVG + Chronos bande strette + alta cont_prob. Pochissimi trade, win rate molto alto. Adatto a range molto definiti come S6, S8.

| Parametro | Valore | Motivazione |
|-----------|--------|-------------|
| `directional_threshold` | **0.68** | Solo i segnali molto forti ai bordi del range |
| `adx_gate` | **25** | Solo quando l'ADX è momentaneamente alto (breakout falso o bordo netto) |
| `adx_gate_enabled` | true | |
| `confluence_gate` | **68.0** | Tutti i filtri devono essere allineati — nessun compromesso |
| `sl_atr_mult` | **2.0** | |
| `tp_atr_mult` | **2.5** | TP leggermente più largo — entra solo ai bordi del range, il centro è il TP naturale |
| `position_size_pct` | **0.8** | Ancora più conservativo — pochissimi trade, ogni errore è costoso |
| `trailing_sl_enabled` | **false** | |
| `partial_tp_enabled` | true | |
| `partial_tp_atr_mult` | **1.5** | |
| `partial_tp_pct` | **60** | 60% chiuso immediatamente — lascia solo 40% esposto verso il TP finale |
| `be_sl_enabled` | true | |
| `be_sl_activation` | **2.0** | Attivazione dopo il partial TP — copre il residuo |
| `lgbm_exit_enabled` | true | |
| `lgbm_exit_threshold` | **0.28** | Più sensibile — esci appena il segnale si indebolisce significativamente |
| `lgbm_exit_min_hold_bars` | **3** | 12h minimo |
| `lgbm_exit_confirm_bars` | **2** | |
| `enhanced_exit_enabled` | true | |
| `chronos_enabled` | true | |
| `chronos_weight` | **0.50** | Chronos ha peso uguale a LGBM — in range stretto è altrettanto affidabile |
| `dynamic_sl_tp_enabled` | true | |
| `dynamic_sl_tp_blend` | **0.65** | Le bande Chronos in sideways definiscono meglio i target dei puri multipli ATR |
| `recalibrated_uncertainty_thresholds` | true | |
| `p10_sl_floor_enabled` | **true** | |
| `sweep_gate_enabled` | true | Criterio di qualità — setup solo su sweep ai bordi del range |
| `fvg_filter_enabled` | true | |
| `mtf_alignment_enabled` | true | |
| `c2_uncertainty_gate_enabled` | true | |
| `c2_uncertainty_threshold` | **0.04** | Ancora più restrittivo — solo quando Chronos è molto sicuro sulla direzione |
| `c2_cont_prob_gate_enabled` | true | |
| `c2_cont_prob_threshold` | **0.35** | Alta certezza di continuazione — solo ai bordi netti del range |
| `max_hold_bars_enabled` | true | |
| `max_hold_bars` | **18** | 4.5 giorni max — in range stretto, se non si muove in 4.5 giorni, esci |
| `max_daily_dd_pct` | **2.0** | DD giornaliero stretto — questo setup deve avere alta precision |
| `max_consecutive_losses` | **2** | Due stop consecutivi = range non è tradabile, pausa |

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
- `c2_uncertainty_gate` ON con threshold 0.035–0.04 — in flat il Chronos mostra incertezza alta (bande strette = mercato indeciso); questo filtro da solo esclude il 70–80% dei periodi flat
- `c2_cont_prob_gate` ON con threshold 0.40 — richiede alta probabilità di continuazione; in flat quasi mai presente
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

### Setup Consigliati — Regime 4 (Flat / Low Volatility)

#### Setup A — "Flat Survival" *(protezione massima, trade rari, uscita fulminea)*

> Filosofia: l'obiettivo è sopravvivere al periodo flat senza perdite significative. Se un setup passa tutti i filtri (raro), entra piccolo, incassa velocemente, esci al primo segnale di debolezza. Ogni trade in flat deve chiudersi entro 3 giorni.

| Parametro | Valore | Motivazione |
|-----------|--------|-------------|
| `directional_threshold` | **0.68** | Solo i segnali nettissimi — in flat LGBM è ai limiti dell'affidabilità |
| `adx_gate` | **25** | Filtra il 90% dei periodi flat (ADX tipicamente <17) |
| `adx_gate_enabled` | true | |
| `confluence_gate` | **70.0** | Quasi tutto deve essere allineato — la barra è altissima |
| `sl_atr_mult` | **2.0** | ATR basso → SL in $ contenuto anche a 2×ATR; non ridurre ulteriormente |
| `tp_atr_mult` | **2.5** | Il massimo ragionevole in flat — raramente il prezzo si muove oltre |
| `position_size_pct` | **0.8** | Minima esposizione — in flat l'expected value è vicino a zero |
| `trailing_sl_enabled` | **false** | In flat non c'è trend da seguire |
| `partial_tp_enabled` | true | |
| `partial_tp_atr_mult` | **1.5** | Incassa il 60% a 1.5×ATR — in flat è già un ottimo risultato |
| `partial_tp_pct` | **60** | Prendi la maggior parte subito |
| `be_sl_enabled` | true | |
| `be_sl_activation` | **1.0** | BE SL rapidissimo — appena sei in profitto di 1×ATR, proteggi tutto |
| `lgbm_exit_enabled` | true | |
| `lgbm_exit_threshold` | **0.35** | Threshold alto — esce solo su segnale di inversione netto |
| `lgbm_exit_min_hold_bars` | **2** | Solo 8h minimo — in flat il prezzo può invertire in 2 candele |
| `lgbm_exit_confirm_bars` | **1** | **1 sola barra** — reazione immediata al flip in flat |
| `enhanced_exit_enabled` | **false** | In flat la doppia conferma è controproducente: rallenta l'uscita |
| `chronos_enabled` | true | |
| `chronos_weight` | **0.50** | Chronos e LGBM hanno peso uguale — in flat nessuno dei due è chiaramente superiore |
| `dynamic_sl_tp_enabled` | true | |
| `dynamic_sl_tp_blend` | **0.55** | Leggermente orientato Chronos — le bande strette calibrano meglio i target in flat |
| `recalibrated_uncertainty_thresholds` | true | |
| `p10_sl_floor_enabled` | **true** | Bande Chronos strettissime in flat → floor comprime lo SL chirurgicamente |
| `sweep_gate_enabled` | true | In flat i falsi sweep sono comuni — filtrarli è essenziale |
| `fvg_filter_enabled` | true | |
| `mtf_alignment_enabled` | true | Allineamento daily — se il daily non è chiaro, non entrare |
| `c2_uncertainty_gate_enabled` | true | |
| `c2_uncertainty_threshold` | **0.04** | Soglia bassa — in flat la maggior parte dei segnali hanno incertezza >4%; questo filtro esclude il grosso |
| `c2_cont_prob_gate_enabled` | true | |
| `c2_cont_prob_threshold` | **0.35** | Alta continuazione richiesta — in flat raramente presente |
| `max_hold_bars_enabled` | true | |
| `max_hold_bars` | **12** | 3 giorni assoluti — nessun trade flat deve sopravvivere oltre 3 giorni |
| `max_daily_dd_pct` | **2.0** | DD giornaliero strettissimo — priorità assoluta alla protezione capital |
| `max_consecutive_losses` | **2** | Due stop = flat è diventato volatile o breakout imminente; fermati |

---

#### Setup B — "Flat Stealth" *(ancora più conservativo — praticamente non tradare, registra solo i breakout iniziali)*

> Filosofia: fissa le soglie così alte che il bot praticamente si ferma da solo in flat. Se qualcosa passa tutti i filtri, probabilmente è l'inizio di un regime change (breakout) — entra piccolo e proteggiti velocemente.

| Parametro | Valore | Motivazione |
|-----------|--------|-------------|
| `directional_threshold` | **0.70** | Soglia quasi al limite — solo segnali eccezionali |
| `adx_gate` | **28** | In pieno flat (ADX ~13–15) non passerà quasi nulla; se supera 28 è già un regime change |
| `adx_gate_enabled` | true | |
| `confluence_gate` | **72.0** | Barra altissima — accetta solo 1–2 trade a settimana al massimo |
| `sl_atr_mult` | **1.8** | Leggermente ridotto — ATR così basso che anche 1.8× è sufficiente come protezione |
| `tp_atr_mult` | **2.0** | Molto stretto — in flat non sperare in grandi movimenti |
| `position_size_pct` | **0.6** | Il minimo sensato — se entra qualcosa, entra piano |
| `trailing_sl_enabled` | **false** | |
| `partial_tp_enabled` | true | |
| `partial_tp_atr_mult` | **1.2** | TP parziale quasi immediato — a 1.2×ATR in flat è già un successo |
| `partial_tp_pct` | **60** | |
| `be_sl_enabled` | true | |
| `be_sl_activation` | **0.8** | BE SL quasi immediato — appena il prezzo si muove a favore, è protetto |
| `lgbm_exit_enabled` | true | |
| `lgbm_exit_threshold` | **0.35** | |
| `lgbm_exit_min_hold_bars` | **2** | |
| `lgbm_exit_confirm_bars` | **1** | |
| `enhanced_exit_enabled` | **false** | |
| `chronos_enabled` | true | |
| `chronos_weight` | **0.55** | Chronos ha il peso leggermente maggiore — in flat è più stabile di LGBM |
| `dynamic_sl_tp_enabled` | true | |
| `dynamic_sl_tp_blend` | **0.60** | |
| `recalibrated_uncertainty_thresholds` | true | |
| `p10_sl_floor_enabled` | **true** | |
| `sweep_gate_enabled` | true | |
| `fvg_filter_enabled` | true | |
| `mtf_alignment_enabled` | true | |
| `c2_uncertainty_gate_enabled` | true | |
| `c2_uncertainty_threshold` | **0.035** | Soglia più bassa — esclude ancora più situazioni |
| `c2_cont_prob_gate_enabled` | true | |
| `c2_cont_prob_threshold` | **0.40** | Alta certezza di continuazione — quasi mai presente in flat |
| `max_hold_bars_enabled` | true | |
| `max_hold_bars` | **12** | |
| `max_daily_dd_pct` | **1.5** | Limita i danni al minimo assoluto |
| `max_consecutive_losses` | **2** | |

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
*Aggiornato: 17 maggio 2026 — Setup per regime aggiornati con tutti i parametri disponibili (P10 SL Floor, Enhanced Exit, recalibrated thresholds, c2 gates); aggiunti 2 setup dettagliati per ciascuno dei 4 regimi*  
*Dati verificati su `poc/data_ohlcv.parquet` — 4.381 candele 4H BTC, mag 2024 – mag 2026*  
*Periodi pre-maggio 2024 basati su training (dati certi fino ad agosto 2025)*
