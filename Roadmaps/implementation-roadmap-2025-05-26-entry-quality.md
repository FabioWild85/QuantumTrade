# Implementation Roadmap — Entry Quality & Ranging Market Improvements
**Data:** 26 Maggio 2025
**File:** `Roadmaps/implementation-roadmap-2025-05-26-entry-quality.md`
**Stato:** Piano — codice non modificato

---

## Panoramica

Questo piano risolve il problema delle entrate in mercati laterali e delle entrate tardive nei trend (entrambi causano SL ravvicinati colpiti dal noise). I miglioramenti operano esclusivamente su dati già calcolati (nessuna nuova API, nessun nuovo WebSocket), sono tutti backtestabili (eccetto Feature D in modalità live che usa ATR_21 calcolato in smc.py).

**Feature coperte:**

| ID | Nome | File toccati |
|----|------|-------------|
| A | Ranging Regime Gate | `main.py`, `decision.py`, `execution.py`, `backtesting.py` |
| B | Late Entry Distance Filter | `main.py`, `decision.py` |
| C | Path Obstruction Gate | `main.py`, `decision.py` |
| D | Dual ATR per SL | `main.py`, `smc.py`, `execution.py`, `risk.py`, `backtesting.py` |
| E | SL Buffer Enhancement | `main.py`, `execution.py`, `risk.py`, `backtesting.py` |
| F | Consecutive Bars Filter | `main.py`, `smc.py`, `decision.py`, `backtesting.py` |

**Nuovi BotConfig field totali: 14**

---

## Feature A — Ranging Regime Gate

### Problema
Il `RegimeDetector` classifica già il mercato come `sideways`, `flat` o `transition`. Queste classificazioni vengono usate solo per il `regime_bias` (adjustment del threshold). Nessun gate blocca le nuove entrate in regime laterale, che è il contesto in cui i segnali trend-following sono sistematicamente inaffidabili.

### Meccanismo
1. Ogni 4 cicli, `self._regime_signal` è aggiornato da `RegimeDetector.detect()` (già implementato).
2. Il regime 4H viene iniettato nel dict `latest` come `latest["regime_4h"]`.
3. In `DecisionEngine.decide()`, un nuovo gate blocca le nuove entrate se il regime corrente è nella lista dei regimi bloccati.
4. In backtest: `RegimeDetector.detect()` viene pre-calcolato per tutti i candles PRIMA del loop principale, i valori vengono memorizzati in un array indicizzato per barra.

### Logica del Gate
```
IF ranging_gate_enabled AND regime_4h IN {blocked_regimes}:
    → GATE: Regime {regime_4h} — no new entries
```
Il gate blocca SOLO nuove entrate — non chiude posizioni aperte.

### Posizione nel Pipeline di decision.py
Inserito **dopo ExhaustionGuard** e **dopo AbsorptionFilter**, **prima di SweepConfluence**. A questo punto tutti i gate basati su volatilità e probabilità sono già stati verificati. Il ranging gate funziona come ultima linea di difesa prima del controllo confluence.

### Modifiche per file

#### `apps/api/main.py` — BotConfig
```python
# Ranging Regime Gate (4H regime-based entry filter)
ranging_gate_enabled:           bool  = Field(False)
ranging_gate_block_sideways:    bool  = Field(True)
ranging_gate_block_flat:        bool  = Field(True)
ranging_gate_block_transition:  bool  = Field(False)
```

#### `apps/api/services/decision.py` — DecisionEngine

**In `__init__()`, aggiungere 4 parametri:**
```python
ranging_gate_enabled:          bool = False,
ranging_gate_block_sideways:   bool = True,
ranging_gate_block_flat:       bool = True,
ranging_gate_block_transition: bool = False,
```
E i rispettivi `self.` in corpo del costruttore.

**In `decide()`, dopo il blocco AbsorptionFilter (riga ~251) e prima del blocco SweepConfluence:**
```python
# ── Ranging Regime Gate ───────────────────────────────────────────────────
# Blocks new entries when 4H regime is in a ranging/flat/transition state.
# regime_4h is injected from _cycle() via latest dict; None = not available.
if self.ranging_gate_enabled:
    regime_4h = str(features.get("regime_4h") or "")
    _blocked = (
        (regime_4h == "sideways"   and self.ranging_gate_block_sideways)   or
        (regime_4h == "flat"       and self.ranging_gate_block_flat)        or
        (regime_4h == "transition" and self.ranging_gate_block_transition)
    )
    if _blocked:
        reasoning.append(
            f"GATE: RangingRegime — regime_4h={regime_4h} — no new entries in ranging market"
        )
        return self._no_trade(reasoning, dir_prob, p10, p50, p90, features, c2_uncertainty)
```

