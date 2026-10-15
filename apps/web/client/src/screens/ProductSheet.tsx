/** Product sheet: pick a package, fill its fields, buy from the wallet. */
import { useEffect, useMemo, useRef, useState } from "react";
import { api, ApiFail, idempotencyKey } from "../lib/api";
import { copyText, toLatinDigits, usd } from "../lib/format";
import { errorText, pick } from "../lib/i18n";
import { navigate } from "../lib/router";
import { refreshMe, toast, useApp, useT } from "../lib/state";
import { haptic, openTelegramLink } from "../lib/telegram";
import { invalidate, useApi } from "../lib/useApi";
import type { CouponQuote, InputField, Offer, ProductDetail } from "../lib/types";
import { CheckIcon, ShareIcon } from "../ui/icons";
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
  if (f.options?.length) return !f.options.some((o) => o.value === v);
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
  const [coupon, setCoupon] = useState<CouponQuote | null>(null);
  const [couponOpen, setCouponOpen] = useState(false);
  const [couponText, setCouponText] = useState("");
  const [couponErr, setCouponErr] = useState<string | null>(null);
  const [couponBusy, setCouponBusy] = useState(false);
  const key = useRef(idempotencyKey());

  const offer: Offer | undefined = useMemo(() => data?.offers.find((o) => o.id === offerId) ?? data?.offers[0], [data, offerId]);
  const name = data ? pick(lang, data.product.nameAr, data.product.nameEn) : "";
  const listTotal = (offer?.priceCents ?? 0) * qty;
  const total = coupon ? coupon.totalCents : listTotal;
  const balance = me?.balanceCents ?? 0;
  const enough = balance >= total;
  const invalid = offer ? offer.fields.some((f) => fieldError(f, values[f.key] ?? "")) : true;

  /** Share the product's page (it shows a preview with its name, picture and price). */
  async function share() {
    const link = `${location.origin}/p/${slug}`;
    haptic();
    if (miniApp) {
      openTelegramLink(`https://t.me/share/url?url=${encodeURIComponent(link)}&text=${encodeURIComponent(name)}`);
      return;
    }
    if (typeof navigator.share === "function") {
      try {
        await navigator.share({ url: link, title: name });
        return;
      } catch {
        /* closed: copy instead */
      }
    }
    if (await copyText(link)) toast(t("linkCopied"));
  }

  function choose(o: Offer) {
    setOfferId(o.id);
    setQty(1);
    key.current = idempotencyKey();
  }

  async function applyCoupon(code: string): Promise<void> {
    if (!offer || !code.trim()) return;
    setCouponBusy(true);
    setCouponErr(null);
    try {
      const q = await api<CouponQuote>("/api/coupons/quote", { body: { offerId: offer.id, quantity: qty, code: code.trim() } });
      setCoupon(q);
      setCouponOpen(false);
      haptic("success");
    } catch (e) {
      setCoupon(null);
      setCouponOpen(true);
      setCouponText(code);
      setCouponErr(errorText(lang, e instanceof ApiFail ? e.code : "internal"));
      haptic("error");
    } finally {
      setCouponBusy(false);
    }
  }

  // A different package or quantity changes the discount: ask again.
  const appliedCode = useRef<string | null>(null);
  appliedCode.current = coupon?.code ?? null;
  useEffect(() => {
    if (appliedCode.current) void applyCoupon(appliedCode.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [offer?.id, qty]);

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
      const r = await api<Placed>("/api/orders", { body: { offerId: offer.id, quantity: qty, input, idempotencyKey: key.current, coupon: coupon?.code } });
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
      if (f.code.startsWith("coupon_")) {
        setCoupon(null);
        setCouponOpen(true);
        setCouponErr(errorText(lang, f.code));
      }
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
      head={
        <span className="wrap" style={{ gap: 10, flexWrap: "nowrap" }}>
          <span className="small muted">{data ? t(`kind_${data.product.kind}`) : ""}</span>
          {data && (
            <button type="button" className="icon-btn press" aria-label={t("share")} onClick={share}>
              <ShareIcon />
            </button>
          )}
        </span>
      }
      foot={
        data &&
        offer && (
          <>
            {coupon && (
              <div className="row-between small">
                <span className="good">{t("discount")} · {coupon.code}</span>
                <span className="num good">−{usd(coupon.discountCents)}</span>
              </div>
            )}
            {me && (
              <div className="row-between small muted">
                <span>{t("balanceAfter")}</span>
                <span className="num">{usd(balance - total)}</span>
              </div>
            )}
            {me && !enough && <span className="error-text">{t("notEnough")}</span>}
            <button type="button" className="btn btn--block press" onClick={buy} disabled={busy || couponBusy || (touched && invalid)}>
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
            <span className="wrap" style={{ gap: 8, alignItems: "baseline" }}>
              <span className="num" style={{ fontSize: 26, fontWeight: 700, color: "var(--accent-text)" }}>
                {usd(total)}
              </span>
              {coupon && (
                <s className="num muted" style={{ fontSize: 15 }}>
                  {usd(listTotal)}
                </s>
              )}
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
            if (f.options?.length) {
              const label = pick(lang, f.labelAr, f.labelEn);
              const set = (v: string) => setValues((x) => ({ ...x, [f.key]: v }));
              return (
                <div key={f.key} className="field">
                  <span>
                    {label}
                    {f.required && <span className="muted"> *</span>}
                  </span>
                  {f.options.length <= 8 ? (
                    <div className="wrap" role="radiogroup" aria-label={label} style={{ gap: 8 }}>
                      {f.options.map((o) => (
                        <button key={o.value} type="button" role="radio" aria-checked={value === o.value} aria-pressed={value === o.value} className="chip chip--sm press" onClick={() => set(o.value)}>
                          {pick(lang, o.labelAr, o.labelEn) || o.value}
                        </button>
                      ))}
                    </div>
                  ) : (
                    <select className="select" value={value} aria-label={label} aria-invalid={bad} onChange={(e) => set(e.target.value)}>
                      <option value="">{t("chooseOne")}</option>
                      {f.options.map((o) => (
                        <option key={o.value} value={o.value}>
                          {pick(lang, o.labelAr, o.labelEn) || o.value}
                        </option>
                      ))}
                    </select>
                  )}
                  {bad && <span className="error-text">{t("required")}</span>}
                </div>
              );
            }
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

          {me && (
            <div className="stack-sm">
              {coupon ? (
                <div className="copy-box" style={{ fontFamily: "inherit" }}>
                  <span className="good wrap" style={{ fontWeight: 600, gap: 6, flexWrap: "nowrap" }}>
                    <CheckIcon />
                    {t("couponApplied", { code: coupon.code })}
                  </span>
                  <button type="button" className="btn btn--xs btn--ghost press" onClick={() => { setCoupon(null); setCouponText(""); }}>
                    {t("removeCoupon")}
                  </button>
                </div>
              ) : couponOpen ? (
                <form
                  className="wrap"
                  style={{ gap: 8, flexWrap: "nowrap" }}
                  onSubmit={(e) => {
                    e.preventDefault();
                    void applyCoupon(couponText);
                  }}
                >
                  <input
                    className="input"
                    dir="ltr"
                    style={{ flex: 1, minWidth: 0, textTransform: "uppercase" }}
                    value={couponText}
                    placeholder={t("couponPh")}
                    aria-label={t("couponPh")}
                    aria-invalid={couponErr ? true : undefined}
                    autoComplete="off"
                    autoCapitalize="characters"
                    maxLength={32}
                    onChange={(e) => {
                      setCouponText(toLatinDigits(e.target.value).replace(/[^A-Za-z0-9_-]/g, ""));
                      setCouponErr(null);
                    }}
                  />
                  <button className="btn btn--sm btn--soft press" disabled={couponBusy || couponText.trim().length < 3}>
                    {couponBusy ? <Spinner small /> : t("apply")}
                  </button>
                </form>
              ) : (
                <button type="button" className="btn btn--xs btn--ghost press" style={{ alignSelf: "flex-start" }} onClick={() => setCouponOpen(true)}>
                  {t("haveCode")}
                </button>
              )}
              {couponErr && <span className="error-text">{couponErr}</span>}
            </div>
          )}

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
