# Multi-Model Ensemble Upgrade

**Versione:** 2.0  
**Data:** 2026-05-16  
**Stato:** Pianificazione — pronto per implementazione

---

## Valutazione onesta: rischio/guadagno per fase

| Fase | Guadagno stimato | Rischio | Note |
|---|---|---|---|
| 1 — Composite score | +30-60% opportunità di trade; Sharpe +0.1-0.3 | Moderato: win rate cala ~3-5% sui trade aggiuntivi | Dipende dall'EV marginale dei trade ora bloccati |
| 2 — Adaptive sizing | +5-15% rendimento geometrico se modello calibrato | Basso-Moderato: LightGBM prob non è calibrato di default, rischio oversize | Mitigato dai cap conservativi 0.5x-1.5x |
| 3 — Purged walk-forward | Indiretto: tuning più accurato del modello | Nessuno — non cambia il live | Potrebbe rivelare che il modello è peggio di quanto stimato |
| 4 — Dynamic threshold | Marginale: ±3% win rate in regime forte/caotico | Basso | Attivo solo con composite_scoring_enabled=True |
| 5 — P10 SL Floor | R:R migliore su segnali forti; size auto-aumenta | Moderato: C2 errata sul downside → stoppato su size maggiore | Richiede Chronos-2 attivo; guard min ATR obbligatorio |
| 6 — Enhanced exit | Meno false uscite rispetto a LGBM solo | Basso: fallback automatico a LGBM-only se C2 assente | Modalità B non verificabile in backtest senza Chronos |
| 7 — TimesFM (opt.) | Diversità architetturale nell'ensemble LGBM | Basso-Medio: RAM VPS, comportamento non validabile pre-implementazione | Solo dopo 60gg validazione Fasi 1-6; VPS ≥ 8GB |

**Questi miglioramenti ottimizzano la consegna di un edge esistente. Non creano edge dal nulla.** Se il modello non ha vantaggio statistico reale nel mercato, nessuna di queste fasi lo genera. Se l'edge c'è, lo esprimono meglio.

**Su Moirai:** non è nel piano. Chronos-2 già fornisce `c2_uncertainty` via spread dei quantili (Q10/Q90) — Moirai darebbe un secondo parere sulla stessa metrica con alto costo RAM, gain marginale.

**Su TimesFM:** è nella Fase 7 (opzionale) come feature per LightGBM sulle candele 4h già esistenti — non richiede nuovi WebSocket né riscrittura della data pipeline.

---

## Architettura dei toggle

Il progetto usa già un pattern collaudato: i toggle sono campi `bool` nel `BotConfig` Pydantic di `main.py`, propagati automaticamente via `PUT /bot` e `PUT /bot/backtest`, letti in `execution.py`, `decision.py`, `backtesting.py`. Lo stesso meccanismo gestisce già `adx_gate_enabled`, `sweep_gate_enabled`, `c2_uncertainty_gate_enabled`, ecc.

**Tre nuovi toggle:**

| Toggle | Campo | Default | Dove agisce |
|---|---|---|---|
| Composite score | `composite_scoring_enabled` | `False` | `decision.py` → `DecisionEngine` |
| Adaptive sizing | `adaptive_sizing_enabled` | `False` | `risk.py` → `RiskManager` |
| Dynamic threshold | `dynamic_threshold_enabled` | `False` | `decision.py` → `DecisionEngine` (solo con `composite_scoring_enabled=True`) |

Default a `False` su tutti: il comportamento esistente rimane invariato finché non vengono abilitati esplicitamente. Questo garantisce un A/B test pulito tra le due modalità.

---

## Fase 1 — Composite score (sostituisce gate cascade)

### Contesto del problema

`decision.py` ha 5 gate sequenziali hard-coded. Ogni gate ha circa 70-80% di pass rate. Combinati: `0.75 × 0.85 × 0.70 × 0.50 ≈ 22%` dei setup raggiungono il threshold finale. Il sistema rifiuta ~78% delle opportunità prima che l'ensemble abbia voce in capitolo. LightGBM ha già ADX tra le feature di training — il gate hard sull'ADX è in parte ridondante con ciò che il modello ha già imparato.

### File: `apps/api/main.py` — BotConfig Pydantic

Aggiungere dopo `dynamic_sl_tp_blend`:

```python
# ── Ensemble upgrade toggles ──────────────────────────────────────────────────
composite_scoring_enabled: bool = Field(False)
adaptive_sizing_enabled: bool = Field(False)
dynamic_threshold_enabled: bool = Field(False)
# Pesi del composite score (usati solo se composite_scoring_enabled = True)
composite_regime_weight: float = Field(0.30, ge=0.0, le=1.0)
composite_timing_weight: float = Field(0.35, ge=0.0, le=1.0)
composite_liquidity_weight: float = Field(0.20, ge=0.0, le=1.0)
composite_uncertainty_weight: float = Field(0.15, ge=0.0, le=1.0)
composite_threshold: float = Field(0.55, ge=0.40, le=0.75)
# Adaptive sizing range (usato solo se adaptive_sizing_enabled = True)
adaptive_size_min_mult: float = Field(0.5, ge=0.2, le=1.0)
adaptive_size_max_mult: float = Field(1.5, ge=1.0, le=2.5)
```

### File: `apps/api/services/execution.py` — BotConfig dataclass

Aggiungere nel `__init__` di `BotConfig`:

```python
# ── Ensemble upgrade toggles ──────────────────────────────────────────────────
self.composite_scoring_enabled    = kw.get("composite_scoring_enabled",    False)
self.adaptive_sizing_enabled      = kw.get("adaptive_sizing_enabled",      False)
self.dynamic_threshold_enabled    = kw.get("dynamic_threshold_enabled",    False)
self.composite_regime_weight      = kw.get("composite_regime_weight",      0.30)
self.composite_timing_weight      = kw.get("composite_timing_weight",      0.35)
self.composite_liquidity_weight   = kw.get("composite_liquidity_weight",   0.20)
self.composite_uncertainty_weight = kw.get("composite_uncertainty_weight", 0.15)
self.composite_threshold          = kw.get("composite_threshold",          0.55)
self.adaptive_size_min_mult       = kw.get("adaptive_size_min_mult",       0.5)
self.adaptive_size_max_mult       = kw.get("adaptive_size_max_mult",       1.5)
```

### File: `apps/api/services/decision.py` — DecisionEngine

Aggiungere i parametri al `__init__`:

```python
def __init__(
    self,
    # ... parametri esistenti ...
    composite_scoring_enabled: bool = False,
    dynamic_threshold_enabled: bool = False,
    composite_regime_weight: float = 0.30,
    composite_timing_weight: float = 0.35,
    composite_liquidity_weight: float = 0.20,
    composite_uncertainty_weight: float = 0.15,
    composite_threshold: float = 0.55,
):
    # ... assegnazioni esistenti ...
    self.composite_scoring_enabled    = composite_scoring_enabled
    self.dynamic_threshold_enabled    = dynamic_threshold_enabled
    self.composite_regime_weight      = composite_regime_weight
    self.composite_timing_weight      = composite_timing_weight
    self.composite_liquidity_weight   = composite_liquidity_weight
    self.composite_uncertainty_weight = composite_uncertainty_weight
    self.composite_threshold          = composite_threshold
```

Aggiungere il metodo `_compute_composite_score`:

