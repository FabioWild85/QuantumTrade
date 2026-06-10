import React, { useEffect, useState } from 'react';
import { Tooltip } from './Tooltip';

import { apiFetch } from '../../services/authService';
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
  cov_used: string[];
}

export const ForecastView: React.FC<{ apiBase: string }> = ({ apiBase }) => {
  const [data, setData]       = useState<ForecastData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError]     = useState<string | null>(null);

  const fetchForecast = async () => {
    setLoading(true);
    setError(null);
    try {
      const r = await apiFetch(`${apiBase}/forecast?symbol=BTC&horizon=3`);
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
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 mb-4">
        <div>
          <h2 className="text-xl font-bold text-slate-900 dark:text-white tracking-tight uppercase">Forecast Probabilistico</h2>
          <p className="text-xs font-medium text-slate-500 dark:text-slate-400 mt-1">
            amazon/chronos-2 · Orizzonte 12h (3×4h) · Regressione Quantile Deterministica
          </p>
        </div>
        <button
          onClick={fetchForecast}
          disabled={loading}
          className="w-full sm:w-auto px-6 py-2.5 bg-indigo-600 hover:bg-indigo-500 text-white text-sm font-bold rounded-xl transition-all shadow-lg shadow-indigo-500/20 active:scale-95 disabled:opacity-50 flex items-center justify-center gap-2"
        >
          {loading
            ? <><span className="inline-block w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />Inference…</>
            : '↻ Aggiorna Analisi'}
        </button>
      </div>

      {error && (
        <div className="rounded-xl bg-red-500/10 border border-red-500/30 p-4 text-sm text-red-400 font-mono">
          {error}
          <p className="text-xs text-red-500/60 mt-1">Assicurati che il backend sia avviato: <code>cd apps/api && uvicorn main:app --reload</code></p>
        </div>
      )}

      {loading && !data && (
        <div className="elegant-card p-16 text-center bg-white dark:bg-[#151E32]">
          <div className="inline-block w-10 h-10 border-2 border-indigo-500/30 border-t-indigo-500 rounded-full animate-spin mb-6" />
          <p className="text-slate-500 dark:text-slate-400 text-sm font-medium">Caricamento amazon/chronos-2 in memoria…</p>
          <p className="text-[10px] text-slate-400 dark:text-slate-500 mt-2">La prima richiesta può richiedere fino a 30s — il modello rimane in memoria per le successive</p>
        </div>
      )}

      {data && (
        <>
          {/* Price header */}
          <div className="elegant-card p-6 bg-white dark:bg-[#151E32]">
            <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-6 mb-8">
              <div>
                <div className="flex items-center gap-4">
                   <div className="p-3 bg-indigo-50 dark:bg-indigo-500/10 rounded-xl">
                      <svg className="w-6 h-6 text-indigo-500" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 7h8m0 0v8m0-8l-8 8-4-4-6 6" /></svg>
                   </div>
                   <div>
                      <p className="text-[10px] font-bold text-slate-400 dark:text-slate-500 uppercase tracking-widest">BTC Market Price</p>
                      <p className="text-4xl font-bold font-mono text-slate-900 dark:text-white tracking-tighter mt-0.5">
                        ${data.current_price.toLocaleString('en-US', { minimumFractionDigits: 2 })}
                      </p>
                      <p className="text-xs font-medium text-slate-500 dark:text-slate-400 mt-1">
                        Ultima candela 4h: {new Date(data.last_candle_time).toLocaleString('it-IT')}
                      </p>
                   </div>
                </div>
                {/* Covariate badges — horizontal row, indented to align with price text */}
                <div className="flex flex-wrap items-center gap-2 mt-3 ml-0 sm:ml-[3.75rem]">
                  <CovariatesBadges covUsed={data.cov_used ?? []} />
                </div>
              </div>
              <div className="text-left sm:text-right flex-shrink-0">
                <p className="text-[10px] font-bold text-slate-400 dark:text-slate-500 uppercase tracking-widest mb-1">Inferenza AI</p>
                <div className="flex items-center sm:justify-end gap-2">
                   <span className="w-1.5 h-1.5 bg-emerald-500 rounded-full animate-pulse"></span>
                   <p className="text-sm font-bold font-mono text-slate-700 dark:text-slate-300">{data.latency_ms.toFixed(0)}ms</p>
                </div>
                {data.atr && (
                  <div className="mt-3">
                    <p className="text-[10px] font-bold text-slate-400 dark:text-slate-500 uppercase tracking-widest mb-1">ATR (14)</p>
                    <p className="text-sm font-bold font-mono text-slate-600 dark:text-slate-400">${data.atr.toFixed(0)}</p>
                  </div>
                )}
              </div>
            </div>

            {/* SVG Fan Chart */}
            <div className="rounded-2xl bg-slate-50 dark:bg-black/20 border border-slate-100 dark:border-white/5 p-4 mb-8" style={{ height: 220 }}>
              <FanChartSVG
                currentPrice={data.current_price}
                fan={data.fan}
                horizonSteps={data.horizon_steps}
              />
            </div>

            {/* Quantile strip */}
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
              <Tooltip text="Decimo percentile della distribuzione quantile. Il 90% della distribuzione prevede un prezzo finale sopra questo livello." pos="bottom">
                <QuantileCard label="p10 — Pessimista" value={data.c2_p10} current={data.current_price} />
              </Tooltip>
              <Tooltip text="Mediana della distribuzione quantile — il prezzo centrale più probabile previsto da Chronos-2. Metà della distribuzione è sopra, metà sotto." pos="bottom">
                <QuantileCard label="p50 — Mediana" value={data.c2_p50} current={data.current_price} highlight />
              </Tooltip>
              <Tooltip text="Novantesimo percentile della distribuzione quantile. Solo il 10% della distribuzione prevede un prezzo finale sopra questo livello." pos="bottom">
                <QuantileCard label="p90 — Ottimista" value={data.c2_p90} current={data.current_price} />
              </Tooltip>
            </div>
          </div>

          {/* 3 probabilità */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <Tooltip text="Probabilità Direzionale: P(prezzo finale > prezzo attuale) stimata interpolando la CDF sui 21 quantili nativi di Chronos-2. Contribuisce al 40% dell'ensemble (LGBM 60% + C2 40%) — il gate reale è sull'ensemble a 62%, non su questo valore da solo." width="wide" pos="bottom">
              <ProbCard
                label="Directional Prob"
                description="P(prezzo sale entro 12h)"
                value={data.c2_dir_prob}
                threshold={0.62}
                color="indigo"
                gateType="ensemble"
              />
            </Tooltip>
            <Tooltip text="Probabilità di Volatilità: P(|ritorno| > 3%) stimata come P(prezzo > +3%) + P(prezzo < -3%) interpolando la distribuzione quantile. Indicatore informativo — non blocca né attiva trade." width="wide" pos="bottom">
              <ProbCard
                label="Volatility Prob"
                description="P(range > 3% in 12h)"
                value={data.c2_vol_prob}
                threshold={0.20}
                color="amber"
                gateType="display"
              />
            </Tooltip>
            <Tooltip text="Probabilità di Continuazione: imbalance netto tra bande quantili rialziste e ribassiste — le bande opposte si cancellano. Un fan simmetrico (metà su, metà giù) dà 0%; tutte le bande nella stessa direzione dà 100%. Soglia consigliata: 10%." width="wide" pos="bottom">
              <ProbCard
                label="Continuation Prob"
                description="P(bande quantili direzionali)"
                value={data.c2_cont_prob}
                threshold={0.10}
                color="emerald"
                gateType="gate"
              />
            </Tooltip>
          </div>

          {/* Uncertainty + p50 vs ATR */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <Tooltip text="Quanto il modello è incerto sulla previsione. Calcolata come (p90 − p10) / prezzo attuale. Sotto 4% = alta confidenza (verde), 4-8% = media (giallo), sopra 8% = bassa (rosso). Soglie calibrate per la volatilità tipica di BTC." width="wide" pos="top">
              <div className="elegant-card p-6 bg-white dark:bg-[#151E32] w-full h-full flex flex-col justify-between">
                <div>
                  <div className="flex items-center gap-3 mb-4">
                    <div className="p-2 bg-slate-50 dark:bg-white/5 rounded-lg">
                        <svg className="w-4 h-4 text-slate-500" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z" /></svg>
                    </div>
                    <p className="text-sm font-bold text-slate-700 dark:text-slate-300 uppercase tracking-wider">Incertezza Modello</p>
                  </div>
                  <p className={`text-3xl font-bold font-mono tracking-tighter ${
                    data.c2_uncertainty < 0.04 ? 'text-emerald-600 dark:text-emerald-400'
                    : data.c2_uncertainty < 0.08 ? 'text-amber-600 dark:text-amber-400' : 'text-rose-600 dark:text-rose-400'
                  }`}>
                    {(data.c2_uncertainty * 100).toFixed(2)}%
                  </p>
                </div>
                <p className="text-[10px] font-bold text-slate-400 dark:text-slate-500 uppercase mt-2">Confidenza: {data.c2_uncertainty < 0.04 ? 'Alta' : data.c2_uncertainty < 0.08 ? 'Media' : 'Bassa'}</p>
              </div>
            </Tooltip>
            <Tooltip text="Distanza tra il prezzo mediano previsto (p50) e il prezzo attuale, espressa in unità di ATR. Positivo = il modello prevede salita, negativo = prevede discesa. Vicino a 0 = nessuna direzione chiara." width="wide" pos="top">
              <div className="elegant-card p-6 bg-white dark:bg-[#151E32] w-full h-full flex flex-col justify-between">
                <div>
                  <div className="flex items-center gap-3 mb-4">
                    <div className="p-2 bg-slate-50 dark:bg-white/5 rounded-lg">
                        <svg className="w-4 h-4 text-slate-500" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 12l3-3 3 3 4-4M8 21l4-4 4 4M3 4h18M4 4h16v12a1 1 0 01-1 1H5a1 1 0 01-1-1V4z" /></svg>
                    </div>
                    <p className="text-sm font-bold text-slate-700 dark:text-slate-300 uppercase tracking-wider">p50 vs ATR</p>
                  </div>
                  <p className={`text-3xl font-bold font-mono tracking-tighter ${
                    Math.abs(data.c2_p50_vs_atr) < 0.5 ? 'text-slate-500'
                    : data.c2_p50_vs_atr > 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-rose-600 dark:text-rose-400'
                  }`}>
                    {data.c2_p50_vs_atr >= 0 ? '+' : ''}{data.c2_p50_vs_atr.toFixed(3)}
                  </p>
                </div>
                <p className="text-[10px] font-bold text-slate-400 dark:text-slate-500 uppercase mt-2">Bias Direzionale: {Math.abs(data.c2_p50_vs_atr) < 0.5 ? 'Neutro' : data.c2_p50_vs_atr > 0 ? 'Rialzista' : 'Ribassista'}</p>
              </div>
            </Tooltip>
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
            stroke="currentColor" className="text-slate-200 dark:text-white/5" strokeDasharray="3,5"
          />
          <text x={PAD.l - 8} y={py(price) + 4} textAnchor="end"
            fontSize="9" className="fill-slate-400 dark:fill-slate-500 font-bold" fontFamily="monospace">
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
        stroke="currentColor" className="text-slate-300 dark:text-white/20" strokeDasharray="5,5" strokeWidth="1"
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
      <text x={PAD.l - 8} y={py(currentPrice) + 4} textAnchor="end"
        fontSize="10" className="fill-slate-700 dark:fill-white font-bold" fontFamily="monospace">
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
      <text x={xs[n] + 8} y={py(p90[n]) + 4} textAnchor="start"
        fontSize="9" className="fill-slate-400 dark:fill-slate-500 font-bold" fontFamily="monospace">
        {fmtPrice(p90[n])}
      </text>
      <text x={xs[n] + 8} y={py(p10[n]) + 4} textAnchor="start"
        fontSize="9" className="fill-slate-400 dark:fill-slate-500 font-bold" fontFamily="monospace">
        {fmtPrice(p10[n])}
      </text>
    </svg>
  );
};

// ── Covariates badge row ───────────────────────────────────────────────────────

const COV_META: Record<string, { label: string; tooltip: string }> = {
  volume:  { label: "Vol.Ratio", tooltip: "Volume normalizzato (vol/media-20 barre) — valore >1 = attività sopra media, <1 = mercato quieto. Più stabile del volume grezzo tra regimi diversi" },
  funding: { label: "Funding",   tooltip: "Tasso di funding 8h — indica sentiment e leva del mercato futures. Positivo = mercato over-long, negativo = over-short" },
  oi:      { label: "OI",        tooltip: "Open Interest aggregato multi-exchange da Coinalyze — crescita = trend in forza con nuova leva, calo = distribuzione e chiusure" },
  cvd:     { label: "CVD",       tooltip: "Cumulative Volume Delta (approssimazione Haas) — misura pressione netta acquisti/vendite per candela 4h. Divergenza col prezzo = segnale di esaurimento" },
  liq:     { label: "Liq",       tooltip: "Rapporto liquidazioni long/totale (0–1) da Coinalyze — >0.7 = capitolazione long (potenziale bottom), <0.3 = short squeeze (potenziale top)" },
  premium: { label: "Premium",   tooltip: "Premium-z: z-score del basis spot-perp — proxy di posizionamento/flusso, complementare al funding (past covariate)" },
  calendar:{ label: "Calendar",  tooltip: "Ora-del-giorno + giorno-della-settimana (encoding ciclico sin/cos) come future_covariate — l'unico segnale noto in anticipo: sessioni, weekend, settlement funding" },
};

// cov_used reports the calendar channels by their raw names (hod_sin/…); the badge
// is keyed by 'calendar' and considered active when any calendar channel is present.
const COV_ACTIVE_KEY: Record<string, string> = {
  volume: 'volume', funding: 'funding', oi: 'oi', cvd: 'cvd', liq: 'liq',
  premium: 'premium', calendar: 'hod_sin',
};

const CovariatesBadges: React.FC<{ covUsed: string[] }> = ({ covUsed }) => {
  const all = ['volume', 'funding', 'oi', 'cvd', 'liq', 'premium', 'calendar'];
  return (
    <>
      {all.map(k => {
        const active = covUsed.includes(COV_ACTIVE_KEY[k] ?? k);
        const meta   = COV_META[k];
        return (
          <Tooltip key={k} text={active ? meta.tooltip : `${meta.label} non disponibile — Chronos opera senza questo covariate`} pos="bottom" fit>
            <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-[9px] font-bold uppercase tracking-wider cursor-default ${
              active
                ? 'bg-indigo-100 dark:bg-indigo-500/20 text-indigo-600 dark:text-indigo-400'
                : 'bg-slate-100 dark:bg-white/5 text-slate-400 dark:text-slate-600 line-through'
            }`}>
              <span className={`w-1 h-1 rounded-full ${active ? 'bg-indigo-500' : 'bg-slate-400'}`} />
              {meta.label}
            </span>
          </Tooltip>
        );
      })}
    </>
  );
};

// ── Sub-components ────────────────────────────────────────────────────────────

const QuantileCard: React.FC<{
  label: string; value: number; current: number; highlight?: boolean;
}> = ({ label, value, current, highlight }) => {
  const diff = (value - current) / current * 100;
  const up = value >= current;
  return (
    <div className={`rounded-xl p-4 border transition-all w-full h-full flex flex-col justify-between ${
      highlight ? 'border-indigo-600/20 dark:border-indigo-500/40 bg-indigo-50 dark:bg-indigo-500/10 shadow-md' : 'border-slate-200 dark:border-white/5 bg-slate-50 dark:bg-white/5 hover:border-slate-300 dark:hover:border-white/10'
    }`}>
      <p className="text-[10px] font-bold text-slate-400 dark:text-slate-500 uppercase tracking-widest mb-1">{label}</p>
      <div>
        <p className={`text-xl font-bold font-mono tracking-tighter ${highlight ? 'text-indigo-600 dark:text-indigo-400' : 'text-slate-900 dark:text-white'}`}>
          ${value.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}
        </p>
        <p className={`text-[10px] font-bold font-mono mt-0.5 ${up ? 'text-emerald-600 dark:text-emerald-400' : 'text-rose-600 dark:text-rose-400'}`}>
          {up ? '▲' : '▼'} {diff.toFixed(2)}%
        </p>
      </div>
    </div>
  );
};

const ProbCard: React.FC<{
  label: string; description: string; value: number; threshold: number;
  color: 'indigo' | 'amber' | 'emerald';
  gateType: 'ensemble' | 'gate' | 'display';
}> = ({ label, description, value, threshold, color, gateType }) => {
  const pct    = Math.round(value * 100);
  const active = value > threshold;
  const cols   = {
    indigo:  { border: 'border-indigo-600/20 dark:border-indigo-500/30',  bg: 'bg-indigo-50 dark:bg-indigo-500/5',  bar: 'bg-indigo-600 dark:bg-indigo-500',  txt: 'text-indigo-600 dark:text-indigo-400'  },
    amber:   { border: 'border-amber-600/20 dark:border-amber-500/30',   bg: 'bg-amber-50 dark:bg-amber-500/5',   bar: 'bg-amber-600 dark:bg-amber-500',   txt: 'text-amber-600 dark:text-amber-400'   },
    emerald: { border: 'border-emerald-600/20 dark:border-emerald-500/30', bg: 'bg-emerald-50 dark:bg-emerald-500/5', bar: 'bg-emerald-600 dark:bg-emerald-500', txt: 'text-emerald-600 dark:text-emerald-400' },
  };
  const c = cols[color];
  const gateLabel = gateType === 'ensemble'
    ? `Soglia ensemble: ${Math.round(threshold * 100)}%`
    : gateType === 'gate'
    ? `Gate opt-in: ${Math.round(threshold * 100)}%`
    : `Soglia indicativa: ${Math.round(threshold * 100)}%`;
  return (
    <div className={`elegant-card p-6 transition-all w-full h-full flex flex-col justify-between ${active ? `${c.border} ${c.bg}` : 'border-slate-200 dark:border-white/5 bg-white dark:bg-[#151E32]'}`}>
      <p className="text-[10px] font-bold text-slate-400 dark:text-slate-500 uppercase tracking-widest mb-1">{label}</p>
      <p className="text-xs font-medium text-slate-500 dark:text-slate-400 mb-4">{description}</p>
      <div className="flex items-baseline gap-2 mb-4">
        <p className={`text-4xl font-bold font-mono tracking-tighter ${active ? c.txt : 'text-slate-400 dark:text-slate-500'}`}>{pct}%</p>
        {active && <span className={`text-[10px] font-bold uppercase ${c.txt} tracking-wider animate-pulse`}>Sopra Soglia</span>}
      </div>
      <div className="h-2 bg-slate-100 dark:bg-white/5 rounded-full overflow-hidden">
        <div
          className={`h-full rounded-full transition-all duration-700 ${active ? c.bar : 'bg-slate-300 dark:bg-slate-700'}`}
          style={{ width: `${pct}%` }}
        />
      </div>
      <p className="text-[10px] font-bold text-slate-400 dark:text-slate-500 uppercase mt-3">{gateLabel}</p>
    </div>
  );
};
