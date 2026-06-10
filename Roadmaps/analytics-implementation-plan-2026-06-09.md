# Piano di Implementazione — Analytics Panel (Trade Diagnostics + SL/TP Lab)

**Data:** 9 Giugno 2026
**Stato:** Pronto per implementazione — verificato sul codice reale
**Priorità:** Alta — fornisce la base empirica per tutte le decisioni di tuning future
**Stima:** 5–7 ore, ~550 righe totali

---

## 0. Relazione con il piano Leva (`leverage-implementation-plan-2026-05-28.md`)

### I due piani sono **indipendenti**. Non è necessario implementare la leva prima.

**Motivazione:**

| Aspetto | Analytics | Leva |
|---------|-----------|------|
| Colonne SQL aggiunte a `trades` | `entry_atr`, `sl_price`, `tp_price`, `sl_pct`, `tp_pct`, `mfe_pct`, `mae_pct`, `tp_reach_pct`, `bars_held_final`, `regime_at_entry`, `entry_type`, `lgbm_prob`, `c2_dir_prob` | `leverage`, `liq_px`, `margin_usd` |
| Colonne SQL aggiunte a `inference_logs` | `gates_fired`, `signal_native` | nessuna |
| Dipendenza reciproca | nessuna | nessuna |
| Conflitto colonne | impossibile — set disjoint | impossibile |

**Compatibilità forward con la leva:** Il campo `reason_close` nella tabella `trades` accetta già qualsiasi stringa. Quando la leva verrà implementata e inizieranno ad apparire trade con `reason_close = "liquidation"`, l'Analytics Panel li mostrerà automaticamente nel breakdown Exit Reasons senza modifiche. Il campo `tp_reach_pct` per un trade liquidato sarà semplicemente inferiore al normale — dato informativo, non errore.

**Raccomandazione:** Implementa Analytics prima. La leva è un'operazione più invasiva (7 step, modifica al sizing, 4 path nel backtest) e non produce dati analitici. Analytics inizia a raccogliere dati utili dal primo trade successivo al deploy.

---

## 1. Panoramica dell'architettura aggiunta

```
┌─────────────────────────────────────────────────────────────────────┐
│                         LIVELLO DATI                                │
│                                                                     │
│  decision.py          execution.py           main.py               │
│  DecisionResult  →    _open_position    →    /analytics/*          │
│  + gates_fired        _manage_position       (3 endpoint REST)     │
│  + signal_native      _close_position                              │
│                       _log_inference                                │
│                                                                     │
│  Supabase tables:                                                   │
│  trades (estesa)  ←─── _close_position                             │
│  inference_logs   ←─── _log_inference                              │
│  (entrambe)                                                         │
└──────────────────────────────┬──────────────────────────────────────┘
                               │ HTTP GET
┌──────────────────────────────▼──────────────────────────────────────┐
│                         LIVELLO UI                                  │
│                                                                     │
│  TradingHubTab.tsx ──→ page='analytics' ──→ AnalyticsPanel.tsx     │
│  (nuova voce nav)                           Tab 1: Overview         │
│                                             Tab 2: Gate Performance │
│                                             Tab 3: SL/TP Lab        │
└─────────────────────────────────────────────────────────────────────┘
```

---

## 2. File da modificare

| File | Tipo | Sezione |
|------|------|---------|
| `apps/api/services/decision.py` | Modifica | `DecisionResult` dataclass + `DecisionEngine.decide()` |
| `apps/api/services/execution.py` | Modifica | `_open_position`, `_manage_position`, `_close_position`, `_log_inference` |
| `apps/api/main.py` | Modifica | 3 nuovi endpoint `/analytics/*` + import pandas |
| `apps/web/components/trading-hub/AnalyticsPanel.tsx` | Nuovo file | Componente completo |
| `apps/web/components/trading-hub/TradingHubTab.tsx` | Modifica | `HubPage` type + `NAV` array + routing |

---

## 3. Database Migration (Supabase)

Da eseguire **una sola volta** prima del deploy backend. Usare l'editor SQL di Supabase.

### 3.1 — Tabella `trades`

```sql
-- Aggiunge colonne analitiche alla tabella trades.
-- Tutte nullable per retrocompatibilità con trade già esistenti (avranno NULL).
ALTER TABLE trades
  ADD COLUMN IF NOT EXISTS entry_atr       FLOAT,
  ADD COLUMN IF NOT EXISTS sl_price        FLOAT,
  ADD COLUMN IF NOT EXISTS tp_price        FLOAT,
  ADD COLUMN IF NOT EXISTS sl_pct          FLOAT,
  ADD COLUMN IF NOT EXISTS tp_pct          FLOAT,
  ADD COLUMN IF NOT EXISTS mfe_pct         FLOAT,
  ADD COLUMN IF NOT EXISTS mae_pct         FLOAT,
  ADD COLUMN IF NOT EXISTS tp_reach_pct    FLOAT,
  ADD COLUMN IF NOT EXISTS bars_held_final INT,
  ADD COLUMN IF NOT EXISTS regime_at_entry TEXT,
  ADD COLUMN IF NOT EXISTS entry_type      TEXT,
  ADD COLUMN IF NOT EXISTS lgbm_prob       FLOAT,
  ADD COLUMN IF NOT EXISTS c2_dir_prob     FLOAT;

-- Indici per le query analytics (joins frequenti su questi campi)
CREATE INDEX IF NOT EXISTS idx_trades_reason_close    ON trades(reason_close);
CREATE INDEX IF NOT EXISTS idx_trades_regime_at_entry ON trades(regime_at_entry);
CREATE INDEX IF NOT EXISTS idx_trades_entry_type      ON trades(entry_type);
CREATE INDEX IF NOT EXISTS idx_trades_closed_at       ON trades(closed_at);
```

### 3.2 — Tabella `inference_logs`

```sql
-- Aggiunge struttura gate per query analitiche sui cicli bloccati.
ALTER TABLE inference_logs
  ADD COLUMN IF NOT EXISTS gates_fired  JSONB,
  ADD COLUMN IF NOT EXISTS signal_native TEXT;

-- Indice GIN per query JSONB (es. WHERE gates_fired->>'adx_gate' = 'block')
CREATE INDEX IF NOT EXISTS idx_inference_gates_fired ON inference_logs USING GIN(gates_fired);
CREATE INDEX IF NOT EXISTS idx_inference_decision    ON inference_logs(decision);
```

### 3.3 — Verifica post-migration

```sql
-- Verifica che le colonne siano state aggiunte correttamente
SELECT column_name, data_type, is_nullable
FROM information_schema.columns
WHERE table_name = 'trades'
  AND column_name IN (
    'entry_atr','sl_price','tp_price','sl_pct','tp_pct',
    'mfe_pct','mae_pct','tp_reach_pct','bars_held_final',
    'regime_at_entry','entry_type','lgbm_prob','c2_dir_prob'
  )
ORDER BY column_name;

SELECT column_name, data_type
FROM information_schema.columns
WHERE table_name = 'inference_logs'
  AND column_name IN ('gates_fired','signal_native');
```

---

## 4. Backend — `decision.py`

### 4.1 — `DecisionResult`: aggiungere `gates_fired`

**Posizione:** subito dopo `_exhaustion_triggered` (~riga 31).

```python
@dataclass
class DecisionResult:
    action: Action
    confidence: float
    reasoning: list[str]
    features_snapshot: dict
    directional_prob: float
    forecast_p10: float
    forecast_p50: float
    forecast_p90: float
    forecast_uncertainty: float = 0.0
    size_factor: float = 1.0
    _is_reversal: bool = False
    _exhaustion_triggered: bool = False
    # ── Analytics: gate audit trail ──────────────────────────────────────────
    # Populated by DecisionEngine.decide(). Values: "pass" | "block" | "scale"
    # Keys match BotConfig parameter names (adx_gate, sweep_gate, etc.)
    gates_fired: dict = field(default_factory=dict)
```

Aggiungere l'import in cima al file se non già presente:
```python
from dataclasses import dataclass, field
```

### 4.2 — `DecisionEngine.decide()`: popolare `gates_fired`

Nella funzione `decide()`, ogni gate che scrive nel `reasoning` deve anche scrivere nel dict `gates_fired`. Il pattern è uniforme: subito dopo ogni `reasoning.append(...)` relativo a un gate, aggiungere la corrispondente riga sul dict.

La lista completa dei gate da tracciare e le loro chiavi:

```python
# Inizializzare il dict prima di qualsiasi gate check, all'inizio di decide()
gates_fired: dict = {}
```

Poi, per ogni gate esistente, aggiungere la registrazione structured accanto alla riga reasoning già esistente:

**Weekend gate** (~riga 298-302):
```python
# Esistente:
reasoning.append(f"WEEKEND GATE: ...")
return DecisionResult(action="no_trade", ...)

# Aggiungere prima del return:
gates_fired["weekend_gate"] = "block"
```

**ADX gate** (~riga 310-311):
```python
# Esistente:
reasoning.append(f"GATE: ADX {adx:.1f} < {self.adx_gate} — market compressing, no-trade")
return DecisionResult(action="no_trade", ...)

# Aggiungere prima del return:
gates_fired["adx_gate"] = "block"
```
Quando l'ADX gate NON blocca (~dopo il check):
```python
gates_fired["adx_gate"] = "pass"
```

**Sweep gate** (pattern identico):
```python
gates_fired["sweep_gate"] = "block"  # se blocca
gates_fired["sweep_gate"] = "pass"   # se passa
```

