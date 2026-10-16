import { describe, expect, it } from "vitest";
import { cleanSupplierName, DEFAULT_NAME_WORDS, parseNameWords } from "../src/names";
import { BATSTORE_NAMES } from "./names-batstore.fixture";

const clean = (s: string) => {
  const c = cleanSupplierName(s);
  return [c.productEn, c.packageEn, c.warrantyEn];
};

describe("cleanSupplierName", () => {
  it("reads warranties, durations and details", () => {
    expect(clean("Capcut pro 1M 1600 Ai credit FW")).toEqual(["CapCut Pro", "1 month · 1,600 AI credits", "Full warranty"]);
    expect(clean("ChatGPT - GPT K12 Edu  (W5H)")).toEqual(["ChatGPT K12 Edu", "Standard", "5-hour warranty"]);
    expect(clean("Chatgpt plus 1M (Google pay)Gmail NW")).toEqual(["ChatGPT Plus", "1 month · Ready Gmail account · Google Pay", "No warranty"]);
    expect(clean("Zoom - Zoom Pro 1M (W25D) Ready Account")).toEqual(["Zoom Pro", "1 month · Ready account", "25-day warranty"]);
    expect(clean("Claude 100$ Api 30 D warranty")).toEqual(["Claude API", "$100 credit", "30-day warranty"]);
    expect(clean("API 100M Token Claude 3Day")).toEqual(["Claude API", "3 days · 100M tokens", null]);
    expect(clean("HMA - Key HMA Android/PC 20-30D")[1]).toBe("20–30 days");
    expect(clean("Miro EDU — Lifetime Access(100 members)")).toEqual(["Miro Edu", "Lifetime · 100 members", null]);
    expect(clean("SPEECHIFY PREMIUM – 12 MONTHS")).toEqual(["Speechify Premium", "12 months", null]);
    expect(clean("bolt.new PRO 12m NW")).toEqual(["Bolt.new Pro", "12 months", "No warranty"]);
    expect(clean("pangram")).toEqual(["Pangram", "Standard", null]);
    expect(clean("Spotify premium account1M FW")).toEqual(["Spotify Premium", "1 month · Ready account", "Full warranty"]);
    expect(clean("Autodesk Admin 3000 invite")).toEqual(["Autodesk Admin", "3,000 invitations", null]);
    expect(clean("Gemini Pro 18Months (link)")).toEqual(["Gemini Pro", "18 months · Activation link", null]);
    expect(clean("Gmails Accounts")).toEqual(["Ready Gmail Account", "Standard", null]);
    expect(cleanSupplierName("Gmails Accounts").productAr).toBe("حساب Gmail جاهز");
  });

  it("writes Arabic with the right plural", () => {
    const a = (s: string) => {
      const c = cleanSupplierName(s);
      return [c.packageAr, c.warrantyAr];
    };
    expect(a("Scribd - Scribd Premium 1M (FW)")).toEqual(["شهر واحد", "ضمان كامل"]);
    expect(a("Figma Pro Edu 2yrs")).toEqual(["سنتان", null]);
    expect(a("Notion Business 3 Months")).toEqual(["3 أشهر", null]);
    expect(a("Arize Pro 12m")).toEqual(["12 شهراً", null]);
    expect(a("Grok - Super Grok 9 Days (W3D)")).toEqual(["9 أيام", "ضمان 3 أيام"]);
    expect(a("Elevenlabs - Free 10k Credits (W24H)")).toEqual(["10K رصيد", "ضمان 24 ساعة"]);
  });

  it("puts a supplier's packages of one product together", () => {
    const keys = (names: string[]) => new Set(names.map((n) => cleanSupplierName(n).key));
    expect(keys(["Zoom - 12 months (100 people)", "Zoom - 3 months (100 people)", "Zoom - 6 months (100 people)"]).size).toBe(1);
    expect(keys(["500$ API CLaude - 30 days", "API Claude 50M Token (2Day)", "Claude 100$ Api 30 D warranty"]).size).toBe(1);
    expect(keys(["Wordwall - Wordwall pro 12m (FW)", "Wordwall - Wordwall pro 1m (FW)"]).size).toBe(1);
    // Every BatStore name gives a product and a package.
    for (const n of BATSTORE_NAMES) {
      const c = cleanSupplierName(n);
      expect(c.productEn.length, n).toBeGreaterThan(1);
      expect(c.packageEn.length, n).toBeGreaterThan(1);
    }
  });

  it("uses the owner's words", () => {
    const words = [...DEFAULT_NAME_WORDS, { from: "k12 edu", en: "Education (K12)", ar: "تعليمي (K12)", part: "package" as const }];
    const c = cleanSupplierName("ChatGPT - GPT K12 Edu  (W5H)", words);
    expect([c.productEn, c.packageEn, c.packageAr]).toEqual(["ChatGPT", "Education (K12)", "تعليمي (K12)"]);
  });

  it("checks a word list from the admin", () => {
    expect(parseNameWords([{ from: " Gmail ", en: "Ready Gmail account", ar: "", part: "package" }])).toEqual([
      { from: "gmail", en: "Ready Gmail account", ar: "Ready Gmail account", part: "package" },
    ]);
    expect(parseNameWords([{ from: "", en: "x", ar: "x", part: "package" }])).toBeNull();
    expect(parseNameWords([{ from: "x", en: "x", ar: "x", part: "other" }])).toBeNull();
    expect(parseNameWords("nope")).toBeNull();
  });
});
