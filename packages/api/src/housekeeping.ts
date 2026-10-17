/**
 * Nightly housekeeping: rows nobody needs any more are deleted in small
 * batches by app.housekeep() (0031_reliability.sql), so the tables the jobs
 * read every minute stay small:
 *   messages sent or given up on a month ago (a broadcast's: half a year),
 *   sessions that ended a week ago, expired account-link requests,
 *   price changes older than half a year, channel posts sent or skipped
 *   three months ago, alert state older than a month, throttle counters a
 *   day after their window.
 * Money (ledger, payments), orders, order events and the audit log are never touched.
 */
import type { Services } from "./context";
import { n } from "./db";

/** Rows per table per call, and calls per night (the rest goes the next night). */
export const HOUSEKEEP_BATCH = 500;
export const HOUSEKEEP_ROUNDS = 20;

/** Due once a day: not finished in the last 20 hours. */
export async function housekeepingDue(svc: Pick<Services, "db">): Promise<boolean> {
  const rows = await svc.db.query(`select 1 from app.job_heartbeats where name = 'housekeeping' and last_ok_at > now() - interval '20 hours'`);
  return rows.length === 0;
}

/** Delete old rows, a batch at a time. Returns how many went, per table. */
export async function runHousekeeping(svc: Pick<Services, "db">, opts: { batch?: number; rounds?: number } = {}): Promise<Record<string, number>> {
  const batch = opts.batch ?? HOUSEKEEP_BATCH;
  const totals: Record<string, number> = {};
  for (let i = 0; i < (opts.rounds ?? HOUSEKEEP_ROUNDS); i++) {
    const rows = await svc.db.query<{ out: Record<string, unknown> }>(`select app.housekeep($1) as out`, [batch]);
    let deleted = 0;
    for (const [table, count] of Object.entries(rows[0]?.out ?? {})) {
      totals[table] = (totals[table] ?? 0) + n(count);
      deleted += n(count);
    }
    if (deleted === 0) break;
  }
  return totals;
}
