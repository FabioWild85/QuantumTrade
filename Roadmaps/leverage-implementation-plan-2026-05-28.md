# Piano di Implementazione — Leva Configurabile (Paper + Live HL)

**Data:** 28 Maggio 2026  
**Stato:** Pianificazione — non ancora implementato  
**Priorità:** Media — funzionalità operativa, non safety-critical  
**Stima:** 3-4 ore di lavoro, ~200 righe totali

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
   controlla ad ogni bar e nel watchdog, simulando fedelmente il rischio reale.
3. In **live mode (HL)** — chiama `exchange.update_leverage()` prima di ogni ordine,
   impostando la leva isolated sulla coppia BTCUSDC.
4. In **backtest** — aggiunge un exit event `"liquidation"` quando il prezzo tocca
   la soglia di liquidazione intrabar.
5. In **UI (BotConfig)** — uno slider 1×–50× con label dinamica che mostra margine
   richiesto, rischio per trade in dollari e prezzo di liquidazione stimato.

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

> **Nota:** La formula non include la fee d'ingresso nell'equazione principale perché
> su HL le fee non riducono il margine isolato — il motore di liquidazione usa solo
> la variazione di mark price vs margine. Questa formula è accurata per simulazione
> paper e backtest.

### Costanti da centralizzare in execution.py

```python
HL_MM_RATE  = 0.005   # Maintenance margin rate BTC isolated
HL_MAX_LEV  = 50      # Leva massima HL per BTC
```

---

## 3. File da modificare

| File | Sezione | Tipo di modifica |
|------|---------|-----------------|
| `apps/api/services/execution.py` | `BotConfig.__init__` | Aggiungere campo `leverage` |
| `apps/api/services/execution.py` | `_open_position` | Passare `leverage` a `calculate_trade_params`, salvare `liq_px` |
| `apps/api/services/execution.py` | `_paper_watchdog` | Controllare `liq_px` ogni 30s |
| `apps/api/services/execution.py` | `_manage_position` | Controllare `liq_px` ad ogni bar (paper) |
| `apps/api/services/execution.py` | `_submit_open_order` | Chiamare `update_leverage()` prima dell'ordine |
| `apps/api/services/execution.py` | `_restore_paper_state` | Includere `liq_px` nel restore |
| `apps/api/services/execution.py` | `_persist_position_state` | Persistere `liq_px` |
| `apps/api/services/risk.py` | `calculate_trade_params` | **Moltiplicare `risk_usd × leverage`** + safety cap margine |
| `apps/api/main.py` | `BotConfig` Pydantic | Aggiungere `leverage: int = Field(1, ge=1, le=50)` |
| `apps/api/main.py` | `BacktestRequest` Pydantic | Aggiungere `leverage: int = Field(1, ge=1, le=50)` |
| `apps/api/services/backtesting.py` | `calculate_trade_params` call | Passare `leverage=lev` |
| `apps/api/services/backtesting.py` | loop principale | Aggiungere exit `"liquidation"` intrabar |
| `apps/web/components/trading-hub/BotConfig.tsx` | Config interface | Aggiungere `leverage: number` |
| `apps/web/components/trading-hub/BotConfig.tsx` | DEFAULTS | `leverage: 1` |
| `apps/web/components/trading-hub/BotConfig.tsx` | UI section | Slider leva + rischio USD + margine USD |
| `apps/web/components/trading-hub/BacktestPanel.tsx` | `applyConfig` | Mappare `p.leverage` |
| `apps/web/components/trading-hub/BacktestPanel.tsx` | `drawerHasCustom` | `|| leverage !== 1` |

---

## 4. Dettaglio implementazione

### 4.1 — execution.py: costanti (in cima al file, vicino a `HL_TAKER_FEE`)

```python
HL_MM_RATE = 0.005   # Maintenance margin rate BTC isolated margin
HL_MAX_LEV = 50      # Max leverage HL BTC-PERP
```

