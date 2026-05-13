import React, { useEffect, useRef, useState } from 'react';

interface ForecastData {
  symbol: string;
  current_price: number;
  last_candle_time: string;
  horizon_hours: number;
  c2_dir_prob: number;
  c2_vol_prob: number;
  c2_cont_prob: number;
  c2_p10: number;
  c2_p50: number;
  c2_p90: number;
  c2_uncertainty: number;
  latency_ms: number;
}

export const ForecastView: React.FC<{ apiBase: string }> = ({ apiBase }) => {
  const [data, setData]       = useState<ForecastData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError]     = useState<string | null>(null);
  const chartRef              = useRef<HTMLDivElement>(null);

  const fetchForecast = async () => {
    setLoading(true);
    setError(null);
    try {
      const r = await fetch(`${apiBase}/forecast?symbol=BTC&horizon=3`);
      if (!r.ok) throw new Error(await r.text());
      setData(await r.json());
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchForecast();
  }, [apiBase]);

  const probColor = (p: number) =>
    p > 0.65 ? 'text-emerald-400' : p < 0.35 ? 'text-red-400' : 'text-amber-400';

  return (
    <div className="space-y-6">
      {/* Controls */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-bold text-white">Forecast Probabilistico</h2>
          <p className="text-xs text-slate-500 mt-0.5">Chronos-2 Base · Orizzonte 12h (3×4h) · 200 campioni Monte Carlo</p>
        </div>
        <button
          onClick={fetchForecast}
          disabled={loading}
          className="px-4 py-2 bg-indigo-600 hover:bg-indigo-500 text-white text-sm font-semibold rounded-xl transition-colors disabled:opacity-50"
        >
          {loading ? '⏳ Inference…' : '↻ Aggiorna'}
        </button>
      </div>

      {error && (
        <div className="rounded-xl bg-red-500/10 border border-red-500/30 p-4 text-sm text-red-400 font-mono">
          {error}
        </div>
      )}

      {data && (
        <>
          {/* Price + quantiles */}
          <div className="rounded-2xl bg-dark-card border border-dark-border p-6">
            <div className="flex items-start justify-between mb-6">
              <div>
                <p className="text-xs text-slate-500">Prezzo attuale BTC</p>
                <p className="text-3xl font-bold font-mono text-white mt-1">
                  ${data.current_price.toLocaleString('en-US', { minimumFractionDigits: 2 })}
                </p>
                <p className="text-xs text-slate-500 mt-1">
                  Ultima candela: {new Date(data.last_candle_time).toLocaleString('it-IT')}
                </p>
              </div>
              <div className="text-right">
                <p className="text-xs text-slate-500">Inference</p>
                <p className="text-sm font-mono text-slate-300">{data.latency_ms.toFixed(0)}ms</p>
              </div>
            </div>

            {/* Fan chart visual (CSS-based) */}
            <div className="relative h-32 rounded-xl bg-black/20 overflow-hidden mb-6">
              <FanChart
                currentPrice={data.current_price}
                p10={data.c2_p10}
                p50={data.c2_p50}
                p90={data.c2_p90}
              />
              <div className="absolute inset-0 flex items-center justify-center text-xs text-slate-600 pointer-events-none">
                {/* Placeholder — swap for lightweight-charts integration */}
                <span>Fan chart → integra lightweight-charts in Settimana 3</span>
              </div>
            </div>

            {/* Quantile strip */}
            <div className="grid grid-cols-3 gap-4">
              <QuantileCard label="p10 (pessimista)" value={data.c2_p10} current={data.current_price} />
              <QuantileCard label="p50 (mediana)" value={data.c2_p50} current={data.current_price} highlight />
              <QuantileCard label="p90 (ottimista)" value={data.c2_p90} current={data.current_price} />
            </div>
          </div>

          {/* 3 Probabilità composite */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <ProbCard
              label="Directional Prob"
              description="P(prezzo sale in 12h)"
              value={data.c2_dir_prob}
              threshold={0.62}
            />
            <ProbCard
              label="Volatility Prob"
              description="P(range > 1.5× ATR)"
              value={data.c2_vol_prob}
              threshold={0.50}
            />
            <ProbCard
              label="Continuation Prob"
              description="P(trend resta coerente)"
              value={data.c2_cont_prob}
              threshold={0.60}
            />
          </div>

          {/* Uncertainty */}
          <div className="rounded-2xl bg-dark-card border border-dark-border p-5">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm font-semibold text-slate-300">Incertezza del Modello</p>
                <p className="text-xs text-slate-500 mt-0.5">(p90 − p10) / prezzo corrente — bassa = maggiore confidenza</p>
              </div>
              <p className={`text-xl font-bold font-mono ${data.c2_uncertainty < 0.02 ? 'text-emerald-400' : data.c2_uncertainty < 0.04 ? 'text-amber-400' : 'text-red-400'}`}>
                {(data.c2_uncertainty * 100).toFixed(2)}%
              </p>
            </div>
          </div>
        </>
      )}
    </div>
  );
};

const FanChart: React.FC<{ currentPrice: number; p10: number; p50: number; p90: number }> = ({ currentPrice, p10, p50, p90 }) => {
  const min = Math.min(p10, currentPrice) * 0.999;
  const max = Math.max(p90, currentPrice) * 1.001;
  const range = max - min;
  const pct = (v: number) => `${((v - min) / range * 100).toFixed(1)}%`;

  return (
    <div className="absolute inset-0 flex items-end pb-2 px-4 gap-0.5">
      {/* Simplified visual bars */}
      <div className="flex-1 text-center">
        <div className="text-xs text-slate-600 font-mono">now</div>
        <div className="w-1 bg-white/30 mx-auto rounded" style={{ height: `${((currentPrice - min) / range * 100)}%` }} />
      </div>
      {[1, 2, 3].map(step => {
        const pStep10 = p10 + (p10 < currentPrice ? (currentPrice - p10) * 0.3 * step : 0);
        const pStep90 = p90;
        return (
          <div key={step} className="flex-1 flex flex-col items-center justify-end gap-0.5">
            <div className="text-xs text-slate-600 font-mono">+{step * 4}h</div>
            <div
              className="w-full rounded opacity-30 bg-gradient-to-t from-indigo-600 to-indigo-400"
              style={{ height: `${((p50 - min) / range * 100).toFixed(0)}%`, minHeight: '4px' }}
            />
          </div>
        );
      })}
    </div>
  );
};

const QuantileCard: React.FC<{ label: string; value: number; current: number; highlight?: boolean }> = ({ label, value, current, highlight }) => {
  const diff = ((value - current) / current * 100);
  const up = value >= current;
  return (
    <div className={`rounded-xl p-4 border ${highlight ? 'border-indigo-500/50 bg-indigo-500/10' : 'border-dark-border bg-white/5'}`}>
      <p className="text-xs text-slate-500 mb-1">{label}</p>
      <p className="text-lg font-bold font-mono text-white">${value.toLocaleString('en-US', { minimumFractionDigits: 0 })}</p>
      <p className={`text-xs font-mono mt-0.5 ${up ? 'text-emerald-400' : 'text-red-400'}`}>
        {up ? '+' : ''}{diff.toFixed(2)}%
      </p>
    </div>
  );
};

const ProbCard: React.FC<{ label: string; description: string; value: number; threshold: number }> = ({ label, description, value, threshold }) => {
  const pct = Math.round(value * 100);
  const active = value > threshold;
  return (
    <div className={`rounded-2xl border p-5 ${active ? 'border-emerald-500/40 bg-emerald-500/10' : 'border-dark-border bg-dark-card'}`}>
      <p className="text-sm font-semibold text-slate-300">{label}</p>
      <p className="text-xs text-slate-500 mt-0.5 mb-3">{description}</p>
      <div className="flex items-end gap-2">
        <p className={`text-3xl font-bold font-mono ${active ? 'text-emerald-400' : 'text-slate-400'}`}>{pct}%</p>
        {active && <span className="text-xs text-emerald-500 mb-1">▲ sopra soglia</span>}
      </div>
      {/* Progress bar */}
      <div className="mt-3 h-1.5 bg-white/10 rounded-full overflow-hidden">
        <div
          className={`h-full rounded-full transition-all ${active ? 'bg-emerald-500' : 'bg-slate-600'}`}
          style={{ width: `${pct}%` }}
        />
      </div>
      <p className="text-xs text-slate-600 mt-1">Soglia: {Math.round(threshold * 100)}%</p>
    </div>
  );
};
