-- Money and order functions.
--
-- These are the only way balances change. They run as the schema owner
-- (SECURITY DEFINER), lock the rows they touch in a fixed order (wallet, then
-- order/payment) and write the ledger in the same transaction. Errors are raised
-- with a short machine-readable message the API maps to a user-facing text:
--   insufficient_balance, offer_unavailable, out_of_stock, user_blocked,
--   invalid_quantity, invalid_input, payment_not_found, tx_reused, bad_state,
--   not_allowed.

-- ───────────────────────────────────────────────────────────── guards

-- A payment may only become "paid", and an order "refunded", when the matching
-- ledger row exists. This stops a direct UPDATE from faking either.
create or replace function app.guard_payment_paid() returns trigger
language plpgsql set search_path = app, pg_temp
as $$
begin
  if new.status = 'paid' and old.status is distinct from 'paid' then
    if not exists (select 1 from app.ledger where kind = 'topup' and ref_type = 'payment' and ref_id = new.id) then
      raise exception 'not_allowed' using detail = 'payments become paid only through app.credit_payment';
    end if;
  end if;
  if old.status = 'paid' and new.status is distinct from 'paid' then
    raise exception 'not_allowed' using detail = 'a paid payment cannot change status';
  end if;
  return new;
end $$;
create trigger payments_guard before update on app.payments for each row execute function app.guard_payment_paid();

create or replace function app.guard_order_refund() returns trigger
language plpgsql set search_path = app, pg_temp
as $$
begin
  if new.status = 'refunded' and old.status is distinct from 'refunded' then
    if not exists (select 1 from app.ledger where kind = 'refund' and ref_type = 'order' and ref_id = new.id) then
      raise exception 'not_allowed' using detail = 'orders become refunded only through app.refund_order';
    end if;
  end if;
  if old.status in ('delivered', 'refunded') and new.status is distinct from old.status then
    raise exception 'bad_state' using detail = format('order %s is final (%s)', old.id, old.status);
  end if;
  return new;
end $$;
create trigger orders_guard before update on app.orders for each row execute function app.guard_order_refund();

-- ───────────────────────────────────────────────────────────── identities

-- Find or create the user behind a Telegram account. Returns the user id.
create or replace function app.ensure_telegram_user(
  p_telegram_id text, p_username text, p_display_name text, p_locale text
) returns uuid
language plpgsql security definer set search_path = app, pg_temp
as $$
declare v_user uuid;
begin
  if p_telegram_id !~ '^[0-9]{1,20}$' then raise exception 'invalid_input'; end if;
  select user_id into v_user from app.identities where provider = 'telegram' and subject = p_telegram_id;
  if v_user is null then
    insert into app.users (display_name, locale)
    values (left(coalesce(p_display_name, ''), 120), case when p_locale = 'en' then 'en' else 'ar' end)
    returning id into v_user;
    begin
      insert into app.identities (user_id, provider, subject, username)
      values (v_user, 'telegram', p_telegram_id, p_username);
    exception when unique_violation then
      -- Another request created it first: use theirs, drop ours.
      delete from app.users where id = v_user;
      select user_id into v_user from app.identities where provider = 'telegram' and subject = p_telegram_id;
    end;
  else
    update app.identities set username = p_username
      where provider = 'telegram' and subject = p_telegram_id and username is distinct from p_username;
  end if;
  update app.users set last_seen_at = now() where id = v_user;
  return v_user;
end $$;

-- Same for a website account (Supabase Auth user id).
create or replace function app.ensure_web_user(p_auth_user_id text, p_email text, p_display_name text, p_locale text)
returns uuid
language plpgsql security definer set search_path = app, pg_temp
as $$
declare v_user uuid;
begin
  if p_auth_user_id !~ '^[0-9a-f-]{36}$' then raise exception 'invalid_input'; end if;
  select user_id into v_user from app.identities where provider = 'supabase' and subject = p_auth_user_id;
  if v_user is null then
    insert into app.users (display_name, locale)
    values (left(coalesce(p_display_name, ''), 120), case when p_locale = 'en' then 'en' else 'ar' end)
    returning id into v_user;
    begin
      insert into app.identities (user_id, provider, subject, email) values (v_user, 'supabase', p_auth_user_id, p_email);
    exception when unique_violation then
      delete from app.users where id = v_user;
      select user_id into v_user from app.identities where provider = 'supabase' and subject = p_auth_user_id;
    end;
  end if;
  update app.users set last_seen_at = now() where id = v_user;
  return v_user;