```python
def _compute_composite_score(
    self,
    features: dict,
    c2_output: dict,
    lgbm_prob: float,
    confluence_score: Optional[float] = None,
) -> tuple[float, float, float, list[str]]:
    """
    Restituisce (composite_score, ensemble_prob, regime_score, reasoning).
    composite_score: 0–1, normalizzato per la somma dei pesi.
    ensemble_prob:   probabilità direzionale pesata C2+LGBM.
    regime_score:    componente regime pura [0,1], usata da _dynamic_threshold.
    """
    reasoning = []
    adx         = features.get("adx_14", 0.0)
    d_regime    = features.get("d_regime", 0)
    sweep       = features.get("sweep", 0.0)
    fvg_bear    = features.get("fvg_bear", 0.0)
    fvg_bull    = features.get("fvg_bull", 0.0)
    dir_prob    = c2_output.get("c2_dir_prob", 0.5)
    c2_unc      = c2_output.get("c2_uncertainty", 0.0)
    c2_cont     = c2_output.get("c2_cont_prob", 1.0)

    # Regime score: ADX normalizzato + conferma daily regime
    adx_norm      = min(adx / 50.0, 1.0)
    regime_bonus  = 0.10 if d_regime != 0 else 0.0
    regime_score  = min(adx_norm + regime_bonus, 1.0)

    # Timing score: quanto lontano dal neutro è l'ensemble
    lgbm_w         = 1.0 - self.chronos_weight
    ensemble_prob  = lgbm_w * lgbm_prob + self.chronos_weight * dir_prob
    timing_score   = abs(ensemble_prob - 0.5) * 2.0  # [0,1]

    # Liquidity score: sweep e FVG avversi diventano penalità, non blocchi
    liq_penalty    = 0.50 if sweep == 1.0 else 0.0
    if ensemble_prob > 0.5 and fvg_bear == 1.0:
        liq_penalty = max(liq_penalty, 0.35)
    elif ensemble_prob < 0.5 and fvg_bull == 1.0:
        liq_penalty = max(liq_penalty, 0.35)
    liquidity_score = max(1.0 - liq_penalty, 0.0)

    # Confluence SMC: incorporata nel liquidity_score (0-100 → 0-1)
    # Evita di ignorare silenziosamente il segnale già calcolato dal sistema.
    if confluence_score is not None:
        conf_norm       = min(confluence_score / 100.0, 1.0)
        liquidity_score = liquidity_score * 0.70 + conf_norm * 0.30

    # Uncertainty score: bassa incertezza C2 = score alto
    unc_ref = self.c2_uncertainty_threshold if self.c2_uncertainty_threshold > 0 else 0.05
    uncertainty_score = max(1.0 - (c2_unc / unc_ref), 0.0) if c2_unc > 0 else 1.0
    if self.c2_cont_prob_gate_enabled and c2_cont > 0:
        uncertainty_score = uncertainty_score * 0.7 + (c2_cont) * 0.3

    raw = (
        self.composite_regime_weight      * regime_score +
        self.composite_timing_weight      * timing_score +
        self.composite_liquidity_weight   * liquidity_score +
        self.composite_uncertainty_weight * uncertainty_score
    )

    # ⚠️ Normalizzazione obbligatoria: i pesi sono configurabili dall'utente
    # e potrebbero non sommare a 1.0. Senza normalizzazione il composite
    # esce dal range [0,1] e il threshold check collassa.
    weight_sum = (
        self.composite_regime_weight + self.composite_timing_weight +
        self.composite_liquidity_weight + self.composite_uncertainty_weight
    )
    composite = raw / weight_sum if weight_sum > 0 else 0.0

    reasoning.append(
        f"Composite={composite:.3f} "
        f"(regime={regime_score:.2f}×{self.composite_regime_weight:.2f}, "
        f"timing={timing_score:.2f}×{self.composite_timing_weight:.2f}, "
        f"liq={liquidity_score:.2f}×{self.composite_liquidity_weight:.2f}, "
        f"uncert={uncertainty_score:.2f}×{self.composite_uncertainty_weight:.2f}, "
        f"weights_sum={weight_sum:.2f})"
    )

    return composite, ensemble_prob, regime_score, reasoning
```

Modificare il metodo `decide` per usare il composite quando abilitato:

```python
def decide(self, features, c2_output, lgbm_prob, confluence_score=None, current_price=0.0):
    reasoning = []

    if self.composite_scoring_enabled:
        # ── MODALITÀ COMPOSITE SCORE ──────────────────────────────────────────
        composite, ensemble_prob, regime_score, comp_reasoning = self._compute_composite_score(
            features, c2_output, lgbm_prob, confluence_score
        )
        reasoning.extend(comp_reasoning)

        # Dynamic threshold: usa regime_score (non composite) per evitare
        # doppia penalità sull'uncertainty già contenuta nel composite stesso.
        threshold = self._dynamic_threshold(
            self.directional_threshold,
            regime_score,                           # ← regime puro, non composite
            c2_output.get("c2_uncertainty", 0.0),
        ) if self.dynamic_threshold_enabled else self.composite_threshold

        reasoning.append(f"Threshold={threshold:.3f} (dynamic={self.dynamic_threshold_enabled})")

        p10 = c2_output.get("c2_p10", current_price)
        p50 = c2_output.get("c2_p50", current_price)
        p90 = c2_output.get("c2_p90", current_price)
        c2_unc = c2_output.get("c2_uncertainty", 0.0)

        if composite < threshold:
            reasoning.append(f"NO-TRADE: composite {composite:.3f} < threshold {threshold:.3f}")
            return self._no_trade(reasoning, c2_output.get("c2_dir_prob", 0.5), p10, p50, p90, features, c2_unc)

        # Direzione dal segnale ensemble
        if ensemble_prob >= 0.5:
            reasoning.append(f"LONG: composite={composite:.3f}, P(up)={ensemble_prob:.3f}")
            return DecisionResult(
                action="long", confidence=composite, reasoning=reasoning,
                features_snapshot=features, directional_prob=c2_output.get("c2_dir_prob", 0.5),
                forecast_p10=p10, forecast_p50=p50, forecast_p90=p90, forecast_uncertainty=c2_unc,
            )
        else:
            reasoning.append(f"SHORT: composite={composite:.3f}, P(down)={1-ensemble_prob:.3f}")
            return DecisionResult(
                action="short", confidence=composite, reasoning=reasoning,
                features_snapshot=features, directional_prob=c2_output.get("c2_dir_prob", 0.5),
                forecast_p10=p10, forecast_p50=p50, forecast_p90=p90, forecast_uncertainty=c2_unc,
            )

    else:
        # ── MODALITÀ CLASSICA (gate cascade — comportamento invariato) ────────
        # Nota: dynamic_threshold_enabled non ha effetto in modalità classica.
        # ... codice decide() esistente invariato ...
```

### Passaggio dei parametri da execution.py a DecisionEngine

Nel punto di `execution.py` dove viene istanziato `DecisionEngine` (dentro il ciclo del bot), aggiungere i nuovi parametri:

```python
decision_engine = DecisionEngine(
    # ... parametri esistenti ...
    composite_scoring_enabled=cfg.composite_scoring_enabled,
    dynamic_threshold_enabled=cfg.dynamic_threshold_enabled,
    composite_regime_weight=cfg.composite_regime_weight,
    composite_timing_weight=cfg.composite_timing_weight,
    composite_liquidity_weight=cfg.composite_liquidity_weight,
    composite_uncertainty_weight=cfg.composite_uncertainty_weight,
    composite_threshold=cfg.composite_threshold,
)
```

### File: `apps/api/services/backtesting.py`

Aggiungere la lettura dei nuovi flag insieme agli altri `getattr`:

```python
composite_scoring_enabled    = getattr(cfg, "composite_scoring_enabled",    False)
dynamic_threshold_enabled    = getattr(cfg, "dynamic_threshold_enabled",    False)
composite_regime_weight      = getattr(cfg, "composite_regime_weight",      0.30)
composite_timing_weight      = getattr(cfg, "composite_timing_weight",      0.35)
composite_liquidity_weight   = getattr(cfg, "composite_liquidity_weight",   0.20)
composite_uncertainty_weight = getattr(cfg, "composite_uncertainty_weight", 0.15)
composite_threshold          = getattr(cfg, "composite_threshold",          0.55)
```

E aggiornare la costruzione di `DecisionEngine` nel backtest allo stesso modo di `execution.py`.

---

## Fase 2 — Adaptive sizing (confidence-proporzionale)

### Avvertenza tecnica importante

LightGBM probability outputs non sono calibrati per default — il modello può restituire 0.72 quando il win rate reale a quella soglia è 0.58. Per questo il range è conservativo (0.5x-1.5x). I limiti esistenti `max_daily_dd_pct` e `max_consecutive_losses` proteggono il downside.

### ⚠️ Interazione con `dynamic_sl_tp_enabled`

`dynamic_sl_tp_enabled` ha già il proprio scaling basato su `c2_uncertainty` in `risk.py` (righe 90-98 del codice attuale: da 1.20× ad alta confidenza fino a 0.50× ad alta incertezza). Se `adaptive_sizing_enabled` aggiungesse la propria penalità di uncertainty senza verificare, i due moltiplicatori si sommerebbero silenziosamente:

- `dynamic_sl_tp` con alta incertezza → `size_mult = 0.50`
- `adaptive_sizing` penalità -30% → `× 0.70`
- Risultato finale: **0.35× del size base**, invisibile all'utente

**Fix implementato:** la penalità uncertainty di `adaptive_sizing` viene saltata quando `dynamic_sl_tp_enabled = True`. Il parametro `dynamic_sl_tp_enabled` viene passato a `calculate_trade_params` già nella firma esistente — basta leggerlo.

### File: `apps/api/services/risk.py` — RiskManager

Aggiungere al `__init__`:

```python
def __init__(
    self,
    sl_atr_mult: float = 2.0,
    tp_atr_mult: float = 3.5,
    position_size_pct: float = 1.5,
    max_daily_dd_pct: float = 3.0,
    max_consecutive_losses: int = 4,
    adaptive_sizing_enabled: bool = False,      # nuovo
    adaptive_size_min_mult: float = 0.5,        # nuovo
    adaptive_size_max_mult: float = 1.5,        # nuovo
):
    # ... esistenti ...
    self.adaptive_sizing_enabled  = adaptive_sizing_enabled
    self.adaptive_size_min_mult   = adaptive_size_min_mult
    self.adaptive_size_max_mult   = adaptive_size_max_mult
```

Modificare `calculate_trade_params` per accettare e usare il signal score:

