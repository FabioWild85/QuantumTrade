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
  fee_entry?: number;
  funding_paid?: number;
  reason: string;
  holding_bars: number;
  bar: number;
  _levEq?: number;
  _bankrupt?: boolean;
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
  config?: Record<string, any>;
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
  const stroke = color ?? (isProfit ? '#10b981' : '#f43f5e');
  const fill   = isProfit ? 'url(#profitGradient)' : 'url(#lossGradient)';
  const ticks  = 3;
  const yLabels = Array.from({ length: ticks + 1 }, (_, i) => minV + (range * i) / ticks);
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full" style={{ height: 140 }}>
      <defs>
        <linearGradient id="profitGradient" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#10b981" stopOpacity="0.2" />
          <stop offset="100%" stopColor="#10b981" stopOpacity="0" />
        </linearGradient>
        <linearGradient id="lossGradient" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#f43f5e" stopOpacity="0.2" />
          <stop offset="100%" stopColor="#f43f5e" stopOpacity="0" />
        </linearGradient>
      </defs>
      {yLabels.map((v, i) => {
        const y = py(v);
        return (
          <g key={i}>
            <line x1={PAD.l} y1={y} x2={W - PAD.r} y2={y} className="stroke-slate-100 dark:stroke-white/5" strokeWidth="1" />
            <text x={PAD.l - 8} y={y + 3} textAnchor="end" className="fill-slate-400 dark:fill-slate-500 font-mono" fontSize={9}>
              ${Math.round(v).toLocaleString()}
            </text>
          </g>
        );
      })}
      <line x1={PAD.l} y1={capY} x2={W - PAD.r} y2={capY} className="stroke-slate-300 dark:stroke-slate-600" strokeWidth="1" strokeDasharray="4 3" />
      <polygon points={fillPoly} fill={fill} />
      <polyline points={poly} fill="none" stroke={stroke} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
      {[0, Math.floor(data.length / 2), data.length - 1].map((idx) => (
        <text key={idx} x={px(idx)} y={H - 4} textAnchor="middle" className="fill-slate-400 dark:fill-slate-500 font-mono" fontSize={9}>
          {data[idx]?.bar ?? idx}
        </text>
      ))}
    </svg>
  );
};

// ── Stat card ──────────────────────────────────────────────────────────────────
const Stat: React.FC<{ label: string; value: string; sub?: string; color?: string; delta?: number }> = ({
  label, value, sub, color = 'text-slate-900 dark:text-white', delta,
}) => (
  <div className="bg-slate-50 dark:bg-white/5 rounded-xl p-3 flex flex-col justify-between gap-1 border border-slate-100 dark:border-white/5 w-full h-full">
    <span className="text-[10px] font-bold text-slate-400 dark:text-slate-500 uppercase tracking-widest">{label}</span>
    <div className="flex items-center justify-between">
      <span className={`text-sm font-bold font-mono ${color}`}>{value}</span>
      {delta !== undefined && delta !== 0 && (
        <span className={`text-[10px] font-bold font-mono px-1.5 py-0.5 rounded ${delta > 0 ? 'bg-emerald-50 dark:bg-emerald-500/10 text-emerald-600 dark:text-emerald-400' : 'bg-rose-50 dark:bg-rose-500/10 text-rose-600 dark:text-rose-400'}`}>
          {delta > 0 ? '+' : ''}{delta.toFixed(2)}
        </span>
      )}
    </div>
    {sub && <span className="text-[10px] text-slate-400 dark:text-slate-600 font-medium">{sub}</span>}
  </div>
);

// ── Toggle ─────────────────────────────────────────────────────────────────────
const Toggle: React.FC<{ label: string; desc: string; checked: boolean; onChange: (v: boolean) => void }> = ({
  label, desc, checked, onChange,
}) => (
  <label className="flex items-start gap-3 cursor-pointer group">
    <div className="relative mt-1">
      <input type="checkbox" className="sr-only" checked={checked} onChange={e => onChange(e.target.checked)} />
      <div className={`w-9 h-5 rounded-full transition-all duration-300 ${checked ? 'bg-indigo-600' : 'bg-slate-200 dark:bg-white/10'}`} />
      <div className={`absolute top-1 left-1 w-3 h-3 bg-white rounded-full shadow-sm transition-transform duration-300 ${checked ? 'translate-x-4' : ''}`} />
    </div>
    <div>
      <p className="text-sm font-bold text-slate-800 dark:text-slate-200 group-hover:text-indigo-600 dark:group-hover:text-indigo-400 transition-colors">{label}</p>
      <p className="text-[11px] font-medium text-slate-400 dark:text-slate-500 leading-tight">{desc}</p>
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
  const pnlColor = (v: number) => v > 0 ? 'text-emerald-600 dark:text-emerald-400' : v < 0 ? 'text-rose-600 dark:text-rose-400' : 'text-slate-400 dark:text-slate-500';
  const delta = (a: number, b?: number) => b !== undefined ? a - b : undefined;
  const tipStat = (lbl: string, node: React.ReactNode) => (
    <Tooltip key={lbl} text={STAT_TOOLTIPS[lbl] ?? lbl} pos="top" width="wide">
      {node}
    </Tooltip>
  );
  return (
    <div>
      {label && <h4 className="text-[10px] font-bold text-slate-400 dark:text-slate-500 uppercase tracking-widest mb-3 flex items-center gap-2">
        <span className="w-1 h-3 bg-indigo-500 rounded-full"></span>
        {label}
      </h4>}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
        {tipStat('Trades',        <Stat label="Trades"       value={String(s.total_trades)} delta={delta(s.total_trades, c?.total_trades)} />)}
        {tipStat('Win Rate',      <Stat label="Win Rate"     value={`${s.win_rate}%`} color={s.win_rate >= 50 ? 'text-emerald-600 dark:text-emerald-400' : 'text-rose-600 dark:text-rose-400'} delta={delta(s.win_rate, c?.win_rate)} />)}
        {tipStat('PnL %',         <Stat label="PnL %"        value={`${s.total_pnl_pct > 0 ? '+' : ''}${s.total_pnl_pct}%`} color={pnlColor(s.total_pnl_pct)} delta={delta(s.total_pnl_pct, c?.total_pnl_pct)} />)}
        {tipStat('Profit Factor', <Stat label="Profit Factor" value={(s.profit_factor ?? 0) >= 99 ? '∞' : (s.profit_factor ?? 0).toFixed(2)} color={(s.profit_factor ?? 0) >= 1.5 ? 'text-emerald-600 dark:text-emerald-400' : (s.profit_factor ?? 0) >= 1 ? 'text-amber-500' : 'text-rose-600 dark:text-rose-400'} delta={delta(s.profit_factor, c?.profit_factor)} />)}
        {tipStat('Sharpe',        <Stat label="Sharpe"       value={(s.sharpe ?? 0).toFixed(3)} color={(s.sharpe ?? 0) >= 0.7 ? 'text-emerald-600 dark:text-emerald-400' : (s.sharpe ?? 0) >= 0 ? 'text-amber-500' : 'text-rose-600 dark:text-rose-400'} delta={delta(s.sharpe, c?.sharpe)} />)}
        {tipStat('Sortino',       <Stat label="Sortino"      value={(s.sortino ?? 0).toFixed(3)} color={(s.sortino ?? 0) >= 1 ? 'text-emerald-600 dark:text-emerald-400' : (s.sortino ?? 0) >= 0 ? 'text-amber-500' : 'text-rose-600 dark:text-rose-400'} delta={delta(s.sortino, c?.sortino)} />)}
        {tipStat('Calmar',        <Stat label="Calmar"       value={(s.calmar ?? 0).toFixed(3)} color={(s.calmar ?? 0) >= 0.5 ? 'text-emerald-600 dark:text-emerald-400' : (s.calmar ?? 0) >= 0 ? 'text-amber-500' : 'text-rose-600 dark:text-rose-400'} delta={delta(s.calmar, c?.calmar)} />)}
        {tipStat('Max DD',        <Stat label="Max DD"       value={`-${s.max_drawdown_pct ?? 0}%`} color="text-rose-600 dark:text-rose-400" delta={c ? -((s.max_drawdown_pct ?? 0) - (c.max_drawdown_pct ?? 0)) : undefined} />)}
        {tipStat('Avg Win',       <Stat label="Avg Win"      value={`+${s.avg_win_pct ?? 0}%`} color="text-emerald-600 dark:text-emerald-400" delta={delta(s.avg_win_pct, c?.avg_win_pct)} />)}
        {tipStat('Avg Loss',      <Stat label="Avg Loss"     value={`${s.avg_loss_pct ?? 0}%`} color="text-rose-600 dark:text-rose-400" delta={delta(s.avg_loss_pct, c?.avg_loss_pct)} />)}
        {tipStat('Best',          <Stat label="Best"         value={`+${s.best_trade_pct ?? 0}%`} color="text-emerald-600 dark:text-emerald-400" delta={delta(s.best_trade_pct, c?.best_trade_pct)} />)}
        {tipStat('Avg Hold',       <Stat label="Avg Hold"     value={`${(s.avg_holding_h ?? 0).toFixed(1)}h`} delta={delta(s.avg_holding_h, c?.avg_holding_h)} />)}
      </div>
    </div>
  );
};

const PAGE_SIZE = 50;

const TradeTable: React.FC<{ trades: BacktestTrade[]; showLevEquity?: boolean; initialCapital?: number }> = ({ trades, showLevEquity, initialCapital }) => {
  const [page, setPage] = useState(0);

  const numColor = (v: number) => v > 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-rose-600 dark:text-rose-400';
  const eqColor  = (v: number) => {
    if (!initialCapital) return 'text-slate-600 dark:text-slate-300';
    return v >= initialCapital ? 'text-emerald-600 dark:text-emerald-400' : v <= 0 ? 'text-rose-600 dark:text-rose-400' : 'text-amber-500 dark:text-amber-400';
  };
  const reasonStyle: Record<string, string> = {
    take_profit:   'bg-emerald-50 dark:bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-100 dark:border-emerald-500/20',
    partial_tp:    'bg-teal-50 dark:bg-teal-500/10 text-teal-600 dark:text-teal-400 border-teal-100 dark:border-teal-500/20',
    stop_loss:     'bg-rose-50 dark:bg-rose-500/10 text-rose-600 dark:text-rose-400 border-rose-100 dark:border-rose-500/20',
    end_of_period: 'bg-slate-50 dark:bg-white/5 text-slate-500 dark:text-slate-400 border-slate-200 dark:border-white/10',
    lgbm_exit:     'bg-violet-50 dark:bg-violet-500/10 text-violet-600 dark:text-violet-400 border-violet-100 dark:border-violet-500/20',
    max_hold:      'bg-amber-50 dark:bg-amber-500/10 text-amber-600 dark:text-amber-400 border-amber-100 dark:border-amber-500/20',
  };

  // Newest-first
  const reversed = [...trades].reverse();
  const totalPages = Math.ceil(reversed.length / PAGE_SIZE);
  const pageSlice  = reversed.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
  const colSpan    = showLevEquity ? 11 : 10;

  // Reset to page 0 when trades list changes (new backtest result)
  React.useEffect(() => { setPage(0); }, [trades.length]);

  const rows: React.ReactNode[] = [];
  pageSlice.forEach((t, i) => {
    const globalIdx = page * PAGE_SIZE + i;
    rows.push(
      <tr key={`t-${globalIdx}`} className={`hover:bg-slate-50/50 dark:hover:bg-white/[0.02] transition-colors group ${t._bankrupt ? 'bg-rose-50/30 dark:bg-rose-500/5' : ''}`}>
        <td className="px-4 py-2 text-slate-400 font-mono">{t.bar}</td>
        <td className="px-4 py-2">
          <span className={`px-2 py-0.5 rounded text-[10px] font-bold tracking-wider ${t.side === 'long' ? 'bg-emerald-50 dark:bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border border-emerald-100 dark:border-emerald-500/20' : 'bg-rose-50 dark:bg-rose-500/10 text-rose-600 dark:text-rose-400 border border-rose-100 dark:border-rose-500/20'}`}>
            {t.side.toUpperCase()}
          </span>
        </td>
        <td className="px-4 py-2 text-right font-mono text-slate-600 dark:text-slate-300 font-bold">${t.entry.toLocaleString(undefined, { maximumFractionDigits: 0 })}</td>
        <td className="px-4 py-2 text-right font-mono text-slate-600 dark:text-slate-300 font-bold">${t.exit.toLocaleString(undefined, { maximumFractionDigits: 0 })}</td>
        <td className={`px-4 py-2 text-right font-mono font-bold ${numColor(t.pnl_pct)}`}>
          {t.pnl_pct > 0 ? '+' : ''}{t.pnl_pct}%
        </td>
        <td className={`px-4 py-2 text-right font-mono font-medium ${numColor(t.pnl_usd)}`}>
          {t.pnl_usd > 0 ? '+' : ''}${t.pnl_usd.toFixed(0)}
        </td>
        {showLevEquity && (
          <td className={`px-4 py-2 text-right font-mono font-bold ${eqColor(t._levEq ?? 0)}`}>
            {t._levEq !== undefined ? `$${t._levEq.toLocaleString(undefined, { maximumFractionDigits: 0 })}` : '—'}
          </td>
        )}
        <td className="px-4 py-2 text-right font-mono text-slate-400 dark:text-slate-500">
          {t.fee_entry !== undefined ? `$${t.fee_entry.toFixed(1)}` : '—'}
        </td>
        <td className={`px-4 py-2 text-right font-mono ${t.funding_paid !== undefined && t.funding_paid < 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-slate-400 dark:text-slate-500'}`}>
          {t.funding_paid !== undefined ? (t.funding_paid < 0 ? `+$${Math.abs(t.funding_paid).toFixed(1)}` : `$${t.funding_paid.toFixed(1)}`) : '—'}
        </td>
        <td className="px-4 py-2">
          <span className={`px-2 py-0.5 rounded-lg text-[9px] font-bold uppercase tracking-wider border ${reasonStyle[t.reason] ?? 'bg-slate-50 dark:bg-white/5 text-slate-500 border-slate-200 dark:border-white/10'}`}>
            {t.reason.replace(/_/g, ' ')}
          </span>
        </td>
        <td className="px-4 py-2 text-right text-slate-400 dark:text-slate-500 font-mono">{t.holding_bars * 4}h</td>
      </tr>
    );
    if (t._bankrupt) {
      rows.push(
        <tr key={`liq-${globalIdx}`} className="bg-rose-50 dark:bg-rose-500/10">
          <td colSpan={colSpan} className="px-4 py-2.5 text-center">
            <span className="inline-flex items-center gap-2 text-[10px] font-bold text-rose-600 dark:text-rose-400 uppercase tracking-widest">
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M12 9v2m0 4h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" />
              </svg>
              Liquidazione — il capitale ha raggiunto $0 dopo questo trade. I trade successivi non vengono eseguiti.
            </span>
          </td>
        </tr>
      );
    }
  });

  return (
    <div>
      <div className="overflow-x-auto">
        <table className="w-full text-[11px]">
          <thead>
            <tr className="border-b border-slate-100 dark:border-white/5 text-[10px] text-slate-400 dark:text-slate-500 font-bold uppercase tracking-widest bg-slate-50/50 dark:bg-white/[0.02]">
              <th className="px-4 py-3 text-left">Bar</th>
              <th className="px-4 py-3 text-left">Side</th>
              <th className="px-4 py-3 text-right">Entry</th>
              <th className="px-4 py-3 text-right">Exit</th>
              <th className="px-4 py-3 text-right">PnL %</th>
              <th className="px-4 py-3 text-right">PnL $</th>
              {showLevEquity && <th className="px-4 py-3 text-right">Equity</th>}
              <th className="px-4 py-3 text-right">Fee Ent.</th>
              <th className="px-4 py-3 text-right">Funding</th>
              <th className="px-4 py-3 text-left">Reason</th>
              <th className="px-4 py-3 text-right">Hold</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-50 dark:divide-white/5">
            {rows}
          </tbody>
        </table>
      </div>
      {/* Pagination */}
      {totalPages > 1 && (
        <div className="flex items-center justify-between px-4 py-3 border-t border-slate-100 dark:border-white/5">
          <span className="text-[10px] text-slate-400 dark:text-slate-500">
            Pagina {page + 1} di {totalPages} &nbsp;·&nbsp; {reversed.length} trade totali
          </span>
          <div className="flex items-center gap-1">
            <button
              onClick={() => setPage(0)}
              disabled={page === 0}
              className="px-2 py-1 text-[10px] rounded border border-slate-200 dark:border-white/10 text-slate-500 dark:text-slate-400 disabled:opacity-30 hover:bg-slate-50 dark:hover:bg-white/5 transition-colors"
            >«</button>
            <button
              onClick={() => setPage(p => Math.max(0, p - 1))}
              disabled={page === 0}
              className="px-2 py-1 text-[10px] rounded border border-slate-200 dark:border-white/10 text-slate-500 dark:text-slate-400 disabled:opacity-30 hover:bg-slate-50 dark:hover:bg-white/5 transition-colors"
            >‹ Prec</button>
            {/* Page number pills — show up to 5 around current */}
            {Array.from({ length: totalPages }, (_, idx) => idx)
              .filter(idx => idx === 0 || idx === totalPages - 1 || Math.abs(idx - page) <= 2)
              .reduce<(number | 'gap')[]>((acc, idx, i, arr) => {
                if (i > 0 && idx - (arr[i - 1] as number) > 1) acc.push('gap');
                acc.push(idx);
                return acc;
              }, [])
              .map((item, i) =>
                item === 'gap'
                  ? <span key={`gap-${i}`} className="px-1 text-[10px] text-slate-400">…</span>
                  : <button
                      key={item}
                      onClick={() => setPage(item as number)}
                      className={`px-2.5 py-1 text-[10px] rounded border transition-colors ${
                        item === page
                          ? 'border-violet-500 bg-violet-50 dark:bg-violet-500/10 text-violet-600 dark:text-violet-400 font-bold'
                          : 'border-slate-200 dark:border-white/10 text-slate-500 dark:text-slate-400 hover:bg-slate-50 dark:hover:bg-white/5'
                      }`}
                    >{(item as number) + 1}</button>
              )
            }
            <button
              onClick={() => setPage(p => Math.min(totalPages - 1, p + 1))}
              disabled={page === totalPages - 1}
              className="px-2 py-1 text-[10px] rounded border border-slate-200 dark:border-white/10 text-slate-500 dark:text-slate-400 disabled:opacity-30 hover:bg-slate-50 dark:hover:bg-white/5 transition-colors"
            >Succ ›</button>
            <button
              onClick={() => setPage(totalPages - 1)}
              disabled={page === totalPages - 1}
              className="px-2 py-1 text-[10px] rounded border border-slate-200 dark:border-white/10 text-slate-500 dark:text-slate-400 disabled:opacity-30 hover:bg-slate-50 dark:hover:bg-white/5 transition-colors"
            >»</button>
          </div>
        </div>
      )}
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

  // Annotate each trade with its post-close levered equity using direct index lookup.
  // trades[k] corresponds 1:1 to equity_curve[k+1] (both appended together on every close).
  // A bar-keyed Map would collapse two trades closing at the same bar (e.g. partial TP + final
  // close), giving both rows the same (last) equity. Index-based lookup avoids that.
  let bankruptFound = false;
  const levTrades = result.trades.map((t, k) => {
    const levEq   = k + 1 < levCurve.length
      ? levCurve[k + 1].equity
      : levCurve[levCurve.length - 1].equity;
    const bankrupt = !bankruptFound && levEq <= 0;
    if (bankrupt) bankruptFound = true;
    return {
      ...t,
      pnl_pct:    Math.round(t.pnl_pct * lev * 10000) / 10000,
      pnl_usd:    Math.round(t.pnl_usd * lev * 100) / 100,
      _levEq:     Math.round(levEq * 100) / 100,
      _bankrupt:  bankrupt,
    };
  });

  // Recalculate stats from levered data.
  // totalPnlUsd/Pct MUST be derived from finalEquity (compounded curve), NOT from the sum
  // of individual scaled trade USD amounts. If equity hits 0 (bankruptcy) mid-run, subsequent
  // winning trades would still add to the sum, producing a falsely positive PnL.
  const pnlsPct     = levTrades.map(t => t.pnl_pct);
  const wins        = pnlsPct.filter(p => p > 0);
  const losses      = pnlsPct.filter(p => p <= 0);
  const totalPnlUsd = finalEquity - init;
  const totalPnlPct = ((finalEquity - init) / init) * 100;
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
    <div className="flex flex-wrap items-center gap-4">
      <Tooltip text="Simulatore di leva: ricalcola i risultati come se avessi tradato con leva finanziaria. 1× = senza leva (risultato reale). Attenzione: la leva amplifica sia i guadagni che le perdite, e può portare alla liquidazione." width="wide" pos="top">
        <span className="text-[10px] font-bold text-slate-400 dark:text-slate-500 uppercase tracking-widest whitespace-nowrap cursor-help">Simulazione Leva</span>
      </Tooltip>
      <div className="flex gap-1.5 flex-wrap">
        {LEVERAGE_OPTIONS.map(opt => (
          <button
            key={opt}
            onClick={() => onChange(opt)}
            className={`px-3 py-1.5 rounded-lg text-xs font-bold font-mono transition-all ${
              value === opt
                ? 'bg-indigo-600 text-white shadow-lg shadow-indigo-500/20 scale-[1.05]'
                : 'bg-slate-50 dark:bg-white/5 border border-slate-100 dark:border-white/10 text-slate-400 dark:text-slate-500 hover:text-slate-900 dark:hover:text-white'
            }`}
          >
            {opt === 1 ? '1×' : `${opt}×`}
          </button>
        ))}
      </div>
      {liqThreshold !== null && (
        <span className={`text-[10px] px-3 py-1.5 rounded-xl border font-bold tracking-tight ${
          liqRisk
            ? 'bg-rose-50 dark:bg-rose-500/10 border-rose-200 dark:border-rose-500/30 text-rose-600 dark:text-rose-400'
            : 'bg-amber-50 dark:bg-amber-500/10 border-amber-200 dark:border-amber-500/30 text-amber-600 dark:text-amber-400'
        }`}>
          {liqRisk ? 'RISCHIO LIQUIDAZIONE ELEVATO' : `Liquidazione se trade > ${Math.abs(liqThreshold).toFixed(1)}% loss`}
        </span>
      )}
    </div>
  );
};

// ── Leverage compounding explanation banner ────────────────────────────────────
const LeverageWarning: React.FC<{ lev: number; levPnlPct: number; basePnlPct: number; bankrupt: boolean }> = ({ lev, levPnlPct, basePnlPct, bankrupt }) => {
  const worse = levPnlPct < basePnlPct;
  if (!worse && !bankrupt) return null;
  return (
    <div className={`flex items-start gap-3 rounded-2xl px-5 py-4 border animate-in fade-in ${
      bankrupt
        ? 'bg-rose-50 dark:bg-rose-500/10 border-rose-200 dark:border-rose-500/25'
        : 'bg-amber-50 dark:bg-amber-500/10 border-amber-200 dark:border-amber-500/25'
    }`}>
      <svg className={`w-4 h-4 flex-shrink-0 mt-0.5 ${bankrupt ? 'text-rose-500' : 'text-amber-500'}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M12 9v2m0 4h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" />
      </svg>
      <div className="space-y-1">
        <p className={`text-[11px] font-bold uppercase tracking-wide ${bankrupt ? 'text-rose-700 dark:text-rose-400' : 'text-amber-700 dark:text-amber-400'}`}>
          {bankrupt ? `Liquidazione a ${lev}× — capitale azzerato` : `La leva ${lev}× peggiora il risultato rispetto a 1×`}
        </p>
        <p className={`text-[11px] leading-snug ${bankrupt ? 'text-rose-600 dark:text-rose-500' : 'text-amber-600 dark:text-amber-500'}`}>
          {bankrupt
            ? `Con leva ${lev}×, ogni trade perde ${lev} volte di più. Una sequenza di perdite consecutive ha azzerato il capitale prima che i trade vincenti potessero recuperare. Gli stop loss sono attivi, ma a ${lev}× un SL del 2% consuma il ${lev * 2}% del conto.`
            : `La leva amplifica ogni trade del ${lev}×, sia guadagni che perdite. Se le perdite si concentrano all'inizio del periodo, erodono la base di capitale prima che i vincitori possano compensare — anche se il risultato a 1× è positivo.`
          }
        </p>
      </div>
    </div>
  );
};