**In `__init__()` del DecisionEngine, in esecuzione.py aggiungere i 4 parametri al costruttore DecisionEngine.**

#### `apps/api/services/execution.py` — `_cycle()`

Dopo il blocco regime detection (riga ~751), iniettare nel dict `latest`:
```python
# Inject 4H regime into features dict for RangingGate in DecisionEngine
latest["regime_4h"] = self._regime_signal.regime if self._regime_signal else None
```

**Nel costruttore `DecisionEngine(...)` (riga ~768), aggiungere:**
```python
ranging_gate_enabled          = cfg.ranging_gate_enabled,
ranging_gate_block_sideways   = cfg.ranging_gate_block_sideways,
ranging_gate_block_flat       = cfg.ranging_gate_block_flat,
ranging_gate_block_transition = cfg.ranging_gate_block_transition,
```

#### `apps/api/services/backtesting.py`

**Leggere i nuovi parametri da cfg (blocco getattr iniziale):**
```python
ranging_gate_enabled          = getattr(cfg, "ranging_gate_enabled",          False)
ranging_gate_block_sideways   = getattr(cfg, "ranging_gate_block_sideways",   True)
ranging_gate_block_flat       = getattr(cfg, "ranging_gate_block_flat",       True)
ranging_gate_block_transition = getattr(cfg, "ranging_gate_block_transition", False)
```

**Pre-computazione regimi (inserire PRIMA del loop `for i in range(len(df_feat))`, dopo la costruzione di `decision_engine`):**
```python
# Pre-compute 4H regimes for all bars (RegimeDetector needs ≥ cfg rows)
# Only worth doing if ranging_gate is enabled — it's ~O(N²) work otherwise.
_regime_cache: list[Optional[str]] = [None] * len(df_feat)
if ranging_gate_enabled:
    from services.regime_detector import RegimeDetector as _RD
    _rd_bt = _RD()
    for _ri in range(len(df_feat)):
        if _ri % 4 == 0 and _ri >= 64:   # 64-bar warmup
            try:
                _sig = _rd_bt.detect(df_feat.iloc[:_ri + 1])
                _regime_cache[_ri] = _sig.regime
            except Exception:
                pass
        elif _ri > 0:
            _regime_cache[_ri] = _regime_cache[_ri - 1]  # carry forward
```

**All'inizio del loop, iniettare il regime nella features dict:**
```python
features["regime_4h"] = _regime_cache[i]
```

**Nel costruttore `DecisionEngine(...)`, aggiungere i 4 parametri:**
```python
ranging_gate_enabled          = ranging_gate_enabled,
ranging_gate_block_sideways   = ranging_gate_block_sideways,
ranging_gate_block_flat       = ranging_gate_block_flat,
ranging_gate_block_transition = ranging_gate_block_transition,
```

### Toggle
- Paper/Live: `BotConfig.ranging_gate_enabled` — disponibile via PUT `/bot`
- Backtest: `getattr(cfg, "ranging_gate_enabled", False)` — disponibile via PUT `/bot/backtest`

### Risultati attesi
- Riduzione ~20-35% delle entrate in mercato laterale
- Riduzione del numero totale di trade (minor overtrading)
- Miglioramento del win rate in condizioni di bassa volatilità (`adx_14 < 20`)
- Potenziale riduzione del profit factor se si saltano anche rari trend iniziali che partono da regimi laterali → bilanciare con `ranging_gate_block_transition: False` come default

---

## Feature B — Late Entry Distance Filter

### Problema
Il bot può entrare long su un segnale valido, ma il prezzo è già salito significativamente dall'Order Block che ha generato il momentum. L'OB è il livello strutturale reale — entrare 4-5 ATR sopra di esso significa che la mossa è già matura, lo stop deve essere lontano, e il R:R è compresso.

### Meccanismo
`ob_bull_dist` (già calcolato in `smc.py`) rappresenta la distanza ATR-normalizzata tra il prezzo attuale e il midpoint del Bull Order Block: `(close - OB_mid) / ATR_14`. Valore grande positivo = prezzo molto sopra l'OB = entrata tardiva per un long.

Analogamente, `ob_bear_dist = (OB_mid - close) / ATR_14`. Valore grande positivo = prezzo molto sotto il Bear OB = entrata tardiva per uno short.

### Posizione nel Pipeline
Inserito all'interno dei blocchi Long Signal e Short Signal in `decide()`, **dopo il check FVG** e **prima dell'emissione del segnale**. La direzione è già determinata — il check è direzionale.

### Modifiche per file

#### `apps/api/main.py` — BotConfig
```python
# Late Entry Distance Filter
late_entry_filter_enabled: bool  = Field(False)
late_entry_max_ob_dist:    float = Field(3.0, ge=1.0, le=8.0)
```

