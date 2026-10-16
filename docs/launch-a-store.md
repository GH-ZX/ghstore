# Launch a store

The same steps launch GH Store and any copy of it. Allow about an hour the first
time. Nothing here needs the old work server.

## What you need

| Service | Plan | Why |
| --- | --- | --- |
| Cloudflare | Free to start; Workers Paid ($5/month) when traffic grows | The web app is static files (free, unlimited). Only `/api`, the bot and the cron run code; the free plan gives them 100,000 requests a day and 10 ms of CPU each (waiting for the database or a supplier does not count). Hyperdrive is included. |
| Supabase | Free to start (2 active projects; pauses after a week without traffic), Pro $25/month for production | Postgres and website login |
| Telegram | A bot from @BotFather | Bot, Mini App, Stars |
| A domain on Cloudflare | — | e.g. gh-store.me |
| Provider accounts | — | SAM, NOWPayments, a USDT (BSC) address you control, supplier API keys |

## 1. Make it yours (template copies only)

`store.config.ts` holds the name, the website address (`url`, the same as
`PUBLIC_BASE_URL`), the one-line tagline used in search results and link
previews, the languages and the time zone for daily numbers. Support contacts and
the Telegram Stars price are store settings in the admin (step 4 below).

1. Create a new **private** GitHub repository and upload this folder.
2. Edit `store.config.ts`: name, mark, default language and theme, Telegram bot
   username, order prefix.
3. Replace the files in `brand/` (keep the names). See `brand/README.md`.
4. In `apps/web/wrangler.jsonc`: `name`, `PUBLIC_BASE_URL`, `SUPABASE_URL`,
   `placement.region` (your Supabase region), and the route for your domain.
5. Edit `packages/db/migrations/0003_seed_settings.sql` if you want different
   starting categories (single words, Arabic and English kept separate).

## 2. Install and check

```bash
corepack enable
pnpm install          # commit the pnpm-lock.yaml it creates
pnpm typecheck
```

Optional but recommended: run the tests against a local Postgres (see README).

## 3. Secrets

```bash
pnpm setup:store --domain your-domain.com --bot your_bot
```

It prints fresh random values (session key, data key, webhook secrets, a database
password) and every command below with your domain filled in. Save the values in a
password manager. **`DATA_KEY` encrypts delivered codes: if you lose it, old
deliveries cannot be shown again.**

## 4. Database

The store uses its own private schema `app`, next to whatever is already in the
project (the current gh-store.me tables in `public` are not touched).

```bash
# Supabase → Connect → Direct connection (or Session pooler), as the postgres user
DATABASE_URL="postgres://postgres:...@...:5432/postgres" pnpm db:migrate
```

Then, in the Supabase SQL editor, create the Worker's login (the exact line, with the
generated password, is in the `setup:store` output):

```sql
create role store_app login password '...' in role store_server;
alter role store_app set search_path = app, public;
```

`store_app` can do only what `store_server` allows: no direct wallet or ledger
writes, money only through the SQL functions.

The migrations were checked against this Supabase project (Postgres 17) inside a
transaction that was rolled back, so nothing was created yet.

**gh-store only: bring the current catalogue over** (once, after the migrations):

```bash
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f packages/db/import/from-old-gh-store.sql
```

It copies the categories, products and packages of the current site from
`public` into `app` (nothing in `public` changes, and it is safe to run twice).
Each package keeps its supplier and today's price; the markup is set to today's,
so the hourly sync keeps prices in step with supplier costs. Customer fields come
along, with game servers as choices; stock goods (vouchers, codes) ask for
nothing, as on the old site. A rolled-back dry run on the live data (15 Oct 2026)
brought over all 75 products and 673 packages (655 on sale) with nothing skipped:
601 packages ask for customer details (21 with a server choice), 72 ask for
nothing. One package sits under the 5% margin floor, so the first sync will raise
its price a little. Customers, balances and orders are not copied.

## 5. Hyperdrive

```bash
cd apps/web
npx wrangler hyperdrive create gh-store-db --caching-disabled \
  --connection-string="postgres://store_app.<project-ref>:<password>@<session-pooler-host>:5432/postgres"
```

