/**
 * Browser notifications (Web Push) for website customers: Profile → "Notifications
 * on this device" subscribes the browser; the outbox then also sends a short
 * notification for the customer's messages (delivered, refunded, topped up…).
 *
 * Standard Web Push with the platform's crypto, no library:
 *  - VAPID (RFC 8292): an ES256 token signed with the store's key pair, made on
 *    first use and kept in app.settings ("push.vapid", the private key
 *    encrypted with DATA_KEY).
 *  - Message encryption (RFC 8291, aes128gcm): ECDH with the browser's key,
 *    HKDF, AES-128-GCM.
 * Only the push services of the main browsers are called (no other address).
 */
import { decryptText, encryptText, fromBase64Url, toBase64Url, utf8 } from "@store/core";
import { requireUser } from "./auth";
import type { ApiEnv, Ctx, Services } from "./context";
import { one } from "./db";
import { ApiError, json, readJson } from "./http";

/** The push services of Chrome/Edge/Android, Firefox, Windows and Safari. */
const PUSH_HOSTS = /^(fcm\.googleapis\.com|android\.googleapis\.com|updates\.push\.services\.mozilla\.com|[a-z0-9.-]+\.notify\.windows\.com|web\.push\.apple\.com|[a-z0-9.-]+\.push\.apple\.com)$/;

export function pushEndpointAllowed(endpoint: string): boolean {
  try {
    const u = new URL(endpoint);
    return u.protocol === "https:" && PUSH_HOSTS.test(u.hostname);
  } catch {
    return false;
  }
}

type Bytes = Uint8Array<ArrayBuffer>;
const bytes = (b: ArrayBuffer): Bytes => new Uint8Array(b);
const concat = (...parts: Uint8Array[]): Bytes => {
  const out = new Uint8Array(new ArrayBuffer(parts.reduce((n, p) => n + p.length, 0)));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
};

export interface Vapid {
  publicKey: string; // base64url, 65-byte uncompressed point
  privateKey: CryptoKey;
}

let cached: { key: string; vapid: Vapid } | null = null;

/** The store's VAPID key pair: made once, the private half encrypted with DATA_KEY. */
export async function vapidKeys(svc: Pick<Services, "db">, env: Pick<ApiEnv, "DATA_KEY">): Promise<Vapid> {
  let row = await one<{ value: { public: string; private_enc: string } }>(svc.db, `select value from app.settings where key = 'push.vapid'`);
  if (!row) {
    const pair = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"])) as CryptoKeyPair;
    const pub = toBase64Url(bytes((await crypto.subtle.exportKey("raw", pair.publicKey)) as ArrayBuffer));
    const pkcs8 = toBase64Url(bytes((await crypto.subtle.exportKey("pkcs8", pair.privateKey)) as ArrayBuffer));
    await svc.db.query(
      `insert into app.settings (key, value) values ('push.vapid', $1::text::jsonb) on conflict (key) do nothing`,
      [JSON.stringify({ public: pub, private_enc: await encryptText(pkcs8, env.DATA_KEY) })],
    );
    row = await one(svc.db, `select value from app.settings where key = 'push.vapid'`);
    if (!row) throw new Error("push keys not saved");
  }
  if (cached?.key === row.value.public) return cached.vapid;
  const pkcs8 = fromBase64Url(await decryptText(row.value.private_enc, env.DATA_KEY));
  const privateKey = await crypto.subtle.importKey("pkcs8", pkcs8, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  const vapid = { publicKey: row.value.public, privateKey };
  cached = { key: row.value.public, vapid };
  return vapid;
}

async function vapidHeader(vapid: Vapid, endpoint: string, subject: string, now: Date): Promise<string> {
  const aud = new URL(endpoint).origin;
  const enc = (o: unknown) => toBase64Url(utf8(JSON.stringify(o)));
  const unsigned = `${enc({ typ: "JWT", alg: "ES256" })}.${enc({ aud, exp: Math.floor(now.getTime() / 1000) + 12 * 3600, sub: subject })}`;
  const sig = bytes(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, vapid.privateKey, utf8(unsigned)));
  return `vapid t=${unsigned}.${toBase64Url(sig)}, k=${vapid.publicKey}`;
}

