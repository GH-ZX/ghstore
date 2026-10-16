-- Products delivered by hand, details customers give after paying, warranty
-- labels and clean supplier names.
--
-- products.delivery: 'auto' (the supplier or the store's stock delivers),
--   'manual' (a person delivers: no supplier is called, no stock is used) or
--   'review' (the supplier delivers, then a person checks and releases it).
-- products.after_fields: what the customer gives after paying (email,
--   password, ID, username, cookies/session token, or the owner's own), as
--   [{ key, type, labelEn, labelAr, hintEn?, hintAr?, required }]. The buy
--   sheet lists them before paying.
-- orders.hold: what the order waits for: 'info' (the customer's details),
--   'owner' (a person to deliver it) or 'release' (a person to check what the
--   supplier delivered). Null: nothing (the usual flow).
-- orders.answers_enc: the customer's details, encrypted like deliveries;
--   erased two weeks after the order is closed.
-- offers / supplier_items warranty_ar / warranty_en: "Full warranty",
--   "5-hour warranty", shown next to the package.
-- suppliers.clean_names: name this supplier's items with the name cleaner
--   (BatStore, ProdSeller: "Capcut pro 1M FW" → "CapCut Pro" · "1 month").
alter table app.products
  add column if not exists delivery text not null default 'auto' check (delivery in ('auto', 'manual', 'review')),
  add column if not exists after_fields jsonb not null default '[]'
    check (jsonb_typeof(after_fields) = 'array' and jsonb_array_length(after_fields) <= 8);

alter table app.offers
  add column if not exists warranty_ar text check (warranty_ar is null or length(warranty_ar) <= 40),
  add column if not exists warranty_en text check (warranty_en is null or length(warranty_en) <= 40);

alter table app.supplier_items
  add column if not exists warranty_ar text check (warranty_ar is null or length(warranty_ar) <= 40),
  add column if not exists warranty_en text check (warranty_en is null or length(warranty_en) <= 40);

alter table app.suppliers
  add column if not exists clean_names boolean not null default false;
update app.suppliers set clean_names = true where id in ('batstore', 'prodseller');

alter table app.orders
  add column if not exists hold text check (hold is null or hold in ('info', 'owner', 'release')),
  add column if not exists answers_enc text check (answers_enc is null or length(answers_enc) <= 60000),
  add column if not exists answered_at timestamptz;
create index if not exists orders_hold_idx on app.orders (created_at) where hold is not null;
-- The Worker sets these (orders' columns are granted one by one).
grant update (hold, answers_enc, answered_at) on app.orders to store_server;

create or replace function app.place_order(
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
  v_supplier text;
  v_hold text;
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

  -- Who delivers: the supplier (now, or once the customer has given the
  -- details asked after paying), or a person (products delivered by hand).
  v_supplier := case when v_product.delivery = 'manual' then null else v_offer.supplier_id end;
  v_hold := case
    when jsonb_array_length(v_product.after_fields) > 0 then 'info'
    when v_product.delivery = 'manual' then 'owner'
  end;

  update app.wallets w set balance_cents = w.balance_cents - v_total, updated_at = now()
    where w.user_id = p_user and w.balance_cents >= v_total
    returning w.balance_cents into v_balance;
  if not found then raise exception 'insufficient_balance'; end if;

  insert into app.orders (user_id, offer_id, product_id, quantity, unit_price_cents, discount_cents, total_cents, cost_cents,
                          coupon_id, status, channel, input, supplier_id, idempotency_key, next_check_at, hold)
  values (p_user, v_offer.id, v_product.id, p_quantity, v_offer.price_cents, v_discount, v_total,
          case when v_offer.cost_cents is null then null else v_offer.cost_cents * p_quantity end,
          case when v_discount > 0 then v_coupon.id end,
          'paid', p_channel, p_input, v_supplier, p_idempotency_key,
          case when v_supplier is null or v_hold is not null then null else now() end, v_hold)
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
    if v_claimed < p_quantity then
      raise exception 'out_of_stock';  -- rolls back the charge, the order and the coupon use
    end if;
    -- Stock is handed over at once: nothing left to wait for.
    update app.orders set status = 'delivered', delivered_at = now(), hold = null where id = v_order.id returning * into v_order;
    insert into app.order_events (order_id, type) values (v_order.id, 'delivered_from_stock');
  end if;

  return query select v_order.id, v_order.number, v_order.status, v_order.total_cents, v_order.discount_cents, v_balance, true;
end $$;

