/**
 * The Telegram bot: a launcher for the Mini App, the Stars payment flow and a few
 * quick commands (/balance, /orders, /invite, /help). Browsing and buying happen
 * in the Mini App.
 *
 * Telegram calls POST /telegram/webhook with the secret we registered; anything
 * without that header is refused.
 */
import { store } from "@store/config";
import { formatUsd, verifyBotWebhook } from "@store/core";
import { parsePreCheckoutQuery, parseSuccessfulPayment } from "@store/payments";
import type { ApiEnv, Services } from "./context";
import { n, one } from "./db";
import { logError } from "./health";
import { json } from "./http";
import { creditStarsPayment, expectedStars, TOPUP_WINDOW_MS } from "./payments";
import { referralSettings } from "./promo";
import { botUsername, channelUrl, starsPerUsd, supportContacts, type SupportContacts } from "./settings";

type Update = Record<string, any>;

const TEXT = {
  ar: {
    welcome: (name: string) => `أهلاً ${name} 👋\nكل منتجاتك في مكان واحد: ألعاب، اشتراكات، بطاقات وأكثر.\nاضغط الزر لفتح المتجر.`,
    open: "افتح المتجر",
    help: [
      "الأوامر:",
      "/balance — رصيدك",
      "/orders — آخر طلباتك",
      "/invite — رابط دعوة الأصدقاء",
      "",
      "للمساعدة تواصل مع الدعم من داخل المتجر (حسابي ← المساعدة والدعم).",
    ].join("\n"),
    helpCommands: ["الأوامر:", "/balance — رصيدك", "/orders — آخر طلباتك", "/invite — رابط دعوة الأصدقاء"].join("\n"),
    unknown: "استخدم زر المتجر في الأسفل لتصفح المنتجات والشراء، أو /help لرؤية الأوامر.",
    payFailed: "انتهت صلاحية هذا الدفع. ابدأ من جديد من المتجر.",
    balance: (amount: string) => `رصيدك: ${amount}`,
    topUp: "شحن الرصيد",
    noOrders: "لا توجد طلبات بعد.",
    lastOrders: "آخر طلباتك:",
    allOrders: "كل الطلبات",
    status: { paid: "قيد التنفيذ", processing: "قيد التنفيذ", delivered: "تم التسليم", failed: "تعذّر التنفيذ", refunded: "مُسترد" } as Record<string, string>,
    invite: (link: string, pct: number, days: number) =>
      `ادعُ أصدقاءك واحصل على ${pct}% من قيمة طلباتهم${days > 0 ? ` خلال أول ${days} يوماً` : ""} في رصيدك.\n\nرابطك:\n${link}`,
    inviteOff: "الدعوات غير متاحة حالياً.",
    share: "مشاركة الرابط",
    shareText: "تسوّق ألعاب واشتراكات وبطاقات من هنا:",
    terms: "سياسات المتجر:",
    paySupport: "لمشاكل الدفع أو الاسترداد أرسل لنا رقم الطلب أو تفاصيل الدفع، وسنرد عادةً خلال يوم.",
    pageNames: { terms: "الشروط والأحكام", privacy: "سياسة الخصوصية", refund: "سياسة الاسترداد" } as Record<string, string>,
  },
  en: {
    welcome: (name: string) => `Hi ${name} 👋\nGames, subscriptions, gift cards and more, all in one place.\nTap the button to open the store.`,
    open: "Open store",
    help: [
      "Commands:",
      "/balance — your balance",
      "/orders — your latest orders",
      "/invite — your invite link",
      "",
      "For help, contact support inside the store (Profile → Help and support).",
    ].join("\n"),
    helpCommands: ["Commands:", "/balance — your balance", "/orders — your latest orders", "/invite — your invite link"].join("\n"),
    unknown: "Use the store button below to browse and buy, or /help for commands.",
    payFailed: "This payment has expired. Please start again from the store.",
    balance: (amount: string) => `Your balance: ${amount}`,
    topUp: "Add funds",
    noOrders: "No orders yet.",
    lastOrders: "Your latest orders:",
    allOrders: "All orders",
    status: { paid: "Processing", processing: "Processing", delivered: "Delivered", failed: "Failed", refunded: "Refunded" } as Record<string, string>,
    invite: (link: string, pct: number, days: number) =>
      `Invite friends and get ${pct}% of what they spend${days > 0 ? ` in their first ${days} days` : ""}, added to your balance.\n\nYour link:\n${link}`,
    inviteOff: "Invites are not available right now.",
    share: "Share link",
    shareText: "Games, subscriptions and gift cards:",
    terms: "The store's policies:",
    paySupport: "For a payment problem or a refund, send us your order number or the payment details. We usually answer within a day.",
    pageNames: { terms: "Terms of service", privacy: "Privacy policy", refund: "Refund policy" } as Record<string, string>,
  },
};

