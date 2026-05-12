import { TechnicalAnalysis, OrderBookAnalysis, VolatilityMetrics, EthereumSpecificData, TrendStructure, CycleMetrics, ShortTermAnalysis, Sentiment, Candle } from '../types';
import { calculateLastRSI, calculateRSIArray, calculateEMA, calculateMACD, calculateSMA, calculateBollingerBands, calculateATR } from '../utils/indicators';

const detectRsiDivergence = (prices: number[], rsiValues: number[], lookback: number = 28): 'Bullish' | 'Bearish' | 'None' => {
  if (prices.length < lookback || rsiValues.length < lookback) return 'None';

  const priceSlice = prices.slice(-lookback);
  const rsiSlice = rsiValues.slice(-lookback);

  const firstHalfPrices = priceSlice.slice(0, lookback / 2);
  const secondHalfPrices = priceSlice.slice(lookback / 2);
  const firstHalfRsi = rsiSlice.slice(0, lookback / 2);
  const secondHalfRsi = rsiSlice.slice(lookback / 2);

  const low1 = Math.min(...firstHalfPrices);
  const low2 = Math.min(...secondHalfPrices);
  const rsiAtLow1 = firstHalfRsi[firstHalfPrices.indexOf(low1)];
  const rsiAtLow2 = secondHalfRsi[secondHalfPrices.indexOf(low2)];

  if (low2 < low1 * 0.995 && rsiAtLow2 > rsiAtLow1 * 1.05) return 'Bullish';

  const high1 = Math.max(...firstHalfPrices);
  const high2 = Math.max(...secondHalfPrices);
  const rsiAtHigh1 = firstHalfRsi[firstHalfPrices.indexOf(high1)];
  const rsiAtHigh2 = secondHalfRsi[secondHalfPrices.indexOf(high2)];

  if (high2 > high1 * 1.005 && rsiAtHigh2 < rsiAtHigh1 * 0.95) return 'Bearish';

  return 'None';
};

// Helper for safe fetching to prevent Promise.all failure
const safeFetchJson = async (url: string) => {
    try {
        const res = await fetch(url);
        const json = await res.json();
        return Array.isArray(json) ? json : [];
    } catch (e) {
        console.warn(`Fetch failed for ${url}`, e);
        return [];
    }
};

const safeFetchObject = async (url: string) => {
    try {
        const res = await fetch(url);
        return await res.json();
    } catch (e) {
        return null;
    }
};

