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
};

export const BotConfig: React.FC<{ apiBase: string }> = ({ apiBase }) => {
  const [config, setConfig] = useState<Config>(DEFAULTS);
  const [saved, setSaved]   = useState(false);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    fetch(`${apiBase}/bot`)
      .then(r => r.ok ? r.json() : null)
      .then(d => d && setConfig(c => ({ ...c, ...d })))
      .catch(() => {});
  }, [apiBase]);

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

  const upd = (key: keyof Config) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
    const val = e.target.type === 'number' ? parseFloat(e.target.value) : e.target.value;
    setConfig(c => ({ ...c, [key]: val }));
  };

  const rr = (config.tp_atr_mult / config.sl_atr_mult).toFixed(2);
  const be = (1 / (1 + config.tp_atr_mult / config.sl_atr_mult) * 100).toFixed(1);

  return (
    <div className="space-y-6 max-w-2xl">
      <div>
        <h2 className="text-lg font-bold text-white">Bot Configuration</h2>
        <p className="text-xs text-slate-500 mt-0.5">Parametri attivi della strategia TrendFollowing4hBTC</p>
      </div>

      {/* Mode */}
      <div className="rounded-2xl bg-dark-card border border-dark-border p-5">
        <h3 className="text-sm font-bold text-slate-300 mb-4">Modalità</h3>
        <div className="flex gap-3">
          <Tooltip text="Paper Trading: il bot simula operazioni usando dati reali di mercato ma senza usare fondi veri. Ideale per testare la strategia senza rischi." pos="bottom">
            <button
              onClick={() => setConfig(c => ({ ...c, mode: 'paper' }))}
              className={`flex-1 py-3 rounded-xl text-sm font-semibold transition-colors ${
                config.mode === 'paper'
                  ? 'bg-indigo-600 text-white'
                  : 'bg-white/5 text-slate-400 hover:bg-white/10'
              }`}
            >
              📄 Paper Trading
            </button>
          </Tooltip>
          <Tooltip text="Live Trading: il bot opera con fondi reali su Hyperliquid. Richiede un agent wallet configurato nelle Impostazioni. Usare con cautela." pos="bottom">
            <button
              onClick={() => setConfig(c => ({ ...c, mode: 'live' }))}
              className={`flex-1 py-3 rounded-xl text-sm font-semibold transition-colors ${
                config.mode === 'live'
                  ? 'bg-amber-600 text-white'
                  : 'bg-white/5 text-slate-400 hover:bg-white/10'
              }`}
            >
              ⚡ Live Trading
            </button>
          </Tooltip>
        </div>
        {config.mode === 'live' && (
          <p className="mt-3 text-xs text-amber-400 bg-amber-500/10 rounded-lg px-3 py-2">
            ⚠️ Live mode usa fondi reali su Hyperliquid mainnet. Assicurati che l'agent wallet sia configurato nelle Settings.
          </p>
        )}
      </div>

      {/* Risk Management */}
      <div className="rounded-2xl bg-dark-card border border-dark-border p-5">
        <h3 className="text-sm font-bold text-slate-300 mb-4">Risk Management</h3>
        <div className="grid grid-cols-2 gap-4">
          <Tooltip text="Distanza dello Stop Loss dal prezzo di entrata, espressa come multiplo dell'ATR (Average True Range). ATR misura la volatilità media del mercato. Valore maggiore = tolleranza maggiore alle oscillazioni." width="wide" pos="bottom">
            <NumberField label="SL Multiplier (× ATR)" value={config.sl_atr_mult} min={0.5} max={5} step={0.1} onChange={upd('sl_atr_mult')} />
          </Tooltip>
          <Tooltip text="Distanza del Take Profit dal prezzo di entrata, in multipli di ATR. Valore maggiore = obiettivo di guadagno più lontano ma meno frequente." width="wide" pos="bottom">
            <NumberField label="TP Multiplier (× ATR)" value={config.tp_atr_mult} min={1} max={10} step={0.1} onChange={upd('tp_atr_mult')} />
          </Tooltip>
          <Tooltip text="Percentuale del capitale totale rischiata per ogni singolo trade. Con $10.000 e il 2%, ogni trade rischia al massimo $200." width="wide" pos="bottom">
            <NumberField label="Position Size (%)" value={config.position_size_pct} min={0.1} max={5} step={0.1} onChange={upd('position_size_pct')} />
          </Tooltip>
          <Tooltip text="Perdita massima tollerata in un singolo giorno. Al raggiungimento, il bot smette di aprire nuovi trade fino al giorno successivo." width="wide" pos="bottom">
            <NumberField label="Max Daily DD (%)" value={config.max_daily_dd_pct} min={0.5} max={10} step={0.5} onChange={upd('max_daily_dd_pct')} />
          </Tooltip>
          <Tooltip text="Numero massimo di trade in perdita consecutivi prima che il bot si fermi automaticamente. Protegge da drawdown prolungati." width="wide" pos="bottom">
            <NumberField label="Max Consecutive Losses" value={config.max_consecutive_losses} min={1} max={10} step={1} onChange={upd('max_consecutive_losses')} />
          </Tooltip>
        </div>
        <div className="mt-4 p-3 rounded-xl bg-white/5 text-xs font-mono text-slate-400 flex gap-6">
          <Tooltip text="Rapporto Rischio/Rendimento: quanti dollari guadagni per ogni dollaro rischiato. Con R:R = 1.75, su 100$ rischiati guadagni 175$ se il trade va bene." pos="top">
            <span>R:R = <span className="text-indigo-400">{rr}</span></span>
          </Tooltip>
          <Tooltip text="Win rate minimo per non perdere soldi. Con questo R:R, devi vincere almeno questa percentuale di trade per essere in pareggio." pos="top">
            <span>Break-even win rate = <span className="text-indigo-400">{be}%</span></span>
          </Tooltip>
        </div>
      </div>

      {/* Signal Thresholds */}
      <div className="rounded-2xl bg-dark-card border border-dark-border p-5">
        <h3 className="text-sm font-bold text-slate-300 mb-4">Soglie Segnale</h3>
        <div className="grid grid-cols-2 gap-4">
          <Tooltip text="Soglia minima di probabilità direzionale (0–1) per aprire un trade. Con 0.62, il modello deve essere almeno 62% sicuro che il prezzo si muova nella direzione prevista." width="wide" pos="bottom">
            <NumberField label="Directional Threshold" value={config.directional_threshold} min={0.5} max={0.9} step={0.01} onChange={upd('directional_threshold')} />
          </Tooltip>
          <Tooltip text="ADX (Average Directional Index) misura la forza del trend. Sotto questa soglia il mercato è considerato laterale e il bot non apre trade. Valore tipico: 20–25." width="wide" pos="bottom">
            <NumberField label="ADX Gate (no-trade <)" value={config.adx_gate} min={10} max={40} step={1} onChange={upd('adx_gate')} />
          </Tooltip>
          <Tooltip text="Punteggio minimo del sistema Quantum Trade (0–100) richiesto come conferma del segnale. Include indicatori tecnici multipli come RSI, EMA, divergenze CVD." width="wide" pos="bottom">
            <NumberField label="Confluence Gate (QT score)" value={config.confluence_gate} min={0} max={100} step={5} onChange={upd('confluence_gate')} />
          </Tooltip>
        </div>
      </div>

      {/* Save */}
      <button
        onClick={handleSave}
        disabled={loading}
        className={`w-full py-3 rounded-xl text-sm font-bold transition-colors ${
          saved
            ? 'bg-emerald-600 text-white'
            : 'bg-indigo-600 hover:bg-indigo-500 text-white disabled:opacity-50'
        }`}
      >
        {saved ? '✓ Salvato' : loading ? '⏳ Salvataggio…' : '💾 Salva Configurazione'}
      </button>
    </div>
  );
};

const NumberField: React.FC<{
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (e: React.ChangeEvent<HTMLInputElement>) => void;
}> = ({ label, value, min, max, step, onChange }) => (
  <div>
    <label className="text-xs text-slate-500 block mb-1">{label}</label>
    <input
      type="number"
      value={value}
      min={min}
      max={max}
      step={step}
      onChange={onChange}
      className="w-full bg-white/5 border border-dark-border rounded-lg px-3 py-2 text-sm font-mono text-white focus:outline-none focus:border-indigo-500 transition-colors"
    />
  </div>
);
