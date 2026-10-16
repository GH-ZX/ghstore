/**
 * Telegram notifications from app.outbox. Short, bilingual templates; the user's
 * language decides. Sent by the scheduled job, never inside a money transaction.
 */
import { formatUsd } from "@store/core";
import type { ApiEnv, Services } from "./context";
import { n } from "./db";
import { effectiveEnv } from "./keys";
import { botUsername } from "./settings";
import { summaryText, type DaySummary } from "./reports";

type Data = Record<string, unknown>;

const TEMPLATES: Record<string, { ar: (d: Data) => string; en: (d: Data) => string }> = {
  order_delivered: {
    ar: (d) => `تم تسليم طلبك رقم ${d.number}. افتح المتجر لرؤية التفاصيل.`,
    en: (d) => `Order #${d.number} is delivered. Open the store to see the details.`,
  },
  order_refunded: {
    ar: (d) => `تعذّر تنفيذ الطلب رقم ${d.number}، وأُعيد ${formatUsd(n(d.amount_cents))} إلى محفظتك.`,
    en: (d) => `Order #${d.number} could not be completed. ${formatUsd(n(d.amount_cents))} is back in your wallet.`,
  },
  payment_credited: {
    ar: (d) => `أُضيف ${formatUsd(n(d.amount_cents))} إلى رصيدك.`,
    en: (d) => `${formatUsd(n(d.amount_cents))} was added to your balance.`,
  },
  referral_joined: {
    ar: () => "انضم صديق إلى المتجر عن طريق رابط دعوتك 🎉\nستحصل على مكافأة في رصيدك عن طلباته المسلَّمة.",
    en: () => "A friend joined through your invite link 🎉\nYou'll get a reward in your balance for their delivered orders.",
  },
  referral_reward: {
    ar: (d) => `حصلت على مكافأة دعوة بقيمة ${formatUsd(n(d.amount_cents))}، وأُضيفت إلى رصيدك.`,
    en: (d) => `You earned a ${formatUsd(n(d.amount_cents))} referral reward. It's in your balance.`,
  },
  buy_again: {
    ar: (d) => `حان وقت التجديد؟ اشتريت ${String(d.name_ar ?? "")} (${String(d.offer_ar ?? "")}) قبل فترة.\nاطلبه مجدداً بضغطة واحدة.`,
    en: (d) => `Time to renew? You bought ${String(d.name_en ?? "")} (${String(d.offer_en ?? "")}) a while ago.\nGet it again in one tap.`,
  },
  daily_summary: {
    ar: (d) => summaryText(d as unknown as DaySummary, "ar"),
    en: (d) => summaryText(d as unknown as DaySummary, "en"),
  },
  staff_alert: {
    ar: (d) => `تنبيه: ${String(d.text ?? "")}`,
    en: (d) => `Alert: ${String(d.text ?? "")}`,
  },
  staff_order: {
    ar: (d) => `طلب جديد ${String(d.ref ?? "")}: ${String(d.name_ar ?? "")} (${String(d.offer_ar ?? "")}) — ${formatUsd(n(d.total_cents))}`,
    en: (d) => `New order ${String(d.ref ?? "")}: ${String(d.name_en ?? "")} (${String(d.offer_en ?? "")}) — ${formatUsd(n(d.total_cents))}`,
  },
};

/** Messages for the people running the store, never for customers. */
const STAFF_TEMPLATES = new Set(["staff_alert", "staff_order", "daily_summary"]);

export function renderTemplate(template: string, locale: "ar" | "en", data: Data): string | null {
  const t = TEMPLATES[template];
  return t ? t[locale](data) : null;
}

