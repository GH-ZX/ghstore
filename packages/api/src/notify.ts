/**
 * Telegram notifications from app.outbox. Short, bilingual templates; the user's
 * language decides. Sent by the scheduled job, never inside a money transaction.
 */
import { formatUsd } from "@store/core";
import type { ApiEnv, Services } from "./context";
import { n } from "./db";

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
  staff_alert: {
    ar: (d) => `تنبيه: ${String(d.text ?? "")}`,
    en: (d) => `Alert: ${String(d.text ?? "")}`,
  },
};

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
  for (const r of rows) {
    const text = renderTemplate(r.template, r.locale ?? "ar", r.data ?? {});
    const isStaff = r.template === "staff_alert";
    if (!text || !r.chat_id || (!r.notify && !isStaff)) {
      await svc.db.query(`update app.outbox set status = 'sent', sent_at = now(), last_error = 'skipped' where id = $1`, [r.id]);
      continue;
    }
    try {
      // "Buy again" opens the product itself; everything else opens the store.
      const slug = r.template === "buy_again" && typeof r.data?.slug === "string" && /^[a-z0-9-]{1,80}$/.test(r.data.slug) ? r.data.slug : null;
      const label = slug ? (r.locale === "en" ? "Buy again" : "اطلبه مجدداً") : r.locale === "en" ? "Open store" : "افتح المتجر";
      const url = slug ? `${env.PUBLIC_BASE_URL}/tg?startapp=p_${slug}` : `${env.PUBLIC_BASE_URL}/tg`;
      await svc.telegram("sendMessage", { chat_id: r.chat_id, text, reply_markup: { inline_keyboard: [[{ text: label, web_app: { url } }]] } });
      await svc.db.query(`update app.outbox set status = 'sent', sent_at = now() where id = $1`, [r.id]);
      sent++;
    } catch (err) {
      const msg = err instanceof Error ? err.message.slice(0, 300) : "error";
      await svc.db.query(`update app.outbox set status = case when attempts >= 5 then 'failed' else 'pending' end, last_error = $2 where id = $1`, [r.id, msg]);
    }
  }
  return sent;
}

/** Queue an alert for every owner (supplier balance low, stuck orders...). */
export async function alertOwners(svc: Services, text: string): Promise<void> {
  await svc.db.query(
    `insert into app.outbox (user_id, template, data)
     select id, 'staff_alert', jsonb_build_object('text', $1::text) from app.users where role = 'owner' and status = 'active'`,
    [text.slice(0, 500)],
  );
}
