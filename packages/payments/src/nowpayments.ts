/**
 * NOWPayments: automatic crypto payments, USDT on BNB Smart Chain by default.
 *
 * API reference: https://documenter.getpostman.com/view/7907941/2s93JusNJt
 *
 * Config keys (ctx.config):
 *   NOWPAYMENTS_API_KEY            required  Sent as the x-api-key header.
 *   NOWPAYMENTS_IPN_SECRET         required  for webhooks. The IPN secret from the dashboard
 *                                            (Payment Settings); keys the HMAC-SHA512 signature.
 *   NOWPAYMENTS_BASE_URL           optional  Default "https://api.nowpayments.io/v1"
 *                                            (sandbox: "https://api-sandbox.nowpayments.io/v1").
 *   NOWPAYMENTS_PAY_CURRENCY       optional  Ticker the customer pays in, default "usdtbsc"
 *                                            (USDT BEP20). Callbacks for any other pay currency
 *                                            are never reported as paid.
 *   NOWPAYMENTS_IPN_URL            optional  Callback URL used when CreatePaymentInput.callbackUrl
 *                                            is absent.
 *   NOWPAYMENTS_FIXED_RATE         optional  "true" sends is_fixed_rate.
 *   NOWPAYMENTS_FEE_PAID_BY_USER   optional  "true" sends is_fee_paid_by_user (fixed rate only).
 *   NOWPAYMENTS_PAID_ON_CONFIRMED  optional  "true" reports "confirmed"/"sending" as paid. By
 *                                            default only "finished" is paid.
 *
 * Why POST /payment (address) and not POST /invoice (hosted page): the invoice
 * endpoint returns only an invoice id, while the status endpoint
 * (GET /payment/{payment_id}) needs a payment id that exists only once the
 * customer has picked a coin on the hosted page; listing payments by invoice id
 * needs a separate JWT login (account email + password). Creating the payment
 * directly gives a payment_id up front, so checkPayment works with the API key
 * alone, pay_currency is fixed by construction, and the Mini App can render the
 * address and amount itself.
 *
 * Callbacks (IPN) carry x-nowpayments-sig = hex(HMAC-SHA512(ipn_secret,
 * JSON of the body with keys sorted recursively)).
 */
import {
  AdapterError,
  type AdapterContext,
  type CreatePaymentInput,
  type CreatedPayment,
  type PaymentAdapter,
  type PaymentEvent,
  type PaymentStatus,
} from "../../core/src/adapters";
import { assertCents, centsToDecimal } from "../../core/src/money";
import {
  hmacHex,
  httpJson,
  isRecord,
  parseScaled,
  providerMessage,
  readBoolean,
  readConfig,
  redact,
  requireConfig,
  retryableStatus,
  secretsMatch,
  text,
  trimSlash,
  truncate,
  withRetry,
  type HttpResult,
} from "./util";

const ID = "nowpayments";
export const NOWPAYMENTS_DEFAULT_BASE_URL = "https://api.nowpayments.io/v1";
export const NOWPAYMENTS_DEFAULT_PAY_CURRENCY = "usdtbsc";
export const NOWPAYMENTS_SIGNATURE_HEADER = "x-nowpayments-sig";

/** How a pay currency is shown to the customer. Anything else falls back to the ticker. */
const DISPLAY: Record<string, { network: string; asset: string }> = {
  usdtbsc: { network: "BSC (BEP20)", asset: "USDT" },
  usdttrc20: { network: "TRON (TRC20)", asset: "USDT" },
  usdterc20: { network: "Ethereum (ERC20)", asset: "USDT" },
};

const STATUS: Record<string, PaymentStatus> = {
  waiting: "pending", // waiting for the customer to send
  confirming: "pending", // seen on chain, confirming
  confirmed: "pending", // enough confirmations (see NOWPAYMENTS_PAID_ON_CONFIRMED)
  sending: "pending", // being forwarded to the store's wallet
  partially_paid: "partial", // less than the price arrived
  finished: "paid", // funds reached the store's wallet
  failed: "failed",
  refunded: "failed", // returned to the customer
  expired: "expired", // nothing arrived within the window
};

/** Map a NOWPayments payment_status to ours. Unknown statuses stay pending. */
export function mapNowPaymentsStatus(status: string, paidOnConfirmed = false): PaymentStatus {
  const s = status.trim().toLowerCase();
  if (paidOnConfirmed && (s === "confirmed" || s === "sending")) return "paid";
  return STATUS[s] ?? "pending";
}

/**
 * Recursively sort object keys, keeping arrays as arrays. This is the canonical
 * form of the docs' Python sample (json.dumps(sort_keys=True, separators=(",", ":"))).
 */
