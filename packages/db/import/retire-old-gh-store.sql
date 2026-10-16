-- Retire the old GH Store setup (gh-store-dev site, gh-store-tele bot) in the
-- gh-store Supabase project, once the new store is live. Run once in
-- Supabase → SQL editor as the postgres user. Safe to run again.
--
-- What it does, in one transaction:
--   1. Supabase Auth stops writing new sign-ups into the old site's profiles
--      table (the new store keeps its own users in app.users).
--   2. The old admin's upload rules on the product-images bucket go; anyone can
--      still read the images, as before.
--   3. The old settings tables, which held API keys in plain text, are dropped.
--      Rotate those keys at each provider as well.
--   4. Every other old table and function moves from `public` to a private
--      `legacy` schema that the Data API cannot reach: kept for reference
--      (old orders, customers, balances), out of the way.
-- The new store's `app` schema is not touched.
begin;

drop trigger if exists on_auth_user_created on auth.users;

drop policy if exists product_images_admin_delete on storage.objects;
drop policy if exists product_images_admin_insert on storage.objects;
drop policy if exists product_images_admin_update on storage.objects;

drop table if exists public.store_settings;
drop table if exists public.store_posthog_settings;

create schema if not exists legacy;
revoke all on schema legacy from public;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on schema legacy from anon, authenticated';
  end if;
end $$;

do $$
declare
  r record;
begin
  -- Tables (with their indexes, constraints, policies, triggers and owned sequences).
  for r in
    select c.relname
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      left join pg_depend d on d.objid = c.oid and d.deptype = 'e'
     where n.nspname = 'public' and c.relkind in ('r', 'p') and d.objid is null
  loop
    execute format('alter table public.%I set schema legacy', r.relname);
  end loop;
  -- Views and sequences that no table owns.
  for r in
    select c.relname, c.relkind
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      left join pg_depend d on d.objid = c.oid and d.deptype = 'e'
     where n.nspname = 'public' and c.relkind in ('v', 'm', 'S') and d.objid is null
  loop
    execute format(
      case r.relkind when 'v' then 'alter view public.%I set schema legacy'
                     when 'm' then 'alter materialized view public.%I set schema legacy'
                     else 'alter sequence public.%I set schema legacy' end,
      r.relname);
  end loop;
  -- Functions (extensions' own functions stay where they are).
  for r in
    select p.oid::regprocedure as sig
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
      left join pg_depend d on d.objid = p.oid and d.deptype = 'e'
     where n.nspname = 'public' and d.objid is null
  loop
    execute format('alter routine %s set schema legacy', r.sig);
  end loop;
end $$;

commit;

-- Check: nothing of the old setup is left in public (expect 0 and 0).
select
  (select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace
     left join pg_depend d on d.objid = c.oid and d.deptype = 'e'
    where n.nspname = 'public' and c.relkind in ('r', 'p', 'v', 'm') and d.objid is null) as tables_left,
  (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     left join pg_depend d on d.objid = p.oid and d.deptype = 'e'
    where n.nspname = 'public' and d.objid is null) as functions_left;
