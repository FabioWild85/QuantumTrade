# Transition Guard + Adverse Evidence Monitor — Piano di Implementazione
_Data: 2026-06-11 | Baseline: audit del trade SHORT BTC 9 giugno, analisi codebase live_

---

## Contesto e motivazione

Questo piano nasce dall'analisi di un trade SHORT BTC aperto il 9 giugno a 61.105 con R:R 1.08, TP sotto il minimo strutturale (58.076 < low 59.131), con il modello LGBM ancorato a P(down) 0.82 mentre il prezzo saliva da 60.7k. Sono stati identificati tre problemi distinti:

1. **Ancoraggio all'entry**: il DecisionEngine non difende quando il regime sta finendo (TRANSITION noto ma inutilizzato).
2. **Ancoraggio a posizione aperta**: il ReversalZoneDetector gira a ogni ciclo con posizione aperta ma il risultato viene buttato via.
3. **Bug nel ReversalZoneDetector**: `adx_14_lag3` viene letto dal detector ma non è mai calcolato in `build_all_features()` — il declining ADX non viene mai rilevato correttamente.

---

## Fase 0 — Audit e Fix ReversalZoneDetector (prerequisito obbligatorio)

> **Eseguire prima di tutto il resto.** L'Adverse Evidence Monitor dipende dall'affidabilità del detector.

### Bug 0A — `adx_14_lag3` non calcolato (impatto: medio)

**File**: `apps/api/services/smc.py`  
**Ubicazione bug**: `reversal_detector.py:159` legge `f.get("adx_14_lag3")` ma questa feature non viene calcolata in `build_all_features()`. Il fallback silenzioso `or adx` fa sì che `adx_l3 == adx` sempre → la condizione `adx < adx_l3` (ADX in discesa = segnale più forte) è sempre `False`.

**Fix**: Aggiungere nel blocco `if reversal_mode_enabled:` di `build_all_features()` dopo il calcolo di `adx_14`:

```python
# Reversal: ADX lagged 3 bars (per declining ADX detection)
d["adx_14_lag3"] = d["adx_14"].shift(3)
```

Aggiungere `"adx_14_lag3"` alla lista `FEATURE_GROUPS["reversal"]` in `smc.py`.

**Effetto atteso**: il sub-score exhaustion scende da `1.0` a `0.5` quando l'ADX è piatto o in salita (corretto), e resta `1.0` solo quando è effettivamente in calo (segnale più affidabile di fine trend). Non introduce lookahead (shift positivo = passato).

### Bug 0B — Default `reversal_score_threshold` interno discrepante (impatto: basso ma trappola)

**File**: `apps/api/services/reversal_detector.py:334`  
**Problema**: `getattr(cfg, "reversal_score_threshold", 0.72)` — il fallback interno è 0.72 mentre il default di sistema in `main.py:443` e `execution.py:324` è 0.34. Se mai `score()` viene chiamato con un oggetto cfg senza questo attributo, la threshold impossibile fa sì che `direction` sia sempre `None`.

**Fix**: Allineare il fallback interno:

```python
# reversal_detector.py:334
score_thr = getattr(cfg, "reversal_score_threshold", 0.34)
```

### Verifica 0C — Features disponibili al detector (no fix necessario, documentazione)

Audit completato su tutte le 7 componenti:

| Componente | Features chiave | Disponibile quando `reversal_mode_enabled=True` |
|---|---|---|
| structural | `ob_bear_inside`, `fvg_bear`, `swing_high_px` | ✅ sempre calcolate |
| momentum | `rsi_div_bear`, `d_rsi_div_bear`, `d_macd_div_bear` | ✅ MTF features |
| exhaustion | `consec_bars`, `adx_14`, **`adx_14_lag3`** ⚠️, `ema50_dist`, `ret_48`, `rsi_14`, `iv_7d_percentile`, `d_rsi`, `d_ema20_dist` | ⚠️ dopo fix 0A |
| volume | `vol_climax_bear`, `vol_z_50`, `absorption_z` | ✅ blocco reversal |
| regime | `transition_risk`, `bars_in_regime` (da `regime_signal` O da `latest[]`) | ✅ execution.py:1588 |
| funding | `funding_cum48`, `funding_z` | ✅ sempre calcolate |
| candle | `wick_reject_bear`, `stoch_cross_bear` | ✅ blocco reversal |

