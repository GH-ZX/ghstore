/** One customer, every door: linking a website login (email/Google) and a Telegram account. */
import { afterAll, describe, expect, it } from "vitest";
import { hmacSha256, toHex } from "@store/core";
import { BOT_TOKEN, connectTestDb, env, Harness } from "./helpers";

const conn = await connectTestDb();
const db = conn.db;
const h = new Harness(db);
const base = 780_000_000 + (Date.now() % 100_000_000);
const hex = Date.now().toString(16).padStart(12, "0").slice(-12);
const sbId = (k: number) => `00000000-0000-4000-8000-${(Number.parseInt(hex, 16) + k).toString(16).padStart(12, "0").slice(-12)}`;

const saved = { url: env.SUPABASE_URL, key: env.SUPABASE_PUBLISHABLE_KEY };
env.SUPABASE_URL = "https://sb.test";
env.SUPABASE_PUBLISHABLE_KEY = "sb_publishable_test";
// Supabase Auth stand-in: the access token "tok-<uuid>" belongs to that user.
const emails = new Map<string, string>();
const googleIds = new Set<string>();
h.fetchImpl = async (input, init) => {
  const url = String(input);
  if (url !== "https://sb.test/auth/v1/user") return new Response("not mocked", { status: 500 });
  const auth = new Headers(init?.headers).get("authorization") ?? "";
  const id = auth.replace(/^Bearer tok-/, "");
  if (!emails.has(id)) return new Response("{}", { status: 401 });
  const google = googleIds.has(id);
  return Response.json({
    id, email: emails.get(id), user_metadata: { full_name: "Web Person" },
    app_metadata: { provider: google ? "google" : "email", providers: [google ? "google" : "email"] },
  });
};

afterAll(async () => {
  env.SUPABASE_URL = saved.url;
  env.SUPABASE_PUBLISHABLE_KEY = saved.key;
  await conn.close();
});

function cookieToken(res: { headers: Headers }): string | null {
  const c = res.headers.get("set-cookie");
  return c ? decodeURIComponent(c.split(";")[0]!.split("=")[1]!) : null;
}

