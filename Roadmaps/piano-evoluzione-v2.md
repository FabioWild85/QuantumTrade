# Quantum Trade — Piano di Evoluzione v2

> Documento redatto il 12 Maggio 2026
> Scopo: Audit delle fonti dati, proposte di miglioramento e valutazione della piattaforma.

---

## PARTE 1: Audit Fonti Dati Attuali

### 1.1 Dati Tecnici (API Dirette — Hard Data)

| Dato | Fonte | Metodo | Affidabilità | Nota |
|------|-------|--------|-------------|------|
| Prezzi, Candele, Volumi | Binance REST API | `GET /api/v3/klines` | ⭐⭐⭐⭐⭐ | Gratuita, senza limiti stringenti, dati in tempo reale. Nessuna alternativa migliore per i dati crypto. |
| Order Book (Depth) | Binance REST API | `GET /api/v3/depth` | ⭐⭐⭐⭐ | Snapshot statico, non in streaming. Sufficiente per analisi swing. |
| Fear & Greed Index | Alternative.me | `GET /fng/` | ⭐⭐⭐ | Gratuita, ma fonte unica. Nessuna alternativa gratuita equivalente. |
| RSI, MACD, Bollinger, ATR, EMA, SMA | Calcolo locale (`utils/indicators.ts`) | Math puro | ⭐⭐⭐⭐⭐ | Calcolati correttamente in-app partendo dai dati grezzi Binance. Massima affidabilità. |
| Divergenze RSI | Calcolo locale | Algoritmo di confronto swing highs/lows | ⭐⭐⭐ | Funziona ma l'algoritmo è semplificato (lookback fisso a 28 periodi). |
| Cicli BTC (Halving) | Hardcoded | Data `2024-04-20` + formula lineare | ⭐⭐⭐ | Corretto ma statico. Non considera le variazioni di ciclo. |
| ATH (All-Time High) | **Hardcoded** | `73700 / 4800 / 260` | ⭐ | **CRITICO**: i valori ATH sono fissi nel codice e non si aggiornano. Se BTC raggiungesse $120k, il report mostrerebbe ancora -xx% da $73.7k. |

### 1.2 Dati Macro e News (AI Search — Soft Data)

| Dato | Fonte effettiva | Metodo | Affidabilità | Nota |
|------|----------------|--------|-------------|------|
| S&P 500, DXY, Russell 2000, Oil | Google Search Grounding → Yahoo Finance, Investing.com | AI cerca e interpreta | ⭐⭐⭐ | **Dipende dall'AI**. Non c'è garanzia che i prezzi siano quelli degli ultimi 5 minuti. Può restituire dati di chiusura del giorno prima. |
| Unemployment, CPI, GDP | Google Search Grounding → BLS, FRED | AI cerca e interpreta | ⭐⭐⭐⭐ | Dati mensili/trimestrali, quindi il rischio di errore è basso. Cambiano raramente. |
| ETF Net Flows | Google Search Grounding → Farside Investors, SoSoValue | AI cerca e interpreta | ⭐⭐ | **Variabile**. L'AI potrebbe non trovare il dato del giorno corrente o confondere date. |
| BTC Dominance | Google Search Grounding → CoinMarketCap, TradingView | AI cerca e interpreta | ⭐⭐⭐ | Generalmente accurato ma non in tempo reale. |
| News crypto | Google Search Grounding → CoinDesk, CoinTelegraph | AI cerca e interpreta | ⭐⭐⭐ | Le notizie sono reali ma gli URL delle fonti sono spesso `undefined` nel report. |
| Calendario economico | Google Search Grounding → ForexFactory, Investing.com | AI cerca e interpreta | ⭐⭐⭐ | Accurato per gli eventi della settimana corrente, incerto per quelli futuri. |
| ETH Gas/Staking/Burn | Google Search Grounding → Etherscan, Ultrasound.money | AI cerca e interpreta | ⭐⭐ | **Nuovo e non testato**. In precedenza era `Math.random()`. |
| On-Chain (MVRV, NUPL) | **Completamente generati dall'AI** | AI "stima" | ⭐ | **CRITICO**: Non c'è nessuna fonte verificabile. L'AI inventa numeri plausibili basandosi sulla sua conoscenza. |

### 1.3 Verdetto sulle fonti attuali

> **I dati tecnici (Binance) sono eccellenti.** I dati macro (AI Search) sono "abbastanza buoni" per un'analisi generale, ma **non adatti al trading istituzionale** perché non sono in tempo reale e non sono verificabili programmaticamente. I dati On-Chain sono inventati.

