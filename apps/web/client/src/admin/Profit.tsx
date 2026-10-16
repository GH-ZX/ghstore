/**
 * Admin → Profit (owner): sales, cost and profit over a range of days, with
 * charts by day, supplier, product, category and top-up method, compared with
 * the period before, and a price calculator that uses the store's own pricing
 * rules (the same ones packages are priced by).
 */
import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { store } from "@store/config";
import { minimumPrice, priceFromCost } from "@store/core";
import { dollarsToCents, usd } from "../lib/format";
import { pick } from "../lib/i18n";
import { useT } from "../lib/state";
import { useApi } from "../lib/useApi";
import { ErrorBox, Seg } from "../ui/kit";
import { methodLabel } from "./common";

interface Money {
  salesCents: number;
  profitCents: number;
  orders: number;
}
interface ProfitData {
  from: string;
  to: string;
  totals: Money & {
    costCents: number;
    rewardsCents: number;
    discountsCents: number;
    customers: number;
    refunded: number;
    unknownCost: number;
    inPersonCents: number;
    inPersonOrders: number;
  };
  days: (Money & { date: string })[];
  bySupplier: (Money & { id: string | null; name: string | null; costCents: number })[];
  byProduct: (Money & { id: string; nameEn: string; nameAr: string })[];
  byCategory: (Money & { slug: string; nameEn: string; nameAr: string })[];
  topups: { method: string; amountCents: number; count: number }[];
}

type Range = "7" | "30" | "90" | "365" | "custom";
const DAY = 86_400_000;

