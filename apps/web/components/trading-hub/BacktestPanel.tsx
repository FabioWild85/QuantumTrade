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
const EquityChart: React.FC<{ data: EquityPoint[]; initialCapital: number; color?: string }> = ({
  data, initialCapital, color,
}) => {
  if (data.length < 2) return null;
  const W = 680, H = 150, PAD = { t: 8, r: 8, b: 24, l: 52 };
  const cW = W - PAD.l - PAD.r, cH = H - PAD.t - PAD.b;
  const vals = data.map(d => d.equity);
  const minV = Math.min(...vals, initialCapital * 0.995);
  const maxV = Math.max(...vals, initialCapital * 1.005);
  const range = maxV - minV || 1;
  const px = (i: number) => PAD.l + (i / (data.length - 1)) * cW;
  const py = (v: number) => PAD.t + cH - ((v - minV) / range) * cH;
  const poly = data.map((d, i) => `${px(i)},${py(d.equity)}`).join(' ');
  const fillPoly = `${PAD.l},${PAD.t + cH} ${poly} ${PAD.l + cW},${PAD.t + cH}`;
  const capY = py(initialCapital);
  const isProfit = vals[vals.length - 1] >= initialCapital;
  const stroke = color ?? (isProfit ? '#34d399' : '#f87171');
  const fill   = isProfit ? 'rgba(52,211,153,0.10)' : 'rgba(248,113,113,0.10)';
  const ticks  = 3;
  const yLabels = Array.from({ length: ticks + 1 }, (_, i) => minV + (range * i) / ticks);
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full" style={{ height: 140 }}>
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
      <line x1={PAD.l} y1={capY} x2={W - PAD.r} y2={capY} stroke="#475569" strokeWidth="1" strokeDasharray="4 3" />
      <polygon points={fillPoly} fill={fill} />
      <polyline points={poly} fill="none" stroke={stroke} strokeWidth="1.5" strokeLinejoin="round" />
      {[0, Math.floor(data.length / 2), data.length - 1].map((idx) => (
        <text key={idx} x={px(idx)} y={H - 4} textAnchor="middle" fill="#64748b" fontSize={9}>
          {data[idx]?.bar ?? idx}
        </text>
      ))}
    </svg>
  );
};

// ── Stat card ──────────────────────────────────────────────────────────────────
const Stat: React.FC<{ label: string; value: string; sub?: string; color?: string; delta?: number }> = ({
  label, value, sub, color = 'text-white', delta,
}) => (
  <div className="bg-dark-bg rounded-lg p-3 flex flex-col gap-0.5">
    <span className="text-xs text-slate-500 uppercase tracking-wide">{label}</span>
    <div className="flex items-baseline gap-2">
      <span className={`text-base font-bold font-mono ${color}`}>{value}</span>
      {delta !== undefined && delta !== 0 && (
        <span className={`text-xs font-mono ${delta > 0 ? 'text-emerald-400' : 'text-red-400'}`}>
          {delta > 0 ? '+' : ''}{delta.toFixed(2)}
        </span>
      )}
    </div>
    {sub && <span className="text-xs text-slate-600">{sub}</span>}
  </div>
);

// ── Toggle ─────────────────────────────────────────────────────────────────────
const Toggle: React.FC<{ label: string; desc: string; checked: boolean; onChange: (v: boolean) => void }> = ({
  label, desc, checked, onChange,
}) => (
  <label className="flex items-start gap-3 cursor-pointer group">
    <div className="relative mt-0.5">
      <input type="checkbox" className="sr-only" checked={checked} onChange={e => onChange(e.target.checked)} />
      <div className={`w-10 h-5 rounded-full transition-colors ${checked ? 'bg-indigo-600' : 'bg-slate-700'}`} />
      <div className={`absolute top-0.5 left-0.5 w-4 h-4 bg-white rounded-full shadow transition-transform ${checked ? 'translate-x-5' : ''}`} />
    </div>
    <div>
      <p className="text-sm font-medium text-slate-300 group-hover:text-white transition-colors">{label}</p>
      <p className="text-xs text-slate-600">{desc}</p>
    </div>
  </label>
);