/** The label of the button that opens the store (also the bot's menu button). */
export const OPEN_STORE = { ar: TEXT.ar.open, en: TEXT.en.open } as const;

/** The command menu Telegram shows in the chat, per language (set by Admin → Settings → Connect bot). */
export const BOT_COMMANDS = {
  en: [
    { command: "start", description: "Open the store" },
    { command: "balance", description: "Your balance" },
    { command: "orders", description: "Your latest orders" },
    { command: "invite", description: "Invite friends" },
    { command: "help", description: "Help" },
    { command: "terms", description: "Terms and policies" },
    { command: "paysupport", description: "Payment support" },
  ],
  ar: [
    { command: "start", description: "افتح المتجر" },
    { command: "balance", description: "رصيدك" },
    { command: "orders", description: "آخر طلباتك" },
    { command: "invite", description: "ادعُ أصدقاءك" },
    { command: "help", description: "المساعدة" },
    { command: "terms", description: "الشروط والسياسات" },
    { command: "paysupport", description: "دعم المدفوعات" },
  ],
};

function lang(code: unknown): "ar" | "en" {
  return typeof code === "string" && !code.startsWith("ar") ? "en" : "ar";
}

function webAppUrl(env: ApiEnv, startParam?: string): string {
  return `${env.PUBLIC_BASE_URL}/tg${startParam ? `?startapp=${encodeURIComponent(startParam)}` : ""}`;
}

function storeButton(env: ApiEnv, l: "ar" | "en", startParam?: string, label: string = TEXT[l].open) {
  return { inline_keyboard: [[{ text: label, web_app: { url: webAppUrl(env, startParam) } }]] };
}

/** The store user behind this Telegram account, created on first contact. */
async function botUser(svc: Services, from: Record<string, any>): Promise<string | null> {
  if (typeof from.id !== "number") return null;
  const name = [from.first_name, from.last_name].filter((x) => typeof x === "string").join(" ");
  const locale = typeof from.language_code === "string" && !from.language_code.startsWith("ar") ? "en" : "ar";
  const row = await one<{ id: string }>(svc.db, `select app.ensure_telegram_user($1, $2, $3, $4) as id`, [
    String(from.id),
    typeof from.username === "string" ? from.username : null,
    name,
    locale,
  ]);
  return row?.id ?? null;
}

/** The support channels set in Admin → Settings, one per line. */
function supportLines(s: SupportContacts, l: "ar" | "en", channel: string | null = null): string {
  const ar = l === "ar";
  const lines = [
    channel ? `${ar ? "قناتنا" : "Our channel"}: ${channel}` : "",
    s.telegram ? `${ar ? "تيليجرام" : "Telegram"}: @${s.telegram}` : "",
    s.whatsapp ? `${ar ? "واتساب" : "WhatsApp"}: https://wa.me/${s.whatsapp}` : "",
    s.email ? `${ar ? "البريد" : "Email"}: ${s.email}` : "",
  ].filter(Boolean);
  return lines.length ? `${ar ? "للمساعدة تواصل معنا:" : "Need help? Contact us:"}\n${lines.join("\n")}` : "";
}

