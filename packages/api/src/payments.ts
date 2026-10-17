/**
 * Wallet top-ups.
 *
 * Rule: a callback from a provider is only a wake-up call. Before crediting we
 * always ask the provider again (checkPayment) and credit what IT reports,
 * through app.credit_payment, which is idempotent per payment.
 */
import { AdapterError, type PaymentEvent, type PaymentMethod } from "@store/core";
import { BEP20_SEND_WINDOW_MS, starsForCents } from "@store/payments";
import { requireUser } from "./auth";
import type { ApiEnv, Ctx, Services } from "./context";
import { call, isUniqueViolation, n, one } from "./db";
import { ApiError, int, json, readJson, str, uuid } from "./http";
import { effectiveEnv } from "./keys";
import { starsPerUsd, topupLimits, topupSafety } from "./settings";

const ALL_METHODS: PaymentMethod[] = ["sam", "nowpayments", "bep20", "stars"];
/** Note on a manual USDT top-up whose submitted hash did not match; the customer may paste another. */
const MISMATCH_NOTE = "transfer did not match";


/**
 * The Worker settings a method cannot work without (see each adapter's header).
 * A method listed in PAYMENT_METHODS stays hidden until these are set, so a
 * customer is never offered a method that would fail when tapped.
 */
const REQUIRED_KEYS: Record<PaymentMethod, string[]> = {
  sam: ["SAM_API_KEY", "SAM_WEBHOOK_SECRET"],
  nowpayments: ["NOWPAYMENTS_API_KEY", "NOWPAYMENTS_IPN_SECRET"],
  bep20: ["BEP20_ADDRESS"],
  stars: ["TELEGRAM_BOT_TOKEN"],
};

export function methodConfigured(env: ApiEnv, method: PaymentMethod): boolean {
  return (REQUIRED_KEYS[method] ?? []).every((k) => typeof env[k] === "string" && (env[k] as string).trim() !== "");
}

/** Methods switched on in PAYMENT_METHODS whose keys are set. */
export function enabledMethods(env: ApiEnv): PaymentMethod[] {
  const list = (env.PAYMENT_METHODS ?? "sam,nowpayments,bep20,stars").split(",").map((s) => s.trim());
  return ALL_METHODS.filter((m) => list.includes(m) && methodConfigured(env, m));
}

/** Methods customers can use now: switched on and configured in the Worker, and Stars only while the admin has a rate set. */
export async function availableMethods(env: ApiEnv, svc: Pick<Services, "db">): Promise<PaymentMethod[]> {
  // Keys can also be set in Admin → Settings → Keys.
  const methods = enabledMethods(await effectiveEnv(env, svc.db));
  if (!methods.includes("stars")) return methods;
  return (await starsPerUsd(svc.db)) === null ? methods.filter((m) => m !== "stars") : methods;
}

export async function listMethods(ctx: Ctx): Promise<Response> {
  return json({ methods: await availableMethods(ctx.env, ctx.svc), ...(await topupLimits(ctx.svc.db)) });
}