**ATR% gate:**
```python
gates_fired["atr_pct_gate"] = "block"   # mode="block"
gates_fired["atr_pct_gate"] = "scale"   # mode="scale"
gates_fired["atr_pct_gate"] = "pass"    # non attivato o ATR sopra soglia
```

**OI spike gate, L/S ratio gate, Liquidation spike gate** (Squeeze Protection A/B/C):
```python
gates_fired["oi_spike_gate"]  = "block" | "scale" | "pass"
gates_fired["ls_gate"]        = "block" | "scale" | "pass"
gates_fired["liq_spike_gate"] = "block" | "scale" | "pass"
```

**Confluence gate:**
```python
gates_fired["confluence_gate"] = "block"  # score < confluence_gate threshold
gates_fired["confluence_gate"] = "pass"
```

**C2 uncertainty gate, C2 cont_prob gate:**
```python
gates_fired["c2_uncertainty_gate"] = "block" | "pass"
gates_fired["c2_cont_prob_gate"]   = "block" | "pass"
```

**Exhaustion guard:**
```python
gates_fired["exhaustion_guard"] = "block" | "boost" | "pass"
```

**Daily RSI gate, Vol climax gate, C2 inversion gate:**
```python
gates_fired["daily_rsi_gate"]    = "block" | "pass"
gates_fired["vol_climax_gate"]   = "block" | "pass"
gates_fired["c2_inversion_gate"] = "block" | "pass"
```

**Passare `gates_fired` al `DecisionResult` restituito:**

Ogni `return DecisionResult(...)` nella funzione `decide()` deve includere `gates_fired=gates_fired`. Ci sono diversi return: quello di `no_trade` per gate bloccato, e quello del trade reale. Tutti devono ricevere il dict aggiornato al momento del return.

Il campo `signal_native` da passare a `_log_inference` è il valore di `action` calcolato PRIMA che i gate possano restituire `no_trade`. Conviene tracciarlo con una variabile locale:
```python
# Dopo la logica di scoring, prima dei gate:
signal_pre_gates = "long" if prob_long >= threshold else ("short" if prob_short >= threshold else "no_trade")
```

Questo valore viene poi passato a `_log_inference` (§5.4).

---

## 5. Backend — `execution.py`

### 5.1 — `_open_position`: aggiungere campi analytics al dict `self._position`

**Firma:** aggiungere il parametro `entry_type: str = "market"`.

```python
async def _open_position(
    self,
    result: DecisionResult,
    snap: Optional[dict],
    atr: Optional[float],
    inference_id: Optional[str],
    cfg: Optional[BotConfig] = None,
    atr_sl: Optional[float] = None,
    sl_override: Optional[float] = None,
    tp_override: Optional[float] = None,
    size_usd_override: Optional[float] = None,
    entry_type: str = "market",      # ← nuovo parametro
):
```

**Nei call site** di `_open_position`, aggiungere `entry_type=`:

| Call site | `entry_type` da passare |
|-----------|------------------------|
| Chiamata normale da `_cycle` | `"market"` (default, nessuna modifica) |
| `_open_reversal_pending_position` | `"reversal"` |
| Pullback fill (da `_check_pullback_entry`) | `"pullback"` |
| Bounce-fade fill (da `_check_bounce_fade_entry`) | `"bounce_fade"` |

**Nel dict `self._position`** (~riga 2870), aggiungere dopo i campi esistenti:

```python
# ── Analytics tracking ────────────────────────────────────────────────────────
"entry_type":          entry_type,
"regime_at_entry":     (self._regime_signal.regime if self._regime_signal else None),
"lgbm_prob_at_entry":  result.directional_prob,
"c2_dir_prob_at_entry": getattr(result, "forecast_uncertainty", None),  # riusato dal c2 dict
# MFE/MAE tracking — inizializzati al prezzo di entry, aggiornati in _manage_position
"mfe_px": price,   # max favorable price reached (long: massimo, short: minimo)
"mae_px": price,   # max adverse price reached  (long: minimo, short: massimo)
```

> **Nota:** `c2_dir_prob_at_entry` viene popolato dal `c2_out["c2_dir_prob"]` disponibile nel
> call site di `_open_position`. Passarlo come parametro aggiuntivo o leggerlo dal dict
> `result.features_snapshot` se disponibile. Il `result.directional_prob` è il prob ensemble
> (già blend Chronos+LGBM), non il raw c2_dir_prob — distinguere i due campi nel DB.

### 5.2 — `_manage_position`: tracking MFE/MAE

**Posizione:** subito dopo `self._position["bars_held"] = ... + 1` e PRIMA del blocco trailing SL (~riga 2981).

```python
# ── MFE / MAE tracking (per calibrazione SL/TP — indipendente dal trailing SL) ──
if side == "long":
    self._position["mfe_px"] = max(self._position.get("mfe_px", current_price), current_price)
    self._position["mae_px"] = min(self._position.get("mae_px", current_price), current_price)
else:
    self._position["mfe_px"] = min(self._position.get("mfe_px", current_price), current_price)
    self._position["mae_px"] = max(self._position.get("mae_px", current_price), current_price)
```

> **Perché separato da `high_water`?**
> `high_water` è usato dal trailing SL ed è aggiornato solo quando il trailing è attivo.
> `mfe_px` e `mae_px` devono essere aggiornati **sempre**, indipendentemente dalla
> configurazione del trailing SL. Tenere i due sistemi separati evita side effects.

**Aggiornare anche `_persist_position_state`** per non perdere il progresso su restart.
Nel blocco `_live_position_state` (~riga 892), aggiungere:
```python
"mfe_px":              self._position.get("mfe_px"),
"mae_px":              self._position.get("mae_px"),
"entry_type":          self._position.get("entry_type", "market"),
"regime_at_entry":     self._position.get("regime_at_entry"),
"lgbm_prob_at_entry":  self._position.get("lgbm_prob_at_entry"),
"c2_dir_prob_at_entry":self._position.get("c2_dir_prob_at_entry"),
```

**In `_restore_paper_state`** (retrocompatibilità): dopo i backfill esistenti, aggiungere:
```python
if "mfe_px" not in self._position:
    self._position["mfe_px"] = self._position.get("entry_price", 0.0)
    self._position["mae_px"] = self._position.get("entry_price", 0.0)
```

### 5.3 — `_close_position`: salvare i campi analytics nel DB

Aggiungere il blocco di calcolo **prima** dell'insert su `trades` (~riga 3354):

```python
# ── Calcolo MAE / MFE / TP Reach per analytics ───────────────────────────────
_entry_atr    = self._position.get("entry_atr") or 0.0
_sl_px        = self._position.get("stop_loss",  0.0)
_tp_px        = self._position.get("take_profit", 0.0)
_mfe_px       = self._position.get("mfe_px", exit_price)
_mae_px       = self._position.get("mae_px", exit_price)

# SL/TP distance come % dell'entry price
_sl_pct = abs(entry - _sl_px) / entry * 100 if (entry > 0 and _sl_px > 0) else None
_tp_pct = abs(_tp_px - entry) / entry * 100 if (entry > 0 and _tp_px > 0) else None

# MFE/MAE come % dell'entry price (sempre positivi — rappresentano la distanza)
if side == "long":
    _mfe_pct   = (_mfe_px - entry) / entry * 100 if entry > 0 else None
    _mae_pct   = (entry - _mae_px) / entry * 100 if entry > 0 else None
    _tp_dist   = _tp_px - entry if (_tp_px and _tp_px > entry) else None
    _tp_reach  = min((_mfe_px - entry) / _tp_dist * 100, 100.0) if _tp_dist else None
else:
    _mfe_pct   = (entry - _mfe_px) / entry * 100 if entry > 0 else None
    _mae_pct   = (_mae_px - entry) / entry * 100 if entry > 0 else None
    _tp_dist   = entry - _tp_px if (_tp_px and _tp_px < entry) else None
    _tp_reach  = min((entry - _mfe_px) / _tp_dist * 100, 100.0) if _tp_dist else None

_analytics = {
    "entry_atr":       round(_entry_atr, 2) if _entry_atr else None,
    "sl_price":        round(_sl_px, 2) if _sl_px else None,
    "tp_price":        round(_tp_px, 2) if _tp_px else None,
    "sl_pct":          round(_sl_pct, 4) if _sl_pct is not None else None,
    "tp_pct":          round(_tp_pct, 4) if _tp_pct is not None else None,
    "mfe_pct":         round(_mfe_pct, 4) if _mfe_pct is not None else None,
    "mae_pct":         round(_mae_pct, 4) if _mae_pct is not None else None,
    "tp_reach_pct":    round(_tp_reach, 2) if _tp_reach is not None else None,
    "bars_held_final": self._position.get("bars_held", 0),
    "regime_at_entry": self._position.get("regime_at_entry"),
    "entry_type":      self._position.get("entry_type", "market"),
    "lgbm_prob":       round(self._position["lgbm_prob_at_entry"], 4)
                       if self._position.get("lgbm_prob_at_entry") else None,
    "c2_dir_prob":     round(self._position["c2_dir_prob_at_entry"], 4)
                       if self._position.get("c2_dir_prob_at_entry") else None,
}
```

**Nell'insert su `trades`** (il dict esistente), aggiungere `**_analytics` per unpacking:

