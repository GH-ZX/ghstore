/**
 * Keeping an eye on the store, so the owner hears about trouble before customers
 * do. Unexpected server errors are written to app.error_log; every few minutes
 * watchHealth looks for what needs a person (errors piling up, a supplier not
 * answering, the USDT checker failing, a customer job that stopped finishing)
 * and sends each kind once (app.alert_state), not every minute. Jobs that fail
 * several times in a row already alert from heartbeat() in jobs.ts.
 *
 * GET /api/health?deep=1 is for an outside watchdog (.github/workflows/watchdog.yml):
 * 503 when the database does not answer or the customer jobs stopped, which
 * also covers the case where the scheduled runs stop altogether.
 */
import type { Ctx, Services } from "./context";
import { n, one, type Db } from "./db";
import { json } from "./http";
import { alertOwners } from "./notify";
import { readSettings } from "./settings";

/** Write down an unexpected error; never throws (it runs while answering one). */
export async function logError(db: Db, source: string, message: string): Promise<void> {
  try {
    await db.query(`insert into app.error_log (source, message) values ($1, $2)`, [source.slice(0, 120), message.slice(0, 500)]);
  } catch {
    /* the database may be what failed */
  }
}

/** Send `text` to the owners unless the same kind of alert went out in the last `hours`. */
export async function alertOnce(svc: Services, key: string, hours: number, text: string): Promise<boolean> {
  const rows = await svc.db.query(
    `insert into app.alert_state (key, alerted_at) values ($1, now())
     on conflict (key) do update set alerted_at = now() where app.alert_state.alerted_at < now() - make_interval(hours => $2::int)
     returning key`,
    [key.slice(0, 120), hours],
  );
  if (!rows.length) return false;
  await alertOwners(svc, text);
  return true;
}

/** Errors in the last 15 minutes before the owner hears about them. */
export const ERRORS_TO_ALERT = 5;
/** Customer jobs that should finish every minute or two. */
const CUSTOMER_JOBS = ["orders", "outbox"];
/** Runs started in a row without finishing before the owner hears about it. */
export const UNFINISHED_TO_ALERT = 3;
/** Minutes a receipt or alert may wait to be sent before the watchdog fails. */
export const OUTBOX_LATE_MINUTES = 15;

