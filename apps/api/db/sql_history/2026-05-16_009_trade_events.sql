-- 2026-05-16 | Crea tabella trade_events per la cronologia eventi di ogni trade
-- Eseguito su: Supabase SQL Editor
-- Motivo: ottimizzazione #3 (Gestione Partial TP e Trailing SL — visibilità completa).
--         Registra ogni evento di gestione del trade (spostamento SL, breakeven, partial TP)
--         collegandolo all'ordine di apertura tramite trade_id → orders(id).
--         Usata da _emit_trade_event() in execution.py e dall'endpoint GET /trade-events.
--
-- NOTA: il primo tentativo usava references trades(id) — errato perché execution.py
--       non inserisce mai nella tabella trades. La FK corretta è orders(id).

drop table if exists trade_events;

create table trade_events (
  id        uuid primary key default gen_random_uuid(),
  trade_id  uuid references orders(id) on delete set null,
  kind      text not null,   -- sl_moved | be_sl | partial_tp | tp2_hit | sl_hit
  payload   jsonb,
  time      timestamptz default now()
);

create index on trade_events (trade_id, time);
