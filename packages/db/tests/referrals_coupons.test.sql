-- Database tests for referral rewards and coupons. Run with: pnpm db:test
begin;

insert into app.suppliers (id, name, enabled) values ('refsup', 'Ref supplier', true);
insert into app.products (id, slug, category_id, name_ar, name_en, kind, active)
  select '00000000-0000-7000-8000-000000000101', 'ref-uc', id, 'شدات', 'UC', 'id', true from app.categories where slug = 'games';
insert into app.products (id, slug, category_id, name_ar, name_en, kind, active)
  select '00000000-0000-7000-8000-000000000102', 'ref-codes', id, 'أكواد', 'Codes', 'code', true from app.categories where slug = 'vouchers';
-- Supplier offer: price 1000, cost 900. Stock offer: price 500, cost unknown.
insert into app.offers (id, product_id, name_ar, name_en, supplier_id, supplier_ref, cost_cents, price_cents, max_quantity)
  values ('00000000-0000-7000-8000-0000000001a1', '00000000-0000-7000-8000-000000000101', '600', '600', 'refsup', 'ext-600', 900, 1000, 5);
insert into app.offers (id, product_id, name_ar, name_en, price_cents, max_quantity)
  values ('00000000-0000-7000-8000-0000000001a2', '00000000-0000-7000-8000-000000000102', 'كود', 'Code', 500, 5);
insert into app.stock_items (offer_id, payload_enc) select '00000000-0000-7000-8000-0000000001a2', 'v1.enc-' || g from generate_series(1, 6) g;

update app.settings set value = '5' where key = 'referral.percent';
update app.settings set value = '30' where key = 'referral.days';
update app.settings set value = 'true' where key = 'referral.enabled';

do $$
declare
  inviter uuid; friend uuid; late uuid; other uuid; fresh uuid;
  icode text; o record; r record; pay uuid; bal bigint;
