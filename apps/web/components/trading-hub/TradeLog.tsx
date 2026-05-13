import React, { useEffect, useState } from 'react';

interface Trade {
  id: string;
  side: string;
  symbol: string;
  pnl_usd: number | null;
  pnl_pct: number | null;
  reason_close: string | null;
  opened_at: string;
  closed_at: string | null;
  holding_sec: number | null;
}

interface InferenceLog {
  id: string;
  time: string;
  decision: string;
  reasoning: string[];
  forecast: {
    c2_dir_prob?: number;
    lgbm_prob?: number;
    c2_p10?: number;
    c2_p50?: number;
    c2_p90?: number;
    latency_ms?: number;
  };
  features: Record<string, number>;
}

// Key features shown in the inference detail panel (in order of importance)
const KEY_FEATURES = [
  { key: 'd_ema20_dist', label: 'MTF EMA20 dist', desc: 'Distanza EMA20 daily (feature #1)' },
  { key: 'adx_14',       label: 'ADX(14)',         desc: 'Forza del trend (gate <20)' },
  { key: 'rsi_14',       label: 'RSI(14)',          desc: 'Momentum oscillatore' },
  { key: 'delta_price_div', label: 'CVD Div',      desc: 'Divergenza CVD/prezzo' },
  { key: 'ob_bull_dist',  label: 'OB Bull dist',   desc: 'Distanza Order Block rialzista (ATR)' },
  { key: 'funding_z',    label: 'Funding Z',        desc: 'Z-score funding rate' },
  { key: 'oi_ma_ratio',  label: 'OI ratio',         desc: 'OI / media mobile OI' },
  { key: 'vol_imbalance', label: 'Vol imbalance',  desc: 'Buy vol / total vol (CVD proxy)' },
  { key: 'mtf_aligned',  label: 'MTF align',        desc: 'BOS allineato con regime daily' },
];

