import { create } from "zustand";

export type ToastKind = "success" | "error" | "info" | "warning";

export interface Toast {
  id: string;
  kind: ToastKind;
  title: string;
  message?: string;
}

export type ConnectionState = "connecting" | "online" | "offline";

interface UiState {
  toasts: Toast[];
  connection: ConnectionState;
  soundEnabled: boolean;
  toast: (kind: ToastKind, title: string, message?: string) => void;
  dismiss: (id: string) => void;
  setConnection: (state: ConnectionState) => void;
  toggleSound: () => void;
}

export const useUi = create<UiState>((set, get) => ({
  toasts: [],
  connection: "connecting",
  soundEnabled: localStorage.getItem("restaurante.sound") !== "off",
  toast: (kind, title, message) => {
    const id = crypto.randomUUID();
    set({ toasts: [...get().toasts, { id, kind, title, message }] });
    setTimeout(() => get().dismiss(id), kind === "error" ? 8000 : 5000);
  },
  dismiss: (id) => set({ toasts: get().toasts.filter((t) => t.id !== id) }),
  setConnection: (connection) => set({ connection }),
  toggleSound: () => {
    const next = !get().soundEnabled;
    localStorage.setItem("restaurante.sound", next ? "on" : "off");
    set({ soundEnabled: next });
  },
}));

let audioCtx: AudioContext | null = null;

export function playBeep(kind: "ready" | "error" = "ready"): void {
  if (!useUi.getState().soundEnabled) return;
  try {
    audioCtx = audioCtx ?? new AudioContext();
    const now = audioCtx.currentTime;
    const frequencies = kind === "ready" ? [880, 1174.66] : [440, 330];
    frequencies.forEach((freq, index) => {
      const osc = audioCtx!.createOscillator();
      const gain = audioCtx!.createGain();
      osc.type = "sine";
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.0001, now + index * 0.18);
      gain.gain.exponentialRampToValueAtTime(0.25, now + index * 0.18 + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + index * 0.18 + 0.16);
      osc.connect(gain).connect(audioCtx!.destination);
      osc.start(now + index * 0.18);
      osc.stop(now + index * 0.18 + 0.2);
    });
  } catch {
    // audio no disponible
  }
}
