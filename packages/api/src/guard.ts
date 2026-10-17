/**
 * Who is asking: the session check every route starts with. A request carries
 * one of our session tokens (cookie on the website, bearer in the Mini App);
 * it counts only while its row in app.sessions is live and the account active.
 * Sign-in itself, which hands these tokens out, is auth.ts.
 */
import { readSessionToken, verifySession } from "@store/core";
import type { AuthedUser, Ctx } from "./context";
import { one } from "./db";
import { ApiError } from "./http";

export const SESSION_COOKIE = "store_session";

/** The signed-in user, or null. Checks signature, expiry, revocation and ban. Fails closed. */
export async function optionalUser(ctx: Ctx): Promise<AuthedUser | null> {
  const token = readSessionToken(ctx.req, SESSION_COOKIE);
  if (!token) return null;
  const claims = await verifySession(token, ctx.env.SESSION_SECRET, ctx.svc.now());
  if (!claims) return null;
  const row = await one<{ role: AuthedUser["role"]; locale: "ar" | "en"; status: string; revoked: boolean }>(
    ctx.svc.db,
    `select u.role, u.locale, u.status,
            (s.revoked_at is not null or s.expires_at <= now()
             or (u.sessions_revoked_at is not null and s.created_at <= u.sessions_revoked_at)) as revoked
       from app.sessions s join app.users u on u.id = s.user_id
      where s.id = $1 and s.user_id = $2`,
    [claims.sid, claims.sub],
  );
  if (!row || row.revoked || row.status !== "active") return null;
  return { id: claims.sub, role: row.role, locale: row.locale, sessionId: claims.sid, channel: claims.ch };
}

export async function requireUser(ctx: Ctx): Promise<AuthedUser> {
  const u = await optionalUser(ctx);
  if (!u) throw new ApiError("unauthorized");
  return u;
}

/** Staff ranks, lowest first. Each rank can do everything the ones below it can. */
const STAFF_RANK = { monitor: 1, support: 2, owner: 3 } as const;
export type StaffLevel = keyof typeof STAFF_RANK;

/**
 * Staff only. `owner` can do everything; `support` handles orders and top-ups;
 * `monitor` only looks (reads with level "monitor"). Actions default to "support".
 */
export async function requireStaff(ctx: Ctx, level: StaffLevel = "support"): Promise<AuthedUser> {
  const u = await requireUser(ctx);
  const rank = u.role === "customer" ? 0 : STAFF_RANK[u.role];
  if (rank >= STAFF_RANK[level]) return u;
  throw new ApiError("forbidden");
}
