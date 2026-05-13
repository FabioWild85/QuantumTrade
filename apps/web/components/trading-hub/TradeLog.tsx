import React, { useEffect, useState } from 'react';

interface Trade {
  id: string;
  side: string;
  symbol: string;
  pnl_usd: number;
  pnl_pct: number;
  reason_close: string;
  opened_at: string;
  closed_at: string | null;
  holding_sec: number;
}

interface InferenceLog {
  id: string;
  time: string;
  decision: string;
  reasoning: string[];
  forecast: {
    c2_dir_prob?: number;
    c2_p10?: number;
    c2_p50?: number;
    c2_p90?: number;
    latency_ms?: number;
  };
  features: Record<string, number>;
}

export const TradeLog: React.FC<{ apiBase: string }> = ({ apiBase }) => {
  const [trades, setTrades]     = useState<Trade[]>([]);
  const [logs, setLogs]         = useState<InferenceLog[]>([]);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [tab, setTab]           = useState<'trades' | 'inference'>('trades');

  useEffect(() => {
    Promise.all([
      fetch(`${apiBase}/trades?limit=50`).then(r => r.ok ? r.json() : []),
      fetch(`${apiBase}/inference-logs?limit=20`).then(r => r.ok ? r.json() : []),
    ]).then(([t, l]) => {
      setTrades(t || []);
      setLogs(l || []);
    }).catch(() => {});
  }, [apiBase]);

  const holdingH = (sec: number) => {
    if (!sec) return '—';
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    return `${h}h ${m}m`;
  };

  return (
    <div className="space-y-4">
      <div className="flex gap-2">
        <button
          onClick={() => setTab('trades')}
          className={`px-4 py-2 rounded-xl text-sm font-semibold transition-colors ${tab === 'trades' ? 'bg-indigo-600 text-white' : 'bg-white/5 text-slate-400 hover:bg-white/10'}`}
        >
          Trade ({trades.length})
        </button>
        <button
          onClick={() => setTab('inference')}
          className={`px-4 py-2 rounded-xl text-sm font-semibold transition-colors ${tab === 'inference' ? 'bg-indigo-600 text-white' : 'bg-white/5 text-slate-400 hover:bg-white/10'}`}
        >
          Inference Log ({logs.length})
        </button>
      </div>

      {tab === 'trades' && (
        <div className="rounded-2xl bg-dark-card border border-dark-border overflow-hidden">
          {trades.length === 0 ? (
            <div className="p-8 text-center text-slate-500 text-sm">Nessun trade ancora. Avvia il bot in Paper Trading.</div>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-dark-border text-xs text-slate-500 uppercase tracking-wide">
                  <th className="px-4 py-3 text-left">Data</th>
                  <th className="px-4 py-3 text-left">Side</th>
                  <th className="px-4 py-3 text-right">PnL</th>
                  <th className="px-4 py-3 text-left">Motivo Chiusura</th>
                  <th className="px-4 py-3 text-right">Durata</th>
                </tr>
              </thead>
              <tbody>
                {trades.map(t => (
                  <tr key={t.id} className="border-b border-dark-border/50 hover:bg-white/5 transition-colors">
                    <td className="px-4 py-3 font-mono text-slate-400 text-xs">
                      {new Date(t.opened_at).toLocaleDateString('it-IT')}
                    </td>
                    <td className="px-4 py-3">
                      <span className={`px-2 py-0.5 rounded text-xs font-bold ${t.side === 'long' ? 'bg-emerald-500/20 text-emerald-400' : 'bg-red-500/20 text-red-400'}`}>
                        {t.side?.toUpperCase()}
                      </span>
                    </td>
                    <td className={`px-4 py-3 text-right font-mono font-semibold ${(t.pnl_usd ?? 0) >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                      {(t.pnl_usd ?? 0) >= 0 ? '+' : ''}${(t.pnl_usd ?? 0).toFixed(2)}
                      <span className="text-xs ml-1 opacity-60">({(t.pnl_pct ?? 0) >= 0 ? '+' : ''}{(t.pnl_pct ?? 0).toFixed(2)}%)</span>
                    </td>
                    <td className="px-4 py-3 text-slate-400 text-xs">{t.reason_close ?? '—'}</td>
                    <td className="px-4 py-3 text-right font-mono text-slate-400 text-xs">{holdingH(t.holding_sec)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}

      {tab === 'inference' && (
        <div className="space-y-3">
          {logs.length === 0 ? (
            <div className="p-8 text-center text-slate-500 text-sm">Nessun inference log ancora.</div>
          ) : (
            logs.map(log => (
              <div key={log.id} className="rounded-2xl bg-dark-card border border-dark-border overflow-hidden">
                <button
                  onClick={() => setExpanded(expanded === log.id ? null : log.id)}
                  className="w-full px-5 py-4 flex items-center justify-between text-left hover:bg-white/5 transition-colors"
                >
                  <div className="flex items-center gap-3">
                    <span className={`px-2 py-0.5 rounded text-xs font-bold ${
                      log.decision === 'long' ? 'bg-emerald-500/20 text-emerald-400'
                      : log.decision === 'short' ? 'bg-red-500/20 text-red-400'
                      : 'bg-slate-500/20 text-slate-400'
                    }`}>
                      {log.decision?.toUpperCase()}
                    </span>
                    <span className="text-xs font-mono text-slate-500">
                      {new Date(log.time).toLocaleString('it-IT')}
                    </span>
                    <span className="text-xs font-mono text-slate-600">#{log.id}</span>
                  </div>
                  <span className="text-slate-500 text-sm">{expanded === log.id ? '▲' : '▼'}</span>
                </button>

                {expanded === log.id && (
                  <div className="px-5 pb-5 space-y-4 border-t border-dark-border">
                    {/* Reasoning */}
                    <div>
                      <p className="text-xs text-slate-500 uppercase tracking-wide mb-2">Reasoning</p>
                      <div className="space-y-1">
                        {(log.reasoning || []).map((r, i) => (
                          <div key={i} className="text-xs font-mono text-slate-300 bg-white/5 rounded px-3 py-1.5">
                            → {r}
                          </div>
                        ))}
                      </div>
                    </div>

                    {/* Forecast */}
                    {log.forecast && (
                      <div>
                        <p className="text-xs text-slate-500 uppercase tracking-wide mb-2">Forecast Chronos-2</p>
                        <div className="grid grid-cols-4 gap-3 text-xs font-mono">
                          <FCell label="P(up)" value={`${((log.forecast.c2_dir_prob ?? 0) * 100).toFixed(1)}%`} />
                          <FCell label="p10" value={`$${(log.forecast.c2_p10 ?? 0).toFixed(0)}`} />
                          <FCell label="p50" value={`$${(log.forecast.c2_p50 ?? 0).toFixed(0)}`} />
                          <FCell label="p90" value={`$${(log.forecast.c2_p90 ?? 0).toFixed(0)}`} />
                        </div>
                      </div>
                    )}

                    {/* Key features */}
                    {log.features && (
                      <div>
                        <p className="text-xs text-slate-500 uppercase tracking-wide mb-2">Feature chiave</p>
                        <div className="grid grid-cols-3 gap-2 text-xs font-mono">
                          {['adx_14', 'd_ema20_dist', 'rsi_14', 'vol_imbalance', 'oi_ma_ratio', 'funding_z'].map(k => (
                            log.features[k] !== undefined && (
                              <FCell key={k} label={k} value={(log.features[k] ?? 0).toFixed(3)} />
                            )
                          ))}
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

const FCell: React.FC<{ label: string; value: string }> = ({ label, value }) => (
  <div className="bg-white/5 rounded px-2 py-1.5">
    <p className="text-slate-600 text-xs">{label}</p>
    <p className="text-slate-300">{value}</p>
  </div>
);