```python
db.table("trades").insert({
    "bot_id":          "default",
    "entry_order_id":  self._position.get("trade_id"),
    "symbol":          SYMBOL,
    "side":            side,
    "entry_price":     round(entry, 2),
    "exit_price":      round(exit_price, 2),
    "pnl_usd":         round(total_pnl_usd, 2),
    "pnl_pct":         round(total_pnl_pct, 4),
    "partial_pnl_usd": round(partial_pnl, 2),
    "holding_sec":     int(holding_h * 3600),
    "reason_close":    _reason_close,
    "opened_at":       self._position["opened_at"],
    "closed_at":       datetime.now(timezone.utc).isoformat(),
    "mode":            self.mode,
    "inference_id":    self._position.get("inference_id"),
    **_analytics,      # ← tutti i campi analytics in un colpo solo
}).execute()
```

**Aggiornare `_valid_reasons`** per includere `"trend_exit"` e `"exhaust_max_hold"` che
esistono nel codice ma non erano nella lista (~riga 3352):

```python
_valid_reasons = {
    "stop_loss", "take_profit", "manual", "kill",
    "lgbm_exit", "trend_exit", "exhaust_max_hold",
    "max_hold_bars", "macro_pause", "exchange_close",
    "liquidation",   # futuro piano leva — gestito già ora per compatibilità
}
```

### 5.4 — `_log_inference`: aggiungere `gates_fired` e `signal_native`

Nella funzione `_log_inference` (~riga 4124), `result` è un `DecisionResult` che ora ha
`result.gates_fired` (§4.1). Aggiungere al dict dell'insert:

```python
db.table("inference_logs").insert({
    "id":              inference_id,
    "bot_id":          None,
    "model":           "chronos2_lgbm_ensemble_v2",
    "c2_dir_prob":     self._safe_float(c2.get("c2_dir_prob")),
    "c2_dir_prob_raw": self._safe_float(c2.get("c2_dir_prob_raw")),
    "c2_uncertainty":  self._safe_float(c2.get("c2_uncertainty")),
    "c2_cont_prob":    self._safe_float(c2.get("c2_cont_prob")),
    "features": {
        k: self._safe_float(v)
        for k, v in {**features, **covars}.items()
    },
    "forecast": {
        **{k: (self._safe_float(v) if isinstance(v, float) else v)
           for k, v in c2.items()},
        "lgbm_prob": safe_lgbm,
    },
    "decision":      result.action,
    "reasoning":     result.reasoning,
    "latency_ms":    c2.get("latency_ms", 0),
    # ── Nuovi campi analytics ─────────────────────────────────────────────
    "gates_fired":   result.gates_fired,         # dict strutturato da DecisionEngine
    "signal_native": getattr(result, "_signal_pre_gates", result.action),
    # _signal_pre_gates deve essere settato da DecisionEngine sul result (§4.2)
}).execute()
```

---

## 6. Backend — `main.py`: 3 nuovi endpoint

Aggiungere l'import pandas all'inizio del file (se non presente):
```python
import pandas as pd
```

I tre endpoint usano solo Supabase + pandas. Nessuna dipendenza aggiuntiva.

### 6.1 — `GET /analytics/diagnostics` (Overview tab)

```python
@app.get("/analytics/diagnostics")
async def analytics_diagnostics(
    mode: str = "all",        # "all" | "paper" | "live"
    days: int = 90,           # ultimi N giorni (0 = tutti)
):
    """
    Dati per il tab Overview dell'Analytics Panel.
    Restituisce KPI generali, exit reason breakdown, performance per regime,
    performance per LGBM probability bucket.
    """
    try:
        db = get_supabase()
        q  = db.table("trades").select(
            "pnl_usd, pnl_pct, reason_close, mode, closed_at, "
            "regime_at_entry, entry_type, lgbm_prob, c2_dir_prob, "
            "tp_reach_pct, bars_held_final, holding_sec"
        ).not_.is_("closed_at", "null")

        if mode != "all":
            q = q.eq("mode", mode)
        if days > 0:
            cutoff = (datetime.now(timezone.utc) - timedelta(days=days)).isoformat()
            q = q.gte("closed_at", cutoff)

        rows = q.order("closed_at", desc=False).execute().data

        if not rows:
            return {"n_trades": 0, "insufficient_data": True, "min_trades": 20}

        df = pd.DataFrame(rows)
        df["pnl_usd"] = pd.to_numeric(df["pnl_usd"], errors="coerce").fillna(0)
        df["pnl_pct"] = pd.to_numeric(df["pnl_pct"], errors="coerce").fillna(0)

        closed  = df
        wins    = df[df["pnl_usd"] > 0]
        losses  = df[df["pnl_usd"] <= 0]
        n       = len(df)
        wr      = len(wins) / n * 100 if n > 0 else 0

        # KPI principali
        kpi = {
            "n_trades":       n,
            "win_rate_pct":   round(wr, 1),
            "avg_pnl_usd":    round(df["pnl_usd"].mean(), 2),
            "total_pnl_usd":  round(df["pnl_usd"].sum(), 2),
            "avg_holding_h":  round(df["holding_sec"].mean() / 3600, 1) if "holding_sec" in df else None,
            "avg_tp_reach_pct": round(df["tp_reach_pct"].dropna().mean(), 1) if "tp_reach_pct" in df else None,
            "avg_bars_held":  round(df["bars_held_final"].dropna().mean(), 1) if "bars_held_final" in df else None,
            "insufficient_data": n < 20,
            "min_trades": 20,
        }

        # Exit reasons
        exit_stats = []
        for reason, grp in df.groupby("reason_close"):
            grp_wins = grp[grp["pnl_usd"] > 0]
            exit_stats.append({
                "reason":      reason,
                "count":       len(grp),
                "pct_of_total": round(len(grp) / n * 100, 1),
                "win_rate_pct": round(len(grp_wins) / len(grp) * 100, 1) if reason not in ("stop_loss",) else None,
                "avg_pnl_usd": round(grp["pnl_usd"].mean(), 2),
            })
        exit_stats.sort(key=lambda x: x["count"], reverse=True)

        # Performance per regime
        regime_stats = []
        if "regime_at_entry" in df.columns and df["regime_at_entry"].notna().any():
            for regime, grp in df.dropna(subset=["regime_at_entry"]).groupby("regime_at_entry"):
                grp_wins = grp[grp["pnl_usd"] > 0]
                regime_stats.append({
                    "regime":      regime,
                    "count":       len(grp),
                    "win_rate_pct": round(len(grp_wins) / len(grp) * 100, 1),
                    "avg_pnl_usd": round(grp["pnl_usd"].mean(), 2),
                })
            regime_stats.sort(key=lambda x: x["count"], reverse=True)

        # LGBM probability buckets
        lgbm_buckets = []
        if "lgbm_prob" in df.columns and df["lgbm_prob"].notna().any():
            _ldf = df.dropna(subset=["lgbm_prob"]).copy()
            bins = [0.60, 0.65, 0.70, 0.75, 0.80, 1.01]
            labels = ["0.60–0.65", "0.65–0.70", "0.70–0.75", "0.75–0.80", "0.80+"]
            _ldf["bucket"] = pd.cut(_ldf["lgbm_prob"], bins=bins, labels=labels, right=False)
            for bucket, grp in _ldf.groupby("bucket", observed=True):
                grp_wins = grp[grp["pnl_usd"] > 0]
                lgbm_buckets.append({
                    "bucket":      str(bucket),
                    "count":       len(grp),
                    "win_rate_pct": round(len(grp_wins) / len(grp) * 100, 1),
                    "avg_pnl_usd": round(grp["pnl_usd"].mean(), 2),
                })

        # Entry type breakdown
        entry_type_stats = []
        if "entry_type" in df.columns and df["entry_type"].notna().any():
            for etype, grp in df.dropna(subset=["entry_type"]).groupby("entry_type"):
                grp_wins = grp[grp["pnl_usd"] > 0]
                entry_type_stats.append({
                    "entry_type":  etype,
                    "count":       len(grp),
                    "win_rate_pct": round(len(grp_wins) / len(grp) * 100, 1),
                    "avg_pnl_usd": round(grp["pnl_usd"].mean(), 2),
                })

        return {
            "kpi":              kpi,
            "exit_reasons":     exit_stats,
            "by_regime":        regime_stats,
            "lgbm_buckets":     lgbm_buckets,
            "entry_type_stats": entry_type_stats,
        }

    except Exception as exc:
        log.error("analytics_diagnostics error: %s", exc, exc_info=True)
        raise HTTPException(status_code=500, detail=str(exc))
```

### 6.2 — `GET /analytics/gate-performance` (Gate Performance tab)

