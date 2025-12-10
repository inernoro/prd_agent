import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { User } from '../types';

interface AuthState {
  isAuthenticated: boolean;
  user: User | null;
  accessToken: string | null;
  
  login: (user: User, token: string) => void;
  logout: () => void;
}

export const useAuthStore = create<AuthState>()(
  persist(
    (set) => ({
      isAuthenticated: false,
      user: null,
      accessToken: null,
      
      login: (user, token) => set({
        isAuthenticated: true,
        user,
        accessToken: token,
      }),
      
      logout: () => set({
        isAuthenticated: false,
        user: null,
        accessToken: null,
      }),
    }),
    {
      name: 'auth-storage',
    }
  )
);



