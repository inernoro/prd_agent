import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export type AuthUser = {
  userId: string;
  username: string;
  displayName: string;
  role: 'PM' | 'DEV' | 'QA' | 'ADMIN';
  userType?: 'Human' | 'Bot' | string;
  botKind?: 'PM' | 'DEV' | 'QA' | string;
  avatarFileName?: string | null;
  /** 服务端下发的完整头像 URL（优先使用） */
  avatarUrl?: string | null;
};

type AuthState = {
  isAuthenticated: boolean;
  user: AuthUser | null;
  token: string | null;
  refreshToken: string | null;
  sessionKey: string | null;
  permissions: string[];
  permissionsLoaded: boolean;
  login: (user: AuthUser, token: string) => void;
  setTokens: (token: string, refreshToken: string, sessionKey: string) => void;
  setPermissions: (permissions: string[]) => void;
  setPermissionsLoaded: (loaded: boolean) => void;
  patchUser: (patch: Partial<AuthUser>) => void;
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
      permissions: [],
      permissionsLoaded: false,
      login: (user, token) => set({ isAuthenticated: true, user, token }),
      setTokens: (token, refreshToken, sessionKey) => set({ token, refreshToken, sessionKey }),
      setPermissions: (permissions) => set({ permissions: Array.isArray(permissions) ? permissions : [] }),
      setPermissionsLoaded: (loaded) => set({ permissionsLoaded: !!loaded }),
      patchUser: (patch) =>
        set((s) => (s.user ? { user: { ...s.user, ...patch } } : ({} as Partial<AuthState>))),
      logout: () => set({ isAuthenticated: false, user: null, token: null, refreshToken: null, sessionKey: null, permissions: [], permissionsLoaded: false }),
    }),
    { name: 'prd-admin-auth' }
  )
);
