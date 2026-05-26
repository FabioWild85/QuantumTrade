# 🔍 AI Trading Hub — Audit Report Completo

**Data:** 25 Maggio 2025
**Ambito:** Intero codebase (`apps/api/` e `apps/web/`)
**Metodologia:** Code review statica di tutti i service critici, endpoint REST, WebSocket handler, pipeline feature, e componenti frontend

---

## Riepilogo

Il codice è complessivamente ben strutturato, con una chiara separazione delle responsabilità tra i vari service. La pipeline di decisione multi-gate è robusta, la persistenza dello stato sopravvive ai restart, e i meccanismi di protezione (circuit breaker, kill switch, macro pause) sono ben implementati.

Tuttavia, ho identificato **3 bug certi**, **3 race condition**, **4 incongruenze di design**, e **5 osservazioni minori**.

---

## 🚨 Bug Certi

### B1 — `logger` non definito in `main.py` (NameError a runtime)

- **File:** `apps/api/main.py`, linee 785 e 791
- **Gravità:** Alta
- **Categoria:** Bug — Nome variabile errato

```python
# Linea 27 — il logger è definito come:
log = logging.getLogger("trading_hub")

# Linea 785 e 791 — ma viene usato come:
logger.error(f"Backtest job {job_id} failed: {e}")
```

Il nome `logger` non esiste in questo modulo. Quando un job di backtest fallisce, il `NameError` impedisce la corretta gestione dell'errore. Il job rimane in stato `"running"` per sempre e l'eccezione si propaga potenzialmente causando un crash del task asincrono.

**Fix:** Rinominare `logger` → `log` alle linee 785 e 791.

---

### B2 — `kill()` in live mode non registra PnL né aggiorna equity

- **File:** `apps/api/services/execution.py`, linee 262–276
- **Gravità:** Alta
- **Categoria:** Bug — Logica incompleta

```python
if self._position:
    if self.mode == "live":
        try:
            await self._submit_close_order()
            positions_closed = 1
        except Exception as exc:
            log.error("Kill: close order failed: %s", exc)
    else:
        # Paper: book the position at current mark price
        snap  = await self._hl.get_market_snapshot(SYMBOL)
        price = snap.get("mark_price", self._position["entry_price"])
        await self._close_position(price, "kill")
        positions_closed = 1

self._position = None  # <-- azzerato senza passare da _close_position in live
```

In **paper mode**, `kill()` chiama correttamente `_close_position()` che:
- Calcola il PnL
- Aggiorna `self._equity`
- Chiama `self._risk.record_trade_result()`
- Scrive eventi su Supabase
- Invia notifica Telegram

In **live mode**, `kill()` chiama solo `_submit_close_order()` e poi azzera `self._position = None` **senza** passare da `_close_position()`. Di conseguenza:
- `self._equity` non viene aggiornato
- `self._risk.record_trade_result()` non viene chiamato (daily PnL e consecutive losses non aggiornati)
- Nessun evento `trade_closed` viene scritto su Supabase
- Nessuna notifica Telegram di chiusura trade
- Il trade non appare nella tabella `trades`

**Fix:** Anche in live mode, chiamare `_close_position()` dopo `_submit_close_order()`, oppure estrarre la logica di accounting in un metodo separato chiamato da entrambi i rami.

---

### B3 — `_submit_open_order` non gestisce partial fill

- **File:** `apps/api/services/execution.py`, linee 1648–1671
- **Gravità:** Media
- **Categoria:** Bug — Assunzione errata

```python
result = await asyncio.to_thread(
    exchange.order,
    SYMBOL, is_buy, size, slip_px,
    {"limit": {"tif": "Ioc"}},
    False,
    cloid,
)

# Native SL trigger order — usa size originale, non quella fillata
sl_result = await asyncio.to_thread(
    exchange.order,
    SYMBOL, sl_is_buy, size, stop_loss,  # <-- size è l'originale
    {"trigger": {"triggerPx": round(stop_loss, 1), "isMarket": True, "tpsl": "sl"}},
    True,
    sl_cloid,
)
```

