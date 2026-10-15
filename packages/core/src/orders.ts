/**
 * Order lifecycle.
 *
 *   paid ──► processing ──► delivered
 *     │           │
 *     │           └──► failed ──► refunded
 *     └──► failed ──► refunded
 *
 * The wallet is debited when the order is created (status "paid"), inside one
 * database transaction. A failed order is always refunded to the wallet,
 * exactly once (the ledger has a unique key per refund).
 */
import type { PurchaseResult } from "./adapters";

export type OrderStatus = "paid" | "processing" | "delivered" | "failed" | "refunded";

const TRANSITIONS: Record<OrderStatus, readonly OrderStatus[]> = {
  paid: ["processing", "delivered", "failed"],
  processing: ["delivered", "failed"],
  delivered: [],
  failed: ["refunded", "processing"],
  refunded: [],
};

export function canTransition(from: OrderStatus, to: OrderStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

export function isFinal(status: OrderStatus): boolean {
  return status === "delivered" || status === "refunded";
}

/** What the core should do after asking the supplier. */
export type FulfilmentStep =
  | { next: "delivered" }
  | { next: "processing"; checkAfterSeconds: number }
  | { next: "retry"; checkAfterSeconds: number; reason: string }
  | { next: "refund"; reason: string };

/** Wait 30s, 1m, 2m, 5m, 10m, then every 15m. */
export function backoffSeconds(attempt: number): number {
  const steps = [30, 60, 120, 300, 600];
  return steps[Math.max(0, attempt)] ?? 900;
}

/**
 * Turn a supplier answer into the next step.
 * - Retryable failures (network, supplier temporarily out of balance) are retried
 *   up to `maxAttempts`, then refunded.
 * - Pending orders are checked again with backoff until `maxPendingHours`, then
 *   handed to a person (they are NOT refunded automatically: the supplier may
 *   still deliver, and a refund plus a late delivery would give the item away).
 */
export function nextStep(
  result: PurchaseResult,
  attempt: number,
  opts: { maxAttempts?: number } = {},
): FulfilmentStep {
  const maxAttempts = opts.maxAttempts ?? 6;
  switch (result.status) {
    case "delivered":
      return { next: "delivered" };
    case "pending":
      return { next: "processing", checkAfterSeconds: backoffSeconds(attempt) };
    case "failed":
      if (result.retryable && attempt + 1 < maxAttempts) {
        return { next: "retry", checkAfterSeconds: backoffSeconds(attempt), reason: result.reason };
      }
      return { next: "refund", reason: result.reason };
  }
}
