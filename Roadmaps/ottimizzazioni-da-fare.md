# Ottimizzazioni da Fare

Elenco di modifiche dettagliate da implementare. Aggiungere nuove voci in fondo.

---

## 1. Pulsante "Forza Retrain" in Bot Config

**Priorità:** Alta  
**File coinvolti:**
- `apps/api/main.py` — aggiungere endpoint `POST /retrain`
- `apps/web/components/trading-hub/BotConfig.tsx` — aggiungere pulsante UI

**Descrizione:**  
Aggiungere un pulsante in Bot Config che triggera manualmente il retraining di LightGBM senza dover aspettare i 120 cicli automatici. Utile prima di avviare il bot dopo un periodo di inattività, così il modello è aggiornato alle condizioni di mercato recenti.

**Comportamento atteso:**
- Il pulsante chiama `POST /retrain` sul backend
- Il backend triggera `LGBMTrainer.retrain()` in background (non blocca l'UI)
- Mentre il retrain è in corso, il pulsante mostra uno spinner e diventa disabilitato
- Al termine, mostra le metriche risultanti: OOS accuracy, log loss, numero di righe usate, tempo impiegato
- Se il bot è già in retrain automatico, risponde con `status: busy` e lo comunica all'utente
- Il modello aggiornato viene caricato automaticamente in memoria senza riavviare il server

**Note implementative:**
- L'endpoint `POST /retrain` deve chiamare `_retrain_background()` o direttamente `LGBMTrainer.retrain()`
- Usare polling o SSE per restituire il risultato asincrono all'UI (il retrain dura ~10-30s)
- Alternativa più semplice: il pulsante fa il POST, il frontend aspetta la risposta sincrona (timeout 60s)
- Il pulsante va posizionato nella sezione LightGBM di Bot Config, vicino alle impostazioni del modello
- Aggiungere timestamp "Ultimo retrain:" accanto al pulsante, letto dallo stato del bot

---

## 2. Live Trade Monitor — P&L e andamento in tempo reale (tab Monitor)

**Priorità:** Alta  
**File coinvolti:**
- `apps/api/services/execution.py` — esporre `mark_price` nel metodo `get_status()`
- `apps/api/main.py` — aggiungere endpoint SSE `GET /position/stream` per mark price live
- `apps/web/components/trading-hub/Monitor.tsx` — sostituire la card "Posizione Aperta" esistente con una card avanzata real-time

---

### Contesto attuale

Il Monitor ha già una sezione "Posizione Aperta" (righe 276–303 di `Monitor.tsx`) che mostra:
- Side, Entry, Stop Loss, Take Profit, Size USD, Size Contracts, durata in ore

Manca tutto il lato dinamico: il P&L viene calcolato come `unrealizedPnl = 0 // placeholder — would need live price` (riga 180 di Monitor.tsx). Il polling è ogni 15 secondi e non include il prezzo corrente di mercato.

Il backend ha già in `self._position` tutti i campi necessari (`bars_held`, `high_water`, `sl_trailing_active`, `be_sl_applied`, `partial_done`, `lgbm_strikes`) ma non li espone nell'interfaccia `BotStatus` del frontend.

---

### Modifiche backend

**1. Aggiungere `mark_price` a `get_status()` in `execution.py`**

Il WebSocket (`self._ws`) mantiene il prezzo corrente in memoria. Aggiungerlo al dict restituito da `get_status()`:
```python
"mark_price": self._ws.last_price if self._ws.is_connected else None,
```

**2. Esporre tutti i campi della posizione**

Aggiornare l'interfaccia `BotStatus` nel frontend per includere i campi già presenti nel dict `self._position`:
- `bars_held` — quante candele 4h il trade è aperto
- `high_water` — massimo/minimo dal quale parte il trailing SL
- `sl_trailing_active` — se il trailing SL è attivo
- `be_sl_applied` — se il breakeven è già scattato
- `partial_done` — se il take profit parziale è già stato eseguito
- `lgbm_strikes` — quanti segnali contrari ha accumulato il bot (per exit LGBM)

**3. SSE per mark price in tempo reale (opzionale, fase 2)**

Aggiungere `GET /position/stream` che emette un evento SSE ogni secondo con:
```json
{ "mark_price": 79050.0, "unrealized_pnl": 142.30, "unrealized_pct": 0.93 }
```
Questo endpoint legge `self._ws.last_price` e calcola il P&L in tempo reale. Se non c'è una posizione aperta, restituisce un heartbeat vuoto.

---

### Modifiche frontend (`Monitor.tsx`)

**1. Aggiornare interfaccia `BotStatus`**

```typescript
interface BotStatus {
  // ... campi esistenti ...
  mark_price: number | null;
  position: null | {
    side: string;
    entry_price: number;
    stop_loss: number;
    take_profit: number;
    size_usd: number;
    size_contracts: number;
    opened_at: string;
    bars_held: number;
    high_water: number;
    sl_trailing_active: boolean;
    be_sl_applied: boolean;
    partial_done: boolean;
    lgbm_strikes: number;
  };
}
```

**2. Calcolo P&L client-side**

Con `mark_price` disponibile nel status, il P&L non ha bisogno di SSE dedicato:
```typescript
const markPrice = status?.mark_price ?? null;
const pos = status?.position;
if (pos && markPrice) {
  const direction = pos.side === 'long' ? 1 : -1;
  unrealizedPnl = direction * (markPrice - pos.entry_price) * pos.size_contracts;
  unrealizedPct = (unrealizedPnl / pos.size_usd) * 100;
  distToSL = Math.abs(markPrice - pos.stop_loss);
  distToTP = Math.abs(pos.take_profit - markPrice);
  distToSLPct = (distToSL / markPrice) * 100;
  distToTPPct = (distToTP / markPrice) * 100;
  riskReward = distToTP / distToSL;
}
```

**3. Polling accelerato quando c'è una posizione aperta**

Cambiare l'intervallo di polling da 15s a 5s quando `status?.position != null`:
```typescript
const pollInterval = status?.position ? 5_000 : 15_000;
```

**4. Nuova "Live Trade Card" — layout proposto**

Sostituire la card statica attuale con una card più ricca, divisa in sezioni:

```
┌─────────────────────────────────────────────────────────┐
│  POSIZIONE APERTA · BTC LONG              Aperta 8.2h   │
│  ● LIVE                                                  │
├─────────────────────────────────────────────────────────┤
│                                                          │
│  P&L Non Realizzato                                      │
│  +$312.40          +2.08%          ↑ In guadagno         │
│                                                          │
├───────────────┬──────────────┬──────────────────────────┤
│  Mark Price   │  Entry       │  R:R attuale             │
│  $79,050      │  $77,420     │  1 : 2.4                 │
├───────────────┴──────────────┴──────────────────────────┤
│  Stop Loss ←——————●————————————————→ Take Profit        │
│  $75,800          $79,050           $82,500              │
│  [███████████████████░░░░░░░░░░░░░░░]                    │
│  Distanza SL: -$3,250 (-4.1%)    Distanza TP: +$3,450   │
├─────────────────────────────────────────────────────────┤
│  Barre aperte: 2 × 4h   │  Trailing SL: Attivo          │
│  Breakeven: Applicato   │  Partial TP: Non eseguito     │
│  LGBM Strikes: 0/3      │                               │
└─────────────────────────────────────────────────────────┘
```

- La barra orizzontale SL→TP mostra visivamente dove si trova il prezzo corrente rispetto ai livelli di uscita
- Il P&L in cima è il dato più importante: grande, colorato verde/rosso
- I badge in basso mostrano lo stato della gestione del trade (trailing, breakeven, partial TP)
- `LGBM Strikes` mostra quanti segnali contrari ha accumulato il modello prima dell'exit forzata

---

### Ordine di implementazione consigliato

1. Aggiungere `mark_price` a `get_status()` nel backend — 2 righe
2. Aggiornare interfaccia `BotStatus` nel frontend con tutti i campi posizione
3. Calcolare P&L, distanze e R:R client-side
4. Ridisegnare la card "Posizione Aperta" con il nuovo layout
5. Accelerare polling a 5s quando posizione aperta
6. (Fase 2 opzionale) Aggiungere SSE `/position/stream` per aggiornamento al secondo senza polling

---

## 3. Gestione Partial TP e Trailing SL — visibilità completa in Monitor, TradeLog e Telegram

**Priorità:** Alta  
**Dipende da:** Ottimizzazione #2 (Live Trade Monitor) — va implementata subito dopo o in parallelo  
**File coinvolti:**
- `apps/api/services/execution.py` — arricchire `self._position`, emettere eventi su Supabase ad ogni cambio SL/TP
- `apps/api/services/notifications.py` — aggiungere 3 nuovi metodi Telegram dedicati
- `apps/api/main.py` — aggiungere endpoint `GET /trade-events`
- `apps/web/components/trading-hub/Monitor.tsx` — estendere Live Trade Card (ottimizzazione #2)
- `apps/web/components/trading-hub/TradeLog.tsx` — aggiungere sezione "legs" espandibile per ogni trade

---

### Contesto attuale e gap identificati

**In `execution.py`:**
- `partial_tp_price` (il prezzo esatto a cui scatta il primo TP) viene calcolato inline durante ogni ciclo ma NON salvato in `self._position` → il frontend non può mostrarlo prima che avvenga
- `trailing_sl_dist` (distanza fissa del trailing) non è salvata nella posizione
- Quando il trailing SL si sposta (righe 703–704, 708–709): solo `log.info()`, nessun evento Supabase, nessuna notifica Telegram
- Quando scatta il breakeven SL (righe 716–721): solo aggiornamento del dict, nessun evento, nessuna notifica
- Il partial TP usa `send_trade_closed()` per notificare (sbagliato — non è una chiusura)
- Nessuna tabella `trade_events` in Supabase → impossibile ricostruire la storia di un trade

**In `notifications.py`:**
- Mancano: `send_partial_tp()`, `send_sl_moved()`, `send_breakeven_sl()`

**In `TradeLog.tsx`:**
- L'interfaccia `Trade` non ha campi per eventi/legs del trade
- Non c'è endpoint `/trade-events` per leggerli

---

### Modifiche backend — `execution.py`

**1. Salvare i valori calcolati in `self._position` al momento dell'apertura**

Nel metodo `_open_position()`, dopo aver calcolato SL e TP, aggiungere:
```python
entry_atr = atr  # già disponibile
self._position["entry_atr"]       = entry_atr
self._position["partial_tp_price"] = (
    price + self.config.partial_tp_atr_mult * entry_atr if result.action == "long"
    else price - self.config.partial_tp_atr_mult * entry_atr
) if self.config.partial_tp_enabled else None
self._position["trailing_sl_dist"] = (
    self.config.trailing_sl_activation * entry_atr
) if self.config.trailing_sl_enabled else None
self._position["trailing_sl_activation_price"] = (
    price + self.config.trailing_sl_activation * entry_atr if result.action == "long"
    else price - self.config.trailing_sl_activation * entry_atr
) if self.config.trailing_sl_enabled else None
self._position["sl_original"]     = params.stop_loss  # SL iniziale mai modificato
self._position["tp2_price"]       = params.take_profit  # TP finale (secondo)
```

**2. Emettere eventi Supabase ad ogni cambio SL**

Aggiungere una funzione helper `_emit_trade_event(kind, payload)` che inserisce in una nuova tabella `trade_events`:

```python
async def _emit_trade_event(self, kind: str, payload: dict):
    try:
        db = get_supabase()
        db.table("trade_events").insert({
            "trade_id":   self._position.get("trade_id"),
            "kind":       kind,          # "sl_moved", "be_sl", "partial_tp", "tp2_hit", "sl_hit"
            "payload":    payload,
            "time":       datetime.now(timezone.utc).isoformat(),
        }).execute()
    except Exception as e:
        log.warning("trade_event insert failed: %s", e)
```

Chiamarla nei punti chiave:

- **Trailing SL move** (dopo riga 704 e 709):
```python
await self._emit_trade_event("sl_moved", {
    "sl_old": old_sl, "sl_new": new_sl,
    "high_water": self._position["high_water"],
    "current_price": current_price,
    "reason": "trailing",
})
await self._notifier.send_sl_moved(
    side, SYMBOL, old_sl=old_sl, new_sl=new_sl,
    high_water=self._position["high_water"], reason="trailing"
)
```

- **Breakeven SL** (dopo riga 717 e 721):
```python
await self._emit_trade_event("be_sl", {
    "sl_new": entry, "current_price": current_price
})
await self._notifier.send_breakeven_sl(side, SYMBOL, entry_price=entry)
```

- **Partial TP** (sostituire `send_trade_closed()` con):
```python
await self._emit_trade_event("partial_tp", {
    "price": current_price, "pct_closed": self.config.partial_tp_pct,
    "pnl_usd": pnl_usd_p, "pnl_pct": pnl_pct_p,
    "remaining_usd": self._position["size_usd"],
    "remaining_contracts": self._position["size_contracts"],
    "new_sl": self._position["stop_loss"],
})
await self._notifier.send_partial_tp(
    side=side, symbol=SYMBOL,
    pct=self.config.partial_tp_pct, price=current_price,
    pnl_usd=pnl_usd_p, pnl_pct=pnl_pct_p,
    remaining_usd=self._position["size_usd"],
    new_sl=self._position["stop_loss"],
)
```

**3. Salvare `trade_id` nella posizione**

Al momento dell'apertura, il bot inserisce già un record nella tabella `trades`. Recuperare l'ID generato e salvarlo in `self._position["trade_id"]` per collegare gli eventi al trade corretto.

---

### Modifiche backend — `notifications.py`

Aggiungere tre nuovi metodi:

**`send_partial_tp()`**
```
⚡ PARTIAL TP ESEGUITO — LONG BTC

Eseguito:   50% @ $79,400
PnL leg 1:  +$142.30 (+1.84%)
Restante:   $750 (0.0094 BTC)
SL → BE:    $77,420 (breakeven attivato)
```

**`send_sl_moved()` — per trailing**
```
🔔 TRAILING SL AGGIORNATO — LONG BTC

SL precedente:  $75,800
Nuovo SL:       $78,200  (+$2,400)
High water:     $80,900
Prezzo attuale: $80,650
Profitto minimo garantito: +$780
```

**`send_breakeven_sl()` — per breakeven**
```
🔒 BREAKEVEN SL ATTIVATO — LONG BTC

SL spostato a entry: $77,420
Trade ora a rischio zero
```

---

### Modifiche backend — `main.py`

**Nuovo endpoint `GET /trade-events?trade_id=X&limit=50`**

```python
@app.get("/trade-events")
async def get_trade_events(trade_id: str, limit: int = 50):
    db = get_supabase()
    result = db.table("trade_events")
        .select("*")
        .eq("trade_id", trade_id)
        .order("time", desc=False)
        .limit(limit)
        .execute()
    return result.data
```

**Nuova tabella Supabase da creare:**
```sql
-- trade_id referenzia orders.id (non trades.id):
-- execution.py inserisce in `orders` all'apertura e cattura l'ID generato,
-- poi lo salva in self._position["trade_id"] per collegare tutti gli eventi.
create table trade_events (
  id          uuid primary key default gen_random_uuid(),
  trade_id    uuid references orders(id) on delete set null,
  kind        text not null,  -- sl_moved | be_sl | partial_tp | tp2_hit | sl_hit
  payload     jsonb,
  time        timestamptz default now()
);
create index on trade_events (trade_id, time);
```

---

### Modifiche frontend — `Monitor.tsx` (estende ottimizzazione #2)

La Live Trade Card del piano #2 va arricchita con una sezione dedicata Partial TP / Trailing SL:

**Layout aggiornato della card posizione:**

```
┌─────────────────────────────────────────────────────────────────┐
│  POSIZIONE APERTA · BTC LONG                      Aperta 8.2h   │
│  ● LIVE                                                          │
├─────────────────────────────────────────────────────────────────┤
│  P&L Non Realizzato                                              │
│  +$312.40   +2.08%   ↑ In guadagno                              │
├───────────────┬─────────────┬───────────────────────────────────┤
│  Mark Price   │  Entry      │  R:R attuale                      │
│  $79,050      │  $77,420    │  1 : 2.4                          │
├───────────────┴─────────────┴───────────────────────────────────┤
│  MAPPA LIVELLI                                                    │
│                                                                  │
│  SL      [ENTRY]   Partial TP¹    ●mark     TP finale²          │
│  $75,800  $77,420   $79,400       $79,050    $82,500             │
│                                                                  │
│  [SL]━━━━━━━━━[ENTRY]━━━━━━━[PT1]━━━●━━━━━━━━━━━━━[TP2]        │
│   Distanza SL: -$3,250 (-4.1%)          Distanza TP: +$3,450    │
├─────────────────────────────────────────────────────────────────┤
│  GESTIONE TRADE                                                  │
│                                                                  │
│  Partial TP (50%)    ○ In attesa @ $79,400  →  +$142 stimato    │
│  Trailing SL         ○ Non ancora attivo (attiva @ $78,923)     │
│  Breakeven SL        ○ Non applicato                            │
│  LGBM Strikes        0 / 3                                      │
├─────────────────────────────────────────────────────────────────┤
│  Barre aperte: 2 × 4h   │  Contratti: 0.0186 BTC               │
└─────────────────────────────────────────────────────────────────┘
```

**Quando un evento si verifica**, il badge cambia:
- `○ In attesa @ $79,400` → `✅ Eseguito @ $79,400 (+$142.30)` — verde
- `○ Non ancora attivo` → `✅ Attivo — SL: $78,200 (spostato +$2,400)` — verde
- `○ Non applicato` → `✅ SL a breakeven: $77,420` — verde

La barra "mappa livelli" mostra tutti e 4 i prezzi chiave sulla stessa scala visiva: SL originale, entry, Partial TP¹, mark price attuale, TP finale². Il punto `●` si sposta in tempo reale con il mark price.

**Dati aggiuntivi da aggiungere all'interfaccia `BotStatus` (posizione):**
```typescript
partial_tp_price: number | null;           // prezzo target del partial TP
trailing_sl_dist: number | null;           // distanza fissa del trailing
trailing_sl_activation_price: number | null; // prezzo a cui si attiva
sl_original: number;                       // SL iniziale (non modificato)
tp2_price: number;                         // TP finale (alias di take_profit)
```

---

### Modifiche frontend — `TradeLog.tsx`

**1. Aggiungere interfaccia `TradeEvent`**
```typescript
interface TradeEvent {
  id: string;
  kind: 'sl_moved' | 'be_sl' | 'partial_tp' | 'tp2_hit' | 'sl_hit';
  payload: Record<string, any>;
  time: string;
}
```

**2. Sezione "legs" per ogni trade espanso**

Quando l'utente clicca su un trade nel log per espanderlo, caricare `/trade-events?trade_id=X` e mostrare una timeline verticale degli eventi:

```
TRADE · LONG BTC · +$284.50 (+1.92%)   [espandi ▼]
├── 14:00  📈 APERTO @ $77,420  SL=$75,800  TP=$82,500
├── 18:00  ⚡ PARTIAL TP (50%) @ $79,400  +$142.30
│          └─ SL → BE $77,420 (breakeven attivato)
├── 22:00  🔔 TRAILING SL $75,800 → $78,200 (hw=$80,900)
└── 02:00  ✅ CHIUSO @ $82,500 (tp2_hit)  +$284.50 totale
```

Ogni riga è colorata per tipo: apertura (indigo), partial TP (amber), SL move (slate), chiusura (emerald/rose).

**3. Mostrare SL attuale vs SL originale nelle card trade**

Nelle card del trade log già chiuso, aggiungere sotto il PnL:
- `SL originale: $75,800 → SL finale: $78,200` (se è stato spostato)
- Badge "Partial TP eseguito" se applicabile

---

### Ordine di implementazione consigliato

1. Creare tabella `trade_events` su Supabase
2. Aggiungere `_emit_trade_event()` in `execution.py`
3. Salvare `partial_tp_price`, `trailing_sl_dist`, `trailing_sl_activation_price`, `sl_original` in `self._position` all'apertura
4. Agganciare gli emit nei 3 punti chiave (trailing move, breakeven, partial TP)
5. Sostituire `send_trade_closed()` per partial TP con `send_partial_tp()`
6. Aggiungere `send_sl_moved()` e `send_breakeven_sl()` in `notifications.py`
7. Aggiungere endpoint `GET /trade-events` in `main.py`
8. Aggiornare `get_status()` per includere i nuovi campi posizione
9. Estendere la Live Trade Card in `Monitor.tsx` con la mappa livelli e i badge gestione
10. Aggiungere timeline legs in `TradeLog.tsx` con lazy-load degli eventi al click

---

## 4. Segnalazione segnali bloccati da posizione aperta (Monitor, Log, Server)

**Priorità:** Media  
**File coinvolti:**
- `apps/api/services/execution.py` — aggiungere logica di rilevamento e logging nel ciclo principale
- `apps/web/components/trading-hub/Monitor.tsx` — mostrare i segnali bloccati nel feed eventi

---

### Descrizione

Attualmente, se arriva un segnale mentre una posizione è già aperta, viene ignorato silenziosamente senza alcuna traccia visibile. Il codice rilevante è nella riga 499 di `execution.py`:

```python
if result.action != "no_trade" and allowed and self._position is None:
    await self._open_position(result, snap, atr, inference_id)
elif not allowed:
    log.info("Trade blocked: %s", block_reason)
# ← nessun else: il segnale "bloccato da posizione aperta" sparisce nel vuoto
```

L'inference log viene già scritto PRIMA di questo controllo (riga 496), quindi la decisione è registrata in `inference_logs` ma senza indicare che era bloccata da una posizione esistente. Il caso più importante da intercettare è il **segnale opposto**: SHORT che arriva mentre sei LONG (o viceversa) — può indicare che il modello ha cambiato view e il mercato si sta girando.

---

### Modifiche backend — `execution.py`

Aggiungere un branch `else` dopo il controllo posizione che distingue tre sotto-casi:

```python
if result.action != "no_trade" and allowed and self._position is None:
    await self._open_position(result, snap, atr, inference_id)
elif not allowed:
    log.info("Trade blocked by risk manager: %s", block_reason)
elif result.action != "no_trade" and self._position is not None:
    # Signal arrived but position already open — log it
    open_side    = self._position["side"]
    signal_side  = result.action
    ensemble_pct = round(result.confidence * 100, 1)   # confidence = ensemble_prob
    is_opposite  = (signal_side == "long"  and open_side == "short") or \
                   (signal_side == "short" and open_side == "long")

    kind    = "signal_blocked_opposite" if is_opposite else "signal_blocked_same"
    emoji   = "⚠️" if is_opposite else "ℹ️"
    label   = "SEGNALE CONTRARIO IGNORATO" if is_opposite else "Segnale uguale ignorato"

    # 1. Server log (sempre visibile nei log del processo)
    log.info(
        "[%s] %s — %s mentre posizione %s aperta | ensemble=%.1f%% | reasoning: %s",
        self.mode.upper(), label, signal_side.upper(), open_side.upper(),
        ensemble_pct, result.reasoning[-1] if result.reasoning else "—"
    )

    # 2. Supabase events (letto dal Monitor e dal ServerLogs)
    try:
        db = get_supabase()
        db.table("events").insert({
            "severity": "warning" if is_opposite else "info",
            "kind":     kind,
            "message":  (
                f"{emoji} {label}: {signal_side.upper()} @ ensemble {ensemble_pct}% "
                f"(posizione {open_side.upper()} aperta)"
            ),
            "payload": {
                "signal":        signal_side,
                "open_side":     open_side,
                "ensemble_pct":  ensemble_pct,
                "is_opposite":   is_opposite,
                "reasoning":     result.reasoning,
                "inference_id":  inference_id,
            },
        }).execute()
    except Exception as e:
        log.warning("signal_blocked event insert failed: %s", e)

    # 3. Telegram — solo per segnali opposti (non spammare per quelli uguali)
    if is_opposite:
        await self._notifier.send_signal_blocked_opposite(
            signal_side=signal_side,
            open_side=open_side,
            ensemble_pct=ensemble_pct,
            reasoning=result.reasoning,
        )
```

**Nota:** `result.confidence` è già l'`ensemble_prob` — il campo `confidence` del `DecisionResult` viene impostato a `ensemble_prob` nelle righe 162 e 189 di `decision.py`.

---

### Modifiche backend — `notifications.py`

Aggiungere un nuovo metodo per la notifica Telegram solo sui segnali opposti:

```python
async def send_signal_blocked_opposite(
    self,
    signal_side: str,
    open_side: str,
    ensemble_pct: float,
    reasoning: list[str],
):
    last_reason = reasoning[-1] if reasoning else "—"
    await self._send(
        f"⚠️ <b>SEGNALE CONTRARIO BLOCCATO — {signal_side.upper()}</b>\n"
        f"Posizione aperta: <code>{open_side.upper()}</code>\n"
        f"Ensemble:         <code>{ensemble_pct:.1f}%</code>\n"
        f"Motivo:           <code>{last_reason}</code>\n"
        f"<i>Il trade non è stato eseguito — posizione esistente in corso</i>"
    )
```

---

### Modifiche frontend — `Monitor.tsx`

Il Monitor ha già un feed eventi da Supabase (tabella `events`). Non serve un nuovo endpoint — basta estendere la visualizzazione degli eventi esistenti per differenziare i due nuovi tipi:

- `kind = "signal_blocked_opposite"` → card con bordo **amber**, badge "⚠️ Segnale Contrario", testo con ensemble%
- `kind = "signal_blocked_same"` → card con bordo **slate**, badge "ℹ️ Segnale Uguale", meno prominente

La card potrebbe apparire nel feed sotto la sezione "AI Intelligence Logs" con questo formato:

```
⚠️  SEGNALE CONTRARIO IGNORATO          18:00
    SHORT @ 79.4%  (posizione LONG aperta)
    Ensemble: 79.4% | LONG: P(up)=0.206 < 0.38...
```

---

### Approccio corretto

Sì, è l'approccio giusto. Il segnale opposto non deve mai aprire automaticamente un reverse — sarebbe pericoloso senza logica di chiusura coordinata. Ma **deve essere visibile**. In pratica:

- Segnale contrario debole (ensemble 55-65%): informativo, non allarmante
- Segnale contrario forte (ensemble >70%): segnale che il modello ha cambiato view — l'utente può decidere di chiudere manualmente o attendere l'exit automatica tramite LightGBM Mid-Trade Exit
- Segnale uguale (stesso lato): solo log di debug, non mostrare nella UI con prominenza

---

## 5. Bug: reset del contatore consecutive_losses al salvataggio config

**Priorità:** Bassa (non bloccante)  
**File coinvolti:**
- `apps/api/services/execution.py` — metodo `update_config()` e `_build_risk_manager()`

---

### Descrizione del bug

Quando l'utente salva la configurazione dal frontend (BotConfig o HubSettings), il backend chiama `update_config()`:

```python
def update_config(self, cfg):
    for k, v in cfg.model_dump().items():
        setattr(self.config, k, v)
    self._risk = self._build_risk_manager()  # ← problema qui
```

`_build_risk_manager()` crea un nuovo oggetto `RiskManager` da zero, perdendo lo stato interno accumulato:

```python
def _build_risk_manager(self) -> RiskManager:
    return RiskManager(
        sl_atr_mult=self.config.sl_atr_mult,
        tp_atr_mult=self.config.tp_atr_mult,
        position_size_pct=self.config.position_size_pct,
        max_daily_dd_pct=self.config.max_daily_dd_pct,
        max_consecutive_losses=self.config.max_consecutive_losses,
    )
```

Il costruttore di `RiskManager` inizializza sempre:
```python
self._daily_pnl_pct: float = 0.0
self._consecutive_losses: int = 0
self._daily_reset_date: Optional[str] = None
```

**Conseguenza pratica:** se il bot ha accumulato 3 perdite consecutive (su un massimo di 4 configurato) e l'utente salva qualsiasi impostazione — anche non correlata al risk management — il contatore viene azzerato e il blocco salta.

---

### Soluzione

Preservare lo stato dei contatori del `RiskManager` esistente prima di ricostruirlo, e reinietarli nel nuovo oggetto.

**Modifica a `update_config()` in `execution.py`:**

```python
def update_config(self, cfg):
    for k, v in cfg.model_dump().items():
        setattr(self.config, k, v)
    
    # Preserve risk counters across config updates
    old_daily_pnl      = self._risk._daily_pnl_pct
    old_consec_losses  = self._risk._consecutive_losses
    old_reset_date     = self._risk._daily_reset_date
    
    self._risk = self._build_risk_manager()
    
    # Restore counters so config save doesn't bypass risk guards
    self._risk._daily_pnl_pct       = old_daily_pnl
    self._risk._consecutive_losses  = old_consec_losses
    self._risk._daily_reset_date    = old_reset_date
    
    log.info("Config updated: %s", cfg.model_dump())
```

**Alternativa più pulita:** aggiungere un metodo `update_limits()` a `RiskManager` che aggiorna solo i parametri configurabili senza toccare lo stato:

```python
# In RiskManager
def update_limits(
    self,
    sl_atr_mult: float,
    tp_atr_mult: float,
    position_size_pct: float,
    max_daily_dd_pct: float,
    max_consecutive_losses: int,
):
    self.sl_atr_mult            = sl_atr_mult
    self.tp_atr_mult            = tp_atr_mult
    self.position_size_pct      = position_size_pct
    self.max_daily_dd_pct       = max_daily_dd_pct
    self.max_consecutive_losses = max_consecutive_losses
    # _daily_pnl_pct, _consecutive_losses, _daily_reset_date rimangono intatti

# In ExecutionEngine.update_config()
def update_config(self, cfg):
    for k, v in cfg.model_dump().items():
        setattr(self.config, k, v)
    self._risk.update_limits(
        sl_atr_mult=self.config.sl_atr_mult,
        tp_atr_mult=self.config.tp_atr_mult,
        position_size_pct=self.config.position_size_pct,
        max_daily_dd_pct=self.config.max_daily_dd_pct,
        max_consecutive_losses=self.config.max_consecutive_losses,
    )
    log.info("Config updated: %s", cfg.model_dump())
```

La seconda soluzione è preferibile perché elimina completamente la necessità di ricostruire il `RiskManager` ed è più leggibile.

---

## 6. Pulsante "Chiudi Posizione" manuale senza fermare il bot

**Priorità:** Alta  
**File coinvolti:**
- `apps/api/services/execution.py` — aggiungere metodo pubblico `close_position_manual()`
- `apps/api/main.py` — aggiungere endpoint `POST /bot/position/close`
- `apps/web/components/trading-hub/Monitor.tsx` — aggiungere pulsante nella card "Posizione Aperta"

---

### Problema attuale

L'unico modo per chiudere una posizione dalla UI è il **KILL switch**, che però:
- Ferma completamente il bot (`running = False`)
- Cancella il loop principale
- Disconnette il WebSocket da Hyperliquid
- Richiede un riavvio manuale per riprendere il trading

Non esiste un meccanismo per chiudere una posizione "normalmente" — con PnL contabilizzato, log scritto, notifica Telegram — lasciando il bot attivo e pronto ad aprire il trade successivo alla prossima candela.

---

### Logica della soluzione

Il metodo `_close_position(exit_price, reason)` esiste già e fa esattamente quello che serve: calcola PnL, aggiorna equity, invia ordine su HL (se live), scrive su Supabase, notifica Telegram, imposta `self._position = None`. È già usato da SL, TP, trailing, LightGBM exit e max hold bars.

Serve solo:
1. Un metodo pubblico che lo chiami in modo sicuro (gestendo la race condition con il loop)
2. Un endpoint REST che lo esponga
3. Un pulsante nella UI che lo chiami con conferma

---

### Modifiche backend — `execution.py`

Aggiungere il metodo pubblico `close_position_manual()` all'`ExecutionEngine`:

```python
async def close_position_manual(self) -> dict:
    """
    Chiude la posizione aperta al mark price corrente, senza fermare il bot.
    Il loop continua normalmente e può aprire nuovi trade alla prossima candela.
    Restituisce un dict con esito e PnL, oppure {"status": "no_position"} se non c'è nulla da chiudere.
    """
    if not self._position:
        return {"status": "no_position"}

    # Fetch mark price corrente da REST (fonte di verità — non dal WS che potrebbe essere vecchio)
    snap  = await self._hl.get_market_snapshot(SYMBOL)
    price = snap.get("mark_price", self._position["entry_price"])

    # Salva i dati prima della chiusura (dopo _close_position self._position è None)
    side  = self._position["side"]
    entry = self._position["entry_price"]

    # Riusa il metodo esistente: calcola PnL, aggiorna equity, invia ordine HL (live),
    # scrive Supabase, notifica Telegram, imposta self._position = None
    await self._close_position(price, reason="manual")

    pnl_pct = (
        (price - entry) / entry * 100 if side == "long"
        else (entry - price) / entry * 100
    )

    log.info(
        "[%s] Posizione chiusa manualmente @ %.2f | PnL %+.2f%%",
        self.mode.upper(), price, pnl_pct,
    )

    return {
        "status":    "closed",
        "side":      side,
        "exit_price": price,
        "pnl_pct":   round(pnl_pct, 4),
        "bot_still_running": self.running,
    }
```

**Nota sulla race condition:** il loop principale (`_cycle()`) accede a `self._position` ad ogni candela. Il ciclo 4h dura ore — la chiusura manuale ha una finestra enorme per completarsi senza collisioni. Come misura aggiuntiva, `_close_position()` ha già il guard `if not self._position: return` che previene doppi close.

---

### Modifiche backend — `main.py`

Aggiungere l'endpoint subito dopo `/bot/kill`:

```python
@app.post("/bot/position/close")
async def bot_close_position():
    """
    Chiude la posizione aperta al mark price corrente senza fermare il bot.
    Il loop continua — il prossimo trade può essere aperto alla candela successiva.
    """
    if not engine:
        raise HTTPException(503, "Engine not initialized")
    if not engine.running:
        raise HTTPException(400, "Bot non in esecuzione")

    result = await engine.close_position_manual()

    if result["status"] == "no_position":
        raise HTTPException(404, "Nessuna posizione aperta da chiudere")

    return result
```

---

### Modifiche frontend — `Monitor.tsx`

**1. Aggiungere la funzione `closePosition` accanto a `stopBot` e `killBot`:**

```typescript
const closePosition = async () => {
  if (!confirm(
    '⚠️ Chiudi la posizione aperta al prezzo corrente?\n\n' +
    'Il bot rimane attivo e può aprire nuovi trade.\n' +
    'Questa azione non può essere annullata.'
  )) return;

  try {
    const r = await fetch(`${apiBase}/bot/position/close`, { method: 'POST' });
    if (!r.ok) throw new Error(await r.text());
    const d = await r.json();
    alert(
      `✅ Posizione chiusa\n` +
      `${d.side?.toUpperCase()} @ $${d.exit_price?.toLocaleString()}\n` +
      `PnL: ${d.pnl_pct >= 0 ? '+' : ''}${d.pnl_pct?.toFixed(2)}%`
    );
    setTimeout(fetchAll, 800);  // aggiorna stato dopo chiusura
  } catch (e: any) {
    alert(`❌ Errore chiusura: ${e.message}`);
  }
};
```

**2. Aggiungere il pulsante nella card "Posizione Aperta"** (la sezione `{status?.position && (...)}` esistente), in fondo alla card dopo i dati Size/Contracts:

```tsx
{status?.position && (
  <div className="mt-4 pt-4 border-t border-slate-200 dark:border-white/5 flex items-center justify-between">
    <div className="flex gap-6 text-xs font-mono text-slate-500 dark:text-slate-400">
      <span>Size: ${status.position.size_usd.toFixed(0)}</span>
      <span>Contracts: {status.position.size_contracts?.toFixed(4)}</span>
    </div>
    <button
      onClick={closePosition}
      className="px-4 py-2 bg-amber-500 hover:bg-amber-400 text-white text-xs font-bold rounded-xl transition-all shadow-md shadow-amber-500/20 active:scale-95"
    >
      Chiudi Posizione
    </button>
  </div>
)}
```

**Design:** il pulsante è **amber** (non rosso come il KILL) per comunicare visivamente che è un'azione intenzionale ma non di emergenza. Il KILL rimane rosso.

---

### Differenze rispetto al KILL

| | Chiudi Posizione | KILL Switch |
|---|---|---|
| Chiude la posizione | ✅ | ✅ |
| Contabilizza PnL | ✅ | ✅ |
| Notifica Telegram | ✅ | ✅ |
| Bot rimane attivo | ✅ | ❌ — si ferma |
| WebSocket rimane connesso | ✅ | ❌ — si disconnette |
| Prossimo trade possibile | ✅ — alla candela successiva | ❌ — riavvio manuale |
| Caso d'uso | Uscita tattica manuale | Emergenza totale |

---

### Ordine di implementazione

1. Aggiungere `close_position_manual()` in `execution.py`
2. Aggiungere `POST /bot/position/close` in `main.py`
3. Aggiungere `closePosition()` in `Monitor.tsx`
4. Aggiungere il pulsante amber nella card posizione (integrato con il layout della ottimizzazione #2)
5. Testare in paper: aprire posizione → chiudere manualmente → verificare che il bot continui il loop alla candela successiva

---

## 7. Dominio personalizzato su Hetzner + HTTPS

**Priorità:** Media  
**File coinvolti:**
- `/etc/nginx/sites-available/quantum-trade` (VPS) — aggiornare `server_name`
- `apps/api/main.py` — restringere CORS `allow_origins`
- `apps/api/.env` — aggiornare `VPS_HOST`
- `vite.config.ts` — nessuna modifica necessaria (usa proxy `/api`)

---

### Contesto attuale

Il server Nginx risponde su `server_name 77.42.84.8` (IP diretto, porta 80, no HTTPS).  
Il frontend risolve l'API con path relativo `/api` in produzione — già corretto, non hardcoda l'IP.  
CORS in `main.py` ha `allow_origins=["*"]` — da restringere al dominio una volta attivo.

---

### Step 1 — Configurare il record DNS (sul registrar del dominio)

Nel pannello DNS del registrar aggiungere:

```
Type  Host                  Value         TTL
A     @                     77.42.84.8    300      ← dominio radice (es. tuodominio.com)
A     trade                 77.42.84.8    300      ← sottodominio (es. trade.tuodominio.com) — opzionale
```

Attendere propagazione: 5–30 minuti. Verificare con:
```bash
dig +short tuodominio.com
# deve restituire: 77.42.84.8
```

---

### Step 2 — Installare Certbot sul VPS

```bash
ssh -i ~/.ssh/id_ed25519 root@77.42.84.8

apt update && apt install -y certbot python3-certbot-nginx
```

---

### Step 3 — Aggiornare la configurazione Nginx

Modificare `/etc/nginx/sites-available/quantum-trade` (attualmente hardcoda l'IP):

```nginx
server {
    listen 80;
    server_name tuodominio.com www.tuodominio.com;   # ← sostituire con il dominio reale

    location /api/ {
        proxy_pass http://127.0.0.1:8000/;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_read_timeout 300s;
        proxy_send_timeout 300s;
    }

    location / {
        root /opt/quantum-trade/dist;
        try_files $uri $uri/ /index.html;
    }
}
```

Ricaricare Nginx:
```bash
nginx -t && systemctl reload nginx
```

---

### Step 4 — Ottenere il certificato SSL (HTTPS gratuito con Let's Encrypt)

```bash
certbot --nginx -d tuodominio.com -d www.tuodominio.com
```

Certbot modifica automaticamente Nginx aggiungendo il blocco `listen 443 ssl` e il redirect 80→443.  
Il certificato dura 90 giorni e si rinnova automaticamente via cronjob (`/etc/cron.d/certbot`).

Verificare rinnovo automatico:
```bash
certbot renew --dry-run
```

---

### Step 5 — Aggiornare CORS in `apps/api/main.py`

**File:** `apps/api/main.py`  
**Riga attuale (~74):**
```python
allow_origins=["*"],
```
**Sostituire con:**
```python
allow_origins=[
    "https://tuodominio.com",
    "https://www.tuodominio.com",
    "http://localhost:3000",    # dev locale
],
```

Questo elimina il wildcard CORS che oggi lascia aperto l'endpoint API a qualsiasi origine.  
Dopo questa modifica, riavviare il processo FastAPI sul VPS:
```bash
systemctl restart quantum-api   # o il nome del tuo servizio systemd
```

---

### Step 6 — Aggiornare `apps/api/.env` sul VPS

```dotenv
VPS_HOST=tuodominio.com    # era 77.42.84.8
```

Questo valore è usato solo a scopo documentale/deploy — non influenza il comportamento runtime.

---

### Riepilogo modifiche codice

| File | Cosa cambia | Obbligatorio |
|---|---|---|
| `/etc/nginx/sites-available/quantum-trade` (VPS) | `server_name` → dominio | ✅ |
| `apps/api/main.py` | `allow_origins` → lista domini | ✅ (sicurezza) |
| `apps/api/.env` (VPS) | `VPS_HOST` → dominio | facoltativo |
| `vite.config.ts` | nessuna modifica | — |
| `TradingHubTab.tsx` | nessuna modifica — usa `/api` relativo | — |

**Nota:** il frontend non hardcoda mai l'IP — usa `import.meta.env.VITE_API_URL ?? '/api'` in produzione, quindi il path relativo passa automaticamente attraverso Nginx sia con IP che con dominio. Nessuna rebuild del frontend è necessaria solo per il cambio dominio.

---

### Ordine di implementazione

1. Aggiungere record A sul registrar → attendere propagazione
2. Verificare con `dig +short tuodominio.com` che risponda `77.42.84.8`
3. Aggiornare `server_name` in Nginx → `nginx -t && systemctl reload nginx`
4. Eseguire `certbot --nginx -d tuodominio.com` → HTTPS attivo
5. Aggiornare `allow_origins` in `main.py` → rebuild + deploy → riavviare FastAPI
6. Testare: aprire `https://tuodominio.com` → verificare che il Trading Hub carichi e le API rispondano

---

## Storico SQL — Comandi Eseguiti su Supabase

Cronologia di tutti i comandi SQL eseguiti sul database di produzione, con data e motivo.

---

### 2026-05-16 — Tabella `trade_events`

**Contesto:** implementazione ottimizzazione #3 (Gestione Partial TP e Trailing SL — visibilità completa).  
La tabella collega ogni evento di gestione trade (spostamento SL, breakeven, partial TP) all'ordine di apertura tramite `trade_id`.

**⚠️ Primo tentativo (errato — FK sbagliata):**
```sql
-- NON ESEGUIRE — trade_id referenzia trades(id) che non viene mai popolato da execution.py
create table trade_events (
  id uuid primary key default gen_random_uuid(),
  trade_id uuid references trades(id),
  kind text not null,
  payload jsonb,
  time timestamptz default now()
);
```

**✅ Comando corretto (da eseguire / già eseguito):**
```sql
-- Drop della versione errata e ricreazione con FK corretta su orders(id)
drop table if exists trade_events;

create table trade_events (
  id        uuid primary key default gen_random_uuid(),
  trade_id  uuid references orders(id) on delete set null,
  kind      text not null,   -- sl_moved | be_sl | partial_tp | tp2_hit | sl_hit
  payload   jsonb,
  time      timestamptz default now()
);

create index on trade_events (trade_id, time);
```

**Motivo FK su `orders(id)` e non `trades(id)`:** `execution.py` inserisce un record in `orders` all'apertura della posizione e cattura l'UUID generato in `self._position["trade_id"]`. La tabella `trades` non viene mai popolata dal codice attuale.

---
