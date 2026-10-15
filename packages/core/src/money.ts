/**
 * Money is always an integer number of US cents. Never use floats for amounts.
 */

export type Cents = number;

/** Parse "12.34", "12.3", "12" or a number of dollars into cents. Throws on garbage. */
export function toCents(value: string | number): Cents {
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new RangeError(`not a finite amount: ${value}`);
    return Math.round(value * 100);
  }
  const s = value.trim();
  if (!/^-?\d+(\.\d{1,8})?$/.test(s)) throw new RangeError(`not an amount: "${value}"`);
  const negative = s.startsWith("-");
  const [whole = "0", frac = ""] = s.replace("-", "").split(".");
  const fracPadded = (frac + "000").slice(0, 3);
  // Round half up on the third decimal.
  let cents = Number(whole) * 100 + Number(fracPadded.slice(0, 2));
  if (Number(fracPadded[2]) >= 5) cents += 1;
  return negative ? -cents : cents;
}

/** Cents to a plain decimal string with two places: 1234 -> "12.34". */
export function centsToDecimal(cents: Cents): string {
  assertCents(cents);
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, "0")}`;
}

/** Cents to a display string in US dollars: 1234 -> "$12.34". */
export function formatUsd(cents: Cents): string {
  const d = centsToDecimal(Math.abs(cents));
  return `${cents < 0 ? "−" : ""}$${d}`;
}

/** Cents with an explicit sign, for ledgers: +$10.00 / −$4.90. */
export function formatSignedUsd(cents: Cents): string {
  return `${cents < 0 ? "−" : "+"}$${centsToDecimal(Math.abs(cents))}`;
}

/**
 * Convert to Syrian pounds for display. `sypPerUsd` is the number of NEW pounds
 * per dollar (the 2026 redenomination removed two zeros). Rounds to whole pounds.
 */
export function formatSyp(cents: Cents, sypPerUsd: number, locale: "ar" | "en" = "ar"): string {
  if (!(sypPerUsd > 0)) throw new RangeError("sypPerUsd must be positive");
  const pounds = Math.round((cents / 100) * sypPerUsd);
  const n = new Intl.NumberFormat(locale === "ar" ? "ar-SY" : "en-US", { maximumFractionDigits: 0 }).format(pounds);
  return locale === "ar" ? `${n} ل.س` : `SYP ${n}`;
}

export function assertCents(value: unknown): asserts value is Cents {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new TypeError(`expected integer cents, got ${String(value)}`);
  }
}
