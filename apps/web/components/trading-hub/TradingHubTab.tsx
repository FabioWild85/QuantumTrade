import React, { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { Monitor } from './Monitor';
import { ForecastView } from './ForecastView';
import { BotConfig } from './BotConfig';
import { TradeLog } from './TradeLog';
import { HubSettings } from './HubSettings';
import { BacktestPanel } from './BacktestPanel';
import { ServerLogs } from './ServerLogs';
import { RegimePanel } from './RegimePanel';
import { ReversalPanel } from './ReversalPanel';
import { ServerStatus } from './ServerStatus';

import { apiFetch } from '../../services/authService';
type HubPage = 'monitor' | 'forecast' | 'config' | 'trades' | 'backtest' | 'regime' | 'reversal' | 'logs' | 'server' | 'settings';

const VALID_PAGES: HubPage[] = ['monitor', 'forecast', 'config', 'trades', 'backtest', 'regime', 'reversal', 'logs', 'server', 'settings'];

interface NavItem {
  id: HubPage;
  label: string;
  icon: React.ReactNode;
}

const NAV: NavItem[] = [
  {
    id: 'monitor',
    label: 'Monitor',
    icon: (
      <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
        <rect x="2" y="3" width="20" height="14" rx="2" ry="2"/>
        <line x1="8" y1="21" x2="16" y2="21"/>
        <line x1="12" y1="17" x2="12" y2="21"/>
      </svg>
    ),
  },
  {
    id: 'forecast',
    label: 'Forecast',
    icon: (
      <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" d="M13 7h8m0 0v8m0-8l-8 8-4-4-6 6"/>
      </svg>
    ),
  },
  {
    id: 'config',
    label: 'Bot Config',
    icon: (
      <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z"/>
        <circle cx="12" cy="12" r="3"/>
      </svg>
    ),
  },
  {
    id: 'trades',
    label: 'Trade Log',
    icon: (
      <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"/>
      </svg>
    ),
  },
  {
    id: 'backtest',
    label: 'Backtest',
    icon: (
      <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" d="M14.752 11.168l-3.197-2.132A1 1 0 0010 9.87v4.263a1 1 0 001.555.832l3.197-2.132a1 1 0 000-1.664z"/>
        <path strokeLinecap="round" strokeLinejoin="round" d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z"/>
      </svg>
    ),
  },
  {
    id: 'regime',
    label: 'Regime',
    icon: (
      <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 002 2h2a2 2 0 002-2z"/>
      </svg>
    ),
  },
  {
    id: 'reversal',
    label: 'Reversal',
    icon: (
      <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" d="M7 16V4m0 0L3 8m4-4l4 4M17 8v12m0 0l4-4m-4 4l-4-4"/>
      </svg>
    ),
  },
  {
    id: 'logs',
    label: 'Server Log',
    icon: (
      <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" d="M8 9l3 3-3 3m5 0h3M5 20h14a2 2 0 002-2V6a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z"/>
      </svg>
    ),
  },
  {
    id: 'server',
    label: 'Server',
    icon: (
      <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" d="M5 12h14M5 12a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v4a2 2 0 01-2 2M5 12a2 2 0 00-2 2v4a2 2 0 002 2h14a2 2 0 002-2v-4a2 2 0 00-2-2m-2-4h.01M17 16h.01"/>
      </svg>
    ),
  },
  {
    id: 'settings',
    label: 'Settings',
    icon: (
      <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" d="M12 6V4m0 2a2 2 0 100 4m0-4a2 2 0 110 4m-6 8a2 2 0 100-4m0 4a2 2 0 110-4m0 4v2m0-6V4m6 6v10m6-2a2 2 0 100-4m0 4a2 2 0 110-4m0 4v2m0-6V4"/>
      </svg>
    ),
  },
];

const API_BASE = import.meta.env.VITE_API_URL ?? (
  import.meta.env.DEV ? 'http://localhost:8000' : '/api'
);

interface TradingHubTabProps {
  isDarkMode: boolean;
  toggleTheme: () => void;
}

export const TradingHubTab: React.FC<TradingHubTabProps> = ({ isDarkMode, toggleTheme }) => {
  const { page: pageParam } = useParams<{ page: string }>();
  const navigate = useNavigate();

  const page: HubPage = VALID_PAGES.includes(pageParam as HubPage)
    ? (pageParam as HubPage)
    : 'monitor';

  const [isCollapsed, setIsCollapsed] = useState<boolean>(false);
  const [isMobileOpen, setIsMobileOpen] = useState<boolean>(false);

  // Close mobile drawer on page change
  useEffect(() => {
    setIsMobileOpen(false);
  }, [page]);

  const renderSidebarContent = () => (
    <div className="h-full flex flex-col justify-between py-6">
      <div className="space-y-6">
        {/* Brand / Logo */}
        <div className={`px-6 flex items-center ${isCollapsed ? 'justify-center' : 'gap-3'}`}>
          <div className="w-10 h-10 rounded-xl bg-indigo-600 flex items-center justify-center flex-shrink-0 shadow-lg shadow-indigo-500/20">
            <svg className="w-5 h-5 text-white" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="1,14 6,8 10,11 14,5 19,9" />
              <polyline points="14,5 19,5 19,9" />
            </svg>
          </div>
          {!isCollapsed && (
            <div className="min-w-0">
              <h1 className="text-base font-bold text-slate-900 dark:text-white tracking-tight truncate">AI Trading Hub</h1>
              <p className="text-[10px] font-medium text-slate-500 dark:text-slate-400 truncate">Chronos-2 + LightGBM</p>
            </div>
          )}
        </div>

        {/* Back to Dashboard */}
        <div className="px-4">
          <button
            onClick={() => navigate('/')}
            className={`w-full flex items-center gap-3 px-4 py-2 text-xs font-semibold rounded-xl border border-slate-200 dark:border-white/10 hover:bg-slate-50 dark:hover:bg-white/5 text-slate-500 hover:text-slate-900 dark:text-slate-400 dark:hover:text-white transition-all ${isCollapsed ? 'justify-center' : ''}`}
            title="Dashboard Principale"
          >
            <svg className="w-4 h-4 flex-shrink-0" fill="none" stroke="currentColor" strokeWidth="2.5" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M10.5 19.5L3 12m0 0l7.5-7.5M3 12h18" />
            </svg>
            {!isCollapsed && <span>Dashboard</span>}
          </button>
        </div>

        {/* Nav Links */}
        <nav className="px-3 space-y-1">
          {NAV.map(n => {
            const active = page === n.id;
            return (
              <button
                key={n.id}
                onClick={() => navigate(`/hub/${n.id}`)}
                className={`w-full flex items-center gap-3 px-4 py-3 text-sm font-semibold rounded-xl transition-all relative ${
                  active
                    ? 'bg-indigo-50 dark:bg-indigo-500/10 text-indigo-600 dark:text-indigo-400 shadow-sm'
                    : 'text-slate-500 hover:text-slate-800 dark:text-slate-400 dark:hover:text-slate-200 hover:bg-slate-50 dark:hover:bg-white/[0.02]'
                } ${isCollapsed ? 'justify-center' : ''}`}
                title={n.label}
              >
                <span className={`flex-shrink-0 ${active ? 'text-indigo-600 dark:text-indigo-400' : 'text-slate-400 dark:text-slate-500'}`}>
                  {n.icon}
                </span>
                {!isCollapsed && <span className="truncate">{n.label}</span>}
                {active && !isCollapsed && (
                  <div className="absolute right-3 top-1/2 -translate-y-1/2 w-1.5 h-1.5 bg-indigo-600 dark:bg-indigo-400 rounded-full" />
                )}
              </button>
            );
          })}
        </nav>
      </div>

      {/* Footer: status + dark toggle + collapse */}
      <div className="space-y-4 px-6">
        <div className={`flex items-center ${isCollapsed ? 'justify-center flex-col gap-3' : 'justify-between'} border-t border-slate-100 dark:border-white/5 pt-4`}>
          {!isCollapsed && <StatusBadge apiBase={API_BASE} />}

          <div className={`flex items-center ${isCollapsed ? 'flex-col gap-3' : 'gap-2'}`}>
            {/* Dark Mode Toggle */}
            <button
              onClick={toggleTheme}
              className="flex items-center justify-center p-2 rounded-lg bg-slate-50 dark:bg-white/5 border border-slate-200 dark:border-white/5 text-slate-400 hover:text-slate-800 dark:hover:text-white transition-colors"
              title={isDarkMode ? 'Passa a Light' : 'Passa a Dark'}
            >
              {isDarkMode ? (
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 3v1m0 16v1m9-9h-1M4 12H3m15.364 6.364l-.707-.707M6.343 6.343l-.707-.707m12.728 0l-.707.707M6.343 17.657l-.707.707M16 12a4 4 0 11-8 0 4 4 0 018 0z" />
                </svg>
              ) : (
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M20.354 15.354A9 9 0 018.646 3.646 9.003 9.003 0 0012 21a9.003 9.003 0 008.354-5.646z" />
                </svg>
              )}
            </button>

            {/* Collapse Toggle (Desktop Only) */}
            <button
              onClick={() => setIsCollapsed(c => !c)}
              className="hidden md:flex items-center justify-center p-2 rounded-lg bg-slate-50 dark:bg-white/5 border border-slate-200 dark:border-white/5 text-slate-400 hover:text-slate-800 dark:hover:text-white transition-colors"
              title={isCollapsed ? 'Espandi barra' : 'Comprimi barra'}
            >
              <svg className={`w-4 h-4 transform transition-transform duration-300 ${isCollapsed ? 'rotate-180' : ''}`} fill="none" stroke="currentColor" strokeWidth="2.5" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 19.5L8.25 12l7.5-7.5" />
              </svg>
            </button>
          </div>
        </div>
      </div>
    </div>
  );

  return (
    <div className="min-h-screen bg-slate-50 dark:bg-[#0f172a] text-slate-900 dark:text-slate-100 font-sans transition-colors duration-300 flex flex-col md:flex-row">

      {/* ── Desktop Sidebar ── */}
      <aside
        className={`hidden md:block bg-white dark:bg-[#151E32] border-r border-slate-200 dark:border-white/5 h-screen sticky top-0 z-20 shrink-0 transition-all duration-300 ${
          isCollapsed ? 'w-20' : 'w-64'
        }`}
      >
        {renderSidebarContent()}
      </aside>

      {/* ── Mobile Top Header ── */}
      <header className="md:hidden flex items-center justify-between px-4 h-16 bg-white dark:bg-[#151E32] border-b border-slate-200 dark:border-white/5 sticky top-0 z-30 shadow-sm">
        <div className="flex items-center gap-3">
          <button
            onClick={() => setIsMobileOpen(true)}
            className="p-2 rounded-xl text-slate-500 hover:text-slate-900 dark:hover:text-white hover:bg-slate-100 dark:hover:bg-white/5 transition-all"
            title="Apri menu"
          >
            <svg className="w-6 h-6" fill="none" stroke="currentColor" strokeWidth="2.2" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 6.75h16.5M3.75 12h16.5m-16.5 5.25h16.5" />
            </svg>
          </button>
          <div>
            <h1 className="text-sm font-bold text-slate-900 dark:text-white tracking-tight">AI Trading Hub</h1>
            <p className="text-[9px] font-medium text-slate-500 dark:text-slate-400">BTC-PERP · 4h</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={toggleTheme}
            className="p-2 rounded-xl bg-slate-50 dark:bg-slate-800 text-slate-500 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-700 transition-colors border border-slate-200 dark:border-white/5"
            aria-label="Toggle Dark Mode"
          >
            {isDarkMode ? (
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 3v1m0 16v1m9-9h-1M4 12H3m15.364 6.364l-.707-.707M6.343 6.343l-.707-.707m12.728 0l-.707.707M6.343 17.657l-.707.707M16 12a4 4 0 11-8 0 4 4 0 018 0z" /></svg>
            ) : (
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M20.354 15.354A9 9 0 018.646 3.646 9.003 9.003 0 0012 21a9.003 9.003 0 008.354-5.646z" /></svg>
            )}
          </button>
          <StatusBadge apiBase={API_BASE} />
        </div>
      </header>

      {/* ── Mobile Sidebar Drawer ── */}
      {isMobileOpen && (
        <div className="md:hidden fixed inset-0 z-40 flex">
          <div
            className="fixed inset-0 bg-slate-900/60 backdrop-blur-sm transition-opacity duration-300"
            onClick={() => setIsMobileOpen(false)}
          />
          <div className="relative flex-1 flex flex-col max-w-[280px] w-full bg-white dark:bg-[#151E32] shadow-2xl transition-transform duration-300 ease-in-out z-50">
            <div className="absolute top-4 right-4 z-50">
              <button
                onClick={() => setIsMobileOpen(false)}
                className="p-2 rounded-xl text-slate-400 hover:text-slate-900 dark:hover:text-white hover:bg-slate-100 dark:hover:bg-white/5 transition-colors"
                title="Chiudi menu"
              >
                <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth="2.5" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
            {renderSidebarContent()}
          </div>
        </div>
      )}

      {/* ── Main Content ── */}
      <main className="flex-1 w-full min-w-0 px-4 py-6 md:px-8 md:py-8 overflow-x-hidden">
        {page === 'monitor'  && <Monitor       apiBase={API_BASE} />}
        {page === 'forecast' && <ForecastView  apiBase={API_BASE} />}
        {page === 'config'   && <BotConfig     apiBase={API_BASE} />}
        {page === 'trades'   && <TradeLog      apiBase={API_BASE} />}
        {page === 'backtest' && <BacktestPanel apiBase={API_BASE} />}
        {page === 'regime'   && <RegimePanel   apiBase={API_BASE} />}
        {page === 'reversal' && <ReversalPanel apiBase={API_BASE} />}
        {page === 'logs'     && <ServerLogs    apiBase={API_BASE} />}
        {page === 'server'   && <ServerStatus  apiBase={API_BASE} />}
        {page === 'settings' && <HubSettings   apiBase={API_BASE} />}
      </main>
    </div>
  );
};

// ── Status badge (polls /health ogni 10s) ──────────────────────────────────
const StatusBadge: React.FC<{ apiBase: string }> = ({ apiBase }) => {
  const [status,          setStatus]         = React.useState<'loading' | 'online' | 'offline'>('loading');
  const [running,         setRunning]        = React.useState(false);
  const [backtestRunning, setBacktestRunning] = React.useState(false);

  useEffect(() => {
    let active = true;
    const check = async () => {
      try {
        const r = await apiFetch(`${apiBase}/health`, { signal: AbortSignal.timeout(8000) });
        if (r.ok && active) {
          const d = await r.json();
          setStatus('online');
          setRunning(d.running ?? false);
          setBacktestRunning(d.backtest_running ?? false);
        } else if (active) {
          setStatus('offline');
        }
      } catch {
        if (active) setStatus('offline');
      }
    };
    check();
    const t = setInterval(check, 10_000);
    return () => { active = false; clearInterval(t); };
  }, [apiBase]);

  const color = status !== 'online'
    ? 'bg-slate-500'
    : backtestRunning
      ? 'bg-indigo-500'
      : running
        ? 'bg-emerald-500'
        : 'bg-slate-400';

  const label = status === 'loading'
    ? '…'
    : status === 'offline'
      ? 'API offline'
      : backtestRunning
        ? 'Backtest'
        : running
          ? 'Running'
          : 'Standby';

  const pulse = running || backtestRunning;

  return (
    <div className="flex items-center gap-2 text-xs text-slate-400">
      <span className={`w-2 h-2 rounded-full ${color} ${pulse ? 'animate-pulse' : ''}`} />
      <span className="font-semibold tracking-wide uppercase text-[10px]">{label}</span>
    </div>
  );
};
