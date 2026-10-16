/** Orders list and order detail with copyable deliveries; virtual numbers get their own panel. */
import { useEffect, useState } from "react";
import { api, ApiFail } from "../lib/api";
import { copyText, dateTime, usd } from "../lib/format";
import { errorText, pick } from "../lib/i18n";
import { linkHandler, navigate } from "../lib/router";
import { toast, useT } from "../lib/state";
import { haptic } from "../lib/telegram";
import { useApi } from "../lib/useApi";
import type { OrderDetail, OrderRow, OrderStatus } from "../lib/types";
import { ChevronIcon } from "../ui/icons";
import { Empty, ErrorBox, Spinner } from "../ui/kit";
import { Shell } from "../ui/Shell";
import { RequireUser } from "./Login";

export const STATUS_COLOR: Record<OrderStatus, string> = {
  paid: "var(--warn)",
  processing: "var(--warn)",
  delivered: "var(--good)",
  failed: "var(--bad)",
  refunded: "var(--muted)",
};

export function Orders() {
  const { t } = useT();
  return (
    <Shell title={t("orders")} narrow>
      <RequireUser>
        <OrderList />
      </RequireUser>
    </Shell>
  );
}

function OrderList() {
  const { t, lang } = useT();
  const { data, error, loading, reload } = useApi<{ orders: OrderRow[] }>("/api/orders");
  const [more, setMore] = useState<OrderRow[]>([]);
  const [end, setEnd] = useState(false);
  const [busy, setBusy] = useState(false);
  const rows = [...(data?.orders ?? []), ...more];

  async function loadMore() {
    const last = rows[rows.length - 1];
    if (!last) return;
    setBusy(true);
    try {
      const r = await api<{ orders: OrderRow[] }>(`/api/orders?before=${last.number}`);
      setMore((m) => [...m, ...r.orders]);
      if (r.orders.length < 30) setEnd(true);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="stack screen">
      <h1>{t("myOrders")}</h1>
      {loading && !data && <div className="skeleton" style={{ height: 220 }} />}
      <ErrorBox error={data ? null : error} onRetry={reload} />
      {data && rows.length === 0 && <Empty>{t("noOrders")}</Empty>}
      {rows.length > 0 && (
        <div className="list">
          {rows.map((o) => (
            <a key={o.id} className="list-row" href={`/orders/${o.id}`} onClick={linkHandler(`/orders/${o.id}`)}>
              <span className="dot" style={{ background: STATUS_COLOR[o.status] }} />
              <span className="list-row__main">
                <span className="list-row__title">{pick(lang, o.productAr, o.productEn)}</span>
                <span className="list-row__meta">
                  {pick(lang, o.packageAr, o.packageEn)} · <span className="num">#{o.number}</span> · {dateTime(o.createdAt, lang)}
                </span>
              </span>
              <span className="list-row__end">
                <span className="num" style={{ fontWeight: 700 }}>
                  {usd(o.totalCents)}
                </span>
                <span className="small" style={{ color: STATUS_COLOR[o.status], fontWeight: 600 }}>
                  {t(`st_${o.status}`)}
                </span>
              </span>
              <span className="muted">
                <ChevronIcon />
              </span>
            </a>
          ))}
        </div>
      )}
      {data && data.orders.length >= 30 && !end && (
        <button type="button" className="btn btn--soft btn--block press" onClick={loadMore} disabled={busy}>
          {busy ? <Spinner small /> : t("loadMore")}
        </button>
      )}
    </div>
  );
}

export function OrderPage({ id }: { id: string }) {
  const { t } = useT();
  return (
    <Shell title={t("orders")} narrow>
      <RequireUser>
        <OrderView id={id} />
      </RequireUser>
    </Shell>
  );
}

function OrderView({ id }: { id: string }) {
  const { t, lang } = useT();
  const { data, error, reload } = useApi<OrderDetail>(`/api/orders/${encodeURIComponent(id)}`);
  const open = data && (data.order.status === "paid" || data.order.status === "processing");

  // While the supplier is still working, check again every few seconds.
  useEffect(() => {
    if (!open) return;
    const timer = setInterval(() => void reload(), 5000);
    return () => clearInterval(timer);
  }, [open, reload]);

  async function copy(v: string) {
    if (await copyText(v)) {
      haptic("success");
      toast(t("copied"));
    }
  }

  if (!data) {
    return (
      <div className="stack">
        {!error && <div className="skeleton" style={{ height: 260 }} />}
        <ErrorBox error={error} onRetry={reload} />
      </div>
    );
  }
  const o = data.order;
  const fieldLabel = (key: string) => {
    const f = o.fields?.find((x) => x.key === key);
    return f ? pick(lang, f.labelAr, f.labelEn) : key;
  };
  return (
    <div className="stack screen">
      <div className="stack-sm">
        <span className="small muted">
          {t("orderNo", { n: `#${o.number}` })} · {dateTime(o.createdAt, lang)}
        </span>
        <h1>{pick(lang, o.productAr, o.productEn)}</h1>
        <span className="muted">{pick(lang, o.packageAr, o.packageEn)}</span>
        <div className="row-between">
          <span className="num" style={{ fontSize: 22, fontWeight: 700 }}>
            {usd(o.totalCents)}
          </span>
          <span className="badge" style={{ color: STATUS_COLOR[o.status], background: "var(--surface-2)" }}>
            ● {t(`st_${o.status}`)}
          </span>
        </div>
        {o.discountCents > 0 && (
          <span className="small good">
            {t("discount")} <span className="num">−{usd(o.discountCents)}</span>
          </span>
        )}
      </div>

      {o.kind === "sms" && <NumberPanel data={data} onChanged={reload} onCopy={copy} />}

      {o.kind !== "sms" && data.deliveries.length > 0 && (
        <div className="card card--pad stack-sm">
          <h3>{t("yourDelivery")}</h3>
          {data.deliveries.map((d, i) => (
            <div key={i} className="copy-box">
              <span>{d.label ? `${d.label}: ${d.value}` : d.value}</span>
              <button type="button" className="btn btn--xs btn--ghost press" onClick={() => copy(d.value)}>
                {t("copy")}
              </button>
            </div>
          ))}
        </div>
      )}

      {open && o.kind !== "sms" && (
        <div className="card card--pad wrap">
          <Spinner small />
          <span>{t("inProgress")}</span>
        </div>
      )}
      {o.status === "refunded" && <div className="card card--pad">{t("refundedNote")}</div>}

      {Object.keys(o.input ?? {}).length > 0 && (
        <div className="card card--pad stack-sm">
          <span className="small muted">{t("yourInput")}</span>
          {Object.entries(o.input).map(([k, v]) => (
            <div key={k} className="row-between">
              <span className="muted">{fieldLabel(k)}</span>
              <span className="num">{v}</span>
            </div>
          ))}
        </div>
      )}

      {o.productSlug && !open && (
        <button type="button" className="btn btn--block btn--soft press" onClick={() => navigate(`/p/${o.productSlug}`)}>
          {t("buyAgain")}
        </button>
      )}
    </div>
  );
}

/** "mm:ss" left until `iso`, ticking every second (null without an end). */
function useCountdown(iso: string | null | undefined): string | null {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!iso) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [iso]);
  if (!iso) return null;
  const left = Math.max(0, Math.floor((Date.parse(iso) - now) / 1000));
  return `${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")}`;
}

