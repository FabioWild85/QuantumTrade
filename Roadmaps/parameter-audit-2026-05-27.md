# QUANTUM TRADE — AUDIT PARAMETRI
**Data:** 2026-05-27 · **Aggiornato:** 2026-05-27 (post-verifica codice)
**File auditati:** BotConfig.tsx, BacktestPanel.tsx, main.py, execution.py, decision.py, backtesting.py
**Status:** Da risolvere

> **Nota metodologica:** ogni claim è stato verificato contro il codice reale. Le correzioni rispetto alla versione originale sono indicate con ⚠️. Per i bug del pipeline backend (equity corruption, double close, race condition su `_position`, Sharpe distorto, ecc.) vedere il report parallelo [`audit-botconfig-pipeline-2026-05-27.md`](./audit-botconfig-pipeline-2026-05-27.md) — la sezione "Punti in Comune" in fondo a questo documento mappa i punti sovrapposti tra i due report.

---

## 🔴 CRITICAL (5 issue)

> **Nota — C1/C2/C3 rimossi:** i default diversi tra BacktestPanel e live bot non sono bug. Il backtest è uno strumento indipendente con parametri liberamente configurabili dall'utente tramite UI. Non esiste obbligo che i default coincidano con il live bot; l'utente può e deve impostarli a piacere per ogni run.

---

### C4 — 10 parametri strutturali assenti da `execution.py BotConfig.__init__` (getattr fallback silenzioso)

**File:** `apps/api/services/execution.py` (blocco `__init__`, dopo `structural_sl_enabled`)

**Parametri mancanti in `__init__`:**
- `ob_buffer_pct`
- `ob_buffer_min_atr`
- `ob_tp_enabled`
- `ob_tp_blend`
- `fvg_sl_enabled`
- `fvg_tp_enabled`
- `fvg_tp_blend`
- `swing_sl_enabled`
- `swing_tp_enabled`
- `swing_tp_blend`

**Problema:** Questi parametri esistono in main.py Pydantic e BotConfig.tsx. Sono usati via `getattr(cfg, ..., default)` in `_open_position`. Al **riavvio del servizio**, quando `BotConfig` viene ricostruito dal DB con `BotConfig(**params)`, `__init__` non li assegna mai e non entrano in `self.__dict__`. I `getattr` fallback usano i valori hardcoded (OB TP disabilitato, blend 1.0, FVG SL disabilitato, ecc.) ignorando silenziosamente tutto ciò che era stato configurato.

> ⚠️ Vedi anche **C4b** sotto — variante più grave con `AttributeError` diretto.
> Corrisponde a **M1** in `audit-botconfig-pipeline-2026-05-27.md` (stessa root cause).

---

### C4b — 7 parametri acceduti direttamente (no getattr) su campi assenti da `BotConfig.__init__` → `AttributeError` in produzione ⚠️ *Trovato durante verifica*

**File:** `apps/api/services/execution.py`

| Campo | Linea di accesso diretto | In `BotConfig.__init__`? |
|---|---|---|
| `cfg.dual_atr_enabled` | ~783 | ❌ assente |
| `cfg.late_entry_filter_enabled` | ~823 | ❌ assente |
| `cfg.path_obstruction_enabled` | ~825 | ❌ assente |
| `cfg.path_obstruction_max_dist` | ~826 | ❌ assente |
| `cfg.consec_bars_filter_enabled` | ~827 | ❌ assente |
| `cfg.consec_bars_max_long` | ~828 | ❌ assente |
| `cfg.consec_bars_max_short` | ~829 | ❌ assente |

**Problema:** A differenza dei 10 parametri di C4 (che usano `getattr` e quindi silenziosamente fallbackano), questi 7 sono acceduti con notazione diretta `cfg.campo`. Qualsiasi `BotConfig()` non popolato tramite la path Pydantic → `setattr` (es. riavvio del servizio con config DB incompleto, qualsiasi test unitario, istanza creata senza questi kwarg) lancia `AttributeError` e blocca il ciclo live. In produzione sopravvive solo perché `update_config` fa `setattr` via `model_dump()` subito dopo la costruzione — una dipendenza implicita fragile.

---

