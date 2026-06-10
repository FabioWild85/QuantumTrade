import React, { useEffect, useState } from 'react';
import { Tooltip } from './Tooltip';

import { apiFetch } from '../../services/authService';
export const HubSettings: React.FC<{ apiBase: string }> = ({ apiBase }) => {
  const [walletAddress, setWalletAddress] = useState('');
  const [agentResult, setAgentResult]     = useState<string | null>(null);
  const [connecting, setConnecting]       = useState(false);

  // Ambiente di esecuzione
  const [mode, setMode]           = useState<'paper' | 'live'>('paper');
  const [modeLoading, setModeLoading] = useState(true);
  const [modeSaving, setModeSaving]   = useState(false);
  const [modeSaved, setModeSaved]     = useState(false);

  // Rete ordini live
  const [hlTestnet, setHlTestnet] = useState<boolean | null>(null);

  useEffect(() => {
    apiFetch(`${apiBase}/bot`)
      .then(r => r.ok ? r.json() : null)
      .then(d => { if (d?.mode) setMode(d.mode); })
      .catch(() => {})
      .finally(() => setModeLoading(false));

    apiFetch(`${apiBase}/bot/status`)
      .then(r => r.ok ? r.json() : null)
      .then(s => { if (s) setHlTestnet(s.hl_testnet ?? true); })
      .catch(() => {});
  }, [apiBase]);

  const handleSaveMode = async () => {
    if (!confirm(`Salva modalità ${mode.toUpperCase()}? Il bot userà questa modalità al prossimo ciclo.`)) return;
    setModeSaving(true);
    try {
      // Fetch full config first to avoid overwriting other params
      const r = await apiFetch(`${apiBase}/bot`);
      const fullConfig = r.ok ? await r.json() : {};
      const updated = { ...fullConfig, mode };
      const res = await apiFetch(`${apiBase}/bot`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(updated),
      });
      if (res.ok) {
        setModeSaved(true);
        setTimeout(() => setModeSaved(false), 2000);
      }
    } catch {
      alert('Errore durante il salvataggio della modalità.');
    } finally {
      setModeSaving(false);
    }
  };

  const connectWallet = async () => {
    if (!walletAddress.startsWith('0x')) {
      alert('Inserisci un indirizzo wallet valido (0x…)');
      return;
    }
    setConnecting(true);
    try {
      const r = await apiFetch(`${apiBase}/wallet/connect`, {
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
      const r = await apiFetch(`${apiBase}/wallet/agent`, {
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
    <div className="space-y-8 max-w-4xl">
      <div className="mb-8">
        <h2 className="text-xl font-bold text-slate-900 dark:text-white uppercase tracking-tight">Impostazioni Piattaforma</h2>
        <p className="text-[11px] font-bold text-slate-400 dark:text-slate-500 uppercase tracking-widest mt-1">Sicurezza, Connettività e Infrastruttura</p>
      </div>

      {/* Ambiente di Esecuzione */}
      <Section title="Ambiente di Esecuzione" description="Seleziona la modalità operativa del bot. Il Paper Trading simula l'esecuzione, il Live Trading opera con fondi reali.">
        {modeLoading ? (
          <div className="h-16 bg-slate-100 dark:bg-white/5 rounded-xl animate-pulse" />
        ) : (
          <div className="space-y-4">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <Tooltip text="Paper Trading: il bot simula operazioni usando dati reali di mercato ma senza usare fondi veri. Ideale per testare la strategia senza rischi." pos="bottom">
                <button
                  onClick={() => setMode('paper')}
                  className={`w-full py-4 rounded-xl text-[11px] font-bold uppercase tracking-widest transition-all border ${
                    mode === 'paper'
                      ? 'bg-indigo-600 text-white border-indigo-600 shadow-lg shadow-indigo-500/30'
                      : 'bg-slate-50 dark:bg-white/5 text-slate-400 dark:text-slate-500 border-slate-100 dark:border-white/10 hover:bg-slate-100 dark:hover:bg-white/10'
                  }`}
                >
                  Paper Trading
                </button>
              </Tooltip>
              <Tooltip text="Live Trading: il bot opera con fondi reali su Hyperliquid. Richiede un agent wallet configurato nelle Impostazioni. Usare con cautela." pos="bottom">
                <button
                  onClick={() => setMode('live')}
                  className={`w-full py-4 rounded-xl text-[11px] font-bold uppercase tracking-widest transition-all border ${
                    mode === 'live'
                      ? 'bg-slate-900 dark:bg-white text-white dark:text-slate-900 border-slate-900 dark:border-white shadow-lg'
                      : 'bg-slate-50 dark:bg-white/5 text-slate-400 dark:text-slate-500 border-slate-100 dark:border-white/10 hover:bg-slate-100 dark:hover:bg-white/10'
                  }`}
                >
                  Live Trading
                </button>
              </Tooltip>
            </div>
            {mode === 'live' && (
              <div className="flex items-start gap-3 bg-rose-50 dark:bg-rose-500/10 border border-rose-100 dark:border-rose-500/20 rounded-xl px-4 py-3 animate-in fade-in slide-in-from-top-1">
                <svg className="w-5 h-5 text-rose-500 flex-shrink-0 mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" /></svg>
                <p className="text-[10px] font-bold text-rose-600 dark:text-rose-400 uppercase tracking-tight leading-relaxed">
                  Attenzione: La modalità Live utilizza asset reali su Hyperliquid. Verifica attentamente le soglie di rischio prima di salvare.
                </p>
              </div>
            )}
            <button
              onClick={handleSaveMode}
              disabled={modeSaving}
              className={`w-full sm:w-auto px-6 py-3 rounded-xl text-[10px] font-bold uppercase tracking-widest transition-all shadow-sm active:scale-95 disabled:opacity-50 ${
                modeSaved
                  ? 'bg-emerald-600 text-white'
                  : 'bg-indigo-600 hover:bg-indigo-500 text-white shadow-indigo-500/25'
              }`}
            >
              {modeSaved ? '✓ Salvato' : modeSaving ? 'Salvataggio…' : 'Applica e Salva'}
            </button>
          </div>
        )}
      </Section>

      {/* Rete Ordini Live */}
      <Section
        title="Rete Ordini Live"
        description="Indica su quale rete Hyperliquid vengono inviati gli ordini quando il bot è in modalità Live. I dati di mercato (prezzi, OHLCV) vengono sempre da mainnet."
      >
        {hlTestnet === null ? (
          <div className="h-16 bg-slate-100 dark:bg-white/5 rounded-xl animate-pulse" />
        ) : (
          <div className="space-y-4">
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
                    {hlTestnet ? 'Ordini con fondi virtuali — nessun rischio reale' : 'Ordini con fondi reali — massima attenzione'}
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

      {/* Wallet */}
      <Section title="Asset & Sicurezza" description="Configurazione del wallet principale e dell'agente operativo per l'esecuzione automatizzata su Hyperliquid.">
        <div className="space-y-4">
          <div>
            <label className="text-[10px] font-bold text-slate-400 dark:text-slate-500 uppercase tracking-widest block mb-2 ml-1">Wallet Address (Main)</label>
            <input
              type="text"
              value={walletAddress}
              onChange={e => setWalletAddress(e.target.value)}
              placeholder="0x..."
              className="w-full bg-slate-50 dark:bg-white/5 border border-slate-200 dark:border-white/10 rounded-xl px-4 py-3 text-sm font-mono text-slate-900 dark:text-white placeholder-slate-300 dark:placeholder-slate-700 focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500 transition-all shadow-inner"
            />
          </div>
          <div className="flex flex-col sm:flex-row gap-3">
            <button
              onClick={connectWallet}
              disabled={connecting}
              className="flex-1 py-3.5 bg-indigo-600 hover:bg-indigo-500 text-white text-[10px] font-bold uppercase tracking-widest rounded-xl transition-all shadow-lg shadow-indigo-500/25 active:scale-95 disabled:opacity-50"
            >
              Associa Wallet
            </button>
            <button
              onClick={createAgent}
              disabled={connecting}
              className="flex-1 py-3.5 bg-white dark:bg-white/5 hover:bg-slate-50 dark:hover:bg-white/10 text-slate-600 dark:text-slate-300 text-[10px] font-bold uppercase tracking-widest border border-slate-100 dark:border-white/10 rounded-xl transition-all active:scale-95 disabled:opacity-50"
            >
              Inizializza Agente
            </button>
          </div>
          {agentResult && (
            <div className={`p-4 rounded-xl border text-[10px] font-bold uppercase tracking-widest font-mono flex items-center gap-3 animate-in fade-in slide-in-from-top-1 ${agentResult.startsWith('✓') ? 'bg-emerald-50 dark:bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-100 dark:border-emerald-500/20' : 'bg-rose-50 dark:bg-rose-500/10 text-rose-600 dark:text-rose-400 border-rose-100 dark:border-rose-500/20'}`}>
               <span className="w-2 h-2 rounded-full bg-current animate-pulse"></span>
               {agentResult}
            </div>
          )}
          <p className="text-[10px] font-medium text-slate-400 dark:text-slate-500 leading-relaxed bg-slate-50 dark:bg-black/10 p-4 rounded-xl border border-slate-100 dark:border-white/5">
            Nota di Sicurezza: L'agente wallet ha permessi limitati esclusivamente al trading. Le chiavi private sono protette tramite cifratura AES-256 e non lasciano mai l'ambiente protetto del server.
          </p>
        </div>
      </Section>

      {/* Kill Switch */}
      <Section title="Emergenza & Sicurezza" description="Intervento immediato per la cessazione di ogni attività operativa in corso.">
        <Tooltip text="Azione irreversibile: invia immediatamente ordini di chiusura per tutte le posizioni aperte su Hyperliquid e cancella tutti gli ordini pendenti. Usa in caso di emergenza o malfunzionamento del bot." pos="right" width="wide">
          <button
            onClick={async () => {
              if (!confirm('KILL SWITCH: chiude tutto immediatamente. Sei sicuro?')) return;
              const r = await apiFetch(`${apiBase}/bot/kill`, { method: 'POST' });
              const d = await r.json();
              alert(`Kill completato. Posizioni chiuse: ${d.positions_closed}. Ordini cancellati: ${d.orders_cancelled}.`);
            }}
            className="w-full sm:w-auto px-8 py-4 bg-rose-600 hover:bg-rose-500 text-white text-[11px] font-bold uppercase tracking-widest rounded-xl transition-all shadow-lg shadow-rose-500/25 active:scale-95 flex items-center justify-center gap-3"
          >
            <span className="w-2 h-2 rounded-full bg-white animate-ping"></span>
            Attiva Kill Switch Globale
          </button>
        </Tooltip>
      </Section>

      {/* Telegram */}
      <Section title="Infrastruttura Notifiche" description="Integrazione con il sistema di alert Telegram per il monitoraggio real-time delle operazioni.">
        <div className="space-y-4">
          <InfoRow label="TELEGRAM_BOT_TOKEN" value="apps/api/.env" />
          <InfoRow label="TELEGRAM_CHAT_ID" value="apps/api/.env" />
        </div>
        <div className="mt-6 p-4 rounded-xl bg-slate-50 dark:bg-black/20 text-[10px] font-medium text-slate-500 dark:text-slate-400 border border-slate-100 dark:border-white/5 space-y-2">
          <p className="font-bold text-slate-700 dark:text-slate-300 uppercase tracking-widest mb-1">Procedura di Configurazione:</p>
          <p>1. Crea il bot tramite <span className="text-indigo-600 dark:text-indigo-400">@BotFather</span> e ottieni l'API Token.</p>
          <p>2. Identifica il tuo <span className="text-indigo-600 dark:text-indigo-400">CHAT_ID</span> inviando un messaggio al bot.</p>
          <p>3. Aggiorna le variabili d'ambiente nel file .env dedicato.</p>
          <p>4. Riavvia l'istanza backend per rendere effettive le modifiche.</p>
        </div>
      </Section>

      {/* Supabase */}
      <Section title="Persistenza Dati" description="Stato del database cloud per la gestione dello storico, log di inferenza e sincronizzazione real-time.">
        <div className="space-y-4">
          <InfoRow label="SUPABASE_URL" value="apps/api/.env" />
          <InfoRow label="SUPABASE_KEY" value="apps/api/.env" />
        </div>
        <div className="mt-6 p-4 rounded-xl bg-slate-50 dark:bg-black/20 text-[10px] font-medium text-slate-500 dark:text-slate-400 border border-slate-100 dark:border-white/5 space-y-2">
          <p className="font-bold text-slate-700 dark:text-slate-300 uppercase tracking-widest mb-1">Configurazione Database:</p>
          <p>1. Inizializza il progetto su <span className="text-indigo-600 dark:text-indigo-400">supabase.com</span>.</p>
          <p>2. Esegui lo script SQL fornito in <span className="text-indigo-600 dark:text-indigo-400">apps/api/db/schema.sql</span>.</p>
          <p>3. Assicurati che le tabelle critiche abbiano il <span className="text-indigo-600 dark:text-indigo-400">Realtime</span> abilitato.</p>
        </div>
      </Section>
    </div>
  );
};

const Section: React.FC<{ title: string; description: string; children: React.ReactNode }> = ({ title, description, children }) => (
  <div className="elegant-card p-6 bg-white dark:bg-[#151E32]">
    <h3 className="text-sm font-bold text-slate-900 dark:text-white uppercase tracking-tight mb-1">{title}</h3>
    <p className="text-[11px] font-bold text-slate-400 dark:text-slate-500 uppercase tracking-widest mb-6">{description}</p>
    {children}
  </div>
);

const InfoRow: React.FC<{ label: string; value: string }> = ({ label, value }) => (
  <div className="flex items-center justify-between p-3 rounded-xl bg-slate-50 dark:bg-white/[0.02] border border-slate-100 dark:border-white/5">
    <span className="text-[10px] font-bold font-mono text-slate-400 dark:text-slate-500 uppercase tracking-widest">{label}</span>
    <span className="text-[10px] font-bold font-mono text-indigo-600 dark:text-indigo-400">{value}</span>
  </div>
);