**Nota comportamentale documentata** (non bug): `vol_climax_bull` usa `rsi_14 < 35` come condizione, quindi se l'RSI è tra 35–50 dopo il primo rimbalzo dal bottom, la feature vale 0. Stesso per `vol_climax_bear` con `rsi_14 > 65`. È un design conservativo: i climax di volume all'interno del range non vengono segnalati, solo agli estremi. Accettabile, nessun fix.

---

## Fase 1 — Transition Guard

### Descrizione funzionale

Il Transition Guard agisce **all'entry**, nella fase di calcolo delle soglie del `DecisionEngine`. Quando il `RegimeDetector` segnala che il trend corrente sta probabilmente finendo (`transition_risk ≥ soglia`), alza entrambe le soglie di accettazione (long e short) in modo proporzionale al rischio di transizione. Non vieta nulla — chiede più convinzione a qualsiasi trade in un momento ambiguo.

**Formula**:
```
se transition_guard_enabled AND transition_risk ≥ transition_risk_min:
    boost = transition_boost_max × transition_risk
    threshold_long  += boost
    threshold_short += boost
```

Esempio: base 0.60, transition_risk 0.80, boost_max 0.05 → soglie a 0.64.  
Il boost è asimmetrico per natura (proporzionale al rischio): è zero quando il regime è solido, massimo quando il RegimeDetector ha alta certezza che il regime stia finendo.

**Relazione con Exhaustion Guard**: sono complementari e si sommano. EG difende dal *movimento esteso* (ret_48); TG difende dal *regime che finisce* (ADX peak + slope). Sul trade del 9 giugno: EG → +0.14, TG → +0.04, totale soglia short 0.78 > P(down) 0.715 → trade bloccato.

### Parametri (3 + 1 toggle)

| Parametro | Tipo | Default | Range UI | Note |
|---|---|---|---|---|
| `transition_guard_enabled` | bool | `False` | toggle | Default OFF — validare in backtest |
| `transition_boost_max` | float | `0.05` | 0.02–0.10 | Boost massimo a transition_risk=1.0 |
| `transition_risk_min` | float | `0.55` | 0.40–0.80 | Sotto questa soglia il guard dorme |

### Implementazione Backend

#### `apps/api/services/decision.py`

Aggiungere nel costruttore di `DecisionEngine`, accanto a `exhaustion_guard_enabled`:

```python
self.transition_guard_enabled = transition_guard_enabled
self.transition_boost_max     = transition_boost_max
self.transition_risk_min      = transition_risk_min
```

Aggiungere nel metodo `decide()`, **dopo il blocco Exhaustion Guard** (circa riga 590), prima di Absorption Filter:

```python
# ── Transition Guard: boost soglie quando il regime sta finendo ───────────
# Complementare all'ExhaustionGuard: quello difende dal movimento esteso (ret_48),
# questo difende dal regime che finisce (transition_risk dal RegimeDetector).
if self.transition_guard_enabled:
    _tr_risk = float(features.get("transition_risk", 0.0))
    if _tr_risk >= self.transition_risk_min:
        _tr_boost = self.transition_boost_max * _tr_risk
        threshold_long  += _tr_boost
        threshold_short += _tr_boost
        reasoning.append(
            f"TransitionGuard: transition_risk={_tr_risk:.2f} ≥ {self.transition_risk_min:.2f} "
            f"→ entrambe le soglie +{_tr_boost:.3f}"
        )
```

#### `apps/api/main.py` — BotConfig

Aggiungere dopo il gruppo Exhaustion Guard (circa riga 424):

