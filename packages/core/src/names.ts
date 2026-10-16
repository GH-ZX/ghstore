/**
 * Clean names for suppliers that name each item in shorthand (BatStore,
 * ProdSeller): "Capcut pro 1M 1600 Ai credit FW" becomes the product
 * "CapCut Pro", the package "1 month · 1,600 AI credits" and the warranty
 * "Full warranty", in English and Arabic.
 *
 * What it understands on its own: warranties (FW, NW, W5H, W25D, "30 D
 * warranty"), durations (1M, 12m, 1Yr, 3Day, 20-30D, Lifetime), token and
 * credit amounts (100M Token, 10k Credits, $500), counts (100 people, 6
 * profiles, 10 seats, 10 devices, 3000 invitations) and "Brand - Brand Plan"
 * duplicates. Everything else comes from a word list the owner edits
 * (Admin → Suppliers → Names): words that belong to the package ("Gmail" →
 * "Ready Gmail account") and how product words are written ("chatgpt" →
 * "ChatGPT").
 *
 * Items with the same cleaned product name are packages of one product.
 */

export interface NameWord {
  /** What the supplier writes (any case; a word or a phrase). */
  from: string;
  en: string;
  ar: string;
  /** "package": a detail of the package, taken out of the product name. "product": how the product name writes it. */
  part: "product" | "package";
}

export interface CleanName {
  /** Items with the same key are packages of one product. */
  key: string;
  productEn: string;
  productAr: string;
  packageEn: string;
  packageAr: string;
  warrantyEn: string | null;
  warrantyAr: string | null;
}

export const DEFAULT_NAME_WORDS: NameWord[] = [
  { from: "ready account", en: "Ready account", ar: "حساب جاهز", part: "package" },
  { from: "gmail", en: "Ready Gmail account", ar: "حساب Gmail جاهز", part: "package" },
  { from: "google pay", en: "Google Pay", ar: "عبر Google Pay", part: "package" },
  { from: "activation link", en: "Activation link", ar: "رابط تفعيل", part: "package" },
  { from: "redeem link", en: "Activation link", ar: "رابط تفعيل", part: "package" },
  { from: "invitation", en: "Invite", ar: "دعوة", part: "package" },
  { from: "invite", en: "Invite", ar: "دعوة", part: "package" },
  { from: "individual", en: "Individual", ar: "فردي", part: "package" },
  { from: "private", en: "Private", ar: "خاص", part: "package" },
  { from: "api claude", en: "Claude API", ar: "Claude API", part: "product" },
  { from: "api codex", en: "Codex API", ar: "Codex API", part: "product" },
  { from: "chatgpt", en: "ChatGPT", ar: "ChatGPT", part: "product" },
  { from: "capcut", en: "CapCut", ar: "CapCut", part: "product" },
  { from: "elevenlabs", en: "ElevenLabs", ar: "ElevenLabs", part: "product" },
  { from: "n8n", en: "n8n", ar: "n8n", part: "product" },
  { from: "ilovepdf", en: "iLovePDF", ar: "iLovePDF", part: "product" },
  { from: "youtube", en: "YouTube", ar: "YouTube", part: "product" },
  { from: "nordvpn", en: "NordVPN", ar: "NordVPN", part: "product" },
  { from: "jetbrains", en: "JetBrains", ar: "JetBrains", part: "product" },
  { from: "posthog", en: "PostHog", ar: "PostHog", part: "product" },
  { from: "bolt.new", en: "Bolt.new", ar: "Bolt.new", part: "product" },
  { from: "customer.io", en: "Customer.io", ar: "Customer.io", part: "product" },
  { from: "edu", en: "Edu", ar: "Edu", part: "product" },
  { from: "pro", en: "Pro", ar: "Pro", part: "product" },
  { from: "ai", en: "AI", ar: "AI", part: "product" },
  { from: "api", en: "API", ar: "API", part: "product" },
];

/** Check and tidy a word list from the admin: at most 200 entries. Answers null when it is not one. */
export function parseNameWords(v: unknown): NameWord[] | null {
  if (!Array.isArray(v) || v.length > 200) return null;
  const out: NameWord[] = [];
  for (const w of v) {
    if (!w || typeof w !== "object") return null;
    const r = w as Record<string, unknown>;
    const from = typeof r.from === "string" ? r.from.replace(/\s+/g, " ").trim().toLowerCase() : "";
    const en = typeof r.en === "string" ? r.en.replace(/\s+/g, " ").trim() : "";
    const ar = typeof r.ar === "string" ? r.ar.replace(/\s+/g, " ").trim() : "";
    const part = r.part === "product" ? "product" : r.part === "package" ? "package" : null;
    if (!from || from.length > 60 || en.length > 60 || ar.length > 60 || !part) return null;
    out.push({ from, en, ar: ar || en, part });
  }
  return out;
}

type Unit = "hour" | "day" | "month" | "year";

