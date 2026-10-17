import { describe, expect, it } from "vitest";
import { canResize, pictureSrcSet, pictureUrl } from "../src/images";

const OBJ = "https://abcd.supabase.co/storage/v1/object/public/store-images/x.png";

describe("smaller pictures", () => {
  it("serves the store's own pictures through Supabase's resizer", () => {
    expect(pictureUrl(OBJ, { width: 400 })).toBe("https://abcd.supabase.co/storage/v1/render/image/public/store-images/x.png?width=400&quality=75");
    expect(pictureUrl(OBJ, { width: 720, height: 783 })).toBe(
      "https://abcd.supabase.co/storage/v1/render/image/public/store-images/x.png?width=720&height=783&resize=cover&quality=75",
    );
  });

  it("leaves other pictures alone unless Cloudflare resizing is on", () => {
    const steam = "https://cdn.example/hero.jpg";
    expect(pictureUrl(steam, { width: 400 })).toBe(steam);
    expect(pictureUrl(steam, { width: 400 }, { cloudflare: true })).toBe("/cdn-cgi/image/width=400,fit=scale-down,quality=80,format=auto/https://cdn.example/hero.jpg");
    // SVG logos and objects with a query string are never rewritten
    expect(pictureUrl("https://abcd.supabase.co/storage/v1/object/public/b/logo.svg", { width: 100 })).toContain("/object/public/");
    expect(pictureUrl(`${OBJ}?v=2`, { width: 100 })).toBe(`${OBJ}?v=2`);
    expect(canResize(steam)).toBe(false);
  });

  it("builds srcsets cropped to a box", () => {
    expect(pictureSrcSet(OBJ, [480, 960], { ratio: 2 })).toBe(
      "https://abcd.supabase.co/storage/v1/render/image/public/store-images/x.png?width=480&height=240&resize=cover&quality=75 480w, " +
        "https://abcd.supabase.co/storage/v1/render/image/public/store-images/x.png?width=960&height=480&resize=cover&quality=75 960w",
    );
    expect(pictureSrcSet("https://cdn.example/a.jpg", [480])).toBe("");
  });
});