export async function createTopup(ctx: Ctx): Promise<Response> {
  const user = await requireUser(ctx);
  const body = await readJson(ctx.req);
  const method = str(body, "method", { max: 20 }) as PaymentMethod;
  if (!enabledMethods(await effectiveEnv(ctx.env, ctx.svc.db)).includes(method)) throw new ApiError("payment_method_unavailable");
  if (method === "stars" && user.channel !== "miniapp") throw new ApiError("payment_method_unavailable");
  // The owner's limits (Admin → Settings → Top-ups).
  const limits = await topupLimits(ctx.svc.db);
  const amountCents = int(body, "amountCents", limits.minCents, limits.maxCents);
  // Stars: the rate is the admin's setting (Admin → Settings); none set = Stars off.
  const rate = method === "stars" ? await starsPerUsd(ctx.svc.db) : null;
  if (method === "stars" && rate === null) throw new ApiError("payment_method_unavailable");
  const adapter = rate === null ? ctx.svc.payment(method) : ctx.svc.payment(method, { STARS_PER_USD: String(rate) });
  if (!adapter) throw new ApiError("payment_method_unavailable");

  // Safer top-ups: a brand-new account starts with a smaller limit, and top-ups per hour are capped.
  const safety = await topupSafety(ctx.svc.db);
  const acct = await one<{ fresh: boolean; recent: string | number }>(
    ctx.svc.db,
    `select (u.created_at > now() - interval '1 day'
             and not exists (select 1 from app.orders o where o.user_id = u.id and o.status = 'delivered')) as fresh,
            (select count(*) from app.payments p where p.user_id = u.id and p.created_at > now() - interval '1 hour') as recent
       from app.users u where u.id = $1`,
    [user.id],
  );
  if (acct?.fresh && amountCents > safety.newAccountMaxCents) throw new ApiError("limit_new_account", String(safety.newAccountMaxCents));
  if (n(acct?.recent) >= safety.perHour) throw new ApiError("rate_limited");

  // Limit open top-ups per user so nobody floods the providers.
  const open = await one<{ c: string | number }>(
    ctx.svc.db,
    `select count(*) as c from app.payments where user_id = $1 and status in ('created','pending','review') and created_at > now() - interval '1 day'`,
    [user.id],
  );
  if (n(open?.c) >= 5) throw new ApiError("rate_limited");

  const channel = user.channel === "miniapp" ? "miniapp" : "web";
  let payment: { id: string; amount_cents: string | number; created_at: string; send_units: string | number | null } | undefined;
  // Manual USDT: the customer sends the request plus a small tag (0.0100 to
  // 0.0199), unique among open requests (unique index), and is credited the
  // request. A transfer is then matched by that exact amount and its time, so
  // nobody can claim another customer's public transaction hash.
  const free = method === "bep20" ? await freeSendUnits(ctx.svc.db, amountCents) : [null];
  for (let attempt = 0; attempt < 8 && !payment && free.length; attempt++) {
    const sendUnits = free.splice(Math.floor(Math.random() * free.length), 1)[0] ?? null;
    try {
      payment = await one(
        ctx.svc.db,
        `insert into app.payments (user_id, method, amount_cents, channel, send_units) values ($1, $2, $3, $4, $5)
         returning id, amount_cents, created_at, send_units`,
        [user.id, method, amountCents, channel, sendUnits],
      );
    } catch (err) {
      if (method !== "bep20" || !isUniqueViolation(err)) throw err;
    }
  }
  if (!payment) throw new ApiError(method === "bep20" ? "rate_limited" : "internal");
  const payAmount = n(payment.amount_cents);
  const base = ctx.env.PUBLIC_BASE_URL;
  const created = await adapter.createPayment({
    paymentId: payment.id,
    amountCents: payAmount,
    ...(payment.send_units !== null ? { sendUnits: n(payment.send_units) } : {}),
    description: `Wallet top-up`,
    callbackUrl: `${base}/api/webhooks/payments/${method}`,
    returnUrl: `${base}/wallet?payment=${payment.id}`,
  });
  // A Stars invoice keeps its price in Stars, so a later rate change never affects it.
  const action = rate !== null && created.action.type === "telegram_invoice" ? { ...created.action, stars: starsForCents(payAmount, rate) } : created.action;
  await ctx.svc.db.query(`update app.payments set status = 'pending', provider_ref = $2, action = $3::text::jsonb where id = $1`, [
    payment.id, created.providerRef, JSON.stringify(action),
  ]);
  // Every top-up: pay within the window (the countdown on the customer's screen).
  const sendBy = topupSendBy(payment.created_at);
  // Seconds left as well: the customer's clock may be off, so the countdown starts from this.
  return json(
    { paymentId: payment.id, amountCents: payAmount, action, expiresAt: created.expiresAt ?? null, sendBy, secondsLeft: Math.round(TOPUP_WINDOW_MS / 1000) },
    { status: 201 },
  );
}

/** USDT tags (ten-thousandths of a dollar above the request) a new request may take. */
const TAG_FROM = 100;
const TAG_COUNT = 100;

/** The amounts to send still free for a USDT request of `amountCents` (2.0100 to 2.0199 for $2). */
async function freeSendUnits(db: Services["db"], amountCents: number): Promise<number[]> {
  const base = amountCents * 100 + TAG_FROM;
  const used = await db.query<{ send_units: string | number }>(
    `select send_units from app.payments
      where method = 'bep20' and status in ('created', 'pending', 'review') and send_units between $1 and $2`,
    [base, base + TAG_COUNT - 1],
  );
  const taken = new Set(used.map((r) => n(r.send_units)));
  return Array.from({ length: TAG_COUNT }, (_, i) => base + i).filter((u) => !taken.has(u));
}

