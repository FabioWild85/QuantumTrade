-- Migration 013: Add top-level probability columns to inference_logs for
-- isotonic calibration, and link trades back to the inference that triggered them.
--
-- inference_logs.c2_dir_prob      — Chronos-2 raw directional probability (pre-calibration)
-- inference_logs.c2_dir_prob_raw  — original value preserved when calibration is applied
-- inference_logs.c2_uncertainty   — Chronos-2 uncertainty (p90-p10)/price (top-level copy for fast queries)
-- inference_logs.c2_cont_prob     — Chronos-2 continuation probability (top-level copy)
-- trades.inference_id             — FK back to inference_logs so the calibrator
--                                   can join c2_dir_prob to trade outcomes (pnl_usd)

ALTER TABLE inference_logs
  ADD COLUMN IF NOT EXISTS c2_dir_prob     DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS c2_dir_prob_raw DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS c2_uncertainty  DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS c2_cont_prob    DOUBLE PRECISION;

ALTER TABLE trades
  ADD COLUMN IF NOT EXISTS inference_id TEXT REFERENCES inference_logs(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS inference_logs_c2_dir_prob ON inference_logs (c2_dir_prob)
  WHERE c2_dir_prob IS NOT NULL;

CREATE INDEX IF NOT EXISTS trades_inference_id ON trades (inference_id)
  WHERE inference_id IS NOT NULL;
