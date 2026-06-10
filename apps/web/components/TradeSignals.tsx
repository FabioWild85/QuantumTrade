import React from 'react';
import { TradeSetup } from '../types';

interface Props {
  signals: TradeSetup[];
}

export const TradeSignals: React.FC<Props> = ({ signals }) => {

  if (!signals || signals.length === 0) return null;

  return (
    <div className="mt-8">
      <h3 className="text-lg font-bold text-slate-900 dark:text-white mb-6 flex items-center gap-3">
        <span className="w-1.5 h-6 bg-indigo-500 rounded-full"></span>
        Active Trade Setups
      </h3>
      
      <div className="flex flex-col gap-6">
        {signals.map((signal, idx) => {
          const isLong = signal.type === 'LONG';
          
          return (
            <div key={idx} className="elegant-card p-0 overflow-hidden group border border-slate-200 dark:border-white/5 hover:border-indigo-300 dark:hover:border-indigo-500/30 transition-all shadow-sm">
               {/* Signal Header - STACKED ON MOBILE for layout safety */}
               <div className={`px-6 py-4 flex flex-col md:flex-row justify-between items-start md:items-center gap-4 ${isLong ? 'bg-emerald-50 dark:bg-emerald-500/10' : 'bg-rose-50 dark:bg-rose-500/10'} border-b ${isLong ? 'border-emerald-100 dark:border-emerald-500/20' : 'border-rose-100 dark:border-rose-500/20'}`}>
                   
                   {/* Left: Badge + Timeframe */}
                   <div className="flex items-center gap-3 w-full md:w-auto justify-between md:justify-start">
                       <span className={`text-sm font-bold px-3 py-1 rounded-md uppercase tracking-wide whitespace-nowrap ${isLong ? 'bg-emerald-500 text-white' : 'bg-rose-500 text-white'}`}>
                           {signal.type} {signal.asset}
                       </span>
                       <span className="text-xs font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-widest pl-2 border-l border-slate-300 dark:border-white/10">
                           {signal.timeframe}
                       </span>
                   </div>

                    {/* Right: Confidence + R:R */}
                   <div className="flex items-center gap-4 w-full md:w-auto border-t md:border-t-0 border-slate-200 dark:border-white/5 pt-3 md:pt-0">
                       <div className="flex items-center gap-2">
                           <span className="text-[10px] font-bold text-slate-400 uppercase whitespace-nowrap">Confidence</span>
                           <div className="flex-1 md:flex-none w-24 h-2 bg-white dark:bg-black/20 rounded-full overflow-hidden">
                               <div className={`h-full ${isLong ? 'bg-emerald-500' : 'bg-rose-500'}`} style={{ width: `${signal.confidenceScore}%` }}></div>
                           </div>
                           <span className={`text-xs font-bold ${isLong ? 'text-emerald-600 dark:text-emerald-400' : 'text-rose-600 dark:text-rose-400'}`}>{signal.confidenceScore}%</span>
                       </div>
                       {signal.riskReward && signal.riskReward !== 'N/A' && (
                         <div className="flex items-center gap-1.5 px-2 py-1 bg-white/60 dark:bg-black/20 rounded-lg border border-slate-200 dark:border-white/10">
                           <span className="text-[10px] font-bold text-slate-400 uppercase">R:R</span>
                           <span className={`text-xs font-bold font-mono ${parseFloat(signal.riskReward) >= 2 ? 'text-emerald-600 dark:text-emerald-400' : 'text-orange-600 dark:text-orange-400'}`}>
                             {signal.riskReward}
                           </span>
                         </div>
                       )}
                   </div>
               </div>

               <div className="p-6 md:p-8">
                   
                   {/* Rationale */}
                   <div className="mb-8">
                       <h4 className="text-xs font-bold text-slate-400 uppercase mb-2">Strategy Rationale</h4>
                       <p className="text-sm text-slate-700 dark:text-slate-300 leading-relaxed font-medium">
                           {signal.rationale}
                       </p>
                   </div>

                   {/* Execution Grid */}
                   <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mb-8">
                       <div className="p-4 rounded-xl bg-slate-50 dark:bg-slate-800/50 border border-slate-100 dark:border-white/5">
                           <div className="flex items-center gap-2 mb-1">
                               <div className="w-2 h-2 rounded-full bg-blue-500"></div>
                               <span className="text-xs font-bold text-slate-400 uppercase">Entry Zone</span>
                           </div>
                           <span className="text-lg font-mono font-bold text-slate-900 dark:text-white">{signal.entryZone}</span>
                       </div>

                       <div className="p-4 rounded-xl bg-slate-50 dark:bg-slate-800/50 border border-slate-100 dark:border-white/5">
                           <div className="flex items-center gap-2 mb-1">
                               <div className="w-2 h-2 rounded-full bg-rose-500"></div>
                               <span className="text-xs font-bold text-slate-400 uppercase">Stop Loss</span>
                           </div>
                           <span className="text-lg font-mono font-bold text-rose-600 dark:text-rose-400">{signal.stopLoss}</span>
                       </div>

                       <div className="p-4 rounded-xl bg-slate-50 dark:bg-slate-800/50 border border-slate-100 dark:border-white/5">
                           <div className="flex items-center gap-2 mb-1">
                               <div className={`w-2 h-2 rounded-full ${signal.riskReward && parseFloat(signal.riskReward) >= 2 ? 'bg-emerald-500' : 'bg-orange-500'}`}></div>
                               <span className="text-xs font-bold text-slate-400 uppercase">Risk / Reward</span>
                           </div>
                           <span className="text-lg font-mono font-bold text-slate-900 dark:text-white">
                             {signal.riskReward || signal.riskLevel}
                           </span>
                           {signal.riskReward && signal.riskReward !== 'N/A' && (
                             <div className={`text-[10px] font-bold mt-1 ${parseFloat(signal.riskReward) >= 2 ? 'text-emerald-500' : 'text-orange-500'}`}>
                               {parseFloat(signal.riskReward) >= 2 ? '✓ Favorable ratio' : '⚠ Below 2:1 min'}
                             </div>
                           )}
                       </div>
                   </div>

                   {/* Targets */}
                   <div>
                       <span className="text-xs font-bold text-slate-400 uppercase block mb-3">Profit Targets</span>
                       <div className="flex flex-wrap gap-3">
                           {signal.takeProfit?.map((tp, i) => (
                               <div key={i} className={`flex items-center gap-2 px-4 py-2 rounded-lg border ${isLong ? 'bg-emerald-50 dark:bg-emerald-500/5 border-emerald-100 dark:border-emerald-500/20 text-emerald-700 dark:text-emerald-400' : 'bg-rose-50 dark:bg-rose-500/5 border-rose-100 dark:border-rose-500/20 text-rose-700 dark:text-rose-400'}`}>
                                   <span className="text-[10px] font-bold opacity-60">TP {i+1}</span>
                                   <span className="text-sm font-mono font-bold">{tp}</span>
                               </div>
                           ))}
                       </div>
                   </div>

               </div>
            </div>
          );
        })}
      </div>
    </div>
  );
};