/**
 * SAM (sam-api.pro): ShamCash, and later Syriatel Cash, wallet payments.
 *
 * Ported from gh-store-tele (services/sam.py, routes/webhooks.py /samwebhook,
 * routes/tma_wallet.py) and gh-store-dev (providers/sam/client.ts,
 * sam-recharge.service.ts, supabase/functions/sam-webhook).
 *
 * Config keys (ctx.config):
 *   SAM_API_KEY         required  Bearer key for sam-api.pro.
 *   SAM_WEBHOOK_SECRET  required  Long random string. SAM signs nothing, so this
 *                                 travels in the callback URL (?token=) and is
 *                                 checked in constant time on every callback.
 *   SAM_BASE_URL        optional  Default "https://sam-api.pro/api" (already ends
 *                                 in /api; the customer page is /pay/{id} without it).
 *   SAM_WEBHOOK_URL     optional  Callback URL used when CreatePaymentInput.callbackUrl
 *                                 is absent. One of the two is required.
 *   SAM_METHOD          optional  "shamcash" (default) or "syriatel".
 *   SAM_WALLET          optional  The store's receiving wallet for SAM_METHOD as saved
 *                                 by the owner (ShamCash 32-hex address, Syriatel phone
 *                                 or cash code). It is matched against the wallets
 *                                 linked to the API key. Default: the first active
 *                                 linked wallet for the method.
 *   SAM_CURRENCY        optional  Invoice currency, "USD" (default) or "SYP".
 *   SAM_SYP_PER_USD     required  for SYP invoices. NEW Syrian pounds per 1 USD. Syria
 *                                 removed two zeros from the pound on 1 Jan 2026, so a
 *                                 pre-2026 figure (e.g. 13000) is 100x too large.
 *   SAM_SYP_MAX_RATE    optional  Sanity ceiling for SAM_SYP_PER_USD, default 1000.
 *                                 A larger rate is refused as a probable old-pound value.
 *
 * Safety model (unchanged from the old code): a callback is only a hint. It must
 * carry the secret token, and even then the adapter asks SAM for the invoice and
 * reports SAM's own answer, never the payload's figures. `checkPayment` is the
 * same question asked directly. "paid" is only reported when SAM says paid AND
 * the paid figure covers the invoiced figure in the invoice's own currency.
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
  httpJson,
  isRecord,
  parseScaled,
  providerMessage,
  readConfig,
  readPositiveNumber,
  redact,
  requireConfig,
  retryableStatus,
  secretsMatch,
  text,
  trimSlash,
  withRetry,
  type HttpResult,
} from "./util";

const ID = "sam";
export const SAM_DEFAULT_BASE_URL = "https://sam-api.pro/api";
const DEFAULT_SYP_MAX_RATE = 1000;
const READ_ATTEMPTS = 3;
const READ_BACKOFF_MS = 300;

export type SamMethod = "shamcash" | "syriatel";
export type SamCurrency = "USD" | "SYP";

/** SAM's view of one invoice, as returned by GET /pay/{id}. Amounts kept as SAM sent them. */
export interface SamInvoice {
  invoiceId: string;
  status: string;
  amount: unknown;
  paidAmount: unknown;
  currency: string | null;
  method: string | null;
  paidAt: string | null;
  expiresAt: string | null;
  transactionRef: string | null;
}

export interface SamReferenceResult {
  /** SAM found the customer's transfer reference in the receiving wallet's history. */
  verified: boolean;
  message: string | null;
  /** SAM's own status for the invoice after the check, with the amount rules applied. */
  event: PaymentEvent;
}

export interface SamAdapter extends PaymentAdapter {
  readonly id: "sam";
  createPayment(input: CreatePaymentInput): Promise<CreatedPayment>;
  verifyWebhook(req: Request): Promise<PaymentEvent | null>;
  checkPayment(providerRef: string): Promise<PaymentEvent>;
  /**
   * For a customer whose transfer has not landed on its own: ask SAM to match the
   * wallet transaction reference they paste in (POST /pay/{id}/verify).
   */
  verifyReference(invoiceId: string, transactionRef: string): Promise<SamReferenceResult>;
}

