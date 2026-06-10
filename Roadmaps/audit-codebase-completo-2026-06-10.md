# Audit Strutturale Completo — Quantum Trade

**Data:** 2026-06-10
**Autore:** Scansione automatizzata (Cascade)
**Scope:** Intero monorepo — `apps/api` (FastAPI/Python), `apps/web` (React/TypeScript/Vite), root, `poc/`
**Obiettivo:** Rilevare falle strutturali, codice orfano, bug, problemi di sicurezza e performance **senza compromettere alcuna funzionalità**.

> ⚠️ **Nota importante:** questo è un documento di sola **diagnosi**. Nessuna modifica al codice è stata applicata. Ogni intervento va pianificato e testato singolarmente, dato che si tratta di un sistema di **trading con ordini reali**.

---

## 1. Executive Summary

Il progetto è un sistema di trading algoritmico BTC-PERP su Hyperliquid (backend Python con Chronos-2 + LightGBM) con una dashboard React. Il codice **funziona ed è type-clean** (1 solo errore TS in tutto il frontend), ma presenta **criticità di sicurezza gravi** legate all'esposizione del control-plane di trading e delle API key, oltre a importanti **debiti strutturali** (file monolitici enormi, zero test, duplicazione di configurazione).

### Quadro di gravità

| # | Area | Problema | Gravità | Urgenza |
|---|------|----------|---------|---------|
| S1 | Sicurezza | API senza alcuna autenticazione (controllo bot/ordini live esposto) | 🔴 Critica | Immediata |
| S2 | Sicurezza | CORS `allow_origins=["*"]` su control-plane di trading | 🔴 Critica | Immediata |
| S3 | Sicurezza | API key (Gemini, FMP) iniettate nel bundle client → esposte pubblicamente | ✅ Risolto | — |
| S4 | Sicurezza | Chiavi reali presenti in `.env.local` (controllare rotazione/leak) | ✅ Risolto¹ | — |
| B1 | Bug funzionale | `create_agent_wallet`: approvazione agent su HL commentata → wallet inutilizzabile | 🟠 Alta | Alta |
| C1 | Concorrenza | Client Supabase sincrono chiamato in funzioni `async` → blocca l'event loop | ✅ Risolto | — |
| Q1 | Qualità | `except Exception: pass` diffusi → errori silenziati | ✅ Risolto | — |
| T1 | Test | Zero test automatizzati sull'intero sistema finanziario | 🟠 Alta | Alta |
| M1 | Manutenibilità | File monolitici enormi (fino a 358 KB) | 🟡 Media | Media |
| M2 | Manutenibilità | Doppia definizione di `BotConfig` → rischio drift configurazione | 🟡 Media | Media |
| TS1 | Bug tipi | `ScrollToTop.tsx`: `React.FC` usato senza import di `React` | 🟡 Media | Bassa |
| D1 | Repo hygiene | Binari (`.pkl`, `.parquet`, `.png`, `.ipynb`) tracciati in git | 🟡 Media | Bassa |
| P1 | Build/Prod | Dipendenze da CDN in `index.html` (Tailwind CDN, ecc.) | 🟡 Media | Media |
| Q2 | Qualità | Nessun linter/formatter, `tsconfig` non `strict` | 🟢 Bassa | Bassa |
| R1 | Ridondanza | Doppio layer di cache report nel frontend | 🟢 Bassa | Bassa |

Legenda gravità: 🔴 Critica · 🟠 Alta · 🟡 Media · 🟢 Bassa

---

## 2. Sicurezza (priorità massima)

### S1 — Nessuna autenticazione sugli endpoint API 🔴 CRITICA

**File:** `apps/api/main.py` (tutti gli endpoint)

Nessun endpoint usa `Depends(...)`, header `Authorization`, token o API key. La verifica su tutto il backend conferma l'assenza totale di un layer di auth. Sono esposti senza protezione, tra gli altri:

- `POST /bot/start`, `POST /bot/stop`, `POST /bot/kill` — avvio/arresto/kill del bot
- `POST /bot/trade/manual`, `POST /bot/position/close` — apertura/chiusura posizioni
- `PUT /bot` — modifica parametri di rischio/leva
- `POST /wallet/agent`, `DELETE /wallet/agent/{id}` — gestione wallet/chiavi
- `DELETE /trades`, `DELETE /trades/{id}` — cancellazione storico
- `POST /retrain` — retrain del modello