```python
def calculate_trade_params(
    self,
    side: Side,
    entry_price: float,
    atr: float,
    equity_usd: float,
    signal_score: float = 0.5,        # composite_score o confidence dal DecisionResult
    c2_uncertainty: float = 0.0,
    c2_p10: Optional[float] = None,
    c2_p90: Optional[float] = None,
) -> TradeParams:

    if self.adaptive_sizing_enabled:
        # signal_score è [0,1]; mappiamo [0.5,1.0] → [min_mult, max_mult]
        score_norm    = max(0.5, min(signal_score, 1.0))
        size_mult     = self.adaptive_size_min_mult + (score_norm - 0.5) * 2.0 * (
                            self.adaptive_size_max_mult - self.adaptive_size_min_mult
                        )
        # ⚠️ Penalità uncertainty: applicata SOLO se dynamic_sl_tp NON è attivo.
        # Se dynamic_sl_tp è già attivo applica il proprio scaling (0.50–1.20×
        # in risk.py righe 90-98). Sommare entrambi produrrebbe una doppia
        # penalità moltiplicativa non intenzionale (es. 0.50 × 0.70 = 0.35×).
        if not dynamic_sl_tp_enabled:
            unc_ref     = 0.05
            unc_penalty = min((c2_uncertainty / unc_ref) * 0.30, 0.30) if c2_uncertainty > 0 else 0.0
            size_mult   = size_mult * (1.0 - unc_penalty)
        # Hard floor/cap di sicurezza
        size_mult     = max(self.adaptive_size_min_mult, min(size_mult, self.adaptive_size_max_mult))
        effective_pct = self.position_size_pct * size_mult
    else:
        effective_pct = self.position_size_pct

    size_usd = equity_usd * (effective_pct / 100.0)
    # ... resto del calcolo invariato ...
```

### Propagazione del signal_score

In `execution.py`, passare `decision.confidence` a `risk.calculate_trade_params`:

```python
trade_params = risk.calculate_trade_params(
    side=decision.action,
    entry_price=current_price,
    atr=atr,
    equity_usd=equity,
    signal_score=decision.confidence,       # nuovo
    c2_uncertainty=decision.forecast_uncertainty,
    c2_p10=decision.forecast_p10,
    c2_p90=decision.forecast_p90,
)
```

In `backtesting.py`, costruire `RiskManager` con i nuovi parametri:

```python
adaptive_sizing_enabled = getattr(cfg, "adaptive_sizing_enabled",  False)
adaptive_size_min_mult  = getattr(cfg, "adaptive_size_min_mult",   0.5)
adaptive_size_max_mult  = getattr(cfg, "adaptive_size_max_mult",   1.5)

risk = RiskManager(
    sl_atr_mult=sl_atr_mult,
    tp_atr_mult=tp_atr_mult,
    position_size_pct=pos_size_pct,
    adaptive_sizing_enabled=adaptive_sizing_enabled,
    adaptive_size_min_mult=adaptive_size_min_mult,
    adaptive_size_max_mult=adaptive_size_max_mult,
)
```

E nel loop di backtest, passare il signal_score al calcolo del trade:

```python
tp = risk.calculate_trade_params(
    side=result.action,
    entry_price=close_price,
    atr=atr,
    equity_usd=equity,
    signal_score=result.confidence,          # aggiunto
    c2_uncertainty=result.forecast_uncertainty,
)
```

---

## Fase 3 — Purged walk-forward retraining (zero rischio live)

### File: `apps/api/services/trainer.py`

Sostituire il blocco "step 4. Temporal split" con la funzione seguente:

```python
def _walk_forward_splits(
    X: pd.DataFrame,
    y: pd.Series,
    n_splits: int = 5,
    purge_gap: int = 5,
) -> list[dict]:
    """
    Expanding window walk-forward con purge gap.
    purge_gap: candles escluse prima del validation set per eliminare
    autocorrelazione temporale (look-ahead bias su serie finanziarie).
    """
    n         = len(X)
    min_train = int(n * 0.40)
    step      = max(1, (n - min_train - purge_gap * n_splits) // n_splits)
    results   = []

    for i in range(n_splits):
        train_end = min_train + i * step
        val_start = train_end + purge_gap
        val_end   = min(val_start + step, n)
        if val_end <= val_start or train_end >= n:
            break

        X_tr  = X.iloc[:train_end]
        y_tr  = y.iloc[:train_end]
        X_val = X.iloc[val_start:val_end]
        y_val = y.iloc[val_start:val_end]

        m = lgb.LGBMClassifier(**_LGB_PARAMS)
        m.fit(X_tr, y_tr,
              eval_set=[(X_val, y_val)],
              callbacks=[lgb.early_stopping(50, verbose=False), lgb.log_evaluation(0)])

        y_prob = m.predict_proba(X_val)[:, 1]
        results.append({
            "fold":      i,
            "train_n":   len(X_tr),
            "val_n":     len(X_val),
            "log_loss":  float(log_loss(y_val, y_prob)),
            "accuracy":  float(accuracy_score(y_val, (y_prob > 0.5).astype(int))),
        })

    return results
```

Nella funzione `_run`, sostituire lo split 80/20 con:

```python
# ── 4. Purged walk-forward CV (solo per stima OOS reale) ─────────────────
wf_results = _walk_forward_splits(X, y, n_splits=5, purge_gap=5)
wf_ll   = float(np.mean([r["log_loss"]  for r in wf_results])) if wf_results else None
wf_acc  = float(np.mean([r["accuracy"]  for r in wf_results])) if wf_results else None
log.info("Walk-forward CV: avg_log_loss=%.4f avg_acc=%.4f", wf_ll or 0, wf_acc or 0)

# ── 5. Train finale su tutto il dataset (come prima) ─────────────────────
# Split 80/20 rimane solo per early stopping del modello finale
split   = int(len(X) * 0.80)
X_tr, X_val = X.iloc[:split], X.iloc[split:]
y_tr, y_val = y.iloc[:split], y.iloc[split:]

model = lgb.LGBMClassifier(**_LGB_PARAMS)
model.fit(X_tr, y_tr,
          eval_set=[(X_val, y_val)],
          callbacks=[lgb.early_stopping(50, verbose=False), lgb.log_evaluation(0)])
```

E aggiungere le metriche walk-forward alla risposta:

```python
return {
    # ... metriche esistenti ...
    "wf_log_loss": wf_ll,
    "wf_accuracy": wf_acc,
    "wf_folds":    wf_results,
}
```

---

## Fase 4 — Dynamic threshold (bassa complessità)

Aggiungere il metodo a `DecisionEngine` in `decision.py`:

```python
def _dynamic_threshold(
    self, base: float, regime_score: float, c2_uncertainty: float
) -> float:
    """
    Regime forte (score alto, incertezza bassa) → threshold si abbassa → più trade.
    Regime caotico → threshold si alza → meno trade.
    Range di aggiustamento: ±0.03 (conservativo).
    """
    regime_adj  = (regime_score - 0.5) * 0.06    # [-0.03, +0.03]
    unc_ref     = self.c2_uncertainty_threshold if self.c2_uncertainty_threshold > 0 else 0.05
    unc_adj     = min(c2_uncertainty / unc_ref, 1.0) * 0.04   # [0, +0.04]
    adjusted    = base - regime_adj + unc_adj
    return max(0.52, min(adjusted, 0.75))
```

Viene chiamato nella logica composite quando `dynamic_threshold_enabled=True`.

**⚠️ Limitazione importante:** `dynamic_threshold_enabled` è implementato **solo nella modalità composite**. Se abilitato senza `composite_scoring_enabled=True`, non produce nessun effetto — il sistema continua a usare il threshold fisso della modalità classica senza segnalarlo. Questo comportamento silenzioso deve essere comunicato all'utente.

L'aggiustamento del `MTF alignment bonus` esistente nella modalità classica (`effective_threshold -= 0.02`) rimane invariato e separato. Non viene toccato da questo toggle.

---

## Frontend — `apps/web/components/trading-hub/BotConfig.tsx`

### Aggiornare l'interfaccia `Config`

```typescript
interface Config {
  // ... campi esistenti ...
  composite_scoring_enabled: boolean;
  adaptive_sizing_enabled: boolean;
  dynamic_threshold_enabled: boolean;
  composite_regime_weight: number;
  composite_timing_weight: number;
  composite_liquidity_weight: number;
  composite_uncertainty_weight: number;
  composite_threshold: number;
  adaptive_size_min_mult: number;
  adaptive_size_max_mult: number;
}
```

### Aggiornare `DEFAULTS`

```typescript
const DEFAULTS: Config = {
  // ... esistenti ...
  composite_scoring_enabled: false,
  adaptive_sizing_enabled: false,
  dynamic_threshold_enabled: false,
  composite_regime_weight: 0.30,
  composite_timing_weight: 0.35,
  composite_liquidity_weight: 0.20,
  composite_uncertainty_weight: 0.15,
  composite_threshold: 0.55,
  adaptive_size_min_mult: 0.5,
  adaptive_size_max_mult: 1.5,
};
```

### Nuova sezione UI — "Ensemble Avanzato"

Da inserire dopo la sezione "Impostazioni Chronos-2", seguendo esattamente il pattern dei toggle esistenti:

