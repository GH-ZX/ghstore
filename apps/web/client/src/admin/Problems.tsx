/** Admin → Orders → Problems: customers' reports on their orders, with the order at hand and an answer that reaches them. */
import { useState } from "react";
import { usd } from "../lib/format";
import { pick } from "../lib/i18n";
import { useT } from "../lib/state";
import { useApi } from "../lib/useApi";
import { Empty, ErrorBox, Spinner } from "../ui/kit";
import { ago, useAction } from "./common";

interface AdminProblem {
  id: string;
  reason: string;
  message: string;
  status: "open" | "resolved";
  reply: string;
  created_at: string;
  resolved_at: string | null;
  order_id: string;
  number: string | number;
  order_status: string;
  total_cents: string | number;
  name_ar: string;
  name_en: string;
  offer_ar: string;
  offer_en: string;
  display_name: string;
}

export function ProblemsAdmin({ canAct, onOpenOrder, onChanged }: { canAct: boolean; onOpenOrder: (id: string) => void; onChanged: () => void }) {
  const { t, lang } = useT();
  const { data, error, reload } = useApi<{ problems: AdminProblem[] }>("/api/admin/problems");
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const action = useAction();

  async function answer(p: AdminProblem) {
    const reply = (drafts[p.id] ?? "").trim();
    if (reply.length < 2) return;
    if (await action.run(`/api/admin/problems/${p.id}/resolve`, { body: { reply } }, t("problemAnswered"))) {
      setDrafts((d) => ({ ...d, [p.id]: "" }));
      await reload();
      onChanged();
    }
  }

  return (
    <div className="stack-sm">
      <p className="hint">{t("problemsHint")}</p>
      <ErrorBox error={error} onRetry={reload} />
      {!data && !error && <div className="skeleton" style={{ height: 200 }} />}
      {data && data.problems.length === 0 && <Empty>{t("problemsNone")}</Empty>}
      {data?.problems.map((p) => (
        <article key={p.id} className={`card card--pad stack-sm problem-admin${p.status === "resolved" ? " problem-admin--done" : ""}`}>
          <div className="row-between">
            <strong>{pick(lang, p.name_ar, p.name_en)}</strong>
            <span className="num muted">#{String(p.number)}</span>
          </div>
          <span className="small muted">
            <bdi>{pick(lang, p.offer_ar, p.offer_en)}</bdi> · <bdi>{p.display_name || t("customer")}</bdi> · {usd(Number(p.total_cents))} · {t(`st_${p.order_status}` as "st_paid")}
          </span>
          <span className={`badge ${p.status === "open" ? "badge--warn" : ""}`} style={{ alignSelf: "flex-start" }}>
            {t(`problem_${p.reason}` as "problem_other")} · {ago(p.created_at, lang)}
          </span>
          {p.message && <p className="problem__text" dir="auto">{p.message}</p>}
          {p.status === "resolved" ? (
            <div className="problem-admin__reply">
              <span className="small muted">{t("problemAnswer")}</span>
              <p className="problem__text" dir="auto">{p.reply}</p>
            </div>
          ) : (
            canAct && (
              <>
                <textarea
                  className="textarea"
                  maxLength={1000}
                  value={drafts[p.id] ?? ""}
                  placeholder={t("problemReplyPh")}
                  onChange={(e) => setDrafts((d) => ({ ...d, [p.id]: e.target.value }))}
                />
                <div className="wrap" style={{ gap: 8 }}>
                  <button type="button" className="btn btn--sm press" disabled={action.busy || (drafts[p.id] ?? "").trim().length < 2} onClick={() => void answer(p)}>
                    {action.busy ? <Spinner small /> : t("problemReplySend")}
                  </button>
                  <button type="button" className="btn btn--sm btn--ghost press" onClick={() => onOpenOrder(p.order_id)}>
                    {t("problemOpenOrder")}
                  </button>
                </div>
              </>
            )
          )}
        </article>
      ))}
    </div>
  );
}
