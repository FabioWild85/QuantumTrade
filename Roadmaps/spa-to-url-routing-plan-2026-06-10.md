# Piano di Implementazione: URL Routing e Navigazione Web-Style
**Data:** 2026-06-10  
**Autore:** QuantAI Engineering  
**Stato:** Pianificazione  
**Priorità:** Media — nessun impatto su funzionalità di trading

---

## 1. Contesto e Motivazione

L'applicazione è attualmente una SPA (Single Page Application) con navigazione gestita tramite `useState`. Questo significa:
- L'URL rimane sempre `/` indipendentemente da dove ci si trova
- Un refresh porta sempre alla home, perdendo il contesto
- Non è possibile condividere un link diretto a una sezione specifica
- La navigazione tra viste non resetta la posizione dello scroll

L'obiettivo è introdurre un sistema di routing basato su URL reali (History API), rendendo l'app navigabile come un sito web professionale senza stravolgere l'architettura esistente.

---

## 2. Analisi dello Stato Attuale

### 2.1 Struttura di Navigazione Esistente

```
App.tsx
├── AppView = 'dashboard' | 'trading-hub'
│
├── dashboard
│   ├── Home (nessun asset selezionato)
│   └── Report (BTC | ETH | SOL — stato in memoria React)
│
└── trading-hub (TradingHubTab.tsx)
    └── HubPage = 'monitor' | 'forecast' | 'config' | 'trades' |
                  'backtest' | 'regime' | 'reversal' | 'logs' |
                  'server' | 'settings'
```

### 2.2 Meccanismo di Navigazione Attuale

| Componente | Meccanismo | Problema |
|---|---|---|
| `App.tsx` | `useState<AppView>` | Nessun URL, refresh = home |
| `TradingHubTab.tsx` | `useState<HubPage>` | Nessun URL, refresh = monitor |
| `Header.tsx` | `onOpenHub()` callback prop | No link diretto |
| `App.tsx` reset | `resetState()` callback | No history.back() |

### 2.3 Stack Tecnologico

- **React 19** + **TypeScript** + **Vite 6**
- **Tailwind CSS** (via CDN in `index.html` — *attenzione: implicazione nota, vedi §3.3*)
- **React Router**: **non installato** — da aggiungere
- **Deployment**: Nginx su VPS Hetzner (IP 77.42.84.8), dist → `/var/www/quantum-trade/dist/`

---

## 3. Variabili Critiche e Rischi

### 3.1 Stato del Report in Memoria (CRITICO)

**Problema:** Il report generato (`MarketReport`) esiste solo nello stato React di `App.tsx`. Navigando su `/analysis/btc` e facendo refresh, lo stato viene perso e il report scompare.

**Soluzione proposta — `sessionStorage` con cache per asset:**
- Al momento della generazione, serializzare il report in `sessionStorage` con chiave `report_cache_BTC` (o ETH/SOL)
- Al mount della route `/analysis/:asset`, controllare se esiste una cache e ripristinarla prima di mostrare l'empty state
- La cache viene invalidata se `forceRefreshMode` è attivo
- `sessionStorage` si svuota alla chiusura del tab — comportamento voluto (dato sensibile)

### 3.2 Dark Mode — Bug Esistente nel Trading Hub (CRITICO)

**Risposta diretta:** Il Trading Hub ha le classi `dark:` scritte su tutti i suoi componenti (sidebar, header mobile, pannelli), ma la dark mode **non funziona attualmente** all'interno del hub. È un bug esistente, non introdotto da questa migrazione.

**Causa:** In `App.tsx`, la classe `dark` viene applicata su un div wrapper solo quando si renderizza il dashboard:
```tsx
// Dashboard — il div 'dark' è presente:
return (
  <div className={isDarkMode ? 'dark' : ''}>  ← dark applicato
    <Header ... />
    ...
  </div>
);

// Trading Hub — early return SENZA il wrapper dark:
if (activeView === 'trading-hub') {
  return (
    <TradingHubTab ... />  ← dark NON applicato, tema sempre light
  );
}
```

Tailwind in modalità `darkMode: 'class'` attiva le varianti `dark:` solo se un antenato nel DOM ha la classe `dark`. Quando si entra nel Hub, quel wrapper sparisce — tutte le `dark:bg-`, `dark:text-` del Hub diventano codice morto.

**Soluzione — spostare la classe `dark` sull'elemento `<html>`:**

Invece di un wrapper div in App.tsx, gestire la classe sull'elemento root del documento:

