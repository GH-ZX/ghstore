# Architecture

## One Worker

Everything runs in a single Cloudflare Worker (`apps/web`):

| Path | What |
| --- | --- |
| `/api/*` | JSON API for the website, the Mini App and the admin |
| `/telegram/webhook` | Bot updates. Telegram sends the secret header set with `setWebhook` |
| `/`, `/tg`, `/admin` | The web app: static files from `apps/web/dist`, served by Cloudflare without running the Worker |
| cron `* * * * *` | Scheduled jobs (below) |

One deploy, one set of secrets, one log stream. The earlier plan had a separate
bot Worker; merging it removed a second copy of the wiring and a network hop for
Stars payments.

## Packages

```
core ◄── suppliers
  ▲  ◄── payments
  │         ▲
  └──── api ┘ ◄── apps/web (Worker) ── ui (themes, logo)
```

- **core**: no I/O. Money helpers, HMAC sessions, Telegram `initData` checks,
  AES-GCM encryption, pricing and the margin guard, order state rules, and the
  `SupplierAdapter` / `PaymentAdapter` contracts. Web APIs only, so it runs in
  Workers, Node and Bun.
- **suppliers** / **payments**: one file per provider, each implementing a
  contract from core. They read their keys from Worker secrets and use the
  injected `fetch`, so tests replay recorded responses.
- **api**: framework-free handlers (`Request` in, `Response` out), the bot, and
  the jobs. All dependencies (database, adapters, clock, Telegram) come in through
  `Services`, so the end-to-end tests run the real handlers against a real
  Postgres with fake providers.
- **db**: SQL migrations and SQL tests.
- **ui**: theme tokens and brand SVG, used by the web app and the build.
- **apps/web/client**: the web app (below).

## Web app

One React 19 app, built with esbuild into static files (`pnpm build`), serves
three doors from the same code:

| Door | URL | Sign-in | Notes |
| --- | --- | --- | --- |
| Website | `/` | Telegram Login Widget (same account and wallet as the bot), or email code / Google via Supabase Auth | Session in an HttpOnly cookie |
| Mini App | `/tg` (BotFather menu button) | Automatic from Telegram `initData` | Bearer token for the tab; Telegram's back button, theme, haptics, Stars invoices |
| Admin | `/admin` | Same sign-in, staff role | Support: overview, top-ups, orders, users. Owner: also catalogue, suppliers, settings |

- Arabic (RTL) first, English beside it; every string is in `client/src/lib/i18n.ts`.
- Four theme presets × light/dark from `@store/ui`; the owner picks the preset in
  the admin, visitors pick light/dark/auto (inside Telegram, auto follows Telegram).
- Mobile patterns: floating glass header, floating pill tab bar, bottom sheets
  (centred dialogs on wide screens), two-column product grid, short motion that
  respects reduced-motion settings.