#### `apps/api/services/decision.py` — DecisionEngine

**In `__init__()`, aggiungere 2 parametri:**
```python
late_entry_filter_enabled: bool  = False,
late_entry_max_ob_dist:    float = 3.0,
```

**Nel blocco Long Signal (dopo il check FVG bearish, prima del return):**
```python
# Late entry filter: skip long if price is too far from bull OB (momentum exhausted)
if self.late_entry_filter_enabled:
    _ob_bull_dist = float(features.get("ob_bull_dist") or 0.0)
    _ob_bull_active = float(features.get("ob_bull_active") or 0.0)
    if _ob_bull_active == 1.0 and _ob_bull_dist > self.late_entry_max_ob_dist:
        reasoning.append(
            f"FILTER: LateEntry — ob_bull_dist={_ob_bull_dist:.2f} > "
            f"{self.late_entry_max_ob_dist:.1f} ATR — entry too far from OB"
        )
        return self._no_trade(reasoning, dir_prob, p10, p50, p90, features, c2_uncertainty)
```

**Nel blocco Short Signal (analogamente):**
```python
if self.late_entry_filter_enabled:
    _ob_bear_dist = float(features.get("ob_bear_dist") or 0.0)
    _ob_bear_active = float(features.get("ob_bear_active") or 0.0)
    if _ob_bear_active == 1.0 and _ob_bear_dist > self.late_entry_max_ob_dist:
        reasoning.append(
            f"FILTER: LateEntry — ob_bear_dist={_ob_bear_dist:.2f} > "
            f"{self.late_entry_max_ob_dist:.1f} ATR — entry too far from OB"
        )
        return self._no_trade(reasoning, dir_prob, p10, p50, p90, features, c2_uncertainty)
```

**In `execution.py` e `backtesting.py`:** Aggiungere i 2 parametri al costruttore `DecisionEngine(...)`:
```python
late_entry_filter_enabled = cfg.late_entry_filter_enabled,
late_entry_max_ob_dist    = cfg.late_entry_max_ob_dist,
```
(Per backtesting: `getattr` da cfg come per gli altri parametri.)

### Nota importante
Il filter si attiva solo quando `ob_bull_active == 1.0` (OB attivo). Se non c'è un OB attivo, il filter viene ignorato — evita di bloccare trade legittimi in assenza di struttura.

### Toggle
- Paper/Live: `BotConfig.late_entry_filter_enabled`
- Backtest: `getattr(cfg, "late_entry_filter_enabled", False)`

### Risultati attesi
- Riduzione delle entrate in estensioni di mercato
- Miglioramento del R:R medio (si entra più vicini alla struttura, lo stop è naturalmente più stretto)
- Potenziale riduzione del numero di trade del 10-20% nei trend estesi

---

## Feature C — Path Obstruction Gate

### Problema
Entrare long con una resistenza (Bear OB) a 1-2 ATR sopra l'entry significa che il prezzo dovrà superare quella resistenza per raggiungere il TP. Il mercato spesso inverte lì. Stessa logica per gli short con un supporto (Bull OB) vicino sotto.

### Meccanismo
- **Long entry:** `ob_bear_dist = (bear_OB_mid - close) / ATR_14`. Valore piccolo positivo (es. 0.5-1.5 ATR) = resistenza appena sopra l'entry → ostruzione.
- **Short entry:** `ob_bull_dist = (close - bull_OB_mid) / ATR_14`. Valore piccolo positivo = supporto appena sotto l'entry → ostruzione.

Differenza da Feature B: Feature B blocca entrate **lontane** dalla struttura favorevole (OB nella propria direzione). Feature C blocca entrate con struttura **contraria** troppo vicina.

### Posizione nel Pipeline
Inserito all'interno dei blocchi Long Signal e Short Signal, dopo il Late Entry Filter (Feature B) e prima dell'emissione del segnale.

### Modifiche per file

#### `apps/api/main.py` — BotConfig
```python
# Path Obstruction Gate
path_obstruction_enabled:  bool  = Field(False)
path_obstruction_max_dist: float = Field(1.5, ge=0.5, le=4.0)
```

#### `apps/api/services/decision.py` — DecisionEngine

**In `__init__()`, aggiungere 2 parametri:**
```python
path_obstruction_enabled:  bool  = False,
path_obstruction_max_dist: float = 1.5,
```

