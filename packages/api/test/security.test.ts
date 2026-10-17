/**
 * Security hardening: Mini App initData freshness, throttles on sign-in,
 * coupon quotes, problem reports and reviews, the cap on live sessions, and
 * the cap on open USDT requests per customer.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { hmacSha256, toHex, utf8, type PaymentAdapter } from "@store/core";
import { handle } from "../src/index";
import { MAX_SESSIONS_PER_CHANNEL } from "../src/auth";
import { clientIp, ipv6Prefix64, LIMITS } from "../src/ratelimit";
import { BOT_TOKEN, connectTestDb, env, Harness } from "./helpers";

const conn = await connectTestDb();
const db = conn.db;
const h = new Harness(db);
const base = 860_000_000 + (Date.now() % 1_000_000);

const fakeBep20: PaymentAdapter = {
  id: "bep20",
  createPayment: async (input) => ({
    providerRef: input.paymentId,
    action: { type: "address", network: "BSC (BEP20)", asset: "USDT", address: "0xstore", amount: ((input.sendUnits ?? input.amountCents * 100) / 10_000).toFixed(4) },
  }),
  checkPayment: async (txHash) => ({ providerRef: txHash, txHash, status: "pending" }),
};

beforeAll(() => {
  h.payments.set("bep20", fakeBep20);
});

afterAll(async () => {
  await conn.close();
});

/** Mini App initData signed like Telegram does, `ageSeconds` old. */
async function initData(telegramId: number, ageSeconds: number): Promise<string> {
  const fields: Record<string, string> = {
    auth_date: String(Math.floor(Date.now() / 1000) - ageSeconds),
    query_id: "AAE",
    user: JSON.stringify({ id: telegramId, first_name: "Sec", language_code: "en" }),
  };
  const dcs = Object.keys(fields).sort().map((k) => `${k}=${fields[k]}`).join("\n");
  const secret = await hmacSha256(utf8("WebAppData"), BOT_TOKEN);
  const hash = toHex(await hmacSha256(secret, dcs));
  return new URLSearchParams({ ...fields, hash }).toString();
}

/** POST /api/auth/telegram, optionally from a given address. */
async function miniAppLogin(data: string, ip?: string) {
  const headers: Record<string, string> = { "content-type": "application/json", origin: env.PUBLIC_BASE_URL };
  if (ip) headers["cf-connecting-ip"] = ip;
  const res = await handle(new Request(`${env.PUBLIC_BASE_URL}/api/auth/telegram`, { method: "POST", headers, body: JSON.stringify({ initData: data }) }), env, h.svc);
  return { status: res.status, data: (await res.json()) as Record<string, any> };
}

/** Use up a throttle key so the next request is over the limit. */
async function exhaust(key: string, limit: { max: number; windowSeconds: number }) {
  for (let i = 0; i < limit.max; i++) await db.query(`select app.rate_limit_hit($1, $2, $3)`, [key, limit.max, limit.windowSeconds]);
}

async function userId(token: string): Promise<string> {
  return (await h.call("GET", "/api/me", { token })).data.user.id as string;
}

describe("Mini App sign-in", () => {
  it("accepts initData up to an hour old, not older", async () => {
    expect((await miniAppLogin(await initData(base + 1, 30 * 60))).status).toBe(200);
    const stale = await miniAppLogin(await initData(base + 1, 2 * 3600));
    expect(stale.status).toBe(401);
  });
});

describe("sign-in throttles", () => {
  it("limits attempts per address, other addresses unaffected", async () => {
    const ip = `203.0.113.${(Date.now() % 200) + 1}`;
    await db.query(`delete from app.rate_limits where key = $1`, [`login:ip:${ip}`]);
    await exhaust(`login:ip:${ip}`, LIMITS.loginPerIp);
    const blocked = await miniAppLogin(await initData(base + 2, 5), ip);
    expect(blocked.status).toBe(429);
    expect(blocked.data.error.code).toBe("rate_limited");
    // Even a bad signature is turned away first.
    expect((await miniAppLogin("hash=00&auth_date=1", ip)).status).toBe(429);
    expect((await miniAppLogin(await initData(base + 2, 5), "198.51.100.7")).status).toBe(200);
  });

  it("limits sign-ins per Telegram account", async () => {
    const id = base + 3;
    await exhaust(`login:tg:${id}`, LIMITS.loginPerIdentity);
    const r = await miniAppLogin(await initData(id, 5));
    expect(r.status).toBe(429);
    expect((await miniAppLogin(await initData(base + 4, 5))).status).toBe(200);
  });

  it("applies to the website's Telegram widget and Supabase sign-in too", async () => {
    const ip = "198.51.100.200";
    await db.query(`delete from app.rate_limits where key = $1`, [`login:ip:${ip}`]);
    await exhaust(`login:ip:${ip}`, LIMITS.loginPerIp);
    for (const path of ["/api/auth/telegram-widget", "/api/auth/web"]) {
      const res = await handle(
        new Request(`${env.PUBLIC_BASE_URL}${path}`, {
          method: "POST",
          headers: { "content-type": "application/json", origin: env.PUBLIC_BASE_URL, "cf-connecting-ip": ip },
          body: JSON.stringify({ accessToken: "x" }),
        }),
        env,
        h.svc,
      );
      expect(res.status, path).toBe(429);
    }
  });

  it("reads the address from CF-Connecting-IP only, IPv6 by its /64", () => {
    const req = (headers: Record<string, string>) => new Request("https://x.test/", { headers });
    expect(clientIp(req({ "cf-connecting-ip": "1.2.3.4" }))).toBe("1.2.3.4");
    expect(clientIp(req({ "x-forwarded-for": "1.2.3.4" }))).toBeNull();
    expect(clientIp(req({ "cf-connecting-ip": "not an ip" }))).toBeNull();
    expect(clientIp(req({ "cf-connecting-ip": "2001:db8:abcd:12:1:2:3:4" }))).toBe("2001:db8:abcd:12");
    expect(clientIp(req({ "cf-connecting-ip": "2001:db8::1" }))).toBe("2001:db8:0:0");
    expect(ipv6Prefix64("::1")).toBe("0:0:0:0");
    expect(ipv6Prefix64("1::2::3")).toBeNull();
  });
});

