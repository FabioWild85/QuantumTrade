import { MarketReport, Sentiment, TechnicalAnalysis } from "../types";
import { cacheService } from "./cacheService";

import { apiFetch } from './authService';
// ─── Backend proxy (la GEMINI_API_KEY resta lato server, mai nel bundle JS) ──
const API_BASE = import.meta.env.DEV ? 'http://localhost:8000' : '/api';

async function callGemini(model: string, body: object): Promise<any> {
  const res = await apiFetch(`${API_BASE}/ai/gemini`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, ...body }),
  });
  if (!res.ok) throw new Error(`Gemini proxy error ${res.status}: ${await res.text()}`);
  return res.json();
}

// ─── Models ───────────────────────────────────────────────────────────────────
// gemini-3.1-flash-lite → Phase 1: ultra-fast web search (May 2026)
// gemini-3.1-pro-preview → Phase 2: state-of-the-art reasoning (May 2026)
const MODELS = {
  RESEARCHER: 'gemini-3.1-flash-lite',
  STRATEGIST: 'gemini-3.1-flash', // Switched from Pro to Flash for major cost savings
  FALLBACK:   'gemini-2.5-flash', 
};

// ─── Helpers ──────────────────────────────────────────────────────────────────
/** A-02: Automatically compute Risk/Reward ratio from signal price strings. */
function calculateRR(signal: any): string {
  try {
    const extractPrice = (str: string): number => {
      if (!str) return 0;
      const nums = str.replace(/,/g, '').match(/\d+\.?\d*/g);
      if (!nums) return 0;
      const prices = nums.map(Number).filter(n => n > 100);
      return prices.length ? prices[0] : 0;
    };
    const entry = extractPrice(signal.entryZone);
    const sl    = extractPrice(signal.stopLoss);
    const tp    = extractPrice(signal.takeProfit?.[0] ?? '');
    if (entry && sl && tp) {
      const risk   = Math.abs(entry - sl);
      const reward = Math.abs(tp - entry);
      if (risk > 0) return `${(reward / risk).toFixed(1)}:1`;
    }
  } catch {}
  return 'N/A';
}

/** Extract the first valid JSON object from a model response string. */
function extractJson(text: string): any {
  const mdMatch = text.match(/```json\s*([\s\S]*?)\s*```/);
  const raw = mdMatch ? mdMatch[1] : text;
  const first = raw.indexOf('{');
  const last  = raw.lastIndexOf('}');
  if (first === -1 || last === -1) throw new Error('No JSON found in response');
  return JSON.parse(raw.substring(first, last + 1));
}

/** Extract grounding source URLs from a Gemini response. */
function extractSources(response: any): string[] {
  const chunks = response.candidates?.[0]?.groundingMetadata?.groundingChunks ?? [];
  return chunks
    .map((c: any) => c.web?.uri as string | undefined)
    .filter((u: string | undefined): u is string => Boolean(u && u.trim()));
}

// ─── Fallback report (shown when AI is unreachable) ───────────────────────────
const getFallbackReport = (
  _symbol: 'BTC' | 'ETH' | 'SOL',
  realData: Partial<TechnicalAnalysis>,
): MarketReport => ({
  timestamp: new Date().toISOString(),
  macroOverview: 'AI Analysis unavailable. Displaying calculated technical data only.',
  macroSentiment: Sentiment.NEUTRAL,
  forecastOpinion: 'Automated Fallback: rely on the indicator matrix below.',
  calendar: [],
  latestNews: [],
  technical: {
    price: 0,
    priceHistory: [],
    dominance: 'N/A',
    fearGreedIndex: 50,
    rsi: { value: 50, status: 'Neutral', divergence: 'None' },
    macd: { status: 'Neutral', histogram: 0 },
    openInterest: 'N/A',
    fundingRate: 'N/A',
    volumeAnalysis: 'N/A',
    keyLevels: { support: [], resistance: [] },
    ethBtcRatio: { value: 0, trend: 'Neutral', signal: 'N/A' },
    orderBook: { bidPressure: 50, askPressure: 50, imbalance: 'Neutral', wallPrice: 0, wallType: 'Ask', totalAskVol: 0, totalBidVol: 0 },
    volatility: { atr: 0, bollingerBands: { upper: 0, middle: 0, lower: 0, bandwidth: 0, percentB: 0, squeeze: false } },
    indicators: [],
    // FIX: don't expose hardcoded MVRV/NUPL in fallback — they would be displayed
    // as if they were real metrics. Use 0/Stable so the UI clearly shows "no data".
    onChain: { mvrvZScore: 0, nupl: 0, activeAddressesTrend: 'Stable', longTermHolderSupplyChange: 'Stable' },
    ...realData,
    trendStructure: realData.trendStructure,
    cycles: realData.cycles,
    shortTerm: realData.shortTerm,
  },
  signals: [],
  checklist: [],
  trendReversal: {
    bullishScenario: { title: 'N/A', condition: 'N/A', keyLevel: 'N/A', probability: 'Bassa' },
    bearishScenario: { title: 'N/A', condition: 'N/A', keyLevel: 'N/A', probability: 'Bassa' },
  },
  sources: [],
});

