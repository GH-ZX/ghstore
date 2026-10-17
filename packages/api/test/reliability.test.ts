/**
 * Reliability: browser notifications off until the owner turns them on and
 * kept inside the run's request budget; a few subscriptions per customer;
 * supplier price checks that survive one broken group, back off and never run
 * twice at once; payment re-checks that put live top-ups first; the health
 * checks; nightly housekeeping.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { toBase64Url } from "@store/core";
import type { SupplierAdapter, SupplierProduct } from "@store/core";
import { sendOutbox } from "../src/notify";
import { syncDueSuppliers, syncSupplier } from "../src/sync";
import { recheckPendingPayments } from "../src/jobs";
import { watchHealth } from "../src/health";
import { runHousekeeping } from "../src/housekeeping";
import { refreshDueCatalogues } from "../src/supplier-catalogue";
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

/** Only this test's messages are due: everything else waits (until afterAll). */
const held = new Set<string>();
async function onlyMine(userId: string) {
  const rows = await db.query<{ id: string }>(
    `update app.outbox set available_at = now() + interval '1 hour' where status = 'pending' and user_id is distinct from $1 returning id::text as id`,
    [userId],
  );
  for (const r of rows) held.add(r.id);
}

beforeAll(async () => {
  await h.login(900001, "Owner");
});

