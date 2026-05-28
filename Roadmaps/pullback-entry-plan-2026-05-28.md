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
         Definisci "pullback zone":
           Long: [close - pullback_atr × ATR_14 , close]
           Short: [close , close + pullback_atr × ATR_14]
              │
              ├── Prezzo entra nella zona entro pullback_window_h ore →
              │   entra full size al prezzo corrente
              │
              ├── Prezzo NON entra nella zona MA
              │   |close_attuale - close_4H| ≤ fallback_atr × ATR_14
              │   dopo pullback_window_h ore →
              │   entra full size (fallback — prezzo ancora vicino)
              │
              └── Prezzo si è allontanato > fallback_atr × ATR_14 →
                  segnale decade, nessun trade
```

### Principio chiave: tutto in ATR, non in percentuale fissa

I parametri sono espressi in multipli di `ATR_14` — non in percentuale. Questo li rende adattativi alla volatilità: in periodi di alta volatilità (ATR grande) la zona di attesa è proporzionalmente più ampia, in periodi di bassa volatilità è più stretta. Una percentuale fissa del 2% ha significato diverso quando BTC è a 30k vs 100k, e cambia completamente tra regime calmo e regime esplosivo.

### Cosa NON fa questa logica

- Non entra a scaglioni (50%+50%) — valutato e scartato per eccessiva complessità con dataset piccolo e problemi di gestione SL su posizioni parziali
- Non monitora pattern 1H interni alla candela — il segnale rimane interamente derivato dalla 4H
- Non modifica il SL/TP — rimangono invariati rispetto alla logica attuale

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
  │
  ├── prezzo entra in zona pullback → ENTERING → IDLE
  │
  ├── timeout scaduto + prezzo nel fallback → ENTERING → IDLE
  │
  └── timeout scaduto + prezzo fuori fallback → IDLE (decay)
```

### Dove gira il monitor

Non un processo separato — gira **dentro il loop principale di execution.py**, controllato dal `_cycle_count`. Il bot ha già un ciclo che si esegue ogni ~15 minuti (ogni 4 cicli da 4 ore, ma il timing interno è più granulare per il kill switch). Il PullbackMonitor si aggancia a questo ciclo esistente.

---

## 6. File da modificare

### `apps/api/services/execution.py`
- Aggiungere campo `_pending_pullback: Optional[PendingPullback]` all'`__init__`
- Aggiungere classe `PendingPullback` (dataclass o dict strutturato)
- Modificare `_cycle()`: se `pullback_entry_enabled` e la candela 4H ha chiuso con impulso > soglia → non aprire subito, impostare `_pending_pullback`
- Aggiungere `_check_pullback_entry()`: controlla se il pending signal deve essere eseguito o scaduto. Chiamato ogni ciclo 15min.
- Modificare `kill()`: cancellare `_pending_pullback` oltre alle posizioni aperte

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

---

## 7. Implementazione dettagliata — execution.py

### Struttura PendingPullback

```python
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Optional

@dataclass
class PendingPullback:
    direction:        str      # "long" | "short"
    close_4h:         float    # prezzo chiusura candela 4H che ha generato il segnale
    atr_at_signal:    float    # ATR_14 al momento del segnale (usato per tutte le zone)
    pullback_zone:    float    # close ± pullback_zone_atr × ATR (prezzo target entrata)
    fallback_limit:   float    # close ± fallback_atr × ATR (limite oltre cui decade)
    expires_at:       datetime # timestamp di scadenza (ora segnale + pullback_window_h)
    decision_result:  object   # il DecisionResult originale — contiene size, SL, TP già calcolati
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
        self._pending_pullback = self._create_pending_pullback(result, snap, atr)
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

### `_create_pending_pullback()`

```python
def _create_pending_pullback(self, result, snap, atr) -> PendingPullback:
    close = snap["close"]
    pb_dist = self.config.pullback_zone_atr * atr
    fb_dist = self.config.pullback_fallback_atr * atr
    expires = datetime.now(timezone.utc) + timedelta(hours=self.config.pullback_window_h)

    if result.signal == "long":
        pullback_zone = close - pb_dist   # prezzo scende a questo livello → entro long
        fallback_limit = close + fb_dist  # prezzo sale oltre → decade (si è allontanato)
    else:  # short
        pullback_zone = close + pb_dist   # prezzo sale a questo livello → entro short
        fallback_limit = close - fb_dist  # prezzo scende oltre → decade

    return PendingPullback(
        direction=result.signal,
        close_4h=close,
        atr_at_signal=atr,
        pullback_zone=pullback_zone,
        fallback_limit=fallback_limit,
        expires_at=expires,
        decision_result=result,
    )
```

### `_check_pullback_entry()` — chiamato ogni ciclo

```python
async def _check_pullback_entry(self):
    """
    Controlla se il pending pullback signal deve essere eseguito o cancellato.
    Chiamato ogni ciclo dal loop principale.
    """
    if self._pending_pullback is None or self._position:
        return

    pb = self._pending_pullback
    now = datetime.now(timezone.utc)
    current_price = await self._get_mark_price()  # già esiste nel codebase

    direction = pb.direction
    price = current_price

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

async def _execute_pullback_entry(self, pb: PendingPullback):
    """Esegue l'entrata usando il DecisionResult originale e cancella il pending."""
    snap = await self._get_current_snap()  # snapshot attuale per prezzo e metriche
    await self._open_position(pb.decision_result, snap, pb.atr_at_signal, pb.decision_result.inference_id)
    self._pending_pullback = None
```

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

### Rischio 4 — Complessità di gestione del SL su entrata ritardata
Il SL viene calcolato da `risk.py` al momento del segnale 4H originale, non al momento dell'entrata del pullback. Se il prezzo del pullback è significativamente diverso dal prezzo di chiusura 4H, il SL potrebbe risultare troppo stretto (per long: se il prezzo è sceso al pullback, lo stop calcolato sull'ATR originale potrebbe essere sotto il pullback stesso).

**Soluzione**: in `_execute_pullback_entry()`, ricalcolare il SL usando il prezzo di entrata effettivo del pullback, non quello della chiusura 4H. Usare comunque `pb.atr_at_signal` per le distanze, ma ancorare al nuovo prezzo di entrata.

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

*Piano redatto il 2026-05-28 sulla base di analisi approfondita della meccanica di mercato e dell'architettura attuale del sistema. Da revisionare prima dell'implementazione sulla base dei dati live accumulati.*
