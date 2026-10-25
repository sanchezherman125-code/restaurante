import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { Role, User } from "../types/api";
import { authApi } from "../api/endpoints";
import {
  clearTokens,
  getAccessToken,
  getDeviceId,
  getRefreshToken,
  isConnectivityError,
  onSessionExpired,
  setTokens,
  storedTokenSubject,
} from "../api/client";
import { listOperations } from "../offline/queue-db";
import { useUi } from "./ui";
import { disablePushNotifications } from "../notifications/push";

interface SessionState {
  user: User | null;
  initialized: boolean;
  /** Identidad recuperada sin conexión: pendiente de confirmar con el servidor al reconectar. */
  unverified: boolean;
  login: (username: string, pin: string) => Promise<User>;
  logout: () => Promise<void>;
  restore: () => Promise<void>;
  revalidate: () => Promise<void>;
  hasRole: (...roles: Role[]) => boolean;
}

export const useSession = create<SessionState>()(
  persist(
    (set, get) => ({
      user: null,
      initialized: false,
      unverified: false,
      login: async (username, pin) => {
        const tokens = await authApi.login(username, pin, getDeviceId());
        setTokens(tokens.access_token, tokens.refresh_token);
        const user = await authApi.me();
        set({ user, initialized: true, unverified: false });
        return user;
      },
      logout: async () => {
        const pending = (await listOperations()).some((op) => op.status !== "SYNCED"
          && (!op.owner_user_id || op.owner_user_id === get().user?.id));
        if (pending) {
          // Se explica en un diálogo (visible en cualquier pantalla) en lugar de un aviso fugaz.
          useUi.getState().setLogoutBlocked(true);
          return;
        }
        // Sin service worker activo, "ready" nunca resuelve: no debe bloquear el cierre de sesión.
        await Promise.race([disablePushNotifications(), new Promise<void>((resolve) => setTimeout(resolve, 2500))]);
        try {
          await authApi.logout();
        } catch {
          // la sesión local se limpia igualmente
        }
        clearTokens();
        set({ user: null, unverified: false });
      },
      restore: async () => {
        const remembered = get().user;
        if (!getAccessToken() && !getRefreshToken()) {
          set({ user: null, initialized: true, unverified: false });
          return;
        }
        try {
          const user = await authApi.me();
          set({ user, initialized: true, unverified: false });
        } catch (error) {
          if (!isConnectivityError(error)) {
            // Credenciales rechazadas por el servidor: nunca se reutiliza la identidad guardada.
            clearTokens();
            set({ user: null, initialized: true, unverified: false });
            return;
          }
          // Sin conexión: se conservan tokens e identidad solo si pertenecen al mismo usuario.
          const sameUser = remembered !== null && storedTokenSubject() === remembered.id;
          set({ user: sameUser ? remembered : null, initialized: true, unverified: sameUser });
        }
      },
      revalidate: async () => {
        if (!getAccessToken() && !getRefreshToken()) return;
        try {
          const user = await authApi.me();
          set({ user, unverified: false });
        } catch (error) {
          if (isConnectivityError(error)) return;
          clearTokens();
          set({ user: null, unverified: false });
        }
      },
      hasRole: (...roles) => {
        const user = get().user;
        return !!user && roles.includes(user.role);
      },
    }),
    {
      name: "restaurante.session",
      partialize: (state) => ({ user: state.user }),
    },
  ),
);

// El servidor rechazó la sesión: la interfaz vuelve al ingreso; la cola conserva sus operaciones.
onSessionExpired(() => useSession.setState({ user: null, unverified: false }));
