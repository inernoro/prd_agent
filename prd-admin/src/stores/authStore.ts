import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export type AuthUser = {
  userId: string;
  username: string;
  displayName: string;
  role: 'PM' | 'DEV' | 'QA' | 'ADMIN';
};

type AuthState = {
  isAuthenticated: boolean;
  user: AuthUser | null;
  token: string | null;
  refreshToken: string | null;
  sessionKey: string | null;
  login: (user: AuthUser, token: string) => void;
  setTokens: (token: string, refreshToken: string, sessionKey: string) => void;
  logout: () => void;
};

export const useAuthStore = create<AuthState>()(
  persist(
    (set) => ({
      isAuthenticated: false,
      user: null,
      token: null,
      refreshToken: null,
      sessionKey: null,
      login: (user, token) => set({ isAuthenticated: true, user, token }),
      setTokens: (token, refreshToken, sessionKey) => set({ token, refreshToken, sessionKey }),
      logout: () => set({ isAuthenticated: false, user: null, token: null, refreshToken: null, sessionKey: null }),
    }),
    { name: 'prd-admin-auth' }
  )
);
