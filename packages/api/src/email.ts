/**
 * Email receipts through Resend (https://resend.com): order delivered, order
 * refunded and balance added, sent to a customer's linked email (Profile → Ways
 * to sign in) in their language. The owner turns them on in Admin → Settings →
 * Email receipts with a sender address on a domain verified in Resend, and the
 * RESEND_API_KEY in Admin → Settings → Keys.
 *
 * Receipts say what happened and link to the store; delivered codes stay in the
 * store, behind sign-in, and are never put in an email.
 */
import { store } from "@store/config";
import { formatUsd } from "@store/core";
import type { ApiEnv, Services } from "./context";
import { n, one, type Db } from "./db";
import { ApiError } from "./http";
import { effectiveEnv } from "./keys";
import { settingValue } from "./settings-registry";

/** Telegram templates that also go out as an email receipt. */
export const RECEIPT_TEMPLATES = new Set(["order_delivered", "order_refunded", "payment_credited"]);
/** Messages a website customer (no Telegram) gets by email instead. */
export const EMAIL_INSTEAD = new Set(["order_needs_info", "back_in_stock", "problem_reply", "review_ask", "level_up"]);

export interface EmailSettings {
  on: boolean;
  from: string | null;
  apiKey: string | null;
}

export async function emailSettings(env: ApiEnv, db: Db): Promise<EmailSettings> {
  const rows = await db.query<{ key: string; value: unknown }>(`select key, value from app.settings where key in ('email.receipts', 'email.from')`);
  const s = Object.fromEntries(rows.map((r) => [r.key, r.value]));
  const from = settingValue(s, "email.from");
  const key = (await effectiveEnv(env, db)).RESEND_API_KEY;
  return { on: settingValue(s, "email.receipts"), from, apiKey: typeof key === "string" && key ? key : null };
}

/** Ready to send: switched on, a sender address and an API key. */
export function emailReady(s: EmailSettings): s is EmailSettings & { from: string; apiKey: string } {
  return s.on && !!s.from && !!s.apiKey;
}

const esc = (v: unknown) =>
  String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

export interface EmailMessage {
  subject: string;
  text: string;
  html: string;
}

interface OrderInfo {
  number: string | number;
  product_ar: string;
  product_en: string;
  offer_ar: string;
  offer_en: string;
  quantity: number;
  total_cents: string | number;
}

