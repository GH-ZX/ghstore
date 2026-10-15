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
| Store settings | Support contacts, the Stars price and invite rewards live in the database and are changed in Admin → Settings, never in code. |
| Stars price | 80 Stars per $1 to start (Telegram pays about $0.013 per Star, so 77 ≈ $1). Each invoice keeps the price it was issued at. |
| Invite rewards | On at 2% of what invited friends spend, for 90 days, never more than the sale's margin. |

## Done in v0.1

- Phase 0 on the live gh-store database: internal and trigger functions no longer
  callable by `anon`/`authenticated`, `search_path` pinned. The current site kept
  working.
- This repository: schema and money functions, the full API, five suppliers, four
  payment methods, the bot, scheduled jobs, the catalogue editor API, brand assets,
  theme tokens, CI, docs. 220 automated tests plus the SQL tests (231 after milestone 3, 242 after milestone 4).
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

## Done in milestone 3 (old-bot features)

- Invite rewards on the ledger: invite code and links (bot, Mini App, website),
  reward paid when the friend's order is delivered, settings in the admin,
  "Invite friends" card on the profile.
- Coupons: percent or fixed, caps, minimum order, one product or all, limits and
  dates; checked at checkout, never below cost; admin page with uses and totals.
- "Buy again" reminders per package, sent once on Telegram with a button to the product;
  "Buy again" button on finished orders.
- Bot commands: /balance, /orders, /invite, /help.

## Done in milestone 4 (launch polish)

- One-time import of the current catalogue from the old site
  (`packages/db/import/from-old-gh-store.sql`), dry-run on the live data.
- Choice fields (game servers, regions) end to end; supplier field names kept.
- Product link previews, sitemap, robots; share button on products.
- Owner daily summary on Telegram and CSV exports; admin "today" follows the
  store's time zone.
- The web app's types checked against a strict React 19 stand-in (the real
  types install in CI).
- Support contacts and the Telegram Stars price as admin settings; the import
  fills the contacts from the old site's published channels.

## After that

- Link an email/Google login to a Telegram account (Telegram login already shares the wallet).
- Syriatel Cash through SAM.
- Notifications beyond Telegram (email receipts).

## Open questions

- **SAM after the redenomination**: which currency code SAM uses for new pounds,
  and its exact amount format. Default is USD invoices until confirmed.
- **MaxStore**: order request/response formats were not fully verifiable from the
  old code; test with a real $1 order before enabling.
- **USDT on BSC decimals**: 18, taken from the old code and the token contract
  convention; confirm with the first real transfer.
