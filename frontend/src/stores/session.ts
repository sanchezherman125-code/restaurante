import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { Role, User } from "../types/api";
import { authApi } from "../api/endpoints";
import { clearTokens, getDeviceId, getAccessToken, setTokens } from "../api/client";

interface SessionState {
  user: User | null;
  initialized: boolean;
  login: (username: string, pin: string) => Promise<User>;
  logout: () => Promise<void>;
  restore: () => Promise<void>;
  hasRole: (...roles: Role[]) => boolean;
}

export const useSession = create<SessionState>()(
  persist(
    (set, get) => ({
      user: null,
      initialized: false,
      login: async (username, pin) => {
        const tokens = await authApi.login(username, pin, getDeviceId());
        setTokens(tokens.access_token, tokens.refresh_token);
        const user = await authApi.me();
        set({ user, initialized: true });
        return user;
      },
      logout: async () => {
        try {
          await authApi.logout();
        } catch {
          // la sesión local se limpia igualmente
        }
        clearTokens();
        set({ user: null });
      },
      restore: async () => {
        if (getAccessToken()) {
          try {
            const user = await authApi.me();
            set({ user, initialized: true });
            return;
          } catch {
            clearTokens();
          }
        }
        set({ user: null, initialized: true });
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