/**
 * A virtual number: the number to copy, a countdown while it waits for the
 * code, the code as soon as it arrives, and (before a code) cancel or "already
 * used", both refunded.
 */
function NumberPanel({ data, onChanged, onCopy }: { data: OrderDetail; onChanged: () => void; onCopy: (v: string) => void }) {
  const { t, lang } = useT();
  const [busy, setBusy] = useState<"cancel" | "used" | null>(null);
  const o = data.order;
  const phone = data.deliveries.find((d) => d.kind === "phone");
  const codes = data.deliveries.filter((d) => d.kind === "sms");
  const waiting = (o.status === "paid" || o.status === "processing") && codes.length === 0;
  const left = useCountdown(waiting ? o.expiresAt : null);

  async function close(action: "cancel" | "used") {
    if (!window.confirm(t(action === "cancel" ? "numConfirmCancel" : "numConfirmUsed"))) return;
    setBusy(action);
    try {
      const r = await api<{ closed: boolean }>(`/api/orders/${o.id}/number`, { method: "POST", body: { action } });
      toast(r.closed ? t("numClosed") : t("numCodeArrived"));
      haptic(r.closed ? "tap" : "success");
      onChanged();
    } catch (e) {
      toast(errorText(lang, e instanceof ApiFail ? e.code : "internal"), true);
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="stack-sm">
      {phone && (
        <div className="card card--pad number-card">
          <span className="small muted">{t("numYour")}</span>
          <div className="row-between">
            <span className="number-card__value num">{phone.value}</span>
            <button type="button" className="btn btn--xs btn--soft press" onClick={() => onCopy(phone.value.replace(/[^\d+]/g, ""))}>
              {t("copy")}
            </button>
          </div>
        </div>
      )}
      {codes.map((c, i) => (
        <div key={i} className="card card--pad number-card number-card--code">
          <span className="small muted">{t("numCode")}</span>
          <div className="row-between">
            <span className="number-card__code num">{c.value}</span>
            <button type="button" className="btn btn--xs press" onClick={() => onCopy(c.value)}>
              {t("copy")}
            </button>
          </div>
          {c.label && <span className="small muted">{c.label}</span>}
        </div>
      ))}
      {waiting && (
        <div className="card card--pad stack-sm">
          <div className="row-between">
            <span className="wrap" style={{ gap: 10 }}>
              <span className="number-wait" aria-hidden="true" />
              <strong>{t("numWaiting")}</strong>
            </span>
            {left && (
              <span className="small muted">
                {t("numEndsIn", { time: "" })}
                <span className="num" style={{ fontWeight: 700 }}>{left}</span>
              </span>
            )}
          </div>
          <span className="small muted">{t("numHint")}</span>
          {o.numberActions && (
            <div className="wrap">
              <button type="button" className="btn btn--xs btn--ghost press" disabled={busy !== null} onClick={() => close("cancel")}>
                {busy === "cancel" ? <Spinner small /> : t("numCancel")}
              </button>
              <button type="button" className="btn btn--xs btn--ghost press" disabled={busy !== null} onClick={() => close("used")}>
                {busy === "used" ? <Spinner small /> : t("numUsed")}
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
