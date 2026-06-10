# Piano di Implementazione — Leva Configurabile (Paper + Live HL)

**Data:** 28 Maggio 2026 — **Revisionato:** 7 Giugno 2026
**Stato:** Pianificazione verificata sul codice reale — pronta per implementazione
**Priorità:** Media — funzionalità operativa, non safety-critical
**Stima:** 3-4 ore di lavoro, ~220 righe totali

---

## 1. Contesto e obiettivo

Il sistema attuale non ha un parametro `leverage` esplicito. La leva è implicita nel
sizing risk-based: con `position_size_pct=1.5%` e SL al 2%, il notional aperto è
pari a `equity × 1.5% / 2% = equity × 0.75` — cioè leva ~0.75×, sotto il collaterale.
Questo significa che **il bot non va mai in liquidazione nel paper mode** e su HL
usa la leva di default del conto.

**Obiettivo:** aggiungere un parametro `leverage` (default 1, range 1–50) che:

1. **Moltiplica il notional aperto** — con `leverage=5`, `position_size_pct=1.5%`,
   equity $10.000 e SL al 2%: si rischia $750 (= $10.000 × 1.5% × 5) e si apre
   un notional di $37.500 (= $750 / 2%). Il margine depositato su HL è $7.500
   (= $37.500 / 5). Questo è il comportamento atteso e standard della leva.
2. In **paper mode** — calcola il prezzo di liquidazione per ogni posizione e lo
   controlla ogni 5s nel watchdog e ad ogni bar in `_manage_position`, simulando
   fedelmente il rischio reale.
3. In **live mode (HL)** — chiama `exchange.update_leverage()` prima di ogni ordine,
   impostando la leva isolated sulla coppia BTCUSDC.
4. In **backtest** — aggiunge un exit event `"liquidation"` quando il prezzo tocca
   la soglia di liquidazione intrabar.
5. In **UI (BotConfig)** — uno slider 1×–50× con label dinamica che mostra margine
   richiesto, rischio per trade e prezzo di liquidazione stimato.

---

## 2. Formula esatta del prezzo di liquidazione (isolated margin)

Hyperliquid usa **isolated margin**. La formula ufficiale HL per il prezzo di
liquidazione è:

### Long
```
liq_px = entry_price × (1 − 1/L + MM_rate)
```

### Short
```
liq_px = entry_price × (1 + 1/L − MM_rate)
```

Dove:
- `L` = leverage (intero, 1–50)
- `MM_rate` = Maintenance Margin Rate = **0.005** (0.5%) per BTC su HL
  (costante per posizioni retail, aumenta per posizioni > $5M notional)

### Esempi verificabili

| Side  | Entry   | Leva | liq_px calcolato         |
|-------|---------|------|--------------------------|
| Long  | 100.000 | 10×  | 100.000×(1−0.10+0.005) = **90.500** |
| Long  | 100.000 |  5×  | 100.000×(1−0.20+0.005) = **80.500** |
| Short | 100.000 | 10×  | 100.000×(1+0.10−0.005) = **109.500** |
| Short | 100.000 |  5×  | 100.000×(1+0.20−0.005) = **119.500** |

> **Nota:** La formula non include la fee d'ingresso perché su HL le fee non riducono
> il margine isolato. Questa formula è accurata per paper mode e backtest.

### Costanti da centralizzare in execution.py (modulo level)

```python
HL_MM_RATE  = 0.005   # Maintenance margin rate BTC isolated
HL_MAX_LEV  = 50      # Leva massima HL per BTC
```

---

## 3. File da modificare

