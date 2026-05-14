import React, { useState, useEffect } from 'react';
import { Tooltip } from './Tooltip';

interface FeatureFlags {
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
  // Base gates
  confluence_gate: number;
  adx_gate: number;
  directional_threshold: number;
  // Advanced signal controls
  chronos_enabled: boolean;
  chronos_weight: number;
  adx_gate_enabled: boolean;
  sweep_gate_enabled: boolean;
  fvg_filter_enabled: boolean;
  mtf_alignment_enabled: boolean;
  // Advanced exit
  be_sl_enabled: boolean;
  be_sl_activation: number;
  max_hold_bars_enabled: boolean;
  max_hold_bars: number;
}

export const HubSettings: React.FC<{ apiBase: string }> = ({ apiBase }) => {
  const [walletAddress, setWalletAddress] = useState('');
  const [agentResult, setAgentResult]     = useState<string | null>(null);
  const [connecting, setConnecting]       = useState(false);
  const [flags, setFlags]                 = useState<FeatureFlags>({
    trailing_sl_enabled:     false,
    trailing_sl_activation:  1.0,
    partial_tp_enabled:      false,
    partial_tp_atr_mult:     1.5,
    partial_tp_pct:          50.0,
    lgbm_exit_enabled:       false,
    lgbm_exit_threshold:     0.30,
    lgbm_exit_min_hold_bars: 6,
    lgbm_exit_confirm_bars:  2,
    confluence_gate:         60.0,
    adx_gate:                20.0,
    directional_threshold:   0.62,
    // Advanced
    chronos_enabled:         true,
    chronos_weight:          0.40,
    adx_gate_enabled:        true,
    sweep_gate_enabled:      true,
    fvg_filter_enabled:      true,
    mtf_alignment_enabled:   true,
    be_sl_enabled:           false,
    be_sl_activation:        1.0,
    max_hold_bars_enabled:   false,
    max_hold_bars:           48,
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


      {/* Advanced Controls */}
      <Section title="🧠 Controlli Avanzati" description="Parametri che influenzano direttamente il motore decisionale e le strategie di uscita. Tutti effettivi e salvati sul database.">
        <div className="space-y-6">

          {/* Motore Decisionale */}
          <div>
            <p className="text-xs font-bold text-slate-400 uppercase tracking-widest mb-3">Motore Decisionale</p>
            <div className="space-y-4">
              <ToggleRow
                label="Chronos-2 attivo"
                desc="Abilita il modello transformer Chronos-2 nell'ensemble. Se disattivo, il bot usa solo LightGBM (peso 100%). Utile per confrontare i due approcci."
                checked={flags.chronos_enabled}
                onChange={v => setFlag('chronos_enabled', v)}
              >
                {flags.chronos_enabled && (
                  <Tooltip text="Quanto peso dare a Chronos-2 nella decisione finale. Il peso rimanente va a LightGBM. Es: 0.4 = 40% Chronos + 60% LightGBM." pos="right" width="wide">
                    <NumInput label="Peso Chronos-2 (0.0–0.9)" value={flags.chronos_weight} onChange={v => setFlag('chronos_weight', v)} step={0.05} min={0.1} max={0.9} />
                  </Tooltip>
                )}
              </ToggleRow>

              <ToggleRow
                label="ADX Gate"
                desc="Blocca il trade quando ADX < soglia: mercato in compressione senza trend. Disattivarlo può aumentare i trade in regime laterale ma peggiora il win rate."
                checked={flags.adx_gate_enabled}
                onChange={v => setFlag('adx_gate_enabled', v)}
              />

              <ToggleRow
                label="Liquidity Sweep Gate"
                desc="Salta il segnale quando è rilevato uno sweep di liquidità nell'ultima candela. Evita di entrare in falsi breakout dopo caccia agli stop."
                checked={flags.sweep_gate_enabled}
                onChange={v => setFlag('sweep_gate_enabled', v)}
              />

              <ToggleRow
                label="Filtro FVG Anti-entry"
                desc="Non entrare long se c'è un Fair Value Gap ribassista sopra il prezzo, e viceversa per short. Evita di comprare in una zona di resistenza SMC."
                checked={flags.fvg_filter_enabled}
                onChange={v => setFlag('fvg_filter_enabled', v)}
              />

              <ToggleRow
                label="Bonus MTF Alignment (Daily)"
                desc="Se il regime daily è allineato con il segnale (bull + long, o bear + short), abbassa la soglia direzionale di 0.02. Favorisce i trade in direzione del trend macro."
                checked={flags.mtf_alignment_enabled}
                onChange={v => setFlag('mtf_alignment_enabled', v)}
              />
            </div>
          </div>

          {/* Soglie Base */}
          <div>
            <p className="text-xs font-bold text-slate-400 uppercase tracking-widest mb-3">Soglie Segnale</p>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
              <Tooltip text="ADX (Average Directional Index): misura la forza del trend da 0 a 100. Il bot non apre trade quando ADX è sotto questa soglia (mercato laterale, senza direzione chiara)." pos="bottom" width="wide">
                <NumInput label="ADX Gate (no-trade < x)" value={flags.adx_gate} onChange={v => setFlag('adx_gate', v)} step={1} min={10} max={40} />
              </Tooltip>
              <Tooltip text="Soglia minima di probabilità direzionale (0–1). Il modello ensemble deve essere almeno questa percentuale sicuro della direzione per aprire un trade." pos="bottom" width="wide">
                <NumInput label="Directional Threshold" value={flags.directional_threshold} onChange={v => setFlag('directional_threshold', v)} step={0.01} min={0.5} max={0.9} />
              </Tooltip>
              <Tooltip text="Punteggio minimo del sistema Quantum Trade (0–100). Combina più indicatori tecnici. 0 = filtro disabilitato. Aumentarlo riduce i trade ma li rende più selezionati." pos="bottom" width="wide">
                <NumInput label="Confluence Gate (%)" value={flags.confluence_gate} onChange={v => setFlag('confluence_gate', v)} step={5} min={0} max={100} />
              </Tooltip>
            </div>
          </div>

          {/* Exit Avanzato */}
          <div>
            <p className="text-xs font-bold text-slate-400 uppercase tracking-widest mb-3">Exit Avanzato</p>
            <div className="space-y-4">
              <ToggleRow
                label="Break-Even SL"
                desc="Sposta lo Stop Loss al prezzo di entrata (break-even) quando il prezzo si muove di activation × ATR a favore. Elimina il rischio di perdita dopo essere stati in profitto."
                checked={flags.be_sl_enabled}
                onChange={v => setFlag('be_sl_enabled', v)}
              >
                {flags.be_sl_enabled && (
                  <Tooltip text="Distanza minima di profitto (in multipli di ATR) prima che lo SL venga spostato al break-even. Es: 1.0 ATR = lo SL si sposta a pareggio quando sei in guadagno di 1 ATR." pos="right" width="wide">
                    <NumInput label="Attivazione (× ATR)" value={flags.be_sl_activation} onChange={v => setFlag('be_sl_activation', v)} step={0.1} min={0.5} max={3.0} />
                  </Tooltip>
                )}
              </ToggleRow>

              <ToggleRow
                label="Exit Temporale Massimo"
                desc="Chiude la posizione dopo un numero massimo di barre indipendentemente da SL/TP. Evita di tenere trade aperti indefinitamente in mercati laterali."
                checked={flags.max_hold_bars_enabled}
                onChange={v => setFlag('max_hold_bars_enabled', v)}
              >
                {flags.max_hold_bars_enabled && (
                  <Tooltip text="Numero massimo di candele 4h prima della chiusura forzata. 48 barre = 8 giorni. Utile per evitare di bloccare capitale in trade che non si muovono." pos="right" width="wide">
                    <NumInput label="Max barre (1 barra = 4h)" value={flags.max_hold_bars} onChange={v => setFlag('max_hold_bars', Math.round(v))} step={4} min={12} max={168} />
                  </Tooltip>
                )}
              </ToggleRow>
            </div>
          </div>

          {/* Strategie Exit Esistenti */}
          <div>
            <p className="text-xs font-bold text-slate-400 uppercase tracking-widest mb-3">Strategie di Uscita</p>
            <div className="space-y-4">
              <ToggleRow
                label="Trailing Stop Loss"
                desc="Lo SL segue dinamicamente il prezzo: si attiva dopo N×ATR di profitto e poi si aggiorna ad ogni candela seguendo il massimo/minimo raggiunto (high water mark). Cattura profitto crescente se il trend continua."
                checked={flags.trailing_sl_enabled}
                onChange={v => setFlag('trailing_sl_enabled', v)}
              >
                {flags.trailing_sl_enabled && (
                  <Tooltip text="Distanza di profitto minima per attivare il trailing. Una volta attivato, lo SL insegue il prezzo restando a questa distanza dal massimo raggiunto." pos="right" width="wide">
                    <NumInput label="Attivazione (× ATR)" value={flags.trailing_sl_activation} onChange={v => setFlag('trailing_sl_activation', v)} step={0.1} min={0.5} max={3} />
                  </Tooltip>
                )}
              </ToggleRow>

              <ToggleRow
                label="Partial Take Profit"
                desc="Chiudi una quota della posizione al primo target, lascia il resto correre fino al TP finale. Utile per incassare profitti parziali riducendo il rischio."
                checked={flags.partial_tp_enabled}
                onChange={v => setFlag('partial_tp_enabled', v)}
              >
                {flags.partial_tp_enabled && (
                  <div className="flex gap-4 flex-wrap">
                    <Tooltip text="Distanza in ATR dal prezzo di entrata a cui scatta il primo take profit parziale." pos="top" width="wide">
                      <NumInput label="Target (× ATR)" value={flags.partial_tp_atr_mult} onChange={v => setFlag('partial_tp_atr_mult', v)} step={0.1} min={0.5} max={5} />
                    </Tooltip>
                    <Tooltip text="Percentuale della posizione da chiudere al primo target. Il resto continua fino al TP finale." pos="top" width="wide">
                      <NumInput label="Quota da chiudere (%)" value={flags.partial_tp_pct} onChange={v => setFlag('partial_tp_pct', v)} step={5} min={10} max={90} />
                    </Tooltip>
                  </div>
                )}
              </ToggleRow>

              <ToggleRow
                label="LightGBM Mid-Trade Exit"
                desc="Rivaluta il segnale LightGBM ogni candela mentre il trade è aperto. Chiude anticipatamente se la probabilità scende sotto soglia per N barre consecutive."
                checked={flags.lgbm_exit_enabled}
                onChange={v => setFlag('lgbm_exit_enabled', v)}
              >
                {flags.lgbm_exit_enabled && (
                  <div className="flex gap-4 flex-wrap">
                    <Tooltip text="Se la probabilità LightGBM scende sotto questo valore per N barre consecutive, il trade viene chiuso." pos="top" width="wide">
                      <NumInput label="Soglia (p <)" value={flags.lgbm_exit_threshold} onChange={v => setFlag('lgbm_exit_threshold', v)} step={0.01} min={0.15} max={0.50} />
                    </Tooltip>
                    <Tooltip text="Il bot non può uscire prima di aver tenuto la posizione per almeno questo numero di candele 4h." pos="top" width="wide">
                      <NumInput label="Hold minimo (barre)" value={flags.lgbm_exit_min_hold_bars} onChange={v => setFlag('lgbm_exit_min_hold_bars', v)} step={1} min={1} max={48} />
                    </Tooltip>
                    <Tooltip text="Numero di barre consecutive in cui la probabilità deve essere bassa prima di chiudere. Evita uscite premature su segnali rumorosi." pos="top" width="wide">
                      <NumInput label="Conferma (barre consec.)" value={flags.lgbm_exit_confirm_bars} onChange={v => setFlag('lgbm_exit_confirm_bars', v)} step={1} min={1} max={6} />
                    </Tooltip>
                  </div>
                )}
              </ToggleRow>
            </div>
          </div>

          <div className="flex items-center gap-3 pt-2">
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
        <Tooltip text="Azione irreversibile: invia immediatamente ordini di chiusura per tutte le posizioni aperte su Hyperliquid e cancella tutti gli ordini pendenti. Usa in caso di emergenza o malfunzionamento del bot." pos="right" width="wide">
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
        </Tooltip>
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