---

## PARTE 2: Alternative Più Veloci, Sicure e Gratuite

### 2.1 Fonti che CONSIGLIO di integrare

#### P-01: CoinGecko API (Gratuita) — ATH e Dominance in tempo reale
- **Cosa risolve:** ATH hardcoded ⭐ e Dominance approssimativa
- **Endpoint:** `GET /api/v3/coins/{id}` → campo `ath`, `ath_date`, `market_cap_percentage`
- **Limiti:** 10-30 req/min sul piano free (Demo), più che sufficiente
- **Affidabilità:** ⭐⭐⭐⭐⭐ — È lo standard de facto
- **Necessità:** 🔴 CRITICA — Senza questo, il report mostra dati ATH falsi
- **Rischio:** 🟢 Nessuno — API matura e stabile
- **Sforzo:** ~30 min di implementazione

#### P-02: Yahoo Finance API (via proxy gratuito) — S&P500, DXY, Oil in tempo reale
- **Cosa risolve:** I prezzi macro attualmente dipendono dall'interpretazione AI
- **Endpoint:** `GET /v8/finance/chart/{symbol}` (^GSPC, DX-Y.NYB, CL=F, ^RUT)
- **Limiti:** Richiede un proxy CORS (es. `corsproxy.io`) per il browser
- **Affidabilità:** ⭐⭐⭐⭐ — Dati ritardati di 15min (sufficiente per analisi swing)
- **Necessità:** 🟡 ALTA — Elimina la dipendenza dall'AI per i prezzi macro
- **Rischio:** 🟡 Medio — Yahoo può cambiare l'API senza preavviso; il proxy CORS aggiunge un punto di failure
- **Sforzo:** ~2h di implementazione
- **Alternativa:** FRED API (Federal Reserve Economic Data) per i dati macro USA — completamente gratuita con API key

#### P-03: Etherscan API (Gratuita) — Gas Fees reali per Ethereum
- **Cosa risolve:** Gas Fees attualmente = 0 o inventati dall'AI
- **Endpoint:** `GET /api?module=gastracker&action=gasoracle`
- **Limiti:** 5 req/sec sul piano free (richiede API key gratuita)
- **Affidabilità:** ⭐⭐⭐⭐⭐ — Dato reale on-chain
- **Necessità:** 🟡 ALTA solo per ETH
- **Rischio:** 🟢 Nessuno
- **Sforzo:** ~30 min

#### P-04: Binance Open Interest e Funding Rate — Dati derivati
- **Cosa risolve:** Attualmente `openInterest` e `fundingRate` sono `'N/A'`
- **Endpoint:** `GET /fapi/v1/openInterest`, `GET /fapi/v1/premiumIndex`
- **Limiti:** Richiede l'API futures (gratuita, no auth)
- **Affidabilità:** ⭐⭐⭐⭐⭐ — Dati di prima mano
- **Necessità:** 🟡 ALTA — OI e Funding sono indicatori fondamentali per i derivatives traders
- **Rischio:** 🟢 Nessuno — Stesso provider (Binance) già integrato
- **Sforzo:** ~1h

### 2.2 Fonti che SCONSIGLIO (per ora)

#### ❌ Glassnode / CryptoQuant (On-Chain avanzato)
- **Problema:** MVRV Z-Score, NUPL e Supply Analysis richiedono un piano a pagamento ($39-$799/mese)
- **Alternativa gratuita:** Nessuna affidabile e gratuita per dati on-chain avanzati
- **Consiglio:** Continuare a far "stimare" questi dati dall'AI con un disclaimer chiaro nel report: *"Stime basate su analisi AI — non dati on-chain verificati"*

#### ❌ TradingView Charting Library
- **Problema:** La licenza è commerciale per uso pubblico
- **Consiglio:** L'attuale lightweight-charts di TradingView (open source) è più che sufficiente

---

## PARTE 3: Analisi Aggiuntive per Report Più Professionale

### A-01: Multi-Timeframe Confluence Score (Calcolato localmente)
- **Cos'è:** Un punteggio 0–100 che sintetizza l'allineamento dei segnali su Weekly/Daily/4H
- **Come funziona:** Se tutti e 3 i timeframe sono bullish → 90+. Se c'è conflitto → 40-60.
- **Valore aggiunto:** L'utente vede IMMEDIATAMENTE la forza della tendenza senza leggere tutto il report
- **Necessità:** 🔴 CRITICA — È la feature che differenzia un tool amatoriale da uno professionale
- **Rischio:** 🟢 Nessuno — Calcolo matematico puro
- **Sforzo:** ~2h