/** Manual BEP20: the customer pastes the transaction hash; we check the chain right away. */
export async function submitTxHash(ctx: Ctx): Promise<Response> {
  const user = await requireUser(ctx);
  const id = uuid(ctx.params.id);
  const body = await readJson(ctx.req);
  const txHash = str(body, "txHash", { min: 66, max: 66, pattern: /^0x[0-9a-fA-F]{64}$/ }).toLowerCase();
  await call(ctx.svc.db, `select app.submit_tx_hash($1, $2, $3)`, [id, user.id, txHash]);
  const status = await settlePayment(ctx.svc, id);
  return json({ paymentId: id, status });
}

/** Every top-up is paid within this long of the request (the customer sees a countdown). */
export const TOPUP_WINDOW_MS = BEP20_SEND_WINDOW_MS;
/** Notes on top-ups the store closed (cancelled, or the window ran out): a late provider confirmation still credits them. */
export const CLOSED_NOTES = ["cancelled by the customer", "send window closed"] as const;

/** The end of a top-up's payment window. */
function topupSendBy(createdAt: string | Date): string {
  return new Date(new Date(createdAt).getTime() + TOPUP_WINDOW_MS).toISOString();
}

export async function getTopup(ctx: Ctx): Promise<Response> {
  const user = await requireUser(ctx);
  const id = uuid(ctx.params.id);
  const p = await one<{ id: string; method: string; amount_cents: string | number; status: string; action: unknown; credited_cents: string | number | null; created_at: string; tx_hash: string | null; note: string | null; left_s: string | number }>(
    ctx.svc.db,
    `select id, method, amount_cents, status, action, credited_cents, created_at, tx_hash, note,
            greatest(0, ceil(extract(epoch from created_at - now()) + $3))::int as left_s
       from app.payments where id = $1 and user_id = $2`,
    [id, user.id, TOPUP_WINDOW_MS / 1000],
  );
  if (!p) throw new ApiError("not_found");
  // Manual USDT: where the customer is in the flow, so the app can resume it.
  let stage: "await_hash" | "checking" | "mismatch" | null = null;
  if (p.method === "bep20") {
    if (p.status === "created" || p.status === "pending") stage = "await_hash";
    else if (p.status === "review" && p.tx_hash && p.note === null) stage = "checking";
    else if (p.status === "review" && p.note === MISMATCH_NOTE) stage = "mismatch";
  }
  return json({
    id: p.id, method: p.method, amountCents: n(p.amount_cents), status: p.status, action: p.action,
    creditedCents: p.credited_cents === null ? null : n(p.credited_cents), createdAt: p.created_at,
    txHash: p.method === "bep20" ? p.tx_hash : null, stage,
    sendBy: topupSendBy(p.created_at),
    secondsLeft: ["created", "pending"].includes(p.status) ? n(p.left_s) : 0,
  });
}

/**
 * POST /api/topups/:id/cancel — the customer drops a top-up they have not paid
 * (USDT: no hash given yet). A USDT amount is free again for other requests;
 * a provider that still confirms a payment for it later is credited anyway.
 */
export async function cancelTopup(ctx: Ctx): Promise<Response> {
  const user = await requireUser(ctx);
  const id = uuid(ctx.params.id);
  const rows = await ctx.svc.db.query<{ id: string }>(
    `update app.payments set status = 'expired', note = $3
      where id = $1 and user_id = $2 and status in ('created', 'pending') and (method <> 'bep20' or tx_hash is null)
      returning id`,
    [id, user.id, CLOSED_NOTES[0]],
  );
  if (!rows.length) throw new ApiError("bad_state");
  return json({ paymentId: id, status: "expired" });
}

/**
 * When unpaid top-ups close. A USDT request with no transfer found gets half an
 * hour after its 15 minutes to paste the hash of a transfer made in time; the
 * others close just after their window (a late confirmation still credits them).
 */
export const USDT_CLOSE_AFTER = "45 minutes";
export const TOPUP_CLOSE_AFTER = "17 minutes";

