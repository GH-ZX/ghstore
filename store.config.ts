/**
 * Everything brand-specific lives here and in /brand. To launch another store
 * from this template, change this file, replace the files in /brand, and set
 * the secrets listed in .env.example. Nothing else should need editing.
 */
export const store = {
  /** Full name, typed where the name appears in text. */
  name: "GH Store",
  /** The website's address (no trailing slash): link previews need absolute URLs. Same as PUBLIC_BASE_URL. */
  url: "https://gh-store.me",
  /** One line for search results and link previews. */
  tagline: {
    ar: "شحن ألعاب، بطاقات، اشتراكات وأكثر — تسليم فوري.",
    en: "Game top-ups, gift cards, subscriptions and more, delivered instantly.",
  },
  /** The logo mark. */
  mark: "GH.",
  /** Default language; Arabic is right-to-left. */
  defaultLocale: "ar" as "ar" | "en",
  locales: ["ar", "en"] as const,
  /** Starting theme; the owner can change it in the admin (setting theme.preset). */
  theme: { preset: "energetic" as "calm" | "energetic" | "minimal" | "warm", mode: "system" as "system" | "light" | "dark" },
  currency: "USD",
  /** Shown next to USD prices when the admin sets fx.syp_per_usd (new Syrian pounds). */
  showSyp: true,
  /** Telegram bot username without @, for links like t.me/<bot>. */
  telegramBot: "gh_store1_bot",
  support: {
    telegram: "https://t.me/REPLACE_SUPPORT_USERNAME",
    whatsapp: "",
    email: "",
  },
  /** Order numbers are shown as `${orderPrefix}${number}`. */
  orderPrefix: "GH-",
} as const;

export type StoreConfig = typeof store;