// ---------------------------------------------------------------- pure helpers

/** Sam bills whole pounds; USD is billed to two decimals. Amounts are sent as strings. */
export function samChargeAmount(amountCents: number, currency: SamCurrency, sypPerUsd?: number): string {
  assertCents(amountCents);
  if (currency === "USD") return centsToDecimal(amountCents);
  if (!sypPerUsd || !(sypPerUsd > 0)) throw new AdapterError(ID, "SAM_SYP_PER_USD is required to invoice in SYP");
  const pounds = Math.round((amountCents * sypPerUsd) / 100);
  if (!(pounds >= 1)) throw new AdapterError(ID, "amount is too small to invoice in SYP");
  return String(pounds);
}

/**
 * Map SAM's invoice to a PaymentEvent. `paidOverride` is a paid figure reported by
 * SAM's verify endpoint, used before the invoice's own figures.
 */
export function samInvoiceToEvent(invoice: SamInvoice, sypPerUsd: number | undefined, paidOverride?: unknown): PaymentEvent {
  const base = { providerRef: invoice.invoiceId };
  const status = invoice.status.toLowerCase();
  if (status === "expired") return { ...base, status: "expired" };
  if (status === "failed" || status === "cancelled" || status === "canceled") return { ...base, status: "failed" };
  if (status !== "paid" && paidOverride === undefined) return { ...base, status: "pending" };

  // Paid. Only SAM-reported numbers count: an explicit paid figure first, SAM's
  // own invoiced figure second (what the transfer was quoted as). Never our own
  // expectation of the invoice.
  const currency = (invoice.currency ?? "").toUpperCase();
  const invoiced = parseScaled(invoice.amount, 2);
  const reportedPaid = parseScaled(paidOverride, 2) ?? parseScaled(invoice.paidAmount, 2);
  const paid = reportedPaid !== null && reportedPaid > 0n ? reportedPaid : invoiced;

  // Paid but with nothing to size it against, or in a currency we cannot convert:
  // the money may be there, so it is not failed, but it must wait for a person.
  if (paid === null || paid <= 0n || (currency !== "USD" && currency !== "SYP")) {
    return { ...base, status: "partial" };
  }

  let amountCents: number;
  if (currency === "USD") {
    amountCents = Number(paid);
  } else {
    if (!sypPerUsd) throw new AdapterError(ID, "SAM_SYP_PER_USD is required to size a SYP invoice");
    // `paid` is pounds x 100; the result is US cents at the configured rate.
    amountCents = Math.round(Number(paid) / sypPerUsd);
  }

  const short = invoiced !== null && invoiced > 0n && paid < invoiced;
  const result: PaymentStatus = short ? "partial" : "paid";
  return { ...base, status: result, amountCents };
}

interface LinkedWallet {
  provider: SamMethod;
  identifier: string | null;
  candidates: string[];
  status: string | null;
}

function normalizeProvider(value: unknown): SamMethod {
  // SAM treats shamcash as the default bucket; only syriatel is distinguished.
  return typeof value === "string" && value.trim().toLowerCase() === "syriatel" ? "syriatel" : "shamcash";
}

function toLinkedWallet(raw: Record<string, unknown>): LinkedWallet {
  const provider = normalizeProvider(raw.provider);
  // ShamCash is addressed by its 32-character wallet address, Syriatel by phone or
  // cash code; the wrong field earns INVALID_IDENTIFIER at invoice time.
  const ordered =
    provider === "syriatel"
      ? [raw.phone, raw.cashCode, raw.walletAddress, raw.id]
      : [raw.walletAddress, raw.accountNumber, raw.phone, raw.id];
  const identifier = ordered.map(text).find((v): v is string => v !== null) ?? null;
  const candidates = [raw.walletAddress, raw.phone, raw.cashCode, raw.accountNumber, raw.id]
    .map(text)
    .filter((v): v is string => v !== null);
  return { provider, identifier, candidates, status: text(raw.status)?.toLowerCase() ?? null };
}

