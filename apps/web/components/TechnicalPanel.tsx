
import React, { useState, useEffect, useRef } from 'react';
import { TechnicalAnalysis, Sentiment, Candle } from '../types';
import { ExplanationModal } from './ExplanationModal';
import { getIndicatorExplanation, getEthDataExplanation, getEthBtcExplanation, getOnChainExplanation } from '../utils/explanations';

interface Props {
  technical: TechnicalAnalysis;
  asset: 'BTC' | 'ETH' | 'SOL' | null;
}

// 4H Countdown Component
const CycleCountdown = () => {
    const [timeLeft, setTimeLeft] = useState('');

    useEffect(() => {
        const calculateTime = () => {
            const now = new Date();
            const hours = now.getUTCHours();
            const nextCloseHour = Math.ceil((hours + 1) / 4) * 4;
            let target = new Date(now);
            target.setUTCHours(nextCloseHour % 24, 0, 0, 0);
            if (nextCloseHour >= 24) target.setUTCDate(target.getUTCDate() + 1);

            const diff = target.getTime() - now.getTime();
            const h = Math.floor(diff / (1000 * 60 * 60));
            const m = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));
            const s = Math.floor((diff % (1000 * 60)) / 1000);
            setTimeLeft(`${h}h ${m}m ${s}s`);
        };
        const t = setInterval(calculateTime, 1000);
        calculateTime();
        return () => clearInterval(t);
    }, []);

    return (
        <div className="flex items-center gap-2 px-3 py-1 bg-slate-100 dark:bg-white/5 rounded-lg border border-slate-200 dark:border-white/10 mt-2 md:mt-0">
            <div className="w-2 h-2 rounded-full bg-indigo-500 animate-pulse"></div>
            <span className="text-[10px] font-bold text-slate-500 dark:text-slate-400 uppercase">4H Close In:</span>
            <span className="text-xs font-mono font-bold text-slate-900 dark:text-white">{timeLeft}</span>
        </div>
    );
};

// TradingView Lightweight Chart Component
const InteractiveChart: React.FC<{ data: Candle[], color: string }> = ({ data, color }) => {
    const chartContainerRef = useRef<HTMLDivElement>(null);
    const chartRef = useRef<any>(null);

    useEffect(() => {
        if (!chartContainerRef.current || !data || data.length === 0) return;

        if (!(window as any).LightweightCharts) {
            console.error('LightweightCharts library not found on window object.');
            return;
        }

        const { createChart } = (window as any).LightweightCharts;

        const chart = createChart(chartContainerRef.current, {
            layout: { 
                background: { type: 'solid', color: 'transparent' }, 
                textColor: '#64748b' 
            },
            grid: {
                vertLines: { color: 'rgba(197, 203, 206, 0.05)' },
                horzLines: { color: 'rgba(197, 203, 206, 0.05)' },
            },
            width: chartContainerRef.current.clientWidth,
            height: 300,
            rightPriceScale: { borderVisible: false },
            timeScale: { 
                borderVisible: false, 
                timeVisible: true,
                secondsVisible: false,
            },
            // Enable interactions for zoom/scroll
            handleScale: true,
            handleScroll: true,
        });

        const candlestickSeries = chart.addCandlestickSeries({
            upColor: '#10B981',
            downColor: '#F43F5E',
            borderVisible: false,
            wickUpColor: '#10B981',
            wickDownColor: '#F43F5E',
        });

        candlestickSeries.setData(data);
        
        // --- Calculate and Add SMA 50 and SMA 200 ---
        const calculateSMA = (data: Candle[], count: number) => {
            if (data.length < count) return [];
            const result = [];
            // Simple moving average calculation
            for (let i = count - 1; i < data.length; i++) {
                const slice = data.slice(i - count + 1, i + 1);
                const sum = slice.reduce((a, b) => a + b.close, 0);
                const val = sum / count;
                result.push({ time: data[i].time, value: val });
            }
            return result;
        };

        const sma50Data = calculateSMA(data, 50);
        const sma200Data = calculateSMA(data, 200);

        if (sma50Data.length > 0) {
            const sma50Series = chart.addLineSeries({
                color: '#3B82F6', // Blue for SMA 50
                lineWidth: 2,
                title: '', // EMPTY TITLE TO HIDE LEGEND ON CHART
                priceLineVisible: false,
                crosshairMarkerVisible: false,
            });
            sma50Series.setData(sma50Data);
        }

        if (sma200Data.length > 0) {
            const sma200Series = chart.addLineSeries({
                color: '#8B5CF6', // Purple for SMA 200
                lineWidth: 2,
                title: '', // EMPTY TITLE TO HIDE LEGEND ON CHART
                priceLineVisible: false,
                crosshairMarkerVisible: false,
            });
            sma200Series.setData(sma200Data);
        }
        // --------------------------------------------

        // Fit content initially but allow user to scroll
        chart.timeScale().fitContent();
        
        chartRef.current = chart;

        const handleResize = () => {
            if (chartContainerRef.current && chartRef.current) {
                chartRef.current.applyOptions({ width: chartContainerRef.current.clientWidth });
            }
        };

        window.addEventListener('resize', handleResize);
        return () => {
            window.removeEventListener('resize', handleResize);
            if(chartRef.current) {
                chartRef.current.remove();
            }
        };
    }, [data, color]);

    return <div ref={chartContainerRef} className="w-full h-[300px]" />;
};

