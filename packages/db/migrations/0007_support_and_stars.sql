-- Two more owner settings, changed in Admin → Settings:
--
-- support.telegram / support.whatsapp / support.email: how customers reach the
--   store (profile → Help and support, and the bot's /help). Empty until set: a
--   store copy enters its own; gh-store's come over from the old site with
--   packages/db/import/from-old-gh-store.sql.
--
-- payments.stars_per_usd: Telegram Stars charged per US dollar of balance.
--   Telegram pays bots about $0.013 per Star, so 77 Stars ≈ $1 received; 80 keeps
--   a small margin for withdrawal costs. (The old bot charged 100.) Null turns
--   Stars top-ups off. Each invoice stores its own price in Stars, so changing
--   the rate never affects a payment already in progress.
insert into app.settings (key, value) values
  ('support.telegram', 'null'),
  ('support.whatsapp', 'null'),
  ('support.email', 'null'),
  ('payments.stars_per_usd', '80')
on conflict (key) do nothing;