/** Send up to `limit` pending messages. Returns how many were sent. */
export async function sendOutbox(svc: Services, env: ApiEnv, limit = 25): Promise<number> {
  const rows = await svc.db.query<{ id: string | number; template: string; data: Data; locale: "ar" | "en"; notify: boolean; chat_id: string | null; attempts: number }>(
    `update app.outbox o set attempts = o.attempts + 1, available_at = now() + interval '2 minutes'
      where o.id in (select id from app.outbox where status = 'pending' and available_at <= now() order by id limit $1 for update skip locked)
     returning o.id, o.template, o.data, o.attempts,
       (select u.locale from app.users u where u.id = o.user_id) as locale,
       (select u.notify from app.users u where u.id = o.user_id) as notify,
       (select i.subject from app.identities i where i.user_id = o.user_id and i.provider = 'telegram' limit 1) as chat_id`,
    [limit],
  );
  let sent = 0;
  // Staff messages come from the separate staff-alerts bot when the owner set one.
  const staffBot = rows.some((r) => STAFF_TEMPLATES.has(r.template)) && !!(await effectiveEnv(env, svc.db)).NOTIFY_BOT_TOKEN;
  const storeBot = staffBot ? await botUsername(svc.db) : "";
  for (const r of rows) {
    const text = renderTemplate(r.template, r.locale ?? "ar", r.data ?? {});
    const isStaff = STAFF_TEMPLATES.has(r.template);
    if (!text || !r.chat_id || (!r.notify && !isStaff)) {
      await svc.db.query(`update app.outbox set status = 'sent', sent_at = now(), last_error = 'skipped' where id = $1`, [r.id]);
      continue;
    }
    try {
      // "Buy again" opens the product itself; everything else opens the store.
      const slug = r.template === "buy_again" && typeof r.data?.slug === "string" && /^[a-z0-9-]{1,80}$/.test(r.data.slug) ? r.data.slug : null;
      const label = slug ? (r.locale === "en" ? "Buy again" : "اطلبه مجدداً")
        : isStaff ? (r.locale === "en" ? "Open admin" : "افتح الإدارة")
        : r.locale === "en" ? "Open store" : "افتح المتجر";
      const url = slug ? `${env.PUBLIC_BASE_URL}/tg?startapp=p_${slug}` : isStaff ? `${env.PUBLIC_BASE_URL}/tg?startapp=admin` : `${env.PUBLIC_BASE_URL}/tg`;
      if (isStaff && staffBot) {
        // A Mini App button would sign in through the wrong bot: link to the store bot's Mini App instead.
        const link = `https://t.me/${storeBot}?startapp=admin`;
        await svc.telegram("sendMessage", { chat_id: r.chat_id, text, reply_markup: { inline_keyboard: [[{ text: label, url: link }]] } }, "staff");
      } else {
        await svc.telegram("sendMessage", { chat_id: r.chat_id, text, reply_markup: { inline_keyboard: [[{ text: label, web_app: { url } }]] } });
      }
      await svc.db.query(`update app.outbox set status = 'sent', sent_at = now() where id = $1`, [r.id]);
      sent++;
    } catch (err) {
      const msg = err instanceof Error ? err.message.slice(0, 300) : "error";
      await svc.db.query(`update app.outbox set status = case when attempts >= 5 then 'failed' else 'pending' end, last_error = $2 where id = $1`, [r.id, msg]);
    }
  }
  return sent;
}

/** Queue an alert for every owner (supplier balance low, packages paused...). */
export async function alertOwners(svc: Services, text: string): Promise<void> {
  await alertStaff(svc, text, ["owner"]);
}

/** Queue an alert for the given staff roles (order alerts go to every staff role). */
export async function alertStaff(svc: Services, text: string, roles: ("owner" | "support" | "monitor")[] = ["owner", "support", "monitor"]): Promise<void> {
  await svc.db.query(
    `insert into app.outbox (user_id, template, data)
     select id, 'staff_alert', jsonb_build_object('text', $1::text) from app.users
      where role = any(string_to_array($2::text, ',')) and status = 'active'`,
    [text.slice(0, 500), roles.join(",")],
  );
}

/** Tell all staff (owners, support, monitors) about a new order (Admin → Settings: notify.new_orders). */
export async function alertNewOrder(svc: Pick<Services, "db">, orderId: string, orderPrefix: string): Promise<void> {
  await svc.db.query(
    `insert into app.outbox (user_id, template, data)
     select u.id, 'staff_order',
            jsonb_build_object('ref', $2::text || o.number, 'name_ar', p.name_ar, 'name_en', p.name_en,
                               'offer_ar', f.name_ar, 'offer_en', f.name_en, 'total_cents', o.total_cents)
       from app.orders o
       join app.products p on p.id = o.product_id
       join app.offers f on f.id = o.offer_id
       join app.users u on u.role in ('owner', 'support', 'monitor') and u.status = 'active'
      where o.id = $1
        and (select value from app.settings where key = 'notify.new_orders') is distinct from 'false'::jsonb`,
    [orderId, orderPrefix],
  );
}
