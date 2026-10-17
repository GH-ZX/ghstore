/**
 * Telegram notifications from app.outbox. Short, bilingual templates; the user's
 * language decides. Sent by the scheduled job, never inside a money transaction.
 */
import { store } from "@store/config";
import { formatUsd } from "@store/core";
import type { ApiEnv, Services } from "./context";
import { n } from "./db";
import { EMAIL_INSTEAD, emailReady, emailSettings, RECEIPT_TEMPLATES, renderReceipt, sendEmail } from "./email";
import { effectiveEnv } from "./keys";
import { botUsername, readSettings, supportContacts } from "./settings";
import { PUSH_MAX_BROWSERS, pushToUser, vapidKeys, type Vapid } from "./push";
import { summaryText, type DaySummary } from "./reports";

type Data = Record<string, unknown>;

const TEMPLATES: Record<string, { ar: (d: Data) => string; en: (d: Data) => string }> = {
  order_delivered: {
    ar: (d) => `تم تسليم طلبك رقم ${d.number}. افتح المتجر لرؤية التفاصيل.`,
    en: (d) => `Order #${d.number} is delivered. Open the store to see the details.`,
  },
  order_needs_info: {
    ar: (d) => `طلبك رقم ${d.number} بحاجة إلى بياناتك لنكمله. افتح الطلبات وأرسلها من هناك.`,
    en: (d) => `Order #${d.number} needs your details before we can deliver it. Open Orders and send them there.`,
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
  back_in_stock: {
    ar: (d) => `عاد إلى المتجر ✅ ${String(d.name_ar ?? "")} (${String(d.offer_ar ?? "")}).\nاطلبه قبل أن ينفد مجدداً.`,
    en: (d) => `Back in stock ✅ ${String(d.name_en ?? "")} (${String(d.offer_en ?? "")}).\nGet it before it runs out again.`,
  },
  daily_summary: {
    ar: (d) => summaryText(d as unknown as DaySummary, "ar"),
    en: (d) => summaryText(d as unknown as DaySummary, "en"),
  },
  staff_alert: {
    ar: (d) => `تنبيه: ${String(d.text ?? "")}`,
    en: (d) => `Alert: ${String(d.text ?? "")}`,
  },
  broadcast: {
    ar: (d) => String(d.text_ar ?? d.text_en ?? ""),
    en: (d) => String(d.text_en ?? d.text_ar ?? ""),
  },
  level_up: {
    ar: (d) => `🎉 وصلت إلى المستوى ${d.level}! من الآن تعود إليك ${d.percent}% من قيمة كل طلب في رصيدك.`,
    en: (d) => `🎉 You reached level ${d.level}! From now on ${d.percent}% of every order comes back to your balance.`,
  },
  review_ask: {
    ar: (d) => `كيف كان ${String(d.name_ar ?? "")}؟ ⭐\nقيّمه بضغطة واحدة، فرأيك يساعد غيرك من العملاء.`,
    en: (d) => `How was ${String(d.name_en ?? "")}? ⭐\nRate it in one tap: it helps other customers.`,
  },
  problem_reply: {
    ar: (d) => `ردّ المتجر على مشكلتك في الطلب رقم ${d.number}:\n${String(d.reply ?? "")}`,
    en: (d) => `The store answered about order #${d.number}:\n${String(d.reply ?? "")}`,
  },
  staff_order: {
    ar: (d) => `طلب جديد ${String(d.ref ?? "")}: ${String(d.name_ar ?? "")} (${String(d.offer_ar ?? "")}) — ${formatUsd(n(d.total_cents))}`,
    en: (d) => `New order ${String(d.ref ?? "")}: ${String(d.name_en ?? "")} (${String(d.offer_en ?? "")}) — ${formatUsd(n(d.total_cents))}`,
  },
};

/** Telegram errors that mean this chat can never receive the bot's messages. */
const UNREACHABLE = /bot was blocked by the user|user is deactivated|chat not found|bot can't initiate conversation/i;

/** Customer messages that also go to the browsers they turned notifications on for (Profile). */
const PUSH_TEMPLATES = new Set([
  "order_delivered", "order_refunded", "payment_credited", "order_needs_info", "back_in_stock",
  "problem_reply", "review_ask", "level_up", "referral_reward",
]);

/** Where a notification opens on the website. */
function pushUrl(template: string, data: Data): string {
  const slug = typeof data.slug === "string" && /^[a-z0-9-]{1,80}$/.test(data.slug) ? data.slug : null;
  const order = typeof data.order_id === "string" && /^[0-9a-f-]{36}$/.test(data.order_id) ? data.order_id : null;
  if (template === "review_ask" && slug) return `/p/${slug}?review=1`;
  if (slug) return `/p/${slug}`;
  if (order) return `/orders/${order}`;
  if (template.startsWith("order_")) return "/orders";
  if (template === "payment_credited" || template === "level_up" || template === "referral_reward") return "/wallet";
  return "/";
}

/** Messages for the people running the store, never for customers. */
const STAFF_TEMPLATES = new Set(["staff_alert", "staff_order", "daily_summary"]);

export function renderTemplate(template: string, locale: "ar" | "en", data: Data): string | null {
  const t = TEMPLATES[template];
  return t ? t[locale](data) : null;
}

/** Browser notifications are off until the owner turns them on (Admin → Settings: push.enabled). */
export async function pushEnabled(db: Services["db"]): Promise<boolean> {
  return (await readSettings(db, ["push.enabled"]))["push.enabled"] === true;
}

/**
 * Send up to `limit` pending messages (Telegram and email). Returns how many
 * were sent. Each message needs one request, plus one per browser for a push
 * notification: the batch stops while `reserve` requests are still left for
 * the jobs after it, and what it did not reach goes back in the queue without
 * counting as an attempt.
 */
export async function sendOutbox(svc: Services, env: ApiEnv, limit = 25, reserve = 0): Promise<number> {
  const claimed = await svc.db.query<{
    id: string | number;
    user_id: string;
    channel: "telegram" | "email";
    priority: number;
    template: string;
    data: Data;
    locale: "ar" | "en";
    notify: boolean;
    chat_id: string | null;
    email: string | null;
    attempts: number;
  }>(
    `update app.outbox o set attempts = o.attempts + 1, available_at = now() + interval '2 minutes'
      where o.id in (select id from app.outbox where status = 'pending' and available_at <= now() order by priority, id limit $1 for update skip locked)
     returning o.id, o.user_id, o.channel, o.priority, o.template, o.data, o.attempts,
       (select u.locale from app.users u where u.id = o.user_id) as locale,
       (select u.notify from app.users u where u.id = o.user_id) as notify,
       (select i.subject from app.identities i where i.user_id = o.user_id and i.provider = 'telegram' limit 1) as chat_id,
       (select i.email from app.identities i where i.user_id = o.user_id and i.provider = 'supabase' and i.email is not null limit 1) as email`,
    [limit],
  );
  // UPDATE ... RETURNING has no order: receipts and alerts first, then broadcasts, oldest first.
  const rows = claimed.sort((a, b) => a.priority - b.priority || n(a.id) - n(b.id));
  let sent = 0;
  const skip = (id: string | number) => svc.db.query(`update app.outbox set status = 'sent', sent_at = now(), last_error = 'skipped' where id = $1`, [id]);
  const done = (id: string | number) => svc.db.query(`update app.outbox set status = 'sent', sent_at = now() where id = $1`, [id]);
  const failed = (id: string | number, err: unknown) => {
    const msg = err instanceof Error ? err.message.slice(0, 300) : "error";
    // The person blocked the bot or deleted their account: trying again will not help.
    const final = UNREACHABLE.test(msg);
    return svc.db.query(`update app.outbox set status = case when $3 or attempts >= 5 then 'failed' else 'pending' end, last_error = $2 where id = $1`, [id, msg, final]);
  };

  // Email receipts: only read the settings when a batch has something to do with email.
  const needsEmail = rows.some((r) => r.channel === "email" || ((RECEIPT_TEMPLATES.has(r.template) || EMAIL_INSTEAD.has(r.template)) && r.email));
  const mail = needsEmail ? await emailSettings(env, svc.db) : null;
  // Staff messages come from the separate staff-alerts bot when the owner set one.
  const staffBot = rows.some((r) => STAFF_TEMPLATES.has(r.template)) && !!(await effectiveEnv(env, svc.db)).NOTIFY_BOT_TOKEN;
  const storeBot = staffBot ? await botUsername(svc.db) : "";

  // Browser notifications: only when switched on, and only for messages picked up the first time.
  const pushes = (r: (typeof rows)[number]) => r.channel !== "email" && r.attempts === 1 && r.notify && PUSH_TEMPLATES.has(r.template);
  const pushOn = rows.some(pushes) && (await pushEnabled(svc.db));
  const browsers = new Map<string, number>();
  if (pushOn) {
    const counts = await svc.db.query<{ user_id: string; c: string | number }>(
      `select user_id, count(*) as c from app.push_subscriptions where user_id = any(string_to_array($1::text, ',')::uuid[]) group by user_id`,
      [[...new Set(rows.filter(pushes).map((r) => r.user_id))].join(",")],
    );
    for (const c of counts) browsers.set(c.user_id, Math.min(PUSH_MAX_BROWSERS, n(c.c)));
  }
  // The store's push key and contact, read once per batch.
  let pushFrom: { vapid: Vapid; subject: string } | null = null;
  const left = () => (svc.budget ? svc.budget.left() - reserve : Number.POSITIVE_INFINITY);

  for (const [i, r] of rows.entries()) {
    const locale = r.locale ?? "ar";
    const push = pushOn && pushes(r) ? browsers.get(r.user_id) ?? 0 : 0;
    if (left() < 1 + push) {
      // Out of requests for this run: back in the queue as it was (not a failed attempt).
      await svc.db.query(
        `update app.outbox set attempts = greatest(attempts - 1, 0), available_at = now() where id = any(string_to_array($1::text, ',')::bigint[]) and status = 'pending'`,
        [rows.slice(i).map((x) => String(x.id)).join(",")],
      );
      break;
    }
    if (r.channel === "email") {
      if (!mail || !emailReady(mail) || !r.email || !r.notify) {
        await skip(r.id);
        continue;
      }
      try {
        const msg = await renderReceipt(svc.db, env.PUBLIC_BASE_URL, r.user_id, r.template, locale, r.data ?? {});
        if (!msg) {
          await skip(r.id);
          continue;
        }
        await sendEmail(svc, mail, r.email, msg, `outbox-${r.id}`);
        await done(r.id);
        sent++;
      } catch (err) {
        await failed(r.id, err);
      }
      continue;
    }

    // A receipt also goes by email, as its own message, the first time it is picked up.
    if (r.attempts === 1 && RECEIPT_TEMPLATES.has(r.template) && r.email && r.notify && mail && emailReady(mail)) {
      await svc.db.query(`insert into app.outbox (user_id, channel, template, data) values ($1, 'email', $2, $3::text::jsonb)`, [
        r.user_id,
        r.template,
        JSON.stringify(r.data ?? {}),
      ]);
    }

    // Browser notifications, once per message, for the devices the customer turned them on for.
    if (push > 0) {
      const body = renderTemplate(r.template, locale, r.data ?? {});
      if (body) {
        try {
          if (!pushFrom) {
            const contact = (await supportContacts(svc.db)).email;
            pushFrom = { vapid: await vapidKeys(svc, env), subject: contact ? `mailto:${contact}` : env.PUBLIC_BASE_URL };
          }
          await pushToUser(svc, env, r.user_id, { title: store.name, body: body.slice(0, 240), url: pushUrl(r.template, r.data ?? {}), lang: locale }, pushFrom.subject, {
            vapid: pushFrom.vapid,
            max: push,
            reserve: reserve + 1, // the message itself still goes
          });
        } catch (e) {
          console.error("push failed", e instanceof Error ? e.message : String(e));
        }
      }
    }

    // A website customer (no Telegram) gets these by email instead.
    if (r.attempts === 1 && !r.chat_id && EMAIL_INSTEAD.has(r.template) && r.email && r.notify && mail && emailReady(mail)) {
      await svc.db.query(`insert into app.outbox (user_id, channel, template, data) values ($1, 'email', $2, $3::text::jsonb)`, [
        r.user_id,
        r.template,
        JSON.stringify(r.data ?? {}),
      ]);
    }

    const text = renderTemplate(r.template, locale, r.data ?? {});
    const isStaff = STAFF_TEMPLATES.has(r.template);
    if (!text || !r.chat_id || (!r.notify && !isStaff)) {
      await skip(r.id);
      continue;
    }
    try {
      // "Buy again" and product broadcasts open the product itself; everything else opens the store.
      const slug = (r.template === "buy_again" || r.template === "broadcast" || r.template === "back_in_stock" || r.template === "review_ask") && typeof r.data?.slug === "string" && /^[a-z0-9-]{1,80}$/.test(r.data.slug) ? r.data.slug : null;
      // An answer about an order opens that order.
      const orderId = r.template === "problem_reply" && typeof r.data?.order_id === "string" && /^[0-9a-f-]{36}$/.test(r.data.order_id) ? r.data.order_id : null;
      const label = slug
        ? r.template === "buy_again" ? (locale === "en" ? "Buy again" : "اطلبه مجدداً")
          : r.template === "back_in_stock" ? (locale === "en" ? "Get it now" : "اطلبه الآن")
          : r.template === "review_ask" ? (locale === "en" ? "Rate it ⭐" : "قيّمه ⭐")
          : locale === "en" ? "View" : "عرض المنتج"
        : orderId ? (locale === "en" ? "Open the order" : "افتح الطلب")
        : isStaff ? (locale === "en" ? "Open admin" : "افتح الإدارة")
        : locale === "en" ? "Open store" : "افتح المتجر";
      const url = slug
        ? `${env.PUBLIC_BASE_URL}/tg?startapp=${r.template === "review_ask" ? "v_" : "p_"}${slug}`
        : orderId ? `${env.PUBLIC_BASE_URL}/tg?startapp=o_${orderId}`
        : isStaff ? `${env.PUBLIC_BASE_URL}/tg?startapp=admin` : `${env.PUBLIC_BASE_URL}/tg`;
      if (isStaff && staffBot) {
        // A Mini App button would sign in through the wrong bot: link to the store bot's Mini App instead.
        const link = `https://t.me/${storeBot}?startapp=admin`;
        await svc.telegram("sendMessage", { chat_id: r.chat_id, text, reply_markup: { inline_keyboard: [[{ text: label, url: link }]] } }, "staff");
      } else {
        await svc.telegram("sendMessage", { chat_id: r.chat_id, text, reply_markup: { inline_keyboard: [[{ text: label, web_app: { url } }]] } });
      }
      await done(r.id);
      sent++;
    } catch (err) {
      await failed(r.id, err);
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
