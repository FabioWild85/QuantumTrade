import { GoogleGenAI } from "@google/genai";
import { MarketReport, Sentiment, TechnicalAnalysis } from "../types";
import { cacheService } from "./cacheService";

// Initialize the client
const GENAI_KEY = process.env.GEMINI_API_KEY || process.env.API_KEY || '';
const ai = new GoogleGenAI({ apiKey: GENAI_KEY });

// Model Constants for Gemini 3.1
const MODELS = {
  PRO: 'gemini-3.1-pro-preview',
  FLASH: 'gemini-3.1-flash-lite'
};

const getSystemPrompt = (symbol: 'BTC' | 'ETH' | 'SOL'): string => `
Sei un Senior Quantitative Analyst per un Hedge Fund istituzionale specializzato in ${symbol}.
Il tuo obiettivo è produrre un report di trading operativo basato su una sintesi rigorosa tra Dati Tecnici "Hard" (forniti) e Dati Macro "Soft" (ricercati).

PROTOCOLLO DI ANALISI (GEMINI 3.0 LOGIC):
1. **GERARCHIA DATI**: 
   - I dati forniti nel prompt (Prezzo, RSI, Order Book, Volatilità) sono la VERITÀ ASSOLUTA. Non contraddirli mai.
   - I dati Macro (ricercati) servono a dare il "Bias" (Direzionalità) di fondo.

2. **CORRELAZIONI MACRO OBBLIGATORIE**:
   - **OIL (PETROLIO)**: Correlazione INVERSA. Oil GIÙ = Inflazione GIÙ = Bullish per Crypto. Oil SU = Bearish.
   - **DXY (DOLLARO)**: Correlazione INVERSA. DXY GIÙ = Bullish. DXY SU = Bearish.
   - **RUSSELL 2000**: Correlazione DIRETTA. Se sale, favorisce asset speculativi (ETH/SOL).

3. **GESTIONE DEL RISCHIO**:
   - Usa SEMPRE l'ATR fornito per calcolare gli Stop Loss. Formula: Entry - (2 * ATR) per Long, Entry + (2 * ATR) per Short.
   - Non dare mai segnali "sicuri". Usa un linguaggio probabilistico ("Probabile rottura", "Setup ad alta confluenza").

4. **STILE ISTITUZIONALE**:
   - Sii conciso, diretto, usa terminologia tecnica (Liquidity sweep, Supply shock, Mean reversion).
   - Evita frasi generiche ("Il mercato è volatile"). Sii specifico ("La volatilità compressa suggerisce un breakout imminente").

RISPONDI ESCLUSIVAMENTE CON UN JSON VALIDO SECONDO LA STRUTTURA RICHIESTA.
`;

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

const getFallbackReport = (symbol: 'BTC' | 'ETH' | 'SOL', realData: Partial<TechnicalAnalysis>, sources: string[] = []): MarketReport => {
  return {
    timestamp: new Date().toISOString(),
    macroOverview: "AI Analysis unavailable. Displaying calculated technical data.",
    macroSentiment: Sentiment.NEUTRAL,
    forecastOpinion: "Automated Fallback: Please rely on the indicator matrix below.",
    calendar: [],
    latestNews: [],
    technical: {
        price: 0,
        priceHistory: [],
        dominance: "N/A",
        fearGreedIndex: 50,
        rsi: { value: 50, status: 'Neutral', divergence: 'None' },
        macd: { status: 'Neutral', histogram: 0 },
        openInterest: "N/A",
        fundingRate: "N/A",
        volumeAnalysis: "N/A",
        keyLevels: { support: [], resistance: [] },
        ...realData, 
        ethBtcRatio: realData.ethBtcRatio || { value: 0, trend: 'Neutral', signal: 'N/A' },
        orderBook: realData.orderBook || { bidPressure: 50, askPressure: 50, imbalance: 'Neutral', wallPrice: 0, wallType: 'Ask', totalAskVol: 0, totalBidVol: 0 },
        volatility: realData.volatility || { atr: 0, bollingerBands: { upper: 0, middle: 0, lower: 0, bandwidth: 0, percentB: 0, squeeze: false } },
        indicators: realData.indicators || [],
        trendStructure: realData.trendStructure,
        cycles: realData.cycles,
        shortTerm: realData.shortTerm,
        onChain: { mvrvZScore: 1.5, nupl: 0.4, activeAddressesTrend: 'Stable', longTermHolderSupplyChange: 'Stable' } 
    },
    signals: [],
    checklist: [],
    trendReversal: {
        bullishScenario: { title: "N/A", condition: "N/A", keyLevel: "N/A", probability: "Bassa" },
        bearishScenario: { title: "N/A", condition: "N/A", keyLevel: "N/A", probability: "Bassa" }
    },
    sources: sources
  };
};

