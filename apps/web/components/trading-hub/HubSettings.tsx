import React, { useState } from 'react';

export const HubSettings: React.FC<{ apiBase: string }> = ({ apiBase }) => {
  const [walletAddress, setWalletAddress] = useState('');
  const [agentResult, setAgentResult]     = useState<string | null>(null);
  const [connecting, setConnecting]       = useState(false);

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
