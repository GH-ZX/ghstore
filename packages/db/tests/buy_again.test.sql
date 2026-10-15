-- Database tests for "buy again" reminders. Run with: pnpm db:test
begin;

insert into app.products (id, slug, category_id, name_ar, name_en, kind, active)
  select '00000000-0000-7000-8000-000000000201', 'again-netflix', id, 'نتفلكس', 'Netflix', 'account', true from app.categories where slug = 'streaming';
insert into app.offers (id, product_id, name_ar, name_en, price_cents, max_quantity, remind_after_days)
  values ('00000000-0000-7000-8000-0000000002a1', '00000000-0000-7000-8000-000000000201', 'شهر', '1 month', 300, 5, 28);
insert into app.offers (id, product_id, name_ar, name_en, price_cents, max_quantity)
  values ('00000000-0000-7000-8000-0000000002a2', '00000000-0000-7000-8000-000000000201', 'سنة', '1 year', 2000, 5);
insert into app.stock_items (offer_id, payload_enc)
  select ('00000000-0000-7000-8000-0000000002a' || (1 + (g % 2)))::uuid, 'v1.enc-' || g from generate_series(1, 10) g;

do $$
declare
  u uuid; u2 uuid; pay uuid; o record; o2 record; n int;
begin
  u := app.ensure_telegram_user('710001', 'again', 'Again', 'en');
  u2 := app.ensure_telegram_user('710002', 'quiet', 'Quiet', 'en');
  insert into app.payments (user_id, method, amount_cents, status) values (u, 'sam', 5000, 'pending') returning id into pay;
  perform app.credit_payment(pay, 5000, 'again-1');
  insert into app.payments (user_id, method, amount_cents, status) values (u2, 'sam', 5000, 'pending') returning id into pay;
  perform app.credit_payment(pay, 5000, 'again-2');

  -- delivery sets the reminder from the package; packages without it get none
  select * into o from app.place_order(u, '00000000-0000-7000-8000-0000000002a1', 1, '{}', 'again-0001', 'web');
  assert (select remind_at::date from app.orders where id = o.order_id) = (now() + interval '28 days')::date, 'remind in 28 days';
  select * into o2 from app.place_order(u, '00000000-0000-7000-8000-0000000002a2', 1, '{}', 'again-0002', 'web');
  assert (select remind_at from app.orders where id = o2.order_id) is null, 'no reminder for the yearly package';

  -- not due yet: nothing queued
  assert app.queue_buy_again(50) = 0, 'nothing due';

  -- due, but the customer bought the product again since (order again-0002): skipped and cleared
  update app.orders set remind_at = now() - interval '1 minute' where id = o.order_id;
  assert app.queue_buy_again(50) = 0, 'already bought again';
  assert (select remind_at from app.orders where id = o.order_id) is null, 'cleared';

  -- due with no newer order: one message, once
  select * into o from app.place_order(u, '00000000-0000-7000-8000-0000000002a1', 1, '{}', 'again-0003', 'web');
  update app.orders set remind_at = now() - interval '1 minute' where id = o.order_id;
  assert app.queue_buy_again(50) = 1, 'queued';
  assert app.queue_buy_again(50) = 0, 'only once';
  assert (select data->>'slug' from app.outbox where user_id = u and template = 'buy_again') = 'again-netflix', 'deep link data';

  -- notifications off: cleared without a message
  update app.users set notify = false where id = u2;
  select * into o from app.place_order(u2, '00000000-0000-7000-8000-0000000002a1', 1, '{}', 'again-0004', 'web');
  update app.orders set remind_at = now() - interval '1 minute' where id = o.order_id;
  assert app.queue_buy_again(50) = 0, 'notify off';
  select count(*) into n from app.outbox where user_id = u2 and template = 'buy_again';
  assert n = 0, 'no message for a quiet user';
  raise notice 'buy-again tests: all assertions passed';
end $$;

rollback;
