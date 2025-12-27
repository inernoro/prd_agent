import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { User } from '../types';

interface AuthState {
  isAuthenticated: boolean;
  user: User | null;
  accessToken: string | null;
  refreshToken: string | null;
  sessionKey: string | null;
  
  login: (user: User, tokens: { accessToken: string; refreshToken: string; sessionKey: string }) => void;
  setTokens: (tokens: { accessToken: string; refreshToken: string; sessionKey: string }) => void;
  logout: () => void;
}

export const useAuthStore = create<AuthState>()(
  persist(
    (set) => ({
      isAuthenticated: false,
      user: null,
      accessToken: null,
      refreshToken: null,
      sessionKey: null,
      
      login: (user, tokens) => set({
        isAuthenticated: true,
        user,
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
        sessionKey: tokens.sessionKey,
      }),

      setTokens: (tokens) => set({
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
        sessionKey: tokens.sessionKey,
      }),
      
      logout: () => set({
        isAuthenticated: false,
        user: null,
        accessToken: null,
        refreshToken: null,
        sessionKey: null,
      }),
    }),
    {
      name: 'auth-storage',
    }
  )
);
