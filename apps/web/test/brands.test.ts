import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { BRANDS } from "@store/core";

// simple-icons is a build-time dependency of the web app only.
const require = createRequire(join(import.meta.dirname, "..", "package.json"));
const data = require("simple-icons/icons.json") as { slug: string; title: string; hex: string }[];

describe("the store's brand marks", () => {
  it("are real simple-icons marks, in their own colours", () => {
    const bySlug = new Map(data.map((i) => [i.slug, i]));
    for (const b of BRANDS) {
      const icon = bySlug.get(b.slug);
      expect(icon, b.slug).toBeDefined();
      expect(b.hex, b.slug).toBe(icon!.hex.toUpperCase());
      expect(b.title, b.slug).toBe(icon!.title);
      expect(existsSync(require.resolve(`simple-icons/icons/${b.slug}.svg`)), b.slug).toBe(true);
    }
  });
});
