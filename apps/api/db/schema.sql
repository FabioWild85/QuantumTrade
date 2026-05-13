-- AI Trading Hub — Database Schema
-- Apply to Supabase via: Dashboard > SQL Editor > Run
-- Or locally via: psql $DATABASE_URL < apps/api/db/schema.sql

-- ────────────────────────────────────────────────────────────────────────────
-- EXTENSIONS
-- ────────────────────────────────────────────────────────────────────────────

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
-- Uncomment in Supabase if TimescaleDB community is available:
-- CREATE EXTENSION IF NOT EXISTS timescaledb;


-- ────────────────────────────────────────────────────────────────────────────
-- BOT CONFIG (single row in MVP — one bot)
-- ────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS bot_configs (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name            TEXT NOT NULL DEFAULT 'default',
    params          JSONB NOT NULL DEFAULT '{}',
    mode            TEXT NOT NULL DEFAULT 'paper' CHECK (mode IN ('paper', 'live')),
    status          TEXT NOT NULL DEFAULT 'idle',
    last_heartbeat  TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT one_default_bot UNIQUE (name)
);

INSERT INTO bot_configs (name, params, mode, status)
VALUES ('default', '{
    "sl_atr_mult": 2.0,
    "tp_atr_mult": 3.5,
    "position_size_pct": 1.5,
    "max_daily_dd_pct": 3.0,
    "directional_threshold": 0.62,
    "adx_gate": 20.0,
    "confluence_gate": 60.0,
    "max_consecutive_losses": 4,
    "mode": "paper"
}', 'paper', 'idle')
ON CONFLICT (name) DO NOTHING;


-- ────────────────────────────────────────────────────────────────────────────
-- AGENT WALLETS
-- ────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS agent_wallets (
    id               UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    address          TEXT NOT NULL UNIQUE,
    encrypted_privkey TEXT NOT NULL,
    permissions      JSONB NOT NULL DEFAULT '{"trading": true, "withdraw": false}',
    main_address     TEXT,
    name             TEXT,
    network          TEXT NOT NULL DEFAULT 'testnet' CHECK (network IN ('testnet', 'mainnet')),
    created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    revoked_at       TIMESTAMPTZ
);


-- ────────────────────────────────────────────────────────────────────────────
-- OHLCV TIME SERIES
-- ────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS ohlcv (
    time    TIMESTAMPTZ NOT NULL,
    symbol  TEXT NOT NULL,
    tf      TEXT NOT NULL,   -- '1h', '4h', '1d'
    o       DOUBLE PRECISION NOT NULL,
    h       DOUBLE PRECISION NOT NULL,
    l       DOUBLE PRECISION NOT NULL,
    c       DOUBLE PRECISION NOT NULL,
    v       DOUBLE PRECISION NOT NULL,
    PRIMARY KEY (time, symbol, tf)
);

CREATE INDEX IF NOT EXISTS ohlcv_time_desc ON ohlcv (time DESC);
-- SELECT create_hypertable('ohlcv', 'time', if_not_exists => TRUE);  -- TimescaleDB


-- ────────────────────────────────────────────────────────────────────────────
-- COVARIATES (flexible key-value time series)
-- Includes: confluence_score, rsi_divergence, ema_signal from QT frontend
-- ────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS covariates (
    time    TIMESTAMPTZ NOT NULL,
    symbol  TEXT NOT NULL DEFAULT 'BTC',
    source  TEXT NOT NULL,   -- 'quantum_trade', 'hyperliquid', 'coinalyze'
    key     TEXT NOT NULL,   -- 'confluence_score', 'funding', 'oi', ...
    value   DOUBLE PRECISION NOT NULL,
    PRIMARY KEY (time, symbol, source, key)
);

CREATE INDEX IF NOT EXISTS covariates_key_time ON covariates (key, time DESC);


