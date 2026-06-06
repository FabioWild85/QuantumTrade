import React, { useCallback, useEffect, useState } from 'react';
import { Tooltip } from './Tooltip';

// ── Types ─────────────────────────────────────────────────────────────────────

interface ReversalComponents {
  structural: number;
  momentum:   number;
  exhaustion: number;
  volume:     number;
  regime:     number;
  funding:    number;
  candle:     number;
}

interface ReversalResult {
  score:           number;
  direction:       'long' | 'short' | null;
  component_count: number;
  components:      ReversalComponents;
  reasoning:       string[];
}

interface ReversalPending {
  direction:     'long' | 'short';
  entry_limit:   number;
  sl:            number;
  tp:            number;
  signal_bar:    number;
  expiry_bar:    number;
  atr_at_signal: number;
}

interface ReversalCurrentResponse {
  reversal_enabled: boolean;
  result:           ReversalResult | null;
  pending:          ReversalPending | null;
  updated_at:       string;
  position_open:    boolean;
}

interface HistoryEntry {
  detected_at: string;
  score:       number;
  direction:   'long' | 'short' | null;
}

// ── Constants ─────────────────────────────────────────────────────────────────

const COMPONENT_WEIGHTS: Record<keyof ReversalComponents, number> = {
  structural: 0.22,
  momentum:   0.20,
  exhaustion: 0.18,
  volume:     0.15,
  regime:     0.12,
  funding:    0.08,
  candle:     0.05,
};