| File | Sezione | Tipo di modifica |
|------|---------|-----------------|
| `apps/api/services/execution.py` | modulo level | Costanti `HL_MM_RATE`, `HL_MAX_LEV` |
| `apps/api/services/execution.py` | `BotConfig.__init__` | Campo `leverage` |
| `apps/api/services/execution.py` | `_open_position` — path normale | Sizing × leverage + `liq_px` |
| `apps/api/services/execution.py` | `_open_position` — path `_has_overrides` | Sizing × leverage (⚠ falla del piano originale) |
| `apps/api/services/execution.py` | `_paper_watchdog` | Check liq ogni 5s |
| `apps/api/services/execution.py` | `_manage_position` | Check liq intrabar |
| `apps/api/services/execution.py` | `_submit_open_order` | `update_leverage()` |
| `apps/api/services/execution.py` | `_persist_position_state` | Aggiungere `liq_px`, `leverage`, `margin_usd` per live |
| `apps/api/services/execution.py` | `_restore_paper_state` | Retrocompatibilità `liq_px` |
| `apps/api/services/execution.py` | `_reconcile_position` | Retrocompatibilità `liq_px` per live (⚠ falla del piano originale) |
| `apps/api/services/execution.py` | `get_status()` | Esporre `leverage`, `liq_px`, `margin_usd` |
| `apps/api/services/risk.py` | `calculate_trade_params` | Parametro `leverage`, sizing × leverage, safety cap |
| `apps/api/main.py` | `BotConfig` Pydantic | `leverage: int = Field(1, ge=1, le=50)` |
| `apps/api/services/backtesting.py` | apertura immediata | `liq_px` + `leverage` nel dict position |
| `apps/api/services/backtesting.py` | reversal pending fill | `liq_px` + `leverage` (⚠ falla del piano originale) |
| `apps/api/services/backtesting.py` | pullback fill | `liq_px` + `leverage` (⚠ falla del piano originale) |
| `apps/api/services/backtesting.py` | pullback fallback fill | `liq_px` + `leverage` (⚠ falla del piano originale) |
| `apps/api/services/backtesting.py` | loop principale | Exit `"liquidation"` — prima di `lgbm_exit` (⚠ ordine critico) |
| `apps/web/components/trading-hub/BotConfig.tsx` | Config interface | `leverage: number` |
| `apps/web/components/trading-hub/BotConfig.tsx` | DEFAULTS | `leverage: 1` |
| `apps/web/components/trading-hub/BotConfig.tsx` | UI section | Slider leva |
| `apps/web/components/trading-hub/BacktestPanel.tsx` | `buildConfig()` | Aggiungere `leverage` (⚠ falla del piano originale) |
| `apps/web/components/trading-hub/BacktestPanel.tsx` | `applyConfig` | Aggiornare `leverage` come parametro di config (⚠ falla del piano originale) |
| `apps/web/components/trading-hub/BacktestPanel.tsx` | `drawerHasCustom` | `|| leverage !== 1` dove `leverage` è la var del drawer |
| `apps/web/components/trading-hub/BacktestPanel.tsx` | `LeverageSelector` | Disabilitare quando `buildConfig().leverage > 1` |

> **Nota:** `BacktestRequest` in `main.py` **NON** riceve un campo `leverage` top-level separato.
> La leva del backtest viene letta da `req.config.leverage` (=`BotConfig.leverage`), come tutti
> gli altri parametri strategici. Aggiungere `leverage` a `BacktestRequest` direttamente sarebbe
> ridondante e creerebbe ambiguità.

---

## 4. Dettaglio implementazione

### 4.1 — execution.py: costanti modulo-level (vicino a `HL_TAKER_FEE`, riga 33)

```python
HL_MM_RATE = 0.005   # Maintenance margin rate BTC isolated margin
HL_MAX_LEV = 50      # Max leverage HL BTC-PERP
```

---

### 4.2 — execution.py: `BotConfig.__init__`

Posizione: dopo `max_consecutive_losses`, prima di `mode`.

```python
self.leverage = kw.get("leverage", 1)  # 1 = no leverage (default)
```

---

### 4.3 — risk.py: `calculate_trade_params` (modifica principale del sizing)

Questo è **il cambiamento più importante** — senza di esso la leva non ha effetto
sul notional e il PnL non viene amplificato.

**Firma aggiornata:**
```python
def calculate_trade_params(
    self,
    side: Side,
    entry_price: float,
    atr: float,
    equity_usd: float,
    leverage: int = 1,           # ← nuovo parametro
    sl_atr: Optional[float] = None,
    ...
) -> TradeParams:
```

**Logica sizing aggiornata** (sostituisce le righe 235-239 di risk.py):

```python
sl_pct   = sl_dist / entry_price if entry_price > 0 else 0.02
_eff_lev = max(leverage, 1)
risk_usd = equity_usd * (self.position_size_pct / 100) * size_mult * _eff_lev
size_usd = risk_usd / sl_pct if sl_pct > 1e-6 else risk_usd

# Safety cap: margine ≤ 95% equity (blocca configurazioni estreme)
_margin = size_usd / _eff_lev
if _margin > equity_usd * 0.95:
    size_usd = equity_usd * 0.95 * _eff_lev
    risk_usd = size_usd * sl_pct
    log.warning(
        "Position size capped: margin (%.0f) would exceed 95%% of equity (%.0f). "
        "size_usd reduced to %.0f.", _margin, equity_usd, size_usd
    )

size_contracts = size_usd / entry_price
```

**Esempio numerico con il cap:**
- equity=$10.000, leverage=50, position_size_pct=1.5%, sl_pct=2%
- risk_usd = $10.000 × 1.5% × 50 = $7.500
- size_usd = $7.500 / 2% = $375.000 → margin = $7.500 → 75% equity → **ok**
- Con sl_pct=0.1%: size_usd = $75M → margin=$1.5M → **cap scatta**

---

### 4.4 — execution.py: helper `_calc_liq_px` (metodo statico di `ExecutionEngine`)

