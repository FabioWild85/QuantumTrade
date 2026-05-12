# AI Trading Hub — Piano di implementazione (v2, uso personale)

> Documento aggiornato il 12 Maggio 2026 dopo Q&A iniziale.
> Scopo: integrare nella piattaforma Quantum Trade una sezione "AI Trading Hub" che esegue trade automatici su Hyperliquid usando Chronos-2 come modello di forecasting, **per uso strettamente personale** dell'autore.
> **Nessun codice in questo documento**: è il blueprint operativo prima di scrivere una riga di produzione.

---

## PARTE 0 — TL;DR

**Cosa costruiamo:** un singolo bot di **Trend Following su 4h** su **BTC-PERP** di **Hyperliquid**, guidato da **Chronos-2 Base** (CPU) con covariate prese dai servizi già esistenti di Quantum Trade (RSI, MACD, ATR, Open Interest, Funding Rate, ETF flows, Confluence Score). UI integrata in Quantum Trade come nuova tab.

**Vincoli reali del progetto:**

- **Uso strettamente personale.** Nessuna esposizione a terzi → MiCA non si applica → architettura single-tenant senza compliance overhead.
- **Self-custody totale** via wallet personale + agent wallet Hyperliquid (chiave delegata a permessi solo-trading, revocabile on-chain).
- **Integrazione massima con Quantum Trade**: i dati che già raccogli sono **covariate per Chronos-2**, non vanno duplicati.
- **MVP in 5–6 settimane**, costo infra **~$6/mese in paper, ~$40–50/mese in live**.

**Definizione di successo MVP:** 1 bot in paper trading su Hyperliquid testnet che gira 30 giorni consecutivi senza crash, con dashboard live che mostra forecast probabilistico Chronos-2 sovrapposto al prezzo, equity curve, log decisioni AI, kill-switch funzionante.

**Aspettativa onesta di profittabilità live (post-MVP):** Sharpe netto fees realistico 0.8–1.5, drawdown atteso 15–25%, probabilità ~30–40% di essere effettivamente profittevole netto fees su 12 mesi OOS. **Non è una macchina per fare soldi, è un investimento in skill con upside reale ma incerto.**

---

## PARTE 1 — Decisioni architetturali fondamentali

### 1.1 Cosa il sistema **non** è (decisioni esplicite per non disperdere energie)

- ❌ **Non è scalping.** Chronos-2 ha latenze 200–1500 ms, fees Hyperliquid 0.025% taker mangerebbero qualsiasi edge sub-minuto.
- ❌ **Non è multi-utente.** Single-user → niente SIWE, niente JWT, niente row-level security complesso.
- ❌ **Non è multi-asset al lancio.** Solo BTC-PERP. ETH-PERP arriva in fase 3 dopo aver visto numeri reali.
- ❌ **Non è multi-modello al lancio.** Solo Chronos-2 Base. TimesFM eventualmente in fase 2 come secondo parere.
- ❌ **Non è multi-strategia al lancio.** Solo Trend Following. Mean Reversion eventualmente in fase 4.
- ❌ **Non c'è un Model Server separato.** Chronos-2 Base gira in-process nel Execution Engine (CPU, 1–2s per inference, accettabile per timeframe 4h).

### 1.2 Cosa il sistema **è**

- ✅ **Single-user, single-bot, single-asset, single-strategy** in MVP.
- ✅ **Auto-hosted** su un singolo VPS personale (Hetzner CX22 o equivalente).
- ✅ **Integrato con Quantum Trade** come nuova sezione UI + condivisione data layer (i `services/` esistenti diventano la fonte primaria di dati e covariate).
- ✅ **Self-custody** via Agent Wallet di Hyperliquid (chiave delegata revocabile, mai la seed del wallet principale tocca il server).
- ✅ **Auditabile**: ogni ordine ha un `inference_id` che permette di ricostruire features, forecast e ragionamento.
- ✅ **Fail-safe**: se qualcosa si rompe (API HL down, modello non risponde, dati stale > 5 min), il bot **non apre posizioni** e alerta via Telegram. Preferisce no-trade a bad-trade.

### 1.3 La strategia (definita esplicitamente)

**Nome:** `TrendFollowing4hBTC`

**Dati necessari (ogni close di candela 4h):**
1. OHLCV BTC-PERP ultime 512 candele 4h (~85 giorni) — già in Quantum Trade.
2. Covariate da Quantum Trade:
   - RSI(14), MACD, ATR(14), BB width
   - Open Interest e Funding Rate (da Binance Futures, piano v2 P-04 di Quantum Trade)
   - DXY, SPX delta giornaliero
   - ETF Net Flows (Farside via AI Search o diretta)
   - Multi-Timeframe Confluence Score (Quantum Trade A-01)

**Pipeline di decisione:**

1. **Filtro regime (gating)**: se `ADX(14) < 20` **OR** `realized_vol_7d < median_30d * 0.7` → **no-trade** (mercato in compressione, trend following non funziona).
2. **Forecast Chronos-2 Base** con covariate, orizzonte 6 step (24h avanti).
3. **Decisione long**: se `forecast_p50_h+6 > price * 1.005` **AND** `forecast_p10_h+6 > price` (anche scenario pessimista positivo) **AND** `Confluence Score > 60`.
4. **Decisione short**: simmetrica con segno invertito.
5. **No-trade altrimenti.**

**Risk management:**
- **Position sizing**: 1.5% del capitale per trade (fixed fraction, non Kelly aggressivo).
- **Stop Loss**: `entry ± 2.0 * ATR(14)`.
- **Take Profit**: `entry ± 3.5 * ATR(14)` (R:R ~1.75).
- **Max daily drawdown**: -3% → kill bot, riavvio manuale.
- **Max consecutive losses**: 4 → pausa 24h.
- **Max funding cost**: se funding annualizzato > 30% contro la posizione → exit forzata.

