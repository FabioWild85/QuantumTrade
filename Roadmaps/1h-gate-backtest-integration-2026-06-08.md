# 1H Gate — Integrazione nel Backtest

**Data:** 2026-06-08  
**Priorità:** Alta  
**Complessità:** Media (≈ 3–4 ore)  
**Affidabilità:** Alta — il codice esistente nel trainer.py già fa la stessa cosa

---

## 0. Risposta alla domanda: è integrabile in modo affidabile?

**Sì. La complessità è media e l'affidabilità può essere alta** se l'implementazione segue l'approccio corretto.

Il motivo per cui è affidabile è che tutta la logica esiste già:
- `build_all_features()` su dati 1H → usata da `trainer._run_1h()` (riga 662)
- `build_4h_context_for_1h()` → usata sia nel trainer che nel ciclo live
- `lgbm_1h.predict_proba(row)` → già incapsulata in `_get_lgbm_1h_prob()`
- Il modello `lgbm_1h_latest.pkl` → già su disco, già caricato da `load_1h_model()`

La sfida principale **non è implementare la logica** (già esiste) ma **allineare correttamente i timestamp 1H con le barre 4H** senza lookahead.

Il rischio principale da evitare è il **lookahead bias**: usare dati 1H del futuro per decidere a una barra 4H passata.

---

## 1. Architettura della soluzione

### Approccio: Precompute-and-Lookup

**Non** si fa una chiamata API per ogni barra 4H (sarebbe lentissimo e inutile).

Si usa invece un approccio in due fasi:

```
FASE A — Prima del loop (una volta sola):
  1. Fetch 1H OHLCV per tutto il periodo del backtest
  2. Build feature matrix 1H completa con build_all_features + build_4h_context_for_1h
  3. Crea un index di lookup: Timestamp → 1H feature row

FASE B — All'interno del loop, per ogni barra 4H i:
  4. Trova l'ultima 1H row con timestamp < T(bar_i)   ← NO lookahead
  5. Estrai le feature della 1H model (58 features)
  6. Esegui predict_proba → p1h
  7. Applica gate: block se p_dir < block_thr, reduce se < min_agr
```

Questo approccio è:
- **Veloce**: predict_proba su una riga = microsecondi
- **Senza lookahead**: la lookup è su `df_1h_feat.index < bar_timestamp`
- **Identico al live**: usa le stesse feature, lo stesso modello, la stessa logica

### Schema temporale (no-lookahead)

```
Bar 4H chiude a T=16:00 UTC
  ↓
Ultime 1H bars disponibili: 15:00, 14:00, 13:00, ...
  ↓
Gate usa: df_1h_feat[ index <= 15:00 ].iloc[-1]   ← bar 1H delle 15:00
                                                      (l'ultima chiusa)
```

La barra 1H aperta a T (16:00) viene ESCLUSA, esattamente come fa il live:
```python
# live execution.py riga 1537-1538
if len(df_1h_raw) >= 2:
    df_1h_raw = df_1h_raw.iloc[:-1]   # rimuove la barra 1H in formazione
```

---

## 2. Modifiche necessarie

### File da modificare: `backtesting.py`
### Nessun altro file da modificare — la logica è già pronta

---

## 3. Implementazione dettagliata

### 3.1 — Nuovi parametri (sezione `getattr`, riga ~128)

Aggiungere dopo la sezione `atr_pct_gate_enabled`:

```python
# 1H LightGBM Gate
use_1h_lgbm_gate_bt      = getattr(cfg, "use_1h_lgbm_gate",           False)
lgbm_1h_min_agreement_bt = getattr(cfg, "lgbm_1h_min_agreement",      0.52)
lgbm_1h_block_threshold_bt = getattr(cfg, "lgbm_1h_block_threshold",  0.45)
```

> `use_1h_lgbm_gate` è già in `BotConfig` (riga 169 di `execution.py`). Il backtest lo legge con lo stesso nome — zero nuove UI da aggiungere, il toggle è già quello che si vede nello screenshot.

---

### 3.2 — Fetch + build della 1H feature matrix (Fase A, sezione ── 1c, riga ~247)

