/**
 * Manual USDT on BNB Smart Chain (BEP20): the customer sends USDT to the store's
 * own address and submits the transaction hash; the store checks it on chain.
 *
 * Ported from gh-store-dev storefront/app/.server/payments/bep20.ts, which used
 * JSON-RPC (not BscScan): eth_chainId, eth_getTransactionReceipt, eth_blockNumber
 * and eth_getBlockByNumber, decoding ERC-20 Transfer logs.
 *
 * Config keys (ctx.config):
 *   BEP20_ADDRESS            required  The store's receiving address (0x + 40 hex).
 *   BSC_RPC_URL              optional  JSON-RPC endpoint, default
 *                                      "https://bsc-dataseed-public.bnbchain.org" (the old
 *                                      code's). Never a customer-supplied URL.
 *   BEP20_TOKEN_CONTRACT     optional  Default 0x55d398326f99059ff775485246999027b3197955
 *                                      (USDT / "Binance-Peg BSC-USD" on BSC).
 *   BEP20_TOKEN_DECIMALS     optional  Default 18 (USDT on BSC has 18, unlike 6 on Ethereum).
 *   BEP20_MIN_CONFIRMATIONS  optional  Default 20 (the old code's threshold).
 *   BSC_CHAIN_ID             optional  Default 56. A different chain from the RPC is a config error.
 *   BEP20_MAX_AGE_HOURS      optional  Default 24. When no `notBefore` is given, transfers
 *                                      older than this are refused, so old public transfers
 *                                      to the store address cannot be claimed.
 *
 * A transaction hash is public and does not identify who paid. The core must
 * block reused hashes (PaymentEvent.txHash is the lower-cased hash) and should
 * pass `notBefore` (the payment's creation time minus a little grace) so only
 * transfers made for this payment count.
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
import { httpJson, isRecord, nowOf, readConfig, readInteger, requireConfig } from "./util";

const ID = "bep20";
export const BSC_USDT_CONTRACT = "0x55d398326f99059ff775485246999027b3197955";
export const BSC_DEFAULT_RPC_URL = "https://bsc-dataseed-public.bnbchain.org";
/** keccak256("Transfer(address,address,uint256)") */
export const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
export const BEP20_NETWORK_LABEL = "BSC (BEP20)";

const TX_HASH = /^0x[0-9a-f]{64}$/i;
const ADDRESS = /^0x[0-9a-f]{40}$/i;
const QUANTITY = /^0x[0-9a-f]+$/i;
const WORD = /^0x[0-9a-f]{64}$/i;
/** A block timestamp this far ahead of our clock is treated as clock skew, not a failure. */
const FUTURE_SKEW_MS = 60_000;

export type Bep20Reason =
  | "invalid_hash"
  | "not_found"
  | "reverted"
  | "no_matching_transfer"
  | "too_few_confirmations"
  | "not_canonical"
  | "too_old"
  | "clock_skew"
  | "underpaid"
  | "amount_mismatch";

export interface Bep20Verification {
  /** True only when status is "paid". */
  ok: boolean;
  status: PaymentStatus;
  reason?: Bep20Reason;
  txHash: string;
  /** USDT that reached the store address in this transaction, in US cents (rounded down). */
  receivedCents: number;
  confirmations: number;
  /** Sender addresses of the matching Transfer logs, for the record. */
  senders: string[];
  blockNumber?: number;
  blockTimestamp?: string;
  event: PaymentEvent;
}

export interface VerifyTransferOptions {
  /** Refuse transfers mined before this instant. Defaults to now minus BEP20_MAX_AGE_HOURS. */
  notBefore?: Date | string | number;
  /**
   * Require the received amount to equal `expectedCents` exactly. More than
   * expected becomes "review" (a person decides) instead of "paid".
   */
  exact?: boolean;
}

/** Transfers mined this long before the payment request still count (clock differences). */
export const NOT_BEFORE_GRACE_MS = 2 * 60_000;

interface Log {
  address?: unknown;
  topics?: unknown;
  data?: unknown;
  removed?: unknown;
}

