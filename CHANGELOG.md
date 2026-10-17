# Changelog

## v1.0.0 (2026-10-18)

The first complete version of the store: one Cloudflare Worker serving the
website (gh-store.me), the Telegram Mini App and the bot, over one Supabase
Postgres, with five suppliers and four payment methods.

### Selling
- Catalogue from five suppliers (G2Bulk, BatStore, ProdSeller, 5SIM, MaxStore):
  choose packages per supplier, units, covers, clean names, warranties, pinned
  packages, per-supplier markup with preview, price and stock checks with a
  margin guard and cost-jump review.
- Products delivered by hand, details asked after paying, supplier deliveries
  checked before release, in-person sales.
- Virtual numbers (5SIM): success rates, countdown, code, cancel or try another
  number with a refund; 12 services with their own pictures.
- An order its supplier can't deliver waits for the owner (deliver it by hand
  or refund it) instead of being refunded at once (Admin → Settings).

### Paying
- Wallet in US dollars: ShamCash (SAM), Telegram Stars, NOWPayments, USDT BEP20
  found by its exact amount (no hash needed), 15-minute top-up windows with
  cancel, owner's top-up limits.

### Customers
- Website, Mini App and bot on one account and wallet; sign in with Telegram,
  Google, email + password or an email code (Supabase), linked in Profile.
- Favourites, "notify me" for sold-out packages, "buy again" reminders.
- Reviews: buyers rate products (1–5 stars, comment); stars on cards; a review
  request some hours after delivery.
- "Report a problem" on an order, answered from Admin → Orders → Problems.
- Telegram messages for everything; website customers get them by email.
- Arabic and English, right to left, four themes in light and dark.

### Running the store
- Admin: overview with supplier balances, profit with charts and a price
  calculator, top-ups, orders (waiting, problems), catalogue, home showcase,
  coupons, broadcasts, suppliers, users and roles, reviews, SEO & pages,
  settings and keys.
- SEO: every public page server-rendered for search engines in both
  languages, sitemap, robots, structured data, share pictures, owner's search
  texts; terms, privacy and refund pages; Cloudflare Web Analytics.
- Reliability: owner alerts for failing jobs, stuck orders, low balances,
  suppliers not answering, server errors; an outside watchdog; checks after
  every deploy; nightly encrypted database backups (docs/operations.md).
- Invite rewards, coupons, daily summary, CSV exports, audit log.

### Tests
- 387 automated tests (API, suppliers, payments, core) and SQL tests, run on
  every push.
