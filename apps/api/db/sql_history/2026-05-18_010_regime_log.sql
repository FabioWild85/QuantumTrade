-- 2026-05-18 | Crea tabella regime_log per la persistenza degli snapshot di regime
-- Eseguito su: Supabase SQL Editor
-- Motivo: nuova funzionalità Regime Detection (regime_detector.py + regime_profiles.py).
--         Registra ogni snapshot di rilevamento del regime con tutti i valori diagnostici.
--         Usata da _log_regime() in execution.py e dagli endpoint GET /regime/current
--         e GET /regime/history in main.py.
--         La colonna profile_applied registra quale profilo Setup A è stato applicato
--         quando regime_adaptive_enabled = true.

CREATE TABLE IF NOT EXISTS regime_log (
    id              BIGSERIAL PRIMARY KEY,
    detected_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    regime          TEXT NOT NULL,
    confidence      FLOAT,
    adx             FLOAT,
    atr_pct         FLOAT,
    slope_pct       FLOAT,
    bars_in_regime  INT,
    transition_risk FLOAT,
    profile_applied TEXT
);

CREATE INDEX IF NOT EXISTS idx_regime_log_detected_at ON regime_log (detected_at DESC);

-- Aggiunge il flag regime_adaptive_enabled ai parametri bot_configs
-- (sia la config "default" usata in live che quella "backtest")
UPDATE bot_configs
SET params = params || '{"regime_adaptive_enabled": false}'::jsonb
WHERE name = 'default';

UPDATE bot_configs
SET params = params || '{"regime_adaptive_enabled": false}'::jsonb
WHERE name = 'backtest';