- Routes: `/` store, `/p/:slug` product sheet, `/orders`, `/orders/:id`,
  `/wallet` (`?topup=` opens add-funds, `?payment=` shows a top-up's status),
  `/profile`, `/login`, `/admin/*`. Deep links into the Mini App: `?startapp=p_<slug>`
  (a product), `r_<code>` (a friend's invite), `wallet`, `orders`, `invite`.
  Website invite links are `/?ref=<code>`; the code is kept until sign-in.
- **Header**: the same way round in both languages (logo on the left), with a
  search button (full-screen search, `ui/Search.tsx`: recent searches on the
  device, popular products, categories, results as you type) and a globe that
  switches Arabic and English. Payment providers' logos (ShamCash) are in
  `client/public/pay`.
- **Opening splash**: `index.html` carries the logo (drawn from `ui/logo.ts`,
  the same drawing as `Logo`) so it shows before any script loads; it draws
  itself in and stays until the user, their balance and the home page's
  products are loaded (at least 0.9 s, at most 6 s), so "Sign in" never flashes
  for someone signed in. Coming back to the app after 20 s reads the user and
  balance again.
- No router or state library: a 90-line history router and a small store.
  Admin code is split into its own chunk, so customers never download it.
- `_headers` sets a strict Content-Security-Policy; Telegram's iframe on
  web.telegram.org may embed the app, nobody else can.

## Database

Supabase Postgres, private schema `app` (not exposed to the Data API: `anon` and
`authenticated` have no access). The Worker connects through **Hyperdrive** with
node-postgres as `store_app`, a login role that only has the rights of
`store_server`:

- Plain reads and writes on catalogue, orders, payments (limited columns) and
  settings, with row-level security enabled everywhere as a second layer.
- **No** insert/update/delete on `wallets` or `ledger`. Money moves only through
  `SECURITY DEFINER` functions in `0002_money_functions.sql`:

| Function | Does |
| --- | --- |
| `place_order` | Locks the wallet, checks offer, quantity and balance, debits, writes the ledger, creates the order. Manual-stock offers are delivered in the same transaction. Idempotent per `(user, idempotency key)`. |
| `refund_order` | Refunds once (ledger unique on `(kind, ref_type, ref_id)`). |
| `credit_payment` | Credits a top-up once, with the amount the provider confirmed. |
| `submit_tx_hash` | Attaches a USDT transaction hash to a top-up; a hash can be used once, store-wide. |
| `adjust_wallet` | Owner-only manual adjustment with a note. |
| `claim_due_orders` | Leases orders for the fulfilment job (`FOR UPDATE SKIP LOCKED`). |
| `quote_coupon` | Previews a coupon for an offer and quantity; `place_order` applies the same rules with the coupon row locked. |
| `ensure_referral_code` / `set_referrer` | A customer's invite code; links a brand-new customer to an inviter (once, no self-invites, no loops). |
| `queue_buy_again` | Queues due "buy again" reminders and clears them. |

Guard triggers stop anything else from setting an order or payment to
`paid`/`refunded`. A trigger pays invite rewards when an invited customer's order
becomes `delivered` (ledger kind `referral`, one per order), and another sets the
order's "buy again" time from its package. IDs are UUIDv7 (time ordered). Order numbers are a sequence
from 1001, shown as `GH-1001`.

## Order flow

1. Customer picks a package (offer) and fills its fields (player ID, server…).
   The API validates them against the offer's `input_fields`.
2. `place_order` debits the wallet and creates the order as `paid`.
3. The Worker immediately calls the supplier (`fulfilOrder`) in the background.
   - delivered → codes/accounts are stored **encrypted** (`DATA_KEY`) and the
     customer is notified;
   - pending → `next_check_at` is set with back-off (30 s … 15 min);
   - failed for good → refunded automatically.
4. The cron re-checks pending orders. A supplier webhook only moves the next check
   to "now". Orders still open after `orders.max_pending_hours` go to a person;
   they are never refunded automatically, because the supplier may still deliver.

### Sales made in person (`orders.paid_with`, migration 0022)

The owner can sell a package face to face (the product sheet's "Sell in
person", `POST /api/admin/orders/in-person`, `app.place_in_person_order`): the
order is placed like a customer's, in the owner's own Orders, the supplier
delivers as usual, and no wallet is charged (`paid_with = 'in_person'`). Its
refund marks it refunded and credits no wallet: the owner gives the money back.

### Orders that wait for someone (`orders.hold`, migration 0021)

How a product is delivered is `products.delivery`: `auto` (the supplier, or
the stock uploaded in the admin), `manual` (a person: no supplier is called,
no stock is used) or `review` (the supplier delivers, a person checks it and
releases it). A product can also ask for details after paying
(`products.after_fields`: email, password, account ID, username, cookies or
session token, or the owner's own question); the product page lists them and
the customer ticks "I have these ready" before paying.

- `hold = 'info'`: paid, waiting for the customer's details. The order page
  shows the form (`POST /api/orders/:id/answers`); the answers are checked,
  stored encrypted (`orders.answers_enc`, `DATA_KEY`), never put in a message,
  and erased two weeks after the order is closed (`erase_details` job). Then a
  supplier is asked, or the order waits for a person.
- `hold = 'owner'`: waiting for a person to deliver it (Admin → Orders →
  Waiting). The details can be corrected until then.
- `hold = 'release'`: the supplier delivered; the customer sees nothing until a
  person releases it.
- Staff (owner, support) open the order (`GET /api/admin/orders/:id`, every
  look at the details is audit logged), deliver it or release it
  (`POST /api/admin/orders/:id/deliver`), or refund it. A held order is never
  bought or re-checked by the scheduled job.

## Top-up flow

The smallest and largest top-up are the owner's (Admin → Settings → Top-ups:
`payments.min_topup_cents`, `payments.max_topup_cents`; $1 and $1,000 when
unset), sent to the app in `/api/config` and enforced when a top-up is made.
Admin → Top-ups shows one card per top-up with counts per list, the exact USDT
amount asked, the reason in words, and "Credit" prefilled (what arrived when
less did).

| Method | How it is confirmed |
| --- | --- |
| Telegram Stars | `successful_payment` arrives on the authenticated bot webhook; amount and payer are checked against the invoice. Mini App only (Telegram's rule for digital goods). |
| ShamCash (SAM API) | SAM calls the callback URL, which carries a secret token; the store then asks SAM for the invoice status. |
| NOWPayments | IPN signature checked (HMAC-SHA512), then the payment is fetched from NOWPayments. |
| USDT BEP20 (manual) | The customer sends the request plus a small unique tag (e.g. 10.0137 for $10, `payments.send_units`) and is credited the request. Pasting the transaction hash checks it at once; otherwise the `usdt_deposits` job finds it by that exact amount. Either way the store reads the chain: right token, right address, exact amount, mined after the request, 20 confirmations, hash never used before. |

Anything that does not match exactly (underpaid, overpaid, wrong payer) goes to
**review** in the admin instead of being credited.

**15 minutes to pay, and Cancel.** Every top-up shows a countdown from the
server's `secondsLeft` (a phone's clock may be off) and a Cancel button while
unpaid (`POST /api/topups/:id/cancel`; USDT only before a hash). Closing
marks it `expired` with a note (`CLOSED_NOTES`):
- Stars: Telegram's checkout is refused after the window, so nothing is charged.
- ShamCash / NOWPayments close 17 minutes after the request; a payment the
  provider still confirms later (webhook, or the 2-minute re-check for 2 days)
  reopens and credits it: the money arrived. A Stars payment Telegram took is
  credited the same way.
- Manual USDT: a transfer must be mined within the 15 minutes (plus 2 minutes
  for clocks, `notAfter` in `verifyTransfer`); the request stays open 30 more
  minutes to paste the hash of a transfer made in time, then closes and its
  amount is free again.

**USDT found by its amount** (`detectUsdtDeposits`, every 2 minutes while a
USDT request is open): every open request has its own amount to send (the
request plus 0.0100 to 0.0199, in ten-thousandths of a dollar in
`payments.send_units`, unique among open requests), so a confirmed USDT
transfer of exactly that amount to the store address belongs to it. The job reads the address's
recent USDT transfers with `eth_getLogs` (the dataseed RPC refuses log
queries), at most 1500 blocks per run and never further back than ~35 minutes,
from the first log server that answers: `BSC_LOGS_RPC_URL` if the owner set one
(Admin → Settings → Keys), then the free publicnode, 48 Club and bloXroute
servers. Their answers are only hints: a matching transfer is checked against
that request on `BSC_RPC_URL` first, then attached and credited. Where it
stopped is kept in `app.settings` (`bep20.scan_block`). Busy log servers are
tried again quietly; only 30 minutes of failures is reported
(`bep20.scan_failing_since`). A transfer that matches nothing is left alone:
the customer can still paste its hash.

## Prices and the margin guard

Each offer has a supplier cost and a rule: percent markup, fixed markup, or a
manual price, plus a minimum margin and rounding. Every hour the sync job reads
each supplier's catalogue and:

- reprices computed offers when the cost changes;
- **pauses** a manual-price offer whose cost now eats the minimum margin;
- pauses offers the supplier stopped selling, and resumes them when they return;
- tells the owners in Telegram.

New supplier items are never added automatically: the owner chooses them in
**Admin → Suppliers → Choose packages**.

A supplier's markup (Admin → Suppliers → Settings → New imports) applies to
new imports; "Apply to its packages on sale too" previews and then reprices
the supplier's existing markup-priced packages with it
(`POST /api/admin/suppliers/:id/pricing`). Prices typed by hand and packages
waiting for review are left alone; every price still clears the minimum margin.

## Choosing what to sell (Choose packages)

- **A saved copy of each supplier's list**: `app.supplier_groups` and
  `app.supplier_items` (migration 0018), filled a group at a time (a G2Bulk
  game, or the whole list of a supplier that lists everything at once, group
  id `""`). It is read when the owner opens a group whose copy is older than a
  day, on "Refresh list", by the `supplier_catalogue` job with the requests a
  run has left, and the price check writes the costs it reads anyway. A failed
  or empty read never marks anything as gone. Code: `packages/api/src/supplier-catalogue.ts`.
- **Each supplier groups its own way**: an adapter tells, per item, which
  store product it belongs to (`productKey`, `productName`, `packageName` on
  `SupplierProduct`): G2Bulk one product per game (and per voucher brand),
  MaxStore per category, 5SIM per service. The screen has no supplier-specific code.
- **Clean names** for suppliers that name each item in shorthand
  (`suppliers.clean_names`: BatStore, ProdSeller): `cleanSupplierName` in
  packages/core turns "Capcut pro 1M 1600 Ai credit FW" into the product
  "CapCut Pro", the package "1 month · 1,600 AI credits" and the warranty
  "Full warranty" (`offers.warranty_ar` / `warranty_en`, shown on the package),
  in both languages; items with the same clean product name become packages of
  one product. Warranties, durations, tokens, credits and seat counts are read
  on their own; the rest comes from the owner's word list (Admin → Suppliers →
  Names, setting `catalog.name_words`, with a live preview). Saving renames the
  saved supplier lists only, never products on sale (`packages/api/src/names.ts`).
- **Applying** (`POST /api/admin/suppliers/:id/selection`, `selection.ts`): a
  dry run returns the plan, the real run does it in one transaction, owner
  only, audit logged, at most 500 changes. Every item is checked against the
  saved copy; a screen loaded before another change is refused
  (`suppliers.selection_version`). New packages join the product that already
  sells their group, or a new product (shown at once, in the supplier's import
  category, with its description template, priced with its import markup and
  always above the margin floor). Unticked packages are deleted if never
  ordered, archived (hidden) if they have orders; a product left with nothing
  to sell is hidden; ticking an archived package brings it back.

## Stock, units and pictures

- **Out of stock**: a package the supplier has none of is paused
  (`supplier_unavailable`); the next check puts it back when stock returns. On
  the product page it stays, last and greyed "Sold out" (as does an own-stock
  package with no code left, `SOLD_OUT_SQL` in `favorites.ts`), with "Notify me":
  `app.stock_alerts`, and one `back_in_stock` Telegram message when it is on
  sale again (the price check, the owner adding codes or lifting a pause). The
  heart saves a product (`app.favorites`, Profile → Favourites). A purchase refused for lack of stock is refunded
  and pauses its package at once. Telegram alerts for stock changes are a
  per-supplier option (`suppliers.stock_alerts`, off by default); price jumps
  and lost margins always alert.
- **Units**: `products.unit_ar` / `unit_en` ("شدة" / "UC"). Packages named only
  by their amount are renamed with the unit when it changes ("60" → "60 UC",
  `withUnit` in packages/core); new packages from Choose packages get it too.
- **Badges**: `products.badge` is a fixed badge (Instant, New, Hot, Best
  seller, Sale), `none`, or null for automatic: Best seller for the 3 most sold
  products of the last 30 days (3 orders or more), New for the 6 newest active
  products added in the last 14 days (`autoBadges` in `settings.ts`). Each
  automatic kind can be switched off in Admin → Home (`badges.auto_best`,
  `badges.auto_new`).
- **Pictures**: `products.image_url` (square icon) and `cover_url` (wide). The
  showcase shows the cover, the icon, or decides by itself (`home.picture_mode`,
  per slide `banners.picture_mode`). Uploads and copies live in the Supabase
  Storage bucket `store-images` (`packages/api/src/images.ts`), written with the
  project's secret key (Admin → Settings → Keys → Storage).

## Virtual numbers (5SIM)

One product per service (Telegram, WhatsApp…), a package per country with its
flag and Arabic name. 5SIM prices and balances are in US dollars
(`FIVESIM_RUB_USD_RATE` converts an old ruble account). Each operator of a
country publishes how many of its numbers got their SMS lately; a package is
priced from the operator with the best success rate (cheaper between close
rates), shows that rate (`offers.success_pct`, best countries first), and the
purchase asks for the best operator that still fits the package's cost
(operator "any" with `maxPrice` when none publishes a rate), so a number never
costs more than it was priced from. The order page shows the
number with a countdown (`orders.supplier_expires_at`) and asks 5SIM for the
code every few seconds while the customer watches; the scheduled check does
it every 15 s otherwise. Before a code arrives the customer can cancel or
report the number as already used (`POST /api/orders/:id/number`): 5SIM
releases it and the order is refunded. "Try another number" does that and buys
the next number of the same package at once (`again: true`), as 5SIM users do
until a code arrives, at most `numbers.max_retries` times in a row (default 5,
per customer and package within 30 minutes; Admin → Settings → Virtual
numbers). Pinned packages (`offers.pinned`, the owner's favourite countries)
are listed first, then the best success rates. A number that expires without a code is
refunded too. The catalogue is read a service at a time (the full price list is
several MB).

## Scheduled jobs (every minute)

| Job | Work |
| --- | --- |
| `orders` | Fulfil/re-check due orders (leased, so overlapping runs are safe) |
| `stuck_orders` | Flag orders open too long, alert owners |
| `payments` | Re-check pending SAM/NOWPayments top-ups; expire old ones |
| `usdt_deposits` | Every 2 min (odd minutes), only while a USDT request is open: credit transfers found by their exact amount |
| `supplier_balances` | Every 15 min; alert once when a balance drops under its threshold |
| `supplier_sync` | Every minute, for each supplier whose own interval is up (5 min to 24 h, Admin → Suppliers → Price and stock checks): costs, availability, margin guard |
| `supplier_catalogue` | Every 5 min, with spare requests only: refresh up to 3 groups of the saved supplier lists (Choose packages); suppliers that list everything in one request go first, and new items of clean-name suppliers are named |
| `store_images` | Every 10 min, once the storage key is set: copy pictures linked from other sites into the store's Storage bucket |
| `outbox` | Send queued Telegram notifications |
| `buy_again` | Twice an hour: queue due "buy again" reminders |
| `erase_details` | Twice an hour: erase the details customers gave after paying, two weeks after their order closed |
| `daily_summary` | Every 10 minutes; in the owner's chosen local hour (default 09:00), queue yesterday's summary once |

Each job records `last_ok_at` / `last_error` in `app.job_heartbeats`, shown on the
admin overview.

## Sign-in

- **Mini App**: Telegram `initData`, verified with the bot token (max 24 h old).
- **Website**: Supabase Auth (email / Google) in the browser; the Worker checks
  the access token with Supabase once and issues its own session.
- **Sessions**: `v1.<payload>.<hmac>` signed with `SESSION_SECRET`, tied to a
  row in `app.sessions` so logout, bans and role changes revoke them at once.
  Mini App 12 h, website 14 days, admin 8 h.
- A person is one `users` row with one or more `identities` (Telegram, Supabase).
  Linking a Telegram account and a website login into one wallet is on the
  roadmap; the table is ready for it.

## API

| Area | Endpoints |
| --- | --- |
| Auth | `POST /api/auth/telegram`, `POST /api/auth/web`, `POST /api/auth/logout`, `GET/PATCH /api/me` |
| Catalogue | `GET /api/catalog?q=&category=`, `GET /api/products/:slug` |
| Orders | `POST /api/orders`, `GET /api/orders`, `GET /api/orders/:id` |
| Wallet | `GET /api/wallet`, `GET /api/topups/methods`, `POST /api/topups`, `GET /api/topups/:id`, `POST /api/topups/:id/tx` |
| Webhooks | `POST /api/webhooks/payments/:method`, `POST /api/webhooks/suppliers/:id` |
| Admin (staff) | overview; payments list/approve/reject/recheck; orders list/refund/retry; settings |
| Promotions | `POST /api/coupons/quote`, `GET/POST /api/me/referral` |
| Reports (owner) | `GET /api/admin/export/{orders,topups,wallet}.csv?from=&to=` (local days, up to 366 days, 5,000 rows) |
| Pages (Worker) | `/`, `/c/<slug>`, `/p/<slug>`, `/legal/<slug>` with their head tags and content for crawlers, `/sitemap.xml`, `/robots.txt` |
| Admin (owner) | wallet adjust, user role/ban, supplier sync, catalogue (`/api/admin/catalog`, categories, products, offers, stock, supplier settings), coupons (`GET/POST /api/admin/coupons`, `PATCH /api/admin/coupons/:id`) |

Errors are `{ "error": { "code": "...", "field": "..." } }` with stable codes the
UI translates. State-changing requests must come from the store's own origin or
carry a bearer token.

## Promotions

- **Invite rewards.** Every customer has a 7-character code. Links:
  `t.me/<bot>?start=r_<code>` (the bot links the friend on /start),
  `?startapp=r_<code>` (Mini App) and `/?ref=<code>` (website). Only customers who
  joined in the last day and have no orders can be linked, once. The inviter gets
  `referral.percent`% of what the friend pays for each delivered order during
  `referral.days` days (0 = always). Settings in Admin → Settings.
- **Coupons.** Percent (optionally capped) or fixed amount; minimum order; one
  product or all; total and per-customer limits; start/end dates. A discount never
  takes an order below its cost or to zero. `orders.total_cents` is what the
  customer paid (`unit price × quantity − discount_cents`), so refunds, revenue and
  profit stay right. A refunded order gives its coupon use back.
- **Buy again.** `offers.remind_after_days` (e.g. 28 for a 1-month plan). One
  Telegram message with a button that opens the product, unless the customer
  already bought it again or turned notifications off.

## Customer fields

Each package lists what the customer types before buying (`offers.input_fields`):
a key, Arabic and English labels, required or not, an optional pattern, and
optionally a fixed list of `options` (a game server, a region) shown as chips or
a menu. Keys stay exactly as the supplier names them ("Player_ID", Arabic names),
because the supplier reads them back. Orders accept only a listed option.

## Link previews and search (SEO)

The web app is one page, so the Worker (`run_worker_first` in `wrangler.jsonc`)
answers the public pages itself (`seo.ts`): `/`, `/c/<slug>`, `/p/<slug>` and
`/legal/<slug>` come back as index.html with that page's title, description,
picture (Open Graph, Twitter card), structured data (Organization and WebSite,
ItemList, Product with its price range, BreadcrumbList) and the page's content
as plain HTML inside `#root` for crawlers; the app replaces it when it starts
(the splash covers it). Each page exists in both languages: the default
(Arabic) at its plain address and English at `?lang=en`, linked to each other
with hreflang; the web app opens in the language of `?lang=`. A database
hiccup falls back to the plain page; an unknown page answers 404.

The owner sets the home page's search title and description, the share picture
(default `client/public/promo/share.jpg`), Search Console / Bing verification
codes and an "indexing" switch in Admin → SEO & pages; a product can have its
own search title and description (Catalog → product → Search engines).
`/sitemap.xml` lists the home page, categories, products on sale and published
pages, each language version with its alternates; `/robots.txt` keeps the
private screens (`/admin`, `/api`, `/tg`, `/login`, `/wallet`, `/orders`,
`/profile`) out, or everything when indexing is off.

**Store pages.** `/legal/<slug>` shows the terms, privacy and refund policies
(built-in texts in `legal-defaults.ts`, written for how this store works) or
the owner's edited version (`app.pages`, migration 0026), plus pages the owner
adds. The text uses a few marks parsed by `parseDoc` in `@store/core` (headings,
lists, bold, https/mailto links) for both the server's HTML and the app; `{store}`,
`{site}`, `{url}` and `{contact}` are filled in when shown. Published pages
marked "in the footer" are linked at the bottom of the store, in Profile and on
the sign-in page ("By continuing, you agree to…"). The bot answers `/terms`
and `/paysupport` (Telegram asks bots that take Stars for one).

## Reports

- **Daily summary** (Telegram, every owner): sales, orders, profit after supplier
  cost and invite rewards, top-ups, new customers, and what needs attention
  (failed or open orders, top-ups to review, low supplier balances), for the
  previous complete day. Sent once a day in the hour `reports.daily_hour`
  (default 9) of `store.timeZone`; on/off in Admin → Settings.
- **Profit** (Admin → Profit, owner; `GET /api/admin/reports/profit?from=&to=`,
  local days, up to 366): sales, cost, profit after invite rewards, margin,
  orders, customers, in-person sales, compared with the period just before;
  charts by day (weeks or months for long ranges), supplier, product, category
  and top-up method; and a price calculator that uses the store's own pricing
  rules (`priceFromCost`, the margin guard) with a payment fee and sales per day.
- **Supplier balances** (Admin → Overview): each balance with what its orders
  cost over the last 7 days and how many days it lasts at that pace.
- **Daily summary** also lists sales made in person (cash the owner holds).
- **CSV exports** (Admin → Overview): orders, top-ups, wallet history for 7/30/90
  days or a year. UTF-8 with a BOM so Excel shows Arabic; cells that look like
  formulas are written as text.