```python
# ── Transition Guard ──────────────────────────────────────────────────────
transition_guard_enabled: bool  = Field(False)
transition_boost_max:     float = Field(0.05, ge=0.02, le=0.10)
transition_risk_min:      float = Field(0.55, ge=0.40, le=0.80)
```

#### `apps/api/services/execution.py` — EngineConfig

Aggiungere nel costruttore di `EngineConfig`:

```python
self.transition_guard_enabled = kw.get("transition_guard_enabled", False)
self.transition_boost_max     = kw.get("transition_boost_max",     0.05)
self.transition_risk_min      = kw.get("transition_risk_min",      0.55)
```

Nel punto dove viene istanziato `DecisionEngine` (circa riga 1665), aggiungere i tre parametri al costruttore:

```python
transition_guard_enabled = cfg.transition_guard_enabled,
transition_boost_max     = cfg.transition_boost_max,
transition_risk_min      = cfg.transition_risk_min,
```

#### `apps/api/services/backtesting.py`

Aggiungere nel blocco lettura parametri da cfg (con gli altri `getattr`, circa riga 200):

```python
# Transition Guard
transition_guard_enabled = getattr(cfg, "transition_guard_enabled", False)
transition_boost_max     = getattr(cfg, "transition_boost_max",     0.05)
transition_risk_min      = getattr(cfg, "transition_risk_min",      0.55)
```

Passare i tre parametri al costruttore del `DecisionEngine` (circa riga 446):

```python
transition_guard_enabled = transition_guard_enabled,
transition_boost_max     = transition_boost_max,
transition_risk_min      = transition_risk_min,
```

Aggiungere al dict `param_stats` (circa riga 562):

```python
"gate_transition_guard": 0,
```

Incrementare `param_stats["gate_transition_guard"]` quando il guard aggiunge un boost che fa superare la soglia a una barra che avrebbe altrimenti generato un trade (opzionale per analisi, non bloccante).

### Posizione UI — `apps/web/components/trading-hub/BotConfig.tsx`

**Sezione**: `"Filtri Qualità — Decision Engine"` (riga ~4460), immediatamente dopo il blocco `Exhaustion Guard` (riga ~4557).

