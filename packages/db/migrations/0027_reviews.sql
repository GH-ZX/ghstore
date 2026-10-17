-- Product reviews: a customer who received a product rates it (1 to 5 stars)
-- and may add a comment. One review per customer and product, which they can
-- change or remove; staff can hide one (Admin → Reviews). Shown on the product,
-- as stars on its card, and to search engines (aggregateRating).
create table if not exists app.reviews (
  id uuid primary key default app.uuid_v7(),
  product_id uuid not null references app.products (id) on delete cascade,
  user_id uuid not null references app.users (id) on delete cascade,
  rating smallint not null check (rating between 1 and 5),
  comment text not null default '' check (length(comment) <= 600),
  status text not null default 'visible' check (status in ('visible', 'hidden')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (product_id, user_id)
);
create index if not exists reviews_product_idx on app.reviews (product_id, status, created_at desc);
create trigger reviews_touch before update on app.reviews for each row execute function app.touch_updated_at();

alter table app.reviews enable row level security;
create policy store_server_all on app.reviews for all to store_server using (true) with check (true);
grant select, insert, update, delete on app.reviews to store_server;
