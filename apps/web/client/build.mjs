/**
 * Builds the web app (website, Mini App, admin) into apps/web/dist as static
 * files: one hashed JS bundle, one hashed CSS file, index.html, icons, a web
 * manifest and Cloudflare's _headers. Cloudflare serves these for free; only
 * /api and /telegram run the Worker.
 *
 *   node client/build.mjs            production build
 *   node client/build.mjs --dev      unminified, with source maps
 */
import { build } from "esbuild";
import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..", "..");
const out = join(here, "..", "dist");
const dev = process.argv.includes("--dev");

const hash = (buf) => createHash("sha256").update(buf).digest("hex").slice(0, 10);

await rm(out, { recursive: true, force: true });
await mkdir(join(out, "assets"), { recursive: true });

// Code splitting keeps the admin screens out of what customers download.
const result = await build({
  entryPoints: { app: join(here, "src", "main.tsx") },
  bundle: true,
  splitting: true,
  outdir: join(out, "assets"),
  entryNames: "[name]-[hash]",
  chunkNames: "chunk-[hash]",
  metafile: true,
  format: "esm",
  target: ["es2022", "safari16", "chrome111"],
  jsx: "automatic",
  minify: !dev,
  sourcemap: dev ? "inline" : false,
  legalComments: "none",
  tsconfig: join(here, "tsconfig.json"),
  define: { "process.env.NODE_ENV": JSON.stringify(dev ? "development" : "production") },
  logLevel: "warning",
});
const outputs = Object.entries(result.metafile.outputs);
const entry = outputs.find(([, o]) => o.entryPoint?.endsWith("main.tsx"));
if (!entry) throw new Error("no entry output");
const jsName = entry[0].split("/").pop();
const js = { length: outputs.reduce((n, [, o]) => n + o.bytes, 0) };

const css = await readFile(join(here, "src", "styles.css"));
const cssName = `app-${hash(css)}.css`;
await writeFile(join(out, "assets", cssName), css);

// Icons from /brand (replace those files to rebrand a copy of the store).
const brand = join(root, "brand");
for (const f of ["favicon.svg", "icon-192.png", "icon-512.png", "apple-touch-icon.png", "app-icon.svg"]) {
  await copyFile(join(brand, f), join(out, f));
}

// Load store.config.ts and the theme code (TypeScript) by bundling them for Node.
const meta = await build({
  stdin: {
    contents: `export { store } from ${JSON.stringify(join(root, "store.config.ts"))}; export { themeCss, googleFontsHref } from ${JSON.stringify(join(root, "packages", "ui", "src", "index.ts"))};`,
    resolveDir: root,
    loader: "ts",
  },
  bundle: true,
  write: false,
  format: "esm",
  platform: "node",
  logLevel: "warning",
});
const { store, themeCss, googleFontsHref } = await import(`data:text/javascript;base64,${Buffer.from(meta.outputFiles[0].contents).toString("base64")}`);

const attr = (v) => String(v).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
const html = (await readFile(join(here, "index.html"), "utf8"))
  .replaceAll("%NAME%", attr(store.name))
  .replaceAll("%URL%", attr(store.url))
  .replaceAll("%DESC%", attr(store.defaultLocale === "en" ? store.tagline.en : store.tagline.ar))
  .replaceAll("%LANG%", store.defaultLocale === "en" ? "en" : "ar")
  .replaceAll("%DIR%", store.defaultLocale === "en" ? "ltr" : "rtl")
  .replace("%THEME%", themeCss(store.theme.preset, store.theme.mode))
  .replace("%FONTS%", googleFontsHref(store.theme.preset))
  .replace("%CSS%", `/assets/${cssName}`)
  .replace("%JS%", `/assets/${jsName}`);
await writeFile(join(out, "index.html"), html);

await writeFile(
  join(out, "manifest.webmanifest"),
  JSON.stringify(
    {
      name: store.name,
      short_name: store.name,
      start_url: "/",
      display: "standalone",
      background_color: "#0B0A12",
      theme_color: "#0B0A12",
      icons: [
        { src: "/icon-192.png", sizes: "192x192", type: "image/png" },
        { src: "/icon-512.png", sizes: "512x512", type: "image/png" },
      ],
    },
    null,
    2,
  ),
);

await copyFile(join(here, "public", "_headers"), join(out, "_headers"));
// robots.txt and sitemap.xml are answered by the Worker (they need the live product list).

console.log(`built ${jsName} (${(js.length / 1024).toFixed(0)} KB), ${cssName} (${(css.length / 1024).toFixed(0)} KB)`);
