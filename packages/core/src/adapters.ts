/**
 * Contracts every supplier and payment integration implements.
 *
 * Adapters are small, stateless modules. They talk to one outside API, use only
 * Web-standard APIs (fetch, crypto.subtle, TextEncoder) so they run unchanged on
 * Cloudflare Workers, Bun and Node 20+, and never touch the database: the core
 * decides what to store.
 */

/** How a product reaches the customer. */
export type DeliveryKind = "id" | "code" | "account" | "link" | "sms";

/** A field the customer fills in before buying (player ID, region, email...). */
export interface InputField {
  key: string;
  labelEn: string;
  labelAr?: string;
  required: boolean;
  /** Optional regular expression the value must match. */
  pattern?: string;
  /** A fixed list to choose from (a game server, a region). The value must be one of them. */
  options?: InputOption[];
}

export interface InputOption {
  value: string;
  labelEn?: string;
  labelAr?: string;
}

/** A sellable item as the supplier lists it. Prices are integer US cents. */
export interface SupplierProduct {
  /** The supplier's own identifier for this item. Stable across syncs. */
  externalId: string;
  name: string;
  /** What we pay the supplier for one unit, in US cents. */
  costCents: number;
  available: boolean;
  kind: DeliveryKind;
  fields?: InputField[];
  /** Supplier-specific extras (category, region, image...). Never secrets. */
  meta?: Record<string, unknown>;
  /**
   * How this supplier's own catalogue suggests selling the item: items sharing a
   * productKey become packages of one store product called productName (G2Bulk:
   * a game, MaxStore: a category, 5SIM: a service). Without one, the item is a
   * product of its own (BatStore, ProdSeller). The owner can still move it.
   */
  productKey?: string;
  productName?: string;
  /** The product's Arabic name, when the supplier can give one (5SIM: "رقم Telegram"). */
  productNameAr?: string;
  /** The item's name as a package inside that product ("60 UC" in "PUBG Mobile"). Defaults to name. */
  packageName?: string;
  /** The package's Arabic name, when the supplier can give one (5SIM: the country's name). */
  packageNameAr?: string;
}

export interface PurchaseRequest {
  externalId: string;
  quantity: number;
  /** Values for the product's input fields, keyed by InputField.key. */
  fields: Record<string, string>;
  /** Our order id. Adapters pass it to the supplier when it supports idempotency. */
  idempotencyKey: string;
  /**
   * The most we accept to pay for one unit (the package's known cost), when the
   * supplier can cap a price (5SIM: maxPrice). A supplier asking more refuses.
   */
  maxCostCents?: number;
}

/** One thing handed to the customer: a code, credentials, a link, a phone number, an SMS code. */
export interface DeliveredItem {
  kind: DeliveryKind | "phone";
  value: string;
  label?: string;
}

/** Why a purchase failed, when the supplier says so clearly. */
export type FailureCode = "out_of_stock" | "insufficient_balance" | "invalid_input" | "auth" | "unavailable" | "unknown";

export type PurchaseResult =
  | { status: "delivered"; supplierOrderId: string; items: DeliveredItem[]; costCents?: number }
  | { status: "pending"; supplierOrderId: string; items?: DeliveredItem[]; costCents?: number; expiresAt?: string }
  | { status: "failed"; retryable: boolean; reason: string; code?: FailureCode; supplierOrderId?: string };

export interface SupplierBalance {
  amountCents: number;
  currency: string;
}

/** Everything an adapter needs from the outside world. Injected so tests can fake it. */
export interface AdapterContext {
  fetch: typeof fetch;
  /** Secrets and settings for this integration (API keys, base URLs...). */
  config: Record<string, string | undefined>;
  now?: () => Date;
}

/** A slice of a large supplier catalogue (a game, a category) that can be listed on its own. */
export interface SupplierGroup {
  id: string;
  name: string;
  image?: string | null;
}