end $$;

-- ───────────────────────────────────────────────────────────── orders

-- Charge the wallet and create the order in one step. Idempotent per
-- (user, idempotency key): repeating the call returns the first order unchanged.
-- Manual-stock offers are delivered right here from app.stock_items.
create or replace function app.place_order(
  p_user uuid, p_offer uuid, p_quantity int, p_input jsonb, p_idempotency_key text, p_channel text
) returns table (order_id uuid, order_number bigint, status text, total_cents bigint, balance_cents bigint, created boolean)
language plpgsql security definer set search_path = app, pg_temp
as $$
declare
  v_existing app.orders;
  v_offer app.offers;
  v_product app.products;
  v_user app.users;
  v_total bigint;
  v_balance bigint;
  v_order app.orders;
  v_item record;
  v_claimed int := 0;
begin
  select * into v_existing from app.orders o where o.user_id = p_user and o.idempotency_key = p_idempotency_key;
  if found then
    return query select v_existing.id, v_existing.number, v_existing.status, v_existing.total_cents,
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

  v_total := v_offer.price_cents * p_quantity;

  -- Lock order: wallet first.
  update app.wallets w set balance_cents = w.balance_cents - v_total, updated_at = now()
    where w.user_id = p_user and w.balance_cents >= v_total
    returning w.balance_cents into v_balance;
  if not found then raise exception 'insufficient_balance'; end if;

  insert into app.orders (user_id, offer_id, product_id, quantity, unit_price_cents, total_cents, cost_cents,
                          status, channel, input, supplier_id, idempotency_key, next_check_at)
  values (p_user, v_offer.id, v_product.id, p_quantity, v_offer.price_cents, v_total,
          case when v_offer.cost_cents is null then null else v_offer.cost_cents * p_quantity end,
          'paid', p_channel, p_input, v_offer.supplier_id, p_idempotency_key,
          case when v_offer.supplier_id is null then null else now() end)
  returning * into v_order;

  insert into app.ledger (user_id, amount_cents, kind, ref_type, ref_id, balance_after_cents)
  values (p_user, -v_total, 'purchase', 'order', v_order.id, v_balance);
  insert into app.order_events (order_id, type, data) values (v_order.id, 'created', jsonb_build_object('channel', p_channel));

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
      raise exception 'out_of_stock';  -- rolls back the charge and the order
    end if;
    update app.orders set status = 'delivered', delivered_at = now() where id = v_order.id returning * into v_order;
    insert into app.order_events (order_id, type) values (v_order.id, 'delivered_from_stock');
  end if;

  return query select v_order.id, v_order.number, v_order.status, v_order.total_cents, v_balance, true;
end $$;

-- Put a failed or stuck order's money back, exactly once.
create or replace function app.refund_order(p_order uuid, p_reason text, p_actor uuid default null)
returns table (refunded boolean, balance_cents bigint)
language plpgsql security definer set search_path = app, pg_temp
as $$
declare
  v_order app.orders;
  v_balance bigint;