/** A day in the store's time zone, as the server counts them. */
const localDay = (d: Date) => new Intl.DateTimeFormat("en-CA", { timeZone: store.timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
const shift = (day: string, days: number) => new Date(Date.parse(`${day}T00:00:00Z`) + days * DAY).toISOString().slice(0, 10);
const spanDays = (from: string, to: string) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY) + 1;
const pct = (part: number, whole: number) => (whole > 0 ? (part / whole) * 100 : 0);

export function Profit() {
  const { t } = useT();
  const today = localDay(new Date());
  const [range, setRange] = useState<Range>("30");
  const [customFrom, setCustomFrom] = useState(shift(today, -29));
  const [customTo, setCustomTo] = useState(today);

  const { from, to } = useMemo(() => {
    if (range !== "custom") return { from: shift(today, -(Number(range) - 1)), to: today };
    const a = customFrom <= customTo ? customFrom : customTo;
    const b = customFrom <= customTo ? customTo : customFrom;
    // The server answers at most 366 days.
    return { from: spanDays(a, b) > 366 ? shift(b, -365) : a, to: b };
  }, [range, customFrom, customTo, today]);
  const days = spanDays(from, to);
  // The same number of days just before, to compare with.
  const prevTo = shift(from, -1);
  const prevFrom = shift(prevTo, -(days - 1));

  const { data, error, reload } = useApi<ProfitData>(`/api/admin/reports/profit?from=${from}&to=${to}`);
  const prev = useApi<ProfitData>(`/api/admin/reports/profit?from=${prevFrom}&to=${prevTo}`);

  return (
    <div className="stack">
      <div className="row-between" style={{ flexWrap: "wrap", gap: 10 }}>
        <Seg<Range>
          label={t("profitRange")}
          value={range}
          onChange={setRange}
          options={[
            { value: "7", label: t("days7") },
            { value: "30", label: t("days30") },
            { value: "90", label: t("days90") },
            { value: "365", label: t("days365") },
            { value: "custom", label: t("profitCustom") },
          ]}
        />
        {range === "custom" && (
          <div className="wrap" style={{ gap: 8 }}>
            <input className="input input--sm num" type="date" aria-label={t("profitFrom")} value={customFrom} max={today} onChange={(e) => e.target.value && setCustomFrom(e.target.value)} />
            <span className="muted">→</span>
            <input className="input input--sm num" type="date" aria-label={t("profitTo")} value={customTo} max={today} onChange={(e) => e.target.value && setCustomTo(e.target.value)} />
          </div>
        )}
      </div>

      {!data ? (
        error ? <ErrorBox error={error} onRetry={reload} /> : <div className="skeleton" style={{ height: 420 }} />
      ) : (
        <Report data={data} prev={prev.data} />
      )}

      <Calculator />
    </div>
  );
}

function Report({ data, prev }: { data: ProfitData; prev: ProfitData | undefined }) {
  const { t, lang } = useT();
  const x = data.totals;
  const margin = pct(x.profitCents, x.salesCents);
  const change = (now: number, before: number | undefined) => {
    if (before === undefined) return null;
    if (before === 0) return now === 0 ? null : { text: t("profitNew"), up: now > 0 };
    const d = ((now - before) / Math.abs(before)) * 100;
    return { text: t("profitVsBefore", { n: `${d >= 0 ? "+" : "−"}${Math.abs(d).toFixed(0)}%` }), up: d >= 0 };
  };
  const p = prev?.totals;

  return (
    <>
      <div className="kpis">
        <Kpi label={t("profitSales")} value={usd(x.salesCents)} delta={change(x.salesCents, p?.salesCents)} />
        <Kpi label={t("profitProfit")} value={usd(x.profitCents)} delta={change(x.profitCents, p?.profitCents)} strong />
        <Kpi label={t("profitMargin")} value={`${margin.toFixed(1)}%`} note={t("profitCostOf", { cost: usd(x.costCents) })} />
        <Kpi label={t("orders")} value={String(x.orders)} delta={change(x.orders, p?.orders)} />
        <Kpi label={t("profitAvgOrder")} value={x.orders ? usd(Math.round(x.salesCents / x.orders)) : "—"} note={t("profitAvgProfit", { n: x.orders ? usd(Math.round(x.profitCents / x.orders)) : "—" })} />
        <Kpi label={t("profitCustomers")} value={String(x.customers)} note={x.refunded ? t("profitRefunded", { n: x.refunded }) : undefined} />
        <Kpi label={t("profitInPerson")} value={usd(x.inPersonCents)} note={t("profitInPersonN", { n: x.inPersonOrders })} />
        <Kpi label={t("profitRewards")} value={usd(x.rewardsCents)} note={x.discountsCents ? t("profitDiscounts", { n: usd(x.discountsCents) }) : undefined} />
      </div>
      {x.unknownCost > 0 && <p className="hint warn-text">{t("profitUnknownCost", { n: x.unknownCost })}</p>}

      <section className="card card--pad stack-sm">
        <div className="row-between" style={{ flexWrap: "wrap", gap: 8 }}>
          <h2>{t("profitTrend")}</h2>
          <span className="chart-legend small">
            <span><i className="chart-key chart-key--sales" />{t("profitSales")}</span>
            <span><i className="chart-key chart-key--profit" />{t("profitProfit")}</span>
          </span>
        </div>
        <TrendChart days={data.days} />
      </section>

      <div className="split-2">
        <section className="card card--pad stack-sm">
          <h2>{t("profitBySupplier")}</h2>
          <Bars
            rows={data.bySupplier.map((s) => ({
              key: s.id ?? "-",
              name: s.name ?? (s.id ? s.id : t("profitOwnStock")),
              value: s.profitCents,
              sub: t("profitRowSub", { sales: usd(s.salesCents), n: s.orders, margin: pct(s.profitCents, s.salesCents).toFixed(0) }),
            }))}
          />
        </section>
        <section className="card card--pad stack-sm">
          <h2>{t("profitTopProducts")}</h2>
          <Bars
            limit={8}
            rows={data.byProduct.map((r) => ({
              key: r.id,
              name: pick(lang, r.nameAr, r.nameEn),
              value: r.profitCents,
              sub: t("profitRowSub", { sales: usd(r.salesCents), n: r.orders, margin: pct(r.profitCents, r.salesCents).toFixed(0) }),
            }))}
          />
        </section>
        <section className="card card--pad stack-sm">
          <h2>{t("profitByCategory")}</h2>
          <Donut
            center={usd(x.salesCents)}
            rows={data.byCategory.map((c) => ({ key: c.slug, name: pick(lang, c.nameAr, c.nameEn), value: c.salesCents, sub: t("profitCatSub", { profit: usd(c.profitCents), n: c.orders }) }))}
          />
        </section>
        <section className="card card--pad stack-sm">
          <h2>{t("profitTopups")}</h2>
          <Donut
            center={usd(data.topups.reduce((n, m) => n + m.amountCents, 0))}
            rows={data.topups.map((m) => ({ key: m.method, name: methodLabel(t, m.method), value: m.amountCents, sub: t("profitTopupSub", { n: m.count }) }))}
          />
        </section>
      </div>
    </>
  );
}

function Kpi({ label, value, delta, note, strong }: { label: string; value: string; delta?: { text: string; up: boolean } | null; note?: string; strong?: boolean }) {
  return (
    <div className={strong ? "kpi kpi--strong" : "kpi"}>
      <span className="small muted">{label}</span>
      <span className="num">{value}</span>
      {delta && <span className={delta.up ? "small good" : "small bad"}>{delta.text}</span>}
      {!delta && note && <span className="small muted">{note}</span>}
    </div>
  );
}

/** Width of an element, kept up to date (charts draw in real pixels so text stays readable). */
function useWidth<T extends HTMLElement>(): [RefObject<T | null>, number] {
  const ref = useRef<T | null>(null);
  const [w, setW] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    setW(el.clientWidth);
    const ro = new ResizeObserver(() => setW(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, w];
}

/** Days grouped into what fits: days up to 45, then weeks, then months. */
function buckets(days: ProfitData["days"], lang: "ar" | "en") {
  const locale = lang === "ar" ? "ar-SY-u-nu-latn" : "en-GB";
  const fmt = (d: string, o: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat(locale, { timeZone: "UTC", ...o }).format(new Date(`${d}T00:00:00Z`));
  const by = days.length <= 45 ? "day" : days.length <= 120 ? "week" : "month";
  const out: { key: string; label: string; long: string; salesCents: number; profitCents: number; orders: number }[] = [];
  days.forEach((d, i) => {
    const key = by === "day" ? d.date : by === "week" ? String(Math.floor(i / 7)) : d.date.slice(0, 7);
    let b = out.at(-1);
    if (!b || b.key !== key) {
      b = {
        key,
        label: by === "month" ? fmt(d.date, { month: "short" }) : fmt(d.date, { day: "numeric", month: "short" }),
        long: by === "month" ? fmt(d.date, { month: "long", year: "numeric" }) : by === "week" ? fmt(d.date, { day: "numeric", month: "short" }) : fmt(d.date, { weekday: "short", day: "numeric", month: "short" }),
        salesCents: 0,
        profitCents: 0,
        orders: 0,
      };
      out.push(b);
    }
    b.salesCents += d.salesCents;
    b.profitCents += d.profitCents;
    b.orders += d.orders;
  });
  return { by, out };
}

/** Compact money for chart axes: $0, $40, $1.2k. */
const axisUsd = (cents: number) => {
  const d = cents / 100;
  if (Math.abs(d) >= 1000) return `$${(d / 1000).toFixed(Math.abs(d) >= 10_000 ? 0 : 1)}k`;
  return `$${Math.round(d)}`;
};

function TrendChart({ days }: { days: ProfitData["days"] }) {
  const { t, lang } = useT();
  const [ref, width] = useWidth<HTMLDivElement>();
  const [sel, setSel] = useState<number | null>(null);
  const { by, out } = useMemo(() => buckets(days, lang), [days, lang]);
  const rtl = lang === "ar";
  const H = 200;
  const padTop = 10;
  const padBottom = 24;
  const padSide = 44;
  const top = Math.max(100, ...out.map((b) => b.salesCents), ...out.map((b) => b.profitCents));
  const bottom = Math.min(0, ...out.map((b) => b.profitCents));
  // A round step for the grid lines.
  const raw = (top - bottom) / 4;
  const mag = 10 ** Math.floor(Math.log10(Math.max(raw, 1)));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? raw;
  const yMax = Math.ceil(top / step) * step;
  const yMin = Math.floor(bottom / step) * step;
  const plotW = Math.max(0, width - padSide - 8);
  // The money labels sit on the reading side's start: left in English, right in Arabic.
  const plotLeft = rtl ? 8 : padSide;
  const plotRight = plotLeft + plotW;
  const plotH = H - padTop - padBottom;
  const y = (v: number) => padTop + ((yMax - v) / (yMax - yMin || 1)) * plotH;
  const col = plotW / Math.max(1, out.length);
  const barW = Math.max(2, Math.min(28, col * 0.62));
  // Arabic reads right to left: the newest day is on the left.
  const cx = (i: number) => (rtl ? plotRight - (i + 0.5) * col : plotLeft + (i + 0.5) * col);
  const labelEvery = Math.max(1, Math.ceil(out.length / Math.max(2, Math.floor(plotW / 64))));
  const grid: number[] = [];
  for (let v = yMin; v <= yMax + 1e-6; v += step) grid.push(v);
  const picked = sel !== null ? out[sel] : undefined;
  const sums = out.reduce((s, b) => ({ sales: s.sales + b.salesCents, profit: s.profit + b.profitCents, orders: s.orders + b.orders }), { sales: 0, profit: 0, orders: 0 });
  const empty = sums.orders === 0;

  return (
    <div className="stack-sm">
      <p className="small chart-readout" aria-live="polite">
        {picked ? (
          <>
            <strong>{picked.long}</strong>
            {by === "week" && <span className="muted"> ({t("profitWeekOf")})</span>} · {t("profitSales")} {usd(picked.salesCents)} · {t("profitProfit")} {usd(picked.profitCents)} · {t("profitOrdersN", { n: picked.orders })}
          </>
        ) : (
          <span className="muted">{empty ? t("profitNoSales") : t("profitTapHint")}</span>
        )}
      </p>
      <div ref={ref} className="chart" onMouseLeave={() => setSel(null)}>
        {width > 0 && (
          <svg width={width} height={H} role="img" aria-label={t("profitTrend")}>
            {grid.map((v) => (
              <g key={v}>
                <line x1={plotLeft} x2={plotRight} y1={y(v)} y2={y(v)} className={v === 0 ? "chart-zero" : "chart-grid"} />
                <text x={rtl ? plotRight + 6 : plotLeft - 6} y={y(v) + 4} textAnchor={rtl ? "start" : "end"} direction="ltr" className="chart-axis">
                  {axisUsd(v)}
                </text>
              </g>
            ))}
            {out.map((b, i) => {
              const x0 = cx(i) - barW / 2;
              const active = sel === i;
              return (
                <g key={b.key} opacity={sel === null || active ? 1 : 0.45}>
                  <rect x={x0} width={barW} y={y(Math.max(0, b.salesCents))} height={Math.max(0, y(0) - y(Math.max(0, b.salesCents)))} rx={Math.min(4, barW / 3)} className="chart-sales" />
                  {b.profitCents !== 0 && (
                    <rect
                      x={x0 + barW * 0.2}
                      width={barW * 0.6}
                      y={b.profitCents > 0 ? y(b.profitCents) : y(0)}
                      height={Math.abs(y(b.profitCents) - y(0))}
                      rx={Math.min(3, barW / 4)}
                      className={b.profitCents > 0 ? "chart-profit" : "chart-loss"}
                    />
                  )}
                  {i % labelEvery === 0 && (
                    <text x={cx(i)} y={H - 6} textAnchor="middle" className="chart-axis">
                      {b.label}
                    </text>
                  )}
                  <rect
                    x={cx(i) - col / 2}
                    width={col}
                    y={padTop}
                    height={plotH}
                    fill="transparent"
                    onMouseEnter={() => setSel(i)}
                    onClick={() => setSel(active ? null : i)}
                  />
                </g>
              );
            })}
          </svg>
        )}
      </div>
    </div>
  );
}

interface Row {
  key: string;
  name: string;
  value: number;
  sub: string;
}

/** Horizontal bars, the biggest first, with "show all" past the limit. */
function Bars({ rows, limit = 6 }: { rows: Row[]; limit?: number }) {
  const { t } = useT();
  const [all, setAll] = useState(false);
  if (rows.length === 0) return <p className="muted small">{t("profitNoSales")}</p>;
  const max = Math.max(1, ...rows.map((r) => Math.abs(r.value)));
  const shown = all ? rows : rows.slice(0, limit);
  return (
    <div className="hbars">
      {shown.map((r) => (
        <div key={r.key} className="hbar">
          <div className="row-between" style={{ gap: 8 }}>
            <span className="hbar__name">{r.name}</span>
            <strong className={r.value < 0 ? "num bad" : "num"}>{usd(r.value)}</strong>
          </div>
          <div className="hbar__track">
            <span className={r.value < 0 ? "hbar__fill hbar__fill--loss" : "hbar__fill"} style={{ width: `${Math.max(2, (Math.abs(r.value) / max) * 100)}%` }} />
          </div>
          <span className="small muted">{r.sub}</span>
        </div>
      ))}
      {rows.length > limit && (
        <button type="button" className="btn btn--xs btn--ghost press" style={{ alignSelf: "flex-start" }} onClick={() => setAll((v) => !v)}>
          {all ? t("showLess") : t("showAllN", { n: rows.length })}
        </button>
      )}
    </div>
  );
}

const SHADES = [
  "var(--accent)",
  "var(--good)",
  "var(--warn)",
  "var(--dot)",
  "color-mix(in srgb, var(--accent) 55%, var(--ink))",
  "color-mix(in srgb, var(--good) 45%, var(--surface-2))",
  "var(--muted)",
];

/** A ring of shares (the six biggest, the rest as "Other") with its legend. */
function Donut({ rows, center }: { rows: Row[]; center: string }) {
  const { t } = useT();
  const [sel, setSel] = useState<string | null>(null);
  const total = rows.reduce((n, r) => n + Math.max(0, r.value), 0);
  if (total <= 0) return <p className="muted small">{t("profitNoSales")}</p>;
  const sorted = [...rows].filter((r) => r.value > 0).sort((a, b) => b.value - a.value);
  const top = sorted.slice(0, 6);
  const rest = sorted.slice(6);
  if (rest.length) top.push({ key: "_other", name: t("profitOther"), value: rest.reduce((n, r) => n + r.value, 0), sub: t("profitOtherN", { n: rest.length }) });
  const R = 52;
  const C = 2 * Math.PI * R;
  let at = 0;
  const picked = top.find((r) => r.key === sel);
  return (
    <div className="donut">
      <svg width="140" height="140" viewBox="0 0 140 140" role="img" aria-label={center}>
        <circle cx="70" cy="70" r={R} className="donut__track" />
        {top.map((r, i) => {
          const len = (r.value / total) * C;
          const seg = (
            <circle
              key={r.key}
              cx="70"
              cy="70"
              r={R}
              fill="none"
              stroke={SHADES[i % SHADES.length]}
              strokeWidth={sel === r.key ? 20 : 16}
              strokeDasharray={`${Math.max(0, len - 1.5)} ${C}`}
              strokeDashoffset={-at}
              transform="rotate(-90 70 70)"
              style={{ transition: "stroke-width .2s ease", cursor: "pointer" }}
              onMouseEnter={() => setSel(r.key)}
              onMouseLeave={() => setSel(null)}
              onClick={() => setSel(sel === r.key ? null : r.key)}
            />
          );
          at += len;
          return seg;
        })}
        <text x="70" y={picked ? 66 : 75} textAnchor="middle" className="donut__center num">
          {picked ? `${pct(picked.value, total).toFixed(0)}%` : center}
        </text>
        {picked && (
          <text x="70" y="86" textAnchor="middle" className="chart-axis">
            {usd(picked.value)}
          </text>
        )}
      </svg>
      <ul className="donut__legend">
        {top.map((r, i) => (
          <li key={r.key} aria-current={sel === r.key ? "true" : undefined} onMouseEnter={() => setSel(r.key)} onMouseLeave={() => setSel(null)}>
            <i style={{ background: SHADES[i % SHADES.length] }} />
            <span className="donut__name">{r.name}</span>
            <span className="num small">{pct(r.value, total).toFixed(0)}%</span>
            <span className="small muted donut__sub">
              {usd(r.value)} · {r.sub}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

// ───────────────────────────── calculator

interface CatalogLite {
  products: { id: string; name_ar: string; name_en: string }[];
  offers: {
    id: string;
    product_id: string;
    name_ar: string;
    name_en: string;
    cost_cents: number | null;
    price_cents: number;
    markup_mode: "percent" | "fixed" | "manual";
    markup_value: string | number;
    round_to_cents: number;
    min_margin_pct: string | number;
  }[];
}

const ROUNDINGS = [1, 5, 10, 25, 50, 100];

/**
 * What a package earns: from its cost and a markup (or a price you choose, or
 * the profit you want), less the payment provider's fee, and over a month.
 */
function Calculator() {
  const { t, lang } = useT();
  const [mode, setMode] = useState<"markup" | "price" | "target">("markup");
  const [cost, setCost] = useState("10.00");
  const [markupMode, setMarkupMode] = useState<"percent" | "fixed">("percent");
  const [markup, setMarkup] = useState("15");
  const [round, setRound] = useState(1);
  const [minMargin, setMinMargin] = useState("5");
  const [price, setPrice] = useState("");
  const [target, setTarget] = useState("1.50");
  const [fee, setFee] = useState("0");
  const [perDay, setPerDay] = useState("5");
  const [offerId, setOfferId] = useState("");
  const catalog = useApi<CatalogLite>("/api/admin/catalog");

  const costCents = dollarsToCents(cost) ?? 0;
  const feePct = Math.min(50, Math.max(0, Number(fee) || 0));
  const minPct = Math.max(0, Number(minMargin) || 0);
  const floor = minimumPrice(costCents, minPct);
  const step = Math.max(1, round);

  const priceCents = useMemo(() => {
    if (mode === "price") return dollarsToCents(price) ?? 0;
    if (mode === "target") {
      // The price whose net (after the fee) leaves the wanted profit, rounded like the package would be.
      const want = dollarsToCents(target) ?? 0;
      const raw = Math.ceil((costCents + want) / (1 - feePct / 100));
      return Math.ceil(raw / step) * step;
    }
    const v = Number(markup) || 0;
    return priceFromCost(costCents, { mode: markupMode, value: markupMode === "fixed" ? Math.round(v * 100) : v, roundToCents: step, minMarginPct: minPct });
  }, [mode, price, target, costCents, feePct, step, markup, markupMode, minPct]);

  const feeCents = Math.round((priceCents * feePct) / 100);
  const profit = priceCents - feeCents - costCents;
  const n = Math.max(0, Math.round(Number(perDay) || 0));
  const below = priceCents < floor;

  function fillFromPackage(id: string) {
    setOfferId(id);
    const o = catalog.data?.offers.find((x) => x.id === id);
    if (!o) return;
    setCost(((o.cost_cents ?? 0) / 100).toFixed(2));
    setMinMargin(String(Number(o.min_margin_pct)));
    setRound(ROUNDINGS.includes(o.round_to_cents) ? o.round_to_cents : 1);
    if (o.markup_mode === "manual") {
      setMode("price");
      setPrice((o.price_cents / 100).toFixed(2));
    } else {
      setMode("markup");
      setMarkupMode(o.markup_mode);
      setMarkup(String(o.markup_mode === "fixed" ? Number(o.markup_value) / 100 : Number(o.markup_value)));
    }
  }

  const groups = useMemo(() => {
    const c = catalog.data;
    if (!c) return [];
    const names = new Map(c.products.map((p) => [p.id, pick(lang, p.name_ar, p.name_en)]));
    const by = new Map<string, CatalogLite["offers"]>();
    for (const o of c.offers) {
      if (o.cost_cents === null) continue;
      const list = by.get(o.product_id) ?? [];
      list.push(o);
      by.set(o.product_id, list);
    }
    return [...by.entries()].map(([pid, offers]) => ({ name: names.get(pid) ?? "", offers })).sort((a, b) => a.name.localeCompare(b.name));
  }, [catalog.data, lang]);

  const money = (v: string, set: (s: string) => void, label: string, hint?: string) => (
    <label className="field">
      <span>{label}</span>
      <span className="input-wrap">
        <span className="input-wrap__pre muted">$</span>
        <input className="input num" inputMode="decimal" value={v} onChange={(e) => set(e.target.value.replace(/[^\d.]/g, "").slice(0, 10))} />
      </span>
      {hint && <span className="hint">{hint}</span>}
    </label>
  );

  return (
    <section className="card card--pad stack">
      <div>
        <h2>{t("calcTitle")}</h2>
        <p className="hint">{t("calcHint")}</p>
      </div>
      {groups.length > 0 && (
        <label className="field">
          <span>{t("calcFromPackage")}</span>
          <select className="select" value={offerId} onChange={(e) => fillFromPackage(e.target.value)}>
            <option value="">{t("calcPickPackage")}</option>
            {groups.map((g) => (
              <optgroup key={g.name} label={g.name}>
                {g.offers.map((o) => (
                  <option key={o.id} value={o.id}>
                    {g.name} · {pick(lang, o.name_ar, o.name_en)} — {usd(o.cost_cents ?? 0)} → {usd(o.price_cents)}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
        </label>
      )}
      <Seg
        label={t("calcTitle")}
        value={mode}
        onChange={setMode}
        options={[
          { value: "markup", label: t("calcByMarkup") },
          { value: "price", label: t("calcByPrice") },
          { value: "target", label: t("calcByTarget") },
        ]}
      />
      <div className="form-grid">
        {money(cost, setCost, t("calcCost"))}
        {mode === "markup" && (
          <label className="field">
            <span>{t("calcMarkup")}</span>
            <span className="input-wrap">
              <input className="input num" inputMode="decimal" value={markup} onChange={(e) => setMarkup(e.target.value.replace(/[^\d.]/g, "").slice(0, 8))} />
              <Seg
                label={t("calcMarkup")}
                value={markupMode}
                onChange={setMarkupMode}
                options={[
                  { value: "percent", label: "%" },
                  { value: "fixed", label: "$" },
                ]}
              />
            </span>
          </label>
        )}
        {mode === "price" && money(price, setPrice, t("calcPrice"))}
        {mode === "target" && money(target, setTarget, t("calcTarget"), t("calcTargetHint"))}
        <label className="field">
          <span>{t("calcRound")}</span>
          <select className="select" value={round} onChange={(e) => setRound(Number(e.target.value))}>
            {ROUNDINGS.map((r) => (
              <option key={r} value={r}>
                {r === 1 ? t("calcNoRound") : usd(r)}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>{t("calcMinMargin")}</span>
          <input className="input num" inputMode="decimal" value={minMargin} onChange={(e) => setMinMargin(e.target.value.replace(/[^\d.]/g, "").slice(0, 5))} />
          <span className="hint">{t("calcMinMarginHint", { n: usd(floor) })}</span>
        </label>
        <label className="field">
          <span>{t("calcFee")}</span>
          <input className="input num" inputMode="decimal" value={fee} onChange={(e) => setFee(e.target.value.replace(/[^\d.]/g, "").slice(0, 5))} />
          <span className="hint">{t("calcFeeHint")}</span>
        </label>
        <label className="field">
          <span>{t("calcPerDay")}</span>
          <input className="input num" inputMode="numeric" value={perDay} onChange={(e) => setPerDay(e.target.value.replace(/\D/g, "").slice(0, 5))} />
        </label>
      </div>

      <div className="calc-out">
        <div>
          <span className="small muted">{t("calcSellAt")}</span>
          <strong className="num calc-out__big">{usd(priceCents)}</strong>
          {below && <span className="small bad">{t("calcBelowFloor", { n: usd(floor) })}</span>}
        </div>
        <div>
          <span className="small muted">{t("calcProfitEach")}</span>
          <strong className={profit < 0 ? "num calc-out__big bad" : "num calc-out__big"}>{usd(profit)}</strong>
          {feeCents > 0 && <span className="small muted">{t("calcFeeEach", { n: usd(feeCents) })}</span>}
        </div>
        <div>
          <span className="small muted">{t("calcMargins")}</span>
          <strong className="num calc-out__big">{priceCents > 0 ? `${pct(profit, priceCents).toFixed(1)}%` : "—"}</strong>
          <span className="small muted">{t("calcOnCost", { n: costCents > 0 ? `${pct(profit, costCents).toFixed(1)}%` : "—" })}</span>
        </div>
        <div>
          <span className="small muted">{t("calcMonth", { n })}</span>
          <strong className={profit < 0 ? "num calc-out__big bad" : "num calc-out__big"}>{usd(profit * n * 30)}</strong>
          <span className="small muted">{t("calcMonthSales", { n: usd(priceCents * n * 30) })}</span>
        </div>
      </div>
    </section>
  );
}
