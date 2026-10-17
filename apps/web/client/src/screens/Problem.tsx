/**
 * "Report a problem" on an order page: what went wrong (it didn't arrive, it
 * doesn't work, wrong item, other) and a few words; then the report's state
 * and the store's answer. See packages/api/src/problems.ts.
 */
import { useState } from "react";
import { api } from "../lib/api";
import { dateTime } from "../lib/format";
import { toast, toastFail, useT } from "../lib/state";
import { haptic } from "../lib/telegram";
import type { OrderProblem } from "../lib/types";
import { Spinner } from "../ui/kit";

const REASONS = ["not_received", "not_working", "wrong_item", "other"] as const;
type Reason = (typeof REASONS)[number];

export function ProblemCard({ orderId, problem, onSent }: { orderId: string; problem: OrderProblem | null | undefined; onSent: () => void }) {
  const { t, lang } = useT();
  const [writing, setWriting] = useState(false);
  const [reason, setReason] = useState<Reason | null>(null);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);

  async function send() {
    if (!reason) return;
    setBusy(true);
    try {
      await api(`/api/orders/${orderId}/problem`, { body: { reason, message } });
      haptic("success");
      toast(t("problemSent"));
      setWriting(false);
      setReason(null);
      setMessage("");
      onSent();
    } catch (e) {
      toastFail(e);
    } finally {
      setBusy(false);
    }
  }

  if (problem?.status === "open") {
    return (
      <div className="card card--pad stack-sm problem problem--open">
        <strong>{t("problemOpen")}</strong>
        <span className="small muted">
          {t(`problem_${problem.reason}` as "problem_other")} · {dateTime(problem.createdAt, lang)}
        </span>
        {problem.message && <p className="problem__text" dir="auto">{problem.message}</p>}
        <span className="small muted">{t("problemWait")}</span>
      </div>
    );
  }

  return (
    <div className="stack-sm">
      {problem?.status === "resolved" && (
        <div className="card card--pad stack-sm problem problem--answer">
          <strong>{t("problemAnswer")}</strong>
          <p className="problem__text" dir="auto">{problem.reply}</p>
          {problem.resolvedAt && <span className="small muted">{dateTime(problem.resolvedAt, lang)}</span>}
        </div>
      )}
      {!writing ? (
        <button type="button" className="btn btn--block btn--ghost press" onClick={() => setWriting(true)}>
          {problem ? t("problemAgain") : t("problemReport")}
        </button>
      ) : (
        <form
          className="card card--pad stack-sm"
          onSubmit={(e) => {
            e.preventDefault();
            void send();
          }}
        >
          <strong>{t("problemWhat")}</strong>
          <div className="wrap" style={{ gap: 8 }} role="radiogroup" aria-label={t("problemWhat")}>
            {REASONS.map((r) => (
              <button key={r} type="button" role="radio" aria-checked={reason === r} className="chip chip--sm press" onClick={() => setReason(r)}>
                {t(`problem_${r}`)}
              </button>
            ))}
          </div>
          <textarea className="textarea" maxLength={1000} value={message} placeholder={t("problemPh")} onChange={(e) => setMessage(e.target.value)} />
          <div className="wrap" style={{ gap: 8 }}>
            <button className="btn btn--sm press" disabled={busy || !reason || (reason === "other" && message.trim().length < 3)}>
              {busy ? <Spinner small /> : t("problemSend")}
            </button>
            <button type="button" className="btn btn--sm btn--ghost press" disabled={busy} onClick={() => setWriting(false)}>
              {t("cancel")}
            </button>
          </div>
        </form>
      )}
    </div>
  );
}