Or in the dashboard: Storage & Databases → Hyperdrive → Create configuration
(public database). Host = the Session pooler host from Supabase → Connect, port
5432, database `postgres`, **user `store_app.<project-ref>`** with its password
(not the `postgres` login Supabase shows there), caching off.

Put the id in `wrangler.jsonc` → `hyperdrive[0].id`.

- Use the **Session pooler** string (port 5432) unless your project has IPv4 on the
  direct connection. Never the transaction pooler (port 6543): Hyperdrive already
  pools.
- Keep **caching disabled**. Hyperdrive would otherwise serve reads up to 60 s old,
  and sessions, balances and payment states must always be fresh.
- The Workers free plan includes 100,000 Hyperdrive queries a day. The scheduled
  jobs use about 14,000 of them with no customers (the hourly price sync is a few
  queries per supplier, however many packages it checks); the rest is for visitors.

## 6. Website login

Choose the options in `wrangler.jsonc` → `vars.WEB_LOGIN_METHODS`
(`telegram,email,google`; gh-store starts with `telegram` only, so nothing in
Supabase Auth has to be set up for launch).

**Telegram (recommended: same account and wallet as the bot).** In @BotFather:
`/setdomain` → your bot → `your-domain.com`. Nothing else to set.

**Email code and Google (Supabase Auth).** Supabase → Authentication:

- Providers: Email on. For Google, turn on the Google provider with your Google
  OAuth client.
- Emails → "Magic Link" template: put `{{ .Token }}` in the message, so the email
  carries the 6-digit code the website asks for.
- URL configuration: Site URL `https://your-domain.com`; add
  `https://your-domain.com/login` to the redirect URLs (Google comes back there).

`SUPABASE_URL` and `SUPABASE_PUBLISHABLE_KEY` (Project Settings → API keys →
publishable key) are plain vars in `wrangler.jsonc`: both are meant for browsers,
and the website reads them from `/api/config`.

## 7. Worker secrets

From `apps/web`, one `npx wrangler secret put NAME` per line of the `setup:store`
output, or in the dashboard: Workers & Pages → `ghstore` → Settings → Variables
and Secrets → Add (type **Secret**). Required: `SESSION_SECRET`, `DATA_KEY`,
`TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET`, `OWNER_TELEGRAM_IDS`. Then only
the payment methods and suppliers you use (`.env.example` lists every name, and
each adapter file explains its own keys at the top). Names already set as vars in
`wrangler.jsonc` (`SUPABASE_PUBLISHABLE_KEY`, `G2BULK_CALLBACK_URL`) are not added
again as secrets.

`PAYMENT_METHODS` in `wrangler.jsonc` decides which top-up methods are offered.

## 8. Deploy

Either:

- **Git deploys (recommended, like gh-store-dev today)**: Cloudflare → Workers &
  Pages → Create → Import a repository → pick the repository, then:

  | Setting | Value |
  | --- | --- |
  | Project (Worker) name | `ghstore` (must match `wrangler.jsonc`) |
  | Root directory | `apps/web` |
  | Build command | `cd ../.. && pnpm install --no-frozen-lockfile` |
  | Deploy command | `pnpm run deploy` |
  | Build variable | `SKIP_DEPENDENCY_INSTALL` = `1` |

  The build variable stops Cloudflare's own install step, which would pick npm
  while the repository has no `pnpm-lock.yaml`; the build command installs the
  pnpm workspace from the repository root instead. Every push to `main` deploys,
  so keep `main` green (CI runs on every push and pull request).
- **By hand**: `pnpm ship`.

The Worker is named `ghstore`. **Do not rename it to `gh-store`**: that name
belongs to the current live site's Worker, and deploying under it would replace
the live site at once.

