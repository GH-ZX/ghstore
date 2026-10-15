-- Copy the catalogue of the old gh-store site (public.categories, products,
-- offers and their supplier mappings) into the new store (app.*).
--
-- Run ONCE, after the migrations, on the same Supabase project (the old tables
-- live in `public`, the new ones in `app`), as the `postgres` user:
--
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f packages/db/import/from-old-gh-store.sql
--   (or paste it into Supabase → SQL Editor and run it)
--
-- Safe to re-run: products are matched by slug and packages by supplier item,
-- so nothing is copied twice. Nothing in `public` is changed.
--
-- What it does:
-- - Categories: same slugs (recharge-balance → recharge); missing ones are created.
-- - Products: names, descriptions, image (https only), search words, on/off,
--   featured and order. Delivery type: player/server fields → "id"; account
--   activation or account delivery → "account"; otherwise "code".
-- - Packages: each keeps its single supplier (batstore, g2bulk, maxstore), the
--   supplier item id in the new format, today's price, the cost (rounded UP to the
--   cent, so margins are never overstated) and a percent markup equal to today's,
--   so the hourly sync keeps prices in step with supplier costs. Customer fields
--   come from the package or the game, with supplier field names kept exactly and
--   server lists as choices.
-- - Support contacts: the support Telegram, WhatsApp and email the old site
--   published (only where Admin → Settings has none yet).
-- - Not copied: customers, balances, orders (settled by hand, decided), coupons,
--   reviews, stock (none), Telegram links.

begin;

-- ───────────────────────────────────────────────────────────── categories

create temp table _cat_map on commit drop as
select c.id as old_id,
       case c.slug when 'recharge-balance' then 'recharge' else c.slug end as slug,
       left(c.name_ar, 40) as name_ar, left(c.name_en, 40) as name_en, 1000 + coalesce(c.sort_order, 0) as sort  -- new ones go last
  from public.categories c
 where c.slug ~ '^[a-z0-9-]{1,48}$';

insert into app.categories (slug, name_ar, name_en, sort, active)
select slug, name_ar, name_en, sort, true from _cat_map
on conflict (slug) do nothing;

-- ───────────────────────────────────────────────────────────── customer fields

