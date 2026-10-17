/**
 * Entry point of the single GH Store Worker.
 *   /api/*             JSON API used by the website, the Mini App and the admin
 *   /telegram/webhook  Telegram bot updates (secret-header protected)
 *   /, /c/<slug>, /p/<slug>, /legal/<slug>
 *                      the web app with that page's title, description, picture,
 *                      language versions and content for search engines (seo.ts)
 *   /sitemap.xml, /robots.txt
 *   everything else    the web app: static files from dist/ (website, /tg Mini App,
 *                      /admin), served by Cloudflare without running this code
 * Cron (every minute): fulfilment, payment re-checks, supplier sync, notifications.
 */
import { store } from "@store/config";
import {
  CATEGORY_PATH, categoryHead, handle, handleBotWebhook, homeHead, LEGAL_PATH, legalHead, llmsTxt, PRODUCT_PATH, productHead, productMeta, renderPage, robotsTxt,
  runScheduled, seoSettings, sitemapXml, type PageHead, type PageOpts, type Services,
} from "@store/api";
import { createServices, type WorkerEnv } from "./services";

const SECURITY_HEADERS: Record<string, string> = {
  "strict-transport-security": "max-age=31536000; includeSubDomains",
  "x-content-type-options": "nosniff",
  "referrer-policy": "strict-origin-when-cross-origin",
  "permissions-policy": "camera=(), microphone=(), geolocation=()",
};

/** The page's Content-Security-Policy. Keep in step with client/public/_headers (Cloudflare does not apply that file to Worker responses). */
const PAGE_CSP =
  "default-src 'self'; script-src 'self' https://telegram.org https://static.cloudflareinsights.com; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; " +
  "font-src 'self' https://fonts.gstatic.com; img-src 'self' https: data:; connect-src 'self' https://*.supabase.co https://cloudflareinsights.com; " +
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

/** The plain app (no page head), with the page's security headers like every other answer. */
function plainShell(page: Response): Response {
  const out = withSecurityHeaders(page);
  if ((out.headers.get("content-type") ?? "").includes("text/html")) out.headers.set("content-security-policy", PAGE_CSP);
  return out;
}

// ─────────────────────────────────────────────────────────────── edge cache

/**
 * Busy public answers are kept for a minute in Cloudflare's cache (per data
 * centre), so a crowd looking at the store does not cost one database round
 * trip each. Only answers that are the same for everyone: they never read who
 * is asking (no session, no cookie), and only a 200 without set-cookie.
 */
const EDGE_TTL_SECONDS = 60;
/** The browser's own cache-control, kept beside the edge copy's. */
const CLIENT_CACHE_HEADER = "x-store-client-cache-control";

/** GET API answers that do not depend on who asks (catalogue, product, config, store pages). */
function sharedApiAnswer(url: URL): boolean {
  if (url.pathname === "/api/catalog") return !url.searchParams.has("q"); // searches vary too much to be worth it
  return url.pathname === "/api/config" || /^\/api\/(products|pages)\/[^/]+$/.test(url.pathname);
}

function edgeCache(): Cache | null {
  const c = (globalThis as { caches?: { default?: Cache } }).caches;
  return c?.default ?? null;
}

/** The kept copy of `key`, or `make()`'s answer (kept for `ttl` seconds when it is a plain 200). */
async function viaEdge(ctx: ExecutionContext, key: string, make: () => Promise<Response>, ttl = EDGE_TTL_SECONDS): Promise<Response> {
  const cache = edgeCache();
  if (!cache) return make();
  const req = new Request(key, { method: "GET" });
  const hit = await cache.match(req).catch(() => undefined);
  if (hit) {
    const out = new Response(hit.body, hit);
    out.headers.set("cache-control", hit.headers.get(CLIENT_CACHE_HEADER) ?? "no-cache");
    out.headers.delete(CLIENT_CACHE_HEADER);
    return out;
  }
  const res = await make();
  if (res.status === 200 && !res.headers.has("set-cookie")) {
    const copy = new Response(res.clone().body, res);
    copy.headers.set(CLIENT_CACHE_HEADER, res.headers.get("cache-control") ?? "no-cache");
    copy.headers.set("cache-control", `public, max-age=${ttl}`);
    ctx.waitUntil(cache.put(req, copy).catch(() => {}));
  }
  return res;
}

type HeadFor = (svc: Services, o: PageOpts) => Promise<PageHead | null>;

/**
 * index.html with a public page's title, description, picture, language versions
 * and content for search engines (?lang=en for English). An unknown page answers
 * 404 with the app. A slow database never holds the page: the plain app instead.
 */
async function seoPage(request: Request, env: WorkerEnv, ctx: ExecutionContext, headFor: HeadFor): Promise<Response> {
  const page = await shell(request, env);
  if (!page.ok || !(page.headers.get("content-type") ?? "").includes("text/html")) return plainShell(page);
  // Kept a minute at the edge, per version of the app (its shell's ETag), so a deploy never serves pages of the old one.
  const version = page.headers.get("etag");
  if (request.method !== "GET" || !version) return renderSeoPage(request, env, ctx, headFor, page);
  return viaEdge(ctx, `${request.url}${request.url.includes("?") ? "&" : "?"}__v=${encodeURIComponent(version)}`, () => renderSeoPage(request, env, ctx, headFor, page));
}

