import { describe, expect, it } from "vitest";
import { canResize, pictureSrcSet, pictureUrl } from "../src/images";

const OBJ = "https://abcd.supabase.co/storage/v1/object/public/store-images/x.png";

describe("smaller pictures", () => {
  it("never uses Supabase's (billed) resizer; Cloudflare resizes the store's own pictures when on", () => {
    expect(pictureUrl(OBJ, { width: 400 })).toBe(OBJ);
    expect(pictureUrl(OBJ, { width: 720, height: 783 }, { cloudflare: true })).toBe(`/cdn-cgi/image/width=720,height=783,fit=cover,quality=80,format=auto/${OBJ}`);
  });

  it("leaves other pictures alone unless Cloudflare resizing is on", () => {
    const steam = "https://cdn.example/hero.jpg";
    expect(pictureUrl(steam, { width: 400 })).toBe(steam);
    expect(pictureUrl(steam, { width: 400 }, { cloudflare: true })).toBe("/cdn-cgi/image/width=400,fit=scale-down,quality=80,format=auto/https://cdn.example/hero.jpg");
    // SVG logos are never rewritten
    expect(pictureUrl("https://abcd.supabase.co/storage/v1/object/public/b/logo.svg", { width: 100 }, { cloudflare: true })).toContain("/object/public/");
    expect(canResize(steam)).toBe(false);
  });

  it("builds srcsets cropped to a box", () => {
    expect(pictureSrcSet(OBJ, [480, 960], { ratio: 2, cloudflare: true })).toBe(
      `/cdn-cgi/image/width=480,height=240,fit=cover,quality=80,format=auto/${OBJ} 480w, ` +
        `/cdn-cgi/image/width=960,height=480,fit=cover,quality=80,format=auto/${OBJ} 960w`,
    );
    expect(pictureSrcSet(OBJ, [480])).toBe("");
    expect(pictureSrcSet("https://cdn.example/a.jpg", [480])).toBe("");
  });
});
