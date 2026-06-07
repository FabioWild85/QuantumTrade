# ATR% Volatility Gate — Piano di Implementazione

**Data:** 2026-06-06
**Priorità:** Alta
**Stima effort:** ~1 ora

---

## 1. Motivazione

Dai backtest su periodi di range storico BTC emerge una soglia empirica critica:
quando `ATR_14 / close < 0.8%`, il sistema diventa anti-economico perché:
- Le fee (~0.09% round-trip) erodono una percentuale sproporzionata dell'avg win
- Il modello LightGBM (addestrato su ambienti con ATR% > 0.8%) produce segnali inaffidabili
- Win rate crolla sistematicamente (periodo post-FTX dic 2022: wr=20%, DD=11.6%)

**Obiettivo:** bloccare o ridurre automaticamente l'esposizione quando
l'ATR% scende sotto una soglia configurabile, senza intervento manuale.

---

## 2. Design della feature

### 2.1 Parametri

| Parametro | Tipo | Default | Range | Significato |
|---|---|---|---|---|
| `atr_pct_gate_enabled` | `bool` | `False` | on/off | Master toggle |
| `atr_pct_min` | `float` | `0.008` | 0.003–0.030 | Soglia ATR% (0.8% = 0.008) |
| `atr_pct_mode` | `Literal["block","scale"]` | `"scale"` | block/scale | Modalità di risposta |

### 2.2 Calcolo ATR%

```python
atr_pct = atr_14 / current_price   # es. 800 / 100000 = 0.0080 = 0.8%
```

Entrambi i valori sono già disponibili in `decide()`:
- `atr_14` → `features.get("atr_14")`
- `current_price` → parametro già presente nella firma

### 2.3 Comportamento per modalità

**Modalità `block` (blocco netto):**
- `atr_pct < atr_pct_min` → `no_trade` immediato
- Reasoning: `"GATE: ATR_PCT 0.62% < 0.80% — low-volatility environment, fee drag too high"`
- Identico all'ADX gate: uscita pulita prima di qualsiasi calcolo ulteriore

**Modalità `scale` (riduzione progressiva — consigliata):**
- `size_mult = clamp(atr_pct / atr_pct_min, 0.0, 1.0)`
- Il trade avviene, ma la size viene scalata linearmente
- Esempi con `atr_pct_min = 0.008`:

| ATR% corrente | size_mult | Effetto |
|---|---|---|
| ≥ 0.80% | 1.00 | size piena (nessuna riduzione) |
| 0.60% | 0.75 | size ridotta al 75% |
| 0.40% | 0.50 | size ridotta al 50% |
| 0.20% | 0.25 | size ridotta al 25% |
| < 0.08% | 0.10 (floor) | size minima al 10% |

- Floor minimo 0.10 (non blocca mai del tutto in modalità scale)
- Reasoning: `"ATR_PCT_SCALE: 0.62% / 0.80% = ×0.78 — reduced size for low-volatility regime"`

### 2.4 Posizione nel flusso decision.py

Il gate si inserisce **subito dopo il gate ADX** (Gate Level 1), come Gate Level 1b.
Questo è corretto per due motivi:
1. L'ADX gate già gestisce "nessun trend" — l'ATR% gate gestisce "nessuna volatilità profittabile"
2. Posizionarlo prima dell'ensemble probability evita calcoli inutili in blocco netto
3. In modalità scale, la `size_mult` viene applicata al `DecisionResult.size_factor` finale
   prima del return, identico al comportamento del `iv_size_factor` già esistente

---

## 3. Modifiche file per file

### 3.1 `services/decision.py` — aggiungere gate e parametri

**`__init__` — aggiungere 3 parametri:**
```python
# ── ATR% Volatility Gate ─────────────────────────────────────────────
atr_pct_gate_enabled: bool  = False,
atr_pct_min:          float = 0.008,    # 0.8% default (empirical BTC 4H threshold)
atr_pct_mode:         str   = "scale",  # "block" | "scale"
```

Aggiungerli anche al corpo `__init__`:
```python
self.atr_pct_gate_enabled = atr_pct_gate_enabled
self.atr_pct_min          = atr_pct_min
self.atr_pct_mode         = atr_pct_mode
```

**`decide()` — aggiungere il gate dopo Gate Level 1 (ADX):**

Inserire subito dopo il blocco `if self.adx_gate_enabled and adx < self.adx_gate:`:

```python
# ── Gate Level 1b: ATR% Volatility Gate ──────────────────────────────
# Protects against low-volatility environments where fee drag makes
# trading uneconomical. ATR% = ATR_14 / current_price.
# "block" mode: no_trade immediately. "scale" mode: reduce size linearly.
if self.atr_pct_gate_enabled and current_price > 0:
    atr_14_val = float(features.get("atr_14") or 0.0)
    atr_pct_curr = atr_14_val / current_price if current_price > 0 else 1.0
    if atr_pct_curr < self.atr_pct_min:
        if self.atr_pct_mode == "block":
            reasoning.append(
                f"GATE: ATR_PCT {atr_pct_curr*100:.2f}% < {self.atr_pct_min*100:.2f}% "
                f"— low-volatility regime, fee drag too high"
            )
            return self._no_trade(reasoning, dir_prob, p10, p50, p90, features, c2_uncertainty)
        # scale mode: store multiplier — applied to size_factor at long/short return
        _atr_size_mult = max(0.10, atr_pct_curr / self.atr_pct_min)
        reasoning.append(
            f"ATR_PCT_SCALE: {atr_pct_curr*100:.2f}% / {self.atr_pct_min*100:.2f}% "
            f"→ size×{_atr_size_mult:.2f} (low-volatility, fee protection)"
        )
    else:
        _atr_size_mult = 1.0
else:
    _atr_size_mult = 1.0
```

**Applicare `_atr_size_mult` ai return long e short:**

Nei due return finali (long e short), moltiplicare `size_factor` per `_atr_size_mult`:

```python
# Nel return LONG (già esiste sf = counter_trend_size_factor * iv_sf):
sf = (counter_trend_size_factor if is_counter_trend else 1.0) * iv_sf * _atr_size_mult

# Nel return SHORT (identico):
sf = (counter_trend_size_factor if is_counter_trend else 1.0) * iv_sf * _atr_size_mult
```

Questo mantiene la catena dei size_factor esistenti (regime bias × IV bias × ATR% gate)
senza spezzare nessun calcolo.

---

### 3.2 `services/execution.py` — BotConfig aggiungere 3 parametri

Nel blocco `class BotConfig` (o dovunque sono letti i parametri da `kw`):

```python
# ── ATR% Volatility Gate ─────────────────────────────────────────────────────
self.atr_pct_gate_enabled = kw.get("atr_pct_gate_enabled", False)
self.atr_pct_min          = kw.get("atr_pct_min",          0.008)
self.atr_pct_mode         = kw.get("atr_pct_mode",         "scale")
```

Nel punto in cui viene costruito il `DecisionEngine` (si usa `cfg`), i 3 parametri
vengono passati via `getattr(cfg, ...)` — nessuna modifica necessaria se il pattern
esistente usa `getattr(cfg, key, default)` per tutti i parametri.

Verificare che nella costruzione del `DecisionEngine` ci sia:
```python
atr_pct_gate_enabled = getattr(cfg, "atr_pct_gate_enabled", False),
atr_pct_min          = getattr(cfg, "atr_pct_min",          0.008),
atr_pct_mode         = getattr(cfg, "atr_pct_mode",         "scale"),
```

---

### 3.3 `main.py` — Pydantic BotConfig

Aggiungere 3 campi nel modello Pydantic, vicino agli altri gate (es. dopo `adx_gate`):

```python
# ── ATR% Volatility Gate ─────────────────────────────────────────────────────
atr_pct_gate_enabled: bool  = Field(False)
atr_pct_min:          float = Field(0.008, ge=0.001, le=0.030,
    description="ATR% minimo (ATR_14/close). Sotto questa soglia il gate si attiva. "
                "Default 0.008 = 0.8% (soglia empirica BTC 4H: fee drag > profitto atteso).")
atr_pct_mode:         str   = Field("scale",
    description='"block" = no_trade immediato | "scale" = riduzione size lineare fino a ×0.10')
```

---

### 3.4 `services/backtesting.py` — estrarre parametri e tracciare nel param_stats

**Estrazione parametri (blocco `getattr` iniziale):**
```python
atr_pct_gate_enabled = getattr(cfg, "atr_pct_gate_enabled", False)
atr_pct_min          = getattr(cfg, "atr_pct_min",          0.008)
atr_pct_mode         = getattr(cfg, "atr_pct_mode",         "scale")
```

**`param_stats` — aggiungere contatore:**
```python
"gate_atr_pct": 0,   # barre bloccate o scalate dal gate ATR%
```

**`param_config` — aggiungere flag:**
```python
"gate_atr_pct": atr_pct_gate_enabled,
```