---

### 4.2 — execution.py: BotConfig (aggiunta campo)

Posizione: dopo `max_consecutive_losses`, prima di `mode`.

```python
self.leverage = kw.get("leverage", 1)  # 1 = no leverage (default)
```

Vincolo di validità: clamp in `update_config` o nel Pydantic.

---

### 4.2b — risk.py: `calculate_trade_params` (modifica principale del sizing)

Questo è **il cambiamento più importante** — senza di esso la leva non ha effetto
sul notional e il PnL non viene amplificato.

La funzione `calculate_trade_params` riceve già `equity_usd` ma non `leverage`.
Va aggiunto come parametro con default `1`.

**Firma attuale:**
```python
def calculate_trade_params(self, side, entry_price, atr, equity_usd, sl_atr=None, ...)
```

**Firma aggiornata:**
```python
def calculate_trade_params(self, side, entry_price, atr, equity_usd,
                           leverage: int = 1,   # ← nuovo parametro
                           sl_atr=None, ...)
```

**Logica sizing aggiornata** (riga ~236 in risk.py):

```python
# Prima (senza leverage):
risk_usd = equity_usd * (self.position_size_pct / 100) * size_mult
size_usd = risk_usd / sl_pct

# Dopo (con leverage):
risk_usd = equity_usd * (self.position_size_pct / 100) * size_mult * max(leverage, 1)
size_usd = risk_usd / sl_pct if sl_pct > 1e-6 else risk_usd

# Safety cap: il margine usato non può superare il 95% dell'equity disponibile
# margin_usd = size_usd / leverage (soldi realmente depositati su HL)
_eff_lev = max(leverage, 1)
_margin  = size_usd / _eff_lev
if _margin > equity_usd * 0.95:
    size_usd = equity_usd * 0.95 * _eff_lev   # ricap al massimo sicuro
    risk_usd = size_usd * sl_pct               # aggiorna anche risk
    log.warning(
        "Position size capped: margin (%.0f) would exceed 95%% of equity (%.0f). "
        "size_usd reduced to %.0f.", _margin, equity_usd, size_usd
    )

size_contracts = size_usd / entry_price
```

**Esempio numerico con il cap:**
- equity=$10.000, leverage=50, position_size_pct=1.5%, sl_pct=2%
- risk_usd = $10.000 × 1.5% × 50 = $7.500
- size_usd = $7.500 / 2% = $375.000 notional
- margin = $375.000 / 50 = $7.500 → 75% di equity → **sotto il cap**, ok
- Con leva 50× e sl_pct=0.1%: size_usd = $75.000.000 → margin = $1.500.000 → **cap attivo**

Il cap garantisce che, anche con configurazioni estreme, il bot non tenti di
aprire posizioni che richiedono più collaterale di quello disponibile.

**Dove viene chiamata `calculate_trade_params`:**

In `execution.py` ci sono due call site:
1. In `_open_position` (~riga 1302): aggiungere `leverage=self.config.leverage`
2. In backtest loop `backtesting.py` (~riga 558): aggiungere `leverage=lev`

---

### 4.3 — execution.py: helper `_calc_liq_px` (metodo privato)

Aggiungere come metodo statico della classe `ExecutionEngine`:

```python
@staticmethod
def _calc_liq_px(side: str, entry: float, leverage: int) -> float:
    """
    Hyperliquid isolated margin liquidation price.
    Formula: long  → entry × (1 − 1/L + MM_rate)
             short → entry × (1 + 1/L − MM_rate)
    """
    if leverage <= 1:
        return 0.0  # leverage 1 → no liquidation possible (margin = full notional)
    if side == "long":
        return entry * (1.0 - 1.0 / leverage + HL_MM_RATE)
    else:
        return entry * (1.0 + 1.0 / leverage - HL_MM_RATE)
```

