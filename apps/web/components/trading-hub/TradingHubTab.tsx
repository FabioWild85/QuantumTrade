import React, { useState } from 'react';
import { Monitor } from './Monitor';
import { ForecastView } from './ForecastView';
import { BotConfig } from './BotConfig';
import { TradeLog } from './TradeLog';
import { HubSettings } from './HubSettings';
import { BacktestPanel } from './BacktestPanel';

type HubPage = 'monitor' | 'forecast' | 'config' | 'trades' | 'backtest' | 'settings';

const NAV: { id: HubPage; label: string; icon: string }[] = [
  { id: 'monitor',  label: 'Monitor',    icon: '📡' },
  { id: 'forecast', label: 'Forecast',   icon: '🔮' },
  { id: 'config',   label: 'Bot Config', icon: '⚙️' },
  { id: 'trades',   label: 'Trade Log',  icon: '📋' },
  { id: 'backtest', label: 'Backtest',   icon: '⏱' },
  { id: 'settings', label: 'Settings',   icon: '🔑' },
];

const API_BASE = import.meta.env.VITE_API_URL || 'http://localhost:8000';

export const TradingHubTab: React.FC = () => {
  const [page, setPage] = useState<HubPage>('monitor');
  const [isDark] = useState(true);

  return (
    <div className="min-h-screen bg-dark-bg text-slate-100 font-sans">
      {/* Header */}
      <div className="border-b border-dark-border bg-dark-card/80 backdrop-blur sticky top-0 z-10">
        <div className="max-w-7xl mx-auto px-4 py-3 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-lg bg-indigo-600 flex items-center justify-center text-sm">🤖</div>
            <div>
              <h1 className="text-sm font-bold text-white">AI Trading Hub</h1>
              <p className="text-xs text-slate-500">BTC-PERP · Chronos-2 + LightGBM · 4h</p>
            </div>
          </div>
          <StatusBadge apiBase={API_BASE} />
        </div>

        {/* Tab nav */}
        <div className="max-w-7xl mx-auto px-4 flex gap-1 pb-0 overflow-x-auto">
          {NAV.map(n => (
            <button
              key={n.id}
              onClick={() => setPage(n.id)}
              className={`px-4 py-2.5 text-sm font-medium rounded-t-lg transition-colors whitespace-nowrap border-b-2 ${
                page === n.id
                  ? 'text-indigo-400 border-indigo-500 bg-indigo-500/10'
                  : 'text-slate-500 border-transparent hover:text-slate-300 hover:border-slate-600'
              }`}
            >
              <span className="mr-1.5">{n.icon}</span>{n.label}
            </button>
          ))}
        </div>
      </div>

      {/* Page content */}
      <div className="max-w-7xl mx-auto px-4 py-6">
        {page === 'monitor'  && <Monitor       apiBase={API_BASE} />}
        {page === 'forecast' && <ForecastView  apiBase={API_BASE} />}
        {page === 'config'   && <BotConfig     apiBase={API_BASE} />}
        {page === 'trades'   && <TradeLog      apiBase={API_BASE} />}
        {page === 'backtest' && <BacktestPanel apiBase={API_BASE} />}
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
          setRunning(d.engine);
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
