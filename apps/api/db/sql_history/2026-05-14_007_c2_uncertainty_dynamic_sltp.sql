-- 2026-05-14 | Aggiunge c2_uncertainty_gate e dynamic_sl_tp ai record bot_configs
-- Eseguito su: Supabase SQL Editor
-- Motivo: nuovi parametri aggiunti al BotConfig (Pydantic + execution.py).
--         La colonna params è jsonb: basta fare un merge senza toccare lo schema.
--         I valori di default rispecchiano quelli nei file Python (feature OFF per default).

UPDATE bot_configs
SET params = params || '{
    "c2_uncertainty_gate_enabled": false,
    "c2_uncertainty_threshold": 0.05,
    "dynamic_sl_tp_enabled": false,
    "dynamic_sl_tp_blend": 0.5
}'::jsonb
WHERE name = 'default';

UPDATE bot_configs
SET params = params || '{
    "c2_uncertainty_gate_enabled": false,
    "c2_uncertainty_threshold": 0.05,
    "dynamic_sl_tp_enabled": false,
    "dynamic_sl_tp_blend": 0.5
}'::jsonb
WHERE name = 'backtest';
