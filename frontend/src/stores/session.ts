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
  revokeSession,
  setTokens,
  storedTokenSubject,
} from "../api/client";
import { listOperations } from "../offline/queue-db";
import { useUi } from "./ui";
import { forgetPushSubscription } from "../notifications/push";

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

/**
 * Generación de la sesión local: avanza con cada ingreso, salida o expiración. Una respuesta del servidor
 * pedida en una generación anterior pertenece a otra sesión y no se aplica, ni para confirmarla ni para cerrarla.
 */
let generation = 0;

function nextSession(): number {
  return ++generation;
}

export const useSession = create<SessionState>()(
  persist(
    (set, get) => ({
      user: null,
      initialized: false,
      unverified: false,
      login: async (username, pin) => {
        nextSession();
        const tokens = await authApi.login(username, pin, getDeviceId());
        setTokens(tokens.access_token, tokens.refresh_token);
        const user = await authApi.me();
        nextSession();
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
        // La salida local no espera a la red (un dispositivo compartido debe quedar libre al instante); la
        // revocación en el servidor sigue en segundo plano con las credenciales de quien sale.
        const access = getAccessToken();
        const refresh = getRefreshToken();
        const session = nextSession();
        clearTokens();
        set({ user: null, unverified: false });
        void revokeSession(access, refresh);
        // Sin service worker activo, "ready" nunca resuelve: por eso tampoco se espera.
        void forgetPushSubscription(() => generation === session);
      },
      restore: async () => {
        const session = generation;
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
          const subject = storedTokenSubject();
          try {
            const user = await authApi.me();
            // Mientras tanto pudo ingresar otro usuario: su sesión manda.
            if (generation === session && storedTokenSubject() === user.id) set({ user, unverified: false });
          } catch (error) {
            if (generation !== session || storedTokenSubject() !== subject) return;
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
        const session = generation;
        const expected = get().user?.id ?? null;
        const subject = storedTokenSubject();
        // La respuesta solo vale para la sesión que la pidió: mismo usuario activo y mismas credenciales.
        const stillCurrent = () => generation === session && get().user?.id === expected && storedTokenSubject() === subject;
        try {
          const user = await authApi.me();
          if (!stillCurrent() || user.id !== subject || (expected !== null && user.id !== expected)) return;
          set({ user, unverified: false });
        } catch (error) {
          // Sin conexión, o la sesión ya es de otro usuario: no se toca nada.
          if (isConnectivityError(error) || error instanceof OwnerChangedError || !stillCurrent()) return;
          nextSession();
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
onSessionExpired(() => {
  nextSession();
  useSession.setState({ user: null, unverified: false });
});