**Nel blocco Long Signal (dopo Late Entry Filter, prima del return):**
```python
# Path obstruction: skip long if bearish OB (resistance) is too close overhead
if self.path_obstruction_enabled:
    _ob_bear_dist_overhead = float(features.get("ob_bear_dist") or 999.0)
    _ob_bear_active = float(features.get("ob_bear_active") or 0.0)
    if (
        _ob_bear_active == 1.0
        and 0 < _ob_bear_dist_overhead < self.path_obstruction_max_dist
    ):
        reasoning.append(
            f"FILTER: PathObstruction — bear OB overhead at "
            f"{_ob_bear_dist_overhead:.2f} ATR < {self.path_obstruction_max_dist:.1f} — "
            f"resistance blocks long path"
        )
        return self._no_trade(reasoning, dir_prob, p10, p50, p90, features, c2_uncertainty)
```

**Nel blocco Short Signal (analogamente):**
```python
if self.path_obstruction_enabled:
    _ob_bull_dist_below = float(features.get("ob_bull_dist") or 999.0)
    _ob_bull_active = float(features.get("ob_bull_active") or 0.0)
    if (
        _ob_bull_active == 1.0
        and 0 < _ob_bull_dist_below < self.path_obstruction_max_dist
    ):
        reasoning.append(
            f"FILTER: PathObstruction — bull OB below at "
            f"{_ob_bull_dist_below:.2f} ATR < {self.path_obstruction_max_dist:.1f} — "
            f"support blocks short path"
        )
        return self._no_trade(reasoning, dir_prob, p10, p50, p90, features, c2_uncertainty)
```

**In `execution.py` e `backtesting.py`:** Aggiungere i 2 parametri al costruttore `DecisionEngine(...)`:
```python
path_obstruction_enabled  = cfg.path_obstruction_enabled,
path_obstruction_max_dist = cfg.path_obstruction_max_dist,
```

### Note di calibrazione
`path_obstruction_max_dist = 1.5` ATR è un valore conservativo — a BTC 4H, 1.5 ATR ≈ $1,500-2,000 in mercato normale. Abbassare a `1.0` ATR per ridurre i falsi positivi. Non scendere sotto `0.5` ATR (troppo restrittivo — bloccherebbe quasi ogni entrata dove esiste un OB vicino).

### Toggle
- Paper/Live: `BotConfig.path_obstruction_enabled`
- Backtest: `getattr(cfg, "path_obstruction_enabled", False)`

---

## Feature D — Dual ATR per Stop Loss

### Problema
`ATR_14` è reattivo — risponde ai picchi di volatilità nelle ultime 14 barre. In periodi di alta volatilità, ATR_14 gonfia e lo SL si allarga (buono); ma un singolo candle con spike altissimo può causare ATR_14 a esplodere temporaneamente, portando uno SL eccessivamente largo che riduce la position size e il R:R.

Usare `ATR_21` per lo SL — più smooth, meno soggetto a spike singoli — mentre il TP rimane su ATR_14 (più reattivo, vuole catturare il momentum recente).

### Meccanismo
- `ATR_21` calcolato in `smc.build_all_features()` come colonna aggiuntiva (NON aggiunta a `FEATURE_GROUPS`/`ALL_FEATURES` — non viene usata da LGBM).
- In `execution.py _cycle()` e `backtesting.py`: se `dual_atr_enabled`, il valore `atr_21` viene estratto dalla features row e passato come `sl_atr` a `calculate_trade_params()`.
- In `risk.py calculate_trade_params()`: nuovo parametro opzionale `sl_atr`. Se fornito, `sl_dist = sl_atr * sl_atr_mult`; `tp_dist` rimane su `atr * tp_atr_mult`.

### Modifiche per file

#### `apps/api/main.py` — BotConfig
```python
# Dual ATR: separate ATR periods for SL (smoothed) and TP (reactive)
dual_atr_enabled: bool = Field(False)
```

#### `apps/api/services/smc.py` — `build_all_features()`

Nel blocco "Base indicators" (dopo `d["atr_14"] = ...`):
```python
d["atr_21"] = ta.volatility.AverageTrueRange(high, low, close, 21).average_true_range()
```

Questa riga è sufficiente. `atr_21` sarà disponibile in `df_feat` e in `latest` senza modificare `FEATURE_GROUPS` — quindi non entra nel training LGBM.

#### `apps/api/services/risk.py` — `calculate_trade_params()`

**Cambiare la firma:**
```python
def calculate_trade_params(
    self,
    side: Side,
    entry_price: float,
    atr: float,
    equity_usd: float,
    sl_atr: Optional[float] = None,    # NEW: if provided, used for SL distance only
    c2_p10: Optional[float] = None,
    c2_p90: Optional[float] = None,
    c2_uncertainty: Optional[float] = None,
    dynamic_sl_tp_enabled: bool = False,
    dynamic_sl_tp_blend: float = 0.50,
    recalibrated_uncertainty_thresholds: bool = True,
    p10_sl_floor_enabled: bool = False,
) -> TradeParams:
```