```python
@app.get("/analytics/gate-performance")
async def analytics_gate_performance(
    days: int = 90,
):
    """
    Analisi dei gate: quante volte ogni gate ha bloccato un segnale, e impatto.
    Join inference_logs (cicli bloccati) con trades (outcome se il segnale fosse passato).
    Nota: i cicli bloccati non hanno outcome diretto — la metrica è l'attivazione del gate.
    """
    try:
        db = get_supabase()
        cutoff = (datetime.now(timezone.utc) - timedelta(days=days)).isoformat() if days > 0 else None

        q = db.table("inference_logs").select("id, decision, gates_fired, signal_native, time")
        if cutoff:
            q = q.gte("time", cutoff)
        logs = q.order("time", desc=False).execute().data

        if not logs:
            return {"gate_stats": [], "n_cycles_analyzed": 0}

        n_cycles = len(logs)
        gate_summary: dict[str, dict] = {}

        for log_row in logs:
            gf = log_row.get("gates_fired") or {}
            for gate_name, gate_result in gf.items():
                if gate_name not in gate_summary:
                    gate_summary[gate_name] = {
                        "gate":          gate_name,
                        "total_fires":   0,
                        "blocks":        0,
                        "scales":        0,
                        "passes":        0,
                    }
                gate_summary[gate_name]["total_fires"] += 1
                if gate_result == "block":
                    gate_summary[gate_name]["blocks"] += 1
                elif gate_result == "scale":
                    gate_summary[gate_name]["scales"] += 1
                else:
                    gate_summary[gate_name]["passes"] += 1

        result_list = []
        for gate_name, stats in gate_summary.items():
            total = stats["total_fires"]
            result_list.append({
                **stats,
                "block_rate_pct": round(stats["blocks"] / total * 100, 1) if total > 0 else 0,
                "scale_rate_pct": round(stats["scales"] / total * 100, 1) if total > 0 else 0,
                "blocked_cycles_pct_of_total": round(stats["blocks"] / n_cycles * 100, 1),
            })

        result_list.sort(key=lambda x: x["blocks"], reverse=True)

        return {
            "n_cycles_analyzed": n_cycles,
            "gate_stats":        result_list,
        }

    except Exception as exc:
        log.error("analytics_gate_performance error: %s", exc, exc_info=True)
        raise HTTPException(status_code=500, detail=str(exc))
```

### 6.3 — `GET /analytics/sl-tp-calibration` (SL/TP Lab tab)

```python
@app.get("/analytics/sl-tp-calibration")
async def analytics_sl_tp_calibration(
    mode: str = "all",
    days: int = 90,
):
    """
    Calibrazione SL/TP basata su distribuzione empirica MAE/MFE.
    Restituisce distribuzioni percentili e simulatori SL/TP.
    Richiede almeno 20 trade con mfe_pct / mae_pct non null.
    """
    try:
        db = get_supabase()
        q  = db.table("trades").select(
            "pnl_usd, mae_pct, mfe_pct, tp_reach_pct, sl_pct, tp_pct, "
            "entry_atr, entry_price, reason_close, side, regime_at_entry"
        ).not_.is_("closed_at", "null").not_.is_("mae_pct", "null")

        if mode != "all":
            q = q.eq("mode", mode)
        if days > 0:
            cutoff = (datetime.now(timezone.utc) - timedelta(days=days)).isoformat()
            q = q.gte("closed_at", cutoff)

        rows = q.execute().data

        if len(rows) < 5:
            return {
                "insufficient_data": True,
                "n_trades_with_data": len(rows),
                "min_trades": 20,
                "message": "Dati MAE/MFE insufficienti. Questi campi sono disponibili solo per trade eseguiti dopo il deploy di Analytics.",
            }

        df = pd.DataFrame(rows)
        df["pnl_usd"] = pd.to_numeric(df["pnl_usd"], errors="coerce").fillna(0)
        df["mae_pct"] = pd.to_numeric(df["mae_pct"], errors="coerce")
        df["mfe_pct"] = pd.to_numeric(df["mfe_pct"], errors="coerce")

        winners = df[df["pnl_usd"] > 0].dropna(subset=["mfe_pct"])
        losers  = df[df["pnl_usd"] <= 0].dropna(subset=["mae_pct"])
        all_mae = df.dropna(subset=["mae_pct"])

        # Distribuzioni percentili MAE (tutti i trade)
        mae_dist = {
            f"p{p}": round(float(all_mae["mae_pct"].quantile(p / 100)), 3)
            for p in [10, 25, 50, 75, 90, 95]
        } if len(all_mae) > 0 else {}

        # Distribuzioni percentili MFE (solo vincitori)
        mfe_dist = {
            f"p{p}": round(float(winners["mfe_pct"].quantile(p / 100)), 3)
            for p in [10, 25, 50, 75, 90]
        } if len(winners) > 0 else {}

        # Simulatore SL: per ogni SL% candidate, quanti vincitori sarebbero stati stoppati?
        sl_candidates = [0.5, 0.8, 1.0, 1.2, 1.5, 1.8, 2.0, 2.5, 3.0]
        sl_sim = []
        for sl_c in sl_candidates:
            w_stopped = (winners["mae_pct"] > sl_c).mean() if len(winners) > 0 else 0
            l_stopped = (losers["mae_pct"] > sl_c).mean() if len(losers) > 0 else 0
            sl_sim.append({
                "sl_pct_candidate":            sl_c,
                "winners_falsely_stopped_pct": round(w_stopped * 100, 1),
                "losers_correctly_caught_pct": round(l_stopped * 100, 1),
            })

        # Simulatore TP: per ogni TP% candidate, in quanti trade viene raggiunto?
        tp_candidates = [1.0, 1.5, 2.0, 2.5, 3.0, 3.5, 4.0, 5.0]
        tp_sim = []
        for tp_c in tp_candidates:
            hit_rate = (winners["mfe_pct"] >= tp_c).mean() if len(winners) > 0 else 0
            tp_sim.append({
                "tp_pct_candidate":         tp_c,
                "hit_rate_on_winners_pct":  round(hit_rate * 100, 1),
                "hit_rate_all_trades_pct":  round((df["mfe_pct"].dropna() >= tp_c).mean() * 100, 1),
            })

        # Raccomandazione automatica
        # SL ottimale: il valore dove winners_falsely_stopped < 10% e losers_correctly_caught > 75%
        rec_sl = None
        for row in sl_sim:
            if row["winners_falsely_stopped_pct"] < 10 and row["losers_correctly_caught_pct"] > 75:
                rec_sl = row["sl_pct_candidate"]
                break

        # TP ottimale: il valore più alto dove hit_rate_on_winners > 50%
        rec_tp = None
        for row in reversed(tp_sim):
            if row["hit_rate_on_winners_pct"] > 50:
                rec_tp = row["tp_pct_candidate"]
                break

        # Converti % in ATR multiple usando ATR medio al momento dell'entry
        avg_atr_pct = None
        if "entry_atr" in df.columns and "entry_price" in df.columns:
            _atr_vals = (df["entry_atr"] / df["entry_price"] * 100).dropna()
            avg_atr_pct = round(float(_atr_vals.mean()), 3) if len(_atr_vals) > 0 else None

        recommendation = None
        if rec_sl is not None and avg_atr_pct and avg_atr_pct > 0:
            recommendation = {
                "sl_pct":      rec_sl,
                "sl_atr_mult": round(rec_sl / avg_atr_pct, 2),
                "tp_pct":      rec_tp,
                "tp_atr_mult": round(rec_tp / avg_atr_pct, 2) if rec_tp else None,
                "avg_atr_pct": avg_atr_pct,
                "avg_tp_reach_pct": round(float(df["tp_reach_pct"].dropna().mean()), 1) if "tp_reach_pct" in df else None,
            }

        return {
            "n_trades":         len(df),
            "n_winners":        len(winners),
            "n_losers":         len(losers),
            "insufficient_data": len(df) < 20,
            "win_rate_pct":     round(len(winners) / len(df) * 100, 1),
            "mae_distribution": mae_dist,
            "mfe_distribution_winners": mfe_dist,
            "sl_simulation":    sl_sim,
            "tp_simulation":    tp_sim,
            "recommendation":   recommendation,
        }

    except Exception as exc:
        log.error("analytics_sl_tp_calibration error: %s", exc, exc_info=True)
        raise HTTPException(status_code=500, detail=str(exc))
```

---

## 7. Frontend — `AnalyticsPanel.tsx`

Creare il file `/apps/web/components/trading-hub/AnalyticsPanel.tsx`.

Il componente usa esclusivamente classi Tailwind già in uso nel progetto (nessuna dipendenza aggiuntiva). La struttura è 3 tab interni: Overview, Gate Performance, SL/TP Lab.