export async function walletHistory(ctx: Ctx): Promise<Response> {
  const user = await requireUser(ctx);
  const kind = ctx.url.searchParams.get("kind");
  const kinds = kind === "topup" ? ["topup"] : kind === "purchase" ? ["purchase", "refund"] : ["topup", "purchase", "refund", "adjustment", "referral", "cashback"];
  const balance = await one<{ balance_cents: string | number }>(ctx.svc.db, `select balance_cents from app.wallets where user_id = $1`, [user.id]);
  const rows = await ctx.svc.db.query<{ id: string | number; amount_cents: string | number; kind: string; ref_type: string; ref_id: string; created_at: string; note: string | null; method: string | null; product_ar: string | null; product_en: string | null }>(
    `select l.id, l.amount_cents, l.kind, l.ref_type, l.ref_id, l.created_at, l.note, pay.method, p.name_ar as product_ar, p.name_en as product_en
       from app.ledger l
       left join app.payments pay on l.ref_type = 'payment' and pay.id = l.ref_id
       -- Referral rewards point at the friend's order: never show what the friend bought.
       left join app.orders o on l.ref_type = 'order' and l.kind in ('purchase', 'refund', 'cashback') and o.id = l.ref_id
       left join app.products p on p.id = o.product_id
      where l.user_id = $1 and l.kind = any(string_to_array($2::text, ','))
      order by l.id desc limit 50`,
    [user.id, kinds.join(",")],
  );
  const pending = await ctx.svc.db.query<{ id: string; method: string; amount_cents: string | number; status: string; created_at: string }>(
    `select id, method, amount_cents, status, created_at from app.payments
      where user_id = $1 and status in ('pending','review') order by created_at desc limit 10`,
    [user.id],
  );
  return json({
    balanceCents: n(balance?.balance_cents),
    entries: rows.map((r) => ({
      id: String(r.id), amountCents: n(r.amount_cents), kind: r.kind, createdAt: r.created_at,
      method: r.method, productAr: r.product_ar, productEn: r.product_en, note: r.kind === "adjustment" ? r.note : null,
    })),
    pending: pending.map((p) => ({ id: p.id, method: p.method, amountCents: n(p.amount_cents), status: p.status, createdAt: p.created_at })),
  });
}

/**
 * Ask the provider about a payment and record the answer. Credits only when the
 * provider itself says "paid". Returns the payment's status afterwards.
 */
export async function settlePayment(svc: Services, paymentId: string): Promise<string> {
  const p = await one<{ id: string; method: PaymentMethod; amount_cents: string | number; status: string; provider_ref: string | null; tx_hash: string | null; created_at: string; note: string | null; send_units: string | number | null }>(
    svc.db,
    `select id, method, amount_cents, status, provider_ref, tx_hash, created_at, note, send_units from app.payments where id = $1`,
    [paymentId],
  );
  if (!p) return "missing";
  // A provider top-up the store closed (cancelled, window ran out) is still checked: money may have arrived.
  const closedByUs = p.status === "expired" && p.method !== "bep20" && (CLOSED_NOTES as readonly string[]).includes(p.note ?? "");
  if (!["pending", "review", "created"].includes(p.status) && !closedByUs) return p.status;
  const adapter = svc.payment(p.method);
  if (!adapter?.checkPayment) return p.status;
  const ref = p.method === "bep20" ? p.tx_hash : p.provider_ref;
  if (!ref) return p.status;

  let ev: PaymentEvent;
  try {
    ev = await adapter.checkPayment(ref, {
      amountCents: n(p.amount_cents),
      createdAt: new Date(p.created_at).toISOString(),
      ...(p.send_units !== null ? { sendUnits: n(p.send_units) } : {}),
    });
  } catch (err) {
    console.error("checkPayment failed", p.method, p.id, err instanceof Error ? err.message : String(err));
    return p.status;
  }
  return applyEvent(svc, p.id, ev);
}

/**
 * The provider confirmed a payment for a top-up the store had closed (the
 * customer paid at the last moment, or after cancelling): the money arrived, so
 * open it again to be credited. Manual USDT never comes here closed.
 */
async function reopenIfClosedByUs(svc: Services, paymentId: string): Promise<void> {
  await svc.db.query(
    `update app.payments set status = 'pending', note = 'paid after it closed'
      where id = $1 and status = 'expired' and method <> 'bep20' and note = any($2::text[])`,
    [paymentId, CLOSED_NOTES],
  );
}