```python
@staticmethod
def _calc_liq_px(side: str, entry: float, leverage: int) -> float:
    """
    Hyperliquid isolated margin liquidation price.
    Formula: long  → entry × (1 − 1/L + MM_rate)
             short → entry × (1 + 1/L − MM_rate)
    Restituisce 0.0 per leva 1× (nessun prezzo di liquidazione raggiungibile).
    """
    if leverage <= 1:
        return 0.0
    if side == "long":
        return entry * (1.0 - 1.0 / leverage + HL_MM_RATE)
    else:
        return entry * (1.0 + 1.0 / leverage - HL_MM_RATE)
```

> Con leva 1× il margine coincide con il notionale — la posizione può andare a zero
> ma non viene liquidata prima. Restituire 0.0 e non controllarlo è corretto.

---

### 4.5 — execution.py: `_open_position` — path NORMALE (senza overrides)

**Call site a `calculate_trade_params`** (~riga 2173):

```python
params = self._risk.calculate_trade_params(
    side=result.action,
    entry_price=price,
    atr=atr,
    equity_usd=self._equity,
    leverage=self.config.leverage,   # ← aggiunto
    ...
)
```

**Dopo i calcoli di SL/TP e `eff_size_usd`** (~riga 2237), aggiungere:

```python
liq_px = self._calc_liq_px(result.action, price, self.config.leverage)
if liq_px > 0.0:
    # Warning se SL è configurato oltre il prezzo di liquidazione
    sl_dist_pct  = abs(params.stop_loss - price) / price
    liq_dist_pct = abs(liq_px - price) / price
    if liq_dist_pct < sl_dist_pct:
        log.warning(
            "[%s] SL (%.1f%%) è OLTRE il prezzo di liquidazione (%.1f%%) con leva %d×. "
            "La posizione verrà liquidata prima dello stop loss.",
            self.mode.upper(), sl_dist_pct * 100, liq_dist_pct * 100, self.config.leverage,
        )
    log.info(
        "[%s] Leverage %d× | liq_px=%.2f (margin=%.0f USD)",
        self.mode.upper(), self.config.leverage, liq_px,
        eff_size_usd / self.config.leverage,
    )
```

**Nel dict `self._position`** (~riga 2290), aggiungere dopo le righe esistenti:

```python
"leverage":   self.config.leverage,
"liq_px":     liq_px,
"margin_usd": round(eff_size_usd / max(self.config.leverage, 1), 2),
```

---

### 4.6 — execution.py: `_open_position` — path `_has_overrides=True` ⚠ FALLA DEL PIANO ORIGINALE

Quando si apre una posizione reversal retest (`sl_override` e `tp_override` forniti),
il sizing usa una formula diretta (righe 2147-2148) che **non include la leva**.
Questo path deve essere corretto:

```python
# Attuale (NON include la leva — da correggere):
_size_usd = self._risk.position_size_pct / 100.0 * self._equity * result.size_factor

# Corretto:
_eff_lev  = max(getattr(self.config, "leverage", 1), 1)
_size_usd = self._risk.position_size_pct / 100.0 * self._equity * result.size_factor * _eff_lev
# Safety cap
_margin   = _size_usd / _eff_lev
if _margin > self._equity * 0.95:
    _size_usd = self._equity * 0.95 * _eff_lev
```

Dopo la costruzione di `params` in questo path, aggiungere anche il calcolo di `liq_px`
con la stessa logica del path normale (§4.5 sopra).

---

### 4.7 — execution.py: `_paper_watchdog`

Il watchdog gira ogni **5 secondi** (POLL_S = 5). Aggiungere il check liquidazione
**prima del blocco SL/full TP** (dopo la sezione partial TP, ~riga 1124):

```python
# Check liquidazione — priorità massima, PRIMA di SL/TP
liq_px = self._position.get("liq_px", 0.0)
side   = self._position.get("side")
if liq_px > 0.0:
    hit_liq = (side == "long"  and check_low  <= liq_px) or \
              (side == "short" and check_high >= liq_px)
    if hit_liq:
        log.info(
            "Paper watchdog: liquidation triggered | side=%s liq_px=%.2f "
            "(period low=%.2f high=%.2f)", side, liq_px, check_low, check_high,
        )
        await self._close_position(liq_px, "liquidation")
        continue  # ← important: skip SL/TP check (position already closed)
```

> `continue` è necessario per saltare il controllo SL/TP successivo che altrimenti
> toccherebbe `self._position` che potrebbe essere già `None` dopo `_close_position`.

---

### 4.8 — execution.py: `_manage_position`

Aggiungere subito **dopo** `self._position["bars_held"]` e **prima** del trailing SL
(~riga 2410), solo per paper mode:

```python
# Liquidation check — paper only (in live mode HL enforces natively)
if self.mode == "paper":
    _liq = self._position.get("liq_px", 0.0)
    if _liq > 0.0:
        _hit_liq = (side == "long"  and current_price <= _liq) or \
                   (side == "short" and current_price >= _liq)
        if _hit_liq:
            await self._close_position(_liq, "liquidation")
            return
```

