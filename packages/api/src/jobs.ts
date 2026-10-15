/**
 * Scheduled work (Cloudflare Cron Trigger, every minute). Each task is small,
 * leases its rows with SKIP LOCKED and records a heartbeat, so overlapping runs
 * are harmless and the admin can see when a job last succeeded.
 */
import type { ApiEnv, Services } from "./context";
import { n } from "./db";
import { fulfilOrder } from "./fulfilment";
import { alertOwners, sendOutbox } from "./notify";
import { settlePayment } from "./payments";
import { syncDueSuppliers } from "./sync";

async function heartbeat(svc: Services, name: string, fn: () => Promise<unknown>): Promise<void> {
  await svc.db.query(
    `insert into app.job_heartbeats (name, last_started_at) values ($1, now()) on conflict (name) do update set last_started_at = now()`,
    [name],
  );
  try {
    await fn();
    await svc.db.query(`update app.job_heartbeats set last_ok_at = now(), last_error = null where name = $1`, [name]);
  } catch (err) {
    const msg = err instanceof Error ? err.message.slice(0, 500) : String(err);
    console.error(`job ${name} failed:`, msg);
    await svc.db.query(`update app.job_heartbeats set last_error = $2 where name = $1`, [name, msg]);
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
  if (stuck.length) await alertOwners(svc, `${stuck.length} order(s) stuck: ${stuck.map((s) => "#" + n(s.number)).join(", ")}`);
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
  await heartbeat(svc, "orders", () => processDueOrders(svc, env, 10));
  await heartbeat(svc, "outbox", () => sendOutbox(svc, env));
  if (minute % 2 === 0) await heartbeat(svc, "payments", () => recheckPendingPayments(svc, 10));
  if (minute % 10 === 5) await heartbeat(svc, "stuck_orders", () => flagStuckOrders(svc));
  if (minute % 15 === 7) await heartbeat(svc, "supplier_balances", () => checkSupplierBalances(svc));
  if (minute % 5 === 3) await heartbeat(svc, "supplier_sync", () => syncDueSuppliers(svc, 60, 1));
  if (minute % 30 === 11) await heartbeat(svc, "buy_again", () => queueBuyAgain(svc));
}

/** Queue due "buy again" reminders; the outbox sends them on the next ticks. */
export async function queueBuyAgain(svc: Services, limit = 100): Promise<number> {
  const rows = await svc.db.query<{ queued: number }>(`select app.queue_buy_again($1) as queued`, [limit]);
  return n(rows[0]?.queued);
}
