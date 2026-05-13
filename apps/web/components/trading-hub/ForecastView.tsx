import React, { useEffect, useState } from 'react';

interface FanData {
  p10: number[];
  p25: number[];
  p50: number[];
  p75: number[];
  p90: number[];
}

interface ForecastData {
  symbol: string;
  current_price: number;
  last_candle_time: string;
  horizon_steps: number;
  horizon_hours: number;
  atr: number | null;
  c2_dir_prob: number;
  c2_vol_prob: number;
  c2_cont_prob: number;
  c2_p10: number;
  c2_p50: number;
  c2_p90: number;
  c2_uncertainty: number;
  c2_p50_vs_atr: number;
  fan: FanData;
  latency_ms: number;
}

export const ForecastView: React.FC<{ apiBase: string }> = ({ apiBase }) => {
  const [data, setData]       = useState<ForecastData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError]     = useState<string | null>(null);

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

  useEffect(() => { fetchForecast(); }, [apiBase]);

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-bold text-white">Forecast Probabilistico</h2>
          <p className="text-xs text-slate-500 mt-0.5">
            Chronos-2 Base · Orizzonte 12h (3×4h) · 200 campioni Monte Carlo
          </p>
        </div>
        <button
          onClick={fetchForecast}
          disabled={loading}
          className="px-4 py-2 bg-indigo-600 hover:bg-indigo-500 text-white text-sm font-semibold rounded-xl transition-colors disabled:opacity-50 flex items-center gap-2"
        >
          {loading
            ? <><span className="inline-block w-3 h-3 border-2 border-white/30 border-t-white rounded-full animate-spin" />Inference…</>
            : '↻ Aggiorna'}
        </button>
      </div>

      {error && (
        <div className="rounded-xl bg-red-500/10 border border-red-500/30 p-4 text-sm text-red-400 font-mono">
          {error}
          <p className="text-xs text-red-500/60 mt-1">Assicurati che il backend sia avviato: <code>cd apps/api && uvicorn main:app --reload</code></p>
        </div>
      )}

      {loading && !data && (
        <div className="rounded-2xl bg-dark-card border border-dark-border p-12 text-center">
          <div className="inline-block w-8 h-8 border-2 border-indigo-500/30 border-t-indigo-500 rounded-full animate-spin mb-4" />
          <p className="text-slate-500 text-sm">Caricamento Chronos-2 (~800MB, prima esecuzione può richiedere 30s)…</p>
        </div>
      )}

      {data && (
        <>
          {/* Price header */}
          <div className="rounded-2xl bg-dark-card border border-dark-border p-6">
            <div className="flex items-start justify-between mb-5">
              <div>
                <p className="text-xs text-slate-500">BTC · Prezzo attuale</p>
                <p className="text-3xl font-bold font-mono text-white mt-1">
                  ${data.current_price.toLocaleString('en-US', { minimumFractionDigits: 2 })}
                </p>
                <p className="text-xs text-slate-500 mt-1">
                  Ultima candela 4h: {new Date(data.last_candle_time).toLocaleString('it-IT')}
                </p>
              </div>
              <div className="text-right space-y-1">
                <p className="text-xs text-slate-500">Inferenza</p>
                <p className="text-sm font-mono text-slate-300">{data.latency_ms.toFixed(0)}ms</p>
                {data.atr && (
                  <>
                    <p className="text-xs text-slate-500 mt-1">ATR(14)</p>
                    <p className="text-sm font-mono text-slate-400">${data.atr.toFixed(0)}</p>
                  </>
                )}
              </div>
            </div>

            {/* SVG Fan Chart */}
            <div className="rounded-xl bg-black/30 p-3 mb-6" style={{ height: 200 }}>
              <FanChartSVG
                currentPrice={data.current_price}
                fan={data.fan}
                horizonSteps={data.horizon_steps}
              />
            </div>

            {/* Quantile strip */}
            <div className="grid grid-cols-3 gap-3">
              <QuantileCard label="p10 — Pessimista" value={data.c2_p10} current={data.current_price} />
              <QuantileCard label="p50 — Mediana"   value={data.c2_p50} current={data.current_price} highlight />
              <QuantileCard label="p90 — Ottimista"  value={data.c2_p90} current={data.current_price} />
            </div>
          </div>

          {/* 3 probabilità */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <ProbCard
              label="Directional Prob"
              description="P(prezzo sale entro 12h)"
              value={data.c2_dir_prob}
              threshold={0.62}
              color="indigo"
            />
            <ProbCard
              label="Volatility Prob"
              description="P(range > 1.5% in 12h)"
              value={data.c2_vol_prob}
              threshold={0.50}
              color="amber"
            />
            <ProbCard
              label="Continuation Prob"
              description="P(trend coerente passo-passo)"
              value={data.c2_cont_prob}
              threshold={0.60}
              color="emerald"
            />
          </div>

          {/* Uncertainty + p50 vs ATR */}
          <div className="grid grid-cols-2 gap-4">
            <div className="rounded-2xl bg-dark-card border border-dark-border p-5">
              <p className="text-sm font-semibold text-slate-300">Incertezza Modello</p>
              <p className="text-xs text-slate-500 mt-0.5 mb-3">(p90 − p10) / prezzo — più bassa = più confidenza</p>
              <p className={`text-2xl font-bold font-mono ${
                data.c2_uncertainty < 0.02 ? 'text-emerald-400'
                : data.c2_uncertainty < 0.04 ? 'text-amber-400' : 'text-red-400'
              }`}>
                {(data.c2_uncertainty * 100).toFixed(2)}%
              </p>
            </div>
            <div className="rounded-2xl bg-dark-card border border-dark-border p-5">
              <p className="text-sm font-semibold text-slate-300">p50 vs ATR</p>
              <p className="text-xs text-slate-500 mt-0.5 mb-3">Distanza mediana dal prezzo in unità ATR</p>
              <p className={`text-2xl font-bold font-mono ${
                Math.abs(data.c2_p50_vs_atr) < 0.5 ? 'text-slate-400'
                : data.c2_p50_vs_atr > 0 ? 'text-emerald-400' : 'text-red-400'
              }`}>
                {data.c2_p50_vs_atr >= 0 ? '+' : ''}{data.c2_p50_vs_atr.toFixed(3)}
              </p>
            </div>
          </div>
        </>
      )}
    </div>
  );
};