**Aspettative numeriche realistiche (da comunicare a sé stessi):**
- Trades/mese: 5–15.
- Win rate: 40–50%.
- Sharpe netto fees: 0.8–1.5 nel best case.
- Drawdown massimo atteso in 12 mesi: 20–25%.

---

## PARTE 2 — Stack tecnico (semplificato per single-user)

| Layer | Tech | Note |
|-------|------|------|
| **Frontend** | Estensione di Quantum Trade esistente (React 19 + Vite + TS + Tailwind + shadcn/ui) | Nuova tab "AI Trading Hub" nel `App.tsx`, niente nuovo progetto |
| **Charting** | `lightweight-charts` (TradingView open source) | Candles + fan chart per forecast probabilistico |
| **API Backend** | FastAPI + Pydantic v2 | Single Python service, no microservizi |
| **Execution Engine** | Stesso processo FastAPI con un task `asyncio` background che gestisce il loop trading | Niente process separation per single-bot. Se in futuro servono N bot, si separerà. |
| **Modello AI** | `chronos-forecasting` package, Chronos-2 Base, in-process, CPU | Inference 1–2s, perfetto per 4h tf |
| **DB + Auth + Realtime** | **Supabase Pro** ($25/mese live, free in MVP) | Postgres + estensione `timescaledb` community + Realtime WS + Auth (anche se single-user, utile per proteggere la dashboard) |
| **Hyperliquid** | `hyperliquid-python-sdk` ufficiale | Mainnet + testnet con stessa libreria |
| **Wallet** | RainbowKit / Wagmi nel frontend per connect; Agent Wallet HL creato lato server al primo onboarding | Chiave agent salvata cifrata in Supabase Vault o `age`-encrypted con master key in env |
| **Notifiche** | Bot Telegram (gratuito) | Alert fill, errori, kill, daily summary |
| **Logging** | Sentry free tier (5k events/mese) + log strutturati su Supabase | Bastano per single-user |
| **Hosting** | Hetzner Cloud CX22 (€4.50) → CX32 (€11) in live | Docker Compose, niente Kubernetes |
| **Deploy** | Docker Compose + GitHub Actions per build immagine + `docker compose pull && up` via SSH | Niente CI/CD elaborato |

### 2.1 Perché Supabase e non TimescaleDB self-hosted

Per le tue volumetrie (1 bot, 4h timeframe → ~2000 candele/anno + qualche migliaio di trade/inference log) **Postgres normale basta**. Supabase aggiunge:

- Auth integrata (per proteggere la dashboard remota).
- Realtime via WebSocket nativo (l'UI si sottoscrive a `INSERT` su `equity_snapshots`, `orders`, `inference_logs` senza che tu scriva pub/sub).
- Dashboard SQL editor utilissimo per debug.
- Backup automatici.
- Estensione `timescaledb` community attivabile se serve in futuro.

Risparmio stimato: **3–5 giorni di setup e manutenzione** rispetto a Postgres+Timescale self-hosted.

---

## PARTE 3 — Integrazione con Quantum Trade (chiave del progetto)

L'AI Trading Hub **non è un'app separata che riusa il logo di Quantum Trade**: è una nuova capacità che usa **gli stessi dati** già raccolti dalla piattaforma esistente. Questa è la fonte principale del vantaggio competitivo del sistema rispetto a un bot generico.

### 3.1 Ruolo dei due sistemi

```
Quantum Trade (Brain)                  AI Trading Hub (Hands)
┌─────────────────────────┐            ┌──────────────────────────┐
│ services/binance.ts     │            │ services/chronos.py      │
│ services/coingecko.ts   │            │ services/decision.py     │
│ services/etherscan.ts   │ ─covariate→│ services/risk.py         │
│ utils/indicators.ts     │ + features │ services/hyperliquid.py  │
│ Multi-TF Confluence     │            │ services/execution.py    │
│ Liquidation Levels      │            │                          │
└─────────────────────────┘            └──────────────────────────┘
       (TypeScript, frontend)                  (Python, backend)
                │                                       │
                └────────── Supabase ───────────────────┘
                        (singola fonte di verità)
```

### 3.2 Dipendenza esplicita: cosa va completato in Quantum Trade prima

Nel piano `piano-evoluzione-v2.md` esistono già features pianificate che sono **prerequisiti** per il successo dell'AI Trading Hub. Da completare **prima** o in parallelo alla Fase 1 dell'AI Hub:

| ID Quantum v2 | Cosa | Perché serve all'AI Hub |
|---------------|------|------------------------|
| **P-01** | CoinGecko ATH/Dominance | Feature di contesto per il modello |
| **P-04** | Binance Open Interest + Funding Rate | **Covariate killer**: senza queste, Chronos-2 su perp è cieco al 30% del segnale |
| **A-01** | Multi-Timeframe Confluence Score | Filtro di gating per la strategia |
| **A-03** | Heatmap Volatilità (ATR relativo) | Sizing dinamico vol-target |
| **A-04** | Liquidation Levels | Trigger di exit (prezzo magnetizzato) |

**Sforzo aggiuntivo Quantum Trade**: ~10h (già pianificato in `piano-evoluzione-v2.md`).

### 3.3 Pattern di condivisione dati

I `services/` di Quantum Trade (TypeScript, frontend) restano la fonte primaria di dati per la UI. Il backend Python dell'AI Hub **non duplica** questa pipeline: legge le stesse informazioni da Supabase, dove un cron job o l'attivazione della UI le scrive periodicamente.

**Flusso concreto:**

1. Quando Quantum Trade fa un fetch di OHLCV/indicatori/macro per la dashboard, il risultato viene **anche** scritto su Supabase nella tabella corrispondente (idempotente, dedupe per timestamp).
2. L'Execution Engine Python legge da Supabase quando serve costruire features per Chronos-2.
3. Quantum Trade e AI Hub vedono **gli stessi numeri**, niente disallineamenti.

In MVP si può semplificare: il backend Python fa direttamente le call a Binance API (stesse fonti del frontend). Si centralizza in fase 2 quando il volume di dati cresce.

---

## PARTE 4 — UI/UX integrata in Quantum Trade

### 4.1 Navigazione

```
Quantum Trade
├── Dashboard          (esistente)
├── Technical Panel    (esistente)
├── News               (esistente)
└── AI Trading Hub  ◄── NUOVO
    ├── Monitor        (panoramica del bot, equity live, ultima decisione)
    ├── Bot Config     (parametri della strategia, salva e applica)
    ├── Forecast View  (Chronos-2 fan chart su BTC-PERP, anche fuori dal bot)
    ├── Trade Log      (storico trade + log inference con "perché")
    ├── Backtesting    (interfaccia per simulazione storica)
    └── Settings       (agent wallet, kill-switch globale, paper/live toggle)
```

### 4.2 Componenti UI prioritari

| Sezione | Cosa mostra | Priorità |
|---------|-------------|----------|
| **Monitor** | Stato bot (running/paused/killed), equity curve live (Realtime sub a `equity_snapshots`), PnL today, drawdown corrente, ultima decisione AI con reasoning, mini fan-chart 24h forecast | 🔴 P0 |
| **Forecast View** | Candele BTC-PERP 4h + fan chart Chronos-2 (bande p10–p90, p25–p75, mediana) sovrapposta, marker entry/exit dei trade reali, tooltip con valori quantili | 🔴 P0 |
| **Bot Config** | Form con: SL multiplier ATR, TP multiplier ATR, position size %, max daily DD, soglia confluence, gating ADX/vol on/off, paper/live toggle. Validazione + confirm dialog. | 🔴 P0 |
| **Trade Log** | Tabella trade con expand row che mostra: features usate, forecast quantili, reasoning, slippage reale vs atteso, fill quality | 🔴 P0 |
| **Backtesting** | Form (date range, capitale iniziale) → job async → risultati (equity, drawdown, Sharpe, Sortino, Profit Factor, trade list, distribuzione PnL) | 🟡 P1 |
| **Settings** | Connect wallet, create/revoke agent wallet, kill-switch globale (stop tutti i bot), Telegram bot token, notification preferences | 🔴 P0 |

### 4.3 Componente "money-shot": Forecast Probabilistico

Il pezzo di UI più importante di tutto il progetto. Specifiche:

- Candele storiche di BTC-PERP (ultime 50 candele 4h ~ 8 giorni).
- Da timestamp corrente in avanti, **fan chart** con bande:
  - Area ombreggiata chiara: quantile 10–90.
  - Area ombreggiata più scura: quantile 25–75.
  - Linea mediana solida.
- Linee orizzontali per SL e TP del trade attivo (se esiste).
- Marker triangolari per entry/exit storici nelle 50 candele visibili.
- Tooltip al hover: `{price, forecast_mean, p10, p50, p90, crps_rolling_7d}`.
- Toggle per mostrare/nascondere covariate plot sotto (RSI, OI, Funding, Confluence Score) in pannelli sincronizzati.

Estetica: dark theme coerente con Quantum Trade (glassmorphism, palette esistente). Niente CSS nuovo, riusare classi Tailwind del progetto.

---

## PARTE 5 — Schema database (Supabase Postgres)

Tabelle minime per MVP (single-user, niente `user_id` ovunque — basta una constraint che ce ne sia uno solo):

- `bot_configs (id, name, params jsonb, mode ['paper'|'live'], status, created_at, updated_at)`
- `agent_wallets (id, address, encrypted_privkey, permissions, created_at, revoked_at)`
- `ohlcv (time, symbol, tf, o, h, l, c, v)` — PK `(time, symbol, tf)`, indice su `time DESC`
- `covariates (time, symbol, source, key, value)` — flessibile per RSI/OI/Funding/ETF/etc.
- `inference_logs (id, time, bot_id, model, features jsonb, forecast jsonb, decision, reasoning, latency_ms)`
- `orders (id, bot_id, hl_order_id, tx_hash, symbol, side, size, price, status, filled_size, avg_fill_price, fees_usd, slippage_bps, created_at, filled_at, inference_id)`
- `trades (id, bot_id, entry_order_id, exit_order_id, pnl_usd, pnl_pct, holding_sec, reason_open, reason_close, opened_at, closed_at)`
- `equity_snapshots (time, bot_id, equity_usd, unrealized_pnl, realized_pnl, drawdown_pct)` — Realtime sub da UI
- `events (id, time, severity, kind, message, payload jsonb)` — alerts, kill, riconciliazione, errori

**Estensione `timescaledb`** attivabile su `ohlcv`, `inference_logs`, `equity_snapshots` quando i volumi lo giustificheranno (verosimilmente mai per uso personale).

**Realtime Supabase** abilitato su: `equity_snapshots`, `orders`, `inference_logs`, `events` → la UI si aggiorna in push senza polling.

---

## PARTE 6 — Endpoint FastAPI essenziali

Auth: per uso personale basta una **password singola** + Supabase Auth (email/password) o un middleware basic-auth. Niente SIWE multi-utente.

**Wallet**
- `POST /wallet/connect` — riceve l'address del wallet principale dal frontend
- `POST /wallet/agent` — crea agent wallet HL, lo salva cifrato
- `DELETE /wallet/agent/{id}` — revoca on-chain

**Bot**
- `GET /bot` — config corrente (single bot in MVP)
- `PUT /bot` — aggiorna config
- `POST /bot/start` — avvia loop (body: `{mode: paper|live}`)
- `POST /bot/stop` — stop graceful
- `POST /bot/kill` — kill immediato (cancella ordini aperti, chiude posizioni)
- `GET /bot/status` — snapshot stato

**Data**
- `GET /forecast?symbol=BTC&horizon=6` — forecast Chronos-2 ad-hoc (per Forecast View standalone)
- `GET /equity?from=...&to=...`
- `GET /trades?limit=100`
- `GET /inference-logs?limit=50`

**Backtesting**
- `POST /backtest` — avvia job async
- `GET /backtest/{id}` — stato + risultati

**Realtime via Supabase**
- Niente WS server custom: il frontend si sottoscrive direttamente a Supabase Realtime sulle tabelle `equity_snapshots`, `orders`, `inference_logs`, `events`.

---

## PARTE 7 — Roadmap esecutiva (5–6 settimane MVP)

### 🔴 Settimana 0 — POC e validazione (5 giorni, NON saltare)

Obiettivo: **decidere se il progetto ha senso** prima di investire 5 settimane.

- [ ] Notebook Jupyter: scarica BTC 4h da Binance per ultimi 24 mesi.
- [ ] Esegui Chronos-2 Base zero-shot (no covariate ancora) con walk-forward (12 mesi training-window non-applicabile per zero-shot, quindi: rolling forecast su 12 mesi OOS).
- [ ] Calcola **CRPS** vs naive baseline (random walk).
- [ ] **Criterio go/no-go**: CRPS Chronos-2 < CRPS naive di almeno **5%** su 12 mesi OOS BTC 4h.
- [ ] Se ok, ripeti con covariate sintetiche (RSI, ATR calcolati dal pandas) per verificare che migliori.
- [ ] In parallelo: script Python che usa `hyperliquid-python-sdk` per creare agent wallet su testnet, piazzare un ordine market BTC 0.001, leggere fill via WS. Misura latenza.

**Output**: documento `decisions.md` con risultato CRPS, latenza HL, decisione go/no-go scritta.

### 🔴 Settimana 1 — Infra base

- [ ] Repo restructure: `apps/web` (frontend Quantum Trade esistente + nuova tab), `apps/api` (FastAPI + execution engine in-process), `packages/shared-types` (TypeScript types da Pydantic via OpenAPI).
- [ ] Docker Compose locale: FastAPI + Supabase locale (o cloud free).
- [ ] Schema DB iniziale (Alembic migration + Supabase migration files).
- [ ] Connessione wallet RainbowKit nel frontend, mock agent creation.
- [ ] Endpoint `POST /wallet/agent` che crea davvero l'agent su Hyperliquid testnet e lo salva cifrato.
- [ ] Bot Telegram per notifiche (template messaggi: bot started, trade opened, trade closed, error, killed).

### 🔴 Settimana 2 — Execution engine + decision loop

- [ ] Modulo `services/binance.py`: fetch OHLCV BTC 4h.
- [ ] Modulo `services/covariates.py`: RSI, ATR, MACD, ADX, OI, Funding (chiamate Binance Futures API).
- [ ] Modulo `services/chronos.py`: wrapper Chronos-2 Base con interface `forecast(series, covariates, horizon) -> {p10, p50, p90, mean}`.
- [ ] Modulo `services/decision.py`: implementa la logica di gating + decisione long/short/no-trade descritta in §1.3.
- [ ] Modulo `services/risk.py`: SL/TP basati su ATR, position sizing, max DD checks.
- [ ] Modulo `services/hyperliquid.py`: submit/cancel order, WS subscriptions per fills/positions.
- [ ] Modulo `services/execution.py`: il loop principale (asyncio task) che ogni close 4h: fetch dati → costruisce features → forecast → decide → esegue → logga tutto.
- [ ] Riconciliazione ogni 60s tra stato DB e stato HL (WS positions).

### 🔴 Settimana 3 — UI integrata in Quantum Trade

- [ ] Nuova tab "AI Trading Hub" in `App.tsx` con routing client-side semplice (state Zustand).
- [ ] Pagina **Monitor** con sub Realtime a `equity_snapshots` + componente status bot.
- [ ] Pagina **Forecast View** con `lightweight-charts` + fan chart custom series (bande p10–p90, p25–p75, mediana).
- [ ] Pagina **Bot Config** form con validazione e confirm dialog.
- [ ] Pagina **Trade Log** con expand row sui dettagli inference.
- [ ] Pagina **Settings** con kill-switch globale.

### 🟡 Settimana 4 — Backtesting + hardening

- [ ] Backtesting engine: walk-forward, fees realistiche HL, slippage modellato come `0.5 * (best_ask - mid) / mid * size_factor`.
- [ ] Metriche: Sharpe, Sortino, Calmar, Profit Factor, Max DD, Ulcer Index, distribuzione holding time.
- [ ] UI Backtesting con form + grafici risultati.
- [ ] Stress test: 72h continue in paper sul VPS, monitoring delle ricorrenze (memory leak, file descriptor leak, slow queries).
- [ ] Setup Sentry per cattura crash silenziosi.

### 🟡 Settimana 5 — Paper trading run + osservazione

- [ ] Bot acceso in paper mode su Hyperliquid testnet, lasciato correre per **almeno 14 giorni** continui.
- [ ] Dashboard visitata quotidianamente, log letti.
- [ ] Drift detection: CRPS rolling 7gg, alert se degrada > 20% rispetto al backtest.
- [ ] Aggiustamento parametri se necessario (ma **niente overfitting in real-time**: solo una modifica a settimana max, documentata in `decisions.md`).

### 🟢 Settimana 6 — Decisione live + primo deploy

- [ ] Review completa dei 14+ giorni di paper.
- [ ] Se Sharpe paper > 0.7 e nessun bug critico: **deploy live con $500–1000 di capitale iniziale**.
- [ ] Se Sharpe paper < 0.7: **non andare live**, torna a Settimana 4 e rivedi strategia/parametri.
- [ ] Primo trade live = momento di celebrazione documentato (screenshot, blog post privato per posterità).

---

## PARTE 8 — Costi reali

### 8.1 Infrastruttura

| Voce | MVP (paper, prime 5–6 sett.) | Live (post-MVP) |
|------|------------------------------|-----------------|
| VPS Hetzner CX22 (2 vCPU, 4GB) | €4.50 | — |
| VPS Hetzner CX32 (4 vCPU, 8GB) | — | €11 |
| Supabase Free | $0 | — |
| Supabase Pro | — | $25 |
| Sentry Free | $0 | $0 |
| Telegram bot | $0 | $0 |
| Backup snapshot VPS | — | €1.40 |
| Dominio (opzionale) | $1 | $1 |
| **Totale infra** | **~$6/mese** | **~$40–45/mese** |

### 8.2 Costi di trading (variabili)

- **Hyperliquid fees**: 0.025% maker / 0.075% taker. Su 50 trade/mese da $5000 size con prevalenza market: ~$15–20/mese di fees.
- **Funding cost**: imprevedibile, dipende dalla direzione delle posizioni vs funding rate. Modellato nel backtesting.
- **Gas L1 per agent wallet management**: ~$5 una tantum per approve, $0 per i trade (Hyperliquid L1 è gas-free per operazioni di trading).

### 8.3 Capitale di trading

- **MVP paper**: $0 (testnet).
- **Primo deploy live consigliato**: $500–1.000.
- **Mental accounting**: considerare il capitale iniziale come **spesa R&D**, non investimento. Se va perso, è il prezzo della formazione pratica.
- **Scaling**: solo dopo 3 mesi di live profittevole, e mai più del 20% del capitale totale liquido in questo sistema.

### 8.4 Modello inferenza Chronos-2

In MVP gira su **CPU del VPS** (Chronos-2 Base ~200M parametri, inference 1–2s su 2 vCPU, accettabile per timeframe 4h). **Costo zero aggiuntivo.**

Se in fase 2 si vuole passare a Chronos-2 Large (più accurato ma 500–1500ms anche su CPU buona):
- **Replicate API**: ~$0.0005 per inference. Su 6 inference/giorno (close 4h): $0.09/mese. Trascurabile.
- **Modal/Beam GPU on-demand**: ~$2/mese per le tue volumetrie.
- **VPS GPU dedicata**: $80–150/mese — **non giustificato** per single-bot 4h.

---

## PARTE 9 — Rischi reali e mitigazioni

| Rischio | Probabilità | Impatto | Mitigazione |
|---------|-------------|---------|-------------|
| **Chronos-2 non batte baseline su crypto** | Media | 🔴 Alto | POC Settimana 0 obbligatorio. Se fallisce, pivot a XGBoost + features classiche. |
| **Overfitting via data contamination** (BTC nel pretrain di Chronos) | Alta | 🔴 Alto | Walk-forward strict su periodo post-cutoff del pretrain. Se accuracy crolla post-cutoff, è un brutto segno. |
| **Hyperliquid downtime** | Bassa | 🟡 Medio | Bot in modalità safe (no nuove posizioni, mantieni esistenti, alert) durante outage. Niente fallback automatico ad altri venue in MVP. |
| **Compromissione del VPS** | Bassa | 🟡 Medio | Agent wallet ha solo permessi trading, max danno = chiusura forzata posizioni dall'attaccante. Revoca immediata da wallet principale. |
| **Drawdown catastrofico in live** | Alta (è normale) | 🟡 Medio | Capitale iniziale piccolo, max daily DD 3% hard-coded, kill-switch testato unitariamente. |
| **Bug nel risk manager** che non chiude SL | Media | 🔴 Alto | Test unitari ESTESI sul risk manager prima di andare live. Doppio livello: SL nel bot + SL nativo Hyperliquid. |
| **Latenza inference > 5s causa skip-trade ripetuti** | Bassa | 🟢 Basso | Se succede, accettabile. Meglio no-trade che bad-trade. |
| **Burnout / abbandono progetto** | Media | 🟡 Medio | Scope ridotto al minimo (1 bot, 1 asset, 1 strategy). Niente over-engineering. Se si ferma, riprende facilmente. |

---

## PARTE 10 — Definizioni di successo

Il progetto è **chiuso con successo MVP** se al termine di Settimana 6 sono vere tutte queste:

1. ✅ Il bot ha girato in paper su testnet HL per ≥ 14 giorni consecutivi senza crash non gestiti.
2. ✅ La dashboard Quantum Trade mostra il forecast Chronos-2 (fan chart) sovrapposto al prezzo BTC-PERP, aggiornato ad ogni close 4h.
3. ✅ Ogni trade simulato ha un `inference_id` che permette di vedere le features e il reasoning che lo ha causato.
4. ✅ Il kill-switch funziona in < 1 secondo (testato unitariamente e una volta in vivo).
5. ✅ Il backtesting walk-forward su 12 mesi OOS produce Sharpe netto fees > 0.7.
6. ✅ I costi mensili reali sono entro il budget pianificato ($40–50/mese live).

Il progetto è **chiuso con successo full** se dopo 3 mesi di live:

7. ✅ Sharpe live > 0.6 (sempre più basso del paper, è normale).
8. ✅ Drawdown massimo osservato < 30%.
9. ✅ Nessuna perdita di capitale dovuta a bug (le perdite sono solo "di mercato").
10. ✅ L'autore ha imparato abbastanza da poter scrivere un blog post tecnico onesto sul progetto.

---

## PARTE 11 — Cosa NON fare (lezioni dolorose pre-imparate)

- ❌ **Non aggiungere features prima dei 14 giorni di paper**. Resistere alla tentazione di "una feature in più poi vado live".
- ❌ **Non ottimizzare i parametri sui dati di paper trading**. È overfitting. I parametri si fissano dal backtesting OOS, e si modificano solo con regole esplicite (es. CRPS drift > 20%).
- ❌ **Non andare live se il paper Sharpe è < 0.7**. Il live è sempre peggio del paper (slippage, latenza, regime change).
- ❌ **Non aggiungere un secondo asset/strategia/modello prima di 3 mesi di live profittevole sul primo**. Multiplica complessità senza multiplicare comprensione.
- ❌ **Non scalare il capitale dopo una settimana fortunata**. Random sequence di vittorie esistono, non sono skill.
- ❌ **Non usare leva > 3x mai**. Hyperliquid permette 50x. È il modo più veloce per perdere tutto.
- ❌ **Non mostrare il bot a estranei**. Non serve, e ti spinge psicologicamente a forzare risultati. Tieni privato per almeno 6 mesi.

---

## PARTE 12 — Aspettative realistiche di profittabilità

Trasparenza brutale:

- ~**95% dei trader retail algo perde** soldi su orizzonte > 1 anno. Le ragioni sono sempre le stesse: edge < costi, sizing/risk amatoriale.
- I **modelli AI risolvono solo la previsione direzionale**, che è ~20% della performance reale. Il resto sta in sizing, risk, regime selection, esecuzione.
- **Sharpe realistici crypto retail systematic**: 0.5–1.5. Sopra 2 = sospetto o lucky sample. Sotto 0.5 = praticamente random + fees.

**Probabilità stimate per questo progetto specifico** (con piano corretto e disciplina):

| Outcome a 12 mesi (6 paper + 6 live) | Probabilità |
|--------------------------------------|-------------|
| Profittevole netto fees, Sharpe > 1 | ~30–40% |
| Break-even (Sharpe 0–1) | ~30% |
| Perdita controllata (-10–30% capitale) | ~20–25% |
| Disastro tecnico/finanziario | ~5–10% |

**Profittabilità come business** (numeri onesti):
- $1.000 capitale, Sharpe 1.0: ~$300–500/anno netti. **Hobby premium**.
- $10.000 capitale: ~$3.000–5.000/anno. **Reddito accessorio**.
- $100.000 capitale: ~$30.000–50.000/anno. **Lavoro serio**, ma serve capitale che il 99% non ha.

**Il vero ROI di questo progetto è formativo, non finanziario:**
- Skill su foundation time-series model (richieste in fondi quant).
- Skill su DeFi perp execution (richieste in trading firm crypto).
- Portfolio progetto serio (utile per CV / freelance / candidature).
- Rete di contatti se condividi (con giudizio) i risultati.

Andare avanti **per le ragioni giuste**: imparare, costruire, capire — con la possibilità reale ma incerta di profitto come bonus.

---

## PARTE 13 — Estensione: operare sotto le 4h (1h o 30m, non scalping)

> Sezione aggiunta come **estensione opzionale post-MVP**. Tutto quello che segue presuppone che l'MVP a 4h sia stato completato con successo e che tu voglia ridurre il timeframe per aumentare la frequenza dei trade. **Non saltare l'MVP a 4h per andare direttamente a 1h.**

### 13.1 Cosa cambia matematicamente passando da 4h a 1h

Passare da 4h a 1h **non è "fare la stessa cosa 4 volte più spesso"**. Cambiano 5 cose contemporaneamente, e ognuna ha implicazioni serie.

| Variabile | 4h | 1h | 30m |
|-----------|-----|-----|------|
| Trade attesi/mese | 5–15 | 30–80 | 60–150 |
| Edge per trade (lordo) | 0.5–1.5% | 0.2–0.6% | 0.1–0.3% |
| Fee taker HL (round-trip) | 0.05% | 0.05% | 0.05% |
| Fee come % dell'edge | 5–10% | 15–30% | **35–60%** |
| Signal-to-noise (alto = buono) | 🟢 Alto | 🟡 Medio | 🔴 Basso |
| Tolleranza a slippage | 🟢 Alta | 🟡 Media | 🔴 Critica |
| Tolleranza a latenza inferenza | 🟢 Alta | 🟡 Media | 🔴 Stringente |

**Conclusione chiave:** a 1h le fees mangiano ~25% dell'edge atteso. A 30m ne mangiano ~50%. Sotto i 30m è scalping di fatto, e Chronos-2 non è lo strumento giusto.

**Soglia di sostenibilità realistica per Chronos-2 retail:**
- ✅ **1h** è il floor sostenibile con accorgimenti seri.
- 🟡 **30m** richiede maker-only execution (rebate) e covariate avanzate.
- ❌ **< 15m** non perseguire mai con foundation models.

### 13.2 Cosa devi modificare nel piano originale

Sezione per sezione, ecco gli interventi necessari:

#### 13.2.1 Strategia (PARTE 1.3)

**Da:** `TrendFollowing4hBTC` con forecast 6 step (24h).
**A:** `TrendFollowing1hBTC` con forecast **12 step (12h)** o `TrendFollowing30mBTC` con **24 step (12h)**.

**Modifiche specifiche alla strategia:**
- **Filtro regime più stretto**: oltre ad ADX > 20, aggiungi `realized_vol_1h_24h > median_30d_realized_vol_1h_24h × 0.8`. A timeframe ridotti, il rumore è maggiore: filtra più aggressivamente.
- **Soglia di forecast più alta**: invece di richiedere `forecast_p50 > price × 1.005` (+0.5%), richiedi `forecast_p50 > price × 1.012` (+1.2%) per 1h e +1.8% per 30m. Compensa il segnale più rumoroso con bar più alta.
- **Confluence Score più stretto**: invece di soglia 60, richiedi **70 a 1h** e **75 a 30m**.
- **R:R più ampio**: invece di 1.75:1, mira a 2.0:1 minimo. I costi proporzionalmente maggiori richiedono compensazione.
- **Anti-flip cooldown**: aggiungi regola "se hai chiuso un trade negli ultimi 2 bar (2h a 1h tf, 1h a 30m tf), non aprire una posizione nella direzione opposta". Previene whipsaw.

#### 13.2.2 Esecuzione: passa a maker-only per 30m, ibrido per 1h

**A 4h**: market order è OK, le fees sono trascurabili rispetto all'edge.

**A 1h**: usa **post-only limit a mid-price ± 0.02%**, con timeout 30 secondi. Se non fillato, cancella e ripiazza al nuovo mid. Solo se 3 tentativi consecutivi falliscono, fallback a market. Risparmi ~50% delle fees (rebate maker -0.005% invece di taker +0.025%, swing di 0.06%).

**A 30m**: **maker-only obbligatorio**. Se il post-only non fila in 60 secondi, **salta il trade** invece di andare market. Meglio no-trade che trade in perdita strutturale.

#### 13.2.3 Stack tecnico (PARTE 2)

| Componente | Modifica richiesta |
|------------|---------------------|
| **Fonte OHLCV** | Da Binance REST a **Hyperliquid WebSocket** (`wss://api.hyperliquid.xyz/ws`). Subscribe su `candle` per il simbolo e timeframe. Latenza fetch da 200–500ms a < 50ms. |
| **Modello Chronos** | Da Chronos-2 **Base** (200M params) a Chronos-2 **Small/Large** in base a CPU disponibile. Se a 1h vuoi qualità migliore, usa Modal/Beam GPU on-demand ($2–5/mese). |
| **Loop trigger** | Da "on close 4h" (deterministico) a "on close 1h" via WS callback. Niente cron, è event-driven. |
| **Latenza inference target** | < 800ms a 1h, < 400ms a 30m. Se la CPU è insufficiente, GPU on-demand è obbligatoria. |
| **Database** | Volumi crescono: a 1h, ~750 candele/mese vs ~180 a 4h. Niente cambio infra (Supabase basta), ma abilita compressione `timescaledb` su `ohlcv` e `inference_logs`. |
| **Riconciliazione** | Da 60s a 15s tra stato DB e stato HL. Posizioni cambiano più spesso, drift più rischioso. |
| **Hosting** | VPS CX22 può diventare insufficiente per Chronos-2 + WS + DB. Passa a **CX32** (4 vCPU, 8GB) o **CCX13** dedicato (€14/mese) se la CPU è satura. |

#### 13.2.4 Covariate aggiuntive (PARTE 3)

Per timeframe ridotti, i segnali macro low-frequency (ETF flows giornalieri, DXY daily) **perdono valore**. Aggiungi covariate higher-frequency:

| Nuova covariata | Fonte | Importanza |
|------------------|-------|------------|
| **Funding rate Hyperliquid live** (non Binance) | HL Info API `/info` con `fundingHistory` | 🔴 Critica |
| **OI delta 1h Hyperliquid** | HL `/info` `metaAndAssetCtxs` snapshot ogni 5min | 🔴 Critica |
| **Mid-price spread** (ask−bid) / mid | HL WS `l2Book` channel | 🟡 Importante |
| **Order book imbalance** (bidVol_top5 / askVol_top5) | HL WS `l2Book` | 🟡 Importante |
| **Trade flow imbalance** (buy_volume − sell_volume) ultime 4h | HL WS `trades` channel | 🟡 Importante |
| **Volatilità realizzata 1h rolling 24h** | Calcolata localmente da OHLCV | 🟢 Utile |

Le **covariate Quantum Trade** (RSI 4h, OI Binance, ETF flow) restano come **contesto macro** ma con peso ridotto. A 1h dominano le covariate microstrutturali HL.

#### 13.2.5 Risk management (PARTE 1.3)

| Parametro | 4h | 1h | 30m |
|-----------|-----|-----|------|
| Position size | 1.5% | **1.0%** | **0.7%** |
| SL (× ATR(14)) | 2.0 | **1.5** | **1.2** |
| TP (× ATR(14)) | 3.5 | **3.0** | **2.5** |
| Max daily DD | -3% | **-2.5%** | **-2.0%** |
| Max trades/giorno | illimitato | **6** | **10** |
| Max consecutive losses | 4 | **3** | **3** |
| Cooldown post-loss | 0 | **2 bar (2h)** | **3 bar (1.5h)** |

**Razionale**: la frequenza maggiore aumenta la probabilità di drawdown sequenze. Compensa riducendo size e mettendo cap sui trade/giorno.

#### 13.2.6 Roadmap (PARTE 7)

Non è una nuova roadmap da zero, è un **upgrade post-MVP**:

- **Settimana 7–8** (post-MVP a 4h, ≥ 30gg paper + ≥ 30gg live profittevole): preparazione transizione.
  - Refactor data layer per WS Hyperliquid invece di REST Binance.
  - Aggiungi covariate microstrutturali (l2Book, trades flow).
  - POC notebook: Chronos-2 su BTC 1h ultimi 12 mesi, CRPS vs naive. **Stesso criterio go/no-go**: CRPS Chronos-2 < naive di ≥ 5% su 12 mesi OOS.
- **Settimana 9**: implementazione `TrendFollowing1hBTC` come **bot separato**, in parallelo a quello 4h che continua a girare. Niente switch totale.
- **Settimana 10–12**: paper trading 1h per ≥ 30 giorni.
- **Settimana 13+**: live solo se paper Sharpe > 0.7 *e* il bot 4h originale resta profittevole (evidenza che il framework funziona).

### 13.3 Costi aggiuntivi

| Voce | Δ rispetto al 4h |
|------|-------------------|
| VPS upgrade (CX22 → CX32) | +€6.50/mese |
| GPU on-demand Modal/Beam (se serve) | +$2–10/mese |
| Hyperliquid fees crescono (più trade/mese) | +$5–30/mese (variabile) |
| **Totale Δ mensile** | **~$15–50/mese** |

**Totale live a 1h**: $55–100/mese. **A 30m**: $80–150/mese.

### 13.4 Aspettative realistiche per timeframe

Per uguale capitale ($1.000–3.000) e disciplina:

| Timeframe | Sharpe netto fees expected | Probabilità profittabilità 12m | Stress operativo |
|-----------|----------------------------|--------------------------------|-------------------|
| **4h** | 0.8–1.5 | ~35% | 🟢 Basso |
| **1h** | 0.7–1.2 | ~25% | 🟡 Medio |
| **30m** | 0.4–0.9 | ~15% | 🔴 Alto |
| **< 15m** | sotto 0.5 (mediamente perdita) | < 5% | 🔴 Estremo |

**Conclusione operativa**: scendere da 4h a 1h **riduce** la probabilità di successo ma aumenta la frequenza dei trade (più dati di apprendimento, più engagement). Va fatto **solo** se l'MVP a 4h ha funzionato e vuoi raffinare la skill.

### 13.5 Cosa NON fare in questa estensione

- ❌ **Non saltare l'MVP a 4h** per partire direttamente a 1h. Sbagli sia il modello sia l'execution, e non sai quale dei due è la causa.
- ❌ **Non eseguire entrambi i bot (4h + 1h) sullo stesso capitale.** Sono strategie correlate, raddoppi l'esposizione direzionale. Se proprio vuoi entrambi, **separa il capitale** (es. $500 per 4h, $500 per 1h).
- ❌ **Non scendere sotto i 30m** sperando che "Chronos-2 sia abbastanza buono". I costi strutturali della trading retail vincono sempre sull'edge del modello sotto i 30m.
- ❌ **Non usare market order a 30m**. Maker-only è obbligatorio, anche se significa saltare trade.
- ❌ **Non aggiungere altri simboli (ETH, SOL) prima dei 30 giorni di paper a 1h.** Una variabile alla volta.

### 13.6 Quando questa estensione vale la pena

✅ MVP a 4h ha girato live ≥ 90 giorni con Sharpe > 0.7.
✅ Hai accumulato esperienza operativa, sai cosa monitorare.
✅ Vuoi più trade come "campioni di apprendimento" del comportamento del modello.
✅ Hai tempo per gestire 2 bot e log analysis più frequenti.

❌ Stai cercando "più PnL" abbassando il timeframe — **non funziona così**.
❌ L'MVP 4h ha avuto Sharpe < 0.7 — non recupererai abbassando il timeframe, peggiorerai.

---

## Appendice A — Checklist pre-Settimana 0

- [ ] Letto e compreso il paper Chronos-2 (focus sezione covariate).
- [ ] Installato `chronos-forecasting` e `hyperliquid-python-sdk` localmente, fatto run di "hello world" per entrambi.
- [ ] Aperto wallet personale dedicato a questo progetto (non quello principale con tutto il portfolio).
- [ ] Funded testnet wallet HL con tokens di test.
- [ ] Definito budget massimo che si è disposti a perdere (in capitale + infrastruttura). Scriverlo. Non superarlo mai.
- [ ] Creato file `decisions.md` nel repo dove logghi ogni scelta non ovvia con data e razionale.
- [ ] Aperto bot Telegram personale per le notifiche, salvato chat_id.
- [ ] Pianificato calendario realistico: 5–6 settimane = ~150–200h di lavoro. Distribuirle.

---

## Appendice B — Riferimenti tecnici

- **Chronos-2**: paper "Chronos-2: From Univariate to Universal Forecasting" (Amazon Science, 2025). Repo: `amazon-science/chronos-forecasting`.
- **TimesFM 2.0**: technical report Google Research (2025). Repo: `google-research/timesfm`.
- **Hyperliquid docs**: `hyperliquid.gitbook.io/hyperliquid-docs` (sezioni: API, Agent Wallets, Rate Limits, Funding).
- **`hyperliquid-python-sdk`**: repo ufficiale GitHub, esempi in `/examples`.
- **Supabase TimescaleDB**: docs estensione `timescaledb` su Supabase (community).
- **Lightweight Charts**: `tradingview/lightweight-charts` per candele + custom series.
- **CRPS scoring rule**: Gneiting & Raftery 2007 — base matematica per valutare forecast probabilistici.
- **Walk-forward**: Pardo, "The Evaluation and Optimization of Trading Strategies".
- **Position sizing**: Ralph Vince, "The Leverage Space Trading Model".

---

*Fine documento. Prossimo step concreto: **Appendice A checklist** → **Settimana 0 POC**. Nessun codice di produzione prima del go/no-go di fine Settimana 0.*