### A-02: Risk/Reward Ratio automatico sui Trade Signals
- **Cos'è:** Rapporto tra potenziale guadagno e rischio per ogni segnale
- **Come funziona:** `R:R = (TP - Entry) / (Entry - SL)`. Un R:R < 2:1 è generalmente sconsigliato.
- **Valore aggiunto:** L'utente capisce se il trade "vale la pena" prima di aprirlo
- **Necessità:** 🟡 ALTA
- **Rischio:** 🟢 Nessuno
- **Sforzo:** ~1h (calcolo in fase di merge nel report)

### A-03: Heatmap della Volatilità (ATR relativo)
- **Cos'è:** Confronto dell'ATR attuale con la media storica dell'ATR
- **Come funziona:** `ATR attuale / Media ATR 30gg`. Se > 1.5 = alta volatilità, se < 0.7 = compressione (potenziale esplosione)
- **Valore aggiunto:** Prevede potenziali breakout o periodi di calma
- **Necessità:** 🟡 MEDIA
- **Rischio:** 🟢 Nessuno
- **Sforzo:** ~1h

### A-04: Liquidation Levels (da Binance Futures)
- **Cos'è:** I livelli di prezzo dove le posizioni leveraged vengono liquidate in massa
- **Come funziona:** Si calcolano i cluster di liquidazione dall'OI + Leverage medio
- **Valore aggiunto:** Mostra dove il prezzo è "magnetizzato" — fondamentale per swing traders
- **Necessità:** 🟡 ALTA
- **Rischio:** 🟡 Medio — Richiede logica complessa e dati futures
- **Sforzo:** ~4h

### A-05: Backtesting Storico dei Segnali
- **Cos'è:** Confronto tra i segnali generati in passato e il risultato effettivo
- **Come funziona:** Salva ogni segnale con timestamp, poi confronta con il prezzo dopo N giorni
- **Valore aggiunto:** 🏆 **Game-changer.** Mostra all'utente il track record del tool.
- **Necessità:** 🟡 MEDIA (richiede storage persistente)
- **Rischio:** 🟡 Medio — Se il win rate è basso, danneggia la credibilità. Ma è onesto.
- **Sforzo:** ~8h (richiede database o localStorage evoluto)

### A-06: Portfolio Risk Simulator
- **Cos'è:** Calcolatrice che mostra: "Se investi X con leva Y, quanto puoi perdere/guadagnare?"
- **Come funziona:** Usa i dati del segnale (Entry, SL, TP) per simulare scenari
- **Valore aggiunto:** Educativo e molto utile per i meno esperti
- **Necessità:** 🟢 BASSA (nice-to-have)
- **Rischio:** 🟢 Nessuno
- **Sforzo:** ~3h

### A-07: Correlazione Crypto-Macro Dashboard
- **Cos'è:** Pannello visivo che mostra la correlazione tra BTC e SPX/DXY/Gold negli ultimi 30gg
- **Come funziona:** Coefficiente di correlazione di Pearson calcolato sui daily closes
- **Valore aggiunto:** Mostra se "BTC sta seguendo i mercati tradizionali" o si sta decorrelando
- **Necessità:** 🟡 MEDIA
- **Rischio:** 🟢 Nessuno (se i dati SPX arrivano da API diretta e non da AI)
- **Sforzo:** ~3h

---

## PARTE 4: Prioritizzazione — Piano d'Azione Consigliato

### 🔴 Fase 1 — Fix Critici (da fare subito)
| # | Azione | Tipo | Sforzo |
|---|--------|------|--------|
| P-01 | CoinGecko → ATH e Dominance reali | API Integration | 30 min |
| P-04 | Binance Futures → Open Interest e Funding Rate | API Integration | 1h |
| A-01 | Multi-Timeframe Confluence Score | Feature | 2h |
| A-02 | Risk/Reward Ratio sui segnali | Feature | 1h |
| FIX | Disclaimer su dati On-Chain stimati dall'AI | UI | 15 min |

### 🟡 Fase 2 — Miglioramenti Importanti (settimana successiva)
| # | Azione | Tipo | Sforzo |
|---|--------|------|--------|
| P-02 | Yahoo Finance/FRED → Prezzi macro in tempo reale | API Integration | 2h |
| P-03 | Etherscan → Gas Fees reali per ETH | API Integration | 30 min |
| A-03 | Heatmap Volatilità (ATR relativo) | Feature | 1h |
| A-04 | Liquidation Levels | Feature | 4h |
| A-07 | Correlazione Crypto-Macro | Feature | 3h |

