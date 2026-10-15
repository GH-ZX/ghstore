/**
 * Telegram Stars (currency "XTR") inside the bot and the Mini App.
 *
 * Bot API: https://core.telegram.org/bots/api#createinvoicelink,
 * #answerprecheckoutquery, #successfulpayment; https://core.telegram.org/bots/payments-stars
 *
 * Config keys (ctx.config):
 *   TELEGRAM_BOT_TOKEN   required  The bot's token. It is part of every Bot API URL, so
 *                                  no URL is ever quoted in an error.
 *   STARS_PER_USD        required  How many Stars one US dollar costs, e.g. "77". Prices
 *                                  round UP to whole Stars. (The old bot's
 *                                  GHSTORE_STARS_TO_USD=0.01 equals STARS_PER_USD=100.)
 *   STARS_INVOICE_TITLE  optional  Invoice title (1-32 chars), default "Payment".
 *   TELEGRAM_API_BASE    optional  Default "https://api.telegram.org".
 *
 * Flow: createPayment -> createInvoiceLink with payload = our paymentId; the bot
 * receives pre_checkout_query (validate it, then answerPreCheckout within 10 s)
 * and then message.successful_payment, which parseSuccessfulPayment turns into a
 * PaymentEvent. Goods are delivered only after successful_payment.
 * Stars has no callback of its own to verify: the bot's webhook must check
 * Telegram's X-Telegram-Bot-Api-Secret-Token header before these helpers run.
 */
import {
  AdapterError,
  type AdapterContext,
  type CreatePaymentInput,
  type CreatedPayment,
  type PaymentAdapter,
  type PaymentEvent,
} from "../../core/src/adapters";
import { assertCents } from "../../core/src/money";
import {
  ceilDiv,
  httpJson,
  isRecord,
  parseScaled,
  providerMessage,
  readConfig,
  redact,
  requireConfig,
  retryableStatus,
  text,
  trimSlash,
  truncate,
  utf8Length,
} from "./util";

const ID = "stars";
export const TELEGRAM_DEFAULT_API_BASE = "https://api.telegram.org";
const RATE_SCALE = 6;
const RATE_UNIT = 10n ** BigInt(RATE_SCALE);

function parseRate(starsPerUsd: string | number): bigint {
  const rate = parseScaled(starsPerUsd, RATE_SCALE);
  if (rate === null || rate <= 0n) throw new AdapterError(ID, "STARS_PER_USD must be a positive number");
  return rate;
}

/** Stars to charge for a USD amount: cents x STARS_PER_USD / 100, rounded up, at least 1. */
export function starsForCents(amountCents: number, starsPerUsd: string | number): number {
  assertCents(amountCents);
  if (amountCents <= 0) throw new AdapterError(ID, "amount must be positive");
  const stars = ceilDiv(BigInt(amountCents) * parseRate(starsPerUsd), 100n * RATE_UNIT);
  return Number(stars > 0n ? stars : 1n);
}

/** USD cents a number of Stars is worth at the rate, rounded down. Inverse of starsForCents. */
export function centsForStars(stars: number, starsPerUsd: string | number): number {
  if (!Number.isSafeInteger(stars) || stars < 0) throw new AdapterError(ID, "stars must be a non-negative integer");
  return Number((BigInt(stars) * 100n * RATE_UNIT) / parseRate(starsPerUsd));
}

function botUrl(ctx: AdapterContext, method: string): string {
  const token = requireConfig(ctx, ID, "TELEGRAM_BOT_TOKEN");
  const base = trimSlash(readConfig(ctx, "TELEGRAM_API_BASE") ?? TELEGRAM_DEFAULT_API_BASE);
  return `${base}/bot${token}/${method}`;
}

/** Call a Bot API method and return `result`. Errors never include the token. */
async function callBotApi(ctx: AdapterContext, method: string, params: Record<string, unknown>): Promise<unknown> {
  const res = await httpJson(ctx, ID, botUrl(ctx, method), { method: "POST", body: params });
  const body = isRecord(res.json) ? res.json : {};
  if (!res.ok || body.ok !== true) {
    const status = typeof body.error_code === "number" ? body.error_code : res.status;
    const message = redact(providerMessage(res.json) ?? `HTTP ${res.status}`, [readConfig(ctx, "TELEGRAM_BOT_TOKEN")]);
    throw new AdapterError(ID, `${method} failed (${status}): ${message}`, retryableStatus(status));
  }
  return body.result;
}