// ── Job runner helper ──────────────────────────────────────────────────────────
async function runJob(
  apiBase: string,
  body: object,
  signal?: AbortSignal,
): Promise<BacktestResult> {
  const startRes = await fetch(`${apiBase}/backtest`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  });
  const { job_id } = await startRes.json();
  sessionStorage.setItem('bt_active_job', job_id);

  return new Promise((resolve, reject) => {
    let t: ReturnType<typeof setInterval>;

    const cleanup = () => {
      clearInterval(t);
      sessionStorage.removeItem('bt_active_job');
    };

    const onAbort = () => {
      cleanup();
      reject(new DOMException('Backtest annullato', 'AbortError'));
    };
    signal?.addEventListener('abort', onAbort);

    t = setInterval(async () => {
      if (signal?.aborted) { cleanup(); return; }
      try {
        const r = await fetch(`${apiBase}/backtest/${job_id}`, { signal });
        const job = await r.json();
        if (job.status === 'done') {
          signal?.removeEventListener('abort', onAbort);
          cleanup();
          job.result?.error ? reject(new Error(job.result.error)) : resolve(job.result);
        } else if (job.status === 'cancelled' || job.status === 'error') {
          signal?.removeEventListener('abort', onAbort);
          cleanup();
          reject(new Error(job.result?.error ?? job.status));
        }
      } catch (err: any) {
        if (err.name === 'AbortError') { cleanup(); }
      }
    }, 2000);
  });
}

// ── Reconnect to an already-running job (e.g. after page refresh) ─────────────
async function reconnectJob(apiBase: string, job_id: string, signal?: AbortSignal): Promise<BacktestResult> {
  sessionStorage.setItem('bt_active_job', job_id);
  return new Promise((resolve, reject) => {
    let t: ReturnType<typeof setInterval>;

    const cleanup = () => {
      clearInterval(t);
      sessionStorage.removeItem('bt_active_job');
    };

    const onAbort = () => { cleanup(); reject(new DOMException('Backtest annullato', 'AbortError')); };
    signal?.addEventListener('abort', onAbort);

    t = setInterval(async () => {
      if (signal?.aborted) { cleanup(); return; }
      try {
        const r = await fetch(`${apiBase}/backtest/${job_id}`, { signal });
        const job = await r.json();
        if (job.status === 'done') {
          signal?.removeEventListener('abort', onAbort);
          cleanup();
          job.result?.error ? reject(new Error(job.result.error)) : resolve(job.result);
        } else if (job.status === 'cancelled' || job.status === 'error') {
          signal?.removeEventListener('abort', onAbort);
          cleanup();
          reject(new Error(job.result?.error ?? job.status));
        }
      } catch (err: any) {
        if (err.name === 'AbortError') { cleanup(); }
      }
    }, 2000);
  });
}

// ── Config summary ────────────────────────────────────────────────────────────
const ConfigSummary: React.FC<{ config: Record<string, any> }> = ({ config: c }) => {
  const param = (label: string, value: any, unit = '') => (
    <div key={label} className="flex flex-col gap-0.5">
      <span className="text-[9px] font-bold text-slate-400 dark:text-slate-500 uppercase tracking-widest">{label}</span>
      <span className="text-xs font-bold font-mono text-slate-800 dark:text-slate-200">{value}{unit && <span className="text-[9px] text-slate-400 dark:text-slate-500 ml-0.5">{unit}</span>}</span>
    </div>
  );

  const badge = (label: string, color: string) => (
    <span key={label} className={`px-2.5 py-1 rounded-lg text-[9px] font-bold uppercase tracking-wider border ${color}`}>{label}</span>
  );

  const activeBadges: React.ReactNode[] = [];
  if (c.trailing_sl_enabled)  activeBadges.push(badge(`Trailing SL ×${c.trailing_sl_activation}`, 'bg-indigo-50 dark:bg-indigo-500/10 text-indigo-600 dark:text-indigo-400 border-indigo-100 dark:border-indigo-500/20'));
  if (c.partial_tp_enabled)   activeBadges.push(badge(`Partial TP ${c.partial_tp_pct}% @${c.partial_tp_atr_mult}ATR`, 'bg-indigo-50 dark:bg-indigo-500/10 text-indigo-600 dark:text-indigo-400 border-indigo-100 dark:border-indigo-500/20'));
  if (c.lgbm_exit_enabled)    activeBadges.push(badge(`LGBM Exit p<${c.lgbm_exit_threshold}`, 'bg-purple-50 dark:bg-purple-500/10 text-purple-600 dark:text-purple-400 border-purple-100 dark:border-purple-500/20'));
  if (c.be_sl_enabled)        activeBadges.push(badge(`BE SL @${c.be_sl_activation}ATR`, 'bg-amber-50 dark:bg-amber-500/10 text-amber-600 dark:text-amber-400 border-amber-100 dark:border-amber-500/20'));
  if (c.max_hold_bars_enabled) activeBadges.push(badge(`Max ${c.max_hold_bars} barre`, 'bg-slate-50 dark:bg-white/10 text-slate-600 dark:text-slate-400 border-slate-200 dark:border-white/20'));
  if (c.chronos_enabled)               activeBadges.push(badge(`Chronos ${Math.round((c.chronos_weight ?? 0.4) * 100)}%`, 'bg-cyan-50 dark:bg-cyan-500/10 text-cyan-600 dark:text-cyan-400 border-cyan-100 dark:border-cyan-500/20'));
  if (c.c2_uncertainty_gate_enabled)   activeBadges.push(badge(`C2 Gate <${c.c2_uncertainty_threshold ?? 0.05}`, 'bg-cyan-50 dark:bg-cyan-500/10 text-cyan-600 dark:text-cyan-400 border-cyan-100 dark:border-cyan-500/20'));
  if (c.dynamic_sl_tp_enabled)         activeBadges.push(badge(`Adaptive SL/TP ${Math.round((c.dynamic_sl_tp_blend ?? 0.5) * 100)}% C2`, 'bg-violet-50 dark:bg-violet-500/10 text-violet-600 dark:text-violet-400 border-violet-100 dark:border-violet-500/20'));
  if (c.p10_sl_floor_enabled)          activeBadges.push(badge('P10 SL Floor', 'bg-violet-50 dark:bg-violet-500/10 text-violet-600 dark:text-violet-400 border-violet-100 dark:border-violet-500/20'));
  if (c.ob_tp_enabled)                 activeBadges.push(badge(`OB TP ${Math.round((c.ob_tp_blend ?? 1) * 100)}% OB`, 'bg-emerald-50 dark:bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-100 dark:border-emerald-500/20'));
  if (c.fvg_sl_enabled)                activeBadges.push(badge('FVG SL', 'bg-violet-50 dark:bg-violet-500/10 text-violet-600 dark:text-violet-400 border-violet-100 dark:border-violet-500/20'));
  if (c.fvg_tp_enabled) activeBadges.push(badge(`FVG TP ${Math.round((c.fvg_tp_blend ?? 1) * 100)}% FVG`, 'bg-emerald-50 dark:bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-100 dark:border-emerald-500/20'));
  if (c.swing_sl_enabled)              activeBadges.push(badge('Swing SL', 'bg-violet-50 dark:bg-violet-500/10 text-violet-600 dark:text-violet-400 border-violet-100 dark:border-violet-500/20'));
  if (c.swing_tp_enabled)              activeBadges.push(badge(`Swing TP ${Math.round((c.swing_tp_blend ?? 1) * 100)}% Sw`, 'bg-emerald-50 dark:bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-100 dark:border-emerald-500/20'));
  if (c.regime_bias_enabled) {
    const rLabel = c.forced_regime && c.forced_regime !== 'auto' ? ` [${c.forced_regime.toUpperCase()}]` : '';
    activeBadges.push(badge(`Regime Bias +${c.regime_bias_delta ?? 0.08}${rLabel}`, 'bg-orange-50 dark:bg-orange-500/10 text-orange-600 dark:text-orange-400 border-orange-100 dark:border-orange-500/20'));
  }
  if (c.enhanced_exit_enabled)         activeBadges.push(badge('Enhanced Exit', 'bg-purple-50 dark:bg-purple-500/10 text-purple-600 dark:text-purple-400 border-purple-100 dark:border-purple-500/20'));

  const disabledFilters: string[] = [];
  if (c.adx_gate_enabled      === false) disabledFilters.push('ADX OFF');
  if (c.sweep_gate_enabled    === false) disabledFilters.push('Sweep OFF');
  if (c.fvg_filter_enabled    === false) disabledFilters.push('FVG OFF');
  if (c.mtf_alignment_enabled === false) disabledFilters.push('MTF OFF');

  return (
    <div className="bg-slate-50/50 dark:bg-white/[0.02] rounded-2xl p-5 border border-slate-100 dark:border-white/5 space-y-4">
      <h4 className="text-[9px] font-bold text-slate-400 dark:text-slate-500 uppercase tracking-widest flex items-center gap-2">
        <span className="w-1 h-3 bg-indigo-500 rounded-full" />
        Parametri Utilizzati in questo Backtest
      </h4>
      <div className="grid grid-cols-3 sm:grid-cols-6 gap-x-6 gap-y-3">
        {param('SL Mult', c.sl_atr_mult, '× ATR')}
        {param('TP Mult', c.tp_atr_mult, '× ATR')}
        {param('Size', c.position_size_pct, '%')}
        {param('Dir. Thresh', c.directional_threshold)}
        {param('ADX Gate', c.adx_gate)}
        {param('Confluence', c.confluence_gate)}
      </div>
      {(activeBadges.length > 0 || disabledFilters.length > 0) && (
        <div className="flex flex-wrap gap-2 pt-1">
          {activeBadges}
          {disabledFilters.map(f => badge(f, 'bg-rose-50 dark:bg-rose-500/10 text-rose-500 dark:text-rose-400 border-rose-100 dark:border-rose-500/20'))}
        </div>
      )}
    </div>
  );
};