interface Receipt {
  status?: unknown;
  transactionHash?: unknown;
  blockNumber?: unknown;
  blockHash?: unknown;
  logs?: unknown;
}

function addressTopic(address: string): string {
  return `0x${address.slice(2).toLowerCase().padStart(64, "0")}`;
}

/**
 * Sum of `token` Transfer logs to `destination` in a receipt, in token base units,
 * with the senders. Removed (re-orged) logs and malformed logs are ignored.
 */
export function sumTransfers(receipt: Receipt, token: string, destination: string): { units: bigint; senders: string[] } {
  const toTopic = addressTopic(destination);
  const tokenLower = token.toLowerCase();
  let units = 0n;
  const senders: string[] = [];
  const logs = Array.isArray(receipt.logs) ? (receipt.logs as Log[]) : [];
  for (const log of logs) {
    if (!isRecord(log) || log.removed === true) continue;
    if (typeof log.address !== "string" || log.address.toLowerCase() !== tokenLower) continue;
    const topics = Array.isArray(log.topics) ? log.topics : [];
    if (topics.length !== 3) continue;
    const [t0, t1, t2] = topics as unknown[];
    if (typeof t0 !== "string" || t0.toLowerCase() !== TRANSFER_TOPIC) continue;
    if (typeof t2 !== "string" || t2.toLowerCase() !== toTopic) continue;
    if (typeof log.data !== "string" || !WORD.test(log.data)) continue;
    units += BigInt(log.data);
    if (typeof t1 === "string" && WORD.test(t1)) senders.push(`0x${t1.slice(-40).toLowerCase()}`);
  }
  return { units, senders };
}

/** Token base units to US cents, rounding down (dust is never credited). */
export function unitsToCents(units: bigint, decimals: number): bigint {
  return decimals >= 2 ? units / 10n ** BigInt(decimals - 2) : units * 10n ** BigInt(2 - decimals);
}

function toMillis(value: Date | string | number): number {
  const ms = value instanceof Date ? value.getTime() : typeof value === "number" ? value : Date.parse(value);
  if (!Number.isFinite(ms)) throw new AdapterError(ID, "notBefore is not a valid date");
  return ms;
}

function readSettings(ctx: AdapterContext) {
  const address = requireConfig(ctx, ID, "BEP20_ADDRESS");
  if (!ADDRESS.test(address)) throw new AdapterError(ID, "BEP20_ADDRESS must be 0x followed by 40 hex characters");
  const token = readConfig(ctx, "BEP20_TOKEN_CONTRACT") ?? BSC_USDT_CONTRACT;
  if (!ADDRESS.test(token)) throw new AdapterError(ID, "BEP20_TOKEN_CONTRACT must be 0x followed by 40 hex characters");
  return {
    /** As configured (keeps an EIP-55 checksum for display); comparisons use `address`. */
    displayAddress: address,
    address: address.toLowerCase(),
    token: token.toLowerCase(),
    rpcUrl: readConfig(ctx, "BSC_RPC_URL") ?? BSC_DEFAULT_RPC_URL,
    decimals: readInteger(ctx, ID, "BEP20_TOKEN_DECIMALS", 18, 0, 36),
    minConfirmations: readInteger(ctx, ID, "BEP20_MIN_CONFIRMATIONS", 20, 1, 10_000),
    chainId: readInteger(ctx, ID, "BSC_CHAIN_ID", 56, 1, 2 ** 31),
    maxAgeHours: readInteger(ctx, ID, "BEP20_MAX_AGE_HOURS", 24, 1, 24 * 365),
  };
}

async function rpc(ctx: AdapterContext, url: string, method: string, params: unknown[]): Promise<unknown> {
  // The RPC URL may embed a provider key, so it is never quoted in errors.
  const res = await httpJson(ctx, ID, url, {
    method: "POST",
    body: { jsonrpc: "2.0", id: 1, method, params },
    timeoutMs: 10_000,
  });
  if (!res.ok) throw new AdapterError(ID, `RPC ${method} answered HTTP ${res.status}`, true);
  if (!isRecord(res.json)) throw new AdapterError(ID, `RPC ${method} returned an unreadable body`, true);
  if (res.json.error !== undefined && res.json.error !== null) {
    throw new AdapterError(ID, `RPC ${method} returned an error`, true);
  }
  return res.json.result ?? null;
}

