import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { AdminMenuItem } from '@/services/contracts/authz';

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
  /** 是否为 root 用户（超级管理员） */
  isRoot: boolean;
  /** 菜单目录（从后端获取） */
  menuCatalog: AdminMenuItem[];
  /** 菜单目录是否已加载 */
  menuCatalogLoaded: boolean;
  login: (user: AuthUser, token: string) => void;
  setTokens: (token: string, refreshToken: string, sessionKey: string) => void;
  setPermissions: (permissions: string[]) => void;
  setPermissionsLoaded: (loaded: boolean) => void;
  setIsRoot: (isRoot: boolean) => void;
  setMenuCatalog: (items: AdminMenuItem[]) => void;
  setMenuCatalogLoaded: (loaded: boolean) => void;
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
      isRoot: false,
      menuCatalog: [],
      menuCatalogLoaded: false,
      login: (user, token) => set({ isAuthenticated: true, user, token }),
      setTokens: (token, refreshToken, sessionKey) => set({ token, refreshToken, sessionKey }),
      setPermissions: (permissions) => set({ permissions: Array.isArray(permissions) ? permissions : [] }),
      setPermissionsLoaded: (loaded) => set({ permissionsLoaded: !!loaded }),
      setIsRoot: (isRoot) => set({ isRoot: !!isRoot }),
      setMenuCatalog: (items) => set({ menuCatalog: Array.isArray(items) ? items : [], menuCatalogLoaded: true }),
      setMenuCatalogLoaded: (loaded) => set({ menuCatalogLoaded: !!loaded }),
      patchUser: (patch) =>
        set((s) => (s.user ? { user: { ...s.user, ...patch } } : ({} as Partial<AuthState>))),
      logout: () => set({
        isAuthenticated: false,
        user: null,
        token: null,
        refreshToken: null,
        sessionKey: null,
        permissions: [],
        permissionsLoaded: false,
        isRoot: false,
        menuCatalog: [],
        menuCatalogLoaded: false,
      }),
    }),
    { name: 'prd-admin-auth' }
  )
);
