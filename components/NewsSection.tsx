
import React, { useState } from 'react';
import { CalendarEvent, NewsItem } from '../types';

interface Props {
  news: CalendarEvent[];
  latestNews?: NewsItem[];
}

export const NewsSection: React.FC<Props> = ({ news, latestNews = [] }) => {
  const [activeTab, setActiveTab] = useState<'CALENDAR' | 'HEADLINES'>('CALENDAR');

  const events = Array.isArray(news) ? news : [];
  const headlines = Array.isArray(latestNews) ? latestNews : [];

  return (
    <div className="elegant-card h-full flex flex-col overflow-hidden">
      {/* Tab Header */}
      <div className="flex border-b border-slate-100 dark:border-white/5">
          <button 
             onClick={() => setActiveTab('CALENDAR')}
             className={`flex-1 py-4 text-xs font-bold uppercase tracking-wider transition-colors ${activeTab === 'CALENDAR' ? 'bg-white dark:bg-[#151E32] text-indigo-600 dark:text-indigo-400 border-b-2 border-indigo-600' : 'bg-slate-50 dark:bg-slate-800/50 text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-200'}`}
          >
             Macro Calendar
          </button>
          <button 
             onClick={() => setActiveTab('HEADLINES')}
             className={`flex-1 py-4 text-xs font-bold uppercase tracking-wider transition-colors ${activeTab === 'HEADLINES' ? 'bg-white dark:bg-[#151E32] text-indigo-600 dark:text-indigo-400 border-b-2 border-indigo-600' : 'bg-slate-50 dark:bg-slate-800/50 text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-200'}`}
          >
             Crypto News
          </button>
      </div>
      
      <div className="p-6 overflow-y-auto flex-1">
         {activeTab === 'CALENDAR' && (
             <div className="space-y-6">
                 {events.length > 0 ? (
                   events.map((item, idx) => (
                     <div key={idx} className="group">
                        <div className="flex justify-between items-start mb-1">
                           <span className="text-xs font-bold text-slate-400 dark:text-slate-500 font-mono">{item.date}</span>
                           <span className={`text-[10px] font-bold px-2 py-0.5 rounded uppercase ${item.impact === 'High' ? 'bg-rose-100 text-rose-700 dark:bg-rose-500/10 dark:text-rose-400' : 'bg-blue-100 text-blue-700 dark:bg-blue-500/10 dark:text-blue-400'}`}>
                              {item.impact}
                           </span>
                        </div>
                        <h4 className="text-sm font-bold text-slate-800 dark:text-slate-200 mb-2 group-hover:text-indigo-500 transition-colors">{item.event}</h4>
                        <div className="flex gap-3 text-xs text-slate-500 dark:text-slate-400">
                           <div className="bg-slate-50 dark:bg-slate-800 px-2 py-1 rounded">Forecast: <span className="font-mono text-slate-700 dark:text-slate-300">{item.forecast || 'N/A'}</span></div>
                           <div className="bg-slate-50 dark:bg-slate-800 px-2 py-1 rounded">Prev: <span className="font-mono text-slate-700 dark:text-slate-300">{item.previous || 'N/A'}</span></div>
                        </div>
                     </div>
                   ))
                 ) : (
                   <div className="text-center py-12 text-sm text-slate-400 italic">No major macro events found</div>
                 )}
             </div>
         )}

         {activeTab === 'HEADLINES' && (
             <div className="space-y-6">
                 {headlines.length > 0 ? (
                    headlines.map((item, idx) => (
                        <div key={idx} className="group border-b border-slate-50 dark:border-white/5 last:border-0 pb-4 last:pb-0">
                             <div className="flex justify-between items-center mb-1">
                                 <span className="text-[10px] font-bold text-indigo-500 uppercase">{item.source}</span>
                                 <span className="text-[10px] text-slate-400">{item.time}</span>
                             </div>
                             <a href={item.url} target="_blank" rel="noopener noreferrer" className="block">
                                <h4 className="text-sm font-medium text-slate-800 dark:text-slate-200 leading-snug group-hover:text-indigo-600 dark:group-hover:text-indigo-400 transition-colors">
                                    {item.title}
                                </h4>
                             </a>
                             <div className="mt-2 flex items-center gap-2">
                                 <span className={`w-2 h-2 rounded-full ${item.sentiment === 'Positive' ? 'bg-emerald-500' : item.sentiment === 'Negative' ? 'bg-rose-500' : 'bg-slate-400'}`}></span>
                                 <span className="text-[10px] font-semibold text-slate-500">{item.sentiment} Sentiment</span>
                             </div>
                        </div>
                    ))
                 ) : (
                    <div className="text-center py-12 text-sm text-slate-400 italic">
                        No recent news retrieved from CoinTelegraph/CoinDesk.
                    </div>
                 )}
             </div>
         )}
      </div>
    </div>
  );
};