> Priorità massima: la liquidazione avviene **prima** di qualsiasi trailing SL,
> BE-SL, partial TP o LGBM exit.

---

### 4.9 — execution.py: `_submit_open_order`

Dopo la costruzione dell'oggetto `exchange` (~riga 3104), prima del blocco dell'ordine
di ingresso:

```python
# Imposta leva isolated su HL prima di ogni ordine (HL mantiene la leva dell'ultimo
# set — chiamare ogni volta evita che cicli precedenti con leva diversa interferiscano)
_leverage = getattr(self.config, "leverage", 1)
if _leverage > 1:
    try:
        lev_result = await asyncio.to_thread(
            exchange.update_leverage,
            _leverage,   # intero
            SYMBOL,      # "BTC"
            False,       # is_cross=False → isolated margin
        )
        log.info("HL leverage set to %d× isolated: %s", _leverage, lev_result)
    except Exception as exc:
        log.warning("Could not set leverage on HL (non-blocking): %s", exc)
        # Non-blocking: se fallisce, HL usa la leva già impostata sul conto.
        # Questo è preferibile a bloccare l'entry del tutto.
```

---

### 4.10 — execution.py: `_persist_position_state`

Nel blocco `_live_position_state` (~riga 793), aggiungere i nuovi campi nella lista
esistente (dopo `entry_atr` per esempio):

```python
"leverage":   self._position.get("leverage", 1),
"liq_px":     self._position.get("liq_px", 0.0),
"margin_usd": self._position.get("margin_usd", 0.0),
```

---

### 4.11 — execution.py: `_restore_paper_state` (retrocompatibilità)

Alla fine del blocco di restore, dopo le backfill esistenti (~riga 748):

```python
if "liq_px" not in self._position:
    _lev = self._position.get("leverage", self.config.leverage)
    self._position["leverage"]   = _lev
    self._position["liq_px"]     = self._calc_liq_px(
        self._position["side"], self._position["entry_price"], _lev
    )
    self._position["margin_usd"] = round(
        self._position.get("size_usd", 0.0) / max(_lev, 1), 2
    )
else:
    # Già presenti — assicura che margin_usd sia calcolato se mancante
    if "margin_usd" not in self._position:
        _lev = self._position.get("leverage", 1)
        self._position["margin_usd"] = round(
            self._position.get("size_usd", 0.0) / max(_lev, 1), 2
        )
```

---

### 4.12 — execution.py: `_reconcile_position` (retrocompatibilità live) ⚠ FALLA DEL PIANO ORIGINALE

`_reconcile_position()` (~riga 582) legge `_live_position_state` dal DB e ricostruisce
la posizione live dopo un restart. Se la posizione è stata aperta prima dell'implementazione
della leva, `liq_px` non sarà nel dict salvato.

Alla fine del blocco di restore in `_reconcile_position`, aggiungere:

```python
# Retrocompatibilità: ricalcola liq_px se mancante (posizione aperta pre-leva)
if self._position and "liq_px" not in self._position:
    _lev = self._position.get("leverage", getattr(self.config, "leverage", 1))
    self._position["leverage"]   = _lev
    self._position["liq_px"]     = self._calc_liq_px(
        self._position["side"], self._position["entry_price"], _lev
    )
    self._position["margin_usd"] = round(
        self._position.get("size_usd", 0.0) / max(_lev, 1), 2
    )
```

> In live mode la liquidazione è gestita da HL natively, quindi `liq_px` ha solo
> utilità per log e monitoraggio, non per la sicurezza.

---

### 4.13 — execution.py: `get_status()` / monitor data

Nella risposta di `get_status()` (dove viene costruito il dict della posizione aperta),
aggiungere:

```python
"leverage":   self._position.get("leverage", 1),
"liq_px":     self._position.get("liq_px", 0.0),
"margin_usd": self._position.get("margin_usd", 0.0),
```

---

### 4.14 — backtesting.py: leva e liquidazione

#### A. Leggere la leva dal cfg (NON da BacktestRequest direttamente)

All'inizio di `run_backtest`, nella sezione di lettura parametri da `cfg`:

```python
lev = getattr(cfg, "leverage", 1)  # legge da req.config.leverage
```

> Non aggiungere `leverage` come campo top-level di `BacktestRequest`: è già
> raggiungibile via `req.config.leverage` come tutti gli altri parametri strategici.
> Aggiungere un campo ridondante creerebbe ambiguità su quale dei due ha la precedenza.

#### B. Helper inline per `liq_px` (NON importare `ExecutionEngine`)

Definire una funzione standalone **in backtesting.py** (modulo level) per evitare
l'import di `ExecutionEngine` (classe pesante, potenziale dipendenza circolare):

