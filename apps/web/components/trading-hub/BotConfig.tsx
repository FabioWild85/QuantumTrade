import React, { useEffect, useState } from 'react';
import { Tooltip } from './Tooltip';

interface Config {
  sl_atr_mult: number;
  tp_atr_mult: number;
  position_size_pct: number;
  max_daily_dd_pct: number;
  directional_threshold: number;
  adx_gate: number;
  confluence_gate: number;
  max_consecutive_losses: number;
  mode: 'paper' | 'live';
  dynamic_sl_tp_enabled: boolean;
  dynamic_sl_tp_blend: number;
  c2_uncertainty_gate_enabled: boolean;
  c2_uncertainty_threshold: number;
  c2_cont_prob_gate_enabled: boolean;
  c2_cont_prob_threshold: number;
  chronos_enabled: boolean;
  regime_bias_enabled: boolean;
  regime_bias_delta: number;
  regime_bias_size_factor: number;
  forced_regime: 'auto' | 'bull' | 'bear' | 'neutral';
}

const DEFAULTS: Config = {
  sl_atr_mult: 2.0,
  tp_atr_mult: 3.5,
  position_size_pct: 1.5,
  max_daily_dd_pct: 3.0,
  directional_threshold: 0.62,
  adx_gate: 20.0,
  confluence_gate: 60.0,
  max_consecutive_losses: 4,
  mode: 'paper',
  dynamic_sl_tp_enabled: false,
  dynamic_sl_tp_blend: 0.5,
  c2_uncertainty_gate_enabled: false,
  c2_uncertainty_threshold: 0.05,
  c2_cont_prob_gate_enabled: false,
  c2_cont_prob_threshold: 0.10,
  chronos_enabled: true,
  regime_bias_enabled: false,
  regime_bias_delta: 0.08,
  regime_bias_size_factor: 1.0,
  forced_regime: 'auto',
};

interface RetrainMetrics {
  status: 'ok' | 'busy';
  trained_at?: string;
  elapsed_s?: number;
  train_rows?: number;
  val_rows?: number;
  n_features?: number;
  oos_accuracy?: number;
  oos_log_loss?: number;
  best_iteration?: number | null;
}