/**
 * Check on chain that `txHash` is a successful USDT Transfer to the store address
 * for at least `expectedCents`, with enough confirmations.
 *
 * Result statuses: "paid" (all good), "partial" (good transfer, too little),
 * "pending" (not mined / not enough confirmations / re-org: ask again later),
 * "failed" (reverted, wrong token or recipient, too old, malformed hash).
 * Without `expectedCents`, a confirmed transfer of any size is "paid" and the
 * caller must compare `receivedCents` itself. RPC trouble throws a retryable
 * AdapterError; an RPC on the wrong chain throws a non-retryable one.
 */
export async function verifyTransfer(
  ctx: AdapterContext,
  txHash: string,
  expectedCents?: number,
  options: VerifyTransferOptions = {},
): Promise<Bep20Verification> {
  const settings = readSettings(ctx);
  if (expectedCents !== undefined) assertCents(expectedCents);
  const hash = txHash.trim().toLowerCase();

  const result = (
    status: PaymentStatus,
    reason: Bep20Reason | undefined,
    extra: Partial<Omit<Bep20Verification, "ok" | "status" | "reason" | "txHash" | "event">> = {},
  ): Bep20Verification => {
    const receivedCents = extra.receivedCents ?? 0;
    const event: PaymentEvent = { providerRef: hash, status, txHash: hash };
    if (receivedCents > 0 && Number.isSafeInteger(receivedCents)) event.amountCents = receivedCents;
    return {
      ok: status === "paid",
      status,
      ...(reason ? { reason } : {}),
      txHash: hash,
      receivedCents,
      confirmations: extra.confirmations ?? 0,
      senders: extra.senders ?? [],
      ...(extra.blockNumber !== undefined ? { blockNumber: extra.blockNumber } : {}),
      ...(extra.blockTimestamp !== undefined ? { blockTimestamp: extra.blockTimestamp } : {}),
      event,
    };
  };

  if (!TX_HASH.test(hash)) return result("failed", "invalid_hash");

  const [chainId, receiptRaw, latestRaw] = await Promise.all([
    rpc(ctx, settings.rpcUrl, "eth_chainId", []),
    rpc(ctx, settings.rpcUrl, "eth_getTransactionReceipt", [hash]),
    rpc(ctx, settings.rpcUrl, "eth_blockNumber", []),
  ]);
  if (typeof chainId !== "string" || !QUANTITY.test(chainId) || BigInt(chainId) !== BigInt(settings.chainId)) {
    throw new AdapterError(ID, `BSC_RPC_URL is not on chain ${settings.chainId}`);
  }
  if (typeof latestRaw !== "string" || !QUANTITY.test(latestRaw)) {
    throw new AdapterError(ID, "RPC eth_blockNumber returned an unreadable value", true);
  }
  // Not mined yet, dropped, or not a BSC transaction at all: ask again later.
  if (!isRecord(receiptRaw)) return result("pending", "not_found");
  const receipt = receiptRaw as Receipt;
  if (typeof receipt.transactionHash === "string" && receipt.transactionHash.toLowerCase() !== hash) {
    throw new AdapterError(ID, "RPC returned a receipt for a different transaction", true);
  }
  if (receipt.status !== "0x1") return result("failed", "reverted");
  if (typeof receipt.blockNumber !== "string" || !QUANTITY.test(receipt.blockNumber)) {
    return result("pending", "not_found");
  }

  const blockNumber = BigInt(receipt.blockNumber);
  const confirmations = Number(BigInt(latestRaw) - blockNumber + 1n);
  const { units, senders } = sumTransfers(receipt, settings.token, settings.address);
  const receivedCents = Number(unitsToCents(units, settings.decimals));
  const base = { confirmations: Math.max(0, confirmations), senders, blockNumber: Number(blockNumber) };

  // Wrong token, wrong recipient or dust: this hash will never pay this store.
  if (receivedCents <= 0) return result("failed", "no_matching_transfer", base);
  const withAmount = { ...base, receivedCents };
  if (confirmations < settings.minConfirmations) return result("pending", "too_few_confirmations", withAmount);

  // The receipt's block must still be the canonical one at that height.
  const block = await rpc(ctx, settings.rpcUrl, "eth_getBlockByNumber", [receipt.blockNumber, false]);
  if (
    !isRecord(block) ||
    typeof block.hash !== "string" ||
    typeof receipt.blockHash !== "string" ||
    block.hash.toLowerCase() !== receipt.blockHash.toLowerCase() ||
    typeof block.timestamp !== "string" ||
    !QUANTITY.test(block.timestamp)
  ) {
    return result("pending", "not_canonical", withAmount);
  }
  const minedAt = Number(BigInt(block.timestamp)) * 1000;
  const withTime = { ...withAmount, blockTimestamp: new Date(minedAt).toISOString() };
  const now = nowOf(ctx).getTime();
  const notBefore =
    options.notBefore !== undefined ? toMillis(options.notBefore) : now - settings.maxAgeHours * 3_600_000;
  if (minedAt < notBefore) return result("failed", "too_old", withTime);
  if (minedAt > now + FUTURE_SKEW_MS) return result("pending", "clock_skew", withTime);

  if (expectedCents !== undefined && receivedCents < expectedCents) return result("partial", "underpaid", withTime);
  if (options.exact && expectedCents !== undefined && receivedCents !== expectedCents) return result("review", "amount_mismatch", withTime);
  return result("paid", undefined, withTime);
}

