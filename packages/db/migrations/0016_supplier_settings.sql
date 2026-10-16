-- Supplier settings (Admin → Suppliers → Settings) and a safer price sync.
--
-- sync_minutes        how often prices and availability are checked (15 min to 24 h).
-- auto_reprice        on: packages priced by markup follow the supplier's cost;
--                     off: prices stay put, and a package pauses only when its
--                     price no longer clears the minimum margin.
-- max_jump_pct        a cost that moves by more than this percent (up or down)
--                     pauses the package for review instead of repricing it:
--                     a renumbered catalogue or a supplier's typo cannot reprice
--                     the store by itself. Null turns the guard off.
-- import_*            defaults for packages imported from this supplier.
-- last_sync_report    what the last check did, shown in the admin.
--
-- offers.pending_cost_cents holds the new cost of a package paused for review
-- ('cost_jump') until the owner accepts it, or the cost comes back.
alter table app.suppliers
  add column if not exists sync_minutes int not null default 60 check (sync_minutes between 15 and 1440),
  add column if not exists auto_reprice boolean not null default true,
  add column if not exists max_jump_pct int default 50 check (max_jump_pct is null or max_jump_pct between 5 and 1000),
  add column if not exists import_markup_pct numeric(7, 2) not null default 15 check (import_markup_pct between 0 and 1000),
  add column if not exists import_min_margin_pct numeric(6, 2) not null default 5 check (import_min_margin_pct between 0 and 500),
  add column if not exists import_round_to_cents int not null default 1 check (import_round_to_cents between 1 and 10000),
  add column if not exists last_sync_report jsonb;

alter table app.offers
  add column if not exists pending_cost_cents bigint check (pending_cost_cents is null or pending_cost_cents > 0);
