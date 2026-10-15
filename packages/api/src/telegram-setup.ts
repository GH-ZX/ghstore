/**
 * Owner tools for the Telegram bot (Admin → Settings → Telegram bot): see
 * whether Telegram delivers the bot's messages to this store, and connect it
 * with one tap — the webhook (with our secret), the command menu in Arabic and
 * English, and the menu button that opens the Mini App. This replaces the
 * Bot API calls a store owner would otherwise have to run by hand.
 *
 * Setting the webhook also stops any other server from receiving the bot's
 * updates (a bot has one webhook, and polling stops working once it is set).
 */
import { store } from "@store/config";
import { requireStaff } from "./auth";
import { BOT_COMMANDS, OPEN_STORE } from "./bot";
import type { Ctx } from "./context";
import { ApiError, json } from "./http";

/** The updates the bot handles (see bot.ts). */
export const ALLOWED_UPDATES = ["message", "callback_query", "pre_checkout_query"];

export function webhookUrl(baseUrl: string): string {
  return `${baseUrl}/telegram/webhook`;
}

export interface BotStatus {
  /** The bot token and webhook secret are set on the Worker. */
  configured: boolean;
  /** The bot's username, when Telegram accepted the token. */
  bot: string | null;
  /** Where Telegram should send updates for this store. */
  expectedUrl: string;
  /** Where Telegram sends them now ("" or null when nowhere). */
  url: string | null;
  connected: boolean;
  pendingUpdates: number;
  /** Telegram's last delivery error, if any. */
  lastError: { message: string; at: string | null } | null;
  /** Why the status could not be read (for example an invalid token). */
  error: string | null;
}

/** Telegram's own error text without our "telegram <method>:" prefix. Never includes the token. */
function telegramError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.replace(/^telegram \w+: /, "").slice(0, 300);
}

export async function botStatus(ctx: Ctx): Promise<BotStatus> {
  const expectedUrl = webhookUrl(ctx.env.PUBLIC_BASE_URL);
  const status: BotStatus = {
    configured: Boolean(ctx.env.TELEGRAM_BOT_TOKEN && ctx.env.TELEGRAM_WEBHOOK_SECRET),
    bot: null,
    expectedUrl,
    url: null,
    connected: false,
    pendingUpdates: 0,
    lastError: null,
    error: null,
  };
  if (!ctx.env.TELEGRAM_BOT_TOKEN) return status;
  try {
    const me = (await ctx.svc.telegram("getMe", {})) as { username?: string } | null;
    status.bot = typeof me?.username === "string" ? me.username : null;
    const info = (await ctx.svc.telegram("getWebhookInfo", {})) as {
      url?: string;
      pending_update_count?: number;
      last_error_date?: number;
      last_error_message?: string;
    } | null;
    status.url = info?.url ? info.url : null;
    status.connected = status.url === expectedUrl;
    status.pendingUpdates = typeof info?.pending_update_count === "number" ? info.pending_update_count : 0;
    if (info?.last_error_message) {
      status.lastError = {
        message: info.last_error_message.slice(0, 300),
        at: typeof info.last_error_date === "number" ? new Date(info.last_error_date * 1000).toISOString() : null,
      };
    }
  } catch (err) {
    status.error = telegramError(err);
  }
  return status;
}

export async function getBotStatus(ctx: Ctx): Promise<Response> {
  await requireStaff(ctx, "owner");
  return json(await botStatus(ctx));
}

/** Point the bot at this store: webhook, command menus, menu button. Safe to repeat. */
export async function connectBot(ctx: Ctx): Promise<Response> {
  const staff = await requireStaff(ctx, "owner");
  const secret = ctx.env.TELEGRAM_WEBHOOK_SECRET;
  if (!ctx.env.TELEGRAM_BOT_TOKEN || !secret) throw new ApiError("bad_state", "telegram_secrets");
  if (!/^https:\/\/[^/]+$/.test(ctx.env.PUBLIC_BASE_URL)) throw new ApiError("bad_state", "PUBLIC_BASE_URL");
  const url = webhookUrl(ctx.env.PUBLIC_BASE_URL);

  let error: string | null = null;
  try {
    await ctx.svc.telegram("setWebhook", { url, secret_token: secret, allowed_updates: ALLOWED_UPDATES });
    await ctx.svc.telegram("setMyCommands", { commands: BOT_COMMANDS.en });
    await ctx.svc.telegram("setMyCommands", { commands: BOT_COMMANDS.ar, language_code: "ar" });
    await ctx.svc.telegram("setChatMenuButton", {
      menu_button: { type: "web_app", text: OPEN_STORE[store.defaultLocale], web_app: { url: `${ctx.env.PUBLIC_BASE_URL}/tg` } },
    });
  } catch (err) {
    error = telegramError(err);
  }
  await ctx.svc.db.query(
    `insert into app.audit_log (actor_user_id, action, target_type, target_id, data) values ($1, 'telegram.connect', 'bot', $2, $3::text::jsonb)`,
    [staff.id, url, JSON.stringify({ error })],
  );
  const status = await botStatus(ctx);
  return json({ ...status, error: error ?? status.error });
}
