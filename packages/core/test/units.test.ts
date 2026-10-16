import { describe, expect, it } from "vitest";
import { withUnit } from "../src/units";

describe("withUnit", () => {
  it("names a package given by its amount", () => {
    expect(withUnit("60", "UC")).toBe("60 UC");
    expect(withUnit("1,000", "Diamonds")).toBe("1,000 Diamonds");
    expect(withUnit("60+6", "UC")).toBe("60+6 UC");
    expect(withUnit("٦٠", "شدة")).toBe("٦٠ شدة");
  });

  it("leaves names that say something else alone", () => {
    expect(withUnit("Weekly Pass", "UC")).toBe("Weekly Pass");
    expect(withUnit("60 UC Voucher", "UC")).toBe("60 UC Voucher");
  });

  it("swaps or removes a previous unit", () => {
    expect(withUnit("55 Diamonds", "ألماسة", "Diamonds")).toBe("55 ألماسة");
    expect(withUnit("55 Diamonds", "", "Diamonds")).toBe("55");
    expect(withUnit("55 Gems", "Diamonds", "Diamonds")).toBe("55 Gems");
  });
});
