-- Database tests for migration 0030: who may credit a top-up by hand, hashes
-- reserved only once credited, no cashback without a known cost, coupons never
-- below one cent, and order leases. Run with: pnpm db:test
begin;

insert into app.products (id, slug, category_id, name_ar, name_en, kind, active)
  select '00000000-0000-7000-8000-000000000301', 'fix-codes', id, 'أكواد', 'Codes', 'code', true from app.categories where slug = 'vouchers';
-- Known cost (60 of 100), and unknown cost.
insert into app.offers (id, product_id, name_ar, name_en, price_cents, cost_cents, max_quantity)
  values ('00000000-0000-7000-8000-0000000003a1', '00000000-0000-7000-8000-000000000301', 'أ', 'A', 100, 60, 5);
insert into app.offers (id, product_id, name_ar, name_en, price_cents, max_quantity)
  values ('00000000-0000-7000-8000-0000000003a2', '00000000-0000-7000-8000-000000000301', 'ب', 'B', 100, 5);
insert into app.stock_items (offer_id, payload_enc)
  select o, 'v1.enc-' || o || g from unnest(array['00000000-0000-7000-8000-0000000003a1', '00000000-0000-7000-8000-0000000003a2']::uuid[]) o, generate_series(1, 3) g;
update app.settings set value = 'true' where key = 'loyalty.enabled';
update app.settings set value = '[{"min_cents": 0, "percent": 10}]' where key = 'loyalty.tiers';

do $$
declare
  owner_ uuid; support_ uuid; monitor_ uuid; buyer uuid; other uuid; pay uuid; pay2 uuid; r record; o record;