export const TechnicalPanel: React.FC<Props> = ({ technical, asset }) => {
  const [selectedItem, setSelectedItem] = useState<{title: string, signal: string, desc: string} | null>(null);
  
  const chartColor = asset === 'BTC' ? '#F97316' : asset === 'ETH' ? '#3B82F6' : '#9945FF';

  return (
    <div className="flex flex-col gap-6 h-full">
      <ExplanationModal isOpen={!!selectedItem} onClose={() => setSelectedItem(null)} title={selectedItem?.title || ''} sentiment={selectedItem?.signal || ''} content={selectedItem?.desc || ''} />

      {/* 1. PRICE & CHART HERO SECTION */}
      <div className="elegant-card p-6 md:p-8">
        {/* Mobile: Left aligned vertical stack. Desktop: Row space-between */}
        <div className="flex flex-col md:flex-row justify-between items-start md:items-start gap-5 mb-6">
            
            <div className="flex flex-col gap-1 items-start w-full md:w-auto">
                {/* Brand Row */}
                <div className="flex items-center gap-3">
                    <div className={`p-2 rounded-xl ${asset === 'BTC' ? 'bg-orange-50 dark:bg-orange-500/10' : asset === 'ETH' ? 'bg-blue-50 dark:bg-blue-500/10' : 'bg-[#9945FF]/10'}`}>
                        {asset === 'BTC' && <img src="https://upload.wikimedia.org/wikipedia/commons/4/46/Bitcoin.svg" alt="BTC" className="w-8 h-8" />}
                        {asset === 'ETH' && <svg className="w-8 h-8 text-blue-600 dark:text-blue-400" viewBox="0 0 24 24" fill="currentColor"><path d="M12 1.75l-6.13 9.25 6.13 3.42 6.13-3.42L12 1.75z m0 15.5l-6.13-3.42 6.13 9.42 6.13-9.42-6.13 3.42z"/></svg>}
                        {asset === 'SOL' && (
                        <img 
                            src="https://upload.wikimedia.org/wikipedia/en/b/b9/Solana_logo.png" 
                            alt="Solana" 
                            className="w-8 h-8 object-contain"
                        />
                        )}
                    </div>
                    <span className="text-sm font-bold text-slate-500 dark:text-slate-400 uppercase tracking-wider block pt-1">{asset} / USDT</span>
                </div>
                {/* Big Price */}
                <div className="text-4xl md:text-5xl font-bold text-slate-900 dark:text-white tracking-tight font-mono mt-2">
                    ${technical.price?.toLocaleString()}
                </div>
            </div>

            {/* Countdown aligned right on desktop, flows naturally on mobile */}
            <div className="self-start md:self-auto">
                <CycleCountdown />
            </div>
        </div>

        {/* Interactive Chart */}
        <div className="w-full mb-2 border-b border-slate-100 dark:border-white/5 pb-2">
             <InteractiveChart data={technical.priceHistory || []} color={chartColor} />
        </div>
        
        {/* Legend for Chart */}
        <div className="flex justify-center gap-6">
            <div className="flex items-center gap-2">
                <div className="w-2 h-2 rounded-full bg-blue-500"></div>
                <span className="text-[10px] font-bold text-slate-500 dark:text-slate-400 uppercase">SMA 50 (4H)</span>
            </div>
            <div className="flex items-center gap-2">
                <div className="w-2 h-2 rounded-full bg-purple-500"></div>
                <span className="text-[10px] font-bold text-slate-500 dark:text-slate-400 uppercase">SMA 200 (4H)</span>
            </div>
        </div>
      </div>

      {/* 2. ISOLATED INTRADAY 4H DEEP DIVE */}
      {technical.shortTerm && (
          <div className="elegant-card p-0 overflow-hidden border-l-4 border-l-indigo-500">
              <div className="bg-slate-50 dark:bg-slate-800/50 px-6 py-3 border-b border-slate-100 dark:border-white/5 flex justify-between items-center">
                   <h3 className="text-xs font-bold text-indigo-600 dark:text-indigo-400 uppercase tracking-widest">Intraday Deep Dive (4H Only)</h3>
                   <span className={`text-[10px] px-2 py-1 rounded font-bold uppercase ${technical.shortTerm.trend4h === 'Bullish' ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-400' : technical.shortTerm.trend4h === 'Bearish' ? 'bg-rose-100 text-rose-700 dark:bg-rose-500/10 dark:text-rose-400' : 'bg-slate-100 text-slate-600 dark:bg-slate-500/10 dark:text-slate-400'}`}>
                       {technical.shortTerm.trend4h} Trend
                   </span>
              </div>
              <div className="p-6 grid grid-cols-1 md:grid-cols-2 gap-6">
                  {/* Metrics */}
                  <div className="grid grid-cols-2 gap-4">
                      <div>
                          <div className="text-[10px] text-slate-400 font-bold uppercase mb-1">EMA Structure</div>
                          <div className="text-sm font-bold text-slate-800 dark:text-slate-200">{technical.shortTerm.emaSignal}</div>
                      </div>
                      <div>
                          <div className="text-[10px] text-slate-400 font-bold uppercase mb-1">Volume Status</div>
                          <div className={`text-sm font-bold ${technical.shortTerm.volumeStatus === 'High' ? 'text-indigo-500' : 'text-slate-800 dark:text-slate-200'}`}>{technical.shortTerm.volumeStatus}</div>
                      </div>
                      <div>
                          <div className="text-[10px] text-slate-400 font-bold uppercase mb-1">4H RSI</div>
                          <div className="text-sm font-mono font-bold text-slate-800 dark:text-slate-200">{technical.shortTerm.rsi4h}</div>
                      </div>
                      <div>
                          <div className="text-[10px] text-slate-400 font-bold uppercase mb-1">Local Sup/Res</div>
                          <div className="text-xs font-mono text-slate-600 dark:text-slate-300">
                              <span className="text-emerald-500">{technical.shortTerm.support4h?.toLocaleString() || 'N/A'}</span> / <span className="text-rose-500">{technical.shortTerm.resistance4h?.toLocaleString() || 'N/A'}</span>
                          </div>
                      </div>
                  </div>
                  {/* AI Price Action Commentary */}
                  <div className="bg-slate-50 dark:bg-white/5 rounded-xl p-4">
                      <div className="text-[10px] text-slate-400 font-bold uppercase mb-2">Price Action Context</div>
                      <p className="text-sm text-slate-700 dark:text-slate-300 leading-relaxed italic">
                          "{technical.shortTerm.priceAction}"
                      </p>
                  </div>
              </div>
          </div>
      )}

      {/* 3. STRUCTURE, ROTATION & CORRELATION ROW */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          
          {/* Market Structure Card */}
          {technical.trendStructure && (
            <div className="elegant-card p-6 flex flex-col justify-between">
                <div className="flex items-center justify-between mb-4">
                    <h4 className="text-sm font-bold text-slate-900 dark:text-white flex items-center gap-2">
                        <svg className="w-4 h-4 text-slate-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10" /></svg>
                        Market Structure
                    </h4>
                    <span className="text-xs font-mono text-indigo-600 dark:text-indigo-400 bg-indigo-50 dark:bg-indigo-500/10 px-2 py-1 rounded font-semibold">
                       {technical.trendStructure.marketPhase}
                    </span>
                </div>
                
                <div className="grid grid-cols-2 gap-4 mb-4">
                    <div className="p-3 rounded-xl bg-slate-50 dark:bg-slate-800/50 border border-slate-100 dark:border-white/5 text-center">
                        <div className="text-[10px] font-bold text-slate-400 uppercase mb-1">Weekly Trend</div>
                        <div className={`text-sm font-bold ${technical.trendStructure.weekly === 'Bullish' ? 'text-emerald-600' : 'text-rose-600'}`}>
                            {technical.trendStructure.weekly}
                        </div>
                    </div>
                    <div className="p-3 rounded-xl bg-slate-50 dark:bg-slate-800/50 border border-slate-100 dark:border-white/5 text-center">
                        <div className="text-[10px] font-bold text-slate-400 uppercase mb-1">Daily Trend</div>
                        <div className={`text-sm font-bold ${technical.trendStructure.daily === 'Bullish' ? 'text-emerald-600' : 'text-rose-600'}`}>
                            {technical.trendStructure.daily}
                        </div>
                    </div>
                </div>

                {/* A-01: Confluence Score */}
                {technical.confluenceScore !== undefined && (
                  <div className="mt-2 p-3 rounded-xl bg-slate-50 dark:bg-slate-800/50 border border-slate-100 dark:border-white/5">
                    <div className="flex justify-between items-center mb-2">
                      <span className="text-[10px] font-bold text-slate-400 uppercase">Confluence Score</span>
                      <span className={`text-xs font-bold px-2 py-0.5 rounded ${
                        technical.confluenceScore >= 70 ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-400' :
                        technical.confluenceScore >= 40 ? 'bg-orange-100 text-orange-700 dark:bg-orange-500/10 dark:text-orange-400' :
                        'bg-rose-100 text-rose-700 dark:bg-rose-500/10 dark:text-rose-400'
                      }`}>
                        {technical.confluenceScore >= 70 ? 'Bullish' : technical.confluenceScore >= 40 ? 'Neutral' : 'Bearish'}
                      </span>
                    </div>
                    <div className="relative h-2.5 w-full bg-gradient-to-r from-rose-500 via-orange-400 to-emerald-500 rounded-full overflow-hidden">
                      <div
                        className="absolute top-0 bottom-0 bg-black/20 dark:bg-white/20 rounded-full"
                        style={{ left: `${technical.confluenceScore}%`, width: '3px', transform: 'translateX(-50%)' }}
                      />
                    </div>
                    <div className="flex justify-between text-[10px] font-mono text-slate-400 mt-1">
                      <span>Bearish</span>
                      <span className="font-bold text-slate-900 dark:text-white">{technical.confluenceScore}/100</span>
                      <span>Bullish</span>
                    </div>
                  </div>
                )}
            </div>
          )}

          {/* Capital Rotation Card */}
          {(asset === 'BTC' || asset === 'ETH') && technical.ethBtcRatio && technical.ethBtcRatio.value !== undefined && (
            <button 
                onClick={() => setSelectedItem({ title: 'ETH/BTC Ratio', signal: technical.ethBtcRatio.signal, desc: getEthBtcExplanation(technical.ethBtcRatio.trend, asset) })}
                className="elegant-card p-6 flex flex-col justify-between text-left hover:border-indigo-300 dark:hover:border-indigo-500/30 transition-colors group"
            >
                <div className="flex items-center justify-between mb-4">
                    <h4 className="text-sm font-bold text-slate-900 dark:text-white flex items-center gap-2">
                        <svg className="w-4 h-4 text-slate-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7h12m0 0l-4-4m4 4l-4 4m0 6H4m0 0l4 4m-4-4l4-4" /></svg>
                        Capital Rotation
                    </h4>
                    <span className={`text-[10px] font-bold px-2 py-1 rounded ${technical.ethBtcRatio.trend === 'Bullish' ? 'bg-blue-100 text-blue-700 dark:bg-blue-500/10 dark:text-blue-400' : 'bg-orange-100 text-orange-700 dark:bg-orange-500/10 dark:text-orange-400'}`}>
                        {technical.ethBtcRatio.trend === 'Bullish' ? 'Alt Season' : 'BTC Season'}
                    </span>
                </div>

                <div className="flex items-end justify-between mb-4">
                     <div>
                        <div className="text-[10px] font-bold text-slate-400 uppercase mb-1">ETH / BTC</div>
                        <div className="text-2xl font-mono font-bold text-slate-900 dark:text-white">{technical.ethBtcRatio.value?.toFixed(5)}</div>
                     </div>
                     <div className="text-right">
                        <div className="text-[10px] font-bold text-slate-400 uppercase mb-1">Signal</div>
                        <div className="text-sm font-bold text-slate-700 dark:text-slate-300">{technical.ethBtcRatio.signal}</div>
                     </div>
                </div>
                
                {/* Visual Bar - Simplified and consistent with Correlation card style */}
                <div className="w-full h-2 bg-slate-100 dark:bg-slate-800 rounded-full overflow-hidden flex mb-2">
                    <div style={{ width: `${Math.min(100, (technical.ethBtcRatio.value / 0.1) * 100)}%` }} className={`h-full transition-all duration-500 ${technical.ethBtcRatio.trend === 'Bullish' ? 'bg-blue-500' : 'bg-orange-500'}`}></div>
                </div>
                <p className="text-[10px] text-slate-500 dark:text-slate-400 leading-relaxed mt-2">
                    {technical.ethBtcRatio.trend === 'Bullish' 
                      ? 'ETH sta sovraperformando BTC. Probabile rotazione verso Altcoins.' 
                      : 'BTC sta dominando il mercato. Le Altcoins tendono ad essere più deboli.'}
                </p>
            </button>
          )}

          {/* A-07: BTC-ETH 30-day Correlation */}
          {technical.btcEthCorrelation !== undefined && (
            <div className="elegant-card p-6 flex flex-col justify-between">
              <div className="flex items-center justify-between mb-4">
                <h4 className="text-sm font-bold text-slate-900 dark:text-white flex items-center gap-2">
                  <svg className="w-4 h-4 text-slate-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 7h8m0 0v8m0-8l-8 8-4-4-6 6" /></svg>
                  BTC / ETH Correlation
                </h4>
                <span className="text-[10px] font-bold text-slate-400 px-2 py-1 bg-slate-100 dark:bg-white/5 rounded">30 Days</span>
              </div>
              <div className="flex items-end justify-between mb-3">
                <div>
                  <div className="text-[10px] font-bold text-slate-400 uppercase mb-1">Pearson r</div>
                  <div className={`text-2xl font-mono font-bold ${
                    technical.btcEthCorrelation >= 0.85 ? 'text-emerald-600 dark:text-emerald-400' :
                    technical.btcEthCorrelation >= 0.6  ? 'text-orange-500' :
                    'text-rose-500'
                  }`}>{technical.btcEthCorrelation.toFixed(2)}</div>
                </div>
                <div className="text-right">
                  <div className="text-[10px] font-bold text-slate-400 uppercase mb-1">Regime</div>
                  <div className="text-sm font-bold text-slate-700 dark:text-slate-300">
                    {technical.btcEthCorrelation >= 0.85 ? 'Risk-On' : technical.btcEthCorrelation >= 0.6 ? 'Moderate' : 'Decorrelated'}
                  </div>
                </div>
              </div>
              <div className="w-full h-2 bg-gradient-to-r from-rose-500 via-orange-400 to-emerald-500 rounded-full relative">
                <div className="absolute top-[-4px] w-2 h-4 bg-slate-900 dark:bg-white border-2 border-white dark:border-slate-900 rounded shadow" style={{ left: `${((technical.btcEthCorrelation + 1) / 2) * 100}%`, transform: 'translateX(-50%)' }} />
              </div>
              <p className="text-[10px] text-slate-500 dark:text-slate-400 mt-3 leading-relaxed">
                {technical.btcEthCorrelation >= 0.85
                  ? 'Alta correlazione — BTC e ETH si muovono insieme. Altseason improbabile ora.'
                  : technical.btcEthCorrelation >= 0.6
                  ? 'Correlazione moderata — possibile rotazione selettiva verso ETH.'
                  : 'Bassa correlazione — BTC si muove indipendentemente. ETH può divergere.'}
              </p>
            </div>
          )}

          {/* A-08: Macro Correlation (SP500 & DXY) */}
          {technical.macroCorrelation && (
            <div className="elegant-card p-6 flex flex-col justify-between lg:col-span-3">
              <div className="flex items-center justify-between mb-6">
                <h4 className="text-sm font-bold text-slate-900 dark:text-white flex items-center gap-2">
                  <svg className="w-4 h-4 text-slate-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" /></svg>
                  Macro-Crypto Correlation Matrix
                </h4>
                <div className="flex gap-2">
                  <span className="text-[10px] font-bold text-slate-400 px-2 py-1 bg-slate-100 dark:bg-white/5 rounded">30D Returns vs {asset}</span>
                </div>
              </div>
              
              <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
                {/* S&P 500 Correlation */}
                <div className="space-y-4">
                  <div className="flex justify-between items-end">
                    <div>
                      <div className="text-[10px] font-bold text-slate-400 uppercase">S&P 500 Correlation</div>
                      <div className={`text-2xl font-mono font-bold ${technical.macroCorrelation.sp500 > 0.6 ? 'text-indigo-600' : 'text-slate-700 dark:text-slate-300'}`}>
                        {technical.macroCorrelation.sp500.toFixed(2)}
                      </div>
                    </div>
                    <div className="text-[10px] font-bold px-2 py-1 rounded bg-slate-100 dark:bg-white/5 text-slate-500 uppercase">
                      {technical.macroCorrelation.sp500 > 0.7 ? 'High Coupling' : technical.macroCorrelation.sp500 > 0.3 ? 'Moderate' : 'Uncoupled'}
                    </div>
                  </div>
                  <div className="w-full h-2 bg-slate-100 dark:bg-slate-800 rounded-full relative">
                    <div className="absolute top-0 bottom-0 bg-indigo-500 rounded-full" style={{ left: `${((technical.macroCorrelation.sp500 + 1) / 2) * 100}%`, width: '4px', transform: 'translateX(-50%)' }} />
                  </div>
                  <p className="text-[10px] text-slate-500 italic">
                    {technical.macroCorrelation.sp500 > 0.7 
                      ? `${asset} sta seguendo fedelmente il mercato azionario US.` 
                      : `${asset} mostra segnali di indipendenza dall'S&P 500.`}
                  </p>
                </div>

                {/* DXY Correlation */}
                <div className="space-y-4">
                  <div className="flex justify-between items-end">
                    <div>
                      <div className="text-[10px] font-bold text-slate-400 uppercase">DXY (Dollar) Correlation</div>
                      <div className={`text-2xl font-mono font-bold ${technical.macroCorrelation.dxy < -0.6 ? 'text-rose-600' : 'text-slate-700 dark:text-slate-300'}`}>
                        {technical.macroCorrelation.dxy.toFixed(2)}
                      </div>
                    </div>
                    <div className="text-[10px] font-bold px-2 py-1 rounded bg-slate-100 dark:bg-white/5 text-slate-500 uppercase">
                      {technical.macroCorrelation.dxy < -0.6 ? 'Inverse Link' : 'Neutral'}
                    </div>
                  </div>
                  <div className="w-full h-2 bg-slate-100 dark:bg-slate-800 rounded-full relative">
                    <div className="absolute top-0 bottom-0 bg-rose-500 rounded-full" style={{ left: `${((technical.macroCorrelation.dxy + 1) / 2) * 100}%`, width: '4px', transform: 'translateX(-50%)' }} />
                  </div>
                  <p className="text-[10px] text-slate-500 italic">
                    {technical.macroCorrelation.dxy < -0.6 
                      ? 'Forte legame inverso: un dollaro forte penalizza il prezzo di ' + asset + '.' 
                      : 'L\'andamento del dollaro non sta influenzando pesantemente il prezzo.'}
                  </p>
                </div>
              </div>
            </div>
          )}
      </div>

      {/* 4. INDICATORS GRID */}
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-4">
            {/* RSI */}
            <button 
                onClick={() => technical.rsi && setSelectedItem({ title: 'RSI (Relative Strength Index)', signal: technical.rsi.status, desc: getIndicatorExplanation('RSI', technical.rsi.value > 50 ? Sentiment.BULLISH : Sentiment.BEARISH) })}
                className="elegant-card p-4 flex flex-col items-center justify-center text-center hover:bg-slate-50 dark:hover:bg-slate-800/50 transition-colors"
            >
                <span className="text-[10px] font-bold text-slate-400 uppercase mb-2">RSI (4H)</span>
                <span className={`text-xl font-mono font-bold mb-1 ${technical.rsi.value > 70 || technical.rsi.value < 30 ? 'text-indigo-600 dark:text-indigo-400' : 'text-slate-900 dark:text-white'}`}>
                    {technical.rsi.value}
                </span>
                <span className="text-[10px] text-slate-500">{technical.rsi.status}</span>
                {technical.rsi.divergence !== 'None' && (
                    <span className="mt-2 text-[9px] px-1.5 py-0.5 bg-indigo-100 dark:bg-indigo-500/20 text-indigo-700 dark:text-indigo-300 rounded font-bold">{technical.rsi.divergence} Div</span>
                )}
            </button>

            {/* MACD */}
            <button 
                 onClick={() => technical.macd && setSelectedItem({ title: 'MACD', signal: technical.macd.status, desc: getIndicatorExplanation('MACD', technical.macd.status.includes('Bullish') ? Sentiment.BULLISH : Sentiment.BEARISH) })}
                 className="elegant-card p-4 flex flex-col items-center justify-center text-center hover:bg-slate-50 dark:hover:bg-slate-800/50 transition-colors"
            >
                <span className="text-[10px] font-bold text-slate-400 uppercase mb-2">MACD</span>
                <div className={`w-8 h-8 rounded-full flex items-center justify-center mb-1 ${technical.macd.status.includes('Bullish') ? 'bg-emerald-100 dark:bg-emerald-500/10 text-emerald-600' : 'bg-rose-100 dark:bg-rose-500/10 text-rose-600'}`}>
                    {technical.macd.status.includes('Bullish') ? '▲' : '▼'}
                </div>
                <span className={`text-[10px] font-bold ${technical.macd.status.includes('Bullish') ? 'text-emerald-600' : 'text-rose-600'}`}>
                    {technical.macd.status.includes('Bullish') ? 'Golden Cross' : 'Death Cross'}
                </span>
            </button>

            {/* A-03: ATR Volatility Heatmap */}
            <div className="elegant-card p-4 flex flex-col items-center justify-center text-center relative overflow-hidden">
                {technical.volatility.bollingerBands.squeeze && (
                  <div className="absolute top-0 left-0 right-0 h-1 bg-indigo-500 animate-pulse"></div>
                )}
                <span className="text-[10px] font-bold text-slate-400 uppercase mb-2">Volatility Regime</span>
                <span className="text-lg font-mono font-bold text-slate-900 dark:text-white mb-1">${technical.volatility.atr}</span>
                <div className="flex items-center gap-2 mb-1">
                  <span className={`text-[10px] font-bold px-2 py-0.5 rounded ${
                    technical.volatility.volatilityHeatmap === 'Explosive' ? 'bg-red-100 text-red-700 dark:bg-red-500/10 dark:text-red-400' :
                    technical.volatility.volatilityHeatmap === 'High'      ? 'bg-orange-100 text-orange-700 dark:bg-orange-500/10 dark:text-orange-400' :
                    technical.volatility.volatilityHeatmap === 'Compressed'? 'bg-blue-100 text-blue-700 dark:bg-blue-500/10 dark:text-blue-400' :
                    'bg-slate-100 text-slate-600 dark:bg-slate-700 dark:text-slate-400'
                  }`}>
                    {technical.volatility.volatilityHeatmap}
                  </span>
                  {technical.volatility.bollingerBands.squeeze && (
                    <span className="text-[10px] font-bold px-2 py-0.5 rounded bg-indigo-500 text-white animate-pulse">SQUEEZE</span>
                  )}
                </div>
                {technical.volatility.atrRatio !== undefined && (
                  <span className="text-[9px] text-slate-400 font-mono">Ratio: {technical.volatility.atrRatio}x avg</span>
                )}
            </div>

             {/* P-04: Open Interest (Real — Binance Futures) */}
             <div className="elegant-card p-4 flex flex-col items-center justify-center text-center">
                <span className="text-[10px] font-bold text-slate-400 uppercase mb-2">Open Interest</span>
                <span className={`text-lg font-mono font-bold mb-1 ${
                  technical.openInterest !== 'N/A' ? 'text-slate-900 dark:text-white' : 'text-slate-400'
                }`}>{technical.openInterest || 'N/A'}</span>
                <span className="text-[9px] text-slate-400 font-bold uppercase">Binance Futures</span>
             </div>

             {/* P-04: Funding Rate (Real — Binance Futures) */}
             <div className="elegant-card p-4 flex flex-col items-center justify-center text-center">
                <span className="text-[10px] font-bold text-slate-400 uppercase mb-2">Funding Rate</span>
                <span className={`text-lg font-mono font-bold mb-1 ${
                  technical.fundingRate && technical.fundingRate.startsWith('+') ? 'text-emerald-600 dark:text-emerald-400' :
                  technical.fundingRate && technical.fundingRate.startsWith('-') ? 'text-rose-600 dark:text-rose-400' :
                  'text-slate-400'
                }`}>{technical.fundingRate || 'N/A'}</span>
                <span className="text-[9px] text-slate-400 font-bold uppercase">8h Perpetual</span>
             </div>
      </div>

      {/* 5. ON-CHAIN & CYCLICAL MODELS */}
      {(asset === 'BTC' || asset === 'ETH') && technical.onChain && technical.cycles && (
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
            {/* AI Estimate Disclaimer */}
            <div className="md:col-span-3 flex items-center gap-2 px-3 py-2 bg-amber-50 dark:bg-amber-500/10 border border-amber-200 dark:border-amber-500/20 rounded-lg">
              <svg className="w-3.5 h-3.5 text-amber-500 flex-shrink-0" fill="currentColor" viewBox="0 0 20 20"><path fillRule="evenodd" d="M8.485 2.495c.673-1.167 2.357-1.167 3.03 0l6.28 10.875c.673 1.167-.17 2.625-1.516 2.625H3.72c-1.347 0-2.189-1.458-1.515-2.625L8.485 2.495zM10 5a.75.75 0 01.75.75v3.5a.75.75 0 01-1.5 0v-3.5A.75.75 0 0110 5zm0 9a1 1 0 100-2 1 1 0 000 2z" clipRule="evenodd" /></svg>
              <span className="text-[10px] font-semibold text-amber-700 dark:text-amber-400">On-Chain Estimates — MVRV Z-Score and NUPL are stime basate su analisi AI e non dati on-chain verificati da Glassnode/CryptoQuant. Usare come indicazione qualitativa.</span>
            </div>

            {/* MVRV Gauge */}
            <button 
                onClick={() => setSelectedItem({ title: 'MVRV Z-Score', signal: 'Valuation', desc: getOnChainExplanation('MVRV', technical.onChain?.mvrvZScore) })}
                className="elegant-card p-5 hover:border-indigo-300 dark:hover:border-indigo-500/30 transition-colors"
            >
                <div className="text-[10px] font-bold text-slate-400 uppercase mb-3">MVRV Z-Score (Valuation)</div>
                <div className="relative h-3 bg-gradient-to-r from-emerald-500 via-yellow-400 to-rose-500 rounded-full w-full mb-2">
                    <div 
                        className="absolute top-[-4px] w-2 h-5 bg-slate-900 dark:bg-white border border-white dark:border-slate-900 shadow-md rounded"
                        style={{ left: `${Math.min(100, Math.max(0, (Number(technical.onChain.mvrvZScore) + 1) / 8 * 100))}%` }} // Maps range -1 to 7 approx
                    ></div>
                </div>
                <div className="flex justify-between text-[10px] font-mono text-slate-500">
                    <span>Undervalued</span>
                    <span className="font-bold text-slate-900 dark:text-white text-sm">{Number(technical.onChain.mvrvZScore).toFixed(2)}</span>
                    <span>Overvalued</span>
                </div>
            </button>

            {/* Cycle Progress */}
            <button 
                onClick={() => setSelectedItem({ title: '4-Year Cycle', signal: 'Progress', desc: getOnChainExplanation('Cycle', technical.cycles?.progressInCycle) })}
                className="elegant-card p-5 hover:border-indigo-300 dark:hover:border-indigo-500/30 transition-colors"
            >
                <div className="flex justify-between items-center mb-3">
                     <div className="text-[10px] font-bold text-slate-400 uppercase">Cycle Progress</div>
                     <div className="text-[10px] font-bold text-indigo-500">{technical.cycles.daysSinceHalving} Days since Halving</div>
                </div>
                
                <div className="relative h-3 bg-slate-100 dark:bg-slate-800 rounded-full w-full overflow-hidden mb-2">
                    <div 
                        className="h-full bg-indigo-500 rounded-full"
                        style={{ width: `${technical.cycles.progressInCycle}%` }}
                    ></div>
                </div>
                <div className="flex justify-between text-[10px] font-mono text-slate-500">
                    <span>Halving</span>
                    <span className="font-bold text-slate-900 dark:text-white text-sm">{technical.cycles.progressInCycle}%</span>
                    <span>Projected Top</span>
                </div>
            </button>

            {/* Seasonality / NUPL */}
            <div className="elegant-card p-5 flex flex-col justify-between">
                <div className="text-[10px] font-bold text-slate-400 uppercase mb-1">Historical Seasonality</div>
                <p className="text-xs text-slate-600 dark:text-slate-300 leading-relaxed font-medium border-l-2 border-indigo-500 pl-3 my-2">
                    {technical.cycles.historicalSeasonality}
                </p>
                <div className="flex justify-between items-center pt-2 border-t border-slate-100 dark:border-white/5 mt-1">
                     <span className="text-[10px] font-bold text-slate-400 uppercase">NUPL Sentiment</span>
                     <span className={`text-xs font-bold ${Number(technical.onChain.nupl) > 0.5 ? 'text-rose-500' : Number(technical.onChain.nupl) < 0 ? 'text-emerald-500' : 'text-orange-500'}`}>
                        {Number(technical.onChain.nupl).toFixed(2)}
                     </span>
                </div>
            </div>

        </div>
      )}

      {/* 6. ORDER BOOK BAR (Full Width) */}
      {technical.orderBook && (
        <div className="elegant-card p-6">
            <div className="flex justify-between items-center mb-5">
                <span className="text-xs font-bold text-slate-500 uppercase tracking-wider flex items-center gap-2">
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 7v10c0 2 1 3 3 3h10c2 0 3-1 3-3V7c0-2-1-3-3-3H7c-2 0-3 1-3 3z" /></svg>
                    Real-Time Order Book Strength
                </span>
                <span className={`text-xs font-bold px-3 py-1 rounded-full ${technical.orderBook.imbalance === 'Bullish' ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-400' : technical.orderBook.imbalance === 'Bearish' ? 'bg-rose-100 text-rose-700 dark:bg-rose-500/10 dark:text-rose-400' : 'bg-slate-100 text-slate-500'}`}>
                    {technical.orderBook.imbalance} Imbalance
                </span>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-8 mb-6">
                {/* Major Bids Wall */}
                <div className="bg-emerald-50/30 dark:bg-emerald-500/5 rounded-2xl p-4 border border-emerald-100/50 dark:border-emerald-500/10">
                    <div className="text-[10px] font-bold text-emerald-600 dark:text-emerald-400 uppercase mb-3 flex justify-between">
                        <span>Principale Supporto (Wall)</span>
                        <span>{technical.orderBook.bidPressure.toFixed(1)}%</span>
                    </div>
                    <div className="flex justify-between items-end">
                        <div className="text-2xl font-mono font-bold text-emerald-700 dark:text-emerald-400">
                            ${technical.orderBook.maxBidWall?.price.toLocaleString()}
                        </div>
                        <div className="text-right">
                            <div className="text-[10px] text-slate-400 font-bold uppercase">Volume</div>
                            <div className="text-xs font-mono font-bold text-slate-600 dark:text-slate-300">{technical.orderBook.maxBidWall?.volume.toFixed(2)} {asset}</div>
                        </div>
                    </div>
                </div>

                {/* Major Asks Wall */}
                <div className="bg-rose-50/30 dark:bg-rose-500/5 rounded-2xl p-4 border border-rose-100/50 dark:border-rose-500/10">
                    <div className="text-[10px] font-bold text-rose-600 dark:text-rose-400 uppercase mb-3 flex justify-between">
                        <span>Principale Resistenza (Wall)</span>
                        <span>{technical.orderBook.askPressure.toFixed(1)}%</span>
                    </div>
                    <div className="flex justify-between items-end">
                        <div className="text-2xl font-mono font-bold text-rose-700 dark:text-rose-400">
                            ${technical.orderBook.maxAskWall?.price.toLocaleString()}
                        </div>
                        <div className="text-right">
                            <div className="text-[10px] text-slate-400 font-bold uppercase">Volume</div>
                            <div className="text-xs font-mono font-bold text-slate-600 dark:text-slate-300">{technical.orderBook.maxAskWall?.volume.toFixed(2)} {asset}</div>
                        </div>
                    </div>
                </div>
            </div>

            <div className="relative h-4 w-full bg-slate-100 dark:bg-slate-800 rounded-full overflow-hidden flex">
                <div 
                    style={{ width: `${technical.orderBook.bidPressure}%` }} 
                    className="h-full bg-emerald-500 transition-all duration-700"
                ></div>
                <div 
                    className="flex-1 bg-rose-500 transition-all duration-700"
                ></div>
                <div className="absolute left-1/2 top-0 bottom-0 w-1 bg-white dark:bg-black z-10 opacity-50 transform -translateX-1/2"></div>
            </div>
            <div className="flex justify-between mt-3 text-[10px] font-bold text-slate-400 uppercase tracking-widest">
                <span>Buyer Domination</span>
                <span>Seller Domination</span>
            </div>
        </div>
      )}


      {/* 7. ETH SPECIFIC (Conditional) */}
      {asset === 'ETH' && technical.ethSpecificData && (
          <div className="elegant-card p-5 bg-gradient-to-r from-blue-50 to-white dark:from-blue-900/10 dark:to-[#151E32]">
              <h4 className="text-xs font-bold text-blue-600 dark:text-blue-400 uppercase mb-4 flex items-center gap-2">
                  <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 17.93c-3.95-.49-7-3.85-7-7.93 0-.62.08-1.21.21-1.79L9 15v1c0 1.1.9 2 2 2v1.93zm6.9-2.54c-.26-.81-1-1.39-1.9-1.39h-1v-3c0-.55-.45-1-1-1H8v-2h2c.55 0 1-.45 1-1V7h2c1.1 0 2-.9 2-2v-.41c2.93 1.19 5 4.06 5 7.41 0 2.08-1.07 3.97-2.9 5.4z"/></svg>
                  Ecosystem Health
              </h4>
              <div className="grid grid-cols-3 gap-4 divide-x divide-slate-200 dark:divide-white/10">
                  <button onClick={() => setSelectedItem({ title: 'Gas Fees', signal: 'N/A', desc: getEthDataExplanation('Gas') })} className="text-center px-2 group">
                      <div className="text-[10px] font-medium text-slate-500 mb-1 uppercase">Gas (Gwei)</div>
                      <div className="text-lg font-bold text-slate-900 dark:text-white font-mono group-hover:text-blue-500 transition-colors">{technical.ethSpecificData.gasFees}</div>
                  </button>
                  <button onClick={() => setSelectedItem({ title: 'Staking APY', signal: 'Bullish', desc: getEthDataExplanation('Staking') })} className="text-center px-2 group">
                      <div className="text-[10px] font-medium text-slate-500 mb-1 uppercase">Staking APY</div>
                      <div className="text-lg font-bold text-emerald-600 dark:text-emerald-400 font-mono group-hover:text-emerald-500 transition-colors">{technical.ethSpecificData.stakingApy}%</div>
                  </button>
                  <button onClick={() => setSelectedItem({ title: 'ETH Burn', signal: 'Deflationary', desc: getEthDataExplanation('Burn') })} className="text-center px-2 group">
                      <div className="text-[10px] font-medium text-slate-500 mb-1 uppercase">Burn (24h)</div>
                      <div className="text-lg font-bold text-orange-600 dark:text-orange-400 font-mono group-hover:text-orange-500 transition-colors">🔥 {technical.ethSpecificData.ethBurned24h}</div>
                  </button>
              </div>
          </div>
      )}

    </div>
  );
};