Aggiungere dopo il blocco Binance CVD (`df_binance`):

```python
# ── 1d. 1H LightGBM gate data (pre-compute once, lookup per bar) ─────────
_lgbm_1h_model    = None
_lgbm_1h_features = None
_df_1h_feat_bt    = None  # precomputed 1H feature DataFrame, indexed by UTC timestamp

if use_1h_lgbm_gate_bt:
    try:
        from services.trainer   import load_1h_model
        from services.smc       import build_4h_context_for_1h
        from services.binance_data import get_ohlcv_binance as _get_1h_binance

        _1h_model_result = load_1h_model()
        if _1h_model_result is None:
            log.warning("1H gate backtest: model not found at models/lgbm_1h_latest.pkl — gate disabled")
            use_1h_lgbm_gate_bt = False
        else:
            _lgbm_1h_model, _lgbm_1h_features = _1h_model_result
            log.info("1H gate backtest: model loaded (%d features)", len(_lgbm_1h_features))

            # ── Fetch 1H OHLCV ─────────────────────────────────────────────
            # Buffer: 64 1H bars before the start for feature warmup.
            # Use Binance for the full date range — covers both old and recent periods.
            _1h_buf_dt = dt_from - timedelta(hours=64)
            _df_1h_raw = await _get_1h_binance(
                symbol, "1h",
                start_date=_1h_buf_dt.strftime("%Y-%m-%d"),
                end_date=req.to_date,
            )
            log.info("1H gate backtest: %d 1H candles fetched (%s → %s)",
                     len(_df_1h_raw), _df_1h_raw.index[0].date(), _df_1h_raw.index[-1].date())

            # ── Funding 1H ─────────────────────────────────────────────────
            # Reuse df_fund if it covers 1H bars (already fetched above).
            # df_fund is indexed by hour (from HL funding_history); reindex fills gaps.
            _df_1h_fund = df_fund   # same funding data; reindex in build_all_features

            # ── Build 1H feature matrix ────────────────────────────────────
            # Pass empty df_oi, df_liq (not needed by 1H gate; OI is at 4H granularity)
            _df_1h_feat_full = build_all_features(
                _df_1h_raw, _df_1h_fund, pd.DataFrame(), pd.DataFrame()
            )
            # Add 4H context features (h4_ema50_dist, h4_adx, h4_rsi, h4_regime)
            _df_1h_feat_full = build_4h_context_for_1h(_df_1h_feat_full)
            # Remove warmup rows (same as live: .iloc[64:])
            _df_1h_feat_bt = _df_1h_feat_full.iloc[64:].copy()

            log.info("1H gate backtest: feature matrix built (%d rows, %d cols)",
                     len(_df_1h_feat_bt), _df_1h_feat_bt.shape[1])

    except Exception as _1h_exc:
        log.warning("1H gate backtest setup failed — gate disabled: %s", _1h_exc)
        use_1h_lgbm_gate_bt = False
        _lgbm_1h_model      = None
        _df_1h_feat_bt      = None
```

---

### 3.3 — Nuovi param_stats (riga ~415)

Aggiungere nel dizionario `param_stats`:

```python
"gate_1h_block":   0,   # nuovi trade bloccati dal 1H gate
"mod_1h_reduce":   0,   # nuovi trade ridotti a ×0.70 dal 1H gate
```

---

### 3.4 — Gate logic nel loop (Fase B)

**Posizione esatta**: subito DOPO il blocco `result = decision_engine.decide(...)` (riga ~940) e PRIMA del blocco reversal detector (riga ~950).

