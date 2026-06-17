-- Salt & Flags — schema 0003: located inventory
-- The market_intents.kind CHECK from 0002 only allowed ('account','place','cancel').
-- It predated the flag/production ops (build/pledge/payout/seize/award/produce) and
-- already silently rejected them against real Postgres, and this slice adds the
-- located-inventory ops (grant/ship/load/unload/move). The authoritative engine
-- owns the set of valid kinds (replay() dispatches on it), so drop the DB-side
-- CHECK rather than chase it from two places. Payloads stay JSONB — no other DDL.

alter table market_intents drop constraint if exists market_intents_kind_check;
