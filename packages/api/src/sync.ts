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
}

export async function syncSupplier(svc: Services, supplierId: string): Promise<SyncReport> {
  const report: SyncReport = { supplier: supplierId, checked: 0, repriced: 0, paused: 0, resumed: 0, missing: 0 };
  const adapter = svc.supplier(supplierId);
  if (!adapter) return report;

  let products: SupplierProduct[];
  try {
    products = await adapter.listProducts();
  } catch (err) {
    // A failed or partial catalogue must never be read as "everything was removed".
    const msg = err instanceof Error ? err.message.slice(0, 300) : "error";
    await svc.db.query(`update app.suppliers set health = 'degraded', last_error = $2 where id = $1`, [supplierId, msg]);
    return report;
  }
  const byRef = new Map(products.map((p) => [p.externalId, p]));
  const offers = await svc.db.query<OfferRow>(
    `select id, supplier_ref, cost_cents, price_cents, markup_mode, markup_value, round_to_cents, min_margin_pct, paused_reason
       from app.offers where supplier_id = $1 and active`,
    [supplierId],
  );

  const paused: string[] = [];
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
      await svc.db.query(`update app.offers set cost_checked_at = now() where id = $1`, [o.id]);
    }
  }

  await svc.db.query(`update app.suppliers set last_sync_at = now(), health = 'ok', last_error = null where id = $1`, [supplierId]);
  if (paused.length) {
    await alertOwners(svc, `${supplierId}: ${paused.length} package(s) paused (price or availability changed)`);
  }
  return report;
}

/** Sync every enabled supplier whose last sync is older than `minutes`. */
export async function syncDueSuppliers(svc: Services, minutes = 60): Promise<SyncReport[]> {
  const due = await svc.db.query<{ id: string }>(
    `select id from app.suppliers where enabled and (last_sync_at is null or last_sync_at < now() - make_interval(mins => $1::int))`,
    [minutes],
  );
  const reports: SyncReport[] = [];
  for (const s of due) reports.push(await syncSupplier(svc, s.id));
  return reports;
}