**Rischio:** chiunque raggiunga l'host (rete locale, VPS pubblico, tunnel) può **avviare trade reali in modalità live, svuotare le posizioni, o cancellare lo storico**. Per un sistema che muove capitale reale è la falla più grave.

**Raccomandazione:** introdurre autenticazione (API token via header, o reverse-proxy con auth) come dipendenza FastAPI applicata a tutti i router di mutazione. Differenziare endpoint di sola lettura (status) dai comandi (start/kill/trade).

---

### S2 — CORS aperto a tutti 🔴 CRITICA

**File:** `apps/api/main.py:85-91`

```@/Users/fabiowild/Desktop/Quantum Trade/apps/api/main.py:85-91
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)
```

Combinato con S1, qualsiasi sito web visitato dal browser dell'utente può inviare comandi al bot se l'API è raggiungibile. **Raccomandazione:** restringere `allow_origins` all'origine reale del frontend (lista esplicita) e limitare i metodi.

---

### S3 — API key esposte nel bundle client ✅ RISOLTO (2026-06-10)

**Fix applicato:** proxy thin su FastAPI (`POST /ai/gemini`, `GET /macro/fmp`). Le chiavi ora risiedono solo in `apps/api/.env`, caricate via `env_file` Docker Compose. Rimosso il blocco `define` da `vite.config.ts`. Il bundle JS non contiene più alcuna chiave. `@google/genai` SDK rimosso dal frontend.
**Azione manuale pendente:** ruotare entrambe le chiavi (Gemini + FMP) perché erano già esposte nel bundle precedente.

---

### S3 — API key esposte nel bundle client 🔴 CRITICA (storico)

**File:** `vite.config.ts:13-17`, `apps/web/services/geminiService.ts:7`

```@/Users/fabiowild/Desktop/Quantum Trade/vite.config.ts:13-17
      define: {
        'process.env.API_KEY': JSON.stringify(env.GEMINI_API_KEY),
        'process.env.GEMINI_API_KEY': JSON.stringify(env.GEMINI_API_KEY),
        'process.env.FMP_API_KEY': JSON.stringify(env.FMP_API_KEY || '')
      },
```

Le chiavi vengono **inlinate nel JavaScript servito al browser**: qualunque utente può leggerle dai DevTools / dal bundle. Le chiamate a Gemini partono direttamente dal client (`new GoogleGenAI({ apiKey })`).

**Rischio:** furto della chiave Gemini/FMP → consumo di quota a carico dell'utente, possibili costi.
**Raccomandazione:** spostare le chiamate Gemini/FMP **dietro il backend** (proxy server-side) e non esporre mai le chiavi al client.

---

### S4 — Chiavi reali in `.env.local` ✅ RISOLTO¹ (2026-06-10)

**Fix applicato:** le chiavi sono state spostate in `apps/api/.env` (mai nel bundle). `.env.local` può essere svuotato.
**¹ Pendente:** rotazione chiavi Gemini e FMP (erano già esposte nel bundle precedente in produzione).

---

### S4 — Chiavi reali in `.env.local` 🟠 ALTA (storico)

**File:** `.env.local`

Il file contiene quelli che sembrano valori reali di `GEMINI_API_KEY` e `FMP_API_KEY`. ✅ Verificato: `.env`/`.env.local` **non sono tracciati da git** (gitignore corretto). Tuttavia:

- Per via di S3 le chiavi finiscono comunque nel client in produzione.
- Va verificato che non siano mai state committate in passato (storia git) e, se esposte, **ruotate**.

---

### S5 — `pickle.load` su file modello 🟡 MEDIA

**File:** `apps/api/services/trainer.py:937,953,965`, `apps/api/services/calibration.py:125`

Il caricamento dei modelli usa `pickle.load`. È sicuro finché i file `.pkl` provengono solo dal processo di training locale, ma rappresenta un vettore RCE se un file modello viene sostituito da terzi (supply-chain). **Raccomandazione:** documentare la provenienza, validare percorsi, e in prospettiva valutare formati non eseguibili (es. salvataggio nativo LightGBM).

---

## 3. Bug funzionali

### B1 — Agent wallet creato ma mai autorizzato su Hyperliquid 🟠 ALTA

**File:** `apps/api/services/hyperliquid_data.py:209-211`

