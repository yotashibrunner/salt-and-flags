-- Salt & Flags — schema 0002
-- Append-only market intent log. This is the crash-safe source of truth the
-- server REPLAYS on boot to rebuild every island's books + balances (same engine
-- code path => identical state). `trades` and `ledger` from 0001 remain the audit
-- projection (price history + money movement). Nothing here is ever updated in
-- place — only appended — so a partial write can never corrupt prior state.

create table if not exists market_intents (
  id      bigserial primary key,
  seq     bigint not null,            -- global op order (assigned in-memory at op time)
  kind    text   not null check (kind in ('account','place','cancel')),
  payload jsonb  not null,            -- the intent args (owner/island/commodity/side/price/qty/ref/poe/inv)
  ts      timestamptz not null default now()
);
create index if not exists market_intents_seq on market_intents (seq);
