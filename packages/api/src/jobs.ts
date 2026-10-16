/**
 * Scheduled work (Cloudflare Cron Trigger, every minute). Each task is small,
 * leases its rows with SKIP LOCKED and records a heartbeat, so overlapping runs
 * are harmless and the admin can see when a job last succeeded.
 */
import type { ApiEnv, Services } from "./context";
import { n } from "./db";
import { fulfilOrder } from "./fulfilment";
import { alertOwners, alertStaff, sendOutbox } from "./notify";
import { queueDailySummary } from "./reports";
import { detectUsdtDeposits, settlePayment } from "./payments";
import { copyLinkedImages } from "./images";
import { refreshDueCatalogues } from "./supplier-catalogue";
import { syncDueSuppliers } from "./sync";

/**
 * How many more outgoing requests this run may make, keeping `reserve` back
 * (Infinity without a budget). One scheduled run shares Cloudflare's limit
 * (50 on the free plan) between all the jobs below.
 */
export function room(svc: Services, reserve = 0): number {
  return svc.budget ? Math.max(0, svc.budget.left() - reserve) : Number.POSITIVE_INFINITY;
}

/** Failed runs in a row before the owner hears about it on Telegram. */
export const JOB_ALERT_AFTER = 3;

export async function heartbeat(svc: Services, name: string, fn: () => Promise<unknown>): Promise<void> {
  await svc.db.query(
    `insert into app.job_heartbeats (name, last_started_at) values ($1, now()) on conflict (name) do update set last_started_at = now()`,
    [name],
  );
  try {
    await fn();
    const ok = await svc.db.query<{ recovered: boolean }>(
      `update app.job_heartbeats h set last_ok_at = now(), last_error = null, failures = 0, alerted_at = null
         from (select alerted_at from app.job_heartbeats where name = $1) p
        where h.name = $1
        returning p.alerted_at is not null as recovered`,
      [name],
    );
    if (ok[0]?.recovered) await alertOwners(svc, `✅ Job "${name}" works again.`);
  } catch (err) {
    const msg = err instanceof Error ? err.message.slice(0, 500) : String(err);
    console.error(`job ${name} failed:`, msg);
    try {
      const failed = await svc.db.query<{ failures: number; alert: boolean }>(
        `update app.job_heartbeats
            set last_error = $2, failures = failures + 1,
                alerted_at = case when failures + 1 >= $3 and alerted_at is null then now() else alerted_at end
          where name = $1
          returning failures, (failures >= $3 and alerted_at = now()) as alert`,
        [name, msg, JOB_ALERT_AFTER],
      );
      const f = failed[0];
      if (f?.alert) await alertOwners(svc, `⚠️ Job "${name}" failed ${f.failures} times in a row: ${msg.slice(0, 300)}`);
    } catch (e) {
      console.error(`job ${name}: could not record the failure:`, e instanceof Error ? e.message : String(e));
    }
  }
}

export async function processDueOrders(svc: Services, env: ApiEnv, limit = 20): Promise<number> {
  const due = await svc.db.query<{ id: string }>(`select id from app.claim_due_orders($1, $2)`, [limit, 120]);
  for (const o of due) {
    try {
      await fulfilOrder(svc, env, o.id);
    } catch (err) {
      console.error("fulfil error", o.id, err instanceof Error ? err.message : String(err));
    }
  }
  return due.length;
}

/** Orders that stay pending too long go to a person: never auto-refunded (the supplier may still deliver). */
export async function flagStuckOrders(svc: Services): Promise<void> {
  const stuck = await svc.db.query<{ id: string; number: string | number }>(
    `update app.orders set next_check_at = null, last_error = coalesce(last_error, 'stuck: needs review')
      where status in ('paid','processing') and next_check_at is not null
        and created_at < now() - make_interval(hours => coalesce((select (value #>> '{}')::int from app.settings where key = 'orders.max_pending_hours'), 24))
     returning id, number`,
  );
  if (stuck.length) await alertStaff(svc, `${stuck.length} order(s) stuck: ${stuck.map((s) => "#" + n(s.number)).join(", ")}`);
}

export async function recheckPendingPayments(svc: Services, limit = 20): Promise<void> {
  const rows = await svc.db.query<{ id: string }>(
    `select id from app.payments
      where created_at > now() - interval '2 days'
        and ((status = 'pending' and method in ('sam','nowpayments') and created_at < now() - interval '1 minute')
          -- a USDT hash submitted before it had enough confirmations: check the chain again
          or (status = 'review' and method = 'bep20' and tx_hash is not null and note is null))
      order by updated_at limit $1`,
    [limit],
  );
  for (const r of rows) {
    if (room(svc) < 3) break;
    await settlePayment(svc, r.id);
    await svc.db.query(`update app.payments set updated_at = now() where id = $1`, [r.id]);
  }
  await svc.db.query(`update app.payments set status = 'expired' where status in ('created','pending') and created_at < now() - interval '2 days'`);
}

