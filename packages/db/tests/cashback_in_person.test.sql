-- Database tests for app.pay_cashback (migrations 0029/0030) and
-- app.place_in_person_order (0022): cashback capped by the margin left after an
-- invite reward, paid once per order, only from the wallet and only while
-- loyalty is on; face-to-face sales checked, idempotent and never charged.
-- Run with: pnpm db:test
begin;

insert into app.suppliers (id, name, enabled) values ('sqlcb_sup', 'SQL cashback supplier', true);
insert into app.products (id, slug, category_id, name_ar, name_en, kind, active)
  select '00000000-0000-7000-8000-000000000401', 'cb-codes', id, 'أكواد', 'Codes', 'code', true from app.categories where slug = 'vouchers';
insert into app.products (id, slug, category_id, name_ar, name_en, kind, active, delivery)
  select '00000000-0000-7000-8000-000000000402', 'cb-by-hand', id, 'يدوي', 'By hand', 'account', true, 'manual' from app.categories where slug = 'vouchers';
-- From the store's stock: a wide margin (900), a 250 margin, a 50 margin. From a supplier. Sold by hand.
insert into app.offers (id, product_id, name_ar, name_en, price_cents, cost_cents, max_quantity) values
  ('00000000-0000-7000-8000-0000000004a1', '00000000-0000-7000-8000-000000000401', 'أ', 'Wide', 1000, 100, 5),
  ('00000000-0000-7000-8000-0000000004a2', '00000000-0000-7000-8000-000000000401', 'ب', 'Mid', 1000, 750, 5),
  ('00000000-0000-7000-8000-0000000004a3', '00000000-0000-7000-8000-000000000401', 'ج', 'Thin', 1000, 950, 5);
insert into app.offers (id, product_id, name_ar, name_en, price_cents, cost_cents, max_quantity, supplier_id, supplier_ref) values
  ('00000000-0000-7000-8000-0000000004a4', '00000000-0000-7000-8000-000000000401', 'د', 'Supplier', 500, 400, 3, 'sqlcb_sup', 'x1');
insert into app.offers (id, product_id, name_ar, name_en, price_cents, cost_cents, max_quantity) values
  ('00000000-0000-7000-8000-0000000004a5', '00000000-0000-7000-8000-000000000402', 'ه', 'Hand', 700, 300, 2);
insert into app.stock_items (offer_id, payload_enc)
  select o, 'v1.enc-' || o || g
    from unnest(array['00000000-0000-7000-8000-0000000004a1', '00000000-0000-7000-8000-0000000004a2', '00000000-0000-7000-8000-0000000004a3']::uuid[]) o,
         generate_series(1, 8) g;

insert into app.settings (key, value) values ('loyalty.enabled', 'true') on conflict (key) do update set value = excluded.value;
insert into app.settings (key, value) values ('loyalty.tiers', '[{"min_cents": 0, "percent": 10}]') on conflict (key) do update set value = excluded.value;
insert into app.settings (key, value) values ('referral.enabled', 'true') on conflict (key) do update set value = excluded.value;
insert into app.settings (key, value) values ('referral.percent', '20') on conflict (key) do update set value = excluded.value;
insert into app.settings (key, value) values ('referral.days', '0') on conflict (key) do update set value = excluded.value;

do $$
declare
  owner_ uuid; support_ uuid; buyer uuid; invited uuid; inviter uuid; pay uuid; o record; r record; again record; n_ int; bal bigint;
  wide constant uuid := '00000000-0000-7000-8000-0000000004a1';
  mid constant uuid := '00000000-0000-7000-8000-0000000004a2';
  thin constant uuid := '00000000-0000-7000-8000-0000000004a3';
  sup_offer constant uuid := '00000000-0000-7000-8000-0000000004a4';
  hand constant uuid := '00000000-0000-7000-8000-0000000004a5';
