-- 2026-05-18 | Crea tabella config_presets per il sistema di preset backtest personalizzati
-- Eseguito su: Supabase SQL Editor
-- Motivo: nuova funzionalità Preset Backtest in BacktestPanel.tsx.
--         Sostituisce i setup predefiniti per regime (REGIME_SETUPS) con preset
--         personalizzati creati dall'utente. Ogni preset salva l'intera configurazione
--         di parametri backtest (sl_atr_mult, tp_atr_mult, exit strategies, filtri segnale,
--         ecc.) e può essere caricato in un click per ripristinare tutte le impostazioni.
--         Gestito dagli endpoint GET/POST/PUT/DELETE /presets in main.py.

CREATE TABLE IF NOT EXISTS config_presets (
    id         BIGSERIAL PRIMARY KEY,
    name       TEXT NOT NULL,
    params     JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
