/**
 * Every setting the owner changes in Admin → Settings (a row in app.settings),
 * in one place: what the admin accepts (`check`, PUT /api/admin/settings/:key)
 * and what the store uses while a key is unset (`fallback`). The readers in
 * settings.ts and elsewhere go through settingValue(), so a key's default is
 * written only here.
 *
 * `usable` is how a reader tells a stored value works, when that is looser
 * than `check` (a value saved before a check was tightened keeps working):
 * readers accept what they always accepted. Without it, `check` decides.
 *
 * The database's own functions read a few keys too (referrals, loyalty,
 * top-up limits) with their defaults in SQL; see packages/db/migrations.
 */
import { store } from "@store/config";

// ───────────────────────────────────────────────────────── value formats

export const TELEGRAM_USERNAME = /^[A-Za-z][A-Za-z0-9_]{4,31}$/;
export const WHATSAPP_NUMBER = /^[1-9][0-9]{7,14}$/;
export const EMAIL = /^[^\s@<>"]{1,64}@[^\s@<>"]{1,180}\.[A-Za-z]{2,24}$/;
export const BOT_USERNAME = /^[A-Za-z][A-Za-z0-9_]{4,31}$/;
/** A public channel (t.me/name) or a private invite link (t.me/+code). */
export const CHANNEL_URL = /^https:\/\/t\.me\/(\+[A-Za-z0-9_-]{8,64}|[A-Za-z][A-Za-z0-9_]{4,31})$/;
/** A public channel's @name, or a numeric chat id (-100…). */
export const CHANNEL_CHAT = /^(@[A-Za-z][A-Za-z0-9_]{4,31}|-100\d{6,15})$/;
/** "Name <address@domain>" or a bare address. */
export const EMAIL_FROM = /^(?:[^<>\r\n"]{1,60} <[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,190}\.[A-Za-z]{2,24}>|[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,190}\.[A-Za-z]{2,24})$/;

/** The home page showcase's look: a poster per slide ("cinematic"), or a deal with its packages ("deal"). */
export const SHOWCASE_STYLES = ["cinematic", "deal"] as const;
export type ShowcaseStyle = (typeof SHOWCASE_STYLES)[number];

/** Which of a product's pictures the showcase shows: its wide cover, its square icon, or auto (the cover when it has one). */
export const PICTURE_MODES = ["auto", "wide", "square"] as const;
export type PictureMode = (typeof PICTURE_MODES)[number];

/** Autoplay choices for the showcase, in seconds per slide (0 = off). */
export const SHOWCASE_AUTOPLAY = [0, 4, 6, 8, 10, 12] as const;

/** Loyalty levels as stored: ascending spend thresholds, each with a cashback percent. */
export interface StoredTier {
  min_cents: number;
  percent: number;
}

/** The tiers as stored ({ min_cents, percent }), checked: 1 to 5, ascending, 0–10 %. */
export function validTiers(v: unknown): boolean {
  if (!Array.isArray(v) || v.length < 1 || v.length > 5) return false;
  let last = -1;
  for (const t of v) {
    if (!t || typeof t !== "object") return false;
    const min = (t as Record<string, unknown>).min_cents;
    const pct = (t as Record<string, unknown>).percent;
    if (typeof min !== "number" || !Number.isInteger(min) || min < 0 || min > 10_000_000 || min <= last) return false;
    if (typeof pct !== "number" || pct < 0 || pct > 10 || Math.round(pct * 100) !== pct * 100) return false;
    last = min;
  }
  return true;
}

// ───────────────────────────────────────────────────────── checks

const isBool = (v: unknown): v is boolean => typeof v === "boolean";
const isNum = (v: unknown): v is number => typeof v === "number";
const isStr = (v: unknown): v is string => typeof v === "string";
const intIn = (min: number, max: number) => (v: unknown) => isNum(v) && Number.isInteger(v) && v >= min && v <= max;
const positiveInt = (v: unknown) => isNum(v) && Number.isInteger(v) && v > 0;
const oneOf = (list: readonly unknown[]) => (v: unknown) => list.includes(v);
const matches = (re: RegExp) => (v: unknown) => isStr(v) && re.test(v);
const orNull = (check: (v: unknown) => boolean) => (v: unknown) => v === null || check(v);
const text = (max: number) => (v: unknown) => isStr(v) && v.trim().length >= 1 && v.length <= max;
const nonBlank = (v: unknown) => isStr(v) && v.trim() !== "";
const VERIFICATION = /^[A-Za-z0-9_-]{8,100}$/;

interface Spec<T> {
  check: (v: unknown) => boolean;
  fallback: T;
  usable?: (v: unknown) => boolean;
}
const spec = <T>(s: Spec<T>): Spec<T> => s;
const flag = (fallback: boolean) => spec<boolean>({ check: isBool, fallback });

export const SETTINGS = {
  "theme.preset": spec<string>({ check: oneOf(["calm", "energetic", "minimal", "warm"]), fallback: "energetic", usable: (v) => v != null }),
  "theme.default_mode": spec<string>({ check: oneOf(["system", "light", "dark"]), fallback: "system", usable: (v) => v != null }),
  "fx.syp_per_usd": spec<number | null>({ check: orNull((v) => isNum(v) && v > 0 && v < 1000), fallback: null, usable: isNum }),
  // Read in SQL by flagStuckOrders (jobs.ts), with this fallback.
  "orders.max_pending_hours": spec<number>({ check: intIn(1, 168), fallback: 24 }),
  "referral.enabled": flag(false),
  "referral.percent": spec<number>({ check: (v) => isNum(v) && v >= 0 && v <= 20 && Math.abs(Math.round(v * 100) - v * 100) < 1e-9, fallback: 0, usable: isNum }),
  "referral.days": spec<number>({ check: intIn(0, 3650), fallback: 0, usable: isNum }),
  "reports.daily": flag(true),
  // Support contacts customers see in the app and the bot (null hides one).
  "support.telegram": spec<string | null>({ check: orNull(matches(TELEGRAM_USERNAME)), fallback: null, usable: matches(TELEGRAM_USERNAME) }),
  "support.whatsapp": spec<string | null>({ check: orNull(matches(WHATSAPP_NUMBER)), fallback: null, usable: matches(WHATSAPP_NUMBER) }),
  "support.email": spec<string | null>({ check: orNull((v) => isStr(v) && v.length <= 120 && EMAIL.test(v)), fallback: null, usable: matches(EMAIL) }),
  // Telegram Stars charged per US dollar of balance (null = Stars top-ups off).
  "payments.stars_per_usd": spec<number | null>({ check: orNull(intIn(1, 1000)), fallback: null }),
  // Top-up limits for customers, in cents: $0.10 to $1,000 smallest, up to $10,000 largest.
  "payments.min_topup_cents": spec<number>({ check: intIn(10, 100_000), fallback: 100, usable: positiveInt }),
  "payments.max_topup_cents": spec<number>({ check: intIn(100, 1_000_000), fallback: 100_000, usable: positiveInt }),
  "reports.daily_hour": spec<number>({ check: intIn(0, 23), fallback: 9, usable: isNum }),
  // The store's Telegram channel (null = none). The bot's own username is learned from Telegram, not typed.
  "telegram.channel_url": spec<string | null>({ check: orNull(matches(CHANNEL_URL)), fallback: null }),
  "telegram.bot_username": spec<string>({ check: () => false, fallback: store.telegramBot, usable: matches(BOT_USERNAME) }),
  // Tell owners and support staff about each new order (read in SQL by alertNewOrder: on unless false).
  "notify.new_orders": flag(true),
  "login.email": flag(true),
  "email.receipts": flag(true),
  "email.from": spec<string | null>({ check: orNull(matches(EMAIL_FROM)), fallback: null }),
  "login.google": flag(false),
  // How the home page's showcase looks (Admin → Home): a poster per slide, or a deal with its packages.
  "home.showcase_style": spec<ShowcaseStyle>({ check: oneOf(SHOWCASE_STYLES), fallback: "cinematic" }),
  // The showcase's badges, autoplay (seconds per slide, 0 = off) and packages per deal slide.
  "home.badge_instant": flag(true),
  "home.badge_label": flag(true),
  "home.autoplay_seconds": spec<number>({ check: oneOf(SHOWCASE_AUTOPLAY), fallback: 6 }),
  "home.deal_packages": spec<number>({ check: intIn(2, 4), fallback: 3 }),
  "home.picture_mode": spec<PictureMode>({ check: oneOf(PICTURE_MODES), fallback: "auto" }),
  // Automatic badges on products left on "automatic": New (the newest) and Best seller (the most sold lately).
  "badges.auto_new": flag(true),
  "badges.auto_best": flag(true),
  // Search engines (Admin → SEO & pages). null = the built-in title / description / picture.
  "seo.title_ar": spec<string | null>({ check: orNull(text(70)), fallback: null, usable: nonBlank }),
  "seo.title_en": spec<string | null>({ check: orNull(text(70)), fallback: null, usable: nonBlank }),
  "seo.description_ar": spec<string | null>({ check: orNull(text(320)), fallback: null, usable: nonBlank }),
  "seo.description_en": spec<string | null>({ check: orNull(text(320)), fallback: null, usable: nonBlank }),
  "seo.image_url": spec<string | null>({ check: orNull((v) => isStr(v) && v.length <= 500 && /^https:\/\/[^\s"<>]{4,}$/.test(v)), fallback: null, usable: nonBlank }),
  "seo.google_verification": spec<string | null>({ check: orNull(matches(VERIFICATION)), fallback: null, usable: nonBlank }),
  "seo.bing_verification": spec<string | null>({ check: orNull(matches(VERIFICATION)), fallback: null, usable: nonBlank }),
  "seo.indexing": flag(true),
  // A supplier can't deliver: keep the order for the owner to finish by hand (true) or refund it at once (false).
  "orders.failed_to_owner": flag(true),
  // Ask for a review this many hours after delivery (0 = never).
  "reviews.ask_hours": spec<number>({ check: oneOf([0, 1, 3, 6, 12, 24, 48]), fallback: 3, usable: isNum }),
  // Product pictures resized by Cloudflare (Images → Transformations on for the domain).
  "images.resize": flag(false),
  // Safer top-ups: a new account's largest top-up, and top-ups per hour per customer.
  "payments.new_account_max_cents": spec<number>({ check: intIn(100, 1_000_000), fallback: 5000, usable: positiveInt }),
  "payments.topups_per_hour": spec<number>({ check: intIn(1, 50), fallback: 6, usable: positiveInt }),
  // Loyalty levels: cashback on delivered orders by what was spent in 30 days.
  "loyalty.enabled": flag(false),
  "loyalty.tiers": spec<StoredTier[]>({
    check: validTiers,
    fallback: [{ min_cents: 5000, percent: 1 }, { min_cents: 20000, percent: 2 }, { min_cents: 50000, percent: 3 }],
  }),
  // Posts to the store's channel: where (a public @name or a -100… id; null = the channel link), what, how many a day.
  "channel.chat": spec<string | null>({ check: orNull(matches(CHANNEL_CHAT)), fallback: null }),
  "channel.post_new": flag(false),
  "channel.post_back": flag(false),
  "channel.post_drops": flag(false),
  "channel.max_per_day": spec<number>({ check: intIn(1, 30), fallback: 6 }),
  // Cloudflare Web Analytics: the site's beacon token (null = off).
  "analytics.cf_token": spec<string | null>({ check: orNull(matches(/^[a-f0-9]{32}$/)), fallback: null, usable: isStr }),
  // Virtual numbers: how many times in a row a customer may report a number and get the next one.
  "numbers.max_retries": spec<number>({ check: intIn(1, 20), fallback: 5, usable: isNum }),
  // Browser notifications for website customers (off when unset: each one is a request on the free plan).
  "push.enabled": flag(false),
} as const;

export type SettingKey = keyof typeof SETTINGS;
export type SettingType<K extends SettingKey> = (typeof SETTINGS)[K] extends Spec<infer T> ? T : never;

export function isSettingKey(key: string): key is SettingKey {
  return Object.prototype.hasOwnProperty.call(SETTINGS, key);
}

/** What the store uses for `key`, given the rows read (readSettings): the stored value when usable, else the fallback. */
export function settingValue<K extends SettingKey>(s: Record<string, unknown>, key: K): SettingType<K> {
  const { check, usable, fallback } = SETTINGS[key] as Spec<unknown>;
  const v = s[key];
  return ((usable ?? check)(v) ? v : fallback) as SettingType<K>;
}
