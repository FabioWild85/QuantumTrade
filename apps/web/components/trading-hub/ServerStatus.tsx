import React, { useEffect, useState, useCallback, useRef } from 'react';

// ── Types ─────────────────────────────────────────────────────────────────────

interface CpuInfo {
  percent: number;
  per_core: number[];
  cores_logical: number;
  cores_physical: number;
  freq_mhz: number | null;
  freq_max_mhz: number | null;
}

interface RamInfo {
  total_gb: number;
  used_gb: number;
  avail_gb: number;
  percent: number;
  swap_total_gb: number;
  swap_used_gb: number;
  swap_percent: number;
}

interface DiskInfo {
  path: string;
  total_gb: number;
  used_gb: number;
  free_gb: number;
  percent: number;
  root_total_gb: number;
  root_used_gb: number;
  root_percent: number;
}

interface NetworkInfo {
  rx_bps: number;
  tx_bps: number;
  rx_total_gb: number;
  tx_total_gb: number;
  rx_packets: number;
  tx_packets: number;
}

interface LoadInfo {
  load1: number;
  load5: number;
  load15: number;
  cores: number;
}

interface ProcessInfo {
  pid: number;
  cpu_pct: number;
  rss_mb: number;
  vms_mb: number;
  threads: number;
  fds: number | null;
  uptime_s: number;
}

interface TopProc {
  pid: number;
  name: string;
  cpu: number;
  mem: number;
  status: string;
}

interface ServerData {
  cpu:            CpuInfo;
  ram:            RamInfo;
  disk:           DiskInfo;
  network:        NetworkInfo;
  load:           LoadInfo;
  uptime_s:       number;
  process:        ProcessInfo;
  top_processes:  TopProc[];
  timestamp:      string;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmtUptime(s: number): string {
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d}d ${h}h ${m}m`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m ${s % 60}s`;
}

function fmtBps(bps: number): string {
  if (bps >= 1_000_000) return `${(bps / 1_000_000).toFixed(1)} MB/s`;
  if (bps >= 1_000)     return `${(bps / 1_000).toFixed(0)} KB/s`;
  return `${bps.toFixed(0)} B/s`;
}

function fmtGb(gb: number): string {
  if (gb < 1) return `${(gb * 1024).toFixed(0)} MB`;
  return `${gb.toFixed(2)} GB`;
}

function pctColor(pct: number): string {
  if (pct >= 85) return 'text-rose-600 dark:text-rose-400';
  if (pct >= 65) return 'text-amber-600 dark:text-amber-400';
  return 'text-emerald-600 dark:text-emerald-400';
}

function barColor(pct: number): string {
  if (pct >= 85) return 'bg-rose-500';
  if (pct >= 65) return 'bg-amber-500';
  return 'bg-emerald-500';
}

function loadColor(ratio: number): string {
  if (ratio >= 0.85) return 'text-rose-600 dark:text-rose-400';
  if (ratio >= 0.65) return 'text-amber-600 dark:text-amber-400';
  return 'text-emerald-600 dark:text-emerald-400';
}

// ── Sub-components ────────────────────────────────────────────────────────────

const GaugeBar: React.FC<{
  label: string;
  pct: number;
  left: string;
  right?: string;
  subleft?: string;
  subright?: string;
}> = ({ label, pct, left, right, subleft, subright }) => (
  <div className="space-y-2">
    <div className="flex items-end justify-between">
      <div>
        <p className="text-[10px] font-bold text-slate-400 dark:text-slate-500 uppercase tracking-widest">{label}</p>
        <p className={`text-2xl font-bold font-mono tracking-tight mt-0.5 ${pctColor(pct)}`}>{left}</p>
        {subleft && <p className="text-[11px] text-slate-500 dark:text-slate-400 font-mono mt-0.5">{subleft}</p>}
      </div>
      {right && (
        <div className="text-right">
          <p className={`text-sm font-bold font-mono ${pctColor(pct)}`}>{right}</p>
          {subright && <p className="text-[11px] text-slate-500 dark:text-slate-400 font-mono">{subright}</p>}
        </div>
      )}
    </div>
    <div className="relative h-2 bg-slate-100 dark:bg-white/8 rounded-full overflow-hidden">
      <div
        className={`absolute inset-y-0 left-0 rounded-full transition-all duration-700 ${barColor(pct)}`}
        style={{ width: `${Math.min(100, pct)}%` }}
      />
    </div>
    <p className="text-[10px] text-slate-400 dark:text-slate-500 font-mono text-right">{pct.toFixed(1)}%</p>
  </div>
);

