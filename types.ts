

export enum Sentiment {
  BULLISH = 'BULLISH',
  BEARISH = 'BEARISH',
  NEUTRAL = 'NEUTRAL'
}

export enum Timeframe {
  SHORT_TERM = 'Breve Termine (Intraday)',
  MID_TERM = 'Medio Termine (Swing)',
  LONG_TERM = 'Lungo Termine (HODL)'
}

export interface CalendarEvent {
  date: string;
  event: string;
  impact: 'High' | 'Medium' | 'Low';
  forecast: string;
  previous: string;
}

export interface NewsItem {
  title: string;
  source: string;
  url: string; // Optional, AI might not always get exact URL
  sentiment: 'Positive' | 'Negative' | 'Neutral';
  time: string;
}

export interface IndicatorStatus {
  name: string;
  value: string | number;
  signal: Sentiment;
  description: string;
}

export interface MacroAsset {
  price: string;
  trend: string; // Questo trend indica l'IMPATTO SU BITCOIN
  change24h?: 'up' | 'down' | 'flat';
}

export interface OrderBookAnalysis {
  bidPressure: number; // % di volume in acquisto
  askPressure: number; // % di volume in vendita
  imbalance: 'Bullish' | 'Bearish' | 'Neutral';
  wallPrice: number; // Prezzo con la liquidità maggiore
  wallType: 'Bid' | 'Ask';
  totalBidVol: number;
  totalAskVol: number;
}

export interface VolatilityMetrics {
  atr: number; // Average True Range in USD
  bollingerBands: {
    upper: number;
    middle: number;
    lower: number;
    bandwidth: number; // (Upper - Lower) / Middle
    percentB: number; // Posizione del prezzo nelle bande
    squeeze: boolean; // True se la volatilità è compressa
  };
}

export interface FlowData {
  netInflow: number; // Positive = Inflow, Negative = Outflow
  trend: 'Accumulation' | 'Distribution' | 'Neutral';
  metricType: 'ETF' | 'Exchange';
}

export interface EthereumSpecificData {
  gasFees: number; // in Gwei
  stakingApy: number; // in %
  ethBurned24h: number; // in ETH
}

export interface OnChainMetrics {
  mvrvZScore: number; // <0 Undervalued, >7 Overvalued
  nupl: number; // Net Unrealized Profit/Loss
  activeAddressesTrend: 'Rising' | 'Falling' | 'Stable';
  longTermHolderSupplyChange: 'Accumulating' | 'Distributing' | 'Stable';
}

export interface CycleMetrics {
  daysSinceHalving: number;
  progressInCycle: number; // 0-100% (0 = Halving, 100 = Projected Top)
  distanceFromAth: number; // %
  historicalSeasonality: string; // e.g., "September is historically bearish (-5% avg)"
}

export interface TrendStructure {
  weekly: 'Bullish' | 'Bearish' | 'Neutral'; // Primary Trend (SMA 20W)
  daily: 'Bullish' | 'Bearish' | 'Neutral';  // Secondary Trend (SMA 200D / 50D)
  marketPhase: string; // e.g., "Markup", "Correction", "Bear Market Rally"
  strategySuggestion: string; // e.g., "Buy Dip", "Sell Rally", "Wait"
  weeklySma20: number;
  dailySma200: number;
}

export interface ShortTermAnalysis {
  trend4h: 'Bullish' | 'Bearish' | 'Neutral';
  emaSignal: 'Full Bullish' | 'Full Bearish' | 'Golden Cross' | 'Death Cross' | 'Consolidation';
  volumeStatus: 'High' | 'Low' | 'Normal';
  rsi4h: number;
  priceAction: string; // e.g., "Forming Bull Flag", "Rejecting Resistance"
  support4h: number;
  resistance4h: number;
}

export interface Candle {
  time: string | number; // YYYY-MM-DD or Unix timestamp
  open: number;
  high: number;
  low: number;
  close: number;
}

export interface TechnicalAnalysis {
  price: number;
  priceHistory?: Candle[]; // Changed to Candle array for TradingView
  dominance: string;
  fearGreedIndex: number;
  sp500?: MacroAsset;
  dxy?: MacroAsset;
  russell2000?: MacroAsset;
  oil?: MacroAsset;
  inflation?: MacroAsset;
  unemployment?: MacroAsset;
  gdp?: MacroAsset;
  m2?: MacroAsset;
  rsi: { 
    value: number; 
    status: string;
    divergence: 'Bullish' | 'Bearish' | 'None';
  };
  macd: { 
    status: string;
    histogram: number;
  };
  ethBtcRatio: {
    value: number;
    trend: 'Bullish' | 'Bearish' | 'Neutral'; // Bullish = ETH Stronger, Bearish = BTC Stronger
    signal: string; // e.g. "BTC Dominant" or "Altseason"
  };
  openInterest: string;
  fundingRate: string;
  volumeAnalysis: string;
  keyLevels: {
    support: string[];
    resistance: string[];
  };
  indicators: IndicatorStatus[];
  orderBook: OrderBookAnalysis; 
  volatility: VolatilityMetrics;
  ethSpecificData?: EthereumSpecificData;
  exchangeNetFlow?: FlowData;
  etfNetInflow?: FlowData;
  trendStructure?: TrendStructure;
  shortTerm?: ShortTermAnalysis; // NEW ISOLATED 4H ANALYSIS
  onChain?: OnChainMetrics;
  cycles?: CycleMetrics;
}

export interface TradeSetup {
  asset: 'BTC' | 'ETH' | 'SOL';
  type: 'LONG' | 'SHORT';
  timeframe: Timeframe;
  entryZone: string;
  stopLoss: string;
  takeProfit: string[];
  rationale: string;
  riskLevel: 'Alto' | 'Medio' | 'Basso';
  confidenceScore: number; // 0-100 Score di confluenza tecnica
}

export interface ChecklistItem {
  category: string;
  status: 'PASS' | 'WARNING' | 'FAIL';
  details: string;
}

export interface ReversalScenario {
  title: string; // es: "Inversione Bullish" o "Breakout Ribassista"
  condition: string; // La condizione tecnica/macro necessaria
  keyLevel: string; // Il prezzo specifico di invalidazione
  probability: 'Alta' | 'Media' | 'Bassa';
}

export interface MarketReport {
  timestamp: string;
  macroOverview: string;
  macroSentiment: Sentiment;
  forecastOpinion: string;
  calendar: CalendarEvent[]; 
  latestNews: NewsItem[]; // New Field
  technical: TechnicalAnalysis;
  signals: TradeSetup[];
  checklist: ChecklistItem[];
  trendReversal: {
    bullishScenario: ReversalScenario;
    bearishScenario: ReversalScenario;
  };
  sources: string[];
}