L'ordine IOC (Immediate-or-Cancel) può essere eseguito parzialmente. Il codice:
1. Non legge la quantità effettivamente fillata dal risultato dell'ordine
2. Piazza lo SL nativo per l'intero `size` originale

Se l'ordine viene riempito solo al 60%, lo SL copre il 100% della size, creando una potenziale over-hedge (posizione netta short sullo SL).

**Fix:** Leggere la quantità fillata dal risultato dell'ordine e usarla per lo SL. Se il fill è parziale, aggiornare `size_contracts` e `size_usd` di conseguenza.

---

## ⚡ Race Condition

### R1 — `get_snapshot_and_reset()` senza lock in `hl_websocket.py`

- **File:** `apps/api/services/hl_websocket.py`, linee 88–104
- **Gravità:** Media
- **Categoria:** Race condition — Accesso concorrente non sincronizzato

```python
# get_snapshot_and_reset() — NESSUN LOCK
def get_snapshot_and_reset(self) -> dict:
    snapshot = {
        "ws_cvd_delta":     self._cvd_delta,       # LETTURA senza lock
        "ws_liq_long_usd":  self._liq_long_usd,    # LETTURA senza lock
        "ws_liq_short_usd": self._liq_short_usd,   # LETTURA senza lock
        ...
    }
    self._cvd_delta = 0.0                           # SCRITTURA senza lock
    self._liq_long_usd = 0.0
    self._liq_short_usd = 0.0
    return snapshot

# _on_trades() — CON LOCK
async def _on_trades(self, data):
    async with self._lock:
        for trade in trades:
            ...
            self._cvd_delta += usd                  # SCRITTURA con lock
```

`get_snapshot_and_reset()` legge e azzera i campi **senza** acquisire `_lock`, mentre `_on_trades()` modifica gli stessi campi **con** `_lock`. Il lock protegge solo un lato della coppia produttore/consumatore.

