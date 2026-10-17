/**
 * Builds the web app (website, Mini App, admin) into apps/web/dist as static
 * files: one hashed JS bundle, one hashed CSS file, index.html, icons, a web
 * manifest and Cloudflare's _headers. Cloudflare serves these for free; only
 * /api and /telegram run the Worker.
 *
 *   node client/build.mjs            production build
 *   node client/build.mjs --dev      unminified, with source maps
 */
import { build, transform } from "esbuild";
import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
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
const outputs = result.metafile.outputs;
const entry = Object.entries(outputs).find(([, o]) => o.entryPoint?.endsWith("main.tsx"));
if (!entry) throw new Error("no entry output");
const jsName = entry[0].split("/").pop();
// What the first page really downloads: the entry and the chunks it imports
// statically (and theirs), not the lazily loaded screens.
const firstLoad = new Set();
const walk = (file) => {
  if (firstLoad.has(file)) return;
  firstLoad.add(file);
  for (const imp of outputs[file]?.imports ?? []) if (imp.kind === "import-statement" && !imp.external) walk(imp.path);
};
walk(entry[0]);
const staticChunks = [...firstLoad].filter((f) => f !== entry[0]).map((f) => f.split("/").pop());
const firstLoadBytes = [...firstLoad].reduce((n, f) => n + (outputs[f]?.bytes ?? 0), 0);
const allBytes = Object.values(outputs).reduce((n, o) => n + o.bytes, 0);

// The stylesheet, minified by esbuild (unminified with --dev).
const cssOut = await transform(await readFile(join(here, "src", "styles.css"), "utf8"), {
  loader: "css",
  minify: !dev,
  target: ["safari16", "chrome111"],
  legalComments: "none",
  logLevel: "warning",
});
const css = Buffer.from(cssOut.code);
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
    contents: `export { store } from ${JSON.stringify(join(root, "store.config.ts"))}; export { themeCss, googleFontsHref } from ${JSON.stringify(join(root, "packages", "ui", "src", "index.ts"))}; export { splashHtml } from ${JSON.stringify(join(here, "src", "ui", "logo.ts"))};`,
    resolveDir: root,
    loader: "ts",
  },
  bundle: true,
  write: false,
  format: "esm",
  platform: "node",
  logLevel: "warning",
});
const { store, themeCss, googleFontsHref, splashHtml } = await import(`data:text/javascript;base64,${Buffer.from(meta.outputFiles[0].contents).toString("base64")}`);

const attr = (v) => String(v).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
// Replacer functions keep "$" in names or taglines literal.
const html = (await readFile(join(here, "index.html"), "utf8"))
  .replaceAll("%NAME%", () => attr(store.name))
  .replaceAll("%URL%", () => attr(store.url))
  .replaceAll("%DESC%", () => attr(store.defaultLocale === "en" ? store.tagline.en : store.tagline.ar))
  .replaceAll("%LANG%", () => (store.defaultLocale === "en" ? "en" : "ar"))
  .replaceAll("%DIR%", () => (store.defaultLocale === "en" ? "ltr" : "rtl"))
  .replace("%THEME%", () => themeCss(store.theme.preset, store.theme.mode))
  .replace("%FONTS%", () => googleFontsHref(store.theme.preset))
  .replace("%SPLASH%", () => splashHtml())
  .replace("%CSS%", () => `/assets/${cssName}`)
  .replace("%JS%", () => `/assets/${jsName}`)
  // The entry's static chunks start downloading with it instead of after it is parsed.
  .replace("%PRELOAD%", () => staticChunks.map((c) => `<link rel="modulepreload" href="/assets/${c}">`).join("\n"));
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
// The service worker for browser notifications (lib/push.ts), at the root so it covers every page.
await copyFile(join(here, "public", "sw.js"), join(out, "sw.js"));
// Static pictures: payment providers' logos (pay/, ShamCash) and promo pictures (promo/, the Numbers slide).
for (const dir of ["pay", "promo", "services"]) await cp(join(here, "public", dir), join(out, dir), { recursive: true });

// The deployed version, for the after-deploy check (.github/workflows/after-deploy.yml).
const version = process.env.WORKERS_CI_COMMIT_SHA || process.env.GITHUB_SHA || (() => {
  try {
    return execSync("git rev-parse HEAD", { cwd: root }).toString().trim();
  } catch {
    return "dev";
  }
})();
await writeFile(join(out, "version.txt"), `${version}\n`);

// robots.txt and sitemap.xml are answered by the Worker (they need the live product list).

const kb = (n) => `${(n / 1024).toFixed(0)} KB`;
console.log(
  `built ${jsName}: first load ${kb(firstLoadBytes)} JS (entry + ${staticChunks.length} static chunks), ${kb(allBytes)} JS in all; ${cssName} (${kb(css.length)})`,
);
