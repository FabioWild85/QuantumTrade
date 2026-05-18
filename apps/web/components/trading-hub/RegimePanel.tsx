import React, { useEffect, useState, useCallback } from 'react';
import { Tooltip } from './Tooltip';

// ── Types ─────────────────────────────────────────────────────────────────────

type RegimeName = 'uptrend' | 'downtrend' | 'sideways' | 'flat' | 'transition';

interface RegimeSignal {
  regime:          RegimeName;
  confidence:      number;
  adx:             number;
  atr_percentile:  number;
  trend_slope_pct: number;
  bb_width_pct:    number;
  bars_in_regime:  number;
  transition_risk: number;
  reasoning:       string[];
}

interface RegimeResponse {
  regime_signal: RegimeSignal | null;
}

interface HistoryEntry {
  id:              number;
  detected_at:     string;
  regime:          RegimeName;
  confidence:      number;
  adx:             number;
  bars_in_regime:  number;
  transition_risk: number;
  profile_applied: string | null;
}

// ── Colour palette per regime ─────────────────────────────────────────────────

const REGIME_STYLE: Record<RegimeName, {
  dot: string; badge: string; text: string; border: string; bg: string;
}> = {
  uptrend:    { dot: 'bg-emerald-500',  badge: 'bg-emerald-500/15 text-emerald-400',  text: 'text-emerald-400',  border: 'border-emerald-500/30', bg: 'bg-emerald-500/8'  },
  downtrend:  { dot: 'bg-red-500',      badge: 'bg-red-500/15 text-red-400',          text: 'text-red-400',      border: 'border-red-500/30',     bg: 'bg-red-500/8'      },
  sideways:   { dot: 'bg-amber-400',    badge: 'bg-amber-400/15 text-amber-400',      text: 'text-amber-400',    border: 'border-amber-400/30',   bg: 'bg-amber-400/8'    },
  flat:       { dot: 'bg-slate-400',    badge: 'bg-slate-400/15 text-slate-400',      text: 'text-slate-400',    border: 'border-slate-400/30',   bg: 'bg-slate-400/8'    },
  transition: { dot: 'bg-orange-400',   badge: 'bg-orange-400/15 text-orange-400',    text: 'text-orange-400',   border: 'border-orange-400/30',  bg: 'bg-orange-400/8'   },
};

const REGIME_LABEL: Record<RegimeName, string> = {
  uptrend:   'Uptrend',
  downtrend: 'Downtrend',
  sideways:  'Sideways',
  flat:      'Flat',
  transition:'Transition',
};

