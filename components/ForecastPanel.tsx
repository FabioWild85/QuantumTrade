import React from 'react';

interface Props {
  opinion: string;
}

export const ForecastPanel: React.FC<Props> = ({ opinion }) => {
  return (
    <div className="mt-12 animate-slide-up">
      <div className="elegant-card p-8 border-l-4 border-l-indigo-500 bg-gradient-to-r from-indigo-50/50 to-white dark:from-indigo-900/10 dark:to-transparent">
          <h3 className="text-xs font-bold text-indigo-600 dark:text-indigo-400 uppercase tracking-widest mb-4">AI Strategic Forecast</h3>
          <p className="text-sm text-slate-600 dark:text-slate-400 leading-relaxed font-normal">
             "{opinion}"
          </p>
      </div>
    </div>
  );
};