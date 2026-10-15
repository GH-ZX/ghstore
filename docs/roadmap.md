# Decisions and roadmap

## Decisions

| Topic | Decision |
| --- | --- |
| Stack | All TypeScript, serverless: one Cloudflare Worker + Supabase Postgres via Hyperdrive. No server to run. |
| Repos | This new repository replaces gh-store-tele and gh-store-dev. ghawi.app stays separate; the bot factory is dropped. |
| Database | The existing gh-store Supabase project, new private schema `app`. echocore-store is not touched. |
| Old balances | Small; settled by hand, new wallets start at zero. |
| Suppliers | Multi-supplier reseller, each package from exactly one supplier. No cheapest-supplier routing; the same item from two suppliers is two packages named by the owner ("Server 1", "Server 2"). |
| Payments | Telegram Stars (bot/Mini App), ShamCash through SAM (Syriatel Cash later, same API), NOWPayments (automatic USDT), manual USDT BEP20. Binance Pay dropped. |
| Currency | USD in cents. SYP shown beside it when `fx.syp_per_usd` is set, in new pounds (two zeros removed on 1 Jan 2026). |
| Identity | Mark "GH.", full name "GH Store". Logo direction D (from the owner's hexagon sketch). |
| Themes | Four presets (Calm, Energetic, Minimal, Warm), each light and dark, chosen in the admin; visitors follow their device. |
| Mobile UX | Floating header and pill tab bar, bottom sheets, two-column product cards, gentle motion — the patterns liked in Duskyr and Verifier Bot, in GH's own identity. Prototype: "GH. Identity Directions" design canvas. |
| Template | Everything store-specific is in `store.config.ts`, `brand/`, secrets and the seed migration. |

## Done in v0.1

- Phase 0 on the live gh-store database: internal and trigger functions no longer
  callable by `anon`/`authenticated`, `search_path` pinned. The current site kept
  working.
- This repository: schema and money functions, the full API, five suppliers, four
  payment methods, the bot, scheduled jobs, the catalogue editor API, brand assets,
  theme tokens, CI, docs. 216 automated tests plus the SQL tests.
- Migrations verified on the gh-store project's Postgres 17 inside a transaction
  that was rolled back (nothing created yet).

## Next: the web app (milestone 2)

One React Router app served by the same Worker, built from the approved prototype:

1. **Shared shell**: theme from `@store/ui`, Arabic RTL first, English, light/dark,
   floating header, pill tab bar, bottom sheets, skeletons, motion.
2. **Mini App** (`/tg`): store, product sheet with packages and fields, checkout
   from wallet, orders with copy buttons, wallet with the four top-up methods,
   profile and language. Telegram theme and back button.
3. **Website** (`/`): the same screens on wider layouts, Supabase login, SEO pages
   for categories and products.
4. **Admin** (`/admin`): overview, top-ups to review, orders, catalogue editor
   with supplier import, stock upload, suppliers, settings (theme picker), users.

Needs `pnpm install` (npm registry) — on your computer, in CI, or in a session
linked to your computer.

## After that

- Link a Telegram account and a website login into one wallet.
- Referral rewards, coupons, and "buy again" reminders (from the old bot, rebuilt
  on the ledger).
- Syriatel Cash through SAM.
- Notifications beyond Telegram (email receipts).
- Admin: daily summary to the owners, CSV export.

## Open questions

- **SAM after the redenomination**: which currency code SAM uses for new pounds,
  and its exact amount format. Default is USD invoices until confirmed.
- **MaxStore**: order request/response formats were not fully verifiable from the
  old code; test with a real $1 order before enabling.
- **USDT on BSC decimals**: 18, taken from the old code and the token contract
  convention; confirm with the first real transfer.
- **Stars rate**: `STARS_PER_USD` must cover Telegram's cut; decide the number.
