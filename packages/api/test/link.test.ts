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
h.fetchImpl = async (input, init) => {
  const url = String(input);
  if (url !== "https://sb.test/auth/v1/user") return new Response("not mocked", { status: 500 });
  const auth = new Headers(init?.headers).get("authorization") ?? "";
  const id = auth.replace(/^Bearer tok-/, "");
  if (!emails.has(id)) return new Response("{}", { status: 401 });
  return Response.json({ id, email: emails.get(id), user_metadata: { full_name: "Web Person" } });
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
    const r = await raw("/api/me/link/web", mini, { accessToken: `tok-${sbId(1)}` });
    expect(r.status).toBe(200);
    expect(r.data).toMatchObject({ linked: "supabase", merged: false, switched: false });
    expect((await userOf(mini)).email).toBe("sara@example.com");

    // The same email again changes nothing; a second email is refused.
    expect((await raw("/api/me/link/web", mini, { accessToken: `tok-${sbId(1)}` })).status).toBe(200);
    emails.set(sbId(2), "other@example.com");
    const second = await raw("/api/me/link/web", mini, { accessToken: `tok-${sbId(2)}` });
    expect(second.status).toBe(409);
    expect(second.data.error.code).toBe("already_linked");
    expect((await raw("/api/me/link/web", mini, { accessToken: "tok-nobody" })).status).toBe(401);

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

    const r = await raw("/api/me/link/telegram", web, await widget(tgId, "omar_tg"));
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

    const r = await raw("/api/me/link/telegram", web, await widget(tgId));
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

    const r = await raw("/api/me/link/telegram", web, await widget(tgId));
    expect(r.status).toBe(409);
    expect(r.data.error.code).toBe("account_in_use");
    expect((await userOf(web)).hasTelegram).toBe(false);
    const forged = await widget(tgId);
    expect((await raw("/api/me/link/telegram", web, { ...forged, id: String(tgId + 1) })).status).toBe(401);
  });

  it("removes a login only while another one remains", async () => {
    const mini = await h.login(base + 6, "Huda");
    emails.set(sbId(6), "huda@example.com");
    expect((await raw("/api/me/link/web", mini, { accessToken: `tok-${sbId(6)}` })).status).toBe(200);
    // In the Mini App the Telegram login is the one in use.
    expect((await raw("/api/me/unlink", mini, { provider: "telegram" })).status).toBe(403);
    const off = await raw("/api/me/unlink", mini, { provider: "supabase" });
    expect(off.status).toBe(200);
    expect(off.data.user.email).toBeNull();
    const last = await raw("/api/me/unlink", mini, { provider: "supabase" });
    expect(last.status).toBe(409);
    expect((await raw("/api/me/unlink", mini, { provider: "google" })).status).toBe(400);
  });
});