```@/Users/fabiowild/Desktop/Quantum Trade/apps/api/services/hyperliquid_data.py:209-221
    # Register agent on Hyperliquid
    # exchange = Exchange(acct, endpoint)
    # exchange.approve_agent(agent_address, name)

    db = get_supabase()
    result = db.table("agent_wallets").insert({
        "address": agent_address,
        "encrypted_privkey": encrypted,
        ...
```

La registrazione/approvazione dell'agent sull'exchange è **commentata**. La funzione genera la coppia di chiavi, la cifra e la salva, poi ritorna `status: "created"`, ma **l'agent non è autorizzato a operare su HL**. Il flusso UI (`HubSettings.tsx`) suggerisce all'utente che il wallet è pronto, mentre in realtà non può firmare ordini.

**Rischio:** funzionalità apparentemente disponibile ma non operativa (falso positivo). **Raccomandazione:** o completare l'`approve_agent`, o segnalare chiaramente nello stato/UI che è uno stub.

### B2 — `ScrollToTop.tsx`: errore di tipo `React.FC` senza `React` 🟡 MEDIA

**File:** `apps/web/components/ScrollToTop.tsx:4`

```@/Users/fabiowild/Desktop/Quantum Trade/apps/web/components/ScrollToTop.tsx:1-4
import { useEffect } from 'react';
import { useLocation } from 'react-router-dom';

export const ScrollToTop: React.FC = () => {
```

`npx tsc --noEmit` produce **esattamente 1 errore** in tutto il frontend: `TS2503: Cannot find namespace 'React'`. Vite/esbuild transpila comunque (per-file, senza type-check) quindi a runtime funziona, ma il type-check globale è rotto. **Fix banale:** `import React, { useEffect } from 'react';` oppure tipizzare come `(): null`.

### B3 — Feed dati che ritornano sempre vuoti/zero 🟡 MEDIA

**File:** `apps/api/services/hyperliquid_data.py:145,156`

`get_oi_history` ritorna sempre `DataFrame()` vuoto e `get_recent_liquidations` ritorna sempre zeri. È documentato come "fallback", ma le feature derivate ricevono valori nulli senza segnalazione esplicita a monte → possibile **degradazione silenziosa** della qualità del segnale se il percorso WS non popola i dati. Verificare che il path WebSocket li alimenti sempre in produzione.

---

## 4. Concorrenza e Performance

### C1 — Client Supabase sincrono dentro funzioni `async` ✅ RISOLTO (2026-06-10)

**Fix applicato:** aggiunto helper `run_db(fn)` in `supabase_client.py` che usa `asyncio.to_thread` per eseguire ogni chiamata Supabase nel thread pool senza bloccare l'event loop. Tutte e 22 le chiamate `.execute()` nelle funzioni `async` di `execution.py` e tutti gli endpoint async di `main.py` sono stati wrappati con `await run_db(lambda: ...execute())`. Le 6 chiamate nelle 3 funzioni sync (`_save_paper_position`, `_persist_position_state`, `_persist_reversal_pending`) sono state lasciate invariate (sync caller, nessun loop da bloccare). Verifica sintattica `python3 -m py_compile` su entrambi i file: **zero errori**.

**File:** `apps/api/services/supabase_client.py`, usato ovunque in `main.py` ed `execution.py`

`get_supabase()` crea il client **sincrono** `supabase-py`; le chiamate `db.table(...).execute()` sono bloccanti ma vengono invocate dentro endpoint `async` e dentro il main loop asincrono dell'`ExecutionEngine`. Ogni query **blocca l'event loop**, riducendo la reattività dell'intero server (health, stream SSE, altri endpoint) durante l'I/O DB.

**Raccomandazione (originale):** eseguire le chiamate DB in thread pool (`asyncio.to_thread` / `run_in_executor`) o adottare un client async.

### C2 — `_StubClient` incompleto 🟢 BASSA

**File:** `apps/api/services/supabase_client.py:34-58`

Lo stub per dev locale implementa solo `select/insert/upsert/update/delete/eq/gte/lte/order/limit`. Se il codice usa altri metodi (es. `.neq`, `.in_`, `.single`, `.gt`, `.lt`, `.range`), in modalità stub si genera `AttributeError`. Rischio limitato al dev senza Supabase, ma rende fragile l'avvio locale.

---

## 5. Robustezza ed Error Handling

### Q1 — `except Exception: pass` diffusi ✅ RISOLTO (2026-06-10)

