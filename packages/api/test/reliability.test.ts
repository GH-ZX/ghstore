/**
 * Reliability: browser notifications off until the owner turns them on and
 * kept inside the run's request budget; subscriptions nobody can take over;
 * supplier price checks that survive one broken group, back off and never run
 * twice at once; payment re-checks that put live top-ups first; the health
 * checks; nightly housekeeping.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { toBase64Url } from "@store/core";
import type { SupplierAdapter, SupplierProduct } from "@store/core";
import { sendOutbox } from "../src/notify";
import { connectTestDb, env, Harness } from "./helpers";

const conn = await connectTestDb();
const db = conn.db;
const h = new Harness(db);
const run = Date.now().toString(36);
const base = 870_000_000 + (Date.now() % 1_000_000);
let seq = 0;

const setting = (key: string, value: unknown) =>
  db.query(`insert into app.settings (key, value) values ($1, $2::text::jsonb) on conflict (key) do update set value = excluded.value`, [key, JSON.stringify(value)]);

async function customer(): Promise<{ id: string; token: string }> {
  const token = await h.login(base + ++seq, `Rel ${seq}`, "en");
  const id = (await h.call("GET", "/api/me", { token })).data.user.id as string;
  return { id, token };
}

async function browserKeys() {
  const ua = (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"])) as CryptoKeyPair;
  return { p256dh: toBase64Url(new Uint8Array(await crypto.subtle.exportKey("raw", ua.publicKey))), auth: toBase64Url(crypto.getRandomValues(new Uint8Array(16))) };
}

async function subscribe(c: { token: string }, name: string) {
  return h.call("POST", "/api/push/subscribe", { token: c.token, body: { endpoint: `https://fcm.googleapis.com/fcm/send/rel-${run}-${name}`, keys: await browserKeys() } });
}

/** Only this test's messages are due: everything else waits. */
async function onlyMine(userId: string) {
  await db.query(`update app.outbox set available_at = now() + interval '1 hour' where status = 'pending' and user_id is distinct from $1`, [userId]);
}

beforeAll(async () => {
  await h.login(900001, "Owner");
});

afterAll(async () => {
  await db.query(`delete from app.settings where key = 'push.enabled'`);
  await conn.close();
});

describe("browser notifications", () => {
  it("are off until the owner turns them on, in the public config too", async () => {
    await db.query(`delete from app.settings where key = 'push.enabled'`);
    expect((await h.call("GET", "/api/config")).data.push).toEqual({ enabled: false });
    const owner = await h.login(900001, "Owner");
    expect((await h.call("PUT", "/api/admin/settings/push.enabled", { token: owner, body: { value: "yes" } })).status).toBe(400);
    expect((await h.call("PUT", "/api/admin/settings/push.enabled", { token: owner, body: { value: true } })).status).toBe(200);
    expect((await h.call("GET", "/api/config")).data.push).toEqual({ enabled: true });
    await db.query(`delete from app.settings where key = 'push.enabled'`);
  });

  it("are not sent while off, and sent once on", async () => {
    const c = await customer();
    expect((await subscribe(c, "a")).status).toBe(200);
    const pushed: string[] = [];
    h.fetchImpl = async (input) => {
      pushed.push(String(input));
      return new Response(null, { status: 201 });
    };
    const queue = () => db.query(`insert into app.outbox (user_id, template, data) values ($1, 'payment_credited', '{"amount_cents": 500}'::jsonb)`, [c.id]);

    await queue();
    await onlyMine(c.id);
    expect(await sendOutbox(h.svc, env, 25)).toBe(1); // the Telegram message
    expect(pushed).toEqual([]);

    await setting("push.enabled", true);
    await queue();
    await onlyMine(c.id);
    expect(await sendOutbox(h.svc, env, 25)).toBe(1);
    expect(pushed).toEqual([`https://fcm.googleapis.com/fcm/send/rel-${run}-a`]);
    await db.query(`delete from app.settings where key = 'push.enabled'`);
  });

  it("stay inside the run's requests: what does not fit waits, without counting as an attempt", async () => {
    await setting("push.enabled", true);
    const c = await customer();
    for (const b of ["x", "y", "z"]) expect((await subscribe(c, `${c.id}-${b}`)).status).toBe(200);
    let calls = 0;
    h.fetchImpl = async () => {
      calls++;
      return new Response(null, { status: 201 });
    };
    const id = (await db.query<{ id: string }>(`insert into app.outbox (user_id, template, data) values ($1, 'payment_credited', '{"amount_cents": 700}'::jsonb) returning id`, [c.id]))[0]!.id;
    await onlyMine(c.id);
    h.telegramCalls = [];
    // 1 message + 3 browsers = 4 requests; 5 left with 2 kept back for later jobs: does not fit.
    const tight = { ...h.svc, budget: { left: () => 5 } };
    expect(await sendOutbox(tight, env, 25, 2)).toBe(0);
    expect(calls).toBe(0);
    expect(h.telegramCalls).toEqual([]);
    const row = (await db.query<{ status: string; attempts: number; due: boolean }>(`select status, attempts, available_at <= now() as due from app.outbox where id = $1`, [id]))[0]!;
    expect(row).toEqual({ status: "pending", attempts: 0, due: true });
    // With room: the message and its three notifications.
    expect(await sendOutbox({ ...h.svc, budget: { left: () => 6 } }, env, 25, 2)).toBe(1);
    expect(calls).toBe(3);
    await db.query(`delete from app.settings where key = 'push.enabled'`);
  });

  it("subscriptions stay with their account, a few per customer", async () => {
    const a = await customer();
    const b = await customer();
    const endpoint = `https://fcm.googleapis.com/fcm/send/rel-${run}-shared`;
    const keys = await browserKeys();
    expect((await h.call("POST", "/api/push/subscribe", { token: a.token, body: { endpoint, keys } })).status).toBe(200);
    // Someone else sending the same address does not take it over.
    expect((await h.call("POST", "/api/push/subscribe", { token: b.token, body: { endpoint, keys } })).status).toBe(409);
    expect((await db.query<{ user_id: string }>(`select user_id from app.push_subscriptions where endpoint = $1`, [endpoint]))[0]!.user_id).toBe(a.id);
    // The same customer again: fine (new keys saved).
    expect((await h.call("POST", "/api/push/subscribe", { token: a.token, body: { endpoint, keys: await browserKeys() } })).status).toBe(200);
    for (let i = 0; i < 12; i++) expect((await subscribe(a, `${a.id}-many-${i}`)).status).toBe(200);
    const kept = await db.query<{ endpoint: string }>(`select endpoint from app.push_subscriptions where user_id = $1`, [a.id]);
    expect(kept.length).toBe(10);
    expect(kept.map((k) => k.endpoint)).toContain(`https://fcm.googleapis.com/fcm/send/rel-${run}-${a.id}-many-11`);
    expect(kept.map((k) => k.endpoint)).not.toContain(endpoint); // the oldest went
  });
});