**Scenario di race:** Due trade arrivano in sequenza rapida. `_on_trades()` acquisisce il lock e aggiunge `+$500` a `_cvd_delta`. Contemporaneamente, `get_snapshot_and_reset()` legge `_cvd_delta` (vede $500), ma prima che lo azzeri, `_on_trades()` ha già processato un secondo trade e aggiunto altri `+$200` (fuori dal lock perché il lock è già stato rilasciato? No — in asyncio single-thread, `get_snapshot_and_reset` è sincrono, quindi non c'è context switch a metà. Ma il pattern è fragile e non documentato.)

**Impatto reale:** Basso in asyncio single-thread, ma il codice è fuori standard. Se in futuro si introducesse un `await` dentro `get_snapshot_and_reset()`, la race diventerebbe reale.

**Fix:** Acquisire `_lock` anche in `get_snapshot_and_reset()`.

---

### R2 — `_on_asset_ctx()` scrive senza lock

- **File:** `apps/api/services/hl_websocket.py`, linee 212–220
- **Gravità:** Bassa
- **Categoria:** Race condition — Scrittura non protetta

```python
async def _on_asset_ctx(self, data):
    ...
    self._latest_oi = float(ctx.get("openInterest", 0))    # SCRITTURA senza lock
    self._latest_mark = float(ctx.get("markPx", 0))        # SCRITTURA senza lock
```

`_on_asset_ctx()` scrive `_latest_oi` e `_latest_mark` senza lock, mentre `get_snapshot_and_reset()` li legge senza lock. In CPython, l'assegnazione di float è atomica (singolo store a 64-bit), quindi in pratica non c'è corruzione. Tuttavia, il pattern è inconsistente con `_on_trades()` che invece usa il lock.

**Fix:** Per coerenza, usare `_lock` anche qui, oppure documentare esplicitamente perché non è necessario.

---

### R3 — `_paper_watchdog` e `_cycle` competono su `self._position`

- **File:** `apps/api/services/execution.py`, linee 604–635 e 637–992
- **Gravità:** Media
- **Categoria:** Race condition — Due coroutine modificano lo stesso stato

```python
# _paper_watchdog (linea 635)
await self._close_position(mark, reason)  # contiene await interni

# _cycle (linea 637)
async def _cycle(self):
    ...
    await self._open_position(...)  # await interno
    ...
    await self._manage_position(...)  # await interno
```

Anche se asyncio è cooperativo e single-thread, entrambi i coroutine chiamano funzioni con `await` interni. Durante un `await`, il controllo passa ad altre coroutine.

**Scenario problematico:**
1. `_paper_watchdog` rileva SL violato → chiama `_close_position(mark, "stop_loss")`
2. Dentro `_close_position`, dopo `await self._notifier.send_trade_closed(...)` ma prima di `self._position = None`
3. `_cycle` riprende il controllo, completa la sua iterazione, e chiama `_open_position(...)` creando una nuova `self._position`
4. `_close_position` riprende e setta `self._position = None`, **cancellando la nuova posizione appena aperta**

**Probabilità:** Molto bassa (richiede che il watchdog e il ciclo si attivino esattamente nella stessa finestra di 4h), ma l'impatto sarebbe grave (trade perso).

**Fix:** Aggiungere un controllo in `_close_position` che verifichi che la posizione che sta chiudendo sia la stessa che era attiva quando il metodo è stato chiamato (es. confrontando `opened_at` o un ID univoco).

---

## 🔄 Incongruenze di Design

### I1 — Due classi `BotConfig` duplicate e potenzialmente divergenti

- **File:** `apps/api/main.py` (linee 143–219) e `apps/api/services/execution.py` (linee 50–133)
- **Gravità:** Media
- **Categoria:** Design — Duplicazione

| Aspetto | `main.py` BotConfig | `execution.py` BotConfig |
|---------|---------------------|--------------------------|
| Tipo | Pydantic `BaseModel` | Plain Python class |
| Validazione | Sì (automatica) | No |
| Serializzazione | `.model_dump()` | Manuale |
| Default values | Centralizzati | Duplicati |

La conversione avviene nel flusso:
1. Frontend → API: validato come Pydantic `BotConfig`
2. API → Engine: `cfg.model_dump()` → `engine.update_config(dict)`
3. Engine: `setattr(self.config, k, v)` per ogni chiave

Se un campo viene aggiunto a `main.py` ma dimenticato in `execution.py`, il `setattr` lo crea comunque (perché `BotConfig` in execution è una classe semplice), ma senza tipo noto o default. Se un campo viene rimosso da `main.py` ma ancora referenziato in `execution.py`, causa `AttributeError`.

**Fix:** Usare un'unica fonte di verità. Opzioni:
- Esportare il Pydantic model in un modulo condiviso e far sì che `ExecutionEngine` usi direttamente quello
- Oppure generare l'`execution.py` BotConfig automaticamente dal Pydantic model

---

### I2 — `confluence_gate` default diverso tra live e backtest

- **File:** `apps/api/main.py` (linea 193) e `apps/api/services/backtesting.py` (linea 57)
- **Gravità:** Media
- **Categoria:** Design — Inconsistenza

| Contesto | Default `confluence_gate` |
|----------|---------------------------|
| Live trading (`main.py` BotConfig) | `60.0` |
| Backtesting (`backtesting.py` fallback) | `0.0` |

```python
# main.py — default live
confluence_gate: float = Field(60.0, ge=0.0, le=100.0, ...)

# backtesting.py — fallback se cfg è None
confluence_gate = getattr(cfg, "confluence_gate", 0.0)
```

Un backtest lanciato senza passare una config esplicita ha il confluence gate **disabilitato** (0.0), mentre in live è attivo a 60. Questo rende i risultati di backtest e live non direttamente comparabili.

**Fix:** Allineare il default a `60.0` anche nel fallback di `backtesting.py`.

---

### I3 — `cvd_delta` iniettato come feature ma non usato da nessun modello

- **File:** `apps/api/services/execution.py`, linea 711
- **Gravità:** Bassa
- **Categoria:** Design — Codice morto / Feature incompleta

```python
# execution.py linea 711
latest["cvd_delta"] = ws_snap["ws_cvd_delta"]
```

Analisi del flusso:
- `ws_cvd_delta` viene accumulato in `hl_websocket.py` dai trade real-time
- Viene iniettato nel dict `latest` in `_cycle()`
- `latest` viene passato a `_log_inference()` → finisce nel JSON `features` su Supabase
- **Ma:** `cvd_delta` non è in `FEATURE_GROUPS` (smc.py)
- **Ma:** `cvd_delta` non è in `ALL_FEATURES` (smc.py)
- **Ma:** `cvd_delta` non è tra gli `LGBM_FEATURES` (trainer.py)
- **Ma:** `cvd_delta` non è referenziato in `decision.py`

Nessun modello lo usa per le decisioni. È un dato raccolto, loggato, ma mai consumato.

**Fix:** Se il dato serve, aggiungerlo ai feature group e ri-addestrare il modello. Altrimenti, rimuovere l'iniezione per pulizia.

---

### I4 — `_cycle_count` non incrementato dopo sync live position

- **File:** `apps/api/services/execution.py`, linee 687–688
- **Gravità:** Bassa
- **Categoria:** Design — Inconsistenza contatore

```python
# Dentro _cycle(), dopo aver rilevato che la posizione live è stata chiusa dall'exchange
await self._close_position(exit_px, reason)
return   # skip inference for this cycle; nothing to manage
```

Quando una posizione live viene chiusa dall'exchange (es. SL nativo triggerato), il ciclo:
1. Chiama `_close_position()` — corretto
2. Ritorna senza incrementare `_cycle_count`
3. Non aggiorna `_last_cycle_signals`

La UI non riceve aggiornamenti per quel ciclo, e il conteggio dei cicli è sfalsato rispetto al numero reale di candele processate.

**Fix:** Incrementare `_cycle_count` prima del return, e aggiornare `_last_cycle_signals` con un segnale fittizio (`"exchange_close"`).

---

## ⚠️ Osservazioni Minori

### O1 — `_reconcile_position` senza chiave privata

- **File:** `apps/api/services/execution.py`, linee 280–384

Se `HL_WALLET_ADDRESS` è configurato ma `HL_AGENT_PRIVATE_KEY` non lo è, la reconciliation ripristina la posizione in memoria ma il bot non potrà gestirla (nessun ordine può essere inviato). Andrebbe aggiunto un warning esplicito e, idealmente, il bot non dovrebbe avviarsi in live mode senza chiave privata.

---

### O2 — `_calendar.try_refresh_fomc()` in `__init__`

- **File:** `apps/api/services/execution.py`, linea 180

```python
asyncio.create_task(self._calendar.try_refresh_fomc())
```

Chiamato nel costruttore `__init__`. Se l'event loop non è ancora in esecuzione (es. costruzione dell'oggetto prima di `asyncio.run()`), `asyncio.create_task()` fallisce con `RuntimeError`. Funziona solo perché `ExecutionEngine()` è creato dentro la `lifespan` di FastAPI, dove l'event loop è già attivo. È fragile e non ovvio.

