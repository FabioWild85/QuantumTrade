import React, { useEffect, useRef, useState } from 'react';
import { Tooltip } from './Tooltip';

// Returns seconds until next 4h candle close (00:00, 04:00, 08:00, 12:00, 16:00, 20:00 UTC)
function secsToNext4h(): number {
  const now = Date.now();
  const interval = 4 * 3600 * 1000;
  return Math.ceil((interval - (now % interval)) / 1000);
}

interface Position {
  side: string;
  entry_price: number;
  stop_loss: number;
  take_profit: number;
  sl_original: number;
  size_usd: number;
  size_contracts: number;
  opened_at: string;
  bars_held: number;
  high_water: number;
  sl_trailing_active: boolean;
  be_sl_applied: boolean;
  partial_done: boolean;
  partial_realized_pnl: number;
  lgbm_strikes: number;
  trend_strikes: number;
  partial_tp_price: number | null;
  trailing_sl_activation_price: number | null;
  trailing_sl_dist: number | null;
  entry_atr: number | null;
  entry_reasoning?: string[];
  leverage?: number;
  liq_px?: number;
  margin_usd?: number;
}

interface TrendMeterData {
  display_score: number;
  predictive: number;
  label: string;
  side: string;
  updated_at: string;
  strategic_4h?: {
    score: number;
    components: { direction?: number; adx: number; mtf: number; c2_cont?: number };
    ensemble: number | null;
    chronos: boolean;
    ml_pending?: boolean;
    updated_at: string;
    source?: 'fresh' | 'cycle';
  };
  tactical_1h?: {
    score: number;
    components: { gate_prob: number };
    lgbm_1h_prob: number;
    model_available: boolean;
    updated_at: string;
    error?: string;
  };
  pulse_15m?: {
    score: number;
    components: { direction_4c?: number; ema_8?: number };
    updated_at: string;
    error?: string;
  };
}

interface BotStatus {
  running: boolean;
  mode: string;
  hl_testnet: boolean;
  equity: number;
  position: Position | null;
  mark_price: number | null;
  ws_connected: boolean;
  model_loaded: boolean;
  cycle_count: number;
  config?: {
    lgbm_exit_confirm_bars?: number;
    be_sl_enabled?: boolean;
    partial_tp_enabled?: boolean;
    trailing_sl_enabled?: boolean;
    chronos_enabled?: boolean;
    [key: string]: unknown;
  };
  last_cycle_signals?: {
    action: string;
    ensemble_pct: number;
    lgbm_pct: number;
    c2_dir_pct: number;
    c2_p50: number | null;
    c2_cont_prob: number;
    reasoning: string[];
    updated_at: string;
  } | null;
  trend_meter?: TrendMeterData | null;
  macro_pause_active?: string | null;
  retrain_due?: boolean;
  pending_pullback?: {
    direction: string;
    pullback_zone: number;
    fallback_limit: number;
    expires_at: string;
    ob_order_id: string | null;
    ob_sl_price: number | null;
    close_4h: number;
    atr_at_signal: number;
  } | null;
}

interface InferenceLog {
  id: string;
  time: string;
  decision: string;
  reasoning: string[];
  forecast: Record<string, number>;
  latency_ms: number;
}

interface ServerEvent {
  id: string;
  time: string;
  kind: string;
  severity: string;
  message: string;
  payload: {
    signal?: string;
    open_side?: string;
    ensemble_pct?: number;
    is_opposite?: boolean;
    reasoning?: string[];
    inference_id?: string;
    [key: string]: unknown;
  };
}

interface EquitySnap {
  time: string;
  equity_usd: number;
  realized_pnl: number;
  drawdown_pct: number;
}

interface LiveAccount {
  configured: boolean;
  error?: string;
  account_value?: number;
  total_margin_used?: number;
  total_ntl_pos?: number;
  withdrawable?: number;
  positions?: Array<{
    coin: string;
    side: string;
    size: number;
    entry_price: number;
    unrealized_pnl: number;
    return_on_equity: number;
    leverage_value: number;
    leverage_type: string;
  }>;
}

const INITIAL_EQUITY = 10_000;
const LS_KEY = 'qt_bot_status_cache';

