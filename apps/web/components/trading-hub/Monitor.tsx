import React, { useEffect, useRef, useState, useCallback } from 'react';
import { Tooltip } from './Tooltip';

// Returns seconds until next 4h candle close (00:00, 04:00, 08:00, 12:00, 16:00, 20:00 UTC)
function secsToNext4h(): number {
  const now = Date.now();
  const interval = 4 * 3600 * 1000;
  return Math.ceil((interval - (now % interval)) / 1000);
}

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
    size_contracts: number;
    opened_at: string;
  };
  ws_connected: boolean;
  model_loaded: boolean;
  cycle_count: number;
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

const INITIAL_EQUITY = 10_000;

export const Monitor: React.FC<{ apiBase: string }> = ({ apiBase }) => {
  const [status,    setStatus]   = useState<BotStatus | null>(null);
  const [logs,      setLogs]     = useState<InferenceLog[]>([]);
  const [equity,    setEquity]   = useState<EquitySnap[]>([]);
  const [error,     setError]    = useState<string | null>(null);
  const [starting,  setStarting] = useState(false);
  const [countdown, setCountdown] = useState(secsToNext4h());
  const esRef = useRef<EventSource | null>(null);

  useEffect(() => {
    const t = setInterval(() => setCountdown(secsToNext4h()), 1000);
    return () => clearInterval(t);
  }, []);

  // ── REST polling (status + logs every 15s) ────────────────────────────────
  const fetchAll = async () => {
    try {
      const [s, l, e] = await Promise.all([
        fetch(`${apiBase}/bot/status`).then(r => r.ok ? r.json() : null),
        fetch(`${apiBase}/inference-logs?limit=5`).then(r => r.ok ? r.json() : []),
        fetch(`${apiBase}/equity?limit=100`).then(r => r.ok ? r.json() : []),
      ]);
      setStatus(s);
      setLogs(l ?? []);
      setEquity(prev => {
        if (!e?.length) return prev;
        const sorted = [...e].sort((a: EquitySnap, b: EquitySnap) =>
          new Date(a.time).getTime() - new Date(b.time).getTime()
        );
        return sorted;
      });
      setError(null);
    } catch {
      setError('API non raggiungibile — assicurati che il backend sia avviato.');
    }
  };

  // ── SSE subscription: live equity updates ─────────────────────────────────
  useEffect(() => {
    const connect = () => {
      if (esRef.current) esRef.current.close();
      const es = new EventSource(`${apiBase}/equity/stream`);
      es.onmessage = (evt) => {
        try {
          const snap: EquitySnap = JSON.parse(evt.data);
          setEquity(prev => {
            if (prev.some(x => x.time === snap.time)) return prev;
            const next = [...prev, snap].sort(
              (a, b) => new Date(a.time).getTime() - new Date(b.time).getTime()
            );
            return next.slice(-200);   // keep last 200 points
          });
          // Also refresh status when equity changes (new cycle completed)
          fetch(`${apiBase}/bot/status`).then(r => r.ok ? r.json() : null).then(s => s && setStatus(s));
        } catch {}
      };
      es.onerror = () => es.close();
      esRef.current = es;
    };

    fetchAll();
    connect();
    const poll = setInterval(fetchAll, 15_000);
    return () => {
      clearInterval(poll);
      esRef.current?.close();
    };
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
    } finally { setStarting(false); }
  };

  const stopBot = async () => {
    await fetch(`${apiBase}/bot/stop`, { method: 'POST' });
    setTimeout(fetchAll, 500);
  };

  const killBot = async () => {
    if (!confirm('⚠️ KILL: chiude posizioni e cancella ordini immediatamente. Confermi?')) return;
    await fetch(`${apiBase}/bot/kill`, { method: 'POST' });
    setTimeout(fetchAll, 500);
  };

  if (error && !status) {
    return (
      <div className="rounded-2xl bg-dark-card border border-dark-border p-8 text-center">
        <p className="text-amber-400 text-sm font-mono mb-2">{error}</p>
        <p className="text-slate-500 text-xs">
          Avvia il backend: <code className="text-indigo-400">cd apps/api && uvicorn main:app --reload</code>
        </p>
      </div>
    );
  }

  const currentEquity = status?.equity ?? equity[equity.length - 1]?.equity_usd ?? INITIAL_EQUITY;
  const totalPnl      = currentEquity - INITIAL_EQUITY;
  const totalPnlPct   = (totalPnl / INITIAL_EQUITY) * 100;

  // Unrealized P&L for open position
  let unrealizedPnl = 0;
  let positionDurationH = 0;
  if (status?.position) {
    const pos     = status.position;
    const openedMs = new Date(pos.opened_at).getTime();
    positionDurationH = (Date.now() - openedMs) / 3_600_000;
    // We don't have live mark price here, show size
    unrealizedPnl = 0; // placeholder — would need live price
  }

  return (
    <div className="space-y-5">

      {/* ── KPI strip ─────────────────────────────────────────────────────── */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <Tooltip text="Valore totale del tuo account, inclusi profitti e perdite realizzati. La modalità (PAPER/LIVE) indica se stai usando fondi virtuali o reali.">
          <KpiCard
            label="Equity"
            value={`$${currentEquity.toLocaleString('en-US', { minimumFractionDigits: 2 })}`}
            sub={status?.mode?.toUpperCase() ?? 'PAPER'}
            color={totalPnl >= 0 ? 'text-emerald-400' : 'text-red-400'}
          />
        </Tooltip>
        <Tooltip text="Profitto o perdita totale dall'avvio del bot. Calcolato come differenza tra equity attuale e capitale iniziale di $10.000.">
          <KpiCard
            label="PnL Totale"
            value={`${totalPnl >= 0 ? '+' : ''}$${totalPnl.toFixed(2)}`}
            sub={`${totalPnlPct >= 0 ? '+' : ''}${totalPnlPct.toFixed(2)}%`}
            color={totalPnl >= 0 ? 'text-emerald-400' : 'text-red-400'}
          />
        </Tooltip>
        <Tooltip text="Countdown alla prossima chiusura della candela da 4 ore. Il bot analizza il mercato e decide se aprire un trade ad ogni nuova candela. 'Cicli' = analisi completate. 'Retrain' = candele al prossimo riaddestramentodel modello LightGBM." width="wide">
          <KpiCard
            label="Prossima Candela"
            value={`${String(Math.floor(countdown / 3600)).padStart(2,'0')}:${String(Math.floor((countdown % 3600) / 60)).padStart(2,'0')}:${String(countdown % 60).padStart(2,'0')}`}
            sub={`Cicli: ${status?.cycle_count ?? 0} · Retrain: ${120 - ((status?.cycle_count ?? 0) % 120)}`}
          />
        </Tooltip>
        <Tooltip text="Stato operativo del bot. 'Running' = analizza il mercato attivamente. 'Idle' = in pausa. Mostra anche se la connessione WebSocket a Hyperliquid è attiva.">
          <KpiCard
            label="Stato"
            value={status?.running ? 'Running' : 'Idle'}
            sub={status?.ws_connected ? '● WS connesso' : '○ WS disconnesso'}
            color={status?.running ? 'text-emerald-400' : 'text-slate-400'}
          />
        </Tooltip>
      </div>

      {/* ── Controls ──────────────────────────────────────────────────────── */}
      <div className="flex gap-3 flex-wrap items-center">
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
        {/* System status badges */}
        <div className="flex gap-2 ml-auto">
          <Tooltip text="Modello machine learning per previsione direzione del prezzo. Addestrato su 64 feature di prezzo, volume e dati on-chain. Verde = modello caricato in memoria." pos="bottom">
            <StatusBadge label="LightGBM" active={status?.model_loaded ?? false} />
          </Tooltip>
          <Tooltip text="Connessione in tempo reale a Hyperliquid per ricevere prezzi, order book e aggiornamenti posizioni. Verde = connesso e riceve dati live." pos="bottom">
            <StatusBadge label="WebSocket" active={status?.ws_connected ?? false} />
          </Tooltip>
        </div>
      </div>

      {/* ── Open position ─────────────────────────────────────────────────── */}
      {status?.position && (
        <div className="rounded-2xl bg-amber-500/10 border border-amber-500/30 p-5">
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-sm font-bold text-amber-400">📌 Posizione Aperta</h3>
            <span className="text-xs text-amber-500/70 font-mono">
              Aperta {positionDurationH.toFixed(1)}h fa
            </span>
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
            <Tooltip text="Direzione del trade. LONG = scommessa che il prezzo salga. SHORT = scommessa che il prezzo scenda." pos="bottom">
              <Stat label="Side" value={status.position.side.toUpperCase()}
                color={status.position.side === 'long' ? 'text-emerald-400' : 'text-red-400'} />
            </Tooltip>
            <Tooltip text="Prezzo a cui la posizione è stata aperta." pos="bottom">
              <Stat label="Entry" value={`$${status.position.entry_price.toLocaleString('en-US', { maximumFractionDigits: 0 })}`} />
            </Tooltip>
            <Tooltip text="Livello di prezzo a cui la posizione viene chiusa automaticamente per limitare le perdite (Stop Loss)." pos="bottom">
              <Stat label="Stop Loss" value={`$${status.position.stop_loss.toLocaleString('en-US', { maximumFractionDigits: 0 })}`} color="text-red-400" />
            </Tooltip>
            <Tooltip text="Livello di prezzo a cui la posizione viene chiusa per incassare il profitto (Take Profit)." pos="bottom">
              <Stat label="Take Profit" value={`$${status.position.take_profit.toLocaleString('en-US', { maximumFractionDigits: 0 })}`} color="text-emerald-400" />
            </Tooltip>
          </div>
          <div className="mt-3 pt-3 border-t border-amber-500/20 flex gap-6 text-xs font-mono text-amber-500/60">
            <span>Size: ${status.position.size_usd.toFixed(0)}</span>
            <span>Contracts: {status.position.size_contracts?.toFixed(4)}</span>
          </div>
        </div>
      )}

      {/* ── Equity curve ──────────────────────────────────────────────────── */}
      <div className="rounded-2xl bg-dark-card border border-dark-border p-5">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-sm font-bold text-slate-300">📈 Curva Equity</h3>
          {equity.length > 0 && (
            <span className={`text-xs font-mono ${totalPnl >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
              {totalPnl >= 0 ? '+' : ''}${totalPnl.toFixed(2)} ({totalPnlPct.toFixed(2)}%)
            </span>
          )}
        </div>
        {equity.length < 2 ? (
          <div className="h-28 flex items-center justify-center text-slate-600 text-xs">
            La curva apparirà dopo il primo trade chiuso
          </div>
        ) : (
          <div style={{ height: 120 }}>
            <EquityCurveChart data={equity} startCapital={INITIAL_EQUITY} />
          </div>
        )}
      </div>

      {/* ── Last inference logs ───────────────────────────────────────────── */}
      {logs.length > 0 && (
        <div className="rounded-2xl bg-dark-card border border-dark-border p-5">
          <h3 className="text-sm font-bold text-slate-300 mb-4">🧠 Ultime Decisioni AI</h3>
          <div className="space-y-2">
            {logs.map(log => (
              <div key={log.id} className="rounded-xl bg-white/5 p-4 text-xs font-mono">
                <div className="flex items-center justify-between mb-2">
                  <span className={`font-bold px-2 py-0.5 rounded ${
                    log.decision === 'long'  ? 'bg-emerald-500/20 text-emerald-400'
                    : log.decision === 'short' ? 'bg-red-500/20 text-red-400'
                    : 'bg-slate-500/20 text-slate-400'
                  }`}>
                    {log.decision?.toUpperCase()}
                  </span>
                  <span className="text-slate-500">
                    {new Date(log.time).toLocaleTimeString('it-IT')}
                    {log.latency_ms && ` · ${log.latency_ms.toFixed(0)}ms`}
                  </span>
                </div>
                <div className="text-slate-400 space-y-0.5">
                  {(log.reasoning ?? []).slice(0, 3).map((r, i) => (
                    <div key={i} className="truncate text-slate-500">→ {r}</div>
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

// ── Equity curve SVG ──────────────────────────────────────────────────────────

const EquityCurveChart: React.FC<{ data: EquitySnap[]; startCapital: number }> = ({ data, startCapital }) => {
  const W = 600, H = 110;
  const PAD = { l: 54, r: 12, t: 8, b: 22 };
  const cW = W - PAD.l - PAD.r;
  const cH = H - PAD.t - PAD.b;

  const vals = data.map(d => d.equity_usd);
  const minV = Math.min(...vals, startCapital) * 0.9993;
  const maxV = Math.max(...vals, startCapital) * 1.0007;
  const vRange = maxV - minV || 1;
  const n = vals.length;

  const px = (i: number) => PAD.l + (i / (n - 1)) * cW;
  const py = (v: number)  => PAD.t + (1 - (v - minV) / vRange) * cH;

  const pts   = vals.map((v, i) => `${px(i).toFixed(1)},${py(v).toFixed(1)}`).join(' ');
  const lastV = vals[n - 1];
  const isPos = lastV >= startCapital;
  const lineColor = isPos ? '#34d399' : '#f87171';
  const fillColor = isPos ? 'rgba(52,211,153,0.08)' : 'rgba(248,113,113,0.08)';

  // Filled area under curve
  const fillPath = `M${px(0).toFixed(1)},${py(minV).toFixed(1)} L${px(0).toFixed(1)},${py(vals[0]).toFixed(1)} ${vals.map((v, i) => `L${px(i).toFixed(1)},${py(v).toFixed(1)}`).join(' ')} L${px(n - 1).toFixed(1)},${py(minV).toFixed(1)} Z`;

  const fmtK = (v: number) => v >= 10000 ? `$${(v / 1000).toFixed(1)}k` : `$${v.toFixed(0)}`;

  // Time labels: first + last
  const firstDate = new Date(data[0].time).toLocaleDateString('it-IT', { day: '2-digit', month: '2-digit' });
  const lastDate  = new Date(data[n - 1].time).toLocaleDateString('it-IT', { day: '2-digit', month: '2-digit' });

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-full" preserveAspectRatio="xMidYMid meet">
      {/* Start capital reference */}
      <line
        x1={PAD.l} y1={py(startCapital)} x2={W - PAD.r} y2={py(startCapital)}
        stroke="rgba(255,255,255,0.08)" strokeDasharray="4,5"
      />
      <text x={PAD.l - 4} y={py(startCapital) + 4} textAnchor="end"
        fontSize="8.5" fill="rgba(255,255,255,0.25)" fontFamily="monospace">
        {fmtK(startCapital)}
      </text>

      {/* Fill */}
      <path d={fillPath} fill={fillColor} />

      {/* Line */}
      <polyline points={pts} stroke={lineColor} strokeWidth="1.5" fill="none" strokeLinejoin="round" />

      {/* Current equity label */}
      <circle cx={px(n - 1)} cy={py(lastV)} r={3} fill={lineColor} />
      <text x={W - PAD.r + 3} y={py(lastV) + 4} textAnchor="start"
        fontSize="8.5" fill={lineColor} fontFamily="monospace">
        {fmtK(lastV)}
      </text>

      {/* Y axis labels */}
      {[0.2, 0.8].map((f, i) => {
        const v = minV + f * vRange;
        return (
          <text key={i} x={PAD.l - 4} y={py(v) + 4} textAnchor="end"
            fontSize="8" fill="rgba(148,163,184,0.35)" fontFamily="monospace">
            {fmtK(v)}
          </text>
        );
      })}

      {/* X axis dates */}
      <text x={PAD.l} y={H - 3} textAnchor="middle" fontSize="9" fill="rgba(148,163,184,0.35)" fontFamily="sans-serif">
        {firstDate}
      </text>
      <text x={px(n - 1)} y={H - 3} textAnchor="middle" fontSize="9" fill="rgba(148,163,184,0.35)" fontFamily="sans-serif">
        {lastDate}
      </text>
    </svg>
  );
};

// ── Micro-components ──────────────────────────────────────────────────────────

const KpiCard: React.FC<{ label: string; value: string; sub?: string; color?: string }> = ({
  label, value, sub, color = 'text-white',
}) => (
  <div className="rounded-2xl bg-dark-card border border-dark-border p-4">
    <p className="text-xs text-slate-500 mb-1">{label}</p>
    <p className={`text-xl font-bold font-mono ${color}`}>{value}</p>
    {sub && <p className="text-xs text-slate-600 mt-0.5">{sub}</p>}
  </div>
);

const Stat: React.FC<{ label: string; value: string; color?: string }> = ({
  label, value, color = 'text-white',
}) => (
  <div>
    <p className="text-xs text-slate-500">{label}</p>
    <p className={`font-mono font-semibold ${color}`}>{value}</p>
  </div>
);

const StatusBadge: React.FC<{ label: string; active: boolean }> = ({ label, active }) => (
  <div className={`flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-semibold border ${
    active ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-400'
           : 'border-slate-700 bg-slate-800 text-slate-500'
  }`}>
    <span className={`w-1.5 h-1.5 rounded-full ${active ? 'bg-emerald-400 animate-pulse' : 'bg-slate-600'}`} />
    {label}
  </div>
);