// ── SVG Fan Chart ─────────────────────────────────────────────────────────────

const FanChartSVG: React.FC<{
  currentPrice: number;
  fan: FanData;
  horizonSteps: number;
}> = ({ currentPrice, fan, horizonSteps }) => {
  const W = 600, H = 170;
  const PAD = { l: 66, r: 16, t: 14, b: 28 };
  const cW = W - PAD.l - PAD.r;
  const cH = H - PAD.t - PAD.b;

  // Data: t=0 is current price (no spread), t=1..N are forecast steps
  const n = horizonSteps;
  const p10 = [currentPrice, ...fan.p10];
  const p25 = [currentPrice, ...fan.p25];
  const p50 = [currentPrice, ...fan.p50];
  const p75 = [currentPrice, ...fan.p75];
  const p90 = [currentPrice, ...fan.p90];

  const allVals = [...p10, ...p90, currentPrice].filter(v => v > 0);
  const priceMin = Math.min(...allVals) * 0.9992;
  const priceMax = Math.max(...allVals) * 1.0008;
  const priceRange = priceMax - priceMin || 1;

  const px = (i: number) => PAD.l + (i / n) * cW;
  const py = (price: number) => PAD.t + (1 - (price - priceMin) / priceRange) * cH;

  const xs = Array.from({ length: n + 1 }, (_, i) => px(i));

  const areaPath = (top: number[], bot: number[]) => {
    const fwd = top.map((v, i) => `${i === 0 ? 'M' : 'L'}${xs[i].toFixed(1)},${py(v).toFixed(1)}`).join(' ');
    const rev = [...bot].map((v, i) => `L${xs[n - i].toFixed(1)},${py(v).toFixed(1)}`).reverse().join(' ');
    return `${fwd} ${[...bot].reverse().map((v, i) => `L${xs[n - i].toFixed(1)},${py(v).toFixed(1)}`).join(' ')} Z`;
  };

  const linePath = (arr: number[]) =>
    arr.map((v, i) => `${i === 0 ? 'M' : 'L'}${xs[i].toFixed(1)},${py(v).toFixed(1)}`).join(' ');

  const fmtPrice = (p: number) =>
    p >= 10000 ? `$${(p / 1000).toFixed(1)}k` : `$${p.toFixed(0)}`;

  // Y-axis price labels
  const yLabels = [0.2, 0.5, 0.8].map(f => priceMin + f * priceRange);
  // X-axis time labels
  const xLabels = ['Ora', ...Array.from({ length: n }, (_, i) => `+${(i + 1) * 4}h`)];

  const isBullish = p50[n] >= currentPrice;

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-full" preserveAspectRatio="xMidYMid meet">
      {/* Grid */}
      {yLabels.map((price, i) => (
        <g key={i}>
          <line
            x1={PAD.l} y1={py(price)} x2={W - PAD.r} y2={py(price)}
            stroke="rgba(255,255,255,0.04)" strokeDasharray="3,5"
          />
          <text x={PAD.l - 5} y={py(price) + 4} textAnchor="end"
            fontSize="9" fill="rgba(148,163,184,0.5)" fontFamily="monospace">
            {fmtPrice(price)}
          </text>
        </g>
      ))}

      {/* P10–P90 outer band */}
      <path
        d={areaPath(p90, p10)}
        fill={isBullish ? 'rgba(99,102,241,0.10)' : 'rgba(239,68,68,0.08)'}
      />

      {/* P25–P75 inner band */}
      <path
        d={areaPath(p75, p25)}
        fill={isBullish ? 'rgba(99,102,241,0.22)' : 'rgba(239,68,68,0.18)'}
      />

      {/* Current price dashed reference */}
      <line
        x1={PAD.l} y1={py(currentPrice)} x2={W - PAD.r} y2={py(currentPrice)}
        stroke="rgba(255,255,255,0.18)" strokeDasharray="5,5" strokeWidth="1"
      />

      {/* P50 median path */}
      <path
        d={linePath(p50)}
        stroke={isBullish ? '#818cf8' : '#f87171'}
        strokeWidth="2" fill="none" strokeLinejoin="round"
      />

      {/* Dots on median */}
      {p50.map((v, i) => (
        <circle
          key={i} cx={xs[i]} cy={py(v)} r={i === 0 ? 4 : 2.5}
          fill={i === 0 ? '#fff' : (isBullish ? '#818cf8' : '#f87171')}
          stroke={i === 0 ? '#818cf8' : 'none'} strokeWidth="2"
        />
      ))}

      {/* Current price label */}
      <text x={PAD.l - 5} y={py(currentPrice) + 4} textAnchor="end"
        fontSize="9" fill="rgba(255,255,255,0.4)" fontFamily="monospace">
        {fmtPrice(currentPrice)}
      </text>

      {/* X-axis time labels */}
      {xLabels.map((label, i) => (
        <text key={i} x={xs[i]} y={H - 5} textAnchor="middle"
          fontSize="10" fill="rgba(148,163,184,0.55)" fontFamily="sans-serif">
          {label}
        </text>
      ))}

      {/* p10 / p90 boundary labels at last step */}
      <text x={xs[n] + 4} y={py(p90[n]) + 4} textAnchor="start"
        fontSize="8.5" fill="rgba(148,163,184,0.4)" fontFamily="monospace">
        {fmtPrice(p90[n])}
      </text>
      <text x={xs[n] + 4} y={py(p10[n]) + 4} textAnchor="start"
        fontSize="8.5" fill="rgba(148,163,184,0.4)" fontFamily="monospace">
        {fmtPrice(p10[n])}
      </text>
    </svg>
  );
};

