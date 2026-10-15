/**
 * First-time setup helper. Prints fresh random secrets and the exact commands to
 * register them, the database role and the Telegram webhook. It writes nothing
 * and calls no API: copy the commands you need.
 *
 *   pnpm setup:store                               # secrets + commands for gh-store.me
 *   pnpm setup:store --domain shop.example --bot my_shop_bot
 */
import { randomBytes } from "node:crypto";

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1]! : fallback;
}

const domain = arg("domain", "gh-store.me").replace(/^https?:\/\//, "").replace(/\/$/, "");
const bot = arg("bot", "gh_store1_bot").replace(/^@/, "");
const token = (bytes: number) => randomBytes(bytes).toString("base64url");

const secrets = {
  SESSION_SECRET: token(48),
  DATA_KEY: randomBytes(32).toString("base64"),
  TELEGRAM_WEBHOOK_SECRET: token(32),
  SAM_WEBHOOK_SECRET: token(32),
  SUPPLIER_WEBHOOK_SECRET: token(32),
  DB_APP_PASSWORD: token(24),
};

const line = "─".repeat(72);
console.log(`
${line}
 GH Store setup for https://${domain} (bot @${bot})
 These values are shown once. Keep them in a password manager.
 DATA_KEY encrypts delivered codes: losing it makes old deliveries unreadable.
${line}
`);
for (const [k, v] of Object.entries(secrets)) console.log(`${k}=${v}`);

console.log(`
${line}
 1. Database role for the Worker (run in the Supabase SQL editor, after pnpm db:migrate)
${line}
create role store_app login password '${secrets.DB_APP_PASSWORD}' in role store_server;
alter role store_app set search_path = app, public;

${line}
 2. Hyperdrive (connection pooling from the Worker to Postgres)
${line}
# Copy the "Session pooler" string from Supabase → Connect (port 5432, works over IPv4), then put
# store_app in place of postgres in the user name. Not the transaction pooler (port 6543).
# Caching stays off: sessions, balances and payment states must always be read fresh.
cd apps/web
npx wrangler hyperdrive create ${domain.replace(/\W+/g, "-")}-db --caching-disabled \\
  --connection-string="postgres://store_app.<project-ref>:${secrets.DB_APP_PASSWORD}@aws-0-<region>.pooler.supabase.com:5432/postgres"
# put the printed id in apps/web/wrangler.jsonc (hyperdrive[0].id)

${line}
 3. Worker secrets (each command asks for the value; paste it from above)
${line}
npx wrangler secret put SESSION_SECRET
npx wrangler secret put DATA_KEY
npx wrangler secret put TELEGRAM_BOT_TOKEN          # from @BotFather
npx wrangler secret put TELEGRAM_WEBHOOK_SECRET
npx wrangler secret put OWNER_TELEGRAM_IDS          # your numeric Telegram id
npx wrangler secret put SUPABASE_PUBLISHABLE_KEY    # website login
# payments and suppliers you use, e.g.:
npx wrangler secret put SAM_API_KEY
npx wrangler secret put SAM_WEBHOOK_SECRET
npx wrangler secret put NOWPAYMENTS_API_KEY
npx wrangler secret put NOWPAYMENTS_IPN_SECRET
npx wrangler secret put SUPPLIER_WEBHOOK_SECRET
npx wrangler secret put G2BULK_API_KEY

${line}
 4. Deploy, then point Telegram at the Worker
${line}
pnpm ship        # or connect the GitHub repo in Cloudflare → Workers → Builds
curl -sS "https://api.telegram.org/bot<TELEGRAM_BOT_TOKEN>/setWebhook" \\
  -d url="https://${domain}/telegram/webhook" \\
  -d secret_token="${secrets.TELEGRAM_WEBHOOK_SECRET}" \\
  -d 'allowed_updates=["message","callback_query","pre_checkout_query"]'

# Mini App button: @BotFather → /mybots → @${bot} → Bot Settings → Menu Button → https://${domain}/tg

Webhooks:
  SAM and NOWPayments get their callback URL with every invoice; nothing to set.
  G2Bulk:  npx wrangler secret put G2BULK_CALLBACK_URL
           → https://${domain}/api/webhooks/suppliers/g2bulk
           (the secret is appended as ?token= automatically)
  Other suppliers with a dashboard webhook field:
           https://${domain}/api/webhooks/suppliers/<supplier-id>?token=<SUPPLIER_WEBHOOK_SECRET>
  Webhooks only wake an order up; the store always re-asks the provider before acting.
`);
