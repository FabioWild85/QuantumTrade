import React, { useState, useRef } from 'react';

interface BacktestStats {
  total_trades: number;
  win_rate: number;
  avg_win_pct: number;
  avg_loss_pct: number;
  profit_factor: number;
  total_pnl_usd: number;
  total_pnl_pct: number;
  sharpe: number;
  sortino: number;
  calmar: number;
  max_drawdown_pct: number;
  avg_holding_h: number;
  best_trade_pct: number;
  worst_trade_pct: number;
}

interface BacktestTrade {
  side: string;
  entry: number;
  exit: number;
  pnl_pct: number;
  pnl_usd: number;
  reason: string;
  holding_bars: number;
  bar: number;
}

interface EquityPoint { bar: number; equity: number; }

interface BacktestResult {
  symbol: string;
  from_date: string;
  to_date: string;
  initial_capital: number;
  final_equity: number;
  total_bars: number;
  stats: BacktestStats;
  trades: BacktestTrade[];
  equity_curve: EquityPoint[];
}

// ── Equity curve SVG ──────────────────────────────────────────────────────────
const EquityChart: React.FC<{ data: EquityPoint[]; initialCapital: number }> = ({ data, initialCapital }) => {
  if (data.length < 2) return null;

  const W = 700, H = 160, PAD = { t: 10, r: 10, b: 28, l: 52 };
  const cW = W - PAD.l - PAD.r;
  const cH = H - PAD.t - PAD.b;

  const vals = data.map(d => d.equity);
  const minV = Math.min(...vals, initialCapital * 0.9);
  const maxV = Math.max(...vals, initialCapital * 1.01);
  const range = maxV - minV || 1;

  const px = (i: number) => PAD.l + (i / (data.length - 1)) * cW;
  const py = (v: number) => PAD.t + cH - ((v - minV) / range) * cH;

  const poly = data.map((d, i) => `${px(i)},${py(d.equity)}`).join(' ');
  const fillPoly = `${PAD.l},${PAD.t + cH} ${poly} ${PAD.l + cW},${PAD.t + cH}`;

  const capY = py(initialCapital);
  const isProfit = vals[vals.length - 1] >= initialCapital;
  const stroke = isProfit ? '#34d399' : '#f87171';
  const fill   = isProfit ? 'rgba(52,211,153,0.10)' : 'rgba(248,113,113,0.10)';

  const ticks = 4;
  const yLabels = Array.from({ length: ticks + 1 }, (_, i) => minV + (range * i) / ticks);

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full" style={{ height: 160 }}>
      {/* Grid */}
      {yLabels.map((v, i) => {
        const y = py(v);
        return (
          <g key={i}>
            <line x1={PAD.l} y1={y} x2={W - PAD.r} y2={y} stroke="#1e2433" strokeWidth="1" />
            <text x={PAD.l - 4} y={y + 4} textAnchor="end" fill="#64748b" fontSize={9}>
              ${Math.round(v).toLocaleString()}
            </text>
          </g>
        );
      })}

      {/* Initial capital reference */}
      <line x1={PAD.l} y1={capY} x2={W - PAD.r} y2={capY} stroke="#475569" strokeWidth="1" strokeDasharray="4 3" />

      {/* Fill */}
      <polygon points={fillPoly} fill={fill} />

      {/* Line */}
      <polyline points={poly} fill="none" stroke={stroke} strokeWidth="1.5" strokeLinejoin="round" />

      {/* Axis labels */}
      {[0, Math.floor(data.length / 2), data.length - 1].map((idx) => {
        const bar = data[idx]?.bar ?? idx;
        const label = `Bar ${bar}`;
        return (
          <text key={idx} x={px(idx)} y={H - 4} textAnchor="middle" fill="#64748b" fontSize={9}>
            {label}
          </text>
        );
      })}
    </svg>
  );
};

