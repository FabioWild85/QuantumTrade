import React, { useCallback, useEffect, useState } from 'react';
import { apiFetch } from '../../services/authService';

// ── Tipi ──────────────────────────────────────────────────────────────────────
interface ProviderInfo { available: boolean; models: { id: string; label: string }[]; }
type Providers = Record<string, ProviderInfo>;

interface AIDecision {
  id: number;
  created_at: string;
  provider: string | null;
  model: string | null;
  shadow_mode: boolean | null;
  proposed_action: string | null;
  final_action: string | null;
  changed_decision: boolean | null;
  agreement: string | null;
  conviction: number | null;
  bias: string | null;
  threshold_adjustment: number | null;
  flags: string[] | null;
  invalidation_level: number | null;
  report_it: string | null;
  latency_ms: number | null;
  error: string | null;
  dossier: any;
}

interface Stats { total: number; confirm: number; neutral: number; veto: number; changed: number; fail_open: number; }

const PROVIDER_LABEL: Record<string, string> = {
  anthropic: 'Anthropic (Claude)', gemini: 'Google (Gemini)',
  openai: 'OpenAI (GPT)', deepseek: 'DeepSeek',
};

// ── Sub-componenti ──────────────────────────────────────────────────────────────
const Toggle: React.FC<{ checked: boolean; onChange: (v: boolean) => void; disabled?: boolean }> =
  ({ checked, onChange, disabled }) => (
  <button
    type="button"
    disabled={disabled}
    onClick={() => onChange(!checked)}
    className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
      checked ? 'bg-indigo-500' : 'bg-gray-300 dark:bg-gray-600'
    } ${disabled ? 'opacity-40 cursor-not-allowed' : ''}`}
  >
    <span className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
      checked ? 'translate-x-6' : 'translate-x-1'}`} />
  </button>
);

