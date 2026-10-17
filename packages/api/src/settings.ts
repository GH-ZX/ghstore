/**
 * Store settings the owner changes in Admin → Settings (rows in app.settings),
 * read where they are needed. Nothing here has a value in code: a store copy
 * sets its own in the admin, and gh-store's come over from the old site.
 */
import type { Db } from "./db";
import { BOT_USERNAME, settingValue, type PictureMode, type ShowcaseStyle } from "./settings-registry";

export interface SupportContacts {
  /** Telegram username without @. */
  telegram: string | null;
  /** WhatsApp number in international form, digits only (963…). */
  whatsapp: string | null;
  email: string | null;
}

export async function readSettings(db: Db, keys: string[]): Promise<Record<string, unknown>> {
  const rows = await db.query<{ key: string; value: unknown }>(
    `select key, value from app.settings where key = any(string_to_array($1::text, ','))`,
    [keys.join(",")],
  );
  return Object.fromEntries(rows.map((r) => [r.key, r.value]));
}

export async function supportContacts(db: Db): Promise<SupportContacts> {
  const s = await readSettings(db, ["support.telegram", "support.whatsapp", "support.email"]);
  return {
    telegram: settingValue(s, "support.telegram"),
    whatsapp: settingValue(s, "support.whatsapp"),
    email: settingValue(s, "support.email"),
  };
}

/** Stars charged per US dollar, or null when Stars top-ups are switched off. */
export async function starsPerUsd(db: Db): Promise<number | null> {
  return settingValue(await readSettings(db, ["payments.stars_per_usd"]), "payments.stars_per_usd");
}

/** The store bot's username: saved by Connect bot, else store.config.ts. */
export async function botUsername(db: Db): Promise<string> {
  return settingValue(await readSettings(db, ["telegram.bot_username"]), "telegram.bot_username");
}

/** The store's Telegram channel link, or null. */
export async function channelUrl(db: Db): Promise<string | null> {
  return settingValue(await readSettings(db, ["telegram.channel_url"]), "telegram.channel_url");
}

export interface ShowcaseSettings {
  /** The look of slides that do not pick their own. */
  style: ShowcaseStyle;
  /** The "Instant" badge on deal slides. */
  badgeInstant: boolean;
  /** The product's or category's name above a slide's title. */
  badgeLabel: boolean;
  /** Seconds per slide, 0 = no autoplay. */
  autoplay: number;
  /** How many packages a deal slide shows. */
  dealPackages: number;
  /** Which picture slides show by default. */
  pictureMode: PictureMode;
}

/** The showcase's settings (Admin → Home), with the defaults for anything not set. */
export async function showcaseSettings(db: Db): Promise<ShowcaseSettings> {
  const s = await readSettings(db, ["home.showcase_style", "home.badge_instant", "home.badge_label", "home.autoplay_seconds", "home.deal_packages", "home.picture_mode"]);
  return {
    style: settingValue(s, "home.showcase_style"),
    badgeInstant: settingValue(s, "home.badge_instant"),
    badgeLabel: settingValue(s, "home.badge_label"),
    autoplay: settingValue(s, "home.autoplay_seconds"),
    dealPackages: settingValue(s, "home.deal_packages"),
    pictureMode: settingValue(s, "home.picture_mode"),
  };
}

/** Remember the bot's username as Telegram reports it (no write when unchanged). */
export async function saveBotUsername(db: Db, username: string | null): Promise<void> {
  if (!username || !BOT_USERNAME.test(username)) return;
  await db.query(
    `insert into app.settings (key, value, updated_at) values ('telegram.bot_username', $1::text::jsonb, now())
     on conflict (key) do update set value = excluded.value, updated_at = now() where app.settings.value is distinct from excluded.value`,
    [JSON.stringify(username)],
  );
}

/** Automatic badges (Admin → Home): how many products and over how long. */
export const AUTO_BADGES = { newDays: 14, newCount: 6, bestDays: 30, bestCount: 3, bestMinOrders: 3 } as const;

/**
 * The month's best sellers move slowly but are counted from the orders: kept a
 * few minutes per Worker instance, so busy catalogue views do not count them
 * again each time (the switches above are still read every time).
 */
const BEST_SELLERS_TTL_MS = 5 * 60_000;
let bestSellersMemo: { at: number; ids: string[] } | null = null;

async function bestSellers(db: Db): Promise<string[]> {
  if (bestSellersMemo && Date.now() - bestSellersMemo.at < BEST_SELLERS_TTL_MS) return bestSellersMemo.ids;
  const rows = await db.query<{ product_id: string }>(
    `select product_id from app.orders
      where status = 'delivered' and created_at > now() - make_interval(days => $1)
      group by product_id having count(*) >= $2
      order by count(*) desc, max(created_at) desc limit $3`,
    [AUTO_BADGES.bestDays, AUTO_BADGES.bestMinOrders, AUTO_BADGES.bestCount],
  );
  bestSellersMemo = { at: Date.now(), ids: rows.map((r) => r.product_id) };
  return bestSellersMemo.ids;
}

/**
 * Products that earn an automatic badge right now, for products whose badge is
 * left on "automatic" (null): Best seller for the most sold lately, New for the
 * newest. Each can be switched off (badges.auto_best / badges.auto_new).
 */
export async function autoBadges(db: Db): Promise<Map<string, "new" | "best">> {
  const s = await readSettings(db, ["badges.auto_new", "badges.auto_best"]);
  const out = new Map<string, "new" | "best">();
  if (settingValue(s, "badges.auto_best")) {
    for (const id of await bestSellers(db)) out.set(id, "best");
  }
  if (settingValue(s, "badges.auto_new")) {
    const fresh = await db.query<{ id: string }>(
      `select id from app.products where active and created_at > now() - make_interval(days => $1)
        order by created_at desc, sort, name_en limit $2`,
      [AUTO_BADGES.newDays, AUTO_BADGES.newCount],
    );
    for (const f of fresh) if (!out.has(f.id)) out.set(f.id, "new");
  }
  return out;
}

/** The badge a product shows: the owner's, none, or the automatic one it earned. */
export function effectiveBadge(badge: string | null, auto: Map<string, string>, productId: string): string | null {
  if (badge === "none") return null;
  return badge ?? auto.get(productId) ?? null;
}

/**
 * Safer top-ups (Admin → Settings): a new account (under a day old, nothing
 * delivered yet) can't top up more than `newAccountMaxCents` at once, and
 * nobody starts more than `perHour` top-ups an hour.
 */
export async function topupSafety(db: Db): Promise<{ newAccountMaxCents: number; perHour: number }> {
  const s = await readSettings(db, ["payments.new_account_max_cents", "payments.topups_per_hour"]);
  return { newAccountMaxCents: settingValue(s, "payments.new_account_max_cents"), perHour: settingValue(s, "payments.topups_per_hour") };
}

/** The smallest and largest top-up a customer may ask for (the largest never below the smallest). */
export async function topupLimits(db: Db): Promise<{ minCents: number; maxCents: number }> {
  const s = await readSettings(db, ["payments.min_topup_cents", "payments.max_topup_cents"]);
  const minCents = settingValue(s, "payments.min_topup_cents");
  return { minCents, maxCents: Math.max(minCents, settingValue(s, "payments.max_topup_cents")) };
}