-- Old field rows → new InputField JSON.
create or replace function pg_temp.field_json(p_key text, p_type text, p_label_en text, p_label_ar text, p_required boolean, p_options jsonb, p_canonical boolean)
returns jsonb language sql immutable as $$
  select jsonb_strip_nulls(jsonb_build_object(
    'key', case when p_canonical and lower(p_key) in ('userid', 'user_id', 'uid', 'playerid', 'player_id') then 'player_id'
                when p_canonical and lower(p_key) in ('serverid', 'server_id', 'server', 'zoneid', 'zone_id') then 'server_id'
                else p_key end,
    'labelEn', left(coalesce(nullif(p_label_en, ''), p_key), 60),
    'labelAr', left(nullif(p_label_ar, ''), 60),
    'required', coalesce(p_required, true),
    'pattern', case when p_type = 'number' then '^[0-9]+$' end,
    'options', case when jsonb_typeof(p_options) = 'array' and jsonb_array_length(p_options) between 1 and 50 then (
      select jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
               'value', btrim(coalesce(o->>'value', o#>>'{}')),
               'labelEn', left(coalesce(o->>'label_en', o->>'label'), 60),
               'labelAr', left(coalesce(o->>'label_ar', o->>'label'), 60))))
        from jsonb_array_elements(p_options) o
       where nullif(btrim(coalesce(o->>'value', o#>>'{}')), '') is not null) end))
$$;

-- Fields per old product (game_input_fields). G2Bulk gets the canonical keys
-- (player_id, server_id); other suppliers read their own field names back, so
-- theirs stay exactly as they are.
create temp table _game_fields on commit drop as
select f.game_id as product_id,
       jsonb_agg(pg_temp.field_json(f.field_key, f.field_type, f.label_en, f.label_ar, f.is_required, f.options, true)
                 order by f.sort_order, f.field_key) as fields_g2bulk,
       jsonb_agg(pg_temp.field_json(f.field_key, f.field_type, f.label_en, f.label_ar, f.is_required, f.options, false)
                 order by f.sort_order, f.field_key) as fields_raw,
       bool_or(lower(f.field_key) in ('userid', 'user_id', 'uid', 'playerid', 'player_id', 'serverid', 'server_id', 'zoneid', 'zone_id')) as player
  from public.game_input_fields f
 group by f.game_id;

-- ───────────────────────────────────────────────────────────── products

insert into app.products (slug, category_id, name_ar, name_en, description_ar, description_en, search_terms,
                          image_url, kind, active, featured, sort)
select p.slug, ac.id, left(p.name_ar, 120), left(p.name_en, 120),
       -- Clamped to what the admin editor accepts, so saving a product later never fails.
       left(coalesce(p.description_ar, ''), 4000), left(coalesce(p.description_en, ''), 4000),
       left(coalesce(array_to_string(p.search_aliases, ' '), ''), 500),
       (select u from unnest(array[p.image_url, p.thumbnail_url, p.logo_url]) u where u ~ '^https://' limit 1),
       case
         when gf.player or exists (select 1 from public.offers o where o.product_id = p.id and jsonb_typeof(o.input_fields) = 'array' and jsonb_array_length(o.input_fields) > 0) then 'id'
         when gf.product_id is not null or p.product_kind = 'subscription'
              or exists (select 1 from public.offers o where o.product_id = p.id and o.delivery_kind = 'account') then 'account'
         else 'code'
       end,
       p.is_active, coalesce(p.is_featured, false), coalesce(p.sort_order, 0)
  from public.products p
  join _cat_map cm on cm.old_id = p.category_id
  join app.categories ac on ac.slug = cm.slug
  left join _game_fields gf on gf.product_id = p.id
 where p.slug ~ '^[a-z0-9-]{1,80}$'
on conflict (slug) do nothing;

-- ───────────────────────────────────────────────────────────── packages

create temp table _offers on commit drop as
select o.id as old_id, ap.id as product_id, left(o.name_ar, 120) as name_ar, left(o.name_en, 120) as name_en,
       coalesce(o.sort_order, 0) as sort, m.provider_name as supplier_id,
       case m.provider_name
         when 'g2bulk' then case
           when m.external_product_id is not null then 'voucher:' || m.external_product_id
           when g.code is not null and m.external_catalogue_name is not null then 'game:' || g.code || ':' || m.external_catalogue_name
         end
         else m.external_product_id
       end as supplier_ref,
       ceil(m.supplier_cost_usd * 100)::bigint as cost_cents,
       round(o.price * 100)::bigint as price_cents,
       o.is_active as active,
       case when o.delivery_kind in ('direct', 'stored') then '[]'::jsonb  -- stock goods: nothing to ask (as on the old site)
       else coalesce(
         case when jsonb_typeof(o.input_fields) = 'array' and jsonb_array_length(o.input_fields) > 0 then (
           select jsonb_agg(pg_temp.field_json(e->>'field_key', e->>'field_type', e->>'label_en', e->>'label_ar',
                                               coalesce((e->>'is_required')::boolean, true), e->'options', false))
             from jsonb_array_elements(o.input_fields) e where e->>'field_key' is not null) end,
         case when m.provider_name = 'g2bulk' then gf.fields_g2bulk else gf.fields_raw end,
         -- A G2Bulk game top-up always needs the player id.
         case when m.provider_name = 'g2bulk' and m.external_product_id is null then
           '[{"key":"player_id","labelEn":"Player ID","labelAr":"معرّف اللاعب (ID)","required":true}]'::jsonb end,
         '[]'::jsonb
       ) end as input_fields
  from public.offers o
  join public.provider_offer_mappings m on m.offer_id = o.id
  join public.products p on p.id = o.product_id
  join app.products ap on ap.slug = p.slug
  left join _game_fields gf on gf.product_id = p.id
  left join lateral (
    select pm.external_product_code as code from public.provider_product_mappings pm
     where pm.product_id = p.id and pm.provider_name = 'g2bulk' and pm.external_product_code !~ '^voucher:'
     order by pm.created_at limit 1
  ) g on true
 where m.provider_name in (select id from app.suppliers)
   and o.price > 0;

insert into app.offers (product_id, name_ar, name_en, sort, supplier_id, supplier_ref, cost_cents, price_cents,
                        markup_mode, markup_value, round_to_cents, min_margin_pct, input_fields, max_quantity, active, cost_checked_at)
select x.product_id, x.name_ar, x.name_en, x.sort, x.supplier_id, x.supplier_ref, x.cost_cents, x.price_cents,
       case when x.cost_cents > 0 and x.price_cents > x.cost_cents then 'percent' else 'manual' end,
       -- Today's markup, rounded down, so the next sync lands on today's price (or a cent under).
       case when x.cost_cents > 0 and x.price_cents > x.cost_cents
            then least(1000, floor((x.price_cents::numeric / x.cost_cents - 1) * 10000) / 100) else 15 end,
       1, 5, x.input_fields, 1, x.active, now()
  from _offers x
 where x.supplier_ref is not null and jsonb_array_length(x.input_fields) <= 6
on conflict do nothing;

-- ───────────────────────────────────────────────────────────── support contacts

-- The contact channels the old site published (store_settings.contact.channels):
-- the support Telegram account (not the store bot), WhatsApp and email. Only fills
-- settings that are still empty, so anything set in the admin is kept.
do $$
declare
  v_tg text; v_wa text; v_email text;
begin
  if to_regclass('public.store_settings') is null then return; end if;
  -- first of each kind, in the order the old site listed them; "@name",
  -- "t.me/name" and "https://t.me/name" all become "name"
  select regexp_replace(btrim(c->>'value'), '^(https?://)?(t\.me/|telegram\.me/)?@?', '', 'i') into v_tg
    from public.store_settings s, jsonb_array_elements(s.contact->'channels') with ordinality as ch(c, n)
   where c->>'kind' = 'telegram' and btrim(c->>'value') !~* 'bot/?$' order by n limit 1;
  select regexp_replace(regexp_replace(c->>'value', '[^0-9]', '', 'g'), '^00', '') into v_wa
    from public.store_settings s, jsonb_array_elements(s.contact->'channels') with ordinality as ch(c, n)
   where c->>'kind' = 'whatsapp' order by n limit 1;
  select btrim(c->>'value') into v_email
    from public.store_settings s, jsonb_array_elements(s.contact->'channels') with ordinality as ch(c, n)
   where c->>'kind' = 'email' order by n limit 1;
  update app.settings set value = to_jsonb(v_tg), updated_at = now()
   where key = 'support.telegram' and value = 'null'::jsonb and v_tg ~ '^[A-Za-z][A-Za-z0-9_]{4,31}$';
  update app.settings set value = to_jsonb(v_wa), updated_at = now()
   where key = 'support.whatsapp' and value = 'null'::jsonb and v_wa ~ '^[1-9][0-9]{7,14}$';
  update app.settings set value = to_jsonb(v_email), updated_at = now()
   where key = 'support.email' and value = 'null'::jsonb and v_email ~ '^[^[:space:]@]+@[^[:space:]@]+\.[A-Za-z]{2,24}$';
end $$;

-- ───────────────────────────────────────────────────────────── report

select
  (select count(*) from app.categories) as categories,
  (select count(*) from app.products) as products,
  (select count(*) from app.offers) as packages,
  (select count(*) from app.offers where active) as packages_on_sale,
  (select count(*) from _offers where supplier_ref is null) as skipped_no_supplier_item,
  (select count(*) from app.offers where price_cents < ceil(cost_cents * 1.05)) as below_5pct_margin;

commit;