> **Perché `return 0.0` per leva 1×?** Con leva 1× il margine è pari al notional
> intero — la posizione può andare a zero prima di essere liquidata. In pratica non
> esiste un prezzo di liquidazione raggiungibile a prezzi positivi. Restituire 0.0
> e non controllarlo è corretto.

---

### 4.4 — execution.py: `_open_position` (calcolo e storage di liq_px)

Posizione: dopo il blocco di calcolo SL/TP, prima della costruzione di `self._position`.

```python
liq_px = self._calc_liq_px(result.action, price, self.config.leverage)
if liq_px > 0.0:
    log.info(
        "[%s] Leverage %d× | liq_px=%.2f (margin=%.0f USD)",
        self.mode.upper(), self.config.leverage, liq_px,
        eff_size_usd / self.config.leverage,
    )
```

Nel dict `self._position` aggiungere:

```python
"leverage":   self.config.leverage,
"liq_px":     liq_px,
"margin_usd": round(eff_size_usd / max(self.config.leverage, 1), 2),
```

---

### 4.5 — execution.py: `_paper_watchdog` (check liquidazione ogni 30s)

Il watchdog attuale controlla SL e TP (righe 663-668). Aggiungere il check
liquidazione **prima** del check SL, poiché la liquidazione ha priorità (avviene
prima dell'SL se la leva è alta e l'SL è lontano).

```python
# Check liquidazione (solo paper — in live ci pensa HL)
liq_px = self._position.get("liq_px", 0.0)
side   = self._position.get("side")
if liq_px > 0.0:
    hit_liq = (side == "long"  and mark <= liq_px) or \
              (side == "short" and mark >= liq_px)
    if hit_liq:
        reason = "liquidation"
```

Subito dopo, nel body del `if reason:` esistente, nessuna modifica — `_close_position`
gestisce già il log e il DB con qualsiasi reason.

---

### 4.6 — execution.py: `_manage_position` (check liquidazione intrabar)

Il metodo attuale controlla SL/TP usando `should_stop_loss` / `should_take_profit`.
Aggiungere prima di questi check:

```python
# Liquidation check (paper only — live: HL enforces natively)
if self.mode == "paper":
    liq_px = self._position.get("liq_px", 0.0)
    if liq_px > 0.0:
        hit_liq = (side == "long"  and current_price <= liq_px) or \
                  (side == "short" and current_price >= liq_px)
        if hit_liq:
            await self._close_position(liq_px, "liquidation")
            return
```

Usare `liq_px` come `exit_price` (non `current_price`): la liquidazione avviene
esattamente al prezzo di liquidazione, non al mark price successivo.

---

### 4.7 — execution.py: `_submit_open_order` (impostare leva su HL prima dell'ordine)

Posizione: dopo la costruzione dell'oggetto `Exchange`, prima del blocco `order`.

```python
# Set isolated leverage on HL before opening
leverage = getattr(self.config, "leverage", 1)
if leverage > 1:
    try:
        lev_result = await asyncio.to_thread(
            exchange.update_leverage,
            leverage,   # leverage intero
            SYMBOL,     # "BTC"
            False,      # is_cross = False → isolated margin
        )
        log.info("HL leverage set to %d× isolated: %s", leverage, lev_result)
    except Exception as exc:
        log.warning("Could not set leverage on HL (non-blocking): %s", exc)
        # Non-blocking: procediamo con la leva corrente del conto
```

> **Importante:** Se `update_leverage` fallisce, logghiamo ma non blocchiamo
> l'ordine. HL userà la leva già impostata sul conto. È preferibile eseguire il
> trade con leva sbagliata piuttosto che perdere l'entry del tutto. Questa scelta
> può essere resa più restrittiva (raise invece di warn) in un secondo momento.

---

### 4.8 — execution.py: `_restore_paper_state` e `_persist_position_state`