begin
  owner_ := app.ensure_telegram_user('730001', 'own', 'Owner', 'en');
  support_ := app.ensure_telegram_user('730002', 'sup', 'Support', 'en');
  monitor_ := app.ensure_telegram_user('730003', 'mon', 'Monitor', 'en');
  buyer := app.ensure_telegram_user('730004', 'buy', 'Buyer', 'en');
  update app.users set role = 'owner' where id = owner_;
  update app.users set role = 'support' where id = support_;
  update app.users set role = 'monitor' where id = monitor_;

  -- ───────────────────────────────────── crediting by hand
  insert into app.payments (user_id, method, amount_cents, status) values (buyer, 'sam', 1000, 'review') returning id into pay;
  -- support: not more than was asked
  begin
    perform app.credit_payment(pay, 1001, null, null, support_);
    assert false, 'expected not_allowed (more than asked)';
  exception when others then assert sqlerrm = 'not_allowed', 'got ' || sqlerrm; end;
  -- a monitor or a customer: never
  begin
    perform app.credit_payment(pay, 100, null, null, monitor_);
    assert false, 'expected not_allowed (monitor)';
  exception when others then assert sqlerrm = 'not_allowed', 'got ' || sqlerrm; end;
  begin
    perform app.credit_payment(pay, 100, null, null, buyer);
    assert false, 'expected not_allowed (customer)';
  exception when others then assert sqlerrm = 'not_allowed', 'got ' || sqlerrm; end;
  -- support: a top-up under review, up to its amount
  select * into r from app.credit_payment(pay, 1000, null, null, support_);
  assert r.credited and r.balance_cents = 1000, 'support credits a reviewed top-up';

  -- support: not one still pending, nor a closed one
  insert into app.payments (user_id, method, amount_cents, status) values (buyer, 'sam', 500, 'pending') returning id into pay;
  begin
    perform app.credit_payment(pay, 500, null, null, support_);
    assert false, 'expected not_allowed (pending)';
  exception when others then assert sqlerrm = 'not_allowed', 'got ' || sqlerrm; end;
  update app.payments set status = 'expired' where id = pay;
  begin
    perform app.credit_payment(pay, 500, null, null, support_);
    assert false, 'expected not_allowed (expired)';
  exception when others then assert sqlerrm = 'not_allowed', 'got ' || sqlerrm; end;
  -- the owner keeps full ability (a closed top-up, any amount)
  select * into r from app.credit_payment(pay, 700, null, null, owner_);
  assert r.credited and r.balance_cents = 1700, 'owner credits a closed top-up';

  -- support: never their own top-up
  insert into app.payments (user_id, method, amount_cents, status) values (support_, 'sam', 500, 'review') returning id into pay;
  begin
    perform app.credit_payment(pay, 500, null, null, support_);
    assert false, 'expected not_allowed (own top-up)';
  exception when others then assert sqlerrm = 'not_allowed', 'got ' || sqlerrm; end;
  assert (select balance_cents from app.wallets where user_id = support_) = 0, 'nothing credited to support';

  -- a provider's confirmation (no actor) still works as before
  insert into app.payments (user_id, method, amount_cents, status) values (buyer, 'sam', 300, 'pending') returning id into pay;
  select * into r from app.credit_payment(pay, 300, 'fix-inv-1');
  assert r.credited and r.balance_cents = 2000, 'provider credit';

  -- ───────────────────────────────────── a pasted hash two requests claim
  other := app.ensure_telegram_user('730005', 'oth', 'Other', 'en');
  insert into app.payments (user_id, method, amount_cents, status) values (other, 'bep20', 400, 'created') returning id into pay;
  insert into app.payments (user_id, method, amount_cents, status) values (support_, 'bep20', 400, 'created') returning id into pay2;
  perform app.submit_tx_hash(pay, other, '0x' || repeat('ab', 32));
  perform app.submit_tx_hash(pay2, support_, '0x' || repeat('ab', 32));
  update app.payments set user_id = buyer where id = pay2; -- not support's own, to test the claim itself
  -- support can't pick which request a contested transfer belongs to
  begin
    perform app.credit_payment(pay, 400, null, null, support_);
    assert false, 'expected not_allowed (contested hash)';
  exception when others then assert sqlerrm = 'not_allowed', 'got ' || sqlerrm; end;
  -- the owner can; the transfer is then taken, for staff and providers alike
  select * into r from app.credit_payment(pay, 400, null, null, owner_);
  assert r.credited, 'owner credits a contested hash';
  assert (select tx_hash from app.payments where id = pay) = '0x' || repeat('ab', 32), 'hash kept on the credited top-up';
  begin
    perform app.credit_payment(pay2, 400, null, null, owner_);
    assert false, 'expected tx_reused (staff, pasted hash)';
  exception when others then assert sqlerrm = 'tx_reused', 'got ' || sqlerrm; end;
  begin
    perform app.credit_payment(pay2, 400, null, '0x' || repeat('AB', 32));
    assert false, 'expected tx_reused (provider)';
  exception when others then assert sqlerrm = 'tx_reused', 'got ' || sqlerrm; end;

  -- ───────────────────────────────────── cashback needs a known cost
  select * into o from app.place_order(buyer, '00000000-0000-7000-8000-0000000003a2', 1, '{}', 'fix-order-0001', 'web');
  assert o.status = 'delivered', 'unknown-cost order delivered';
  assert not exists (select 1 from app.ledger where kind = 'cashback' and ref_id = o.order_id), 'no cashback without a known cost';
  select * into o from app.place_order(buyer, '00000000-0000-7000-8000-0000000003a1', 1, '{}', 'fix-order-0002', 'web');
  assert (select amount_cents from app.ledger where kind = 'cashback' and ref_id = o.order_id) = 10, '10% cashback with a known cost';

  -- ───────────────────────────────────── a coupon never takes a price below one cent
  insert into app.coupons (code, percent_off) values ('ALLFREE', 100);
  select * into r from app.quote_coupon(buyer, '00000000-0000-7000-8000-0000000003a2', 1, 'ALLFREE');
  assert r.total_cents = 1 and r.discount_cents = 99, 'unknown cost: down to 1 cent, got ' || r.total_cents;
  select * into r from app.quote_coupon(buyer, '00000000-0000-7000-8000-0000000003a1', 1, 'ALLFREE');
  assert r.total_cents = 60, 'known cost: down to the cost, got ' || r.total_cents;

  -- the ledger still matches every wallet
  assert (select balance_cents from app.wallets where user_id = buyer) = (select sum(amount_cents) from app.ledger where user_id = buyer), 'buyer ledger';
  raise notice 'order/money fix tests: all assertions passed';
end $$;

-- The server role may set the new order columns (column grants) ------------
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'store_test_app') then
    create role store_test_app login;
  end if;
end $$;
grant store_server to store_test_app;
-- On Supabase `postgres` is not a superuser and needs SET on the role it switches to (Postgres 16+ syntax).
grant store_test_app to current_user with set true;
set role store_test_app;
do $$
declare v_id uuid;
begin
  select id into v_id from app.orders where idempotency_key = 'fix-order-0001';
  update app.orders set fail_streak = fail_streak, lease_until = null where id = v_id;
  raise notice 'order/money fix privilege tests: all assertions passed';
end $$;
reset role;

rollback;
