/**
 * The store API: one framework-free `handle(request)` used by the web Worker for
 * /api/*, plus `runScheduled` for the cron trigger. The Mini App, the website and
 * the admin all call the same endpoints.
 */
import * as admin from "./admin";
import * as adminCatalog from "./admin-catalog";
import * as broadcast from "./broadcast";
import * as home from "./home";
import * as auth from "./auth";
import * as catalog from "./catalog";
import { publicConfig } from "./config";
import type { ApiEnv, Services } from "./context";
import { ApiError, errorResponse, json } from "./http";
import * as orders from "./orders";
import * as adminOrders from "./admin-orders";
import * as names from "./names";
import * as accounts from "./accounts";
import * as profit from "./profit";
import * as payments from "./payments";
import * as favorites from "./favorites";
import * as promo from "./promo";
import * as images from "./images";
import * as reports from "./reports";
import * as selection from "./selection";
import * as supplierCatalogue from "./supplier-catalogue";
import { Router } from "./router";
import * as keys from "./keys";
import * as telegramSetup from "./telegram-setup";
import * as pages from "./pages";
import * as reviews from "./reviews";
import * as problems from "./problems";
import { health, logError } from "./health";
import * as loyalty from "./loyalty";
import * as channel from "./channel";
import * as push from "./push";

export type { ApiEnv, AuthedUser, Ctx, Services } from "./context";
export type { Db } from "./db";
export { ApiError } from "./http";
export { runScheduled } from "./jobs";
export { fulfilOrder } from "./fulfilment";
export { creditStarsPayment, settlePayment } from "./payments";
export { normalizeSearch, matchesQuery } from "@store/core";
export { renderTemplate, sendOutbox } from "./notify";
export { handleBotWebhook, handleUpdate } from "./bot";
export { syncSupplier, syncDueSuppliers } from "./sync";
export { refreshDueCatalogues, refreshGroups, refreshItems } from "./supplier-catalogue";
export { loadStoreKeys, STORE_KEYS } from "./keys";
export { daySummary, localNow, previousDay, queueDailySummary, summaryText, toCsv } from "./reports";
export {
  CATEGORY_PATH, PRODUCT_PATH, categoryHead, homeHead, legalHead, llmsTxt, productHead, productMeta, renderPage, renderProductPage, robotsTxt, seoSettings, sitemapXml,
  type PageHead, type PageOpts, type ProductMeta, type SeoSettings,
} from "./seo";
export { LEGAL_PATH } from "./pages";

