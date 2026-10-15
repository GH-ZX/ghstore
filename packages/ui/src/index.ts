/**
 * GH Store design tokens: four theme presets, each with a light and a dark mode.
 * The owner picks the preset in the admin (setting `theme.preset`); visitors get
 * light or dark from their device. Components use the CSS variables only.
 */

export type ThemePreset = "calm" | "energetic" | "minimal" | "warm";
export type ThemeMode = "light" | "dark";

export interface ThemeColors {
  bg: string;
  surface: string;
  surface2: string;
  line: string;
  ink: string;
  muted: string;
  accent: string;
  accentInk: string;
  accentText: string;
  tile: string;
  dot: string;
}

export interface Theme {
  label: { en: string; ar: string };
  font: string;
  headingFont: string;
  /** Google Fonts families to load (Arabic + Latin in one family where possible). */
  fonts: string[];
  light: ThemeColors;
  dark: ThemeColors;
}

export const THEMES: Record<ThemePreset, Theme> = {
  calm: {
    label: { en: "Calm", ar: "هادئ" },
    font: "'Readex Pro', system-ui, sans-serif",
    headingFont: "'Readex Pro', system-ui, sans-serif",
    fonts: ["Readex+Pro:wght@400;500;600;700"],
    light: { bg: "#F3F5F9", surface: "#FFFFFF", surface2: "#EEF2F7", line: "#E1E6EE", ink: "#0E1421", muted: "#5B6678", accent: "#2F6BEA", accentInk: "#FFFFFF", accentText: "#2457C5", tile: "#E5EDFD", dot: "#2F6BEA" },
    dark: { bg: "#08090D", surface: "#13151B", surface2: "#1B1E26", line: "#252935", ink: "#F2F4F8", muted: "#8D94A3", accent: "#2F6BEA", accentInk: "#FFFFFF", accentText: "#6EA2FF", tile: "#172238", dot: "#6EA2FF" },
  },
  energetic: {
    label: { en: "Energetic", ar: "حيوي" },
    font: "'Rubik', system-ui, sans-serif",
    headingFont: "'Rubik', system-ui, sans-serif",
    fonts: ["Rubik:wght@400;500;600;700;800"],
    light: { bg: "#FFFFFF", surface: "#F8F6FF", surface2: "#F1ECFF", line: "#E6DFFB", ink: "#160F2E", muted: "#5E5677", accent: "#6D28D9", accentInk: "#FFFFFF", accentText: "#6D28D9", tile: "#EEE6FF", dot: "#6D28D9" },
    dark: { bg: "#0B0A12", surface: "#15131F", surface2: "#1E1B2C", line: "#2A2639", ink: "#F4F2FA", muted: "#A39DB8", accent: "#7C3AED", accentInk: "#FFFFFF", accentText: "#B69CFF", tile: "#241B3F", dot: "#B69CFF" },
  },
  minimal: {
    label: { en: "Minimal", ar: "بسيط" },
    font: "'Alexandria', system-ui, sans-serif",
    headingFont: "'Alexandria', system-ui, sans-serif",
    fonts: ["Alexandria:wght@400;500;600;700"],
    light: { bg: "#FFFFFF", surface: "#F6F6F5", surface2: "#EDEDEB", line: "#E4E4E1", ink: "#111111", muted: "#6B6B6B", accent: "#111111", accentInk: "#FFFFFF", accentText: "#111111", tile: "#EAEAE8", dot: "#111111" },
    dark: { bg: "#0A0A0A", surface: "#161616", surface2: "#1F1F1F", line: "#2A2A2A", ink: "#F5F5F5", muted: "#9A9A9A", accent: "#F5F5F5", accentInk: "#0A0A0A", accentText: "#F5F5F5", tile: "#232323", dot: "#F5F5F5" },
  },
  warm: {
    label: { en: "Warm", ar: "دافئ" },
    font: "'Tajawal', system-ui, sans-serif",
    headingFont: "'El Messiri', serif",
    fonts: ["Tajawal:wght@400;500;700;800", "El+Messiri:wght@500;600;700"],
    light: { bg: "#FAF6EF", surface: "#FFFFFF", surface2: "#F4EDE2", line: "#EADFCF", ink: "#2A1E14", muted: "#7A6A58", accent: "#1F6B52", accentInk: "#FFFFFF", accentText: "#1F6B52", tile: "#E3EFE8", dot: "#C98A1B" },
    dark: { bg: "#14100C", surface: "#1F1A14", surface2: "#29221A", line: "#382D22", ink: "#F6EEE2", muted: "#B3A492", accent: "#E3A63F", accentInk: "#1E150A", accentText: "#E9B65C", tile: "#3A2C17", dot: "#E3A63F" },
  },
};