// ─── PHASE 1: RESEARCHER (Gemini Flash + Google Search) ───────────────────────
/**
 * Uses the fast Flash model with Google Search grounding to retrieve
 * live macro data and news. Runs in ~5–8 s instead of 20+ s.
 */
async function fetchMacroResearch(
  symbol: string, 
  realData: Partial<TechnicalAnalysis>
): Promise<{ data: any; sources: string[] }> {
  
  // Identify which macro assets we ALREADY have from APIs to avoid paid AI search
  const hasSp500 = !!realData.sp500;
  const hasDxy = !!realData.dxy;
  const hasOil = !!realData.oil;
  const hasRussell = !!realData.russell2000;

  const prompt = `
Sei un analista macro. Recupera i dati mancanti e le news per ${symbol}.
${hasSp500 && hasDxy && hasOil && hasRussell 
  ? 'Abbiamo già i prezzi live di S&P500, DXY, Oil e Russell. Concentrati SOLO su news, calendario e indicatori macro (inflazione/PIL).' 
  : 'Cerca i dati LIVE mancanti tra quelli elencati sotto.'}

1. MERCATI (Solo se non forniti):
   ${!hasSp500 ? '- S&P 500 (US500 Futures)' : ''}
   ${!hasDxy ? '- DXY Dollar Index' : ''}
   ${!hasRussell ? '- Russell 2000' : ''}
   ${!hasOil ? '- Crude Oil WTI' : ''}

2. INDICATORI MACRO USA (ultimi dati ufficiali):
   - Unemployment Rate %
   - CPI Inflation %
   - GDP Growth %

3. CRYPTO-SPECIFICI:
   - BTC Dominance % (se non fornito: ${realData.dominance || 'N/A'})
   - ETF daily net flow per ${symbol} (in $M)
   - SE ${symbol} === 'ETH': Cerca Gas Fees (Gwei), Staking APY %, e ETH Burned nelle ultime 24h.

4. NEWS: Le ultime 4 notizie rilevanti per ${symbol} da CoinDesk o CoinTelegraph.

5. CALENDARIO: I 3 eventi macro più importanti dei prossimi 7 giorni.

Restituisci SOLO un JSON con questa struttura:
{
  "sp500": { "price": "...", "trend": "BULLISH/BEARISH" },
  "dxy": { "price": "...", "trend": "BULLISH/BEARISH" },
  "russell2000": { "price": "...", "trend": "BULLISH/BEARISH" },
  "oil": { "price": "...", "trend": "BULLISH/BEARISH" },
  "unemployment": "...",
  "inflation": "...",
  "gdp": "...",
  "dominance": "...",
  "etfNetFlow": 0,
  "ethNetwork": { "gas": "...", "stakingApy": "...", "burned24h": "..." },
  "news": [
    { "title": "...", "source": "CoinDesk/CoinTelegraph", "sentiment": "Positive/Negative/Neutral", "time": "2h ago" }
  ],
  "calendar": [
    { "date": "YYYY-MM-DD", "event": "...", "impact": "High/Medium" }
  ]
}
`;

  try {
    const response = await callGemini(MODELS.RESEARCHER, {
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      tools: [{ google_search: {} }],
    });
    const text = response.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
    const sources = extractSources(response);
    const data = extractJson(text);
    console.log(`Research OK (${MODELS.RESEARCHER}) — ${sources.length} sources.`);
    return { data, sources };
  } catch (err: any) {
    // Preview model might not be available — fall back to stable flash
    console.warn(`Research with ${MODELS.RESEARCHER} failed, trying ${MODELS.FALLBACK}:`, err.message);
    try {
      const response = await callGemini(MODELS.FALLBACK, {
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        tools: [{ google_search: {} }],
      });
      const text = response.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
      const sources = extractSources(response);
      const data = extractJson(text);
      console.log(`Research OK (fallback ${MODELS.FALLBACK}) — ${sources.length} sources.`);
      return { data, sources };
    } catch (err2: any) {
      console.warn('Research Phase failed (non-blocking):', err2.message);
      return { data: {}, sources: [] };
    }
  }
}

