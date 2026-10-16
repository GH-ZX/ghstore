/**
 * Sign-in for every channel ends in the same thing: one of our own short-lived
 * session tokens tied to a row in app.sessions (so it can be revoked).
 *
 * - Mini App: the client posts Telegram initData; we verify it with the bot token.
 * - Website: the client signs in with Supabase Auth (email or Google) and posts
 *   the Supabase access token; we confirm it with Supabase and swap it for ours.
 */
import { readSessionToken, SESSION_TTL_SECONDS, signSession, verifyInitData, verifyLoginWidget, verifySession, type Channel, type TelegramUser } from "@store/core";
import type { AuthedUser, Ctx } from "./context";
import { call, must, n, one, type Db } from "./db";
import { ApiError, clearCookie, json, readJson, setCookie, str } from "./http";

export const SESSION_COOKIE = "store_session";

async function startSession(ctx: Ctx, userId: string, channel: Channel): Promise<{ token: string; expiresAt: Date }> {
  const now = ctx.svc.now();
  const expiresAt = new Date(now.getTime() + SESSION_TTL_SECONDS[channel] * 1000);
  const row = await must<{ id: string }>(
    ctx.svc.db,
    `insert into app.sessions (user_id, channel, expires_at, user_agent) values ($1, $2, $3, $4) returning id`,
    [userId, channel, expiresAt.toISOString(), (ctx.req.headers.get("user-agent") ?? "").slice(0, 200)],
  );
  const token = await signSession({ sub: userId, sid: row.id, ch: channel, exp: Math.floor(expiresAt.getTime() / 1000) }, ctx.env.SESSION_SECRET, now);
  return { token, expiresAt };
}

