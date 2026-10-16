-- Automatic badges and pinned packages.
--
-- products.badge: null now means "automatic" (New for the newest products,
--   Best seller for the most sold, when those are switched on in Admin →
--   Home); 'none' means never a badge; the others stay fixed.
-- offers.pinned: the package is listed first in its product (virtual numbers:
--   the owner's favourite countries above the success-rate order).
alter table app.products drop constraint if exists products_badge_check;
alter table app.products
  add constraint products_badge_check check (badge is null or badge in ('none', 'instant', 'new', 'hot', 'best', 'sale'));

alter table app.offers
  add column if not exists pinned boolean not null default false;
