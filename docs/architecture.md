# Architecture

## One Worker

Everything runs in a single Cloudflare Worker (`apps/web`):

| Path | What |
| --- | --- |
| `/api/*` | JSON API for the website, the Mini App and the admin |
| `/telegram/webhook` | Bot updates. Telegram sends the secret header set with `setWebhook` |
| `/`, `/tg`, `/admin` | The web app (next milestone; a branded placeholder for now) |
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
- **ui**: theme tokens and brand SVG, shared by the placeholder page now and the
  web app next.

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

Guard triggers stop anything else from setting an order or payment to
`paid`/`refunded`. IDs are UUIDv7 (time ordered). Order numbers are a sequence
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

## Top-up flow

| Method | How it is confirmed |
| --- | --- |
| Telegram Stars | `successful_payment` arrives on the authenticated bot webhook; amount and payer are checked against the invoice. Mini App only (Telegram's rule for digital goods). |
| ShamCash (SAM API) | SAM calls the callback URL, which carries a secret token; the store then asks SAM for the invoice status. |
| NOWPayments | IPN signature checked (HMAC-SHA512), then the payment is fetched from NOWPayments. |
| USDT BEP20 (manual) | The customer is shown a unique amount (e.g. 10.37) and pastes the transaction hash; the store reads the chain: right token, right address, exact amount, mined after the request, 20 confirmations. |

Anything that does not match exactly (underpaid, overpaid, wrong payer) goes to
**review** in the admin instead of being credited.

## Prices and the margin guard

Each offer has a supplier cost and a rule: percent markup, fixed markup, or a
manual price, plus a minimum margin and rounding. Every hour the sync job reads
each supplier's catalogue and:

- reprices computed offers when the cost changes;
- **pauses** a manual-price offer whose cost now eats the minimum margin;
- pauses offers the supplier stopped selling, and resumes them when they return;
- tells the owners in Telegram.

New supplier items are never added automatically: the owner imports them in the
admin (`GET /api/admin/suppliers/:id/products`, then create an offer).

## Scheduled jobs (every minute)

| Job | Work |
| --- | --- |
| `orders` | Fulfil/re-check due orders (leased, so overlapping runs are safe) |
| `stuck_orders` | Flag orders open too long, alert owners |
| `payments` | Re-check pending SAM/NOWPayments top-ups; expire old ones |
| `supplier_balances` | Every 15 min; alert once when a balance drops under its threshold |
| `supplier_sync` | Hourly per supplier: costs, availability, margin guard |
| `outbox` | Send queued Telegram notifications |

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
| Admin (owner) | wallet adjust, user role/ban, supplier sync, catalogue (`/api/admin/catalog`, categories, products, offers, stock, supplier settings) |

Errors are `{ "error": { "code": "...", "field": "..." } }` with stable codes the
UI translates. State-changing requests must come from the store's own origin or
carry a bearer token.
