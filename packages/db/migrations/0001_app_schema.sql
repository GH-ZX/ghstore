-- GH Store core schema.
--
-- Everything lives in the private `app` schema. It is NOT exposed through the
-- Supabase Data API: anon/authenticated have no access at all. The Workers talk
-- to Postgres directly (Cloudflare Hyperdrive) as the `store_server` role.
--
-- Money is integer US cents (bigint). Wallet balances change only through the
-- SECURITY DEFINER functions at the bottom, each of which writes a ledger row in
-- the same transaction. The ledger has one unique row per (kind, ref) so every
-- credit, charge and refund happens exactly once.

create schema if not exists app;
revoke all on schema app from public;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on schema app from anon, authenticated';
  end if;
  if not exists (select 1 from pg_roles where rolname = 'store_server') then
    create role store_server nologin;
  end if;
end $$;
grant usage on schema app to store_server;

-- Time-ordered UUIDs (v7): unique like v4, but they index like a sequence.
create or replace function app.uuid_v7() returns uuid
language sql volatile parallel safe
set search_path = pg_catalog
as $$
  select encode(
    set_bit(set_bit(
      overlay(uuid_send(gen_random_uuid())
        placing substring(int8send((extract(epoch from clock_timestamp()) * 1000)::bigint) from 3)
        from 1 for 6),
      52, 1), 53, 1),
    'hex')::uuid
$$;

create or replace function app.touch_updated_at() returns trigger
language plpgsql set search_path = pg_catalog
as $$ begin new.updated_at := now(); return new; end $$;

-- ───────────────────────────────────────────────────────────── people

create table app.users (
  id uuid primary key default app.uuid_v7(),
  display_name text not null default '' check (length(display_name) <= 120),
  locale text not null default 'ar' check (locale in ('ar', 'en')),
  role text not null default 'customer' check (role in ('customer', 'support', 'owner')),
  status text not null default 'active' check (status in ('active', 'banned')),
  notify boolean not null default true,
  sessions_revoked_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  last_seen_at timestamptz
);
create trigger users_touch before update on app.users for each row execute function app.touch_updated_at();

-- One person can sign in with Telegram and/or a website account (Supabase Auth).
create table app.identities (
  id bigint generated always as identity primary key,
  user_id uuid not null references app.users (id) on delete cascade,
  provider text not null check (provider in ('telegram', 'supabase')),
  subject text not null check (length(subject) between 1 and 64),
  username text,
  email text,
  created_at timestamptz not null default now(),
  unique (provider, subject)
);
create index identities_user_idx on app.identities (user_id);

create table app.sessions (
  id uuid primary key default app.uuid_v7(),
  user_id uuid not null references app.users (id) on delete cascade,
  channel text not null check (channel in ('web', 'miniapp', 'admin')),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  revoked_at timestamptz,
  user_agent text
);
create index sessions_user_idx on app.sessions (user_id);

-- ───────────────────────────────────────────────────────────── catalog

