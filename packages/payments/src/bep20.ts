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
 *   BSC_LOGS_RPC_URL         optional  An RPC that answers eth_getLogs (the default
 *                                      dataseed refuses it), for recentDeposits and the
 *                                      account's latest transfers. Tried first; the free
 *                                      public ones (BSC_LOGS_RPC_URLS) follow in turn.
 *
 * A transaction hash is public and does not identify who paid. The core must
 * block reused hashes (PaymentEvent.txHash is the lower-cased hash) and should
 * pass `notBefore` (the payment's creation time minus a little grace) so only
 * transfers made for this payment count.
 */
import {
  AdapterError,
  type AccountInfo,
  type AdapterContext,
  type Deposit,
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
/**
 * Free public RPCs that answer eth_getLogs over recent blocks, tried in turn
 * (each rate-limits busy shared addresses now and then). Their answers are only
 * hints: every matching transfer is checked on BSC_RPC_URL before it counts.
 */
export const BSC_LOGS_RPC_URLS = ["https://bsc-rpc.publicnode.com", "https://rpc-bsc.48.club", "https://bsc.rpc.blxrbdn.com"];
/** How far back the public log servers answer (~35 minutes of BSC blocks). */
const LOGS_REACH = 4500;
/** Blocks one scan reads; a scan that fell behind catches up over the next ones. */
const LOGS_STEP = 1500;

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
    logsRpcUrls: [...new Set([readConfig(ctx, "BSC_LOGS_RPC_URL"), ...BSC_LOGS_RPC_URLS].filter((u): u is string => !!u))],
  };
}

type Settings = ReturnType<typeof readSettings>;

/** Runs `scan` on each log server in turn until one answers. */
async function withLogServer<T>(s: Settings, scan: (url: string) => Promise<T>): Promise<T> {
  let last: unknown = new AdapterError(ID, "no log server", true);
  for (const url of s.logsRpcUrls) {
    try {
      return await scan(url);
    } catch (err) {
      if (!(err instanceof AdapterError && err.retryable)) throw err;
      last = err;
    }
  }
  throw last;
}

/** The last block with enough confirmations, as `url` sees it: whatever is found up to it is final. */
async function confirmedHead(ctx: AdapterContext, s: Settings, url: string): Promise<number> {
  const head = await rpc(ctx, url, "eth_blockNumber", []);
  if (typeof head !== "string" || !QUANTITY.test(head)) throw new AdapterError(ID, "RPC eth_blockNumber returned an unreadable value", true);
  return Number(BigInt(head)) - (s.minConfirmations - 1);
}

/**
 * Confirmed Transfer logs of the token to the store address after `sinceBlock`,
 * at most LOGS_STEP blocks at a time (`toBlock` is where the next scan starts)
 * and never further back than the public servers answer.
 *
 * Block heights come from BSC_RPC_URL as well: a log server claiming a later
 * head never moves the scan past the real chain, and a saved place ahead of
 * the real chain starts again from the servers' reach.
 */
export async function recentDeposits(ctx: AdapterContext, sinceBlock?: number): Promise<{ toBlock: number; deposits: Deposit[] }> {
  const s = readSettings(ctx);
  const trusted = await confirmedHead(ctx, s, s.rpcUrl);
  if (sinceBlock !== undefined && sinceBlock > trusted) sinceBlock = undefined;
  return withLogServer(s, async (url) => {
    const confirmed = Math.min(trusted, await confirmedHead(ctx, s, url));
    const oldest = confirmed - LOGS_REACH + 1;
    const from = Math.max(sinceBlock !== undefined ? sinceBlock + 1 : oldest, oldest);
    // A server lagging behind the last scan: nothing new, keep the place.
    if (from > confirmed) return { toBlock: Math.max(confirmed, sinceBlock ?? confirmed), deposits: [] };
    const to = Math.min(confirmed, from + LOGS_STEP - 1);
    return { toBlock: to, deposits: await transfersIn(ctx, s, url, from, to) };
  });
}