```tsx
<Section
  title="Ensemble Avanzato"
  description="Modalità sperimentali per ottimizzare la selezione dei segnali. Disabilita per tornare al comportamento classico con gate sequenziali."
>
  {/* ── Composite Score Toggle ── */}
  <div className={`flex flex-col gap-3 mb-6 pb-6 border-b transition-colors duration-200 ${config.composite_scoring_enabled ? 'border-violet-200 dark:border-violet-500/25' : 'border-slate-100 dark:border-white/5'}`}>
    <Tooltip
      text="Sostituisce i gate sequenziali hard-coded con un punteggio composito continuo. Ogni condizione contribuisce al punteggio invece di bloccare completamente. Aumenta la frequenza di trade mantenendo la selettività."
      width="wide" pos="bottom"
    >
      <label className="flex items-center gap-3 cursor-pointer group">
        <div className="relative">
          <input type="checkbox" className="sr-only"
            checked={config.composite_scoring_enabled}
            onChange={e => setConfig(c => ({ ...c, composite_scoring_enabled: e.target.checked }))}
          />
          <div className={`w-10 h-5 rounded-full transition-all duration-300 ${config.composite_scoring_enabled ? 'bg-violet-600' : 'bg-slate-200 dark:bg-white/10'}`} />
          <div className={`absolute top-1 left-1 w-3 h-3 bg-white rounded-full shadow-sm transition-transform duration-300 ${config.composite_scoring_enabled ? 'translate-x-5' : ''}`} />
        </div>
        <div>
          <p className={`text-sm font-bold transition-colors ${config.composite_scoring_enabled ? 'text-violet-600 dark:text-violet-400' : 'text-slate-800 dark:text-slate-200 group-hover:text-violet-600 dark:group-hover:text-violet-400'}`}>
            Composite Score
            {config.composite_scoring_enabled && (
              <span className="ml-2 px-1.5 py-0.5 rounded text-[9px] font-bold bg-violet-100 dark:bg-violet-500/20 text-violet-600 dark:text-violet-400 uppercase tracking-wider">Attivo</span>
            )}
          </p>
          <p className="text-[11px] font-medium text-slate-400 dark:text-slate-500 leading-tight">
            {config.composite_scoring_enabled
              ? 'Gate sequenziali disabilitati — punteggio ponderato continuo attivo'
              : 'Attiva per usare un punteggio continuo al posto dei gate hard-coded'}
          </p>
        </div>
      </label>
    </Tooltip>

    {config.composite_scoring_enabled && (
      <div className="pl-12 flex flex-col gap-4">
        <NumInput label="Threshold composito" value={config.composite_threshold} min={0.40} max={0.75} step={0.01} onChange={upd('composite_threshold')} />
        <div className="grid grid-cols-2 gap-4">
          <NumInput label="Peso Regime" value={config.composite_regime_weight} min={0} max={1} step={0.05} onChange={upd('composite_regime_weight')} />
          <NumInput label="Peso Timing" value={config.composite_timing_weight} min={0} max={1} step={0.05} onChange={upd('composite_timing_weight')} />
          <NumInput label="Peso Liquidità" value={config.composite_liquidity_weight} min={0} max={1} step={0.05} onChange={upd('composite_liquidity_weight')} />
          <NumInput label="Peso Uncertainty" value={config.composite_uncertainty_weight} min={0} max={1} step={0.05} onChange={upd('composite_uncertainty_weight')} />
        </div>

        {/* ⚠️ Warning somma pesi */}
        {(() => {
          const wsum = config.composite_regime_weight + config.composite_timing_weight +
                       config.composite_liquidity_weight + config.composite_uncertainty_weight;
          return Math.abs(wsum - 1.0) > 0.05 ? (
            <div className="flex items-start gap-3 bg-amber-50 dark:bg-amber-500/10 border border-amber-200 dark:border-amber-500/30 rounded-xl px-4 py-3">
              <svg className="w-4 h-4 text-amber-500 flex-shrink-0 mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" />
              </svg>
              <div>
                <p className="text-[11px] font-bold text-amber-700 dark:text-amber-400 uppercase tracking-wide">
                  Somma pesi: {wsum.toFixed(2)} (consigliato: 1.00)
                </p>
                <p className="text-[11px] text-amber-600 dark:text-amber-500 leading-snug mt-0.5">
                  Il composite score viene normalizzato automaticamente, ma pesi molto sbilanciati riducono la leggibilità del reasoning nel log.
                </p>
              </div>
            </div>
          ) : null;
        })()}

        {/* ── Dynamic Threshold sub-toggle ── */}
        <label className="flex items-center gap-3 cursor-pointer group mt-2">
          <div className="relative">
            <input type="checkbox" className="sr-only"
              checked={config.dynamic_threshold_enabled}
              onChange={e => setConfig(c => ({ ...c, dynamic_threshold_enabled: e.target.checked }))}
            />
            <div className={`w-8 h-4 rounded-full transition-all duration-300 ${config.dynamic_threshold_enabled ? 'bg-indigo-500' : 'bg-slate-200 dark:bg-white/10'}`} />
            <div className={`absolute top-0.5 left-0.5 w-3 h-3 bg-white rounded-full shadow-sm transition-transform duration-300 ${config.dynamic_threshold_enabled ? 'translate-x-4' : ''}`} />
          </div>
          <p className="text-[11px] font-bold text-slate-600 dark:text-slate-400">
            Threshold dinamico per regime
            <span className="ml-1 font-normal text-slate-400">(abbassa in trend, alza in caos)</span>
          </p>
        </label>
      </div>
    )}
  </div>

  {/* ── Adaptive Sizing Toggle ── */}
  <div className="flex flex-col gap-3">
    <Tooltip
      text="La dimensione della posizione scala proporzionalmente alla confidence del segnale (0.5×–1.5× il size base). Segnali forti con bassa incertezza C2 ricevono size maggiore."
      width="wide" pos="bottom"
    >
      <label className="flex items-center gap-3 cursor-pointer group">
        <div className="relative">
          <input type="checkbox" className="sr-only"
            checked={config.adaptive_sizing_enabled}
            onChange={e => setConfig(c => ({ ...c, adaptive_sizing_enabled: e.target.checked }))}
          />
          <div className={`w-10 h-5 rounded-full transition-all duration-300 ${config.adaptive_sizing_enabled ? 'bg-violet-600' : 'bg-slate-200 dark:bg-white/10'}`} />
          <div className={`absolute top-1 left-1 w-3 h-3 bg-white rounded-full shadow-sm transition-transform duration-300 ${config.adaptive_sizing_enabled ? 'translate-x-5' : ''}`} />
        </div>
        <div>
          <p className={`text-sm font-bold transition-colors ${config.adaptive_sizing_enabled ? 'text-violet-600 dark:text-violet-400' : 'text-slate-800 dark:text-slate-200 group-hover:text-violet-600 dark:group-hover:text-violet-400'}`}>
            Adaptive Sizing
            {config.adaptive_sizing_enabled && (
              <span className="ml-2 px-1.5 py-0.5 rounded text-[9px] font-bold bg-violet-100 dark:bg-violet-500/20 text-violet-600 dark:text-violet-400 uppercase tracking-wider">Attivo</span>
            )}
          </p>
          <p className="text-[11px] font-medium text-slate-400 dark:text-slate-500 leading-tight">
            {config.adaptive_sizing_enabled
              ? `Size: ${config.adaptive_size_min_mult}×–${config.adaptive_size_max_mult}× in base alla confidence del segnale`
              : 'Attiva per scalare il position size in base alla qualità del segnale'}
          </p>
        </div>
      </label>
    </Tooltip>

    {config.adaptive_sizing_enabled && (
      <div className="pl-12 grid grid-cols-2 gap-4">
        <NumInput label="Size minima (×)" value={config.adaptive_size_min_mult} min={0.2} max={1.0} step={0.1} onChange={upd('adaptive_size_min_mult')} />
        <NumInput label="Size massima (×)" value={config.adaptive_size_max_mult} min={1.0} max={2.5} step={0.1} onChange={upd('adaptive_size_max_mult')} />
      </div>
    )}
  </div>
</Section>
```

---

## Fase 5 — P10 SL Floor (vincolo intelligente sullo Stop Loss)

### Meccanismo

Chronos-2 produce una distribuzione di forecast: p10, p50, p90. Il p10 per un long rappresenta il 10° percentile della distribuzione di prezzo attesa — dove il modello stima che il prezzo difficilmente scenderà. Il p90 per un short è il corrispettivo al rialzo.

**L'idea:** se C2 prevede che il prezzo non scenderà sotto 95.000 (p10=95k) ma il tuo SL da ATR sarebbe a 93.000, c'è uno spazio di 2.000 punti di SL "inutile". Il P10 floor tira il SL su a 95.000, stringe il rischio, e — dato che il sistema usa risk-based sizing (`size_usd = risk_usd / sl_pct`) — la dimensione della posizione aumenta automaticamente di conseguenza a parità di capitale a rischio.

**Regola fondamentale:** il floor si applica **solo se stringe** il SL, mai se lo allarga.

```
Long: stop_loss  = max(entry - sl_dist, c2_p10)   ← SL tende verso entry
Short: stop_loss = min(entry + sl_dist, c2_p90)   ← SL tende verso entry
```

Se p10 è già sotto il SL da ATR (C2 prevede un downside maggiore), si mantiene il SL originale.

### Effetto sul sizing — punto critico

Dato che `risk.py` usa:
```python
size_usd = risk_usd / sl_pct    # sl_pct = sl_dist / entry_price
```
Una riduzione di `sl_dist` riduce `sl_pct` e aumenta automaticamente `size_usd`. Questo è matematicamente corretto (Kelly): stessa perdita massima, posizione più grande. Ma se il SL viene stretto molto e C2 era errata sul downside, si viene stoppati su una posizione più grande. Per questo serve il **guard sul size massimo** e il **guard sulla distanza minima**.

### Interazione con `dynamic_sl_tp_enabled`

Le due feature usano entrambe p10/p90 ma con meccanismi diversi:
- `dynamic_sl_tp_enabled`: **blende** ATR e distanza C2 (`(1-blend)*ATR_dist + blend*C2_dist`)
- `p10_sl_floor_enabled`: **vincola** il livello SL finale a non superare p10/p90

