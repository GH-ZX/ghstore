-- The store's home page (Admin → Home): banners for the carousel at the top,
-- and an icon per category (a name from the web app's icon set, e.g. "game")
-- for its section and the category bar.
--
-- A banner shows a title and a line of text over its picture, or over the
-- theme's colours when it has none, and opens a product, a category or a link.
-- It shows between starts_at and ends_at when they are set. With no banners
-- the carousel shows the products marked "featured".
create table if not exists app.banners (
  id uuid primary key default app.uuid_v7(),
  title_ar text not null check (length(title_ar) between 1 and 80),
  title_en text not null check (length(title_en) between 1 and 80),
  subtitle_ar text not null default '' check (length(subtitle_ar) <= 160),
  subtitle_en text not null default '' check (length(subtitle_en) <= 160),
  cta_ar text not null default '' check (length(cta_ar) <= 24),
  cta_en text not null default '' check (length(cta_en) <= 24),
  image_url text check (image_url is null or (length(image_url) <= 500 and image_url ~ '^https://[^\s"<>]{4,}$')),
  link_type text not null default 'none' check (link_type in ('none', 'product', 'category', 'url')),
  link_value text check (link_value is null or length(link_value) <= 300),
  style text not null default 'accent' check (style in ('accent', 'dark', 'light')),
  sort int not null default 0,
  active boolean not null default true,
  starts_at timestamptz,
  ends_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (link_type = 'none' or link_value is not null),
  check (starts_at is null or ends_at is null or starts_at < ends_at)
);
create trigger banners_touch before update on app.banners for each row execute function app.touch_updated_at();

alter table app.banners enable row level security;
create policy store_server_all on app.banners for all to store_server using (true) with check (true);
grant select, insert, update, delete on app.banners to store_server;

alter table app.categories add column if not exists icon text check (icon is null or icon ~ '^[a-z]{2,20}$');

-- Starting icons for the categories the store already has.
update app.categories set icon = v.icon
  from (values ('games', 'game'), ('vouchers', 'gift'), ('ai', 'spark'), ('streaming', 'play'), ('design', 'palette'),
               ('productivity', 'briefcase'), ('vpn', 'shield'), ('numbers', 'phone'), ('recharge', 'bolt'), ('developing', 'code')) as v(slug, icon)
 where app.categories.slug = v.slug and app.categories.icon is null;
