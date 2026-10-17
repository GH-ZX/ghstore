/** The bottom of the store's pages: its terms, privacy and refund pages (Admin → SEO & pages) and the year. */
import { store } from "@store/config";
import { pick } from "../lib/i18n";
import { linkHandler } from "../lib/router";
import { useApp, useT } from "../lib/state";

export function SiteFooter() {
  const { config } = useApp();
  const { t, lang } = useT();
  const pages = config?.pages ?? [];
  return (
    <footer className="site-footer">
      {pages.length > 0 && (
        <nav className="site-footer__links" aria-label={t("legalPages")}>
          {pages.map((p) => (
            <a key={p.slug} href={`/legal/${p.slug}`} onClick={linkHandler(`/legal/${p.slug}`)}>
              {pick(lang, p.titleAr, p.titleEn)}
            </a>
          ))}
        </nav>
      )}
      <p className="site-footer__copy">
        © {new Date().getFullYear()} {store.name} · {t("footerRights")}
      </p>
    </footer>
  );
}
