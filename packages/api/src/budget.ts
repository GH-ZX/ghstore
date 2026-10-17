/**
 * The outside-request budget of one Worker run (Cloudflare's free plan allows
 * 50). apps/web/src/services.ts counts the requests; everything here only asks
 * how many are left, so the scheduled jobs leave room for each other.
 */
import type { Services } from "./context";

/**
 * How many more outgoing requests this run may make, keeping `reserve` back
 * (Infinity without a budget). One scheduled run shares Cloudflare's limit
 * (50 on the free plan) between all the jobs in jobs.ts.
 */
export function room(svc: Services, reserve = 0): number {
  return svc.budget ? Math.max(0, svc.budget.left() - reserve) : Number.POSITIVE_INFINITY;
}
