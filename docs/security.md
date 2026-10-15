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
- Manual USDT (BEP20): each open request has its own exact amount (e.g. 10.37,
  enforced by a unique index). A transaction counts only if it sends that exact
  amount of the real USDT contract to the store address, was mined after the
  request, and has 20 confirmations. A hash can be used once in the whole store.
  So a public transaction hash cannot be claimed by someone else.
- Anything unusual (underpaid, overpaid, wrong payer, unreadable amount) goes to
  **review**; a person approves it with the amount actually received.

## Accounts and sessions

- Mini App sign-in: Telegram `initData` HMAC checked with the bot token, at most
  24 hours old. Website sign-in: the Supabase access token is checked with Supabase
  once, then exchanged for the store's own session.
- Sessions are signed with `SESSION_SECRET` (not the bot token) and tied to a
  database row: logout, bans and role changes take effect immediately.
  Unknown or revoked sessions fail closed.
- Cookies are `HttpOnly; Secure; SameSite=Lax`. Requests that change something must
  come from the store's own origin or carry a bearer token (CSRF).
- Roles: `customer`, `support` (top-up review, orders), `owner` (settings, wallets,
  roles, catalogue). Every admin action is written to `app.audit_log`.
- Owners come only from `OWNER_TELEGRAM_IDS` or another owner.

## Delivered goods

- Codes, accounts and links are encrypted at rest with AES-GCM (`DATA_KEY`),
  including manual stock uploaded by the owner. They are decrypted only for the
  order's owner.
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
- Supplier and provider errors are logged without keys (adapters mask them).

## Owner checklist

- [ ] Make `gh-store-tele` and `gh-store-dev` private.
- [ ] Rotate every key that was ever committed or used on the work server: bot
      token (@BotFather → Revoke), supplier keys, SAM/NOWPayments keys, the
      Postgres and Redis passwords from the old server.
- [ ] Change the ghawi.app admin password (it was shared in a chat).
- [ ] Turn on 2FA for Cloudflare, Supabase, GitHub and every supplier account.
- [ ] Keep `DATA_KEY` and `SESSION_SECRET` in a password manager. Rotating
      `SESSION_SECRET` signs everyone out; `DATA_KEY` must not be lost.
- [ ] Use a receiving USDT address that only this store uses.
