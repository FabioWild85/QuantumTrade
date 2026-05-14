import React, { useState, useEffect } from 'react';

interface FeatureFlags {
  trailing_sl_enabled: boolean;
  trailing_sl_activation: number;
  partial_tp_enabled: boolean;
  partial_tp_atr_mult: number;
  partial_tp_pct: number;
  confluence_gate: number;
  adx_gate: number;
  directional_threshold: number;
}

export const HubSettings: React.FC<{ apiBase: string }> = ({ apiBase }) => {
  const [walletAddress, setWalletAddress] = useState('');
  const [agentResult, setAgentResult]     = useState<string | null>(null);
  const [connecting, setConnecting]       = useState(false);
  const [flags, setFlags]                 = useState<FeatureFlags>({
    trailing_sl_enabled:    false,
    trailing_sl_activation: 1.0,
    partial_tp_enabled:     false,
    partial_tp_atr_mult:    1.5,
    partial_tp_pct:         50.0,
    confluence_gate:        60.0,
    adx_gate:               20.0,
    directional_threshold:  0.62,
  });
  const [saving, setSaving]     = useState(false);
  const [saveMsg, setSaveMsg]   = useState<string | null>(null);

  useEffect(() => {
    fetch(`${apiBase}/bot`)
      .then(r => r.ok ? r.json() : null)
      .then(d => { if (d) setFlags(f => ({ ...f, ...d })); })
      .catch(() => {});
  }, [apiBase]);

  const saveFlags = async () => {
    setSaving(true); setSaveMsg(null);
    try {
      const r = await fetch(`${apiBase}/bot`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...flags, mode: 'paper' }),
      });
      setSaveMsg(r.ok ? '✓ Impostazioni salvate' : '❌ Errore salvataggio');
    } catch { setSaveMsg('❌ Errore salvataggio'); }
    finally { setSaving(false); setTimeout(() => setSaveMsg(null), 3000); }
  };

  const setFlag = <K extends keyof FeatureFlags>(k: K, v: FeatureFlags[K]) =>
    setFlags(f => ({ ...f, [k]: v }));

  const connectWallet = async () => {
    if (!walletAddress.startsWith('0x')) {
      alert('Inserisci un indirizzo wallet valido (0x…)');
      return;
    }
    setConnecting(true);
    try {
      const r = await fetch(`${apiBase}/wallet/connect`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ address: walletAddress }),
      });
      const d = await r.json();
      setAgentResult(`✓ Wallet connesso: ${d.address}`);
    } catch {
      setAgentResult('❌ Errore connessione wallet');
    } finally {
      setConnecting(false);
    }
  };

  const createAgent = async () => {
    if (!walletAddress) {
      alert('Prima connetti il wallet principale');
      return;
    }
    if (!confirm('Crea un agent wallet su Hyperliquid testnet? (chiave salvata cifrata su Supabase)')) return;
    setConnecting(true);
    try {
      const r = await fetch(`${apiBase}/wallet/agent`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ main_address: walletAddress, agent_name: 'trading-hub-agent' }),
      });
      const d = await r.json();
      setAgentResult(`✓ Agent creato: ${d.agent_address} (${d.network})`);
    } catch {
      setAgentResult('❌ Errore creazione agent');
    } finally {
      setConnecting(false);
    }
  };

  return (
    <div className="space-y-6 max-w-2xl">
      <div>
        <h2 className="text-lg font-bold text-white">Settings</h2>
        <p className="text-xs text-slate-500 mt-0.5">Wallet, agent, kill-switch globale, notifiche</p>
      </div>

      {/* Wallet */}
      <Section title="🔑 Wallet" description="Connetti il tuo wallet principale e crea l'agent wallet per il trading automatico.">
        <label className="text-xs text-slate-500 block mb-1">Indirizzo wallet principale (0x…)</label>
        <input
          type="text"
          value={walletAddress}
          onChange={e => setWalletAddress(e.target.value)}
          placeholder="0xF5e16B42c9126fFF754…"
          className="w-full bg-white/5 border border-dark-border rounded-lg px-3 py-2 text-sm font-mono text-white placeholder-slate-700 focus:outline-none focus:border-indigo-500 transition-colors mb-3"
        />
        <div className="flex gap-3">
          <button
            onClick={connectWallet}
            disabled={connecting}
            className="flex-1 py-2.5 bg-indigo-600 hover:bg-indigo-500 text-white text-sm font-semibold rounded-xl transition-colors disabled:opacity-50"
          >
            Connetti Wallet
          </button>
          <button
            onClick={createAgent}
            disabled={connecting}
            className="flex-1 py-2.5 bg-slate-700 hover:bg-slate-600 text-white text-sm font-semibold rounded-xl transition-colors disabled:opacity-50"
          >
            Crea Agent Wallet
          </button>
        </div>
        {agentResult && (
          <p className={`mt-3 text-xs font-mono p-3 rounded-lg ${agentResult.startsWith('✓') ? 'bg-emerald-500/10 text-emerald-400' : 'bg-red-500/10 text-red-400'}`}>
            {agentResult}
          </p>
        )}
        <p className="text-xs text-slate-600 mt-3">
          L'agent wallet ha permessi solo trading (no withdraw). La private key è cifrata con AES-256 prima di essere salvata su Supabase. Puoi revocarla in qualsiasi momento da Hyperliquid.
        </p>
      </Section>

      {/* Trading Strategy Toggles */}
      <Section title="⚡ Strategie di Trading" description="Abilita o disabilita modalità avanzate. Le modifiche vengono applicate al prossimo ciclo del bot.">
        <div className="space-y-5">
          <ToggleRow
            label="Trailing Stop Loss"
            desc="Sposta SL al break-even quando il prezzo si muove a favore di trading_sl_activation × ATR. Riduce i trade che tornano in perdita dopo essere stati in profitto."
            checked={flags.trailing_sl_enabled}
            onChange={v => setFlag('trailing_sl_enabled', v)}
          >
            {flags.trailing_sl_enabled && (
              <NumInput label="Attivazione (× ATR)" value={flags.trailing_sl_activation} onChange={v => setFlag('trailing_sl_activation', v)} step={0.1} min={0.5} max={3} />
            )}
          </ToggleRow>

          <ToggleRow
            label="Partial Take Profit"
            desc="Chiudi una quota della posizione al primo target di prezzo, lascia il resto correre fino al TP finale. Migliora il profit factor riducendo i gain che si trasformano in loss."
            checked={flags.partial_tp_enabled}
            onChange={v => setFlag('partial_tp_enabled', v)}
          >
            {flags.partial_tp_enabled && (
              <div className="flex gap-4 flex-wrap">
                <NumInput label="Target (× ATR)" value={flags.partial_tp_atr_mult} onChange={v => setFlag('partial_tp_atr_mult', v)} step={0.1} min={0.5} max={5} />
                <NumInput label="Quota da chiudere (%)" value={flags.partial_tp_pct} onChange={v => setFlag('partial_tp_pct', v)} step={5} min={10} max={90} />
              </div>
            )}
          </ToggleRow>

          <div className="border-t border-dark-border pt-4 grid grid-cols-1 sm:grid-cols-3 gap-4">
            <NumInput label="ADX Gate (no-trade)" value={flags.adx_gate} onChange={v => setFlag('adx_gate', v)} step={1} min={10} max={40} />
            <NumInput label="Directional Threshold" value={flags.directional_threshold} onChange={v => setFlag('directional_threshold', v)} step={0.01} min={0.5} max={0.9} />
            <NumInput label="Confluence Gate (%)" value={flags.confluence_gate} onChange={v => setFlag('confluence_gate', v)} step={5} min={0} max={100} />
          </div>

          <div className="flex items-center gap-3">
            <button onClick={saveFlags} disabled={saving}
              className="px-5 py-2.5 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white text-sm font-semibold rounded-lg transition-colors">
              {saving ? 'Salvataggio…' : 'Salva e Applica'}
            </button>
            {saveMsg && <span className={`text-xs font-mono ${saveMsg.startsWith('✓') ? 'text-emerald-400' : 'text-red-400'}`}>{saveMsg}</span>}
          </div>
        </div>
      </Section>

      {/* Kill Switch */}
      <Section title="🔴 Kill Switch Globale" description="Cancella tutti gli ordini aperti e chiude tutte le posizioni immediatamente. Irreversibile.">
        <button
          onClick={async () => {
            if (!confirm('⚠️ KILL SWITCH: chiude tutto immediatamente. Sei sicuro?')) return;
            const r = await fetch(`${apiBase}/bot/kill`, { method: 'POST' });
            const d = await r.json();
            alert(`Kill completato. Posizioni chiuse: ${d.positions_closed}. Ordini cancellati: ${d.orders_cancelled}.`);
          }}
          className="px-6 py-3 bg-red-700 hover:bg-red-600 text-white text-sm font-bold rounded-xl transition-colors"
        >
          🔴 Attiva Kill Switch
        </button>
      </Section>

      {/* Telegram */}
      <Section title="📱 Notifiche Telegram" description="Configura il bot Telegram per ricevere alert su trade, errori e heartbeat mancanti.">
        <div className="space-y-3">
          <InfoRow label="TELEGRAM_BOT_TOKEN" value="Imposta in apps/api/.env" />
          <InfoRow label="TELEGRAM_CHAT_ID" value="Imposta in apps/api/.env" />
        </div>
        <div className="mt-4 p-3 rounded-xl bg-white/5 text-xs text-slate-500 font-mono space-y-1">
          <p>1. Crea bot su @BotFather → ottieni il token</p>
          <p>2. Manda un messaggio al bot → prendi il chat_id da:</p>
          <p className="text-indigo-400">   https://api.telegram.org/bot&lt;TOKEN&gt;/getUpdates</p>
          <p>3. Aggiorna apps/api/.env con i valori</p>
          <p>4. Riavvia il backend</p>
        </div>
      </Section>

      {/* Supabase */}
      <Section title="🗄 Database (Supabase)" description="Configura Supabase per persistere trade, inference log, equity snapshot e ricevere push realtime.">
        <div className="space-y-3">
          <InfoRow label="SUPABASE_URL" value="Imposta in apps/api/.env" />
          <InfoRow label="SUPABASE_SERVICE_ROLE_KEY" value="Imposta in apps/api/.env" />
        </div>
        <div className="mt-4 p-3 rounded-xl bg-white/5 text-xs text-slate-500 space-y-1">
          <p>1. Crea progetto su supabase.com (free tier)</p>
          <p>2. Dashboard → Settings → API → copia Project URL e service_role key</p>
          <p>3. Esegui lo schema: Dashboard → SQL Editor → incolla il contenuto di <code className="text-indigo-400">apps/api/db/schema.sql</code></p>
          <p>4. Abilita Realtime su: equity_snapshots, orders, inference_logs, events</p>
        </div>
      </Section>
    </div>
  );
};

