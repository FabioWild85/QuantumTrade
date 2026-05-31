import React, { useEffect, useRef, useState } from 'react';
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
  regime_bias_enhanced: boolean;
  // Walk-forward & retraining
  auto_retrain_enabled: boolean;
  retrain_every_n_cycles: number;
  wf_n_splits: number;
  wf_purge_gap: number;
  // Feature Importance Pruning
  use_feature_pruning: boolean;
  feature_pruning_min_importance: number;
  // Isotonic calibration on c2_dir_prob
  use_chronos_calibration: boolean;
  // Gate LightGBM 1H
  use_1h_lgbm_gate: boolean;
  lgbm_1h_min_agreement: number;
  lgbm_1h_block_threshold: number;
  // Optuna hyperparameter tuning
  use_optuna: boolean;
  optuna_n_trials: number;
  // Macro Event Pause
  macro_pause_enabled: boolean;
  macro_pause_window_min: number;
  macro_pause_close_position: boolean;
  macro_pause_fomc: boolean;
  macro_pause_cpi: boolean;
  macro_pause_nfp: boolean;
  macro_pause_ppi: boolean;
  macro_pause_jolts: boolean;
  // Exit strategies
  trailing_sl_enabled: boolean;
  trailing_sl_activation: number;
  partial_tp_enabled: boolean;
  partial_tp_atr_mult: number;
  partial_tp_pct: number;
  lgbm_exit_enabled: boolean;
  lgbm_exit_threshold: number;
  lgbm_exit_min_hold_bars: number;
  lgbm_exit_confirm_bars: number;
  // Position management
  be_sl_enabled: boolean;
  be_sl_activation: number;
  max_hold_bars_enabled: boolean;
  max_hold_bars: number;
  // Signal gates
  adx_gate_enabled: boolean;
  sweep_gate_enabled: boolean;
  sweep_gate_directional: boolean;
  fvg_filter_enabled: boolean;
  mtf_alignment_enabled: boolean;
  chronos_weight: number;
  recalibrated_uncertainty_thresholds: boolean;
  // CVD Absorption Filter
  absorption_filter_enabled: boolean;
  absorption_z_threshold: number;
  // Dual ATR
  dual_atr_enabled: boolean;
  // Signal quality filters (formerly hardcoded)
  exhaustion_guard_enabled: boolean;
  structural_sl_enabled: boolean;
  ob_buffer_pct: number;
  ob_buffer_min_atr: number;
  ob_tp_enabled: boolean;
  ob_tp_blend: number;
  fvg_sl_enabled: boolean;
  fvg_tp_enabled: boolean;
  fvg_tp_blend: number;
  swing_sl_enabled: boolean;
  swing_tp_enabled: boolean;
  swing_tp_blend: number;
  // Late Entry Distance Filter
  late_entry_filter_enabled: boolean;
  late_entry_max_ob_dist: number;
  // Path Obstruction Gate
  path_obstruction_enabled: boolean;
  path_obstruction_max_dist: number;
  // Consecutive Bars Filter
  consec_bars_filter_enabled: boolean;
  consec_bars_max_long: number;
  consec_bars_max_short: number;
  // Funding Rate Bias
  funding_gate_enabled: boolean;
  funding_gate_lookback: number;
  funding_high_thr: number;
  funding_extreme_thr: number;
  funding_bias_delta: number;
  // Fear & Greed Bias
  fng_gate_enabled: boolean;
  fng_extreme_fear_thr: number;
  fng_fear_thr: number;
  fng_greed_thr: number;
  fng_extreme_greed_thr: number;
  fng_bias_delta: number;
  // Extra exit flags (from HubSettings)
  p10_sl_floor_enabled: boolean;
  enhanced_exit_enabled: boolean;
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
  c2_cont_prob_threshold: 0.25,
  chronos_enabled: true,
  regime_bias_enabled: false,
  regime_bias_delta: 0.08,
  regime_bias_size_factor: 1.0,
  forced_regime: 'auto',
  regime_bias_enhanced: false,
  // Walk-forward & retraining
  auto_retrain_enabled: true,
  retrain_every_n_cycles: 120,
  wf_n_splits: 5,
  wf_purge_gap: 5,
  // Feature Importance Pruning
  use_feature_pruning: false,
  feature_pruning_min_importance: 0.005,
  // Isotonic calibration on c2_dir_prob
  use_chronos_calibration: false,
  // Gate LightGBM 1H
  use_1h_lgbm_gate: false,
  lgbm_1h_min_agreement: 0.52,
  lgbm_1h_block_threshold: 0.45,
  // Optuna hyperparameter tuning
  use_optuna: false,
  optuna_n_trials: 50,
  // Macro Event Pause
  macro_pause_enabled: false,
  macro_pause_window_min: 60,
  macro_pause_close_position: false,
  macro_pause_fomc: true,
  macro_pause_cpi: true,
  macro_pause_nfp: true,
  macro_pause_ppi: false,
  macro_pause_jolts: false,
  // Exit strategies
  trailing_sl_enabled: false,
  trailing_sl_activation: 1.5,
  partial_tp_enabled: false,
  partial_tp_atr_mult: 1.5,
  partial_tp_pct: 50.0,
  lgbm_exit_enabled: false,
  lgbm_exit_threshold: 0.30,
  lgbm_exit_min_hold_bars: 6,
  lgbm_exit_confirm_bars: 2,
  // Position management
  be_sl_enabled: false,
  be_sl_activation: 1.0,
  max_hold_bars_enabled: false,
  max_hold_bars: 48,
  // Signal gates
  adx_gate_enabled: true,
  sweep_gate_enabled: true,
  sweep_gate_directional: false,
  fvg_filter_enabled: true,
  mtf_alignment_enabled: true,
  chronos_weight: 0.40,
  recalibrated_uncertainty_thresholds: true,
  // CVD Absorption Filter
  absorption_filter_enabled: false,
  absorption_z_threshold: 2.0,
  // Dual ATR
  dual_atr_enabled: false,
  // Signal quality filters
  exhaustion_guard_enabled: true,
  structural_sl_enabled: true,
  ob_buffer_pct: 0.3,
  ob_buffer_min_atr: 0.0,
  ob_tp_enabled: false,
  ob_tp_blend: 1.0,
  fvg_sl_enabled: false,
  fvg_tp_enabled: false,
  fvg_tp_blend: 1.0,
  swing_sl_enabled: false,
  swing_tp_enabled: false,
  swing_tp_blend: 1.0,
  // Late Entry Distance Filter
  late_entry_filter_enabled: false,
  late_entry_max_ob_dist: 3.0,
  // Path Obstruction Gate
  path_obstruction_enabled: false,
  path_obstruction_max_dist: 1.5,
  consec_bars_filter_enabled: false,
  consec_bars_max_long: 8,
  consec_bars_max_short: 8,
  // Funding Rate Bias
  funding_gate_enabled: false,
  funding_gate_lookback: 6,
  funding_high_thr: 0.00010,
  funding_extreme_thr: 0.00030,
  funding_bias_delta: 0.03,
  // Fear & Greed Bias
  fng_gate_enabled: false,
  fng_extreme_fear_thr: 20.0,
  fng_fear_thr: 35.0,
  fng_greed_thr: 65.0,
  fng_extreme_greed_thr: 80.0,
  fng_bias_delta: 0.03,
  p10_sl_floor_enabled: false,
  enhanced_exit_enabled: false,
};

interface PruningMetrics {
  status: 'ok' | 'skipped';
  features_kept?: number;
  features_removed?: number;
  full_accuracy?: number;
  pruned_accuracy?: number;
  accuracy_delta?: number;
  reason?: string;
}

interface FeatureImportanceData {
  available: boolean;
  trained_at?: string;
  features?: Record<string, number>;
}

interface PruningStatsData {
  available: boolean;
  pruned_model_exists?: boolean;
  trained_at?: string;
  status?: 'ok' | 'skipped';
  full_accuracy?: number;
  pruned_accuracy?: number;
  accuracy_delta?: number;
  features_kept?: number;
  features_removed?: number;
  threshold?: number;
}

interface CalibratorStats {
  file_exists: boolean;
  fitted: boolean;
  n_samples?: number;
  mapping?: Record<string, number>;
  error?: string;
}

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
  pruning?: PruningMetrics | null;
}

interface Preset {
  id: number;
  name: string;
  params: Record<string, any>;
  created_at?: string;
}

interface RegistryEntry {
  filename: string;
  trained_at: string;
  oos_accuracy?: number;
  oos_log_loss?: number;
  wf_avg_accuracy?: number;
  n_features?: number;
  train_rows?: number;
  best_iteration?: number;
  neutral_excluded_pct?: number;
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
  const [featImportance, setFeatImportance] = useState<FeatureImportanceData | null>(null);
  const [featImportanceLoading, setFeatImportanceLoading] = useState(false);
  const [pruningStats, setPruningStats] = useState<PruningStatsData | null>(null);
  const [calibratorStats, setCalibratorStats] = useState<CalibratorStats | null>(null);
  const [calibratorRefitting, setCalibratorRefitting] = useState(false);
  const [calibratorRefitResult, setCalibratorRefitResult] = useState<{ status: string; n_samples?: number } | null>(null);
  const [lgbm1hLoaded, setLgbm1hLoaded] = useState<boolean | null>(null);
  const [lgbm1hRetraining, setLgbm1hRetraining] = useState(false);
  const [lgbm1hResult, setLgbm1hResult] = useState<{
    status: string; oos_accuracy?: number; oos_log_loss?: number;
    n_features?: number; elapsed_s?: number; train_rows?: number;
  } | null>(null);
  const [macroEvents, setMacroEvents] = useState<Array<{
    type: string; name: string; datetime_utc: string; days_away: number;
  }> | null>(null);
  const [macroEventsLoading, setMacroEventsLoading] = useState(false);
  const [presets,         setPresets]         = useState<Preset[]>([]);
  const [presetDropOpen,  setPresetDropOpen]  = useState(false);
  const [appliedPreset,   setAppliedPreset]   = useState<string | null>(null);
  const presetDropRef = useRef<HTMLDivElement>(null);
  const [modelRegistry,  setModelRegistry]   = useState<RegistryEntry[]>([]);
  const [rollingBack,    setRollingBack]      = useState<string | null>(null);
  const [registryOpen,   setRegistryOpen]     = useState(false);

  useEffect(() => {
    if (!presetDropOpen) return;
    const handler = (e: MouseEvent) => {
      if (presetDropRef.current && !presetDropRef.current.contains(e.target as Node)) {
        setPresetDropOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [presetDropOpen]);

  const loadFeatureImportance = () => {
    setFeatImportanceLoading(true);
    fetch(`${apiBase}/model/feature-importance`)
      .then(r => r.ok ? r.json() : null)
      .then(d => d && setFeatImportance(d))
      .catch(() => {})
      .finally(() => setFeatImportanceLoading(false));
  };

  const loadPruningStats = () => {
    fetch(`${apiBase}/model/pruning-stats`)
      .then(r => r.ok ? r.json() : null)
      .then(d => d && setPruningStats(d))
      .catch(() => {});
  };

  const loadCalibratorStats = () => {
    fetch(`${apiBase}/calibrator/stats`)
      .then(r => r.ok ? r.json() : null)
      .then(d => d && setCalibratorStats(d))
      .catch(() => {});
  };

  const loadModelRegistry = () => {
    fetch(`${apiBase}/model/registry`)
      .then(r => r.ok ? r.json() : null)
      .then(d => d?.models && setModelRegistry(d.models))
      .catch(() => {});
  };

  const handleRetrain1h = async () => {
    if (!confirm('Addestra il modello LightGBM 1H Gate su 2000 candele orarie?\n\nIl processo dura 20–60 secondi. Non interrompe il bot.')) return;
    setLgbm1hRetraining(true);
    setLgbm1hResult(null);
    try {
      const r = await fetch(`${apiBase}/retrain/1h`, { method: 'POST' });
      const data = await r.json();
      setLgbm1hResult(data);
      if (data.status === 'ok') setLgbm1hLoaded(true);
    } catch {
      setLgbm1hResult({ status: 'error' });
    } finally {
      setLgbm1hRetraining(false);
    }
  };

  const handleCalibratorRefit = async () => {
    if (!confirm('Ricalibra IsotonicCalibrator su tutti i trade storici?\n\nRichiede ≥50 trade chiusi con inference_id nel DB. Il processo è rapido (<2s).')) return;
    setCalibratorRefitting(true);
    setCalibratorRefitResult(null);
    try {
      const r = await fetch(`${apiBase}/calibrator/refit`, { method: 'POST' });
      const data = await r.json();
      setCalibratorRefitResult(data);
      loadCalibratorStats();
    } catch {
      setCalibratorRefitResult({ status: 'error' });
    } finally {
      setCalibratorRefitting(false);
    }
  };

  const handleRollback = async (filename: string) => {
    if (!confirm(`Rollback al modello:\n${filename}\n\nIl modello corrente (lgbm_latest.pkl) verrà sostituito. Il bot ricaricherà il modello automaticamente.`)) return;
    setRollingBack(filename);
    try {
      const r = await fetch(`${apiBase}/model/rollback/${encodeURIComponent(filename)}`, { method: 'POST' });
      const data = await r.json();
      if (data.status === 'ok') {
        alert(`✓ Rollback completato.\nModello attivo: ${filename}`);
        loadModelRegistry();
      } else {
        alert(`✕ Rollback fallito: ${data.detail ?? data.status}`);
      }
    } catch {
      alert('✕ Errore di rete durante il rollback.');
    } finally {
      setRollingBack(null);
    }
  };

  useEffect(() => {
    fetch(`${apiBase}/bot`)
      .then(r => r.ok ? r.json() : null)
      .then(d => d && setConfig(c => ({ ...c, ...d })))
      .catch(e => console.error('[BotConfig] GET /bot failed:', e));
    fetch(`${apiBase}/bot/status`)
      .then(r => r.ok ? r.json() : null)
      .then(s => {
        if (!s) return;
        setModelLoaded(s.model_loaded ?? false);
        setHlTestnet(s.hl_testnet ?? true);
        if (s.last_retrain) setLastRetrain(s.last_retrain);
        if (s.retrain_in_progress) setRetraining(true);
        if (s.lgbm_1h_loaded !== undefined) setLgbm1hLoaded(s.lgbm_1h_loaded);
      })
      .catch(e => console.error('[BotConfig] GET /bot/status failed:', e));
    loadFeatureImportance();
    loadPruningStats();
    loadCalibratorStats();
    setMacroEventsLoading(true);
    fetch(`${apiBase}/macro-events?days=60`)
      .then(r => r.ok ? r.json() : null)
      .then(d => d && setMacroEvents(d.events ?? []))
      .catch(e => console.error('[BotConfig] GET /macro-events failed:', e))
      .finally(() => setMacroEventsLoading(false));
    fetch(`${apiBase}/presets`)
      .then(r => r.ok ? r.json() : [])
      .then(d => setPresets(Array.isArray(d) ? d : []))
      .catch(e => console.error('[BotConfig] GET /presets failed:', e));
    loadModelRegistry();
  }, [apiBase]);

  const handleRetrain = async () => {
    const optunaNotes = config.use_optuna
      ? `\n\n⚠ Optuna attivo: durata stimata 3–8 minuti (${config.optuna_n_trials} trial).`
      : '';
    if (!confirm(`Avvia retrain manuale di LightGBM?\n\nIl modello verrà ricalcolato sugli ultimi 500 candles (4h). Il processo dura 10–30 secondi.${optunaNotes}`)) return;
    setRetraining(true);
    setRetrainResult(null);
    try {
      const r = await fetch(`${apiBase}/retrain`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ use_optuna: config.use_optuna, optuna_n_trials: config.optuna_n_trials }),
      });
      const data: RetrainMetrics = await r.json();
      setRetrainResult(data);
      if (data.status === 'ok') {
        setModelLoaded(true);
        setLastRetrain(data);
        loadFeatureImportance();
        loadPruningStats();
      }
    } catch {
      setRetrainResult({ status: 'busy' });
    } finally {
      setRetraining(false);
    }
  };

  const [deepFromDate, setDeepFromDate] = useState('');