```ts
useEffect(() => {
  const root = document.documentElement; // elemento <html>
  if (isDarkMode) {
    root.classList.add('dark');
  } else {
    root.classList.remove('dark');
  }
  localStorage.setItem('theme', isDarkMode ? 'dark' : 'light');
}, [isDarkMode]);

// Inizializzazione (legge da localStorage o preferenza OS):
const [isDarkMode, setIsDarkMode] = useState<boolean>(() => {
  const saved = localStorage.getItem('theme');
  if (saved) return saved === 'dark';
  return window.matchMedia('(prefers-color-scheme: dark)').matches;
});
```

Con questa soluzione:
- La classe `dark` è sull'elemento `<html>`, sempre presente indipendentemente dalla route
- Il wrapper div in App.tsx può essere rimosso — non serve più
- Il Trading Hub eredita automaticamente il tema corretto
- La dark mode persiste al refresh via `localStorage`
- Il toggle nel `Header` va rimosso dal Hub (si userà il toggle globale nel Header principale — ma il Header non è visibile nel Hub, vedi §3.2.1)

#### 3.2.1 Toggle Dark Mode accessibile dal Trading Hub

**Problema secondario:** Quando si è nel Trading Hub, il `Header` del dashboard (con il toggle dark/light) non è visibile. Attualmente non c'è nessun modo di cambiare tema dall'interno del Hub.

**Soluzione:** Aggiungere un piccolo pulsante toggle dark/light nel footer della sidebar del Trading Hub, accanto al pulsante collapse. È il posto più naturale — già lì c'è un'area di controlli sidebar.

**Stato precedente:** `isDarkMode` e `toggleTheme` non venivano passati a `TradingHubTab` in alcun modo. Con la nuova architettura globale (`<html>` class), il toggle non richiede props — chiama direttamente la stessa logica via un context o un custom hook `useTheme()`.

**Nota:** Questo bug e la sua soluzione sono completamente indipendenti dalla migrazione al routing. Possono essere risolti anche senza React Router. Tuttavia, la migrazione è il momento ideale per farlo perché riorganizza già App.tsx.

### 3.3 Importmap CDN vs. Vite Bundle

**Osservazione:** `index.html` contiene un `<script type="importmap">` con URL CDN per React. Con Vite attivo, questo importmap **non viene usato** — Vite risolve i moduli da `node_modules` e produce il bundle. L'importmap è un residuo storico e può essere rimosso senza conseguenze (non è obbligatorio farlo ora, ma va documentato).

**React Router** viene installato via npm e bundlato normalmente da Vite — nessun conflitto.

### 3.4 Configurazione Nginx (CRITICO per Deployment)

**Problema:** Con BrowserRouter, ogni URL come `/hub/backtest` viene richiesto al server. Nginx senza configurazione risponde con 404 perché il file fisico non esiste.

**Soluzione:** Aggiungere la direttiva SPA fallback in Nginx:
```nginx
location / {
    try_files $uri $uri/ /index.html;
}
```
Questa modifica è **obbligatoria** prima di fare deploy in produzione dopo l'implementazione.

### 3.5 Scroll to Top

React Router non resetta lo scroll automaticamente tra route. Va implementato un componente `ScrollToTop` che si monta una volta sola nel router e ascolta i cambi di `pathname`.

### 3.6 Sidebar del Trading Hub — Stato Collapsibile

`isCollapsed` e `isMobileOpen` in `TradingHubTab` sono stati UI locali, non legati al routing. Rimangono invariati — nessun impatto.

### 3.7 `forceRefreshMode` — Dev Toggle

È un flag di sviluppo e non deve comparire nell'URL. Rimane in `useState` come ora.

### 3.8 `analyzedAsset` come Parametro URL

Una volta che usiamo `/analysis/:asset`, l'asset analizzato diventa derivabile dall'URL. Questo semplifica il codice: `analyzedAsset` non serve più come stato separato — viene letto da `useParams()`.

---

## 4. Struttura URL Proposta

```
/                          → Dashboard Home (selezione asset)
/analysis/btc              → Report Bitcoin
/analysis/eth              → Report Ethereum
/analysis/sol              → Report Solana
/hub                       → Trading Hub (redirect automatico a /hub/monitor)
/hub/monitor               → Monitor (pagina default hub)
/hub/forecast              → Forecast
/hub/config                → Bot Config
/hub/trades                → Trade Log
/hub/backtest              → Backtest
/hub/regime                → Regime
/hub/reversal              → Reversal
/hub/logs                  → Server Log
/hub/server                → Server Status
/hub/settings              → Settings
```

**Regole:**
- `/analysis/:asset` con asset non valido → redirect a `/`
- `/hub` senza sub-path → redirect a `/hub/monitor`
- Qualsiasi path non riconosciuto → redirect a `/`

---

## 5. Architettura dell'Implementazione

### 5.1 Dipendenza da Installare

```bash
npm install react-router-dom
```