Possono coesistere: `dynamic_sl_tp` calcola `sl_dist`, poi `p10_sl_floor` lo stringe ulteriormente se p10 è sopra il livello risultante. Tuttavia, la combinazione può produrre SL molto aggressivi su segnali forti. Aggiungere un warning in UI.

### Guard di sicurezza

Tre guard obbligatori prima di applicare il floor:

1. **Validità dei dati C2**: `c2_p10` deve essere non-None, > 0, e < `entry_price` per un long (altrimenti p10 non ha senso come floor). In backtest con Chronos disabilitato `c2_p10 == entry_price`, quindi il guard di `c2_p10 < entry_price` impedisce automaticamente l'applicazione.

2. **Distanza minima SL**: dopo il floor, `sl_dist` non può essere inferiore a `p10_sl_floor_min_atr_mult × atr`. Default: 1.0×ATR. Previene SL così stretti da essere colpiti dal normale market noise su 4h.

3. **Cap implicito sul size**: il sizing auto-aumenta con SL più stretto. I guard esistenti `max_daily_dd_pct` e `max_consecutive_losses` coprono il downside. Non è necessario un cap esplicito aggiuntivo dato il floor minimo ATR.

---

### File: `apps/api/main.py` — BotConfig Pydantic

Aggiungere con gli altri ensemble upgrade toggles:

```python
p10_sl_floor_enabled: bool = Field(False)
p10_sl_floor_min_atr_mult: float = Field(1.0, ge=0.5, le=2.0)
```

---

### File: `apps/api/services/execution.py` — BotConfig dataclass

```python
self.p10_sl_floor_enabled       = kw.get("p10_sl_floor_enabled",       False)
self.p10_sl_floor_min_atr_mult  = kw.get("p10_sl_floor_min_atr_mult",  1.0)
```

---

### File: `apps/api/services/risk.py` — RiskManager

Aggiungere al `__init__`:

```python
def __init__(
    self,
    sl_atr_mult: float = 2.0,
    tp_atr_mult: float = 3.5,
    position_size_pct: float = 1.5,
    max_daily_dd_pct: float = 3.0,
    max_consecutive_losses: int = 4,
    adaptive_sizing_enabled: bool = False,
    adaptive_size_min_mult: float = 0.5,
    adaptive_size_max_mult: float = 1.5,
    p10_sl_floor_enabled: bool = False,        # nuovo
    p10_sl_floor_min_atr_mult: float = 1.0,   # nuovo
):
    # ... esistenti ...
    self.p10_sl_floor_enabled      = p10_sl_floor_enabled
    self.p10_sl_floor_min_atr_mult = p10_sl_floor_min_atr_mult
```

Aggiungere il parametro `p10_sl_floor_enabled` alla firma di `calculate_trade_params` (già riceve `c2_p10` e `c2_p90`):

```python
def calculate_trade_params(
    self,
    side: Side,
    entry_price: float,
    atr: float,
    equity_usd: float,
    c2_p10: Optional[float] = None,
    c2_p90: Optional[float] = None,
    c2_uncertainty: Optional[float] = None,
    dynamic_sl_tp_enabled: bool = False,
    dynamic_sl_tp_blend: float = 0.50,
    signal_score: float = 0.5,
    p10_sl_floor_enabled: bool = False,      # nuovo — usa self se non passato
) -> TradeParams:
```

Inserire il blocco del floor **dopo** il calcolo di `sl_dist` (riga ~86 del codice attuale, dopo il blocco `if dynamic_sl_tp_enabled ... else ...`) e **prima** del calcolo del `stop_loss` finale:

```python
    # ── P10 SL Floor ─────────────────────────────────────────────────────────
    # Applica solo se il flag è attivo, C2 ha dati validi, e il floor STRINGE
    # (mai allarga) lo SL. Il guard sulla distanza minima previene SL troppo
    # stretti rispetto al noise del timeframe 4h.
    _use_floor = (self.p10_sl_floor_enabled or p10_sl_floor_enabled)
    if _use_floor and c2_p10 is not None and c2_p90 is not None:
        if side == "long":
            # Guard validità: p10 deve essere sotto entry e sopra zero
            if 0 < c2_p10 < entry_price:
                p10_dist = entry_price - c2_p10
                if p10_dist < sl_dist:          # il floor è sopra il SL corrente → stringe
                    sl_dist = p10_dist
                    log.info(f"P10 SL floor applied (long): sl_dist {atr_sl_dist:.2f} → {sl_dist:.2f} (p10={c2_p10:.2f})")
        else:  # short
            if c2_p90 > entry_price:
                p90_dist = c2_p90 - entry_price
                if p90_dist < sl_dist:          # il floor è sotto il SL corrente → stringe
                    sl_dist = p90_dist
                    log.info(f"P10 SL floor applied (short): sl_dist {atr_sl_dist:.2f} → {sl_dist:.2f} (p90={c2_p90:.2f})")

    # Guard distanza minima: SL mai più stretto di min_atr_mult × ATR
    min_sl_dist = self.p10_sl_floor_min_atr_mult * atr
    if _use_floor:
        sl_dist = max(sl_dist, min_sl_dist)
```

Il logging include il confronto prima/dopo per poter tracciare l'impatto candle per candle nei log del bot.

---

### File: `apps/api/services/backtesting.py`

Aggiungere la lettura dei flag:

```python
p10_sl_floor_enabled      = getattr(cfg, "p10_sl_floor_enabled",      False)
p10_sl_floor_min_atr_mult = getattr(cfg, "p10_sl_floor_min_atr_mult", 1.0)
```

Aggiornare la costruzione di `RiskManager`:

```python
risk = RiskManager(
    sl_atr_mult=sl_atr_mult,
    tp_atr_mult=tp_atr_mult,
    position_size_pct=pos_size_pct,
    adaptive_sizing_enabled=adaptive_sizing_enabled,
    adaptive_size_min_mult=adaptive_size_min_mult,
    adaptive_size_max_mult=adaptive_size_max_mult,
    p10_sl_floor_enabled=p10_sl_floor_enabled,
    p10_sl_floor_min_atr_mult=p10_sl_floor_min_atr_mult,
)
```

