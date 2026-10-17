/** Helpers shared by admin screens. */
import { useState } from "react";
import { api, ApiFail } from "../lib/api";
import { toLatinDigits } from "../lib/format";
import { errorText } from "../lib/i18n";
import { toast, useT } from "../lib/state";

/** Run an admin action with a busy flag and a toast for the result. */
export function useAction() {
  const { t, lang } = useT();
  const [busy, setBusy] = useState(false);
  async function run<T>(path: string, opts: { method?: string; body?: unknown } = {}, ok?: string): Promise<T | null> {
    setBusy(true);
    try {
      const r = await api<T>(path, { method: opts.method ?? "POST", body: opts.body ?? {} });
      toast(ok ?? t("saved"));
      return r;
    } catch (e) {
      const f = e instanceof ApiFail ? e : new ApiFail("internal", 0);
      toast(`${errorText(lang, f.code)}${f.field ? ` (${f.field})` : ""}`, true);
      return null;
    } finally {
      setBusy(false);
    }
  }
  return { busy, run };
}

/** What an owner typed in a number box, as 0-9 and ".": Arabic and Persian digits and the Arabic decimal sign work too. */
export function decimalText(v: string, max = 10): string {
  return toLatinDigits(v).replace(/[^\d.]/g, "").slice(0, max);
}

/** Whole numbers only (hours, counts), Arabic digits included. */
export function intText(v: string, max = 6): string {
  return toLatinDigits(v).replace(/\D/g, "").slice(0, max);
}

/** A dollar amount box ("$" before it), taking Arabic digits as well. */
export function MoneyInput({ value, onChange, max = 10, placeholder, disabled, label }: { value: string; onChange: (v: string) => void; max?: number; placeholder?: string; disabled?: boolean; label?: string }) {
  return (
    <span className="input-wrap">
      <span className="input-wrap__pre muted">$</span>
      <input className="input num" inputMode="decimal" value={value} placeholder={placeholder} disabled={disabled} aria-label={label} onChange={(e) => onChange(decimalText(e.target.value, max))} />
    </span>
  );
}

export function ago(iso: string | null | undefined, lang: "ar" | "en"): string {
  if (!iso) return "—";
  const d = new Date(iso);
  const s = Math.round((Date.now() - d.getTime()) / 1000);
  const rtf = new Intl.RelativeTimeFormat(lang === "ar" ? "ar-u-nu-latn" : "en", { numeric: "auto" });
  if (Math.abs(s) < 60) return rtf.format(-s, "second");
  if (Math.abs(s) < 3600) return rtf.format(-Math.round(s / 60), "minute");
  if (Math.abs(s) < 86400) return rtf.format(-Math.round(s / 3600), "hour");
  return rtf.format(-Math.round(s / 86400), "day");
}

const METHODS = ["sam", "nowpayments", "bep20", "stars"] as const;
export function methodLabel(t: ReturnType<typeof useT>["t"], m: string): string {
  return (METHODS as readonly string[]).includes(m) ? t(`m_${m as (typeof METHODS)[number]}`) : m;
}
