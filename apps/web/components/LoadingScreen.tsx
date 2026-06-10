import React, { useEffect, useState } from 'react';

interface Props {
  asset: 'BTC' | 'ETH' | 'SOL';
  step: string;
  isDarkMode: boolean;
}

export const LoadingScreen: React.FC<Props> = ({ asset, step }) => {
  const [progress, setProgress] = useState(0);
  const [logs, setLogs] = useState<string[]>([]);
  
  // Dynamic Colors based on Asset
  let bgClass = 'bg-orange-500';
  let borderClass = 'border-t-orange-500';

  if (asset === 'ETH') {
      bgClass = 'bg-blue-600';
      borderClass = 'border-t-blue-600';
  } else if (asset === 'SOL') {
      // Solana Official Gradient Colors (Purple #9945FF to Green #14F195)
      // Using the dominant Purple for text/border context
      bgClass = 'bg-[#9945FF]';
      borderClass = 'border-t-[#9945FF]';
  }
  
  useEffect(() => {
    const interval = setInterval(() => {
      setProgress((prev) => {
        const remaining = 100 - prev;
        let increment = 0;
        if (step.includes('Collegamento')) {
           increment = (remaining / 15) + (Math.random() * 0.5);
           if (prev > 40) increment = increment / 4; 
        } else {
           increment = (remaining / 80) + (Math.random() * 0.2);
        }
        const next = prev + increment;
        return next > 99.5 ? 99.5 : next;
      });
    }, 50);

    return () => clearInterval(interval);
  }, [step]);

  useEffect(() => {
    const sysLogs = [
      "Connection established...",
      "Fetching on-chain data...",
      "Aggregating order book...",
      "Calculating metrics...",
      "Macro synchronization...",
      "AI Analysis Engine...",
      "Finalizing report..."
    ];

    let logIdx = 0;
    const logInterval = setInterval(() => {
      if (logIdx < sysLogs.length) {
        setLogs(prev => [...prev.slice(-3), sysLogs[logIdx]]); 
        logIdx++;
      }
    }, 1000);

    return () => {
      clearInterval(logInterval);
    };
  }, [asset]);

  return (
    <div className="fixed inset-0 z-[100] bg-white dark:bg-[#0B1120] flex flex-col items-center justify-center overflow-hidden font-sans transition-colors duration-300">
      
      {/* Central Loader */}
      <div className="relative mb-16 animate-scale-in">
        {/* Outer Ring - Now Dynamic Color */}
        <div className={`w-32 h-32 rounded-full border-[3px] border-slate-100 dark:border-slate-800 ${borderClass} animate-spin`}></div>
        
        {/* Center Icon */}
        <div className="absolute inset-0 flex items-center justify-center">
          {asset === 'BTC' && <img src="https://upload.wikimedia.org/wikipedia/commons/4/46/Bitcoin.svg" alt="BTC" className="w-12 h-12 drop-shadow-lg" />}
          {asset === 'ETH' && <svg className="w-12 h-12 text-blue-600 dark:text-blue-400 drop-shadow-lg" viewBox="0 0 24 24" fill="currentColor"><path d="M12 1.75l-6.13 9.25 6.13 3.42 6.13-3.42L12 1.75z m0 15.5l-6.13-3.42 6.13 9.42 6.13-9.42-6.13 3.42z"/></svg>}
          {asset === 'SOL' && (
             // Official Solana Logo PNG
             <img 
                src="https://upload.wikimedia.org/wikipedia/en/b/b9/Solana_logo.png" 
                alt="Solana" 
                className="w-12 h-12 object-contain"
             />
          )}
        </div>
      </div>

      {/* Text & Status */}
      <div className="z-10 text-center space-y-8 max-w-md w-full px-8">
        <div>
          <h2 className="text-2xl font-bold text-slate-900 dark:text-white tracking-tight mb-2">Analysis in Progress</h2>
          <p className="text-sm text-slate-500 dark:text-slate-400 font-medium">{step}</p>
        </div>

        {/* Progress Bar */}
        <div className="w-full bg-slate-100 dark:bg-slate-800 h-1.5 rounded-full overflow-hidden">
           <div 
             className={`h-full ${bgClass} transition-all duration-100 ease-linear rounded-full shadow-[0_0_10px_rgba(153,69,255,0.4)]`}
             style={{ width: `${progress}%` }}
           ></div>
        </div>
        
        <div className="h-16 flex flex-col items-center justify-end">
           {logs.map((log, i) => (
             <p key={i} className="text-xs font-mono text-slate-400 dark:text-slate-500 animate-fade-in my-0.5">
               {log}
             </p>
           ))}
        </div>
      </div>
    </div>
  );
};