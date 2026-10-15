/**
 * Forgiving search for Arabic and English product names.
 * Treats أ/إ/آ/ا, ة/ه, ى/ي, ؤ/و, ئ/ي as the same letter, drops diacritics and
 * tatweel, converts Arabic-Indic digits, and lower-cases Latin.
 */

const DIACRITICS = /[ؐ-ًؚ-ٰٟۖ-ۭـ]/g;

export function normalizeSearch(input: string): string {
  return input
    .normalize("NFKC")
    .replace(DIACRITICS, "")
    .replace(/[أإآٱ]/g, "ا")
    .replace(/ة/g, "ه")
    .replace(/ى/g, "ي")
    .replace(/ؤ/g, "و")
    .replace(/ئ/g, "ي")
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0))
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

/** True when every word of the query appears in the haystack (after normalising both). */
export function matchesQuery(haystack: string, query: string): boolean {
  const h = normalizeSearch(haystack);
  const words = normalizeSearch(query).split(" ").filter(Boolean);
  return words.every((w) => h.includes(w));
}