// ─── PHASE 2: STRATEGIST (Gemini Pro — no web search) ─────────────────────────
/**
 * Uses the Pro model to cross-reference the technical data (from Binance)
 * with the macro research gathered in Phase 1 and generate the full report.
 * Because this model doesn't need to browse the web, it is significantly faster.
 */
async function runStrategyAnalysis(
  symbol: 'BTC' | 'ETH' | 'SOL',
  realData: Partial<TechnicalAnalysis>,
  macroData: any,
): Promise<{ parsed: any }> {
  const systemInstruction = `
Sei un Senior Quantitative Analyst per un Hedge Fund specializzato in ${symbol}.
Analizza i dati tecnici (da Binance) e i dati macro (pre-ricercati) per generare un report istituzionale.
REGOLE:
- I dati tecnici forniti sono la VERITÀ ASSOLUTA. Non contraddirli mai.
- Usa sempre l'ATR per calcolare gli Stop Loss: Entry ± (2 × ATR).
- Correlazioni obbligatorie: analizza btcEthCorrelation e macroCorrelation (SP500/DXY). DXY↑ = Bearish Crypto.
- Order Book Walls: Osserva maxBidWall e maxAskWall per identificare barriere reali di prezzo.
- Volatilità: Se bollingerBands.squeeze è true, sottolinea che un'esplosione di prezzo è imminente.
- Usa linguaggio probabilistico (es. "Alta confluenza per breakout rialzista").
- Rispondi ESCLUSIVAMENTE con un JSON valido.
`;

  const prompt = `
DATI TECNICI REALI (BINANCE — NON CONTRADDIRE):
${JSON.stringify(realData, null, 2)}

DATI MACRO & NEWS (PRE-RICERCATI):
${JSON.stringify(macroData, null, 2)}

Genera il JSON del report con QUESTA struttura esatta:
{
  "timestamp": "ISO String",
  "macroOverview": "Sintesi macro professionale max 3 frasi. Focus su DXY/OIL/SPX e impatto su ${symbol}.",
  "macroSentiment": "BULLISH | BEARISH | NEUTRAL",
  "forecastOpinion": "Strategia operativa sintetica (es. 'Accumulare sui dip in attesa di breakout').",
  "calendar": [
    { "date": "YYYY-MM-DD", "event": "...", "impact": "High/Medium", "forecast": "...", "previous": "..." }
  ],
  "latestNews": [
    { "title": "...", "source": "...", "sentiment": "Positive/Negative/Neutral", "time": "..." }
  ],
  "technical": {
    "sp500":       { "price": "...", "trend": "BULLISH/BEARISH", "change24h": "up/down" },
    "dxy":         { "price": "...", "trend": "BULLISH/BEARISH", "change24h": "up/down" },
    "russell2000": { "price": "...", "trend": "BULLISH/BEARISH", "change24h": "up/down" },
    "oil":         { "price": "...", "trend": "BULLISH/BEARISH", "change24h": "up/down" },
    "dominance": "...",
    "inflation":   { "price": "...%", "trend": "BULLISH/BEARISH", "change24h": "flat" },
    "unemployment":{ "price": "...%", "trend": "BULLISH/BEARISH", "change24h": "flat" },
    "gdp":         { "price": "...%", "trend": "BULLISH/BEARISH", "change24h": "flat" },
    "m2":          { "price": "...T", "trend": "BULLISH/BEARISH", "change24h": "up/down" },
    "exchangeNetFlow": { "netInflow": 0, "trend": "Accumulation/Distribution", "metricType": "Exchange" },
    "etfNetInflow":    { "netInflow": 0, "trend": "Accumulation/Distribution", "metricType": "ETF" },
    "onChain": { "mvrvZScore": 0, "nupl": 0, "activeAddressesTrend": "Rising/Falling/Stable", "longTermHolderSupplyChange": "Rising/Falling/Stable" },
    "cycles":    { "historicalSeasonality": "..." },
    "shortTerm": { "priceAction": "..." }
  },
  "signals": [
    {
      "asset": "${symbol}",
      "type": "LONG | SHORT",
      "timeframe": "Swing",
      "entryZone": "...",
      "stopLoss": "Calcolato come Entry ± 2×ATR",
      "takeProfit": ["TP1: ...", "TP2: ..."],
      "rationale": "...",
      "riskLevel": "Basso/Medio/Alto",
      "confidenceScore": 80
    }
  ],
  "checklist": [
    { "category": "Market Phase", "status": "PASS | FAIL", "details": "..." }
  ],
  "trendReversal": {
    "bullishScenario": { "title": "...", "condition": "...", "keyLevel": "...", "probability": "Alta/Media/Bassa" },
    "bearishScenario": { "title": "...", "condition": "...", "keyLevel": "...", "probability": "Alta/Media/Bassa" }
  }
}
`;

  try {
    const response = await callGemini(MODELS.STRATEGIST, {
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      systemInstruction: { parts: [{ text: systemInstruction }] },
    });
    const text = response.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
    return { parsed: extractJson(text) };
  } catch (err: any) {
    // Preview model might not be available — fall back to stable flash
    console.warn(`Strategy with ${MODELS.STRATEGIST} failed, trying ${MODELS.FALLBACK}:`, err.message);
    const response = await callGemini(MODELS.FALLBACK, {
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      systemInstruction: { parts: [{ text: systemInstruction }] },
    });
    const text = response.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
    return { parsed: extractJson(text) };
  }
}

