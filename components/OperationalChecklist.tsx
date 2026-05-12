import React from 'react';
import { ChecklistItem } from '../types';

interface Props {
  checklist: ChecklistItem[];
}

export const OperationalChecklist: React.FC<Props> = ({ checklist }) => {
  return (
    <div className="elegant-card p-8 h-full flex flex-col">
       <div className="flex items-center gap-3 mb-8">
          <div className="w-1.5 h-6 bg-emerald-500 rounded-full"></div>
          <h3 className="text-sm font-bold text-slate-900 dark:text-white uppercase tracking-wide">System Diagnostics</h3>
       </div>

       <div className="space-y-4">
          {checklist?.map((item, idx) => (
             <div key={idx} className="flex items-center justify-between p-4 bg-slate-50 dark:bg-slate-800/50 rounded-xl border border-slate-100 dark:border-white/5">
                <div className="flex items-center gap-4">
                   <div className={`w-2.5 h-2.5 flex-shrink-0 rounded-full ${item.status === 'PASS' ? 'bg-emerald-500 shadow-glow shadow-emerald-500/50' : item.status === 'WARNING' ? 'bg-orange-400' : 'bg-rose-500'}`}></div>
                   <div>
                      <div className="text-xs font-bold text-slate-500 dark:text-slate-400 uppercase tracking-wider mb-0.5">{item.category}</div>
                      <div className="text-sm text-slate-800 dark:text-slate-200 font-medium">{item.details}</div>
                   </div>
                </div>
                <div className={`text-[10px] font-bold px-3 py-1.5 rounded-lg border ${item.status === 'PASS' ? 'border-emerald-200 dark:border-emerald-500/20 text-emerald-700 dark:text-emerald-400 bg-emerald-50 dark:bg-emerald-500/5' : item.status === 'WARNING' ? 'border-orange-200 dark:border-orange-500/20 text-orange-700 dark:text-orange-400 bg-orange-50 dark:bg-orange-500/5' : 'border-rose-200 dark:border-rose-500/20 text-rose-700 dark:text-rose-400 bg-rose-50 dark:bg-rose-500/5'}`}>
                   {item.status}
                </div>
             </div>
          ))}
       </div>
    </div>
  );
};