Nel loop del backtest, passare il flag a `calculate_trade_params` (i parametri `c2_p10` e `c2_p90` sono già passati nell'implementazione corrente):

```python
tp = risk.calculate_trade_params(
    side=result.action,
    entry_price=close_price,
    atr=atr,
    equity_usd=equity,
    c2_p10=result.forecast_p10,
    c2_p90=result.forecast_p90,
    signal_score=result.confidence,
    p10_sl_floor_enabled=p10_sl_floor_enabled,
)
```

**Nota backtest:** quando Chronos è disabilitato nel backtest, `forecast_p10 == forecast_p50 == forecast_p90 == close_price`. Il guard `0 < c2_p10 < entry_price` sarà `False` (p10 == entry_price, non strettamente minore), quindi il floor non si applica automaticamente senza nessuna condizione speciale da aggiungere.

---

### Frontend — `apps/web/components/trading-hub/BotConfig.tsx`

Aggiungere all'interfaccia `Config`:

```typescript
p10_sl_floor_enabled: boolean;
p10_sl_floor_min_atr_mult: number;
```

Aggiungere a `DEFAULTS`:

```typescript
p10_sl_floor_enabled: false,
p10_sl_floor_min_atr_mult: 1.0,
```

Aggiungere il toggle nella sezione "Ensemble Avanzato", dopo il blocco Adaptive Sizing:

```tsx
{/* ── P10 SL Floor Toggle ── */}
<div className={`flex flex-col gap-3 pt-6 border-t transition-colors duration-200 ${config.p10_sl_floor_enabled ? 'border-violet-200 dark:border-violet-500/25' : 'border-slate-100 dark:border-white/5'}`}>
  <Tooltip
    text="Usa il 10° percentile di Chronos-2 come vincolo inferiore per lo Stop Loss sui long (90° per gli short). Il SL si stringe quando C2 è confidenta sul limite del downside, aumentando automaticamente il position size a parità di rischio. Richiede Chronos-2 attivo."
    width="wide" pos="bottom"
  >
    <label className="flex items-center gap-3 cursor-pointer group">
      <div className="relative">
        <input type="checkbox" className="sr-only"
          checked={config.p10_sl_floor_enabled}
          onChange={e => setConfig(c => ({ ...c, p10_sl_floor_enabled: e.target.checked }))}
        />
        <div className={`w-10 h-5 rounded-full transition-all duration-300 ${config.p10_sl_floor_enabled ? 'bg-violet-600' : 'bg-slate-200 dark:bg-white/10'}`} />
        <div className={`absolute top-1 left-1 w-3 h-3 bg-white rounded-full shadow-sm transition-transform duration-300 ${config.p10_sl_floor_enabled ? 'translate-x-5' : ''}`} />
      </div>
      <div>
        <p className={`text-sm font-bold transition-colors ${config.p10_sl_floor_enabled ? 'text-violet-600 dark:text-violet-400' : 'text-slate-800 dark:text-slate-200 group-hover:text-violet-600 dark:group-hover:text-violet-400'}`}>
          P10 SL Floor
          {config.p10_sl_floor_enabled && (
            <span className="ml-2 px-1.5 py-0.5 rounded text-[9px] font-bold bg-violet-100 dark:bg-violet-500/20 text-violet-600 dark:text-violet-400 uppercase tracking-wider">Attivo</span>
          )}
        </p>
        <p className="text-[11px] font-medium text-slate-400 dark:text-slate-500 leading-tight">
          {config.p10_sl_floor_enabled
            ? `SL vincolato al p10 C2 — distanza minima ${config.p10_sl_floor_min_atr_mult}×ATR garantita`
            : 'Attiva per usare Chronos p10/p90 come vincolo intelligente sullo Stop Loss'}
        </p>
      </div>
    </label>
  </Tooltip>

  {config.p10_sl_floor_enabled && (
    <div className="pl-12 flex flex-col gap-4">
      <NumInput
        label="Distanza SL minima (× ATR)"
        value={config.p10_sl_floor_min_atr_mult}
        min={0.5} max={2.0} step={0.1}
        onChange={upd('p10_sl_floor_min_atr_mult')}
      />

      {/* Warning se dynamic_sl_tp è anche attivo */}
      {config.dynamic_sl_tp_enabled && (
        <div className="flex items-start gap-3 bg-amber-50 dark:bg-amber-500/10 border border-amber-200 dark:border-amber-500/30 rounded-xl px-4 py-3">
          <svg className="w-4 h-4 text-amber-500 flex-shrink-0 mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" />
          </svg>
          <div>
            <p className="text-[11px] font-bold text-amber-700 dark:text-amber-400 uppercase tracking-wide">SL/TP Adattativi attivi</p>
            <p className="text-[11px] text-amber-600 dark:text-amber-500 leading-snug mt-0.5">
              Con entrambe le feature attive, il SL viene prima blendato (ATR+C2) e poi vincolato al p10. L'effetto combinato può produrre SL molto stretti su segnali forti con position size auto-aumentate. Testa prima separatamente.
            </p>
          </div>
        </div>
      )}

      {/* Warning se Chronos è disabilitato */}
      {!config.chronos_enabled && (
        <div className="flex items-start gap-3 bg-amber-50 dark:bg-amber-500/10 border border-amber-200 dark:border-amber-500/30 rounded-xl px-4 py-3">
          <svg className="w-4 h-4 text-amber-500 flex-shrink-0 mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" />
          </svg>
          <div>
            <p className="text-[11px] font-bold text-amber-700 dark:text-amber-400 uppercase tracking-wide">Chronos-2 non attivo</p>
            <p className="text-[11px] text-amber-600 dark:text-amber-500 leading-snug mt-0.5">
              P10 SL Floor richiede Chronos-2. Il bot userà il SL ATR standard finché Chronos non viene abilitato.
            </p>
          </div>
        </div>
      )}
    </div>
  )}
</div>
```

---

## Fase 6 — Enhanced Mid-Trade Exit (raffinazione di `lgbm_exit_enabled`)

### Problema del sistema attuale

`lgbm_exit_enabled` chiude la posizione dopo N barre consecutive in cui LightGBM solo inverte segnale. È già utile, ma soffre di un limite: LGBM può flippare per rumore su una singola feature senza che il mercato abbia davvero cambiato direzione. Il risultato sono uscite premature da trade che poi avrebbero raggiunto il TP.

### Soluzione

Aggiungere un livello di conferma: il segnale di uscita di LGBM deve essere corroborato da almeno un'altra fonte prima di contare come "strike". Due modalità a seconda della configurazione attiva:

**Modalità A — LGBM + C2 p50** (quando `composite_scoring_enabled = False`)  
LGBM segnala uscita E il p50 di Chronos-2 è passato dall'altro lato dell'entry price. p50 è il punto di "massima probabilità" della distribuzione C2 — se è sotto l'entry su un long, C2 stima che il prezzo atteso è già in territorio di perdita.

**Modalità B — LGBM + ensemble direzionale** (quando `composite_scoring_enabled = True`)  
LGBM segnala uscita E l'`ensemble_prob` (la stessa combinazione LGBM+C2 usata per l'ingresso) ha flippato sotto 0.5 per un long, sopra 0.5 per uno short. Usa la stessa metrica su cui si era entrati per decidere se uscire.

**Fallback automatico in backtest senza Chronos:** quando Chronos è disabilitato, `c2_p50 ≈ close_price` (prior neutro). Il guard `abs(c2_p50 - close_price) > 0.1% × close_price` rileva questa condizione e ricade automaticamente sul comportamento LGBM-only originale. Il backtest senza Chronos non cambia rispetto a oggi.

### Un solo nuovo parametro

Il toggle si chiama `enhanced_exit_enabled`. Non aggiunge nuovi threshold — riutilizza `lgbm_exit_threshold`, `lgbm_exit_confirm_bars`, `lgbm_exit_min_hold_bars` già configurabili. Quando `False`, il comportamento è identico a oggi.

---

### File: `apps/api/main.py` — BotConfig Pydantic

```python
enhanced_exit_enabled: bool = Field(False)
```

---

### File: `apps/api/services/execution.py` — BotConfig dataclass

```python
self.enhanced_exit_enabled = kw.get("enhanced_exit_enabled", False)
```

---

### File: `apps/api/services/execution.py` — blocco LightGBM mid-trade exit

Sostituire il blocco attuale (righe ~768-784) con:

```python
# ── 4. LightGBM mid-trade exit (con enhanced confirmation opzionale) ─────────
if (self.config.lgbm_exit_enabled and self._lgbm_model is not None
        and self._position["bars_held"] >= self.config.lgbm_exit_min_hold_bars):

    lgbm_p    = self._get_lgbm_prob(df_feat)
    entry_px  = self._position["entry"]

    if self.config.enhanced_exit_enabled:
        # ── Recupera output C2 corrente (già calcolato nel ciclo corrente) ───
        c2_p50       = c2_output.get("c2_p50", current_price)
        c2_available = abs(c2_p50 - current_price) > (0.001 * current_price)

        if self.config.composite_scoring_enabled:
            # Modalità B: usa ensemble_prob (stessa metrica dell'ingresso)
            lgbm_w         = 1.0 - self.config.chronos_weight
            c2_dir_prob    = c2_output.get("c2_dir_prob", 0.5)
            ensemble_prob  = lgbm_w * lgbm_p + self.config.chronos_weight * c2_dir_prob
            flip_long      = side == "long"  and lgbm_p < self.config.lgbm_exit_threshold and ensemble_prob < 0.5
            flip_short     = side == "short" and lgbm_p > (1.0 - self.config.lgbm_exit_threshold) and ensemble_prob > 0.5
        elif c2_available:
            # Modalità A: LGBM + C2 p50 ha attraversato l'entry
            lgbm_flip_long  = lgbm_p < self.config.lgbm_exit_threshold
            lgbm_flip_short = lgbm_p > (1.0 - self.config.lgbm_exit_threshold)
            flip_long       = lgbm_flip_long  and c2_p50 < entry_px
            flip_short      = lgbm_flip_short and c2_p50 > entry_px
        else:
            # Fallback: C2 non disponibile (Chronos disabilitato) → LGBM solo
            flip_long  = side == "long"  and lgbm_p < self.config.lgbm_exit_threshold
            flip_short = side == "short" and lgbm_p > (1.0 - self.config.lgbm_exit_threshold)
    else:
        # Comportamento originale invariato
        flip_long  = side == "long"  and lgbm_p < self.config.lgbm_exit_threshold
        flip_short = side == "short" and lgbm_p > (1.0 - self.config.lgbm_exit_threshold)

    if flip_long or flip_short:
        self._position["lgbm_strikes"] = self._position.get("lgbm_strikes", 0) + 1
    else:
        self._position["lgbm_strikes"] = 0

    if self._position.get("lgbm_strikes", 0) >= self.config.lgbm_exit_confirm_bars:
        log.info(
            "Mid-trade exit triggered: %s | lgbm_p=%.3f | bars_held=%d | strikes=%d | enhanced=%s",
            side, lgbm_p, self._position["bars_held"],
            self._position["lgbm_strikes"], self.config.enhanced_exit_enabled,
        )
        await self._close_position(current_price, "lgbm_exit")
        return
```

**Nota su `c2_output`:** nell'execution engine, Chronos viene eseguito ogni ciclo e il suo output è già disponibile nella stessa chiamata che gestisce la posizione. Se il tuo codice non lo passa già al blocco di gestione della posizione come variabile locale, va propagato dalla funzione che avvia il ciclo.

---

### File: `apps/api/services/backtesting.py`

Aggiungere la lettura del flag:

```python
enhanced_exit_enabled = getattr(cfg, "enhanced_exit_enabled", False)
```

Sostituire il blocco lgbm_exit (righe ~247-272) con:

```python
# ── LightGBM mid-trade exit (con enhanced confirmation opzionale) ─────────
if lgbm_exit_enabled and bars_held >= lgbm_exit_min_hold_bars:
    row_x          = X_all.iloc[[i]]
    lgbm_p_current = float(lgbm_model.predict_proba(row_x)[0, 1])
    entry_px       = position["entry"]

    if enhanced_exit_enabled:
        # In backtest, c2_p50 viene dal risultato della decisione all'ingresso.
        # Con Chronos disabilitato, c2_p50 ≈ close_price (prior neutro).
        # Il guard c2_available rileva questo e ricade su LGBM solo.
        c2_p50_current = result.forecast_p50 if result else close_price
        c2_available   = abs(c2_p50_current - close_price) > (0.001 * close_price)

        if composite_scoring_enabled:
            # Modalità B: ensemble_prob con gli stessi pesi dell'ingresso
            lgbm_w        = 1.0 - chronos_weight
            c2_dir_prob   = c2_output.get("c2_dir_prob", 0.5) if c2_output else 0.5
            ens_prob      = lgbm_w * lgbm_p_current + chronos_weight * c2_dir_prob
            flip_long     = side == "long"  and lgbm_p_current < lgbm_exit_threshold and ens_prob < 0.5
            flip_short    = side == "short" and lgbm_p_current > (1.0 - lgbm_exit_threshold) and ens_prob > 0.5
        elif c2_available:
            # Modalità A: LGBM + C2 p50 oltre entry
            flip_long  = lgbm_p_current < lgbm_exit_threshold      and c2_p50_current < entry_px
            flip_short = lgbm_p_current > (1.0 - lgbm_exit_threshold) and c2_p50_current > entry_px
        else:
            # Fallback LGBM solo (Chronos disabilitato → comportamento identico all'originale)
            flip_long  = lgbm_p_current < lgbm_exit_threshold
            flip_short = lgbm_p_current > (1.0 - lgbm_exit_threshold)
    else:
        # Comportamento originale invariato
        flip_long  = lgbm_p_current < lgbm_exit_threshold
        flip_short = lgbm_p_current > (1.0 - lgbm_exit_threshold)

    if flip_long or flip_short:
        position["lgbm_strikes"] = position.get("lgbm_strikes", 0) + 1
    else:
        position["lgbm_strikes"] = 0

    if position.get("lgbm_strikes", 0) >= lgbm_exit_confirm_bars:
        pnl_pct_e = (close_price - entry_px) / entry_px * 100 if side == "long" \
                    else (entry_px - close_price) / entry_px * 100
        pnl_usd_e = position["size_usd"] * pnl_pct_e / 100
        fee_e     = position["size_usd"] * HL_TAKER_FEE
        equity   += pnl_usd_e - fee_e
        trades.append({
            "side": side, "entry": entry_px, "exit": close_price,
            "pnl_pct":      round(pnl_pct_e, 4),
            "pnl_usd":      round(pnl_usd_e - fee_e, 2),
            "reason":       "lgbm_exit",
            "holding_bars": bars_held,
            "bar":          i,
        })
        equity_curve.append({"bar": i, "equity": round(equity, 2)})
        position       = None
        already_closed = True
```

---

### Frontend — `apps/web/components/trading-hub/BotConfig.tsx`

Aggiungere all'interfaccia `Config`:

```typescript
enhanced_exit_enabled: boolean;
```

Aggiungere a `DEFAULTS`:

```typescript
enhanced_exit_enabled: false,
```

Il toggle va inserito vicino agli altri controlli `lgbm_exit_*`, nella sezione già esistente "LightGBM Mid-Trade Exit", come sub-opzione che appare solo quando `lgbm_exit_enabled` è già attivo:

```tsx
{config.lgbm_exit_enabled && (
  <div className="pl-12 mt-3">
    <label className="flex items-center gap-3 cursor-pointer group">
      <div className="relative">
        <input type="checkbox" className="sr-only"
          checked={config.enhanced_exit_enabled}
          onChange={e => setConfig(c => ({ ...c, enhanced_exit_enabled: e.target.checked }))}
        />
        <div className={`w-8 h-4 rounded-full transition-all duration-300 ${config.enhanced_exit_enabled ? 'bg-indigo-500' : 'bg-slate-200 dark:bg-white/10'}`} />
        <div className={`absolute top-0.5 left-0.5 w-3 h-3 bg-white rounded-full shadow-sm transition-transform duration-300 ${config.enhanced_exit_enabled ? 'translate-x-4' : ''}`} />
      </div>
      <div>
        <p className="text-[11px] font-bold text-slate-600 dark:text-slate-400">
          Conferma C2 richiesta
          {config.enhanced_exit_enabled && (
            <span className="ml-2 px-1.5 py-0.5 rounded text-[9px] font-bold bg-indigo-100 dark:bg-indigo-500/20 text-indigo-600 dark:text-indigo-400 uppercase tracking-wider">Attivo</span>
          )}
        </p>
        <p className="text-[11px] font-medium text-slate-400 dark:text-slate-500 leading-tight mt-0.5">
          {config.enhanced_exit_enabled
            ? config.composite_scoring_enabled
              ? 'Esce solo se LGBM + ensemble prob concordano nel flip'
              : 'Esce solo se LGBM + C2 p50 concordano nel flip'
            : 'Attiva per richiedere conferma Chronos-2 prima di uscire anticipatamente'}
        </p>
      </div>
    </label>
  </div>
)}
```

---

### Comportamento per combinazione di configurazione