```python
def _liq_price(side: str, entry: float, leverage: int) -> float:
    """HL isolated margin liquidation price. Returns 0.0 for leverage <= 1."""
    if leverage <= 1:
        return 0.0
    if side == "long":
        return entry * (1.0 - 1.0 / leverage + 0.005)  # HL_MM_RATE = 0.005
    return entry * (1.0 + 1.0 / leverage - 0.005)
```

#### C. Quattro path di apertura — aggiungere `liq_px` e `leverage` a TUTTI ⚠

Il piano originale menzionava solo il path di apertura immediata. Ci sono **quattro**
path che costruiscono il dict `position`:

**1. Apertura immediata** (~riga 1192):

```python
position = {
    ...
    "leverage": lev,
    "liq_px":   _liq_price(result.action, close_price, lev),
}
```

**2. Reversal pending fill** (~riga 494):

```python
position = {
    ...
    "leverage": lev,
    "liq_px":   _liq_price(_rp["direction"], _rev_entry_px, lev),
}
```

**3. Pullback fill** (~riga 563):

```python
position = {
    ...
    "leverage": lev,
    "liq_px":   _liq_price(pb_dir, _entry_px, lev),
}
```

**4. Pullback fallback fill** (~riga 602):

```python
position = {
    ...
    "leverage": lev,
    "liq_px":   _liq_price(pb_dir, _entry_px, lev),
}
```

#### D. Check liquidazione intrabar — ORDINE CORRETTO ⚠

Il piano originale posizionava il check liquidazione "prima di SL e TP". Questo è
**sbagliato**: la liquidazione deve essere controllata **prima di lgbm_exit** e
**prima di max_hold**, non solo prima di SL/TP.

L'ordine corretto nel loop (~riga 735) è:

```
liquidation → lgbm_exit → max_hold → SL/TP
```

Aggiungere il blocco liquidazione **subito dopo** `bars_held = i - position["bar_idx"]`
e **prima** del blocco `lgbm_exit`:

```python
bars_held      = i - position["bar_idx"]
already_closed = False

# ── Liquidation check — massima priorità (prima di ogni altro exit) ─────────
if not already_closed and lev > 1:
    _lp = position.get("liq_px", 0.0)
    if _lp > 0.0:
        _hit_liq = (side == "long"  and curr_low  <= _lp) or \
                   (side == "short" and curr_high >= _lp)
        if _hit_liq:
            param_stats["exit_liquidation"] = param_stats.get("exit_liquidation", 0) + 1
            pnl_pct  = ((_lp - entry) / entry * 100 if side == "long"
                        else (entry - _lp) / entry * 100)
            pnl_usd  = position["size_usd"] * pnl_pct / 100
            fee_exit = position["size_usd"] * HL_TAKER_FEE
            entry_fee_used = position.get("fee_entry", 0.0)
            funding_used   = position.get("funding_paid", 0.0)
            equity += pnl_usd - fee_exit
            trades.append({
                "side":         side,
                "entry":        entry,
                "exit":         _lp,
                "pnl_pct":      round(pnl_pct, 4),
                "pnl_usd":      round(pnl_usd - fee_exit - entry_fee_used - funding_used, 2),
                "fee_entry":    round(entry_fee_used, 2),
                "funding_paid": round(funding_used, 2),
                "reason":       "liquidation",
                "holding_bars": i - position["bar_idx"],
                "bar":          i,
                "origin":       position.get("origin", "trend"),
            })
            equity_curve.append({"bar": i, "equity": round(equity, 2)})
            position       = None
            already_closed = True
```

> **Perché prima di lgbm_exit?** Se in una candela il prezzo tocca il liq_px,
> la liquidazione avviene intrabar e ogni successivo check (lgbm, max_hold, SL/TP)
> deve essere saltato. Con `already_closed=True` tutti i blocchi successivi sono
> già protetti dalla loro guard `if not already_closed:`.

> **`param_stats["exit_liquidation"]`**: usa `param_stats.get()` invece di `+= 1`
> direttamente perché questa chiave non è nella lista iniziale di `param_stats`. 
> Alternativamente, aggiungere `"exit_liquidation": 0` all'init di `param_stats`.

---

### 4.15 — main.py: Pydantic BotConfig

Aggiungere dopo `max_consecutive_losses`:

```python
leverage: int = Field(1, ge=1, le=50)
```

> `BacktestRequest` **non** riceve un campo `leverage` separato — viene letto da
> `req.config.leverage` nel backtest engine.

---

### 4.16 — BotConfig.tsx: interfaccia, defaults e UI

**Config interface** (aggiungere):
```typescript
leverage: number;
```

**DEFAULTS** (aggiungere):
```typescript
leverage: 1,
```

**UI — sezione "Dimensionamento Posizione"** (subito dopo il slider `position_size_pct`):

