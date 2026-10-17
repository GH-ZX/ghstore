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
import { CLOSED_NOTES, detectUsdtDeposits, MISMATCH_NOTE, NEVER_CONFIRMED_NOTE, settlePayment, TOPUP_CLOSE_AFTER, USDT_CLOSE_AFTER } from "./payments";
import { copyLinkedImages } from "./images";
import { watchHealth } from "./health";
import { queueChannelPosts, sendChannelPosts } from "./channel";
import { refreshDueCatalogues } from "./supplier-catalogue";
import { syncDueSuppliers } from "./sync";
import { housekeepingDue, runHousekeeping } from "./housekeeping";

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
    // unfinished: runs started since the job last finished (a run cut off never gets to reset it; health.ts watches it).
    `insert into app.job_heartbeats (name, last_started_at, unfinished) values ($1, now(), 1)
     on conflict (name) do update set last_started_at = now(), unfinished = app.job_heartbeats.unfinished + 1`,
    [name],
  );
  try {
    await fn();
    const ok = await svc.db.query<{ recovered: boolean }>(
      `update app.job_heartbeats h set last_ok_at = now(), last_error = null, failures = 0, alerted_at = null, unfinished = 0
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
            set last_error = $2, failures = failures + 1, unfinished = 0,
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

/**
 * Orders due for a supplier check. Each one is leased by fulfilOrder itself,
 * right before its own supplier call (so no lease runs out while earlier ones
 * are handled); one another run or request holds is skipped.
 */
export async function processDueOrders(svc: Services, env: ApiEnv, limit = 20): Promise<number> {
  const due = await svc.db.query<{ id: string }>(
    `select id from app.orders
      where status in ('paid', 'processing') and hold is null and next_check_at <= now()
        and (lease_until is null or lease_until <= now())
      order by next_check_at limit $1`,
    [Math.max(1, Math.min(limit, 100))],
  );
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
  // Customers waiting right now first (open top-ups, USDT hashes waiting for
  // confirmations). Closed ones are checked less often the older they get (a
  // tenth of their age: every few minutes at first, every few hours the next
  // day), so abandoned top-ups never hold up live ones.
  const rows = await svc.db.query<{ id: string }>(
    `select id from app.payments
      where created_at > now() - interval '2 days'
        and ((status = 'pending' and method in ('sam','nowpayments') and created_at < now() - interval '1 minute')
          -- closed by the store (cancelled, window ran out): a late payment is still credited
          or (status = 'expired' and method in ('sam','nowpayments') and note = any($2::text[])
              and updated_at < now() - least(interval '3 hours', greatest(interval '2 minutes', (now() - created_at) / 10)))
          -- a USDT hash submitted before it had enough confirmations: check the chain again
          or (status = 'review' and method = 'bep20' and tx_hash is not null and note is null))
      order by (status = 'expired'), updated_at limit $1`,
    [limit, CLOSED_NOTES],
  );
  for (const r of rows) {
    if (room(svc) < 3) break;
    await settlePayment(svc, r.id);
    await svc.db.query(`update app.payments set updated_at = now() where id = $1`, [r.id]);
  }
  await svc.db.query(`update app.payments set status = 'expired' where status in ('created','pending') and created_at < now() - interval '2 days'`);
  await svc.db.query(
    `update app.payments set status = 'expired', note = $3
      where status in ('created','pending')
        and ((method = 'bep20' and tx_hash is null and created_at < now() - $1::interval)
          or (method <> 'bep20' and created_at < now() - $2::interval))`,
    [USDT_CLOSE_AFTER, TOPUP_CLOSE_AFTER, CLOSED_NOTES[1]],
  );
  // Manual USDT under review that can no longer settle closes too, freeing its exact
  // amount for other requests: a pasted hash that did not match (sent too late or too
  // early, another transfer) once the request's time is over, or a hash never
  // confirmed on chain within hours. Partial or odd amounts stay for staff.
  await svc.db.query(
    `update app.payments set status = 'expired', note = coalesce(note, $3)
      where method = 'bep20' and status = 'review'
        and ((note = $1 and created_at < now() - $2::interval)
          or (note is null and tx_hash is not null and created_at < now() - $4::interval))`,
    [MISMATCH_NOTE, USDT_CLOSE_AFTER, NEVER_CONFIRMED_NOTE, USDT_UNCONFIRMED_AFTER],
  );
}

/** A pasted USDT hash still not confirmed after this long is given up (its transfer never made it). */
export const USDT_UNCONFIRMED_AFTER = "6 hours";

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
 * Order: customers' orders, messages and payments; then the cheap jobs that
 * only talk to the database; the supplier price checks and catalogue reads
 * (the most requests and CPU) last, with whatever the run has left.
 */
export async function runScheduled(svc: Services, env: ApiEnv): Promise<void> {
  const now = svc.now();
  const minute = now.getUTCMinutes();
  // Most urgent first: customers' orders (a few requests each), then their messages, then payments.
  const orders = Math.min(10, Math.floor(room(svc, 8) / 3));
  if (orders > 0) await heartbeat(svc, "orders", () => processDueOrders(svc, env, orders));
  const messages = Math.min(25, room(svc, 6));
  if (messages > 0) await heartbeat(svc, "outbox", () => sendOutbox(svc, env, messages, 6));
  if (minute % 2 === 0 && room(svc, 4) > 0) await heartbeat(svc, "payments", () => recheckPendingPayments(svc, 10));
  // USDT top-ups matched by their exact amount, without a pasted hash (only while one is open).
  if (minute % 2 === 1 && room(svc, 4) >= 8) await heartbeat(svc, "usdt_deposits", () => detectUsdtDeposits(svc));

  // Database only: cheap, and never starved by the supplier jobs below.
  if (minute % 10 === 5) await heartbeat(svc, "stuck_orders", () => flagStuckOrders(svc));
  // Errors piling up, a supplier not answering, a customer job stuck: the owner hears once.
  if (minute % 5 === 3) await heartbeat(svc, "health_watch", () => watchHealth(svc));
  // "How was it?": a review request some hours after delivery (Admin → Settings).
  if (minute % 15 === 13) await heartbeat(svc, "review_ask", () => queueReviewAsks(svc));
  if (minute % 30 === 11) await heartbeat(svc, "buy_again", () => queueBuyAgain(svc));
  if (minute % 30 === 23) await heartbeat(svc, "erase_details", () => eraseOldDetails(svc));
  // Checked six times an hour, so one missed tick never skips a day; it is sent once.
  if (minute % 10 === 9) await heartbeat(svc, "daily_summary", () => queueDailySummary(svc));
  // Old rows deleted once a night (00:00-00:59 UTC, before the 01:30 backup); a missed tick tries again 10 minutes later.
  if (now.getUTCHours() === 0 && minute % 10 === 6 && (await housekeepingDue(svc))) await heartbeat(svc, "housekeeping", () => runHousekeeping(svc));

  // The store's channel: new products and price drops queued, one post sent at a time (a few a day).
  if (minute % 5 === 2 && room(svc, 4) > 0) {
    await heartbeat(svc, "channel_posts", async () => {
      await queueChannelPosts(svc.db);
      await sendChannelPosts(svc, env);
    });
  }
  if (minute % 15 === 7 && room(svc, 2) > 0) await heartbeat(svc, "supplier_balances", () => checkSupplierBalances(svc));
  // Price and stock checks, every minute for whichever suppliers are due (each has its own interval).
  const groups = room(svc, 2);
  if (groups >= 3) await heartbeat(svc, "supplier_sync", () => syncDueSuppliers(svc, 5, { maxGroups: groups, reserve: 2 }));
  // The saved copy of each supplier's list (Choose packages), a few groups at a time.
  if (minute % 5 === 1 && room(svc, 2) >= 10) await heartbeat(svc, "supplier_catalogue", () => refreshDueCatalogues(svc, { maxGroups: 3 }));
  // Pictures linked from other sites, copied into the store's storage (once the key is set).
  if (minute % 10 === 4 && room(svc, 2) >= 10) await heartbeat(svc, "store_images", () => copyLinkedImages(svc, env, 4));
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

/**
 * Ask customers to rate what they received, `reviews.ask_hours` after delivery
 * (default 3; 0 = never): once per customer and product, only for orders of the
 * last week, not for virtual numbers, and not when they already reviewed it.
 */
export async function queueReviewAsks(svc: Services, limit = 50): Promise<number> {
  const v = (await svc.db.query<{ value: unknown }>(`select value from app.settings where key = 'reviews.ask_hours'`))[0]?.value;
  const hours = typeof v === "number" ? v : 3;
  if (hours <= 0) return 0;
  const due = await svc.db.query<{ id: string; user_id: string; number: string | number; slug: string; name_ar: string; name_en: string }>(
    `select distinct on (o.user_id, o.product_id) o.id, o.user_id, o.number, p.slug, p.name_ar, p.name_en
       from app.orders o join app.products p on p.id = o.product_id join app.users u on u.id = o.user_id
      where o.status = 'delivered' and o.review_asked_at is null and p.kind <> 'sms' and p.active and u.notify
        and o.delivered_at < now() - make_interval(hours => $1::int) and o.delivered_at > now() - interval '7 days'
        and not exists (select 1 from app.reviews r where r.product_id = o.product_id and r.user_id = o.user_id)
        and not exists (select 1 from app.orders x where x.user_id = o.user_id and x.product_id = o.product_id and x.review_asked_at is not null)
      order by o.user_id, o.product_id, o.delivered_at desc
      limit $2`,
    [hours, limit],
  );
  let queued = 0;
  for (const d of due) {
    const marked = await svc.db.query(`update app.orders set review_asked_at = now() where id = $1 and review_asked_at is null returning id`, [d.id]);
    if (!marked.length) continue;
    await svc.db.query(`insert into app.outbox (user_id, template, data, priority) values ($1, 'review_ask', $2::text::jsonb, 5)`, [
      d.user_id, JSON.stringify({ order_id: d.id, number: n(d.number), slug: d.slug, name_ar: d.name_ar, name_en: d.name_en }),
    ]);
    queued++;
  }
  return queued;
}

/** Queue due "buy again" reminders; the outbox sends them on the next ticks. */
export async function queueBuyAgain(svc: Services, limit = 100): Promise<number> {
  const rows = await svc.db.query<{ queued: number }>(`select app.queue_buy_again($1) as queued`, [limit]);
  return n(rows[0]?.queued);
}
