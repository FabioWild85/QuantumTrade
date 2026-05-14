-- 2026-05-14 | Aggiunge 'backtest' ai valori ammessi per bot_configs.mode
-- Eseguito su: Supabase SQL Editor
-- Motivo: la config backtest separata usa mode='backtest', ma il CHECK constraint
--         ammetteva solo 'paper' | 'live'. Soluzione: drop+recreate il constraint.

ALTER TABLE bot_configs
  DROP CONSTRAINT IF EXISTS bot_configs_mode_check;

ALTER TABLE bot_configs
  ADD CONSTRAINT bot_configs_mode_check
    CHECK (mode IN ('paper', 'live', 'backtest'));

-- Ora inserisce (o aggiorna) la config default backtest
INSERT INTO bot_configs (name, params, mode, status)
VALUES (
  'backtest',
  '{
    "sl_atr_mult": 2.0,
    "tp_atr_mult": 3.5,
    "position_size_pct": 1.5,
    "directional_threshold": 0.62,
    "adx_gate": 20.0,
    "confluence_gate": 0.0,
    "trailing_sl_enabled": false,
    "trailing_sl_activation": 1.0,
    "partial_tp_enabled": false,
    "partial_tp_atr_mult": 1.5,
    "partial_tp_pct": 50.0,
    "lgbm_exit_enabled": false,
    "lgbm_exit_threshold": 0.30,
    "lgbm_exit_min_hold_bars": 6,
    "lgbm_exit_confirm_bars": 2,
    "chronos_enabled": false,
    "chronos_weight": 0.40,
    "adx_gate_enabled": true,
    "sweep_gate_enabled": true,
    "fvg_filter_enabled": true,
    "mtf_alignment_enabled": true,
    "be_sl_enabled": false,
    "be_sl_activation": 1.0,
    "max_hold_bars_enabled": false,
    "max_hold_bars": 48
  }'::jsonb,
  'backtest',
  'ready'
)
ON CONFLICT (name) DO UPDATE
  SET params = EXCLUDED.params,
      mode   = EXCLUDED.mode,
      status = EXCLUDED.status;
