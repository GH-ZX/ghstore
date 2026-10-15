-- Referral rewards and coupon codes.
--
-- Referrals: every customer gets a short invite code. A brand-new customer who
-- arrives through it is linked to the inviter, and the inviter earns a
-- percentage of what that customer pays for each delivered order (for a set
-- number of days). The reward is a ledger row of kind 'referral' keyed by the
-- order, so it is paid once and only for delivered orders (which are final).
--
-- Coupons: a code takes a percentage or a fixed amount off one order. Limits:
-- total uses, uses per customer, minimum order, one product, start/end dates.
-- A discount never brings an order below its cost (when the cost is known) and
-- never to zero. A refunded order gives its coupon use back.
--
-- orders.total_cents stays "what the customer paid": it is now the list price
-- times quantity minus discount_cents, so revenue and profit stay right. Refunds
-- and rewards read the amount from the purchase ledger row itself, and the server
-- role can no longer insert orders or change their amounts.

-- ───────────────────────────────────────────────────────────── referrals

alter table app.users
  add column referral_code text unique check (referral_code ~ '^[A-Z2-9]{6,12}$'),
  add column referred_by uuid references app.users (id) on delete set null,
  add column referred_at timestamptz,
  add constraint users_not_self_referred check (referred_by is distinct from id);
create index users_referred_by_idx on app.users (referred_by) where referred_by is not null;

alter table app.ledger drop constraint ledger_kind_check;
alter table app.ledger add constraint ledger_kind_check
  check (kind in ('topup', 'purchase', 'refund', 'adjustment', 'referral'));

insert into app.settings (key, value) values
  ('referral.enabled', 'true'),
  -- Percent of what the invited customer pays that goes to the inviter.
  ('referral.percent', '2'),
  -- For how many days after joining the invited customer's orders earn rewards (0 = always).
  ('referral.days', '90')
on conflict (key) do nothing;

-- The user's invite code, created the first time it is asked for.
create or replace function app.ensure_referral_code(p_user uuid) returns text
language plpgsql security definer set search_path = app, pg_temp
as $$
declare
  v_code text;
  i int;
begin
  select referral_code into v_code from app.users where id = p_user;
  if not found then raise exception 'invalid_input' using detail = 'unknown user'; end if;
  if v_code is not null then return v_code; end if;
  for i in 1..10 loop
    -- 7 characters without look-alikes (no I, L, O, 0, 1): about 27 billion codes.
    select string_agg(substr('ABCDEFGHJKMNPQRSTUVWXYZ23456789', 1 + floor(random() * 31)::int, 1), '')
      into v_code from generate_series(1, 7);
    begin
      update app.users set referral_code = v_code where id = p_user and referral_code is null;
      if not found then
        select referral_code into v_code from app.users where id = p_user;  -- a parallel call set it first
      end if;
      return v_code;
    exception when unique_violation then
      null;  -- taken: try another
    end;
  end loop;
  raise exception 'internal' using detail = 'could not create a referral code';
end $$;

-- Link a new customer to the owner of an invite code. Only customers who joined
-- in the last day and have not ordered yet can be linked, only once, never to
-- themselves and never in a loop. Returns whether the link was made.
create or replace function app.set_referrer(p_user uuid, p_code text) returns boolean
language plpgsql security definer set search_path = app, pg_temp
as $$
declare
  v_user app.users;
  v_ref app.users;
  v_code text := upper(trim(coalesce(p_code, '')));
begin
  if v_code !~ '^[A-Z2-9]{6,12}$' then return false; end if;
  -- One link at a time, so parallel links can never close a loop between them.
  -- (Rare: only brand-new customers arriving through an invite get here.)
  perform pg_advisory_xact_lock(hashtext('app.set_referrer'));
  if (select value from app.settings where key = 'referral.enabled') is distinct from 'true'::jsonb then return false; end if;
  select * into v_user from app.users where id = p_user for update;
  if not found or v_user.referred_by is not null or v_user.created_at < now() - interval '1 day' then return false; end if;
  if exists (select 1 from app.orders where user_id = p_user) then return false; end if;
  select * into v_ref from app.users where referral_code = v_code;
  if not found or v_ref.id = p_user or v_ref.status <> 'active' then return false; end if;
  -- No loops: p_user must not already be somewhere above the inviter.
  if exists (
    with recursive up(id, depth) as (
      select v_ref.referred_by, 1
      union all
      select u.referred_by, up.depth + 1 from app.users u join up on u.id = up.id
      where up.id is not null and up.depth < 100
    )
    select 1 from up where id = p_user
  ) then
    return false;
  end if;
  update app.users set referred_by = v_ref.id, referred_at = now() where id = p_user;
  insert into app.outbox (user_id, template, data) values (v_ref.id, 'referral_joined', '{}');
  return true;