async function command(cmd: string, userId: string, chatId: unknown, l: "ar" | "en", env: ApiEnv, svc: Services): Promise<boolean> {
  const T = TEXT[l];
  if (cmd === "/balance") {
    const w = await one<{ balance_cents: string | number }>(svc.db, `select balance_cents from app.wallets where user_id = $1`, [userId]);
    await svc.telegram("sendMessage", { chat_id: chatId, text: T.balance(formatUsd(n(w?.balance_cents))), reply_markup: storeButton(env, l, "wallet", T.topUp) });
    return true;
  }
  if (cmd === "/orders") {
    const rows = await svc.db.query<{ number: string | number; status: string; total_cents: string | number; name_ar: string; name_en: string; offer_ar: string; offer_en: string }>(
      `select o.number, o.status, o.total_cents, p.name_ar, p.name_en, f.name_ar as offer_ar, f.name_en as offer_en
         from app.orders o join app.products p on p.id = o.product_id join app.offers f on f.id = o.offer_id
        where o.user_id = $1 order by o.number desc limit 5`,
      [userId],
    );
    const lines = rows.map((r) => {
      const name = l === "ar" ? `${r.name_ar} · ${r.offer_ar}` : `${r.name_en} · ${r.offer_en}`;
      return `${store.orderPrefix}${n(r.number)} — ${name}\n${T.status[r.status] ?? r.status} · ${formatUsd(n(r.total_cents))}`;
    });
    await svc.telegram("sendMessage", {
      chat_id: chatId,
      text: rows.length ? `${T.lastOrders}\n\n${lines.join("\n\n")}` : T.noOrders,
      reply_markup: storeButton(env, l, rows.length ? "orders" : undefined, rows.length ? T.allOrders : T.open),
    });
    return true;
  }
  if (cmd === "/invite") {
    const s = await referralSettings({ svc });
    if (!s.enabled || s.percent <= 0) {
      await svc.telegram("sendMessage", { chat_id: chatId, text: T.inviteOff, reply_markup: storeButton(env, l) });
      return true;
    }
    const row = await one<{ code: string }>(svc.db, `select app.ensure_referral_code($1) as code`, [userId]);
    const link = `https://t.me/${await botUsername(svc.db)}?start=r_${row?.code ?? ""}`;
    const share = `https://t.me/share/url?url=${encodeURIComponent(link)}&text=${encodeURIComponent(T.shareText)}`;
    await svc.telegram("sendMessage", {
      chat_id: chatId,
      text: T.invite(link, s.percent, s.days),
      link_preview_options: { is_disabled: true },
      reply_markup: { inline_keyboard: [[{ text: T.share, url: share }], [{ text: T.open, web_app: { url: webAppUrl(env, "invite") } }]] },
    });
    return true;
  }
  if (cmd === "/terms") {
    const lines = (["terms", "privacy", "refund"] as const).map((s) => `${T.pageNames[s]}: ${env.PUBLIC_BASE_URL}/legal/${s}${l === store.defaultLocale ? "" : `?lang=${l}`}`);
    await svc.telegram("sendMessage", { chat_id: chatId, text: `${T.terms}\n${lines.join("\n")}`, link_preview_options: { is_disabled: true } });
    return true;
  }
  if (cmd === "/paysupport") {
    const contact = supportLines(await supportContacts(svc.db), l);
    const refund = `${T.pageNames.refund}: ${env.PUBLIC_BASE_URL}/legal/refund${l === store.defaultLocale ? "" : `?lang=${l}`}`;
    await svc.telegram("sendMessage", {
      chat_id: chatId,
      text: [T.paySupport, contact, refund].filter(Boolean).join("\n\n"),
      link_preview_options: { is_disabled: true },
    });
    return true;
  }
  if (cmd === "/help") {
    const contact = supportLines(await supportContacts(svc.db), l, await channelUrl(svc.db));
    await svc.telegram("sendMessage", {
      chat_id: chatId,
      text: contact ? `${T.helpCommands}\n\n${contact}` : T.help,
      link_preview_options: { is_disabled: true },
      reply_markup: storeButton(env, l),
    });
    return true;
  }
  return false;
}