// ─── PUBLIC API ────────────────────────────────────────────────────────────────
export const generateMarketAnalysis = async (
  symbol: 'BTC' | 'ETH' | 'SOL',
  realData: Partial<TechnicalAnalysis>,
  forceRefresh: boolean = false,
): Promise<MarketReport> => {

  // Serve from cache when available (saves API quota)
  if (!forceRefresh) {
    const cached = cacheService.getValidReport(symbol);
    if (cached) {
      console.log(`Cache HIT for ${symbol} — skipping API call.`);
      // Sanitize numeric fields that Gemini may have returned as strings
      if (cached.technical?.onChain) {
        cached.technical.onChain.mvrvZScore = Number(cached.technical.onChain.mvrvZScore) || 0;
        cached.technical.onChain.nupl = Number(cached.technical.onChain.nupl) || 0;
      }
      return cached;
    }
  }

  try {
    // ── Run both phases: Research happens first (grounding), then Strategy ──
    console.log(`[Phase 1] Research starting for ${symbol}…`);
    const research = await fetchMacroResearch(symbol, realData);

    console.log(`[Phase 2] Strategy analysis starting for ${symbol}…`);
    const { parsed } = await runStrategyAnalysis(symbol, realData, research.data);

    // Merge: real Binance data always wins over AI-generated technical fields
    const finalReport: MarketReport = {
      timestamp: new Date().toISOString(),
      macroOverview:   parsed.macroOverview   || 'Dati macro non disponibili.',
      macroSentiment:  parsed.macroSentiment  || Sentiment.NEUTRAL,
      forecastOpinion: parsed.forecastOpinion || 'Previsione non disponibile.',
      calendar:    Array.isArray(parsed.calendar)    ? parsed.calendar    : [],
      latestNews:  Array.isArray(parsed.latestNews)  ? parsed.latestNews  : [],
      signals:     Array.isArray(parsed.signals)     ? parsed.signals.map((s: any) => ({ ...s, riskReward: calculateRR(s) })) : [],
      checklist:   Array.isArray(parsed.checklist)   ? parsed.checklist   : [],
      trendReversal: {
        bullishScenario: { title: 'N/A', condition: 'N/A', keyLevel: 'N/A', probability: 'Media', ...(parsed.trendReversal?.bullishScenario ?? {}) },
        bearishScenario: { title: 'N/A', condition: 'N/A', keyLevel: 'N/A', probability: 'Media', ...(parsed.trendReversal?.bearishScenario ?? {}) },
      },
      technical: {
        // AI-provided macro fields first
        ...parsed.technical,
        // Hard real data ALWAYS overwrites — price, RSI, MACD, etc.
        ...realData,
        // Merge nested objects carefully
        onChain: parsed.technical?.onChain ? {
          ...parsed.technical.onChain,
          mvrvZScore: Number(parsed.technical.onChain.mvrvZScore) || 0,
          nupl: Number(parsed.technical.onChain.nupl) || 0,
        } : { mvrvZScore: 0, nupl: 0, activeAddressesTrend: 'Stable', longTermHolderSupplyChange: 'Stable' },
        cycles: {
          daysSinceHalving: realData.cycles?.daysSinceHalving ?? 0,
          progressInCycle:  realData.cycles?.progressInCycle  ?? 0,
          distanceFromAth:  realData.cycles?.distanceFromAth  ?? 0,
          historicalSeasonality: parsed.technical?.cycles?.historicalSeasonality ?? 'N/A',
        },
        shortTerm: realData.shortTerm ? {
          ...realData.shortTerm,
          priceAction: parsed.technical?.shortTerm?.priceAction ?? 'Analyzing…',
        } : undefined,
      },
      sources: research.sources,
    };

    cacheService.saveReport(symbol, finalReport);
    console.log(`[Done] Report generated for ${symbol}.`);
    return finalReport;

  } catch (err: any) {
    console.error(`generateMarketAnalysis failed for ${symbol}:`, err.message);
    return getFallbackReport(symbol, realData);
  }
};