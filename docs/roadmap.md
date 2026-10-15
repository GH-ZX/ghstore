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
  theme tokens, CI, docs. 220 automated tests plus the SQL tests.
- Migrations verified on the gh-store project's Postgres 17 inside a transaction
  that was rolled back (nothing created yet).

## Done in milestone 2 (web app)

- Website, Mini App (`/tg`) and admin (`/admin`) in one React app, served as
  static files (free on Cloudflare). Arabic and English, four themes, light/dark.
- Store, product sheet with packages and fields, wallet with all four top-up
  flows (ShamCash, USDT auto, USDT manual with hash check, Stars), orders with
  copyable codes, profile and preferences.
- Website sign-in with Telegram (same wallet as the bot), email code, or Google.
- Admin: overview, top-up review, orders (retry, refund), catalogue editor with
  supplier import and manual stock, suppliers, users (wallet adjust, roles),
  settings (theme picker, SYP rate).
- Free-plan fit: the cron spreads its work across the hour.

## After that

- Link an email/Google login to a Telegram account (Telegram login already shares the wallet).
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