/** Incoming token transfers to the store address between two blocks (inclusive). */
async function transfersIn(ctx: AdapterContext, s: Settings, url: string, fromBlock: number, toBlock: number): Promise<Deposit[]> {
  const logs = await rpc(ctx, url, "eth_getLogs", [{
    fromBlock: `0x${fromBlock.toString(16)}`,
    toBlock: `0x${toBlock.toString(16)}`,
    address: s.token,
    topics: [TRANSFER_TOPIC, null, addressTopic(s.address)],
  }]);
  const deposits: Deposit[] = [];
  const unit = 10n ** BigInt(Math.max(0, s.decimals - 2));
  for (const log of Array.isArray(logs) ? logs : []) {
    if (!isRecord(log) || log.removed === true) continue;
    const topics = Array.isArray(log.topics) ? log.topics : [];
    const hash = typeof log.transactionHash === "string" ? log.transactionHash.toLowerCase() : "";
    if (!TX_HASH.test(hash) || typeof log.data !== "string" || !WORD.test(log.data) || typeof log.blockNumber !== "string" || !QUANTITY.test(log.blockNumber)) continue;
    if (typeof log.address !== "string" || log.address.toLowerCase() !== s.token) continue;
    const units = BigInt(log.data);
    const cents = Number(unitsToCents(units, s.decimals));
    if (cents <= 0 || !Number.isSafeInteger(cents)) continue;
    const from = typeof topics[1] === "string" && WORD.test(topics[1]) ? `0x${topics[1].slice(-40).toLowerCase()}` : "";
    deposits.push({ txHash: hash, cents, exact: s.decimals >= 2 ? units % unit === 0n : true, blockNumber: Number(BigInt(log.blockNumber)), from });
  }
  return deposits;
}

/** The store address's USDT and BNB (gas) balances, and its latest incoming USDT. */
async function bep20AccountInfo(ctx: AdapterContext): Promise<AccountInfo> {
  const s = readSettings(ctx);
  const balanceOf = `0x70a08231${s.address.slice(2).padStart(64, "0")}`;
  const [usdt, bnb] = await Promise.all([
    rpc(ctx, s.rpcUrl, "eth_call", [{ to: s.token, data: balanceOf }, "latest"]),
    rpc(ctx, s.rpcUrl, "eth_getBalance", [s.address, "latest"]),
  ]);
  const amount = (raw: unknown, decimals: number) =>
    typeof raw === "string" && QUANTITY.test(raw) ? Number(BigInt(raw) / 10n ** BigInt(Math.max(0, decimals - 6))) / 1e6 : null;
  const balances: AccountInfo["balances"] = [];
  const u = amount(usdt, s.decimals);
  const b = amount(bnb, 18);
  if (u !== null) balances.push({ currency: "USDT", amount: u });
  if (b !== null) balances.push({ currency: "BNB", amount: b });
  const history: AccountInfo["history"] = [];
  try {
    // The latest ~35 minutes, from whichever log server answers.
    const deposits = await withLogServer(s, async (url) => {
      const confirmed = await confirmedHead(ctx, s, url);
      return transfersIn(ctx, s, url, confirmed - LOGS_REACH + 1, confirmed);
    });
    for (const d of deposits.slice(-15).reverse()) {
      history.push({ at: null, amount: d.cents / 100, currency: "USDT", text: `${d.from.slice(0, 6)}…${d.from.slice(-4)} · block ${d.blockNumber}`, direction: "in" });
    }
  } catch {
    // The logs RPC is optional: balances alone are still useful.
  }
  return {
    fields: [
      { label: "Address", value: s.displayAddress },
      { label: "Network", value: BEP20_NETWORK_LABEL },
      { label: "Confirmations needed", value: String(s.minConfirmations) },
    ],
    balances,
    history,
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
    recentDeposits: (sinceBlock) => recentDeposits(ctx, sinceBlock),
    accountInfo: () => bep20AccountInfo(ctx),
  };
}