| `lgbm_exit_enabled` | `enhanced_exit_enabled` | `composite_scoring_enabled` | Comportamento |
|---|---|---|---|
| `False` | qualsiasi | qualsiasi | Nessun mid-trade exit |
| `True` | `False` | qualsiasi | Originale: LGBM solo |
| `True` | `True` | `False` + C2 disponibile | Modalità A: LGBM + C2 p50 vs entry |
| `True` | `True` | `True` | Modalità B: LGBM + ensemble_prob flippato |
| `True` | `True` | `False` + C2 non disponibile | Fallback: LGBM solo (identico all'originale) |

**⚠️ Limitazione backtest per Modalità B:** quando si esegue un backtest con `use_chronos=False` (default), `c2_dir_prob` non è disponibile nel loop mid-trade. Il calcolo dell'`ensemble_prob` usa `c2_dir_prob=0.5` come fallback, rendendo l'ensemble quasi identico a LGBM solo. Il backtest **non replica fedelmente** il comportamento live di Modalità B. Per una validazione realistica di Modalità B è necessario eseguire il backtest con `use_chronos=True`, accettando i tempi più lunghi (~3s/candela).

---

## Fase 7 — TimesFM come feature per LightGBM (opzionale, post-validazione)

**Pre-condizione obbligatoria:** Fasi 1-6 live e validate con almeno 60 giorni di paper trading.

### Perché questa integrazione e non le altre

TimesFM (Google, `google/timesfm-1.0-200m`) è addestrato su un corpus diverso da Chronos-2 (dati proprietari Google vs dati open Amazon) e usa un'architettura decoder-only diversa. Questo garantisce **errori genuinamente non correlati** sui segnali borderline — l'unico contesto in cui un terzo modello aggiunge valore reale rispetto all'ensemble esistente.

Il modo più robusto di integrarlo non è aggiungere un gate manuale o un peso hardcoded, ma **lasciare che LightGBM impari autonomamente a pesarlo** insieme alle altre 56 feature. Se il segnale TimesFM non porta informazione utile, LGBM lo apprende dai dati e lo ignora (feature importance vicina a zero). Se porta informazione, viene usato con il peso corretto senza nessuna calibrazione manuale.

### Segnale generato

```python
# Input: ultimi 256 close price su 4h (univariato)
# Output: forecast prossime 6 candele (24h)

tfm_expected_return = (mean(forecast[:3]) - current_price) / current_price
# [-1, +1] → atteso rendimento percentuale nelle prossime 12h

tfm_bullish = float(tfm_expected_return > 0)
# 1.0 = TimesFM prevede rialzo, 0.0 = prevede ribasso
```

Due feature numeriche, compatibili con il formato tabellare di LGBM.

### Problema computazionale e soluzione

Generare la feature per ogni candela di training richiede un'inferenza TimesFM per candle. Su 500 candles di lookback a ~0.5s/inference su CPU → ~250 secondi per retrain. Non è proibitivo (il retrain avviene ogni 120 cicli, ~30 giorni), ma va gestito.

**Soluzione: batch inference.** TimesFM supporta inferenza batched — si possono preparare tutte le sequenze sliding-window come un tensore e passarle in un'unica chiamata forward. Con batch size 32-64, il tempo totale scende a 20-40 secondi per l'intero training set.

### File: `apps/api/services/trainer.py`

Aggiungere la funzione di feature generation (chiamata una sola volta per retrain):

```python
def _generate_tfm_features(df_ohlcv: pd.DataFrame, context_len: int = 256) -> pd.DataFrame:
    """
    Genera tfm_expected_return e tfm_bullish per ogni candle del training set.
    Usa batch inference per contenere il tempo di calcolo.
    Restituisce DataFrame indicizzato come df_ohlcv, con NaN per le prime context_len righe.
    """
    try:
        import timesfm
    except ImportError:
        log.warning("timesfm non installato — feature TFM non generate (pip install timesfm)")
        return pd.DataFrame(index=df_ohlcv.index)

    closes = df_ohlcv["close"].values.astype(np.float32)
    n      = len(closes)
    if n < context_len + 6:
        return pd.DataFrame(index=df_ohlcv.index)

    # Carica il modello (singleton — rimane in memoria durante il retrain)
    tfm = timesfm.TimesFm(
        hparams=timesfm.TimesFmHparams(
            backend="cpu",
            per_core_batch_size=32,
            horizon_len=6,
        ),
        checkpoint=timesfm.TimesFmCheckpoint(
            huggingface_repo_id="google/timesfm-1.0-200m-pytorch"
        ),
    )

    # Prepara sequenze sliding-window in batch
    sequences = []
    valid_idx = []
    for i in range(context_len, n):
        sequences.append(closes[i - context_len:i].tolist())
        valid_idx.append(i)

    # Batch inference (TimesFM gestisce il batching internamente)
    forecasts, _ = tfm.forecast(sequences, freq=[0] * len(sequences))
    # forecasts: shape (n_sequences, horizon=6)

    tfm_ret   = np.full(n, np.nan)
    tfm_bull  = np.full(n, np.nan)
    for j, idx in enumerate(valid_idx):
        fcast                = forecasts[j]           # 6 valori futuri
        mean_3bar            = float(np.mean(fcast[:3]))
        current              = closes[idx - 1]
        tfm_ret[idx]         = (mean_3bar - current) / current if current > 0 else 0.0
        tfm_bull[idx]        = 1.0 if tfm_ret[idx] > 0 else 0.0

    result = pd.DataFrame({
        "tfm_expected_return": tfm_ret,
        "tfm_bullish":         tfm_bull,
    }, index=df_ohlcv.index)

    log.info("TFM features generated: %d valid rows of %d", len(valid_idx), n)
    return result
```

Nella funzione `_run`, aggiungere la generazione delle feature dopo il build delle feature classiche e prima del training:

```python
# ── 2b. TimesFM features (opzionali) ────────────────────────────────────
if self._tfm_enabled:
    df_tfm = _generate_tfm_features(df_ohlcv)
    if not df_tfm.empty:
        df_feat = df_feat.join(df_tfm, how="left")
        log.info("TimesFM features joined: %s", list(df_tfm.columns))
```

`_tfm_enabled` viene impostato nel costruttore di `LGBMTrainer`. Aggiornare la classe:

```python
class LGBMTrainer:
    def __init__(self, tfm_enabled: bool = False):
        self._hl         = HyperliquidData()
        self._tfm_enabled = tfm_enabled
```

In `execution.py`, dove `LGBMTrainer` viene istanziato (tipicamente all'avvio e al retrain), passare il flag dal BotConfig:

```python
trainer = LGBMTrainer(tfm_enabled=self.config.timesfm_enabled)
```

Il `/retrain` endpoint in `main.py` deve propagare il flag:

```python
@app.post("/retrain")
async def retrain(background_tasks: BackgroundTasks):
    cfg = engine.config
    trainer = LGBMTrainer(tfm_enabled=cfg.timesfm_enabled)
    background_tasks.add_task(trainer.retrain, SYMBOL)
    return {"status": "retraining_started"}
```

### File: `apps/api/services/smc.py`

Aggiungere le nuove feature al gruppo inference-time (stesso gruppo delle feature C2, escluse dal training base):

```python
FEATURE_GROUPS["tfm"] = ["tfm_expected_return", "tfm_bullish"]
```

E aggiornare `ALL_FEATURES` di conseguenza.

### File: `apps/api/services/execution.py` — ciclo live

TimesFM deve girare ogni ciclo (4h) per produrre la feature corrente che LGBM usa per la predizione. Va affiancato a Chronos, con lazy loading per contenere l'uso di RAM:

```python
# Singleton, caricato alla prima chiamata e mantenuto in memoria
_tfm_model = None

def _get_tfm_model():
    global _tfm_model
    if _tfm_model is None:
        import timesfm
        _tfm_model = timesfm.TimesFm(
            hparams=timesfm.TimesFmHparams(backend="cpu", per_core_batch_size=1, horizon_len=6),
            checkpoint=timesfm.TimesFmCheckpoint(huggingface_repo_id="google/timesfm-1.0-200m-pytorch"),
        )
    return _tfm_model

def _get_tfm_features(df_ohlcv: pd.DataFrame, context_len: int = 256) -> dict:
    """Inferenza TimesFM per la candela corrente. Restituisce dict con le feature."""
    try:
        closes = df_ohlcv["close"].values[-context_len:].astype(np.float32)
        if len(closes) < context_len:
            return {"tfm_expected_return": 0.0, "tfm_bullish": 0.5}
        tfm      = _get_tfm_model()
        fcast, _ = tfm.forecast([closes.tolist()], freq=[0])
        mean_3   = float(np.mean(fcast[0][:3]))
        current  = float(closes[-1])
        ret      = (mean_3 - current) / current if current > 0 else 0.0
        return {"tfm_expected_return": ret, "tfm_bullish": 1.0 if ret > 0 else 0.0}
    except Exception as e:
        log.warning("TimesFM inference failed: %s — using neutral", e)
        return {"tfm_expected_return": 0.0, "tfm_bullish": 0.5}
```

Le feature vengono poi aggiunte al `features` dict prima della chiamata a `lgbm_model.predict_proba`:

```python
if self.config.timesfm_enabled:
    tfm_feats = _get_tfm_features(df_ohlcv)
    features.update(tfm_feats)
```

### File: `apps/api/main.py` — BotConfig Pydantic

```python
timesfm_enabled: bool = Field(False)
```

### Backtest

TimesFM **non viene eseguito nel backtest** — identico all'approccio già usato per le feature Chronos-2. Le colonne `tfm_expected_return` e `tfm_bullish` vengono fillate con `0.0` (prior neutro). LGBM è stato addestrato con valori reali di TimesFM, ma in backtest riceve il placeholder: questo introduce un piccolo disallineamento train/test, lo stesso che esiste già per le feature C2. È accettabile e documentato.

### RAM e latenza

- `google/timesfm-1.0-200m-pytorch`: ~800MB su disco, ~400MB in RAM con float32
- Inferenza su CPU per singola sequenza: ~0.3-0.8s
- Con Chronos-2 già in memoria (~1-1.5GB), il totale sale a ~1.5-2GB per i soli modelli
- Su VPS con 4GB RAM: fattibile ma stretto. Su 8GB RAM: confortevole
- Alternativa: scaricare TimesFM dalla RAM dopo l'inferenza (del-model), ricaricare al ciclo successivo — aggiunge ~3s per ciclo ma riduce il footprint a ~400MB alternati

### Installazione

```bash
pip install timesfm
# oppure dalla sorgente per la versione PyTorch:
pip install "timesfm[torch] @ git+https://github.com/google-research/timesfm"
```

---

## Come fare A/B testing tra le due modalità

Entrambe le configurazioni — classica e composite — vengono salvate separatamente tramite gli endpoint esistenti:

- `/bot` → config live/paper (persiste su `bot_configs.name = "default"`)
- `/bot/backtest` → config backtest (persiste su `bot_configs.name = "backtest"`)

**Workflow consigliato:**
1. Eseguire un backtest con `composite_scoring_enabled = false` (baseline classico) e salvare le metriche
2. Eseguire un backtest con `composite_scoring_enabled = true` e confrontare win rate, trade count, Sharpe, max DD
3. Se il backtest è favorevole, abilitare in paper trading con `adaptive_sizing_enabled = false` inizialmente (isola le variabili)
4. Dopo 30+ trade in paper, aggiungere `adaptive_sizing_enabled = true`
5. Confrontare paper results prima di portare in live

**Non abilitare composite score e adaptive sizing contemporaneamente dal primo giorno.** Testa una variabile alla volta.

---

## Roadmap di esecuzione

```
Settimana 1   — Fase 3: purged walk-forward in trainer.py (zero rischio, standalone)
Settimana 1-2 — Fase 1: composite score con toggle (backend + API + UI)
Settimana 2   — Fase 4: dynamic threshold (sub-toggle del composite, <1h di lavoro)
Settimana 3   — Fase 2: adaptive sizing con toggle (backend + API + UI)
Settimana 4   — Fase 5: P10 SL floor con toggle (backend + API + UI)
Settimana 4   — Fase 6: enhanced exit con toggle (sub-toggle di lgbm_exit_enabled)
Settimana 5-6 — A/B backtest sistematico: baseline → +composite → +adaptive → +p10floor → +enhanced_exit
Mese 2        — Paper trading comparativo (30+ trade per modalità, una variabile alla volta)
Mese 3+       — Decisione basata su dati reali se promuovere in live
Mese 4+ (opt) — Fase 7: TimesFM come feature LGBM, solo se RAM VPS ≥ 8GB e Fasi 1-6 validate
```

---

## Cosa NON fare

- **Non portare nessuna di queste modalità in live prima di 30+ trade paper** con la nuova configurazione
- **Non abilitare composite + adaptive insieme** senza prima testare ciascuno separatamente
- **Non abilitare P10 SL floor + dynamic_sl_tp insieme** senza aver testato ciascuno in isolamento — l'effetto combinato può produrre SL troppo stretti con position size molto grandi
- **Non alzare `composite_threshold` oltre 0.65** cercando certezza — si distrugge l'edge statistico
- **Non usare `p10_sl_floor_min_atr_mult` sotto 0.8** — sotto questa soglia il SL su 4h è troppo esposto al normale noise di candela
- **Non aggiungere Moirai**: C2 già copre l'uncertainty. Gain marginale, costo RAM proibitivo sul VPS
- **Non implementare TimesFM prima di Mese 4**: richiede Fasi 1-6 validate e VPS con almeno 8GB RAM. Su VPS con 4GB è rischioso per la stabilità del processo
- **Non usare TimesFM come gate diretto o peso hardcoded**: l'unica integrazione sensata è come feature per LGBM — lascia che sia il modello a pesarla, non tu
