/**
 * A product's unit ("UC", "Diamonds", "شدة"): a package named only by its
 * amount ("60", "1,000", "60+6") is named with it ("60 UC"). Names that say
 * something else ("Weekly Pass", "60 UC Voucher") are left alone.
 */

/** An amount: digits with thousands separators, decimals, "+" bonuses or "×". */
const AMOUNT = /^\s*[\d٠-٩]+(?:[.,][\d٠-٩]+)*(?:\s*[+×x]\s*[\d٠-٩]+(?:[.,][\d٠-٩]+)*)*\s*$/u;

/**
 * The package's name with `unit`. A name that already ends with the previous
 * unit (`was`) is renamed, so changing "Diamonds" to "ألماس" keeps working;
 * an empty unit takes a previous one off.
 */
export function withUnit(name: string, unit: string, was = ""): string {
  const u = unit.trim();
  const old = was.trim();
  let amount = name.trim();
  if (old && amount.endsWith(` ${old}`) && AMOUNT.test(amount.slice(0, -old.length - 1))) {
    amount = amount.slice(0, -old.length - 1).trim();
  }
  if (!AMOUNT.test(amount)) return name;
  return (u ? `${amount} ${u}` : amount).slice(0, 120);
}
