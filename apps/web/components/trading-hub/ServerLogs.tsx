import React, { useCallback, useEffect, useRef, useState } from 'react';

import { apiFetch } from '../../services/authService';
interface ServerEvent {
  id: string;
  time: string;
  severity: 'info' | 'warning' | 'error' | 'critical';
  kind: string;
  message: string;
  payload: Record<string, unknown>;
}

type Filter = 'all' | 'info' | 'warning' | 'error';

const KIND_LABELS: Record<string, string> = {
  bot_started:      'Avvio',
  bot_stopped:      'Stop',
  bot_auto_resumed: 'Auto-resume',
  server_stopping:  'Spegnimento',
  trade_opened:     'Trade aperto',
  trade_closed:     'Trade chiuso',
  cycle_error:      'Errore ciclo',
  wallet_connected: 'Wallet',
  kill:             'Kill',
};

const SEVERITY_STYLES: Record<string, string> = {
  info:     'bg-sky-500/10 text-sky-600 dark:text-sky-400 border-sky-500/20',
  warning:  'bg-amber-500/10 text-amber-600 dark:text-amber-400 border-amber-500/20',
  error:    'bg-red-500/10 text-red-600 dark:text-red-400 border-red-500/20',
  critical: 'bg-rose-600/10 text-rose-600 dark:text-rose-400 border-rose-500/20',
};

const LEFT_BAR: Record<string, string> = {
  info:     'bg-sky-500',
  warning:  'bg-amber-500',
  error:    'bg-red-500',
  critical: 'bg-rose-600',
};

