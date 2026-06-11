import React, { useState, useRef, useEffect, useCallback } from 'react';
import { Tooltip } from './Tooltip';

import { apiFetch } from '../../services/authService';
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
  origin?: string;
  date?: string;
  equity_after?: number;
  leverage?: number;
  _levEq?: number;
  _bankrupt?: boolean;
}

interface EquityPoint { bar: number; equity: number; }

interface ParamStats {
  // signal volume
  bars_evaluated: number;
  signals_long: number;
  signals_short: number;
  no_trade: number;
  // hard gates
  gate_adx: number;
  gate_sweep: number;
  gate_confluence: number;
  gate_c2_uncertainty: number;
  gate_c2_cont: number;
  gate_fvg_long: number;
  gate_fvg_short: number;
  gate_late_entry: number;
  gate_path_obstruction: number;
  gate_consec_bars: number;
  gate_atr_pct: number;
  gate_daily_rsi?: number;
  gate_vol_climax?: number;
  gate_1h_block?: number;
  // squeeze protection gates
  gate_oi_spike?: number;
  gate_ls_ratio?: number;
  gate_liq_spike?: number;
  mod_oi_spike_scale?: number;
  mod_ls_ratio_scale?: number;
  mod_liq_spike_scale?: number;
  // weekend gate
  gate_weekend?: number;
  // bias/modifiers
  mod_mtf_alignment: number;
  mod_regime_bias: number;
  mod_counter_trend_size: number;
  mod_funding_bias: number;
  mod_fng_bias: number;
  mod_iv_size_reduction: number;
  mod_exhaustion_guard: number;
  mod_absorption_filter: number;
  mod_atr_pct_scale: number;
  mod_sweep_conf_bonus: number;
  mod_exhaustion_prop?: number;
  mod_c2_inversion?: number;
  mod_1h_reduce?: number;
  pm_exhaust_max_hold?: number;
  mod_transition_guard?: number;
  // exhaustion guard breakdown
  exh_trigger_rsi_only?: number;
  exh_trigger_ret48_only?: number;
  exh_trigger_both?: number;
  exh_guard_passed?: number;
  exh_guard_blocked?: number;
  exh_guard_decisive?: number;
  exh_passed_wins?: number;
  exh_passed_losses?: number;
  // structural SL/TP overrides
  sl_structural_ob: number;
  sl_fvg: number;
  sl_swing: number;
  tp_ob: number;
  // position management
  pm_trailing_sl: number;
  pm_be_sl: number;
  pm_partial_tp: number;
  pm_lgbm_exit: number;
  pm_adverse_monitor?: number;
  pm_max_hold: number;
  // trade exits
  exit_stop_loss: number;
  exit_take_profit: number;
  exit_end_of_period: number;
  // pullback entry
  pb_activated: number;
  pb_filled_zone: number;
  pb_filled_fallback: number;
  pb_decayed: number;
  // bounce-fade entry
  bf_created?: number;
  bf_filled_limit?: number;
  bf_market_fallback?: number;
  bf_abandoned?: number;
  // reversal zone detector
  rev_signals?: number;
  rev_guard_triggered?: number;
  rev_pending_set?: number;
  rev_pending_triggered?: number;
  rev_pending_expired?: number;
  rev_conflict_block?: number;
  rev_trend_boost?: number;
  // re-entry on TP
  reentry_triggered?: number;
  reentry_blocked_lgbm?: number;
  reentry_blocked_1h?: number;
}

