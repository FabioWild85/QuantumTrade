# Audit Report — BotConfig & Pipeline Paper/Live + Backtest

**Data:** 27 Maggio 2026
**File analizzati:** `main.py`, `execution.py`, `backtesting.py`, `decision.py`, `risk.py`

---

## BUG CRITICI

### B1 — `_close_position` aggiorna equity prima di confermare il fill (live mode)
`apps/api/services/execution.py:1619-1626` — L'equity viene incrementata prima di `_submit_close_order()`. Se l'ordine fallisce, equity in memoria è corrotta.
**Fix:** spostare `self._equity += pnl_usd` DOPO la conferma del fill.

### B2 — `kill()` invia close order due volte in live mode
`apps/api/services/execution.py:276-290` — `kill()` chiama `_submit_close_order()` e poi `_close_position()` che lo richiama. Doppio ordine, log fuorvianti, rate limit sprecati.
**Fix:** rimuovere la chiamata esplicita in `kill()`.

### ~~B3~~ — ~~Inference log scritto PRIMA del check `allowed` di RiskManager~~ ❌ ERRATO
~~`apps/api/services/execution.py:893-956`~~ — **Verificato contro il codice: non è un bug.** `can_trade()` viene chiamato a ~line 801, `_log_inference` a ~line 895 — l'ordine è corretto. Il log avviene *dopo* che `allowed` è già noto. La scelta di loggare anche i trade bloccati è intenzionale per avere dati di calibrazione completi. Non richede fix.

### B4 — Backtest: Sharpe ratio su equity curve non uniforme
`apps/api/services/backtesting.py:698-702` — `equity_curve` ha entry solo a trade open/close, non bar-per-bar. `np.diff` assume rendimenti equispaziati ma non lo sono. Sharpe sistematicamente distorto.
**Fix:** costruire equity curve bar-per-bar riempiendo i periodi flat.

### B5 — Backtest: Calmar ratio non annualizzato
`apps/api/services/backtesting.py:724-725` — Calmar = `total_pnl_pct / max_dd` senza annualizzazione. Non confrontabile tra periodi diversi.
**Fix:** `annual_return = (1 + total_pnl_pct/100) ** (365/duration_days) - 1`.

---

## BUG MEDI

### M1 — `_open_position`: `getattr` vs accesso diretto inconsistente
`apps/api/services/execution.py:1212-1225` — Alcuni campi usano `getattr(cfg, "f", default)`, altri `cfg.f`. Se un campo manca, alcuni fallbackano silenziosamente, altri causano `AttributeError`.

### M2 — `_manage_position` usa `self.config` live, non snapshot
Se il config cambia a metà trade (PUT /bot), trailing SL, partial TP, LGBM exit cambiano immediatamente. Non documentato.

### M3 — `_restore_paper_state` backfilla con config corrente, non storico
`apps/api/services/execution.py:442-453` — Dopo restart, partial_tp_price e trailing usano i nuovi moltiplicatori, non quelli all'apertura. Impatto UI.

### M4 — `_log_inference`: `bot_id` hardcodato a `None`
`apps/api/services/execution.py:1873` — Tutte le altre tabelle usano `"default"`. Rompe coerenza.

### M5 — Retrain schedule resetta dopo restart
`apps/api/services/execution.py:1033-1035` — `_cycle_count` parte da 0. Dopo restart frequenti, il retrain non scatta mai.

### M6 — `_submit_open_order`: `oid` da `resting` anche per ordini filled
`apps/api/services/execution.py:1780` — IOC fully filled non ha campo `resting`. `oid=None` indistinguibile da errore.

---

## RACE CONDITION

### R1 — `_open_position` muta `self._risk` senza lock
`apps/api/services/execution.py:1194-1231` — Salva/ripristina attributi di `self._risk`. Sicuro oggi (no await in `calculate_trade_params`), fragile in futuro.
**Fix:** usare copia locale dei parametri.

### R2 — Paper watchdog e `_manage_position` concorrenti su `self._position`
Watchdog (ogni 30s) e `_manage_position` (ogni 4h) accedono a `self._position`. Operazioni read-modify-write sul trailing SL non sono atomiche vs watchdog.
**Fix:** `asyncio.Lock` su `self._position`.

---

## INCONGRUENZE

- **I1** — `DecisionEngine` creato ex-novo ogni ciclo con 23+ parametri. Ogni nuova feature va aggiunta in 3 file. Rischio desincronizzazione.
- **I2** — `_cycle` usa `self.config.chronos_enabled` invece di `cfg.chronos_enabled` (oggi stesso oggetto, ma il codice suggerisce che potrebbero differire).
- **I3** — `_log_inference` fa merge `{**features, **covars}` — se collidono, covars sovrascrive silenziosamente.
- **I4** — `_close_position`: `_valid_reasons` include `"max_funding"` ma non viene mai usato. Manca `"end_of_period"` (ma usato solo in backtest).
- **I5** — `confluence` calcolato solo se `cfg.confluence_gate > 0` (non `>= 0`). Corretto ma poco chiaro.
- **I6** — Regime detection al ciclo 0 (`0 % 4 == 0`). Eseguito subito con warmup potenzialmente insufficiente.

---

## CODICE MORTO

- **D1** — `"max_funding"` in `_valid_reasons` ma mai usato come reason.
- **D2** — `rv_72` letto in `decision.py:144` ma mai referenziato.

---

## DESIGN / MANUTENIBILITÀ

- **P1** — **30 parametri** nel costruttore di `DecisionEngine` (il report originale diceva "35+", conteggio corretto dopo verifica). Passare `BotConfig` direttamente eliminerebbe la necessità di aggiornarli in 3 file ad ogni nuova feature.
- **P2** — `execution.py` `BotConfig` è classe plain, non dataclass. Nessun type checking.
- **P3** — `covars` passato a `_log_inference` ma mergiato con `features` internamente. Interfaccia confusa.
- **P4** — Slippage 50bps hardcodato in 3 punti (`_submit_open_order`, `_submit_partial_close`, `_submit_close_order`). Dovrebbe essere costante/configurabile.

---

## RIEPILOGO

| Severità | Count | IDs |
|----------|-------|-----|
| CRITICAL | 4 | B1, B2, ~~B3~~, B4, B5 — **B3 ERRATO, rimosso** |
| MEDIUM | 6 | M1, M2, M3, M4, M5, M6 |
| RACE | 2 | R1, R2 |
| INCONS. | 6 | I1–I6 |
| MORTO | 2 | D1, D2 |
| DESIGN | 4 | P1–P4 |

**Totale: 24 issue reali** (B3 rimosso — falso positivo verificato contro codice).

> Per i punti in comune con il report parametri frontend/API vedere [`parameter-audit-2026-05-27.md`](./parameter-audit-2026-05-27.md) — sezione "Punti in Comune". In particolare: **M1 di questo report = C4/C4b** dell'altro (stessa root cause, 17 campi mancanti da `BotConfig.__init__`); **R1 di questo report = H6** dell'altro (declassato a debito tecnico).