**Fix applicato:** tutti i blocchi `except Exception: pass` silenziosi in `execution.py` e `main.py` sostituiti con `log.warning("...", exc_info=True)`. Il comportamento non-bloccante è mantenuto (nessun re-raise), ma ogni errore ora lascia traccia nel log con stack trace completo. Incluso il caso della liquidation ratio covariate (`main.py:745`) e tutti i blocchi nei circuit breaker, drift check, retrain e persistenza eventi.

**Descrizione originale:** Pattern ripetuto in `execution.py` (es. righe ~72, 821, 1126, 1142, 1154, 1472, 2632, 2703), `main.py` e altri service. Gli errori vengono **silenziati senza log**, mascherando guasti (persistenza stato, scrittura eventi, circuit breaker, retrain). In un sistema di trading questo può nascondere fallimenti critici (es. mancato salvataggio dello stato posizione).

**Raccomandazione (originale):** sostituire i `pass` silenziosi con almeno `log.warning(..., exc_info=True)`; mantenere il comportamento non-bloccante dove voluto, ma rendere visibile l'errore.

---

## 6. Manutenibilità e Struttura

### M1 — File monolitici giganteschi 🟡 MEDIA

| File | Dimensione | Note |
|------|-----------|------|
| `apps/web/components/trading-hub/BotConfig.tsx` | **358 KB** | componente singolo |
| `apps/web/components/trading-hub/BacktestPanel.tsx` | **347 KB** | ~4900+ righe |
| `apps/web/components/trading-hub/Monitor.tsx` | **123 KB** | |
| `apps/web/components/trading-hub/TradeLog.tsx` | 51 KB | |
| `apps/web/components/TechnicalPanel.tsx` | 44 KB | |
| `apps/api/services/execution.py` | **242 KB** | core engine |
| `apps/api/services/backtesting.py` | **114 KB** | |
| `apps/api/main.py` | 79 KB | ~1840 righe, tutti i route in un file |
| `apps/api/services/decision.py` | 53 KB | |

**Rischio:** difficoltà di review, alta probabilità di merge-conflict, lentezza degli editor/bundler, accoppiamento elevato. **Raccomandazione (incrementale, a funzionalità invariata):** spezzare per dominio — `main.py` in `routers/` (bot, trades, equity, model, system), e i componenti React in sotto-componenti + hook estratti.

### M2 — Doppia definizione di `BotConfig` 🟡 MEDIA

- `apps/api/main.py:151` — `BotConfig(BaseModel)` Pydantic con validazioni (`ge/le/pattern`).
- `apps/api/services/execution.py:119` — `class BotConfig` plain con `kw.get(...)` e default propri.