export const generateMarketAnalysis = async (symbol: 'BTC' | 'ETH' | 'SOL', realData: Partial<TechnicalAnalysis>, forceRefresh: boolean = false): Promise<MarketReport> => {
  
  if (!forceRefresh) {
    const cached = cacheService.getValidReport(symbol);
    if (cached) {
      console.log(`Serving cached report for ${symbol} to save API costs.`);
      return cached;
    }
  }

  let attempts = 0;
  const maxAttempts = 3;
  let currentModel = MODELS.PRO;

  while (attempts < maxAttempts) {
    try {
      const ANALYSIS_PROMPT = `
      Analizza ${symbol} per un report professionale (Hedge Fund Standard).
      
      DATI TECNICI REALI (INPUT HARD - NON CONTRADDIRE):
      - Price: $${realData.price}
      - Daily ATR (Volatilità): $${realData.volatility?.atr} (CRITICO PER STOP LOSS)
      - Weekly Structure: ${realData.trendStructure?.weekly}
      - 4H Support/Resistance (CALCOLATI): Supporto $${realData.shortTerm?.support4h}, Resistenza $${realData.shortTerm?.resistance4h}
      
      TASK 1: RICERCA WEB (CRITICO: CERCA DATI LIVE)
      1. **MACRO INDICATORS (FUTURES)**: Cerca specificamente "US500 Futures Price Live" (S&P), "DXY Futures Live", "Russell 2000 Futures", "Crude Oil WTI Futures".
         *ATTENZIONE: Se trovi dati vecchi di 24h, cercali di nuovo. Vogliamo il prezzo ADESSO.*
      2. **US Unemployment Rate %**: Cerca l'ultimo dato ufficiale rilasciato (BLS report).
      3. **ECONOMIC CALENDAR**: Cerca i 3 eventi macro più importanti dei prossimi 7 giorni.
      4. **CRYPTO NEWS**: Cerca le ultime 4 notizie rilevanti per ${symbol} SOLO da **CoinTelegraph** e **CoinDesk**.
      5. **FLOWS**: Cerca "Farside Investors ${symbol === 'SOL' ? 'Bitcoin' : symbol} ETF Flow daily" (in $ Millions).
      6. **BTC DOMINANCE**: Cerca "Bitcoin Dominance live chart" o "BTC.D index".
      
      TASK 2: GENERAZIONE JSON
      Genera un JSON valido con questa struttura esatta:
      {
        "timestamp": "ISO String",
        "macroOverview": "Sintesi macroeconomica professionale (max 3 frasi). Focus su correlazioni.",
        "macroSentiment": "BULLISH/BEARISH/NEUTRAL",
        "forecastOpinion": "Opinione strategica sintetica (es. 'Accumulare sui dip in attesa di breakout').",
        "calendar": [ { "date": "YYYY-MM-DD", "event": "FOMC Meeting", "impact": "High/Medium", "forecast": "...", "previous": "..." } ],
        "latestNews": [ { "title": "Headline", "source": "CoinTelegraph/CoinDesk", "sentiment": "Positive/Negative", "time": "2h ago" } ],
        "technical": {
             "sp500": { "price": "...", "trend": "BULLISH/BEARISH", "change24h": "up/down" },
             "dxy": { "price": "...", "trend": "BULLISH/BEARISH", "change24h": "up/down" },
             "russell2000": { "price": "...", "trend": "BULLISH/BEARISH", "change24h": "up/down" },
             "oil": { "price": "...", "trend": "BULLISH/BEARISH", "change24h": "up/down" },
             "dominance": "xx.x%",
             "inflation": { "price": "...%", "trend": "BULLISH/BEARISH", "change24h": "flat" },
             "unemployment": { "price": "...%", "trend": "BULLISH/BEARISH", "change24h": "flat" },
             "gdp": { "price": "...%", "trend": "BULLISH/BEARISH", "change24h": "flat" },
             "m2": { "price": "...T", "trend": "BULLISH/BEARISH", "change24h": "up/down" },
             "exchangeNetFlow": { "netInflow": number, "trend": "Accumulation/Distribution", "metricType": "Exchange" },
             "etfNetInflow": { "netInflow": number, "trend": "Accumulation/Distribution", "metricType": "ETF" },
             "onChain": { "mvrvZScore": number, "nupl": number, "activeAddressesTrend": "Rising", "longTermHolderSupplyChange": "Stable" },
             "cycles": { "historicalSeasonality": "..." },
             "shortTerm": { "priceAction": "..." }
        },
        "signals": [ { "asset": "${symbol}", "type": "LONG/SHORT", "timeframe": "Swing", "entryZone": "...", "stopLoss": "Calculated as Entry +/- 2*ATR", "takeProfit": ["..."], "rationale": "...", "riskLevel": "Medio", "confidenceScore": 80 } ],
        "checklist": [ { "category": "Market Phase", "status": "PASS/FAIL", "details": "..." } ],
        "trendReversal": {
          "bullishScenario": { "title": "...", "condition": "...", "keyLevel": "...", "probability": "Media" },
          "bearishScenario": { "title": "...", "condition": "...", "keyLevel": "...", "probability": "Media" }
        }
      }
      `;
      
      console.log(`AI Analysis started using ${currentModel}...`);
      const response = await ai.models.generateContent({
        model: currentModel,
        contents: ANALYSIS_PROMPT,
        config: {
          systemInstruction: getSystemPrompt(symbol),
          tools: [{ googleSearch: {} }],
        }
      });

      const textResponse = response.text;
      
      const groundingChunks = response.candidates?.[0]?.groundingMetadata?.groundingChunks || [];
      const sources = groundingChunks
          .map((chunk: any) => chunk.web?.uri)
          .filter((uri: string | undefined) => uri && uri.trim().length > 0) as string[];

      let parsedJson: Partial<MarketReport> = {};

      try {
        const jsonMatch = textResponse.match(/```json\s*([\s\S]*?)\s*```/);
        if (jsonMatch) {
           parsedJson = JSON.parse(jsonMatch[1]);
        } else {
          const firstBrace = textResponse.indexOf('{');
          const lastBrace = textResponse.lastIndexOf('}');
          if (firstBrace !== -1 && lastBrace !== -1) {
             const rawJson = textResponse.substring(firstBrace, lastBrace + 1);
             parsedJson = JSON.parse(rawJson);
          } else {
             throw new Error("No JSON structure found");
          }
        }
      } catch (parseError) {
        console.warn(`JSON Parse Error on attempt ${attempts + 1}`);
        throw parseError;
      }

      const aiTechnical: Partial<TechnicalAnalysis> = parsedJson.technical || {};

      const finalReport: MarketReport = {
        timestamp: new Date().toISOString(),
        macroOverview: parsedJson.macroOverview || "Dati macro non disponibili.",
        macroSentiment: parsedJson.macroSentiment || Sentiment.NEUTRAL,
        forecastOpinion: parsedJson.forecastOpinion || "Previsione non disponibile.",
        calendar: Array.isArray(parsedJson.calendar) ? parsedJson.calendar : [],
        latestNews: Array.isArray(parsedJson.latestNews) ? parsedJson.latestNews : [], 
        technical: {
          ...realData, 
          sp500: aiTechnical.sp500,
          dxy: aiTechnical.dxy,
          russell2000: aiTechnical.russell2000,
          oil: aiTechnical.oil,
          inflation: aiTechnical.inflation,
          unemployment: aiTechnical.unemployment,
          gdp: aiTechnical.gdp,
          m2: aiTechnical.m2,
          exchangeNetFlow: aiTechnical.exchangeNetFlow,
          etfNetInflow: aiTechnical.etfNetInflow,
          onChain: aiTechnical.onChain || { mvrvZScore: 0, nupl: 0, activeAddressesTrend: 'Stable', longTermHolderSupplyChange: 'Stable' },
          cycles: {
              ...realData.cycles!,
              historicalSeasonality: aiTechnical.cycles?.historicalSeasonality || "Data unavailable"
          },
          shortTerm: {
             ...realData.shortTerm!, // Keep the real calculated support/resistance
             priceAction: aiTechnical.shortTerm?.priceAction || "Analyzing price action..."
          },
          price: realData.price || 0,
          priceHistory: realData.priceHistory || [],
          // ... rest protected ...
          dominance: aiTechnical.dominance || "N/A",
          fearGreedIndex: realData.fearGreedIndex || 50,
          rsi: realData.rsi || { value: 50, status: 'Neutral', divergence: 'None' },
          macd: realData.macd || { status: 'Neutral', histogram: 0 },
          openInterest: realData.openInterest || "N/A",
          fundingRate: realData.fundingRate || "N/A",
          volumeAnalysis: realData.volumeAnalysis || "N/A",
          keyLevels: realData.keyLevels || { support: [], resistance: [] },
          orderBook: realData.orderBook || { bidPressure: 50, askPressure: 50, imbalance: 'Neutral', wallPrice: 0, wallType: 'Ask', totalAskVol: 0, totalBidVol: 0 },
          volatility: realData.volatility || { atr: 0, bollingerBands: { upper: 0, middle: 0, lower: 0, bandwidth: 0, percentB: 0, squeeze: false } },
          ethBtcRatio: realData.ethBtcRatio || { value: 0, trend: 'Neutral', signal: 'N/A' },
          indicators: realData.indicators || [],
          trendStructure: realData.trendStructure
        },
        signals: Array.isArray(parsedJson.signals) ? parsedJson.signals : [],
        checklist: Array.isArray(parsedJson.checklist) ? parsedJson.checklist : [],
        trendReversal: {
          bullishScenario: { title: "N/A", condition: "N/A", keyLevel: "N/A", probability: "Media", ...(parsedJson.trendReversal?.bullishScenario || {}) },
          bearishScenario: { title: "N/A", condition: "N/A", keyLevel: "N/A", probability: "Media", ...(parsedJson.trendReversal?.bearishScenario || {}) }
        },
        sources: sources
      };

      cacheService.saveReport(symbol, finalReport);
      return finalReport;

    } catch (error: any) {
      attempts++;
      console.error(`Gemini API Attempt ${attempts} failed (${currentModel}):`, error.message);
      
      // If Pro fails, fallback to Flash for the next attempt
      if (currentModel === MODELS.PRO) {
        console.warn("Switching to Gemini 3.1 Flash-Lite due to Pro unavailability...");
        currentModel = MODELS.FLASH;
      }

      if (attempts >= maxAttempts) {
         console.error("All AI attempts failed. Returning fallback data.");
         return getFallbackReport(symbol, realData, []);
      }
      await delay(1500 * attempts); // Exponential-ish backoff
    }
  }
  return getFallbackReport(symbol, realData);
};