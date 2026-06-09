# Trend Continuation Meter — Barra di Forza/Continuazione del Trend Multi-Timeframe

**Data:** 2026-06-09
**Priorità:** Media-Alta
**Complessità:** Media-Alta (≈ 8–10 ore, 3 fasi)
**Origine:** Richiesta utente — barra nella card del trade aperto (Monitor) che mostri la forza del trend e la probabilità di continuazione, su più timeframe, con opzione di chiusura automatica sotto soglia (default OFF, validata su backtest).

---

## 0. Il problema in una frase

Quando un trade è aperto, l'utente vede PnL, SL/TP e distanze, ma **non** una sintesi visiva di "quanto è ancora forte il trend a mio favore e quanto è probabile che continui". Il dato esiste già internamente (ensemble 4H, modello gate 1H, ADX, MTF) ma viene ricalcolato solo a ogni chiusura 4H, il gate 1H viene usato solo all'entrata e poi scartato, e nulla è esposto nella card.

---

## 1. Vincolo architetturale: "real-time" ≠ "accurato" → gerarchia a 3 risoluzioni

Il segnale predittivo profondo (ensemble LGBM+Chronos) si ricalcola **solo alla chiusura 4H** ([execution.py:998](../apps/api/services/execution.py#L998)), perché i suoi input sono barre 4H che non cambiano intrabar. Un trade però può deteriorarsi parecchio dentro quelle 4 ore. La soluzione professionale è una **gerarchia di risoluzione**, dove ogni timeframe ha un ruolo onesto e distinto:

| Timeframe | Ruolo | Cosa valuta | Cadenza | Predittivo |
|---|---|---|---|---|
| **4H** | Strategico (ancora) | Il setup è ancora valido? Ensemble 4H + `c2_cont_prob` + ADX 4H + regime 1D | ogni 4H | **Sì** — cuore |
| **1H** | Tattico (lente d'ingrandimento) | Il prezzo sta *davvero* prendendo la direzione nelle ultime ore? Modello **gate 1H già addestrato** | ogni 1H | **Sì** — conferma / allarme precoce |
| **15m** | Polso (texture real-time) | Come si sta muovendo il prezzo *adesso*? Momentum 15m leggero, **nessun modello** | ~ogni 60s + chiusura 15m | No — descrittivo |

**Decisioni di design (prese dopo confronto con l'utente):**
- **5s/1m/5m scartati**: rumore puro, la barra ballerebbe a caso. Il polso real-time è su **15m** (unità reale: 4 candele/ora, 16 per 4H).
- La barra fonde **4H + 1H** (predittivi); il **15m** la modula entro una banda stretta per il movimento.
- **L'auto-close decide SOLO su 4H + 1H** (entrambi backtestabili). Il 15m è escluso: il rumore non muove i soldi.

---

## 2. Strato 4H — Strategic Score (0–100)

Calcolato nel ciclo principale ([execution.py `_cycle`](../apps/api/services/execution.py)) quando una posizione è aperta, proiettato nella **direzione del trade** (`dir = +1 long / −1 short`). Riusa valori già disponibili mid-trade (`lgbm_p`, `c2_out`, `features`).

| Componente | Formula | Peso default | Razionale |
|---|---|---|---|
| Direzione (ensemble) | `ensemble` se long, `1−ensemble` se short → map [0.5,1.0]→[0,100] | 0.40 | Cuore predittivo (stessa logica di entry/exit) |
| Continuazione C2 | `c2_cont_prob × 100` | 0.20 | Coerenza quantili Chronos ([decision.py:284](../apps/api/services/decision.py#L284)) |
| Forza trend (ADX) | `clamp((adx_14−15)/25,0,1) × 100` | 0.20 | Forza presente del trend |
| Allineamento MTF/1D | `mtf_aligned`/`d_regime` concorde con `dir` → 100 / 50 / 0 | 0.20 | Regime giornaliero (1D embedded) |

`strategic_4h = Σ peso_i × componente_i`. Pesi configurabili (`trend_meter_weights_4h`).

---

## 3. Strato 1H — Tactical Score (0–100)

La "lente d'ingrandimento" sul 4H. **Riusa il modello gate 1H esistente** ([execution.py:1649](../apps/api/services/execution.py#L1649)) che oggi è usato solo all'entrata: pipeline `get_ohlcv("1h") → build_all_features → build_4h_context_for_1h → _get_lgbm_1h_prob`.

| Componente | Formula | Peso default | Razionale |
|---|---|---|---|
| Direzione 1H (gate) | `gate_side_prob` = `p1h` se long, `1−p1h` se short → map [0.5,1.0]→[0,100] | 0.65 | "Il prezzo prende la direzione sperata?" — modello addestrato |
| Forza trend 1H (ADX) | `clamp((adx_14_1h−15)/25,0,1) × 100` | 0.35 | Forza del trend sul TF tattico |

`tactical_1h = Σ peso_i × componente_i`. Ricalcolato alla chiusura di ogni candela 1H (riusa `_compute_1h_tactical()`). Pesi configurabili (`trend_meter_weights_1h`).

**Combinazione predittiva:**
```
predictive = w_4h × strategic_4h + w_1h × tactical_1h        (default 0.55 / 0.45)
```

---

## 4. Strato 15m — Live Pulse (texture, descrittivo)

Momentum leggero, **nessun modello**, calcolato backend su un timer (~60s) + ad ogni chiusura 15m. Tra le chiusure, la candela 15m in formazione è aggiornata col mark price corrente.

- **Direzione 15m:** ultime N candele 15m a favore/contro `dir` + close vs EMA breve 15m.
- **Velocità:** progressione verso TP vs SL nell'ultima finestra.
- Smussato con EMA breve per evitare jitter.

`pulse_15m ∈ [0,100]`, 50 = neutro.

**Barra finale visualizzata:**
```
display_score = clamp( predictive + (pulse_15m − 50)/50 × pulse_band , 0 , 100 )
```
`pulse_band` default 10 pt — il polso fa "respirare" la barra senza ribaltarne il significato.

Etichette: `> 65` Forte · `40–65` In indebolimento · `< 40` Debole.
Colori: gradiente emerald → amber → rose. Sotto-tacche per i 3 strati (4H / 1H / 15m) visibili nel dettaglio/tooltip, così l'utente vede *quale* timeframe sta cedendo. Tooltip che chiarisce le cadenze (4H ogni candela, 1H ogni ora, 15m descrittivo).

---

## 5. Comunicazione tra gli strati

Un solo blocco `trend_meter` in `/bot/status`, frontend puramente presentazionale (single source of truth, valori identici ovunque, testabili):

```
trend_meter = {
  strategic_4h, strategic_components, strategic_updated_at,
  tactical_1h,  tactical_components,  tactical_updated_at,
  pulse_15m,    pulse_updated_at,
  predictive, display_score, label
}
```

Cadenze, prodotte da un task dedicato `_trend_meter_loop` attivo **mentre una posizione è aperta in entrambe le modalità** (paper e live):
- **4H** — preso dal ciclo principale (già esistente).
- **1H** — ricalcolato quando si chiude una nuova candela 1H.
- **15m** — refresh ~ogni 60s + chiusura 15m, riusando il mark price del WS.

Frontend: polling `/bot/status` (già 5s con posizione aperta) → legge `trend_meter` e renderizza la barra. Nessun nuovo canale realtime.

---

## 6. Auto-Close (default OFF, backtestata prima)

Agisce su `predictive` (**4H + 1H**, non sul 15m). Inserito nella scala di uscita dopo il LightGBM exit ([execution.py:2732](../apps/api/services/execution.py#L2732)), con la stessa filosofia anti-rumore (conferme consecutive).

Nuovi campi `BotConfig`:
- `trend_exit_enabled: bool = False`
- `trend_exit_threshold: float = 35.0`
- `trend_exit_confirm_bars: int = 2` (cicli 1H consecutivi sotto soglia)
- `trend_exit_min_hold_bars: int = 2`
- `trend_meter_pulse_band: float = 10.0`
- `trend_meter_w_4h: float = 0.55`, `trend_meter_w_1h: float = 0.45`
- `trend_meter_weights_4h`, `trend_meter_weights_1h` (sotto-pesi componenti)

Logica: contatore `trend_strikes` (analogo a `lgbm_strikes`); chiude con `reason="trend_exit"` quando `predictive < threshold` per `confirm_bars` valutazioni consecutive e `bars_held ≥ min_hold_bars`.

---

## 7. Fasi di implementazione

### Fase 1 — Visualizzazione (nessun rischio operativo)
1. `execution.py`: `_compute_strategic_4h(...)` (riusa valori del ciclo) + `_compute_1h_tactical()` (riusa pipeline gate 1H) + `_compute_pulse_15m()` (nuovo, leggero) + `_trend_meter_loop` task.
2. `main.py`/status: esporre il blocco `trend_meter`.
3. `Monitor.tsx`: estendere lo status, nuovo componente `<TrendMeter>` dentro `LiveTradeCard` con i 3 strati e tooltip.

### Fase 2 — Backtest dell'auto-close
4. `backtesting.py`: calcolare `strategic_4h` e `tactical_1h` per barra (4H e 1H disponibili nel backtest 1H gate — riusa `df_1h_feat_bt`), comporre `predictive`, aggiungere l'uscita `trend_exit` con `param_stats` counter.
5. Validazione: win-rate / PnL / DD vs baseline; calibrare `threshold`, `confirm_bars`, `w_4h`/`w_1h`.

### Fase 3 — Auto-close live
6. `execution.py`: wiring nella scala di uscita + contatore `trend_strikes` + persistenza.
7. `BotConfig.tsx`: toggle + slider (default OFF), badge "validato su backtest".

---

## 8. Affidabilità attesa (onesta)

| Strato | Potere predittivo | Uso |
|---|---|---|
| 4H Strategic | Moderato (~54–58% direzionale, edge reale ma piccolo) | "Restare o uscire", ancora |
| 1H Tactical | Moderato — modello addestrato, più reattivo ma più rumoroso del 4H | Conferma direzione / allarme precoce |
| 15m Pulse | Quasi nullo da solo | Visualizzazione / texture |

Conclusione: ottimo strumento di **monitoraggio e allerta multi-timeframe**; come predittore vale quanto i modelli sottostanti (4H ancora, 1H lente). L'auto-close resta conservativo e default OFF finché il backtest non ne dimostra il valore.
