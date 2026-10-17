-- Database tests for the nightly housekeeping (0031). Run with: pnpm db:test
begin;

-- The throttle table of 0032, if that migration is not here yet (rolled back below).
create table if not exists app.rate_limits (
  key text not null, window_start timestamptz not null, expires_at timestamptz not null, count integer not null default 1,
  primary key (key, window_start)
);

do $$
declare
  u uuid; s_old uuid; s_new uuid; r jsonb; total int;
begin
  u := app.ensure_telegram_user('730001', 'tidy', 'Tidy', 'en');

  -- messages: old sent/failed go, pending and recent stay; old broadcast messages stay half a year
  insert into app.outbox (user_id, template, status, created_at) values
    (u, 'hk_old_sent', 'sent', now() - interval '40 days'),
    (u, 'hk_old_failed', 'failed', now() - interval '40 days'),
    (u, 'hk_old_pending', 'pending', now() - interval '40 days'),
    (u, 'hk_new_sent', 'sent', now() - interval '2 days');

  -- sessions: ended over a week ago go (with their link requests), live ones stay
  insert into app.sessions (user_id, channel, expires_at) values (u, 'web', now() - interval '8 days') returning id into s_old;
  insert into app.sessions (user_id, channel, expires_at) values (u, 'web', now() + interval '8 days') returning id into s_new;
  insert into app.link_requests (session_id, provider, token_hash, expires_at) values
    (s_new, 'telegram', repeat('a', 64), now() - interval '1 minute'),
    (s_new, 'supabase', repeat('b', 64), now() + interval '10 minutes');

  insert into app.alert_state (key, alerted_at) values ('hk:old', now() - interval '31 days'), ('hk:new', now());
  insert into app.rate_limits (key, window_start, expires_at) values
    ('hk:old', now() - interval '3 days', now() - interval '2 days'),
    ('hk:new', now(), now() + interval '1 hour');

  -- small batches: called again until nothing is left
  total := 0;
  loop
    r := app.housekeep(1);
    exit when (select coalesce(sum(value::int), 0) from jsonb_each_text(r)) = 0;
    total := total + 1;
    assert total < 50, 'housekeeping ends';
  end loop;

  assert (select count(*) from app.outbox where user_id = u) = 2, 'old sent and failed messages deleted';
  assert exists (select 1 from app.outbox where user_id = u and template = 'hk_old_pending'), 'pending kept';
  assert exists (select 1 from app.outbox where user_id = u and template = 'hk_new_sent'), 'recent kept';
  assert not exists (select 1 from app.sessions where id = s_old), 'old session deleted';
  assert exists (select 1 from app.sessions where id = s_new), 'live session kept';
  assert (select count(*) from app.link_requests where session_id = s_new) = 1, 'expired link request deleted';
  assert not exists (select 1 from app.alert_state where key = 'hk:old'), 'old alert state deleted';
  assert exists (select 1 from app.alert_state where key = 'hk:new'), 'recent alert state kept';
  assert not exists (select 1 from app.rate_limits where key = 'hk:old'), 'old throttle window deleted';
  assert exists (select 1 from app.rate_limits where key = 'hk:new'), 'current throttle window kept';
  raise notice 'housekeeping tests: all assertions passed';
end $$;

rollback;