```tsx
{/* Leverage */}
<div>
  <div className="flex items-center justify-between mb-1">
    <p className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">
      Leva Isolata
    </p>
    <span className="text-[11px] font-bold font-mono text-orange-600 dark:text-orange-400">
      {config.leverage}×
      {config.leverage > 1 && (
        <span className="ml-2 text-slate-400 font-normal">
          · margine {(100 / config.leverage).toFixed(0)}% del notional
        </span>
      )}
    </span>
  </div>
  <input
    type="range" min="1" max="50" step="1"
    value={config.leverage}
    onChange={e => setConfig(c => ({ ...c, leverage: parseInt(e.target.value) }))}
    className="w-full h-1.5 rounded-full appearance-none cursor-pointer ..."
  />
  {config.leverage > 1 && (
    <p className="text-[10px] text-amber-500 dark:text-amber-400 mt-1">
      ⚠ Leva {config.leverage}× — liquidazione a ~{(100/config.leverage - 0.5).toFixed(1)}%
      di movimento avverso. SL consigliato &lt; {((1/config.leverage - 0.005) * 100 * 0.8).toFixed(1)}%.
    </p>
  )}
</div>

{/* Warning SL vs liquidazione */}
{config.leverage > 5 && config.sl_atr_mult > 2.5 && (
  <div className="flex gap-2 bg-red-50 dark:bg-red-500/10 border border-red-200 rounded-xl px-3 py-2 mt-2">
    <p className="text-[10px] text-red-600 dark:text-red-400">
      Con leva {config.leverage}× il prezzo di liquidazione potrebbe trovarsi
      <strong> prima dell'SL</strong>. Riduci sl_atr_mult o abbassa la leva.
    </p>
  </div>
)}
```

---

### 4.17 — BacktestPanel.tsx: aggiornamenti ⚠ FALLA DEL PIANO ORIGINALE

**Problema critico:** Il BacktestPanel.tsx ha già un sistema di simulazione leverage
**frontend-side** (`applyLeverage()` + `LeverageSelector`) che opera post-hoc sui
risultati del backtest. Se il backend esegue il backtest con `leverage=5` (liquidazioni
reali incluse) e poi l'utente applica anche il display leverage 5×, i risultati sono
**double-leveraged**.

La soluzione è:
1. Aggiungere `leverage` a `buildConfig()` così viene inviato al backend
2. Aggiungere una variabile `botLeverage` al drawer (come `slMult`, `tpMult`, etc.)
3. Disabilitare il `LeverageSelector` display quando `buildConfig().leverage > 1`
4. **Non** usare `setLeverage` del display in `applyConfig`

**`buildConfig()`** — aggiungere:
```typescript
const buildConfig = (withAdvanced: boolean) => ({
  ...
  leverage: parseInt(botLeverageStr),  // ← aggiunto
  ...
});
```

**Variabile drawer** (aggiungere vicino a `posSizePct`):
```typescript
const [botLeverageStr, setBotLeverageStr] = useState<string>("1");
```

**`applyConfig`** — aggiornare (NON chiamare `setLeverage` del display):
```typescript
const applyConfig = useCallback((p: Record<string, any>) => {
  ...
  if (p.leverage !== undefined) setBotLeverageStr(String(p.leverage));
  // NON chiamare setLeverage(p.leverage) — quello è il display leverage post-hoc
  ...
}, [...deps, setBotLeverageStr]);
```

**`drawerHasCustom`** — aggiungere:
```typescript
const drawerHasCustom = ... || parseInt(botLeverageStr) !== 1;
```

**Disabilitare il display `LeverageSelector` quando leverage backend > 1:**
```tsx
{/* Leverage display selector — disabilitato se il backtest usa leverage reale */}
{buildConfig(true).leverage <= 1 && (
  <LeverageSelector value={leverage} onChange={setLeverage} ... />
)}
{buildConfig(true).leverage > 1 && (
  <p className="text-[10px] text-amber-500 mt-1">
    Il backtest include già leva {buildConfig(true).leverage}×
    (con liquidazioni). Simulazione display non disponibile.
  </p>
)}
```

**Download config** (sezione statistics):
```typescript
lines.push(`Leva:                 ${buildConfig(true).leverage}×`);
```

---

## 5. Ordine di implementazione consigliato

1. **Step 1 — Costanti, BotConfig, risk.py** (15 min)
   - Aggiungere `HL_MM_RATE`, `HL_MAX_LEV` in execution.py
   - Aggiungere `leverage` in `BotConfig.__init__`
   - Aggiungere `leverage: int = Field(1, ge=1, le=50)` in Pydantic BotConfig (main.py)
   - Aggiungere parametro `leverage: int = 1` + logica sizing + cap a `calculate_trade_params`

2. **Step 2 — Helper `_calc_liq_px` + `_open_position`** (20 min)
   - Aggiungere metodo statico `_calc_liq_px`
   - Aggiornare path normale in `_open_position` (call a `calculate_trade_params` + liq_px + warning)
   - Aggiornare path `_has_overrides` in `_open_position` (⚠ sizing × leverage)
   - Aggiungere campi `leverage`, `liq_px`, `margin_usd` al dict `self._position`

