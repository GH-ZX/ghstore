/**
 * A product's reviews, in its sheet: the stars and how they spread, the latest
 * reviews, and — for a customer who received the product — their own rating
 * (Rate this product, change it, remove it). See packages/api/src/reviews.ts.
 */
import { useEffect, useRef, useState } from "react";
import { api, ApiFail } from "../lib/api";
import { errorText } from "../lib/i18n";
import { toast, useApp, useT } from "../lib/state";
import { haptic } from "../lib/telegram";
import { invalidate, useApi } from "../lib/useApi";
import { Spinner } from "../ui/kit";

interface Review {
  id: string;
  name: string;
  rating: number;
  comment: string;
  createdAt: string;
  mine: boolean;
}

interface ReviewsData {
  summary: { average: number; count: number; stars: number[] };
  reviews: Review[];
  more: boolean;
  mine: { rating: number; comment: string; hidden: boolean } | null;
  canReview: boolean;
}

/** Five stars, filled to `value` (halves show as a partly filled star). */
export function Stars({ value, size = 14 }: { value: number; size?: number }) {
  return (
    <span className="stars" aria-hidden="true">
      {[0, 1, 2, 3, 4].map((i) => {
        const fill = Math.max(0, Math.min(1, value - i));
        return (
          <span key={i} className="stars__one" style={{ width: size, height: size }}>
            <svg viewBox="0 0 24 24" width={size} height={size}><path className="stars__empty" d={STAR} /></svg>
            <span className="stars__fill" style={{ width: `${fill * 100}%` }}>
              <svg viewBox="0 0 24 24" width={size} height={size}><path d={STAR} /></svg>
            </span>
          </span>
        );
      })}
    </span>
  );
}

const STAR = "M12 2.6l2.9 6 6.6.9-4.8 4.6 1.2 6.5L12 17.5l-5.9 3.1 1.2-6.5L2.5 9.5l6.6-.9z";