export async function checkSupplierBalances(svc: Services): Promise<void> {
  const suppliers = await svc.db.query<{ id: string; low_balance_cents: string | number; balance_cents: string | number | null }>(
    `select id, low_balance_cents, balance_cents from app.suppliers
      where enabled and (balance_checked_at is null or balance_checked_at < now() - interval '15 minutes')`,
  );
  for (const s of suppliers) {
    if (room(svc) < 2) break; // the rest are checked next time
    const adapter = svc.supplier(s.id);
    if (!adapter) continue;
    try {
      const bal = await adapter.getBalance();
      if (!bal) continue;
      const was = s.balance_cents === null ? null : n(s.balance_cents);
      await svc.db.query(`update app.suppliers set balance_cents = $2, balance_checked_at = now(), health = 'ok', last_error = null where id = $1`, [s.id, bal.amountCents]);
      const low = n(s.low_balance_cents);
      if (low > 0 && bal.amountCents < low && (was === null || was >= low)) {
        await alertOwners(svc, `${s.id} balance is low: $${(bal.amountCents / 100).toFixed(2)}`);
      }
    } catch (err) {
      await svc.db.query(`update app.suppliers set health = 'degraded', last_error = $2, balance_checked_at = now() where id = $1`, [
        s.id, err instanceof Error ? err.message.slice(0, 300) : "error",
      ]);
    }
  }
}

/**
 * One cron tick (every minute). Customer-facing work runs every tick; the rest
 * is spread over the hour so a single run stays small enough for the Workers
 * free plan (10 ms CPU per invocation; waiting on the network does not count).
 */
export async function runScheduled(svc: Services, env: ApiEnv): Promise<void> {
  const minute = svc.now().getUTCMinutes();
  // Most urgent first: customers' orders (a few requests each), then their
  // messages, then payments; the supplier sync gets whatever is left.
  const orders = Math.min(10, Math.floor(room(svc, 8) / 3));
  if (orders > 0) await heartbeat(svc, "orders", () => processDueOrders(svc, env, orders));
  const messages = Math.min(25, room(svc, 6));
  if (messages > 0) await heartbeat(svc, "outbox", () => sendOutbox(svc, env, messages));
  if (minute % 2 === 0 && room(svc, 4) > 0) await heartbeat(svc, "payments", () => recheckPendingPayments(svc, 10));
  // USDT top-ups matched by their exact amount, without a pasted hash (only while one is open).
  if (minute % 2 === 1 && room(svc, 4) >= 8) await heartbeat(svc, "usdt_deposits", () => detectUsdtDeposits(svc));
  if (minute % 10 === 5) await heartbeat(svc, "stuck_orders", () => flagStuckOrders(svc));
  if (minute % 15 === 7 && room(svc, 2) > 0) await heartbeat(svc, "supplier_balances", () => checkSupplierBalances(svc));
  // Price and stock checks, every minute for whichever suppliers are due (each has its own interval).
  const groups = room(svc, 2);
  if (groups >= 3) await heartbeat(svc, "supplier_sync", () => syncDueSuppliers(svc, 5, { maxGroups: groups, reserve: 2 }));
  // The saved copy of each supplier's list (Choose packages), a few groups at a time.
  if (minute % 5 === 1 && room(svc, 2) >= 10) await heartbeat(svc, "supplier_catalogue", () => refreshDueCatalogues(svc, { maxGroups: 3 }));
  // Pictures linked from other sites, copied into the store's storage (once the key is set).
  if (minute % 10 === 4 && room(svc, 2) >= 10) await heartbeat(svc, "store_images", () => copyLinkedImages(svc, env, 4));
  if (minute % 30 === 11) await heartbeat(svc, "buy_again", () => queueBuyAgain(svc));
  if (minute % 30 === 23) await heartbeat(svc, "erase_details", () => eraseOldDetails(svc));
  // Checked six times an hour, so one missed tick never skips a day; it is sent once.
  if (minute % 10 === 9) await heartbeat(svc, "daily_summary", () => queueDailySummary(svc));
}

/**
 * The details customers gave after paying (passwords, cookies...) are kept two
 * weeks after the order is closed, for questions about it, then erased.
 */
export async function eraseOldDetails(svc: Services): Promise<number> {
  const rows = await svc.db.query(
    `update app.orders set answers_enc = null
      where answers_enc is not null and status in ('delivered', 'refunded', 'failed')
        and coalesce(delivered_at, updated_at) < now() - interval '14 days'
     returning 1`,
  );
  return rows.length;
}

/** Queue due "buy again" reminders; the outbox sends them on the next ticks. */
export async function queueBuyAgain(svc: Services, limit = 100): Promise<number> {
  const rows = await svc.db.query<{ queued: number }>(`select app.queue_buy_again($1) as queued`, [limit]);
  return n(rows[0]?.queued);
}
