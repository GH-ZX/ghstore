import { describe, expect, it } from "vitest";
import { AdapterError } from "../../core/src/adapters";
import { BSC_USDT_CONTRACT, TRANSFER_TOPIC, createBep20, verifyTransfer } from "../src/bep20";
import { context, fakeFetch, type RecordedCall } from "./fake-fetch";

const STORE = "0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf";
const PAYER = "0x2b5ad5c4795c026514f8317c7a215e218dccd6cf";
const OTHER = "0x6813eb9362372eef6200f3b1dbc3f819671cba69";
const FAKE_TOKEN = "0x1111111111111111111111111111111111111111";
const TX = "0x" + "ab".repeat(32);
const NOW = new Date("2026-10-15T12:00:00Z");
const MINED_AT = Math.floor(NOW.getTime() / 1000) - 600; // ten minutes ago
const BLOCK = 50_000_000;
const BLOCK_HASH = "0x" + "cd".repeat(32);
const CONFIG = { BEP20_ADDRESS: STORE, BSC_RPC_URL: "https://rpc.example/bsc?key=test" };

const hex = (n: number | bigint) => "0x" + BigInt(n).toString(16);
const topic = (address: string) => "0x" + address.slice(2).toLowerCase().padStart(64, "0");
const word = (n: bigint) => "0x" + n.toString(16).padStart(64, "0");
/** USDT on BSC has 18 decimals: $1.00 = 10^18 units. */
const usdt = (cents: number) => BigInt(cents) * 10n ** 16n;

function transferLog(opts: { token?: string; to?: string; from?: string; units: bigint; removed?: boolean }) {
  return {
    address: opts.token ?? BSC_USDT_CONTRACT,
    topics: [TRANSFER_TOPIC, topic(opts.from ?? PAYER), topic(opts.to ?? STORE)],
    data: word(opts.units),
    blockNumber: hex(BLOCK),
    transactionHash: TX,
    logIndex: "0x0",
    removed: opts.removed ?? false,
  };
}

interface Chain {
  chainId?: string;
  receipt?: unknown;
  latest?: number;
  blockHash?: string;
  timestamp?: number;
}

function chain(c: Chain) {
  const receipt =
    c.receipt === undefined
      ? {
          transactionHash: TX,
          blockHash: BLOCK_HASH,
          blockNumber: hex(BLOCK),
          status: "0x1",
          logs: [transferLog({ units: usdt(1234) })],
        }
      : c.receipt;
  const fake = fakeFetch([
    [
      () => true,
      (call: RecordedCall) => {
        const req = call.body as { method: string; params: unknown[] };
        switch (req.method) {
          case "eth_chainId":
            return { json: { jsonrpc: "2.0", id: 1, result: c.chainId ?? "0x38" } };
          case "eth_blockNumber":
            return { json: { jsonrpc: "2.0", id: 1, result: hex(c.latest ?? BLOCK + 19) } };
          case "eth_getTransactionReceipt":
            return { json: { jsonrpc: "2.0", id: 1, result: receipt } };
          case "eth_getBlockByNumber":
            return {
              json: {
                jsonrpc: "2.0",
                id: 1,
                result: { number: hex(BLOCK), hash: c.blockHash ?? BLOCK_HASH, timestamp: hex(c.timestamp ?? MINED_AT) },
              },
            };
          default:
            return { status: 400, json: { error: "unknown method" } };
        }
      },
    ],
  ]);
  return { ctx: context(fake.fetch, CONFIG, NOW), calls: fake.calls };
}

function receiptWith(logs: unknown[], status = "0x1") {
  return { transactionHash: TX, blockHash: BLOCK_HASH, blockNumber: hex(BLOCK), status, logs };
}

describe("bep20: createPayment", () => {
  it("returns the store address and the USD amount as USDT", async () => {
    const { ctx, calls } = chain({});
    const created = await createBep20(ctx).createPayment({ paymentId: "p-1", amountCents: 1234, description: "x" });
    expect(created).toEqual({
      providerRef: "p-1",
      action: { type: "address", network: "BSC (BEP20)", asset: "USDT", address: STORE, amount: "12.34" },
    });
    expect(calls.length).toBe(0);
  });

  it("refuses a malformed store address", async () => {
    const ctx = context(fakeFetch([]).fetch, { BEP20_ADDRESS: "0x123" });
    await expect(createBep20(ctx).createPayment({ paymentId: "p", amountCents: 1, description: "x" })).rejects.toThrow("BEP20_ADDRESS");
  });
});