afterAll(async () => {
  if (held.size) {
    await db.query(`update app.outbox set available_at = now() where status = 'pending' and id = any(string_to_array($1::text, ',')::bigint[])`, [[...held].join(",")]);
  }
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

// ─────────────────────────────────────────────────────────────── supplier sync

const quiet: Omit<SupplierAdapter, "id"> = {
  name: "Rel",
  listProducts: async () => [],
  getBalance: async () => null,
  purchase: async () => ({ status: "failed", error: "no", retryable: false }),
  checkOrder: async (id) => ({ status: "pending", supplierOrderId: id }),
};

async function offersFor(supplier: string, refs: string[]): Promise<Record<string, string>> {
  const product = (await db.query<{ id: string }>(
    `insert into app.products (slug, category_id, name_ar, name_en, kind, active) values ($1, (select id from app.categories where slug = 'games'), 'منتج', 'Rel', 'code', true) returning id`,
    [`rel-${supplier.replace(/_/g, "-")}`],
  ))[0]!.id;
  const out: Record<string, string> = {};
  for (const ref of refs) {
    out[ref] = (await db.query<{ id: string }>(
      `insert into app.offers (product_id, name_ar, name_en, supplier_id, supplier_ref, cost_cents, price_cents, markup_mode, markup_value)
       values ($1, 'x', 'x', $2, $3, 100, 115, 'percent', 15) returning id`,
      [product, supplier, ref],
    ))[0]!.id;
  }
  return out;
}

const supplierRow = async (id: string) =>
  (await db.query<{ health: string; sync_health: string; sync_error: string | null; sync_failures: number; backing_off: boolean; leased: boolean; last_sync_at: string | null }>(
    `select health, sync_health, sync_error, sync_failures, coalesce(sync_retry_at > now(), false) as backing_off,
            sync_lease_until is not null as leased, last_sync_at from app.suppliers where id = $1`,
    [id],
  ))[0]!;

describe("supplier price checks", () => {
  it("go on when one group fails: the others are saved, the failing one backs off", async () => {
    const supplier = `relg_${run}`;
    await db.query(`insert into app.suppliers (id, name, enabled) values ($1, 'Rel grouped', true)`, [supplier]);
    const offers = await offersFor(supplier, ["a:1", "a:2", "b:1", "c:1"]);
    const asked: string[] = [];
    let brokenB = true;
    h.suppliers.set(supplier, {
      ...quiet,
      id: supplier,
      listProductsFor: async (ids) => {
        const g = ids[0]!.split(":")[0]!;
        asked.push(g);
        if (g === "b" && brokenB) throw new Error("b: bad gateway");
        return ids.map((id): SupplierProduct => ({ externalId: id, name: id, costCents: 110, available: true, kind: "code" }));
      },
      syncGroup: (id) => id.split(":")[0]!,
    });
    const price = async (ref: string) => (await db.query<{ price_cents: string; paused_reason: string | null }>(`select price_cents, paused_reason from app.offers where id = $1`, [offers[ref]]))[0]!;

    const r1 = await syncSupplier(h.svc, supplier);
    expect(r1).toMatchObject({ checked: 3, repriced: 3, missing: 0, failedGroups: 1, complete: false });
    expect(r1.error).toContain("b: bad gateway");
    expect(Number((await price("a:1")).price_cents)).toBe(127);
    expect(await price("b:1")).toMatchObject({ price_cents: "115", paused_reason: null }); // left alone, not "gone"
    expect(await supplierRow(supplier)).toMatchObject({ sync_health: "ok", last_sync_at: null });
    const g = (await db.query<{ failures: number; waiting: boolean }>(`select failures, retry_at > now() as waiting from app.supplier_sync_groups where supplier_id = $1 and group_id = 'b'`, [supplier]))[0]!;
    expect(g).toEqual({ failures: 1, waiting: true });

    // Next run: b is backing off, the pass completes without it.
    asked.length = 0;
    const r2 = await syncSupplier(h.svc, supplier);
    expect(asked).toEqual([]);
    expect(r2).toMatchObject({ checked: 0, complete: true });
    expect((await supplierRow(supplier)).last_sync_at).not.toBeNull();

    // "Sync now" in the admin tries it again; once it answers, its backoff is forgotten.
    brokenB = false;
    await db.query(`update app.suppliers set last_sync_at = null where id = $1`, [supplier]);
    const r3 = await syncSupplier(h.svc, supplier, { retryNow: true });
    expect(asked).toContain("b");
    expect(r3.failedGroups).toBeUndefined();
    expect(Number((await price("b:1")).price_cents)).toBe(127);
    expect((await db.query(`select 1 from app.supplier_sync_groups where supplier_id = $1`, [supplier])).length).toBe(0);
    await db.query(`update app.suppliers set enabled = false where id = $1`, [supplier]);
  });

  it("back a failing supplier off, apart from its balance check's health", async () => {
    const supplier = `relf_${run}`;
    await db.query(`insert into app.suppliers (id, name, enabled, health) values ($1, 'Rel failing', true, 'ok')`, [supplier]);
    await offersFor(supplier, ["x"]);
    let calls = 0;
    let down = true;
    h.suppliers.set(supplier, {
      ...quiet,
      id: supplier,
      listProducts: async () => {
        calls++;
        if (down) throw new Error("connection reset");
        return [{ externalId: "x", name: "x", costCents: 100, available: true, kind: "code" }];
      },
    });
    const mine = async () => (await syncDueSuppliers(h.svc, 50)).filter((r) => r.supplier === supplier);
    expect((await mine())[0]).toMatchObject({ error: "connection reset" });
    expect(await supplierRow(supplier)).toMatchObject({ health: "ok", sync_health: "degraded", sync_error: "connection reset", sync_failures: 1, backing_off: true, leased: false });
    // Backing off: not tried again on the next tick.
    expect(await mine()).toEqual([]);
    expect(calls).toBe(1);

    // The owner hears about the price check, separately from "not answering".
    await db.query(`delete from app.alert_state where key in ($1, $2)`, [`sync:${supplier}`, `supplier:${supplier}`]);
    await watchHealth(h.svc);
    const alerts = await db.query<{ text: string }>(`select data->>'text' as text from app.outbox where template = 'staff_alert' and data->>'text' like $1`, [`%${supplier}%`]);
    expect(alerts.some((a) => a.text.includes("price check is failing"))).toBe(true);
    expect(alerts.some((a) => a.text.includes("is not answering"))).toBe(false);

    // Backoff over and the supplier answers again: all clear.
    down = false;
    await db.query(`update app.suppliers set sync_retry_at = now() - interval '1 second' where id = $1`, [supplier]);
    expect((await mine())[0]).toMatchObject({ checked: 1, complete: true });
    expect(await supplierRow(supplier)).toMatchObject({ sync_health: "ok", sync_error: null, sync_failures: 0, backing_off: false });
    await db.query(`update app.suppliers set enabled = false where id = $1`, [supplier]);
  });

  it("never check the same supplier from two runs at once", async () => {
    const supplier = `rell_${run}`;
    await db.query(`insert into app.suppliers (id, name, enabled) values ($1, 'Rel leased', true)`, [supplier]);
    await offersFor(supplier, ["y"]);
    let calls = 0;
    h.suppliers.set(supplier, {
      ...quiet,
      id: supplier,
      listProducts: async () => {
        calls++;
        // Another run starting meanwhile finds it leased.
        expect((await syncDueSuppliers(h.svc, 50)).some((r) => r.supplier === supplier)).toBe(false);
        return [{ externalId: "y", name: "y", costCents: 100, available: true, kind: "code" }];
      },
    });
    expect((await syncDueSuppliers(h.svc, 50)).some((r) => r.supplier === supplier)).toBe(true);
    expect(calls).toBe(1);
    expect((await supplierRow(supplier)).leased).toBe(false); // released when done
    await db.query(`update app.suppliers set enabled = false where id = $1`, [supplier]);
  });
});

describe("supplier catalogue refresh", () => {
  it("stops once a run saved enough items, whatever the requests left", async () => {
    const supplier = `relc_${run}`;
    await db.query(`insert into app.suppliers (id, name, enabled) values ($1, 'Rel catalogue', true)`, [supplier]);
    let lists = 0;
    h.suppliers.set(supplier, {
      ...quiet,
      id: supplier,
      listGroups: async () => [{ id: "g1", name: "G1" }, { id: "g2", name: "G2" }, { id: "g3", name: "G3" }],
      listProducts: async (group) => {
        lists++;
        return Array.from({ length: 30 }, (_, i): SupplierProduct => ({ externalId: `${group}-${i}`, name: `${group} ${i}`, costCents: 100, available: true, kind: "code" }));
      },
      syncGroup: (id) => id.split("-")[0]!,
    });
    // Other test suppliers have nothing due (or no adapter here); this one has three groups of 30.
    await refreshDueCatalogues(h.svc, { maxGroups: 10, maxItems: 40 });
    expect(lists).toBe(2); // 30, then 60 >= 40: stop
    await db.query(`update app.suppliers set enabled = false where id = $1`, [supplier]);
  });
});

// ─────────────────────────────────────────────────────────────── payments, health, housekeeping

describe("payment re-checks", () => {
  it("check open top-ups every time and closed ones less often the older they get", async () => {
    const c = await customer();
    const add = async (status: string, note: string | null, createdMin: number, updatedMin: number) =>
      (await db.query<{ id: string }>(
        `insert into app.payments (user_id, method, amount_cents, status, note, created_at, updated_at)
         values ($1, 'sam', 500, $2, $3, now() - make_interval(mins => $4), now() - make_interval(mins => $5)) returning id`,
        [c.id, status, note, createdMin, updatedMin],
      ))[0]!.id;
    const open = await add("pending", null, 5, 2);
    const justClosed = await add("expired", "cancelled by the customer", 30, 1); // checked a minute ago: next in ~3 min
    const closedDue = await add("expired", "cancelled by the customer", 30, 10);
    const dayOld = await add("expired", "send window closed", 24 * 60, 60); // every ~2.4 h at that age
    await recheckPendingPayments(h.svc, 1000);
    const touched = async (id: string) => (await db.query<{ t: boolean }>(`select updated_at > now() - interval '5 seconds' as t from app.payments where id = $1`, [id]))[0]!.t;
    expect(await touched(open)).toBe(true);
    expect(await touched(closedDue)).toBe(true);
    expect(await touched(justClosed)).toBe(false);
    expect(await touched(dayOld)).toBe(false);
  });
});

describe("health", () => {
  const job = `rel_job_${run}`;
  afterAll(async () => {
    await db.query(`delete from app.job_heartbeats where name = $1`, [job]);
  });

  it("tells the owner about a job that keeps starting but never finishes", async () => {
    const { heartbeat } = await import("../src/jobs");
    await heartbeat(h.svc, job, async () => {});
    expect((await db.query<{ unfinished: number }>(`select unfinished from app.job_heartbeats where name = $1`, [job]))[0]!.unfinished).toBe(0);
    // Three runs cut off before the end (the Worker stopped them): the counter is never reset.
    await db.query(`update app.job_heartbeats set unfinished = 3 where name = $1`, [job]);
    await watchHealth(h.svc);
    const alerts = await db.query(`select 1 from app.outbox where template = 'staff_alert' and data->>'text' like $1`, [`%"${job}" started 3 times without finishing%`]);
    expect(alerts.length).toBeGreaterThan(0);
  });
});

describe("housekeeping", () => {
  it("deletes old messages in batches, as the Worker's database role", async () => {
    const c = await customer();
    await db.query(
      `insert into app.outbox (user_id, template, status, created_at) select $1, 'rel_old', 'sent', now() - interval '40 days' from generate_series(1, 7)`,
      [c.id],
    );
    await db.query(`insert into app.outbox (user_id, template, status) values ($1, 'rel_new', 'sent')`, [c.id]);
    const out = await runHousekeeping(h.svc, { batch: 3 });
    expect(out.outbox).toBeGreaterThanOrEqual(7);
    const left = await db.query<{ template: string }>(`select template from app.outbox where user_id = $1`, [c.id]);
    expect(left.map((r) => r.template)).toEqual(["rel_new"]);
  });
});