export interface Bep20Adapter extends PaymentAdapter {
  readonly id: "bep20";
  createPayment(input: CreatePaymentInput): Promise<CreatedPayment>;
  /**
   * providerRef must be the customer's transaction hash. With `expected`, the
   * transfer must be for exactly that amount and mined after the request was made.
   */
  checkPayment(providerRef: string, expected?: { amountCents: number; createdAt?: string }): Promise<PaymentEvent>;
  verifyTransfer(txHash: string, expectedCents?: number, options?: VerifyTransferOptions): Promise<Bep20Verification>;
}

export function createBep20(ctx: AdapterContext): Bep20Adapter {
  async function createPayment(input: CreatePaymentInput): Promise<CreatedPayment> {
    assertCents(input.amountCents);
    if (input.amountCents <= 0) throw new AdapterError(ID, "amount must be positive");
    const { displayAddress } = readSettings(ctx);
    // No transaction exists yet: the reference is our own payment id until the
    // customer submits a hash, which the core then checks with verifyTransfer.
    return {
      providerRef: input.paymentId,
      action: {
        type: "address",
        network: BEP20_NETWORK_LABEL,
        asset: "USDT",
        address: displayAddress,
        amount: centsToDecimal(input.amountCents),
      },
    };
  }

  async function checkPayment(providerRef: string, expected?: { amountCents: number; createdAt?: string }): Promise<PaymentEvent> {
    if (!TX_HASH.test(providerRef.trim())) {
      throw new AdapterError(ID, "checkPayment needs the transaction hash the customer submitted");
    }
    if (!expected) return (await verifyTransfer(ctx, providerRef)).event;
    const created = expected.createdAt ? Date.parse(expected.createdAt) : NaN;
    const options: VerifyTransferOptions = { exact: true };
    if (Number.isFinite(created)) options.notBefore = created - NOT_BEFORE_GRACE_MS;
    return (await verifyTransfer(ctx, providerRef, expected.amountCents, options)).event;
  }

  return {
    id: ID,
    createPayment,
    checkPayment,
    verifyTransfer: (txHash, expectedCents, options) => verifyTransfer(ctx, txHash, expectedCents, options),
  };
}
