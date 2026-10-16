-- Database tests for the money functions. Run with: pnpm db:test
-- Each block raises an exception (and fails the run) when an expectation breaks.
begin;

-- Fixtures ------------------------------------------------------------------
insert into app.suppliers (id, name, enabled) values ('testsup', 'Test supplier', true);
insert into app.products (id, slug, category_id, name_ar, name_en, kind, active)
  select '00000000-0000-7000-8000-000000000001', 'test-uc', id, 'شدات', 'UC', 'id', true from app.categories where slug = 'games';
insert into app.products (id, slug, category_id, name_ar, name_en, kind, active)
  select '00000000-0000-7000-8000-000000000002', 'test-codes', id, 'أكواد', 'Codes', 'code', true from app.categories where slug = 'vouchers';
insert into app.offers (id, product_id, name_ar, name_en, supplier_id, supplier_ref, cost_cents, price_cents, max_quantity)
  values ('00000000-0000-7000-8000-0000000000a1', '00000000-0000-7000-8000-000000000001', '60', '60', 'testsup', 'ext-60', 100, 123, 5);
insert into app.offers (id, product_id, name_ar, name_en, price_cents, max_quantity)
  values ('00000000-0000-7000-8000-0000000000a2', '00000000-0000-7000-8000-000000000002', 'كود', 'Code', 250, 3);
insert into app.stock_items (offer_id, payload_enc) values
  ('00000000-0000-7000-8000-0000000000a2', 'v1.enc-one'),
  ('00000000-0000-7000-8000-0000000000a2', 'v1.enc-two');

do $$
declare
  u uuid; u2 uuid; v uuid; pay uuid; pay2 uuid; r record; o record; n int; bal bigint;
