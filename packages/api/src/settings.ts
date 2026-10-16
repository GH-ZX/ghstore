/**
 * Store settings the owner changes in Admin → Settings (rows in app.settings),
 * read where they are needed. Nothing here has a value in code: a store copy
 * sets its own in the admin, and gh-store's come over from the old site.
 */
import { store } from "@store/config";
import type { Db } from "./db";

export interface SupportContacts {
  /** Telegram username without @. */
  telegram: string | null;
  /** WhatsApp number in international form, digits only (963…). */
  whatsapp: string | null;
  email: string | null;
}

export const TELEGRAM_USERNAME = /^[A-Za-z][A-Za-z0-9_]{4,31}$/;
export const WHATSAPP_NUMBER = /^[1-9][0-9]{7,14}$/;
export const EMAIL = /^[^\s@<>"]{1,64}@[^\s@<>"]{1,180}\.[A-Za-z]{2,24}$/;

export async function readSettings(db: Db, keys: string[]): Promise<Record<string, unknown>> {
  const rows = await db.query<{ key: string; value: unknown }>(
    `select key, value from app.settings where key = any(string_to_array($1::text, ','))`,
    [keys.join(",")],
  );
  return Object.fromEntries(rows.map((r) => [r.key, r.value]));
}

const str = (v: unknown, re: RegExp): string | null => (typeof v === "string" && re.test(v) ? v : null);

export async function supportContacts(db: Db): Promise<SupportContacts> {
  const s = await readSettings(db, ["support.telegram", "support.whatsapp", "support.email"]);
  return {
    telegram: str(s["support.telegram"], TELEGRAM_USERNAME),
    whatsapp: str(s["support.whatsapp"], WHATSAPP_NUMBER),
    email: str(s["support.email"], EMAIL),
  };
}

/** Stars charged per US dollar, or null when Stars top-ups are switched off. */
export async function starsPerUsd(db: Db): Promise<number | null> {
  const v = (await readSettings(db, ["payments.stars_per_usd"]))["payments.stars_per_usd"];
  return typeof v === "number" && Number.isInteger(v) && v >= 1 && v <= 1000 ? v : null;
}

export const BOT_USERNAME = /^[A-Za-z][A-Za-z0-9_]{4,31}$/;
/** A public channel (t.me/name) or a private invite link (t.me/+code). */
export const CHANNEL_URL = /^https:\/\/t\.me\/(\+[A-Za-z0-9_-]{8,64}|[A-Za-z][A-Za-z0-9_]{4,31})$/;

/** The store bot's username: saved by Connect bot, else store.config.ts. */
export async function botUsername(db: Db): Promise<string> {
  const v = (await readSettings(db, ["telegram.bot_username"]))["telegram.bot_username"];
  return str(v, BOT_USERNAME) ?? store.telegramBot;
}

/** The store's Telegram channel link, or null. */
export async function channelUrl(db: Db): Promise<string | null> {
  return str((await readSettings(db, ["telegram.channel_url"]))["telegram.channel_url"], CHANNEL_URL);
}

/** The home page showcase's look: a poster per slide ("cinematic"), or a deal with its packages ("deal"). */
export const SHOWCASE_STYLES = ["cinematic", "deal"] as const;
export type ShowcaseStyle = (typeof SHOWCASE_STYLES)[number];

/** Autoplay choices for the showcase, in seconds per slide (0 = off). */
export const SHOWCASE_AUTOPLAY = [0, 4, 6, 8, 10, 12] as const;

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
}

/** The showcase's settings (Admin → Home), with the defaults for anything not set. */
export async function showcaseSettings(db: Db): Promise<ShowcaseSettings> {
  const s = await readSettings(db, ["home.showcase_style", "home.badge_instant", "home.badge_label", "home.autoplay_seconds", "home.deal_packages"]);
  const style = s["home.showcase_style"];
  const autoplay = s["home.autoplay_seconds"];
  const deal = s["home.deal_packages"];
  return {
    style: (SHOWCASE_STYLES as readonly unknown[]).includes(style) ? (style as ShowcaseStyle) : "cinematic",
    badgeInstant: s["home.badge_instant"] !== false,
    badgeLabel: s["home.badge_label"] !== false,
    autoplay: (SHOWCASE_AUTOPLAY as readonly unknown[]).includes(autoplay) ? (autoplay as number) : 6,
    dealPackages: typeof deal === "number" && Number.isInteger(deal) && deal >= 2 && deal <= 4 ? deal : 3,
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
