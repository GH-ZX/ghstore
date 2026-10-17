# Next up

Work in progress and what the owner still has to do. Confirm a plan with the
owner before building, and show screenshots (mobile and desktop, Arabic and
English) before calling a UI change done. What is done is in `CHANGELOG.md`.

## v1.0 is out (2026-10-18)

Everything in `CHANGELOG.md` is live on gh-store.me; migrations up to
`0028_problems_health.sql` are on the live database.

## The owner's to-do

- **Supplier balances**: top up 5SIM (numbers can't sell without it) and the
  others before they run out (Admin → Overview shows days left).
- **Backups**: add `BACKUP_DATABASE_URL` and `BACKUP_PASSPHRASE` as GitHub
  repository secrets, then run Actions → Database backup once
  (`docs/operations.md` → Backups).
- **Watchdog by Telegram** (optional): `WATCHDOG_TELEGRAM_TOKEN` and
  `WATCHDOG_TELEGRAM_CHAT` secrets; GitHub emails failures without them.
- **Legal pages**: read and adapt the terms, privacy and refund texts (Admin →
  SEO & pages); they are ready texts until edited.
- **Cloudflare Web Analytics**: paste the site's token in Admin → SEO & pages.
- **Smaller pictures**: turn on Cloudflare Images → Transformations for
  gh-store.me (any origin), then Admin → Settings → Smaller pictures.
- **Search Console**: submit `https://gh-store.me/sitemap.xml`.
- **Bot menu**: Admin → Settings → Connect bot once (adds /terms, /paysupport).
- **Supabase Auth**: keep "Confirm email" on; an SMTP sender for customer codes.
- **Workers paid plan** ($5/month), in a few days: lifts the 50-requests-per-run
  limit the scheduled jobs share.

## Asked for, not started

- **MaxStore**: a real 10¢ order ("10 ليرة MTN") before relying on it.
- **Wide covers** for the games still without one (Mobile Legends, Genshin, Free Fire…).

## Ideas for v1.1

- A second supplier per package taking over automatically when the first fails.
- Web push notifications for website customers (email covers them today).
- Smaller translation files (the admin's strings load with the store today).