**Struttura UI** (pattern identico all'Exhaustion Guard esistente):

```tsx
{/* Transition Guard */}
<div className="mt-6 pt-5 border-t border-slate-200/60 dark:border-slate-700/40">
  <div className="flex items-center justify-between mb-3">
    <div>
      <p className="text-[11px] font-bold text-slate-600 dark:text-slate-400 uppercase tracking-widest">
        Transition Guard
      </p>
      <p className="text-[10px] text-slate-400 dark:text-slate-500 mt-0.5">
        Alza le soglie quando il regime sta finendo. Complementare all'Exhaustion Guard.
        Default OFF — validare in backtest prima del live.
      </p>
    </div>
    <Toggle
      checked={config.transition_guard_enabled}
      onChange={v => update("transition_guard_enabled", v)}
    />
  </div>

  {config.transition_guard_enabled && (
    <div className="grid grid-cols-2 gap-4 mt-3">
      <SliderField
        label="Boost Massimo"
        value={config.transition_boost_max}
        min={0.02} max={0.10} step={0.01}
        format={v => `+${(v * 100).toFixed(0)}%`}
        tooltip="Boost alla soglia quando transition_risk = 1.0. Es. 0.05 → soglia 0.65 con base 0.60."
        onChange={v => update("transition_boost_max", v)}
      />
      <SliderField
        label="Rischio Min Attivazione"
        value={config.transition_risk_min}
        min={0.40} max={0.80} step={0.05}
        format={v => v.toFixed(2)}
        tooltip="Il guard si attiva solo se transition_risk ≥ questo valore. Default 0.55."
        onChange={v => update("transition_risk_min", v)}
      />
    </div>
  )}
</div>
```

**Sezione Backtest** — aggiungere gli stessi controlli nel `BacktestPanel.tsx` nella sezione "Filtri" o "Protezioni Entry", pattern identico a come vengono esposti gli altri parametri del DecisionEngine.

---

## Fase 2 — Adverse Evidence Monitor

### Descrizione funzionale (in parole semplici)

Con una posizione aperta, ogni 4 ore il sistema chiede al `ReversalZoneDetector`: "c'è evidenza strutturale che il mercato voglia andare nella direzione opposta alla mia posizione?". Se la risposta è sì per **N cicli consecutivi**, prende un'azione difensiva configurabile.

**Flusso dettagliato**:
- SHORT aperto → il monitor guarda il `score bullish` del ReversalZoneDetector (l'evidenza *contro* la posizione)
- Se `score_bullish ≥ adverse_score_threshold` con `≥ adverse_min_components` componenti attivi → `adverse_strikes += 1`; altrimenti `adverse_strikes = 0` (reset: un segnale isolato non conta)
- Se `adverse_strikes ≥ adverse_confirm_cycles` → esegue `adverse_action`
- Non agisce nelle prime `adverse_min_hold_bars` barre (rumore post-entry)

**`adverse_action` options**:
- `shadow`: logga l'evento senza agire (modalità osservazione, **default** per le prime settimane)
- `tighten_sl`: sposta SL a breakeven + 0.3×ATR (protegge il capitale senza chiudere)
- `partial_close`: chiude `adverse_partial_pct`% della posizione (riduzione rischio)
- `close`: chiude l'intera posizione

**Perché non è LGBM Exit esteso**: LGBM Exit chiede allo stesso modello 4H "hai cambiato idea?" — ma il modello è ancorato, quindi non cambierà idea finché il movimento non è già avanzato. L'Adverse Monitor usa una fonte *indipendente* (7 componenti strutturali, di momentum, di volume) che vede quello che il LGBM non vede. I due meccanismi sono ortogonali e devono restare separati.

### Parametri (6 + 1 toggle)

| Parametro | Tipo | Default | Range UI | Note |
|---|---|---|---|---|
| `adverse_monitor_enabled` | bool | `False` | toggle | Default OFF — usare shadow per calibrare |
| `adverse_action` | enum | `"shadow"` | shadow/tighten_sl/partial_close/close | Azione quando strikes raggiunto |
| `adverse_score_threshold` | float | `0.40` | 0.30–0.60 | Leggermente sopra reversal_score_threshold (0.34–0.36) |
| `adverse_confirm_cycles` | int | `2` | 1–4 | Cicli consecutivi richiesti |
| `adverse_min_hold_bars` | int | `3` | 1–8 | Non agire nelle prime N barre |
| `adverse_partial_pct` | float | `0.50` | 0.25–0.75 | Solo per partial_close |

### Implementazione Backend

#### `apps/api/services/execution.py` — EngineConfig

Aggiungere nel costruttore di `EngineConfig`:

```python
self.adverse_monitor_enabled  = kw.get("adverse_monitor_enabled",  False)
self.adverse_action           = kw.get("adverse_action",           "shadow")
self.adverse_score_threshold  = kw.get("adverse_score_threshold",  0.40)
self.adverse_confirm_cycles   = kw.get("adverse_confirm_cycles",   2)
self.adverse_min_hold_bars    = kw.get("adverse_min_hold_bars",    3)
self.adverse_partial_pct      = kw.get("adverse_partial_pct",      0.50)
```

Nel costruttore di `TradingEngine`, aggiungere il contatore strikes:

```python
self._adverse_strikes: int = 0   # reset a ogni nuovo trade
```

#### Loop principale — inserimento nel ciclo di gestione posizione

Il codice va inserito nel punto del ciclo dove `self._position is not None`, **dopo** il calcolo di `_reversal_result` (già disponibile grazie al blocco esistente a ~riga 1592) e **prima** dei controlli SL/TP. Il punto esatto è circa riga 2141 (dopo il block "Heartbeat").

```python
# ── Adverse Evidence Monitor ──────────────────────────────────────────────
# Usa il reversal score già calcolato sopra per la direzione opposta alla posizione.
# _reversal_result è sempre disponibile quando reversal_mode_enabled=True.
if (
    getattr(self.config, "adverse_monitor_enabled", False)
    and self._position is not None
    and _reversal_result is not None
    and getattr(self.config, "reversal_mode_enabled", False)
):
    _pos_side        = self._position["side"]
    _bars_held       = self._position.get("bars_held", 0)
    _min_hold        = getattr(self.config, "adverse_min_hold_bars", 3)
    _score_thr       = getattr(self.config, "adverse_score_threshold", 0.40)
    _confirm_needed  = getattr(self.config, "adverse_confirm_cycles", 2)
    _action          = getattr(self.config, "adverse_action", "shadow")

    # Direzione contraria alla posizione
    _adverse_dir     = "long" if _pos_side == "short" else "short"

    # Score nella direzione avversa (raw dai componenti bear/bull)
    _rev_components  = _reversal_result.components  # dict già calcolato
    # Re-run score nella direzione opposta (il ReversalResult contiene i components
    # della direzione vincente; quando non coincide con _adverse_dir, ricalcoliamo)
    if _reversal_result.direction == _adverse_dir:
        _adverse_score = _reversal_result.score
        _adverse_count = _reversal_result.component_count
    else:
        # Il detector non ha scelto la direzione avversa → score grezzo dei componenti
        # nella direzione avversa non è nel result corrente. Usiamo bear/bull raw score
        # ricalcolando via helper (solo se position è aperta e monitor è attivo).
        _rz = ReversalZoneDetector()
        _adv_feat = df_feat.iloc[-1].to_dict()
        if _adverse_dir == "long":
            _raw = {c: getattr(_rz, f"_{c}_bull")(_adv_feat, self.config) for c in _rz.WEIGHTS}
        else:
            _raw = {c: getattr(_rz, f"_{c}_bear")(_adv_feat, self.config) for c in _rz.WEIGHTS}
        _adverse_score = sum(_rz.WEIGHTS[c] * _raw[c] for c in _rz.WEIGHTS)
        _comp_min      = getattr(self.config, "reversal_component_min_score", 0.40)
        _adverse_count = sum(1 for v in _raw.values() if v > _comp_min)

    if _bars_held >= _min_hold and _adverse_score >= _score_thr and _adverse_count >= 2:
        self._adverse_strikes += 1
        log.info(
            "AdverseMonitor [%s]: score=%.3f components=%d strikes=%d/%d",
            _adverse_dir.upper(), _adverse_score, _adverse_count,
            self._adverse_strikes, _confirm_needed,
        )
    else:
        if self._adverse_strikes > 0:
            log.debug("AdverseMonitor: strikes reset (score=%.3f)", _adverse_score)
        self._adverse_strikes = 0

    if self._adverse_strikes >= _confirm_needed:
        _mark = latest.get("mark_price") or self._ws.latest_mark or 0.0
        log.warning(
            "AdverseMonitor TRIGGERED: action=%s pos=%s score=%.3f bars_held=%d",
            _action, _pos_side, _adverse_score, _bars_held,
        )
        self._adverse_strikes = 0  # reset dopo azione

        if _action == "shadow":
            # Solo log — nessuna azione
            pass
        elif _action == "tighten_sl" and _mark > 0:
            _new_sl = (
                _mark + atr * 0.3 if _pos_side == "short"
                else _mark - atr * 0.3
            )
            if self._position:
                _old_sl = self._position.get("sl", _new_sl)
                # Muovi SL solo se più conservativo dell'attuale
                _should_move = (
                    (_pos_side == "short" and _new_sl < _old_sl) or
                    (_pos_side == "long"  and _new_sl > _old_sl)
                )
                if _should_move:
                    self._position["sl"] = _new_sl
                    log.info("AdverseMonitor: SL tightened to %.2f", _new_sl)
        elif _action == "partial_close" and _mark > 0:
            _pct = getattr(self.config, "adverse_partial_pct", 0.50)
            asyncio.create_task(self._close_partial(_pct, _mark, "adverse_monitor"))
        elif _action == "close" and _mark > 0:
            await self._close_position(_mark, "adverse_monitor")
```

**Reset a ogni nuovo trade**: nel codice di apertura posizione aggiungere `self._adverse_strikes = 0`.

#### `apps/api/main.py` — BotConfig

Aggiungere dopo il blocco LGBM Exit (circa riga 430):

```python
# ── Adverse Evidence Monitor ──────────────────────────────────────────────
adverse_monitor_enabled: bool  = Field(False)
adverse_action:          str   = Field("shadow", pattern="^(shadow|tighten_sl|partial_close|close)$")
adverse_score_threshold: float = Field(0.40, ge=0.25, le=0.65)
adverse_confirm_cycles:  int   = Field(2,    ge=1,    le=4)
adverse_min_hold_bars:   int   = Field(3,    ge=1,    le=8)
adverse_partial_pct:     float = Field(0.50, ge=0.25, le=0.75)
```

#### `apps/api/services/backtesting.py`

**Lettura parametri** (aggiungere con gli altri `getattr`, circa riga 230):

```python
# Adverse Evidence Monitor
adverse_monitor_enabled  = getattr(cfg, "adverse_monitor_enabled",  False)
adverse_action           = getattr(cfg, "adverse_action",           "shadow")
adverse_score_threshold  = getattr(cfg, "adverse_score_threshold",  0.40)
adverse_confirm_cycles   = getattr(cfg, "adverse_confirm_cycles",   2)
adverse_min_hold_bars    = getattr(cfg, "adverse_min_hold_bars",    3)
adverse_partial_pct      = getattr(cfg, "adverse_partial_pct",      0.50)
```

**Variabili di stato** nel loop (aggiungere dopo `pending_rev = None`):

```python
adverse_strikes = 0  # reset a ogni nuovo trade
```

**Istanziazione detector** (già esiste `_bt_rev_detector`; riutilizzarlo):

```python
if adverse_monitor_enabled and not reversal_mode_enabled:
    # Monitor richiede il detector anche se il reversal entry è off
    from services.reversal_detector import ReversalZoneDetector
    _bt_rev_detector = ReversalZoneDetector()
```

**Loop di gestione posizione**: inserire immediatamente dopo il blocco `lgbm_exit` (~riga 1195), prima del max_hold check:

```python
# ── Adverse Evidence Monitor (backtest) ──────────────────────────────────
if (
    adverse_monitor_enabled
    and position is not None
    and not already_closed
    and _bt_rev_detector is not None
    and bars_held >= adverse_min_hold_bars
):
    _pos_side = position["side"]
    _adverse_dir = "long" if _pos_side == "short" else "short"
    _df_slice = df_feat.iloc[:i+1]

    if _adverse_dir == "long":
        _raw_scores = {
            c: getattr(_bt_rev_detector, f"_{c}_bull")(row.to_dict(), cfg)
            for c in _bt_rev_detector.WEIGHTS
        }
    else:
        _raw_scores = {
            c: getattr(_bt_rev_detector, f"_{c}_bear")(row.to_dict(), cfg)
            for c in _bt_rev_detector.WEIGHTS
        }

    _adv_score = sum(_bt_rev_detector.WEIGHTS[c] * _raw_scores[c] for c in _bt_rev_detector.WEIGHTS)
    _comp_min  = getattr(cfg, "reversal_component_min_score", 0.40)
    _adv_count = sum(1 for v in _raw_scores.values() if v > _comp_min)

    if _adv_score >= adverse_score_threshold and _adv_count >= 2:
        adverse_strikes += 1
    else:
        adverse_strikes = 0

    if adverse_strikes >= adverse_confirm_cycles:
        adverse_strikes = 0
        param_stats["pm_adverse_monitor"] += 1

        if adverse_action == "tighten_sl":
            _atr_now = float(row.get("atr_14", 1.0))
            _new_sl  = (close_price + _atr_now * 0.3 if _pos_side == "short"
                        else close_price - _atr_now * 0.3)
            if _pos_side == "short" and _new_sl < position["sl"]:
                position["sl"] = _new_sl
            elif _pos_side == "long" and _new_sl > position["sl"]:
                position["sl"] = _new_sl

        elif adverse_action in ("partial_close", "close"):
            _pct     = adverse_partial_pct if adverse_action == "partial_close" else 1.0
            _pnl_pct = (close_price - entry) / entry * 100 if _pos_side == "long" \
                       else (entry - close_price) / entry * 100
            _size_closed = position["size_usd"] * _pct
            _pnl_usd     = _size_closed * _pnl_pct / 100
            _fee         = _size_closed * HL_TAKER_FEE
            equity      += _pnl_usd - _fee
            trades.append({
                "side": _pos_side, "entry": entry, "exit": close_price,
                "pnl_pct":      round(_pnl_pct * _pct, 4),
                "pnl_usd":      round(_pnl_usd - _fee, 2),
                "fee_entry":    round(position.get("fee_entry", 0.0) * _pct, 2),
                "funding_paid": round(position.get("funding_paid", 0.0) * _pct, 2),
                "reason":       f"adverse_monitor_{adverse_action}",
                "holding_bars": bars_held,
                "bar":          i,
                "origin":       position.get("origin", "trend"),
                "date":         str(row.name.date()) if hasattr(row.name, "date") else "",
                "equity_after": round(equity, 2),
            })
            if adverse_action == "close":
                equity_curve.append({"bar": i, "equity": round(equity, 2)})
                position       = None
                already_closed = True
            else:
                position["size_usd"] *= (1.0 - _pct)
```

**Reset strikes a ogni nuovo trade**: nel codice di apertura posizione (tutti i branch) aggiungere `adverse_strikes = 0`.

**`param_stats`** — aggiungere:

```python
"pm_adverse_monitor": 0,
```

**`features_used`** nel summary finale — aggiungere alla lista:

```python
"adv_monitor_action": adverse_monitor_enabled and adverse_action != "shadow",
```

### Posizione UI — `apps/web/components/trading-hub/BotConfig.tsx`

**Sezione**: `"Strategie di Uscita"` (riga ~4202), subito dopo il blocco LGBM Exit.

**Struttura UI**:

```tsx
{/* Adverse Evidence Monitor */}
<div className="mt-6 pt-5 border-t border-slate-200/60 dark:border-slate-700/40">
  <div className="flex items-center justify-between mb-3">
    <div>
      <p className="text-[11px] font-bold text-slate-600 dark:text-slate-400 uppercase tracking-widest">
        Adverse Evidence Monitor
      </p>
      <p className="text-[10px] text-slate-400 dark:text-slate-500 mt-0.5">
        Con posizione aperta, se il Reversal Detector segnala evidenza strutturale
        contro la posizione per N cicli consecutivi, agisce in modo difensivo.
        Richiede Reversal Mode attivo. Default OFF — usare "shadow" per calibrare.
      </p>
    </div>
    <Toggle
      checked={config.adverse_monitor_enabled}
      onChange={v => update("adverse_monitor_enabled", v)}
      disabled={!config.reversal_mode_enabled}
    />
  </div>

  {!config.reversal_mode_enabled && config.adverse_monitor_enabled && (
    <p className="text-[10px] text-amber-500 mt-1">
      ⚠ Richiede Reversal Zone Detector attivo
    </p>
  )}

  {config.adverse_monitor_enabled && (
    <div className="space-y-4 mt-3">
      {/* Azione */}
      <SelectField
        label="Azione"
        value={config.adverse_action}
        options={[
          { value: "shadow",        label: "Shadow — solo log, nessuna azione" },
          { value: "tighten_sl",    label: "Tighten SL — porta SL a breakeven +0.3×ATR" },
          { value: "partial_close", label: "Partial Close — chiudi % della posizione" },
          { value: "close",         label: "Close — chiudi tutto" },
        ]}
        onChange={v => update("adverse_action", v)}
      />

      <div className="grid grid-cols-2 gap-4">
        <SliderField
          label="Score Minimo"
          value={config.adverse_score_threshold}
          min={0.30} max={0.60} step={0.02}
          format={v => v.toFixed(2)}
          tooltip="Soglia reversal score nella direzione opposta. Leggermente sopra reversal_score_threshold."
          onChange={v => update("adverse_score_threshold", v)}
        />
        <SliderField
          label="Cicli Consecutivi"
          value={config.adverse_confirm_cycles}
          min={1} max={4} step={1}
          format={v => `${v} cicli`}
          tooltip="Quanti cicli 4H consecutivi con evidenza avversa prima di agire."
          onChange={v => update("adverse_confirm_cycles", v)}
        />
        <SliderField
          label="Hold Minimo (barre)"
          value={config.adverse_min_hold_bars}
          min={1} max={8} step={1}
          format={v => `${v} barre`}
          tooltip="Non agisce nelle prime N barre — riduce il rumore post-entry."
          onChange={v => update("adverse_min_hold_bars", v)}
        />
        {config.adverse_action === "partial_close" && (
          <SliderField
            label="% da Chiudere"
            value={config.adverse_partial_pct}
            min={0.25} max={0.75} step={0.05}
            format={v => `${(v * 100).toFixed(0)}%`}
            onChange={v => update("adverse_partial_pct", v)}
          />
        )}
      </div>
    </div>
  )}
</div>
```

**Sezione Backtest** — identica ma con nota "shadow mode sempre attivo in backtest con action=close/partial_close per osservare prima di portare in live".

---

## Ordine di esecuzione raccomandato

```
Fase 0A  →  Fix adx_14_lag3 in smc.py                   (30 min, priorità alta)
Fase 0B  →  Fix default score_threshold nel detector     (5 min)
Fase 1   →  Transition Guard backend                     (1–2h)
Fase 1   →  Transition Guard frontend                    (1h)
Fase 1   →  Backtest TG: validare su 2023-2026 BTC/ETH  (osservazione)
Fase 2   →  Adverse Monitor backend (shadow mode)        (3–4h)
Fase 2   →  Adverse Monitor frontend                     (1.5h)
Fase 2   →  Adverse Monitor in shadow 2–4 settimane     (calibrazione)
Fase 2   →  Promuovere a tighten_sl dopo calibrazione   (decisione operativa)
```

---

## Note di rischio e testing

### Transition Guard
- **Rischio zero o negativo**: peggio che può fare è bloccare qualche trade borderline. Non introduce side-effect sul sistema esistente.
- **Test minimo prima del live**: backtest 2023–2026 con vs. senza, verificare che i trade bloccati siano effettivamente i peggiori per R:R e non riducano win_rate su trade di alta qualità.
- **Parametri iniziali consigliati**: `boost_max=0.05`, `risk_min=0.60` (più conservativo del default 0.55 per iniziare).

### Adverse Evidence Monitor
- **Dipendenza**: richiede `reversal_mode_enabled=True` — il calcolo del reversal score è già nel loop, il monitor è solo un consumatore aggiuntivo del risultato.
- **Shadow mode obbligatorio all'inizio**: non passare mai direttamente a `close` senza almeno 2–4 settimane di shadow. Analizzare i log per verificare quante volte avrebbe agito e con quale outcome.
- **Falsi positivi attesi**: in mercati trending forti, il reversal score nella direzione opposta può salire brevemente senza inversione reale. Il `confirm_cycles=2` riduce ma non elimina questo. Aumentare a 3 se shadow mostra falsi positivi frequenti.
- **Il backtest in shadow non produce differenze equity** — è per design: serve solo a costruire la statistica `pm_adverse_monitor` per sapere quante volte avrebbe agito.

### Nota sul deploy
Entrambe le feature hanno `enabled=False` come default → un deploy normale non cambia il comportamento del sistema live finché l'utente non attiva esplicitamente i toggle. Nessuna migrazione DB necessaria — `BotConfig` usa `getattr` con fallback dappertutto.