### 🟢 Fase 3 — Differenziazione (futuro)
| # | Azione | Tipo | Sforzo |
|---|--------|------|--------|
| A-05 | Backtesting storico segnali | Feature | 8h |
| A-06 | Portfolio Risk Simulator | Feature | 3h |
| — | Migrazione Tailwind da CDN a npm | Infra | 2h |
| — | WebSocket Binance per prezzi in streaming | Infra | 4h |

---

## PARTE 5: Giudizio sulla Piattaforma — Stato Attuale

### Punti di Forza
1. **Architettura intelligente** — La separazione tra dati "hard" (Binance/calcolo locale) e dati "soft" (AI) è una scelta architetturale solida. I dati che contano davvero per il trading (RSI, MACD, supporti/resistenze, ATR) sono calcolati matematicamente e non dipendono dall'AI.
2. **UI premium** — L'interfaccia è esteticamente curata (dark mode, glassmorphism, animazioni). Dà un'impressione di professionalità.
3. **Resilienza** — Il sistema di fallback a 3 livelli (Pro → Flash → Fallback report con soli dati tecnici) garantisce che l'utente non resti mai senza analisi.
4. **Caching intelligente** — La cache da 60 minuti è un ottimo compromesso tra freschezza dei dati e risparmio di quota API.

### Punti di Debolezza
1. **ATH e On-Chain sono finti** — Questo è il problema più grave. Un utente esperto se ne accorgerebbe e perderebbe fiducia nell'intero tool. L'ATH hardcoded è un bug critico.
2. **Dipendenza totale dall'AI per i dati macro** — Se Gemini ha un'allucinazione sui prezzi di SPX o DXY, il report intero è inquinato. Non c'è nessuna validazione incrociata.
3. **Nessun Open Interest / Funding Rate** — Questi sono indicatori FONDAMENTALI per chi opera sui futures. La loro assenza rende il tool incompleto per un pubblico professionale.
4. **Nessuna metrica di performance** — L'utente non ha modo di sapere se i segnali generati in passato erano accurati. Senza track record, il tool è una "black box".
5. **Tailwind via CDN** — L'avviso in console non è solo un fastidio: in produzione rallenta il caricamento e può causare FOUC (Flash of Unstyled Content).

### Valutazione Complessiva

| Criterio | Voto | Commento |
|----------|------|----------|
| **Design/UX** | 8.5/10 | Eccellente. Premium feel, buone animazioni. |
| **Accuratezza Dati Tecnici** | 8/10 | RSI, MACD, BB, ATR sono corretti. ATH è il punto debole. |
| **Accuratezza Dati Macro** | 5/10 | Dipende dall'AI. Funziona "di solito", ma non è verificabile. |
| **Accuratezza On-Chain** | 2/10 | Essenzialmente inventati. Serve un disclaimer o una vera integrazione. |
| **Velocità** | 7/10 | L'architettura a 2 fasi è una buona idea. Ma il Free Tier di Gemini limita. |
| **Affidabilità Operativa** | 6/10 | Troppi punti di failure nella catena AI. Il fallback salva la situazione. |
| **Completezza per un Trader** | 6/10 | Mancano OI, Funding, Liquidation Levels e R:R — tutte cose che un trader swing si aspetta. |
| **Sicurezza** | 7/10 | La chiave API è gestita correttamente via env. La vecchia leak è stata risolta. |

### Verdetto Finale

> **Quantum Trade è un ottimo MVP con una base architetturale solida.** L'idea di combinare dati tecnici reali con analisi AI è potente e differenziante. Tuttavia, **non è ancora pronto per un uso professionale serio** a causa dei dati inventati (ATH, On-Chain) e della mancanza di indicatori derivati (OI, Funding).
>
> Con l'implementazione della **Fase 1** (circa 4h di lavoro), il tool farebbe un salto di qualità significativo e potrebbe essere considerato uno strumento affidabile per analisi swing. La **Fase 2** lo renderebbe competitivo con tool a pagamento come Coinalyze o TradingView Premium.
>
> **Raccomandazione:** Implementare immediatamente P-01 (CoinGecko ATH) e A-01 (Confluence Score). Queste due aggiunte da sole trasformerebbero la percezione del tool da "esperimento interessante" a "strumento utile".
