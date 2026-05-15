-- 2026-05-14 | Aggiunge colonna running a bot_configs per auto-resume dopo restart
-- Eseguito su: Supabase SQL Editor
-- Motivo: dopo un restart del VPS (deploy, crash, SIGKILL) il bot non si riavviava
--         automaticamente. Il campo running=true persiste lo stato "avviato" in DB
--         e viene letto al startup dalla lifespan in main.py per auto-riavviare.

ALTER TABLE bot_configs ADD COLUMN IF NOT EXISTS running BOOLEAN NOT NULL DEFAULT false;

-- Imposta lo stato corrente a false (sicurezza: non vogliamo auto-start inaspettati)
UPDATE bot_configs SET running = false WHERE name = 'default';
UPDATE bot_configs SET running = false WHERE name = 'backtest';
