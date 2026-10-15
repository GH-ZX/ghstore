/**
 * The Telegram bot: a thin launcher for the Mini App, the Stars payment flow,
 * and nothing else. Browsing and buying happen in the Mini App.
 *
 * Telegram calls POST /telegram/webhook with the secret we registered; anything
 * without that header is refused.
 */
import { verifyBotWebhook } from "@store/core";
import { parsePreCheckoutQuery, parseSuccessfulPayment, starsForCents } from "@store/payments";
import type { ApiEnv, Services } from "./context";
import { n, one } from "./db";
import { json } from "./http";
import { creditStarsPayment } from "./payments";

type Update = Record<string, any>;

const TEXT = {
  ar: {
    welcome: (name: string) => `أهلاً ${name} 👋\nكل منتجاتك في مكان واحد: ألعاب، اشتراكات، بطاقات وأكثر.\nاضغط الزر لفتح المتجر.`,
    open: "افتح المتجر",
    help: "للمساعدة تواصل مع الدعم من داخل المتجر (حسابي ← المساعدة والدعم).",
    unknown: "استخدم زر المتجر في الأسفل لتصفح المنتجات والشراء.",
    payFailed: "انتهت صلاحية هذا الدفع. ابدأ من جديد من المتجر.",
  },
  en: {
    welcome: (name: string) => `Hi ${name} 👋\nGames, subscriptions, gift cards and more, all in one place.\nTap the button to open the store.`,
    open: "Open store",
    help: "For help, contact support inside the store (Profile → Help and support).",
    unknown: "Use the store button below to browse and buy.",
    payFailed: "This payment has expired. Please start again from the store.",
  },
};

function lang(code: unknown): "ar" | "en" {
  return typeof code === "string" && !code.startsWith("ar") ? "en" : "ar";
}

function storeButton(env: ApiEnv, l: "ar" | "en", startParam?: string) {
  const url = `${env.PUBLIC_BASE_URL}/tg${startParam ? `?startapp=${encodeURIComponent(startParam)}` : ""}`;
  return { inline_keyboard: [[{ text: TEXT[l].open, web_app: { url } }]] };
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
    // Always 200 so Telegram doesn't retry forever; the error is logged.
    console.error("bot update failed", err instanceof Error ? err.message : String(err));
  }
  return json({ ok: true });
}

export async function handleUpdate(update: Update, env: ApiEnv, svc: Services): Promise<void> {
  const rate = env.STARS_PER_USD;

  const pre = parsePreCheckoutQuery(update);
  if (pre) {
    const l = lang(update.pre_checkout_query?.from?.language_code);
    let ok = false;
    if (pre.currency === "XTR" && rate && /^[0-9a-f-]{36}$/.test(pre.paymentId)) {
      const p = await one<{ amount_cents: string | number; status: string; subject: string | null }>(
        svc.db,
        `select pay.amount_cents, pay.status, i.subject
           from app.payments pay left join app.identities i on i.user_id = pay.user_id and i.provider = 'telegram'
          where pay.id = $1 and pay.method = 'stars'`,
        [pre.paymentId],
      );
      ok = !!p && ["created", "pending"].includes(p.status) && p.subject === String(pre.fromId) &&
        pre.totalStars >= starsForCents(n(p.amount_cents), rate);
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
  if (paid && rate) {
    await creditStarsPayment(svc, {
      paymentId: paid.paymentId ?? "",
      chargeId: paid.providerRef,
      totalStars: n(msg.successful_payment?.total_amount),
      telegramUserId: String(from.id),
      expectedStars: (cents) => starsForCents(cents, rate),
    });
    return;
  }

  if (msg.chat?.type !== "private") return;
  const text = typeof msg.text === "string" ? msg.text.trim() : "";
  if (text.startsWith("/start")) {
    const param = text.split(/\s+/)[1];
    const safeParam = param && /^[A-Za-z0-9_-]{1,64}$/.test(param) ? param : undefined;
    await svc.telegram("sendMessage", {
      chat_id: msg.chat.id,
      text: TEXT[l].welcome(String(from.first_name ?? "").slice(0, 40)),
      reply_markup: storeButton(env, l, safeParam),
    });
    return;
  }
  await svc.telegram("sendMessage", {
    chat_id: msg.chat.id,
    text: text === "/help" ? TEXT[l].help : TEXT[l].unknown,
    reply_markup: storeButton(env, l),
  });
}