/** Make configured Telegram ids owners the first time they sign in. */
async function promoteOwner(db: Db, userId: string, telegramId: string, ownerIds: string | undefined): Promise<void> {
  const ids = (ownerIds ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  if (!ids.includes(telegramId)) return;
  const res = await db.query(`update app.users set role = 'owner' where id = $1 and role <> 'owner' returning id`, [userId]);
  if (res.length) {
    await db.query(
      `insert into app.audit_log (actor_user_id, action, target_type, target_id) values ($1, 'user.promote_owner', 'user', $2)`,
      [userId, userId],
    );
  }
}

/** Find or create the user behind a verified Telegram account (owners promoted on the way). */
async function telegramUser(ctx: Ctx, u: TelegramUser): Promise<UserRow> {
  const displayName = [u.firstName, u.lastName].filter(Boolean).join(" ");
  const locale = u.languageCode?.startsWith("ar") ? "ar" : u.languageCode ? "en" : "ar";
  const rows = await call<{ id: string }>(ctx.svc.db, `select app.ensure_telegram_user($1, $2, $3, $4) as id`, [
    String(u.id),
    u.username ?? null,
    displayName,
    locale,
  ]);
  const userId = rows[0]?.id;
  if (!userId) throw new ApiError("internal");
  await promoteOwner(ctx.svc.db, userId, String(u.id), ctx.env.OWNER_TELEGRAM_IDS);
  const user = await loadUser(ctx.svc.db, userId);
  if (user.status !== "active") throw new ApiError("user_blocked");
  return user;
}

/** Mini App: Telegram initData, answered with a bearer token (Telegram's webview keeps no cookies reliably). */
export async function telegramLogin(ctx: Ctx): Promise<Response> {
  const body = await readJson(ctx.req);
  const initData = str(body, "initData", { max: 4096 });
  const verified = await verifyInitData(initData, ctx.env.TELEGRAM_BOT_TOKEN, { now: ctx.svc.now(), maxAgeSeconds: 24 * 3600 });
  if (!verified) throw new ApiError("unauthorized");
  const user = await telegramUser(ctx, verified.user);
  const { token, expiresAt } = await startSession(ctx, user.id, "miniapp");
  return json({ token, expiresAt: expiresAt.toISOString(), user: publicUser(user) });
}

/** Website: "Log in with Telegram" widget. Same Telegram account, same user and wallet as in the bot. */
export async function telegramWidgetLogin(ctx: Ctx): Promise<Response> {
  const body = await readJson(ctx.req);
  const verified = await verifyLoginWidget(body, ctx.env.TELEGRAM_BOT_TOKEN, { now: ctx.svc.now(), maxAgeSeconds: 3600 });
  if (!verified) throw new ApiError("unauthorized");
  const user = await telegramUser(ctx, verified.user);
  const { expiresAt, token } = await startSession(ctx, user.id, "web");
  return json(
    { expiresAt: expiresAt.toISOString(), user: publicUser(user) },
    { headers: { "set-cookie": setCookie(SESSION_COOKIE, token, SESSION_TTL_SECONDS.web) } },
  );
}

export async function webLogin(ctx: Ctx): Promise<Response> {
  const body = await readJson(ctx.req);
  const accessToken = str(body, "accessToken", { max: 4096 });
  if (!ctx.env.SUPABASE_URL || !ctx.env.SUPABASE_PUBLISHABLE_KEY) throw new ApiError("not_allowed");
  // Ask Supabase Auth who this token belongs to. Never decode it ourselves without verifying.
  const res = await ctx.svc.fetch(`${ctx.env.SUPABASE_URL}/auth/v1/user`, {
    headers: { apikey: ctx.env.SUPABASE_PUBLISHABLE_KEY, authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) throw new ApiError("unauthorized");
  const au = (await res.json()) as { id?: string; email?: string; user_metadata?: { full_name?: string; name?: string } };
  if (!au.id) throw new ApiError("unauthorized");
  const name = au.user_metadata?.full_name ?? au.user_metadata?.name ?? "";
  const locale = body.locale === "en" ? "en" : "ar";
  const rows = await call<{ id: string }>(ctx.svc.db, `select app.ensure_web_user($1, $2, $3, $4) as id`, [au.id, au.email ?? null, name, locale]);
  const userId = rows[0]?.id;
  if (!userId) throw new ApiError("internal");
  const user = await loadUser(ctx.svc.db, userId);
  if (user.status !== "active") throw new ApiError("user_blocked");
  const { token, expiresAt } = await startSession(ctx, userId, "web");
  return json(
    { expiresAt: expiresAt.toISOString(), user: publicUser(user) },
    { headers: { "set-cookie": setCookie(SESSION_COOKIE, token, SESSION_TTL_SECONDS.web) } },
  );
}

export async function logout(ctx: Ctx): Promise<Response> {
  const user = await optionalUser(ctx);
  if (user) await ctx.svc.db.query(`update app.sessions set revoked_at = now() where id = $1`, [user.sessionId]);
  return json({ ok: true }, { headers: { "set-cookie": clearCookie(SESSION_COOKIE) } });
}

interface UserRow {
  id: string;
  display_name: string;
  locale: "ar" | "en";
  role: "customer" | "monitor" | "support" | "owner";
  status: "active" | "banned";
  notify: boolean;
  sessions_revoked_at: string | null;
}

async function loadUser(db: Db, id: string): Promise<UserRow> {
  return must<UserRow>(db, `select id, display_name, locale, role, status, notify, sessions_revoked_at from app.users where id = $1`, [id]);
}

function publicUser(u: UserRow) {
  return { id: u.id, name: u.display_name, locale: u.locale, role: u.role, notify: u.notify };
}

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

export async function me(ctx: Ctx): Promise<Response> {
  const auth = await requireUser(ctx);
  const user = await loadUser(ctx.svc.db, auth.id);
  const extra = await one<{ balance_cents: string | number | null; orders: string | number; spent: string | number; telegram: string | null; tg_id: string | null; email: string | null }>(
    ctx.svc.db,
    `select (select balance_cents from app.wallets where user_id = $1) as balance_cents,
            (select count(*) from app.orders where user_id = $1 and status = 'delivered') as orders,
            (select coalesce(sum(total_cents), 0) from app.orders where user_id = $1 and status = 'delivered') as spent,
            (select username from app.identities where user_id = $1 and provider = 'telegram' limit 1) as telegram,
            (select subject from app.identities where user_id = $1 and provider = 'telegram' limit 1) as tg_id,
            (select email from app.identities where user_id = $1 and provider = 'supabase' limit 1) as email`,
    [auth.id],
  );
  return json({
    user: { ...publicUser(user), telegramUsername: extra?.telegram ?? null, hasTelegram: Boolean(extra?.tg_id), email: extra?.email ?? null },
    balanceCents: n(extra?.balance_cents),
    stats: { orders: n(extra?.orders), spentCents: n(extra?.spent) },
    channel: auth.channel,
  });
}

export async function updateMe(ctx: Ctx): Promise<Response> {
  const auth = await requireUser(ctx);
  const body = await readJson(ctx.req);
  const locale = body.locale === "en" || body.locale === "ar" ? body.locale : null;
  const notify = typeof body.notify === "boolean" ? body.notify : null;
  await ctx.svc.db.query(`update app.users set locale = coalesce($2, locale), notify = coalesce($3, notify) where id = $1`, [auth.id, locale, notify]);
  return me(ctx);
}
