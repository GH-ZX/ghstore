-- Default settings and starter categories. Safe to re-run.

insert into app.settings (key, value) values
  ('theme.preset', '"energetic"'),
  ('theme.default_mode', '"system"'),
  -- New Syrian pounds per US dollar, for showing SYP beside USD prices (null = hide).
  ('fx.syp_per_usd', 'null'),
  ('orders.max_pending_hours', '24')
on conflict (key) do nothing;

-- Single-word names, Arabic and English kept separate.
insert into app.categories (slug, name_ar, name_en, sort) values
  ('games', 'ألعاب', 'Games', 10),
  ('vouchers', 'بطاقات', 'Vouchers', 20),
  ('ai', 'ذكاء', 'AI', 30),
  ('streaming', 'ترفيه', 'Streaming', 40),
  ('design', 'تصميم', 'Design', 50),
  ('productivity', 'إنتاجية', 'Productivity', 60),
  ('vpn', 'VPN', 'VPN', 70),
  ('numbers', 'أرقام', 'Numbers', 80),
  ('recharge', 'رصيد', 'Recharge', 90)
on conflict (slug) do nothing;

-- Supplier rows (disabled until their API key is set and the owner enables them).
-- Ids match packages/suppliers (supplierFactories). Display names are for the admin only.
insert into app.suppliers (id, name) values
  ('g2bulk', 'G2Bulk'),
  ('batstore', 'BatStore'),
  ('prodseller', 'ProdSeller'),
  ('fivesim', '5SIM'),
  ('maxstore', 'MaxStore')
on conflict (id) do nothing;
