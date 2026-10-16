-- Favourites and "tell me when it's back".
--
-- favorites: products a customer saved (the heart on a product, Profile → Favourites).
-- stock_alerts: a sold-out package a customer wants to hear about; when it is on
--   sale again the store sends one Telegram message and forgets the request.
create table if not exists app.favorites (
  user_id uuid not null references app.users (id) on delete cascade,
  product_id uuid not null references app.products (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (user_id, product_id)
);

create table if not exists app.stock_alerts (
  user_id uuid not null references app.users (id) on delete cascade,
  offer_id uuid not null references app.offers (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (user_id, offer_id)
);
create index if not exists stock_alerts_offer_idx on app.stock_alerts (offer_id);

alter table app.favorites enable row level security;
alter table app.stock_alerts enable row level security;
create policy store_server_all on app.favorites for all to store_server using (true) with check (true);
create policy store_server_all on app.stock_alerts for all to store_server using (true) with check (true);
grant select, insert, delete on app.favorites, app.stock_alerts to store_server;