begin
  -- Lock order: wallet first, then the order.
  select o.* into v_order from app.orders o where o.id = p_order;
  if not found then raise exception 'invalid_input' using detail = 'unknown order'; end if;
  perform 1 from app.wallets w where w.user_id = v_order.user_id for update;
  select o.* into v_order from app.orders o where o.id = p_order for update;

  if v_order.status = 'refunded' then
    return query select false, (select w.balance_cents from app.wallets w where w.user_id = v_order.user_id);
    return;
  end if;
  if v_order.status = 'delivered' then raise exception 'bad_state' using detail = 'delivered orders are not refunded automatically'; end if;

  update app.wallets w set balance_cents = w.balance_cents + v_order.total_cents, updated_at = now()
    where w.user_id = v_order.user_id returning w.balance_cents into v_balance;
  insert into app.ledger (user_id, amount_cents, kind, ref_type, ref_id, balance_after_cents, note, actor_user_id)
  values (v_order.user_id, v_order.total_cents, 'refund', 'order', v_order.id, v_balance, left(p_reason, 500), p_actor);
  update app.orders set status = 'refunded', last_error = left(p_reason, 500), next_check_at = null where id = v_order.id;
  insert into app.order_events (order_id, type, data) values (v_order.id, 'refunded', jsonb_build_object('reason', p_reason, 'actor', p_actor));
  insert into app.outbox (user_id, template, data)
  values (v_order.user_id, 'order_refunded', jsonb_build_object('order_id', v_order.id, 'number', v_order.number, 'amount_cents', v_order.total_cents));
  return query select true, v_balance;
end $$;

-- Hand out orders whose supplier status is due for a check. Each claimed order
-- is leased for p_lease_seconds so parallel workers never handle the same one.
create or replace function app.claim_due_orders(p_limit int, p_lease_seconds int)
returns setof app.orders
language plpgsql security definer set search_path = app, pg_temp
as $$
begin
  return query
  update app.orders o set next_check_at = now() + make_interval(secs => p_lease_seconds)
  where o.id in (
    select d.id from app.orders d
    where d.status in ('paid', 'processing') and d.next_check_at <= now()
    order by d.next_check_at
    limit greatest(1, least(p_limit, 100))
    for update skip locked
  )
  returning o.*;
end $$;

-- ───────────────────────────────────────────────────────────── payments

-- Credit a confirmed payment to the wallet, exactly once.
-- p_amount_cents is what was actually received (may differ from what was asked).
create or replace function app.credit_payment(
  p_payment uuid, p_amount_cents bigint, p_provider_ref text default null, p_tx_hash text default null,
  p_actor uuid default null
) returns table (credited boolean, balance_cents bigint)
language plpgsql security definer set search_path = app, pg_temp
as $$
declare
  v_payment app.payments;
  v_balance bigint;
begin
  if p_amount_cents is null or p_amount_cents <= 0 then raise exception 'invalid_input' using detail = 'amount must be positive'; end if;
  select p.* into v_payment from app.payments p where p.id = p_payment;
  if not found then raise exception 'payment_not_found'; end if;
  perform 1 from app.wallets w where w.user_id = v_payment.user_id for update;
  select p.* into v_payment from app.payments p where p.id = p_payment for update;

  if v_payment.status = 'paid' then
    return query select false, (select w.balance_cents from app.wallets w where w.user_id = v_payment.user_id);
    return;
  end if;
  if v_payment.status in ('rejected', 'expired') and p_actor is null then
    raise exception 'bad_state' using detail = 'closed payments are credited only by staff';
  end if;
  if p_tx_hash is not null and exists (select 1 from app.payments p where p.tx_hash = lower(p_tx_hash) and p.id <> p_payment) then
    raise exception 'tx_reused';
  end if;

  update app.wallets w set balance_cents = w.balance_cents + p_amount_cents, updated_at = now()
    where w.user_id = v_payment.user_id returning w.balance_cents into v_balance;
  insert into app.ledger (user_id, amount_cents, kind, ref_type, ref_id, balance_after_cents, actor_user_id)
  values (v_payment.user_id, p_amount_cents, 'topup', 'payment', v_payment.id, v_balance, p_actor);
  update app.payments set
    status = 'paid', credited_cents = p_amount_cents, paid_at = now(), reviewed_by = coalesce(p_actor, reviewed_by),
    provider_ref = coalesce(p_provider_ref, provider_ref), tx_hash = coalesce(lower(p_tx_hash), tx_hash)
  where id = v_payment.id;
  insert into app.outbox (user_id, template, data)
  values (v_payment.user_id, 'payment_credited', jsonb_build_object('payment_id', v_payment.id, 'amount_cents', p_amount_cents, 'method', v_payment.method));
  return query select true, v_balance;
