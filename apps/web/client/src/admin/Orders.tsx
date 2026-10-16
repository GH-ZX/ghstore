/** Orders: follow open ones, retry a supplier, refund a failed order. */
import { useState } from "react";
import { dateTime, usd } from "../lib/format";
import { pick } from "../lib/i18n";
import { useT } from "../lib/state";
import { useApi } from "../lib/useApi";
import type { OrderStatus } from "../lib/types";
import { STATUS_COLOR } from "../screens/Orders";
import { Empty, ErrorBox, Sheet, Spinner } from "../ui/kit";
import { useAction } from "./common";

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
}

const FILTERS = ["", "processing", "paid", "failed", "delivered", "refunded"] as const;

export function AdminOrders({ canAct = true }: { canAct?: boolean }) {
  const { t, lang } = useT();
  const [status, setStatus] = useState<(typeof FILTERS)[number]>("");
  const { data, error, reload } = useApi<{ orders: AdminOrder[] }>(`/api/admin/orders${status ? `?status=${status}` : ""}`);
  const [refunding, setRefunding] = useState<AdminOrder | null>(null);
  const action = useAction();

  async function retry(o: AdminOrder) {
    await action.run(`/api/admin/orders/${o.id}/retry`, {}, t("retryOrder"));
    void reload();
  }

  return (
    <div className="stack">
      <div className="chip-row" role="group" aria-label={t("status")}>
        {FILTERS.map((s) => (
          <button key={s || "all"} type="button" className="chip chip--sm press" aria-pressed={status === s} onClick={() => setStatus(s)}>
            {s ? t(`st_${s}`) : t("all")}
          </button>
        ))}
      </div>
      <ErrorBox error={error} onRetry={reload} />
      {!data && !error && <div className="skeleton" style={{ height: 240 }} />}
      {data && data.orders.length === 0 && <Empty>{t("none")}</Empty>}
      {data && data.orders.length > 0 && (
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
                  </td>
                  <td className="small">
                    {o.supplier_id ?? t("manualStock")}
                    {o.supplier_order_id && <span className="muted num"> · {o.supplier_order_id}</span>}
                  </td>
                  <td className="wrap-cell small bad">{o.last_error ?? ""}</td>
                  <td>
                    <div className="wrap">
                      {canAct && (o.status === "paid" || o.status === "processing") && (
                        <button type="button" className="btn btn--xs btn--ghost press" disabled={action.busy} onClick={() => retry(o)}>
                          {t("retryOrder")}
                        </button>
                      )}
                      {canAct && (o.status === "failed" || o.status === "paid" || o.status === "processing") && (
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