export async function handleBotWebhook(req: Request, env: ApiEnv, svc: Services): Promise<Response> {
  if (!env.TELEGRAM_WEBHOOK_SECRET || !verifyBotWebhook(req, env.TELEGRAM_WEBHOOK_SECRET)) {
    return json({ ok: false }, { status: 401 });
  }
  let update: Update;
  try {
    update = (await req.json()) as Update;
  } catch {
    return json({ ok: true });
  }
  try {
    await handleUpdate(update, env, svc);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("bot update failed", msg);
    // A paid Stars invoice that could not be credited (the database blinked...): the
    // customer's Stars are already spent, so Telegram must deliver it again. Crediting
    // is idempotent per payment (app.credit_payment), so a repeat never pays twice.
    if (parseSuccessfulPayment(update)) {
      await logError(svc.db, "bot.successful_payment", msg);
      return json({ ok: false }, { status: 500 });
    }
    // Anything else: 200, so Telegram doesn't retry it forever; the error is logged.
    await logError(svc.db, "bot.update", msg);
  }
  return json({ ok: true });
}

export async function handleUpdate(update: Update, env: ApiEnv, svc: Services): Promise<void> {
  const pre = parsePreCheckoutQuery(update);
  if (pre) {
    const l = lang(update.pre_checkout_query?.from?.language_code);
    let ok = false;
    if (pre.currency === "XTR" && /^[0-9a-f-]{36}$/.test(pre.paymentId)) {
      const p = await one<{ amount_cents: string | number; status: string; subject: string | null; stars: unknown; created_at: string }>(
        svc.db,
        `select pay.amount_cents, pay.status, i.subject, pay.action->'stars' as stars, pay.created_at
           from app.payments pay left join app.identities i on i.user_id = pay.user_id and i.provider = 'telegram'
          where pay.id = $1 and pay.method = 'stars'`,
        [pre.paymentId],
      );
      const expected = p ? expectedStars(p.stars, n(p.amount_cents), await starsPerUsd(svc.db)) : null;
      // Only while the top-up is open and inside its payment window (a closed one charges nothing).
      const inWindow = !!p && svc.now().getTime() < new Date(p.created_at).getTime() + TOPUP_WINDOW_MS;
      ok = !!p && inWindow && ["created", "pending"].includes(p.status) && p.subject === String(pre.fromId) &&
        expected !== null && pre.totalStars >= expected;
    }
    await svc.telegram("answerPreCheckoutQuery", ok
      ? { pre_checkout_query_id: pre.queryId, ok: true }
      : { pre_checkout_query_id: pre.queryId, ok: false, error_message: TEXT[l].payFailed });
    return;
  }

  const msg = update.message;
  if (!msg || typeof msg !== "object") return;
  const from = msg.from ?? {};
  const l = lang(from.language_code);

  const paid = parseSuccessfulPayment(update);
  if (paid) {
    await creditStarsPayment(svc, {
      paymentId: paid.paymentId ?? "",
      chargeId: paid.providerRef,
      totalStars: n(msg.successful_payment?.total_amount),
      telegramUserId: String(from.id),
    });
    return;
  }

  if (msg.chat?.type !== "private") return;
  const text = typeof msg.text === "string" ? msg.text.trim() : "";
  // "/orders@gh_store1_bot" and "/orders" are the same command.
  const cmd = (text.split(/\s+/)[0] ?? "").replace(/@\w+$/, "").toLowerCase();

  if (cmd === "/start") {
    const param = text.split(/\s+/)[1];
    const safeParam = param && /^[A-Za-z0-9_-]{1,64}$/.test(param) ? param : undefined;
    const userId = await botUser(svc, from);
    // t.me/<bot>?start=r_<code>: a friend's invite link.
    if (userId && safeParam?.startsWith("r_")) {
      await svc.db.query(`select app.set_referrer($1, $2)`, [userId, safeParam.slice(2)]);
    }
    await svc.telegram("sendMessage", {
      chat_id: msg.chat.id,
      text: TEXT[l].welcome(String(from.first_name ?? "").slice(0, 40)),
      reply_markup: storeButton(env, l, safeParam?.startsWith("r_") ? undefined : safeParam),
    });
    return;
  }
  if (cmd.startsWith("/")) {
    const userId = await botUser(svc, from);
    if (userId && (await command(cmd, userId, msg.chat.id, l, env, svc))) return;
  }
  await svc.telegram("sendMessage", { chat_id: msg.chat.id, text: TEXT[l].unknown, reply_markup: storeButton(env, l) });
}
