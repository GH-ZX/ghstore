-- Account linking, hardened after review:
--
-- 1. A link must be started from the account itself: app.link_requests holds a
--    one-time, 10-minute token per session (only its SHA-256), which the link
--    call must present. A crafted link that carries someone else's signed
--    Telegram login or Supabase token can no longer attach it to a victim who
--    merely opens the page.
-- 2. A blocked account is never merged in either direction (link_identity
--    raises 'user_blocked'), and only an active account counts as unused.
create table if not exists app.link_requests (
  session_id uuid not null references app.sessions (id) on delete cascade,
  provider text not null check (provider in ('telegram', 'supabase')),
  token_hash text not null check (token_hash ~ '^[0-9a-f]{64}$'),
  expires_at timestamptz not null,
  primary key (session_id, provider)
);

alter table app.link_requests enable row level security;
create policy store_server_all on app.link_requests for all to store_server using (true) with check (true);
grant select, insert, update, delete on app.link_requests to store_server;

create or replace function app.account_is_unused(p_user uuid) returns boolean
language sql stable security definer set search_path = app, pg_temp
as $$
  select exists (select 1 from app.users u where u.id = p_user and u.role = 'customer' and u.status = 'active')
     and not exists (select 1 from app.ledger where user_id = p_user)
     and not exists (select 1 from app.orders where user_id = p_user)
     and not exists (select 1 from app.payments where user_id = p_user)
     and coalesce((select balance_cents from app.wallets where user_id = p_user), 0) = 0
$$;

create or replace function app.link_identity(
  p_user uuid, p_provider text, p_subject text, p_username text, p_email text
) returns table (user_id uuid, merged boolean)
language plpgsql security definer set search_path = app, pg_temp
as $$
declare
  v_other uuid;
  v_keep uuid;
  v_drop uuid;
begin
  if p_provider = 'telegram' then
    if p_subject !~ '^[0-9]{1,20}$' then raise exception 'invalid_input'; end if;
  elsif p_provider = 'supabase' then
    if p_subject !~ '^[0-9a-f-]{36}$' then raise exception 'invalid_input'; end if;
  else
    raise exception 'invalid_input';
  end if;
  -- One link at a time per login, so two taps cannot both move it.
  perform pg_advisory_xact_lock(hashtext('app.link_identity:' || p_provider || ':' || p_subject));

  if not exists (select 1 from app.users u where u.id = p_user and u.status = 'active') then
    raise exception 'user_blocked';
  end if;

  select i.user_id into v_other from app.identities i where i.provider = p_provider and i.subject = p_subject;
  if v_other = p_user then
    return query select p_user, false;
    return;
  end if;

  if v_other is null then
    if exists (select 1 from app.identities i where i.user_id = p_user and i.provider = p_provider) then
      raise exception 'already_linked';
    end if;
    insert into app.identities (user_id, provider, subject, username, email)
    values (p_user, p_provider, p_subject, p_username, p_email);
    insert into app.audit_log (actor_user_id, action, target_type, target_id, data)
    values (p_user, 'user.link', 'user', p_user::text, jsonb_build_object('provider', p_provider));
    return query select p_user, false;
    return;
  end if;

  -- A blocked account's logins stay blocked: never move them, never absorb them.
  if not exists (select 1 from app.users u where u.id = v_other and u.status = 'active') then
    raise exception 'user_blocked';
  end if;

  -- The login belongs to another account: keep the one that has been used.
  if app.account_is_unused(v_other) then
    v_keep := p_user; v_drop := v_other;
  elsif app.account_is_unused(p_user) then
    v_keep := v_other; v_drop := p_user;
  else
    raise exception 'account_in_use';
  end if;

  -- The kept account must not end up with two logins of the same kind.
  if exists (
    select 1 from app.identities d join app.identities k on k.provider = d.provider and k.user_id = v_keep
     where d.user_id = v_drop
  ) then
    raise exception 'already_linked';
  end if;

  update app.identities set user_id = v_keep where identities.user_id = v_drop;
  update app.users set sessions_revoked_at = now(), updated_at = now() where id = v_drop;
  update app.users k set display_name = d.display_name
    from app.users d where k.id = v_keep and d.id = v_drop and k.display_name = '' and d.display_name <> '';
  insert into app.audit_log (actor_user_id, action, target_type, target_id, data)
  values (p_user, 'user.merge', 'user', v_keep::text, jsonb_build_object('provider', p_provider, 'from', v_drop));
  return query select v_keep, true;
end $$;

