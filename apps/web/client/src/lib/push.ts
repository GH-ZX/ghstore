/**
 * Browser notifications on this device (Profile): the service worker (/sw.js)
 * shows them; the server sends them for the customer's messages (packages/api
 * push.ts). Not in the Telegram Mini App (Telegram notifies there). On iPhone
 * they work once the store is added to the Home Screen.
 */
import { api } from "./api";

export type PushState = "unsupported" | "blocked" | "off" | "on";

export function pushSupported(): boolean {
  return typeof window !== "undefined" && "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
}

/** iPhone/iPad Safari outside the Home Screen: push needs the store added there first. */
export function needsHomeScreen(): boolean {
  const ios = /iPad|iPhone|iPod/.test(navigator.userAgent);
  const standalone = window.matchMedia?.("(display-mode: standalone)").matches || (navigator as unknown as { standalone?: boolean }).standalone === true;
  return ios && !standalone && !pushSupported();
}

async function registration(): Promise<ServiceWorkerRegistration> {
  return (await navigator.serviceWorker.getRegistration("/")) ?? navigator.serviceWorker.register("/sw.js", { scope: "/" });
}

export async function pushState(): Promise<PushState> {
  if (!pushSupported()) return "unsupported";
  if (Notification.permission === "denied") return "blocked";
  const reg = await navigator.serviceWorker.getRegistration("/");
  const sub = reg ? await reg.pushManager.getSubscription() : null;
  return sub && Notification.permission === "granted" ? "on" : "off";
}

function keyBytes(b64url: string): Uint8Array<ArrayBuffer> {
  const pad = "=".repeat((4 - (b64url.length % 4)) % 4);
  const raw = atob((b64url + pad).replace(/-/g, "+").replace(/_/g, "/"));
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

/** Ask permission, subscribe this browser and tell the store. */
export async function enablePush(): Promise<PushState> {
  if (!pushSupported()) return "unsupported";
  const permission = await Notification.requestPermission();
  if (permission !== "granted") return permission === "denied" ? "blocked" : "off";
  const reg = await registration();
  await navigator.serviceWorker.ready;
  const { publicKey } = await api<{ publicKey: string }>("/api/push/key");
  const sub = (await reg.pushManager.getSubscription()) ?? (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(publicKey) }));
  const json = sub.toJSON() as { endpoint?: string; keys?: { p256dh?: string; auth?: string } };
  await api("/api/push/subscribe", { body: { endpoint: json.endpoint, keys: json.keys } });
  return "on";
}

/**
 * Signing out: drop this browser's subscription, so a shared device stops
 * getting the previous customer's notifications. Call it while the session is
 * still valid (the store forgets the endpoint first). Never throws, and gives
 * up after a few seconds so sign-out is never held up.
 */
export async function forgetPush(): Promise<void> {
  if (!pushSupported()) return;
  const work = (async () => {
    const reg = await navigator.serviceWorker.getRegistration("/");
    const sub = reg ? await reg.pushManager.getSubscription() : null;
    if (!sub) return;
    await api("/api/push/unsubscribe", { body: { endpoint: sub.endpoint } }).catch(() => undefined);
    await sub.unsubscribe().catch(() => false);
  })().catch(() => undefined);
  await Promise.race([work, new Promise<void>((r) => setTimeout(r, 3000))]);
}

export async function disablePush(): Promise<PushState> {
  const reg = await navigator.serviceWorker.getRegistration("/");
  const sub = reg ? await reg.pushManager.getSubscription() : null;
  if (sub) {
    await api("/api/push/unsubscribe", { body: { endpoint: sub.endpoint } }).catch(() => undefined);
    await sub.unsubscribe();
  }
  return "off";
}