const REGIME_ICON: Record<RegimeName, React.ReactNode> = {
  uptrend:    <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path d="M5 17l5-5 4 4 5-6"/><path d="M15 10h4v4"/></svg>,
  downtrend:  <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path d="M5 7l5 5 4-4 5 6"/><path d="M15 14h4v-4"/></svg>,
  sideways:   <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path d="M5 12h14M16 8l4 4-4 4"/></svg>,
  flat:       <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path d="M5 12h14"/></svg>,
  transition: <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4"/></svg>,
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function formatParamValue(v: unknown): string {
  if (typeof v === 'boolean') return v ? 'ON' : 'OFF';
  if (typeof v === 'number')  return Number.isInteger(v) ? String(v) : v.toFixed(2);
  return String(v ?? '—');
}

function formatParamName(k: string): string {
  return k.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

function barsToTime(bars: number): string {
  const h = bars * 4;
  if (h < 48)  return `${h}h`;
  if (h < 168) return `${Math.round(h / 24)}d`;
  return `${Math.round(h / 168)}w`;
}

// ── Sub-components ────────────────────────────────────────────────────────────

const ProgressBar: React.FC<{
  value: number; max?: number; color?: string; thin?: boolean;
}> = ({ value, max = 1, color = 'bg-indigo-500', thin = false }) => {
  const pct = Math.min(100, Math.max(0, (value / max) * 100));
  return (
    <div className={`w-full bg-slate-200 dark:bg-white/5 rounded-full overflow-hidden ${thin ? 'h-1' : 'h-1.5'}`}>
      <div
        className={`${color} h-full rounded-full transition-all duration-500`}
        style={{ width: `${pct}%` }}
      />
    </div>
  );
};

const StatBox: React.FC<{
  label: string; value: string | number; sub?: string; tip?: string;
}> = ({ label, value, sub, tip }) => (
  <div className="flex flex-col gap-0.5">
    <span className="text-[10px] font-medium text-slate-500 uppercase tracking-wide">
      {tip ? <Tooltip text={tip} pos="top" width="wide"><span className="cursor-help border-b border-dashed border-slate-400 dark:border-slate-600">{label}</span></Tooltip> : label}
    </span>
    <span className="text-sm font-semibold text-slate-900 dark:text-slate-100">{value}</span>
    {sub && <span className="text-[10px] text-slate-500">{sub}</span>}
  </div>
);

// ── Regime history mini-chart ─────────────────────────────────────────────────

const HistoryBar: React.FC<{ entries: HistoryEntry[] }> = ({ entries }) => {
  if (entries.length === 0) return null;
  const recent = [...entries].reverse().slice(-48);
  return (
    <div className="flex items-end gap-px h-8">
      {recent.map((e, i) => {
        const style = REGIME_STYLE[e.regime as RegimeName] ?? REGIME_STYLE.sideways;
        return (
          <Tooltip
            key={e.id ?? i}
            text={`${REGIME_LABEL[e.regime as RegimeName]} · conf ${(e.confidence * 100).toFixed(0)}% · ADX ${e.adx?.toFixed(1)} · ${barsToTime(e.bars_in_regime)}`}
            pos="top"
          >
            <div
              className={`flex-1 min-w-[4px] rounded-sm ${style.dot} opacity-70 hover:opacity-100 transition-opacity`}
              style={{ height: `${Math.round(20 + e.confidence * 12)}px` }}
            />
          </Tooltip>
        );
      })}
    </div>
  );
};

// ── Main component ────────────────────────────────────────────────────────────

export const RegimePanel: React.FC<{ apiBase: string }> = ({ apiBase }) => {
  const [data,           setData]          = useState<RegimeResponse | null>(null);
  const [history,        setHistory]       = useState<HistoryEntry[]>([]);
  const [loading,        setLoading]       = useState(true);
  const [error,          setError]         = useState<string | null>(null);
  const [showReasoning,  setShowReasoning] = useState(false);

  const fetchData = useCallback(async () => {
    try {
      const [r1, r2] = await Promise.all([
        fetch(`${apiBase}/regime/current`,       { signal: AbortSignal.timeout(8000) }),
        fetch(`${apiBase}/regime/history?limit=48`, { signal: AbortSignal.timeout(8000) }),
      ]);
      if (r1.ok) setData(await r1.json());
      else        setError('API error');
      if (r2.ok) setHistory(await r2.json());
    } catch {
      setError('Connection error');
    } finally {
      setLoading(false);
    }
  }, [apiBase]);

  useEffect(() => {
    fetchData();
    const id = setInterval(fetchData, 30_000);
    return () => clearInterval(id);
  }, [fetchData]);

  // ── Render states ─────────────────────────────────────────────────────────

  if (loading) {
    return (
      <div className="flex items-center justify-center h-48 text-slate-500 text-sm">
        <svg className="animate-spin w-4 h-4 mr-2" viewBox="0 0 24 24" fill="none">
          <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" strokeDasharray="40" strokeDashoffset="10"/>
        </svg>
        Loading regime data…
      </div>
    );
  }

  const signal = data?.regime_signal;

  const style    = signal ? (REGIME_STYLE[signal.regime] ?? REGIME_STYLE.sideways) : REGIME_STYLE.sideways;
  const label    = signal ? REGIME_LABEL[signal.regime] : 'Unknown';

  return (
    <div className="space-y-4 max-w-4xl">

      {/* Header row */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-base font-bold text-slate-900 dark:text-slate-100">Regime Detection</h2>
          <p className="text-xs text-slate-500 mt-0.5">
            Automatic market regime classifier — runs every 4 cycles (≈16h)
          </p>
        </div>
        <button
          onClick={() => { setLoading(true); fetchData(); }}
          className="text-xs text-slate-500 dark:text-slate-400 hover:text-indigo-500 dark:hover:text-indigo-400 flex items-center gap-1.5 transition-colors"
        >
          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
            <path d="M1 4v6h6M23 20v-6h-6"/><path d="M20.49 9A9 9 0 0 0 5.64 5.64L1 10M23 14l-4.64 4.36A9 9 0 0 1 3.51 15"/>
          </svg>
          Refresh
        </button>
      </div>

      {error && (
        <div className="text-xs text-red-400 bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-2">
          {error} — check API connection
        </div>
      )}

      {/* Main card grid */}
      <div className="grid grid-cols-1 gap-4">

        {/* Left — regime status card */}
        <div className={`rounded-xl border ${style.border} ${style.bg} p-5 space-y-4`}>
          {signal ? (
            <>
              {/* Regime badge + label */}
              <div className="flex items-start justify-between">
                <div className="space-y-1">
                  <div className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-sm font-semibold ${style.badge}`}>
                    <span className={`w-2 h-2 rounded-full ${style.dot} animate-pulse`} />
                    {REGIME_ICON[signal.regime]}
                    {label}
                  </div>
                </div>
                <Tooltip text="Probabilità che il regime rilevato sia corretto. <50% = segnale debole, 50–70% = moderato, >70% = forte." pos="top" width="wide">
                  <div className="text-right text-xs text-slate-500 cursor-help">
                    <div className="text-slate-700 dark:text-slate-300 font-medium">{(signal.confidence * 100).toFixed(0)}%</div>
                    <div>confidence</div>
                  </div>
                </Tooltip>
              </div>

              {/* Confidence bar */}
              <div className="space-y-1">
                <ProgressBar value={signal.confidence} color={signal.confidence > 0.7 ? style.dot : 'bg-slate-500'} />
              </div>

              {/* Stats grid */}
              <div className="grid grid-cols-2 gap-x-4 gap-y-3">
                <StatBox
                  label="ADX"
                  value={signal.adx.toFixed(1)}
                  sub={signal.adx < 15 ? 'compression' : signal.adx < 22 ? 'moderate' : 'strong trend'}
                  tip="Average Directional Index — trend strength. <15 flat, 15–22 sideways, >22 trending"
                />
                <StatBox
                  label="Duration"
                  value={`${signal.bars_in_regime} bars`}
                  sub={barsToTime(signal.bars_in_regime)}
                  tip="Consecutive 4H candles classified in this regime"
                />
                <StatBox
                  label="EMA Slope"
                  value={`${signal.trend_slope_pct >= 0 ? '+' : ''}${signal.trend_slope_pct.toFixed(3)}%`}
                  sub="per 4H candle"
                  tip="EMA20 slope in % per candle. >+0.5 = uptrend, <−0.5 = downtrend"
                />
                <StatBox
                  label="ATR Rank"
                  value={`P${signal.atr_percentile.toFixed(0)}`}
                  sub={signal.atr_percentile < 30 ? 'low vol' : signal.atr_percentile > 70 ? 'high vol' : 'normal vol'}
                  tip="Current ATR vs last 90 bars — P50 is normal, P80+ is elevated volatility"
                />
                <StatBox
                  label="BB Width"
                  value={`${signal.bb_width_pct.toFixed(2)}%`}
                  tip="Bollinger Band width as % of price — low = compression, high = expansion"
                />
              </div>

              {/* Transition risk */}
              {signal.transition_risk > 0.15 && (
                <div className="space-y-1.5 pt-1 border-t border-slate-200/60 dark:border-white/5">
                  <div className="flex items-center justify-between text-xs">
                    <Tooltip text="Probabilità che il mercato stia per cambiare regime nelle prossime 4–8 candele. >50% = attenzione, >65% = applica cautela extra." pos="top" width="wide">
                      <span className={`font-medium cursor-help border-b border-dashed ${signal.transition_risk > 0.50 ? 'text-orange-500 dark:text-orange-400 border-orange-400/40' : 'text-slate-600 dark:text-slate-400 border-slate-400/40 dark:border-slate-600/40'}`}>
                        {signal.transition_risk > 0.50 ? '⚠ ' : ''}Transition Risk
                      </span>
                    </Tooltip>
                    <span className={signal.transition_risk > 0.50 ? 'text-orange-500 dark:text-orange-400' : 'text-slate-600 dark:text-slate-400'}>
                      {(signal.transition_risk * 100).toFixed(0)}%
                    </span>
                  </div>
                  <ProgressBar
                    value={signal.transition_risk}
                    color={signal.transition_risk > 0.50 ? 'bg-orange-400' : 'bg-slate-500'}
                    thin
                  />
                </div>
              )}

              {/* Reasoning toggle */}
              <button
                onClick={() => setShowReasoning(v => !v)}
                className="text-xs text-slate-500 hover:text-slate-700 dark:hover:text-slate-300 flex items-center gap-1 transition-colors"
              >
                <svg className={`w-3 h-3 transition-transform ${showReasoning ? 'rotate-90' : ''}`} fill="currentColor" viewBox="0 0 20 20">
                  <path fillRule="evenodd" d="M7.293 14.707a1 1 0 010-1.414L10.586 10 7.293 6.707a1 1 0 011.414-1.414l4 4a1 1 0 010 1.414l-4 4a1 1 0 01-1.414 0z" clipRule="evenodd"/>
                </svg>
                {showReasoning ? 'Hide' : 'Show'} classification reasoning
              </button>

              {showReasoning && (
                <div className="rounded-lg bg-slate-100 dark:bg-black/20 border border-slate-200 dark:border-white/5 p-3 space-y-1">
                  {signal.reasoning.map((r, i) => (
                    <p key={i} className="text-[11px] font-mono text-slate-600 dark:text-slate-400 leading-relaxed">{r}</p>
                  ))}
                </div>
              )}
            </>
          ) : (
            <div className="flex flex-col items-center justify-center py-8 text-slate-500 space-y-2">
              <svg className="w-8 h-8 opacity-40" fill="none" stroke="currentColor" strokeWidth="1.5" viewBox="0 0 24 24">
                <path d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"/>
              </svg>
              <p className="text-sm">No regime data yet</p>
              <p className="text-xs text-center">
                Regime detection runs on the first cycle after the bot starts,<br />
                or when a new candle closes (every 4 cycles ≈ 16h).
              </p>
            </div>
          )}
        </div>

      </div>

      {/* Regime history */}
      {history.length > 0 && (
        <div className="rounded-xl border border-slate-200 dark:border-white/8 bg-slate-50 dark:bg-white/3 p-5 space-y-3">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold text-slate-800 dark:text-slate-200">Recent Regime History</h3>
            <span className="text-xs text-slate-500">{history.length} snapshots</span>
          </div>

          {/* Mini bar chart */}
          <HistoryBar entries={history} />

          {/* Legend */}
          <div className="flex flex-wrap gap-x-4 gap-y-1">
            {(Object.keys(REGIME_LABEL) as RegimeName[]).map(r => (
              <div key={r} className="flex items-center gap-1.5 text-xs text-slate-500">
                <span className={`w-2 h-2 rounded-full ${REGIME_STYLE[r].dot}`} />
                {REGIME_LABEL[r]}
              </div>
            ))}
          </div>

          {/* Recent table */}
          <div className="rounded-lg border border-slate-200 dark:border-white/8 overflow-hidden">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-slate-200 dark:border-white/8 bg-slate-100/50 dark:bg-white/3">
                  <th className="text-left px-3 py-2 text-slate-500 font-medium">Time</th>
                  <th className="text-left px-3 py-2 text-slate-500 font-medium">Regime</th>
                  <th className="text-right px-3 py-2 text-slate-500 font-medium">Conf</th>
                  <th className="text-right px-3 py-2 text-slate-500 font-medium">ADX</th>
                  <th className="text-right px-3 py-2 text-slate-500 font-medium">Duration</th>
                  <th className="text-right px-3 py-2 text-slate-500 font-medium">T-Risk</th>
                </tr>
              </thead>
              <tbody>
                {history.slice(0, 10).map((e, i) => {
                  const s = REGIME_STYLE[e.regime as RegimeName] ?? REGIME_STYLE.sideways;
                  return (
                    <tr key={e.id ?? i} className="border-b border-slate-100 dark:border-white/5 hover:bg-slate-50 dark:hover:bg-white/2 transition-colors">
                      <td className="px-3 py-1.5 text-slate-500">
                        {new Date(e.detected_at).toLocaleString('it-IT', {
                          month: 'short', day: '2-digit',
                          hour: '2-digit', minute: '2-digit',
                        })}
                      </td>
                      <td className="px-3 py-1.5">
                        <span className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[10px] font-semibold ${s.badge}`}>
                          <span className={`w-1.5 h-1.5 rounded-full ${s.dot}`} />
                          {REGIME_LABEL[e.regime as RegimeName]}
                        </span>
                      </td>
                      <td className="px-3 py-1.5 text-right text-slate-700 dark:text-slate-300">
                        {(e.confidence * 100).toFixed(0)}%
                      </td>
                      <td className="px-3 py-1.5 text-right text-slate-600 dark:text-slate-400">
                        {e.adx?.toFixed(1) ?? '—'}
                      </td>
                      <td className="px-3 py-1.5 text-right text-slate-600 dark:text-slate-400">
                        {e.bars_in_regime} bars
                      </td>
                      <td className={`px-3 py-1.5 text-right font-medium ${
                        e.transition_risk > 0.50 ? 'text-orange-500 dark:text-orange-400' : 'text-slate-500'}`}>
                        {e.transition_risk > 0 ? `${(e.transition_risk * 100).toFixed(0)}%` : '—'}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Info footer */}
      <div className="text-xs text-slate-500 border-t border-slate-200 dark:border-white/5 pt-3 space-y-1">
        <p>
          <span className="text-slate-400 dark:text-slate-500">Classification:</span>{' '}
          ADX {'<'}15 → Flat · ADX 15–22 → Sideways · ADX ≥22 + slope → Up/Downtrend · ADX peaked {'>'} 35 declining → Transition
        </p>
        {history.length === 0 && (
          <p className="text-orange-400/70">
            No history yet — the <code className="bg-slate-100 dark:bg-white/5 px-1 rounded">regime_log</code> table needs to be created in Supabase first.
            See the SQL comment in <code className="bg-slate-100 dark:bg-white/5 px-1 rounded">GET /regime/history</code>.
          </p>
        )}
      </div>
    </div>
  );
};
