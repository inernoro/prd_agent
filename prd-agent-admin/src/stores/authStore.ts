import { create } from 'zustand';
import { persist } from 'zustand/middleware';

interface User {
  userId: string;
  username: string;
  displayName: string;
  role: string;
}

interface AuthState {
  isAuthenticated: boolean;
  user: User | null;
  token: string | null;
  login: (user: User, token: string) => void;
  logout: () => void;
}

export const useAuthStore = create<AuthState>()(
  persist(
    (set) => ({
      isAuthenticated: false,
      user: null,
      token: null,
      
      login: (user, token) => set({
        isAuthenticated: true,
        user,
        token,
      }),
      
      logout: () => set({
        isAuthenticated: false,
        user: null,
        token: null,
      }),
    }),
    {
      name: 'admin-auth-storage',
    }
  )
);