In `_persist_position_state` (che salva lo stato su DB tra un ciclo e l'altro),
aggiungere `"liq_px"` e `"leverage"` ai campi salvati, analogamente a come sono
già salvati `stop_loss`, `take_profit`, ecc.

In `_restore_paper_state`, dopo il ripristino dei campi SL/TP, aggiungere:

```python
if "liq_px" in saved_state:
    self._position["liq_px"]     = saved_state["liq_px"]
    self._position["leverage"]   = saved_state.get("leverage", 1)
    self._position["margin_usd"] = saved_state.get("margin_usd", 0.0)
```

Se `liq_px` non è nel saved_state (upgrade da versione precedente senza leva),
ricalcolarlo al volo:

```python
else:
    _lev = saved_state.get("leverage", self.config.leverage)
    self._position["leverage"]   = _lev
    self._position["liq_px"]     = self._calc_liq_px(
        self._position["side"], self._position["entry_price"], _lev
    )
```

Questo garantisce la retrocompatibilità: posizioni aperte senza `liq_px` vengono
aggiornate correttamente al prossimo restart.

---

### 4.9 — backtesting.py: liquidazione intrabar

Nel loop principale, aggiungere il check **subito dopo** il calcolo di `hit_sl` e
`hit_tp`, prima del blocco `if hit_sl or hit_tp:`.

**A. Calcolo di liq_px all'apertura della posizione**

Nel blocco di apertura (dove viene costruito il dict `position`), aggiungere:

```python
lev     = getattr(req, "leverage", 1)  # passato dal req del backtest
liq_px  = ExecutionEngine._calc_liq_px(side, entry_price, lev) if lev > 1 else 0.0
position = {
    ...
    "leverage": lev,
    "liq_px":   liq_px,
}
```

**B. Check intrabar (usa high/low, non solo close)**

```python
if not already_closed and position.get("liq_px", 0.0) > 0.0:
    lp = position["liq_px"]
    hit_liq = (side == "long"  and curr_low  <= lp) or \
              (side == "short" and curr_high >= lp)
    if hit_liq:
        # Liquidazione: equity azzera il margine (worst-case = perde tutto il margine)
        pnl_pct = (lp - entry) / entry * 100 if side == "long" \
                  else (entry - lp) / entry * 100
        pnl_usd    = position["size_usd"] * pnl_pct / 100
        fee_exit   = position["size_usd"] * HL_TAKER_FEE
        entry_fee_used = position.get("fee_entry", 0.0)
        funding_used   = position.get("funding_paid", 0.0)
        equity += pnl_usd - fee_exit
        trades.append({
            "side": side, "entry": entry, "exit": lp,
            "pnl_pct":    round(pnl_pct, 4),
            "pnl_usd":    round(pnl_usd - fee_exit - entry_fee_used - funding_used, 2),
            "fee_entry":  round(entry_fee_used, 2),
            "funding_paid": round(funding_used, 2),
            "reason":     "liquidation",
            "holding_bars": i - position["bar_idx"],
            "bar":        i,
        })
        equity_curve.append({"bar": i, "equity": round(equity, 2)})
        position       = None
        already_closed = True
```

> **Ordine di priorità intrabar:** la liquidazione deve essere controllata
> **prima** di SL e TP. Se in una candela il low tocca sia il liq_px che l'SL,
> la liquidazione (avviene più in basso del SL) prevale. La struttura corretta è:
> `liq → SL → TP` (ognuno con `already_closed` guard).

**C. `_valid_reasons` nel backtest**

In `_calculate_stats` o nella funzione che costruisce le stats, `"liquidation"` è
già gestita correttamente — è una reason valida come `"stop_loss"`. Nessuna modifica
necessaria alle statistiche: una liquidazione è semplicemente un trade chiuso con
PnL negativo.

---

### 4.10 — main.py: Pydantic BotConfig

Nel modello Pydantic (usato per la validazione delle PUT /bot/config):

```python
leverage: int = Field(1, ge=1, le=50)
```

Il vincolo `ge=1, le=50` corrisponde ai limiti reali di HL per BTC-PERP.

---

### 4.11 — BotConfig.tsx: interfaccia e UI

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
```

**Warning aggiuntivo** se `leverage > 1` e `sl_atr_mult` è alto (rischio SL oltre
la liquidazione):

```tsx
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

### 4.12 — BacktestPanel.tsx: aggiornamenti

**`applyConfig`**: aggiungere
```typescript
if (p.leverage !== undefined) setLeverage(Number(p.leverage));
```

**`drawerHasCustom`**: aggiungere `|| leverage !== 1`

**Download config** (sezione statistics): aggiungere
```
lines.push(`Leva:                 ${leverage}×`);
```

---

## 5. Ordine di implementazione consigliato

Seguire questo ordine riduce il rischio di stati inconsistenti durante lo sviluppo:

1. **Step 1 — Costanti e BotConfig** (10 min)
   - Aggiungere `HL_MM_RATE`, `HL_MAX_LEV` in execution.py
   - Aggiungere `leverage` in `BotConfig.__init__` e Pydantic main.py + BacktestRequest
   - Aggiungere parametro `leverage: int = 1` a `RiskManager.calculate_trade_params`

2. **Step 2 — Sizing con leverage in risk.py** (15 min)
   - Moltiplicare `risk_usd × leverage` in `calculate_trade_params`
   - Aggiungere safety cap margine con log warning
   - Aggiornare i call site in execution.py e backtesting.py

3. **Step 3 — Helper `_calc_liq_px`** (5 min)
   - Metodo statico `ExecutionEngine._calc_liq_px`
   - Verificare con unit test manuale (vedere §6.1)

4. **Step 4 — Paper mode: open + watchdog + manage** (30 min)
   - `_open_position`: calcolo e storage `liq_px`, `margin_usd`
   - `_paper_watchdog`: check liquidazione
   - `_manage_position`: check liquidazione paper
   - `_restore_paper_state` / `_persist_position_state`: retrocompatibilità

5. **Step 5 — Backtest** (30 min)
   - Calcolo `liq_px` all'apertura in backtesting.py
   - Check intrabar con priorità corretta (liq → SL → TP)

6. **Step 6 — Live HL: `update_leverage`** (15 min)
   - Chiamata `update_leverage()` in `_submit_open_order`
   - Test su testnet (vedere §6.3)

7. **Step 7 — Frontend** (30 min)
   - Slider BotConfig.tsx con label rischio USD + margine USD
   - `applyConfig`, `drawerHasCustom` in BacktestPanel.tsx
   - Warning SL vs liquidazione

8. **Step 8 — Deploy e verifica** (15 min)
   - Build frontend
   - Deploy backend + frontend
   - Verifica con backtest leva 1×, 5× e 10× sullo stesso periodo

---

## 6. Testing — piano di verifica

### 6.1 Unit test formula liquidazione

Prima di qualsiasi deploy, verificare la formula con valori noti:

```python
# Da eseguire manualmente in un REPL
from services.execution import ExecutionEngine

# Long 10x: liq = 100_000 * (1 - 0.1 + 0.005) = 90_500
assert abs(ExecutionEngine._calc_liq_px("long",  100_000, 10) - 90_500) < 1
# Short 10x: liq = 100_000 * (1 + 0.1 - 0.005) = 109_500
assert abs(ExecutionEngine._calc_liq_px("short", 100_000, 10) - 109_500) < 1
# Long 5x: liq = 100_000 * (1 - 0.2 + 0.005) = 80_500
assert abs(ExecutionEngine._calc_liq_px("long",  100_000,  5) - 80_500) < 1
# Leva 1: nessuna liquidazione
assert ExecutionEngine._calc_liq_px("long", 100_000, 1) == 0.0
```

### 6.2 Verifica backtest

Eseguire due backtest identici sullo stesso periodo (es. 2024-01-01 → 2024-12-31):

| Parametro | Run A | Run B |
|-----------|-------|-------|
| leverage  | 1×    | 10×   |
| position_size_pct | 1.5% | 1.5% |

**Risultati attesi:**
- Run A: zero trade con reason `"liquidation"`
- Run B: presenza di trade `"liquidation"` (specialmente durante alta volatilità)
- Run B: max drawdown significativamente più alto (ogni trade perde/guadagna 5× di più)
- Run B: Sharpe più basso o negativo se la leva è alta
- PnL di ogni singolo trade **non-liquidato** in Run B deve essere esattamente **5×**
  rispetto al corrispondente trade in Run A (stessa entry/exit, `size_usd` = 5× →
  PnL = 5×). Questo è il comportamento atteso e corretto.
- Il `margin_usd` in Run B è identico a `size_usd` in Run A (75% di equity entrambi,
  ma Run B controlla 5× più notional).

> **Verifica numerica attesa** (equity=$10.000, pos_size=1.5%, SL=2%, leva=5):
> - Run A: size_usd=$7.500, win +$262 (3.5% TP), loss −$150 (2% SL)
> - Run B: size_usd=$37.500, win +$1.312, loss −$750 — esattamente 5×

### 6.3 Test live su HL testnet

Prima di usare in produzione con soldi reali:

1. Impostare `HL_TESTNET=true` nel `.env` del VPS
2. Avviare bot in modalità `live` con `leverage=5`
3. Verificare nei log: `"HL leverage set to 5× isolated: ..."` senza errori
4. Aprire il sito HL testnet — verificare che la posizione mostri "5× Isolated"
5. Verificare che l'ordine SL nativo sia correttamente dimensionato
6. Chiudere la posizione manualmente (kill switch)
7. Ripristinare `HL_TESTNET=false`

**Cosa verificare sulla risposta di `update_leverage`:**
```python
# Risposta attesa da HL SDK:
{"status": "ok"}
# Risposta di errore:
{"status": "err", "response": "..."}
```
Se la risposta è `"err"`, loggarla come `log.error` invece di `warning` e considerare
di bloccare l'ordine (`return None` da `_submit_open_order`).

### 6.4 Verifica SL vs liquidazione (scenario critico)

Con leva alta, il SL potrebbe essere configurato a una distanza maggiore del buffer
al liquidation price. Esempio pericoloso:

- Leva 20×: `liq_px` a `entry × (1 - 0.05 + 0.005) = entry × 0.955` → 4.5% di distanza
- `sl_atr_mult=3.0`, ATR=2% di entry → SL a 6% di distanza → **SL è oltre la liquidazione**

In questo caso la posizione viene liquidata prima che l'SL scatti.
Aggiungere un log `WARNING` in `_open_position` se questa condizione è vera:

```python
sl_dist_pct = abs(params.stop_loss - price) / price
liq_dist_pct = abs(liq_px - price) / price if liq_px > 0 else float("inf")
if liq_dist_pct < sl_dist_pct:
    log.warning(
        "[%s] SL (%.1f%%) è OLTRE il prezzo di liquidazione (%.1f%%) con leva %d×. "
        "La posizione verrà liquidata prima dello stop loss.",
        self.mode.upper(), sl_dist_pct * 100, liq_dist_pct * 100, self.config.leverage
    )
```

---

## 7. Rischi e mitigazioni

| Rischio | Probabilità | Impatto | Mitigazione |
|---------|------------|---------|-------------|
| `update_leverage` fallisce silenziosamente su HL | Bassa | Alto | Log esplicito + opzione per bloccare l'ordine |
| Leva impostata sul conto HL dal ciclo precedente rimane attiva per il successivo | Media | Medio | `update_leverage` viene chiamato prima di **ogni** ordine, non solo al primo |
| SL configurato oltre il prezzo di liquidazione | Media | Alto | Warning in `_open_position` + warning UI se `leverage > 5` e `sl_atr_mult > 2.5` |
| Posizioni paper aperte prima del feature (senza `liq_px`) | Alta | Basso | Retrocompatibilità in `_restore_paper_state`: ricalcolo al volo con `config.leverage` |
| Backtest ottimistico con leva alta se liquidazione non è implementata prima di SL/TP | Alta (se non fatto) | Alto | Implementare check liq **prima** di SL nel loop (§4.9) |
| Margine richiesto > equity (configurazione estrema) | Bassa | Alto | Cap in risk.py: `margin ≤ equity × 0.95` con log warning (§4.2b) |
| Confusione tra rischio in USD e margine nell'UI | Media | Basso | Label distinte: "Rischio per trade: $X" e "Margine: $Y" (non la stessa cosa) |

---

## 8. Decisioni di design

### La leva moltiplica il notional — comportamento atteso

Con `leverage=5`, equity $10.000, `position_size_pct=1.5%`, SL al 2%:

```
risk_usd       = $10.000 × 1.5% × 5 = $750    ← si rischia $750 se SL scatta
size_usd       = $750 / 2%           = $37.500  ← notional controllato
margin_usd     = $37.500 / 5        = $7.500   ← depositato su HL (75% equity)
liq_px (long)  = entry × (1 − 0.2 + 0.005)     ← ~19.5% sotto entry
```

Il `position_size_pct` rimane il parametro di controllo del rischio: definisce
**quanta percentuale di equity si mette a rischio per trade, moltiplicata per la
leva**. Con leva 1× e pos_size 1.5% si rischia $150/trade. Con leva 5× si rischia
$750/trade — cinque volte di più, con posizioni cinque volte più grandi.

**Invariante chiave:** il margine depositato (`size_usd / leverage`) è identico a
`size_usd` con leva 1×. La leva amplifica il notional controllato, non il collaterale
usato. Questo è il comportamento standard e atteso dalla leva sui derivati.

### Safety cap sul margine

Il cap `margin ≤ equity × 0.95` (§4.2b) garantisce che configurazioni estreme
(leva 50× con SL strettissimo) non tentino di aprire posizioni che richiedono
più margine del saldo disponibile. Se il cap scatta viene loggato un WARNING
con i valori originali e ridotti.

### Perché leverage = 1 è il default

Con leva 1× non esiste un prezzo di liquidazione raggiungibile. Il bot si
comporta esattamente come prima. È il default sicuro per chi non ha bisogno
di leva e garantisce la retrocompatibilità totale.

### Leva cross vs isolated

Il sistema usa **isolated margin** (non cross). Su HL isolated:
- Solo il margine della singola posizione è a rischio, non l'intero wallet
- Il prezzo di liquidazione è calcolabile in modo deterministico (formula §2)
- È il tipo di margin standard per sistemi automatici

---

## 9. Impatto su metriche e Monitor UI

Il Monitor live mostra già `size_usd`, `entry_price`, `stop_loss`, `take_profit`.
Dopo l'implementazione, aggiungere alla risposta di `get_status()` / `get_monitor_data()`:

```python
"leverage":   self._position.get("leverage", 1),
"liq_px":     self._position.get("liq_px", 0.0),
"margin_usd": self._position.get("margin_usd", 0.0),
```

Il Monitor.tsx può mostrare una row aggiuntiva:
```
Leva:    10×  |  Margine: $750  |  Liq: $90.500
```
con la liq_px evidenziata in rosso se il mark price si avvicina entro il 10%.

---

## 10. Sommario dei parametri aggiunti

| Parametro | Tipo | Default | Range | Dove |
|-----------|------|---------|-------|------|
| `leverage` | `int` | `1` | 1–50 | BotConfig (backend + frontend) |
| `liq_px` | `float` | calcolato | — | `_position` dict (runtime) |
| `margin_usd` | `float` | calcolato | — | `_position` dict (runtime) |
| `HL_MM_RATE` | `float` | `0.005` | costante | execution.py module level |
| `HL_MAX_LEV` | `int` | `50` | costante | execution.py module level |
