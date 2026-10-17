/**
 * A picture for a product or a slide: paste a link, upload a file, or save a
 * copy of a linked picture into the store's own storage (server: images.ts).
 * Shown as a square (icons) or wide (covers, slides) preview.
 */
import { useRef, useState } from "react";
import { api, apiUpload, ApiFail } from "../lib/api";
import { errorText } from "../lib/i18n";
import { toast, useT } from "../lib/state";
import { Spinner } from "../ui/kit";

const STORED = "/storage/v1/object/public/store-images/";

/** Longest side kept for an uploaded picture: enough for the widest slide on a sharp screen. */
const MAX_SIDE = { square: 800, wide: 2000 } as const;

/**
 * Shrink a picture in the browser before it is stored (free, unlike resizing on
 * every view): at most MAX_SIDE, re-encoded as WebP. The original is kept when
 * it is already small, animated (GIF), or the result would not be smaller.
 */
async function shrink(f: File, shape: "square" | "wide"): Promise<File> {
  if (!/^image\/(png|jpeg|webp)$/.test(f.type) || typeof createImageBitmap !== "function") return f;
  try {
    const bmp = await createImageBitmap(f);
    const scale = Math.min(1, MAX_SIDE[shape] / Math.max(bmp.width, bmp.height));
    if (scale === 1 && f.size < 300 * 1024) return f;
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(bmp.width * scale);
    canvas.height = Math.round(bmp.height * scale);
    canvas.getContext("2d")?.drawImage(bmp, 0, 0, canvas.width, canvas.height);
    bmp.close();
    const blob = await new Promise<Blob | null>((ok) => canvas.toBlob(ok, "image/webp", 0.82));
    if (!blob || blob.type !== "image/webp" || blob.size >= f.size) return f;
    return new File([blob], f.name.replace(/\.\w+$/, "") + ".webp", { type: "image/webp" });
  } catch {
    return f;
  }
}

export function ImageField({ label, hint, value, onChange, shape }: { label: string; hint?: string; value: string; onChange: (url: string) => void; shape: "square" | "wide" }) {
  const { t, lang } = useT();
  const file = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const url = value.trim();
  const ok = !url || /^https:\/\/\S{4,}$/.test(url);
  const stored = url.includes(STORED);

  function fail(e: unknown) {
    const f = e instanceof ApiFail ? e : new ApiFail("internal", 0);
    toast(f.field === "storage" ? t("imgNoStorage") : f.field === "size" ? t("imgTooBig") : f.field === "type" ? t("imgBadType") : errorText(lang, f.code), true);
  }

  async function upload(f: File | undefined) {
    if (!f) return;
    setBusy(true);
    try {
      const r = await apiUpload<{ url: string }>("/api/admin/images", await shrink(f, shape));
      onChange(r.url);
      toast(t("imgSaved"));
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
      if (file.current) file.current.value = "";
    }
  }

  async function copy() {
    setBusy(true);
    try {
      const r = await api<{ url: string }>("/api/admin/images", { body: { url } });
      onChange(r.url);
      toast(t("imgSaved"));
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="field image-field">
      <span>{label}</span>
      <div className="image-field__row">
        <span className={`image-field__preview image-field__preview--${shape}`} aria-hidden="true">
          {url && ok ? <img src={url} alt="" referrerPolicy="no-referrer" /> : null}
        </span>
        <div className="stack-sm" style={{ flex: 1, minWidth: 0 }}>
          <input className="input" dir="ltr" value={value} onChange={(e) => onChange(e.target.value)} placeholder="https://…" aria-label={label} aria-invalid={!ok || undefined} />
          <div className="wrap">
            <button type="button" className="btn btn--xs btn--soft press" disabled={busy} onClick={() => file.current?.click()}>
              {busy ? <Spinner small /> : t("imgUpload")}
            </button>
            {url && ok && !stored && (
              <button type="button" className="btn btn--xs btn--ghost press" disabled={busy} onClick={copy}>
                {t("imgCopy")}
              </button>
            )}
            {stored && <span className="badge badge--good">{t("imgStored")}</span>}
            {url && (
              <button type="button" className="btn btn--xs btn--ghost press" disabled={busy} onClick={() => onChange("")}>
                {t("imgRemove")}
              </button>
            )}
          </div>
        </div>
      </div>
      <input ref={file} type="file" accept="image/png,image/jpeg,image/webp,image/gif,image/avif" hidden onChange={(e) => void upload(e.target.files?.[0])} />
      {hint && <span className="hint">{hint}</span>}
    </div>
  );
}