### C5 — `avg_funding` off-by-one: live include la bar corrente, backtest no

**File:**
- `apps/api/services/execution.py:794-798`
- `apps/api/services/backtesting.py:497-501`

```python
# Live (execution.py):
_fund_col[-_fund_lb:]          # include la bar corrente (i-esima)

# Backtest (backtesting.py):
df_feat["funding"].values[i - _lb:i]  # esclude la bar i (corrente)
```

**Problema:** Il Funding Rate Bias calcola la media su un window diversa di 1 bar tra live e backtest. Il threshold adjustment diverge sistematicamente, rendendo il comportamento non replicabile.

---

### C6 — `dynamicSlTp` e altri flag strutturali non gated da `withAdvanced` in `buildConfig`

**File:** `apps/web/components/trading-hub/BacktestPanel.tsx:1686`

**Parametri non gated (passati sempre, anche in `buildConfig(false)`):**
- `dynamic_sl_tp_enabled`
- `ob_tp_enabled`
- `fvg_sl_enabled`
- `fvg_tp_enabled`
- `swing_sl_enabled`
- `swing_tp_enabled`

**Problema:** Tutti gli altri exit-strategy flag sono protetti da `withAdvanced && flag`. Questi non lo sono. In `compareMode`, il run "baseline" (`buildConfig(false)`) riceve comunque questi flag attivi, rendendo il confronto baseline/advanced fuorviante.

**Fix atteso:**
```typescript
dynamic_sl_tp_enabled: withAdvanced && dynamicSlTp,
ob_tp_enabled:         withAdvanced && obTp,
// etc.
```

---

### C7 — F&G date lookup potenzialmente silenziosamente neutro su tutti i bar

**File:** `apps/api/services/backtesting.py:507`

```python
bar_date = str(row.name.date()) if hasattr(row.name, "date") else ""
fng_val  = fng_history.get(bar_date, 50.0)
```

**Problema:** Se il formato della data del DataFrame non corrisponde esattamente alle chiavi ISO `YYYY-MM-DD` di `fng_history` (es. timezone, format diverso), ogni lookup ritorna `50.0` (neutro). Il gate F&G sembra attivo ma non produce mai alcun effetto su nessun trade, senza errore o warning. La validazione dell'empty dict esiste solo al momento del fetch, non per-bar.

---

## 🟠 HIGH (6 issue)

---

### H1 — `use_binance` nessun controllo UI, hardcoded `true`

**File:**
- `apps/web/components/trading-hub/BacktestPanel.tsx` (`buildConfig` — campo assente)
- `apps/api/main.py:750` (`BacktestRequest.use_binance: bool = Field(True, ...)`)

**Problema:** Il frontend non manda mai `use_binance` nel payload. L'API usa sempre il default Pydantic `true`. L'utente non può forzare dati HL-only per i backtest.

---

### H2 — `recalibrated_uncertainty_thresholds` nascosto quando `dynamic_sl_tp_enabled=false`

**File:** `apps/web/components/trading-hub/BotConfig.tsx` (render condizionale dentro `{config.dynamic_sl_tp_enabled && ...}`)

**Problema:** Il parametro influenza anche il calcolo del P10 floor (attivo anche con dynamic SL/TP disabilitato), ma il toggle è invisibile e inaccessibile quando `dynamic_sl_tp_enabled=false`. L'utente non può modificarlo in quella configurazione.

---

### H3 — `compareMode` causa cancellazione automatica del primo backtest

**File:**
- `apps/web/components/trading-hub/BacktestPanel.tsx:1870-1876`
- `apps/api/main.py:757` (`ThreadPoolExecutor(max_workers=1)`)

```typescript
// BacktestPanel — compareMode
Promise.all([runJob(buildConfig(false)), runJob(buildConfig(true))])
```

**Problema:** `compareMode` lancia due POST `/backtest` quasi simultanei. Il server ha `max_workers=1` e cancella il job in corso quando arriva una nuova richiesta. Il primo backtest viene sempre cancellato dal secondo → `compareMode` è fondamentalmente rotto. La `Promise.all` riceverà sempre un reject per `r1`.

---

### H4 — `drawerHasCustom` manca di 7 parametri strutturali