describe("bep20: verifyTransfer accepts", () => {
  it("a successful USDT transfer to the store for the expected amount with 20 confirmations", async () => {
    const { ctx, calls } = chain({});
    const result = await verifyTransfer(ctx, TX.toUpperCase().replace("0X", "0x"), 1234);
    expect(result.ok).toBe(true);
    expect(result.status).toBe("paid");
    expect(result.receivedCents).toBe(1234);
    expect(result.confirmations).toBe(20);
    expect(result.senders).toEqual([PAYER]);
    expect(result.blockTimestamp).toBe(new Date(MINED_AT * 1000).toISOString());
    expect(result.event).toEqual({ providerRef: TX, status: "paid", amountCents: 1234, txHash: TX });
    expect(calls.every((c) => c.url === CONFIG.BSC_RPC_URL && c.method === "POST")).toBe(true);
  });

  it("an overpayment, and several transfers in one transaction added together", async () => {
    const over = await verifyTransfer(chain({ receipt: receiptWith([transferLog({ units: usdt(5000) })]) }).ctx, TX, 1234);
    expect(over.status).toBe("paid");
    expect(over.receivedCents).toBe(5000);
    const split = await verifyTransfer(
      chain({ receipt: receiptWith([transferLog({ units: usdt(1000) }), transferLog({ units: usdt(234) })]) }).ctx,
      TX,
      1234,
    );
    expect(split.status).toBe("paid");
    expect(split.receivedCents).toBe(1234);
  });

  it("rounds sub-cent units down", async () => {
    const units = usdt(1234) + 9_999_999_999_999_999n; // 12.34 + 0.0099...
    const result = await verifyTransfer(chain({ receipt: receiptWith([transferLog({ units })]) }).ctx, TX, 1234);
    expect(result.receivedCents).toBe(1234);
  });

  it("via the adapter's checkPayment (providerRef = tx hash), leaving the amount comparison to the caller", async () => {
    const event = await createBep20(chain({}).ctx).checkPayment(TX);
    expect(event).toEqual({ providerRef: TX, status: "paid", amountCents: 1234, txHash: TX });
  });
});

describe("bep20: checkPayment with the payment's expected amount and time", () => {
  const madeAt = (secondsBeforeMining: number) => new Date((MINED_AT - secondsBeforeMining) * 1000).toISOString();

  it("pays a transfer of exactly the requested amount, mined after the request", async () => {
    const event = await createBep20(chain({}).ctx).checkPayment(TX, { amountCents: 1234, createdAt: madeAt(60) });
    expect(event.status).toBe("paid");
    expect(event.amountCents).toBe(1234);
  });

  it("sends a different amount to review instead of paying (someone else's transfer)", async () => {
    const more = await createBep20(chain({}).ctx).checkPayment(TX, { amountCents: 1200, createdAt: madeAt(60) });
    expect(more.status).toBe("review");
    const less = await createBep20(chain({}).ctx).checkPayment(TX, { amountCents: 1299, createdAt: madeAt(60) });
    expect(less.status).toBe("partial");
  });

  it("refuses a transfer mined before the request was made (beyond a short grace)", async () => {
    const early = await createBep20(chain({}).ctx).checkPayment(TX, { amountCents: 1234, createdAt: madeAt(-600) });
    expect(early.status).toBe("failed");
    const withinGrace = await createBep20(chain({}).ctx).checkPayment(TX, { amountCents: 1234, createdAt: madeAt(-60) });
    expect(withinGrace.status).toBe("paid");
  });
});

