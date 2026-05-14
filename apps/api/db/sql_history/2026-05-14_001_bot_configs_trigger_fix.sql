-- 2026-05-14 | Fix trigger duplicato su bot_configs
-- Eseguito su: Supabase SQL Editor
-- Motivo: trigger "bot_configs_updated_at" già esistente causava errore 42710

DROP TRIGGER IF EXISTS bot_configs_updated_at ON bot_configs;

CREATE TRIGGER bot_configs_updated_at
    BEFORE UPDATE ON bot_configs
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();