**File:** `apps/web/components/trading-hub/BacktestPanel.tsx:1896-1901`

**Parametri mancanti dalla check:**
- `dynamicSlTp`
- `p10SlFloor`
- `obTp`
- `fvgSl`
- `fvgTp`
- `swingSl`
- `swingTp`

**Problema:** Il badge "configurazione avanzata attiva" sul pulsante del drawer non si accende quando questi parametri sono attivi. L'utente non ha feedback visivo che ha setting strutturali non-default.

---

### H5 — `applyConfig` non ripristina `useChronos` dal config salvato

**File:** `apps/web/components/trading-hub/BacktestPanel.tsx:1434-1506`

**Problema:** `applyConfig` mappa tutti i parametri dal config salvato tranne `chronos_enabled` → `setUseChronos`. Caricare un config salvato via `/bot/backtest` non ripristina il toggle Chronos. L'unica path che aggiorna `useChronos` è `handleLoadPreset` (non chiamata da `applyConfig`).

---

### H6 — ~~Race condition~~ Fragile pattern in `_open_position`: `_risk` mutato ⚠️ *Declassato dopo verifica*

**File:** `apps/api/services/execution.py:1194-1231`

```python
_orig_sl  = self._risk.sl_atr_mult
self._risk.sl_atr_mult = cfg.sl_atr_mult
# calculate_trade_params() — sincrono, nessun await
self._risk.sl_atr_mult = _orig_sl   # restore
```

**Correzione alla versione originale:** non è una race condition attiva. `calculate_trade_params()` è un metodo **sincrono** — non ci sono `await` tra la mutazione e il restore, quindi il cooperative scheduler asyncio non può interleave nessun altro coroutine. Il pattern è però fragile: qualsiasi futura aggiunta di un `await` nel blocco lo renderebbe immediatamente vulnerabile. Stessa issue di **R1** in `audit-botconfig-pipeline-2026-05-27.md`.

> ⚠️ Classificato originalmente come race condition — non corretto. Problema reale è R2 nel report pipeline (watchdog + `_manage_position` senza lock su `self._position`).

---

## 🟡 MEDIUM (7 issue)

---

### M1 — `downloadConfig` usa field name `sharpe_ratio`/`sortino_ratio` sbagliati

**File:** `apps/web/components/trading-hub/BacktestPanel.tsx:1817-1818`

```typescript
// Sbagliato:
`Sharpe ratio: ${s.sharpe_ratio?.toFixed(2) ?? '—'}`
`Sortino ratio: ${s.sortino_ratio?.toFixed(2) ?? '—'}`

// Corretto (campo in BacktestStats interface e backtesting.py):
s.sharpe   // non s.sharpe_ratio
s.sortino  // non s.sortino_ratio
```

**Effetto:** Sharpe e Sortino nel file esportato mostrano sempre `—`.

---

### M2 — `downloadConfig` usa `avg_holding_bars` (field inesistente)

**File:** `apps/web/components/trading-hub/BacktestPanel.tsx:1824`

```typescript
// Sbagliato:
s.avg_holding_bars?.toFixed(1)

// Corretto (campo in BacktestStats interface):
s.avg_holding_h
```

**Effetto:** Sempre `undefined` nel report esportato.

---

### M3 — `max_daily_dd_pct` e `max_consecutive_losses` hardcoded in `buildConfig`

**File:** `apps/web/components/trading-hub/BacktestPanel.tsx:1657,1661`

```typescript
max_daily_dd_pct:       3.0,   // hardcoded
max_consecutive_losses: 4,     // hardcoded
```

**Problema:** Questi valori non sono controllabili dall'utente in backtest. Quando il config backtest salvato viene ricaricato nel live bot tramite "Apply from Saved", sovrascrive i limiti di rischio del live con `3.0` e `4` indipendentemente da cosa era configurato. Rischio di cross-contaminazione dei parametri di rischio.

---

### M4 — `fng_greed_thr` e `fng_extreme_greed_thr` senza guard di inversione soglie

**File:**
- `apps/api/main.py:254-255`
- `apps/api/services/decision.py` (logica F&G bias)

**Problema:** I range Pydantic si sovrappongono:
- `fng_greed_thr`: `ge=50.0, le=80.0`
- `fng_extreme_greed_thr`: `ge=60.0, le=95.0`