export function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (isRecord(value)) {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) out[key] = sortKeysDeep(value[key]);
    return out;
  }
  return value;
}

/**
 * The docs' Node.js sample, literally: its sortObject() recurses into arrays with
 * Object.keys(), which turns [a, b] into {"0": a, "1": b}. Identical to
 * sortKeysDeep for payloads without arrays.
 */
function sortObjectLikeNodeSample(value: unknown): unknown {
  if (value !== null && typeof value === "object") {
    const source = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) out[key] = sortObjectLikeNodeSample(source[key]);
    return out;
  }
  return value;
}

/** The hex HMAC-SHA512 NOWPayments sends in x-nowpayments-sig for this body. */
export async function nowPaymentsSignature(body: unknown, ipnSecret: string): Promise<string> {
  return hmacHex("SHA-512", ipnSecret, JSON.stringify(sortKeysDeep(body)));
}

/** Verify an IPN signature in constant time. Accepts either canonical form described in the docs. */
export async function verifyNowPaymentsSignature(body: unknown, signature: string, ipnSecret: string): Promise<boolean> {
  const provided = signature.trim().toLowerCase();
  if (!/^[0-9a-f]{128}$/.test(provided)) return false;
  const canonical = await nowPaymentsSignature(body, ipnSecret);
  if (await secretsMatch(provided, canonical)) return true;
  const nodeSample = await hmacHex("SHA-512", ipnSecret, JSON.stringify(sortObjectLikeNodeSample(body)));
  return nodeSample !== canonical && (await secretsMatch(provided, nodeSample));
}

/**
 * Turn a NOWPayments payment object (status response or IPN body) into a
 * PaymentEvent. amountCents is the USD value received: price x actually_paid /
 * pay_amount, rounded down; for "finished" without figures, the price.
 */
export function nowPaymentsToEvent(
  payment: Record<string, unknown>,
  options: { payCurrency: string; paidOnConfirmed?: boolean },
): PaymentEvent | null {
  const providerRef = text(payment.payment_id);
  const rawStatus = text(payment.payment_status);
  if (!providerRef || !rawStatus) return null;
  let status = mapNowPaymentsStatus(rawStatus, options.paidOnConfirmed);
  const event: PaymentEvent = { providerRef, status };
  const orderId = text(payment.order_id);
  if (orderId) event.paymentId = orderId;

  let amountCents: number | undefined;
  const priceCurrency = text(payment.price_currency)?.toLowerCase();
  const price = parseScaled(payment.price_amount, 2);
  if (priceCurrency === "usd" && price !== null && price > 0n) {
    const paid = parseScaled(payment.actually_paid, 18);
    const due = parseScaled(payment.pay_amount, 18);
    if (paid !== null && due !== null && paid > 0n && due > 0n) {
      amountCents = Number((price * paid) / due);
    } else if (status === "paid") {
      amountCents = Number(price);
    }
  }

  // Defence in depth: the store only takes the configured coin. A payment in
  // anything else is never "paid" automatically.
  const payCurrency = text(payment.pay_currency)?.toLowerCase();
  if (payCurrency && payCurrency !== options.payCurrency.toLowerCase()) {
    if (status === "paid" || status === "partial") status = "partial";
    amountCents = undefined;
  }
  event.status = status;
  if (amountCents !== undefined && Number.isSafeInteger(amountCents)) event.amountCents = amountCents;
  return event;
}

function plainAmount(value: unknown): string | null {
  if (typeof value === "string" && /^\d+(\.\d+)?$/.test(value.trim())) return value.trim();
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    const s = String(value);
    return /e/i.test(s) ? value.toLocaleString("en-US", { useGrouping: false, maximumFractionDigits: 20 }) : s;
  }
  return null;
}

export interface NowPaymentsAdapter extends PaymentAdapter {
  readonly id: "nowpayments";
  createPayment(input: CreatePaymentInput): Promise<CreatedPayment>;
  verifyWebhook(req: Request): Promise<PaymentEvent | null>;
  checkPayment(providerRef: string): Promise<PaymentEvent>;
}