const router = new Router()
  .on("GET", "/api/health", health)
  .on("GET", "/api/config", publicConfig)
  .on("GET", "/api/pages/:slug", pages.getPage)
  // auth
  .on("POST", "/api/auth/telegram", auth.telegramLogin)
  .on("POST", "/api/auth/telegram-widget", auth.telegramWidgetLogin)
  .on("POST", "/api/auth/web", auth.webLogin)
  .on("POST", "/api/auth/logout", auth.logout)
  .on("GET", "/api/me", auth.me)
  .on("PATCH", "/api/me", auth.updateMe)
  .on("POST", "/api/me/link/start", auth.startLink)
  .on("POST", "/api/me/link/web", auth.linkWeb)
  .on("POST", "/api/me/link/telegram", auth.linkTelegram)
  .on("POST", "/api/me/unlink", auth.unlink)
  .on("GET", "/api/me/referral", promo.getReferral)
  .on("GET", "/api/me/level", loyalty.myLevel)
  .on("GET", "/api/push/key", push.pushKey)
  .on("POST", "/api/push/subscribe", push.subscribePush)
  .on("POST", "/api/push/unsubscribe", push.unsubscribePush)
  .on("POST", "/api/me/referral", promo.claimReferral)
  // catalog
  .on("GET", "/api/catalog", catalog.listCatalog)
  .on("GET", "/api/products/:slug", catalog.getProduct)
  .on("GET", "/api/products/:slug/reviews", reviews.listReviews)
  .on("PUT", "/api/products/:slug/review", reviews.saveReview)
  .on("DELETE", "/api/products/:slug/review", reviews.deleteReview)
  .on("POST", "/api/orders/:id/problem", problems.reportProblem)
  // orders
  .on("POST", "/api/orders", orders.placeOrder)
  .on("GET", "/api/orders", orders.listOrders)
  .on("GET", "/api/orders/:id", orders.getOrder)
  .on("POST", "/api/orders/:id/number", orders.closeNumber)
  .on("POST", "/api/orders/:id/answers", orders.submitAnswers)
  .on("POST", "/api/coupons/quote", promo.quoteCoupon)
  .on("POST", "/api/webhooks/suppliers/:id", orders.supplierWebhook)
  // wallet and top-ups
  .on("GET", "/api/wallet", payments.walletHistory)
  .on("GET", "/api/topups/methods", payments.listMethods)
  .on("POST", "/api/topups", payments.createTopup)
  .on("GET", "/api/topups/:id", payments.getTopup)
  .on("POST", "/api/topups/:id/tx", payments.submitTxHash)
  .on("POST", "/api/topups/:id/cancel", payments.cancelTopup)
  .on("GET", "/api/favorites", favorites.listFavorites)
  .on("PUT", "/api/favorites/:productId", favorites.addFavorite)
  .on("DELETE", "/api/favorites/:productId", favorites.removeFavorite)
  .on("PUT", "/api/stock-alerts/:offerId", favorites.addStockAlert)
  .on("DELETE", "/api/stock-alerts/:offerId", favorites.removeStockAlert)
  .on("POST", "/api/webhooks/payments/:method", payments.paymentWebhook)
  // admin
  .on("GET", "/api/admin/overview", admin.overview)
  .on("GET", "/api/admin/payments", admin.listPayments)
  .on("POST", "/api/admin/payments/:id/approve", admin.approvePayment)
  .on("POST", "/api/admin/payments/:id/reject", admin.rejectPayment)
  .on("POST", "/api/admin/payments/:id/recheck", admin.recheckPayment)
  .on("GET", "/api/admin/orders", admin.listOrders)
  .on("POST", "/api/admin/orders/in-person", adminOrders.placeInPersonOrder)
  .on("GET", "/api/admin/orders/:id", adminOrders.getAdminOrder)
  .on("POST", "/api/admin/orders/:id/deliver", adminOrders.deliverOrder)
  .on("POST", "/api/admin/orders/:id/reveal", adminOrders.revealDeliveries)
  .on("POST", "/api/admin/orders/:id/refund", admin.refundOrder)
  .on("POST", "/api/admin/orders/:id/retry", admin.retryOrder)
  .on("GET", "/api/admin/channel", channel.adminChannel)
  .on("POST", "/api/admin/channel/test", channel.testChannelPost)
  .on("GET", "/api/admin/problems", problems.adminProblems)
  .on("POST", "/api/admin/problems/:id/resolve", problems.resolveProblem)
  .on("GET", "/api/admin/reviews", reviews.adminReviews)
  .on("PATCH", "/api/admin/reviews/:id", reviews.setReviewStatus)
  .on("DELETE", "/api/admin/reviews/:id", reviews.removeReview)
  .on("GET", "/api/admin/pages", pages.adminPages)
  .on("PUT", "/api/admin/pages/:slug", pages.savePage)
  .on("DELETE", "/api/admin/pages/:slug", pages.deletePage)
  .on("GET", "/api/admin/settings", admin.getSettings)
  .on("PUT", "/api/admin/settings/:key", admin.putSetting)
  .on("GET", "/api/admin/users", admin.listUsers)
  .on("POST", "/api/admin/users/:id/wallet", admin.adjustWallet)
  .on("POST", "/api/admin/users/:id/role", admin.setUserRole)
  .on("POST", "/api/admin/suppliers/check-all", admin.checkAllSuppliers)
  .on("POST", "/api/admin/suppliers/:id/sync", admin.runSupplierSync)
  .on("GET", "/api/admin/telegram", telegramSetup.getBotStatus)
  .on("POST", "/api/admin/telegram/connect", telegramSetup.connectBot)
  .on("POST", "/api/admin/email/test", admin.testEmail)
  .on("GET", "/api/admin/accounts", accounts.listAccounts)
  .on("GET", "/api/admin/accounts/:kind/:id", accounts.getAccount)
  .on("GET", "/api/admin/names", names.getNames)
  .on("POST", "/api/admin/names/preview", names.previewNames)
  .on("PUT", "/api/admin/names", names.putNames)
  .on("GET", "/api/admin/keys", keys.listKeys)
  .on("PUT", "/api/admin/keys/:name", keys.putKey)
  .on("GET", "/api/admin/export/:kind", reports.exportCsv)
  .on("GET", "/api/admin/reports/profit", profit.profitReport)
  .on("GET", "/api/admin/broadcasts", broadcast.listBroadcasts)
  .on("GET", "/api/admin/broadcasts/audience", broadcast.broadcastAudience)
  .on("POST", "/api/admin/broadcasts/test", broadcast.testBroadcast)
  .on("POST", "/api/admin/broadcasts", broadcast.createBroadcast)
  .on("POST", "/api/admin/broadcasts/:id/cancel", broadcast.cancelBroadcast)
  .on("GET", "/api/admin/coupons", promo.listCoupons)
  .on("POST", "/api/admin/coupons", promo.createCoupon)
  .on("PATCH", "/api/admin/coupons/:id", promo.updateCoupon)
  // admin catalogue
  .on("GET", "/api/admin/catalog", adminCatalog.getCatalog)
  .on("POST", "/api/admin/categories", adminCatalog.createCategory)
  .on("PATCH", "/api/admin/categories/:id", home.updateCategory)
  .on("GET", "/api/admin/home", home.listBanners)
  .on("POST", "/api/admin/images", images.uploadImage)
  .on("POST", "/api/admin/banners", home.createBanner)
  .on("PATCH", "/api/admin/banners/:id", home.updateBanner)
  .on("DELETE", "/api/admin/banners/:id", home.deleteBanner)
  .on("POST", "/api/admin/products", adminCatalog.createProduct)
  .on("PATCH", "/api/admin/products/:id", adminCatalog.updateProduct)
  .on("POST", "/api/admin/products/:id/offers", adminCatalog.createOffer)
  .on("PATCH", "/api/admin/offers/:id", adminCatalog.updateOffer)
  .on("POST", "/api/admin/offers/:id/relink", adminCatalog.relinkOffer)
  .on("POST", "/api/admin/offers/:id/accept-cost", adminCatalog.acceptCost)
  .on("GET", "/api/admin/suppliers", adminCatalog.listSuppliers)
  .on("GET", "/api/admin/suppliers/:id/review", adminCatalog.supplierReview)
  .on("POST", "/api/admin/offers/:id/stock", adminCatalog.addStock)
  .on("GET", "/api/admin/suppliers/:id/catalogue", supplierCatalogue.getCatalogue)
  .on("GET", "/api/admin/suppliers/:id/catalogue/items", supplierCatalogue.getCatalogueItems)
  .on("POST", "/api/admin/suppliers/:id/catalogue/refresh", supplierCatalogue.refreshCatalogue)
  .on("POST", "/api/admin/suppliers/:id/selection", selection.applySelection)
  .on("POST", "/api/admin/suppliers/:id/pricing", adminCatalog.applySupplierPricing)
  .on("PATCH", "/api/admin/suppliers/:id", adminCatalog.updateSupplier);

/** Requests that change state must come from our own pages (or carry a bearer token). */
function sameOriginOrBearer(req: Request, env: ApiEnv, path: string): boolean {
  if (req.method === "GET" || req.method === "HEAD") return true;
  if (path.startsWith("/api/webhooks/")) return true;
  if (req.headers.get("authorization")?.startsWith("Bearer ")) return true;
  const origin = req.headers.get("origin");
  return origin === env.PUBLIC_BASE_URL;
}

export async function handle(req: Request, env: ApiEnv, svc: Services): Promise<Response> {
  const url = new URL(req.url);
  try {
    if (!sameOriginOrBearer(req, env, url.pathname)) throw new ApiError("forbidden");
    const m = router.match(req.method, url.pathname);
    if (!m) throw new ApiError("not_found");
    return await m.handler({ req, url, env, svc, params: m.params });
  } catch (err) {
    // Unexpected errors are written down: when they pile up, the owner hears about it (health.ts).
    if (!(err instanceof ApiError)) {
      await logError(svc.db, `${req.method} ${url.pathname}`, err instanceof Error ? `${err.name}: ${err.message}` : String(err));
    }
    return errorResponse(err);
  }
}
