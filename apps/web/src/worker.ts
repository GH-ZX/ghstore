/**
 * Entry point of the single GH Store Worker.
 *   /api/*             JSON API used by the website, the Mini App and the admin
 *   /telegram/webhook  Telegram bot updates (secret-header protected)
 *   /p/<slug>          the web app with the product's link-preview tags
 *   /sitemap.xml, /robots.txt
 *   everything else    the web app: static files from dist/ (website, /tg Mini App,
 *                      /admin), served by Cloudflare without running this code
 * Cron (every minute): fulfilment, payment re-checks, supplier sync, notifications.
 */
import { store } from "@store/config";
import { handle, handleBotWebhook, PRODUCT_PATH, productMeta, renderProductPage, robotsTxt, runScheduled, sitemapXml } from "@store/api";
import { createServices, type WorkerEnv } from "./services";

const SECURITY_HEADERS: Record<string, string> = {
  "strict-transport-security": "max-age=31536000; includeSubDomains",
  "x-content-type-options": "nosniff",
  "referrer-policy": "strict-origin-when-cross-origin",
  "permissions-policy": "camera=(), microphone=(), geolocation=()",
};

/** The page's Content-Security-Policy. Keep in step with client/public/_headers (Cloudflare does not apply that file to Worker responses). */
const PAGE_CSP =
  "default-src 'self'; script-src 'self' https://telegram.org; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; " +
  "font-src 'self' https://fonts.gstatic.com; img-src 'self' https: data:; connect-src 'self' https://*.supabase.co; " +
  "frame-src https://oauth.telegram.org; frame-ancestors 'self' https://web.telegram.org https://*.telegram.org; base-uri 'self'; form-action 'self'";

/** Resolve with null if the work takes longer than `ms` (a slow database must not hang a page). */
function within<T>(ms: number, work: Promise<T>): Promise<T | null> {
  return Promise.race([work, new Promise<null>((resolve) => setTimeout(() => resolve(null), ms))]);
}

function withSecurityHeaders(res: Response): Response {
  const out = new Response(res.body, res);
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) out.headers.set(k, v);
  return out;
}

/** The app's index.html (the SPA shell) from the static assets. */
function shell(request: Request, env: WorkerEnv): Promise<Response> {
  return env.ASSETS.fetch(new Request(new URL("/", request.url)));
}

/** index.html with the product's title, picture and price for link previews. Never fails the page. */
async function productPage(request: Request, slug: string, env: WorkerEnv, ctx: ExecutionContext): Promise<Response> {
  const page = await shell(request, env);
  if (!page.ok || !(page.headers.get("content-type") ?? "").includes("text/html")) return page;
  const { svc, finish } = createServices(env);
  try {
    const meta = await within(1500, productMeta(svc, slug));
    if (!meta) return page;
    const html = renderProductPage(await page.text(), meta, { baseUrl: env.PUBLIC_BASE_URL, storeName: store.name, locale: store.defaultLocale });
    const headers = new Headers(page.headers);
    headers.delete("content-length");
    headers.delete("etag");
    headers.set("cache-control", "no-cache");
    headers.set("content-security-policy", PAGE_CSP);
    return withSecurityHeaders(new Response(html, { status: 200, headers }));
  } catch (err) {
    console.error("product page meta failed", err instanceof Error ? err.message : String(err));
    return shell(request, env);
  } finally {
    ctx.waitUntil(finish());
  }
}

async function sitemap(env: WorkerEnv, ctx: ExecutionContext): Promise<Response> {
  const { svc, finish } = createServices(env);
  try {
    const xml = await within(3000, sitemapXml(svc, env.PUBLIC_BASE_URL));
    if (!xml) return new Response("sitemap unavailable", { status: 503, headers: { "retry-after": "300" } });
    return new Response(xml, {
      headers: { "content-type": "application/xml; charset=utf-8", "cache-control": "public, max-age=3600" },
    });
  } catch (err) {
    console.error("sitemap failed", err instanceof Error ? err.message : String(err));
    return new Response("sitemap unavailable", { status: 503, headers: { "retry-after": "300" } });
  } finally {
    ctx.waitUntil(finish());
  }
}

export default {
  async fetch(request: Request, env: WorkerEnv, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    // www.<domain> is an alias of the store's address (the web app redirects static pages itself).
    if (url.hostname.startsWith("www.")) {
      url.hostname = url.hostname.slice(4);
      return Response.redirect(url.toString(), 301);
    }
    if (url.pathname.startsWith("/api/") || url.pathname === "/telegram/webhook") {
      const { svc, ready, finish } = createServices(env);
      try {
        await ready();
        const res =
          url.pathname === "/telegram/webhook" && request.method === "POST"
            ? await handleBotWebhook(request, env, svc)
            : await handle(request, env, svc);
        return withSecurityHeaders(res);
      } finally {
        ctx.waitUntil(finish());
      }
    }
    if (request.method === "GET" || request.method === "HEAD") {
      if (url.pathname === "/robots.txt") {
        return new Response(robotsTxt(env.PUBLIC_BASE_URL), { headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "public, max-age=3600" } });
      }
      if (url.pathname === "/sitemap.xml") return sitemap(env, ctx);
      const m = PRODUCT_PATH.exec(url.pathname);
      if (m?.[1]) return productPage(request, m[1], env, ctx);
    }
    // Only reached for paths listed in run_worker_first that are not ours; let assets answer.
    return env.ASSETS.fetch(request);
  },

  async scheduled(_controller: ScheduledController, env: WorkerEnv, ctx: ExecutionContext): Promise<void> {
    const { svc, ready, finish } = createServices(env);
    ctx.waitUntil(ready().then(() => runScheduled(svc, env)).finally(finish));
  },
} satisfies ExportedHandler<WorkerEnv>;
