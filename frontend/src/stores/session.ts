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
  OwnerChangedError,
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
        try {
          const remembered = get().user;
          if (!getAccessToken() && !getRefreshToken()) {
            set({ user: null, unverified: false });
            return;
          }
          if (remembered !== null && storedTokenSubject() === remembered.id) {
            // Identidad local de este dispositivo: la interfaz arranca sin esperar a la red (una red que no
            // responde demoraría el arranque 15 s o más). El servidor la confirma en segundo plano y sigue
            // autorizando cada operación.
            set({ user: remembered, unverified: true });
            void get().revalidate();
            return;
          }
          // Sin identidad local utilizable: solo el servidor puede decir quién es.
          try {
            const user = await authApi.me();
            set({ user, unverified: false });
          } catch (error) {
            // Credenciales rechazadas: se limpian. Sin conexión se conservan para intentarlo al reconectar.
            if (!isConnectivityError(error) && !(error instanceof OwnerChangedError)) clearTokens();
            set({ user: null, unverified: false });
          }
        } catch {
          // Error inesperado (almacenamiento bloqueado, etc.): ingreso manual, nunca una carga infinita.
          set({ user: null, unverified: false });
        } finally {
          set({ initialized: true });
        }
      },
      revalidate: async () => {
        if (!getAccessToken() && !getRefreshToken()) return;
        const expected = get().user?.id ?? null;
        try {
          const user = await authApi.me();
          // Solo se aplica si mientras tanto no cambió el usuario del dispositivo.
          if (expected === null || user.id === expected) set({ user, unverified: false });
        } catch (error) {
          // Sin conexión, o la sesión ya es de otro usuario: no se toca nada.
          if (isConnectivityError(error) || error instanceof OwnerChangedError) return;
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