Due sorgenti di verità per gli stessi parametri, con default duplicati. **Rischio:** drift silenzioso (un default cambiato in un punto e non nell'altro → comportamento incoerente tra validazione API e runtime engine). **Raccomandazione:** unica fonte (modello Pydantic) condivisa, oppure generare i default da un modulo comune.

### R1 — Doppio layer di cache report frontend 🟢 BASSA

- `apps/web/services/cacheService.ts` — `localStorage`, TTL 60 min.
- `apps/web/App.tsx:44-61` — `sessionStorage`, TTL 30 min.

Due meccanismi sovrapposti con TTL diversi per lo stesso report. Possibile confusione su quale prevalga. **Raccomandazione:** unificare in un singolo servizio cache.

---

## 7. Codice Orfano / Repo Hygiene

### D1 — Binari e artefatti di ricerca tracciati in git 🟡 MEDIA

File tracciati che gonfiano il repository:

- `apps/api/models/lgbm_latest.pkl` (modello binario)
- `poc/*.parquet` (≈ 750 KB di dati storici), `poc/crps_results.png`, `poc/week0_btc_poc.ipynb`
- `backtest_study.py`, `decisions.md` a root, script in `poc/`

**Rischio:** crescita del repo, diff illeggibili sui binari, possibile drift tra modello committato e modello realmente in uso. **Raccomandazione:** spostare dati/modelli fuori dal versionamento (storage/artifact registry o Git LFS) e valutare se `poc/` e `backtest_study.py` siano ancora attivi o archiviabili.

### Orphan/dead-code da verificare
- `dist/` contiene un build statico (gitignored): assicurarsi non venga servito stantio.
- `.claude/` vuoto, `models/` con un solo file.
- Verificare se `backtest_study.py` (root) duplica logica di `apps/api/services/backtesting.py`.

---

## 8. Build, Produzione e Tooling

### P1 — Dipendenze da CDN in `index.html` 🟡 MEDIA

**File:** `index.html:8-10,60-69`

- `https://cdn.tailwindcss.com` — **non adatto alla produzione** (l'avviso ufficiale Tailwind), nessun purge, peso e latenza.
- `lightweight-charts` e `html2canvas` caricati da CDN esterni.
- `importmap` carica React da `aistudiocdn.com` mentre Vite/`package.json` bundlano React: **doppia fonte** di React, rischio di versioni divergenti.

**Rischio:** affidabilità (down della CDN), supply-chain, peso. **Raccomandazione:** installare Tailwind come dipendenza di build e bundlare le librerie; rimuovere l'importmap se si usa il bundling Vite.

### Q2 — Assenza di linter/formatter e `tsconfig` non strict 🟢 BASSA

- Nessun ESLint/Prettier per il frontend, nessun ruff/black/mypy per il backend.
- `tsconfig.json` **non** ha `"strict": true` → molti errori di tipo (null-safety, `any` impliciti) non vengono rilevati. Il codebase usa diffusamente `any` (es. `geminiService.ts`).

**Raccomandazione:** aggiungere ESLint+Prettier e ruff; abilitare gradualmente `strict` nel tsconfig.

### T1 — Zero test automatizzati 🟠 ALTA

Nessun file di test in tutto il progetto (verificato). Per un sistema che esegue ordini reali, l'assenza di test su risk management, sizing, gate di decisione e parsing è un rischio elevato di regressioni non rilevate.

**Raccomandazione:** introdurre `pytest` con test unitari prioritari su: `risk.py` (sizing, daily DD, liquidation price `_calc_liq_px`), `decision.py` (gate/threshold), `calculateRR` e parsing in `geminiService.ts`. Aggiungere uno smoke-test sugli endpoint FastAPI.

---

## 9. Piano d'azione consigliato (per priorità)

### Fase 0 — Mitigazione immediata (sicurezza, oggi)
1. **S1/S2:** aggiungere auth token su tutti gli endpoint di mutazione + restringere CORS all'origine reale.
2. **S3/S4:** ✅ spostare le chiamate Gemini/FMP dietro il backend; ruotare le chiavi se sospette di esposizione.

### Fase 1 — Stabilità (questa settimana)
3. **B1:** completare o segnalare chiaramente lo stub `approve_agent`.
4. **C1:** offload delle chiamate Supabase su thread pool.
5. **Q1:** aggiungere logging agli `except` silenziosi.
6. **B2:** fix import in `ScrollToTop.tsx` (rende verde `tsc`).

### Fase 2 — Qualità e test (2–3 settimane)
7. **T1:** suite `pytest` su risk/decision + smoke API.
8. **M2:** unificare `BotConfig`.
9. **Q2:** ESLint/Prettier/ruff + `strict` graduale.

### Fase 3 — Manutenibilità (continuativa)
10. **M1:** refactor incrementale dei file monolitici (router backend, sotto-componenti React) **a funzionalità invariata**, ognuno con verifica.
11. **D1/P1:** ripulire repo da binari e dipendenze CDN.

---

## 10. Cosa NON è risultato problematico (note positive)

- `.gitignore` copre correttamente `.env`, `.env.local`, `apps/api/.env`, `.venv`, `node_modules`, `dist`, `.claude/settings.json`.
- Type-check frontend quasi pulito (**1 solo errore**, banale).
- Buon uso di `Field(ge/le/pattern)` nel modello Pydantic `BotConfig` (validazione input lato API).
- Pattern difensivi presenti: circuit breaker, reconciliation equity/posizioni allo startup, fallback report AI, `safeFetch*` lato frontend.
- Encryption (Fernet) presente per le private key degli agent wallet.

---

## 11. Metodo e limiti dell'audit

- Analisi statica + ricerche mirate (pattern di errore, auth, secret, default mutabili) ed esecuzione di `tsc --noEmit`.
- **Non** sono stati eseguiti i test runtime/integrazione (assenti) né analizzati riga-per-riga i file >100 KB nella loro interezza: per `execution.py`/`backtesting.py` l'analisi è strutturale e su pattern. Una review approfondita della logica di rischio in `risk.py`/`decision.py` è consigliata come step dedicato.
- Nessuna modifica al codice è stata effettuata.
