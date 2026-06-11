# Guida alla Validazione Professionale del Sistema — Quantum Trade

> **Obiettivo:** trasformare un backtest che "sembra ottimo" in una stima affidabile della performance futura, seguendo gli standard usati dai desk quant istituzionali.
>
> Leggi ogni sezione nell'ordine in cui è scritta: ogni punto costruisce sul precedente.

---

## Indice

1. [Protocollo OOS Rigoroso](#1-protocollo-oos-rigoroso)
2. [Hold-Out Intoccabile](#2-hold-out-intoccabile)
3. [Sensitivity Analysis](#3-sensitivity-analysis)
4. [Monte Carlo sui Trade](#4-monte-carlo-sui-trade)
5. [Modello di Slippage e Stress Test dei Costi](#5-modello-di-slippage-e-stress-test-dei-costi)
6. [Paper Trading con Tracking Error](#6-paper-trading-con-tracking-error)
7. [Risk a Livello Portafoglio](#7-risk-a-livello-portafoglio)
8. [Attribution per Gate (param_stats)](#8-attribution-per-gate-param_stats)
9. [Checklist finale prima del capitale reale](#9-checklist-finale-prima-del-capitale-reale)

---

## 1. Protocollo OOS Rigoroso

### Il problema in parole semplici

Immagina di studiare per un esame con le stesse domande che ci sono nel compito. Ovviamente prenderai 10. Ma se poi ti danno un compito con domande nuove, probabilmente farai molto peggio.

Il tuo LightGBM è nella stessa situazione. Se il modello è stato addestrato su dati che includono il 2024, e poi fai il backtest sul 2024, il modello **ha già "visto le domande dell'esame"**. Non importa quanto siano ottimi i numeri: non ti dicono nulla sulla performance futura.

Nel codice attuale (`backtesting.py`), il backtest carica `lgbm_latest.pkl` — il modello corrente addestrato su tutti i dati disponibili, inclusi quelli del periodo che stai testando. Questo si chiama **data leakage** ed è la causa principale di risultati gonfiati.

### La soluzione: Walk-Forward Backtest con retraining temporale

Il principio è semplice: **il modello può usare solo i dati che esistevano in quel momento nel passato.**

Esistono due livelli di applicazione:

---

#### Livello 1 — Semplice (punto di partenza obbligatorio)

Prima di eseguire un backtest su un periodo, ri-addestri il modello **usando solo dati antecedenti a quel periodo**.

**Esempio pratico:**
- Vuoi testare il 2024 (1 gennaio → 31 dicembre)
- Vai su `/retrain` e lancia un retrain con `from_date = "2020-01-01"` e imposta manualmente la data di fine come `"2023-12-31"` (questo richiede una modifica al trainer per accettare `to_date`)
- Salva il modello risultante come `lgbm_pre2024.pkl`
- Esegui il backtest 2024 caricando **quel** modello, non `lgbm_latest.pkl`

Senza fare questo, ogni backtest su dati passati è **in-sample** per definizione, indipendentemente da quanti anni indietro vai.

---

#### Livello 2 — Rolling Walk-Forward (standard professionale)

Questo è quello che il bot fa in produzione (retraining ogni ~120 candele), replicato dentro il backtest stesso.

Il ciclo funziona così:

```
├── Addestra su: [2020-01-01 → 2022-12-31]
├── Testa su:    [2023-01-01 → 2023-03-31]  ← risultati validi
│
├── Ri-addestra su: [2020-01-01 → 2023-03-31]
├── Testa su:       [2023-04-01 → 2023-06-30]  ← risultati validi
│
├── Ri-addestra su: [2020-01-01 → 2023-06-30]
├── Testa su:       [2023-07-01 → 2023-09-30]  ← risultati validi
│
... e così via fino alla fine
```

I risultati di ogni finestra di test vengono concatenati: **quella è la tua equity curve OOS reale**.

**Implementazione in Quantum Trade:**

Il backtesting engine deve essere modificato per:
1. Dividere l'intervallo `[from_date, to_date]` in N finestre (es. trimestrali)
2. Prima di ogni finestra, chiamare `LGBMTrainer.retrain(from_date=..., to_date=finestra-1)` (da aggiungere al trainer)
3. Eseguire la simulazione su quella finestra con il modello appena addestrato
4. Concatenare i risultati

**Purge gap**: tra la fine del training e l'inizio del test, scarta sempre almeno 5 barre (già presente nel WF CV interno — va applicato anche qui).

---

#### Cosa aspettarsi dopo l'implementazione

I numeri scenderanno. Un sistema **genuinamente buono** su BTC 4H in OOS reale produce tipicamente:
- Sharpe: 0.8 – 2.0
- Win rate: 52 – 62%
- PnL annuo: 20 – 80%
- Max drawdown: 10 – 25%

Se dopo il vero OOS i numeri sono ancora molto superiori, hai comunque trovato qualcosa di potenzialmente interessante — ma verifica i punti 3, 4, 5 prima di fidarti.

---

## 2. Hold-Out Intoccabile

### Il problema in parole semplici

Anche con il protocollo OOS corretto, c'è un rischio sottile: ogni volta che guardi i risultati e modifichi la configurazione (soglie, gate, parametri) stai **implicitamente ottimizzando** anche sul periodo OOS. Dopo 50 iterazioni di "provo questo, guardo il risultato, aggiusto, riprovo", il tuo periodo OOS non è più davvero out-of-sample.

I fondi istituzionali chiamano questo il **"Multiple Testing Problem"** o **"backtest overfitting"**. La soluzione è tenere nascosto un pezzo di storico che **non guardi mai** fino alla decisione finale di andare live.

### Come implementarlo

**Passo 1 — Scegli e congela il periodo di hold-out**

Prendi gli ultimi 4–6 mesi di dati disponibili (es. da gennaio 2026 a oggi). Decidi questa finestra **una volta sola** e scrivila qui sotto:

```
HOLD-OUT PERIOD (non toccare):
  Da: 2026-01-01
  A:  2026-06-10  (o data corrente)
```

**Passo 2 — Lavora solo sul periodo di sviluppo**

Tutto lo sviluppo, ottimizzazione, sensitivity analysis si fa su dati fino al 31 dicembre 2025. Il hold-out non lo guardi.

**Passo 3 — Test finale**

Quando sei soddisfatto della configurazione e pensi che il sistema sia pronto, **una sola volta** esegui il backtest sul hold-out. Quel risultato è la tua stima onesta delle performance future.

Se il risultato è deludente: il sistema non funziona quanto pensavi. Non puoi riottimizzare e ritestare — quello azzererebbe l'utilità del hold-out.

**Regola d'oro:** il hold-out è come la risposta di un esame che non puoi consultare mentre studi. La sua utilità dipende dall'onestà con cui lo tratti.

---

## 3. Sensitivity Analysis

### Il problema in parole semplici

La tua configurazione ha ~70 parametri. Dopo molti backtest, trovi combinazioni che funzionano magnificamente sul passato. Ma molti di quei parametri potrebbero essere perfetti **solo per quel particolare pezzo di storia**, non perché catturano un vero pattern di mercato.

Un **edge reale** (vantaggio genuino) è robusto: se lo perturbi un po', funziona ancora decentemente. Un parametro curve-fitted è fragile: spostalo del 20% e il sistema collassa.

### Come fare la sensitivity analysis

Per ogni parametro importante, lancia 3 backtest: con il valore corrente, con il valore ridotto del 25%, con il valore aumentato del 25%.

**Parametri prioritari da testare:**

| Parametro | Valore attuale | Test -25% | Test +25% |
|---|---|---|---|
| `directional_threshold` | 0.62 | 0.465 | 0.775 |
| `sl_atr_mult` | 1.0 | 0.75 | 1.25 |
| `tp_atr_mult` | 2.5 | 1.875 | 3.125 |
| `adx_gate` | 18 | 13.5 | 22.5 |
| `absorption_z_threshold` | 2.5 | 1.875 | 3.125 |
| `ls_long_block_pct` | 78 | 58.5 | 97.5 (disattivato) |
| `oi_spike_thr` | 3.0 | 2.25 | 3.75 |
| `atr_pct_min` | 0.8% | 0.6% | 1.0% |

**Come leggere i risultati:**

```
Parametro X = valore base → Sharpe 2.0, DD 8%
Parametro X = -25%        → Sharpe 1.7, DD 10%  ✅ degrada dolcemente = robusto
Parametro X = +25%        → Sharpe 1.8, DD 9%   ✅

Parametro Y = valore base → Sharpe 2.0, DD 8%
Parametro Y = -25%        → Sharpe 0.2, DD 35%  ❌ collasso = curve-fitted
Parametro Y = +25%        → Sharpe -0.5, DD 50% ❌
```

I parametri che causano un collasso vanno eliminati o semplificati. La loro performanza nel backtest originale era statistica, non edge reale.

**Strumento aggiuntivo — Surface plot:** lancia una grid 5×5 su coppie di parametri chiave (es. SL mult × threshold) e colora le celle per Sharpe. Un edge reale forma un plateau ampio; un artefatto forma un picco stretto.

---

## 4. Monte Carlo sui Trade

### Il problema in parole semplici

Il tuo backtest produce **una sola sequenza di trade**: i 287 trade nell'ordine in cui si sono verificati nel 2024. Ma il futuro non andrà in quello stesso ordine. La domanda vera è: **quanto male può andare con quegli stessi trade in una sequenza diversa?**

Con 287 trade e Sharpe 7, il risultato sembra invincibile. Ma se i trade fossero arrivati in sequenza sfavorevole (5 loss consecutivi a inizio anno, poi il recupero lento), il tuo max DD sarebbe stato diverso. Il Monte Carlo ti dà la distribuzione completa dei possibili outcome.

### Come implementarlo

**Algoritmo Bootstrap:**

1. Prendi la lista dei 287 PnL% (uno per trade)
2. Ripetila N volte (es. 10.000):
   - Estrai casualmente 287 trade con ripetizione (bootstrap)
   - Calcola equity curve, max DD, Sharpe per quella sequenza
3. Raccogli le distribuzioni

**Metriche che vuoi osservare:**

- **Percentile 5° del max DD:** "nel 5% dei casi peggiori, qual è il massimo drawdown?" → questa è la tua stima conservativa del rischio
- **Percentile 5° del PnL annuo:** "nel 5% dei casi, quanto guadagno?"
- **Probabilità di rovina** (DD > 20%): idealmente < 1%
- **Probabilità PnL < 0** sull'anno: se è > 10%, il sistema non è affidabile

**Cosa aspettarsi da un sistema sano:**

```
Max DD p5°: 8–15%       (il tuo 4.06% è quasi certamente sottostimato)
PnL p5°: +5–20%         (non zero o negativo)
P(rovina DD>20%): < 2%
P(anno negativo): < 10%
```

**Implementazione pratica rapida (Python):**

```python
import numpy as np

pnls = [t["pnl_pct"] for t in trades]  # lista dei tuoi 287 PnL%
n_sim = 10_000
results = []

for _ in range(n_sim):
    seq = np.random.choice(pnls, size=len(pnls), replace=True)
    # Equity curve cumulativa
    equity = np.cumprod(1 + seq / 100) * 10_000
    peak = np.maximum.accumulate(equity)
    dd = (equity - peak) / peak
    results.append({
        "max_dd": dd.min() * 100,
        "final_pnl": (equity[-1] / 10_000 - 1) * 100
    })

dds = [r["max_dd"] for r in results]
pnls_final = [r["final_pnl"] for r in results]

print(f"Max DD p5°: {np.percentile(dds, 5):.1f}%")
print(f"Max DD mediano: {np.percentile(dds, 50):.1f}%")
print(f"PnL p5°: {np.percentile(pnls_final, 5):.1f}%")
print(f"P(anno negativo): {(np.array(pnls_final) < 0).mean() * 100:.1f}%")
```

---

## 5. Modello di Slippage e Stress Test dei Costi

### Il problema in parole semplici

Nel backtest entri ed esci **esattamente al prezzo di close della candela segnale**, pagando solo la taker fee di HL (0.035%). Nella realtà, anche in un mercato liquido come BTC perp:

- Quando fai market order, il prezzo si muove contro di te (lo chiamano **market impact** o slippage)
- Nelle fasi turbolente (crash rapidi, spike) lo slippage può essere anche 10–20 bps in un singolo trade
- I tuoi SL vengono eseguiti proprio in quei momenti: il momento peggiore per lo slippage

Questo è particolarmente rilevante per te: SL 1×ATR con partial TP 50% significa molte esecuzioni. Ogni esecuzione con 5 bps extra di slippage su $10.000 di notional → $5 per trade → $1.435 in 287 trade = circa **14% di PnL eroso** solo dallo slippage.

### Come implementare il modello di slippage

Aggiungi al backtest engine una funzione di slippage realistica:

```python
def apply_slippage(price: float, side: str, atr: float, slippage_atr_frac: float = 0.02) -> float:
    """
    Slippage = frazione dell'ATR nella direzione avversa all'entrata/uscita.
    Default: 2% dell'ATR (conservativo per BTC perp liquido).
    """
    spread = atr * slippage_atr_frac
    if side == "long":
        return price + spread   # compri leggermente più caro
    else:
        return price - spread   # vendi leggermente più basso
```

**Modello a 3 livelli di stress test:**

| Scenario | Slippage | Fee | A cosa corrisponde |
|---|---|---|---|
| **Ottimistico** | 1 bps | 0.035% (attuale) | Mercato normale, book spesso |
| **Realistico** | 3–5 bps | 0.035% | Operatività normale |
| **Pessimistico** | 10–15 bps | 0.05% | Volatilità elevata, SL su spike |

**Regola di validazione:** il sistema deve restare profittevole anche nello scenario **realistico**. Se i numeri reggono solo con zero slippage, l'edge non è sufficiente.

**Considerazioni aggiuntive da modellare:**

- **Partial TP**: i 50% parziali escono in un momento spesso già mosso — applica +50% slippage rispetto all'entrata
- **SL hit su spike**: applica 2× slippage normale
- **Funding accrued**: già modellato nel tuo backtest — bene, mantienilo

---

## 6. Paper Trading con Tracking Error

### Il problema in parole semplici

Anche con OOS corretto, slippage modellato e Monte Carlo, il backtest rimane una simulazione. L'unico modo per sapere se il sistema funziona davvero è **confrontare le previsioni con la realtà in tempo reale**, senza rischiare capitale.

Il **tracking error** è la differenza tra quello che il backtest si aspettava e quello che il live ha prodotto. Se quella differenza è troppo grande, qualcosa nel backtest è sbagliato: ci sono assunzioni irrealistiche, dati storici di qualità diversa, o semplicemente overfitting.

### Come strutturare il paper trading

**Passo 1 — Definisci le metriche attese PRIMA di iniziare**

Prima di attivare il paper, calcola queste metriche sul tuo miglior backtest OOS (non su quello in-sample!) e scrivile:

```
METRICHE ATTESE (da aggiornare con il risultato del vero OOS):

Win rate atteso:          ____% (±5%)
Avg win atteso:           ____% 
Avg loss atteso:          ____% 
Trade/settimana attesi:   ____ (±1)
Sharpe mensile atteso:    ____
Max DD atteso (p25°):     ____% 
```

**Passo 2 — Testa per almeno 50–100 trade (non per settimane fisse)**

I mercati possono essere tranquilli per settimane. Non fermarti a "2 mesi" — aspetta almeno 50 trade (con 287 in un anno, sono circa 2–3 mesi di media).

**Passo 3 — Controllo statistico: regola dei 2σ**

Dopo ogni 10 trade, calcola la media mobile del win rate e confronta con il valore atteso. Se si discosta di più di **2 deviazioni standard**, ferma il sistema e analizza.

**Formula:**
```
σ = sqrt(WR_atteso × (1 - WR_atteso) / n_trade)
Limite inferiore 2σ = WR_atteso - 2 × σ
```

**Esempio:** WR atteso 55%, dopo 50 trade
```
σ = sqrt(0.55 × 0.45 / 50) = 0.070
Limite inferiore = 0.55 - 2 × 0.070 = 41%
→ Se il win rate live scende sotto 41%, è anomalo (probabilità < 2.5%)
```

**Passo 4 — Log di ogni trade con causa di discrepanza**

Per ogni trade dove l'outcome differisce dall'atteso (es. SL colpito prima del TP teorico), documenta il perché. Le cause ricorrenti rivelano i difetti del backtest.

**Metriche di allerta rossa (stop immediato del paper → analisi prima di continuare):**

- Win rate live < atteso − 2σ per 30+ trade
- Max DD live > percentile 75° del Monte Carlo
- Trade/settimana < 50% o > 200% del valore atteso (il modello si comporta diversamente live)
- Qualsiasi perdita singola > 3× il worst trade del backtest

---

## 7. Risk a Livello Portafoglio

### Il problema in parole semplici

Hai due protezioni giornaliere (daily DD 3% e max consecutive loss 4), ma **non hai protezioni a lungo termine**. Un sistema può perdere 2.9% ogni giorno per 5 giorni di fila, scattare il daily DD ogni volta, e alla fine del mese avere perso il 14% — senza mai attivare nessun kill-switch.

Gli istituzionali gestiscono il rischio su **tre orizzonti**: giornaliero, settimanale/mensile, e totale da picco equity.

### Protezioni da aggiungere

#### A. Weekly DD Cap (priorità alta)

Imposta un limite di perdita settimanale. Se lo raggiungi, nessun nuovo trade fino al lunedì successivo.

**Valore consigliato:** 6–8% del capitale

*Implementazione:* nel ciclo di esecuzione live, calcola `(equity_corrente - equity_a_inizio_settimana) / equity_a_inizio_settimana`. Se < −0.07, `result.action = "no_trade"` per tutti i cicli rimanenti della settimana.

#### B. Monthly DD Cap

Stesso concetto su base mensile.

**Valore consigliato:** 12–15% del capitale

#### C. Kill-Switch su DD Totale da Picco

Questo è il più importante. Se l'equity scende del X% dal massimo storico raggiunto, il bot si ferma **completamente** e non ricomincia finché non supera una soglia di rivalutazione manuale.

**Valore consigliato:** −15% da equity peak

*Logica:* un sistema sano non dovrebbe mai perdere più del 15% dal suo picco. Se succede, c'è quasi certamente qualcosa che non va (regime di mercato completamente nuovo, dati corrotti, bug nel codice live). La fermata forzata ti protegge dal continuare a perdere mentre il sistema è "rotto".

#### D. Cooldown post Consecutive Losses

Attualmente fermi dopo 4 loss consecutive, ma riparti subito al reset giornaliero. **Aggiungi un cooldown di 24–48 ore** dopo il trigger: aspetta che il mercato si stabilizzi prima di rientrare.

#### E. Riduzione size dopo DD (Position Sizing Dinamico)

Standard professionale: dopo un drawdown, riduci la size finché non recuperi.

**Schema semplice:**

| Drawdown da peak | Size factor |
|---|---|
| 0–5% | 100% (normale) |
| 5–10% | 75% |
| 10–15% | 50% |
| > 15% | STOP — analisi manuale |

---

## 8. Attribution per Gate (param_stats)

### Il problema in parole semplici

Hai già un sistema eccellente di conteggio gate chiamato `param_stats` nel codice. Ma al momento lo usi principalmente per visualizzazione. Il passo successivo è usarlo per **decidere cosa tenere e cosa eliminare**.

Il principio è: un gate che blocca molti trade ma non migliora il PnL OOS è un gate che **non aggiunge edge reale** — aggiunge solo complessità e rischio di overfitting.

### Come fare l'attribution analysis

**Passo 1 — Baseline:** esegui il backtest OOS con tutti i gate attivi. Registra: Sharpe, WR, PnL, DD, numero trade.

**Passo 2 — Ablation:** disattiva un gate alla volta e riesegui. Crea una tabella così:

| Gate disattivato | Trade bloccati | ΔSharpe | ΔWR | ΔDD | Verdetto |
|---|---|---|---|---|---|
| Absorption Filter | ~15 | -0.05 | -0.3% | +0.2% | Marginale, elimina |
| OI Spike Gate | ~8 | -0.20 | -1.5% | +1.5% | Utile, tieni |
| L/S Ratio Gate | ~22 | +0.02 | +0.1% | -0.1% | Negativo, elimina |
| 1H Gate | ~40 | -0.45 | -3.0% | +3.0% | Critico, tieni |
| ATR% Vol Gate | ~12 | -0.15 | -1.0% | +1.2% | Utile, tieni |

**Regola decisionale:**
- **Tieni** il gate se: ΔSharpe > +0.10 e ΔDD < −0.5% (migliora il risk-adjusted return)
- **Elimina** il gate se: ΔSharpe < +0.05 o il DD peggiora (non aggiunge valore reale)
- **Rivaluta** se: i risultati cambiano molto tra periodi diversi (gate instabile = curva-fittato)

**Gate prioritari da testare per ablation (in ordine di sospetto):**

1. `ls_gate` (L/S ratio 78/35): dati retail, qualità dubbia, soglie molto specifiche
2. `absorption_filter` (z 2.5σ): si sovrappone ad altri filtri di microstruttura
3. `path_obstruction` (1.5 ATR): concettualmente valido ma valore incrementale incerto
4. `reversal_mode` + `reentry_on_tp`: 20+ parametri aggiuntivi, validare separatamente
5. `fvg_tp_blend 100%`: dipende dalla qualità della FVG detection, testa blend 50–70%

**Importante:** l'ablation va fatta **sul dataset OOS** (vedi punto 1), non in-sample. Un gate che sembra utile in-sample ma non OOS è curve-fitted.

---

## 9. Checklist Finale Prima del Capitale Reale

Usa questa checklist come gate di accesso. Ogni punto deve essere spuntato prima di passare al successivo.

### Fase 1 — Pulizia (settimane 1–2)
- [ ] Implementato retraining temporale nel backtest (modello addestrato solo su dati pre-test)
- [ ] Identificato e congelato il periodo hold-out
- [ ] Aggiunto slippage realistico (scenario realistico: 3–5 bps)
- [ ] Correcto il lookahead del trailing SL intrabar (verificare che SL si aggiorni solo dalla barra successiva)
- [ ] Aggiunti weekly/monthly DD cap e kill-switch da equity peak al bot live

### Fase 2 — Validazione (settimane 3–6)
- [ ] Backtest OOS eseguito (non in-sample): risultati documentati
- [ ] Sharpe OOS > 1.0, max DD OOS < 20%
- [ ] Sensitivity analysis completata sui 8 parametri principali: tutti robusti (nessun collasso a ±25%)
- [ ] Monte Carlo eseguito: P(anno negativo) < 15%, P(DD > 20%) < 5%
- [ ] Ablation analysis completata: eliminati i gate che non aggiungono valore OOS
- [ ] Configurazione semplificata (<6 gate attivi)

### Fase 3 — Paper Trading (mesi 2–3)
- [ ] Metriche attese registrate PRIMA di iniziare il paper
- [ ] Almeno 50 trade paper completati
- [ ] Win rate live dentro il range 2σ rispetto all'atteso
- [ ] Max DD paper < percentile 75° del Monte Carlo
- [ ] Trade/settimana in linea con le attese (±30%)
- [ ] Log discrepanze compilato: nessuna causa sistematica identificata

### Fase 4 — Capitale Reale (solo dopo Fase 3 completata)
- [ ] Inizia con **capitale ridotto** (20–30% del capitale target) per i primi 30 trade
- [ ] Kill-switch live testato e funzionante
- [ ] Weekly DD cap configurato
- [ ] Scala il capitale solo se i primi 30 trade live replicano le metriche paper (dentro 2σ)

---

## Note Finali

### Cosa aspettarsi realisticamente

Un sistema genuinamente buono su BTC 4H con validazione OOS corretta produce tipicamente:

| Metrica | Target realistico |
|---|---|
| Sharpe OOS | 0.8 – 2.0 |
| Win rate | 52 – 62% |
| PnL annuo | 20 – 80% |
| Max drawdown | 10 – 25% |

Se i numeri OOS si avvicinano a questi range invece dei valori attuali (Sharpe 7.25, +238%), **non è una delusione** — è la conferma che il sistema ha un edge reale. Qualsiasi strategia con Sharpe stabile di 1.5 e 40–50% annuo in OOS è eccezionale e battuta solo dai migliori hedge fund al mondo.

### Il valore di questo progetto

L'architettura di Quantum Trade è solida: purged walk-forward CV, drift detection, gate multipli, fee e funding modellati. La qualità ingegneristica è nettamente superiore alla media retail. Il lavoro da fare non è ricostruire il sistema — è **validarlo onestamente**. Questi 9 punti sono il percorso.

---

*Guida generata il 10/06/2026 — basata sull'analisi del codebase Quantum Trade e sui principi di validazione quantitativa professionale (López de Prado, Bailey, Prado).*
