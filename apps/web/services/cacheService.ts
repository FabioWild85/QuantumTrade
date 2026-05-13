
import { MarketReport } from '../types';

const CACHE_PREFIX = 'quant_ai_cache_v1_';
const CACHE_DURATION_MS = 60 * 60 * 1000; // 60 Minuti di durata cache

interface CachedData {
  timestamp: number;
  report: MarketReport;
}

export const cacheService = {
  /**
   * Salva un report in cache con il timestamp attuale
   */
  saveReport: (asset: 'BTC' | 'ETH' | 'SOL', report: MarketReport) => {
    try {
      const data: CachedData = {
        timestamp: Date.now(),
        report: report
      };
      localStorage.setItem(`${CACHE_PREFIX}${asset}`, JSON.stringify(data));
      console.log(`[Cache] Report saved for ${asset}`);
    } catch (e) {
      console.warn('[Cache] Failed to save report', e);
    }
  },

  /**
   * Recupera un report dalla cache se è ancora valido (non scaduto)
   */
  getValidReport: (asset: 'BTC' | 'ETH' | 'SOL'): MarketReport | null => {
    try {
      const raw = localStorage.getItem(`${CACHE_PREFIX}${asset}`);
      if (!raw) return null;

      const data: CachedData = JSON.parse(raw);
      const now = Date.now();
      const age = now - data.timestamp;

      // Se il report è più vecchio della durata massima, è invalido
      if (age > CACHE_DURATION_MS) {
        console.log(`[Cache] Report for ${asset} is expired (${(age / 60000).toFixed(1)} mins old)`);
        return null;
      }

      console.log(`[Cache] Hit for ${asset}. Report is ${(age / 60000).toFixed(1)} mins old.`);
      return data.report;
    } catch (e) {
      console.warn('[Cache] Failed to retrieve report', e);
      return null;
    }
  },

  /**
   * Pulisce la cache (utile per debug o reset forzato)
   */
  clearCache: () => {
    Object.keys(localStorage).forEach(key => {
      if (key.startsWith(CACHE_PREFIX)) {
        localStorage.removeItem(key);
      }
    });
  }
};
