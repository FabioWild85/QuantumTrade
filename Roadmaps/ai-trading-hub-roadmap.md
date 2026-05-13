# AI Trading Hub — Piano di implementazione (v3, uso personale)

> Documento aggiornato il 13 Maggio 2026 — v3: integrazione Hyperliquid come fonte dati primaria, SMC algoritmici (FVG, liquidity sweep, market structure), riformulazione obiettivo Chronos-2 (directional/volatility/continuation probability), horizon corretto a 3 step (12h), liquidations e Nasdaq futures come nuove covariate, dead-man's switch, validazione post-cutoff pretrain.
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
1. OHLCV BTC-PERP ultime 512 candele 4h da **Hyperliquid WebSocket** (fonte nativa — non Binance, che introduce disallineamento sistematico sul perp HL).
2. OHLCV multi-timeframe di contesto: candele **1h** (ultime 512) e **1d** (ultime 120) — sempre da HL WebSocket.
3. Covariate da Hyperliquid (fonte primaria per tutto ciò che riguarda BTC-PERP HL):
   - **Open Interest** HL (`metaAndAssetCtxs`) — snapshot ogni 5 min
   - **Funding Rate** HL live (`fundingHistory`) — **non Binance**
   - **Liquidations** HL aggregate (`userFills` filtered + `clearinghouseState`) — covariate critica per cascade events
   - **Volume imbalance** buy/sell (buy_volume − sell_volume ultime 4h da `trades` WS channel)
4. Covariate macro esterne (bassa frequenza, peso ridotto):
   - RSI(14), MACD, ATR(14), BB width — calcolati localmente da OHLCV HL
   - DXY delta giornaliero, **Nasdaq Futures** delta giornaliero (proxy risk-on/off)
   - **BTC Dominance** (CoinGecko — già in Quantum Trade P-01)
   - ETF Net Flows (Farside, giornaliero)
   - Multi-Timeframe Confluence Score (Quantum Trade A-01)
5. **Feature SMC algoritmiche** (calcolate da `services/smc.py`):
   - **Fair Value Gaps (FVG)**: zona di squilibrio prezzo rilevata su pattern 3-candele — feature categoriale (bullish_fvg_present, bearish_fvg_present, distance_to_nearest_fvg_pct)
   - **Liquidity sweep recente**: se nelle ultime 3 candele il prezzo ha preso un swing high/low degli ultimi 20 bar poi chiuso nella direzione opposta — segnale di inversione
   - **Market structure**: BOS (Break of Structure = continuazione) o CHoCH (Change of Character = potenziale inversione) — feature categoriale loggata ad ogni decisione

**Obiettivo del forecast (riformulato):**
Chronos-2 **non predice il prezzo esatto** — produce tre stime probabilistiche composite sull'orizzonte 4h–12h:
1. **Directional probability** `P(price_h+3 > price_now)` — dalla distribuzione p10/p50/p90 dell'output quantile
2. **Volatility expansion probability** `P(realized_range_h+3 > ATR * 1.5)` — se ci sarà un movimento significativo
3. **Continuation probability** `P(move aligns with current trend direction)` — coerenza con regime attuale

**Pipeline di decisione:**

1. **Filtro regime (gating — doppio livello)**:
   - Se `ADX(14) < 20` OR `realized_vol_7d < median_30d * 0.7` → **no-trade** (mercato in compressione).
   - Se **liquidity sweep rilevato nell'ultima candela** → **no-trade** (prezzo in potenziale inversione, aspetta conferma).
2. **Forecast Chronos-2 Base** con covariate, **orizzonte 3 step (12h avanti)** — non 6 step. Orizzonte 24h è troppo incerto e non actionable per decisioni a 4h.
3. **Decisione long**: se `directional_probability > 0.62` **AND** `forecast_p10_h+3 > price` (scenario pessimista positivo) **AND** `Confluence Score > 60` **AND** `nessun bearish_fvg_presente nel 2% sopra entry` (non entrare in una zona di riequilibrio attesa).
4. **Decisione short**: simmetrica con segno invertito.
5. **No-trade altrimenti.**