async function applyEvent(svc: Services, paymentId: string, ev: PaymentEvent): Promise<string> {
  switch (ev.status) {
    case "paid": {
      if (!ev.amountCents || ev.amountCents <= 0) {
        await svc.db.query(`update app.payments set status = 'review', note = 'paid without a usable amount' where id = $1 and status <> 'paid'`, [paymentId]);
        return "review";
      }
      await reopenIfClosedByUs(svc, paymentId);
      await call(svc.db, `select * from app.credit_payment($1, $2, $3, $4)`, [paymentId, ev.amountCents, ev.providerRef ?? null, ev.txHash ?? null]);
      return "paid";
    }
    case "partial":
    case "review":
      await svc.db.query(`update app.payments set status = 'review', note = $2 where id = $1 and status <> 'paid'`, [
        paymentId, ev.status === "partial" ? `partial: ${ev.amountCents ?? "unknown"} cents received` : "needs review",
      ]);
      return "review";
    case "failed":
    case "expired":
      await svc.db.query(`update app.payments set status = $2 where id = $1 and status in ('created','pending')`, [paymentId, ev.status]);
      // A submitted USDT hash that does not match stays open (the customer may paste the right one),
      // but gets a note so the cron stops re-checking it and staff can see why.
      await svc.db.query(`update app.payments set note = coalesce(note, $2) where id = $1 and status = 'review'`, [paymentId, MISMATCH_NOTE]);
      return ev.status;
    case "pending":
      return "pending";
  }
}

/**
 * Telegram Stars: the bot receives `successful_payment` over its authenticated
 * webhook, so the update itself is the proof. We still check that the Stars paid
 * cover the invoice and that it is the customer's own payment.
 */
/**
 * Stars a top-up must be paid with: the price stored on its invoice, or (for an
 * invoice made before prices were stored) today's rate. Null = cannot tell.
 */
export function expectedStars(storedStars: unknown, amountCents: number, rate: number | null): number | null {
  if (typeof storedStars === "number" && Number.isSafeInteger(storedStars) && storedStars > 0) return storedStars;
  const s = typeof storedStars === "string" && /^\d+$/.test(storedStars) ? Number(storedStars) : null;
  if (s !== null && s > 0) return s;
  return rate === null ? null : starsForCents(amountCents, rate);
}

export async function creditStarsPayment(
  svc: Services,
  input: { paymentId: string; chargeId: string; totalStars: number; telegramUserId: string },
): Promise<"paid" | "ignored" | "review"> {
  if (!/^[0-9a-f-]{36}$/.test(input.paymentId)) return "ignored";
  const p = await one<{ id: string; amount_cents: string | number; status: string; method: string; subject: string | null; stars: unknown }>(
    svc.db,
    `select pay.id, pay.amount_cents, pay.status, pay.method, i.subject, pay.action->'stars' as stars
       from app.payments pay left join app.identities i on i.user_id = pay.user_id and i.provider = 'telegram'
      where pay.id = $1`,
    [input.paymentId],
  );
  if (!p || p.method !== "stars") return "ignored";
  if (p.status === "paid") return "paid";
  const amount = n(p.amount_cents);
  // The money has already left the customer: never drop it. If the amount or payer
  // does not match, a person reviews it (Admin → Top-ups).
  const expected = expectedStars(p.stars, amount, await starsPerUsd(svc.db));
  if (p.subject !== input.telegramUserId || expected === null || input.totalStars < expected) {
    await svc.db.query(`update app.payments set status = 'review', provider_ref = $2, note = 'stars amount or payer mismatch' where id = $1 and status <> 'paid'`, [p.id, input.chargeId]);
    return "review";
  }
  await reopenIfClosedByUs(svc, p.id);
  await call(svc.db, `select * from app.credit_payment($1, $2, $3, null)`, [p.id, amount, input.chargeId]);
  return "paid";
}

/** POST /api/webhooks/payments/:method — authenticate, then re-check with the provider. */
export async function paymentWebhook(ctx: Ctx): Promise<Response> {
  const method = ctx.params.method as PaymentMethod;
  if (!ALL_METHODS.includes(method)) throw new ApiError("not_found");
  const adapter = ctx.svc.payment(method);
  if (!adapter?.verifyWebhook) throw new ApiError("not_found");
  const ev = await adapter.verifyWebhook(ctx.req);
  if (!ev) throw new ApiError("unauthorized");
  const p = await one<{ id: string }>(
    ctx.svc.db,
    `select id from app.payments where method = $1 and (provider_ref = $2 or ($3::uuid is not null and id = $3::uuid))`,
    [method, ev.providerRef, ev.paymentId && /^[0-9a-f-]{36}$/.test(ev.paymentId) ? ev.paymentId : null],
  );
  if (!p) return json({ ok: true }); // Not ours (or already cleaned up): acknowledge so the provider stops retrying.
  const status = await settlePayment(ctx.svc, p.id);
  return json({ ok: true, status });
}

