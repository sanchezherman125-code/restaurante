import { afterEach, describe, expect, it, vi } from "vitest";
import { apiRequest } from "../api/client";
import { enablePushNotifications } from "./push";

vi.mock("../api/client", () => ({ apiRequest: vi.fn() }));

const mockedApi = vi.mocked(apiRequest);

function setPushBrowser(permission: string, subscription?: PushSubscription) {
  class TestNotification { static requestPermission = vi.fn().mockResolvedValue(permission); }
  class TestPushManager {}
  Object.defineProperty(window, "Notification", { configurable: true, value: TestNotification });
  Object.defineProperty(window, "PushManager", { configurable: true, value: TestPushManager });
  Object.defineProperty(navigator, "serviceWorker", { configurable: true, value: {
    ready: Promise.resolve({ pushManager: {
      getSubscription: vi.fn().mockResolvedValue(subscription ?? null),
      subscribe: vi.fn().mockResolvedValue(subscription),
    } }),
  } });
}

afterEach(() => {
  mockedApi.mockReset();
  Reflect.deleteProperty(window, "Notification");
  Reflect.deleteProperty(window, "PushManager");
  Reflect.deleteProperty(navigator, "serviceWorker");
});

describe("Web Push onboarding", () => {
  it("does not subscribe or call the backend after permission is denied", async () => {
    setPushBrowser("denied");
    await expect(enablePushNotifications()).resolves.toBe("denied");
    expect(mockedApi).not.toHaveBeenCalled();
  });

  it("stores a granted subscription with the backend", async () => {
    const subscription = {
      endpoint: "https://push.example.test/sub",
      toJSON: () => ({ endpoint: "https://push.example.test/sub", keys: { auth: "auth", p256dh: "key" } }),
    } as unknown as PushSubscription;
    setPushBrowser("granted", subscription);
    mockedApi.mockResolvedValueOnce({ public_key: "AQID" }).mockResolvedValueOnce({ status: "ok" });
    await expect(enablePushNotifications()).resolves.toBe("enabled");
    expect(mockedApi).toHaveBeenNthCalledWith(2, "/api/v1/push/subscriptions", expect.objectContaining({
      method: "POST", body: { endpoint: subscription.endpoint, keys: { auth: "auth", p256dh: "key" } },
    }));
  });
});
