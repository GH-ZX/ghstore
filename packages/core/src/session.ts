/**
 * Our own short-lived session tokens, signed with SESSION_SECRET (never the bot token).
 *
 * Format: "v1.<payload>.<signature>", both base64url. The payload names the user,
 * the session row (so a session can be revoked), the channel and the expiry.
 * Tokens travel in the Authorization header (Mini App) or an HttpOnly cookie
 * (website), never in URLs.
 */
import { fromBase64Url, fromUtf8, hmacSha256, timingSafeEqual, toBase64Url, utf8 } from "./encoding";

export type Channel = "web" | "miniapp" | "admin";

export interface SessionClaims {
  /** User id (uuid). */
  sub: string;
  /** Session id (uuid), checked against the sessions table for revocation. */
  sid: string;
  ch: Channel;
  /** Expiry, seconds since epoch. */
  exp: number;
  /** Issued at, seconds since epoch. */
  iat: number;
}

export const SESSION_TTL_SECONDS: Record<Channel, number> = {
  miniapp: 60 * 60 * 12,
  web: 60 * 60 * 24 * 14,
  admin: 60 * 60 * 8,
};

export async function signSession(
  claims: Omit<SessionClaims, "iat" | "exp"> & { exp?: number },
  secret: string,
  now = new Date(),
): Promise<string> {
  assertSecret(secret);
  const iat = Math.floor(now.getTime() / 1000);
  const full: SessionClaims = { ...claims, iat, exp: claims.exp ?? iat + SESSION_TTL_SECONDS[claims.ch] };
  const payload = toBase64Url(utf8(JSON.stringify(full)));
  const sig = toBase64Url(await hmacSha256(secret, `v1.${payload}`));
  return `v1.${payload}.${sig}`;
}

export async function verifySession(token: string, secret: string, now = new Date()): Promise<SessionClaims | null> {
  assertSecret(secret);
  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== "v1") return null;
  const [, payload = "", sig = ""] = parts;
  const expected = toBase64Url(await hmacSha256(secret, `v1.${payload}`));
  if (!timingSafeEqual(expected, sig)) return null;
  let claims: SessionClaims;
  try {
    claims = JSON.parse(fromUtf8(fromBase64Url(payload))) as SessionClaims;
  } catch {
    return null;
  }
  if (typeof claims.sub !== "string" || typeof claims.sid !== "string" || typeof claims.exp !== "number") return null;
  if (!["web", "miniapp", "admin"].includes(claims.ch)) return null;
  if (claims.exp <= Math.floor(now.getTime() / 1000)) return null;
  return claims;
}

/** Read a bearer token from the Authorization header, or the session cookie. */
export function readSessionToken(req: Request, cookieName = "store_session"): string | null {
  const auth = req.headers.get("authorization");
  if (auth?.startsWith("Bearer ")) return auth.slice(7).trim() || null;
  const cookie = req.headers.get("cookie") ?? "";
  for (const part of cookie.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === cookieName) return decodeURIComponent(v.join("="));
  }
  return null;
}

function assertSecret(secret: string): void {
  if (!secret || secret.length < 32) throw new Error("SESSION_SECRET must be at least 32 characters");
}
