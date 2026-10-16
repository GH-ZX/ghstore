-- Link a website login (email or Google, through Supabase Auth) and a Telegram
-- account to one customer, so the website, the bot and the Mini App share one
-- wallet and one order history.
--
-- app.link_identity(user, provider, subject, ...) attaches a verified identity
-- to the signed-in user. When that identity already belongs to another account:
--   * if one of the two accounts has never been used (no money moved, no orders,
--     no top-ups, plain customer), its logins move to the other account and the
--     unused one is left empty and signed out;
--   * otherwise nothing changes ('account_in_use'): two wallets with history are
--     never merged automatically.
-- A customer keeps at most one login per provider ('already_linked').
--
-- Website sign-in switches (Admin → Settings): email codes on, Google off until
-- the owner sets up Google in Supabase Auth.
insert into app.settings (key, value) values ('login.email', 'true'), ('login.google', 'false')
on conflict (key) do nothing;

create or replace function app.account_is_unused(p_user uuid) returns boolean
language sql stable security definer set search_path = app, pg_temp
as $$
  select exists (select 1 from app.users u where u.id = p_user and u.role = 'customer')
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

revoke all on function app.account_is_unused(uuid) from public;
revoke all on function app.link_identity(uuid, text, text, text, text) from public;
grant execute on function app.account_is_unused(uuid) to store_server;
grant execute on function app.link_identity(uuid, text, text, text, text) to store_server;
