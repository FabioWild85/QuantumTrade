import React from 'react';
import { ReversalScenario } from '../types';

interface Props {
  bullish: ReversalScenario;
  bearish: ReversalScenario;
}

export const TrendReversal: React.FC<Props> = ({ bullish, bearish }) => {
  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-8 mb-10 animate-slide-up" style={{ animationDelay: '0.2s' }}>
      {/* Bullish Scenario */}
      <div className="elegant-card p-8 border-t-4 border-t-emerald-500 bg-gradient-to-b from-emerald-50/50 to-white dark:from-emerald-900/10 dark:to-[#151E32]">
          <div className="flex items-center gap-3 mb-6">
            <div className="p-2 rounded-lg bg-emerald-100 dark:bg-emerald-500/20 text-emerald-600 dark:text-emerald-400">
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 7h8m0 0v8m0-8l-8 8-4-4-6 6" /></svg>
            </div>
            <h3 className="text-sm font-bold text-emerald-600 dark:text-emerald-400 uppercase tracking-widest">Bullish Case</h3>
          </div>
          
          <h4 className="text-xl font-bold text-slate-900 dark:text-white mb-3">{bullish.title}</h4>
          <p className="text-sm text-slate-600 dark:text-slate-400 mb-8 leading-relaxed">{bullish.condition}</p>
          
          <div className="flex items-center justify-between pt-6 border-t border-emerald-100 dark:border-emerald-500/20">
             <div>
               <span className="text-xs text-slate-400 font-bold uppercase block mb-1">Activation Level</span>
               <span className="text-base font-mono font-bold text-slate-900 dark:text-white">{bullish.keyLevel}</span>
             </div>
             <div className="text-right">
               <span className="text-xs text-slate-400 font-bold uppercase block mb-1">Probability</span>
               <span className="text-base font-bold text-emerald-600 dark:text-emerald-400">{bullish.probability}</span>
             </div>
          </div>
      </div>

      {/* Bearish Scenario */}
      <div className="elegant-card p-8 border-t-4 border-t-rose-500 bg-gradient-to-b from-rose-50/50 to-white dark:from-rose-900/10 dark:to-[#151E32]">
          <div className="flex items-center gap-3 mb-6">
            <div className="p-2 rounded-lg bg-rose-100 dark:bg-rose-500/20 text-rose-600 dark:text-rose-400">
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 17h8m0 0V9m0 8l-8-8-4 4-6-6" /></svg>
            </div>
            <h3 className="text-sm font-bold text-rose-600 dark:text-rose-400 uppercase tracking-widest">Bearish Case</h3>
          </div>
          
          <h4 className="text-xl font-bold text-slate-900 dark:text-white mb-3">{bearish.title}</h4>
          <p className="text-sm text-slate-600 dark:text-slate-400 mb-8 leading-relaxed">{bearish.condition}</p>
          
          <div className="flex items-center justify-between pt-6 border-t border-rose-100 dark:border-rose-500/20">
             <div>
               <span className="text-xs text-slate-400 font-bold uppercase block mb-1">Invalidation Level</span>
               <span className="text-base font-mono font-bold text-slate-900 dark:text-white">{bearish.keyLevel}</span>
             </div>
             <div className="text-right">
               <span className="text-xs text-slate-400 font-bold uppercase block mb-1">Probability</span>
               <span className="text-base font-bold text-rose-600 dark:text-rose-400">{bearish.probability}</span>
             </div>
          </div>
      </div>
    </div>
  );
};