begin
  -- uuid v7 has version 7 and sorts by time
  v := app.uuid_v7();
  assert substr(v::text, 15, 1) = '7', 'uuid_v7 version nibble';

  -- identities are stable and create a wallet
  u := app.ensure_telegram_user('424242', 'samer_sy', 'Samer', 'ar');
  assert app.ensure_telegram_user('424242', 'samer_new', 'Samer', 'ar') = u, 'same telegram id -> same user';
  assert (select username from app.identities where subject = '424242') = 'samer_new', 'username refreshed';
  assert (select balance_cents from app.wallets where user_id = u) = 0, 'wallet created at zero';
  u2 := app.ensure_web_user('9b2f1c3e-1111-4222-8333-444455556666', 'a@example.com', 'Web', 'en');
  assert u2 <> u, 'web user is separate';

  -- not enough balance
  begin
    perform * from app.place_order(u, '00000000-0000-7000-8000-0000000000a1', 1, '{"player_id":"5123"}', 'order-key-0001', 'miniapp');
    assert false, 'expected insufficient_balance';
  exception when others then
    assert sqlerrm = 'insufficient_balance', 'got ' || sqlerrm;
  end;

  -- credit a payment, exactly once
  insert into app.payments (user_id, method, amount_cents, status) values (u, 'sam', 1000, 'pending') returning id into pay;
  select * into r from app.credit_payment(pay, 1000, 'sam-inv-1');
  assert r.credited and r.balance_cents = 1000, 'first credit applies';
  select * into r from app.credit_payment(pay, 1000, 'sam-inv-1');
  assert not r.credited and r.balance_cents = 1000, 'second credit is a no-op';
  assert (select count(*) from app.ledger where ref_id = pay) = 1, 'one ledger row per payment';
  assert (select count(*) from app.outbox where template = 'payment_credited') = 1, 'one notification queued';

  -- a direct update cannot fake "paid"
  insert into app.payments (user_id, method, amount_cents, send_units) values (u, 'bep20', 500, 50137) returning id into pay2;
  begin
    update app.payments set status = 'paid' where id = pay2;
    assert false, 'expected not_allowed';
  exception when others then
    assert sqlerrm = 'not_allowed', 'got ' || sqlerrm;
  end;

  -- transaction hashes can be used once
  perform app.submit_tx_hash(pay2, u, '0x' || repeat('ab', 32));
  assert (select status from app.payments where id = pay2) = 'review', 'manual transfer goes to review';
  -- two open manual-USDT requests never share an amount to send (so a hash matches one request);
  -- they may ask for the same amount, told apart by their small tag (5.0137 / 5.0142)
  begin
    insert into app.payments (user_id, method, amount_cents, send_units) values (u2, 'bep20', 500, 50137);
    assert false, 'expected a unique violation';
  exception when unique_violation then
    null;
  end;
  insert into app.payments (user_id, method, amount_cents, send_units) values (u2, 'bep20', 500, 50142) returning id into pay;
  begin
    perform app.submit_tx_hash(pay, u2, '0x' || repeat('AB', 32));
    assert false, 'expected tx_reused';
  exception when others then
    assert sqlerrm = 'tx_reused', 'got ' || sqlerrm;
  end;

  -- place an order; repeating the same key returns the same order without charging again
  select * into o from app.place_order(u, '00000000-0000-7000-8000-0000000000a1', 2, '{"player_id":"5123"}', 'order-key-0002', 'miniapp');
  assert o.created and o.total_cents = 246 and o.balance_cents = 754 and o.status = 'paid', 'order charged';
  select * into r from app.place_order(u, '00000000-0000-7000-8000-0000000000a1', 2, '{"player_id":"5123"}', 'order-key-0002', 'miniapp');
  assert not r.created and r.order_id = o.order_id and r.balance_cents = 754, 'idempotent order';
  assert (select count(*) from app.ledger where kind = 'purchase' and ref_id = o.order_id) = 1, 'charged once';

  -- quantity above the offer limit
  begin
    perform * from app.place_order(u, '00000000-0000-7000-8000-0000000000a1', 6, '{}', 'order-key-0003', 'web');
    assert false, 'expected invalid_quantity';
  exception when others then
    assert sqlerrm = 'invalid_quantity', 'got ' || sqlerrm;
  end;

  -- paused offers cannot be sold
  update app.offers set paused_reason = 'cost_above_margin' where id = '00000000-0000-7000-8000-0000000000a1';
  begin
    perform * from app.place_order(u, '00000000-0000-7000-8000-0000000000a1', 1, '{}', 'order-key-0004', 'web');
    assert false, 'expected offer_unavailable';
  exception when others then
    assert sqlerrm = 'offer_unavailable', 'got ' || sqlerrm;
  end;
  update app.offers set paused_reason = null where id = '00000000-0000-7000-8000-0000000000a1';

  -- claim due orders, then refund exactly once
  select count(*) into n from app.claim_due_orders(10, 60);
  assert n = 1, 'one order due';
  select count(*) into n from app.claim_due_orders(10, 60);
  assert n = 0, 'leased orders are not handed out twice';
  update app.orders set status = 'failed', last_error = 'supplier rejected' where id = o.order_id;
  select * into r from app.refund_order(o.order_id, 'supplier rejected');
  assert r.refunded and r.balance_cents = 1000, 'refund restores the balance';
  select * into r from app.refund_order(o.order_id, 'supplier rejected');
  assert not r.refunded and r.balance_cents = 1000, 'second refund is a no-op';
  begin
    update app.orders set status = 'processing' where id = o.order_id;
    assert false, 'expected bad_state';
  exception when others then
    assert sqlerrm = 'bad_state', 'got ' || sqlerrm;
  end;

  -- manual stock is delivered immediately; running out rolls everything back
  select * into o from app.place_order(u, '00000000-0000-7000-8000-0000000000a2', 2, '{}', 'order-key-0005', 'web');
  assert o.status = 'delivered' and o.balance_cents = 500, 'stock order delivered';
  assert (select count(*) from app.deliveries where order_id = o.order_id) = 2, 'two codes delivered';
  begin
    perform * from app.place_order(u, '00000000-0000-7000-8000-0000000000a2', 1, '{}', 'order-key-0006', 'web');
    assert false, 'expected out_of_stock';
  exception when others then
    assert sqlerrm = 'out_of_stock', 'got ' || sqlerrm;
  end;
  assert (select balance_cents from app.wallets where user_id = u) = 500, 'failed stock order did not charge';
  assert not exists (select 1 from app.orders where idempotency_key = 'order-key-0006'), 'failed stock order left nothing';

  -- staff adjustments: owner only, idempotent, never below zero
  begin
    perform * from app.adjust_wallet(u, 100, 'goodwill credit', u, '11111111-1111-4111-8111-111111111111');
    assert false, 'expected not_allowed';
  exception when others then
    assert sqlerrm = 'not_allowed', 'got ' || sqlerrm;
  end;
  update app.users set role = 'owner' where id = u2;
  select * into r from app.adjust_wallet(u, 100, 'goodwill credit', u2, '11111111-1111-4111-8111-111111111111');
  assert r.applied and r.balance_cents = 600, 'adjustment applied';
  select * into r from app.adjust_wallet(u, 100, 'goodwill credit', u2, '11111111-1111-4111-8111-111111111111');
  assert not r.applied and r.balance_cents = 600, 'adjustment idempotent';
  begin
    perform * from app.adjust_wallet(u, -1000, 'too much', u2, '22222222-2222-4222-8222-222222222222');
    assert false, 'expected insufficient_balance';
  exception when others then
    assert sqlerrm = 'insufficient_balance', 'got ' || sqlerrm;
  end;

  -- ledger always matches the wallet
  select balance_cents into bal from app.wallets where user_id = u;
  assert bal = (select sum(amount_cents) from app.ledger where user_id = u), 'ledger sums to the balance';
  raise notice 'money tests: all assertions passed';
end $$;

-- Privileges: the server role cannot touch balances directly ----------------
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
begin
  begin
    update app.wallets set balance_cents = 999999;
    assert false, 'store_server must not update wallets';
  exception when insufficient_privilege then null;
  end;
  begin
    insert into app.ledger (user_id, amount_cents, kind, ref_type, ref_id, balance_after_cents)
      select id, 1, 'topup', 'admin', gen_random_uuid(), 1 from app.users limit 1;
    assert false, 'store_server must not write the ledger';
  exception when insufficient_privilege then null;
  end;
  assert (select count(*) from app.orders) >= 1, 'store_server can read orders';
  raise notice 'privilege tests: all assertions passed';
end $$;
reset role;

-- Supabase API roles see nothing ------------------------------------------
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    assert not has_schema_privilege('anon', 'app', 'usage'), 'anon must not use schema app';
    assert not has_schema_privilege('authenticated', 'app', 'usage'), 'authenticated must not use schema app';
    raise notice 'api role tests: all assertions passed';
  end if;
end $$;

rollback;
