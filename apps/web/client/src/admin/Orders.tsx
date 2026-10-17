/**
 * Orders: follow open ones, retry a supplier, refund a failed order, and finish
 * the ones waiting for a person (Waiting): products delivered by hand, and a
 * supplier's delivery to check before the customer gets it.
 */
import { useState } from "react";
import { copyText, dateTime, usd } from "../lib/format";
import { pick } from "../lib/i18n";
import { toast, useT } from "../lib/state";
import { useApi } from "../lib/useApi";
import type { OrderHold, OrderStatus } from "../lib/types";
import { STATUS_COLOR } from "../screens/Orders";
import { Empty, ErrorBox, Sheet, Spinner } from "../ui/kit";
import { api, ApiFail } from "../lib/api";
import { errorText } from "../lib/i18n";
import { useAction } from "./common";
import { ProblemsAdmin } from "./Problems";

interface AdminOrder {
  id: string;
  number: string | number;
  status: OrderStatus;
  total_cents: string | number;
  cost_cents: string | number | null;
  channel: string;
  supplier_id: string | null;
  supplier_order_id: string | null;
  attempts: number;
  last_error: string | null;
  created_at: string;
  display_name: string;
  product_en: string;
  product_ar: string;
  offer_en?: string;
  offer_ar?: string;
  hold?: OrderHold | null;
  answered_at?: string | null;
}

interface OrderSheetData {
  order: {
    id: string; number: number; status: OrderStatus; hold: OrderHold | null; totalCents: number; costCents: number | null;
    createdAt: string; deliveredAt: string | null; answeredAt: string | null; supplierId: string | null; supplierOrderId: string | null;
    lastError: string | null; productEn: string; productAr: string; packageEn: string; packageAr: string; kind: string; delivery: string;
    customer: { id: string; name: string | null; telegram: string | null; email: string | null };
    input: { label: string; labelAr: string; value: string }[];
    details: { key: string; type: string; label: string; labelAr: string; secret: boolean; value: string | null }[];
  };
  /** Values come hidden (null): "Show" asks for each one, and every look is logged. */
  deliveries: { id: string; kind: string; label: string | null; value: string | null; masked?: boolean; at: string }[];
  events: { type: string; at: string }[];
}

const FILTERS = ["waiting", "problems", "", "processing", "paid", "failed", "delivered", "refunded"] as const;
type Filter = (typeof FILTERS)[number];
const open = (s: OrderStatus) => s === "paid" || s === "processing";

