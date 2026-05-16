import React, { useEffect, useState } from 'react';
import { Tooltip } from './Tooltip';

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

interface TradeEvent {
  id: string;
  kind: 'sl_moved' | 'be_sl' | 'partial_tp' | 'tp2_hit' | 'sl_hit';
  payload: Record<string, number | string | boolean | null>;
  time: string;
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
  const [trades,       setTrades]       = useState<Trade[]>([]);
  const [logs,         setLogs]         = useState<InferenceLog[]>([]);
  const [expanded,     setExpanded]     = useState<string | null>(null);
  const [expandedTrade, setExpandedTrade] = useState<string | null>(null);
  const [tradeEvents,  setTradeEvents]  = useState<Record<string, TradeEvent[]>>({});
  const [loadingEvents, setLoadingEvents] = useState<string | null>(null);
  const [tab,          setTab]          = useState<'trades' | 'inference'>('trades');
  const [loading,      setLoading]      = useState(true);

  const loadTradeEvents = async (tradeId: string) => {
    if (tradeEvents[tradeId] !== undefined) return; // already loaded
    setLoadingEvents(tradeId);
    try {
      const r = await fetch(`${apiBase}/trade-events?trade_id=${tradeId}&limit=50`);
      const data: TradeEvent[] = r.ok ? await r.json() : [];
      setTradeEvents(prev => ({ ...prev, [tradeId]: data }));
    } catch {
      setTradeEvents(prev => ({ ...prev, [tradeId]: [] }));
    } finally {
      setLoadingEvents(null);
    }
  };

