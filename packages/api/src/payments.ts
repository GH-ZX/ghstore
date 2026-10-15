/**
 * Wallet top-ups.
 *
 * Rule: a callback from a provider is only a wake-up call. Before crediting we
 * always ask the provider again (checkPayment) and credit what IT reports,
 * through app.credit_payment, which is idempotent per payment.
 */
import type { PaymentEvent, PaymentMethod } from "@store/core";
import { requireUser } from "./auth";
import type { ApiEnv, Ctx, Services } from "./context";
import { call, isUniqueViolation, n, one } from "./db";
import { ApiError, int, json, readJson, str, uuid } from "./http";

const ALL_METHODS: PaymentMethod[] = ["sam", "nowpayments", "bep20", "stars"];
/** Note on a manual USDT top-up whose submitted hash did not match; the customer may paste another. */
const MISMATCH_NOTE = "transfer did not match";

export const MIN_TOPUP_CENTS = 100;
export const MAX_TOPUP_CENTS = 100_000;

export function enabledMethods(env: ApiEnv): PaymentMethod[] {
  const list = (env.PAYMENT_METHODS ?? "sam,nowpayments,bep20,stars").split(",").map((s) => s.trim());
  return ALL_METHODS.filter((m) => list.includes(m));
}

export async function listMethods(ctx: Ctx): Promise<Response> {
  return json({ methods: enabledMethods(ctx.env), minCents: MIN_TOPUP_CENTS, maxCents: MAX_TOPUP_CENTS });
}

