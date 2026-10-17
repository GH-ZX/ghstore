/**
 * Sign-in for every channel ends in the same thing: one of our own short-lived
 * session tokens tied to a row in app.sessions (so it can be revoked).
 *
 * - Mini App: the client posts Telegram initData; we verify it with the bot token.
 * - Website: the client signs in with Supabase Auth (email or Google) and posts
 *   the Supabase access token; we confirm it with Supabase and swap it for ours.
 * - Linking: a signed-in customer adds the other kind of login (Telegram, or
 *   email/Google), so every door opens the same wallet.
 */
import {
  fromBase64Url, fromUtf8, randomToken, readSessionToken, SESSION_TTL_SECONDS, signSession, toHex, utf8, verifyInitData, verifyLoginWidget,
  verifySession, type Channel, type TelegramUser,
} from "@store/core";
import { audit } from "./audit";
import { webLoginMethods, type LoginMethod } from "./config";
import type { AuthedUser, Ctx } from "./context";
import { call, must, n, one, type Db } from "./db";
import { ApiError, clearCookie, json, readJson, setCookie, str } from "./http";
import { throttleLoginIdentity, throttleLoginIp } from "./ratelimit";

export const SESSION_COOKIE = "store_session";

/** Live sessions one account may hold per channel; signing in again past this ends the oldest. */
export const MAX_SESSIONS_PER_CHANNEL = 20;

/**
 * How old Mini App initData may be. It is a bearer credential while it lasts
 * (whoever holds it can sign in as that customer), and the Mini App signs in
 * right after opening, so an hour is plenty.
 */
export const INIT_DATA_MAX_AGE_SECONDS = 3600;

