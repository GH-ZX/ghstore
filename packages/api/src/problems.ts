/**
 * "Report a problem" on an order: the customer says what went wrong (it didn't
 * arrive, it doesn't work, wrong item, other) and the team sees it in Admin →
 * Orders → Problems with the order attached, answers, and the answer reaches
 * the customer (Telegram, or email for website customers). One open report per
 * order; once answered, the customer can report again.
 */
import { store } from "@store/config";
import { requireStaff, requireUser } from "./auth";
import type { Ctx } from "./context";
import { n, one, type Db } from "./db";
import { ApiError, json, readJson, uuid } from "./http";
import { alertStaff } from "./notify";

export const PROBLEM_REASONS = ["not_received", "not_working", "wrong_item", "other"] as const;
const REASON_EN: Record<string, string> = { not_received: "didn't arrive", not_working: "doesn't work", wrong_item: "wrong item", other: "other" };

export interface ProblemView {
  id: string;
  reason: string;
  message: string;
  status: "open" | "resolved";
  reply: string;
  createdAt: string;
  resolvedAt: string | null;
}

/** The latest report on an order, for its page. */
export async function orderProblem(db: Db, orderId: string): Promise<ProblemView | null> {
  const r = await one<{ id: string; reason: string; message: string; status: "open" | "resolved"; reply: string; created_at: string | Date; resolved_at: string | Date | null }>(
    db,
    `select id, reason, message, status, reply, created_at, resolved_at from app.order_problems where order_id = $1 order by created_at desc limit 1`,
    [orderId],
  );
  return r
    ? {
        id: r.id, reason: r.reason, message: r.message, status: r.status, reply: r.reply,
        createdAt: new Date(r.created_at).toISOString(), resolvedAt: r.resolved_at ? new Date(r.resolved_at).toISOString() : null,
      }
    : null;
}

/** POST /api/orders/:id/problem { reason, message } */
export async function reportProblem(ctx: Ctx): Promise<Response> {
  const user = await requireUser(ctx);
  const id = uuid(ctx.params.id);
  const body = await readJson(ctx.req);
  const reason = typeof body.reason === "string" && (PROBLEM_REASONS as readonly string[]).includes(body.reason) ? body.reason : null;
  if (!reason) throw new ApiError("invalid_input", "reason");
  const message = typeof body.message === "string" ? body.message.replace(/\r\n?/g, "\n").trim() : "";
  if (message.length > 1000) throw new ApiError("invalid_input", "message");
  if (reason === "other" && message.length < 3) throw new ApiError("invalid_input", "message");
  const order = await one<{ number: string | number; name_en: string; status: string }>(
    ctx.svc.db,
    `select o.number, p.name_en, o.status from app.orders o join app.products p on p.id = o.product_id where o.id = $1 and o.user_id = $2`,
    [id, user.id],
  );
  if (!order) throw new ApiError("not_found");
  const rows = await ctx.svc.db.query(
    `insert into app.order_problems (order_id, user_id, reason, message) values ($1, $2, $3, $4)
     on conflict (order_id) where status = 'open' do nothing returning id`,
    [id, user.id, reason, message],
  );
  if (!rows.length) throw new ApiError("bad_state", "already_reported");
  await alertStaff(
    ctx.svc,
    `Problem on order ${store.orderPrefix}${n(order.number)} (${order.name_en}): ${REASON_EN[reason]}${message ? ` — "${message.slice(0, 160)}"` : ""}. Answer it in Admin → Orders → Problems.`,
    ["owner", "support"],
  );
  return json({ problem: await orderProblem(ctx.svc.db, id) }, { status: 201 });
}

/** GET /api/admin/problems?status=open|resolved */
export async function adminProblems(ctx: Ctx): Promise<Response> {
  await requireStaff(ctx, "support");
  const s = ctx.url.searchParams.get("status");
  const rows = await ctx.svc.db.query<Record<string, unknown>>(
    `select r.id, r.reason, r.message, r.status, r.reply, r.created_at, r.resolved_at,
            o.id as order_id, o.number, o.status as order_status, o.total_cents, p.name_ar, p.name_en, f.name_ar as offer_ar, f.name_en as offer_en,
            u.display_name, u.id as user_id
       from app.order_problems r join app.orders o on o.id = r.order_id join app.products p on p.id = o.product_id
       join app.offers f on f.id = o.offer_id join app.users u on u.id = r.user_id
      where ($1::text is null or r.status = $1)
      order by (r.status = 'open') desc, r.created_at desc limit 200`,
    [s === "open" || s === "resolved" ? s : null],
  );
  return json({ problems: rows });
}

/** POST /api/admin/problems/:id/resolve { reply } — answer the customer and close the report. */
export async function resolveProblem(ctx: Ctx): Promise<Response> {
  const staff = await requireStaff(ctx, "support");
  const id = uuid(ctx.params.id);
  const body = await readJson(ctx.req);
  const reply = typeof body.reply === "string" ? body.reply.replace(/\r\n?/g, "\n").trim() : "";
  if (reply.length < 2 || reply.length > 1000) throw new ApiError("invalid_input", "reply");
  const r = await one<{ user_id: string; order_id: string; number: string | number }>(
    ctx.svc.db,
    `update app.order_problems p set status = 'resolved', reply = $2, resolved_at = now(), resolved_by = $3
       from app.orders o where p.id = $1 and p.status = 'open' and o.id = p.order_id
     returning p.user_id, p.order_id, o.number`,
    [id, reply, staff.id],
  );
  if (!r) throw new ApiError("bad_state");
  await ctx.svc.db.query(`insert into app.outbox (user_id, template, data) values ($1, 'problem_reply', $2::text::jsonb)`, [
    r.user_id,
    JSON.stringify({ order_id: r.order_id, number: n(r.number), reply }),
  ]);
  await ctx.svc.db.query(
    `insert into app.audit_log (actor_user_id, action, target_type, target_id, data) values ($1, 'problem.resolve', 'order', $2, '{}'::jsonb)`,
    [staff.id, r.order_id],
  );
  return json({ ok: true });
}

/** How many reports wait for an answer (the Problems tab's count). */
export async function openProblems(db: Db): Promise<number> {
  const r = await one<{ count: string | number }>(db, `select count(*) as count from app.order_problems where status = 'open'`);
  return n(r?.count);
}