describe("bep20: verifyTransfer rejects", () => {
  it("a transfer of a different token (wrong contract)", async () => {
    const result = await verifyTransfer(
      chain({ receipt: receiptWith([transferLog({ token: FAKE_TOKEN, units: usdt(1234) })]) }).ctx,
      TX,
      1234,
    );
    expect(result).toMatchObject({ ok: false, status: "failed", reason: "no_matching_transfer", receivedCents: 0 });
    expect(result.event.amountCents).toBeUndefined();
  });

  it("a transfer to someone else (wrong recipient)", async () => {
    const result = await verifyTransfer(chain({ receipt: receiptWith([transferLog({ to: OTHER, units: usdt(1234) })]) }).ctx, TX, 1234);
    expect(result).toMatchObject({ ok: false, status: "failed", reason: "no_matching_transfer" });
  });

  it("too little: partial, with the amount that arrived", async () => {
    const result = await verifyTransfer(chain({ receipt: receiptWith([transferLog({ units: usdt(1233) })]) }).ctx, TX, 1234);
    expect(result).toMatchObject({ ok: false, status: "partial", reason: "underpaid", receivedCents: 1233 });
    expect(result.event).toEqual({ providerRef: TX, status: "partial", amountCents: 1233, txHash: TX });
  });

  it("a failed (reverted) transaction", async () => {
    const result = await verifyTransfer(chain({ receipt: receiptWith([transferLog({ units: usdt(1234) })], "0x0") }).ctx, TX, 1234);
    expect(result).toMatchObject({ ok: false, status: "failed", reason: "reverted" });
  });

  it("too few confirmations: pending, not failed", async () => {
    const result = await verifyTransfer(chain({ latest: BLOCK + 18 }).ctx, TX, 1234);
    expect(result).toMatchObject({ ok: false, status: "pending", reason: "too_few_confirmations", confirmations: 19, receivedCents: 1234 });
  });

  it("honours BEP20_MIN_CONFIRMATIONS", async () => {
    const { ctx } = chain({ latest: BLOCK + 2 });
    const relaxed = { ...ctx, config: { ...ctx.config, BEP20_MIN_CONFIRMATIONS: "3" } };
    expect((await verifyTransfer(relaxed, TX, 1234)).status).toBe("paid");
  });

  it("a removed (re-orged) log and dust below one cent", async () => {
    const removed = await verifyTransfer(chain({ receipt: receiptWith([transferLog({ units: usdt(1234), removed: true })]) }).ctx, TX, 1234);
    expect(removed.reason).toBe("no_matching_transfer");
    const dust = await verifyTransfer(chain({ receipt: receiptWith([transferLog({ units: 9_999_999_999_999_999n })]) }).ctx, TX, 1);
    expect(dust.reason).toBe("no_matching_transfer");
  });

  it("an unknown or not yet mined transaction: pending", async () => {
    const result = await verifyTransfer(chain({ receipt: null }).ctx, TX, 1234);
    expect(result).toMatchObject({ status: "pending", reason: "not_found" });
  });

  it("a block that is no longer canonical: pending", async () => {
    const result = await verifyTransfer(chain({ blockHash: "0x" + "ee".repeat(32) }).ctx, TX, 1234);
    expect(result).toMatchObject({ status: "pending", reason: "not_canonical" });
  });

  it("an old public transfer (older than BEP20_MAX_AGE_HOURS, or before notBefore)", async () => {
    const old = await verifyTransfer(chain({ timestamp: MINED_AT - 2 * 86_400 }).ctx, TX, 1234);
    expect(old).toMatchObject({ status: "failed", reason: "too_old" });
    const beforeCreation = await verifyTransfer(chain({}).ctx, TX, 1234, { notBefore: new Date(NOW.getTime() - 300_000) });
    expect(beforeCreation).toMatchObject({ status: "failed", reason: "too_old" });
    const afterCreation = await verifyTransfer(chain({}).ctx, TX, 1234, { notBefore: "2026-10-15T11:00:00Z" });
    expect(afterCreation.status).toBe("paid");
  });

  it("a malformed hash, without asking the chain", async () => {
    const { ctx, calls } = chain({});
    expect(await verifyTransfer(ctx, "0x1234", 1234)).toMatchObject({ status: "failed", reason: "invalid_hash" });
    expect(calls.length).toBe(0);
    await expect(createBep20(ctx).checkPayment("p-1")).rejects.toThrow("transaction hash");
  });

  it("an RPC on another chain is a configuration error; RPC trouble is retryable and never quotes the URL", async () => {
    const wrongChain = await verifyTransfer(chain({ chainId: "0x1" }).ctx, TX, 1234).catch((e: unknown) => e);
    expect(wrongChain).toBeInstanceOf(AdapterError);
    expect((wrongChain as AdapterError).retryable).toBe(false);

    const down = context(fakeFetch([[() => true, { status: 503, text: "busy" }]]).fetch, CONFIG, NOW);
    const error = await verifyTransfer(down, TX, 1234).catch((e: unknown) => e);
    expect((error as AdapterError).retryable).toBe(true);
    expect((error as Error).message).not.toContain("key=test");
  });
});