**Versione:** v6 (attuale LTS, API stabile con `createBrowserRouter` o `BrowserRouter`). Si usa `BrowserRouter` per mantenere la semplicità — `createBrowserRouter` non aggiunge benefici in questo contesto.

### 5.2 Struttura dei File da Modificare

```
index.tsx               → wrappare con <BrowserRouter>
App.tsx                 → rimuovere AppView useState, aggiungere <Routes>
                          rimuovere wrapper <div className={isDarkMode?'dark':''}>
                          aggiungere useEffect per dark class su <html>
                          aggiungere inizializzazione isDarkMode da localStorage/OS
                          aggiungere <ScrollToTop />
                          aggiungere cache sessionStorage
components/Header.tsx   → sostituire onOpenHub() con <Link to="/hub">
components/trading-hub/
  TradingHubTab.tsx     → sostituire HubPage useState con useParams()
                          sostituire setPage() con navigate()
                          aggiungere toggle dark/light nella sidebar (footer)
                          rimuovere prop onBackToDashboard (diventa navigate('/'))
```

### 5.3 Componente ScrollToTop

```tsx
// apps/web/components/ScrollToTop.tsx
import { useEffect } from 'react';
import { useLocation } from 'react-router-dom';

export const ScrollToTop: React.FC = () => {
  const { pathname } = useLocation();
  useEffect(() => {
    window.scrollTo(0, 0);
  }, [pathname]);
  return null;
};
```

### 5.4 Schema delle Route in App.tsx

```tsx
<Routes>
  <Route path="/" element={<DashboardHome />} />
  <Route path="/analysis/:asset" element={<AnalysisReport />} />
  <Route path="/hub" element={<Navigate to="/hub/monitor" replace />} />
  <Route path="/hub/:page" element={<TradingHubTab />} />
  <Route path="*" element={<Navigate to="/" replace />} />
</Routes>
```

### 5.5 Cache SessionStorage per i Report

```ts
// Al salvataggio del report (dopo generateMarketAnalysis):
sessionStorage.setItem(`report_cache_${symbol}`, JSON.stringify({
  report: data,
  timestamp: Date.now()
}));

// Al mount di /analysis/:asset:
const cached = sessionStorage.getItem(`report_cache_${asset.toUpperCase()}`);
if (cached) {
  const { report, timestamp } = JSON.parse(cached);
  const AGE_LIMIT_MS = 30 * 60 * 1000; // 30 minuti
  if (Date.now() - timestamp < AGE_LIMIT_MS) {
    setReport(report);
    return; // non rigenera
  }
}
// altrimenti mostra empty state con CTA "Genera analisi"
```

---

## 6. Piano di Esecuzione a Step

### Step 1 — Installazione dipendenza
```bash
npm install react-router-dom
```
**Rischio:** nessuno. Non modifica codice esistente.

### Step 2 — Componente ScrollToTop
Creare `apps/web/components/ScrollToTop.tsx`. File nuovo, nessun impatto.

### Step 3 — Wrapping BrowserRouter in index.tsx
Modifica minima a un file di bootstrap — nessuna regressione possibile.

### Step 4 — Fix Dark Mode globale (prerequisito)
- Rimuovere il wrapper `<div className={isDarkMode ? 'dark' : ''}>` da App.tsx
- Aggiungere `useEffect` che gestisce la classe `dark` direttamente su `document.documentElement`
- Aggiungere inizializzazione da `localStorage` con fallback a `prefers-color-scheme`
- **Verificare** che il dashboard continui a funzionare con lo stesso aspetto visivo
- **Verificare** che il Trading Hub ora risponda correttamente al tema

**Questo step va eseguito e testato isolatamente** — è un bugfix indipendente dal routing.

### Step 5 — Refactor App.tsx (routing)
- Rimuovere `AppView` useState e la logica condizionale `if (activeView === 'trading-hub')`
- Aggiungere `<Routes>` con la struttura definita in §5.4
- Estrarre `DashboardHome` e `AnalysisReport` come componenti interni o file separati
- Implementare cache sessionStorage per i report

**Questo è lo step più impattante sul routing.** Va testato interamente.

### Step 6 — Refactor Header.tsx
- Sostituire il prop `onOpenHub` con `<Link to="/hub">` da react-router
- Il prop `onOpenHub` può essere deprecato dopo la migrazione
- Il pulsante mobile in `App.tsx` diventa anch'esso un `<Link>`

### Step 7 — Refactor TradingHubTab.tsx
- Aggiungere `useParams<{ page: string }>()` per leggere la pagina attiva dall'URL
- Sostituire `setPage(n.id)` con `navigate(\`/hub/${n.id}\`)`
- Il back al dashboard diventa `navigate('/')` invece del callback prop `onBackToDashboard`
- Rimuovere la prop `onBackToDashboard` dall'interfaccia del componente
- Aggiungere toggle dark/light nel footer della sidebar (accanto al pulsante collapse)
- `isCollapsed` e `isMobileOpen` rimangono invariati