```python
            # ── 1H LightGBM Gate (mirrors execution._cycle logic) ─────────────
            # Applied only when:
            #   a) use_1h_lgbm_gate_bt is True
            #   b) A new position would be opened (position is None)
            #   c) The decision engine returned long or short
            # Implementation: lookup the last closed 1H bar before the current 4H bar.
            # Strict no-lookahead: df_1h_feat_bt.index strictly LESS THAN bar timestamp.
            if (
                use_1h_lgbm_gate_bt
                and _lgbm_1h_model is not None
                and _df_1h_feat_bt is not None
                and position is None
                and result.action in ("long", "short")
            ):
                try:
                    _bar_ts   = df_feat.index[i]   # 4H bar open timestamp

                    # Last closed 1H bar: strictly before this 4H bar open.
                    # On HL, 4H bars open at e.g. 16:00 UTC; the last closed 1H is 15:00.
                    _1h_mask  = _df_1h_feat_bt.index < _bar_ts
                    if _1h_mask.any():
                        _1h_row   = _df_1h_feat_bt[_1h_mask].iloc[-1]
                        _avail    = [f for f in (_lgbm_1h_features or []) if f in _1h_row.index]
                        if _avail:
                            _1h_X     = pd.DataFrame([_1h_row[_avail].fillna(0)])
                            _p1h      = float(_lgbm_1h_model.predict_proba(_1h_X)[0, 1])
                            _p_dir    = _p1h if result.action == "long" else (1.0 - _p1h)

                            if _p_dir < lgbm_1h_block_threshold_bt:
                                result.action = "no_trade"
                                result.reasoning.append(
                                    f"1H gate BLOCK: P({result.action})_1h={_p_dir:.3f} "
                                    f"< {lgbm_1h_block_threshold_bt}"
                                )
                                param_stats["gate_1h_block"] += 1

                            elif _p_dir < lgbm_1h_min_agreement_bt:
                                result.size_factor = (result.size_factor or 1.0) * 0.70
                                result.reasoning.append(
                                    f"1H gate REDUCE ×0.70: P({result.action})_1h={_p_dir:.3f} "
                                    f"< {lgbm_1h_min_agreement_bt}"
                                )
                                param_stats["mod_1h_reduce"] += 1

                            # log: same format as live for easy cross-referencing
                            log.debug(
                                "1H gate [%s] bar=%d: p1h=%.3f p_dir=%.3f → action=%s",
                                result.action, i, _p1h, _p_dir, result.action,
                            )

                except Exception as _1h_bt_exc:
                    log.debug("1H gate backtest failed at bar %d: %s", i, _1h_bt_exc)
                    # Fail-safe: gate is skipped, trade proceeds as without gate
```

---

### 3.5 — param_stats nel dict finale (riga ~1265)

Aggiungere nel dizionario delle statistiche:

```python
"gate_1h_block":   use_1h_lgbm_gate_bt and lgbm_1h_block_threshold_bt > 0,
"mod_1h_reduce":   use_1h_lgbm_gate_bt and lgbm_1h_min_agreement_bt > 0,
```

E nel reporting loop dei reasoning (riga ~995):

```python
if "1H gate BLOCK" in _line: param_stats["gate_1h_block"] += 1; break
```

```python
if "1H gate REDUCE" in _line and "mod_1h" not in _mods_seen:
    param_stats["mod_1h_reduce"] += 1; _mods_seen.add("mod_1h")
```

---

## 4. Perché è affidabile: garanzie di correttezza

### 4.1 No lookahead — dimostrazione formale

```
4H bar i apre a timestamp T_i.
Ultimi dati 1H usati: _df_1h_feat_bt[index < T_i].iloc[-1]
                                          ^^^^
                                     strettamente minore
```

Con `<` (non `<=`): anche se una 1H bar chiude esattamente a T_i (caso raro ma possibile), viene esclusa. È più conservativo del live (che usa `iloc[:-1]` sul df corrente), ma garantisce zero lookahead.

**Verifica**: al ciclo live 16:00 UTC, la 1H data recuperata parte da ~720h prima e rimuove l'ultima barra (la barra aperta alle 16:00 in formazione). Il backtest usa `< T_i` (< 16:00), quindi la barra delle 15:00 è l'ultima inclusa. Identico.

### 4.2 Stesso modello e stesse feature del live

- Modello: `load_1h_model()` → stesso `lgbm_1h_latest.pkl` usato dalla live
- Feature: `[f for f in _lgbm_1h_features if f in _1h_row.index]` → stesso subset del live
- Feature building: `build_all_features` + `build_4h_context_for_1h` → stesso codice del trainer e della live

### 4.3 Fail-safe coerente con il live