async function renderSeoPage(request: Request, env: WorkerEnv, ctx: ExecutionContext, headFor: HeadFor, page: Response): Promise<Response> {
  const { svc, finish } = createServices(env);
  try {
    const q = new URL(request.url).searchParams.get("lang");
    const locale = q === "en" || q === "ar" ? q : store.defaultLocale;
    const work = async () => {
      const o: PageOpts = {
        baseUrl: env.PUBLIC_BASE_URL, storeName: store.name, locale, defaultLocale: store.defaultLocale,
        seo: await seoSettings(svc.db), shareImage: `${env.PUBLIC_BASE_URL}/promo/share.jpg`,
      };
      return { o, head: await headFor(svc, o) };
    };
    const r = await within(1500, work());
    if (!r) return plainShell(page);
    const headers = new Headers(page.headers);
    headers.delete("content-length");
    headers.delete("etag");
    headers.set("cache-control", "no-cache");
    headers.set("content-security-policy", PAGE_CSP);
    if (!r.head) {
      headers.set("x-robots-tag", "noindex");
      return withSecurityHeaders(new Response(await page.text(), { status: 404, headers }));
    }
    return withSecurityHeaders(new Response(renderPage(await page.text(), r.head, r.o), { status: 200, headers }));
  } catch (err) {
    console.error("page head failed", err instanceof Error ? err.message : String(err));
    return plainShell(await shell(request, env));
  } finally {
    ctx.waitUntil(finish());
  }
}

async function robots(env: WorkerEnv, ctx: ExecutionContext): Promise<Response> {
  const { svc, finish } = createServices(env);
  try {
    const seo = await within(1000, seoSettings(svc.db)).catch(() => null);
    return new Response(robotsTxt(env.PUBLIC_BASE_URL, { indexing: seo?.indexing ?? true }), {
      headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "public, max-age=600" },
    });
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

/** /llms.txt: the store in Markdown for AI assistants (seo.ts llmsTxt). */
async function llms(env: WorkerEnv, ctx: ExecutionContext): Promise<Response> {
  const { svc, finish } = createServices(env);
  try {
    const text = await within(3000, llmsTxt(svc, env.PUBLIC_BASE_URL));
    if (text === null) return new Response("Not found", { status: 404, headers: { "content-type": "text/plain; charset=utf-8" } });
    return new Response(text, {
      headers: { "content-type": "text/markdown; charset=utf-8", "cache-control": "public, max-age=3600", "x-content-type-options": "nosniff" },
    });
  } catch (err) {
    console.error("llms.txt failed", err instanceof Error ? err.message : String(err));
    return new Response("unavailable", { status: 503, headers: { "retry-after": "300" } });
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
      const api = async () => {
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
      };
      return request.method === "GET" && sharedApiAnswer(url) ? viaEdge(ctx, request.url, api) : api();
    }
    if (request.method === "GET" || request.method === "HEAD") {
      if (url.pathname === "/robots.txt") return viaEdge(ctx, request.url, () => robots(env, ctx), 600);
      if (url.pathname === "/sitemap.xml") return viaEdge(ctx, request.url, () => sitemap(env, ctx), 600);
      if (url.pathname === "/llms.txt") return viaEdge(ctx, request.url, () => llms(env, ctx), 600);
      // Nothing is published under /.well-known/ (e.g. ai-catalog.json): a real 404, not the app.
      if (url.pathname.startsWith("/.well-known/")) return new Response("Not found", { status: 404, headers: { "content-type": "text/plain; charset=utf-8" } });
      if (url.pathname === "/") return seoPage(request, env, ctx, (svc, o) => homeHead(svc, o));
      const product = PRODUCT_PATH.exec(url.pathname)?.[1];
      if (product) return seoPage(request, env, ctx, async (svc, o) => {
        const meta = await productMeta(svc, product);
        return meta ? productHead(meta, o) : null;
      });
      const category = CATEGORY_PATH.exec(url.pathname)?.[1];
      if (category) return seoPage(request, env, ctx, (svc, o) => categoryHead(svc, category, o));
      const legal = LEGAL_PATH.exec(url.pathname)?.[1];
      if (legal) return seoPage(request, env, ctx, (svc, o) => legalHead(svc, legal, o));
    }
    // Only reached for paths listed in run_worker_first that are not ours; let assets answer.
    return env.ASSETS.fetch(request);
  },

  async scheduled(_controller: ScheduledController, env: WorkerEnv, ctx: ExecutionContext): Promise<void> {
    const { svc, ready, finish } = createServices(env);
    ctx.waitUntil(ready().then(() => runScheduled(svc, env)).finally(finish));
  },
} satisfies ExportedHandler<WorkerEnv>;
