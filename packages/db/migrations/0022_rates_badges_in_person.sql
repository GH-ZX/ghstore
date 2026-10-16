-- Success rates, product badges, sales made in person by the owner, and
-- profile pictures.
--
-- supplier_items / offers success_pct: how often a package delivers, 0-100,
--   when the supplier publishes it (5SIM: the share of its numbers that got
--   their SMS lately). Shown on the package; null: not known.
-- products.badge: the badge on the product's card, chosen by the owner
--   ('instant', 'new', 'hot', 'best', 'sale'); null: none.
-- orders.paid_with: 'wallet' (the usual purchase) or 'in_person': the owner
--   sold it face to face and took the money themselves. Such an order charges
--   no wallet, and its refund gives nothing back to a wallet.
-- users.photo_url: the Telegram profile picture, for the profile page.
alter table app.supplier_items
  add column if not exists success_pct numeric(4, 1) check (success_pct is null or success_pct between 0 and 100);
alter table app.offers
  add column if not exists success_pct numeric(4, 1) check (success_pct is null or success_pct between 0 and 100);

alter table app.products
  add column if not exists badge text check (badge is null or badge in ('instant', 'new', 'hot', 'best', 'sale'));

alter table app.orders
  add column if not exists paid_with text not null default 'wallet' check (paid_with in ('wallet', 'in_person'));

alter table app.users
  add column if not exists photo_url text check (photo_url is null or (length(photo_url) <= 500 and photo_url ~ '^https://[^\s"<>]+$'));
grant update (photo_url) on app.users to store_server;

-- The owner sells a package face to face: the order is placed like a customer's
-- (the supplier delivers, or the order waits for the owner), but no wallet is
-- charged. Idempotent per key, like place_order.
create or replace function app.place_in_person_order(
  p_staff uuid, p_offer uuid, p_quantity int, p_input jsonb, p_idempotency_key text
) returns table (order_id uuid, order_number bigint, status text, total_cents bigint, created boolean)
language plpgsql security definer set search_path = app, pg_temp
as $$
declare
  v_existing app.orders;
  v_staff app.users;
  v_offer app.offers;
  v_product app.products;
  v_order app.orders;
  v_item record;
  v_claimed int := 0;
  v_supplier text;
  v_hold text;
begin
  select * into v_existing from app.orders o where o.user_id = p_staff and o.idempotency_key = p_idempotency_key;
  if found then
    return query select v_existing.id, v_existing.number, v_existing.status, v_existing.total_cents, false;
    return;
  end if;

  select * into v_staff from app.users where id = p_staff;
  if not found or v_staff.role <> 'owner' or v_staff.status <> 'active' then raise exception 'forbidden'; end if;
  select * into v_offer from app.offers where id = p_offer;
  if not found or not v_offer.active or v_offer.paused_reason is not null then raise exception 'offer_unavailable'; end if;
  select * into v_product from app.products where id = v_offer.product_id;
  if not v_product.active then raise exception 'offer_unavailable'; end if;
  if p_quantity is null or p_quantity < 1 or p_quantity > v_offer.max_quantity then raise exception 'invalid_quantity'; end if;
  if p_input is null or jsonb_typeof(p_input) <> 'object' then raise exception 'invalid_input'; end if;

  v_supplier := case when v_product.delivery = 'manual' then null else v_offer.supplier_id end;
  v_hold := case
    when jsonb_array_length(v_product.after_fields) > 0 then 'info'
    when v_product.delivery = 'manual' then 'owner'
  end;

  insert into app.orders (user_id, offer_id, product_id, quantity, unit_price_cents, discount_cents, total_cents, cost_cents,
                          status, channel, input, supplier_id, idempotency_key, next_check_at, hold, paid_with)
  values (p_staff, v_offer.id, v_product.id, p_quantity, v_offer.price_cents, 0, v_offer.price_cents * p_quantity,
          case when v_offer.cost_cents is null then null else v_offer.cost_cents * p_quantity end,
          'paid', 'admin', p_input, v_supplier, p_idempotency_key,
          case when v_supplier is null or v_hold is not null then null else now() end, v_hold, 'in_person')
  returning * into v_order;
  insert into app.order_events (order_id, type, data) values (v_order.id, 'created', jsonb_build_object('channel', 'admin', 'in_person', true));

  if v_offer.supplier_id is null and v_product.delivery <> 'manual' then
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
    if v_claimed < p_quantity then raise exception 'out_of_stock'; end if;
    update app.orders set status = 'delivered', delivered_at = now(), hold = null where id = v_order.id returning * into v_order;
    insert into app.order_events (order_id, type) values (v_order.id, 'delivered_from_stock');
  end if;

  return query select v_order.id, v_order.number, v_order.status, v_order.total_cents, true;
end $$;

revoke all on function app.place_in_person_order(uuid, uuid, int, jsonb, text) from public;
grant execute on function app.place_in_person_order(uuid, uuid, int, jsonb, text) to store_server;

-- refund_order: an in-person sale was paid by hand, so its refund marks the
-- order refunded and gives nothing back to a wallet (the owner returns the
-- money themselves). Everything else is as in 0004.
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

  if v_order.paid_with = 'in_person' then
    update app.orders set status = 'refunded', last_error = left(p_reason, 500), next_check_at = null, hold = null where id = v_order.id;
    insert into app.order_events (order_id, type, data)
    values (v_order.id, 'refunded', jsonb_build_object('reason', p_reason, 'actor', p_actor, 'in_person', true));
    return query select true, (select w.balance_cents from app.wallets w where w.user_id = v_order.user_id);
    return;
  end if;

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

-- The refund guard: an in-person sale has no wallet charge to give back, so it
-- becomes refunded without a refund ledger row (store_server cannot change
-- paid_with, so no other order can pass this way).
create or replace function app.guard_order_refund() returns trigger
language plpgsql set search_path = app, pg_temp
as $$
begin
  if new.status = 'refunded' and old.status is distinct from 'refunded' and new.paid_with <> 'in_person' then
    if not exists (select 1 from app.ledger where kind = 'refund' and ref_type = 'order' and ref_id = new.id) then
      raise exception 'not_allowed' using detail = 'orders become refunded only through app.refund_order';
    end if;
  end if;
  if old.status in ('delivered', 'refunded') and new.status is distinct from old.status then
    raise exception 'bad_state' using detail = format('order %s is final (%s)', old.id, old.status);
  end if;
  return new;
end $$;