  const handleDeepRetrain = async () => {
    if (!deepFromDate) return;
    const today = new Date().toISOString().slice(0, 10);
    const diffDays = Math.round((new Date(today).getTime() - new Date(deepFromDate).getTime()) / 864e5);
    const estCandles = Math.round(diffDays * 6);
    const estMinutes = Math.round(estCandles / 500 * 0.5);
    if (!confirm(
      `Deep Training da ${deepFromDate} a oggi\n\n` +
      `Stima: ~${estCandles.toLocaleString()} candele 4H (${diffDays} giorni).\n` +
      `Durata stimata: ${estMinutes < 1 ? '<1' : estMinutes}–${estMinutes + 2} minuti.\n\n` +
      `Il modello attuale verrà salvato come backup (lgbm_latest.bak.pkl).\n\nProcedere?`
    )) return;
    setRetraining(true);
    setRetrainResult(null);
    try {
      const r = await fetch(`${apiBase}/retrain`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          from_date: deepFromDate,
          use_optuna: config.use_optuna,
          optuna_n_trials: config.optuna_n_trials,
        }),
      });
      const data: RetrainMetrics = await r.json();
      setRetrainResult(data);
      if (data.status === 'ok') {
        setModelLoaded(true);
        setLastRetrain(data);
        loadFeatureImportance();
        loadPruningStats();
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

  const PRESET_SKIP = new Set([
    'mode',
    'retrain_every_n_cycles', 'wf_n_splits', 'wf_purge_gap',
    'use_feature_pruning', 'feature_pruning_min_importance',
    'use_chronos_calibration',
    'use_1h_lgbm_gate', 'lgbm_1h_min_agreement', 'lgbm_1h_block_threshold',
    'macro_pause_enabled', 'macro_pause_window_min', 'macro_pause_close_position',
    'macro_pause_fomc', 'macro_pause_cpi', 'macro_pause_nfp', 'macro_pause_ppi', 'macro_pause_jolts',
  ]);

  const applyPreset = (preset: Preset) => {
    setConfig(c => {
      const next = { ...c };
      for (const [k, v] of Object.entries(preset.params)) {
        if (PRESET_SKIP.has(k) || !(k in DEFAULTS)) continue;
        const expectedType = typeof DEFAULTS[k as keyof Config];
        if (expectedType === 'boolean') {
          (next as any)[k] = Boolean(v);
        } else if (expectedType === 'number') {
          (next as any)[k] = Number(v);
        } else if (k === 'forced_regime') {
          if (['auto', 'bull', 'bear', 'neutral'].includes(String(v))) {
            (next as any)[k] = String(v);
          }
        } else {
          (next as any)[k] = v;
        }
      }
      return next;
    });
    setAppliedPreset(preset.name);
    setPresetDropOpen(false);
  };

  const rr = (config.tp_atr_mult / config.sl_atr_mult).toFixed(2);
  const be = (1 / (1 + config.tp_atr_mult / config.sl_atr_mult) * 100).toFixed(1);

  return (
    <div className="space-y-8 max-w-4xl">
      <div className="mb-8">
        <h2 className="text-xl font-bold text-slate-900 dark:text-white uppercase tracking-tight">Parametri Operativi</h2>
        <p className="text-[11px] font-bold text-slate-400 dark:text-slate-500 uppercase tracking-widest mt-1">Configurazione Strategia BTC-PERP · Trend Following 4h</p>
      </div>

      {/* Preset Loader */}
      {presets.length > 0 && (
        <div className={`elegant-card p-5 bg-white dark:bg-[#151E32] ${presetDropOpen ? 'relative z-[100]' : ''}`}>
          <div className="flex items-start justify-between gap-4 flex-wrap">
            <div>
              <h3 className="text-sm font-bold text-slate-900 dark:text-white uppercase tracking-tight">Carica Preset Backtest</h3>
              <p className="text-[11px] font-bold text-slate-400 dark:text-slate-500 uppercase tracking-widest mt-0.5 leading-relaxed">
                Applica un preset salvato dal Backtest — mode, retrain e macro pause non vengono modificati
              </p>
            </div>
            {appliedPreset && (
              <span className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-[10px] font-bold bg-indigo-50 dark:bg-indigo-500/15 text-indigo-600 dark:text-indigo-400 border border-indigo-200 dark:border-indigo-500/30 uppercase tracking-wide whitespace-nowrap">
                <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" /></svg>
                {appliedPreset}
              </span>
            )}
          </div>
          <div className="relative mt-4" ref={presetDropRef}>
            <button
              onClick={() => setPresetDropOpen(o => !o)}
              className="w-full flex items-center justify-between gap-3 px-4 py-3 bg-slate-50 dark:bg-white/5 border border-slate-200 dark:border-white/10 rounded-xl text-sm font-medium text-slate-700 dark:text-slate-300 hover:border-indigo-400 dark:hover:border-indigo-500/50 transition-all"
            >
              <span className="text-[11px] font-bold text-slate-400 dark:text-slate-500 uppercase tracking-widest">
                Seleziona preset…
              </span>
              <svg className={`w-4 h-4 text-slate-400 transition-transform ${presetDropOpen ? 'rotate-180' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
              </svg>
            </button>
            {presetDropOpen && (
              <div className="absolute top-full left-0 right-0 mt-1 z-20 bg-white dark:bg-[#1A2438] border border-slate-200 dark:border-white/10 rounded-xl shadow-xl overflow-hidden">
                {presets.map(p => (
                  <button
                    key={p.id}
                    onClick={() => applyPreset(p)}
                    className="w-full flex items-center justify-between gap-3 px-4 py-3 text-left hover:bg-indigo-50 dark:hover:bg-indigo-500/10 transition-colors border-b border-slate-100 dark:border-white/5 last:border-0"
                  >
                    <div>
                      <p className="text-sm font-bold text-slate-800 dark:text-slate-200">{p.name}</p>
                      {p.created_at && (
                        <p className="text-[10px] text-slate-400 dark:text-slate-500 mt-0.5">
                          {new Date(p.created_at).toLocaleDateString('it-IT', { day: '2-digit', month: '2-digit', year: '2-digit' })}
                        </p>
                      )}
                    </div>
                    <svg className="w-4 h-4 text-indigo-400 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                    </svg>
                  </button>
                ))}
              </div>
            )}
          </div>
          {appliedPreset && (
            <p className="mt-3 text-[10px] text-slate-400 dark:text-slate-500 leading-relaxed">
              Parametri applicati. Verifica i valori e premi <span className="font-bold text-slate-600 dark:text-slate-300">Applica e Salva</span> in fondo alla pagina per sincronizzarli sul bot.
            </p>
          )}
        </div>
      )}

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

        {/* ── AI Adattivo — Chronos-2 ── */}
        <div className={`flex flex-col gap-3 mb-6 pb-6 border-b transition-colors duration-200 ${(config.dynamic_sl_tp_enabled || config.p10_sl_floor_enabled) ? 'border-violet-200 dark:border-violet-500/25' : 'border-slate-100 dark:border-white/5'}`}>
          <p className="text-[10px] font-bold text-slate-400 dark:text-slate-500 uppercase tracking-widest">AI Adattivo — Chronos-2</p>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">

            {/* SL/TP Adattativi */}
            <Tooltip text="Quando attivo, SL e TP vengono calcolati blendando ATR con le previsioni probabilistiche p10/p90 di Chronos-2. I moltiplicatori fissi SL/TP vengono ignorati. Richiede Chronos-2 attivo nel bot." width="wide" pos="bottom">
              <label className={`flex items-start gap-2.5 cursor-pointer group p-3 rounded-xl border transition-all duration-200 h-full ${config.dynamic_sl_tp_enabled ? 'border-violet-200 dark:border-violet-500/30 bg-violet-50/40 dark:bg-violet-500/5' : 'border-slate-100 dark:border-white/5 hover:bg-slate-50 dark:hover:bg-white/[0.03]'}`}>
                <div className="relative mt-0.5 flex-shrink-0">
                  <input type="checkbox" className="sr-only" checked={config.dynamic_sl_tp_enabled} onChange={e => setConfig(c => ({ ...c, dynamic_sl_tp_enabled: e.target.checked }))} />
                  <div className={`w-9 h-[18px] rounded-full transition-all duration-300 ${config.dynamic_sl_tp_enabled ? 'bg-violet-600' : 'bg-slate-200 dark:bg-white/10'}`} />
                  <div className={`absolute top-[3px] left-[3px] w-3 h-3 bg-white rounded-full shadow-sm transition-transform duration-300 ${config.dynamic_sl_tp_enabled ? 'translate-x-[18px]' : ''}`} />
                </div>
                <div className="min-w-0">
                  <p className={`text-xs font-bold leading-tight transition-colors ${config.dynamic_sl_tp_enabled ? 'text-violet-600 dark:text-violet-400' : 'text-slate-700 dark:text-slate-300'}`}>
                    SL/TP Adattativi
                    {config.dynamic_sl_tp_enabled && <span className="ml-1.5 px-1.5 py-0.5 rounded text-[9px] font-bold bg-violet-100 dark:bg-violet-500/20 text-violet-600 dark:text-violet-400 uppercase tracking-wider">Attivo</span>}
                  </p>
                  <p className="text-[10px] text-slate-400 dark:text-slate-500 leading-snug mt-0.5">
                    SL/TP calcolati da Chronos p10/p90 — moltiplicatori ATR fissi disabilitati
                  </p>
                </div>
              </label>
            </Tooltip>

            {/* P10 SL Floor */}
            <Tooltip text="Usa il percentile p10 di Chronos come floor per lo Stop Loss. Quando il forecast è confidenti e il p10 è più vicino all'entry dell'ATR-SL, lo SL viene tirato al livello p10. Migliora il R:R nelle previsioni ad alta confidenza. Richiede Chronos-2 attivo." width="wide" pos="bottom">
              <label className={`flex items-start gap-2.5 cursor-pointer group p-3 rounded-xl border transition-all duration-200 h-full ${config.p10_sl_floor_enabled && config.chronos_enabled ? 'border-amber-200 dark:border-amber-500/30 bg-amber-50/40 dark:bg-amber-500/5' : 'border-slate-100 dark:border-white/5 hover:bg-slate-50 dark:hover:bg-white/[0.03]'} ${!config.chronos_enabled ? 'opacity-50 pointer-events-none' : ''}`}>
                <div className="relative mt-0.5 flex-shrink-0">
                  <input type="checkbox" className="sr-only" checked={config.p10_sl_floor_enabled} onChange={e => setConfig(c => ({ ...c, p10_sl_floor_enabled: e.target.checked }))} disabled={!config.chronos_enabled} />
                  <div className={`w-9 h-[18px] rounded-full transition-all duration-300 ${config.p10_sl_floor_enabled && config.chronos_enabled ? 'bg-amber-500' : 'bg-slate-200 dark:bg-white/10'}`} />
                  <div className={`absolute top-[3px] left-[3px] w-3 h-3 bg-white rounded-full shadow-sm transition-transform duration-300 ${config.p10_sl_floor_enabled ? 'translate-x-[18px]' : ''}`} />
                </div>
                <div className="min-w-0">
                  <p className={`text-xs font-bold leading-tight transition-colors ${config.p10_sl_floor_enabled && config.chronos_enabled ? 'text-amber-600 dark:text-amber-400' : 'text-slate-700 dark:text-slate-300'}`}>
                    P10 SL Floor
                    {config.p10_sl_floor_enabled && config.chronos_enabled && <span className="ml-1.5 px-1.5 py-0.5 rounded text-[9px] font-bold bg-amber-100 dark:bg-amber-500/20 text-amber-600 dark:text-amber-400 uppercase tracking-wider">Attivo</span>}
                    {!config.chronos_enabled && <span className="ml-1.5 px-1.5 py-0.5 rounded text-[9px] font-bold bg-slate-100 dark:bg-white/10 text-slate-400 dark:text-slate-500 uppercase tracking-wider">Richiede C2</span>}
                  </p>
                  <p className="text-[10px] text-slate-400 dark:text-slate-500 leading-snug mt-0.5">
                    Chronos p10 come floor per lo SL — migliora R:R con forecast confidenti
                  </p>
                </div>
              </label>
            </Tooltip>
          </div>

          {/* Blend slider */}
          {config.dynamic_sl_tp_enabled && (
            <div className="px-1 flex flex-col gap-1.5 sm:flex-row sm:items-center sm:gap-4">
              <div className="flex items-center justify-between sm:block">
                <span className="text-[10px] font-bold text-slate-400 dark:text-slate-500 uppercase tracking-widest whitespace-nowrap">Blend ATR ↔ C2</span>
                <span className="sm:hidden text-[11px] font-bold font-mono text-violet-600 dark:text-violet-400">
                  {Math.round((1 - config.dynamic_sl_tp_blend) * 100)}% ATR · {Math.round(config.dynamic_sl_tp_blend * 100)}% C2
                </span>
              </div>
              <div className="flex items-center gap-3 flex-1">
                <span className="text-[10px] font-bold text-slate-500 dark:text-slate-400 font-mono">ATR</span>
                <input
                  type="range" min="0" max="1" step="0.05"
                  value={config.dynamic_sl_tp_blend}
                  onChange={e => setConfig(c => ({ ...c, dynamic_sl_tp_blend: parseFloat(e.target.value) }))}
                  className="flex-1 h-1.5 rounded-full appearance-none cursor-pointer bg-slate-200 dark:bg-white/15 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-3.5 [&::-webkit-slider-thumb]:h-3.5 [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-violet-500 [&::-webkit-slider-thumb]:shadow-sm [&::-webkit-slider-thumb]:cursor-pointer [&::-moz-range-thumb]:w-3.5 [&::-moz-range-thumb]:h-3.5 [&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:bg-violet-500 [&::-moz-range-thumb]:border-0"
                />
                <span className="text-[10px] font-bold text-slate-500 dark:text-slate-400 font-mono">C2</span>
                <span className="hidden sm:inline text-[11px] font-bold font-mono text-violet-600 dark:text-violet-400 w-20 text-right">
                  {Math.round((1 - config.dynamic_sl_tp_blend) * 100)}% ATR · {Math.round(config.dynamic_sl_tp_blend * 100)}% C2
                </span>
              </div>
            </div>
          )}

          {/* Recalibrated thresholds toggle */}
          <div className="flex items-center justify-between gap-3 px-1">
            <div>
              <p className="text-[11px] font-bold text-slate-600 dark:text-slate-300">Soglie uncertainty ricalibrate</p>
              <p className="text-[10px] text-slate-400 dark:text-slate-500 leading-tight mt-0.5">
                {config.recalibrated_uncertainty_thresholds
                  ? 'Distribuzione reale BTC 4H — +20% attivo da 3%, −25% da 4.2%'
                  : 'Soglie originali teoriche — +20% sotto 2%, −25% sopra 4%'}
              </p>
            </div>
            <button
              onClick={() => setConfig(c => ({ ...c, recalibrated_uncertainty_thresholds: !c.recalibrated_uncertainty_thresholds }))}
              className={`relative flex-shrink-0 w-9 h-[18px] rounded-full transition-all duration-300 focus:outline-none ${config.recalibrated_uncertainty_thresholds ? 'bg-violet-600' : 'bg-slate-200 dark:bg-white/10'}`}
            >
              <span className={`absolute top-[3px] left-[3px] w-3 h-3 bg-white rounded-full shadow-sm transition-transform duration-300 ${config.recalibrated_uncertainty_thresholds ? 'translate-x-[18px]' : ''}`} />
            </button>
          </div>

          {/* Chronos warning */}
          {(config.dynamic_sl_tp_enabled || config.p10_sl_floor_enabled) && !config.chronos_enabled && (
            <div className="flex items-start gap-3 bg-amber-50 dark:bg-amber-500/10 border border-amber-200 dark:border-amber-500/30 rounded-xl px-4 py-3">
              <svg className="w-4 h-4 text-amber-500 flex-shrink-0 mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" />
              </svg>
              <div>
                <p className="text-[11px] font-bold text-amber-700 dark:text-amber-400 uppercase tracking-wide">Chronos-2 non attivo</p>
                <p className="text-[11px] text-amber-600 dark:text-amber-500 leading-snug mt-0.5">
                  SL/TP Adattativi e P10 Floor richiedono Chronos-2. Il bot userà SL e TP fissi (ATR) finché Chronos non viene abilitato nelle Impostazioni avanzate.
                </p>
              </div>
            </div>
          )}
        </div>

        {/* ── Livelli Strutturali — OB / FVG ── */}
        <div className={`flex flex-col gap-3 mb-6 pb-6 border-b transition-colors duration-200 ${(config.structural_sl_enabled || config.ob_tp_enabled || config.fvg_sl_enabled || config.fvg_tp_enabled || config.swing_sl_enabled || config.swing_tp_enabled) ? 'border-violet-200 dark:border-violet-500/25' : 'border-slate-100 dark:border-white/5'}`}>
          <p className="text-[10px] font-bold text-slate-400 dark:text-slate-500 uppercase tracking-widest">Livelli Strutturali — OB / FVG / Swing</p>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">

            {/* SL — OB */}
            <Tooltip text="Posiziona lo SL oltre l'Order Block attivo più vicino (entro 2 ATR dall'entry). Per short: SL = ob_bear_top_px + buffer. Per long: SL = ob_bull_bot_px − buffer. Solo allarga lo SL (mai restringe) — size ridotta proporzionalmente per mantenere il rischio USD costante." width="wide" pos="bottom">
              <label className={`flex items-start gap-2.5 cursor-pointer group p-3 rounded-xl border transition-all duration-200 h-full ${config.structural_sl_enabled ? 'border-violet-200 dark:border-violet-500/30 bg-violet-50/40 dark:bg-violet-500/5' : 'border-slate-100 dark:border-white/5 hover:bg-slate-50 dark:hover:bg-white/[0.03]'}`}>
                <div className="relative mt-0.5 flex-shrink-0">
                  <input type="checkbox" className="sr-only" checked={config.structural_sl_enabled} onChange={e => setConfig(c => ({ ...c, structural_sl_enabled: e.target.checked }))} />
                  <div className={`w-9 h-[18px] rounded-full transition-all duration-300 ${config.structural_sl_enabled ? 'bg-violet-600' : 'bg-slate-200 dark:bg-white/10'}`} />
                  <div className={`absolute top-[3px] left-[3px] w-3 h-3 bg-white rounded-full shadow-sm transition-transform duration-300 ${config.structural_sl_enabled ? 'translate-x-[18px]' : ''}`} />
                </div>
                <div className="min-w-0">
                  <p className={`text-xs font-bold leading-tight transition-colors ${config.structural_sl_enabled ? 'text-violet-600 dark:text-violet-400' : 'text-slate-700 dark:text-slate-300'}`}>
                    SL — OB
                    {config.structural_sl_enabled && <span className="ml-1.5 px-1.5 py-0.5 rounded text-[9px] font-bold bg-violet-100 dark:bg-violet-500/20 text-violet-600 dark:text-violet-400 uppercase tracking-wider">Attivo</span>}
                  </p>
                  <p className="text-[10px] text-slate-400 dark:text-slate-500 leading-snug mt-0.5">Stop Loss oltre l'Order Block attivo più vicino</p>
                </div>
              </label>
            </Tooltip>

            {/* TP — OB */}
            <Tooltip text="Usa il bordo dell'Order Block opposto come target del Take Profit invece di un multiplo ATR fisso. Per long: TP = ob_bear_top_px (prima resistenza OB sopra l'entry). Per short: TP = ob_bull_bot_px (primo supporto OB sotto l'entry). Il blend controlla quanto peso dare all'OB vs il TP ATR corrente. Fallback automatico a ATR se nessun OB valido è presente." width="wide" pos="bottom">
              <label className={`flex items-start gap-2.5 cursor-pointer group p-3 rounded-xl border transition-all duration-200 h-full ${config.ob_tp_enabled ? 'border-emerald-200 dark:border-emerald-500/30 bg-emerald-50/40 dark:bg-emerald-500/5' : 'border-slate-100 dark:border-white/5 hover:bg-slate-50 dark:hover:bg-white/[0.03]'}`}>
                <div className="relative mt-0.5 flex-shrink-0">
                  <input type="checkbox" className="sr-only" checked={config.ob_tp_enabled} onChange={e => setConfig(c => ({ ...c, ob_tp_enabled: e.target.checked, fvg_tp_enabled: e.target.checked ? false : c.fvg_tp_enabled, swing_tp_enabled: e.target.checked ? false : c.swing_tp_enabled }))} />
                  <div className={`w-9 h-[18px] rounded-full transition-all duration-300 ${config.ob_tp_enabled ? 'bg-emerald-600' : 'bg-slate-200 dark:bg-white/10'}`} />
                  <div className={`absolute top-[3px] left-[3px] w-3 h-3 bg-white rounded-full shadow-sm transition-transform duration-300 ${config.ob_tp_enabled ? 'translate-x-[18px]' : ''}`} />
                </div>
                <div className="min-w-0">
                  <p className={`text-xs font-bold leading-tight transition-colors ${config.ob_tp_enabled ? 'text-emerald-600 dark:text-emerald-400' : 'text-slate-700 dark:text-slate-300'}`}>
                    TP — OB
                    {config.ob_tp_enabled && <span className="ml-1.5 px-1.5 py-0.5 rounded text-[9px] font-bold bg-emerald-100 dark:bg-emerald-500/20 text-emerald-600 dark:text-emerald-400 uppercase tracking-wider">Attivo</span>}
                  </p>
                  <p className="text-[10px] text-slate-400 dark:text-slate-500 leading-snug mt-0.5">Take Profit al primo Order Block opposto sopra/sotto l'entry</p>
                </div>
              </label>
            </Tooltip>

            {/* SL — FVG */}
            <Tooltip text="Posiziona lo SL oltre il livello di invalidazione della Fair Value Gap più vicina. Per long: SL = fvg_bull_bot_px − buffer (rottura del fondo del gap bullish = invalidazione). Per short: SL = fvg_bear_top_px + buffer (rottura del tetto del gap bearish = invalidazione). Solo allarga lo SL — size ridotta proporzionalmente. Usa gli stessi parametri buffer dell'OB SL." width="wide" pos="bottom">
              <label className={`flex items-start gap-2.5 cursor-pointer group p-3 rounded-xl border transition-all duration-200 h-full ${config.fvg_sl_enabled ? 'border-violet-200 dark:border-violet-500/30 bg-violet-50/40 dark:bg-violet-500/5' : 'border-slate-100 dark:border-white/5 hover:bg-slate-50 dark:hover:bg-white/[0.03]'}`}>
                <div className="relative mt-0.5 flex-shrink-0">
                  <input type="checkbox" className="sr-only" checked={config.fvg_sl_enabled} onChange={e => setConfig(c => ({ ...c, fvg_sl_enabled: e.target.checked }))} />
                  <div className={`w-9 h-[18px] rounded-full transition-all duration-300 ${config.fvg_sl_enabled ? 'bg-violet-600' : 'bg-slate-200 dark:bg-white/10'}`} />
                  <div className={`absolute top-[3px] left-[3px] w-3 h-3 bg-white rounded-full shadow-sm transition-transform duration-300 ${config.fvg_sl_enabled ? 'translate-x-[18px]' : ''}`} />
                </div>
                <div className="min-w-0">
                  <p className={`text-xs font-bold leading-tight transition-colors ${config.fvg_sl_enabled ? 'text-violet-600 dark:text-violet-400' : 'text-slate-700 dark:text-slate-300'}`}>
                    SL — FVG
                    {config.fvg_sl_enabled && <span className="ml-1.5 px-1.5 py-0.5 rounded text-[9px] font-bold bg-violet-100 dark:bg-violet-500/20 text-violet-600 dark:text-violet-400 uppercase tracking-wider">Attivo</span>}
                  </p>
                  <p className="text-[10px] text-slate-400 dark:text-slate-500 leading-snug mt-0.5">Stop Loss oltre la Fair Value Gap più vicina (invalidazione FVG)</p>
                </div>
              </label>
            </Tooltip>

            {/* TP — FVG */}
            <Tooltip text="Usa il bordo della Fair Value Gap opposta come target del Take Profit. Per long: TP = fvg_bear_bot_px (fondo della prima bearish FVG sopra l'entry — il prezzo tende a riempire i gap). Per short: TP = fvg_bull_top_px (tetto della prima bullish FVG sotto l'entry). Il blend controlla ATR vs FVG. Fallback automatico a ATR se nessuna FVG valida è presente." width="wide" pos="bottom">
              <label className={`flex items-start gap-2.5 cursor-pointer group p-3 rounded-xl border transition-all duration-200 h-full ${config.fvg_tp_enabled ? 'border-emerald-200 dark:border-emerald-500/30 bg-emerald-50/40 dark:bg-emerald-500/5' : 'border-slate-100 dark:border-white/5 hover:bg-slate-50 dark:hover:bg-white/[0.03]'}`}>
                <div className="relative mt-0.5 flex-shrink-0">
                  <input type="checkbox" className="sr-only" checked={config.fvg_tp_enabled} onChange={e => setConfig(c => ({ ...c, fvg_tp_enabled: e.target.checked, ob_tp_enabled: e.target.checked ? false : c.ob_tp_enabled, swing_tp_enabled: e.target.checked ? false : c.swing_tp_enabled }))} />
                  <div className={`w-9 h-[18px] rounded-full transition-all duration-300 ${config.fvg_tp_enabled ? 'bg-emerald-600' : 'bg-slate-200 dark:bg-white/10'}`} />
                  <div className={`absolute top-[3px] left-[3px] w-3 h-3 bg-white rounded-full shadow-sm transition-transform duration-300 ${config.fvg_tp_enabled ? 'translate-x-[18px]' : ''}`} />
                </div>
                <div className="min-w-0">
                  <p className={`text-xs font-bold leading-tight transition-colors ${config.fvg_tp_enabled ? 'text-emerald-600 dark:text-emerald-400' : 'text-slate-700 dark:text-slate-300'}`}>
                    TP — FVG
                    {config.fvg_tp_enabled && <span className="ml-1.5 px-1.5 py-0.5 rounded text-[9px] font-bold bg-emerald-100 dark:bg-emerald-500/20 text-emerald-600 dark:text-emerald-400 uppercase tracking-wider">Attivo</span>}
                  </p>
                  <p className="text-[10px] text-slate-400 dark:text-slate-500 leading-snug mt-0.5">Take Profit al fondo/tetto della Fair Value Gap opposta</p>
                </div>
              </label>
            </Tooltip>

            {/* SL — Swing */}
            <Tooltip text="Posiziona lo SL oltre il più recente swing high/low confermato nella direzione dell'invalidazione. Per long: SL = swing_low_px − 0.1% (rottura del minimo strutturale). Per short: SL = swing_high_px + 0.1% (rottura del massimo strutturale). Attiva solo quando il livello è entro 4 ATR dall'entry. Solo allarga lo SL — size ridotta proporzionalmente." width="wide" pos="bottom">
              <label className={`flex items-start gap-2.5 cursor-pointer group p-3 rounded-xl border transition-all duration-200 h-full ${config.swing_sl_enabled ? 'border-violet-200 dark:border-violet-500/30 bg-violet-50/40 dark:bg-violet-500/5' : 'border-slate-100 dark:border-white/5 hover:bg-slate-50 dark:hover:bg-white/[0.03]'}`}>
                <div className="relative mt-0.5 flex-shrink-0">
                  <input type="checkbox" className="sr-only" checked={config.swing_sl_enabled} onChange={e => setConfig(c => ({ ...c, swing_sl_enabled: e.target.checked }))} />
                  <div className={`w-9 h-[18px] rounded-full transition-all duration-300 ${config.swing_sl_enabled ? 'bg-violet-600' : 'bg-slate-200 dark:bg-white/10'}`} />
                  <div className={`absolute top-[3px] left-[3px] w-3 h-3 bg-white rounded-full shadow-sm transition-transform duration-300 ${config.swing_sl_enabled ? 'translate-x-[18px]' : ''}`} />
                </div>
                <div className="min-w-0">
                  <p className={`text-xs font-bold leading-tight transition-colors ${config.swing_sl_enabled ? 'text-violet-600 dark:text-violet-400' : 'text-slate-700 dark:text-slate-300'}`}>
                    SL — Swing
                    {config.swing_sl_enabled && <span className="ml-1.5 px-1.5 py-0.5 rounded text-[9px] font-bold bg-violet-100 dark:bg-violet-500/20 text-violet-600 dark:text-violet-400 uppercase tracking-wider">Attivo</span>}
                  </p>
                  <p className="text-[10px] text-slate-400 dark:text-slate-500 leading-snug mt-0.5">Stop Loss oltre lo Swing High/Low strutturale più vicino</p>
                </div>
              </label>
            </Tooltip>

            {/* TP — Swing */}
            <Tooltip text="Usa il più recente swing high/low confermato come target del Take Profit nella direzione del trade. Per long: TP = swing_high_px (prossimo massimo strutturale). Per short: TP = swing_low_px (prossimo minimo strutturale). Il blend controlla quanto peso dare allo Swing vs il TP ATR corrente. Fallback automatico a ATR se nessun swing valido è presente." width="wide" pos="bottom">
              <label className={`flex items-start gap-2.5 cursor-pointer group p-3 rounded-xl border transition-all duration-200 h-full ${config.swing_tp_enabled ? 'border-emerald-200 dark:border-emerald-500/30 bg-emerald-50/40 dark:bg-emerald-500/5' : 'border-slate-100 dark:border-white/5 hover:bg-slate-50 dark:hover:bg-white/[0.03]'}`}>
                <div className="relative mt-0.5 flex-shrink-0">
                  <input type="checkbox" className="sr-only" checked={config.swing_tp_enabled} onChange={e => setConfig(c => ({ ...c, swing_tp_enabled: e.target.checked, ob_tp_enabled: e.target.checked ? false : c.ob_tp_enabled, fvg_tp_enabled: e.target.checked ? false : c.fvg_tp_enabled }))} />
                  <div className={`w-9 h-[18px] rounded-full transition-all duration-300 ${config.swing_tp_enabled ? 'bg-emerald-600' : 'bg-slate-200 dark:bg-white/10'}`} />
                  <div className={`absolute top-[3px] left-[3px] w-3 h-3 bg-white rounded-full shadow-sm transition-transform duration-300 ${config.swing_tp_enabled ? 'translate-x-[18px]' : ''}`} />
                </div>
                <div className="min-w-0">
                  <p className={`text-xs font-bold leading-tight transition-colors ${config.swing_tp_enabled ? 'text-emerald-600 dark:text-emerald-400' : 'text-slate-700 dark:text-slate-300'}`}>
                    TP — Swing
                    {config.swing_tp_enabled && <span className="ml-1.5 px-1.5 py-0.5 rounded text-[9px] font-bold bg-emerald-100 dark:bg-emerald-500/20 text-emerald-600 dark:text-emerald-400 uppercase tracking-wider">Attivo</span>}
                  </p>
                  <p className="text-[10px] text-slate-400 dark:text-slate-500 leading-snug mt-0.5">Take Profit al prossimo Swing High/Low strutturale</p>
                </div>
              </label>
            </Tooltip>
          </div>

          {/* SL buffer controls */}
          {(config.structural_sl_enabled || config.fvg_sl_enabled) && (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 px-1">
              <NumInput label="SL Buffer %" value={config.ob_buffer_pct} onChange={v => setConfig(c => ({ ...c, ob_buffer_pct: v }))} step={0.1} min={0.0} max={2.0} />
              <NumInput label="SL Buffer Min ATR" value={config.ob_buffer_min_atr} onChange={v => setConfig(c => ({ ...c, ob_buffer_min_atr: v }))} step={0.05} min={0.0} max={1.0} />
            </div>
          )}

          {/* OB TP blend slider */}
          {config.ob_tp_enabled && (
            <div className="px-1 flex flex-col gap-1.5 sm:flex-row sm:items-center sm:gap-4">
              <div className="flex items-center justify-between sm:block">
                <span className="text-[10px] font-bold text-slate-400 dark:text-slate-500 uppercase tracking-widest whitespace-nowrap">OB TP — Blend ATR ↔ OB</span>
                <span className="sm:hidden text-[11px] font-bold font-mono text-emerald-600 dark:text-emerald-400">
                  {Math.round((1 - config.ob_tp_blend) * 100)}% ATR · {Math.round(config.ob_tp_blend * 100)}% OB
                </span>
              </div>
              <div className="flex items-center gap-3 flex-1">
                <span className="text-[10px] font-bold text-slate-500 dark:text-slate-400 font-mono">ATR</span>
                <input
                  type="range" min="0" max="1" step="0.05"
                  value={config.ob_tp_blend}
                  onChange={e => setConfig(c => ({ ...c, ob_tp_blend: parseFloat(e.target.value) }))}
                  className="flex-1 h-1.5 rounded-full appearance-none cursor-pointer bg-slate-200 dark:bg-white/15 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-3.5 [&::-webkit-slider-thumb]:h-3.5 [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-emerald-500 [&::-webkit-slider-thumb]:shadow-sm [&::-webkit-slider-thumb]:cursor-pointer [&::-moz-range-thumb]:w-3.5 [&::-moz-range-thumb]:h-3.5 [&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:bg-emerald-500 [&::-moz-range-thumb]:border-0"
                />
                <span className="text-[10px] font-bold text-slate-500 dark:text-slate-400 font-mono">OB</span>
                <span className="hidden sm:inline text-[11px] font-bold font-mono text-emerald-600 dark:text-emerald-400 w-24 text-right">
                  {Math.round((1 - config.ob_tp_blend) * 100)}% ATR · {Math.round(config.ob_tp_blend * 100)}% OB
                </span>
              </div>
            </div>
          )}

          {/* FVG TP blend slider */}
          {config.fvg_tp_enabled && (
            <div className="px-1 flex flex-col gap-1.5 sm:flex-row sm:items-center sm:gap-4">
              <div className="flex items-center justify-between sm:block">
                <span className="text-[10px] font-bold text-slate-400 dark:text-slate-500 uppercase tracking-widest whitespace-nowrap">FVG TP — Blend ATR ↔ FVG</span>
                <span className="sm:hidden text-[11px] font-bold font-mono text-emerald-600 dark:text-emerald-400">
                  {Math.round((1 - config.fvg_tp_blend) * 100)}% ATR · {Math.round(config.fvg_tp_blend * 100)}% FVG
                </span>
              </div>
              <div className="flex items-center gap-3 flex-1">
                <span className="text-[10px] font-bold text-slate-500 dark:text-slate-400 font-mono">ATR</span>
                <input
                  type="range" min="0" max="1" step="0.05"
                  value={config.fvg_tp_blend}
                  onChange={e => setConfig(c => ({ ...c, fvg_tp_blend: parseFloat(e.target.value) }))}
                  className="flex-1 h-1.5 rounded-full appearance-none cursor-pointer bg-slate-200 dark:bg-white/15 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-3.5 [&::-webkit-slider-thumb]:h-3.5 [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-emerald-500 [&::-webkit-slider-thumb]:shadow-sm [&::-webkit-slider-thumb]:cursor-pointer [&::-moz-range-thumb]:w-3.5 [&::-moz-range-thumb]:h-3.5 [&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:bg-emerald-500 [&::-moz-range-thumb]:border-0"
                />
                <span className="text-[10px] font-bold text-slate-500 dark:text-slate-400 font-mono">FVG</span>
                <span className="hidden sm:inline text-[11px] font-bold font-mono text-emerald-600 dark:text-emerald-400 w-24 text-right">
                  {Math.round((1 - config.fvg_tp_blend) * 100)}% ATR · {Math.round(config.fvg_tp_blend * 100)}% FVG
                </span>
              </div>
            </div>
          )}

          {/* Swing TP blend slider */}
          {config.swing_tp_enabled && (
            <div className="px-1 flex flex-col gap-1.5 sm:flex-row sm:items-center sm:gap-4">
              <div className="flex items-center justify-between sm:block">
                <span className="text-[10px] font-bold text-slate-400 dark:text-slate-500 uppercase tracking-widest whitespace-nowrap">Swing TP — Blend ATR ↔ Swing</span>
                <span className="sm:hidden text-[11px] font-bold font-mono text-emerald-600 dark:text-emerald-400">
                  {Math.round((1 - config.swing_tp_blend) * 100)}% ATR · {Math.round(config.swing_tp_blend * 100)}% Swing
                </span>
              </div>
              <div className="flex items-center gap-3 flex-1">
                <span className="text-[10px] font-bold text-slate-500 dark:text-slate-400 font-mono">ATR</span>
                <input
                  type="range" min="0" max="1" step="0.05"
                  value={config.swing_tp_blend}
                  onChange={e => setConfig(c => ({ ...c, swing_tp_blend: parseFloat(e.target.value) }))}
                  className="flex-1 h-1.5 rounded-full appearance-none cursor-pointer bg-slate-200 dark:bg-white/15 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-3.5 [&::-webkit-slider-thumb]:h-3.5 [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-emerald-500 [&::-webkit-slider-thumb]:shadow-sm [&::-webkit-slider-thumb]:cursor-pointer [&::-moz-range-thumb]:w-3.5 [&::-moz-range-thumb]:h-3.5 [&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:bg-emerald-500 [&::-moz-range-thumb]:border-0"
                />
                <span className="text-[10px] font-bold text-slate-500 dark:text-slate-400 font-mono">Swing</span>
                <span className="hidden sm:inline text-[11px] font-bold font-mono text-emerald-600 dark:text-emerald-400 w-24 text-right">
                  {Math.round((1 - config.swing_tp_blend) * 100)}% ATR · {Math.round(config.swing_tp_blend * 100)}% Swing
                </span>
              </div>
            </div>
          )}
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-8 gap-y-6">
          <div>
            <Tooltip text="Distanza dello Stop Loss dal prezzo di entrata, espressa come multiplo dell'ATR. Usato come base anche in modalità AI-driven e strutturale." width="wide" pos="bottom">
              <NumInput label="SL Multiplier (× ATR)" value={config.sl_atr_mult} min={0.5} max={5} step={0.1} onChange={upd('sl_atr_mult')} />
            </Tooltip>
          </div>
          <div>
            <Tooltip text="Distanza del Take Profit dal prezzo di entrata, in multipli di ATR. Usato come base e come fallback quando nessun livello strutturale è disponibile." width="wide" pos="bottom">
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

        {/* ── Signal Gate Toggles ── */}
        <div className="mt-6 pt-6 border-t border-slate-100 dark:border-white/5">
          <p className="text-[10px] font-bold text-slate-400 dark:text-slate-500 uppercase tracking-widest mb-4">Filtri Segnale Attivi</p>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {([
              { key: 'adx_gate_enabled',         label: 'ADX Gate',              desc: 'Blocca il trade se ADX < soglia (mercato senza trend)',       color: 'indigo' },
              { key: 'sweep_gate_enabled',        label: 'Liquidity Sweep Gate',  desc: 'Richiede uno sweep di liquidità recente prima dell\'entrata', color: 'violet' },
              { key: 'fvg_filter_enabled',        label: 'FVG Filter',            desc: 'Filtra entrate senza Fair Value Gap sul timeframe 4H',        color: 'purple' },
              { key: 'mtf_alignment_enabled',     label: 'MTF Alignment',         desc: 'Richiede allineamento direzionale multi-timeframe',           color: 'blue'   },
            ] as { key: keyof Config; label: string; desc: string; color: string }[]).map(({ key, label, desc, color }) => {
              const active = config[key] as boolean;
              return (
                <label key={key} className="flex items-start gap-3 cursor-pointer group p-3 rounded-xl border transition-colors duration-200 hover:bg-slate-50 dark:hover:bg-white/[0.03] border-slate-100 dark:border-white/5">
                  <div className="relative mt-0.5 flex-shrink-0">
                    <input type="checkbox" className="sr-only" checked={active} onChange={e => setConfig(c => ({ ...c, [key]: e.target.checked }))} />
                    <div className={`w-9 h-[18px] rounded-full transition-all duration-300 ${active ? `bg-${color}-600` : 'bg-slate-200 dark:bg-white/10'}`} />
                    <div className={`absolute top-[3px] left-[3px] w-3 h-3 bg-white rounded-full shadow-sm transition-transform duration-300 ${active ? 'translate-x-[18px]' : ''}`} />
                  </div>
                  <div className="min-w-0">
                    <p className={`text-xs font-bold leading-tight transition-colors ${active ? `text-${color}-600 dark:text-${color}-400` : 'text-slate-700 dark:text-slate-300'}`}>{label}</p>
                    <p className="text-[10px] text-slate-400 dark:text-slate-500 leading-snug mt-0.5">{desc}</p>
                  </div>
                </label>
              );
            })}
          </div>

          {/* ── Sweep Gate Directional Mode ────────────────────────────────── */}
          {config.sweep_gate_enabled && (
            <div className={`mt-3 p-3 rounded-xl border transition-colors duration-200 ${config.sweep_gate_directional ? 'border-violet-200 dark:border-violet-500/30 bg-violet-50/40 dark:bg-violet-500/5' : 'border-slate-100 dark:border-white/5'}`}>
              <Tooltip text="Quando attivo: un buyside sweep + ensemble bearish riduce il threshold short di 0.03 (bonus per stop hunt istituzionale). Un sellside sweep + ensemble bullish riduce il long threshold di 0.03. Conflitto sweep/direzione → no-trade. Disattivo: qualsiasi sweep blocca sempre il trade." width="wide" pos="bottom">
              <label className="flex items-start gap-3 cursor-pointer group">
                <div className="relative mt-0.5 flex-shrink-0">
                  <input type="checkbox" className="sr-only" checked={config.sweep_gate_directional} onChange={e => setConfig(c => ({ ...c, sweep_gate_directional: e.target.checked }))} />
                  <div className={`w-9 h-[18px] rounded-full transition-all duration-300 ${config.sweep_gate_directional ? 'bg-violet-600' : 'bg-slate-200 dark:bg-white/10'}`} />
                  <div className={`absolute top-[3px] left-[3px] w-3 h-3 bg-white rounded-full shadow-sm transition-transform duration-300 ${config.sweep_gate_directional ? 'translate-x-[18px]' : ''}`} />
                </div>
                <div className="min-w-0 flex-1">
                  <p className={`text-xs font-bold leading-tight transition-colors ${config.sweep_gate_directional ? 'text-violet-600 dark:text-violet-400' : 'text-slate-700 dark:text-slate-300'}`}>
                    Sweep Confluence — Modalità Direzionale
                    {config.sweep_gate_directional && <span className="ml-2 px-1.5 py-0.5 rounded text-[9px] font-bold bg-violet-100 dark:bg-violet-500/20 text-violet-600 dark:text-violet-400 uppercase tracking-wider">Attivo</span>}
                  </p>
                  <p className="text-[10px] text-slate-400 dark:text-slate-500 leading-snug mt-0.5">
                    {config.sweep_gate_directional
                      ? 'Sweep confermato nella direzione del modello → bonus −0.03 al threshold. Conflitto → blocco. Identifica stop hunt istituzionale.'
                      : 'Disabilitato: qualsiasi sweep blocca il trade (comportamento attuale). Attiva per convertire lo sweep da blocco a segnale direzionale.'}
                  </p>
                </div>
              </label>
              </Tooltip>
            </div>
          )}

          {/* ── CVD Absorption Filter ───────────────────────────────────────── */}
          <div className={`mt-4 p-3 rounded-xl border transition-colors duration-200 ${config.absorption_filter_enabled ? 'border-teal-200 dark:border-teal-500/30 bg-teal-50/50 dark:bg-teal-500/5' : 'border-slate-100 dark:border-white/5'}`}>
            <Tooltip text="absorption_z = volume / (|close−open| + ATR×0.01), z-scored su 24 barre. Valori alti indicano volume anomalo con movimento minimo: segnale di accumulo istituzionale. Attivo aggiunge +0.03 al threshold quando z supera la soglia configurata." width="wide" pos="bottom">
            <label className="flex items-start gap-3 cursor-pointer group">
              <div className="relative mt-0.5 flex-shrink-0">
                <input type="checkbox" className="sr-only" checked={config.absorption_filter_enabled} onChange={e => setConfig(c => ({ ...c, absorption_filter_enabled: e.target.checked }))} />
                <div className={`w-9 h-[18px] rounded-full transition-all duration-300 ${config.absorption_filter_enabled ? 'bg-teal-600' : 'bg-slate-200 dark:bg-white/10'}`} />
                <div className={`absolute top-[3px] left-[3px] w-3 h-3 bg-white rounded-full shadow-sm transition-transform duration-300 ${config.absorption_filter_enabled ? 'translate-x-[18px]' : ''}`} />
              </div>
              <div className="min-w-0 flex-1">
                <p className={`text-xs font-bold leading-tight transition-colors ${config.absorption_filter_enabled ? 'text-teal-600 dark:text-teal-400' : 'text-slate-700 dark:text-slate-300'}`}>
                  CVD Absorption Filter
                  {config.absorption_filter_enabled && <span className="ml-2 px-1.5 py-0.5 rounded text-[9px] font-bold bg-teal-100 dark:bg-teal-500/20 text-teal-600 dark:text-teal-400 uppercase tracking-wider">Attivo</span>}
                </p>
                <p className="text-[10px] text-slate-400 dark:text-slate-500 leading-snug mt-0.5">
                  Alto volume senza movimento di prezzo = istituzionali che assorbono. Aggiunge +0.03 al threshold richiesto.
                </p>
              </div>
            </label>
            </Tooltip>
            {config.absorption_filter_enabled && (
              <div className="mt-3 pt-3 border-t border-teal-100 dark:border-teal-500/20">
                <div className="flex items-center justify-between mb-1">
                  <span className="text-[10px] font-medium text-slate-600 dark:text-slate-400">Soglia Z-Score</span>
                  <span className="text-[10px] font-bold text-teal-600 dark:text-teal-400">{config.absorption_z_threshold.toFixed(1)}σ</span>
                </div>
                <input
                  type="range" min={0.5} max={5.0} step={0.1}
                  value={config.absorption_z_threshold}
                  onChange={e => setConfig(c => ({ ...c, absorption_z_threshold: parseFloat(e.target.value) }))}
                  className="w-full h-1 rounded-full appearance-none bg-teal-100 dark:bg-teal-900/40 accent-teal-500"
                />
                <p className="text-[9px] text-slate-400 dark:text-slate-500 mt-1">
                  Boost +0.03 quando absorption_z supera questa soglia (volume anomalo rispetto alla norma recente)
                </p>
              </div>
            )}
          </div>
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
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
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
              {/* Enhanced regime detection toggle — only relevant in Auto mode */}
              {config.forced_regime === 'auto' && (
                <label className={`flex items-center gap-3 mt-3 p-3 rounded-xl cursor-pointer transition-colors ${config.regime_bias_enhanced ? 'bg-indigo-50 dark:bg-indigo-500/10 border border-indigo-200 dark:border-indigo-500/25' : 'bg-slate-50 dark:bg-white/[0.03] border border-slate-100 dark:border-white/5'}`}>
                  <div className="relative shrink-0">
                    <input type="checkbox" className="sr-only" checked={config.regime_bias_enhanced} onChange={e => setConfig(c => ({ ...c, regime_bias_enhanced: e.target.checked }))} />
                    <div className={`w-9 h-5 rounded-full transition-all duration-300 ${config.regime_bias_enhanced ? 'bg-indigo-600' : 'bg-slate-200 dark:bg-white/10'}`} />
                    <div className={`absolute top-1 left-1 w-3 h-3 bg-white rounded-full shadow-sm transition-transform duration-300 ${config.regime_bias_enhanced ? 'translate-x-4' : ''}`} />
                  </div>
                  <div>
                    <p className={`text-[11px] font-bold ${config.regime_bias_enhanced ? 'text-indigo-600 dark:text-indigo-400' : 'text-slate-600 dark:text-slate-400'}`}>
                      Regime Detection Avanzato
                      {config.regime_bias_enhanced && <span className="ml-1.5 px-1.5 py-0.5 rounded text-[9px] font-bold bg-indigo-100 dark:bg-indigo-500/20 text-indigo-600 dark:text-indigo-400 uppercase tracking-wider">Attivo</span>}
                    </p>
                    <p className="text-[10px] text-slate-400 dark:text-slate-500 mt-0.5">
                      {config.regime_bias_enhanced
                        ? 'ADX slope · BB compression · transition_risk · confidence — delta modulato dinamicamente'
                        : 'Semplice: EMA20 + ADX > 20 (più reattivo, meno preciso)'}
                    </p>
                  </div>
                </label>
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


      {/* ── Bias di Mercato — Funding / Sentiment ── */}
      <Section title="Bias di Mercato — Funding / Sentiment" description="Adatta le soglie direzionali al posizionamento del mercato. Funding Rate alto = mercato over-long → soglia long alzata. Fear &amp; Greed estremo = contrarian → favorisce il lato opposto.">
        {/* Funding Rate Bias */}
        <div className={`flex flex-col gap-3 mb-6 pb-6 border-b transition-colors duration-200 ${config.funding_gate_enabled ? 'border-cyan-200 dark:border-cyan-500/25' : 'border-slate-100 dark:border-white/5'}`}>
          <label className="flex items-center gap-3 cursor-pointer group">
            <div className="relative">
              <input type="checkbox" className="sr-only" checked={config.funding_gate_enabled} onChange={e => setConfig(c => ({ ...c, funding_gate_enabled: e.target.checked }))} />
              <div className={`w-10 h-5 rounded-full transition-all duration-300 ${config.funding_gate_enabled ? 'bg-cyan-600' : 'bg-slate-200 dark:bg-white/10'}`} />
              <div className={`absolute top-1 left-1 w-3 h-3 bg-white rounded-full shadow-sm transition-transform duration-300 ${config.funding_gate_enabled ? 'translate-x-5' : ''}`} />
            </div>
            <div>
              <p className={`text-sm font-bold transition-colors ${config.funding_gate_enabled ? 'text-cyan-600 dark:text-cyan-400' : 'text-slate-800 dark:text-slate-200 group-hover:text-cyan-600 dark:group-hover:text-cyan-400'}`}>
                Funding Rate Bias
                {config.funding_gate_enabled && <span className="ml-2 px-1.5 py-0.5 rounded text-[9px] font-bold bg-cyan-100 dark:bg-cyan-500/20 text-cyan-600 dark:text-cyan-400 uppercase tracking-wider">Attivo</span>}
              </p>
              <p className="text-[11px] font-medium text-slate-400 dark:text-slate-500 leading-tight">
                {config.funding_gate_enabled
                  ? `Lookback ${config.funding_gate_lookback} bar · high ≥${(config.funding_high_thr * 10000).toFixed(1)}bps · extreme ≥${(config.funding_extreme_thr * 10000).toFixed(1)}bps · Δ${config.funding_bias_delta}`
                  : 'Funding positivo alto → soglia long alzata; funding negativo → soglia short alzata'}
              </p>
            </div>
          </label>
          {config.funding_gate_enabled && (
            <div className="pl-12 grid grid-cols-1 sm:grid-cols-2 gap-x-8 gap-y-4 mt-1">
              <div>
                <label className="flex items-center justify-between mb-2">
                  <span className="text-[11px] font-bold text-slate-600 dark:text-slate-400 uppercase tracking-widest">Lookback bars (4H)</span>
                  <span className="font-mono text-sm font-bold text-cyan-600 dark:text-cyan-400">{config.funding_gate_lookback}</span>
                </label>
                <input type="range" min="2" max="24" step="1"
                  value={config.funding_gate_lookback}
                  onChange={e => setConfig(c => ({ ...c, funding_gate_lookback: parseInt(e.target.value) }))}
                  className="w-full h-1.5 bg-slate-200 dark:bg-white/10 rounded-full appearance-none cursor-pointer accent-cyan-600"
                />
                <div className="flex justify-between text-[9px] font-mono text-slate-400 mt-1"><span>2</span><span>12</span><span>24</span></div>
              </div>
              <div>
                <label className="flex items-center justify-between mb-2">
                  <span className="text-[11px] font-bold text-slate-600 dark:text-slate-400 uppercase tracking-widest">Soglia high (bps/8h)</span>
                  <span className="font-mono text-sm font-bold text-cyan-600 dark:text-cyan-400">{(config.funding_high_thr * 10000).toFixed(1)}</span>
                </label>
                <input type="range" min="0.00003" max="0.00050" step="0.00001"
                  value={config.funding_high_thr}
                  onChange={e => setConfig(c => ({ ...c, funding_high_thr: parseFloat(e.target.value) }))}
                  className="w-full h-1.5 bg-slate-200 dark:bg-white/10 rounded-full appearance-none cursor-pointer accent-cyan-600"
                />
                <div className="flex justify-between text-[9px] font-mono text-slate-400 mt-1"><span>0.3</span><span>2.5</span><span>5.0</span></div>
              </div>
              <div>
                <label className="flex items-center justify-between mb-2">
                  <span className="text-[11px] font-bold text-slate-600 dark:text-slate-400 uppercase tracking-widest">Soglia extreme (bps/8h)</span>
                  <span className="font-mono text-sm font-bold text-cyan-600 dark:text-cyan-400">{(config.funding_extreme_thr * 10000).toFixed(1)}</span>
                </label>
                <input type="range" min="0.00010" max="0.00100" step="0.00005"
                  value={config.funding_extreme_thr}
                  onChange={e => setConfig(c => ({ ...c, funding_extreme_thr: parseFloat(e.target.value) }))}
                  className="w-full h-1.5 bg-slate-200 dark:bg-white/10 rounded-full appearance-none cursor-pointer accent-cyan-600"
                />
                <div className="flex justify-between text-[9px] font-mono text-slate-400 mt-1"><span>1.0</span><span>5.0</span><span>10.0</span></div>
              </div>
              <div>
                <label className="flex items-center justify-between mb-2">
                  <span className="text-[11px] font-bold text-slate-600 dark:text-slate-400 uppercase tracking-widest">Bias delta</span>
                  <span className="font-mono text-sm font-bold text-cyan-600 dark:text-cyan-400">Δ{config.funding_bias_delta.toFixed(2)}</span>
                </label>
                <input type="range" min="0.01" max="0.08" step="0.005"
                  value={config.funding_bias_delta}
                  onChange={e => setConfig(c => ({ ...c, funding_bias_delta: parseFloat(e.target.value) }))}
                  className="w-full h-1.5 bg-slate-200 dark:bg-white/10 rounded-full appearance-none cursor-pointer accent-cyan-600"
                />
                <div className="flex justify-between text-[9px] font-mono text-slate-400 mt-1"><span>0.01</span><span>0.04</span><span>0.08</span></div>
              </div>
            </div>
          )}
        </div>

        {/* Fear & Greed Bias */}
        <div className={`flex flex-col gap-3 transition-colors duration-200`}>
          <label className="flex items-center gap-3 cursor-pointer group">
            <div className="relative">
              <input type="checkbox" className="sr-only" checked={config.fng_gate_enabled} onChange={e => setConfig(c => ({ ...c, fng_gate_enabled: e.target.checked }))} />
              <div className={`w-10 h-5 rounded-full transition-all duration-300 ${config.fng_gate_enabled ? 'bg-violet-600' : 'bg-slate-200 dark:bg-white/10'}`} />
              <div className={`absolute top-1 left-1 w-3 h-3 bg-white rounded-full shadow-sm transition-transform duration-300 ${config.fng_gate_enabled ? 'translate-x-5' : ''}`} />
            </div>
            <div>
              <p className={`text-sm font-bold transition-colors ${config.fng_gate_enabled ? 'text-violet-600 dark:text-violet-400' : 'text-slate-800 dark:text-slate-200 group-hover:text-violet-600 dark:group-hover:text-violet-400'}`}>
                Fear &amp; Greed Bias
                {config.fng_gate_enabled && <span className="ml-2 px-1.5 py-0.5 rounded text-[9px] font-bold bg-violet-100 dark:bg-violet-500/20 text-violet-600 dark:text-violet-400 uppercase tracking-wider">Attivo</span>}
              </p>
              <p className="text-[11px] font-medium text-slate-400 dark:text-slate-500 leading-tight">
                {config.fng_gate_enabled
                  ? `Extreme Fear <${config.fng_extreme_fear_thr} · Fear <${config.fng_fear_thr} · Greed >${config.fng_greed_thr} · Extreme Greed >${config.fng_extreme_greed_thr} · Δ${config.fng_bias_delta}`
                  : 'Contrarian: paura estrema favorisce long, greed estremo favorisce short'}
              </p>
            </div>
          </label>
          {config.fng_gate_enabled && (
            <div className="pl-12 grid grid-cols-1 sm:grid-cols-2 gap-x-8 gap-y-4 mt-1">
              <div>
                <label className="flex items-center justify-between mb-2">
                  <span className="text-[11px] font-bold text-slate-600 dark:text-slate-400 uppercase tracking-widest">Soglia Extreme Fear</span>
                  <span className="font-mono text-sm font-bold text-violet-600 dark:text-violet-400">&lt;{config.fng_extreme_fear_thr.toFixed(0)}</span>
                </label>
                <input type="range" min="5" max="40" step="1"
                  value={config.fng_extreme_fear_thr}
                  onChange={e => setConfig(c => ({ ...c, fng_extreme_fear_thr: parseFloat(e.target.value) }))}
                  className="w-full h-1.5 bg-slate-200 dark:bg-white/10 rounded-full appearance-none cursor-pointer accent-violet-600"
                />
                <div className="flex justify-between text-[9px] font-mono text-slate-400 mt-1"><span>5</span><span>20</span><span>40</span></div>
              </div>
              <div>
                <label className="flex items-center justify-between mb-2">
                  <span className="text-[11px] font-bold text-slate-600 dark:text-slate-400 uppercase tracking-widest">Soglia Fear</span>
                  <span className="font-mono text-sm font-bold text-violet-600 dark:text-violet-400">&lt;{config.fng_fear_thr.toFixed(0)}</span>
                </label>
                <input type="range" min="20" max="50" step="1"
                  value={config.fng_fear_thr}
                  onChange={e => setConfig(c => ({ ...c, fng_fear_thr: parseFloat(e.target.value) }))}
                  className="w-full h-1.5 bg-slate-200 dark:bg-white/10 rounded-full appearance-none cursor-pointer accent-violet-600"
                />
                <div className="flex justify-between text-[9px] font-mono text-slate-400 mt-1"><span>20</span><span>35</span><span>50</span></div>
              </div>
              <div>
                <label className="flex items-center justify-between mb-2">
                  <span className="text-[11px] font-bold text-slate-600 dark:text-slate-400 uppercase tracking-widest">Soglia Greed</span>
                  <span className="font-mono text-sm font-bold text-violet-600 dark:text-violet-400">&gt;{config.fng_greed_thr.toFixed(0)}</span>
                </label>
                <input type="range" min="50" max="80" step="1"
                  value={config.fng_greed_thr}
                  onChange={e => setConfig(c => ({ ...c, fng_greed_thr: parseFloat(e.target.value) }))}
                  className="w-full h-1.5 bg-slate-200 dark:bg-white/10 rounded-full appearance-none cursor-pointer accent-violet-600"
                />
                <div className="flex justify-between text-[9px] font-mono text-slate-400 mt-1"><span>50</span><span>65</span><span>80</span></div>
              </div>
              <div>
                <label className="flex items-center justify-between mb-2">
                  <span className="text-[11px] font-bold text-slate-600 dark:text-slate-400 uppercase tracking-widest">Soglia Extreme Greed</span>
                  <span className="font-mono text-sm font-bold text-violet-600 dark:text-violet-400">&gt;{config.fng_extreme_greed_thr.toFixed(0)}</span>
                </label>
                <input type="range" min="60" max="95" step="1"
                  value={config.fng_extreme_greed_thr}
                  onChange={e => setConfig(c => ({ ...c, fng_extreme_greed_thr: parseFloat(e.target.value) }))}
                  className="w-full h-1.5 bg-slate-200 dark:bg-white/10 rounded-full appearance-none cursor-pointer accent-violet-600"
                />
                <div className="flex justify-between text-[9px] font-mono text-slate-400 mt-1"><span>60</span><span>80</span><span>95</span></div>
              </div>
              <div className="sm:col-span-2">
                <label className="flex items-center justify-between mb-2">
                  <span className="text-[11px] font-bold text-slate-600 dark:text-slate-400 uppercase tracking-widest">Bias delta</span>
                  <span className="font-mono text-sm font-bold text-violet-600 dark:text-violet-400">Δ{config.fng_bias_delta.toFixed(2)}</span>
                </label>
                <input type="range" min="0.01" max="0.08" step="0.005"
                  value={config.fng_bias_delta}
                  onChange={e => setConfig(c => ({ ...c, fng_bias_delta: parseFloat(e.target.value) }))}
                  className="w-full h-1.5 bg-slate-200 dark:bg-white/10 rounded-full appearance-none cursor-pointer accent-violet-600"
                />
                <div className="flex justify-between text-[9px] font-mono text-slate-400 mt-1"><span>0.01</span><span>0.04</span><span>0.08</span></div>
              </div>
            </div>
          )}
        </div>
      </Section>

      {/* Chronos-2 — Modello Predittivo */}
      <Section title="Chronos-2 — Modello Predittivo" description="Transformer time-series Chronos-2: controlla l'attivazione del modello, il peso nell'ensemble e i gate basati sulle previsioni quantili p10/p90/p50.">
        {/* ── Master toggle for chronos_enabled ── */}
        <div className={`flex flex-col gap-3 mb-6 pb-6 border-b transition-colors duration-200 ${config.chronos_enabled ? 'border-sky-200 dark:border-sky-500/25' : 'border-slate-100 dark:border-white/5'}`}>
          <label className="flex items-center gap-3 cursor-pointer group">
            <div className="relative">
              <input type="checkbox" className="sr-only" checked={config.chronos_enabled} onChange={e => setConfig(c => ({ ...c, chronos_enabled: e.target.checked }))} />
              <div className={`w-10 h-5 rounded-full transition-all duration-300 ${config.chronos_enabled ? 'bg-sky-600' : 'bg-slate-200 dark:bg-white/10'}`} />
              <div className={`absolute top-1 left-1 w-3 h-3 bg-white rounded-full shadow-sm transition-transform duration-300 ${config.chronos_enabled ? 'translate-x-5' : ''}`} />
            </div>
            <div>
              <p className={`text-sm font-bold transition-colors ${config.chronos_enabled ? 'text-sky-600 dark:text-sky-400' : 'text-slate-800 dark:text-slate-200 group-hover:text-sky-600 dark:group-hover:text-sky-400'}`}>
                Abilita Chronos-2
                {config.chronos_enabled && <span className="ml-2 px-1.5 py-0.5 rounded text-[9px] font-bold bg-sky-100 dark:bg-sky-500/20 text-sky-600 dark:text-sky-400 uppercase tracking-wider">Attivo</span>}
              </p>
              <p className="text-[11px] font-medium text-slate-400 dark:text-slate-500 leading-tight">
                {config.chronos_enabled ? 'Modello transformer attivo — p10/p90 quantili usati per gates e SL/TP adattativi' : 'Disattivo — il bot usa solo LightGBM (peso 100%)'}
              </p>
            </div>
          </label>
          {config.chronos_enabled && (
            <div className="pl-12 grid grid-cols-1 sm:grid-cols-2 gap-x-8 gap-y-4 mt-1">
              <div>
                <p className="text-[10px] font-bold text-slate-400 dark:text-slate-500 uppercase tracking-widest mb-2">Peso Chronos nell'Ensemble</p>
                <div className="flex items-center gap-3">
                  <input
                    type="range" min="0" max="0.9" step="0.05"
                    value={config.chronos_weight}
                    onChange={e => setConfig(c => ({ ...c, chronos_weight: parseFloat(e.target.value) }))}
                    className="flex-1 h-1.5 rounded-full appearance-none cursor-pointer bg-slate-200 dark:bg-white/15 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-3.5 [&::-webkit-slider-thumb]:h-3.5 [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-sky-500 [&::-webkit-slider-thumb]:shadow-sm [&::-webkit-slider-thumb]:cursor-pointer [&::-moz-range-thumb]:w-3.5 [&::-moz-range-thumb]:h-3.5 [&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:bg-sky-500 [&::-moz-range-thumb]:border-0"
                  />
                  <span className="text-[11px] font-bold font-mono text-sky-600 dark:text-sky-400 w-10 text-right">{(config.chronos_weight * 100).toFixed(0)}%</span>
                </div>
                <p className="text-[10px] text-slate-400 dark:text-slate-500 mt-1">Resto assegnato a LightGBM</p>
              </div>
              <label className="flex items-start gap-3 cursor-pointer group p-3 rounded-xl border border-slate-100 dark:border-white/5 hover:bg-slate-50 dark:hover:bg-white/[0.03] transition-colors">
                <div className="relative mt-0.5 flex-shrink-0">
                  <input type="checkbox" className="sr-only" checked={config.recalibrated_uncertainty_thresholds} onChange={e => setConfig(c => ({ ...c, recalibrated_uncertainty_thresholds: e.target.checked }))} />
                  <div className={`w-9 h-[18px] rounded-full transition-all duration-300 ${config.recalibrated_uncertainty_thresholds ? 'bg-teal-600' : 'bg-slate-200 dark:bg-white/10'}`} />
                  <div className={`absolute top-[3px] left-[3px] w-3 h-3 bg-white rounded-full shadow-sm transition-transform duration-300 ${config.recalibrated_uncertainty_thresholds ? 'translate-x-[18px]' : ''}`} />
                </div>
                <div>
                  <p className={`text-xs font-bold leading-tight ${config.recalibrated_uncertainty_thresholds ? 'text-teal-600 dark:text-teal-400' : 'text-slate-700 dark:text-slate-300'}`}>Soglie Uncertainty Ricalibrate</p>
                  <p className="text-[10px] text-slate-400 dark:text-slate-500 leading-snug mt-0.5">Usa thresholds C2 ottimizzati sul dataset storico</p>
                </div>
              </label>
            </div>
          )}
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

        {/* ── Isotonic Calibration ── */}
        <div className={`flex flex-col gap-3 mt-6 pt-6 border-t transition-colors duration-200 ${config.use_chronos_calibration ? 'border-teal-200 dark:border-teal-500/25' : 'border-slate-100 dark:border-white/5'}`}>
          <Tooltip text="Corregge c2_dir_prob usando IsotonicRegression addestrata sugli esiti reali dei trade storici: X = c2_dir_prob al momento dell'inferenza, y = 1 se il trade è stato profittevole. Richiede ≥50 trade chiusi con inference_id valorizzato nel DB. Quando attivo, la calibrazione viene ri-fittata ad ogni retrain automaticamente." width="wide" pos="bottom">
            <label className="flex items-center gap-3 cursor-pointer group">
              <div className="relative">
                <input
                  type="checkbox"
                  className="sr-only"
                  checked={config.use_chronos_calibration}
                  onChange={e => setConfig(c => ({ ...c, use_chronos_calibration: e.target.checked }))}
                  disabled={!config.chronos_enabled}
                />
                <div className={`w-10 h-5 rounded-full transition-all duration-300 ${config.use_chronos_calibration ? 'bg-teal-600' : 'bg-slate-200 dark:bg-white/10'} ${!config.chronos_enabled ? 'opacity-40' : ''}`} />
                <div className={`absolute top-1 left-1 w-3 h-3 bg-white rounded-full shadow-sm transition-transform duration-300 ${config.use_chronos_calibration ? 'translate-x-5' : ''}`} />
              </div>
              <div>
                <p className={`text-sm font-bold transition-colors ${config.use_chronos_calibration ? 'text-teal-600 dark:text-teal-400' : !config.chronos_enabled ? 'text-slate-400 dark:text-slate-600' : 'text-slate-800 dark:text-slate-200 group-hover:text-teal-600 dark:group-hover:text-teal-400'}`}>
                  Calibrazione Isotonica c2_dir_prob
                  {config.use_chronos_calibration && (
                    <span className="ml-2 px-1.5 py-0.5 rounded text-[9px] font-bold bg-teal-100 dark:bg-teal-500/20 text-teal-600 dark:text-teal-400 uppercase tracking-wider">Attivo</span>
                  )}
                </p>
                <p className="text-[11px] font-medium text-slate-400 dark:text-slate-500 leading-tight">
                  {!config.chronos_enabled
                    ? 'Richiede Chronos-2 attivo'
                    : config.use_chronos_calibration
                    ? 'c2_dir_prob corretto da IsotonicRegression — richiede ≥50 trade chiusi nel DB'
                    : 'Corregge le probabilità Chronos sugli esiti reali dei trade storici'}
                </p>
              </div>
            </label>
          </Tooltip>
          {config.use_chronos_calibration && !config.chronos_enabled && (
            <div className="flex items-start gap-3 bg-amber-50 dark:bg-amber-500/10 border border-amber-200 dark:border-amber-500/30 rounded-xl px-4 py-3">
              <svg className="w-4 h-4 text-amber-500 flex-shrink-0 mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" />
              </svg>
              <div>
                <p className="text-[11px] font-bold text-amber-700 dark:text-amber-400 uppercase tracking-wide">Chronos-2 non attivo</p>
                <p className="text-[11px] text-amber-600 dark:text-amber-500 leading-snug mt-0.5">
                  La calibrazione isotonica richiede Chronos-2. Abilitarlo nelle impostazioni sopra.
                </p>
              </div>
            </div>
          )}
          {config.use_chronos_calibration && config.chronos_enabled && (
            <div className="flex flex-col gap-3">
              {/* Calibrator status card */}
              <div className="bg-slate-50 dark:bg-white/3 border border-slate-100 dark:border-white/8 rounded-xl px-4 py-3 flex flex-col gap-2">
                <div className="flex items-center justify-between gap-3">
                  <div className="flex items-center gap-2">
                    <div className={`w-2 h-2 rounded-full flex-shrink-0 ${calibratorStats?.fitted ? 'bg-teal-500' : 'bg-slate-300 dark:bg-slate-600'}`} />
                    <span className="text-[11px] font-bold text-slate-700 dark:text-slate-300">
                      {calibratorStats?.fitted
                        ? `Calibratore attivo — ${calibratorStats.n_samples} trade`
                        : calibratorStats?.file_exists === false
                        ? 'Nessun calibratore addestrato'
                        : 'Stato calibratore sconosciuto'}
                    </span>
                  </div>
                  <Tooltip text="Ri-addestra il calibratore isotonic su tutti i trade chiusi nel DB con inference_id valorizzato. Richiede ≥50 campioni. Il processo dura <2 secondi e non richiede un retrain completo di LightGBM." width="wide" pos="top">
                    <button
                      onClick={handleCalibratorRefit}
                      disabled={calibratorRefitting}
                      className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[11px] font-bold bg-teal-600 hover:bg-teal-700 disabled:opacity-50 disabled:cursor-not-allowed text-white transition-colors"
                    >
                      {calibratorRefitting ? (
                        <svg className="w-3 h-3 animate-spin" fill="none" viewBox="0 0 24 24">
                          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
                          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z"/>
                        </svg>
                      ) : (
                        <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                        </svg>
                      )}
                      {calibratorRefitting ? 'Calibro…' : 'Ricalibra ora'}
                    </button>
                  </Tooltip>
                </div>
                {/* Probability mapping */}
                {calibratorStats?.fitted && calibratorStats.mapping && (
                  <div className="flex flex-wrap gap-x-3 gap-y-1 mt-1">
                    {Object.entries(calibratorStats.mapping).map(([key, val]: [string, number]) => {
                      const raw = parseInt(key.replace('raw_', '')) / 100;
                      const delta = val - raw;
                      return (
                        <div key={key} className="flex items-center gap-1 text-[10px]">
                          <span className="text-slate-400 dark:text-slate-500 font-mono">{(raw * 100).toFixed(0)}%</span>
                          <span className="text-slate-300 dark:text-slate-600">→</span>
                          <span className="font-mono font-bold text-slate-600 dark:text-slate-300">{(val * 100).toFixed(1)}%</span>
                          <span className={`font-mono text-[9px] ${delta >= 0 ? 'text-teal-500' : 'text-rose-400'}`}>
                            ({delta >= 0 ? '+' : ''}{(delta * 100).toFixed(1)})
                          </span>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
              {/* Refit result feedback */}
              {calibratorRefitResult && (
                <div className={`flex items-center gap-2 px-3 py-2 rounded-lg text-[11px] font-medium border ${
                  calibratorRefitResult.status === 'ok'
                    ? 'bg-teal-50 dark:bg-teal-500/10 border-teal-200 dark:border-teal-500/30 text-teal-700 dark:text-teal-400'
                    : calibratorRefitResult.status === 'skipped'
                    ? 'bg-amber-50 dark:bg-amber-500/10 border-amber-200 dark:border-amber-500/30 text-amber-700 dark:text-amber-400'
                    : 'bg-rose-50 dark:bg-rose-500/10 border-rose-200 dark:border-rose-500/30 text-rose-700 dark:text-rose-400'
                }`}>
                  {calibratorRefitResult.status === 'ok' && `✓ Calibratore aggiornato su ${calibratorRefitResult.n_samples} trade`}
                  {calibratorRefitResult.status === 'skipped' && `⚠ Dati insufficienti — ${calibratorRefitResult.n_samples ?? 0}/50 trade nel DB`}
                  {calibratorRefitResult.status === 'error' && '✕ Errore durante la ricalibrazione'}
                </div>
              )}
              <p className="text-[10px] text-slate-400 dark:text-slate-500 leading-relaxed">
                Il calibratore viene ri-addestrato automaticamente ad ogni retrain di LightGBM (ogni ~{config.retrain_every_n_cycles} cicli ≈ {Math.round(config.retrain_every_n_cycles * 4 / 24)} giorni). Usa "Ricalibra ora" per aggiornarlo immediatamente senza attendere il retrain.
              </p>
            </div>
          )}
        </div>

      </Section>

      <Section title="LightGBM — Modello, Retraining & Gate" description="Gestione completa del modello LightGBM 4H: stato, retrain manuale, frequenza automatica, walk-forward e gate secondario 1H.">
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

        {/* Deep Training */}
        <div className="mt-5 p-4 rounded-xl border border-violet-200 dark:border-violet-500/20 bg-violet-50/40 dark:bg-violet-500/5 space-y-3">
          <div className="flex items-center gap-2">
            <svg className="w-3.5 h-3.5 text-violet-500 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 2L2 7l10 5 10-5-10-5z"/><path d="M2 17l10 5 10-5"/><path d="M2 12l10 5 10-5"/>
            </svg>
            <span className="text-[10px] font-bold text-violet-600 dark:text-violet-400 uppercase tracking-widest">Deep Training — Storia completa</span>
          </div>
          <p className="text-[10px] text-slate-500 dark:text-slate-400 leading-relaxed">
            Allena il modello su anni di dati BTC via Binance invece degli ultimi 500 candles HL.
            Il modello attuale viene salvato come <span className="font-mono">lgbm_latest.bak.pkl</span> prima di essere sovrascritto.
          </p>
          {/* Preset year buttons */}
          <div className="flex gap-1.5 flex-wrap">
            {(['1Y','2Y','3Y','5Y'] as const).map(label => {
              const years = parseInt(label);
              const d = new Date();
              d.setFullYear(d.getFullYear() - years);
              const val = d.toISOString().slice(0, 10);
              return (
                <button
                  key={label}
                  onClick={() => setDeepFromDate(val)}
                  disabled={retraining}
                  className={`px-3 py-1.5 rounded-lg text-[10px] font-bold uppercase tracking-wider border transition-all ${
                    deepFromDate === val
                      ? 'bg-violet-500 text-white border-violet-500'
                      : 'bg-white dark:bg-white/5 text-slate-600 dark:text-slate-400 border-slate-200 dark:border-white/10 hover:border-violet-400 dark:hover:border-violet-500/50'
                  }`}
                >{label}</button>
              );
            })}
            <input
              type="date"
              value={deepFromDate}
              onChange={e => setDeepFromDate(e.target.value)}
              disabled={retraining}
              className="flex-1 min-w-[110px] px-2 py-1.5 rounded-lg text-[10px] font-mono border border-slate-200 dark:border-white/10 bg-white dark:bg-white/5 text-slate-700 dark:text-slate-300 focus:outline-none focus:border-violet-400"
            />
          </div>
          {/* Optuna toggle + trials slider */}
          <div className={`rounded-xl border px-3 py-2.5 space-y-2.5 transition-colors ${config.use_optuna ? 'border-amber-300 dark:border-amber-500/30 bg-amber-50/60 dark:bg-amber-500/5' : 'border-slate-200 dark:border-white/8 bg-white/50 dark:bg-white/[0.02]'}`}>
            <Tooltip
              text="Quando attivo, prima del retrain Optuna esegue 50–200 trial di Bayesian optimization per trovare i parametri LightGBM ottimali (num_leaves, max_depth, learning_rate, reg_alpha, ecc.). Ogni trial è una mini-WF da 3 fold. Consigliato solo per Deep Training, non per retrain ciclici. Aggiunge 3–8 minuti al processo."
              width="wide"
              pos="top"
            >
              <label className="flex items-center justify-between gap-3 cursor-pointer">
                <div className="flex items-center gap-2">
                  <span className="text-[10px] font-bold text-slate-600 dark:text-slate-400 uppercase tracking-widest cursor-help">
                    Optuna Tuning
                  </span>
                  {config.use_optuna && (
                    <span className="px-1.5 py-0.5 rounded text-[9px] font-bold bg-amber-100 dark:bg-amber-500/20 text-amber-700 dark:text-amber-400 uppercase tracking-wider">
                      Attivo
                    </span>
                  )}
                </div>
                <div className="relative flex-shrink-0">
                  <input
                    type="checkbox"
                    className="sr-only"
                    checked={config.use_optuna}
                    onChange={e => setConfig(c => ({ ...c, use_optuna: e.target.checked }))}
                  />
                  <div className={`w-9 h-[18px] rounded-full transition-all duration-300 ${config.use_optuna ? 'bg-amber-500' : 'bg-slate-200 dark:bg-white/10'}`} />
                  <div className={`absolute top-[3px] left-[3px] w-3 h-3 bg-white rounded-full shadow-sm transition-transform duration-300 ${config.use_optuna ? 'translate-x-[18px]' : ''}`} />
                </div>
              </label>
            </Tooltip>

            {config.use_optuna && (
              <div className="space-y-1.5 pt-1 border-t border-amber-200 dark:border-amber-500/20">
                <div className="flex items-center justify-between">
                  <span className="text-[10px] text-slate-500 dark:text-slate-400">Trial Optuna</span>
                  <span className="font-mono text-sm font-bold text-amber-600 dark:text-amber-400">{config.optuna_n_trials}</span>
                </div>
                <input
                  type="range" min={10} max={200} step={10}
                  value={config.optuna_n_trials}
                  onChange={e => setConfig(c => ({ ...c, optuna_n_trials: parseInt(e.target.value) }))}
                  className="w-full h-1.5 rounded-full appearance-none cursor-pointer bg-slate-200 dark:bg-white/15 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-3.5 [&::-webkit-slider-thumb]:h-3.5 [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-amber-500 [&::-webkit-slider-thumb]:shadow-sm [&::-webkit-slider-thumb]:cursor-pointer [&::-moz-range-thumb]:w-3.5 [&::-moz-range-thumb]:h-3.5 [&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:bg-amber-500 [&::-moz-range-thumb]:border-0"
                />
                <div className="flex justify-between text-[9px] font-mono text-slate-400 dark:text-slate-500">
                  <span>10 (~1 min)</span><span>50 (~4 min)</span><span>200 (~15 min)</span>
                </div>
                <p className="text-[9px] text-amber-700 dark:text-amber-400/80 leading-relaxed">
                  Si applica a tutti i retrain manuali e deep. I retrain automatici e drift usano sempre i parametri default (velocità prioritaria).
                </p>
              </div>
            )}
          </div>

          <button
            onClick={handleDeepRetrain}
            disabled={retraining || !deepFromDate}
            className={`flex items-center justify-center gap-2 w-full py-2.5 rounded-xl text-[10px] font-bold uppercase tracking-widest transition-all border ${
              retraining || !deepFromDate
                ? 'bg-slate-100 dark:bg-white/5 text-slate-400 dark:text-slate-500 border-slate-200 dark:border-white/10 cursor-not-allowed'
                : 'bg-violet-600 text-white border-transparent hover:bg-violet-700 shadow-md active:scale-[0.98]'
            }`}
          >
            {retraining ? (
              <>
                <svg className="w-3.5 h-3.5 animate-spin" viewBox="0 0 24 24" fill="none">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4l3-3-3-3v4a8 8 0 00-8 8h4z" />
                </svg>
                Deep Training in corso…
              </>
            ) : (
              <>
                <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M12 2L2 7l10 5 10-5-10-5z"/><path d="M2 17l10 5 10-5"/><path d="M2 12l10 5 10-5"/>
                </svg>
                {deepFromDate ? `Deep Train da ${deepFromDate}` : 'Seleziona un periodo'}
              </>
            )}
          </button>
        </div>

        <div className="my-6 border-t border-slate-100 dark:border-white/5" />

        {/* auto_retrain_enabled */}
        <div className="flex flex-col gap-3 mb-6 pb-6 border-b border-slate-100 dark:border-white/5">
          <Tooltip text="Se attivo, il bot esegue automaticamente il retrain ogni N cicli usando le ultime 500 candele. Se disattivato, il retrain automatico non avviene e al raggiungimento del limite cicli compare un avviso in Monitor per ricordarti di eseguire un retrain manuale profondo (5 anni + Optuna)." width="wide" pos="bottom">
            <label className="flex items-center gap-3 cursor-pointer group w-fit">
              <div className="relative">
                <input
                  type="checkbox"
                  className="sr-only"
                  checked={config.auto_retrain_enabled}
                  onChange={e => setConfig(c => ({ ...c, auto_retrain_enabled: e.target.checked }))}
                />
                <div className={`w-10 h-5 rounded-full transition-all duration-300 ${config.auto_retrain_enabled ? 'bg-indigo-600' : 'bg-slate-200 dark:bg-white/10'}`} />
                <div className={`absolute top-1 left-1 w-3 h-3 bg-white rounded-full shadow-sm transition-transform duration-300 ${config.auto_retrain_enabled ? 'translate-x-5' : ''}`} />
              </div>
              <div>
                <p className={`text-sm font-bold transition-colors ${config.auto_retrain_enabled ? 'text-indigo-600 dark:text-indigo-400' : 'text-slate-800 dark:text-slate-200 group-hover:text-indigo-600 dark:group-hover:text-indigo-400'}`}>
                  Retrain automatico
                  {!config.auto_retrain_enabled && (
                    <span className="ml-2 text-[10px] font-bold uppercase tracking-widest px-1.5 py-0.5 rounded bg-amber-100 dark:bg-amber-500/15 text-amber-700 dark:text-amber-400">
                      Manuale
                    </span>
                  )}
                </p>
                <p className="text-[10px] text-slate-400 dark:text-slate-500 leading-relaxed mt-0.5">
                  {config.auto_retrain_enabled
                    ? 'Il modello si riaddestra automaticamente ogni N cicli.'
                    : 'Nessun retrain automatico. Il Monitor mostrerà un avviso quando scade il countdown.'}
                </p>
              </div>
            </label>
          </Tooltip>
        </div>

        {/* retrain_every_n_cycles */}
        <div className="space-y-2 mb-6">
          <div className="flex items-center justify-between">
            <Tooltip text="Numero di cicli 4H tra un retrain e il successivo. Valori bassi (30–40) permettono al modello di adattarsi più rapidamente ai cambi di regime ma aumentano il carico computazionale sul server." width="wide" pos="bottom">
              <span className="text-[10px] font-bold text-slate-600 dark:text-slate-400 uppercase tracking-widest cursor-help">
                Frequenza retrain
              </span>
            </Tooltip>
            <span className="font-mono text-sm font-bold text-indigo-600 dark:text-indigo-400">
              ogni {config.retrain_every_n_cycles} cicli
              <span className="text-[10px] font-normal text-slate-400 dark:text-slate-500 ml-1">
                (≈{Math.round(config.retrain_every_n_cycles / 6)} giorni)
              </span>
            </span>
          </div>
          <input
            type="range" min={20} max={120} step={10}
            value={config.retrain_every_n_cycles}
            onChange={e => setConfig(c => ({ ...c, retrain_every_n_cycles: parseInt(e.target.value) }))}
            className="w-full h-1.5 rounded-full appearance-none cursor-pointer bg-slate-200 dark:bg-white/15 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-3.5 [&::-webkit-slider-thumb]:h-3.5 [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-indigo-500 [&::-webkit-slider-thumb]:shadow-sm [&::-webkit-slider-thumb]:cursor-pointer [&::-moz-range-thumb]:w-3.5 [&::-moz-range-thumb]:h-3.5 [&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:bg-indigo-500 [&::-moz-range-thumb]:border-0"
          />
          <div className="flex justify-between text-[9px] font-mono text-slate-400 dark:text-slate-500">
            <span>20 (≈3gg)</span><span>60 (≈10gg)</span><span>120 (≈20gg)</span>
          </div>
          <p className="text-[10px] text-slate-400 dark:text-slate-500 leading-relaxed">
            Default 120. Abbassa a 30–40 per adattarti più velocemente ai nuovi regimi. Il bot non si interrompe durante il retrain.
          </p>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-6 pt-4 border-t border-slate-100 dark:border-white/5">
          {/* wf_n_splits */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Tooltip text="Numero di fold nella walk-forward cross-validation temporale. Più fold = stima OOS più robusta ma retrain più lento. Con 500 candele e 8 fold, ogni window di validazione copre ~30 candele 4H (~5 giorni)." width="wide" pos="bottom">
                <span className="text-[10px] font-bold text-slate-600 dark:text-slate-400 uppercase tracking-widest cursor-help">
                  Fold walk-forward
                </span>
              </Tooltip>
              <span className="font-mono text-sm font-bold text-indigo-600 dark:text-indigo-400">
                {config.wf_n_splits} fold
              </span>
            </div>
            <input
              type="range" min={3} max={12} step={1}
              value={config.wf_n_splits}
              onChange={e => setConfig(c => ({ ...c, wf_n_splits: parseInt(e.target.value) }))}
              className="w-full h-1.5 rounded-full appearance-none cursor-pointer bg-slate-200 dark:bg-white/15 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-3.5 [&::-webkit-slider-thumb]:h-3.5 [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-indigo-500 [&::-webkit-slider-thumb]:shadow-sm [&::-webkit-slider-thumb]:cursor-pointer [&::-moz-range-thumb]:w-3.5 [&::-moz-range-thumb]:h-3.5 [&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:bg-indigo-500 [&::-moz-range-thumb]:border-0"
            />
            <div className="flex justify-between text-[9px] font-mono text-slate-400 dark:text-slate-500">
              <span>3</span><span>7</span><span>12</span>
            </div>
          </div>

          {/* wf_purge_gap */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Tooltip text="Candele 4H escluse tra la fine del training set e l'inizio del validation set in ogni fold. Elimina l'autocorrelazione temporale (look-ahead bias). Alzare in mercati molto trending o con alta persistenza della volatilità." width="wide" pos="bottom">
                <span className="text-[10px] font-bold text-slate-600 dark:text-slate-400 uppercase tracking-widest cursor-help">
                  Purge gap
                </span>
              </Tooltip>
              <span className="font-mono text-sm font-bold text-indigo-600 dark:text-indigo-400">
                {config.wf_purge_gap} candele
                <span className="text-[10px] font-normal text-slate-400 dark:text-slate-500 ml-1">
                  ({config.wf_purge_gap * 4}h)
                </span>
              </span>
            </div>
            <input
              type="range" min={2} max={20} step={1}
              value={config.wf_purge_gap}
              onChange={e => setConfig(c => ({ ...c, wf_purge_gap: parseInt(e.target.value) }))}
              className="w-full h-1.5 rounded-full appearance-none cursor-pointer bg-slate-200 dark:bg-white/15 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-3.5 [&::-webkit-slider-thumb]:h-3.5 [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-indigo-500 [&::-webkit-slider-thumb]:shadow-sm [&::-webkit-slider-thumb]:cursor-pointer [&::-moz-range-thumb]:w-3.5 [&::-moz-range-thumb]:h-3.5 [&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:bg-indigo-500 [&::-moz-range-thumb]:border-0"
            />
            <div className="flex justify-between text-[9px] font-mono text-slate-400 dark:text-slate-500">
              <span>2 (8h)</span><span>10 (40h)</span><span>20 (80h)</span>
            </div>
          </div>
        </div>

        {/* Recommended settings hint */}
        {(config.retrain_every_n_cycles === 120 && config.wf_n_splits === 5 && config.wf_purge_gap === 5) && (
          <div className="mt-4 flex items-start gap-2 bg-slate-50 dark:bg-white/[0.03] border border-slate-100 dark:border-white/8 rounded-xl px-4 py-3">
            <svg className="w-4 h-4 text-slate-400 dark:text-slate-500 flex-shrink-0 mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
            <p className="text-[10px] text-slate-400 dark:text-slate-500 leading-relaxed">
              Stai usando i valori di default. Per un adattamento più aggressivo ai regimi: <span className="font-mono font-bold">retrain=40 · fold=8 · gap=8</span>
            </p>
          </div>
        )}
        <div className="my-6 border-t border-slate-100 dark:border-white/5" />
        {/* Toggle */}
        <div className={`flex flex-col gap-3 mb-6 pb-6 border-b transition-colors duration-200 ${config.use_1h_lgbm_gate ? 'border-violet-200 dark:border-violet-500/25' : 'border-slate-100 dark:border-white/5'}`}>
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
            <Tooltip
              text="Quando attivo, ogni segnale 4H (long/short) viene filtrato dal modello 1H: se P(direzione)_1H ≥ min_agreement → confermato; se block_threshold ≤ P < min_agreement → permesso con size ×0.70; se P < block_threshold → bloccato. Fail-safe: se il modello 1H non esiste o si verifica un errore, il trade procede normalmente senza il gate."
              width="wide"
              pos="bottom"
            >
              <label className="flex items-center gap-3 cursor-pointer group">
                <div className="relative">
                  <input
                    type="checkbox"
                    className="sr-only"
                    checked={config.use_1h_lgbm_gate}
                    onChange={e => setConfig(c => ({ ...c, use_1h_lgbm_gate: e.target.checked }))}
                  />
                  <div className={`w-10 h-5 rounded-full transition-all duration-300 ${config.use_1h_lgbm_gate ? 'bg-violet-600' : 'bg-slate-200 dark:bg-white/10'}`} />
                  <div className={`absolute top-1 left-1 w-3 h-3 bg-white rounded-full shadow-sm transition-transform duration-300 ${config.use_1h_lgbm_gate ? 'translate-x-5' : ''}`} />
                </div>
                <div>
                  <p className={`text-sm font-bold transition-colors ${config.use_1h_lgbm_gate ? 'text-violet-600 dark:text-violet-400' : 'text-slate-800 dark:text-slate-200 group-hover:text-violet-600 dark:group-hover:text-violet-400'}`}>
                    Abilita Gate LightGBM 1H
                    {config.use_1h_lgbm_gate && (
                      <span className="ml-2 px-1.5 py-0.5 rounded text-[9px] font-bold bg-violet-100 dark:bg-violet-500/20 text-violet-600 dark:text-violet-400 uppercase tracking-wider">Attivo</span>
                    )}
                  </p>
                  <p className="text-[11px] font-medium text-slate-400 dark:text-slate-500 leading-tight">
                    {config.use_1h_lgbm_gate ? 'Segnali 4H filtrati da conferma 1H — tre fasce: block / reduce ×0.70 / pass' : 'Filtra i segnali 4H con un modello LightGBM su candele orarie'}
                  </p>
                </div>
              </label>
            </Tooltip>

            {/* Model status + Train button */}
            <div className="flex items-center gap-2 flex-shrink-0 sm:flex-row">
              <div className="flex items-center gap-1.5">
                <div className={`w-2 h-2 rounded-full ${lgbm1hLoaded === true ? 'bg-emerald-500' : lgbm1hLoaded === false ? 'bg-rose-400' : 'bg-slate-300 dark:bg-slate-600'}`} />
                <span className="text-[10px] font-medium text-slate-500 dark:text-slate-400">
                  {lgbm1hLoaded === true ? 'Modello caricato' : lgbm1hLoaded === false ? 'Non addestrato' : '—'}
                </span>
              </div>
              <Tooltip text="Addestra il modello LightGBM 1H su 2000 candele orarie (feature identiche al modello 4H, target: close[+1] > close[0] su 1H). Il processo dura 20–60s e non interrompe il bot. Dopo il primo addestramento, verrà ri-addestrato automaticamente ad ogni retrain 4H quando il gate è attivo." width="wide" pos="top">
                <button
                  onClick={handleRetrain1h}
                  disabled={lgbm1hRetraining}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[11px] font-bold bg-violet-600 hover:bg-violet-700 disabled:opacity-50 disabled:cursor-not-allowed text-white transition-colors sm:flex-shrink-0"
                >
                  {lgbm1hRetraining ? (
                    <svg className="w-3 h-3 animate-spin" fill="none" viewBox="0 0 24 24">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z"/>
                    </svg>
                  ) : (
                    <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z" />
                    </svg>
                  )}
                  {lgbm1hRetraining ? 'Addestro…' : lgbm1hLoaded ? 'Ri-addestra 1H' : 'Addestra 1H'}
                </button>
              </Tooltip>
            </div>
          </div>

          {/* Retrain result */}
          {lgbm1hResult && (
            <div className={`flex items-center gap-3 px-3 py-2 rounded-lg text-[11px] font-medium border ${
              lgbm1hResult.status === 'ok'
                ? 'bg-violet-50 dark:bg-violet-500/10 border-violet-200 dark:border-violet-500/30 text-violet-700 dark:text-violet-400'
                : 'bg-rose-50 dark:bg-rose-500/10 border-rose-200 dark:border-rose-500/30 text-rose-700 dark:text-rose-400'
            }`}>
              {lgbm1hResult.status === 'ok' ? (
                <>
                  <span>✓ Modello 1H addestrato</span>
                  <span className="text-slate-400 dark:text-slate-500">·</span>
                  <span>OOS acc <span className="font-bold font-mono">{lgbm1hResult.oos_accuracy !== undefined ? `${(lgbm1hResult.oos_accuracy * 100).toFixed(1)}%` : '—'}</span></span>
                  <span className="text-slate-400 dark:text-slate-500">·</span>
                  <span>{lgbm1hResult.n_features} feature</span>
                  <span className="text-slate-400 dark:text-slate-500">·</span>
                  <span>{lgbm1hResult.elapsed_s}s</span>
                </>
              ) : (
                <span>✕ Errore durante l'addestramento del modello 1H</span>
              )}
            </div>
          )}
        </div>

        {/* Threshold sliders — only shown when gate is enabled */}
        {config.use_1h_lgbm_gate && (
          <div className="space-y-6">
            {/* Min agreement */}
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <Tooltip
                  text="Probabilità minima P(direzione)_1H per confermare il trade a size piena. Se P(direzione) è tra block_threshold e questo valore, il trade viene permesso con size ridotta al 70%. Deve essere > block_threshold. Valore consigliato per iniziare: 52%."
                  width="wide"
                  pos="bottom"
                >
                  <span className="text-[10px] font-bold text-slate-600 dark:text-slate-400 uppercase tracking-widest cursor-help">
                    Accordo minimo 1H
                  </span>
                </Tooltip>
                <span className="font-mono text-sm font-bold text-violet-600 dark:text-violet-400">
                  {(config.lgbm_1h_min_agreement * 100).toFixed(0)}%
                  <span className="text-[10px] font-normal text-slate-400 dark:text-slate-500 ml-1">→ size piena</span>
                </span>
              </div>
              <input
                type="range" min={50} max={70} step={1}
                value={Math.round(config.lgbm_1h_min_agreement * 100)}
                onChange={e => setConfig(c => ({ ...c, lgbm_1h_min_agreement: parseInt(e.target.value) / 100 }))}
                className="w-full h-1.5 rounded-full appearance-none cursor-pointer bg-slate-200 dark:bg-white/15 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-3.5 [&::-webkit-slider-thumb]:h-3.5 [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-violet-500 [&::-webkit-slider-thumb]:shadow-sm [&::-webkit-slider-thumb]:cursor-pointer [&::-moz-range-thumb]:w-3.5 [&::-moz-range-thumb]:h-3.5 [&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:bg-violet-500 [&::-moz-range-thumb]:border-0"
              />
              <div className="flex justify-between text-[9px] font-mono text-slate-400 dark:text-slate-500">
                <span>50%</span><span>60%</span><span>70%</span>
              </div>
            </div>

            {/* Block threshold */}
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <Tooltip
                  text="Se P(direzione)_1H scende sotto questa soglia, il trade viene bloccato completamente (no_trade). Deve essere < accordo minimo. Valore consigliato per iniziare: 42–45%. Abbassare se il gate blocca troppi segnali (>30%)."
                  width="wide"
                  pos="bottom"
                >
                  <span className="text-[10px] font-bold text-slate-600 dark:text-slate-400 uppercase tracking-widest cursor-help">
                    Soglia di blocco 1H
                  </span>
                </Tooltip>
                <span className="font-mono text-sm font-bold text-rose-500 dark:text-rose-400">
                  {(config.lgbm_1h_block_threshold * 100).toFixed(0)}%
                  <span className="text-[10px] font-normal text-slate-400 dark:text-slate-500 ml-1">→ trade bloccato</span>
                </span>
              </div>
              <input
                type="range" min={30} max={50} step={1}
                value={Math.round(config.lgbm_1h_block_threshold * 100)}
                onChange={e => setConfig(c => ({ ...c, lgbm_1h_block_threshold: parseInt(e.target.value) / 100 }))}
                className="w-full h-1.5 rounded-full appearance-none cursor-pointer bg-slate-200 dark:bg-white/15 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-3.5 [&::-webkit-slider-thumb]:h-3.5 [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-rose-500 [&::-webkit-slider-thumb]:shadow-sm [&::-webkit-slider-thumb]:cursor-pointer [&::-moz-range-thumb]:w-3.5 [&::-moz-range-thumb]:h-3.5 [&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:bg-rose-500 [&::-moz-range-thumb]:border-0"
              />
              <div className="flex justify-between text-[9px] font-mono text-slate-400 dark:text-slate-500">
                <span>30%</span><span>40%</span><span>50%</span>
              </div>
            </div>

            {/* Visual bands summary */}
            <div className="bg-slate-50 dark:bg-white/[0.03] border border-slate-100 dark:border-white/8 rounded-xl px-4 py-3">
              <p className="text-[10px] font-bold text-slate-500 dark:text-slate-400 uppercase tracking-widest mb-2">Fasce attive</p>
              <div className="space-y-1.5">
                <div className="flex items-center gap-2">
                  <div className="w-2.5 h-2.5 rounded-full bg-emerald-500 flex-shrink-0" />
                  <span className="text-[11px] text-slate-600 dark:text-slate-300">
                    P ≥ <span className="font-mono font-bold">{(config.lgbm_1h_min_agreement * 100).toFixed(0)}%</span>
                    <span className="text-slate-400 dark:text-slate-500 ml-2">→ Trade confermato, size piena</span>
                  </span>
                </div>
                <div className="flex items-center gap-2">
                  <div className="w-2.5 h-2.5 rounded-full bg-amber-400 flex-shrink-0" />
                  <span className="text-[11px] text-slate-600 dark:text-slate-300">
                    <span className="font-mono font-bold">{(config.lgbm_1h_block_threshold * 100).toFixed(0)}%</span>
                    <span className="text-slate-400 dark:text-slate-500 mx-1">≤ P &lt;</span>
                    <span className="font-mono font-bold">{(config.lgbm_1h_min_agreement * 100).toFixed(0)}%</span>
                    <span className="text-slate-400 dark:text-slate-500 ml-2">→ Permesso, size ×0.70</span>
                  </span>
                </div>
                <div className="flex items-center gap-2">
                  <div className="w-2.5 h-2.5 rounded-full bg-rose-500 flex-shrink-0" />
                  <span className="text-[11px] text-slate-600 dark:text-slate-300">
                    P &lt; <span className="font-mono font-bold">{(config.lgbm_1h_block_threshold * 100).toFixed(0)}%</span>
                    <span className="text-slate-400 dark:text-slate-500 ml-2">→ Trade bloccato</span>
                  </span>
                </div>
              </div>
              {config.lgbm_1h_block_threshold >= config.lgbm_1h_min_agreement && (
                <div className="mt-2 text-[10px] font-bold text-amber-600 dark:text-amber-400">
                  ⚠ Soglia di blocco ≥ accordo minimo: la fascia "reduce" scompare. Abbassa il blocco o alza l'accordo.
                </div>
              )}
            </div>

            <p className="text-[10px] text-slate-400 dark:text-slate-500 leading-relaxed">
              Avvia con valori conservativi <span className="font-mono">accordo=52% · blocco=42%</span>. Monitora: se il gate blocca &gt;30% dei segnali abbassa il blocco; se blocca &lt;10% alzalo. Dopo validazione live, considera il punto 5 (estensione backtest).
            </p>
          </div>
        )}
      </Section>

      {/* Model Version Registry */}
      <Section
        title="Versioni Modello LightGBM"
        description="Storico dei modelli addestrati con metriche OOS. Puoi fare rollback a qualsiasi versione precedente — il bot ricarica il modello automaticamente senza riavvio."
      >
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <button
              onClick={() => { setRegistryOpen((o: boolean) => !o); if (!registryOpen) loadModelRegistry(); }}
              className="flex items-center gap-2 text-[11px] font-bold text-slate-600 dark:text-slate-400 uppercase tracking-widest hover:text-indigo-600 dark:hover:text-indigo-400 transition-colors"
            >
              <span className={`transition-transform duration-200 ${registryOpen ? 'rotate-90' : ''}`}>▶</span>
              {registryOpen ? 'Nascondi' : 'Mostra'} versioni ({modelRegistry.length})
            </button>
            <button
              onClick={loadModelRegistry}
              className="text-[10px] font-medium text-slate-400 dark:text-slate-500 hover:text-indigo-500 dark:hover:text-indigo-400 transition-colors"
            >
              ↻ Aggiorna
            </button>
          </div>

          {registryOpen && (
            <div className="space-y-2">
              {modelRegistry.length === 0 ? (
                <p className="text-[11px] text-slate-400 dark:text-slate-500 py-3 text-center">
                  Nessun modello nel registry. Esegui un retrain per iniziare a tracciare le versioni.
                </p>
              ) : (
                [...modelRegistry].reverse().map((entry, idx) => {
                  const isLatest = idx === 0;
                  const date = new Date(entry.trained_at);
                  const dateStr = date.toLocaleDateString('it-IT', { day: '2-digit', month: '2-digit', year: '2-digit' });
                  const timeStr = date.toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' });
                  return (
                    <div
                      key={entry.filename}
                      className={`flex items-center gap-3 px-3 py-2.5 rounded-lg border text-[11px] transition-colors ${
                        isLatest
                          ? 'bg-indigo-50 dark:bg-indigo-500/10 border-indigo-200 dark:border-indigo-500/30'
                          : 'bg-slate-50 dark:bg-white/[0.03] border-slate-100 dark:border-white/8'
                      }`}
                    >
                      {/* Date/time */}
                      <div className="flex-shrink-0 text-center min-w-[52px]">
                        <div className={`font-mono font-bold ${isLatest ? 'text-indigo-600 dark:text-indigo-400' : 'text-slate-700 dark:text-slate-300'}`}>{dateStr}</div>
                        <div className="text-[10px] text-slate-400 dark:text-slate-500 font-mono">{timeStr}</div>
                      </div>

                      <div className="w-px h-7 bg-slate-200 dark:bg-white/10 flex-shrink-0" />

                      {/* Metrics */}
                      <div className="flex-1 flex items-center gap-3 flex-wrap">
                        {entry.oos_accuracy !== undefined && (
                          <span className={`font-mono font-bold ${entry.oos_accuracy >= 0.55 ? 'text-emerald-600 dark:text-emerald-400' : entry.oos_accuracy >= 0.50 ? 'text-amber-500 dark:text-amber-400' : 'text-rose-500 dark:text-rose-400'}`}>
                            {(entry.oos_accuracy * 100).toFixed(1)}%
                            <span className="text-[9px] font-normal text-slate-400 dark:text-slate-500 ml-0.5">OOS</span>
                          </span>
                        )}
                        {entry.oos_log_loss !== undefined && (
                          <span className="text-slate-500 dark:text-slate-400 font-mono">
                            LL <span className="font-bold">{entry.oos_log_loss.toFixed(3)}</span>
                          </span>
                        )}
                        {entry.n_features !== undefined && (
                          <span className="text-slate-400 dark:text-slate-500">{entry.n_features} feat</span>
                        )}
                        {entry.train_rows !== undefined && (
                          <span className="text-slate-400 dark:text-slate-500">{entry.train_rows} bar</span>
                        )}
                        {entry.neutral_excluded_pct !== undefined && (
                          <span className="text-slate-400 dark:text-slate-500">{entry.neutral_excluded_pct.toFixed(0)}% neutri</span>
                        )}
                      </div>

                      {/* Badge + rollback */}
                      <div className="flex items-center gap-2 flex-shrink-0">
                        {isLatest && (
                          <span className="px-1.5 py-0.5 rounded text-[9px] font-bold bg-indigo-100 dark:bg-indigo-500/20 text-indigo-600 dark:text-indigo-400 uppercase tracking-wider">
                            Attivo
                          </span>
                        )}
                        {!isLatest && (
                          <button
                            onClick={() => handleRollback(entry.filename)}
                            disabled={rollingBack !== null}
                            className="px-2 py-1 rounded text-[10px] font-bold bg-slate-100 dark:bg-white/8 text-slate-600 dark:text-slate-300 hover:bg-indigo-100 dark:hover:bg-indigo-500/20 hover:text-indigo-600 dark:hover:text-indigo-400 border border-slate-200 dark:border-white/10 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                          >
                            {rollingBack === entry.filename ? '…' : '↩ Rollback'}
                          </button>
                        )}
                      </div>
                    </div>
                  );
                })
              )}
              <p className="text-[10px] text-slate-400 dark:text-slate-500 leading-relaxed pt-1">
                Max 10 versioni conservate. Dopo il rollback, il bot ricarica il modello senza interruzioni. Per tornare all'ultima versione, esegui un nuovo retrain.
              </p>
            </div>
          )}
        </div>
      </Section>

      {/* Feature Importance Pruning */}
      <Section
        title="Feature Importance Pruning LightGBM"
        description="Addestra un secondo modello con solo le feature più informative (gain normalizzato ≥ soglia). Riduce il rumore e il rischio di overfitting. Richiede un retrain manuale per generare lgbm_pruned.pkl."
      >
        {/* Toggle */}
        <div className={`flex flex-col gap-3 mb-6 pb-6 border-b transition-colors duration-200 ${config.use_feature_pruning ? 'border-purple-200 dark:border-purple-500/25' : 'border-slate-100 dark:border-white/5'}`}>
          <Tooltip text="Quando attivo, il bot carica lgbm_pruned.pkl invece di lgbm_latest.pkl — un secondo modello LightGBM addestrato solo sulle feature con gain normalizzato ≥ soglia, scartando quelle irrilevanti. Riduce il rischio di overfitting e può migliorare la generalizzazione. Richiede almeno un retrain con pruning abilitato per generare il file." width="wide" pos="bottom">
          <label className="flex items-center gap-3 cursor-pointer group">
            <div className="relative">
              <input
                type="checkbox"
                className="sr-only"
                checked={config.use_feature_pruning}
                onChange={e => setConfig(c => ({ ...c, use_feature_pruning: e.target.checked }))}
              />
              <div className={`w-10 h-5 rounded-full transition-all duration-300 ${config.use_feature_pruning ? 'bg-purple-600' : 'bg-slate-200 dark:bg-white/10'}`} />
              <div className={`absolute top-1 left-1 w-3 h-3 bg-white rounded-full shadow-sm transition-transform duration-300 ${config.use_feature_pruning ? 'translate-x-5' : ''}`} />
            </div>
            <div>
              <p className={`text-sm font-bold transition-colors ${config.use_feature_pruning ? 'text-purple-600 dark:text-purple-400' : 'text-slate-800 dark:text-slate-200 group-hover:text-purple-600 dark:group-hover:text-purple-400'}`}>
                Usa Modello Pruned
                {config.use_feature_pruning && (
                  <span className="ml-2 px-1.5 py-0.5 rounded text-[9px] font-bold bg-purple-100 dark:bg-purple-500/20 text-purple-600 dark:text-purple-400 uppercase tracking-wider">Attivo</span>
                )}
              </p>
              <p className="text-[11px] font-medium text-slate-400 dark:text-slate-500 leading-tight">
                {config.use_feature_pruning
                  ? 'Il bot userà lgbm_pruned.pkl — modello con feature ridotte per meno overfitting'
                  : 'Il bot usa lgbm_latest.pkl con tutte le feature (comportamento default)'}
              </p>
            </div>
          </label>
          </Tooltip>
        </div>

        {/* Threshold slider — shown always so user can configure before enabling */}
        <div className="space-y-2 mb-4">
          <div className="flex items-center justify-between">
            <Tooltip
              text="Feature con importanza gain normalizzata sotto questa soglia vengono rimosse dal modello pruned. 0.5% è conservativo e sicuro. Alzare a 1% per un pruning più aggressivo."
              width="wide"
              pos="bottom"
            >
              <span className="text-[10px] font-bold text-slate-600 dark:text-slate-400 uppercase tracking-widest cursor-help">
                Importanza minima feature
              </span>
            </Tooltip>
            <span className="font-mono text-sm font-bold text-purple-600 dark:text-purple-400">
              {(config.feature_pruning_min_importance * 100).toFixed(1)}%
            </span>
          </div>
          <input
            type="range" min={0.001} max={0.05} step={0.001}
            value={config.feature_pruning_min_importance}
            onChange={e => setConfig(c => ({ ...c, feature_pruning_min_importance: parseFloat(e.target.value) }))}
            className="w-full h-1.5 rounded-full appearance-none cursor-pointer bg-slate-200 dark:bg-white/15 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-3.5 [&::-webkit-slider-thumb]:h-3.5 [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-purple-500 [&::-webkit-slider-thumb]:shadow-sm [&::-webkit-slider-thumb]:cursor-pointer [&::-moz-range-thumb]:w-3.5 [&::-moz-range-thumb]:h-3.5 [&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:bg-purple-500 [&::-moz-range-thumb]:border-0"
          />
          <div className="flex justify-between text-[9px] font-mono text-slate-400 dark:text-slate-500">
            <span>0.1% (conserv.)</span><span>0.5% (default)</span><span>5.0% (aggressivo)</span>
          </div>
          <p className="text-[10px] text-slate-400 dark:text-slate-500 leading-relaxed">
            Con 56 feature e soglia 0.5% restano tipicamente 30–40 feature. Controllare <span className="font-mono">GET /model/pruning-stats</span> dopo il retrain.
          </p>
        </div>

        {/* Pruning live preview — counts from featImportance, accuracy from last retrain */}
        {featImportance?.available && featImportance.features && (() => {
          const allEntries = Object.entries(featImportance.features) as [string, number][];
          const threshold  = config.feature_pruning_min_importance;
          const liveKept   = allEntries.filter(([, v]) => v >= threshold).length;
          const liveRemoved = allEntries.length - liveKept;
          // Prefer live retrain result (session), fall back to disk stats (survives reload)
          const pruning    = retrainResult?.pruning?.status === 'ok'
            ? retrainResult.pruning
            : pruningStats?.status === 'ok' ? pruningStats : null;
          const delta      = pruning?.accuracy_delta;

          return (
            <div className="mt-2 bg-purple-50 dark:bg-purple-500/10 border border-purple-200 dark:border-purple-500/30 rounded-xl px-4 py-3">
              <div className="flex items-center justify-between mb-2">
                <p className="text-[10px] font-bold text-purple-700 dark:text-purple-400 uppercase tracking-widest">
                  Anteprima soglia corrente
                </p>
                {pruning && (
                  <span className="text-[9px] text-purple-500 dark:text-purple-400 font-mono">
                    acc full e delta dall'ultimo retrain
                  </span>
                )}
              </div>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                {/* Feature kept — LIVE from slider */}
                <Tooltip text="Feature che superano la soglia corrente — verranno incluse nel modello pruned. Il conteggio si aggiorna in tempo reale muovendo lo slider." pos="top">
                <div className="bg-white dark:bg-purple-500/10 rounded-lg px-3 py-2 text-center cursor-help">
                  <p className="text-[9px] font-bold text-purple-500 dark:text-purple-400 uppercase tracking-widest mb-0.5">Feature kept</p>
                  <p className="text-sm font-bold font-mono text-purple-800 dark:text-purple-200">{liveKept}</p>
                </div>
                </Tooltip>
                {/* Rimosse — LIVE from slider */}
                <Tooltip text="Feature con gain normalizzato sotto soglia — escluse dal modello pruned. Più feature rimosse = modello più semplice. Controlla Acc delta per verificare l'impatto sulla precisione." pos="top">
                <div className="bg-white dark:bg-purple-500/10 rounded-lg px-3 py-2 text-center cursor-help">
                  <p className="text-[9px] font-bold text-purple-500 dark:text-purple-400 uppercase tracking-widest mb-0.5">Rimosse</p>
                  <p className="text-sm font-bold font-mono text-purple-800 dark:text-purple-200">{liveRemoved}</p>
                </div>
                </Tooltip>
                {/* Acc full — static from last retrain */}
                <Tooltip text="Accuratezza out-of-sample del modello completo (tutte le feature) sull'ultimo retrain — calcolata sul 20% finale del dataset. È il valore di riferimento per confrontare il modello pruned." pos="top">
                <div className="bg-white dark:bg-purple-500/10 rounded-lg px-3 py-2 text-center cursor-help">
                  <p className="text-[9px] font-bold text-purple-500 dark:text-purple-400 uppercase tracking-widest mb-0.5">Acc full</p>
                  <p className="text-sm font-bold font-mono text-purple-800 dark:text-purple-200">
                    {pruning?.full_accuracy !== undefined ? `${(pruning.full_accuracy * 100).toFixed(1)}%` : '—'}
                  </p>
                </div>
                </Tooltip>
                {/* Acc delta — static from last retrain */}
                <Tooltip text="Differenza di accuratezza tra modello pruned e modello completo (pruned − full). Verde = pruning neutro o migliorativo. Arancione = degradazione &gt;1% — abbassa la soglia e rifai il retrain." pos="top">
                <div className="bg-white dark:bg-purple-500/10 rounded-lg px-3 py-2 text-center cursor-help">
                  <p className="text-[9px] font-bold text-purple-500 dark:text-purple-400 uppercase tracking-widest mb-0.5">Acc delta</p>
                  <p className={`text-sm font-bold font-mono ${
                    delta === undefined ? 'text-purple-800 dark:text-purple-200'
                    : delta >= 0 ? 'text-emerald-600 dark:text-emerald-400'
                    : delta < -0.01 ? 'text-amber-600 dark:text-amber-400'
                    : 'text-purple-800 dark:text-purple-200'
                  }`}>
                    {delta !== undefined ? `${delta >= 0 ? '+' : ''}${(delta * 100).toFixed(2)}%` : '—'}
                  </p>
                </div>
                </Tooltip>
              </div>
              {/* Verdict based on last retrain delta */}
              {delta !== undefined && Math.abs(delta) < 0.005 && (
                <p className="text-[10px] text-purple-600 dark:text-purple-400 mt-2 font-medium">
                  Delta &lt;0.5% — pruning sicuro con questa soglia. Attiva il toggle e salva.
                </p>
              )}
              {delta !== undefined && delta < -0.01 && (
                <p className="text-[10px] text-amber-600 dark:text-amber-400 mt-2 font-medium">
                  Peggioramento &gt;1% con la soglia usata nell'ultimo retrain. Abbassa la soglia e rifai il retrain.
                </p>
              )}
              {!pruning && (
                <p className="text-[10px] text-slate-400 dark:text-slate-500 mt-2">
                  Acc full e delta disponibili dopo il primo retrain con pruning attivo.
                </p>
              )}
            </div>
          );
        })()}
        {(retrainResult?.pruning?.status ?? pruningStats?.status) === 'skipped' && (
          <div className="mt-2 flex items-start gap-2 bg-amber-50 dark:bg-amber-500/10 border border-amber-200 dark:border-amber-500/30 rounded-xl px-4 py-3">
            <svg className="w-4 h-4 text-amber-500 flex-shrink-0 mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" />
            </svg>
            <p className="text-[11px] text-amber-700 dark:text-amber-400">
              Pruning saltato: troppo poche feature sopravviverebbero alla soglia impostata. Abbassa la soglia e riprova.
            </p>
          </div>
        )}

        {/* Feature Importance Chart */}
        <div className="mt-4 border-t border-slate-100 dark:border-white/5 pt-5">
          <div className="flex items-center justify-between mb-3">
            <span className="text-[10px] font-bold text-slate-600 dark:text-slate-400 uppercase tracking-widest">
              Importanza Feature (ultimo retrain)
            </span>
            <button
              onClick={loadFeatureImportance}
              disabled={featImportanceLoading}
              className="flex items-center gap-1.5 text-[10px] font-bold text-indigo-600 dark:text-indigo-400 hover:text-indigo-500 disabled:opacity-40 transition-colors"
            >
              {featImportanceLoading ? (
                <svg className="w-3 h-3 animate-spin" viewBox="0 0 24 24" fill="none">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4l3-3-3-3v4a8 8 0 00-8 8h4z" />
                </svg>
              ) : (
                <svg className="w-3 h-3" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                </svg>
              )}
              Aggiorna
            </button>
          </div>

          {!featImportance?.available && !featImportanceLoading && (
            <div className="flex items-start gap-2 bg-slate-50 dark:bg-white/[0.03] border border-slate-100 dark:border-white/8 rounded-xl px-4 py-3">
              <svg className="w-4 h-4 text-slate-400 dark:text-slate-500 flex-shrink-0 mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
              <p className="text-[10px] text-slate-400 dark:text-slate-500 leading-relaxed">
                Nessun dato disponibile — esegui un <span className="font-bold">Retrain manuale</span> nella sezione LightGBM per generare la mappa delle importanze.
              </p>
            </div>
          )}

          {featImportanceLoading && (
            <div className="space-y-2">
              {[...Array(8)].map((_, i) => (
                <div key={i} className="flex items-center gap-2">
                  <div className="w-28 h-3 bg-slate-100 dark:bg-white/5 rounded animate-pulse flex-shrink-0" />
                  <div className="flex-1 h-3 bg-slate-100 dark:bg-white/5 rounded animate-pulse" style={{ width: `${30 + Math.random() * 50}%` }} />
                </div>
              ))}
            </div>
          )}

          {featImportance?.available && featImportance.features && !featImportanceLoading && (() => {
            const entries = Object.entries(featImportance.features) as [string, number][];
            const threshold = config.feature_pruning_min_importance;
            const maxVal = entries[0]?.[1] ?? 1;
            const kept   = entries.filter(([, v]) => v >= threshold);
            const pruned = entries.filter(([, v]) => v < threshold);

            return (
              <div>
                {featImportance.trained_at && (
                  <p className="text-[9px] font-mono text-slate-400 dark:text-slate-500 mb-3">
                    Aggiornato: {new Date(featImportance.trained_at).toLocaleString('it-IT', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}
                    {' · '}
                    <span className="text-purple-500 dark:text-purple-400 font-bold">{kept.length} kept</span>
                    {' · '}
                    <span className="text-slate-400">{pruned.length} sotto soglia</span>
                  </p>
                )}

                {/* Bar chart — top 20 features */}
                <div className="space-y-1.5">
                  {entries.slice(0, 20).map(([name, val]) => {
                    const pct     = (val / maxVal) * 100;
                    const isKept  = val >= threshold;
                    const displayPct = (val * 100).toFixed(2);
                    return (
                      <div key={name} className="flex items-center gap-2 group">
                        <span className={`text-[9px] font-mono w-32 flex-shrink-0 truncate text-right ${isKept ? 'text-slate-700 dark:text-slate-300' : 'text-slate-400 dark:text-slate-600'}`}>
                          {name}
                        </span>
                        <div className="flex-1 h-3 bg-slate-100 dark:bg-white/5 rounded-full overflow-hidden">
                          <div
                            className={`h-full rounded-full transition-all ${isKept ? 'bg-purple-500 dark:bg-purple-500' : 'bg-slate-300 dark:bg-white/15'}`}
                            style={{ width: `${pct}%` }}
                          />
                        </div>
                        <span className={`text-[9px] font-mono w-10 text-right flex-shrink-0 ${isKept ? 'text-purple-600 dark:text-purple-400' : 'text-slate-400 dark:text-slate-500'}`}>
                          {displayPct}%
                        </span>
                      </div>
                    );
                  })}
                </div>

                {entries.length > 20 && (
                  <p className="text-[9px] text-slate-400 dark:text-slate-500 mt-2 text-center">
                    + {entries.length - 20} feature non mostrate (tutte sotto soglia)
                  </p>
                )}

                {/* Legend */}
                <div className="flex items-center gap-4 mt-3 pt-3 border-t border-slate-100 dark:border-white/5">
                  <div className="flex items-center gap-1.5">
                    <div className="w-3 h-2 rounded-sm bg-purple-500" />
                    <span className="text-[9px] text-slate-500 dark:text-slate-400">≥ {(threshold * 100).toFixed(1)}% (kept)</span>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <div className="w-3 h-2 rounded-sm bg-slate-300 dark:bg-white/15" />
                    <span className="text-[9px] text-slate-500 dark:text-slate-400">&lt; {(threshold * 100).toFixed(1)}% (rimossa)</span>
                  </div>
                  <span className="text-[9px] text-slate-400 dark:text-slate-500 ml-auto">
                    La soglia si aggiorna in tempo reale allo slider
                  </span>
                </div>
              </div>
            );
          })()}
        </div>

        {/* Workflow hint — only if no data and no pruning result */}
        {!retrainResult?.pruning && !featImportance?.available && (
          <div className="mt-3 flex items-start gap-2 bg-slate-50 dark:bg-white/[0.03] border border-slate-100 dark:border-white/8 rounded-xl px-4 py-3">
            <svg className="w-4 h-4 text-slate-400 dark:text-slate-500 flex-shrink-0 mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
            <p className="text-[10px] text-slate-400 dark:text-slate-500 leading-relaxed">
              Workflow: <span className="font-mono font-bold">1.</span> Esegui Retrain — il grafico si popola automaticamente · <span className="font-mono font-bold">2.</span> Scegli la soglia in base a quante feature vuoi tenere · <span className="font-mono font-bold">3.</span> Abilita il toggle · <span className="font-mono font-bold">4.</span> Salva e ri-fai Retrain per generare <span className="font-mono">lgbm_pruned.pkl</span>
            </p>
          </div>
        )}
      </Section>

      {/* ── Macro Event Pause ──────────────────────────────────────────────── */}
      <Section
        title="Pausa Macro Eventi"
        description="Blocca nuove aperture (e opzionalmente chiude la posizione) durante la finestra di un evento ad alto impatto."
      >
        {/* Master toggle */}
        <div className="flex items-center justify-between mb-5">
          <div>
            <p className="text-xs font-bold text-slate-700 dark:text-slate-200">Attiva Pausa</p>
            <p className="text-[10px] text-slate-400 dark:text-slate-500 mt-0.5">
              Il bot non aprirà nuovi trade durante gli eventi selezionati
            </p>
          </div>
          <button
            onClick={() => setConfig(c => ({ ...c, macro_pause_enabled: !c.macro_pause_enabled }))}
            className={`relative inline-flex h-6 w-11 flex-shrink-0 rounded-full border-2 border-transparent transition-colors duration-200 focus:outline-none ${
              config.macro_pause_enabled ? 'bg-indigo-600' : 'bg-slate-200 dark:bg-slate-700'
            }`}
          >
            <span className={`inline-block h-5 w-5 rounded-full bg-white shadow transform transition-transform duration-200 ${
              config.macro_pause_enabled ? 'translate-x-5' : 'translate-x-0'
            }`} />
          </button>
        </div>

        {config.macro_pause_enabled && (
          <div className="space-y-5">
            {/* Window slider */}
            <div>
              <div className="flex items-center justify-between mb-2">
                <span className="text-[10px] font-bold text-slate-400 dark:text-slate-500 uppercase tracking-widest">
                  Finestra ±{config.macro_pause_window_min} min prima/dopo
                </span>
                <span className="text-xs font-bold font-mono text-indigo-500 dark:text-indigo-400">
                  {config.macro_pause_window_min} min
                </span>
              </div>
              <input
                type="range" min={15} max={180} step={15}
                value={config.macro_pause_window_min}
                onChange={e => setConfig(c => ({ ...c, macro_pause_window_min: parseInt(e.target.value) }))}
                className="w-full accent-indigo-500"
              />
              <div className="flex justify-between text-[9px] font-mono text-slate-400 dark:text-slate-500 mt-1">
                <span>15 min</span><span>1h</span><span>2h</span><span>3h</span>
              </div>
            </div>

            {/* Event sub-toggles */}
            <div>
              <p className="text-[10px] font-bold text-slate-400 dark:text-slate-500 uppercase tracking-widest mb-3">
                Eventi abilitati
              </p>
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                {([
                  { key: 'macro_pause_fomc',  label: 'FOMC',  desc: '8×/anno · 🔴 Alto' },
                  { key: 'macro_pause_cpi',   label: 'CPI',   desc: 'Mensile · 🔴 Alto' },
                  { key: 'macro_pause_nfp',   label: 'NFP',   desc: '1° Ven · 🔴 Alto' },
                  { key: 'macro_pause_ppi',   label: 'PPI',   desc: 'Mensile · 🟡 Medio' },
                  { key: 'macro_pause_jolts', label: 'JOLTS', desc: 'Mensile · 🟡 Medio' },
                ] as Array<{ key: keyof Config; label: string; desc: string }>).map(({ key, label, desc }) => (
                  <button
                    key={key}
                    onClick={() => setConfig(c => ({ ...c, [key]: !c[key] }))}
                    className={`flex flex-col items-start px-3 py-2.5 rounded-xl border text-left transition-all ${
                      config[key]
                        ? 'bg-indigo-50 dark:bg-indigo-500/10 border-indigo-200 dark:border-indigo-500/30 text-indigo-700 dark:text-indigo-400'
                        : 'bg-slate-50 dark:bg-white/5 border-slate-100 dark:border-white/8 text-slate-400 dark:text-slate-500'
                    }`}
                  >
                    <span className="text-xs font-bold">{config[key] ? '✓ ' : ''}{label}</span>
                    <span className="text-[9px] opacity-70 mt-0.5">{desc}</span>
                  </button>
                ))}
              </div>
            </div>

            {/* Position behavior toggle */}
            <div className="bg-slate-50 dark:bg-white/5 rounded-xl p-4 border border-slate-100 dark:border-white/8">
              <p className="text-[10px] font-bold text-slate-400 dark:text-slate-500 uppercase tracking-widest mb-3">
                Gestione posizione aperta
              </p>
              <div className="flex flex-col gap-2">
                {[
                  { val: false, label: 'Blocca solo nuove aperture', desc: 'La posizione esistente rimane aperta — SL/TP gestiti normalmente' },
                  { val: true,  label: 'Chiudi anche la posizione aperta', desc: '⚠ Chiusura immediata alla prima rilevazione della finestra evento' },
                ].map(({ val, label, desc }) => (
                  <button
                    key={String(val)}
                    onClick={() => setConfig(c => ({ ...c, macro_pause_close_position: val }))}
                    className={`flex items-start gap-3 px-3 py-2.5 rounded-xl border text-left transition-all ${
                      config.macro_pause_close_position === val
                        ? val
                          ? 'bg-amber-50 dark:bg-amber-500/10 border-amber-300 dark:border-amber-500/30'
                          : 'bg-emerald-50 dark:bg-emerald-500/10 border-emerald-200 dark:border-emerald-500/30'
                        : 'bg-slate-50 dark:bg-white/5 border-slate-100 dark:border-white/8 opacity-50'
                    }`}
                  >
                    <span className={`mt-0.5 w-3.5 h-3.5 rounded-full border-2 flex-shrink-0 ${
                      config.macro_pause_close_position === val
                        ? val ? 'border-amber-500 bg-amber-500' : 'border-emerald-500 bg-emerald-500'
                        : 'border-slate-300 dark:border-slate-600'
                    }`} />
                    <div>
                      <p className="text-xs font-bold text-slate-700 dark:text-slate-200">{label}</p>
                      <p className="text-[10px] text-slate-400 dark:text-slate-500 mt-0.5">{desc}</p>
                    </div>
                  </button>
                ))}
              </div>
            </div>

            {/* Upcoming events preview */}
            <div>
              <p className="text-[10px] font-bold text-slate-400 dark:text-slate-500 uppercase tracking-widest mb-2">
                Prossimi eventi (60 giorni)
              </p>
              {macroEventsLoading ? (
                <p className="text-[10px] text-slate-400 dark:text-slate-500 font-mono animate-pulse">Caricamento…</p>
              ) : macroEvents && macroEvents.length > 0 ? (
                <div className="space-y-1.5">
                  {(() => {
                    const typeMap: Record<string, keyof Config> = {
                      fomc: 'macro_pause_fomc', cpi: 'macro_pause_cpi',
                      nfp: 'macro_pause_nfp',  ppi: 'macro_pause_ppi',
                      jolts: 'macro_pause_jolts',
                    };
                    return macroEvents.slice(0, 6).map((e, i) => {
                      const enabled = config[typeMap[e.type]] as boolean;
                      const dt = new Date(e.datetime_utc);
                      return (
                        <div key={i} className={`flex items-center justify-between px-3 py-2 rounded-lg border text-[10px] font-mono transition-opacity ${
                          enabled
                            ? 'bg-rose-50 dark:bg-rose-500/8 border-rose-100 dark:border-rose-500/20'
                            : 'bg-slate-50 dark:bg-white/5 border-slate-100 dark:border-white/8 opacity-35'
                        }`}>
                          <span className="font-bold text-slate-700 dark:text-slate-200">
                            {enabled ? '' : '✗ '}{e.name}
                          </span>
                          <span className="text-slate-500 dark:text-slate-400">
                            {dt.toLocaleDateString('it-IT', { day: '2-digit', month: 'short', timeZone: 'UTC' })}{' '}
                            {dt.toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit', timeZone: 'UTC' })} UTC
                          </span>
                          <span className={`font-bold ${e.days_away <= 3 ? 'text-rose-600 dark:text-rose-400' : 'text-slate-500 dark:text-slate-400'}`}>
                            {e.days_away <= 0.04 ? '🔴 ORA' : `${e.days_away.toFixed(0)}g`}
                          </span>
                        </div>
                      );
                    });
                  })()}
                </div>
              ) : (
                <p className="text-[10px] text-slate-400 dark:text-slate-500 font-mono">Nessun evento nei prossimi 60 giorni.</p>
              )}
            </div>
          </div>
        )}
      </Section>

      {/* Exit Strategies */}
      <Section title="Strategie di Uscita" description="Gestione attiva delle posizioni aperte: trailing stop, presa parziale di profitto, uscita AI e limiti temporali.">

        {/* Trailing SL */}
        <div className={`flex flex-col gap-3 pb-6 border-b transition-colors duration-200 ${config.trailing_sl_enabled ? 'border-orange-200 dark:border-orange-500/25' : 'border-slate-100 dark:border-white/5'}`}>
          <label className="flex items-center gap-3 cursor-pointer group">
            <div className="relative">
              <input type="checkbox" className="sr-only" checked={config.trailing_sl_enabled} onChange={e => setConfig(c => ({ ...c, trailing_sl_enabled: e.target.checked }))} />
              <div className={`w-10 h-5 rounded-full transition-all duration-300 ${config.trailing_sl_enabled ? 'bg-orange-500' : 'bg-slate-200 dark:bg-white/10'}`} />
              <div className={`absolute top-1 left-1 w-3 h-3 bg-white rounded-full shadow-sm transition-transform duration-300 ${config.trailing_sl_enabled ? 'translate-x-5' : ''}`} />
            </div>
            <div>
              <p className={`text-sm font-bold transition-colors ${config.trailing_sl_enabled ? 'text-orange-600 dark:text-orange-400' : 'text-slate-800 dark:text-slate-200 group-hover:text-orange-600 dark:group-hover:text-orange-400'}`}>
                Trailing Stop Loss
                {config.trailing_sl_enabled && <span className="ml-2 px-1.5 py-0.5 rounded text-[9px] font-bold bg-orange-100 dark:bg-orange-500/20 text-orange-600 dark:text-orange-400 uppercase tracking-wider">Attivo</span>}
              </p>
              <p className="text-[11px] font-medium text-slate-400 dark:text-slate-500 leading-tight">Sposta lo SL al massimo favorevole man mano che il prezzo avanza</p>
            </div>
          </label>
          {config.trailing_sl_enabled && (
            <div className="pl-12 grid grid-cols-1 sm:grid-cols-2 gap-x-8 gap-y-4">
              <div>
                <p className="text-[10px] font-bold text-slate-400 dark:text-slate-500 uppercase tracking-widest mb-2">Attivazione (× ATR)</p>
                <div className="flex items-center gap-3">
                  <input type="range" min="0.5" max="3" step="0.1" value={config.trailing_sl_activation}
                    onChange={e => setConfig(c => ({ ...c, trailing_sl_activation: parseFloat(e.target.value) }))}
                    className="flex-1 h-1.5 rounded-full appearance-none cursor-pointer bg-slate-200 dark:bg-white/15 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-3.5 [&::-webkit-slider-thumb]:h-3.5 [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-orange-500 [&::-webkit-slider-thumb]:cursor-pointer [&::-moz-range-thumb]:w-3.5 [&::-moz-range-thumb]:h-3.5 [&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:bg-orange-500 [&::-moz-range-thumb]:border-0" />
                  <span className="text-[11px] font-bold font-mono text-orange-600 dark:text-orange-400 w-10 text-right">{config.trailing_sl_activation.toFixed(1)}×</span>
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Breakeven SL */}
        <div className={`flex flex-col gap-3 mt-6 pb-6 border-b transition-colors duration-200 ${config.be_sl_enabled ? 'border-sky-200 dark:border-sky-500/25' : 'border-slate-100 dark:border-white/5'}`}>
          <label className="flex items-center gap-3 cursor-pointer group">
            <div className="relative">
              <input type="checkbox" className="sr-only" checked={config.be_sl_enabled} onChange={e => setConfig(c => ({ ...c, be_sl_enabled: e.target.checked }))} />
              <div className={`w-10 h-5 rounded-full transition-all duration-300 ${config.be_sl_enabled ? 'bg-sky-500' : 'bg-slate-200 dark:bg-white/10'}`} />
              <div className={`absolute top-1 left-1 w-3 h-3 bg-white rounded-full shadow-sm transition-transform duration-300 ${config.be_sl_enabled ? 'translate-x-5' : ''}`} />
            </div>
            <div>
              <p className={`text-sm font-bold transition-colors ${config.be_sl_enabled ? 'text-sky-600 dark:text-sky-400' : 'text-slate-800 dark:text-slate-200 group-hover:text-sky-600 dark:group-hover:text-sky-400'}`}>
                Breakeven Stop Loss
                {config.be_sl_enabled && <span className="ml-2 px-1.5 py-0.5 rounded text-[9px] font-bold bg-sky-100 dark:bg-sky-500/20 text-sky-600 dark:text-sky-400 uppercase tracking-wider">Attivo</span>}
              </p>
              <p className="text-[11px] font-medium text-slate-400 dark:text-slate-500 leading-tight">Sposta lo SL a breakeven quando il profitto raggiunge la soglia</p>
            </div>
          </label>
          {config.be_sl_enabled && (
            <div className="pl-12">
              <p className="text-[10px] font-bold text-slate-400 dark:text-slate-500 uppercase tracking-widest mb-2">Attivazione (× ATR)</p>
              <div className="flex items-center gap-3">
                <input type="range" min="0.3" max="3" step="0.1" value={config.be_sl_activation}
                  onChange={e => setConfig(c => ({ ...c, be_sl_activation: parseFloat(e.target.value) }))}
                  className="flex-1 h-1.5 rounded-full appearance-none cursor-pointer bg-slate-200 dark:bg-white/15 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-3.5 [&::-webkit-slider-thumb]:h-3.5 [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-sky-500 [&::-webkit-slider-thumb]:cursor-pointer [&::-moz-range-thumb]:w-3.5 [&::-moz-range-thumb]:h-3.5 [&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:bg-sky-500 [&::-moz-range-thumb]:border-0" />
                <span className="text-[11px] font-bold font-mono text-sky-600 dark:text-sky-400 w-10 text-right">{config.be_sl_activation.toFixed(1)}×</span>
              </div>
            </div>
          )}
        </div>

        {/* Partial TP */}
        <div className={`flex flex-col gap-3 mt-6 pb-6 border-b transition-colors duration-200 ${config.partial_tp_enabled ? 'border-emerald-200 dark:border-emerald-500/25' : 'border-slate-100 dark:border-white/5'}`}>
          <label className="flex items-center gap-3 cursor-pointer group">
            <div className="relative">
              <input type="checkbox" className="sr-only" checked={config.partial_tp_enabled} onChange={e => setConfig(c => ({ ...c, partial_tp_enabled: e.target.checked }))} />
              <div className={`w-10 h-5 rounded-full transition-all duration-300 ${config.partial_tp_enabled ? 'bg-emerald-600' : 'bg-slate-200 dark:bg-white/10'}`} />
              <div className={`absolute top-1 left-1 w-3 h-3 bg-white rounded-full shadow-sm transition-transform duration-300 ${config.partial_tp_enabled ? 'translate-x-5' : ''}`} />
            </div>
            <div>
              <p className={`text-sm font-bold transition-colors ${config.partial_tp_enabled ? 'text-emerald-600 dark:text-emerald-400' : 'text-slate-800 dark:text-slate-200 group-hover:text-emerald-600 dark:group-hover:text-emerald-400'}`}>
                Presa Parziale di Profitto
                {config.partial_tp_enabled && <span className="ml-2 px-1.5 py-0.5 rounded text-[9px] font-bold bg-emerald-100 dark:bg-emerald-500/20 text-emerald-600 dark:text-emerald-400 uppercase tracking-wider">Attivo</span>}
              </p>
              <p className="text-[11px] font-medium text-slate-400 dark:text-slate-500 leading-tight">Chiude una quota della posizione al primo target ATR</p>
            </div>
          </label>
          {config.partial_tp_enabled && (
            <div className="pl-12 grid grid-cols-1 sm:grid-cols-2 gap-x-8 gap-y-4">
              <div>
                <p className="text-[10px] font-bold text-slate-400 dark:text-slate-500 uppercase tracking-widest mb-2">Target (× ATR)</p>
                <div className="flex items-center gap-3">
                  <input type="range" min="0.5" max="3" step="0.1" value={config.partial_tp_atr_mult}
                    onChange={e => setConfig(c => ({ ...c, partial_tp_atr_mult: parseFloat(e.target.value) }))}
                    className="flex-1 h-1.5 rounded-full appearance-none cursor-pointer bg-slate-200 dark:bg-white/15 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-3.5 [&::-webkit-slider-thumb]:h-3.5 [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-emerald-500 [&::-webkit-slider-thumb]:cursor-pointer [&::-moz-range-thumb]:w-3.5 [&::-moz-range-thumb]:h-3.5 [&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:bg-emerald-500 [&::-moz-range-thumb]:border-0" />
                  <span className="text-[11px] font-bold font-mono text-emerald-600 dark:text-emerald-400 w-10 text-right">{config.partial_tp_atr_mult.toFixed(1)}×</span>
                </div>
              </div>
              <div>
                <p className="text-[10px] font-bold text-slate-400 dark:text-slate-500 uppercase tracking-widest mb-2">Quota da chiudere</p>
                <div className="flex items-center gap-3">
                  <input type="range" min="10" max="80" step="5" value={config.partial_tp_pct}
                    onChange={e => setConfig(c => ({ ...c, partial_tp_pct: parseFloat(e.target.value) }))}
                    className="flex-1 h-1.5 rounded-full appearance-none cursor-pointer bg-slate-200 dark:bg-white/15 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-3.5 [&::-webkit-slider-thumb]:h-3.5 [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-emerald-500 [&::-webkit-slider-thumb]:cursor-pointer [&::-moz-range-thumb]:w-3.5 [&::-moz-range-thumb]:h-3.5 [&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:bg-emerald-500 [&::-moz-range-thumb]:border-0" />
                  <span className="text-[11px] font-bold font-mono text-emerald-600 dark:text-emerald-400 w-12 text-right">{config.partial_tp_pct.toFixed(0)}%</span>
                </div>
              </div>
            </div>
          )}
        </div>

        {/* LightGBM Exit */}
        <div className={`flex flex-col gap-3 mt-6 pb-6 border-b transition-colors duration-200 ${config.lgbm_exit_enabled ? 'border-violet-200 dark:border-violet-500/25' : 'border-slate-100 dark:border-white/5'}`}>
          <label className="flex items-center gap-3 cursor-pointer group">
            <div className="relative">
              <input type="checkbox" className="sr-only" checked={config.lgbm_exit_enabled} onChange={e => setConfig(c => ({ ...c, lgbm_exit_enabled: e.target.checked }))} />
              <div className={`w-10 h-5 rounded-full transition-all duration-300 ${config.lgbm_exit_enabled ? 'bg-violet-600' : 'bg-slate-200 dark:bg-white/10'}`} />
              <div className={`absolute top-1 left-1 w-3 h-3 bg-white rounded-full shadow-sm transition-transform duration-300 ${config.lgbm_exit_enabled ? 'translate-x-5' : ''}`} />
            </div>
            <div>
              <p className={`text-sm font-bold transition-colors ${config.lgbm_exit_enabled ? 'text-violet-600 dark:text-violet-400' : 'text-slate-800 dark:text-slate-200 group-hover:text-violet-600 dark:group-hover:text-violet-400'}`}>
                Uscita AI — LightGBM Exit
                {config.lgbm_exit_enabled && <span className="ml-2 px-1.5 py-0.5 rounded text-[9px] font-bold bg-violet-100 dark:bg-violet-500/20 text-violet-600 dark:text-violet-400 uppercase tracking-wider">Attivo</span>}
              </p>
              <p className="text-[11px] font-medium text-slate-400 dark:text-slate-500 leading-tight">Chiude la posizione quando LightGBM rileva inversione imminente</p>
            </div>
          </label>
          {config.lgbm_exit_enabled && (
            <>
            <div className="pl-12 grid grid-cols-1 sm:grid-cols-3 gap-x-8 gap-y-4">
              <div>
                <p className="text-[10px] font-bold text-slate-400 dark:text-slate-500 uppercase tracking-widest mb-2">Soglia Uscita</p>
                <div className="flex items-center gap-3">
                  <input type="range" min="0.1" max="0.6" step="0.01" value={config.lgbm_exit_threshold}
                    onChange={e => setConfig(c => ({ ...c, lgbm_exit_threshold: parseFloat(e.target.value) }))}
                    className="flex-1 h-1.5 rounded-full appearance-none cursor-pointer bg-slate-200 dark:bg-white/15 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-3.5 [&::-webkit-slider-thumb]:h-3.5 [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-violet-500 [&::-webkit-slider-thumb]:cursor-pointer [&::-moz-range-thumb]:w-3.5 [&::-moz-range-thumb]:h-3.5 [&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:bg-violet-500 [&::-moz-range-thumb]:border-0" />
                  <span className="text-[11px] font-bold font-mono text-violet-600 dark:text-violet-400 w-10 text-right">{config.lgbm_exit_threshold.toFixed(2)}</span>
                </div>
              </div>
              <div>
                <p className="text-[10px] font-bold text-slate-400 dark:text-slate-500 uppercase tracking-widest mb-2">Min Hold (bar)</p>
                <div className="flex items-center gap-3">
                  <input type="range" min="1" max="24" step="1" value={config.lgbm_exit_min_hold_bars}
                    onChange={e => setConfig(c => ({ ...c, lgbm_exit_min_hold_bars: parseInt(e.target.value) }))}
                    className="flex-1 h-1.5 rounded-full appearance-none cursor-pointer bg-slate-200 dark:bg-white/15 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-3.5 [&::-webkit-slider-thumb]:h-3.5 [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-violet-500 [&::-webkit-slider-thumb]:cursor-pointer [&::-moz-range-thumb]:w-3.5 [&::-moz-range-thumb]:h-3.5 [&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:bg-violet-500 [&::-moz-range-thumb]:border-0" />
                  <span className="text-[11px] font-bold font-mono text-violet-600 dark:text-violet-400 w-10 text-right">{config.lgbm_exit_min_hold_bars}</span>
                </div>
              </div>
              <div>
                <p className="text-[10px] font-bold text-slate-400 dark:text-slate-500 uppercase tracking-widest mb-2">Conferma (bar)</p>
                <div className="flex items-center gap-3">
                  <input type="range" min="1" max="5" step="1" value={config.lgbm_exit_confirm_bars}
                    onChange={e => setConfig(c => ({ ...c, lgbm_exit_confirm_bars: parseInt(e.target.value) }))}
                    className="flex-1 h-1.5 rounded-full appearance-none cursor-pointer bg-slate-200 dark:bg-white/15 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-3.5 [&::-webkit-slider-thumb]:h-3.5 [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-violet-500 [&::-webkit-slider-thumb]:cursor-pointer [&::-moz-range-thumb]:w-3.5 [&::-moz-range-thumb]:h-3.5 [&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:bg-violet-500 [&::-moz-range-thumb]:border-0" />
                  <span className="text-[11px] font-bold font-mono text-violet-600 dark:text-violet-400 w-10 text-right">{config.lgbm_exit_confirm_bars}</span>
                </div>
              </div>
            </div>
            {/* Enhanced Exit sub-toggle */}
            <div className="pl-12 pt-3 border-t border-violet-100 dark:border-violet-500/15 mt-1">
              <label className="flex items-center gap-3 cursor-pointer group">
                <div className="relative">
                  <input type="checkbox" className="sr-only" checked={config.enhanced_exit_enabled} onChange={e => setConfig(c => ({ ...c, enhanced_exit_enabled: e.target.checked }))} />
                  <div className={`w-9 h-[18px] rounded-full transition-all duration-300 ${config.enhanced_exit_enabled ? 'bg-violet-400' : 'bg-slate-200 dark:bg-white/10'}`} />
                  <div className={`absolute top-[3px] left-[3px] w-3 h-3 bg-white rounded-full shadow-sm transition-transform duration-300 ${config.enhanced_exit_enabled ? 'translate-x-[18px]' : ''}`} />
                </div>
                <div>
                  <p className={`text-xs font-bold transition-colors ${config.enhanced_exit_enabled ? 'text-violet-500 dark:text-violet-300' : 'text-slate-600 dark:text-slate-400'}`}>
                    Enhanced Exit (Chronos p50 confirm)
                  </p>
                  <p className="text-[10px] text-slate-400 dark:text-slate-500 leading-snug">Richiede che il p50 di Chronos abbia attraversato il prezzo di entrata prima di uscire</p>
                </div>
              </label>
            </div>
            </>
          )}
        </div>

        {/* Max Hold Bars */}
        <div className={`flex flex-col gap-3 mt-6 transition-colors duration-200`}>
          <label className="flex items-center gap-3 cursor-pointer group">
            <div className="relative">
              <input type="checkbox" className="sr-only" checked={config.max_hold_bars_enabled} onChange={e => setConfig(c => ({ ...c, max_hold_bars_enabled: e.target.checked }))} />
              <div className={`w-10 h-5 rounded-full transition-all duration-300 ${config.max_hold_bars_enabled ? 'bg-rose-500' : 'bg-slate-200 dark:bg-white/10'}`} />
              <div className={`absolute top-1 left-1 w-3 h-3 bg-white rounded-full shadow-sm transition-transform duration-300 ${config.max_hold_bars_enabled ? 'translate-x-5' : ''}`} />
            </div>
            <div>
              <p className={`text-sm font-bold transition-colors ${config.max_hold_bars_enabled ? 'text-rose-600 dark:text-rose-400' : 'text-slate-800 dark:text-slate-200 group-hover:text-rose-600 dark:group-hover:text-rose-400'}`}>
                Max Hold Time
                {config.max_hold_bars_enabled && <span className="ml-2 px-1.5 py-0.5 rounded text-[9px] font-bold bg-rose-100 dark:bg-rose-500/20 text-rose-600 dark:text-rose-400 uppercase tracking-wider">Attivo</span>}
              </p>
              <p className="text-[11px] font-medium text-slate-400 dark:text-slate-500 leading-tight">Chiude forzatamente la posizione dopo N candele 4H</p>
            </div>
          </label>
          {config.max_hold_bars_enabled && (
            <div className="pl-12">
              <p className="text-[10px] font-bold text-slate-400 dark:text-slate-500 uppercase tracking-widest mb-2">
                Max candele ({(config.max_hold_bars * 4)}h ≈ {(config.max_hold_bars / 6).toFixed(1)} giorni)
              </p>
              <div className="flex items-center gap-3">
                <input type="range" min="6" max="120" step="6" value={config.max_hold_bars}
                  onChange={e => setConfig(c => ({ ...c, max_hold_bars: parseInt(e.target.value) }))}
                  className="flex-1 h-1.5 rounded-full appearance-none cursor-pointer bg-slate-200 dark:bg-white/15 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-3.5 [&::-webkit-slider-thumb]:h-3.5 [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-rose-500 [&::-webkit-slider-thumb]:cursor-pointer [&::-moz-range-thumb]:w-3.5 [&::-moz-range-thumb]:h-3.5 [&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:bg-rose-500 [&::-moz-range-thumb]:border-0" />
                <span className="text-[11px] font-bold font-mono text-rose-600 dark:text-rose-400 w-16 text-right">{config.max_hold_bars} bar</span>
              </div>
            </div>
          )}
        </div>
      </Section>

      {/* ── Filtri Qualità Segnale ─────────────────────────────────────────── */}
      <Section title="Filtri Qualità — Decision Engine" description="Protezioni avanzate contro entrate in condizioni sfavorevoli. Operano dopo il calcolo dell'ensemble probability e prima del segnale finale.">
        <div className="space-y-3">

          {/* Dual ATR */}
          <Tooltip text="Usa ATR_21 (periodo più lungo, più smooth) per calcolare la distanza dello Stop Loss, e ATR_14 (reattivo) per il Take Profit. Vantaggi: in periodi di spike di volatilità, ATR_14 si gonfia temporaneamente e allarga lo SL eccessivamente. ATR_21 reagisce meno agli spike singoli, producendo uno SL più stabile e un R:R migliore. La size aumenta leggermente perché lo SL è più stretto. TP rimane invariato." width="wide" pos="bottom">
          <label className={`flex items-start gap-3 cursor-pointer group p-4 rounded-xl border transition-all duration-200 ${config.dual_atr_enabled ? 'border-cyan-200 dark:border-cyan-500/30 bg-cyan-50/40 dark:bg-cyan-500/5' : 'border-slate-100 dark:border-white/5 hover:bg-slate-50 dark:hover:bg-white/[0.03]'}`}>
            <div className="relative mt-0.5 flex-shrink-0">
              <input type="checkbox" className="sr-only" checked={config.dual_atr_enabled} onChange={e => setConfig(c => ({ ...c, dual_atr_enabled: e.target.checked }))} />
              <div className={`w-9 h-[18px] rounded-full transition-all duration-300 ${config.dual_atr_enabled ? 'bg-cyan-600' : 'bg-slate-200 dark:bg-white/10'}`} />
              <div className={`absolute top-[3px] left-[3px] w-3 h-3 bg-white rounded-full shadow-sm transition-transform duration-300 ${config.dual_atr_enabled ? 'translate-x-[18px]' : ''}`} />
            </div>
            <div className="min-w-0">
              <p className={`text-xs font-bold leading-tight transition-colors ${config.dual_atr_enabled ? 'text-cyan-600 dark:text-cyan-400' : 'text-slate-700 dark:text-slate-300'}`}>
                Dual ATR — SL su ATR_21, TP su ATR_14
                {config.dual_atr_enabled && <span className="ml-2 px-1.5 py-0.5 rounded text-[9px] font-bold bg-cyan-100 dark:bg-cyan-500/20 text-cyan-600 dark:text-cyan-400 uppercase tracking-wider">Attivo</span>}
              </p>
              <p className="text-[10px] text-slate-400 dark:text-slate-500 leading-snug mt-1">
                SL usa <span className="font-mono text-slate-600 dark:text-slate-300">ATR_21</span> (smooth, meno sensibile agli spike) — TP usa <span className="font-mono text-slate-600 dark:text-slate-300">ATR_14</span> (reattivo). SL più stabile, R:R migliorato.
              </p>
            </div>
          </label>
          </Tooltip>

          {/* Exhaustion Guard */}
          <Tooltip text="Protezione contro entrate in zone di esaurimento tecnico. RSI 4H < 28 o ret_48 < −6% (ipervenduto/caduta prolungata): threshold short +0.06. RSI > 72 o ret_48 > +6% (ipercomprato/rally prolungato): threshold long +0.06. Riduce il rischio di entrare nella direzione di un rimbalzo imminente." width="wide" pos="bottom">
          <label className={`flex items-start gap-3 cursor-pointer group p-4 rounded-xl border transition-all duration-200 ${config.exhaustion_guard_enabled ? 'border-rose-200 dark:border-rose-500/30 bg-rose-50/40 dark:bg-rose-500/5' : 'border-slate-100 dark:border-white/5 hover:bg-slate-50 dark:hover:bg-white/[0.03]'}`}>
            <div className="relative mt-0.5 flex-shrink-0">
              <input type="checkbox" className="sr-only" checked={config.exhaustion_guard_enabled} onChange={e => setConfig(c => ({ ...c, exhaustion_guard_enabled: e.target.checked }))} />
              <div className={`w-9 h-[18px] rounded-full transition-all duration-300 ${config.exhaustion_guard_enabled ? 'bg-rose-500' : 'bg-slate-200 dark:bg-white/10'}`} />
              <div className={`absolute top-[3px] left-[3px] w-3 h-3 bg-white rounded-full shadow-sm transition-transform duration-300 ${config.exhaustion_guard_enabled ? 'translate-x-[18px]' : ''}`} />
            </div>
            <div className="min-w-0">
              <p className={`text-xs font-bold leading-tight transition-colors ${config.exhaustion_guard_enabled ? 'text-rose-600 dark:text-rose-400' : 'text-slate-700 dark:text-slate-300'}`}>
                Exhaustion Guard
                {config.exhaustion_guard_enabled && <span className="ml-2 px-1.5 py-0.5 rounded text-[9px] font-bold bg-rose-100 dark:bg-rose-500/20 text-rose-600 dark:text-rose-400 uppercase tracking-wider">Attivo</span>}
              </p>
              <p className="text-[10px] text-slate-400 dark:text-slate-500 leading-snug mt-1">
                Se <span className="font-mono text-slate-600 dark:text-slate-300">RSI 4H &lt; 28</span> o <span className="font-mono text-slate-600 dark:text-slate-300">ret_48 &lt; −6%</span> il threshold short aumenta <span className="font-mono text-slate-600 dark:text-slate-300">+0.06</span>. Speculare per long (<span className="font-mono text-slate-600 dark:text-slate-300">RSI &gt; 72</span> / <span className="font-mono text-slate-600 dark:text-slate-300">ret_48 &gt; +6%</span>). Blocca entrate in zone di esaurimento tecnico.
              </p>
            </div>
          </label>
          </Tooltip>

          {/* Late Entry Distance Filter */}
          <Tooltip text="Blocca l'entry se il prezzo è già troppo lontano dall'Order Block attivo (ob_dist > soglia ATR). Il filtro è attivo solo quando esiste un OB nella direzione del trade — se non c'è OB viene ignorato per non bloccare trade legittimi senza struttura vicina." width="wide" pos="top">
          <label className={`flex items-start gap-3 cursor-pointer group p-4 rounded-xl border transition-all duration-200 ${config.late_entry_filter_enabled ? 'border-amber-200 dark:border-amber-500/30 bg-amber-50/40 dark:bg-amber-500/5' : 'border-slate-100 dark:border-white/5 hover:bg-slate-50 dark:hover:bg-white/[0.03]'}`}>
            <div className="relative mt-0.5 flex-shrink-0">
              <input type="checkbox" className="sr-only" checked={config.late_entry_filter_enabled} onChange={e => setConfig(c => ({ ...c, late_entry_filter_enabled: e.target.checked }))} />
              <div className={`w-9 h-[18px] rounded-full transition-all duration-300 ${config.late_entry_filter_enabled ? 'bg-amber-500' : 'bg-slate-200 dark:bg-white/10'}`} />
              <div className={`absolute top-[3px] left-[3px] w-3 h-3 bg-white rounded-full shadow-sm transition-transform duration-300 ${config.late_entry_filter_enabled ? 'translate-x-[18px]' : ''}`} />
            </div>
            <div className="min-w-0 flex-1">
              <p className={`text-xs font-bold leading-tight transition-colors ${config.late_entry_filter_enabled ? 'text-amber-600 dark:text-amber-400' : 'text-slate-700 dark:text-slate-300'}`}>
                Late Entry Filter — OB Distance
                {config.late_entry_filter_enabled && <span className="ml-2 px-1.5 py-0.5 rounded text-[9px] font-bold bg-amber-100 dark:bg-amber-500/20 text-amber-600 dark:text-amber-400 uppercase tracking-wider">Attivo</span>}
              </p>
              <p className="text-[10px] text-slate-400 dark:text-slate-500 leading-snug mt-1">
                Salta l'entry se il prezzo è &gt; <span className="font-mono text-slate-600 dark:text-slate-300">{config.late_entry_max_ob_dist} ATR</span> dall'Order Block — momentum già esaurito.
              </p>
            </div>
          </label>
          </Tooltip>
          {config.late_entry_filter_enabled && (
            <div className="px-4 pb-2">
              <NumInput label="Distanza Massima OB (ATR)" value={config.late_entry_max_ob_dist} onChange={v => setConfig(c => ({ ...c, late_entry_max_ob_dist: v }))} step={0.5} min={1.0} max={8.0} />
            </div>
          )}

          {/* Path Obstruction Gate */}
          <Tooltip text="Blocca long se c'è un Bear Order Block (resistenza) a meno di N ATR sopra l'entry. Blocca short se c'è un Bull Order Block (supporto) a meno di N ATR sotto. ob_bear_dist = (OB_mid − close) / ATR_14: valore piccolo positivo = resistenza appena sopra. Inattivo se nessun OB attivo nella direzione contraria." width="wide" pos="top">
          <label className={`flex items-start gap-3 cursor-pointer group p-4 rounded-xl border transition-all duration-200 ${config.path_obstruction_enabled ? 'border-orange-200 dark:border-orange-500/30 bg-orange-50/40 dark:bg-orange-500/5' : 'border-slate-100 dark:border-white/5 hover:bg-slate-50 dark:hover:bg-white/[0.03]'}`}>
            <div className="relative mt-0.5 flex-shrink-0">
              <input type="checkbox" className="sr-only" checked={config.path_obstruction_enabled} onChange={e => setConfig(c => ({ ...c, path_obstruction_enabled: e.target.checked }))} />
              <div className={`w-9 h-[18px] rounded-full transition-all duration-300 ${config.path_obstruction_enabled ? 'bg-orange-500' : 'bg-slate-200 dark:bg-white/10'}`} />
              <div className={`absolute top-[3px] left-[3px] w-3 h-3 bg-white rounded-full shadow-sm transition-transform duration-300 ${config.path_obstruction_enabled ? 'translate-x-[18px]' : ''}`} />
            </div>
            <div className="min-w-0 flex-1">
              <p className={`text-xs font-bold leading-tight transition-colors ${config.path_obstruction_enabled ? 'text-orange-600 dark:text-orange-400' : 'text-slate-700 dark:text-slate-300'}`}>
                Path Obstruction Gate — OB Overhead
                {config.path_obstruction_enabled && <span className="ml-2 px-1.5 py-0.5 rounded text-[9px] font-bold bg-orange-100 dark:bg-orange-500/20 text-orange-600 dark:text-orange-400 uppercase tracking-wider">Attivo</span>}
              </p>
              <p className="text-[10px] text-slate-400 dark:text-slate-500 leading-snug mt-1">
                Blocca long/short se una struttura contraria è entro <span className="font-mono text-slate-600 dark:text-slate-300">{config.path_obstruction_max_dist} ATR</span> — OB resistenza/supporto che ostacola il percorso.
              </p>
            </div>
          </label>
          </Tooltip>
          {config.path_obstruction_enabled && (
            <div className="px-4 pb-2">
              <NumInput label="Distanza Massima OB Contrario (ATR)" value={config.path_obstruction_max_dist} onChange={v => setConfig(c => ({ ...c, path_obstruction_max_dist: v }))} step={0.5} min={0.5} max={4.0} />
            </div>
          )}

          {/* Consecutive Bars Filter */}
          <Tooltip text="Blocca l'entry se il trend ha troppi bar consecutivi nella stessa direzione — il momentum è già prezzato e il rischio di pullback/rimbalzo è elevato. consec_bars ≥ max_long blocca long (bull overextension); consec_bars ≤ −max_short blocca short (bear overextension)." width="wide" pos="top">
          <label className={`flex items-start gap-3 cursor-pointer group p-4 rounded-xl border transition-all duration-200 ${config.consec_bars_filter_enabled ? 'border-rose-200 dark:border-rose-500/30 bg-rose-50/40 dark:bg-rose-500/5' : 'border-slate-100 dark:border-white/5 hover:bg-slate-50 dark:hover:bg-white/[0.03]'}`}>
            <div className="relative mt-0.5 flex-shrink-0">
              <input type="checkbox" className="sr-only" checked={config.consec_bars_filter_enabled} onChange={e => setConfig(c => ({ ...c, consec_bars_filter_enabled: e.target.checked }))} />
              <div className={`w-9 h-[18px] rounded-full transition-all duration-300 ${config.consec_bars_filter_enabled ? 'bg-rose-500' : 'bg-slate-200 dark:bg-white/10'}`} />
              <div className={`absolute top-[3px] left-[3px] w-3 h-3 bg-white rounded-full shadow-sm transition-transform duration-300 ${config.consec_bars_filter_enabled ? 'translate-x-[18px]' : ''}`} />
            </div>
            <div className="min-w-0 flex-1">
              <p className={`text-xs font-bold leading-tight transition-colors ${config.consec_bars_filter_enabled ? 'text-rose-600 dark:text-rose-400' : 'text-slate-700 dark:text-slate-300'}`}>
                Consecutive Bars Filter — Trend Age
                {config.consec_bars_filter_enabled && <span className="ml-2 px-1.5 py-0.5 rounded text-[9px] font-bold bg-rose-100 dark:bg-rose-500/20 text-rose-600 dark:text-rose-400 uppercase tracking-wider">Attivo</span>}
              </p>
              <p className="text-[10px] text-slate-400 dark:text-slate-500 leading-snug mt-1">
                Salta long se ≥ <span className="font-mono text-slate-600 dark:text-slate-300">{config.consec_bars_max_long}</span> bar bull consecutivi — salta short se ≥ <span className="font-mono text-slate-600 dark:text-slate-300">{config.consec_bars_max_short}</span> bar bear. Trend overexteso, alto rischio inversione.
              </p>
            </div>
          </label>
          </Tooltip>
          {config.consec_bars_filter_enabled && (
            <div className="px-4 pb-2 flex flex-col gap-2">
              <NumInput label="Max Bar Bull Consecutivi (Long)" value={config.consec_bars_max_long} onChange={v => setConfig(c => ({ ...c, consec_bars_max_long: v }))} step={1} min={3} max={20} />
              <NumInput label="Max Bar Bear Consecutivi (Short)" value={config.consec_bars_max_short} onChange={v => setConfig(c => ({ ...c, consec_bars_max_short: v }))} step={1} min={3} max={20} />
            </div>
          )}

        </div>
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
