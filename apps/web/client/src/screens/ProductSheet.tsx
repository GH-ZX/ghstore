/** Product sheet: pick a package, fill its fields, buy from the wallet. */
import { useMemo, useRef, useState } from "react";
import { api, ApiFail, idempotencyKey } from "../lib/api";
import { toLatinDigits, usd } from "../lib/format";
import { errorText, pick } from "../lib/i18n";
import { navigate } from "../lib/router";
import { refreshMe, toast, useApp, useT } from "../lib/state";
import { haptic } from "../lib/telegram";
import { invalidate, useApi } from "../lib/useApi";
import type { InputField, Offer, ProductDetail } from "../lib/types";
import { CheckIcon } from "../ui/icons";
import { ErrorBox, Sheet, Spinner, Tile } from "../ui/kit";

interface Placed {
  orderId: string;
  number: number;
  status: string;
  balanceCents: number;
}

function fieldError(f: InputField, value: string): boolean {
  const v = value.trim();
  if (!v) return f.required;
  if (f.pattern) {
    try {
      return !new RegExp(f.pattern).test(v);
    } catch {
      return false;
    }
  }
  return false;
}

export function ProductSheet({ slug, onClose }: { slug: string; onClose: () => void }) {
  const { t, lang } = useT();
  const { me, miniApp } = useApp();
  const { data, error, reload } = useApi<ProductDetail>(`/api/products/${encodeURIComponent(slug)}`);
  const [offerId, setOfferId] = useState<string | null>(null);
  const [qty, setQty] = useState(1);
  const [values, setValues] = useState<Record<string, string>>({});
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [placed, setPlaced] = useState<Placed | null>(null);
  const [failure, setFailure] = useState<ApiFail | null>(null);
  const key = useRef(idempotencyKey());

  const offer: Offer | undefined = useMemo(() => data?.offers.find((o) => o.id === offerId) ?? data?.offers[0], [data, offerId]);
  const name = data ? pick(lang, data.product.nameAr, data.product.nameEn) : "";
  const total = (offer?.priceCents ?? 0) * qty;
  const balance = me?.balanceCents ?? 0;
  const enough = balance >= total;
  const invalid = offer ? offer.fields.some((f) => fieldError(f, values[f.key] ?? "")) : true;

  function choose(o: Offer) {
    setOfferId(o.id);
    setQty(1);
    key.current = idempotencyKey();
  }

  async function buy() {
    setTouched(true);
    if (!offer || invalid) return;
    if (!me) {
      navigate(`/login?next=${encodeURIComponent(`/p/${slug}`)}`);
      return;
    }
    if (!enough) {
      navigate(`/wallet?topup=${Math.max(total - balance, 100)}`);
      return;
    }
    setBusy(true);
    setFailure(null);
    try {
      const input: Record<string, string> = {};
      for (const f of offer.fields) if ((values[f.key] ?? "").trim()) input[f.key] = values[f.key]!.trim();
      const r = await api<Placed>("/api/orders", { body: { offerId: offer.id, quantity: qty, input, idempotencyKey: key.current } });
      haptic("success");
      setPlaced(r);
      key.current = idempotencyKey();
      invalidate("/api/orders");
      invalidate("/api/wallet");
      void refreshMe();
    } catch (e) {
      haptic("error");
      const f = e instanceof ApiFail ? e : new ApiFail("internal", 0);
      setFailure(f);
      toast(errorText(lang, f.code), true);
      if (f.code === "offer_unavailable") void reload();
    } finally {
      setBusy(false);
    }
  }

  if (placed) {
    const delivered = placed.status === "delivered";
    return (
      <Sheet onClose={onClose} label={t("orderPlaced")} head={<span />}>
        <div className="done">
          <span className="done__icon pop" style={{ background: "color-mix(in srgb, var(--good) 15%, transparent)", color: "var(--good)" }}>
            <CheckIcon size={36} />
          </span>
          <h2>{t("orderPlaced")}</h2>
          <p className="muted">{delivered ? t("orderDelivered") : t("orderProcessing")}</p>
          <button type="button" className="btn btn--block press" onClick={() => navigate(`/orders/${placed.orderId}`)}>
            {t("viewOrder")}
          </button>
          <button type="button" className="btn btn--block btn--ghost press" onClick={onClose}>
            {t("keepShopping")}
          </button>
        </div>
      </Sheet>
    );
  }

  return (
    <Sheet
      onClose={onClose}
      label={name || t("loading")}
      head={<span className="small muted">{data ? t(`kind_${data.product.kind}`) : ""}</span>}
      foot={
        data &&
        offer && (
          <>
            {me && (
              <div className="row-between small muted">
                <span>{t("balanceAfter")}</span>
                <span className="num">{usd(balance - total)}</span>
              </div>
            )}
            {me && !enough && <span className="error-text">{t("notEnough")}</span>}
            <button type="button" className="btn btn--block press" onClick={buy} disabled={busy || (touched && invalid)}>
              {busy ? (
                <Spinner small />
              ) : !me && !miniApp ? (
                t("signInToBuy")
              ) : me && !enough ? (
                t("addFunds")
              ) : (
                <>
                  {t("buy")} · <span className="num">{usd(total)}</span>
                </>
              )}
            </button>
          </>
        )
      }
    >
      {!data && !error && (
        <div className="stack">
          <div className="skeleton product-tile" />
          <div className="skeleton" style={{ height: 28, width: "60%" }} />
          <div className="skeleton" style={{ height: 50 }} />
          <div className="skeleton" style={{ height: 50 }} />
        </div>
      )}
      <ErrorBox error={error} onRetry={reload} />
      {data && offer && (
        <>
          <Tile name={data.product.nameEn} imageUrl={data.product.imageUrl} className="product-tile" />
          <h2>{name}</h2>
          <div className="row-between">
            <span className="num" style={{ fontSize: 26, fontWeight: 700, color: "var(--accent-text)" }}>
              {usd(total)}
            </span>
            <span className="badge badge--good">● {t("instant")}</span>
          </div>

          {data.offers.length > 1 && (
            <div className="stack-sm">
              <span className="small" style={{ fontWeight: 600 }}>
                {t("package")}
              </span>
              <div className="options" role="radiogroup" aria-label={t("package")}>
                {data.offers.map((o) => (
                  <button key={o.id} type="button" role="radio" aria-checked={o.id === offer.id} className="option press" onClick={() => choose(o)}>
                    <span>{pick(lang, o.nameAr, o.nameEn)}</span>
                    <span className="num">{usd(o.priceCents)}</span>
                  </button>
                ))}
              </div>
            </div>
          )}

          {offer.maxQuantity > 1 && (
            <div className="row-between">
              <span className="small" style={{ fontWeight: 600 }}>
                {t("quantity")}
              </span>
              <div className="seg" role="group" aria-label={t("quantity")}>
                <button type="button" className="press" onClick={() => setQty((q) => Math.max(1, q - 1))} aria-label="−">
                  −
                </button>
                <button type="button" aria-pressed="true" className="num" style={{ minWidth: 44 }}>
                  {qty}
                </button>
                <button type="button" className="press" onClick={() => setQty((q) => Math.min(offer.maxQuantity, q + 1))} aria-label="+">
                  +
                </button>
              </div>
            </div>
          )}

          {offer.fields.map((f) => {
            const value = values[f.key] ?? "";
            const bad = (touched || value !== "") && fieldError(f, value);
            const numeric = f.pattern ? /^\^?\[0-9\]|\\d/.test(f.pattern) : false;
            return (
              <label key={f.key} className="field">
                <span>
                  {pick(lang, f.labelAr, f.labelEn)}
                  {f.required && <span className="muted"> *</span>}
                </span>
                <input
                  className="input"
                  dir="ltr"
                  value={value}
                  inputMode={numeric ? "numeric" : "text"}
                  autoComplete="off"
                  aria-invalid={bad}
                  onChange={(e) => setValues((v) => ({ ...v, [f.key]: toLatinDigits(e.target.value) }))}
                />
                {bad && <span className="error-text">{value.trim() ? t("invalidValue") : t("required")}</span>}
                {failure?.field === `input.${f.key}` && <span className="error-text">{t("invalidValue")}</span>}
              </label>
            );
          })}

          {pick(lang, data.product.descriptionAr, data.product.descriptionEn) ? (
            <div className="prose">{pick(lang, data.product.descriptionAr, data.product.descriptionEn)}</div>
          ) : (
            <div className="stack-sm">
              <span className="small" style={{ fontWeight: 600 }}>
                {t("included")}
              </span>
              {(["f1", "f2", "f3"] as const).map((k) => (
                <span key={k} className="wrap" style={{ fontSize: 14 }}>
                  <span className="good">
                    <CheckIcon />
                  </span>
                  {t(k)}
                </span>
              ))}
            </div>
          )}
          {pick(lang, data.product.instructionsAr, data.product.instructionsEn) && (
            <div className="stack-sm">
              <h3>{t("instructions")}</h3>
              <div className="prose">{pick(lang, data.product.instructionsAr, data.product.instructionsEn)}</div>
            </div>
          )}
          {pick(lang, data.product.warrantyAr, data.product.warrantyEn) && (
            <div className="stack-sm">
              <h3>{t("warranty")}</h3>
              <div className="prose">{pick(lang, data.product.warrantyAr, data.product.warrantyEn)}</div>
            </div>
          )}
        </>
      )}
    </Sheet>
  );
}