```tsx
import React, { useState, useEffect, useCallback } from 'react';

// ── Tipi API ─────────────────────────────────────────────────────────────────

interface DiagnosticsData {
  kpi: {
    n_trades: number;
    win_rate_pct: number;
    avg_pnl_usd: number;
    total_pnl_usd: number;
    avg_holding_h: number | null;
    avg_tp_reach_pct: number | null;
    avg_bars_held: number | null;
    insufficient_data: boolean;
    min_trades: number;
  };
  exit_reasons: Array<{
    reason: string;
    count: number;
    pct_of_total: number;
    win_rate_pct: number | null;
    avg_pnl_usd: number;
  }>;
  by_regime: Array<{
    regime: string;
    count: number;
    win_rate_pct: number;
    avg_pnl_usd: number;
  }>;
  lgbm_buckets: Array<{
    bucket: string;
    count: number;
    win_rate_pct: number;
    avg_pnl_usd: number;
  }>;
  entry_type_stats: Array<{
    entry_type: string;
    count: number;
    win_rate_pct: number;
    avg_pnl_usd: number;
  }>;
}

interface GateData {
  n_cycles_analyzed: number;
  gate_stats: Array<{
    gate: string;
    total_fires: number;
    blocks: number;
    scales: number;
    passes: number;
    block_rate_pct: number;
    scale_rate_pct: number;
    blocked_cycles_pct_of_total: number;
  }>;
}

interface CalibrationData {
  n_trades: number;
  n_winners: number;
  n_losers: number;
  win_rate_pct: number;
  insufficient_data: boolean;
  mae_distribution: Record<string, number>;
  mfe_distribution_winners: Record<string, number>;
  sl_simulation: Array<{
    sl_pct_candidate: number;
    winners_falsely_stopped_pct: number;
    losers_correctly_caught_pct: number;
  }>;
  tp_simulation: Array<{
    tp_pct_candidate: number;
    hit_rate_on_winners_pct: number;
    hit_rate_all_trades_pct: number;
  }>;
  recommendation: {
    sl_pct: number;
    sl_atr_mult: number;
    tp_pct: number | null;
    tp_atr_mult: number | null;
    avg_atr_pct: number;
    avg_tp_reach_pct: number | null;
  } | null;
  message?: string;
}

type AnalyticsTab = 'overview' | 'gates' | 'sltp';
type ModeFilter   = 'all' | 'paper' | 'live';
type DaysFilter   = 30 | 60 | 90 | 0;

// ── Componenti locali ─────────────────────────────────────────────────────────

const KpiCard: React.FC<{
  label: string;
  value: string;
  sub?: string;
  color?: string;
}> = ({ label, value, sub, color = 'text-slate-900 dark:text-white' }) => (
  <div className="bg-white dark:bg-white/5 rounded-2xl border border-slate-100 dark:border-white/10 p-4 space-y-1">
    <p className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">{label}</p>
    <p className={`text-2xl font-bold font-mono ${color}`}>{value}</p>
    {sub && <p className="text-[10px] text-slate-500">{sub}</p>}
  </div>
);

const InsufficientDataBanner: React.FC<{ current: number; min: number }> = ({ current, min }) => (
  <div className="rounded-xl border border-amber-200 dark:border-amber-500/30 bg-amber-50 dark:bg-amber-500/10 px-4 py-3 flex gap-3 items-start">
    <svg className="w-4 h-4 text-amber-500 mt-0.5 flex-shrink-0" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.007v.008H12v-.008z" />
    </svg>
    <div>
      <p className="text-xs font-semibold text-amber-700 dark:text-amber-400">
        Dati insufficienti ({current} / {min} trade minimi)
      </p>
      <p className="text-[11px] text-amber-600 dark:text-amber-500 mt-0.5">
        Le statistiche hanno alta varianza. Evita decisioni di calibrazione fino a {min}+ trade completati.
      </p>
    </div>
  </div>
);

const BarRow: React.FC<{
  label: string;
  pct: number;
  maxPct: number;
  left?: string;
  right?: string;
  color?: string;
}> = ({ label, pct, maxPct, left, right, color = 'bg-indigo-500' }) => {
  const barW = maxPct > 0 ? Math.min((pct / maxPct) * 100, 100) : 0;
  return (
    <div className="flex items-center gap-3 py-2">
      <span className="text-xs text-slate-600 dark:text-slate-300 w-28 shrink-0 truncate">{label}</span>
      <div className="flex-1 h-2 bg-slate-100 dark:bg-white/5 rounded-full overflow-hidden">
        <div className={`h-full rounded-full ${color}`} style={{ width: `${barW}%` }} />
      </div>
      {left  && <span className="text-xs font-mono text-slate-500 w-12 text-right">{left}</span>}
      {right && <span className="text-xs font-mono text-slate-400 w-20 text-right">{right}</span>}
    </div>
  );
};

// ── Helper ────────────────────────────────────────────────────────────────────

const fmtPnl = (v: number) =>
  `${v >= 0 ? '+' : ''}$${Math.abs(v).toFixed(2)}`;

const exitReasonLabel: Record<string, string> = {
  take_profit:    'Take Profit',
  stop_loss:      'Stop Loss',
  lgbm_exit:      'LGBM Exit',
  trend_exit:     'Trend Exit',
  max_hold_bars:  'Max Hold',
  exhaust_max_hold: 'Exhaust Hold',
  macro_pause:    'Macro Pause',
  manual:         'Manuale',
  kill:           'Kill Switch',
  exchange_close: 'Exchange Close',
  liquidation:    'Liquidazione',
};

const gateLabel: Record<string, string> = {
  adx_gate:           'ADX Gate',
  sweep_gate:         'Sweep Gate',
  confluence_gate:    'Confluence Gate',
  atr_pct_gate:       'ATR% Gate',
  oi_spike_gate:      'OI Spike Gate',
  ls_gate:            'L/S Ratio Gate',
  liq_spike_gate:     'Liq Spike Gate',
  c2_uncertainty_gate:'C2 Uncertainty',
  c2_cont_prob_gate:  'C2 Cont Prob',
  exhaustion_guard:   'Exhaustion Guard',
  daily_rsi_gate:     'Daily RSI Gate',
  vol_climax_gate:    'Vol Climax Gate',
  c2_inversion_gate:  'C2 Inversion',
  weekend_gate:       'Weekend Gate',
};

// ── Componente principale ─────────────────────────────────────────────────────

export const AnalyticsPanel: React.FC<{ apiBase: string }> = ({ apiBase }) => {
  const [tab,        setTab]        = useState<AnalyticsTab>('overview');
  const [mode,       setMode]       = useState<ModeFilter>('all');
  const [days,       setDays]       = useState<DaysFilter>(90);
  const [loading,    setLoading]    = useState(false);

  const [diagData,   setDiagData]   = useState<DiagnosticsData | null>(null);
  const [gateData,   setGateData]   = useState<GateData | null>(null);
  const [calibData,  setCalibData]  = useState<CalibrationData | null>(null);
  const [error,      setError]      = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const qs = `?mode=${mode}&days=${days}`;
    try {
      const [dRes, gRes, cRes] = await Promise.all([
        fetch(`${apiBase}/analytics/diagnostics${qs}`),
        fetch(`${apiBase}/analytics/gate-performance?days=${days}`),
        fetch(`${apiBase}/analytics/sl-tp-calibration${qs}`),
      ]);
      const [d, g, c] = await Promise.all([dRes.json(), gRes.json(), cRes.json()]);
      setDiagData(d);
      setGateData(g);
      setCalibData(c);
    } catch (e) {
      setError('Errore nel caricamento dati analytics. Verifica che il backend sia aggiornato.');
    } finally {
      setLoading(false);
    }
  }, [apiBase, mode, days]);

  useEffect(() => { load(); }, [load]);

  // ── Render header ──────────────────────────────────────────────────────────

  return (
    <div className="space-y-6">

      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h2 className="text-xl font-bold text-slate-900 dark:text-white">Analytics</h2>
          <p className="text-xs text-slate-500 mt-0.5">Diagnosi performance · Calibrazione SL/TP</p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          {/* Mode filter */}
          <div className="flex rounded-xl overflow-hidden border border-slate-200 dark:border-white/10 text-xs font-semibold">
            {(['all','paper','live'] as ModeFilter[]).map(m => (
              <button key={m} onClick={() => setMode(m)}
                className={`px-3 py-1.5 capitalize transition-colors ${
                  mode === m
                    ? 'bg-indigo-600 text-white'
                    : 'bg-white dark:bg-white/5 text-slate-500 dark:text-slate-400 hover:bg-slate-50 dark:hover:bg-white/10'
                }`}
              >{m}</button>
            ))}
          </div>
          {/* Days filter */}
          <div className="flex rounded-xl overflow-hidden border border-slate-200 dark:border-white/10 text-xs font-semibold">
            {([30, 60, 90, 0] as DaysFilter[]).map(d => (
              <button key={d} onClick={() => setDays(d)}
                className={`px-3 py-1.5 transition-colors ${
                  days === d
                    ? 'bg-indigo-600 text-white'
                    : 'bg-white dark:bg-white/5 text-slate-500 dark:text-slate-400 hover:bg-slate-50 dark:hover:bg-white/10'
                }`}
              >{d === 0 ? 'Tutto' : `${d}gg`}</button>
            ))}
          </div>
          {/* Refresh */}
          <button onClick={load} disabled={loading}
            className="p-2 rounded-xl border border-slate-200 dark:border-white/10 bg-white dark:bg-white/5 text-slate-500 hover:text-slate-900 dark:hover:text-white transition-colors disabled:opacity-40"
            title="Aggiorna"
          >
            <svg className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0l3.181 3.183a8.25 8.25 0 0013.803-3.7M4.031 9.865a8.25 8.25 0 0113.803-3.7l3.181 3.182m0-4.991v4.99" />
            </svg>
          </button>
        </div>
      </div>

      {/* Error */}
      {error && (
        <div className="rounded-xl border border-red-200 dark:border-red-500/30 bg-red-50 dark:bg-red-500/10 px-4 py-3 text-xs text-red-600 dark:text-red-400">
          {error}
        </div>
      )}

      {/* Tab selettore */}
      <div className="flex gap-1 bg-slate-100 dark:bg-white/5 rounded-xl p-1 w-fit">
        {([
          { id: 'overview', label: 'Overview' },
          { id: 'gates',    label: 'Gate Performance' },
          { id: 'sltp',     label: 'SL/TP Lab' },
        ] as { id: AnalyticsTab; label: string }[]).map(t => (
          <button key={t.id} onClick={() => setTab(t.id)}
            className={`px-4 py-2 rounded-lg text-xs font-semibold transition-all ${
              tab === t.id
                ? 'bg-white dark:bg-white/10 text-slate-900 dark:text-white shadow-sm'
                : 'text-slate-500 dark:text-slate-400 hover:text-slate-800 dark:hover:text-slate-200'
            }`}
          >{t.label}</button>
        ))}
      </div>

      {/* ── TAB: Overview ───────────────────────────────────────────────────── */}
      {tab === 'overview' && diagData && (
        <div className="space-y-6">
          {diagData.kpi.insufficient_data && (
            <InsufficientDataBanner current={diagData.kpi.n_trades} min={diagData.kpi.min_trades} />
          )}

          {/* KPI cards */}
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
            <KpiCard label="Trade totali" value={String(diagData.kpi.n_trades)} />
            <KpiCard
              label="Win Rate"
              value={`${diagData.kpi.win_rate_pct.toFixed(1)}%`}
              color={diagData.kpi.win_rate_pct >= 55 ? 'text-emerald-600 dark:text-emerald-400' : 'text-amber-600 dark:text-amber-400'}
            />
            <KpiCard
              label="Avg PnL / Trade"
              value={fmtPnl(diagData.kpi.avg_pnl_usd)}
              color={diagData.kpi.avg_pnl_usd >= 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-500'}
            />
            <KpiCard label="Avg Holding" value={diagData.kpi.avg_holding_h !== null ? `${diagData.kpi.avg_holding_h}h` : '—'} />
            <KpiCard
              label="TP Reach avg"
              value={diagData.kpi.avg_tp_reach_pct !== null ? `${diagData.kpi.avg_tp_reach_pct}%` : '—'}
              sub={diagData.kpi.avg_tp_reach_pct !== null && diagData.kpi.avg_tp_reach_pct < 65 ? '⚠ TP troppo lontano' : undefined}
              color={
                diagData.kpi.avg_tp_reach_pct === null ? 'text-slate-400' :
                diagData.kpi.avg_tp_reach_pct < 50 ? 'text-red-500' :
                diagData.kpi.avg_tp_reach_pct < 65 ? 'text-amber-500 dark:text-amber-400' :
                'text-emerald-600 dark:text-emerald-400'
              }
            />
          </div>

          {/* Exit Reasons */}
          <div className="bg-white dark:bg-white/5 rounded-2xl border border-slate-100 dark:border-white/10 p-5 space-y-3">
            <h3 className="text-xs font-bold text-slate-400 uppercase tracking-widest">Exit Reasons</h3>
            <div className="divide-y divide-slate-50 dark:divide-white/5">
              {diagData.exit_reasons.map(r => (
                <BarRow
                  key={r.reason}
                  label={exitReasonLabel[r.reason] ?? r.reason}
                  pct={r.pct_of_total}
                  maxPct={100}
                  left={`${r.pct_of_total}%`}
                  right={r.win_rate_pct !== null
                    ? `WR ${r.win_rate_pct}%  ${fmtPnl(r.avg_pnl_usd)}`
                    : fmtPnl(r.avg_pnl_usd)
                  }
                  color={r.reason === 'stop_loss' ? 'bg-red-400' : r.reason === 'take_profit' ? 'bg-emerald-500' : 'bg-indigo-500'}
                />
              ))}
            </div>
          </div>

          {/* Per Regime */}
          {diagData.by_regime.length > 0 && (
            <div className="bg-white dark:bg-white/5 rounded-2xl border border-slate-100 dark:border-white/10 p-5 space-y-3">
              <h3 className="text-xs font-bold text-slate-400 uppercase tracking-widest">Performance per Regime</h3>
              <div className="divide-y divide-slate-50 dark:divide-white/5">
                {diagData.by_regime.map(r => (
                  <BarRow
                    key={r.regime}
                    label={r.regime}
                    pct={r.win_rate_pct}
                    maxPct={100}
                    left={`WR ${r.win_rate_pct}%`}
                    right={`${r.count} trade  ${fmtPnl(r.avg_pnl_usd)}`}
                    color={r.win_rate_pct >= 60 ? 'bg-emerald-500' : r.win_rate_pct >= 50 ? 'bg-amber-400' : 'bg-red-400'}
                  />
                ))}
              </div>
              {diagData.by_regime.some(r => r.win_rate_pct < 50 && r.count >= 5) && (
                <p className="text-[10px] text-amber-500 dark:text-amber-400 pt-1">
                  💡 I regimi con WR &lt; 50% su 5+ trade suggeriscono di considerare <code>forced_regime</code> o threshold più conservativi.
                </p>
              )}
            </div>
          )}

          {/* LGBM Buckets */}
          {diagData.lgbm_buckets.length > 0 && (
            <div className="bg-white dark:bg-white/5 rounded-2xl border border-slate-100 dark:border-white/10 p-5 space-y-3">
              <h3 className="text-xs font-bold text-slate-400 uppercase tracking-widest">LGBM Prob → Win Rate effettivo</h3>
              <div className="divide-y divide-slate-50 dark:divide-white/5">
                {diagData.lgbm_buckets.map(b => (
                  <BarRow
                    key={b.bucket}
                    label={b.bucket}
                    pct={b.win_rate_pct}
                    maxPct={100}
                    left={`WR ${b.win_rate_pct}%`}
                    right={`${b.count} trade`}
                    color={b.win_rate_pct >= 65 ? 'bg-emerald-500' : b.win_rate_pct >= 55 ? 'bg-indigo-400' : 'bg-amber-400'}
                  />
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {/* ── TAB: Gate Performance ───────────────────────────────────────────── */}
      {tab === 'gates' && gateData && (
        <div className="space-y-4">
          <p className="text-xs text-slate-500">
            Analizzati <strong className="text-slate-700 dark:text-slate-300">{gateData.n_cycles_analyzed}</strong> cicli.
            I gate con più "block" filtrano il maggior numero di segnali — verificare se giustificato.
          </p>

          {gateData.gate_stats.length === 0 ? (
            <div className="rounded-xl border border-slate-100 dark:border-white/10 bg-white dark:bg-white/5 p-8 text-center text-xs text-slate-400">
              Nessun dato gates_fired trovato.<br />
              Disponibile solo per cicli eseguiti dopo il deploy di Analytics.
            </div>
          ) : (
            <div className="bg-white dark:bg-white/5 rounded-2xl border border-slate-100 dark:border-white/10 overflow-hidden">
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b border-slate-100 dark:border-white/10">
                    <th className="text-left px-5 py-3 text-slate-400 font-semibold uppercase tracking-wider">Gate</th>
                    <th className="text-right px-4 py-3 text-slate-400 font-semibold uppercase tracking-wider">Block</th>
                    <th className="text-right px-4 py-3 text-slate-400 font-semibold uppercase tracking-wider">Scale</th>
                    <th className="text-right px-4 py-3 text-slate-400 font-semibold uppercase tracking-wider">Pass</th>
                    <th className="text-right px-4 py-3 text-slate-400 font-semibold uppercase tracking-wider">% cicli bloccati</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-50 dark:divide-white/5">
                  {gateData.gate_stats.map(g => (
                    <tr key={g.gate} className="hover:bg-slate-50 dark:hover:bg-white/[0.02] transition-colors">
                      <td className="px-5 py-3 font-medium text-slate-700 dark:text-slate-200">
                        {gateLabel[g.gate] ?? g.gate}
                      </td>
                      <td className="px-4 py-3 text-right font-mono text-red-500">{g.blocks}</td>
                      <td className="px-4 py-3 text-right font-mono text-amber-500">{g.scales}</td>
                      <td className="px-4 py-3 text-right font-mono text-emerald-500">{g.passes}</td>
                      <td className="px-4 py-3 text-right font-mono text-slate-500">
                        {g.blocked_cycles_pct_of_total}%
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* ── TAB: SL/TP Lab ──────────────────────────────────────────────────── */}
      {tab === 'sltp' && calibData && (
        <div className="space-y-6">
          {(calibData.insufficient_data || (calibData.message)) && (
            <div className="rounded-xl border border-amber-200 dark:border-amber-500/30 bg-amber-50 dark:bg-amber-500/10 px-4 py-3 text-xs text-amber-700 dark:text-amber-400">
              {calibData.message ?? `Dati insufficienti (${calibData.n_trades} / 20 trade minimi con dati MAE/MFE). Questi campi vengono raccolti solo sui trade chiusi dopo il deploy di Analytics.`}
            </div>
          )}

          {/* Distribuzione MAE / MFE */}
          <div className="grid sm:grid-cols-2 gap-4">
            {/* MAE */}
            <div className="bg-white dark:bg-white/5 rounded-2xl border border-slate-100 dark:border-white/10 p-5 space-y-3">
              <div>
                <h3 className="text-xs font-bold text-slate-400 uppercase tracking-widest">MAE — Max Adverse Excursion</h3>
                <p className="text-[10px] text-slate-400 mt-0.5">Quanto il prezzo si muove contro la posizione prima della chiusura</p>
              </div>
              <div className="space-y-1.5">
                {Object.entries(calibData.mae_distribution).map(([k, v]) => (
                  <div key={k} className="flex justify-between text-xs">
                    <span className="text-slate-500 font-mono">{k}</span>
                    <span className="font-mono font-semibold text-slate-700 dark:text-slate-200">{v.toFixed(2)}%</span>
                  </div>
                ))}
              </div>
            </div>

            {/* MFE vincitori */}
            <div className="bg-white dark:bg-white/5 rounded-2xl border border-slate-100 dark:border-white/10 p-5 space-y-3">
              <div>
                <h3 className="text-xs font-bold text-slate-400 uppercase tracking-widest">MFE — Max Favorable (vincitori)</h3>
                <p className="text-[10px] text-slate-400 mt-0.5">Massimo vantaggio raggiunto nei trade vincitori</p>
              </div>
              <div className="space-y-1.5">
                {Object.entries(calibData.mfe_distribution_winners).map(([k, v]) => (
                  <div key={k} className="flex justify-between text-xs">
                    <span className="text-slate-500 font-mono">{k}</span>
                    <span className="font-mono font-semibold text-emerald-600 dark:text-emerald-400">{v.toFixed(2)}%</span>
                  </div>
                ))}
              </div>
            </div>
          </div>

          {/* Simulatori */}
          <div className="grid sm:grid-cols-2 gap-4">
            {/* SL Simulator */}
            <div className="bg-white dark:bg-white/5 rounded-2xl border border-slate-100 dark:border-white/10 overflow-hidden">
              <div className="px-5 py-3 border-b border-slate-100 dark:border-white/10">
                <h3 className="text-xs font-bold text-slate-400 uppercase tracking-widest">SL Simulator</h3>
                <p className="text-[10px] text-slate-400 mt-0.5">Per ogni SL%, impatto su vincitori e perdenti</p>
              </div>
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b border-slate-50 dark:border-white/5">
                    <th className="text-right px-4 py-2 text-slate-400 font-semibold">SL%</th>
                    <th className="text-right px-4 py-2 text-slate-400 font-semibold">W stoppati</th>
                    <th className="text-right px-4 py-2 text-slate-400 font-semibold">L presi</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-50 dark:divide-white/5">
                  {calibData.sl_simulation.map(row => {
                    const isOptimal = calibData.recommendation?.sl_pct === row.sl_pct_candidate;
                    return (
                      <tr key={row.sl_pct_candidate}
                        className={`${isOptimal ? 'bg-indigo-50 dark:bg-indigo-500/10' : 'hover:bg-slate-50 dark:hover:bg-white/[0.02]'} transition-colors`}>
                        <td className={`px-4 py-2 text-right font-mono font-bold ${isOptimal ? 'text-indigo-600 dark:text-indigo-400' : 'text-slate-700 dark:text-slate-300'}`}>
                          {row.sl_pct_candidate}%{isOptimal && ' ★'}
                        </td>
                        <td className="px-4 py-2 text-right font-mono text-red-400">{row.winners_falsely_stopped_pct}%</td>
                        <td className="px-4 py-2 text-right font-mono text-emerald-500">{row.losers_correctly_caught_pct}%</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            {/* TP Simulator */}
            <div className="bg-white dark:bg-white/5 rounded-2xl border border-slate-100 dark:border-white/10 overflow-hidden">
              <div className="px-5 py-3 border-b border-slate-100 dark:border-white/10">
                <h3 className="text-xs font-bold text-slate-400 uppercase tracking-widest">TP Simulator</h3>
                <p className="text-[10px] text-slate-400 mt-0.5">Hit rate sui vincitori per ogni TP%</p>
              </div>
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b border-slate-50 dark:border-white/5">
                    <th className="text-right px-4 py-2 text-slate-400 font-semibold">TP%</th>
                    <th className="text-right px-4 py-2 text-slate-400 font-semibold">Hit (vincitori)</th>
                    <th className="text-right px-4 py-2 text-slate-400 font-semibold">Hit (tutti)</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-50 dark:divide-white/5">
                  {calibData.tp_simulation.map(row => {
                    const isOptimal = calibData.recommendation?.tp_pct === row.tp_pct_candidate;
                    return (
                      <tr key={row.tp_pct_candidate}
                        className={`${isOptimal ? 'bg-indigo-50 dark:bg-indigo-500/10' : 'hover:bg-slate-50 dark:hover:bg-white/[0.02]'} transition-colors`}>
                        <td className={`px-4 py-2 text-right font-mono font-bold ${isOptimal ? 'text-indigo-600 dark:text-indigo-400' : 'text-slate-700 dark:text-slate-300'}`}>
                          {row.tp_pct_candidate}%{isOptimal && ' ★'}
                        </td>
                        <td className="px-4 py-2 text-right font-mono text-emerald-500">{row.hit_rate_on_winners_pct}%</td>
                        <td className="px-4 py-2 text-right font-mono text-slate-400">{row.hit_rate_all_trades_pct}%</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>

          {/* Recommendation card */}
          {calibData.recommendation && (
            <div className="rounded-2xl border border-indigo-200 dark:border-indigo-500/30 bg-indigo-50 dark:bg-indigo-500/10 p-5 space-y-3">
              <h3 className="text-xs font-bold text-indigo-600 dark:text-indigo-400 uppercase tracking-widest">
                Raccomandazione basata sui dati ({calibData.n_trades} trade)
              </h3>
              <div className="grid sm:grid-cols-2 gap-4">
                <div className="space-y-1">
                  <p className="text-[10px] text-slate-500 uppercase font-semibold">SL ottimale</p>
                  <p className="text-xl font-bold font-mono text-slate-900 dark:text-white">
                    {calibData.recommendation.sl_pct}%
                    <span className="text-sm font-normal text-slate-400 ml-2">
                      = {calibData.recommendation.sl_atr_mult}×ATR
                    </span>
                  </p>
                </div>
                {calibData.recommendation.tp_pct && (
                  <div className="space-y-1">
                    <p className="text-[10px] text-slate-500 uppercase font-semibold">TP ottimale</p>
                    <p className="text-xl font-bold font-mono text-slate-900 dark:text-white">
                      {calibData.recommendation.tp_pct}%
                      <span className="text-sm font-normal text-slate-400 ml-2">
                        = {calibData.recommendation.tp_atr_mult}×ATR
                      </span>
                    </p>
                  </div>
                )}
              </div>
              {calibData.recommendation.avg_tp_reach_pct !== null && (
                <p className="text-[11px] text-slate-600 dark:text-slate-400">
                  TP Reach medio attuale: <strong>{calibData.recommendation.avg_tp_reach_pct}%</strong> del percorso verso TP.
                  {calibData.recommendation.avg_tp_reach_pct < 65 && ' Il TP corrente viene raggiunto raramente — abbassarlo aumenterà il take rate.'}
                </p>
              )}
              <p className="text-[10px] text-slate-400">
                Per applicare: vai in <strong>Bot Config</strong> e aggiorna manualmente <code>sl_atr_mult</code> e <code>tp_atr_mult</code>.
              </p>
            </div>
          )}
        </div>
      )}

      {/* Loading overlay */}
      {loading && (
        <div className="fixed inset-0 bg-white/30 dark:bg-black/30 backdrop-blur-sm flex items-center justify-center z-50">
          <div className="bg-white dark:bg-[#151E32] rounded-2xl px-6 py-4 flex items-center gap-3 shadow-xl border border-slate-100 dark:border-white/10">
            <svg className="w-5 h-5 text-indigo-500 animate-spin" fill="none" viewBox="0 0 24 24">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"/>
            </svg>
            <span className="text-sm font-medium text-slate-700 dark:text-slate-200">Caricamento analytics…</span>
          </div>
        </div>
      )}
    </div>
  );
};
```