**Fix:** Spostare questa chiamata in `start()` o in un metodo `initialize()` chiamato esplicitamente dopo la costruzione.

---

### O3 — `_submit_close_order` non aspetta conferma fill in live

- **File:** `apps/api/services/execution.py`, linee 1703–1733

In live mode, `_close_position()`:
1. Calcola il PnL sul mark price corrente
2. Aggiorna `self._equity` con quel PnL
3. Chiama `_submit_close_order()` — ma non aspetta il fill effettivo

Se l'ordine viene eseguito a un prezzo diverso dal mark price (slippage), l'equity in memoria e il PnL reale divergono. L'errore è piccolo (tipicamente < 0.1%) ma cumulativo nel tempo.

---

### O4 — `_safe_float` restituisce `str(v)` come fallback

- **File:** `apps/api/services/execution.py`, linea 1745

```python
@staticmethod
def _safe_float(v):
    if v is None:
        return None
    if hasattr(v, "__float__"):
        f = float(v)
        return None if (math.isnan(f) or math.isinf(f)) else f
    return str(v)  # <-- fallback a stringa
```

Se un valore non è convertibile a float, restituisce la sua rappresentazione in stringa. Questo viene scritto nel JSON `features` su Supabase. Un consumer che si aspetta numeri potrebbe rompersi.

