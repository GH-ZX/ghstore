/**
 * Supplier price checks (the "sync") and the margin guard.
 *
 * For every package linked to a supplier we read the supplier's current cost and
 * availability, then, following the supplier's settings (Admin → Suppliers):
 *  - reprice markup-priced packages automatically (auto_reprice), or keep their
 *    price while it still clears the minimum margin,
 *  - pause a package whose cost jumped by more than max_jump_pct, for the owner
 *    to review (the new cost waits in pending_cost_cents),
 *  - pause manual-price packages whose price no longer clears the minimum margin,
 *  - pause packages the supplier stopped selling or has none of in stock, and
 *    resume them when they return (they disappear from the store meanwhile).
 * New supplier products are not added automatically: the owner chooses them
 * (Admin → Suppliers → Choose packages, selection.ts).
 * Every check leaves a short report on the supplier for the admin to read.
 * Owners get a Telegram alert for price jumps and lost margins; stock coming
 * and going alerts only for suppliers with stock_alerts on (some suppliers run
 * out and restock all day).
 */
import { onCostChange, type PriceRule, type SupplierProduct } from "@store/core";
import type { Services } from "./context";
import { n, one } from "./db";
import { notifyBackInStock } from "./favorites";
import { alertOwners } from "./notify";
import { noteSupplierPrices } from "./supplier-catalogue";

/** Pause reasons set by the sync. Other reasons (set by staff) are never cleared here. */
export const SYNC_REASONS = new Set(["supplier_unavailable", "cost_above_margin", "cost_jump"]);

interface OfferRow {
  id: string;
  supplier_ref: string;
  cost_cents: string | number | null;
  pending_cost_cents: string | number | null;
  price_cents: string | number;
  markup_mode: PriceRule["mode"];
  markup_value: string | number;
  round_to_cents: number;
  min_margin_pct: string | number;
  paused_reason: string | null;
  due: boolean;
}

interface SupplierSettings {
  auto_reprice: boolean;
  max_jump_pct: number | null;
  stock_alerts: boolean;
}

export interface SyncReport {
  supplier: string;
  checked: number;
  repriced: number;
  paused: number;
  resumed: number;
  missing: number;
  /** Packages paused because their cost jumped: waiting for the owner. */
  review: number;
  /** False when only part of a big catalogue was checked this time (the rest goes next run). */
  complete: boolean;
  /** Why the check could not run (the supplier's own error, without secrets), or the first package that failed. */
  error?: string;
  /** Packages that could not be checked this time (skipped; the rest went on). */
  failed?: number;
}

export interface SyncOptions {
  /**
   * For suppliers priced per group (G2Bulk: one request per game), check at
   * most this many groups now, the least recently checked first. Keeps one
   * run inside the Worker's per-invocation request limit.
   */
  maxGroups?: number;
}

/** Did the cost move by more than the supplier's limit? */
export function costJumped(oldCost: number | null, newCost: number, maxJumpPct: number | null): boolean {
  if (maxJumpPct === null || oldCost === null || oldCost <= 0) return false;
  return (Math.abs(newCost - oldCost) * 100) / oldCost > maxJumpPct;
}

async function saveReport(svc: Services, supplierId: string, report: SyncReport): Promise<void> {
  const { supplier: _s, ...rest } = report;
  await svc.db.query(`update app.suppliers set last_sync_report = $2::text::jsonb where id = $1`, [
    supplierId,
    JSON.stringify({ ...rest, at: svc.now().toISOString() }),
  ]);
}