/** Status colours do not change with the preset: they always mean the same thing. */
export const SEMANTIC = {
  light: { good: "#15803D", bad: "#C0362C", warn: "#B45309" },
  dark: { good: "#4ADE80", bad: "#F87171", warn: "#FBBF24" },
} as const;

export const MONO_FONT = "'JetBrains Mono', ui-monospace, monospace";

export function isPreset(v: unknown): v is ThemePreset {
  return typeof v === "string" && v in THEMES;
}

function vars(c: ThemeColors, mode: ThemeMode, t: Theme): string {
  const s = SEMANTIC[mode];
  return [
    `--bg:${c.bg}`, `--surface:${c.surface}`, `--surface-2:${c.surface2}`, `--line:${c.line}`,
    `--ink:${c.ink}`, `--muted:${c.muted}`, `--accent:${c.accent}`, `--accent-ink:${c.accentInk}`,
    `--accent-text:${c.accentText}`, `--tile:${c.tile}`, `--dot:${c.dot}`,
    `--good:${s.good}`, `--bad:${s.bad}`, `--warn:${s.warn}`,
    `--font:${t.font}`, `--font-heading:${t.headingFont}`, `--font-mono:${MONO_FONT}`,
    `color-scheme:${mode}`,
  ].join(";");
}

/**
 * CSS for a preset. "system" follows the device; "light"/"dark" force a mode.
 * A `data-mode` attribute on <html> overrides it (the visitor's own toggle).
 */
export function themeCss(preset: ThemePreset, defaultMode: "system" | ThemeMode = "system"): string {
  const t = THEMES[preset];
  const light = vars(t.light, "light", t);
  const dark = vars(t.dark, "dark", t);
  const base = defaultMode === "dark" ? dark : light;
  const auto = defaultMode === "system" ? `@media (prefers-color-scheme: dark){:root:not([data-mode="light"]){${dark}}}` : "";
  return `:root{${base}}${auto}:root[data-mode="light"]{${light}}:root[data-mode="dark"]{${dark}}`;
}

export function googleFontsHref(preset: ThemePreset): string {
  const fams = [...THEMES[preset].fonts, "JetBrains+Mono:wght@400;500;700"];
  return `https://fonts.googleapis.com/css2?${fams.map((f) => `family=${f}`).join("&")}&display=swap`;
}

/** Logo D ("GH."): the G and the dot take the accent, the H takes the ink. */
export function logoSvg(opts: { height?: number; g?: string; h?: string; dot?: string; title?: string } = {}): string {
  const height = opts.height ?? 24;
  const width = Math.round((height * 240) / 120);
  const g = opts.g ?? "var(--accent-text)";
  const hh = opts.h ?? "var(--ink)";
  const dot = opts.dot ?? "var(--dot)";
  return `<svg width="${width}" height="${height}" viewBox="0 0 240 120" role="img" aria-label="${opts.title ?? "GH."}"><path d="M92 22H40L22 40V80L40 98H80V62H54" fill="none" stroke="${g}" stroke-width="24"/><path d="M122 10V110M182 10V110M122 60H182" fill="none" stroke="${hh}" stroke-width="24"/><path d="M212 86H224L230 92V104L224 110H212L206 104V92Z" fill="${dot}"/></svg>`;
}

/** Hexagon app icon / favicon. */
export function iconSvg(opts: { size?: number; bg?: string; g?: string; h?: string; dot?: string; simple?: boolean } = {}): string {
  const size = opts.size ?? 96;
  const bg = opts.bg ?? "#0B0A12";
  const g = opts.g ?? "#B69CFF";
  const h = opts.h ?? "#FFFFFF";
  const dot = opts.dot ?? g;
  const inner = opts.simple
    ? `<g transform="translate(26 26) scale(0.42)"><path d="M92 22H40L22 40V80L40 98H80V62H54" fill="none" stroke="${g}" stroke-width="24"/></g>`
    : `<g transform="translate(19 34) scale(0.24)"><path d="M92 22H40L22 40V80L40 98H80V62H54" fill="none" stroke="${g}" stroke-width="24"/><path d="M122 10V110M182 10V110M122 60H182" fill="none" stroke="${h}" stroke-width="24"/><path d="M212 86H224L230 92V104L224 110H212L206 104V92Z" fill="${dot}"/></g>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 96 96"><path d="M48 6L86 28V68L48 90L10 68V28Z" fill="${bg}" stroke="${bg}" stroke-width="8" stroke-linejoin="round"/>${inner}</svg>`;
}