export const TradeLog: React.FC<{ apiBase: string }> = ({ apiBase }) => {
  const [trades,   setTrades]   = useState<Trade[]>([]);
  const [logs,     setLogs]     = useState<InferenceLog[]>([]);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [tab,      setTab]      = useState<'trades' | 'inference'>('trades');
  const [loading,  setLoading]  = useState(true);

  useEffect(() => {
    setLoading(true);
    Promise.all([
      fetch(`${apiBase}/trades?limit=100`).then(r => r.ok ? r.json() : []),
      fetch(`${apiBase}/inference-logs?limit=30`).then(r => r.ok ? r.json() : []),
    ]).then(([t, l]) => {
      setTrades(t ?? []);
      setLogs(l ?? []);
    }).catch(() => {}).finally(() => setLoading(false));
  }, [apiBase]);

  const hms = (sec: number | null) => {
    if (!sec) return '—';
    const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60);
    return `${h}h ${m}m`;
  };

  // ── Aggregate stats ────────────────────────────────────────────────────────
  const closed  = trades.filter(t => t.closed_at);
  const wins    = closed.filter(t => (t.pnl_usd ?? 0) > 0);
  const losses  = closed.filter(t => (t.pnl_usd ?? 0) <= 0);
  const totalPnl = closed.reduce((s, t) => s + (t.pnl_usd ?? 0), 0);
  const winRate  = closed.length > 0 ? wins.length / closed.length * 100 : 0;
  const avgWin   = wins.length > 0   ? wins.reduce((s, t) => s + (t.pnl_pct ?? 0), 0) / wins.length : 0;
  const avgLoss  = losses.length > 0 ? losses.reduce((s, t) => s + (t.pnl_pct ?? 0), 0) / losses.length : 0;
  const pf       = losses.length > 0 && avgLoss !== 0 ? Math.abs(avgWin * wins.length / (avgLoss * losses.length)) : null;

  return (
    <div className="space-y-4">

      {/* ── Stats strip (only when trades exist) ──────────────────────────── */}
      {closed.length > 0 && (
        <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-6 gap-3">
          <StatChip label="Trade chiusi" value={String(closed.length)} />
          <StatChip
            label="Win Rate"
            value={`${winRate.toFixed(1)}%`}
            color={winRate >= 55 ? 'text-emerald-400' : winRate >= 50 ? 'text-amber-400' : 'text-red-400'}
          />
          <StatChip
            label="PnL Totale"
            value={`${totalPnl >= 0 ? '+' : ''}$${totalPnl.toFixed(2)}`}
            color={totalPnl >= 0 ? 'text-emerald-400' : 'text-red-400'}
          />
          <StatChip label="Avg Win"  value={`+${avgWin.toFixed(2)}%`}  color="text-emerald-400" />
          <StatChip label="Avg Loss" value={`${avgLoss.toFixed(2)}%`}  color="text-red-400" />
          {pf !== null && (
            <StatChip
              label="Profit Factor"
              value={pf.toFixed(2)}
              color={pf >= 1.5 ? 'text-emerald-400' : pf >= 1.0 ? 'text-amber-400' : 'text-red-400'}
            />
          )}
        </div>
      )}

      {/* ── Tabs ──────────────────────────────────────────────────────────── */}
      <div className="flex gap-2">
        <TabBtn active={tab === 'trades'}    onClick={() => setTab('trades')}>
          Trade ({trades.length})
        </TabBtn>
        <TabBtn active={tab === 'inference'} onClick={() => setTab('inference')}>
          Inference Log ({logs.length})
        </TabBtn>
      </div>

      {/* ── Trades table ──────────────────────────────────────────────────── */}
      {tab === 'trades' && (
        <div className="rounded-2xl bg-dark-card border border-dark-border overflow-hidden">
          {loading ? (
            <div className="p-8 text-center text-slate-500 text-sm">Caricamento…</div>
          ) : trades.length === 0 ? (
            <div className="p-8 text-center text-slate-500 text-sm">
              Nessun trade ancora. Avvia il bot in Paper Trading.
            </div>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-dark-border text-xs text-slate-500 uppercase tracking-wide">
                  <th className="px-4 py-3 text-left">Data apertura</th>
                  <th className="px-4 py-3 text-left">Side</th>
                  <th className="px-4 py-3 text-right">PnL netto</th>
                  <th className="px-4 py-3 text-left hidden sm:table-cell">Chiusura</th>
                  <th className="px-4 py-3 text-right hidden sm:table-cell">Durata</th>
                </tr>
              </thead>
              <tbody>
                {trades.map(t => {
                  const pnl     = t.pnl_usd ?? 0;
                  const pnlPct  = t.pnl_pct ?? 0;
                  const isOpen  = !t.closed_at;
                  return (
                    <tr key={t.id} className="border-b border-dark-border/50 hover:bg-white/5 transition-colors">
                      <td className="px-4 py-3 font-mono text-slate-400 text-xs">
                        {new Date(t.opened_at).toLocaleString('it-IT', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}
                      </td>
                      <td className="px-4 py-3">
                        <span className={`px-2 py-0.5 rounded text-xs font-bold ${
                          t.side === 'long' ? 'bg-emerald-500/20 text-emerald-400'
                                           : 'bg-red-500/20 text-red-400'
                        }`}>
                          {t.side?.toUpperCase()}
                        </span>
                      </td>
                      <td className={`px-4 py-3 text-right font-mono font-semibold text-xs ${
                        isOpen ? 'text-amber-400' : pnl >= 0 ? 'text-emerald-400' : 'text-red-400'
                      }`}>
                        {isOpen ? (
                          <span className="text-amber-500/60">Aperta…</span>
                        ) : (
                          <>
                            {pnl >= 0 ? '+' : ''}${pnl.toFixed(2)}
                            <span className="text-xs ml-1 opacity-60">
                              ({pnlPct >= 0 ? '+' : ''}{pnlPct.toFixed(2)}%)
                            </span>
                          </>
                        )}
                      </td>
                      <td className="px-4 py-3 text-slate-500 text-xs hidden sm:table-cell">
                        {t.reason_close
                          ? <ReasonBadge reason={t.reason_close} />
                          : <span className="text-slate-600">—</span>}
                      </td>
                      <td className="px-4 py-3 text-right font-mono text-slate-500 text-xs hidden sm:table-cell">
                        {hms(t.holding_sec)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      )}

      {/* ── Inference log ─────────────────────────────────────────────────── */}
      {tab === 'inference' && (
        <div className="space-y-2">
          {loading ? (
            <div className="p-8 text-center text-slate-500 text-sm">Caricamento…</div>
          ) : logs.length === 0 ? (
            <div className="p-8 text-center text-slate-500 text-sm">Nessun inference log. Il bot deve aver completato almeno un ciclo.</div>
          ) : (
            logs.map(log => (
              <div key={log.id} className="rounded-2xl bg-dark-card border border-dark-border overflow-hidden">
                {/* Header row */}
                <button
                  onClick={() => setExpanded(expanded === log.id ? null : log.id)}
                  className="w-full px-5 py-4 flex items-center justify-between text-left hover:bg-white/5 transition-colors"
                >
                  <div className="flex items-center gap-3">
                    <DecisionBadge decision={log.decision} />
                    <span className="text-xs font-mono text-slate-500">
                      {new Date(log.time).toLocaleString('it-IT')}
                    </span>
                    {log.forecast?.latency_ms && (
                      <span className="text-xs text-slate-600 font-mono hidden sm:inline">
                        {log.forecast.latency_ms.toFixed(0)}ms
                      </span>
                    )}
                    <span className="text-xs text-slate-700 font-mono hidden md:inline">#{log.id}</span>
                  </div>
                  <span className="text-slate-500 text-sm">{expanded === log.id ? '▲' : '▼'}</span>
                </button>

                {/* Expanded detail */}
                {expanded === log.id && (
                  <div className="px-5 pb-5 space-y-5 border-t border-dark-border">

                    {/* Reasoning */}
                    <div>
                      <p className="text-xs text-slate-500 uppercase tracking-wide mb-2 mt-4">Reasoning Pipeline</p>
                      <div className="space-y-1">
                        {(log.reasoning ?? []).map((r, i) => (
                          <div key={i} className={`text-xs font-mono px-3 py-1.5 rounded ${
                            r.startsWith('GATE') ? 'bg-red-500/10 text-red-400'
                            : r.startsWith('LONG') ? 'bg-emerald-500/10 text-emerald-400'
                            : r.startsWith('SHORT') ? 'bg-red-500/10 text-red-400'
                            : r.startsWith('MTF') ? 'bg-indigo-500/10 text-indigo-400'
                            : r.startsWith('FILTER') ? 'bg-amber-500/10 text-amber-400'
                            : 'bg-white/5 text-slate-400'
                          }`}>
                            → {r}
                          </div>
                        ))}
                      </div>
                    </div>

                    {/* Chronos-2 + LightGBM output */}
                    {log.forecast && (
                      <div>
                        <p className="text-xs text-slate-500 uppercase tracking-wide mb-2">Ensemble Output</p>
                        <div className="grid grid-cols-3 sm:grid-cols-6 gap-2 text-xs font-mono">
                          <FCell label="C2 P(up)"   value={`${((log.forecast.c2_dir_prob ?? 0) * 100).toFixed(1)}%`} />
                          <FCell label="LGBM P(up)" value={`${((log.forecast.lgbm_prob ?? 0) * 100).toFixed(1)}%`} />
                          <FCell label="p10" value={`$${(log.forecast.c2_p10 ?? 0).toFixed(0)}`} />
                          <FCell label="p50" value={`$${(log.forecast.c2_p50 ?? 0).toFixed(0)}`} highlight />
                          <FCell label="p90" value={`$${(log.forecast.c2_p90 ?? 0).toFixed(0)}`} />
                          <FCell label="Latency" value={`${(log.forecast.latency_ms ?? 0).toFixed(0)}ms`} />
                        </div>
                      </div>
                    )}

                    {/* Key features */}
                    {log.features && (
                      <div>
                        <p className="text-xs text-slate-500 uppercase tracking-wide mb-2">Feature Chiave (64 totali)</p>
                        <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                          {KEY_FEATURES.map(({ key, label, desc }) => {
                            const val = log.features[key];
                            if (val === undefined) return null;
                            return (
                              <FeatureCell
                                key={key}
                                label={label}
                                value={val}
                                desc={desc}
                              />
                            );
                          })}
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
};

// ── Sub-components ────────────────────────────────────────────────────────────

const StatChip: React.FC<{ label: string; value: string; color?: string }> = ({ label, value, color = 'text-white' }) => (
  <div className="rounded-xl bg-dark-card border border-dark-border px-4 py-3">
    <p className="text-xs text-slate-500 mb-0.5">{label}</p>
    <p className={`text-sm font-bold font-mono ${color}`}>{value}</p>
  </div>
);

const TabBtn: React.FC<{ active: boolean; onClick: () => void; children: React.ReactNode }> = ({ active, onClick, children }) => (
  <button
    onClick={onClick}
    className={`px-4 py-2 rounded-xl text-sm font-semibold transition-colors ${
      active ? 'bg-indigo-600 text-white' : 'bg-white/5 text-slate-400 hover:bg-white/10'
    }`}
  >
    {children}
  </button>
);

const DecisionBadge: React.FC<{ decision: string }> = ({ decision }) => (
  <span className={`px-2 py-0.5 rounded text-xs font-bold ${
    decision === 'long'  ? 'bg-emerald-500/20 text-emerald-400'
    : decision === 'short' ? 'bg-red-500/20 text-red-400'
    : 'bg-slate-500/20 text-slate-400'
  }`}>
    {decision?.toUpperCase()}
  </span>
);

const ReasonBadge: React.FC<{ reason: string }> = ({ reason }) => {
  const map: Record<string, string> = {
    stop_loss:   'bg-red-500/20 text-red-400',
    take_profit: 'bg-emerald-500/20 text-emerald-400',
    kill:        'bg-orange-500/20 text-orange-400',
    manual:      'bg-slate-500/20 text-slate-400',
  };
  return (
    <span className={`px-2 py-0.5 rounded text-xs ${map[reason] ?? 'bg-slate-500/20 text-slate-400'}`}>
      {reason}
    </span>
  );
};

const FCell: React.FC<{ label: string; value: string; highlight?: boolean }> = ({ label, value, highlight }) => (
  <div className={`rounded px-2 py-1.5 ${highlight ? 'bg-indigo-500/15 border border-indigo-500/20' : 'bg-white/5'}`}>
    <p className="text-slate-600 text-xs">{label}</p>
    <p className={`${highlight ? 'text-indigo-300' : 'text-slate-300'} font-mono`}>{value}</p>
  </div>
);

const FeatureCell: React.FC<{ label: string; value: number; desc: string }> = ({ label, value, desc }) => {
  const formatted = Math.abs(value) >= 1000 ? value.toFixed(0)
    : Math.abs(value) >= 1 ? value.toFixed(2) : value.toFixed(4);
  const isPositive = value > 0;

  return (
    <div className="bg-white/5 rounded px-2.5 py-2 group relative" title={desc}>
      <p className="text-xs text-slate-600 mb-0.5">{label}</p>
      <p className={`text-xs font-mono font-semibold ${
        isPositive ? 'text-emerald-400/80' : value < 0 ? 'text-red-400/80' : 'text-slate-400'
      }`}>
        {value > 0 ? '+' : ''}{formatted}
      </p>
    </div>
  );
};