**DecisionEngine construction — passare i 3 parametri:**
```python
atr_pct_gate_enabled = atr_pct_gate_enabled,
atr_pct_min          = atr_pct_min,
atr_pct_mode         = atr_pct_mode,
```

**Incremento contatore** nel loop backtest — da aggiungere nel blocco di analisi
del reasoning del result (pattern già usato per altri gate):
```python
if any("ATR_PCT" in r for r in result.reasoning):
    param_stats["gate_atr_pct"] += 1
```

---

### 3.5 `BotConfig.tsx` — UI live/paper

**TypeScript `Config` interface — aggiungere 3 campi:**
```typescript
atr_pct_gate_enabled: boolean;
atr_pct_min: number;
atr_pct_mode: 'block' | 'scale';
```

**`DEFAULTS` — aggiungere valori di default:**
```typescript
atr_pct_gate_enabled: false,
atr_pct_min: 0.008,
atr_pct_mode: 'scale' as const,
```

**UI — aggiungere sezione nella tab "Signal Quality Filters"**
(vicino all'ADX gate, stesso stile visivo):

```tsx
{/* ATR% Volatility Gate */}
<div className="flex flex-col gap-3 p-4 rounded-2xl border border-slate-100 dark:border-white/5">
  <Tooltip
    text="Blocca o riduce la size quando la volatilità assoluta scende sotto soglia.
          ATR% = ATR_14 / prezzo. Quando ATR% < soglia il bot non può più coprire le fee
          con le vincite medie. Empiricamente: soglia 0.8% su BTC 4H (dal backtest dic 2022)."
    width="wide" pos="top"
  >
    <label className="flex items-center gap-3 cursor-pointer group w-fit">
      <div className="relative">
        <input type="checkbox" className="sr-only"
          checked={config.atr_pct_gate_enabled}
          onChange={e => setConfig(c => ({ ...c, atr_pct_gate_enabled: e.target.checked }))} />
        <div className={`w-10 h-5 rounded-full transition-all duration-300
          ${config.atr_pct_gate_enabled ? 'bg-orange-500' : 'bg-slate-200 dark:bg-white/10'}`} />
        <div className={`absolute top-1 left-1 w-3 h-3 bg-white rounded-full shadow-sm
          transition-transform duration-300
          ${config.atr_pct_gate_enabled ? 'translate-x-5' : ''}`} />
      </div>
      <div>
        <p className={`text-sm font-bold transition-colors
          ${config.atr_pct_gate_enabled
            ? 'text-orange-600 dark:text-orange-400'
            : 'text-slate-800 dark:text-slate-200'}`}>
          ATR% Volatility Gate
          {config.atr_pct_gate_enabled && (
            <span className="ml-2 text-[10px] font-bold uppercase tracking-widest
              px-1.5 py-0.5 rounded bg-orange-100 dark:bg-orange-500/15
              text-orange-700 dark:text-orange-400">
              Attivo — soglia {(config.atr_pct_min * 100).toFixed(1)}%
            </span>
          )}
        </p>
        <p className="text-[11px] text-slate-400 dark:text-slate-500 leading-tight mt-0.5">
          {config.atr_pct_gate_enabled
            ? `Volatilità minima richiesta: ${(config.atr_pct_min * 100).toFixed(2)}%
               — modalità ${config.atr_pct_mode === 'block' ? 'blocco netto' : 'riduzione graduale'}`
            : 'Protegge dal fee-drag in ambienti a bassa volatilità (es. range post-crash)'}
        </p>
      </div>
    </label>
  </Tooltip>

  {config.atr_pct_gate_enabled && (
    <div className="space-y-4 pt-1">

      {/* Soglia ATR% */}
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <span className="text-[10px] font-bold text-slate-600 dark:text-slate-400
            uppercase tracking-widest">
            Soglia ATR%
          </span>
          <span className="font-mono text-sm font-bold text-orange-600 dark:text-orange-400">
            {(config.atr_pct_min * 100).toFixed(2)}%
          </span>
        </div>
        <input type="range" min={0.003} max={0.030} step={0.001}
          value={config.atr_pct_min}
          onChange={e => setConfig(c => ({ ...c, atr_pct_min: parseFloat(e.target.value) }))}
          className="w-full h-1.5 rounded-full appearance-none cursor-pointer
            bg-slate-200 dark:bg-white/15
            [&::-webkit-slider-thumb]:appearance-none
            [&::-webkit-slider-thumb]:w-3.5 [&::-webkit-slider-thumb]:h-3.5
            [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-orange-500
            [&::-webkit-slider-thumb]:shadow-sm [&::-webkit-slider-thumb]:cursor-pointer"
        />
        <div className="flex justify-between text-[9px] font-mono text-slate-400 dark:text-slate-500">
          <span>0.3% (molto permissivo)</span>
          <span>0.8% (empirico BTC)</span>
          <span>3.0% (molto restrittivo)</span>
        </div>
        <p className="text-[9px] text-slate-400 dark:text-slate-500 leading-relaxed">
          A $100k BTC: soglia 0.8% = ATR &lt; $800 attiva il gate.
          A $65k: &lt; $520. A $30k: &lt; $240.
        </p>
      </div>

      {/* Modalità: block vs scale */}
      <div className={`rounded-xl border px-3 py-2.5 space-y-2 transition-colors
        ${config.atr_pct_mode === 'block'
          ? 'border-red-200 dark:border-red-500/30 bg-red-50/40 dark:bg-red-500/5'
          : 'border-amber-200 dark:border-amber-500/30 bg-amber-50/40 dark:bg-amber-500/5'}`}>
        <p className="text-[9px] font-bold text-slate-500 dark:text-slate-400
          uppercase tracking-widest">
          Modalità di risposta
        </p>
        <div className="flex gap-2">
          {(['scale', 'block'] as const).map(mode => (
            <button key={mode}
              onClick={() => setConfig(c => ({ ...c, atr_pct_mode: mode }))}
              className={`flex-1 py-2 px-3 rounded-lg text-[10px] font-bold border
                transition-all ${config.atr_pct_mode === mode
                  ? mode === 'scale'
                    ? 'bg-amber-500 text-white border-amber-500'
                    : 'bg-red-500 text-white border-red-500'
                  : 'bg-white dark:bg-white/5 text-slate-600 dark:text-slate-400 border-slate-200 dark:border-white/10'}`}>
              {mode === 'scale' ? '📉 Riduzione Graduale' : '🚫 Blocco Netto'}
            </button>
          ))}
        </div>
        <p className="text-[9px] text-slate-500 dark:text-slate-400 leading-relaxed">
          {config.atr_pct_mode === 'scale'
            ? 'La size viene ridotta linearmente (ATR_curr / soglia). A 0.6% con soglia 0.8%: size ×0.75. Floor minimo ×0.10 — il bot non si blocca mai del tutto.'
            : 'Nessun trade quando ATR% è sotto soglia. Identico al gate ADX: uscita immediata senza aprire posizioni.'}
        </p>
      </div>
    </div>
  )}
</div>
```

---

### 3.6 `BacktestPanel.tsx` — UI backtest

**State variables da aggiungere:**
```typescript
const [atrPctGateEnabled, setAtrPctGateEnabled] = useState(false);
const [atrPctMin,         setAtrPctMin]         = useState('0.008');
const [atrPctMode,        setAtrPctMode]         = useState<'block' | 'scale'>('scale');
```

**`applyConfig` — aggiungere caricamento:**
```typescript
if (p.atr_pct_gate_enabled !== undefined) setAtrPctGateEnabled(!!p.atr_pct_gate_enabled);
if (p.atr_pct_min         !== undefined) setAtrPctMin(String(p.atr_pct_min));
if (p.atr_pct_mode        !== undefined) setAtrPctMode(p.atr_pct_mode as 'block' | 'scale');
```

**`buildConfig` payload — aggiungere:**
```typescript
atr_pct_gate_enabled: atrPctGateEnabled,
atr_pct_min:          parseFloat(atrPctMin),
atr_pct_mode:         atrPctMode,
```

**UI nel pannello "Signal Quality Filters" del backtest** — aggiungere subito dopo
il toggle ADX Gate, stessa struttura dei filtri esistenti:

```tsx
<Toggle
  label="ATR% Volatility Gate"
  desc={`Blocca o scala la size quando ATR% < soglia. Protegge dal fee-drag in range compressi.`}
  checked={atrPctGateEnabled}
  onChange={setAtrPctGateEnabled}
/>
{atrPctGateEnabled && (
  <div className="space-y-3 pl-2">
    <Tooltip text="Soglia ATR% (ATR_14/close). Default 0.8% calibrato su BTC 4H storico." pos="top" width="wide">
      <NumInput
        label="Soglia ATR% minima"
        value={String(Math.round(parseFloat(atrPctMin) * 1000) / 10)}
        onChange={v => setAtrPctMin(String(parseFloat(v) / 100))}
        step="0.1" min="0.3" max="3.0" unit="%"
      />
    </Tooltip>
    <div className="flex gap-2">
      {(['scale', 'block'] as const).map(m => (
        <button key={m} onClick={() => setAtrPctMode(m)}
          className={`flex-1 py-1.5 px-2 rounded-lg text-[10px] font-bold border
            transition-all ${atrPctMode === m
              ? 'bg-orange-100 dark:bg-orange-500/20 text-orange-600 dark:text-orange-400 border-orange-300 dark:border-orange-500/40'
              : 'bg-white dark:bg-white/5 text-slate-500 border-slate-200 dark:border-white/10'}`}>
          {m === 'scale' ? 'Graduale (×size)' : 'Blocco Netto'}
        </button>
      ))}
    </div>
  </div>
)}
```

**Export file testuale — aggiungere alla sezione "Signal Quality Filters":**
```typescript
`ATR% Gate:              ${atrPctGateEnabled
  ? `ATTIVO — soglia ${(parseFloat(atrPctMin)*100).toFixed(1)}% · modalità ${atrPctMode}`
  : 'DISATTIVATO'}`
```

---

## 4. Sequenza di implementazione (ordine preciso)

1. **`decision.py`** — aggiungere parametri a `__init__`, aggiungere gate in `decide()`, applicare `_atr_size_mult` ai due return finali
2. **`execution.py`** — aggiungere 3 parametri al BotConfig reader
3. **`main.py`** — aggiungere 3 campi Pydantic con Field e validazione
4. **`backtesting.py`** — aggiungere parametri, contatore param_stats, passaggio a DecisionEngine
5. **`BotConfig.tsx`** — aggiungere interface, DEFAULTS, sezione UI
6. **`BacktestPanel.tsx`** — aggiungere state, applyConfig, buildConfig, UI
7. **Syntax check Python + TypeScript check** — prima di qualsiasi deploy
8. **Build frontend + deploy backend + restart VPS**

---

## 5. Integrazione con il sistema esistente — garanzie di non-regressione

### Parametri non rompono nulla con i default

Con `atr_pct_gate_enabled: False` (default), il gate non viene mai eseguito.
Il codice aggiunto è protetto da `if self.atr_pct_gate_enabled`, quindi:
- Tutti i backtest esistenti producono risultati identici
- La config live attuale non cambia comportamento
- DB Supabase: i vecchi record non hanno questi campi → Pydantic usa i default → OK

### `_atr_size_mult` non altera la catena size esistente

La moltiplicazione avviene come:
```
sf = counter_trend_size_factor × iv_sf × _atr_size_mult
```
Con gate disabilitato: `_atr_size_mult = 1.0` → nessun effetto.
Con gate abilitato ma ATR% ≥ soglia: `_atr_size_mult = 1.0` → nessun effetto.
Il gate è additivo alla catena esistente, mai sostitutivo.

### `param_stats` è un dict con default zero

Il nuovo campo `"gate_atr_pct": 0` nel backtest non rompe nessun endpoint
che legga param_stats — aggiunta non-breaking.

### Modalità `scale` non blocca mai del tutto

Il floor a `max(0.10, ...)` garantisce che il bot non si congeli mai completamente
in modalità scale. Se l'utente vuole blocco totale, usa modalità `block`.

---

## 6. Calibrazione consigliata

**Default raccomandati al lancio:**
- `atr_pct_gate_enabled = False` — off per non sorprendere il comportamento esistente
- `atr_pct_min = 0.008` — 0.8%, calibrato su BTC 4H post-FTX
- `atr_pct_mode = "scale"` — più professionale del blocco netto

**Valori da testare in backtest:**

| Scenario | atr_pct_min | atr_pct_mode | Comportamento atteso |
|---|---|---|---|
| Conservativo | 0.010 (1.0%) | scale | Riduce size più aggressivamente |
| Calibrato BTC | 0.008 (0.8%) | scale | Bilancia protezione e opportunità |
| Permissivo | 0.005 (0.5%) | scale | Solo regime di compressione estrema |
| Blocco netto | 0.008 (0.8%) | block | Ferma tutto al di sotto della soglia |

**Test di riferimento da eseguire prima del go-live:**
- Periodo 3 (post-FTX, dic 2022): con gate 0.8% block dovrebbe diventare 0 trade
- Periodo 1 (range puro, giu 2023): con gate 0.8% scale non dovrebbe cambiare significativamente (ATR% era ~1.1%)
- Periodo di trend (giu–dic 2024): nessuna differenza (ATR% > 1.2% costantemente)