/** The receipt for one outbox message, or null for messages that are not receipts. */
export async function renderReceipt(
  db: Db,
  baseUrl: string,
  userId: string,
  template: string,
  locale: "ar" | "en",
  data: Record<string, unknown>,
): Promise<EmailMessage | null> {
  if (!RECEIPT_TEMPLATES.has(template) && !EMAIL_INSTEAD.has(template)) return null;
  const ar = locale === "ar";
  const rows: [string, string][] = [];
  let subject: string;
  let lead: string;
  let link = `${baseUrl}/wallet`;
  let button = ar ? "افتح المتجر" : "Open the store";
  const slug = typeof data.slug === "string" && /^[a-z0-9-]{1,80}$/.test(data.slug) ? data.slug : null;

  if (template === "level_up") {
    subject = ar ? `🎉 وصلت إلى المستوى ${n(data.level)}` : `🎉 You reached level ${n(data.level)}`;
    lead = ar
      ? `من الآن تعود إليك ${Number(data.percent)}% من قيمة كل طلب في رصيدك في ${store.name}.`
      : `From now on ${Number(data.percent)}% of every order comes back to your ${store.name} balance.`;
    link = `${baseUrl}/profile`;
  } else if (template === "back_in_stock" || template === "review_ask") {
    if (!slug) return null;
    const name = String((ar ? data.name_ar : data.name_en) ?? "");
    if (template === "back_in_stock") {
      subject = ar ? `عاد إلى المتجر: ${name}` : `Back in stock: ${name}`;
      lead = ar ? `${name} (${String(data.offer_ar ?? "")}) متوفر الآن في ${store.name}. اطلبه قبل أن ينفد مجدداً.` : `${name} (${String(data.offer_en ?? "")}) is available again at ${store.name}. Get it before it runs out.`;
      link = `${baseUrl}/p/${slug}`;
      button = ar ? "اطلبه الآن" : "Get it now";
    } else {
      subject = ar ? `كيف كان ${name}؟` : `How was ${name}?`;
      lead = ar ? `استلمت ${name} من ${store.name}. قيّمه بضغطة واحدة، فرأيك يساعد غيرك من العملاء.` : `You received ${name} from ${store.name}. Rate it in one tap: it helps other customers.`;
      link = `${baseUrl}/p/${slug}?review=1`;
      button = ar ? "قيّمه ⭐" : "Rate it ⭐";
    }
  } else if (template === "payment_credited") {
    const amount = formatUsd(n(data.amount_cents));
    subject = ar ? `أُضيف ${amount} إلى رصيدك` : `${amount} added to your balance`;
    lead = ar ? `أُضيف ${amount} إلى رصيدك في ${store.name}.` : `${amount} was added to your ${store.name} balance.`;
    rows.push([ar ? "المبلغ" : "Amount", amount]);
  } else {
    const order = await one<OrderInfo>(
      db,
      `select o.number, p.name_ar as product_ar, p.name_en as product_en, f.name_ar as offer_ar, f.name_en as offer_en, o.quantity, o.total_cents
         from app.orders o join app.products p on p.id = o.product_id join app.offers f on f.id = o.offer_id
        where o.user_id = $1 and o.number = $2`,
      [userId, n(data.number)],
    );
    if (!order) return null;
    const num = `${store.orderPrefix}${order.number}`;
    link = `${baseUrl}/orders`;
    rows.push(
      [ar ? "الطلب" : "Order", num],
      [ar ? "المنتج" : "Product", `${ar ? order.product_ar : order.product_en} · ${ar ? order.offer_ar : order.offer_en}${order.quantity > 1 ? ` × ${order.quantity}` : ""}`],
    );
    if (typeof data.order_id === "string" && /^[0-9a-f-]{36}$/.test(data.order_id)) link = `${baseUrl}/orders/${data.order_id}`;
    if (template === "order_needs_info") {
      subject = ar ? `طلبك ${num} بحاجة إلى بياناتك` : `Order ${num} needs your details`;
      lead = ar ? "نحتاج بعض البيانات منك لنكمل طلبك. افتح الطلب وأرسلها من هناك." : "We need a few details from you to finish your order. Open the order and send them there.";
      button = ar ? "افتح الطلب" : "Open the order";
    } else if (template === "problem_reply") {
      subject = ar ? `ردّنا على مشكلتك في الطلب ${num}` : `Our answer about order ${num}`;
      lead = String(data.reply ?? "");
      button = ar ? "افتح الطلب" : "Open the order";
    } else if (template === "order_delivered") {
      subject = ar ? `تم تسليم طلبك ${num}` : `Order ${num} is delivered`;
      lead = ar ? "تم تسليم طلبك. افتح طلباتك في المتجر لرؤية التفاصيل والأكواد." : "Your order is delivered. Open your orders in the store to see the details and codes.";
      rows.push([ar ? "المدفوع" : "Paid", formatUsd(n(order.total_cents))]);
    } else {
      const amount = formatUsd(n(data.amount_cents));
      subject = ar ? `أُعيد ${amount} عن الطلب ${num}` : `${amount} refunded for order ${num}`;
      lead = ar ? `تعذّر تنفيذ طلبك، وأُعيد ${amount} إلى رصيدك.` : `We couldn't complete your order, so ${amount} is back in your balance.`;
      rows.push([ar ? "المُعاد" : "Refunded", amount]);
    }
  }

  const footer = ar ? `وصلتك هذه الرسالة لأن بريدك مرتبط بحسابك في ${store.name}.` : `You get this because your email is linked to your ${store.name} account.`;
  const text = [lead, "", ...rows.map(([k, v]) => `${k}: ${v}`), "", `${button}: ${link}`, "", footer].join("\n");
  const dir = ar ? "rtl" : "ltr";
  const html = `<!doctype html><html lang="${locale}" dir="${dir}"><body style="margin:0;padding:24px;background:#f4f4f5;font-family:-apple-system,Segoe UI,Tahoma,Arial,sans-serif;color:#18181b">
<div style="max-width:480px;margin:0 auto;background:#ffffff;border-radius:16px;padding:28px;text-align:${ar ? "right" : "left"}">
<div style="font-size:22px;font-weight:800;letter-spacing:-0.5px;margin-bottom:18px">${esc(store.mark)}</div>
<p style="font-size:16px;line-height:1.6;margin:0 0 18px">${esc(lead)}</p>
<table role="presentation" style="width:100%;border-collapse:collapse;font-size:14px;margin-bottom:22px">${rows
    .map(([k, v]) => `<tr><td style="padding:8px 0;color:#71717a;border-top:1px solid #e4e4e7">${esc(k)}</td><td style="padding:8px 0;border-top:1px solid #e4e4e7;text-align:${ar ? "left" : "right"};font-weight:600">${esc(v)}</td></tr>`)
    .join("")}</table>
<a href="${esc(link)}" style="display:inline-block;background:#18181b;color:#ffffff;text-decoration:none;padding:12px 20px;border-radius:12px;font-weight:700">${esc(button)}</a>
<p style="font-size:12px;color:#a1a1aa;margin:22px 0 0">${esc(footer)}</p>
</div></body></html>`;
  return { subject, text, html };
}

/** Send one email with Resend. `idempotencyKey` makes a retry after a timeout harmless. */
export async function sendEmail(
  svc: Pick<Services, "fetch">,
  cfg: { apiKey: string; from: string },
  to: string,
  msg: EmailMessage,
  idempotencyKey: string,
): Promise<void> {
  const res = await svc.fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { authorization: `Bearer ${cfg.apiKey}`, "content-type": "application/json", "idempotency-key": idempotencyKey },
    body: JSON.stringify({ from: cfg.from, to: [to], subject: msg.subject, text: msg.text, html: msg.html }),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { message?: string; name?: string } | null;
    // Resend's message never contains the key; keep it short.
    throw new Error(`resend ${res.status}: ${String(body?.message ?? body?.name ?? "error").slice(0, 200)}`);
  }
}

/** Admin → Settings → Email receipts → "Send me a test": a sample receipt to the owner's own linked email. */
export async function sendTestEmail(svc: Services, env: ApiEnv, userId: string, locale: "ar" | "en", typed?: string): Promise<string> {
  const cfg = await emailSettings(env, svc.db);
  if (!cfg.apiKey) throw new ApiError("bad_state", "RESEND_API_KEY");
  if (!cfg.from) throw new ApiError("bad_state", "email.from");
  // A typed address, or the owner's own linked email (an owner who signs in with Telegram has none).
  const to = typed ?? (await one<{ email: string }>(svc.db, `select email from app.identities where user_id = $1 and provider = 'supabase' and email is not null limit 1`, [userId]))?.email;
  if (!to) throw new ApiError("bad_state", "email.to");
  const msg = await renderReceipt(svc.db, env.PUBLIC_BASE_URL, userId, "payment_credited", locale, { amount_cents: 500 });
  await sendEmail(svc, { apiKey: cfg.apiKey, from: cfg.from }, to, msg!, `test-${userId}-${Date.now()}`);
  return to;
}
