/**
 * Supplier catalogue sync and the margin guard.
 *
 * For every offer linked to a supplier we read the supplier's current cost and
 * availability, then:
 *  - reprice computed offers (percent / fixed markup) automatically,
 *  - pause manual-price offers whose price no longer clears the minimum margin,
 *  - pause offers the supplier stopped selling, and un-pause them when they return.
 * New supplier products are not added automatically: the owner imports them.
 */
import { onCostChange, type PriceRule, type SupplierProduct } from "@store/core";
import type { Services } from "./context";
import { n } from "./db";
import { alertOwners } from "./notify";

/** Pause reasons set by the sync. Other reasons (set by staff) are never cleared here. */
const SYNC_REASONS = new Set(["supplier_unavailable", "cost_above_margin"]);

interface OfferRow {
  id: string;
  supplier_ref: string;
  cost_cents: string | number | null;
  price_cents: string | number;
  markup_mode: PriceRule["mode"];
  markup_value: string | number;
  round_to_cents: number;
  min_margin_pct: string | number;
  paused_reason: string | null;
}

export interface SyncReport {
  supplier: string;
  checked: number;
  repriced: number;
  paused: number;
  resumed: number;
  missing: number;
  /** False when only part of a big catalogue was checked this time (the rest goes next run). */
  complete: boolean;
}

export interface SyncOptions {
  /**
   * For suppliers priced per group (G2Bulk: one request per game), check at
   * most this many groups now, the least recently checked first. Keeps one
   * run inside the Worker's per-invocation request limit.
   */
  maxGroups?: number;
}

export async function syncSupplier(svc: Services, supplierId: string, opts: SyncOptions = {}): Promise<SyncReport> {
  const report: SyncReport = { supplier: supplierId, checked: 0, repriced: 0, paused: 0, resumed: 0, missing: 0, complete: true };
  const adapter = svc.supplier(supplierId);
  if (!adapter) return report;

  // `due`: not checked since the last complete pass (a pass may take several runs).
  // A supplier never synced yet: anything not checked in the last hour is due,
  // whatever an import recorded, while a pass in progress moves on.
  let offers = await svc.db.query<OfferRow & { due: boolean }>(
    `select o.id, o.supplier_ref, o.cost_cents, o.price_cents, o.markup_mode, o.markup_value, o.round_to_cents, o.min_margin_pct, o.paused_reason,
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
    return report;
  }
  const byRef = new Map(products.map((p) => [p.externalId, p]));

  const paused: string[] = [];
  // Packages whose cost and price did not change (nearly all of them on a normal
  // hour). They are marked as checked together in one write after the loop, so a
  // sync costs a few queries instead of one per package (Hyperdrive's free plan
  // counts every query).
  const unchanged: string[] = [];
  for (const o of offers) {
    report.checked++;
    const p = byRef.get(o.supplier_ref);
    const syncPaused = o.paused_reason !== null && SYNC_REASONS.has(o.paused_reason);

    if (!p || !p.available) {
      report.missing++;
      if (o.paused_reason === null) {
        await svc.db.query(`update app.offers set paused_reason = 'supplier_unavailable', cost_checked_at = now() where id = $1`, [o.id]);
        report.paused++;
        paused.push(o.id);
      } else {
        unchanged.push(o.id); // still away: checked, nothing to change
      }
      continue;
    }

    const rule: PriceRule = {
      mode: o.markup_mode,
      value: Number(o.markup_value),
      roundToCents: o.round_to_cents,
      minMarginPct: Number(o.min_margin_pct),
    };
    const price = n(o.price_cents);
    const oldCost = o.cost_cents === null ? null : n(o.cost_cents);
    const decision = onCostChange(price, p.costCents, rule);

    if (decision.action === "pause") {
      if (o.paused_reason !== "cost_above_margin") {
        await svc.db.query(`update app.offers set cost_cents = $2, paused_reason = 'cost_above_margin', cost_checked_at = now() where id = $1`, [o.id, p.costCents]);
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
        `update app.offers set cost_cents = $2, price_cents = $3, cost_checked_at = now(),
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
      }
      if (resume) report.resumed++;
    } else {
      unchanged.push(o.id);
    }
  }

  if (unchanged.length) {
    await svc.db.query(
      `update app.offers set cost_checked_at = now() where id = any(string_to_array($1::text, ',')::uuid[])`,
      [unchanged.join(",")],
    );
  }
  // A partial pass keeps the supplier due, so the next run checks the next groups.
  await svc.db.query(
    `update app.suppliers set last_sync_at = case when $2 then now() else last_sync_at end, health = 'ok', last_error = null where id = $1`,
    [supplierId, report.complete],
  );
  if (paused.length) {
    await alertOwners(svc, `${supplierId}: ${paused.length} package(s) paused (price or availability changed)`);
  }
  return report;
}

/**
 * Sync enabled suppliers whose last sync is older than `minutes`, oldest first,
 * at most `max` per call. One per cron tick keeps each run light (the Workers
 * free plan allows 10 ms of CPU per invocation; a catalogue parse is the heavy part).
 */
export async function syncDueSuppliers(svc: Services, minutes = 60, max = 1, opts: SyncOptions = {}): Promise<SyncReport[]> {
  const due = await svc.db.query<{ id: string }>(
    `select id from app.suppliers where enabled and (last_sync_at is null or last_sync_at < now() - make_interval(mins => $1::int))
      order by last_sync_at nulls first limit $2`,
    [minutes, max],
  );
  const reports: SyncReport[] = [];
  for (const s of due) reports.push(await syncSupplier(svc, s.id, opts));
  return reports;
}