const AR_UNITS: Record<Unit, [one: string, two: string, few: string, many: string]> = {
  hour: ["ساعة واحدة", "ساعتان", "ساعات", "ساعة"],
  day: ["يوم واحد", "يومان", "أيام", "يوماً"],
  month: ["شهر واحد", "شهران", "أشهر", "شهراً"],
  year: ["سنة واحدة", "سنتان", "سنوات", "سنة"],
};

function enDuration(n: number, unit: Unit): string {
  return `${n} ${unit}${n === 1 ? "" : "s"}`;
}

function arDuration(n: number, unit: Unit): string {
  const [one, two, few, many] = AR_UNITS[unit];
  if (n === 1) return one;
  if (n === 2) return two;
  return `${n} ${n <= 10 ? few : many}`;
}

function unitOf(s: string): Unit | null {
  const u = s.toLowerCase();
  if (/^(h|hr|hrs|hours?)$/.test(u)) return "hour";
  if (/^(d|days?)$/.test(u)) return "day";
  if (/^(m|mo|mos|months?|monthly)$/.test(u)) return "month";
  if (/^(y|yr|yrs|years?)$/.test(u)) return "year";
  return null;
}

/** 1600 → "1,600"; keeps "10K", "100M". */
function amount(s: string): string {
  const d = s.replace(/,/g, "");
  return /^\d{4,}$/.test(d) ? Number(d).toLocaleString("en-US") : s.toUpperCase();
}

