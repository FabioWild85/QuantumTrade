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
  enhanced_exit_enabled: boolean;
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
  p10_sl_floor_enabled: boolean;
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
    enhanced_exit_enabled:   false,
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
    p10_sl_floor_enabled:    false,
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
    <div className="space-y-8 max-w-4xl">
      <div className="mb-8">
        <h2 className="text-xl font-bold text-slate-900 dark:text-white uppercase tracking-tight">Impostazioni Piattaforma</h2>
        <p className="text-[11px] font-bold text-slate-400 dark:text-slate-500 uppercase tracking-widest mt-1">Gestione Sicurezza, Intelligenza Artificiale e Connettività</p>
      </div>

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
          <div className="flex gap-4">
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


      {/* Advanced Controls */}
      <Section title="Intelligence Engine" description="Parametri critici che governano il motore decisionale del bot e le logiche di esecuzione in tempo reale.">
        <div className="space-y-10">

          {/* Motore Decisionale */}
          <div>
            <h4 className="text-[10px] font-bold text-slate-400 dark:text-slate-500 uppercase tracking-widest mb-6 flex items-center gap-2">
               <span className="w-1 h-3 bg-indigo-500 rounded-full"></span>
               Modelli Previsionali
            </h4>
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
          <div className="pt-8 border-t border-slate-100 dark:border-white/5">
            <h4 className="text-[10px] font-bold text-slate-400 dark:text-slate-500 uppercase tracking-widest mb-6 flex items-center gap-2">
               <span className="w-1 h-3 bg-indigo-500 rounded-full"></span>
               Soglie di Innesco
            </h4>
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
          <div className="pt-8 border-t border-slate-100 dark:border-white/5">
            <h4 className="text-[10px] font-bold text-slate-400 dark:text-slate-500 uppercase tracking-widest mb-6 flex items-center gap-2">
               <span className="w-1 h-3 bg-indigo-500 rounded-full"></span>
               Gestione Rischio Avanzata
            </h4>
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

              <ToggleRow
                label="P10 SL Floor (Chronos)"
                desc="Usa il 10° percentile di Chronos come floor per lo Stop Loss: se il p10 è più vicino all'entry dell'ATR-SL, tighten SL a p10. Migliora R:R nei trade con forecast Chronos confidenti. Richiede Chronos attivo."
                checked={flags.p10_sl_floor_enabled}
                onChange={v => setFlag('p10_sl_floor_enabled', v)}
              />
            </div>
          </div>

          {/* Strategie Exit Esistenti */}
          <div className="pt-8 border-t border-slate-100 dark:border-white/5">
            <h4 className="text-[10px] font-bold text-slate-400 dark:text-slate-500 uppercase tracking-widest mb-6 flex items-center gap-2">
               <span className="w-1 h-3 bg-indigo-500 rounded-full"></span>
               Strategie di Uscita
            </h4>
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
                  <div className="flex flex-col gap-4">
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
                    <ToggleRow
                      label="Enhanced Exit (Chronos p50 confirm)"
                      desc="Richiede che anche il p50 di Chronos abbia attraversato il prezzo di entrata prima di uscire — riduce i falsi segnali di uscita da rumore LGBM."
                      checked={flags.enhanced_exit_enabled}
                      onChange={v => setFlag('enhanced_exit_enabled', v)}
                    />
                  </div>
                )}
              </ToggleRow>
            </div>
          </div>

          <div className="flex items-center gap-4 pt-8 border-t border-slate-100 dark:border-white/5">
            <button onClick={saveFlags} disabled={saving}
              className="px-8 py-3.5 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white text-[10px] font-bold uppercase tracking-widest rounded-xl transition-all shadow-lg shadow-indigo-500/25 active:scale-95">
              {saving ? 'Sincronizzazione…' : 'Salva & Applica'}
            </button>
            {saveMsg && (
              <span className={`text-[10px] font-bold font-mono px-3 py-1.5 rounded-lg border ${saveMsg.startsWith('✓') ? 'bg-emerald-50 dark:bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-100 dark:border-emerald-500/20' : 'bg-rose-50 dark:bg-rose-500/10 text-rose-600 dark:text-rose-400 border-rose-100 dark:border-rose-500/20'}`}>
                {saveMsg}
              </span>
            )}
          </div>
        </div>
      </Section>

      {/* Kill Switch */}
      <Section title="Emergenza & Sicurezza" description="Intervento immediato per la cessazione di ogni attività operativa in corso.">
        <Tooltip text="Azione irreversibile: invia immediatamente ordini di chiusura per tutte le posizioni aperte su Hyperliquid e cancella tutti gli ordini pendenti. Usa in caso di emergenza o malfunzionamento del bot." pos="right" width="wide">
          <button
            onClick={async () => {
              if (!confirm('KILL SWITCH: chiude tutto immediatamente. Sei sicuro?')) return;
              const r = await fetch(`${apiBase}/bot/kill`, { method: 'POST' });
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

const ToggleRow: React.FC<{
  label: string; desc: string; checked: boolean;
  onChange: (v: boolean) => void; children?: React.ReactNode;
}> = ({ label, desc, checked, onChange, children }) => (
  <div className="space-y-4">
    <label className="flex items-start gap-4 cursor-pointer group">
      <div className="relative mt-1 flex-shrink-0">
        <input type="checkbox" className="sr-only" checked={checked} onChange={e => onChange(e.target.checked)} />
        <div className={`w-11 h-6 rounded-full transition-all duration-300 border ${
          checked ? 'bg-indigo-600 border-indigo-600' : 'bg-slate-200 dark:bg-white/10 border-slate-300 dark:border-white/20'
        }`} />
        <div className={`absolute top-1 left-1 w-4 h-4 bg-white rounded-full shadow-sm transition-transform duration-300 ${checked ? 'translate-x-5' : ''}`} />
      </div>
      <div>
        <p className="text-sm font-bold text-slate-800 dark:text-slate-200 group-hover:text-indigo-600 dark:group-hover:text-indigo-400 transition-colors">{label}</p>
        <p className="text-[11px] font-medium text-slate-400 dark:text-slate-500 leading-snug mt-0.5">{desc}</p>
      </div>
    </label>
    {checked && children && <div className="ml-15 animate-in fade-in slide-in-from-left-2">{children}</div>}
  </div>
);

const NumInput: React.FC<{
  label: string; value: number; onChange: (v: number) => void;
  step?: number; min?: number; max?: number; unit?: string;
}> = ({ label, value, onChange, step = 0.1, min, max, unit }) => (
  <label className="flex flex-col gap-2 w-full max-w-[160px]">
    <span className="text-[10px] font-bold text-slate-400 dark:text-slate-500 uppercase tracking-widest ml-1">{label}</span>
    <div className="relative">
      <input type="number" value={value} step={step} min={min} max={max}
        onChange={e => onChange(parseFloat(e.target.value))}
        className="w-full bg-slate-50 dark:bg-white/5 border border-slate-200 dark:border-white/10 rounded-xl px-4 py-2.5 text-sm font-bold font-mono text-slate-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500 transition-all outline-none shadow-sm" />
      {unit && <span className="absolute right-3 top-1/2 -translate-y-1/2 text-[9px] font-bold text-slate-400 dark:text-slate-500 uppercase">{unit}</span>}
    </div>
  </label>
);
