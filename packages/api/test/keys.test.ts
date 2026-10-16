/** Admin → Settings → Keys: payment and supplier keys stored encrypted in the database. */
import { afterAll, describe, expect, it } from "vitest";
import { clearStoreKeysCache, loadStoreKeys } from "../src/keys";
import { connectTestDb, env, Harness } from "./helpers";

const conn = await connectTestDb();
const db = conn.db;
const h = new Harness(db);
const tg = (k: number) => 730_000_000 + (Date.now() % 100_000_000) + k;
const ADDRESS = "0x1111111111111111111111111111111111112222";

afterAll(async () => {
  await db.query(`delete from app.store_keys`);
  clearStoreKeysCache();
  await conn.close();
});

async function ownerToken(): Promise<string> {
  await db.query(`delete from app.identities where provider = 'telegram' and subject = '900001'`);
  return h.login(900001, "Owner");
}

describe("store keys", () => {
  it("are for the owner only", async () => {
    const customer = await h.login(tg(1));
    expect((await h.call("GET", "/api/admin/keys", { token: customer })).status).toBe(403);
    expect((await h.call("PUT", "/api/admin/keys/BEP20_ADDRESS", { token: customer, body: { value: ADDRESS } })).status).toBe(403);
  });

  it("are stored encrypted, shown only by their last characters, and switch a payment method on", async () => {
    const owner = await ownerToken();
    const saved = env.BEP20_ADDRESS;
    delete env.BEP20_ADDRESS;
    try {
      const before = await h.call("GET", "/api/admin/keys", { token: owner });
      const row = (name: string, keys = before.data.keys) => keys.find((k: { name: string }) => k.name === name);
      expect(before.data.keys).toHaveLength(11);
      expect(row("BEP20_ADDRESS")).toMatchObject({ source: null, hint: null });
      expect(row("SAM_API_KEY").source).toBe("worker"); // set as a Worker secret in the test settings
      expect((await h.call("GET", "/api/topups/methods")).data.methods).not.toContain("bep20");

      expect((await h.call("PUT", "/api/admin/keys/BEP20_ADDRESS", { token: owner, body: { value: "not-an-address" } })).status).toBe(400);
      expect((await h.call("PUT", "/api/admin/keys/TELEGRAM_BOT_TOKEN", { token: owner, body: { value: "123:abc-abc-abc" } })).status).toBe(404);

      const set = await h.call("PUT", "/api/admin/keys/BEP20_ADDRESS", { token: owner, body: { value: ` ${ADDRESS} ` } });
      expect(set.status).toBe(200);
      expect(row("BEP20_ADDRESS", set.data.keys)).toMatchObject({ source: "admin", hint: "2222" });
      expect(JSON.stringify(set.data)).not.toContain(ADDRESS);

      const stored = await db.query<{ value_enc: string }>(`select value_enc from app.store_keys where name = 'BEP20_ADDRESS'`);
      expect(stored[0]!.value_enc.startsWith("v1.")).toBe(true);
      expect(stored[0]!.value_enc).not.toContain(ADDRESS);
      expect((await loadStoreKeys(db, env.DATA_KEY)).BEP20_ADDRESS).toBe(ADDRESS);
      expect((await h.call("GET", "/api/topups/methods")).data.methods).toContain("bep20");

      const audit = await db.query<{ data: unknown }>(`select data from app.audit_log where action = 'key.set' and target_id = 'BEP20_ADDRESS'`);
      expect(audit.length).toBeGreaterThan(0);
      expect(JSON.stringify(audit)).not.toContain(ADDRESS);

      const removed = await h.call("PUT", "/api/admin/keys/BEP20_ADDRESS", { token: owner, body: { value: null } });
      expect(row("BEP20_ADDRESS", removed.data.keys).source).toBeNull();
      expect((await h.call("GET", "/api/topups/methods")).data.methods).not.toContain("bep20");
    } finally {
      env.BEP20_ADDRESS = saved;
    }
  });

  it("ignore a value moved to another key's row or sealed with another DATA_KEY", async () => {
    const owner = await ownerToken();
    await h.call("PUT", "/api/admin/keys/G2BULK_API_KEY", { token: owner, body: { value: "g2bulk-secret-key-1234" } });
    // Someone with database access copies G2Bulk's sealed value into BatStore's row.
    await db.query(
      `insert into app.store_keys (name, value_enc, hint) select 'BATSTORE_API_KEY', value_enc, hint from app.store_keys where name = 'G2BULK_API_KEY'`,
    );
    clearStoreKeysCache();
    const keys = await loadStoreKeys(db, env.DATA_KEY);
    expect(keys.G2BULK_API_KEY).toBe("g2bulk-secret-key-1234");
    expect(keys.BATSTORE_API_KEY).toBeUndefined();

    clearStoreKeysCache();
    const otherKey = btoa(String.fromCharCode(...new Uint8Array(32).fill(9)));
    expect(await loadStoreKeys(db, otherKey)).toEqual({});
    clearStoreKeysCache();
  });
});
