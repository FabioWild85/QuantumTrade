# Bounce-Fade Entry — Entry Adattivo sui Rimbalzi Controtendenza

**Data:** 2026-06-08
**Priorità:** Alta
**Complessità:** Media (≈ 4–5 ore)
**Origine:** Analisi del trade SHORT BTC 08/06 (entry a mercato 63.309, R:R 0.69). Il sistema entra subito alla chiusura candela anche quando il prezzo sta rimbalzando, beccando entry mediocri e SL larghi.

---

## 0. Il problema in una frase

Quando il sistema apre uno **short controtendenza** (regime daily bearish, ma il 4H sta rimbalzando), entra **subito al mark price** alla chiusura della candela. Risultato: entra nel mezzo del rimbalzo, con SL largo e R:R basso. Idealmente dovrebbe aspettare che il rimbalzo si avvicini alla resistenza e entrare **più in alto**, con SL stretto sopra la resistenza → R:R molto migliore.

---

## 1. Perché il design naive (limite alla EMA50) NON funziona

Dati reali del trade 08/06:

| | Valore |
|---|---|
| Entry a mercato | 63.309 |
| **Massimo del rimbalzo** | **64.228** (+1.45%, ≈ 0.75 ATR) |
| EMA50 | 65.119 |
| Bear OB top | 63.707 |

Il rimbalzo si è fermato **900 punti sotto la EMA50**. Un limite ancorato rigidamente alla EMA50 (o a qualsiasi resistenza "piena") **non sarebbe mai stato riempito** → trade perso, nonostante il segnale fosse corretto.

**Lezione 1**: la resistenza è un *bersaglio probabile*, non una garanzia. Il rimbalzo spesso si esaurisce **prima** di raggiungerla.

**Lezione 2**: serve un meccanismo di **fallback** — se il limite non riempie ma il segnale persiste, bisogna comunque entrare, altrimenti si perdono i segnali validi.

---

## 2. Il design corretto: penetration_pct + fallback

### 2.1 Idea centrale

Invece di mettere il limite ALLA resistenza, lo si mette a una **frazione configurabile** della distanza tra il prezzo attuale e la resistenza:

```
entry_limit = close + penetration_pct × (resistenza − close)
```

con un **cap in ATR** che impedisce al limite di allontanarsi troppo dal prezzo:

```
offset = min( bounce_offset_atr × ATR , penetration_pct × (resistenza − close) )
entry_limit_short = close + offset
```

### 2.2 Validazione sul trade reale

Con `penetration_pct = 0.50` e ATR = 1223:

```
resistenza (EMA50) = 65.119
penetration 50%    = 63.309 + 0.50 × (65.119 − 63.309) = 64.214
cap ATR (0.5×ATR)  = 63.309 + 611 = 63.920
entry_limit = min(64.214, 63.920) = 63.920   ← riempito (rimbalzo a 64.228)
```

→ entry a **63.920 invece di 63.309** = **+0.97% più in alto**, con SL stretto sopra il rimbalzo invece di 2 ATR generici. Il trade sarebbe stato riempito **e** con R:R nettamente migliore.

> Senza cap ATR e con penetration 50% pura, il limite sarebbe stato 64.214 — riempito comunque (rimbalzo a 64.228), entry ancora migliore. Il cap è una rete di sicurezza per i casi in cui la resistenza è molto lontana.

---

## 3. Calcolo della resistenza

