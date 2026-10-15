/** Orders list and order detail with copyable deliveries. */
import { useEffect, useState } from "react";
import { api } from "../lib/api";
import { copyText, dateTime, usd } from "../lib/format";
import { pick } from "../lib/i18n";
import { linkHandler } from "../lib/router";
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
      </div>

      {data.deliveries.length > 0 && (
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

      {open && (
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
    </div>
  );
}
