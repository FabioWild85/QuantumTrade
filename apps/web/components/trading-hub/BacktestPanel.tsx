import React, { useState, useRef, useEffect, useCallback } from 'react';
import { Tooltip } from './Tooltip';

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

// ── History types ──────────────────────────────────────────────────────────────
interface HistoryItem {
  id: string;
  name?: string;
  created_at: string;
  symbol: string;
  from_date: string;
  to_date: string;
  summary: {
    total_trades: number;
    win_rate: number;
    total_pnl_pct: number;
    sharpe: number;
  };
  result?: BacktestResult;
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
const STAT_TOOLTIPS: Record<string, string> = {
  Trades:         'Numero totale di trade simulati nel periodo.',
  'Win Rate':     'Percentuale di trade chiusi in profitto. Sopra 50% è il punto di pareggio minimo; l\'obiettivo è 55%+.',
  'PnL %':        'Rendimento percentuale totale sul capitale iniziale nel periodo simulato.',
  'Profit Factor':'Somma dei profitti diviso somma delle perdite. Sopra 1.5 è buono, sopra 2.0 è eccellente.',
  Sharpe:         'Misura il rendimento aggiustato per il rischio. Calcolato come rendimento medio diviso deviazione standard, annualizzato. Sopra 0.7 è buono.',
  Sortino:        'Come lo Sharpe, ma penalizza solo la volatilità negativa (drawdown). Più preciso per strategie asimmetriche. Sopra 1.0 è buono.',
  Calmar:         'Rendimento annuo diviso massimo drawdown. Misura quando guadagni per ogni dollaro perso nel worst case. Sopra 0.5 è accettabile.',
  'Max DD':       'Massimo Drawdown: la perdita massima dal picco al minimo durante il periodo simulato. Più basso è meglio.',
  'Avg Win':      'Guadagno percentuale medio sui trade in profitto.',
  'Avg Loss':     'Perdita percentuale media sui trade in negativo.',
  Best:           'Miglior singolo trade del backtest in percentuale.',
  'Avg Hold':     'Durata media di ogni trade in ore.',
};

const StatsGrid: React.FC<{ stats: BacktestStats; compare?: BacktestStats; label?: string }> = ({ stats: s, compare: c, label }) => {
  const pnlColor = (v: number) => v > 0 ? 'text-emerald-400' : v < 0 ? 'text-red-400' : 'text-slate-400';
  const delta = (a: number, b?: number) => b !== undefined ? a - b : undefined;
  const tipStat = (lbl: string, node: React.ReactNode) => (
    <Tooltip key={lbl} text={STAT_TOOLTIPS[lbl] ?? lbl} pos="top" width="wide">
      {node}
    </Tooltip>
  );
  return (
    <div>
      {label && <h4 className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-2">{label}</h4>}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2">
        {tipStat('Trades',        <Stat label="Trades"       value={String(s.total_trades)} delta={delta(s.total_trades, c?.total_trades)} />)}
        {tipStat('Win Rate',      <Stat label="Win Rate"     value={`${s.win_rate}%`} color={s.win_rate >= 50 ? 'text-emerald-400' : 'text-red-400'} delta={delta(s.win_rate, c?.win_rate)} />)}
        {tipStat('PnL %',         <Stat label="PnL %"        value={`${s.total_pnl_pct > 0 ? '+' : ''}${s.total_pnl_pct}%`} color={pnlColor(s.total_pnl_pct)} delta={delta(s.total_pnl_pct, c?.total_pnl_pct)} />)}
        {tipStat('Profit Factor', <Stat label="Profit Factor" value={s.profit_factor >= 99 ? '∞' : s.profit_factor.toFixed(2)} color={s.profit_factor >= 1.5 ? 'text-emerald-400' : s.profit_factor >= 1 ? 'text-amber-400' : 'text-red-400'} delta={delta(s.profit_factor, c?.profit_factor)} />)}
        {tipStat('Sharpe',        <Stat label="Sharpe"       value={s.sharpe.toFixed(3)} color={s.sharpe >= 0.7 ? 'text-emerald-400' : s.sharpe >= 0 ? 'text-amber-400' : 'text-red-400'} delta={delta(s.sharpe, c?.sharpe)} />)}
        {tipStat('Sortino',       <Stat label="Sortino"      value={s.sortino.toFixed(3)} color={s.sortino >= 1 ? 'text-emerald-400' : s.sortino >= 0 ? 'text-amber-400' : 'text-red-400'} delta={delta(s.sortino, c?.sortino)} />)}
        {tipStat('Calmar',        <Stat label="Calmar"       value={s.calmar.toFixed(3)} color={s.calmar >= 0.5 ? 'text-emerald-400' : s.calmar >= 0 ? 'text-amber-400' : 'text-red-400'} delta={delta(s.calmar, c?.calmar)} />)}
        {tipStat('Max DD',        <Stat label="Max DD"       value={`-${s.max_drawdown_pct}%`} color="text-red-400" delta={c ? -(s.max_drawdown_pct - c.max_drawdown_pct) : undefined} />)}
        {tipStat('Avg Win',       <Stat label="Avg Win"      value={`+${s.avg_win_pct}%`} color="text-emerald-400" delta={delta(s.avg_win_pct, c?.avg_win_pct)} />)}
        {tipStat('Avg Loss',      <Stat label="Avg Loss"     value={`${s.avg_loss_pct}%`} color="text-red-400" delta={delta(s.avg_loss_pct, c?.avg_loss_pct)} />)}
        {tipStat('Best',          <Stat label="Best"         value={`+${s.best_trade_pct}%`} color="text-emerald-400" />)}
        {tipStat('Avg Hold',      <Stat label="Avg Hold"     value={`${s.avg_holding_h}h`} />)}
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

// ── Leverage simulation (pure frontend — no re-run needed) ────────────────────
const LEVERAGE_OPTIONS = [1, 5, 10, 20, 30, 40, 50] as const;
type LeverageOption = typeof LEVERAGE_OPTIONS[number];

function applyLeverage(result: BacktestResult, lev: number): BacktestResult {
  if (lev === 1) return result;

  const init = result.initial_capital;
  const origCurve = result.equity_curve;

  // Rebuild levered equity curve compounding per-segment returns
  const levCurve: EquityPoint[] = [{ bar: origCurve[0]?.bar ?? 0, equity: init }];
  let bankrupt = false;
  for (let i = 1; i < origCurve.length; i++) {
    const prevOrig = origCurve[i - 1].equity;
    const currOrig = origCurve[i].equity;
    const segReturn = prevOrig > 0 ? (currOrig - prevOrig) / prevOrig : 0;
    const prevLev   = levCurve[i - 1].equity;
    const newEq     = bankrupt ? 0 : Math.max(0, prevLev * (1 + segReturn * lev));
    if (newEq === 0) bankrupt = true;
    levCurve.push({ bar: origCurve[i].bar, equity: Math.round(newEq * 100) / 100 });
  }
  const finalEquity = levCurve[levCurve.length - 1].equity;

  // Scale individual trade P&L
  const levTrades = result.trades.map(t => ({
    ...t,
    pnl_pct: Math.round(t.pnl_pct * lev * 10000) / 10000,
    pnl_usd: Math.round(t.pnl_usd * lev * 100) / 100,
  }));

  // Recalculate stats from levered data
  const pnlsPct = levTrades.map(t => t.pnl_pct);
  const pnlsUsd = levTrades.map(t => t.pnl_usd);
  const wins     = pnlsPct.filter(p => p > 0);
  const losses   = pnlsPct.filter(p => p <= 0);
  const totalPnlUsd = pnlsUsd.reduce((a, b) => a + b, 0);
  const totalPnlPct = (totalPnlUsd / init) * 100;
  const winRate     = pnlsPct.length > 0 ? (wins.length / pnlsPct.length) * 100 : 0;
  const pf          = losses.length > 0 ? Math.abs(wins.reduce((a,b)=>a+b,0) / losses.reduce((a,b)=>a+b,0)) : 99;

  // Max drawdown from levered curve
  let peak = init, maxDd = 0;
  for (const p of levCurve) {
    if (p.equity > peak) peak = p.equity;
    const dd = peak > 0 ? (peak - p.equity) / peak * 100 : 0;
    if (dd > maxDd) maxDd = dd;
  }

  // Sharpe/Sortino from levered curve returns
  const eqVals = levCurve.map(p => p.equity);
  const rets   = eqVals.slice(1).map((v, i) => eqVals[i] > 0 ? (v - eqVals[i]) / eqVals[i] : 0);
  const ann    = Math.sqrt(365 * 6);
  const mean   = rets.length ? rets.reduce((a,b)=>a+b,0) / rets.length : 0;
  const std    = rets.length ? Math.sqrt(rets.map(r=>(r-mean)**2).reduce((a,b)=>a+b,0)/rets.length) : 0;
  const sharpe = std > 0 ? mean / std * ann : 0;
  const negR   = rets.filter(r => r < 0);
  const dStd   = negR.length > 0 ? Math.sqrt(negR.map(r=>r**2).reduce((a,b)=>a+b,0)/negR.length) : std;
  const sortino = dStd > 0 ? mean / dStd * ann : sharpe;
  const calmar  = maxDd > 0 ? totalPnlPct / maxDd : 0;

  const r = (v: number, d = 2) => Math.round(v * 10 ** d) / 10 ** d;

  return {
    ...result,
    final_equity: finalEquity,
    trades: levTrades,
    equity_curve: levCurve,
    stats: {
      total_trades:     result.stats.total_trades,
      win_rate:         r(winRate),
      avg_win_pct:      r(result.stats.avg_win_pct * lev, 4),
      avg_loss_pct:     r(result.stats.avg_loss_pct * lev, 4),
      profit_factor:    r(pf, 3),
      total_pnl_usd:    r(totalPnlUsd),
      total_pnl_pct:    r(totalPnlPct),
      sharpe:           r(isFinite(sharpe) ? sharpe : 0, 3),
      sortino:          r(isFinite(sortino) ? sortino : 0, 3),
      calmar:           r(isFinite(calmar) ? calmar : 0, 3),
      max_drawdown_pct: r(maxDd),
      avg_holding_h:    result.stats.avg_holding_h,
      best_trade_pct:   r(Math.max(...pnlsPct, 0), 4),
      worst_trade_pct:  r(Math.min(...pnlsPct, 0), 4),
    },
  };
}

// ── Leverage selector bar ─────────────────────────────────────────────────────
const LeverageSelector: React.FC<{
  value: LeverageOption;
  onChange: (v: LeverageOption) => void;
  worstTradePct: number;
}> = ({ value, onChange, worstTradePct }) => {
  const liqThreshold = value > 1 ? -(100 / value) : null;
  const worstAbs = Math.abs(worstTradePct);
  const liqRisk  = liqThreshold !== null && worstAbs >= Math.abs(liqThreshold);

  return (
    <div className="flex flex-wrap items-center gap-3">
      <Tooltip text="Simulatore di leva: ricalcola i risultati come se avessi tradato con leva finanziaria. 1× = senza leva (risultato reale). Attenzione: la leva amplifica sia i guadagni che le perdite, e può portare alla liquidazione." width="wide" pos="top">
        <span className="text-xs text-slate-500 font-medium uppercase tracking-wide whitespace-nowrap cursor-help">Sim. Leva</span>
      </Tooltip>
      <div className="flex gap-1 flex-wrap">
        {LEVERAGE_OPTIONS.map(opt => (
          <button
            key={opt}
            onClick={() => onChange(opt)}
            className={`px-2.5 py-1 rounded-lg text-xs font-bold font-mono transition-colors ${
              value === opt
                ? 'bg-indigo-600 text-white'
                : 'bg-white/5 border border-dark-border text-slate-400 hover:text-white hover:bg-white/10'
            }`}
          >
            {opt === 1 ? '1× (reale)' : `${opt}×`}
          </button>
        ))}
      </div>
      {liqThreshold !== null && (
        <span className={`text-xs px-2 py-1 rounded-full border font-mono ${
          liqRisk
            ? 'bg-red-600/20 border-red-500/40 text-red-400'
            : 'bg-amber-600/10 border-amber-500/30 text-amber-400'
        }`}>
          {liqRisk ? '⚠ RISCHIO LIQUIDAZIONE' : `Liquidazione se trade > ${Math.abs(liqThreshold).toFixed(1)}% loss`}
        </span>
      )}
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

// ── History result card ────────────────────────────────────────────────────────
const HistoryResultCard: React.FC<{ result: BacktestResult }> = ({ result }) => {
  const [lev, setLev] = useState<LeverageOption>(1);
  const disp = applyLeverage(result, lev);

  return (
    <div className="mt-4 space-y-4">
      {/* Leverage selector */}
      <div className="bg-dark-bg rounded-lg px-4 py-3 border border-dark-border">
        <LeverageSelector value={lev} onChange={setLev} worstTradePct={result.stats.worst_trade_pct} />
      </div>
      {/* Header summary */}
      <div className="bg-dark-bg rounded-lg p-3 flex flex-wrap gap-6 text-sm border border-dark-border">
        <div>
          <span className="text-slate-500 text-xs">Periodo</span>
          <p className="text-white font-medium">{result.from_date} → {result.to_date}</p>
        </div>
        <div>
          <span className="text-slate-500 text-xs">Capitale iniziale → finale</span>
          <p className={`font-bold ${disp.final_equity >= result.initial_capital ? 'text-emerald-400' : 'text-red-400'}`}>
            ${result.initial_capital.toLocaleString()} → ${disp.final_equity.toLocaleString()}
            {lev > 1 && <span className="ml-1.5 text-xs font-normal text-indigo-400">{lev}× sim</span>}
          </p>
        </div>
        <div>
          <span className="text-slate-500 text-xs">PnL totale</span>
          <p className={`font-bold text-base ${disp.stats.total_pnl_usd >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
            {disp.stats.total_pnl_usd >= 0 ? '+' : ''}${disp.stats.total_pnl_usd.toFixed(2)} ({disp.stats.total_pnl_pct > 0 ? '+' : ''}{disp.stats.total_pnl_pct}%)
          </p>
        </div>
      </div>
      {/* Equity curve */}
      <div className="bg-dark-bg rounded-lg p-3 border border-dark-border">
        <h3 className="text-xs font-semibold text-slate-400 uppercase tracking-wide mb-2">
          Curva Equity{lev > 1 ? ` — simulazione ${lev}×` : ''}
        </h3>
        <EquityChart data={disp.equity_curve} initialCapital={result.initial_capital} />
      </div>
      {/* Stats grid */}
      <div className="bg-dark-bg rounded-lg p-3 border border-dark-border">
        <StatsGrid stats={disp.stats} compare={lev > 1 ? result.stats : undefined} label={lev > 1 ? `${lev}× leva (δ = differenza vs 1×)` : undefined} />
      </div>
      {/* Trade table */}
      {disp.trades.length > 0 && (
        <div className="bg-dark-bg rounded-lg border border-dark-border overflow-hidden">
          <div className="px-4 py-3 border-b border-dark-border">
            <h3 className="text-xs font-semibold text-slate-400 uppercase tracking-wide">
              Ultimi {disp.trades.length} trade{lev > 1 ? ` — ${lev}× leva` : ''}
            </h3>
          </div>
          <TradeTable trades={disp.trades} />
        </div>
      )}
    </div>
  );
};

// ── History tab ────────────────────────────────────────────────────────────────
const HistoryTab: React.FC<{ apiBase: string }> = ({ apiBase }) => {
  const [items, setItems]             = useState<HistoryItem[]>([]);
  const [loading, setLoading]         = useState(false);
  const [expandedId, setExpandedId]   = useState<string | null>(null);
  const [loadingDetailId, setLoadingDetailId] = useState<string | null>(null);
  const [editingId, setEditingId]     = useState<string | null>(null);
  const [editingName, setEditingName] = useState('');
  const [deletingId, setDeletingId]   = useState<string | null>(null);

  const fetchHistory = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`${apiBase}/backtest-history`);
      const data = await res.json();
      setItems(Array.isArray(data) ? data : (data.items ?? []));
    } catch {
      setItems([]);
    } finally {
      setLoading(false);
    }
  }, [apiBase]);

  useEffect(() => { fetchHistory(); }, [fetchHistory]);

  const handleExpand = async (itemId: string) => {
    const isOpen = expandedId === itemId;
    setExpandedId(isOpen ? null : itemId);
    if (isOpen) return;

    // Fetch full result only if not already loaded
    const item = items.find(i => i.id === itemId);
    if (item && !item.result) {
      setLoadingDetailId(itemId);
      try {
        const res  = await fetch(`${apiBase}/backtest-history/${itemId}`);
        const data = await res.json();
        // API returns { ..., results: BacktestResult }
        const fullResult: BacktestResult | undefined = data.results ?? data.result;
        if (fullResult) {
          setItems(prev => prev.map(i => i.id === itemId ? { ...i, result: fullResult } : i));
        }
      } catch { /* silent — will show fallback */ }
      finally { setLoadingDetailId(null); }
    }
  };

  const handleDelete = async (id: string) => {
    setDeletingId(id);
    try {
      await fetch(`${apiBase}/backtest-history/${id}`, { method: 'DELETE' });
      setItems(prev => prev.filter(item => item.id !== id));
      if (expandedId === id) setExpandedId(null);
    } finally {
      setDeletingId(null);
    }
  };

  const handleRenameStart = (item: HistoryItem) => {
    setEditingId(item.id);
    setEditingName(item.name ?? '');
  };

  const handleRenameCommit = async (id: string) => {
    const name = editingName.trim();
    setEditingId(null);
    if (!name) return;
    try {
      await fetch(`${apiBase}/backtest-history/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      });
      setItems(prev => prev.map(item => item.id === id ? { ...item, name } : item));
    } catch { /* silent */ }
  };

  const formatDate = (iso: string) => {
    try {
      return new Date(iso).toLocaleString('it-IT', {
        day: '2-digit', month: '2-digit', year: 'numeric',
        hour: '2-digit', minute: '2-digit',
      });
    } catch {
      return iso;
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-16 text-slate-400">
        <svg className="w-5 h-5 animate-spin mr-2" viewBox="0 0 24 24" fill="none">
          <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" strokeDasharray="40 20" />
        </svg>
        Caricamento storico…
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {/* Toolbar */}
      <div className="flex items-center justify-between">
        <span className="text-xs text-slate-500">{items.length} backtest salvat{items.length === 1 ? 'o' : 'i'}</span>
        <button
          onClick={fetchHistory}
          className="flex items-center gap-1.5 px-3 py-1.5 text-xs bg-white/5 hover:bg-white/10 border border-dark-border rounded-lg text-slate-400 hover:text-white transition-colors"
        >
          <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path strokeLinecap="round" strokeLinejoin="round" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
          </svg>
          Aggiorna
        </button>
      </div>

      {items.length === 0 ? (
        <div className="bg-dark-card rounded-xl p-10 border border-dark-border text-center text-slate-500 text-sm">
          Nessun backtest salvato
        </div>
      ) : (
        <div className="space-y-2">
          {items.map(item => {
            const pnlPositive    = item.summary.total_pnl_pct > 0;
            const pnlNeutral     = item.summary.total_pnl_pct === 0;
            const isExpanded     = expandedId === item.id;
            const isDeleting     = deletingId === item.id;
            const isLoadingDetail = loadingDetailId === item.id;

            return (
              <div
                key={item.id}
                className="bg-dark-card rounded-xl border border-dark-border overflow-hidden"
              >
                {/* Card header row */}
                <div
                  className="px-4 py-3 flex items-center gap-3 cursor-pointer hover:bg-white/5 transition-colors select-none"
                  onClick={() => handleExpand(item.id)}
                >
                  {/* Expand chevron */}
                  <svg
                    className={`w-4 h-4 text-slate-500 flex-shrink-0 transition-transform ${isExpanded ? 'rotate-90' : ''}`}
                    viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
                  >
                    <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
                  </svg>

                  {/* Name / inline edit */}
                  <div className="flex-1 min-w-0" onClick={e => e.stopPropagation()}>
                    {editingId === item.id ? (
                      <input
                        autoFocus
                        type="text"
                        value={editingName}
                        onChange={e => setEditingName(e.target.value)}
                        onBlur={() => handleRenameCommit(item.id)}
                        onKeyDown={e => {
                          if (e.key === 'Enter') handleRenameCommit(item.id);
                          if (e.key === 'Escape') setEditingId(null);
                        }}
                        className="bg-dark-bg border border-indigo-500 rounded px-2 py-0.5 text-sm text-white focus:outline-none w-full max-w-xs"
                      />
                    ) : (
                      <span
                        className="text-sm font-medium text-white truncate cursor-text hover:text-indigo-300 transition-colors"
                        title="Clicca per rinominare"
                        onClick={() => handleRenameStart(item)}
                      >
                        {item.name || `${item.symbol} · ${item.from_date} → ${item.to_date}`}
                      </span>
                    )}
                    <p className="text-xs text-slate-500 mt-0.5">{formatDate(item.created_at)}</p>
                  </div>

                  {/* Quick stats */}
                  <div className="hidden sm:flex items-center gap-4 text-xs font-mono flex-shrink-0">
                    <span className="text-slate-400">
                      <span className="text-slate-600 text-[10px] uppercase mr-1">Trades</span>
                      {item.summary.total_trades}
                    </span>
                    <span className="text-slate-400">
                      <span className="text-slate-600 text-[10px] uppercase mr-1">WR</span>
                      {item.summary.win_rate}%
                    </span>
                    <span className="text-slate-400">
                      <span className="text-slate-600 text-[10px] uppercase mr-1">Sharpe</span>
                      {item.summary.sharpe?.toFixed(2) ?? '—'}
                    </span>
                  </div>

                  {/* PnL badge */}
                  <span className={`flex-shrink-0 px-2.5 py-1 rounded-full text-xs font-bold font-mono ${
                    pnlNeutral  ? 'bg-slate-700 text-slate-300' :
                    pnlPositive ? 'bg-emerald-600/20 text-emerald-400 border border-emerald-600/30' :
                                  'bg-red-600/20 text-red-400 border border-red-600/30'
                  }`}>
                    {item.summary.total_pnl_pct > 0 ? '+' : ''}{item.summary.total_pnl_pct}%
                  </span>

                  {/* Delete button */}
                  <button
                    onClick={e => { e.stopPropagation(); handleDelete(item.id); }}
                    disabled={isDeleting}
                    className="flex-shrink-0 p-1.5 rounded-lg text-slate-600 hover:text-red-400 hover:bg-red-400/10 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                    title="Elimina"
                  >
                    {isDeleting ? (
                      <svg className="w-4 h-4 animate-spin" viewBox="0 0 24 24" fill="none">
                        <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" strokeDasharray="40 20" />
                      </svg>
                    ) : (
                      <span className="text-base leading-none">🗑</span>
                    )}
                  </button>
                </div>

                {/* Expanded results */}
                {isExpanded && (
                  <div className="px-4 pb-4 border-t border-dark-border">
                    {isLoadingDetail ? (
                      <div className="flex items-center justify-center py-10 text-slate-400 gap-2">
                        <svg className="w-4 h-4 animate-spin" viewBox="0 0 24 24" fill="none">
                          <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" strokeDasharray="40 20" />
                        </svg>
                        <span className="text-xs">Caricamento report…</span>
                      </div>
                    ) : item.result ? (
                      <HistoryResultCard result={item.result} />
                    ) : (
                      <p className="text-xs text-slate-500 py-4 text-center">
                        Risultato completo non disponibile per questo backtest.
                      </p>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};

// ── Numeric input helper ────────────────────────────────────────────────────────
const NumInput: React.FC<{
  label: string; value: string; onChange: (v: string) => void;
  step?: string; min?: string; max?: string; unit?: string;
}> = ({ label, value, onChange, step = '0.01', min, max, unit }) => (
  <label className="flex flex-col gap-1">
    <span className="text-xs text-slate-500">{label}</span>
    <div className="flex items-center gap-1.5">
      <input
        type="number" value={value} onChange={e => onChange(e.target.value)}
        step={step} min={min} max={max}
        className="w-full bg-[#0d1117] border border-[#1e2433] rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-indigo-500"
      />
      {unit && <span className="text-xs text-slate-600 whitespace-nowrap">{unit}</span>}
    </div>
  </label>
);

// ── Main component ─────────────────────────────────────────────────────────────
export const BacktestPanel: React.FC<{ apiBase: string }> = ({ apiBase }) => {
  const today        = new Date().toISOString().slice(0, 10);
  const twoYearsAgo  = new Date(Date.now() - 730 * 864e5).toISOString().slice(0, 10);

  // ── Sub-tab state ────────────────────────────────────────────────────────────
  const [activeTab, setActiveTab] = useState<'nuovo' | 'storico'>('nuovo');

  // ── Main config ──────────────────────────────────────────────────────────────
  const [fromDate,    setFromDate]    = useState(twoYearsAgo);
  const [toDate,      setToDate]      = useState(today);
  const [capital,     setCapital]     = useState('10000');
  const [slMult,      setSlMult]      = useState('2.0');
  const [tpMult,      setTpMult]      = useState('3.5');
  const [posSizePct,  setPosSizePct]  = useState('1.5');
  // Exit strategies
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

  // ── Advanced settings drawer ─────────────────────────────────────────────────
  const [isDrawerOpen,  setIsDrawerOpen]  = useState(false);
  const [drawerSaving,  setDrawerSaving]  = useState(false);
  const [drawerLoading, setDrawerLoading] = useState(false);
  // Signal controls
  const [advDirThresh,   setAdvDirThresh]   = useState('0.62');
  const [advAdxGate,     setAdvAdxGate]     = useState('20.0');
  const [advConfGate,    setAdvConfGate]    = useState('60.0');
  const [advAdxEnabled,  setAdvAdxEnabled]  = useState(true);
  const [advSweepEnabled,setAdvSweepEnabled]= useState(true);
  const [advFvgEnabled,  setAdvFvgEnabled]  = useState(true);
  const [advMtfEnabled,  setAdvMtfEnabled]  = useState(true);
  // Chronos blend
  const [advChronosWeight, setAdvChronosWeight] = useState('0.40');
  // Position management
  const [advBeSL,        setAdvBeSL]        = useState(false);
  const [advBeSLAct,     setAdvBeSLAct]     = useState('1.0');
  const [advMaxHold,     setAdvMaxHold]     = useState(false);
  const [advMaxHoldBars, setAdvMaxHoldBars] = useState('48');

  // ── Results ───────────────────────────────────────────────────────────────────
  const [status,   setStatus]   = useState<'idle' | 'running' | 'done' | 'error'>('idle');
  const [result,   setResult]   = useState<BacktestResult | null>(null);
  const [baseline, setBaseline] = useState<BacktestResult | null>(null);
  const [errorMsg, setErrorMsg] = useState('');
  const [leverage, setLeverage] = useState<LeverageOption>(1);

  // ── Load backtest config from API on mount ────────────────────────────────────
  const applyConfig = useCallback((p: Record<string, any>) => {
    if (p.sl_atr_mult        !== undefined) setSlMult(String(p.sl_atr_mult));
    if (p.tp_atr_mult        !== undefined) setTpMult(String(p.tp_atr_mult));
    if (p.position_size_pct  !== undefined) setPosSizePct(String(p.position_size_pct));
    if (p.trailing_sl_enabled   !== undefined) setTrailingSL(!!p.trailing_sl_enabled);
    if (p.trailing_sl_activation!== undefined) setTrailAct(String(p.trailing_sl_activation));
    if (p.partial_tp_enabled    !== undefined) setPartialTP(!!p.partial_tp_enabled);
    if (p.partial_tp_atr_mult   !== undefined) setPartialMult(String(p.partial_tp_atr_mult));
    if (p.partial_tp_pct        !== undefined) setPartialPct(String(p.partial_tp_pct));
    if (p.lgbm_exit_enabled     !== undefined) setLgbmExit(!!p.lgbm_exit_enabled);
    if (p.lgbm_exit_threshold   !== undefined) setLgbmThresh(String(p.lgbm_exit_threshold));
    if (p.lgbm_exit_min_hold_bars!== undefined) setLgbmMinHold(String(p.lgbm_exit_min_hold_bars));
    if (p.lgbm_exit_confirm_bars !== undefined) setLgbmConfirm(String(p.lgbm_exit_confirm_bars));
    // Drawer (advanced)
    if (p.directional_threshold !== undefined) setAdvDirThresh(String(p.directional_threshold));
    if (p.adx_gate              !== undefined) setAdvAdxGate(String(p.adx_gate));
    if (p.confluence_gate       !== undefined) setAdvConfGate(String(p.confluence_gate));
    if (p.adx_gate_enabled      !== undefined) setAdvAdxEnabled(!!p.adx_gate_enabled);
    if (p.sweep_gate_enabled    !== undefined) setAdvSweepEnabled(!!p.sweep_gate_enabled);
    if (p.fvg_filter_enabled    !== undefined) setAdvFvgEnabled(!!p.fvg_filter_enabled);
    if (p.mtf_alignment_enabled !== undefined) setAdvMtfEnabled(!!p.mtf_alignment_enabled);
    if (p.chronos_weight        !== undefined) setAdvChronosWeight(String(p.chronos_weight));
    if (p.be_sl_enabled         !== undefined) setAdvBeSL(!!p.be_sl_enabled);
    if (p.be_sl_activation      !== undefined) setAdvBeSLAct(String(p.be_sl_activation));
    if (p.max_hold_bars_enabled !== undefined) setAdvMaxHold(!!p.max_hold_bars_enabled);
    if (p.max_hold_bars         !== undefined) setAdvMaxHoldBars(String(p.max_hold_bars));
  }, []);

  useEffect(() => {
    fetch(`${apiBase}/bot/backtest`)
      .then(r => r.json())
      .then(applyConfig)
      .catch(() => {/* silent — use defaults */});
  }, [apiBase, applyConfig]);

  const loadFromLive = async () => {
    setDrawerLoading(true);
    try {
      const r = await fetch(`${apiBase}/bot`);
      const p = await r.json();
      applyConfig(p);
    } finally {
      setDrawerLoading(false);
    }
  };

  const saveAsDefault = async () => {
    setDrawerSaving(true);
    try {
      await fetch(`${apiBase}/bot/backtest`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(buildConfig(true)),
      });
    } finally {
      setDrawerSaving(false);
    }
  };

  const buildConfig = (withAdvanced: boolean) => ({
    sl_atr_mult:              parseFloat(slMult),
    tp_atr_mult:              parseFloat(tpMult),
    position_size_pct:        parseFloat(posSizePct),
    max_daily_dd_pct:         3.0,
    directional_threshold:    parseFloat(advDirThresh),
    adx_gate:                 parseFloat(advAdxGate),
    confluence_gate:          parseFloat(advConfGate),
    max_consecutive_losses:   4,
    mode:                     'paper',
    // Exit strategies
    trailing_sl_enabled:      withAdvanced && trailingSL,
    trailing_sl_activation:   parseFloat(trailAct),
    partial_tp_enabled:       withAdvanced && partialTP,
    partial_tp_atr_mult:      parseFloat(partialMult),
    partial_tp_pct:           parseFloat(partialPct),
    lgbm_exit_enabled:        withAdvanced && lgbmExit,
    lgbm_exit_threshold:      parseFloat(lgbmThresh),
    lgbm_exit_min_hold_bars:  parseInt(lgbmMinHold),
    lgbm_exit_confirm_bars:   parseInt(lgbmConfirm),
    // Advanced signal controls (always active — drawer only)
    chronos_enabled:          false,
    chronos_weight:           parseFloat(advChronosWeight),
    adx_gate_enabled:         advAdxEnabled,
    sweep_gate_enabled:       advSweepEnabled,
    fvg_filter_enabled:       advFvgEnabled,
    mtf_alignment_enabled:    advMtfEnabled,
    // Advanced position management
    be_sl_enabled:            advBeSL,
    be_sl_activation:         parseFloat(advBeSLAct),
    max_hold_bars_enabled:    advMaxHold,
    max_hold_bars:            parseInt(advMaxHoldBars),
  });

  const runBacktest = async () => {
    setStatus('running');
    setResult(null);
    setBaseline(null);
    setErrorMsg('');
    setLeverage(1);
    try {
      const body = {
        symbol: 'BTC',
        from_date: fromDate,
        to_date: toDate,
        initial_capital: parseFloat(capital) || 10000,
        use_chronos: useChronos,
        config: buildConfig(true),
      };
      if (compareMode && (trailingSL || partialTP)) {
        const bodyBase = { ...body, config: buildConfig(false) };
        const [r1, r2] = await Promise.all([runJob(apiBase, body), runJob(apiBase, bodyBase)]);
        setResult(r1);
        setBaseline(r2);
      } else {
        setResult(await runJob(apiBase, body));
      }
      setStatus('done');
    } catch (e: any) {
      setErrorMsg(e.message);
      setStatus('error');
    }
  };

  const advancedActive = trailingSL || partialTP;
  const drawerHasCustom = trailingSL || partialTP || lgbmExit || useChronos || advBeSL || advMaxHold
    || !advAdxEnabled || !advSweepEnabled || !advFvgEnabled || !advMtfEnabled;

  return (
    <div className="space-y-5">
      {/* ── Sub-tab navigation ───────────────────────────────────────────────── */}
      <div className="flex gap-1 bg-dark-card border border-dark-border rounded-xl p-1 w-fit">
        {(['nuovo', 'storico'] as const).map(tab => (
          <button
            key={tab}
            onClick={() => setActiveTab(tab)}
            className={`px-4 py-1.5 rounded-lg text-sm font-medium transition-colors ${
              activeTab === tab
                ? 'bg-indigo-600 text-white'
                : 'bg-white/5 text-slate-400 hover:text-white'
            }`}
          >
            {tab === 'nuovo' ? 'Nuovo' : 'Storico'}
          </button>
        ))}
      </div>

      {/* ── Storico tab ─────────────────────────────────────────────────────── */}
      {activeTab === 'storico' && <HistoryTab apiBase={apiBase} />}

      {/* ── Nuovo tab ───────────────────────────────────────────────────────── */}
      {activeTab === 'nuovo' && (
        <>
          {/* ── Config card ──────────────────────────────────────────────────── */}
          <div className="bg-dark-card rounded-xl p-5 border border-dark-border space-y-5">
            {/* Header with ⚙ button */}
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-semibold text-slate-300 flex items-center gap-2">
                <span className="text-indigo-400">◈</span> Configurazione Backtest
              </h2>
              <Tooltip text="Apre il pannello delle impostazioni avanzate: filtri segnale, strategie di uscita (Trailing SL, Partial TP, LGBM Exit, Break-even SL), e configurazione Chronos-2. Indipendente dalle impostazioni del bot live." width="wide" pos="bottom">
              <button
                onClick={() => setIsDrawerOpen(true)}
                title="Impostazioni avanzate segnale"
                className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium border transition-colors ${
                  drawerHasCustom
                    ? 'bg-indigo-600/20 border-indigo-500/40 text-indigo-300 hover:bg-indigo-600/30'
                    : 'bg-white/5 border-dark-border text-slate-400 hover:text-white hover:bg-white/10'
                }`}
              >
                <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
                  <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                </svg>
                Avanzate
                {drawerHasCustom && <span className="w-1.5 h-1.5 rounded-full bg-indigo-400" />}
              </button>
              </Tooltip>
            </div>

            {/* Base params */}
            <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
              {([
                { label: 'Da (min: 2017-01-01)', tip: 'Data di inizio del backtest. I dati storici OHLCV sono disponibili dal 2017.', type: 'date', val: fromDate, set: setFromDate, min: '2017-01-01', max: toDate },
                { label: 'A (max: oggi)', tip: 'Data di fine del backtest. Usa una data recente per testare su dati aggiornati.', type: 'date', val: toDate, set: setToDate, min: fromDate, max: today },
                { label: 'Capitale ($)', tip: 'Capitale iniziale simulato in USD. Tutti i calcoli di P&L sono basati su questo importo.', type: 'number', val: capital, set: setCapital, min: undefined, max: undefined },
                { label: 'SL mult', tip: 'Stop Loss Multiplier: distanza dello stop loss dal prezzo di entrata in multipli di ATR. Maggiore = SL più largo = meno stop colpiti ma perdite maggiori.', type: 'number', val: slMult, set: setSlMult, min: undefined, max: undefined },
                { label: 'TP mult', tip: 'Take Profit Multiplier: distanza del take profit in multipli di ATR. Combinato con SL mult determina il rapporto R:R (rischio/rendimento).', type: 'number', val: tpMult, set: setTpMult, min: undefined, max: undefined },
                { label: 'Size (%)', tip: 'Percentuale del capitale rischiata per ogni trade. Con $10.000 e Size 1.5%, ogni trade rischia $150.', type: 'number', val: posSizePct, set: setPosSizePct, min: undefined, max: undefined },
              ] as const).map(f => (
                <Tooltip key={f.label} text={f.tip} pos="bottom" width="wide">
                  <label className="flex flex-col gap-1 w-full">
                    <span className="text-xs text-slate-500">{f.label}</span>
                    <input
                      type={f.type} value={f.val}
                      min={f.min} max={f.max}
                      onChange={e => f.set(e.target.value)}
                      style={f.type === 'date' ? { colorScheme: 'dark' } : undefined}
                      className="bg-dark-bg border border-dark-border rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-indigo-500"
                    />
                  </label>
                </Tooltip>
              ))}
            </div>

            {/* Active strategy badges */}
            {drawerHasCustom && (
              <div className="flex flex-wrap gap-1.5">
                {trailingSL   && <span className="px-2 py-0.5 rounded-full text-xs bg-indigo-600/20 text-indigo-300 border border-indigo-600/30">Trailing SL</span>}
                {partialTP    && <span className="px-2 py-0.5 rounded-full text-xs bg-indigo-600/20 text-indigo-300 border border-indigo-600/30">Partial TP {partialPct}%</span>}
                {lgbmExit     && <span className="px-2 py-0.5 rounded-full text-xs bg-violet-600/20 text-violet-300 border border-violet-600/30">LGBM Exit</span>}
                {useChronos   && <span className="px-2 py-0.5 rounded-full text-xs bg-cyan-600/20 text-cyan-300 border border-cyan-600/30">Chronos-2 {Math.round(parseFloat(advChronosWeight)*100)}%</span>}
                {advBeSL      && <span className="px-2 py-0.5 rounded-full text-xs bg-amber-600/20 text-amber-300 border border-amber-600/30">BE SL</span>}
                {advMaxHold   && <span className="px-2 py-0.5 rounded-full text-xs bg-amber-600/20 text-amber-300 border border-amber-600/30">Max {advMaxHoldBars}b</span>}
                {!advAdxEnabled   && <span className="px-2 py-0.5 rounded-full text-xs bg-slate-700 text-slate-400">ADX off</span>}
                {!advSweepEnabled && <span className="px-2 py-0.5 rounded-full text-xs bg-slate-700 text-slate-400">Sweep off</span>}
                {!advFvgEnabled   && <span className="px-2 py-0.5 rounded-full text-xs bg-slate-700 text-slate-400">FVG off</span>}
                {!advMtfEnabled   && <span className="px-2 py-0.5 rounded-full text-xs bg-slate-700 text-slate-400">MTF off</span>}
              </div>
            )}

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

          {/* ── Results ────────────────────────────────────────────────────────── */}
          {result && (() => {
            const disp     = applyLeverage(result, leverage);
            const dispBase = baseline ? applyLeverage(baseline, leverage) : null;
            return (
              <>
                {/* Leverage selector */}
                <div className="bg-dark-card rounded-xl px-5 py-3 border border-dark-border">
                  <LeverageSelector value={leverage} onChange={setLeverage} worstTradePct={result.stats.worst_trade_pct} />
                </div>

                {/* Summary header */}
                <div className="bg-dark-card rounded-xl p-4 border border-dark-border flex flex-wrap gap-6 text-sm">
                  <div>
                    <span className="text-slate-500 text-xs">Periodo</span>
                    <p className="text-white font-medium">{result.from_date} → {result.to_date}</p>
                  </div>
                  <div>
                    <span className="text-slate-500 text-xs">Capitale iniziale → finale</span>
                    <p className={`font-bold ${disp.final_equity >= result.initial_capital ? 'text-emerald-400' : 'text-red-400'}`}>
                      ${result.initial_capital.toLocaleString()} → ${disp.final_equity.toLocaleString()}
                      {leverage > 1 && <span className="ml-1.5 text-xs font-normal text-indigo-400">{leverage}× sim</span>}
                    </p>
                  </div>
                  <div>
                    <span className="text-slate-500 text-xs">PnL totale</span>
                    <p className={`font-bold text-base ${disp.stats.total_pnl_usd >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                      {disp.stats.total_pnl_usd >= 0 ? '+' : ''}${disp.stats.total_pnl_usd.toFixed(2)} ({disp.stats.total_pnl_pct > 0 ? '+' : ''}{disp.stats.total_pnl_pct}%)
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
                <div className={`grid gap-4 ${dispBase ? 'grid-cols-1 lg:grid-cols-2' : 'grid-cols-1'}`}>
                  <div className="bg-dark-card rounded-xl p-4 border border-dark-border">
                    <h3 className="text-xs font-semibold text-slate-400 uppercase tracking-wide mb-2">
                      {dispBase ? '✦ Con strategie avanzate' : `Curva Equity${leverage > 1 ? ` — ${leverage}× sim` : ''}`}
                    </h3>
                    <EquityChart data={disp.equity_curve} initialCapital={result.initial_capital} color={dispBase ? '#818cf8' : undefined} />
                  </div>
                  {dispBase && (
                    <div className="bg-dark-card rounded-xl p-4 border border-dark-border">
                      <h3 className="text-xs font-semibold text-slate-400 uppercase tracking-wide mb-2">
                        ○ Baseline (solo SL/TP fisso){leverage > 1 ? ` — ${leverage}×` : ''}
                      </h3>
                      <EquityChart data={dispBase.equity_curve} initialCapital={result.initial_capital} color="#64748b" />
                    </div>
                  )}
                </div>

                {/* Stats */}
                <div className="bg-dark-card rounded-xl p-4 border border-dark-border">
                  {dispBase ? (
                    <div className="space-y-4">
                      <StatsGrid stats={disp.stats} compare={dispBase.stats} label={`✦ Con strategie avanzate${leverage > 1 ? ` (${leverage}×)` : ''} (δ = diff vs baseline)`} />
                      <div className="border-t border-dark-border pt-4">
                        <StatsGrid stats={dispBase.stats} label={`○ Baseline${leverage > 1 ? ` (${leverage}×)` : ''}`} />
                      </div>
                    </div>
                  ) : (
                    <StatsGrid
                      stats={disp.stats}
                      compare={leverage > 1 ? result.stats : undefined}
                      label={leverage > 1 ? `${leverage}× leva simulata (δ = differenza vs 1×)` : undefined}
                    />
                  )}
                </div>

                {/* Trade table */}
                {disp.trades.length > 0 && (
                  <div className="bg-dark-card rounded-xl border border-dark-border overflow-hidden">
                    <div className="px-4 py-3 border-b border-dark-border">
                      <h3 className="text-xs font-semibold text-slate-400 uppercase tracking-wide">
                        Ultimi {disp.trades.length} trade{leverage > 1 ? ` — ${leverage}× leva` : ''}
                      </h3>
                    </div>
                    <TradeTable trades={disp.trades} />
                  </div>
                )}
              </>
            );
          })()}
        </>
      )}

      {/* ── Advanced settings drawer (slide-over) ──────────────────────────────── */}
      {isDrawerOpen && (
        <>
          {/* Backdrop */}
          <div
            className="fixed inset-0 bg-black/50 z-40 backdrop-blur-sm"
            onClick={() => setIsDrawerOpen(false)}
          />
          {/* Panel */}
          <div className="fixed top-0 right-0 h-full w-full max-w-md bg-[#0a0e1a] border-l border-dark-border z-50 flex flex-col shadow-2xl overflow-hidden">
            {/* Drawer header */}
            <div className="flex items-center justify-between px-5 py-4 border-b border-dark-border flex-shrink-0">
              <div>
                <h3 className="text-sm font-semibold text-white">Impostazioni Avanzate Backtest</h3>
                <p className="text-xs text-slate-500 mt-0.5">Indipendenti dal bot live</p>
              </div>
              <button
                onClick={() => setIsDrawerOpen(false)}
                className="p-1.5 rounded-lg text-slate-500 hover:text-white hover:bg-white/10 transition-colors"
              >
                <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>

            {/* Drawer body */}
            <div className="flex-1 overflow-y-auto px-5 py-4 space-y-6">

              {/* ── Motore Decisionale ──────────────────────────────────────────── */}
              <section className="space-y-3">
                <h4 className="text-xs font-semibold text-slate-400 uppercase tracking-wide flex items-center gap-2">
                  <span className="w-1.5 h-1.5 rounded-full bg-indigo-400 inline-block" />
                  Motore Decisionale
                </h4>
                <div className="grid grid-cols-2 gap-3">
                  <Tooltip text="Probabilità minima (0–1) che il modello deve avere per aprire un trade. 0.62 = il bot è almeno 62% sicuro della direzione." pos="bottom" width="wide">
                    <NumInput label="Soglia direzionale" value={advDirThresh} onChange={setAdvDirThresh} step="0.01" min="0.50" max="0.90" />
                  </Tooltip>
                  <Tooltip text="Average Directional Index: misura la forza del trend. Sotto questo valore il mercato è considerato laterale e il bot non opera." pos="bottom" width="wide">
                    <NumInput label="ADX Gate" value={advAdxGate} onChange={setAdvAdxGate} step="1" min="10" max="40" />
                  </Tooltip>
                </div>
                <Tooltip text="Punteggio minimo del sistema Quantum Trade (0–100) come conferma aggiuntiva. Combina RSI, EMA, divergenze CVD e altri indicatori. 0 = disabilitato." pos="bottom" width="wide">
                  <NumInput label="Confluence Gate" value={advConfGate} onChange={setAdvConfGate} step="1" min="0" max="100" unit="(0 = disabilitato)" />
                </Tooltip>
              </section>

              {/* ── Filtri Segnale ──────────────────────────────────────────────── */}
              <section className="space-y-3">
                <h4 className="text-xs font-semibold text-slate-400 uppercase tracking-wide flex items-center gap-2">
                  <span className="w-1.5 h-1.5 rounded-full bg-violet-400 inline-block" />
                  Filtri Segnale
                </h4>
                <div className="space-y-3">
                  <Toggle label="ADX Gate" desc="Filtra segnali quando l'ADX è sotto la soglia: mercato senza trend direzionale, spesso laterale o in compressione." checked={advAdxEnabled} onChange={setAdvAdxEnabled} />
                  <Toggle label="Sweep Gate" desc="Liquidity Sweep: rileva quando i market maker cacciano gli stop prima di invertire. Attivo = il bot salta il segnale dopo uno sweep, evitando falsi breakout." checked={advSweepEnabled} onChange={setAdvSweepEnabled} />
                  <Toggle label="FVG Filter" desc="Fair Value Gap (SMC): zona di prezzo non coperta da volumi. Attivo = non aprire long se c'è un FVG ribassista sopra, e viceversa. Evita di comprare in zone di resistenza." checked={advFvgEnabled} onChange={setAdvFvgEnabled} />
                  <Toggle label="MTF Alignment" desc="Multi-TimeFrame Alignment: verifica che il regime daily (trend a lungo termine) sia allineato con il segnale 4h. Se allineato, abbassa la soglia di 0.02 favorendo il trade." checked={advMtfEnabled} onChange={setAdvMtfEnabled} />
                </div>
              </section>

              {/* ── Strategie di Uscita ─────────────────────────────────────────── */}
              <section className="space-y-4">
                <h4 className="text-xs font-semibold text-slate-400 uppercase tracking-wide flex items-center gap-2">
                  <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 inline-block" />
                  Strategie di Uscita
                </h4>

                {/* Trailing SL */}
                <div className="space-y-2">
                  <Toggle label="Trailing Stop Loss" desc="Segue dinamicamente il prezzo: lo SL si aggiorna ad ogni candela (high water mark − N×ATR). Cattura profitto crescente se il trend continua." checked={trailingSL} onChange={setTrailingSL} />
                  {trailingSL && (
                    <div className="pl-13">
                      <NumInput label="Attivazione dopo" value={trailAct} onChange={setTrailAct} step="0.1" min="0.5" max="3" unit="× ATR" />
                    </div>
                  )}
                </div>

                {/* Partial TP */}
                <div className="space-y-2">
                  <Toggle label="Partial Take Profit" desc="Chiudi una quota della posizione al primo target, lascia correre il resto" checked={partialTP} onChange={setPartialTP} />
                  {partialTP && (
                    <div className="pl-13 grid grid-cols-2 gap-3">
                      <NumInput label="Target" value={partialMult} onChange={setPartialMult} step="0.1" min="0.5" max="5" unit="× ATR" />
                      <NumInput label="Quota" value={partialPct} onChange={setPartialPct} step="5" min="10" max="90" unit="%" />
                    </div>
                  )}
                </div>

                {/* Break-even SL */}
                <div className="space-y-2">
                  <Toggle label="Break-even Stop Loss" desc="Sposta lo SL al prezzo di entrata UNA VOLTA SOLA quando il trade raggiunge N×ATR di profitto. Azzera il rischio senza seguire il prezzo." checked={advBeSL} onChange={setAdvBeSL} />
                  {advBeSL && (
                    <div className="pl-13">
                      <NumInput label="Attivazione BE" value={advBeSLAct} onChange={setAdvBeSLAct} step="0.1" min="0.5" max="3.0" unit="× ATR" />
                    </div>
                  )}
                </div>

                {/* Max Hold Bars */}
                <div className="space-y-2">
                  <Toggle label="Max Hold Bars" desc="Chiude forzatamente la posizione dopo N candele indipendentemente da SL/TP" checked={advMaxHold} onChange={setAdvMaxHold} />
                  {advMaxHold && (
                    <div className="pl-13">
                      <NumInput label="Numero candele max" value={advMaxHoldBars} onChange={setAdvMaxHoldBars} step="1" min="12" max="168" unit={`≈ ${Math.round(parseInt(advMaxHoldBars || '48') * 4 / 24)}d`} />
                    </div>
                  )}
                </div>

                {/* Confronto A/B */}
                {advancedActive && (
                  <div className="border-t border-dark-border pt-3">
                    <Toggle label="Confronto A/B" desc="Esegue anche il backtest senza le strategie avanzate per mostrare le differenze" checked={compareMode} onChange={setCompareMode} />
                  </div>
                )}
              </section>

              {/* ── LightGBM Mid-Trade Exit ─────────────────────────────────────── */}
              <section className="space-y-3">
                <h4 className="text-xs font-semibold text-slate-400 uppercase tracking-wide flex items-center gap-2">
                  <span className="w-1.5 h-1.5 rounded-full bg-rose-400 inline-block" />
                  LightGBM Mid-Trade Exit
                </h4>
                <Toggle
                  label="Abilita LGBM Exit"
                  desc="Ad ogni candela mentre il trade è aperto, il modello LightGBM rivaluta la probabilità direzionale. Se scende sotto la soglia per N barre consecutive, chiude anticipatamente il trade (utile per uscire da trend che si indeboliscono)."
                  checked={lgbmExit}
                  onChange={setLgbmExit}
                />
                {lgbmExit && (
                  <div className="pl-13 grid grid-cols-3 gap-3">
                    <Tooltip text="Se la probabilità LightGBM scende sotto questo valore per N barre consecutive, il trade viene chiuso anticipatamente." pos="top" width="wide">
                      <NumInput label="Soglia p <" value={lgbmThresh} onChange={setLgbmThresh} step="0.01" min="0.20" max="0.50" />
                    </Tooltip>
                    <Tooltip text="Numero minimo di barre (candele 4h) prima che l'uscita anticipata possa scattare. Evita uscite troppo precoci." pos="top" width="wide">
                      <NumInput label="Hold min (barre)" value={lgbmMinHold} onChange={setLgbmMinHold} step="1" min="1" max="48" />
                    </Tooltip>
                    <Tooltip text="Numero di barre consecutive in cui la probabilità deve essere sotto la soglia prima di uscire. Più alto = meno falsi segnali di uscita." pos="top" width="wide">
                      <NumInput label="Conferma consec." value={lgbmConfirm} onChange={setLgbmConfirm} step="1" min="1" max="6" />
                    </Tooltip>
                  </div>
                )}
              </section>

              {/* ── Chronos-2 ──────────────────────────────────────────────────── */}
              <section className="space-y-3">
                <h4 className="text-xs font-semibold text-slate-400 uppercase tracking-wide flex items-center gap-2">
                  <span className="w-1.5 h-1.5 rounded-full bg-cyan-400 inline-block" />
                  Chronos-2
                </h4>
                <Toggle
                  label="Inferenza Chronos-2 attiva"
                  desc="Abilita il modello transformer Chronos-2 (800MB) per generare previsioni probabilistiche su ogni candela del backtest. Più accurato ma molto lento (~3 secondi per candela). Disabilitato = usa un prior neutro veloce."
                  checked={useChronos}
                  onChange={setUseChronos}
                />
                {useChronos && (
                  <p className="pl-13 text-xs text-amber-400/80 font-mono">
                    ⚠ 1 mese ≈ 10 min · 1 anno ≈ 2h — usa periodi brevi
                  </p>
                )}
                <div className="pl-13">
                  <Tooltip text="Quanto peso dare a Chronos-2 nella decisione finale. Il peso rimanente va a LightGBM. Esempio: 0.4 Chronos = 60% LightGBM + 40% Chronos." pos="top" width="wide">
                    <NumInput
                      label="Peso Chronos-2 nell'ensemble"
                      value={advChronosWeight}
                      onChange={setAdvChronosWeight}
                      step="0.05" min="0.0" max="0.9"
                      unit={`LightGBM ${Math.round((1 - parseFloat(advChronosWeight || '0.4')) * 100)}%`}
                    />
                  </Tooltip>
                </div>
              </section>

            </div>

            {/* Drawer footer */}
            <div className="flex items-center gap-3 px-5 py-4 border-t border-dark-border flex-shrink-0">
              <button
                onClick={loadFromLive}
                disabled={drawerLoading}
                className="flex-1 flex items-center justify-center gap-2 px-4 py-2.5 text-xs font-medium bg-white/5 hover:bg-white/10 border border-dark-border rounded-lg text-slate-400 hover:text-white transition-colors disabled:opacity-50"
              >
                {drawerLoading ? (
                  <svg className="w-3.5 h-3.5 animate-spin" viewBox="0 0 24 24" fill="none">
                    <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" strokeDasharray="40 20" />
                  </svg>
                ) : (
                  <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" />
                  </svg>
                )}
                Carica da Live
              </button>
              <button
                onClick={saveAsDefault}
                disabled={drawerSaving}
                className="flex-1 flex items-center justify-center gap-2 px-4 py-2.5 text-xs font-semibold bg-indigo-600 hover:bg-indigo-500 disabled:bg-indigo-800 rounded-lg text-white transition-colors disabled:opacity-50"
              >
                {drawerSaving ? (
                  <svg className="w-3.5 h-3.5 animate-spin" viewBox="0 0 24 24" fill="none">
                    <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" strokeDasharray="40 20" />
                  </svg>
                ) : (
                  <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M8 7H5a2 2 0 00-2 2v9a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-3m-1 4l-3 3m0 0l-3-3m3 3V4" />
                  </svg>
                )}
                Salva come Default
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
};
