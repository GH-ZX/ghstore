/**
 * The store's own pages at /legal/<slug>: the terms, privacy and refund policies
 * and any page the owner adds (Admin → SEO & pages). Their text uses a few marks
 * (parseDoc in @store/core), shown here as headings, lists, bold and links.
 */
import { Fragment, useEffect, useMemo, type MouseEvent } from "react";
import { store } from "@store/config";
import { parseDoc, parseSpans } from "@store/core";
import { pick } from "../lib/i18n";
import { navigate } from "../lib/router";
import { useT } from "../lib/state";
import { openExternal, openTelegramLink } from "../lib/telegram";
import { useApi } from "../lib/useApi";
import { SiteFooter } from "../ui/Footer";
import { ErrorBox, PageLoading } from "../ui/kit";
import { Shell } from "../ui/Shell";

interface PageData {
  slug: string;
  titleAr: string;
  titleEn: string;
  bodyAr: string;
  bodyEn: string;
  updatedAt: string;
}

export function LegalPage({ slug }: { slug: string }) {
  const { t, lang } = useT();
  const { data, error, reload } = useApi<PageData>(`/api/pages/${encodeURIComponent(slug)}`);
  const title = data ? pick(lang, data.titleAr, data.titleEn) : "";
  useEffect(() => {
    if (title) document.title = `${title} | ${store.name}`;
  }, [title]);
  const date = data
    ? new Intl.DateTimeFormat(lang === "ar" ? "ar-SY-u-nu-latn" : "en-GB", { day: "numeric", month: "long", year: "numeric" }).format(new Date(data.updatedAt))
    : "";
  return (
    <Shell title={title || undefined}>
      <div className="stack screen legal">
        {!data && !error && <PageLoading />}
        <ErrorBox error={data ? null : error} onRetry={reload} />
        {data && (
          <article className="card card--pad legal__doc">
            <h1>{title}</h1>
            <p className="small muted">{t("legalUpdated", { date })}</p>
            <Prose source={pick(lang, data.bodyAr, data.bodyEn)} />
          </article>
        )}
        <SiteFooter />
      </div>
    </Shell>
  );
}

/** Page text with its marks shown as headings, lists, bold and links. */
export function Prose({ source }: { source: string }) {
  const blocks = useMemo(() => parseDoc(source), [source]);
  return (
    <div className="doc">
      {blocks.map((b, i) =>
        b.type === "ul" ? (
          <ul key={i}>
            {b.items.map((item, j) => (
              <li key={j}>
                <Spans text={item} />
              </li>
            ))}
          </ul>
        ) : b.type === "h2" ? (
          <h2 key={i}>
            <Spans text={b.text} />
          </h2>
        ) : b.type === "h3" ? (
          <h3 key={i}>
            <Spans text={b.text} />
          </h3>
        ) : (
          <p key={i}>
            <Spans text={b.text} />
          </p>
        ),
      )}
    </div>
  );
}

/** A link inside the page: the store's own pages open in place, Telegram links in Telegram, others outside. */
function follow(e: MouseEvent<HTMLAnchorElement>, href: string) {
  if (href.startsWith("mailto:")) return;
  e.preventDefault();
  if (href.startsWith(location.origin)) navigate(href.slice(location.origin.length) || "/");
  else if (/^https:\/\/t\.me\//.test(href)) openTelegramLink(href);
  else openExternal(href);
}

function Spans({ text }: { text: string }) {
  return (
    <>
      {parseSpans(text).map((s, i) =>
        s.type === "bold" ? (
          <strong key={i}>{s.text}</strong>
        ) : s.type === "link" ? (
          <a key={i} href={s.href} rel="noopener" onClick={(e) => follow(e, s.href)}>
            <bdi>{s.text}</bdi>
          </a>
        ) : (
          <Fragment key={i}>{s.text}</Fragment>
        ),
      )}
    </>
  );
}
