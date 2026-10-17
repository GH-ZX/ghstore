-- Database tests for throttles and the open-USDT-request cap (0032). Run with: pnpm db:test
begin;

do $$
declare
  k text := 'test:' || gen_random_uuid();
  i int;
  ok boolean;
  u uuid; u2 uuid; p1 uuid; p2 uuid;
begin
  -- counts within the window, refuses past the limit, keys are separate
  for i in 1..3 loop
    assert app.rate_limit_hit(k, 3, 600), 'within the limit';
  end loop;
  assert not app.rate_limit_hit(k, 3, 600), 'over the limit';
  assert app.rate_limit_hit(k || ':other', 3, 600), 'another key has its own count';
  assert (select count from app.rate_limits where key = k) = 4, 'every attempt counted';

  -- bad arguments are refused
  begin
    perform app.rate_limit_hit('', 3, 600);
    assert false, 'empty key refused';
  exception when raise_exception then null;
  end;
  begin
    perform app.rate_limit_hit(k, 3, 0);
    assert false, 'zero window refused';
  exception when raise_exception then null;
  end;

  -- windows that are over get cleared by the function itself (about one call in fifty)
  insert into app.rate_limits (key, window_start, expires_at, count)
    select 'old:' || g, now() - interval '2 hours', now() - interval '1 hour', 5 from generate_series(1, 20) g;
  for i in 1..600 loop
    perform app.rate_limit_hit('sweep:' || (i % 7), 1000, 600);
    exit when not exists (select 1 from app.rate_limits where key like 'old:%');
  end loop;
  assert not exists (select 1 from app.rate_limits where key like 'old:%'), 'expired windows deleted';
  assert exists (select 1 from app.rate_limits where key = k), 'live windows kept';

  -- at most two USDT requests waiting per customer
  u := app.ensure_telegram_user('720001', 'usdt', 'Usdt', 'en');
  u2 := app.ensure_telegram_user('720002', 'usdt2', 'Usdt 2', 'en');
  insert into app.payments (user_id, method, amount_cents, send_units) values (u, 'bep20', 1000, 100100) returning id into p1;
  insert into app.payments (user_id, method, amount_cents, status, send_units) values (u, 'bep20', 1000, 'pending', 100101) returning id into p2;
  begin
    insert into app.payments (user_id, method, amount_cents, send_units) values (u, 'bep20', 2000, 200100);
    assert false, 'third open USDT request refused';
  exception when unique_violation then
    assert sqlerrm = 'rate_limited', 'refused as rate_limited';
  end;
  -- other methods and other customers are not affected
  insert into app.payments (user_id, method, amount_cents) values (u, 'sam', 1000);
  insert into app.payments (user_id, method, amount_cents, send_units) values (u2, 'bep20', 1000, 100102);
  -- one in review waits for staff and does not count; a closed one frees a place
  update app.payments set status = 'review' where id = p1;
  insert into app.payments (user_id, method, amount_cents, send_units) values (u, 'bep20', 2000, 200101);
  raise notice 'rate limit tests: all assertions passed';
end $$;

-- Privileges: the server role may call the function but not read or change the table
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
  assert app.rate_limit_hit('priv:' || gen_random_uuid(), 5, 60), 'store_server can count';
  begin
    perform 1 from app.rate_limits limit 1;
    assert false, 'store_server must not read rate_limits';
  exception when insufficient_privilege then null;
  end;
  begin
    delete from app.rate_limits;
    assert false, 'store_server must not reset rate_limits';
  exception when insufficient_privilege then null;
  end;
  raise notice 'rate limit privilege tests: all assertions passed';
end $$;
reset role;

rollback;