export function createNowPayments(ctx: AdapterContext): NowPaymentsAdapter {
  const baseUrl = (): string => trimSlash(readConfig(ctx, "NOWPAYMENTS_BASE_URL") ?? NOWPAYMENTS_DEFAULT_BASE_URL);
  const apiKey = (): string => requireConfig(ctx, ID, "NOWPAYMENTS_API_KEY");
  const payCurrency = (): string =>
    (readConfig(ctx, "NOWPAYMENTS_PAY_CURRENCY") ?? NOWPAYMENTS_DEFAULT_PAY_CURRENCY).toLowerCase();
  const eventOptions = () => ({
    payCurrency: payCurrency(),
    paidOnConfirmed: readBoolean(ctx, ID, "NOWPAYMENTS_PAID_ON_CONFIRMED") === true,
  });

  function fail(res: HttpResult, what: string): never {
    const message = redact(providerMessage(res.json) ?? `HTTP ${res.status}`, [
      readConfig(ctx, "NOWPAYMENTS_API_KEY"),
      readConfig(ctx, "NOWPAYMENTS_IPN_SECRET"),
    ]);
    const code = isRecord(res.json) ? text(res.json.code) : null;
    throw new AdapterError(
      ID,
      `${what} failed (HTTP ${res.status}${code ? ` ${code}` : ""}): ${message}`,
      retryableStatus(res.status),
    );
  }

  async function createPayment(input: CreatePaymentInput): Promise<CreatedPayment> {
    assertCents(input.amountCents);
    if (input.amountCents <= 0) throw new AdapterError(ID, "amount must be positive");
    const key = apiKey();
    const currency = payCurrency();
    const callback = input.callbackUrl ?? readConfig(ctx, "NOWPAYMENTS_IPN_URL");
    if (!callback) throw new AdapterError(ID, "no callback URL (pass callbackUrl or set NOWPAYMENTS_IPN_URL)");

    const body: Record<string, unknown> = {
      price_amount: Number(centsToDecimal(input.amountCents)),
      price_currency: "usd",
      pay_currency: currency,
      order_id: input.paymentId,
      order_description: truncate(input.description, 250),
      ipn_callback_url: callback,
    };
    const fixedRate = readBoolean(ctx, ID, "NOWPAYMENTS_FIXED_RATE");
    if (fixedRate !== undefined) body.is_fixed_rate = fixedRate;
    const feeByUser = readBoolean(ctx, ID, "NOWPAYMENTS_FEE_PAID_BY_USER");
    if (feeByUser !== undefined) body.is_fee_paid_by_user = feeByUser;

    // Never retried: a second POST would open a second payment.
    const res = await httpJson(ctx, ID, `${baseUrl()}/payment`, {
      method: "POST",
      headers: { "x-api-key": key },
      body,
    });
    if (!res.ok) fail(res, "POST /payment");
    const j = isRecord(res.json) ? res.json : {};
    const paymentId = text(j.payment_id);
    const address = text(j.pay_address);
    const amount = plainAmount(j.pay_amount);
    if (!paymentId || !address || !amount) {
      throw new AdapterError(ID, "NOWPayments returned a payment without id, address or amount");
    }
    const returned = text(j.pay_currency)?.toLowerCase();
    if (returned && returned !== currency) {
      throw new AdapterError(ID, `NOWPayments opened the payment in ${returned}, expected ${currency}`);
    }
    const display = DISPLAY[currency] ?? {
      network: (text(j.network) ?? currency).toUpperCase(),
      asset: currency.toUpperCase(),
    };
    const memo = text(j.payin_extra_id);
    const created: CreatedPayment = {
      providerRef: paymentId,
      action: { type: "address", network: display.network, asset: display.asset, address, amount, ...(memo ? { memo } : {}) },
    };
    const expiresAt = text(j.expiration_estimate_date);
    if (expiresAt) created.expiresAt = expiresAt;
    return created;
  }

  async function checkPayment(providerRef: string): Promise<PaymentEvent> {
    const id = providerRef.trim();
    if (!/^\d+$/.test(id)) throw new AdapterError(ID, "payment id must be numeric");
    const res = await withRetry(3, 300, async () => {
      const r = await httpJson(ctx, ID, `${baseUrl()}/payment/${id}`, {
        method: "GET",
        headers: { "x-api-key": apiKey() },
      });
      if (!r.ok) fail(r, "GET /payment/{id}");
      return r;
    });
    const event = isRecord(res.json) ? nowPaymentsToEvent(res.json, eventOptions()) : null;
    if (!event) throw new AdapterError(ID, "NOWPayments returned an unreadable payment status", true);
    if (event.providerRef !== id) throw new AdapterError(ID, "NOWPayments answered for a different payment");
    return event;
  }

  async function verifyWebhook(req: Request): Promise<PaymentEvent | null> {
    if (req.method.toUpperCase() !== "POST") return null;
    const secret = requireConfig(ctx, ID, "NOWPAYMENTS_IPN_SECRET");
    const signature = req.headers.get(NOWPAYMENTS_SIGNATURE_HEADER);
    if (!signature) return null;
    let body: unknown;
    try {
      body = JSON.parse(await req.text());
    } catch {
      return null;
    }
    if (!isRecord(body)) return null;
    if (!(await verifyNowPaymentsSignature(body, signature, secret))) return null;
    return nowPaymentsToEvent(body, eventOptions());
  }

  return { id: ID, createPayment, checkPayment, verifyWebhook };
}