Un utente può impostare `fng_greed_thr=80, fng_extreme_greed_thr=60` → soglie invertite. In `decide()` le condizioni vengono valutate in ordine (extreme prima, greed dopo): un valore F&G di 70 matcherebbe `extreme_greed` (60) applicando il delta pieno invece del mezzo delta. Stessa logica per la coppia Fear/ExtremeFear. Nessun guard a runtime.

---

### M5 — `chronos_enabled` hardcoded `false` in `buildConfig` — non persistito correttamente nel DB

**File:** `apps/web/components/trading-hub/BacktestPanel.tsx:1675`

```typescript
chronos_enabled: false,  // sempre false indipendentemente da useChronos
```

**Problema:** Il config salvato in DB via PUT `/bot/backtest` ha sempre `chronos_enabled: false`. Il reale toggle viene inviato come campo top-level `use_chronos` nella request, non nel sub-object `config`. Il DB non riflette lo stato Chronos del backtest salvato.

---

### M6 — `applyPreset` in BotConfig.tsx non valida `forced_regime` contro i valori ammessi

**File:** `apps/web/components/trading-hub/BotConfig.tsx:463-480`

**Problema:** `applyPreset` assegna direttamente il valore stringa di `forced_regime` dal preset senza validarne il contenuto (`'auto'|'bull'|'bear'|'neutral'`). Un preset con valore non valido supera l'UI e viene inviato al PUT `/bot`, che risponde con 422. `handleSave` non gestisce questo errore e può segnalare "salvato" falsamente.

---

### M7 — `chronos_weight` max Pydantic `0.9` ma slider BotConfig.tsx può raggiungere `1.0`

**File:**
- `apps/api/main.py:166`: `Field(0.40, ge=0.0, le=0.9)`
- `apps/web/components/trading-hub/BotConfig.tsx` (slider range non cappato a `0.9`)

**Problema:** Se l'utente porta il slider a `1.0`, il PUT `/bot` ritorna 422. L'errore non viene mostrato chiaramente all'utente.

---

## 🟢 LOW (3 issue)

---

### L1 — `regime_bias_size_factor` range `[0.30, 1.0]` non documentato in UI

**File:** `apps/api/main.py:189`

`Field(1.0, ge=0.30, le=1.0)` — il parametro può solo ridurre o mantenere la size dei trade contro-trend, mai aumentarla. Nessun tooltip esplicativo in BotConfig.tsx.

---

### L2 — `retrain_every_n_cycles` potrebbe leggere la costante hardcoded invece del config

**File:** `apps/api/services/execution.py:42`

```python
RETRAIN_INTERVAL = 120  # default — ora configurabile via BotConfig.retrain_every_n_cycles
```

Da verificare che il trigger di retrain in `_cycle()` usi `self.config.retrain_every_n_cycles` e non la costante `RETRAIN_INTERVAL`. Vedi **M5** in `audit-botconfig-pipeline-2026-05-27.md` (stesso rischio: `_cycle_count` parte da 0 al riavvio).

---

### L3 — `applyConfig` in BacktestPanel non ripristina `max_daily_dd_pct`/`max_consecutive_losses`

**File:** `apps/web/components/trading-hub/BacktestPanel.tsx:1434-1506`

Coerente con M3: questi valori nel DB backtest sono sempre i valori hardcoded, non quelli configurati dall'utente. `applyConfig` non li mappa a nessun stato (corretto dato che non sono configurabili).

---

## Tabella Riepilogativa Cross-Layer

