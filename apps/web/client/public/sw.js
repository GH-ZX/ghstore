/*
 * The store's service worker: only browser notifications (Profile → notifications
 * on this device). It does not cache or change any page.
 */

/** A page of this store only ("/orders/…"); anything that resolves to another site becomes "/". */
function sameOrigin(u) {
  if (typeof u !== "string" || u === "") return "/";
  try {
    const url = new URL(u, self.location.origin);
    return url.origin === self.location.origin ? url.pathname + url.search + url.hash : "/";
  } catch {
    return "/";
  }
}

self.addEventListener("push", (event) => {
  let d = {};
  try {
    d = event.data ? event.data.json() : {};
  } catch {
    d = { body: event.data ? event.data.text() : "" };
  }
  event.waitUntil(
    self.registration.showNotification(d.title || "GH Store", {
      body: d.body || "",
      icon: "/icon-192.png",
      badge: "/icon-192.png",
      lang: d.lang,
      dir: d.dir,
      data: { url: sameOrigin(d.url) },
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = new URL(sameOrigin(event.notification.data?.url), self.location.origin).href;
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((list) => {
      for (const c of list) {
        if (new URL(c.url).origin === self.location.origin && "focus" in c) {
          return c.focus().then(() => ("navigate" in c ? c.navigate(url) : undefined));
        }
      }
      return self.clients.openWindow(url);
    }),
  );
});