begin
  inviter := app.ensure_telegram_user('700001', 'inviter', 'Inviter', 'ar');
  friend := app.ensure_telegram_user('700002', 'friend', 'Friend', 'ar');
  late := app.ensure_telegram_user('700003', 'late', 'Late', 'en');
  other := app.ensure_telegram_user('700004', 'other', 'Other', 'en');

  -- invite codes are created once and stay the same
  icode := app.ensure_referral_code(inviter);
  assert icode ~ '^[A-Z2-9]{7}$', 'code shape: ' || icode;
  assert app.ensure_referral_code(inviter) = icode, 'code is stable';
  assert app.ensure_referral_code(friend) <> icode, 'codes are unique';

  -- linking: once, never to yourself, not with a bad code, not in a loop
  assert not app.set_referrer(inviter, icode), 'no self-referral';
  assert not app.set_referrer(friend, 'NOPE22X'), 'unknown code';
  assert not app.set_referrer(friend, 'bad code!'), 'malformed code';
  assert app.set_referrer(friend, lower(icode)), 'friend linked (code is case-insensitive)';
  assert not app.set_referrer(friend, app.ensure_referral_code(other)), 'linked only once';
  assert (select referred_by from app.users where id = friend) = inviter, 'referred_by set';
  assert not app.set_referrer(inviter, app.ensure_referral_code(friend)), 'no loops (inviter under friend)';
  assert (select count(*) from app.outbox where user_id = inviter and template = 'referral_joined') = 1, 'inviter told once';

  -- only brand-new customers can be linked
  update app.users set created_at = now() - interval '3 days' where id = late;
  assert not app.set_referrer(late, icode), 'old account cannot be linked';

  -- fund the friend
  insert into app.payments (user_id, method, amount_cents, status) values (friend, 'sam', 5000, 'pending') returning id into pay;
  perform app.credit_payment(pay, 5000, 'ref-inv-1');

  -- a delivered stock order pays the inviter 5% once
  select * into o from app.place_order(friend, '00000000-0000-7000-8000-0000000001a2', 2, '{}', 'ref-order-0001', 'web');
  assert o.status = 'delivered' and o.total_cents = 1000 and o.discount_cents = 0, 'stock order delivered';
  assert (select balance_cents from app.wallets where user_id = inviter) = 50, 'inviter earned 5% of 1000';
  assert (select count(*) from app.ledger where kind = 'referral' and ref_id = o.order_id) = 1, 'one reward row';
  assert (select count(*) from app.outbox where user_id = inviter and template = 'referral_reward') = 1, 'reward message queued';

  -- a supplier order pays only when delivered, and a refunded one never pays
  select * into o from app.place_order(friend, '00000000-0000-7000-8000-0000000001a1', 1, '{}', 'ref-order-0002', 'web');
  assert (select balance_cents from app.wallets where user_id = inviter) = 50, 'nothing while processing';
  update app.orders set status = 'processing' where id = o.order_id;
  update app.orders set status = 'delivered', delivered_at = now() where id = o.order_id;
  assert (select balance_cents from app.wallets where user_id = inviter) = 100, 'paid on delivery';
  select * into o from app.place_order(friend, '00000000-0000-7000-8000-0000000001a1', 1, '{}', 'ref-order-0003', 'web');
  update app.orders set status = 'failed' where id = o.order_id;
  perform app.refund_order(o.order_id, 'supplier failed');
  assert (select balance_cents from app.wallets where user_id = inviter) = 100, 'refunded order pays nothing';

  -- outside the reward window nothing is paid
  update app.users set referred_at = now() - interval '31 days' where id = friend;
  select * into o from app.place_order(friend, '00000000-0000-7000-8000-0000000001a2', 1, '{}', 'ref-order-0004', 'web');
  assert (select balance_cents from app.wallets where user_id = inviter) = 100, 'window over';
  update app.users set referred_at = now() where id = friend;

  -- switched off: nothing is paid
  update app.settings set value = 'false' where key = 'referral.enabled';
  select * into o from app.place_order(friend, '00000000-0000-7000-8000-0000000001a2', 1, '{}', 'ref-order-0005', 'web');
  assert (select balance_cents from app.wallets where user_id = inviter) = 100, 'disabled';
  update app.settings set value = 'true' where key = 'referral.enabled';

  -- a coupon plus a reward never sells below cost: 10% off a 1000 offer costing 900 leaves no margin, so no reward
  insert into app.coupons (code, percent_off) values ('NOMARGIN', 10);
  select * into o from app.place_order(friend, '00000000-0000-7000-8000-0000000001a1', 1, '{}', 'ref-order-0006', 'web', 'NOMARGIN');
  assert o.total_cents = 900, 'coupon down to cost';
  update app.orders set status = 'delivered', delivered_at = now() where id = o.order_id;
  assert (select balance_cents from app.wallets where user_id = inviter) = 100, 'no reward without margin';

  -- refunds pay back what the ledger charged, even if the order row was tampered with
  select * into o from app.place_order(friend, '00000000-0000-7000-8000-0000000001a1', 1, '{}', 'ref-order-0007', 'web');
  update app.orders set unit_price_cents = 50000, total_cents = 50000 where id = o.order_id;
  update app.orders set status = 'failed' where id = o.order_id;
  select * into r from app.refund_order(o.order_id, 'test');
  assert (select amount_cents from app.ledger where kind = 'refund' and ref_id = o.order_id) = 1000, 'refund = charge, not the edited total';

  -- the ledger still matches every wallet
  assert (select balance_cents from app.wallets where user_id = inviter) = (select sum(amount_cents) from app.ledger where user_id = inviter), 'inviter ledger';
  assert (select balance_cents from app.wallets where user_id = friend) = (select sum(amount_cents) from app.ledger where user_id = friend), 'friend ledger';
  raise notice 'referral tests: all assertions passed';

  -- ─────────────────────────────────────────────── coupons
  insert into app.payments (user_id, method, amount_cents, status) values (other, 'sam', 10000, 'pending') returning id into pay;
  perform app.credit_payment(pay, 10000, 'ref-inv-2');
  insert into app.coupons (code, percent_off, max_uses, max_uses_per_user) values ('SAVE10', 10, 3, 1);
  insert into app.coupons (code, amount_off_cents, min_order_cents) values ('TWODOLLARS', 200, 900);
  insert into app.coupons (code, percent_off, product_id) values ('UCONLY', 50, '00000000-0000-7000-8000-000000000101');
  insert into app.coupons (code, percent_off, expires_at) values ('OLD', 10, now() - interval '1 hour');

  -- quote = what place_order charges
  select * into r from app.quote_coupon(other, '00000000-0000-7000-8000-0000000001a2', 2, ' save10 ');
  assert r.discount_cents = 100 and r.total_cents = 900 and r.code = 'SAVE10', 'quote 10% of 1000';
  select * into o from app.place_order(other, '00000000-0000-7000-8000-0000000001a2', 2, '{}', 'cp-order-0001', 'web', 'save10');
  assert o.discount_cents = 100 and o.total_cents = 900, 'charged 900';
  assert (select balance_cents from app.wallets where user_id = other) = 9100, 'wallet charged the discounted total';
  assert (select uses from app.coupons where code = 'SAVE10') = 1, 'one use counted';
  assert (select discount_cents from app.coupon_redemptions where order_id = o.order_id) = 100, 'redemption saved';
  -- repeating the same request returns the same order, no second use
  select * into r from app.place_order(other, '00000000-0000-7000-8000-0000000001a2', 2, '{}', 'cp-order-0001', 'web', 'save10');
  assert not r.created and r.order_id = o.order_id and r.discount_cents = 100, 'idempotent with coupon';
  assert (select uses from app.coupons where code = 'SAVE10') = 1, 'still one use';

  -- per-user limit, product limit, minimum order, expiry, unknown code
  begin
    perform * from app.place_order(other, '00000000-0000-7000-8000-0000000001a2', 1, '{}', 'cp-order-0002', 'web', 'SAVE10');
    assert false, 'expected coupon_used';
  exception when others then assert sqlerrm = 'coupon_used', 'got ' || sqlerrm; end;
  begin
    perform * from app.quote_coupon(other, '00000000-0000-7000-8000-0000000001a2', 1, 'UCONLY');
    assert false, 'expected coupon_not_applicable';
  exception when others then assert sqlerrm = 'coupon_not_applicable', 'got ' || sqlerrm; end;
  begin
    perform * from app.quote_coupon(other, '00000000-0000-7000-8000-0000000001a2', 1, 'TWODOLLARS');
    assert false, 'expected coupon_min_order';
  exception when others then assert sqlerrm = 'coupon_min_order', 'got ' || sqlerrm; end;
  begin
    perform * from app.quote_coupon(other, '00000000-0000-7000-8000-0000000001a2', 1, 'OLD');
    assert false, 'expected coupon_invalid (expired)';
  exception when others then assert sqlerrm = 'coupon_invalid', 'got ' || sqlerrm; end;
  begin
    perform * from app.place_order(other, '00000000-0000-7000-8000-0000000001a2', 1, '{}', 'cp-order-0003', 'web', 'NOSUCH');
    assert false, 'expected coupon_invalid';
  exception when others then assert sqlerrm = 'coupon_invalid', 'got ' || sqlerrm; end;
  assert not exists (select 1 from app.orders where idempotency_key in ('cp-order-0002', 'cp-order-0003')), 'failed coupons leave nothing';

  -- a discount never goes below cost: 50% off a 1000 offer that costs 900 takes 100 off
  select * into r from app.quote_coupon(other, '00000000-0000-7000-8000-0000000001a1', 1, 'UCONLY');
  assert r.discount_cents = 100 and r.total_cents = 900, 'capped at cost, got ' || r.discount_cents;
  -- and when there is no margin left it does not apply at all
  update app.offers set cost_cents = 1000 where id = '00000000-0000-7000-8000-0000000001a1';
  begin
    perform * from app.quote_coupon(other, '00000000-0000-7000-8000-0000000001a1', 1, 'UCONLY');
    assert false, 'expected coupon_not_applicable (no margin)';
  exception when others then assert sqlerrm = 'coupon_not_applicable', 'got ' || sqlerrm; end;
  update app.offers set cost_cents = 900 where id = '00000000-0000-7000-8000-0000000001a1';

  -- a refunded order gives its coupon use back
  select * into o from app.place_order(other, '00000000-0000-7000-8000-0000000001a1', 1, '{}', 'cp-order-0004', 'web', 'TWODOLLARS');
  assert o.discount_cents = 100 and o.total_cents = 900, 'fixed coupon capped at cost too';
  assert (select uses from app.coupons where code = 'TWODOLLARS') = 1, 'used';
  update app.orders set status = 'failed' where id = o.order_id;
  select * into r from app.refund_order(o.order_id, 'supplier failed');
  assert r.refunded, 'refunded';
  assert (select uses from app.coupons where code = 'TWODOLLARS') = 0, 'use given back';
  assert (select released_at is not null from app.coupon_redemptions where order_id = o.order_id), 'redemption released';
  select * into o from app.place_order(other, '00000000-0000-7000-8000-0000000001a1', 1, '{}', 'cp-order-0005', 'web', 'TWODOLLARS');
  assert o.discount_cents = 100, 'can use it again after the refund';

  -- total use limit
  update app.coupons set max_uses = 1, uses = 1 where code = 'SAVE10';
  fresh := app.ensure_telegram_user('700005', 'fresh', 'Fresh', 'en');
  begin
    perform * from app.quote_coupon(fresh, '00000000-0000-7000-8000-0000000001a2', 1, 'SAVE10');
    assert false, 'expected coupon_exhausted';
  exception when others then assert sqlerrm = 'coupon_exhausted', 'got ' || sqlerrm; end;

  -- orders keep total = price x quantity - discount
  assert not exists (select 1 from app.orders where total_cents <> unit_price_cents * quantity - discount_cents), 'order totals consistent';
  select balance_cents into bal from app.wallets where user_id = other;
  assert bal = (select sum(amount_cents) from app.ledger where user_id = other), 'ledger sums to the balance';
  raise notice 'coupon tests: all assertions passed';
