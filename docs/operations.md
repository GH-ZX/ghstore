# Running the store

How the store is watched, backed up and rolled back. The store itself is
described in `architecture.md`; launching one in `launch-a-store.md`.

## Alerts the owner gets (Telegram)

Sent to every owner by the store bot (or the staff-alerts bot, when set):

| Alert | When |
|---|---|
| New order | Each order, to all staff (Admin → Settings → order alerts) |
| Order can't be bought from its supplier | The supplier refused it or failed after its retries: the order waits in Admin → Orders → Waiting (or was refunded, with "Keep orders a supplier can't deliver" off) |
| Problem on an order | A customer used "Report a problem" (Admin → Orders → Problems) |
| Stuck orders | Open longer than "max pending hours" |
| Supplier balance low | Under the supplier's threshold (Admin → Suppliers) |
| Supplier not answering | Its balance check fails (once every 6 hours while it lasts) |
| Job failing | A scheduled job failed 3 times in a row, and again when it recovers |
| Job not finishing | Orders or messages haven't finished for 15 minutes |
| Server errors | 5 or more unexpected errors in 15 minutes (once an hour); details in `app.error_log` (kept a week) |
| USDT checker down | Its log server refused for an hour (USDT top-ups then need the hash pasted) |
| Daily summary | Every day at the hour set in Admin → Settings |

These come from inside the Worker, so they stop if the Worker's scheduled runs
stop. The watchdog below covers that case from outside.

## Watchdog

`.github/workflows/watchdog.yml` runs every 15 minutes on GitHub: it opens the
home page and `/api/health?deep=1`, which answers 503 when the database does
not answer or the orders and messages jobs haven't run for 10 minutes. A failed
run emails you (github.com → Settings → Notifications → Actions: "Send
notifications for failed workflows only"). To get a Telegram message too, add
two repository secrets (Settings → Secrets and variables → Actions):
`WATCHDOG_TELEGRAM_TOKEN` (a bot token, e.g. the staff-alerts bot) and
`WATCHDOG_TELEGRAM_CHAT` (your Telegram user id; open the bot and send it
/start first).

### When the watchdog fails

1. Open the site. If it doesn't load: Cloudflare → Workers & Pages → ghstore →
   Deployments: is the latest one live? Roll back if a deploy broke it.
2. If it loads but the jobs stopped: Cloudflare → ghstore → Settings → Trigger
   events: the cron `* * * * *` must be there. Admin → Overview shows each job's
   last run and error.
3. Database: Supabase → project gh-store → is it paused or over a limit?

## After each deploy

`.github/workflows/after-deploy.yml` runs on every push to `main`: it waits
until `/version.txt` shows the pushed commit (the build writes it), then checks
the home page (both languages), health, config, catalogue, a product page, a
legal page, sitemap, robots, the Mini App, and that an unknown page answers 404.
A failure emails you.

## Rollback

The quickest way back to the version that worked: Cloudflare → Workers & Pages
→ ghstore → Deployments → the previous deployment → "Rollback to this
deployment". From a computer with Wrangler signed in:

```bash
cd apps/web && npx wrangler rollback
```

Then fix the problem in the code and push again (the next push deploys over
the rollback). A rollback does not undo database migrations: they are additive,
so the previous code keeps working with them.

## Backups

`.github/workflows/backup.yml` copies the database every night at 01:30 UTC
(the `app` and `legacy` schemas, plus the Supabase logins `auth.users` and
`auth.identities`), encrypts it with your passphrase (AES-256, gpg) and keeps it
30 days as a workflow artifact. It checks the copy can be read back. Product
pictures in Supabase Storage are not in it (they are also linked from their
original sites).

Set up once, in GitHub → Settings → Secrets and variables → Actions:

- `BACKUP_DATABASE_URL`: Supabase → Connect → "Session pooler" connection
  string, with the database password in it (GitHub's runners need the pooler:
  the direct address is IPv6 only).
- `BACKUP_PASSPHRASE`: a long passphrase. Keep it in your password manager:
  without it a backup can't be opened.

Then run it once by hand: Actions → Database backup → Run workflow.

### Restore

1. Actions → Database backup → a run → Artifacts → download it, unzip.
2. Decrypt and unpack:

   ```bash
   gpg --decrypt store-backup-2026-10-18.tar.gz.gpg > store-backup.tar.gz
   tar -xzf store-backup.tar.gz
   ```

3. Look before restoring (a list of what is inside): `pg_restore --list store.dump`.
4. Into the live database, replacing its tables (stop and think first: this
   overwrites what changed since the backup):

   ```bash
   pg_restore --clean --if-exists --no-owner --no-privileges -d "$DATABASE_URL" --schema=app store.dump
   ```

   Into a new Supabase project instead: apply the migrations first
   (`pnpm db:migrate` with its `DATABASE_URL`), then restore the data only with
   `--data-only --disable-triggers`. `auth.dump` holds the logins
   (data only), for a new project's `auth` schema.

Practise a restore into a scratch database now and then, so the day it matters
is not the first time.

## Error log

Unexpected server errors (not a customer's wrong input) are written to
`app.error_log` with the request and the message, kept a week:

```sql
select at, source, message from app.error_log order by at desc limit 50;
```
