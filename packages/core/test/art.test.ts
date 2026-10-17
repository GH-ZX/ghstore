import { describe, expect, it } from "vitest";
import { artName, brandFor, brandFromIconUrl, brandInk, BRANDS } from "../src/art";

const slug = (name: string) => brandFor(name)?.slug ?? null;

describe("brand marks for products without a picture", () => {
  it("finds the brand a name starts with", () => {
    expect(slug("Duolingo Super")).toBe("duolingo");
    expect(slug("Warp Build")).toBe("warp");
    expect(slug("Telegram Premium")).toBe("telegram");
    expect(slug("ElevenLabs Creator")).toBe("elevenlabs");
    expect(slug("Eleven Labs")).toBe("elevenlabs");
    expect(slug("PUBG Mobile UC")).toBe("pubg");
    expect(slug("Chess.com Diamond")).toBe("chessdotcom");
    expect(slug("Twitter Blue")).toBe("x");
  });

  it("prefers the longest name", () => {
    expect(slug("Google Gemini Advanced")).toBe("googlegemini");
    expect(slug("YouTube Music Premium")).toBe("youtubemusic");
    expect(slug("YouTube Premium")).toBe("youtube");
    expect(slug("Apple Music")).toBe("applemusic");
    expect(slug("GitHub Copilot Pro")).toBe("githubcopilot");
  });

  it("matches whole words at the start only, and never brands it does not carry", () => {
    expect(slug("Xbox Game Pass")).toBeNull();
    expect(slug("Steamworks")).toBeNull();
    expect(slug("Buy Netflix")).toBeNull();
    for (const n of ["Canva Pro", "CapCut Pro", "Amazon Prime Video", "Microsoft Office 365 Plus", "Adobe Express", "Bolt.new Pro", "ChatGPT Plus", "Scribd Premium"]) {
      expect(slug(n)).toBeNull();
    }
  });

  it("reads simple-icons' own addresses", () => {
    expect(brandFromIconUrl("https://cdn.jsdelivr.net/npm/simple-icons@13.21.0/icons/whatsapp.svg")?.slug).toBe("whatsapp");
    expect(brandFromIconUrl("https://cdn.jsdelivr.net/npm/simple-icons/icons/telegram.svg")?.slug).toBe("telegram");
    expect(brandFromIconUrl("https://cdn.simpleicons.org/duolingo")?.slug).toBe("duolingo");
    // OpenAI's mark is no longer in simple-icons: not carried
    expect(brandFromIconUrl("https://cdn.jsdelivr.net/npm/simple-icons/icons/openai.svg")).toBeNull();
    expect(brandFromIconUrl("https://abcd.supabase.co/storage/v1/object/public/b/telegram.svg")).toBeNull();
  });

  it("draws the mark in white, black only on very light brand colours", () => {
    expect(brandInk("FFFC00")).toBe("#000000");
    expect(brandInk("53FC19")).toBe("#000000");
    expect(brandInk("58CC02")).toBe("#FFFFFF");
    expect(brandInk("26A5E4")).toBe("#FFFFFF");
    expect(brandInk("E50914")).toBe("#FFFFFF");
    expect(brandInk("000000")).toBe("#FFFFFF");
  });

  it("has each brand once", () => {
    expect(new Set(BRANDS.map((b) => b.slug)).size).toBe(BRANDS.length);
    for (const b of BRANDS) expect(b.hex).toMatch(/^[0-9A-F]{6}$/);
  });
});

describe("the name tile", () => {
  it("takes the plan words off the end", () => {
    expect(artName("Duolingo Super")).toEqual({ title: "Duolingo", plan: "Super" });
    expect(artName("Canva Pro Team Invite")).toEqual({ title: "Canva", plan: "Pro Team Invite" });
    expect(artName("Magic Patterns Starter")).toEqual({ title: "Magic Patterns", plan: "Starter" });
    expect(artName("Microsoft Office 365 Plus")).toEqual({ title: "Microsoft Office 365", plan: "Plus" });
  });

  it("keeps names without plan words, and names that are only one", () => {
    expect(artName("Lovable")).toEqual({ title: "Lovable", plan: "" });
    expect(artName("Amazon Prime Video")).toEqual({ title: "Amazon Prime Video", plan: "" });
    expect(artName("Premium")).toEqual({ title: "Premium", plan: "" });
    expect(artName("  Outlook / Hotmail Email ")).toEqual({ title: "Outlook / Hotmail Email", plan: "" });
    expect(artName("نتفليكس بريميوم")).toEqual({ title: "نتفليكس بريميوم", plan: "" });
  });
});