end $$;

-- Privileges: the server cannot fake uses, redemptions or who invited whom.
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'store_test_app') then
    create role store_test_app login;
  end if;
end $$;
grant store_server to store_test_app;
grant store_test_app to current_user with set true;
set role store_test_app;
do $$
begin
  begin
    update app.coupons set uses = 0;
    assert false, 'store_server must not reset coupon uses';
  exception when insufficient_privilege then null;
  end;
  begin
    delete from app.coupon_redemptions;
    assert false, 'store_server must not delete redemptions';
  exception when insufficient_privilege then null;
  end;
  begin
    update app.users set referred_by = null;
    assert false, 'store_server must not change referred_by';
  exception when insufficient_privilege then null;
  end;
  begin
    insert into app.orders (user_id, offer_id, product_id, quantity, unit_price_cents, total_cents, status, channel, idempotency_key)
      select user_id, offer_id, product_id, 1, 99999, 99999, 'paid', 'web', 'forged-order-0001' from app.orders limit 1;
    assert false, 'store_server must not insert orders';
  exception when insufficient_privilege then null;
  end;
  begin
    update app.orders set total_cents = total_cents + 1;
    assert false, 'store_server must not change order amounts';
  exception when insufficient_privilege then null;
  end;
  begin
    update app.orders set user_id = user_id;
    assert false, 'store_server must not change who an order belongs to';
  exception when insufficient_privilege then null;
  end;
  update app.orders set next_check_at = next_check_at, attempts = attempts, last_error = last_error where false;
  update app.coupons set active = false where code = 'OLD';
  update app.users set notify = notify where false;
  raise notice 'referral/coupon privilege tests: all assertions passed';
end $$;
reset role;

rollback;