Test first on the temporary address `https://ghstore.<account>.workers.dev`:
set `PUBLIC_BASE_URL` (in `wrangler.jsonc` or the dashboard's variables) to that
address while testing, because the API accepts website requests only from that
origin. Check `…/api/health` → `{"ok":true}`.

Switch-over, when the test passes: set `PUBLIC_BASE_URL` back to
`https://gh-store.me`, then in Cloudflare move the custom domain gh-store.me from
the old `gh-store` Worker to `ghstore` (or add `routes` with `custom_domain: true`
in `wrangler.jsonc`), and www.gh-store.me with it: the store sends www visitors to
gh-store.me itself. That is the moment customers see the new store.

## 9. Telegram

In @BotFather (once):

- `/mybots` → your bot → Bot Settings → Configure Mini App → Main Mini App →
  `https://your-domain.com/tg` (this makes `t.me/<bot>?startapp=…` links open the
  store, and puts an **Open** button on the bot's profile)
- `/setdomain` → your bot → `your-domain.com` (Telegram login on the website)
- Edit Bot → Edit Botpic → `brand/telegram-avatar.png`
- Payments are not needed for Stars.

Then open the bot's Mini App with the Telegram account in `OWNER_TELEGRAM_IDS`
(it becomes the owner), go to Profile → Admin → **Settings → Telegram bot** and tap
**Connect bot**. That sets the webhook with your `TELEGRAM_WEBHOOK_SECRET`, the
command menu in Arabic and English, and the menu button that opens the store, and
shows whether Telegram delivers the bot's messages to the store.

Connecting switches the bot away from the old server for good (a bot has one
webhook, and polling stops once it is set). The old Python bot can then be stopped.

<details>
<summary>The same by hand (Bot API calls)</summary>

```bash
curl -sS "https://api.telegram.org/bot<TOKEN>/setWebhook" \
  -d url="https://your-domain.com/telegram/webhook" \
  -d secret_token="<TELEGRAM_WEBHOOK_SECRET>" \
  -d 'allowed_updates=["message","callback_query","pre_checkout_query"]'
```

The bot's command menu (once):

```bash
curl -sS "https://api.telegram.org/bot<TOKEN>/setMyCommands" -H 'content-type: application/json' -d '{"commands":[
  {"command":"start","description":"Open the store"},
  {"command":"balance","description":"Your balance"},
  {"command":"orders","description":"Your latest orders"},
  {"command":"invite","description":"Invite friends"},
  {"command":"help","description":"Help"}]}'
curl -sS "https://api.telegram.org/bot<TOKEN>/setMyCommands" -H 'content-type: application/json' -d '{"language_code":"ar","commands":[
  {"command":"start","description":"افتح المتجر"},
  {"command":"balance","description":"رصيدك"},
  {"command":"orders","description":"آخر طلباتك"},
  {"command":"invite","description":"ادعُ أصدقاءك"},
  {"command":"help","description":"المساعدة"}]}'
```

Menu button: @BotFather → `/mybots` → your bot → Bot Settings → Menu Button →
`https://your-domain.com/tg`.

</details>

## 10. First run

1. Sign in with the Telegram account in `OWNER_TELEGRAM_IDS` (done in § 9): it
   becomes the owner.
2. In **Admin → Suppliers**, switch on the suppliers you set keys for and set a
   low-balance alert. Packages of a supplier that is off are hidden from the store,
   and a payment method appears only once its keys are set.
3. Add products in **Admin → Catalogue**: create a product, then "Import from
   supplier" to pick the supplier's items and set the markup (the price preview
   uses the same margin rule the server enforces). Codes and accounts you sell
   yourself go in a package with "Manual stock" → "Add stock".
4. **Admin → Settings**: pick the theme (Calm, Energetic, Minimal, Warm) and the
   default light/dark mode, and the SYP rate if you want Syrian pound prices shown.
   - **Support contact**: the Telegram username, WhatsApp number and email shown
     under Profile → Help and support and in the bot's /help. (For gh-store the
     import copies them from the old site.)
   - **Telegram Stars**: Stars per $1, starting at **80**. Telegram pays you about
     $0.013 per Star, so 77 Stars is about $1; 80 leaves a small margin. Each
     invoice keeps the price it was issued at. Empty switches Stars off.
   - **Invite rewards** start **on at 2% for 90 days**; change or switch them off
     here.
5. Optional: **Admin → Coupons** for launch codes, and "Buy-again reminder after
   (days)" on subscription packages in the catalogue (28 for a 1-month plan).
6. Make a $1 test top-up with each method and a test order.

## Moving from the old setup

- Balances in the old bot are small: settle them by hand, then start the new
  wallets at zero (decided).
- After the webhook moves and a few days pass without problems, turn off the
  tunnels to the work server (admin.gh-store.me, factory.gh-store.me).
