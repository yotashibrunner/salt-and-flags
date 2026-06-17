-- Salt & Flags — schema 0001
-- All currency movement flows through `ledger` so total money supply is auditable.

create table if not exists players (
  id          text primary key,
  name        text unique not null,
  standing    int not null default 0,
  created_at  timestamptz not null default now()
);

create table if not exists characters (
  id          text primary key,
  player_id   text references players(id),
  appearance  jsonb not null default '{}',
  location    text,                 -- island id or 'at_sea'
  on_ship_id  text
);

create table if not exists crews (
  id      text primary key,
  name    text not null,
  flag_id text,
  coffers bigint not null default 0
);

create table if not exists flags (
  id       text primary key,
  name     text not null,
  royalty  jsonb not null default '{}'
);

create table if not exists islands (
  id                  text primary key,
  name                text not null,
  region              text not null,
  x                   int not null,
  y                   int not null,
  controlling_flag_id text references flags(id),
  tax_rate            numeric not null default 0
);

create table if not exists ships (
  id            text primary key,
  owner_crew_id text references crews(id),
  class         text not null,
  hull          int not null,
  sail          int not null,
  cargo_cap     int not null,
  fittings      jsonb not null default '{}',
  port_id       text references islands(id)
);

create table if not exists commodities (
  id   text primary key,
  name text not null,
  tier text not null
);

-- inventories: owner_type in (player, ship, stall, crew)
create table if not exists inventories (
  owner_type  text not null,
  owner_id    text not null,
  commodity_id text not null references commodities(id),
  qty         int not null default 0,
  primary key (owner_type, owner_id, commodity_id)
);

create table if not exists stalls (
  id        text primary key,
  island_id text references islands(id),
  owner_id  text references players(id),
  type      text not null,
  recipe_id text,
  prices    jsonb not null default '{}'
);

create table if not exists orders (
  id           bigserial primary key,
  island_id    text not null references islands(id),
  commodity_id text not null references commodities(id),
  side         text not null check (side in ('buy','sell')),
  price        int not null,
  qty          int not null,
  owner_id     text not null,
  status       text not null default 'open',
  created_at   timestamptz not null default now()
);
create index if not exists orders_book on orders (island_id, commodity_id, side, price);

-- immutable trade ledger (price history + anti-fraud)
create table if not exists trades (
  id           bigserial primary key,
  island_id    text not null,
  commodity_id text not null,
  price        int not null,
  qty          int not null,
  buyer_id     text not null,
  seller_id    text not null,
  ts           timestamptz not null default now()
);

create table if not exists blockades (
  id            text primary key,
  island_id     text references islands(id),
  scheduled_at  timestamptz not null,
  state         text not null default 'scheduled',
  control_meter numeric not null default 50
);

-- every piece-of-eight movement, ever
create table if not exists ledger (
  id         bigserial primary key,
  account_id text not null,
  delta      bigint not null,
  reason     text not null,
  ts         timestamptz not null default now()
);
