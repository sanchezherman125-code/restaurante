import { afterEach, describe, expect, it, vi } from "vitest";
import { unlockNotificationAudio, useUi, vibrateNotification } from "./ui";

afterEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});

describe("notification preferences and optional device APIs", () => {
  it("loads preferences scoped to the signed-in user", () => {
    localStorage.setItem("restaurante.notifications.user-a", JSON.stringify({ soundEnabled: false, volume: 0.2 }));
    localStorage.setItem("restaurante.notifications.user-b", JSON.stringify({ vibrationEnabled: false }));
    useUi.getState().loadPreferences("user-a");
    expect(useUi.getState().preferencesUserId).toBe("user-a");
    expect(useUi.getState().soundEnabled).toBe(false);
    expect(useUi.getState().volume).toBe(0.2);
    useUi.getState().loadPreferences("user-b");
    expect(useUi.getState().soundEnabled).toBe(true);
    expect(useUi.getState().vibrationEnabled).toBe(false);
  });

  it("does not throw when vibration is unsupported", () => {
    Object.defineProperty(navigator, "vibrate", { configurable: true, value: undefined });
    expect(() => vibrateNotification()).not.toThrow();
  });

  it("treats blocked audio as an optional capability", async () => {
    class BlockedAudioContext {
      state = "suspended";
      resume() { return Promise.reject(new Error("autoplay blocked")); }
    }
    Object.defineProperty(window, "AudioContext", { configurable: true, value: BlockedAudioContext });
    await expect(unlockNotificationAudio()).resolves.toBe(false);
  });
});