La resistenza sovrastante è il **minimo tra i livelli sopra il prezzo** (il più vicino, non il più lontano — questo era l'errore della EMA50):

```python
candidates = []
if ob_bear_top_px  > close:  candidates.append(ob_bear_top_px)
if fvg_bear_bot_px > close:  candidates.append(fvg_bear_bot_px)
if swing_high_px   > close and swing_high_px < close * 1.05:  # escludi swing irrealistici
    candidates.append(swing_high_px)
ema50 = close - ema50_dist * atr
if ema50 > close:  candidates.append(ema50)

resistance = min(candidates) if candidates else close + bounce_offset_atr * atr
```

> **Nota**: per i LONG controtendenza (regime daily bullish, 4H in pullback ribassista) la logica è speculare: resistenza → supporto sottostante, `min` → `max`, `+offset` → `−offset`.

Tutti i livelli (`ob_bear_top_px`, `fvg_bear_bot_px`, `swing_high_px`, `ema50_dist`, `atr_14`) sono **già calcolati** in `build_all_features()` e presenti nel `features_snapshot`. Nessun nuovo dato da fetchare.

---

## 4. Condizione di attivazione: solo controtendenza

Il bounce-fade si attiva **solo** quando il trade è controtendenza, altrimenti si rischia di ritardare entry su trade trend-following validi.

```python
# Short controtendenza = segnale short MA il 4H recente è verde (rimbalzo)
is_counter_trend_short = (result.action == "short") and (ret_6 > 0)
is_counter_trend_long  = (result.action == "long")  and (ret_6 < 0)
counter_trend = is_counter_trend_short or is_counter_trend_long
```

Con `bounce_fade_counter_trend_only = True` (default), se non è controtendenza → entry normale a mercato. Se l'utente lo mette a `False`, il bounce-fade si applica a tutti i segnali.

---

## 5. Ciclo di vita del pending (risponde alla domanda 2)

```
T0 (chiusura candela 4H, segnale short controtendenza):
  → calcola entry_limit
  → crea PendingBounceFade (window = bounce_fade_window_bars × 4h)
  → NON entra ancora

Durante la finestra (controllo a ogni candela 4H, o 1H se disponibile):
  ├─ se high >= entry_limit  → FILL short @ entry_limit
  │     SL = max(bounce_high_raggiunto, resistenza) + sl_buffer_atr × ATR
  │     recalcola R:R; se R:R < bounce_fade_min_rr → annulla (entry troppo vicino a SL)
  │
  ├─ [opzionale] momentum exhaustion: se si forma una candela 4H ribassista
  │     dopo il run verde (close < open) → FILL a mercato (prendi il top locale)
  │
  └─ traccia il massimo raggiunto (bounce_high)

Alla SCADENZA senza fill:
  ├─ se bounce_fade_market_fallback = True E segnale ancora short
  │     → ENTRA A MERCATO alla chiusura della candela corrente   ← la tua domanda 2
  │
  └─ se bounce_fade_market_fallback = False
        → annulla (trade perso, ma evitato entry mediocre)
```

**Risposta diretta alla tua domanda 2**: sì. Con `bounce_fade_market_fallback = True` (default), se il limite non viene riempito entro la finestra e il segnale è ancora short alla chiusura dell'ultima candela 4H, il sistema **entra comunque a mercato**. Non perdi mai un segnale persistente — al massimo, se il rimbalzo non è arrivato all'entry ottimale, entri al prezzo corrente come faresti oggi. Il bounce-fade può solo migliorare l'entry, mai peggiorarlo.

---

## 5.5 Gestione SL / TP / Size / R:R (LA TUA DOMANDA CHIAVE)

> **Chiarimento importante**: questo NON è un entry "a scaglioni" (laddered). È un **singolo limite** con fallback a mercato. Un solo fill, una sola posizione. Niente media di prezzo su più livelli — questo evita conflitti con la logica di partial TP esistente e tiene la gestione SL/TP/size semplice e robusta. Se in futuro vorrai un vero scaling su più livelli, è un'estensione separata.

### Il pericolo da evitare: esplosione della size

`calculate_trade_params` usa **sizing risk-based**:
```python
risk_usd = equity × (position_size_pct / 100)   # rischio $ FISSO
size_usd = risk_usd / sl_pct                      # SL più stretto → size PIÙ GRANDE
```

Se al fill ricalcolassi la size con lo SL stretto della resistenza (es. 0.5 ATR invece di 2 ATR), la posizione **esploderebbe di ~4×**. Il codice stesso avverte di questo rischio (`risk.py:124`).

### La soluzione: size congelata al segnale, SL/TP override

Al **momento del fill** il sistema usa il meccanismo `sl_override` / `tp_override` (già presente in `_open_position`, già testato dal reversal) + un nuovo `size_usd_override`:

| Componente | Valore al fill | Razionale |
|---|---|---|
| **Entry** | `entry_limit` (prezzo migliore) | — |
| **TP** | `orig_tp` (assoluto, dal segnale) | Il target del downtrend NON si sposta perché entri più in alto → più reward |
| **SL** | `max(bounce_extreme, resistenza) + sl_buffer×ATR`, con **floor** `sl_min_atr×ATR` | SL stretto sopra la resistenza, ma mai più stretto del floor (anti-rumore) |
| **Size** | `orig_size_usd` (congelata al segnale, calcolata a mercato) | **Niente esplosione**: size identica a un entry a mercato normale |
| **R:R** | `\|entry−TP\| / \|SL−entry\|`, accettato solo se ≥ `min_rr` | Se R:R sotto soglia → annulla il fill |

**Conseguenza chiave**: con size congelata + SL più stretto, il **rischio in dollari di questi trade è PIÙ BASSO** di un entry a mercato (non più alto). Il bounce-fade è quindi conservativo sul rischio e migliora l'R:R — non aumenta mai l'esposizione.

### Verifica sui numeri reali del trade 08/06

```
Entry a mercato (oggi):  63.309, SL 65.323 (2 ATR), TP 61.916  →  R:R 0.69
Bounce-fade:
  entry_limit  = 63.920  (penetration 50% + cap 0.5 ATR)
  TP           = 61.916  (orig_tp, invariato)
  resistenza   ≈ 64.228  (bounce high)
  SL grezzo    = 64.228 + 0.3×1223 = 64.595  (0.55 ATR — sotto il floor)
  SL con floor = 63.920 + 0.8×1223 = 64.898  (floor 0.8 ATR applicato)
  R:R          = (63.920−61.916)/(64.898−63.920) = 2.004/978 = 2.05
  size         = orig_size_usd (invariata)
  rischio $    = size × 978/63.920  <  size × 2.014/63.309 (entry a mercato)
```

→ R:R da **0.69 a 2.05**, con **rischio in dollari inferiore**. Il floor SL (0.8 ATR) evita che lo SL sia troppo stretto e venga spazzato dal rumore.

### Fallback a mercato (scadenza)

Se non riempito e `market_fallback=True`: `_open_position` normale (entry a mercato, SL/TP/size ricalcolati standard dal prezzo corrente). **Nessun override** — identico a oggi. Il bounce-fade non ha effetto su questo caso, se non l'attesa.

---

## 5.6 Analisi conflitti (verifica integrità sistema)

| Potenziale conflitto | Risoluzione |
|---|---|
| **Pullback Entry** (anch'esso crea pending su impulso) | Il bounce-fade è controllato PRIMA del pullback nel blocco trend-entry. Se crea un pending, il pullback viene saltato (`result.action="no_trade"`). I due non possono coesistere sullo stesso segnale. |
| **Reversal Detector** (ha il suo limit_retest) | Il bounce-fade si applica SOLO ai segnali trend normali (`not result._is_reversal`). I trade reversal mantengono la loro entry. |
| **1H Gate** (può mettere no_trade) | Gira prima. Se blocca, non c'è segnale da intercettare. Nessun conflitto. |
| **Partial TP / Trailing SL** (gestione posizione) | Agiscono dopo l'apertura, sulla posizione già aperta. Il bounce-fade tocca solo l'entry. Nessuna interferenza. |
| **Sizing risk-based** | Risolto con size congelata (`orig_size_usd`) — vedi 5.5. |
| **Race: posizione aperta nello stesso ciclo** | Mirror del guard del pullback (`if self._position: pending=None`). |
| **Persistenza stato** (restart del bot) | Il pending bounce-fade è in memoria. Su restart si perde (come il pullback passivo). Accettabile: alla scadenza il segnale o si ripresenta o decade. Per il live si può persistere in seguito. |

---

## 6. Parametri (toggle + slider, live/paper + backtest)

| Parametro | Tipo | Default | Range UI | Significato |
|---|---|---|---|---|
| `bounce_fade_enabled` | bool | `False` | toggle | Master switch |
| `bounce_fade_counter_trend_only` | bool | `True` | toggle | Solo su segnali controtendenza |
| `bounce_fade_penetration_pct` | float | `0.50` | 0.20–0.80 | Frazione della distanza verso la resistenza |
| `bounce_fade_offset_atr` | float | `0.50` | 0.20–1.50 | Cap massimo in ATR sopra/sotto il prezzo |
| `bounce_fade_window_bars` | int | `2` | 1–4 | Candele 4H di attesa (2 = 8h) |
| `bounce_fade_market_fallback` | bool | `True` | toggle | Entra a mercato a scadenza se segnale persiste |
| `bounce_fade_min_rr` | float | `1.5` | 1.0–3.0 | R:R minimo per accettare il fill |
| `bounce_fade_sl_buffer_atr` | float | `0.30` | 0.10–1.00 | Buffer SL sopra la resistenza |
| `bounce_fade_exhaustion_fill` | bool | `True` | toggle | Fill anticipato su candela di esaurimento |

**Calibrazione default su BTC 4H**: `penetration_pct 0.50` + `offset_atr 0.50` riempie sui rimbalzi tipici (0.5–1.0 ATR) senza ancorarsi a resistenze irrealistiche.

---

## 7. Implementazione

### 7.1 Riuso della struttura esistente

Il sistema ha già `PendingPullback` ([execution.py:55](apps/api/services/execution.py#L55)) e tutta la logica di pending fill/expiry/fallback, sia live che backtest. Il bounce-fade **riusa lo stesso pattern**:

```python
@dataclass
class PendingBounceFade:
    direction:       str           # "long" | "short"
    close_4h:        float
    atr_at_signal:   float
    entry_limit:     float         # prezzo limite calcolato
    resistance:      float         # livello di resistenza/supporto usato
    bounce_high:     float         # massimo (o minimo) raggiunto, aggiornato a ogni bar
    expires_at:      datetime
    decision_result: object        # DecisionResult originale per il fallback
    min_rr:          float
    sl_buffer_atr:   float
```

### 7.2 File da modificare

| File | Modifica |
|---|---|
| `execution.py` | BotConfig params (sezione `__init__`); `PendingBounceFade` dataclass; `_create_pending_bounce_fade()`; check fill/expiry nel `_cycle()`; passaggio params a... (vedi sotto) |
| `backtesting.py` | `getattr` params; gestione `pending_bf` nel loop (mirror di `pending_pb`); param_stats `bf_filled`, `bf_market_fallback`, `bf_expired_abandoned` |
| `BotConfig.tsx` | interface + default + sezione UI dentro "Pullback Entry" o nuova sezione |
| `BacktestPanel.tsx` | state + loadPreset + buildConfig + UI + param_stats display |

### 7.3 Logica di creazione (execution.py, nuovo metodo)

```python
async def _create_pending_bounce_fade(self, result, latest, atr, snap):
    close = float(latest.get("close") or snap["mark_price"])
    pen   = getattr(self.config, "bounce_fade_penetration_pct", 0.50)
    cap   = getattr(self.config, "bounce_fade_offset_atr",      0.50) * atr
    win   = getattr(self.config, "bounce_fade_window_bars",     2)
    ema50 = close - self._safe_float(latest.get("ema50_dist") or 0.0) * atr

    if result.action == "short":
        cands = [lv for lv in (
            self._safe_float(latest.get("ob_bear_top_px")),
            self._safe_float(latest.get("fvg_bear_bot_px")),
            self._safe_float(latest.get("swing_high_px")),
            ema50,
        ) if lv and close < lv < close * 1.05]
        resistance  = min(cands) if cands else close + cap
        offset      = min(cap, pen * (resistance - close))
        entry_limit = close + offset
    else:  # long counter-trend
        cands = [lv for lv in (
            self._safe_float(latest.get("ob_bull_bot_px")),
            self._safe_float(latest.get("fvg_bull_top_px")),
            self._safe_float(latest.get("swing_low_px")),
            ema50,
        ) if lv and close * 0.95 < lv < close]
        support     = max(cands) if cands else close - cap
        offset      = min(cap, pen * (close - support))
        entry_limit = close - offset
        resistance  = support

    return PendingBounceFade(
        direction=result.action, close_4h=close, atr_at_signal=atr,
        entry_limit=entry_limit, resistance=resistance, bounce_high=close,
        expires_at=datetime.now(timezone.utc) + timedelta(hours=win * 4),
        decision_result=result,
        min_rr=getattr(self.config, "bounce_fade_min_rr", 1.5),
        sl_buffer_atr=getattr(self.config, "bounce_fade_sl_buffer_atr", 0.30),
    )
```

### 7.4 Check fill/expiry nel ciclo (mirror del pullback)

Posizione: nel `_cycle()`, **prima** della generazione del segnale, dove già si controlla `_pending_pullback` ([execution.py:~1039](apps/api/services/execution.py)).

```python
if self._pending_bounce_fade is not None and self._position is None:
    bf = self._pending_bounce_fade
    bar_high = float(snap.get("high_4h", snap["mark_price"]))
    bar_low  = float(snap.get("low_4h",  snap["mark_price"]))
    bf.bounce_high = max(bf.bounce_high, bar_high) if bf.direction == "short" else min(bf.bounce_high, bar_low)

    _reached = (bf.direction == "short" and bar_high >= bf.entry_limit) or \
               (bf.direction == "long"  and bar_low  <= bf.entry_limit)

    if _reached:
        # FILL al limite: SL sopra (sotto) la resistenza + buffer
        sl_buf = bf.sl_buffer_atr * bf.atr_at_signal
        if bf.direction == "short":
            sl = max(bf.bounce_high, bf.resistance) + sl_buf
        else:
            sl = min(bf.bounce_high, bf.resistance) - sl_buf
        # recalcola R:R con il nuovo entry e SL; apri solo se >= min_rr
        # (riusa risk.calculate_trade_params con entry=bf.entry_limit, sl override)
        ...
        self._pending_bounce_fade = None

    elif datetime.now(timezone.utc) >= bf.expires_at:
        if getattr(self.config, "bounce_fade_market_fallback", True):
            # entra a mercato col DecisionResult originale (se segnale ancora valido)
            ...  # market entry @ snap["mark_price"]
        self._pending_bounce_fade = None
```

### 7.5 Hook al posto del market entry immediato

Dove oggi il segnale apre subito ([execution.py, blocco di apertura posizione]):

```python
if (
    getattr(cfg, "bounce_fade_enabled", False)
    and result.action in ("long", "short")
    and self._position is None
    and self._pending_bounce_fade is None
):
    _ret6 = self._safe_float(latest.get("ret_6") or 0.0)
    _counter = (result.action == "short" and _ret6 > 0) or (result.action == "long" and _ret6 < 0)
    if _counter or not getattr(cfg, "bounce_fade_counter_trend_only", True):
        self._pending_bounce_fade = await self._create_pending_bounce_fade(result, latest, atr, snap)
        result.action = "no_trade"   # sospende l'entry immediato; il pending gestirà fill/fallback
        result.reasoning.append(
            f"BounceFade: limite {self._pending_bounce_fade.entry_limit:.0f} "
            f"(resistenza {self._pending_bounce_fade.resistance:.0f}, scade in "
            f"{getattr(cfg,'bounce_fade_window_bars',2)} bar)"
        )
```

---

## 8. Backtest (backtesting.py)

Mirror esatto della gestione `pending_pb` già presente ([backtesting.py:517-621](apps/api/services/backtesting.py)):

```python
# getattr params (sezione iniziale)
bounce_fade_enabled         = getattr(cfg, "bounce_fade_enabled",         False)
bounce_fade_counter_only    = getattr(cfg, "bounce_fade_counter_trend_only", True)
bounce_fade_penetration     = getattr(cfg, "bounce_fade_penetration_pct", 0.50)
bounce_fade_offset_atr      = getattr(cfg, "bounce_fade_offset_atr",      0.50)
bounce_fade_window          = getattr(cfg, "bounce_fade_window_bars",     2)
bounce_fade_fallback        = getattr(cfg, "bounce_fade_market_fallback", True)
bounce_fade_min_rr          = getattr(cfg, "bounce_fade_min_rr",          1.5)
bounce_fade_sl_buffer       = getattr(cfg, "bounce_fade_sl_buffer_atr",   0.30)

# pending_bf gestito nel loop con i high/low intrabar della candela i
# (stesso pattern di pending_pb: check fill, traccia bounce_high, expiry+fallback)

# param_stats nuovi
"bf_created":            0,   # pending creati
"bf_filled_limit":       0,   # riempiti al limite (entry migliore)
"bf_market_fallback":    0,   # entry a mercato a scadenza (segnale persistente)
"bf_abandoned":          0,   # scaduti senza fill (fallback OFF)
"bf_exhaustion_fill":    0,   # fill anticipato su esaurimento
```

> **Nota backtest**: usare `df_feat["high"].iloc[i]` e `df_feat["low"].iloc[i]` per simulare il fill intrabar, esattamente come fa già il pullback. Nessun lookahead: il fill si valuta sulla candela in cui il pending è attivo, non su quelle future.

---

## 9. UI

### 9.1 BotConfig.tsx — nuova sezione "Bounce-Fade Entry" (dopo Pullback Entry)

Toggle master + slider per: penetration_pct (20-80%), offset_atr (0.2-1.5), window_bars (1-4), min_rr (1.0-3.0), sl_buffer_atr (0.1-1.0), e due toggle (counter_trend_only, market_fallback).

### 9.2 BacktestPanel.tsx

State + loadPreset + buildConfig + sezione UI (riusa il pattern `NumInput` + `Toggle`) + righe param_stats nel report Attività Parametri:
- "Bounce-Fade — Fill al limite (entry migliore)" → `bf_filled_limit`
- "Bounce-Fade — Fallback a mercato (segnale persistente)" → `bf_market_fallback`
- "Bounce-Fade — Scaduti senza fill" → `bf_abandoned`

---

## 10. Cosa misurare nel backtest

Dopo l'implementazione, confrontare su 3-5 periodi (gate OFF vs ON):

1. **R:R medio** dei trade controtendenza (atteso: netto miglioramento)
2. **Win rate** dei trade controtendenza (atteso: leggero miglioramento — entry migliore = meno SL sfiorati)
3. **% di pending riempiti al limite** vs **% fallback a mercato** (se il fallback domina, il penetration_pct è troppo alto → abbassarlo)
4. **Return totale** (atteso: stabile o migliore; se cala molto, troppi trade persi → alzare penetration o accorciare window)
5. **Trade evitati** (pending scaduti con fallback OFF) e loro esito ipotetico

Soglia di successo: R:R medio controtendenza migliora di ≥ 0.5 senza che il win rate cali.

---

## 11. Riepilogo onesto dei limiti

- **Non è gratis**: ogni bounce-fade ritarda l'entry di fino a `window_bars × 4h`. Su segnali che si invertono rapidamente, il fallback a mercato entra comunque ma all'entry originale (nessun guadagno, nessuna perdita).
- **La resistenza può essere superata**: se il rimbalzo sfonda la resistenza e continua, il fill avviene ma poi va in perdita come un market entry. Il bounce-fade migliora l'entry medio, non elimina i trade sbagliati.
- **Dipende dalla qualità dei livelli SMC**: se OB/FVG/swing sono rumorosi, la resistenza calcolata è imprecisa. Il cap in ATR limita il danno.
- **Va validato in backtest prima del live**, come ogni feature. Default `False`.

---

*Piano generato il 2026-06-08 da analisi del trade SHORT BTC 08/06 (entry a mercato R:R 0.69, rimbalzo a 64.228 fermatosi 900pt sotto EMA50). Stima implementazione: 4–5 ore incluso testing.*