**All'inizio del corpo, prima del calcolo delle distanze (riga ~82):**
```python
# Use sl_atr for SL distance when provided (dual ATR mode); TP always uses atr
_sl_atr = sl_atr if (sl_atr is not None and sl_atr > 0) else atr
atr_sl_dist = self.sl_atr_mult * _sl_atr
atr_tp_dist = self.tp_atr_mult * atr   # TP sempre su ATR_14
```

Le righe successive che usano `atr_sl_dist` e `atr_tp_dist` rimangono invariate.

**Attenzione:** Il blending Chronos-dynamic SL usa `c2_sl_dist` e poi fa `max(sl_dist, 1.0 * atr)`. Il floor `1.0 * atr` è intenzionale (non deve essere floor su `_sl_atr`). Lasciarlo invariato — il dynamic SL è già calibrato su ATR_14.

**Nel logging `log.info(...)` verso fine funzione**, aggiungere indicazione se sl_atr è diverso da atr:
```python
+ (f" [dual ATR: sl_atr={_sl_atr:.0f} atr={atr:.0f}]"
   if sl_atr is not None and abs(sl_atr - atr) > 1.0 else "")
```

#### `apps/api/services/execution.py` — `_cycle()`

Dopo `atr = latest.get("atr_14")` (riga ~712), aggiungere:
```python
# Dual ATR: ATR_21 for smoother SL sizing (less affected by single-candle spikes)
atr_21_raw = latest.get("atr_21")
atr_sl = (
    float(atr_21_raw)
    if (cfg.dual_atr_enabled and atr_21_raw is not None and pd.notna(atr_21_raw) and float(atr_21_raw) > 0)
    else None
)
```

