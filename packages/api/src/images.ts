/**
 * Store pictures (product icons and covers, showcase slides) kept in the store's
 * own Supabase Storage bucket, so a picture never disappears because another
 * site moved it.
 *
 * - POST /api/admin/images: an image file as the body (Content-Type image/*), or
 *   { url } to save a copy of a picture from the web. Answers { url }, the
 *   picture's public address, to put in a product or slide.
 * - The `store_images` job copies pictures still linked from elsewhere (product
 *   icons and covers, slide pictures) into the bucket a few at a time, and
 *   points them at the copy. A picture that cannot be fetched is tried again a
 *   day later; the link keeps working meanwhile.
 *
 * Needs SUPABASE_URL (a Worker var) and the project's secret key, set by the
 * owner in Admin → Settings → Keys → Storage (or as a Worker secret). Without
 * it, links work as before and uploads answer "not_allowed".
 * Files are named by their content's hash: the same picture is stored once.
 */
import { requireStaff } from "./auth";
import type { ApiEnv, Ctx, Services } from "./context";
import { ApiError, json, readJson } from "./http";
import { effectiveEnv } from "./keys";

export const BUCKET = "store-images";
const MAX_BYTES = 4 * 1024 * 1024;
const TYPES: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif", "image/avif": "avif" };

interface Storage {
  base: string;
  key: string;
}

function storageOf(env: ApiEnv): Storage | null {
  const base = typeof env.SUPABASE_URL === "string" ? env.SUPABASE_URL.replace(/\/+$/, "") : "";
  const key = typeof env.SUPABASE_SECRET_KEY === "string" ? env.SUPABASE_SECRET_KEY.trim() : "";
  return base.startsWith("https://") && key ? { base, key } : null;
}

/** Where a stored picture is served from. */
export function publicBase(env: ApiEnv): string | null {
  const base = typeof env.SUPABASE_URL === "string" ? env.SUPABASE_URL.replace(/\/+$/, "") : "";
  return base ? `${base}/storage/v1/object/public/${BUCKET}/` : null;
}

async function sha256Hex(bytes: ArrayBuffer): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Store bytes in the bucket; answers the public URL. */
export async function storeImage(svc: Services, env: ApiEnv, bytes: ArrayBuffer, type: string): Promise<string> {
  const ext = TYPES[type];
  if (!ext) throw new ApiError("invalid_input", "type");
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_BYTES) throw new ApiError("invalid_input", "size");
  const storage = storageOf(env);
  if (!storage) throw new ApiError("not_allowed", "storage");
  const path = `${(await sha256Hex(bytes)).slice(0, 32)}.${ext}`;
  const headers: Record<string, string> = { apikey: storage.key, "content-type": type, "x-upsert": "true", "cache-control": "31536000" };
  // Legacy service_role keys are JWTs and also go as a bearer token; new sb_secret_ keys go as apikey only.
  if (storage.key.startsWith("eyJ")) headers.authorization = `Bearer ${storage.key}`;
  const res = await svc.fetch(`${storage.base}/storage/v1/object/${BUCKET}/${path}`, { method: "POST", headers, body: bytes });
  if (!res.ok) {
    const text = (await res.text().catch(() => "")).slice(0, 200);
    console.error("storage upload failed", res.status, text);
    throw new ApiError("bad_state", "storage");
  }
  return `${storage.base}/storage/v1/object/public/${BUCKET}/${path}`;
}

/**
 * Read a body up to MAX_BYTES, counting as it arrives: a missing or wrong
 * Content-Length cannot make us hold more than that.
 */
async function readCapped(body: ReadableStream<Uint8Array> | null): Promise<ArrayBuffer> {
  if (!body) return new ArrayBuffer(0);
  const reader = body.getReader();
  const parts: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_BYTES) {
      await reader.cancel().catch(() => undefined);
      throw new ApiError("invalid_input", "size");
    }
    parts.push(value);
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.byteLength;
  }
  return out.buffer;
}

