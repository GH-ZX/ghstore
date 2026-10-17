/** Scheduled jobs tell the owner when one keeps failing, once, and again when it recovers. */
import { afterAll, describe, expect, it } from "vitest";
import { room } from "../src/budget";
import { heartbeat, JOB_ALERT_AFTER } from "../src/jobs";
import { connectTestDb, env, Harness } from "./helpers";

const conn = await connectTestDb();
const db = conn.db;
const h = new Harness(db);
const job = `test_job_${Date.now().toString(36)}`;

afterAll(async () => {
  await db.query(`delete from app.job_heartbeats where name = $1`, [job]);
  await conn.close();
});

async function alerts(): Promise<string[]> {
  const rows = await db.query<{ text: string }>(
    `select o.data->>'text' as text from app.outbox o join app.users u on u.id = o.user_id
      where o.template = 'staff_alert' and u.role = 'owner' and o.data->>'text' like $1 order by o.id`,
    [`%"${job}"%`],
  );
  return [...new Set(rows.map((r) => r.text))];
}

describe("request budget", () => {
  it("leaves work for the next run instead of going over the per-invocation limit", async () => {
    const owner = await h.login(900001, "Owner");
    void owner;
    const ownerId = (await db.query<{ user_id: string }>(`select user_id from app.identities where provider = 'telegram' and subject = '900001'`))[0]!.user_id;
    // First in the queue, whatever other test files left pending (alerts fan out to every owner).
    await db.query(`insert into app.outbox (user_id, template, data, priority) values ($1, 'staff_alert', $2::text::jsonb, -1)`, [ownerId, JSON.stringify({ text: `budget ${job}` })]);
    const pending = () => db.query(`select 1 from app.outbox where status = 'pending' and data->>'text' = $1`, [`budget ${job}`]);
    const { runScheduled } = await import("../src/jobs");
    h.telegramCalls = [];
    let left = 3; // nearly spent
    const tight = { ...h.svc, budget: { left: () => left } };
    await runScheduled(tight, env);
    expect(h.telegramCalls).toEqual([]);
    expect((await pending()).length).toBe(1);
    left = 50;
    await runScheduled({ ...h.svc, budget: { left: () => left } }, env);
    expect((await pending()).length).toBe(0);
    expect(room({ ...h.svc, budget: { left: () => 10 } }, 4)).toBe(6);
    expect(room(h.svc)).toBe(Number.POSITIVE_INFINITY);
  });
});

describe("job failure alerts", () => {
  it("alert the owner after repeated failures, only once, and when the job recovers", async () => {
    await h.login(900001, "Owner"); // makes sure an owner exists
    const fail = () => heartbeat(h.svc, job, async () => Promise.reject(new Error("supplier API timed out")));

    for (let i = 1; i < JOB_ALERT_AFTER; i++) await fail();
    expect(await alerts()).toEqual([]);
    await fail();
    expect(await alerts()).toEqual([`⚠️ Job "${job}" failed ${JOB_ALERT_AFTER} times in a row: supplier API timed out`]);
    await fail();
    await fail();
    expect((await alerts()).length).toBe(1);
    const row = (await db.query<{ failures: number; last_error: string }>(`select failures, last_error from app.job_heartbeats where name = $1`, [job]))[0]!;
    expect(row).toMatchObject({ failures: JOB_ALERT_AFTER + 2, last_error: "supplier API timed out" });

    await heartbeat(h.svc, job, async () => undefined);
    expect(await alerts()).toEqual([
      `⚠️ Job "${job}" failed ${JOB_ALERT_AFTER} times in a row: supplier API timed out`,
      `✅ Job "${job}" works again.`,
    ]);
    const reset = (await db.query<{ failures: number; alerted_at: string | null }>(`select failures, alerted_at from app.job_heartbeats where name = $1`, [job]))[0]!;
    expect(reset).toEqual({ failures: 0, alerted_at: null });

    // A single blip after recovering stays quiet.
    await fail();
    await heartbeat(h.svc, job, async () => undefined);
    expect((await alerts()).length).toBe(2);
  });
});
