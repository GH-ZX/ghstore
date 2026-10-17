/**
 * Cloudflare Web Analytics (Admin → SEO & pages): visits and pages, without
 * cookies. Its beacon follows the app's own page changes (spa). Not loaded on
 * the admin screens, so the staff's own visits are not counted there.
 */
let started = false;

export function startAnalytics(token: string | null | undefined): void {
  if (started || !token || !/^[a-f0-9]{32}$/.test(token)) return;
  if (location.pathname.startsWith("/admin")) return;
  started = true;
  const s = document.createElement("script");
  s.defer = true;
  s.src = "https://static.cloudflareinsights.com/beacon.min.js";
  s.setAttribute("data-cf-beacon", JSON.stringify({ token, spa: true }));
  document.head.appendChild(s);
}