const Section: React.FC<{ title: string; description: string; children: React.ReactNode }> = ({ title, description, children }) => (
  <div className="rounded-2xl bg-dark-card border border-dark-border p-5">
    <h3 className="text-sm font-bold text-slate-300 mb-0.5">{title}</h3>
    <p className="text-xs text-slate-500 mb-4">{description}</p>
    {children}
  </div>
);

const InfoRow: React.FC<{ label: string; value: string }> = ({ label, value }) => (
  <div className="flex items-center justify-between text-xs">
    <span className="font-mono text-slate-400">{label}</span>
    <span className="text-slate-600">{value}</span>
  </div>
);

const ToggleRow: React.FC<{
  label: string; desc: string; checked: boolean;
  onChange: (v: boolean) => void; children?: React.ReactNode;
}> = ({ label, desc, checked, onChange, children }) => (
  <div className="space-y-2">
    <label className="flex items-start gap-3 cursor-pointer">
      <div className="relative mt-0.5 flex-shrink-0">
        <input type="checkbox" className="sr-only" checked={checked} onChange={e => onChange(e.target.checked)} />
        <div className={`w-10 h-5 rounded-full transition-colors ${checked ? 'bg-indigo-600' : 'bg-slate-700'}`} />
        <div className={`absolute top-0.5 left-0.5 w-4 h-4 bg-white rounded-full shadow transition-transform ${checked ? 'translate-x-5' : ''}`} />
      </div>
      <div>
        <p className="text-sm font-medium text-slate-300">{label}</p>
        <p className="text-xs text-slate-600 mt-0.5">{desc}</p>
      </div>
    </label>
    {checked && children && <div className="ml-13 pl-1">{children}</div>}
  </div>
);

const NumInput: React.FC<{
  label: string; value: number; onChange: (v: number) => void;
  step?: number; min?: number; max?: number;
}> = ({ label, value, onChange, step = 0.1, min, max }) => (
  <label className="flex flex-col gap-1">
    <span className="text-xs text-slate-500">{label}</span>
    <input type="number" value={value} step={step} min={min} max={max}
      onChange={e => onChange(parseFloat(e.target.value))}
      className="w-28 bg-dark-bg border border-dark-border rounded-lg px-3 py-1.5 text-sm text-white focus:outline-none focus:border-indigo-500" />
  </label>
);
