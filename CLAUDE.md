# GH Store — notes for Claude

A multi-supplier digital-goods store (game top-ups, vouchers, subscriptions,
virtual numbers): one Cloudflare Worker serves the website, the Telegram Mini
App, the bot webhook, the API and the scheduled jobs, over one Postgres
(Supabase, private `app` schema). Start with `docs/architecture.md`; the launch
guide is `docs/launch-a-store.md`, running it (alerts, backups, rollback)
`docs/operations.md`, security notes `docs/security.md`, what is done
`CHANGELOG.md`, `README.md` and `docs/roadmap.md`. Work in progress: `docs/next-up.md`.

## Layout

- `packages/core` — types and adapter contracts (`adapters.ts`: `SupplierAdapter`, `PaymentAdapter`).
- `packages/suppliers` — one adapter per supplier (G2Bulk, BatStore, ProdSeller, 5SIM, MaxStore), registered in `index.ts`.
- `packages/payments` — Telegram Stars, ShamCash, NOWPayments, manual USDT BEP20.
- `packages/api` — the HTTP API (routes in `src/index.ts`), jobs (`jobs.ts`), price sync (`sync.ts`), admin.
- `packages/db/migrations` — numbered SQL, append-only. `packages/db/tests` — SQL tests.
- `apps/web` — the Worker (`src/worker.ts`) and the React client (`client/src`, built by `client/build.mjs`, no framework router). Admin screens in `client/src/admin`.
- `store.config.ts` — per-store branding; this repo is also a template for other stores.

## Rules that always hold

- **No secrets in the repo, ever** (it is public). No `.env`, no keys, no
  passwords, no personal data. Secrets live only as Worker secrets or as
  encrypted keys in the database (Admin → Settings → Keys).
- The Worker is named **`ghstore`**. Never deploy under any other name.
- Only touch the Supabase project **gh-store** (`njlzgfddfnnqujaodbta`). Other
  projects in the account belong to other people's stores.
- Never force-push, rebase or rewrite `main`. Small commits, clear messages.
- Never point tests at the production database.
- The design is this project's own (`packages/ui` tokens, `client/src/styles.css`,
  `ui/kit.tsx`). Do not copy anything from the old GH Store site's design.
- Arabic and English everywhere: every string goes in `client/src/lib/i18n.ts`
  (both languages), or `client/src/admin/messages.ts` when only the admin uses
  it (kept out of what customers download); layouts must work right-to-left.
  Prices are integer cents.
- Supplier keys are encrypted at rest; never decrypt them to call a supplier by hand.

## Deploying

Pushing to `main` deploys: Cloudflare Workers Builds runs
`pnpm install --frozen-lockfile` and the build. If you change dependencies,
run `pnpm install` and commit `pnpm-lock.yaml` in the same commit, or the
deploy fails.

**Database first.** A migration must be on the live database *before* the code
that needs it is pushed. Apply a migration with the Supabase connector's
`apply_migration` (project `njlzgfddfnnqujaodbta`), adding at the end:
`insert into app.schema_migrations (name) values ('00NN_name.sql');`.
If no Supabase connector is available, stop and give the owner the SQL to run
in Supabase → SQL Editor, then wait for "done" before pushing.
Keep migrations additive (new tables/columns, `if not exists`); anything that
drops or rewrites data needs the owner's explicit OK first. Live is at
`0029_loyalty_channel_push.sql`; check `select max(name) from app.schema_migrations`.

## Checking your work

```bash
pnpm install
pnpm typecheck
# Postgres 17 locally (apt install postgresql, or docker run postgres:17)
DATABASE_URL=postgres://postgres@localhost:5432/store_test pnpm db:migrate
DATABASE_URL=postgres://postgres@localhost:5432/store_test pnpm db:test
TEST_DATABASE_URL=postgres://postgres@localhost:5432/store_test pnpm test
pnpm build
```

CI (`.github/workflows/ci.yml`) runs all of this on every push. For UI work,
build the client and look at it (Playwright screenshots, mobile and desktop,
Arabic and English) before calling it done.

## Constraints to design around

- **Cloudflare free plan: 50 outside requests per Worker run.** `apps/web/src/services.ts`
  counts them (`svc.budget.left()`); jobs leave room for each other. Anything
  that talks to a supplier must work a page/group at a time and resume on the
  next run, never "fetch the whole catalogue now".
- Scheduled jobs run every minute in priority order: orders, outbox, payments,
  balances, price sync.
- A package (offer) whose supplier cost jumps past the supplier's
  `max_jump_pct` is paused for review, never repriced silently. Prices always
  clear the margin guard (`docs/architecture.md` → Prices and the margin guard).
- Orders reference offers: never hard-delete an offer that has orders.

## Adding a supplier

1. `packages/suppliers/src/<name>.ts` implementing `SupplierAdapter`
   (`listGroups`/`listProductsFor`/`syncGroup` when the catalogue is large).
2. Register it in `packages/suppliers/src/index.ts`, add its key names to
   `packages/api/src/keys.ts`.
3. Tests with recorded responses, like the existing adapters.
4. A migration inserting its `app.suppliers` row (off by default; see `0003_seed_settings.sql`).
The admin screens must then work for it with no supplier-specific UI code.
