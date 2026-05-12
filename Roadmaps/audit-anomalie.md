# 🔍 Quantum Trade — Audit Completo Anomalie
> Audit eseguito il: 09/05/2026  
> File analizzati: 17 | Servizi: 3 | Componenti: 11 | Utility: 2

---

## 🔴 CRITICAL — Blocchi che impediscono il funzionamento corretto

---

### [C-01] API Key Gemini è un placeholder — L'AI non funziona
**File:** `.env.local` → riga 1

```
GEMINI_API_KEY=PLACEHOLDER_API_KEY
```

**Problema:**  
La chiave API è un valore placeholder (`PLACEHOLDER_API_KEY`). Tutte le chiamate all'API Gemini falliranno con un errore di autenticazione (401/403). Il sistema entrerà nel blocco `catch` di `geminiService.ts` e, dopo 3 tentativi, restituirà un `getFallbackReport` con tutti i dati macro impostati a `"N/A"`. L'app è sostanzialmente inutilizzabile per la sua funzione principale senza una chiave valida.

**Fix:**  
Ottenere una API Key reale da [https://aistudio.google.com/](https://aistudio.google.com/) e inserirla nel file `.env.local`:
```
GEMINI_API_KEY=AIza...tuaChiaveReale
```

---

### [C-02] File `index.css` referenziato ma inesistente — 404
**File:** `index.html` → riga 117

```html
<link rel="stylesheet" href="/index.css">
```

**Problema:**  
Il file `index.css` non esiste nel progetto. Nessun file `.css` è presente nella directory. Questo genera un errore HTTP 404 silenziato dal browser. Al momento non provoca crash visibili perché tutto lo styling è gestito da Tailwind CDN + stili inline, ma è un riferimento rotto che potrebbe causare problemi in build di produzione e nei tool di analisi.

**Fix opzione A (Rimuovere):**  
Eliminare il tag `<link>` se il file non è necessario.

**Fix opzione B (Creare):**  
Creare un file `index.css` con eventuali reset/global styles:
```css
/* index.css */
*, *::before, *::after {
  box-sizing: border-box;
}
body {
  margin: 0;
  font-family: 'Inter', sans-serif;
}
```

---

### [C-03] Non-null assertions su dati opzionali — Potenziale Runtime Crash
**File:** `services/geminiService.ts` → righe 202-209

```typescript
cycles: {
    ...realData.cycles!,       // ⚠️ CRASH se cycles è undefined
    historicalSeasonality: aiTechnical.cycles?.historicalSeasonality || "Data unavailable"
},
shortTerm: {
    ...realData.shortTerm!,    // ⚠️ CRASH se shortTerm è undefined
    priceAction: aiTechnical.shortTerm?.priceAction || "Analyzing..."
},
```

**Problema:**  
Se `cryptoDataService.getTechnicalData()` fallisce, il suo blocco `catch` (righe 309-317) restituisce un oggetto parziale che **non include** `cycles` né `shortTerm`. Di conseguenza, il spread su `realData.cycles!` e `realData.shortTerm!` con il non-null assertion operator (`!`) causerà un `TypeError: Cannot spread non-object` a runtime. Questo porta l'intera analisi al crash senza mostrare il fallback.

**Fix:**  
```typescript
cycles: realData.cycles ? {
    ...realData.cycles,
    historicalSeasonality: aiTechnical.cycles?.historicalSeasonality || "Data unavailable"
} : { daysSinceHalving: 0, progressInCycle: 0, distanceFromAth: 0, historicalSeasonality: "Data unavailable" },

shortTerm: realData.shortTerm ? {
    ...realData.shortTerm,
    priceAction: aiTechnical.shortTerm?.priceAction || "Analyzing price action..."
} : undefined,
```

Inoltre, aggiornare il blocco catch di `cryptoDataService.ts` per includere i valori default mancanti:
```typescript
} catch (error) {
    return {
        price: 0,
        priceHistory: [],
        fearGreedIndex: 50,
        volatility: { atr: 0, bollingerBands: { upper: 0, lower: 0, middle: 0, bandwidth: 0, percentB: 0, squeeze: false }},
        cycles: { daysSinceHalving: 0, progressInCycle: 0, distanceFromAth: 0, historicalSeasonality: "N/A" },
        shortTerm: undefined
    };
}
```

---

### [C-04] Nome modello Gemini potenzialmente non valido o non disponibile
**File:** `services/geminiService.ts` → riga 87

```typescript
const model = 'gemini-3-pro-preview';
```

**Problema:**  
Il modello `gemini-3-pro-preview` è un identificativo non verificato. L'SDK `@google/genai` richiede nomi di modelli esatti come `gemini-2.0-flash`, `gemini-1.5-pro`, ecc. Se il modello non esiste, l'API risponde con un errore 404 per tutti e 3 i tentativi, portando al fallback dopo ~10 secondi di attesa inutile (2s + 4s + 4s di delay esponenziale).

**Fix:**  
Usare un modello verificato e disponibile:
```typescript
const model = 'gemini-2.0-flash'; // veloce e con Web Search
// oppure
const model = 'gemini-1.5-pro';   // più capace, più lento
```

Verificare i modelli disponibili su: [https://ai.google.dev/models](https://ai.google.dev/models)

---

## 🟠 HIGH — Dati Errati / Fuorvianti per il Trading

---

### [H-01] Dati Ethereum Ecosystem COMPLETAMENTE FINTI (Math.random)
**File:** `services/cryptoDataService.ts` → righe 219-224

```typescript
if (symbol === 'ETH') {
    ethSpecificData = {
        gasFees: Math.floor(Math.random() * (40 - 10 + 1) + 10),
        stakingApy: parseFloat((Math.random() * (4.5 - 3.0) + 3.0).toFixed(2)),
        ethBurned24h: parseFloat((Math.random() * (2500 - 1500) + 1500).toFixed(0)),
    };
}
```

**Problema:**  
La card "Ecosystem Health" di Ethereum mostra Gas Fees, Staking APY ed ETH Burned come **numeri casuali** generati a runtime. Ogni refresh mostrerà valori diversi. Un utente che usa questi dati per decisioni di trading riceverà informazioni false presentate con un'interfaccia professionale.

**Fix — Integrare API reali:**
```typescript
// Gas Fees: Etherscan Gas Oracle (gratuito con API key)
const gasRes = await fetch(`https://api.etherscan.io/api?module=gastracker&action=gasoracle&apikey=${GAS_API_KEY}`);

// ETH Staked APY: Lido API (pubblica, no key)
const lidoRes = await fetch('https://eth-api.lido.fi/v1/protocol/steth/apr/sma');

// ETH Burned: ultrasound.money API o Etherscan
const burnRes = await fetch('https://api.etherscan.io/api?module=stats&action=ethsupply&apikey=${GAS_API_KEY}');
```

---

### [H-02] ATH (All-Time High) Hardcoded e Obsoleti
**File:** `services/cryptoDataService.ts` → righe 232-234

```typescript
let ath = 73700;   // BTC — OBSOLETO (BTC ha superato $100k nel 2024)
if (symbol === 'ETH') ath = 4800;   // ETH — valore approssimativo
if (symbol === 'SOL') ath = 260;    // SOL — OBSOLETO (SOL ha raggiunto ~$295 nel 2025)
```

**Problema:**  
Il calcolo `distanceFromAth` (riga 236) mostra percentuali errate. Con BTC a $95,000 e ATH impostato a $73,700, il calcolo mostrerebbe `+28.9%` sopra l'ATH precedente — un dato completamente privo di senso per l'analisi dei cicli.

**Fix — Recuperare ATH da API:**
```typescript
// CoinGecko API (gratuita, no key per uso base)
const cgData = await safeFetchObject(
    `https://api.coingecko.com/api/v3/coins/${symbol.toLowerCase()}?localization=false&tickers=false&market_data=true&community_data=false`
);
const ath = cgData?.market_data?.ath?.usd || fallbackAth;
```

---

### [H-03] Scoring del Market Synthesis introduce Bias Bearish quando non ci sono segnali
**File:** `components/MarketSynthesis.tsx` → righe 28-30

```typescript
const signalDirection = report.signals[0]?.type === 'LONG' ? 1 : -1;
score += (avgConfidence > 70 ? 5 : 0) * signalDirection;
```

**Problema:**  
Quando `report.signals` è un array vuoto (es. nel caso di fallback o AI che non genera segnali), l'operatore optional chaining restituisce `undefined`, che viene trattato come `!== 'LONG'`, quindi `signalDirection = -1`. Questo abbassa artificialmente il Confidence Score di 5 punti senza una vera ragione bearish.

**Fix:**
```typescript
const signalDirection = report.signals.length === 0 
    ? 0  // Neutrale se non ci sono segnali
    : (report.signals[0]?.type === 'LONG' ? 1 : -1);
```

---

### [H-04] BTC Dominance non viene mai calcolata da dati reali
**File:** `services/cryptoDataService.ts` → riga 286 (commento)

```typescript
// Dominance removed here to let AI populate it via Web Search
```

**Problema:**  
La BTC Dominance è uno degli indicatori più importanti per determinare "BTC Season" vs "Altseason". Affidarsi esclusivamente all'AI per questo dato significa che:
1. Con l'API key invalida (problema C-01), la dominance sarà sempre `"N/A"`
2. L'AI potrebbe restituire dati non aggiornati o in formato sbagliato
3. Non c'è nessun fallback a un'API reale

**Fix — Integrare CoinGecko `/global`:**
```typescript
const globalData = await safeFetchObject('https://api.coingecko.com/api/v3/global');
const dominance = globalData?.data?.market_cap_percentage?.btc?.toFixed(1) + '%' || 'N/A';
```

---

## 🟡 MEDIUM — Problemi Strutturali e Architetturali

---

### [M-01] Import Map residuo da Google AI Studio — Dead Code
**File:** `index.html` → righe 107-116

```html
<script type="importmap">
{
  "imports": {
    "react": "https://aistudiocdn.com/react@^19.2.0",
    "@google/genai": "https://aistudiocdn.com/@google/genai@^1.29.1",
    "react-dom/": "https://aistudiocdn.com/react-dom@^19.2.0/",
    "react/": "https://aistudiocdn.com/react@^19.2.0/"
  }
}
</script>
```

**Problema:**  
Questo blocco è un residuo dell'ambiente sandbox di Google AI Studio (che esegue il codice direttamente nel browser senza bundler). In un progetto Vite con `node_modules`, i moduli vengono risolti dal bundler e questo import map è totalmente ignorato — ma potrebbe causare conflitti in browser con supporto nativo degli import maps o in ambienti di build non standard.

**Fix:**  
Rimuovere completamente il blocco `<script type="importmap">...</script>` dall'`index.html`.

---

### [M-02] Tailwind CSS caricato via CDN — Non appropriato per produzione
**File:** `index.html` → riga 8

```html
<script src="https://cdn.tailwindcss.com"></script>
```

**Problema:**  
Il CDN Tailwind:
- Processa e applica le classi CSS **nel browser a runtime** (performance degradata)
- Non supporta tree-shaking/purging (include tutto Tailwind, ~3.5MB non minificato)
- La configurazione è inline nell'HTML (righe 14-57) — difficile da mantenere
- Dipende dalla disponibilità del CDN esterno

**Fix:**  
```bash
npm install -D tailwindcss postcss autoprefixer
npx tailwindcss init -p
```

Poi creare `tailwind.config.js` e un file `index.css` con le direttive `@tailwind`.

---

### [M-03] LightweightCharts e html2canvas caricati via CDN senza gestione errori
**File:** `index.html` → righe 9-10, `components/TechnicalPanel.tsx` → riga 53, `App.tsx` → riga 59

```html
<script src="https://unpkg.com/lightweight-charts@4.2.0/dist/..."></script>
<script src="https://html2canvas.hertzen.com/dist/html2canvas.min.js"></script>
```

```typescript
// TechnicalPanel.tsx:53
if (!(window as any).LightweightCharts) {
    console.error('LightweightCharts library not found');
    return; // Il grafico non viene renderizzato, silenziosamente
}

// App.tsx:59
const canvas = await (window as any).html2canvas(element, {...}); // No null check
```

**Problema:**  
- Se il CDN è lento/offline: il grafico mostra uno spazio vuoto senza feedback all'utente
- `html2canvas` non ha nessun controllo di esistenza — se non carica, `undefined(element)` causa un crash
- Le versioni sono fissate a specifici release CDN, non gestite da npm

**Fix:**  
```bash
npm install lightweight-charts html2canvas
```

Poi importare normalmente:
```typescript
import { createChart } from 'lightweight-charts';
import html2canvas from 'html2canvas';
```

---

### [M-04] Variabile `themeColor` dichiarata ma mai utilizzata
**File:** `components/TradeSignals.tsx` → riga 22

```typescript
const themeColor = isLong ? 'emerald' : 'rose'; // ← Mai usata nel JSX
```

**Problema:**  
Il componente usa classi Tailwind condizionali inline (`isLong ? 'bg-emerald-500' : 'bg-rose-500'`) invece della variabile `themeColor`. La variabile è dichiarata ma non referenziata, generando dead code.

**Fix:**  
Rimuovere la riga o consolidare la logica usando la variabile:
```typescript
const tc = isLong ? 'emerald' : 'rose';
// poi usare: className={`bg-${tc}-500`} — attenzione: Tailwind richiede classi complete
```

---

### [M-05] Mismatch nella stringa di loading — Branch di progress mai raggiunto
**File:** `components/LoadingScreen.tsx` → riga 35 vs `App.tsx` → riga 35

```typescript
// LoadingScreen.tsx — Check per "Collegamento"
if (step.includes('Collegamento')) {
    increment = (remaining / 15) + (Math.random() * 0.5); // Progress veloce
}

// App.tsx — Ma lo step è "Connessione"
setLoadingStep(`Connessione ai nodi Binance per ${symbol}...`);
```

**Problema:**  
Il branch "veloce" della progress bar (pensato per la fase iniziale di connessione ai nodi Binance) non viene mai eseguito perché il testo contiene `"Connessione"` e non `"Collegamento"`. La barra usa sempre il branch lento (`remaining / 80`), rendendo l'animazione meno reattiva nella fase iniziale.

**Fix:**  
Allineare le stringhe in uno dei due file:
```typescript
// LoadingScreen.tsx
if (step.includes('Connessione')) { // ← Corretto
```

---

### [M-06] URL delle news non richiesto esplicitamente nel prompt AI — Link rotti
**File:** `services/geminiService.ts` → riga 117 (prompt) vs `components/NewsSection.tsx` → riga 68

```typescript
// Nel prompt, la struttura richiesta è:
"latestNews": [ { "title": "...", "source": "...", "sentiment": "...", "time": "..." } ]
// Il campo "url" NON è incluso nella struttura richiesta!

// Ma NewsSection.tsx renderizza:
<a href={item.url} target="_blank" rel="noopener noreferrer">
```

**Problema:**  
Il campo `url` è richiesto dal tipo `NewsItem` in `types.ts` (riga 26) e usato come link cliccabile nel componente, ma non viene esplicitamente richiesto nel prompt JSON inviato all'AI. Se l'AI non lo include nella risposta, i link puntano a `undefined` e si aprono come `http://localhost:3005/undefined`.

**Fix — Aggiornare il prompt:**
```typescript
"latestNews": [ { 
  "title": "Headline", 
  "source": "CoinTelegraph/CoinDesk", 
  "url": "https://url-articolo.com",  // ← Aggiungere esplicitamente
  "sentiment": "Positive/Negative/Neutral", 
  "time": "2h ago" 
} ]
```

---

## 🔵 LOW — Miglioramenti Consigliati

---

### [L-01] RSI Divergence detection è eccessivamente semplificata
**File:** `services/cryptoDataService.ts` → righe 4-30

**Problema:**  
L'algoritmo rileva la divergenza dividendo semplicemente il lookback a metà e confrontando il minimo/massimo delle due metà. Un rilevamento professionale richiede l'identificazione di pivot point reali (swing highs/lows) con algoritmi come ZigZag o peak detection. L'approccio attuale può generare falsi positivi.

**Miglioramento suggerito:**  
Implementare peak detection con soglia di prominenza:
```typescript
const findSwingLows = (prices: number[], window: number = 5) => {
    return prices.map((p, i) => {
        if (i < window || i > prices.length - window) return null;
        const slice = prices.slice(i - window, i + window + 1);
        return p === Math.min(...slice) ? { index: i, price: p } : null;
    }).filter(Boolean);
};
```

---

### [L-02] Tipo `Candle.time` generico con cast `as any` — Type Safety bypassata
**File:** `services/cryptoDataService.ts` → riga 80

```typescript
time: (d[0] / 1000) as any, // Binance timestamp in ms → secondi
```

**Problema:**  
Il tipo `Candle` in `types.ts` definisce `time: string | number` ma Lightweight Charts richiede specificamente `UTCTimestamp` (un branded type). Il cast `as any` bypassa il type checking e potrebbe causare errori di rendering se la libreria aggiorna i suoi tipi.

**Fix:**  
Aggiornare il tipo `Candle`:
```typescript
// types.ts
import { UTCTimestamp } from 'lightweight-charts';
export interface Candle {
  time: UTCTimestamp;
  open: number;
  high: number;
  low: number;
  close: number;
}
```

---

### [L-03] Cache di 60 minuti eccessiva per un'app di analisi in tempo reale
**File:** `services/cacheService.ts` → riga 5

```typescript
const CACHE_DURATION_MS = 60 * 60 * 1000; // 60 Minuti
```

**Problema:**  
Per un tool di analisi del trading, 60 minuti significa che l'utente potrebbe operare su dati vecchi di un'ora. In un mercato volatile, RSI, Order Book e struttura di trend possono cambiare significativamente in questo lasso di tempo.

**Suggerimento:**  
Differenziare la cache per tipo di dato:
```typescript
const CACHE_TECHNICAL_MS = 15 * 60 * 1000;  // 15 min per dati tecnici
const CACHE_AI_MS = 60 * 60 * 1000;          // 60 min per analisi macro AI (costosa)
```

---

### [L-04] API Key Gemini esposta nel bundle JavaScript client-side
**File:** `vite.config.ts` → righe 13-15

```typescript
define: {
    'process.env.API_KEY': JSON.stringify(env.GEMINI_API_KEY),
    'process.env.GEMINI_API_KEY': JSON.stringify(env.GEMINI_API_KEY)
},
```

**Problema:**  
La chiave API viene iniettata come stringa letterale nel bundle JavaScript del client. Chiunque apra i DevTools del browser e cerchi `AIza` nel sorgente JS può trovare e riutilizzare la chiave. Questo può portare a costi inaspettati o utilizzo non autorizzato della quota API.

**Soluzione ideale per produzione:**  
Creare un backend API route (es. Vercel Serverless Function) che funga da proxy:
```
Browser → POST /api/analyze → [Server con API key sicura] → Gemini API
```

**Soluzione minima:**  
Impostare restrizioni di dominio sulla API key nel Google Cloud Console per limitare l'uso ai soli domini autorizzati.

---

## 📊 Tabella Riepilogativa

| ID | Gravità | File | Descrizione | Status |
|----|---------|------|-------------|--------|
| C-01 | 🔴 CRITICAL | `.env.local` | API key placeholder — AI completamente non funzionante | ❌ Da fixare |
| C-02 | 🔴 CRITICAL | `index.html` | File `index.css` referenziato ma inesistente (404) | ❌ Da fixare |
| C-03 | 🔴 CRITICAL | `geminiService.ts` | Non-null assertions su oggetti opzionali — crash potenziale | ❌ Da fixare |
| C-04 | 🔴 CRITICAL | `geminiService.ts` | Nome modello Gemini non verificato | ❌ Verificare |
| H-01 | 🟠 HIGH | `cryptoDataService.ts` | Dati ETH (Gas/Staking/Burn) completamente finti con Math.random | ❌ Da fixare |
| H-02 | 🟠 HIGH | `cryptoDataService.ts` | ATH hardcoded e obsoleti — metriche di ciclo errate | ❌ Da fixare |
| H-03 | 🟠 HIGH | `MarketSynthesis.tsx` | Bias bearish nel scoring quando signals[] è vuoto | ❌ Da fixare |
| H-04 | 🟠 HIGH | `cryptoDataService.ts` | BTC Dominance affidata solo all'AI, nessun fallback reale | ⚠️ Migliorare |
| M-01 | 🟡 MEDIUM | `index.html` | Import map residuo da AI Studio — dead code | 🔧 Pulire |
| M-02 | 🟡 MEDIUM | `index.html` | Tailwind via CDN — non appropriato per produzione | 🔧 Migrare |
| M-03 | 🟡 MEDIUM | `index.html`, vari | LightweightCharts + html2canvas via CDN senza error handling | 🔧 Migrare |
| M-04 | 🟡 MEDIUM | `TradeSignals.tsx` | Variabile `themeColor` dichiarata ma mai usata | 🔧 Pulire |
| M-05 | 🟡 MEDIUM | `LoadingScreen.tsx` | Stringa "Collegamento" vs "Connessione" — branch mai eseguito | 🔧 Allineare |
| M-06 | 🟡 MEDIUM | `geminiService.ts` | Campo `url` nelle news non richiesto nel prompt — link rotti | 🔧 Da fixare |
| L-01 | 🔵 LOW | `cryptoDataService.ts` | RSI Divergence detection troppo semplificata | 💡 Migliorare |
| L-02 | 🔵 LOW | `cryptoDataService.ts` | Cast `as any` su `Candle.time` bypassa type safety | 💡 Migliorare |
| L-03 | 🔵 LOW | `cacheService.ts` | Cache 60 min troppo lunga per trading in tempo reale | 💡 Ottimizzare |
| L-04 | 🔵 LOW | `vite.config.ts` | API key esposta nel bundle JS client-side | 💡 Proteggere |

---

## ✅ Cosa Funziona Bene

| Area | Valutazione |
|------|-------------|
| Architettura generale (services/components/utils) | ✅ Separazione pulita e ben strutturata |
| Fallback report quando l'AI non risponde | ✅ Robusto, l'app non crasha |
| Calcolo RSI (Wilder's Smoothing) | ✅ Implementazione corretta |
| Calcolo MACD (EMA 12/26, Signal 9) | ✅ Standard industry |
| Calcolo Bollinger Bands con %B e Bandwidth | ✅ Corretto |
| Calcolo ATR (Average True Range) | ✅ Formula standard |
| Fetch parallelo con Promise.all + safeFetch | ✅ Ottima gestione degli errori |
| Order Book analysis (bid/ask pressure, wall detection) | ✅ Logica corretta |
| Market Phase classification (Markup/Correction/Bear) | ✅ Solida |
| Pattern AI + dati reali (tecnici da Binance, macro da AI) | ✅ Approccio intelligente |
| Dark Mode | ✅ Funziona correttamente |
| Retry logic con exponential backoff (2s/4s/4s) | ✅ Best practice |
| Cache con localStorage + TTL | ✅ Implementazione corretta |
| Responsive layout | ✅ Ben gestito su mobile e desktop |
