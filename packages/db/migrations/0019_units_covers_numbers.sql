-- Units, wide covers, supplier checks and virtual numbers.
--
-- products.unit_ar / unit_en: the product's unit ("شدة" / "UC", "ألماسة" /
--   "Diamonds"). A package named only by a number ("60") is named "60 UC" with
--   it; the admin renames the packages when the unit changes.
-- products.cover_url: a wide picture (a game's cover art) for the showcase,
--   next to the square image_url.
-- banners.picture_mode: which picture a slide shows: 'wide' (the product's
--   cover), 'square' (its icon) or 'auto'; null follows the store's setting
--   home.picture_mode (Admin → Home → Showcase).
-- suppliers.stock_alerts: Telegram alerts when packages go out of stock and
--   come back (off by default: some suppliers do it all day). Price jumps and
--   margin problems always alert.
-- suppliers.sync_minutes may now be as short as 5 minutes.
-- orders.supplier_expires_at: when the supplier's offer ends (a virtual
--   number lives about 15 minutes), for the countdown and the cancel button.
alter table app.products
  add column if not exists unit_ar text not null default '' check (length(unit_ar) <= 24),
  add column if not exists unit_en text not null default '' check (length(unit_en) <= 24),
  add column if not exists cover_url text check (cover_url is null or (length(cover_url) <= 500 and cover_url ~ '^https://[^\s"<>]{4,}$'));

alter table app.banners
  add column if not exists picture_mode text check (picture_mode is null or picture_mode in ('auto', 'wide', 'square'));

alter table app.suppliers
  add column if not exists stock_alerts boolean not null default false;
alter table app.suppliers drop constraint if exists suppliers_sync_minutes_check;
alter table app.suppliers add constraint suppliers_sync_minutes_check check (sync_minutes between 5 and 1440);

alter table app.orders
  add column if not exists supplier_expires_at timestamptz;

-- Arabic names a supplier can suggest (5SIM: country names), for new products and packages.
alter table app.supplier_items
  add column if not exists product_name_ar text check (product_name_ar is null or length(product_name_ar) <= 200),
  add column if not exists package_name_ar text check (package_name_ar is null or length(package_name_ar) <= 300);

-- Store pictures kept in the project's Storage bucket "store-images" (see
-- packages/api/src/images.ts): each picture linked from another site is
-- copied once; a failed copy is tried again a day later.
create table if not exists app.image_copies (
  source_url text primary key check (length(source_url) <= 500),
  stored_url text check (stored_url is null or length(stored_url) <= 500),
  failed_at timestamptz,
  error text,
  created_at timestamptz not null default now()
);
alter table app.image_copies enable row level security;
create policy store_server_all on app.image_copies for all to store_server using (true) with check (true);
grant select, insert, update, delete on app.image_copies to store_server;