/**
 * Answer a pre-checkout query. Telegram cancels the payment when no answer arrives
 * within 10 seconds. When refusing, Telegram shows `errorMessage` to the customer.
 */
export async function answerPreCheckout(
  ctx: AdapterContext,
  queryId: string,
  ok: boolean,
  errorMessage?: string,
): Promise<void> {
  if (!queryId.trim()) throw new AdapterError(ID, "empty pre_checkout_query_id");
  const params: Record<string, unknown> = { pre_checkout_query_id: queryId, ok };
  if (!ok) {
    params.error_message = truncate(errorMessage?.trim() || "This payment can no longer be completed. Please start again.", 255);
  }
  await callBotApi(ctx, "answerPreCheckoutQuery", params);
}

export interface StarsPreCheckout {
  queryId: string;
  /** Our payment id, from the invoice payload. */
  paymentId: string;
  currency: string;
  /** Total in Stars (XTR has no fractional unit). */
  totalStars: number;
  fromId: number | null;
}

/**
 * Read a pre_checkout_query from an Update. The bot should look the payment up by
 * `paymentId`, check it is still pending and that `totalStars` matches what was
 * invoiced, and only then answerPreCheckout(ok = true).
 */
export function parsePreCheckoutQuery(update: unknown): StarsPreCheckout | null {
  if (!isRecord(update) || !isRecord(update.pre_checkout_query)) return null;
  const q = update.pre_checkout_query;
  const queryId = text(q.id);
  const paymentId = text(q.invoice_payload);
  const currency = text(q.currency);
  const total = q.total_amount;
  if (!queryId || !paymentId || !currency || typeof total !== "number" || !Number.isSafeInteger(total)) return null;
  const from = isRecord(q.from) && typeof q.from.id === "number" ? q.from.id : null;
  return { queryId, paymentId, currency, totalStars: total, fromId: from };
}

/**
 * Turn an Update (or a Message) carrying `successful_payment` in Stars into a
 * PaymentEvent: providerRef = telegram_payment_charge_id (keep it, refunds need it),
 * paymentId = invoice_payload. amountCents is filled when `ctx` provides
 * STARS_PER_USD (at today's rate, rounded down). Returns null for anything else,
 * including payments in a currency other than XTR.
 */
export function parseSuccessfulPayment(update: unknown, ctx?: AdapterContext): PaymentEvent | null {
  if (!isRecord(update)) return null;
  const message = isRecord(update.message) ? update.message : update;
  const sp = message.successful_payment;
  if (!isRecord(sp)) return null;
  if (sp.currency !== "XTR") return null;
  const chargeId = text(sp.telegram_payment_charge_id);
  const paymentId = text(sp.invoice_payload);
  const stars = sp.total_amount;
  if (!chargeId || !paymentId || typeof stars !== "number" || !Number.isSafeInteger(stars) || stars <= 0) return null;
  const event: PaymentEvent = { providerRef: chargeId, paymentId, status: "paid" };
  const rate = ctx ? readConfig(ctx, "STARS_PER_USD") : undefined;
  if (rate !== undefined) event.amountCents = centsForStars(stars, rate);
  return event;
}

export interface StarsAdapter extends PaymentAdapter {
  readonly id: "stars";
  createPayment(input: CreatePaymentInput): Promise<CreatedPayment>;
}

export function createStars(ctx: AdapterContext): StarsAdapter {
  async function createPayment(input: CreatePaymentInput): Promise<CreatedPayment> {
    assertCents(input.amountCents);
    const stars = starsForCents(input.amountCents, requireConfig(ctx, ID, "STARS_PER_USD"));
    const payload = input.paymentId;
    const payloadBytes = utf8Length(payload);
    if (payloadBytes < 1 || payloadBytes > 128) throw new AdapterError(ID, "paymentId must be 1-128 bytes to fit the invoice payload");
    const title = truncate(readConfig(ctx, "STARS_INVOICE_TITLE") ?? "Payment", 32);
    const description = truncate(input.description.trim() || title, 255);
    const result = await callBotApi(ctx, "createInvoiceLink", {
      title,
      description,
      payload,
      provider_token: "",
      currency: "XTR",
      prices: [{ label: `${stars} Stars`, amount: stars }],
    });
    const url = text(result);
    if (!url || !/^https:\/\//.test(url)) throw new AdapterError(ID, "createInvoiceLink returned no link");
    // There is no Telegram charge yet; the charge id arrives with successful_payment.
    return { providerRef: payload, action: { type: "telegram_invoice", url } };
  }

  return { id: ID, createPayment };
}