**Risk management:**
- **Position sizing**: 1.5% del capitale per trade (fixed fraction, non Kelly aggressivo).
- **Stop Loss**: `entry ± 2.0 * ATR(14)`. Doppio livello: SL nel bot + SL nativo HL (protezione da bug nel risk manager).
- **Take Profit**: `entry ± 3.5 * ATR(14)` (R:R ~1.75).
- **Max daily drawdown**: -3% → kill bot, riavvio manuale.
- **Max consecutive losses**: 4 → pausa 24h.
- **Max funding cost**: se funding annualizzato > 30% contro la posizione → exit forzata.
- **Heartbeat check**: ogni 4h il bot scrive `last_heartbeat` su Supabase. Se non aggiornato entro 8h, alert Telegram automatico (dead-man's switch contro blocchi silenziosi).

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
| **Charting** | `lightweight-charts` (TradingView open source) | Candles + fan chart per forecast probabilistico (bande p10/p50/p90) |
| **API Backend** | FastAPI + Pydantic v2 | Single Python service, no microservizi |
| **Execution Engine** | Stesso processo FastAPI con un task `asyncio` background che gestisce il loop trading | Niente process separation per single-bot. Se in futuro servono N bot, si separerà. |
| **Modello AI** | `chronos-forecasting` package, Chronos-2 Base, in-process, CPU | Inference 1–2s, perfetto per 4h tf. Output: quantili p10/p50/p90 → derivati in directional/volatility/continuation probability. |
| **DB + Auth + Realtime** | **Supabase Pro** ($25/mese live, free in MVP) | Postgres + estensione `timescaledb` community + Realtime WS + Auth |
| **Fonte dati primaria** | **Hyperliquid WebSocket + REST** per OHLCV multi-tf, OI, funding, liquidations, volume imbalance | **Non Binance** per i dati BTC-PERP — fonte nativa elimina disallineamento. Binance solo per dati non disponibili su HL. |
| **SMC features** | `services/smc.py` — modulo Python custom | Calcola FVG, liquidity sweeps, market structure (BOS/CHoCH) da OHLCV HL. Features categoriali che entrano come covariate in Chronos-2 e come filtro nel decision layer. |
| **Hyperliquid SDK** | `hyperliquid-python-sdk` ufficiale | Mainnet + testnet con stessa libreria |
| **Wallet** | RainbowKit / Wagmi nel frontend per connect; Agent Wallet HL creato lato server al primo onboarding | Chiave agent salvata cifrata in Supabase Vault o `age`-encrypted con master key in env |
| **Notifiche** | Bot Telegram (gratuito) | Alert fill, errori, kill, daily summary, **heartbeat mancante** |
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
| **P-01** | CoinGecko BTC Dominance | Feature di contesto macro per il modello (directional probability) |
| **P-04** | ~~Binance~~ **Hyperliquid** Open Interest + Funding Rate | **Covariate killer**: OI e funding **da HL** (non Binance) per evitare disallineamento con il perp che si sta tradando |
| **A-01** | Multi-Timeframe Confluence Score | Filtro di gating nella pipeline di decisione |
| **A-03** | Heatmap Volatilità (ATR relativo) | Volatility expansion probability — input al modello |
| **A-04** | Liquidation Levels (display UI) | Utile per visualizzazione nella dashboard — **NON usare come covariate per Chronos-2**: sono stime matematiche (`price × leverage_ratio`), non dati reali. Come feature insegnerebbero al modello un'identità numerica, non un segnale. |
| **NUOVO** | **Liquidations aggregate reali da HL** | Questa sì è la covariate reale: volume aggregato di liquidazioni nelle ultime N ore da HL (`clearinghouseState`). Completamente diverso dalle stime A-04. |
| **NUOVO** | **Nasdaq Futures delta** | Feature macro risk-on/off, correlazione con BTC sui timeframe 4h–1d |

**Sforzo aggiuntivo Quantum Trade**: ~10h (già pianificato in `piano-evoluzione-v2.md`).

### 3.3 Pattern di condivisione dati — architettura corretta

**Il backend Python deve essere indipendente dal browser.** Il bot gira 24/7 su VPS; l'utente potrebbe non aprire Quantum Trade per giorni. Un'architettura dove il backend dipende dalla UI per avere dati freschi è fragile per definizione.

**Regola fondamentale**: il backend Python calcola autonomamente tutto il necessario. I dati di Quantum Trade sono un **input supplementare di qualità superiore** quando disponibili — non un prerequisito.

```
BACKEND PYTHON (fonte primaria, sempre aggiornata):
  ├── OHLCV multi-tf         → Hyperliquid WebSocket/REST
  ├── RSI, ATR, ADX, MACD, BB → calcolati da Python (pandas-ta) su OHLCV HL
  ├── OI, Funding, Liquidations → Hyperliquid Info API
  ├── FVG, sweep, structure  → services/smc.py
  ├── Fear & Greed           → alternative.me API diretta
  └── BTC Dominance          → CoinGecko API diretta

QUANTUM TRADE FRONTEND (input supplementare, quando fresco):
  ├── Confluence Score (0-100)   → scritto su Supabase quando utente apre dashboard
  ├── RSI Divergence             → Bullish/Bearish/None, aggiornata dalla UI
  └── EMA Signal categoriale     → Full Bullish / Golden Cross / ecc.
  
  Il backend li LEGGE da Supabase con questo filtro:
  SELECT value FROM covariates WHERE key='confluence_score'
    AND source='quantum_trade' AND time > NOW() - INTERVAL '4 hours'
  Se non trovati (stale o utente non ha aperto QT): usa i propri calcoli come fallback.
```

**Cosa NON viene dal frontend di QT come covariate:**
- ❌ Liquidation Levels (A-04): sono stime matematiche (`price × 0.980`), non dati reali — non hanno valore informativo per Chronos-2
- ❌ OI e Funding formattati come stringa (`"$8.45B"`, `"+0.0100%"`): già in formato UI, il backend usa i raw float da HL
- ❌ Order book Binance spot: mercato diverso dal perp HL, imbalance non comparabile

**Quali dati QT vale la pena leggere (e perché):**
- ✅ **Confluence Score**: aggrega weekly/daily/4H trend + RSI + divergenza + MACD + order book in un numero già pesato euristically (vedi codice righe 338-365 di `cryptoDataService.ts`). Più ricco di quello che il backend calcolerebbe da zero.
- ✅ **RSI Divergence**: rilevazione bullish/bearish divergence su 28 periodi — calcolo non banale, vale riusare.
- ✅ **EMA Signal**: struttura EMA multi-tf (Full Bullish/Golden Cross/ecc.) come feature categoriale.

**Scansione automatica — come garantire dati freschi:**
In MVP, la UI non ha un auto-refresh background: i dati QT su Supabase sono aggiornati solo quando l'utente apre la dashboard. Sono supplementari, quindi questo è accettabile. In fase 2, se si vuole eliminalre questa dipendenza manuale, si implementa una **Supabase Edge Function** schedulata ogni 4h che chiama le stesse API della UI e scrive i valori nella tabella `covariates`. Costo: ~$0, complessità: bassa.

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

- [ ] Notebook Jupyter: scarica BTC 4h da **Hyperliquid REST** (non Binance) per ultimi 24 mesi via `candleSnapshot`. Verifica che i dati siano completi e senza gap.
- [ ] Identifica il **pretrain cutoff di Chronos-2** (Amazon Science paper §3) e limita l'OOS al periodo *posteriore* a quella data — altrimenti il "test" è in realtà in-sample.
- [ ] Esegui Chronos-2 Base zero-shot con walk-forward rolling su **12 mesi OOS post-cutoff**, orizzonte **3 step (12h)**, non 6.
- [ ] Calcola **CRPS** vs naive baseline (random walk) e vs AR(1).
- [ ] **Criterio go/no-go**: CRPS Chronos-2 < CRPS naive di almeno **5%** su OOS post-cutoff BTC 4h.
- [ ] Se ok, aggiungi covariate: OI HL, funding HL, realized vol, RSI calcolato da pandas — misura il delta CRPS. Se le covariate peggiorano, analizza perché prima di procedere.
- [ ] Test SMC baseline: implementa FVG detection e liquidity sweep detector su pandas, verifica che producano segnali non nulli e distribuiti nel periodo OOS (non tutti concentrati in un mese).
- [ ] Test latenza ciclo completo **sul VPS Hetzner reale** (non localhost): close candela → fetch HL → SMC calc → Chronos-2 inference → decision → order submit. Target: < 3s totali per 4h tf.
- [ ] In parallelo: script Python che usa `hyperliquid-python-sdk` per creare agent wallet su testnet, piazzare un ordine market BTC 0.001, leggere fill via WS.

**Output**: documento `decisions.md` con: risultato CRPS (con e senza covariate), delta CRPS SMC features, latenza ciclo completo su VPS, decisione go/no-go scritta con motivazione.

### 🔴 Settimana 1 — Infra base

- [ ] Repo restructure: `apps/web` (frontend Quantum Trade esistente + nuova tab), `apps/api` (FastAPI + execution engine in-process), `packages/shared-types` (TypeScript types da Pydantic via OpenAPI).
- [ ] Docker Compose locale: FastAPI + Supabase locale (o cloud free).
- [ ] Schema DB iniziale (Alembic migration + Supabase migration files).
- [ ] Connessione wallet RainbowKit nel frontend, mock agent creation.
- [ ] Endpoint `POST /wallet/agent` che crea davvero l'agent su Hyperliquid testnet e lo salva cifrato.
- [ ] Bot Telegram per notifiche (template messaggi: bot started, trade opened, trade closed, error, killed).

### 🔴 Settimana 2 — Execution engine + decision loop

- [ ] Modulo `services/hyperliquid_data.py`: fetch OHLCV BTC multi-timeframe (4h, 1h, 1d) da HL REST + WS. Niente Binance per i dati primari.
- [ ] Modulo `services/covariates.py`: RSI, ATR, MACD, ADX calcolati localmente da OHLCV HL; OI, Funding, Liquidations aggregate da HL Info API; Nasdaq Futures e DXY da fonte esterna (yfinance o simile per queste due voci macro).
- [ ] Modulo `services/smc.py`: **Smart Money Concepts algoritmici**:
  - `detect_fvg(df)` → lista di FVG bullish/bearish attivi con livello e distanza % da prezzo corrente.
  - `detect_liquidity_sweep(df, lookback=20)` → bool + direzione se lo sweep è avvenuto nelle ultime 3 candele.
  - `classify_market_structure(df)` → `"BOS_up"` / `"BOS_down"` / `"CHoCH_up"` / `"CHoCH_down"` / `"ranging"`.
  - Tutto testato unitariamente prima di essere usato in produzione.
- [ ] Modulo `services/chronos.py`: wrapper Chronos-2 Base con interface `forecast(series, covariates, horizon=3) -> {p10, p50, p90, directional_prob, vol_expansion_prob, continuation_prob}`. La derivazione delle tre probabilità composite avviene qui dalla distribuzione quantile output.
- [ ] Modulo `services/decision.py`: implementa gating doppio (ADX + liquidity sweep) + decisione long/short/no-trade con filtro FVG descritto in §1.3.
- [ ] Modulo `services/risk.py`: SL/TP basati su ATR, position sizing, max DD checks. SL doppio: bot + SL nativo HL. Heartbeat writer (aggiorna `last_heartbeat` su Supabase ogni ciclo).
- [ ] Modulo `services/hyperliquid.py`: submit/cancel order, WS subscriptions per fills/positions.
- [ ] Modulo `services/execution.py`: il loop principale (asyncio task) che ogni close 4h: fetch dati → SMC calc → costruisce features → forecast → decide → esegue → logga tutto con `inference_id`.
- [ ] Riconciliazione ogni 60s tra stato DB e stato HL (WS positions).
- [ ] Cron job Telegram: alert se `last_heartbeat` non aggiornato entro 8h (dead-man's switch).

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

## PARTE 8b — Smart Money Concepts (SMC): implementazione algoritmica

> Sezione aggiunta v3. I concetti SMC sono la logica sottostante a strumenti come "SMC Sniper Pro" (TradingView). Non si usa lo strumento closed-source — si implementa la logica in modo trasparente e auditabile in `services/smc.py`.

### Perché SMC è rilevante per questo progetto

Chronos-2 cattura pattern statistici nelle serie temporali ma è cieco alla **microstruttura del mercato**. I concetti SMC riempiono questo gap: identificano dove si trova la liquidità, dove il prezzo tende a "tornare" (FVG), e quando il trend è davvero rotto (CHoCH vs rumore). Usati come **feature categoriali** amplificano il segnale che Chronos-2 riceve.

### Tre concetti implementabili algoritmicamente

**1. Fair Value Gap (FVG)**
```python
# Pattern 3-candele: il gap tra la low della candela i-2 e la high della candela i
# non è coperto dalla candela i-1 (bullish FVG) — zona di squilibrio dove il prezzo tende a tornare
def detect_fvg(df: pd.DataFrame, min_gap_pct: float = 0.001) -> pd.DataFrame:
    bullish = df['low'].shift(-1) > df['high'].shift(1)  # gap up: candle[i-1].low > candle[i+1].high
    bearish = df['high'].shift(-1) < df['low'].shift(1)  # gap down
    gap_size = abs(df['low'].shift(-1) - df['high'].shift(1)) / df['close']
    return df.assign(
        bullish_fvg=bullish & (gap_size > min_gap_pct),
        bearish_fvg=bearish & (gap_size > min_gap_pct),
        distance_to_fvg_pct=...  # distanza % dal prezzo corrente alla zona FVG più vicina
    )
```
**Uso nella decisione**: non entrare long se c'è un bearish FVG entro il 2% sopra l'entry (è una zona di riequilibrio attesa).

**2. Liquidity Sweep**
```python
# Il prezzo prende un swing high/low degli ultimi N bar, poi chiude nella direzione opposta
# = hunt dei retail stop-loss → potenziale inversione
def detect_liquidity_sweep(df: pd.DataFrame, lookback: int = 20) -> pd.Series:
    swing_high = df['high'].rolling(lookback).max().shift(1)
    swing_low = df['low'].rolling(lookback).min().shift(1)
    buyside_sweep = (df['high'] > swing_high) & (df['close'] < swing_high)
    sellside_sweep = (df['low'] < swing_low) & (df['close'] > swing_low)
    return buyside_sweep | sellside_sweep  # True = sweep avvenuto in questa candela
```
**Uso nella decisione**: se sweep nell'ultima candela → **no-trade** (aspetta conferma direzione reale).

**3. Market Structure (BOS / CHoCH)**
```python
# BOS (Break of Structure): il prezzo chiude oltre l'ultimo swing high/low nella direzione del trend
# = continuazione confermata
# CHoCH (Change of Character): il prezzo rompe nella direzione OPPOSTA al trend corrente
# = potenziale inversione, aumenta peso del gating
def classify_market_structure(df: pd.DataFrame, lookback: int = 10) -> str:
    # Implementazione basata su swing highs/lows consecutivi
    # Ritorna: "BOS_up", "BOS_down", "CHoCH_up", "CHoCH_down", "ranging"
    ...
```
**Uso nella decisione**: CHoCH nella direzione opposta alla nostra posizione = trigger di review exit anticipata.

### Cosa NON implementare da SMC

- ❌ **Fibonacci levels come segnale primario**: soggettivi, difficili da backtestare in modo non-overfitted.
- ❌ **Order blocks**: più complessi, sovrapposizione con FVG, aggiungi solo in fase 2 se i dati OOS li supportano.
- ❌ **Qualsiasi logica < 4h timeframe**: SMC a 30m–1h richiede latenza WS < 100ms che non abbiamo in MVP.

---

## PARTE 9 — Rischi reali e mitigazioni

| Rischio | Probabilità | Impatto | Mitigazione |
|---------|-------------|---------|-------------|
| **Chronos-2 non batte baseline su crypto** | Media | 🔴 Alto | POC Settimana 0 obbligatorio. Se fallisce, pivot a XGBoost + features classiche. |
| **Overfitting via data contamination** (BTC nel pretrain di Chronos) | Alta | 🔴 Alto | Walk-forward strict su periodo **post-cutoff pretrain**. Identificare data cutoff da paper Chronos-2 prima del POC. Se accuracy crolla post-cutoff, è un segnale di contaminazione. |
| **SMC features overfit** (FVG/sweep come pattern illusori) | Media | 🟡 Medio | Backtestare ogni SMC feature singolarmente su OOS prima di combinarle. Se una feature peggiora CRPS, escluderla. |
| **Blocco silenzioso del bot** (no crash, no alert, ma niente inference) | Media | 🔴 Alto | Dead-man's switch: heartbeat su Supabase ogni 4h, alert Telegram se mancante entro 8h. |
| **Hyperliquid downtime** | Bassa | 🟡 Medio | Bot in modalità safe (no nuove posizioni, mantieni esistenti, alert) durante outage. Niente fallback automatico ad altri venue in MVP. |
| **Compromissione del VPS** | Bassa | 🟡 Medio | Agent wallet ha solo permessi trading, max danno = chiusura forzata posizioni dall'attaccante. Revoca immediata da wallet principale. |
| **Drawdown catastrofico in live** | Alta (è normale) | 🟡 Medio | Capitale iniziale piccolo, max daily DD 3% hard-coded, kill-switch testato unitariamente. |
| **Bug nel risk manager** che non chiude SL | Media | 🔴 Alto | Test unitari ESTESI sul risk manager prima di andare live. Doppio livello: SL nel bot + SL nativo Hyperliquid. |
| **Latenza ciclo completo > 5s** (fetch + SMC + inference + order) | Bassa | 🟢 Basso | Misurata sul VPS reale in Settimana 0. Se > 3s, ottimizzare fetch asincrono o usare Chronos-2 Small. |
| **Burnout / abbandono progetto** | Media | 🟡 Medio | Scope ridotto al minimo (1 bot, 1 asset, 1 strategy). Niente over-engineering. Se si ferma, riprende facilmente. |

---

## PARTE 10 — Definizioni di successo

Il progetto è **chiuso con successo MVP** se al termine di Settimana 6 sono vere tutte queste:

1. ✅ Il bot ha girato in paper su testnet HL per ≥ 14 giorni consecutivi senza crash non gestiti.
2. ✅ La dashboard Quantum Trade mostra il forecast Chronos-2 (fan chart p10/p50/p90) sovrapposto al prezzo BTC-PERP, aggiornato ad ogni close 4h, con etichette `directional_prob`, `vol_expansion_prob`, `continuation_prob` visibili nel Trade Log.
3. ✅ Ogni trade simulato ha un `inference_id` che permette di vedere: features complete (incl. SMC), forecast quantili, le tre probabilità composite, e il reasoning della decisione.
4. ✅ Il kill-switch funziona in < 1 secondo (testato unitariamente e una volta in vivo).
5. ✅ Il dead-man's switch Telegram è testato: arrestando il bot manualmente per 9h, l'alert arriva.
6. ✅ Il backtesting walk-forward su 12 mesi OOS **post-cutoff pretrain** produce Sharpe netto fees > 0.7.
7. ✅ I costi mensili reali sono entro il budget pianificato ($40–50/mese live).

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
