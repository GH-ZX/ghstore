/**
 * Selling prices and the margin guard.
 *
 * Every offer (package) has a supplier cost and a pricing rule. When a supplier
 * changes its cost, `onCostChange` decides whether to keep the price, reprice,
 * or pause the offer so the store never sells at a loss.
 */
import type { Cents } from "./money";

export type MarkupMode = "percent" | "fixed" | "manual";

export interface PriceRule {
  mode: MarkupMode;
  /** percent: 15 means +15%. fixed: cents added to cost. manual: ignored. */
  value: number;
  /** Round the final price UP to a multiple of this many cents (1 = no rounding). */
  roundToCents?: number;
  /** Minimum margin over cost, in percent, that the guard enforces. */
  minMarginPct: number;
}

export function priceFromCost(cost: Cents, rule: PriceRule): Cents {
  if (!Number.isSafeInteger(cost) || cost < 0) throw new RangeError("cost must be non-negative integer cents");
  let price: number;
  switch (rule.mode) {
    case "percent":
      price = Math.ceil(cost * (1 + rule.value / 100));
      break;
    case "fixed":
      price = cost + Math.round(rule.value);
      break;
    case "manual":
      throw new Error("manual prices are set by hand, not computed");
  }
  const step = Math.max(1, Math.floor(rule.roundToCents ?? 1));
  price = Math.ceil(price / step) * step;
  return Math.max(price, minimumPrice(cost, rule.minMarginPct));
}

/** The lowest price that still keeps the minimum margin. */
export function minimumPrice(cost: Cents, minMarginPct: number): Cents {
  return Math.ceil(cost * (1 + Math.max(0, minMarginPct) / 100));
}

export function marginPct(price: Cents, cost: Cents): number {
  if (cost <= 0) return Infinity;
  return ((price - cost) / cost) * 100;
}

export type CostDecision =
  | { action: "keep"; price: Cents }
  | { action: "reprice"; price: Cents }
  | { action: "pause"; reason: string };

/**
 * Decide what to do when the supplier's cost changes.
 * - Computed rules reprice automatically (up or down).
 * - Manual prices are kept while they still clear the minimum margin; otherwise
 *   the offer pauses and the owner is alerted to set a new price.
 */
export function onCostChange(currentPrice: Cents, newCost: Cents, rule: PriceRule): CostDecision {
  if (rule.mode === "manual") {
    return currentPrice >= minimumPrice(newCost, rule.minMarginPct)
      ? { action: "keep", price: currentPrice }
      : { action: "pause", reason: "cost_above_margin" };
  }
  const price = priceFromCost(newCost, rule);
  return price === currentPrice ? { action: "keep", price } : { action: "reprice", price };
}
