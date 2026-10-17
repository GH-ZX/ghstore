-- Fixes for orders and money found in the audit.
--
-- orders.lease_until: one caller at a time talks to the supplier about an
-- order (fulfilOrder takes this lease right before asking the supplier; the
-- scheduled job, the order page, webhooks and the admin all go through it).
-- An expired lease (a run that died) frees the order again.
--
-- orders.fail_streak: failures in a row, apart from orders.attempts (which also
-- counts pending checks). Only failures in a row lead to a refund, and never
-- for an order the supplier already accepted (it may still deliver).
--
-- Manual USDT: a pasted transaction hash no longer reserves the transfer.
-- Only a top-up that was credited keeps its hash to itself (unique among paid
-- top-ups), so pasting another customer's public hash blocks nobody.
--
-- app.credit_payment with a staff member: support may credit only a top-up
-- under review, for no more than was asked, and never their own; the owner
-- keeps full ability.
--
-- Invite rewards and cashback: nothing is paid on an order whose cost is
-- unknown (its margin can't be checked).

alter table app.orders
  add column if not exists lease_until timestamptz,
  add column if not exists fail_streak int not null default 0 check (fail_streak >= 0);
grant update (lease_until, fail_streak) on app.orders to store_server;

-- ───────────────────────────────────────────────────────────── orders

-- Hand out orders due for a check, skipping any another run holds. Each one
-- is leased for p_lease_seconds.
create or replace function app.claim_due_orders(p_limit int, p_lease_seconds int)
returns setof app.orders
language plpgsql security definer set search_path = app, pg_temp
as $$
begin
  return query
  update app.orders o set lease_until = date_trunc('milliseconds', now()) + make_interval(secs => p_lease_seconds)
  where o.id in (
    select d.id from app.orders d
    where d.status in ('paid', 'processing') and d.hold is null and d.next_check_at <= now()
      and (d.lease_until is null or d.lease_until <= now())
    order by d.next_check_at
    limit greatest(1, least(p_limit, 100))
    for update skip locked
  )
  returning o.*;
end $$;

-- ───────────────────────────────────────────────────────────── payments

alter table app.payments drop constraint if exists payments_tx_hash_key;
create unique index if not exists payments_tx_hash_paid_idx on app.payments (tx_hash)
  where status = 'paid' and tx_hash is not null;
create index if not exists payments_tx_hash_idx on app.payments (tx_hash) where tx_hash is not null;

-- Credit a confirmed payment to the wallet, exactly once.
-- p_amount_cents is what was actually received (may differ from what was asked).
-- p_actor: the staff member crediting it by hand (null = a provider confirmed it).
create or replace function app.credit_payment(
  p_payment uuid, p_amount_cents bigint, p_provider_ref text default null, p_tx_hash text default null,
  p_actor uuid default null
) returns table (credited boolean, balance_cents bigint)
language plpgsql security definer set search_path = app, pg_temp
as $$
declare
  v_payment app.payments;
  v_balance bigint;
  v_role text;
  v_hash text;
begin
  if p_amount_cents is null or p_amount_cents <= 0 then raise exception 'invalid_input' using detail = 'amount must be positive'; end if;
  select p.* into v_payment from app.payments p where p.id = p_payment;
  if not found then raise exception 'payment_not_found'; end if;
  if p_actor is not null then
    select u.role into v_role from app.users u where u.id = p_actor and u.status = 'active';
    if v_role is null or v_role not in ('owner', 'support') then raise exception 'not_allowed' using detail = 'only staff credit by hand'; end if;
  end if;
  perform 1 from app.wallets w where w.user_id = v_payment.user_id for update;
  select p.* into v_payment from app.payments p where p.id = p_payment for update;

  if v_payment.status = 'paid' then
    return query select false, (select w.balance_cents from app.wallets w where w.user_id = v_payment.user_id);
    return;
  end if;
  if v_role = 'support' then
    if v_payment.status not in ('review', 'partial') then
      raise exception 'not_allowed' using detail = 'support credits only top-ups under review';
    end if;
    if p_amount_cents > v_payment.amount_cents then
      raise exception 'not_allowed' using detail = 'support credits at most what was asked';
    end if;
    if v_payment.user_id = p_actor then
      raise exception 'not_allowed' using detail = 'nobody credits their own top-up';
    end if;
  end if;
  if v_payment.status in ('rejected', 'expired') and p_actor is null then
    raise exception 'bad_state' using detail = 'closed payments are credited only by staff';
  end if;
  -- The transfer this credit is for: the verified one passed in, or (crediting
  -- by hand) the hash the customer pasted, which nobody has checked.
  v_hash := lower(coalesce(p_tx_hash, v_payment.tx_hash));
  if v_hash is not null then
    -- One credit per transfer, also between two requests credited at the same moment.
    perform pg_advisory_xact_lock(hashtext('tx:' || v_hash));
    if exists (select 1 from app.payments p where p.tx_hash = v_hash and p.id <> p_payment and p.status = 'paid') then
      raise exception 'tx_reused';
    end if;
    -- A pasted hash another open request also claims (a customer may paste
    -- someone else's public transfer): support can't pick the winner, only the owner.
    if p_tx_hash is null and v_role = 'support' and exists (
      select 1 from app.payments p where p.tx_hash = v_hash and p.id <> p_payment and p.status not in ('paid', 'rejected', 'expired')
    ) then
      raise exception 'not_allowed' using detail = 'another top-up claims the same transfer';
    end if;
  end if;

  update app.wallets w set balance_cents = w.balance_cents + p_amount_cents, updated_at = now()
    where w.user_id = v_payment.user_id returning w.balance_cents into v_balance;
  insert into app.ledger (user_id, amount_cents, kind, ref_type, ref_id, balance_after_cents, actor_user_id)
  values (v_payment.user_id, p_amount_cents, 'topup', 'payment', v_payment.id, v_balance, p_actor);
  update app.payments set
    status = 'paid', credited_cents = p_amount_cents, paid_at = now(), reviewed_by = coalesce(p_actor, reviewed_by),
    provider_ref = coalesce(p_provider_ref, provider_ref), tx_hash = v_hash
  where id = v_payment.id;
  insert into app.outbox (user_id, template, data)
  values (v_payment.user_id, 'payment_credited', jsonb_build_object('payment_id', v_payment.id, 'amount_cents', p_amount_cents, 'method', v_payment.method));
  return query select true, v_balance;
end $$;

-- Attach a customer-submitted transaction hash to a manual payment (BEP20), to
-- be checked on chain. Refused only for a hash already credited to a top-up:
-- an unchecked hash reserves nothing (it may be someone else's public one).
create or replace function app.submit_tx_hash(p_payment uuid, p_user uuid, p_tx_hash text)
returns void
language plpgsql security definer set search_path = app, pg_temp
as $$
declare v_hash text := lower(trim(p_tx_hash));
begin
  if v_hash !~ '^0x[0-9a-f]{64}$' then raise exception 'invalid_input' using detail = 'not a transaction hash'; end if;
  if exists (select 1 from app.payments p where p.tx_hash = v_hash and p.status = 'paid' and p.id <> p_payment) then
    raise exception 'tx_reused';
  end if;
  update app.payments set tx_hash = v_hash, status = 'review',
         -- A new hash after one that did not match is checked afresh.
         note = case when note = 'transfer did not match' then null else note end
    where id = p_payment and user_id = p_user and method = 'bep20' and status in ('created', 'pending', 'review');
  if not found then raise exception 'bad_state'; end if;
end $$;

-- ───────────────────────────────────────────────────────────── rewards

-- Pay the inviter when an invited customer's order is delivered (not when its cost is unknown).
create or replace function app.pay_referral_reward() returns trigger
language plpgsql security definer set search_path = app, pg_temp
as $$
declare
  v_referrer uuid;
  v_joined timestamptz;
  v_pct numeric;
  v_days int;
  v_paid bigint;
  v_amount bigint;
  v_balance bigint;
begin
  if new.status <> 'delivered' or old.status = 'delivered' then return null; end if;
  -- No known cost, no known margin: nothing is paid.
  if new.cost_cents is null then return null; end if;
  select u.referred_by, u.referred_at into v_referrer, v_joined from app.users u where u.id = new.user_id;
  if v_referrer is null then return null; end if;
  if (select value from app.settings where key = 'referral.enabled') is distinct from 'true'::jsonb then return null; end if;
  v_pct := least(coalesce((select (value #>> '{}')::numeric from app.settings where key = 'referral.percent'), 0), 20);
  v_days := coalesce((select (value #>> '{}')::int from app.settings where key = 'referral.days'), 0);
  if v_pct <= 0 then return null; end if;
  if v_days > 0 and new.created_at > v_joined + make_interval(days => v_days) then return null; end if;
  -- What the customer was actually charged, from the ledger (not from the order row).
  select -l.amount_cents into v_paid from app.ledger l
   where l.kind = 'purchase' and l.ref_type = 'order' and l.ref_id = new.id and l.user_id = new.user_id;
  if v_paid is null or v_paid <= 0 then return null; end if;
  v_amount := floor(v_paid * v_pct / 100);
  -- Never more than the margin, so a coupon plus a reward can't sell below cost.
  v_amount := least(v_amount, v_paid - new.cost_cents);
  if v_amount < 1 then return null; end if;
  if exists (select 1 from app.ledger l where l.kind = 'referral' and l.ref_type = 'order' and l.ref_id = new.id) then return null; end if;

  update app.wallets w set balance_cents = w.balance_cents + v_amount, updated_at = now()
    where w.user_id = v_referrer and exists (select 1 from app.users u where u.id = v_referrer and u.status = 'active')
    returning w.balance_cents into v_balance;
  if not found then return null; end if;
  insert into app.ledger (user_id, amount_cents, kind, ref_type, ref_id, balance_after_cents)
  values (v_referrer, v_amount, 'referral', 'order', new.id, v_balance);
  insert into app.outbox (user_id, template, data)
  values (v_referrer, 'referral_reward', jsonb_build_object('amount_cents', v_amount));
  return null;
end $$;

-- Cashback when an order is delivered (none when its cost is unknown; the level-up message still goes).
create or replace function app.pay_cashback() returns trigger
language plpgsql security definer set search_path = app, pg_temp
as $$
declare
  v_paid bigint;
  v_before bigint;
  v_lb int; v_pb numeric;
  v_la int; v_pa numeric;
  v_referral bigint;
  v_amount bigint;
  v_balance bigint;
begin
  if new.status <> 'delivered' or old.status = 'delivered' then return null; end if;
  if (select value from app.settings where key = 'loyalty.enabled') is distinct from 'true'::jsonb then return null; end if;
  -- What the customer was charged from the wallet (in-person sales have none).
  select -l.amount_cents into v_paid from app.ledger l
   where l.kind = 'purchase' and l.ref_type = 'order' and l.ref_id = new.id and l.user_id = new.user_id;
  if v_paid is null or v_paid <= 0 then return null; end if;
  v_before := app.loyalty_spent(new.user_id, new.id);
  select level, percent into v_lb, v_pb from app.loyalty_level(v_before);
  select level, percent into v_la, v_pa from app.loyalty_level(v_before + v_paid);
  if v_la > v_lb then
    insert into app.outbox (user_id, template, data)
    values (new.user_id, 'level_up', jsonb_build_object('level', v_la, 'percent', v_pa));
  end if;
  if v_pa <= 0 then return null; end if;
  -- No known cost, no known margin: no cashback.
  if new.cost_cents is null then return null; end if;
  if exists (select 1 from app.ledger l where l.kind = 'cashback' and l.ref_type = 'order' and l.ref_id = new.id) then return null; end if;
  select coalesce(sum(l.amount_cents), 0) into v_referral from app.ledger l where l.kind = 'referral' and l.ref_type = 'order' and l.ref_id = new.id;
  v_amount := floor(v_paid * v_pa / 100);
  -- Never more than the margin left after an invite reward: no sale below cost.
  v_amount := least(v_amount, v_paid - new.cost_cents - v_referral);
  if v_amount < 1 then return null; end if;
  update app.wallets w set balance_cents = w.balance_cents + v_amount, updated_at = now()
    where w.user_id = new.user_id returning w.balance_cents into v_balance;
  if not found then return null; end if;
  insert into app.ledger (user_id, amount_cents, kind, ref_type, ref_id, balance_after_cents)
  values (new.user_id, v_amount, 'cashback', 'order', new.id, v_balance);
  return null;
end $$;

-- ───────────────────────────────────────────────────────────── grants

revoke all on function
  app.claim_due_orders(int, int),
  app.credit_payment(uuid, bigint, text, text, uuid),
  app.submit_tx_hash(uuid, uuid, text),
  app.pay_referral_reward(),
  app.pay_cashback()
from public;

grant execute on function
  app.claim_due_orders(int, int),
  app.credit_payment(uuid, bigint, text, text, uuid),
  app.submit_tx_hash(uuid, uuid, text)
to store_server;