begin
  owner_ := app.ensure_telegram_user('740001', 'own', 'Owner', 'en');
  support_ := app.ensure_telegram_user('740002', 'sup', 'Support', 'en');
  buyer := app.ensure_telegram_user('740003', 'buy', 'Buyer', 'en');
  invited := app.ensure_telegram_user('740004', 'inv', 'Invited', 'en');
  inviter := app.ensure_telegram_user('740005', 'ref', 'Inviter', 'en');
  update app.users set role = 'owner' where id = owner_;
  update app.users set role = 'support' where id = support_;
  update app.users set referred_by = inviter, referred_at = now() where id = invited;
  for r in select u from unnest(array[buyer, invited]) u loop
    insert into app.payments (user_id, method, amount_cents, status) values (r.u, 'sam', 10000, 'pending') returning id into pay;
    perform app.credit_payment(pay, 10000, 'cb-inv-' || pay);
  end loop;

  -- ───────────────────────────────────── cashback
  -- No invite: 10% of what was paid, well inside the margin.
  select * into o from app.place_order(buyer, wide, 1, '{}', 'cb-order-01', 'web');
  assert o.status = 'delivered', 'delivered from stock, got ' || o.status;
  assert (select amount_cents from app.ledger where kind = 'cashback' and ref_id = o.order_id) = 100, '10% cashback';

  -- Paid once per order: a delivered order is final, so it can not be delivered (and paid) again.
  begin
    update app.orders set status = 'processing' where id = o.order_id;
    assert false, 'expected bad_state (final order)';
  exception when others then assert sqlerrm = 'bad_state', 'got ' || sqlerrm; end;
  assert (select count(*) from app.ledger where kind = 'cashback' and ref_id = o.order_id) = 1, 'cashback once per order';
  -- A supplier order: nothing while it is paid or processing, once when delivered (cost 400 of 500: 10% = 50).
  select * into o from app.place_order(buyer, sup_offer, 1, '{"player": "1"}', 'cb-order-09', 'web');
  assert o.status = 'paid', 'supplier order paid, got ' || o.status;
  update app.orders set status = 'processing' where id = o.order_id;
  assert not exists (select 1 from app.ledger where kind = 'cashback' and ref_id = o.order_id), 'no cashback before delivery';
  update app.orders set status = 'delivered', delivered_at = now() where id = o.order_id;
  assert (select count(*) from app.ledger where kind = 'cashback' and ref_id = o.order_id) = 1, 'one cashback on delivery';
  assert (select amount_cents from app.ledger where kind = 'cashback' and ref_id = o.order_id) = 50, 'cashback on a supplier order';

  -- Invited customer, margin 900: the inviter gets 20% (200), cashback stays 100 (700 left).
  select * into o from app.place_order(invited, wide, 1, '{}', 'cb-order-02', 'web');
  assert (select amount_cents from app.ledger where kind = 'referral' and ref_id = o.order_id) = 200, 'referral 20%';
  assert (select amount_cents from app.ledger where kind = 'cashback' and ref_id = o.order_id) = 100, 'cashback with room left';

  -- Margin 250: the reward takes 200, cashback is capped at the 50 left (not 100).
  select * into o from app.place_order(invited, mid, 1, '{}', 'cb-order-03', 'web');
  assert (select amount_cents from app.ledger where kind = 'referral' and ref_id = o.order_id) = 200, 'referral within the margin';
  assert (select amount_cents from app.ledger where kind = 'cashback' and ref_id = o.order_id) = 50, 'cashback capped at margin minus referral';

  -- Margin 50: the reward takes all of it (capped to 50), so no cashback at all.
  select * into o from app.place_order(invited, thin, 1, '{}', 'cb-order-04', 'web');
  assert (select amount_cents from app.ledger where kind = 'referral' and ref_id = o.order_id) = 50, 'referral capped at the margin';
  assert not exists (select 1 from app.ledger where kind = 'cashback' and ref_id = o.order_id), 'no cashback once the margin is used up';
  -- Without an invite the same thin margin caps cashback at 50.
  select * into o from app.place_order(buyer, thin, 1, '{}', 'cb-order-05', 'web');
  assert (select amount_cents from app.ledger where kind = 'cashback' and ref_id = o.order_id) = 50, 'cashback capped at the margin';

  -- Loyalty switched off (false, or the key missing): nothing.
  update app.settings set value = 'false' where key = 'loyalty.enabled';
  select * into o from app.place_order(buyer, wide, 1, '{}', 'cb-order-06', 'web');
  assert o.status = 'delivered', 'still sold';
  assert not exists (select 1 from app.ledger where kind = 'cashback' and ref_id = o.order_id), 'no cashback while loyalty is off';
  delete from app.settings where key = 'loyalty.enabled';
  select * into o from app.place_order(buyer, wide, 1, '{}', 'cb-order-07', 'web');
  assert not exists (select 1 from app.ledger where kind = 'cashback' and ref_id = o.order_id), 'no cashback while loyalty is unset';
  insert into app.settings (key, value) values ('loyalty.enabled', 'true');

  -- A 0% level pays nothing.
  update app.settings set value = '[{"min_cents": 0, "percent": 0}]' where key = 'loyalty.tiers';
  select * into o from app.place_order(buyer, wide, 1, '{}', 'cb-order-08', 'web');
  assert not exists (select 1 from app.ledger where kind = 'cashback' and ref_id = o.order_id), 'no cashback at 0%';
  update app.settings set value = '[{"min_cents": 0, "percent": 10}]' where key = 'loyalty.tiers';

  -- ───────────────────────────────────── in person
  -- Only the owner sells face to face.
  begin
    perform app.place_in_person_order(support_, wide, 1, '{}', 'in-person-01');
    assert false, 'expected forbidden (support)';
  exception when others then assert sqlerrm = 'forbidden', 'got ' || sqlerrm; end;
  begin
    perform app.place_in_person_order(buyer, wide, 1, '{}', 'in-person-02');
    assert false, 'expected forbidden (customer)';
  exception when others then assert sqlerrm = 'forbidden', 'got ' || sqlerrm; end;
  -- Quantity within 1..max, input an object.
  begin
    perform app.place_in_person_order(owner_, wide, 0, '{}', 'in-person-03');
    assert false, 'expected invalid_quantity (0)';
  exception when others then assert sqlerrm = 'invalid_quantity', 'got ' || sqlerrm; end;
  begin
    perform app.place_in_person_order(owner_, wide, 6, '{}', 'in-person-04');
    assert false, 'expected invalid_quantity (over max)';
  exception when others then assert sqlerrm = 'invalid_quantity', 'got ' || sqlerrm; end;
  begin
    perform app.place_in_person_order(owner_, wide, 1, '[]', 'in-person-05');
    assert false, 'expected invalid_input';
  exception when others then assert sqlerrm = 'invalid_input', 'got ' || sqlerrm; end;
  -- A paused package, or one whose product is hidden, is not sold.
  update app.offers set paused_reason = 'staff' where id = mid;
  begin
    perform app.place_in_person_order(owner_, mid, 1, '{}', 'in-person-06');
    assert false, 'expected offer_unavailable (paused)';
  exception when others then assert sqlerrm = 'offer_unavailable', 'got ' || sqlerrm; end;
  update app.offers set paused_reason = null where id = mid;
  update app.products set active = false where id = '00000000-0000-7000-8000-000000000401';
  begin
    perform app.place_in_person_order(owner_, mid, 1, '{}', 'in-person-07');
    assert false, 'expected offer_unavailable (hidden product)';
  exception when others then assert sqlerrm = 'offer_unavailable', 'got ' || sqlerrm; end;
  update app.products set active = true where id = '00000000-0000-7000-8000-000000000401';

  -- From stock: delivered at once, codes handed over, no wallet touched, no cashback.
  bal := (select balance_cents from app.wallets where user_id = owner_);
  n_ := (select count(*) from app.stock_items where offer_id = wide and status = 'available');
  select * into o from app.place_in_person_order(owner_, wide, 2, '{}', 'in-person-10');
  assert o.created and o.status = 'delivered' and o.total_cents = 2000, 'in person from stock: ' || o.status || ' ' || o.total_cents;
  assert (select count(*) from app.deliveries where order_id = o.order_id) = 2, 'two codes delivered';
  assert (select count(*) from app.stock_items where offer_id = wide and status = 'available') = n_ - 2, 'two codes sold';
  select * into r from app.orders where id = o.order_id;
  assert r.paid_with = 'in_person' and r.channel = 'admin' and r.cost_cents = 200, 'paid in person, cost known';
  assert (select balance_cents from app.wallets where user_id = owner_) is not distinct from bal, 'no wallet charged';
  assert not exists (select 1 from app.ledger where ref_id = o.order_id), 'no ledger rows: no purchase, no cashback';
  -- The same key again: the same order, nothing new.
  select * into again from app.place_in_person_order(owner_, wide, 2, '{}', 'in-person-10');
  assert not again.created and again.order_id = o.order_id, 'idempotent per key';
  assert (select count(*) from app.stock_items where offer_id = wide and status = 'available') = n_ - 2, 'no more codes taken';

  -- More than the stock holds: refused, nothing taken.
  n_ := (select count(*) from app.stock_items where offer_id = mid and status = 'available');
  update app.offers set max_quantity = 20 where id = mid;
  begin
    perform app.place_in_person_order(owner_, mid, n_ + 1, '{}', 'in-person-11');
    assert false, 'expected out_of_stock';
  exception when others then assert sqlerrm = 'out_of_stock', 'got ' || sqlerrm; end;
  assert (select count(*) from app.stock_items where offer_id = mid and status = 'available') = n_, 'stock untouched';
  assert not exists (select 1 from app.orders where idempotency_key = 'in-person-11'), 'no order left behind';

  -- From a supplier: paid, due for the supplier now.
  select * into o from app.place_in_person_order(owner_, sup_offer, 1, '{"player": "1"}', 'in-person-12');
  select * into r from app.orders where id = o.order_id;
  assert o.status = 'paid' and r.supplier_id = 'sqlcb_sup' and r.next_check_at is not null and r.hold is null, 'supplier order queued';

  -- Sold by hand: waits for the owner, no supplier, nothing due.
  select * into o from app.place_in_person_order(owner_, hand, 1, '{}', 'in-person-13');
  select * into r from app.orders where id = o.order_id;
  assert o.status = 'paid' and r.hold = 'owner' and r.supplier_id is null and r.next_check_at is null, 'hand order waits for the owner';

  -- Every wallet still matches its ledger.
  for r in select u from unnest(array[buyer, invited, inviter]) u loop
    assert (select balance_cents from app.wallets where user_id = r.u) = (select coalesce(sum(amount_cents), 0) from app.ledger where user_id = r.u), 'ledger matches wallet';
  end loop;
  raise notice 'cashback and in-person tests: all assertions passed';
end $$;

rollback;
