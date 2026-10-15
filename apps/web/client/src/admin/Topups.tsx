/** Top-ups: review manual transfers and anything a provider could not settle. */
import { useState } from "react";
import { dateTime, dollarsToCents, usd } from "../lib/format";
import { useT } from "../lib/state";
import { useApi } from "../lib/useApi";
import { Empty, ErrorBox, Sheet, Spinner } from "../ui/kit";
import { methodLabel, useAction } from "./common";

interface Payment {
  id: string;
  user_id: string;
  display_name: string;
  method: string;
  amountCents: number;
  status: string;
  tx_hash: string | null;
  provider_ref: string | null;
  note: string | null;
  created_at: string;
}

const STATUSES = ["review", "pending", "paid", "failed", "expired", "rejected"] as const;

export function Topups() {
  const { t, lang } = useT();
  const [status, setStatus] = useState<(typeof STATUSES)[number]>("review");
  const { data, error, reload } = useApi<{ payments: Payment[] }>(`/api/admin/payments?status=${status}`);
  const [open, setOpen] = useState<Payment | null>(null);
  const action = useAction();

  async function recheck(p: Payment) {
    await action.run(`/api/admin/payments/${p.id}/recheck`, {}, t("recheck"));
    void reload();
  }

  return (
    <div className="stack">
      <div className="chip-row" role="group" aria-label={t("status")}>
        {STATUSES.map((s) => (
          <button key={s} type="button" className="chip chip--sm press" aria-pressed={status === s} onClick={() => setStatus(s)}>
            {s}
          </button>
        ))}
      </div>
      <ErrorBox error={error} onRetry={reload} />
      {!data && !error && <div className="skeleton" style={{ height: 200 }} />}
      {data && data.payments.length === 0 && <Empty>{t("none")}</Empty>}
      {data && data.payments.length > 0 && (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>{t("created")}</th>
                <th>{t("user")}</th>
                <th>{t("method")}</th>
                <th>{t("amount")}</th>
                <th>Ref / hash</th>
                <th>{t("note")}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {data.payments.map((p) => (
                <tr key={p.id}>
                  <td>{dateTime(p.created_at, lang)}</td>
                  <td>{p.display_name || p.user_id.slice(0, 8)}</td>
                  <td>{methodLabel(t, p.method)}</td>
                  <td className="num">{usd(p.amountCents)}</td>
                  <td className="num small">
                    {p.tx_hash ? (
                      <a href={`https://bscscan.com/tx/${p.tx_hash}`} target="_blank" rel="noopener noreferrer">
                        {p.tx_hash.slice(0, 10)}…
                      </a>
                    ) : (
                      p.provider_ref?.slice(0, 16) ?? "—"
                    )}
                  </td>
                  <td className="wrap-cell small muted">{p.note ?? ""}</td>
                  <td>
                    <div className="wrap">
                      {["review", "pending", "created", "partial", "expired"].includes(p.status) && (
                        <button type="button" className="btn btn--xs press" onClick={() => setOpen(p)}>
                          {t("approve")}
                        </button>
                      )}
                      {["review", "pending"].includes(p.status) && (
                        <button type="button" className="btn btn--xs btn--ghost press" onClick={() => recheck(p)} disabled={action.busy}>
                          {t("recheck")}
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
      {open && (
        <ReviewSheet
          payment={open}
          onClose={() => {
            setOpen(null);
            void reload();
          }}
        />
      )}
    </div>
  );
}

function ReviewSheet({ payment, onClose }: { payment: Payment; onClose: () => void }) {
  const { t } = useT();
  const [amount, setAmount] = useState((payment.amountCents / 100).toFixed(2));
  const [note, setNote] = useState("");
  const action = useAction();
  const cents = dollarsToCents(amount);

  async function approve() {
    if (cents === null || note.trim().length < 3) return;
    if (await action.run(`/api/admin/payments/${payment.id}/approve`, { body: { amountCents: cents, note: note.trim() } })) onClose();
  }
  async function reject() {
    if (note.trim().length < 3) return;
    if (await action.run(`/api/admin/payments/${payment.id}/reject`, { body: { note: note.trim() } })) onClose();
  }

  return (
    <Sheet
      onClose={onClose}
      label={`${t("approve")} · ${usd(payment.amountCents)}`}
      foot={
        <div className="wrap" style={{ justifyContent: "flex-end" }}>
          <button type="button" className="btn btn--sm btn--danger press" onClick={reject} disabled={action.busy || note.trim().length < 3}>
            {t("reject")}
          </button>
          <button type="button" className="btn btn--sm press" onClick={approve} disabled={action.busy || cents === null || note.trim().length < 3}>
            {action.busy ? <Spinner small /> : t("approve")}
          </button>
        </div>
      }
    >
      <p className="small muted">
        {payment.display_name} · {payment.method} · {payment.tx_hash ?? payment.provider_ref ?? ""}
      </p>
      <label className="field">
        <span>{t("amountReceived")}</span>
        <input className="input num" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} />
      </label>
      <label className="field">
        <span>{t("note")}</span>
        <input className="input" value={note} onChange={(e) => setNote(e.target.value)} placeholder={t("noteRequired")} />
      </label>
    </Sheet>
  );
}
