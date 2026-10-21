/// <reference lib="webworker" />
import { createHandlerBoundToURL, precacheAndRoute } from "workbox-precaching";
import { NavigationRoute, registerRoute } from "workbox-routing";

declare const self: ServiceWorkerGlobalScope & {
  __WB_MANIFEST: Array<string | { url: string; revision: string | null }>;
};

precacheAndRoute(self.__WB_MANIFEST);
self.addEventListener("install", (event) => { event.waitUntil(self.skipWaiting()); });
self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});
registerRoute(new NavigationRoute(createHandlerBoundToURL("/index.html")));

self.addEventListener("push", (event) => {
  const pushEvent = event as PushEvent;
  pushEvent.waitUntil((async () => {
    const data = (() => {
      try { return pushEvent.data?.json() as { id?: string; title?: string; body?: string; route?: string } | undefined; }
      catch { return undefined; }
    })();
    const route = ["/comandas", "/pedidos", "/mesas"].includes(data?.route ?? "") ? data!.route! : "/";
    const title = data?.title || "Restaurante";
    await self.registration.showNotification(title, {
      body: data?.body ?? "Hay una actualización operativa.",
      icon: "/icons/icon-192.png",
      badge: "/icons/icon-192.png",
      tag: data?.id,
      data: { route },
    });
  })());
});

self.addEventListener("notificationclick", (event) => {
  const clickEvent = event as NotificationEvent;
  clickEvent.notification.close();
  const route = (clickEvent.notification.data?.route as string | undefined) ?? "/";
  const safeRoute = ["/comandas", "/pedidos", "/mesas"].includes(route) ? route : "/";
  clickEvent.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    const existing = windows.find((client) => new URL(client.url).origin === self.location.origin);
    if (existing) {
      await existing.focus();
      existing.postMessage({ type: "notification.navigate", route: safeRoute });
    } else {
      await self.clients.openWindow(new URL(safeRoute, self.location.origin).href);
    }
  })());
});