end $$;

-- Pay the inviter when an invited customer's order is delivered.
create or replace function app.pay_referral_reward() returns trigger
language plpgsql security definer set search_path = app, pg_temp
as $$
declare
  v_referrer uuid;
  v_joined timestamptz;
  v_pct numeric;
  v_days int;
  v_paid bigint;
  v_amount bigint;
  v_balance bigint;
begin
  if new.status <> 'delivered' or old.status = 'delivered' then return null; end if;
  select u.referred_by, u.referred_at into v_referrer, v_joined from app.users u where u.id = new.user_id;
  if v_referrer is null then return null; end if;
  if (select value from app.settings where key = 'referral.enabled') is distinct from 'true'::jsonb then return null; end if;
  v_pct := least(coalesce((select (value #>> '{}')::numeric from app.settings where key = 'referral.percent'), 0), 20);
  v_days := coalesce((select (value #>> '{}')::int from app.settings where key = 'referral.days'), 0);
  if v_pct <= 0 then return null; end if;
  if v_days > 0 and new.created_at > v_joined + make_interval(days => v_days) then return null; end if;
  -- What the customer was actually charged, from the ledger (not from the order row).
  select -l.amount_cents into v_paid from app.ledger l
   where l.kind = 'purchase' and l.ref_type = 'order' and l.ref_id = new.id and l.user_id = new.user_id;
  if v_paid is null or v_paid <= 0 then return null; end if;
  v_amount := floor(v_paid * v_pct / 100);
  -- Never more than the margin, so a coupon plus a reward can't sell below cost.
  v_amount := least(v_amount, v_paid - coalesce(new.cost_cents, 0));
  if v_amount < 1 then return null; end if;
  if exists (select 1 from app.ledger l where l.kind = 'referral' and l.ref_type = 'order' and l.ref_id = new.id) then return null; end if;

  update app.wallets w set balance_cents = w.balance_cents + v_amount, updated_at = now()
    where w.user_id = v_referrer and exists (select 1 from app.users u where u.id = v_referrer and u.status = 'active')
    returning w.balance_cents into v_balance;
  if not found then return null; end if;
  insert into app.ledger (user_id, amount_cents, kind, ref_type, ref_id, balance_after_cents)
  values (v_referrer, v_amount, 'referral', 'order', new.id, v_balance);
  insert into app.outbox (user_id, template, data)
  values (v_referrer, 'referral_reward', jsonb_build_object('amount_cents', v_amount));
  return null;
end $$;
create trigger orders_referral_reward after update of status on app.orders
  for each row execute function app.pay_referral_reward();

-- ───────────────────────────────────────────────────────────── coupons

create table app.coupons (
  id uuid primary key default app.uuid_v7(),
  code text not null unique check (code ~ '^[A-Z0-9_-]{3,32}$'),
  percent_off numeric(5, 2) check (percent_off > 0 and percent_off <= 100),
  amount_off_cents bigint check (amount_off_cents > 0),
  -- Cap for percentage coupons (e.g. 10% up to $5).
  max_discount_cents bigint check (max_discount_cents > 0),
  min_order_cents bigint not null default 0 check (min_order_cents >= 0),
  -- Only for this product (null = every product).
  product_id uuid references app.products (id) on delete cascade,
  max_uses int check (max_uses > 0),
  max_uses_per_user int not null default 1 check (max_uses_per_user > 0),
  uses int not null default 0 check (uses >= 0),
  starts_at timestamptz,
  expires_at timestamptz,
  active boolean not null default true,
  note text not null default '' check (length(note) <= 200),
  created_by uuid references app.users (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check ((percent_off is null) <> (amount_off_cents is null)),
  check (expires_at is null or starts_at is null or expires_at > starts_at)
);
create trigger coupons_touch before update on app.coupons for each row execute function app.touch_updated_at();

create table app.coupon_redemptions (
  id bigint generated always as identity primary key,
  coupon_id uuid not null references app.coupons (id) on delete restrict,
  user_id uuid not null references app.users (id) on delete restrict,
  order_id uuid not null unique references app.orders (id) on delete restrict,
  discount_cents bigint not null check (discount_cents > 0),
  released_at timestamptz,
  created_at timestamptz not null default now()
);
create index coupon_redemptions_open_idx on app.coupon_redemptions (coupon_id, user_id) where released_at is null;

alter table app.orders
  add column discount_cents bigint not null default 0 check (discount_cents >= 0),
  add column coupon_id uuid references app.coupons (id) on delete restrict;
alter table app.orders drop constraint orders_check;
alter table app.orders add constraint orders_total_check
  check (total_cents = unit_price_cents * quantity - discount_cents and total_cents > 0);

-- How much a coupon takes off this offer and quantity for this user, or an error:
-- coupon_invalid, coupon_not_applicable, coupon_used, coupon_exhausted, coupon_min_order.
create or replace function app.coupon_discount(p_coupon app.coupons, p_user uuid, p_offer app.offers, p_quantity int)
returns bigint
language plpgsql stable set search_path = app, pg_temp
as $$
declare
  v_total bigint := p_offer.price_cents * p_quantity;
  v_discount bigint;
  v_floor bigint;
begin
  if not p_coupon.active
     or (p_coupon.starts_at is not null and p_coupon.starts_at > now())
     or (p_coupon.expires_at is not null and p_coupon.expires_at <= now()) then
    raise exception 'coupon_invalid';
  end if;
  if p_coupon.product_id is not null and p_coupon.product_id <> p_offer.product_id then raise exception 'coupon_not_applicable'; end if;
  if p_coupon.max_uses is not null and p_coupon.uses >= p_coupon.max_uses then raise exception 'coupon_exhausted'; end if;
  if (select count(*) from app.coupon_redemptions r
       where r.coupon_id = p_coupon.id and r.user_id = p_user and r.released_at is null) >= p_coupon.max_uses_per_user then
    raise exception 'coupon_used';
  end if;
  if v_total < p_coupon.min_order_cents then raise exception 'coupon_min_order'; end if;

  v_discount := coalesce(floor(v_total * p_coupon.percent_off / 100)::bigint, p_coupon.amount_off_cents);
  if p_coupon.max_discount_cents is not null then v_discount := least(v_discount, p_coupon.max_discount_cents); end if;
  -- Never below cost (when known) and never free.
  v_floor := greatest(1, coalesce(p_offer.cost_cents * p_quantity, 0));
  v_discount := least(v_discount, v_total - v_floor);
  if v_discount < 1 then raise exception 'coupon_not_applicable'; end if;
  return v_discount;
end $$;

-- Preview a coupon before buying (no locks, nothing written).
create or replace function app.quote_coupon(p_user uuid, p_offer uuid, p_quantity int, p_code text)
returns table (coupon_id uuid, code text, discount_cents bigint, total_cents bigint)
language plpgsql stable security definer set search_path = app, pg_temp
as $$
declare
  v_offer app.offers;
  v_coupon app.coupons;
  v_discount bigint;
begin
  select * into v_offer from app.offers where id = p_offer;
  if not found or not v_offer.active or v_offer.paused_reason is not null
     or not exists (select 1 from app.products p where p.id = v_offer.product_id and p.active) then
    raise exception 'offer_unavailable';
  end if;
  if p_quantity is null or p_quantity < 1 or p_quantity > v_offer.max_quantity then raise exception 'invalid_quantity'; end if;
  select * into v_coupon from app.coupons c where c.code = upper(trim(coalesce(p_code, '')));
  if not found then raise exception 'coupon_invalid'; end if;
  v_discount := app.coupon_discount(v_coupon, p_user, v_offer, p_quantity);
  return query select v_coupon.id, v_coupon.code, v_discount, v_offer.price_cents * p_quantity - v_discount;
end $$;

-- place_order gains an optional coupon code. Lock order: coupon, wallet, order.
drop function app.place_order(uuid, uuid, int, jsonb, text, text);
create function app.place_order(
  p_user uuid, p_offer uuid, p_quantity int, p_input jsonb, p_idempotency_key text, p_channel text,
  p_coupon text default null
) returns table (order_id uuid, order_number bigint, status text, total_cents bigint, discount_cents bigint,
                 balance_cents bigint, created boolean)
language plpgsql security definer set search_path = app, pg_temp
as $$
declare
  v_existing app.orders;
  v_offer app.offers;
  v_product app.products;
  v_user app.users;
  v_coupon app.coupons;
  v_discount bigint := 0;
  v_total bigint;
  v_balance bigint;
  v_order app.orders;
  v_item record;
  v_claimed int := 0;
begin
  select * into v_existing from app.orders o where o.user_id = p_user and o.idempotency_key = p_idempotency_key;
  if found then
    return query select v_existing.id, v_existing.number, v_existing.status, v_existing.total_cents, v_existing.discount_cents,
      (select w.balance_cents from app.wallets w where w.user_id = p_user), false;
    return;
  end if;

  select * into v_user from app.users where id = p_user;
  if not found then raise exception 'invalid_input' using detail = 'unknown user'; end if;
  if v_user.status <> 'active' then raise exception 'user_blocked'; end if;

  select * into v_offer from app.offers where id = p_offer;
  if not found or not v_offer.active or v_offer.paused_reason is not null then raise exception 'offer_unavailable'; end if;
  select * into v_product from app.products where id = v_offer.product_id;
  if not v_product.active then raise exception 'offer_unavailable'; end if;
  if p_quantity is null or p_quantity < 1 or p_quantity > v_offer.max_quantity then raise exception 'invalid_quantity'; end if;
  if p_input is null or jsonb_typeof(p_input) <> 'object' then raise exception 'invalid_input'; end if;
  if p_channel not in ('web', 'miniapp', 'bot', 'admin') then raise exception 'invalid_input'; end if;

  if coalesce(trim(p_coupon), '') <> '' then
    select * into v_coupon from app.coupons c where c.code = upper(trim(p_coupon)) for update;
    if not found then raise exception 'coupon_invalid'; end if;
    v_discount := app.coupon_discount(v_coupon, p_user, v_offer, p_quantity);
  end if;
  v_total := v_offer.price_cents * p_quantity - v_discount;

  update app.wallets w set balance_cents = w.balance_cents - v_total, updated_at = now()
    where w.user_id = p_user and w.balance_cents >= v_total
    returning w.balance_cents into v_balance;
  if not found then raise exception 'insufficient_balance'; end if;

  insert into app.orders (user_id, offer_id, product_id, quantity, unit_price_cents, discount_cents, total_cents, cost_cents,
                          coupon_id, status, channel, input, supplier_id, idempotency_key, next_check_at)
  values (p_user, v_offer.id, v_product.id, p_quantity, v_offer.price_cents, v_discount, v_total,
          case when v_offer.cost_cents is null then null else v_offer.cost_cents * p_quantity end,
          case when v_discount > 0 then v_coupon.id end,
          'paid', p_channel, p_input, v_offer.supplier_id, p_idempotency_key,
          case when v_offer.supplier_id is null then null else now() end)
  returning * into v_order;

  insert into app.ledger (user_id, amount_cents, kind, ref_type, ref_id, balance_after_cents)
  values (p_user, -v_total, 'purchase', 'order', v_order.id, v_balance);
  insert into app.order_events (order_id, type, data)
  values (v_order.id, 'created', jsonb_strip_nulls(jsonb_build_object(
    'channel', p_channel, 'coupon', case when v_discount > 0 then v_coupon.code end,
    'discount_cents', nullif(v_discount, 0))));

  if v_discount > 0 then
    insert into app.coupon_redemptions (coupon_id, user_id, order_id, discount_cents) values (v_coupon.id, p_user, v_order.id, v_discount);
    update app.coupons set uses = uses + 1 where id = v_coupon.id;
  end if;

  if v_offer.supplier_id is null then
    for v_item in
      select s.id, s.payload_enc from app.stock_items s
      where s.offer_id = v_offer.id and s.status = 'available'
      order by s.id limit p_quantity
      for update skip locked
    loop
      update app.stock_items set status = 'sold', order_id = v_order.id, sold_at = now() where id = v_item.id;
      insert into app.deliveries (order_id, kind, value_enc) values (v_order.id, v_product.kind, v_item.payload_enc);
      v_claimed := v_claimed + 1;
    end loop;
    if v_claimed < p_quantity then
      raise exception 'out_of_stock';  -- rolls back the charge, the order and the coupon use
    end if;
    update app.orders set status = 'delivered', delivered_at = now() where id = v_order.id returning * into v_order;
    insert into app.order_events (order_id, type) values (v_order.id, 'delivered_from_stock');
  end if;

  return query select v_order.id, v_order.number, v_order.status, v_order.total_cents, v_order.discount_cents, v_balance, true;
end $$;

-- refund_order also gives the coupon use back. It refunds exactly what the
-- purchase ledger row charged, to the user it charged. Lock order: order, coupon,
-- wallet (the fulfilment job already holds the order row when it refunds).
create or replace function app.refund_order(p_order uuid, p_reason text, p_actor uuid default null)
returns table (refunded boolean, balance_cents bigint)
language plpgsql security definer set search_path = app, pg_temp
as $$
declare
  v_order app.orders;
  v_user uuid;
  v_amount bigint;
  v_balance bigint;
  v_coupon uuid;
begin
  select o.* into v_order from app.orders o where o.id = p_order for update;
  if not found then raise exception 'invalid_input' using detail = 'unknown order'; end if;
  if v_order.status = 'refunded' then
    return query select false, (select w.balance_cents from app.wallets w where w.user_id = v_order.user_id);
    return;
  end if;
  if v_order.status = 'delivered' then raise exception 'bad_state' using detail = 'delivered orders are not refunded automatically'; end if;

  select l.user_id, -l.amount_cents into v_user, v_amount from app.ledger l
   where l.kind = 'purchase' and l.ref_type = 'order' and l.ref_id = v_order.id;
  if v_user is null or v_amount is null or v_amount <= 0 then
    raise exception 'bad_state' using detail = 'no purchase charge recorded for this order';
  end if;

  if v_order.coupon_id is not null then
    perform 1 from app.coupons c where c.id = v_order.coupon_id for update;
  end if;
  update app.wallets w set balance_cents = w.balance_cents + v_amount, updated_at = now()
    where w.user_id = v_user returning w.balance_cents into v_balance;
  insert into app.ledger (user_id, amount_cents, kind, ref_type, ref_id, balance_after_cents, note, actor_user_id)
  values (v_user, v_amount, 'refund', 'order', v_order.id, v_balance, left(p_reason, 500), p_actor);
  update app.orders set status = 'refunded', last_error = left(p_reason, 500), next_check_at = null where id = v_order.id;
  update app.coupon_redemptions set released_at = now() where order_id = v_order.id and released_at is null
    returning coupon_id into v_coupon;
  if v_coupon is not null then
    update app.coupons set uses = greatest(uses - 1, 0) where id = v_coupon;
  end if;
  insert into app.order_events (order_id, type, data) values (v_order.id, 'refunded', jsonb_build_object('reason', p_reason, 'actor', p_actor));
  insert into app.outbox (user_id, template, data)
  values (v_user, 'order_refunded', jsonb_build_object('order_id', v_order.id, 'number', v_order.number, 'amount_cents', v_amount));
  return query select true, v_balance;
end $$;

-- ───────────────────────────────────────────────────────────── access

do $$
declare t text;
begin
  foreach t in array array['coupons', 'coupon_redemptions'] loop
    execute format('alter table app.%I enable row level security', t);
    execute format('create policy store_server_all on app.%I for all to store_server using (true) with check (true)', t);
  end loop;
end $$;

grant select, insert on app.coupons to store_server;
-- The use counter and redemptions change only inside place_order / refund_order.
grant update (percent_off, amount_off_cents, max_discount_cents, min_order_cents, product_id, max_uses,
              max_uses_per_user, starts_at, expires_at, active, note, updated_at) on app.coupons to store_server;
grant select on app.coupon_redemptions to store_server;
-- Orders are created only by place_order (which charges the wallet); the server
-- may change only what fulfilment needs. Amounts, owner and coupon stay as charged.
revoke insert, update on app.orders from store_server;
grant update (status, delivered_at, supplier_order_id, next_check_at, cost_cents, attempts, last_error, updated_at)
  on app.orders to store_server;
-- Who invited whom is set only through set_referrer.
revoke update on app.users from store_server;
grant update (display_name, locale, role, status, notify, sessions_revoked_at, updated_at, last_seen_at) on app.users to store_server;

revoke all on function
  app.ensure_referral_code(uuid),
  app.set_referrer(uuid, text),
  app.pay_referral_reward(),
  app.coupon_discount(app.coupons, uuid, app.offers, int),
  app.quote_coupon(uuid, uuid, int, text),
  app.place_order(uuid, uuid, int, jsonb, text, text, text)
from public;
grant execute on function
  app.ensure_referral_code(uuid),
  app.set_referrer(uuid, text),
  app.quote_coupon(uuid, uuid, int, text),
  app.place_order(uuid, uuid, int, jsonb, text, text, text)
to store_server;