// ── History result card ────────────────────────────────────────────────────────
const HistoryResultCard: React.FC<{ result: BacktestResult; config?: Record<string, any> }> = ({ result, config }) => {
  const [lev, setLev] = useState<LeverageOption>(1);
  const disp = applyLeverage(result, lev);

  return (
    <div className="mt-6 space-y-6">
      {/* Config summary */}
      {config && <ConfigSummary config={config} />}
      {/* Leverage selector */}
      <div className="bg-slate-50/50 dark:bg-white/[0.02] rounded-2xl px-6 py-4 border border-slate-100 dark:border-white/5">
        <LeverageSelector value={lev} onChange={setLev} worstTradePct={result.stats.worst_trade_pct} />
      </div>
      {/* Leverage compounding warning */}
      {lev > 1 && (
        <LeverageWarning
          lev={lev}
          levPnlPct={disp.stats.total_pnl_pct}
          basePnlPct={result.stats.total_pnl_pct}
          bankrupt={disp.trades.some(t => t._bankrupt)}
        />
      )}
      {/* Header summary */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <div className="bg-white dark:bg-[#151E32] rounded-2xl p-5 border border-slate-100 dark:border-white/5 shadow-sm">
          <span className="text-[10px] font-bold text-slate-400 dark:text-slate-500 uppercase tracking-widest block mb-2">Periodo Analizzato</span>
          <p className="text-slate-900 dark:text-white font-bold text-sm tracking-tight">{result.from_date} <span className="text-slate-300 dark:text-slate-600 px-1">→</span> {result.to_date}</p>
        </div>
        <div className="bg-white dark:bg-[#151E32] rounded-2xl p-5 border border-slate-100 dark:border-white/5 shadow-sm">
          <span className="text-[10px] font-bold text-slate-400 dark:text-slate-500 uppercase tracking-widest block mb-2">Equity Dynamics</span>
          <p className={`font-bold text-sm tracking-tight ${disp.final_equity >= result.initial_capital ? 'text-emerald-600 dark:text-emerald-400' : 'text-rose-600 dark:text-rose-400'}`}>
            ${result.initial_capital.toLocaleString()} <span className="text-slate-300 dark:text-slate-600 px-1">→</span> ${disp.final_equity.toLocaleString()}
            {lev > 1 && <span className="ml-2 text-[10px] font-bold text-indigo-500 uppercase">{lev}× sim</span>}
          </p>
        </div>
        <div className="bg-white dark:bg-[#151E32] rounded-2xl p-5 border border-slate-100 dark:border-white/5 shadow-sm">
          <span className="text-[10px] font-bold text-slate-400 dark:text-slate-500 uppercase tracking-widest block mb-2">PnL Netto</span>
          <p className={`font-bold text-lg tracking-tighter ${disp.stats.total_pnl_usd >= 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-rose-600 dark:text-rose-400'}`}>
            {(disp.stats.total_pnl_usd ?? 0) >= 0 ? '+' : ''}${(disp.stats.total_pnl_usd ?? 0).toFixed(2)} <span className="text-[10px] font-bold ml-1">({disp.stats.total_pnl_pct > 0 ? '+' : ''}{disp.stats.total_pnl_pct}%)</span>
          </p>
        </div>
      </div>
      {/* Equity curve */}
      <div className="elegant-card p-6 bg-white dark:bg-[#151E32]">
        <h3 className="text-[10px] font-bold text-slate-400 dark:text-slate-500 uppercase tracking-widest mb-6 flex items-center gap-2">
           <span className="w-1 h-3 bg-indigo-500 rounded-full"></span>
           Andamento Portafoglio {lev > 1 ? ` — Simulazione ${lev}×` : ''}
        </h3>
        <EquityChart data={disp.equity_curve} initialCapital={result.initial_capital} />
      </div>
      {/* Stats grid */}
      <div className="elegant-card p-6 bg-white dark:bg-[#151E32]">
        <StatsGrid stats={disp.stats} compare={lev > 1 ? result.stats : undefined} label={lev > 1 ? `Performance ${lev}× (Variazione vs 1×)` : 'Metriche di Performance'} />
      </div>
      {/* Trade table */}
      {disp.trades.length > 0 && (
        <div className="elegant-card bg-white dark:bg-[#151E32] overflow-hidden">
          <div className="px-6 py-4 border-b border-slate-100 dark:border-white/5 bg-slate-50/50 dark:bg-white/[0.02]">
            <h3 className="text-[10px] font-bold text-slate-400 dark:text-slate-500 uppercase tracking-widest">
              Dettaglio Operazioni ({disp.trades.length}){lev > 1 ? ` — Leva ${lev}×` : ''}
            </h3>
          </div>
          <TradeTable trades={disp.trades} showLevEquity={lev > 1} initialCapital={result.initial_capital} />
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
        // API returns { ..., results: BacktestResult, config: Record<string,any> }
        const fullResult: BacktestResult | undefined = data.results ?? data.result;
        const cfg: Record<string, any> | undefined = data.config ?? undefined;
        if (fullResult) {
          setItems(prev => prev.map(i => i.id === itemId ? { ...i, result: fullResult, config: cfg } : i));
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
      <div className="flex flex-col items-center justify-center py-24 text-slate-400 gap-4">
        <div className="w-10 h-10 border-4 border-slate-100 dark:border-white/5 border-t-indigo-500 rounded-full animate-spin"></div>
        <span className="text-xs font-bold uppercase tracking-widest animate-pulse">Caricamento Storico Analisi…</span>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {/* Toolbar */}
      <div className="flex items-center justify-between mb-4">
        <span className="text-[10px] font-bold text-slate-400 dark:text-slate-500 uppercase tracking-widest">{items.length} Report Disponibili</span>
        <button
          onClick={fetchHistory}
          className="flex items-center gap-2 px-4 py-2 text-[10px] font-bold uppercase tracking-widest bg-white dark:bg-white/5 hover:bg-slate-50 dark:hover:bg-white/10 border border-slate-100 dark:border-white/10 rounded-xl text-slate-500 dark:text-slate-400 transition-all shadow-sm active:scale-95"
        >
          <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
            <path strokeLinecap="round" strokeLinejoin="round" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
          </svg>
          Sincronizza
        </button>
      </div>

      {items.length === 0 ? (
        <div className="elegant-card p-12 bg-white dark:bg-[#151E32] text-center">
          <p className="text-sm font-medium text-slate-400 dark:text-slate-500 italic">Nessun report di analisi presente in archivio.</p>
        </div>
      ) : (
        <div className="space-y-3">
          {items.map(item => {
            const pnlPositive    = item.summary.total_pnl_pct > 0;
            const pnlNeutral     = item.summary.total_pnl_pct === 0;
            const isExpanded     = expandedId === item.id;
            const isDeleting     = deletingId === item.id;
            const isLoadingDetail = loadingDetailId === item.id;

            return (
              <div
                key={item.id}
                className="elegant-card bg-white dark:bg-[#151E32] overflow-hidden"
              >
                {/* Card header row */}
                <div
                  className="px-6 py-4 flex items-center gap-4 cursor-pointer hover:bg-slate-50 dark:hover:bg-white/[0.02] transition-all select-none group"
                  onClick={() => handleExpand(item.id)}
                >
                  {/* Expand chevron */}
                  <svg
                    className={`w-4 h-4 text-slate-300 group-hover:text-indigo-500 transition-all duration-300 ${isExpanded ? 'rotate-90 text-indigo-500' : ''}`}
                    viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3"
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
                        className="bg-slate-50 dark:bg-white/5 border border-indigo-500 rounded-xl px-3 py-1.5 text-sm text-slate-900 dark:text-white focus:outline-none w-full max-w-xs shadow-inner"
                      />
                    ) : (
                      <span
                        className="text-sm font-bold text-slate-800 dark:text-slate-200 truncate cursor-text hover:text-indigo-600 dark:hover:text-indigo-400 transition-colors"
                        title="Clicca per rinominare"
                        onClick={() => handleRenameStart(item)}
                      >
                        {item.name || `${item.symbol} · ${item.from_date} → ${item.to_date}`}
                      </span>
                    )}
                    <p className="text-[10px] font-bold text-slate-400 dark:text-slate-500 mt-1 uppercase tracking-widest">{formatDate(item.created_at)}</p>
                  </div>

                  {/* Quick stats */}
                  <div className="hidden md:flex items-center gap-6 text-[10px] font-bold uppercase tracking-widest flex-shrink-0">
                    <div className="flex flex-col items-end">
                      <span className="text-slate-300 dark:text-slate-600">Trades</span>
                      <span className="text-slate-600 dark:text-slate-400 font-mono">{item.summary.total_trades}</span>
                    </div>
                    <div className="flex flex-col items-end">
                      <span className="text-slate-300 dark:text-slate-600">WR</span>
                      <span className="text-slate-600 dark:text-slate-400 font-mono">{item.summary.win_rate}%</span>
                    </div>
                  </div>

                  {/* PnL badge */}
                  <span className={`flex-shrink-0 px-3 py-1.5 rounded-xl text-[10px] font-bold font-mono border tracking-tight ${
                    pnlNeutral  ? 'bg-slate-50 dark:bg-white/5 text-slate-500 border-slate-200 dark:border-white/10' :
                    pnlPositive ? 'bg-emerald-50 dark:bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-100 dark:border-emerald-500/20' :
                                  'bg-rose-50 dark:bg-rose-500/10 text-rose-600 dark:text-rose-400 border-rose-100 dark:border-rose-500/20'
                  }`}>
                    {item.summary.total_pnl_pct > 0 ? '+' : ''}{item.summary.total_pnl_pct}%
                  </span>

                  {/* Delete button */}
                  <button
                    onClick={e => { e.stopPropagation(); handleDelete(item.id); }}
                    disabled={isDeleting}
                    className="flex-shrink-0 p-2 rounded-xl text-slate-300 dark:text-slate-600 hover:text-rose-600 dark:hover:text-rose-400 hover:bg-rose-50 dark:hover:bg-rose-500/10 transition-all active:scale-90 disabled:opacity-40"
                    title="Elimina"
                  >
                    {isDeleting ? (
                      <div className="w-4 h-4 border-2 border-slate-300 dark:border-slate-600 border-t-rose-500 rounded-full animate-spin"></div>
                    ) : (
                      <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" /></svg>
                    )}
                  </button>
                </div>

                {/* Expanded results */}
                {isExpanded && (
                  <div className="px-6 pb-6 border-t border-slate-50 dark:border-white/5 bg-slate-50/20 dark:bg-black/[0.02]">
                    {isLoadingDetail ? (
                      <div className="flex flex-col items-center justify-center py-12 text-slate-400 gap-3">
                        <div className="w-6 h-6 border-2 border-slate-100 dark:border-white/5 border-t-indigo-500 rounded-full animate-spin"></div>
                        <span className="text-[10px] font-bold uppercase tracking-widest animate-pulse">Generazione Report Analitico…</span>
                      </div>
                    ) : item.result ? (
                      <HistoryResultCard result={item.result} config={item.config} />
                    ) : (
                      <div className="py-8 text-center">
                        <p className="text-xs font-medium text-slate-400 dark:text-slate-500 italic">Report di dettaglio non disponibile per questo snapshot.</p>
                      </div>
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
  <label className="flex flex-col gap-1.5">
    <span className="text-[10px] font-bold text-slate-400 dark:text-slate-500 uppercase tracking-widest ml-1">{label}</span>
    <div className="flex items-center gap-2">
      <input
        type="number" value={value} onChange={e => onChange(e.target.value)}
        step={step} min={min} max={max}
        className="w-full bg-slate-50 dark:bg-white/5 border border-slate-200 dark:border-white/10 rounded-xl px-4 py-2.5 text-sm font-bold font-mono text-slate-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500 transition-all outline-none shadow-sm"
      />
      {unit && <span className="text-[10px] font-bold text-slate-400 dark:text-slate-600 whitespace-nowrap">{unit}</span>}
    </div>
  </label>
);

// ── Regime period data ────────────────────────────────────────────────────────
type RegimeKey = 'uptrend' | 'downtrend' | 'sideways' | 'flat';

interface RegimePeriodEntry {
  id: string;
  shortLabel: string;
  fullLabel: string;
  from: string;
  to: string;
  change: string;
  duration: string;
  range: string;
  isRef?: boolean;
}

const REGIME_META: Record<RegimeKey, {
  label: string; icon: string;
  dot: string; bg: string; border: string; text: string;
  dropBg: string; hoverBg: string; activeBg: string; activeBorder: string;
}> = {
  uptrend: {
    label: 'Bull Market', icon: '↗',
    dot: 'bg-emerald-500', bg: 'bg-emerald-50 dark:bg-emerald-500/10',
    border: 'border-emerald-200 dark:border-emerald-500/30',
    text: 'text-emerald-700 dark:text-emerald-400',
    dropBg: 'bg-white dark:bg-[#151E32]',
    hoverBg: 'hover:bg-emerald-50 dark:hover:bg-emerald-500/10',
    activeBg: 'bg-emerald-50 dark:bg-emerald-500/10',
    activeBorder: 'border-emerald-400 dark:border-emerald-500',
  },
  downtrend: {
    label: 'Bear Market', icon: '↘',
    dot: 'bg-rose-500', bg: 'bg-rose-50 dark:bg-rose-500/10',
    border: 'border-rose-200 dark:border-rose-500/30',
    text: 'text-rose-700 dark:text-rose-400',
    dropBg: 'bg-white dark:bg-[#151E32]',
    hoverBg: 'hover:bg-rose-50 dark:hover:bg-rose-500/10',
    activeBg: 'bg-rose-50 dark:bg-rose-500/10',
    activeBorder: 'border-rose-400 dark:border-rose-500',
  },
  sideways: {
    label: 'Sideways', icon: '↔',
    dot: 'bg-amber-500', bg: 'bg-amber-50 dark:bg-amber-500/10',
    border: 'border-amber-200 dark:border-amber-500/30',
    text: 'text-amber-700 dark:text-amber-400',
    dropBg: 'bg-white dark:bg-[#151E32]',
    hoverBg: 'hover:bg-amber-50 dark:hover:bg-amber-500/10',
    activeBg: 'bg-amber-50 dark:bg-amber-500/10',
    activeBorder: 'border-amber-400 dark:border-amber-500',
  },
  flat: {
    label: 'Flat / Low Vol', icon: '—',
    dot: 'bg-slate-400', bg: 'bg-slate-50 dark:bg-white/5',
    border: 'border-slate-200 dark:border-white/15',
    text: 'text-slate-600 dark:text-slate-400',
    dropBg: 'bg-white dark:bg-[#151E32]',
    hoverBg: 'hover:bg-slate-50 dark:hover:bg-white/5',
    activeBg: 'bg-slate-50 dark:bg-white/5',
    activeBorder: 'border-slate-400 dark:border-slate-500',
  },
};

const REGIME_PERIODS: Record<RegimeKey, RegimePeriodEntry[]> = {
  uptrend: [
    { id: 'U1', shortLabel: 'U1 · Gen→Apr 2021', fullLabel: '1 Gen – 13 Apr 2021', from: '2021-01-01', to: '2021-04-13', change: '+121%', duration: '3.5 mesi', range: '$29k → $64k', isRef: false },
    { id: 'U2', shortLabel: 'U2 · Lug→Nov 2021', fullLabel: '20 Lug – 10 Nov 2021', from: '2021-07-20', to: '2021-11-10', change: '+130%', duration: '3.7 mesi', range: '$30k → $69k', isRef: true },
    { id: 'U3', shortLabel: 'U3 · Gen→Feb 2023', fullLabel: '1 Gen – 16 Feb 2023', from: '2023-01-01', to: '2023-02-16', change: '+52%', duration: '6 settimane', range: '$16.5k → $25k', isRef: false },
    { id: 'U4', shortLabel: 'U4 · Set→Dic 2023', fullLabel: '11 Set – 8 Dic 2023', from: '2023-09-11', to: '2023-12-08', change: '+76%', duration: '3 mesi', range: '$25k → $44k', isRef: false },
    { id: 'U5', shortLabel: 'U5 · Gen→Mar 2024', fullLabel: '3 Gen – 14 Mar 2024', from: '2024-01-03', to: '2024-03-14', change: '+74%', duration: '2.5 mesi', range: '$42k → $73k', isRef: false },
    { id: 'U6', shortLabel: 'U6 · Ott→Nov 2024', fullLabel: '1 Ott – 22 Nov 2024', from: '2024-10-01', to: '2024-11-22', change: '+57%', duration: '7.5 settimane', range: '$63k → $99k', isRef: false },
    { id: 'U7', shortLabel: 'U7 · Apr→Mag 2025', fullLabel: '7 Apr – 21 Mag 2025', from: '2025-04-07', to: '2025-05-21', change: '+51%', duration: '6.5 settimane', range: '$74k → $112k', isRef: false },
    { id: 'U8', shortLabel: 'U8 · Lug→Ago 2025', fullLabel: '1 Lug – 10 Ago 2025', from: '2025-07-01', to: '2025-08-10', change: '+18%', duration: '5.5 settimane', range: '$105k → $124k', isRef: false },
  ],
  downtrend: [
    { id: 'D1', shortLabel: 'D1 · Apr→Giu 2021', fullLabel: '13 Apr – 22 Giu 2021', from: '2021-04-13', to: '2021-06-22', change: '-56%', duration: '2.3 mesi', range: '$64k → $28k', isRef: true },
    { id: 'D2', shortLabel: 'D2 · Nov 2021→Gen 2022', fullLabel: '10 Nov 2021 – 22 Gen 2022', from: '2021-11-10', to: '2022-01-22', change: '-52%', duration: '2.5 mesi', range: '$69k → $33k', isRef: false },
    { id: 'D3', shortLabel: 'D3 · Apr→Giu 2022 ⚠', fullLabel: '5 Apr – 18 Giu 2022', from: '2022-04-05', to: '2022-06-18', change: '-62%', duration: '2.5 mesi', range: '$46k → $17.6k', isRef: false },
    { id: 'D4', shortLabel: 'D4 · Nov 2022 ⚠', fullLabel: '3 – 22 Nov 2022', from: '2022-11-03', to: '2022-11-22', change: '-26%', duration: '3 settimane', range: '$21k → $15.5k', isRef: false },
    { id: 'D5', shortLabel: 'D5 · Ago→Set 2023', fullLabel: '15 Ago – 11 Set 2023', from: '2023-08-15', to: '2023-09-11', change: '-19%', duration: '4 settimane', range: '$31k → $25k', isRef: false },
    { id: 'D6', shortLabel: 'D6 · Giu→Ago 2024 ⚠', fullLabel: '5 Giu – 5 Ago 2024', from: '2024-06-05', to: '2024-08-05', change: '-32%', duration: '9 settimane', range: '$72k → $49k', isRef: false },
    { id: 'D7', shortLabel: 'D7 · Feb→Apr 2025', fullLabel: '1 Feb – 7 Apr 2025', from: '2025-02-01', to: '2025-04-07', change: '-28%', duration: '9 settimane', range: '$103k → $74k', isRef: false },
    { id: 'D8', shortLabel: 'D8 · Nov 2025', fullLabel: '1 – 28 Nov 2025', from: '2025-11-01', to: '2025-11-28', change: '-27%', duration: '4 settimane', range: '$110k → $80k', isRef: false },
    { id: 'D9', shortLabel: 'D9 · Gen→Feb 2026', fullLabel: '15 Gen – 7 Feb 2026', from: '2026-01-15', to: '2026-02-07', change: '-38%', duration: '3.5 settimane', range: '$97k → $60k', isRef: false },
  ],
  sideways: [
    { id: 'S1', shortLabel: 'S1 · Giu→Lug 2021', fullLabel: '22 Giu – 20 Lug 2021', from: '2021-06-22', to: '2021-07-20', change: '±24%', duration: '4 settimane', range: '$29k – $36k', isRef: false },
    { id: 'S2', shortLabel: 'S2 · Set→Ott 2021', fullLabel: '7 Set – 4 Ott 2021', from: '2021-09-07', to: '2021-10-04', change: '±24%', duration: '4 settimane', range: '$42k – $52k', isRef: false },
    { id: 'S3', shortLabel: 'S3 · Feb→Apr 2022', fullLabel: '16 Feb – 4 Apr 2022', from: '2022-02-16', to: '2022-04-04', change: '±21%', duration: '7 settimane', range: '$37k – $45k', isRef: false },
    { id: 'S4', shortLabel: 'S4 · Lug→Ago 2022', fullLabel: '26 Lug – 17 Ago 2022', from: '2022-07-26', to: '2022-08-17', change: '±14%', duration: '3 settimane', range: '$22k – $25k', isRef: false },
    { id: 'S5', shortLabel: 'S5 · Ott→Nov 2022', fullLabel: '1 Ott – 3 Nov 2022', from: '2022-10-01', to: '2022-11-03', change: '±13%', duration: '5 settimane', range: '$18.5k – $21k', isRef: false },
    { id: 'S6', shortLabel: 'S6 · Mar→Giu 2023', fullLabel: '1 Mar – 15 Giu 2023', from: '2023-03-01', to: '2023-06-15', change: '±24%', duration: '3.5 mesi', range: '$25k – $31k', isRef: true },
    { id: 'S7', shortLabel: 'S7 · Set 2024', fullLabel: '1 – 30 Set 2024', from: '2024-09-01', to: '2024-09-30', change: '±26%', duration: '4 settimane', range: '$53k – $67k', isRef: false },
    { id: 'S8', shortLabel: 'S8 · Dic 2024', fullLabel: '1 – 31 Dic 2024', from: '2024-12-01', to: '2024-12-31', change: '±20%', duration: '4 settimane', range: '$91k – $109k', isRef: false },
    { id: 'S9', shortLabel: 'S9 · Feb→Apr 2025', fullLabel: '15 Feb – 6 Apr 2025', from: '2025-02-15', to: '2025-04-06', change: '±25%', duration: '7 settimane', range: '$76k – $95k', isRef: false },
    { id: 'S10', shortLabel: 'S10 · Giu 2025', fullLabel: '1 – 30 Giu 2025', from: '2025-06-01', to: '2025-06-30', change: '±13%', duration: '4 settimane', range: '$98k – $111k', isRef: false },
    { id: 'S11', shortLabel: 'S11 · Dic 2025', fullLabel: '1 – 31 Dic 2025', from: '2025-12-01', to: '2025-12-31', change: '±13%', duration: '4 settimane', range: '$84k – $95k', isRef: false },
    { id: 'S12', shortLabel: 'S12 · Mar→Apr 2026', fullLabel: '1 Mar – 6 Apr 2026', from: '2026-03-01', to: '2026-04-06', change: '±17%', duration: '5 settimane', range: '$65k – $76k', isRef: false },
  ],
  flat: [
    { id: 'F1', shortLabel: 'F1 · Dic 2022→Gen 2023', fullLabel: '1 Dic 2022 – 12 Gen 2023', from: '2022-12-01', to: '2023-01-12', change: '±8%', duration: '6 settimane', range: '$16k – $17.2k', isRef: true },
    { id: 'F2', shortLabel: 'F2 · Set→Ott 2023', fullLabel: '15 Set – 14 Ott 2023', from: '2023-09-15', to: '2023-10-14', change: '±10%', duration: '4 settimane', range: '$25k – $27.5k', isRef: false },
    { id: 'F3', shortLabel: 'F3 · Apr 2024', fullLabel: '15 – 30 Apr 2024', from: '2024-04-15', to: '2024-04-30', change: '±8%', duration: '2.5 settimane', range: '$60k – $65k', isRef: false },
    { id: 'F4', shortLabel: 'F4 · Giu→Lug 2024', fullLabel: '10 Giu – 5 Lug 2024', from: '2024-06-10', to: '2024-07-05', change: '±13%', duration: '3.5 settimane', range: '$60k – $68k', isRef: false },
    { id: 'F5', shortLabel: 'F5 · Mag 2026', fullLabel: '1 – 17 Mag 2026', from: '2026-05-01', to: '2026-05-17', change: '±8.5%', duration: '~2.5 settimane', range: '$76k – $83k', isRef: false },
  ],
};

// ── Preset types ──────────────────────────────────────────────────────────────
interface Preset {
  id: number;
  name: string;
  params: Record<string, any>;
  created_at: string;
  updated_at: string;
}

// ── SavePresetModal ────────────────────────────────────────────────────────────
interface SavePresetModalProps {
  mode: 'save' | 'rename';
  preset?: Preset;
  params: Record<string, any>;
  apiBase: string;
  onClose: () => void;
  onSaved: () => void;
}

const SavePresetModal: React.FC<SavePresetModalProps> = ({ mode, preset, params, apiBase, onClose, onSaved }) => {
  const [name, setName] = useState(mode === 'rename' ? (preset?.name ?? '') : '');
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [error, setError] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => { inputRef.current?.focus(); }, []);

  const handleSave = async () => {
    const trimmed = name.trim();
    if (!trimmed) { setError('Il nome è obbligatorio.'); return; }
    setSaving(true);
    setError('');
    try {
      if (mode === 'save') {
        const res = await fetch(`${apiBase}/presets`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: trimmed, params }),
        });
        if (!res.ok) throw new Error(await res.text());
      } else {
        const res = await fetch(`${apiBase}/presets/${preset!.id}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: trimmed }),
        });
        if (!res.ok) throw new Error(await res.text());
      }
      onSaved();
      onClose();
    } catch (e: any) {
      setError(e.message || 'Errore nel salvataggio.');
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!preset) return;
    setDeleting(true);
    try {
      await fetch(`${apiBase}/presets/${preset.id}`, { method: 'DELETE' });
      onSaved();
      onClose();
    } finally {
      setDeleting(false);
    }
  };

  const paramKeys = Object.keys(params).slice(0, 8);

  return (
    <div className="fixed inset-0 z-[200] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" onClick={onClose} />
      <div className="relative w-full max-w-sm bg-white dark:bg-[#141c2b] rounded-2xl shadow-2xl shadow-black/40 border border-slate-100 dark:border-white/10 overflow-hidden animate-in fade-in zoom-in-95 duration-150">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-slate-100 dark:border-white/8">
          <div className="flex items-center gap-2.5">
            <div className="w-7 h-7 rounded-xl bg-indigo-500/15 flex items-center justify-center">
              <svg className="w-3.5 h-3.5 text-indigo-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 5a2 2 0 012-2h10a2 2 0 012 2v16l-7-3.5L5 21V5z" />
              </svg>
            </div>
            <h3 className="text-sm font-bold text-slate-900 dark:text-white">
              {mode === 'save' ? 'Salva Preset' : 'Rinomina Preset'}
            </h3>
          </div>
          <button onClick={onClose} className="w-7 h-7 flex items-center justify-center rounded-lg text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-white/8 transition-colors">
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M6 18L18 6M6 6l12 12" /></svg>
          </button>
        </div>

        <div className="px-5 py-4 space-y-4">
          {/* Name input */}
          <div>
            <label className="block text-[10px] font-bold text-slate-500 dark:text-slate-400 uppercase tracking-widest mb-1.5">Nome preset</label>
            <input
              ref={inputRef}
              type="text"
              value={name}
              onChange={e => { setName(e.target.value); setError(''); }}
              onKeyDown={e => { if (e.key === 'Enter') handleSave(); if (e.key === 'Escape') onClose(); }}
              placeholder="es. Trend Aggressivo, Bear Conservative…"
              maxLength={80}
              className="w-full px-3 py-2.5 rounded-xl border border-slate-200 dark:border-white/10 bg-slate-50 dark:bg-white/[0.04] text-sm text-slate-900 dark:text-white placeholder-slate-300 dark:placeholder-slate-600 focus:outline-none focus:ring-2 focus:ring-indigo-500/40 focus:border-indigo-400 dark:focus:border-indigo-500 transition-all"
            />
            {error && <p className="mt-1.5 text-[10px] font-medium text-rose-500">{error}</p>}
          </div>

          {/* Param summary (save mode only) */}
          {mode === 'save' && (
            <div className="rounded-xl border border-slate-100 dark:border-white/[0.06] bg-slate-50/50 dark:bg-white/[0.02] px-3.5 py-3">
              <p className="text-[9px] font-bold text-slate-400 dark:text-slate-500 uppercase tracking-widest mb-2">Parametri inclusi</p>
              <div className="grid grid-cols-2 gap-x-4 gap-y-1">
                {paramKeys.map(k => (
                  <div key={k} className="flex items-center justify-between gap-2">
                    <span className="text-[10px] text-slate-400 dark:text-slate-500 truncate">{k.replace(/_/g, ' ')}</span>
                    <span className="text-[10px] font-mono font-bold text-slate-600 dark:text-slate-400 flex-shrink-0">{String(params[k])}</span>
                  </div>
                ))}
                {Object.keys(params).length > 8 && (
                  <p className="col-span-2 text-[9px] text-slate-400 dark:text-slate-500 mt-1">+{Object.keys(params).length - 8} altri parametri</p>
                )}
              </div>
            </div>
          )}

          {/* Delete confirm (rename mode) */}
          {mode === 'rename' && preset && (
            confirmDelete ? (
              <div className="rounded-xl border border-rose-200 dark:border-rose-500/25 bg-rose-50/50 dark:bg-rose-500/[0.05] px-3.5 py-3 space-y-2.5">
                <p className="text-[11px] font-semibold text-rose-700 dark:text-rose-400">Eliminare «{preset.name}»? L'azione è irreversibile.</p>
                <div className="flex gap-2">
                  <button
                    onClick={handleDelete}
                    disabled={deleting}
                    className="flex-1 py-1.5 rounded-lg bg-rose-500 hover:bg-rose-600 text-white text-[11px] font-bold transition-colors disabled:opacity-50"
                  >
                    {deleting ? 'Eliminando…' : 'Sì, elimina'}
                  </button>
                  <button onClick={() => setConfirmDelete(false)} className="flex-1 py-1.5 rounded-lg bg-slate-100 dark:bg-white/8 text-slate-600 dark:text-slate-400 text-[11px] font-bold transition-colors hover:bg-slate-200 dark:hover:bg-white/12">
                    Annulla
                  </button>
                </div>
              </div>
            ) : (
              <button
                onClick={() => setConfirmDelete(true)}
                className="w-full flex items-center justify-center gap-2 py-2 rounded-xl border border-rose-200 dark:border-rose-500/20 text-rose-500 dark:text-rose-400 text-[11px] font-bold hover:bg-rose-50 dark:hover:bg-rose-500/10 transition-colors"
              >
                <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" /></svg>
                Elimina preset
              </button>
            )
          )}
        </div>

        {/* Footer */}
        <div className="flex gap-2.5 px-5 py-4 border-t border-slate-100 dark:border-white/8 bg-slate-50/50 dark:bg-white/[0.01]">
          <button
            onClick={onClose}
            className="flex-1 py-2 rounded-xl border border-slate-200 dark:border-white/10 text-sm font-bold text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-white/8 transition-colors"
          >
            Annulla
          </button>
          <button
            onClick={handleSave}
            disabled={saving || !name.trim()}
            className="flex-1 py-2 rounded-xl bg-indigo-500 hover:bg-indigo-600 text-white text-sm font-bold transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
          >
            {saving ? (
              <><svg className="w-3.5 h-3.5 animate-spin" fill="none" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" /><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" /></svg>Salvando…</>
            ) : mode === 'save' ? 'Salva Preset' : 'Rinomina'}
          </button>
        </div>
      </div>
    </div>
  );
};

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
  const [enhancedExit,  setEnhancedExit]  = useState(false);
  const [useChronos,          setUseChronos]          = useState(false);
  const [c2UncertaintyGate,   setC2UncertaintyGate]   = useState(false);
  const [c2UncertaintyThresh, setC2UncertaintyThresh] = useState('0.05');
  const [c2ContProbGate,      setC2ContProbGate]      = useState(false);
  const [c2ContProbThresh,    setC2ContProbThresh]    = useState('0.10');
  const [dynamicSlTp,              setDynamicSlTp]              = useState(false);
  const [dynamicSlTpBlend,         setDynamicSlTpBlend]         = useState('0.50');
  const [recalibratedUncertainty,  setRecalibratedUncertainty]  = useState(true);
  const [p10SlFloor,               setP10SlFloor]               = useState(false);
  const [obTp,                     setObTp]                     = useState(false);
  const [obTpBlend,                setObTpBlend]                = useState('1.0');
  const [fvgSl,                    setFvgSl]                    = useState(false);
  const [fvgTp,                    setFvgTp]                    = useState(false);
  const [fvgTpBlend,               setFvgTpBlend]               = useState('1.0');
  const [swingSl,                  setSwingSl]                  = useState(false);
  const [swingTp,                  setSwingTp]                  = useState(false);
  const [swingTpBlend,             setSwingTpBlend]             = useState('1.0');
  // Sweep Confluence directional mode
  const [sweepDirectional, setSweepDirectional] = useState(false);
  // CVD Absorption Filter
  const [absorptionFilter,    setAbsorptionFilter]    = useState(false);
  const [absorptionZThresh,   setAbsorptionZThresh]   = useState('2.0');
  // Dual ATR
  const [dualAtr, setDualAtr] = useState(false);
  // Signal quality filters
  const [exhaustionGuard,    setExhaustionGuard]    = useState(true);
  const [structuralSl,       setStructuralSl]       = useState(false);
  const [obBufferPct,        setObBufferPct]        = useState('0.3');
  const [obBufferMinAtr,     setObBufferMinAtr]     = useState('0.0');
  const [lateEntryFilter,    setLateEntryFilter]    = useState(false);
  const [lateEntryMaxObDist, setLateEntryMaxObDist] = useState('3.0');
  const [pathObstruction,    setPathObstruction]    = useState(false);
  const [pathObstMaxDist,    setPathObstMaxDist]    = useState('1.5');
  const [consecBarsFilter,   setConsecBarsFilter]   = useState(false);
  const [consecBarsMaxLong,  setConsecBarsMaxLong]  = useState('8');
  const [consecBarsMaxShort, setConsecBarsMaxShort] = useState('8');
  // Regime Bias
  const [regimeBias,          setRegimeBias]          = useState(false);
  const [regimeBiasDelta,     setRegimeBiasDelta]     = useState('0.08');
  const [regimeBiasSizeFactor,setRegimeBiasSizeFactor]= useState('1.0');
  const [forcedRegime,        setForcedRegime]        = useState<'auto' | 'bull' | 'bear' | 'neutral'>('auto');
  // Funding Rate Bias
  const [fundingGate,          setFundingGate]          = useState(false);
  const [fundingGateLookback,  setFundingGateLookback]  = useState('6');
  const [fundingHighThr,       setFundingHighThr]       = useState('0.00010');
  const [fundingExtremeThr,    setFundingExtremeThr]    = useState('0.00030');
  const [fundingBiasDelta,     setFundingBiasDelta]     = useState('0.03');
  // Fear & Greed Bias
  const [fngGate,              setFngGate]              = useState(false);
  const [fngExtremeFearThr,    setFngExtremeFearThr]    = useState('20.0');
  const [fngFearThr,           setFngFearThr]           = useState('35.0');
  const [fngGreedThr,          setFngGreedThr]          = useState('65.0');
  const [fngExtremeGreedThr,   setFngExtremeGreedThr]   = useState('80.0');
  const [fngBiasDelta,         setFngBiasDelta]         = useState('0.03');
  const [compareMode,         setCompareMode]         = useState(false);

  // ── Regime quick-selector ────────────────────────────────────────────────────
  const [selectedRegime,  setSelectedRegime]  = useState<RegimeKey | ''>('');
  const [selectedPeriod,  setSelectedPeriod]  = useState('');
  const [regimeDropOpen,  setRegimeDropOpen]  = useState(false);
  const [periodDropOpen,  setPeriodDropOpen]  = useState(false);
  const regimeRef  = useRef<HTMLDivElement>(null);
  const periodRef  = useRef<HTMLDivElement>(null);
  // ── Presets ──────────────────────────────────────────────────────────────────
  const [presets,         setPresets]         = useState<Preset[]>([]);
  const [activePreset,    setActivePreset]    = useState<Preset | null>(null);
  const [presetDropOpen,  setPresetDropOpen]  = useState(false);
  const [showSaveModal,   setShowSaveModal]   = useState(false);
  const [saveModalMode,   setSaveModalMode]   = useState<'save' | 'rename'>('save');
  const [saveModalPreset, setSaveModalPreset] = useState<Preset | undefined>(undefined);
  const presetDropRef = useRef<HTMLDivElement>(null);

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
  const [status,         setStatus]         = useState<'idle' | 'running' | 'done' | 'error'>('idle');
  const [result,         setResult]         = useState<BacktestResult | null>(null);
  const [baseline,       setBaseline]       = useState<BacktestResult | null>(null);
  const [errorMsg,       setErrorMsg]       = useState('');
  const [leverage,       setLeverage]       = useState<LeverageOption>(1);
  const [lastRunConfig,  setLastRunConfig]  = useState<Record<string, any> | null>(null);
  const [toast,          setToast]          = useState<{ type: 'success' | 'error'; msg: string } | null>(null);

  // ── Abort controller ref (one per run, replaced on each new run) ─────────────
  const abortCtrlRef = useRef<AbortController | null>(null);
  const activeJobRef = useRef<string | null>(null);

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
    if (p.enhanced_exit_enabled  !== undefined) setEnhancedExit(!!p.enhanced_exit_enabled);
    // Drawer (advanced)
    if (p.directional_threshold !== undefined) setAdvDirThresh(String(p.directional_threshold));
    if (p.adx_gate              !== undefined) setAdvAdxGate(String(p.adx_gate));
    if (p.confluence_gate       !== undefined) setAdvConfGate(String(p.confluence_gate));
    if (p.adx_gate_enabled      !== undefined) setAdvAdxEnabled(!!p.adx_gate_enabled);
    if (p.sweep_gate_enabled    !== undefined) setAdvSweepEnabled(!!p.sweep_gate_enabled);
    if (p.fvg_filter_enabled    !== undefined) setAdvFvgEnabled(!!p.fvg_filter_enabled);
    if (p.mtf_alignment_enabled !== undefined) setAdvMtfEnabled(!!p.mtf_alignment_enabled);
    if (p.chronos_weight                !== undefined) setAdvChronosWeight(String(p.chronos_weight));
    if (p.c2_uncertainty_gate_enabled   !== undefined) setC2UncertaintyGate(!!p.c2_uncertainty_gate_enabled);
    if (p.c2_uncertainty_threshold      !== undefined) setC2UncertaintyThresh(String(p.c2_uncertainty_threshold));
    if (p.c2_cont_prob_gate_enabled     !== undefined) setC2ContProbGate(!!p.c2_cont_prob_gate_enabled);
    if (p.c2_cont_prob_threshold        !== undefined) setC2ContProbThresh(String(p.c2_cont_prob_threshold));
    if (p.dynamic_sl_tp_enabled                   !== undefined) setDynamicSlTp(!!p.dynamic_sl_tp_enabled);
    if (p.dynamic_sl_tp_blend                     !== undefined) setDynamicSlTpBlend(String(p.dynamic_sl_tp_blend));
    if (p.recalibrated_uncertainty_thresholds     !== undefined) setRecalibratedUncertainty(!!p.recalibrated_uncertainty_thresholds);
    if (p.p10_sl_floor_enabled                    !== undefined) setP10SlFloor(!!p.p10_sl_floor_enabled);
    if (p.ob_tp_enabled                           !== undefined) setObTp(!!p.ob_tp_enabled);
    if (p.ob_tp_blend                             !== undefined) setObTpBlend(String(p.ob_tp_blend));
    if (p.fvg_sl_enabled                          !== undefined) setFvgSl(!!p.fvg_sl_enabled);
    if (p.fvg_tp_enabled !== undefined) setFvgTp(!!p.fvg_tp_enabled);
    if (p.fvg_tp_blend   !== undefined) setFvgTpBlend(String(p.fvg_tp_blend));
    if (p.swing_sl_enabled !== undefined) setSwingSl(!!p.swing_sl_enabled);
    if (p.swing_tp_enabled !== undefined) setSwingTp(!!p.swing_tp_enabled);
    if (p.swing_tp_blend   !== undefined) setSwingTpBlend(String(p.swing_tp_blend));
    if (p.sweep_gate_directional    !== undefined) setSweepDirectional(!!p.sweep_gate_directional);
    if (p.absorption_filter_enabled !== undefined) setAbsorptionFilter(!!p.absorption_filter_enabled);
    if (p.absorption_z_threshold    !== undefined) setAbsorptionZThresh(String(p.absorption_z_threshold));
    if (p.dual_atr_enabled           !== undefined) setDualAtr(!!p.dual_atr_enabled);
    if (p.exhaustion_guard_enabled   !== undefined) setExhaustionGuard(!!p.exhaustion_guard_enabled);
    if (p.structural_sl_enabled      !== undefined) setStructuralSl(!!p.structural_sl_enabled);
    if (p.ob_buffer_pct              !== undefined) setObBufferPct(String(p.ob_buffer_pct));
    if (p.ob_buffer_min_atr          !== undefined) setObBufferMinAtr(String(p.ob_buffer_min_atr));
    if (p.late_entry_filter_enabled  !== undefined) setLateEntryFilter(!!p.late_entry_filter_enabled);
    if (p.late_entry_max_ob_dist     !== undefined) setLateEntryMaxObDist(String(p.late_entry_max_ob_dist));
    if (p.path_obstruction_enabled   !== undefined) setPathObstruction(!!p.path_obstruction_enabled);
    if (p.path_obstruction_max_dist  !== undefined) setPathObstMaxDist(String(p.path_obstruction_max_dist));
    if (p.consec_bars_filter_enabled !== undefined) setConsecBarsFilter(!!p.consec_bars_filter_enabled);
    if (p.consec_bars_max_long       !== undefined) setConsecBarsMaxLong(String(p.consec_bars_max_long));
    if (p.consec_bars_max_short      !== undefined) setConsecBarsMaxShort(String(p.consec_bars_max_short));
    if (p.regime_bias_enabled     !== undefined) setRegimeBias(!!p.regime_bias_enabled);
    if (p.regime_bias_delta       !== undefined) setRegimeBiasDelta(String(p.regime_bias_delta));
    if (p.regime_bias_size_factor !== undefined) setRegimeBiasSizeFactor(String(p.regime_bias_size_factor));
    if (p.forced_regime           !== undefined) setForcedRegime(p.forced_regime as 'auto' | 'bull' | 'bear' | 'neutral');
    if (p.funding_gate_enabled    !== undefined) setFundingGate(!!p.funding_gate_enabled);
    if (p.funding_gate_lookback   !== undefined) setFundingGateLookback(String(p.funding_gate_lookback));
    if (p.funding_high_thr        !== undefined) setFundingHighThr(String(p.funding_high_thr));
    if (p.funding_extreme_thr     !== undefined) setFundingExtremeThr(String(p.funding_extreme_thr));
    if (p.funding_bias_delta      !== undefined) setFundingBiasDelta(String(p.funding_bias_delta));
    if (p.fng_gate_enabled        !== undefined) setFngGate(!!p.fng_gate_enabled);
    if (p.fng_extreme_fear_thr    !== undefined) setFngExtremeFearThr(String(p.fng_extreme_fear_thr));
    if (p.fng_fear_thr            !== undefined) setFngFearThr(String(p.fng_fear_thr));
    if (p.fng_greed_thr           !== undefined) setFngGreedThr(String(p.fng_greed_thr));
    if (p.fng_extreme_greed_thr   !== undefined) setFngExtremeGreedThr(String(p.fng_extreme_greed_thr));
    if (p.fng_bias_delta          !== undefined) setFngBiasDelta(String(p.fng_bias_delta));
    if (p.be_sl_enabled                 !== undefined) setAdvBeSL(!!p.be_sl_enabled);
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

  // ── Reconnect to a job that was running before a page refresh ────────────────
  useEffect(() => {
    fetch(`${apiBase}/backtest/active`)
      .then(r => r.json())
      .then(({ job_id }: { job_id: string | null }) => {
        if (!job_id) { sessionStorage.removeItem('bt_active_job'); return; }
        // There's a live job on the server — reconnect and show results when done
        setStatus('running');
        setResult(null);
        setBaseline(null);
        setErrorMsg('');
        const ctrl = new AbortController();
        abortCtrlRef.current = ctrl;
        activeJobRef.current = job_id;
        reconnectJob(apiBase, job_id, ctrl.signal)
          .then(r => { setResult(r); setStatus('done'); })
          .catch((e: Error) => {
            if (e.name === 'AbortError') { setStatus('idle'); }
            else { setErrorMsg(e.message); setStatus('error'); }
          });
      })
      .catch(() => {/* no active job or server unreachable */});
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [apiBase]);

  const cancelBacktest = async () => {
    const jobId = activeJobRef.current ?? sessionStorage.getItem('bt_active_job');
    abortCtrlRef.current?.abort();
    abortCtrlRef.current = null;
    activeJobRef.current = null;
    if (jobId) {
      try { await fetch(`${apiBase}/backtest/${jobId}`, { method: 'DELETE' }); } catch {}
    }
    sessionStorage.removeItem('bt_active_job');
    setStatus('idle');
  };

  // Close dropdowns on outside click
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (regimeRef.current && !regimeRef.current.contains(e.target as Node)) setRegimeDropOpen(false);
      if (periodRef.current && !periodRef.current.contains(e.target as Node)) setPeriodDropOpen(false);
      if (presetDropRef.current && !presetDropRef.current.contains(e.target as Node)) setPresetDropOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  // Fetch presets on mount
  useEffect(() => {
    fetch(`${apiBase}/presets`)
      .then(r => r.json())
      .then(setPresets)
      .catch(() => {});
  }, [apiBase]);

  const handleRegimeSelect = (regime: RegimeKey) => {
    setSelectedRegime(regime);
    setSelectedPeriod('');
    setRegimeDropOpen(false);
  };

  const handlePeriodSelect = (periodId: string) => {
    if (!selectedRegime) return;
    const p = REGIME_PERIODS[selectedRegime].find(x => x.id === periodId);
    if (!p) return;
    setSelectedPeriod(periodId);
    setFromDate(p.from);
    setToDate(p.to);
    setPeriodDropOpen(false);
  };

  const clearRegimeSelection = () => {
    setSelectedRegime('');
    setSelectedPeriod('');
  };

  const handleLoadPreset = (preset: Preset) => {
    applyConfig(preset.params);
    if (preset.params.chronos_enabled !== undefined) setUseChronos(!!preset.params.chronos_enabled);
    setActivePreset(preset);
    setPresetDropOpen(false);
  };

  const fetchPresets = useCallback(() => {
    fetch(`${apiBase}/presets`)
      .then(r => r.json())
      .then(setPresets)
      .catch(() => {});
  }, [apiBase]);

  const openSaveModal = () => {
    setSaveModalMode('save');
    setSaveModalPreset(undefined);
    setShowSaveModal(true);
  };

  const openRenameModal = (preset: Preset) => {
    setSaveModalMode('rename');
    setSaveModalPreset(preset);
    setShowSaveModal(true);
  };

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

  const showToast = (type: 'success' | 'error', msg: string) => {
    setToast({ type, msg });
    setTimeout(() => setToast(null), 3500);
  };

  const saveAsDefault = async () => {
    setDrawerSaving(true);
    try {
      const r = await fetch(`${apiBase}/bot/backtest`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(buildConfig(true)),
      });
      setIsDrawerOpen(false);
      showToast(r.ok ? 'success' : 'error', r.ok ? 'Configurazione salvata come default.' : 'Errore durante il salvataggio.');
    } catch {
      setIsDrawerOpen(false);
      showToast('error', 'Impossibile raggiungere il server.');
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
    enhanced_exit_enabled:    withAdvanced && lgbmExit && enhancedExit,
    // Advanced signal controls (always active — drawer only)
    chronos_enabled:               false,
    chronos_weight:                parseFloat(advChronosWeight),
    adx_gate_enabled:              advAdxEnabled,
    sweep_gate_enabled:            advSweepEnabled,
    fvg_filter_enabled:            advFvgEnabled,
    mtf_alignment_enabled:         advMtfEnabled,
    // Chronos-2 adaptive features
    c2_uncertainty_gate_enabled:   c2UncertaintyGate,
    c2_uncertainty_threshold:      parseFloat(c2UncertaintyThresh),
    c2_cont_prob_gate_enabled:     c2ContProbGate,
    c2_cont_prob_threshold:        parseFloat(c2ContProbThresh),
    dynamic_sl_tp_enabled:                  dynamicSlTp,
    dynamic_sl_tp_blend:                    parseFloat(dynamicSlTpBlend),
    recalibrated_uncertainty_thresholds:    recalibratedUncertainty,
    p10_sl_floor_enabled:                   withAdvanced && p10SlFloor && useChronos,
    ob_tp_enabled:                          obTp,
    ob_tp_blend:                            parseFloat(obTpBlend),
    fvg_sl_enabled:                         fvgSl,
    fvg_tp_enabled:                         fvgTp,
    fvg_tp_blend:                           parseFloat(fvgTpBlend),
    swing_sl_enabled:                       swingSl,
    swing_tp_enabled:                       swingTp,
    swing_tp_blend:                         parseFloat(swingTpBlend),
    // Advanced position management
    be_sl_enabled:                 advBeSL,
    be_sl_activation:              parseFloat(advBeSLAct),
    max_hold_bars_enabled:         advMaxHold,
    max_hold_bars:                 parseInt(advMaxHoldBars),
    // Regime Bias
    regime_bias_enabled:           regimeBias,
    regime_bias_delta:             parseFloat(regimeBiasDelta),
    regime_bias_size_factor:       parseFloat(regimeBiasSizeFactor),
    forced_regime:                 forcedRegime,
    // Sweep Confluence directional mode
    sweep_gate_directional:        sweepDirectional,
    // CVD Absorption Filter
    absorption_filter_enabled:     absorptionFilter,
    absorption_z_threshold:        parseFloat(absorptionZThresh),
    // Dual ATR
    dual_atr_enabled:              dualAtr,
    // Signal quality filters
    exhaustion_guard_enabled:      exhaustionGuard,
    structural_sl_enabled:         structuralSl,
    ob_buffer_pct:                 parseFloat(obBufferPct),
    ob_buffer_min_atr:             parseFloat(obBufferMinAtr),
    late_entry_filter_enabled:     lateEntryFilter,
    late_entry_max_ob_dist:        parseFloat(lateEntryMaxObDist),
    path_obstruction_enabled:      pathObstruction,
    path_obstruction_max_dist:     parseFloat(pathObstMaxDist),
    consec_bars_filter_enabled:    consecBarsFilter,
    consec_bars_max_long:          parseInt(consecBarsMaxLong),
    consec_bars_max_short:         parseInt(consecBarsMaxShort),
    // Funding Rate Bias
    funding_gate_enabled:          fundingGate,
    funding_gate_lookback:         parseInt(fundingGateLookback),
    funding_high_thr:              parseFloat(fundingHighThr),
    funding_extreme_thr:           parseFloat(fundingExtremeThr),
    funding_bias_delta:            parseFloat(fundingBiasDelta),
    // Fear & Greed Bias
    fng_gate_enabled:              fngGate,
    fng_extreme_fear_thr:          parseFloat(fngExtremeFearThr),
    fng_fear_thr:                  parseFloat(fngFearThr),
    fng_greed_thr:                 parseFloat(fngGreedThr),
    fng_extreme_greed_thr:         parseFloat(fngExtremeGreedThr),
    fng_bias_delta:                parseFloat(fngBiasDelta),
  });

  const downloadConfig = () => {
    const cfg = buildConfig(true);
    const now = new Date().toLocaleString('it-IT');
    const lines: string[] = [
      '╔══════════════════════════════════════════════════════════════╗',
      '║           QUANTUM TRADE — CONFIGURAZIONE BACKTEST            ║',
      '╚══════════════════════════════════════════════════════════════╝',
      `Esportato il: ${now}`,
      '',
      '━━━ PARAMETRI BASE ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
      `Data inizio:          ${fromDate}`,
      `Data fine:            ${toDate}`,
      `Capitale iniziale:    $${parseFloat(capital).toLocaleString('en-US')}`,
      `Simbolo:              BTC/USD`,
      `Modalità:             Paper (simulazione)`,
      '',
      '━━━ GESTIONE RISCHIO ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
      `SL ATR multiplier:    ${slMult}×`,
      `TP ATR multiplier:    ${tpMult}×`,
      `Position size:        ${posSizePct}% del capitale per trade`,
      `Max daily drawdown:   ${cfg.max_daily_dd_pct}%`,
      `Max consecutive loss: ${cfg.max_consecutive_losses} trade`,
      '',
      '━━━ STRATEGIA DI ENTRATA ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
      `Directional threshold:  ${advDirThresh} (P(up) minimo)`,
      `ADX gate:               ${advAdxGate} (${advAdxEnabled ? 'ATTIVO' : 'DISATTIVATO'})`,
      `Confluence gate:        ${advConfGate}% (${advSweepEnabled ? 'sweep ON' : 'sweep OFF'} | ${advFvgEnabled ? 'FVG ON' : 'FVG OFF'} | ${advMtfEnabled ? 'MTF ON' : 'MTF OFF'})`,
      `Regime bias:            ${regimeBias ? `ATTIVO — delta ${regimeBiasDelta}, size ×${regimeBiasSizeFactor}` : 'DISATTIVATO'}`,
      `Regime forzato:         ${forcedRegime.toUpperCase()}`,
      '',
      '━━━ STRATEGIE DI USCITA ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
      `Trailing SL:            ${trailingSL ? `ATTIVO — attivazione +${trailAct}R` : 'DISATTIVATO'}`,
      `Partial TP:             ${partialTP ? `ATTIVO — ${partialPct}% @ ${partialMult}× ATR` : 'DISATTIVATO'}`,
      `LightGBM exit:          ${lgbmExit ? `ATTIVO — soglia ${lgbmThresh}, min hold ${lgbmMinHold} barre, confirm ${lgbmConfirm} barre${enhancedExit ? ', enhanced ON' : ''}` : 'DISATTIVATO'}`,
      `Breakeven SL:           ${advBeSL ? `ATTIVO — attivazione +${advBeSLAct}R` : 'DISATTIVATO'}`,
      `Max hold bars:          ${advMaxHold ? `${advMaxHoldBars} barre (${Math.round(parseInt(advMaxHoldBars) * 4)}h)` : 'DISATTIVATO'}`,
      '',
      '━━━ MODELLI AI ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
      `Chronos-2:              ${useChronos ? `ATTIVO — peso ensemble ${advChronosWeight}` : 'DISATTIVATO (solo LightGBM)'}`,
      `C2 Uncertainty gate:    ${c2UncertaintyGate ? `ATTIVO — soglia ${c2UncertaintyThresh}` : 'DISATTIVATO'}`,
      `C2 Continuation gate:   ${c2ContProbGate ? `ATTIVO — soglia ${c2ContProbThresh}` : 'DISATTIVATO'}`,
      `Dynamic SL/TP:          ${dynamicSlTp ? `ATTIVO — blend ${dynamicSlTpBlend}` : 'DISATTIVATO'}`,
      `Recalibrated uncertainty: ${recalibratedUncertainty ? 'SÌ' : 'NO'}`,
      `P10 SL floor:           ${p10SlFloor && useChronos ? 'ATTIVO' : 'DISATTIVATO'}`,
      `TP Strutturale (OB):    ${obTp ? `ATTIVO — blend ${Math.round(parseFloat(obTpBlend) * 100)}% OB / ${Math.round((1 - parseFloat(obTpBlend)) * 100)}% ATR` : 'DISATTIVATO'}`,
      `SL Strutturale (OB):    ${structuralSl ? `ATTIVO — buffer ${obBufferPct}% | min ATR floor ${obBufferMinAtr}` : 'DISATTIVATO'}`,
      `SL — FVG:               ${fvgSl ? `ATTIVO — buffer ${obBufferPct}% | min ATR floor ${obBufferMinAtr}` : 'DISATTIVATO'}`,
      `TP — FVG:               ${fvgTp ? `ATTIVO — blend ${Math.round(parseFloat(fvgTpBlend) * 100)}% FVG / ${Math.round((1 - parseFloat(fvgTpBlend)) * 100)}% ATR` : 'DISATTIVATO'}`,
      `SL — Swing:             ${swingSl ? 'ATTIVO' : 'DISATTIVATO'}`,
      `TP — Swing:             ${swingTp ? `ATTIVO — blend ${Math.round(parseFloat(swingTpBlend) * 100)}% Swing / ${Math.round((1 - parseFloat(swingTpBlend)) * 100)}% ATR` : 'DISATTIVATO'}`,
      '',
      '━━━ SIGNAL QUALITY FILTERS ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
      `Exhaustion Guard:       ${exhaustionGuard ? 'ATTIVO' : 'DISATTIVATO'}`,
      `Absorption Filter:      ${absorptionFilter ? `ATTIVO — soglia z ${absorptionZThresh}σ` : 'DISATTIVATO'}`,
      `Dual ATR (SL/TP):       ${dualAtr ? 'ATTIVO (SL=ATR_21, TP=ATR_14)' : 'DISATTIVATO'}`,
      `Late Entry Filter:      ${lateEntryFilter ? `ATTIVO — max OB dist ${lateEntryMaxObDist} ATR` : 'DISATTIVATO'}`,
      `Path Obstruction Gate:  ${pathObstruction ? `ATTIVO — max dist contrario ${pathObstMaxDist} ATR` : 'DISATTIVATO'}`,
      `Consecutive Bars Filter:${consecBarsFilter ? ` ATTIVO — max long ${consecBarsMaxLong} bar | max short ${consecBarsMaxShort} bar` : ' DISATTIVATO'}`,
      '',
      '━━━ BIAS DI MERCATO ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
      `Funding Rate Bias:      ${fundingGate ? `ATTIVO — lookback ${fundingGateLookback} bar · high ${(parseFloat(fundingHighThr)*10000).toFixed(1)}bps · extreme ${(parseFloat(fundingExtremeThr)*10000).toFixed(1)}bps · Δ${fundingBiasDelta}` : 'DISATTIVATO'}`,
      `Fear & Greed Bias:      ${fngGate ? `ATTIVO — ExFear <${fngExtremeFearThr} · Fear <${fngFearThr} · Greed >${fngGreedThr} · ExGreed >${fngExtremeGreedThr} · Δ${fngBiasDelta}` : 'DISATTIVATO'}`,
    ];

    if (result) {
      const s = result.stats;
      lines.push('');
      lines.push('━━━ RISULTATI ULTIMO RUN ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
      lines.push(`Periodo simulato:     ${result.from_date} → ${result.to_date}`);
      lines.push(`Capitale iniziale:    $${result.initial_capital.toLocaleString('en-US')}`);
      lines.push(`Equity finale:        $${result.final_equity.toLocaleString('en-US', { maximumFractionDigits: 2 })}`);
      lines.push(`PnL totale:           ${s.total_pnl_pct >= 0 ? '+' : ''}${s.total_pnl_pct.toFixed(2)}% ($${s.total_pnl_usd.toFixed(2)})`);
      lines.push(`Trade totali:         ${s.total_trades}`);
      lines.push(`Win rate:             ${s.win_rate.toFixed(1)}%`);
      lines.push(`Profit factor:        ${s.profit_factor?.toFixed(2) ?? '—'}`);
      lines.push(`Sharpe ratio:         ${s.sharpe_ratio?.toFixed(2) ?? '—'}`);
      lines.push(`Sortino ratio:        ${s.sortino_ratio?.toFixed(2) ?? '—'}`);
      lines.push(`Max drawdown:         ${s.max_drawdown_pct.toFixed(2)}%`);
      lines.push(`Avg win:              +${s.avg_win_pct?.toFixed(2) ?? '0.00'}%`);
      lines.push(`Avg loss:             ${s.avg_loss_pct?.toFixed(2) ?? '0.00'}%`);
      lines.push(`Best trade:           +${s.best_trade_pct?.toFixed(2) ?? '0.00'}%`);
      lines.push(`Worst trade:          ${s.worst_trade_pct?.toFixed(2) ?? '0.00'}%`);
      lines.push(`Avg holding:          ${s.avg_holding_bars?.toFixed(1) ?? '—'} barre (${((s.avg_holding_bars ?? 0) * 4).toFixed(0)}h)`);
    }

    lines.push('');
    lines.push('━━━ CONFIG JSON COMPLETO ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    lines.push(JSON.stringify({
      symbol: 'BTC',
      from_date: fromDate,
      to_date: toDate,
      initial_capital: parseFloat(capital) || 10000,
      use_chronos: useChronos,
      config: cfg,
    }, null, 2));

    const blob = new Blob([lines.join('\n')], { type: 'text/plain;charset=utf-8' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href     = url;
    a.download = `backtest_config_${fromDate}_${toDate}.txt`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const runBacktest = async () => {
    // Abort any previous run cleanly before starting a new one
    abortCtrlRef.current?.abort();
    const ctrl = new AbortController();
    abortCtrlRef.current = ctrl;
    activeJobRef.current = null;

    setStatus('running');
    setResult(null);
    setBaseline(null);
    setErrorMsg('');
    setLeverage(1);
    const cfg = buildConfig(true);
    setLastRunConfig(cfg);
    try {
      const body = {
        symbol: 'BTC',
        from_date: fromDate,
        to_date: toDate,
        initial_capital: parseFloat(capital) || 10000,
        use_chronos: useChronos,
        config: cfg,
      };
      if (compareMode && (trailingSL || partialTP)) {
        const bodyBase = { ...body, config: buildConfig(false) };
        const [r1, r2] = await Promise.all([
          runJob(apiBase, body, ctrl.signal),
          runJob(apiBase, bodyBase, ctrl.signal),
        ]);
        setResult(r1);
        setBaseline(r2);
      } else {
        setResult(await runJob(apiBase, body, ctrl.signal));
      }
      setStatus('done');
    } catch (e: any) {
      if (e.name === 'AbortError') {
        setStatus('idle');
      } else {
        setErrorMsg(e.message);
        setStatus('error');
      }
    } finally {
      if (abortCtrlRef.current === ctrl) abortCtrlRef.current = null;
      activeJobRef.current = null;
    }
  };

  const advancedActive = trailingSL || partialTP;
  const drawerHasCustom = trailingSL || partialTP || lgbmExit || useChronos || advBeSL || advMaxHold
    || !advAdxEnabled || !advSweepEnabled || !advFvgEnabled || !advMtfEnabled
    || c2UncertaintyGate || c2ContProbGate || regimeBias
    || sweepDirectional || absorptionFilter || !exhaustionGuard || !structuralSl
    || lateEntryFilter || pathObstruction || dualAtr || consecBarsFilter
    || fundingGate || fngGate;

  return (
    <>
    <div className="space-y-5">
      {/* ── Toast notification ─────────────────────────────────────────────── */}
      {toast && (
        <div className={`fixed bottom-6 left-1/2 -translate-x-1/2 z-[100] flex items-center gap-3 px-5 py-3.5 rounded-2xl shadow-2xl border text-sm font-bold transition-all animate-in fade-in slide-in-from-bottom-3 ${
          toast.type === 'success'
            ? 'bg-emerald-600 text-white border-emerald-500 shadow-emerald-500/30'
            : 'bg-rose-600 text-white border-rose-500 shadow-rose-500/30'
        }`}>
          {toast.type === 'success' ? (
            <svg className="w-4 h-4 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M5 13l4 4L19 7" /></svg>
          ) : (
            <svg className="w-4 h-4 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M6 18L18 6M6 6l12 12" /></svg>
          )}
          {toast.msg}
        </div>
      )}

      {/* ── Sub-tab navigation ───────────────────────────────────────────────── */}
      <div className="flex gap-4 p-1.5 bg-slate-100 dark:bg-white/5 rounded-2xl w-fit">
        {(['nuovo', 'storico'] as const).map(tab => (
          <button
            key={tab}
            onClick={() => setActiveTab(tab)}
            className={`px-8 py-2.5 rounded-xl text-xs font-bold uppercase tracking-widest transition-all ${
              activeTab === tab
                ? 'bg-indigo-600 text-white shadow-lg shadow-indigo-500/20'
                : 'text-slate-500 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white'
            }`}
          >
            {tab === 'nuovo' ? 'Nuova Analisi' : 'Archivio Report'}
          </button>
        ))}
      </div>

      {/* ── Storico tab ─────────────────────────────────────────────────────── */}
      {activeTab === 'storico' && <HistoryTab apiBase={apiBase} />}

      {/* ── Nuovo tab ───────────────────────────────────────────────────────── */}
      {activeTab === 'nuovo' && (
        <>
          {/* ── Config card ──────────────────────────────────────────────────── */}
          <div className="elegant-card p-6 bg-white dark:bg-[#151E32] space-y-6 relative">
            {/* Advanced config button moved to top-right absolute */}
            <div className="absolute top-6 right-6 z-10">
              <Tooltip text="Apre il pannello delle impostazioni avanzate: filtri segnale, strategie di uscita (Trailing SL, Partial TP, LGBM Exit, Break-even SL), e configurazione Chronos-2. Indipendente dalle impostazioni del bot live." width="wide" pos="bottom">
                <button
                  onClick={() => setIsDrawerOpen(true)}
                  className={`flex items-center gap-2 px-4 py-2 rounded-xl text-[10px] font-bold uppercase tracking-widest border transition-all ${
                    drawerHasCustom
                      ? 'bg-indigo-50 dark:bg-indigo-500/10 border-indigo-200 dark:border-indigo-500/30 text-indigo-600 dark:text-indigo-400'
                      : 'bg-slate-50 dark:bg-white/5 border-slate-100 dark:border-white/10 text-slate-400 dark:text-slate-500 hover:text-slate-900 dark:hover:text-white'
                  }`}
                >
                  <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
                    <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                  </svg>
                  Configurazione Avanzata
                  {drawerHasCustom && <span className="w-1.5 h-1.5 rounded-full bg-indigo-500 animate-pulse" />}
                </button>
              </Tooltip>
            </div>

            {/* Header */}
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-bold text-slate-900 dark:text-white uppercase tracking-wider flex items-center gap-2">
                 <span className="w-1.5 h-4 bg-indigo-500 rounded-full"></span>
                 Parametri di Simulazione
              </h2>
            </div>

            {/* ── Presets bar ── */}
            <div className="flex items-center gap-2.5">
              {/* Preset dropdown */}
              <div className="relative flex-1 min-w-0" ref={presetDropRef}>
                <button
                  type="button"
                  disabled={presets.length === 0}
                  onClick={() => setPresetDropOpen(o => !o)}
                  className={`w-full flex items-center gap-2 px-3 py-2 rounded-xl border text-sm transition-all text-left ${
                    activePreset
                      ? 'bg-indigo-50 dark:bg-indigo-500/10 border-indigo-200 dark:border-indigo-500/30 text-indigo-700 dark:text-indigo-400'
                      : presets.length === 0
                        ? 'bg-slate-50/50 dark:bg-white/[0.02] border-slate-100 dark:border-white/5 text-slate-300 dark:text-slate-600 cursor-not-allowed'
                        : 'bg-slate-50 dark:bg-white/5 border-slate-200 dark:border-white/10 text-slate-400 dark:text-slate-500 hover:border-indigo-300 dark:hover:border-indigo-500/40'
                  }`}
                >
                  <svg className="w-3.5 h-3.5 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 5a2 2 0 012-2h10a2 2 0 012 2v16l-7-3.5L5 21V5z" />
                  </svg>
                  <span className="truncate text-xs font-semibold flex-1">
                    {activePreset ? activePreset.name : presets.length === 0 ? 'Nessun preset salvato' : 'Carica preset…'}
                  </span>
                  {activePreset && (
                    <button
                      type="button"
                      onClick={e => { e.stopPropagation(); openRenameModal(activePreset); }}
                      className="flex-shrink-0 w-5 h-5 flex items-center justify-center rounded-md text-indigo-400 hover:text-indigo-700 dark:hover:text-indigo-200 hover:bg-indigo-100 dark:hover:bg-indigo-500/20 transition-colors"
                    >
                      <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z" /></svg>
                    </button>
                  )}
                  {presets.length > 0 && (
                    <svg className={`w-3 h-3 flex-shrink-0 transition-transform duration-200 ${presetDropOpen ? 'rotate-180' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M19 9l-7 7-7-7" /></svg>
                  )}
                </button>

                {presetDropOpen && presets.length > 0 && (
                  <div className="absolute z-50 top-full left-0 mt-1.5 w-full min-w-[260px] bg-white dark:bg-[#1a2436] border border-slate-100 dark:border-white/10 rounded-2xl shadow-xl shadow-slate-900/10 dark:shadow-black/30 overflow-hidden animate-in fade-in slide-in-from-top-1 duration-150">
                    <div className="px-4 py-2 border-b border-slate-50 dark:border-white/[0.06] bg-slate-50/50 dark:bg-white/[0.02]">
                      <span className="text-[9px] font-bold text-slate-400 dark:text-slate-500 uppercase tracking-widest">I tuoi preset</span>
                    </div>
                    <div className="max-h-56 overflow-y-auto">
                      {presets.map(p => (
                        <button
                          key={p.id}
                          type="button"
                          onClick={() => handleLoadPreset(p)}
                          className={`w-full flex items-center gap-3 px-4 py-3 text-left border-b border-slate-50 dark:border-white/[0.04] last:border-0 transition-colors ${
                            activePreset?.id === p.id
                              ? 'bg-indigo-50 dark:bg-indigo-500/10 text-indigo-700 dark:text-indigo-400'
                              : 'text-slate-700 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-white/[0.04]'
                          }`}
                        >
                          <svg className="w-3 h-3 flex-shrink-0 opacity-60" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 5a2 2 0 012-2h10a2 2 0 012 2v16l-7-3.5L5 21V5z" />
                          </svg>
                          <span className="flex-1 text-xs font-semibold truncate">{p.name}</span>
                          {activePreset?.id === p.id && (
                            <svg className="w-3.5 h-3.5 flex-shrink-0 text-indigo-500" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M5 13l4 4L19 7" /></svg>
                          )}
                          <button
                            type="button"
                            onClick={e => { e.stopPropagation(); openRenameModal(p); }}
                            className="flex-shrink-0 w-5 h-5 flex items-center justify-center rounded-md text-slate-300 dark:text-slate-600 hover:text-slate-600 dark:hover:text-slate-300 hover:bg-slate-100 dark:hover:bg-white/8 transition-colors"
                          >
                            <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z" /></svg>
                          </button>
                        </button>
                      ))}
                    </div>
                  </div>
                )}
              </div>

              {/* Save button */}
              <button
                type="button"
                onClick={openSaveModal}
                className="flex-shrink-0 flex items-center gap-1.5 px-3 py-2 rounded-xl border border-indigo-200 dark:border-indigo-500/30 bg-indigo-50 dark:bg-indigo-500/10 text-indigo-600 dark:text-indigo-400 text-xs font-bold hover:bg-indigo-100 dark:hover:bg-indigo-500/20 transition-colors whitespace-nowrap"
              >
                <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7H5a2 2 0 00-2 2v9a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-3m-1 4l-3 3m0 0l-3-3m3 3V4" />
                </svg>
                Salva preset
              </button>
            </div>

            {/* Base params */}
            <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-4">
              {([
                { label: 'Dal',        tip: 'Data di inizio del backtest. I dati storici OHLCV sono disponibili dal 2017.', type: 'date',   val: fromDate,   set: setFromDate,   min: '2017-01-01', max: toDate,  dimWhenDynamic: false },
                { label: 'Al',         tip: 'Data di fine del backtest. Usa una data recente per testare su dati aggiornati.',       type: 'date',   val: toDate,     set: setToDate,     min: fromDate,     max: today,  dimWhenDynamic: false },
                { label: 'Capitale ($)',tip: 'Capitale iniziale simulato in USD. Tutti i calcoli di P&L sono basati su questo importo.', type: 'number', val: capital,    set: setCapital,    min: undefined,    max: undefined, dimWhenDynamic: false },
                { label: 'SL Mult',    tip: 'Stop Loss Multiplier: distanza dello stop loss in multipli di ATR. Usato come base e fallback anche in modalità Adaptive SL/TP.',    type: 'number', val: slMult,     set: setSlMult,     min: undefined,    max: undefined, dimWhenDynamic: false },
                { label: 'TP Mult',    tip: 'Take Profit Multiplier: distanza del TP in multipli di ATR. Usato come base e fallback anche in modalità Adaptive SL/TP.',            type: 'number', val: tpMult,     set: setTpMult,     min: undefined,    max: undefined, dimWhenDynamic: false },
                { label: 'Size (%)',   tip: 'Percentuale del capitale rischiata per ogni trade. Con $10.000 e Size 1.5%, ogni trade rischia $150.',             type: 'number', val: posSizePct, set: setPosSizePct, min: undefined,    max: undefined, dimWhenDynamic: false },
              ] as const).map(f => (
                <div key={f.label} className={`transition-all duration-200 ${f.dimWhenDynamic && dynamicSlTp ? 'opacity-35 pointer-events-none' : ''}`}>
                  <Tooltip text={f.tip} pos="bottom" width="wide">
                    <label className="flex flex-col gap-1.5 w-full">
                      <span className="text-[10px] font-bold text-slate-400 dark:text-slate-500 uppercase tracking-widest ml-1">{f.label}</span>
                      <input
                        type={f.type} value={f.val}
                        min={f.min} max={f.max}
                        onChange={e => f.set(e.target.value)}
                        className={`bg-slate-50 dark:bg-white/5 border border-slate-200 dark:border-white/10 rounded-xl px-4 py-2.5 text-sm font-bold font-mono text-slate-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500 transition-all outline-none shadow-sm${f.type === 'date' ? ' [color-scheme:light] dark:[color-scheme:dark]' : ''}`}
                      />
                    </label>
                  </Tooltip>
                </div>
              ))}
            </div>

            {/* ── Regime / Period Quick Selector ───────────────────────────────── */}
            <div className="pt-1">
              {/* Section header */}
              <div className="flex items-center gap-3 mb-3">
                <div className="flex items-center gap-2">
                  <span className="w-1 h-3 bg-indigo-400/60 rounded-full" />
                  <span className="text-[9px] font-bold text-slate-400 dark:text-slate-500 uppercase tracking-widest">Selezione Rapida Periodo Storico</span>
                </div>
                {selectedRegime && (
                  <button
                    onClick={clearRegimeSelection}
                    className="ml-auto flex items-center gap-1.5 text-[9px] font-bold text-slate-400 dark:text-slate-500 hover:text-rose-500 dark:hover:text-rose-400 transition-colors uppercase tracking-widest"
                  >
                    <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M6 18L18 6M6 6l12 12" /></svg>
                    Reset
                  </button>
                )}
              </div>

              <div className="flex gap-3 items-start">
                {/* ── Regime dropdown ── */}
                <div className="relative flex-shrink-0 w-52" ref={regimeRef}>
                  <span className="block text-[9px] font-bold text-slate-400 dark:text-slate-500 uppercase tracking-widest mb-1.5 ml-1">Regime</span>
                  <button
                    type="button"
                    onClick={() => { setRegimeDropOpen(o => !o); setPeriodDropOpen(false); }}
                    className={`w-full flex items-center gap-2.5 px-3.5 py-2.5 rounded-xl border text-sm font-bold transition-all text-left ${
                      selectedRegime
                        ? `${REGIME_META[selectedRegime].bg} ${REGIME_META[selectedRegime].border} ${REGIME_META[selectedRegime].text}`
                        : 'bg-slate-50 dark:bg-white/5 border-slate-200 dark:border-white/10 text-slate-400 dark:text-slate-500 hover:border-indigo-300 dark:hover:border-indigo-500/40'
                    }`}
                  >
                    {selectedRegime ? (
                      <>
                        <span className={`w-2 h-2 rounded-full flex-shrink-0 ${REGIME_META[selectedRegime].dot}`} />
                        <span className="truncate text-xs">{REGIME_META[selectedRegime].icon} {REGIME_META[selectedRegime].label}</span>
                      </>
                    ) : (
                      <>
                        <span className="w-2 h-2 rounded-full flex-shrink-0 bg-slate-200 dark:bg-white/10" />
                        <span className="text-xs">Seleziona regime…</span>
                      </>
                    )}
                    <svg className={`w-3.5 h-3.5 ml-auto flex-shrink-0 transition-transform duration-200 ${regimeDropOpen ? 'rotate-180' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M19 9l-7 7-7-7" /></svg>
                  </button>

                  {regimeDropOpen && (
                    <div className="absolute z-50 top-full left-0 mt-1.5 w-full bg-white dark:bg-[#1a2436] border border-slate-100 dark:border-white/10 rounded-2xl shadow-xl shadow-slate-900/10 dark:shadow-black/30 overflow-hidden animate-in fade-in slide-in-from-top-1 duration-150">
                      {(Object.keys(REGIME_META) as RegimeKey[]).map(key => {
                        const m = REGIME_META[key];
                        return (
                          <button
                            key={key}
                            type="button"
                            onClick={() => handleRegimeSelect(key)}
                            className={`w-full flex items-center gap-3 px-4 py-3 text-left transition-colors ${
                              selectedRegime === key ? `${m.activeBg} ${m.text}` : `text-slate-700 dark:text-slate-300 ${m.hoverBg}`
                            }`}
                          >
                            <span className={`w-2.5 h-2.5 rounded-full flex-shrink-0 ${m.dot}`} />
                            <div>
                              <p className="text-xs font-bold leading-tight">{m.icon} {m.label}</p>
                              <p className="text-[9px] font-medium text-slate-400 dark:text-slate-500 mt-0.5">{REGIME_PERIODS[key].length} periodi storici</p>
                            </div>
                            {selectedRegime === key && (
                              <svg className="w-3.5 h-3.5 ml-auto text-current" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M5 13l4 4L19 7" /></svg>
                            )}
                          </button>
                        );
                      })}
                    </div>
                  )}
                </div>

                {/* ── Period dropdown ── */}
                <div className="relative w-60 flex-shrink-0" ref={periodRef}>
                  <span className="block text-[9px] font-bold text-slate-400 dark:text-slate-500 uppercase tracking-widest mb-1.5 ml-1">Periodo</span>
                  <button
                    type="button"
                    disabled={!selectedRegime}
                    onClick={() => { setPeriodDropOpen(o => !o); setRegimeDropOpen(false); }}
                    className={`w-full flex items-center gap-2.5 px-3.5 py-2.5 rounded-xl border text-sm font-bold transition-all text-left ${
                      !selectedRegime
                        ? 'bg-slate-50/50 dark:bg-white/[0.02] border-slate-100 dark:border-white/5 text-slate-300 dark:text-slate-600 cursor-not-allowed'
                        : selectedPeriod
                          ? `${REGIME_META[selectedRegime].bg} ${REGIME_META[selectedRegime].border} ${REGIME_META[selectedRegime].text}`
                          : 'bg-slate-50 dark:bg-white/5 border-slate-200 dark:border-white/10 text-slate-400 dark:text-slate-500 hover:border-indigo-300 dark:hover:border-indigo-500/40'
                    }`}
                  >
                    {selectedRegime && selectedPeriod ? (() => {
                      const p = REGIME_PERIODS[selectedRegime].find(x => x.id === selectedPeriod)!;
                      return (
                        <>
                          <span className={`w-2 h-2 rounded-full flex-shrink-0 ${REGIME_META[selectedRegime].dot}`} />
                          <span className="text-xs font-bold truncate">{p.id} — {p.fullLabel}</span>
                          <span className={`ml-auto flex-shrink-0 text-[10px] font-bold font-mono px-2 py-0.5 rounded-lg ${
                            p.change.startsWith('+') ? 'bg-emerald-100 dark:bg-emerald-500/15 text-emerald-700 dark:text-emerald-400' :
                            p.change.startsWith('-') ? 'bg-rose-100 dark:bg-rose-500/15 text-rose-700 dark:text-rose-400' :
                            'bg-amber-100 dark:bg-amber-500/15 text-amber-700 dark:text-amber-400'
                          }`}>{p.change}</span>
                        </>
                      );
                    })() : (
                      <span className="text-xs">{!selectedRegime ? 'Prima seleziona un regime' : 'Seleziona un periodo…'}</span>
                    )}
                    {selectedRegime && (
                      <svg className={`w-3.5 h-3.5 flex-shrink-0 transition-transform duration-200 ${selectedPeriod ? '' : 'ml-auto'} ${periodDropOpen ? 'rotate-180' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M19 9l-7 7-7-7" /></svg>
                    )}
                  </button>

                  {periodDropOpen && selectedRegime && (
                    <div className="absolute z-50 top-full left-0 mt-1.5 w-full min-w-[420px] bg-white dark:bg-[#1a2436] border border-slate-100 dark:border-white/10 rounded-2xl shadow-xl shadow-slate-900/10 dark:shadow-black/30 overflow-hidden animate-in fade-in slide-in-from-top-1 duration-150">
                      {/* Header */}
                      <div className={`px-4 py-2.5 border-b ${REGIME_META[selectedRegime].bg} ${REGIME_META[selectedRegime].border}`}>
                        <span className={`text-[9px] font-bold uppercase tracking-widest ${REGIME_META[selectedRegime].text}`}>
                          {REGIME_META[selectedRegime].icon} {REGIME_META[selectedRegime].label} — {REGIME_PERIODS[selectedRegime].length} campioni storici
                        </span>
                      </div>
                      <div className="max-h-64 overflow-y-auto">
                        {REGIME_PERIODS[selectedRegime].map(p => (
                          <button
                            key={p.id}
                            type="button"
                            onClick={() => handlePeriodSelect(p.id)}
                            className={`w-full flex items-center gap-4 px-4 py-3 text-left border-b border-slate-50 dark:border-white/[0.04] last:border-0 transition-colors ${
                              selectedPeriod === p.id
                                ? `${REGIME_META[selectedRegime].activeBg}`
                                : `${REGIME_META[selectedRegime].hoverBg}`
                            }`}
                          >
                            {/* ID badge */}
                            <span className={`flex-shrink-0 w-9 text-center text-[10px] font-bold font-mono px-1.5 py-1 rounded-lg border ${
                              p.isRef
                                ? `${REGIME_META[selectedRegime].bg} ${REGIME_META[selectedRegime].border} ${REGIME_META[selectedRegime].text}`
                                : 'bg-slate-50 dark:bg-white/5 border-slate-100 dark:border-white/10 text-slate-500 dark:text-slate-400'
                            }`}>{p.id}</span>
                            {/* Period info */}
                            <div className="flex-1 min-w-0">
                              <p className="text-xs font-bold text-slate-800 dark:text-slate-200 truncate">{p.fullLabel}</p>
                              <p className="text-[10px] text-slate-400 dark:text-slate-500 font-medium mt-0.5">{p.duration} · {p.range}</p>
                            </div>
                            {/* Change badge */}
                            <span className={`flex-shrink-0 text-[10px] font-bold font-mono px-2 py-1 rounded-lg ${
                              p.change.startsWith('+') ? 'bg-emerald-50 dark:bg-emerald-500/10 text-emerald-700 dark:text-emerald-400' :
                              p.change.startsWith('-') ? 'bg-rose-50 dark:bg-rose-500/10 text-rose-700 dark:text-rose-400' :
                              'bg-amber-50 dark:bg-amber-500/10 text-amber-700 dark:text-amber-400'
                            }`}>{p.change}</span>
                            {/* Ref star */}
                            {p.isRef && (
                              <span className="flex-shrink-0 text-[9px] font-bold text-slate-400 dark:text-slate-500 uppercase tracking-wider">Ref</span>
                            )}
                            {/* Selected check */}
                            {selectedPeriod === p.id && (
                              <svg className={`w-3.5 h-3.5 flex-shrink-0 ${REGIME_META[selectedRegime].text}`} fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M5 13l4 4L19 7" /></svg>
                            )}
                          </button>
                        ))}
                      </div>
                    </div>
                  )}
                </div>

              </div>

              {/* Selected period info strip */}
              {selectedRegime && selectedPeriod && (() => {
                const p = REGIME_PERIODS[selectedRegime].find(x => x.id === selectedPeriod)!;
                const m = REGIME_META[selectedRegime];
                return (
                  <div className={`mt-3 flex items-center gap-3 px-4 py-2.5 rounded-xl border ${m.bg} ${m.border}`}>
                    <svg className={`w-3.5 h-3.5 flex-shrink-0 ${m.text}`} fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" /></svg>
                    <span className={`text-[10px] font-bold ${m.text}`}>
                      Date impostate: <span className="font-mono">{p.from}</span> → <span className="font-mono">{p.to}</span>
                      <span className="mx-2 opacity-40">·</span>
                      {p.duration} · {p.range} · {p.change}
                      {p.isRef && <span className="ml-2 opacity-60">(campione di riferimento)</span>}
                    </span>
                  </div>
                );
              })()}
            </div>

            {/* ── AI Adattivo — Chronos-2 ── */}
            <div className={`pt-4 border-t border-dashed space-y-3 transition-colors duration-200 ${(dynamicSlTp || p10SlFloor) ? 'border-violet-200 dark:border-violet-500/25' : 'border-slate-200 dark:border-white/8'}`}>
              <p className="text-[10px] font-bold text-slate-400 dark:text-slate-500 uppercase tracking-widest">AI Adattivo — Chronos-2</p>
              <div className="grid grid-cols-2 gap-3">
                {/* SL/TP Adattativi */}
                <Tooltip text="Adatta SL e TP alle previsioni probabilistiche di Chronos-2. Quando attivo, SL e TP fissi vengono disabilitati: le distanze vengono calcolate blendando ATR con p10/p90 del forecast. Richiede Chronos attivo nel drawer." pos="bottom" width="wide">
                  <label className={`flex items-start gap-2.5 cursor-pointer group p-3 rounded-xl border transition-all duration-200 h-full ${dynamicSlTp ? 'border-violet-200 dark:border-violet-500/30 bg-violet-50/40 dark:bg-violet-500/5' : 'border-slate-100 dark:border-white/5 hover:bg-slate-50 dark:hover:bg-white/[0.03]'}`}>
                    <div className="relative mt-0.5 flex-shrink-0">
                      <input type="checkbox" className="sr-only" checked={dynamicSlTp} onChange={e => setDynamicSlTp(e.target.checked)} />
                      <div className={`w-9 h-[18px] rounded-full transition-all duration-300 ${dynamicSlTp ? 'bg-violet-600' : 'bg-slate-200 dark:bg-white/10'}`} />
                      <div className={`absolute top-[3px] left-[3px] w-3 h-3 bg-white rounded-full shadow-sm transition-transform duration-300 ${dynamicSlTp ? 'translate-x-[18px]' : ''}`} />
                    </div>
                    <div className="min-w-0">
                      <p className={`text-xs font-bold leading-tight transition-colors ${dynamicSlTp ? 'text-violet-600 dark:text-violet-400' : 'text-slate-700 dark:text-slate-300'}`}>
                        SL/TP Adattativi
                        {dynamicSlTp && <span className="ml-1.5 px-1.5 py-0.5 rounded text-[9px] font-bold bg-violet-100 dark:bg-violet-500/20 text-violet-600 dark:text-violet-400 uppercase tracking-wider">AI-driven</span>}
                      </p>
                      <p className="text-[10px] text-slate-400 dark:text-slate-500 leading-snug mt-0.5">SL/TP calcolati da Chronos p10/p90 — moltiplicatori ATR fissi disabilitati</p>
                    </div>
                  </label>
                </Tooltip>

                {/* P10 SL Floor */}
                <Tooltip text="Usa il p10 di Chronos come floor per lo Stop Loss: se il forecast p10 è più vicino all'entry dell'ATR-SL, SL viene tirato al livello p10 → miglior R:R con Chronos confidenti." pos="bottom" width="wide">
                  <label className={`flex items-start gap-2.5 cursor-pointer group p-3 rounded-xl border transition-all duration-200 h-full ${p10SlFloor && useChronos ? 'border-amber-200 dark:border-amber-500/30 bg-amber-50/40 dark:bg-amber-500/5' : 'border-slate-100 dark:border-white/5 hover:bg-slate-50 dark:hover:bg-white/[0.03]'} ${!useChronos ? 'opacity-50' : ''}`}>
                    <div className="relative mt-0.5 flex-shrink-0">
                      <input type="checkbox" className="sr-only" checked={p10SlFloor} onChange={e => setP10SlFloor(e.target.checked)} />
                      <div className={`w-9 h-[18px] rounded-full transition-all duration-300 ${p10SlFloor && useChronos ? 'bg-amber-500' : 'bg-slate-200 dark:bg-white/10'}`} />
                      <div className={`absolute top-[3px] left-[3px] w-3 h-3 bg-white rounded-full shadow-sm transition-transform duration-300 ${p10SlFloor ? 'translate-x-[18px]' : ''}`} />
                    </div>
                    <div className="min-w-0">
                      <p className={`text-xs font-bold leading-tight transition-colors ${p10SlFloor && useChronos ? 'text-amber-600 dark:text-amber-400' : 'text-slate-700 dark:text-slate-300'}`}>
                        P10 SL Floor
                        {p10SlFloor && useChronos && <span className="ml-1.5 px-1.5 py-0.5 rounded text-[9px] font-bold bg-amber-100 dark:bg-amber-500/20 text-amber-600 dark:text-amber-400 uppercase tracking-wider">Attivo</span>}
                        {!useChronos && <span className="ml-1.5 px-1.5 py-0.5 rounded text-[9px] font-bold bg-slate-100 dark:bg-white/10 text-slate-400 dark:text-slate-500 uppercase tracking-wider">Richiede C2</span>}
                      </p>
                      <p className="text-[10px] text-slate-400 dark:text-slate-500 leading-snug mt-0.5">Chronos p10 come floor per lo SL — migliora R:R con forecast confidenti</p>
                    </div>
                  </label>
                </Tooltip>
              </div>

              {/* Blend + calibration */}
              {dynamicSlTp && (
                <div className="flex items-center gap-4 px-1">
                  <span className="text-[10px] font-bold text-slate-400 dark:text-slate-500 uppercase tracking-widest whitespace-nowrap">Blend ATR ↔ C2</span>
                  <div className="flex items-center gap-3 flex-1">
                    <span className="text-[10px] font-bold text-slate-500 dark:text-slate-400 font-mono">ATR</span>
                    <input
                      type="range" min="0" max="1" step="0.05"
                      value={dynamicSlTpBlend}
                      onChange={e => setDynamicSlTpBlend(e.target.value)}
                      className="flex-1 h-1.5 rounded-full appearance-none cursor-pointer bg-slate-200 dark:bg-white/15 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-3.5 [&::-webkit-slider-thumb]:h-3.5 [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-violet-500 [&::-webkit-slider-thumb]:shadow-sm [&::-webkit-slider-thumb]:cursor-pointer [&::-moz-range-thumb]:w-3.5 [&::-moz-range-thumb]:h-3.5 [&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:bg-violet-500 [&::-moz-range-thumb]:border-0"
                    />
                    <span className="text-[10px] font-bold text-slate-500 dark:text-slate-400 font-mono">C2</span>
                    <span className="text-[11px] font-bold font-mono text-violet-600 dark:text-violet-400 w-20 text-right">
                      {Math.round((1 - parseFloat(dynamicSlTpBlend || '0.5')) * 100)}% ATR · {Math.round(parseFloat(dynamicSlTpBlend || '0.5') * 100)}% C2
                    </span>
                  </div>
                </div>
              )}
              {dynamicSlTp && (
                <div className="flex items-center justify-between gap-3 px-1">
                  <div>
                    <p className="text-[11px] font-bold text-slate-600 dark:text-slate-300">Soglie uncertainty ricalibrate</p>
                    <p className="text-[10px] text-slate-400 dark:text-slate-500 leading-tight mt-0.5">
                      {recalibratedUncertainty
                        ? 'Distribuzione reale BTC 4h — +20% attivo da 3%, −25% da 4.2%'
                        : 'Soglie originali teoriche — +20% sotto 2%, −25% sopra 4%'}
                    </p>
                  </div>
                  <button
                    onClick={() => setRecalibratedUncertainty(v => !v)}
                    className={`relative flex-shrink-0 w-9 h-[18px] rounded-full transition-all duration-300 focus:outline-none ${recalibratedUncertainty ? 'bg-violet-600' : 'bg-slate-200 dark:bg-white/10'}`}
                    title={recalibratedUncertainty ? 'Passa alle soglie originali' : 'Passa alle soglie ricalibrate'}
                  >
                    <span className={`absolute top-[3px] left-[3px] w-3 h-3 bg-white rounded-full shadow-sm transition-transform duration-300 ${recalibratedUncertainty ? 'translate-x-[18px]' : ''}`} />
                  </button>
                </div>
              )}
              {(dynamicSlTp || p10SlFloor) && !useChronos && (
                <div className="flex items-start gap-3 bg-amber-50 dark:bg-amber-500/10 border border-amber-200 dark:border-amber-500/30 rounded-xl px-4 py-3 animate-in fade-in slide-in-from-top-1">
                  <svg className="w-4 h-4 text-amber-500 flex-shrink-0 mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" />
                  </svg>
                  <div>
                    <p className="text-[11px] font-bold text-amber-700 dark:text-amber-400 uppercase tracking-wide">Chronos-2 non attivo</p>
                    <p className="text-[11px] text-amber-600 dark:text-amber-500 leading-snug mt-0.5">
                      SL/TP Adattivi e P10 Floor richiedono Chronos-2.
                      Abilita <span className="font-bold">Chronos-2 Engine</span> nel drawer "Configurazione Avanzata".
                    </p>
                  </div>
                </div>
              )}
              {p10SlFloor && dynamicSlTp && (
                <div className="flex items-start gap-2.5 bg-violet-50 dark:bg-violet-500/10 border border-violet-200 dark:border-violet-500/30 rounded-xl px-3.5 py-2.5">
                  <svg className="w-3.5 h-3.5 text-violet-500 flex-shrink-0 mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                  </svg>
                  <p className="text-[10px] font-bold text-violet-600 dark:text-violet-400 leading-snug uppercase tracking-wide">
                    Guard B1: P10 Floor + SL/TP Adattivi attivi — se l'uncertainty è bassa (size_mult &gt; 1×) il log segnalerà la combinazione. Monitora la size USD nel report.
                  </p>
                </div>
              )}
            </div>

            {/* ── Livelli Strutturali — OB / FVG ── */}
            <div className={`pt-5 border-t transition-colors duration-200 space-y-3 ${(structuralSl || fvgSl || obTp || fvgTp || swingSl || swingTp) ? 'border-violet-200 dark:border-violet-500/25' : 'border-slate-100 dark:border-white/5'}`}>
              <p className="text-[10px] font-bold text-slate-400 dark:text-slate-500 uppercase tracking-widest">Livelli Strutturali — OB / FVG / Swing</p>
              <div className="grid grid-cols-2 gap-3">

                {/* SL — OB */}
                <Tooltip text="Posiziona lo SL oltre l'Order Block attivo più vicino nella direzione dello stop. Per long: SL = ob_bull_bot_px − buffer. Per short: SL = ob_bear_top_px + buffer. Solo allarga lo SL (mai restringe) — size ridotta proporzionalmente." pos="top" width="wide">
                  <label className={`flex items-start gap-2.5 cursor-pointer group p-3 rounded-xl border transition-all duration-200 h-full ${structuralSl ? 'border-violet-200 dark:border-violet-500/30 bg-violet-50/40 dark:bg-violet-500/5' : 'border-slate-100 dark:border-white/5 hover:bg-slate-50 dark:hover:bg-white/[0.03]'}`}>
                    <div className="relative mt-0.5 flex-shrink-0">
                      <input type="checkbox" className="sr-only" checked={structuralSl} onChange={e => setStructuralSl(e.target.checked)} />
                      <div className={`w-9 h-[18px] rounded-full transition-all duration-300 ${structuralSl ? 'bg-violet-600' : 'bg-slate-200 dark:bg-white/10'}`} />
                      <div className={`absolute top-[3px] left-[3px] w-3 h-3 bg-white rounded-full shadow-sm transition-transform duration-300 ${structuralSl ? 'translate-x-[18px]' : ''}`} />
                    </div>
                    <div className="min-w-0">
                      <p className={`text-xs font-bold leading-tight transition-colors ${structuralSl ? 'text-violet-600 dark:text-violet-400' : 'text-slate-700 dark:text-slate-300'}`}>
                        SL — OB
                        {structuralSl && <span className="ml-1.5 px-1.5 py-0.5 rounded text-[9px] font-bold bg-violet-100 dark:bg-violet-500/20 text-violet-600 dark:text-violet-400 uppercase tracking-wider">Attivo</span>}
                      </p>
                      <p className="text-[10px] text-slate-400 dark:text-slate-500 leading-snug mt-0.5">Stop Loss oltre l'Order Block attivo più vicino</p>
                    </div>
                  </label>
                </Tooltip>

                {/* TP — OB */}
                <Tooltip text="Usa il bordo dell'Order Block opposto come target del Take Profit. Per long: TP = ob_bear_top_px. Per short: TP = ob_bull_bot_px. Blend 100% OB = puro livello strutturale; 0% = puro ATR. Fallback automatico ad ATR." pos="top" width="wide">
                  <label className={`flex items-start gap-2.5 cursor-pointer group p-3 rounded-xl border transition-all duration-200 h-full ${obTp ? 'border-emerald-200 dark:border-emerald-500/30 bg-emerald-50/40 dark:bg-emerald-500/5' : 'border-slate-100 dark:border-white/5 hover:bg-slate-50 dark:hover:bg-white/[0.03]'}`}>
                    <div className="relative mt-0.5 flex-shrink-0">
                      <input type="checkbox" className="sr-only" checked={obTp} onChange={e => { setObTp(e.target.checked); if (e.target.checked) { setFvgTp(false); setSwingTp(false); } }} />
                      <div className={`w-9 h-[18px] rounded-full transition-all duration-300 ${obTp ? 'bg-emerald-600' : 'bg-slate-200 dark:bg-white/10'}`} />
                      <div className={`absolute top-[3px] left-[3px] w-3 h-3 bg-white rounded-full shadow-sm transition-transform duration-300 ${obTp ? 'translate-x-[18px]' : ''}`} />
                    </div>
                    <div className="min-w-0">
                      <p className={`text-xs font-bold leading-tight transition-colors ${obTp ? 'text-emerald-600 dark:text-emerald-400' : 'text-slate-700 dark:text-slate-300'}`}>
                        TP — OB
                        {obTp && <span className="ml-1.5 px-1.5 py-0.5 rounded text-[9px] font-bold bg-emerald-100 dark:bg-emerald-500/20 text-emerald-600 dark:text-emerald-400 uppercase tracking-wider">Attivo</span>}
                      </p>
                      <p className="text-[10px] text-slate-400 dark:text-slate-500 leading-snug mt-0.5">Take Profit al primo Order Block opposto sopra/sotto l'entry</p>
                    </div>
                  </label>
                </Tooltip>

                {/* SL — FVG */}
                <Tooltip text="Posiziona lo SL oltre il livello di invalidazione della Fair Value Gap più vicina. Per long: SL = fvg_bull_bot_px − buffer. Per short: SL = fvg_bear_top_px + buffer. Solo allarga lo SL — size ridotta proporzionalmente." pos="top" width="wide">
                  <label className={`flex items-start gap-2.5 cursor-pointer group p-3 rounded-xl border transition-all duration-200 h-full ${fvgSl ? 'border-violet-200 dark:border-violet-500/30 bg-violet-50/40 dark:bg-violet-500/5' : 'border-slate-100 dark:border-white/5 hover:bg-slate-50 dark:hover:bg-white/[0.03]'}`}>
                    <div className="relative mt-0.5 flex-shrink-0">
                      <input type="checkbox" className="sr-only" checked={fvgSl} onChange={e => setFvgSl(e.target.checked)} />
                      <div className={`w-9 h-[18px] rounded-full transition-all duration-300 ${fvgSl ? 'bg-violet-600' : 'bg-slate-200 dark:bg-white/10'}`} />
                      <div className={`absolute top-[3px] left-[3px] w-3 h-3 bg-white rounded-full shadow-sm transition-transform duration-300 ${fvgSl ? 'translate-x-[18px]' : ''}`} />
                    </div>
                    <div className="min-w-0">
                      <p className={`text-xs font-bold leading-tight transition-colors ${fvgSl ? 'text-violet-600 dark:text-violet-400' : 'text-slate-700 dark:text-slate-300'}`}>
                        SL — FVG
                        {fvgSl && <span className="ml-1.5 px-1.5 py-0.5 rounded text-[9px] font-bold bg-violet-100 dark:bg-violet-500/20 text-violet-600 dark:text-violet-400 uppercase tracking-wider">Attivo</span>}
                      </p>
                      <p className="text-[10px] text-slate-400 dark:text-slate-500 leading-snug mt-0.5">Stop Loss oltre la Fair Value Gap più vicina (invalidazione FVG)</p>
                    </div>
                  </label>
                </Tooltip>

                {/* TP — FVG */}
                <Tooltip text="Usa il bordo della Fair Value Gap opposta come target del Take Profit. Per long: TP = fvg_bear_bot_px (fondo della bearish FVG sopra l'entry). Per short: TP = fvg_bull_top_px (tetto della bullish FVG sotto l'entry). Il prezzo tende a riempire i gap — la FVG opposta è un target naturale." pos="top" width="wide">
                  <label className={`flex items-start gap-2.5 cursor-pointer group p-3 rounded-xl border transition-all duration-200 h-full ${fvgTp ? 'border-emerald-200 dark:border-emerald-500/30 bg-emerald-50/40 dark:bg-emerald-500/5' : 'border-slate-100 dark:border-white/5 hover:bg-slate-50 dark:hover:bg-white/[0.03]'}`}>
                    <div className="relative mt-0.5 flex-shrink-0">
                      <input type="checkbox" className="sr-only" checked={fvgTp} onChange={e => { setFvgTp(e.target.checked); if (e.target.checked) { setObTp(false); setSwingTp(false); } }} />
                      <div className={`w-9 h-[18px] rounded-full transition-all duration-300 ${fvgTp ? 'bg-emerald-600' : 'bg-slate-200 dark:bg-white/10'}`} />
                      <div className={`absolute top-[3px] left-[3px] w-3 h-3 bg-white rounded-full shadow-sm transition-transform duration-300 ${fvgTp ? 'translate-x-[18px]' : ''}`} />
                    </div>
                    <div className="min-w-0">
                      <p className={`text-xs font-bold leading-tight transition-colors ${fvgTp ? 'text-emerald-600 dark:text-emerald-400' : 'text-slate-700 dark:text-slate-300'}`}>
                        TP — FVG
                        {fvgTp && <span className="ml-1.5 px-1.5 py-0.5 rounded text-[9px] font-bold bg-emerald-100 dark:bg-emerald-500/20 text-emerald-600 dark:text-emerald-400 uppercase tracking-wider">Attivo</span>}
                      </p>
                      <p className="text-[10px] text-slate-400 dark:text-slate-500 leading-snug mt-0.5">Take Profit al fondo/tetto della Fair Value Gap opposta</p>
                    </div>
                  </label>
                </Tooltip>

                {/* SL — Swing */}
                <Tooltip text="Posiziona lo SL oltre il più recente swing high/low confermato. Per long: SL = swing_low_px − 0.1% (rottura del minimo strutturale). Per short: SL = swing_high_px + 0.1% (rottura del massimo strutturale). Attivo solo quando il livello è entro 4 ATR dall'entry. Solo allarga lo SL." pos="top" width="wide">
                  <label className={`flex items-start gap-2.5 cursor-pointer group p-3 rounded-xl border transition-all duration-200 h-full ${swingSl ? 'border-violet-200 dark:border-violet-500/30 bg-violet-50/40 dark:bg-violet-500/5' : 'border-slate-100 dark:border-white/5 hover:bg-slate-50 dark:hover:bg-white/[0.03]'}`}>
                    <div className="relative mt-0.5 flex-shrink-0">
                      <input type="checkbox" className="sr-only" checked={swingSl} onChange={e => setSwingSl(e.target.checked)} />
                      <div className={`w-9 h-[18px] rounded-full transition-all duration-300 ${swingSl ? 'bg-violet-600' : 'bg-slate-200 dark:bg-white/10'}`} />
                      <div className={`absolute top-[3px] left-[3px] w-3 h-3 bg-white rounded-full shadow-sm transition-transform duration-300 ${swingSl ? 'translate-x-[18px]' : ''}`} />
                    </div>
                    <div className="min-w-0">
                      <p className={`text-xs font-bold leading-tight transition-colors ${swingSl ? 'text-violet-600 dark:text-violet-400' : 'text-slate-700 dark:text-slate-300'}`}>
                        SL — Swing
                        {swingSl && <span className="ml-1.5 px-1.5 py-0.5 rounded text-[9px] font-bold bg-violet-100 dark:bg-violet-500/20 text-violet-600 dark:text-violet-400 uppercase tracking-wider">Attivo</span>}
                      </p>
                      <p className="text-[10px] text-slate-400 dark:text-slate-500 leading-snug mt-0.5">Stop Loss oltre lo Swing High/Low strutturale più vicino</p>
                    </div>
                  </label>
                </Tooltip>

                {/* TP — Swing */}
                <Tooltip text="Usa il più recente swing high/low confermato come target del Take Profit. Per long: TP = swing_high_px (prossimo massimo strutturale). Per short: TP = swing_low_px (prossimo minimo strutturale). Il blend controlla Swing vs ATR. Fallback automatico ad ATR se nessun swing valido." pos="top" width="wide">
                  <label className={`flex items-start gap-2.5 cursor-pointer group p-3 rounded-xl border transition-all duration-200 h-full ${swingTp ? 'border-emerald-200 dark:border-emerald-500/30 bg-emerald-50/40 dark:bg-emerald-500/5' : 'border-slate-100 dark:border-white/5 hover:bg-slate-50 dark:hover:bg-white/[0.03]'}`}>
                    <div className="relative mt-0.5 flex-shrink-0">
                      <input type="checkbox" className="sr-only" checked={swingTp} onChange={e => { setSwingTp(e.target.checked); if (e.target.checked) { setObTp(false); setFvgTp(false); } }} />
                      <div className={`w-9 h-[18px] rounded-full transition-all duration-300 ${swingTp ? 'bg-emerald-600' : 'bg-slate-200 dark:bg-white/10'}`} />
                      <div className={`absolute top-[3px] left-[3px] w-3 h-3 bg-white rounded-full shadow-sm transition-transform duration-300 ${swingTp ? 'translate-x-[18px]' : ''}`} />
                    </div>
                    <div className="min-w-0">
                      <p className={`text-xs font-bold leading-tight transition-colors ${swingTp ? 'text-emerald-600 dark:text-emerald-400' : 'text-slate-700 dark:text-slate-300'}`}>
                        TP — Swing
                        {swingTp && <span className="ml-1.5 px-1.5 py-0.5 rounded text-[9px] font-bold bg-emerald-100 dark:bg-emerald-500/20 text-emerald-600 dark:text-emerald-400 uppercase tracking-wider">Attivo</span>}
                      </p>
                      <p className="text-[10px] text-slate-400 dark:text-slate-500 leading-snug mt-0.5">Take Profit al prossimo Swing High/Low strutturale</p>
                    </div>
                  </label>
                </Tooltip>
              </div>

              {/* SL buffer controls */}
              {(structuralSl || fvgSl) && (
                <div className="grid grid-cols-2 gap-3 px-1">
                  <NumInput label="SL Buffer %" value={obBufferPct} onChange={setObBufferPct} step="0.1" min="0" max="2" unit="%" />
                  <NumInput label="SL Buffer Min ATR" value={obBufferMinAtr} onChange={setObBufferMinAtr} step="0.05" min="0" max="1" unit="ATR" />
                </div>
              )}

              {/* OB TP blend */}
              {obTp && (
                <div className="flex items-center gap-4 px-1">
                  <span className="text-[10px] font-bold text-slate-400 dark:text-slate-500 uppercase tracking-widest whitespace-nowrap">OB TP — Blend ATR ↔ OB</span>
                  <div className="flex items-center gap-3 flex-1">
                    <span className="text-[10px] font-bold text-slate-500 dark:text-slate-400 font-mono">ATR</span>
                    <input
                      type="range" min="0" max="1" step="0.05"
                      value={obTpBlend}
                      onChange={e => setObTpBlend(e.target.value)}
                      className="flex-1 h-1.5 rounded-full appearance-none cursor-pointer bg-slate-200 dark:bg-white/15 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-3.5 [&::-webkit-slider-thumb]:h-3.5 [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-emerald-500 [&::-webkit-slider-thumb]:shadow-sm [&::-webkit-slider-thumb]:cursor-pointer [&::-moz-range-thumb]:w-3.5 [&::-moz-range-thumb]:h-3.5 [&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:bg-emerald-500 [&::-moz-range-thumb]:border-0"
                    />
                    <span className="text-[10px] font-bold text-slate-500 dark:text-slate-400 font-mono">OB</span>
                    <span className="text-[11px] font-bold font-mono text-emerald-600 dark:text-emerald-400 w-24 text-right">
                      {Math.round((1 - parseFloat(obTpBlend || '1')) * 100)}% ATR · {Math.round(parseFloat(obTpBlend || '1') * 100)}% OB
                    </span>
                  </div>
                </div>
              )}

              {/* FVG TP blend */}
              {fvgTp && (
                <div className="flex items-center gap-4 px-1">
                  <span className="text-[10px] font-bold text-slate-400 dark:text-slate-500 uppercase tracking-widest whitespace-nowrap">FVG TP — Blend ATR ↔ FVG</span>
                  <div className="flex items-center gap-3 flex-1">
                    <span className="text-[10px] font-bold text-slate-500 dark:text-slate-400 font-mono">ATR</span>
                    <input
                      type="range" min="0" max="1" step="0.05"
                      value={fvgTpBlend}
                      onChange={e => setFvgTpBlend(e.target.value)}
                      className="flex-1 h-1.5 rounded-full appearance-none cursor-pointer bg-slate-200 dark:bg-white/15 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-3.5 [&::-webkit-slider-thumb]:h-3.5 [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-emerald-500 [&::-webkit-slider-thumb]:shadow-sm [&::-webkit-slider-thumb]:cursor-pointer [&::-moz-range-thumb]:w-3.5 [&::-moz-range-thumb]:h-3.5 [&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:bg-emerald-500 [&::-moz-range-thumb]:border-0"
                    />
                    <span className="text-[10px] font-bold text-slate-500 dark:text-slate-400 font-mono">FVG</span>
                    <span className="text-[11px] font-bold font-mono text-emerald-600 dark:text-emerald-400 w-24 text-right">
                      {Math.round((1 - parseFloat(fvgTpBlend || '1')) * 100)}% ATR · {Math.round(parseFloat(fvgTpBlend || '1') * 100)}% FVG
                    </span>
                  </div>
                </div>
              )}

              {/* Swing TP blend */}
              {swingTp && (
                <div className="flex items-center gap-4 px-1">
                  <span className="text-[10px] font-bold text-slate-400 dark:text-slate-500 uppercase tracking-widest whitespace-nowrap">Swing TP — Blend ATR ↔ Swing</span>
                  <div className="flex items-center gap-3 flex-1">
                    <span className="text-[10px] font-bold text-slate-500 dark:text-slate-400 font-mono">ATR</span>
                    <input
                      type="range" min="0" max="1" step="0.05"
                      value={swingTpBlend}
                      onChange={e => setSwingTpBlend(e.target.value)}
                      className="flex-1 h-1.5 rounded-full appearance-none cursor-pointer bg-slate-200 dark:bg-white/15 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-3.5 [&::-webkit-slider-thumb]:h-3.5 [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-emerald-500 [&::-webkit-slider-thumb]:shadow-sm [&::-webkit-slider-thumb]:cursor-pointer [&::-moz-range-thumb]:w-3.5 [&::-moz-range-thumb]:h-3.5 [&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:bg-emerald-500 [&::-moz-range-thumb]:border-0"
                    />
                    <span className="text-[10px] font-bold text-slate-500 dark:text-slate-400 font-mono">Swing</span>
                    <span className="text-[11px] font-bold font-mono text-emerald-600 dark:text-emerald-400 w-24 text-right">
                      {Math.round((1 - parseFloat(swingTpBlend || '1')) * 100)}% ATR · {Math.round(parseFloat(swingTpBlend || '1') * 100)}% Sw
                    </span>
                  </div>
                </div>
              )}
            </div>

            {/* Active strategy badges */}
            {drawerHasCustom && (
              <div className="flex flex-wrap gap-2 pt-2">
                {trailingSL   && <span className="px-3 py-1 rounded-lg text-[9px] font-bold uppercase tracking-wider bg-indigo-50 dark:bg-indigo-500/10 text-indigo-600 dark:text-indigo-400 border border-indigo-100 dark:border-indigo-500/20">Trailing SL</span>}
                {partialTP    && <span className="px-3 py-1 rounded-lg text-[9px] font-bold uppercase tracking-wider bg-indigo-50 dark:bg-indigo-500/10 text-indigo-600 dark:text-indigo-400 border border-indigo-100 dark:border-indigo-500/20">Partial TP {partialPct}%</span>}
                {lgbmExit     && <span className="px-3 py-1 rounded-lg text-[9px] font-bold uppercase tracking-wider bg-purple-50 dark:bg-purple-500/10 text-purple-600 dark:text-purple-400 border border-purple-100 dark:border-purple-500/20">LGBM Exit</span>}
                {useChronos          && <span className="px-3 py-1 rounded-lg text-[9px] font-bold uppercase tracking-wider bg-cyan-50 dark:bg-cyan-500/10 text-cyan-600 dark:text-cyan-400 border border-cyan-100 dark:border-cyan-500/20">Chronos-2 {Math.round(parseFloat(advChronosWeight)*100)}%</span>}
                {c2UncertaintyGate   && <span className="px-3 py-1 rounded-lg text-[9px] font-bold uppercase tracking-wider bg-cyan-50 dark:bg-cyan-500/10 text-cyan-600 dark:text-cyan-400 border border-cyan-100 dark:border-cyan-500/20">C2 Uncertainty &lt;{c2UncertaintyThresh}</span>}
                {dynamicSlTp && !recalibratedUncertainty && <span className="px-3 py-1 rounded-lg text-[9px] font-bold uppercase tracking-wider bg-orange-50 dark:bg-orange-500/10 text-orange-600 dark:text-orange-400 border border-orange-100 dark:border-orange-500/20">Soglie Originali</span>}
                {c2ContProbGate      && <span className="px-3 py-1 rounded-lg text-[9px] font-bold uppercase tracking-wider bg-emerald-50 dark:bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border border-emerald-100 dark:border-emerald-500/20">C2 Cont &gt;{c2ContProbThresh}</span>}
                {advBeSL             && <span className="px-3 py-1 rounded-lg text-[9px] font-bold uppercase tracking-wider bg-amber-50 dark:bg-amber-500/10 text-amber-600 dark:text-amber-400 border border-amber-100 dark:border-amber-500/20">BE SL</span>}
                {advMaxHold          && <span className="px-3 py-1 rounded-lg text-[9px] font-bold uppercase tracking-wider bg-slate-50 dark:bg-white/10 text-slate-600 dark:text-slate-400 border border-slate-200 dark:border-white/20">Max {advMaxHoldBars}b</span>}
              </div>
            )}

            {/* Chronos long-period warning */}
            {useChronos && (() => {
              const days = (new Date(toDate).getTime() - new Date(fromDate).getTime()) / 864e5;
              return days > 45 ? (
                <div className="flex items-start gap-3 bg-amber-50 dark:bg-amber-500/10 border border-amber-200 dark:border-amber-500/30 rounded-xl px-4 py-3">
                  <svg className="w-4 h-4 text-amber-500 flex-shrink-0 mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" />
                  </svg>
                  <div>
                    <p className="text-[11px] font-bold text-amber-700 dark:text-amber-400 uppercase tracking-wide">Periodo lungo con Chronos-2 attivo</p>
                    <p className="text-[11px] text-amber-600 dark:text-amber-500 leading-snug mt-0.5">
                      Chronos-2 esegue un'inferenza AI su ogni barra ({Math.round(days / (4/24))} barre × ~{days > 90 ? '5-15' : '3-8'} sec). Il backtest potrebbe impiegare <strong>{days > 90 ? '30–60+ minuti' : '10–20 minuti'}</strong>. Considera un periodo più breve (&le;45 giorni) per risultati rapidi.
                    </p>
                  </div>
                </div>
              ) : null;
            })()}

            {/* Run / Cancel / Download buttons */}
            <div className="flex flex-col sm:flex-row items-center gap-4 pt-4 border-t border-slate-100 dark:border-white/5">
              <button onClick={runBacktest} disabled={status === 'running'}
                className="w-full sm:w-auto px-8 py-3.5 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white text-sm font-bold uppercase tracking-widest rounded-xl transition-all shadow-lg shadow-indigo-500/25 active:scale-95 flex items-center justify-center gap-3">
                {status === 'running' ? (
                  <>
                    <div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin"></div>
                    {compareMode && advancedActive ? 'Elaborazione Doppia…' : 'Simulazione in corso…'}
                  </>
                ) : (
                  <>
                    <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24">
                      <path d="M5.25 5.653c0-.856.917-1.398 1.667-.986l11.54 6.348a1.125 1.125 0 010 1.971l-11.54 6.347a1.125 1.125 0 01-1.667-.985V5.653z" />
                    </svg>
                    Esegui Analisi
                  </>
                )}
              </button>
              {status === 'running' && (
                <button onClick={cancelBacktest}
                  className="w-full sm:w-auto px-6 py-3.5 bg-rose-600 hover:bg-rose-500 text-white text-sm font-bold uppercase tracking-widest rounded-xl transition-all shadow-lg shadow-rose-500/25 active:scale-95 flex items-center justify-center gap-2">
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M6 18L18 6M6 6l12 12" />
                  </svg>
                  Annulla
                </button>
              )}
              {status === 'error' && (
                <div className="flex items-center gap-2 text-rose-600 dark:text-rose-400 bg-rose-50 dark:bg-rose-500/10 px-4 py-2 rounded-xl border border-rose-100 dark:border-rose-500/20 text-xs font-bold">
                   <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
                   {errorMsg}
                </div>
              )}
              <button
                onClick={downloadConfig}
                className="sm:ml-auto w-full sm:w-auto px-5 py-3.5 bg-slate-100 hover:bg-slate-200 dark:bg-white/5 dark:hover:bg-white/10 text-slate-700 dark:text-slate-300 text-sm font-bold uppercase tracking-widest rounded-xl transition-all active:scale-95 flex items-center justify-center gap-2 border border-slate-200 dark:border-white/10"
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
                </svg>
                Scarica Configurazione
              </button>
            </div>
          </div>

          {/* ── Results ────────────────────────────────────────────────────────── */}
          {result && (() => {
            const disp     = applyLeverage(result, leverage);
            const dispBase = baseline ? applyLeverage(baseline, leverage) : null;
            return (
              <>
                {/* Config summary for current run */}
                {lastRunConfig && <ConfigSummary config={lastRunConfig} />}
                {/* Leverage selector */}
                <div className="bg-slate-50/50 dark:bg-white/[0.02] rounded-2xl px-6 py-4 border border-slate-100 dark:border-white/5">
                  <LeverageSelector value={leverage} onChange={setLeverage} worstTradePct={result.stats.worst_trade_pct} />
                </div>
                {/* Leverage compounding warning */}
                {leverage > 1 && (
                  <LeverageWarning
                    lev={leverage}
                    levPnlPct={disp.stats.total_pnl_pct}
                    basePnlPct={result.stats.total_pnl_pct}
                    bankrupt={disp.trades.some(t => t._bankrupt)}
                  />
                )}

                {/* Summary header */}
                <div className="elegant-card p-6 bg-white dark:bg-[#151E32] grid grid-cols-1 sm:grid-cols-4 gap-6 items-center">
                  <div>
                    <span className="text-[10px] font-bold text-slate-400 dark:text-slate-500 uppercase tracking-widest block mb-1.5">Periodo</span>
                    <p className="text-slate-900 dark:text-white font-bold text-sm tracking-tight">{result.from_date} <span className="text-slate-300 px-1">→</span> {result.to_date}</p>
                  </div>
                  <div>
                    <span className="text-[10px] font-bold text-slate-400 dark:text-slate-500 uppercase tracking-widest block mb-1.5">Equity Dynamics</span>
                    <p className={`font-bold text-sm tracking-tight ${disp.final_equity >= result.initial_capital ? 'text-emerald-600 dark:text-emerald-400' : 'text-rose-600 dark:text-rose-400'}`}>
                      ${result.initial_capital.toLocaleString()} <span className="text-slate-300 px-1">→</span> ${disp.final_equity.toLocaleString()}
                      {leverage > 1 && <span className="ml-2 text-[10px] font-bold text-indigo-500 uppercase tracking-widest">{leverage}× sim</span>}
                    </p>
                  </div>
                  <div>
                    <span className="text-[10px] font-bold text-slate-400 dark:text-slate-500 uppercase tracking-widest block mb-1.5">PnL Totale</span>
                    <p className={`font-bold text-xl tracking-tighter ${disp.stats.total_pnl_usd >= 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-rose-600 dark:text-rose-400'}`}>
                      {(disp.stats.total_pnl_usd ?? 0) >= 0 ? '+' : ''}${(disp.stats.total_pnl_usd ?? 0).toFixed(2)} <span className="text-[10px] font-bold ml-1 opacity-70">({disp.stats.total_pnl_pct > 0 ? '+' : ''}{disp.stats.total_pnl_pct}%)</span>
                    </p>
                  </div>
                  {advancedActive && (
                    <div className="flex flex-wrap gap-2 justify-end">
                      {trailingSL && <span className="px-3 py-1 rounded-xl text-[9px] font-bold uppercase tracking-widest bg-indigo-50 dark:bg-indigo-500/10 text-indigo-600 dark:text-indigo-400 border border-indigo-100 dark:border-indigo-500/20">Trailing SL</span>}
                      {partialTP && <span className="px-3 py-1 rounded-xl text-[9px] font-bold uppercase tracking-widest bg-indigo-50 dark:bg-indigo-500/10 text-indigo-600 dark:text-indigo-400 border border-indigo-100 dark:border-indigo-500/20">Partial TP {partialPct}%</span>}
                    </div>
                  )}
                </div>

                {/* Equity curves */}
                <div className={`grid gap-6 ${dispBase ? 'grid-cols-1 lg:grid-cols-2' : 'grid-cols-1'}`}>
                  <div className="elegant-card p-6 bg-white dark:bg-[#151E32]">
                    <h3 className="text-[10px] font-bold text-slate-400 dark:text-slate-500 uppercase tracking-widest mb-6 flex items-center gap-2">
                       <span className="w-1 h-3 bg-indigo-500 rounded-full"></span>
                       {dispBase ? 'Configurazione Ottimizzata' : `Curva Equity Portafoglio${leverage > 1 ? ` — ${leverage}× sim` : ''}`}
                    </h3>
                    <EquityChart data={disp.equity_curve} initialCapital={result.initial_capital} color={dispBase ? '#6366f1' : undefined} />
                  </div>
                  {dispBase && (
                    <div className="elegant-card p-6 bg-white dark:bg-[#151E32]">
                      <h3 className="text-[10px] font-bold text-slate-400 dark:text-slate-500 uppercase tracking-widest mb-6 flex items-center gap-2">
                         <span className="w-1 h-3 bg-slate-300 dark:bg-slate-600 rounded-full"></span>
                         Baseline (SL/TP Fisso){leverage > 1 ? ` — ${leverage}×` : ''}
                      </h3>
                      <EquityChart data={dispBase.equity_curve} initialCapital={result.initial_capital} color="#94a3b8" />
                    </div>
                  )}
                </div>

                {/* Stats */}
                <div className="elegant-card p-6 bg-white dark:bg-[#151E32]">
                  {dispBase ? (
                    <div className="space-y-8">
                      <StatsGrid stats={disp.stats} compare={dispBase.stats} label={`Report Ottimizzato${leverage > 1 ? ` (${leverage}×)` : ''} — Variazione vs Baseline`} />
                      <div className="border-t border-slate-100 dark:border-white/5 pt-8">
                        <StatsGrid stats={dispBase.stats} label={`Analisi Baseline${leverage > 1 ? ` (${leverage}×)` : ''}`} />
                      </div>
                    </div>
                  ) : (
                    <StatsGrid
                      stats={disp.stats}
                      compare={leverage > 1 ? result.stats : undefined}
                      label={leverage > 1 ? `Metriche Avanzate ${leverage}× (Delta vs Reale)` : 'Metriche di Performance'}
                    />
                  )}
                </div>

                {/* Trade table */}
                {disp.trades.length > 0 && (
                  <div className="elegant-card bg-white dark:bg-[#151E32] overflow-hidden">
                    <div className="px-6 py-4 border-b border-slate-100 dark:border-white/5 bg-slate-50/50 dark:bg-white/[0.02]">
                      <h3 className="text-[10px] font-bold text-slate-400 dark:text-slate-500 uppercase tracking-widest">
                        Cronologia Operazioni ({disp.trades.length}){leverage > 1 ? ` — Leva ${leverage}×` : ''}
                      </h3>
                    </div>
                    <TradeTable trades={disp.trades} showLevEquity={leverage > 1} initialCapital={result.initial_capital} />
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
          <div className="fixed top-0 right-0 h-full w-full max-w-md bg-white dark:bg-[#0a0e1a] border-l border-slate-100 dark:border-white/5 z-50 flex flex-col shadow-2xl overflow-hidden transition-all">
            {/* Drawer header */}
            <div className="flex items-center justify-between px-6 py-5 border-b border-slate-100 dark:border-white/5 flex-shrink-0 bg-slate-50/50 dark:bg-black/20">
              <div>
                <h3 className="text-sm font-bold text-slate-900 dark:text-white uppercase tracking-wider">Intelligence Sandbox</h3>
                <p className="text-[10px] font-bold text-slate-400 dark:text-slate-500 uppercase tracking-widest mt-1">Impostazioni Avanzate Backtest</p>
              </div>
              <button
                onClick={() => setIsDrawerOpen(false)}
                className="p-2 rounded-xl text-slate-400 hover:text-slate-900 dark:hover:text-white hover:bg-slate-100 dark:hover:bg-white/10 transition-all active:scale-90"
              >
                <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>

            {/* Drawer body */}
            <div className="flex-1 overflow-y-auto px-6 py-8 space-y-10 custom-scrollbar">

              {/* ── Motore Decisionale ──────────────────────────────────────────── */}
              <section className="space-y-5">
                <h4 className="text-[10px] font-bold text-slate-400 dark:text-slate-500 uppercase tracking-widest flex items-center gap-2">
                  <span className="w-1.5 h-1.5 rounded-full bg-indigo-500" />
                  Motore Decisionale
                </h4>
                <div className="grid grid-cols-2 gap-4">
                  <Tooltip text="Probabilità minima (0–1) che il modello deve avere per aprire un trade. 0.62 = il bot è almeno 62% sicuro della direzione." pos="bottom" width="wide">
                    <NumInput label="Soglia segnale" value={advDirThresh} onChange={setAdvDirThresh} step="0.01" min="0.50" max="0.90" />
                  </Tooltip>
                  <Tooltip text="Average Directional Index: misura la forza del trend. Sotto questo valore il mercato è considerato laterale e il bot non opera." pos="bottom" width="wide">
                    <NumInput label="ADX Power Gate" value={advAdxGate} onChange={setAdvAdxGate} step="1" min="10" max="40" />
                  </Tooltip>
                </div>
                <Tooltip text="Punteggio minimo del sistema Quantum Trade (0–100) come conferma aggiuntiva. Combina RSI, EMA, divergenze CVD e altri indicatori. 0 = disabilitato." pos="bottom" width="wide">
                  <NumInput label="Confluence confirmation" value={advConfGate} onChange={setAdvConfGate} step="1" min="0" max="100" unit="(QT SCORE)" />
                </Tooltip>
              </section>

              {/* ── Filtri Segnale ──────────────────────────────────────────────── */}
              <section className="space-y-5">
                <h4 className="text-[10px] font-bold text-slate-400 dark:text-slate-500 uppercase tracking-widest flex items-center gap-2">
                  <span className="w-1.5 h-1.5 rounded-full bg-purple-500" />
                  Filtri di Precisione
                </h4>
                <div className="space-y-4 bg-slate-50 dark:bg-white/[0.02] p-4 rounded-2xl border border-slate-100 dark:border-white/5">
                  <Toggle label="Trend Strength Filter" desc="Usa l'ADX per evitare mercati laterali" checked={advAdxEnabled} onChange={setAdvAdxEnabled} />
                  <Toggle label="Liquidity Sweep Filter" desc="Evita ingressi su falsi breakout di liquidità" checked={advSweepEnabled} onChange={setAdvSweepEnabled} />
                  {advSweepEnabled && (
                    <div className="pl-4 border-l-2 border-violet-200 dark:border-violet-500/30 ml-1">
                      <Toggle
                        label="↳ Modalità Direzionale (Stop Hunt)"
                        desc="Sweep confermato dalla direzione del modello → bonus −0.03 threshold. Conflitto → blocco."
                        checked={sweepDirectional}
                        onChange={setSweepDirectional}
                      />
                    </div>
                  )}
                  <Toggle label="Fair Value Gap (SMC)" desc="Filtra ingressi contro zone di inefficienza" checked={advFvgEnabled} onChange={setAdvFvgEnabled} />
                  <Toggle label="MTF Daily Alignment" desc="Verifica allineamento con trend primario daily" checked={advMtfEnabled} onChange={setAdvMtfEnabled} />
                  <div className="border-t border-slate-200 dark:border-white/5 pt-4 space-y-4">
                    <Toggle
                      label="CVD Absorption Filter"
                      desc="Alto volume senza movimento di prezzo → threshold +0.03 (assorbimento istituzionale)"
                      checked={absorptionFilter}
                      onChange={setAbsorptionFilter}
                    />
                    {absorptionFilter && (
                      <div className="pl-1">
                        <Tooltip text="Soglia Z-Score oltre cui scatta il boost +0.03. Valori più bassi = filtro più sensibile." pos="top" width="wide">
                          <NumInput
                            label="Soglia Absorption Z-Score"
                            value={absorptionZThresh}
                            onChange={setAbsorptionZThresh}
                            step="0.1" min="0.5" max="5.0"
                            unit="σ"
                          />
                        </Tooltip>
                      </div>
                    )}
                    <Toggle
                      label="Exhaustion Guard"
                      desc="RSI < 28 o ret_48 < −6% → threshold +0.06 (blocca entrate in zona esaurimento)"
                      checked={exhaustionGuard}
                      onChange={setExhaustionGuard}
                    />
                    <Toggle
                      label="Dual ATR — SL su ATR_21, TP su ATR_14"
                      desc="SL calcolato su ATR_21 (smooth, meno sensibile agli spike) — TP su ATR_14 (reattivo). Produce SL più stabile e R:R migliorato."
                      checked={dualAtr}
                      onChange={setDualAtr}
                    />
                    <Toggle
                      label="Late Entry Filter — OB Distance"
                      desc="Salta l'entry se il prezzo è già troppo lontano dall'Order Block attivo (ob_dist > soglia ATR). Attivo solo quando esiste un OB nella direzione del trade."
                      checked={lateEntryFilter}
                      onChange={setLateEntryFilter}
                    />
                    {lateEntryFilter && (
                      <div className="pl-1">
                        <Tooltip text="Distanza massima ATR-normalizzata tra il prezzo e il midpoint dell'Order Block. Se ob_bull_dist (long) o ob_bear_dist (short) supera questa soglia e l'OB è attivo, il trade viene saltato. Se nessun OB è attivo il filtro è inattivo. Default 3.0 ATR." pos="top" width="wide">
                          <NumInput
                            label="Distanza Massima OB (ATR)"
                            value={lateEntryMaxObDist}
                            onChange={setLateEntryMaxObDist}
                            step="0.5" min="1.0" max="8.0"
                            unit="ATR"
                          />
                        </Tooltip>
                      </div>
                    )}
                    <Toggle
                      label="Path Obstruction Gate — OB Overhead"
                      desc="Blocca long/short se un OB contrario è troppo vicino (resistenza/supporto che ostacola il percorso)"
                      checked={pathObstruction}
                      onChange={setPathObstruction}
                    />
                    {pathObstruction && (
                      <div className="pl-1">
                        <Tooltip text="Distanza massima ATR-normalizzata per considerare un OB contrario come ostacolo. Per long: se ob_bear_dist < soglia, il trade viene bloccato. Default 1.5 ATR." pos="top" width="wide">
                          <NumInput
                            label="Distanza Massima OB Contrario (ATR)"
                            value={pathObstMaxDist}
                            onChange={setPathObstMaxDist}
                            step="0.5" min="0.5" max="4.0"
                            unit="ATR"
                          />
                        </Tooltip>
                      </div>
                    )}
                    <Toggle
                      label="Consecutive Bars Filter — Trend Age"
                      desc="Blocca long/short se ci sono troppi bar consecutivi nella stessa direzione del trade (trend esteso, momentum già prezzato, alto rischio pullback)."
                      checked={consecBarsFilter}
                      onChange={setConsecBarsFilter}
                    />
                    {consecBarsFilter && (
                      <div className="pl-1 flex flex-col gap-2">
                        <Tooltip text="Numero massimo di bar bullish consecutivi prima che un long venga bloccato. Es. con 6: dopo 6 chiuse bullish consecutive il long è saltato — il trend è overextended e il rischio di pullback è alto. Default 8." pos="top" width="wide">
                          <NumInput
                            label="Max Bar Bull Consecutivi (Long)"
                            value={consecBarsMaxLong}
                            onChange={setConsecBarsMaxLong}
                            step="1" min="3" max="20"
                            unit="bar"
                          />
                        </Tooltip>
                        <Tooltip text="Numero massimo di bar bearish consecutivi prima che uno short venga bloccato. Es. con 6: dopo 6 chiuse bearish consecutive lo short è saltato — il trend è overextended e il rischio di rimbalzo è alto. Default 8." pos="top" width="wide">
                          <NumInput
                            label="Max Bar Bear Consecutivi (Short)"
                            value={consecBarsMaxShort}
                            onChange={setConsecBarsMaxShort}
                            step="1" min="3" max="20"
                            unit="bar"
                          />
                        </Tooltip>
                      </div>
                    )}
                  </div>
                </div>
              </section>

              {/* ── Regime Bias ────────────────────────────────────────────────── */}
              <section className="space-y-5">
                <h4 className="text-[10px] font-bold text-slate-400 dark:text-slate-500 uppercase tracking-widest flex items-center gap-2">
                  <span className="w-1.5 h-1.5 rounded-full bg-orange-500" />
                  Regime Bias
                </h4>
                <div className="space-y-4 bg-slate-50 dark:bg-white/[0.02] p-4 rounded-2xl border border-slate-100 dark:border-white/5">
                  <Toggle
                    label="Threshold Asimmetrico"
                    desc="Penalizza i trade contro-trend richiedendo un segnale più forte"
                    checked={regimeBias}
                    onChange={setRegimeBias}
                  />
                  {regimeBias && (
                    <div className="space-y-4 pt-1">
                      {/* Forced regime selector */}
                      <div>
                        <p className="text-[10px] font-bold text-slate-500 dark:text-slate-400 uppercase tracking-widest mb-2">Regime di mercato</p>
                        <div className="grid grid-cols-4 gap-1.5">
                          {(['auto', 'bull', 'bear', 'neutral'] as const).map(r => {
                            const labels: Record<string, string> = { auto: 'Auto', bull: 'Bull', bear: 'Bear', neutral: 'Neutro' };
                            const activeClass: Record<string, string> = {
                              auto:    'bg-slate-700 dark:bg-white text-white dark:text-slate-900 border-slate-700',
                              bull:    'bg-emerald-600 text-white border-emerald-600',
                              bear:    'bg-rose-600 text-white border-rose-600',
                              neutral: 'bg-slate-400 text-white border-transparent',
                            };
                            const inactive = 'bg-white dark:bg-white/5 text-slate-400 dark:text-slate-500 border-slate-200 dark:border-white/10 hover:bg-slate-50 dark:hover:bg-white/10';
                            return (
                              <button
                                key={r}
                                onClick={() => setForcedRegime(r)}
                                className={`py-2 rounded-lg text-[9px] font-bold uppercase tracking-widest transition-all border ${forcedRegime === r ? activeClass[r] : inactive}`}
                              >
                                {labels[r]}
                              </button>
                            );
                          })}
                        </div>
                        {forcedRegime !== 'auto' && (
                          <p className="text-[9px] font-bold mt-1.5 text-orange-500 dark:text-orange-400">
                            {forcedRegime === 'bull' && 'Regime BULL forzato — short penalizzati'}
                            {forcedRegime === 'bear' && 'Regime BEAR forzato — long penalizzati'}
                            {forcedRegime === 'neutral' && 'Regime NEUTRO — bias attivo ma simmetrico'}
                          </p>
                        )}
                      </div>
                      <Tooltip text="Delta aggiunto alla soglia direzionale per il lato contro-trend. Es. 0.08 con threshold 0.62 → 0.70 richiesto per un short in regime bull." pos="top" width="wide">
                        <NumInput
                          label="Penalità contro-trend (delta)"
                          value={regimeBiasDelta}
                          onChange={setRegimeBiasDelta}
                          step="0.01" min="0.01" max="0.20"
                          unit="Δ"
                        />
                      </Tooltip>
                      <Tooltip text="Fattore di riduzione size per i trade contro-trend che superano comunque la soglia alzata. 1.0 = size piena, 0.5 = metà size." pos="top" width="wide">
                        <NumInput
                          label="Size factor contro-trend"
                          value={regimeBiasSizeFactor}
                          onChange={setRegimeBiasSizeFactor}
                          step="0.05" min="0.30" max="1.0"
                          unit="×"
                        />
                      </Tooltip>
                    </div>
                  )}
                </div>
              </section>

              {/* ── Bias di Mercato ────────────────────────────────────────────── */}
              <section className="space-y-5">
                <h4 className="text-[10px] font-bold text-slate-400 dark:text-slate-500 uppercase tracking-widest flex items-center gap-2">
                  <span className="w-1.5 h-1.5 rounded-full bg-cyan-500" />
                  Bias di Mercato
                </h4>
                <div className="space-y-4 bg-slate-50 dark:bg-white/[0.02] p-4 rounded-2xl border border-slate-100 dark:border-white/5">
                  {/* Funding Rate Bias */}
                  <Toggle
                    label="Funding Rate Bias"
                    desc="Funding alto → soglia long alzata; funding negativo → soglia short alzata"
                    checked={fundingGate}
                    onChange={setFundingGate}
                  />
                  {fundingGate && (
                    <div className="space-y-3 pt-1">
                      <NumInput
                        label="Lookback bars (4H)"
                        value={fundingGateLookback}
                        onChange={setFundingGateLookback}
                        step="1" min="2" max="24"
                        unit="bar"
                      />
                      <NumInput
                        label="Soglia high (bps/8h)"
                        value={String((parseFloat(fundingHighThr) * 10000).toFixed(2))}
                        onChange={v => setFundingHighThr(String(parseFloat(v) / 10000))}
                        step="0.1" min="0.3" max="5.0"
                        unit="bps"
                      />
                      <NumInput
                        label="Soglia extreme (bps/8h)"
                        value={String((parseFloat(fundingExtremeThr) * 10000).toFixed(2))}
                        onChange={v => setFundingExtremeThr(String(parseFloat(v) / 10000))}
                        step="0.5" min="1.0" max="10.0"
                        unit="bps"
                      />
                      <NumInput
                        label="Bias delta"
                        value={fundingBiasDelta}
                        onChange={setFundingBiasDelta}
                        step="0.005" min="0.01" max="0.08"
                        unit="Δ"
                      />
                    </div>
                  )}
                  <div className="border-t border-slate-100 dark:border-white/5 pt-4">
                    {/* Fear & Greed Bias */}
                    <Toggle
                      label="Fear & Greed Bias"
                      desc="Contrarian: paura estrema favorisce long, greed estremo favorisce short"
                      checked={fngGate}
                      onChange={setFngGate}
                    />
                    {fngGate && (
                      <div className="space-y-3 pt-3">
                        <NumInput
                          label="Soglia Extreme Fear"
                          value={fngExtremeFearThr}
                          onChange={setFngExtremeFearThr}
                          step="1" min="5" max="40"
                          unit="<"
                        />
                        <NumInput
                          label="Soglia Fear"
                          value={fngFearThr}
                          onChange={setFngFearThr}
                          step="1" min="20" max="50"
                          unit="<"
                        />
                        <NumInput
                          label="Soglia Greed"
                          value={fngGreedThr}
                          onChange={setFngGreedThr}
                          step="1" min="50" max="80"
                          unit=">"
                        />
                        <NumInput
                          label="Soglia Extreme Greed"
                          value={fngExtremeGreedThr}
                          onChange={setFngExtremeGreedThr}
                          step="1" min="60" max="95"
                          unit=">"
                        />
                        <NumInput
                          label="Bias delta"
                          value={fngBiasDelta}
                          onChange={setFngBiasDelta}
                          step="0.005" min="0.01" max="0.08"
                          unit="Δ"
                        />
                      </div>
                    )}
                  </div>
                </div>
              </section>

              {/* ── Strategie di Uscita ─────────────────────────────────────────── */}
              <section className="space-y-6">
                <h4 className="text-[10px] font-bold text-slate-400 dark:text-slate-500 uppercase tracking-widest flex items-center gap-2">
                  <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" />
                  Position Management
                </h4>

                <div className="space-y-6">
                  {/* Trailing SL */}
                  <div className="space-y-3">
                    <Toggle label="Trailing Stop Loss" desc="Insegue il profitto aggiornando lo stop dinamico" checked={trailingSL} onChange={setTrailingSL} />
                    {trailingSL && (
                      <div className="pl-12">
                        <NumInput label="Attivazione dinamica" value={trailAct} onChange={setTrailAct} step="0.1" min="0.5" max="3" unit="ATR DIST" />
                      </div>
                    )}
                  </div>

                  {/* Partial TP */}
                  <div className="space-y-3">
                    <Toggle label="Partial Take Profit" desc="Monetizza una parte della posizione a target intermedio" checked={partialTP} onChange={setPartialTP} />
                    {partialTP && (
                      <div className="pl-12 grid grid-cols-2 gap-4">
                        <NumInput label="Target TP1" value={partialMult} onChange={setPartialMult} step="0.1" min="0.5" max="5" unit="ATR" />
                        <NumInput label="Volume" value={partialPct} onChange={setPartialPct} step="5" min="10" max="90" unit="%" />
                      </div>
                    )}
                  </div>

                  {/* Break-even SL */}
                  <div className="space-y-3">
                    <Toggle label="Risk-Free Break Even" desc="Proteggi il capitale spostando lo stop a prezzo d'entrata" checked={advBeSL} onChange={setAdvBeSL} />
                    {advBeSL && (
                      <div className="pl-12">
                        <NumInput label="Soglia protezione" value={advBeSLAct} onChange={setAdvBeSLAct} step="0.1" min="0.5" max="3.0" unit="ATR" />
                      </div>
                    )}
                  </div>

                  {/* Max Hold Bars */}
                  <div className="space-y-3">
                    <Toggle label="Time-Based Exit" desc="Uscita forzata dopo un periodo di tempo predefinito" checked={advMaxHold} onChange={setAdvMaxHold} />
                    {advMaxHold && (
                      <div className="pl-12">
                        <NumInput label="Durata massima" value={advMaxHoldBars} onChange={setAdvMaxHoldBars} step="1" min="12" max="168" unit={`CANDLE (~${Math.round(parseInt(advMaxHoldBars || '48') * 4 / 24)}d)`} />
                      </div>
                    )}
                  </div>
                </div>

                {/* Confronto A/B */}
                {advancedActive && (
                  <div className="pt-6 border-t border-slate-100 dark:border-white/5">
                    <Toggle label="Modalità Confronto A/B" desc="Simula baseline vs ottimizzato per vedere il valore aggiunto" checked={compareMode} onChange={setCompareMode} />
                  </div>
                )}
              </section>

              {/* ── LightGBM Mid-Trade Exit ─────────────────────────────────────── */}
              <section className="space-y-5">
                <h4 className="text-[10px] font-bold text-slate-400 dark:text-slate-500 uppercase tracking-widest flex items-center gap-2">
                  <span className="w-1.5 h-1.5 rounded-full bg-rose-500" />
                  Mid-Trade Intelligence
                </h4>
                <Toggle
                  label="Dynamic LGBM Signal Exit"
                  desc="Uscita intelligente basata sul decadimento del momentum rilevato dal modello LightGBM"
                  checked={lgbmExit}
                  onChange={setLgbmExit}
                />
                {lgbmExit && (
                  <div className="pl-12 grid grid-cols-1 gap-4">
                    <Tooltip text="Se la probabilità LightGBM scende sotto questo valore per N barre consecutive, il trade viene chiuso anticipatamente." pos="top" width="wide">
                      <NumInput label="Soglia criticità p <" value={lgbmThresh} onChange={setLgbmThresh} step="0.01" min="0.20" max="0.50" />
                    </Tooltip>
                    <div className="grid grid-cols-2 gap-4">
                      <NumInput label="Hold min (barre)" value={lgbmMinHold} onChange={setLgbmMinHold} step="1" min="1" max="48" />
                      <NumInput label="Conferma barre" value={lgbmConfirm} onChange={setLgbmConfirm} step="1" min="1" max="6" />
                    </div>
                    <Toggle
                      label="Enhanced Exit (Chronos p50 confirm)"
                      desc="Richiede che il p50 di Chronos abbia attraversato il prezzo di entrata per confermare l'uscita — riduce falsi segnali da rumore LGBM."
                      checked={enhancedExit}
                      onChange={setEnhancedExit}
                    />
                  </div>
                )}
              </section>

              {/* ── Chronos-2 ──────────────────────────────────────────────────── */}
              <section className="space-y-5">
                <h4 className="text-[10px] font-bold text-slate-400 dark:text-slate-500 uppercase tracking-widest flex items-center gap-2">
                  <span className="w-1.5 h-1.5 rounded-full bg-cyan-500" />
                  Chronos-2 Engine
                </h4>
                <Toggle
                  label="Transformer Inference"
                  desc="Usa il modello Chronos-2 per previsioni temporali ad alta precisione"
                  checked={useChronos}
                  onChange={setUseChronos}
                />
                {useChronos && (
                  <div className="pl-12 flex items-start gap-3 bg-amber-50 dark:bg-amber-500/10 p-3 rounded-xl border border-amber-100 dark:border-amber-500/20">
                    <svg className="w-4 h-4 text-amber-600 dark:text-amber-500 flex-shrink-0 mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
                    <p className="text-[10px] font-bold text-amber-600 dark:text-amber-400 leading-tight uppercase">
                      L'elaborazione Chronos richiede risorse GPU elevate (~3s/candela). Si consigliano periodi brevi per l'analisi.
                    </p>
                  </div>
                )}
                <div className="pl-12">
                  <Tooltip text="Quanto peso dare a Chronos-2 nella decisione finale. Il peso rimanente va a LightGBM. Esempio: 0.4 Chronos = 60% LightGBM + 40% Chronos." pos="top" width="wide">
                    <NumInput
                      label="Blending Weight Ensemble"
                      value={advChronosWeight}
                      onChange={setAdvChronosWeight}
                      step="0.05" min="0.0" max="0.9"
                      unit={`LGBM ${Math.round((1 - parseFloat(advChronosWeight || '0.4')) * 100)}%`}
                    />
                  </Tooltip>
                </div>

                {/* ── Uncertainty Gate ── */}
                <div className="space-y-3 pt-5 border-t border-slate-100 dark:border-white/5">
                  <Tooltip text="Blocca il trade quando la banda di incertezza di Chronos (p90-p10)/p50 supera la soglia. Un valore alto significa che i 200 scenari sono molto dispersi — il modello non ha una visione chiara." pos="top" width="wide">
                    <Toggle
                      label="Uncertainty Gate"
                      desc="No-trade se la previsione C2 è troppo dispersa (banda p10–p90 ampia)"
                      checked={c2UncertaintyGate}
                      onChange={setC2UncertaintyGate}
                    />
                  </Tooltip>
                  {c2UncertaintyGate && !useChronos && (
                    <div className="flex items-start gap-2.5 bg-amber-50 dark:bg-amber-500/10 border border-amber-200 dark:border-amber-500/30 rounded-xl px-3.5 py-2.5">
                      <svg className="w-3.5 h-3.5 text-amber-500 flex-shrink-0 mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" />
                      </svg>
                      <p className="text-[10px] font-bold text-amber-600 dark:text-amber-400 leading-snug uppercase tracking-wide">
                        Richiede Chronos-2 — il gate sarà ignorato senza Chronos attivo
                      </p>
                    </div>
                  )}
                  {c2UncertaintyGate && (
                    <div className="pl-12">
                      <Tooltip text="Soglia massima di incertezza tollerata. Tipicamente: <2% = mercato prevedibile, 2-4% = normale, >5% = alta dispersione. Default: 0.05 (5%)." pos="top" width="wide">
                        <NumInput
                          label="Max incertezza C2"
                          value={c2UncertaintyThresh}
                          onChange={setC2UncertaintyThresh}
                          step="0.005" min="0.01" max="0.15"
                          unit="(p90−p10)/p50"
                        />
                      </Tooltip>
                    </div>
                  )}
                </div>

                {/* ── Continuation Gate ── */}
                <div className="space-y-3 pt-5 border-t border-slate-100 dark:border-white/5">
                  <Tooltip text="Blocca il trade quando le bande quantile di Chronos non concordano sulla direzione. cont_prob misura quante delle 21 bande si muovono tutte nello stesso verso (0 = caos totale, 1 = accordo perfetto)." pos="top" width="wide">
                    <Toggle
                      label="Continuation Gate"
                      desc="No-trade se le bande di Chronos non sono coerenti direzionalmente (cont_prob basso)"
                      checked={c2ContProbGate}
                      onChange={setC2ContProbGate}
                    />
                  </Tooltip>
                  {c2ContProbGate && !useChronos && (
                    <div className="flex items-start gap-2.5 bg-amber-50 dark:bg-amber-500/10 border border-amber-200 dark:border-amber-500/30 rounded-xl px-3.5 py-2.5">
                      <svg className="w-3.5 h-3.5 text-amber-500 flex-shrink-0 mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" />
                      </svg>
                      <p className="text-[10px] font-bold text-amber-600 dark:text-amber-400 leading-snug uppercase tracking-wide">
                        Richiede Chronos-2 — il gate sarà ignorato senza Chronos attivo
                      </p>
                    </div>
                  )}
                  {c2ContProbGate && (
                    <div className="pl-12">
                      <Tooltip text="Soglia minima di coerenza direzionale. 0.10 = almeno il 60% delle bande concordano. 0.30 = circa il 65% concordano. Valori alti filtrano più aggressivamente." pos="top" width="wide">
                        <NumInput
                          label="Min coerenza direzionale"
                          value={c2ContProbThresh}
                          onChange={setC2ContProbThresh}
                          step="0.05" min="0.05" max="0.80"
                          unit="cont_prob"
                        />
                      </Tooltip>
                    </div>
                  )}
                </div>

              </section>

            </div>

            {/* Drawer footer */}
            <div className="flex items-center gap-4 px-6 pt-5 pb-8 border-t border-slate-100 dark:border-white/5 flex-shrink-0 bg-slate-50/50 dark:bg-black/20">
              <button
                onClick={loadFromLive}
                disabled={drawerLoading}
                className="flex-1 flex items-center justify-center gap-2 px-4 py-3 text-[10px] font-bold uppercase tracking-widest bg-white dark:bg-white/5 hover:bg-slate-50 dark:hover:bg-white/10 border border-slate-100 dark:border-white/10 rounded-xl text-slate-500 dark:text-slate-400 transition-all active:scale-95 disabled:opacity-50"
              >
                {drawerLoading ? (
                  <div className="w-3 h-3 border-2 border-slate-300 dark:border-slate-600 border-t-indigo-500 rounded-full animate-spin"></div>
                ) : (
                  <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" />
                  </svg>
                )}
                Importa Live
              </button>
              <button
                onClick={saveAsDefault}
                disabled={drawerSaving}
                className="flex-1 flex items-center justify-center gap-2 px-4 py-3 text-[10px] font-bold uppercase tracking-widest bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 rounded-xl text-white transition-all shadow-lg shadow-indigo-500/20 active:scale-95"
              >
                {drawerSaving ? (
                  <div className="w-3 h-3 border-2 border-white/30 border-t-white rounded-full animate-spin"></div>
                ) : (
                  <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M8 7H5a2 2 0 00-2 2v9a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-3m-1 4l-3 3m0 0l-3-3m3 3V4" />
                  </svg>
                )}
                Salva Default
              </button>
            </div>
          </div>
        </>
      )}
    </div>

    {/* Save/Rename Preset Modal */}
    {showSaveModal && (
      <SavePresetModal
        mode={saveModalMode}
        preset={saveModalPreset}
        params={{ ...buildConfig(true), chronos_enabled: useChronos }}
        apiBase={apiBase}
        onClose={() => setShowSaveModal(false)}
        onSaved={() => {
          if (saveModalMode === 'rename' && saveModalPreset) {
            fetch(`${apiBase}/presets`)
              .then(r => r.json())
              .then((ps: Preset[]) => {
                setPresets(ps);
                const updated = ps.find(p => p.id === saveModalPreset!.id);
                if (activePreset?.id === saveModalPreset!.id) {
                  // The active preset was renamed or deleted — update or clear it
                  setActivePreset(updated ?? null);
                }
              })
              .catch(() => fetchPresets());
          } else {
            fetchPresets();
          }
        }}
      />
    )}
    </>
  );
};