async function hkdf(salt: Bytes, ikm: Bytes, info: Bytes, length: number): Promise<Bytes> {
  const key = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  return bytes(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info }, key, length * 8));
}

/**
 * RFC 8291 aes128gcm body for one message to one browser. `ephemeral` and
 * `salt` are only passed by tests.
 */
export async function encryptPayload(
  payload: Bytes,
  uaPublicB64: string,
  authB64: string,
  opts: { ephemeral?: CryptoKeyPair; salt?: Bytes } = {},
): Promise<Bytes> {
  const uaPublic = fromBase64Url(uaPublicB64);
  const auth = fromBase64Url(authB64);
  if (uaPublic.length !== 65 || auth.length !== 16) throw new ApiError("invalid_input", "keys");
  const eph = opts.ephemeral ?? ((await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"])) as CryptoKeyPair);
  const asPublic = bytes((await crypto.subtle.exportKey("raw", eph.publicKey)) as ArrayBuffer);
  const uaKey = await crypto.subtle.importKey("raw", uaPublic, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const shared = bytes(await crypto.subtle.deriveBits({ name: "ECDH", public: uaKey } as unknown as Parameters<SubtleCrypto["deriveBits"]>[0] /* the standard name; Workers' types call it $public */, eph.privateKey, 256));
  const ikm = await hkdf(auth, shared, concat(utf8("WebPush: info\0"), uaPublic, asPublic), 32);
  const salt = opts.salt ?? crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, ikm, utf8("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(salt, ikm, utf8("Content-Encoding: nonce\0"), 12);
  const key = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["encrypt"]);
  // One record: the message, then the last-record delimiter (no padding).
  const sealed = bytes(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, key, concat(payload, Uint8Array.of(2))));
  const header = new Uint8Array(new ArrayBuffer(21));
  header.set(salt, 0);
  new DataView(header.buffer).setUint32(16, 4096);
  header[20] = asPublic.length;
  return concat(header, asPublic, sealed);
}

export interface PushMessage {
  title: string;
  body: string;
  url: string;
  lang: "ar" | "en";
}

/** Browsers notified per message (the newest subscriptions): each is one request. */
export const PUSH_MAX_BROWSERS = 5;
/** Subscriptions kept per customer; subscribing one more forgets the oldest. */
export const PUSH_MAX_SUBSCRIPTIONS = 10;

/**
 * Send `msg` to the browsers the user subscribed (the newest `max`, at most
 * PUSH_MAX_BROWSERS), while more than `reserve` requests are left in this run.
 * Gone subscriptions are removed. Returns how many went out. `vapid` saves
 * reading the key again when sending many.
 */
export async function pushToUser(
  svc: Services,
  env: ApiEnv,
  userId: string,
  msg: PushMessage,
  subject: string,
  opts: { vapid?: Vapid; max?: number; reserve?: number } = {},
): Promise<number> {
  const subs = await svc.db.query<{ id: string; endpoint: string; p256dh: string; auth: string }>(
    `select id, endpoint, p256dh, auth from app.push_subscriptions where user_id = $1 order by created_at desc limit $2`,
    [userId, Math.max(0, Math.min(PUSH_MAX_BROWSERS, opts.max ?? PUSH_MAX_BROWSERS))],
  );
  if (!subs.length) return 0;
  const vapid = opts.vapid ?? (await vapidKeys(svc, env));
  const payload = utf8(JSON.stringify({ ...msg, dir: msg.lang === "ar" ? "rtl" : "ltr" }));
  let sent = 0;
  for (const s of subs) {
    if (!pushEndpointAllowed(s.endpoint)) continue;
    if (svc.budget && svc.budget.left() <= (opts.reserve ?? 1)) break;
    try {
      const res = await svc.fetch(s.endpoint, {
        method: "POST",
        headers: {
          authorization: await vapidHeader(vapid, s.endpoint, subject, svc.now()),
          "content-encoding": "aes128gcm",
          "content-type": "application/octet-stream",
          ttl: "86400",
          urgency: "normal",
        },
        body: await encryptPayload(payload, s.p256dh, s.auth),
      });
      if (res.status === 404 || res.status === 410) {
        await svc.db.query(`delete from app.push_subscriptions where id = $1`, [s.id]);
      } else if (res.ok) {
        await svc.db.query(`update app.push_subscriptions set last_ok_at = now(), failures = 0 where id = $1`, [s.id]);
        sent++;
      } else {
        await svc.db.query(`update app.push_subscriptions set failures = failures + 1 where id = $1`, [s.id]);
        await svc.db.query(`delete from app.push_subscriptions where id = $1 and failures >= 5`, [s.id]);
      }
    } catch {
      await svc.db.query(`update app.push_subscriptions set failures = failures + 1 where id = $1`, [s.id]);
    }
  }
  return sent;
}

// ─────────────────────────────────────────────────────────────── API

/** GET /api/push/key — the store's public key, for the browser's subscribe call. */
export async function pushKey(ctx: Ctx): Promise<Response> {
  const v = await vapidKeys(ctx.svc, ctx.env);
  return json({ publicKey: v.publicKey }, { headers: { "cache-control": "public, max-age=3600" } });
}

/** POST /api/push/subscribe { endpoint, keys: { p256dh, auth } } */
export async function subscribePush(ctx: Ctx): Promise<Response> {
  const user = await requireUser(ctx);
  const body = await readJson(ctx.req);
  const endpoint = typeof body.endpoint === "string" ? body.endpoint : "";
  const keys = (body.keys ?? {}) as Record<string, unknown>;
  const p256dh = typeof keys.p256dh === "string" ? keys.p256dh : "";
  const auth = typeof keys.auth === "string" ? keys.auth : "";
  if (!pushEndpointAllowed(endpoint) || endpoint.length > 1000) throw new ApiError("invalid_input", "endpoint");
  try {
    if (fromBase64Url(p256dh).length !== 65 || fromBase64Url(auth).length !== 16) throw new Error("keys");
  } catch {
    throw new ApiError("invalid_input", "keys");
  }
  // A browser already subscribed for another account stays with that account
  // (it unsubscribes when that customer signs out); nobody can take over
  // someone else's subscription by sending its address.
  const saved = await ctx.svc.db.query(
    `insert into app.push_subscriptions (user_id, endpoint, p256dh, auth) values ($1, $2, $3, $4)
     on conflict (endpoint) do update set p256dh = excluded.p256dh, auth = excluded.auth, failures = 0
       where app.push_subscriptions.user_id = excluded.user_id
     returning id`,
    [user.id, endpoint, p256dh, auth],
  );
  if (!saved.length) throw new ApiError("bad_state", "endpoint");
  // A handful of browsers per customer: the oldest go first.
  await ctx.svc.db.query(
    `delete from app.push_subscriptions where user_id = $1
        and id not in (select id from app.push_subscriptions where user_id = $1 order by created_at desc, id desc limit $2)`,
    [user.id, PUSH_MAX_SUBSCRIPTIONS],
  );
  return json({ ok: true });
}

/** POST /api/push/unsubscribe { endpoint } */
export async function unsubscribePush(ctx: Ctx): Promise<Response> {
  const user = await requireUser(ctx);
  const body = await readJson(ctx.req);
  const endpoint = typeof body.endpoint === "string" ? body.endpoint : "";
  await ctx.svc.db.query(`delete from app.push_subscriptions where user_id = $1 and endpoint = $2`, [user.id, endpoint]);
  return json({ ok: true });
}
