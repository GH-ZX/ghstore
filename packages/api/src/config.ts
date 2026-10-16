/**
 * Public store settings the web app reads at start: theme, the SYP rate, which
 * top-up methods and website sign-in options are on. Nothing here is secret
 * (the Supabase publishable key is meant for browsers).
 */
import type { Ctx } from "./context";
import { json } from "./http";
import { availableMethods, MAX_TOPUP_CENTS, MIN_TOPUP_CENTS } from "./payments";
import { botUsername, channelUrl, starsPerUsd, supportContacts } from "./settings";

const LOGIN_METHODS = ["telegram", "email", "google"] as const;
type LoginMethod = (typeof LOGIN_METHODS)[number];

export async function publicConfig(ctx: Ctx): Promise<Response> {
  const rows = await ctx.svc.db.query<{ key: string; value: unknown }>(
    `select key, value from app.settings where key in ('theme.preset', 'theme.default_mode', 'fx.syp_per_usd', 'login.email', 'login.google')`,
  );
  const s = Object.fromEntries(rows.map((r) => [r.key, r.value]));
  const supabaseReady = typeof ctx.env.SUPABASE_URL === "string" && typeof ctx.env.SUPABASE_PUBLISHABLE_KEY === "string" && !!ctx.env.SUPABASE_PUBLISHABLE_KEY;
  // WEB_LOGIN_METHODS lists what this deployment may offer; Admin → Settings switches email and Google on or off.
  const wanted = String(ctx.env.WEB_LOGIN_METHODS ?? "telegram,email").split(",").map((m) => m.trim());
  const switchedOn = (m: LoginMethod) => m === "telegram" || (m === "email" ? s["login.email"] !== false : s["login.google"] === true);
  const login = LOGIN_METHODS.filter((m): m is LoginMethod => wanted.includes(m) && switchedOn(m) && (m === "telegram" || supabaseReady));
  return json(
    {
      theme: { preset: s["theme.preset"] ?? "energetic", defaultMode: s["theme.default_mode"] ?? "system" },
      sypPerUsd: typeof s["fx.syp_per_usd"] === "number" ? s["fx.syp_per_usd"] : null,
      payments: {
        methods: await availableMethods(ctx.env, ctx.svc),
        minCents: MIN_TOPUP_CENTS,
        maxCents: MAX_TOPUP_CENTS,
        starsPerUsd: await starsPerUsd(ctx.svc.db),
      },
      // How customers reach the store (Admin → Settings → Support).
      support: await supportContacts(ctx.svc.db),
      // The store bot (as Telegram reported it at Connect bot) and the store's channel.
      telegram: { bot: await botUsername(ctx.svc.db), channel: await channelUrl(ctx.svc.db) },
      login,
      supabase: supabaseReady ? { url: ctx.env.SUPABASE_URL, key: ctx.env.SUPABASE_PUBLISHABLE_KEY } : null,
    },
    { headers: { "cache-control": "public, max-age=60" } },
  );
}