// ── Stats comparison grid ──────────────────────────────────────────────────────
const StatsGrid: React.FC<{ stats: BacktestStats; compare?: BacktestStats; label?: string }> = ({ stats: s, compare: c, label }) => {
  const pnlColor = (v: number) => v > 0 ? 'text-emerald-400' : v < 0 ? 'text-red-400' : 'text-slate-400';
  const delta = (a: number, b?: number) => b !== undefined ? a - b : undefined;
  return (
    <div>
      {label && <h4 className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-2">{label}</h4>}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2">
        <Stat label="Trades"      value={String(s.total_trades)} delta={delta(s.total_trades, c?.total_trades)} />
        <Stat label="Win Rate"    value={`${s.win_rate}%`} color={s.win_rate >= 50 ? 'text-emerald-400' : 'text-red-400'} delta={delta(s.win_rate, c?.win_rate)} />
        <Stat label="PnL %"       value={`${s.total_pnl_pct > 0 ? '+' : ''}${s.total_pnl_pct}%`} color={pnlColor(s.total_pnl_pct)} delta={delta(s.total_pnl_pct, c?.total_pnl_pct)} />
        <Stat label="Profit Factor" value={s.profit_factor >= 99 ? '∞' : s.profit_factor.toFixed(2)} color={s.profit_factor >= 1.5 ? 'text-emerald-400' : s.profit_factor >= 1 ? 'text-amber-400' : 'text-red-400'} delta={delta(s.profit_factor, c?.profit_factor)} />
        <Stat label="Sharpe"      value={s.sharpe.toFixed(3)} color={s.sharpe >= 0.7 ? 'text-emerald-400' : s.sharpe >= 0 ? 'text-amber-400' : 'text-red-400'} delta={delta(s.sharpe, c?.sharpe)} />
        <Stat label="Sortino"     value={s.sortino.toFixed(3)} color={s.sortino >= 1 ? 'text-emerald-400' : s.sortino >= 0 ? 'text-amber-400' : 'text-red-400'} delta={delta(s.sortino, c?.sortino)} />
        <Stat label="Calmar"      value={s.calmar.toFixed(3)} color={s.calmar >= 0.5 ? 'text-emerald-400' : s.calmar >= 0 ? 'text-amber-400' : 'text-red-400'} delta={delta(s.calmar, c?.calmar)} />
        <Stat label="Max DD"      value={`-${s.max_drawdown_pct}%`} color="text-red-400" delta={c ? -(s.max_drawdown_pct - c.max_drawdown_pct) : undefined} />
        <Stat label="Avg Win"     value={`+${s.avg_win_pct}%`} color="text-emerald-400" delta={delta(s.avg_win_pct, c?.avg_win_pct)} />
        <Stat label="Avg Loss"    value={`${s.avg_loss_pct}%`} color="text-red-400" delta={delta(s.avg_loss_pct, c?.avg_loss_pct)} />
        <Stat label="Best"        value={`+${s.best_trade_pct}%`} color="text-emerald-400" />
        <Stat label="Avg Hold"    value={`${s.avg_holding_h}h`} />
      </div>
    </div>
  );
};

// ── Trade table ────────────────────────────────────────────────────────────────
const TradeTable: React.FC<{ trades: BacktestTrade[] }> = ({ trades }) => {
  const numColor = (v: number) => v > 0 ? 'text-emerald-400' : 'text-red-400';
  const reasonStyle: Record<string, string> = {
    take_profit: 'bg-emerald-900/50 text-emerald-400',
    partial_tp:  'bg-teal-900/50 text-teal-400',
    stop_loss:   'bg-red-900/50 text-red-400',
    end_of_period: 'bg-slate-800 text-slate-400',
  };
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs">
        <thead>
          <tr className="border-b border-dark-border text-slate-500 uppercase tracking-wide">
            <th className="px-3 py-2 text-left">Bar</th>
            <th className="px-3 py-2 text-left">Side</th>
            <th className="px-3 py-2 text-right">Entry</th>
            <th className="px-3 py-2 text-right">Exit</th>
            <th className="px-3 py-2 text-right">PnL %</th>
            <th className="px-3 py-2 text-right">PnL $</th>
            <th className="px-3 py-2 text-left">Reason</th>
            <th className="px-3 py-2 text-right">Hold</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-dark-border">
          {[...trades].reverse().map((t, i) => (
            <tr key={i} className="hover:bg-dark-bg/50 transition-colors">
              <td className="px-3 py-1.5 text-slate-500 font-mono">{t.bar}</td>
              <td className="px-3 py-1.5">
                <span className={`px-1.5 py-0.5 rounded text-xs font-bold ${t.side === 'long' ? 'bg-emerald-900/60 text-emerald-300' : 'bg-red-900/60 text-red-300'}`}>
                  {t.side.toUpperCase()}
                </span>
              </td>
              <td className="px-3 py-1.5 text-right font-mono text-slate-300">${t.entry.toLocaleString(undefined, { maximumFractionDigits: 0 })}</td>
              <td className="px-3 py-1.5 text-right font-mono text-slate-300">${t.exit.toLocaleString(undefined, { maximumFractionDigits: 0 })}</td>
              <td className={`px-3 py-1.5 text-right font-mono font-bold ${numColor(t.pnl_pct)}`}>
                {t.pnl_pct > 0 ? '+' : ''}{t.pnl_pct}%
              </td>
              <td className={`px-3 py-1.5 text-right font-mono ${numColor(t.pnl_usd)}`}>
                {t.pnl_usd > 0 ? '+' : ''}${t.pnl_usd.toFixed(0)}
              </td>
              <td className="px-3 py-1.5">
                <span className={`px-1.5 py-0.5 rounded text-xs ${reasonStyle[t.reason] ?? 'bg-slate-800 text-slate-400'}`}>
                  {t.reason.replace(/_/g, ' ')}
                </span>
              </td>
              <td className="px-3 py-1.5 text-right text-slate-500">{t.holding_bars * 4}h</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
};

// ── Job runner helper ──────────────────────────────────────────────────────────
async function runJob(apiBase: string, body: object): Promise<BacktestResult> {
  const startRes = await fetch(`${apiBase}/backtest`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const { job_id } = await startRes.json();
  return new Promise((resolve, reject) => {
    const t = setInterval(async () => {
      const r = await fetch(`${apiBase}/backtest/${job_id}`);
      const job = await r.json();
      if (job.status === 'done') {
        clearInterval(t);
        job.result?.error ? reject(new Error(job.result.error)) : resolve(job.result);
      }
    }, 2000);
  });
}

// ── Main component ─────────────────────────────────────────────────────────────
export const BacktestPanel: React.FC<{ apiBase: string }> = ({ apiBase }) => {
  const today        = new Date().toISOString().slice(0, 10);
  const twoYearsAgo  = new Date(Date.now() - 730 * 864e5).toISOString().slice(0, 10);

  const [fromDate,    setFromDate]    = useState(twoYearsAgo);
  const [toDate,      setToDate]      = useState(today);
  const [capital,     setCapital]     = useState('10000');
  const [slMult,      setSlMult]      = useState('2.0');
  const [tpMult,      setTpMult]      = useState('3.5');
  const [posSizePct,  setPosSizePct]  = useState('1.5');
  // Advanced toggles
  const [trailingSL,    setTrailingSL]    = useState(false);
  const [trailAct,      setTrailAct]      = useState('1.0');
  const [partialTP,     setPartialTP]     = useState(false);
  const [partialMult,   setPartialMult]   = useState('1.5');
  const [partialPct,    setPartialPct]    = useState('50');
  const [lgbmExit,      setLgbmExit]      = useState(false);
  const [lgbmThresh,    setLgbmThresh]    = useState('0.30');
  const [lgbmMinHold,   setLgbmMinHold]   = useState('6');
  const [lgbmConfirm,   setLgbmConfirm]   = useState('2');
  const [useChronos,    setUseChronos]    = useState(false);
  const [compareMode,   setCompareMode]   = useState(false);
  // Results
  const [status,   setStatus]   = useState<'idle' | 'running' | 'done' | 'error'>('idle');
  const [result,   setResult]   = useState<BacktestResult | null>(null);
  const [baseline, setBaseline] = useState<BacktestResult | null>(null);
  const [errorMsg, setErrorMsg] = useState('');

  const buildConfig = (withAdvanced: boolean) => ({
    sl_atr_mult: parseFloat(slMult),
    tp_atr_mult: parseFloat(tpMult),
    position_size_pct: parseFloat(posSizePct),
    max_daily_dd_pct: 3.0,
    directional_threshold: 0.62,
    adx_gate: 20.0,
    confluence_gate: 0.0,
    max_consecutive_losses: 4,
    mode: 'paper',
    trailing_sl_enabled:     withAdvanced && trailingSL,
    trailing_sl_activation:  parseFloat(trailAct),
    partial_tp_enabled:      withAdvanced && partialTP,
    partial_tp_atr_mult:     parseFloat(partialMult),
    partial_tp_pct:          parseFloat(partialPct),
    lgbm_exit_enabled:       withAdvanced && lgbmExit,
    lgbm_exit_threshold:     parseFloat(lgbmThresh),
    lgbm_exit_min_hold_bars: parseInt(lgbmMinHold),
    lgbm_exit_confirm_bars:  parseInt(lgbmConfirm),
  });

  const runBacktest = async () => {
    setStatus('running');
    setResult(null);
    setBaseline(null);
    setErrorMsg('');
    try {
      const body = { symbol: 'BTC', from_date: fromDate, to_date: toDate, initial_capital: parseFloat(capital) || 10000, use_chronos: useChronos, config: buildConfig(true) };
      if (compareMode && (trailingSL || partialTP)) {
        const bodyBase = { ...body, config: buildConfig(false) };
        const [r1, r2] = await Promise.all([runJob(apiBase, body), runJob(apiBase, bodyBase)]);
        setResult(r1);
        setBaseline(r2);
      } else {
        const r = await runJob(apiBase, body);
        setResult(r);
      }
      setStatus('done');
    } catch (e: any) {
      setErrorMsg(e.message);
      setStatus('error');
    }
  };

  const advancedActive = trailingSL || partialTP;

  return (
    <div className="space-y-5">
      {/* ── Config ─────────────────────────────────────────────────────────── */}
      <div className="bg-dark-card rounded-xl p-5 border border-dark-border space-y-5">
        <h2 className="text-sm font-semibold text-slate-300 flex items-center gap-2">
          <span className="text-indigo-400">◈</span> Configurazione Backtest
        </h2>

        {/* Base params */}
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
          {[
            { label: 'Da (min: 2017-01-01)', type: 'date', val: fromDate, set: setFromDate, min: '2017-01-01', max: toDate },
            { label: 'A (max: oggi)', type: 'date', val: toDate, set: setToDate, min: fromDate, max: today },
            { label: 'Capitale ($)', type: 'number', val: capital, set: setCapital, min: undefined, max: undefined },
            { label: 'SL mult', type: 'number', val: slMult, set: setSlMult, min: undefined, max: undefined },
            { label: 'TP mult', type: 'number', val: tpMult, set: setTpMult, min: undefined, max: undefined },
            { label: 'Size (%)', type: 'number', val: posSizePct, set: setPosSizePct, min: undefined, max: undefined },
          ].map(f => (
            <label key={f.label} className="flex flex-col gap-1">
              <span className="text-xs text-slate-500">{f.label}</span>
              <input
                type={f.type} value={f.val}
                min={f.min} max={f.max}
                onChange={e => f.set(e.target.value)}
                style={f.type === 'date' ? { colorScheme: 'dark' } : undefined}
                className="bg-dark-bg border border-dark-border rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-indigo-500"
              />
            </label>
          ))}
        </div>

        {/* Advanced exit strategies */}
        <div className="border-t border-dark-border pt-4 space-y-4">
          <p className="text-xs font-semibold text-slate-400 uppercase tracking-wide">Strategie di uscita avanzate</p>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="space-y-3">
              <Toggle label="Trailing Stop Loss" desc="Sposta SL al break-even quando il prezzo si muove in nostro favore" checked={trailingSL} onChange={setTrailingSL} />
              {trailingSL && (
                <label className="ml-13 flex items-center gap-2 text-xs text-slate-400">
                  <span>Attivazione dopo</span>
                  <input type="number" value={trailAct} onChange={e => setTrailAct(e.target.value)} step="0.1" min="0.5" max="3"
                    className="w-16 bg-dark-bg border border-dark-border rounded px-2 py-1 text-white text-xs focus:outline-none focus:border-indigo-500" />
                  <span>× ATR dal entry</span>
                </label>
              )}
            </div>
            <div className="space-y-3">
              <Toggle label="Partial Take Profit" desc="Chiudi una quota della posizione al primo target, lascia correre il resto" checked={partialTP} onChange={setPartialTP} />
              {partialTP && (
                <div className="flex items-center gap-3 text-xs text-slate-400">
                  <label className="flex items-center gap-1">
                    <span>Target:</span>
                    <input type="number" value={partialMult} onChange={e => setPartialMult(e.target.value)} step="0.1" min="0.5" max="5"
                      className="w-14 bg-dark-bg border border-dark-border rounded px-2 py-1 text-white text-xs focus:outline-none focus:border-indigo-500" />
                    <span>× ATR</span>
                  </label>
                  <label className="flex items-center gap-1">
                    <span>Quota:</span>
                    <input type="number" value={partialPct} onChange={e => setPartialPct(e.target.value)} step="5" min="10" max="90"
                      className="w-14 bg-dark-bg border border-dark-border rounded px-2 py-1 text-white text-xs focus:outline-none focus:border-indigo-500" />
                    <span>%</span>
                  </label>
                </div>
              )}
            </div>
          </div>

          {/* LightGBM mid-trade exit */}
          <div className="border-t border-dark-border pt-3">
            <div className="space-y-3">
              <Toggle
                label="LightGBM Mid-Trade Exit"
                desc="Rivaluta il segnale ogni candela mentre il trade è aperto. Se la probabilità direzionale crolla sotto la soglia, chiude prima di SL/TP. Hold minimo evita uscite premature da rumore di breve termine."
                checked={lgbmExit}
                onChange={setLgbmExit}
              />
              {lgbmExit && (
                <div className="flex items-center gap-4 text-xs text-slate-400">
                  <label className="flex items-center gap-1">
                    <span>Soglia p &lt;</span>
                    <input type="number" value={lgbmThresh} onChange={e => setLgbmThresh(e.target.value)} step="0.01" min="0.20" max="0.50"
                      className="w-16 bg-dark-bg border border-dark-border rounded px-2 py-1 text-white text-xs focus:outline-none focus:border-indigo-500" />
                    <span>(default 0.40)</span>
                  </label>
                  <label className="flex items-center gap-1">
                    <span>Hold min</span>
                    <input type="number" value={lgbmMinHold} onChange={e => setLgbmMinHold(e.target.value)} step="1" min="1" max="48"
                      className="w-14 bg-dark-bg border border-dark-border rounded px-2 py-1 text-white text-xs focus:outline-none focus:border-indigo-500" />
                    <span>barre</span>
                  </label>
                  <label className="flex items-center gap-1">
                    <span>Conferma</span>
                    <input type="number" value={lgbmConfirm} onChange={e => setLgbmConfirm(e.target.value)} step="1" min="1" max="6"
                      className="w-12 bg-dark-bg border border-dark-border rounded px-2 py-1 text-white text-xs focus:outline-none focus:border-indigo-500" />
                    <span>consec.</span>
                  </label>
                </div>
              )}
            </div>
          </div>

          {advancedActive && (
            <Toggle label="Confronto A/B" desc="Esegue anche il backtest senza le strategie avanzate per mostrare le differenze" checked={compareMode} onChange={setCompareMode} />
          )}

          {/* Chronos-2 toggle */}
          <div className="border-t border-dark-border pt-3">
            <Toggle
              label="Chronos-2 attivo"
              desc={`Abilita l'inferenza reale di Chronos-2 per ogni candela (blend 40% C2 + 60% LightGBM). Attenzione: ~3s per candela — su periodi lunghi può richiedere ore. Consigliato solo su periodi di 1-2 mesi.`}
              checked={useChronos}
              onChange={setUseChronos}
            />
            {useChronos && (
              <p className="mt-2 ml-13 text-xs text-amber-400/80 font-mono">
                ⚠ 1 mese ≈ 10 min · 3 mesi ≈ 30 min · 1 anno ≈ 2h — usa periodi brevi
              </p>
            )}
          </div>
        </div>

        {/* Run button */}
        <div className="flex items-center gap-4">
          <button onClick={runBacktest} disabled={status === 'running'}
            className="px-5 py-2.5 bg-indigo-600 hover:bg-indigo-500 disabled:bg-indigo-800 disabled:cursor-not-allowed text-white text-sm font-semibold rounded-lg transition-colors flex items-center gap-2">
            {status === 'running' ? (
              <>
                <svg className="w-4 h-4 animate-spin" viewBox="0 0 24 24" fill="none">
                  <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" strokeDasharray="40 20" />
                </svg>
                {compareMode && advancedActive ? 'Eseguendo 2 backtest…' : 'Eseguendo…'}
              </>
            ) : 'Avvia Backtest'}
          </button>
          {status === 'error' && <span className="text-xs text-red-400">{errorMsg}</span>}
        </div>
      </div>

      {/* ── Results ──────────────────────────────────────────────────────────── */}
      {result && (
        <>
          {/* Header */}
          <div className="bg-dark-card rounded-xl p-4 border border-dark-border flex flex-wrap gap-6 text-sm">
            <div>
              <span className="text-slate-500 text-xs">Periodo</span>
              <p className="text-white font-medium">{result.from_date} → {result.to_date}</p>
            </div>
            <div>
              <span className="text-slate-500 text-xs">Capitale iniziale → finale</span>
              <p className={`font-bold ${result.final_equity >= result.initial_capital ? 'text-emerald-400' : 'text-red-400'}`}>
                ${result.initial_capital.toLocaleString()} → ${result.final_equity.toLocaleString()}
              </p>
            </div>
            <div>
              <span className="text-slate-500 text-xs">PnL totale</span>
              <p className={`font-bold text-base ${result.stats.total_pnl_usd >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                {result.stats.total_pnl_usd >= 0 ? '+' : ''}${result.stats.total_pnl_usd.toFixed(2)} ({result.stats.total_pnl_pct > 0 ? '+' : ''}{result.stats.total_pnl_pct}%)
              </p>
            </div>
            {advancedActive && (
              <div className="ml-auto flex items-center gap-2">
                <span className="text-xs px-2 py-1 rounded-full bg-indigo-600/20 text-indigo-400 border border-indigo-600/30">
                  {[trailingSL && 'Trailing SL', partialTP && `Partial TP ${partialPct}%`].filter(Boolean).join(' + ')}
                </span>
              </div>
            )}
          </div>

          {/* Equity curves */}
          <div className={`grid gap-4 ${baseline ? 'grid-cols-1 lg:grid-cols-2' : 'grid-cols-1'}`}>
            <div className="bg-dark-card rounded-xl p-4 border border-dark-border">
              <h3 className="text-xs font-semibold text-slate-400 uppercase tracking-wide mb-2">
                {baseline ? '✦ Con strategie avanzate' : 'Curva Equity'}
              </h3>
              <EquityChart data={result.equity_curve} initialCapital={result.initial_capital} color={baseline ? '#818cf8' : undefined} />
            </div>
            {baseline && (
              <div className="bg-dark-card rounded-xl p-4 border border-dark-border">
                <h3 className="text-xs font-semibold text-slate-400 uppercase tracking-wide mb-2">
                  ○ Baseline (solo SL/TP fisso)
                </h3>
                <EquityChart data={baseline.equity_curve} initialCapital={baseline.initial_capital} color="#64748b" />
              </div>
            )}
          </div>

          {/* Stats */}
          <div className="bg-dark-card rounded-xl p-4 border border-dark-border">
            {baseline ? (
              <div className="space-y-4">
                <StatsGrid stats={result.stats}   compare={baseline.stats} label="✦ Con strategie avanzate (δ = differenza rispetto al baseline)" />
                <div className="border-t border-dark-border pt-4">
                  <StatsGrid stats={baseline.stats} label="○ Baseline" />
                </div>
              </div>
            ) : (
              <StatsGrid stats={result.stats} />
            )}
          </div>

          {/* Trade table */}
          {result.trades.length > 0 && (
            <div className="bg-dark-card rounded-xl border border-dark-border overflow-hidden">
              <div className="px-4 py-3 border-b border-dark-border">
                <h3 className="text-xs font-semibold text-slate-400 uppercase tracking-wide">
                  Ultimi {result.trades.length} trade
                </h3>
              </div>
              <TradeTable trades={result.trades} />
            </div>
          )}
        </>
      )}
    </div>
  );
};