/** Where the USDT deposit scan stopped (app.settings, a block number). */
const SCAN_KEY = "bep20.scan_block";
/** Since when the scan's log server keeps refusing (app.settings, an ISO time), if it does. */
const SCAN_FAILING_KEY = "bep20.scan_failing_since";
/** Public log servers rate-limit now and then; only a scan failing this long is reported. */
const SCAN_FAIL_REPORT_MS = 30 * 60_000;

async function saveSetting(svc: Services, key: string, value: unknown): Promise<void> {
  await svc.db.query(
    `insert into app.settings (key, value, updated_at) values ($1, $2::text::jsonb, now())
     on conflict (key) do update set value = excluded.value, updated_at = now()`,
    [key, JSON.stringify(value)],
  );
}

/**
 * Scheduled: credit USDT top-ups without the customer pasting the hash. Every
 * open request has its own exact amount (createTopup), so a confirmed deposit
 * of exactly that amount to the store address is that customer's: it goes
 * checked on chain against that request first (amount, confirmations, sent
 * after the request was made); only then is it attached and credited, so an
 * older transfer that happens to share the amount never blocks the request.
 * Runs only while a USDT request is open; a deposit matching nothing is left
 * alone (the customer can still paste its hash; staff see it in Admin →
 * Settings → APIs).
 */
export async function detectUsdtDeposits(svc: Services): Promise<number> {
  const open = await svc.db.query<{ id: string; user_id: string; amount_cents: string | number; created_at: string; send_units: string | number | null }>(
    `select id, user_id, amount_cents, created_at, send_units from app.payments
      where method = 'bep20' and status in ('created', 'pending') and tx_hash is null and created_at > now() - interval '1 day'`,
  );
  if (!open.length) {
    // Nothing to look for: a refusing log server from before no longer counts.
    await svc.db.query(`delete from app.settings where key = $1`, [SCAN_FAILING_KEY]);
    return 0;
  }
  const adapter = svc.payment("bep20");
  if (!adapter?.recentDeposits || !adapter.checkPayment) return 0;
  const saved = await svc.db.query<{ value: unknown }>(`select value from app.settings where key = $1`, [SCAN_KEY]);
  const since = typeof saved[0]?.value === "number" ? (saved[0].value as number) : undefined;
  let scan: Awaited<ReturnType<NonNullable<typeof adapter.recentDeposits>>>;
  try {
    scan = await adapter.recentDeposits(since);
  } catch (err) {
    // A busy public log server (HTTP 429, a timeout): try again next run. The
    // customer can still paste the hash; only half an hour of failures is
    // reported (the job's error, then the owner's alert).
    if (!(err instanceof AdapterError && err.retryable)) throw err;
    const row = await svc.db.query<{ value: unknown }>(`select value from app.settings where key = $1`, [SCAN_FAILING_KEY]);
    const failingSince = typeof row[0]?.value === "string" ? Date.parse(row[0].value as string) : Number.NaN;
    if (Number.isNaN(failingSince)) {
      await saveSetting(svc, SCAN_FAILING_KEY, svc.now().toISOString());
      return 0;
    }
    if (svc.now().getTime() - failingSince < SCAN_FAIL_REPORT_MS) return 0;
    throw err;
  }
  const { toBlock, deposits } = scan;
  await svc.db.query(`delete from app.settings where key = $1`, [SCAN_FAILING_KEY]);
  let credited = 0;
  for (const d of deposits) {
    // Each request's exact amount to send (older requests: their cents).
    if (!d.exact4) continue;
    const match = open.find((p) => (p.send_units !== null ? n(p.send_units) : n(p.amount_cents) * 100) === d.amount4);
    if (!match) continue;
    let ev: PaymentEvent;
    try {
      ev = await adapter.checkPayment(d.txHash, {
        amountCents: n(match.amount_cents),
        createdAt: new Date(match.created_at).toISOString(),
        ...(match.send_units !== null ? { sendUnits: n(match.send_units) } : {}),
      });
    } catch {
      continue; // the RPC failed: the next scan does not see it again, but the customer can paste the hash
    }
    if (ev.status !== "paid") continue; // not this request's (sent before it, or a different amount)
    try {
      await call(svc.db, `select app.submit_tx_hash($1, $2, $3)`, [match.id, match.user_id, d.txHash]);
    } catch {
      continue; // already used for another request, or this one moved on
    }
    if ((await applyEvent(svc, match.id, ev)) === "paid") credited++;
  }
  await saveSetting(svc, SCAN_KEY, toBlock);
  return credited;
}
