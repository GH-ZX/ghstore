# GH Store

One store, three doors: the **website** (gh-store.me), the **Telegram Mini App**
(@ghstore_robot) and the **bot** itself — all on the same accounts, wallet,
catalogue and orders. A multi-supplier reseller for digital goods: game top-ups,
vouchers, accounts, subscriptions and virtual numbers.

It runs entirely on **Cloudflare Workers + Supabase Postgres**, and fits the
Cloudflare free plan to start: the web app is static files, only `/api`, the bot
and a once-a-minute cron run code. No server to keep alive, and the whole thing is
a template: change `store.config.ts` and `/brand`, set the secrets, and it is
someone else's store.

> متجر واحد بثلاث واجهات: الموقع، تطبيق تيليغرام المصغّر، والبوت — بحساب ومحفظة وطلبات موحّدة.

## Status (v0.1)

| Part | State |
| --- | --- |
| Database (schema, money functions, access rules) | Done, tested |
| API: auth, catalogue, wallet, top-ups, orders, admin, catalogue editor | Done, tested end to end |
| Suppliers: G2Bulk, BatStore, ProdSeller, 5SIM, MaxStore | Done, tested with recorded responses |
| Payments: Telegram Stars, ShamCash (SAM), NOWPayments, manual USDT BEP20 | Done, tested with recorded responses |
| Bot: /start, Mini App button, Stars checkout, /balance, /orders, /invite, /help | Done |
| Invite rewards, coupon codes, "buy again" reminders | Done, tested (SQL + API + browser) |
| Catalogue import from the current site (75 products, 673 packages) | Done; dry-run on the live data, rolled back |
| SEO: every public page server-rendered for search (both languages), sitemap, robots, settings in Admin → SEO & pages | Done |
| Terms, privacy and refund pages (ready texts, editable in the admin), footer links, bot /terms and /paysupport | Done |
| Product reviews (buyers only, stars on cards, Admin → Reviews, in search results' data) | Done |
| Cloudflare Web Analytics (token in Admin → SEO & pages) | Done |
| Owner tools: daily Telegram summary, CSV exports | Done |
| Store settings in the database: support contacts, Stars price, invite rewards (Admin → Settings) | Done, tested |
| Scheduled jobs: fulfilment, payment re-checks, margin guard, balances, reminders, notifications | Done |
| Brand: logo, icon, favicon, Telegram avatar, 4 themes × light/dark | Done |
| Web app: website, Mini App (`/tg`), admin (`/admin`) | Done: React, Arabic/English, 4 themes × light/dark, checked end to end in a browser |
| Staff roles: Owner, Support, Monitor (watch only) | Done, tested |
| Choose packages: tick what to sell from each supplier, review, apply | Done, tested |
| Home showcase: Cinematic and Deal looks, per slide, with settings | Done |
| Units on packages, wide covers, pictures in Supabase Storage | Done, tested |
| 5SIM virtual numbers: success rates, best operator, countdown, code, cancel / try another number with refund | Done, tested |
| Admin → Settings → APIs: supplier and SAM account balances, details, latest movements | Done, tested |
| Sales made in person by the owner (no wallet), product badges chosen per product | Done, tested |
| Admin → Profit: charts, comparison with the period before, price calculator; supplier balances at their pace | Done, tested |
| Automatic badges (New, Best seller), pinned packages, USDT found by its exact amount, retry limit for numbers, opening splash | Done, tested |
| Favourites, "notify me" for sold-out packages, top-up limits set by the owner, header search | Done, tested |
| Per-supplier check schedules (5 min to 24 h), out-of-stock hiding | Done, tested |
| Products delivered by hand, details asked after paying, supplier deliveries checked before release | Done, tested |
| Clean names for BatStore / ProdSeller shorthand, package warranties | Done, tested |
| Email and Google sign-in, linked to Telegram (one wallet) | Done, tested |
| Email receipts (Resend), Telegram broadcasts, job-failure alerts | Done, tested |

## How it fits together

```
 Telegram ──► /telegram/webhook ─┐
 Mini App ──► /tg  ──┐           │
 Website  ──► /    ──┼─► /api/* ─┼─► one Cloudflare Worker ──Hyperdrive──► Supabase Postgres
 Admin    ──► /admin─┘           │        │                                 (private `app` schema,
 Cron (every minute) ────────────┘        ├─► suppliers (G2Bulk, 5SIM, …)    money only through
                                          └─► payments (SAM, NOWPayments,    SQL functions)
                                               BSC RPC, Telegram Stars)
```

More in [docs/architecture.md](docs/architecture.md).

## Repository

```
store.config.ts        name, URL, tagline, mark, languages, time zone, theme (per store)
brand/                 logo and icons (per store)
apps/web/              the Worker (src/) and the web app (client/): website, Mini App, admin
packages/core/         money, sessions, Telegram checks, encryption, pricing, adapter contracts
packages/api/          every endpoint, the bot, scheduled jobs (framework-free)
packages/suppliers/    one adapter per supplier
packages/payments/     one adapter per payment method
packages/db/           SQL migrations, SQL tests, and the one-time import from the old site
packages/ui/           design tokens: 4 theme presets, logo and icon SVG
scripts/setup.ts       prints fresh secrets and the setup commands
docs/                  architecture, launch guide, security, roadmap
```

## Develop

Requirements: Node 24 (22.6+ works), pnpm via `corepack enable`, a local Postgres 17
(16+ works) for tests.

```bash
pnpm install                       # then commit pnpm-lock.yaml
pnpm typecheck
DATABASE_URL=postgres://postgres@localhost:5432/store_test pnpm db:migrate
DATABASE_URL=postgres://postgres@localhost:5432/store_test pnpm db:test
TEST_DATABASE_URL=postgres://postgres@localhost:5432/store_test pnpm test
pnpm build                         # web app → apps/web/dist
pnpm dev                           # build + wrangler dev; local secrets in apps/web/.dev.vars
```

Never point `db:test` or `pnpm test` at production. CI runs all of the above on
every push against a throwaway Postgres (`.github/workflows/ci.yml`).

## Launch

Step by step, including how to copy this into a new store:
[docs/launch-a-store.md](docs/launch-a-store.md). Short version: `pnpm setup:store`
prints the secrets and commands.

## Rules this codebase keeps

- Money is integer US cents. Balances change only inside SQL functions that write a
  ledger row; the Worker's database role cannot touch wallets directly.
- A provider callback is only a wake-up. The store always asks the provider again
  before crediting a top-up or delivering an order.
- Every order and top-up is idempotent: retries, double taps and duplicate webhooks
  cannot charge or credit twice.
- No secrets in git. `.env.example` lists names only.
- Arabic first, right-to-left, English beside it. Category names are single words.

See [docs/security.md](docs/security.md) for the full list.
