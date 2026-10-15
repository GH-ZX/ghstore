/** Money, dates and small display helpers. Amounts are integer US cents. */
import { formatSignedUsd, formatSyp, formatUsd } from "@store/core";
import type { Lang } from "./types";

export function usd(cents: number): string {
  return formatUsd(cents);
}

export function signedUsd(cents: number): string {
  return formatSignedUsd(cents);
}

/** "≈ 1,560 ل.س" when the owner set a rate, else null. */
export function syp(cents: number, rate: number | null | undefined, lang: Lang): string | null {
  if (!rate || rate <= 0) return null;
  return formatSyp(cents, rate, lang);
}

export function dateTime(iso: string, lang: Lang): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return new Intl.DateTimeFormat(lang === "ar" ? "ar-SY-u-nu-latn" : "en-GB", {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  }).format(d);
}

/** Two letters for a product tile when it has no image: "PUBG Mobile UC" → "PU". */
export function monogram(name: string): string {
  const words = name.replace(/[^\p{L}\p{N}\s]/gu, " ").trim().split(/\s+/).filter(Boolean);
  if (!words.length) return "•";
  const latin = words.find((w) => /^[A-Za-z0-9]/.test(w));
  const w = latin ?? words[0]!;
  return w.slice(0, w.length <= 3 && w === w.toUpperCase() ? 3 : 2).toUpperCase();
}

/** Arabic-Indic and Persian digits (common on Arabic keyboards) to 0-9; Arabic decimal sign to ".". */
export function toLatinDigits(input: string): string {
  return input
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0))
    .replace(/٫/g, ".")
    .replace(/٬/g, ",");
}

export function dollarsToCents(input: string): number | null {
  const s = toLatinDigits(input).trim().replace(",", ".");
  if (!/^\d{1,6}(\.\d{1,2})?$/.test(s)) return null;
  const [w, f = ""] = s.split(".");
  return Number(w) * 100 + Number((f + "00").slice(0, 2));
}

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    ta.remove();
    return ok;
  }
}
