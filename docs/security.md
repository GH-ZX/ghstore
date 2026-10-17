# Security

What protects money, codes and accounts, and what the owner must do.

## Money

- Integer US cents everywhere (`bigint`), never floating point.
- The Worker's database role (`store_app` → `store_server`) has **no** insert,
  update or delete on `app.wallets` or `app.ledger`. Balances change only inside
  `SECURITY DEFINER` functions that lock the wallet and write a ledger row in the
  same transaction. A balance can never go below zero (check constraint).
- Exactly once: the ledger is unique on `(kind, ref_type, ref_id)`, so a top-up is
  credited once and an order is refunded once, however many times a webhook or
  job retries. Orders are unique per `(user, idempotency key)`.
- Guard triggers refuse any direct change of a payment to `paid` or an order to
  `refunded` that did not come with its ledger row.
- `SELECT sum(amount_cents) FROM app.ledger WHERE user_id = …` always equals the
  wallet balance (tested).

## Payments

- Webhooks are wake-ups only. After checking a webhook's signature or secret, the
  store asks the provider for the payment and credits what the provider reports,
  never the amount in the callback body.
- Telegram Stars: credited from `successful_payment` on the authenticated bot
  webhook, only when the payer is the account that opened the invoice and the
  Stars cover the price.
- Manual USDT (BEP20): each open request has its own exact amount to send (the
  request plus a 0.0100–0.0199 tag, e.g. 10.0137, enforced by a unique index). A transaction counts only if it sends that exact
  amount of the real USDT contract to the store address, was mined after the
  request, and has 20 confirmations. A hash can be used once in the whole store.
  So a public transaction hash cannot be claimed by someone else.
  There are 100 tags per dollar amount, so a customer may hold at most **2**
  waiting USDT requests at a time (a trigger on `app.payments`, migration 0032);
  a few accounts cannot hold every tag for a popular amount.
- Anything unusual (underpaid, overpaid, wrong payer, unreadable amount) goes to
  **review**; a person approves it with the amount actually received.

## Accounts and sessions

- Mini App sign-in: Telegram `initData` HMAC checked with the bot token, at most
  **1 hour** old (initData works as a bearer login while it is accepted, and the
  Mini App signs in right after opening). Website sign-in: the Supabase access token is checked with Supabase
  once, then exchanged for the store's own session.
- Sessions are signed with `SESSION_SECRET` (not the bot token) and tied to a
  database row: logout, bans and role changes take effect immediately.
  Unknown or revoked sessions fail closed.
- Every sign-in creates a session row; an account keeps at most 20 live
  sessions per channel (web, Mini App), and signing in again ends the oldest.
- Cookies are `HttpOnly; Secure; SameSite=Lax`. Requests that change something must
  come from the store's own origin or carry a bearer token (CSRF).
- Roles: `customer`, `monitor` (looks at orders, top-ups and customers; changes
  nothing), `support` (also top-up review, retries, refunds), `owner` (settings,
  wallets, roles, catalogue, keys, broadcasts). Every admin action is written to
  `app.audit_log`.
- Linking logins: a login is attached only after Telegram or Supabase Auth has
  verified it, and only with a one-time token the same session asked for
  (`/api/me/link/start`, 10 minutes, stored hashed), so a crafted link carrying
  someone else's login does nothing; Telegram links are also confirmed on
  screen and must be fresh. If the login already belongs to another account,
  the logins of an unused, active account (no ledger, orders or payments) move
  over and it is signed out; blocked accounts and two accounts with history
  are never merged. Removing a login signs out every other session.
- The website sign-in switches (Admin → Settings) are enforced by the API, not
  only hidden on the page: a Google or email token is refused while that
  method is off.
- Email receipts never contain delivered codes, and every value in them is
  HTML-escaped. Broadcasts are plain text (no Telegram formatting).
- Owners come only from `OWNER_TELEGRAM_IDS` or another owner.

## Throttles

`app.rate_limits` counts requests per key in fixed windows; `app.rate_limit_hit`
(migration 0032, the Worker's only access to the table) counts and checks in one
statement and deletes windows that are over now and then, so no job is needed.
Over the limit, the API answers `429 rate_limited`. Limits live in
`packages/api/src/ratelimit.ts`:

| What | Key | Limit |
| --- | --- | --- |
| Sign-in (`/api/auth/telegram`, `/telegram-widget`, `/web`) | address (`CF-Connecting-IP`; IPv6 by /64) | 100 per 10 min |
| Sign-in | Telegram id or website account | 30 per 10 min |
| Coupon quotes | customer | 20 per 10 min (stops guessing codes) |
| Problem reports | customer | 10 per hour |
| Review saves | customer | 20 per hour |

Without `CF-Connecting-IP` (local runs, tests) the per-address limit is skipped;
the per-account ones still apply. `X-Forwarded-For` is never trusted.

## Delivered goods

- Codes, accounts and links are encrypted at rest with AES-GCM (`DATA_KEY`),
  including manual stock uploaded by the owner. Customers see them only on
  their own orders.
- Staff: admin order details mask delivered codes; revealing them is an
  explicit action and is written to `app.audit_log`.
- Users only ever see their own orders: ownership is part of every query, and a
  stranger's order is "not found".

## Database exposure

- Everything lives in schema `app`, which the Supabase Data API does not expose;
  `anon` and `authenticated` have no rights on it (tested). Row-level security is on
  for every table as a second layer.
- On the existing gh-store project, Phase 0 also removed public `EXECUTE` from
  internal and trigger functions of the current site and pinned their
  `search_path`.

## Suppliers and prices

- The hourly margin guard pauses any offer whose supplier cost would make it sell
  at a loss (or under the minimum margin), and offers the supplier stopped selling.
- A failed or empty supplier catalogue is never read as "everything was removed".
- Stuck orders go to a person; they are never refunded automatically, because the
  supplier may still deliver.

## Secrets

- No secrets in git: `.env*` and `.dev.vars` are ignored; `.env.example` lists
  names only. Production secrets live in Cloudflare (`wrangler secret put`).
- Supplier and provider errors are logged without keys (adapters mask them,
  and also mask any `token=` / `secret=` / `key=` query value, in case a
  provider echoes our callback URL back).
- Payment and supplier keys can also be set in Admin → Settings → Keys
  (encrypted with `DATA_KEY`, never shown again), and win over a Worker secret
  of the same name. That includes `NOWPAYMENTS_IPN_SECRET`. The bot token,
  `DATA_KEY`, `SESSION_SECRET`, `TELEGRAM_WEBHOOK_SECRET` and the SAM and
  supplier webhook secrets are Worker secrets only.
- **Webhook secrets in URLs.** SAM signs nothing, so its callback carries
  `?token=<SAM_WEBHOOK_SECRET>`; G2Bulk callbacks carry `?token=` too. Suppliers
  that can send a header (`X-Supplier-Webhook-Secret` / `X-Webhook-Secret`)
  are checked by the header first. A secret in a URL appears in **Cloudflare's
  request logs** (Workers Logs / Logpush, dashboard) and in the provider's own
  records: treat access to those logs as access to the secret, and rotate the
  secret if a log export leaks. The store's own logging never prints full
  request URLs (errors are recorded by method and path only). NOWPayments
  callbacks are signed (HMAC header) and carry no secret.

## Owner checklist

- [ ] Turn on 2FA for Cloudflare, Supabase, GitHub and every supplier account.
- [ ] Keep `DATA_KEY` and `SESSION_SECRET` in a password manager. Rotating
      `SESSION_SECRET` signs everyone out; `DATA_KEY` must not be lost.
- [ ] Use a receiving USDT address that only this store uses.
