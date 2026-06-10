-- Migration 014: Tabella utenti per autenticazione JWT single-user
--
-- Crea la tabella users con username, password_hash (bcrypt) e flag is_active.
-- Non è prevista registrazione: l'unico account viene creato manualmente
-- tramite lo script apps/api/create_user.py.

CREATE TABLE IF NOT EXISTS users (
    id           UUID        NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
    username     TEXT        NOT NULL UNIQUE,
    password_hash TEXT       NOT NULL,
    is_active    BOOLEAN     NOT NULL DEFAULT TRUE,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Impedisce la creazione di più di un utente attivo (sistema single-user)
CREATE UNIQUE INDEX IF NOT EXISTS users_single_active
    ON users (is_active)
    WHERE is_active = TRUE;

COMMENT ON TABLE users IS 'Single-user auth — un solo account attivo per volta.';