interface BacktestResult {
  symbol: string;
  from_date: string;
  to_date: string;
  initial_capital: number;
  final_equity: number;
  total_bars: number;
  stats: BacktestStats;
  reversal_stats?: BacktestStats | null;
  trend_stats?: BacktestStats | null;
  trades: BacktestTrade[];
  equity_curve: EquityPoint[];
  param_stats?: ParamStats;
  param_config?: Record<string, boolean>;
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
    lgbm_exit:                    'bg-violet-50 dark:bg-violet-500/10 text-violet-600 dark:text-violet-400 border-violet-100 dark:border-violet-500/20',
    max_hold:                     'bg-amber-50 dark:bg-amber-500/10 text-amber-600 dark:text-amber-400 border-amber-100 dark:border-amber-500/20',
    liquidation:                  'bg-red-50 dark:bg-red-500/10 text-red-600 dark:text-red-400 border-red-200 dark:border-red-500/25',
    adverse_monitor_close:        'bg-rose-50 dark:bg-rose-500/10 text-rose-600 dark:text-rose-400 border-rose-100 dark:border-rose-500/20',
    adverse_monitor_partial_close:'bg-orange-50 dark:bg-orange-500/10 text-orange-600 dark:text-orange-400 border-orange-100 dark:border-orange-500/20',
  };

  // Newest-first
  const reversed = [...trades].reverse();
  const totalPages = Math.ceil(reversed.length / PAGE_SIZE);
  const pageSlice  = reversed.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
  const colSpan    = showLevEquity ? 12 : 12;  // always 12 — date + equity always shown

  // Reset to page 0 when trades list changes (new backtest result)
  React.useEffect(() => { setPage(0); }, [trades.length]);

  const rows: React.ReactNode[] = [];
  pageSlice.forEach((t, i) => {
    const globalIdx = page * PAGE_SIZE + i;
    const isLiquidation = t.reason === 'liquidation';
    const eqVal = t.equity_after ?? (showLevEquity ? t._levEq : undefined);
    rows.push(
      <tr key={`t-${globalIdx}`} className={`hover:bg-slate-50/50 dark:hover:bg-white/[0.02] transition-colors group ${t._bankrupt ? 'bg-rose-50/30 dark:bg-rose-500/5' : isLiquidation ? 'bg-red-50/20 dark:bg-red-500/5' : ''}`}>
        {/* Date */}
        <td className="px-3 py-2 text-slate-400 dark:text-slate-500 font-mono whitespace-nowrap">
          {t.date || <span className="text-slate-300 dark:text-slate-600">—</span>}
        </td>
        {/* Side */}
        <td className="px-3 py-2">
          <span className={`px-2 py-0.5 rounded text-[10px] font-bold tracking-wider ${t.side === 'long' ? 'bg-emerald-50 dark:bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border border-emerald-100 dark:border-emerald-500/20' : 'bg-rose-50 dark:bg-rose-500/10 text-rose-600 dark:text-rose-400 border border-rose-100 dark:border-rose-500/20'}`}>
            {t.side.toUpperCase()}
          </span>
        </td>
        <td className="px-3 py-2 text-right font-mono text-slate-600 dark:text-slate-300 font-bold">${t.entry.toLocaleString(undefined, { maximumFractionDigits: 0 })}</td>
        <td className="px-3 py-2 text-right font-mono text-slate-600 dark:text-slate-300 font-bold">${t.exit.toLocaleString(undefined, { maximumFractionDigits: 0 })}</td>
        <td className={`px-3 py-2 text-right font-mono font-bold ${numColor(t.pnl_pct)}`}>
          {t.pnl_pct > 0 ? '+' : ''}{t.pnl_pct}%
        </td>
        <td className={`px-3 py-2 text-right font-mono font-medium ${numColor(t.pnl_usd)}`}>
          {t.pnl_usd > 0 ? '+' : ''}${t.pnl_usd.toFixed(0)}
        </td>
        {/* Equity after — always shown */}
        <td className={`px-3 py-2 text-right font-mono font-bold ${eqColor(eqVal ?? (initialCapital ?? 0))}`}>
          {eqVal !== undefined ? `$${eqVal.toLocaleString(undefined, { maximumFractionDigits: 0 })}` : '—'}
        </td>
        <td className="px-3 py-2 text-right font-mono text-slate-400 dark:text-slate-500">
          {t.fee_entry !== undefined ? `$${t.fee_entry.toFixed(1)}` : '—'}
        </td>
        <td className={`px-3 py-2 text-right font-mono ${t.funding_paid !== undefined && t.funding_paid < 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-slate-400 dark:text-slate-500'}`}>
          {t.funding_paid !== undefined ? (t.funding_paid < 0 ? `+$${Math.abs(t.funding_paid).toFixed(1)}` : `$${t.funding_paid.toFixed(1)}`) : '—'}
        </td>
        <td className="px-3 py-2">
          <div className="flex items-center gap-1 flex-wrap">
            <span className={`px-2 py-0.5 rounded-lg text-[9px] font-bold uppercase tracking-wider border ${reasonStyle[t.reason] ?? 'bg-slate-50 dark:bg-white/5 text-slate-500 border-slate-200 dark:border-white/10'}`}>
              {t.reason.replace(/_/g, ' ')}
            </span>
            {t.origin === 'reentry' && (
              <span className="px-1.5 py-0.5 rounded text-[8px] font-bold uppercase tracking-wider bg-emerald-50 dark:bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border border-emerald-200 dark:border-emerald-500/25">
                re-entry
              </span>
            )}
            {(t.leverage ?? 1) > 1 && (
              <span className="px-1.5 py-0.5 rounded text-[8px] font-bold tracking-wider bg-amber-50 dark:bg-amber-500/10 text-amber-600 dark:text-amber-400 border border-amber-200 dark:border-amber-500/25">
                {t.leverage}×
              </span>
            )}
          </div>
        </td>
        <td className="px-3 py-2 text-right text-slate-400 dark:text-slate-500 font-mono">{t.holding_bars * 4}h</td>
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
              <th className="px-3 py-3 text-left">Data</th>
              <th className="px-3 py-3 text-left">Side</th>
              <th className="px-3 py-3 text-right">Entry</th>
              <th className="px-3 py-3 text-right">Exit</th>
              <th className="px-3 py-3 text-right">PnL %</th>
              <th className="px-3 py-3 text-right">PnL $</th>
              <th className="px-3 py-3 text-right">Equity</th>
              <th className="px-3 py-3 text-right">Fee Ent.</th>
              <th className="px-3 py-3 text-right">Funding</th>
              <th className="px-3 py-3 text-left">Reason</th>
              <th className="px-3 py-3 text-right">Hold</th>
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
  const startRes = await apiFetch(`${apiBase}/backtest`, {
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
        const r = await apiFetch(`${apiBase}/backtest/${job_id}`, { signal });
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
        const r = await apiFetch(`${apiBase}/backtest/${job_id}`, { signal });
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
  const sqColor = 'bg-rose-50 dark:bg-rose-500/10 text-rose-600 dark:text-rose-400 border-rose-100 dark:border-rose-500/20';
  if (c.oi_spike_gate_enabled)  activeBadges.push(badge(`OI Spike ${c.oi_spike_thr ?? 2}σ ${c.oi_spike_mode === 'block' ? 'BLOCK' : 'scale'}`, sqColor));
  if (c.ls_gate_enabled)        activeBadges.push(badge(`L/S Gate ≥${c.ls_long_block_pct ?? 67}% ${c.ls_gate_mode === 'block' ? 'BLOCK' : `×${c.ls_gate_scale_factor ?? 0.5}`}`, sqColor));
  if (c.liq_spike_gate_enabled) activeBadges.push(badge(`Liq Spike ${c.liq_spike_thr ?? 2.5}σ ${c.liq_spike_mode === 'block' ? 'BLOCK' : 'scale'}`, sqColor));
  if (c.weekend_gate_block_saturday || c.weekend_gate_block_sunday) activeBadges.push(badge(`Weekend BLOCK ${[c.weekend_gate_block_saturday && 'Sab', c.weekend_gate_block_sunday && 'Dom'].filter(Boolean).join('+')}`, 'bg-amber-50 dark:bg-amber-500/10 text-amber-600 dark:text-amber-400 border-amber-100 dark:border-amber-500/20'));
  if (c.transition_guard_enabled) activeBadges.push(badge(`Transition Guard ≥${c.transition_risk_min ?? 0.55}`, 'bg-sky-50 dark:bg-sky-500/10 text-sky-600 dark:text-sky-400 border-sky-100 dark:border-sky-500/20'));
  if (c.adverse_monitor_enabled)  activeBadges.push(badge(`Adverse Monitor ${c.adverse_action ?? 'shadow'} ≥${c.adverse_score_threshold ?? 0.40}`, 'bg-rose-50 dark:bg-rose-500/10 text-rose-600 dark:text-rose-400 border-rose-100 dark:border-rose-500/20'));

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
      <div className="grid grid-cols-2 sm:grid-cols-6 gap-x-6 gap-y-3">
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

// ── Parameter Activity Report ─────────────────────────────────────────────────
const ParamActivity: React.FC<{ ps: ParamStats; cfg?: Record<string, boolean>; trades?: BacktestTrade[] }> = ({ ps, cfg, trades: allTrades }) => {
  const total  = ps.bars_evaluated || 1;
  const trades = (ps.signals_long ?? 0) + (ps.signals_short ?? 0);

  // Re-entry win/loss: only FULL closes (exclude partial_tp — they're sub-records of the same position)
  const reentryClosings = (allTrades ?? []).filter(t => t.origin === 'reentry' && t.reason !== 'partial_tp');
  const reentryWins     = reentryClosings.filter(t => t.pnl_pct > 0).length;
  const reentryLosses   = reentryClosings.filter(t => t.pnl_pct < 0).length;
  const reentryWinRate  = reentryClosings.length > 0 ? Math.round(reentryWins / reentryClosings.length * 100) : null;

  // Exhaustion Guard: wins/losses from backend counters
  const exhPassed       = (ps.exh_guard_passed  ?? 0);
  const exhBlocked      = (ps.exh_guard_blocked  ?? 0);
  const exhTotal        = (ps.mod_exhaustion_guard ?? 0);
  const exhPassedWins   = (ps.exh_passed_wins    ?? 0);
  const exhPassedLosses = (ps.exh_passed_losses  ?? 0);
  const exhPassedClosed = exhPassedWins + exhPassedLosses;
  const exhWinRate      = exhPassedClosed > 0 ? Math.round(exhPassedWins / exhPassedClosed * 100) : null;

  // isOn: true = enabled in backtest settings, false = disabled (hidden from report)
  // When param_config is not available (old backtest result), show all rows.
  const isOn = (key: string): boolean => cfg ? (cfg[key] ?? false) : true;

  const pct = (n: number, base = total) => base > 0 ? Math.round(n / base * 100) : 0;

  type Row = {
    key: string;           // matches param_config keys
    label: string;
    count: number;
    pct?: number;
    note?: string;
    alwaysShow?: boolean;  // signal/exit rows always shown regardless of param_config
  };

  const groups: { title: string; color: string; dot: string; rows: Row[]; alwaysShow?: boolean }[] = [
    {
      title: 'Segnali Valutati',
      color: 'border-indigo-200 dark:border-indigo-500/20',
      dot: 'bg-indigo-500',
      alwaysShow: true,
      rows: [
        { key: '_bars',   label: 'Candele analizzate (LGBM attivo)',    count: ps.bars_evaluated, alwaysShow: true },
        { key: '_long',   label: 'Segnali LONG generati',  count: ps.signals_long,  pct: pct(ps.signals_long),  note: `${pct(ps.signals_long)}% delle candele`,  alwaysShow: true },
        { key: '_short',  label: 'Segnali SHORT generati', count: ps.signals_short, pct: pct(ps.signals_short), note: `${pct(ps.signals_short)}% delle candele`, alwaysShow: true },
        { key: '_notrade',label: 'No-trade (sotto soglia)', count: ps.no_trade,     pct: pct(ps.no_trade),      note: `${pct(ps.no_trade)}% delle candele`,      alwaysShow: true },
      ],
    },
    {
      title: 'Gate — Blocchi Hard (trade impediti)',
      color: 'border-rose-200 dark:border-rose-500/20',
      dot: 'bg-rose-500',
      rows: [
        { key: 'gate_adx',              label: 'ADX Gate (mercato compresso)',                count: ps.gate_adx,             pct: pct(ps.gate_adx) },
        { key: 'gate_sweep',            label: 'Liquidity Sweep Gate',                        count: ps.gate_sweep,           pct: pct(ps.gate_sweep) },
        { key: 'gate_confluence',       label: 'Confluence Gate (QT score basso)',            count: ps.gate_confluence,      pct: pct(ps.gate_confluence) },
        { key: 'gate_c2_uncertainty',   label: 'C2 Uncertainty Gate',                         count: ps.gate_c2_uncertainty,  pct: pct(ps.gate_c2_uncertainty) },
        { key: 'gate_c2_cont',          label: 'C2 Continuation Gate',                        count: ps.gate_c2_cont,         pct: pct(ps.gate_c2_cont) },
        { key: 'gate_fvg_long',         label: 'FVG Filter — bloccato LONG (bearish FVG sopra)',  count: ps.gate_fvg_long,   pct: pct(ps.gate_fvg_long) },
        { key: 'gate_fvg_short',        label: 'FVG Filter — bloccato SHORT (bullish FVG sotto)', count: ps.gate_fvg_short,  pct: pct(ps.gate_fvg_short) },
        { key: 'gate_late_entry',       label: 'Late Entry Filter (entry troppo lontana da OB)', count: ps.gate_late_entry,  pct: pct(ps.gate_late_entry) },
        { key: 'gate_path_obstruction', label: 'Path Obstruction (OB opposto blocca il percorso)', count: ps.gate_path_obstruction, pct: pct(ps.gate_path_obstruction) },
        { key: 'gate_consec_bars',      label: 'Consecutive Bars Filter (trend overextended)', count: ps.gate_consec_bars,  pct: pct(ps.gate_consec_bars) },
        { key: 'gate_atr_pct',          label: 'ATR% Volatility Gate (bassa volatilità, fee drag)', count: ps.gate_atr_pct ?? 0, pct: pct(ps.gate_atr_pct ?? 0) },
        { key: 'gate_daily_rsi',        label: 'Daily RSI Gate (RSI giornaliero estremo — capitolazione/euforia)', count: ps.gate_daily_rsi ?? 0, pct: pct(ps.gate_daily_rsi ?? 0) },
        { key: 'gate_vol_climax',       label: 'Volume Climax Gate (volume 2.5σ + RSI oversold — capitolazione)', count: ps.gate_vol_climax ?? 0, pct: pct(ps.gate_vol_climax ?? 0) },
        { key: 'gate_1h_block',         label: '1H Gate BLOCK (modello 1H disaccorda con segnale 4H)',             count: ps.gate_1h_block ?? 0,   pct: pct(ps.gate_1h_block ?? 0) },
        { key: 'gate_oi_spike',         label: 'OI Spike Gate BLOCK (crowding direzionale, oi_delta_z estremo)',   count: ps.gate_oi_spike ?? 0,   pct: pct(ps.gate_oi_spike ?? 0) },
        { key: 'gate_ls_ratio',         label: 'Long/Short Ratio Gate BLOCK (mercato over-long/over-short)',       count: ps.gate_ls_ratio ?? 0,   pct: pct(ps.gate_ls_ratio ?? 0) },
        { key: 'gate_liq_spike',        label: 'Liquidation Spike Gate BLOCK (squeeze in corso, liq_z estremo)',   count: ps.gate_liq_spike ?? 0,  pct: pct(ps.gate_liq_spike ?? 0) },
        { key: 'gate_weekend',          label: 'Weekend Gate BLOCK (sabato/domenica, mercati chiusi)',             count: ps.gate_weekend ?? 0,    pct: pct(ps.gate_weekend ?? 0) },
      ],
    },
    {
      title: 'Modificatori — Soglie & Size',
      color: 'border-amber-200 dark:border-amber-500/20',
      dot: 'bg-amber-500',
      rows: [
        { key: 'mod_mtf_alignment',      label: 'MTF Alignment (soglia abbassata per trend daily)', count: ps.mod_mtf_alignment,      pct: pct(ps.mod_mtf_alignment) },
        { key: 'mod_regime_bias',        label: 'Regime Bias (soglia alzata per trade contro-trend)', count: ps.mod_regime_bias,      pct: pct(ps.mod_regime_bias) },
        { key: 'mod_counter_trend_size', label: 'Size ridotta (trade contro-trend, regime bias)', count: ps.mod_counter_trend_size, pct: trades > 0 ? pct(ps.mod_counter_trend_size, trades) : 0, note: trades > 0 ? `${pct(ps.mod_counter_trend_size, trades)}% dei trade` : undefined },
        { key: 'mod_funding_bias',       label: 'Funding Rate Bias (soglia adattata al funding)',  count: ps.mod_funding_bias,       pct: pct(ps.mod_funding_bias) },
        { key: 'mod_fng_bias',           label: 'Fear & Greed Bias (soglia contrarian)',            count: ps.mod_fng_bias,           pct: pct(ps.mod_fng_bias) },
        { key: 'mod_transition_guard',   label: 'Transition Guard (regime in transizione, soglia alzata)',   count: ps.mod_transition_guard ?? 0, pct: pct(ps.mod_transition_guard ?? 0) },
        { key: 'mod_absorption_filter',  label: 'Absorption Filter (volume anomalo, soglia +0.03)', count: ps.mod_absorption_filter,  pct: pct(ps.mod_absorption_filter) },
        { key: 'mod_atr_pct_scale',      label: 'ATR% Scale (size ridotta per bassa volatilità)',   count: ps.mod_atr_pct_scale ?? 0, pct: pct(ps.mod_atr_pct_scale ?? 0), note: (ps.mod_atr_pct_scale ?? 0) > 0 ? `${pct(ps.mod_atr_pct_scale ?? 0)}% delle candele` : undefined },
        { key: 'mod_sweep_conf_bonus',   label: 'Sweep Confluenza direzionale (bonus -0.03)',       count: ps.mod_sweep_conf_bonus,   pct: pct(ps.mod_sweep_conf_bonus) },
        { key: 'mod_c2_inversion',       label: 'C2 Inversion Gate (C2 forecast opposto al segnale → +0.10 threshold)', count: ps.mod_c2_inversion ?? 0, pct: pct(ps.mod_c2_inversion ?? 0) },
        { key: 'mod_1h_reduce',          label: '1H Gate REDUCE ×0.70 (modello 1H incerto, size ridotta)',             count: ps.mod_1h_reduce ?? 0, pct: pct(ps.mod_1h_reduce ?? 0) },
        { key: 'mod_oi_spike_scale',     label: 'OI Spike Scale (size ridotta per crowding direzionale)',              count: ps.mod_oi_spike_scale ?? 0, pct: pct(ps.mod_oi_spike_scale ?? 0) },
        { key: 'mod_ls_ratio_scale',     label: 'Long/Short Ratio Scale (size ridotta per mercato sbilanciato)',       count: ps.mod_ls_ratio_scale ?? 0, pct: pct(ps.mod_ls_ratio_scale ?? 0) },
        { key: 'mod_liq_spike_scale',    label: 'Liquidation Spike Scale (size ridotta per spike liquidazioni)',       count: ps.mod_liq_spike_scale ?? 0, pct: pct(ps.mod_liq_spike_scale ?? 0) },
      ],
    },
    {
      title: 'Entry — Override SL/TP Strutturale',
      color: 'border-violet-200 dark:border-violet-500/20',
      dot: 'bg-violet-500',
      rows: [
        { key: 'sl_structural_ob', label: 'Structural SL da Order Block (SL dietro OB)', count: ps.sl_structural_ob, pct: trades > 0 ? pct(ps.sl_structural_ob, trades) : 0, note: trades > 0 ? `${pct(ps.sl_structural_ob, trades)}% dei trade` : undefined },
        { key: 'sl_fvg',           label: 'SL da Fair Value Gap (SL dietro FVG)',         count: ps.sl_fvg,           pct: trades > 0 ? pct(ps.sl_fvg, trades)           : 0, note: trades > 0 ? `${pct(ps.sl_fvg, trades)}% dei trade`           : undefined },
        { key: 'sl_swing',         label: 'SL da Swing High/Low strutturale',              count: ps.sl_swing,         pct: trades > 0 ? pct(ps.sl_swing, trades)         : 0, note: trades > 0 ? `${pct(ps.sl_swing, trades)}% dei trade`         : undefined },
        { key: 'tp_ob',            label: 'TP da Order Block opposto (OB come target)',   count: ps.tp_ob,            pct: trades > 0 ? pct(ps.tp_ob, trades)            : 0, note: trades > 0 ? `${pct(ps.tp_ob, trades)}% dei trade`            : undefined },
      ],
    },
    {
      title: 'Gestione Posizione (mid-trade)',
      color: 'border-emerald-200 dark:border-emerald-500/20',
      dot: 'bg-emerald-500',
      rows: [
        { key: 'pm_trailing_sl', label: 'Trailing SL attivato (high-water mark)',            count: ps.pm_trailing_sl, pct: trades > 0 ? pct(ps.pm_trailing_sl, trades) : 0, note: trades > 0 ? `${pct(ps.pm_trailing_sl, trades)}% dei trade` : undefined },
        { key: 'pm_be_sl',       label: 'Break-even SL applicato (SL a breakeven)',          count: ps.pm_be_sl,       pct: trades > 0 ? pct(ps.pm_be_sl, trades)       : 0, note: trades > 0 ? `${pct(ps.pm_be_sl, trades)}% dei trade`       : undefined },
        { key: 'pm_partial_tp',  label: 'Partial TP eseguito (50% della posizione chiusa)', count: ps.pm_partial_tp,  pct: trades > 0 ? pct(ps.pm_partial_tp, trades)  : 0, note: trades > 0 ? `${pct(ps.pm_partial_tp, trades)}% dei trade`  : undefined },
        { key: 'pm_lgbm_exit',        label: 'LGBM Exit (uscita AI per segnale invertito)',                  count: ps.pm_lgbm_exit,              pct: trades > 0 ? pct(ps.pm_lgbm_exit, trades)              : 0, note: trades > 0 ? `${pct(ps.pm_lgbm_exit, trades)}% dei trade`              : undefined },
        { key: 'pm_adverse_monitor',  label: 'Adverse Monitor (evidenza strutturale contro la posizione)', count: ps.pm_adverse_monitor ?? 0,   pct: trades > 0 ? pct(ps.pm_adverse_monitor ?? 0, trades)   : 0, note: trades > 0 ? `${pct(ps.pm_adverse_monitor ?? 0, trades)}% dei trade`   : undefined },
        { key: 'pm_max_hold',         label: 'Max Hold (uscita temporale forzata)',                    count: ps.pm_max_hold,           pct: trades > 0 ? pct(ps.pm_max_hold, trades)          : 0, note: trades > 0 ? `${pct(ps.pm_max_hold, trades)}% dei trade`          : undefined },
      ],
    },
    {
      title: 'Uscite Trade',
      color: 'border-slate-200 dark:border-slate-500/20',
      dot: 'bg-slate-400',
      alwaysShow: true,
      rows: [
        { key: '_sl',  label: 'Stop Loss colpito',              count: ps.exit_stop_loss,    pct: trades > 0 ? pct(ps.exit_stop_loss, trades)    : 0, note: trades > 0 ? `${pct(ps.exit_stop_loss, trades)}% dei trade`    : undefined, alwaysShow: true },
        { key: '_tp',  label: 'Take Profit raggiunto',          count: ps.exit_take_profit,  pct: trades > 0 ? pct(ps.exit_take_profit, trades)  : 0, note: trades > 0 ? `${pct(ps.exit_take_profit, trades)}% dei trade`  : undefined, alwaysShow: true },
        { key: '_eop', label: 'Fine periodo (posizione aperta)', count: ps.exit_end_of_period,pct: trades > 0 ? pct(ps.exit_end_of_period, trades): 0, alwaysShow: true },
      ],
    },
    // Pullback: shown only when enabled (pb_activated in param_config) or when it actually fired
    ...((isOn('pb_activated') || (ps.pb_activated ?? 0) > 0) ? [{
      title: 'Pullback Entry',
      color: 'border-cyan-200 dark:border-cyan-500/20',
      dot: 'bg-cyan-500',
      rows: [
        { key: 'pb_activated',     label: 'Impulso ≥ soglia (segnali in modalità pullback)', count: ps.pb_activated ?? 0,     pct: trades > 0 ? pct(ps.pb_activated ?? 0, trades) : 0, note: trades > 0 ? `${pct(ps.pb_activated ?? 0, trades)}% dei trade` : undefined },
        { key: 'pb_filled_zone',   label: 'Fill di zona (pullback raggiunto prima del timeout)', count: ps.pb_filled_zone ?? 0,   pct: (ps.pb_activated ?? 0) > 0 ? pct(ps.pb_filled_zone ?? 0, ps.pb_activated!) : 0, note: (ps.pb_activated ?? 0) > 0 ? `${pct(ps.pb_filled_zone ?? 0, ps.pb_activated!)}% delle attivazioni` : undefined },
        { key: 'pb_filled_fallback',label: 'Fill fallback (timeout, prezzo ancora vicino)',    count: ps.pb_filled_fallback ?? 0,pct: (ps.pb_activated ?? 0) > 0 ? pct(ps.pb_filled_fallback ?? 0, ps.pb_activated!) : 0, note: (ps.pb_activated ?? 0) > 0 ? `${pct(ps.pb_filled_fallback ?? 0, ps.pb_activated!)}% delle attivazioni` : undefined },
        { key: 'pb_decayed',       label: 'Segnale decaduto (prezzo fuori range o timeout)',   count: ps.pb_decayed ?? 0,       pct: (ps.pb_activated ?? 0) > 0 ? pct(ps.pb_decayed ?? 0, ps.pb_activated!) : 0, note: (ps.pb_activated ?? 0) > 0 ? `${pct(ps.pb_decayed ?? 0, ps.pb_activated!)}% delle attivazioni` : undefined },
      ],
    }] : []),
    // Bounce-Fade: shown when enabled or when it actually fired
    ...((isOn('bf_created') || (ps.bf_created ?? 0) > 0) ? [{
      title: 'Bounce-Fade Entry',
      color: 'border-rose-200 dark:border-rose-500/20',
      dot: 'bg-rose-500',
      rows: [
        { key: 'bf_created',        label: 'Pending creati (segnali controtendenza)',           count: ps.bf_created ?? 0,        pct: trades > 0 ? pct(ps.bf_created ?? 0, trades) : 0, note: trades > 0 ? `${pct(ps.bf_created ?? 0, trades)}% dei trade` : undefined },
        { key: 'bf_filled_limit',   label: 'Fill al limite (entry migliore, SL stretto)',       count: ps.bf_filled_limit ?? 0,   pct: (ps.bf_created ?? 0) > 0 ? pct(ps.bf_filled_limit ?? 0, ps.bf_created!) : 0, note: (ps.bf_created ?? 0) > 0 ? `${pct(ps.bf_filled_limit ?? 0, ps.bf_created!)}% dei pending` : undefined },
        { key: 'bf_market_fallback',label: 'Fallback a mercato (segnale persistente)',          count: ps.bf_market_fallback ?? 0,pct: (ps.bf_created ?? 0) > 0 ? pct(ps.bf_market_fallback ?? 0, ps.bf_created!) : 0, note: (ps.bf_created ?? 0) > 0 ? `${pct(ps.bf_market_fallback ?? 0, ps.bf_created!)}% dei pending` : undefined },
        { key: 'bf_abandoned',      label: 'Annullati (R:R sotto soglia o no fallback)',        count: ps.bf_abandoned ?? 0,      pct: (ps.bf_created ?? 0) > 0 ? pct(ps.bf_abandoned ?? 0, ps.bf_created!) : 0, note: (ps.bf_created ?? 0) > 0 ? `${pct(ps.bf_abandoned ?? 0, ps.bf_created!)}% dei pending` : undefined },
      ],
    }] : []),
    // Reversal: shown when enabled OR when conflict blocks fired (guard_only case: rev_signals=0 but conflict_block>0)
    ...((isOn('rev_signals') || isOn('rev_conflict_block') || (ps.rev_signals ?? 0) > 0 || (ps.rev_conflict_block ?? 0) > 0) ? [{
      title: 'Reversal Zone Detector',
      color: 'border-violet-200 dark:border-violet-500/20',
      dot: 'bg-violet-500',
      rows: [
        { key: 'rev_guard_triggered', alwaysShow: true, label: 'Guard — attivazioni totali (score ≥ soglia, qualsiasi modalità)', count: ps.rev_guard_triggered ?? 0, pct: ps.bars_evaluated > 0 ? pct(ps.rev_guard_triggered ?? 0, ps.bars_evaluated) : 0, note: ps.bars_evaluated > 0 ? `${pct(ps.rev_guard_triggered ?? 0, ps.bars_evaluated)}% delle barre` : undefined },
        { key: 'rev_signals',       alwaysShow: true, label: 'Trade reversal aperti (guard_only=OFF, score ≥ soglia)', count: ps.rev_signals ?? 0, pct: (ps.rev_guard_triggered ?? 0) > 0 ? pct(ps.rev_signals ?? 0, ps.rev_guard_triggered!) : 0, note: (ps.rev_guard_triggered ?? 0) > 0 ? `${pct(ps.rev_signals ?? 0, ps.rev_guard_triggered!)}% delle attivazioni` : undefined },
        { key: 'rev_conflict_block', alwaysShow: true, label: 'Trade trend bloccati dal Guard (direzione opposta al trend)', count: ps.rev_conflict_block ?? 0, pct: (ps.rev_guard_triggered ?? 0) > 0 ? pct(ps.rev_conflict_block ?? 0, ps.rev_guard_triggered!) : 0, note: (ps.rev_guard_triggered ?? 0) > 0 ? `${pct(ps.rev_conflict_block ?? 0, ps.rev_guard_triggered!)}% delle attivazioni` : undefined },
        ...((ps.rev_pending_set ?? 0) > 0 || isOn('rev_pending_set') ? [
          { key: 'rev_pending_set',      label: 'Pending creati (limit-retest mode)',                              count: ps.rev_pending_set ?? 0,      pct: (ps.rev_signals ?? 0) > 0 ? pct(ps.rev_pending_set ?? 0, ps.rev_signals!) : 0,      note: (ps.rev_signals ?? 0) > 0 ? `${pct(ps.rev_pending_set ?? 0, ps.rev_signals!)}% dei segnali` : undefined },
          { key: 'rev_pending_triggered',label: 'Pending triggerati (retest raggiunto → trade aperto)',            count: ps.rev_pending_triggered ?? 0, pct: (ps.rev_pending_set ?? 0) > 0 ? pct(ps.rev_pending_triggered ?? 0, ps.rev_pending_set!) : 0, note: (ps.rev_pending_set ?? 0) > 0 ? `${pct(ps.rev_pending_triggered ?? 0, ps.rev_pending_set!)}% dei pending` : undefined },
          { key: 'rev_pending_expired',  label: 'Pending scaduti (retest non raggiunto nel periodo)',              count: ps.rev_pending_expired ?? 0,   pct: (ps.rev_pending_set ?? 0) > 0 ? pct(ps.rev_pending_expired ?? 0, ps.rev_pending_set!) : 0,  note: (ps.rev_pending_set ?? 0) > 0 ? `${pct(ps.rev_pending_expired ?? 0, ps.rev_pending_set!)}% dei pending` : undefined },
        ] : []),
      ],
    }] : []),
    // Re-entry on TP: shown when enabled OR when at least one re-entry fired
    ...((isOn('reentry_triggered') || isOn('reentry_blocked_lgbm') || (ps.reentry_triggered ?? 0) > 0 || (ps.reentry_blocked_lgbm ?? 0) > 0 || (ps.reentry_blocked_1h ?? 0) > 0) ? [{
      title: 'Re-entry on TP',
      color: 'border-emerald-200 dark:border-emerald-500/20',
      dot: 'bg-emerald-500',
      rows: [
        { key: 'reentry_triggered',    alwaysShow: true, label: 'Re-entry aperti (TP colpito → stesso lato riaperto)', count: ps.reentry_triggered ?? 0,    pct: ps.exit_take_profit > 0 ? pct(ps.reentry_triggered ?? 0, ps.exit_take_profit) : 0, note: ps.exit_take_profit > 0 ? `${pct(ps.reentry_triggered ?? 0, ps.exit_take_profit)}% dei TP` : undefined },
        { key: 'reentry_wins',         alwaysShow: true, label: `Chiusi in profitto${reentryWinRate !== null ? ` — win rate ${reentryWinRate}%` : ''}`, count: reentryWins,   pct: reentryClosings.length > 0 ? pct(reentryWins,   reentryClosings.length) : 0, note: reentryClosings.length > 0 ? `${pct(reentryWins, reentryClosings.length)}% dei re-entry` : undefined },
        { key: 'reentry_losses',       alwaysShow: true, label: 'Chiusi in perdita',                                   count: reentryLosses, pct: reentryClosings.length > 0 ? pct(reentryLosses, reentryClosings.length) : 0, note: reentryClosings.length > 0 ? `${pct(reentryLosses, reentryClosings.length)}% dei re-entry` : undefined },
        { key: 'reentry_blocked_lgbm', alwaysShow: true, label: 'Bloccati — LGBM 4H sotto soglia (trend indebolito)',  count: ps.reentry_blocked_lgbm ?? 0, pct: (ps.reentry_triggered ?? 0) + (ps.reentry_blocked_lgbm ?? 0) + (ps.reentry_blocked_1h ?? 0) > 0 ? pct(ps.reentry_blocked_lgbm ?? 0, (ps.reentry_triggered ?? 0) + (ps.reentry_blocked_lgbm ?? 0) + (ps.reentry_blocked_1h ?? 0)) : 0, note: undefined },
        { key: 'reentry_blocked_1h',   alwaysShow: true, label: 'Bloccati — Gate 1H sotto soglia (momentum 1H debole)', count: ps.reentry_blocked_1h ?? 0,   pct: (ps.reentry_triggered ?? 0) + (ps.reentry_blocked_lgbm ?? 0) + (ps.reentry_blocked_1h ?? 0) > 0 ? pct(ps.reentry_blocked_1h ?? 0, (ps.reentry_triggered ?? 0) + (ps.reentry_blocked_lgbm ?? 0) + (ps.reentry_blocked_1h ?? 0)) : 0, note: undefined },
      ],
    }] : []),
    // Exhaustion Guard: dedicated section shown when guard is enabled OR when it fired at least once
    ...((isOn('mod_exhaustion_guard') || exhTotal > 0) ? [{
      title: 'Exhaustion Guard',
      color: 'border-orange-200 dark:border-orange-500/20',
      dot: 'bg-orange-500',
      alwaysShow: true,
      rows: [
        {
          key: 'exh_total', alwaysShow: true,
          label: `Attivazioni totali — condizioni RSI/ret_48 rilevate (su ${ps.bars_evaluated.toLocaleString()} candele)`,
          count: exhTotal,
          pct: pct(exhTotal),
          note: exhTotal > 0 ? `${pct(exhTotal)}% delle candele` : undefined,
        },
        {
          key: 'exh_trigger_rsi_only', alwaysShow: true,
          label: 'Motivo: solo RSI (RSI fuori soglia, ret_48 neutro)',
          count: ps.exh_trigger_rsi_only ?? 0,
          pct: exhTotal > 0 ? pct(ps.exh_trigger_rsi_only ?? 0, exhTotal) : 0,
          note: exhTotal > 0 ? `${pct(ps.exh_trigger_rsi_only ?? 0, exhTotal)}% delle attivazioni` : undefined,
        },
        {
          key: 'exh_trigger_ret48_only', alwaysShow: true,
          label: 'Motivo: solo ret_48 (return 48 barre 4H ≈ 8 giorni fuori range, RSI neutro)',
          count: ps.exh_trigger_ret48_only ?? 0,
          pct: exhTotal > 0 ? pct(ps.exh_trigger_ret48_only ?? 0, exhTotal) : 0,
          note: exhTotal > 0 ? `${pct(ps.exh_trigger_ret48_only ?? 0, exhTotal)}% delle attivazioni` : undefined,
        },
        {
          key: 'exh_trigger_both', alwaysShow: true,
          label: 'Motivo: RSI + ret_48 (doppia condizione — massima cautela)',
          count: ps.exh_trigger_both ?? 0,
          pct: exhTotal > 0 ? pct(ps.exh_trigger_both ?? 0, exhTotal) : 0,
          note: exhTotal > 0 ? `${pct(ps.exh_trigger_both ?? 0, exhTotal)}% delle attivazioni` : undefined,
        },
        {
          key: 'exh_guard_passed', alwaysShow: true,
          label: `Trade aperti nonostante il guard sulla loro direzione (threshold superato comunque)${exhTotal > 0 ? ` — ${pct(exhPassed, exhTotal)}% delle attivazioni passate` : ''}`,
          count: exhPassed,
          pct: exhTotal > 0 ? pct(exhPassed, exhTotal) : 0,
          note: exhPassed > 0 && trades > 0 ? `${pct(exhPassed, trades)}% dei trade totali` : undefined,
        },
        {
          key: 'exh_guard_blocked', alwaysShow: true,
          label: 'Barre con guard attivo ma nessun trade aperto (threshold non superato o altro gate)',
          count: exhBlocked,
          pct: exhTotal > 0 ? pct(exhBlocked, exhTotal) : 0,
          note: exhTotal > 0 ? `${pct(exhBlocked, exhTotal)}% delle attivazioni` : undefined,
        },
        {
          key: 'exh_guard_decisive', alwaysShow: true,
          label: 'Bloccati DAL guard — il segnale superava la soglia base, solo il boost lo ha fermato (counterfactual)',
          count: ps.exh_guard_decisive ?? 0,
          pct: exhTotal > 0 ? pct(ps.exh_guard_decisive ?? 0, exhTotal) : 0,
          note: exhTotal > 0 ? `${pct(ps.exh_guard_decisive ?? 0, exhTotal)}% delle attivazioni` : undefined,
        },
        {
          key: 'exh_passed_wins', alwaysShow: true,
          label: `Vincenti (trade aperti durante guard${exhWinRate !== null ? ` — win rate ${exhWinRate}%` : ''})`,
          count: exhPassedWins,
          pct: exhPassedClosed > 0 ? pct(exhPassedWins, exhPassedClosed) : 0,
          note: exhPassedClosed > 0 ? `${pct(exhPassedWins, exhPassedClosed)}% dei trade passati` : undefined,
        },
        {
          key: 'exh_passed_losses', alwaysShow: true,
          label: 'Perdenti (trade aperti durante guard)',
          count: exhPassedLosses,
          pct: exhPassedClosed > 0 ? pct(exhPassedLosses, exhPassedClosed) : 0,
          note: exhPassedClosed > 0 ? `${pct(exhPassedLosses, exhPassedClosed)}% dei trade passati` : undefined,
        },
        ...((isOn('mod_exhaustion_prop') || (ps.mod_exhaustion_prop ?? 0) > 0) ? [{
          key: 'exh_prop', alwaysShow: true,
          label: 'Boost proporzionale applicato (ret_48 estremo → bonus boost su threshold)',
          count: ps.mod_exhaustion_prop ?? 0,
          pct: exhTotal > 0 ? pct(ps.mod_exhaustion_prop ?? 0, exhTotal) : 0,
          note: exhTotal > 0 ? `${pct(ps.mod_exhaustion_prop ?? 0, exhTotal)}% delle attivazioni` : undefined,
        }] : []),
        ...((isOn('pm_exhaust_max_hold') || (ps.pm_exhaust_max_hold ?? 0) > 0) ? [{
          key: 'pm_exhaust_max_hold', alwaysShow: true,
          label: 'Chiusi anticipatamente — Exhaust Max Hold (entry in esaurimento → uscita forzata)',
          count: ps.pm_exhaust_max_hold ?? 0,
          pct: exhPassed > 0 ? pct(ps.pm_exhaust_max_hold ?? 0, exhPassed) : 0,
          note: exhPassed > 0 ? `${pct(ps.pm_exhaust_max_hold ?? 0, exhPassed)}% dei trade passati` : undefined,
        }] : []),
      ],
    }] : []),
  ];

  return (
    <div className="elegant-card bg-white dark:bg-[#151E32] overflow-hidden">
      <div className="px-6 py-4 border-b border-slate-100 dark:border-white/5 bg-slate-50/50 dark:bg-white/[0.02]">
        <h3 className="text-[10px] font-bold text-slate-400 dark:text-slate-500 uppercase tracking-widest flex items-center gap-2">
          <span className="w-1 h-3 bg-slate-400 dark:bg-slate-500 rounded-full" />
          Attività Parametri — {ps.bars_evaluated.toLocaleString()} candele analizzate
        </h3>
        <p className="text-[10px] text-slate-400 dark:text-slate-500 mt-1">
          Mostra solo i parametri attivi nelle impostazioni di questo backtest. <strong className="text-slate-500 dark:text-slate-400">Contatore 0</strong> = attivo ma mai scattato nel periodo — valuta se disabilitarlo.
        </p>
      </div>
      <div className="p-6 space-y-5">
        {/* ── Dati & Sorgenti: feature senza counter runtime ─────────────── */}
        {cfg && (() => {
          // Sorgenti dati attive: non hanno un counter ma vanno sempre mostrate
          // quando presenti in param_config. Aggiungere qui ogni nuovo toggle dati.
          const dataSources: { key: string; label: string; detail: string }[] = [
            {
              key:    'data_binance_cvd',
              label:  'Binance Cross-Exchange CVD',
              detail: 'taker_buy_vol → 3 feature LightGBM (binance_cvd_slope · binance_absorption_z · cross_cvd_div)',
            },
            // ── AGGIUNGI QUI FUTURE SORGENTI DATI ──────────────────────────────
            // { key: 'data_deribit_iv', label: 'Deribit IV (Options)', detail: '...' },
          ];
          const active = dataSources.filter(s => cfg[s.key] === true);
          const inactive = dataSources.filter(s => cfg[s.key] === false);
          if (active.length === 0 && inactive.length === 0) return null;
          return (
            <div className="rounded-xl border border-sky-200 dark:border-sky-500/20 overflow-hidden">
              <div className="px-4 py-2.5 bg-slate-50/50 dark:bg-white/[0.02] flex items-center justify-between border-b border-slate-100 dark:border-white/5">
                <div className="flex items-center gap-2">
                  <span className="w-1.5 h-1.5 rounded-full bg-sky-500" />
                  <span className="text-[10px] font-bold text-slate-600 dark:text-slate-300 uppercase tracking-widest">Dati & Sorgenti Esterne</span>
                </div>
                <span className="text-[9px] font-medium text-slate-400 dark:text-slate-500">
                  {active.length} attiv{active.length === 1 ? 'a' : 'e'} su {dataSources.length}
                </span>
              </div>
              <div className="divide-y divide-slate-50 dark:divide-white/[0.03]">
                {active.map(s => (
                  <div key={s.key} className="flex items-center gap-3 px-4 py-2.5">
                    <div className="flex-1 min-w-0">
                      <span className="text-[11px] font-medium text-slate-700 dark:text-slate-200">{s.label}</span>
                      <span className="ml-2 text-[9px] text-slate-400 dark:text-slate-500">{s.detail}</span>
                    </div>
                    <span className="text-[9px] font-bold px-2 py-0.5 rounded-full bg-sky-100 dark:bg-sky-500/15 text-sky-600 dark:text-sky-400 flex-shrink-0">ATTIVO</span>
                  </div>
                ))}
                {inactive.length > 0 && (
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2 bg-slate-50/30 dark:bg-transparent">
                    <span className="text-[8px] font-bold text-slate-300 dark:text-slate-600 uppercase tracking-widest shrink-0">Non usati:</span>
                    {inactive.map(s => (
                      <span key={s.key} className="text-[9px] text-slate-300 dark:text-slate-600">{s.label}</span>
                    ))}
                  </div>
                )}
              </div>
            </div>
          );
        })()}

        {/* ── Gruppi con counter ─────────────────────────────────────────── */}
        {groups.map(g => {
          // Filter rows: always-show rows are always included; others only if enabled in param_config
          const visibleRows = g.rows.filter(r => r.alwaysShow || g.alwaysShow || isOn(r.key));
          // Skip entire group if no visible rows (all features disabled)
          if (visibleRows.length === 0) return null;

          const firedRows   = visibleRows.filter(r => r.count > 0);
          const unfiledRows = visibleRows.filter(r => r.count === 0);

          return (
            <div key={g.title} className={`rounded-xl border ${g.color} overflow-hidden`}>
              {/* Group header */}
              <div className="px-4 py-2.5 bg-slate-50/50 dark:bg-white/[0.02] flex items-center justify-between border-b border-slate-100 dark:border-white/5">
                <div className="flex items-center gap-2">
                  <span className={`w-1.5 h-1.5 rounded-full ${g.dot}`} />
                  <span className="text-[10px] font-bold text-slate-600 dark:text-slate-300 uppercase tracking-widest">{g.title}</span>
                </div>
                <span className="text-[9px] font-medium text-slate-400 dark:text-slate-500">
                  {visibleRows.length} parametr{visibleRows.length === 1 ? 'o' : 'i'} attivi
                </span>
              </div>
              <div className="divide-y divide-slate-50 dark:divide-white/[0.03]">
                {/* Fired rows — with bar and count */}
                {firedRows.map(r => (
                  <div key={r.key} className="flex items-center gap-3 px-4 py-2.5">
                    <div className="flex-1 min-w-0">
                      <span className="text-[11px] font-medium text-slate-700 dark:text-slate-200 leading-tight">{r.label}</span>
                      {r.note && <span className="ml-2 text-[9px] text-slate-400 dark:text-slate-500">{r.note}</span>}
                    </div>
                    <div className="flex items-center gap-2.5 flex-shrink-0">
                      {r.pct !== undefined && r.pct > 0 && (
                        <div className="w-20 h-1.5 rounded-full bg-slate-100 dark:bg-white/5 overflow-hidden">
                          <div
                            className={`h-full rounded-full ${g.dot}`}
                            style={{ width: `${Math.min(100, r.pct)}%`, opacity: 0.65 }}
                          />
                        </div>
                      )}
                      <span className="text-[12px] font-bold text-slate-800 dark:text-slate-100 tabular-nums min-w-[2.5rem] text-right">
                        {r.count.toLocaleString()}
                      </span>
                    </div>
                  </div>
                ))}
                {/* Unfired rows — compact, dim, with "mai scattato" badge */}
                {unfiledRows.length > 0 && (
                  <div className="px-4 py-2.5 flex flex-wrap items-center gap-x-3 gap-y-1.5 bg-slate-50/30 dark:bg-white/[0.01]">
                    <span className="text-[8px] font-bold text-slate-300 dark:text-slate-600 uppercase tracking-widest shrink-0">Mai scattato:</span>
                    {unfiledRows.map(r => (
                      <span key={r.key} className="text-[9px] text-slate-400 dark:text-slate-500 flex items-center gap-1">
                        <span className={`w-1 h-1 rounded-full ${g.dot} opacity-40 inline-block`} />
                        {r.label}
                      </span>
                    ))}
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>
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
      {/* Parameter Activity Report */}
      {result.param_stats && <ParamActivity ps={result.param_stats} cfg={result.param_config} trades={result.trades} />}
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
  const [clearingAll, setClearingAll] = useState(false);

  const fetchHistory = useCallback(async () => {
    setLoading(true);
    try {
      const res = await apiFetch(`${apiBase}/backtest-history`);
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
        const res  = await apiFetch(`${apiBase}/backtest-history/${itemId}`);
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
      await apiFetch(`${apiBase}/backtest-history/${id}`, { method: 'DELETE' });
      setItems(prev => prev.filter(item => item.id !== id));
      if (expandedId === id) setExpandedId(null);
    } finally {
      setDeletingId(null);
    }
  };

  const handleClearAll = async () => {
    if (!confirm('Svuotare l\'intero archivio? Tutti i report verranno eliminati definitivamente.')) return;
    setClearingAll(true);
    try {
      await apiFetch(`${apiBase}/backtest-history`, { method: 'DELETE' });
      setItems([]);
      setExpandedId(null);
    } finally {
      setClearingAll(false);
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
      await apiFetch(`${apiBase}/backtest-history/${id}`, {
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
        <div className="flex items-center gap-2">
          {items.length > 0 && (
            <button
              onClick={handleClearAll}
              disabled={clearingAll}
              className="flex items-center gap-2 px-4 py-2 text-[10px] font-bold uppercase tracking-widest bg-white dark:bg-white/5 hover:bg-rose-50 dark:hover:bg-rose-500/10 border border-slate-100 dark:border-white/10 hover:border-rose-200 dark:hover:border-rose-500/30 rounded-xl text-slate-500 dark:text-slate-400 hover:text-rose-600 dark:hover:text-rose-400 transition-all shadow-sm active:scale-95 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                <path strokeLinecap="round" strokeLinejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
              </svg>
              {clearingAll ? 'Pulizia…' : 'Svuota Archivio'}
            </button>
          )}
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
type RegimeKey = 'uptrend' | 'downtrend' | 'sideways' | 'flat' | 'stress';

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
  stress: {
    label: 'Stress Test', icon: '⚡',
    dot: 'bg-orange-500', bg: 'bg-orange-50 dark:bg-orange-500/10',
    border: 'border-orange-200 dark:border-orange-500/30',
    text: 'text-orange-700 dark:text-orange-400',
    dropBg: 'bg-white dark:bg-[#151E32]',
    hoverBg: 'hover:bg-orange-50 dark:hover:bg-orange-500/10',
    activeBg: 'bg-orange-50 dark:bg-orange-500/10',
    activeBorder: 'border-orange-400 dark:border-orange-500',
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
    { id: 'D4', shortLabel: 'D4 · Nov→Dic 2022 ⚠', fullLabel: '1 Nov – 10 Dic 2022', from: '2022-11-01', to: '2022-12-10', change: '-26%', duration: '5.5 settimane', range: '$21k → $15.5k → $17k', isRef: false },
    { id: 'D5', shortLabel: 'D5 · Ago→Set 2023', fullLabel: '1 Ago – 11 Set 2023', from: '2023-08-01', to: '2023-09-11', change: '-14%', duration: '5.5 settimane', range: '$29.5k → $25k', isRef: false },
    { id: 'D6', shortLabel: 'D6 · Giu→Ago 2024 ⚠', fullLabel: '5 Giu – 5 Ago 2024', from: '2024-06-05', to: '2024-08-05', change: '-32%', duration: '9 settimane', range: '$72k → $49k', isRef: false },
    { id: 'D7', shortLabel: 'D7 · Feb→Apr 2025', fullLabel: '1 Feb – 7 Apr 2025', from: '2025-02-01', to: '2025-04-07', change: '-28%', duration: '9 settimane', range: '$103k → $74k', isRef: false },
    { id: 'D8', shortLabel: 'D8 · Ott→Nov 2025', fullLabel: '20 Ott – 28 Nov 2025', from: '2025-10-20', to: '2025-11-28', change: '-27%', duration: '5.5 settimane', range: '$110k → $80k', isRef: false },
    { id: 'D9', shortLabel: 'D9 · Gen→Feb 2026', fullLabel: '8 Gen – 14 Feb 2026', from: '2026-01-08', to: '2026-02-14', change: '-38%', duration: '5.5 settimane', range: '$97k → $60k', isRef: false },
  ],
  sideways: [
    { id: 'S1', shortLabel: 'S1 · Giu→Lug 2021', fullLabel: '22 Giu – 20 Lug 2021', from: '2021-06-22', to: '2021-07-20', change: '±24%', duration: '4 settimane', range: '$29k – $36k', isRef: false },
    { id: 'S2', shortLabel: 'S2 · Set→Ott 2021', fullLabel: '1 Set – 10 Ott 2021', from: '2021-09-01', to: '2021-10-10', change: '±24%', duration: '5.5 settimane', range: '$43k – $52k', isRef: false },
    { id: 'S3', shortLabel: 'S3 · Feb→Apr 2022', fullLabel: '16 Feb – 4 Apr 2022', from: '2022-02-16', to: '2022-04-04', change: '±21%', duration: '7 settimane', range: '$37k – $45k', isRef: false },
    { id: 'S4', shortLabel: 'S4 · Lug→Ago 2022', fullLabel: '14 Lug – 17 Ago 2022', from: '2022-07-14', to: '2022-08-17', change: '±16%', duration: '4.9 settimane', range: '$20k – $25k', isRef: false },
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
    { id: 'F3', shortLabel: 'F3 · Post-Halving Apr→Mag 2024', fullLabel: '20 Apr – 20 Mag 2024', from: '2024-04-20', to: '2024-05-20', change: '±9%', duration: '4.4 settimane', range: '$57k – $68k', isRef: false },
    { id: 'F4', shortLabel: 'F4 · Giu→Lug 2024', fullLabel: '10 Giu – 15 Lug 2024', from: '2024-06-10', to: '2024-07-15', change: '±13%', duration: '5 settimane', range: '$60k – $68k', isRef: false },
    { id: 'F5', shortLabel: 'F5 · Mag 2026', fullLabel: '1 – 31 Mag 2026', from: '2026-05-01', to: '2026-05-31', change: '±8.5%', duration: '4.4 settimane', range: '$76k – $83k', isRef: false },
  ],
  stress: [
    { id: 'ST1', shortLabel: 'ST1 · COVID Crash Feb→Apr 2020', fullLabel: '15 Feb – 30 Apr 2020', from: '2020-02-15', to: '2020-04-30', change: '-63% → +137%', duration: '10.5 settimane', range: '$10.2k → $3.8k → $9k', isRef: true },
    { id: 'ST2', shortLabel: 'ST2 · Bear Cap Nov 2018→Feb 2019', fullLabel: '1 Nov 2018 – 28 Feb 2019', from: '2018-11-01', to: '2019-02-28', change: '-49%', duration: '17 settimane', range: '$6.3k → $3.2k', isRef: false },
    { id: 'ST3', shortLabel: 'ST3 · ETF Sell-the-News Gen 2024', fullLabel: '8 Gen – 29 Feb 2024', from: '2024-01-08', to: '2024-02-29', change: '-18% → +65%', duration: '7.5 settimane', range: '$46k → $38k → $63k', isRef: false },
    { id: 'ST4', shortLabel: 'ST4 · Black Monday Lug→Set 2024', fullLabel: '29 Lug – 7 Set 2024', from: '2024-07-29', to: '2024-09-07', change: '-28% → +18%', duration: '5.5 settimane', range: '$68k → $49k → $57k', isRef: false },
    { id: 'ST5', shortLabel: 'ST5 · Bull→Bear 2019', fullLabel: '26 Giu – 25 Nov 2019', from: '2019-06-26', to: '2019-11-25', change: '-53%', duration: '22 settimane', range: '$13.8k → $6.5k', isRef: false },
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
        const res = await apiFetch(`${apiBase}/presets`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: trimmed, params }),
        });
        if (!res.ok) throw new Error(await res.text());
      } else {
        const res = await apiFetch(`${apiBase}/presets/${preset!.id}`, {
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
      await apiFetch(`${apiBase}/presets/${preset.id}`, { method: 'DELETE' });
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
  const [exhaustionRsiLow,   setExhaustionRsiLow]   = useState('28');
  const [exhaustionRsiHigh,  setExhaustionRsiHigh]  = useState('72');
  const [exhaustionRet48,    setExhaustionRet48]    = useState('6.0');
  const [exhaustionBoost,    setExhaustionBoost]    = useState('0.06');
  // Feature A: Exhaustion Guard proporzionale
  const [exhaustionProp,       setExhaustionProp]       = useState(false);
  const [exhaustionPropScale,  setExhaustionPropScale]  = useState('0.06');
  // Feature B: Daily RSI Gate
  const [dailyRsiGate,         setDailyRsiGate]         = useState(false);
  const [dailyRsiShortBlock,   setDailyRsiShortBlock]   = useState('18');
  const [dailyRsiLongBlock,    setDailyRsiLongBlock]    = useState('82');
  // Feature C: Volume Climax Gate
  const [volClimaxGate,        setVolClimaxGate]        = useState(false);
  const [volClimaxZ,           setVolClimaxZ]           = useState('2.5');
  const [volClimaxRsi,         setVolClimaxRsi]         = useState('30');
  // Feature D: C2 Inversion Gate
  const [c2InversionGate,      setC2InversionGate]      = useState(false);
  const [c2InversionPct,       setC2InversionPct]       = useState('0.005');
  // Feature E: Exhaustion Max Hold
  const [exhaustionMaxHold,    setExhaustionMaxHold]    = useState(false);
  const [exhaustionMaxHoldBars,setExhaustionMaxHoldBars]= useState('2');
  const [transitionGuard,      setTransitionGuard]      = useState(false);
  const [transitionBoostMax,   setTransitionBoostMax]   = useState('0.05');
  const [transitionRiskMin,    setTransitionRiskMin]    = useState('0.55');
  const [structuralSl,         setStructuralSl]         = useState(false);
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
  const [regimeBiasEnhanced,  setRegimeBiasEnhanced]  = useState(false);
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
  // Binance Cross-Exchange CVD
  const [binanceCvd, setBinanceCvd] = useState(false);
  // Pullback Entry
  const [pullbackEnabled,       setPullbackEnabled]       = useState(false);
  const [pullbackImpulseAtr,    setPullbackImpulseAtr]    = useState('1.2');
  const [pullbackZoneAtr,       setPullbackZoneAtr]       = useState('0.3');
  const [pullbackWindowH,       setPullbackWindowH]       = useState('3');
  const [pullbackFallbackAtr,   setPullbackFallbackAtr]   = useState('0.5');
  // Bounce-Fade Entry
  const [bounceFadeEnabled,     setBounceFadeEnabled]     = useState(false);
  const [bounceFadeCounterOnly, setBounceFadeCounterOnly] = useState(true);
  const [bounceFadePenetration, setBounceFadePenetration] = useState('50');  // shown as %
  const [bounceFadeOffsetAtr,   setBounceFadeOffsetAtr]   = useState('0.5');
  const [bounceFadeWindow,      setBounceFadeWindow]      = useState('2');
  const [bounceFadeFallback,    setBounceFadeFallback]    = useState(true);
  const [bounceFadeMinRr,       setBounceFadeMinRr]       = useState('1.5');
  const [bounceFadeSlBuffer,    setBounceFadeSlBuffer]    = useState('0.3');
  const [bounceFadeSlMin,       setBounceFadeSlMin]       = useState('0.8');
  // Reversal Zone Detector
  const [reversalEnabled,       setReversalEnabled]       = useState(false);
  const [reversalScoreThresh,   setReversalScoreThresh]   = useState('0.34');   // recal on BTC 4H 3y (2023-26): P99=0.40, max=0.53; 0.38 fired only 1.0% of bars
  const [reversalMinComponents, setReversalMinComponents] = useState('3');      // was 4; only 2% of bars ever reach 4 active components
  const [reversalSizeFactor,    setReversalSizeFactor]    = useState('0.50');   // conservative until validated
  const [reversalSlAtr,         setReversalSlAtr]         = useState('1.2');
  const [reversalTpAtr,         setReversalTpAtr]         = useState('2.0');    // 2.0×ATR achievable in 2-3 bars
  const [reversalRrMin,         setReversalRrMin]         = useState('1.5');    // wick_pct=0.25 gives avg R:R 1.88
  const [reversalMaxHold,       setReversalMaxHold]       = useState('4');      // BTC reversal: resolve <16h
  const [reversalEntryMode,     setReversalEntryMode]     = useState<'limit_retest' | 'close'>('close');  // 'close' for backtest diagnosability; switch to limit_retest after validating signals
  const [reversalRetestWickPct, setReversalRetestWickPct] = useState('0.25');   // R:R 1.88 avg (vs 1.49 at 0.50)
  const [reversalExpiry,        setReversalExpiry]        = useState('3');      // 12h window instead of 8h
  const [reversalConflictBlock,  setReversalConflictBlock]  = useState(true);
  const [reversalTrendHoldOnly,  setReversalTrendHoldOnly]  = useState(true);
  const [reversalGuardOnly,      setReversalGuardOnly]      = useState(false);
  const [reversalAdxPeakMin,    setReversalAdxPeakMin]    = useState('30');
  // Re-entry on TP
  const [reentryEnabled,         setReentryEnabled]         = useState(false);
  const [reentryMinLgbm,         setReentryMinLgbm]         = useState('68');   // shown as %
  const [reentry1hConfirm,       setReentry1hConfirm]       = useState(true);
  const [reentryMin1h,           setReentryMin1h]           = useState('55');   // shown as %
  const [reentrySize,            setReentrySize]            = useState('65');   // shown as %
  const [reentrySlAtr,           setReentrySlAtr]           = useState('1.5');
  const [reentryTpAtr,           setReentryTpAtr]           = useState('3.5');
  // Adverse Evidence Monitor
  const [adverseMonitor,         setAdverseMonitor]         = useState(false);
  const [adverseAction,          setAdverseAction]          = useState<'shadow' | 'tighten_sl' | 'partial_close' | 'close'>('shadow');
  const [adverseScoreThresh,     setAdverseScoreThresh]     = useState('0.40');
  const [adverseConfirmCycles,   setAdverseConfirmCycles]   = useState('2');
  const [adverseMinHold,         setAdverseMinHold]         = useState('3');
  const [adversePartialPct,      setAdversePartialPct]      = useState('50');  // shown as %
  const [reversalRet48Extreme,  setReversalRet48Extreme]  = useState('6');   // shown as % in UI
  const [reversalBarsInRegime,  setReversalBarsInRegime]  = useState('20');
  // ATR% Volatility Gate
  const [atrPctGateEnabled, setAtrPctGateEnabled] = useState(false);
  const [atrPctMin,         setAtrPctMin]         = useState('0.8');  // shown as % in UI
  const [atrPctMode,        setAtrPctMode]         = useState<'block' | 'scale'>('scale');
  // Squeeze Protection Gates — OI Spike
  const [oiSpikeGateEnabled, setOiSpikeGateEnabled] = useState(false);
  const [oiSpikeThr,         setOiSpikeThr]         = useState('2.0');
  const [oiSpikeMode,        setOiSpikeMode]        = useState<'block' | 'scale'>('scale');
  const [oiSpikeLookback,    setOiSpikeLookback]    = useState('2');
  // Squeeze Protection Gates — Long/Short Ratio
  const [lsGateEnabled,      setLsGateEnabled]      = useState(false);
  const [lsLongBlockPct,     setLsLongBlockPct]     = useState('67');
  const [lsShortBlockPct,    setLsShortBlockPct]    = useState('33');
  const [lsGateMode,         setLsGateMode]         = useState<'block' | 'scale'>('scale');
  const [lsGateScaleFactor,  setLsGateScaleFactor]  = useState('0.50');
  // Squeeze Protection Gates — Liquidation Spike
  const [liqSpikeGateEnabled, setLiqSpikeGateEnabled] = useState(false);
  const [liqSpikeThr,         setLiqSpikeThr]         = useState('2.5');
  const [liqSpikeLookback,    setLiqSpikeLookback]    = useState('2');
  const [liqSpikeMode,        setLiqSpikeMode]        = useState<'block' | 'scale'>('block');
  const [liqSpikeScaleFactor, setLiqSpikeScaleFactor] = useState('0.40');
  // Weekend Gate
  const [weekendBlockSaturday, setWeekendBlockSaturday] = useState(false);
  const [weekendBlockSunday,   setWeekendBlockSunday]   = useState(false);
  // 1H LightGBM Gate
  const [use1hGate,            setUse1hGate]            = useState(false);
  const [lgbm1hMinAgreement,   setLgbm1hMinAgreement]   = useState('52');   // shown as %
  const [lgbm1hBlockThreshold, setLgbm1hBlockThreshold] = useState('45');   // shown as %
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
  const [chronosCalendarCov, setChronosCalendarCov] = useState(false);
  const [chronosPremiumCov,  setChronosPremiumCov]  = useState(false);
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
  const [botLeverageStr, setBotLeverageStr] = useState<string>("1");   // config leverage (backend)
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
    if (p.leverage           !== undefined) setBotLeverageStr(String(p.leverage ?? 1));
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
    if (p.exhaustion_rsi_low         !== undefined) setExhaustionRsiLow(String(p.exhaustion_rsi_low));
    if (p.exhaustion_rsi_high        !== undefined) setExhaustionRsiHigh(String(p.exhaustion_rsi_high));
    if (p.exhaustion_ret48_pct       !== undefined) setExhaustionRet48(String(p.exhaustion_ret48_pct));
    if (p.exhaustion_boost              !== undefined) setExhaustionBoost(String(p.exhaustion_boost));
    if (p.exhaustion_prop_enabled       !== undefined) setExhaustionProp(!!p.exhaustion_prop_enabled);
    if (p.exhaustion_prop_scale         !== undefined) setExhaustionPropScale(String(p.exhaustion_prop_scale));
    if (p.daily_rsi_gate_enabled        !== undefined) setDailyRsiGate(!!p.daily_rsi_gate_enabled);
    if (p.daily_rsi_short_block         !== undefined) setDailyRsiShortBlock(String(p.daily_rsi_short_block));
    if (p.daily_rsi_long_block          !== undefined) setDailyRsiLongBlock(String(p.daily_rsi_long_block));
    if (p.vol_climax_gate_enabled       !== undefined) setVolClimaxGate(!!p.vol_climax_gate_enabled);
    if (p.vol_climax_gate_z             !== undefined) setVolClimaxZ(String(p.vol_climax_gate_z));
    if (p.vol_climax_gate_rsi           !== undefined) setVolClimaxRsi(String(p.vol_climax_gate_rsi));
    if (p.c2_inversion_gate_enabled     !== undefined) setC2InversionGate(!!p.c2_inversion_gate_enabled);
    if (p.c2_inversion_pct              !== undefined) setC2InversionPct(String(p.c2_inversion_pct));
    if (p.exhaustion_max_hold_enabled   !== undefined) setExhaustionMaxHold(!!p.exhaustion_max_hold_enabled);
    if (p.exhaustion_max_hold_bars      !== undefined) setExhaustionMaxHoldBars(String(p.exhaustion_max_hold_bars));
    if (p.transition_guard_enabled      !== undefined) setTransitionGuard(!!p.transition_guard_enabled);
    if (p.transition_boost_max          !== undefined) setTransitionBoostMax(String(p.transition_boost_max));
    if (p.transition_risk_min           !== undefined) setTransitionRiskMin(String(p.transition_risk_min));
    if (p.structural_sl_enabled         !== undefined) setStructuralSl(!!p.structural_sl_enabled);
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
    if (p.regime_bias_enhanced    !== undefined) setRegimeBiasEnhanced(!!p.regime_bias_enhanced);
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
    if (p.chronos_enabled         !== undefined) setUseChronos(!!p.chronos_enabled);
    if (p.chronos_calendar_covariates !== undefined) setChronosCalendarCov(!!p.chronos_calendar_covariates);
    if (p.chronos_premium_covariate   !== undefined) setChronosPremiumCov(!!p.chronos_premium_covariate);
    if (p.be_sl_enabled                 !== undefined) setAdvBeSL(!!p.be_sl_enabled);
    if (p.be_sl_activation      !== undefined) setAdvBeSLAct(String(p.be_sl_activation));
    if (p.max_hold_bars_enabled !== undefined) setAdvMaxHold(!!p.max_hold_bars_enabled);
    if (p.max_hold_bars         !== undefined) setAdvMaxHoldBars(String(p.max_hold_bars));
    // Binance Cross-Exchange CVD
    if (p.binance_cvd_enabled   !== undefined) setBinanceCvd(!!p.binance_cvd_enabled);
    // Pullback Entry
    if (p.pullback_entry_enabled     !== undefined) setPullbackEnabled(!!p.pullback_entry_enabled);
    if (p.pullback_impulse_atr_mult  !== undefined) setPullbackImpulseAtr(String(p.pullback_impulse_atr_mult));
    if (p.pullback_zone_atr          !== undefined) setPullbackZoneAtr(String(p.pullback_zone_atr));
    if (p.pullback_window_h          !== undefined) setPullbackWindowH(String(p.pullback_window_h));
    if (p.pullback_fallback_atr      !== undefined) setPullbackFallbackAtr(String(p.pullback_fallback_atr));
    // Bounce-Fade Entry
    if (p.bounce_fade_enabled            !== undefined) setBounceFadeEnabled(!!p.bounce_fade_enabled);
    if (p.bounce_fade_counter_trend_only !== undefined) setBounceFadeCounterOnly(!!p.bounce_fade_counter_trend_only);
    if (p.bounce_fade_penetration_pct    !== undefined) setBounceFadePenetration(String(Math.round(p.bounce_fade_penetration_pct * 100)));
    if (p.bounce_fade_offset_atr         !== undefined) setBounceFadeOffsetAtr(String(p.bounce_fade_offset_atr));
    if (p.bounce_fade_window_bars        !== undefined) setBounceFadeWindow(String(p.bounce_fade_window_bars));
    if (p.bounce_fade_market_fallback    !== undefined) setBounceFadeFallback(!!p.bounce_fade_market_fallback);
    if (p.bounce_fade_min_rr             !== undefined) setBounceFadeMinRr(String(p.bounce_fade_min_rr));
    if (p.bounce_fade_sl_buffer_atr      !== undefined) setBounceFadeSlBuffer(String(p.bounce_fade_sl_buffer_atr));
    if (p.bounce_fade_sl_min_atr         !== undefined) setBounceFadeSlMin(String(p.bounce_fade_sl_min_atr));
    // Reversal Zone Detector
    if (p.reversal_mode_enabled        !== undefined) setReversalEnabled(!!p.reversal_mode_enabled);
    if (p.reversal_score_threshold     !== undefined) setReversalScoreThresh(String(p.reversal_score_threshold));
    if (p.reversal_min_components      !== undefined) setReversalMinComponents(String(p.reversal_min_components));
    if (p.reversal_size_factor         !== undefined) setReversalSizeFactor(String(p.reversal_size_factor));
    if (p.reversal_sl_atr_mult         !== undefined) setReversalSlAtr(String(p.reversal_sl_atr_mult));
    if (p.reversal_tp_atr_mult         !== undefined) setReversalTpAtr(String(p.reversal_tp_atr_mult));
    if (p.reversal_rr_min              !== undefined) setReversalRrMin(String(p.reversal_rr_min));
    if (p.reversal_max_hold_bars       !== undefined) setReversalMaxHold(String(p.reversal_max_hold_bars));
    if (p.reversal_entry_mode          !== undefined) setReversalEntryMode(p.reversal_entry_mode as 'limit_retest' | 'close');
    if (p.reversal_retest_wick_pct     !== undefined) setReversalRetestWickPct(String(p.reversal_retest_wick_pct));
    if (p.reversal_retest_expiry_bars  !== undefined) setReversalExpiry(String(p.reversal_retest_expiry_bars));
    if (p.reversal_conflict_block      !== undefined) setReversalConflictBlock(!!p.reversal_conflict_block);
    if (p.reversal_trend_hold_only     !== undefined) setReversalTrendHoldOnly(!!p.reversal_trend_hold_only);
    if (p.reversal_guard_only          !== undefined) setReversalGuardOnly(!!p.reversal_guard_only);
    if (p.reversal_adx_peak_min        !== undefined) setReversalAdxPeakMin(String(p.reversal_adx_peak_min));
    // Re-entry on TP
    if (p.reentry_on_tp_enabled        !== undefined) setReentryEnabled(!!p.reentry_on_tp_enabled);
    if (p.reentry_min_lgbm_pct         !== undefined) setReentryMinLgbm(String(Math.round(p.reentry_min_lgbm_pct * 100)));
    if (p.reentry_1h_confirm_enabled   !== undefined) setReentry1hConfirm(!!p.reentry_1h_confirm_enabled);
    if (p.reentry_min_1h_pct           !== undefined) setReentryMin1h(String(Math.round(p.reentry_min_1h_pct * 100)));
    if (p.reentry_size_factor          !== undefined) setReentrySize(String(Math.round(p.reentry_size_factor * 100)));
    if (p.reentry_sl_atr_mult          !== undefined) setReentrySlAtr(String(p.reentry_sl_atr_mult));
    if (p.reentry_tp_atr_mult          !== undefined) setReentryTpAtr(String(p.reentry_tp_atr_mult));
    if (p.adverse_monitor_enabled      !== undefined) setAdverseMonitor(!!p.adverse_monitor_enabled);
    if (p.adverse_action               !== undefined) setAdverseAction(p.adverse_action as 'shadow' | 'tighten_sl' | 'partial_close' | 'close');
    if (p.adverse_score_threshold      !== undefined) setAdverseScoreThresh(String(p.adverse_score_threshold));
    if (p.adverse_confirm_cycles       !== undefined) setAdverseConfirmCycles(String(p.adverse_confirm_cycles));
    if (p.adverse_min_hold_bars        !== undefined) setAdverseMinHold(String(p.adverse_min_hold_bars));
    if (p.adverse_partial_pct          !== undefined) setAdversePartialPct(String(Math.round(p.adverse_partial_pct * 100)));
    if (p.reversal_ret48_extreme       !== undefined) setReversalRet48Extreme(String(Math.round(p.reversal_ret48_extreme * 100)));
    if (p.reversal_bars_in_regime_min  !== undefined) setReversalBarsInRegime(String(p.reversal_bars_in_regime_min));
    if (p.atr_pct_gate_enabled         !== undefined) setAtrPctGateEnabled(!!p.atr_pct_gate_enabled);
    if (p.atr_pct_min                  !== undefined) setAtrPctMin(String(Math.round(p.atr_pct_min * 1000) / 10));
    if (p.atr_pct_mode                 !== undefined) setAtrPctMode(p.atr_pct_mode as 'block' | 'scale');
    // Squeeze Protection Gates
    if (p.oi_spike_gate_enabled        !== undefined) setOiSpikeGateEnabled(!!p.oi_spike_gate_enabled);
    if (p.oi_spike_thr                 !== undefined) setOiSpikeThr(String(p.oi_spike_thr));
    if (p.oi_spike_mode                !== undefined) setOiSpikeMode(p.oi_spike_mode as 'block' | 'scale');
    if (p.oi_spike_lookback            !== undefined) setOiSpikeLookback(String(p.oi_spike_lookback));
    if (p.ls_gate_enabled              !== undefined) setLsGateEnabled(!!p.ls_gate_enabled);
    if (p.ls_long_block_pct            !== undefined) setLsLongBlockPct(String(p.ls_long_block_pct));
    if (p.ls_short_block_pct           !== undefined) setLsShortBlockPct(String(p.ls_short_block_pct));
    if (p.ls_gate_mode                 !== undefined) setLsGateMode(p.ls_gate_mode as 'block' | 'scale');
    if (p.ls_gate_scale_factor         !== undefined) setLsGateScaleFactor(String(p.ls_gate_scale_factor));
    if (p.liq_spike_gate_enabled       !== undefined) setLiqSpikeGateEnabled(!!p.liq_spike_gate_enabled);
    if (p.liq_spike_thr                !== undefined) setLiqSpikeThr(String(p.liq_spike_thr));
    if (p.liq_spike_lookback           !== undefined) setLiqSpikeLookback(String(p.liq_spike_lookback));
    if (p.liq_spike_mode               !== undefined) setLiqSpikeMode(p.liq_spike_mode as 'block' | 'scale');
    if (p.liq_spike_scale_factor       !== undefined) setLiqSpikeScaleFactor(String(p.liq_spike_scale_factor));
    // Weekend Gate
    if (p.weekend_gate_block_saturday  !== undefined) setWeekendBlockSaturday(!!p.weekend_gate_block_saturday);
    if (p.weekend_gate_block_sunday    !== undefined) setWeekendBlockSunday(!!p.weekend_gate_block_sunday);
    if (p.use_1h_lgbm_gate             !== undefined) setUse1hGate(!!p.use_1h_lgbm_gate);
    if (p.lgbm_1h_min_agreement        !== undefined) setLgbm1hMinAgreement(String(Math.round(p.lgbm_1h_min_agreement * 100)));
    if (p.lgbm_1h_block_threshold      !== undefined) setLgbm1hBlockThreshold(String(Math.round(p.lgbm_1h_block_threshold * 100)));
  }, []);

  useEffect(() => {
    apiFetch(`${apiBase}/bot/backtest`)
      .then(r => r.json())
      .then(applyConfig)
      .catch(() => {/* silent — use defaults */});
  }, [apiBase, applyConfig]);

  // ── Reconnect to a job that was running before a page refresh ────────────────
  useEffect(() => {
    apiFetch(`${apiBase}/backtest/active`)
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
      try { await apiFetch(`${apiBase}/backtest/${jobId}`, { method: 'DELETE' }); } catch {}
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
    apiFetch(`${apiBase}/presets`)
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
    apiFetch(`${apiBase}/presets`)
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
      const r = await apiFetch(`${apiBase}/bot`);
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
      const r = await apiFetch(`${apiBase}/bot/backtest`, {
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
    leverage:                 parseInt(botLeverageStr) || 1,
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
    chronos_enabled:               useChronos,
    chronos_weight:                parseFloat(advChronosWeight),
    chronos_calendar_covariates:   chronosCalendarCov,
    chronos_premium_covariate:     chronosPremiumCov,
    adx_gate_enabled:              advAdxEnabled,
    sweep_gate_enabled:            advSweepEnabled,
    fvg_filter_enabled:            advFvgEnabled,
    mtf_alignment_enabled:         advMtfEnabled,
    // Chronos-2 adaptive features
    c2_uncertainty_gate_enabled:   c2UncertaintyGate,
    c2_uncertainty_threshold:      parseFloat(c2UncertaintyThresh),
    c2_cont_prob_gate_enabled:     c2ContProbGate,
    c2_cont_prob_threshold:        parseFloat(c2ContProbThresh),
    dynamic_sl_tp_enabled:                  withAdvanced && dynamicSlTp,
    dynamic_sl_tp_blend:                    parseFloat(dynamicSlTpBlend),
    recalibrated_uncertainty_thresholds:    recalibratedUncertainty,
    p10_sl_floor_enabled:                   withAdvanced && p10SlFloor && useChronos,
    ob_tp_enabled:                          withAdvanced && obTp,
    ob_tp_blend:                            parseFloat(obTpBlend),
    fvg_sl_enabled:                         withAdvanced && fvgSl,
    fvg_tp_enabled:                         withAdvanced && fvgTp,
    fvg_tp_blend:                           parseFloat(fvgTpBlend),
    swing_sl_enabled:                       withAdvanced && swingSl,
    swing_tp_enabled:                       withAdvanced && swingTp,
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
    regime_bias_enhanced:          regimeBiasEnhanced,
    // Sweep Confluence directional mode
    sweep_gate_directional:        sweepDirectional,
    // CVD Absorption Filter
    absorption_filter_enabled:     absorptionFilter,
    absorption_z_threshold:        parseFloat(absorptionZThresh),
    // Dual ATR
    dual_atr_enabled:              dualAtr,
    // Signal quality filters
    exhaustion_guard_enabled:      exhaustionGuard,
    exhaustion_rsi_low:            parseFloat(exhaustionRsiLow),
    exhaustion_rsi_high:           parseFloat(exhaustionRsiHigh),
    exhaustion_ret48_pct:          parseFloat(exhaustionRet48),
    exhaustion_boost:              parseFloat(exhaustionBoost),
    exhaustion_prop_enabled:       exhaustionProp,
    exhaustion_prop_scale:         parseFloat(exhaustionPropScale),
    daily_rsi_gate_enabled:        dailyRsiGate,
    daily_rsi_short_block:         parseFloat(dailyRsiShortBlock),
    daily_rsi_long_block:          parseFloat(dailyRsiLongBlock),
    vol_climax_gate_enabled:       volClimaxGate,
    vol_climax_gate_z:             parseFloat(volClimaxZ),
    vol_climax_gate_rsi:           parseFloat(volClimaxRsi),
    c2_inversion_gate_enabled:     c2InversionGate,
    c2_inversion_pct:              parseFloat(c2InversionPct),
    exhaustion_max_hold_enabled:   exhaustionMaxHold,
    exhaustion_max_hold_bars:      parseInt(exhaustionMaxHoldBars),
    transition_guard_enabled:      transitionGuard,
    transition_boost_max:          parseFloat(transitionBoostMax),
    transition_risk_min:           parseFloat(transitionRiskMin),
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
    // Binance Cross-Exchange CVD
    binance_cvd_enabled:           binanceCvd,
    // Pullback Entry
    bounce_fade_enabled:            bounceFadeEnabled,
    bounce_fade_counter_trend_only: bounceFadeCounterOnly,
    bounce_fade_penetration_pct:    parseFloat(bounceFadePenetration) / 100,
    bounce_fade_offset_atr:         parseFloat(bounceFadeOffsetAtr),
    bounce_fade_window_bars:        parseInt(bounceFadeWindow),
    bounce_fade_market_fallback:    bounceFadeFallback,
    bounce_fade_min_rr:             parseFloat(bounceFadeMinRr),
    bounce_fade_sl_buffer_atr:      parseFloat(bounceFadeSlBuffer),
    bounce_fade_sl_min_atr:         parseFloat(bounceFadeSlMin),
    pullback_entry_enabled:        pullbackEnabled,
    pullback_impulse_atr_mult:     parseFloat(pullbackImpulseAtr),
    pullback_zone_atr:             parseFloat(pullbackZoneAtr),
    pullback_window_h:             parseInt(pullbackWindowH),
    pullback_fallback_atr:         parseFloat(pullbackFallbackAtr),
    // Reversal Zone Detector
    reversal_mode_enabled:         reversalEnabled,
    reversal_score_threshold:      parseFloat(reversalScoreThresh),
    reversal_min_components:       parseInt(reversalMinComponents),
    reversal_component_min_score:  0.40,   // Pydantic default — not exposed in UI
    reversal_size_factor:          parseFloat(reversalSizeFactor),
    reversal_sl_atr_mult:          parseFloat(reversalSlAtr),
    reversal_tp_atr_mult:          parseFloat(reversalTpAtr),
    reversal_rr_min:               parseFloat(reversalRrMin),
    reversal_max_hold_bars:        parseInt(reversalMaxHold),
    reversal_entry_mode:           reversalEntryMode,
    reversal_retest_wick_pct:      parseFloat(reversalRetestWickPct),
    reversal_retest_expiry_bars:   parseInt(reversalExpiry),
    reversal_conflict_block:       reversalConflictBlock,
    reversal_trend_hold_only:      reversalTrendHoldOnly,
    reversal_guard_only:           reversalGuardOnly,
    reversal_adx_peak_min:         parseFloat(reversalAdxPeakMin),
    reversal_ret48_extreme:        parseFloat(reversalRet48Extreme) / 100,
    reversal_bars_in_regime_min:   parseInt(reversalBarsInRegime),
    // Re-entry on TP
    reentry_on_tp_enabled:         reentryEnabled,
    reentry_min_lgbm_pct:          parseFloat(reentryMinLgbm) / 100,
    reentry_1h_confirm_enabled:    reentry1hConfirm,
    reentry_min_1h_pct:            parseFloat(reentryMin1h) / 100,
    reentry_size_factor:           parseFloat(reentrySize) / 100,
    reentry_sl_atr_mult:           parseFloat(reentrySlAtr),
    reentry_tp_atr_mult:           parseFloat(reentryTpAtr),
    adverse_monitor_enabled:       adverseMonitor,
    adverse_action:                adverseAction,
    adverse_score_threshold:       parseFloat(adverseScoreThresh),
    adverse_confirm_cycles:        parseInt(adverseConfirmCycles),
    adverse_min_hold_bars:         parseInt(adverseMinHold),
    adverse_partial_pct:           parseFloat(adversePartialPct) / 100,
    atr_pct_gate_enabled:          atrPctGateEnabled,
    use_1h_lgbm_gate:              use1hGate,
    lgbm_1h_min_agreement:         parseFloat(lgbm1hMinAgreement) / 100,
    lgbm_1h_block_threshold:       parseFloat(lgbm1hBlockThreshold) / 100,
    atr_pct_min:                   parseFloat(atrPctMin) / 100,
    atr_pct_mode:                  atrPctMode,
    // Squeeze Protection Gates
    oi_spike_gate_enabled:         oiSpikeGateEnabled,
    oi_spike_thr:                  parseFloat(oiSpikeThr),
    oi_spike_mode:                 oiSpikeMode,
    oi_spike_lookback:             parseInt(oiSpikeLookback),
    ls_gate_enabled:               lsGateEnabled,
    ls_long_block_pct:             parseFloat(lsLongBlockPct),
    ls_short_block_pct:            parseFloat(lsShortBlockPct),
    ls_gate_mode:                  lsGateMode,
    ls_gate_scale_factor:          parseFloat(lsGateScaleFactor),
    liq_spike_gate_enabled:        liqSpikeGateEnabled,
    liq_spike_thr:                 parseFloat(liqSpikeThr),
    liq_spike_lookback:            parseInt(liqSpikeLookback),
    liq_spike_mode:                liqSpikeMode,
    liq_spike_scale_factor:        parseFloat(liqSpikeScaleFactor),
    // Weekend Gate
    weekend_gate_block_saturday:   weekendBlockSaturday,
    weekend_gate_block_sunday:     weekendBlockSunday,
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
      `Regime forzato:         ${forcedRegime.toUpperCase()}${forcedRegime === 'auto' && regimeBiasEnhanced ? ' [ENHANCED]' : ''}`,
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
      `Chronos covariate:      ${useChronos ? `calendar ${chronosCalendarCov ? 'ON (hour+dow sin/cos)' : 'OFF'} · premium_z ${chronosPremiumCov ? 'ON' : 'OFF'}` : '—'}`,
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
      `Exhaustion Guard:       ${exhaustionGuard ? `ATTIVO — RSI low ${exhaustionRsiLow} · RSI high ${exhaustionRsiHigh} · ret48 ±${exhaustionRet48}% · boost +${exhaustionBoost}` + (exhaustionProp ? ` · prop ×${exhaustionPropScale}` : ' · prop OFF') : 'DISATTIVATO'}`,
      `Absorption Filter:      ${absorptionFilter ? `ATTIVO — soglia z ${absorptionZThresh}σ` : 'DISATTIVATO'}`,
      `Dual ATR (SL/TP):       ${dualAtr ? 'ATTIVO (SL=ATR_21, TP=ATR_14)' : 'DISATTIVATO'}`,
      `Late Entry Filter:      ${lateEntryFilter ? `ATTIVO — max OB dist ${lateEntryMaxObDist} ATR` : 'DISATTIVATO'}`,
      `Path Obstruction Gate:  ${pathObstruction ? `ATTIVO — max dist contrario ${pathObstMaxDist} ATR` : 'DISATTIVATO'}`,
      `Consecutive Bars Filter:${consecBarsFilter ? ` ATTIVO — max long ${consecBarsMaxLong} bar | max short ${consecBarsMaxShort} bar` : ' DISATTIVATO'}`,
      `ATR% Volatility Gate:   ${atrPctGateEnabled ? `ATTIVO — soglia ${atrPctMin}% · modalità ${atrPctMode === 'block' ? 'Blocco Netto' : 'Riduzione Graduale'}` : 'DISATTIVATO'}`,
      `OI Spike Gate:          ${oiSpikeGateEnabled ? `ATTIVO — soglia ${oiSpikeThr}σ · lookback ${oiSpikeLookback} bar · ${oiSpikeMode === 'block' ? 'Blocco' : 'Scale'}` : 'DISATTIVATO'}`,
      `Long/Short Ratio Gate:  ${lsGateEnabled ? `ATTIVO — block SHORT ≥${lsLongBlockPct}% · block LONG ≤${lsShortBlockPct}% · ${lsGateMode === 'block' ? 'Blocco' : `Scale ×${lsGateScaleFactor}`}` : 'DISATTIVATO'}`,
      `Liquidation Spike Gate: ${liqSpikeGateEnabled ? `ATTIVO — soglia ${liqSpikeThr}σ · lookback ${liqSpikeLookback} bar · ${liqSpikeMode === 'block' ? 'Blocco' : `Scale ×${liqSpikeScaleFactor}`}` : 'DISATTIVATO'}`,
      `Weekend Gate:           ${(weekendBlockSaturday || weekendBlockSunday) ? `ATTIVO — blocca ${[weekendBlockSaturday && 'Sabato', weekendBlockSunday && 'Domenica'].filter(Boolean).join(' + ')} (UTC)` : 'DISATTIVATO'}`,
      `1H Gate (LightGBM):     ${use1hGate ? `ATTIVO — blocco <${lgbm1hBlockThreshold}% · riduzione <${lgbm1hMinAgreement}%` : 'DISATTIVATO'}`,
      '',
      '━━━ BIAS DI MERCATO ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
      `Funding Rate Bias:      ${fundingGate ? `ATTIVO — lookback ${fundingGateLookback} bar · high ${(parseFloat(fundingHighThr)*10000).toFixed(1)}bps · extreme ${(parseFloat(fundingExtremeThr)*10000).toFixed(1)}bps · Δ${fundingBiasDelta}` : 'DISATTIVATO'}`,
      `Fear & Greed Bias:      ${fngGate ? `ATTIVO — ExFear <${fngExtremeFearThr} · Fear <${fngFearThr} · Greed >${fngGreedThr} · ExGreed >${fngExtremeGreedThr} · Δ${fngBiasDelta}` : 'DISATTIVATO'}`,
      '',
      '━━━ DATI AGGIUNTIVI ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
      `Binance Cross-Exchange CVD: ${binanceCvd ? 'ATTIVO (taker_buy_vol → binance_cvd_slope, binance_absorption_z, cross_cvd_div)' : 'DISATTIVATO'}`,
      '',
      '━━━ PULLBACK ENTRY ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
      `Bounce-Fade Entry:      ${bounceFadeEnabled ? `ATTIVO — penetration ${bounceFadePenetration}% · cap ${bounceFadeOffsetAtr}×ATR · window ${bounceFadeWindow} bar · ${bounceFadeFallback ? 'fallback mercato' : 'no fallback'} · minR:R ${bounceFadeMinRr}${bounceFadeCounterOnly ? ' · solo controtrend' : ''}` : 'DISATTIVATO'}`,
      `Pullback Entry:         ${pullbackEnabled ? 'ATTIVO' : 'DISATTIVATO'}`,
      `Reversal Detector:      ${reversalEnabled ? 'ATTIVO' : 'DISATTIVATO'}`,
      ...(reversalEnabled ? [
        `  Entry mode:           ${reversalEntryMode === 'limit_retest' ? `Limit Retest (wick ${Math.round(parseFloat(reversalRetestWickPct)*100)}%, scade ${reversalExpiry} barre)` : 'Market Close (immediato)'}`,
        `  Score ≥:              ${reversalScoreThresh} · Min ${reversalMinComponents}/7 componenti`,
        `  SL / TP:              ${reversalSlAtr}×ATR / ${reversalTpAtr}×ATR · R:R min ${reversalRrMin}:1`,
        `  Size factor:          ${Math.round(parseFloat(reversalSizeFactor)*100)}% · Max hold ${reversalMaxHold} barre (${parseInt(reversalMaxHold)*4}h)`,
        `  Conflict block:       ${reversalConflictBlock ? 'ON (blocca se trend opposto)' : 'OFF'}`,
        `  Trend hold only:      ${reversalTrendHoldOnly ? 'ON' : 'OFF'} · Guard only: ${reversalGuardOnly ? 'ON (solo blocco)' : 'OFF'}`,
        `  IV Bias:              Neutro in backtest (iv_7d_percentile=50 fisso — dati Deribit non disponibili storicamente)`,
      ] : []),
      ...(pullbackEnabled ? [
        `  Soglia impulso corpo: ${pullbackImpulseAtr}×ATR (abs(close-open) ≥ soglia per attivare)`,
        `  Profondità pullback:  ${pullbackZoneAtr}×ATR (ritracciamento target dalla chiusura 4H)`,
        `  Finestra attesa:      ${pullbackWindowH}h (${Math.max(1, Math.ceil(parseInt(pullbackWindowH) / 4))} bar 4H)`,
        `  Limite fallback:      ${pullbackFallbackAtr}×ATR (oltre → segnale decade)`,
      ] : []),
      '',
      '━━━ RE-ENTRY ON TP ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
      `Re-entry on TP:         ${reentryEnabled ? 'ATTIVO' : 'DISATTIVATO'}`,
      ...(reentryEnabled ? [
        `  Conferma Gate 1H:     ${reentry1hConfirm ? 'ON' : 'OFF'}`,
        `  LGBM 4H min:          ${reentryMinLgbm}%`,
        ...(reentry1hConfirm ? [`  Gate 1H min:          ${reentryMin1h}%`] : []),
        `  Size factor:          ×${(parseFloat(reentrySize) / 100).toFixed(2)} (${reentrySize}% della size normale)`,
        `  SL / TP:              ${reentrySlAtr}×ATR / ${reentryTpAtr}×ATR`,
        `  Structural SL:        DISABILITATO (nessuna nuova candela 4H al re-entry)`,
      ] : []),
      '',
      '━━━ TRANSITION GUARD ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
      `Transition Guard:       ${transitionGuard ? `ATTIVO — risk_min ${transitionRiskMin} · boost max ×${transitionBoostMax}` : 'DISATTIVATO'}`,
      '',
      '━━━ ADVERSE EVIDENCE MONITOR ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
      `Adverse Monitor:        ${adverseMonitor ? `ATTIVO — azione ${adverseAction} · soglia score ${adverseScoreThresh} · confirm ${adverseConfirmCycles} cicli · min hold ${adverseMinHold} barre${adverseAction === 'partial_close' ? ` · chiude ${adversePartialPct}%` : ''}` : 'DISATTIVATO'}`,
    ];
    // ── NOTA MANUTENZIONE ─────────────────────────────────────────────────────
    // Il blocco "CONFIG JSON COMPLETO" in fondo include SEMPRE il 100% dei campi
    // tramite buildConfig(true). Le sezioni di testo sopra devono essere aggiornate
    // manualmente ogni volta che si aggiunge un nuovo parametro a buildConfig.
    // Per verificare la copertura: confronta le chiavi di buildConfig() con le righe
    // di testo in questa funzione. Il JSON è la fonte di verità, il testo è UX.

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
      lines.push(`Sharpe ratio:         ${s.sharpe?.toFixed(2) ?? '—'}`);
      lines.push(`Sortino ratio:        ${s.sortino?.toFixed(2) ?? '—'}`);
      lines.push(`Max drawdown:         ${s.max_drawdown_pct.toFixed(2)}%`);
      lines.push(`Avg win:              +${s.avg_win_pct?.toFixed(2) ?? '0.00'}%`);
      lines.push(`Avg loss:             ${s.avg_loss_pct?.toFixed(2) ?? '0.00'}%`);
      lines.push(`Best trade:           +${s.best_trade_pct?.toFixed(2) ?? '0.00'}%`);
      lines.push(`Worst trade:          ${s.worst_trade_pct?.toFixed(2) ?? '0.00'}%`);
      lines.push(`Avg holding:          ${s.avg_holding_h?.toFixed(1) ?? '—'} h`);
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
        // Sequential: the backend is single-slot — parallel POST requests would
        // cause the second to cancel the first with "Annullato — nuovo backtest avviato".
        const bodyOpt  = { ...body,    name: 'A/B — Ottimizzato' };
        const bodyBase = { ...body, config: buildConfig(false), name: 'A/B — Baseline' };
        const r1 = await runJob(apiBase, bodyOpt, ctrl.signal);
        const r2 = await runJob(apiBase, bodyBase, ctrl.signal);
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
    || fundingGate || fngGate
    || dynamicSlTp || p10SlFloor || obTp || fvgSl || fvgTp || swingSl || swingTp
    || parseInt(botLeverageStr) > 1;

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
          <div className="elegant-card p-6 bg-white dark:bg-[#151E32] space-y-6">
            <div className="flex flex-col md:flex-row items-center justify-between space-y-2 md:space-y-0">
              <h2 className="text-sm font-bold text-slate-900 dark:text-white uppercase tracking-wider">Parametri di Simulazione</h2>
              <Tooltip text="Apre il pannello delle impostazioni avanzate: filtri segnale, strategie di uscita (Trailing SL, Partial TP, LGBM Exit, Break-even SL), e configurazione Chronos-2. Indipendente dalle impostazioni del bot live." width="wide" pos="bottom">
                <button
                  onClick={() => setIsDrawerOpen(true)}
                  className={`flex items-center gap-2 w-full md:w-auto px-4 py-2 rounded-xl text-[10px] font-bold uppercase tracking-widest border transition-all ${drawerHasCustom
                    ? 'bg-indigo-50 dark:bg-indigo-500/10 border-indigo-200 dark:border-indigo-500/30 text-indigo-600 dark:text-indigo-400'
                    : 'bg-slate-50 dark:bg-white/5 border-slate-100 dark:border-white/10 text-slate-400 dark:text-slate-500 hover:text-slate-900 dark:hover:text-white'
                  }`}
                >
                  <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
                    <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                  </svg>
                  Configurazione Avanzata
                  {drawerHasCustom && <span className="w-1.5 h-1.5 rounded-full bg-indigo-500 animate-pulse"></span>}
                </button>
              </Tooltip>
            </div>

            {/* ── Presets bar ── */}
            <div className="flex items-center gap-2.5">
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
                { label: 'Size (%)',   tip: 'Percentuale del capitale rischiata per ogni trade. Con $10.000 e Size 1.5%, ogni trade rischia $150.',             type: 'number', val: posSizePct,      set: setPosSizePct,      min: undefined, max: undefined, dimWhenDynamic: false },
                { label: 'Leva (×)',  tip: 'Leva isolata reale applicata al backtest (1–50). Size USD × leva, margine = size/leva. Safety cap: margine ≤ 95% del capitale. Imposta a 1 per nessuna leva.',   type: 'number', val: botLeverageStr,  set: setBotLeverageStr,  min: '1',       max: '50',      dimWhenDynamic: false },
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

            {/* Leverage warning banner */}
            {parseInt(botLeverageStr) > 1 && (
              <div className={`flex items-start gap-2 rounded-xl px-3.5 py-2.5 text-[11px] font-medium ${
                parseInt(botLeverageStr) >= 20
                  ? 'bg-red-50 dark:bg-red-900/20 text-red-700 dark:text-red-400'
                  : 'bg-amber-50 dark:bg-amber-900/20 text-amber-700 dark:text-amber-400'
              }`}>
                <span className="mt-0.5 shrink-0">⚠</span>
                <span>
                  {parseInt(botLeverageStr) >= 20
                    ? `Leva ${botLeverageStr}× — liquidazione attiva nel backtest. Le posizioni vengono chiuse al prezzo di liquidazione se toccato prima dello SL.`
                    : `Leva ${botLeverageStr}× attiva. Position size ×${botLeverageStr}, margine = size/${botLeverageStr}. Il simulatore post-hoc è disabilitato sui risultati.`}
                </span>
              </div>
            )}

            {/* ── Regime / Period Quick Selector ───────────────────────────────── */}
            <div className="pt-1">
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

              <div className="flex flex-col sm:flex-row gap-3 items-start">
                {/* ── Regime dropdown ── */}
                <div className="relative w-full sm:w-52 flex-shrink-0" ref={regimeRef}>
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
                <div className="relative w-full sm:w-60 flex-shrink-0" ref={periodRef}>
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
                    <div className="absolute z-50 top-full left-0 mt-1.5 w-screen max-w-[calc(100vw-2rem)] sm:w-full sm:min-w-[420px] bg-white dark:bg-[#1a2436] border border-slate-100 dark:border-white/10 rounded-2xl shadow-xl shadow-slate-900/10 dark:shadow-black/30 overflow-hidden animate-in fade-in slide-in-from-top-1 duration-150">
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
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
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

              {/* Covariate avanzate Chronos: calendar (future) + premium_z (past) */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                {/* Calendar future covariates */}
                <Tooltip text="Passa a Chronos-2 ora-del-giorno e giorno-della-settimana (encoding ciclico sin/cos) come future_covariates — l'unico segnale noto in anticipo. Aiuta il modello a riconoscere sessioni (Asia/EU/US), weekend e settlement funding. Effetto atteso principalmente su volatilità/incertezza." pos="bottom" width="wide">
                  <label className={`flex items-start gap-2.5 cursor-pointer group p-3 rounded-xl border transition-all duration-200 h-full ${chronosCalendarCov && useChronos ? 'border-cyan-200 dark:border-cyan-500/30 bg-cyan-50/40 dark:bg-cyan-500/5' : 'border-slate-100 dark:border-white/5 hover:bg-slate-50 dark:hover:bg-white/[0.03]'} ${!useChronos ? 'opacity-50' : ''}`}>
                    <div className="relative mt-0.5 flex-shrink-0">
                      <input type="checkbox" className="sr-only" checked={chronosCalendarCov} onChange={e => setChronosCalendarCov(e.target.checked)} disabled={!useChronos} />
                      <div className={`w-9 h-[18px] rounded-full transition-all duration-300 ${chronosCalendarCov && useChronos ? 'bg-cyan-600' : 'bg-slate-200 dark:bg-white/10'}`} />
                      <div className={`absolute top-[3px] left-[3px] w-3 h-3 bg-white rounded-full shadow-sm transition-transform duration-300 ${chronosCalendarCov ? 'translate-x-[18px]' : ''}`} />
                    </div>
                    <div className="min-w-0">
                      <p className={`text-xs font-bold leading-tight transition-colors ${chronosCalendarCov && useChronos ? 'text-cyan-600 dark:text-cyan-400' : 'text-slate-700 dark:text-slate-300'}`}>
                        Calendar Covariates
                        {chronosCalendarCov && useChronos && <span className="ml-1.5 px-1.5 py-0.5 rounded text-[9px] font-bold bg-cyan-100 dark:bg-cyan-500/20 text-cyan-600 dark:text-cyan-400 uppercase tracking-wider">Future</span>}
                        {!useChronos && <span className="ml-1.5 px-1.5 py-0.5 rounded text-[9px] font-bold bg-slate-100 dark:bg-white/10 text-slate-400 dark:text-slate-500 uppercase tracking-wider">Richiede C2</span>}
                      </p>
                      <p className="text-[10px] text-slate-400 dark:text-slate-500 leading-snug mt-0.5">Ora + giorno (sin/cos) come future_covariates — sessioni, weekend, settlement funding</p>
                    </div>
                  </label>
                </Tooltip>

                {/* Premium_z past covariate */}
                <Tooltip text="Passa a Chronos-2 il premium_z (z-score del basis spot-perp) come past_covariate. Proxy di posizionamento/flusso complementare al funding. Costo quasi nullo." pos="bottom" width="wide">
                  <label className={`flex items-start gap-2.5 cursor-pointer group p-3 rounded-xl border transition-all duration-200 h-full ${chronosPremiumCov && useChronos ? 'border-cyan-200 dark:border-cyan-500/30 bg-cyan-50/40 dark:bg-cyan-500/5' : 'border-slate-100 dark:border-white/5 hover:bg-slate-50 dark:hover:bg-white/[0.03]'} ${!useChronos ? 'opacity-50' : ''}`}>
                    <div className="relative mt-0.5 flex-shrink-0">
                      <input type="checkbox" className="sr-only" checked={chronosPremiumCov} onChange={e => setChronosPremiumCov(e.target.checked)} disabled={!useChronos} />
                      <div className={`w-9 h-[18px] rounded-full transition-all duration-300 ${chronosPremiumCov && useChronos ? 'bg-cyan-600' : 'bg-slate-200 dark:bg-white/10'}`} />
                      <div className={`absolute top-[3px] left-[3px] w-3 h-3 bg-white rounded-full shadow-sm transition-transform duration-300 ${chronosPremiumCov ? 'translate-x-[18px]' : ''}`} />
                    </div>
                    <div className="min-w-0">
                      <p className={`text-xs font-bold leading-tight transition-colors ${chronosPremiumCov && useChronos ? 'text-cyan-600 dark:text-cyan-400' : 'text-slate-700 dark:text-slate-300'}`}>
                        Premium-z Covariate
                        {chronosPremiumCov && useChronos && <span className="ml-1.5 px-1.5 py-0.5 rounded text-[9px] font-bold bg-cyan-100 dark:bg-cyan-500/20 text-cyan-600 dark:text-cyan-400 uppercase tracking-wider">Past</span>}
                        {!useChronos && <span className="ml-1.5 px-1.5 py-0.5 rounded text-[9px] font-bold bg-slate-100 dark:bg-white/10 text-slate-400 dark:text-slate-500 uppercase tracking-wider">Richiede C2</span>}
                      </p>
                      <p className="text-[10px] text-slate-400 dark:text-slate-500 leading-snug mt-0.5">Basis spot-perp (z-score) come past_covariate — proxy posizionamento, complementare al funding</p>
                    </div>
                  </label>
                </Tooltip>
              </div>

              {/* Blend + calibration */}
              {dynamicSlTp && (
                <div className="px-1 flex flex-col gap-1.5 sm:flex-row sm:items-center sm:gap-4">
                  <div className="flex items-center justify-between sm:block">
                    <span className="text-[10px] font-bold text-slate-400 dark:text-slate-500 uppercase tracking-widest whitespace-nowrap">Blend ATR ↔ C2</span>
                    <span className="sm:hidden text-[11px] font-bold font-mono text-violet-600 dark:text-violet-400">
                      {Math.round((1 - parseFloat(dynamicSlTpBlend || '0.5')) * 100)}% ATR · {Math.round(parseFloat(dynamicSlTpBlend || '0.5') * 100)}% C2
                    </span>
                  </div>
                  <div className="flex items-center gap-3 flex-1">
                    <span className="text-[10px] font-bold text-slate-500 dark:text-slate-400 font-mono">ATR</span>
                    <input
                      type="range" min="0" max="1" step="0.05"
                      value={dynamicSlTpBlend}
                      onChange={e => setDynamicSlTpBlend(e.target.value)}
                      className="flex-1 h-1.5 rounded-full appearance-none cursor-pointer bg-slate-200 dark:bg-white/15 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-3.5 [&::-webkit-slider-thumb]:h-3.5 [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-violet-500 [&::-webkit-slider-thumb]:shadow-sm [&::-webkit-slider-thumb]:cursor-pointer [&::-moz-range-thumb]:w-3.5 [&::-moz-range-thumb]:h-3.5 [&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:bg-violet-500 [&::-moz-range-thumb]:border-0"
                    />
                    <span className="text-[10px] font-bold text-slate-500 dark:text-slate-400 font-mono">C2</span>
                    <span className="hidden sm:inline text-[11px] font-bold font-mono text-violet-600 dark:text-violet-400 w-20 text-right">
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
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">

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
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 px-1">
                  <NumInput label="SL Buffer %" value={obBufferPct} onChange={setObBufferPct} step="0.1" min="0" max="2" unit="%" />
                  <NumInput label="SL Buffer Min ATR" value={obBufferMinAtr} onChange={setObBufferMinAtr} step="0.05" min="0" max="1" unit="ATR" />
                </div>
              )}

              {/* OB TP blend */}
              {obTp && (
                <div className="px-1 flex flex-col gap-1.5 sm:flex-row sm:items-center sm:gap-4">
                  <div className="flex items-center justify-between sm:block">
                    <span className="text-[10px] font-bold text-slate-400 dark:text-slate-500 uppercase tracking-widest whitespace-nowrap">OB TP — Blend ATR ↔ OB</span>
                    <span className="sm:hidden text-[11px] font-bold font-mono text-emerald-600 dark:text-emerald-400">
                      {Math.round((1 - parseFloat(obTpBlend || '1')) * 100)}% ATR · {Math.round(parseFloat(obTpBlend || '1') * 100)}% OB
                    </span>
                  </div>
                  <div className="flex items-center gap-3 flex-1">
                    <span className="text-[10px] font-bold text-slate-500 dark:text-slate-400 font-mono">ATR</span>
                    <input
                      type="range" min="0" max="1" step="0.05"
                      value={obTpBlend}
                      onChange={e => setObTpBlend(e.target.value)}
                      className="flex-1 h-1.5 rounded-full appearance-none cursor-pointer bg-slate-200 dark:bg-white/15 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-3.5 [&::-webkit-slider-thumb]:h-3.5 [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-emerald-500 [&::-webkit-slider-thumb]:shadow-sm [&::-webkit-slider-thumb]:cursor-pointer [&::-moz-range-thumb]:w-3.5 [&::-moz-range-thumb]:h-3.5 [&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:bg-emerald-500 [&::-moz-range-thumb]:border-0"
                    />
                    <span className="text-[10px] font-bold text-slate-500 dark:text-slate-400 font-mono">OB</span>
                    <span className="hidden sm:inline text-[11px] font-bold font-mono text-emerald-600 dark:text-emerald-400 w-24 text-right">
                      {Math.round((1 - parseFloat(obTpBlend || '1')) * 100)}% ATR · {Math.round(parseFloat(obTpBlend || '1') * 100)}% OB
                    </span>
                  </div>
                </div>
              )}

              {/* FVG TP blend */}
              {fvgTp && (
                <div className="px-1 flex flex-col gap-1.5 sm:flex-row sm:items-center sm:gap-4">
                  <div className="flex items-center justify-between sm:block">
                    <span className="text-[10px] font-bold text-slate-400 dark:text-slate-500 uppercase tracking-widest whitespace-nowrap">FVG TP — Blend ATR ↔ FVG</span>
                    <span className="sm:hidden text-[11px] font-bold font-mono text-emerald-600 dark:text-emerald-400">
                      {Math.round((1 - parseFloat(fvgTpBlend || '1')) * 100)}% ATR · {Math.round(parseFloat(fvgTpBlend || '1') * 100)}% FVG
                    </span>
                  </div>
                  <div className="flex items-center gap-3 flex-1">
                    <span className="text-[10px] font-bold text-slate-500 dark:text-slate-400 font-mono">ATR</span>
                    <input
                      type="range" min="0" max="1" step="0.05"
                      value={fvgTpBlend}
                      onChange={e => setFvgTpBlend(e.target.value)}
                      className="flex-1 h-1.5 rounded-full appearance-none cursor-pointer bg-slate-200 dark:bg-white/15 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-3.5 [&::-webkit-slider-thumb]:h-3.5 [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-emerald-500 [&::-webkit-slider-thumb]:shadow-sm [&::-webkit-slider-thumb]:cursor-pointer [&::-moz-range-thumb]:w-3.5 [&::-moz-range-thumb]:h-3.5 [&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:bg-emerald-500 [&::-moz-range-thumb]:border-0"
                    />
                    <span className="text-[10px] font-bold text-slate-500 dark:text-slate-400 font-mono">FVG</span>
                    <span className="hidden sm:inline text-[11px] font-bold font-mono text-emerald-600 dark:text-emerald-400 w-24 text-right">
                      {Math.round((1 - parseFloat(fvgTpBlend || '1')) * 100)}% ATR · {Math.round(parseFloat(fvgTpBlend || '1') * 100)}% FVG
                    </span>
                  </div>
                </div>
              )}

              {/* Swing TP blend */}
              {swingTp && (
                <div className="px-1 flex flex-col gap-1.5 sm:flex-row sm:items-center sm:gap-4">
                  <div className="flex items-center justify-between sm:block">
                    <span className="text-[10px] font-bold text-slate-400 dark:text-slate-500 uppercase tracking-widest whitespace-nowrap">Swing TP — Blend ATR ↔ Swing</span>
                    <span className="sm:hidden text-[11px] font-bold font-mono text-emerald-600 dark:text-emerald-400">
                      {Math.round((1 - parseFloat(swingTpBlend || '1')) * 100)}% ATR · {Math.round(parseFloat(swingTpBlend || '1') * 100)}% Sw
                    </span>
                  </div>
                  <div className="flex items-center gap-3 flex-1">
                    <span className="text-[10px] font-bold text-slate-500 dark:text-slate-400 font-mono">ATR</span>
                    <input
                      type="range" min="0" max="1" step="0.05"
                      value={swingTpBlend}
                      onChange={e => setSwingTpBlend(e.target.value)}
                      className="flex-1 h-1.5 rounded-full appearance-none cursor-pointer bg-slate-200 dark:bg-white/15 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-3.5 [&::-webkit-slider-thumb]:h-3.5 [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-emerald-500 [&::-webkit-slider-thumb]:shadow-sm [&::-webkit-slider-thumb]:cursor-pointer [&::-moz-range-thumb]:w-3.5 [&::-moz-range-thumb]:h-3.5 [&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:bg-emerald-500 [&::-moz-range-thumb]:border-0"
                    />
                    <span className="text-[10px] font-bold text-slate-500 dark:text-slate-400 font-mono">Swing</span>
                    <span className="hidden sm:inline text-[11px] font-bold font-mono text-emerald-600 dark:text-emerald-400 w-24 text-right">
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
                {/* Leverage selector — disabilitato se la config usa già leva reale backend */}
                {parseInt(botLeverageStr) > 1 ? (
                  <div className="bg-indigo-50/60 dark:bg-indigo-900/10 rounded-2xl px-6 py-4 border border-indigo-200/60 dark:border-indigo-500/20 flex items-start gap-3">
                    <span className="text-indigo-500 dark:text-indigo-400 mt-0.5 text-base">ℹ</span>
                    <div>
                      <p className="text-[12px] font-semibold text-indigo-700 dark:text-indigo-300">
                        Leva reale {parseInt(botLeverageStr)}× già applicata dal backtest
                      </p>
                      <p className="text-[11px] text-indigo-600/70 dark:text-indigo-400/60 mt-0.5">
                        Il simulatore post-hoc è disabilitato per evitare doppia leva.
                        I risultati già riflettono sizing ×{parseInt(botLeverageStr)} e liquidazione.
                      </p>
                    </div>
                  </div>
                ) : (
                  <div className="bg-slate-50/50 dark:bg-white/[0.02] rounded-2xl px-6 py-4 border border-slate-100 dark:border-white/5">
                    <LeverageSelector value={leverage} onChange={setLeverage} worstTradePct={result.stats.worst_trade_pct} />
                  </div>
                )}
                {/* Leverage compounding warning (solo per simulatore post-hoc) */}
                {parseInt(botLeverageStr) <= 1 && leverage > 1 && (
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

                {/* Reversal vs Trend Split Stats */}
                {(result.reversal_stats || result.trend_stats) && (() => {
                  const rev = result.reversal_stats;
                  const tr  = result.trend_stats;
                  const revTrades = rev?.total_trades ?? 0;
                  const trTrades  = tr?.total_trades  ?? 0;
                  if (revTrades === 0 && trTrades === 0) return null;
                  const StatMini: React.FC<{ label: string; value: string; accent?: string }> = ({ label, value, accent }) => (
                    <div className="flex flex-col gap-0.5">
                      <span className="text-[9px] font-bold text-slate-400 dark:text-slate-500 uppercase tracking-widest">{label}</span>
                      <span className={`text-sm font-black ${accent ?? 'text-slate-900 dark:text-white'}`}>{value}</span>
                    </div>
                  );
                  return (
                    <div className="elegant-card bg-white dark:bg-[#151E32] overflow-hidden">
                      <div className="px-6 py-4 border-b border-slate-100 dark:border-white/5 bg-slate-50/50 dark:bg-white/[0.02]">
                        <h3 className="text-[10px] font-bold text-slate-400 dark:text-slate-500 uppercase tracking-widest flex items-center gap-2">
                          <span className="w-1.5 h-1.5 rounded-full bg-violet-500" />
                          Reversal vs Trend-Following — Breakdown Trade
                        </h3>
                        <p className="text-[10px] text-slate-400 dark:text-slate-500 mt-1">Statistiche separate per origine del segnale. Require reversal_mode_enabled=True.</p>
                      </div>
                      <div className="p-6 grid grid-cols-2 gap-6">
                        {revTrades > 0 && (
                          <div className="space-y-3">
                            <div className="flex items-center gap-2 mb-2">
                              <span className="w-2 h-2 rounded-full bg-violet-500" />
                              <span className="text-[10px] font-bold text-violet-600 dark:text-violet-400 uppercase tracking-widest">Reversal ({revTrades} trade)</span>
                            </div>
                            <StatMini label="Win Rate"       value={`${(rev!.win_rate ?? 0).toFixed(1)}%`} accent={(rev!.win_rate ?? 0) >= 50 ? 'text-emerald-500' : 'text-red-400'} />
                            <StatMini label="Avg Win"        value={`+${(rev!.avg_win_pct ?? 0).toFixed(2)}%`} accent="text-emerald-500" />
                            <StatMini label="Avg Loss"       value={`${(rev!.avg_loss_pct ?? 0).toFixed(2)}%`} accent="text-red-400" />
                            <StatMini label="P&L Totale"     value={`$${(rev!.total_pnl_usd ?? 0).toFixed(0)}`} accent={(rev!.total_pnl_usd ?? 0) >= 0 ? 'text-emerald-500' : 'text-red-400'} />
                            <StatMini label="Avg Hold"       value={`${(rev!.avg_holding_h ?? 0).toFixed(1)}h`} />
                          </div>
                        )}
                        {trTrades > 0 && (
                          <div className="space-y-3">
                            <div className="flex items-center gap-2 mb-2">
                              <span className="w-2 h-2 rounded-full bg-indigo-500" />
                              <span className="text-[10px] font-bold text-indigo-600 dark:text-indigo-400 uppercase tracking-widest">Trend-Following ({trTrades} trade)</span>
                            </div>
                            <StatMini label="Win Rate"       value={`${(tr!.win_rate ?? 0).toFixed(1)}%`} accent={(tr!.win_rate ?? 0) >= 50 ? 'text-emerald-500' : 'text-red-400'} />
                            <StatMini label="Avg Win"        value={`+${(tr!.avg_win_pct ?? 0).toFixed(2)}%`} accent="text-emerald-500" />
                            <StatMini label="Avg Loss"       value={`${(tr!.avg_loss_pct ?? 0).toFixed(2)}%`} accent="text-red-400" />
                            <StatMini label="P&L Totale"     value={`$${(tr!.total_pnl_usd ?? 0).toFixed(0)}`} accent={(tr!.total_pnl_usd ?? 0) >= 0 ? 'text-emerald-500' : 'text-red-400'} />
                            <StatMini label="Avg Hold"       value={`${(tr!.avg_holding_h ?? 0).toFixed(1)}h`} />
                          </div>
                        )}
                        {revTrades === 0 && (
                          <div className="col-span-2 flex items-center gap-3 py-3">
                            <div className="w-8 h-8 rounded-full bg-violet-50 dark:bg-violet-500/10 flex items-center justify-center flex-shrink-0">
                              <svg className="w-4 h-4 text-violet-400" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                                <circle cx="12" cy="12" r="10"/><path d="M12 8v4m0 4h.01"/>
                              </svg>
                            </div>
                            <div>
                              <p className="text-xs font-bold text-slate-700 dark:text-slate-300">Nessun trade reversal nel periodo</p>
                              <p className="text-[10px] text-slate-400 dark:text-slate-500 mt-0.5">
                                Controlla Attività Parametri: <strong>rev_signals</strong> mostra quanti segnali sono stati rilevati.
                                Se 0 = soglia troppo alta. Se segnali ma 0 trade = pending scaduti (usa modalità <strong>Market Close</strong> per diagnosticare).
                              </p>
                            </div>
                          </div>
                        )}
                      </div>
                    </div>
                  );
                })()}

                {/* Parameter Activity Report */}
                {result.param_stats && <ParamActivity ps={result.param_stats} cfg={result.param_config} trades={result.trades} />}
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
                      desc={`RSI < ${exhaustionRsiLow} o ret_48 < −${exhaustionRet48}% → threshold +${exhaustionBoost} (blocca entrate in zona esaurimento)`}
                      checked={exhaustionGuard}
                      onChange={setExhaustionGuard}
                    />
                    {exhaustionGuard && (
                      <div className="space-y-3 pl-1">
                        <Tooltip text="RSI 4H sotto questa soglia = zona ipervenduto → la guard alza il threshold SHORT per ridurre il rischio di shortare vicino a un rimbalzo. Default: 28" pos="top" width="wide">
                          <NumInput label="RSI Ipervenduto (short guard)" value={exhaustionRsiLow} onChange={setExhaustionRsiLow} step="1" min="15" max="45" unit="" />
                        </Tooltip>
                        <Tooltip text="RSI 4H sopra questa soglia = zona ipercomprato → la guard alza il threshold LONG per ridurre il rischio di longare vicino a un pullback. Default: 72" pos="top" width="wide">
                          <NumInput label="RSI Ipercomprato (long guard)" value={exhaustionRsiHigh} onChange={setExhaustionRsiHigh} step="1" min="55" max="85" unit="" />
                        </Tooltip>
                        <Tooltip text="Se il rendimento delle ultime 48 candele 4H supera ±N%, il mercato è overextended — la guard si attiva anche senza RSI estremo. Default: 6%" pos="top" width="wide">
                          <NumInput label="Soglia Rendimento 48 bar (≈8gg)" value={exhaustionRet48} onChange={setExhaustionRet48} step="0.5" min="2" max="20" unit="%" />
                        </Tooltip>
                        <Tooltip text="Quanto viene alzata la soglia direzionale quando la guard scatta. Es. 0.06 con threshold 0.62 → richiede 0.68 per entrare. Default: 0.06" pos="top" width="wide">
                          <NumInput label="Boost Soglia (Δ threshold)" value={exhaustionBoost} onChange={setExhaustionBoost} step="0.01" min="0.01" max="0.20" unit="" />
                        </Tooltip>
                      </div>
                    )}
                    {/* ── Gate avanzati: Exhaustion & Signal Quality ── */}
                    <div className="pt-1 pb-0">
                      <p className="text-[9px] font-semibold uppercase tracking-widest text-slate-400 dark:text-slate-500">Gate avanzati — Exhaustion &amp; Signal Quality</p>
                    </div>
                    <Toggle
                      label="Exhaustion Boost Proporzionale"
                      desc={`Scala il boost ExhaustionGuard in base alla severità del ret_48. A −12% (2× soglia) aggiunge +${exhaustionPropScale} extra. Cap +0.15.`}
                      checked={exhaustionProp}
                      onChange={setExhaustionProp}
                    />
                    {exhaustionProp && (
                      <div className="pl-1">
                        <Tooltip text="Coefficiente: extra_boost = max(0, (|ret48|/soglia − 1) × scala). 0.06 = neutro rispetto al boost fisso. Default: 0.06" pos="top" width="wide">
                          <NumInput label="Coefficiente scala proporzionale" value={exhaustionPropScale} onChange={setExhaustionPropScale} step="0.01" min="0.01" max="0.30" unit="" />
                        </Tooltip>
                      </div>
                    )}
                    <Toggle
                      label="Daily RSI Gate"
                      desc={`Blocca short se RSI daily < ${dailyRsiShortBlock} (capitolazione). Blocca long se RSI daily > ${dailyRsiLongBlock} (euforia). Gate hard — no_trade immediato.`}
                      checked={dailyRsiGate}
                      onChange={setDailyRsiGate}
                    />
                    {dailyRsiGate && (
                      <div className="space-y-3 pl-1">
                        <Tooltip text="Sotto questa soglia RSI daily il mercato è in capitolazione: vietato shortare. Default: 18" pos="top" width="wide">
                          <NumInput label="Blocco Short — RSI daily min" value={dailyRsiShortBlock} onChange={setDailyRsiShortBlock} step="1" min="5" max="35" unit="" />
                        </Tooltip>
                        <Tooltip text="Sopra questa soglia RSI daily il mercato è in euforia: vietato entrare long. Default: 82" pos="top" width="wide">
                          <NumInput label="Blocco Long — RSI daily max" value={dailyRsiLongBlock} onChange={setDailyRsiLongBlock} step="1" min="65" max="95" unit="" />
                        </Tooltip>
                      </div>
                    )}
                    <Toggle
                      label="Volume Climax Gate"
                      desc={`Blocca short se vol_z_50 > ${volClimaxZ}σ e RSI 4H < ${volClimaxRsi}. Volume anomalo su RSI oversold = capitolazione, non trend.`}
                      checked={volClimaxGate}
                      onChange={setVolClimaxGate}
                    />
                    {volClimaxGate && (
                      <div className="space-y-3 pl-1">
                        <Tooltip text="Soglia Z-Score volume anomalo. 2.5σ = top 1% dei bar per volume. Default: 2.5" pos="top" width="wide">
                          <NumInput label="Soglia Volume Z-Score" value={volClimaxZ} onChange={setVolClimaxZ} step="0.1" min="1.0" max="5.0" unit="σ" />
                        </Tooltip>
                        <Tooltip text="Gate attivo solo quando RSI 4H è già oversold. Evita falsi positivi in trend forte. Default: 30" pos="top" width="wide">
                          <NumInput label="RSI 4H Oversold (gate attivo sotto)" value={volClimaxRsi} onChange={setVolClimaxRsi} step="1" min="10" max="50" unit="" />
                        </Tooltip>
                      </div>
                    )}
                    <Toggle
                      label="C2 Forecast Inversion Gate"
                      desc={`Se C2 p50 punta nella direzione opposta al trade di oltre ${(parseFloat(c2InversionPct)*100).toFixed(1)}%, alza la soglia +0.10. Non blocca, rende più esigente.`}
                      checked={c2InversionGate}
                      onChange={setC2InversionGate}
                    />
                    {c2InversionGate && (
                      <div className="pl-1">
                        <Tooltip text="Distanza minima tra C2 p50 e prezzo corrente per attivare il gate. 0.5% = solo previsioni chiaramente opposte. Default: 0.005" pos="top" width="wide">
                          <NumInput label="Soglia inversione C2 (%)" value={c2InversionPct} onChange={setC2InversionPct} step="0.001" min="0.001" max="0.05" unit="" />
                        </Tooltip>
                      </div>
                    )}
                    <Toggle
                      label="Exhaustion Max Hold"
                      desc={`Quando ExhaustionGuard era attivo all'apertura, forza uscita dopo max ${exhaustionMaxHoldBars} bar (${parseInt(exhaustionMaxHoldBars)*4}h). Evita trade in esaurimento troppo lunghi.`}
                      checked={exhaustionMaxHold}
                      onChange={setExhaustionMaxHold}
                    />
                    {exhaustionMaxHold && (
                      <div className="pl-1">
                        <Tooltip text="Limite massimo di permanenza per trade aperti durante esaurimento. Default: 2 bar (8h)" pos="top" width="wide">
                          <NumInput label="Barre massime (4H)" value={exhaustionMaxHoldBars} onChange={setExhaustionMaxHoldBars} step="1" min="1" max="12" unit="bar" />
                        </Tooltip>
                      </div>
                    )}
                    <Toggle
                      label="Transition Guard"
                      desc="Complementare all'Exhaustion Guard: alza entrambe le soglie in proporzione a transition_risk quando il RegimeDetector segnala che il trend sta finendo. Default OFF."
                      checked={transitionGuard}
                      onChange={setTransitionGuard}
                    />
                    {transitionGuard && (
                      <div className="pl-1 space-y-2">
                        <Tooltip text="Boost massimo alla soglia quando transition_risk = 1.0. Es. 0.05 → soglia 0.65 con base 0.60." pos="top" width="wide">
                          <NumInput label="Boost Massimo" value={transitionBoostMax} onChange={setTransitionBoostMax} step="0.01" min="0.02" max="0.10" unit="" />
                        </Tooltip>
                        <Tooltip text="Il guard si attiva solo se transition_risk ≥ questo valore. Default 0.55." pos="top" width="wide">
                          <NumInput label="Rischio Min Attivazione" value={transitionRiskMin} onChange={setTransitionRiskMin} step="0.05" min="0.40" max="0.80" unit="" />
                        </Tooltip>
                      </div>
                    )}
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
                  {/* ATR% Volatility Gate */}
                  <div className="space-y-3">
                    <Toggle
                      label="ATR% Volatility Gate"
                      desc="Blocca o riduce la size quando ATR% (ATR_14/prezzo) scende sotto soglia. Protegge dal fee-drag nei range a bassa volatilità. Soglia empirica BTC 4H: 0.8%."
                      checked={atrPctGateEnabled}
                      onChange={setAtrPctGateEnabled}
                    />
                    {atrPctGateEnabled && (
                      <div className="pl-1 flex flex-col gap-3">
                        <Tooltip text="Soglia ATR% sotto cui il gate si attiva (ATR_14/close × 100). Default 0.8% calibrato su BTC 4H storico. A $100k: 0.8% = ATR < $800." pos="top" width="wide">
                          <NumInput
                            label="Soglia ATR% minima"
                            value={atrPctMin}
                            onChange={setAtrPctMin}
                            step="0.1" min="0.3" max="3.0"
                            unit="%"
                          />
                        </Tooltip>
                        <div className="flex flex-col gap-1.5">
                          <span className="text-[9px] font-bold text-slate-500 dark:text-slate-400 uppercase tracking-widest">Modalità di risposta</span>
                          <div className="flex gap-2">
                            {(['scale', 'block'] as const).map(m => (
                              <button key={m} onClick={() => setAtrPctMode(m)}
                                className={`flex-1 py-1.5 px-2 rounded-lg text-[10px] font-bold border transition-all ${atrPctMode === m
                                  ? m === 'scale'
                                    ? 'bg-amber-500 text-white border-amber-500'
                                    : 'bg-red-500 text-white border-red-500'
                                  : 'bg-white dark:bg-white/5 text-slate-500 border-slate-200 dark:border-white/10'}`}>
                                {m === 'scale' ? '📉 Riduzione Graduale' : '🚫 Blocco Netto'}
                              </button>
                            ))}
                          </div>
                          <p className="text-[9px] text-slate-400 dark:text-slate-500 leading-relaxed">
                            {atrPctMode === 'scale'
                              ? 'Size ridotta linearmente (ATR_curr/soglia), floor ×0.10. Il bot non si blocca mai del tutto.'
                              : 'Nessun trade quando ATR% < soglia. Uscita immediata come il gate ADX.'}
                          </p>
                        </div>
                      </div>
                    )}
                  </div>
                  {/* ── Squeeze Protection Gates ── */}
                  {/* OI Spike Gate */}
                  <div className="space-y-3">
                    <Toggle
                      label="OI Spike Gate (Squeeze Protection)"
                      desc="Blocca o riduce la size quando oi_delta_z supera la soglia (crowding direzionale veloce). Per SHORT: OI in rapida crescita = short affollati = rischio squeeze. Per LONG: OI in rapido calo = long in liquidazione."
                      checked={oiSpikeGateEnabled}
                      onChange={setOiSpikeGateEnabled}
                    />
                    {oiSpikeGateEnabled && (
                      <div className="pl-1 flex flex-col gap-3">
                        <Tooltip text="Soglia z-score di oi_delta_z oltre cui il gate si attiva. Default 2.0σ ≈ il 2% delle barre più estreme." pos="top" width="wide">
                          <NumInput label="Soglia z-score OI" value={oiSpikeThr} onChange={setOiSpikeThr} step="0.1" min="1.0" max="4.0" unit="σ" />
                        </Tooltip>
                        <Tooltip text="Numero di barre 4H da considerare (usa il massimo |oi_delta_z| sulle ultime N barre via lag features). Default 2 = barra corrente + precedente (8h)." pos="top" width="wide">
                          <NumInput label="Lookback" value={oiSpikeLookback} onChange={setOiSpikeLookback} step="1" min="1" max="6" unit="bar" />
                        </Tooltip>
                        <div className="flex flex-col gap-1.5">
                          <span className="text-[9px] font-bold text-slate-500 dark:text-slate-400 uppercase tracking-widest">Modalità di risposta</span>
                          <div className="flex gap-2">
                            {(['scale', 'block'] as const).map(m => (
                              <button key={m} onClick={() => setOiSpikeMode(m)}
                                className={`flex-1 py-1.5 px-2 rounded-lg text-[10px] font-bold border transition-all ${oiSpikeMode === m
                                  ? m === 'scale' ? 'bg-amber-500 text-white border-amber-500' : 'bg-red-500 text-white border-red-500'
                                  : 'bg-white dark:bg-white/5 text-slate-500 border-slate-200 dark:border-white/10'}`}>
                                {m === 'scale' ? '📉 Riduzione Graduale' : '🚫 Blocco Netto'}
                              </button>
                            ))}
                          </div>
                        </div>
                      </div>
                    )}
                  </div>
                  {/* Long/Short Ratio Gate */}
                  <div className="space-y-3">
                    <Toggle
                      label="Long/Short Ratio Gate (Squeeze Protection)"
                      desc="Blocca o riduce la size quando il mercato è eccessivamente posizionato in una direzione (dato Coinalyze L/S). Mercato over-long ≥67% → rischio short squeeze. Disponibile solo per gli ultimi 90 giorni; oltre, il gate resta neutro."
                      checked={lsGateEnabled}
                      onChange={setLsGateEnabled}
                    />
                    {lsGateEnabled && (
                      <div className="pl-1 flex flex-col gap-3">
                        <Tooltip text="Blocca/riduce SHORT quando la % di account long ≥ questa soglia. Default 67% = P75 degli ultimi 90 giorni BTC." pos="top" width="wide">
                          <NumInput label="Block SHORT se long ≥" value={lsLongBlockPct} onChange={setLsLongBlockPct} step="1" min="55" max="80" unit="%" />
                        </Tooltip>
                        <Tooltip text="Blocca/riduce LONG quando la % di account long ≤ questa soglia (mercato over-short). Default 33% simmetrico." pos="top" width="wide">
                          <NumInput label="Block LONG se long ≤" value={lsShortBlockPct} onChange={setLsShortBlockPct} step="1" min="20" max="45" unit="%" />
                        </Tooltip>
                        {lsGateMode === 'scale' && (
                          <Tooltip text="Fattore di riduzione della size in modalità Scale. Default ×0.50 = dimezza la size." pos="top" width="wide">
                            <NumInput label="Scale factor" value={lsGateScaleFactor} onChange={setLsGateScaleFactor} step="0.05" min="0.20" max="0.80" unit="×" />
                          </Tooltip>
                        )}
                        <div className="flex flex-col gap-1.5">
                          <span className="text-[9px] font-bold text-slate-500 dark:text-slate-400 uppercase tracking-widest">Modalità di risposta</span>
                          <div className="flex gap-2">
                            {(['scale', 'block'] as const).map(m => (
                              <button key={m} onClick={() => setLsGateMode(m)}
                                className={`flex-1 py-1.5 px-2 rounded-lg text-[10px] font-bold border transition-all ${lsGateMode === m
                                  ? m === 'scale' ? 'bg-amber-500 text-white border-amber-500' : 'bg-red-500 text-white border-red-500'
                                  : 'bg-white dark:bg-white/5 text-slate-500 border-slate-200 dark:border-white/10'}`}>
                                {m === 'scale' ? '📉 Riduzione Graduale' : '🚫 Blocco Netto'}
                              </button>
                            ))}
                          </div>
                        </div>
                      </div>
                    )}
                  </div>
                  {/* Liquidation Spike Gate */}
                  <div className="space-y-3">
                    <Toggle
                      label="Liquidation Spike Gate (Squeeze Protection)"
                      desc="Blocca o riduce la size quando liq_short_z (per SHORT) o liq_long_z (per LONG) supera la soglia: uno squeeze è già in corso o appena terminato. Default modalità Blocco."
                      checked={liqSpikeGateEnabled}
                      onChange={setLiqSpikeGateEnabled}
                    />
                    {liqSpikeGateEnabled && (
                      <div className="pl-1 flex flex-col gap-3">
                        <Tooltip text="Soglia z-score delle liquidazioni oltre cui il gate si attiva. Default 2.5σ = solo spike davvero anomali." pos="top" width="wide">
                          <NumInput label="Soglia z-score Liq" value={liqSpikeThr} onChange={setLiqSpikeThr} step="0.1" min="1.5" max="5.0" unit="σ" />
                        </Tooltip>
                        <Tooltip text="Barre 4H da esaminare (corrente + lag-1). Default 2." pos="top" width="wide">
                          <NumInput label="Lookback" value={liqSpikeLookback} onChange={setLiqSpikeLookback} step="1" min="1" max="6" unit="bar" />
                        </Tooltip>
                        {liqSpikeMode === 'scale' && (
                          <Tooltip text="Fattore di riduzione della size in modalità Scale. Default ×0.40." pos="top" width="wide">
                            <NumInput label="Scale factor" value={liqSpikeScaleFactor} onChange={setLiqSpikeScaleFactor} step="0.05" min="0.20" max="0.80" unit="×" />
                          </Tooltip>
                        )}
                        <div className="flex flex-col gap-1.5">
                          <span className="text-[9px] font-bold text-slate-500 dark:text-slate-400 uppercase tracking-widest">Modalità di risposta</span>
                          <div className="flex gap-2">
                            {(['block', 'scale'] as const).map(m => (
                              <button key={m} onClick={() => setLiqSpikeMode(m)}
                                className={`flex-1 py-1.5 px-2 rounded-lg text-[10px] font-bold border transition-all ${liqSpikeMode === m
                                  ? m === 'scale' ? 'bg-amber-500 text-white border-amber-500' : 'bg-red-500 text-white border-red-500'
                                  : 'bg-white dark:bg-white/5 text-slate-500 border-slate-200 dark:border-white/10'}`}>
                                {m === 'scale' ? '📉 Riduzione Graduale' : '🚫 Blocco Netto'}
                              </button>
                            ))}
                          </div>
                        </div>
                      </div>
                    )}
                  </div>
                  {/* Weekend Gate */}
                  <div className="space-y-3">
                    <Toggle
                      label="Weekend Gate — Blocca Sabato"
                      desc="Blocca l'apertura di nuovi trade il sabato (orario UTC). Mercati tradizionali chiusi → liquidità sottile e movimenti anomali. Non chiude le posizioni aperte."
                      checked={weekendBlockSaturday}
                      onChange={setWeekendBlockSaturday}
                    />
                    <Toggle
                      label="Weekend Gate — Blocca Domenica"
                      desc="Blocca l'apertura di nuovi trade la domenica (orario UTC). Stessa logica del sabato. I due toggle sono indipendenti: puoi attivarne uno, l'altro o entrambi."
                      checked={weekendBlockSunday}
                      onChange={setWeekendBlockSunday}
                    />
                  </div>
                  {/* 1H LightGBM Gate */}
                  <div className="space-y-3">
                    <Toggle
                      label="1H LightGBM Gate"
                      desc="Applica il modello 1H (lgbm_1h_latest.pkl) come filtro di conferma sul segnale 4H. Per ogni barra 4H usa l'ultima barra 1H chiusa senza lookahead. Richiede il modello 1H addestrato. BLOCK: trade bloccato. REDUCE: size ×0.70."
                      checked={use1hGate}
                      onChange={setUse1hGate}
                    />
                    {use1hGate && (
                      <div className="pl-1 flex flex-col gap-3">
                        <Tooltip text="Soglia di BLOCCO: se P(direzione)_1H < questa soglia il trade è bloccato del tutto. Default 45% = il modello 1H deve dare almeno 45% di probabilità nella direzione del segnale 4H." pos="top" width="wide">
                          <NumInput
                            label="Soglia Blocco 1H"
                            value={lgbm1hBlockThreshold}
                            onChange={setLgbm1hBlockThreshold}
                            step="1" min="30" max="50"
                            unit="%"
                          />
                        </Tooltip>
                        <Tooltip text="Accordo Minimo: se P(direzione)_1H è tra Soglia Blocco e questo valore, il trade è permesso ma con size ridotta a ×0.70. Default 52% = piena size solo se modello 1H supera il 52%." pos="top" width="wide">
                          <NumInput
                            label="Accordo Minimo 1H (size piena)"
                            value={lgbm1hMinAgreement}
                            onChange={setLgbm1hMinAgreement}
                            step="1" min="50" max="70"
                            unit="%"
                          />
                        </Tooltip>
                        <p className="text-[9px] text-slate-400 dark:text-slate-500 leading-relaxed">
                          Fasce: P &lt; {lgbm1hBlockThreshold}% → blocco · {lgbm1hBlockThreshold}%–{lgbm1hMinAgreement}% → size ×0.70 · P ≥ {lgbm1hMinAgreement}% → size piena
                        </p>
                      </div>
                    )}
                  </div>
                  <Toggle
                    label="Binance Cross-Exchange CVD"
                    desc="Fetcha taker_buy_vol da Binance 4H per calcolare CVD reale (~60% del volume BTC perp). Aggiunge 3 feature: binance_cvd_slope, binance_absorption_z, cross_cvd_div. Utile solo dopo un retrain con questo toggle attivo."
                    checked={binanceCvd}
                    onChange={setBinanceCvd}
                  />
                </div>
              </section>

              {/* ── Bounce-Fade Entry ───────────────────────────────────────────── */}
              <section className="space-y-5">
                <h4 className="text-[10px] font-bold text-slate-400 dark:text-slate-500 uppercase tracking-widest flex items-center gap-2">
                  <span className="w-1.5 h-1.5 rounded-full bg-rose-500" />
                  Bounce-Fade Entry
                </h4>
                <div className="space-y-4 bg-slate-50 dark:bg-white/[0.02] p-4 rounded-2xl border border-slate-100 dark:border-white/5">
                  <Toggle
                    label="Bounce-Fade Entry — Entry su Rimbalzi Controtendenza"
                    desc="Su segnali controtendenza (es. short mentre il 4H rimbalza), invece di entrare subito piazza un limite ancorato alla resistenza sovrastante: entry più alto, SL stretto, R:R migliore. Fallback a mercato a scadenza se il segnale persiste. Backtestabile (fill intrabar)."
                    checked={bounceFadeEnabled}
                    onChange={setBounceFadeEnabled}
                  />
                  {bounceFadeEnabled && (
                    <div className="space-y-4 pt-1">
                      <Tooltip text="Frazione della distanza verso la resistenza a cui piazzare il limite. 50% = a metà strada. Più basso = riempie più spesso (entry meno ottimale); più alto = entry migliore ma più fallback. Default 50%." pos="top" width="wide">
                        <NumInput label="Penetration verso resistenza" value={bounceFadePenetration} onChange={setBounceFadePenetration} step="5" min="20" max="80" unit="%" />
                      </Tooltip>
                      <Tooltip text="Cap massimo in ATR: il limite non si allontana più di N×ATR dal prezzo, anche se la resistenza è lontana. Rete di sicurezza per garantire fill. Default 0.5×ATR." pos="top" width="wide">
                        <NumInput label="Cap offset (×ATR)" value={bounceFadeOffsetAtr} onChange={setBounceFadeOffsetAtr} step="0.1" min="0.2" max="1.5" unit="×ATR" />
                      </Tooltip>
                      <Tooltip text="Candele 4H di attesa prima della scadenza. 2 = 8h. Alla scadenza: fallback a mercato (se attivo) o annulla. Default 2." pos="top" width="wide">
                        <NumInput label="Finestra (candele 4H)" value={bounceFadeWindow} onChange={setBounceFadeWindow} step="1" min="1" max="4" />
                      </Tooltip>
                      <Tooltip text="R:R minimo per accettare il fill al limite. Se il rimbalzo lascia un R:R sotto soglia, il trade viene annullato. Default 1.5." pos="top" width="wide">
                        <NumInput label="R:R minimo" value={bounceFadeMinRr} onChange={setBounceFadeMinRr} step="0.1" min="1.0" max="3.0" />
                      </Tooltip>
                      <Tooltip text="Buffer SL sopra la resistenza, in ATR. Default 0.3×ATR." pos="top" width="wide">
                        <NumInput label="Buffer SL (×ATR)" value={bounceFadeSlBuffer} onChange={setBounceFadeSlBuffer} step="0.1" min="0.1" max="1.0" unit="×ATR" />
                      </Tooltip>
                      <Tooltip text="Distanza minima dello SL dall'entry, in ATR (anti-rumore). Lo SL non sarà mai più stretto di questo. Default 0.8×ATR." pos="top" width="wide">
                        <NumInput label="SL minimo (×ATR floor)" value={bounceFadeSlMin} onChange={setBounceFadeSlMin} step="0.1" min="0.1" max="1.5" unit="×ATR" />
                      </Tooltip>
                      <Toggle label="Solo segnali controtendenza" desc="Attiva il bounce-fade solo quando il segnale è opposto al momentum recente (ret_6). Se OFF, si applica a tutti i segnali." checked={bounceFadeCounterOnly} onChange={setBounceFadeCounterOnly} />
                      <Toggle label="Fallback a mercato alla scadenza" desc="Se il limite non viene raggiunto entro la finestra e il segnale è ancora valido, entra comunque a mercato. Garantisce di non perdere segnali persistenti." checked={bounceFadeFallback} onChange={setBounceFadeFallback} />
                    </div>
                  )}
                </div>
              </section>

              {/* ── Pullback Entry ──────────────────────────────────────────────── */}
              <section className="space-y-5">
                <h4 className="text-[10px] font-bold text-slate-400 dark:text-slate-500 uppercase tracking-widest flex items-center gap-2">
                  <span className="w-1.5 h-1.5 rounded-full bg-cyan-500" />
                  Pullback Entry
                </h4>
                <div className="space-y-4 bg-slate-50 dark:bg-white/[0.02] p-4 rounded-2xl border border-slate-100 dark:border-white/5">
                  <Toggle
                    label="Pullback Entry — Timing Ottimizzato"
                    desc="Su candele forti (range > N×ATR), attende un ritracciamento prima di entrare. Migliora R:R strutturalmente. Completamente backtestabile — usa high/low intrabar per simulare il fill."
                    checked={pullbackEnabled}
                    onChange={setPullbackEnabled}
                  />
                  {pullbackEnabled && (
                    <div className="space-y-4 pt-1">
                      <Tooltip text="CORPO candela (close−open) ≥ N×ATR. Misura solo il movimento netto, esclude shadow e doji. 1.2× = top ~7% candele (85% PB rate). 1.5× = top ~4% (87% PB rate). Default: 1.2" pos="top" width="wide">
                        <NumInput
                          label="Soglia Impulso Corpo (×ATR)"
                          value={pullbackImpulseAtr}
                          onChange={setPullbackImpulseAtr}
                          step="0.1" min="0.5" max="3.0"
                          unit="×ATR"
                        />
                      </Tooltip>
                      <Tooltip text="Distanza dalla chiusura 4H (in ATR) che il prezzo deve raggiungere per triggerare l'entrata. 0.3 ≈ 20% del range candela. Default: 0.30" pos="top" width="wide">
                        <NumInput
                          label="Profondità Pullback (×ATR)"
                          value={pullbackZoneAtr}
                          onChange={setPullbackZoneAtr}
                          step="0.05" min="0.1" max="1.0"
                          unit="×ATR"
                        />
                      </Tooltip>
                      <Tooltip text="Finestre di attesa in ore (= numero di candele 4H da attendere). Dopo il timeout scatta il fallback. Default: 3h" pos="top" width="wide">
                        <NumInput
                          label="Finestra Attesa (ore)"
                          value={pullbackWindowH}
                          onChange={setPullbackWindowH}
                          step="1" min="1" max="8"
                          unit="h"
                        />
                      </Tooltip>
                      <Tooltip text="Se scade il timeout ma il prezzo è ancora entro N×ATR dalla chiusura 4H, entra comunque via market. Oltre questa soglia il segnale decade. Default: 0.5" pos="top" width="wide">
                        <NumInput
                          label="Limite Fallback (×ATR)"
                          value={pullbackFallbackAtr}
                          onChange={setPullbackFallbackAtr}
                          step="0.1" min="0.2" max="2.0"
                          unit="×ATR"
                        />
                      </Tooltip>
                    </div>
                  )}
                </div>
              </section>

              {/* ── Reversal Zone Detector ─────────────────────────────────────── */}
              <section className="space-y-5">
                <h4 className="text-[10px] font-bold text-slate-400 dark:text-slate-500 uppercase tracking-widest flex items-center gap-2">
                  <span className="w-1.5 h-1.5 rounded-full bg-violet-500" />
                  Reversal Zone Detector
                </h4>
                <div className="space-y-4 bg-slate-50 dark:bg-white/[0.02] p-4 rounded-2xl border border-slate-100 dark:border-white/5">
                  <Toggle
                    label="Reversal Zone Detector"
                    desc="Identifica top/bottom con 7 componenti pesati (SMC, momentum, exhaustion, volume, regime, funding, candle). Entra solo quando il trend dice no-trade. SL/TP e max_hold separati dal trend-following."
                    checked={reversalEnabled}
                    onChange={setReversalEnabled}
                  />
                  {reversalEnabled && (
                    <div className="space-y-4 pt-1">
                      <div className="space-y-2">
                        <label className="text-[10px] font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-widest">Modalità Entry</label>
                        <div className="flex gap-2">
                          {(['limit_retest', 'close'] as const).map(m => (
                            <button key={m} onClick={() => setReversalEntryMode(m)}
                              className={`flex-1 py-1.5 px-2 rounded-lg text-[10px] font-bold border transition-all ${reversalEntryMode === m ? 'bg-violet-100 dark:bg-violet-500/20 text-violet-600 dark:text-violet-400 border-violet-300 dark:border-violet-500/40' : 'bg-white dark:bg-white/5 text-slate-500 border-slate-200 dark:border-white/10'}`}>
                              {m === 'limit_retest' ? 'Limit Retest (↑ R:R)' : 'Market Close'}
                            </button>
                          ))}
                        </div>
                      </div>
                      <Tooltip text="Score 0–1 aggregato dai 7 componenti. Default 0.34 (calibrato su BTC 4H 3 anni: P99=0.40, max=0.53). Valori alti = meno trade, più selettivi." pos="top" width="wide">
                        <NumInput
                          label="Score Minimo"
                          value={reversalScoreThresh}
                          onChange={setReversalScoreThresh}
                          step="0.01" min="0.25" max="0.70"
                        />
                      </Tooltip>
                      <Tooltip text="Componenti con score > 0.5 che devono essere attivi contemporaneamente. Default 3/7 (solo il 2% delle barre raggiunge 4 componenti)." pos="top" width="wide">
                        <NumInput
                          label="Componenti Minime (su 7)"
                          value={reversalMinComponents}
                          onChange={setReversalMinComponents}
                          step="1" min="2" max="7"
                        />
                      </Tooltip>
                      <Tooltip text="Percentuale della size normale per i trade reversal. Default 50% — conservativo finché non validato." pos="top" width="wide">
                        <NumInput
                          label="Size Factor"
                          value={reversalSizeFactor}
                          onChange={setReversalSizeFactor}
                          step="0.05" min="0.20" max="1.00"
                        />
                      </Tooltip>
                      <div className="grid grid-cols-2 gap-3">
                        <Tooltip text="SL più stretto del trend-following. Default: 1.2 ATR (vs 2.0 ATR trend)." pos="top">
                          <NumInput label="SL (×ATR)" value={reversalSlAtr} onChange={setReversalSlAtr} step="0.1" min="0.5" max="3.0" unit="×ATR" />
                        </Tooltip>
                        <Tooltip text="TP ancorato alla close della candela segnale + N×ATR. Default: 2.5 ATR." pos="top">
                          <NumInput label="TP (×ATR)" value={reversalTpAtr} onChange={setReversalTpAtr} step="0.1" min="1.0" max="6.0" unit="×ATR" />
                        </Tooltip>
                      </div>
                      <Tooltip text="Se il setup non raggiunge questo R:R, il trade viene skippato. In limit_retest mode calibra insieme a wick_pct." pos="top" width="wide">
                        <NumInput
                          label="R:R Minimo"
                          value={reversalRrMin}
                          onChange={setReversalRrMin}
                          step="0.1" min="1.0" max="4.0"
                          unit=":1"
                        />
                      </Tooltip>
                      <Tooltip text="Barre 4H massime per ogni trade reversal. Sempre attivo (non condizionale). Default: 6 barre = 24h." pos="top" width="wide">
                        <NumInput
                          label="Max Hold (barre 4H)"
                          value={reversalMaxHold}
                          onChange={setReversalMaxHold}
                          step="1" min="2" max="20"
                          unit="bars"
                        />
                      </Tooltip>
                      {reversalEntryMode === 'limit_retest' && (
                        <>
                          <Tooltip text="Posizione nel wick: 0% = estremo del wick (R:R massimo), 50% = metà wick. Default: 0.50" pos="top" width="wide">
                            <NumInput
                              label="Posizione nel Wick"
                              value={reversalRetestWickPct}
                              onChange={setReversalRetestWickPct}
                              step="0.05" min="0.0" max="1.0"
                            />
                          </Tooltip>
                          <Tooltip text="Barre 4H di attesa prima che il pending scada. Default: 2 = 8h di finestra." pos="top" width="wide">
                            <NumInput
                              label="Scadenza Pending (barre)"
                              value={reversalExpiry}
                              onChange={setReversalExpiry}
                              step="1" min="1" max="6"
                              unit="bars"
                            />
                          </Tooltip>
                        </>
                      )}
                      {/* Exhaustion calibration */}
                      <div className="space-y-3 p-3 rounded-xl bg-slate-100/60 dark:bg-white/[0.03] border border-slate-200 dark:border-white/8">
                        <p className="text-[9px] font-bold text-slate-500 dark:text-slate-400 uppercase tracking-widest">Soglie Exhaustion</p>
                        <p className="text-[9px] text-slate-400 dark:text-slate-500 leading-relaxed -mt-1">
                          Calibrate per mosse di 2–5 giorni su BTC. Abbassare ADX e Ret48 per segnali più frequenti.
                        </p>
                        <div className="grid grid-cols-3 gap-2">
                          <Tooltip text="ADX minimo per attivare exhaustion. 30 = mosse di medio termine. 35+ = solo trend molto forti." pos="top">
                            <NumInput
                              label="ADX Picco Min"
                              value={reversalAdxPeakMin}
                              onChange={setReversalAdxPeakMin}
                              step="1" min="20" max="50"
                            />
                          </Tooltip>
                          <Tooltip text="Return minimo su 48 barre (8gg) per classificare la mossa come estrema. Mostrato in %. 6% = soglia BTC moderato." pos="top">
                            <NumInput
                              label="Ret 48 Estremo (%)"
                              value={reversalRet48Extreme}
                              onChange={setReversalRet48Extreme}
                              step="1" min="3" max="20"
                              unit="%"
                            />
                          </Tooltip>
                          <Tooltip text="Barre minime in regime prima che l'inversione sia probabile. 20 ≈ 3gg. 40+ = macro-trend." pos="top">
                            <NumInput
                              label="Barre Regime Min"
                              value={reversalBarsInRegime}
                              onChange={setReversalBarsInRegime}
                              step="5" min="5" max="80"
                              unit="bar"
                            />
                          </Tooltip>
                        </div>
                      </div>

                      <Toggle
                        label="Conflict Block"
                        desc="Se trend e reversal sono in direzioni opposte, blocca entrambi. Raccomandato ON."
                        checked={reversalConflictBlock}
                        onChange={setReversalConflictBlock}
                      />
                      <Toggle
                        label="Solo su Trend Hold"
                        desc="ON = reversal apre solo quando trend dice no-trade. OFF = apre anche quando trend concorda (boost). Raccomandato ON."
                        checked={reversalTrendHoldOnly}
                        onChange={setReversalTrendHoldOnly}
                      />
                      <Toggle
                        label="Guard Only (solo blocco)"
                        desc="ON = nessun trade contro-trend; il detector blocca solo i trade trend in zona di esaurimento. OFF = comportamento completo."
                        checked={reversalGuardOnly}
                        onChange={setReversalGuardOnly}
                      />
                    </div>
                  )}
                </div>
              </section>

              {/* ── Re-entry on TP ─────────────────────────────────────────────── */}
              <section className="space-y-5">
                <h4 className="text-[10px] font-bold text-slate-400 dark:text-slate-500 uppercase tracking-widest flex items-center gap-2">
                  <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" />
                  Re-entry on TP
                </h4>
                <div className="space-y-4 bg-slate-50 dark:bg-white/[0.02] p-4 rounded-2xl border border-slate-100 dark:border-white/5">
                  <Toggle
                    label="Re-entry on TP"
                    desc="Riapre nella stessa direzione subito dopo un TP, con conferma 1H e parametri di rischio ridotti."
                    checked={reentryEnabled}
                    onChange={setReentryEnabled}
                  />
                  {reentryEnabled && (
                    <div className="space-y-4 pt-1">
                      <Toggle
                        label="Conferma Gate 1H"
                        desc="Richiede conferma del modello 1H prima di riaprire. Raccomandato ON."
                        checked={reentry1hConfirm}
                        onChange={setReentry1hConfirm}
                      />
                      <div>
                        <p className="text-[10px] font-bold text-slate-500 dark:text-slate-400 uppercase tracking-widest mb-2">
                          LGBM 4H min — <span className="text-emerald-500">{reentryMinLgbm}%</span>
                        </p>
                        <input type="range" min={55} max={85} step={1} value={reentryMinLgbm}
                          onChange={e => setReentryMinLgbm(e.target.value)}
                          className="w-full accent-emerald-500" />
                        <div className="flex justify-between text-[9px] text-slate-400 mt-1"><span>55%</span><span>85%</span></div>
                      </div>
                      {reentry1hConfirm && (
                        <div>
                          <p className="text-[10px] font-bold text-slate-500 dark:text-slate-400 uppercase tracking-widest mb-2">
                            Gate 1H min — <span className="text-emerald-500">{reentryMin1h}%</span>
                          </p>
                          <input type="range" min={50} max={75} step={1} value={reentryMin1h}
                            onChange={e => setReentryMin1h(e.target.value)}
                            className="w-full accent-emerald-500" />
                          <div className="flex justify-between text-[9px] text-slate-400 mt-1"><span>50%</span><span>75%</span></div>
                        </div>
                      )}
                      <div>
                        <p className="text-[10px] font-bold text-slate-500 dark:text-slate-400 uppercase tracking-widest mb-2">
                          Size Factor — <span className="text-emerald-500">×{(parseFloat(reentrySize) / 100).toFixed(2)}</span>
                        </p>
                        <input type="range" min={30} max={100} step={5} value={reentrySize}
                          onChange={e => setReentrySize(e.target.value)}
                          className="w-full accent-emerald-500" />
                        <div className="flex justify-between text-[9px] text-slate-400 mt-1"><span>×0.30</span><span>×1.00</span></div>
                      </div>
                      <div className="grid grid-cols-2 gap-4">
                        <div>
                          <p className="text-[10px] font-bold text-slate-500 dark:text-slate-400 uppercase tracking-widest mb-2">
                            SL — <span className="text-rose-500">{reentrySlAtr}×ATR</span>
                          </p>
                          <input type="range" min={5} max={30} step={1} value={Math.round(parseFloat(reentrySlAtr) * 10)}
                            onChange={e => setReentrySlAtr(String(parseInt(e.target.value) / 10))}
                            className="w-full accent-rose-500" />
                          <div className="flex justify-between text-[9px] text-slate-400 mt-1"><span>0.5×</span><span>3.0×</span></div>
                        </div>
                        <div>
                          <p className="text-[10px] font-bold text-slate-500 dark:text-slate-400 uppercase tracking-widest mb-2">
                            TP — <span className="text-emerald-500">{reentryTpAtr}×ATR</span>
                          </p>
                          <input type="range" min={10} max={80} step={5} value={Math.round(parseFloat(reentryTpAtr) * 10)}
                            onChange={e => setReentryTpAtr(String(parseInt(e.target.value) / 10))}
                            className="w-full accent-emerald-500" />
                          <div className="flex justify-between text-[9px] text-slate-400 mt-1"><span>1.0×</span><span>8.0×</span></div>
                        </div>
                      </div>
                      <p className="text-[9px] text-emerald-700 dark:text-emerald-300/70 bg-emerald-50 dark:bg-emerald-500/5 border border-emerald-100 dark:border-emerald-500/15 rounded-lg p-2">
                        SL strutturale, FVG-SL e pullback disabilitati per il re-entry (nessuna nuova candela 4H). Statistica nei param_stats: reentry_triggered / reentry_blocked_lgbm / reentry_blocked_1h.
                      </p>
                    </div>
                  )}
                </div>
              </section>

              {/* ── Adverse Evidence Monitor ────────────────────────────────────── */}
              <section className="space-y-5">
                <h4 className="text-[10px] font-bold text-slate-400 dark:text-slate-500 uppercase tracking-widest flex items-center gap-2">
                  <span className="w-1.5 h-1.5 rounded-full bg-rose-500" />
                  Adverse Evidence Monitor
                </h4>
                <div className="space-y-4 bg-slate-50 dark:bg-white/[0.02] p-4 rounded-2xl border border-slate-100 dark:border-white/5">
                  <Toggle
                    label="Adverse Evidence Monitor"
                    desc="Monitora il Reversal Detector contro la posizione aperta per N cicli consecutivi. Shadow = solo log. Richiede Reversal Mode nel backtest."
                    checked={adverseMonitor}
                    onChange={setAdverseMonitor}
                  />
                  {adverseMonitor && (
                    <div className="space-y-4 pt-1">
                      <div>
                        <p className="text-[10px] font-bold text-slate-500 dark:text-slate-400 uppercase tracking-widest mb-2">Azione</p>
                        <select
                          value={adverseAction}
                          onChange={e => setAdverseAction(e.target.value as 'shadow' | 'tighten_sl' | 'partial_close' | 'close')}
                          className="w-full text-xs bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg px-3 py-2 text-slate-700 dark:text-slate-300 focus:outline-none focus:ring-1 focus:ring-rose-400"
                        >
                          <option value="shadow">Shadow — solo log (nessun impatto equity)</option>
                          <option value="tighten_sl">Tighten SL — porta SL a breakeven +0.3×ATR</option>
                          <option value="partial_close">Partial Close — chiudi % della posizione</option>
                          <option value="close">Close — chiudi tutto</option>
                        </select>
                      </div>
                      <div>
                        <p className="text-[10px] font-bold text-slate-500 dark:text-slate-400 uppercase tracking-widest mb-2">
                          Score Min — <span className="text-rose-500">{adverseScoreThresh}</span>
                        </p>
                        <input type="range" min={25} max={65} step={1} value={Math.round(parseFloat(adverseScoreThresh) * 100)}
                          onChange={e => setAdverseScoreThresh(String(parseInt(e.target.value) / 100))}
                          className="w-full accent-rose-500" />
                        <div className="flex justify-between text-[9px] text-slate-400 mt-1"><span>0.25</span><span>0.65</span></div>
                      </div>
                      <div className="grid grid-cols-2 gap-4">
                        <div>
                          <p className="text-[10px] font-bold text-slate-500 dark:text-slate-400 uppercase tracking-widest mb-2">
                            Cicli Consecutivi — <span className="text-rose-500">{adverseConfirmCycles}</span>
                          </p>
                          <input type="range" min={1} max={4} step={1} value={adverseConfirmCycles}
                            onChange={e => setAdverseConfirmCycles(e.target.value)}
                            className="w-full accent-rose-500" />
                          <div className="flex justify-between text-[9px] text-slate-400 mt-1"><span>1</span><span>4</span></div>
                        </div>
                        <div>
                          <p className="text-[10px] font-bold text-slate-500 dark:text-slate-400 uppercase tracking-widest mb-2">
                            Hold Min (barre) — <span className="text-rose-500">{adverseMinHold}</span>
                          </p>
                          <input type="range" min={1} max={8} step={1} value={adverseMinHold}
                            onChange={e => setAdverseMinHold(e.target.value)}
                            className="w-full accent-rose-500" />
                          <div className="flex justify-between text-[9px] text-slate-400 mt-1"><span>1</span><span>8</span></div>
                        </div>
                      </div>
                      {adverseAction === 'partial_close' && (
                        <div>
                          <p className="text-[10px] font-bold text-slate-500 dark:text-slate-400 uppercase tracking-widest mb-2">
                            % da Chiudere — <span className="text-rose-500">{adversePartialPct}%</span>
                          </p>
                          <input type="range" min={25} max={75} step={5} value={adversePartialPct}
                            onChange={e => setAdversePartialPct(e.target.value)}
                            className="w-full accent-rose-500" />
                          <div className="flex justify-between text-[9px] text-slate-400 mt-1"><span>25%</span><span>75%</span></div>
                        </div>
                      )}
                      <p className="text-[9px] text-rose-700 dark:text-rose-300/70 bg-rose-50 dark:bg-rose-500/5 border border-rose-100 dark:border-rose-500/15 rounded-lg p-2">
                        Shadow mode non altera l&apos;equity — serve solo a costruire la statistica pm_adverse_monitor per calibrare prima di portare in live.
                      </p>
                    </div>
                  )}
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
                        <div className="grid grid-cols-2 sm:grid-cols-4 gap-1.5">
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
                        {forcedRegime === 'auto' && (
                          <label className={`flex items-center gap-2.5 mt-2.5 p-2.5 rounded-xl cursor-pointer transition-colors ${regimeBiasEnhanced ? 'bg-indigo-50 dark:bg-indigo-500/10 border border-indigo-200 dark:border-indigo-500/25' : 'bg-slate-50 dark:bg-white/[0.03] border border-slate-100 dark:border-white/5'}`}>
                            <div className="relative shrink-0">
                              <input type="checkbox" className="sr-only" checked={regimeBiasEnhanced} onChange={e => setRegimeBiasEnhanced(e.target.checked)} />
                              <div className={`w-8 h-4 rounded-full transition-all duration-300 ${regimeBiasEnhanced ? 'bg-indigo-600' : 'bg-slate-200 dark:bg-white/10'}`} />
                              <div className={`absolute top-0.5 left-0.5 w-3 h-3 bg-white rounded-full shadow-sm transition-transform duration-300 ${regimeBiasEnhanced ? 'translate-x-4' : ''}`} />
                            </div>
                            <div>
                              <p className={`text-[10px] font-bold ${regimeBiasEnhanced ? 'text-indigo-600 dark:text-indigo-400' : 'text-slate-500 dark:text-slate-400'}`}>
                                Regime Detection Avanzato
                                {regimeBiasEnhanced && <span className="ml-1.5 px-1 py-0.5 rounded text-[8px] font-bold bg-indigo-100 dark:bg-indigo-500/20 text-indigo-600 dark:text-indigo-400 uppercase tracking-wider">Attivo</span>}
                              </p>
                              <p className="text-[9px] text-slate-400 dark:text-slate-500 mt-0.5">
                                {regimeBiasEnhanced
                                  ? 'ADX slope · transition_risk · confidence — delta modulato dinamicamente'
                                  : 'Semplice: EMA20 + ADX > 20 (più reattivo, meno preciso)'}
                              </p>
                            </div>
                          </label>
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
                      <div className="pl-12 grid grid-cols-1 sm:grid-cols-2 gap-4">
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
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
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
            apiFetch(`${apiBase}/presets`)
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