Il live ha:
```python
except Exception as _exc:
    log.warning("1H gate skipped (error): %s", _exc)
```
(= trade procede come senza gate)

Il backtest ha:
```python
except Exception as _1h_bt_exc:
    log.debug("1H gate backtest failed at bar %d: %s", i, _1h_bt_exc)
    # trade procede come senza gate
```
Identico comportamento.

### 4.4 Condizione di attivazione identica al live

Live:
```python
if (
    cfg.use_1h_lgbm_gate
    and self._lgbm_1h is not None
    and result.action in ("long", "short")
):
```

Backtest:
```python
if (
    use_1h_lgbm_gate_bt
    and _lgbm_1h_model is not None
    and _df_1h_feat_bt is not None
    and position is None           # ← solo su nuovi trade
    and result.action in ("long", "short")
):
```

La condizione `position is None` è implicita nel live (il gate è nel blocco `if position is None:` del ciclo live). Nel backtest viene resa esplicita.

---

## 5. Limitazione nota: barre successive nella stessa 4H

Nel live il gate opera sul candle 4H chiuso e agisce prima di aprire la posizione. Nel backtest, il gate opera sulla feature row 1H che corrisponde all'ultima barra 1H prima del close 4H. Le barre 1H successive (quelle dentro la 4H in corso) non esistono ancora — corretto, nessun lookahead.

Il risultato è che il gate backtest simula: *"come sarebbe stato il gate se avesse letto l'ultima 1H bar chiusa"*, che è esattamente quello che fa nel live.

---

## 6. Performance

| Operazione | Costo | Note |
|---|---|---|
| Fetch 1H OHLCV (90 giorni = 2160 barre) | ~1.5s | Una sola volta, prima del loop |
| Build feature matrix 1H | ~0.3s | Una sola volta |
| `build_4h_context_for_1h()` | ~0.1s | Una sola volta |
| Lookup + `predict_proba()` per barra 4H | ~0.2ms | × 540 bar = ~0.1s totale |
| **Overhead totale** | **~2s** | Trascurabile rispetto al backtest completo |

Non c'è chiamata API per barra. L'overhead aggiunto al backtest è ~2 secondi fissi + 0.1s per tutte le barre. Irrilevante.

---

## 7. BotConfig UI — nessuna modifica necessaria

Il toggle `use_1h_lgbm_gate` e le soglie `lgbm_1h_min_agreement` / `lgbm_1h_block_threshold` esistono già in `BotConfig` e vengono già serializzati a Supabase. Il backtest legge questi stessi campi da `cfg` via `getattr`. Non serve nessuna nuova UI.

Quando l'utente accende il gate dalla schermata BotConfig e lancia un backtest, il backtest leggerà automaticamente le stesse soglie.

---

## 8. Checklist implementazione

```
Step 1 — Nuovi parametri getattr (~5 min)
  [ ] Aggiungere use_1h_lgbm_gate_bt, lgbm_1h_min_agreement_bt, lgbm_1h_block_threshold_bt

Step 2 — Pre-fetch + pre-build 1H (~30 min)
  [ ] Aggiungere blocco ── 1d dopo il blocco ── 1c (Binance CVD)
  [ ] Testare che _df_1h_feat_bt venga costruito senza errori su un backtest breve (7 giorni)
  [ ] Verificare shape: len(_df_1h_feat_bt) ≈ days × 24 - 64

Step 3 — param_stats (~5 min)
  [ ] Aggiungere gate_1h_block e mod_1h_reduce al dizionario param_stats
  [ ] Aggiungere al reporting loop dei reasoning strings

Step 4 — Gate logic nel loop (~20 min)
  [ ] Aggiungere il blocco gate DOPO decision_engine.decide() e PRIMA del reversal detector
  [ ] Verificare che position is None sia nella condizione
  [ ] Testare un singolo bar: stampare _p1h e _p_dir per verificare i valori

Step 5 — Test di parità live/backtest (~30 min)
  [ ] Eseguire backtest sul periodo Mag 20 – Giu 8 2026 (l'unico con gate funzionante)
  [ ] Confrontare gate_1h_block backtest vs eventi "GATE: 1H" nei log live: devono concordare
  [ ] Verificare che nessuna barra di backtest abbia _1h_mask completamente False

Step 6 — Validazione no-lookahead (~15 min)
  [ ] Print debug: per bar i, stampare T_i e _1h_row.name → verificare che _1h_row.name < T_i
  [ ] Controllare il primo bar del backtest: _1h_mask.sum() deve essere >= 64
```