/** A public https address: no IP literals, local names or odd ports. */
function publicUrl(raw: string): URL | null {
  if (!/^https:\/\/[^\s"<>]{4,500}$/.test(raw)) return null;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  const host = u.hostname.toLowerCase();
  if (u.protocol !== "https:" || (u.port && u.port !== "443") || u.username || u.password) return null;
  if (!host.includes(".") || host.startsWith("[") || /^[\d.]+$/.test(host) || /^0x/i.test(host)) return null;
  if (/(^|\.)(localhost|local|internal|lan|home|corp|intranet)$/.test(host)) return null;
  return u;
}

/** Fetch a picture from the web (a public https address, an image, not too big). */
export async function fetchImage(svc: Services, url: string): Promise<{ bytes: ArrayBuffer; type: string }> {
  let at = publicUrl(url);
  if (!at) throw new ApiError("invalid_input", "url");
  let res: Response | null = null;
  // Redirects are followed by hand so every hop is checked like the first.
  for (let hop = 0; hop <= 3; hop++) {
    res = await svc.fetch(at.href, { headers: { accept: "image/*" }, redirect: "manual" });
    if (res.status < 300 || res.status >= 400) break;
    const next = res.headers.get("location");
    await res.body?.cancel().catch(() => undefined);
    at = next ? publicUrl(new URL(next, at).href) : null;
    if (!at || hop === 3) throw new ApiError("invalid_input", "url");
  }
  if (!res || !res.ok) throw new ApiError("invalid_input", "url");
  const type = (res.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
  if (!TYPES[type]) throw new ApiError("invalid_input", "type");
  const len = Number(res.headers.get("content-length") ?? "0");
  if (len > MAX_BYTES) throw new ApiError("invalid_input", "size");
  return { bytes: await readCapped(res.body), type };
}

/** POST /api/admin/images — upload a picture, or save a copy of one from a link. */
export async function uploadImage(ctx: Ctx): Promise<Response> {
  const staff = await requireStaff(ctx, "owner");
  const env = await effectiveEnv(ctx.env, ctx.svc.db);
  if (!storageOf(env)) throw new ApiError("not_allowed", "storage");
  const type = (ctx.req.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
  let picture: { bytes: ArrayBuffer; type: string };
  if (type === "application/json") {
    const body = await readJson(ctx.req);
    picture = await fetchImage(ctx.svc, typeof body.url === "string" ? body.url.trim() : "");
  } else {
    const len = Number(ctx.req.headers.get("content-length") ?? "0");
    if (len > MAX_BYTES) throw new ApiError("invalid_input", "size");
    picture = { bytes: await readCapped(ctx.req.body), type };
  }
  const url = await storeImage(ctx.svc, env, picture.bytes, picture.type);
  await ctx.svc.db.query(
    `insert into app.audit_log (actor_user_id, action, target_type, target_id, data) values ($1, 'image.upload', 'image', $2, '{}'::jsonb)`,
    [staff.id, url.slice(-80)],
  );
  return json({ url }, { status: 201 });
}

/**
 * Scheduled: copy pictures still linked from other sites into the bucket, at
 * most `max` per run (two requests each), and point everything that used the
 * link at the copy. Nothing happens until the storage key is set.
 */
export async function copyLinkedImages(svc: Services, env: ApiEnv, max = 4): Promise<number> {
  const full = await effectiveEnv(env, svc.db);
  const own = publicBase(full);
  if (!storageOf(full) || !own) return 0;
  const links = await svc.db.query<{ url: string }>(
    `select distinct url from (
       select image_url as url from app.products where image_url is not null
       union all select cover_url from app.products where cover_url is not null
       union all select image_url from app.banners where image_url is not null
     ) u
     where url not like $1 || '%'
       and url !~* '\\.svg([?#]|$)' -- SVGs can carry scripts: they stay linked, never stored
       and not exists (select 1 from app.image_copies c where c.source_url = u.url and c.failed_at > now() - interval '1 day')
     limit $2`,
    [own, max],
  );
  let copied = 0;
  for (const { url } of links) {
    if (svc.budget && svc.budget.left() < 4) break;
    try {
      const picture = await fetchImage(svc, url);
      const stored = await storeImage(svc, full, picture.bytes, picture.type);
      await svc.db.query(
        `insert into app.image_copies (source_url, stored_url, failed_at, error) values ($1, $2, null, null)
         on conflict (source_url) do update set stored_url = excluded.stored_url, failed_at = null, error = null`,
        [url, stored],
      );
      await svc.db.query(`update app.products set image_url = $2 where image_url = $1`, [url, stored]);
      await svc.db.query(`update app.products set cover_url = $2 where cover_url = $1`, [url, stored]);
      await svc.db.query(`update app.banners set image_url = $2 where image_url = $1`, [url, stored]);
      copied++;
    } catch (err) {
      const msg = err instanceof ApiError ? `${err.code}${err.field ? `:${err.field}` : ""}` : err instanceof Error ? err.message.slice(0, 200) : "error";
      await svc.db.query(
        `insert into app.image_copies (source_url, failed_at, error) values ($1, now(), $2)
         on conflict (source_url) do update set failed_at = now(), error = excluded.error`,
        [url, msg],
      );
    }
  }
  return copied;
}
