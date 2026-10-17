-- Reliability: supplier sync backoff and leases, job "started but never
-- finished" tracking, nightly housekeeping, a statement timeout for the
-- Worker's login, and the indexes the scheduled jobs and the catalogue need.
-- Additive only.
--
-- suppliers.sync_*: the price check's own state, kept apart from the balance
--   check's health/last_error (one no longer clears the other's 'degraded'
--   before the health watch sees it). sync_retry_at/sync_failures back a
--   failing supplier off (2, 4, 8 … 60 minutes) instead of retrying every
--   minute; sync_lease_until stops two overlapping cron runs from checking
--   the same supplier at once.
-- supplier_sync_groups: a group of a big catalogue (a G2Bulk game, a 5SIM
--   service) whose price check failed, backed off the same way, so one broken
--   group never blocks the rest of the supplier.
-- job_heartbeats.unfinished: runs started since the job last finished (well or
--   with an error). A job cut off every time (too slow, over a limit) keeps
--   counting up; the health watch tells the owner.
-- app.housekeep(): deletes old rows in bounded batches (sent messages, expired
--   sessions, old price changes...). Never money, orders or the audit log.

-- ───────────────────────────────────────────────────────────── supplier sync

alter table app.suppliers
  add column if not exists sync_health text not null default 'unknown',
  add column if not exists sync_error text,
  add column if not exists sync_failures int not null default 0,
  add column if not exists sync_retry_at timestamptz,
  add column if not exists sync_lease_until timestamptz;

do $$ begin
  alter table app.suppliers add constraint suppliers_sync_health_check check (sync_health in ('unknown', 'ok', 'degraded', 'down'));
exception when duplicate_object then null;
end $$;

create table if not exists app.supplier_sync_groups (
  supplier_id text not null references app.suppliers (id) on delete cascade,
  group_id text not null check (length(group_id) <= 200),
  failures int not null default 0,
  retry_at timestamptz not null default now(),
  last_error text,
  updated_at timestamptz not null default now(),
  primary key (supplier_id, group_id)
);
alter table app.supplier_sync_groups enable row level security;
do $$ begin
  create policy store_server_all on app.supplier_sync_groups for all to store_server using (true) with check (true);
exception when duplicate_object then null;
end $$;
grant select, insert, update, delete on app.supplier_sync_groups to store_server;

-- ───────────────────────────────────────────────────────────── jobs

alter table app.job_heartbeats add column if not exists unfinished int not null default 0;

-- ───────────────────────────────────────────────────────────── indexes

-- Housekeeping and the channel's price-drop posts read price changes by date.
create index if not exists price_changes_at_idx on app.price_changes (at);
-- Review requests: delivered orders not asked yet.
create index if not exists orders_review_ask_idx on app.orders (delivered_at) where status = 'delivered' and review_asked_at is null;
-- Automatic "Best seller" badges: delivered orders of the last 30 days, per product.
create index if not exists orders_delivered_recent_idx on app.orders (created_at, product_id) where status = 'delivered';
-- The health watch's "many top-ups in an hour" (all customers).
create index if not exists payments_created_idx on app.payments (created_at);
-- Payment re-checks: closed top-ups of the last two days (late payments are still credited).
create index if not exists payments_expired_recent_idx on app.payments (created_at) where status = 'expired';
-- Housekeeping: messages already sent or given up on, and old sessions.
create index if not exists outbox_done_idx on app.outbox (created_at) where status in ('sent', 'failed');
create index if not exists sessions_expires_idx on app.sessions (expires_at);

-- ───────────────────────────────────────────────────────────── housekeeping

-- Delete at most p_batch rows from each table per call; call again while it
-- reports deletions. Returns the counts, e.g. {"outbox": 500, "sessions": 12}.
create or replace function app.housekeep(p_batch int default 500) returns jsonb
language plpgsql security definer set search_path = app, pg_temp
as $$
declare
  v_batch int := least(greatest(coalesce(p_batch, 500), 1), 5000);
  v_out jsonb := '{}';
  v_n int;
begin
  -- Messages sent, skipped or given up on a month ago. A broadcast's messages
  -- are its delivery counts (Admin → Broadcasts): kept half a year.
  delete from app.outbox where id in (
    select id from app.outbox
     where status in ('sent', 'failed') and created_at < now() - interval '30 days'
       and (broadcast_id is null or created_at < now() - interval '180 days')
     limit v_batch);
  get diagnostics v_n = row_count; v_out := v_out || jsonb_build_object('outbox', v_n);

  -- Sessions that ended (expired or signed out) a week ago; their link requests go with them.
  delete from app.sessions where id in (
    select id from app.sessions
     where expires_at < now() - interval '7 days' or revoked_at < now() - interval '7 days'
     limit v_batch);
  get diagnostics v_n = row_count; v_out := v_out || jsonb_build_object('sessions', v_n);

  -- Account-link requests are one-time and short-lived: once expired they are useless.
  delete from app.link_requests where ctid = any(array(
    select ctid from app.link_requests where expires_at < now() limit v_batch));
  get diagnostics v_n = row_count; v_out := v_out || jsonb_build_object('link_requests', v_n);

  delete from app.price_changes where id in (
    select id from app.price_changes where at < now() - interval '180 days' limit v_batch);
  get diagnostics v_n = row_count; v_out := v_out || jsonb_build_object('price_changes', v_n);

  delete from app.channel_posts where id in (
    select id from app.channel_posts where status in ('sent', 'skipped') and created_at < now() - interval '90 days' limit v_batch);
  get diagnostics v_n = row_count; v_out := v_out || jsonb_build_object('channel_posts', v_n);

  delete from app.alert_state where key in (
    select key from app.alert_state where alerted_at < now() - interval '30 days' limit v_batch);
  get diagnostics v_n = row_count; v_out := v_out || jsonb_build_object('alert_state', v_n);

  -- Throttle counters (0032), when that table exists.
  if to_regclass('app.rate_limits') is not null then
    begin
      execute 'delete from app.rate_limits where ctid = any(array(
                 select ctid from app.rate_limits where expires_at < now() - interval ''1 day'' limit $1))' using v_batch;
      get diagnostics v_n = row_count; v_out := v_out || jsonb_build_object('rate_limits', v_n);
    exception when undefined_column then null;
    end;
  end if;
  return v_out;
end $$;

revoke all on function app.housekeep(int) from public;
grant execute on function app.housekeep(int) to store_server;

-- ───────────────────────────────────────────────────────────── statement timeout

-- A runaway query must not hold a connection for minutes: the Worker's login
-- (docs/launch-a-store.md) gets a 30 s limit. Skipped where the role does not
-- exist (tests, a new store before its setup) or may not be changed.
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'store_app') then
    execute 'alter role store_app set statement_timeout = ''30s''';
  end if;
exception when insufficient_privilege then
  raise notice 'store_app statement_timeout not set: %', sqlerrm;
end $$;