export function AdminOrders({ canAct = true }: { canAct?: boolean }) {
  const { t, lang } = useT();
  const [status, setStatus] = useState<Filter>("");
  const { data, error, reload } = useApi<{ orders: AdminOrder[]; waiting?: number; problems?: number }>(`/api/admin/orders${status ? `?status=${status}` : ""}`);
  const [refunding, setRefunding] = useState<AdminOrder | null>(null);
  const [opened, setOpened] = useState<string | null>(null);
  const action = useAction();

  async function retry(o: AdminOrder) {
    await action.run(`/api/admin/orders/${o.id}/retry`, {}, t("retryOrder"));
    void reload();
  }

  const waiting = status === "waiting";
  return (
    <div className="stack">
      <div className="chip-row" role="group" aria-label={t("status")}>
        {FILTERS.map((s) => (
          <button key={s || "all"} type="button" className="chip chip--sm press" aria-pressed={status === s} onClick={() => setStatus(s)}>
            {s === "waiting" ? t("waiting") : s === "problems" ? t("problems") : s ? t(`st_${s}`) : t("all")}
            {s === "waiting" && (data?.waiting ?? 0) > 0 && <span className="count-pill num">{data?.waiting}</span>}
            {s === "problems" && (data?.problems ?? 0) > 0 && <span className="count-pill num">{data?.problems}</span>}
          </button>
        ))}
      </div>
      <ErrorBox error={error} onRetry={reload} />
      {!data && !error && <div className="skeleton" style={{ height: 240 }} />}
      {status === "problems" && <ProblemsAdmin canAct={canAct} onOpenOrder={setOpened} onChanged={() => void reload()} />}
      {status !== "problems" && data && data.orders.length === 0 && <Empty>{waiting ? t("waitingNone") : t("none")}</Empty>}

      {waiting && data && data.orders.length > 0 && (
        <>
          <p className="hint">{t("waitingHint")}</p>
          <div className="waiting-list">
            {data.orders.map((o) => (
              <button key={o.id} type="button" className="card card--pad waiting-card press" disabled={!canAct} onClick={() => setOpened(o.id)}>
                <span className="row-between">
                  <strong>{pick(lang, o.product_ar, o.product_en)}</strong>
                  <span className="num muted">#{String(o.number)}</span>
                </span>
                <span className="small muted">
                  <bdi>{pick(lang, o.offer_ar ?? "", o.offer_en ?? "")}</bdi> · <bdi>{o.display_name}</bdi> · {dateTime(o.created_at, lang)}
                </span>
                <span className="row-between">
                  <span className={`badge ${o.hold === "info" ? "" : "badge--warn"}`}>{t(`hold_${o.hold ?? "owner"}`)}</span>
                  <span className="num" style={{ fontWeight: 700 }}>
                    {usd(Number(o.total_cents))}
                  </span>
                </span>
              </button>
            ))}
          </div>
        </>
      )}

      {!waiting && data && data.orders.length > 0 && (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>#</th>
                <th>{t("created")}</th>
                <th>{t("user")}</th>
                <th>{t("product")}</th>
                <th>{t("total")}</th>
                <th>{t("cost")}</th>
                <th>{t("status")}</th>
                <th>{t("supplier")}</th>
                <th>{t("error")}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {data.orders.map((o) => (
                <tr key={o.id}>
                  <td className="num">{String(o.number)}</td>
                  <td>{dateTime(o.created_at, lang)}</td>
                  <td>{o.display_name}</td>
                  <td>{pick(lang, o.product_ar, o.product_en)}</td>
                  <td className="num">{usd(Number(o.total_cents))}</td>
                  <td className="num muted">{o.cost_cents === null ? "—" : usd(Number(o.cost_cents))}</td>
                  <td>
                    <span style={{ color: STATUS_COLOR[o.status], fontWeight: 600 }}>{t(`st_${o.status}`)}</span>
                    {o.hold && open(o.status) && <span className="small muted"> · {t(`hold_${o.hold}`)}</span>}
                  </td>
                  <td className="small">
                    {o.supplier_id ?? (o.hold ? t("delivery_manual") : t("manualStock"))}
                    {o.supplier_order_id && <span className="muted num"> · {o.supplier_order_id}</span>}
                  </td>
                  <td className="wrap-cell small bad">{o.last_error ?? ""}</td>
                  <td>
                    <div className="wrap">
                      {canAct && (
                        <button type="button" className="btn btn--xs btn--ghost press" onClick={() => setOpened(o.id)}>
                          {t("open")}
                        </button>
                      )}
                      {canAct && open(o.status) && !o.hold && (
                        <button type="button" className="btn btn--xs btn--ghost press" disabled={action.busy} onClick={() => retry(o)}>
                          {t("retryOrder")}
                        </button>
                      )}
                      {canAct && (o.status === "failed" || open(o.status)) && (
                        <button type="button" className="btn btn--xs btn--danger press" onClick={() => setRefunding(o)}>
                          {t("refund")}
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {opened && (
        <OrderSheet
          id={opened}
          onRefund={(o) => {
            setOpened(null);
            setRefunding(o);
          }}
          onClose={() => {
            setOpened(null);
            void reload();
          }}
        />
      )}
      {refunding && (
        <RefundSheet
          order={refunding}
          onClose={() => {
            setRefunding(null);
            void reload();
          }}
        />
      )}
    </div>
  );
}

interface DeliveryDraft {
  kind: "account" | "code" | "link" | "id";
  label: string;
  value: string;
}

/**
 * One order: the customer, what they typed before paying and the details they
 * gave after (secrets hidden until shown), what was delivered so far, and the
 * way to finish it: deliver it by hand, release the supplier's delivery, or refund.
 */
function OrderSheet({ id, onClose, onRefund }: { id: string; onClose: () => void; onRefund: (o: AdminOrder) => void }) {
  const { t, lang } = useT();
  const { data, error, reload } = useApi<OrderSheetData>(`/api/admin/orders/${id}`);
  const [shown, setShown] = useState<Record<string, boolean>>({});
  // Delivered values asked for with "Show" (each look is audit logged on the server).
  const [revealed, setRevealed] = useState<Record<string, string>>({});
  const [revealing, setRevealing] = useState<string | null>(null);
  const [items, setItems] = useState<DeliveryDraft[]>([{ kind: "account", label: "", value: "" }]);
  const action = useAction();

  async function copy(v: string) {
    if (await copyText(v)) toast(t("copied"));
  }

  async function reveal(deliveryId: string) {
    if (!data) return;
    setRevealing(deliveryId);
    try {
      const r = await api<{ deliveries: { id: string; value: string }[] }>(`/api/admin/orders/${data.order.id}/reveal`, { method: "POST", body: { deliveryId } });
      setRevealed((x) => ({ ...x, ...Object.fromEntries(r.deliveries.map((d) => [d.id, d.value])) }));
    } catch (e) {
      toast(errorText(lang, e instanceof ApiFail ? e.code : "internal"), true);
    } finally {
      setRevealing(null);
    }
  }

  const o = data?.order;
  const canFinish = !!o && open(o.status) && !!o.hold;
  const release = o?.hold === "release";
  const filled = items.filter((i) => i.value.trim());

  async function deliver() {
    if (!o) return;
    const body = { items: filled.map((i) => ({ kind: i.kind, label: i.label.trim() || undefined, value: i.value.trim() })) };
    if (await action.run(`/api/admin/orders/${o.id}/deliver`, { body }, release ? t("released") : t("deliveredByHand"))) onClose();
  }

  const asRow = (x: OrderSheetData["order"]): AdminOrder => ({
    id: x.id, number: x.number, status: x.status, total_cents: x.totalCents, cost_cents: x.costCents, channel: "", supplier_id: x.supplierId,
    supplier_order_id: x.supplierOrderId, attempts: 0, last_error: x.lastError, created_at: x.createdAt, display_name: x.customer.name ?? "",
    product_en: x.productEn, product_ar: x.productAr,
  });

  return (
    <Sheet
      onClose={onClose}
      label={o ? `#${o.number} · ${pick(lang, o.productAr, o.productEn)}` : t("loading")}
      foot={
        canFinish && o ? (
          <div className="stack-sm">
            <button type="button" className="btn btn--block press" disabled={action.busy || (!release && filled.length === 0)} onClick={deliver}>
              {action.busy ? <Spinner small /> : release ? (filled.length ? t("releaseWith") : t("release")) : t("deliverNow")}
            </button>
            <button type="button" className="btn btn--block btn--ghost press" onClick={() => onRefund(asRow(o))}>
              {t("refund")} · {usd(o.totalCents)}
            </button>
          </div>
        ) : undefined
      }
    >
      <ErrorBox error={error} onRetry={reload} />
      {!data && !error && <div className="skeleton" style={{ height: 260 }} />}
      {o && data && (
        <div className="stack">
          <div className="stack-sm">
            <bdi className="muted">{pick(lang, o.packageAr, o.packageEn)}</bdi>
            <div className="row-between">
              <span className="num" style={{ fontSize: 20, fontWeight: 700 }}>
                {usd(o.totalCents)}
                {o.costCents !== null && <span className="small muted"> · {t("cost")} {usd(o.costCents)}</span>}
              </span>
              <span className="badge" style={{ color: STATUS_COLOR[o.status] }}>
                ● {t(`st_${o.status}`)}
                {o.hold && open(o.status) ? ` · ${t(`hold_${o.hold}`)}` : ""}
              </span>
            </div>
            <span className="small muted">{dateTime(o.createdAt, lang)}</span>
          </div>

          <div className="card card--pad stack-sm">
            <span className="small muted">{t("customer")}</span>
            <strong>{o.customer.name ?? "—"}</strong>
            {o.customer.telegram && (
              <a className="small" href={`https://t.me/${o.customer.telegram}`} target="_blank" rel="noreferrer" dir="ltr">
                @{o.customer.telegram}
              </a>
            )}
            {o.customer.email && (
              <span className="small" dir="ltr">
                {o.customer.email}
              </span>
            )}
          </div>

          {o.input.length > 0 && (
            <div className="card card--pad stack-sm">
              <span className="small muted">{t("typedBefore")}</span>
              {o.input.map((x) => (
                <div key={x.label} className="copy-box">
                  <span>
                    <span className="muted">{pick(lang, x.labelAr, x.label)}: </span>
                    {x.value}
                  </span>
                  <button type="button" className="btn btn--xs btn--ghost press" onClick={() => copy(x.value)}>
                    {t("copy")}
                  </button>
                </div>
              ))}
            </div>
          )}

          {o.details.length > 0 && (
            <div className="card card--pad stack-sm">
              <div className="row-between">
                <span className="small muted">{t("givenAfter")}</span>
                {o.answeredAt && <span className="small muted">{dateTime(o.answeredAt, lang)}</span>}
              </div>
              {!o.answeredAt && <span className="warn small">{t("hold_info")}</span>}
              {o.details.map((d) => (
                <div key={d.key} className="copy-box copy-box--stack">
                  <span className="small muted">{pick(lang, d.labelAr, d.label)}</span>
                  <span dir="ltr" className={d.type === "token" ? "mono-block" : undefined}>
                    {d.value === null ? "—" : d.secret && !shown[d.key] ? "••••••••" : d.value}
                  </span>
                  {d.value !== null && (
                    <span className="wrap">
                      {d.secret && (
                        <button type="button" className="btn btn--xs btn--ghost press" onClick={() => setShown((s) => ({ ...s, [d.key]: !s[d.key] }))}>
                          {shown[d.key] ? t("hide") : t("show")}
                        </button>
                      )}
                      <button type="button" className="btn btn--xs btn--ghost press" onClick={() => copy(d.value ?? "")}>
                        {t("copy")}
                      </button>
                    </span>
                  )}
                </div>
              ))}
              <span className="hint">🔒 {t("detailsErased")}</span>
            </div>
          )}

          {data.deliveries.length > 0 && (
            <div className="card card--pad stack-sm">
              <span className="small muted">{release ? t("supplierSent") : t("yourDelivery")}</span>
              {data.deliveries.map((d) => {
                const value = d.value ?? revealed[d.id] ?? null;
                return (
                  <div key={d.id} className="copy-box">
                    <span dir="auto">
                      {d.label ? `${d.label}: ` : ""}
                      {value ?? "••••••••"}
                    </span>
                    {value === null ? (
                      <button type="button" className="btn btn--xs btn--ghost press" disabled={revealing !== null} onClick={() => reveal(d.id)}>
                        {revealing === d.id ? <Spinner small /> : t("show")}
                      </button>
                    ) : (
                      <button type="button" className="btn btn--xs btn--ghost press" onClick={() => copy(value)}>
                        {t("copy")}
                      </button>
                    )}
                  </div>
                );
              })}
              <span className="hint">🔒 {t("deliveriesLogged")}</span>
            </div>
          )}

          {canFinish && (
            <div className="card card--pad stack-sm">
              <h3>{release ? t("releaseTitle") : t("deliverTitle")}</h3>
              <span className="hint">{release ? t("releaseHint") : t("deliverHint")}</span>
              {items.map((it, i) => (
                <div key={i} className="deliver-row">
                  <select className="select" value={it.kind} aria-label={t("kind")} onChange={(e) => setItems((x) => x.map((y, j) => (j === i ? { ...y, kind: e.target.value as DeliveryDraft["kind"] } : y)))}>
                    {(["account", "code", "link", "id"] as const).map((k) => (
                      <option key={k} value={k}>
                        {t(`kind_${k}`)}
                      </option>
                    ))}
                  </select>
                  <input className="input" maxLength={60} value={it.label} placeholder={t("deliverLabel")} onChange={(e) => setItems((x) => x.map((y, j) => (j === i ? { ...y, label: e.target.value } : y)))} />
                  <textarea className="input deliver-row__value" dir="auto" rows={2} maxLength={4000} value={it.value} placeholder={t("deliverValue")} onChange={(e) => setItems((x) => x.map((y, j) => (j === i ? { ...y, value: e.target.value } : y)))} />
                  {items.length > 1 && (
                    <button type="button" className="btn btn--xs btn--ghost press" aria-label={t("remove")} onClick={() => setItems((x) => x.filter((_, j) => j !== i))}>
                      ✕
                    </button>
                  )}
                </div>
              ))}
              {items.length < 20 && (
                <button type="button" className="btn btn--xs btn--ghost press" style={{ alignSelf: "flex-start" }} onClick={() => setItems((x) => [...x, { kind: "account", label: "", value: "" }])}>
                  + {t("deliverAdd")}
                </button>
              )}
            </div>
          )}

          {o.lastError && <span className="small bad">{o.lastError}</span>}
          {data.events.length > 0 && (
            <details className="small muted">
              <summary>{t("history")}</summary>
              {data.events.map((e, i) => (
                <div key={i} className="row-between">
                  <span>{e.type}</span>
                  <span>{dateTime(e.at, lang)}</span>
                </div>
              ))}
            </details>
          )}
        </div>
      )}
    </Sheet>
  );
}

function RefundSheet({ order, onClose }: { order: AdminOrder; onClose: () => void }) {
  const { t } = useT();
  const [note, setNote] = useState("");
  const action = useAction();
  async function refund() {
    if (await action.run(`/api/admin/orders/${order.id}/refund`, { body: { note: note.trim() } })) onClose();
  }
  return (
    <Sheet
      onClose={onClose}
      label={`${t("refund")} #${String(order.number)}`}
      foot={
        <button type="button" className="btn btn--block btn--danger press" disabled={action.busy || note.trim().length < 3} onClick={refund}>
          {action.busy ? <Spinner small /> : `${t("refund")} · ${usd(Number(order.total_cents))}`}
        </button>
      }
    >
      <p>{t("confirmRefund")}</p>
      <label className="field">
        <span>{t("note")}</span>
        <input className="input" value={note} onChange={(e) => setNote(e.target.value)} placeholder={t("noteRequired")} />
      </label>
    </Sheet>
  );
}
