/** Coupons: codes that take a percentage or an amount off one order. Owner only. */
import { useState } from "react";
import { dateTime, dollarsToCents, toLatinDigits, usd } from "../lib/format";
import { pick } from "../lib/i18n";
import { useT } from "../lib/state";
import type { AdminCoupon } from "../lib/types";
import { useApi } from "../lib/useApi";
import { Empty, ErrorBox, Seg, Sheet, Spinner, Switch } from "../ui/kit";
import { useAction } from "./common";

interface ProductLite {
  id: string;
  name_ar: string;
  name_en: string;
}

/** yyyy-mm-dd (local) ↔ ISO. An end date means "valid through that day". */
function dayToIso(day: string, end: boolean): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return null;
  const d = new Date(`${day}T00:00:00`);
  if (end) d.setDate(d.getDate() + 1);
  return d.toISOString();
}
function isoToDay(iso: string | null, end: boolean): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (end) d.setDate(d.getDate() - 1);
  const p = (x: number) => String(x).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function Coupons() {
  const { t, lang } = useT();
  const { data, error, reload } = useApi<{ coupons: AdminCoupon[] }>("/api/admin/coupons");
  const catalog = useApi<{ products: ProductLite[] }>("/api/admin/catalog");
  const [editing, setEditing] = useState<AdminCoupon | "new" | null>(null);

  const offText = (c: AdminCoupon) =>
    c.percentOff !== null ? `${c.percentOff}%${c.maxDiscountCents ? ` ≤ ${usd(c.maxDiscountCents)}` : ""}` : usd(c.amountOffCents ?? 0);

  return (
    <div className="stack">
      <div className="wrap">
        <button type="button" className="btn btn--sm press" onClick={() => setEditing("new")}>
          {t("newCoupon")}
        </button>
      </div>
      <p className="hint">{t("couponHint")}</p>
      <ErrorBox error={error} onRetry={reload} />
      {!data && !error && <div className="skeleton" style={{ height: 200 }} />}
      {data && data.coupons.length === 0 && <Empty>{t("none")}</Empty>}
      {data && data.coupons.length > 0 && (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>{t("couponCode")}</th>
                <th>{t("discountType")}</th>
                <th>{t("product")}</th>
                <th>{t("uses")}</th>
                <th>{t("discountGiven")}</th>
                <th>{t("ends")}</th>
                <th>{t("status")}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {data.coupons.map((c) => (
                <tr key={c.id} style={{ opacity: c.active ? 1 : 0.55 }}>
                  <td className="num" style={{ fontWeight: 700 }}>
                    {c.code}
                  </td>
                  <td className="num">{offText(c)}</td>
                  <td>{c.productId ? pick(lang, c.productAr, c.productEn) : t("anyProduct")}</td>
                  <td className="num">
                    {c.uses} / {c.maxUses ?? "∞"}
                  </td>
                  <td className="num">{usd(c.discountTotalCents)}</td>
                  <td className="small">{c.expiresAt ? dateTime(c.expiresAt, lang) : "—"}</td>
                  <td>
                    <span className={c.active ? "badge badge--good" : "badge"}>{c.active ? t("enabled") : t("inactive")}</span>
                  </td>
                  <td>
                    <button type="button" className="btn btn--xs btn--ghost press" onClick={() => setEditing(c)}>
                      {t("edit")}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {editing && (
        <CouponSheet
          coupon={editing === "new" ? null : editing}
          products={catalog.data?.products ?? []}
          onClose={(changed) => {
            setEditing(null);
            if (changed) void reload();
          }}
        />
      )}
    </div>
  );
}

function CouponSheet({ coupon, products, onClose }: { coupon: AdminCoupon | null; products: ProductLite[]; onClose: (changed: boolean) => void }) {
  const { t, lang } = useT();
  const action = useAction();
  const [code, setCode] = useState(coupon?.code ?? "");
  const [type, setType] = useState<"percent" | "amount">(coupon?.amountOffCents ? "amount" : "percent");
  const [percent, setPercent] = useState(coupon?.percentOff !== null && coupon?.percentOff !== undefined ? String(coupon.percentOff) : "10");
  const [amount, setAmount] = useState(coupon?.amountOffCents ? (coupon.amountOffCents / 100).toFixed(2) : "");
  const [maxDiscount, setMaxDiscount] = useState(coupon?.maxDiscountCents ? (coupon.maxDiscountCents / 100).toFixed(2) : "");
  const [minOrder, setMinOrder] = useState(coupon?.minOrderCents ? (coupon.minOrderCents / 100).toFixed(2) : "");
  const [productId, setProductId] = useState(coupon?.productId ?? "");
  const [maxUses, setMaxUses] = useState(coupon?.maxUses ? String(coupon.maxUses) : "");
  const [perUser, setPerUser] = useState(String(coupon?.maxUsesPerUser ?? 1));
  const [starts, setStarts] = useState(isoToDay(coupon?.startsAt ?? null, false));
  const [ends, setEnds] = useState(isoToDay(coupon?.expiresAt ?? null, true));
  const [active, setActive] = useState(coupon?.active ?? true);
  const [note, setNote] = useState(coupon?.note ?? "");

  const pct = Number(toLatinDigits(percent));
  const amountCents = dollarsToCents(amount);
  const maxDiscountCents = maxDiscount.trim() ? dollarsToCents(maxDiscount) : null;
  const minOrderCents = minOrder.trim() ? dollarsToCents(minOrder) : 0;
  const valueOk = type === "percent" ? pct > 0 && pct <= 100 && Number.isFinite(pct) : amountCents !== null && amountCents > 0;
  const codeOk = /^[A-Za-z0-9_-]{3,32}$/.test(code.trim());
  const datesOk = !starts || !ends || starts <= ends;
  const ok =
    valueOk && (coupon || codeOk) && datesOk && minOrderCents !== null &&
    (!maxDiscount.trim() || (maxDiscountCents !== null && maxDiscountCents > 0)) && Number(perUser) >= 1;

  async function save() {
    if (!ok) return;
    const body: Record<string, unknown> = {
      ...(type === "percent" ? { percentOff: Math.round(pct * 100) / 100 } : { amountOffCents: amountCents }),
      maxDiscountCents: type === "percent" ? maxDiscountCents : null,
      minOrderCents: minOrderCents ?? 0,
      productId: productId || null,
      maxUses: maxUses.trim() ? Number(maxUses) : null,
      maxUsesPerUser: Number(perUser),
      startsAt: starts ? dayToIso(starts, false) : null,
      expiresAt: ends ? dayToIso(ends, true) : null,
      active,
      note: note.trim(),
    };
    const r = coupon
      ? await action.run(`/api/admin/coupons/${coupon.id}`, { method: "PATCH", body })
      : await action.run("/api/admin/coupons", { body: { ...body, code: code.trim().toUpperCase() } });
    if (r) onClose(true);
  }

  const digits = (v: string) => toLatinDigits(v).replace(/[^\d.]/g, "");
  return (
    <Sheet
      onClose={() => onClose(false)}
      label={coupon ? coupon.code : t("newCoupon")}
      foot={
        <button type="button" className="btn btn--block press" disabled={!ok || action.busy} onClick={save}>
          {action.busy ? <Spinner small /> : t("save")}
        </button>
      }
    >
      {!coupon && (
        <label className="field">
          <span>{t("couponCode")}</span>
          <input
            className="input num"
            dir="ltr"
            style={{ textTransform: "uppercase" }}
            value={code}
            maxLength={32}
            autoCapitalize="characters"
            onChange={(e) => setCode(e.target.value.replace(/[^A-Za-z0-9_-]/g, ""))}
            placeholder="RAMADAN10"
          />
        </label>
      )}
      <div className="pref-row">
        <span>{t("discountType")}</span>
        <Seg
          label={t("discountType")}
          value={type}
          onChange={setType}
          options={[
            { value: "percent", label: t("dt_percent") },
            { value: "amount", label: t("dt_amount") },
          ]}
        />
      </div>
      <div className="form-grid">
        {type === "percent" ? (
          <>
            <label className="field">
              <span>{t("percentOff")}</span>
              <input className="input num" inputMode="decimal" value={percent} onChange={(e) => setPercent(digits(e.target.value))} />
            </label>
            <label className="field">
              <span>{t("maxDiscount")}</span>
              <input className="input num" inputMode="decimal" value={maxDiscount} onChange={(e) => setMaxDiscount(digits(e.target.value))} placeholder="—" />
            </label>
          </>
        ) : (
          <label className="field">
            <span>{t("amountOff")}</span>
            <input className="input num" inputMode="decimal" value={amount} onChange={(e) => setAmount(digits(e.target.value))} placeholder="1.00" />
          </label>
        )}
        <label className="field">
          <span>{t("minOrder")}</span>
          <input className="input num" inputMode="decimal" value={minOrder} onChange={(e) => setMinOrder(digits(e.target.value))} placeholder="0.00" />
        </label>
        <label className="field">
          <span>{t("onlyProduct")}</span>
          <select className="select" value={productId} onChange={(e) => setProductId(e.target.value)}>
            <option value="">{t("anyProduct")}</option>
            {products.map((p) => (
              <option key={p.id} value={p.id}>
                {pick(lang, p.name_ar, p.name_en)}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>{t("maxUses")}</span>
          <input className="input num" inputMode="numeric" value={maxUses} onChange={(e) => setMaxUses(toLatinDigits(e.target.value).replace(/\D/g, ""))} placeholder={t("unlimited")} />
        </label>
        <label className="field">
          <span>{t("perUser")}</span>
          <input className="input num" inputMode="numeric" value={perUser} onChange={(e) => setPerUser(toLatinDigits(e.target.value).replace(/\D/g, ""))} />
        </label>
        <label className="field">
          <span>{t("startsAt")}</span>
          <input className="input num" type="date" value={starts} onChange={(e) => setStarts(e.target.value)} />
        </label>
        <label className="field">
          <span>{t("expiresAt")}</span>
          <input className="input num" type="date" value={ends} onChange={(e) => setEnds(e.target.value)} aria-invalid={!datesOk || undefined} />
        </label>
      </div>
      <label className="field">
        <span>{t("note")}</span>
        <input className="input" value={note} maxLength={200} onChange={(e) => setNote(e.target.value)} />
      </label>
      <div className="pref-row">
        <span>{t("enabled")}</span>
        <Switch checked={active} onChange={setActive} label={t("enabled")} />
      </div>
      {coupon && (
        <p className="small muted num">
          {t("uses")}: {coupon.uses} / {coupon.maxUses ?? "∞"} · {t("discountGiven")}: {usd(coupon.discountTotalCents)}
        </p>
      )}
    </Sheet>
  );
}