function formatTime(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString('it-IT', {
    day: '2-digit', month: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
}

export const ServerLogs: React.FC<{ apiBase: string }> = ({ apiBase }) => {
  const [events, setEvents] = useState<ServerEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>('all');
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [lastFetch, setLastFetch] = useState<Date | null>(null);
  const logsEndRef = useRef<HTMLDivElement>(null);

  const fetchEvents = useCallback(async () => {
    setLoading(true);
    try {
      const r = await apiFetch(`${apiBase}/events?limit=200`, { signal: AbortSignal.timeout(5000) });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const data: ServerEvent[] = await r.json();
      setEvents(data);
      setError(null);
      setLastFetch(new Date());
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Errore di rete');
    } finally {
      setLoading(false);
    }
  }, [apiBase]);

  useEffect(() => {
    fetchEvents();
  }, [fetchEvents]);

  useEffect(() => {
    if (!autoRefresh) return;
    const t = setInterval(fetchEvents, 30_000);
    return () => clearInterval(t);
  }, [autoRefresh, fetchEvents]);

  const toggleExpand = (id: string) => {
    setExpanded(prev => {
      const n = new Set(prev);
      n.has(id) ? n.delete(id) : n.add(id);
      return n;
    });
  };

  const filtered = events.filter(e => {
    if (filter === 'all') return true;
    if (filter === 'error') return e.severity === 'error' || e.severity === 'critical';
    return e.severity === filter;
  });

  const warningCount = events.filter(e => e.severity === 'warning').length;
  const errorCount   = events.filter(e => e.severity === 'error' || e.severity === 'critical').length;

  return (
    <div className="space-y-5">
      {/* Header row */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h2 className="text-base font-semibold text-slate-900 dark:text-white">Log del Server</h2>
          <p className="text-xs text-slate-400 mt-0.5">
            {lastFetch ? `Aggiornato: ${lastFetch.toLocaleTimeString('it-IT')}` : 'Caricamento…'}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {/* Auto-refresh toggle */}
          <button
            onClick={() => setAutoRefresh(p => !p)}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors ${
              autoRefresh
                ? 'bg-emerald-500/10 border-emerald-500/20 text-emerald-600 dark:text-emerald-400'
                : 'bg-slate-100 dark:bg-white/5 border-slate-200 dark:border-white/10 text-slate-500'
            }`}
          >
            <span className={`w-1.5 h-1.5 rounded-full ${autoRefresh ? 'bg-emerald-500 animate-pulse' : 'bg-slate-400'}`} />
            {autoRefresh ? 'Live' : 'Pausa'}
          </button>
          {/* Manual refresh */}
          <button
            onClick={fetchEvents}
            disabled={loading}
            title="Aggiorna log"
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-slate-200 dark:border-white/10 text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-white/5 transition-colors disabled:opacity-40 text-xs font-medium"
          >
            <svg className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <path d="M11.9 2.1a6 6 0 1 1-8.4-.1" />
              <polyline points="9.5,0.5 12,2 9.5,4" />
            </svg>
            Aggiorna
          </button>
        </div>
      </div>

      {/* Stats bar */}
      <div className="grid grid-cols-3 gap-3">
        <div className="bg-white dark:bg-white/[0.04] border border-slate-200 dark:border-white/8 rounded-xl p-3">
          <p className="text-xs text-slate-400">Totale eventi</p>
          <p className="text-xl font-bold text-slate-900 dark:text-white mt-0.5">{events.length}</p>
        </div>
        <div className="bg-white dark:bg-white/[0.04] border border-amber-500/20 rounded-xl p-3">
          <p className="text-xs text-amber-500">Warning</p>
          <p className="text-xl font-bold text-amber-600 dark:text-amber-400 mt-0.5">{warningCount}</p>
        </div>
        <div className="bg-white dark:bg-white/[0.04] border border-red-500/20 rounded-xl p-3">
          <p className="text-xs text-red-500">Errori</p>
          <p className="text-xl font-bold text-red-600 dark:text-red-400 mt-0.5">{errorCount}</p>
        </div>
      </div>

      {/* Filter tabs */}
      <div className="flex gap-1 p-1 bg-slate-100 dark:bg-white/5 rounded-xl w-fit">
        {(['all', 'info', 'warning', 'error'] as Filter[]).map(f => (
          <button
            key={f}
            onClick={() => setFilter(f)}
            className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-all ${
              filter === f
                ? 'bg-white dark:bg-white/10 text-slate-900 dark:text-white shadow-sm'
                : 'text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-300'
            }`}
          >
            {f === 'all' ? 'Tutti' : f === 'info' ? 'Info' : f === 'warning' ? 'Warning' : 'Errori'}
            {f !== 'all' && (
              <span className="ml-1.5 text-[10px] opacity-60">
                {f === 'info' ? events.filter(e => e.severity === 'info').length
                 : f === 'warning' ? warningCount : errorCount}
              </span>
            )}
          </button>
        ))}
      </div>

      {/* Events list */}
      <div className="bg-white dark:bg-white/[0.04] border border-slate-200 dark:border-white/8 rounded-2xl overflow-hidden">
        {error && (
          <div className="p-4 text-sm text-red-500 flex items-center gap-2">
            <svg className="w-4 h-4 shrink-0" viewBox="0 0 16 16" fill="currentColor"><path fillRule="evenodd" d="M8 1a7 7 0 100 14A7 7 0 008 1zm-.75 4a.75.75 0 011.5 0v3a.75.75 0 01-1.5 0V5zm.75 6a.75.75 0 100-1.5.75.75 0 000 1.5z" /></svg>
            Impossibile caricare i log: {error}
          </div>
        )}

        {!error && filtered.length === 0 && (
          <div className="py-16 text-center text-sm text-slate-400">
            {loading ? 'Caricamento log…' : 'Nessun evento trovato.'}
          </div>
        )}

        {filtered.map((event, idx) => {
          const isExpanded = expanded.has(event.id);
          const hasPayload = event.payload && Object.keys(event.payload).length > 0;
          const isLast = idx === filtered.length - 1;

          return (
            <div
              key={event.id}
              className={`flex gap-0 ${!isLast ? 'border-b border-slate-100 dark:border-white/5' : ''}`}
            >
              {/* Left severity bar */}
              <div className={`w-1 shrink-0 rounded-l-none ${LEFT_BAR[event.severity] || LEFT_BAR.info} opacity-70`} />

              <div className="flex-1 px-4 py-3 min-w-0">
                <div className="flex items-start gap-3 flex-wrap">
                  {/* Time */}
                  <span className="text-[11px] font-mono text-slate-400 shrink-0 pt-0.5 tabular-nums">
                    {formatTime(event.time)}
                  </span>

                  {/* Severity badge */}
                  <span className={`text-[10px] font-semibold uppercase px-1.5 py-0.5 rounded border ${SEVERITY_STYLES[event.severity] || SEVERITY_STYLES.info}`}>
                    {event.severity}
                  </span>

                  {/* Kind */}
                  <span className="text-[11px] font-medium text-slate-500 dark:text-slate-400 bg-slate-100 dark:bg-white/5 px-2 py-0.5 rounded shrink-0">
                    {KIND_LABELS[event.kind] ?? event.kind}
                  </span>

                  {/* Message */}
                  <span className="text-sm text-slate-700 dark:text-slate-200 flex-1 min-w-0 break-words">
                    {event.message}
                  </span>

                  {/* Expand button */}
                  {hasPayload && (
                    <button
                      onClick={() => toggleExpand(event.id)}
                      className="text-[11px] text-slate-400 hover:text-slate-600 dark:hover:text-slate-300 shrink-0 flex items-center gap-0.5 transition-colors"
                    >
                      <svg className={`w-3 h-3 transition-transform ${isExpanded ? 'rotate-180' : ''}`} viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                        <polyline points="2,4 6,8 10,4" />
                      </svg>
                      dettagli
                    </button>
                  )}
                </div>

                {/* Expanded payload */}
                {isExpanded && hasPayload && (
                  <div className="mt-2 ml-0 p-3 bg-slate-50 dark:bg-black/20 rounded-lg border border-slate-100 dark:border-white/5">
                    <pre className="text-[11px] font-mono text-slate-600 dark:text-slate-300 whitespace-pre-wrap break-all leading-relaxed">
                      {JSON.stringify(event.payload, null, 2)}
                    </pre>
                  </div>
                )}
              </div>
            </div>
          );
        })}
        <div ref={logsEndRef} />
      </div>

      {filtered.length > 0 && (
        <p className="text-xs text-slate-400 text-center">
          {filtered.length} eventi — aggiornamento automatico ogni 30s
        </p>
      )}
    </div>
  );
};
