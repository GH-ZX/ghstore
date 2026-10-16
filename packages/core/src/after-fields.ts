/**
 * What a customer gives after paying for a product delivered by hand (or one
 * a supplier activates on the customer's account): an email, a password, an
 * account ID, a username, a cookies/session token, or the owner's own question.
 * The buy sheet lists them before paying; the order asks for them after.
 */

export const AFTER_TYPES = ["email", "password", "id", "username", "token", "custom"] as const;
export type AfterType = (typeof AFTER_TYPES)[number];

export interface AfterField {
  key: string;
  type: AfterType;
  labelEn: string;
  labelAr: string;
  /** How to find it (where to copy the cookies from...). */
  hintEn?: string;
  hintAr?: string;
  required: boolean;
}

/** Default labels, used when the owner leaves one empty. */
export const AFTER_LABELS: Record<AfterType, { en: string; ar: string }> = {
  email: { en: "Email", ar: "البريد الإلكتروني" },
  password: { en: "Password", ar: "كلمة المرور" },
  id: { en: "Account ID", ar: "معرّف الحساب" },
  username: { en: "Username", ar: "اسم المستخدم" },
  token: { en: "Cookies / session token", ar: "الكوكيز / رمز الجلسة" },
  custom: { en: "Details", ar: "التفاصيل" },
};

/** The longest answer per type (a cookies export is long). */
export const AFTER_MAX: Record<AfterType, number> = { email: 254, password: 200, id: 200, username: 200, token: 16_000, custom: 2_000 };
/** Answers that are secrets: never shown back in full, never sent in a message. */
export const AFTER_SECRET = new Set<AfterType>(["password", "token"]);
/** All the answers of one order together, at most. */
export const ANSWERS_MAX_CHARS = 40_000;

const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,}$/;

function text(v: unknown, max: number): string | undefined {
  if (v === undefined || v === null || v === "") return undefined;
  if (typeof v !== "string") return undefined;
  const t = v.replace(/\s+/g, " ").trim();
  return t ? t.slice(0, max) : undefined;
}

/** Check and tidy the owner's list (at most 8). Answers null when it is not one. */
export function parseAfterFields(v: unknown): AfterField[] | null {
  if (!Array.isArray(v) || v.length > 8) return null;
  const used = new Map<string, number>();
  const out: AfterField[] = [];
  for (const raw of v) {
    if (!raw || typeof raw !== "object") return null;
    const r = raw as Record<string, unknown>;
    const type = AFTER_TYPES.find((t) => t === r.type);
    if (!type) return null;
    // Keys are ours ("email", "custom_2"), never typed: they name the answers.
    const n = (used.get(type) ?? 0) + 1;
    used.set(type, n);
    const field: AfterField = {
      key: n === 1 ? type : `${type}_${n}`,
      type,
      labelEn: text(r.labelEn, 60) ?? AFTER_LABELS[type].en,
      labelAr: text(r.labelAr, 60) ?? AFTER_LABELS[type].ar,
      required: r.required !== false,
    };
    const hintEn = text(r.hintEn, 300);
    const hintAr = text(r.hintAr, 300);
    if (hintEn) field.hintEn = hintEn;
    if (hintAr) field.hintAr = hintAr;
    out.push(field);
  }
  return out;
}

/**
 * Check a customer's answers. `previous` keeps a secret the customer left
 * empty when correcting their details.
 */
export function checkAnswers(
  fields: AfterField[],
  input: Record<string, unknown>,
  previous: Record<string, string> = {},
): { ok: true; values: Record<string, string> } | { ok: false; field: string } {
  const values: Record<string, string> = Object.create(null) as Record<string, string>;
  let total = 0;
  for (const f of fields) {
    const raw = Object.hasOwn(input, f.key) ? input[f.key] : undefined;
    // Tokens keep their line breaks and spaces; everything else is one tidy line.
    let v = typeof raw === "string" ? (f.type === "token" || f.type === "custom" ? raw.trim() : raw.replace(/\s+/g, " ").trim()) : "";
    if (!v && AFTER_SECRET.has(f.type) && previous[f.key]) v = previous[f.key]!;
    if (!v) {
      if (f.required) return { ok: false, field: f.key };
      continue;
    }
    if (v.length > AFTER_MAX[f.type]) return { ok: false, field: f.key };
    if (f.type === "email" && !EMAIL.test(v)) return { ok: false, field: f.key };
    values[f.key] = v;
    total += v.length;
  }
  if (total > ANSWERS_MAX_CHARS) return { ok: false, field: fields[fields.length - 1]?.key ?? "answers" };
  return { ok: true, values };
}