async function raw(path: string, token: string, body: unknown) {
  const { handle } = await import("../src/index");
  const res = await handle(
    new Request(`${env.PUBLIC_BASE_URL}${path}`, {
      method: "POST",
      headers: { origin: env.PUBLIC_BASE_URL, "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    }),
    env,
    h.svc,
  );
  return { status: res.status, data: (await res.json()) as Record<string, any>, headers: res.headers };
}

/** Profile → Connect: start the link from this session, then send the login with its one-time state. */
async function link(path: "/api/me/link/web" | "/api/me/link/telegram", token: string, body: Record<string, unknown>) {
  const start = await raw("/api/me/link/start", token, { provider: path.endsWith("/web") ? "supabase" : "telegram" });
  expect(start.status).toBe(200);
  return raw(path, token, { ...body, state: start.data.state });
}

async function webLogin(id: string, email: string): Promise<string> {
  emails.set(id, email);
  const { handle } = await import("../src/index");
  const res = await handle(
    new Request(`${env.PUBLIC_BASE_URL}/api/auth/web`, {
      method: "POST",
      headers: { origin: env.PUBLIC_BASE_URL, "content-type": "application/json" },
      body: JSON.stringify({ accessToken: `tok-${id}` }),
    }),
    env,
    h.svc,
  );
  expect(res.status).toBe(200);
  return cookieToken(res)!;
}

async function widget(id: number, username?: string): Promise<Record<string, string>> {
  const fields: Record<string, string> = { id: String(id), first_name: "Tele", auth_date: String(Math.floor(Date.now() / 1000) - 5) };
  if (username) fields.username = username;
  const dcs = Object.keys(fields).sort().map((k) => `${k}=${fields[k]}`).join("\n");
  const secret = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(BOT_TOKEN)));
  return { ...fields, hash: toHex(await hmacSha256(secret, dcs)) };
}

async function userOf(token: string): Promise<{ id: string; email: string | null; hasTelegram: boolean; channel: string }> {
  const me = await h.call("GET", "/api/me", { token });
  expect(me.status).toBe(200);
  return { ...me.data.user, channel: me.data.channel };
}

/** Give an account some history (a past wallet movement). */
async function used(userId: string): Promise<void> {
  await db.query(
    `insert into app.ledger (user_id, amount_cents, kind, ref_type, ref_id, balance_after_cents) values ($1, 100, 'adjustment', 'admin', gen_random_uuid(), 100)`,
    [userId],
  );
}

describe("linking logins", () => {
  it("offers email by default and Google once the owner switches it on", async () => {
    const saveMethods = env.WEB_LOGIN_METHODS;
    env.WEB_LOGIN_METHODS = "telegram,email,google";
    try {
      expect((await h.call("GET", "/api/config")).data.login).toEqual(["telegram", "email"]);
      await db.query(`update app.settings set value = 'true' where key = 'login.google'`);
      await db.query(`update app.settings set value = 'false' where key = 'login.email'`);
      expect((await h.call("GET", "/api/config")).data.login).toEqual(["telegram", "google"]);
    } finally {
      await db.query(`update app.settings set value = 'false' where key = 'login.google'`);
      await db.query(`update app.settings set value = 'true' where key = 'login.email'`);
      env.WEB_LOGIN_METHODS = saveMethods;
    }
  });

  it("adds an email to a Telegram customer, once", async () => {
    const mini = await h.login(base + 1, "Sara");
    const before = await userOf(mini);
    expect(before.email).toBeNull();

    emails.set(sbId(1), "sara@example.com");
    const r = await link("/api/me/link/web", mini, { accessToken: `tok-${sbId(1)}` });
    expect(r.status).toBe(200);
    expect(r.data).toMatchObject({ linked: "supabase", merged: false, switched: false });
    expect((await userOf(mini)).email).toBe("sara@example.com");

    // The same email again changes nothing; a second email is refused.
    expect((await link("/api/me/link/web", mini, { accessToken: `tok-${sbId(1)}` })).status).toBe(200);
    emails.set(sbId(2), "other@example.com");
    const second = await link("/api/me/link/web", mini, { accessToken: `tok-${sbId(2)}` });
    expect(second.status).toBe(409);
    expect(second.data.error.code).toBe("already_linked");
    expect((await link("/api/me/link/web", mini, { accessToken: "tok-nobody" })).status).toBe(401);

    // Signing in on the website with that email now opens the same wallet.
    const web = await webLogin(sbId(1), "sara@example.com");
    expect((await userOf(web)).id).toBe(before.id);
  });

  it("moves a new website account into the Telegram account that has history", async () => {
    const tgId = base + 2;
    const mini = await h.login(tgId, "Omar");
    const tgUser = await userOf(mini);
    await used(tgUser.id);

    const web = await webLogin(sbId(3), "omar@example.com");
    const webUser = await userOf(web);
    expect(webUser.id).not.toBe(tgUser.id);

    const r = await link("/api/me/link/telegram", web, await widget(tgId, "omar_tg"));
    expect(r.status).toBe(200);
    expect(r.data).toMatchObject({ linked: "telegram", merged: true, switched: true });
    const fresh = cookieToken(r);
    expect(fresh).toBeTruthy();
    const now = await userOf(fresh!);
    expect(now).toMatchObject({ id: tgUser.id, email: "omar@example.com", hasTelegram: true, channel: "web" });
    // The emptied account is signed out everywhere.
    expect((await h.call("GET", "/api/me", { token: web })).status).toBe(401);
    expect((await userOf(await webLogin(sbId(3), "omar@example.com"))).id).toBe(tgUser.id);
    const merged = await db.query(`select 1 from app.audit_log where action = 'user.merge' and target_id = $1`, [tgUser.id]);
    expect(merged.length).toBe(1);
  });

  it("brings a Telegram login into a website account when the Telegram one was never used", async () => {
    const web = await webLogin(sbId(4), "noor@example.com");
    const webUser = await userOf(web);
    await used(webUser.id);
    const tgId = base + 4;
    await h.login(tgId, "Noor"); // created by opening the bot once, never used

    const r = await link("/api/me/link/telegram", web, await widget(tgId));
    expect(r.status).toBe(200);
    expect(r.data).toMatchObject({ merged: true, switched: false });
    expect(await userOf(web)).toMatchObject({ id: webUser.id, hasTelegram: true });
    expect((await userOf(await h.login(tgId, "Noor"))).id).toBe(webUser.id);
  });

  it("never merges two accounts that both have history", async () => {
    const tgId = base + 5;
    const mini = await h.login(tgId, "Ali");
    await used((await userOf(mini)).id);
    const web = await webLogin(sbId(5), "ali@example.com");
    await used((await userOf(web)).id);

    const r = await link("/api/me/link/telegram", web, await widget(tgId));
    expect(r.status).toBe(409);
    expect(r.data.error.code).toBe("account_in_use");
    expect((await userOf(web)).hasTelegram).toBe(false);
    const forged = await widget(tgId);
    expect((await link("/api/me/link/telegram", web, { ...forged, id: String(tgId + 1) })).status).toBe(401);
  });

  it("removes a login only while another one remains", async () => {
    const mini = await h.login(base + 6, "Huda");
    emails.set(sbId(6), "huda@example.com");
    expect((await link("/api/me/link/web", mini, { accessToken: `tok-${sbId(6)}` })).status).toBe(200);
    // In the Mini App the Telegram login is the one in use.
    expect((await raw("/api/me/unlink", mini, { provider: "telegram" })).status).toBe(403);
    const off = await raw("/api/me/unlink", mini, { provider: "supabase" });
    expect(off.status).toBe(200);
    expect(off.data.user.email).toBeNull();
    // The Mini App carries on with the fresh token it was handed; the old one is signed out.
    expect(typeof off.data.token).toBe("string");
    expect((await h.call("GET", "/api/me", { token: mini })).status).toBe(401);
    const now = off.data.token as string;
    const last = await raw("/api/me/unlink", now, { provider: "supabase" });
    expect(last.status).toBe(409);
    expect((await raw("/api/me/unlink", now, { provider: "google" })).status).toBe(400);
  });

  it("refuse a link the account did not start: no state, another session's state, or a used one", async () => {
    // An attacker signs in with their own Telegram and sends the victim a crafted link.
    const victim = await webLogin(sbId(10), "victim@example.com");
    const attackerTg = base + 10;
    const fields = await widget(attackerTg, "attacker");
    const none = await raw("/api/me/link/telegram", victim, fields);
    expect(none.status).toBe(403);
    expect(none.data.error).toEqual({ code: "forbidden", field: "link_state" });
    expect((await raw("/api/me/link/telegram", victim, { ...fields, state: "x".repeat(43) })).status).toBe(403);

    // A state started by the attacker's own session is useless in the victim's.
    const attacker = await h.login(base + 11, "Attacker");
    const theirs = await raw("/api/me/link/start", attacker, { provider: "telegram" });
    expect((await raw("/api/me/link/telegram", victim, { ...fields, state: theirs.data.state })).status).toBe(403);
    // A state for the other kind of login does not fit either.
    const wrongKind = await raw("/api/me/link/start", victim, { provider: "supabase" });
    expect((await raw("/api/me/link/telegram", victim, { ...fields, state: wrongKind.data.state })).status).toBe(403);
    expect((await userOf(victim)).hasTelegram).toBe(false);

    // The real flow works once; the same state cannot be replayed.
    const mine = await raw("/api/me/link/start", victim, { provider: "telegram" });
    const ok = await raw("/api/me/link/telegram", victim, { ...(await widget(base + 12, "victim_tg")), state: mine.data.state });
    expect(ok.status).toBe(200);
    expect((await raw("/api/me/link/telegram", victim, { ...fields, state: mine.data.state })).status).toBe(403);

    // An expired state is refused.
    const old = await raw("/api/me/link/start", victim, { provider: "supabase" });
    await db.query(`update app.link_requests set expires_at = now() - interval '1 second' where provider = 'supabase'`);
    emails.set(sbId(11), "late@example.com");
    expect((await raw("/api/me/link/web", victim, { accessToken: `tok-${sbId(11)}`, state: old.data.state })).status).toBe(403);
  });

  it("enforce the sign-in switches on the server, not only on the page", async () => {
    // Google is off by default: a Google token is refused for sign-in and for linking.
    googleIds.add(sbId(12));
    emails.set(sbId(12), "g@example.com");
    const { handle } = await import("../src/index");
    const signIn = await handle(
      new Request(`${env.PUBLIC_BASE_URL}/api/auth/web`, {
        method: "POST",
        headers: { origin: env.PUBLIC_BASE_URL, "content-type": "application/json" },
        body: JSON.stringify({ accessToken: `tok-${sbId(12)}` }),
      }),
      env,
      h.svc,
    );
    expect(signIn.status).toBe(403);
    const mini = await h.login(base + 13, "Rana");
    expect((await link("/api/me/link/web", mini, { accessToken: `tok-${sbId(12)}` })).status).toBe(403);

    // Email codes switched off: refused too, even with a valid token.
    await db.query(`update app.settings set value = 'false' where key = 'login.email'`);
    try {
      emails.set(sbId(13), "e@example.com");
      expect((await link("/api/me/link/web", mini, { accessToken: `tok-${sbId(13)}` })).status).toBe(403);
    } finally {
      await db.query(`update app.settings set value = 'true' where key = 'login.email'`);
    }
  });

  it("sign out every other session when a login is removed", async () => {
    const tgId = base + 14;
    const web = await webLogin(sbId(14), "kept@example.com");
    const startT = await raw("/api/me/link/start", web, { provider: "telegram" });
    expect((await raw("/api/me/link/telegram", web, { ...(await widget(tgId)), state: startT.data.state })).status).toBe(200);
    const phone = await h.login(tgId, "Phone"); // the Mini App, same account
    expect((await userOf(phone)).email).toBe("kept@example.com");

    const off = await raw("/api/me/unlink", web, { provider: "telegram" });
    expect(off.status).toBe(200);
    expect(off.data.user.hasTelegram).toBe(false);
    // The other session is gone; this one continues with a fresh cookie.
    expect((await h.call("GET", "/api/me", { token: phone })).status).toBe(401);
    expect((await h.call("GET", "/api/me", { token: web })).status).toBe(401);
    const fresh = cookieToken(off)!;
    expect((await userOf(fresh)).email).toBe("kept@example.com");
  });

  it("never merge a blocked account, in either direction", async () => {
    // A blocked Telegram account that was never used cannot be pulled into a fresh website account.
    const blockedTg = base + 15;
    const blocked = await h.login(blockedTg, "Blocked");
    const blockedId = (await userOf(blocked)).id;
    await db.query(`update app.users set status = 'banned' where id = $1`, [blockedId]);
    const web = await webLogin(sbId(15), "fresh@example.com");
    const r = await link("/api/me/link/telegram", web, await widget(blockedTg));
    expect(r.status).toBe(403);
    expect(r.data.error.code).toBe("user_blocked");
    expect((await userOf(web)).hasTelegram).toBe(false);
    const still = await db.query(`select 1 from app.identities where user_id = $1 and provider = 'telegram'`, [blockedId]);
    expect(still.length).toBe(1);
  });
});