Nel punto dove viene chiamata `calculate_trade_params()` (nell'area di apertura posizione):
```python
params = self._risk.calculate_trade_params(
    side=result.action,
    entry_price=mark_price,
    atr=atr,
    sl_atr=atr_sl,    # NEW
    equity_usd=equity,
    ...
)
```

#### `apps/api/services/backtesting.py`

**Leggere il nuovo parametro:**
```python
dual_atr_enabled = getattr(cfg, "dual_atr_enabled", False)
```

**All'interno del loop, dove viene calcolato `atr` dalla features row (riga ~192):**
```python
atr_21_raw = features.get("atr_21")
atr_sl = (
    float(atr_21_raw)
    if (dual_atr_enabled and atr_21_raw is not None and pd.notna(atr_21_raw) and float(atr_21_raw) > 0)
    else None
)
```

**Nel `risk.calculate_trade_params(...)`, aggiungere `sl_atr=atr_sl`.**

### Toggle
- Paper/Live: `BotConfig.dual_atr_enabled`
- Backtest: `getattr(cfg, "dual_atr_enabled", False)` — pienamente backtestabile poiché `atr_21` è in `smc.py`

### Risultati attesi
- SL mediamente più stabili: ATR_21 ≈ ATR_14 × 1.05-1.15 in condizioni normali
- Nei periodi di spike di volatilità, ATR_21 può essere 15-25% più stretto di ATR_14
- Effetto netto: SL leggermente più stretti ma più stabili, position size leggermente più grande
- Il beneficio principale non è il win rate ma la stabilità del sizing

---

## Feature E — SL Buffer Enhancement

### Problema
`apply_structural_sl()` usa `ob_buffer_pct = 0.3` hardcoded. Per un Bull OB con bottom a $48,000, il buffer è $144 — circa 0.09 ATR in mercato normale. Questo buffer è spesso troppo stretto: un singolo spike di volatilità intorno all'OB può colpire lo SL prima che il livello sia effettivamente violato strutturalmente.

### Meccanismo
Rendere `ob_buffer_pct` configurabile e aggiungere un buffer minimo basato su ATR (`ob_buffer_min_atr`). Il buffer effettivo = `max(pct_buffer, atr_buffer)`.

`params.atr` è già disponibile all'interno di `apply_structural_sl()` (campo del dataclass `TradeParams`). Non richiede parametri aggiuntivi per l'ATR.

### Modifiche per file

#### `apps/api/main.py` — BotConfig
```python
# Structural SL buffer configuration
ob_buffer_pct:     float = Field(0.3,  ge=0.1, le=2.0)
ob_buffer_min_atr: float = Field(0.0,  ge=0.0, le=0.5)
```
`ob_buffer_min_atr = 0.0` (default) = comportamento invariato rispetto all'attuale.
Valori suggeriti per produzione: `ob_buffer_pct = 0.3`, `ob_buffer_min_atr = 0.1`.

#### `apps/api/services/risk.py` — `apply_structural_sl()`

**Cambiare la firma:**
```python
def apply_structural_sl(
    params: TradeParams,
    features: dict,
    entry_price: float,
    ob_proximity_atr: float = 2.0,
    ob_buffer_pct: float = 0.3,
    ob_buffer_min_atr: float = 0.0,   # NEW: minimum buffer as ATR multiple
) -> tuple[bool, str]:
```

**Sostituire il calcolo del buffer per lo short (riga ~293):**
```python
# Buffer: max of percentage-based and ATR-based minimum
_pct_buf_abs = _ob_top_f * ob_buffer_pct / 100.0
_atr_buf_abs = ob_buffer_min_atr * params.atr if ob_buffer_min_atr > 0 else 0.0
_buf_abs = max(_pct_buf_abs, _atr_buf_abs)
ob_sl = _ob_top_f + _buf_abs
```
(Sostituisce `ob_sl = _ob_top_f * (1.0 + ob_buffer_pct / 100.0)`)

**Sostituire il calcolo per il long (riga ~315):**
```python
_pct_buf_abs = _ob_bot_f * ob_buffer_pct / 100.0
_atr_buf_abs = ob_buffer_min_atr * params.atr if ob_buffer_min_atr > 0 else 0.0
_buf_abs = max(_pct_buf_abs, _atr_buf_abs)
ob_sl = _ob_bot_f - _buf_abs
```
(Sostituisce `ob_sl = _ob_bot_f * (1.0 - ob_buffer_pct / 100.0)`)

**Aggiornare i log message** per riflettere il buffer effettivo:
```python
# Nel log message, aggiungere _buf_abs
f"StructuralSL: bull OB bot={_ob_bot_f:.2f} buf={_buf_abs:.1f} ({_ob_dist_f:.2f} ATR) → SL={ob_sl:.2f} (was {orig_sl:.2f})"
```

#### `apps/api/services/execution.py`

Nella chiamata a `apply_structural_sl()` (trovare con grep `apply_structural_sl`):
```python
apply_structural_sl(
    params, result.features_snapshot, mark_price,
    ob_buffer_pct=cfg.ob_buffer_pct,
    ob_buffer_min_atr=cfg.ob_buffer_min_atr,
)
```

#### `apps/api/services/backtesting.py`

**Leggere i nuovi parametri:**
```python
ob_buffer_pct     = getattr(cfg, "ob_buffer_pct",     0.3)
ob_buffer_min_atr = getattr(cfg, "ob_buffer_min_atr", 0.0)
```

**Nella chiamata a `apply_structural_sl()`:**
```python
apply_structural_sl(
    params, result.features_snapshot, close_price,
    ob_buffer_pct=ob_buffer_pct,
    ob_buffer_min_atr=ob_buffer_min_atr,
)
```

### Toggle
Nessun toggle on/off separato — `ob_buffer_pct` rimpiazza il valore hardcoded, `ob_buffer_min_atr = 0.0` disabilita il comportamento ATR-based. Il parametro `structural_sl_enabled` (già in BotConfig) controlla l'intera funzionalità structural SL.

### Risultati attesi
Con `ob_buffer_min_atr = 0.1` e ATR ≈ $1,500:
- Buffer minimo: $150 (vs. attuale $144 per OB a $48k)
- Buffer per OB a $40k con pct: $120, ma ATR floor porta a $150
- Impatto principale: OB a prezzi bassi o in periodi di bassa volatilità nominale ottengono un buffer proporzionalmente più generoso

---

## Feature F — Consecutive Bars Filter (Trend Age)

### Problema
Entrare in direzione trend dopo 6-8 candele consecutive della stessa direzione è statisticamente peggiore. Il momentum è già prezzato, il mercato è probabilmente in oversold/overbought su timeframe inferiori, e il rischio di pullback è elevato.

### Meccanismo
Nuova feature `consec_bars` in `smc.build_all_features()`:
- Positivo = numero di candele bullish consecutive chiuse (esempio: +5 = 5 chiuse sopra open)
- Negativo = numero di candele bearish consecutive
- Resetta a ±1 al cambio di direzione

Il gate in `decision.py` blocca un long se `consec_bars >= consec_bars_max_long`, e blocca uno short se `consec_bars <= -consec_bars_max_short`.

### Modifiche per file

#### `apps/api/main.py` — BotConfig
```python
# Consecutive Bars Filter (trend age / exhaustion)
consec_bars_filter_enabled: bool = Field(False)
consec_bars_max_long:       int  = Field(8, ge=3, le=20)
consec_bars_max_short:      int  = Field(8, ge=3, le=20)
```

#### `apps/api/services/smc.py` — `build_all_features()`

**Aggiungere alla fine della funzione, prima del `log.debug` e del `return d`:**
```python
# ── Consecutive directional closes ──────────────────────────────────────
# Positive = consecutive bullish closes, negative = consecutive bearish.
# Resets to ±1 on direction change; 0 on doji (open == close).
_closes = d["close"].values
_opens  = d["open"].values
_consec = np.zeros(len(d))
for _ci in range(1, len(d)):
    if _closes[_ci] > _opens[_ci]:    # bullish
        _consec[_ci] = max(_consec[_ci - 1], 0.0) + 1.0
    elif _closes[_ci] < _opens[_ci]:  # bearish
        _consec[_ci] = min(_consec[_ci - 1], 0.0) - 1.0
    # else doji: _consec[_ci] stays 0.0
d["consec_bars"] = _consec
```

**Nota:** `consec_bars` NON viene aggiunta a `FEATURE_GROUPS` né ad `ALL_FEATURES`. Sarà presente nel DataFrame e nel `features` dict di `decision.py`, ma non entrerà nel training LGBM a meno di un'aggiunta esplicita futura.

#### `apps/api/services/decision.py` — DecisionEngine

**In `__init__()`, aggiungere 3 parametri:**
```python
consec_bars_filter_enabled: bool = False,
consec_bars_max_long:       int  = 8,
consec_bars_max_short:      int  = 8,
```

**Nel blocco Long Signal (dopo Path Obstruction, prima del return DecisionResult):**
```python
# Consecutive bars filter: skip if trend is too extended (high reversal risk)
if self.consec_bars_filter_enabled:
    _consec = float(features.get("consec_bars") or 0.0)
    if _consec >= self.consec_bars_max_long:
        reasoning.append(
            f"FILTER: ConsecBars — {int(_consec)} consecutive bull bars ≥ "
            f"{self.consec_bars_max_long} — trend extended, skip long"
        )
        return self._no_trade(reasoning, dir_prob, p10, p50, p90, features, c2_uncertainty)
```

**Nel blocco Short Signal (analogamente):**
```python
if self.consec_bars_filter_enabled:
    _consec = float(features.get("consec_bars") or 0.0)
    if _consec <= -self.consec_bars_max_short:
        reasoning.append(
            f"FILTER: ConsecBars — {int(abs(_consec))} consecutive bear bars ≥ "
            f"{self.consec_bars_max_short} — trend extended, skip short"
        )
        return self._no_trade(reasoning, dir_prob, p10, p50, p90, features, c2_uncertainty)
```

**In `execution.py` e `backtesting.py`:** Aggiungere i 3 parametri al costruttore `DecisionEngine(...)`:
```python
consec_bars_filter_enabled = cfg.consec_bars_filter_enabled,
consec_bars_max_long       = cfg.consec_bars_max_long,
consec_bars_max_short      = cfg.consec_bars_max_short,
```
(Per backtesting: `getattr` da cfg.)

### Nota di calibrazione
A 4H, 8 candele consecutive = 32 ore di closes unidirezionali senza interruzione. Questo è davvero raro (tipicamente 3-4 su BTC) ma indica chiaramente over-extension. Valori più aggressivi: `consec_bars_max_long = 5-6`.

### Toggle
- Paper/Live: `BotConfig.consec_bars_filter_enabled`
- Backtest: `getattr(cfg, "consec_bars_filter_enabled", False)`

---

## Appendix 1 — Tutti i nuovi BotConfig field (Piano 2)

| Campo | Tipo | Default | Ge | Le | Feature |
|-------|------|---------|----|----|---------|
| `ranging_gate_enabled` | bool | False | — | — | A |
| `ranging_gate_block_sideways` | bool | True | — | — | A |
| `ranging_gate_block_flat` | bool | True | — | — | A |
| `ranging_gate_block_transition` | bool | False | — | — | A |
| `late_entry_filter_enabled` | bool | False | — | — | B |
| `late_entry_max_ob_dist` | float | 3.0 | 1.0 | 8.0 | B |
| `path_obstruction_enabled` | bool | False | — | — | C |
| `path_obstruction_max_dist` | float | 1.5 | 0.5 | 4.0 | C |
| `dual_atr_enabled` | bool | False | — | — | D |
| `ob_buffer_pct` | float | 0.3 | 0.1 | 2.0 | E |
| `ob_buffer_min_atr` | float | 0.0 | 0.0 | 0.5 | E |
| `consec_bars_filter_enabled` | bool | False | — | — | F |
| `consec_bars_max_long` | int | 8 | 3 | 20 | F |
| `consec_bars_max_short` | int | 8 | 3 | 20 | F |

**Totale: 14 nuovi campi**

---

## Appendix 2 — Ordine di Implementazione

Le feature sono indipendenti tra loro e possono essere implementate in qualsiasi ordine. L'ordine suggerito massimizza il valore per test incrementali:

### Step 1 — Feature E: SL Buffer Enhancement *(~30 min)*
Il cambiamento meno invasivo. Tocca solo `risk.py`, `execution.py`, `backtesting.py`. Nessun nuovo gate, solo parametri passati in modo configurabile. Può essere testato in backtest immediatamente. Nessun rischio di regressione.

### Step 2 — Feature D: Dual ATR per SL *(~45 min)*
Aggiunge `atr_21` a `smc.py` (una riga), una firma a `risk.py`, e 3-4 righe in `_cycle()` e `backtesting.py`. Completamente non-invasivo per i path esistenti (`sl_atr=None` = comportamento invariato).

### Step 3 — Feature F: Consecutive Bars Filter *(~1 ora)*
Aggiunge `consec_bars` a `smc.py` (loop semplice). Aggiunge gate in `decision.py` dentro i blocchi Long/Short. Testabile in backtest immediatamente.

### Step 4 — Feature A: Ranging Regime Gate *(~1.5 ore)*
La più complessa (pre-computazione regimi in backtest). Testare prima in paper mode per 2-3 cicli prima del backtest.

### Step 5 — Feature B: Late Entry Distance Filter *(~45 min)*
Gate semplice in `decision.py`. Nessuna modifica a smc.py (usa features esistenti).

### Step 6 — Feature C: Path Obstruction Gate *(~30 min)*
Gate semplice in `decision.py`. Logica speculare a Feature B.

---

## Appendix 3 — Analisi Conflitti con Piano 1

Piano 1 = `Roadmaps/implementation-roadmap-2025-05-26.md` (F&G, Funding Rate, L2 Imbalance, Slippage)
Piano 2 = questo documento (Ranging Gate, Dual ATR, SL Buffer, ecc.)

### File toccati da entrambi i piani

| File | Piano 1 | Piano 2 | Conflitto? |
|------|---------|---------|------------|
| `main.py` (BotConfig) | +23 campi | +14 campi | **No** — additive, basta applicarli in sequenza |
| `decision.py` | Aggiunge FNG/Funding gate dopo RegimeBias | Aggiunge RangingGate dopo AbsorptionFilter, B/C/F dentro Long/Short blocks | **No** — posizioni diverse nel pipeline |
| `execution.py` `_cycle()` | Inietta covariates, avg_funding, L2 check post-decide | Inietta regime_4h, calcola atr_sl | **No** — righe diverse |
| `backtesting.py` | Integra F&G nel loop | Pre-computa regimi prima del loop, nuovi getattr params | **No** — aree diverse |

### File toccati solo da Piano 1
`hl_websocket.py`, `covariates.py`

### File toccati solo da Piano 2
`smc.py`, `risk.py`

### Potenziale attenzione
Piano 1 modifica la firma di `decide()` aggiungendo `covariates: Optional[dict] = None` e `avg_funding: float = 0.0`. Piano 2 NON modifica la firma di `decide()` (usa iniezione via `features` dict). Quindi se i due piani vengono implementati in sequenza, non c'è merge conflict sulla firma.

**Verdetto: nessun conflitto tecnico. I piani possono essere implementati in qualsiasi ordine.**

---

## Appendix 4 — Quale Piano Implementare Prima?

### Raccomandazione: **Piano 2 prima**

**Motivazioni:**

1. **Piano 2 risolve il problema alla radice.** I falsi segnali in regime laterale sono la causa principale di trade persi, non la mancanza di dati F&G o funding. Filtrare prima le entrate di bassa qualità rende ogni miglioramento successivo (Piano 1) più efficace.

2. **Piano 2 è completamente backtestabile senza nuove dipendenze.** Nessuna API esterna, nessuna infrastruttura WebSocket, nessuna latenza. Puoi validare l'impatto in backtest in pochi minuti.

3. **Piano 2 opera su dati già calcolati.** `ob_bull_dist`, `ob_bear_dist`, `RegimeDetector`, `atr_14` — tutto esiste già. Il rischio di bug è minimale.

4. **Piano 1 L2 è la feature più complessa del progetto intero.** Richiede nuova sottoscrizione WebSocket, deque buffer, anti-spoofing, e post-decide gate. Implementarla su una baseline già ottimizzata con Piano 2 è più sicuro.

5. **Piano 1 Feature F&G e Funding sono semplici**, ma il loro impatto è incrementale (+5-10% di signal quality). Piano 2 può migliorare il win rate del 10-20% riducendo strutturalmente le entrate sbagliate.

6. **Ordine ottimale per massimizzare ROI:**
   - Settimana 1: Piano 2 (E → D → F → A → B → C)
   - Settimana 2: Piano 1 Feature 1 (F&G + Dominance) + Feature 2 (Funding Rate)
   - Settimana 3: Piano 1 Feature 3 (L2 Imbalance)
   - Feature 4 (Slippage Tracking) = sempre attiva, nessuna urgenza specifica
