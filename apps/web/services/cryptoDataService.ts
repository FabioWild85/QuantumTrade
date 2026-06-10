import { TechnicalAnalysis, OrderBookAnalysis, VolatilityMetrics, EthereumSpecificData, TrendStructure, CycleMetrics, ShortTermAnalysis, Sentiment, Candle, MacroAsset } from '../types';
import { calculateLastRSI, calculateRSIArray, calculateEMA, calculateMACD, calculateSMA, calculateBollingerBands, calculateATR, calculatePearsonCorrelation } from '../utils/indicators';

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

// Yahoo Finance unofficial API — free, no key, CORS-safe, covers indices + forex + commodities
const fetchYahooMacro = async (ticker: string): Promise<{ price: number; changePercent: number; history: number[] } | null> => {
  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?interval=1d&range=2mo`;
    const res = await fetch(url, { headers: { Accept: 'application/json' } });
    if (!res.ok) return null;
    const data = await res.json();
    const result = data?.chart?.result?.[0];
    if (!result) return null;
    const price: number = result.meta?.regularMarketPrice;
    const prevClose: number = result.meta?.previousClose ?? result.meta?.chartPreviousClose ?? price;
    const changePercent = prevClose ? ((price - prevClose) / prevClose) * 100 : 0;
    const history: number[] = (result.indicators?.quote?.[0]?.close ?? []).filter((v: number | null) => v != null);
    return { price, changePercent, history };
  } catch {
    return null;
  }
};

// CoinGecko symbol → coin ID mapping
const COINGECKO_IDS: Record<string, string> = {
  BTC: 'bitcoin',
  ETH: 'ethereum',
  SOL: 'solana',
};

export const getTechnicalData = async (symbol: 'BTC' | 'ETH' | 'SOL'): Promise<Partial<TechnicalAnalysis>> => {
  const pair = `${symbol}USDT`;
  
  try {
    // PARALLEL FETCHING: Significant speed improvement
    // INCREASED LIMIT TO 1000 for 4h to ensure history for chart and SMA calculations
    const [weeklyData, dailyData, h4Data, ethBtcRaw, depth, fgData, cgCoinData, cgGlobalData, oiData, fundingData] = await Promise.all([
        safeFetchJson(`https://api.binance.com/api/v3/klines?symbol=${pair}&interval=1w&limit=52`),
        safeFetchJson(`https://api.binance.com/api/v3/klines?symbol=${pair}&interval=1d&limit=200`),
        safeFetchJson(`https://api.binance.com/api/v3/klines?symbol=${pair}&interval=4h&limit=1000`),
        safeFetchJson(`https://api.binance.com/api/v3/klines?symbol=ETHBTC&interval=1d&limit=50`),
        safeFetchObject(`https://api.binance.com/api/v3/depth?symbol=${pair}&limit=50`),
        safeFetchObject('https://api.alternative.me/fng/'),
        // P-01: CoinGecko — ATH in tempo reale
        safeFetchObject(`https://api.coingecko.com/api/v3/coins/${COINGECKO_IDS[symbol]}?localization=false&tickers=false&market_data=true&community_data=false&developer_data=false`),
        // P-01: CoinGecko Global — Dominance in tempo reale
        safeFetchObject('https://api.coingecko.com/api/v3/global'),
        // P-04: Binance Futures — Open Interest
        safeFetchObject(`https://fapi.binance.com/fapi/v1/openInterest?symbol=${pair}`),
        // P-04: Binance Futures — Funding Rate
        safeFetchObject(`https://fapi.binance.com/fapi/v1/premiumIndex?symbol=${pair}`),
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
    if (Array.isArray(ethBtcRaw) && ethBtcRaw.length > 0) {
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
            wallType: maxAskVol > maxBidVol ? 'Ask' : 'Bid',
            maxBidWall: { price: maxBidPrice, volume: maxBidVol },
            maxAskWall: { price: maxAskPrice, volume: maxAskVol }
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
    
    // ── P-03: ETH Ecosystem — Blockchair (gas + burn) + Lido (staking APY) ──────
    let ethSpecificData: EthereumSpecificData | undefined;
    if (symbol === 'ETH') {
      let gasFees = 0;
      let stakingApy = 0;
      let ethBurned24h = 0;

      await Promise.allSettled([
        // Blockchair: gas estimate + burn 24h — free, no key
        (async () => {
          const res = await fetch('https://api.blockchair.com/ethereum/stats');
          const data = await res.json();
          const d = data?.data;
          if (d) {
            // Gas in Gwei: derive from avg simple tx fee (21000 gas) or use suggested
            const suggested = d.suggested_transaction_fee_gwei_options?.fast ?? 0;
            if (suggested > 0) {
              gasFees = suggested;
            } else if (d.average_simple_transaction_fee_24h > 0) {
              gasFees = parseFloat((d.average_simple_transaction_fee_24h / 21000 / 1e9).toFixed(2));
            }
            // Burn 24h in wei → ETH
            const burnWei: number = d.burned_24h ?? 0;
            if (burnWei > 0) ethBurned24h = Math.round(burnWei / 1e18);
          }
        })(),

        // Lido: staking APY — free, no key, real-time
        (async () => {
          const res = await fetch('https://eth-api.lido.fi/v1/protocol/steth/apr/last');
          const data = await res.json();
          if (data?.data?.apr != null) {
            stakingApy = parseFloat(data.data.apr.toFixed(2));
          }
        })(),
      ]);

      ethSpecificData = { gasFees, stakingApy, ethBurned24h };
      console.log('[P-03] ETH ecosystem data:', { gasFees, stakingApy, ethBurned24h });
    }

    // --- CYCLES ---
    // Bitcoin Halving: Apr 2024. ETH follows BTC cycles generally.
    const lastHalvingDate = new Date('2024-04-20').getTime();
    const daysSinceHalving = Math.floor((new Date().getTime() - lastHalvingDate) / (1000 * 60 * 60 * 24));
    const progressInCycle = Math.min(100, Math.max(0, (daysSinceHalving / 530) * 100)); // 530 days is approx top timing
    
    // ── P-01: CoinGecko — ATH reale e Dominance ──────────────────────────────
    let ath = symbol === 'BTC' ? 73700 : symbol === 'ETH' ? 4800 : 260; // fallback statico
    let dominance = 'N/A';
    if (cgCoinData?.market_data?.ath?.usd) {
      ath = cgCoinData.market_data.ath.usd;
    }
    if (cgGlobalData?.data?.market_cap_percentage) {
      const key = symbol.toLowerCase();
      const pct = cgGlobalData.data.market_cap_percentage[key];
      if (pct != null) dominance = `${parseFloat(pct).toFixed(1)}%`;
    }

    // ── P-04: Binance Futures — Open Interest e Funding Rate ──────────────────
    // FIX: always express OI in USD for visual consistency across BTC/ETH/SOL.
    // The fapi /openInterest endpoint returns OI denominated in the base asset
    // (e.g. BTC for BTCUSDT), so multiply by currentPrice to get USD notional.
    let openInterest = 'N/A';
    let fundingRate = 'N/A';
    if (oiData?.openInterest && currentPrice > 0) {
      const oiUsd = parseFloat(oiData.openInterest) * currentPrice;
      openInterest = oiUsd >= 1_000_000_000
        ? `$${(oiUsd / 1_000_000_000).toFixed(2)}B`
        : `$${(oiUsd / 1_000_000).toFixed(0)}M`;
    }
    if (fundingData?.lastFundingRate) {
      const rate = parseFloat(fundingData.lastFundingRate) * 100;
      fundingRate = `${rate >= 0 ? '+' : ''}${rate.toFixed(4)}%`;
    }

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

    // ── A-01: Confluence Score (0-100) ────────────────────────────────────────
    // Aggregates all technical signals into a single directional score.
    // 0 = Strong Bearish, 50 = Neutral, 100 = Strong Bullish
    const computeConfluence = (): number => {
      let score = 0;
      // Weekly trend — primary, highest weight
      score += weeklyBias === 'Bullish' ? 30 : 0;
      // Daily trend — secondary
      score += dailyBias === 'Bullish' ? 20 : 0;
      // 4H EMA structure
      if      (emaSignal === 'Full Bullish')  score += 20;
      else if (emaSignal === 'Golden Cross')   score += 12;
      else if (emaSignal === 'Consolidation') score += 10;
      else if (emaSignal === 'Death Cross')    score += 4;
      // RSI momentum
      if      (rsiValue < 30)  score += 15; // oversold → bullish opportunity
      else if (rsiValue < 45)  score += 10;
      else if (rsiValue <= 55) score += 7;
      else if (rsiValue <= 70) score += 3;
      // RSI divergence bonus
      if (divergence === 'Bullish') score += 8;
      else if (divergence === 'None') score += 4;
      // MACD histogram direction
      score += macdData.hist > 0 ? 5 : 0;
      // Order book imbalance
      if      (orderBookData.imbalance === 'Bullish') score += 2;
      else if (orderBookData.imbalance === 'Neutral') score += 1;
      // Max possible = 100. Clamp to [0, 100].
      return Math.min(100, Math.max(0, score));
    };
    const confluenceScore = computeConfluence();

    // ── A-03: ATR Volatility Heatmap ──────────────────────────────────────────
    // Compare current 14-day ATR to the 30-period average of ATR to classify vol regime
    const buildATRArray = (h: number[], l: number[], c: number[], p = 14): number[] => {
      const out: number[] = [];
      for (let i = p; i < c.length; i++) {
        let sum = 0;
        for (let j = i - p + 1; j <= i; j++) {
          sum += Math.max(h[j] - l[j], Math.abs(h[j] - c[j-1] || 0), Math.abs(l[j] - c[j-1] || 0));
        }
        out.push(sum / p);
      }
      return out;
    };
    const atrHistory = buildATRArray(dailyHighs, dailyLows, dailyCloses);
    // FIX: exclude the most recent ATR from the baseline average so atrRatio
    // measures the *current* ATR vs the previous 30-day window, not vs itself.
    const baselineSlice = atrHistory.length > 30 ? atrHistory.slice(-31, -1) : atrHistory.slice(0, -1);
    const avgAtr30 = baselineSlice.length > 0
      ? baselineSlice.reduce((s, v) => s + v, 0) / baselineSlice.length
      : atr;
    const atrRatio = avgAtr30 > 0 ? parseFloat((atr / avgAtr30).toFixed(2)) : 1;
    const volatilityHeatmap: VolatilityMetrics['volatilityHeatmap'] =
      atrRatio >= 2.0 ? 'Explosive' : atrRatio >= 1.3 ? 'High' : atrRatio >= 0.7 ? 'Normal' : 'Compressed';
    volatilityMetrics.atrRatio = atrRatio;
    volatilityMetrics.volatilityHeatmap = volatilityHeatmap;

    // ── A-04: Liquidation Level Estimates ─────────────────────────────────────
    // Mathematical approximation: leverage clusters at 10x, 20x, 50x from current price
    const leverages = ['50x', '20x', '10x'];
    const bullLiqs = [
      (currentPrice * 0.980).toFixed(0), // 50x longs liquidated at -2%
      (currentPrice * 0.952).toFixed(0), // 20x longs at -4.8%
      (currentPrice * 0.909).toFixed(0), // 10x longs at -9.1%
    ];
    const bearLiqs = [
      (currentPrice * 1.020).toFixed(0), // 50x shorts at +2%
      (currentPrice * 1.048).toFixed(0), // 20x shorts at +4.8%
      (currentPrice * 1.091).toFixed(0), // 10x shorts at +9.1%
    ];
    const liquidationLevels = { bullLiqs, bearLiqs, leverages };

    // ── A-07: BTC-ETH 30-day Return Correlation ───────────────────────────────
    // FIX: previous version mixed two arrays of different lengths (ETHBTC=50,
    // BTCUSD=200) using the same index → temporally unaligned series → noise.
    // New approach: align by tail (most recent N days) since both Binance
    // klines feeds end at the same timestamp when fetched simultaneously.
    const ethBtcClosesAll = (ethBtcRaw || []).map((c: any[]) => parseFloat(c[4]));
    let btcEthCorrelation: number | undefined;
    const N = 30;
    if (ethBtcClosesAll.length >= N + 1 && dailyCloses.length >= N + 1) {
      // Take the last N+1 closes from each series (already time-aligned by tail).
      const btcTail = dailyCloses.slice(-(N + 1));
      const ratioTail = ethBtcClosesAll.slice(-(N + 1));
      // Reconstruct ETHUSD = (ETH/BTC) * BTCUSD on the same dates.
      // Works regardless of `symbol`: we always correlate BTCUSD vs ETHUSD.
      const ethUsdTail = ratioTail.map((r, i) => r * btcTail[i]);
      const btcReturns: number[] = [];
      const ethReturns: number[] = [];
      for (let i = 1; i < btcTail.length; i++) {
        if (btcTail[i - 1] > 0 && ethUsdTail[i - 1] > 0) {
          btcReturns.push((btcTail[i] - btcTail[i - 1]) / btcTail[i - 1]);
          ethReturns.push((ethUsdTail[i] - ethUsdTail[i - 1]) / ethUsdTail[i - 1]);
        }
      }
      if (btcReturns.length >= 5) {
        btcEthCorrelation = calculatePearsonCorrelation(btcReturns, ethReturns);
      }
    }

    // ── P-02: Macro Prices — Yahoo Finance (primary, free, no key) + FMP (fallback) ──
    let fmpSp500: MacroAsset | undefined;
    let fmpDxy: MacroAsset | undefined;
    let fmpOil: MacroAsset | undefined;
    let fmpRussell: MacroAsset | undefined;
    let macroCorrelation: { sp500: number, dxy: number } | undefined;

    const yahooToMacro = (data: { price: number; changePercent: number } | null, invertTrend = false): MacroAsset | undefined => {
      if (!data?.price) return undefined;
      const up = data.changePercent > 0;
      return {
        price: data.price.toLocaleString(),
        trend: invertTrend ? (up ? 'BEARISH' : 'BULLISH') : (up ? 'BULLISH' : 'BEARISH'),
        change24h: up ? 'up' : 'down',
      };
    };

    try {
      // Fetch all four macro assets in parallel from Yahoo Finance
      const [spData, dxData, clData, rutData] = await Promise.all([
        fetchYahooMacro('^GSPC'),      // S&P 500
        fetchYahooMacro('DX-Y.NYB'),   // US Dollar Index
        fetchYahooMacro('CL=F'),       // WTI Crude Oil (front-month futures)
        fetchYahooMacro('^RUT'),       // Russell 2000
      ]);

      fmpSp500   = yahooToMacro(spData);
      fmpDxy     = yahooToMacro(dxData, true);
      fmpOil     = yahooToMacro(clData, true);
      fmpRussell = yahooToMacro(rutData);

      // A-08: Macro Correlation using Yahoo Finance historical closes
      if (spData?.history && spData.history.length > 0 && dxData?.history && dxData.history.length > 0 && dailyData.length >= 31) {
        const toReturns = (prices: number[]) => {
          const rets = [];
          for (let i = 1; i < prices.length; i++) rets.push((prices[i] - prices[i-1]) / prices[i-1]);
          return rets;
        };

        const btcRets = [];
        for (let i = dailyData.length - 31; i < dailyData.length; i++) {
          const p1 = parseFloat(dailyData[i-1][4]);
          const p2 = parseFloat(dailyData[i][4]);
          btcRets.push((p2 - p1) / p1);
        }

        const spRets  = toReturns(spData.history.slice(-32));
        const dxRets  = toReturns(dxData.history.slice(-32));
        const minLen  = Math.min(btcRets.length, spRets.length, dxRets.length);
        if (minLen >= 5) {
          macroCorrelation = {
            sp500: calculatePearsonCorrelation(btcRets.slice(-minLen), spRets.slice(-minLen)),
            dxy:   calculatePearsonCorrelation(btcRets.slice(-minLen), dxRets.slice(-minLen)),
          };
          console.log('[A-08] Macro Correlation (Yahoo):', macroCorrelation);
        } else {
          console.warn('[A-08] Not enough data for correlation. minLen:', minLen);
        }
      } else {
        console.warn('[A-08] Missing Yahoo historical data for correlation. SPX:', spData?.history?.length, 'DXY:', dxData?.history?.length);
      }

      console.log('[P-02] Yahoo Finance macro loaded. SP500:', fmpSp500?.price, 'DXY:', fmpDxy?.price);
    } catch (e) {
      console.warn('[P-02] Yahoo Finance macro fetch failed:', e);

      // Fallback: FMP via backend proxy (la chiave resta lato server)
      try {
        const apiBase = import.meta.env.DEV ? 'http://localhost:8000' : '/api';
        const fmpData: any[] = await safeFetchJson(`${apiBase}/macro/fmp`);
        if (Array.isArray(fmpData) && fmpData.length === 4) {
          const fmpToMacro = (data: any, invertTrend = false): MacroAsset | undefined => {
            const q = Array.isArray(data) ? data[0] : data;
            if (!q?.price) return undefined;
            const up = (q.changesPercentage ?? 0) > 0;
            return {
              price: q.price.toLocaleString(),
              trend: invertTrend ? (up ? 'BEARISH' : 'BULLISH') : (up ? 'BULLISH' : 'BEARISH'),
              change24h: up ? 'up' : 'down',
            };
          };
          const [spRaw, dxRaw, clRaw, rutRaw] = fmpData;
          fmpSp500   = fmpToMacro(spRaw);
          fmpDxy     = fmpToMacro(dxRaw, true);
          fmpOil     = fmpToMacro(clRaw, true);
          fmpRussell = fmpToMacro(rutRaw);
          console.log('[P-02] FMP macro fallback loaded.');
        }
      } catch (e2) {
        console.warn('[P-02] FMP fallback also failed:', e2);
      }
    }

    return {
        price: currentPrice,
        priceHistory,
        dominance,               // P-01: Real dominance from CoinGecko
        fearGreedIndex: fearGreedValue,
        openInterest,            // P-04: Real OI from Binance Futures
        fundingRate,             // P-04: Real Funding Rate from Binance Futures
        volumeAnalysis: currentVol > avgVol * 1.5 ? 'High Volume (+50% avg)' : currentVol > avgVol * 1.2 ? 'Above Average' : 'Normal',
        confluenceScore,         // A-01: Multi-TF Confluence Score
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
        keyLevels: { support: [], resistance: [] }, // populated by AI
        indicators: [
            { name: 'EMA 200 (Daily)', value: sma200Daily.toFixed(2), signal: currentPrice > sma200Daily ? Sentiment.BULLISH : Sentiment.BEARISH, description: 'Long Term Trend' },
            { name: 'RSI (14 — 4H)',  value: rsiValue.toFixed(2), signal: rsiValue < 30 ? Sentiment.BULLISH : rsiValue > 70 ? Sentiment.BEARISH : Sentiment.NEUTRAL, description: 'Momentum' },
            { name: 'MACD (Daily)', value: macdData.hist.toFixed(2), signal: macdData.hist > 0 ? Sentiment.BULLISH : Sentiment.BEARISH, description: 'Trend Momentum' },
            { name: 'BB Squeeze', value: volatilityMetrics.bollingerBands.squeeze ? 'Active' : 'None', signal: volatilityMetrics.bollingerBands.squeeze ? Sentiment.NEUTRAL : Sentiment.NEUTRAL, description: 'Volatility Compression' },
        ],
        ethSpecificData,
        trendStructure,
        cycles: cycleMetrics,
        shortTerm: shortTermAnalysis,
        liquidationLevels,   // A-04
        btcEthCorrelation,   // A-07
        // P-02: Real macro from FMP (only when API key is set)
        ...(fmpSp500   && { sp500:       fmpSp500 }),
        ...(fmpDxy     && { dxy:         fmpDxy }),
        ...(fmpOil     && { oil:         fmpOil }),
        ...(fmpRussell && { russell2000: fmpRussell }),
        macroCorrelation,
    };
  } catch (error) {
    console.error("Error fetching technical data:", error);
    return {
        price: 0,
        priceHistory: [],
        fearGreedIndex: 50,
        volatility: { atr: 0, bollingerBands: { upper: 0, lower: 0, middle: 0, bandwidth: 0, percentB: 0, squeeze: false }},
        cycles: { daysSinceHalving: 0, progressInCycle: 0, distanceFromAth: 0, historicalSeasonality: "N/A" },
        shortTerm: undefined
    };
  }
};