end $$;

-- Attach a customer-submitted transaction hash to a manual payment (BEP20).
-- Fails if the hash was already used by any payment.
create or replace function app.submit_tx_hash(p_payment uuid, p_user uuid, p_tx_hash text)
returns void
language plpgsql security definer set search_path = app, pg_temp
as $$
declare v_hash text := lower(trim(p_tx_hash));
begin
  if v_hash !~ '^0x[0-9a-f]{64}$' then raise exception 'invalid_input' using detail = 'not a transaction hash'; end if;
  begin
    update app.payments set tx_hash = v_hash, status = 'review'
      where id = p_payment and user_id = p_user and method = 'bep20' and status in ('created', 'pending', 'review');
    if not found then raise exception 'bad_state'; end if;
  exception when unique_violation then
    raise exception 'tx_reused';
  end;
end $$;

-- ───────────────────────────────────────────────────────────── staff

-- Manual balance change by the owner, with a reason, idempotent per key.
create or replace function app.adjust_wallet(
  p_user uuid, p_amount_cents bigint, p_note text, p_actor uuid, p_idempotency_key uuid
) returns table (applied boolean, balance_cents bigint)
language plpgsql security definer set search_path = app, pg_temp
as $$
declare v_balance bigint;
begin
  if not exists (select 1 from app.users u where u.id = p_actor and u.role = 'owner' and u.status = 'active') then
    raise exception 'not_allowed';
  end if;
  if p_amount_cents = 0 or p_note is null or length(trim(p_note)) < 3 then raise exception 'invalid_input'; end if;
  if exists (select 1 from app.ledger l where l.kind = 'adjustment' and l.ref_type = 'admin' and l.ref_id = p_idempotency_key) then
    return query select false, (select w.balance_cents from app.wallets w where w.user_id = p_user);
    return;
  end if;
  update app.wallets w set balance_cents = w.balance_cents + p_amount_cents, updated_at = now()
    where w.user_id = p_user and w.balance_cents + p_amount_cents >= 0
    returning w.balance_cents into v_balance;
  if not found then raise exception 'insufficient_balance'; end if;
  insert into app.ledger (user_id, amount_cents, kind, ref_type, ref_id, balance_after_cents, note, actor_user_id)
  values (p_user, p_amount_cents, 'adjustment', 'admin', p_idempotency_key, v_balance, left(p_note, 500), p_actor);
  insert into app.audit_log (actor_user_id, action, target_type, target_id, data)
  values (p_actor, 'wallet.adjust', 'user', p_user::text, jsonb_build_object('amount_cents', p_amount_cents, 'note', p_note));
  return query select true, v_balance;
end $$;

-- ───────────────────────────────────────────────────────────── grants

revoke all on function
  app.ensure_telegram_user(text, text, text, text),
  app.ensure_web_user(text, text, text, text),
  app.place_order(uuid, uuid, int, jsonb, text, text),
  app.refund_order(uuid, text, uuid),
  app.claim_due_orders(int, int),
  app.credit_payment(uuid, bigint, text, text, uuid),
  app.submit_tx_hash(uuid, uuid, text),
  app.adjust_wallet(uuid, bigint, text, uuid, uuid)
from public;

grant execute on function
  app.ensure_telegram_user(text, text, text, text),
  app.ensure_web_user(text, text, text, text),
  app.place_order(uuid, uuid, int, jsonb, text, text),
  app.refund_order(uuid, text, uuid),
  app.claim_due_orders(int, int),
  app.credit_payment(uuid, bigint, text, text, uuid),
  app.submit_tx_hash(uuid, uuid, text),
  app.adjust_wallet(uuid, bigint, text, uuid, uuid),
  app.uuid_v7()
to store_server;