// ── Stat card ─────────────────────────────────────────────────────────────────
const Stat: React.FC<{ label: string; value: string; sub?: string; color?: string }> = ({
  label, value, sub, color = 'text-white',
}) => (
  <div className="bg-dark-bg rounded-lg p-3 flex flex-col gap-0.5">
    <span className="text-xs text-slate-500 uppercase tracking-wide">{label}</span>
    <span className={`text-lg font-bold font-mono ${color}`}>{value}</span>
    {sub && <span className="text-xs text-slate-600">{sub}</span>}
  </div>
);

// ── Main component ─────────────────────────────────────────────────────────────
export const BacktestPanel: React.FC<{ apiBase: string }> = ({ apiBase }) => {
  const today = new Date().toISOString().slice(0, 10);
  const sixMonthsAgo = new Date(Date.now() - 180 * 864e5).toISOString().slice(0, 10);

  const [fromDate, setFromDate]   = useState(sixMonthsAgo);
  const [toDate, setToDate]       = useState(today);
  const [capital, setCapital]     = useState('10000');
  const [slMult, setSlMult]       = useState('2.0');
  const [tpMult, setTpMult]       = useState('3.5');
  const [posSizePct, setPosSizePct] = useState('1.5');
  const [status, setStatus]       = useState<'idle' | 'running' | 'done' | 'error'>('idle');
  const [result, setResult]       = useState<BacktestResult | null>(null);
  const [errorMsg, setErrorMsg]   = useState('');
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const runBacktest = async () => {
    setStatus('running');
    setResult(null);
    setErrorMsg('');

    try {
      const body = {
        symbol: 'BTC',
        from_date: fromDate,
        to_date: toDate,
        initial_capital: parseFloat(capital) || 10000,
        config: {
          sl_atr_mult: parseFloat(slMult),
          tp_atr_mult: parseFloat(tpMult),
          position_size_pct: parseFloat(posSizePct),
          max_daily_dd_pct: 3.0,
          directional_threshold: 0.62,
          adx_gate: 20.0,
          confluence_gate: 0.0,
          max_consecutive_losses: 4,
          mode: 'paper',
        },
      };

      const startRes = await fetch(`${apiBase}/backtest`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const { job_id } = await startRes.json();

      pollRef.current = setInterval(async () => {
        const r = await fetch(`${apiBase}/backtest/${job_id}`);
        const job = await r.json();
        if (job.status === 'done') {
          clearInterval(pollRef.current!);
          if (job.result?.error) {
            setErrorMsg(job.result.error);
            setStatus('error');
          } else {
            setResult(job.result);
            setStatus('done');
          }
        }
      }, 2000);
    } catch (e: any) {
      setErrorMsg(e.message);
      setStatus('error');
    }
  };

  const pnlColor = (v: number) => v > 0 ? 'text-emerald-400' : v < 0 ? 'text-red-400' : 'text-slate-400';
  const numColor = (v: number) => v > 0 ? 'text-emerald-400' : 'text-red-400';

  return (
    <div className="space-y-6">
      {/* ── Config panel ─────────────────────────────────────────────────────── */}
      <div className="bg-dark-card rounded-xl p-5 border border-dark-border">
        <h2 className="text-sm font-semibold text-slate-300 mb-4 flex items-center gap-2">
          <span className="text-indigo-400">◈</span> Backtest Configuration
        </h2>

        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
          <label className="flex flex-col gap-1">
            <span className="text-xs text-slate-500">From</span>
            <input type="date" value={fromDate} onChange={e => setFromDate(e.target.value)}
              className="bg-dark-bg border border-dark-border rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-indigo-500" />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-xs text-slate-500">To</span>
            <input type="date" value={toDate} onChange={e => setToDate(e.target.value)}
              className="bg-dark-bg border border-dark-border rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-indigo-500" />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-xs text-slate-500">Capital ($)</span>
            <input type="number" value={capital} onChange={e => setCapital(e.target.value)} min="1000"
              className="bg-dark-bg border border-dark-border rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-indigo-500" />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-xs text-slate-500">SL mult (ATR)</span>
            <input type="number" value={slMult} onChange={e => setSlMult(e.target.value)} step="0.1" min="0.5" max="5"
              className="bg-dark-bg border border-dark-border rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-indigo-500" />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-xs text-slate-500">TP mult (ATR)</span>
            <input type="number" value={tpMult} onChange={e => setTpMult(e.target.value)} step="0.1" min="1" max="10"
              className="bg-dark-bg border border-dark-border rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-indigo-500" />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-xs text-slate-500">Size (%)</span>
            <input type="number" value={posSizePct} onChange={e => setPosSizePct(e.target.value)} step="0.1" min="0.1" max="5"
              className="bg-dark-bg border border-dark-border rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-indigo-500" />
          </label>
        </div>

        <div className="mt-4 flex items-center gap-4">
          <button
            onClick={runBacktest}
            disabled={status === 'running'}
            className="px-5 py-2.5 bg-indigo-600 hover:bg-indigo-500 disabled:bg-indigo-800 disabled:cursor-not-allowed text-white text-sm font-semibold rounded-lg transition-colors flex items-center gap-2"
          >
            {status === 'running' ? (
              <>
                <svg className="w-4 h-4 animate-spin" viewBox="0 0 24 24" fill="none">
                  <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" strokeDasharray="40 20" />
                </svg>
                Running…
              </>
            ) : 'Run Backtest'}
          </button>
          {status === 'running' && (
            <span className="text-xs text-slate-500 animate-pulse">
              Fetching historical data + running decision loop…
            </span>
          )}
          {status === 'error' && (
            <span className="text-xs text-red-400">{errorMsg}</span>
          )}
        </div>
      </div>

      {/* ── Results ──────────────────────────────────────────────────────────── */}
      {result && (
        <>
          {/* Summary bar */}
          <div className="bg-dark-card rounded-xl p-4 border border-dark-border flex flex-wrap items-center gap-6 text-sm">
            <div>
              <span className="text-slate-500 text-xs">Period</span>
              <p className="text-white font-medium">{result.from_date} → {result.to_date}</p>
            </div>
            <div>
              <span className="text-slate-500 text-xs">Capital</span>
              <p className="text-white font-medium">${result.initial_capital.toLocaleString()} → ${result.final_equity.toLocaleString()}</p>
            </div>
            <div>
              <span className="text-slate-500 text-xs">Total PnL</span>
              <p className={`font-bold text-base ${pnlColor(result.stats.total_pnl_usd)}`}>
                {result.stats.total_pnl_usd > 0 ? '+' : ''}${result.stats.total_pnl_usd.toLocaleString()} ({result.stats.total_pnl_pct > 0 ? '+' : ''}{result.stats.total_pnl_pct}%)
              </p>
            </div>
            <div>
              <span className="text-slate-500 text-xs">Bars simulated</span>
              <p className="text-white font-medium">{result.total_bars}</p>
            </div>
          </div>

          {/* Equity curve */}
          <div className="bg-dark-card rounded-xl p-4 border border-dark-border">
            <h3 className="text-xs font-semibold text-slate-400 uppercase tracking-wide mb-3">Equity Curve</h3>
            <EquityChart data={result.equity_curve} initialCapital={result.initial_capital} />
          </div>

          {/* Stats grid */}
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
            <Stat label="Win Rate"       value={`${result.stats.win_rate}%`} sub={`${result.stats.total_trades} trades`} color={result.stats.win_rate >= 50 ? 'text-emerald-400' : 'text-red-400'} />
            <Stat label="Profit Factor"  value={result.stats.profit_factor === Infinity ? '∞' : result.stats.profit_factor.toFixed(2)} sub="wins/losses gross" color={result.stats.profit_factor >= 1.5 ? 'text-emerald-400' : result.stats.profit_factor >= 1 ? 'text-amber-400' : 'text-red-400'} />
            <Stat label="Sharpe"         value={result.stats.sharpe.toFixed(3)} sub="annualized" color={result.stats.sharpe >= 0.7 ? 'text-emerald-400' : result.stats.sharpe >= 0 ? 'text-amber-400' : 'text-red-400'} />
            <Stat label="Sortino"        value={result.stats.sortino.toFixed(3)} sub="downside risk" color={result.stats.sortino >= 1 ? 'text-emerald-400' : result.stats.sortino >= 0 ? 'text-amber-400' : 'text-red-400'} />
            <Stat label="Calmar"         value={result.stats.calmar.toFixed(3)} sub="return/max DD" color={result.stats.calmar >= 0.5 ? 'text-emerald-400' : result.stats.calmar >= 0 ? 'text-amber-400' : 'text-red-400'} />
            <Stat label="Max Drawdown"   value={`-${result.stats.max_drawdown_pct}%`} color="text-red-400" />
            <Stat label="Avg Win"        value={`+${result.stats.avg_win_pct}%`} color="text-emerald-400" />
            <Stat label="Avg Loss"       value={`${result.stats.avg_loss_pct}%`} color="text-red-400" />
            <Stat label="Best Trade"     value={`+${result.stats.best_trade_pct}%`} color="text-emerald-400" />
            <Stat label="Worst Trade"    value={`${result.stats.worst_trade_pct}%`} color="text-red-400" />
            <Stat label="Avg Hold"       value={`${result.stats.avg_holding_h}h`} sub="per trade" />
          </div>

          {/* Trade table */}
          {result.trades.length > 0 && (
            <div className="bg-dark-card rounded-xl border border-dark-border overflow-hidden">
              <div className="px-4 py-3 border-b border-dark-border">
                <h3 className="text-xs font-semibold text-slate-400 uppercase tracking-wide">
                  Last {result.trades.length} Trades
                </h3>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="border-b border-dark-border text-slate-500 uppercase tracking-wide">
                      <th className="px-4 py-2 text-left">Bar</th>
                      <th className="px-4 py-2 text-left">Side</th>
                      <th className="px-4 py-2 text-right">Entry</th>
                      <th className="px-4 py-2 text-right">Exit</th>
                      <th className="px-4 py-2 text-right">PnL %</th>
                      <th className="px-4 py-2 text-right">PnL $</th>
                      <th className="px-4 py-2 text-left">Reason</th>
                      <th className="px-4 py-2 text-right">Hold</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-dark-border">
                    {[...result.trades].reverse().map((t, i) => (
                      <tr key={i} className="hover:bg-dark-bg/50 transition-colors">
                        <td className="px-4 py-2 text-slate-500 font-mono">{t.bar}</td>
                        <td className="px-4 py-2">
                          <span className={`px-1.5 py-0.5 rounded text-xs font-bold ${t.side === 'long' ? 'bg-emerald-900/60 text-emerald-300' : 'bg-red-900/60 text-red-300'}`}>
                            {t.side.toUpperCase()}
                          </span>
                        </td>
                        <td className="px-4 py-2 text-right font-mono text-slate-300">${t.entry.toLocaleString(undefined, { minimumFractionDigits: 0 })}</td>
                        <td className="px-4 py-2 text-right font-mono text-slate-300">${t.exit.toLocaleString(undefined, { minimumFractionDigits: 0 })}</td>
                        <td className={`px-4 py-2 text-right font-mono font-bold ${numColor(t.pnl_pct)}`}>
                          {t.pnl_pct > 0 ? '+' : ''}{t.pnl_pct}%
                        </td>
                        <td className={`px-4 py-2 text-right font-mono ${numColor(t.pnl_usd)}`}>
                          {t.pnl_usd > 0 ? '+' : ''}${t.pnl_usd.toFixed(0)}
                        </td>
                        <td className="px-4 py-2">
                          <span className={`px-1.5 py-0.5 rounded text-xs ${
                            t.reason === 'take_profit' ? 'bg-emerald-900/50 text-emerald-400' :
                            t.reason === 'stop_loss'   ? 'bg-red-900/50 text-red-400' :
                            'bg-slate-800 text-slate-400'
                          }`}>
                            {t.reason.replace('_', ' ')}
                          </span>
                        </td>
                        <td className="px-4 py-2 text-right text-slate-500">{t.holding_bars * 4}h</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
};
