-- Search engines and the store's own pages (Admin → SEO & pages).
--
-- pages: pages shown at /legal/<slug>. The privacy policy, the terms and the
--   refund policy start from texts built into the app (a row here is the owner's
--   edited version; deleting it goes back to the built-in text); the owner can add
--   more pages. Text is plain with a few marks: "## " and "### " headings, "- "
--   list items, **bold** and [links](https://…). {store}, {site}, {url} and
--   {contact} are filled in when the page is shown.
-- products.seo_*: an optional title and description for search results and link
--   previews, used instead of the product's name and description.
create table if not exists app.pages (
  slug text primary key check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$' and length(slug) <= 60),
  title_ar text not null check (length(title_ar) between 1 and 120),
  title_en text not null check (length(title_en) between 1 and 120),
  body_ar text not null default '' check (length(body_ar) <= 60000),
  body_en text not null default '' check (length(body_en) <= 60000),
  published boolean not null default true,
  in_footer boolean not null default true,
  sort int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create trigger pages_touch before update on app.pages for each row execute function app.touch_updated_at();

alter table app.pages enable row level security;
create policy store_server_all on app.pages for all to store_server using (true) with check (true);
grant select, insert, update, delete on app.pages to store_server;

alter table app.products
  add column if not exists seo_title_ar text not null default '' check (length(seo_title_ar) <= 70),
  add column if not exists seo_title_en text not null default '' check (length(seo_title_en) <= 70),
  add column if not exists seo_description_ar text not null default '' check (length(seo_description_ar) <= 320),
  add column if not exists seo_description_en text not null default '' check (length(seo_description_en) <= 320);