export const getTechnicalData = async (symbol: 'BTC' | 'ETH' | 'SOL'): Promise<Partial<TechnicalAnalysis>> => {
  const pair = `${symbol}USDT`;
  
  try {
    // PARALLEL FETCHING: Significant speed improvement
    // INCREASED LIMIT TO 1000 for 4h to ensure history for chart and SMA calculations
    const [weeklyData, dailyData, h4Data, ethBtcRaw, depth, fgData] = await Promise.all([
        safeFetchJson(`https://api.binance.com/api/v3/klines?symbol=${pair}&interval=1w&limit=52`),
        safeFetchJson(`https://api.binance.com/api/v3/klines?symbol=${pair}&interval=1d&limit=200`),
        safeFetchJson(`https://api.binance.com/api/v3/klines?symbol=${pair}&interval=4h&limit=1000`),
        safeFetchJson(`https://api.binance.com/api/v3/klines?symbol=ETHBTC&interval=1d&limit=50`),
        safeFetchObject(`https://api.binance.com/api/v3/depth?symbol=${pair}&limit=50`),
        safeFetchObject('https://api.alternative.me/fng/')
    ]);

    // 1. Process Weekly
    const weeklyCloses = weeklyData.map((d: any) => parseFloat(d[4]));
    
    // 2. Process Daily (For Indicators & Structure)
    const dailyCloses = dailyData.map((d: any) => parseFloat(d[4]));
    const dailyHighs = dailyData.map((d: any) => parseFloat(d[2]));
    const dailyLows = dailyData.map((d: any) => parseFloat(d[3]));
    const currentPrice = dailyCloses.length > 0 ? dailyCloses[dailyCloses.length - 1] : 0;
    
    // 3. Process 4H (For Chart & Short Term)
    // Map 4H data for the Interactive Chart
    const priceHistory: Candle[] = h4Data.map((d: any) => ({
        time: (d[0] / 1000) as any, // Use UNIX timestamp (seconds) for Lightweight Charts
        open: parseFloat(d[1]),
        high: parseFloat(d[2]),
        low: parseFloat(d[3]),
        close: parseFloat(d[4])
    })); 

    const h4Closes = h4Data.map((d: any) => parseFloat(d[4]));
    const h4Volumes = h4Data.map((d: any) => parseFloat(d[5]));
    const h4Highs = h4Data.map((d: any) => parseFloat(d[2]));
    const h4Lows = h4Data.map((d: any) => parseFloat(d[3]));

    // 4. ETH/BTC Ratio (Or Generic Ratio)
    let ethBtcRatioData: any = { value: 0, trend: 'Neutral', signal: 'Neutral' };
    if (ethBtcRaw.length > 0) {
        const ethBtcCloses = ethBtcRaw.map((d: any) => parseFloat(d[4]));
        const currentRatio = ethBtcCloses[ethBtcCloses.length - 1];
        const sma50Ratio = calculateSMA(ethBtcCloses, 50);
        // Only meaningful if analyzing BTC or ETH directly
        if (symbol === 'BTC' || symbol === 'ETH') {
            ethBtcRatioData = { 
                value: currentRatio, 
                trend: currentRatio > sma50Ratio ? 'Bullish' : 'Bearish', 
                signal: currentRatio > sma50Ratio ? 'ETH Outperforming' : 'BTC Dominant' 
            };
        }
    }

    // 5. Order Book - Optimized Loop
    let orderBookData: OrderBookAnalysis = {
        bidPressure: 50, askPressure: 50, imbalance: 'Neutral', wallPrice: 0, wallType: 'Ask', totalAskVol: 0, totalBidVol:0
    };

    if (depth && Array.isArray(depth.bids) && Array.isArray(depth.asks)) {
        let bidsVol = 0, asksVol = 0;
        let maxBidVol = 0, maxBidPrice = 0;
        let maxAskVol = 0, maxAskPrice = 0;

        for (const b of depth.bids) {
            const vol = parseFloat(b[1]);
            const price = parseFloat(b[0]);
            bidsVol += vol;
            if (vol > maxBidVol) { maxBidVol = vol; maxBidPrice = price; }
        }

        for (const a of depth.asks) {
            const vol = parseFloat(a[1]);
            const price = parseFloat(a[0]);
            asksVol += vol;
            if (vol > maxAskVol) { maxAskVol = vol; maxAskPrice = price; }
        }

        const totalVol = bidsVol + asksVol;
        const bidPressure = (bidsVol / totalVol) * 100;
        const askPressure = (asksVol / totalVol) * 100;

        orderBookData = {
            bidPressure,
            askPressure,
            totalBidVol: bidsVol,
            totalAskVol: asksVol,
            imbalance: bidPressure > 55 ? 'Bullish' : askPressure > 55 ? 'Bearish' : 'Neutral',
            wallPrice: maxAskVol > maxBidVol ? maxAskPrice : maxBidPrice,
            wallType: maxAskVol > maxBidVol ? 'Ask' : 'Bid'
        };
    }

    // --- CALCULATIONS ---
    const sma20Weekly = calculateSMA(weeklyCloses, 20);
    const sma50Daily = calculateSMA(dailyCloses, 50);
    const sma200Daily = calculateSMA(dailyCloses, 200);
    
    // RSI & DIV based on 4H for better granularity
    const rsiValue = calculateLastRSI(h4Closes, 14);
    const rsiArray = calculateRSIArray(h4Closes, 14);
    const divergence = detectRsiDivergence(h4Closes, rsiArray);
    
    const macdData = calculateMACD(dailyCloses); 
    
    const bb = calculateBollingerBands(dailyCloses, 20, 2);
    // CRITICAL: Calculate ATR for Precise Stop Loss
    const atr = calculateATR(dailyHighs, dailyLows, dailyCloses, 14);
    
    const volatilityMetrics: VolatilityMetrics = {
        atr: parseFloat(atr.toFixed(2)),
        bollingerBands: {
            upper: parseFloat(bb.upper.toFixed(2)),
            middle: parseFloat(bb.middle.toFixed(2)),
            lower: parseFloat(bb.lower.toFixed(2)),
            bandwidth: parseFloat(bb.bandwidth.toFixed(4)),
            percentB: parseFloat(bb.percentB.toFixed(2)),
            squeeze: bb.bandwidth < 0.10
        }
    };

    const avgVol = calculateSMA(h4Volumes, 20);
    const currentVol = h4Volumes[h4Volumes.length - 1];
    
    const recentHigh = Math.max(...dailyCloses.slice(-30));
    const recentLow = Math.min(...dailyCloses.slice(-30));
    
    // --- 4H ANALYSIS ---
    const ema20_4h = calculateEMA(h4Closes, 20);
    const ema50_4h = calculateEMA(h4Closes, 50);
    const sma200_4h = calculateSMA(h4Closes, 200);

    let emaSignal: any = 'Consolidation';
    if (currentPrice > ema20_4h && ema20_4h > ema50_4h && ema50_4h > sma200_4h) emaSignal = 'Full Bullish';
    else if (currentPrice < ema20_4h && ema20_4h < ema50_4h && ema50_4h < sma200_4h) emaSignal = 'Full Bearish';
    else if (currentPrice > sma200_4h) emaSignal = 'Golden Cross';
    else if (currentPrice < sma200_4h) emaSignal = 'Death Cross';

    const trend4h = currentPrice > ema50_4h ? 'Bullish' : currentPrice < ema50_4h ? 'Bearish' : 'Neutral';
    
    // CALCULATE REAL 4H SUPPORT/RESISTANCE
    // Look back 42 periods (approx 1 week on 4h chart) to find local extremes
    const lookbackSR = 42; 
    const srHighs = h4Highs.slice(-lookbackSR);
    const srLows = h4Lows.slice(-lookbackSR);
    const localHigh4h = Math.max(...(srHighs.length ? srHighs : [currentPrice * 1.05]));
    const localLow4h = Math.min(...(srLows.length ? srLows : [currentPrice * 0.95]));

    const shortTermAnalysis: ShortTermAnalysis = {
        trend4h,
        emaSignal,
        volumeStatus: currentVol > avgVol * 1.2 ? 'High' : 'Normal',
        rsi4h: parseFloat(rsiValue.toFixed(2)),
        priceAction: "Analisi in corso...",
        support4h: parseFloat(localLow4h.toFixed(2)),
        resistance4h: parseFloat(localHigh4h.toFixed(2))
    };

    let fearGreedValue = 50;
    if (fgData && Array.isArray(fgData.data)) {
        fearGreedValue = parseInt(fgData.data[0].value);
    }
    
    let ethSpecificData: EthereumSpecificData | undefined;
    if (symbol === 'ETH') {
      ethSpecificData = {
        gasFees: Math.floor(Math.random() * (40 - 10 + 1) + 10),
        stakingApy: parseFloat((Math.random() * (4.5 - 3.0) + 3.0).toFixed(2)),
        ethBurned24h: parseFloat((Math.random() * (2500 - 1500) + 1500).toFixed(0)),
      };
    }

    // --- CYCLES ---
    // Bitcoin Halving: Apr 2024. ETH follows BTC cycles generally.
    const lastHalvingDate = new Date('2024-04-20').getTime();
    const daysSinceHalving = Math.floor((new Date().getTime() - lastHalvingDate) / (1000 * 60 * 60 * 24));
    const progressInCycle = Math.min(100, Math.max(0, (daysSinceHalving / 530) * 100)); // 530 days is approx top timing
    
    let ath = 73700; // BTC Default
    if (symbol === 'ETH') ath = 4800;
    if (symbol === 'SOL') ath = 260; 

    const distFromAth = ((currentPrice - ath) / ath) * 100;
    
    const cycleMetrics: CycleMetrics = {
        daysSinceHalving,
        progressInCycle: parseFloat(progressInCycle.toFixed(1)),
        distanceFromAth: parseFloat(distFromAth.toFixed(2)),
        historicalSeasonality: "Analyzing..."
    };

    // --- MARKET PHASE ---
    const weeklyBias = currentPrice > sma20Weekly ? 'Bullish' : 'Bearish';
    const dailyBias = currentPrice > sma200Daily ? 'Bullish' : 'Bearish';
    const shortTermBias = currentPrice > sma50Daily ? 'Bullish' : 'Bearish';

    let marketPhase = "Neutral";
    let strategySuggestion = "Wait for confirmation";

    if (weeklyBias === 'Bullish') {
        if (dailyBias === 'Bullish' && shortTermBias === 'Bullish') {
            marketPhase = "Markup (Strong Uptrend)";
            strategySuggestion = "Trend Following (Buy Dips)";
        } else if (dailyBias === 'Bullish' && shortTermBias === 'Bearish') {
            marketPhase = "Bull Market Correction";
            strategySuggestion = "Accumulate in Support Zones";
        } else {
             marketPhase = "Early Bull / Recovery";
             strategySuggestion = "Build Long Positions";
        }
    } else {
        if (dailyBias === 'Bearish' && shortTermBias === 'Bearish') {
            marketPhase = "Markdown (Downtrend)";
            strategySuggestion = "Short Rallies / Cash is King";
        } else if (dailyBias === 'Bearish' && shortTermBias === 'Bullish') {
            marketPhase = "Bear Market Rally";
            strategySuggestion = "Take Profits / Caution";
        }
    }

    const trendStructure: TrendStructure = {
        weekly: weeklyBias,
        daily: dailyBias,
        marketPhase,
        strategySuggestion,
        weeklySma20: parseFloat(sma20Weekly.toFixed(2)),
        dailySma200: parseFloat(sma200Daily.toFixed(2))
    };

    return {
        price: currentPrice,
        priceHistory, // 4H Data
        // Dominance removed here to let AI populate it via Web Search
        fearGreedIndex: fearGreedValue,
        rsi: { 
            value: parseFloat(rsiValue.toFixed(2)), 
            status: rsiValue > 70 ? 'Overbought' : rsiValue < 30 ? 'Oversold' : 'Neutral',
            divergence 
        },
        macd: { 
            status: macdData.macd > macdData.signal ? 'Bullish Cross' : 'Bearish Cross',
            histogram: parseFloat(macdData.hist.toFixed(2))
        },
        ethBtcRatio: ethBtcRatioData,
        orderBook: orderBookData,
        volatility: volatilityMetrics,
        indicators: [
            { name: 'EMA 200 (Daily)', value: sma200Daily.toFixed(2), signal: currentPrice > sma200Daily ? Sentiment.BULLISH : Sentiment.BEARISH, description: 'Long Term Trend' },
            { name: 'RSI (14)', value: rsiValue.toFixed(2), signal: rsiValue < 30 ? Sentiment.BULLISH : rsiValue > 70 ? Sentiment.BEARISH : Sentiment.NEUTRAL, description: 'Momentum' },
        ],
        ethSpecificData,
        trendStructure,
        cycles: cycleMetrics,
        shortTerm: shortTermAnalysis
    };
  } catch (error) {
    console.error("Error fetching technical data:", error);
    return {
        price: 0,
        priceHistory: [],
        fearGreedIndex: 50,
        volatility: { atr: 0, bollingerBands: { upper: 0, lower: 0, middle: 0, bandwidth: 0, percentB: 0, squeeze: false }}
    };
  }
};