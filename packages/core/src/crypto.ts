/**
 * Encryption at rest for delivered codes, account credentials and supplier API keys.
 * AES-256-GCM with a random 96-bit IV. DATA_KEY is 32 random bytes, base64.
 * Output: "v1.<iv>.<ciphertext>" (base64url). The key never leaves the Worker secrets.
 */
import { fromBase64, fromBase64Url, fromUtf8, toBase64Url, utf8 } from "./encoding";

const keyCache = new Map<string, Promise<CryptoKey>>();

function importKey(dataKeyB64: string): Promise<CryptoKey> {
  let k = keyCache.get(dataKeyB64);
  if (!k) {
    const raw = fromBase64(dataKeyB64);
    if (raw.length !== 32) throw new Error("DATA_KEY must be 32 bytes, base64-encoded");
    k = crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
    keyCache.set(dataKeyB64, k);
  }
  return k;
}

export async function encryptText(plain: string, dataKeyB64: string): Promise<string> {
  const key = await importKey(dataKeyB64);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, utf8(plain));
  return `v1.${toBase64Url(iv)}.${toBase64Url(ct)}`;
}

export async function decryptText(sealed: string, dataKeyB64: string): Promise<string> {
  const [v, ivB64, ctB64] = sealed.split(".");
  if (v !== "v1" || !ivB64 || !ctB64) throw new Error("not an encrypted value");
  const key = await importKey(dataKeyB64);
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: fromBase64Url(ivB64) }, key, fromBase64Url(ctB64));
  return fromUtf8(new Uint8Array(pt));
}

/** Show only the end of a secret: "GH-7Q4K-M2XD" -> "••••M2XD". */
export function maskTail(value: string, visible = 4): string {
  if (value.length <= visible) return "•".repeat(value.length);
  return "••••" + value.slice(-visible);
}