// ── Sub-components ────────────────────────────────────────────────────────────

const QuantileCard: React.FC<{
  label: string; value: number; current: number; highlight?: boolean;
}> = ({ label, value, current, highlight }) => {
  const diff = (value - current) / current * 100;
  const up = value >= current;
  return (
    <div className={`rounded-xl p-4 border ${
      highlight ? 'border-indigo-500/40 bg-indigo-500/10' : 'border-dark-border bg-white/5'
    }`}>
      <p className="text-xs text-slate-500 mb-1">{label}</p>
      <p className="text-lg font-bold font-mono text-white">
        ${value.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}
      </p>
      <p className={`text-xs font-mono mt-0.5 ${up ? 'text-emerald-400' : 'text-red-400'}`}>
        {up ? '+' : ''}{diff.toFixed(2)}%
      </p>
    </div>
  );
};

const ProbCard: React.FC<{
  label: string; description: string; value: number; threshold: number;
  color: 'indigo' | 'amber' | 'emerald';
}> = ({ label, description, value, threshold, color }) => {
  const pct    = Math.round(value * 100);
  const active = value > threshold;
  const cols   = {
    indigo:  { border: 'border-indigo-500/40',  bg: 'bg-indigo-500/10',  bar: 'bg-indigo-500',  txt: 'text-indigo-400'  },
    amber:   { border: 'border-amber-500/40',   bg: 'bg-amber-500/10',   bar: 'bg-amber-500',   txt: 'text-amber-400'   },
    emerald: { border: 'border-emerald-500/40', bg: 'bg-emerald-500/10', bar: 'bg-emerald-500', txt: 'text-emerald-400' },
  };
  const c = cols[color];
  return (
    <div className={`rounded-2xl border p-5 ${active ? `${c.border} ${c.bg}` : 'border-dark-border bg-dark-card'}`}>
      <p className="text-sm font-semibold text-slate-300">{label}</p>
      <p className="text-xs text-slate-500 mt-0.5 mb-3">{description}</p>
      <div className="flex items-end gap-2 mb-3">
        <p className={`text-3xl font-bold font-mono ${active ? c.txt : 'text-slate-400'}`}>{pct}%</p>
        {active && <span className={`text-xs mb-1 ${c.txt}`}>▲ sopra soglia</span>}
      </div>
      <div className="h-1.5 bg-white/10 rounded-full overflow-hidden">
        <div
          className={`h-full rounded-full transition-all duration-500 ${active ? c.bar : 'bg-slate-600'}`}
          style={{ width: `${pct}%` }}
        />
      </div>
      <p className="text-xs text-slate-600 mt-1.5">Soglia attivazione: {Math.round(threshold * 100)}%</p>
    </div>
  );
};
