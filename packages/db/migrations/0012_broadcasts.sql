-- Broadcasts: a Telegram message from the owner to every customer, or to those
-- who bought one product (Admin → Broadcast). Each recipient gets an outbox row,
-- sent by the scheduled job after order and payment messages (priority 1), so a
-- big broadcast never delays a receipt. Customers who turned notifications off
-- are skipped, as for every customer message.
create table if not exists app.broadcasts (
  id uuid primary key default app.uuid_v7(),
  text_ar text not null check (length(text_ar) between 1 and 1000),
  text_en text not null check (length(text_en) between 1 and 1000),
  audience text not null check (audience in ('all', 'buyers')),
  product_id uuid references app.products (id),
  button text not null default 'store' check (button in ('store', 'product')),
  recipients int not null default 0,
  idempotency_key text not null unique check (length(idempotency_key) between 8 and 64),
  created_by uuid not null references app.users (id),
  created_at timestamptz not null default now(),
  cancelled_at timestamptz,
  check (audience = 'all' or product_id is not null),
  check (button = 'store' or product_id is not null)
);

alter table app.broadcasts enable row level security;
create policy store_server_all on app.broadcasts for all to store_server using (true) with check (true);
grant select, insert, update on app.broadcasts to store_server;

-- Lower numbers go first; customer receipts and staff alerts stay at 0.
alter table app.outbox add column if not exists priority smallint not null default 0;
alter table app.outbox add column if not exists broadcast_id uuid references app.broadcasts (id) on delete set null;
create index if not exists outbox_broadcast_idx on app.outbox (broadcast_id) where broadcast_id is not null;
drop index if exists app.outbox_due_idx;
create index outbox_due_idx on app.outbox (priority, id) where status = 'pending';