| Parametro | BotConfig.tsx | main.py | execution.py `__init__` | decision.py | backtesting.py | Note |
|---|---|---|---|---|---|---|
| `ob_buffer_pct` | 0.3 | 0.3 | **mancante** | N/A | 0.3 | Perso al riavvio via getattr (C4) |
| `ob_buffer_min_atr` | 0.0 | 0.0 | **mancante** | N/A | 0.0 | Perso al riavvio via getattr (C4) |
| `ob_tp_enabled` | false | false | **mancante** | N/A | false | Perso al riavvio via getattr (C4) |
| `ob_tp_blend` | 1.0 | 1.0 | **mancante** | N/A | 1.0 | Perso al riavvio via getattr (C4) |
| `fvg_sl_enabled` | false | false | **mancante** | N/A | false | Perso al riavvio via getattr (C4) |
| `fvg_tp_enabled` | false | false | **mancante** | N/A | false | Perso al riavvio via getattr (C4) |
| `fvg_tp_blend` | 1.0 | 1.0 | **mancante** | N/A | 1.0 | Perso al riavvio via getattr (C4) |
| `swing_sl_enabled` | false | false | **mancante** | N/A | false | Perso al riavvio via getattr (C4) |
| `swing_tp_enabled` | false | false | **mancante** | N/A | false | Perso al riavvio via getattr (C4) |
| `swing_tp_blend` | 1.0 | 1.0 | **mancante** | N/A | 1.0 | Perso al riavvio via getattr (C4) |
| `dual_atr_enabled` | ✓ | ✓ | **mancante** | N/A | ✓ | **AttributeError diretto** (C4b) |
| `late_entry_filter_enabled` | ✓ | ✓ | **mancante** | N/A | ✓ | **AttributeError diretto** (C4b) |
| `path_obstruction_enabled` | ✓ | ✓ | **mancante** | N/A | ✓ | **AttributeError diretto** (C4b) |
| `path_obstruction_max_dist` | ✓ | ✓ | **mancante** | N/A | ✓ | **AttributeError diretto** (C4b) |
| `consec_bars_filter_enabled` | ✓ | ✓ | **mancante** | N/A | ✓ | **AttributeError diretto** (C4b) |
| `consec_bars_max_long` | ✓ | ✓ | **mancante** | N/A | ✓ | **AttributeError diretto** (C4b) |
| `consec_bars_max_short` | ✓ | ✓ | **mancante** | N/A | ✓ | **AttributeError diretto** (C4b) |
| `avg_funding` | N/A | N/A | include bar corrente | N/A | esclude bar corrente | Off-by-one (C5) |
| `dynamic_sl_tp_enabled` | ✓ | ✓ | ✓ | N/A | non gated da withAdvanced | compareMode sbagliato (C6) |
| `fng_gate_enabled` | ✓ | ✓ | ✓ | ✓ | date lookup fragile | Potenziale no-op silenzioso (C7) |
| `chronos_enabled` | ✓ | ✓ | ✓ | N/A | hardcoded false in buildConfig | applyConfig non mappa a useChronos (H5, M5) |
| `use_binance` | assente | BacktestRequest | N/A | N/A | req field | Nessun controllo UI (H1) |
| `sharpe`/`sortino` | N/A | N/A | N/A | N/A | field `sharpe`/`sortino` | downloadConfig usa nomi sbagliati (M1) |
| `avg_holding_h` | N/A | N/A | N/A | N/A | field `avg_holding_h` | downloadConfig usa `avg_holding_bars` (M2) |

---

## Punti in Comune con `audit-botconfig-pipeline-2026-05-27.md`

