import React from 'react';
import { Sentiment } from '../types';

interface Props {
  isOpen: boolean;
  onClose: () => void;
  title: string;
  sentiment: Sentiment | string;
  content: string;
}

export const ExplanationModal: React.FC<Props> = ({ isOpen, onClose, title, sentiment, content }) => {
  if (!isOpen) return null;

  const isBullish = sentiment.toString().toUpperCase().includes('BULL') || sentiment.toString().toUpperCase().includes('POS');
  const isBearish = sentiment.toString().toUpperCase().includes('BEAR') || sentiment.toString().toUpperCase().includes('NEG');

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center px-4 animate-fade-in">
      {/* Backdrop */}
      <div 
        className="absolute inset-0 bg-slate-900/20 dark:bg-slate-900/80 backdrop-blur-sm transition-opacity"
        onClick={onClose}
      ></div>

      {/* Modal Content */}
      <div className="relative w-full max-w-lg bg-white dark:bg-[#151E32] rounded-2xl shadow-2xl overflow-hidden transform transition-all animate-slide-up border border-slate-100 dark:border-white/10">
        {/* Header */}
        <div className="px-8 py-6 border-b border-slate-100 dark:border-white/5 flex justify-between items-start bg-slate-50 dark:bg-slate-800/50">
          <div>
            <h3 className="text-xl font-bold text-slate-900 dark:text-white mb-1">{title}</h3>
            <span className={`inline-block px-2.5 py-0.5 rounded text-[10px] font-bold uppercase tracking-wider ${isBullish ? 'bg-emerald-100 dark:bg-emerald-500/10 text-emerald-700 dark:text-emerald-400' : isBearish ? 'bg-rose-100 dark:bg-rose-500/10 text-rose-700 dark:text-rose-400' : 'bg-slate-100 dark:bg-slate-500/10 text-slate-600 dark:text-slate-400'}`}>
               {sentiment}
            </span>
          </div>
          <button 
            onClick={onClose}
            className="text-slate-400 hover:text-slate-600 dark:hover:text-white transition-colors p-2 hover:bg-slate-100 dark:hover:bg-white/5 rounded-full"
          >
            <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Body */}
        <div className="p-8">
          <div className="flex gap-6">
            <div className={`flex-shrink-0 w-12 h-12 rounded-full flex items-center justify-center shadow-sm ${isBullish ? 'bg-emerald-50 dark:bg-emerald-500/10 text-emerald-600 dark:text-emerald-500' : isBearish ? 'bg-rose-50 dark:bg-rose-500/10 text-rose-600 dark:text-rose-500' : 'bg-slate-50 dark:bg-slate-500/10 text-slate-600 dark:text-slate-500'}`}>
              <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
            </div>
            <div>
              <h4 className="text-sm font-bold text-slate-900 dark:text-white mb-3 uppercase tracking-wide">Impact Analysis</h4>
              <p className="text-base text-slate-600 dark:text-slate-300 leading-relaxed font-normal">
                {content}
              </p>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};