# Squeeze Protection Gates — Piano di Implementazione

**Data:** 2026-06-08  
**Priorità:** Alta  
**Contesto:** Analisi post-mortem del trade SHORT BTC del 07/06/2026 che ha colpito SL per short squeeze (+4.5% in 135 min). Il sistema mancava di filtri strutturali contro il crowding direzionale e la velocità dell'OI.

---

## Indice

1. [Architettura generale](#1-architettura-generale)
2. [Gate A — OI Spike Gate](#2-gate-a--oi-spike-gate)
3. [Gate B — Long/Short Ratio Gate](#3-gate-b--longshort-ratio-gate)
4. [Gate C — Liquidation Spike Gate](#4-gate-c--liquidation-spike-gate)
5. [Prerequisito condiviso — Coinalyze L/S + Liquidation fetch](#5-prerequisito-condiviso--coinalyze-ls--liquidation-fetch)
6. [Integrazione backtest](#6-integrazione-backtest)
7. [UI — BotConfig.tsx](#7-ui--botconfigtsx)
8. [Sequenza di gate aggiornata](#8-sequenza-di-gate-aggiornata)
9. [Parametri consigliati e calibrazione](#9-parametri-consigliati-e-calibrazione)
10. [Testing checklist](#10-testing-checklist)

---

## 1. Architettura generale

Ogni gate segue il pattern già stabilito nel sistema:

```
BotConfig.__init__(**kw)           ← paper/live
backtesting.py getattr(cfg, ...)   ← backtest  
DecisionEngine.__init__(...)       ← gate logic
decision.py evaluate()             ← esecuzione
BotConfig.tsx                      ← UI toggle + sliders
```

**Nessun gate blocca le posizioni già aperte** — agiscono solo sull'entrata.  
**Tutti i gate sono `False` per default** — zero impatto finché non attivati.  
**Ogni gate produce una riga di reasoning** che appare nei log e nei backtest param_stats.

### Posizione nella sequenza di gate (decision.py)

```
Gate Level 1:   ADX gate
Gate Level 1b:  ATR% Volatility gate
Gate Level 2:   Sweep gate
Gate Level 2b:  [NUOVO] OI Spike Gate          ← Gate A
Gate Level 2c:  [NUOVO] Long/Short Ratio Gate  ← Gate B
Gate Level 2d:  [NUOVO] Liquidation Spike Gate ← Gate C
Gate Level 3:   Chronos-2 uncertainty gate
Gate Level 4:   Chronos-2 continuation gate
...
```

I tre nuovi gate si inseriscono PRIMA del calcolo dell'ensemble probability, così il blocco è computazionalmente efficiente.

---

## 2. Gate A — OI Spike Gate

### Razionale

Quando l'Open Interest cresce rapidamente mentre si apre una posizione nella direzione "affollata", il rischio di squeeze è elevato. `oi_delta_z` è già calcolato in `build_all_features()` — questo gate lo usa direttamente senza nuovi fetch.

- **Per SHORT**: se `oi_delta_z > soglia` (OI cresce = nuovi short si accumulano) → mercato sovraffollato in direzione short → riduce size o blocca
- **Per LONG**: se `oi_delta_z < -soglia` (OI cala = short si chiudono / pressione in vendita) → mercato sovraffollato in direzione long sul breve termine → riduce size

### 2.1 Parametri

| Parametro | Tipo | Default | Range UI | Significato |
|---|---|---|---|---|
| `oi_spike_gate_enabled` | `bool` | `False` | toggle | Master switch |
| `oi_spike_thr` | `float` | `2.0` | 1.0 – 4.0 | Soglia z-score OI delta (σ) |
| `oi_spike_mode` | `Literal["block","scale"]` | `"scale"` | block/scale | Modalità risposta |
| `oi_spike_lookback` | `int` | `2` | 1 – 6 | Barre 4H da considerare |

### 2.2 Logica (decision.py)

Posizione: dopo Gate Level 2 (sweep), prima di Gate Level 3 (C2 uncertainty).

```python
# ── Gate Level 2b: OI Spike Gate ─────────────────────────────────────────
if self.oi_spike_gate_enabled:
    _oi_z_vals = [features.get(f"oi_delta_z_lag{i}", features.get("oi_delta_z", 0.0))
                  for i in range(self.oi_spike_lookback)]
    _oi_z_max = max(abs(v) for v in _oi_z_vals if v is not None) if _oi_z_vals else 0.0

    _oi_spike_triggered = False
    if tentative_action == "short" and _oi_z_max > self.oi_spike_thr:
        # OI crescente veloce mentre si va short = crowded short = squeeze risk
        _oi_spike_triggered = True
        _msg = f"OI_SPIKE: oi_delta_z={_oi_z_max:.2f} > {self.oi_spike_thr:.1f}σ — crowded short, squeeze risk"
    elif tentative_action == "long" and _oi_z_max > self.oi_spike_thr and features.get("oi_delta", 0) < 0:
        # OI calante veloce mentre si va long = liquidazione rapida longs
        _oi_spike_triggered = True
        _msg = f"OI_SPIKE: oi_delta_z={_oi_z_max:.2f} — rapid OI decline, long squeeze risk"

    if _oi_spike_triggered:
        if self.oi_spike_mode == "block":
            reasoning.append(f"GATE: {_msg}")
            return self._no_trade(reasoning, dir_prob, p10, p50, p90, features, c2_uncertainty)
        else:
            _oi_sf = max(0.30, 1.0 - (_oi_z_max - self.oi_spike_thr) * 0.15)
            result.size_factor *= _oi_sf
            reasoning.append(f"OI_SPIKE_SCALE ×{_oi_sf:.2f}: {_msg}")
```

> **Nota implementativa**: `oi_delta_z` è già in `df_feat` dal ciclo di fetch OI Coinalyze. Per il lookback multi-barra, il valore più recente è sufficiente (1 barra = default). Il lookback aggiuntivo richiede lag features (`oi_delta_z_lag1`, etc.) — vedi sezione 2.3.

### 2.3 Feature aggiuntive richieste (smc.py)

In `build_all_features()`, dopo il calcolo di `oi_delta_z`, aggiungere:

```python
# Lag features per OI Spike Gate lookback (max 3 barre)
for _lag in [1, 2, 3]:
    d[f"oi_delta_z_lag{_lag}"] = d["oi_delta_z"].shift(_lag)
```

Aggiungere al `FEATURE_GROUPS["oi"]`:
```python
"oi":  ["oi_raw", "oi_ma_ratio", "oi_delta", "oi_delta_z", "oi_ma24",
        "oi_delta_z_lag1", "oi_delta_z_lag2", "oi_delta_z_lag3"],
```

### 2.4 BotConfig (execution.py)

```python
# OI Spike Gate
self.oi_spike_gate_enabled = kw.get("oi_spike_gate_enabled", False)
self.oi_spike_thr          = kw.get("oi_spike_thr",          2.0)
self.oi_spike_mode         = kw.get("oi_spike_mode",         "scale")
self.oi_spike_lookback     = kw.get("oi_spike_lookback",     2)
```

Passare alla `DecisionEngine` in `execution.py` (blocco di istanziazione):
```python
oi_spike_gate_enabled = getattr(cfg, "oi_spike_gate_enabled", False),
oi_spike_thr          = getattr(cfg, "oi_spike_thr",          2.0),
oi_spike_mode         = getattr(cfg, "oi_spike_mode",         "scale"),
oi_spike_lookback     = getattr(cfg, "oi_spike_lookback",     2),
```

### 2.5 DecisionEngine.__init__ (decision.py)

```python
oi_spike_gate_enabled: bool  = False,
oi_spike_thr:          float = 2.0,
oi_spike_mode:         str   = "scale",
oi_spike_lookback:     int   = 2,
```

```python
self.oi_spike_gate_enabled = oi_spike_gate_enabled
self.oi_spike_thr          = oi_spike_thr
self.oi_spike_mode         = oi_spike_mode
self.oi_spike_lookback     = oi_spike_lookback
```

---

## 3. Gate B — Long/Short Ratio Gate

### Razionale

**Il più importante dei tre gate.** Il dato Coinalyze L/S ratio mostra la percentuale di account che detengono posizioni long vs short. Quando il mercato è ≥67% long (come il 07/06 quando il bot ha aperto il fatale SHORT), la controparte è strutturalmente forte: qualsiasi risalita degenera in short squeeze.

- Dati: Coinalyze `/long-short-ratio-history` → verificato funzionante (90 giorni, 1999 campioni)
- Aggiornamento: ogni 4H (allineato al ciclo del bot)
- Non dipende da Coinglass (che richiede piano a pagamento)

### 3.1 Parametri

| Parametro | Tipo | Default | Range UI | Significato |
|---|---|---|---|---|
| `ls_gate_enabled` | `bool` | `False` | toggle | Master switch |
| `ls_long_block_pct` | `float` | `67.0` | 55 – 80 | Block SHORT quando long% ≥ questa soglia |
| `ls_short_block_pct` | `float` | `33.0` | 20 – 45 | Block LONG quando long% ≤ questa soglia |
| `ls_gate_mode` | `Literal["block","scale"]` | `"scale"` | block/scale | Modalità risposta |
| `ls_gate_scale_factor` | `float` | `0.50` | 0.20 – 0.80 | Riduzione size in modalità scale |
| `ls_lookback_bars` | `int` | `1` | 1 – 6 | Barre di lookback (media rolling) |

**Calibrazione sui 90 giorni di dati BTC (Mar-Giu 2026):**
- Mediana long%: 60.9%
- P75 long%: 66.5%  
- P90 long%: 72.8%
- Default `ls_long_block_pct = 67` → top quartile → ~25% trade SHORT potenzialmente bloccati

### 3.2 Prerequisito: fetch dati (external_data.py)

Nuova funzione da aggiungere in `services/external_data.py`:

```python
async def get_coinalyze_ls(
    symbol: str = "BTC",
    interval: str = "4hour",
    start_date: Optional[str] = None,
    end_date: Optional[str] = None,
) -> pd.DataFrame:
    """
    Fetch Long/Short ratio history from Coinalyze.
    Returns DataFrame indexed by UTC timestamp with columns:
      long_pct  — % of accounts holding long positions
      short_pct — % of accounts holding short positions
      ls_ratio  — long_pct / short_pct
    """
    if not COINALYZE_KEY:
        log.warning("COINALYZE_API_KEY not set — returning empty L/S ratio")
        return pd.DataFrame()

    end_ts   = int((datetime.strptime(end_date, "%Y-%m-%d")
                    .replace(tzinfo=timezone.utc).timestamp())) if end_date \
               else int(datetime.now(timezone.utc).timestamp())
    start_ts = int((datetime.strptime(start_date, "%Y-%m-%d")
                    .replace(tzinfo=timezone.utc).timestamp())) if start_date \
               else end_ts - 90 * 86400

    coinalyze_symbol = f"{symbol}USDT_PERP.A"
    try:
        async with httpx.AsyncClient(base_url=COINALYZE_BASE, timeout=20.0) as client:
            resp = await client.get(
                "/long-short-ratio-history",
                params={
                    "symbols":  coinalyze_symbol,
                    "interval": interval,
                    "from":     start_ts,
                    "to":       end_ts,
                },
                headers={"api_key": COINALYZE_KEY},
            )
            resp.raise_for_status()
            data = resp.json()

        if not data or not isinstance(data, list) or not data[0].get("history"):
            return pd.DataFrame()

        rows = data[0]["history"]
        df = pd.DataFrame([{
            "time":      pd.Timestamp(int(r["t"]), unit="s", tz="UTC"),
            "long_pct":  float(r["l"]),   # % long accounts
            "short_pct": float(r["s"]),   # % short accounts
            "ls_ratio":  float(r["r"]),   # long/short ratio
        } for r in rows]).set_index("time").sort_index()
        log.info("Coinalyze L/S %s: %d rows", symbol, len(df))
        return df

    except Exception as e:
        log.warning("Coinalyze L/S fetch failed: %s", e)
        return pd.DataFrame()
```

### 3.3 Integrazione feature matrix (smc.py)

Aggiungere parametro `df_ls` a `build_all_features()`:

```python
def build_all_features(
    df_4h: pd.DataFrame,
    df_funding: pd.DataFrame,
    df_oi: pd.DataFrame,
    df_liq: pd.DataFrame,
    df_ls: Optional[pd.DataFrame] = None,       # ← NUOVO
    df_binance: Optional[pd.DataFrame] = None,
    ...
) -> pd.DataFrame:
```

Aggiungere blocco di integrazione L/S dopo il blocco OI (intorno alla riga 445):

```python
# ── Long/Short Ratio ─────────────────────────────────────────────────────
if df_ls is not None and not df_ls.empty and "long_pct" in df_ls.columns:
    _ls_aligned = df_ls[["long_pct", "short_pct", "ls_ratio"]].reindex(d.index, method="ffill")
    d["long_pct"]  = _ls_aligned["long_pct"].fillna(50.0)
    d["short_pct"] = _ls_aligned["short_pct"].fillna(50.0)
    d["ls_ratio"]  = _ls_aligned["ls_ratio"].fillna(1.0)
    # Rolling mean (6 bars = 24h smoothing) to reduce noise
    d["long_pct_ma6"]  = d["long_pct"].rolling(6, min_periods=1).mean()
    d["short_pct_ma6"] = d["short_pct"].rolling(6, min_periods=1).mean()
else:
    d["long_pct"]      = 50.0
    d["short_pct"]     = 50.0
    d["ls_ratio"]      = 1.0
    d["long_pct_ma6"]  = 50.0
    d["short_pct_ma6"] = 50.0
```

Aggiungere al `FEATURE_GROUPS`:
```python
"ls": ["long_pct", "short_pct", "ls_ratio", "long_pct_ma6", "short_pct_ma6"],
```

### 3.4 Fetch nel ciclo live (execution.py)

Nel metodo principale del ciclo (intorno alla riga 1280, dove viene fetchato `df_oi`):

```python
# Long/Short ratio (Coinalyze, ultimo aggiornamento ogni 4H)
try:
    _ls_start = (_today_dt - timedelta(days=7)).strftime("%Y-%m-%d")
    df_ls = await get_coinalyze_ls(SYMBOL, start_date=_ls_start, end_date=_today)
except Exception as _ls_exc:
    log.warning("L/S ratio fetch failed: %s — using defaults", _ls_exc)
    df_ls = pd.DataFrame()
```

Passare `df_ls` a `build_all_features()`:
```python
df_feat = build_all_features(
    df_4h, df_fund, df_oi, df_liq, df_ls=df_ls,
    ...
)
```

Import da aggiungere in `execution.py`:
```python
from services.external_data import get_coinalyze_ls
```

### 3.5 Logica gate (decision.py)

Posizione: Gate Level 2c (dopo OI Spike Gate).

```python
# ── Gate Level 2c: Long/Short Ratio Gate ──────────────────────────────────
if self.ls_gate_enabled:
    _long_pct  = float(features.get("long_pct_ma6", features.get("long_pct", 50.0)) or 50.0)
    _short_pct = 100.0 - _long_pct

    _ls_triggered = False
    _ls_msg = ""

    if tentative_action == "short" and _long_pct >= self.ls_long_block_pct:
        # Mercato heavily long → short squeeze risk elevato
        _ls_triggered = True
        _ls_msg = (
            f"LS_RATIO: long={_long_pct:.1f}% ≥ {self.ls_long_block_pct:.0f}% "
            f"— mercato over-long, short squeeze risk"
        )

    elif tentative_action == "long" and _long_pct <= self.ls_short_block_pct:
        # Mercato heavily short → long squeeze risk elevato
        _ls_triggered = True
        _ls_msg = (
            f"LS_RATIO: long={_long_pct:.1f}% ≤ {self.ls_short_block_pct:.0f}% "
            f"— mercato over-short, long squeeze risk"
        )

    if _ls_triggered:
        if self.ls_gate_mode == "block":
            reasoning.append(f"GATE: {_ls_msg}")
            return self._no_trade(reasoning, dir_prob, p10, p50, p90, features, c2_uncertainty)
        else:
            result.size_factor *= self.ls_gate_scale_factor
            reasoning.append(f"LS_RATIO_SCALE ×{self.ls_gate_scale_factor:.2f}: {_ls_msg}")
```

### 3.6 BotConfig (execution.py)

```python
# Long/Short Ratio Gate
self.ls_gate_enabled      = kw.get("ls_gate_enabled",      False)
self.ls_long_block_pct    = kw.get("ls_long_block_pct",    67.0)
self.ls_short_block_pct   = kw.get("ls_short_block_pct",   33.0)
self.ls_gate_mode         = kw.get("ls_gate_mode",         "scale")
self.ls_gate_scale_factor = kw.get("ls_gate_scale_factor", 0.50)
self.ls_lookback_bars     = kw.get("ls_lookback_bars",     1)
```

### 3.7 DecisionEngine.__init__ (decision.py)

```python
ls_gate_enabled:      bool  = False,
ls_long_block_pct:    float = 67.0,
ls_short_block_pct:   float = 33.0,
ls_gate_mode:         str   = "scale",
ls_gate_scale_factor: float = 0.50,
ls_lookback_bars:     int   = 1,
```

---

## 4. Gate C — Liquidation Spike Gate

### Razionale

Quando nei 4H bar recenti si verifica un picco anomalo di liquidazioni SHORT (liq_short_z alto), significa che uno squeeze è già in corso o appena terminato. Aprire nuovi SHORT in questo contesto è pericoloso: il mercato ha appena dimostrato la sua capacità di cacciare i venditori allo scoperto.

**Dato critico dal 07/06:** a 20:00 UTC (4h dopo l'apertura del trade), `liq_short_usd = $69.8M` → picco enorme. Il gate avrebbe rilevato questo nella barra delle 20:00 e bloccato qualsiasi nuova apertura SHORT al ciclo successivo (00:00 June 8).

### 4.1 Parametri

| Parametro | Tipo | Default | Range UI | Significato |
|---|---|---|---|---|
| `liq_spike_gate_enabled` | `bool` | `False` | toggle | Master switch |
| `liq_spike_thr` | `float` | `2.5` | 1.5 – 5.0 | Soglia z-score liquidazioni (σ) |
| `liq_spike_lookback` | `int` | `2` | 1 – 6 | Barre 4H da esaminare |
| `liq_spike_mode` | `Literal["block","scale"]` | `"block"` | block/scale | Default block: spike = no trade |
| `liq_spike_scale_factor` | `float` | `0.40` | 0.20 – 0.80 | Riduzione size in modalità scale |

### 4.2 Prerequisito: fetch liquidation history (external_data.py)

Nuova funzione da aggiungere:

```python
async def get_coinalyze_liq(
    symbol: str = "BTC",
    interval: str = "4hour",
    start_date: Optional[str] = None,
    end_date: Optional[str] = None,
) -> pd.DataFrame:
    """
    Fetch liquidation history from Coinalyze.
    Returns DataFrame indexed by UTC timestamp with columns:
      liq_long  — long liquidations (USD millions)
      liq_short — short liquidations (USD millions)
    """
    if not COINALYZE_KEY:
        return pd.DataFrame()

    end_ts   = int((datetime.strptime(end_date, "%Y-%m-%d")
                    .replace(tzinfo=timezone.utc).timestamp())) if end_date \
               else int(datetime.now(timezone.utc).timestamp())
    start_ts = int((datetime.strptime(start_date, "%Y-%m-%d")
                    .replace(tzinfo=timezone.utc).timestamp())) if start_date \
               else end_ts - 90 * 86400

    coinalyze_symbol = f"{symbol}USDT_PERP.A"
    try:
        async with httpx.AsyncClient(base_url=COINALYZE_BASE, timeout=20.0) as client:
            resp = await client.get(
                "/liquidation-history",
                params={
                    "symbols":  coinalyze_symbol,
                    "interval": interval,
                    "from":     start_ts,
                    "to":       end_ts,
                },
                headers={"api_key": COINALYZE_KEY},
            )
            resp.raise_for_status()
            data = resp.json()

        if not data or not isinstance(data, list) or not data[0].get("history"):
            return pd.DataFrame()

        rows = data[0]["history"]
        df = pd.DataFrame([{
            "time":      pd.Timestamp(int(r["t"]), unit="s", tz="UTC"),
            "liq_long":  float(r.get("l", 0)),    # long liquidations (M USD)
            "liq_short": float(r.get("s", 0)),    # short liquidations (M USD)
        } for r in rows]).set_index("time").sort_index()
        log.info("Coinalyze liquidations %s: %d rows", symbol, len(df))
        return df

    except Exception as e:
        log.warning("Coinalyze liquidation fetch failed: %s", e)
        return pd.DataFrame()
```

> **Nota**: in modalità live il sistema usa già i dati di liquidazione dal WebSocket accumulator (`liq_long_usd`, `liq_short_usd`). La funzione `get_coinalyze_liq` serve principalmente per il **backtest** e per arricchire il feature set storico. Nel ciclo live, `liq_short_z` viene già calcolato da `build_all_features` usando `df_liq` (da WS snapshot) — il gate può usare direttamente la feature già esistente.

### 4.3 Logica gate (decision.py)

Posizione: Gate Level 2d (dopo L/S Ratio Gate).

```python
# ── Gate Level 2d: Liquidation Spike Gate ────────────────────────────────
if self.liq_spike_gate_enabled:
    # Controlla barre recenti per picchi di liquidazione nella direzione segnalata
    _liq_z_col = "liq_short_z" if tentative_action == "short" else "liq_long_z"
    _liq_z_cur = float(features.get(_liq_z_col, 0.0) or 0.0)

    # Anche lag-1 se disponibile (spike nella barra precedente)
    _liq_z_lag = float(features.get(f"{_liq_z_col}_lag1", 0.0) or 0.0)
    _liq_z_peak = max(_liq_z_cur, _liq_z_lag)

    if _liq_z_peak > self.liq_spike_thr:
        _liq_msg = (
            f"LIQ_SPIKE: {_liq_z_col}={_liq_z_peak:.2f}σ > {self.liq_spike_thr:.1f}σ "
            f"— liquidazioni {'short' if tentative_action == 'short' else 'long'} anomale, squeeze risk"
        )
        if self.liq_spike_mode == "block":
            reasoning.append(f"GATE: {_liq_msg}")
            return self._no_trade(reasoning, dir_prob, p10, p50, p90, features, c2_uncertainty)
        else:
            result.size_factor *= self.liq_spike_scale_factor
            reasoning.append(f"LIQ_SPIKE_SCALE ×{self.liq_spike_scale_factor:.2f}: {_liq_msg}")
```

### 4.4 Feature lag necessarie (smc.py)

Aggiungere dopo le liq features esistenti:

```python
# Lag features per Liquidation Spike Gate
if "liq_short_z" in d.columns:
    d["liq_short_z_lag1"] = d["liq_short_z"].shift(1)
    d["liq_long_z_lag1"]  = d["liq_long_z"].shift(1)
```

Aggiungere al `FEATURE_GROUPS["liq"]`:
```python
"liq": ["liq_total", "liq_sum_24h", "liq_z", "liq_ratio",
        "liq_long_z", "liq_short_z",
        "liq_short_z_lag1", "liq_long_z_lag1"],  # ← NUOVI
```

### 4.5 BotConfig (execution.py)

```python
# Liquidation Spike Gate
self.liq_spike_gate_enabled  = kw.get("liq_spike_gate_enabled",  False)
self.liq_spike_thr           = kw.get("liq_spike_thr",           2.5)
self.liq_spike_lookback      = kw.get("liq_spike_lookback",      2)
self.liq_spike_mode          = kw.get("liq_spike_mode",          "block")
self.liq_spike_scale_factor  = kw.get("liq_spike_scale_factor",  0.40)
```

---

## 5. Prerequisito condiviso — Coinalyze L/S + Liquidation fetch

### 5.1 Import (execution.py)

```python
from services.external_data import get_coinalyze_ls, get_coinalyze_liq
```

### 5.2 Fetch nel ciclo live (execution.py)

Nel blocco di fetch dati (vicino alla riga 1282, dopo il fetch di `df_oi`):

```python
# ── Long/Short ratio (Coinalyze, 7 giorni) ───────────────────────────────
try:
    _ls_from  = (_today_dt - timedelta(days=7)).strftime("%Y-%m-%d")
    df_ls = await get_coinalyze_ls(SYMBOL, start_date=_ls_from, end_date=_today)
except Exception as _e:
    log.warning("L/S fetch failed: %s", _e)
    df_ls = pd.DataFrame()

# Live: liquidation già da WS accumulator (df_liq).
# df_ls viene passato a build_all_features per i nuovi feature columns.
```

> **Nota**: Le liquidazioni live usano già `df_liq` dal WS accumulator. Non serve `get_coinalyze_liq` nel ciclo live — serve solo per backtest.

### 5.3 Passaggio a build_all_features (execution.py)

```python
df_feat = build_all_features(
    df_4h, df_fund, df_oi, df_liq,
    df_ls=df_ls,                    # ← NUOVO
    df_binance=df_binance if cfg.binance_cvd_enabled else None,
    ...
)
```

---

## 6. Integrazione backtest

### 6.1 Nuovi parametri in backtesting.py

Aggiungere nel blocco `getattr` (dopo la sezione ATR% gate, riga ~130):

```python
# OI Spike Gate
oi_spike_gate_enabled = getattr(cfg, "oi_spike_gate_enabled", False)
oi_spike_thr          = getattr(cfg, "oi_spike_thr",          2.0)
oi_spike_mode         = getattr(cfg, "oi_spike_mode",         "scale")
oi_spike_lookback     = getattr(cfg, "oi_spike_lookback",     2)
# Long/Short Ratio Gate
ls_gate_enabled       = getattr(cfg, "ls_gate_enabled",       False)
ls_long_block_pct     = getattr(cfg, "ls_long_block_pct",     67.0)
ls_short_block_pct    = getattr(cfg, "ls_short_block_pct",    33.0)
ls_gate_mode          = getattr(cfg, "ls_gate_mode",          "scale")
ls_gate_scale_factor  = getattr(cfg, "ls_gate_scale_factor",  0.50)
ls_lookback_bars      = getattr(cfg, "ls_lookback_bars",      1)
# Liquidation Spike Gate
liq_spike_gate_enabled = getattr(cfg, "liq_spike_gate_enabled", False)
liq_spike_thr          = getattr(cfg, "liq_spike_thr",          2.5)
liq_spike_lookback     = getattr(cfg, "liq_spike_lookback",     2)
liq_spike_mode         = getattr(cfg, "liq_spike_mode",         "block")
liq_spike_scale_factor = getattr(cfg, "liq_spike_scale_factor", 0.40)
```

### 6.2 Fetch dati storici per backtest (backtesting.py)

Nel blocco di fetch (dopo il fetch di OI, circa riga 220):

```python
# ── Long/Short ratio (Coinalyze) ─────────────────────────────────────────
df_ls_bt = pd.DataFrame()
if ls_gate_enabled:
    try:
        from services.external_data import get_coinalyze_ls
        df_ls_bt = await get_coinalyze_ls(
            symbol,
            start_date=req.from_date,
            end_date=req.to_date,
        )
        log.info("Backtest L/S ratio: %d rows", len(df_ls_bt))
    except Exception as _e:
        log.warning("Backtest L/S fetch failed: %s — gate disabled for this run", _e)

# ── Liquidation history (Coinalyze) ──────────────────────────────────────
df_liq_hist = pd.DataFrame()
if liq_spike_gate_enabled:
    try:
        from services.external_data import get_coinalyze_liq
        df_liq_hist = await get_coinalyze_liq(
            symbol,
            start_date=req.from_date,
            end_date=req.to_date,
        )
        log.info("Backtest liquidations: %d rows", len(df_liq_hist))
    except Exception as _e:
        log.warning("Backtest liquidation fetch failed: %s", _e)
```

### 6.3 Passaggio a build_all_features nel backtest loop

```python
df_feat = build_all_features(
    df_window, df_fund_window, df_oi_window, df_liq_hist_window,
    df_ls=df_ls_bt,   # ← NUOVO (sliced to current window, same as df_oi_window)
    ...
)
```

> **Nota su Coinalyze**: L/S e liquidation history disponibili solo per gli ultimi 90 giorni. Per backtest su periodi più lunghi, le feature `long_pct`, `short_pct`, `liq_short_z` saranno NaN → i gate usano `features.get(..., default)` con default neutro (50.0 per L/S, 0.0 per liq_z) → nessun gate si attiva. Comportamento corretto e sicuro.

### 6.4 param_stats nel backtest (backtesting.py)

Aggiungere nel dizionario `param_stats` (riga ~415):

```python
"gate_oi_spike":          0,
"gate_ls_ratio":          0,
"gate_liq_spike":         0,
"mod_oi_spike_scale":     0,
"mod_ls_ratio_scale":     0,
"mod_liq_spike_scale":    0,
```

Nel loop di parsing reasoning (riga ~995):

```python
if "GATE: OI_SPIKE"         in _line: param_stats["gate_oi_spike"]      += 1; break
if "GATE: LS_RATIO"         in _line: param_stats["gate_ls_ratio"]       += 1; break
if "GATE: LIQ_SPIKE"        in _line: param_stats["gate_liq_spike"]      += 1; break
if "OI_SPIKE_SCALE"         in _line: param_stats["mod_oi_spike_scale"]  += 1; break
if "LS_RATIO_SCALE"         in _line: param_stats["mod_ls_ratio_scale"]  += 1; break
if "LIQ_SPIKE_SCALE"        in _line: param_stats["mod_liq_spike_scale"] += 1; break
```

Nel dizionario finale stats (riga ~1265):

```python
"gate_oi_spike":         oi_spike_gate_enabled and oi_spike_mode == "block",
"gate_ls_ratio":         ls_gate_enabled and ls_gate_mode == "block",
"gate_liq_spike":        liq_spike_gate_enabled and liq_spike_mode == "block",
"mod_oi_spike_scale":    oi_spike_gate_enabled and oi_spike_mode == "scale",
"mod_ls_ratio_scale":    ls_gate_enabled and ls_gate_mode == "scale",
"mod_liq_spike_scale":   liq_spike_gate_enabled and liq_spike_mode == "scale",
```

---

## 7. UI — BotConfig.tsx

### 7.1 Interfaccia TypeScript

Aggiungere all'interfaccia `BotConfigParams` (dopo i parametri ATR%):

```typescript
// OI Spike Gate
oi_spike_gate_enabled: boolean;
oi_spike_thr: number;
oi_spike_mode: 'block' | 'scale';
oi_spike_lookback: number;
// Long/Short Ratio Gate
ls_gate_enabled: boolean;
ls_long_block_pct: number;
ls_short_block_pct: number;
ls_gate_mode: 'block' | 'scale';
ls_gate_scale_factor: number;
ls_lookback_bars: number;
// Liquidation Spike Gate
liq_spike_gate_enabled: boolean;
liq_spike_thr: number;
liq_spike_lookback: number;
liq_spike_mode: 'block' | 'scale';
liq_spike_scale_factor: number;
```

### 7.2 Default state

```typescript
// OI Spike Gate
oi_spike_gate_enabled: false,
oi_spike_thr: 2.0,
oi_spike_mode: 'scale' as const,
oi_spike_lookback: 2,
// Long/Short Ratio Gate
ls_gate_enabled: false,
ls_long_block_pct: 67.0,
ls_short_block_pct: 33.0,
ls_gate_mode: 'scale' as const,
ls_gate_scale_factor: 0.50,
ls_lookback_bars: 1,
// Liquidation Spike Gate
liq_spike_gate_enabled: false,
liq_spike_thr: 2.5,
liq_spike_lookback: 2,
liq_spike_mode: 'block' as const,
liq_spike_scale_factor: 0.40,
```

### 7.3 Sezione UI — "Squeeze Protection Gates"

Inserire come nuova `<Section>` dopo la sezione **"Bias di Mercato — Funding / Sentiment"**. Colore tema: `red`/`rose` per evidenziare la natura protettiva anti-squeeze.

```tsx
<Section
  title="Squeeze Protection Gates — Protezione Short/Long Squeeze"
  description="Tre gate indipendenti basati su dati di posizionamento del mercato (Coinalyze). Attivare in presenza di crowding direzionale elevato. Richiedono API key Coinalyze già configurata."
>
  {/* ── Gate A: OI Spike ── */}
  <div className={`flex flex-col gap-3 mb-6 pb-6 border-b transition-colors duration-200 
    ${config.oi_spike_gate_enabled ? 'border-rose-200 dark:border-rose-500/25' : 'border-slate-100 dark:border-white/5'}`}>
    
    <label className="flex items-start gap-3 cursor-pointer group">
      {/* Toggle */}
      <div className="relative inline-flex items-center mt-0.5">
        <input type="checkbox" className="sr-only"
          checked={config.oi_spike_gate_enabled}
          onChange={e => setConfig(c => ({ ...c, oi_spike_gate_enabled: e.target.checked }))} />
        <div className={`w-10 h-5 rounded-full transition-all duration-300
          ${config.oi_spike_gate_enabled ? 'bg-rose-600' : 'bg-slate-200 dark:bg-white/10'}`} />
        <div className={`absolute top-1 left-1 w-3 h-3 bg-white rounded-full shadow-sm transition-transform duration-300
          ${config.oi_spike_gate_enabled ? 'translate-x-5' : ''}`} />
      </div>
      <div>
        <p className={`text-sm font-bold transition-colors
          ${config.oi_spike_gate_enabled ? 'text-rose-600 dark:text-rose-400' : 'text-slate-800 dark:text-slate-200'}`}>
          OI Spike Gate
          {config.oi_spike_gate_enabled && (
            <span className="ml-2 px-1.5 py-0.5 rounded text-[9px] font-bold bg-rose-100 dark:bg-rose-500/20 text-rose-600 dark:text-rose-400 uppercase tracking-wider">Attivo</span>
          )}
        </p>
        <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
          {config.oi_spike_gate_enabled
            ? `soglia ${config.oi_spike_thr.toFixed(1)}σ · lookback ${config.oi_spike_lookback} bar · ${config.oi_spike_mode === 'block' ? 'Blocco' : `Scale ×${config.oi_spike_scale_factor.toFixed(2)}`}`
            : 'Blocca/riduce trade quando OI_delta_z supera la soglia (crowding direzionale)'}
        </p>
      </div>
    </label>

    {config.oi_spike_gate_enabled && (
      <div className="grid grid-cols-2 gap-4 pl-14">
        {/* Soglia z-score */}
        <div>
          <label className="flex items-center justify-between mb-2">
            <span className="text-[11px] font-bold text-slate-600 dark:text-slate-400 uppercase tracking-widest">Soglia (σ)</span>
            <span className="font-mono text-sm font-bold text-rose-600 dark:text-rose-400">{config.oi_spike_thr.toFixed(1)}σ</span>
          </label>
          <input type="range" min="1.0" max="4.0" step="0.1"
            value={config.oi_spike_thr}
            onChange={e => setConfig(c => ({ ...c, oi_spike_thr: parseFloat(e.target.value) }))}
            className="w-full h-1.5 bg-slate-200 dark:bg-white/10 rounded-full appearance-none cursor-pointer accent-rose-600" />
          <div className="flex justify-between text-[9px] font-mono text-slate-400 mt-1"><span>1.0</span><span>2.5</span><span>4.0</span></div>
        </div>
        {/* Lookback */}
        <div>
          <label className="flex items-center justify-between mb-2">
            <span className="text-[11px] font-bold text-slate-600 dark:text-slate-400 uppercase tracking-widest">Lookback (bar)</span>
            <span className="font-mono text-sm font-bold text-rose-600 dark:text-rose-400">{config.oi_spike_lookback}</span>
          </label>
          <input type="range" min="1" max="6" step="1"
            value={config.oi_spike_lookback}
            onChange={e => setConfig(c => ({ ...c, oi_spike_lookback: parseInt(e.target.value) }))}
            className="w-full h-1.5 bg-slate-200 dark:bg-white/10 rounded-full appearance-none cursor-pointer accent-rose-600" />
          <div className="flex justify-between text-[9px] font-mono text-slate-400 mt-1"><span>1</span><span>3</span><span>6</span></div>
        </div>
        {/* Modalità */}
        <div className="col-span-2 flex gap-3">
          {(['scale', 'block'] as const).map(mode => (
            <button key={mode}
              onClick={() => setConfig(c => ({ ...c, oi_spike_mode: mode }))}
              className={`flex-1 py-2 rounded-lg text-xs font-bold border transition-all ${
                config.oi_spike_mode === mode
                  ? 'bg-rose-600 text-white border-rose-600'
                  : 'bg-transparent text-slate-600 dark:text-slate-400 border-slate-200 dark:border-white/10 hover:border-rose-400'
              }`}>
              {mode === 'scale' ? '⚖️ Scale size' : '🚫 Blocca trade'}
            </button>
          ))}
        </div>
      </div>
    )}
  </div>

  {/* ── Gate B: Long/Short Ratio ── */}
  <div className={`flex flex-col gap-3 mb-6 pb-6 border-b transition-colors duration-200
    ${config.ls_gate_enabled ? 'border-rose-200 dark:border-rose-500/25' : 'border-slate-100 dark:border-white/5'}`}>
    
    <label className="flex items-start gap-3 cursor-pointer group">
      <div className="relative inline-flex items-center mt-0.5">
        <input type="checkbox" className="sr-only"
          checked={config.ls_gate_enabled}
          onChange={e => setConfig(c => ({ ...c, ls_gate_enabled: e.target.checked }))} />
        <div className={`w-10 h-5 rounded-full transition-all duration-300
          ${config.ls_gate_enabled ? 'bg-rose-600' : 'bg-slate-200 dark:bg-white/10'}`} />
        <div className={`absolute top-1 left-1 w-3 h-3 bg-white rounded-full shadow-sm transition-transform duration-300
          ${config.ls_gate_enabled ? 'translate-x-5' : ''}`} />
      </div>
      <div>
        <p className={`text-sm font-bold transition-colors
          ${config.ls_gate_enabled ? 'text-rose-600 dark:text-rose-400' : 'text-slate-800 dark:text-slate-200'}`}>
          Long/Short Ratio Gate
          {config.ls_gate_enabled && (
            <span className="ml-2 px-1.5 py-0.5 rounded text-[9px] font-bold bg-rose-100 dark:bg-rose-500/20 text-rose-600 dark:text-rose-400 uppercase tracking-wider">Attivo</span>
          )}
        </p>
        <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
          {config.ls_gate_enabled
            ? `block SHORT se long ≥${config.ls_long_block_pct.toFixed(0)}% · block LONG se long ≤${config.ls_short_block_pct.toFixed(0)}%`
            : 'Blocca/riduce trade quando il mercato è eccessivamente posizionato in una direzione (Coinalyze)'}
        </p>
      </div>
    </label>

    {config.ls_gate_enabled && (
      <div className="grid grid-cols-2 gap-4 pl-14">
        {/* Block SHORT threshold */}
        <div>
          <label className="flex items-center justify-between mb-2">
            <span className="text-[11px] font-bold text-slate-600 dark:text-slate-400 uppercase tracking-widest">Block SHORT se long ≥</span>
            <span className="font-mono text-sm font-bold text-rose-600 dark:text-rose-400">{config.ls_long_block_pct.toFixed(0)}%</span>
          </label>
          <input type="range" min="55" max="80" step="1"
            value={config.ls_long_block_pct}
            onChange={e => setConfig(c => ({ ...c, ls_long_block_pct: parseFloat(e.target.value) }))}
            className="w-full h-1.5 bg-slate-200 dark:bg-white/10 rounded-full appearance-none cursor-pointer accent-rose-600" />
          <div className="flex justify-between text-[9px] font-mono text-slate-400 mt-1"><span>55%</span><span>67%</span><span>80%</span></div>
        </div>
        {/* Block LONG threshold */}
        <div>
          <label className="flex items-center justify-between mb-2">
            <span className="text-[11px] font-bold text-slate-600 dark:text-slate-400 uppercase tracking-widest">Block LONG se long ≤</span>
            <span className="font-mono text-sm font-bold text-rose-600 dark:text-rose-400">{config.ls_short_block_pct.toFixed(0)}%</span>
          </label>
          <input type="range" min="20" max="45" step="1"
            value={config.ls_short_block_pct}
            onChange={e => setConfig(c => ({ ...c, ls_short_block_pct: parseFloat(e.target.value) }))}
            className="w-full h-1.5 bg-slate-200 dark:bg-white/10 rounded-full appearance-none cursor-pointer accent-rose-600" />
          <div className="flex justify-between text-[9px] font-mono text-slate-400 mt-1"><span>20%</span><span>33%</span><span>45%</span></div>
        </div>
        {/* Scale factor */}
        {config.ls_gate_mode === 'scale' && (
          <div>
            <label className="flex items-center justify-between mb-2">
              <span className="text-[11px] font-bold text-slate-600 dark:text-slate-400 uppercase tracking-widest">Scale factor</span>
              <span className="font-mono text-sm font-bold text-rose-600 dark:text-rose-400">×{config.ls_gate_scale_factor.toFixed(2)}</span>
            </label>
            <input type="range" min="0.20" max="0.80" step="0.05"
              value={config.ls_gate_scale_factor}
              onChange={e => setConfig(c => ({ ...c, ls_gate_scale_factor: parseFloat(e.target.value) }))}
              className="w-full h-1.5 bg-slate-200 dark:bg-white/10 rounded-full appearance-none cursor-pointer accent-rose-600" />
            <div className="flex justify-between text-[9px] font-mono text-slate-400 mt-1"><span>×0.20</span><span>×0.50</span><span>×0.80</span></div>
          </div>
        )}
        {/* Modalità */}
        <div className={config.ls_gate_mode === 'scale' ? '' : 'col-span-2'}>
          <div className="flex gap-3">
            {(['scale', 'block'] as const).map(mode => (
              <button key={mode}
                onClick={() => setConfig(c => ({ ...c, ls_gate_mode: mode }))}
                className={`flex-1 py-2 rounded-lg text-xs font-bold border transition-all ${
                  config.ls_gate_mode === mode
                    ? 'bg-rose-600 text-white border-rose-600'
                    : 'bg-transparent text-slate-600 dark:text-slate-400 border-slate-200 dark:border-white/10 hover:border-rose-400'
                }`}>
                {mode === 'scale' ? '⚖️ Scale size' : '🚫 Blocca trade'}
              </button>
            ))}
          </div>
        </div>
      </div>
    )}
  </div>

  {/* ── Gate C: Liquidation Spike ── */}
  <div className={`flex flex-col gap-3 transition-colors duration-200`}>
    
    <label className="flex items-start gap-3 cursor-pointer group">
      <div className="relative inline-flex items-center mt-0.5">
        <input type="checkbox" className="sr-only"
          checked={config.liq_spike_gate_enabled}
          onChange={e => setConfig(c => ({ ...c, liq_spike_gate_enabled: e.target.checked }))} />
        <div className={`w-10 h-5 rounded-full transition-all duration-300
          ${config.liq_spike_gate_enabled ? 'bg-rose-600' : 'bg-slate-200 dark:bg-white/10'}`} />
        <div className={`absolute top-1 left-1 w-3 h-3 bg-white rounded-full shadow-sm transition-transform duration-300
          ${config.liq_spike_gate_enabled ? 'translate-x-5' : ''}`} />
      </div>
      <div>
        <p className={`text-sm font-bold transition-colors
          ${config.liq_spike_gate_enabled ? 'text-rose-600 dark:text-rose-400' : 'text-slate-800 dark:text-slate-200'}`}>
          Liquidation Spike Gate
          {config.liq_spike_gate_enabled && (
            <span className="ml-2 px-1.5 py-0.5 rounded text-[9px] font-bold bg-rose-100 dark:bg-rose-500/20 text-rose-600 dark:text-rose-400 uppercase tracking-wider">Attivo</span>
          )}
        </p>
        <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
          {config.liq_spike_gate_enabled
            ? `soglia ${config.liq_spike_thr.toFixed(1)}σ · lookback ${config.liq_spike_lookback} bar · ${config.liq_spike_mode === 'block' ? 'Blocco' : 'Scale'}`
            : 'Blocca trade quando liq_short_z o liq_long_z supera la soglia (squeeze in corso)'}
        </p>
      </div>
    </label>

    {config.liq_spike_gate_enabled && (
      <div className="grid grid-cols-2 gap-4 pl-14">
        <div>
          <label className="flex items-center justify-between mb-2">
            <span className="text-[11px] font-bold text-slate-600 dark:text-slate-400 uppercase tracking-widest">Soglia (σ)</span>
            <span className="font-mono text-sm font-bold text-rose-600 dark:text-rose-400">{config.liq_spike_thr.toFixed(1)}σ</span>
          </label>
          <input type="range" min="1.5" max="5.0" step="0.1"
            value={config.liq_spike_thr}
            onChange={e => setConfig(c => ({ ...c, liq_spike_thr: parseFloat(e.target.value) }))}
            className="w-full h-1.5 bg-slate-200 dark:bg-white/10 rounded-full appearance-none cursor-pointer accent-rose-600" />
          <div className="flex justify-between text-[9px] font-mono text-slate-400 mt-1"><span>1.5</span><span>3.0</span><span>5.0</span></div>
        </div>
        <div>
          <label className="flex items-center justify-between mb-2">
            <span className="text-[11px] font-bold text-slate-600 dark:text-slate-400 uppercase tracking-widest">Lookback (bar)</span>
            <span className="font-mono text-sm font-bold text-rose-600 dark:text-rose-400">{config.liq_spike_lookback}</span>
          </label>
          <input type="range" min="1" max="6" step="1"
            value={config.liq_spike_lookback}
            onChange={e => setConfig(c => ({ ...c, liq_spike_lookback: parseInt(e.target.value) }))}
            className="w-full h-1.5 bg-slate-200 dark:bg-white/10 rounded-full appearance-none cursor-pointer accent-rose-600" />
          <div className="flex justify-between text-[9px] font-mono text-slate-400 mt-1"><span>1</span><span>3</span><span>6</span></div>
        </div>
        <div className="col-span-2 flex gap-3">
          {(['block', 'scale'] as const).map(mode => (
            <button key={mode}
              onClick={() => setConfig(c => ({ ...c, liq_spike_mode: mode }))}
              className={`flex-1 py-2 rounded-lg text-xs font-bold border transition-all ${
                config.liq_spike_mode === mode
                  ? 'bg-rose-600 text-white border-rose-600'
                  : 'bg-transparent text-slate-600 dark:text-slate-400 border-slate-200 dark:border-white/10 hover:border-rose-400'
              }`}>
              {mode === 'scale' ? '⚖️ Scale size' : '🚫 Blocca trade'}
            </button>
          ))}
        </div>
      </div>
    )}
  </div>
</Section>
```

---

## 8. Sequenza di gate aggiornata

```
decision.py evaluate()
│
├── Level 1:   ADX gate (adx < adx_gate → no_trade)
├── Level 1b:  ATR% Volatility gate (atr_pct < min)
├── Level 2:   Sweep gate (liq_sweep in trend direction)
├── Level 2b:  [NUOVO] OI Spike Gate
│               └── oi_delta_z > soglia → block/scale
├── Level 2c:  [NUOVO] Long/Short Ratio Gate
│               └── long% > 67% + SHORT → block/scale
│               └── long% < 33% + LONG  → block/scale
├── Level 2d:  [NUOVO] Liquidation Spike Gate
│               └── liq_short_z > soglia + SHORT → block
├── Level 3:   Chronos-2 uncertainty gate
├── Level 4:   Chronos-2 continuation gate
│
├── Ensemble probability (C2 + LGBM blend)
├── MTF alignment bonus
├── Regime Bias threshold adjustment
├── Funding Rate Bias (×8 fix applicato)
├── Fear & Greed Bias
├── Options IV Bias
├── Exhaustion Guard
├── Absorption Filter
├── Sweep Confluence
├── Confluence gate
├── Daily RSI gate
├── Volume Climax gate
├── C2 Forecast Inversion gate
│
├── Long signal evaluation
└── Short signal evaluation
```

---

## 9. Parametri consigliati e calibrazione

Basati su 90 giorni di dati BTC reali (Coinalyze + HyperLiquid, Mar-Giu 2026):

### Gate A — OI Spike Gate

| Parametro | Valore consigliato | Razionale |
|---|---|---|
| `oi_spike_gate_enabled` | `True` | Abilitare subito |
| `oi_spike_thr` | `2.0` | P97.7 della distribuzione normale — ≈2% dei bar |
| `oi_spike_mode` | `"scale"` | Meno aggressivo come primo uso |
| `oi_spike_lookback` | `2` | 8h di finestra — cattura spike nel bar precedente |

### Gate B — Long/Short Ratio Gate

| Parametro | Valore consigliato | Razionale |
|---|---|---|
| `ls_gate_enabled` | `True` | Il più impattante — abilitare subito |
| `ls_long_block_pct` | `67.0` | P75 di long% negli ultimi 90 giorni; avrebbe bloccato il trade 07/06 |
| `ls_short_block_pct` | `33.0` | Simmetrico — protezione da long squeeze |
| `ls_gate_mode` | `"scale"` | Prima usa scale (×0.50), poi valuta block dopo 30+ trade |
| `ls_gate_scale_factor` | `0.50` | Dimezza la size — abbastanza punitivo senza bloccare completamente |
| `ls_lookback_bars` | `1` | Media su 1 barra (4H) → più reattivo |

### Gate C — Liquidation Spike Gate

| Parametro | Valore consigliato | Razionale |
|---|---|---|
| `liq_spike_gate_enabled` | `True` | Abilitare — dato critico già disponibile da WS |
| `liq_spike_thr` | `2.5` | P99.4 — solo spike davvero anomali |
| `liq_spike_lookback` | `2` | Controlla barra corrente + precedente |
| `liq_spike_mode` | `"block"` | Default block: spike di liq = squeeze confermato |
| `liq_spike_scale_factor` | `0.40` | Per modalità scale se preferita |

---

## 10. Testing checklist

### Pre-implementazione

- [ ] Verificare che `COINALYZE_API_KEY` sia nell'env del VPS
- [ ] Testare manualmente `get_coinalyze_ls()` e `get_coinalyze_liq()` → output non vuoto
- [ ] Verificare che `build_all_features()` accetti `df_ls=pd.DataFrame()` senza errori (fallback a 50.0)

### Unit test rapido (Python)

```python
# Test build_all_features con df_ls vuoto
from services.smc import build_all_features
import pandas as pd

df_feat = build_all_features(
    df_4h=some_df, df_funding=pd.DataFrame(),
    df_oi=pd.DataFrame(), df_liq=pd.DataFrame(),
    df_ls=pd.DataFrame()   # deve funzionare senza crash
)
assert "long_pct" in df_feat.columns
assert df_feat["long_pct"].iloc[-1] == 50.0  # default neutro

# Test con dati reali
df_ls_real = await get_coinalyze_ls("BTC", start_date="2026-06-01", end_date="2026-06-08")
df_feat_enriched = build_all_features(..., df_ls=df_ls_real)
assert df_feat_enriched["long_pct"].iloc[-1] > 0
assert df_feat_enriched["long_pct"].iloc[-1] < 100
```

### Ciclo live post-deploy

- [ ] Al prossimo ciclo 4H: verificare log `"Coinalyze L/S BTC: N rows"` senza errori
- [ ] Verificare che `long_pct` sia nella snapshot features dei log inference
- [ ] Con gate B attivato: aprire dashboard e verificare che il toggle persista dopo save config
- [ ] Testare un ciclo con `ls_long_block_pct = 50` (blocca quasi tutti i SHORT) → deve loggare reasoning `"GATE: LS_RATIO: ..."`

### Backtest post-deploy

- [ ] Eseguire backtest su periodo Giugno 2026 con Gate B attivo → verificare che il trade del 07/06 non venga aperto
- [ ] Controllare `param_stats["gate_ls_ratio"]` nel risultato backtest → deve essere > 0
- [ ] Confrontare win rate / max DD con e senza i gate su un campione di 90 giorni

---

## Dipendenze e ordine di implementazione consigliato

```
1. external_data.py      → get_coinalyze_ls() + get_coinalyze_liq()         [~30 min]
2. smc.py                → build_all_features() sig + feature columns + lag   [~20 min]
3. execution.py          → BotConfig params + fetch nel ciclo + pass a build  [~30 min]
4. decision.py           → DecisionEngine params + gate logic (3 gate)        [~40 min]
5. backtesting.py        → getattr params + fetch + param_stats               [~30 min]
6. BotConfig.tsx         → interfaccia + defaults + sezione UI                [~60 min]
7. Deploy VPS + testing                                                        [~30 min]
                                                           Totale: ~4h
```

---

*Piano generato il 2026-06-08 da analisi post-mortem trade SHORT BTC 07/06 (short squeeze -2.98% / $168.55).*
