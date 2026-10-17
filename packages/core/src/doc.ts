/**
 * The store's page text (Admin → SEO & pages): plain text with a few marks, read
 * the same way by the server (HTML for search engines) and the web app (React).
 *   "## Title" / "### Title"  headings      "- item"  list items
 *   **bold**                  [text](https://… or mailto:…)  links
 * A blank line starts a new paragraph.
 */
export type DocBlock = { type: "h2" | "h3" | "p"; text: string } | { type: "ul"; items: string[] };

export type DocSpan = { type: "text"; text: string } | { type: "bold"; text: string } | { type: "link"; text: string; href: string };

export function parseDoc(source: string): DocBlock[] {
  const blocks: DocBlock[] = [];
  let para: string[] = [];
  let list: string[] | null = null;
  const flushPara = () => {
    if (para.length) blocks.push({ type: "p", text: para.join(" ") });
    para = [];
  };
  const flushList = () => {
    if (list) blocks.push({ type: "ul", items: list });
    list = null;
  };
  for (const raw of source.replace(/\r\n?/g, "\n").split("\n")) {
    const line = raw.trim();
    if (!line) {
      flushPara();
      flushList();
      continue;
    }
    const heading = /^(#{1,3})\s+(.+)$/.exec(line);
    if (heading) {
      flushPara();
      flushList();
      blocks.push({ type: heading[1]!.length === 3 ? "h3" : "h2", text: heading[2]!.trim() });
      continue;
    }
    const item = /^[-*•]\s+(.+)$/.exec(line);
    if (item) {
      flushPara();
      (list ??= []).push(item[1]!.trim());
      continue;
    }
    flushList();
    para.push(line);
  }
  flushPara();
  flushList();
  return blocks;
}

const INLINE = /\*\*(.+?)\*\*|\[([^\]\n]+)\]\(((?:https:\/\/|mailto:)[^\s()<>"]+)\)/g;

export function parseSpans(text: string): DocSpan[] {
  const out: DocSpan[] = [];
  let at = 0;
  for (const m of text.matchAll(INLINE)) {
    if (m.index! > at) out.push({ type: "text", text: text.slice(at, m.index) });
    if (m[1] !== undefined) out.push({ type: "bold", text: m[1] });
    else out.push({ type: "link", text: m[2]!, href: m[3]! });
    at = m.index! + m[0].length;
  }
  if (at < text.length) out.push({ type: "text", text: text.slice(at) });
  return out;
}

/** The text without its marks (for a search result's description). */
export function docPlainText(source: string): string {
  return parseDoc(source)
    .map((b) => (b.type === "ul" ? b.items.join(" · ") : b.text))
    .join(" ")
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/\[([^\]\n]+)\]\([^)]*\)/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}
