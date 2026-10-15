/**
 * Telegram Mini App sign-in.
 *
 * The Mini App sends `Telegram.WebApp.initData`. We check its signature with the
 * bot token as Telegram documents (secret = HMAC_SHA256("WebAppData", bot token),
 * hash = HMAC_SHA256(secret, data_check_string)) and refuse stale data.
 * https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app
 */
import { hmacSha256, timingSafeEqual, toHex, utf8 } from "./encoding";

export interface TelegramUser {
  id: number;
  firstName: string;
  lastName?: string;
  username?: string;
  languageCode?: string;
  isPremium?: boolean;
  photoUrl?: string;
}

export interface VerifiedInitData {
  user: TelegramUser;
  authDate: Date;
  queryId?: string;
  startParam?: string;
}

export interface VerifyOptions {
  /** Reject data older than this. Default: 1 hour. */
  maxAgeSeconds?: number;
  now?: Date;
}

export async function verifyInitData(
  initData: string,
  botToken: string,
  opts: VerifyOptions = {},
): Promise<VerifiedInitData | null> {
  if (!initData || !botToken) return null;
  const params = new URLSearchParams(initData);
  const hash = params.get("hash");
  if (!hash || !/^[0-9a-f]{64}$/.test(hash)) return null;
  params.delete("hash");

  const dataCheckString = [...params.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");

  const secret = await hmacSha256(utf8("WebAppData"), botToken);
  const expected = toHex(await hmacSha256(secret, dataCheckString));
  if (!timingSafeEqual(expected, hash)) return null;

  const authDateSec = Number(params.get("auth_date"));
  if (!Number.isFinite(authDateSec) || authDateSec <= 0) return null;
  const now = opts.now ?? new Date();
  const maxAge = opts.maxAgeSeconds ?? 3600;
  const ageSec = now.getTime() / 1000 - authDateSec;
  if (ageSec > maxAge || ageSec < -300) return null;

  const rawUser = params.get("user");
  if (!rawUser) return null;
  let u: Record<string, unknown>;
  try {
    u = JSON.parse(rawUser) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (typeof u.id !== "number" || !Number.isSafeInteger(u.id)) return null;

  const user: TelegramUser = {
    id: u.id,
    firstName: typeof u.first_name === "string" ? u.first_name : "",
  };
  if (typeof u.last_name === "string") user.lastName = u.last_name;
  if (typeof u.username === "string") user.username = u.username;
  if (typeof u.language_code === "string") user.languageCode = u.language_code;
  if (u.is_premium === true) user.isPremium = true;
  if (typeof u.photo_url === "string") user.photoUrl = u.photo_url;

  const out: VerifiedInitData = { user, authDate: new Date(authDateSec * 1000) };
  const queryId = params.get("query_id");
  if (queryId) out.queryId = queryId;
  const startParam = params.get("start_param");
  if (startParam) out.startParam = startParam;
  return out;
}

/** Telegram sends the secret we registered with setWebhook in this header. */
export function verifyBotWebhook(req: Request, secret: string): boolean {
  const got = req.headers.get("x-telegram-bot-api-secret-token") ?? "";
  return secret.length >= 16 && timingSafeEqual(got, secret);
}
