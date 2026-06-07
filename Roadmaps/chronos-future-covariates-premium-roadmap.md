# Implementation Roadmap — Chronos-2 `future_covariates` (calendario) + `premium_z`
**Data:** 7 Giugno 2026
**File:** `Roadmaps/chronos-future-covariates-premium-roadmap.md`
**Stato:** Piano — codice non modificato

---

## Panoramica

Due aggiunte al wrapper Chronos-2 ([apps/api/services/chronos_model.py](../apps/api/services/chronos_model.py)):

1. **Covariate calendariali come `future_covariates`** — `hour-of-day` e `day-of-week` con encoding ciclico (sin/cos). Sono l'unico segnale *noto in anticipo* nel sistema, quindi l'unico che valorizza davvero i `future_covariates`. Colmano un buco strutturale: Chronos riceve solo una sequenza di numeri, **non i timestamp**, quindi non può sapere che ore/giorno sono le barre di contesto né quelle future (sessioni Asia/EU/US, weekend, settlement funding 00/08/16 UTC).

2. **`premium_z` come `past_covariate`** — proxy di flusso/posizionamento spot-perp, già calcolato in `build_all_features` ([smc.py:436](../apps/api/services/smc.py#L436)) ma oggi non passato a Chronos. Costo quasi nullo.

**Verifica preliminare già eseguita:** `chronos-forecasting 2.2.2` espone `future_covariates` in `Chronos2Pipeline.predict()`, confermato sia in locale sia sul VPS in produzione (`apps/api/.venv`, torch 2.5.1, gira su CPU).

**Vincolo dell'API (dal docstring di `predict`):**
> *"All keys in `future_covariates` must be a subset of the keys in `past_covariates`. ... `future_covariates` values must have length equal to `prediction_length`."*

Conseguenza progettuale: ogni canale calendariale va passato **due volte** → in `past_covariates` (lunghezza = `history_length`) **e** in `future_covariates` (lunghezza = `horizon`). Le covariate di order-flow (volume/oi/funding/cvd/liq/premium) restano **solo past** perché il loro valore futuro non è noto.

**File toccati:**

| File | Modifica |
|------|----------|
| `apps/api/services/chronos_model.py` | Nuovi parametri `timestamps`, `interval_hours`, `calendar_covariates`, `premium_series`; costruzione past+future covariates |
| `apps/api/main.py` | BotConfig (2 campi) + passaggio nuovi argomenti nell'endpoint `/forecast` |
| `apps/api/services/execution.py` | Passaggio nuovi argomenti nel motore live (~riga 1330) |
| `apps/api/services/backtesting.py` | Passaggio nuovi argomenti nel loop di backtest (~riga 884) + propagazione config |

**Nuovi BotConfig field totali: 2**
- `chronos_calendar_covariates: bool = False`
- `chronos_premium_covariate: bool = False`

Entrambi default `False` → comportamento invariato finché non attivati. Pensati per A/B test in backtest.

---

## Feature A — Covariate calendariali (`future_covariates`)

### Problema
Chronos-2 è time-index-blind: vede `ctx = close_series[-512:]` come 512 numeri senza alcuna etichetta temporale. Tutto ciò che dipende dall'orario di parete (liquidità di sessione, weekend, prossimità settlement funding) è **invisibile** al modello e non deducibile dalla sequenza.

### Meccanismo
1. Il chiamante passa i `timestamps` (DatetimeIndex UTC) allineati a `close_series` e l'`interval_hours` (4 su 4H).
2. Il wrapper deriva, per ogni barra di contesto, `hour-of-day` (0–23) e `day-of-week` (0–6) e li codifica in modo **ciclico** (sin/cos) → 4 canali: `hod_sin`, `hod_cos`, `dow_sin`, `dow_cos`.
3. Estrapola i timestamp futuri (`last_ts + k * interval_hours`, k=1..horizon) e calcola gli **stessi 4 canali** per le barre future.
4. I 4 canali passati vanno in `past_covariates`; i 4 canali futuri in `future_covariates` (stessi nomi → rispetta il vincolo subset).

### Perché encoding ciclico
`hour=23` e `hour=0` sono adiacenti: una codifica lineare 0–23 introduce una falsa discontinuità. sin/cos su `2π·h/24` rende la distanza tra 23:00 e 00:00 uguale a quella tra 00:00 e 01:00. Idem per il giorno della settimana su `2π·d/7`.

### No-lookahead
Le covariate calendariali sono **deterministiche**: i timestamp futuri sono noti con certezza assoluta (step fissi da 4h). Zero rischio di lookahead — è esattamente il caso d'uso per cui esistono i `future_covariates`.

### Implementazione — `chronos_model.py`

#### Nuova firma di `forecast()`
```python
def forecast(
    self,
    close_series: np.ndarray,
    horizon: int = 3,
    atr: Optional[float] = None,
    seed: Optional[int] = None,
    volume_series:    Optional[np.ndarray] = None,
    oi_series:        Optional[np.ndarray] = None,
    funding_series:   Optional[np.ndarray] = None,
    cvd_series:       Optional[np.ndarray] = None,
    liq_series:       Optional[np.ndarray] = None,
    premium_series:   Optional[np.ndarray] = None,   # NEW (Feature B)
    timestamps:       Optional["pd.DatetimeIndex"] = None,  # NEW — aligned with close_series
    interval_hours:   int = 4,                        # NEW — bar interval for future ts
    calendar_covariates: bool = False,                # NEW — toggle Feature A
    use_calibration: bool = False,
) -> dict:
```

#### Costruzione canali calendariali (dopo il blocco `_prep_covariate`, prima di assemblare `model_input`)
```python
import pandas as pd

future_covariates: dict = {}

if calendar_covariates and timestamps is not None and len(timestamps) >= ctx_len:
    ts = pd.DatetimeIndex(timestamps)[-ctx_len:]

    def _cyc(values: np.ndarray, period: int) -> tuple[np.ndarray, np.ndarray]:
        ang = 2.0 * np.pi * (values.astype(np.float32) / period)
        return np.sin(ang).astype(np.float32), np.cos(ang).astype(np.float32)

    # PAST channels (length = ctx_len)
    hod_sin, hod_cos = _cyc(ts.hour.values,       24)
    dow_sin, dow_cos = _cyc(ts.dayofweek.values,   7)
    past_covariates["hod_sin"] = torch.from_numpy(hod_sin)
    past_covariates["hod_cos"] = torch.from_numpy(hod_cos)
    past_covariates["dow_sin"] = torch.from_numpy(dow_sin)
    past_covariates["dow_cos"] = torch.from_numpy(dow_cos)

    # FUTURE channels (length = horizon) — extrapolate timestamps forward
    last_ts   = ts[-1]
    future_ts = pd.DatetimeIndex(
        [last_ts + pd.Timedelta(hours=interval_hours * (k + 1)) for k in range(horizon)]
    )
    f_hod_sin, f_hod_cos = _cyc(future_ts.hour.values,      24)
    f_dow_sin, f_dow_cos = _cyc(future_ts.dayofweek.values,  7)
    future_covariates["hod_sin"] = torch.from_numpy(f_hod_sin)
    future_covariates["hod_cos"] = torch.from_numpy(f_hod_cos)
    future_covariates["dow_sin"] = torch.from_numpy(f_dow_sin)
    future_covariates["dow_cos"] = torch.from_numpy(f_dow_cos)
```

#### Assemblaggio `model_input` (sostituisce il blocco righe ~177-180)
```python
if past_covariates:
    item = {"target": torch.from_numpy(ctx), "past_covariates": past_covariates}
    if future_covariates:
        item["future_covariates"] = future_covariates
    model_input = [item]
else:
    model_input = [torch.from_numpy(ctx)]
```

> **Nota:** `predict()` resta invariato — `pipeline.predict(model_input, prediction_length=horizon)`. Le lunghezze sono già coerenti (past = ctx_len, future = horizon).

#### Logging
Aggiornare `cov_used = list(past_covariates.keys())` (include già i nuovi canali). Opzionale: loggare separatamente `future_used = list(future_covariates.keys())`.

---

## Feature B — `premium_z` come `past_covariate`

### Problema
`premium_z` (z-score del premio spot-perp su finestra 12) è già in `build_all_features` ma non arriva a Chronos. È un proxy esogeno di posizionamento/flusso, complementare a funding.

### Implementazione — `chronos_model.py`
Nel blocco di assemblaggio covariate (vicino a riga ~170), dopo `liq`:
```python
prem = _prep_covariate(premium_series)
...
if prem is not None: past_covariates["premium"] = torch.from_numpy(prem)
```
`premium` resta **solo past** (il premio futuro non è noto) → nessun ingresso in `future_covariates`.

---

## Modifiche per file (call sites)

### 1. `apps/api/main.py`

#### BotConfig (2 nuovi campi)
```python
# Chronos-2 covariate avanzate
chronos_calendar_covariates: bool = Field(False)   # future_covariates: hour-of-day + day-of-week (sin/cos)
chronos_premium_covariate:   bool = Field(False)   # past_covariate: premium_z (spot-perp basis)
```

#### Endpoint `/forecast` (~riga 680)
`premium_z` qui non è disponibile (l'endpoint costruisce le covariate a mano, non chiama `build_all_features`). Calcolarlo dal `df_fund` che già contiene `premium`:
```python
# Premium-z covariate (spot-perp basis), allineato alle candele 4h
premium_series = None
try:
    if not df_fund.empty and "premium" in df_fund.columns:
        _prem = df_fund["premium"].reindex(df.index, method="ffill")
        premium_series = ((_prem - _prem.rolling(12).mean())
                          / (_prem.rolling(12).std() + 1e-9)).fillna(0.0).values
except Exception:
    premium_series = None
```
Aggiornare la chiamata `forecaster.forecast(...)`:
```python
result = forecaster.forecast(
    df["close"].values,
    horizon=horizon,
    atr=atr,
    volume_series=vol_ratio_series,
    funding_series=funding_series,
    oi_series=oi_series,
    cvd_series=cvd_series,
    liq_series=liq_ratio_series,
    premium_series=premium_series,            # NEW
    timestamps=df.index,                      # NEW
    interval_hours=4,                         # NEW
    calendar_covariates=True,                 # endpoint debug → sempre on (o query param)
)
```

> Per l'endpoint debug si può attivare sempre `calendar_covariates=True`; in produzione lo controlla la BotConfig (sotto).

### 2. `apps/api/services/execution.py` (~riga 1330)
```python
c2_out = self._chronos.forecast(
    df_feat["close"].values,
    horizon=3,
    atr=atr,
    volume_series=   (df_feat["vol_ratio"].values
                      if "vol_ratio"  in df_feat.columns else
                      df_feat["volume"].values
                      if "volume"     in df_feat.columns else None),
    oi_series=       df_feat["oi_raw"].values    if "oi_raw"    in df_feat.columns else None,
    funding_series=  df_feat["funding"].values   if "funding"   in df_feat.columns else None,
    cvd_series=      df_feat["delta_raw"].values if "delta_raw" in df_feat.columns else None,
    liq_series=      df_feat["liq_ratio"].values if "liq_ratio" in df_feat.columns else None,
    premium_series=  (df_feat["premium_z"].values                       # NEW
                      if self.config.chronos_premium_covariate
                      and "premium_z" in df_feat.columns else None),
    timestamps=      df_feat.index,                                     # NEW
    interval_hours=  4,                                                 # NEW
    calendar_covariates= self.config.chronos_calendar_covariates,      # NEW
    use_calibration= self.config.use_chronos_calibration,
)
```

### 3. `apps/api/services/backtesting.py` (~riga 884)
Aggiungere lo slice `premium_z` accanto agli altri `*_so_far`:
```python
premium_so_far = (df_feat["premium_z"].values[:i + 1]
                  if getattr(cfg, "chronos_premium_covariate", False)
                  and "premium_z" in df_feat.columns else None)
```
e nella chiamata:
```python
c2_out = chronos_forecaster.forecast(
    close_so_far, horizon=3, atr=atr,
    volume_series=volume_so_far,
    oi_series=oi_so_far,
    funding_series=funding_so_far,
    cvd_series=cvd_so_far,
    liq_series=liq_so_far,
    premium_series=premium_so_far,                                      # NEW
    timestamps=    df_feat.index[:i + 1],                               # NEW
    interval_hours=4,                                                   # NEW
    calendar_covariates=getattr(cfg, "chronos_calendar_covariates", False),  # NEW
    use_calibration=getattr(cfg, "use_chronos_calibration", False),
)
```

> **Verifica:** `df_feat` in backtest deve avere un `DatetimeIndex` UTC. Confermato — proviene da `build_all_features` ([backtesting.py:265](../apps/api/services/backtesting.py#L265)) che preserva l'indice OHLCV. Se per qualche motivo l'indice non fosse temporale, le covariate calendariali vanno disattivate (il guard `len(timestamps) >= ctx_len` + `calendar_covariates` flag protegge comunque).

---

## Piano di test / validazione

### 1. Unit / smoke test del wrapper
- Chiamare `forecast()` con `calendar_covariates=True` e `timestamps` sintetici → verificare che `cov_used` includa i 4 canali e che non sollevi eccezioni.
- Verificare che con `calendar_covariates=False` l'output sia **bit-identico** al comportamento attuale (nessuna regressione).
- Verificare lunghezze: `past` covariate = `ctx_len`, `future` = `horizon`.

### 2. A/B in backtest (il test che conta)
Stesso simbolo / periodo / seed, 4 run:

| Run | calendar | premium | Scopo |
|-----|----------|---------|-------|
| Baseline | off | off | riferimento attuale |
| +Calendar | on | off | isolare Feature A |
| +Premium | off | on | isolare Feature B |
| Entrambe | on | on | effetto combinato |

**Metriche da confrontare:**
- Sharpe / Sortino, max drawdown, win-rate, profit factor.
- **Calibrazione di `dir_prob`** (reliability curve) — è qui che ci si aspetta il maggior effetto, non sul direzionale puro.
- Larghezza media banda `p10–p90` e accuratezza di `vol_prob` segmentate per sessione/weekend (per vedere se il calendario migliora davvero l'incertezza dove atteso).
- Latency per inference (CPU sul VPS → controllare che i canali extra non rallentino troppo).

**Criterio di promozione:** attivare in produzione solo se il run "Entrambe" (o quello migliore) batte la baseline su Sharpe **e** non peggiora la calibrazione. Aspettativa realistica: miglioramento **modesto**, prevalentemente su volatilità/incertezza.

### 3. Re-fit del calibratore isotonico
`dir_prob` cambia distribuzione con le nuove covariate → il calibratore esistente ([chronos_calibrator.pkl](../apps/api/models/chronos_calibrator.pkl)) va **rifittato** dopo l'attivazione (`/calibrator/refit` poi `reload_calibrator()`), altrimenti la trasformazione isotonica è disallineata.

---

## Rischi e note

| Rischio | Mitigazione |
|---------|-------------|
| Indice non temporale in qualche call site | Guard `calendar_covariates and timestamps is not None and len>=ctx_len`; default flag `False` |
| Segnale calendariale debole su orizzonte 12h (3 barre, 6 barre/giorno → risoluzione grossolana) | È un esperimento a basso costo; decide il backtest A/B, non si attiva al buio |
| Calibratore disallineato dopo attivazione | Re-fit obbligatorio (vedi sopra) |
| Latency extra su CPU (VPS) | 4 canali sin/cos sono trascurabili; misurare comunque nel test 1 |
| Overfitting a pattern di sessione spuri | Validare out-of-sample, non solo in-sample |

## Aspettativa onesta
- I `future_covariates` danno a Chronos l'**unica informazione che non può ottenere altrimenti**: sapere che ore/giorno sono. Beneficio reale ma **probabilmente modesto** su questo orizzonte, concentrato su **volatilità/incertezza** più che sul direzionale.
- `premium_z` è quasi gratis: vale la pena includerlo nel test combinato.
- Nessuna delle due aggiunge dipendenze esterne nuove (i dati ci sono già: timestamp e `premium_z`).

---

## Checklist implementazione

- [ ] `chronos_model.py`: nuova firma + costruzione past/future calendar covariates + `premium`
- [ ] `chronos_model.py`: assemblaggio `model_input` con `future_covariates`
- [ ] `main.py`: 2 campi BotConfig + calcolo `premium_series` + nuovi argomenti in `/forecast`
- [ ] `execution.py`: nuovi argomenti nella chiamata `forecast()` (~1330)
- [ ] `backtesting.py`: slice `premium_so_far` + `timestamps` + flag config (~884)
- [ ] Smoke test wrapper (regressione off = identico)
- [ ] A/B backtest 4 run + analisi metriche/calibrazione
- [ ] Re-fit calibratore isotonico se promosso
- [ ] Rimuovere venv fantasma `/opt/quantum-trade/api/.venv` sul VPS (cleanup non correlato emerso in fase di verifica)
