-- 2026-05-14 | Tabella storico backtest
-- Eseguito su: Supabase SQL Editor
-- Motivo: persistenza risultati backtest con recupero, visualizzazione e cancellazione

CREATE TABLE IF NOT EXISTS backtest_results (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    created_at      timestamptz DEFAULT now(),
    name            text,                          -- nome opzionale assegnato dall'utente
    symbol          text NOT NULL DEFAULT 'BTC',
    from_date       date NOT NULL,
    to_date         date NOT NULL,
    initial_capital float NOT NULL DEFAULT 10000,
    duration_days   int,
    config          jsonb,                         -- snapshot BotConfig usato
    summary         jsonb,                         -- metriche chiave (win_rate, sharpe, pnl...)
    results         jsonb                          -- payload completo del backtest
);

-- Indice per ordinamento cronologico
CREATE INDEX IF NOT EXISTS backtest_results_created_at_idx
    ON backtest_results (created_at DESC);

-- RLS disabilitato (single-user, service_role key)
ALTER TABLE backtest_results DISABLE ROW LEVEL SECURITY;
