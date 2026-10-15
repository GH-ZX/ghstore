-- "Buy again" reminders for things that run out (a 1-month subscription, a
-- weekly pass...). The owner sets remind_after_days on a package; when an order
-- of it is delivered, the order gets a remind_at time. The scheduled job sends
-- one Telegram message when it comes, unless the customer already bought the
-- product again, turned notifications off, or the package is no longer on sale.

alter table app.offers
  add column remind_after_days int check (remind_after_days between 1 and 365);

alter table app.orders
  add column remind_at timestamptz;
create index orders_remind_idx on app.orders (remind_at) where remind_at is not null;

create or replace function app.set_remind_at() returns trigger
language plpgsql set search_path = app, pg_temp
as $$
declare v_days int;
begin
  if new.status = 'delivered' and old.status is distinct from 'delivered' then
    select f.remind_after_days into v_days from app.offers f where f.id = new.offer_id;
    if v_days is not null then
      new.remind_at := coalesce(new.delivered_at, now()) + make_interval(days => v_days);
    end if;
  elsif new.status = 'refunded' then
    new.remind_at := null;
  end if;
  return new;
end $$;
create trigger orders_remind_at before update of status on app.orders
  for each row execute function app.set_remind_at();

-- Queue the reminders that are due (at most p_limit) and clear them. Returns how many were queued.
create or replace function app.queue_buy_again(p_limit int) returns int
language plpgsql security definer set search_path = app, pg_temp
as $$
declare v_count int;
begin
  with due as (
    select o.id from app.orders o
     where o.remind_at <= now()
     order by o.remind_at
     limit greatest(1, least(p_limit, 200))
     for update skip locked
  ), cleared as (
    update app.orders o set remind_at = null from due where o.id = due.id
    returning o.id, o.user_id, o.product_id, o.offer_id, o.number
  ), queued as (
    insert into app.outbox (user_id, template, data)
    select c.user_id, 'buy_again',
           jsonb_build_object('slug', p.slug, 'name_ar', p.name_ar, 'name_en', p.name_en,
                              'offer_ar', f.name_ar, 'offer_en', f.name_en)
      from cleared c
      join app.products p on p.id = c.product_id
      join app.offers f on f.id = c.offer_id
      join app.users u on u.id = c.user_id
     where p.active and f.active and f.paused_reason is null and u.status = 'active' and u.notify
       and not exists (
         select 1 from app.orders n
          where n.user_id = c.user_id and n.product_id = c.product_id
            and n.number > c.number and n.status <> 'refunded')
    returning 1
  )
  select count(*) into v_count from queued;
  return v_count;
end $$;

revoke all on function app.queue_buy_again(int) from public;
grant execute on function app.queue_buy_again(int) to store_server;