describe("sessions", () => {
  it(`keeps at most ${MAX_SESSIONS_PER_CHANNEL} live sessions per account and channel, ending the oldest`, async () => {
    const id = base + 5;
    const tokens: string[] = [];
    for (let i = 0; i < MAX_SESSIONS_PER_CHANNEL + 2; i++) tokens.push(await h.login(id, "Many"));
    expect((await h.call("GET", "/api/me", { token: tokens[0] })).status).toBe(401);
    expect((await h.call("GET", "/api/me", { token: tokens[1] })).status).toBe(401);
    expect((await h.call("GET", "/api/me", { token: tokens[2] })).status).toBe(200);
    expect((await h.call("GET", "/api/me", { token: tokens.at(-1) })).status).toBe(200);
    const uid = await userId(tokens.at(-1)!);
    const live = await db.query<{ c: string | number }>(
      `select count(*) as c from app.sessions where user_id = $1 and revoked_at is null and expires_at > now()`,
      [uid],
    );
    expect(Number(live[0]!.c)).toBe(MAX_SESSIONS_PER_CHANNEL);
  });
});

describe("customer throttles", () => {
  it("caps coupon quotes per customer, good code or not", async () => {
    const token = await h.login(base + 6, "Guesser");
    const offerId = "00000000-0000-7000-8000-000000000000";
    for (let i = 0; i < LIMITS.couponQuote.max; i++) {
      const r = await h.call("POST", "/api/coupons/quote", { token, body: { offerId, code: `GUESS${i}` } });
      expect(r.status).not.toBe(429);
    }
    const over = await h.call("POST", "/api/coupons/quote", { token, body: { offerId, code: "GUESSX" } });
    expect(over.status).toBe(429);
    expect(over.data.error.code).toBe("rate_limited");
    // Another customer is unaffected.
    const other = await h.login(base + 7, "Other");
    expect((await h.call("POST", "/api/coupons/quote", { token: other, body: { offerId, code: "GUESSX" } })).status).not.toBe(429);
  });

  it("caps problem reports and review saves per customer", async () => {
    const token = await h.login(base + 8, "Noisy");
    const uid = await userId(token);
    const order = "00000000-0000-7000-8000-000000000001";
    expect((await h.call("POST", `/api/orders/${order}/problem`, { token, body: { reason: "not_received" } })).status).toBe(404);
    await exhaust(`problem:${uid}`, LIMITS.problemReport);
    expect((await h.call("POST", `/api/orders/${order}/problem`, { token, body: { reason: "not_received" } })).status).toBe(429);

    expect((await h.call("PUT", "/api/products/no-such-product/review", { token, body: { rating: 5 } })).status).not.toBe(429);
    await exhaust(`review:${uid}`, LIMITS.reviewSave);
    expect((await h.call("PUT", "/api/products/no-such-product/review", { token, body: { rating: 5 } })).status).toBe(429);
  });
});

describe("USDT requests", () => {
  it("lets a customer hold at most two open USDT requests", async () => {
    const token = await h.login(base + 9, "Holder");
    const ids: string[] = [];
    for (let i = 0; i < 2; i++) {
      const r = await h.call("POST", "/api/topups", { token, body: { method: "bep20", amountCents: 1000 } });
      expect(r.status, JSON.stringify(r.data)).toBe(201);
      ids.push(r.data.paymentId as string);
    }
    const third = await h.call("POST", "/api/topups", { token, body: { method: "bep20", amountCents: 1500 } });
    expect(third.status).toBe(429);
    expect(third.data.error.code).toBe("rate_limited");
    // Cancelling one frees a place.
    expect((await h.call("POST", `/api/topups/${ids[0]}/cancel`, { token })).status).toBe(200);
    expect((await h.call("POST", "/api/topups", { token, body: { method: "bep20", amountCents: 1500 } })).status).toBe(201);
    await db.query(`update app.payments set status = 'expired' where user_id = $1 and status in ('created', 'pending')`, [await userId(token)]);
  });
});
