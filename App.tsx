import React, { useState, useCallback, useEffect } from 'react';
import { Header } from './components/Header';
import { MarketSummary } from './components/MarketSummary';
import { NewsSection } from './components/NewsSection';
import { TechnicalPanel } from './components/TechnicalPanel';
import { TradeSignals } from './components/TradeSignals';
import { OperationalChecklist } from './components/OperationalChecklist';
import { ForecastPanel } from './components/ForecastPanel';
import { TrendReversal } from './components/TrendReversal';
import { LoadingScreen } from './components/LoadingScreen';
import { MarketSynthesis } from './components/MarketSynthesis';
import { generateMarketAnalysis } from './services/geminiService';
import { getTechnicalData } from './services/cryptoDataService';
import { MarketReport } from './types';

const App: React.FC = () => {
  const [report, setReport] = useState<MarketReport | null>(null);
  const [loading, setLoading] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [loadingStep, setLoadingStep] = useState<string>('');
  const [analyzedAsset, setAnalyzedAsset] = useState<'BTC' | 'ETH' | 'SOL' | null>(null);
  const [isDarkMode, setIsDarkMode] = useState<boolean>(false);
  const [forceRefreshMode, setForceRefreshMode] = useState<boolean>(false);

  // Handle Dark Mode Toggle
  const toggleTheme = () => setIsDarkMode(!isDarkMode);

  const handleGenerateAnalysis = useCallback(async (symbol: 'BTC' | 'ETH' | 'SOL', forceRefresh: boolean = false) => {
    setLoading(true);
    setError(null);
    setAnalyzedAsset(symbol);
    
    window.scrollTo({ top: 0, behavior: 'smooth' });
    
    try {
      setLoadingStep(`Connessione ai nodi Binance per ${symbol}...`);
      // 1. Get Real Data first (Free & Fast)
      const realData = await getTechnicalData(symbol);
      
      setLoadingStep(`Analisi Macro & Sentiment per ${symbol} con AI...`);
      
      // 2. Pass real data to AI (Uses Cache if available unless forceRefresh is true)
      const data = await generateMarketAnalysis(symbol, realData, forceRefresh);
      
      setReport(data);
    } catch (err: any) {
      console.error(err);
      setError("Errore durante l'analisi. " + (err.message || "Riprova tra poco."));
    } finally {
      setLoading(false);
      setLoadingStep('');
    }
  }, []);

  const handleExport = async () => {
    if (!report) return;
    const element = document.getElementById('report-container');
    if (element) {
        try {
            const canvas = await (window as any).html2canvas(element, { 
                backgroundColor: isDarkMode ? '#151E32' : '#FFFFFF',
                scale: 2
            });
            const link = document.createElement('a');
            link.download = `QuantAI_Analysis_${analyzedAsset}_${new Date().toISOString().split('T')[0]}.png`;
            link.href = canvas.toDataURL();
            link.click();
        } catch (e) {
            console.error("Export failed", e);
        }
    }
  };

  const getHostname = (url: string) => {
    try {
      return new URL(url).hostname.replace('www.', '');
    } catch (e) {
      return 'Source';
    }
  };

  const resetState = () => {
    setReport(null);
    setAnalyzedAsset(null);
    setError(null);
    setLoading(false);
  }

  return (
    <div className={isDarkMode ? 'dark' : ''}>
      <div className="min-h-screen font-sans transition-colors duration-300 bg-[#F8FAFC] dark:bg-[#0B1120] text-slate-900 dark:text-slate-200 w-full overflow-x-hidden flex flex-col selection:bg-indigo-500/20">
        <Header isDarkMode={isDarkMode} toggleTheme={toggleTheme} />

        <main className="flex-grow container mx-auto px-4 md:px-6 py-10 max-w-[1400px] pb-32">
          
          {/* Hero / Empty State */}
          {!report && !loading && (
            <div className="flex flex-col items-center justify-center min-h-[75vh] text-center space-y-10 animate-fade-in px-4">
               <div className="w-full max-w-5xl mx-auto">
                  <div className="inline-block px-4 py-1.5 rounded-full bg-indigo-50 dark:bg-indigo-500/10 border border-indigo-100 dark:border-indigo-500/20 text-indigo-600 dark:text-indigo-400 text-xs font-bold uppercase tracking-widest mb-6">
                    Institutional Grade Analytics
                  </div>
                  <h2 className="text-4xl md:text-6xl font-bold text-slate-900 dark:text-white mb-6 tracking-tight leading-tight">
                    Quant Intelligence <br /> for <span className="text-indigo-600 dark:text-indigo-400">Crypto Assets</span>
                  </h2>
                  <p className="text-slate-500 dark:text-slate-400 text-lg mb-12 max-w-2xl mx-auto leading-relaxed">
                    Piattaforma avanzata di analisi quantitativa. 
                    Combina dati on-chain, struttura tecnica e sentiment macroeconomico in tempo reale.
                  </p>

                  <div className="grid grid-cols-1 md:grid-cols-3 gap-8 max-w-4xl mx-auto">
                    {/* Bitcoin Card */}
                    <div 
                      onClick={() => handleGenerateAnalysis('BTC', forceRefreshMode)}
                      className={`group cursor-pointer bg-white dark:bg-[#151E32] rounded-3xl p-8 shadow-elegant hover:shadow-elevation dark:shadow-none dark:hover:bg-[#1E293B] border transition-all duration-300 transform hover:-translate-y-1 ${
                        forceRefreshMode
                          ? 'border-amber-400 dark:border-amber-500/60 ring-2 ring-amber-400/30 dark:ring-amber-500/20'
                          : 'border-slate-200 dark:border-white/5'
                      } cursor-pointer`}
                    >
                        <div className="flex items-center justify-between mb-6">
                           <div className="p-4 bg-orange-50 dark:bg-orange-500/10 rounded-2xl group-hover:scale-110 transition-transform duration-300">
                             <img 
                               src="https://upload.wikimedia.org/wikipedia/commons/4/46/Bitcoin.svg" 
                               alt="Bitcoin" 
                               className="w-10 h-10"
                             />
                           </div>
                           <div className="h-8 w-8 rounded-full border border-slate-200 dark:border-white/10 flex items-center justify-center text-slate-400 group-hover:bg-orange-500 group-hover:text-white group-hover:border-orange-500 transition-colors">
                             <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" /></svg>
                           </div>
                        </div>
                        <h3 className="text-2xl font-bold text-slate-900 dark:text-white mb-2 text-left">Bitcoin</h3>
                        <p className="text-slate-500 dark:text-slate-400 text-sm text-left leading-relaxed">
                          Dominance, Order Flow e cicli di Halving.
                        </p>
                    </div>
                    
                    {/* Ethereum Card */}
                     <div 
                        onClick={() => handleGenerateAnalysis('ETH', forceRefreshMode)}
                        className={`group cursor-pointer bg-white dark:bg-[#151E32] rounded-3xl p-8 shadow-elegant hover:shadow-elevation dark:shadow-none dark:hover:bg-[#1E293B] border transition-all duration-300 transform hover:-translate-y-1 ${
                          forceRefreshMode
                            ? 'border-amber-400 dark:border-amber-500/60 ring-2 ring-amber-400/30 dark:ring-amber-500/20'
                            : 'border-slate-200 dark:border-white/5'
                        } cursor-pointer`}
                     >
                        <div className="flex items-center justify-between mb-6">
                           <div className="p-4 bg-blue-50 dark:bg-blue-500/10 rounded-2xl group-hover:scale-110 transition-transform duration-300">
                             <svg className="w-10 h-10 text-blue-600 dark:text-blue-400" viewBox="0 0 24 24" fill="currentColor">
                               <path d="M12 1.75l-6.13 9.25 6.13 3.42 6.13-3.42L12 1.75z m0 15.5l-6.13-3.42 6.13 9.42 6.13-9.42-6.13 3.42z"/>
                             </svg>
                           </div>
                           <div className="h-8 w-8 rounded-full border border-slate-200 dark:border-white/10 flex items-center justify-center text-slate-400 group-hover:bg-blue-500 group-hover:text-white group-hover:border-blue-500 transition-colors">
                             <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" /></svg>
                           </div>
                        </div>
                        <h3 className="text-2xl font-bold text-slate-900 dark:text-white mb-2 text-left">Ethereum</h3>
                        <p className="text-slate-500 dark:text-slate-400 text-sm text-left leading-relaxed">
                           Staking Metrics e correlazione DeFi.
                        </p>
                    </div>

                    {/* Solana Card */}
                    <div 
                        onClick={() => handleGenerateAnalysis('SOL', forceRefreshMode)}
                        className={`group cursor-pointer bg-white dark:bg-[#151E32] rounded-3xl p-8 shadow-elegant hover:shadow-elevation dark:shadow-none dark:hover:bg-[#1E293B] border transition-all duration-300 transform hover:-translate-y-1 ${
                          forceRefreshMode
                            ? 'border-amber-400 dark:border-amber-500/60 ring-2 ring-amber-400/30 dark:ring-amber-500/20'
                            : 'border-slate-200 dark:border-white/5'
                        } cursor-pointer`}
                     >
                        <div className="flex items-center justify-between mb-6">
                           {/* Official Solana Gradient Background */}
                           <div className="p-4 bg-gradient-to-br from-[#9945FF]/10 to-[#14F195]/10 rounded-2xl group-hover:scale-110 transition-transform duration-300">
                             {/* Official Solana Logo (PNG) */}
                             <img 
                                src="https://upload.wikimedia.org/wikipedia/en/b/b9/Solana_logo.png" 
                                alt="Solana" 
                                className="w-10 h-10 object-contain"
                             />
                           </div>
                           <div className="h-8 w-8 rounded-full border border-slate-200 dark:border-white/10 flex items-center justify-center text-slate-400 group-hover:bg-[#9945FF] group-hover:text-white group-hover:border-[#9945FF] transition-colors">
                             <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" /></svg>
                           </div>
                        </div>
                        <h3 className="text-2xl font-bold text-slate-900 dark:text-white mb-2 text-left">Solana</h3>
                        <p className="text-slate-500 dark:text-slate-400 text-sm text-left leading-relaxed">
                           High Throughput e Momentum Analysis.
                        </p>
                    </div>
                  </div>

                  {/* DEV: Force Refresh Toggle */}
                  <div className="mt-12 flex justify-center">
                    <button
                      onClick={() => setForceRefreshMode(prev => !prev)}
                      className={`group flex items-center gap-3 px-5 py-2.5 rounded-full border text-sm font-medium transition-all duration-300 ${
                        forceRefreshMode
                          ? 'bg-amber-50 dark:bg-amber-500/10 border-amber-300 dark:border-amber-500/40 text-amber-700 dark:text-amber-400 shadow-sm'
                          : 'bg-white dark:bg-white/5 border-slate-200 dark:border-white/10 text-slate-400 dark:text-slate-500 hover:border-slate-300 dark:hover:border-white/20 hover:text-slate-600 dark:hover:text-slate-400'
                      }`}
                    >
                      <span className={`relative inline-flex items-center w-9 h-5 rounded-full transition-colors duration-300 ${
                        forceRefreshMode ? 'bg-amber-400 dark:bg-amber-500' : 'bg-slate-200 dark:bg-slate-700'
                      }`}>
                        <span className={`absolute left-0.5 w-4 h-4 bg-white rounded-full shadow transition-transform duration-300 ${
                          forceRefreshMode ? 'translate-x-4' : 'translate-x-0'
                        }`} />
                      </span>
                      <svg className={`w-3.5 h-3.5 transition-transform duration-500 ${forceRefreshMode ? 'rotate-180' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                      </svg>
                      <span>
                        {forceRefreshMode ? (
                          <span>Fresh Scan <span className="font-bold text-amber-600 dark:text-amber-400">ATTIVO</span> — bypass cache</span>
                        ) : (
                          <span>Dev: abilita Fresh Scan</span>
                        )}
                      </span>
                    </button>
                  </div>
               </div>
            </div>
          )}

          {/* Loading Screen */}
          {loading && analyzedAsset && (
            <LoadingScreen asset={analyzedAsset} step={loadingStep} isDarkMode={isDarkMode} />
          )}

          {/* Error State */}
          {error && (
            <div className="max-w-lg mx-auto mt-20 p-8 bg-white dark:bg-[#151E32] rounded-2xl border border-red-100 dark:border-red-500/30 shadow-xl text-center animate-fade-in">
              <div className="w-16 h-16 bg-red-50 dark:bg-red-500/20 rounded-full flex items-center justify-center mx-auto mb-6 text-red-500 dark:text-red-400">
                <svg className="w-8 h-8" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                   <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
                </svg>
              </div>
              <h3 className="text-lg font-bold text-slate-900 dark:text-white mb-2">Analysis Failed</h3>
              <p className="text-slate-500 dark:text-slate-300 mb-8 leading-relaxed">{error}</p>
              <button 
                onClick={resetState}
                className="px-6 py-3 bg-slate-900 dark:bg-white text-white dark:text-slate-900 font-semibold rounded-xl hover:opacity-90 transition-opacity shadow-lg"
              >
                Torna alla Home
              </button>
            </div>
          )}

          {/* Dashboard Report */}
          {report && analyzedAsset && !loading && (
            <div className="space-y-8 animate-fade-in" id="report-container">
               {/* Dashboard Header */}
               <div className="flex flex-col lg:flex-row justify-between items-start lg:items-center gap-6 bg-white dark:bg-[#151E32] p-6 rounded-2xl shadow-sm border border-slate-200 dark:border-white/5">
                  <div className="w-full lg:w-auto">
                     <h2 className="text-2xl font-bold text-slate-900 dark:text-white flex items-center gap-3">
                        {analyzedAsset === 'BTC' && <img src="https://upload.wikimedia.org/wikipedia/commons/4/46/Bitcoin.svg" alt="BTC" className="w-8 h-8" />}
                        {analyzedAsset === 'ETH' && <svg className="w-8 h-8 text-blue-600 dark:text-blue-400" viewBox="0 0 24 24" fill="currentColor"><path d="M12 1.75l-6.13 9.25 6.13 3.42 6.13-3.42L12 1.75z m0 15.5l-6.13-3.42 6.13 9.42 6.13-9.42-6.13 3.42z"/></svg>}
                        {analyzedAsset === 'SOL' && (
                           <img 
                              src="https://upload.wikimedia.org/wikipedia/en/b/b9/Solana_logo.png" 
                              alt="Solana" 
                              className="w-8 h-8 object-contain"
                           />
                        )}
                        Executive Report
                     </h2>
                     <div className="flex items-center gap-2 text-sm text-slate-500 mt-2">
                        <span className="relative flex h-2.5 w-2.5">
                          <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>
                          <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-emerald-500"></span>
                        </span>
                        Updated: <span className="font-mono font-medium text-slate-700 dark:text-slate-300">{new Date(report.timestamp).toLocaleTimeString()}</span>
                     </div>
                  </div>
                  
                  {/* Actions - Responsive Layout for Mobile - FORCED GRID-COLS-1 on Mobile */}
                  <div className="w-full lg:w-auto mt-4 lg:mt-0">
                      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                          <button 
                            onClick={handleExport}
                            className="w-full px-5 py-2.5 bg-slate-100 dark:bg-slate-700 hover:bg-slate-200 dark:hover:bg-slate-600 text-slate-700 dark:text-slate-300 text-sm font-semibold rounded-xl transition-colors shadow-sm flex items-center justify-center gap-2"
                          >
                             <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" /></svg>
                             Condividi
                          </button>
                          <button 
                            onClick={resetState} 
                            className="w-full px-5 py-2.5 bg-white dark:bg-slate-800 hover:bg-slate-50 dark:hover:bg-slate-700 text-slate-700 dark:text-slate-300 text-sm font-semibold rounded-xl border border-slate-200 dark:border-slate-600 transition-colors shadow-sm text-center"
                          >
                             Home
                          </button>
                          <button 
                            onClick={() => handleGenerateAnalysis(analyzedAsset, true)} 
                            className="w-full px-5 py-2.5 bg-indigo-600 hover:bg-indigo-500 text-white text-sm font-semibold rounded-xl transition-colors shadow-lg shadow-indigo-500/20 flex items-center justify-center gap-2"
                          >
                             <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" /></svg>
                             Aggiorna
                          </button>
                      </div>
                  </div>
               </div>
              
              {/* Market Synthesis */}
              <MarketSynthesis report={report} />

              {/* Macro & Sentiment */}
              <MarketSummary 
                data={report.technical} 
                macroSentiment={report.macroSentiment} 
                macroOverview={report.macroOverview} 
              />
              
              {/* Reversal Scenarios */}
              {report.trendReversal && (
                <TrendReversal 
                  bullish={report.trendReversal.bullishScenario} 
                  bearish={report.trendReversal.bearishScenario} 
                />
              )}

              {/* Main Grid */}
              <div className="grid grid-cols-1 xl:grid-cols-3 gap-8">
                {/* Left Column */}
                <div className="xl:col-span-2 flex flex-col gap-8 min-w-0">
                  <TechnicalPanel technical={report.technical} asset={analyzedAsset} />
                  <TradeSignals signals={report.signals} />
                </div>
                
                {/* Right Column */}
                <div className="xl:col-span-1 flex flex-col gap-8 min-w-0">
                  <OperationalChecklist checklist={report.checklist} />
                  <NewsSection news={report.calendar} latestNews={report.latestNews} />
                </div>
              </div>

              {/* Forecast Bottom */}
              <ForecastPanel opinion={report.forecastOpinion} />

              {/* Footer */}
              {report.sources && report.sources.length > 0 && (
                 <div className="mt-16 pt-8 border-t border-slate-200 dark:border-white/5 text-center pb-6">
                    <p className="text-xs text-slate-400 mb-4 uppercase tracking-widest font-bold">Dati verificati da</p>
                    <div className="flex flex-wrap justify-center gap-3">
                       {report.sources.slice(0, 5).map((src, i) => (
                          <a key={i} href={src} target="_blank" rel="noreferrer" className="text-xs bg-white dark:bg-white/5 hover:bg-indigo-50 dark:hover:bg-white/10 px-4 py-2 rounded-full text-slate-500 dark:text-slate-400 transition-colors border border-slate-200 dark:border-white/10 hover:text-indigo-600 dark:hover:text-indigo-400 hover:border-indigo-200 truncate max-w-[200px]">
                             {getHostname(src)}
                          </a>
                       ))}
                    </div>
                 </div>
              )}
            </div>
          )}
        </main>
      </div>
    </div>
  );
};

export default App;