### Step 9 — Configurazione Nginx sul VPS
Prima del prossimo deploy in produzione, modificare il file di configurazione Nginx:
```nginx
server {
    listen 80;
    root /var/www/quantum-trade/dist;
    index index.html;

    location / {
        try_files $uri $uri/ /index.html;
    }

    # Proxy API requests
    location /api/ {
        proxy_pass http://localhost:8000/;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }
}
```

### Step 10 — Testing End-to-End
Checklist di verifica prima di considerare l'implementazione completa:

- [ ] `/` carica la home con selezione asset
- [ ] Click su BTC porta a `/analysis/btc` e genera il report
- [ ] Refresh su `/analysis/btc` mostra il report dalla cache (se < 30 min)
- [ ] Refresh su `/analysis/btc` senza cache mostra l'empty state con CTA
- [ ] `/hub` redirige a `/hub/monitor`
- [ ] Click su "Backtest" nella sidebar porta a `/hub/backtest`
- [ ] Refresh su `/hub/backtest` rimane su backtest
- [ ] Navigare da `/hub/backtest` a `/analysis/btc` scrolla in cima
- [ ] Navigare da report a `/hub/monitor` scrolla in cima
- [ ] Dark mode persiste al refresh
- [ ] URL non riconosciuto (es. `/foo`) redirige a `/`
- [ ] Header logo/brand → click porta a `/`
- [ ] Pulsante "Home" nel report porta a `/`
- [ ] Pulsante mobile "AI Trading Hub" porta a `/hub`
- [ ] In produzione (VPS): nessun 404 su refresh di URL profondi

---

## 7. Impatto su Funzionalità Esistenti

| Funzionalità | Impatto | Note |
|---|---|---|
| Generazione report AI | Nessuno | La logica di fetch rimane invariata |
| Export PNG (html2canvas) | Nessuno | Funziona su qualsiasi route |
| WebSocket / polling API hub | Nessuno | Non legato alla navigazione |
| Backtest | Nessuno | Il componente rimane identico |
| Dark Mode dashboard | Nessuno | Funziona già, si migliora solo la persistenza |
| Dark Mode Trading Hub | **Bugfix** | Attualmente non funziona — viene risolto con dark su `<html>` |
| `forceRefreshMode` | Nessuno | Rimane in useState |
| Tailwind CDN | Nessuno | Non interferisce con react-router |
| Toggle tema in Hub | **Feature aggiunta** | Pulsante nella sidebar — non esisteva |

---

## 8. Stima Complessità

| Step | Complessità | File Toccati |
|---|---|---|
| 1. Install dipendenza | Minima | package.json, package-lock.json |
| 2. ScrollToTop | Minima | 1 file nuovo |
| 3. BrowserRouter | Minima | index.tsx |
| 4. Fix dark mode su `<html>` | Minima-Media | App.tsx |
| 5. Refactor App.tsx routing | Media | App.tsx |
| 6. Refactor Header.tsx | Minima | Header.tsx |
| 7. Refactor TradingHubTab.tsx | Media | TradingHubTab.tsx |
| 9. Nginx config | Minima (1 riga) | config Nginx su VPS |
| 10. Testing | — | — |

**Totale stimato:** 3-4 ore di lavoro effettivo. Nessuna riscrittura architetturale.

---

## 9. Ordine di Priorità

1. **Obbligatorio prima del deploy:** Step 9 (Nginx) — senza questo, l'app va in 404 in produzione su qualsiasi URL diverso da `/`
2. **Prerequisito tecnico:** Step 4 (dark mode su `<html>`) — va fatto prima del routing per non perdere il tema al passaggio di route
3. **Core dell'implementazione:** Step 5 (App.tsx routing) — è il cuore della migrazione
4. **Tutto il resto** è incrementale e può essere committato separatamente

---

## 10. Decisioni Aperte

| Decisione | Opzione A | Opzione B | Default consigliato |
|---|---|---|---|
| Cache report su refresh | sessionStorage (tab-scoped) | nessuna cache → empty state | **A** — UX migliore |
| Cache TTL | 30 minuti | 60 minuti | **30 min** — dato finanziario, meglio fresco |
| `/analysis/:asset` asset non valido | Redirect a `/` | Mostra error state | **Redirect** — più pulito |
| Header logo → click | `/` | No comportamento | **`/`** — standard web |
| Dark mode default | OS `prefers-color-scheme` | sempre light | **OS** — rispetta preferenze utente |