/** Pick the linked wallet to invoice against. Exported for tests. */
export function resolveSamWallet(rawWallets: unknown, method: SamMethod, stored: string | undefined): string | null {
  const list = Array.isArray(rawWallets)
    ? rawWallets
    : isRecord(rawWallets) && Array.isArray(rawWallets.wallets)
      ? rawWallets.wallets
      : isRecord(rawWallets) && Array.isArray(rawWallets.data)
        ? rawWallets.data
        : null;
  if (!list) return null;
  const wallets = list.filter(isRecord).map(toLinkedWallet).filter((w) => w.provider === method);
  if (stored) {
    const needle = stored.trim().toLowerCase();
    const match = wallets.find((w) => w.candidates.some((c) => c.toLowerCase() === needle));
    return match?.identifier ?? null;
  }
  const active = wallets.find((w) => w.status === null || w.status === "active");
  return active?.identifier ?? null;
}

function readMethod(ctx: AdapterContext): SamMethod {
  const raw = (readConfig(ctx, "SAM_METHOD") ?? "shamcash").toLowerCase();
  if (raw === "shamcash") return "shamcash";
  if (raw === "syriatel" || raw === "syriatelcash") return "syriatel";
  throw new AdapterError(ID, 'SAM_METHOD must be "shamcash" or "syriatel"');
}

function readCurrency(ctx: AdapterContext): SamCurrency {
  const raw = (readConfig(ctx, "SAM_CURRENCY") ?? "USD").toUpperCase();
  if (raw === "USD" || raw === "SYP") return raw;
  throw new AdapterError(ID, 'SAM_CURRENCY must be "USD" or "SYP"');
}

/** The configured SYP rate, refusing values that look like pre-2026 (old-pound) rates. */
function readSypRate(ctx: AdapterContext): number | undefined {
  const rate = readPositiveNumber(ctx, ID, "SAM_SYP_PER_USD");
  if (rate === undefined) return undefined;
  const max = readPositiveNumber(ctx, ID, "SAM_SYP_MAX_RATE") ?? DEFAULT_SYP_MAX_RATE;
  if (rate > max) {
    throw new AdapterError(
      ID,
      `SAM_SYP_PER_USD (${rate}) is above SAM_SYP_MAX_RATE (${max}). Rates are in new pounds since the ` +
        "1 Jan 2026 redenomination (two zeros removed); check the value.",
    );
  }
  return rate;
}

// ---------------------------------------------------------------- adapter

