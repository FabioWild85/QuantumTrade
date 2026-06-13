-- Migration 015: Tabella ai_decisions per l'AI Decision Layer
--
-- Una riga per ogni ciclo 4H in cui l'AI Decision Layer viene invocato (inclusi
-- i no-trade e i fail-open). È la VALIDAZIONE FORWARD della feature: permette di
-- rispondere a "quante volte l'AI ha vetato? quei trade sarebbero stati perdenti?
-- l'AI sta aiutando o danneggiando?" — la feature NON è backtestabile.
--
-- Tutti i campi del verdetto sono nullable: su fail-open (errore/timeout) restano
-- NULL e `error` viene popolato.

CREATE TABLE IF NOT EXISTS ai_decisions (
    id                   BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
    bar_time             TIMESTAMPTZ,
    symbol               TEXT,
    provider             TEXT,
    model                TEXT,
    shadow_mode          BOOLEAN,
    -- input / contesto
    proposed_action      TEXT,           -- azione del modello (long/short/no_trade)
    dossier              JSONB,          -- snapshot dossier (audit + replay)
    -- output AI
    agreement            TEXT,           -- confirm / neutral / veto
    conviction           INTEGER,
    bias                 TEXT,           -- long / short / neutral
    threshold_adjustment DOUBLE PRECISION,
    flags                JSONB,
    invalidation_level   DOUBLE PRECISION,
    report_it            TEXT,
    latency_ms           INTEGER,
    error                TEXT,           -- 'fail_open' quando l'AI non ha risposto
    -- esito
    final_action         TEXT,           -- azione dopo l'AI Layer
    changed_decision     BOOLEAN         -- l'AI ha cambiato l'esito?
);

CREATE INDEX IF NOT EXISTS ai_decisions_created_at_idx
    ON ai_decisions (created_at DESC);
CREATE INDEX IF NOT EXISTS ai_decisions_agreement_idx
    ON ai_decisions (agreement);

COMMENT ON TABLE ai_decisions IS
    'AI Decision Layer — log di ogni giudizio LLM pre-trade. Validazione forward.';
