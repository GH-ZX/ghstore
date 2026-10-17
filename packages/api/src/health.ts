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

  const suppliers = await svc.db.query<{ id: string; last_error: string | null }>(
    `select id, last_error from app.suppliers where enabled and health in ('degraded', 'down')`,
  );
  for (const s of suppliers) {
    await alertOnce(svc, `supplier:${s.id}`, 6, `⚠️ ${s.id} is not answering: ${(s.last_error ?? "").slice(0, 200)}`);
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

  await svc.db.query(`delete from app.error_log where at < now() - interval '7 days'`);
}

/** GET /api/health — `?deep=1`: the database answers and the customer jobs ran lately (for a watchdog). */
export async function health(ctx: Ctx): Promise<Response> {
  if (ctx.url.searchParams.get("deep") !== "1") return json({ ok: true });
  const problems: string[] = [];
  try {
    const rows = await ctx.svc.db.query<{ name: string }>(
      `select name from app.job_heartbeats where name = any($1::text[]) and coalesce(last_ok_at, last_started_at) > now() - interval '10 minutes'`,
      [CUSTOMER_JOBS],
    );
    if (rows.length < CUSTOMER_JOBS.length) problems.push("jobs");
  } catch {
    problems.push("database");
  }
  return json({ ok: problems.length === 0, problems }, { status: problems.length ? 503 : 200, headers: { "cache-control": "no-store" } });
}