3. **Step 3 — Paper mode: watchdog + manage + persist + restore** (20 min)
   - `_paper_watchdog`: check liquidazione (con `continue` dopo close)
   - `_manage_position`: check liquidazione paper (prima del trailing SL)
   - `_persist_position_state`: aggiungere 3 campi per live mode
   - `_restore_paper_state`: retrocompatibilità `liq_px`
   - `_reconcile_position`: retrocompatibilità `liq_px` per live
   - `get_status()`: esporre i 3 campi

4. **Step 4 — Backtest** (30 min)
   - Funzione `_liq_price()` modulo-level in backtesting.py
   - Aggiungere `lev = getattr(cfg, "leverage", 1)` all'inizio di `run_backtest`
   - Aggiungere `leverage` a `calculate_trade_params` call in backtesting.py
   - Aggiungere `liq_px` + `leverage` ai 4 path di apertura posizione
   - Aggiungere check liquidazione nel loop (PRIMA di lgbm_exit)
   - Aggiungere `"exit_liquidation": 0` all'init di `param_stats`

5. **Step 5 — Live HL: `update_leverage`** (10 min)
   - Chiamata `update_leverage()` in `_submit_open_order`

6. **Step 6 — Frontend** (30 min)
   - `BotConfig.tsx`: interface + DEFAULTS + UI slider + warning
   - `BacktestPanel.tsx`: `botLeverageStr` var + `buildConfig()` + `applyConfig` + `drawerHasCustom` + LeverageSelector guard

7. **Step 7 — Deploy e verifica** (15 min)
   - Build frontend
   - Deploy backend + frontend
   - Verifica con backtest leva 1×, 5× e 10× sullo stesso periodo

---

## 6. Testing — piano di verifica

### 6.1 Unit test formula liquidazione

Prima di qualsiasi deploy, verificare la formula con valori noti:

```python
# Da eseguire manualmente in un REPL (dalla directory apps/api)
from services.execution import ExecutionEngine

# Long 10x: liq = 100_000 * (1 - 0.1 + 0.005) = 90_500
assert abs(ExecutionEngine._calc_liq_px("long",  100_000, 10) - 90_500) < 1
# Short 10x: liq = 100_000 * (1 + 0.1 - 0.005) = 109_500
assert abs(ExecutionEngine._calc_liq_px("short", 100_000, 10) - 109_500) < 1
# Long 5x: liq = 100_000 * (1 - 0.2 + 0.005) = 80_500
assert abs(ExecutionEngine._calc_liq_px("long",  100_000,  5) - 80_500) < 1
# Leva 1: nessuna liquidazione
assert ExecutionEngine._calc_liq_px("long", 100_000, 1) == 0.0
print("Tutti i test passano ✓")
```

### 6.2 Verifica backtest

Eseguire due backtest identici sullo stesso periodo (es. 2024-01-01 → 2024-12-31):

| Parametro | Run A | Run B |
|-----------|-------|-------|
| leverage  | 1×    | 5×   |
| position_size_pct | 1.5% | 1.5% |

**Risultati attesi:**
- Run A: zero trade con reason `"liquidation"`
- Run B: presenza di trade `"liquidation"` in periodi di alta volatilità
- Run B: max drawdown significativamente più alto
- PnL di ogni singolo trade **non-liquidato** in Run B = **5× Run A** (stessa entry/exit)

> **Verifica numerica** (equity=$10.000, pos_size=1.5%, SL=2%, leva=5):
> - Run A: size_usd=$7.500, win ≈+$262 (3.5% TP), loss ≈−$150 (2% SL)
> - Run B: size_usd=$37.500, win ≈+$1.312, loss ≈−$750 — esattamente 5×

### 6.3 Verifica paper mode

1. Avviare bot in paper mode con `leverage=10`
2. Aprire una posizione (attendere un segnale o forzarla manualmente)
3. Verificare nei log: `"Leverage 10× | liq_px=XXXX.XX (margin=XXX USD)"`
4. Verificare nel Monitor UI che `liq_px` sia visibile
5. Verificare retrocompatibilità: con una posizione paper aperta pre-deploy,
   riavviare il bot e controllare che `liq_px` venga ricalcolato correttamente

### 6.4 Test live su HL testnet

Prima di usare in produzione con soldi reali:

1. Impostare `HL_TESTNET=true` nel `.env` del VPS
2. Avviare bot in modalità `live` con `leverage=5`
3. Verificare nei log: `"HL leverage set to 5× isolated: ..."` senza errori
4. Aprire il sito HL testnet — verificare che la posizione mostri "5× Isolated"
5. Chiudere la posizione manualmente (kill switch)
6. Ripristinare `HL_TESTNET=false`

