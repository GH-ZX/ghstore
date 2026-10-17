/**
 * runScheduled: which jobs run on which minute (and hour), in what order, and
 * how the request budget's reserve keeps the customers' jobs and the
 * database-only jobs going when suppliers would use it all.
 */
import { afterAll, describe, expect, it } from "vitest";
import type { Services } from "../src/context";
import { runScheduled } from "../src/jobs";
import { connectTestDb, env, Harness, holdOtherSuppliers } from "./helpers";

const conn = await connectTestDb();
const db = conn.db;
const h = new Harness(db);

afterAll(async () => {
  await conn.close();
});

const at = (hour: number, minute: number) => new Date(Date.UTC(2026, 9, 17, hour, minute, 30));

/** Run one tick at that time (and budget); the jobs that started, in the order they started. */
async function tick(when: Date, left?: number): Promise<string[]> {
  const t0 = (await db.query<{ t: string }>(`select clock_timestamp()::text as t`))[0]!.t;
  const svc: Services = { ...h.svc, now: () => when, ...(left === undefined ? {} : { budget: { left: () => left } }) };
  // Earlier runs leave test suppliers switched on: none is due while this runs.
  const release = await holdOtherSuppliers(db, []);
  try {
    await runScheduled(svc, env);
  } finally {
    await release();
  }
  const rows = await db.query<{ name: string }>(
    `select name from app.job_heartbeats where last_started_at >= $1::timestamptz order by last_started_at, name`,
    [t0],
  );
  return rows.map((r) => r.name);
}

const CUSTOMER = ["orders", "outbox"];

describe("runScheduled", () => {
  it("runs the customers' jobs every minute, the rest on their own minutes", async () => {
    // Even minute: payments; nothing else of the hour's jobs on minute 0.
    expect(await tick(at(10, 0))).toEqual([...CUSTOMER, "payments", "supplier_sync"]);
    // Odd minute: USDT deposits instead of payments; 13 is also the health watch and the review asks.
    expect(await tick(at(10, 13))).toEqual([...CUSTOMER, "usdt_deposits", "health_watch", "review_ask", "supplier_sync"]);
    expect(await tick(at(10, 5))).toEqual([...CUSTOMER, "usdt_deposits", "stuck_orders", "supplier_sync"]);
    expect(await tick(at(10, 9))).toEqual([...CUSTOMER, "usdt_deposits", "daily_summary", "supplier_sync"]);
    expect(await tick(at(10, 11))).toEqual([...CUSTOMER, "usdt_deposits", "buy_again", "supplier_sync", "supplier_catalogue"]);
    expect(await tick(at(10, 23))).toEqual([...CUSTOMER, "usdt_deposits", "health_watch", "erase_details", "supplier_sync"]);
    expect(await tick(at(10, 2))).toEqual([...CUSTOMER, "payments", "channel_posts", "supplier_sync"]);
    expect(await tick(at(10, 4))).toEqual([...CUSTOMER, "payments", "supplier_sync", "store_images"]);
    // Minute 7 of each quarter: the supplier balances (always a channel-post minute too).
    expect(await tick(at(10, 7))).toEqual([...CUSTOMER, "usdt_deposits", "channel_posts", "supplier_balances", "supplier_sync"]);
  });

  it("cleans up only at night, and only once a day", async () => {
    // Done less than 20 hours ago: not again.
    await db.query(
      `insert into app.job_heartbeats (name, last_started_at, last_ok_at) values ('housekeeping', now(), now())
       on conflict (name) do update set last_ok_at = now()`,
    );
    expect(await tick(at(0, 6))).not.toContain("housekeeping");
    await db.query(`update app.job_heartbeats set last_ok_at = now() - interval '21 hours' where name = 'housekeeping'`);
    expect(await tick(at(10, 6))).not.toContain("housekeeping"); // not the night
    expect(await tick(at(0, 7))).not.toContain("housekeeping"); // not its minute
    expect(await tick(at(0, 16))).toContain("housekeeping");
  });

  it("keeps the budget's reserve: customers' jobs first, database-only jobs whatever is left", async () => {
    // Nothing left: no outside request at all, but the database-only jobs still run.
    expect(await tick(at(10, 5), 0)).toEqual(["stuck_orders"]);
    expect(await tick(at(10, 13), 0)).toEqual(["health_watch", "review_ask"]);
    // 5 left: orders keep 8 back and messages 6, so neither; payments (even minute, 4 kept) and the price check (2 kept) do.
    expect(await tick(at(10, 0), 5)).toEqual(["payments", "supplier_sync"]);
    // 9 left: messages now (25 at most, 6 kept), orders still not (3 requests each after 8 kept).
    expect(await tick(at(10, 0), 9)).toEqual(["outbox", "payments", "supplier_sync"]);
    expect(await tick(at(10, 0), 11)).toEqual(["orders", "outbox", "payments", "supplier_sync"]);
    // USDT deposits need 8 after their reserve of 4; the catalogue and pictures 10 after 2.
    expect(await tick(at(10, 1), 11)).toEqual(["orders", "outbox", "supplier_sync"]);
    expect(await tick(at(10, 1), 12)).toEqual(["orders", "outbox", "usdt_deposits", "supplier_sync", "supplier_catalogue"]);
    expect(await tick(at(10, 4), 11)).toEqual(["orders", "outbox", "payments", "supplier_sync"]);
    // 4 left is all reserve: payments need one past 4, the price check 3 past 2.
    expect(await tick(at(10, 0), 4)).toEqual([]);
  });
});
