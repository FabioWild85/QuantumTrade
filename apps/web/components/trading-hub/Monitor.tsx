import React, { useEffect, useState } from 'react';

interface BotStatus {
  running: boolean;
  mode: string;
  equity: number;
  position: null | {
    side: string;
    entry_price: number;
    stop_loss: number;
    take_profit: number;
    size_usd: number;
    opened_at: string;
  };
}

interface InferenceLog {
  id: string;
  time: string;
  decision: string;
  reasoning: string[];
  forecast: Record<string, number>;
  latency_ms: number;
}

interface EquitySnap {
  time: string;
  equity_usd: number;
  realized_pnl: number;
  drawdown_pct: number;
}

export const Monitor: React.FC<{ apiBase: string }> = ({ apiBase }) => {
  const [status, setStatus]  = useState<BotStatus | null>(null);
  const [logs, setLogs]      = useState<InferenceLog[]>([]);
  const [equity, setEquity]  = useState<EquitySnap[]>([]);
  const [error, setError]    = useState<string | null>(null);
  const [starting, setStarting] = useState(false);

  const fetchAll = async () => {
    try {
      const [s, l, e] = await Promise.all([
        fetch(`${apiBase}/bot/status`).then(r => r.ok ? r.json() : null),
        fetch(`${apiBase}/inference-logs?limit=5`).then(r => r.ok ? r.json() : []),
        fetch(`${apiBase}/equity?limit=50`).then(r => r.ok ? r.json() : []),
      ]);
      setStatus(s);
      setLogs(l || []);
      setEquity(e || []);
      setError(null);
    } catch (err) {
      setError('API non raggiungibile — assicurati che il backend sia avviato.');
    }
  };

  useEffect(() => {
    fetchAll();
    const t = setInterval(fetchAll, 30_000);
    return () => clearInterval(t);
  }, [apiBase]);

  const startBot = async (mode: 'paper' | 'live') => {
    setStarting(true);
    try {
      await fetch(`${apiBase}/bot/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode }),
      });
      setTimeout(fetchAll, 1000);
    } finally {
      setStarting(false);
    }
  };

  const stopBot = async () => {
    await fetch(`${apiBase}/bot/stop`, { method: 'POST' });
    setTimeout(fetchAll, 500);
  };

  const killBot = async () => {
    if (!confirm('⚠️ KILL: chiude posizioni e cancella ordini. Confermi?')) return;
    await fetch(`${apiBase}/bot/kill`, { method: 'POST' });
    setTimeout(fetchAll, 500);
  };

  if (error) {
    return (
      <div className="rounded-2xl bg-dark-card border border-dark-border p-8 text-center">
        <p className="text-amber-400 text-sm font-mono">{error}</p>
        <p className="text-slate-500 text-xs mt-2">
          Avvia il backend: <code className="text-indigo-400">cd apps/api && uvicorn main:app --reload</code>
        </p>
      </div>
    );
  }

  const totalPnl = equity.reduce((s, e) => s + e.realized_pnl, 0);

  return (
    <div className="space-y-6">
      {/* KPI strip */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
        <KpiCard label="Equity" value={`$${(status?.equity ?? 10000).toLocaleString('it-IT', { minimumFractionDigits: 2 })}`} sub={status?.mode?.toUpperCase() ?? '—'} />
        <KpiCard label="PnL Totale" value={`${totalPnl >= 0 ? '+' : ''}$${totalPnl.toFixed(2)}`} color={totalPnl >= 0 ? 'text-emerald-400' : 'text-red-400'} />
        <KpiCard label="Stato Bot" value={status?.running ? 'Running' : 'Idle'} color={status?.running ? 'text-emerald-400' : 'text-slate-400'} />
        <KpiCard label="Posizione" value={status?.position ? `${status.position.side.toUpperCase()} $${status.position.size_usd.toFixed(0)}` : 'Nessuna'} color={status?.position ? 'text-amber-400' : 'text-slate-400'} />
      </div>

      {/* Controls */}
      <div className="flex gap-3 flex-wrap">
        {!status?.running ? (
          <>
            <button
              onClick={() => startBot('paper')}
              disabled={starting}
              className="px-5 py-2.5 bg-indigo-600 hover:bg-indigo-500 text-white text-sm font-semibold rounded-xl transition-colors disabled:opacity-50"
            >
              ▶ Avvia Paper Trading
            </button>
            <button
              onClick={() => startBot('live')}
              disabled={starting}
              className="px-5 py-2.5 bg-amber-600 hover:bg-amber-500 text-white text-sm font-semibold rounded-xl transition-colors disabled:opacity-50"
            >
              ⚡ Avvia Live
            </button>
          </>
        ) : (
          <>
            <button onClick={stopBot} className="px-5 py-2.5 bg-slate-700 hover:bg-slate-600 text-white text-sm font-semibold rounded-xl transition-colors">
              ⏹ Stop
            </button>
            <button onClick={killBot} className="px-5 py-2.5 bg-red-700 hover:bg-red-600 text-white text-sm font-semibold rounded-xl transition-colors">
              🔴 KILL
            </button>
          </>
        )}
      </div>

      {/* Active position */}
      {status?.position && (
        <div className="rounded-2xl bg-amber-500/10 border border-amber-500/30 p-5">
          <h3 className="text-sm font-bold text-amber-400 mb-3">📌 Posizione Aperta</h3>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 text-sm">
            <Stat label="Side" value={status.position.side.toUpperCase()} />
            <Stat label="Entry" value={`$${status.position.entry_price.toLocaleString()}`} />
            <Stat label="Stop Loss" value={`$${status.position.stop_loss.toLocaleString()}`} color="text-red-400" />
            <Stat label="Take Profit" value={`$${status.position.take_profit.toLocaleString()}`} color="text-emerald-400" />
          </div>
        </div>
      )}

      {/* Last inference logs */}
      {logs.length > 0 && (
        <div className="rounded-2xl bg-dark-card border border-dark-border p-5">
          <h3 className="text-sm font-bold text-slate-300 mb-4">🧠 Ultime Decisioni AI</h3>
          <div className="space-y-3">
            {logs.map(log => (
              <div key={log.id} className="rounded-xl bg-white/5 p-4 text-xs font-mono">
                <div className="flex items-center justify-between mb-2">
                  <span className={`font-bold ${log.decision === 'long' ? 'text-emerald-400' : log.decision === 'short' ? 'text-red-400' : 'text-slate-400'}`}>
                    {log.decision.toUpperCase()}
                  </span>
                  <span className="text-slate-500">{new Date(log.time).toLocaleTimeString()} · {log.latency_ms?.toFixed(0)}ms</span>
                </div>
                <div className="text-slate-400 space-y-0.5">
                  {(log.reasoning || []).slice(0, 3).map((r, i) => (
                    <div key={i} className="truncate">→ {r}</div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
};

const KpiCard: React.FC<{ label: string; value: string; sub?: string; color?: string }> = ({ label, value, sub, color = 'text-white' }) => (
  <div className="rounded-2xl bg-dark-card border border-dark-border p-4">
    <p className="text-xs text-slate-500 mb-1">{label}</p>
    <p className={`text-xl font-bold font-mono ${color}`}>{value}</p>
    {sub && <p className="text-xs text-slate-600 mt-0.5">{sub}</p>}
  </div>
);

const Stat: React.FC<{ label: string; value: string; color?: string }> = ({ label, value, color = 'text-white' }) => (
  <div>
    <p className="text-xs text-slate-500">{label}</p>
    <p className={`font-mono font-semibold ${color}`}>{value}</p>
  </div>
);
