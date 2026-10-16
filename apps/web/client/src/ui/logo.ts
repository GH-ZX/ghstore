/**
 * The logo mark, drawn once here: the header, admin and sign-in (Logo in
 * kit.tsx) and the opening splash (built into index.html by build.mjs) all use
 * it. To rebrand, change these paths (viewBox 0 0 240 120).
 */
export const LOGO = {
  viewBox: "0 0 240 120",
  /** Drawn as lines, in order (the splash draws them in). */
  strokes: [
    { d: "M92 22H40L22 40V80L40 98H80V62H54", color: "var(--accent-text)", width: 24 },
    { d: "M122 10V110M182 10V110M122 60H182", color: "var(--ink)", width: 24 },
  ],
  /** The final dot. */
  fill: { d: "M212 86H224L230 92V104L224 110H212L206 104V92Z", color: "var(--dot)" },
} as const;

/**
 * The splash shown while the app starts (until the user and their balance are
 * known), as HTML for index.html: it appears before any script has loaded.
 */
export function splashHtml(): string {
  const strokes = LOGO.strokes
    .map((s, i) => `<path class="splash__stroke splash__stroke--${i + 1}" pathLength="1" d="${s.d}" fill="none" stroke="${s.color}" stroke-width="${s.width}"/>`)
    .join("");
  return (
    `<div id="splash" class="splash" aria-hidden="true"><div class="splash__mark">` +
    `<svg class="splash__logo" viewBox="${LOGO.viewBox}" width="144" height="72">${strokes}` +
    `<path class="splash__dot" d="${LOGO.fill.d}" fill="${LOGO.fill.color}"/></svg></div>` +
    `<div class="splash__bar"><span></span></div></div>`
  );
}