const SectionCard: React.FC<{
  title: string;
  icon: React.ReactNode;
  accent: string;
  children: React.ReactNode;
}> = ({ title, icon, accent, children }) => (
  <div className="rounded-2xl border border-slate-200 dark:border-white/5 bg-white dark:bg-[#151E32] p-6 space-y-5">
    <div className="flex items-center gap-3">
      <span className={`w-1.5 h-6 rounded-full ${accent}`} />
      <div className={`w-8 h-8 rounded-lg flex items-center justify-center ${accent.replace('bg-', 'bg-').replace('500', '500/10')}`}>
        <span className={accent.replace('bg-', 'text-')}>{icon}</span>
      </div>
      <h3 className="text-sm font-bold text-slate-900 dark:text-white uppercase tracking-wider">{title}</h3>
    </div>
    {children}
  </div>
);

const StatPill: React.FC<{ label: string; value: string; mono?: boolean }> = ({ label, value, mono }) => (
  <div className="flex items-center justify-between py-2 border-b border-slate-100 dark:border-white/5 last:border-0">
    <span className="text-[11px] text-slate-500 dark:text-slate-400">{label}</span>
    <span className={`text-[11px] font-bold text-slate-700 dark:text-slate-200 ${mono ? 'font-mono' : ''}`}>{value}</span>
  </div>
);

// Mini sparkline for CPU history
const MiniSparkline: React.FC<{ data: number[]; color: string }> = ({ data, color }) => {
  if (data.length < 2) return null;
  const W = 200, H = 32;
  const min = 0, max = 100;
  const n = data.length;
  const px = (i: number) => (i / (n - 1)) * W;
  const py = (v: number) => H - ((v - min) / (max - min)) * H;
  const pts = data.map((v, i) => `${px(i).toFixed(1)},${py(v).toFixed(1)}`).join(' ');
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full" style={{ height: H }}>
      <polyline points={pts} fill="none" stroke={color} strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
};

// ── Main component ────────────────────────────────────────────────────────────

