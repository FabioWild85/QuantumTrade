-- Migration 012: Enrich trades table with entry/exit prices, partial PnL,
-- and expand reason_close constraint to include all engine exit reasons.

-- 1. Add missing columns
ALTER TABLE trades
  ADD COLUMN IF NOT EXISTS entry_price      DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS exit_price       DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS partial_pnl_usd  DOUBLE PRECISION DEFAULT 0,
  ADD COLUMN IF NOT EXISTS mode             TEXT DEFAULT 'paper';

-- 2. Drop old constraint and recreate with full set of close reasons
ALTER TABLE trades DROP CONSTRAINT IF EXISTS trades_reason_close_check;
ALTER TABLE trades ADD CONSTRAINT trades_reason_close_check
  CHECK (reason_close IN (
    'stop_loss', 'take_profit', 'manual', 'kill',
    'max_funding', 'lgbm_exit', 'max_hold_bars'
  ));