---

## 9. Test di validazione post-implementazione

### Test A — Parità temporale

```python
# Per ogni 4H bar i, verifica che la 1H row usata sia la corretta
for i, bar_ts in enumerate(df_feat.index):
    mask = _df_1h_feat_bt.index < bar_ts
    if mask.any():
        last_1h_ts = _df_1h_feat_bt[mask].index[-1]
        # Deve essere sempre < bar_ts
        assert last_1h_ts < bar_ts, f"Lookahead at bar {i}!"
        # Deve essere vicino (< 4h di distanza)
        delta_h = (bar_ts - last_1h_ts).total_seconds() / 3600
        assert delta_h <= 4.0, f"Gap too large at bar {i}: {delta_h:.1f}h"
```

### Test B — Confronto con log live (periodo Mag 20 – Giu 8)

Dalla sezione 3 (analisi storica), i log live mostrano queste gate calls reali:

| Data | p_dir live | Esito live |
|---|---|---|
| May 20 00:00 | 0.440 | BLOCK |
| May 20 04:00 | 0.527 | PASS |
| May 20 08:00 | 0.461 | REDUCE |
| May 23 08:00 | 0.439 | REDUCE |
| May 28 12:00 | 0.648 | PASS |
| Jun 08 08:00 | 0.425 | BLOCK |

Il backtest deve produrre valori di `_p_dir` vicini (non necessariamente identici) agli stessi timestamp. Differenze di ±0.05 sono accettabili (il live usa dati HL con lag di mercato, il backtest usa Binance). Differenze > 0.10 indicano un problema di alignment.

### Test C — Campione di gate attivazioni su 90 giorni

Con `use_1h_lgbm_gate_bt=True`, `block_threshold=0.44`, `min_agreement=0.52`:
- `gate_1h_block` deve essere ~28% dei segnali originali (coerente con l'analisi storica)
- `mod_1h_reduce` deve essere ~26% dei segnali originali

Se i valori differiscono molto (es. 0% block o 60% block), c'è un problema di allineamento.

---

## 10. Analisi della complessità

| Aspetto | Valutazione |
|---|---|
| Difficoltà tecnica | **Media** — la logica esiste già, serve solo integrare |
| Rischio di lookahead | **Basso** — la condizione `< T_i` è chiara e verificabile |
| Rischio di crash | **Basso** — il fail-safe fa passare il trade senza gate |
| Affidabilità del risultato | **Alta** — stesso modello, stesse feature, stessa logica del live |
| Sforzo di test | **Medio** — serve il test B (confronto con log live) |
| Impatto su performance | **Trascurabile** — 2s di overhead fisso |

La principale incertezza non è tecnica ma statistica: con 90 giorni di dati (≈540 4H bar, di cui forse 100 con segnale), il campione è troppo piccolo per conclusioni forti. Ma avremo numeri reali invece di supposizioni.

---

## 11. Cosa ti dirà il backtest che ora non sai

Dopo l'implementazione, per la prima volta avrai:

1. **Win rate con gate ON vs gate OFF** — capire se il gate aggiunge valore netto
2. **p_dir distribution per trade vincenti vs perdenti** — calibrare le soglie su dati reali
3. **Qual è la soglia ottimale** — confrontare block=40%/42%/44%/46% su win rate
4. **Quante opportunità vengono perse** (BLOCK) vs quante perdite vengono evitate (gate TP → bloccato)
5. **Se il REDUCE a ×0.70 ha senso** — i trade con 44%≤p_dir<53% hanno win rate peggiore?

Questi dati rendono le soglie del gate decidibili razionalmente invece di essere semi-arbitrarie.

---

*Piano generato il 2026-06-08. Stima implementazione: 3–4 ore incluso testing.*