export async function createTopup(ctx: Ctx): Promise<Response> {
  const user = await requireUser(ctx);
  const body = await readJson(ctx.req);
  const method = str(body, "method", { max: 20 }) as PaymentMethod;
  if (!enabledMethods(ctx.env).includes(method)) throw new ApiError("payment_method_unavailable");
  if (method === "stars" && user.channel !== "miniapp") throw new ApiError("payment_method_unavailable");
  const amountCents = int(body, "amountCents", MIN_TOPUP_CENTS, MAX_TOPUP_CENTS);
  const adapter = ctx.svc.payment(method);
  if (!adapter) throw new ApiError("payment_method_unavailable");

  // Limit open top-ups per user so nobody floods the providers.
  const open = await one<{ c: string | number }>(
    ctx.svc.db,
    `select count(*) as c from app.payments where user_id = $1 and status in ('created','pending','review') and created_at > now() - interval '1 day'`,
    [user.id],
  );
  if (n(open?.c) >= 5) throw new ApiError("rate_limited");

  const channel = user.channel === "miniapp" ? "miniapp" : "web";
  let payment: { id: string; amount_cents: string | number } | undefined;
  // Manual USDT gets a unique amount (requested + 1..99 cents) among open requests,
  // enforced by a unique index. A transfer is then matched by its exact amount and
  // time, so nobody can claim another customer's public transaction hash.
  for (let attempt = 0; attempt < 8 && !payment; attempt++) {
    const amount = method === "bep20" ? amountCents + 1 + Math.floor(Math.random() * 99) : amountCents;
    try {
      payment = await one(
        ctx.svc.db,
        `insert into app.payments (user_id, method, amount_cents, channel) values ($1, $2, $3, $4) returning id, amount_cents`,
        [user.id, method, amount, channel],
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
    description: `Wallet top-up`,
    callbackUrl: `${base}/api/webhooks/payments/${method}`,
    returnUrl: `${base}/wallet?payment=${payment.id}`,
  });
  await ctx.svc.db.query(`update app.payments set status = 'pending', provider_ref = $2, action = $3::text::jsonb where id = $1`, [
    payment.id, created.providerRef, JSON.stringify(created.action),
  ]);
  return json({ paymentId: payment.id, amountCents: payAmount, action: created.action, expiresAt: created.expiresAt ?? null }, { status: 201 });
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

export async function getTopup(ctx: Ctx): Promise<Response> {
  const user = await requireUser(ctx);
  const id = uuid(ctx.params.id);
  const p = await one<{ id: string; method: string; amount_cents: string | number; status: string; action: unknown; credited_cents: string | number | null; created_at: string; tx_hash: string | null; note: string | null }>(
    ctx.svc.db,
    `select id, method, amount_cents, status, action, credited_cents, created_at, tx_hash, note from app.payments where id = $1 and user_id = $2`,
    [id, user.id],
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
  });
}

export async function walletHistory(ctx: Ctx): Promise<Response> {
  const user = await requireUser(ctx);
  const kind = ctx.url.searchParams.get("kind");
  const kinds = kind === "topup" ? ["topup"] : kind === "purchase" ? ["purchase", "refund"] : ["topup", "purchase", "refund", "adjustment", "referral"];
  const balance = await one<{ balance_cents: string | number }>(ctx.svc.db, `select balance_cents from app.wallets where user_id = $1`, [user.id]);
  const rows = await ctx.svc.db.query<{ id: string | number; amount_cents: string | number; kind: string; ref_type: string; ref_id: string; created_at: string; note: string | null; method: string | null; product_ar: string | null; product_en: string | null }>(
    `select l.id, l.amount_cents, l.kind, l.ref_type, l.ref_id, l.created_at, l.note, pay.method, p.name_ar as product_ar, p.name_en as product_en
       from app.ledger l
       left join app.payments pay on l.ref_type = 'payment' and pay.id = l.ref_id
       -- Referral rewards point at the friend's order: never show what the friend bought.
       left join app.orders o on l.ref_type = 'order' and l.kind in ('purchase', 'refund') and o.id = l.ref_id
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
  const p = await one<{ id: string; method: PaymentMethod; amount_cents: string | number; status: string; provider_ref: string | null; tx_hash: string | null; created_at: string }>(
    svc.db,
    `select id, method, amount_cents, status, provider_ref, tx_hash, created_at from app.payments where id = $1`,
    [paymentId],
  );
  if (!p) return "missing";
  if (!["pending", "review", "created"].includes(p.status)) return p.status;
  const adapter = svc.payment(p.method);
  if (!adapter?.checkPayment) return p.status;
  const ref = p.method === "bep20" ? p.tx_hash : p.provider_ref;
  if (!ref) return p.status;

  let ev: PaymentEvent;
  try {
    ev = await adapter.checkPayment(ref, { amountCents: n(p.amount_cents), createdAt: new Date(p.created_at).toISOString() });
  } catch (err) {
    console.error("checkPayment failed", p.method, p.id, err instanceof Error ? err.message : String(err));
    return p.status;
  }
  return applyEvent(svc, p.id, ev);
}

async function applyEvent(svc: Services, paymentId: string, ev: PaymentEvent): Promise<string> {
  switch (ev.status) {
    case "paid": {
      if (!ev.amountCents || ev.amountCents <= 0) {
        await svc.db.query(`update app.payments set status = 'review', note = 'paid without a usable amount' where id = $1 and status <> 'paid'`, [paymentId]);
        return "review";
      }
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
export async function creditStarsPayment(
  svc: Services,
  input: { paymentId: string; chargeId: string; totalStars: number; telegramUserId: string; expectedStars: (cents: number) => number },
): Promise<"paid" | "ignored" | "review"> {
  if (!/^[0-9a-f-]{36}$/.test(input.paymentId)) return "ignored";
  const p = await one<{ id: string; amount_cents: string | number; status: string; method: string; subject: string | null }>(
    svc.db,
    `select pay.id, pay.amount_cents, pay.status, pay.method, i.subject
       from app.payments pay left join app.identities i on i.user_id = pay.user_id and i.provider = 'telegram'
      where pay.id = $1`,
    [input.paymentId],
  );
  if (!p || p.method !== "stars") return "ignored";
  if (p.status === "paid") return "paid";
  const amount = n(p.amount_cents);
  if (p.subject !== input.telegramUserId || input.totalStars < input.expectedStars(amount)) {
    await svc.db.query(`update app.payments set status = 'review', provider_ref = $2, note = 'stars amount or payer mismatch' where id = $1 and status <> 'paid'`, [p.id, input.chargeId]);
    return "review";
  }
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
