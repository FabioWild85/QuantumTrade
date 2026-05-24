# Piano di Implementazione — Pullback Entry 1H + CVD Absorption Score

**Data:** 2026-05-24  
**Priorità:** Alta  
**Autore:** Claude (audit architetturale + piano)

---

## Indice

1. [Contesto e motivazione](#1-contesto-e-motivazione)
2. [Bug pre-esistente da correggere prima](#2-bug-pre-esistente-da-correggere-prima)
3. [Feature A — CVD Absorption Score](#3-feature-a--cvd-absorption-score)
4. [Feature B — Pullback Entry 1H](#4-feature-b--pullback-entry-1h)
5. [Modifiche UI — BotConfig.tsx](#5-modifiche-ui--botconfigtsx)
6. [Ordine di implementazione](#6-ordine-di-implementazione)
7. [Checklist di verifica finale](#7-checklist-di-verifica-finale)

---

## 1. Contesto e motivazione

### CVD Absorption Score
Quando il volume è alto ma il prezzo non si muove nella direzione del delta (compri grandi, prezzo fermo o in calo), significa che qualcuno sta assorbendo gli ordini — comportamento istituzionale tipico nelle zone di accumulo/distribuzione. Questo segnale NON è ancora nel sistema.

Abbiamo già `cvd_delta`, `vol_imbalance`, `delta_price_div` — ma nessuno misura direttamente il rapporto volume/movimento. L'absorption score riempie questa lacuna con una formula semplice.

### Pullback Entry 1H
Il trade SHORT del 2026-05-23 ha illustrato il problema: il bot entra alla chiusura della 4H qualunque sia il timing nel ciclo. I player istituzionali aspettano che il prezzo ritorni all'OB/FVG e **shortano la rejection**, non l'impulso iniziale.

Con il Pullback Entry:
- Il segnale 4H diventa un "alert pending"
- Il bot monitora le candele 1H successive
- Entra solo quando il prezzo raggiunge l'OB/FVG e mostra una rejection candle
- Risultato: entry migliore, SL naturalmente più stretto, R:R superiore

---

## 2. Bug pre-esistente da correggere prima

**File:** `apps/api/services/risk.py` → funzione `apply_structural_sl()`  
**File:** `apps/api/services/smc.py` → `build_order_block_features()`

### Il problema

`ob_bear_dist` e `ob_bull_dist` sono **ATR-normalized**, non percentuali:

```python
# smc.py riga ~168-169
d["ob_bear_dist"] = ((bear_ob_top + bear_ob_bot) / 2 - d["close"]) / atr_safe
d["ob_bull_dist"] = (d["close"] - (bull_ob_top + bull_ob_bot) / 2) / atr_safe
```

Il valore `1.45` nel trade fallito significa "1.45 ATR sopra il prezzo", NON "1.45%".

In `apply_structural_sl()` viene usato come percentuale (`price * (1 + ob_dist / 100)`) — errore di unità.

### Correzione da applicare prima di tutto il resto

**Modifica 1 — `smc.py`:** Esporta i livelli di prezzo assoluti dell'OB (necessari anche per il Pullback Entry):

```python
# Aggiungere a build_order_block_features(), DOPO le righe esistenti:
d["ob_bear_top_px"] = bear_ob_top   # prezzo assoluto top del bear OB
d["ob_bear_bot_px"] = bear_ob_bot   # prezzo assoluto bot del bear OB
d["ob_bull_top_px"] = bull_ob_top   # prezzo assoluto top del bull OB
d["ob_bull_bot_px"] = bull_ob_bot   # prezzo assoluto bot del bull OB
```

Aggiungere queste 4 features al dict `ALL_FEATURE_GROUPS["ob"]` e a `ALL_FEATURES`.

**Modifica 2 — `risk.py`:** Correggere `apply_structural_sl()` per usare i livelli di prezzo assoluti invece della conversione ATR→%:

```python
def apply_structural_sl(
    params: TradeParams,
    features: dict,
    entry_price: float,
    ob_proximity_atr: float = 2.0,   # rinominato: "entro 2 ATR"
    ob_buffer_pct: float = 0.3,
) -> tuple[bool, str]:

    is_short  = params.side == "short"
    orig_sl   = params.stop_loss
    atr       = float(features.get("atr_14") or 0)
    if atr <= 0:
        return False, ""

    if is_short:
        ob_active  = float(features.get("ob_bear_active") or 0)
        ob_dist    = features.get("ob_bear_dist")          # in ATR units
        ob_inside  = float(features.get("ob_bear_inside") or 0)
        ob_top_px  = features.get("ob_bear_top_px")        # prezzo assoluto (nuovo)

        if (
            ob_active == 1.0
            and ob_dist is not None
            and ob_inside == 0.0
            and 0 < float(ob_dist) < ob_proximity_atr
            and ob_top_px is not None
        ):
            ob_sl = float(ob_top_px) * (1.0 + ob_buffer_pct / 100.0)
            if ob_sl > params.stop_loss:
                params.stop_loss = ob_sl
                msg = (
                    f"StructuralSL: bear OB top={float(ob_top_px):.2f} → "
                    f"SL={ob_sl:.2f} (was {orig_sl:.2f})"
                )
                _rescale_size(params, orig_sl, entry_price)
                return True, msg
    else:
        ob_active  = float(features.get("ob_bull_active") or 0)
        ob_dist    = features.get("ob_bull_dist")
        ob_inside  = float(features.get("ob_bull_inside") or 0)
        ob_bot_px  = features.get("ob_bull_bot_px")

        if (
            ob_active == 1.0
            and ob_dist is not None
            and ob_inside == 0.0
            and 0 < float(ob_dist) < ob_proximity_atr
            and ob_bot_px is not None
        ):
            ob_sl = float(ob_bot_px) * (1.0 - ob_buffer_pct / 100.0)
            if ob_sl < params.stop_loss:
                params.stop_loss = ob_sl
                msg = (
                    f"StructuralSL: bull OB bot={float(ob_bot_px):.2f} → "
                    f"SL={ob_sl:.2f} (was {orig_sl:.2f})"
                )
                _rescale_size(params, orig_sl, entry_price)
                return True, msg

    return False, ""
```

**Nota:** `ob_top_px` / `ob_bot_px` saranno `NaN` (float) quando non c'è OB attivo. Il check `ob_top_px is not None` non cattura NaN — usare `pd.notna(ob_top_px)` oppure `float(ob_top_px) > 0`. Il codice dovrà gestire questo caso.

---

## 3. Feature A — CVD Absorption Score

### Descrizione tecnica

L'absorption score misura quanto volume è stato scambiato per unità di movimento di prezzo. Valori alti = tanto volume, poco movimento = assorbimento istituzionale.

**Formula:**
```
absorption_score = volume_bar / max(|close - open|, atr * 0.01)
```
Normalizzata rispetto all'ATR su una rolling window per renderla comparabile nel tempo:
```
absorption_z = (absorption_score - rolling_mean_24) / rolling_std_24
```

Valori `absorption_z > 2.0` indicano assorbimento anomalo rispetto alla norma recente.

### Modifiche necessarie

#### `apps/api/services/smc.py`

**Posizione:** dentro `build_cvd_features()`, dopo le righe esistenti.

```python
def build_cvd_features(df: pd.DataFrame) -> pd.DataFrame:
    # ... codice esistente ...

    # ── Absorption Score ───────────────────────────────────────────────────
    # Misura volume per unità di movimento. Alto = assorbimento istituzionale.
    body_size = (d["close"] - d["open"]).abs()
    atr_floor = d["atr_14"] * 0.01                         # floor: evita /0 su doji
    raw_absorption = d["volume"] / (body_size + atr_floor)  # contracts / punto
    # Z-score rolling 24 bar (~4 giorni su 4H) per normalizzazione temporale
    roll_mean = raw_absorption.rolling(24, min_periods=6).mean()
    roll_std  = raw_absorption.rolling(24, min_periods=6).std().replace(0, np.nan)
    d["absorption_z"] = (raw_absorption - roll_mean) / roll_std

    return d
```

**In `ALL_FEATURE_GROUPS` (già presente in smc.py):** aggiungere `"absorption_z"` al gruppo `"cvd"`:

```python
"cvd": [
    "delta_raw", "delta_ma8", "delta_ma24", "cvd_slope",
    "vol_imbalance", "delta_price_div",
    "absorption_z",   # ← nuovo
],
```

**In `ALL_FEATURES`:** aggiungere `"absorption_z"` alla lista flat.

#### `apps/api/main.py` — BotConfig Pydantic

```python
# Aggiungere nel blocco dei toggle segnali (dopo sweep_gate_enabled):
absorption_filter_enabled: bool  = Field(False)
absorption_z_threshold:    float = Field(2.0, ge=0.5, le=5.0)
```

**Semantica del toggle:**
- `absorption_filter_enabled = True`: se `absorption_z > absorption_z_threshold` nell'ultima barra, forza la modalità "aspetta pullback" anziché entrare subito. Funziona da precondizione al Pullback Entry, ma può anche operare in standalone modificando leggermente il threshold richiesto (+0.03) come segnale di attenzione.
- Standalone (senza Pullback Entry): l'absorption alto in direzione contraria al segnale aggiunge +0.03 al threshold richiesto.

#### `apps/api/services/decision.py`

Aggiungere estrazione e logica nel metodo `decide()`, dopo l'Exhaustion Guard:

```python
absorption_z = features.get("absorption_z", 0.0) or 0.0

# ── Absorption Filter ─────────────────────────────────────────────────────
# Alto assorbimento nella direzione contraria al segnale = istituzionali
# stanno assorbendo l'impulso. Richiede maggiore conviction per entrare.
if self.absorption_filter_enabled and absorption_z > self.absorption_z_threshold:
    # Assorbimento anomalo: +0.03 a entrambi i threshold (segnale di cautela)
    threshold_long  += 0.03
    threshold_short += 0.03
    reasoning.append(
        f"AbsorptionFilter: absorption_z={absorption_z:.2f} > "
        f"{self.absorption_z_threshold:.2f} — threshold +0.03 (high volume, low move)"
    )
```

**Nuovi parametri nel `__init__` di `DecisionEngine`:**

```python
absorption_filter_enabled: bool  = False,
absorption_z_threshold:    float = 2.0,
```

#### Backtest — automatico

`build_all_features()` è condiviso tra live e backtest. Una volta aggiunto `absorption_z` in `build_cvd_features()`, il backtest lo riceve automaticamente su ogni barra storica. Nessuna modifica a `backtesting.py`.

**Nota importante:** il retraining del modello LightGBM è necessario dopo l'aggiunta della feature (il modello corrente non include `absorption_z` nei 49 feature che conosce). Il modello ignorerà la feature finché non viene ritrained. La `DecisionEngine` usa `absorption_z` solo per il threshold boost, indipendentemente dall'LGBM.

---

## 4. Feature B — Pullback Entry 1H

### Architettura generale

Il sistema attuale è un loop **event-driven 4H**: ad ogni chiusura 4H, decide se aprire/chiudere. Con il Pullback Entry, la chiusura 4H genera un "pending signal" (alert) invece di un'apertura immediata. Un secondo loop separato monitora le candele **1H** e apre la posizione quando le condizioni di pullback sono soddisfatte.

```
4H close → DecisionEngine → "long"/"short"
                          ↓ (pullback_entry_enabled=True)
                    PendingSignal state
                          ↓
              Monitor 1H (polling ogni chiusura 1H)
                          ↓
              Pullback raggiunto + Rejection candle?
                          ↓
                    _open_position()   ← stesso identico codice
```

### Stato macchina (State Machine)

```
IDLE
  ↓ 4H signal + pullback_entry_enabled
PENDING (signal, direction, OB/FVG target, expiry_bar)
  ↓ 1H candle close: target raggiunto + rejection
OPEN_POSITION → normale gestione trade
  ↓ 1H candle: expiry_bar raggiunto senza trigger
IDLE (signal scaduto, skip)
```

### Definizione "pullback raggiunto + rejection"

**Per SHORT:**
1. Il prezzo 1H sale verso il target (OB bear top oppure FVG bear bottom)
2. Una candela 1H chiude con: `(high_1h - close_1h) / (high_1h - low_1h) >= 0.60`
   → Il prezzo ha visitato la zona alta ma la candela chiude nel terzo inferiore del range
   → "Rejection" nella zona OB/FVG = istituzionali che shortano la distribuzione

**Per LONG:**
1. Il prezzo 1H scende verso il target (OB bull bot oppure FVG bull top)
2. Una candela 1H chiude con: `(close_1h - low_1h) / (high_1h - low_1h) >= 0.60`
   → Candela con wick inferiore lungo, close nel terzo superiore = demand absorption

### Parametri configurabili

| Parametro | Tipo | Default | Descrizione |
|-----------|------|---------|-------------|
| `pullback_entry_enabled` | bool | False | Abilita la modalità pullback |
| `pullback_target` | str | "ob" | Target zone: `"ob"`, `"fvg"`, `"ob_or_fvg"` |
| `pullback_max_bars_1h` | int | 12 | Barre 1H di attesa massima (12 = 12h) |
| `pullback_rejection_pct` | float | 0.60 | Fraction del range 1H per confermare rejection |
| `pullback_proximity_pct` | float | 0.30 | % dal target entro cui considerare "raggiunto" |

### Modifiche necessarie — Live (`execution.py`)

#### Step 1: Nuovi attributi di stato in `__init__`

```python
self._pending_signal: Optional[dict] = None
# Struttura:
# {
#   "action":           "long" | "short",
#   "result":           DecisionResult,    # snapshot completo per _open_position
#   "snap":             dict,              # snapshot mercato al momento del 4H signal
#   "atr":              float,
#   "inference_id":     str,
#   "target_high":      float,             # prezzo top della zona target
#   "target_low":       float,             # prezzo bot della zona target
#   "target_type":      "ob" | "fvg",
#   "expiry_time":      datetime,          # UTC, dopo cui il pending viene scartato
#   "created_at":       datetime,
# }
```

#### Step 2: Nuovo metodo `_resolve_pullback_target()`

```python
def _resolve_pullback_target(
    self,
    action: str,
    features: dict,
    price: float,
) -> Optional[tuple[float, float, str]]:
    """
    Determina la zona di pullback (high, low, type) in base alla configurazione.
    Restituisce None se nessun target valido è disponibile.
    """
    cfg = self.config

    if action == "short":
        if cfg.pullback_target in ("ob", "ob_or_fvg"):
            ob_active = float(features.get("ob_bear_active") or 0)
            ob_top    = features.get("ob_bear_top_px")
            ob_bot    = features.get("ob_bear_bot_px")
            if ob_active == 1.0 and ob_top and ob_bot and float(ob_top) > price:
                return float(ob_top), float(ob_bot), "ob"
        if cfg.pullback_target in ("fvg", "ob_or_fvg"):
            # FVG: necessita esposizione dei livelli di prezzo (vedi smc.py modifiche)
            fvg_top = features.get("fvg_bear_top_px")
            fvg_bot = features.get("fvg_bear_bot_px")
            if fvg_top and fvg_bot and float(fvg_top) > price:
                return float(fvg_top), float(fvg_bot), "fvg"
    else:  # long
        if cfg.pullback_target in ("ob", "ob_or_fvg"):
            ob_active = float(features.get("ob_bull_active") or 0)
            ob_top    = features.get("ob_bull_top_px")
            ob_bot    = features.get("ob_bull_bot_px")
            if ob_active == 1.0 and ob_bot and ob_top and float(ob_bot) < price:
                return float(ob_top), float(ob_bot), "ob"
        if cfg.pullback_target in ("fvg", "ob_or_fvg"):
            fvg_top = features.get("fvg_bull_top_px")
            fvg_bot = features.get("fvg_bull_bot_px")
            if fvg_bot and fvg_top and float(fvg_bot) < price:
                return float(fvg_top), float(fvg_bot), "fvg"

    return None
```

#### Step 3: Modifica a `_cycle()` — generazione pending invece di apertura diretta

**Posizione:** immediatamente prima di `await self._open_position(result, snap, atr, inference_id)` (riga ~885):

```python
if result.action != "no_trade" and allowed and self._position is None:
    if cfg.pullback_entry_enabled and self._pending_signal is None:
        target = self._resolve_pullback_target(
            result.action, result.features_snapshot, snap["mark_price"]
        )
        if target is not None:
            target_high, target_low, target_type = target
            expiry = datetime.now(timezone.utc) + timedelta(
                hours=cfg.pullback_max_bars_1h
            )
            self._pending_signal = {
                "action":       result.action,
                "result":       result,
                "snap":         snap,
                "atr":          atr,
                "inference_id": inference_id,
                "target_high":  target_high,
                "target_low":   target_low,
                "target_type":  target_type,
                "expiry_time":  expiry,
                "created_at":   datetime.now(timezone.utc),
            }
            log.info(
                "PullbackEntry [%s]: pending signal → target=%s [%.2f–%.2f] expiry=%s",
                result.action.upper(), target_type,
                target_low, target_high,
                expiry.strftime("%Y-%m-%dT%H:%M"),
            )
            result.reasoning.append(
                f"PullbackEntry: signal pending → target {target_type} "
                f"[{target_low:.2f}–{target_high:.2f}] expiry {expiry.strftime('%H:%Mz')}"
            )
            # Logga l'inference normalmente (per storico), ma non apre
        else:
            # Nessun target OB/FVG disponibile → fallback immediato
            log.info("PullbackEntry: no target zone found — opening immediately (fallback)")
            await self._open_position(result, snap, atr, inference_id)
    else:
        await self._open_position(result, snap, atr, inference_id)
```

#### Step 4: Nuovo loop `_pullback_monitor()`

Task asyncio separato, lanciato da `start()` in parallelo con `_loop()`:

```python
async def _pullback_monitor(self):
    """
    Monitors 1H candle closes for pending signal pullback + rejection.
    Runs only when pullback_entry_enabled=True.
    """
    POLL_INTERVAL_S = 60  # controlla ogni 60s, non blocca

    while self.running:
        await asyncio.sleep(POLL_INTERVAL_S)

        if not self._pending_signal or self._position is not None:
            # Nessun pending o posizione già aperta → skip
            continue

        pending = self._pending_signal
        now = datetime.now(timezone.utc)

        # Scadenza: signal troppo vecchio
        if now > pending["expiry_time"]:
            log.info(
                "PullbackEntry: signal [%s] scaduto dopo %s — discarded",
                pending["action"].upper(),
                str(now - pending["created_at"]).split(".")[0],
            )
            self._pending_signal = None
            continue

        # Fetch ultima candela 1H chiusa
        try:
            df_1h = await self._hl.get_ohlcv(SYMBOL, "1h", limit=3)
        except Exception as exc:
            log.warning("PullbackEntry monitor: 1H fetch failed: %s", exc)
            continue

        last_1h = df_1h.iloc[-1]
        h, l, c = float(last_1h["high"]), float(last_1h["low"]), float(last_1h["close"])
        bar_range = max(h - l, 1e-6)

        action     = pending["action"]
        tgt_high   = pending["target_high"]
        tgt_low    = pending["target_low"]
        proximity  = (tgt_high - tgt_low) * self.config.pullback_proximity_pct
        rej_pct    = self.config.pullback_rejection_pct

        triggered = False

        if action == "short":
            # Prezzo ha raggiunto la zona target (alta della 1H ≥ tgt_low - proximity)
            price_in_zone = h >= (tgt_low - proximity)
            # Rejection: close nel terzo inferiore del range
            rejection = (h - c) / bar_range >= rej_pct
            triggered = price_in_zone and rejection

        else:  # long
            price_in_zone = l <= (tgt_high + proximity)
            rejection = (c - l) / bar_range >= rej_pct
            triggered = price_in_zone and rejection

        if triggered:
            log.info(
                "PullbackEntry [%s]: rejection confirmed @ 1H [H=%.2f L=%.2f C=%.2f] "
                "zone=[%.2f–%.2f] — opening position",
                action.upper(), h, l, c, tgt_low, tgt_high,
            )
            # Aggiorna snap con il prezzo attuale (non quello del segnale 4H)
            try:
                live_snap = await self._hl.get_market_snapshot(SYMBOL)
            except Exception:
                live_snap = pending["snap"]

            pending["result"].reasoning.append(
                f"PullbackEntry: rejection @ 1H [H={h:.2f} C={c:.2f}] → entry"
            )
            await self._open_position(
                pending["result"],
                live_snap,
                pending["atr"],
                pending["inference_id"],
            )
            self._pending_signal = None
```

#### Step 5: Persistenza del pending signal

Il pending signal deve sopravvivere a un riavvio del bot (paper mode). Aggiungere alla `_save_paper_position()`:

```python
# In _save_paper_position (o funzione equivalente di salvataggio stato):
state_to_save = {
    "_paper_position": self._position,
    "_pending_signal_serialized": _serialize_pending(self._pending_signal),
}
```

Il `DecisionResult` non è JSON-serializable direttamente → serializzare solo i campi necessari: `action`, `target_high`, `target_low`, `target_type`, `expiry_time`, `atr`, `inference_id`. Ricostruire un `DecisionResult` minimo al restore.

#### Step 6: Esposizione FVG price levels in `smc.py`

Attualmente `fvg_bear` e `fvg_bull` sono booleani (0/1). Per il pullback entry servono i livelli di prezzo. Modificare `detect_fvg()`:

```python
def detect_fvg(df: pd.DataFrame, min_gap_pct: float = 0.001) -> pd.DataFrame:
    d = df.copy()
    # Gap rialzista: low[i] > high[i-2] (gap sopra la candela precedente)
    raw_bull = (d["low"] > d["high"].shift(2)) & (
        (d["low"] - d["high"].shift(2)) / d["close"] > min_gap_pct
    )
    # Gap ribassista: high[i] < low[i-2]
    raw_bear = (d["high"] < d["low"].shift(2)) & (
        (d["low"].shift(2) - d["high"]) / d["close"] > min_gap_pct
    )

    d["fvg_bull"]         = raw_bull.shift(1).fillna(0.0)
    d["fvg_bear"]         = raw_bear.shift(1).fillna(0.0)

    # Livelli di prezzo assoluti del FVG (NaN se non attivo)
    # Bull FVG: zona tra high[i-2] e low[i] della candela che ha creato il gap
    bull_top = d["low"].where(raw_bull).shift(1)   # low della candela FVG
    bull_bot = d["high"].shift(2).where(raw_bull).shift(1)  # high 2 barre prima
    bear_top = d["low"].shift(2).where(raw_bear).shift(1)   # low 2 barre prima
    bear_bot = d["high"].where(raw_bear).shift(1)  # high della candela FVG

    d["fvg_bull_top_px"] = bull_top.ffill()  # mantieni livello finché valido
    d["fvg_bull_bot_px"] = bull_bot.ffill()
    d["fvg_bear_top_px"] = bear_top.ffill()
    d["fvg_bear_bot_px"] = bear_bot.ffill()

    return d
```

**Nota:** la logica di `ffill()` andrà calibrata per resettare i livelli quando il FVG viene "riempito" (il prezzo lo attraversa). In prima implementazione, usare `ffill()` semplice e documentare il limite.

### Modifiche necessarie — Backtest (`backtesting.py`)

Il backtest itera su barre 4H. La simulazione perfetta del pullback entry richiederebbe dati 1H bar-by-bar per ogni segnale 4H — complessità molto alta per v1.

**Approccio v1: Intrabar Approximation**

Usa i dati OHLC della **stessa barra 4H** per inferire se il pullback sarebbe avvenuto all'interno della barra:

```python
if pullback_entry_enabled and result.action != "no_trade":
    target = _resolve_pullback_target_bt(result.action, features, close_price)
    if target is not None:
        target_high, target_low, _ = target
        h4, l4 = float(row["high"]), float(row["low"])
        # La barra 4H ha visitato la zona target?
        if result.action == "short":
            bar_visited_zone  = h4 >= target_low
            # Rejection approssimata: il prezzo ha visitato la zona ma chiude sotto
            rejection_approx = close_price < target_low
            triggered = bar_visited_zone and rejection_approx
        else:
            bar_visited_zone  = l4 <= target_high
            rejection_approx = close_price > target_high
            triggered = bar_visited_zone and rejection_approx

        if not triggered:
            # Aspetta la barra successiva (simuliamo max 1 barra di attesa in backtest v1)
            # Nella barra successiva: controlla se il target viene raggiunto
            # Implementazione: salva pending, processa nella prossima iterazione
            pending_bt = {
                "action": result.action, "result": result,
                "target_high": target_high, "target_low": target_low,
                "expiry_bar": i + pullback_max_bars_1h // 4,  # 4 bar 1H = 1 bar 4H
            }
            continue  # non aprire questa barra

# In cima al loop bar: check pending_bt
if pending_bt and i <= pending_bt["expiry_bar"]:
    # ... stessa logica di check con OHLC corrente
```

**Approccio v2 (roadmap futura):** caricare dati 1H reali durante il backtest e iterare barra per barra. Richiede refactoring significativo di `backtesting.py`.

### Edge cases da gestire

| Scenario | Comportamento atteso |
|----------|---------------------|
| 4H genera segnale mentre c'è già un `_pending_signal` | Ignora il nuovo segnale (already pending) |
| Posizione aperta mentre pending è attivo | Svuota `_pending_signal` — già gestito dal check iniziale |
| OB invalidato mentre pending attivo | Il monitor continua fino a scadenza — il prezzo non raggiungerà la zona invalida |
| Bot riavviato con pending attivo | Restore da Supabase state, expiry verificata subito |
| Nessun OB/FVG disponibile con pullback abilitato | Fallback all'entrata immediata + log warning |
| `pullback_entry_enabled` = False | Il pending non viene mai creato, comportamento identico all'attuale |

---

## 5. Modifiche UI — BotConfig.tsx

### Nuova sezione: "Pullback Entry 1H"

Da inserire nella sezione LightGBM Gate (logicamente correlata al comportamento entry):

```tsx
{/* ── Pullback Entry 1H ──────────────────────────────────────────────── */}
<div className="elegant-card p-6 bg-white dark:bg-[#151E32]">
  {/* Toggle master */}
  <div className="flex items-center justify-between mb-4">
    <div>
      <h3>Pullback Entry 1H</h3>
      <p>Entry solo su rejection della candela 1H nella zona OB/FVG — non all'impulso 4H</p>
    </div>
    <Toggle
      checked={config.pullback_entry_enabled}
      onChange={...}
    />
  </div>

  {config.pullback_entry_enabled && (
    <>
      {/* Target zone selector: ob / fvg / ob_or_fvg */}
      {/* pullback_max_bars_1h slider: 4–24 */}
      {/* pullback_rejection_pct slider: 0.40–0.80 */}
      {/* pullback_proximity_pct slider: 0.10–0.50 */}
    </>
  )}
</div>
```

### Nuova sezione: "CVD Absorption Filter"

Da inserire nella sezione "Filtri Segnale Attivi" (logicamente correlata agli altri gate):

```tsx
{/* Card absorption filter */}
<div>
  <Toggle checked={config.absorption_filter_enabled} onChange={...} />
  <div>
    <p>Absorption Filter</p>
    <p>Richiede maggiore conviction quando il volume è anomalo senza movimento di prezzo</p>
  </div>
</div>

{config.absorption_filter_enabled && (
  <SliderRow
    label="Soglia Absorption Z-Score"
    value={config.absorption_z_threshold}
    min={0.5} max={5.0} step={0.1}
    hint="Boost +0.03 al threshold quando absorption_z supera questo valore"
  />
)}
```

### Nuovi campi da aggiungere a `Config` interface e `DEFAULTS` in BotConfig.tsx

```typescript
// Config interface
pullback_entry_enabled:    boolean;
pullback_target:           string;      // "ob" | "fvg" | "ob_or_fvg"
pullback_max_bars_1h:      number;
pullback_rejection_pct:    number;
pullback_proximity_pct:    number;
absorption_filter_enabled: boolean;
absorption_z_threshold:    number;

// DEFAULTS
pullback_entry_enabled:    false,
pullback_target:           "ob",
pullback_max_bars_1h:      12,
pullback_rejection_pct:    0.60,
pullback_proximity_pct:    0.30,
absorption_filter_enabled: false,
absorption_z_threshold:    2.0,
```

### Aggiornare il box "Hardcoded Engine Rules"

Aggiungere nota che l'ExhaustionGuard si integra con il Pullback Entry: se l'ExhaustionGuard blocca il segnale 4H, il pending non viene mai generato (corretto — la protezione è a monte).

---

## 6. Ordine di implementazione

### Fase 0 — Prerequisiti (fare subito, prima di tutto)

1. **Correggi bug `ob_bear_dist` unità** in `smc.py` e `risk.py`
2. **Aggiungi `ob_bear_top_px`, `ob_bear_bot_px`, `ob_bull_top_px`, `ob_bull_bot_px`** in `smc.py`
3. **Aggiungi `fvg_bear_top_px`, `fvg_bear_bot_px`, `fvg_bull_top_px`, `fvg_bull_bot_px`** in `smc.py`
4. Deploy e test: verificare che i nuovi campi appaiono nell'inference_log

### Fase 1 — CVD Absorption Score (1-2 ore)

1. Aggiungere `absorption_z` in `smc.py` → `build_cvd_features()`
2. Aggiungere `absorption_filter_enabled`, `absorption_z_threshold` in `main.py` BotConfig
3. Aggiungere logica in `decision.py` DecisionEngine
4. Aggiungere campi in `BotConfig.tsx` (Config interface + DEFAULTS + UI)
5. Deploy e test: verificare che `absorption_z` compare nell'inference_log features
6. **Retraining LGBM** dopo deploy per includere la nuova feature nel modello

### Fase 2 — Pullback Entry 1H (4-8 ore)

1. Aggiungere parametri in `main.py` BotConfig
2. Aggiungere `_pending_signal` e `_resolve_pullback_target()` in `execution.py`
3. Modificare `_cycle()` per generare pending invece di open diretta
4. Implementare `_pullback_monitor()` come task asyncio parallelo
5. Aggiungere persistenza pending in paper/live state
6. Implementare simulazione approssimata in `backtesting.py` (v1)
7. Aggiungere UI in `BotConfig.tsx`
8. Test in paper mode: verificare che il pending viene creato, monitorato e triggerato
9. Verifica backtest con `pullback_entry_enabled=True` vs `False`

---

## 7. Checklist di verifica finale

### CVD Absorption Score

- [ ] `absorption_z` presente nei features dell'inference_log dopo deploy
- [ ] Con `absorption_filter_enabled=False`: comportamento identico all'attuale
- [ ] Con `absorption_filter_enabled=True` e `absorption_z=3.0` su una barra ad alto volume+basso movimento: reasoning mostra "AbsorptionFilter" con boost +0.03
- [ ] Feature presente nelle barre del backtest (stesso valore live vs backtest per stessa candela storica)
- [ ] Toggle UI salva e carica correttamente

### Pullback Entry 1H

- [ ] Con `pullback_entry_enabled=False`: nessuna modifica al comportamento, zero pending creati
- [ ] Con `pullback_entry_enabled=True` e OB disponibile: 4H signal → log "pending signal" → nessuna apertura immediata
- [ ] 1H rejection nella zona → posizione aperta, reasoning mostra "PullbackEntry: rejection confirmed"
- [ ] Scadenza expiry: dopo `pullback_max_bars_1h` ore senza trigger, pending scartato e log "signal scaduto"
- [ ] Fallback a open immediata se nessun OB/FVG disponibile
- [ ] Riavvio bot con pending attivo: stato ripristinato correttamente da Supabase
- [ ] Backtest con pullback abilitato: meno trade totali, entry price diversa dal 4H close
- [ ] UI toggle salva e carica, parametri slider funzionanti

---

## Note finali

**Sul pullback entry e il backtest v1:** la simulazione intrabar è un'approssimazione. I backtest con `pullback_entry_enabled=True` produrranno risultati meno precisi rispetto alla versione live. Usare i backtest v1 solo per capire l'ordine di grandezza dell'impatto, non per calibrazione fine. La v2 (dati 1H reali in backtest) è il target per la validazione definitiva.

**Sul retraining:** dopo l'aggiunta di `absorption_z`, il modello LGBM attuale non include questa feature. Il bot continuerà a funzionare (la feature viene usata solo nel DecisionEngine per il threshold boost, non viene inviata al modello LGBM corrente). Il retraining aggiornerà il modello per includere `absorption_z` come feature predittiva.