async function startSession(ctx: Ctx, userId: string, channel: Channel): Promise<{ token: string; expiresAt: Date }> {
  const now = ctx.svc.now();
  const expiresAt = new Date(now.getTime() + SESSION_TTL_SECONDS[channel] * 1000);
  const row = await must<{ id: string }>(
    ctx.svc.db,
    `insert into app.sessions (user_id, channel, expires_at, user_agent) values ($1, $2, $3, $4) returning id`,
    [userId, channel, expiresAt.toISOString(), (ctx.req.headers.get("user-agent") ?? "").slice(0, 200)],
  );
  // Every sign-in makes a session: keep the newest ones per channel, end the rest.
  await ctx.svc.db.query(
    `update app.sessions set revoked_at = now()
      where id in (select id from app.sessions
                    where user_id = $1 and channel = $2 and revoked_at is null and expires_at > now()
                    order by created_at desc, id desc offset $3)`,
    [userId, channel, MAX_SESSIONS_PER_CHANNEL],
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
    await audit(db, { actor: userId, action: "user.promote_owner", targetType: "user", targetId: userId });
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
  // The Telegram profile picture, for the profile page (Telegram's own https address only).
  const photo = u.photoUrl && /^https:\/\/[a-z0-9.-]*(telegram\.org|t\.me|telesco\.pe)\/[^\s"<>]{1,400}$/i.test(u.photoUrl) ? u.photoUrl : null;
  if (photo) await ctx.svc.db.query(`update app.users set photo_url = $2 where id = $1 and photo_url is distinct from $2`, [userId, photo]);
  await promoteOwner(ctx.svc.db, userId, String(u.id), ctx.env.OWNER_TELEGRAM_IDS);
  const user = await loadUser(ctx.svc.db, userId);
  if (user.status !== "active") throw new ApiError("user_blocked");
  return user;
}

/** Mini App: Telegram initData, answered with a bearer token (Telegram's webview keeps no cookies reliably). */
export async function telegramLogin(ctx: Ctx): Promise<Response> {
  await throttleLoginIp(ctx);
  const body = await readJson(ctx.req);
  const initData = str(body, "initData", { max: 4096 });
  const verified = await verifyInitData(initData, ctx.env.TELEGRAM_BOT_TOKEN, { now: ctx.svc.now(), maxAgeSeconds: INIT_DATA_MAX_AGE_SECONDS });
  if (!verified) throw new ApiError("unauthorized");
  await throttleLoginIdentity(ctx, "tg", String(verified.user.id));
  const user = await telegramUser(ctx, verified.user);
  const { token, expiresAt } = await startSession(ctx, user.id, "miniapp");
  return json({ token, expiresAt: expiresAt.toISOString(), user: publicUser(user) });
}

/** Website: "Log in with Telegram" widget. Same Telegram account, same user and wallet as in the bot. */
export async function telegramWidgetLogin(ctx: Ctx): Promise<Response> {
  await throttleLoginIp(ctx);
  const body = await readJson(ctx.req);
  const verified = await verifyLoginWidget(body, ctx.env.TELEGRAM_BOT_TOKEN, { now: ctx.svc.now(), maxAgeSeconds: 3600 });
  if (!verified) throw new ApiError("unauthorized");
  await throttleLoginIdentity(ctx, "tg", String(verified.user.id));
  const user = await telegramUser(ctx, verified.user);
  const { expiresAt, token } = await startSession(ctx, user.id, "web");
  return json(
    { expiresAt: expiresAt.toISOString(), user: publicUser(user) },
    { headers: { "set-cookie": setCookie(SESSION_COOKIE, token, SESSION_TTL_SECONDS.web) } },
  );
}

/**
 * How a Supabase access token was obtained: "email" (a one-time code or a password) or "google".
 * Read from the token's `amr` claim, only after Supabase has confirmed the
 * token; falls back to the account's providers when the claim is absent.
 */
function webMethod(accessToken: string, providers: string[]): LoginMethod | null {
  try {
    const claims = JSON.parse(fromUtf8(fromBase64Url(accessToken.split(".")[1] ?? ""))) as { amr?: { method?: string }[] };
    const methods = (claims.amr ?? []).map((a) => a.method);
    if (methods.includes("oauth")) return "google";
    if (methods.some((m) => m === "otp" || m === "magiclink" || m === "email/signup" || m === "password" || m === "recovery")) return "email";
  } catch {
    // not a readable JWT: use the providers below
  }
  if (providers.includes("google") && !providers.includes("email")) return "google";
  if (providers.includes("email") && !providers.includes("google")) return "email";
  return null;
}

/** Ask Supabase Auth who an access token belongs to, and refuse sign-in methods the owner switched off. */
async function supabaseUser(ctx: Ctx, accessToken: string): Promise<{ id: string; email: string | null; name: string }> {
  if (!ctx.env.SUPABASE_URL || !ctx.env.SUPABASE_PUBLISHABLE_KEY) throw new ApiError("not_allowed");
  const res = await ctx.svc.fetch(`${ctx.env.SUPABASE_URL}/auth/v1/user`, {
    headers: { apikey: ctx.env.SUPABASE_PUBLISHABLE_KEY, authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) throw new ApiError("unauthorized");
  const au = (await res.json()) as {
    id?: string;
    email?: string;
    user_metadata?: { full_name?: string; name?: string };
    app_metadata?: { provider?: string; providers?: string[] };
  };
  if (!au.id) throw new ApiError("unauthorized");
  const providers = [...(au.app_metadata?.providers ?? []), ...(au.app_metadata?.provider ? [au.app_metadata.provider] : [])];
  const method = webMethod(accessToken, providers);
  const enabled = await webLoginMethods(ctx);
  // Unknown method: allowed only while both website methods are on.
  if (method ? !enabled.includes(method) : !(enabled.includes("email") && enabled.includes("google"))) throw new ApiError("not_allowed", "login_method");
  return { id: au.id, email: au.email ?? null, name: au.user_metadata?.full_name ?? au.user_metadata?.name ?? "" };
}

export async function webLogin(ctx: Ctx): Promise<Response> {
  // Before the Supabase call: each attempt costs one of the run's outside requests.
  await throttleLoginIp(ctx);
  const body = await readJson(ctx.req);
  const au = await supabaseUser(ctx, str(body, "accessToken", { max: 4096 }));
  await throttleLoginIdentity(ctx, "web", au.id);
  const locale = body.locale === "en" ? "en" : "ar";
  const rows = await call<{ id: string }>(ctx.svc.db, `select app.ensure_web_user($1, $2, $3, $4) as id`, [au.id, au.email, au.name, locale]);
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

const LINK_TTL_MINUTES = 10;
const sha256Hex = async (s: string) => toHex(await crypto.subtle.digest("SHA-256", utf8(s)));

/**
 * Profile → Connect: start linking a login to this account. The one-time token
 * returned must come back with the login itself, from the same session, within
 * 10 minutes, so a crafted link carrying someone else's login does nothing.
 */
export async function startLink(ctx: Ctx): Promise<Response> {
  const auth = await requireUser(ctx);
  const body = await readJson(ctx.req);
  const provider = body.provider === "telegram" ? "telegram" : body.provider === "supabase" ? "supabase" : null;
  if (!provider) throw new ApiError("invalid_input", "provider");
  const state = randomToken(32);
  await ctx.svc.db.query(
    `insert into app.link_requests (session_id, provider, token_hash, expires_at) values ($1, $2, $3, now() + make_interval(mins => $4::int))
     on conflict (session_id, provider) do update set token_hash = excluded.token_hash, expires_at = excluded.expires_at`,
    [auth.sessionId, provider, await sha256Hex(state), LINK_TTL_MINUTES],
  );
  return json({ state, expiresInSeconds: LINK_TTL_MINUTES * 60 });
}

/** Use up the token from startLink; refuse when it is missing, wrong, expired or from another session. */
async function consumeLink(ctx: Ctx, sessionId: string, provider: "telegram" | "supabase", state: unknown): Promise<void> {
  if (typeof state !== "string" || state.length < 16 || state.length > 128) throw new ApiError("forbidden", "link_state");
  const used = await ctx.svc.db.query(
    `delete from app.link_requests where session_id = $1 and provider = $2 and token_hash = $3 and expires_at > now() returning session_id`,
    [sessionId, provider, await sha256Hex(state)],
  );
  if (!used.length) throw new ApiError("forbidden", "link_state");
}

/**
 * Attach a verified login to the signed-in customer (see app.link_identity).
 * When the login's own account was the one with history, the customer carries
 * on in that account: we answer with a fresh session for it.
 */
async function linkIdentity(ctx: Ctx, auth: AuthedUser, provider: "telegram" | "supabase", subject: string, username: string | null, email: string | null): Promise<Response> {
  const rows = await call<{ user_id: string; merged: boolean }>(ctx.svc.db, `select user_id, merged from app.link_identity($1, $2, $3, $4, $5)`, [
    auth.id,
    provider,
    subject,
    username,
    email,
  ]);
  const result = rows[0];
  if (!result) throw new ApiError("internal");
  if (provider === "telegram") await promoteOwner(ctx.svc.db, result.user_id, subject, ctx.env.OWNER_TELEGRAM_IDS);
  if (result.user_id === auth.id) return json({ linked: provider, merged: result.merged, switched: false });
  // This account was unused and its logins moved to the other one: continue there.
  const { token, expiresAt } = await startSession(ctx, result.user_id, auth.channel);
  if (auth.channel !== "miniapp") {
    return json(
      { linked: provider, merged: true, switched: true, expiresAt: expiresAt.toISOString() },
      { headers: { "set-cookie": setCookie(SESSION_COOKIE, token, SESSION_TTL_SECONDS.web) } },
    );
  }
  return json({ linked: provider, merged: true, switched: true, token, expiresAt: expiresAt.toISOString() });
}

/** Profile → add email or Google: the client signed in with Supabase Auth and sends its access token. */
export async function linkWeb(ctx: Ctx): Promise<Response> {
  const auth = await requireUser(ctx);
  const body = await readJson(ctx.req);
  await consumeLink(ctx, auth.sessionId, "supabase", body.state);
  const au = await supabaseUser(ctx, str(body, "accessToken", { max: 4096 }));
  return linkIdentity(ctx, auth, "supabase", au.id, null, au.email);
}

/** Website profile → connect Telegram: the Telegram Login Widget's signed fields. */
export async function linkTelegram(ctx: Ctx): Promise<Response> {
  const auth = await requireUser(ctx);
  const body = await readJson(ctx.req);
  const { state, ...fields } = body;
  await consumeLink(ctx, auth.sessionId, "telegram", state);
  // A fresh Telegram confirmation only: linking is not something to replay later.
  const verified = await verifyLoginWidget(fields, ctx.env.TELEGRAM_BOT_TOKEN, { now: ctx.svc.now(), maxAgeSeconds: LINK_TTL_MINUTES * 60 });
  if (!verified) throw new ApiError("unauthorized");
  return linkIdentity(ctx, auth, "telegram", String(verified.user.id), verified.user.username ?? null, null);
}

/** Remove a login, as long as the customer keeps another way in. */
export async function unlink(ctx: Ctx): Promise<Response> {
  const auth = await requireUser(ctx);
  const body = await readJson(ctx.req);
  const provider = body.provider === "telegram" ? "telegram" : body.provider === "supabase" ? "supabase" : null;
  if (!provider) throw new ApiError("invalid_input", "provider");
  // The login used for this very session stays: unlinking it would sign the person out of the bot or website.
  if (provider === "telegram" && auth.channel === "miniapp") throw new ApiError("not_allowed");
  const removed = await ctx.svc.db.query(
    `delete from app.identities i
      where i.user_id = $1 and i.provider = $2
        and exists (select 1 from app.identities o where o.user_id = $1 and o.provider <> $2)
      returning i.id`,
    [auth.id, provider],
  );
  if (!removed.length) throw new ApiError("bad_state", "last_login");
  await audit(ctx.svc.db, { actor: auth.id, action: "user.unlink", targetType: "user", targetId: auth.id, data: { provider } });
  // A login is often removed because it was lost or taken over: sign out every
  // other session, and carry on here with a fresh one.
  await ctx.svc.db.query(`update app.users set sessions_revoked_at = now() where id = $1`, [auth.id]);
  const { token, expiresAt } = await startSession(ctx, auth.id, auth.channel);
  const fresh: Ctx = { ...ctx, req: new Request(ctx.req.url, { headers: { authorization: `Bearer ${token}` } }) };
  const profile = (await (await me(fresh)).json()) as Record<string, unknown>;
  if (auth.channel === "miniapp") return json({ ...profile, token, expiresAt: expiresAt.toISOString() });
  return json(profile, { headers: { "set-cookie": setCookie(SESSION_COOKIE, token, SESSION_TTL_SECONDS[auth.channel]) } });
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

/**
 * The signed-in person. With ?guest=ok (the web app's start-up check) a visitor
 * who is not signed in gets `{ "user": null }` instead of a 401, so every first
 * visit does not log a failed request in the browser's console.
 */
export async function me(ctx: Ctx): Promise<Response> {
  const auth = ctx.url.searchParams.get("guest") === "ok" ? await optionalUser(ctx) : await requireUser(ctx);
  if (!auth) return json({ user: null }, { headers: { "cache-control": "no-store" } });
  const user = await loadUser(ctx.svc.db, auth.id);
  const extra = await one<{ balance_cents: string | number | null; orders: string | number; spent: string | number; telegram: string | null; tg_id: string | null; email: string | null; photo_url: string | null }>(
    ctx.svc.db,
    `select (select balance_cents from app.wallets where user_id = $1) as balance_cents,
            (select count(*) from app.orders where user_id = $1 and status = 'delivered') as orders,
            (select coalesce(sum(total_cents), 0) from app.orders where user_id = $1 and status = 'delivered') as spent,
            (select username from app.identities where user_id = $1 and provider = 'telegram' limit 1) as telegram,
            (select subject from app.identities where user_id = $1 and provider = 'telegram' limit 1) as tg_id,
            (select photo_url from app.users where id = $1) as photo_url,
            (select email from app.identities where user_id = $1 and provider = 'supabase' limit 1) as email`,
    [auth.id],
  );
  return json({
    user: {
      ...publicUser(user), telegramUsername: extra?.telegram ?? null, hasTelegram: Boolean(extra?.tg_id), email: extra?.email ?? null,
      photoUrl: extra?.photo_url ?? null,
    },
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
