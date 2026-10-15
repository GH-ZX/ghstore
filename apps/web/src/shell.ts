/**
 * Temporary page for everything outside /api while the React app is being built
 * (next milestone). It already uses the real theme tokens and logo, so the
 * deployed Worker can be checked end to end: brand, theme switching, and the
 * /api/health endpoint.
 */
import { googleFontsHref, iconSvg, isPreset, logoSvg, themeCss, type ThemePreset } from "@store/ui";
import type { WorkerEnv } from "./services";

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string);
}

export function renderShell(url: URL, env: WorkerEnv): Response {
  if (url.pathname === "/favicon.svg") {
    return new Response(iconSvg({ size: 64, simple: true }), { headers: { "content-type": "image/svg+xml", "cache-control": "public, max-age=86400" } });
  }
  const preset: ThemePreset = isPreset(env.THEME_PRESET) ? env.THEME_PRESET : "energetic";
  const lang = url.searchParams.get("lang") === "en" ? "en" : "ar";
  const title = lang === "ar" ? "GH Store · المتجر الجديد قريباً" : "GH Store · new store coming soon";
  const line = lang === "ar" ? "نبني نسخة جديدة من المتجر. ترقبوا." : "We are building a new version of the store. Stay tuned.";
  const html = `<!doctype html>
<html lang="${lang}" dir="${lang === "ar" ? "rtl" : "ltr"}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${escapeHtml(title)}</title>
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="stylesheet" href="${googleFontsHref(preset)}">
<style>${themeCss(preset)}
html,body{margin:0;min-height:100%;background:var(--bg);color:var(--ink);font-family:var(--font)}
main{min-height:100dvh;display:grid;place-items:center;padding:24px;box-sizing:border-box}
.card{max-width:420px;width:100%;background:var(--surface);border:1px solid var(--line);border-radius:28px;padding:32px;display:flex;flex-direction:column;gap:16px;align-items:center;text-align:center}
p{margin:0;color:var(--muted);line-height:1.7}
a{color:var(--accent-text)}
</style>
</head>
<body><main><div class="card">${logoSvg({ height: 48 })}<p>${escapeHtml(line)}</p><a href="?lang=${lang === "ar" ? "en" : "ar"}">${lang === "ar" ? "English" : "العربية"}</a></div></main></body>
</html>`;
  return new Response(html, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
}
