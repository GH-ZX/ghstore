/**
 * Public store settings the web app reads at start: theme, the SYP rate, which
 * top-up methods and website sign-in options are on. Nothing here is secret
 * (the Supabase publishable key is meant for browsers).
 */
import type { Ctx } from "./context";
import { json } from "./http";
import { footerPages } from "./pages";
import { availableMethods } from "./payments";
import { botUsername, channelUrl, starsPerUsd, supportContacts, topupLimits } from "./settings";
import { settingValue } from "./settings-registry";

const LOGIN_METHODS = ["telegram", "email", "google"] as const;
export type LoginMethod = (typeof LOGIN_METHODS)[number];

/**
 * Website sign-in methods on now: allowed by WEB_LOGIN_METHODS, switched on in
 * Admin → Settings (email and Google), and Supabase configured. The server
 * enforces this too, not only the sign-in page.
 */
export async function webLoginMethods(ctx: Ctx): Promise<LoginMethod[]> {
  const rows = await ctx.svc.db.query<{ key: string; value: unknown }>(`select key, value from app.settings where key in ('login.email', 'login.google')`);
  const s = Object.fromEntries(rows.map((r) => [r.key, r.value]));
  return loginMethods(ctx, s);
}

function loginMethods(ctx: Ctx, s: Record<string, unknown>): LoginMethod[] {
  const supabaseReady = typeof ctx.env.SUPABASE_URL === "string" && typeof ctx.env.SUPABASE_PUBLISHABLE_KEY === "string" && !!ctx.env.SUPABASE_PUBLISHABLE_KEY;
  // WEB_LOGIN_METHODS lists what this deployment may offer; Admin → Settings switches email and Google on or off.
  const wanted = String(ctx.env.WEB_LOGIN_METHODS ?? "telegram,email").split(",").map((m) => m.trim());
  const switchedOn = (m: LoginMethod) => m === "telegram" || (m === "email" ? settingValue(s, "login.email") : settingValue(s, "login.google"));
  return LOGIN_METHODS.filter((m): m is LoginMethod => wanted.includes(m) && switchedOn(m) && (m === "telegram" || supabaseReady));
}

export async function publicConfig(ctx: Ctx): Promise<Response> {
  const rows = await ctx.svc.db.query<{ key: string; value: unknown }>(
    `select key, value from app.settings where key in ('theme.preset', 'theme.default_mode', 'fx.syp_per_usd', 'login.email', 'login.google', 'analytics.cf_token', 'images.resize', 'push.enabled')`,
  );
  const s = Object.fromEntries(rows.map((r) => [r.key, r.value]));
  const supabaseReady = typeof ctx.env.SUPABASE_URL === "string" && typeof ctx.env.SUPABASE_PUBLISHABLE_KEY === "string" && !!ctx.env.SUPABASE_PUBLISHABLE_KEY;
  const login = loginMethods(ctx, s);
  return json(
    {
      theme: { preset: settingValue(s, "theme.preset"), defaultMode: settingValue(s, "theme.default_mode") },
      sypPerUsd: settingValue(s, "fx.syp_per_usd"),
      payments: {
        methods: await availableMethods(ctx.env, ctx.svc),
        ...(await topupLimits(ctx.svc.db)),
        starsPerUsd: await starsPerUsd(ctx.svc.db),
      },
      // How customers reach the store (Admin → Settings → Support).
      support: await supportContacts(ctx.svc.db),
      // The store bot (as Telegram reported it at Connect bot) and the store's channel.
      telegram: { bot: await botUsername(ctx.svc.db), channel: await channelUrl(ctx.svc.db) },
      login,
      // The store's pages linked at the bottom (terms, privacy, refund…).
      pages: await footerPages(ctx.svc.db),
      // Cloudflare Web Analytics (no cookies), when the owner set its token.
      analytics: { cfBeacon: settingValue(s, "analytics.cf_token") },
      // Product pictures resized by Cloudflare (Admin → Settings), when its Transformations are on.
      images: { resize: settingValue(s, "images.resize") },
      // Browser notifications (Admin → Settings): the Profile switch shows only when they are on.
      push: { enabled: settingValue(s, "push.enabled") },
      supabase: supabaseReady ? { url: ctx.env.SUPABASE_URL, key: ctx.env.SUPABASE_PUBLISHABLE_KEY } : null,
    },
    { headers: { "cache-control": "public, max-age=60" } },
  );
}