I due report si occupano di layer diversi (questo: frontend↔API↔pipeline params; l'altro: logica interna execution/backtesting/risk) ma convergono su alcuni punti. La tabella seguente li mappa per evitare duplicazioni in fase di fix.

| Issue (questo report) | Issue (pipeline report) | Relazione |
|---|---|---|
| **C4** — 10 params mancanti da `BotConfig.__init__` (getattr fallback) | **M1** — `getattr` vs accesso diretto inconsistente | **Stessa root cause.** C4 descrive il sintomo (params persi al riavvio), M1 descrive il pattern generale. Fix = aggiungere i 17 campi a `__init__`. |
| **C4b** — 7 params acceduti direttamente → `AttributeError` | **M1** (estensione critica) | **C4b è la versione più grave di M1.** Non era nel report pipeline originale — trovato durante verifica. |
| **H6** — `_risk` mutato in `_open_position` (declassato) | **R1** — stessa issue, già correttamente classificata come "safe today, fragile" | **Duplicato.** H6 originale era errato (classificato race condition). R1 è la descrizione corretta. |
| **L2** — `retrain_every_n_cycles` potrebbe usare costante | **M5** — `_cycle_count` parte da 0 al riavvio | **Stesso file, stessa area.** M5 conferma che il retrain non scatta mai dopo restart frequenti; L2 aggiunge il dubbio sulla costante hardcoded. Fix vanno fatti insieme. |

### Issue presenti SOLO in `audit-botconfig-pipeline-2026-05-27.md` (non coperti qui)

Questi vanno risolti partendo dall'altro report:

| ID | Descrizione | Severità |
|---|---|---|
| **B1** | Equity corrotta prima di confermare close order in live mode | 🔴 Critical |
| **B2** | Doppio close order in `kill()` in live mode | 🔴 Critical |
| ~~B3~~ | ~~Inference log prima di `allowed` check~~ | ❌ **ERRATO — non è un bug** |
| **B4** | Sharpe calcolato su equity curve non bar-per-bar | 🟠 High |
| **B5** | Calmar ratio non annualizzato | 🟡 Medium |
| **M2** | `_manage_position` usa `self.config` live, non snapshot | 🟡 Medium |
| **M3** | `_restore_paper_state` usa config corrente, non storico | 🟡 Medium |
| **M4** | `bot_id=None` in inference_logs | 🟢 Low |
| **M5** | `_cycle_count` parte da 0 al riavvio | 🟡 Medium |
| **M6** | IOC filled orders ritornano `oid=None` | 🟡 Medium |
| **R2** | Watchdog + `_manage_position` concorrenti su `self._position` senza lock | 🟠 High |
| **I1–I6** | Varie incongruenze pipeline (DecisionEngine per-ciclo, cfg vs self.config, ecc.) | 🟢 Low |
| **D1, D2** | Codice morto (`max_funding`, `rv_72`) | Trivial |
| **P1–P4** | Design/manutenibilità (30 params DecisionEngine, plain class, slippage hardcoded) | 🟢 Low |

> **Nota P1:** il report pipeline indicava "35+ parametri" — la verifica ha contato **30 parametri** esatti nel costruttore di `DecisionEngine`.

---

## Priorità di Risoluzione Suggerita

| Ordine | Issue | Motivazione |
|---|---|---|
| 1 | **C4 + C4b** | 17 campi mancanti da `BotConfig.__init__` — impatto diretto sul trading live; C4b causa `AttributeError` a runtime |
| 2 | **B1, B2** (pipeline report) | Equity corruption e double-close in live mode — danno finanziario diretto |
| 4 | **R2** (pipeline report) | Race condition watchdog + `_manage_position` su `self._position` |
| 5 | **C5** | Funding bias diverge tra live e backtest (off-by-one window) |
| 6 | **H3** | `compareMode` completamente rotto (job sempre cancellato) |
| 7 | **C6** | `withAdvanced` non protegge flag strutturali in baseline run |
| 8 | **C7** | F&G date lookup — aggiungere log diagnostico + assert formato |
| 9 | **H4, H5** | `drawerHasCustom` + `applyConfig` Chronos |
| 10 | **B4** (pipeline report) | Sharpe distorto — equity curve bar-per-bar |
| 11 | **M1, M2** | `downloadConfig` field names sbagliati |
| 12 | **M4, M5** (pipeline report) | `bot_id=None`, `_cycle_count` reset |
| 13 | **M4** (questo report) | Guard inversione soglie F&G |
| 14 | **M7, H6/R1** | `chronos_weight` slider cap + refactor pattern `_risk` mutation |

---

## Riepilogo Conteggio

| Severità | Questo report | Pipeline report | Totale unico |
|---|---|---|---|
| 🔴 Critical | 5 (C4, C4b, C5, C6, C7) | 4 (B1, B2, B4, + C4b shared) | **7** |
| 🟠 High | 6 (H1–H6) | 1 (R2) | **7** |
| 🟡 Medium | 7 (M1–M7) | 6 (M1–M6 pipeline) | **13** |
| 🟢 Low / Trivial | 3 (L1–L3) | 12 (I1–I6, D1–D2, P1–P4, B5) | **15** |
| ❌ Falsi positivi / rimossi | C1, C2, C3 (default indipendenti — non bug), H6 come race condition | B3 | — |
| **Totale unico** | | | **~40 issue distinti** |
