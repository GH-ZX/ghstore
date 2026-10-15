/** Helpers shared by admin screens. */
import { useState } from "react";
import { api, ApiFail } from "../lib/api";
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