**Risposta attesa da `update_leverage`:**
```python
{"status": "ok"}     # successo
{"status": "err", "response": "..."} # errore — loggare come warning
```

### 6.5 Verifica double-leverage nel backtest frontend

Con backend `leverage=5`:
1. Eseguire un backtest con `leverage=5` nel drawer
2. Verificare che il `LeverageSelector` display sia disabilitato o mostri il messaggio
3. Verificare che i risultati NON siano ulteriormente moltiplicati dal display

---

## 7. Rischi e mitigazioni

| Rischio | Probabilità | Impatto | Mitigazione |
|---------|------------|---------|-------------|
| `update_leverage` fallisce silenziosamente su HL | Bassa | Alto | Log esplicito warning — HL usa leva precedente del conto |
| Leva impostata nel ciclo precedente rimane per il successivo | Media | Medio | `update_leverage` chiamato prima di **ogni** ordine, non solo al primo |
| SL configurato oltre il prezzo di liquidazione | Media | Alto | Warning in `_open_position` + warning UI se `leverage > 5` e `sl_atr_mult > 2.5` |
| Posizioni paper/live aperte prima del feature (senza `liq_px`) | Alta | Basso | Retrocompatibilità in `_restore_paper_state` + `_reconcile_position` |
| Backtest double-leverage (backend leverage + display leverage) | Alta (se non gestita) | Alto | Disabilitare `LeverageSelector` display quando `config.leverage > 1` |
| Pullback/reversal entries nel backtest senza `liq_px` | Alta (se non gestita) | Alto | Aggiungere `liq_px` ai 4 path di apertura (§4.14C) |
| Priorità sbagliata dei check nel backtest (liq dopo lgbm_exit) | Alta (se non gestita) | Medio | Check liquidazione PRIMA di lgbm_exit (§4.14D) |
| Reversal retest fill senza leva (path `_has_overrides`) | Alta (se non gestita) | Alto | Moltiplicare sizing × leverage anche nel path override (§4.6) |
| Margine richiesto > equity (configurazione estrema) | Bassa | Alto | Cap in risk.py: `margin ≤ equity × 0.95` con log warning (§4.3) |

---

## 8. Decisioni di design

### Leva nel BotConfig, non in BacktestRequest

`leverage` è un parametro strategico della posizione (come `sl_atr_mult`, `position_size_pct`),
non un parametro operativo del backtest. Appartiene in `BotConfig` e viene letto come
`getattr(cfg, "leverage", 1)` in backtesting.py. Aggiungere anche `BacktestRequest.leverage`
creerebbe ambiguità su quale dei due ha la precedenza.

### Frontend: display leverage vs leverage configurato

I due sistemi servono scopi distinti:
- **Config `leverage`** → leva reale del bot (paper/live/backtest con liquidazioni)
- **Display `LeverageSelector`** → simulazione post-hoc visiva (no re-run)

Quando il config leverage > 1, il backtest ha già liquidazioni reali calcolate dal backend.
Applicare anche il display leverage produrrebbe risultati doppiamente amplificati. Il display
deve essere disabilitato in questo caso.

### Helper `_liq_price()` inline nel backtest

Invece di importare `ExecutionEngine._calc_liq_px` in backtesting.py (import pesante,
potenziale dipendenza circolare), si definisce una funzione standalone di 5 righe
con la stessa logica. Le due implementazioni devono rimanere sincronizzate — la formula
è stabile (costanti HL).

### `continue` nel watchdog dopo liquidazione

Dopo `await self._close_position(liq_px, "liquidation")` nel watchdog, bisogna
usare `continue` per saltare il successivo check SL/TP. Senza `continue`, il codice
procederebbe a leggere `self._position["stop_loss"]` su una posizione già chiusa
(None), causando un `NoneType` error.

### Ordine dei check nel backtest: liq → lgbm_exit → max_hold → SL → TP

La liquidazione ha priorità assoluta perché viene forzata dall'exchange. Se in una
barra il prezzo tocca sia `liq_px` che il prezzo di lgbm_exit, la liquidazione
prevale. L'`already_closed=True` guard protegge tutti i blocchi successivi.

---

## 9. Sommario dei parametri aggiunti

| Parametro | Tipo | Default | Range | Dove |
|-----------|------|---------|-------|------|
| `leverage` | `int` | `1` | 1–50 | BotConfig (backend + frontend drawer) |
| `liq_px` | `float` | calcolato | — | `_position` dict (runtime) |
| `margin_usd` | `float` | calcolato | — | `_position` dict (runtime) |
| `HL_MM_RATE` | `float` | `0.005` | costante | execution.py modulo level |
| `HL_MAX_LEV` | `int` | `50` | costante | execution.py modulo level |
| `_liq_price()` | funzione | — | — | backtesting.py modulo level |
| `exit_liquidation` | `int` | `0` | counter | `param_stats` dict in backtest |
