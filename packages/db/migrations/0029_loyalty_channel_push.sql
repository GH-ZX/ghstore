-- v1.1: loyalty levels with cashback, posts to the store's Telegram channel,
-- and browser notifications for website customers.
--
-- Loyalty: a customer's level comes from what they spent on delivered orders in
-- the last 30 days (loyalty.tiers: ascending thresholds, each with a percent).
-- Each delivered order then pays that percent back to their wallet ('cashback'
-- on the ledger), never more than the order's margin left after an invite
-- reward, and a message when they reach a new level.
--
-- channel_posts: what the store posts to its channel (a new product, back in
-- stock, a price drop), queued here and sent a few a day by the scheduled job.
-- products.channel_posted_at: when a product was announced (products that
-- existed before this migration count as announced).
--
-- push_subscriptions: a browser's Web Push subscription (Profile →
-- notifications on this device), for website customers.

alter table app.ledger drop constraint ledger_kind_check;
alter table app.ledger add constraint ledger_kind_check
  check (kind in ('topup', 'purchase', 'refund', 'adjustment', 'referral', 'cashback'));

insert into app.settings (key, value) values
  ('loyalty.enabled', 'true'),
  ('loyalty.tiers', '[{"min_cents": 5000, "percent": 1}, {"min_cents": 20000, "percent": 2}, {"min_cents": 50000, "percent": 3}]')
on conflict (key) do nothing;

-- What a customer spent on delivered orders (from the wallet) in the last 30 days, without `p_except`.
create or replace function app.loyalty_spent(p_user uuid, p_except uuid default null) returns bigint
language sql stable security definer set search_path = app, pg_temp
as $$
  select coalesce(sum(-l.amount_cents), 0)::bigint
    from app.orders o join app.ledger l on l.kind = 'purchase' and l.ref_type = 'order' and l.ref_id = o.id and l.user_id = o.user_id
   where o.user_id = p_user and o.status = 'delivered' and o.delivered_at > now() - interval '30 days'
     and (p_except is null or o.id <> p_except)
$$;

-- The level (1 = first tier, 0 = none) and its percent for an amount spent.
create or replace function app.loyalty_level(p_spent bigint, out level int, out percent numeric)
language plpgsql stable security definer set search_path = app, pg_temp
as $$
declare t jsonb; i int := 0; v_tiers jsonb;
begin
  level := 0; percent := 0;
  v_tiers := (select value from app.settings where key = 'loyalty.tiers');
  if v_tiers is null or jsonb_typeof(v_tiers) <> 'array' then return; end if;
  for t in select value from jsonb_array_elements(v_tiers) loop
    i := i + 1;
    if p_spent >= coalesce((t->>'min_cents')::bigint, 0) then
      level := i;
      percent := least(greatest(coalesce((t->>'percent')::numeric, 0), 0), 10);
    end if;
  end loop;
end $$;

-- Cashback when an order is delivered. Named to run after the invite reward
-- trigger (same event, alphabetical), so both together stay within the margin.
create or replace function app.pay_cashback() returns trigger
language plpgsql security definer set search_path = app, pg_temp
as $$
declare
  v_paid bigint;
  v_before bigint;
  v_lb int; v_pb numeric;
  v_la int; v_pa numeric;
  v_referral bigint;
  v_amount bigint;
  v_balance bigint;
begin
  if new.status <> 'delivered' or old.status = 'delivered' then return null; end if;
  if (select value from app.settings where key = 'loyalty.enabled') is distinct from 'true'::jsonb then return null; end if;
  -- What the customer was charged from the wallet (in-person sales have none).
  select -l.amount_cents into v_paid from app.ledger l
   where l.kind = 'purchase' and l.ref_type = 'order' and l.ref_id = new.id and l.user_id = new.user_id;
  if v_paid is null or v_paid <= 0 then return null; end if;
  v_before := app.loyalty_spent(new.user_id, new.id);
  select level, percent into v_lb, v_pb from app.loyalty_level(v_before);
  select level, percent into v_la, v_pa from app.loyalty_level(v_before + v_paid);
  if v_la > v_lb then
    insert into app.outbox (user_id, template, data)
    values (new.user_id, 'level_up', jsonb_build_object('level', v_la, 'percent', v_pa));
  end if;
  if v_pa <= 0 then return null; end if;
  if exists (select 1 from app.ledger l where l.kind = 'cashback' and l.ref_type = 'order' and l.ref_id = new.id) then return null; end if;
  select coalesce(sum(l.amount_cents), 0) into v_referral from app.ledger l where l.kind = 'referral' and l.ref_type = 'order' and l.ref_id = new.id;
  v_amount := floor(v_paid * v_pa / 100);
  -- Never more than the margin left after an invite reward: no sale below cost.
  v_amount := least(v_amount, v_paid - coalesce(new.cost_cents, 0) - v_referral);
  if v_amount < 1 then return null; end if;
  update app.wallets w set balance_cents = w.balance_cents + v_amount, updated_at = now()
    where w.user_id = new.user_id returning w.balance_cents into v_balance;
  if not found then return null; end if;
  insert into app.ledger (user_id, amount_cents, kind, ref_type, ref_id, balance_after_cents)
  values (new.user_id, v_amount, 'cashback', 'order', new.id, v_balance);
  return null;
end $$;
create trigger orders_zz_cashback after update of status on app.orders
  for each row execute function app.pay_cashback();

revoke all on function app.pay_cashback(), app.loyalty_spent(uuid, uuid), app.loyalty_level(bigint) from public;
grant execute on function app.loyalty_spent(uuid, uuid), app.loyalty_level(bigint) to store_server;

-- ───────────────────────────────────────────────────────────── channel posts

create table if not exists app.channel_posts (
  id bigint generated always as identity primary key,
  kind text not null check (kind in ('new_product', 'back_in_stock', 'price_drop')),
  product_id uuid not null references app.products (id) on delete cascade,
  data jsonb not null default '{}',
  status text not null default 'pending' check (status in ('pending', 'sent', 'failed', 'skipped')),
  attempts int not null default 0,
  error text,
  created_at timestamptz not null default now(),
  sent_at timestamptz
);
create unique index if not exists channel_posts_one_pending on app.channel_posts (kind, product_id) where status = 'pending';
create index if not exists channel_posts_status_idx on app.channel_posts (status, created_at);

alter table app.products add column if not exists channel_posted_at timestamptz;
-- What is on sale today was already there: only products added from now on are announced.
update app.products set channel_posted_at = now() where channel_posted_at is null;

alter table app.channel_posts enable row level security;
create policy store_server_all on app.channel_posts for all to store_server using (true) with check (true);
grant select, insert, update on app.channel_posts to store_server;

-- ───────────────────────────────────────────────────────────── browser notifications

create table if not exists app.push_subscriptions (
  id uuid primary key default app.uuid_v7(),
  user_id uuid not null references app.users (id) on delete cascade,
  endpoint text not null unique check (endpoint ~ '^https://[^\s"<>]{8,}$' and length(endpoint) <= 1000),
  p256dh text not null check (length(p256dh) between 40 and 200),
  auth text not null check (length(auth) between 10 and 100),
  failures int not null default 0,
  created_at timestamptz not null default now(),
  last_ok_at timestamptz
);
create index if not exists push_subscriptions_user_idx on app.push_subscriptions (user_id);

alter table app.push_subscriptions enable row level security;
create policy store_server_all on app.push_subscriptions for all to store_server using (true) with check (true);
grant select, insert, update, delete on app.push_subscriptions to store_server;
