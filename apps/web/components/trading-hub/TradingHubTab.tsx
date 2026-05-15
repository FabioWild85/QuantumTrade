import React, { useState } from 'react';
import { Monitor } from './Monitor';
import { ForecastView } from './ForecastView';
import { BotConfig } from './BotConfig';
import { TradeLog } from './TradeLog';
import { HubSettings } from './HubSettings';
import { BacktestPanel } from './BacktestPanel';
import { ServerLogs } from './ServerLogs';

type HubPage = 'monitor' | 'forecast' | 'config' | 'trades' | 'backtest' | 'logs' | 'settings';

const NAV: { id: HubPage; label: string }[] = [
  { id: 'monitor',  label: 'Monitor' },
  { id: 'forecast', label: 'Forecast' },
  { id: 'config',   label: 'Bot Config' },
  { id: 'trades',   label: 'Trade Log' },
  { id: 'backtest', label: 'Backtest' },
  { id: 'logs',     label: 'Server Log' },
  { id: 'settings', label: 'Settings' },
];

const API_BASE = import.meta.env.VITE_API_URL ?? (
  import.meta.env.DEV ? 'http://localhost:8000' : '/api'
);

export const TradingHubTab: React.FC = () => {
  const [page, setPage] = useState<HubPage>('monitor');

  return (
    <div className="min-h-screen bg-slate-50 dark:bg-[#0f172a] text-slate-900 dark:text-slate-100 font-sans transition-colors duration-300">
      {/* Header */}
      <div className="border-b border-slate-200 dark:border-white/5 bg-white/80 dark:bg-[#151E32]/80 backdrop-blur sticky top-0 z-10">
        <div className="max-w-7xl mx-auto px-6 py-4 flex items-center justify-between">
          <div className="flex items-center gap-4">
            <div className="w-10 h-10 rounded-xl bg-indigo-600 flex items-center justify-center">
              <svg className="w-5 h-5 text-white" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="1,14 6,8 10,11 14,5 19,9" />
                <polyline points="14,5 19,5 19,9" />
              </svg>
            </div>
            <div>
              <h1 className="text-base font-bold text-slate-900 dark:text-white tracking-tight">AI Trading Hub</h1>
              <p className="text-xs font-medium text-slate-500 dark:text-slate-400">BTC-PERP · Chronos-2 + LightGBM · 4h</p>
            </div>
          </div>
          <StatusBadge apiBase={API_BASE} />
        </div>

        {/* Tab nav */}
        <div className="max-w-7xl mx-auto px-6 flex gap-8 pb-0 overflow-x-auto no-scrollbar">
          {NAV.map(n => (
            <button
              key={n.id}
              onClick={() => setPage(n.id)}
              className={`pb-4 text-sm font-semibold transition-all relative whitespace-nowrap ${
                page === n.id
                  ? 'text-indigo-600 dark:text-indigo-400'
                  : 'text-slate-400 dark:text-slate-500 hover:text-slate-600 dark:hover:text-slate-300'
              }`}
            >
              {n.label}
              {page === n.id && (
                <div className="absolute bottom-0 left-0 right-0 h-0.5 bg-indigo-600 dark:bg-indigo-400 rounded-full" />
              )}
            </button>
          ))}
        </div>
      </div>

      {/* Page content */}
      <div className="max-w-7xl mx-auto px-6 py-8">
        {page === 'monitor'  && <Monitor       apiBase={API_BASE} />}
        {page === 'forecast' && <ForecastView  apiBase={API_BASE} />}
        {page === 'config'   && <BotConfig     apiBase={API_BASE} />}
        {page === 'trades'   && <TradeLog      apiBase={API_BASE} />}
        {page === 'backtest' && <BacktestPanel apiBase={API_BASE} />}
        {page === 'logs'     && <ServerLogs    apiBase={API_BASE} />}
        {page === 'settings' && <HubSettings   apiBase={API_BASE} />}
      </div>
    </div>
  );
};

// ── Status badge (polls /health every 10s) ──────────────────────────────────
const StatusBadge: React.FC<{ apiBase: string }> = ({ apiBase }) => {
  const [status, setStatus] = React.useState<'loading' | 'online' | 'offline'>('loading');
  const [running, setRunning] = React.useState(false);

  React.useEffect(() => {
    const check = async () => {
      try {
        const r = await fetch(`${apiBase}/health`, { signal: AbortSignal.timeout(3000) });
        if (r.ok) {
          const d = await r.json();
          setStatus('online');
          setRunning(d.running);
        } else {
          setStatus('offline');
        }
      } catch {
        setStatus('offline');
      }
    };
    check();
    const t = setInterval(check, 10_000);
    return () => clearInterval(t);
  }, [apiBase]);

  const color = status === 'online' ? (running ? 'bg-emerald-500' : 'bg-amber-500') : 'bg-slate-600';
  const label = status === 'loading' ? '…' : status === 'offline' ? 'API offline' : running ? 'Running' : 'Idle';

  return (
    <div className="flex items-center gap-2 text-xs text-slate-400">
      <span className={`w-2 h-2 rounded-full ${color} ${running ? 'animate-pulse' : ''}`} />
      <span>{label}</span>
    </div>
  );
};
