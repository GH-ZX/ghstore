/**
 * The sign-in page's art half (loaded on its own, after the form): the store's
 * products drifting past and a card showing one product after another.
 */
import { memo, useEffect, useMemo, useState } from "react";
import { usd } from "../lib/format";
import { pick } from "../lib/i18n";
import { useT } from "../lib/state";
import type { Category, ProductCard } from "../lib/types";
import { useApi } from "../lib/useApi";
import { BoltIcon, MethodMark, WalletIcon } from "../ui/icons";
import { Tile } from "../ui/kit";

/**
 * Products with a real picture, one category after another (games, AI, gift
 * cards, numbers…), so the mix shows the whole store, each picture once.
 */
function mixAcross(products: ProductCard[]): ProductCard[] {
  const seen = new Set<string>();
  const groups = new Map<string, ProductCard[]>();
  for (const p of [...products].sort((a, b) => Number(b.featured) - Number(a.featured))) {
    if (!p.imageUrl || /simpleicons|favicons|\.svg(\?|$)/i.test(p.imageUrl) || seen.has(p.imageUrl)) continue;
    seen.add(p.imageUrl);
    groups.set(p.category, [...(groups.get(p.category) ?? []), p]);
  }
  const lists = [...groups.values()];
  const out: ProductCard[] = [];
  for (let i = 0; out.length < 36 && lists.some((l) => l[i]); i++) for (const l of lists) if (l[i]) out.push(l[i]!);
  return out;
}

const ROW = 12;
const NEXT_MS = 2800;

/**
 * The sign-in page's other half, always moving: three rows of the store's
 * products drifting past, soft colours slowly changing place, and a card that
 * shows one product after another (its category, name and price).
 */
export function LoginArt() {
  const { t, lang } = useT();
  const { data } = useApi<{ products: ProductCard[]; categories: Category[] }>("/api/catalog");
  const mix = useMemo(() => mixAcross(data?.products ?? []), [data]);
  const rows = useMemo(() => {
    const n = mix.length;
    if (!n) return [];
    const shift = Math.max(1, Math.floor(n / 3));
    return [0, 1, 2].map((r) => Array.from({ length: ROW }, (_, i) => mix[(r * shift + i) % n]!));
  }, [mix]);
  return (
    <aside className="login__art" dir={lang === "ar" ? "rtl" : "ltr"} aria-hidden="true">
      <i className="login__blob login__blob--a" />
      <i className="login__blob login__blob--b" />
      <i className="login__blob login__blob--c" />
      <Rows rows={rows} />
      <NowCard mix={mix} categories={data?.categories} />
      <div className="login__pitch">
        <h2>{t("loginArtTitle")}</h2>
        <ul>
          <li>
            <span className="login__perk-icon"><BoltIcon size={16} /></span>
            {t("loginPerk1")}
          </li>
          <li>
            <span className="login__perk-icon"><WalletIcon size={16} /></span>
            {t("loginPerk2")}
          </li>
          <li>
            <span className="login__marks">
              <MethodMark method="sam" size={24} />
              <MethodMark method="bep20" size={24} />
              <MethodMark method="stars" size={24} />
            </span>
            {t("loginPerk3")}
          </li>
        </ul>
      </div>
    </aside>
  );
}

/** The drifting rows: drawn once per catalogue, never re-rendered by the card's timer. */
const Rows = memo(function Rows({ rows }: { rows: ProductCard[][] }) {
  return (
    <div className="login__rows" dir="ltr">
      {rows.map((row, r) => (
        <div key={r} className={`login__row login__row--${r}`}>
          <div className="login__track">
            {[...row, ...row].map((p, i) => (
              <Tile key={i} name={p.nameEn} imageUrl={p.imageUrl} className="login__tile" />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
});

/** One product after another, every NEXT_MS: only this card changes. */
function NowCard({ mix, categories }: { mix: ProductCard[]; categories: Category[] | undefined }) {
  const { t, lang } = useT();
  const [at, setAt] = useState(0);
  useEffect(() => {
    if (mix.length < 2) return;
    const id = setInterval(() => setAt((i) => (i + 1) % mix.length), NEXT_MS);
    return () => clearInterval(id);
  }, [mix.length]);
  const cur = mix.length ? mix[at % mix.length] : undefined;
  if (!cur) return null;
  const cat = categories?.find((c) => c.slug === cur.category);
  return (
    <div className="login__now" key={at}>
      <Tile name={cur.nameEn} imageUrl={cur.imageUrl} className="login__now-tile" />
      <span className="login__now-text">
        {cat && <span className="login__now-cat">{pick(lang, cat.nameAr, cat.nameEn)}</span>}
        <b>{pick(lang, cur.nameAr, cur.nameEn)}</b>
        <span className="login__now-price">
          {t("from")} <span className="num">{usd(cur.fromCents)}</span>
          {!cur.byHand && <em>⚡ {t("instant")}</em>}
        </span>
      </span>
      <i className="login__now-bar" />
    </div>
  );
}