export async function watchHealth(svc: Services): Promise<void> {
  const errors = await one<{ count: string | number; latest: string | null }>(
    svc.db,
    `select count(*) as count, (array_agg(source || ': ' || message order by at desc))[1] as latest
       from app.error_log where at > now() - interval '15 minutes'`,
  );
  const count = n(errors?.count);
  if (count >= ERRORS_TO_ALERT) {
    await alertOnce(svc, "server_errors", 1, `⚠️ ${count} server errors in the last 15 minutes. Latest: ${(errors?.latest ?? "").slice(0, 200)}`);
  }

  // The balance check (health) and the price check (sync_health) are tracked
  // apart, so one succeeding never hides the other failing.
  const suppliers = await svc.db.query<{ id: string; balance: boolean; last_error: string | null; sync: boolean; sync_error: string | null }>(
    `select id, health in ('degraded', 'down') as balance, last_error, sync_health in ('degraded', 'down') as sync, sync_error
       from app.suppliers where enabled and (health in ('degraded', 'down') or sync_health in ('degraded', 'down'))`,
  );
  for (const s of suppliers) {
    if (s.balance) await alertOnce(svc, `supplier:${s.id}`, 6, `⚠️ ${s.id} is not answering: ${(s.last_error ?? "").slice(0, 200)}`);
    if (s.sync) await alertOnce(svc, `sync:${s.id}`, 6, `⚠️ ${s.id}'s price check is failing (retrying less often): ${(s.sync_error ?? "").slice(0, 200)}`);
  }

  const since = (await readSettings(svc.db, ["bep20.scan_failing_since"]))["bep20.scan_failing_since"];
  if (typeof since === "string" && Date.parse(since) < svc.now().getTime() - 60 * 60_000) {
    await alertOnce(svc, "usdt_scan", 6, "⚠️ The USDT checker can't reach its log server for an hour: USDT top-ups need their hash pasted until it recovers.");
  }

  const stale = await svc.db.query<{ name: string; minutes: string | number }>(
    `select name, floor(extract(epoch from now() - coalesce(last_ok_at, last_started_at)) / 60) as minutes
       from app.job_heartbeats where name = any($1::text[]) and coalesce(last_ok_at, last_started_at) < now() - interval '15 minutes'`,
    [CUSTOMER_JOBS],
  );
  for (const j of stale) {
    await alertOnce(svc, `stale:${j.name}`, 2, `⚠️ Job "${j.name}" hasn't finished for ${n(j.minutes)} minutes.`);
  }
  // Any job that keeps starting but never gets to the end (nor to an error): the run is cut off (too slow, over a limit).
  const cut = await svc.db.query<{ name: string; unfinished: string | number }>(
    `select name, unfinished from app.job_heartbeats where unfinished >= $1`,
    [UNFINISHED_TO_ALERT],
  );
  for (const j of cut) {
    await alertOnce(svc, `unfinished:${j.name}`, 6, `⚠️ Job "${j.name}" started ${n(j.unfinished)} times without finishing: its run is cut off before the end.`);
  }

  // Unusual activity: many top-ups in an hour, or many problem reports in a week, from one customer.
  const busy = await svc.db.query<{ id: string; name: string; count: string | number }>(
    `select u.id, u.display_name as name, count(*) as count from app.payments p join app.users u on u.id = p.user_id
      where p.created_at > now() - interval '1 hour' and u.role = 'customer' group by u.id having count(*) >= 5`,
  );
  for (const u of busy) {
    await alertOnce(svc, `topups:${u.id}`, 24, `👀 ${u.name || "A customer"} started ${n(u.count)} top-ups in the last hour (Admin → Top-ups, Users).`);
  }
  const reports = await svc.db.query<{ id: string; name: string; count: string | number }>(
    `select u.id, u.display_name as name, count(*) as count from app.order_problems r join app.users u on u.id = r.user_id
      where r.created_at > now() - interval '7 days' group by u.id having count(*) >= 3`,
  );
  for (const u of reports) {
    await alertOnce(svc, `problems:${u.id}`, 72, `👀 ${u.name || "A customer"} reported ${n(u.count)} problems this week (Admin → Orders → Problems).`);
  }

  await svc.db.query(`delete from app.error_log where at < now() - interval '7 days'`);
}

/**
 * GET /api/health — `?deep=1`: the database answers, the customer jobs ran
 * lately and no receipt or alert has waited more than 15 minutes (for a watchdog).
 */
export async function health(ctx: Ctx): Promise<Response> {
  if (ctx.url.searchParams.get("deep") !== "1") return json({ ok: true });
  const problems: string[] = [];
  try {
    const rows = await ctx.svc.db.query<{ name: string }>(
      `select name from app.job_heartbeats where name = any($1::text[]) and coalesce(last_ok_at, last_started_at) > now() - interval '10 minutes'`,
      [CUSTOMER_JOBS],
    );
    if (rows.length < CUSTOMER_JOBS.length) problems.push("jobs");
    // Messages due but not sent: the job runs, yet the queue is stuck (broadcasts, priority 1+, may take longer).
    const late = await ctx.svc.db.query(
      `select 1 from app.outbox where status = 'pending' and priority <= 0 and available_at < now() - make_interval(mins => $1) limit 1`,
      [OUTBOX_LATE_MINUTES],
    );
    if (late.length) problems.push("outbox");
  } catch {
    problems.push("database");
  }
  return json({ ok: problems.length === 0, problems }, { status: problems.length ? 503 : 200, headers: { "cache-control": "no-store" } });
}