export const ServerStatus: React.FC<{ apiBase: string }> = ({ apiBase }) => {
  const [data,       setData]      = useState<ServerData | null>(null);
  const [error,      setError]     = useState<string | null>(null);
  const [loading,    setLoading]   = useState(true);
  const [lastUpdate, setLastUpdate] = useState<Date | null>(null);
  const [cpuHistory, setCpuHistory] = useState<number[]>([]);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const fetchData = useCallback(async () => {
    try {
      const r = await fetch(`${apiBase}/server/status`, { signal: AbortSignal.timeout(6000) });
      if (!r.ok) { setError(`HTTP ${r.status}`); return; }
      const d: ServerData = await r.json();
      setData(d);
      setError(null);
      setLastUpdate(new Date());
      setCpuHistory(h => [...h.slice(-59), d.cpu.percent]);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Connection error');
    } finally {
      setLoading(false);
    }
  }, [apiBase]);

  useEffect(() => {
    fetchData();
    intervalRef.current = setInterval(fetchData, 4000);
    return () => { if (intervalRef.current) clearInterval(intervalRef.current); };
  }, [fetchData]);

  // ── Loading ───────────────────────────────────────────────────────────────

  if (loading) {
    return (
      <div className="flex flex-col items-center justify-center h-64 gap-3 text-slate-500">
        <svg className="animate-spin w-6 h-6" viewBox="0 0 24 24" fill="none">
          <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" strokeDasharray="40" strokeDashoffset="10"/>
        </svg>
        <p className="text-sm">Connessione al server…</p>
      </div>
    );
  }

  if (error && !data) {
    return (
      <div className="flex flex-col items-center justify-center h-64 gap-3 text-rose-500">
        <svg className="w-8 h-8 opacity-60" fill="none" stroke="currentColor" strokeWidth="1.5" viewBox="0 0 24 24">
          <path d="M12 9v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"/>
        </svg>
        <p className="text-sm font-medium">Impossibile raggiungere il server</p>
        <p className="text-xs text-slate-500">{error}</p>
        <button onClick={fetchData} className="text-xs text-indigo-500 hover:text-indigo-400 mt-1">Riprova</button>
      </div>
    );
  }

  if (!data) return null;

  const { cpu, ram, disk, network, load, uptime_s, process: proc, top_processes } = data;
  const cpuColor = cpu.percent >= 85 ? '#f87171' : cpu.percent >= 65 ? '#fbbf24' : '#34d399';
  const loadRatio = load.load1 / load.cores;

  return (
    <div className="space-y-6">

      {/* ── Header strip ──────────────────────────────────────────────────── */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h2 className="text-base font-bold text-slate-900 dark:text-slate-100">Server Status</h2>
          <p className="text-xs text-slate-500 mt-0.5">VPS Hetzner · 77.42.84.8 · aggiornamento ogni 4s</p>
        </div>
        <div className="flex items-center gap-3">
          {error && (
            <span className="text-[10px] font-bold text-rose-500 bg-rose-50 dark:bg-rose-500/10 border border-rose-200 dark:border-rose-500/20 px-2 py-1 rounded-lg">
              ⚠ {error}
            </span>
          )}
          <div className="flex items-center gap-2 text-[11px] text-slate-500 dark:text-slate-400">
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />
            {lastUpdate ? `Aggiornato ${lastUpdate.toLocaleTimeString('it-IT')}` : '…'}
          </div>
          <button
            onClick={fetchData}
            className="flex items-center gap-1.5 text-xs text-slate-500 dark:text-slate-400 hover:text-indigo-500 dark:hover:text-indigo-400 transition-colors"
          >
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
              <path d="M1 4v6h6M23 20v-6h-6"/><path d="M20.49 9A9 9 0 0 0 5.64 5.64L1 10M23 14l-4.64 4.36A9 9 0 0 1 3.51 15"/>
            </svg>
            Refresh
          </button>
        </div>
      </div>

      {/* ── KPI strip — uptime / load / process ───────────────────────────── */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        {[
          {
            label: 'Uptime server',
            value: fmtUptime(uptime_s),
            sub: 'dalla riaccensione',
            color: 'text-indigo-600 dark:text-indigo-400',
          },
          {
            label: 'Load avg (1m)',
            value: load.load1.toFixed(2),
            sub: `5m ${load.load5.toFixed(2)} · 15m ${load.load15.toFixed(2)}`,
            color: loadColor(loadRatio),
          },
          {
            label: 'API uptime',
            value: fmtUptime(proc.uptime_s),
            sub: `PID ${proc.pid} · ${proc.threads} thread`,
            color: 'text-slate-700 dark:text-slate-200',
          },
          {
            label: 'API memoria',
            value: `${proc.rss_mb.toFixed(0)} MB`,
            sub: `VMS ${proc.vms_mb.toFixed(0)} MB${proc.fds != null ? ` · ${proc.fds} fd` : ''}`,
            color: 'text-slate-700 dark:text-slate-200',
          },
        ].map(k => (
          <div key={k.label} className="rounded-xl border border-slate-200 dark:border-white/5 bg-white dark:bg-[#151E32] px-5 py-4">
            <p className="text-[10px] font-bold text-slate-400 dark:text-slate-500 uppercase tracking-widest mb-1">{k.label}</p>
            <p className={`text-lg font-bold font-mono tracking-tight ${k.color}`}>{k.value}</p>
            <p className="text-[10px] text-slate-400 dark:text-slate-500 font-mono mt-0.5">{k.sub}</p>
          </div>
        ))}
      </div>

      {/* ── Resource gauges ───────────────────────────────────────────────── */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">

        {/* CPU */}
        <SectionCard
          title="CPU"
          accent="bg-indigo-500"
          icon={
            <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
              <rect x="4" y="4" width="16" height="16" rx="2"/><path d="M9 9h6v6H9z"/>
              <path d="M9 1v3M15 1v3M9 20v3M15 20v3M1 9h3M1 15h3M20 9h3M20 15h3"/>
            </svg>
          }
        >
          <GaugeBar
            label="Utilizzo totale"
            pct={cpu.percent}
            left={`${cpu.percent.toFixed(1)}%`}
            right={cpu.freq_mhz ? `${cpu.freq_mhz} MHz` : undefined}
            subright={cpu.freq_max_mhz ? `max ${cpu.freq_max_mhz} MHz` : undefined}
          />
          {/* Sparkline */}
          <div className="pt-1">
            <p className="text-[10px] font-bold text-slate-400 dark:text-slate-500 uppercase tracking-widest mb-1.5">Storico (ultimi 60 campioni)</p>
            <MiniSparkline data={cpuHistory} color={cpuColor} />
          </div>
          {/* Per-core grid */}
          {cpu.per_core.length > 0 && (
            <div>
              <p className="text-[10px] font-bold text-slate-400 dark:text-slate-500 uppercase tracking-widest mb-2">Per core</p>
              <div className="grid grid-cols-4 gap-1.5">
                {cpu.per_core.map((c, i) => (
                  <div key={i} className="flex flex-col items-center gap-1">
                    <div className="w-full h-1.5 bg-slate-100 dark:bg-white/8 rounded-full overflow-hidden">
                      <div className={`h-full rounded-full ${barColor(c)}`} style={{ width: `${c}%` }} />
                    </div>
                    <span className="text-[9px] font-mono text-slate-400 dark:text-slate-500">C{i} {c.toFixed(0)}%</span>
                  </div>
                ))}
              </div>
            </div>
          )}
          <div className="flex gap-4 text-[11px] text-slate-500 dark:text-slate-400 pt-1 border-t border-slate-100 dark:border-white/5">
            <span>{cpu.cores_physical} core fisici</span>
            <span>·</span>
            <span>{cpu.cores_logical} thread logici</span>
          </div>
        </SectionCard>

        {/* RAM */}
        <SectionCard
          title="RAM"
          accent="bg-violet-500"
          icon={
            <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
              <rect x="2" y="7" width="20" height="10" rx="2"/><path d="M6 7V5M10 7V5M14 7V5M18 7V5M6 17v2M10 17v2M14 17v2M18 17v2"/>
            </svg>
          }
        >
          <GaugeBar
            label="RAM utilizzata"
            pct={ram.percent}
            left={`${fmtGb(ram.used_gb)}`}
            right={`${fmtGb(ram.avail_gb)} liberi`}
            subleft={`su ${fmtGb(ram.total_gb)} totali`}
          />
          {ram.swap_total_gb > 0 && (
            <GaugeBar
              label="Swap"
              pct={ram.swap_percent}
              left={`${fmtGb(ram.swap_used_gb)}`}
              subleft={`su ${fmtGb(ram.swap_total_gb)}`}
            />
          )}
          <div className="grid grid-cols-2 gap-x-4 pt-1 border-t border-slate-100 dark:border-white/5">
            <StatPill label="Totale RAM"    value={fmtGb(ram.total_gb)} mono />
            <StatPill label="Disponibile"   value={fmtGb(ram.avail_gb)} mono />
            <StatPill label="Usata"         value={fmtGb(ram.used_gb)} mono />
            <StatPill label="Swap"          value={ram.swap_total_gb > 0 ? `${ram.swap_percent.toFixed(0)}%` : 'N/D'} mono />
          </div>
        </SectionCard>

        {/* Disk */}
        <SectionCard
          title="Disco"
          accent="bg-amber-500"
          icon={
            <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
              <ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3"/>
              <path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"/>
            </svg>
          }
        >
          <GaugeBar
            label={`Partizione ${disk.path}`}
            pct={disk.percent}
            left={`${fmtGb(disk.used_gb)}`}
            right={`${fmtGb(disk.free_gb)} liberi`}
            subleft={`su ${fmtGb(disk.total_gb)}`}
          />
          {disk.path !== '/' && (
            <GaugeBar
              label="Root /"
              pct={disk.root_percent}
              left={`${fmtGb(disk.root_used_gb)}`}
              subleft={`su ${fmtGb(disk.root_total_gb)}`}
            />
          )}
          <div className="grid grid-cols-2 gap-x-4 pt-1 border-t border-slate-100 dark:border-white/5">
            <StatPill label="Totale disco"  value={fmtGb(disk.total_gb)} mono />
            <StatPill label="Libero"        value={fmtGb(disk.free_gb)} mono />
            <StatPill label="Usato"         value={fmtGb(disk.used_gb)} mono />
            <StatPill label="Utilizzo"      value={`${disk.percent.toFixed(1)}%`} mono />
          </div>
        </SectionCard>

        {/* Network */}
        <SectionCard
          title="Rete"
          accent="bg-cyan-500"
          icon={
            <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
              <path d="M5 12H19M12 5l7 7-7 7"/><path d="M19 12L12 5M5 12l7-7"/>
            </svg>
          }
        >
          <div className="grid grid-cols-2 gap-4">
            <div className="rounded-xl bg-slate-50 dark:bg-white/5 border border-slate-100 dark:border-white/5 p-4">
              <p className="text-[10px] font-bold text-slate-400 dark:text-slate-500 uppercase tracking-widest mb-1">
                ↓ Download
              </p>
              <p className="text-xl font-bold font-mono text-cyan-600 dark:text-cyan-400">
                {fmtBps(network.rx_bps)}
              </p>
              <p className="text-[11px] text-slate-400 dark:text-slate-500 font-mono mt-1">
                totale {fmtGb(network.rx_total_gb)}
              </p>
            </div>
            <div className="rounded-xl bg-slate-50 dark:bg-white/5 border border-slate-100 dark:border-white/5 p-4">
              <p className="text-[10px] font-bold text-slate-400 dark:text-slate-500 uppercase tracking-widest mb-1">
                ↑ Upload
              </p>
              <p className="text-xl font-bold font-mono text-indigo-600 dark:text-indigo-400">
                {fmtBps(network.tx_bps)}
              </p>
              <p className="text-[11px] text-slate-400 dark:text-slate-500 font-mono mt-1">
                totale {fmtGb(network.tx_total_gb)}
              </p>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-x-4 pt-1 border-t border-slate-100 dark:border-white/5">
            <StatPill label="Pacchetti rx"  value={network.rx_packets.toLocaleString()} mono />
            <StatPill label="Pacchetti tx"  value={network.tx_packets.toLocaleString()} mono />
            <StatPill label="RX totale"     value={fmtGb(network.rx_total_gb)} mono />
            <StatPill label="TX totale"     value={fmtGb(network.tx_total_gb)} mono />
          </div>
        </SectionCard>
      </div>

      {/* ── Load average detail + top processes ───────────────────────────── */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">

        {/* Load average */}
        <div className="rounded-2xl border border-slate-200 dark:border-white/5 bg-white dark:bg-[#151E32] p-6 space-y-4">
          <div className="flex items-center gap-3">
            <span className="w-1.5 h-6 rounded-full bg-rose-500" />
            <div className="w-8 h-8 rounded-lg flex items-center justify-center bg-rose-500/10">
              <svg className="w-4 h-4 text-rose-500" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                <path d="M22 12h-4l-3 9L9 3l-3 9H2"/>
              </svg>
            </div>
            <h3 className="text-sm font-bold text-slate-900 dark:text-white uppercase tracking-wider">Load Average</h3>
          </div>
          <div className="grid grid-cols-3 gap-3">
            {[
              { period: '1 min',  value: load.load1 },
              { period: '5 min',  value: load.load5 },
              { period: '15 min', value: load.load15 },
            ].map(({ period, value }) => {
              const ratio = value / load.cores;
              return (
                <div key={period} className="rounded-xl bg-slate-50 dark:bg-white/5 border border-slate-100 dark:border-white/5 p-3">
                  <p className="text-[10px] font-bold text-slate-400 dark:text-slate-500 uppercase tracking-widest mb-1">{period}</p>
                  <p className={`text-xl font-bold font-mono ${loadColor(ratio)}`}>{value.toFixed(2)}</p>
                  <p className="text-[10px] text-slate-400 dark:text-slate-500 font-mono mt-0.5">{(ratio * 100).toFixed(0)}% cores</p>
                  <div className="mt-2 h-1 bg-slate-200 dark:bg-white/8 rounded-full overflow-hidden">
                    <div
                      className={`h-full rounded-full ${ratio >= 0.85 ? 'bg-rose-500' : ratio >= 0.65 ? 'bg-amber-500' : 'bg-emerald-500'}`}
                      style={{ width: `${Math.min(100, ratio * 100)}%` }}
                    />
                  </div>
                </div>
              );
            })}
          </div>
          <p className="text-[11px] text-slate-400 dark:text-slate-500">
            Verde = &lt;65% · Giallo = 65–85% · Rosso = &gt;85% dei core logici ({load.cores} core)
          </p>
        </div>

        {/* Top processes */}
        <div className="rounded-2xl border border-slate-200 dark:border-white/5 bg-white dark:bg-[#151E32] p-6 space-y-4">
          <div className="flex items-center gap-3">
            <span className="w-1.5 h-6 rounded-full bg-slate-500" />
            <div className="w-8 h-8 rounded-lg flex items-center justify-center bg-slate-500/10">
              <svg className="w-4 h-4 text-slate-500" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                <path d="M9 3H5a2 2 0 00-2 2v4m6-6h10a2 2 0 012 2v4M9 3v18m0 0h10a2 2 0 002-2V9M9 21H5a2 2 0 01-2-2V9m0 0h18"/>
              </svg>
            </div>
            <h3 className="text-sm font-bold text-slate-900 dark:text-white uppercase tracking-wider">Top Processi (CPU)</h3>
          </div>
          <div className="rounded-xl border border-slate-100 dark:border-white/5 overflow-hidden">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-slate-100 dark:border-white/5 bg-slate-50 dark:bg-white/3">
                  <th className="text-left px-3 py-2 text-slate-400 font-medium">Processo</th>
                  <th className="text-right px-3 py-2 text-slate-400 font-medium">CPU</th>
                  <th className="text-right px-3 py-2 text-slate-400 font-medium">RAM</th>
                  <th className="text-right px-3 py-2 text-slate-400 font-medium">Stato</th>
                </tr>
              </thead>
              <tbody>
                {top_processes.map((p, i) => (
                  <tr key={p.pid} className={`border-b border-slate-50 dark:border-white/3 transition-colors ${i % 2 === 0 ? '' : 'bg-slate-50/50 dark:bg-white/[0.02]'}`}>
                    <td className="px-3 py-2">
                      <div className="flex items-center gap-2">
                        <span className="font-medium text-slate-700 dark:text-slate-200 truncate max-w-[120px]">{p.name}</span>
                        <span className="text-[9px] text-slate-400 font-mono">{p.pid}</span>
                      </div>
                    </td>
                    <td className="px-3 py-2 text-right font-mono font-bold">
                      <span className={p.cpu >= 50 ? 'text-rose-500' : p.cpu >= 20 ? 'text-amber-500' : 'text-slate-600 dark:text-slate-300'}>
                        {p.cpu.toFixed(1)}%
                      </span>
                    </td>
                    <td className="px-3 py-2 text-right font-mono text-slate-500 dark:text-slate-400">
                      {p.mem.toFixed(1)}%
                    </td>
                    <td className="px-3 py-2 text-right">
                      <span className={`text-[9px] font-bold uppercase px-1.5 py-0.5 rounded ${
                        p.status === 'running' ? 'bg-emerald-50 dark:bg-emerald-500/10 text-emerald-600 dark:text-emerald-400' : 'bg-slate-100 dark:bg-white/5 text-slate-400'
                      }`}>
                        {p.status}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>

    </div>
  );
};
