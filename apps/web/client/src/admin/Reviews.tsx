/** Admin → Reviews: the customers' latest reviews, to hide or remove one (spam, abuse). */
import { useState } from "react";
import { pick } from "../lib/i18n";
import { useT } from "../lib/state";
import { useApi } from "../lib/useApi";
import { Stars } from "../screens/Reviews";
import { Empty, ErrorBox, Seg } from "../ui/kit";
import { ago, useAction } from "./common";

interface AdminReview {
  id: string;
  rating: number;
  comment: string;
  status: "visible" | "hidden";
  created_at: string;
  user_id: string;
  display_name: string;
  slug: string;
  name_ar: string;
  name_en: string;
}

export function ReviewsAdmin({ owner }: { owner: boolean }) {
  const { t, lang } = useT();
  const action = useAction();
  const [status, setStatus] = useState<"all" | "visible" | "hidden">("all");
  const { data, error, reload } = useApi<{ reviews: AdminReview[] }>(`/api/admin/reviews${status === "all" ? "" : `?status=${status}`}`);

  async function setVisible(r: AdminReview, visible: boolean) {
    if (await action.run(`/api/admin/reviews/${r.id}`, { method: "PATCH", body: { status: visible ? "visible" : "hidden" } })) await reload();
  }

  async function remove(r: AdminReview) {
    if (!confirm(t("reviewDeleteConfirm"))) return;
    if (await action.run(`/api/admin/reviews/${r.id}`, { method: "DELETE" })) await reload();
  }

  const rows = data?.reviews ?? [];
  const average = rows.length ? rows.reduce((a, r) => a + Number(r.rating), 0) / rows.length : 0;
  return (
    <div className="stack">
      <div className="row-between" style={{ flexWrap: "wrap", gap: 8 }}>
        <Seg
          value={status}
          onChange={setStatus}
          label={t("reviews")}
          options={[
            { value: "all", label: t("all") },
            { value: "visible", label: t("reviewShownF") },
            { value: "hidden", label: t("reviewHiddenF") },
          ]}
        />
        {rows.length > 0 && (
          <span className="reviews__avg">
            <Stars value={average} />
            <b className="num">{average.toFixed(1)}</b>
            <span className="muted small">({rows.length})</span>
          </span>
        )}
      </div>
      <ErrorBox error={error} onRetry={reload} />
      {!data && !error && <div className="skeleton" style={{ height: 200 }} />}
      {data && rows.length === 0 && <Empty>{t("noReviews")}</Empty>}
      <div className="stack-sm">
        {rows.map((r) => (
          <article key={r.id} className={`card card--pad stack-sm review-admin${r.status === "hidden" ? " review-admin--hidden" : ""}`}>
            <div className="row-between">
              <a href={`/p/${r.slug}`} target="_blank" rel="noopener" className="review-admin__product">
                {pick(lang, r.name_ar, r.name_en)}
              </a>
              <Stars value={Number(r.rating)} />
            </div>
            {r.comment ? <p className="reviews__text">{r.comment}</p> : <span className="small muted">{t("reviewNoText")}</span>}
            <div className="row-between small muted">
              <span>
                <bdi>{r.display_name || t("customer")}</bdi> · {ago(r.created_at, lang)}
                {r.status === "hidden" && ` · ${t("reviewHiddenF")}`}
              </span>
              <span className="wrap" style={{ gap: 6 }}>
                <button type="button" className="btn btn--xs btn--soft press" disabled={action.busy} onClick={() => void setVisible(r, r.status === "hidden")}>
                  {r.status === "hidden" ? t("reviewShow") : t("reviewHide")}
                </button>
                {owner && (
                  <button type="button" className="btn btn--xs btn--ghost press" disabled={action.busy} onClick={() => void remove(r)}>
                    {t("delete")}
                  </button>
                )}
              </span>
            </div>
          </article>
        ))}
      </div>
    </div>
  );
}
