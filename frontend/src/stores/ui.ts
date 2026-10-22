import { create } from "zustand";

export type ToastKind = "success" | "error" | "info" | "warning";
export interface Toast { id: string; kind: ToastKind; title: string; message?: string }
export type ConnectionState = "connecting" | "online" | "offline";
export interface NotificationPreferences { soundEnabled: boolean; volume: number; vibrationEnabled: boolean; pushEnabled: boolean }

const defaults: NotificationPreferences = { soundEnabled: true, volume: 0.45, vibrationEnabled: true, pushEnabled: false };
const prefKey = (userId: string) => `restaurante.notifications.${userId}`;

interface UiState extends NotificationPreferences {
  preferencesUserId: string | null;
  toasts: Toast[];
  connection: ConnectionState;
  logoutBlocked: boolean;
  setLogoutBlocked: (blocked: boolean) => void;
  loadPreferences: (userId: string) => void;
  updatePreferences: (userId: string, values: Partial<NotificationPreferences>) => void;
  toast: (kind: ToastKind, title: string, message?: string) => void;
  dismiss: (id: string) => void;
  setConnection: (state: ConnectionState) => void;
}

export const useUi = create<UiState>((set, get) => ({
  ...defaults,
  preferencesUserId: null,
  toasts: [],
  connection: "connecting",
  logoutBlocked: false,
  setLogoutBlocked: (logoutBlocked) => set({ logoutBlocked }),
  loadPreferences: (userId) => {
    try {
      const saved = localStorage.getItem(prefKey(userId));
      const parsed = saved ? JSON.parse(saved) as Partial<NotificationPreferences> : {};
      const legacySound = !saved && localStorage.getItem("restaurante.sound") === "off" ? false : defaults.soundEnabled;
      set({ ...defaults, ...parsed, soundEnabled: parsed.soundEnabled ?? legacySound, preferencesUserId: userId,
        volume: Math.max(0, Math.min(1, Number(parsed.volume ?? defaults.volume))) });
    } catch { set({ ...defaults, preferencesUserId: userId }); }
  },
  updatePreferences: (userId, values) => {
    const next = { soundEnabled: get().soundEnabled, volume: get().volume, vibrationEnabled: get().vibrationEnabled, pushEnabled: get().pushEnabled, ...values };
    set({ ...next, preferencesUserId: userId });
    try { localStorage.setItem(prefKey(userId), JSON.stringify(next)); } catch { /* almacenamiento opcional */ }
  },
  toast: (kind, title, message) => {
    const id = crypto.randomUUID();
    set({ toasts: [...get().toasts, { id, kind, title, message }] });
    setTimeout(() => get().dismiss(id), kind === "error" ? 8000 : 5000);
  },
  dismiss: (id) => set({ toasts: get().toasts.filter((toast) => toast.id !== id) }),
  setConnection: (connection) => set({ connection }),
}));

let audioCtx: AudioContext | null = null;
let activeNodes: OscillatorNode[] = [];

/** Call only from a direct user gesture; failures and unsupported audio are harmless. */
export async function unlockNotificationAudio(): Promise<boolean> {
  try {
    if (!("AudioContext" in window)) return false;
    audioCtx ??= new AudioContext();
    if (audioCtx.state === "suspended") await audioCtx.resume();
    return audioCtx.state === "running";
  } catch { return false; }
}

export function playNotificationSound(kind: "ready" | "command" | "payment" | "error" = "ready"): void {
  const prefs = useUi.getState();
  if (!prefs.soundEnabled || prefs.volume <= 0 || !audioCtx || audioCtx.state !== "running") return;
  try {
    activeNodes.forEach((node) => { try { node.stop(); } catch { /* ya detenido */ } });
    activeNodes = [];
    const patterns = {
      ready: [880, 1174], command: [660, 880, 1046], payment: [523, 784], error: [440, 330],
    }[kind];
    const now = audioCtx.currentTime;
    patterns.forEach((frequency, index) => {
      const oscillator = audioCtx!.createOscillator();
      const gain = audioCtx!.createGain();
      const start = now + index * 0.15;
      oscillator.type = "sine";
      oscillator.frequency.value = frequency;
      gain.gain.setValueAtTime(0.0001, start);
      gain.gain.linearRampToValueAtTime(Math.max(0.0001, prefs.volume * 0.18), start + 0.015);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.12);
      oscillator.connect(gain).connect(audioCtx!.destination);
      oscillator.start(start);
      oscillator.stop(start + 0.13);
      activeNodes.push(oscillator);
    });
  } catch { /* el audio bloqueado no interrumpe la aplicación */ }
}

export function vibrateNotification(pattern: number | number[] = 100): void {
  if (!useUi.getState().vibrationEnabled || typeof navigator === "undefined" || typeof navigator.vibrate !== "function") return;
  try { navigator.vibrate(pattern); } catch { /* haptics opcionales */ }
}