export function ProductReviews({ slug, focus }: { slug: string; focus?: boolean }) {
  const { t, lang } = useT();
  const { me } = useApp();
  const path = `/api/products/${encodeURIComponent(slug)}/reviews`;
  const { data, reload } = useApi<ReviewsData>(path);
  const [extra, setExtra] = useState<Review[]>([]);
  const [more, setMore] = useState<boolean | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [editing, setEditing] = useState(false);
  const [rating, setRating] = useState(0);
  const [comment, setComment] = useState("");
  const [busy, setBusy] = useState(false);
  const box = useRef<HTMLElement>(null);

  // From an order's "Rate this product": open the form and bring it into view.
  useEffect(() => {
    if (!focus || !data) return;
    box.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    if (data.canReview) startEditing(data.mine?.rating ?? 0, data.mine?.comment ?? "");
  }, [focus, data]);

  if (!data) return null;
  const s = data.summary;
  const list = [...data.reviews, ...extra];
  const hasMore = more ?? data.more;
  const date = (iso: string) =>
    new Intl.DateTimeFormat(lang === "ar" ? "ar-SY-u-nu-latn" : "en-GB", { day: "numeric", month: "short", year: "numeric" }).format(new Date(iso));

  function startEditing(r: number, c: string) {
    setRating(r);
    setComment(c);
    setEditing(true);
  }

  async function refresh() {
    setExtra([]);
    setMore(null);
    invalidate(path);
    await reload();
  }

  async function save() {
    if (!rating) return;
    setBusy(true);
    try {
      await api(`/api/products/${encodeURIComponent(slug)}/review`, { method: "PUT", body: { rating, comment } });
      haptic("success");
      toast(t("reviewThanks"));
      setEditing(false);
      await refresh();
    } catch (e) {
      toast(errorText(lang, e instanceof ApiFail ? e.code : "internal"), true);
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    setBusy(true);
    try {
      await api(`/api/products/${encodeURIComponent(slug)}/review`, { method: "DELETE" });
      toast(t("reviewDeleted"));
      setEditing(false);
      await refresh();
    } catch (e) {
      toast(errorText(lang, e instanceof ApiFail ? e.code : "internal"), true);
    } finally {
      setBusy(false);
    }
  }

  async function loadMore() {
    const last = list[list.length - 1];
    if (!last) return;
    setLoadingMore(true);
    try {
      const r = await api<ReviewsData>(`${path}?before=${encodeURIComponent(last.createdAt)}`);
      setExtra((x) => [...x, ...r.reviews]);
      setMore(r.more);
    } catch (e) {
      toast(errorText(lang, e instanceof ApiFail ? e.code : "internal"), true);
    } finally {
      setLoadingMore(false);
    }
  }

  return (
    <section className="reviews stack-sm" ref={box} id="reviews">
      <div className="row-between">
        <h3>{t("reviews")}</h3>
        {s.count > 0 && (
          <span className="reviews__avg">
            <Stars value={s.average} />
            <b className="num">{s.average.toFixed(1)}</b>
            <span className="muted small">({s.count})</span>
          </span>
        )}
      </div>

      {s.count > 1 && (
        <div className="reviews__bars" aria-hidden="true">
          {s.stars.map((c, i) => (
            <div key={i} className="reviews__bar">
              <span className="num">{5 - i}★</span>
              <i>
                <b style={{ width: `${(c / s.count) * 100}%` }} />
              </i>
              <span className="num muted">{c}</span>
            </div>
          ))}
        </div>
      )}

      {data.canReview &&
        (editing ? (
          <form
            className="card card--pad stack-sm reviews__form"
            onSubmit={(e) => {
              e.preventDefault();
              void save();
            }}
          >
            <strong>{data.mine ? t("yourReview") : t("rateIt")}</strong>
            <div className="star-input" role="radiogroup" aria-label={t("rateIt")} dir="ltr">
              {[1, 2, 3, 4, 5].map((n) => (
                <button
                  key={n}
                  type="button"
                  role="radio"
                  aria-checked={rating === n}
                  aria-label={t("starsLabel", { n })}
                  className={`star-input__one press${n <= rating ? " star-input__one--on" : ""}`}
                  onClick={() => {
                    haptic("tap");
                    setRating(n);
                  }}
                >
                  <svg viewBox="0 0 24 24" width="34" height="34" aria-hidden="true"><path d={STAR} /></svg>
                </button>
              ))}
            </div>
            <textarea className="textarea" maxLength={600} value={comment} placeholder={t("reviewPh")} onChange={(e) => setComment(e.target.value)} />
            <div className="wrap" style={{ gap: 8 }}>
              <button className="btn btn--sm press" disabled={busy || !rating}>
                {busy ? <Spinner small /> : t("reviewSend")}
              </button>
              <button type="button" className="btn btn--sm btn--ghost press" disabled={busy} onClick={() => setEditing(false)}>
                {t("cancel")}
              </button>
            </div>
          </form>
        ) : data.mine ? (
          <div className="card card--pad stack-sm reviews__mine">
            <div className="row-between">
              <strong>{t("yourReview")}</strong>
              <Stars value={data.mine.rating} />
            </div>
            {data.mine.comment && <p className="reviews__text">{data.mine.comment}</p>}
            {data.mine.hidden && <span className="small muted">{t("reviewHidden")}</span>}
            <div className="wrap" style={{ gap: 8 }}>
              <button type="button" className="btn btn--xs btn--soft press" disabled={busy} onClick={() => startEditing(data.mine!.rating, data.mine!.comment)}>
                {t("edit")}
              </button>
              <button type="button" className="btn btn--xs btn--ghost press" disabled={busy} onClick={() => void remove()}>
                {t("reviewRemove")}
              </button>
            </div>
          </div>
        ) : (
          <button type="button" className="btn btn--block btn--soft press reviews__rate" onClick={() => startEditing(0, "")}>
            <Stars value={0} size={16} /> {t("rateIt")}
          </button>
        ))}

      {list.length === 0 ? (
        <p className="small muted">{me && !data.canReview ? t("reviewsOnlyBuyers") : t("noReviews")}</p>
      ) : (
        <div className="stack-sm">
          {list
            .filter((r) => !r.mine)
            .map((r) => (
              <article key={r.id} className="review">
                <div className="row-between">
                  <b>{r.name || t("customer")}</b>
                  <Stars value={r.rating} size={13} />
                </div>
                {r.comment && <p className="reviews__text">{r.comment}</p>}
                <span className="small muted">{date(r.createdAt)}</span>
              </article>
            ))}
        </div>
      )}
      {hasMore && (
        <button type="button" className="pk-more press" disabled={loadingMore} onClick={() => void loadMore()}>
          {loadingMore ? <Spinner small /> : t("reviewsMore")}
        </button>
      )}
    </section>
  );
}
