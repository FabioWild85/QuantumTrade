
export const calculateSMA = (data: number[], period: number): number => {
  if (data.length < period) return 0;
  const slice = data.slice(data.length - period);
  const sum = slice.reduce((acc, val) => acc + val, 0);
  return sum / period;
};

export const calculateEMA = (data: number[], period: number): number => {
  if (data.length < period) return 0;
  const k = 2 / (period + 1);
  
  // Start with SMA for the first period
  let ema = data.slice(0, period).reduce((a, b) => a + b, 0) / period;
  
  // Calculate EMA for the rest
  for (let i = period; i < data.length; i++) {
    ema = (data[i] - ema) * k + ema;
  }
  return ema;
};

export const calculateLastRSI = (closes: number[], period: number = 14): number => {
  if (closes.length < period + 1) return 50;
  
  let gains = 0;
  let losses = 0;
  
  // Initial average gain/loss
  for (let i = 1; i <= period; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff >= 0) gains += diff;
    else losses += Math.abs(diff);
  }
  
  let avgGain = gains / period;
  let avgLoss = losses / period;
  
  // Smoothed averages
  for (let i = period + 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    const currentGain = diff > 0 ? diff : 0;
    const currentLoss = diff < 0 ? Math.abs(diff) : 0;
    
    avgGain = ((avgGain * (period - 1)) + currentGain) / period;
    avgLoss = ((avgLoss * (period - 1)) + currentLoss) / period;
  }
  
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - (100 / (1 + rs));
};

export const calculateRSIArray = (closes: number[], period: number = 14): number[] => {
  if (closes.length < period + 1) return Array(closes.length).fill(50);
  
  const rsiValues: number[] = [];
  const changes = closes.slice(1).map((c, i) => c - closes[i]);
  
  let initialGains = 0;
  let initialLosses = 0;
  
  for (let i = 0; i < period; i++) {
    if (changes[i] >= 0) initialGains += changes[i];
    else initialLosses += Math.abs(changes[i]);
  }

  let avgGain = initialGains / period;
  let avgLoss = initialLosses / period;
  
  const firstRS = avgLoss === 0 ? 100 : 100 - (100 / (1 + (avgGain / avgLoss)));
  rsiValues.push(firstRS);

  for (let i = period; i < changes.length; i++) {
    const diff = changes[i];
    const currentGain = diff >= 0 ? diff : 0;
    const currentLoss = diff < 0 ? Math.abs(diff) : 0;

    avgGain = (avgGain * (period - 1) + currentGain) / period;
    avgLoss = (avgLoss * (period - 1) + currentLoss) / period;
    
    const rs = avgLoss === 0 ? 100 : 100 - (100 / (1 + (avgGain / avgLoss)));
    rsiValues.push(rs);
  }

  const padding = Array(closes.length - rsiValues.length).fill(50);
  return [...padding, ...rsiValues];
};

export const calculateMACD = (closes: number[]) => {
  const getEMAArray = (data: number[], period: number): number[] => {
    const k = 2 / (period + 1);
    const emas: number[] = [];
    
    // Initial SMA
    let sma = 0;
    for(let i=0; i<period; i++) sma += data[i];
    sma /= period;
    
    let currentEma = sma;
    // For i < period-1, no EMA.
    for(let i=0; i<period-1; i++) emas.push(0);
    emas.push(currentEma);

    for(let i=period; i<data.length; i++) {
      currentEma = (data[i] - currentEma) * k + currentEma;
      emas.push(currentEma);
    }
    return emas;
  }

  const ema12 = getEMAArray(closes, 12);
  const ema26 = getEMAArray(closes, 26);
  
  const macdLine: number[] = [];
  for(let i=0; i<closes.length; i++) {
      macdLine.push(ema12[i] - ema26[i]);
  }
  
  const validMacdStart = 26;
  const validMacdValues = macdLine.slice(validMacdStart);
  const signalLineValues = getEMAArray(validMacdValues, 9);
  
  const currentMacd = macdLine[macdLine.length-1];
  const currentSignal = signalLineValues[signalLineValues.length-1];
  
  return { macd: currentMacd, signal: currentSignal, hist: currentMacd - currentSignal };
};

export const calculateStandardDeviation = (data: number[], period: number): number => {
  if (data.length < period) return 0;
  const slice = data.slice(data.length - period);
  const mean = slice.reduce((a, b) => a + b, 0) / period;
  const variance = slice.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / period;
  return Math.sqrt(variance);
};

export const calculateBollingerBands = (data: number[], period: number = 20, multiplier: number = 2) => {
  const middle = calculateSMA(data, period);
  const stdDev = calculateStandardDeviation(data, period);
  const upper = middle + (stdDev * multiplier);
  const lower = middle - (stdDev * multiplier);
  const currentPrice = data[data.length - 1];
  
  // Bandwidth: (Upper - Lower) / Middle. Low values indicate squeeze.
  const bandwidth = (upper - lower) / middle;
  // PercentB: Where is price relative to bands? >1 overbought, <0 oversold
  const percentB = (currentPrice - lower) / (upper - lower);
  
  return { upper, middle, lower, bandwidth, percentB };
};

export const calculateATR = (highs: number[], lows: number[], closes: number[], period: number = 14): number => {
  if (highs.length < period + 1) return 0;

  let trs: number[] = [];
  // TR is max of: H-L, abs(H-PrevClose), abs(L-PrevClose)
  for(let i = 1; i < highs.length; i++) {
    const hl = highs[i] - lows[i];
    const hpc = Math.abs(highs[i] - closes[i-1]);
    const lpc = Math.abs(lows[i] - closes[i-1]);
    trs.push(Math.max(hl, hpc, lpc));
  }

  // Simple Average of TRs for initial, or smoothed. Let's use SMA of TRs for simplicity similar to TradingView default in some settings, or RMTA.
  // Using SMA approach for ATR here:
  const currentATR = calculateSMA(trs, period);
  return currentATR;
};

/** A-07: Pearson correlation coefficient between two return series. Range -1 to +1. */
export const calculatePearsonCorrelation = (a: number[], b: number[]): number => {
  const n = Math.min(a.length, b.length);
  if (n < 5) return 0;
  const aS = a.slice(-n);
  const bS = b.slice(-n);
  const meanA = aS.reduce((s, v) => s + v, 0) / n;
  const meanB = bS.reduce((s, v) => s + v, 0) / n;
  let num = 0, dA = 0, dB = 0;
  for (let i = 0; i < n; i++) {
    const da = aS[i] - meanA;
    const db = bS[i] - meanB;
    num += da * db; dA += da * da; dB += db * db;
  }
  const denom = Math.sqrt(dA * dB);
  return denom === 0 ? 0 : parseFloat((num / denom).toFixed(3));
};