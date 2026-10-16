/**
 * Top-ups: review manual transfers and anything a provider could not settle.
 * One card per top-up (readable on a phone): who, how, how much (for USDT the
 * exact amount asked), how long ago, the reason in words, and "Credit" with the
 * amount and a note already filled in.
 */
import { useState } from "react";
import { dateTime, dollarsToCents, usd } from "../lib/format";
import type { MsgKey } from "../lib/i18n";
import { useT } from "../lib/state";
import { useApi } from "../lib/useApi";
import { MethodMark } from "../ui/icons";
import { Empty, ErrorBox, Sheet, Spinner } from "../ui/kit";
import { ago, methodLabel, useAction } from "./common";

interface Payment {
  id: string;
  user_id: string;
  display_name: string;
  method: string;
  amountCents: number;
  creditedCents: number | null;
  status: string;
  tx_hash: string | null;
  provider_ref: string | null;
  note: string | null;
  created_at: string;
  /** Manual USDT: the exact amount the customer was asked to send. */
  send_amount: string | null;
}

const STATUSES = ["review", "pending", "paid", "failed", "expired", "rejected"] as const;
type Status = (typeof STATUSES)[number];
const STATUS_LABEL: Record<Status, MsgKey> = {
  review: "tst_review", pending: "tst_pending", paid: "tst_paid", failed: "tst_failed", expired: "tst_expired", rejected: "tst_rejected",
};

/** What to suggest crediting: what arrived when less than asked did, else the request. */
function suggested(p: Payment): number {
  const partial = p.note ? /^partial: (\d+) cents received$/.exec(p.note) : null;
  return partial ? Number(partial[1]) : p.amountCents;
}

/** The server's notes, in the owner's words. */
function noteText(t: ReturnType<typeof useT>["t"], note: string | null): string | null {
  if (!note) return null;
  const partial = /^partial: (\d+) cents received$/.exec(note);
  if (partial) return t("tnote_partial", { amount: usd(Number(partial[1])) });
  const known: Record<string, MsgKey> = {
    "transfer did not match": "tnote_mismatch",
    "needs review": "tnote_review",
    "paid without a usable amount": "tnote_noAmount",
    "stars amount or payer mismatch": "tnote_stars",
    "cancelled by the customer": "tnote_cancelled",
    "send window closed": "tnote_closed",
    "paid after it closed": "tnote_late",
  };
  return known[note] ? t(known[note]!) : note;
}

export function Topups({ canAct = true }: { canAct?: boolean }) {
  const { t, lang } = useT();
  const [status, setStatus] = useState<Status>("review");
  const { data, error, reload } = useApi<{ payments: Payment[]; counts?: Record<string, number> }>(`/api/admin/payments?status=${status}`);
  const [open, setOpen] = useState<Payment | null>(null);
  const action = useAction();

  async function recheck(p: Payment) {
    await action.run(`/api/admin/payments/${p.id}/recheck`, {}, t("recheck"));
    void reload();
  }

  return (
    <div className="stack">
      <div className="chip-row" role="group" aria-label={t("status")}>
        {STATUSES.map((s) => {
          const count = data?.counts?.[s];
          return (
            <button key={s} type="button" className="chip chip--sm press" aria-pressed={status === s} onClick={() => setStatus(s)}>
              {t(STATUS_LABEL[s])}
              {count ? <span className={s === "review" ? "chip__count chip__count--alert" : "chip__count"}>{count}</span> : null}
            </button>
          );
        })}
      </div>
      <ErrorBox error={error} onRetry={reload} />
      {!data && !error && <div className="skeleton" style={{ height: 200 }} />}
      {data && data.payments.length === 0 && <Empty>{t("none")}</Empty>}
      {data && data.payments.length > 0 && (
        <div className="pay-cards">
          {data.payments.map((p) => {
            const why = noteText(t, p.note);
            return (
              <div key={p.id} className={p.status === "review" ? "pay-card pay-card--review" : "pay-card"}>
                <div className="pay-card__top">
                  <MethodMark method={p.method} size={36} />
                  <span className="pay-card__who">
                    <strong dir="auto">{p.display_name || p.user_id.slice(0, 8)}</strong>
                    <span className="small muted" title={dateTime(p.created_at, lang)}>
                      {methodLabel(t, p.method)} · {ago(p.created_at, lang)}
                    </span>
                  </span>
                  <span className="pay-card__amount num">{usd(p.creditedCents ?? p.amountCents)}</span>
                </div>
                {p.send_amount && (
                  <span className="small">
                    {t("topupSendAsked")} <b className="num" dir="ltr">{p.send_amount} USDT</b>
                  </span>
                )}
                {(p.tx_hash || p.provider_ref) && (
                  <span className="small muted num pay-card__ref">
                    {p.tx_hash ? (
                      <a href={`https://bscscan.com/tx/${p.tx_hash}`} target="_blank" rel="noopener noreferrer">
                        {p.tx_hash.slice(0, 12)}…{p.tx_hash.slice(-6)} ↗
                      </a>
                    ) : (
                      p.provider_ref
                    )}
                  </span>
                )}
                {why && <span className="pay-card__why">{why}</span>}
                {canAct && (
                  <div className="wrap" style={{ gap: 8 }}>
                    {["review", "pending", "created", "partial", "expired"].includes(p.status) && (
                      <button type="button" className="btn btn--xs press" onClick={() => setOpen(p)}>
                        {t("creditAmount", { amount: usd(suggested(p)) })}
                      </button>
                    )}
                    {["review", "pending"].includes(p.status) && (
                      <button type="button" className="btn btn--xs btn--ghost press" onClick={() => recheck(p)} disabled={action.busy}>
                        {t("recheck")}
                      </button>
                    )}
                  </div>
                )}
              </div>
            );
          })}
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
  const [amount, setAmount] = useState((suggested(payment) / 100).toFixed(2));
  // Filled in, so crediting what was checked is one more tap.
  const [note, setNote] = useState(t("checkedByHand"));
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
            {action.busy ? <Spinner small /> : t("creditAmount", { amount: cents === null ? "—" : usd(cents) })}
          </button>
        </div>
      }
    >
      <div className="pay-card__top">
        <MethodMark method={payment.method} size={36} />
        <span className="pay-card__who">
          <strong dir="auto">{payment.display_name}</strong>
          <span className="small muted">{methodLabel(t, payment.method)}</span>
        </span>
      </div>
      {payment.send_amount && (
        <p className="small">
          {t("topupSendAsked")} <b className="num" dir="ltr">{payment.send_amount} USDT</b>
        </p>
      )}
      {(payment.tx_hash || payment.provider_ref) && <p className="small muted num pay-card__ref">{payment.tx_hash ?? payment.provider_ref}</p>}
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
