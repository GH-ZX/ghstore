# Changelog

## v1.2.0 (2026-10-17)

Fixes from a full audit of the code.

- **Orders**: one supplier call per order at a time (no double purchase when the
  scheduled job and the order page meet); only failures in a row lead to a
  refund, never for an order the supplier already accepted; a virtual number
  that fails is cancelled at the supplier before its refund; an admin refund
  cancels at the supplier first; corrected details no longer take an order
  away from the owner.
- **Money**: a pasted USDT hash reserves nothing (someone else's public hash
  blocks nobody); staff in support credit only top-ups under review, up to the
  amount asked, never their own; delivered codes are hidden in the admin until
  "Show", and every look is in the audit log; paid Stars are delivered again by
  Telegram if the database blinked; a SYP invoice paid in full credits its own
  dollars; late provider payments go to review; supplier costs round up to the
  cent; no invite reward or cashback on an order whose cost is unknown.
- **Security**: limits on sign-in, coupon tries, problem reports and reviews;
  Mini App sign-in data accepted for an hour (was a day); at most 20 sessions
  per customer and channel; at most 2 open USDT requests per customer; webhook
  secrets kept out of error texts.
- **Reliability**: time limits on every outside call and on database queries;
  one failing supplier group no longer blocks a supplier's price check (it backs
  off on its own); public pages cached for a minute; nightly clean-up of old
  messages and sessions; health alerts for stuck messages and jobs that never
  finish; browser notifications off until switched on (Admin → Settings).
- **Store**: a product opens over the screen you were on and closing it brings
  that screen back as it was; the Mini App opens even when telegram.org is slow;
  a network blip no longer signs anyone out; signing out clears the device's
  data and notifications; better for screen readers and keyboards; admin
  settings cards save on their own; Arabic digits in admin number boxes.

## v1.1.0 (2026-10-18)

- **Loyalty levels**: customers move up by what they spent on delivered orders
  in the last 30 days (Silver from $50, Gold from $200, Platinum from $500 by
  default) and get 1–3% of every delivered order back in their wallet, never
  more than the order's margin; a message when they reach a level; "Your level"
  in Profile; Admin → Settings → Loyalty levels.
- **Channel posts**: the store posts new products, packages back in stock and
  price drops (10%+) to its Telegram channel by itself, a few a day, with the
  picture and a button to the Mini App (Admin → Broadcast → Channel posts).
- **Browser notifications** for website customers (Profile → Notifications on
  this device): standard Web Push with the store's own keys, no extra service.
- **Safer top-ups**: a smaller first top-up for brand-new accounts, a limit per
  hour, and an alert for unusual activity (many top-ups, many problem reports).
- **Lighter store**: the admin's strings load with the admin; customers' first
  load is about 320 KB of code (was about 670 KB before v1.0).

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
