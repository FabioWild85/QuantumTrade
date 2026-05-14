-- 2026-05-14 | Aggiornamento schema bot_configs per impostazioni avanzate
-- Eseguito su: Supabase SQL Editor
-- Motivo: supporto parametri avanzati (chronos_weight, be_sl, max_hold_bars, gate flags)
-- Nota: la colonna params è jsonb, quindi nessuna migrazione strutturale necessaria.
-- Il record default viene aggiornato per includere i nuovi campi con valori di default.

UPDATE bot_configs
SET params = params || '{
    "chronos_enabled": true,
    "chronos_weight": 0.40,
    "adx_gate_enabled": true,
    "sweep_gate_enabled": true,
    "fvg_filter_enabled": true,
    "mtf_alignment_enabled": true,
    "be_sl_enabled": false,
    "be_sl_activation": 1.0,
    "max_hold_bars_enabled": false,
    "max_hold_bars": 48
}'::jsonb
WHERE name = 'default';