-- ────────────────────────────────────────────────────────────────────────────
-- INFERENCE LOGS (full audit trail per cycle)
-- ────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS inference_logs (
    id          TEXT PRIMARY KEY,    -- short UUID prefix (12 chars)
    time        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    bot_id      UUID REFERENCES bot_configs(id) ON DELETE SET NULL,
    model       TEXT NOT NULL DEFAULT 'chronos2_lgbm_ensemble_v1',
    features    JSONB NOT NULL DEFAULT '{}',   -- full 64-feature snapshot
    forecast    JSONB NOT NULL DEFAULT '{}',   -- Chronos-2 output + LightGBM prob
    decision    TEXT NOT NULL CHECK (decision IN ('long', 'short', 'no_trade')),
    reasoning   JSONB NOT NULL DEFAULT '[]',   -- list of reasoning steps
    latency_ms  DOUBLE PRECISION
);

CREATE INDEX IF NOT EXISTS inference_logs_time ON inference_logs (time DESC);


-- ────────────────────────────────────────────────────────────────────────────
-- ORDERS
-- ────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS orders (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    bot_id          TEXT NOT NULL DEFAULT 'default',
    hl_order_id     TEXT,
    symbol          TEXT NOT NULL DEFAULT 'BTC',
    side            TEXT NOT NULL CHECK (side IN ('long', 'short')),
    size            DOUBLE PRECISION NOT NULL,
    price           DOUBLE PRECISION,
    status          TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'filled', 'cancelled', 'rejected')),
    filled_size     DOUBLE PRECISION DEFAULT 0,
    avg_fill_price  DOUBLE PRECISION,
    fees_usd        DOUBLE PRECISION DEFAULT 0,
    slippage_bps    DOUBLE PRECISION DEFAULT 0,
    inference_id    TEXT REFERENCES inference_logs(id) ON DELETE SET NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    filled_at       TIMESTAMPTZ
);


-- ────────────────────────────────────────────────────────────────────────────
-- TRADES (entry + exit pair)
-- ────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS trades (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    bot_id          TEXT NOT NULL DEFAULT 'default',
    entry_order_id  UUID REFERENCES orders(id),
    exit_order_id   UUID REFERENCES orders(id),
    symbol          TEXT NOT NULL DEFAULT 'BTC',
    side            TEXT NOT NULL CHECK (side IN ('long', 'short')),
    pnl_usd         DOUBLE PRECISION,
    pnl_pct         DOUBLE PRECISION,
    holding_sec     INTEGER,
    reason_open     TEXT,
    reason_close    TEXT CHECK (reason_close IN ('stop_loss', 'take_profit', 'manual', 'kill', 'max_funding')),
    opened_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    closed_at       TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS trades_opened ON trades (opened_at DESC);


-- ────────────────────────────────────────────────────────────────────────────
-- EQUITY SNAPSHOTS (real-time chart data)
-- ────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS equity_snapshots (
    time            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    bot_id          TEXT NOT NULL DEFAULT 'default',
    equity_usd      DOUBLE PRECISION NOT NULL,
    unrealized_pnl  DOUBLE PRECISION DEFAULT 0,
    realized_pnl    DOUBLE PRECISION DEFAULT 0,
    drawdown_pct    DOUBLE PRECISION DEFAULT 0,
    PRIMARY KEY (time, bot_id)
);

CREATE INDEX IF NOT EXISTS equity_snapshots_time ON equity_snapshots (time DESC);


-- ────────────────────────────────────────────────────────────────────────────
-- EVENTS (alerts, errors, system events)
-- ────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS events (
    id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    time        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    severity    TEXT NOT NULL DEFAULT 'info' CHECK (severity IN ('info', 'warning', 'error', 'critical')),
    kind        TEXT NOT NULL,   -- 'trade_opened', 'kill', 'heartbeat_missing', 'error', ...
    message     TEXT NOT NULL,
    payload     JSONB DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS events_time ON events (time DESC);


-- ────────────────────────────────────────────────────────────────────────────
-- SUPABASE REALTIME
-- Enable on: equity_snapshots, orders, inference_logs, events
-- Run in Supabase Dashboard > Realtime > Tables > Enable Realtime
-- ────────────────────────────────────────────────────────────────────────────


-- ────────────────────────────────────────────────────────────────────────────
-- UPDATED_AT TRIGGER
-- ────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE TRIGGER bot_configs_updated_at
    BEFORE UPDATE ON bot_configs
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();
