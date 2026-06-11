# Piano di Implementazione — Walk-Forward, Monte Carlo e Slippage nel Backtest

> **Stato:** Pianificazione (nessun codice ancora scritto)
> **Obiettivo:** aggiungere 3 funzionalità di validazione al motore di backtest, ognuna con un **toggle indipendente** (default OFF) per attivarle solo all'occorrenza, senza alterare il comportamento attuale quando disattivate.
>
> **Principio guida:** ogni feature deve essere *additiva* e *isolata*. Con tutti i toggle a `false`, il backtest deve produrre risultati **byte-identici** a quelli attuali. Questo garantisce zero regressioni.

---

## Indice

1. [Analisi della struttura attuale](#1-analisi-della-struttura-attuale)
2. [Principi di sicurezza trasversali](#2-principi-di-sicurezza-trasversali)
3. [Feature 1 — Slippage Model](#3-feature-1--slippage-model-la-più-semplice)
4. [Feature 2 — Monte Carlo sui Trade](#4-feature-2--monte-carlo-sui-trade)
5. [Feature 3 — Rolling Walk-Forward](#5-feature-3--rolling-walk-forward-la-più-complessa)
6. [Ordine di implementazione consigliato](#6-ordine-di-implementazione-consigliato)
7. [Checklist di test e validazione](#7-checklist-di-test-e-validazione)

---

## 1. Analisi della struttura attuale

Punti chiave del codebase rilevanti per questo piano (verificati sul codice):

| Componente | File | Note |
|---|---|---|
| Config pydantic | `apps/api/main.py` → `BotConfig` (~riga 230) | Tutti i toggle vivono qui. Letti nel backtest via `getattr(cfg, ...)`. |
| Request backtest | `apps/api/main.py` → `BacktestRequest` (~riga 1318) | Ha già `from_date`, `to_date`, `config`, `use_chronos`. |
| Endpoint avvio | `apps/api/main.py` → `POST /backtest` (~riga 1358) | Job async, executor a slot singolo, risultato in `backtest_jobs`. |
| Motore | `apps/api/services/backtesting.py` → `run_backtest()` (riga 50) | Loop principale a barre. |
| Fee | `backtesting.py` riga 25 | `HL_TAKER_FEE = 0.00035`, applicata su entry e ogni leg di uscita. |
| Esecuzioni | `backtesting.py` | Entry market a `close_price`; uscite SL/TP a prezzo livello; partial a target fisso. |
| Stats | `backtesting.py` → `_calculate_stats()` (~riga 1910) | Calcola sharpe, DD, PF, ecc. dalla lista `trades`. |
| Output | `backtesting.py` (~riga 1845) | Dict con `stats`, `trades`, `equity_curve`, `param_stats`, `param_config`. |
| Trainer | `apps/api/services/trainer.py` → `retrain()` (riga 251) | Ha `from_date` ma **NON** `to_date` (va aggiunto per la Feature 3). |
| Caricamento modello | `backtesting.py` riga 434 | `load_correct_model()` carica `lgbm_latest.pkl` dal disco. |
| UI | `apps/web/components/trading-hub/BacktestPanel.tsx` | Componente `Toggle` riutilizzabile (~riga 236). Config object `c`/`cfg`. |

**Conseguenza architetturale chiave:** il backtest legge la config con `getattr(cfg, "campo", default)`. Quindi aggiungere nuovi campi a `BotConfig` in `main.py` è sufficiente perché siano disponibili nel motore. **Non serve** toccare la classe `BotConfig` di `execution.py` (è per il live; Slippage/MC/WF sono feature di backtest).

---

## 2. Principi di sicurezza trasversali

Da rispettare per **tutte e 3** le feature:

1. **Default OFF.** Ogni toggle ha `Field(False)`. Backtest invariato finché non lo attivi esplicitamente.
2. **Guardia di no-op.** Il codice nuovo è racchiuso in `if <toggle>_enabled:`. Quando il toggle è off, il branch non viene mai eseguito.
3. **Nessuna modifica alle firme esistenti.** Si aggiungono solo nuovi campi/chiavi, mai si rinominano o rimuovono quelle attuali (il frontend e i record Supabase storici dipendono da esse).
4. **Output retro-compatibile.** Le nuove chiavi nel dict risultato (`slippage_applied`, `montecarlo`, `wf_windows`) sono *aggiuntive*. Il frontend attuale le ignora finché non viene aggiornato.
5. **Test di non-regressione obbligatorio.** Prima di ogni merge: esegui lo stesso backtest con tutti i toggle OFF, confronta `final_equity` e `total_trades` con il baseline. Devono coincidere esattamente.

---

## 3. Feature 1 — Slippage Model (la più semplice)

### Obiettivo

Simulare un costo di esecuzione orientativo, espresso come frazione dell'ATR o in basis point, applicato sul prezzo di entrata/uscita nella direzione realistica. Comprende il fatto (corretto, come discusso) che lo slippage è **avverso sulle esecuzioni market e sugli SL**, ma **neutro o leggermente favorevole su limit order e TP fissi**.

### 3.1 Nuovi campi in `BotConfig` (`main.py`, dopo la sezione Walk-forward ~riga 327)

```python
    # ── Slippage Model (backtest only) ────────────────────────────────────────
    slippage_enabled:        bool  = Field(False)
    slippage_bps:            float = Field(3.0, ge=0.0, le=50.0,
                                           description="Slippage avverso in basis point sulle esecuzioni "
                                           "market (entrata, SL, liquidazione). 1 bps = 0.01%.")
    slippage_sl_multiplier:  float = Field(2.0, ge=1.0, le=5.0,
                                           description="Moltiplicatore dello slippage quando l'uscita è uno SL "
                                           "o una liquidazione (esecuzione su spike, peggiore).")
    slippage_limit_favorable: bool = Field(True,
                                           description="Se True, le esecuzioni limit (partial TP, reversal "
                                           "retest, pullback) NON subiscono slippage avverso (sono passive).")
```

### 3.2 Helper nel motore (`backtesting.py`, vicino a `_safe_px`, ~riga 36)

```python
def _apply_slippage(price: float, side: str, kind: str,
                    bps: float, sl_mult: float, limit_favorable: bool) -> float:
    """
    Applica slippage al prezzo di esecuzione.
      side: "long" | "short"  — direzione della posizione
      kind: "entry" | "sl" | "tp" | "liquidation" | "partial"
    Convenzione: slippage AVVERSO = peggiora il prezzo per chi esegue a mercato.
      - entry long  → paghi di più (prezzo ↑)
      - entry short → vendi a meno (prezzo ↓)
      - sl/liq      → slippage × sl_mult (esecuzione forzata su spike)
      - tp/partial  → limit order: 0 slippage se limit_favorable, altrimenti bps normale
    """
    if bps <= 0:
        return price
    frac = bps / 10_000.0
    if kind in ("tp", "partial") and limit_favorable:
        return price  # ordine passivo: nessun costo di impatto
    if kind in ("sl", "liquidation"):
        frac *= sl_mult
    # Direzione avversa: per long l'entrata è più cara e l'uscita più bassa
    if kind == "entry":
        return price * (1 + frac) if side == "long" else price * (1 - frac)
    # Uscite (sl/liq/tp-market): per long si esce più in basso, per short più in alto
    return price * (1 - frac) if side == "long" else price * (1 + frac)
```

### 3.3 Punti di applicazione nel loop

Leggi i parametri una volta a inizio `run_backtest()` (vicino alle altre `getattr`):

```python
slippage_enabled         = getattr(cfg, "slippage_enabled",         False)
slippage_bps             = getattr(cfg, "slippage_bps",             3.0)
slippage_sl_multiplier   = getattr(cfg, "slippage_sl_multiplier",   2.0)
slippage_limit_favorable = getattr(cfg, "slippage_limit_favorable", True)
```

Poi applica `_apply_slippage` **solo se `slippage_enabled`** in questi punti (tutti già identificati nel codice):

| Punto | Riga ~ | `kind` | Note |
|---|---|---|---|
| Entry market principale | 1503 (`entry_price=close_price`) | `entry` | Il caso più comune. |
| Entry reversal retest | 679 (`_rev_entry_px`) | `entry` con `limit_favorable` | Limit → favorevole. |
| Entry pullback / fallback | 749, 791 | `entry` | Fill è limit → favorevole. |
| Entry bounce-fade | 851, 886 | `entry` | Limit → favorevole. |
| Uscita SL/TP | 1157-1162 | `sl` o `tp` | Distinguere quale è stato colpito. |
| Partial TP | 998 | `partial` | Limit → favorevole. |
| Liquidazione | 1042 | `liquidation` | Slippage ×sl_mult. |
| Uscita LGBM/max-hold/EOP | 1085, ecc. | `tp` (market a close) | Esecuzione a close → bps normale. |

**Approccio sicuro:** invece di modificare ogni `entry`/`exit` price inline (rischioso, molti punti), preferisci modificare il **prezzo di esecuzione effettivo** appena prima di calcolare `pnl_pct`. Esempio per l'uscita SL/TP:

```python
exit_px = position["sl"] if hit_sl else position["tp"]
if slippage_enabled:
    exit_px = _apply_slippage(
        exit_px, side, "sl" if hit_sl else "tp",
        slippage_bps, slippage_sl_multiplier, slippage_limit_favorable,
    )
# usa exit_px (non position["sl"]/["tp"]) nel calcolo pnl_pct
```

### 3.4 Output

Aggiungi al dict risultato (~riga 1845):

```python
"slippage_applied": {
    "enabled": slippage_enabled,
    "bps": slippage_bps,
    "sl_multiplier": slippage_sl_multiplier,
} if slippage_enabled else None,
```

### 3.5 Rischi e mitigazioni

- **Doppio conteggio fee/slippage:** lo slippage è sul *prezzo*, le fee sul *notional*. Sono indipendenti, nessun conflitto.
- **Coerenza partial+final:** lo slippage sul partial usa `kind="partial"`, quello sul final usa `tp`/`sl`. Verifica che entrambe le leg lo applichino.
- **Test:** con `slippage_bps=0` il risultato deve essere identico al baseline anche con `slippage_enabled=True` (la guardia `if bps <= 0` lo garantisce).

### 3.6 Stima di effort

**Basso.** ~1 helper + ~8 punti di applicazione + 4 campi config + 1 toggle UI. Mezza giornata.

---

## 4. Feature 2 — Monte Carlo sui Trade

### Obiettivo

Dopo aver prodotto la lista dei trade, eseguire N simulazioni bootstrap per ottenere la **distribuzione** di max drawdown e PnL finale, invece di un singolo path. Risponde a: "quanto male può andare in una sequenza sfavorevole?".

### Decisione architetturale: calcolo post-backtest, non nel loop

Il Monte Carlo **non tocca il loop a barre**. Opera sulla lista `trades` già prodotta. Due opzioni:

- **Opzione A (consigliata):** calcolo inline alla fine di `run_backtest()`, dietro toggle. Risultato incluso nel dict. Semplice, atomico.
- **Opzione B:** endpoint separato `POST /backtest/{job_id}/montecarlo` che rilegge i trade da Supabase. Più flessibile (ri-esegui MC senza rifare il backtest) ma richiede più codice. Rimandabile a fase 2.

Questo piano implementa l'**Opzione A**.

### 4.1 Nuovi campi in `BotConfig` (`main.py`)

```python
    # ── Monte Carlo (backtest only) ───────────────────────────────────────────
    montecarlo_enabled:    bool = Field(False)
    montecarlo_runs:       int  = Field(5000, ge=1000, le=50000,
                                        description="Numero di simulazioni bootstrap sui trade.")
    montecarlo_method:     str  = Field("bootstrap",
                                        description='"bootstrap" = ricampiona con ripetizione | '
                                        '"shuffle" = riordina senza ripetizione (stesso set di trade).')
```

### 4.2 Funzione di calcolo (`backtesting.py`, vicino a `_calculate_stats`)

```python
def _monte_carlo_analysis(trades: list[dict], initial_capital: float,
                          runs: int = 5000, method: str = "bootstrap",
                          seed: int = 42) -> dict:
    """
    Simula `runs` sequenze dei PnL% dei trade e restituisce i percentili di
    max drawdown e PnL finale. Non altera lo stato del backtest.
    """
    pnls = np.array([t["pnl_pct"] for t in trades if "pnl_pct" in t], dtype=float)
    n = len(pnls)
    if n < 10:
        return {"status": "insufficient_trades", "n_trades": n}

    rng = np.random.default_rng(seed)
    max_dds, final_pnls = np.empty(runs), np.empty(runs)

    for k in range(runs):
        if method == "shuffle":
            seq = pnls[rng.permutation(n)]
        else:  # bootstrap
            seq = pnls[rng.integers(0, n, size=n)]
        equity = initial_capital * np.cumprod(1.0 + seq / 100.0)
        peak = np.maximum.accumulate(equity)
        dd = (equity - peak) / peak
        max_dds[k] = dd.min() * 100.0
        final_pnls[k] = (equity[-1] / initial_capital - 1.0) * 100.0

    def pctl(a, q): return float(np.percentile(a, q))
    return {
        "status": "ok",
        "runs": runs,
        "method": method,
        "n_trades": n,
        "max_dd": {
            "p5":  round(pctl(max_dds, 5), 2),
            "p25": round(pctl(max_dds, 25), 2),
            "p50": round(pctl(max_dds, 50), 2),
            "p95": round(pctl(max_dds, 95), 2),
        },
        "final_pnl_pct": {
            "p5":  round(pctl(final_pnls, 5), 2),
            "p50": round(pctl(final_pnls, 50), 2),
            "p95": round(pctl(final_pnls, 95), 2),
        },
        "prob_negative_year": round(float((final_pnls < 0).mean()) * 100, 2),
        "prob_dd_gt_20": round(float((max_dds < -20).mean()) * 100, 2),
    }
```

### 4.3 Integrazione in `run_backtest()`

Subito dopo il calcolo di `stats` (~riga 1758), dietro toggle:

```python
montecarlo_result = None
if getattr(cfg, "montecarlo_enabled", False):
    montecarlo_result = _monte_carlo_analysis(
        trades, capital,
        runs=getattr(cfg, "montecarlo_runs", 5000),
        method=getattr(cfg, "montecarlo_method", "bootstrap"),
    )
```

E aggiungi `"montecarlo": montecarlo_result,` al dict risultato.

### 4.4 Considerazioni di correttezza statistica

- **Limite del bootstrap indipendente:** ricampionare i trade in modo indipendente **rompe l'autocorrelazione** (es. cluster di loss in regime avverso). Tende quindi a *sottostimare* il DD reale. Per questo si offre anche `method="shuffle"`, che preserva il set esatto di trade ma ne varia l'ordine — più conservativo sul DD da clustering. Documenta questo limite nella UI.
- **Trade parziali:** la lista `trades` contiene leg parziali (partial TP) come righe separate con `pnl_pct` proprio. Va bene per il MC purché siano coerenti — sono già normalizzati per size nel campo `pnl_pct`. Verifica che il MC tratti ogni leg come un evento (accettabile come prima approssimazione).
- **Performance:** 5000 run × ~300 trade è vettorizzato con numpy → <1 secondo. Nessun impatto sul tempo del backtest.

### 4.5 Stima di effort

**Basso-medio.** 1 funzione pura + 3 campi config + integrazione + UI di visualizzazione (tabella percentili). Mezza-una giornata. La funzione è isolata e facilmente testabile a parte.

---

## 5. Feature 3 — Rolling Walk-Forward (la più complessa)

### Obiettivo

Eliminare il leakage: invece di caricare `lgbm_latest.pkl` (che ha visto tutto lo storico), dividere il periodo in N finestre e, prima di ogni finestra, **ri-addestrare il modello solo su dati antecedenti**. I risultati delle finestre vengono concatenati in un'unica equity curve OOS reale.

> ⚠️ **Questa è la feature con più rischio architetturale.** Va implementata per ultima, con un test di non-regressione rigoroso. Richiede modifiche a `trainer.py` e un orchestratore sopra `run_backtest`.

### 5.1 Prerequisito: aggiungere `to_date` al trainer

Attualmente `LGBMTrainer.retrain()` / `_run()` accettano `from_date` ma addestrano fino a "oggi". Serve un limite superiore.

In `trainer.py`, `_run()` (~riga 289), dopo il fetch dei dati e prima del labeling:

```python
async def _run(self, ..., from_date=None, to_date=None, ...):
    ...
    # Dopo build_all_features, PRIMA del target labeling:
    if to_date:
        _cutoff = pd.Timestamp(to_date, tz="UTC")
        df_feat = df_feat[df_feat.index <= _cutoff].copy()
        log.info("WF training cutoff: %d candele fino a %s", len(df_feat), to_date)
```

Propaga `to_date` attraverso `retrain()` → `_run()` (e analogamente `retrain_1h`/`_run_1h` se il gate 1H è attivo). **Modifica additiva**, default `None` = comportamento attuale.

### 5.2 Nuovi campi in `BotConfig` (`main.py`)

```python
    # ── Rolling Walk-Forward Backtest ─────────────────────────────────────────
    wf_backtest_enabled:     bool = Field(False,
                                          description="Ri-addestra il modello prima di ogni finestra, "
                                          "usando solo dati antecedenti (elimina il leakage).")
    wf_backtest_windows:     int  = Field(4, ge=2, le=12,
                                          description="Numero di finestre OOS in cui dividere il periodo.")
    wf_backtest_train_start: str  = Field("2020-01-01",
                                          description="Data inizio del primo training set (più indietro = meglio).")
    wf_backtest_purge_days:  int  = Field(2, ge=0, le=10,
                                          description="Giorni scartati tra fine training e inizio test (anti-leakage).")
```

### 5.3 Orchestratore (nuova funzione in `backtesting.py`)

L'idea: una funzione `run_walk_forward_backtest()` che:
1. Divide `[from_date, to_date]` in N finestre temporali uguali.
2. Per ogni finestra `[w_start, w_end]`:
   - Addestra un modello con `retrain(from_date=wf_backtest_train_start, to_date=w_start - purge_days)`.
   - Salva il modello in un path temporaneo dedicato (NON sovrascrivere `lgbm_latest.pkl`).
   - Esegue il segmento di backtest su `[w_start, w_end]` con quel modello.
3. Concatena trade ed equity curve di tutte le finestre.
4. Calcola le stats aggregate sull'intero set OOS.

```python
async def run_walk_forward_backtest(req, cancel_event=None) -> dict:
    cfg = req.config
    n_windows   = getattr(cfg, "wf_backtest_windows", 4)
    train_start = getattr(cfg, "wf_backtest_train_start", "2020-01-01")
    purge_days  = getattr(cfg, "wf_backtest_purge_days", 2)

    start = pd.Timestamp(req.from_date)
    end   = pd.Timestamp(req.to_date)
    edges = pd.date_range(start, end, periods=n_windows + 1)

    all_trades, all_equity = [], []
    wf_windows_meta = []
    equity_running = float(req.initial_capital)
    trainer = LGBMTrainer()

    for w in range(n_windows):
        if cancel_event and cancel_event.is_set():
            raise RuntimeError("backtest_cancelled")
        w_start, w_end = edges[w], edges[w + 1]
        cutoff = (w_start - pd.Timedelta(days=purge_days)).strftime("%Y-%m-%d")

        # 1) Train su dati < cutoff, salva in path temporaneo isolato
        metrics = await trainer.retrain(
            symbol=req.symbol, from_date=train_start, to_date=cutoff,
            wf_n_splits=cfg.wf_n_splits, wf_purge_gap=cfg.wf_purge_gap,
            # ... altri flag rilevanti (binance_cvd, reversal, 1h gate)
            model_out_path=_WF_TEMP_MODEL_PATH,   # ← nuovo param, vedi 5.4
        )

        # 2) Backtest del segmento con capitale iniziale = equity corrente
        seg_req = req.model_copy(update={
            "from_date": w_start.strftime("%Y-%m-%d"),
            "to_date":   w_end.strftime("%Y-%m-%d"),
            "initial_capital": equity_running,
        })
        seg = await run_backtest(seg_req, cancel_event=cancel_event,
                                 _model_path_override=_WF_TEMP_MODEL_PATH)  # ← 5.4

        all_trades.extend(seg["trades"])
        all_equity.extend(seg["equity_curve"])
        equity_running = seg["final_equity"]
        wf_windows_meta.append({
            "window": w + 1, "train_cutoff": cutoff,
            "test_from": seg_req.from_date, "test_to": seg_req.to_date,
            "oos_model_acc": metrics.get("oos_accuracy"),
            "segment_trades": len(seg["trades"]),
            "segment_final_equity": seg["final_equity"],
        })

    stats = _calculate_stats(all_trades, all_equity, float(req.initial_capital))
    return {
        "symbol": req.symbol, "from_date": req.from_date, "to_date": req.to_date,
        "initial_capital": float(req.initial_capital),
        "final_equity": equity_running,
        "stats": stats, "trades": all_trades, "equity_curve": all_equity,
        "wf_windows": wf_windows_meta,
        "is_walk_forward": True,
    }
```

### 5.4 Isolamento del modello (critico per la sicurezza)

**Non sovrascrivere mai `lgbm_latest.pkl`** durante il WF backtest — comprometterebbe il bot live. Due modifiche additive necessarie:

1. `trainer.retrain()/_run()` deve accettare un `model_out_path: Optional[Path] = None`. Quando settato, salva lì invece che in `MODEL_PATH`. Quando `None`, comportamento attuale invariato.
2. `run_backtest()` deve accettare `_model_path_override: Optional[Path] = None`. Quando settato, carica quel file invece di `load_correct_model()`. Quando `None`, comportamento attuale invariato.

Usa un path dedicato tipo `MODEL_DIR / "wf_temp" / "lgbm_wf.pkl"`, ripulito a fine run.

### 5.5 Routing nell'endpoint (`main.py`, `POST /backtest`)

```python
from services.backtesting import run_backtest, run_walk_forward_backtest
_fn = run_walk_forward_backtest if (req.config and getattr(req.config, "wf_backtest_enabled", False)) else run_backtest
result = await loop.run_in_executor(_backtest_executor, lambda: asyncio.run(_fn(req, cancel_event=cancel_event)))
```

### 5.6 Rischi e mitigazioni

| Rischio | Mitigazione |
|---|---|
| Sovrascrittura modello live | `model_out_path` dedicato + mai toccare `MODEL_PATH` (5.4). |
| Tempo di esecuzione lungo (N retrain) | N=4 → 4 retrain. Ogni retrain ~10-60s. Mostra progresso per finestra. Usa lo slot-singolo executor esistente. |
| Dati storici insufficienti per il primo training | Validare che `wf_backtest_train_start` sia abbastanza indietro; il trainer già alza `ValueError` se <100 righe. Gestire l'errore per finestra. |
| Cancellazione job a metà | Check `cancel_event.is_set()` a ogni finestra (già previsto sopra). |
| Funding/Binance data per periodi vecchi | Il trainer usa già Binance con `from_date`; coerente. |
| Disallineamento capitale tra finestre | Si passa `equity_running` come `initial_capital` del segmento successivo → equity curve continua e corretta. |

### 5.7 Stima di effort

**Alto.** Modifiche a `trainer.py` (to_date + model_out_path), nuovo orchestratore, override path in `run_backtest`, routing endpoint, UI con progresso per-finestra. 2-3 giorni con test accurato.

---

## 6. Ordine di implementazione consigliato

Procedi in modo incrementale: ogni feature è autonoma e mergeable separatamente.

```
Fase 1 — Slippage      (rischio basso,   valore alto, mezza giornata)
   └─ Sblocca subito stress test dei costi sui backtest esistenti.

Fase 2 — Monte Carlo   (rischio basso,   valore alto, ~1 giornata)
   └─ Si appoggia ai trade già prodotti, zero impatto sul loop.

Fase 3 — Walk-Forward  (rischio alto,    valore altissimo, 2-3 giorni)
   └─ Da fare per ultima: è la più invasiva ma è quella che dà
      validità statistica reale ai numeri. Richiede il test di
      non-regressione più rigoroso.
```

**Motivazione:** Slippage e Monte Carlo danno valore immediato con rischio minimo e ti permettono di prendere confidenza con il pattern "toggle + guardia no-op". Il Walk-Forward, più delicato, arriva quando il pattern è consolidato.

---

## 7. Checklist di test e validazione

Da eseguire per **ogni** feature prima del merge.

### Test di non-regressione (obbligatorio per tutte)
- [ ] Backtest di riferimento con **tutti i nuovi toggle OFF** → `final_equity` e `total_trades` identici al baseline pre-modifica.
- [ ] Snapshot del JSON risultato con toggle OFF: nessuna nuova chiave deve rompere il frontend (le chiavi nuove sono `None` o assenti).

### Feature 1 — Slippage
- [ ] `slippage_enabled=True, slippage_bps=0` → risultato identico al baseline (guardia `bps<=0`).
- [ ] `slippage_bps=5` → PnL totale **inferiore** al baseline (lo slippage erode), DD ≥ baseline.
- [ ] Le esecuzioni limit (partial TP, reversal retest) con `slippage_limit_favorable=True` non peggiorano.
- [ ] SL/liquidazioni applicano il moltiplicatore (verifica su un trade campione il prezzo di uscita).

### Feature 2 — Monte Carlo
- [ ] Con <10 trade → ritorna `status: insufficient_trades` senza crash.
- [ ] `montecarlo_runs` piccolo (1000) vs grande (20000): i percentili convergono (stabilità).
- [ ] `method="shuffle"` produce DD mediamente peggiore di `bootstrap` (clustering preservato).
- [ ] Tempo di esecuzione < 2s con 5000 run.
- [ ] Seed fisso → risultati riproducibili.

### Feature 3 — Walk-Forward
- [ ] **`lgbm_latest.pkl` NON viene modificato** dopo un WF backtest (confronta hash/mtime prima/dopo).
- [ ] Il modello di ogni finestra è addestrato solo su dati `< cutoff` (verifica nei log il numero candele e la data).
- [ ] Equity curve continua tra finestre (nessun salto artificiale di capitale).
- [ ] I numeri OOS sono **sensibilmente inferiori** all'in-sample (è il segnale che il leakage è stato eliminato — atteso e corretto).
- [ ] Cancellazione job a metà run → si ferma in modo pulito senza lasciare modelli temporanei orfani.
- [ ] Finestra con dati insufficienti → errore gestito per-finestra, non crash dell'intero job.

---

## Note finali

- **Tutte le feature sono additive e isolate dietro toggle**: con i toggle OFF il sistema è identico a oggi. Questo è il vincolo di progettazione più importante e va verificato per primo a ogni step.
- **Il frontend** (`BacktestPanel.tsx`) riusa il componente `Toggle` esistente: aggiungere i 3 nuovi toggle è meccanico. La visualizzazione dei risultati (percentili MC, metadati WF per-finestra, costo slippage) è puramente additiva.
- **Priorità di valore:** il Walk-Forward è ciò che trasforma i tuoi numeri da "illustrativi" a "predittivi". Slippage e Monte Carlo rendono onesta la stima del rischio. Insieme, coprono 3 degli 8 punti della guida di validazione professionale.

---

*Piano redatto il 10/06/2026 — basato sull'analisi diretta del codebase Quantum Trade (`main.py`, `backtesting.py`, `trainer.py`, `BacktestPanel.tsx`).*