function readStatusCache(): BotStatus | null {
  try {
    const raw = localStorage.getItem(LS_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

function writeStatusCache(s: BotStatus | null) {
  try {
    if (s) localStorage.setItem(LS_KEY, JSON.stringify(s));
  } catch {}
}

// ── Confirmation Modal ────────────────────────────────────────────────────────

interface ModalState {
  title: string;
  message: string;
  confirmLabel: string;
  variant: 'danger' | 'warning';
  onConfirm: () => void;
}

const ConfirmModal: React.FC<ModalState & { onCancel: () => void }> = ({
  title, message, confirmLabel, variant, onConfirm, onCancel,
}) => {
  const isDanger = variant === 'danger';
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onCancel} />
      <div className="relative z-10 elegant-card bg-white dark:bg-[#151E32] p-6 max-w-sm w-full shadow-2xl border border-slate-200 dark:border-white/10">
        {/* Icon + title */}
        <div className="flex items-start gap-4 mb-4">
          <div className={`flex-shrink-0 w-10 h-10 rounded-full flex items-center justify-center ${
            isDanger ? 'bg-rose-100 dark:bg-rose-500/15' : 'bg-amber-100 dark:bg-amber-500/15'
          }`}>
            <svg className={`w-5 h-5 ${isDanger ? 'text-rose-600 dark:text-rose-400' : 'text-amber-600 dark:text-amber-400'}`}
              viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M12 9v4m0 4h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/>
            </svg>
          </div>
          <div>
            <h3 className="text-sm font-bold text-slate-900 dark:text-white uppercase tracking-wider">{title}</h3>
            <p className="text-xs text-slate-500 dark:text-slate-400 mt-1 leading-relaxed">{message}</p>
          </div>
        </div>
        {/* Actions */}
        <div className="flex gap-3 mt-5 justify-end">
          <button
            onClick={onCancel}
            className="px-4 py-2 text-xs font-bold rounded-xl bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300 hover:bg-slate-200 dark:hover:bg-slate-700 transition-colors uppercase tracking-wide"
          >
            Annulla
          </button>
          <button
            onClick={onConfirm}
            className={`px-4 py-2 text-xs font-bold rounded-xl text-white uppercase tracking-wide transition-all active:scale-95 ${
              isDanger
                ? 'bg-rose-600 hover:bg-rose-500 shadow-lg shadow-rose-500/20'
                : 'bg-amber-500 hover:bg-amber-400 shadow-lg shadow-amber-500/20'
            }`}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
};

export const Monitor: React.FC<{ apiBase: string }> = ({ apiBase }) => {
  const [status,        setStatus]       = useState<BotStatus | null>(readStatusCache);
  const [logs,          setLogs]         = useState<InferenceLog[]>([]);
  const [equity,        setEquity]       = useState<EquitySnap[]>([]);
  const [blockedSignals, setBlockedSignals] = useState<ServerEvent[]>([]);
  const [error,         setError]        = useState<string | null>(null);
  const [starting,      setStarting]     = useState(false);
  const [countdown,     setCountdown]    = useState(secsToNext4h());
  const [initialLoad,   setInitialLoad]  = useState(!readStatusCache()); // false if cache hit
  const [modal,         setModal]        = useState<ModalState | null>(null);
  const [liveAccount,   setLiveAccount]  = useState<LiveAccount | null>(null);

  // ── Manual trade panel ─────────────────────────────────────────────────────
  const [showManual,    setShowManual]   = useState(false);
  const [manualSide,    setManualSide]   = useState<'long' | 'short'>('long');
  const [manualMode,    setManualMode]   = useState<'paper' | 'live'>('paper');
  const [manualSlPct,   setManualSlPct]  = useState(1.0);
  const [manualTpPct,   setManualTpPct]  = useState(2.0);
  const [manualSize,    setManualSize]   = useState(100);
  const [manualLoading, setManualLoading] = useState(false);
  const [manualResult,  setManualResult] = useState<{ ok: boolean; entry_price?: number; stop_loss?: number; take_profit?: number; rr?: number; size_usd?: number; mode?: string; error?: string } | null>(null);
  const esRef       = useRef<EventSource | null>(null);
  const statusRef   = useRef<BotStatus | null>(null);

  useEffect(() => {
    const t = setInterval(() => setCountdown(secsToNext4h()), 1000);
    return () => clearInterval(t);
  }, []);

  // ── REST polling (status + logs every 15s) ────────────────────────────────
  const fetchAll = async () => {
    try {
      const [s, l, e, ev, la] = await Promise.all([
        fetch(`${apiBase}/bot/status`).then(r => r.ok ? r.json() : null),
        fetch(`${apiBase}/inference-logs?limit=5`).then(r => r.ok ? r.json() : []),
        fetch(`${apiBase}/equity?limit=100`).then(r => r.ok ? r.json() : []),
        fetch(`${apiBase}/events?limit=50&since=${new Date(Date.now() - 48 * 3600_000).toISOString()}`).then(r => r.ok ? r.json() : []),
        fetch(`${apiBase}/live/account`).then(r => r.ok ? r.json() : null),
      ]);
      setStatus(s);
      statusRef.current = s;
      writeStatusCache(s);
      if (la?.configured) setLiveAccount(la);
      setLogs((Array.isArray(l) ? l : []).filter(Boolean));
      setEquity(prev => {
        if (!e?.length) return prev;
        const sorted = [...e].sort((a: EquitySnap, b: EquitySnap) =>
          new Date(a.time).getTime() - new Date(b.time).getTime()
        );
        return sorted;
      });
      const blocked = (ev ?? []).filter((x: ServerEvent) =>
        x.kind === 'signal_blocked_opposite' || x.kind === 'signal_blocked_same'
      );
      setBlockedSignals(blocked);
      setError(null);
    } catch {
      setError('API non raggiungibile — assicurati che il backend sia avviato.');
    } finally {
      setInitialLoad(false);
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
          fetch(`${apiBase}/bot/status`).then(r => r.ok ? r.json() : null).then(s => {
            if (s) { setStatus(s); statusRef.current = s; }
          });
        } catch {}
      };
      es.onerror = () => es.close();
      esRef.current = es;
    };

    fetchAll();
    connect();
    // Adaptive polling: 5s with position open, 15s idle
    const poll = setInterval(() => {
      const hasPosition = !!statusRef.current?.position;
      if (hasPosition) fetchAll();
    }, 5_000);
    const slowPoll = setInterval(() => {
      if (!statusRef.current?.position) fetchAll();
    }, 15_000);
    // Sync equity when TradeLog deletes trades (cross-tab event)
    const onEquityChanged = () => fetchAll();
    window.addEventListener('qt:equity-changed', onEquityChanged);
    return () => {
      clearInterval(poll);
      clearInterval(slowPoll);
      esRef.current?.close();
      window.removeEventListener('qt:equity-changed', onEquityChanged);
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

  const killBot = () => setModal({
    title: 'Kill Switch',
    message: 'Tutte le posizioni aperte verranno chiuse e gli ordini cancellati immediatamente. Il bot si fermerà.',
    confirmLabel: 'Attiva Kill Switch',
    variant: 'danger',
    onConfirm: async () => {
      setModal(null);
      await fetch(`${apiBase}/bot/kill`, { method: 'POST' });
      setTimeout(fetchAll, 500);
    },
  });

  const closePosition = () => setModal({
    title: 'Chiudi Posizione',
    message: 'La posizione verrà chiusa al prezzo corrente di mercato. Il bot continuerà a girare normalmente.',
    confirmLabel: 'Chiudi Posizione',
    variant: 'warning',
    onConfirm: async () => {
      setModal(null);
      await fetch(`${apiBase}/bot/position/close`, { method: 'POST' });
      setTimeout(fetchAll, 800);
    },
  });

  const submitManualTrade = async () => {
    setManualLoading(true);
    setManualResult(null);
    try {
      const r = await fetch(`${apiBase}/bot/trade/manual`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          side:     manualSide,
          mode:     manualMode,
          sl_pct:   manualSlPct,
          tp_pct:   manualTpPct,
          size_usd: manualSize,
        }),
      });
      const data = await r.json();
      if (!r.ok) {
        setManualResult({ ok: false, error: data.detail ?? 'Errore sconosciuto' });
      } else {
        setManualResult(data);
        setTimeout(fetchAll, 800);
      }
    } catch {
      setManualResult({ ok: false, error: 'API non raggiungibile' });
    } finally {
      setManualLoading(false);
    }
  };

  if (error && !status) {
    return (
      <div className="elegant-card p-8 text-center bg-white dark:bg-[#151E32]">
        <p className="text-amber-500 font-mono mb-2 text-sm">{error}</p>
        <p className="text-slate-500 dark:text-slate-400 text-xs">
          Avvia il backend: <code className="text-indigo-600 dark:text-indigo-400">cd apps/api && uvicorn main:app --reload</code>
        </p>
      </div>
    );
  }

  const currentEquity = status?.equity ?? equity[equity.length - 1]?.equity_usd ?? INITIAL_EQUITY;
  const totalPnl      = currentEquity - INITIAL_EQUITY;
  const totalPnlPct   = (totalPnl / INITIAL_EQUITY) * 100;

  // Live P&L calculation
  const pos        = status?.position ?? null;
  const markPrice  = status?.mark_price ?? null;
  const positionDurationH = pos ? (Date.now() - new Date(pos.opened_at).getTime()) / 3_600_000 : 0;

  let unrealizedPnl    = 0;
  let unrealizedPct    = 0;
  let distToSL         = 0;
  let distToTP         = 0;
  let distToSLPct      = 0;
  let distToTPPct      = 0;
  let slProgressPct    = 0; // 0=at SL, 100=at TP
  let ptpProgressPct   = 0;
  let distToPTP        = 0;
  let distToPTPPct     = 0;
  if (pos && markPrice) {
    const dir       = pos.side === 'long' ? 1 : -1;
    unrealizedPnl   = dir * (markPrice - pos.entry_price) * pos.size_contracts;
    unrealizedPct   = (unrealizedPnl / pos.size_usd) * 100;
    distToSL        = Math.abs(markPrice - pos.stop_loss);
    distToTP        = Math.abs(pos.take_profit - markPrice);
    distToSLPct     = (distToSL / markPrice) * 100;
    distToTPPct     = (distToTP / markPrice) * 100;
    const range     = Math.abs(pos.take_profit - pos.stop_loss);
    const traveled  = pos.side === 'long'
      ? markPrice - pos.stop_loss
      : pos.stop_loss - markPrice;
    slProgressPct   = range > 0 ? Math.max(0, Math.min(100, (traveled / range) * 100)) : 0;
    if (pos.partial_tp_price) {
      const ptpTraveled = pos.side === 'long'
        ? pos.partial_tp_price - pos.stop_loss
        : pos.stop_loss - pos.partial_tp_price;
      ptpProgressPct  = range > 0 ? Math.max(0, Math.min(100, (ptpTraveled / range) * 100)) : 0;
      distToPTP       = Math.abs(pos.partial_tp_price - markPrice);
      distToPTPPct    = (distToPTP / markPrice) * 100;
    }
  }

  // ── Performance analytics (from equity snapshots) ─────────────────────────
  let maxDrawdownPct = 0;
  if (equity.length > 1) {
    let peak = equity[0].equity_usd;
    for (const snap of equity) {
      if (snap.equity_usd > peak) peak = snap.equity_usd;
      const dd = peak > 0 ? (peak - snap.equity_usd) / peak * 100 : 0;
      if (dd > maxDrawdownPct) maxDrawdownPct = dd;
    }
  }
  const todayStart  = new Date(); todayStart.setHours(0, 0, 0, 0);
  const weekStart   = new Date(todayStart);
  weekStart.setDate(weekStart.getDate() - ((weekStart.getDay() + 6) % 7)); // Monday
  const beforeToday  = equity.filter(e => new Date(e.time) < todayStart);
  const beforeWeek   = equity.filter(e => new Date(e.time) < weekStart);
  const dayBase      = beforeToday.length > 0 ? beforeToday[beforeToday.length - 1].equity_usd : INITIAL_EQUITY;
  const weekBase     = beforeWeek.length  > 0 ? beforeWeek[beforeWeek.length - 1].equity_usd   : INITIAL_EQUITY;
  const dailyPnl     = equity.length > 0 ? currentEquity - dayBase  : 0;
  const weeklyPnl    = equity.length > 0 ? currentEquity - weekBase : 0;
  const dailyPnlPct  = dayBase  > 0 ? (dailyPnl  / dayBase)  * 100 : 0;
  const weeklyPnlPct = weekBase > 0 ? (weeklyPnl / weekBase) * 100 : 0;

  return (
    <div className="space-y-5">

      {/* ── KPI strip ─────────────────────────────────────────────────────── */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <Tooltip text="Valore totale del tuo account, inclusi profitti e perdite realizzati. La modalità (PAPER/LIVE) indica se stai usando fondi virtuali o reali.">
          <KpiCard
            label="Equity"
            value={`$${currentEquity.toLocaleString('en-US', { minimumFractionDigits: 2 })}`}
            sub={status?.mode?.toUpperCase() ?? 'PAPER'}
            color={totalPnl >= 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-rose-600 dark:text-rose-400'}
          />
        </Tooltip>
        <Tooltip text="Profitto o perdita totale dall'avvio del bot. Calcolato come differenza tra equity attuale e capitale iniziale di $10.000.">
          <KpiCard
            label="PnL Totale"
            value={`${totalPnl >= 0 ? '+' : ''}$${totalPnl.toFixed(2)}`}
            sub={`${totalPnlPct >= 0 ? '+' : ''}${totalPnlPct.toFixed(2)}%`}
            color={totalPnl >= 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-rose-600 dark:text-rose-400'}
          />
        </Tooltip>
        <Tooltip text="Countdown alla prossima chiusura della candela da 4 ore. Il bot analizza il mercato e decide se aprire un trade ad ogni nuova candela. 'Cicli' = analisi completate. 'Retrain' = cicli al prossimo promemoria di riaddestramentodel modello LightGBM." width="wide">
          <KpiCard
            label="Prossima Candela"
            value={`${String(Math.floor(countdown / 3600)).padStart(2,'0')}:${String(Math.floor((countdown % 3600) / 60)).padStart(2,'0')}:${String(countdown % 60).padStart(2,'0')}`}
            sub={(() => {
              const n = (status?.config?.retrain_every_n_cycles as number) ?? 120;
              const autoEnabled = (status?.config?.auto_retrain_enabled as boolean) ?? true;
              const remaining = n - ((status?.cycle_count ?? 0) % n);
              const label = autoEnabled ? 'Retrain' : 'Promemoria';
              return `Cicli: ${status?.cycle_count ?? 0} · ${label}: ${remaining}`;
            })()}
          />
        </Tooltip>
        <Tooltip text="Stato operativo del bot. 'Running' = analizza il mercato attivamente. 'Idle' = in pausa. Mostra anche se la connessione WebSocket a Hyperliquid è attiva.">
          <KpiCard
            label="Stato"
            value={initialLoad ? '…' : status?.running ? 'Running' : 'Idle'}
            sub={initialLoad ? 'Caricamento…' : status?.ws_connected ? '● WS connesso' : '○ WS disconnesso'}
            color={initialLoad ? 'text-slate-400 dark:text-slate-500' : status?.running ? 'text-emerald-600 dark:text-emerald-400' : 'text-slate-400 dark:text-slate-500'}
          />
        </Tooltip>
      </div>

      {/* ── Retrain due banner ────────────────────────────────────────────── */}
      {status?.retrain_due && (
        <div className="flex items-start gap-3 px-4 py-3 rounded-xl border border-amber-300 dark:border-amber-500/40 bg-amber-50 dark:bg-amber-500/10">
          <svg className="w-4 h-4 mt-0.5 shrink-0 text-amber-600 dark:text-amber-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.007v.008H12v-.008z" />
          </svg>
          <div className="flex-1 min-w-0">
            <p className="text-sm font-bold text-amber-800 dark:text-amber-300">Retrain manuale necessario</p>
            <p className="text-xs text-amber-700 dark:text-amber-400/80 mt-0.5 leading-relaxed">
              Il modello ha completato {(status?.config?.retrain_every_n_cycles as number) ?? 120} cicli senza aggiornarsi.
              Vai in <span className="font-mono font-bold">Configurazione → LightGBM</span> e avvia un retrain profondo
              con <span className="font-mono font-bold">from_date 2021-01-01</span> + Optuna per mantenere la calibrazione a 5 anni.
            </p>
          </div>
        </div>
      )}

      {/* ── Controls ──────────────────────────────────────────────────────── */}
      <div className="flex gap-4 flex-wrap items-center">
        {initialLoad ? (
          /* ── Skeleton while first fetch is in flight ── */
          <>
            <div className="relative px-6 py-3 rounded-xl overflow-hidden bg-slate-100 dark:bg-white/5 border border-slate-200 dark:border-white/8">
              <div className="w-36 h-4 rounded bg-slate-200 dark:bg-white/10 animate-pulse" />
              <div className="absolute inset-0 flex items-center justify-center gap-2 text-[11px] font-bold text-slate-400 dark:text-slate-500 uppercase tracking-widest">
                <svg className="w-3.5 h-3.5 animate-spin" fill="none" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z"/>
                </svg>
                Verifica stato…
              </div>
            </div>
          </>
        ) : !status?.running ? (
          <>
            <button
              onClick={() => startBot('paper')}
              disabled={starting}
              className="px-6 py-3 bg-indigo-600 hover:bg-indigo-500 text-white text-sm font-bold rounded-xl transition-all shadow-lg shadow-indigo-500/20 active:scale-95 disabled:opacity-50"
            >
              Avvia Paper Trading
            </button>
            <div className="flex items-center gap-2 flex-shrink-0">
              <button
                onClick={() => startBot('live')}
                disabled={starting}
                className="px-6 py-3 whitespace-nowrap bg-emerald-600 hover:bg-emerald-500 text-white text-sm font-bold rounded-xl transition-all shadow-lg shadow-emerald-500/20 active:scale-95 disabled:opacity-50"
              >
                Avvia Live
              </button>
              <Tooltip
                text={status?.hl_testnet
                  ? 'Gli ordini verranno inviati su Hyperliquid TESTNET (fondi virtuali). Per usare fondi reali, imposta HL_TESTNET=false nel file .env del VPS.'
                  : 'Gli ordini verranno inviati su Hyperliquid MAINNET — fondi REALI. Assicurati di aver configurato HL_AGENT_PRIVATE_KEY nel .env del VPS.'}
                pos="bottom"
              >
                <span className={`text-[9px] font-bold uppercase tracking-widest px-2 py-0.5 rounded border cursor-help whitespace-nowrap ${
                  status?.hl_testnet ?? true
                    ? 'bg-amber-50 dark:bg-amber-500/10 text-amber-700 dark:text-amber-400 border-amber-300 dark:border-amber-500/30'
                    : 'bg-rose-50 dark:bg-rose-500/10 text-rose-700 dark:text-rose-400 border-rose-300 dark:border-rose-500/30'
                }`}>
                  {status?.hl_testnet ?? true ? '⚠ Testnet' : '🔴 Mainnet'}
                </span>
              </Tooltip>
            </div>
          </>
        ) : (
          <>
            <button onClick={stopBot} className="px-6 py-3 bg-slate-200 dark:bg-slate-800 text-slate-700 dark:text-slate-200 text-sm font-bold rounded-xl transition-all hover:bg-slate-300 dark:hover:bg-slate-700 active:scale-95">
              Stop
            </button>
            <button onClick={killBot} className="px-6 py-3 bg-rose-600 text-white text-sm font-bold rounded-xl transition-all hover:bg-rose-500 shadow-lg shadow-rose-500/20 active:scale-95">
              KILL
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
          {/* Network badge: visible only when running in live mode */}
          {status?.running && status?.mode === 'live' && (
            <Tooltip
              text={status.hl_testnet
                ? 'Bot live su Hyperliquid TESTNET — ordini con fondi virtuali HL.'
                : 'Bot live su Hyperliquid MAINNET — ordini con fondi REALI.'}
              pos="bottom"
            >
              <div className={`flex items-center gap-1.5 px-2.5 py-1 rounded-lg border text-[10px] font-bold uppercase tracking-widest ${
                status.hl_testnet
                  ? 'bg-amber-50 dark:bg-amber-500/10 text-amber-700 dark:text-amber-400 border-amber-300 dark:border-amber-500/30'
                  : 'bg-rose-50 dark:bg-rose-500/10 text-rose-700 dark:text-rose-400 border-rose-300 dark:border-rose-500/30'
              }`}>
                <span className={`w-1.5 h-1.5 rounded-full ${status.hl_testnet ? 'bg-amber-500' : 'bg-rose-500 animate-pulse'}`} />
                {status.hl_testnet ? 'Testnet' : 'Mainnet'}
              </div>
            </Tooltip>
          )}
        </div>
      </div>

      {/* ── Macro Pause Banner ────────────────────────────────────────────── */}
      {status?.macro_pause_active && (
        <div className="elegant-card px-5 py-3.5 bg-amber-50 dark:bg-amber-500/10 border border-amber-200 dark:border-amber-500/30 flex items-center gap-3">
          <span className="text-lg">⏸</span>
          <div>
            <p className="text-xs font-bold text-amber-800 dark:text-amber-300 uppercase tracking-wider">
              Pausa Macro Attiva — {status.macro_pause_active}
            </p>
            <p className="text-[10px] text-amber-700 dark:text-amber-400 mt-0.5">
              Nuove aperture bloccate durante la finestra evento · SL/TP posizione attiva operativi
            </p>
          </div>
        </div>
      )}

      {/* ── Weekend Gate Banner ───────────────────────────────────────────── */}
      {(() => {
        const cfg = status?.config;
        const blockSat = !!cfg?.weekend_gate_block_saturday;
        const blockSun = !!cfg?.weekend_gate_block_sunday;
        if (!blockSat && !blockSun) return null;
        const utcDay    = new Date().getUTCDay(); // 0=Dom … 6=Sab
        const activeNow = (utcDay === 6 && blockSat) || (utcDay === 0 && blockSun);
        const days      = [blockSat && 'Sabato', blockSun && 'Domenica'].filter(Boolean).join(' e ');
        return (
          <div className={`elegant-card px-5 py-3.5 flex items-center gap-3 border ${
            activeNow
              ? 'bg-amber-100 dark:bg-amber-500/15 border-amber-300 dark:border-amber-500/40'
              : 'bg-amber-50/60 dark:bg-amber-500/[0.07] border-amber-200/70 dark:border-amber-500/20'}`}>
            <span className="text-lg">{activeNow ? '🚫' : '📅'}</span>
            <div>
              <p className="text-xs font-bold text-amber-800 dark:text-amber-300 uppercase tracking-wider">
                {activeNow
                  ? `Weekend Gate ATTIVO ORA — nuove aperture bloccate (${utcDay === 6 ? 'sabato' : 'domenica'} UTC)`
                  : `Weekend Gate configurato — blocco ${days} (UTC)`}
              </p>
              <p className="text-[10px] text-amber-700 dark:text-amber-400 mt-0.5">
                {activeNow
                  ? 'Mercati tradizionali chiusi · nessun nuovo trade fino a fine giornata · SL/TP posizioni aperte operativi'
                  : 'Durante i giorni selezionati il bot non aprirà nuovi trade · le posizioni aperte restano gestite'}
              </p>
            </div>
          </div>
        );
      })()}

      {/* ── Pending Pullback Banner ───────────────────────────────────────── */}
      {status?.pending_pullback && !status?.position && (() => {
        const pb    = status.pending_pullback!;
        const isLong = pb.direction === 'long';
        const exp   = new Date(pb.expires_at);
        const expStr = exp.toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' }) + ' UTC';
        const hasOB = pb.ob_order_id !== null;
        const cancelPb = async () => {
          try {
            await fetch('/pullback/cancel', { method: 'POST' });
          } catch (_) {}
        };
        return (
          <div className="elegant-card px-5 py-3.5 bg-cyan-50 dark:bg-cyan-500/10 border border-cyan-200 dark:border-cyan-500/30 flex items-center gap-3">
            <span className="text-lg">🎯</span>
            <div className="flex-1 min-w-0">
              <p className="text-xs font-bold text-cyan-800 dark:text-cyan-300 uppercase tracking-wider">
                Pullback {isLong ? 'LONG' : 'SHORT'} in attesa
                {hasOB && <span className="ml-2 text-[9px] px-1.5 py-0.5 bg-cyan-100 dark:bg-cyan-500/20 rounded font-bold">OB Limit Order</span>}
              </p>
              <p className="text-[10px] text-cyan-700 dark:text-cyan-400 mt-0.5">
                Target: <span className="font-mono font-bold">${pb.pullback_zone.toLocaleString('en-US', { maximumFractionDigits: 0 })}</span>
                {pb.ob_sl_price && <> · SL strutturale: <span className="font-mono">${pb.ob_sl_price.toLocaleString('en-US', { maximumFractionDigits: 0 })}</span></>}
                {' · '}Scade: <span className="font-mono">{expStr}</span>
              </p>
            </div>
            <button
              onClick={cancelPb}
              className="text-[10px] font-bold text-cyan-600 dark:text-cyan-400 hover:text-rose-500 dark:hover:text-rose-400 transition-colors px-2 py-1 rounded border border-cyan-200 dark:border-cyan-500/30 hover:border-rose-300 dark:hover:border-rose-500/30"
            >
              Cancella
            </button>
          </div>
        );
      })()}

      {/* ── Manual Trade Panel ───────────────────────────────────────────── */}
      {(() => {
        const mp = markPrice;
        const slPrice  = mp ? Math.round((manualSide === 'long' ? mp * (1 - manualSlPct / 100) : mp * (1 + manualSlPct / 100)) * 10) / 10 : null;
        const tpPrice  = mp ? Math.round((manualSide === 'long' ? mp * (1 + manualTpPct / 100) : mp * (1 - manualTpPct / 100)) * 10) / 10 : null;
        const rr       = manualSlPct > 0 ? (manualTpPct / manualSlPct).toFixed(2) : '—';
        const fmtPx    = (v: number) => v.toLocaleString('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
        return (
          <div className={`elegant-card bg-white dark:bg-[#151E32] overflow-hidden border-2 border-dashed transition-colors ${showManual ? 'border-violet-300 dark:border-violet-500/40' : 'border-slate-200 dark:border-white/10 hover:border-slate-300 dark:hover:border-white/20'}`}>
            {/* Header row — always visible */}
            <button
              onClick={() => { setShowManual((v: boolean) => !v); setManualResult(null); }}
              className="w-full flex items-center justify-between px-5 py-4 text-left"
            >
              <div className="flex items-center gap-3">
                <div className={`w-7 h-7 rounded-lg flex items-center justify-center flex-shrink-0 transition-colors ${showManual ? 'bg-violet-100 dark:bg-violet-500/20' : 'bg-slate-100 dark:bg-white/5'}`}>
                  <svg className={`w-3.5 h-3.5 ${showManual ? 'text-violet-600 dark:text-violet-400' : 'text-slate-400 dark:text-slate-500'}`} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M9 3H5a2 2 0 00-2 2v4m6-6h10a2 2 0 012 2v4M9 3v18m0 0h10a2 2 0 002-2V9M9 21H5a2 2 0 01-2-2V9m0 0h18"/>
                  </svg>
                </div>
                <div>
                  <p className="text-xs font-bold text-slate-700 dark:text-slate-200 uppercase tracking-wider">Trade Manuale</p>
                  <p className="text-[10px] text-slate-400 dark:text-slate-500 mt-0.5">Apri una posizione di test senza passare dalla pipeline ML</p>
                </div>
              </div>
              <div className="flex items-center gap-2">
                {pos && (
                  <span className="text-[9px] font-bold uppercase tracking-widest px-2 py-0.5 rounded border bg-amber-50 dark:bg-amber-500/10 text-amber-600 dark:text-amber-400 border-amber-200 dark:border-amber-500/20">
                    Posizione aperta
                  </span>
                )}
                <svg className={`w-4 h-4 text-slate-400 transition-transform duration-200 ${showManual ? 'rotate-180' : ''}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
                  <path d="M19 9l-7 7-7-7"/>
                </svg>
              </div>
            </button>

            {/* Expanded form */}
            {showManual && (
              <div className="px-5 pb-5 space-y-5 border-t border-slate-100 dark:border-white/5 pt-4">

                {pos ? (
                  /* Position already open — block form */
                  <div className="flex items-center gap-3 p-4 rounded-xl bg-amber-50 dark:bg-amber-500/10 border border-amber-200 dark:border-amber-500/20">
                    <svg className="w-4 h-4 text-amber-500 flex-shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <path d="M12 9v4m0 4h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/>
                    </svg>
                    <p className="text-xs text-amber-700 dark:text-amber-400">
                      C&apos;è già una posizione aperta. Chiudila prima di aprire un trade manuale.
                    </p>
                  </div>
                ) : (
                  <>
                    {/* Side + Mode row */}
                    <div className="grid grid-cols-2 gap-4">
                      <div>
                        <p className="text-[10px] font-bold text-slate-400 dark:text-slate-500 uppercase tracking-widest mb-2">Direzione</p>
                        <div className="flex gap-2">
                          {(['long', 'short'] as const).map(s => (
                            <button
                              key={s}
                              onClick={() => setManualSide(s)}
                              className={`flex-1 py-2.5 rounded-xl text-xs font-bold uppercase tracking-widest border transition-all active:scale-95 ${
                                manualSide === s
                                  ? s === 'long'
                                    ? 'bg-emerald-500 text-white border-emerald-500 shadow-lg shadow-emerald-500/20'
                                    : 'bg-rose-500 text-white border-rose-500 shadow-lg shadow-rose-500/20'
                                  : 'text-slate-500 dark:text-slate-400 border-slate-200 dark:border-white/10 hover:border-slate-300 dark:hover:border-white/20 bg-white dark:bg-white/5'
                              }`}
                            >
                              {s === 'long' ? '▲ Long' : '▼ Short'}
                            </button>
                          ))}
                        </div>
                      </div>
                      <div>
                        <p className="text-[10px] font-bold text-slate-400 dark:text-slate-500 uppercase tracking-widest mb-2">Modalità</p>
                        <div className="flex gap-2">
                          {(['paper', 'live'] as const).map(m => (
                            <button
                              key={m}
                              onClick={() => setManualMode(m)}
                              className={`flex-1 py-2.5 rounded-xl text-xs font-bold uppercase tracking-widest border transition-all active:scale-95 ${
                                manualMode === m
                                  ? m === 'paper'
                                    ? 'bg-indigo-500 text-white border-indigo-500 shadow-lg shadow-indigo-500/20'
                                    : 'bg-emerald-600 text-white border-emerald-600 shadow-lg shadow-emerald-500/20'
                                  : 'text-slate-500 dark:text-slate-400 border-slate-200 dark:border-white/10 hover:border-slate-300 dark:hover:border-white/20 bg-white dark:bg-white/5'
                              }`}
                            >
                              {m === 'paper' ? 'Paper' : 'Live'}
                            </button>
                          ))}
                        </div>
                        {manualMode === 'live' && (
                          <p className="text-[9px] text-rose-500 dark:text-rose-400 mt-1.5 font-medium">
                            Ordine reale su Hyperliquid — usa fondi reali
                          </p>
                        )}
                      </div>
                    </div>

                    {/* SL / TP / Size inputs */}
                    <div className="grid grid-cols-3 gap-3">
                      {[
                        { label: 'Stop Loss %', val: manualSlPct, set: setManualSlPct, min: 0.1, max: 10, step: 0.1, color: 'text-rose-500' },
                        { label: 'Take Profit %', val: manualTpPct, set: setManualTpPct, min: 0.1, max: 20, step: 0.1, color: 'text-emerald-500' },
                        { label: 'Size (USD)', val: manualSize, set: (v: number) => setManualSize(Math.round(v)), min: 10, max: 50000, step: 10, color: 'text-indigo-500' },
                      ].map(({ label, val, set, min, max, step, color }) => (
                        <div key={label} className="bg-slate-50 dark:bg-white/[0.03] rounded-xl p-3 border border-slate-100 dark:border-white/5">
                          <p className="text-[10px] font-bold text-slate-400 dark:text-slate-500 uppercase tracking-widest mb-2">{label}</p>
                          <div className="flex items-center gap-1">
                            <button onClick={() => set(Math.max(min, Math.round((val - step) * 10) / 10))} className="w-6 h-6 rounded-lg bg-slate-200 dark:bg-white/10 text-slate-600 dark:text-slate-300 text-xs font-bold hover:bg-slate-300 dark:hover:bg-white/15 transition-colors flex items-center justify-center flex-shrink-0">−</button>
                            <input
                              type="number"
                              value={val}
                              min={min} max={max} step={step}
                              onChange={(e: React.ChangeEvent<HTMLInputElement>) => { const v = parseFloat(e.target.value); if (!isNaN(v) && v >= min && v <= max) set(v); }}
                              className={`flex-1 min-w-0 text-center text-sm font-bold font-mono ${color} bg-transparent border-none outline-none`}
                            />
                            <button onClick={() => set(Math.min(max, Math.round((val + step) * 10) / 10))} className="w-6 h-6 rounded-lg bg-slate-200 dark:bg-white/10 text-slate-600 dark:text-slate-300 text-xs font-bold hover:bg-slate-300 dark:hover:bg-white/15 transition-colors flex items-center justify-center flex-shrink-0">+</button>
                          </div>
                        </div>
                      ))}
                    </div>

                    {/* Live preview strip */}
                    {mp && (
                      <div className="grid grid-cols-4 gap-2">
                        {[
                          { label: 'Prezzo entrata', val: `$${fmtPx(mp)}`, color: 'text-slate-700 dark:text-slate-200' },
                          { label: 'Stop Loss', val: slPrice ? `$${fmtPx(slPrice)}` : '—', color: 'text-rose-600 dark:text-rose-400' },
                          { label: 'Take Profit', val: tpPrice ? `$${fmtPx(tpPrice)}` : '—', color: 'text-emerald-600 dark:text-emerald-400' },
                          { label: 'R:R ratio', val: `${rr}×`, color: parseFloat(rr) >= 1.5 ? 'text-emerald-600 dark:text-emerald-400' : parseFloat(rr) >= 1 ? 'text-amber-600 dark:text-amber-400' : 'text-rose-600 dark:text-rose-400' },
                        ].map(({ label, val, color }) => (
                          <div key={label} className="bg-slate-50 dark:bg-white/[0.03] rounded-xl px-3 py-2.5 border border-slate-100 dark:border-white/5">
                            <p className="text-[9px] font-bold text-slate-400 dark:text-slate-500 uppercase tracking-widest mb-1">{label}</p>
                            <p className={`text-xs font-bold font-mono ${color}`}>{val}</p>
                          </div>
                        ))}
                      </div>
                    )}

                    {/* Result banner */}
                    {manualResult && (
                      <div className={`flex items-start gap-3 p-3.5 rounded-xl border ${manualResult.ok ? 'bg-emerald-50 dark:bg-emerald-500/10 border-emerald-200 dark:border-emerald-500/20' : 'bg-rose-50 dark:bg-rose-500/10 border-rose-200 dark:border-rose-500/20'}`}>
                        <svg className={`w-4 h-4 flex-shrink-0 mt-0.5 ${manualResult.ok ? 'text-emerald-500' : 'text-rose-500'}`} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                          {manualResult.ok ? <path d="M20 6L9 17l-5-5"/> : <path d="M18 6L6 18M6 6l12 12"/>}
                        </svg>
                        {manualResult.ok ? (
                          <div className="space-y-0.5">
                            <p className="text-xs font-bold text-emerald-700 dark:text-emerald-300 uppercase tracking-wide">Trade aperto con successo</p>
                            <p className="text-[10px] text-emerald-600 dark:text-emerald-400 font-mono">
                              Entry ${manualResult.entry_price?.toFixed(2)} · SL ${manualResult.stop_loss?.toFixed(2)} · TP ${manualResult.take_profit?.toFixed(2)} · R:R {manualResult.rr}× · {manualResult.mode?.toUpperCase()}
                            </p>
                          </div>
                        ) : (
                          <p className="text-xs text-rose-600 dark:text-rose-400">{manualResult.error}</p>
                        )}
                      </div>
                    )}

                    {/* Execute button */}
                    <div className="flex items-center justify-between pt-1">
                      <p className="text-[9px] text-slate-400 dark:text-slate-500 italic max-w-xs">
                        Il trade verrà gestito dal bot normalmente (SL/TP via candle close). Non interferisce con la pipeline ML.
                      </p>
                      <button
                        onClick={submitManualTrade}
                        disabled={manualLoading}
                        className={`px-5 py-2.5 text-xs font-bold rounded-xl text-white uppercase tracking-widest transition-all active:scale-95 disabled:opacity-50 disabled:cursor-not-allowed shadow-lg ${
                          manualSide === 'long'
                            ? 'bg-emerald-500 hover:bg-emerald-400 shadow-emerald-500/20'
                            : 'bg-rose-500 hover:bg-rose-400 shadow-rose-500/20'
                        }`}
                      >
                        {manualLoading ? (
                          <span className="flex items-center gap-2">
                            <svg className="w-3 h-3 animate-spin" fill="none" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z"/></svg>
                            Invio…
                          </span>
                        ) : (
                          `Apri ${manualSide === 'long' ? 'Long' : 'Short'} ${manualMode === 'live' ? '· Live' : '· Paper'}`
                        )}
                      </button>
                    </div>
                  </>
                )}
              </div>
            )}
          </div>
        );
      })()}

      {/* ── Open position — Live Trade Card ───────────────────────────────── */}
      {pos && (
        <LiveTradeCard
          pos={pos}
          markPrice={markPrice}
          unrealizedPnl={unrealizedPnl}
          unrealizedPct={unrealizedPct}
          distToSL={distToSL}
          distToTP={distToTP}
          distToSLPct={distToSLPct}
          distToTPPct={distToTPPct}
          slProgressPct={slProgressPct}
          ptpProgressPct={ptpProgressPct}
          distToPTP={distToPTP}
          distToPTPPct={distToPTPPct}
          positionDurationH={positionDurationH}
          mode={status?.mode ?? 'paper'}
          lgbmConfirmBars={status?.config?.lgbm_exit_confirm_bars ?? 2}
          beSlEnabled={status?.config?.be_sl_enabled ?? false}
          chronosEnabled={!!(status?.config?.chronos_enabled ?? true)}
          lastCycleSignals={status?.last_cycle_signals ?? null}
          trendMeter={status?.trend_meter ?? null}
          trendExitEnabled={!!(status?.config?.trend_exit_enabled)}
          trendExitConfirmBars={(status?.config?.trend_exit_confirm_bars as number) ?? 2}
          onClose={closePosition}
        />
      )}

      {/* ── Equity curve ──────────────────────────────────────────────────── */}
      <div className="elegant-card p-6 bg-white dark:bg-[#151E32]">
        <div className="flex items-center justify-between mb-6">
          <div className="flex items-center gap-3">
            <span className="w-1.5 h-6 bg-indigo-500 rounded-full"></span>
            <h3 className="text-sm font-bold text-slate-900 dark:text-white uppercase tracking-wider">Equity Curve</h3>
          </div>
          {equity.length > 0 && (
            <span className={`text-sm font-bold font-mono px-3 py-1 rounded-lg ${totalPnl >= 0 ? 'bg-emerald-50 dark:bg-emerald-500/10 text-emerald-600 dark:text-emerald-400' : 'bg-rose-50 dark:bg-rose-500/10 text-rose-600 dark:text-rose-400'}`}>
              {totalPnl >= 0 ? '+' : ''}${totalPnl.toFixed(2)} ({totalPnlPct.toFixed(2)}%)
            </span>
          )}
        </div>
        {equity.length === 0 ? (
          <div className="h-32 flex items-center justify-center text-slate-400 dark:text-slate-500 text-xs italic">
            La curva apparirà dopo il primo trade chiuso
          </div>
        ) : (
          <div style={{ height: 140 }}>
            <EquityCurveChart data={equity} startCapital={INITIAL_EQUITY} />
          </div>
        )}
      </div>

      {/* ── Performance Analytics ─────────────────────────────────────────── */}
      {equity.length > 0 && (
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <Tooltip text="Variazione dell'equity dall'inizio della giornata corrente (mezzanotte UTC). Basato sugli snapshot di equity salvati nel DB.">
            <div className="rounded-xl border transition-all w-full h-full flex flex-col justify-between px-5 py-4 bg-white dark:bg-[#151E32] border-slate-200 dark:border-white/5 hover:border-slate-300 dark:hover:border-white/10">
              <p className="text-[10px] font-bold text-slate-400 dark:text-slate-500 uppercase tracking-widest mb-1.5">PnL Oggi</p>
              <div>
                <p className={`text-xl font-bold font-mono tracking-tight ${dailyPnl >= 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-rose-600 dark:text-rose-400'}`}>
                  {dailyPnl >= 0 ? '+' : ''}${dailyPnl.toFixed(2)}
                </p>
                <p className={`text-xs font-mono mt-0.5 ${dailyPnl >= 0 ? 'text-emerald-500 dark:text-emerald-500' : 'text-rose-500'}`}>
                  {dailyPnlPct >= 0 ? '+' : ''}{dailyPnlPct.toFixed(2)}%
                </p>
              </div>
            </div>
          </Tooltip>
          <Tooltip text="Variazione dell'equity dall'inizio della settimana corrente (lunedì UTC). Basato sugli snapshot di equity.">
            <div className="rounded-xl border transition-all w-full h-full flex flex-col justify-between px-5 py-4 bg-white dark:bg-[#151E32] border-slate-200 dark:border-white/5 hover:border-slate-300 dark:hover:border-white/10">
              <p className="text-[10px] font-bold text-slate-400 dark:text-slate-500 uppercase tracking-widest mb-1.5">PnL Settimana</p>
              <div>
                <p className={`text-xl font-bold font-mono tracking-tight ${weeklyPnl >= 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-rose-600 dark:text-rose-400'}`}>
                  {weeklyPnl >= 0 ? '+' : ''}${weeklyPnl.toFixed(2)}
                </p>
                <p className={`text-xs font-mono mt-0.5 ${weeklyPnl >= 0 ? 'text-emerald-500 dark:text-emerald-500' : 'text-rose-500'}`}>
                  {weeklyPnlPct >= 0 ? '+' : ''}{weeklyPnlPct.toFixed(2)}%
                </p>
              </div>
            </div>
          </Tooltip>
          <Tooltip text="Massimo drawdown storico: la peggiore perdita percentuale dal picco all'equity più bassa successiva. 0% se nessun drawdown.">
            <div className="rounded-xl border transition-all w-full h-full flex flex-col justify-between px-5 py-4 bg-white dark:bg-[#151E32] border-slate-200 dark:border-white/5 hover:border-slate-300 dark:hover:border-white/10">
              <p className="text-[10px] font-bold text-slate-400 dark:text-slate-500 uppercase tracking-widest mb-1.5">Max Drawdown</p>
              <div>
                <p className={`text-xl font-bold font-mono tracking-tight ${maxDrawdownPct > 5 ? 'text-rose-600 dark:text-rose-400' : maxDrawdownPct > 2 ? 'text-amber-600 dark:text-amber-400' : 'text-emerald-600 dark:text-emerald-400'}`}>
                  -{maxDrawdownPct.toFixed(2)}%
                </p>
                <p className="text-xs font-mono mt-0.5 text-slate-400 dark:text-slate-500">
                  {maxDrawdownPct === 0 ? 'Nessun drawdown' : maxDrawdownPct > 5 ? 'Alto' : maxDrawdownPct > 2 ? 'Moderato' : 'Basso'}
                </p>
              </div>
            </div>
          </Tooltip>
        </div>
      )}

      {/* ── Last inference logs ───────────────────────────────────────────── */}
      {logs.length > 0 && (
        <div className="elegant-card p-6 bg-white dark:bg-[#151E32]">
          <div className="flex items-center gap-3 mb-6">
            <span className="w-1.5 h-6 bg-purple-500 rounded-full"></span>
            <h3 className="text-sm font-bold text-slate-900 dark:text-white uppercase tracking-wider">AI Intelligence Logs</h3>
          </div>
          <div className="space-y-3">
            {logs.map(log => (
              <div key={log.id} className="rounded-xl bg-slate-50 dark:bg-slate-800/50 border border-slate-100 dark:border-white/5 p-4 text-xs font-mono transition-all hover:bg-white dark:hover:bg-slate-800 hover:shadow-md">
                <div className="flex items-center justify-between mb-3">
                  <span className={`font-bold px-2.5 py-1 rounded-lg text-[10px] uppercase tracking-widest ${
                    log.decision === 'long'  ? 'bg-emerald-50 dark:bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border border-emerald-100 dark:border-emerald-500/20'
                    : log.decision === 'short' ? 'bg-rose-50 dark:bg-rose-500/10 text-rose-600 dark:text-rose-400 border border-rose-100 dark:border-rose-500/20'
                    : 'bg-slate-100 dark:bg-slate-700 text-slate-500 dark:text-slate-400 border border-slate-200 dark:border-slate-600'
                  }`}>
                    {log.decision?.toUpperCase()}
                  </span>
                  <span className="text-slate-400 dark:text-slate-500 font-medium">
                    {log.time ? new Date(log.time).toLocaleTimeString('it-IT') : '—'}
                    {log.latency_ms ? ` · ${log.latency_ms.toFixed(0)}ms` : ''}
                  </span>
                </div>
                <div className="space-y-1.5">
                  {(log.reasoning ?? []).slice(0, 3).map((r, i) => (
                    <div key={i} className="truncate text-slate-600 dark:text-slate-400 flex items-start gap-2">
                      <span className="text-indigo-500 opacity-50">•</span>
                      {r}
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ── Live Account (HL) ──────────────────────────────────────────────── */}
      {status?.mode === 'live' && liveAccount && liveAccount.configured && !liveAccount.error && (
        <div className="elegant-card p-6 bg-white dark:bg-[#151E32]">
          <div className="flex items-center gap-3 mb-5">
            <span className="w-1.5 h-6 bg-emerald-500 rounded-full"></span>
            <h3 className="text-sm font-bold text-slate-900 dark:text-white uppercase tracking-wider">Account Hyperliquid</h3>
            <span className="ml-auto text-[9px] font-bold uppercase tracking-widest px-2 py-0.5 rounded border bg-emerald-50 dark:bg-emerald-500/10 text-emerald-700 dark:text-emerald-400 border-emerald-200 dark:border-emerald-500/20">Live</span>
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-4">
            <Tooltip text="Valore totale del conto su Hyperliquid, inclusi margine usato e PnL non realizzato.">
              <div className="bg-slate-50 dark:bg-white/5 border border-slate-100 dark:border-white/5 rounded-xl px-4 py-3">
                <p className="text-[10px] font-bold text-slate-400 dark:text-slate-500 uppercase tracking-widest mb-1">Account Value</p>
                <p className="text-base font-bold font-mono text-slate-900 dark:text-white">${(liveAccount.account_value ?? 0).toLocaleString('en-US', { minimumFractionDigits: 2 })}</p>
              </div>
            </Tooltip>
            <Tooltip text="Margine disponibile per nuove posizioni o prelievi.">
              <div className="bg-slate-50 dark:bg-white/5 border border-slate-100 dark:border-white/5 rounded-xl px-4 py-3">
                <p className="text-[10px] font-bold text-slate-400 dark:text-slate-500 uppercase tracking-widest mb-1">Disponibile</p>
                <p className="text-base font-bold font-mono text-emerald-600 dark:text-emerald-400">${(liveAccount.withdrawable ?? 0).toLocaleString('en-US', { minimumFractionDigits: 2 })}</p>
              </div>
            </Tooltip>
            <Tooltip text="Margine attualmente impegnato nelle posizioni aperte.">
              <div className="bg-slate-50 dark:bg-white/5 border border-slate-100 dark:border-white/5 rounded-xl px-4 py-3">
                <p className="text-[10px] font-bold text-slate-400 dark:text-slate-500 uppercase tracking-widest mb-1">Margine Usato</p>
                <p className={`text-base font-bold font-mono ${(liveAccount.total_margin_used ?? 0) > 0 ? 'text-amber-600 dark:text-amber-400' : 'text-slate-500 dark:text-slate-400'}`}>
                  ${(liveAccount.total_margin_used ?? 0).toLocaleString('en-US', { minimumFractionDigits: 2 })}
                </p>
              </div>
            </Tooltip>
            <Tooltip text="Valore nozionale totale delle posizioni aperte su Hyperliquid.">
              <div className="bg-slate-50 dark:bg-white/5 border border-slate-100 dark:border-white/5 rounded-xl px-4 py-3">
                <p className="text-[10px] font-bold text-slate-400 dark:text-slate-500 uppercase tracking-widest mb-1">Notionale</p>
                <p className="text-base font-bold font-mono text-slate-700 dark:text-slate-200">${(liveAccount.total_ntl_pos ?? 0).toLocaleString('en-US', { maximumFractionDigits: 0 })}</p>
              </div>
            </Tooltip>
          </div>
          {/* Open positions from HL (real fill prices) */}
          {(liveAccount.positions ?? []).length > 0 && (
            <div className="space-y-3">
              <p className="text-[10px] font-bold text-slate-400 dark:text-slate-500 uppercase tracking-widest">Posizioni Aperte (HL)</p>
              
              {/* Mobile Card List */}
              <div className="sm:hidden space-y-3">
                {(liveAccount.positions ?? []).map((p, i) => {
                  const upnlColor = p.unrealized_pnl >= 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-rose-600 dark:text-rose-400';
                  const roe = (p.return_on_equity * 100);
                  return (
                    <div key={i} className="bg-slate-50 dark:bg-white/[0.03] border border-slate-100 dark:border-white/5 rounded-xl p-4 text-xs font-mono space-y-3">
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-2">
                          <span className={`px-2 py-0.5 rounded text-[9px] font-bold uppercase tracking-widest border ${p.side === 'long' ? 'bg-emerald-50 dark:bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-100 dark:border-emerald-500/20' : 'bg-rose-50 dark:bg-rose-500/10 text-rose-600 dark:text-rose-400 border-rose-100 dark:border-rose-500/20'}`}>
                            {p.side.toUpperCase()}
                          </span>
                          <span className="text-slate-700 dark:text-slate-200 font-bold">{p.coin}</span>
                        </div>
                        <span className="text-slate-400 dark:text-slate-500 text-[10px]">{p.leverage_value}x {p.leverage_type}</span>
                      </div>
                      
                      <div className="grid grid-cols-2 gap-y-2.5 gap-x-2 text-[11px]">
                        <div>
                          <p className="text-[9px] text-slate-400 uppercase tracking-wider">Size</p>
                          <p className="text-slate-700 dark:text-slate-200 font-bold">{p.size.toFixed(4)} BTC</p>
                        </div>
                        <div>
                          <p className="text-[9px] text-slate-400 uppercase tracking-wider">Fill Price</p>
                          <p className="text-slate-700 dark:text-slate-200 font-bold">${p.entry_price.toLocaleString('en-US', { minimumFractionDigits: 2 })}</p>
                        </div>
                        <div>
                          <p className="text-[9px] text-slate-400 uppercase tracking-wider">PnL non real.</p>
                          <p className={`font-bold ${upnlColor}`}>{p.unrealized_pnl >= 0 ? '+' : ''}${p.unrealized_pnl.toFixed(2)}</p>
                        </div>
                        <div>
                          <p className="text-[9px] text-slate-400 uppercase tracking-wider">ROE</p>
                          <p className={`font-bold ${roe >= 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-rose-600 dark:text-rose-400'}`}>{roe >= 0 ? '+' : ''}{roe.toFixed(2)}%</p>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>

              {/* Desktop Table List */}
              <div className="hidden sm:block space-y-2">
                {(liveAccount.positions ?? []).map((p, i) => {
                  const upnlColor = p.unrealized_pnl >= 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-rose-600 dark:text-rose-400';
                  const roe = (p.return_on_equity * 100);
                  return (
                    <div key={i} className="flex items-center justify-between px-4 py-3 bg-slate-50 dark:bg-white/[0.03] border border-slate-100 dark:border-white/5 rounded-xl text-xs font-mono">
                      <div className="flex items-center gap-3">
                        <span className={`px-2 py-0.5 rounded text-[10px] font-bold uppercase tracking-widest border ${p.side === 'long' ? 'bg-emerald-50 dark:bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-100 dark:border-emerald-500/20' : 'bg-rose-50 dark:bg-rose-500/10 text-rose-600 dark:text-rose-400 border-rose-100 dark:border-rose-500/20'}`}>
                          {p.side.toUpperCase()}
                        </span>
                        <span className="text-slate-700 dark:text-slate-200 font-bold">{p.coin}</span>
                        <span className="text-slate-500 dark:text-slate-400">{p.size.toFixed(4)} BTC</span>
                      </div>
                      <div className="flex items-center gap-4 text-right">
                        <div>
                          <p className="text-[9px] text-slate-400 uppercase">Fill Price</p>
                          <p className="text-slate-700 dark:text-slate-200 font-bold">${p.entry_price.toLocaleString('en-US', { minimumFractionDigits: 2 })}</p>
                        </div>
                        <div>
                          <p className="text-[9px] text-slate-400 uppercase">PnL non real.</p>
                          <p className={`font-bold ${upnlColor}`}>{p.unrealized_pnl >= 0 ? '+' : ''}${p.unrealized_pnl.toFixed(2)}</p>
                        </div>
                        <div>
                          <p className="text-[9px] text-slate-400 uppercase">ROE</p>
                          <p className={`font-bold ${roe >= 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-rose-600 dark:text-rose-400'}`}>{roe >= 0 ? '+' : ''}{roe.toFixed(2)}%</p>
                        </div>
                        <div className="text-slate-400 dark:text-slate-500 text-[9px]">
                          {p.leverage_value}x {p.leverage_type}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
          {(liveAccount.positions ?? []).length === 0 && (
            <p className="text-xs text-slate-400 dark:text-slate-500 italic">Nessuna posizione aperta su Hyperliquid.</p>
          )}
        </div>
      )}
      {/* HL wallet not configured warning */}
      {status?.mode === 'live' && status?.running && (!liveAccount || !liveAccount.configured) && (
        <div className="elegant-card p-5 bg-amber-50 dark:bg-amber-500/5 border border-amber-200 dark:border-amber-500/20">
          <div className="flex items-center gap-3">
            <svg className="w-4 h-4 text-amber-500 flex-shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 9v4m0 4h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/></svg>
            <div>
              <p className="text-xs font-bold text-amber-700 dark:text-amber-400 uppercase tracking-wider">Wallet HL non configurato</p>
              <p className="text-[11px] text-amber-600 dark:text-amber-400 mt-0.5">Imposta <code className="font-mono">HL_WALLET_ADDRESS</code> nel file <code>.env</code> del VPS per visualizzare il saldo reale del conto.</p>
            </div>
          </div>
        </div>
      )}

      {/* ── Blocked signals ───────────────────────────────────────────────── */}
      {blockedSignals.length > 0 && (
        <div className="elegant-card p-6 bg-white dark:bg-[#151E32]">
          <div className="flex items-center justify-between mb-6">
            <div className="flex items-center gap-3">
              <span className="w-1.5 h-6 bg-amber-500 rounded-full"></span>
              <h3 className="text-sm font-bold text-slate-900 dark:text-white uppercase tracking-wider">Segnali Bloccati</h3>
            </div>
            <span className="text-[10px] font-bold text-slate-400 dark:text-slate-500 uppercase tracking-widest">
              Posizione aperta — segnali ignorati
            </span>
          </div>
          <div className="space-y-3">
            {blockedSignals.map(ev => {
              const isOpposite = ev.kind === 'signal_blocked_opposite';
              const signal    = ev.payload?.signal?.toUpperCase() ?? '—';
              const openSide  = ev.payload?.open_side?.toUpperCase() ?? '—';
              const pct        = ev.payload?.ensemble_pct ?? 0;
              const dirProb    = ev.payload?.dir_prob ?? 0;
              const markPrice  = ev.payload?.mark_price ?? 0;
              const hypSl      = ev.payload?.hyp_sl ?? 0;
              const hypTp      = ev.payload?.hyp_tp ?? 0;
              const hypRr      = ev.payload?.hyp_rr ?? 0;
              const reasoning  = ev.payload?.reasoning ?? [];
              const lastReason = reasoning[reasoning.length - 1] ?? '';
              return (
                <div
                  key={ev.id}
                  className={`rounded-xl p-4 text-xs font-mono transition-all hover:shadow-md border ${
                    isOpposite
                      ? 'bg-amber-50 dark:bg-amber-500/5 border-amber-200 dark:border-amber-500/20'
                      : 'bg-slate-50 dark:bg-white/[0.03] border-slate-100 dark:border-white/5'
                  }`}
                >
                  <div className="flex items-center justify-between mb-2">
                    <div className="flex items-center gap-2">
                      <span className={`font-bold px-2 py-0.5 rounded text-[10px] uppercase tracking-widest border ${
                        isOpposite
                          ? 'bg-amber-100 dark:bg-amber-500/15 text-amber-700 dark:text-amber-400 border-amber-200 dark:border-amber-500/25'
                          : 'bg-slate-100 dark:bg-white/8 text-slate-500 dark:text-slate-400 border-slate-200 dark:border-white/10'
                      }`}>
                        {isOpposite ? '⚠️ Segnale Contrario' : 'ℹ️ Segnale Uguale'}
                      </span>
                      <span className={`font-bold text-[10px] px-2 py-0.5 rounded border ${
                        signal === 'LONG'
                          ? 'bg-emerald-50 dark:bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-200 dark:border-emerald-500/20'
                          : 'bg-rose-50 dark:bg-rose-500/10 text-rose-600 dark:text-rose-400 border-rose-200 dark:border-rose-500/20'
                      }`}>
                        {signal}
                      </span>
                    </div>
                    <span className="text-slate-400 dark:text-slate-500 font-medium text-[10px]">
                      {ev.time ? new Date(ev.time).toLocaleString('it-IT', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—'}
                    </span>
                  </div>
                  <div className={`flex items-center gap-4 mb-2 text-[11px] flex-wrap ${isOpposite ? 'text-amber-700 dark:text-amber-400' : 'text-slate-500 dark:text-slate-400'}`}>
                    <span>Pos. aperta: <span className="font-bold">{openSide}</span></span>
                    <span>Ensemble: <span className="font-bold">{pct.toFixed(1)}%</span></span>
                    {dirProb > 0 && <span>P(dir): <span className="font-bold">{dirProb.toFixed(1)}%</span></span>}
                  </div>
                  {markPrice > 0 && (
                    <div className={`grid grid-cols-4 gap-2 mb-2 text-[10px] font-mono p-2 rounded-lg ${isOpposite ? 'bg-amber-100/60 dark:bg-amber-500/10' : 'bg-slate-100 dark:bg-white/5'}`}>
                      <div><span className="opacity-60">Entry</span><br/><span className="font-bold">${markPrice.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}</span></div>
                      {hypSl > 0 && <div><span className="opacity-60">SL</span><br/><span className="font-bold text-rose-500">${hypSl.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}</span></div>}
                      {hypTp > 0 && <div><span className="opacity-60">TP</span><br/><span className="font-bold text-emerald-500">${hypTp.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}</span></div>}
                      {hypRr > 0 && <div><span className="opacity-60">R:R</span><br/><span className="font-bold">{hypRr.toFixed(2)}</span></div>}
                    </div>
                  )}
                  {lastReason && (
                    <div className="truncate text-slate-500 dark:text-slate-500 text-[11px] flex items-start gap-2 mt-1">
                      <span className="text-amber-400 opacity-60 shrink-0">•</span>
                      {lastReason}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* ── Confirmation modal ────────────────────────────────────────────── */}
      {modal && (
        <ConfirmModal
          {...modal}
          onCancel={() => setModal(null)}
        />
      )}
    </div>
  );
};

// ── Trade narrative helpers ───────────────────────────────────────────────────

function parseBold(text: string): React.ReactNode[] {
  const parts = text.split(/\*\*(.*?)\*\*/g);
  return parts.map((part, i) =>
    i % 2 === 1
      ? <strong key={i} className="font-semibold text-slate-700 dark:text-slate-200">{part}</strong>
      : part
  );
}

function buildTradeNarrative(pos: Position, chronosEnabled: boolean): string {
  const isLong = pos.side === 'long';
  const lines  = pos.entry_reasoning ?? [];

  // Extract ensemble P(up)
  let pUp = isLong ? 0.65 : 0.35;
  const ensLine = lines.find(l => l.startsWith('Ensemble P(up)'));
  if (ensLine) {
    const m = ensLine.match(/P\(up\):\s*([\d.]+)/);
    if (m) pUp = parseFloat(m[1]);
  }
  const confPct = Math.round((isLong ? pUp : 1 - pUp) * 100);

  // Regime
  let regimeText = '';
  const regimeLine = lines.find(l => l.includes('MTF:') || l.includes('regime'));
  if (regimeLine) {
    const low = regimeLine.toLowerCase();
    if (low.includes('bear'))    regimeText = 'ribassista sul timeframe giornaliero';
    else if (low.includes('bull'))   regimeText = 'rialzista sul timeframe giornaliero';
    else if (low.includes('ranging') || low.includes('sideways')) regimeText = 'laterale (ranging)';
  }

  // Fear & Greed
  let fngVal: number | null = null;
  let fngLabel = '';
  const fngLine = lines.find(l => l.startsWith('FNG:'));
  if (fngLine) {
    const m = fngLine.match(/(\d+)/);
    if (m) {
      fngVal = parseInt(m[1]);
      if (fngVal <= 25)      fngLabel = 'paura estrema';
      else if (fngVal <= 45) fngLabel = 'paura diffusa';
      else if (fngVal <= 55) fngLabel = 'sentiment neutro';
      else if (fngVal <= 75) fngLabel = 'ottimismo';
      else                   fngLabel = 'euforia';
    }
  }

  // Exhaustion guard / RSI
  let rsiVal: number | null = null;
  const exhaustLine = lines.find(l => l.includes('ExhaustionGuard'));
  if (exhaustLine) {
    const m = exhaustLine.match(/RSI\s*([\d.]+)/);
    if (m) rsiVal = parseFloat(m[1]);
  }

  // C2 p50 target
  let c2Target: number | null = null;
  const decLine = lines.find(l => l.includes('C2_p50='));
  if (decLine) {
    const m = decLine.match(/C2_p50=([\d.]+)/);
    if (m) c2Target = parseFloat(m[1]);
  }

  // R:R
  const toTP = Math.abs(pos.take_profit - pos.entry_price);
  const toSL = Math.abs(pos.entry_price - pos.stop_loss);
  const rr   = toSL > 0 ? (toTP / toSL).toFixed(1) : null;

  // ── Build narrative ──────────────────────────────────────────────────────
  let p = '';

  // Opening: direction + AI confidence
  const modelsLabel = chronosEnabled ? 'LightGBM e Chronos' : 'LightGBM';
  p += `Il bot ha aperto una posizione **${isLong ? 'LONG (rialzista)' : 'SHORT (ribassista)'}** su Bitcoin perché ${chronosEnabled ? 'i due modelli di intelligenza artificiale' : 'il modello di intelligenza artificiale'} (${modelsLabel}) ${chronosEnabled ? 'concordano' : 'stima'} con una **probabilità del ${confPct}%** che il prezzo si muova ${isLong ? 'al rialzo' : 'al ribasso'} nelle prossime ore. `;

  // Regime context
  if (regimeText) {
    const aligned = (isLong && regimeText.includes('rialzista')) || (!isLong && regimeText.includes('ribassista'));
    if (aligned) {
      p += `Il regime di mercato è **${regimeText}**, il che conferma la direzione del trade e abbassa leggermente la soglia di ingresso richiesta. `;
    } else if (regimeText.includes('laterale')) {
      p += `Il mercato si trova in una fase **${regimeText}**: in questo contesto il bot richiede una confidenza leggermente più alta prima di entrare. `;
    } else {
      p += `Il regime rilevato sul timeframe giornaliero è **${regimeText}**: i segnali AI hanno comunque superato la soglia più alta richiesta in questo contesto. `;
    }
  }

  // F&G context
  if (fngVal !== null) {
    if (!isLong && fngVal <= 35) {
      p += `L'indice Fear & Greed segna **${fngVal}/100** (${fngLabel}), segnale che i venditori stanno dominando — ha rafforzato leggermente il segnale short. `;
    } else if (isLong && fngVal <= 35) {
      p += `L'indice Fear & Greed segna **${fngVal}/100** (${fngLabel}), che storicamente precede rimbalzi e ha ridotto leggermente la soglia di ingresso long. `;
    } else if (!isLong && fngVal >= 65) {
      p += `L'indice Fear & Greed segna **${fngVal}/100** (${fngLabel}), un livello che spesso precede correzioni e ha rafforzato il segnale short. `;
    } else {
      p += `L'indice Fear & Greed è a **${fngVal}/100** (${fngLabel}). `;
    }
  }

  // Exhaustion guard note
  if (rsiVal !== null) {
    if (!isLong && rsiVal < 30) {
      p += `Attenzione: l'RSI era in zona di **ipervenduto (${rsiVal.toFixed(0)})** all'apertura — il bot ha alzato temporaneamente la soglia richiesta per ridurre il rischio di shortare vicino a un potenziale rimbalzo tecnico, e il segnale l'ha comunque superata. `;
    } else if (isLong && rsiVal > 70) {
      p += `Attenzione: l'RSI era in zona di **ipercomprato (${rsiVal.toFixed(0)})** all'apertura — il bot ha richiesto una conferma extra prima di entrare long, che il segnale ha superato. `;
    }
  }

  // C2 price target — only show when Chronos is enabled (otherwise c2_p50 = mark_price, non è una previsione reale)
  if (chronosEnabled && c2Target !== null) {
    p += `Il modello Chronos stima un prezzo mediano di **$${c2Target.toLocaleString('en-US', { maximumFractionDigits: 0 })}** come riferimento per il prossimo ciclo. `;
  }

  // Pullback Entry context
  const pullbackLine = lines.find(l => l.startsWith('PullbackEntry:'));
  if (pullbackLine) {
    const mSignal      = pullbackLine.match(/signal_close=([\d.]+)/);
    const mActual      = pullbackLine.match(/actual_entry=([\d.]+)/);
    const mImprovement = pullbackLine.match(/improvement=([\d.]+)/);
    const isFallback   = pullbackLine.includes('pullback_fallback') || pullbackLine.includes('ob_fallback');
    const isOBFill     = pullbackLine.includes('ob_limit_filled');
    if (mSignal && mActual && mImprovement) {
      const signalPx = parseFloat(mSignal[1]);
      const actualPx = parseFloat(mActual[1]);
      const improv   = parseFloat(mImprovement[1]);
      if (isOBFill) {
        p += `Il bot aveva rilevato un impulso forte e piazzato un **ordine limit GTC** al livello dell'Order Block ($${signalPx.toLocaleString('en-US', { maximumFractionDigits: 0 })}). L'ordine è stato fillato a **$${actualPx.toLocaleString('en-US', { maximumFractionDigits: 0 })}** con SL strutturale — entry più precisa e stop più stretto rispetto all'entry immediata. `;
      } else if (isFallback) {
        p += `Il segnale è scattato alla chiusura 4H a **$${signalPx.toLocaleString('en-US', { maximumFractionDigits: 0 })}** ma il prezzo non ha eseguito il pullback atteso. Scaduta la finestra di attesa e verificato che il prezzo fosse ancora vicino al livello originale, il bot è entrato via **fallback** a **$${actualPx.toLocaleString('en-US', { maximumFractionDigits: 0 })}**. `;
      } else {
        p += `Il segnale era stato generato alla chiusura 4H a **$${signalPx.toLocaleString('en-US', { maximumFractionDigits: 0 })}**, ma il bot ha atteso un ${isLong ? 'ritracciamento' : 'rimbalzo tecnico'} per migliorare il timing di entrata. Il prezzo è tornato nella zona attesa e il trade è stato aperto a **$${actualPx.toLocaleString('en-US', { maximumFractionDigits: 0 })}** — **$${improv.toLocaleString('en-US', { maximumFractionDigits: 0 })} più favorevole** rispetto all'entry immediata, migliorando strutturalmente il rapporto rischio/rendimento. `;
      }
    }
  }

  // TP/SL expectation
  p += `Il take profit è fissato a **$${pos.take_profit.toLocaleString('en-US', { maximumFractionDigits: 0 })}**`;
  if (rr) p += ` (rapporto rischio/rendimento **${rr}:1**)`;
  p += `, con stop loss a **$${pos.stop_loss.toLocaleString('en-US', { maximumFractionDigits: 0 })}** per limitare le perdite se il mercato dovesse invalidare il segnale.`;

  return p;
}

// ── Live Trade Card ───────────────────────────────────────────────────────────

interface LastCycleSignals {
  action: string;
  ensemble_pct: number;
  lgbm_pct: number;
  c2_dir_pct: number;
  c2_p50: number | null;
  c2_cont_prob: number;
  reasoning: string[];
  updated_at: string;
}

function formatSignalTime(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  const time = d.toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' });
  if (d.toDateString() === now.toDateString()) return `Oggi · ${time}`;
  const months = ['gen','feb','mar','apr','mag','giu','lug','ago','set','ott','nov','dic'];
  return `${d.getDate()} ${months[d.getMonth()]} · ${time}`;
}

function buildSignalNarrative(s: LastCycleSignals): string {
  const { action, lgbm_pct, c2_dir_pct, reasoning } = s;

  // Parse reasoning lines
  let regime = '';
  let threshLong: number | null = null;
  let fngVal: number | null = null;
  let fngLabel = '';
  let pUp: number | null = null;
  let longThr: number | null = null;
  let shortThr: number | null = null;

  for (const line of reasoning) {
    const rm = line.match(/RegimeBias.*regime=(\w+).*threshold_long=([\d.]+).*threshold_short=([\d.]+)/);
    if (rm) { regime = rm[1].toUpperCase(); threshLong = parseFloat(rm[2]); }

    const fm = line.match(/FNG:.*?(\d+)/);
    if (fm) {
      fngVal = parseInt(fm[1]);
      if (fngVal <= 20)      fngLabel = 'paura estrema';
      else if (fngVal <= 35) fngLabel = 'paura';
      else if (fngVal <= 65) fngLabel = 'neutro';
      else if (fngVal <= 80) fngLabel = 'ottimismo';
      else                   fngLabel = 'euforia';
    }

    const ntm = line.match(/NO-TRADE.*P\(up\)=([\d.]+).*long>([\d.]+).*short>([\d.]+)/i);
    if (ntm) { pUp = parseFloat(ntm[1]); longThr = parseFloat(ntm[2]); shortThr = parseFloat(ntm[3]); }

    const lm = line.match(/(?:LONG|SHORT).*P\(up\)=([\d.]+)/i);
    if (lm && pUp === null) pUp = parseFloat(lm[1]);
  }

  let p = '';
  const isNoTrade = action === 'no_trade';
  const isLong    = action === 'long';

  // 1. Opening — what the AI sees
  if (isNoTrade && pUp !== null) {
    const pUpPct = Math.round(pUp * 100);
    p += `Il modello LightGBM vede una probabilità rialzista del **${pUpPct}%**`;
    if (longThr !== null && shortThr !== null) {
      const lPct = Math.round(longThr * 100);
      const sPct = Math.round((1 - shortThr) * 100);
      p += `, che non è sufficiente per aprire un trade: servirebbero **>${lPct}%** per entrare long o **<${sPct}%** per entrare short. `;
    } else {
      p += `, insufficiente per superare le soglie di ingresso. `;
    }
  } else if (isLong) {
    p += `LightGBM vede una probabilità rialzista del **${Math.round(lgbm_pct)}%** — segnale attivo **LONG** in questo ciclo. `;
  } else if (!isNoTrade) {
    p += `LightGBM vede una probabilità ribassista del **${Math.round(100 - lgbm_pct)}%** — segnale attivo **SHORT** in questo ciclo. `;
  } else {
    p += `Nessun segnale direzionale sufficientemente forte in questo ciclo. `;
  }

  // 2. Regime
  if (regime) {
    const rMap: Record<string, string> = { BEAR: 'ribassista', BULL: 'rialzista', RANGING: 'laterale', NEUTRAL: 'neutro' };
    const rIt = rMap[regime] ?? regime.toLowerCase();
    if (threshLong !== null) {
      p += `Il regime è **${rIt}** (${regime}): la soglia long è alzata a **${Math.round(threshLong * 100)}%** per essere più selettivi. `;
    } else {
      p += `Il regime attuale è **${rIt}** (${regime}). `;
    }
  }

  // 3. F&G
  if (fngVal !== null) {
    if (fngVal <= 35) {
      p += `Fear & Greed è a **${fngVal}/100** (${fngLabel}): sentiment di paura, che abbassa leggermente la soglia short e alza quella long. `;
    } else if (fngVal >= 65) {
      p += `Fear & Greed è a **${fngVal}/100** (${fngLabel}): sentiment ottimistico, la soglia short si abbassa leggermente. `;
    } else {
      p += `Fear & Greed è a **${fngVal}/100** (${fngLabel}): sentiment neutro, nessuna correzione alle soglie. `;
    }
  }

  // 4. Chronos
  if (c2_dir_pct >= 56) {
    p += `Chronos-2 conferma una tendenza **rialzista** (${c2_dir_pct.toFixed(0)}%). `;
  } else if (c2_dir_pct <= 44) {
    p += `Chronos-2 vede una tendenza **ribassista** (${(100 - c2_dir_pct).toFixed(0)}% al ribasso). `;
  }

  return p.trim();
}

interface LiveTradeCardProps {
  pos: Position;
  markPrice: number | null;
  unrealizedPnl: number;
  unrealizedPct: number;
  distToSL: number;
  distToTP: number;
  distToSLPct: number;
  distToTPPct: number;
  slProgressPct: number;
  ptpProgressPct: number;
  distToPTP: number;
  distToPTPPct: number;
  positionDurationH: number;
  mode: string;
  lgbmConfirmBars: number;
  beSlEnabled: boolean;
  chronosEnabled: boolean;
  lastCycleSignals: LastCycleSignals | null;
  trendMeter: TrendMeterData | null;
  trendExitEnabled: boolean;
  trendExitConfirmBars: number;
  onClose: () => void;
}

const LiveTradeCard: React.FC<LiveTradeCardProps> = ({
  pos, markPrice, unrealizedPnl, unrealizedPct,
  distToSL, distToTP, distToSLPct, distToTPPct,
  slProgressPct, ptpProgressPct, distToPTP, distToPTPPct,
  positionDurationH, mode, lgbmConfirmBars, beSlEnabled, chronosEnabled,
  lastCycleSignals, trendMeter, trendExitEnabled, trendExitConfirmBars, onClose,
}) => {
  const isLong    = pos.side === 'long';
  const pnlPos    = unrealizedPnl >= 0;
  const pnlColor  = pnlPos ? 'text-emerald-600 dark:text-emerald-400' : 'text-rose-600 dark:text-rose-400';
  const pnlBg     = pnlPos ? 'bg-emerald-50 dark:bg-emerald-500/5' : 'bg-rose-50 dark:bg-rose-500/5';
  const fmt       = (n: number) => n.toLocaleString('en-US', { maximumFractionDigits: 0 });
  const hasMark   = markPrice !== null;
  const rr        = distToSL > 0 ? (distToTP / distToSL).toFixed(2) : '—';
  const slWarning = hasMark && slProgressPct >= 0 && slProgressPct < 20;

  // SL has moved if current SL differs from original
  const slMoved   = pos.sl_original !== undefined && Math.abs(pos.stop_loss - pos.sl_original) > 1;

  return (
    <div className="elegant-card overflow-hidden bg-white dark:bg-[#151E32] border border-indigo-100 dark:border-indigo-500/20">

      {/* SL proximity alert */}
      {slWarning && (
        <div className="mx-4 mt-4 px-4 py-3 rounded-xl bg-rose-50 dark:bg-rose-500/10 border border-rose-200 dark:border-rose-500/30 flex items-center gap-3 animate-pulse">
          <svg className="w-4 h-4 text-rose-500 flex-shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.007v.008H12v-.008z"/>
          </svg>
          <div>
            <p className="text-[11px] font-bold text-rose-700 dark:text-rose-400 uppercase tracking-wider">Stop Loss Vicino</p>
            <p className="text-[10px] text-rose-600 dark:text-rose-400 font-mono mt-0.5">
              A soli {distToSLPct.toFixed(2)}% dal SL · ${distToSL.toFixed(0)} di distanza
            </p>
          </div>
        </div>
      )}

      {/* Header */}
      <div className="flex items-center justify-between px-6 py-4 border-b border-slate-100 dark:border-white/5">
        <div className="flex items-center gap-3">
          <span className={`w-2 h-2 rounded-full animate-pulse ${isLong ? 'bg-emerald-500' : 'bg-rose-500'}`} />
          <h3 className="text-sm font-bold text-slate-900 dark:text-white uppercase tracking-wider">
            Posizione Aperta · BTC {pos.side.toUpperCase()}
          </h3>
          <span className={`px-2 py-0.5 rounded text-[9px] font-bold uppercase tracking-widest border ${
            mode === 'live'
              ? 'bg-rose-50 dark:bg-rose-500/10 text-rose-600 dark:text-rose-400 border-rose-200 dark:border-rose-500/20'
              : 'bg-indigo-50 dark:bg-indigo-500/10 text-indigo-600 dark:text-indigo-400 border-indigo-200 dark:border-indigo-500/20'
          }`}>{mode.toUpperCase()}</span>
        </div>
        <div className="flex items-center gap-4 text-xs text-slate-400 dark:text-slate-500 font-mono">
          <span>{pos.bars_held ?? 0} × 4h</span>
          <span>{positionDurationH.toFixed(1)}h apertura</span>
        </div>
      </div>

      {/* P&L hero */}
      <div className={`px-6 py-5 ${pnlBg} border-b border-slate-100 dark:border-white/5`}>
        {hasMark ? (
          <div className="flex items-end justify-between gap-4">
            {/* Unrealized PnL (current open portion) */}
            <div>
              <p className="text-[10px] font-bold text-slate-400 dark:text-slate-500 uppercase tracking-widest mb-1">
                P&L Non Realizzato
              </p>
              <div className="flex items-baseline gap-3">
                <span className={`text-3xl font-bold font-mono tracking-tighter ${pnlColor}`}>
                  {unrealizedPnl >= 0 ? '+' : ''}${unrealizedPnl.toFixed(2)}
                </span>
                <span className={`text-base font-bold font-mono ${pnlColor}`}>
                  {unrealizedPct >= 0 ? '+' : ''}{unrealizedPct.toFixed(2)}%
                </span>
              </div>
              {/* Realized PnL from partial TP — shown only when partial_done */}
              {pos.partial_done && (pos.partial_realized_pnl ?? 0) !== 0 && (() => {
                const rPnl = pos.partial_realized_pnl ?? 0;
                const totalPnl = unrealizedPnl + rPnl;
                const rColor = rPnl >= 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-rose-600 dark:text-rose-400';
                const tColor = totalPnl >= 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-rose-600 dark:text-rose-400';
                return (
                  <div className="mt-2 flex flex-col gap-0.5">
                    <div className="flex items-center gap-3">
                      <span className="text-[10px] font-bold text-slate-400 dark:text-slate-500 uppercase tracking-widest w-32">
                        ✓ Partial TP realiz.
                      </span>
                      <span className={`text-sm font-bold font-mono ${rColor}`}>
                        {rPnl >= 0 ? '+' : ''}${rPnl.toFixed(2)}
                      </span>
                    </div>
                    <div className="flex items-center gap-3">
                      <span className="text-[10px] font-bold text-slate-400 dark:text-slate-500 uppercase tracking-widest w-32">
                        PnL Totale trade
                      </span>
                      <span className={`text-sm font-bold font-mono ${tColor}`}>
                        {totalPnl >= 0 ? '+' : ''}${totalPnl.toFixed(2)}
                      </span>
                    </div>
                  </div>
                );
              })()}
            </div>
            <div className="text-right flex-shrink-0">
              <p className="text-[10px] font-bold text-slate-400 dark:text-slate-500 uppercase tracking-widest mb-1">Mark Price</p>
              <p className="text-xl font-bold font-mono text-slate-900 dark:text-white">${fmt(markPrice!)}</p>
            </div>
          </div>
        ) : (
          <div className="flex items-center gap-2 text-slate-400 dark:text-slate-500">
            <svg className="w-3.5 h-3.5 animate-spin" viewBox="0 0 24 24" fill="none">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z"/>
            </svg>
            <span className="text-xs font-medium">In attesa del primo prezzo WS…</span>
          </div>
        )}
      </div>

      {/* Key levels grid */}
      <div className={`grid grid-cols-1 divide-y border-b border-slate-100 dark:border-white/5 ${pos.liq_px ? 'sm:grid-cols-4 sm:divide-y-0 sm:divide-x' : 'sm:grid-cols-3 sm:divide-y-0 sm:divide-x'} divide-slate-100 dark:divide-white/5`}>
        {[
          { label: 'Entry', value: `$${fmt(pos.entry_price)}`, color: 'text-slate-900 dark:text-white', sub: undefined as string | undefined },
          { label: 'Stop Loss', value: `$${fmt(pos.stop_loss)}`, color: 'text-rose-600 dark:text-rose-400',
            sub: slMoved ? `orig. $${fmt(pos.sl_original)}` : undefined },
          { label: 'Take Profit', value: `$${fmt(pos.take_profit)}`, color: 'text-emerald-600 dark:text-emerald-400', sub: undefined as string | undefined },
          ...(pos.liq_px ? [{ label: 'Liquidazione', value: `$${fmt(pos.liq_px)}`, color: 'text-red-600 dark:text-red-400',
            sub: pos.leverage && pos.leverage > 1 ? `${pos.leverage}× · margine $${pos.margin_usd?.toLocaleString(undefined, { maximumFractionDigits: 0 }) ?? '—'}` : undefined }] : []),
        ].map(({ label, value, color, sub }) => (
          <div key={label} className="px-4 py-3 sm:px-6 sm:py-4">
            <p className="text-[10px] font-bold text-slate-400 dark:text-slate-500 uppercase tracking-widest mb-1">{label}</p>
            <p className={`text-base font-bold font-mono ${color}`}>{value}</p>
            {sub && <p className="text-[10px] text-slate-400 dark:text-slate-500 font-mono mt-0.5">{sub}</p>}
          </div>
        ))}
      </div>

      {/* Progress bar SL → TP */}
      {hasMark && (
        <div className="px-6 py-4 border-b border-slate-100 dark:border-white/5">
          {/* Header labels — SL, PTP tick, Mark, TP */}
          <div className="relative h-4 mb-2">
            <span className="absolute left-0 text-[10px] font-bold text-slate-400 dark:text-slate-500 uppercase tracking-widest leading-4">
              SL ${fmt(pos.stop_loss)}
            </span>
            {pos.partial_tp_price && (
              <span
                className={`absolute text-[10px] font-bold uppercase tracking-widest leading-4 -translate-x-1/2 whitespace-nowrap ${pos.partial_done ? 'text-amber-400/50 line-through' : 'text-amber-500'}`}
                style={{ left: `${ptpProgressPct}%` }}
              >
                ⚡ ${fmt(pos.partial_tp_price)}
              </span>
            )}
            <span
              className="absolute text-[10px] font-bold text-indigo-500 dark:text-indigo-400 uppercase tracking-widest leading-4 -translate-x-1/2 whitespace-nowrap"
              style={{ left: `${slProgressPct}%` }}
            >
              ${fmt(markPrice!)}
            </span>
            <span className="absolute right-0 text-[10px] font-bold text-emerald-600 dark:text-emerald-400 uppercase tracking-widest leading-4">
              TP ${fmt(pos.take_profit)}
            </span>
          </div>
          <div className="relative h-2 bg-slate-100 dark:bg-white/8 rounded-full overflow-hidden">
            {/* Filled portion */}
            <div
              className={`absolute left-0 top-0 h-full rounded-full transition-all duration-700 ${pnlPos ? 'bg-emerald-500' : 'bg-rose-500'}`}
              style={{ width: `${slProgressPct}%` }}
            />
            {/* Partial TP tick mark */}
            {pos.partial_tp_price && (
              <div
                className={`absolute top-0 w-0.5 h-full transition-all duration-700 ${pos.partial_done ? 'bg-amber-400/40' : 'bg-amber-400'}`}
                style={{ left: `${ptpProgressPct}%` }}
              />
            )}
            {/* Mark price dot */}
            <div
              className="absolute top-1/2 -translate-y-1/2 w-3 h-3 rounded-full bg-white border-2 border-indigo-500 shadow-md transition-all duration-700"
              style={{ left: `calc(${slProgressPct}% - 6px)` }}
            />
          </div>
          <div className="flex justify-between text-[10px] font-mono text-slate-400 dark:text-slate-500 mt-2">
            <Tooltip text="Distanza in USD e percentuale tra il prezzo corrente e lo Stop Loss." pos="top">
              <span>↔ SL: ${distToSL.toFixed(0)} ({distToSLPct.toFixed(2)}%)</span>
            </Tooltip>
            <Tooltip text={`R:R attuale: per ogni $ rischiato verso SL, il TP ne vale ${rr}.`} pos="top">
              <span className="font-bold text-indigo-500 dark:text-indigo-400">R:R {rr}</span>
            </Tooltip>
            <Tooltip text="Distanza in USD e percentuale tra il prezzo corrente e il Take Profit." pos="top">
              <span>↔ TP: ${distToTP.toFixed(0)} ({distToTPPct.toFixed(2)}%)</span>
            </Tooltip>
          </div>
          {/* Partial TP info row */}
          {pos.partial_tp_price && (
            <div className="flex justify-center mt-1.5">
              {pos.partial_done ? (
                <span className="text-[10px] font-mono text-amber-500/70">
                  ⚡ Partial TP eseguito · realizzato {(pos.partial_realized_pnl ?? 0) >= 0 ? '+' : ''}${(pos.partial_realized_pnl ?? 0).toFixed(2)}
                </span>
              ) : (
                <span className="text-[10px] font-mono text-amber-500">
                  ⚡ PTP @ ${fmt(pos.partial_tp_price)} · mancano ${distToPTP.toFixed(0)} ({distToPTPPct.toFixed(2)}%)
                </span>
              )}
            </div>
          )}
        </div>
      )}

      {/* Trend Continuation Meter */}
      {trendMeter && <TrendMeter meter={trendMeter} />}

      {/* Trade management badges */}
      <div className="px-6 py-4 border-b border-slate-100 dark:border-white/5">
        <p className="text-[10px] font-bold text-slate-400 dark:text-slate-500 uppercase tracking-widest mb-3">Gestione Trade</p>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
          {/* Partial TP */}
          <TradeBadge
            label="Partial TP"
            done={pos.partial_done}
            doneText={
              (pos.partial_realized_pnl ?? 0) !== 0
                ? `${(pos.partial_realized_pnl ?? 0) >= 0 ? '+' : ''}$${(pos.partial_realized_pnl ?? 0).toFixed(2)}`
                : 'Eseguito'
            }
            pendingText={pos.partial_tp_price ? `@ $${fmt(pos.partial_tp_price)}` : 'Disabilitato'}
            disabled={!pos.partial_tp_price}
          />
          {/* Trailing SL */}
          <TradeBadge
            label="Trailing SL"
            done={pos.sl_trailing_active}
            doneText="Attivo"
            pendingText={pos.trailing_sl_activation_price
              ? `Soglia $${fmt(pos.trailing_sl_activation_price)}`
              : 'Disabilitato'}
            disabled={!pos.trailing_sl_activation_price}
          />
          {/* Breakeven */}
          <TradeBadge
            label="Breakeven SL"
            done={pos.be_sl_applied}
            doneText={`SL → $${fmt(pos.entry_price)}`}
            pendingText="In attesa"
            disabled={!beSlEnabled}
          />
          {/* LGBM strikes */}
          <div className={`flex flex-col gap-1 px-3 py-2.5 rounded-xl border text-xs ${
            (pos.lgbm_strikes ?? 0) > 0
              ? 'bg-amber-50 dark:bg-amber-500/10 border-amber-200 dark:border-amber-500/25 text-amber-700 dark:text-amber-400'
              : 'bg-slate-50 dark:bg-white/5 border-slate-100 dark:border-white/8 text-slate-400 dark:text-slate-500'
          }`}>
            <span className="text-[9px] font-bold uppercase tracking-widest opacity-70">LGBM Strikes</span>
            <span className="font-bold font-mono">{pos.lgbm_strikes ?? 0} / {lgbmConfirmBars}</span>
          </div>
          {/* Trend Exit strikes — visible only when feature is enabled */}
          {trendExitEnabled && (
            <div className={`flex flex-col gap-1 px-3 py-2.5 rounded-xl border text-xs ${
              (pos.trend_strikes ?? 0) > 0
                ? 'bg-orange-50 dark:bg-orange-500/10 border-orange-200 dark:border-orange-500/25 text-orange-700 dark:text-orange-400'
                : 'bg-slate-50 dark:bg-white/5 border-slate-100 dark:border-white/8 text-slate-400 dark:text-slate-500'
            }`}>
              <span className="text-[9px] font-bold uppercase tracking-widest opacity-70">Trend Strikes</span>
              <span className="font-bold font-mono">{pos.trend_strikes ?? 0} / {trendExitConfirmBars}</span>
            </div>
          )}
        </div>
      </div>

      {/* Entry reasoning — why the trade was opened */}
      {pos.entry_reasoning && pos.entry_reasoning.length > 0 && (
        <div className="px-6 py-4 border-b border-slate-100 dark:border-white/5">
          <p className="text-[10px] font-bold text-slate-400 dark:text-slate-500 uppercase tracking-widest mb-3">Perché Aperto</p>
          {/* Natural language narrative */}
          <p className="text-[12px] text-slate-600 dark:text-slate-300 leading-relaxed mb-4">
            {parseBold(buildTradeNarrative(pos, chronosEnabled))}
          </p>
          {/* Technical details — collapsible */}
          <details className="group">
            <summary className="flex items-center gap-1.5 text-[10px] font-bold text-slate-400 dark:text-slate-500 uppercase tracking-widest cursor-pointer select-none hover:text-slate-600 dark:hover:text-slate-300 list-none mb-1">
              <svg className="w-2.5 h-2.5 transition-transform group-open:rotate-90" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M9 5l7 7-7 7"/>
              </svg>
              Dettagli tecnici
            </summary>
            <div className="space-y-1 mt-2">
              {pos.entry_reasoning.map((line, i) => (
                <p key={i} className="text-[11px] font-mono text-slate-600 dark:text-slate-300 leading-relaxed">
                  <span className="text-indigo-400 mr-1.5">›</span>{line}
                </p>
              ))}
            </div>
          </details>
        </div>
      )}

      {/* Current cycle signals — are they still strong? */}
      {lastCycleSignals && (
        <div className="px-6 py-4 border-b border-slate-100 dark:border-white/5">
          {/* Header: title + timestamp + status badge */}
          <div className="flex items-center justify-between mb-1">
            <p className="text-[10px] font-bold text-slate-400 dark:text-slate-500 uppercase tracking-widest">Segnali Attuali</p>
            <span className={`text-[9px] font-bold uppercase tracking-widest px-2 py-0.5 rounded-full ${
              lastCycleSignals.action === pos.side
                ? 'bg-emerald-50 dark:bg-emerald-500/10 text-emerald-600 dark:text-emerald-400'
                : lastCycleSignals.action === 'no_trade'
                  ? 'bg-slate-50 dark:bg-white/5 text-slate-400 dark:text-slate-500'
                  : 'bg-amber-50 dark:bg-amber-500/10 text-amber-600 dark:text-amber-400'
            }`}>
              {lastCycleSignals.action === pos.side ? '✓ Confermato' : lastCycleSignals.action === 'no_trade' ? 'Neutro' : '⚠ Contrario'}
            </span>
          </div>
          {/* Timestamp */}
          <p className="text-[10px] text-slate-400 dark:text-slate-500 mb-3">
            Aggiornato: <span className="font-mono font-semibold text-slate-500 dark:text-slate-400">{formatSignalTime(lastCycleSignals.updated_at)}</span>
          </p>

          {/* 4-column probability grid */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mb-4">
            {[
              { label: 'Ensemble', value: `${lastCycleSignals.ensemble_pct.toFixed(1)}%`, highlight: lastCycleSignals.ensemble_pct >= 60 },
              { label: 'LGBM 4H', value: `${lastCycleSignals.lgbm_pct.toFixed(1)}%`, highlight: lastCycleSignals.lgbm_pct >= 55 },
              { label: 'C2 Dir', value: `${lastCycleSignals.c2_dir_pct.toFixed(1)}%`, highlight: lastCycleSignals.c2_dir_pct >= 55 },
              { label: 'C2 Cont', value: `${lastCycleSignals.c2_cont_prob.toFixed(0)}%`, highlight: lastCycleSignals.c2_cont_prob >= 50 },
            ].map(({ label, value, highlight }) => (
              <div key={label} className="bg-slate-50 dark:bg-white/5 rounded-lg p-2 text-center">
                <p className="text-[9px] font-bold text-slate-400 dark:text-slate-500 uppercase tracking-widest mb-0.5">{label}</p>
                <p className={`text-xs font-bold font-mono ${highlight ? 'text-indigo-600 dark:text-indigo-400' : 'text-slate-500 dark:text-slate-400'}`}>{value}</p>
              </div>
            ))}
          </div>

          {/* Natural-language narrative */}
          <p className="text-[12px] text-slate-600 dark:text-slate-300 leading-relaxed mb-3">
            {parseBold(buildSignalNarrative(lastCycleSignals))}
          </p>

          {/* Collapsible technical details */}
          {lastCycleSignals.reasoning.length > 0 && (
            <details className="group">
              <summary className="flex items-center gap-1.5 text-[10px] font-bold text-slate-400 dark:text-slate-500 uppercase tracking-widest cursor-pointer select-none hover:text-slate-600 dark:hover:text-slate-300 list-none mb-1">
                <svg className="w-2.5 h-2.5 transition-transform group-open:rotate-90" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M9 5l7 7-7 7"/>
                </svg>
                Dettagli tecnici
              </summary>
              <div className="space-y-0.5 mt-2">
                {lastCycleSignals.reasoning.map((line, i) => (
                  <p key={i} className="text-[10px] font-mono text-slate-500 dark:text-slate-400">
                    <span className="text-indigo-400 mr-1.5">›</span>{line}
                  </p>
                ))}
              </div>
            </details>
          )}
        </div>
      )}

      {/* Size footer */}
      <div className="px-6 py-4 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between border-t border-slate-100 dark:border-white/5">
        <div className="flex flex-wrap gap-x-6 gap-y-2 text-[11px] font-mono text-slate-400 dark:text-slate-500">
          <span>Size: <span className="text-slate-600 dark:text-slate-300 font-bold">${pos.size_usd.toFixed(0)}</span></span>
          <span>Contratti: <span className="text-slate-600 dark:text-slate-300 font-bold">{pos.size_contracts?.toFixed(4)} BTC</span></span>
          {pos.entry_atr && (
            <span>ATR entry: <span className="text-slate-600 dark:text-slate-300 font-bold">${pos.entry_atr.toFixed(0)}</span></span>
          )}
        </div>
        <button
          onClick={onClose}
          className="w-full sm:w-auto flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg text-[11px] font-bold uppercase tracking-widest border border-amber-300 dark:border-amber-500/40 bg-amber-50 dark:bg-amber-500/10 text-amber-700 dark:text-amber-400 hover:bg-amber-100 dark:hover:bg-amber-500/20 transition-colors"
        >
          <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
            <path d="M18 6L6 18M6 6l12 12"/>
          </svg>
          Chiudi Posizione
        </button>
      </div>
    </div>
  );
};

// ── Trend Continuation Meter ──────────────────────────────────────────────────

const TrendMeter: React.FC<{ meter: TrendMeterData }> = ({ meter }) => {
  const score = meter.display_score ?? 0;
  const pred  = meter.predictive   ?? 0;
  const s4h   = meter.strategic_4h?.score ?? null;
  const t1h   = meter.tactical_1h?.score  ?? null;
  const p15m  = meter.pulse_15m?.score    ?? null;
  const has1hModel = meter.tactical_1h?.model_available ?? false;

  // Colour gradient: emerald ≥65, amber 40-64, rose <40
  const barColor =
    score >= 65 ? 'from-emerald-500 to-emerald-400'
    : score >= 40 ? 'from-amber-500 to-amber-400'
    : 'from-rose-500 to-rose-400';
  const scoreColor =
    score >= 65 ? 'text-emerald-600 dark:text-emerald-400'
    : score >= 40 ? 'text-amber-600 dark:text-amber-400'
    : 'text-rose-600 dark:text-rose-400';
  const labelColor =
    score >= 65 ? 'bg-emerald-50 dark:bg-emerald-500/10 text-emerald-700 dark:text-emerald-400 border-emerald-200 dark:border-emerald-500/25'
    : score >= 40 ? 'bg-amber-50 dark:bg-amber-500/10 text-amber-700 dark:text-amber-400 border-amber-200 dark:border-amber-500/25'
    : 'bg-rose-50 dark:bg-rose-500/10 text-rose-700 dark:text-rose-400 border-rose-200 dark:border-rose-500/25';

  // Mini sub-bar helpers
  const SubBar: React.FC<{ value: number | null; label: string; tooltip: string }> = ({ value, label, tooltip }) => {
    const v = value ?? 50;
    const col = v >= 65 ? 'bg-emerald-500' : v >= 40 ? 'bg-amber-500' : 'bg-rose-500';
    return (
      <Tooltip text={tooltip} pos="top">
        <div className="flex flex-col gap-0.5 min-w-0">
          <div className="flex items-center justify-between gap-1">
            <span className="text-[8px] font-bold text-slate-400 dark:text-slate-500 uppercase tracking-widest truncate">{label}</span>
            <span className={`text-[9px] font-bold font-mono tabular-nums ${
              v >= 65 ? 'text-emerald-600 dark:text-emerald-400' : v >= 40 ? 'text-amber-600 dark:text-amber-400' : 'text-rose-600 dark:text-rose-400'
            }`}>{value !== null ? `${v.toFixed(0)}` : '—'}</span>
          </div>
          <div className="h-1 bg-slate-100 dark:bg-white/8 rounded-full overflow-hidden">
            <div
              className={`h-full rounded-full transition-all duration-700 ${col}`}
              style={{ width: `${value !== null ? v : 50}%` }}
            />
          </div>
        </div>
      </Tooltip>
    );
  };

  const s4hSource    = meter.strategic_4h?.source;
  const s4hMlPending = meter.strategic_4h?.ml_pending === true;
  const s4hTime      = meter.strategic_4h?.updated_at ? new Date(meter.strategic_4h.updated_at).toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' }) : null;
  const s4hLabel     = s4hMlPending ? '4H · Strutturale ⏳' : s4hSource === 'fresh' ? '4H · Ora ⚡' : '4H · Strategico';
  const s4hSourceNote = s4hMlPending
    ? 'ML in attesa del primo ciclo 4H (bot appena avviato o nessun ciclo ancora completato). Mostra solo ADX + regime — il componente LGBM si aggiungerà alla prossima chiusura 4H.'
    : s4hSource === 'fresh'
      ? 'Calcolato ora (LGBM ultimo ciclo + ADX + regime da dati recenti). Si consolida alla prossima chiusura 4H.'
      : `Aggiornato all'ultima chiusura 4H: ${s4hTime ?? '—'}`;
  const t1hTime = meter.tactical_1h?.updated_at  ? new Date(meter.tactical_1h.updated_at).toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' }) : null;
  const p15mTime = meter.pulse_15m?.updated_at   ? new Date(meter.pulse_15m.updated_at).toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' }) : null;

  return (
    <div className="px-6 py-4 border-b border-slate-100 dark:border-white/5">
      {/* Header */}
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <p className="text-[10px] font-bold text-slate-400 dark:text-slate-500 uppercase tracking-widest">
            Forza Trend
          </p>
          <Tooltip
            text={`Punteggio multi-timeframe che misura la forza e la probabilità di continuazione del trend nella direzione del trade.\n\n• 4H Strategico: ensemble LGBM+Chronos + ADX 4H + regime giornaliero. ${s4hSourceNote}\n• 1H Tattico (${t1hTime ?? '—'}): modello gate 1H${has1hModel ? '' : ' non disponibile — valore neutro 50'} — "il prezzo sta prendendo la direzione sperata?". Aggiorna ogni ora.\n• 15m Polso (${p15mTime ?? '—'}): momentum leggero (direzione ultime 4 candele + EMA 8). Descrittivo, non predittivo. Aggiorna ogni ~60s.\n\nScore finale = (4H × 0.55 + 1H × 0.45) ± modulazione 15m (max ±10 pt).`}
            pos="bottom"
            width="wide"
          >
            <svg className="w-3 h-3 text-slate-400 dark:text-slate-500 cursor-help" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <circle cx="12" cy="12" r="10"/><path d="M12 16v-4m0-4h.01"/>
            </svg>
          </Tooltip>
        </div>
        <span className={`text-[9px] font-bold uppercase tracking-widest px-2 py-0.5 rounded-full border ${labelColor}`}>
          {meter.label}
        </span>
      </div>

      {/* Main score + bar */}
      <div className="flex items-center gap-4 mb-3">
        <span className={`text-2xl font-bold font-mono tabular-nums w-12 shrink-0 ${scoreColor}`}>
          {score.toFixed(0)}
        </span>
        <div className="flex-1 relative">
          {/* Track */}
          <div className="h-3 bg-slate-100 dark:bg-white/8 rounded-full overflow-hidden">
            <div
              className={`h-full rounded-full bg-gradient-to-r transition-all duration-700 ${barColor}`}
              style={{ width: `${score}%` }}
            />
          </div>
          {/* Threshold ticks */}
          <div className="absolute top-0 h-3 w-full pointer-events-none">
            {/* 40 threshold */}
            <div className="absolute top-0 h-full w-px bg-slate-300 dark:bg-white/20" style={{ left: '40%' }} />
            {/* 65 threshold */}
            <div className="absolute top-0 h-full w-px bg-slate-300 dark:bg-white/20" style={{ left: '65%' }} />
          </div>
        </div>
        <div className="text-right shrink-0">
          <p className="text-[9px] font-bold text-slate-400 dark:text-slate-500 uppercase tracking-widest">Predittivo</p>
          <p className="text-[11px] font-bold font-mono text-slate-600 dark:text-slate-300">{pred.toFixed(0)}</p>
        </div>
      </div>

      {/* Scale labels */}
      <div className="flex justify-between text-[8px] font-bold text-slate-300 dark:text-slate-600 uppercase tracking-widest mb-4 px-12">
        <span>Debole</span>
        <span>In indebolimento</span>
        <span>Forte</span>
      </div>

      {/* ML pending notice */}
      {s4hMlPending && (
        <div className="mb-3 flex items-center gap-2 px-3 py-2 rounded-lg bg-amber-50 dark:bg-amber-500/10 border border-amber-200 dark:border-amber-500/25">
          <svg className="w-3 h-3 text-amber-500 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <circle cx="12" cy="12" r="10"/><path d="M12 8v4m0 4h.01"/>
          </svg>
          <p className="text-[10px] text-amber-700 dark:text-amber-400">
            <span className="font-bold">ML in attesa</span> — componente LGBM 4H non ancora disponibile (primo ciclo 4H non completato). Il valore riflette solo ADX e regime strutturale.
          </p>
        </div>
      )}

      {/* Three sub-bars */}
      <div className="grid grid-cols-3 gap-3">
        <SubBar
          value={s4h}
          label={s4hLabel}
          tooltip={[
            'Score 4H (predittivo):',
            meter.strategic_4h?.ml_pending
              ? '⏳ ML in attesa del primo ciclo 4H — solo ADX e regime strutturale.'
              : `• Direzione LGBM: ${meter.strategic_4h?.components.direction?.toFixed(0) ?? '—'}/100`,
            `• ADX 4H: ${meter.strategic_4h?.components.adx?.toFixed(0) ?? '—'}/100`,
            `• Regime 1D/MTF: ${meter.strategic_4h?.components.mtf?.toFixed(0) ?? '—'}/100`,
            meter.strategic_4h?.chronos && meter.strategic_4h?.components.c2_cont != null
              ? `• Continuazione C2: ${meter.strategic_4h.components.c2_cont?.toFixed(0)}/100`
              : '• C2 Chronos: disabilitato (escluso)',
            s4hSourceNote,
          ].filter(Boolean).join('\n')}
        />
        <SubBar
          value={t1h}
          label={`1H · Tattico${has1hModel ? '' : ' ⚠'}`}
          tooltip={[
            'Score 1H (predittivo — solo gate model):',
            has1hModel
              ? `• P(direzione corretta su 1H): ${meter.tactical_1h?.components.gate_prob?.toFixed(0) ?? '—'}%\n  (50% = neutro, 100% = max conferma)`
              : '⚠ Modello 1H non addestrato — valore neutro (50).\nEsegui un retrain 1H per attivare questo strato.',
            'ADX su 1H escluso: già incluso nel modello, laggante sul TF orario.',
            `Aggiornato: ${t1hTime ?? 'in attesa…'}`,
          ].join('\n')}
        />
        <SubBar
          value={p15m}
          label="15m · Polso"
          tooltip={`Polso 15m (descrittivo — non predittivo):\n• Direzione ultime 4 candele: ${meter.pulse_15m?.components.direction_4c?.toFixed(0) ?? '—'}\n• EMA 8 (≈2h): ${meter.pulse_15m?.components.ema_8?.toFixed(0) ?? '—'}\nFa "respirare" la barra tra le candele 4H senza impatto sull'auto-chiusura.\nAggiornato: ${p15mTime ?? 'in attesa…'}`}
        />
      </div>
    </div>
  );
};

const TradeBadge: React.FC<{
  label: string;
  done: boolean;
  doneText: string;
  pendingText: string;
  disabled: boolean;
}> = ({ label, done, doneText, pendingText, disabled }) => (
  <div className={`flex flex-col gap-1 px-3 py-2.5 rounded-xl border text-xs transition-colors ${
    disabled
      ? 'bg-slate-50 dark:bg-white/[0.03] border-slate-100 dark:border-white/5 opacity-40'
      : done
        ? 'bg-emerald-50 dark:bg-emerald-500/10 border-emerald-200 dark:border-emerald-500/25 text-emerald-700 dark:text-emerald-400'
        : 'bg-slate-50 dark:bg-white/5 border-slate-100 dark:border-white/8 text-slate-500 dark:text-slate-400'
  }`}>
    <span className="text-[9px] font-bold uppercase tracking-widest opacity-70">{label}</span>
    <span className="font-bold font-mono leading-tight">{done ? `✓ ${doneText}` : pendingText}</span>
  </div>
);

// ── Equity curve SVG ──────────────────────────────────────────────────────────

const EquityCurveChart: React.FC<{ data: EquitySnap[]; startCapital: number }> = ({ data, startCapital }) => {
  const W = 600, H = 110;
  const PAD = { l: 54, r: 12, t: 8, b: 22 };
  const cW = W - PAD.l - PAD.r;
  const cH = H - PAD.t - PAD.b;

  // Prepend a synthetic start-capital point so the chart works with a single snapshot
  const rawVals = data.map(d => d.equity_usd);
  const vals = rawVals.length === 1 ? [startCapital, ...rawVals] : rawVals;
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

  // Time labels: first + last — use data[] indices (not vals[] which may include synthetic start point)
  const firstDate = data[0]?.time ? new Date(data[0].time).toLocaleDateString('it-IT', { day: '2-digit', month: '2-digit' }) : '';
  const lastDate  = data[data.length - 1]?.time ? new Date(data[data.length - 1].time).toLocaleDateString('it-IT', { day: '2-digit', month: '2-digit' }) : '';

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
  label, value, sub, color = 'text-slate-900 dark:text-white',
}) => (
  <div className="elegant-card p-5 bg-white dark:bg-[#151E32] w-full h-full flex flex-col justify-between">
    <p className="text-[10px] font-bold text-slate-400 dark:text-slate-500 uppercase tracking-widest mb-2">{label}</p>
    <div>
      <p className={`text-lg sm:text-2xl font-bold font-mono tracking-tighter ${color}`}>{value}</p>
      {sub && <p className="text-xs font-semibold text-slate-500 dark:text-slate-400 mt-1">{sub}</p>}
    </div>
  </div>
);

const StatusBadge: React.FC<{ label: string; active: boolean }> = ({ label, active }) => (
  <div className={`flex items-center gap-1.5 px-3 py-1 rounded-full text-[10px] font-bold uppercase tracking-wider border transition-all ${
    active ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400'
           : 'border-slate-200 dark:border-white/10 bg-slate-50 dark:bg-white/5 text-slate-400 dark:text-slate-500'
  }`}>
    <span className={`w-1.5 h-1.5 rounded-full ${active ? 'bg-emerald-500 animate-pulse' : 'bg-slate-300 dark:bg-slate-700'}`} />
    {label}
  </div>
);
