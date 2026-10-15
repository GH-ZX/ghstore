/**
 * Entry point of the single GH Store Worker.
 *   /api/*             JSON API used by the website, the Mini App and the admin
 *   /telegram/webhook  Telegram bot updates (secret-header protected)
 *   everything else    the web app: static files from dist/ (website, /tg Mini App,
 *                      /admin), served by Cloudflare without running this code
 * Cron (every minute): fulfilment, payment re-checks, supplier sync, notifications.
 */
import { handle, handleBotWebhook, runScheduled } from "@store/api";
import { createServices, type WorkerEnv } from "./services";

const SECURITY_HEADERS: Record<string, string> = {
  "strict-transport-security": "max-age=31536000; includeSubDomains",
  "x-content-type-options": "nosniff",
  "referrer-policy": "strict-origin-when-cross-origin",
  "permissions-policy": "camera=(), microphone=(), geolocation=()",
};

function withSecurityHeaders(res: Response): Response {
  const out = new Response(res.body, res);
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) out.headers.set(k, v);
  return out;
}

export default {
  async fetch(request: Request, env: WorkerEnv, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/") || url.pathname === "/telegram/webhook") {
      const { svc, finish } = createServices(env);
      try {
        const res =
          url.pathname === "/telegram/webhook" && request.method === "POST"
            ? await handleBotWebhook(request, env, svc)
            : await handle(request, env, svc);
        return withSecurityHeaders(res);
      } finally {
        ctx.waitUntil(finish());
      }
    }
    // Only reached for paths listed in run_worker_first that are not ours; let assets answer.
    return env.ASSETS.fetch(request);
  },

  async scheduled(_controller: ScheduledController, env: WorkerEnv, ctx: ExecutionContext): Promise<void> {
    const { svc, finish } = createServices(env);
    ctx.waitUntil(runScheduled(svc, env).finally(finish));
  },
} satisfies ExportedHandler<WorkerEnv>;
