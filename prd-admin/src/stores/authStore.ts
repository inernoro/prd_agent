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
  login: (user: AuthUser, token: string) => void;
  logout: () => void;
};

export const useAuthStore = create<AuthState>()(
  persist(
    (set) => ({
      isAuthenticated: false,
      user: null,
      token: null,
      login: (user, token) => set({ isAuthenticated: true, user, token }),
      logout: () => set({ isAuthenticated: false, user: null, token: null }),
    }),
    { name: 'prd-admin-auth' }
  )
);
