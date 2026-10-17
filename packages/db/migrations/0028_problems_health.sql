-- v1.0: customers' problem reports, the owner's "something is broken" alerts,
-- and asking for a review after delivery.
--
-- order_problems: "Report a problem" on an order (didn't arrive, doesn't work,
--   wrong item, other) and the store's answer. One open report per order.
-- error_log: unexpected server errors, so the owner hears when they pile up
--   (kept a week).
-- alert_state: when each kind of alert was last sent, so a lasting problem
--   sends one message, not one a minute.
-- orders.review_asked_at: when the customer was asked to rate this order's
--   product (once per customer and product).
create table if not exists app.order_problems (
  id uuid primary key default app.uuid_v7(),
  order_id uuid not null references app.orders (id),
  user_id uuid not null references app.users (id) on delete cascade,
  reason text not null check (reason in ('not_received', 'not_working', 'wrong_item', 'other')),
  message text not null default '' check (length(message) <= 1000),
  status text not null default 'open' check (status in ('open', 'resolved')),
  reply text not null default '' check (length(reply) <= 1000),
  created_at timestamptz not null default now(),
  resolved_at timestamptz,
  resolved_by uuid references app.users (id)
);
create unique index if not exists order_problems_one_open on app.order_problems (order_id) where status = 'open';
create index if not exists order_problems_status_idx on app.order_problems (status, created_at desc);

create table if not exists app.error_log (
  id bigint generated always as identity primary key,
  at timestamptz not null default now(),
  source text not null default '' check (length(source) <= 120),
  message text not null default '' check (length(message) <= 500)
);
create index if not exists error_log_at_idx on app.error_log (at);

create table if not exists app.alert_state (
  key text primary key check (length(key) between 1 and 120),
  alerted_at timestamptz not null default now()
);

alter table app.orders add column if not exists review_asked_at timestamptz;
grant update (review_asked_at) on app.orders to store_server;

alter table app.order_problems enable row level security;
alter table app.error_log enable row level security;
alter table app.alert_state enable row level security;
create policy store_server_all on app.order_problems for all to store_server using (true) with check (true);
create policy store_server_all on app.error_log for all to store_server using (true) with check (true);
create policy store_server_all on app.alert_state for all to store_server using (true) with check (true);
grant select, insert, update on app.order_problems to store_server;
grant select, insert, delete on app.error_log to store_server;
grant select, insert, update, delete on app.alert_state to store_server;
