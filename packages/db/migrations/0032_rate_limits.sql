-- Throttles, and a cap on open USDT requests per customer.
--
-- rate_limits: one counter per key and fixed time window ("login:ip:1.2.3.4",
--   "coupon:<user id>" ...). app.rate_limit_hit counts a request and says
--   whether it is still within the limit. Windows that are over are deleted
--   by the same function now and then (about one call in fifty, a bounded
--   batch), so the table stays small without a job.
--
-- USDT (BEP20) requests: each open request holds one of 100 amount tags for its
--   dollar amount (0024), so a handful of accounts could hold every tag for,
--   say, $10. A customer may have at most 2 USDT requests waiting at a time
--   (created or pending; one in review waits for staff and is not counted).
--   The trigger reports the refusal as a unique violation with the message
--   'rate_limited': createTopup already treats a unique violation on a USDT
--   insert as "this tag is taken, try another" and answers 429 rate_limited
--   when no attempt succeeds, so no code change is needed for it.
create table if not exists app.rate_limits (
  key text not null check (length(key) between 1 and 200),
  window_start timestamptz not null,
  expires_at timestamptz not null,
  count integer not null default 1,
  primary key (key, window_start)
);
create index if not exists rate_limits_expires_idx on app.rate_limits (expires_at);
alter table app.rate_limits enable row level security;
-- No grants: the Worker reaches it only through app.rate_limit_hit.

create or replace function app.rate_limit_hit(p_key text, p_max integer, p_window_seconds integer)
returns boolean
language plpgsql security definer set search_path = app, pg_temp
as $$
declare
  v_start timestamptz;
  v_count integer;
begin
  if p_key is null or length(p_key) not between 1 and 200 or p_max is null or p_max < 1
     or p_window_seconds is null or p_window_seconds not between 1 and 86400 then
    raise exception 'invalid_input';
  end if;
  v_start := to_timestamp(floor(extract(epoch from now()) / p_window_seconds) * p_window_seconds);
  insert into app.rate_limits as r (key, window_start, expires_at, count)
    values (p_key, v_start, v_start + make_interval(secs => p_window_seconds), 1)
  on conflict (key, window_start) do update set count = least(r.count + 1, 1000000000)
  returning r.count into v_count;
  -- Housekeeping: now and then, drop a bounded batch of windows that are over.
  if random() < 0.02 then
    delete from app.rate_limits
     where (key, window_start) in (select key, window_start from app.rate_limits where expires_at < now() limit 500);
  end if;
  return v_count <= p_max;
end
$$;

revoke all on function app.rate_limit_hit(text, integer, integer) from public;
grant execute on function app.rate_limit_hit(text, integer, integer) to store_server;

create or replace function app.payments_usdt_open_cap()
returns trigger
language plpgsql security definer set search_path = app, pg_temp
as $$
begin
  if new.method = 'bep20' and new.status in ('created', 'pending') then
    -- One customer's requests are counted one at a time.
    perform pg_advisory_xact_lock(hashtextextended('usdt-open:' || new.user_id::text, 0));
    if (select count(*) from app.payments
         where user_id = new.user_id and method = 'bep20' and status in ('created', 'pending')) >= 2 then
      raise exception 'rate_limited' using errcode = 'unique_violation', detail = 'open USDT requests per customer';
    end if;
  end if;
  return new;
end
$$;

revoke all on function app.payments_usdt_open_cap() from public;

drop trigger if exists payments_usdt_open_cap on app.payments;
create trigger payments_usdt_open_cap before insert on app.payments
  for each row when (new.method = 'bep20') execute function app.payments_usdt_open_cap();
