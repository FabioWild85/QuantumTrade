# Piano di Implementazione — Pullback Entry con Filtro Impulso

**Data:** 2026-05-28  
**Stato:** Progettato, non implementato — da validare con dati live  
**Priorità:** Media-Alta (implementare dopo aver accumulato almeno 3-6 mesi di trade live)  
**Sostituisce:** `pullback-entry-absorption-plan.md` (piano precedente, meno dettagliato)

---

## Indice

1. [Problema che risolve](#1-problema-che-risolve)
2. [Perché non implementarlo subito](#2-perché-non-implementarlo-subito)
3. [La logica definitiva](#3-la-logica-definitiva)
4. [Parametri e valori di default](#4-parametri-e-valori-di-default)
5. [Architettura tecnica](#5-architettura-tecnica)
6. [File da modificare](#6-file-da-modificare)
7. [Implementazione dettagliata — execution.py](#7-implementazione-dettagliata--executionpy)
8. [Implementazione dettagliata — decision.py e risk.py](#8-implementazione-dettagliata--decisionpy-e-riskpy)
9. [UI — BotConfig.tsx](#9-ui--botconfigtsx)
10. [Checklist pre-implementazione](#10-checklist-pre-implementazione)
11. [Come validare che funziona](#11-come-validare-che-funziona)
12. [Rischi e controindicazioni](#12-rischi-e-controindicazioni)

---

## 1. Problema che risolve

Il sistema attuale valuta il segnale **solo alla chiusura di ogni candela 4H** e apre il trade immediatamente dopo, al prezzo di mercato di quel momento.

Il problema: dopo una candela 4H fortemente direzionale (impulso vero, range ampio, volume elevato), il prezzo quasi sempre ritraccia per 1-2 ore prima di riprendere il trend. Questo ritracciamento è meccanica di mercato reale — i market maker riequilibrano il book, i retail prendono profitto, il prezzo torna a testare zone di supporto/resistenza. Entrare sull'impulso invece che sul pullback significa:

- SL più lontano (volatilità già esplosa → ATR elevato → stop obbligatoriamente distante)
- R:R strutturalmente peggiore
- Slippage più alto
- Entrata in un momento di massima avversità di liquidità

**Esempio concreto discusso:** Bearish trend, chiusura candela 4H molto ribassista. Il bot entra short subito. Ma nelle 1-2 ore successive il prezzo risale al 38-50% del range della candela, offrendo un punto di ingresso short molto più favorevole — SL stretto al massimo del rimbalzo, TP al minimo già definito dalla candela. Quel trade ha R:R 3:1 invece di 1.5:1, e il bot lo ha mancato.

---

## 2. Perché non implementarlo subito

**Non implementare prima di avere almeno 60-100 trade live chiusi.**

Motivi:

1. **Overfitting sui parametri.** La logica richiede 2 parametri principali espressi in multipli di ATR. Con pochi dati, qualsiasi combinazione che "funziona bene" nel backtest è adattata ai pattern storici specifici di BTC in quel periodo — non a una logica robusta. Servono dati live per calibrarli correttamente.

2. **Il sistema attuale non è ancora validato su questi parametri.** Prima di complicare l'execution layer, è più prezioso migliorare il signal quality (Optuna, drift detection, regime filtering). Un segnale migliore con entry immediata batte un segnale mediocre con entry perfetta.

3. **Il fallback può annullare il vantaggio.** Se i parametri sono mal calibrati, il fallback scatta quasi sempre e sei di nuovo al punto di partenza — entri al prezzo di mercato subito dopo la 4H, con complessità aggiuntiva e zero beneficio.

4. **Missed trades in mercati fortemente direzionali.** I mercati crypto in trend violento non pullbackano. Se il 30% dei segnali migliori scattano in questi regimi, perdere quei trade è un costo reale che va misurato empiricamente.

---

## 3. La logica definitiva

### Flusso completo

```
Chiusura candela 4H → segnale long/short scatta dal Decision Engine
    │
    ▼
[FILTRO IMPULSO] candle_range > impulse_atr_mult × ATR_14?
    │
    ├── NO  → entra immediatamente come ora (comportamento invariato)
    │         ≈ 70-80% dei segnali — nessun cambiamento
    │
    └── SÌ  → modalità PULLBACK attivata
              │
              ▼
         OB attivo nella direzione del trade?
         (ob_bull_active=True per long / ob_bear_active=True per short)
              │
              ├── SÌ  → modalità OB LIMIT ORDER
              │         Piazza immediatamente un ordine GTC limit su HL:
              │           Long:  limit a ob_bull_top_px   | SL a ob_bull_bot_px - buffer
              │           Short: limit a ob_bear_bot_px   | SL a ob_bear_top_px + buffer
              │         │
              │         ├── Ordine fillato entro pullback_window_h → trade aperto (fill esatto)
              │         │
              │         ├── Timeout scaduto, ordine non fillato:
              │         │   Cancella ordine HL →
              │         │   price ≤ fallback_atr×ATR da close_4H? →
              │         │     SÌ: fallback market order
              │         │     NO: segnale decade
              │         │
              │         └── Prezzo si allontana > fallback_atr×ATR (break opposto):
              │             Cancella ordine HL → segnale decade
              │
              └── NO  → modalità PASSIVE MONITORING (ATR-based)
                        Zona: close ± pullback_zone_atr × ATR_14
                        │
                        ├── Prezzo entra nella zona entro pullback_window_h ore →
                        │   market order al prezzo corrente | SL ATR-based riancorato
                        │
                        ├── Timeout scaduto, price ≤ fallback_atr×ATR da close_4H →
                        │   market order fallback
                        │
                        └── Prezzo si allontana > fallback_atr×ATR →
                            segnale decade
```

### Due modalità operative: OB Limit Order vs Passive Monitoring

Quando è disponibile un **Order Block attivo nella direzione del trade**, il sistema non si limita a monitorare il prezzo passivamente — piazza direttamente un **ordine GTC limit su Hyperliquid** al livello esatto dell'OB. Questo è l'approccio pragmatico: più preciso, fill garantito al livello voluto (invece di inseguire il mercato con un market order quando il prezzo ci arriva), SL strutturale stretto (appena sotto/sopra l'OB invece di ATR-based).

La differenza rispetto al piano originale: il piano usava l'OB come zona di riferimento e poi entrava a mercato quando il prezzo ci arrivava. Questo piazza invece un limit order reale su HL al prezzo esatto — il broker gestisce il fill, il bot monitora lo stato dell'ordine e lo cancella se scade.

**SL in modalità OB Limit Order:**
- Long: `SL = ob_bull_bot_px - (atr_at_signal × 0.05)` — appena sotto il bottom dell'OB (piccolo buffer per evitare stop-hunt sul livello esatto)
- Short: `SL = ob_bear_top_px + (atr_at_signal × 0.05)` — appena sopra il top dell'OB
- Questo SL è strutturalmente più stretto rispetto all'approccio ATR-based: l'OB invalida il trade solo se il prezzo chiude oltre il suo estremo opposto, non a una distanza arbitraria dall'entry

**Quando non c'è un OB attivo** (o l'OB è fuori range ragionevole), il sistema ricade nella **modalità Passive Monitoring** originale: aspetta passivamente che il prezzo entri nella zona ATR-based e poi esegue un market order. Questa modalità rimane invariata rispetto al piano precedente.

I parametri ATR rimangono attivi come fallback e sono espressi in multipli di `ATR_14` — adattativi alla volatilità corrente.

### Cosa NON fa questa logica

- Non entra a scaglioni (50%+50%) — valutato e scartato per eccessiva complessità con dataset piccolo e problemi di gestione SL su posizioni parziali
- Non monitora pattern 1H interni alla candela — il segnale rimane interamente derivato dalla 4H
- Non modifica il SL/TP — rimangono invariati rispetto alla logica attuale
- Non implementa pullback strutturale multi-candela (fase correttiva nel trend) — quello è un sistema separato da progettare dopo 6+ mesi di dati live

---

## 4. Parametri e valori di default

| Parametro | Nome config | Default | Range UI | Descrizione |
|-----------|-------------|---------|----------|-------------|
| Moltiplicatore ATR candela impulso | `pullback_impulse_atr_mult` | `1.5` | 1.0 – 3.0 | `candle_range > N × ATR_14` per attivare la modalità pullback. Con 1.5: la candela deve aver percorso 1.5 volte l'ATR medio. |
| Zona di pullback (ATR) | `pullback_zone_atr` | `0.3` | 0.1 – 1.0 | Distanza dalla chiusura 4H entro cui il prezzo deve ritornare per triggherare l'entrata. |
| Finestra temporale | `pullback_window_h` | `3` | 1 – 8 | Ore di attesa massima. Dopo questo timeout si applica il fallback. In candele 1H = stesso valore numerico. |
| Distanza fallback (ATR) | `pullback_fallback_atr` | `0.5` | 0.2 – 2.0 | Se dopo il timeout il prezzo è ancora entro N × ATR dalla chiusura 4H, entra comunque. Se è oltre, decade. |
| Abilitato | `pullback_entry_enabled` | `false` | toggle | Master switch. Default OFF — comportamento invariato finché non abilitato esplicitamente. |

### Valori di default — ragionamento

- **`impulse_atr_mult = 1.5`**: una candela da 1.5×ATR è già nel top ~25% delle candele per dimensione. Abbastanza selettivo da non attivarsi su ogni segnale, abbastanza basso da coprire impulsi reali. Da rivalutare con dati live.
- **`pullback_zone_atr = 0.3`**: corrisponde circa al 20-30% del range di una candela da 1.5×ATR. Zona realistica per un rimbalzo tecnico senza aspettare un ritracciamento profondo che spesso non arriva.
- **`pullback_window_h = 3`**: 3 ore = prime 3 candele 1H dopo la chiusura 4H. È la finestra dove i pullback tecnici sono più probabili. Oltre le 3 ore il mercato sta già formando una nuova struttura.
- **`pullback_fallback_atr = 0.5`**: più largo della zona di pullback (0.3) ma non esagerato. Significa: "se il prezzo non è venuto a farmi del favore ma neanche è esploso via, entro lo stesso".

---

## 5. Architettura tecnica

### Componente nuovo: PullbackMonitor

Il sistema attuale è event-driven sulla chiusura 4H e poi il ciclo dorme. Per il pullback serve una **macchina a stati** separata che:

1. Viene attivata quando un segnale 4H scatta con impulso sufficiente
2. Tiene in memoria il "pending signal" con: direzione, prezzo di chiusura 4H, ATR al momento del segnale, timestamp di scadenza
3. Controlla ogni ciclo 15min se il prezzo è entrato nella zona di pullback o se il timeout è scaduto
4. Esegue l'entrata quando la condizione è soddisfatta
5. Cancella il pending signal se decade

### Schema della macchina a stati

```
IDLE
  │
  │ segnale 4H + impulso > soglia
  ▼
WAITING_PULLBACK
  ├── [ob_order_id presente] → ordine GTC HL attivo
  │     ├── ordine fillato → ENTERING → IDLE
  │     ├── timeout + price vicino → cancella ordine → fallback market → IDLE
  │     └── timeout + price lontano / break opposto → cancella ordine → IDLE (decay)
  │
  └── [ob_order_id assente] → monitoring passivo ATR-based
        ├── prezzo entra in zona → market order → IDLE
        ├── timeout + price nel fallback → market order → IDLE
        └── timeout + price fuori fallback → IDLE (decay)
```

### Dove gira il monitor

Non un processo separato — gira **dentro il loop principale di execution.py**, controllato dal `_cycle_count`. Il bot ha già un ciclo che si esegue ogni ~15 minuti (ogni 4 cicli da 4 ore, ma il timing interno è più granulare per il kill switch). Il PullbackMonitor si aggancia a questo ciclo esistente.

In modalità OB Limit Order, il ciclo 15min controlla lo stato dell'ordine HL tramite API (order status) invece di confrontare il prezzo corrente con una zona — il fill avviene direttamente sul broker, non richiede polling del mark price.

---

## 6. File da modificare

### `apps/api/services/execution.py`
- Aggiungere campo `_pending_pullback: Optional[PendingPullback]` all'`__init__`
- Aggiungere classe `PendingPullback` (dataclass o dict strutturato)
- Modificare `_cycle()`: se `pullback_entry_enabled` e la candela 4H ha chiuso con impulso > soglia → non aprire subito, impostare `_pending_pullback`
- Aggiungere `_check_pullback_entry()`: controlla se il pending signal deve essere eseguito o scaduto. Chiamato ogni ciclo 15min.
- Modificare `kill()`: cancellare `_pending_pullback` oltre alle posizioni aperte
- **Aggiungere tracciamento in `_execute_pullback_entry()`**: iniettare riga in `result.reasoning` e campo nel payload `trade_opened` (vedi §7 — Tracciamento)

### `apps/api/services/decision.py`
- Aggiungere `candle_range_atr_mult` nel `DecisionResult` o come campo separato nella risposta di `evaluate()`
- Questo valore viene calcolato già da `smc.py` tramite `atr_14` — serve solo esporlo

### `apps/api/main.py`
- Aggiungere i 5 nuovi campi al `BotConfig` pydantic model
- Aggiungere endpoint `GET /pullback/status` per mostrare il pending signal attivo nell'UI

### `apps/api/services/execution.py` — `BotEngineConfig`
- Aggiungere i 5 nuovi campi con defaults

### `apps/web/components/trading-hub/BotConfig.tsx`
- Aggiungere la sezione UI (vedi §9)

### `apps/web/components/trading-hub/Monitor.tsx`
- Mostrare il pending pullback signal se attivo (direzione, prezzo di ingresso target, scadenza)
- **Aggiornare `buildTradeNarrative()`**: parsare la riga `PullbackEntry:` in `entry_reasoning` e aggiungere frase narrativa dedicata (vedi §9 — Tracciamento UI)

---

## 7. Implementazione dettagliata — execution.py

### Struttura PendingPullback

```python
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Optional

@dataclass
class PendingPullback:
    direction:        str            # "long" | "short"
    close_4h:         float          # prezzo chiusura candela 4H che ha generato il segnale
    atr_at_signal:    float          # ATR_14 al momento del segnale (usato per tutte le zone)
    pullback_zone:    float          # close ± pullback_zone_atr × ATR (prezzo target entrata)
    fallback_limit:   float          # close ± fallback_atr × ATR (limite oltre cui decade)
    expires_at:       datetime       # timestamp di scadenza (ora segnale + pullback_window_h)
    decision_result:  object         # il DecisionResult originale — contiene size, SL, TP già calcolati
    # Campi OB Limit Order mode (None = modalità passive monitoring ATR-based)
    ob_order_id:      Optional[str]  = None   # oid dell'ordine GTC HL se piazzato
    ob_sl_price:      Optional[float] = None  # SL strutturale (appena fuori OB) per questa modalità
    created_at:       datetime = field(default_factory=lambda: datetime.now(timezone.utc))
```

### Logica in `_cycle()` — punto di intercettazione

```python
# Punto attuale dove il bot apre la posizione:
# if result.signal in ("long", "short") and not self._position:
#     await self._open_position(result, snap, atr, inference_id)

# Nuovo comportamento:
if result.signal in ("long", "short") and not self._position:
    candle_range = snap.get("candle_range", 0)  # high - low della candela 4H appena chiusa
    atr = snap.get("atr_14", 1)
    impulse_ratio = candle_range / atr if atr > 0 else 0

    if (self.config.pullback_entry_enabled
            and impulse_ratio >= self.config.pullback_impulse_atr_mult
            and self._pending_pullback is None):
        # Modalità pullback: non entrare subito, imposta il pending signal
        # Nota: await perché _create_pending_pullback può piazzare un ordine HL (async)
        self._pending_pullback = await self._create_pending_pullback(result, snap, atr)
        log.info(
            "Pullback mode: signal=%s impulse_ratio=%.2f (≥%.2f) — waiting for retracement "
            "to %.2f | fallback limit %.2f | expires %s",
            result.signal, impulse_ratio, self.config.pullback_impulse_atr_mult,
            self._pending_pullback.pullback_zone,
            self._pending_pullback.fallback_limit,
            self._pending_pullback.expires_at.strftime("%H:%M UTC"),
        )
    else:
        # Comportamento invariato: entry immediata
        await self._open_position(result, snap, atr, inference_id)
```

### `_create_pending_pullback()` — con piazzamento ordine HL

```python
async def _create_pending_pullback(self, result, snap, atr) -> PendingPullback:
    close = snap["close"]
    pb_dist = self.config.pullback_zone_atr * atr
    fb_dist = self.config.pullback_fallback_atr * atr
    expires = datetime.now(timezone.utc) + timedelta(hours=self.config.pullback_window_h)
    ob_order_id = None
    ob_sl_price = None
    sl_buffer = atr * 0.05  # piccolo buffer ATR per evitare stop-hunt sul livello esatto dell'OB

    if result.signal == "long":
        ob_top = snap.get("ob_bull_top_px")
        ob_bot = snap.get("ob_bull_bot_px")
        ob_active = snap.get("ob_bull_active", False)
        if ob_active and ob_top and ob_top < close:
            pullback_zone = ob_top
            # Modalità OB Limit Order: piazza GTC limit immediatamente
            try:
                ob_order_id = await self._place_ob_limit_order(
                    direction="long",
                    limit_px=ob_top,
                    size=result.size,
                )
                ob_sl_price = (ob_bot - sl_buffer) if ob_bot else (ob_top - sl_buffer * 4)
                log.info("OB limit order placed (long): oid=%s limit=%.2f sl=%.2f", ob_order_id, ob_top, ob_sl_price)
            except Exception as e:
                log.warning("OB limit order placement failed (non-blocking, falling back to passive): %s", e)
                ob_order_id = None
        else:
            pullback_zone = close - pb_dist
        fallback_limit = close + fb_dist  # prezzo sale troppo → decade

    else:  # short
        ob_bot = snap.get("ob_bear_bot_px")
        ob_top = snap.get("ob_bear_top_px")
        ob_active = snap.get("ob_bear_active", False)
        if ob_active and ob_bot and ob_bot > close:
            pullback_zone = ob_bot
            try:
                ob_order_id = await self._place_ob_limit_order(
                    direction="short",
                    limit_px=ob_bot,
                    size=result.size,
                )
                ob_sl_price = (ob_top + sl_buffer) if ob_top else (ob_bot + sl_buffer * 4)
                log.info("OB limit order placed (short): oid=%s limit=%.2f sl=%.2f", ob_order_id, ob_bot, ob_sl_price)
            except Exception as e:
                log.warning("OB limit order placement failed (non-blocking, falling back to passive): %s", e)
                ob_order_id = None
        else:
            pullback_zone = close + pb_dist
        fallback_limit = close - fb_dist  # prezzo scende troppo → decade

    return PendingPullback(
        direction=result.signal,
        close_4h=close,
        atr_at_signal=atr,
        pullback_zone=pullback_zone,
        fallback_limit=fallback_limit,
        expires_at=expires,
        decision_result=result,
        ob_order_id=ob_order_id,
        ob_sl_price=ob_sl_price,
    )
```

### `_place_ob_limit_order()` — wrapper HL GTC

```python
async def _place_ob_limit_order(self, direction: str, limit_px: float, size: float) -> str:
    """Piazza un ordine GTC limit su HL. Ritorna l'order ID (oid). Lancia eccezione in caso di errore."""
    side = "buy" if direction == "long" else "sell"
    resp = await self._hl_client.order(
        coin=self.config.symbol,
        is_buy=(side == "buy"),
        sz=size,
        limit_px=limit_px,
        order_type={"limit": {"tif": "Gtc"}},
        reduce_only=False,
    )
    # L'API HL restituisce {"status": "ok", "response": {"data": {"statuses": [{"resting": {"oid": N}}]}}}
    oid = resp["response"]["data"]["statuses"][0]["resting"]["oid"]
    return str(oid)
```

**Nota:** `_hl_client` è l'istanza `hyperliquid.exchange.Exchange` già presente in execution.py. Il metodo `order()` è l'API standard HL per piazzare ordini limite GTC. Verificare che il client usato nel codebase esponga questa interfaccia — se usa `asyncio`-wrapped calls adattare di conseguenza.

### `_check_pullback_entry()` — chiamato ogni ciclo

```python
async def _check_pullback_entry(self):
    """
    Controlla se il pending pullback signal deve essere eseguito o cancellato.
    Chiamato ogni ciclo dal loop principale.
    Gestisce due modalità: OB Limit Order (ob_order_id presente) e Passive Monitoring (ATR-based).
    """
    if self._pending_pullback is None or self._position:
        return

    pb = self._pending_pullback
    now = datetime.now(timezone.utc)
    price = await self._get_mark_price()

    # ── Modalità OB Limit Order ─────────────────────────────────────────
    if pb.ob_order_id is not None:
        # Controlla se l'ordine è stato fillato
        order_status = await self._get_order_status(pb.ob_order_id)

        if order_status == "filled":
            # L'ordine è stato eseguito da HL — registra il trade nel sistema interno
            log.info("OB limit order filled: oid=%s direction=%s", pb.ob_order_id, pb.direction)
            await self._register_ob_limit_fill(pb)
            return

        # Controlla se il prezzo ha violato il fallback limit (break opposto → decade subito)
        decay = (pb.direction == "long" and price > pb.fallback_limit) or \
                (pb.direction == "short" and price < pb.fallback_limit)
        if decay or now >= pb.expires_at:
            await self._cancel_ob_limit_order(pb.ob_order_id)
            if not decay:
                # Timeout: valuta fallback market order
                near_close = (pb.direction == "long" and price <= pb.fallback_limit) or \
                             (pb.direction == "short" and price >= pb.fallback_limit)
                if near_close:
                    log.info("OB limit order timeout — fallback market entry: price=%.2f", price)
                    await self._execute_pullback_entry(pb, use_atr_sl=True)
                    return
            log.info("OB limit order CANCELLED: oid=%s reason=%s", pb.ob_order_id,
                     "decay" if decay else "timeout+far")
            self._pending_pullback = None
        return

    # ── Modalità Passive Monitoring (ATR-based) ──────────────────────────
    direction = pb.direction

    # Condizione 1: il prezzo è tornato nella zona di pullback → entra
    if direction == "long" and price <= pb.pullback_zone:
        log.info("Pullback entry triggered (long): price=%.2f ≤ zone=%.2f", price, pb.pullback_zone)
        await self._execute_pullback_entry(pb)
        return

    if direction == "short" and price >= pb.pullback_zone:
        log.info("Pullback entry triggered (short): price=%.2f ≥ zone=%.2f", price, pb.pullback_zone)
        await self._execute_pullback_entry(pb)
        return

    # Condizione 2: timeout scaduto
    if now >= pb.expires_at:
        if direction == "long" and price <= pb.fallback_limit:
            log.info("Pullback fallback (long): price=%.2f still near close=%.2f", price, pb.close_4h)
            await self._execute_pullback_entry(pb)
        elif direction == "short" and price >= pb.fallback_limit:
            log.info("Pullback fallback (short): price=%.2f still near close=%.2f", price, pb.close_4h)
            await self._execute_pullback_entry(pb)
        else:
            log.info(
                "Pullback signal DECAYED: %s signal from %.2f, price now %.2f (too far)",
                direction, pb.close_4h, price
            )
            self._pending_pullback = None
```

### `_cancel_ob_limit_order()` — cancellazione sicura

```python
async def _cancel_ob_limit_order(self, oid: str):
    """Cancella l'ordine GTC HL. Non lancia eccezione se già fillato o inesistente."""
    try:
        await self._hl_client.cancel(coin=self.config.symbol, oid=int(oid))
        log.info("OB limit order cancelled: oid=%s", oid)
    except Exception as e:
        # Ordine già fillato o inesistente — non è un errore critico
        log.warning("Cancel OB limit order oid=%s failed (may already be filled): %s", oid, e)
```

### `_register_ob_limit_fill()` — registra il fill dell'ordine limit

```python
async def _register_ob_limit_fill(self, pb: PendingPullback):
    """
    Quando l'ordine GTC viene fillato da HL, registra il trade nel sistema interno.
    Lo SL è quello strutturale (ob_sl_price) calcolato al momento del piazzamento.
    Il TP rimane invariato dal DecisionResult originale.
    """
    snap = await self._get_current_snap()
    # Override SL con quello strutturale OB (pre-calcolato, più stretto)
    if pb.ob_sl_price is not None:
        pb.decision_result.stop_loss = pb.ob_sl_price

    # Inietta nota in reasoning per tracciamento
    pb.decision_result.reasoning.append(
        f"PullbackEntry: ob_limit_filled | signal_close={pb.close_4h:.2f} "
        f"limit_px={pb.pullback_zone:.2f} ob_sl={pb.ob_sl_price:.2f} oid={pb.ob_order_id}"
    )
    await self._open_position(pb.decision_result, snap, pb.atr_at_signal, pb.decision_result.inference_id)
    self._pending_pullback = None
```

### `_execute_pullback_entry()` — market order (passive monitoring + fallback)

```python
async def _execute_pullback_entry(self, pb: PendingPullback, use_atr_sl: bool = False):
    snap = await self._get_current_snap()
    actual_entry = snap["mark_price"]

    if use_atr_sl or pb.ob_sl_price is None:
        # Modalità ATR-based: rieancora lo SL all'entry reale mantenendo il multiplo ATR originale.
        # Così il dollar risk e la position size rimangono identici all'originale.
        # Il TP rimane invariato: è ancorato a struttura (OB opposto, swing), non all'entry price.
        sl_atr_mult = abs(pb.decision_result.stop_loss - pb.close_4h) / pb.atr_at_signal
        if pb.direction == "long":
            pb.decision_result.stop_loss = actual_entry - sl_atr_mult * pb.atr_at_signal
        else:
            pb.decision_result.stop_loss = actual_entry + sl_atr_mult * pb.atr_at_signal
        entry_mode = "pullback_market" if not use_atr_sl else "pullback_fallback_market"
    else:
        # Modalità OB fallback: usa lo SL strutturale OB pre-calcolato
        pb.decision_result.stop_loss = pb.ob_sl_price
        entry_mode = "ob_fallback_market"

    price_improvement = abs(pb.close_4h - actual_entry)
    pb.decision_result.reasoning.append(
        f"PullbackEntry: {entry_mode} | signal_close={pb.close_4h:.2f} "
        f"actual_entry={actual_entry:.2f} improvement={price_improvement:.2f} "
        f"impulse_ratio={abs(pb.close_4h - actual_entry) / pb.atr_at_signal:.2f}×ATR"
    )
    await self._open_position(pb.decision_result, snap, pb.atr_at_signal, pb.decision_result.inference_id)
    self._pending_pullback = None
```

### Tracciamento — `_execute_pullback_entry()`

Il sistema usa tre canali per tracciare il motivo di apertura di un trade: `result.reasoning[]` (visualizzato in "Perché Aperto"), l'evento `trade_opened` su Supabase, e i log di sistema. Il pullback entry deve essere tracciato in tutti e tre.

**1. Riga in `result.reasoning`** — iniettare prima di chiamare `_open_position()`:

```python
entry_mode = "pullback" if price < pb.close_4h else "pullback_fallback"
price_improvement = abs(pb.close_4h - actual_entry)
pb.decision_result.reasoning.append(
    f"PullbackEntry: {entry_mode} | signal_close={pb.close_4h:.2f} "
    f"actual_entry={actual_entry:.2f} improvement={price_improvement:.2f} "
    f"impulse_ratio={abs(pb.close_4h - actual_entry) / pb.atr_at_signal:.2f}×ATR"
)
```

Questa riga viene salvata automaticamente in `self._position["entry_reasoning"]`, scritta su `inference_logs.reasoning` in Supabase, e letta da `buildTradeNarrative()` nel frontend.

**2. Campo aggiuntivo nel payload `trade_opened`** — aggiungere a `_open_position()` tramite un campo opzionale `entry_meta` nel `DecisionResult`, oppure passando direttamente il dict extra all'evento già esistente:

```python
# Nel payload dell'evento trade_opened (execution.py, riga ~1470):
"entry_mode":        "pullback",          # o "pullback_fallback" o "immediate"
"signal_close_px":   pb.close_4h,
"actual_entry_px":   actual_entry,
"entry_improvement": price_improvement,
```

Questo rende filtrabile in Supabase la distinzione tra trade aperti con pullback vs immediati — utile per l'analisi retrospettiva.

**3. Log di sistema** — già presente nel piano (`log.info("Pullback entry triggered...")`). Nessuna modifica necessaria.

### Punto di chiamata in `_cycle()`

```python
# Aggiungere PRIMA della logica di apertura nuove posizioni:
await self._check_pullback_entry()
```

### Modifica `kill()`

```python
# Aggiungere all'inizio di kill():
if self._pending_pullback is not None:
    log.info("Kill switch: cancelling pending pullback signal (%s)", self._pending_pullback.direction)
    self._pending_pullback = None
```

---

## 8. Implementazione dettagliata — decision.py e risk.py

### decision.py — esportare candle_range_atr_mult

Il `DecisionResult` deve includere il rapporto range/ATR per permettere a execution.py di valutare il filtro impulso senza dover ricalcolarlo:

```python
# Nel DecisionResult (dataclass o dict):
candle_range_atr_mult: float = 0.0  # (high - low) / ATR_14 della candela appena chiusa
```

In `evaluate()`, aggiungere il calcolo:
```python
atr = float(row.get("atr_14", 1) or 1)
candle_range = float(row.get("high", 0)) - float(row.get("low", 0))
result.candle_range_atr_mult = candle_range / atr if atr > 0 else 0.0
```

### risk.py — nessuna modifica necessaria

SL e TP vengono calcolati usando l'ATR al momento del segnale 4H originale (`pb.atr_at_signal`). Questo è **corretto**: il sizing del rischio è basato sulla struttura della candela che ha generato il segnale, non sul prezzo di entrata del pullback. Non modificare risk.py.

> **Nota importante:** il prezzo di entrata sarà diverso (migliore) da quello originale, quindi il R:R effettivo sarà migliore del previsto — è esattamente il vantaggio cercato.

---

## 9. UI — BotConfig.tsx

### Sezione da aggiungere

Posizionare **dopo la sezione "1H Gate"** e prima di "Feature Importance Pruning", come sezione `Section` separata con toggle master.

```
Section: "Pullback Entry — Timing Ottimizzato"
  ├── Toggle master: use_pullback_entry (default OFF)
  │
  └── [visibile solo se attivo]
      ├── Slider: impulse_atr_mult (1.0–3.0, step 0.1)
      │   Tooltip: "La candela 4H deve essersi mossa almeno N×ATR per attivare l'attesa del pullback.
      │            Valore 1.5 = top ~25% delle candele per ampiezza. Default: 1.5"
      │
      ├── Slider: pullback_zone_atr (0.1–1.0, step 0.05)
      │   Tooltip: "Distanza dalla chiusura 4H (in multipli di ATR) entro cui il prezzo
      │            deve ritornare per triggherare l'entrata. Default: 0.3"
      │
      ├── Slider: pullback_window_h (1–8 ore, step 1)
      │   Tooltip: "Finestra temporale massima di attesa. Dopo questo timeout si applica
      │            il fallback. Corrisponde alle prime N candele 1H. Default: 3"
      │
      ├── Slider: fallback_atr (0.2–2.0, step 0.1)
      │   Tooltip: "Se il pullback non arriva, entra comunque se il prezzo è ancora entro
      │            N×ATR dalla chiusura 4H. Oltre questo limite il segnale decade. Default: 0.5"
      │
      └── Info box: mostra pending signal attivo se presente
          "⏳ Short pending — target pullback: $XXX | scade alle 14:00 UTC"
```

### Monitor.tsx — aggiunta pending signal

Nella sezione "Stato Bot" del Monitor, aggiungere un badge visibile quando c'è un pending pullback:

```
🎯 SHORT pendente · target $XXX · scade 14:00 UTC · [Cancella]
```

Il bottone "Cancella" chiama `POST /pullback/cancel` (endpoint da aggiungere in main.py).

### Monitor.tsx — tracciamento in "Perché Aperto" e narrativa

**Aggiornare `buildTradeNarrative()`** per parsare la riga `PullbackEntry:` da `entry_reasoning` e aggiungere una frase narrativa dedicata:

```typescript
// In buildTradeNarrative(), dopo il blocco RSI/ExhaustionGuard:
const pullbackLine = lines.find(l => l.startsWith('PullbackEntry:'));
if (pullbackLine) {
  const mMode        = pullbackLine.match(/entry_mode=(\w+)/);        // non presente nel formato attuale
  const mSignal      = pullbackLine.match(/signal_close=([\d.]+)/);
  const mActual      = pullbackLine.match(/actual_entry=([\d.]+)/);
  const mImprovement = pullbackLine.match(/improvement=([\d.]+)/);
  const isFallback   = pullbackLine.includes('pullback_fallback');

  if (mSignal && mActual && mImprovement) {
    const signalPx = parseFloat(mSignal[1]);
    const actualPx = parseFloat(mActual[1]);
    const improv   = parseFloat(mImprovement[1]);
    if (isFallback) {
      p += `Il segnale era stato generato alla chiusura della candela 4H a **$${signalPx.toLocaleString()}**, ma il prezzo non ha eseguito il pullback atteso. Il bot ha atteso la finestra di ${isLong ? 'ritracciamento' : 'rimbalzo'} e, scaduto il timeout, ha verificato che il prezzo fosse ancora abbastanza vicino al livello di segnale — entrando via **fallback pullback** a **$${actualPx.toLocaleString()}**. `;
    } else {
      p += `Il segnale era stato generato alla chiusura della candela 4H a **$${signalPx.toLocaleString()}**, ma il bot ha atteso un ${isLong ? 'ritracciamento' : 'rimbalzo tecnico'} per migliorare il prezzo di entrata. Il prezzo è tornato nella zona attesa e il trade è stato aperto a **$${actualPx.toLocaleString()}** — **$${improv.toLocaleString()} più favorevole** rispetto all'entry immediata, migliorando strutturalmente il rapporto rischio/rendimento. `;
    }
  }
}
```

**Aggiornare il blocco raw `entry_reasoning`** (lista righe sotto "Perché Aperto") per evidenziare la riga `PullbackEntry:` con uno stile visivo distinto — es. colore indigo invece del grigio standard — così è immediatamente riconoscibile nella card.

---

## 10. Checklist pre-implementazione

Prima di iniziare a scrivere codice, verificare che queste condizioni siano soddisfatte:

- [ ] **Almeno 60 trade live chiusi** nel DB con entry price, exit price, inference_id
- [ ] **Analisi retrospettiva completata**: su quanti dei trade passati c'era un impulso > 1.5×ATR? Quanti avrebbero beneficiato del pullback? (query SQL su `trades` + `inference_logs`)
- [ ] **Drift detection validata**: il sistema deve già rilevare cambi di regime prima di aggiungere logica di timing
- [ ] **Optuna tuning eseguito almeno una volta**: parametri LightGBM ottimizzati prima di aggiungere complessità
- [ ] **Il bot ha girato in paper almeno 30 giorni consecutivi senza crash**: stabilità operativa verificata

---

## 11. Come validare che funziona

### Test A/B su paper trading

La validazione corretta è eseguire due istanze in paper trading in parallelo per 4-8 settimane:
- **Istanza A**: sistema attuale (entry immediata)
- **Istanza B**: sistema con pullback entry abilitato

Confrontare:
- `avg_entry_price_improvement`: miglioramento medio del prezzo di entrata (in ATR) sui segnali con impulso
- `win_rate`: deve essere uguale o migliore (stesso segnale, timing migliore)
- `avg_rr_realized`: R:R effettivo medio (deve migliorare)
- `missed_trade_rate`: % segnali decaduti (deve essere < 25%, altrimenti i parametri sono troppo restrittivi)
- `fallback_rate`: % segnali entrati via fallback (deve essere 30-60% — se troppo alto i parametri non funzionano, se troppo basso il fallback è inutile)

### Query SQL per analisi retrospettiva (da eseguire prima)

```sql
-- Segnali con impulso forte (candela range > 1.5×ATR)
-- Richiede che inference_logs abbia i campi atr_14, high, low della candela
SELECT
    t.id,
    t.direction,
    t.entry_price,
    t.exit_price,
    t.pnl_usd,
    il.candle_range / NULLIF(il.atr_14, 0) AS impulse_ratio,
    il.c2_dir_prob
FROM trades t
JOIN inference_logs il ON t.inference_id = il.id
WHERE il.candle_range / NULLIF(il.atr_14, 0) >= 1.5
ORDER BY t.created_at DESC;
```

---

## 12. Rischi e controindicazioni

### Rischio 1 — Missed trades in breakout violento
In un breakout fortemente direzionale (es. news macro, liquidation cascade), il prezzo non pullbacka. Il bot aspetta 3 ore, il fallback non scatta perché il prezzo è già troppo lontano, il segnale decade. In questi casi il sistema attuale è superiore.

**Mitigazione**: il `fallback_atr = 0.5` è intenzionalmente largo per catturare almeno parte di questi casi. Se il `missed_trade_rate` su breakout forti è > 30%, abbassare `pullback_impulse_atr_mult` per essere meno selettivi.

### Rischio 2 — Doppio segnale nella stessa candela
Se il bot ha un pending pullback long e arriva un nuovo segnale short sulla candela successiva, cosa succede? La logica deve cancellare il pending e gestire il conflitto.

**Gestione**: se scatta un nuovo segnale in direzione opposta mentre c'è un pending, cancellare il pending. Se scatta lo stesso segnale, ignorarlo (pending già attivo). Implementare in `_cycle()` come guardia esplicita.

### Rischio 3 — Parametri mal calibrati producono overfitting
I valori di default sono basati su ragionamento teorico, non su ottimizzazione empirica. Con dati insufficienti, ottimizzarli produrrà overfitting. 

**Mitigazione**: non toccare i default per i primi 60 giorni di utilizzo. Solo dopo, confrontare i valori teorici con l'analisi retrospettiva dei trade reali.

### Rischio 4a — Ordine limit non cancellato correttamente (OB Limit Order mode)

**Problema:** la cancellazione dell'ordine HL può fallire (timeout API, ordine già fillato durante il cancel). Se l'ordine viene fillato mentre il bot sta cercando di cancellarlo (race condition), il bot non sa che ha una posizione aperta su HL senza averla registrata internamente.

**Mitigazione strutturale:** `_cancel_ob_limit_order()` cattura le eccezioni senza far crashare il bot, ma in caso di errore il bot deve riconciliare lo stato interno con HL al ciclo successivo. Il sistema ha già un meccanismo di riconciliazione posizioni (`_sync_position()` chiamato ogni ciclo) — verificare che gestisca correttamente il caso "posizione aperta su HL non presente in `_position`". Se non lo fa, questo è il punto da estendere prima di implementare la modalità OB Limit Order.

### Rischio 4b — Fill parziale sull'ordine limit

**Problema:** se la liquidità a `ob_bull_top_px` è insufficiente, l'ordine può essere fillato parzialmente. Il sistema interno non sa gestire position size parziali se `_open_position()` non è progettato per entrate scaglionate.

**Mitigazione:** usare TIF `Alo` (post-only) invece di `Gtc` se il mercato è thin, oppure accettare il fill parziale come full fill (la differenza in USD è marginale per size tipiche del bot). In alternativa, cancellare l'ordine parzialmente fillato e aprire la parte rimanente con market order — logica aggiuntiva da valutare solo se i fill parziali diventano frequenti.

### Rischio 4 — SL disallineato su entrata ritardata

**Problema:** `risk.py` calcola lo SL relativo a `close_4h` al momento del segnale. Se l'entrata avviene sul pullback (prezzo diverso da `close_4h`), la distanza entry→SL cambia implicitamente, alterando dollar risk e position size senza che il sistema se ne accorga.

Esempio con `close_4h = $100.000`, `ATR = $500`, `sl_mult = 1.5`:
- SL originale = `$99.250` (distanza $750 = 1.5×ATR da `close_4h`)
- Entry sul pullback = `$99.850` (0.3×ATR sotto)
- Distanza effettiva entry→SL = `$600` = 1.2×ATR → profilo di rischio silenziosamente alterato

Nel caso limite (`pullback_zone_atr ≥ sl_mult`), il prezzo di pullback potrebbe toccare o superare il livello di SL originale — SL già violato al momento dell'entrata.

**Soluzione — Approccio C: rieancoraggio con multiplo ATR invariato**

Esprimi lo SL originale come multiplo di ATR, poi ricalcolalo dall'entry reale con lo stesso multiplo. Implementato in `_execute_pullback_entry()`:

```python
sl_atr_mult = abs(pb.decision_result.stop_loss - pb.close_4h) / pb.atr_at_signal
if pb.direction == "long":
    pb.decision_result.stop_loss = actual_entry - sl_atr_mult * pb.atr_at_signal
else:
    pb.decision_result.stop_loss = actual_entry + sl_atr_mult * pb.atr_at_signal
```

**Proprietà garantite:**
- Dollar risk invariato: `sl_dist_dollars = sl_atr_mult × atr_at_signal` identico all'originale
- Position size invariata: `size = dollar_risk / sl_dist_dollars` — nessuna modifica necessaria a risk.py
- Zero edge cases: SL è sempre a distanza piena dall'entry reale, indipendentemente dalla profondità del pullback
- TP invariato: ancorato a struttura (OB opposto, swing level), non dipende dall'entry price — il R:R effettivo migliora automaticamente proporzionalmente al miglioramento dell'entry

**Tradeoff accettato:** il livello di SL si sposta di al massimo `pullback_zone_atr × ATR` rispetto all'originale (es. 0.3×ATR = $150 nell'esempio). Per i casi con SL strutturale (OB, FVG), questo può disallineare leggermente il livello dall'ancora originale. Con `pullback_zone_atr ≤ 0.5`, lo shift è trascurabile rispetto alla granularità della struttura di mercato.

---

## Riepilogo dei parametri da aggiungere al config

```python
# execution.py — BotEngineConfig.__init__()
self.pullback_entry_enabled     = kw.get("pullback_entry_enabled",     False)
self.pullback_impulse_atr_mult  = kw.get("pullback_impulse_atr_mult",  1.5)
self.pullback_zone_atr          = kw.get("pullback_zone_atr",          0.3)
self.pullback_window_h          = kw.get("pullback_window_h",          3)
self.pullback_fallback_atr      = kw.get("pullback_fallback_atr",      0.5)
```

```python
# main.py — BotConfig pydantic model
pullback_entry_enabled:     bool  = Field(False)
pullback_impulse_atr_mult:  float = Field(1.5,  ge=1.0, le=3.0)
pullback_zone_atr:          float = Field(0.3,  ge=0.1, le=1.0)
pullback_window_h:          int   = Field(3,    ge=1,   le=8)
pullback_fallback_atr:      float = Field(0.5,  ge=0.2, le=2.0)
```

---

*Piano redatto il 2026-05-28. Revisione 2026-05-29 (1): Rischio 4 aggiornato con soluzione definitiva (Approccio C — rieancoraggio SL con multiplo ATR invariato) e implementazione corretta di `_execute_pullback_entry()`. Revisione 2026-05-29 (2): aggiunto §7 Tracciamento e aggiornato §6 e §9 — il pullback entry viene ora tracciato nei tre canali del sistema: `result.reasoning[]` / "Perché Aperto", evento `trade_opened` su Supabase con campi `entry_mode`/`signal_close_px`/`actual_entry_px`/`entry_improvement`, e `buildTradeNarrative()` con frase narrativa dedicata per entrata pullback e fallback. Revisione 2026-06-03: integrata modalità **OB Limit Order** — quando un Order Block è attivo nella direzione del trade, il bot piazza immediatamente un ordine GTC limit su HL al livello esatto dell'OB invece di monitorare passivamente il prezzo. SL strutturale (appena sotto/sopra il bordo dell'OB) invece di ATR-based. Nuovi metodi: `_place_ob_limit_order()`, `_cancel_ob_limit_order()`, `_register_ob_limit_fill()`. `_create_pending_pullback()` diventa async. `PendingPullback` esteso con `ob_order_id` e `ob_sl_price`. Aggiunti Rischi 4a (race condition cancel/fill) e 4b (fill parziale). La modalità passive monitoring ATR-based rimane come fallback quando non c'è OB attivo.*