function escape(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** A word or phrase, not inside another word. */
function phrase(from: string): RegExp {
  return new RegExp(`(?<![\\p{L}\\p{N}])${escape(from)}(?![\\p{L}\\p{N}])`, "giu");
}

interface Detail {
  en: string;
  ar: string;
}

export function cleanSupplierName(raw: string, words: NameWord[] = DEFAULT_NAME_WORDS): CleanName {
  let s = ` ${raw.normalize("NFKC").replace(/[–—]/g, " - ").replace(/\s+/g, " ").trim()} `;
  let warranty: Detail | null = null;
  let duration: Detail | null = null;
  const details: Detail[] = [];
  const take = (re: RegExp, fn: (m: RegExpExecArray) => void) => {
    s = s.replace(re, (...args) => {
      fn(args.slice(0, -2) as unknown as RegExpExecArray);
      return " ";
    });
  };
  const B = "(?<![\\p{L}\\p{N}$])"; // not inside a word or after "$"
  const E = "(?![\\p{L}\\p{N}])";

  // ── warranty
  take(new RegExp(`\\(?${B}(?:fw|full\\s*warranty)${E}\\)?`, "giu"), () => {
    warranty = { en: "Full warranty", ar: "ضمان كامل" };
  });
  take(new RegExp(`\\(?${B}(?:nw|no\\s*warranty|non[-\\s]?warranty)${E}\\)?`, "giu"), () => {
    warranty = { en: "No warranty", ar: "بدون ضمان" };
  });
  const timed = (n: number, u: string) => {
    const unit = unitOf(u);
    if (unit && n > 0) warranty = { en: `${n}-${unit} warranty`, ar: `ضمان ${arDuration(n, unit)}` };
  };
  take(new RegExp(`\\(?${B}w(\\d{1,3})\\s*([hdmy])${E}\\)?`, "giu"), (m) => timed(Number(m[1]), m[2]!));
  take(new RegExp(`\\(?${B}(\\d{1,3})\\s*(h|hours?|d|days?|m|months?)\\s*warranty${E}\\)?`, "giu"), (m) => timed(Number(m[1]), m[2]!));
  take(new RegExp(`${B}warranty${E}`, "giu"), () => undefined);

  // ── amounts: tokens, credits, money (before durations: "100M" here is not 100 months)
  take(new RegExp(`${B}(\\d+(?:[.,]\\d+)?)\\s*([kmb])\\s*tokens?${E}`, "giu"), (m) => {
    const big = { k: "ألف", m: "مليون", b: "مليار" }[m[2]!.toLowerCase() as "k" | "m" | "b"];
    details.push({ en: `${m[1]}${m[2]!.toUpperCase()} tokens`, ar: `${m[1]} ${big} توكن` });
  });
  take(new RegExp(`${B}(\\d[\\d,]*(?:\\.\\d+)?)\\s*(k)?\\s*(ai\\s*)?credits?${E}`, "giu"), (m) => {
    const n = amount(m[1]!) + (m[2] ? "K" : "");
    details.push({ en: `${n} ${m[3] ? "AI " : ""}credits`, ar: `${n} رصيد${m[3] ? " AI" : ""}` });
  });
  take(/\$\s*(\d[\d,]*)|(?<![\p{L}\p{N}])(\d[\d,]*)\s*\$/gu, (m) => {
    const n = amount(m[1] ?? m[2]!);
    details.push({ en: `$${n} credit`, ar: `رصيد ${n}$` });
  });

  // ── counts
  const count = (re: string, en: string, ar: string) =>
    take(new RegExp(`\\(?${B}(\\d[\\d,]*)\\s*${re}${E}\\)?`, "giu"), (m) => details.push({ en: `${amount(m[1]!)} ${en}`, ar: `${amount(m[1]!)} ${ar}` }));
  count("(?:people|participants|users)", "participants", "مشارك");
  count("members?", "members", "عضو");
  count("profiles?", "profiles", "ملفات");
  count("x?\\s*seats?", "seats", "مقاعد");
  count("devices?", "devices", "أجهزة");
  count("invitations?", "invitations", "دعوة");

  // ── duration: the first is the package's, any other is a detail
  const setDuration = (d: Detail) => {
    if (!duration) duration = d;
    else details.push(d);
  };
  take(new RegExp(`${B}lifetime(?:\\s*access)?${E}`, "giu"), () => setDuration({ en: "Lifetime", ar: "مدى الحياة" }));
  take(new RegExp(`${B}(\\d{1,3})\\s*-\\s*(\\d{1,3})\\s*(d|days?)${E}`, "giu"), (m) => setDuration({ en: `${m[1]}–${m[2]} days`, ar: `${m[1]}–${m[2]} يوماً` }));
  take(new RegExp(`${B}(\\d{1,3})\\s*(months?|mos?|m|years?|yrs?|y|days?|d|hours?|hrs?|h)${E}`, "giu"), (m) => {
    const unit = unitOf(m[2]!);
    const n = Number(m[1]);
    if (unit && n > 0) setDuration({ en: enDuration(n, unit), ar: arDuration(n, unit) });
  });

  // ── the owner's package words ("Gmail" → "Ready Gmail account")
  for (const w of words.filter((w) => w.part === "package")) {
    take(phrase(w.from), () => {
      if (w.en && !details.some((d) => d.en === w.en)) details.push({ en: w.en, ar: w.ar || w.en });
    });
  }

  // ── what is left is the product
  s = s.replace(/\(\s*\)/g, " ").replace(/[()[\]]/g, " ").replace(/\s+/g, " ").trim();
  s = s.replace(/^[-+·,:|/\s]+|[-+·,:|/\s]+$/g, "").replace(/\s*\+\s*/g, " + ").replace(/\s+/g, " ").trim();
  // "Brand - Brand Plan" / "ChatGPT - GPT K12": say the brand once.
  const dash = s.split(/\s+-\s+/);
  if (dash.length >= 2) {
    const a = dash[0]!.trim();
    const b = dash.slice(1).join(" ").trim();
    const al = a.toLowerCase();
    const bl = b.toLowerCase();
    const bFirst = bl.split(" ")[0] ?? "";
    if (!b) s = a;
    else if (phrase(al).test(bl)) s = b;
    else if (bFirst && al.includes(bFirst)) s = `${a} ${b.split(" ").slice(1).join(" ")}`.trim();
    else s = `${a} ${b}`;
  }
  // A word said twice ("HMA Key HMA") once.
  const seen = new Set<string>();
  s = s.split(" ").filter((w) => {
    const k = w.toLowerCase();
    if (seen.has(k) && /\p{L}/u.test(k)) return false;
    seen.add(k);
    return true;
  }).join(" ");

  let en = s;
  let ar = s;
  for (const w of words.filter((w) => w.part === "product" && w.from.includes(" "))) {
    en = en.replace(phrase(w.from), w.en);
    ar = ar.replace(phrase(w.from), w.ar || w.en);
  }
  const single = new Map(words.filter((w) => w.part === "product" && !w.from.includes(" ")).map((w) => [w.from, w]));
  const cased = (text: string, lang: "en" | "ar") =>
    text.split(" ").map((t) => {
      const known = single.get(t.toLowerCase());
      if (known) return lang === "ar" ? known.ar || known.en : known.en;
      if (/^\p{Ll}[\p{Ll}\d.]*$/u.test(t)) return t[0]!.toUpperCase() + t.slice(1);
      if (/^\p{Lu}{5,}$/u.test(t)) return t[0] + t.slice(1).toLowerCase();
      return t;
    }).join(" ");
  en = cased(en, "en").trim();
  ar = cased(ar, "ar").trim();
  if (!en) en = ar = raw.trim().slice(0, 120);

  const parts: Detail[] = [...(duration ? [duration] : []), ...details];
  return {
    key: en.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim().slice(0, 150),
    productEn: en.slice(0, 120),
    productAr: ar.slice(0, 120),
    packageEn: (parts.map((p) => p.en).join(" · ") || "Standard").slice(0, 120),
    packageAr: (parts.map((p) => p.ar).join(" · ") || "الباقة الأساسية").slice(0, 120),
    warrantyEn: (warranty as Detail | null)?.en ?? null,
    warrantyAr: (warranty as Detail | null)?.ar ?? null,
  };
}
