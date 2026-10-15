/**
 * Supplier adapters, keyed by the stable id stored in the database.
 *
 * Each factory reads only its own keys from `ctx.config` (documented at the top
 * of each adapter file) and talks to the outside world only through `ctx.fetch`.
 */
import type { SupplierFactory } from "../../core/src/adapters";
import { createBatStore } from "./batstore";
import { createFiveSim } from "./fivesim";
import { createG2Bulk } from "./g2bulk";
import { createMaxStore } from "./maxstore";
import { createProdSeller } from "./prodseller";

export const supplierFactories: Record<string, SupplierFactory> = {
  g2bulk: createG2Bulk,
  batstore: createBatStore,
  prodseller: createProdSeller,
  fivesim: createFiveSim,
  maxstore: createMaxStore,
};

export { createBatStore, createFiveSim, createG2Bulk, createMaxStore, createProdSeller };
export type { FiveSimAdapter } from "./fivesim";
