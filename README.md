# GH Store

One store, three doors: the **website** (gh-store.me), the **Telegram Mini App**
(@gh_store1_bot) and the **bot** itself — all on the same accounts, wallet,
catalogue and orders. A multi-supplier reseller for digital goods: game top-ups,
vouchers, accounts, subscriptions and virtual numbers.

It runs entirely on **Cloudflare Workers + Supabase Postgres**. No server to keep
alive, and the whole thing is a template: change `store.config.ts` and `/brand`,
set the secrets, and it is someone else's store.

> متجر واحد بثلاث واجهات: الموقع، تطبيق تيليغرام المصغّر، والبوت — بحساب ومحفظة وطلبات موحّدة.

## Status (v0.1)

| Part | State |
| --- | --- |
| Database (schema, money functions, access rules) | Done, tested |
| API: auth, catalogue, wallet, top-ups, orders, admin, catalogue editor | Done, tested end to end |
| Suppliers: G2Bulk, BatStore, ProdSeller, 5SIM, MaxStore | Done, tested with recorded responses |
| Payments: Telegram Stars, ShamCash (SAM), NOWPayments, manual USDT BEP20 | Done, tested with recorded responses |
| Bot: /start, Mini App button, Stars checkout | Done |
| Scheduled jobs: fulfilment, payment re-checks, margin guard, balances, notifications | Done |
| Brand: logo, icon, favicon, Telegram avatar, 4 themes × light/dark | Done |
| **Web app: website, Mini App (/tg), admin (/admin)** | **Next milestone** — a branded placeholder page is served meanwhile |

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
store.config.ts        name, mark, languages, default theme, support links (per store)
brand/                 logo and icons (per store)
apps/web/              the Worker: routing, wiring, wrangler.jsonc
packages/core/         money, sessions, Telegram checks, encryption, pricing, adapter contracts
packages/api/          every endpoint, the bot, scheduled jobs (framework-free)
packages/suppliers/    one adapter per supplier
packages/payments/     one adapter per payment method
packages/db/           SQL migrations and SQL tests
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
pnpm dev                           # wrangler dev; local secrets in apps/web/.dev.vars
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