export interface SupplierAdapter {
  /** Stable id used in the database, e.g. "g2bulk". */
  readonly id: string;
  readonly name: string;
  /**
   * The catalogue, or one group of it. Suppliers with listGroups() are too big to
   * list at once (one request per game): the admin lists a group at a time.
   */
  listProducts(group?: string): Promise<SupplierProduct[]>;
  /** The groups of a catalogue too large to list in one go (see listProducts). */
  listGroups?(): Promise<SupplierGroup[]>;
  /**
   * Current cost and availability of these products only. Anything not returned
   * is no longer sold. Lets the sync check what the store sells without reading
   * the whole catalogue.
   */
  listProductsFor?(externalIds: string[]): Promise<SupplierProduct[]>;
  /**
   * Which request a product's price comes from in listProductsFor (one request
   * per group), so the sync can spread a big catalogue over several runs.
   */
  syncGroup?(externalId: string): string;
  getBalance(): Promise<SupplierBalance | null>;
  purchase(req: PurchaseRequest): Promise<PurchaseResult>;
  /** Re-check an order the supplier reported as pending. */
  checkOrder(supplierOrderId: string): Promise<PurchaseResult>;
  /** Cancel a pending order where the supplier allows it (virtual numbers). */
  cancel?(supplierOrderId: string): Promise<boolean>;
  /** Report a virtual number as already used by the target service (virtual numbers). */
  ban?(supplierOrderId: string): Promise<boolean>;
  /** Parse and authenticate a supplier callback. Returns null when it is not ours or not valid. */
  parseWebhook?(req: Request): Promise<{ supplierOrderId: string; result: PurchaseResult } | null>;
}

export type SupplierFactory = (ctx: AdapterContext) => SupplierAdapter;

// ---------------------------------------------------------------- payments

export type PaymentMethod = "sam" | "nowpayments" | "bep20" | "stars";

export interface CreatePaymentInput {
  /** Our payment id (uuid). Sent to the provider so callbacks can be matched. */
  paymentId: string;
  amountCents: number;
  /** Shown on the provider's page where supported. */
  description: string;
  /** Where the provider should send its callback, when it has one. */
  callbackUrl?: string;
  /** Where to send the customer back after paying, when the provider redirects. */
  returnUrl?: string;
}

/** What the customer has to do next to pay. */
export type PaymentAction =
  | { type: "redirect"; url: string }
  | { type: "address"; network: string; asset: string; address: string; amount: string; memo?: string }
  | { type: "telegram_invoice"; url: string }
  | { type: "instructions"; textEn: string; textAr: string };

export interface CreatedPayment {
  providerRef: string;
  action: PaymentAction;
  expiresAt?: string;
}

/** "review" means a person has to look at it (amount unclear, manual transfer...). */
export type PaymentStatus = "pending" | "paid" | "partial" | "review" | "failed" | "expired";

export interface PaymentEvent {
  providerRef: string;
  /** Our payment id when the provider echoes it back. */
  paymentId?: string;
  status: PaymentStatus;
  /** Amount actually received, in US cents, when the provider reports it. */
  amountCents?: number;
  /** For on-chain transfers: the transaction hash, used to block reuse. */
  txHash?: string;
}

export interface PaymentAdapter {
  readonly id: PaymentMethod;
  createPayment(input: CreatePaymentInput): Promise<CreatedPayment>;
  /** Authenticate and parse a provider callback. Returns null when invalid. */
  verifyWebhook?(req: Request): Promise<PaymentEvent | null>;
  /**
   * Ask the provider for the current status. `expected` lets adapters compare the
   * amount and age themselves (on-chain transfers, invoices in another currency).
   */
  checkPayment?(providerRef: string, expected?: { amountCents: number; createdAt?: string }): Promise<PaymentEvent>;
}

export type PaymentFactory = (ctx: AdapterContext) => PaymentAdapter;

/** Error raised by adapters for configuration or protocol problems (not customer mistakes). */
export class AdapterError extends Error {
  constructor(
    readonly adapter: string,
    message: string,
    readonly retryable = false,
  ) {
    super(`${adapter}: ${message}`);
    this.name = "AdapterError";
  }
}
