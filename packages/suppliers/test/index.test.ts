import { describe, expect, it } from "vitest";
import { supplierFactories } from "../src/index";
import { deliveryValues, secretEquals, usdToCents, uuid4From, uuid5 } from "../src/shared";
import { fakeFetch } from "./fake-fetch";

describe("supplier registry", () => {
  it("builds every adapter under its stable id without touching the network", () => {
    const { fetch, calls } = fakeFetch({});
    const ids = Object.entries(supplierFactories).map(([key, factory]) => {
      const adapter = factory({ fetch, config: {} });
      expect(adapter.id).toBe(key);
      return key;
    });
    expect(ids.sort()).toEqual(["batstore", "fivesim", "g2bulk", "maxstore", "prodseller"]);
    expect(calls).toHaveLength(0);
  });
});

describe("shared helpers", () => {
  it("converts supplier prices to integer cents", () => {
    expect(usdToCents(0.84)).toBe(84);
    expect(usdToCents(1.005)).toBe(101);
    expect(usdToCents("18.105")).toBe(1811);
    expect(usdToCents("0.123456789")).toBe(12);
    expect(usdToCents(-1)).toBeNull();
    expect(usdToCents("abc")).toBeNull();
    expect(usdToCents(null)).toBeNull();
  });

  it("matches Python's uuid5 and derives stable v4-shaped uuids", async () => {
    expect(await uuid5("python.org")).toBe("886313e1-3b8a-5372-9b90-0c9aee199e5d");
    expect(await uuid4From("a")).toBe(await uuid4From("a"));
    expect(await uuid4From("a")).not.toBe(await uuid4From("b"));
  });

  it("compares secrets without accepting empty ones", async () => {
    expect(await secretEquals("s3cret", "s3cret")).toBe(true);
    expect(await secretEquals("s3cret", "s3cre")).toBe(false);
    expect(await secretEquals("", "")).toBe(false);
  });

  it("flattens delivered goods", () => {
    expect(deliveryValues(["A", { code: "B" }, { account_data: { email: "e", password: "p" } }, null, " "])).toEqual([
      "A", "B", '{"email":"e","password":"p"}',
    ]);
  });
});