const Row: React.FC<{ label: string; hint?: string; children: React.ReactNode }> =
  ({ label, hint, children }) => (
  <div className="flex flex-col gap-2 py-2.5 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
    <div className="min-w-0">
      <div className="text-sm font-medium text-gray-800 dark:text-gray-200">{label}</div>
      {hint && <div className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">{hint}</div>}
    </div>
    <div className="flex-shrink-0 w-full sm:w-auto">{children}</div>
  </div>
);

const Slider: React.FC<{ value: number; min: number; max: number; step: number; onChange: (v: number) => void; suffix?: string }> =
  ({ value, min, max, step, onChange, suffix }) => (
  <div className="flex items-center gap-3 w-full sm:w-56">
    <input type="range" min={min} max={max} step={step} value={value}
      onChange={(e) => onChange(parseFloat(e.target.value))}
      className="flex-1 accent-indigo-500" />
    <span className="text-sm font-mono text-gray-700 dark:text-gray-300 w-14 text-right">
      {value}{suffix}</span>
  </div>
);

const agreementStyle = (a: string | null): { label: string; cls: string } => {
  switch (a) {
    case 'veto':    return { label: 'VETO',    cls: 'bg-rose-100 text-rose-700 dark:bg-rose-500/20 dark:text-rose-300' };
    case 'confirm': return { label: 'CONFERMA', cls: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-500/20 dark:text-emerald-300' };
    default:        return { label: 'NEUTRO',  cls: 'bg-gray-100 text-gray-600 dark:bg-gray-700 dark:text-gray-300' };
  }
};

const actionLabel = (a: string | null) =>
  a === 'long' ? 'LONG' : a === 'short' ? 'SHORT' : 'NO-TRADE';

// ── Pagina ──────────────────────────────────────────────────────────────────────
export const AILayerPanel: React.FC<{ apiBase: string }> = ({ apiBase }) => {
  const [cfg, setCfg] = useState<Record<string, any> | null>(null);
  const [providers, setProviders] = useState<Providers>({});
  const [decisions, setDecisions] = useState<AIDecision[]>([]);
  const [stats, setStats] = useState<Stats | null>(null);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  const loadAll = useCallback(async () => {
    try {
      const [cfgR, provR, decR, statR] = await Promise.all([
        apiFetch(`${apiBase}/bot`),
        apiFetch(`${apiBase}/ai-layer/providers`),
        apiFetch(`${apiBase}/ai-layer/decisions?limit=40`),
        apiFetch(`${apiBase}/ai-layer/stats`),
      ]);
      setCfg(await cfgR.json());
      setProviders(await provR.json());
      setDecisions((await decR.json()).decisions ?? []);
      setStats(await statR.json());
      setError(null);
    } catch (e: any) {
      setError(e?.message ?? 'Errore di caricamento');
    }
  }, [apiBase]);

  useEffect(() => { loadAll(); }, [loadAll]);

  const set = (key: string, val: any) => {
    setCfg((c) => (c ? { ...c, [key]: val } : c));
    setDirty(true);
  };

  const save = async () => {
    if (!cfg) return;
    setSaving(true);
    try {
      const res = await apiFetch(`${apiBase}/bot`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(cfg),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setDirty(false);
    } catch (e: any) {
      setError(`Salvataggio fallito: ${e?.message ?? e}`);
    } finally {
      setSaving(false);
    }
  };

  const runTest = async () => {
    setTesting(true); setTestResult(null);
    try {
      const res = await apiFetch(`${apiBase}/ai-layer/test`, { method: 'POST' });
      const data = await res.json();
      if (data.ok) {
        const v = data.verdict;
        setTestResult(`✅ ${agreementStyle(v.agreement).label} · conv ${v.conviction} · ${v.report_it}`);
      } else {
        setTestResult(`⚠️ ${data.error ?? 'Test fallito'}`);
      }
    } catch (e: any) {
      setTestResult(`⚠️ ${e?.message ?? 'Errore'}`);
    } finally {
      setTesting(false);
    }
  };

  if (!cfg) {
    return (
      <div className="p-6 text-gray-500 dark:text-gray-400">
        {error ? `Errore: ${error}` : 'Caricamento…'}
      </div>
    );
  }

  const provider = cfg.ai_layer_provider ?? 'anthropic';
  const provModels = providers[provider]?.models ?? [];
  const enabled = !!cfg.ai_layer_enabled;
  const shadow = !!cfg.ai_layer_shadow_mode;

  return (
    <div className="p-4 sm:p-6 max-w-5xl mx-auto space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-xl font-bold text-gray-900 dark:text-white flex items-center gap-2">
            <span className="w-2.5 h-2.5 rounded-full bg-indigo-500" /> Modello AI
          </h1>
          <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">
            Un LLM giudica ogni decisione del modello prima del trade, con contesto strutturale e macro che il modello non vede.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <span className={`px-2.5 py-1 rounded-full text-xs font-semibold ${
            !enabled ? 'bg-gray-100 text-gray-500 dark:bg-gray-700 dark:text-gray-400'
            : shadow ? 'bg-amber-100 text-amber-700 dark:bg-amber-500/20 dark:text-amber-300'
            : 'bg-emerald-100 text-emerald-700 dark:bg-emerald-500/20 dark:text-emerald-300'
          }`}>
            {!enabled ? 'SPENTO' : shadow ? 'SHADOW' : 'ATTIVO'}
          </span>
          <button onClick={save} disabled={!dirty || saving}
            className={`px-4 py-1.5 rounded-lg text-sm font-medium transition-colors ${
              dirty ? 'bg-indigo-500 hover:bg-indigo-600 text-white' : 'bg-gray-100 text-gray-400 dark:bg-gray-700 cursor-default'
            }`}>
            {saving ? 'Salvataggio…' : dirty ? 'Salva' : 'Salvato'}
          </button>
        </div>
      </div>

      {error && <div className="text-sm text-rose-600 dark:text-rose-400">{error}</div>}

      {/* A — Controllo */}
      <Section title="Controllo">
        <Row label="Attiva valutazione AI" hint="OFF = il sistema opera identico a oggi (solo modello).">
          <Toggle checked={enabled} onChange={(v) => set('ai_layer_enabled', v)} />
        </Row>
        <Row label="Shadow mode" hint="Logga il giudizio senza influenzare le decisioni. Consigliato per le prime settimane.">
          <Toggle checked={shadow} onChange={(v) => set('ai_layer_shadow_mode', v)} />
        </Row>
        <Row label="Valuta anche i no-trade" hint="L'AI elabora un giudizio anche quando il modello sta fuori (informativo in v1).">
          <Toggle checked={!!cfg.ai_layer_evaluate_no_trade} onChange={(v) => set('ai_layer_evaluate_no_trade', v)} />
        </Row>
      </Section>

      {/* B — Modello AI */}
      <Section title="Modello AI">
        <Row label="Provider" hint="I provider senza chiave API configurata non sono selezionabili.">
          <select value={provider}
            onChange={(e) => {
              const p = e.target.value;
              const first = providers[p]?.models?.[0]?.id;
              setCfg((c) => c ? { ...c, ai_layer_provider: p, ...(first ? { ai_layer_model: first } : {}) } : c);
              setDirty(true);
            }}
            className="w-full sm:w-56 px-3 py-1.5 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-sm text-gray-800 dark:text-gray-200">
            {Object.keys(providers).length === 0 && <option value={provider}>{PROVIDER_LABEL[provider] ?? provider}</option>}
            {Object.entries(providers).map(([p, info]) => {
              const i = info as ProviderInfo;
              return (
                <option key={p} value={p} disabled={!i.available}>
                  {PROVIDER_LABEL[p] ?? p}{i.available ? '' : ' — chiave mancante'}
                </option>
              );
            })}
          </select>
        </Row>
        <Row label="Modello" hint="Versione/tipo specifico del provider scelto.">
          <select value={cfg.ai_layer_model ?? ''}
            onChange={(e) => set('ai_layer_model', e.target.value)}
            className="w-full sm:w-56 px-3 py-1.5 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-sm text-gray-800 dark:text-gray-200">
            {provModels.length === 0 && <option value={cfg.ai_layer_model}>{cfg.ai_layer_model}</option>}
            {provModels.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
          </select>
        </Row>
        <Row label="Modalità dossier" hint="'Completo' include le opinioni del modello (prob, reasoning); 'Ortogonale' solo fatti oggettivi (giudizio AI indipendente). In shadow puoi confrontarle.">
          <select value={cfg.ai_layer_dossier_mode ?? 'full'}
            onChange={(e) => set('ai_layer_dossier_mode', e.target.value)}
            className="w-full sm:w-56 px-3 py-1.5 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-sm text-gray-800 dark:text-gray-200">
            <option value="full">Completo (con opinioni modello)</option>
            <option value="orthogonal">Ortogonale (solo fatti)</option>
          </select>
        </Row>
        <Row label="Test ora" hint="Valuta l'ultimo dossier salvato senza eseguire trade. Verifica chiave + connettività.">
          <button onClick={runTest} disabled={testing}
            className="px-3 py-1.5 rounded-lg text-sm font-medium bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-200 hover:bg-gray-200 dark:hover:bg-gray-600">
            {testing ? 'Test in corso…' : 'Esegui test'}
          </button>
        </Row>
        {testResult && (
          <div className="text-sm mt-1 p-3 rounded-lg bg-gray-50 dark:bg-gray-800/60 text-gray-700 dark:text-gray-300">
            {testResult}
          </div>
        )}
      </Section>

      {/* C — Parametri d'influenza */}
      <Section title="Parametri d'influenza">
        <Row label="Peso" hint="Quanto pesa l'AI (0 = nullo, 1 = pieno).">
          <Slider value={cfg.ai_layer_weight ?? 1} min={0} max={1} step={0.05}
            onChange={(v) => set('ai_layer_weight', v)} />
        </Row>
        <Row label="Clamp massimo soglia" hint="Spostamento massimo della soglia per ciclo.">
          <Slider value={cfg.ai_layer_clamp_max ?? 0.08} min={0} max={0.2} step={0.01}
            onChange={(v) => set('ai_layer_clamp_max', v)} />
        </Row>
        <Row label="Conviction minima" hint="Sotto questa soglia il verdetto è ignorato (solo log).">
          <Slider value={cfg.ai_layer_min_conviction ?? 60} min={0} max={100} step={5}
            onChange={(v) => set('ai_layer_min_conviction', v)} />
        </Row>
        <Row label="Timeout (s)" hint="Oltre questo limite → fail-open (solo modello).">
          <Slider value={cfg.ai_layer_timeout_s ?? 30} min={5} max={120} step={5}
            onChange={(v) => set('ai_layer_timeout_s', v)} suffix="s" />
        </Row>
        <Row label="Veto duro" hint="Se l'AI vota 'veto' → blocca il trade. È il filtro principale.">
          <Toggle checked={!!cfg.ai_layer_hard_veto} onChange={(v) => set('ai_layer_hard_veto', v)} />
        </Row>
        <Row label="Permetti di facilitare" hint="Abilita solo dopo validazione forward: l'AI può aprire trade che il modello scarta.">
          <Toggle checked={!!cfg.ai_layer_allow_easing} onChange={(v) => set('ai_layer_allow_easing', v)} />
        </Row>
      </Section>

      {/* E — Statistiche */}
      {stats && stats.total > 0 && (
        <Section title="Statistiche (ultime decisioni)">
          <div className="grid grid-cols-2 sm:grid-cols-5 gap-3 pt-1">
            <Stat label="Totale" value={stats.total} />
            <Stat label="Conferme" value={stats.confirm} color="text-emerald-600 dark:text-emerald-400" />
            <Stat label="Veto" value={stats.veto} color="text-rose-600 dark:text-rose-400" />
            <Stat label="Decisioni cambiate" value={stats.changed} color="text-indigo-600 dark:text-indigo-400" />
            <Stat label="Fail-open" value={stats.fail_open} color="text-amber-600 dark:text-amber-400" />
          </div>
        </Section>
      )}

      {/* D — Log decisioni */}
      <Section title="Log decisioni">
        {decisions.length === 0 ? (
          <p className="text-sm text-gray-500 dark:text-gray-400 py-4">
            Nessuna decisione ancora. Attiva l'AI Layer e avvia il bot: ogni ciclo 4H comparirà qui.
          </p>
        ) : (
          <div className="space-y-3 pt-1">
            {decisions.map((d) => {
              const ag = agreementStyle(d.agreement);
              return (
                <div key={d.id} className="rounded-xl border border-gray-200 dark:border-gray-700 p-3.5">
                  <div className="flex items-center justify-between flex-wrap gap-2">
                    <div className="flex items-center gap-2 text-sm">
                      <span className="text-gray-400 dark:text-gray-500">
                        {new Date(d.created_at).toLocaleString('it-IT', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })}
                      </span>
                      <span className="font-semibold text-gray-700 dark:text-gray-300">
                        {actionLabel(d.proposed_action)}
                      </span>
                      <span className="text-gray-400">→</span>
                      <span className="font-semibold text-gray-700 dark:text-gray-300">
                        {actionLabel(d.final_action)}
                      </span>
                      {d.changed_decision && (
                        <span className="text-xs px-1.5 py-0.5 rounded bg-indigo-100 text-indigo-700 dark:bg-indigo-500/20 dark:text-indigo-300">
                          🔵 cambiata
                        </span>
                      )}
                    </div>
                    <div className="flex items-center gap-2">
                      {d.error === 'fail_open'
                        ? <span className="text-xs px-2 py-0.5 rounded-full bg-amber-100 text-amber-700 dark:bg-amber-500/20 dark:text-amber-300">fail-open</span>
                        : <span className={`text-xs px-2 py-0.5 rounded-full font-semibold ${ag.cls}`}>{ag.label}</span>}
                      {d.shadow_mode && <span className="text-xs px-2 py-0.5 rounded-full bg-gray-100 text-gray-500 dark:bg-gray-700 dark:text-gray-400">shadow</span>}
                    </div>
                  </div>

                  {d.report_it ? (
                    <p className="text-sm text-gray-700 dark:text-gray-200 mt-2 leading-relaxed">{d.report_it}</p>
                  ) : d.error === 'fail_open' ? (
                    <p className="text-sm text-amber-600 dark:text-amber-400 mt-2 leading-relaxed">
                      L'AI non ha risposto in questo ciclo (fail-open) — nessun giudizio prodotto.
                      Il bot ha operato col solo modello. Cause tipiche: timeout o errore temporaneo dell'API.
                    </p>
                  ) : (
                    <p className="text-sm text-gray-400 dark:text-gray-500 mt-2 italic">Nessuna spiegazione testuale per questa decisione.</p>
                  )}

                  {(d.conviction != null || d.flags?.length) && (
                    <div className="flex items-center flex-wrap gap-1.5 mt-2 text-xs">
                      {d.conviction != null && <span className="text-gray-500 dark:text-gray-400">conv {d.conviction}</span>}
                      {d.threshold_adjustment != null && <span className="text-gray-500 dark:text-gray-400">· adj {d.threshold_adjustment > 0 ? '+' : ''}{d.threshold_adjustment}</span>}
                      {d.invalidation_level != null && <span className="text-gray-500 dark:text-gray-400">· inval ${Math.round(d.invalidation_level).toLocaleString('en-US')}</span>}
                      {d.latency_ms != null && <span className="text-gray-400 dark:text-gray-500">· {d.latency_ms}ms</span>}
                      {(d.flags ?? []).map((f) => (
                        <span key={f} className="px-1.5 py-0.5 rounded bg-gray-100 text-gray-600 dark:bg-gray-700 dark:text-gray-300">{f}</span>
                      ))}
                    </div>
                  )}

                  <button onClick={() => setExpanded(expanded === d.id ? null : d.id)}
                    className="text-xs text-indigo-500 hover:text-indigo-600 mt-2">
                    {expanded === d.id ? 'Nascondi dossier' : 'Mostra dossier'}
                  </button>
                  {expanded === d.id && (
                    <pre className="mt-2 p-3 rounded-lg bg-gray-50 dark:bg-gray-900/60 text-xs text-gray-600 dark:text-gray-400 overflow-x-auto max-h-80">
                      {JSON.stringify(d.dossier, null, 2)}
                    </pre>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </Section>
    </div>
  );
};

// ── Helpers di layout ─────────────────────────────────────────────────────────
const Section: React.FC<{ title: string; children: React.ReactNode }> = ({ title, children }) => (
  <div className="rounded-2xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800/40 p-4 sm:p-5">
    <h2 className="text-sm font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide mb-1">{title}</h2>
    <div className="divide-y divide-gray-100 dark:divide-gray-700/50">{children}</div>
  </div>
);

const Stat: React.FC<{ label: string; value: number; color?: string }> = ({ label, value, color }) => (
  <div className="rounded-xl bg-gray-50 dark:bg-gray-800/60 p-3 text-center">
    <div className={`text-2xl font-bold ${color ?? 'text-gray-800 dark:text-gray-200'}`}>{value}</div>
    <div className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">{label}</div>
  </div>
);