export const BotConfig: React.FC<{ apiBase: string }> = ({ apiBase }) => {
  const [config, setConfig]             = useState<Config>(DEFAULTS);
  const [saved, setSaved]               = useState(false);
  const [loading, setLoading]           = useState(false);
  const [modelLoaded, setModelLoaded]   = useState<boolean | null>(null);
  const [retraining, setRetraining]     = useState(false);
  const [retrainResult, setRetrainResult] = useState<RetrainMetrics | null>(null);
  const [lastRetrain, setLastRetrain]   = useState<RetrainMetrics | null>(null);
  const [hlTestnet, setHlTestnet]       = useState<boolean | null>(null);

  useEffect(() => {
    fetch(`${apiBase}/bot`)
      .then(r => r.ok ? r.json() : null)
      .then(d => d && setConfig(c => ({ ...c, ...d })))
      .catch(() => {});
    // Fetch bot status to populate model info and network config
    fetch(`${apiBase}/bot/status`)
      .then(r => r.ok ? r.json() : null)
      .then(s => {
        if (!s) return;
        setModelLoaded(s.model_loaded ?? false);
        setHlTestnet(s.hl_testnet ?? true);
        if (s.last_retrain) setLastRetrain(s.last_retrain);
        if (s.retrain_in_progress) setRetraining(true);
      })
      .catch(() => {});
  }, [apiBase]);

  const handleRetrain = async () => {
    if (!confirm('Avvia retrain manuale di LightGBM?\n\nIl modello verrà ricalcolato sugli ultimi 500 candles (4h). Il processo dura 10–30 secondi.')) return;
    setRetraining(true);
    setRetrainResult(null);
    try {
      const r = await fetch(`${apiBase}/retrain`, { method: 'POST' });
      const data: RetrainMetrics = await r.json();
      setRetrainResult(data);
      if (data.status === 'ok') {
        setModelLoaded(true);
        setLastRetrain(data);
      }
    } catch {
      setRetrainResult({ status: 'busy' });
    } finally {
      setRetraining(false);
    }
  };

  const handleSave = async () => {
    if (!confirm(`Salva configurazione in modalità ${config.mode.toUpperCase()}?`)) return;
    setLoading(true);
    try {
      const r = await fetch(`${apiBase}/bot`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(config),
      });
      if (r.ok) {
        setSaved(true);
        setTimeout(() => setSaved(false), 2000);
      }
    } finally {
      setLoading(false);
    }
  };

  const upd = (key: keyof Config) => (v: number) => {
    setConfig(c => ({ ...c, [key]: v }));
  };

  const rr = (config.tp_atr_mult / config.sl_atr_mult).toFixed(2);
  const be = (1 / (1 + config.tp_atr_mult / config.sl_atr_mult) * 100).toFixed(1);

  return (
    <div className="space-y-8 max-w-4xl">
      <div className="mb-8">
        <h2 className="text-xl font-bold text-slate-900 dark:text-white uppercase tracking-tight">Parametri Operativi</h2>
        <p className="text-[11px] font-bold text-slate-400 dark:text-slate-500 uppercase tracking-widest mt-1">Configurazione Strategia BTC-PERP · Trend Following 4h</p>
      </div>

      {/* Mode Selection */}
      <Section title="Ambiente di Esecuzione" description="Seleziona la modalità operativa del bot. Il Paper Trading simula l'esecuzione, il Live Trading opera con fondi reali.">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <Tooltip text="Paper Trading: il bot simula operazioni usando dati reali di mercato ma senza usare fondi veri. Ideale per testare la strategia senza rischi." pos="bottom">
            <button
              onClick={() => setConfig(c => ({ ...c, mode: 'paper' }))}
              className={`w-full py-4 rounded-xl text-[11px] font-bold uppercase tracking-widest transition-all border ${
                config.mode === 'paper'
                  ? 'bg-indigo-600 text-white border-indigo-600 shadow-lg shadow-indigo-500/30'
                  : 'bg-slate-50 dark:bg-white/5 text-slate-400 dark:text-slate-500 border-slate-100 dark:border-white/10 hover:bg-slate-100 dark:hover:bg-white/10'
              }`}
            >
              Paper Trading
            </button>
          </Tooltip>
          <Tooltip text="Live Trading: il bot opera con fondi reali su Hyperliquid. Richiede un agent wallet configurato nelle Impostazioni. Usare con cautela." pos="bottom">
            <button
              onClick={() => setConfig(c => ({ ...c, mode: 'live' }))}
              className={`w-full py-4 rounded-xl text-[11px] font-bold uppercase tracking-widest transition-all border ${
                config.mode === 'live'
                  ? 'bg-slate-900 dark:bg-white text-white dark:text-slate-900 border-slate-900 dark:border-white shadow-lg'
                  : 'bg-slate-50 dark:bg-white/5 text-slate-400 dark:text-slate-500 border-slate-100 dark:border-white/10 hover:bg-slate-100 dark:hover:bg-white/10'
              }`}
            >
              Live Trading
            </button>
          </Tooltip>
        </div>
        {config.mode === 'live' && (
          <div className="mt-4 flex items-start gap-3 bg-rose-50 dark:bg-rose-500/10 border border-rose-100 dark:border-rose-500/20 rounded-xl px-4 py-3 animate-in fade-in slide-in-from-top-1">
             <svg className="w-5 h-5 text-rose-500 flex-shrink-0 mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" /></svg>
             <p className="text-[10px] font-bold text-rose-600 dark:text-rose-400 uppercase tracking-tight leading-relaxed">
               Attenzione: La modalità Live utilizza asset reali su Hyperliquid. Verifica attentamente le soglie di rischio prima di salvare.
             </p>
          </div>
        )}
      </Section>

      {/* Network for live orders */}
      <Section
        title="Rete Ordini Live"
        description="Indica su quale rete Hyperliquid vengono inviati gli ordini quando il bot è in modalità Live. I dati di mercato (prezzi, OHLCV) vengono sempre da mainnet."
      >
        {hlTestnet === null ? (
          <div className="h-16 bg-slate-100 dark:bg-white/5 rounded-xl animate-pulse" />
        ) : (
          <div className="space-y-4">
            {/* Current network badge */}
            <div className={`flex items-center justify-between p-4 rounded-xl border ${
              hlTestnet
                ? 'bg-amber-50 dark:bg-amber-500/10 border-amber-200 dark:border-amber-500/25'
                : 'bg-rose-50 dark:bg-rose-500/10 border-rose-200 dark:border-rose-500/25'
            }`}>
              <div className="flex items-center gap-3">
                <span className={`w-2.5 h-2.5 rounded-full ${hlTestnet ? 'bg-amber-500' : 'bg-rose-500 animate-pulse'}`} />
                <div>
                  <p className={`text-xs font-bold uppercase tracking-widest ${hlTestnet ? 'text-amber-700 dark:text-amber-400' : 'text-rose-700 dark:text-rose-400'}`}>
                    {hlTestnet ? 'Hyperliquid Testnet' : 'Hyperliquid Mainnet'}
                  </p>
                  <p className="text-[10px] text-slate-500 dark:text-slate-400 mt-0.5">
                    {hlTestnet
                      ? 'Ordini con fondi virtuali — nessun rischio reale'
                      : 'Ordini con fondi reali — massima attenzione'}
                  </p>
                </div>
              </div>
              <span className={`text-[9px] font-bold uppercase tracking-widest px-2 py-1 rounded border ${
                hlTestnet
                  ? 'bg-amber-100 dark:bg-amber-500/15 text-amber-700 dark:text-amber-400 border-amber-300 dark:border-amber-500/30'
                  : 'bg-rose-100 dark:bg-rose-500/15 text-rose-700 dark:text-rose-400 border-rose-300 dark:border-rose-500/30'
              }`}>
                {hlTestnet ? 'TESTNET' : 'MAINNET'}
              </span>
            </div>

            {/* How to switch */}
            <div className="bg-slate-50 dark:bg-white/[0.03] border border-slate-100 dark:border-white/8 rounded-xl p-4 space-y-2">
              <p className="text-[10px] font-bold text-slate-500 dark:text-slate-400 uppercase tracking-widest">Come cambiare rete</p>
              <p className="text-[11px] text-slate-500 dark:text-slate-400 leading-relaxed">
                La rete è configurata tramite variabile d'ambiente <code className="text-indigo-600 dark:text-indigo-400 bg-indigo-50 dark:bg-indigo-500/10 px-1 rounded">HL_TESTNET</code> nel file <code className="text-indigo-600 dark:text-indigo-400 bg-indigo-50 dark:bg-indigo-500/10 px-1 rounded">.env</code> sul VPS.
              </p>
              <div className="font-mono text-[10px] bg-slate-900 dark:bg-black/40 text-emerald-400 rounded-lg px-3 py-2 space-y-0.5 mt-2">
                <div className="text-slate-500"># Testnet (default — ordini virtuali)</div>
                <div>HL_TESTNET=<span className="text-amber-400">true</span></div>
                <div className="text-slate-500 mt-1"># Mainnet (fondi reali)</div>
                <div>HL_TESTNET=<span className="text-rose-400">false</span></div>
              </div>
              <p className="text-[10px] text-slate-400 dark:text-slate-500 leading-relaxed mt-1">
                Dopo aver modificato il file, riavvia il servizio con <code className="text-indigo-600 dark:text-indigo-400 bg-indigo-50 dark:bg-indigo-500/10 px-1 rounded">systemctl restart quantum-trade</code>.
              </p>
            </div>
          </div>
        )}
      </Section>

      {/* Risk Management */}
      <Section title="Risk Management" description="Gestione dell'esposizione e dei livelli di uscita. Questi parametri determinano la conservatività del bot.">

        {/* ── Dynamic SL/TP toggle ── */}
        <div className={`flex flex-col gap-3 mb-6 pb-6 border-b transition-colors duration-200 ${config.dynamic_sl_tp_enabled ? 'border-violet-200 dark:border-violet-500/25' : 'border-slate-100 dark:border-white/5'}`}>
          <Tooltip text="Quando attivo, SL e TP vengono calcolati blendando ATR con le previsioni probabilistiche p10/p90 di Chronos-2. I moltiplicatori fissi SL/TP vengono ignorati. Richiede Chronos-2 attivo nel bot." width="wide" pos="bottom">
            <label className="flex items-center gap-3 cursor-pointer group">
              <div className="relative">
                <input type="checkbox" className="sr-only" checked={config.dynamic_sl_tp_enabled} onChange={e => setConfig(c => ({ ...c, dynamic_sl_tp_enabled: e.target.checked }))} />
                <div className={`w-10 h-5 rounded-full transition-all duration-300 ${config.dynamic_sl_tp_enabled ? 'bg-violet-600' : 'bg-slate-200 dark:bg-white/10'}`} />
                <div className={`absolute top-1 left-1 w-3 h-3 bg-white rounded-full shadow-sm transition-transform duration-300 ${config.dynamic_sl_tp_enabled ? 'translate-x-5' : ''}`} />
              </div>
              <div>
                <p className={`text-sm font-bold transition-colors ${config.dynamic_sl_tp_enabled ? 'text-violet-600 dark:text-violet-400' : 'text-slate-800 dark:text-slate-200 group-hover:text-violet-600 dark:group-hover:text-violet-400'}`}>
                  SL/TP Adattativi (AI-driven)
                  {config.dynamic_sl_tp_enabled && (
                    <span className="ml-2 px-1.5 py-0.5 rounded text-[9px] font-bold bg-violet-100 dark:bg-violet-500/20 text-violet-600 dark:text-violet-400 uppercase tracking-wider">Attivo</span>
                  )}
                </p>
                <p className="text-[11px] font-medium text-slate-400 dark:text-slate-500 leading-tight">
                  {config.dynamic_sl_tp_enabled
                    ? 'Moltiplicatori SL/TP fissi disabilitati — livelli calcolati da Chronos p10/p90'
                    : 'Attiva per sostituire i moltiplicatori fissi con livelli AI adattativi basati su Chronos-2'}
                </p>
              </div>
            </label>
          </Tooltip>
          {config.dynamic_sl_tp_enabled && (
            <div className="flex items-center gap-4 pl-12">
              <span className="text-[10px] font-bold text-slate-400 dark:text-slate-500 uppercase tracking-widest whitespace-nowrap">Blend ATR ↔ C2</span>
              <div className="flex items-center gap-3 flex-1">
                <span className="text-[10px] font-bold text-slate-500 dark:text-slate-400 font-mono">ATR</span>
                <input
                  type="range" min="0" max="1" step="0.05"
                  value={config.dynamic_sl_tp_blend}
                  onChange={e => setConfig(c => ({ ...c, dynamic_sl_tp_blend: parseFloat(e.target.value) }))}
                  className="flex-1 h-1.5 rounded-full appearance-none cursor-pointer bg-slate-200 dark:bg-white/15 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-3.5 [&::-webkit-slider-thumb]:h-3.5 [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-violet-500 [&::-webkit-slider-thumb]:shadow-sm [&::-webkit-slider-thumb]:cursor-pointer [&::-moz-range-thumb]:w-3.5 [&::-moz-range-thumb]:h-3.5 [&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:bg-violet-500 [&::-moz-range-thumb]:border-0"
                />
                <span className="text-[10px] font-bold text-slate-500 dark:text-slate-400 font-mono">C2</span>
                <span className="text-[11px] font-bold font-mono text-violet-600 dark:text-violet-400 w-20 text-right">
                  {Math.round((1 - config.dynamic_sl_tp_blend) * 100)}% ATR · {Math.round(config.dynamic_sl_tp_blend * 100)}% C2
                </span>
              </div>
            </div>
          )}
          {config.dynamic_sl_tp_enabled && !config.chronos_enabled && (
            <div className="flex items-start gap-3 bg-amber-50 dark:bg-amber-500/10 border border-amber-200 dark:border-amber-500/30 rounded-xl px-4 py-3">
              <svg className="w-4 h-4 text-amber-500 flex-shrink-0 mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" />
              </svg>
              <div>
                <p className="text-[11px] font-bold text-amber-700 dark:text-amber-400 uppercase tracking-wide">Chronos-2 non attivo</p>
                <p className="text-[11px] text-amber-600 dark:text-amber-500 leading-snug mt-0.5">
                  SL/TP Adattativi richiede Chronos-2. Il bot userà SL e TP fissi (ATR) finché Chronos non viene abilitato nelle Impostazioni avanzate.
                </p>
              </div>
            </div>
          )}
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-8 gap-y-6">
          <div className={`transition-all duration-200 ${config.dynamic_sl_tp_enabled ? 'opacity-35 pointer-events-none' : ''}`}>
            <Tooltip text={config.dynamic_sl_tp_enabled ? 'Disabilitato: in modalità AI-driven il valore viene calcolato da Chronos p10/p90.' : 'Distanza dello Stop Loss dal prezzo di entrata, espressa come multiplo dell\'ATR.'} width="wide" pos="bottom">
              <NumInput label="SL Multiplier (× ATR)" value={config.sl_atr_mult} min={0.5} max={5} step={0.1} onChange={upd('sl_atr_mult')} />
            </Tooltip>
          </div>
          <div className={`transition-all duration-200 ${config.dynamic_sl_tp_enabled ? 'opacity-35 pointer-events-none' : ''}`}>
            <Tooltip text={config.dynamic_sl_tp_enabled ? 'Disabilitato: in modalità AI-driven il valore viene calcolato da Chronos p10/p90.' : 'Distanza del Take Profit dal prezzo di entrata, in multipli di ATR.'} width="wide" pos="bottom">
              <NumInput label="TP Multiplier (× ATR)" value={config.tp_atr_mult} min={1} max={10} step={0.1} onChange={upd('tp_atr_mult')} />
            </Tooltip>
          </div>
          <Tooltip text="Percentuale del capitale totale rischiata per ogni singolo trade." width="wide" pos="bottom">
            <NumInput label="Position Size (%)" value={config.position_size_pct} min={0.1} max={5} step={0.1} onChange={upd('position_size_pct')} />
          </Tooltip>
          <Tooltip text="Perdita massima tollerata in un singolo giorno." width="wide" pos="bottom">
            <NumInput label="Max Daily DD (%)" value={config.max_daily_dd_pct} min={0.5} max={10} step={0.5} onChange={upd('max_daily_dd_pct')} />
          </Tooltip>
          <Tooltip text="Numero massimo di trade in perdita consecutivi prima che il bot si fermi." width="wide" pos="bottom">
            <NumInput label="Max Consecutive Losses" value={config.max_consecutive_losses} min={1} max={10} step={1} onChange={upd('max_consecutive_losses')} />
          </Tooltip>
        </div>
        <div className="mt-8 flex gap-12 border-t border-slate-100 dark:border-white/5 pt-6">
          <Tooltip text={config.dynamic_sl_tp_enabled ? 'R:R indicativo — in modalità AI-driven i livelli variano per ogni trade.' : 'Rapporto Rischio/Rendimento: quanti dollari guadagni per ogni dollaro rischiato.'} pos="top">
            <div className="flex flex-col gap-1">
               <span className="text-[10px] font-bold text-slate-400 dark:text-slate-500 uppercase tracking-widest">R:R Ratio</span>
               <span className={`text-lg font-bold font-mono ${config.dynamic_sl_tp_enabled ? 'text-violet-500 dark:text-violet-400' : 'text-indigo-600 dark:text-indigo-400'}`}>
                 {config.dynamic_sl_tp_enabled ? '~' : ''}{rr}
               </span>
            </div>
          </Tooltip>
          <Tooltip text="Win rate minimo per non perdere soldi con questo R:R." pos="top">
            <div className="flex flex-col gap-1">
               <span className="text-[10px] font-bold text-slate-400 dark:text-slate-500 uppercase tracking-widest">Break-even Win Rate</span>
               <span className={`text-lg font-bold font-mono ${config.dynamic_sl_tp_enabled ? 'text-violet-500 dark:text-violet-400' : 'text-indigo-600 dark:text-indigo-400'}`}>
                 {config.dynamic_sl_tp_enabled ? '~' : ''}{be}%
               </span>
            </div>
          </Tooltip>
        </div>
      </Section>

      {/* AI Thresholds */}
      <Section title="Soglie Modelli Ensemble" description="Controllo del rigore dei segnali generati dall'AI. Valori più alti riducono la frequenza operativa aumentando la precisione.">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-8 gap-y-6">
          <Tooltip text="Soglia minima di probabilità direzionale (0–1) per aprire un trade." width="wide" pos="bottom">
            <NumInput label="Directional Threshold" value={config.directional_threshold} min={0.5} max={0.9} step={0.01} onChange={upd('directional_threshold')} />
          </Tooltip>
          <Tooltip text="ADX misura la forza del trend. Sotto questa soglia il bot non opera." width="wide" pos="bottom">
            <NumInput label="ADX Power Gate" value={config.adx_gate} min={10} max={40} step={1} onChange={upd('adx_gate')} />
          </Tooltip>
          <Tooltip text="Punteggio minimo del sistema Quantum Trade (0–100) richiesto come conferma." width="wide" pos="bottom">
            <NumInput label="Confluence confirmation" value={config.confluence_gate} min={0} max={100} step={5} onChange={upd('confluence_gate')} />
          </Tooltip>
        </div>

        {/* ── C2 Uncertainty Gate ── */}
        <div className={`flex flex-col gap-3 mt-6 pt-6 border-t transition-colors duration-200 ${config.c2_uncertainty_gate_enabled ? 'border-cyan-200 dark:border-cyan-500/25' : 'border-slate-100 dark:border-white/5'}`}>
          <Tooltip text="Blocca il trade quando la banda di incertezza di Chronos-2 (p90−p10)/prezzo supera la soglia. Un valore alto = la distribuzione quantile è molto dispersa = modello senza visione chiara. Richiede Chronos-2 attivo." width="wide" pos="bottom">
            <label className="flex items-center gap-3 cursor-pointer group">
              <div className="relative">
                <input type="checkbox" className="sr-only" checked={config.c2_uncertainty_gate_enabled} onChange={e => setConfig(c => ({ ...c, c2_uncertainty_gate_enabled: e.target.checked }))} />
                <div className={`w-10 h-5 rounded-full transition-all duration-300 ${config.c2_uncertainty_gate_enabled ? 'bg-cyan-600' : 'bg-slate-200 dark:bg-white/10'}`} />
                <div className={`absolute top-1 left-1 w-3 h-3 bg-white rounded-full shadow-sm transition-transform duration-300 ${config.c2_uncertainty_gate_enabled ? 'translate-x-5' : ''}`} />
              </div>
              <div>
                <p className={`text-sm font-bold transition-colors ${config.c2_uncertainty_gate_enabled ? 'text-cyan-600 dark:text-cyan-400' : 'text-slate-800 dark:text-slate-200 group-hover:text-cyan-600 dark:group-hover:text-cyan-400'}`}>
                  Uncertainty Gate (Chronos-2)
                  {config.c2_uncertainty_gate_enabled && <span className="ml-2 px-1.5 py-0.5 rounded text-[9px] font-bold bg-cyan-100 dark:bg-cyan-500/20 text-cyan-600 dark:text-cyan-400 uppercase tracking-wider">Attivo</span>}
                </p>
                <p className="text-[11px] font-medium text-slate-400 dark:text-slate-500 leading-tight">
                  No-trade se la previsione C2 è troppo dispersa (banda p10–p90 ampia)
                </p>
              </div>
            </label>
          </Tooltip>
          {config.c2_uncertainty_gate_enabled && !config.chronos_enabled && (
            <div className="flex items-start gap-3 bg-amber-50 dark:bg-amber-500/10 border border-amber-200 dark:border-amber-500/30 rounded-xl px-4 py-3">
              <svg className="w-4 h-4 text-amber-500 flex-shrink-0 mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" />
              </svg>
              <div>
                <p className="text-[11px] font-bold text-amber-700 dark:text-amber-400 uppercase tracking-wide">Chronos-2 non attivo</p>
                <p className="text-[11px] text-amber-600 dark:text-amber-500 leading-snug mt-0.5">
                  L'Uncertainty Gate richiede Chronos-2. Il gate sarà ignorato finché Chronos non viene abilitato nelle Impostazioni avanzate.
                </p>
              </div>
            </div>
          )}
          {config.c2_uncertainty_gate_enabled && (
            <div className="flex items-center gap-4 pl-12">
              <span className="text-[10px] font-bold text-slate-400 dark:text-slate-500 uppercase tracking-widest whitespace-nowrap">Max incertezza</span>
              <div className="flex items-center gap-3 flex-1">
                <input
                  type="range" min="0.01" max="0.15" step="0.005"
                  value={config.c2_uncertainty_threshold}
                  onChange={e => setConfig(c => ({ ...c, c2_uncertainty_threshold: parseFloat(e.target.value) }))}
                  className="flex-1 h-1.5 rounded-full appearance-none cursor-pointer bg-slate-200 dark:bg-white/15 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-3.5 [&::-webkit-slider-thumb]:h-3.5 [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-cyan-500 [&::-webkit-slider-thumb]:shadow-sm [&::-webkit-slider-thumb]:cursor-pointer [&::-moz-range-thumb]:w-3.5 [&::-moz-range-thumb]:h-3.5 [&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:bg-cyan-500 [&::-moz-range-thumb]:border-0"
                />
                <span className="text-[11px] font-bold font-mono text-cyan-600 dark:text-cyan-400 w-14 text-right">
                  {(config.c2_uncertainty_threshold * 100).toFixed(1)}%
                </span>
                <span className="text-[10px] text-slate-400 dark:text-slate-500">(p90−p10)/prezzo</span>
              </div>
            </div>
          )}
        </div>

        {/* ── C2 Continuation Prob Gate ── */}
        <div className={`flex flex-col gap-3 mt-6 pt-6 border-t transition-colors duration-200 ${config.c2_cont_prob_gate_enabled ? 'border-emerald-200 dark:border-emerald-500/25' : 'border-slate-100 dark:border-white/5'}`}>
          <Tooltip text="Blocca il trade quando l'imbalance netto tra bande quantili rialziste e ribassiste è sotto soglia. Le bande opposte si cancellano — un fan simmetrico (metà up, metà down) dà 0%; tutte le bande concordi dà 100%. Soglia consigliata: 10-15%." width="wide" pos="bottom">
            <label className="flex items-center gap-3 cursor-pointer group">
              <div className="relative">
                <input type="checkbox" className="sr-only" checked={config.c2_cont_prob_gate_enabled} onChange={e => setConfig(c => ({ ...c, c2_cont_prob_gate_enabled: e.target.checked }))} />
                <div className={`w-10 h-5 rounded-full transition-all duration-300 ${config.c2_cont_prob_gate_enabled ? 'bg-emerald-600' : 'bg-slate-200 dark:bg-white/10'}`} />
                <div className={`absolute top-1 left-1 w-3 h-3 bg-white rounded-full shadow-sm transition-transform duration-300 ${config.c2_cont_prob_gate_enabled ? 'translate-x-5' : ''}`} />
              </div>
              <div>
                <p className={`text-sm font-bold transition-colors ${config.c2_cont_prob_gate_enabled ? 'text-emerald-600 dark:text-emerald-400' : 'text-slate-800 dark:text-slate-200 group-hover:text-emerald-600 dark:group-hover:text-emerald-400'}`}>
                  Continuation Gate (Chronos-2)
                  {config.c2_cont_prob_gate_enabled && <span className="ml-2 px-1.5 py-0.5 rounded text-[9px] font-bold bg-emerald-100 dark:bg-emerald-500/20 text-emerald-600 dark:text-emerald-400 uppercase tracking-wider">Attivo</span>}
                </p>
                <p className="text-[11px] font-medium text-slate-400 dark:text-slate-500 leading-tight">
                  No-trade se le bande quantili C2 non mostrano una direzione coerente (mercato choppy)
                </p>
              </div>
            </label>
          </Tooltip>
          {config.c2_cont_prob_gate_enabled && !config.chronos_enabled && (
            <div className="flex items-start gap-3 bg-amber-50 dark:bg-amber-500/10 border border-amber-200 dark:border-amber-500/30 rounded-xl px-4 py-3">
              <svg className="w-4 h-4 text-amber-500 flex-shrink-0 mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" />
              </svg>
              <div>
                <p className="text-[11px] font-bold text-amber-700 dark:text-amber-400 uppercase tracking-wide">Chronos-2 non attivo</p>
                <p className="text-[11px] text-amber-600 dark:text-amber-500 leading-snug mt-0.5">
                  Il Continuation Gate richiede Chronos-2. Il gate sarà ignorato finché Chronos non viene abilitato nelle Impostazioni avanzate.
                </p>
              </div>
            </div>
          )}
          {config.c2_cont_prob_gate_enabled && (
            <div className="flex items-center gap-4 pl-12">
              <span className="text-[10px] font-bold text-slate-400 dark:text-slate-500 uppercase tracking-widest whitespace-nowrap">Min coerenza</span>
              <div className="flex items-center gap-3 flex-1">
                <input
                  type="range" min="0.05" max="0.80" step="0.05"
                  value={config.c2_cont_prob_threshold}
                  onChange={e => setConfig(c => ({ ...c, c2_cont_prob_threshold: parseFloat(e.target.value) }))}
                  className="flex-1 h-1.5 rounded-full appearance-none cursor-pointer bg-slate-200 dark:bg-white/15 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-3.5 [&::-webkit-slider-thumb]:h-3.5 [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-emerald-500 [&::-webkit-slider-thumb]:shadow-sm [&::-webkit-slider-thumb]:cursor-pointer [&::-moz-range-thumb]:w-3.5 [&::-moz-range-thumb]:h-3.5 [&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:bg-emerald-500 [&::-moz-range-thumb]:border-0"
                />
                <span className="text-[11px] font-bold font-mono text-emerald-600 dark:text-emerald-400 w-14 text-right">
                  {(config.c2_cont_prob_threshold * 100).toFixed(0)}%
                </span>
                <span className="text-[10px] text-slate-400 dark:text-slate-500">bande quantili coerenti</span>
              </div>
            </div>
          )}
        </div>
      </Section>

      {/* Regime Bias */}
      <Section title="Regime Bias — Threshold Asimmetrico" description="Penalizza i trade contro-trend richiedendo un segnale più forte. In regime bull, i short richiedono ensemble_prob > threshold + delta; in bear, i long richiedono lo stesso. Sideways = simmetrico.">
        <div className={`flex flex-col gap-3 mb-6 pb-6 border-b transition-colors duration-200 ${config.regime_bias_enabled ? 'border-orange-200 dark:border-orange-500/25' : 'border-slate-100 dark:border-white/5'}`}>
          <label className="flex items-center gap-3 cursor-pointer group">
            <div className="relative">
              <input type="checkbox" className="sr-only" checked={config.regime_bias_enabled} onChange={e => setConfig(c => ({ ...c, regime_bias_enabled: e.target.checked }))} />
              <div className={`w-10 h-5 rounded-full transition-all duration-300 ${config.regime_bias_enabled ? 'bg-orange-600' : 'bg-slate-200 dark:bg-white/10'}`} />
              <div className={`absolute top-1 left-1 w-3 h-3 bg-white rounded-full shadow-sm transition-transform duration-300 ${config.regime_bias_enabled ? 'translate-x-5' : ''}`} />
            </div>
            <div>
              <p className={`text-sm font-bold transition-colors ${config.regime_bias_enabled ? 'text-orange-600 dark:text-orange-400' : 'text-slate-800 dark:text-slate-200 group-hover:text-orange-600 dark:group-hover:text-orange-400'}`}>
                Threshold Asimmetrico
                {config.regime_bias_enabled && <span className="ml-2 px-1.5 py-0.5 rounded text-[9px] font-bold bg-orange-100 dark:bg-orange-500/20 text-orange-600 dark:text-orange-400 uppercase tracking-wider">Attivo</span>}
              </p>
              <p className="text-[11px] text-slate-400 dark:text-slate-500 mt-0.5">
                {config.regime_bias_enabled
                  ? `Penalità +${config.regime_bias_delta} per trade contro-trend · size ×${config.regime_bias_size_factor}`
                  : 'Soglia identica per long e short indipendentemente dal regime'}
              </p>
            </div>
          </label>
        </div>

        {config.regime_bias_enabled && (
          <>
            {/* Forced regime selector */}
            <div className="mb-6">
              <Tooltip text="Scegli tu il regime di mercato manualmente, oppure lascia che sia il bot a rilevarlo automaticamente da EMA20+ADX. Con 'Neutro' il bias è attivo ma non penalizza nessuna direzione." width="wide" pos="bottom">
                <p className="text-[11px] font-bold text-slate-600 dark:text-slate-400 uppercase tracking-widest mb-3">Regime di mercato</p>
              </Tooltip>
              <div className="grid grid-cols-4 gap-2">
                {(['auto', 'bull', 'bear', 'neutral'] as const).map(r => {
                  const labels: Record<string, string> = { auto: 'Auto', bull: 'Bull', bear: 'Bear', neutral: 'Neutro' };
                  const active: Record<string, string> = {
                    auto:    'bg-slate-800 dark:bg-white text-white dark:text-slate-900 border-slate-800 dark:border-white',
                    bull:    'bg-emerald-600 text-white border-emerald-600 shadow-emerald-500/20',
                    bear:    'bg-rose-600 text-white border-rose-600 shadow-rose-500/20',
                    neutral: 'bg-slate-400 dark:bg-slate-500 text-white border-transparent',
                  };
                  const inactive = 'bg-slate-50 dark:bg-white/5 text-slate-400 dark:text-slate-500 border-slate-100 dark:border-white/10 hover:bg-slate-100 dark:hover:bg-white/10';
                  return (
                    <button
                      key={r}
                      onClick={() => setConfig(c => ({ ...c, forced_regime: r }))}
                      className={`py-2.5 rounded-xl text-[10px] font-bold uppercase tracking-widest transition-all border shadow-sm ${config.forced_regime === r ? active[r] : inactive}`}
                    >
                      {labels[r]}
                    </button>
                  );
                })}
              </div>
              {config.forced_regime !== 'auto' && (
                <p className="text-[10px] font-bold mt-2 text-orange-600 dark:text-orange-400">
                  {config.forced_regime === 'bull' && 'Regime BULL manuale — gli short richiedono soglia più alta'}
                  {config.forced_regime === 'bear' && 'Regime BEAR manuale — i long richiedono soglia più alta'}
                  {config.forced_regime === 'neutral' && 'Regime NEUTRO — nessun bias su nessuna direzione'}
                </p>
              )}
            </div>

            <div className="mb-4">
              <Tooltip text="Delta aggiunto alla soglia direzionale per il lato contro-trend. Es. con threshold 0.62 e delta 0.08, in regime bull i short richiedono ensemble_prob > 0.70." width="wide" pos="bottom">
                <label className="flex items-center justify-between mb-2">
                  <span className="text-[11px] font-bold text-slate-600 dark:text-slate-400 uppercase tracking-widest">Penalità contro-trend (delta)</span>
                  <span className="font-mono text-sm font-bold text-orange-600 dark:text-orange-400">+{config.regime_bias_delta.toFixed(2)}</span>
                </label>
              </Tooltip>
              <input
                type="range" min="0.01" max="0.20" step="0.01"
                value={config.regime_bias_delta}
                onChange={e => setConfig(c => ({ ...c, regime_bias_delta: parseFloat(e.target.value) }))}
                className="w-full h-1.5 bg-slate-200 dark:bg-white/10 rounded-full appearance-none cursor-pointer accent-orange-600"
              />
              <div className="flex justify-between text-[9px] font-mono text-slate-400 dark:text-slate-500 mt-1">
                <span>0.01</span><span>0.10</span><span>0.20</span>
              </div>
            </div>

            <div>
              <Tooltip text="Fattore di riduzione size per i trade contro-trend che superano comunque la soglia alzata. 1.0 = size piena, 0.5 = metà size." width="wide" pos="bottom">
                <label className="flex items-center justify-between mb-2">
                  <span className="text-[11px] font-bold text-slate-600 dark:text-slate-400 uppercase tracking-widest">Size factor contro-trend</span>
                  <span className="font-mono text-sm font-bold text-orange-600 dark:text-orange-400">×{config.regime_bias_size_factor.toFixed(2)}</span>
                </label>
              </Tooltip>
              <input
                type="range" min="0.30" max="1.0" step="0.05"
                value={config.regime_bias_size_factor}
                onChange={e => setConfig(c => ({ ...c, regime_bias_size_factor: parseFloat(e.target.value) }))}
                className="w-full h-1.5 bg-slate-200 dark:bg-white/10 rounded-full appearance-none cursor-pointer accent-orange-600"
              />
              <div className="flex justify-between text-[9px] font-mono text-slate-400 dark:text-slate-500 mt-1">
                <span>0.30</span><span>0.65</span><span>1.0</span>
              </div>
            </div>
          </>
        )}
      </Section>

      {/* LightGBM Model */}
      <Section title="LightGBM — Modello Direzionale" description="Il modello di machine learning viene riaddestrato automaticamente ogni 120 candele (~30 giorni). Usa il retrain manuale per aggiornarlo prima di avviare il bot dopo un periodo di inattività.">
        {/* Model status row */}
        <div className="flex items-center justify-between mb-5">
          <div className="flex items-center gap-3">
            <div className={`w-2 h-2 rounded-full ${modelLoaded === null ? 'bg-slate-300 dark:bg-slate-600' : modelLoaded ? 'bg-emerald-500' : 'bg-amber-400'}`} />
            <span className="text-[11px] font-bold text-slate-500 dark:text-slate-400 uppercase tracking-widest">
              {modelLoaded === null ? 'Caricamento…' : modelLoaded ? 'Modello caricato' : 'Nessun modello — usa ATR neutro'}
            </span>
          </div>
          {lastRetrain?.trained_at && (
            <span className="text-[10px] font-mono text-slate-400 dark:text-slate-500">
              Ultimo retrain: {new Date(lastRetrain.trained_at).toLocaleString('it-IT', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}
            </span>
          )}
        </div>

        {/* Last retrain metrics */}
        {lastRetrain?.status === 'ok' && !retrainResult && (
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-5">
            {[
              { label: 'OOS Accuracy',  value: `${((lastRetrain.oos_accuracy ?? 0) * 100).toFixed(1)}%` },
              { label: 'Log Loss',      value: (lastRetrain.oos_log_loss ?? 0).toFixed(4) },
              { label: 'Training Rows', value: (lastRetrain.train_rows ?? 0).toLocaleString() },
              { label: 'Features',      value: lastRetrain.n_features ?? '—' },
            ].map(({ label, value }) => (
              <div key={label} className="bg-slate-50 dark:bg-white/5 rounded-xl px-3 py-2 text-center">
                <p className="text-[9px] font-bold text-slate-400 dark:text-slate-500 uppercase tracking-widest mb-0.5">{label}</p>
                <p className="text-sm font-bold font-mono text-slate-900 dark:text-white">{value}</p>
              </div>
            ))}
          </div>
        )}

        {/* Result after manual retrain */}
        {retrainResult && (
          <div className={`flex items-start gap-3 rounded-xl px-4 py-3 mb-5 ${
            retrainResult.status === 'ok'
              ? 'bg-emerald-50 dark:bg-emerald-500/10 border border-emerald-200 dark:border-emerald-500/30'
              : 'bg-amber-50 dark:bg-amber-500/10 border border-amber-200 dark:border-amber-500/30'
          }`}>
            <div className="flex-1">
              {retrainResult.status === 'ok' ? (
                <>
                  <p className="text-[11px] font-bold text-emerald-700 dark:text-emerald-400 uppercase tracking-wide mb-1">Retrain completato</p>
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                    {[
                      { label: 'OOS Accuracy',  value: `${((retrainResult.oos_accuracy ?? 0) * 100).toFixed(1)}%` },
                      { label: 'Log Loss',      value: (retrainResult.oos_log_loss ?? 0).toFixed(4) },
                      { label: 'Training Rows', value: (retrainResult.train_rows ?? 0).toLocaleString() },
                      { label: 'Durata',        value: `${retrainResult.elapsed_s ?? 0}s` },
                    ].map(({ label, value }) => (
                      <div key={label}>
                        <p className="text-[9px] font-bold text-emerald-600 dark:text-emerald-500 uppercase tracking-widest">{label}</p>
                        <p className="text-sm font-bold font-mono text-emerald-800 dark:text-emerald-300">{value}</p>
                      </div>
                    ))}
                  </div>
                </>
              ) : (
                <p className="text-[11px] font-bold text-amber-700 dark:text-amber-400 uppercase tracking-wide">
                  Retrain già in corso — riprova tra qualche secondo
                </p>
              )}
            </div>
          </div>
        )}

        {/* Retrain button */}
        <button
          onClick={handleRetrain}
          disabled={retraining}
          className={`flex items-center justify-center gap-2 w-full py-3 rounded-xl text-[11px] font-bold uppercase tracking-widest transition-all border ${
            retraining
              ? 'bg-slate-100 dark:bg-white/5 text-slate-400 dark:text-slate-500 border-slate-200 dark:border-white/10 cursor-not-allowed'
              : 'bg-slate-900 dark:bg-white text-white dark:text-slate-900 border-transparent hover:bg-slate-700 dark:hover:bg-slate-100 shadow-md active:scale-[0.98]'
          }`}
        >
          {retraining ? (
            <>
              <svg className="w-3.5 h-3.5 animate-spin" viewBox="0 0 24 24" fill="none">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4l3-3-3-3v4a8 8 0 00-8 8h4z" />
              </svg>
              Retrain in corso…
            </>
          ) : (
            <>
              <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21 12a9 9 0 11-6.219-8.56" />
              </svg>
              Forza Retrain LightGBM
            </>
          )}
        </button>
        <p className="text-[10px] text-slate-400 dark:text-slate-500 text-center mt-2">
          Addestra il modello sugli ultimi 500 candles 4h · non interrompe il bot
        </p>
      </Section>

      {/* Action Footer */}
      <div className="pt-4">
        <button
          onClick={handleSave}
          disabled={loading}
          className={`w-full py-4 rounded-xl text-[11px] font-bold uppercase tracking-widest transition-all shadow-lg active:scale-[0.98] ${
            saved
              ? 'bg-emerald-600 text-white shadow-emerald-500/20'
              : 'bg-indigo-600 hover:bg-indigo-500 text-white shadow-indigo-500/20 disabled:opacity-50'
          }`}
        >
          {saved ? '✓ Configurazione Sincronizzata' : loading ? 'Salvataggio in corso…' : 'Applica e Salva Parametri'}
        </button>
      </div>
    </div>
  );
};

const Section: React.FC<{ title: string; description: string; children: React.ReactNode }> = ({ title, description, children }) => (
  <div className="elegant-card p-6 bg-white dark:bg-[#151E32]">
    <h3 className="text-sm font-bold text-slate-900 dark:text-white uppercase tracking-tight mb-1">{title}</h3>
    <p className="text-[11px] font-bold text-slate-400 dark:text-slate-500 uppercase tracking-widest mb-6 leading-relaxed">{description}</p>
    {children}
  </div>
);

const NumInput: React.FC<{
  label: string; value: number; onChange: (v: number) => void;
  step?: number; min?: number; max?: number;
}> = ({ label, value, onChange, step = 0.1, min, max }) => (
  <label className="flex flex-col gap-2 w-full">
    <span className="text-[10px] font-bold text-slate-400 dark:text-slate-500 uppercase tracking-widest ml-1">{label}</span>
    <input type="number" value={value} step={step} min={min} max={max}
      onChange={e => onChange(parseFloat(e.target.value))}
      className="w-full bg-slate-50 dark:bg-white/5 border border-slate-200 dark:border-white/10 rounded-xl px-4 py-3 text-sm font-bold font-mono text-slate-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500 transition-all outline-none" />
  </label>
);