const COMPONENT_LABELS: Record<keyof ReversalComponents, string> = {
  structural: 'Structural (SMC)',
  momentum:   'Momentum (4H+Daily Div)',
  exhaustion: 'Exhaustion (ADX+RSI)',
  volume:     'Volume (Climax)',
  regime:     'Regime (Risk)',
  funding:    'Funding Rate',
  candle:     'Candle Pattern',
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function dirStyle(dir: 'long' | 'short' | null) {
  if (dir === 'long')  return { dot: 'bg-emerald-500', badge: 'bg-emerald-500/15 text-emerald-400', text: 'text-emerald-400' };
  if (dir === 'short') return { dot: 'bg-red-500',     badge: 'bg-red-500/15 text-red-400',         text: 'text-red-400'     };
  return { dot: 'bg-slate-400', badge: 'bg-slate-400/15 text-slate-400', text: 'text-slate-400' };
}

function componentColor(score: number): string {
  if (score >= 0.6) return 'bg-emerald-500';
  if (score >= 0.3) return 'bg-amber-400';
  return 'bg-slate-300 dark:bg-slate-600';
}

function fmtScore(s: number): string { return (s * 100).toFixed(0) + '%'; }

function fmtTime(iso: string): string {
  try {
    return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  } catch { return '—'; }
}

function fmtPrice(p: number): string {
  return p >= 1000 ? p.toLocaleString('en-US', { maximumFractionDigits: 0 }) : p.toFixed(2);
}

// ── Main Component ────────────────────────────────────────────────────────────

export const ReversalPanel: React.FC<{ apiBase: string }> = ({ apiBase }) => {
  const [data,        setData]        = useState<ReversalCurrentResponse | null>(null);
  const [history,     setHistory]     = useState<HistoryEntry[]>([]);
  const [loading,     setLoading]     = useState(true);
  const [error,       setError]       = useState<string | null>(null);
  const [showReason,  setShowReason]  = useState(false);
  const [lastUpdated, setLastUpdated] = useState<string>('');

  const fetchCurrent = useCallback(async () => {
    try {
      const r = await fetch(`${apiBase}/reversal/current`, { signal: AbortSignal.timeout(8000) });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const d: ReversalCurrentResponse = await r.json();
      setData(d);
      setLastUpdated(new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }));
      setError(null);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Fetch error');
    } finally {
      setLoading(false);
    }
  }, [apiBase]);

  const fetchHistory = useCallback(async () => {
    try {
      const r = await fetch(`${apiBase}/reversal/history?limit=20`, { signal: AbortSignal.timeout(8000) });
      if (!r.ok) return;
      const d = await r.json();
      setHistory(d.history || []);
    } catch { /* non-blocking */ }
  }, [apiBase]);

  useEffect(() => {
    fetchCurrent();
    fetchHistory();
    const t = setInterval(() => { fetchCurrent(); fetchHistory(); }, 30_000);
    return () => clearInterval(t);
  }, [fetchCurrent, fetchHistory]);

  // ── Disabled state ──────────────────────────────────────────────────────────
  if (!loading && data && !data.reversal_enabled) {
    return (
      <div className="space-y-6">
        <div>
          <h2 className="text-xl font-bold text-slate-900 dark:text-white">Reversal Zone Detector</h2>
          <p className="text-sm text-slate-500 dark:text-slate-400 mt-1">Identificazione di top/bottom strutturali con 7 componenti pesati</p>
        </div>
        <div className="elegant-card p-8 flex flex-col items-center justify-center gap-4 text-center">
          <div className="w-12 h-12 rounded-full bg-slate-100 dark:bg-white/5 flex items-center justify-center">
            <svg className="w-6 h-6 text-slate-400" fill="none" stroke="currentColor" strokeWidth="1.5" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M7 16V4m0 0L3 8m4-4l4 4M17 8v12m0 0l4-4m-4 4l-4-4"/>
            </svg>
          </div>
          <div>
            <p className="text-sm font-bold text-slate-700 dark:text-slate-300">Reversal Detector Disabilitato</p>
            <p className="text-xs text-slate-400 dark:text-slate-500 mt-1">Abilita <strong>reversal_mode_enabled</strong> nel pannello Bot Config per attivare il rilevamento inversioni strutturali.</p>
          </div>
        </div>
      </div>
    );
  }

  const rev = data?.result ?? null;
  const pnd = data?.pending ?? null;
  const dir = rev?.direction ?? null;
  const ds  = dirStyle(dir);

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-xl font-bold text-slate-900 dark:text-white">Reversal Zone Detector</h2>
          <p className="text-sm text-slate-500 dark:text-slate-400 mt-1">7 componenti pesati · polling 30s</p>
        </div>
        {lastUpdated && (
          <div className="text-[10px] text-slate-400 dark:text-slate-500 font-mono shrink-0 mt-1">
            Aggiornato {lastUpdated}
          </div>
        )}
      </div>

      {error && (
        <div className="elegant-card p-4 border-l-4 border-red-400 bg-red-50 dark:bg-red-500/5">
          <p className="text-xs text-red-600 dark:text-red-400 font-medium">Errore: {error}</p>
        </div>
      )}

      {loading && !data && (
        <div className="elegant-card p-8 flex items-center justify-center">
          <div className="w-5 h-5 border-2 border-violet-500/30 border-t-violet-500 rounded-full animate-spin" />
        </div>
      )}

      {data && (
        <>
          {/* ── Score Card ── */}
          <div className="elegant-card p-6 bg-white dark:bg-[#151E32]">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-xs font-bold text-slate-500 dark:text-slate-400 uppercase tracking-widest">Score Corrente</h3>
              {rev && (
                <span className={`px-2.5 py-1 rounded-lg text-[10px] font-bold uppercase tracking-wider ${ds.badge}`}>
                  {dir ? dir.toUpperCase() : 'NO SIGNAL'}
                </span>
              )}
            </div>

            {rev ? (
              <div className="space-y-4">
                {/* Score bar */}
                <div>
                  <div className="flex justify-between items-end mb-1.5">
                    <span className="text-3xl font-black text-slate-900 dark:text-white">
                      {fmtScore(rev.score)}
                    </span>
                    <span className="text-xs text-slate-400 dark:text-slate-500 mb-1">
                      {rev.component_count}/7 componenti attivi
                    </span>
                  </div>
                  <div className="w-full h-2 bg-slate-100 dark:bg-white/5 rounded-full overflow-hidden">
                    <div
                      className={`h-full rounded-full transition-all duration-700 ${rev.score >= 0.72 ? 'bg-violet-500' : rev.score >= 0.50 ? 'bg-amber-400' : 'bg-slate-300 dark:bg-slate-600'}`}
                      style={{ width: `${Math.min(100, rev.score * 100)}%` }}
                    />
                  </div>
                  <div className="flex justify-between text-[9px] text-slate-400 dark:text-slate-600 mt-0.5">
                    <span>0</span>
                    <span className="text-violet-500">soglia 72%</span>
                    <span>100%</span>
                  </div>
                </div>

                {/* Reasoning toggle */}
                {rev.reasoning.length > 0 && (
                  <button onClick={() => setShowReason(r => !r)}
                    className="flex items-center gap-1.5 text-[10px] font-semibold text-slate-400 dark:text-slate-500 hover:text-violet-500 transition-colors">
                    <svg className={`w-3.5 h-3.5 transition-transform ${showReason ? 'rotate-90' : ''}`} fill="none" stroke="currentColor" strokeWidth="2.5" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7"/>
                    </svg>
                    {showReason ? 'Nascondi' : 'Mostra'} reasoning ({rev.reasoning.length} righe)
                  </button>
                )}
                {showReason && (
                  <div className="rounded-xl bg-slate-50 dark:bg-white/[0.03] border border-slate-100 dark:border-white/5 p-3 space-y-1">
                    {rev.reasoning.map((r, i) => (
                      <p key={i} className="text-[10px] font-mono text-slate-600 dark:text-slate-400 leading-relaxed">{r}</p>
                    ))}
                  </div>
                )}
              </div>
            ) : (
              <div className="flex items-center gap-3 py-2">
                <div className={`w-2.5 h-2.5 rounded-full ${data.reversal_enabled ? 'bg-amber-400' : 'bg-slate-300 dark:bg-slate-600'}`} />
                <p className="text-sm text-slate-500 dark:text-slate-400">
                  {!data.reversal_enabled
                    ? 'Detector disabilitato'
                    : data.position_open
                    ? 'Posizione aperta — analisi disponibile al ciclo 4H successivo'
                    : 'In attesa del primo ciclo 4H dall\'avvio'}
                </p>
              </div>
            )}
          </div>

          {/* ── 7 Componenti ── */}
          {rev && (
            <div className="elegant-card p-6 bg-white dark:bg-[#151E32]">
              <h3 className="text-xs font-bold text-slate-500 dark:text-slate-400 uppercase tracking-widest mb-4">
                Breakdown Componenti
              </h3>
              <div className="space-y-3">
                {(Object.keys(COMPONENT_WEIGHTS) as (keyof ReversalComponents)[]).map(key => {
                  const score  = rev.components[key] ?? 0;
                  const weight = COMPONENT_WEIGHTS[key];
                  const contribution = score * weight;
                  return (
                    <div key={key}>
                      <div className="flex items-center justify-between mb-1">
                        <div className="flex items-center gap-2">
                          <Tooltip content={`Peso: ${(weight * 100).toFixed(0)}% · Contributo: ${(contribution * 100).toFixed(1)}%`}>
                            <span className="text-[10px] font-semibold text-slate-600 dark:text-slate-400 cursor-help">
                              {COMPONENT_LABELS[key]}
                            </span>
                          </Tooltip>
                          <span className="text-[9px] text-slate-400 dark:text-slate-500">×{(weight * 100).toFixed(0)}%</span>
                        </div>
                        <span className={`text-[10px] font-bold ${score >= 0.6 ? 'text-emerald-500' : score >= 0.3 ? 'text-amber-400' : 'text-slate-400 dark:text-slate-500'}`}>
                          {fmtScore(score)}
                        </span>
                      </div>
                      <div className="w-full h-1.5 bg-slate-100 dark:bg-white/5 rounded-full overflow-hidden">
                        <div
                          className={`h-full rounded-full transition-all duration-500 ${componentColor(score)}`}
                          style={{ width: `${Math.min(100, score * 100)}%` }}
                        />
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* ── Pending State Card ── */}
          {pnd ? (
            <div className="elegant-card p-6 bg-white dark:bg-[#151E32] border border-violet-200 dark:border-violet-500/30">
              <div className="flex items-center justify-between mb-4">
                <h3 className="text-xs font-bold text-slate-500 dark:text-slate-400 uppercase tracking-widest">
                  Pending Limit Retest
                </h3>
                <span className={`px-2.5 py-1 rounded-lg text-[10px] font-bold uppercase tracking-wider animate-pulse ${dirStyle(pnd.direction).badge}`}>
                  {pnd.direction.toUpperCase()} — IN ATTESA
                </span>
              </div>
              <div className="grid grid-cols-3 gap-4">
                <div className="flex flex-col gap-0.5">
                  <span className="text-[9px] font-bold text-slate-400 dark:text-slate-500 uppercase tracking-widest">Entry Limit</span>
                  <span className="text-sm font-black text-violet-600 dark:text-violet-400">${fmtPrice(pnd.entry_limit)}</span>
                </div>
                <div className="flex flex-col gap-0.5">
                  <span className="text-[9px] font-bold text-slate-400 dark:text-slate-500 uppercase tracking-widest">Stop Loss</span>
                  <span className="text-sm font-black text-red-500 dark:text-red-400">${fmtPrice(pnd.sl)}</span>
                </div>
                <div className="flex flex-col gap-0.5">
                  <span className="text-[9px] font-bold text-slate-400 dark:text-slate-500 uppercase tracking-widest">Take Profit</span>
                  <span className="text-sm font-black text-emerald-500 dark:text-emerald-400">${fmtPrice(pnd.tp)}</span>
                </div>
              </div>
              <div className="mt-3 pt-3 border-t border-slate-100 dark:border-white/5 flex items-center justify-between">
                <span className="text-[9px] text-slate-400 dark:text-slate-500">
                  R:R = {pnd.entry_limit > 0 && pnd.sl > 0 && pnd.tp > 0
                    ? (Math.abs(pnd.tp - pnd.entry_limit) / Math.abs(pnd.entry_limit - pnd.sl)).toFixed(2)
                    : '—'}:1
                </span>
                <span className="text-[9px] text-slate-400 dark:text-slate-500">
                  Scade barra #{pnd.expiry_bar} · ATR {fmtPrice(pnd.atr_at_signal)}
                </span>
              </div>
            </div>
          ) : (
            <div className="elegant-card p-4 bg-white dark:bg-[#151E32]">
              <div className="flex items-center gap-2 text-slate-400 dark:text-slate-500">
                <div className="w-1.5 h-1.5 rounded-full bg-slate-300 dark:bg-slate-600" />
                <span className="text-xs">Nessun pending reversal attivo</span>
              </div>
            </div>
          )}

          {/* ── History ── */}
          {history.length > 0 && (
            <div className="elegant-card p-6 bg-white dark:bg-[#151E32]">
              <h3 className="text-xs font-bold text-slate-500 dark:text-slate-400 uppercase tracking-widest mb-4">
                Segnali Recenti
              </h3>
              <div className="space-y-2 max-h-64 overflow-y-auto">
                {history.map((h, i) => {
                  const hds = dirStyle(h.direction);
                  return (
                    <div key={i} className="flex items-center justify-between py-1.5 border-b border-slate-50 dark:border-white/3 last:border-0">
                      <div className="flex items-center gap-2">
                        <div className={`w-1.5 h-1.5 rounded-full ${hds.dot}`} />
                        <span className={`text-[10px] font-bold uppercase ${hds.text}`}>
                          {h.direction ?? 'no signal'}
                        </span>
                      </div>
                      <div className="flex items-center gap-3">
                        <div className="w-16 h-1 bg-slate-100 dark:bg-white/5 rounded-full overflow-hidden">
                          <div className="h-full bg-violet-400 rounded-full" style={{ width: `${Math.min(100, h.score * 100)}%` }} />
                        </div>
                        <span className="text-[10px] font-mono text-slate-500 dark:text-slate-400 w-8 text-right">{fmtScore(h.score)}</span>
                        <span className="text-[10px] text-slate-400 dark:text-slate-500 w-10 text-right">{fmtTime(h.detected_at)}</span>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
};