**Fix:** Restituire `None` invece di `str(v)`, e loggare un warning.

---

### O5 — `_retrain_background` non riporta fallimenti alla UI

- **File:** `apps/api/services/execution.py`, linee 1074–1090

```python
async def _retrain_background(self):
    try:
        metrics = await self._trainer.retrain(...)
        if metrics.get("status") == "ok":
            await self._reload_model_after_retrain(metrics, trigger="auto")
    except Exception as exc:
        log.error("Retraining failed: %s", exc, exc_info=True)
        # Nessun evento su Supabase, nessuna notifica Telegram
```

I retrain automatici sono fire-and-forget. Se falliscono, l'errore è solo nei log del server. L'utente non ha modo di sapere che il modello non è stato aggiornato.

**Fix:** Scrivere un evento `retrain_failed` su Supabase e inviare una notifica Telegram.

---

## ✅ Cosa Funziona Correttamente

1. **Pipeline di decisione ben stratificata** — I gate multipli (ADX, sweep, uncertainty, cont_prob, confluence, FVG, absorption, exhaustion) sono implementati con logica chiara e audit trail completo nei `reasoning`. Ogni gate produce una spiegazione in italiano.

2. **Walk-forward validation con purge gap** — Il trainer usa correttamente expanding window con gap per eliminare look-ahead bias. Il purge gap è configurabile.

3. **Doppio layer SL** — SL bot-side (calcolato via `RiskManager`) + SL nativo Hyperliquid (trigger order on-chain). Se il bot va down, il SL nativo protegge la posizione.

4. **Persistenza stato** — Paper position e live position state sopravvivono ai restart. La logica di merge tra stato HL e stato salvato in `bot_configs.params` è corretta e ben documentata nei log.

5. **Circuit breaker** — 5 errori consecutivi fermano il bot e persistono lo stato. Il contatore viene resettato dopo ogni ciclo completato con successo.

6. **Macro event pause** — Ben implementato con:
   - Refresh automatico del calendario FOMC
   - Notifica singola all'entrata e all'uscita della finestra di pausa
   - Logging dei segnali soppressi con dettaglio evento
   - Chiusura opzionale della posizione durante eventi ad alto impatto

7. **Idempotency guard** — In `_open_position()`, prima di aprire in live verifica che non esista già una posizione su HL. Se esiste, chiama `_reconcile_position()` invece di aprire un duplicato.

8. **Heartbeat** — Scritto ogni ciclo su `bot_configs.heartbeat_at`. Un dead-man's switch esterno può monitorarlo per rilevare bot bloccati.

9. **Regime detection** — Completa con:
   - Classificazione in 6 regimi (trending, ranging, volatile, quiet, breakdown, squeeze)
   - Transition risk composito (ADX + ATR + slope + BB_width)
   - Fallback da DB (`regime_log`) se il segnale in memoria non è disponibile
   - Persistenza automatica a ogni ciclo

10. **Chronos-2 integrazione** — Corretta con:
    - 4 covariate (volume, OI, funding, CVD)
    - Calibrazione isotonica opzionale
    - Fallback a neutral prior (0.5) quando Chronos è disabilitato
    - Fan chart direttamente dai quantili (nessun sampling noise)

