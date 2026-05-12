
import React, { useState } from 'react';
import { TechnicalAnalysis, Sentiment } from '../types';
import { ExplanationModal } from './ExplanationModal';
import { getMacroExplanation, getFearGreedExplanation } from '../utils/explanations';

interface Props {
  data: TechnicalAnalysis;
  macroSentiment: Sentiment;
  macroOverview: string;
}

// Optimization: Defined outside component to prevent re-creation on every render
const MacroTrendIcon = ({ change }: { change?: 'up' | 'down' | 'flat' }) => {
  if (change === 'up') return <span className="text-emerald-500">▲</span>;
  if (change === 'down') return <span className="text-rose-500">▼</span>;
  return <span className="text-slate-400">=</span>;
};

export const MarketSummary: React.FC<Props> = ({ data, macroSentiment, macroOverview }) => {
  const [selectedItem, setSelectedItem] = useState<{title: string, trend: string, desc: string} | null>(null);

  const getTrendColor = (trend: string | undefined) => {
    if (!trend) return 'text-slate-500';
    const t = trend.toLowerCase();
    if (t.includes('bull') || t.includes('up') || t.includes('pos')) return 'text-emerald-600 dark:text-emerald-400';
    if (t.includes('bear') || t.includes('down') || t.includes('neg')) return 'text-rose-600 dark:text-rose-400';
    return 'text-slate-500 dark:text-slate-400';
  };

  const macroItems = [
    { label: 'S&P 500', val: data.sp500, code: 'SPX' },
    { label: 'DXY Index', val: data.dxy, code: 'DXY' },
    { label: 'Russell 2K', val: data.russell2000, code: 'RUT' },
    { label: 'WTI Oil', val: data.oil, code: 'OIL' },
    { label: 'US CPI', val: data.inflation, code: 'CPI' },
    { label: 'Unemployment', val: data.unemployment, code: 'UNEM' },
    { label: 'US GDP', val: data.gdp, code: 'GDP' },
    { label: 'M2 Supply', val: data.m2, code: 'M2' },
  ];

  const handleItemClick = (label: string, val: any) => {
    if (!val || !val.trend) return;
    setSelectedItem({
      title: label,
      trend: val.trend,
      desc: getMacroExplanation(label, val.trend)
    });
  };

  const handleFearGreedClick = () => {
    const { sentiment, text } = getFearGreedExplanation(data.fearGreedIndex);
    setSelectedItem({
      title: 'Market Sentiment',
      trend: sentiment,
      desc: text
    });
  };

  return (
    <div className="grid grid-cols-1 md:grid-cols-3 gap-8 mb-10">
      
      <ExplanationModal 
        isOpen={!!selectedItem}
        onClose={() => setSelectedItem(null)}
        title={selectedItem?.title || ''}
        sentiment={selectedItem?.trend || ''}
        content={selectedItem?.desc || ''}
      />

      {/* Macro Data Grid */}
      <div className="md:col-span-2 elegant-card p-8 flex flex-col">
           {/* Header */}
           <div className="flex justify-between items-center mb-6">
              <h2 className="text-lg font-bold text-slate-900 dark:text-white flex items-center gap-3">
                <span className="w-1.5 h-6 bg-indigo-500 rounded-full"></span>
                Macro Environment
              </h2>
              <span className={`text-xs font-bold px-4 py-1.5 rounded-full border ${macroSentiment === Sentiment.BULLISH ? 'bg-emerald-50 dark:bg-emerald-500/10 border-emerald-200 dark:border-emerald-500/30 text-emerald-600 dark:text-emerald-400' : macroSentiment === Sentiment.BEARISH ? 'bg-rose-50 dark:bg-rose-500/10 border-rose-200 dark:border-rose-500/30 text-rose-600 dark:text-rose-400' : 'bg-slate-100 dark:bg-slate-800 border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-400'}`}>
                 {macroSentiment}
              </span>
           </div>
           
           <p className="text-slate-600 dark:text-slate-400 text-sm mb-8 leading-relaxed">
             {macroOverview ? macroOverview : 'Loading macro data...'}
           </p>

           {/* Grid */}
           <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 mt-auto">
             {macroItems.map((item, idx) => (
                <button 
                  key={idx} 
                  onClick={() => handleItemClick(item.label, item.val)}
                  className="bg-slate-50 dark:bg-slate-800/50 border border-slate-100 dark:border-white/5 hover:bg-white dark:hover:bg-slate-800 hover:shadow-md hover:border-indigo-200 dark:hover:border-indigo-500/30 transition-all p-4 text-left rounded-xl group"
                  disabled={!item.val}
                >
                   <div className="flex justify-between items-start mb-2">
                      <span className="text-xs font-bold text-slate-400 dark:text-slate-500">{item.code}</span>
                      <span className="text-xs"><MacroTrendIcon change={item.val?.change24h} /></span>
                   </div>
                   <div>
                      <div className="text-lg font-bold text-slate-900 dark:text-white font-mono tracking-tight">{item.val?.price || '---'}</div>
                      <div className={`text-xs font-bold mt-1.5 ${getTrendColor(item.val?.trend)}`}>
                         {item.val?.trend ? item.val.trend.replace('ish', '') : 'N/A'}
                      </div>
                   </div>
                </button>
             ))}
           </div>
      </div>

      {/* Fear & Greed Gauge */}
      <button 
        onClick={handleFearGreedClick}
        className="elegant-card p-8 cursor-pointer group relative border-t-4 border-t-purple-500"
      >
         <div className="flex justify-between items-start mb-8">
           <h3 className="text-lg font-bold text-slate-900 dark:text-white">
              Sentiment
           </h3>
           <div className="p-2 bg-purple-50 dark:bg-purple-500/10 rounded-lg">
             <svg className="w-5 h-5 text-purple-500" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M14.828 14.828a4 4 0 01-5.656 0M9 10h.01M15 10h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
           </div>
         </div>

         <div className="flex flex-col items-center justify-center py-2">
            {/* Semi-circle Gauge (SVG for precision) */}
            <div className="relative w-48 h-24 mb-2">
               <svg viewBox="0 0 100 50" className="w-full h-full">
                  {/* Background Track */}
                  <path 
                     d="M 10 50 A 40 40 0 0 1 90 50" 
                     fill="none" 
                     stroke="currentColor" 
                     strokeWidth="12" 
                     className="text-slate-100 dark:text-slate-800"
                  />
                  {/* Progress Fill */}
                  <path 
                     d="M 10 50 A 40 40 0 0 1 90 50" 
                     fill="none" 
                     stroke="currentColor" 
                     strokeWidth="12" 
                     strokeDasharray="125.6" 
                     strokeDashoffset={125.6 - (125.6 * data.fearGreedIndex) / 100}
                     strokeLinecap="round"
                     className={`transition-all duration-1000 ${
                        data.fearGreedIndex >= 55 ? 'text-emerald-500' : 
                        data.fearGreedIndex <= 45 ? 'text-rose-500' : 
                        'text-amber-500'
                     }`}
                  />
               </svg>
            </div>
            
            <div className="text-center relative z-10">
               <span className="text-5xl font-bold text-slate-900 dark:text-white tracking-tighter">{data.fearGreedIndex}</span>
            </div>
         </div>

         <div className="mt-6 text-center">
            <span className={`inline-block px-4 py-2 rounded-lg text-xs font-bold tracking-wide uppercase ${
              data.fearGreedIndex >= 55 ? 'bg-emerald-50 dark:bg-emerald-500/10 text-emerald-600 dark:text-emerald-400' : 
              data.fearGreedIndex <= 45 ? 'bg-rose-50 dark:bg-rose-500/10 text-rose-600 dark:text-rose-400' : 
              'bg-amber-50 dark:bg-amber-500/10 text-amber-600 dark:text-amber-400'
            }`}>
              {data.fearGreedIndex < 25 ? 'Extreme Fear' : data.fearGreedIndex < 45 ? 'Fear' : data.fearGreedIndex < 55 ? 'Neutral' : data.fearGreedIndex < 75 ? 'Greed' : 'Extreme Greed'}
            </span>
         </div>
         
         <div className="mt-8 pt-4 border-t border-slate-100 dark:border-white/5 flex justify-between items-center">
             <span className="text-xs font-semibold text-slate-400">BTC Dominance</span>
             <span className="text-sm font-mono font-bold text-slate-700 dark:text-slate-200">{data.dominance}</span>
         </div>
      </button>
    </div>
  );
};
