import React, { useMemo } from 'react';
import { MarketReport, Sentiment } from '../types';

interface Props {
  report: MarketReport;
}

export const MarketSynthesis: React.FC<Props> = ({ report }) => {
  
  const calculateMarketState = () => {
    let score = 50; 
    let reasons: string[] = [];

    if (report.macroSentiment === Sentiment.BULLISH) { score += 15; reasons.push("Macro Favorable"); } 
    else if (report.macroSentiment === Sentiment.BEARISH) { score -= 15; reasons.push("Macro Headwinds"); }

    const ema = report.technical.indicators.find(i => i.name.includes('EMA 200'));
    if (ema?.signal === Sentiment.BULLISH) { score += 15; reasons.push("Above EMA 200"); } 
    else if (ema?.signal === Sentiment.BEARISH) { score -= 15; reasons.push("Below EMA 200"); }

    if (report.technical.macd.status.includes('Bullish')) score += 5; else score -= 5;
    if (report.technical.rsi.value < 30) score += 5; 
    if (report.technical.rsi.value > 75) score -= 5;

    if (report.technical.orderBook?.imbalance === 'Bullish') score += 5;
    else if (report.technical.orderBook?.imbalance === 'Bearish') score -= 5;

    const avgConfidence = report.signals.reduce((acc, curr) => acc + curr.confidenceScore, 0) / (report.signals.length || 1);
    const signalDirection = report.signals[0]?.type === 'LONG' ? 1 : -1;
    score += (avgConfidence > 70 ? 5 : 0) * signalDirection;

    score = Math.min(100, Math.max(0, score));

    return { score, reasons };
  };

  const { score, reasons } = useMemo(calculateMarketState, [report]);

  const getConfig = (s: number) => {
    if (s >= 75) return {
        label: "Strong Bullish",
        subLabel: "High conviction uptrend detected",
        text: "text-emerald-600 dark:text-emerald-400",
        bar: "bg-emerald-500",
        bg: "bg-emerald-50 dark:bg-emerald-500/10",
        border: "border-emerald-100 dark:border-emerald-500/20"
    };
    if (s >= 60) return {
        label: "Bullish Trend",
        subLabel: "Positive momentum building",
        text: "text-emerald-500 dark:text-emerald-400",
        bar: "bg-emerald-400",
        bg: "bg-emerald-50 dark:bg-emerald-500/5",
        border: "border-emerald-100 dark:border-emerald-500/20"
    };
    if (s <= 25) return {
        label: "Strong Bearish",
        subLabel: "High conviction downtrend detected",
        text: "text-rose-600 dark:text-rose-400",
        bar: "bg-rose-500",
        bg: "bg-rose-50 dark:bg-rose-500/10",
        border: "border-rose-100 dark:border-rose-500/20"
    };
    if (s <= 40) return {
        label: "Bearish Trend",
        subLabel: "Negative structure prevailing",
        text: "text-rose-500 dark:text-rose-400",
        bar: "bg-rose-400",
        bg: "bg-rose-50 dark:bg-rose-500/5",
        border: "border-rose-100 dark:border-rose-500/20"
    };
    return {
        label: "Neutral Market",
        subLabel: "No clear direction confirmed",
        text: "text-blue-600 dark:text-blue-400",
        bar: "bg-blue-500",
        bg: "bg-blue-50 dark:bg-blue-500/5",
        border: "border-blue-100 dark:border-blue-500/20"
    };
  };

  const config = getConfig(score);

  return (
    <div className={`elegant-card w-full mb-10 animate-slide-up ${config.bg} ${config.border} border`}>
      <div className="p-8 flex flex-col md:flex-row items-center justify-between gap-10">
        
        {/* Left: Text */}
        <div className="flex-1 text-center md:text-left">
           <h2 className="text-xs font-bold text-slate-500 dark:text-slate-400 uppercase tracking-widest mb-3">Market Synthesis</h2>
           <h1 className={`text-4xl md:text-5xl font-bold tracking-tight mb-2 ${config.text}`}>
             {config.label}
           </h1>
           <p className="text-slate-600 dark:text-slate-300 mb-6 font-medium">
             {config.subLabel}
           </p>
           
           <div className="flex flex-wrap justify-center md:justify-start gap-2">
              {reasons.map((reason, idx) => (
                  <span key={idx} className="px-3 py-1.5 rounded-lg bg-white dark:bg-slate-800 border border-slate-200 dark:border-white/5 text-xs font-semibold text-slate-600 dark:text-slate-300 shadow-sm">
                    {reason}
                  </span>
              ))}
           </div>
        </div>

        {/* Right: Visualization */}
        <div className="w-full md:w-80 flex flex-col items-center md:items-end">
             <div className="flex justify-between w-full mb-3">
                <span className="text-xs font-bold text-rose-500 dark:text-rose-400">BEARISH</span>
                <span className={`text-3xl font-bold font-mono ${config.text}`}>{score}</span>
                <span className="text-xs font-bold text-emerald-600 dark:text-emerald-400">BULLISH</span>
             </div>
             
             <div className="w-full h-4 bg-white dark:bg-slate-800 rounded-full overflow-hidden border border-slate-200 dark:border-white/5 shadow-inner">
                <div 
                   className={`h-full rounded-full transition-all duration-1000 ease-out ${config.bar} shadow-lg`}
                   style={{ width: `${score}%` }}
                ></div>
             </div>
             
             <div className="mt-3 text-xs font-medium text-slate-400">
                Confidence Index (0-100)
             </div>
        </div>

      </div>
    </div>
  );
};