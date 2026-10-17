/**
 * The order of a product's packages in the store and on its public page:
 *
 * 1. sold-out packages last (customers can ask to be told when they are back);
 * 2. the owner's pinned packages first;
 * 3. virtual numbers: the countries whose numbers get their SMS most often first;
 * 4. the owner's sort numbers (Admin → Catalogue → package → Sort);
 * 5. then the natural order: cheaper first, then by the amount in the name
 *    ("10 UC, 12 UC, 100 UC", never "10, 100, 1000, 12").
 *
 * Sort numbers that only spell out the names in plain text order (what the old
 * store's import left: "10, 100, 1000, 12") are not a choice anyone made, so
 * such a product falls back to the natural order.
 */
export interface OrderablePackage {
  nameEn: string;
  nameAr?: string;
  priceCents: number;
  sort: number;
  pinned?: boolean;
  soldOut?: boolean;
  successPct?: number | null;
}

const natural = new Intl.Collator("en", { numeric: true, sensitivity: "base" });
const plainText = new Intl.Collator("en", { sensitivity: "base" });

/** Compare two package names the way people count: "12 UC" before "100 UC". */
export function compareNames(a: string, b: string): number {
  return natural.compare(a, b);
}

/** Do these sort numbers just repeat the names' plain text order (and that differs from counting order)? */
export function sortIsTextOrder(list: readonly OrderablePackage[]): boolean {
  if (list.length < 3 || new Set(list.map((p) => p.sort)).size < 2) return false;
  const bySort = [...list].sort((a, b) => a.sort - b.sort).map((p) => p.nameEn);
  const byText = [...list].sort((a, b) => plainText.compare(a.nameEn, b.nameEn) || (a.nameEn < b.nameEn ? -1 : a.nameEn > b.nameEn ? 1 : 0)).map((p) => p.nameEn);
  const byCount = [...list].sort((a, b) => compareNames(a.nameEn, b.nameEn)).map((p) => p.nameEn);
  const same = (x: string[], y: string[]) => x.every((v, i) => v === y[i]);
  return same(bySort, byText) && !same(byText, byCount);
}

/** The packages in the store's order (see above). */
export function orderPackages<T extends OrderablePackage>(list: readonly T[], opts: { bySuccess?: boolean } = {}): T[] {
  const useSort = !sortIsTextOrder(list);
  return [...list].sort(
    (a, b) =>
      Number(!!a.soldOut) - Number(!!b.soldOut) ||
      Number(!!b.pinned) - Number(!!a.pinned) ||
      (opts.bySuccess ? (b.successPct ?? -1) - (a.successPct ?? -1) : 0) ||
      (useSort ? a.sort - b.sort : 0) ||
      a.priceCents - b.priceCents ||
      compareNames(a.nameEn, b.nameEn),
  );
}