export async function syncSupplier(svc: Services, supplierId: string, opts: SyncOptions = {}): Promise<SyncReport> {
  const resumedIds: string[] = [];
  const report: SyncReport = { supplier: supplierId, checked: 0, repriced: 0, paused: 0, resumed: 0, missing: 0, review: 0, complete: true };
  const adapter = svc.supplier(supplierId);
  if (!adapter) return report;
  const settings = (await one<SupplierSettings>(svc.db, `select auto_reprice, max_jump_pct, stock_alerts from app.suppliers where id = $1`, [supplierId])) ?? {
    auto_reprice: true,
    max_jump_pct: null,
    stock_alerts: false,
  };

  // `due`: not checked since the last complete pass (a pass may take several runs).
  // A supplier never synced yet: anything not checked in the last hour is due,
  // whatever an import recorded, while a pass in progress moves on.
  let offers = await svc.db.query<OfferRow>(
    `select o.id, o.supplier_ref, o.cost_cents, o.pending_cost_cents, o.price_cents, o.markup_mode, o.markup_value,
            o.round_to_cents, o.min_margin_pct, o.paused_reason,
            (o.cost_checked_at is null or o.cost_checked_at <= coalesce(s.last_sync_at, now() - interval '1 hour')) as due
       from app.offers o join app.suppliers s on s.id = o.supplier_id
      where o.supplier_id = $1 and o.active
      order by o.cost_checked_at nulls first, o.id`,
    [supplierId],
  );
  // Big catalogues: price only what the store sells, a few groups at a time,
  // the groups not checked yet in this pass first.
  const grouped = adapter.listProductsFor && adapter.syncGroup ? adapter : null;
  if (grouped) {
    const max = Math.max(1, Math.floor(opts.maxGroups ?? Number.POSITIVE_INFINITY));
    const dueGroups: string[] = [];
    for (const o of offers) {
      const g = grouped.syncGroup!(o.supplier_ref);
      if (o.due && !dueGroups.includes(g)) dueGroups.push(g);
    }
    const chosen = new Set(dueGroups.slice(0, max));
    report.complete = dueGroups.length <= max;
    offers = offers.filter((o) => chosen.has(grouped.syncGroup!(o.supplier_ref)));
  }
  if (offers.length === 0) {
    await svc.db.query(`update app.suppliers set last_sync_at = now(), health = 'ok', last_error = null where id = $1`, [supplierId]);
    await saveReport(svc, supplierId, report);
    return report;
  }

  let products: SupplierProduct[];
  try {
    products = grouped ? await grouped.listProductsFor!(offers.map((o) => o.supplier_ref)) : await adapter.listProducts();
  } catch (err) {
    // A failed or partial catalogue must never be read as "everything was removed".
    const msg = err instanceof Error ? err.message.slice(0, 300) : "error";
    await svc.db.query(`update app.suppliers set health = 'degraded', last_error = $2 where id = $1`, [supplierId, msg]);
    report.complete = false;
    report.error = msg;
    await saveReport(svc, supplierId, report);
    return report;
  }
  const byRef = new Map(products.map((p) => [p.externalId, p]));
  // Keep Admin → Choose packages' copy of the supplier's list in step (no extra request).
  try {
    await noteSupplierPrices(svc, supplierId, products);
  } catch (err) {
    console.error(`sync ${supplierId}: could not update the saved list:`, err instanceof Error ? err.message : String(err));
  }

  const paused: string[] = [];
  /** Paused only for stock (no alert unless the supplier's stock alerts are on). */
  let stockPaused = 0;
  // Packages whose cost and price did not change (nearly all of them on a normal
  // hour). They are marked as checked together in one write after the loop, so a
  // sync costs a few queries instead of one per package (Hyperdrive's free plan
  // counts every query).
  const unchanged: string[] = [];
  for (const o of offers) {
    report.checked++;
    // One package that can't be saved (an odd price from the supplier...) is skipped
    // and reported; it never stops the check of the others.
    try {
      const p = byRef.get(o.supplier_ref);
      const syncPaused = o.paused_reason !== null && SYNC_REASONS.has(o.paused_reason);

      if (!p || !p.available) {
        report.missing++;
        if (o.paused_reason === null) {
          await svc.db.query(`update app.offers set paused_reason = 'supplier_unavailable', cost_checked_at = now() where id = $1`, [o.id]);
          report.paused++;
          paused.push(o.id);
          stockPaused++;
        } else {
          unchanged.push(o.id); // still away: checked, nothing to change
        }
        continue;
      }

      const price = n(o.price_cents);
      const oldCost = o.cost_cents === null ? null : n(o.cost_cents);

      // A big jump waits for the owner instead of repricing the store by itself.
      if (costJumped(oldCost, p.costCents, settings.max_jump_pct)) {
        if (o.paused_reason !== null && !syncPaused) {
          unchanged.push(o.id); // paused by staff: leave it alone
          continue;
        }
        report.review++;
        const pending = o.pending_cost_cents === null ? null : n(o.pending_cost_cents);
        if (o.paused_reason === "cost_jump" && pending === p.costCents) {
          unchanged.push(o.id);
          continue;
        }
        await svc.db.query(
          `update app.offers set paused_reason = 'cost_jump', pending_cost_cents = $2, cost_checked_at = now() where id = $1`,
          [o.id, p.costCents],
        );
        if (o.paused_reason !== "cost_jump") {
          await svc.db.query(
            `insert into app.price_changes (offer_id, old_cost_cents, new_cost_cents, old_price_cents, new_price_cents, action) values ($1, $2, $3, $4, $4, 'paused')`,
            [o.id, oldCost, p.costCents, price],
          );
          report.paused++;
          paused.push(o.id);
        }
        continue;
      }

      const rule: PriceRule = {
        mode: settings.auto_reprice ? o.markup_mode : "manual",
        value: Number(o.markup_value),
        roundToCents: o.round_to_cents,
        minMarginPct: Number(o.min_margin_pct),
      };
      const decision = onCostChange(price, p.costCents, rule);

      if (decision.action === "pause") {
        if (o.paused_reason !== "cost_above_margin") {
          await svc.db.query(
            `update app.offers set cost_cents = $2, pending_cost_cents = null, paused_reason = 'cost_above_margin', cost_checked_at = now() where id = $1`,
            [o.id, p.costCents],
          );
          await svc.db.query(
            `insert into app.price_changes (offer_id, old_cost_cents, new_cost_cents, old_price_cents, new_price_cents, action) values ($1, $2, $3, $4, $4, 'paused')`,
            [o.id, oldCost, p.costCents, price],
          );
          report.paused++;
          paused.push(o.id);
        } else {
          unchanged.push(o.id);
        }
        continue;
      }

      const newPrice = decision.price;
      const resume = syncPaused;
      if (newPrice !== price || oldCost !== p.costCents || resume) {
        await svc.db.query(
          `update app.offers set cost_cents = $2, price_cents = $3, pending_cost_cents = null, cost_checked_at = now(),
                  paused_reason = case when paused_reason = any(string_to_array($4::text, ',')) then null else paused_reason end
            where id = $1`,
          [o.id, p.costCents, newPrice, [...SYNC_REASONS].join(",")],
        );
        if (newPrice !== price) {
          await svc.db.query(
            `insert into app.price_changes (offer_id, old_cost_cents, new_cost_cents, old_price_cents, new_price_cents, action) values ($1, $2, $3, $4, $5, 'repriced')`,
            [o.id, oldCost, p.costCents, price, newPrice],
          );
          report.repriced++;
        } else if (oldCost !== p.costCents && oldCost !== null) {
          // Automatic repricing is off: the cost moved, the price stayed.
          await svc.db.query(
            `insert into app.price_changes (offer_id, old_cost_cents, new_cost_cents, old_price_cents, new_price_cents, action) values ($1, $2, $3, $4, $4, 'kept')`,
            [o.id, oldCost, p.costCents, price],
          );
        }
        if (resume) {
          report.resumed++;
          resumedIds.push(o.id);
        }
      } else {
        unchanged.push(o.id);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message.slice(0, 200) : "error";
      report.failed = (report.failed ?? 0) + 1;
      report.error ??= `package ${o.id}: ${msg}`;
      console.error(`sync ${supplierId}: package ${o.id} skipped:`, msg);
    }
  }

  if (unchanged.length) {
    await svc.db.query(
      `update app.offers set cost_checked_at = now() where id = any(string_to_array($1::text, ',')::uuid[])`,
      [unchanged.join(",")],
    );
  }
  // Success rates follow the supplier (5SIM publishes one per country); one write, only for suppliers that publish them.
  const rates = products.filter((p) => p.successPct !== undefined).map((p) => ({ ref: p.externalId, pct: p.successPct ?? null }));
  if (rates.length) {
    await svc.db.query(
      `update app.offers o set success_pct = x.pct
         from jsonb_to_recordset($2::text::jsonb) as x(ref text, pct numeric)
        where o.supplier_id = $1 and o.supplier_ref = x.ref and o.success_pct is distinct from x.pct`,
      [supplierId, JSON.stringify(rates)],
    );
  }
  // A partial pass keeps the supplier due, so the next run checks the next groups.
  await svc.db.query(
    `update app.suppliers set last_sync_at = case when $2 then now() else last_sync_at end, health = 'ok', last_error = null where id = $1`,
    [supplierId, report.complete],
  );
  await saveReport(svc, supplierId, report);
  // Back on sale: one Telegram message to each customer who asked to be told.
  await notifyBackInStock(svc, resumedIds);
  const alerting = settings.stock_alerts ? paused.length : paused.length - stockPaused;
  if (alerting > 0) {
    const review = report.review ? ` ${report.review} need your review: their cost jumped.` : "";
    await alertOwners(svc, `${supplierId}: ${alerting} package(s) paused (price or availability changed).${review}`);
  }
  return report;
}

/**
 * Sync enabled suppliers whose last check is older than their own interval
 * (Admin → Suppliers → Checks), oldest first, at most `max` per call, and only
 * while the run has requests left (`reserve` kept back; the Workers free plan
 * allows 50 outgoing requests and 10 ms of CPU per invocation). The rest are
 * due again on the next tick.
 */
export async function syncDueSuppliers(svc: Services, max = 1, opts: SyncOptions & { reserve?: number } = {}): Promise<SyncReport[]> {
  const due = await svc.db.query<{ id: string }>(
    `select id from app.suppliers
      where enabled and (last_sync_at is null or last_sync_at < now() - make_interval(mins => sync_minutes))
      order by last_sync_at nulls first limit $1`,
    [max],
  );
  const reports: SyncReport[] = [];
  const left = () => (svc.budget ? svc.budget.left() - (opts.reserve ?? 0) : Number.POSITIVE_INFINITY);
  for (const s of due) {
    // Each supplier needs a few requests; a big catalogue checks only as many groups as fit.
    if (reports.length > 0 && left() < 4) break;
    reports.push(await syncSupplier(svc, s.id, { ...opts, maxGroups: Math.max(1, Math.min(opts.maxGroups ?? Number.POSITIVE_INFINITY, left() - 1)) }));
  }
  return reports;
}