export function createSam(ctx: AdapterContext): SamAdapter {
  const baseUrl = (): string => trimSlash(readConfig(ctx, "SAM_BASE_URL") ?? SAM_DEFAULT_BASE_URL);
  const apiKey = (): string => requireConfig(ctx, ID, "SAM_API_KEY");

  /** SAM's own hosted page, which is not under the /api prefix. */
  const payPageUrl = (invoiceId: string): string =>
    `${baseUrl().replace(/\/api$/, "")}/pay/${encodeURIComponent(invoiceId)}`;

  function fail(res: HttpResult, what: string): never {
    const body = isRecord(res.json) ? res.json : {};
    const code = typeof body.code === "string" ? body.code.trim().toUpperCase() : "";
    const message = redact(providerMessage(res.json) ?? `HTTP ${res.status}`, [
      readConfig(ctx, "SAM_API_KEY"),
      readConfig(ctx, "SAM_WEBHOOK_SECRET"),
    ]);
    const retryable =
      retryableStatus(res.status) || code === "PROVIDER_ERROR" || code === "WALLET_UPSTREAM_ERROR";
    throw new AdapterError(ID, `${what} failed (HTTP ${res.status}${code ? ` ${code}` : ""}): ${message}`, retryable);
  }

  async function get(path: string, what: string, tolerate: number[] = []): Promise<HttpResult> {
    // Reads are retried; writes never are (SAM has no idempotency contract).
    return withRetry(READ_ATTEMPTS, READ_BACKOFF_MS, async () => {
      const res = await httpJson(ctx, ID, `${baseUrl()}${path}`, {
        method: "GET",
        headers: { Authorization: `Bearer ${apiKey()}` },
      });
      if (!res.ok && !tolerate.includes(res.status)) fail(res, what);
      return res;
    });
  }

  async function getInvoice(invoiceId: string): Promise<SamInvoice> {
    const res = await get(`/pay/${encodeURIComponent(invoiceId)}`, "GET /pay/{id}", [410]);
    if (res.status === 410) {
      // SAM's way of saying the 15-minute invoice is gone.
      return {
        invoiceId,
        status: "expired",
        amount: null,
        paidAmount: null,
        currency: null,
        method: null,
        paidAt: null,
        expiresAt: null,
        transactionRef: null,
      };
    }
    if (!isRecord(res.json)) throw new AdapterError(ID, "SAM returned an unreadable invoice status", true);
    const j = res.json;
    return {
      invoiceId,
      status: text(j.status)?.toLowerCase() ?? "pending",
      amount: j.amount ?? null,
      paidAmount: j.paidAmount ?? j.paid_amount ?? null,
      currency: text(j.currency)?.toUpperCase() ?? null,
      method: text(j.method),
      paidAt: text(j.paidAt),
      expiresAt: text(j.expiresAt),
      transactionRef: text(j.transactionRef),
    };
  }

  /** The SYP rate, read only when a paid SYP invoice has to be sized. */
  function rateFor(invoice: SamInvoice, paid: boolean): number | undefined {
    return paid && invoice.currency === "SYP" ? readSypRate(ctx) : undefined;
  }

  async function checkPayment(providerRef: string): Promise<PaymentEvent> {
    const invoiceId = providerRef.trim();
    if (!invoiceId) throw new AdapterError(ID, "empty invoice id");
    const invoice = await getInvoice(invoiceId);
    return samInvoiceToEvent(invoice, rateFor(invoice, invoice.status === "paid"));
  }

  async function createPayment(input: CreatePaymentInput): Promise<CreatedPayment> {
    assertCents(input.amountCents);
    if (input.amountCents <= 0) throw new AdapterError(ID, "amount must be positive");
    const key = apiKey();
    const secret = requireConfig(ctx, ID, "SAM_WEBHOOK_SECRET");
    const method = readMethod(ctx);
    const currency = readCurrency(ctx);
    const amount = samChargeAmount(input.amountCents, currency, currency === "SYP" ? readSypRate(ctx) : undefined);

    // Without a callback SAM cannot report the payment; the old store refused to
    // open an invoice in that case, and so does this one.
    const callbackBase = input.callbackUrl ?? readConfig(ctx, "SAM_WEBHOOK_URL");
    if (!callbackBase) throw new AdapterError(ID, "no callback URL (pass callbackUrl or set SAM_WEBHOOK_URL)");
    let webhook: URL;
    try {
      webhook = new URL(callbackBase);
    } catch {
      throw new AdapterError(ID, "callback URL is not a valid URL");
    }
    webhook.searchParams.set("token", secret);
    webhook.searchParams.set("pid", input.paymentId);

    // SAM wants the identifier in the shape its own records use; resolving against
    // the linked wallets also fails early, before an invoice exists, when the
    // wallet is not linked at all.
    const wallets = await get("/v1/wallets", "GET /v1/wallets");
    const identifier = resolveSamWallet(wallets.json, method, readConfig(ctx, "SAM_WALLET"));
    if (!identifier) {
      throw new AdapterError(
        ID,
        readConfig(ctx, "SAM_WALLET")
          ? `SAM_WALLET is not a ${method} wallet linked to this SAM account`
          : `no active ${method} wallet is linked to this SAM account`,
      );
    }

    const res = await httpJson(ctx, ID, `${baseUrl()}/v1/invoices`, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}` },
      body: { method, identifier, amount, currency, webhookUrl: webhook.toString() },
    });
    if (!res.ok) fail(res, "POST /v1/invoices");
    const body = isRecord(res.json) ? res.json : {};
    const invoiceId = text(body.invoiceId) ?? text(body.id);
    if (!invoiceId) throw new AdapterError(ID, "SAM returned an invoice without an id");
    let url = text(body.paymentUrl) ?? text(body.url) ?? payPageUrl(invoiceId);
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== "https:" && parsed.protocol !== "http:") url = payPageUrl(invoiceId);
    } catch {
      url = payPageUrl(invoiceId);
    }
    const created: CreatedPayment = { providerRef: invoiceId, action: { type: "redirect", url } };
    const expiresAt = text(body.expiresAt);
    if (expiresAt) created.expiresAt = expiresAt;
    return created;
  }

  async function verifyWebhook(req: Request): Promise<PaymentEvent | null> {
    if (req.method.toUpperCase() !== "POST") return null;
    const secret = requireConfig(ctx, ID, "SAM_WEBHOOK_SECRET");
    let url: URL;
    try {
      url = new URL(req.url);
    } catch {
      return null;
    }
    // The token check is the only gate on this endpoint and runs before anything else.
    const token = url.searchParams.get("token")?.trim() ?? "";
    if (token.length === 0 || !(await secretsMatch(token, secret))) return null;

    let body: unknown;
    try {
      body = JSON.parse(await req.text());
    } catch {
      return null;
    }
    if (!isRecord(body)) return null;
    const event = text(body.event)?.toLowerCase();
    const invoiceId = text(body.invoiceId) ?? text(body.invoice_id);
    if (!invoiceId || (event !== "invoice.paid" && event !== "invoice.expired")) return null;

    // The payload is evidence, never an instruction: report what SAM itself says.
    // A failed lookup throws (retryable), so the caller answers 5xx and SAM retries.
    const upstream = await checkPayment(invoiceId);
    const paymentId = url.searchParams.get("pid")?.trim();
    return paymentId ? { ...upstream, paymentId } : upstream;
  }

  async function verifyReference(invoiceId: string, transactionRef: string): Promise<SamReferenceResult> {
    const id = invoiceId.trim();
    const ref = transactionRef.trim();
    if (!id) throw new AdapterError(ID, "empty invoice id");
    if (ref.length === 0 || ref.length > 200) {
      return { verified: false, message: "invalid transaction reference", event: await checkPayment(id) };
    }
    // Not retried: a second "yes" would be indistinguishable from the first.
    const res = await httpJson(ctx, ID, `${baseUrl()}/pay/${encodeURIComponent(id)}/verify`, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey()}` },
      body: { transactionRef: ref },
    });
    if (res.status === 410) {
      return { verified: false, message: "invoice expired", event: { providerRef: id, status: "expired" } };
    }
    if (!res.ok) fail(res, "POST /pay/{id}/verify");
    const body = isRecord(res.json) ? res.json : {};
    const verified = body.verified === true;
    const message = text(body.message);
    const invoice = await getInvoice(id);
    const rate = rateFor(invoice, verified || invoice.status === "paid");
    // A verified reference counts as SAM confirming the transfer, but the amount
    // rules still apply to SAM's own figures (verify's paid figure first).
    const event = verified
      ? samInvoiceToEvent(invoice, rate, body.paidAmount ?? body.amount ?? invoice.paidAmount ?? invoice.amount)
      : samInvoiceToEvent(invoice, rate);
    return { verified, message, event };
  }

  return { id: ID, createPayment, verifyWebhook, checkPayment, verifyReference };
}