---

## 8. Frontend — `TradingHubTab.tsx`

### 8.1 — Aggiungere il tipo e l'import

```tsx
// Aggiungere all'import esistente:
import { AnalyticsPanel } from './AnalyticsPanel';

// Aggiungere 'analytics' al tipo HubPage (riga 13):
type HubPage = 'monitor' | 'forecast' | 'config' | 'trades' | 'analytics' | 'backtest' | 'regime' | 'reversal' | 'logs' | 'server' | 'settings';
```

### 8.2 — Aggiungere la voce nel NAV array

Inserire **dopo la voce `trades`** (riga ~60) e prima di `backtest`:

```tsx
{
  id: 'analytics',
  label: 'Analytics',
  icon: (
    <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" d="M3 13.125C3 12.504 3.504 12 4.125 12h2.25c.621 0 1.125.504 1.125 1.125v6.75C7.5 20.496 6.996 21 6.375 21h-2.25A1.125 1.125 0 013 19.875v-6.75zM9.75 8.625c0-.621.504-1.125 1.125-1.125h2.25c.621 0 1.125.504 1.125 1.125v11.25c0 .621-.504 1.125-1.125 1.125h-2.25a1.125 1.125 0 01-1.125-1.125V8.625zM16.5 4.125c0-.621.504-1.125 1.125-1.125h2.25C20.496 3 21 3.504 21 4.125v15.75c0 .621-.504 1.125-1.125 1.125h-2.25a1.125 1.125 0 01-1.125-1.125V4.125z" />
    </svg>
  )
},
```