11. **Telegram notifications** — Template completi per tutti gli eventi: avvio, stop, trade aperto/chiuso, partial TP, SL spostato, breakeven, kill, errori, heartbeat mancante, macro pause, segnali bloccati, daily summary.

12. **Backtesting engine** — Supporta:
    - Data source HL + Binance (per storico > 11 mesi)
    - Chronos-2 opzionale (disabilitato di default per velocità)
    - Cancellazione long-running job
    - Persistenza risultati su Supabase
    - Single-slot executor per evitare RAM exhaustion

---

## 📊 Tabella Riepilogativa

| ID | Tipo | Gravità | File | Riga/e | Descrizione |
|----|------|---------|------|--------|-------------|
| **B1** | Bug | 🔴 Alta | `main.py` | 785, 791 | `logger` non definito → `NameError` |
| **B2** | Bug | 🔴 Alta | `execution.py` | 262–276 | `kill()` live non registra PnL |
| **B3** | Bug | 🟠 Media | `execution.py` | 1648–1671 | Partial fill non gestito in `_submit_open_order` |
| **R1** | Race | 🟠 Media | `hl_websocket.py` | 88–104 | `get_snapshot_and_reset()` senza lock |
| **R2** | Race | 🟡 Bassa | `hl_websocket.py` | 212–220 | `_on_asset_ctx()` senza lock |
| **R3** | Race | 🟠 Media | `execution.py` | 604–635 | Watchdog e `_cycle()` competono su `_position` |
| **I1** | Design | 🟠 Media | `main.py` / `execution.py` | — | Due `BotConfig` duplicate |
| **I2** | Design | 🟠 Media | `backtesting.py` | 57 | `confluence_gate` default 0 vs 60 |
| **I3** | Design | 🟡 Bassa | `execution.py` | 711 | `cvd_delta` iniettato ma inutilizzato |
| **I4** | Design | 🟡 Bassa | `execution.py` | 688 | `_cycle_count` non incrementato dopo sync |
| **O1** | Minore | 🟡 Bassa | `execution.py` | 280–384 | Reconciliation senza chiave privata |
| **O2** | Minore | 🟡 Bassa | `execution.py` | 180 | `asyncio.create_task` in `__init__` |
| **O3** | Minore | 🟡 Bassa | `execution.py` | 1703–1733 | Close order non aspetta fill |
| **O4** | Minore | 🟡 Bassa | `execution.py` | 1745 | `_safe_float` fallback a stringa |
| **O5** | Minore | 🟡 Bassa | `execution.py` | 1074–1090 | Retrain failure non notificato |

---

## Priorità di Intervento Consigliate

### Immediata (prima del prossimo deploy live)
1. **B1** — `logger` → `log` (fix banale, 2 caratteri)
2. **B2** — `kill()` in live: aggiungere chiamata a `_close_position()`

### Prima della prossima settimana di trading
3. **B3** — Gestione partial fill in `_submit_open_order`
4. **R1** — Lock in `get_snapshot_and_reset()`
5. **I2** — Allineare default `confluence_gate`

### Prossimo sprint
6. **R3** — Proteggere `_close_position` da chiusure duplicate
7. **I1** — Unificare le due classi `BotConfig`
8. **O5** — Notificare fallimenti retrain

### Backlog
9. **I3** — Decidere se usare o rimuovere `cvd_delta`
10. **I4** — Correggere `_cycle_count` dopo sync
11. **O1–O4** — Pulizia minori

---

## Note

- Tutti i file citati sono relativi alla root del progetto `/Users/fabiowild/Desktop/Quantum Trade/`
- I numeri di linea si riferiscono allo stato del codice al 25 Maggio 2025
- Le race condition R1–R3 sono a bassa probabilità di manifestazione in asyncio single-thread, ma vanno corrette per principio e per robustezza futura
- Il codice non ha vulnerabilità di sicurezza evidenti (le chiavi private sono cifrate con Fernet, gli endpoint sono idempotenti)
