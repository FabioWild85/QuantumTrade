# Piano di Implementazione — Upgrade Strategico
**Data:** 26 Maggio 2025
**Versione:** 1.0
**Stato:** Draft — da approvare prima dell'implementazione

---

## Indice

1. [Fear & Greed + BTC Dominance nel DecisionEngine](#feature-1)
2. [Funding Rate Gate/Bias](#feature-2)
3. [Order Book L2 Imbalance](#feature-3)
4. [Slippage Tracking Sistematico](#feature-4)
5. [Appendice A — Mapping completo file → modifiche](#appendice-a)
6. [Appendice B — Nuovi campi BotConfig (tabella completa)](#appendice-b)
7. [Appendice C — Ordine di implementazione consigliato](#appendice-c)

---

## Premessa architetturale

Ogni feature segue il pattern già consolidato nel codebase:

1. **Campi di configurazione** aggiunti sia a `BotConfig` in `execution.py` (plain class) che a `BotConfig` in `main.py` (Pydantic model) con gli stessi default.
2. **Estrazione in `backtesting.py`** via `getattr(cfg, "field", default)` nella sezione config del `run_backtest`.
3. **Toggle attivo in `DecisionEngine`**: parametri statici (soglie, flag) passati a `__init__`; valori dinamici per-ciclo passati a `decide()`.
4. **Audit trail**: ogni gate che modifica la decisione aggiunge una stringa a `reasoning` per garantire piena tracciabilità nel log.

---

<a name="feature-1"></a>
## Feature 1 — Fear & Greed + BTC Dominance nel DecisionEngine

### 1.1 Situazione attuale

In `_cycle()` (execution.py, step 6, linee ~747-748):
```python
await update_covariates()
covars = get_latest_covariates()
```
`covars` contiene `{"fear_greed": float(0-100), "btc_dominance": float(0.0-1.0)}`.
Viene passato **solo** a `_log_inference()` per il log su Supabase. Non raggiunge mai il `DecisionEngine`.

### 1.2 Obiettivo

Usare `fear_greed` e `btc_dominance` come **bias asimmetrico sulle soglie** nel `DecisionEngine`. Non come gate binario (on/off), ma come aggiustamento continuo che rende certi trade più o meno facili da aprire in funzione del sentiment corrente.

### 1.3 Logica di decisione

#### Fear & Greed (range 0-100)

| Zona F&G | Valore | Comportamento |
|----------|--------|---------------|
| Extreme Fear | < `fng_extreme_fear_thr` (def: 20) | `threshold_long -= fng_bias_delta` · `threshold_short += fng_bias_delta` |
| Fear | < `fng_fear_thr` (def: 35) | `threshold_long -= fng_bias_delta * 0.5` · `threshold_short += fng_bias_delta * 0.5` |
| Neutral | 35–65 | Nessun aggiustamento |
| Greed | > `fng_greed_thr` (def: 65) | `threshold_long += fng_bias_delta * 0.5` · `threshold_short -= fng_bias_delta * 0.5` |
| Extreme Greed | > `fng_extreme_greed_thr` (def: 80) | `threshold_long += fng_bias_delta` · `threshold_short -= fng_bias_delta` |

**Razionale:** Fear estremo = mercato oversold da panic selling → favorire contrariamente i long. Greed estremo = mercato overbought da euforia → favorire i short.

#### BTC Dominance (range 0.0–1.0, tipicamente 0.40–0.65)

| Condizione | Comportamento |
|------------|---------------|
| Dominance in rapida salita (Δ > `dom_rising_delta`, def: 0.008 in 24h) | `threshold_long += dom_bias_delta * 0.5` (BTC si apprezza ma in clima risk-off) |
| Dominance in rapida discesa (Δ < -`dom_rising_delta`) | Nessun aggiustamento (alt season ≠ segnale affidabile per BTC-PERP) |
| Variazione normale | Nessun aggiustamento |

**Nota:** L'effetto della dominance è intenzionalmente debole (solo 0.5×) e one-sided, perché la relazione dominance→prezzo BTC è meno robusta di quella F&G→sentiment. Si può disabilitare con `dom_gate_enabled = False` senza perdere nulla di rilevante.

**Posizionamento nel flusso di `decide()`:** Il blocco F&G/Dominance si inserisce **dopo** il calcolo di `effective_threshold` (MTF alignment) e **dopo** RegimeBias, **prima** di ExhaustionGuard. I threshold modificati diventano input degli stessi gate successivi.

### 1.4 Backtestabilità

**Fear & Greed: COMPLETAMENTE BACKTESTABILE.**
alternative.me fornisce l'intera storia F&G (2018–oggi) via endpoint pubblico:
```
GET https://api.alternative.me/fng/?limit=0&format=json&date_format=us
```
Risposta: array JSON con `{"value": "45", "value_classification": "Fear", "timestamp": "2024-01-15", ...}` per ogni giorno.

**BTC Dominance: LIVE/PAPER ONLY (inizialmente).**
CoinGecko storico su endpoint free richiede pagination complessa. Si può aggiungere in seguito. Per ora, in backtest il `dom_gate_enabled` è estratto ma **forzato a False** con un commento esplicito.

### 1.5 Nuovi campi di configurazione

| Campo | Tipo | Default | Range | Nota |
|-------|------|---------|-------|------|
| `fng_gate_enabled` | bool | False | — | Master toggle F&G |
| `fng_extreme_fear_thr` | float | 20.0 | 5–40 | Soglia Extreme Fear |
| `fng_fear_thr` | float | 35.0 | 20–50 | Soglia Fear (half-effect) |
| `fng_greed_thr` | float | 65.0 | 50–80 | Soglia Greed (half-effect) |
| `fng_extreme_greed_thr` | float | 80.0 | 60–95 | Soglia Extreme Greed |
| `fng_bias_delta` | float | 0.03 | 0.01–0.08 | Aggiustamento soglia in zone estreme |
| `dom_gate_enabled` | bool | False | — | Master toggle BTC Dominance |
| `dom_rising_delta` | float | 0.008 | 0.003–0.02 | Variazione dom 24h = "rapida salita" |
| `dom_bias_delta` | float | 0.02 | 0.01–0.05 | Aggiustamento soglia per dom |

### 1.6 Modifiche per file

#### `apps/api/services/covariates.py`
- **Nuova funzione** `async def fetch_historical_fng() -> dict[str, float]`:
  - Chiama `https://api.alternative.me/fng/?limit=0&format=json&date_format=us`
  - Parsa la risposta e restituisce `{"2024-01-15": 45.0, "2023-12-01": 72.0, ...}` (chiave = data ISO, valore = F&G)
  - Cache in-process: se già caricato nella stessa sessione, non ri-fetcha (una `dict` modulo-level `_fng_cache: dict = {}`)
  - In caso di errore, restituisce `{}` e loga warning (non deve mai bloccare il backtest)

#### `apps/api/services/decision.py`
- **`__init__`**: aggiungere 9 nuovi parametri (tutti i campi della tabella sopra)
- **`decide()`**: aggiungere parametri `covariates: Optional[dict] = None` e `dom_prev_value: float = 0.0`
  - Dopo il blocco RegimeBias, prima di ExhaustionGuard, inserire il blocco **FNG/Dominance Bias**:
    ```
    # ── Fear & Greed Bias ────────────────────────────────────────────────
    if self.fng_gate_enabled and covariates:
        fng = covariates.get("fear_greed", 50.0)
        if fng < self.fng_extreme_fear_thr:
            delta = self.fng_bias_delta
            threshold_long  -= delta
            threshold_short += delta
            reasoning.append(f"FNG: Extreme Fear {fng:.0f} → long −{delta:.2f}, short +{delta:.2f}")
        elif fng < self.fng_fear_thr:
            half = self.fng_bias_delta * 0.5
            threshold_long  -= half
            threshold_short += half
            reasoning.append(f"FNG: Fear {fng:.0f} → long −{half:.2f}, short +{half:.2f}")
        elif fng > self.fng_extreme_greed_thr:
            delta = self.fng_bias_delta
            threshold_long  += delta
            threshold_short -= delta
            reasoning.append(f"FNG: Extreme Greed {fng:.0f} → long +{delta:.2f}, short −{delta:.2f}")
        elif fng > self.fng_greed_thr:
            half = self.fng_bias_delta * 0.5
            threshold_long  += half
            threshold_short -= half
            reasoning.append(f"FNG: Greed {fng:.0f} → long +{half:.2f}, short −{half:.2f}")

    # ── BTC Dominance Bias ───────────────────────────────────────────────
    if self.dom_gate_enabled and covariates:
        dom_now  = covariates.get("btc_dominance", 0.0)
        dom_delta_24h = dom_now - dom_prev_value
        if dom_delta_24h > self.dom_rising_delta:
            half = self.dom_bias_delta * 0.5
            threshold_long += half
            reasoning.append(f"DomBias: Dominance +{dom_delta_24h*100:.2f}% → long +{half:.2f}")
    ```

#### `apps/api/services/execution.py`
- **`BotConfig.__init__`**: aggiungere i 9 nuovi campi con `kw.get("field", default)`
- **`_cycle()`**:
  - Recuperare il valore precedente di dominance per calcolare il delta 24h (6 cicli × 4h = 24h): `dom_prev = get_latest_covariates(["btc_dominance_prev"])` — oppure più semplice: usare la dominance di 6 cicli fa dalla tabella `covariates` con una query `ORDER BY time DESC LIMIT 7`
  - Passare `covariates=covars` e `dom_prev_value=dom_prev` a `decision_engine.decide()`
  - La creazione del `DecisionEngine` (linee ~768-789) deve includere i 9 nuovi parametri

#### `apps/api/main.py`
- **Pydantic `BotConfig`**: aggiungere i 9 nuovi campi con `Field(default, ge=..., le=...)`

#### `apps/api/services/backtesting.py`
- **Estrazione config** (sezione iniziale): aggiungere `getattr` per tutti i 9 nuovi campi
- **Fetch storico F&G**: se `fng_gate_enabled`, chiamare `fetch_historical_fng()` una volta prima del loop:
  ```python
  fng_history: dict[str, float] = {}
  if fng_gate_enabled:
      try:
          from services.covariates import fetch_historical_fng
          fng_history = await fetch_historical_fng()
      except Exception as _e:
          log.warning("Historical F&G fetch failed — F&G gate disabled for this backtest: %s", _e)
          fng_gate_enabled = False
  ```
- **Nel loop per-bar**: costruire `covars_bt` per ogni bar
  ```python
  bar_date = str(row.name.date())  # row.name è l'indice datetime
  fng_val  = fng_history.get(bar_date, 50.0) if fng_gate_enabled else 50.0
  covars_bt = {"fear_greed": fng_val, "btc_dominance": 0.0}
  ```
- **`decision_engine.decide()`**: aggiungere `covariates=covars_bt`
- **`DecisionEngine` istanziazione**: aggiungere i 9 nuovi parametri. `dom_gate_enabled` forzato a `False` in backtesting (il parametro viene estratto dalla config ma viene passato `False` all'istanza, con commento: `# BTC dominance history not available — skipped in backtest`)

---

<a name="feature-2"></a>
## Feature 2 — Funding Rate Gate/Bias

### 2.1 Situazione attuale

`df_fund` viene fetchato in `_cycle()` e passato a `build_all_features()`. La feature matrix già contiene una colonna `"funding"` (tasso per ogni barra 4H, corrispondente alla sessione di funding di 8H). Tuttavia:
- Non viene mai usata direttamente per modificare le soglie di decisione
- Viene passata a Chronos come covariata, ma solo come serie temporale opaca

### 2.2 Logica di decisione

Il funding rate medio delle ultime N barre (default N=6 = 48h) riflette il **posizionamento aggregato del mercato con leva**:
- Funding medio molto positivo = mercato over-long, costo alto per i long, rischio di flush
- Funding medio molto negativo = mercato over-short, potenziale short squeeze

| Condizione | Effetto |
|------------|---------|
| `avg_funding > funding_high_thr` (default 0.00010) | `threshold_long += funding_bias_delta` · `threshold_short -= funding_bias_delta` |
| `avg_funding > funding_extreme_thr` (default 0.00030) | Effetto 2× (`funding_bias_delta * 2`) |
| `avg_funding < -funding_high_thr` | `threshold_long -= funding_bias_delta` · `threshold_short += funding_bias_delta` |
| `avg_funding < -funding_extreme_thr` | Effetto 2× |
| Tra `-funding_high_thr` e `+funding_high_thr` | Nessun effetto |

**Valori di riferimento Hyperliquid:** Funding neutro su BTC è ~0.0001/8h (0.01% per 8h). Alta tensione long inizia ~0.0003/8h (0.03% = $300 su $1M per 8h). Estremo = oltre 0.0005/8h.

**Posizionamento nel flusso:** Stesso livello del F&G bias — dopo RegimeBias, prima di ExhaustionGuard. I due bias sono **additivi** (se F&G + funding concorrono nello stesso senso, l'aggiustamento si accumula).

**Valore di `avg_funding` calcolato:**
```python
# In _cycle() e in backtesting per-bar loop:
funding_lookback = cfg.funding_gate_lookback  # default 6 barre = 48h
fund_series = df_feat["funding"].values
avg_funding = float(np.nanmean(fund_series[-funding_lookback:])) if len(fund_series) >= funding_lookback else 0.0
```

### 2.3 Backtestabilità

**COMPLETAMENTE BACKTESTABILE.** `df_fund` è già fetchato in `backtesting.py` (linea 113) e `df_feat["funding"]` è già nella feature matrix. Il calcolo di `avg_funding` per ogni barra è:
```python
avg_funding = float(np.nanmean(df_feat["funding"].values[max(0, i - funding_lookback):i])) if i > 0 else 0.0
```

### 2.4 Nuovi campi di configurazione

| Campo | Tipo | Default | Range | Nota |
|-------|------|---------|-------|------|
| `funding_gate_enabled` | bool | False | — | Master toggle |
| `funding_gate_lookback` | int | 6 | 2–24 | Barre 4H da mediare (6 = 48h) |
| `funding_high_thr` | float | 0.00010 | 0.00003–0.00050 | Soglia "alto" per 8H rate |
| `funding_extreme_thr` | float | 0.00030 | 0.00010–0.00100 | Soglia "estremo" per 8H rate |
| `funding_bias_delta` | float | 0.03 | 0.01–0.08 | Aggiustamento base soglie |

### 2.5 Modifiche per file

#### `apps/api/services/decision.py`
- **`__init__`**: aggiungere 5 nuovi parametri
- **`decide()`**: aggiungere parametro `avg_funding: float = 0.0`
  - Blocco **Funding Rate Bias** inserito insieme al blocco F&G (dopo RegimeBias):
    ```
    # ── Funding Rate Bias ────────────────────────────────────────────────
    if self.funding_gate_enabled and avg_funding != 0.0:
        _fund_mult = 2.0 if abs(avg_funding) > self.funding_extreme_thr else 1.0
        _fund_adj  = self.funding_bias_delta * _fund_mult
        if avg_funding > self.funding_high_thr:
            threshold_long  += _fund_adj
            threshold_short -= _fund_adj
            reasoning.append(f"FundingBias: avg={avg_funding*10000:.2f}bps/8h (×{_fund_mult:.0f}) → long +{_fund_adj:.2f}, short −{_fund_adj:.2f}")
        elif avg_funding < -self.funding_high_thr:
            threshold_long  -= _fund_adj
            threshold_short += _fund_adj
            reasoning.append(f"FundingBias: avg={avg_funding*10000:.2f}bps/8h (×{_fund_mult:.0f}) → long −{_fund_adj:.2f}, short +{_fund_adj:.2f}")
    ```

#### `apps/api/services/execution.py`
- **`BotConfig.__init__`**: aggiungere i 5 nuovi campi
- **`_cycle()`**:
  - Calcolare `avg_funding` da `df_feat["funding"]` prima della creazione del `DecisionEngine`
  - Passare `avg_funding=avg_funding` a `decision_engine.decide()`
  - Il `DecisionEngine` riceve i 5 nuovi parametri nella sua istanziazione

#### `apps/api/main.py`
- **Pydantic `BotConfig`**: aggiungere i 5 nuovi campi

#### `apps/api/services/backtesting.py`
- **Estrazione config**: aggiungere `getattr` per i 5 nuovi campi
- **Nel loop per-bar** (linea ~428, prima di `decision_engine.decide()`):
  ```python
  avg_funding = 0.0
  if funding_gate_enabled and i > 0:
      _lb = min(funding_gate_lookback, i)
      avg_funding = float(np.nanmean(df_feat["funding"].values[i - _lb:i]))
  ```
- **`decision_engine.decide()`**: aggiungere `avg_funding=avg_funding`
- **`DecisionEngine` istanziazione**: aggiungere i 5 nuovi parametri

---

<a name="feature-3"></a>
## Feature 3 — Order Book L2 Imbalance

### 3.1 Premessa di design

Questa è la feature più complessa. Alcune regole non negoziabili:

1. **Non è backtestabile.** Il toggle `ob_imbalance_gate_enabled` esiste in BotConfig per coerenza, ma in `backtesting.py` viene estratto e **ignorato** (hardcoded a comportarsi come se fosse False). Ogni tentativo di backtest con questa feature attiva produce il comportamento base senza modifiche.

2. **Strategia anti-spoofing non negoziabile.** Non usare singoli snapshot. Non usare solo i top 3 livelli. Non fidarsi di un singolo momento temporale. Tutta la logica di raccolta è progettata per essere **resistente alla manipolazione intenzionale del book**.

3. **Fail-safe obbligatorio.** Se il buffer L2 è stale (nessun update in >120s), è vuoto, o contiene meno di `ob_min_samples` reading, il gate è automaticamente **bypassed** (il trade prosegue normalmente). Il gate non blocca mai in caso di dato assente.

4. **Modalità predefinita: `log_only`.** Il gate di default non blocca né modifica nulla — logga solo l'imbalance corrente nel `reasoning`. Questo permette di osservare il comportamento per N settimane prima di attivare modalità più aggressive.

### 3.2 Subscription Hyperliquid l2Book

Hyperliquid espone l'order book tramite WS con la subscription:
```json
{"method": "subscribe", "subscription": {"type": "l2Book", "coin": "BTC", "nSigFigs": 5}}
```

Il parametro `nSigFigs: 5` normalizza i prezzi a 5 cifre significative, riducendo il rumore nella granularità dei prezzi e semplificando il parsing.

**Formato messaggio in arrivo:**
```json
{
  "channel": "l2Book",
  "data": {
    "coin": "BTC",
    "time": 1716720000000,
    "levels": [
      [["49950.0", "0.5000"], ["49940.0", "1.2000"], ...],
      [["50010.0", "0.3000"], ["50020.0", "0.8000"], ...]
    ]
  }
}
```
`levels[0]` = bids (ordinati dal più alto al più basso).
`levels[1]` = asks (ordinati dal più basso al più alto).
Ogni entry è `[price_str, size_str]`.

**Nota importante:** HL invia snapshot completi ad ogni cambiamento del book, non diff incrementali. Ogni messaggio sostituisce interamente lo stato precedente del book.

### 3.3 Formula di imbalance (notional-weighted)

Usare **notional USD** invece di raw size in BTC:
```
bid_notional = Σ (float(price) × float(size)) per i primi N livelli bid
ask_notional = Σ (float(price) × float(size)) per i primi N livelli ask
imbalance    = (bid_notional − ask_notional) / (bid_notional + ask_notional)
```

Range: **[-1.0, +1.0]**
- `+1.0` = solo bid visibili (acquirenti dominanti)
- `-1.0` = solo ask visibili (venditori dominanti)
- `0.0` = perfettamente bilanciato

Usare **notional** invece di size evita che grandi ordini a prezzi lontani dal mercato (quindi meno rilevanti) pesino eccessivamente.

### 3.4 Strategia anti-spoofing

**Problema:** I grandi operatori piazzano e ritirano grandi ordini ai top 1-3 livelli continuamente (layering/spoofing) per manipolare la percezione del book.

**Contromisure nell'implementazione:**

| Contromisura | Implementazione |
|--------------|-----------------|
| Profondità sufficiente | Default `ob_depth_levels = 10` livelli per lato. Spoofing massivo ai top 10 livelli è costoso e raro. |
| Rolling buffer | `deque(maxlen=120)` — mantiene gli ultimi 120 snapshot (~2 min a ~1 snapshot/sec). L'imbalance mean di 120 snapshot è molto più difficile da manipolare del singolo istante. |
| Mean + std | Calcolare media E deviazione standard del buffer. Se `std > ob_max_std` (default 0.30), il mercato è troppo instabile per fare affidamento sul book → bypass automatico. |
| Campionamento minimo | Gate inattivo se `buffer.size < ob_min_samples` (default 10). Non agire sui primissimi snapshot dopo la connessione. |
| Staleness check | Se `time.time() - last_l2_update_ts > 120.0` → gate bypassed (WS lag o disconnessione). |
| Modalità log_only | Default non blocca mai — osservare prima di confidare nel segnale. |

### 3.5 Modifiche a `HLWebSocket`

#### `__init__`
Aggiungere:
```python
from collections import deque
import time as _time_module

self._l2_imbalance_buffer: deque = deque(maxlen=120)  # (timestamp, imbalance) pairs
self._l2_last_update_ts: float = 0.0
self._l2_depth_levels: int = 10  # configurabile dall'esterno dopo la costruzione
```

#### `_subscribe()`
Aggiungere la subscription l2Book alla lista `subs`:
```python
{"type": "l2Book", "coin": self.symbol, "nSigFigs": 5}
```

#### `_handle()`
Aggiungere il routing per il nuovo canale:
```python
elif channel == "l2Book":
    self._on_l2_book(data)
```
Nota: `_on_l2_book` è **sincrona** (non async), esattamente come `_on_asset_ctx`.

#### Nuovo metodo `_on_l2_book(self, data: dict)`
```python
def _on_l2_book(self, data: dict):
    try:
        levels = data.get("levels", [])
        if len(levels) < 2:
            return
        bid_levels = levels[0][:self._l2_depth_levels]
        ask_levels = levels[1][:self._l2_depth_levels]

        bid_notional = sum(float(p) * float(s) for p, s in bid_levels)
        ask_notional = sum(float(p) * float(s) for p, s in ask_levels)
        total = bid_notional + ask_notional
        if total <= 0:
            return

        imbalance = (bid_notional - ask_notional) / total
        self._l2_imbalance_buffer.append((_time_module.time(), imbalance))
        self._l2_last_update_ts = _time_module.time()
    except (ValueError, TypeError, IndexError):
        pass
```

#### Nuovo metodo `get_l2_snapshot(self) -> dict`
Restituisce lo stato corrente del buffer per il consumatore (non resetta nulla, è read-only):
```python
def get_l2_snapshot(self) -> dict:
    """
    Restituisce statistiche del buffer L2 imbalance accumulato.
    Non acquisisce lock — è sincrona e opera su deque thread-safe (CPython).
    """
    now = _time_module.time()
    stale = (now - self._l2_last_update_ts) > 120.0
    samples = list(self._l2_imbalance_buffer)  # snapshot istantaneo

    if not samples or stale:
        return {
            "mean_imbalance": 0.0,
            "std_imbalance":  0.0,
            "samples":        len(samples),
            "stale":          True,
        }

    values = [v for _, v in samples]
    mean   = float(np.mean(values))
    std    = float(np.std(values))
    return {
        "mean_imbalance": mean,
        "std_imbalance":  std,
        "samples":        len(samples),
        "stale":          stale,
    }
```

### 3.6 Logica di gate in `execution.py`

Il gate L2 si applica **dopo** `decision_engine.decide()` e **prima** di `_open_position()`, esattamente come il gate 1H LightGBM (linee ~798-837). Non entra in `DecisionEngine.decide()` — è un filtro di esecuzione tattica, non un giudizio strategico.

#### Nuovo metodo privato `_check_l2_quality(result, cfg) -> DecisionResult`

```python
async def _check_l2_quality(self, result: DecisionResult, cfg: BotConfig) -> DecisionResult:
    """
    Post-decision L2 order book quality check.
    Modifica result.action o aggiunge a result.reasoning in base all'imbalance corrente.
    Mai blocca se dati insufficienti o stale — fail-safe garantito.
    """
    l2 = self._ws.get_l2_snapshot()

    # Fail-safe: dati insufficienti o stale → bypass silenzioso
    if l2["stale"] or l2["samples"] < cfg.ob_min_samples:
        result.reasoning.append(
            f"L2: bypass (samples={l2['samples']}, stale={l2['stale']})"
        )
        return result

    mean_imb = l2["mean_imbalance"]
    std_imb  = l2["std_imbalance"]

    # Fail-safe: book troppo volatile → bypass
    if std_imb > cfg.ob_max_std:
        result.reasoning.append(
            f"L2: bypass (std={std_imb:.3f} > {cfg.ob_max_std:.2f} — book instabile)"
        )
        return result

    side     = result.action  # "long" or "short"
    aligned  = (side == "long" and mean_imb > 0) or (side == "short" and mean_imb < 0)
    opposing = (side == "long" and mean_imb < 0) or (side == "short" and mean_imb > 0)
    abs_imb  = abs(mean_imb)

    mode = cfg.ob_confirmation_mode

    if mode == "log_only":
        # Registra sempre, non blocca mai
        result.reasoning.append(
            f"L2 [{mode}]: imbalance={mean_imb:+.3f} std={std_imb:.3f} "
            f"samples={l2['samples']} — {'aligned' if aligned else 'opposing' if opposing else 'neutral'}"
        )

    elif mode == "confirm":
        # Richiede allineamento minimo per procedere; blocca solo se forte opposizione
        if abs_imb >= cfg.ob_imbalance_threshold:
            if aligned:
                result.reasoning.append(
                    f"L2 [confirm]: imbalance={mean_imb:+.3f} — CONFIRMED ({side})"
                )
            elif abs_imb >= cfg.ob_veto_threshold:
                result.action = "no_trade"
                result.reasoning.append(
                    f"L2 [confirm VETO]: imbalance={mean_imb:+.3f} strongly against {side} "
                    f"(thr={cfg.ob_veto_threshold:.2f}) — trade blocked"
                )
        else:
            result.reasoning.append(
                f"L2 [confirm]: imbalance={mean_imb:+.3f} < thr={cfg.ob_imbalance_threshold:.2f} — neutral, proceeding"
            )

    elif mode == "veto":
        # Blocca solo se fortemente opposto; non richiede allineamento per procedere
        if opposing and abs_imb >= cfg.ob_veto_threshold:
            result.action = "no_trade"
            result.reasoning.append(
                f"L2 [veto]: imbalance={mean_imb:+.3f} against {side} "
                f"(thr={cfg.ob_veto_threshold:.2f}) — trade blocked"
            )
        else:
            result.reasoning.append(
                f"L2 [veto]: imbalance={mean_imb:+.3f} — {'opposing but weak' if opposing else 'OK'}, proceeding"
            )

    return result
```

#### In `_cycle()`, dopo il gate 1H e prima della macro pause:
```python
# ── L2 Order Book Quality Check ──────────────────────────────────────────
if cfg.ob_imbalance_gate_enabled and result.action in ("long", "short"):
    result = await self._check_l2_quality(result, cfg)
```

### 3.7 Nuovi campi di configurazione

| Campo | Tipo | Default | Note |
|-------|------|---------|------|
| `ob_imbalance_gate_enabled` | bool | False | Master toggle |
| `ob_depth_levels` | int | 10 | Livelli bid/ask da includere nel calcolo |
| `ob_min_samples` | int | 10 | Campioni minimi nel buffer prima di attivare il gate |
| `ob_max_std` | float | 0.30 | Deviazione standard massima tollerata prima del bypass |
| `ob_confirmation_mode` | str | "log_only" | `"log_only"` / `"confirm"` / `"veto"` |
| `ob_imbalance_threshold` | float | 0.15 | |imbalance| minima per considerarla significativa |
| `ob_veto_threshold` | float | 0.25 | |imbalance| che oppone un veto in mode confirm/veto |

**Validazione Pydantic per `ob_confirmation_mode`:**
```python
ob_confirmation_mode: str = Field("log_only", pattern="^(log_only|confirm|veto)$")
```

### 3.8 Modifiche per file — riepilogo

#### `apps/api/services/hl_websocket.py`
- `__init__`: nuovi campi `_l2_imbalance_buffer`, `_l2_last_update_ts`, `_l2_depth_levels`
- `_subscribe()`: aggiungere subscription `l2Book`
- `_handle()`: aggiungere routing `"l2Book"` → `_on_l2_book()`
- Nuovo metodo `_on_l2_book(self, data)`
- Nuovo metodo `get_l2_snapshot(self) -> dict`
- Import `from collections import deque` e `import time as _time_module`

#### `apps/api/services/execution.py`
- `BotConfig.__init__`: aggiungere 7 nuovi campi
- Nuovo metodo `_check_l2_quality(self, result, cfg) -> DecisionResult`
- `_cycle()`: chiamare `_check_l2_quality` nella posizione corretta
- `_ws` (`HLWebSocket`): dopo la costruzione in `__init__`, settare `self._ws._l2_depth_levels` dal config (o gestirlo tramite metodo dedicato `set_depth_levels`)

#### `apps/api/main.py`
- Pydantic `BotConfig`: aggiungere 7 nuovi campi

#### `apps/api/services/backtesting.py`
- Estrarre `ob_imbalance_gate_enabled = getattr(cfg, "ob_imbalance_gate_enabled", False)` (e tutti gli altri)
- **Non passare al `DecisionEngine`** — non modificare il flusso del backtest
- Aggiungere commento esplicito: `# ob_imbalance_gate: L2 book data non disponibile storicamente — ignorato in backtest`

---

<a name="feature-4"></a>
## Feature 4 — Slippage Tracking Sistematico

### 4.1 Obiettivo

Misurare sistematicamente la differenza tra il prezzo stimato (mark price al momento della decisione) e il prezzo effettivo di fill, per ogni ordine entry e exit. Serve a:
1. Calibrare i parametri SL/TP che oggi sono calcolati sul mark price, non sul fill effettivo
2. Rilevare deterioramenti nella qualità dell'esecuzione nel tempo
3. Calcolare correttamente l'equity (oggi diverge dal fill reale)
4. Ottimizzare il parametro `slip_px` (50bps di tolleranza IOC)

### 4.2 Dati da catturare

Per ogni ordine:
- `mark_price_at_decision`: mark price al momento del ciclo (già disponibile)
- `slip_limit_price`: il prezzo IOC settato (mark × 1.005 o × 0.995)
- `fill_price`: il prezzo medio di fill effettivo (`avgPx` dalla risposta HL)
- `slippage_bps`: `(fill_price − mark_price_at_decision) / mark_price_at_decision × 10000`
  - Per long: valore positivo = hai pagato più del mark (slippage sfavorevole)
  - Per short: valore negativo = hai venduto meno del mark (slippage sfavorevole)
- `fill_size`: dimensione effettiva riempita (già estratta dopo fix B3)

### 4.3 Dove estrarre `avgPx`

In `_submit_open_order()` e `_submit_close_order()`, la risposta HL ha struttura:
```json
{
  "response": {
    "type": "order",
    "data": {
      "statuses": [
        {"filled": {"totalSz": "0.010", "avgPx": "49985.0", "oid": 12345}}
      ]
    }
  }
}
```

Per il fill parziale (o zero fill), `"filled"` potrebbe essere absent e `"resting"` o `"error"` presenti. Il parsing difensivo già introdotto con il fix B3 può essere esteso:
```python
filled_info = status_0.get("filled", {})
fill_price  = float(filled_info.get("avgPx", 0)) if filled_info else 0.0
```

### 4.4 Modifica alla signature di `_submit_open_order()`

**Attuale:** `async def _submit_open_order(...) -> Optional[str]`

**Nuova:** `async def _submit_open_order(...) -> tuple[Optional[str], float]`
- Primo elemento: `oid` (invariato)
- Secondo elemento: `fill_price` effettivo (0.0 se non disponibile)

Aggiornare tutti i caller (attualmente solo `_open_position()`):
```python
# Prima:
oid = await self._submit_open_order(...)
# Dopo:
oid, entry_fill_px = await self._submit_open_order(...)
```

Stessa modifica per `_submit_close_order()`:
**Nuova:** `async def _submit_close_order() -> float`
- Restituisce `fill_price` (0.0 su errore o se non disponibile)

### 4.5 Storage dei dati di slippage

**Opzione scelta: aggiungere colonne alla tabella `trades` esistente** (non creare una nuova tabella).

Nuove colonne da aggiungere a `trades` in Supabase:
| Colonna | Tipo | Descrizione |
|---------|------|-------------|
| `entry_fill_price` | float8 | Prezzo medio di fill all'entrata |
| `entry_slippage_bps` | float8 | Slippage in bps all'entrata |
| `exit_fill_price` | float8 | Prezzo medio di fill all'uscita |
| `exit_slippage_bps` | float8 | Slippage in bps all'uscita |

In `_close_position()`, la riga inserita nella tabella `trades` (linea ~1580-1598) viene arricchita con questi 4 campi. Se i dati di fill non sono disponibili (paper mode, errore), i campi rimangono NULL.

### 4.6 Statistiche in-memory con Welford's algorithm

Aggiungere a `ExecutionEngine.__init__`:
```python
self._slippage_stats = {
    "entry_n":    0,
    "entry_mean": 0.0,
    "entry_M2":   0.0,   # per calcolo varianza online (Welford)
    "exit_n":     0,
    "exit_mean":  0.0,
    "exit_M2":    0.0,
}
```

Funzione di aggiornamento (Welford's online algorithm — non richiede di conservare tutti i campioni):
```python
def _update_slippage_stats(self, kind: str, value: float):
    """kind: 'entry' o 'exit'"""
    n_key    = f"{kind}_n"
    mean_key = f"{kind}_mean"
    m2_key   = f"{kind}_M2"
    n    = self._slippage_stats[n_key] + 1
    mean = self._slippage_stats[mean_key]
    m2   = self._slippage_stats[m2_key]
    delta    = value - mean
    mean    += delta / n
    delta2   = value - mean
    m2      += delta * delta2
    self._slippage_stats[n_key]    = n
    self._slippage_stats[mean_key] = mean
    self._slippage_stats[m2_key]   = m2
```

Proprietà derivata (esposta via `/bot` GET endpoint):
```python
@property
def slippage_summary(self) -> dict:
    result = {}
    for kind in ("entry", "exit"):
        n    = self._slippage_stats[f"{kind}_n"]
        mean = self._slippage_stats[f"{kind}_mean"]
        var  = self._slippage_stats[f"{kind}_M2"] / n if n > 1 else 0.0
        result[f"{kind}_slippage_mean_bps"] = round(mean, 2)
        result[f"{kind}_slippage_std_bps"]  = round(var ** 0.5, 2)
        result[f"{kind}_slippage_samples"]  = n
    return result
```

### 4.7 Alert Telegram

In `_close_position()`, dopo il calcolo dello slippage, se `abs(entry_slippage_bps) > cfg.slippage_alert_threshold_bps` oppure `abs(exit_slippage_bps) > cfg.slippage_alert_threshold_bps`:
```
asyncio.create_task(self._notifier.send_error(
    f"⚠️ Slippage anomalo: entry={entry_slippage_bps:.1f}bps exit={exit_slippage_bps:.1f}bps "
    f"(soglia: ±{cfg.slippage_alert_threshold_bps:.0f}bps)",
    "slippage_alert"
))
```

### 4.8 Nuovi campi di configurazione

| Campo | Tipo | Default | Note |
|-------|------|---------|------|
| `slippage_tracking_enabled` | bool | True | Master toggle (passive, non blocca mai) |
| `slippage_alert_threshold_bps` | float | 50.0 | Soglia per alert Telegram (bps) |

### 4.9 Modifiche per file

#### `apps/api/services/execution.py`
- `BotConfig.__init__`: aggiungere 2 nuovi campi
- `__init__` di `ExecutionEngine`: aggiungere `self._slippage_stats`
- `_submit_open_order()`: estrarre `avgPx` → nuovo return type `tuple[Optional[str], float]`
- `_submit_close_order()`: estrarre `avgPx` → nuovo return type `float`
- `_open_position()`: unpack tuple da `_submit_open_order()`; memorizzare `entry_fill_price` in `self._position`
- `_close_position()`: calcolare `entry_slippage_bps` e `exit_slippage_bps`; aggiornare stats con `_update_slippage_stats`; includere nelle 4 nuove colonne della riga `trades`
- Nuovo metodo `_update_slippage_stats(self, kind, value)`
- Nuova property `slippage_summary`

#### `apps/api/main.py`
- Pydantic `BotConfig`: aggiungere 2 nuovi campi
- Endpoint `GET /bot`: includerà automaticamente `slippage_summary` se esposto via `engine.slippage_summary` nella risposta

#### Supabase (migrazione schema)
- Aggiungere 4 colonne nullable a tabella `trades`: `entry_fill_price float8`, `entry_slippage_bps float8`, `exit_fill_price float8`, `exit_slippage_bps float8`
- Nessuna nuova tabella necessaria

#### `apps/api/services/backtesting.py`
- Nessuna modifica. Lo slippage tracking è esclusivamente live.

---

<a name="appendice-a"></a>
## Appendice A — Mapping completo file → modifiche

| File | Feature 1 | Feature 2 | Feature 3 | Feature 4 |
|------|-----------|-----------|-----------|-----------|
| `services/decision.py` | `__init__` + `decide()` | `__init__` + `decide()` | — | — |
| `services/execution.py` | BotConfig + `_cycle()` | BotConfig + `_cycle()` | BotConfig + `_cycle()` + nuovo `_check_l2_quality()` | BotConfig + `__init__` + 4 metodi esistenti + 2 nuovi metodi |
| `services/hl_websocket.py` | — | — | `__init__` + `_subscribe()` + `_handle()` + 2 nuovi metodi | — |
| `services/covariates.py` | Nuova funzione `fetch_historical_fng()` | — | — | — |
| `services/backtesting.py` | Config extract + F&G history fetch + decide() call | Config extract + avg_funding calc + decide() call | Config extract only (no-op) | — |
| `main.py` | Pydantic BotConfig (+9 campi) | Pydantic BotConfig (+5 campi) | Pydantic BotConfig (+7 campi) | Pydantic BotConfig (+2 campi) |
| Supabase schema | — | — | — | Alter table `trades` (+4 colonne) |

**Totale nuovi campi BotConfig:** 23 (9 + 5 + 7 + 2)

---

<a name="appendice-b"></a>
## Appendice B — Nuovi campi BotConfig (tabella completa)

### Feature 1 — Fear & Greed + BTC Dominance
```
fng_gate_enabled             bool    False
fng_extreme_fear_thr         float   20.0
fng_fear_thr                 float   35.0
fng_greed_thr                float   65.0
fng_extreme_greed_thr        float   80.0
fng_bias_delta               float   0.03
dom_gate_enabled             bool    False
dom_rising_delta             float   0.008
dom_bias_delta               float   0.02
```

### Feature 2 — Funding Rate Gate/Bias
```
funding_gate_enabled         bool    False
funding_gate_lookback        int     6
funding_high_thr             float   0.00010
funding_extreme_thr          float   0.00030
funding_bias_delta           float   0.03
```

### Feature 3 — Order Book L2 Imbalance
```
ob_imbalance_gate_enabled    bool    False
ob_depth_levels              int     10
ob_min_samples               int     10
ob_max_std                   float   0.30
ob_confirmation_mode         str     "log_only"
ob_imbalance_threshold       float   0.15
ob_veto_threshold            float   0.25
```

### Feature 4 — Slippage Tracking
```
slippage_tracking_enabled    bool    True
slippage_alert_threshold_bps float   50.0
```

---

<a name="appendice-c"></a>
## Appendice C — Ordine di implementazione consigliato

### Fase 1 (una sessione, basso rischio)
1. **Feature 2 — Funding Rate Gate** — tutto il dato è già presente, nessuna chiamata esterna nuova, completamente backtestabile. Minimo 3 file da toccare. Ideale per validare il pattern prima di fare le feature più complesse.
2. **Feature 1 — F&G** (solo live, senza storico backtest) — collegare i `covars` esistenti al `DecisionEngine`. Circa 4 file, sforzo basso. La parte del backtest storico può essere aggiunta successivamente.

### Fase 2 (sessione dedicata)
3. **Feature 4 — Slippage Tracking** — modifica delle signature di `_submit_open_order` e `_submit_close_order`. Richiede attenzione ai caller e alla migrazione Supabase. Impatto basso sul comportamento, alto valore informativo.

### Fase 3 (sessione dedicata, testare in paper first)
4. **Feature 1 — F&G storico per backtest** — aggiungere `fetch_historical_fng()` e integrare il loop in `backtesting.py`.
5. **Feature 3 — L2 Order Book** — la più complessa. Partire **obbligatoriamente con `ob_confirmation_mode = "log_only"`** per almeno 2 settimane di osservazione in paper mode prima di passare a `"confirm"` o `"veto"`.

### Regola generale
Ogni feature va implementata con il proprio toggle `= False` (disabilitata di default). Prima di abilitare in live, testare in paper per almeno un ciclo completo di backtest + 2 settimane di paper mode. Non abilitare mai più di una feature nuova alla volta in live.

---

*Fine del piano. Versione 1.0 — soggetto a revisione durante l'implementazione.*