### 8.3 — Aggiungere il routing nel `<main>`

```tsx
{page === 'analytics' && <AnalyticsPanel apiBase={API_BASE} />}
```

---

## 9. Ordine di implementazione

```
Step 1 — Database migration (5 min)
  ├── Eseguire SQL §3.1 su Supabase (trades table)
  └── Eseguire SQL §3.2 su Supabase (inference_logs table)

Step 2 — decision.py (30 min)
  ├── Aggiungere field gates_fired a DecisionResult (§4.1)
  └── Popolare gates_fired in DecisionEngine.decide() per ogni gate (§4.2)
      PRIORITÀ: adx_gate, sweep_gate, confluence_gate (i più frequenti)
      Gli altri gate possono essere aggiunti progressivamente

Step 3 — execution.py: _open_position (20 min)
  ├── Aggiungere parametro entry_type alla firma (§5.1)
  ├── Aggiornare i 4 call site con entry_type corretto (§5.1)
  └── Aggiungere campi analytics al dict self._position (§5.1)

Step 4 — execution.py: _manage_position (10 min)
  └── Aggiungere tracking mfe_px / mae_px unconditionale (§5.2)

Step 5 — execution.py: _close_position (20 min)
  ├── Aggiungere blocco calcolo _analytics (§5.3)
  ├── Aggiungere **_analytics all'insert su trades (§5.3)
  └── Aggiornare _valid_reasons (§5.3)

Step 6 — execution.py: _log_inference (10 min)
  └── Aggiungere gates_fired e signal_native all'insert (§5.4)

Step 7 — execution.py: persist/restore (10 min)
  ├── Aggiungere mfe_px/mae_px + campi entry a _persist_position_state (§5.2)
  └── Aggiungere retrocompatibilità in _restore_paper_state (§5.2)

Step 8 — main.py: 3 endpoint analytics (40 min)
  ├── Aggiungere import pandas (se mancante)
  ├── Implementare GET /analytics/diagnostics (§6.1)
  ├── Implementare GET /analytics/gate-performance (§6.2)
  └── Implementare GET /analytics/sl-tp-calibration (§6.3)

Step 9 — Frontend: AnalyticsPanel.tsx (40 min)
  └── Creare il file completo (§7)

Step 10 — Frontend: TradingHubTab.tsx (5 min)
  ├── Aggiungere import AnalyticsPanel (§8.1)
  ├── Aggiungere 'analytics' al tipo HubPage (§8.1)
  ├── Aggiungere voce NAV (§8.2)
  └── Aggiungere routing nel <main> (§8.3)

Step 11 — Deploy e verifica (15 min)
  ├── Build frontend: cd apps/web && npm run build
  ├── Restart backend
  └── Verificare con checklist §10
```

