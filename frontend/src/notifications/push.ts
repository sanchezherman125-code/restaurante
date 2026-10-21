import { apiRequest } from "../api/client";

export type PushSetupResult = "enabled" | "denied" | "unsupported" | "unavailable";

function decodePublicKey(value: string): Uint8Array {
  const padded = value + "=".repeat((4 - value.length % 4) % 4);
  const raw = atob(padded.replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(raw, (character) => character.charCodeAt(0));
}

export function supportsWebPush(): boolean {
  return typeof window !== "undefined" && "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
}

export async function enablePushNotifications(): Promise<PushSetupResult> {
  if (!supportsWebPush()) return "unsupported";
  try {
    // This must stay in the direct click path so browsers and iOS can grant permission.
    const permission = await Notification.requestPermission();
    if (permission !== "granted") return permission === "denied" ? "denied" : "unavailable";
    const registration = await navigator.serviceWorker.ready;
    const response = await apiRequest<{ public_key: string | null }>("/api/v1/push/public-key", { auth: false });
    if (!response.public_key) return "unavailable";
    const subscription = await registration.pushManager.getSubscription() ?? await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: decodePublicKey(response.public_key) as BufferSource,
    });
    const json = subscription.toJSON();
    if (!json.endpoint || !json.keys?.auth || !json.keys.p256dh) return "unavailable";
    await apiRequest("/api/v1/push/subscriptions", {
      method: "POST", body: { endpoint: json.endpoint, keys: json.keys },
    });
    return "enabled";
  } catch { return "unavailable"; }
}

export async function disablePushNotifications(): Promise<void> {
  if (!supportsWebPush()) return;
  try {
    const registration = await navigator.serviceWorker.ready;
    const subscription = await registration.pushManager.getSubscription();
    if (!subscription) return;
    try {
      await apiRequest<void>("/api/v1/push/subscriptions", {
        method: "DELETE", body: { endpoint: subscription.endpoint },
      });
    } finally {
      await subscription.unsubscribe();
    }
  } catch { /* backend logout also revokes subscriptions for this device */ }
}

export async function hasPushSubscription(): Promise<boolean> {
  if (!supportsWebPush() || Notification.permission !== "granted") return false;
  try { return Boolean(await (await navigator.serviceWorker.ready).pushManager.getSubscription()); }
  catch { return false; }
}