  const toggleTradeExpand = (id: string) => {
    if (expandedTrade === id) {
      setExpandedTrade(null);
    } else {
      setExpandedTrade(id);
      loadTradeEvents(id);
    }
  };

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
        <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-6 gap-4">
          <Tooltip text="Numero totale di trade completati (con entrata e uscita)." pos="bottom">
            <StatChip label="Trade chiusi" value={String(closed.length)} />
          </Tooltip>
          <Tooltip text="Percentuale di trade chiusi in profitto. Sopra 55% è ottimo, sopra 50% è accettabile se il R:R è favorevole." pos="bottom">
            <StatChip
              label="Win Rate"
              value={`${winRate.toFixed(1)}%`}
              color={winRate >= 55 ? 'text-emerald-600 dark:text-emerald-400' : winRate >= 50 ? 'text-amber-600 dark:text-amber-400' : 'text-rose-600 dark:text-rose-400'}
            />
          </Tooltip>
          <Tooltip text="Somma di tutti i profitti e perdite realizzati su trade chiusi." pos="bottom">
            <StatChip
              label="PnL Totale"
              value={`${totalPnl >= 0 ? '+' : ''}$${totalPnl.toFixed(2)}`}
              color={totalPnl >= 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-rose-600 dark:text-rose-400'}
            />
          </Tooltip>
          <Tooltip text="Guadagno medio percentuale dei trade in profitto. Indica quanto si guadagna in media quando il trade va bene." pos="bottom">
            <StatChip label="Avg Win" value={`+${avgWin.toFixed(2)}%`} color="text-emerald-600 dark:text-emerald-400" />
          </Tooltip>
          <Tooltip text="Perdita media percentuale dei trade in negativo. Indica quanto si perde in media quando il trade va male." pos="bottom">
            <StatChip label="Avg Loss" value={`${avgLoss.toFixed(2)}%`} color="text-rose-600 dark:text-rose-400" />
          </Tooltip>
          {pf !== null && (
            <Tooltip text="Profitti totali diviso perdite totali. Sopra 1.5 è buono, sopra 2.0 è eccellente. Sotto 1.0 significa che le perdite superano i guadagni." pos="bottom">
              <StatChip
                label="Profit Factor"
                value={pf.toFixed(2)}
                color={pf >= 1.5 ? 'text-emerald-600 dark:text-emerald-400' : pf >= 1.0 ? 'text-amber-600 dark:text-amber-400' : 'text-rose-600 dark:text-rose-400'}
              />
            </Tooltip>
          )}
        </div>
      )}

      {/* ── Tabs ──────────────────────────────────────────────────────────── */}
      <div className="flex gap-4 p-1.5 bg-slate-100 dark:bg-white/5 rounded-2xl w-fit">
        <TabBtn active={tab === 'trades'}    onClick={() => setTab('trades')}>
          Trades Chiuse ({trades.length})
        </TabBtn>
        <TabBtn active={tab === 'inference'} onClick={() => setTab('inference')}>
          Inference Intelligence ({logs.length})
        </TabBtn>
      </div>

      {/* ── Trades table ──────────────────────────────────────────────────── */}
      {tab === 'trades' && (
        <div className="elegant-card bg-white dark:bg-[#151E32] overflow-hidden">
          {loading ? (
            <div className="p-12 text-center text-slate-500 dark:text-slate-400 text-sm font-medium">Caricamento storico operazioni…</div>
          ) : trades.length === 0 ? (
            <div className="p-12 text-center text-slate-500 dark:text-slate-400 text-sm italic">
              Nessun trade registrato. Avvia il bot in modalità Paper Trading.
            </div>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-slate-100 dark:border-white/5 text-[10px] text-slate-400 dark:text-slate-500 font-bold uppercase tracking-widest bg-slate-50/50 dark:bg-white/[0.02]">
                  <th className="px-6 py-4 text-left">Data apertura</th>
                  <th className="px-4 py-3 text-left">
                    <Tooltip text="Direzione del trade: LONG = scommessa che il prezzo salga, SHORT = scommessa che scenda." pos="bottom">
                      <span>Side</span>
                    </Tooltip>
                  </th>
                  <th className="px-4 py-3 text-right">
                    <Tooltip text="Profitto o perdita netta in USD dopo le commissioni di trading." pos="bottom">
                      <span>PnL netto</span>
                    </Tooltip>
                  </th>
                  <th className="px-4 py-3 text-left hidden sm:table-cell">
                    <Tooltip text="Motivo di chiusura: stop_loss = prezzo raggiunto il limite di perdita, take_profit = raggiunto l'obiettivo, kill = chiuso manualmente, manual = chiusura utente." pos="bottom" width="wide">
                      <span>Chiusura</span>
                    </Tooltip>
                  </th>
                  <th className="px-4 py-3 text-right hidden sm:table-cell">
                    <Tooltip text="Per quanto tempo il trade è rimasto aperto (ore e minuti)." pos="bottom">
                      <span>Durata</span>
                    </Tooltip>
                  </th>
                </tr>
              </thead>
              <tbody>
                {trades.map(t => {
                  const pnl      = t.pnl_usd ?? 0;
                  const pnlPct   = t.pnl_pct ?? 0;
                  const isOpen   = !t.closed_at;
                  const isExpTrade = expandedTrade === t.id;
                  const events   = tradeEvents[t.id] ?? null;
                  return (
                    <React.Fragment key={t.id}>
                      <tr
                        onClick={() => toggleTradeExpand(t.id)}
                        className={`border-b border-slate-50 dark:border-white/5 cursor-pointer transition-colors group ${isExpTrade ? 'bg-slate-50/80 dark:bg-white/[0.03]' : 'hover:bg-slate-50/50 dark:hover:bg-white/[0.02]'}`}
                      >
                        <td className="px-6 py-4 font-mono text-slate-500 dark:text-slate-400 text-xs">
                          <div className="flex items-center gap-2">
                            <svg className={`w-3 h-3 text-slate-300 dark:text-slate-600 transition-transform duration-200 ${isExpTrade ? 'rotate-90' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7"/></svg>
                            {new Date(t.opened_at).toLocaleString('it-IT', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}
                          </div>
                        </td>
                        <td className="px-6 py-4">
                          <span className={`px-2 py-1 rounded-lg text-[10px] font-bold uppercase tracking-wider ${
                            t.side === 'long' ? 'bg-emerald-50 dark:bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border border-emerald-100 dark:border-emerald-500/20'
                                             : 'bg-rose-50 dark:bg-rose-500/10 text-rose-600 dark:text-rose-400 border border-rose-100 dark:border-rose-500/20'
                          }`}>
                            {t.side?.toUpperCase()}
                          </span>
                        </td>
                        <td className={`px-6 py-4 text-right font-mono font-bold text-xs ${
                          isOpen ? 'text-amber-500' : pnl >= 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-rose-600 dark:text-rose-400'
                        }`}>
                          {isOpen ? (
                            <span className="opacity-60 italic">In corso…</span>
                          ) : (
                            <>
                              {pnl >= 0 ? '+' : ''}${pnl.toFixed(2)}
                              <span className="text-[10px] ml-1.5 opacity-60">
                                ({pnlPct >= 0 ? '+' : ''}{pnlPct.toFixed(2)}%)
                              </span>
                            </>
                          )}
                        </td>
                        <td className="px-6 py-4 text-slate-500 dark:text-slate-400 text-xs hidden sm:table-cell">
                          {t.reason_close
                            ? <ReasonBadge reason={t.reason_close} />
                            : <span className="text-slate-400 italic">—</span>}
                        </td>
                        <td className="px-6 py-4 text-right font-mono text-slate-400 dark:text-slate-500 text-xs hidden sm:table-cell">
                          {hms(t.holding_sec)}
                        </td>
                      </tr>
                      {/* ── Event timeline (expanded) ── */}
                      {isExpTrade && (
                        <tr className="border-b border-slate-100 dark:border-white/5">
                          <td colSpan={5} className="px-6 py-4 bg-slate-50/50 dark:bg-black/10">
                            {loadingEvents === t.id ? (
                              <p className="text-xs text-slate-400 italic">Caricamento eventi…</p>
                            ) : events && events.length > 0 ? (
                              <TradeTimeline events={events} openedAt={t.opened_at} closedAt={t.closed_at} side={t.side} />
                            ) : (
                              <p className="text-xs text-slate-400 dark:text-slate-500 italic">
                                Nessun evento registrato per questo trade.
                                {!events && ' (tabella trade_events non ancora creata su Supabase)'}
                              </p>
                            )}
                          </td>
                        </tr>
                      )}
                    </React.Fragment>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      )}

      {/* ── Inference log ─────────────────────────────────────────────────── */}
      {tab === 'inference' && (
        <div className="space-y-3">
          {loading ? (
            <div className="p-12 text-center text-slate-500 dark:text-slate-400 text-sm font-medium">Caricamento log decisioni AI…</div>
          ) : logs.length === 0 ? (
            <div className="p-12 text-center text-slate-500 dark:text-slate-400 text-sm italic">Nessun log disponibile. Il bot deve completare almeno un ciclo di analisi.</div>
          ) : (
            logs.map(log => (
              <div key={log.id} className="elegant-card bg-white dark:bg-[#151E32] overflow-hidden">
                {/* Header row */}
                <button
                  onClick={() => setExpanded(expanded === log.id ? null : log.id)}
                  className="w-full px-6 py-5 flex items-center justify-between text-left hover:bg-slate-50 dark:hover:bg-white/[0.02] transition-all"
                >
                  <div className="flex items-center gap-4">
                    <DecisionBadge decision={log.decision} />
                    <span className="text-xs font-bold text-slate-500 dark:text-slate-400 font-mono">
                      {new Date(log.time).toLocaleString('it-IT')}
                    </span>
                    {log.forecast?.latency_ms && (
                      <span className="text-xs text-slate-400 dark:text-slate-500 font-mono hidden sm:inline px-2 py-0.5 bg-slate-100 dark:bg-white/5 rounded">
                        {log.forecast.latency_ms.toFixed(0)}ms
                      </span>
                    )}
                  </div>
                  <span className="text-slate-400 group-hover:text-slate-600 transition-colors">
                     <svg className={`w-5 h-5 transition-transform duration-300 ${expanded === log.id ? 'rotate-180' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" /></svg>
                  </span>
                </button>

                {/* Expanded detail */}
                {expanded === log.id && (
                  <div className="px-6 pb-6 space-y-8 border-t border-slate-100 dark:border-white/5 pt-6 bg-slate-50/30 dark:bg-black/5">

                    {/* Reasoning */}
                    <div>
                      <h4 className="text-[10px] font-bold text-slate-400 dark:text-slate-500 uppercase tracking-widest mb-4 flex items-center gap-2">
                         <span className="w-1 h-3 bg-indigo-500 rounded-full"></span>
                         Reasoning Intelligence Pipeline
                      </h4>
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                        {(log.reasoning ?? []).map((r, i) => (
                          <div key={i} className={`text-xs font-bold font-mono px-4 py-2.5 rounded-xl border transition-all ${
                            r.startsWith('GATE') ? 'bg-rose-50 dark:bg-rose-500/10 text-rose-600 dark:text-rose-400 border-rose-100 dark:border-rose-500/20'
                            : r.startsWith('LONG') ? 'bg-emerald-50 dark:bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-100 dark:border-emerald-500/20'
                            : r.startsWith('SHORT') ? 'bg-rose-50 dark:bg-rose-500/10 text-rose-600 dark:text-rose-400 border-rose-100 dark:border-rose-500/20'
                            : r.startsWith('MTF') ? 'bg-indigo-50 dark:bg-indigo-500/10 text-indigo-600 dark:text-indigo-400 border-indigo-100 dark:border-indigo-500/20'
                            : r.startsWith('FILTER') ? 'bg-amber-50 dark:bg-amber-500/10 text-amber-600 dark:text-amber-400 border-amber-100 dark:border-amber-500/20'
                            : 'bg-white dark:bg-white/5 text-slate-600 dark:text-slate-400 border-slate-100 dark:border-white/5'
                          }`}>
                            <span className="opacity-40 mr-2">→</span> {r}
                          </div>
                        ))}
                      </div>
                    </div>

                    {/* Chronos-2 + LightGBM output */}
                    {log.forecast && (
                      <div>
                        <h4 className="text-[10px] font-bold text-slate-400 dark:text-slate-500 uppercase tracking-widest mb-4 flex items-center gap-2">
                           <span className="w-1 h-3 bg-purple-500 rounded-full"></span>
                           Ensemble Model Output
                        </h4>
                        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3 text-xs font-mono">
                          <Tooltip text="Probabilità Chronos-2 che il prezzo salga nel prossimo orizzonte di 12 ore." pos="bottom">
                            <FCell label="C2 P(up)" value={`${((log.forecast.c2_dir_prob ?? 0) * 100).toFixed(1)}%`} />
                          </Tooltip>
                          <Tooltip text="Probabilità LightGBM che il prezzo salga. Modello basato su feature tecniche e on-chain." pos="bottom">
                            <FCell label="LGBM P(up)" value={`${((log.forecast.lgbm_prob ?? 0) * 100).toFixed(1)}%`} />
                          </Tooltip>
                          <Tooltip text="Percentile 10: prezzo pessimistico. Il 10% delle simulazioni prevede un prezzo sotto questo livello." pos="bottom">
                            <FCell label="p10" value={`$${(log.forecast.c2_p10 ?? 0).toFixed(0)}`} />
                          </Tooltip>
                          <Tooltip text="Percentile 50: prezzo mediano. La metà delle simulazioni prevede un prezzo sopra, l'altra metà sotto." pos="bottom">
                            <FCell label="p50" value={`$${(log.forecast.c2_p50 ?? 0).toFixed(0)}`} highlight />
                          </Tooltip>
                          <Tooltip text="Percentile 90: prezzo ottimistico. Il 10% delle simulazioni prevede un prezzo sopra questo livello." pos="bottom">
                            <FCell label="p90" value={`$${(log.forecast.c2_p90 ?? 0).toFixed(0)}`} />
                          </Tooltip>
                          <Tooltip text="Tempo impiegato dall'ensemble (Chronos-2 + LightGBM) per completare l'inferenza e produrre la decisione." pos="bottom">
                            <FCell label="Latency" value={`${(log.forecast.latency_ms ?? 0).toFixed(0)}ms`} />
                          </Tooltip>
                        </div>
                      </div>
                    )}

                    {/* Key features */}
                    {log.features && (
                      <div>
                        <h4 className="text-[10px] font-bold text-slate-400 dark:text-slate-500 uppercase tracking-widest mb-4 flex items-center gap-2">
                           <span className="w-1 h-3 bg-slate-400 rounded-full"></span>
                           Market Signal Features
                        </h4>
                        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-4">
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

// ── Trade Timeline ────────────────────────────────────────────────────────────

const EVENT_META: Record<string, { icon: string; label: string; colorClass: string }> = {
  sl_moved:   { icon: '🔔', label: 'Trailing SL aggiornato', colorClass: 'border-l-indigo-400 bg-indigo-50/50 dark:bg-indigo-500/5' },
  be_sl:      { icon: '🔒', label: 'Breakeven SL attivato',  colorClass: 'border-l-slate-400 bg-slate-50/50 dark:bg-slate-500/5' },
  partial_tp: { icon: '⚡', label: 'Partial TP eseguito',    colorClass: 'border-l-amber-400 bg-amber-50/50 dark:bg-amber-500/5' },
  tp2_hit:    { icon: '✅', label: 'Take Profit finale',     colorClass: 'border-l-emerald-500 bg-emerald-50/50 dark:bg-emerald-500/5' },
  sl_hit:     { icon: '❌', label: 'Stop Loss colpito',      colorClass: 'border-l-rose-500 bg-rose-50/50 dark:bg-rose-500/5' },
};

const fmt = (n: number) => n.toLocaleString('en-US', { maximumFractionDigits: 0 });

const TradeTimeline: React.FC<{
  events: TradeEvent[];
  openedAt: string;
  closedAt: string | null;
  side: string;
}> = ({ events, openedAt, closedAt, side }) => (
  <div className="flex flex-col gap-2 py-1">
    {/* Open row */}
    <div className="flex items-start gap-3 pl-2 text-xs">
      <span className="text-[10px] font-mono text-slate-400 w-28 shrink-0 pt-0.5">
        {new Date(openedAt).toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' })}
      </span>
      <div className="flex-1 px-3 py-2 border-l-2 border-l-emerald-400 bg-emerald-50/50 dark:bg-emerald-500/5 rounded-r-xl">
        <span className="font-bold text-emerald-700 dark:text-emerald-400">📈 TRADE APERTO · {side.toUpperCase()}</span>
      </div>
    </div>

    {/* Event rows */}
    {events.map(ev => {
      const meta = EVENT_META[ev.kind] ?? { icon: '•', label: ev.kind, colorClass: 'border-l-slate-300 bg-slate-50/30' };
      const p    = ev.payload;
      return (
        <div key={ev.id} className="flex items-start gap-3 pl-2 text-xs">
          <span className="text-[10px] font-mono text-slate-400 w-28 shrink-0 pt-0.5">
            {new Date(ev.time).toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' })}
          </span>
          <div className={`flex-1 px-3 py-2 border-l-2 rounded-r-xl ${meta.colorClass}`}>
            <span className="font-bold text-slate-700 dark:text-slate-300">{meta.icon} {meta.label}</span>
            {ev.kind === 'sl_moved' && p.sl_old != null && p.sl_new != null && (
              <span className="ml-2 font-mono text-slate-500 dark:text-slate-400">
                ${fmt(Number(p.sl_old))} → ${fmt(Number(p.sl_new))}
              </span>
            )}
            {ev.kind === 'partial_tp' && p.pnl_usd != null && (
              <span className="ml-2 font-mono text-amber-600 dark:text-amber-400">
                {Number(p.pct_closed).toFixed(0)}% · +${Number(p.pnl_usd).toFixed(2)}
              </span>
            )}
            {ev.kind === 'be_sl' && p.sl_new != null && (
              <span className="ml-2 font-mono text-slate-500 dark:text-slate-400">
                SL → ${fmt(Number(p.sl_new))}
              </span>
            )}
          </div>
        </div>
      );
    })}

    {/* Close row */}
    {closedAt && (
      <div className="flex items-start gap-3 pl-2 text-xs">
        <span className="text-[10px] font-mono text-slate-400 w-28 shrink-0 pt-0.5">
          {new Date(closedAt).toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' })}
        </span>
        <div className="flex-1 px-3 py-2 border-l-2 border-l-slate-300 dark:border-l-slate-600 bg-slate-50/30 dark:bg-slate-700/10 rounded-r-xl">
          <span className="font-bold text-slate-500 dark:text-slate-400">🔚 TRADE CHIUSO</span>
        </div>
      </div>
    )}
  </div>
);

// ── Sub-components ────────────────────────────────────────────────────────────

const StatChip: React.FC<{ label: string; value: string; color?: string }> = ({ label, value, color = 'text-slate-900 dark:text-white' }) => (
  <div className="elegant-card px-5 py-4 bg-white dark:bg-[#151E32]">
    <p className="text-[10px] font-bold text-slate-400 dark:text-slate-500 uppercase tracking-widest mb-1.5">{label}</p>
    <p className={`text-lg font-bold font-mono tracking-tight ${color}`}>{value}</p>
  </div>
);

const TabBtn: React.FC<{ active: boolean; onClick: () => void; children: React.ReactNode }> = ({ active, onClick, children }) => (
  <button
    onClick={onClick}
    className={`px-6 py-2.5 rounded-xl text-xs font-bold uppercase tracking-widest transition-all ${
      active ? 'bg-indigo-600 text-white shadow-lg shadow-indigo-500/20' : 'text-slate-500 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white'
    }`}
  >
    {children}
  </button>
);

const DecisionBadge: React.FC<{ decision: string }> = ({ decision }) => (
  <span className={`px-2.5 py-1 rounded-lg text-[10px] font-bold uppercase tracking-widest border ${
    decision === 'long'  ? 'bg-emerald-50 dark:bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-100 dark:border-emerald-500/20'
    : decision === 'short' ? 'bg-rose-50 dark:bg-rose-500/10 text-rose-600 dark:text-rose-400 border-rose-100 dark:border-rose-500/20'
    : 'bg-slate-100 dark:bg-white/5 text-slate-500 dark:text-slate-400 border-slate-200 dark:border-white/10'
  }`}>
    {decision?.toUpperCase()}
  </span>
);

const ReasonBadge: React.FC<{ reason: string }> = ({ reason }) => {
  const map: Record<string, string> = {
    stop_loss:   'bg-rose-50 dark:bg-rose-500/10 text-rose-600 dark:text-rose-400 border border-rose-100 dark:border-rose-500/20',
    take_profit: 'bg-emerald-50 dark:bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border border-emerald-100 dark:border-emerald-500/20',
    kill:        'bg-amber-50 dark:bg-amber-500/10 text-amber-600 dark:text-amber-400 border border-amber-100 dark:border-amber-500/20',
    manual:      'bg-slate-50 dark:bg-white/5 text-slate-500 dark:text-slate-400 border border-slate-200 dark:border-white/10',
  };
  return (
    <span className={`px-2 py-0.5 rounded-lg text-[10px] font-bold uppercase tracking-wider ${map[reason] ?? 'bg-slate-50 dark:bg-white/5 text-slate-500 dark:text-slate-400 border border-slate-200 dark:border-white/10'}`}>
      {reason.replace('_', ' ')}
    </span>
  );
};

const FCell: React.FC<{ label: string; value: string; highlight?: boolean }> = ({ label, value, highlight }) => (
  <div className={`rounded-xl px-3 py-2 border transition-all ${highlight ? 'bg-indigo-50 dark:bg-indigo-500/10 border-indigo-100 dark:border-indigo-500/20' : 'bg-white dark:bg-white/5 border-slate-100 dark:border-white/5'}`}>
    <p className="text-slate-400 dark:text-slate-500 text-[10px] font-bold uppercase tracking-widest mb-1">{label}</p>
    <p className={`text-sm font-bold font-mono ${highlight ? 'text-indigo-600 dark:text-indigo-400' : 'text-slate-700 dark:text-slate-300'}`}>{value}</p>
  </div>
);

const FeatureCell: React.FC<{ label: string; value: number; desc: string }> = ({ label, value, desc }) => {
  const formatted = Math.abs(value) >= 1000 ? value.toFixed(0)
    : Math.abs(value) >= 1 ? value.toFixed(2) : value.toFixed(4);
  const isPositive = value > 0;

  return (
    <div className="bg-white dark:bg-white/5 border border-slate-100 dark:border-white/5 rounded-xl px-4 py-3 group relative transition-all hover:border-slate-300 dark:hover:border-white/10" title={desc}>
      <p className="text-[10px] font-bold text-slate-400 dark:text-slate-500 uppercase tracking-widest mb-1.5">{label}</p>
      <p className={`text-sm font-bold font-mono ${
        isPositive ? 'text-emerald-600 dark:text-emerald-400' : value < 0 ? 'text-rose-600 dark:text-rose-400' : 'text-slate-500 dark:text-slate-400'
      }`}>
        {value > 0 ? '+' : ''}{formatted}
      </p>
    </div>
  );
};
