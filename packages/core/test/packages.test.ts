import { describe, expect, it } from "vitest";
import { orderPackages, sortIsTextOrder } from "../src/packages";

const pkg = (nameEn: string, priceCents: number, sort = 0, extra: Record<string, unknown> = {}) => ({ nameEn, priceCents, sort, ...extra });
const names = (l: { nameEn: string }[]) => l.map((p) => p.nameEn);

describe("package order", () => {
  it("counts like people do: cheaper first, then 12 before 100", () => {
    const list = [pkg("100 UC", 100), pkg("1000 UC", 900), pkg("12 UC", 12), pkg("10 UC", 10), pkg("120 UC", 100)];
    expect(names(orderPackages(list))).toEqual(["10 UC", "12 UC", "100 UC", "120 UC", "1000 UC"]);
  });

  it("ignores sort numbers that only repeat the names in text order (the old store's import)", () => {
    const text = ["10 MTN", "100 MTN", "1000 MTN", "12 MTN", "15 MTN"];
    const price: Record<string, number> = { "10 MTN": 10, "100 MTN": 91, "1000 MTN": 911, "12 MTN": 11, "15 MTN": 13 };
    const list = text.map((n, i) => pkg(n, price[n]!, i + 1));
    expect(sortIsTextOrder(list)).toBe(true);
    expect(names(orderPackages(list))).toEqual(["10 MTN", "12 MTN", "15 MTN", "100 MTN", "1000 MTN"]);
  });

  it("keeps the owner's own order, pins and sold-out packages last", () => {
    const list = [pkg("10 UC", 10, 3), pkg("Weekly pass", 500, 1), pkg("60 UC", 60, 2), pkg("325 UC", 300, 4, { pinned: true }), pkg("660 UC", 600, 0, { soldOut: true })];
    expect(names(orderPackages(list))).toEqual(["325 UC", "Weekly pass", "60 UC", "10 UC", "660 UC"]);
  });

  it("puts the numbers that get their SMS most often first", () => {
    const list = [pkg("USA", 30, 0, { successPct: 40 }), pkg("UK", 20, 0, { successPct: 90 }), pkg("Spain", 10, 0, { successPct: null })];
    expect(names(orderPackages(list, { bySuccess: true }))).toEqual(["UK", "USA", "Spain"]);
  });
});