**Tempo totale stimato: 3.5 – 4.5 ore**

---

## 10. Testing — Piano di verifica

### 10.1 — Verifica database migration

```sql
-- Verifica che tutte le colonne esistano e siano nullable
SELECT column_name, is_nullable
FROM information_schema.columns
WHERE table_name = 'trades'
  AND column_name = 'mfe_pct';
-- Expected: mfe_pct | YES
```

### 10.2 — Verifica backend endpoints (prima del frontend)

```bash
# Overview: deve restituire kpi, exit_reasons, by_regime
curl -s http://localhost:8000/analytics/diagnostics | python3 -m json.tool | head -40

# Gate performance: deve avere n_cycles_analyzed
curl -s "http://localhost:8000/analytics/gate-performance" | python3 -m json.tool | head -20

# SL/TP calibration: se trade < 5, deve restituire insufficient_data=true
curl -s "http://localhost:8000/analytics/sl-tp-calibration" | python3 -m json.tool

# Verifica filtri (mode + days)
curl -s "http://localhost:8000/analytics/diagnostics?mode=paper&days=30" | python3 -m json.tool
```

### 10.3 — Verifica raccolta dati su trade reale

Dopo il deploy, attendere un trade completato (o chiuderne uno manualmente):

```sql
-- Il trade più recente deve avere mfe_pct e mae_pct non null
SELECT id, side, pnl_usd, mfe_pct, mae_pct, tp_reach_pct, entry_type, regime_at_entry, lgbm_prob
FROM trades
ORDER BY closed_at DESC
LIMIT 1;

-- Expected: tutti i nuovi campi con valori non null per trade chiusi DOPO il deploy
```

### 10.4 — Verifica gates_fired in inference_logs

```sql
-- I cicli successivi al deploy devono avere gates_fired non null
SELECT id, decision, gates_fired, signal_native
FROM inference_logs
ORDER BY time DESC
LIMIT 3;

-- Expected: gates_fired = {"adx_gate": "pass", "sweep_gate": "pass", ...}
--           signal_native = "long" | "short" | "no_trade"
```

### 10.5 — Verifica UI

1. Aprire il Trading Hub — deve apparire la voce "Analytics" nella sidebar
2. Aprire Analytics — deve caricare senza errori (anche con dati vuoti/insufficienti)
3. Il banner "dati insufficienti" deve apparire se n_trades < 20
4. I filtri mode/days devono aggiornare i dati (osservare la loading spinner)
5. Il tab SL/TP Lab con insufficient_data deve mostrare il messaggio esplicativo

### 10.6 — Verifica retrocompatibilità posizioni esistenti

Se al momento del deploy esiste una posizione paper aperta:
- `mfe_px` e `mae_px` non saranno nel dict salvato
- `_restore_paper_state` li inizializza a `entry_price` (§5.2 retrocompatibilità)
- Il trade si chiuderà normalmente; `mfe_pct` e `mae_pct` nel DB saranno prossimi a 0
  (il tracking inizia dal momento del restore, non dall'apertura originale) — **accettabile**

---

## 11. Rischi e mitigazioni

| Rischio | Probabilità | Impatto | Mitigazione |
|---------|-------------|---------|-------------|
| Trade esistenti hanno `mfe_pct = NULL` | Certa | Basso | Colonne nullable — il tab SL/TP Lab mostra banner fino a dati sufficienti |
| `gates_fired` vuoto nei cicli pre-deploy | Certa | Basso | Gate Performance tab mostra messaggio esplicativo |
| Errore nel parsing `gates_fired` in `_log_inference` | Bassa | Basso | `result.gates_fired` è un dict Python — nessun parsing necessario |
| Endpoint analytics lenti (query su molte righe) | Bassa | Basso | Indici creati in §3 — aggiungere `.limit(500)` se necessario |
| `decision.py` — aggiunta di `gates_fired` rompe un path | Media | Alto | Verificare che TUTTI i `return DecisionResult(...)` includano `gates_fired=gates_fired` |
| `_open_position` — parametro `entry_type` mancante in un call site | Alta | Medio | Default `"market"` — se dimentichi un call site, classifica come "market" (non crasher) |
| `pandas` non installato nel venv backend | Bassa | Bloccante | Verificare con `python -c "import pandas"` prima del deploy; se manca: `pip install pandas` |
| `signal_native` non settato su `DecisionResult` | Media | Basso | Usare `getattr(result, "_signal_pre_gates", result.action)` come fallback (§5.4) |
| Conflitto colonne con piano leva (future) | Nulla | Nulla | Set di colonne disgiunti — verificato §0 |

---

## 12. Decisioni di design

### pandas in main.py
Il calcolo analytics è puro aggregation su un dataset di al massimo qualche centinaia di righe (trade storici). `pandas` è già nel progetto (usato in `smc.py`, `trainer.py`, `backtesting.py`). Non è necessario un servizio analytics separato.

### Retrocompatibilità NULL per trade esistenti
I trade già registrati non avranno i nuovi campi. La scelta è di trattarli come `NULL` anziché tentare un backfill (impossibile senza accesso alla serie prezzi storica della posizione). Il banner "dati insufficienti" gestisce il periodo di accumulo.

### `mfe_px` e `mae_px` separati da `high_water`
`high_water` è un componente operativo del trailing SL — modificarlo (o condividerlo con MAE/MFE tracking) rischierebbe di alterare il trailing SL behavior. I campi analytics sono completamente separati e non influenzano la logica di trading.

### Gate tracking in `DecisionResult` vs parsing del reasoning
Il parsing testuale del reasoning è fragile (basta cambiare il testo di un messaggio per rompere il parser). Aggiungere `gates_fired: dict` direttamente a `DecisionResult` è la soluzione robusta: il dato strutturato viene prodotto dove la decisione viene presa (DecisionEngine) e non ricostruito a posteriori.

### Endpoint analytics sincroni (non async con asyncio.to_thread)
Le query Supabase usate negli endpoint analytics sono leggere (poche centinaia di righe, aggregation semplice). Non richiedono `asyncio.to_thread` — il pattern esistente degli altri endpoint è sufficiente.

---

## 13. Sommario colonne aggiunte

### `trades` table

| Colonna | Tipo | Popolata da | Significato |
|---------|------|-------------|-------------|
| `entry_atr` | FLOAT | `_close_position` | ATR_14 al momento dell'entry |
| `sl_price` | FLOAT | `_close_position` | Prezzo SL assoluto all'apertura |
| `tp_price` | FLOAT | `_close_position` | Prezzo TP assoluto all'apertura |
| `sl_pct` | FLOAT | `_close_position` | Distanza SL come % di entry_price |
| `tp_pct` | FLOAT | `_close_position` | Distanza TP come % di entry_price |
| `mfe_pct` | FLOAT | `_close_position` | Max Favorable Excursion % |
| `mae_pct` | FLOAT | `_close_position` | Max Adverse Excursion % |
| `tp_reach_pct` | FLOAT | `_close_position` | % percorso verso TP raggiunto (0–100) |
| `bars_held_final` | INT | `_close_position` | Numero di barre 4H tenuta la posizione |
| `regime_at_entry` | TEXT | `_open_position` | Regime al momento dell'apertura |
| `entry_type` | TEXT | `_open_position` | market / pullback / bounce_fade / reversal |
| `lgbm_prob` | FLOAT | `_open_position` | Probabilità direzionale LGBM ensemble |
| `c2_dir_prob` | FLOAT | `_open_position` | Probabilità direzionale Chronos-2 |

### `inference_logs` table

| Colonna | Tipo | Popolata da | Significato |
|---------|------|-------------|-------------|
| `gates_fired` | JSONB | `_log_inference` | Dict gate → "pass"/"block"/"scale" |
| `signal_native` | TEXT | `_log_inference` | Segnale pre-gate (long/short/no_trade) |
