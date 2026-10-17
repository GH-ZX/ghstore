/**
 * Orders list and order detail with copyable deliveries; virtual numbers get
 * their own panel, and products delivered by hand ask for the customer's
 * details after paying.
 */
import { ProblemCard } from "./Problem";
import { useEffect, useState } from "react";
import { api, ApiFail } from "../lib/api";
import { copyText, dateTime, usd } from "../lib/format";
import { errorText, pick } from "../lib/i18n";
import { linkHandler, navigate } from "../lib/router";
import { toast, useT } from "../lib/state";
import { haptic } from "../lib/telegram";
import { useApi } from "../lib/useApi";
import type { OrderDetail, OrderRow, OrderStatus } from "../lib/types";
import { CheckIcon, ChevronIcon } from "../ui/icons";
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
                  <bdi>{pick(lang, o.packageAr, o.packageEn)}</bdi> · <span className="num">#{o.number}</span> · {dateTime(o.createdAt, lang)}
                </span>
              </span>
              <span className="list-row__end">
                <span className="num" style={{ fontWeight: 700 }}>
                  {usd(o.totalCents)}
                </span>
                <span className="small" style={{ color: STATUS_COLOR[o.status], fontWeight: 600 }}>
                  {o.hold === "info" && (o.status === "paid" || o.status === "processing") ? t("holdInfoShort") : t(`st_${o.status}`)}
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
  const hold = open ? data?.order.hold ?? null : null;

  // While the supplier (or the team) is still working, check again every few
  // seconds; not while the customer is filling in their details.
  useEffect(() => {
    if (!open || hold === "info") return;
    const timer = setInterval(() => void reload(), hold ? 15000 : 5000);
    return () => clearInterval(timer);
  }, [open, hold, reload]);

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
        <bdi className="muted">{pick(lang, o.packageAr, o.packageEn)}</bdi>
        <div className="row-between">
          <span className="num" style={{ fontSize: 22, fontWeight: 700 }}>
            {usd(o.totalCents)}
          </span>
          <span className="badge" style={{ color: STATUS_COLOR[o.status], background: "var(--surface-2)" }}>
            ● {hold === "info" ? t("holdInfoShort") : hold ? t("st_processing") : t(`st_${o.status}`)}
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

      {o.canAnswer && <DetailsPanel data={data} onSent={reload} />}

      {open && o.kind !== "sms" && hold !== "info" && (
        <div className="card card--pad status-wait">
          <Spinner small />
          <span>{hold ? t("holdTeam") : t("inProgress")}</span>
        </div>
      )}
      {o.status === "refunded" && <div className="card card--pad">{t("refundedNote")}</div>}

      <ProblemCard orderId={o.id} problem={o.problem} onSent={() => void reload()} />

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

      {o.productSlug && o.status === "delivered" && (
        <button type="button" className="btn btn--block btn--soft press" onClick={() => navigate(`/p/${o.productSlug}?review=1`)}>
          ★ {t("rateIt")}
        </button>
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
  const [busy, setBusy] = useState<"cancel" | "used" | "again" | null>(null);
  const o = data.order;
  const phone = data.deliveries.find((d) => d.kind === "phone");
  const codes = data.deliveries.filter((d) => d.kind === "sms");
  const waiting = (o.status === "paid" || o.status === "processing") && codes.length === 0;
  const left = useCountdown(waiting ? o.expiresAt : null);

  /**
   * No code? Report this number (refunded) and buy the next one in one go, as
   * 5sim users do until a code arrives.
   */
  async function another() {
    setBusy("again");
    try {
      const r = await api<{ closed: boolean; orderId?: string; againError?: string; againLimit?: number }>(`/api/orders/${o.id}/number`, { method: "POST", body: { action: "used", again: true } });
      if (!r.closed) {
        toast(t("numCodeArrived"));
        onChanged();
      } else if (r.orderId) {
        haptic("tap");
        toast(t("numAnother"));
        navigate(`/orders/${r.orderId}`, { replace: true });
      } else if (r.againLimit) {
        toast(t("numAgainLimit", { n: r.againLimit }), true);
        onChanged();
      } else {
        toast(`${t("numClosed")} · ${errorText(lang, r.againError ?? "internal")}`, true);
        onChanged();
      }
    } catch (e) {
      toast(errorText(lang, e instanceof ApiFail ? e.code : "internal"), true);
    } finally {
      setBusy(null);
    }
  }

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
              <button type="button" className="btn btn--sm press" disabled={busy !== null} onClick={another}>
                {busy === "again" ? <Spinner small /> : t("numTryAnother")}
              </button>
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

/**
 * The details a product needs after paying (email, password, cookies...).
 * Once sent they can be corrected until the order is delivered; secrets are
 * never shown back, and an empty secret keeps the one already sent.
 */
function DetailsPanel({ data, onSent }: { data: OrderDetail; onSent: () => void }) {
  const { t, lang } = useT();
  const o = data.order;
  const fields = o.afterFields ?? [];
  const sent = o.hold !== "info";
  const [editing, setEditing] = useState(!sent);
  const [values, setValues] = useState<Record<string, string>>(() => Object.fromEntries(fields.map((f) => [f.key, f.value ?? ""])));
  const [show, setShow] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState(false);
  const [bad, setBad] = useState<string | null>(null);

  async function send(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setBad(null);
    try {
      await api(`/api/orders/${o.id}/answers`, { body: { values } });
      haptic("success");
      toast(t("afterSent"));
      setEditing(false);
      onSent();
    } catch (err) {
      const f = err instanceof ApiFail ? err : new ApiFail("internal", 0);
      if (f.field?.startsWith("answers.")) setBad(f.field.slice(8));
      toast(errorText(lang, f.code), true);
      haptic("error");
    } finally {
      setBusy(false);
    }
  }

  if (!editing) {
    return (
      <div className="card card--pad stack-sm">
        <div className="row-between">
          <strong className="good wrap" style={{ gap: 6 }}>
            <CheckIcon /> {t("afterGiven")}
          </strong>
          <button type="button" className="btn btn--xs btn--ghost press" onClick={() => setEditing(true)}>
            {t("afterEdit")}
          </button>
        </div>
        {fields.map((f) => (
          <div key={f.key} className="row-between small">
            <span className="muted">{pick(lang, f.labelAr, f.labelEn)}</span>
            <span dir="ltr">{f.value ?? (f.given ? "••••••" : "—")}</span>
          </div>
        ))}
      </div>
    );
  }

  return (
    <form className="card card--pad stack details-form" onSubmit={send}>
      <div className="stack-sm">
        <h3>{t("afterFormTitle")}</h3>
        <span className="small muted">{t("afterFormHint")}</span>
      </div>
      {fields.map((f) => {
        const label = pick(lang, f.labelAr, f.labelEn);
        const hint = pick(lang, f.hintAr ?? "", f.hintEn ?? "");
        const set = (v: string) => setValues((x) => ({ ...x, [f.key]: v }));
        const v = values[f.key] ?? "";
        const keep = sent && f.given && (f.type === "password" || f.type === "token");
        return (
          <label key={f.key} className="field">
            <span>
              {label}
              {f.required && <span className="muted"> *</span>}
            </span>
            {f.type === "token" || f.type === "custom" ? (
              <textarea
                className={f.type === "token" ? "input input--mono" : "input"}
                dir={f.type === "token" ? "ltr" : "auto"}
                rows={f.type === "token" ? 4 : 2}
                value={v}
                placeholder={keep ? t("afterKeep") : undefined}
                aria-invalid={bad === f.key || undefined}
                spellCheck={false}
                onChange={(e) => set(e.target.value)}
              />
            ) : (
              <span className="input-wrap">
                <input
                  className="input"
                  dir="ltr"
                  type={f.type === "email" ? "email" : f.type === "password" && !show[f.key] ? "password" : "text"}
                  autoComplete={f.type === "email" ? "email" : "off"}
                  value={v}
                  placeholder={keep ? t("afterKeep") : undefined}
                  aria-invalid={bad === f.key || undefined}
                  onChange={(e) => set(e.target.value)}
                />
                {f.type === "password" && (
                  <button type="button" className="btn btn--xs btn--ghost press" onClick={() => setShow((x) => ({ ...x, [f.key]: !x[f.key] }))}>
                    {show[f.key] ? t("hide") : t("show")}
                  </button>
                )}
              </span>
            )}
            {hint && <span className="small muted">{hint}</span>}
            {bad === f.key && <span className="error-text">{v.trim() ? t("invalidValue") : t("required")}</span>}
          </label>
        );
      })}
      <span className="small muted">🔒 {t("afterPrivacy")}</span>
      <div className="wrap">
        <button className="btn press" disabled={busy}>
          {busy ? <Spinner small /> : sent ? t("afterResend") : t("afterSubmit")}
        </button>
        {sent && (
          <button type="button" className="btn btn--ghost press" onClick={() => setEditing(false)}>
            {t("cancel")}
          </button>
        )}
      </div>
    </form>
  );
}
