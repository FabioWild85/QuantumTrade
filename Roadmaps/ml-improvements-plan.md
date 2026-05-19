# Piano di Implementazione — ML Improvements con Toggle
**Data**: 2026-05-19
**Stato**: In attesa di implementazione

---

## Ordine di implementazione ottimale

```
Priorità = Impatto / Complessità / Dipendenze

1. Walk-forward aggressiva     → Alto impatto · Bassa complessità · Zero dipendenze → SUBITO
2. Feature Pruning             → Medio impatto · Bassa complessità · Zero dipendenze → SUBITO
3. Calibrazione Isotonica      → Medio impatto · Bassa complessità · Richiede 50+ trade → dopo 2-3 settimane
4. Gate LightGBM 1H (live)     → Alto impatto · Media complessità · Richiede sistema base stabile → dopo 1 mese
5. Gate LightGBM 1H (backtest) → Opzionale · dopo validazione live del gate
```

---

## Indice

1. [Walk-forward Validation Aggressiva](#1-walk-forward-validation-aggressiva)
2. [Feature Importance Pruning LightGBM](#2-feature-importance-pruning-lightgbm)
3. [Calibrazione Isotonica su c2_dir_prob](#3-calibrazione-isotonica-su-c2_dir_prob)
4. [Gate LightGBM 1H (live)](#4-gate-lightgbm-1h-live)
5. [Gate LightGBM 1H — Estensione Backtest (opzionale)](#5-gate-lightgbm-1h--estensione-backtest-opzionale)

---

## 1. Walk-forward Validation Aggressiva

**Impatto**: Alto | **Complessità**: Bassa | **Dipendenze**: Nessuna

### Situazione attuale

In `apps/api/services/trainer.py` tutto è hardcoded:
- `n_splits = 5` fold nella walk-forward CV (riga 167)
- `purge_gap = 5` candele tra train e validation (riga 167)
- `lookback_candles = 500` (parametro default di `retrain()`, riga 110)
- `retrain_every_n_cycles = 120` — hardcoded in `execution.py` (trigger del retrain)

La walk-forward usa già **expanding window** (ogni fold aggiunge dati): buona scelta.
Il problema è che con 5 fold su 500 candele, ogni fold di validazione copre ~20 candele 4H (~3 giorni).
Troppo poco per rilevare degrado nelle diverse condizioni di mercato.

### Cosa migliorare

| Parametro | Attuale | Aggressivo consigliato | Effetto |
|-----------|---------|------------------------|---------|
| `retrain_every_n_cycles` | 120 (~30 gg) | 30–40 (~7–10 gg) | Il modello si adatta ai nuovi regimi prima |
| `wf_n_splits` | 5 | 8 | Stima più robusta dell'OOS accuracy |
| `wf_lookback_candles` | 500 | 400–500 (invariato) | OK così |
| `wf_purge_gap` | 5 | 8 | Elimina più autocorrelazione temporale |

### Toggle / parametri da aggiungere

Non è un toggle on/off: sono **parametri numerici configurabili** dal BotConfig.
Il confronto si fa eseguendo due backtest con modelli addestrati con parametri diversi.

```
retrain_every_n_cycles: int   = 120   # nuovo campo BotConfig — range 20..120
wf_n_splits:            int   = 5     # nuovo campo BotConfig — range 3..12
wf_purge_gap:           int   = 5     # nuovo campo BotConfig — range 2..20
```

### File da modificare

#### A) `apps/api/services/execution.py`

Il retrain è pilotato dalla costante `RETRAIN_INTERVAL = 120` (riga 43) usata in
`if self._cycle_count % RETRAIN_INTERVAL == 0:` (riga 732). Il trigger chiama
`_retrain_background()`, che a sua volta chiama `self._trainer.retrain()`.

**Step 1**: Sostituire il riferimento alla costante (riga 732) con il valore dal config:
```python
# Prima:
if self._cycle_count % RETRAIN_INTERVAL == 0:
    asyncio.create_task(self._retrain_background())

# Dopo:
if self._cycle_count % self.config.retrain_every_n_cycles == 0:
    asyncio.create_task(self._retrain_background())
```

La costante `RETRAIN_INTERVAL` può essere rimossa (non più usata) o tenuta come commento.

**Step 2**: Aggiornare `_retrain_background()` per passare i parametri walk-forward al trainer:
```python
async def _retrain_background(self):
    log.info("Auto-retraining triggered (cycle %d)", self._cycle_count)
    try:
        metrics = await self._trainer.retrain(
            SYMBOL,
            lookback_candles=500,
            wf_n_splits=self.config.wf_n_splits,
            wf_purge_gap=self.config.wf_purge_gap,
        )
        if metrics.get("status") == "ok":
            await self._reload_model_after_retrain(metrics, trigger="auto")
    except Exception as exc:
        log.error("Retraining failed: %s", exc, exc_info=True)
```

**Step 3**: Aggiornare `retrain_manual()` nello stesso modo:
```python
async def retrain_manual(self) -> dict:
    metrics = await self._trainer.retrain(
        SYMBOL,
        lookback_candles=500,
        wf_n_splits=self.config.wf_n_splits,
        wf_purge_gap=self.config.wf_purge_gap,
    )
    if metrics.get("status") == "ok":
        await self._reload_model_after_retrain(metrics, trigger="manual")
    return metrics
```

**Step 4**: Aggiungere i nuovi campi alla classe `BotConfig` (plain Python) in `execution.py`,
nell'`__init__`, insieme agli altri campi esistenti:
```python
self.retrain_every_n_cycles = kw.get("retrain_every_n_cycles", 120)
self.wf_n_splits            = kw.get("wf_n_splits",            5)
self.wf_purge_gap           = kw.get("wf_purge_gap",           5)
```

> **Nota**: `execution.py` contiene una classe `BotConfig` separata dalla Pydantic model
> in `main.py`. Ogni nuovo campo va aggiunto a **entrambi**. Senza il `kw.get()` in
> `execution.py`, il bot lancerebbe `AttributeError` al primo ciclo prima della chiamata
> a `update_config()`.

#### B) `apps/api/services/trainer.py`

**Step 1**: Aggiungere i parametri al metodo `retrain()`:

```python
async def retrain(
    self,
    symbol:           str = "BTC",
    lookback_candles: int = 500,
    wf_n_splits:      int = 5,      # ← NUOVO
    wf_purge_gap:     int = 5,      # ← NUOVO
) -> dict:
```

**Step 2**: Passarli a `_walk_forward_splits()` (riga 167):

```python
# Prima (hardcoded):
wf_results = _walk_forward_splits(X, y, n_splits=5, purge_gap=5)

# Dopo (parametrizzato):
wf_results = _walk_forward_splits(X, y, n_splits=wf_n_splits, purge_gap=wf_purge_gap)
```

**Step 3**: Aggiungere ai `metrics` i parametri usati per tracciabilità:

```python
metrics["wf_n_splits"]   = wf_n_splits
metrics["wf_purge_gap"]  = wf_purge_gap
metrics["retrain_cycle"] = self._cycle_count_at_retrain  # opzionale
```

#### C) `apps/api/main.py` — BotConfig

```python
retrain_every_n_cycles: int = Field(120, ge=20,  le=120)
wf_n_splits:            int = Field(5,   ge=3,   le=12)
wf_purge_gap:           int = Field(5,   ge=2,   le=20)
```

#### D) `apps/web/components/trading-hub/BotConfig.tsx`

Aggiungere all'interfaccia:
```typescript
retrain_every_n_cycles: number;
wf_n_splits:            number;
wf_purge_gap:           number;
```

Defaults: `120`, `5`, `5`

Aggiungere sezione UI "Retraining LightGBM":

```tsx
<Section title="Retraining Automatico LightGBM" description="Controlla con quale frequenza il modello viene riaddestrato e quanti fold usa la walk-forward cross-validation.">
  <SliderField
    label="Frequenza retrain (cicli)"
    value={config.retrain_every_n_cycles}
    min={20} max={120} step={10}
    format={v => `ogni ${v} cicli (≈${Math.round(v / 6)} giorni)`}
    onChange={v => setConfig(c => ({ ...c, retrain_every_n_cycles: v }))}
    description="Default 120 (~30 giorni). Abbassa a 30–40 per adattarsi più velocemente ai nuovi regimi."
  />
  <SliderField
    label="Fold walk-forward"
    value={config.wf_n_splits}
    min={3} max={12} step={1}
    format={v => `${v} fold`}
    onChange={v => setConfig(c => ({ ...c, wf_n_splits: v }))}
    description="Numero di split nella cross-validation temporale. Più fold = stima OOS più robusta."
  />
  <SliderField
    label="Purge gap (candele)"
    value={config.wf_purge_gap}
    min={2} max={20} step={1}
    format={v => `${v} candele (${v * 4}h)`}
    onChange={v => setConfig(c => ({ ...c, wf_purge_gap: v }))}
    description="Candele escluse tra train e validation per ridurre autocorrelazione. Alzare in mercati molto trending."
  />
</Section>
```

### Ordine di implementazione

1. Aggiungere i 3 campi al `BotConfig` Pydantic in `main.py` (con `Field()` e range)
2. Aggiungere gli stessi 3 campi al `BotConfig` plain Python in `execution.py` (con `kw.get()`)
3. Modificare `trainer.py`: aggiungere parametri a `retrain()` e `_run()`, passarli a `_walk_forward_splits()`
4. Modificare `execution.py`: sostituire `% RETRAIN_INTERVAL` con `% self.config.retrain_every_n_cycles`; aggiornare `_retrain_background()` e `retrain_manual()` per passare `wf_n_splits`/`wf_purge_gap`
5. Aggiungere campi TypeScript + UI in `BotConfig.tsx`

**Tempo stimato**: mezza giornata (è tutto parametrizzazione di logica esistente).

### Impostazioni consigliate per iniziare

```
retrain_every_n_cycles = 40   (≈10 giorni)
wf_n_splits            = 8
wf_purge_gap           = 8
```

Monitorare se `wf_avg_accuracy` migliora o peggiora rispetto ai valori con `n_splits=5`.
Se peggiora, il modello stava forse overfittando sui fold rari — segnale positivo della nuova config.

---

## 2. Feature Importance Pruning LightGBM

**Impatto**: Medio | **Complessità**: Bassa | **Dipendenze**: Nessuna

### Situazione attuale

Il modello usa 56 feature non-Chronos (`LGBM_FEATURES` in `trainer.py`, riga 32).
LightGBM calcola `feature_importances_` (gain-based) dopo ogni training ma il valore
non viene né salvato né usato per filtrare le feature nei run successivi.

### Cosa migliorare

Identificare le feature con importanza normalizzata < soglia, addestare un secondo
modello `lgbm_pruned.pkl` con solo le feature significative.
Il toggle seleziona quale modello usare (full vs pruned) senza toccare il training flow principale.

### Toggle

```
use_feature_pruning:            bool  = False
feature_pruning_min_importance: float = 0.005   # 0.5% del gain totale
```

### File da modificare

#### A) `apps/api/services/trainer.py`

**Step 1**: Aggiungere salvataggio `feature_importance.json` alla fine di `_run()`,
subito dopo il salvataggio del modello (riga ~198):

```python
import json

# Salva feature importance per analisi e pruning
importances = model.feature_importances_
total_imp   = importances.sum() or 1.0
imp_dict = {
    name: round(float(imp / total_imp), 5)
    for name, imp in sorted(
        zip(available, importances),
        key=lambda x: -x[1]
    )
}
with open(MODEL_DIR / "feature_importance.json", "w") as f:
    json.dump({"trained_at": t0.isoformat(), "features": imp_dict}, f, indent=2)

log.info("Feature importance saved (%d features)", len(imp_dict))
```

**Step 2**: Aggiungere metodo `_build_pruned_model()` nella classe `LGBMTrainer`:

```python
def _build_pruned_model(
    self,
    model:     lgb.LGBMClassifier,
    X_train:   pd.DataFrame,
    y_train:   pd.Series,
    X_val:     pd.DataFrame,
    y_val:     pd.Series,
    threshold: float = 0.005,
) -> tuple[lgb.LGBMClassifier, list[str], dict]:
    """
    Addestra un modello sul sottoinsieme di feature con importanza >= threshold.
    Ritorna (pruned_model, kept_features, comparison_metrics).
    """
    importances = model.feature_importances_
    total       = importances.sum() or 1.0
    norm        = importances / total

    kept    = [f for f, imp in zip(X_train.columns, norm) if imp >= threshold]
    removed = [f for f, imp in zip(X_train.columns, norm) if imp < threshold]

    if len(kept) < 10:
        log.warning("Pruning skipped: too few features would survive (%d)", len(kept))
        return model, list(X_train.columns), {"status": "skipped"}

    log.info("Pruning: keeping %d/%d features, removing: %s", len(kept), len(X_train.columns), removed)

    pruned = lgb.LGBMClassifier(**_LGB_PARAMS)
    pruned.fit(
        X_train[kept], y_train,
        eval_set   = [(X_val[kept], y_val)],
        callbacks  = [lgb.early_stopping(50, verbose=False), lgb.log_evaluation(0)],
    )

    full_acc   = float(accuracy_score(y_val, model.predict(X_val)))
    pruned_acc = float(accuracy_score(y_val, pruned.predict(X_val[kept])))

    return pruned, kept, {
        "status":           "ok",
        "features_kept":    len(kept),
        "features_removed": len(removed),
        "removed_names":    removed,
        "full_accuracy":    round(full_acc,   4),
        "pruned_accuracy":  round(pruned_acc, 4),
        "accuracy_delta":   round(pruned_acc - full_acc, 4),
    }
```

**Step 3**: Chiamare `_build_pruned_model()` alla fine di `_run()` se il pruning è abilitato.
Aggiungere `use_feature_pruning` e `feature_pruning_min_importance` come parametri di `_run()`,
passati da `retrain()` dopo averli letti dal config:

```python
# Alla fine di _run(), dopo il salvataggio di lgbm_latest.pkl:
if use_feature_pruning:
    pruned_model, kept_feats, prune_metrics = self._build_pruned_model(
        model, X_tr, y_tr, X_val, y_val,
        threshold=feature_pruning_min_importance,
    )
    if prune_metrics.get("status") == "ok":
        payload_pruned = {"model": pruned_model, "features": kept_feats}
        with open(MODEL_DIR / "lgbm_pruned.pkl", "wb") as f:
            pickle.dump(payload_pruned, f)
        with open(MODEL_DIR / "pruned_features.json", "w") as f:
            json.dump({"trained_at": t0.isoformat(), **prune_metrics}, f, indent=2)
    metrics["pruning"] = prune_metrics
```

#### B) `apps/api/services/execution.py`

Nella funzione `load_model()` (o nel metodo di caricamento del modello nell'engine),
aggiungere la logica di selezione del modello:

```python
# Attualmente (semplificato):
#   model, features = load_model()

# Nuovo: rispetta il flag use_feature_pruning dal config
def load_correct_model(use_pruning: bool):
    if use_pruning:
        pruned_path = MODEL_DIR / "lgbm_pruned.pkl"
        if pruned_path.exists():
            with open(pruned_path, "rb") as f:
                payload = pickle.load(f)
            log.info("Loaded PRUNED model (%d features)", len(payload["features"]))
            return payload["model"], payload["features"]
        log.warning("Pruned model not found, falling back to full model")
    return load_model()  # funzione esistente in trainer.py
```

Il metodo `_get_lgbm_prob()` in `execution.py` non richiede modifiche: riceve già
`df_feat` e seleziona le colonne basandosi su `features` (già salvato nel payload).

#### C) `apps/api/services/backtesting.py`

Identica modifica: nel setup del backtest, sostituire il caricamento del modello
con `load_correct_model(cfg.use_feature_pruning)`.

Il loop del backtest usa già le `features` salvate nel payload per filtrare le colonne,
quindi non servono ulteriori modifiche nel loop.

#### D) Nuovo endpoint: feature importance

```python
# In apps/api/main.py

@app.get("/model/feature-importance")
async def get_feature_importance():
    """Restituisce l'importanza normalizzata di ogni feature dall'ultimo retrain."""
    path = MODEL_DIR / "feature_importance.json"
    if not path.exists():
        return {"available": False}
    with open(path) as f:
        return {"available": True, **json.load(f)}

@app.get("/model/pruning-stats")
async def get_pruning_stats():
    """Restituisce il confronto full vs pruned model dall'ultimo retrain."""
    path = MODEL_DIR / "pruned_features.json"
    if not path.exists():
        return {"available": False}
    with open(path) as f:
        return {"available": True, **json.load(f)}
```

#### E) `apps/api/main.py` — BotConfig (Pydantic)

```python
use_feature_pruning:            bool  = Field(False)
feature_pruning_min_importance: float = Field(0.005, ge=0.001, le=0.05)
```

Aggiungere anche al `BotConfig` plain Python in `execution.py`:
```python
self.use_feature_pruning            = kw.get("use_feature_pruning",            False)
self.feature_pruning_min_importance = kw.get("feature_pruning_min_importance", 0.005)
```

#### F) `apps/web/components/trading-hub/BotConfig.tsx`

```typescript
// Interfaccia
use_feature_pruning:            boolean;
feature_pruning_min_importance: number;

// Defaults
use_feature_pruning:            false,
feature_pruning_min_importance: 0.005,
```

UI nella sezione LightGBM:

```tsx
<Toggle
  label="Feature Pruning"
  description="Usa il modello LightGBM con sole le feature più informative. Attiva il pruning, poi esegui un retrain manuale per generare lgbm_pruned.pkl."
  checked={config.use_feature_pruning}
  onChange={v => setConfig(c => ({ ...c, use_feature_pruning: v }))}
/>
{config.use_feature_pruning && (
  <SliderField
    label="Importanza minima feature"
    value={config.feature_pruning_min_importance}
    min={0.001} max={0.05} step={0.001}
    format={v => `${(v * 100).toFixed(1)}%`}
    onChange={v => setConfig(c => ({ ...c, feature_pruning_min_importance: v }))}
    description="Feature con importanza gain normalizzata sotto questa soglia vengono rimosse. 0.5% è il default sicuro."
  />
)}
```

### Ordine di implementazione

1. Aggiungere salvataggio `feature_importance.json` in `trainer.py` (1 modifica, nessun rischio)
2. Aggiungere `_build_pruned_model()` in `trainer.py`
3. Aggiungere campi `use_feature_pruning` in BotConfig (Python + TypeScript)
4. Modificare il caricamento modello in `execution.py` e `backtesting.py`
5. Aggiungere endpoint `/model/feature-importance` e `/model/pruning-stats`
6. Aggiungere UI in `BotConfig.tsx`

### Quando attivare

1. Attivare il toggle in BotConfig
2. Triggerare un retrain manuale (`POST /retrain`)
3. Controllare `GET /model/pruning-stats` → verificare `accuracy_delta`
4. Se `|accuracy_delta| < 0.005` (meno di 0.5% di differenza): pruning sicuro, lasciare attivo
5. Se `accuracy_delta < -0.01` (peggioramento > 1%): alzare la soglia o disattivare

---

## 3. Calibrazione Isotonica su c2_dir_prob

**Impatto**: Medio | **Complessità**: Bassa | **Dipendenze**: ≥50 trade chiusi nel DB

### Situazione attuale

`chronos_model.py` restituisce `c2_dir_prob` come probabilità grezza dal modello.
Non c'è nessuna verifica che questa probabilità sia ben calibrata rispetto agli esiti reali.
Esiste già calibrazione empirica in `risk.py` per l'uncertainty (size scaling),
ma nessuna correzione sulla probabilità direzionale usata nell'ensemble.

### Toggle

```
use_chronos_calibration: bool = False
```

### File da modificare / creare

#### A) Nuovo file: `apps/api/services/calibration.py`

```python
"""
IsotonicCalibrator — corregge c2_dir_prob di Chronos-2 basandosi
sugli esiti reali dei trade storici.

Addestrato su:
  X = c2_dir_prob al momento dell'inferenza (da inference_logs)
  y = 1 se il trade corrispondente è stato profittevole nella direzione attesa,
      0 altrimenti

Usa sklearn.isotonic.IsotonicRegression (monotonic constraint: se Chronos
è più sicuro, la correzione non può invertire la direzione).
"""

import json
import logging
import pickle
from pathlib import Path
from typing import Optional

import numpy as np
from sklearn.isotonic import IsotonicRegression

log = logging.getLogger(__name__)

MIN_SAMPLES = 50  # sotto questo numero non si fitta


class IsotonicCalibrator:

    def __init__(self):
        self._model: Optional[IsotonicRegression] = None
        self._n_samples: int = 0

    # ── Fit ──────────────────────────────────────────────────────────────────

    async def fit(self, db) -> int:
        """
        Legge da Supabase:
          - inference_logs: c2_dir_prob, decision, time, id
          - trades: inference_id, pnl_usd, side

        Costruisce (X, y) e fitta IsotonicRegression.
        Ritorna il numero di campioni usati.
        """
        try:
            # Join inference_logs + trades su inference_id
            result = db.table("inference_logs") \
                .select("id, c2_dir_prob, decision") \
                .not_.is_("c2_dir_prob", "null") \
                .execute()

            logs = {row["id"]: row for row in (result.data or [])}
            if not logs:
                return 0

            trades_result = db.table("trades") \
                .select("inference_id, pnl_usd, side") \
                .not_.is_("inference_id", "null") \
                .execute()

            X, y = [], []
            for trade in (trades_result.data or []):
                inf_id = trade.get("inference_id")
                if inf_id not in logs:
                    continue
                prob = logs[inf_id].get("c2_dir_prob")
                if prob is None:
                    continue
                # outcome: 1 se il trade ha guadagnato nella direzione prevista
                outcome = 1 if (trade.get("pnl_usd") or 0) > 0 else 0
                X.append(float(prob))
                y.append(outcome)

            if len(X) < MIN_SAMPLES:
                log.warning("Calibrator: only %d samples (need %d)", len(X), MIN_SAMPLES)
                return len(X)

            self._model = IsotonicRegression(out_of_bounds="clip")
            self._model.fit(np.array(X), np.array(y))
            self._n_samples = len(X)
            log.info("Calibrator fitted on %d samples", self._n_samples)
            return self._n_samples

        except Exception as exc:
            log.warning("Calibrator fit failed: %s", exc)
            return 0

    # ── Transform ─────────────────────────────────────────────────────────────

    def transform(self, prob: float) -> float:
        """Applica la correzione a una singola probabilità."""
        if self._model is None:
            return prob
        return float(self._model.predict([[prob]])[0])

    def is_fitted(self) -> bool:
        return self._model is not None

    # ── Persist ───────────────────────────────────────────────────────────────

    def save(self, path: Path | str):
        with open(path, "wb") as f:
            pickle.dump({"model": self._model, "n_samples": self._n_samples}, f)

    @classmethod
    def load(cls, path: Path | str) -> "IsotonicCalibrator":
        obj = cls()
        with open(path, "rb") as f:
            data = pickle.load(f)
        obj._model    = data["model"]
        obj._n_samples = data.get("n_samples", 0)
        return obj

    # ── Stats ─────────────────────────────────────────────────────────────────

    def calibration_stats(self) -> dict:
        """Ritorna statistiche di calibrazione per debug/UI."""
        if not self.is_fitted():
            return {"fitted": False}
        return {
            "fitted":    True,
            "n_samples": self._n_samples,
        }
```

#### B) `apps/api/services/trainer.py`

Aggiungere metodo `retrain_calibrator()` alla classe `LGBMTrainer`:

```python
async def retrain_calibrator(self) -> dict:
    """
    Fitta IsotonicCalibrator su trade storici.
    Chiamato automaticamente alla fine di retrain() se use_chronos_calibration=True.
    """
    from services.calibration import IsotonicCalibrator
    cal = IsotonicCalibrator()
    n   = await cal.fit(get_supabase())

    if n >= 50:
        cal.save(MODEL_DIR / "chronos_calibrator.pkl")
        log.info("Chronos calibrator saved (%d samples)", n)
        return {"status": "ok", "n_samples": n}

    log.warning("Calibrator skipped: insufficient samples (%d < 50)", n)
    return {"status": "skipped", "n_samples": n}
```

Alla fine di `_run()`, dopo il salvataggio del modello principale:

```python
if use_chronos_calibration:
    cal_result = await self.retrain_calibrator()
    metrics["calibrator"] = cal_result
```

Aggiungere `use_chronos_calibration: bool = False` come parametro di `_run()`/`retrain()`.

#### C) `apps/api/services/chronos_model.py`

In `__init__` di `ChronosForecaster`, aggiungere caricamento lazy del calibratore:

```python
from pathlib import Path

self._calibrator = None
cal_path = Path("models/chronos_calibrator.pkl")
if cal_path.exists():
    from services.calibration import IsotonicCalibrator
    self._calibrator = IsotonicCalibrator.load(cal_path)
    log.info("Chronos calibrator loaded (%d samples)", self._calibrator._n_samples)
```

Nel metodo `forecast()`, aggiungere parametro `use_calibration: bool = False`
e applicare la correzione prima del return:

```python
def forecast(
    self,
    close_series:    np.ndarray,
    horizon:         int = 3,
    use_calibration: bool = False,   # ← NUOVO
    # ... parametri esistenti invariati ...
) -> dict:
    # ... logica esistente invariata ...

    # Applicazione calibrazione — alla fine, prima del return
    if use_calibration and self._calibrator is not None and self._calibrator.is_fitted():
        raw_prob = result["c2_dir_prob"]
        result["c2_dir_prob"]     = self._calibrator.transform(raw_prob)
        result["c2_dir_prob_raw"] = raw_prob   # conserva per log/debug
    
    return result
```

**Nota**: quando `use_calibration=True` ma il calibratore non è caricato (file non esiste),
la funzione ritorna silenziosamente il valore non corretto (fail-safe).

#### D) `apps/api/services/execution.py`

Nella chiamata a `self._chronos.forecast()` in `_cycle()` (non esiste un metodo `_analyse()` — il forecast è direttamente in `_cycle()`):

```python
c2_out = self._chronos.forecast(
    close_series    = closes,
    horizon         = 3,
    use_calibration = self.config.use_chronos_calibration,  # ← NUOVO
    atr             = latest.get("atr_14"),
    volume_series   = volumes,
    # ... altri parametri invariati ...
)
```

#### E) `apps/api/services/backtesting.py`

Nella chiamata a `chronos.forecast()` nel loop del backtest:

```python
c2_out = chronos.forecast(
    close_series    = ctx_closes,
    horizon         = 3,
    use_calibration = cfg.use_chronos_calibration,  # ← NUOVO
    # ... altri parametri invariati ...
)
```

Il calibratore viene caricato automaticamente nell'`__init__` di `ChronosForecaster`,
quindi il backtest lo usa senza logica aggiuntiva.

#### F) `apps/api/services/execution.py` — `_log_inference()`

Attualmente `c2_dir_prob` è salvato solo **dentro** il JSON `forecast`, non come colonna
top-level. Il calibratore fa un `.select("id, c2_dir_prob, ...")` sulla tabella, quindi
la colonna deve esistere anche a livello SQL **e** venire popolata nell'INSERT.

Modificare `_log_inference()` per aggiungere il campo top-level all'insert:
```python
db.table("inference_logs").insert({
    "id":          inference_id,
    "bot_id":      None,
    "model":       "chronos2_lgbm_ensemble_v2",
    "c2_dir_prob": self._safe_float(c2.get("c2_dir_prob")),   # ← NUOVO top-level
    "features":    { ... },   # invariato
    "forecast":    { ... },   # invariato (c2_dir_prob resta anche qui per retro-compat.)
    "decision":    result.action,
    "reasoning":   result.reasoning,
    "latency_ms":  c2.get("latency_ms", 0),
}).execute()
```

#### G) Migration SQL — `inference_logs`

Verificare prima se le colonne esistono:
```sql
SELECT column_name FROM information_schema.columns
WHERE table_name = 'inference_logs';
```

Se mancano, creare il file `apps/api/db/sql_history/2026-05-XX_013_inference_logs_calibration.sql`:

```sql
ALTER TABLE inference_logs
  ADD COLUMN IF NOT EXISTS c2_dir_prob      DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS c2_dir_prob_raw  DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS c2_uncertainty   DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS c2_cont_prob     DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS inference_id     BIGINT;   -- foreign key verso trades

-- Aggiungere anche in trades se non esiste:
ALTER TABLE trades
  ADD COLUMN IF NOT EXISTS inference_id BIGINT;
```

Modificare `execution.py` per salvare `inference_id` nel record del trade
e il `c2_dir_prob` nel log dell'inferenza — in modo che il join funzioni.

#### H) Endpoint aggiuntivi

```python
@app.post("/calibrator/refit")
async def refit_calibrator():
    """Forza re-fit manuale del calibratore senza full retrain LGBM."""
    result = await trainer.retrain_calibrator()
    return result

@app.get("/calibrator/stats")
async def calibrator_stats():
    """Restituisce stato e statistiche del calibratore corrente."""
    cal_path = MODEL_DIR / "chronos_calibrator.pkl"
    if not cal_path.exists():
        return {"fitted": False, "file_exists": False}
    from services.calibration import IsotonicCalibrator
    cal = IsotonicCalibrator.load(cal_path)
    return {"file_exists": True, **cal.calibration_stats()}
```

#### I) `apps/api/main.py` — BotConfig (Pydantic)

```python
use_chronos_calibration: bool = Field(False)
```

Aggiungere anche al `BotConfig` plain Python in `execution.py`:
```python
self.use_chronos_calibration = kw.get("use_chronos_calibration", False)
```

#### J) `apps/web/components/trading-hub/BotConfig.tsx`

```typescript
use_chronos_calibration: boolean;
// Default: false
```

UI nella sezione Chronos-2 (dopo il toggle `chronos_enabled`):

```tsx
<Toggle
  label="Calibrazione Isotonica c2_dir_prob"
  description="Corregge le probabilità di Chronos basandosi sugli esiti reali dei trade storici. Richiede ≥50 trade chiusi con inference_id valorizzato."
  checked={config.use_chronos_calibration}
  onChange={v => setConfig(c => ({ ...c, use_chronos_calibration: v }))}
  disabled={!config.chronos_enabled}
/>
```

### Ordine di implementazione

1. Creare `calibration.py`
2. Applicare migration SQL su `inference_logs` (aggiunge `c2_dir_prob` colonna top-level) e `trades` (aggiunge `inference_id`)
3. Modificare `_log_inference()` in `execution.py` per salvare `c2_dir_prob` come colonna top-level nell'INSERT (non solo nel JSON `forecast`)
4. Modificare `_close_position()` in `execution.py` per includere `"inference_id": self._position.get("inference_id")` nell'INSERT della tabella `trades`
5. Modificare `chronos_model.py`: caricamento lazy calibratore nell'`__init__` + parametro `use_calibration` in `forecast()`
6. Modificare `trainer.py`: aggiungere `retrain_calibrator()`
7. Modificare `execution.py` (`_cycle()`) e `backtesting.py`: passare `use_calibration` flag a `forecast()`
8. Aggiungere endpoint `/calibrator/refit` e `/calibrator/stats`
9. Aggiungere campo BotConfig (Pydantic main.py + plain execution.py + TypeScript) e UI toggle

**Quando attivare**: dopo 2-3 settimane di bot operativo con ≥50 trade chiusi.
Verificare prima con `GET /calibrator/stats` che `n_samples >= 50`.

---

## 4. Gate LightGBM 1H (live)

**Impatto**: Alto | **Complessità**: Media | **Dipendenze**: Sistema base stabile, 4+ settimane operative

### Obiettivo

Aggiungere un secondo LightGBM su candele 1H come gate di conferma:
il segnale 4H viene eseguito solo se il modello 1H concorda con la direzione.

### Toggle e parametri

```
use_1h_lgbm_gate:        bool  = False
lgbm_1h_min_agreement:   float = 0.52   # P(up) minima su 1H per confermare LONG
lgbm_1h_block_threshold: float = 0.45   # sotto questo: LONG bloccato
```

### Logica del gate

```
Segnale 4H = LONG (ensemble_prob = 0.68)
↓
Gate 1H abilitato?
  → Fetch ultime 512 candele 1H
  → Calcola feature matrix 1H (stessa build_all_features)
  → lgbm_1h_prob = predict_proba(...)[1]  # P(up) su 1H

  lgbm_1h_prob ≥ min_agreement (0.52)?   → ✅ Trade confermato, size normale
  block_threshold ≤ prob < min_agreement? → ⚠️  Trade permesso, size_factor = 0.70
  lgbm_1h_prob < block_threshold (0.45)?  → ❌ Trade bloccato ("1H contrario")
```

### File da modificare

#### A) `apps/api/services/trainer.py`

Aggiungere metodo `retrain_1h()` alla classe `LGBMTrainer`:

```python
async def retrain_1h(
    self,
    symbol:           str = "BTC",
    lookback_candles: int = 2000,
) -> dict:
    """
    Addestra LightGBM su candele 1H.
    Usa le stesse feature del modello 4H (build_all_features).
    Target: close[+1] > close[0] (orizzonte 1 candela).
    Salva in: models/lgbm_1h_latest.pkl
    """
    t0 = datetime.now(timezone.utc)
    log.info("1H LightGBM retraining started")

    fetch_n  = lookback_candles + 128
    df_ohlcv = await self._hl.get_ohlcv(symbol, "1h", limit=fetch_n)
    df_fund  = await self._hl.get_funding_history(symbol, hours=fetch_n)

    df_feat  = build_all_features(df_ohlcv, df_fund, pd.DataFrame(), pd.DataFrame())
    df_feat["_target"] = (df_feat["close"].shift(-1) > df_feat["close"]).astype(int)

    available = [f for f in LGBM_FEATURES if f in df_feat.columns]
    df_feat[available] = df_feat[available].fillna(0)
    df_clean = df_feat.dropna(subset=["_target"]).iloc[64:]
    if len(df_clean) > lookback_candles:
        df_clean = df_clean.iloc[-lookback_candles:]

    if len(df_clean) < 200:
        raise ValueError(f"Insufficient 1H data: {len(df_clean)} rows")

    X = df_clean[available]
    y = df_clean["_target"]

    split    = int(len(X) * 0.80)
    X_tr, X_val = X.iloc[:split], X.iloc[split:]
    y_tr, y_val = y.iloc[:split], y.iloc[split:]

    model_1h = lgb.LGBMClassifier(**_LGB_PARAMS)
    model_1h.fit(
        X_tr, y_tr,
        eval_set  = [(X_val, y_val)],
        callbacks = [lgb.early_stopping(50, verbose=False), lgb.log_evaluation(0)],
    )

    oos_acc = float(accuracy_score(y_val, model_1h.predict(X_val)))
    payload = {"model": model_1h, "features": available}
    with open(MODEL_DIR / "lgbm_1h_latest.pkl", "wb") as f:
        pickle.dump(payload, f)

    elapsed = (datetime.now(timezone.utc) - t0).total_seconds()
    log.info("1H model trained: OOS acc=%.2f%% (%.1fs)", oos_acc * 100, elapsed)
    return {
        "status":       "ok",
        "oos_accuracy": round(oos_acc, 4),
        "train_rows":   split,
        "val_rows":     len(X_val),
        "n_features":   len(available),
        "elapsed_s":    round(elapsed, 1),
    }
```

Modificare `retrain()` per chiamare `retrain_1h()` automaticamente se abilitato:

```python
# Alla fine di _run(), dopo tutti i salvataggi:
if use_1h_lgbm_gate:
    try:
        result_1h = await self.retrain_1h()
        metrics["lgbm_1h"] = result_1h
    except Exception as exc:
        log.warning("1H retrain failed: %s", exc)
        metrics["lgbm_1h"] = {"status": "failed", "error": str(exc)}
```

#### B) `apps/api/services/execution.py`

Aggiungere nel `__init__` dell'engine:

```python
self._lgbm_1h          = None
self._lgbm_1h_features = None
```

Aggiungere metodo `_load_1h_model()` (chiamato da `_load_models()` o equivalente):

```python
def _load_1h_model(self):
    path_1h = MODEL_DIR / "lgbm_1h_latest.pkl"
    if path_1h.exists():
        with open(path_1h, "rb") as f:
            payload = pickle.load(f)
        self._lgbm_1h          = payload["model"]
        self._lgbm_1h_features = payload["features"]
        log.info("1H LGBM loaded (%d features)", len(self._lgbm_1h_features))
    else:
        self._lgbm_1h = None
        log.warning("1H LGBM model not found — gate will be skipped if enabled")
```

Nel metodo `_analyse()`, aggiungere il gate **dopo** il calcolo della decisione
da `DecisionEngine.decide()` e **prima** di eseguire il trade:

```python
# --- Gate 1H (applicato dopo la decisione 4H) ---
if (
    self.config.use_1h_lgbm_gate
    and self._lgbm_1h is not None
    and result.action in ("long", "short")
):
    try:
        df_1h_raw  = await self._hl.get_ohlcv("BTC", "1h", limit=640)
        df_1h_fund = await self._hl.get_funding_history("BTC", hours=640)
        df_1h_feat = build_all_features(df_1h_raw, df_1h_fund,
                                        pd.DataFrame(), pd.DataFrame())
        df_1h_feat = df_1h_feat.dropna().iloc[64:]

        row_1h = df_1h_feat.iloc[[-1]]
        cols   = [c for c in self._lgbm_1h_features if c in row_1h.columns]
        row_1h[cols] = row_1h[cols].fillna(0)

        lgbm_1h_prob = float(self._lgbm_1h.predict_proba(row_1h[cols])[0, 1])

        min_agr   = self.config.lgbm_1h_min_agreement
        block_thr = self.config.lgbm_1h_block_threshold

        if result.action == "long":
            if lgbm_1h_prob < block_thr:
                result.action = "no_trade"
                result.reasoning.append(f"1H gate BLOCK: P(up)={lgbm_1h_prob:.3f} < {block_thr}")
            elif lgbm_1h_prob < min_agr:
                result.size_factor *= 0.70
                result.reasoning.append(f"1H gate REDUCE: P(up)={lgbm_1h_prob:.3f} → size×0.70")

        elif result.action == "short":
            p_down = 1.0 - lgbm_1h_prob
            if p_down < block_thr:
                result.action = "no_trade"
                result.reasoning.append(f"1H gate BLOCK: P(down)={p_down:.3f} < {block_thr}")
            elif p_down < min_agr:
                result.size_factor *= 0.70
                result.reasoning.append(f"1H gate REDUCE: P(down)={p_down:.3f} → size×0.70")

        log.info("1H gate: prob=%.3f action=%s size_factor=%.2f",
                 lgbm_1h_prob, result.action, result.size_factor)

    except Exception as exc:
        log.warning("1H gate skipped (error): %s", exc)
        # Fail-safe: il trade procede senza il gate
```

#### C) Endpoint manuale training 1H

```python
@app.post("/retrain/1h")
async def retrain_1h_endpoint():
    """Avvia manualmente il training del modello LightGBM 1H."""
    if not engine:
        raise HTTPException(503, "Engine not initialized")
    result = await trainer.retrain_1h()
    return result
```

#### D) `apps/api/main.py` — BotConfig (Pydantic)

```python
use_1h_lgbm_gate:        bool  = Field(False)
lgbm_1h_min_agreement:   float = Field(0.52, ge=0.50, le=0.70)
lgbm_1h_block_threshold: float = Field(0.45, ge=0.30, le=0.50)
```

Aggiungere anche al `BotConfig` plain Python in `execution.py`:
```python
self.use_1h_lgbm_gate        = kw.get("use_1h_lgbm_gate",        False)
self.lgbm_1h_min_agreement   = kw.get("lgbm_1h_min_agreement",   0.52)
self.lgbm_1h_block_threshold = kw.get("lgbm_1h_block_threshold", 0.45)
```

#### E) `apps/web/components/trading-hub/BotConfig.tsx`

```typescript
use_1h_lgbm_gate:        boolean;
lgbm_1h_min_agreement:   number;
lgbm_1h_block_threshold: number;
// Defaults: false, 0.52, 0.45
```

UI nella sezione dedicata "Gate LightGBM 1H":

```tsx
<Section title="Gate LightGBM 1H" description="Un secondo modello LightGBM addestrato su candele 1H conferma o blocca i segnali del modello 4H principale. Riduce i falsi segnali in momenti di disaccordo tra i due timeframe.">
  <Toggle
    label="Abilita Gate 1H"
    description="Richiede lgbm_1h_latest.pkl. Usa POST /retrain/1h per generarlo manualmente."
    checked={config.use_1h_lgbm_gate}
    onChange={v => setConfig(c => ({ ...c, use_1h_lgbm_gate: v }))}
  />
  {config.use_1h_lgbm_gate && (
    <>
      <SliderField
        label="Accordo minimo 1H"
        value={config.lgbm_1h_min_agreement}
        min={0.50} max={0.70} step={0.01}
        format={v => `${(v * 100).toFixed(0)}%`}
        onChange={v => setConfig(c => ({ ...c, lgbm_1h_min_agreement: v }))}
        description="P(up) minima su 1H per confermare un LONG (viceversa per SHORT). Sotto: size ridotta a 70%."
      />
      <SliderField
        label="Soglia di blocco 1H"
        value={config.lgbm_1h_block_threshold}
        min={0.30} max={0.50} step={0.01}
        format={v => `${(v * 100).toFixed(0)}%`}
        onChange={v => setConfig(c => ({ ...c, lgbm_1h_block_threshold: v }))}
        description="Se P(up) scende sotto questa soglia per un LONG, il trade viene bloccato completamente."
      />
    </>
  )}
</Section>
```

### Ordine di implementazione

1. Aggiungere `retrain_1h()` in `trainer.py`
2. Aggiungere endpoint `POST /retrain/1h` in `main.py`
3. Aggiungere `_load_1h_model()` e logica gate in `execution.py`
4. Aggiungere campi BotConfig (Python + TypeScript) e UI

### Quando attivare

1. `POST /retrain/1h` manuale → verifica log `1H LGBM loaded`
2. Attivare toggle con parametri conservativi: `min_agreement=0.52`, `block_threshold=0.42`
3. Monitorare: il gate non dovrebbe bloccare più del 25-30% dei segnali
4. Se blocca troppo (>40%): abbassare `min_agreement` o `block_threshold`

---

## 5. Gate LightGBM 1H — Estensione Backtest (opzionale)

> Implementare solo dopo ≥4-6 settimane di validazione del gate live.

### Il problema specifico del backtest

Il backtester fetcha dati 4H storici. Per replicare il gate 1H in backtest
senza look-ahead bias, serve sapere, per ogni candela 4H al timestamp T,
quale fosse l'ultima feature matrix 1H disponibile **esattamente** a quel momento.

### Strategia: pre-fetch + lookup per timestamp

#### A) Setup: pre-fetch dei dati 1H prima del loop

```python
# In backtesting.py, nel setup prima del loop principale:
lgbm_1h, df_1h_indexed = None, None

if cfg.use_1h_lgbm_gate:
    path_1h = MODEL_DIR / "lgbm_1h_latest.pkl"
    if path_1h.exists():
        with open(path_1h, "rb") as f:
            payload_1h = pickle.load(f)
        lgbm_1h = payload_1h["model"]
        feats_1h = payload_1h["features"]

        # Fetch 1H per l'intero periodo del backtest (4× le candele 4H)
        df_1h_raw  = await hl.get_ohlcv(symbol, "1h", limit=n_candles * 4 + 512)
        df_1h_fund = await hl.get_funding_history(symbol, hours=n_candles * 4 + 512)
        df_1h_feat = build_all_features(df_1h_raw, df_1h_fund,
                                        pd.DataFrame(), pd.DataFrame())
        df_1h_feat = df_1h_feat.dropna().iloc[64:].reset_index(drop=False)

        # CRITICO: usa close_time (open_time + 1h) per evitare look-ahead bias
        # Ipotesi: colonna "time" in df_1h_feat è open_time della candela
        df_1h_feat["close_time"] = pd.to_datetime(df_1h_feat["time"]) + pd.Timedelta(hours=1)
        df_1h_feat = df_1h_feat.sort_values("close_time").reset_index(drop=True)
        df_1h_indexed = df_1h_feat  # usato nel loop
```

#### B) Loop: lookup per timestamp

```python
# Nel loop del backtest, all'inizio di ogni iterazione, derivare il close_time della
# candela 4H corrente (row.name è open_time — indice del DataFrame):
candle_close_time = row.name + pd.Timedelta(hours=4)

# Applicare il gate se il segnale è attivo:
if lgbm_1h is not None and df_1h_indexed is not None and pending_action != "no_trade":
    # Prendi l'ultima riga 1H con close_time <= candle_close_time
    mask = df_1h_indexed["close_time"] <= pd.Timestamp(candle_close_time)
    if mask.any():
        row_1h = df_1h_indexed[mask].iloc[[-1]]
        cols   = [c for c in feats_1h if c in row_1h.columns]
        row_1h[cols] = row_1h[cols].fillna(0)

        lgbm_1h_prob = float(lgbm_1h.predict_proba(row_1h[cols])[0, 1])

        # Stessa logica del live (sezione 4.B)
        if pending_action == "long":
            if lgbm_1h_prob < cfg.lgbm_1h_block_threshold:
                pending_action = "no_trade"
            elif lgbm_1h_prob < cfg.lgbm_1h_min_agreement:
                size_factor *= 0.70
        elif pending_action == "short":
            p_down = 1.0 - lgbm_1h_prob
            if p_down < cfg.lgbm_1h_block_threshold:
                pending_action = "no_trade"
            elif p_down < cfg.lgbm_1h_min_agreement:
                size_factor *= 0.70
```

#### C) Verifica look-ahead bias

Test da eseguire prima di considerare i risultati affidabili:
- Confrontare il risultato del backtest con `use_1h_lgbm_gate=True` vs `False`
- Se il gate migliora le metriche in modo **eccessivo** (>20% di Sharpe ratio), sospettare look-ahead bias
- Verificare manualmente un campione di trade: la candela 1H usata ha `close_time` ≤ `candle_open_time` della candela 4H?

#### Prerequisiti

1. Gate 1H live validato per ≥4-6 settimane
2. `lgbm_1h_latest.pkl` stabile (non retrained durante il periodo di test)
3. Verifica che Hyperliquid API ritorni dati 1H storici per il periodo del backtest
4. Test look-ahead bias come descritto sopra

---

## Riepilogo e checklist

| # | Miglioramento | Toggle/Param | File principali | Prerequisiti | Stima |
|---|--------------|-------------|-----------------|--------------|-------|
| 1 | Walk-forward aggressiva | `retrain_every_n_cycles`, `wf_n_splits`, `wf_purge_gap` | trainer.py, execution.py | Nessuno | 0.5 gg |
| 2 | Feature Pruning | `use_feature_pruning`, soglia | trainer.py, execution.py, backtesting.py | Nessuno | 1 gg |
| 3 | Calibrazione Isotonica | `use_chronos_calibration` | calibration.py (nuovo), trainer.py, chronos_model.py | ≥50 trade + SQL migration | 1.5 gg |
| 4 | Gate 1H (live) | `use_1h_lgbm_gate`, 2 soglie | trainer.py, execution.py | Sistema stabile | 2 gg |
| 5 | Gate 1H (backtest) | (stessi di #4) | backtesting.py | Gate live validato | 1 gg |

### Timeline consigliata

```
Settimana 1:  Implementa #1 (walk-forward parametrizzata) — modifica minima, zero rischio
Settimana 1:  Implementa #2 (feature pruning) — addestra e confronta full vs pruned
Settimane 2-4: Accumula trade nel DB con bot operativo
Settimana 4:  Implementa #3 (calibrazione) — se ≥50 trade disponibili
Mese 2:       Implementa #4 (gate 1H live) — dopo validazione del sistema base
Mese 3+:      Valuta #5 (gate 1H backtest) — solo se gate live mostra risultati positivi
```