create table app.categories (
  id uuid primary key default app.uuid_v7(),
  slug text not null unique check (slug ~ '^[a-z0-9-]{1,48}$'),
  name_ar text not null check (length(name_ar) between 1 and 40),
  name_en text not null check (length(name_en) between 1 and 40),
  sort int not null default 0,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create trigger categories_touch before update on app.categories for each row execute function app.touch_updated_at();

create table app.suppliers (
  id text primary key check (id ~ '^[a-z0-9_]{2,32}$'),
  name text not null,
  enabled boolean not null default false,
  -- Optional encrypted JSON with API keys; keys may instead live in Worker secrets.
  config_enc text,
  balance_cents bigint,
  balance_checked_at timestamptz,
  low_balance_cents bigint not null default 0 check (low_balance_cents >= 0),
  health text not null default 'unknown' check (health in ('unknown', 'ok', 'degraded', 'down')),
  last_sync_at timestamptz,
  last_error text,
  updated_at timestamptz not null default now()
);
create trigger suppliers_touch before update on app.suppliers for each row execute function app.touch_updated_at();

create table app.products (
  id uuid primary key default app.uuid_v7(),
  slug text not null unique check (slug ~ '^[a-z0-9-]{1,80}$'),
  category_id uuid not null references app.categories (id) on delete restrict,
  name_ar text not null check (length(name_ar) between 1 and 120),
  name_en text not null check (length(name_en) between 1 and 120),
  description_ar text not null default '',
  description_en text not null default '',
  instructions_ar text not null default '',
  instructions_en text not null default '',
  warranty_ar text not null default '',
  warranty_en text not null default '',
  -- Extra words people search with ("ببجي", "pubg", "uc"); normalised by the app.
  search_terms text not null default '',
  image_url text,
  kind text not null check (kind in ('id', 'code', 'account', 'link', 'sms')),
  active boolean not null default false,
  featured boolean not null default false,
  sort int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index products_category_idx on app.products (category_id);
create trigger products_touch before update on app.products for each row execute function app.touch_updated_at();

-- A sellable package of a product. Each offer comes from exactly one supplier
-- (or from manual stock when supplier_id is null). The same item from two
-- suppliers is two offers/products, named by the owner ("Server 1", "Server 2").
create table app.offers (
  id uuid primary key default app.uuid_v7(),
  product_id uuid not null references app.products (id) on delete cascade,
  name_ar text not null check (length(name_ar) between 1 and 120),
  name_en text not null check (length(name_en) between 1 and 120),
  sort int not null default 0,
  supplier_id text references app.suppliers (id) on update cascade on delete restrict,
  supplier_ref text,
  cost_cents bigint check (cost_cents >= 0),
  price_cents bigint not null check (price_cents > 0),
  markup_mode text not null default 'percent' check (markup_mode in ('percent', 'fixed', 'manual')),
  markup_value numeric(10, 2) not null default 15,
  round_to_cents int not null default 1 check (round_to_cents between 1 and 10000),
  min_margin_pct numeric(5, 2) not null default 5 check (min_margin_pct >= 0),
  input_fields jsonb not null default '[]' check (jsonb_typeof(input_fields) = 'array'),
  max_quantity int not null default 1 check (max_quantity between 1 and 100),
  active boolean not null default true,
  -- Set by the system when the offer must not be sold (margin lost, supplier down...).
  paused_reason text,
  cost_checked_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (supplier_id, supplier_ref),
  check ((supplier_id is null) = (supplier_ref is null))
);
create index offers_product_idx on app.offers (product_id);
create trigger offers_touch before update on app.offers for each row execute function app.touch_updated_at();

create table app.price_changes (
  id bigint generated always as identity primary key,
  offer_id uuid not null references app.offers (id) on delete cascade,
  old_cost_cents bigint,
  new_cost_cents bigint,
  old_price_cents bigint,
  new_price_cents bigint,
  action text not null check (action in ('repriced', 'paused', 'kept', 'manual')),
  at timestamptz not null default now()
);
create index price_changes_offer_idx on app.price_changes (offer_id, at desc);

-- Codes/accounts the owner uploads by hand. payload_enc is AES-GCM encrypted.
create table app.stock_items (
  id bigint generated always as identity primary key,
  offer_id uuid not null references app.offers (id) on delete cascade,
  payload_enc text not null,
  status text not null default 'available' check (status in ('available', 'sold', 'void')),
  order_id uuid,
  created_at timestamptz not null default now(),
  sold_at timestamptz
);
create index stock_items_available_idx on app.stock_items (offer_id, id) where status = 'available';
create index stock_items_order_idx on app.stock_items (order_id) where order_id is not null;

-- ───────────────────────────────────────────────────────────── money

create table app.wallets (
  user_id uuid primary key references app.users (id) on delete restrict,
  balance_cents bigint not null default 0 check (balance_cents >= 0),
  updated_at timestamptz not null default now()
);

create table app.ledger (
  id bigint generated always as identity primary key,
  user_id uuid not null references app.users (id) on delete restrict,
  amount_cents bigint not null check (amount_cents <> 0),
  kind text not null check (kind in ('topup', 'purchase', 'refund', 'adjustment')),
  ref_type text not null check (ref_type in ('payment', 'order', 'admin')),
  ref_id uuid not null,
  balance_after_cents bigint not null check (balance_after_cents >= 0),
  note text,
  actor_user_id uuid references app.users (id),
  created_at timestamptz not null default now(),
  unique (kind, ref_type, ref_id)
);
create index ledger_user_idx on app.ledger (user_id, id desc);

create table app.payments (
  id uuid primary key default app.uuid_v7(),
  user_id uuid not null references app.users (id) on delete restrict,
  method text not null check (method in ('sam', 'nowpayments', 'bep20', 'stars', 'manual')),
  amount_cents bigint not null check (amount_cents > 0),
  status text not null default 'created'
    check (status in ('created', 'pending', 'review', 'paid', 'partial', 'failed', 'expired', 'rejected')),
  provider_ref text,
  -- On-chain transaction hash (lower case). Globally unique: a transfer can be used once.
  tx_hash text unique check (tx_hash is null or tx_hash ~ '^0x[0-9a-f]{64}$'),
  credited_cents bigint check (credited_cents is null or credited_cents > 0),
  action jsonb,
  note text,
  channel text not null default 'web' check (channel in ('web', 'miniapp', 'bot', 'admin')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  paid_at timestamptz,
  reviewed_by uuid references app.users (id),
  unique (method, provider_ref)
);
create index payments_user_idx on app.payments (user_id, created_at desc);
create index payments_open_idx on app.payments (status, created_at) where status in ('created', 'pending', 'review');
-- Manual USDT: every open request has its own exact amount (e.g. 10.37), so a public
-- transaction hash only ever matches the request it was sent for.
create unique index payments_bep20_open_amount_idx on app.payments (amount_cents)
  where method = 'bep20' and status in ('created', 'pending', 'review');
create trigger payments_touch before update on app.payments for each row execute function app.touch_updated_at();

-- ───────────────────────────────────────────────────────────── orders

create sequence app.order_number_seq start 1001;

create table app.orders (
  id uuid primary key default app.uuid_v7(),
  number bigint not null unique default nextval('app.order_number_seq'),
  user_id uuid not null references app.users (id) on delete restrict,
  offer_id uuid not null references app.offers (id) on delete restrict,
  product_id uuid not null references app.products (id) on delete restrict,
  quantity int not null check (quantity between 1 and 100),
  unit_price_cents bigint not null check (unit_price_cents > 0),
  total_cents bigint not null,
  cost_cents bigint,
  status text not null check (status in ('paid', 'processing', 'delivered', 'failed', 'refunded')),
  channel text not null check (channel in ('web', 'miniapp', 'bot', 'admin')),
  input jsonb not null default '{}' check (jsonb_typeof(input) = 'object'),
  supplier_id text references app.suppliers (id) on update cascade,
  supplier_order_id text,
  idempotency_key text not null check (length(idempotency_key) between 8 and 100),
  attempts int not null default 0,
  next_check_at timestamptz,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  delivered_at timestamptz,
  unique (user_id, idempotency_key),
  check (total_cents = unit_price_cents * quantity)
);
create index orders_user_idx on app.orders (user_id, created_at desc);
create index orders_due_idx on app.orders (next_check_at) where status in ('paid', 'processing');
create index orders_offer_idx on app.orders (offer_id);
create index orders_product_idx on app.orders (product_id);
create index orders_supplier_ref_idx on app.orders (supplier_id, supplier_order_id) where supplier_order_id is not null;
create trigger orders_touch before update on app.orders for each row execute function app.touch_updated_at();

alter table app.stock_items
  add constraint stock_items_order_fk foreign key (order_id) references app.orders (id) on delete set null;

-- What the customer received. value_enc is AES-GCM encrypted by the app.
create table app.deliveries (
  id bigint generated always as identity primary key,
  order_id uuid not null references app.orders (id) on delete cascade,
  kind text not null check (kind in ('id', 'code', 'account', 'link', 'sms', 'phone')),
  value_enc text not null,
  label text,
  created_at timestamptz not null default now(),
  first_viewed_at timestamptz
);
create index deliveries_order_idx on app.deliveries (order_id);

create table app.order_events (
  id bigint generated always as identity primary key,
  order_id uuid not null references app.orders (id) on delete cascade,
  type text not null,
  data jsonb not null default '{}',
  at timestamptz not null default now()
);
create index order_events_order_idx on app.order_events (order_id, id);

-- ───────────────────────────────────────────────────────────── operations

create table app.settings (
  key text primary key check (key ~ '^[a-z0-9_.]{2,64}$'),
  value jsonb not null,
  updated_at timestamptz not null default now(),
  updated_by uuid references app.users (id)
);

create table app.audit_log (
  id bigint generated always as identity primary key,
  actor_user_id uuid references app.users (id),
  action text not null,
  target_type text,
  target_id text,
  data jsonb not null default '{}',
  at timestamptz not null default now()
);
create index audit_log_target_idx on app.audit_log (target_type, target_id);
create index audit_log_actor_idx on app.audit_log (actor_user_id, at desc);

-- Messages waiting to be sent by the bot (order delivered, top-up credited...).
create table app.outbox (
  id bigint generated always as identity primary key,
  user_id uuid references app.users (id) on delete cascade,
  channel text not null default 'telegram' check (channel in ('telegram')),
  template text not null,
  data jsonb not null default '{}',
  status text not null default 'pending' check (status in ('pending', 'sent', 'failed')),
  attempts int not null default 0,
  available_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  sent_at timestamptz,
  last_error text
);
create index outbox_due_idx on app.outbox (available_at) where status = 'pending';
create index outbox_user_idx on app.outbox (user_id);

create table app.job_heartbeats (
  name text primary key,
  last_started_at timestamptz,
  last_ok_at timestamptz,
  last_error text
);

-- Every user gets a wallet.
create or replace function app.create_wallet() returns trigger
language plpgsql set search_path = app, pg_temp
as $$ begin insert into app.wallets (user_id) values (new.id) on conflict do nothing; return new; end $$;
create trigger users_wallet after insert on app.users for each row execute function app.create_wallet();

-- ───────────────────────────────────────────────────────────── access

-- Row-level security everywhere, as defence in depth: only store_server has policies.
do $$
declare t record;
begin
  for t in select tablename from pg_tables where schemaname = 'app' loop
    execute format('alter table app.%I enable row level security', t.tablename);
    execute format('create policy store_server_all on app.%I for all to store_server using (true) with check (true)', t.tablename);
  end loop;
end $$;

grant select, insert, update, delete on all tables in schema app to store_server;
grant usage, select on all sequences in schema app to store_server;
-- Money moves only through the functions below.
revoke insert, update, delete on app.wallets, app.ledger from store_server;
revoke update, delete on app.payments from store_server;
grant update (status, provider_ref, action, note, updated_at) on app.payments to store_server;
revoke delete on app.orders, app.deliveries, app.audit_log from store_server;
