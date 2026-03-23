import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import type { AdminMenuItem } from '@/services/contracts/authz';
import type { UserRole } from '@/types/admin';

export type AuthUser = {
  userId: string;
  username: string;
  displayName: string;
  role: UserRole;
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
  /** CDN 基础地址（从后端 /api/authz/me 获取） */
  cdnBaseUrl: string;
  /** 权限指纹（后端基于权限目录+角色定义计算的哈希，用于检测部署/角色变更后的缓存失效） */
  permFingerprint: string;
  login: (user: AuthUser, token: string) => void;
  setTokens: (token: string, refreshToken: string, sessionKey: string) => void;
  setPermissions: (permissions: string[]) => void;
  setPermissionsLoaded: (loaded: boolean) => void;
  setIsRoot: (isRoot: boolean) => void;
  setMenuCatalog: (items: AdminMenuItem[]) => void;
  setMenuCatalogLoaded: (loaded: boolean) => void;
  setCdnBaseUrl: (url: string) => void;
  setPermFingerprint: (fp: string) => void;
  patchUser: (patch: Partial<AuthUser>) => void;
  logout: () => void;
};

const INITIAL_STATE = {
  isAuthenticated: false,
  user: null,
  token: null,
  refreshToken: null,
  sessionKey: null,
  permissions: [] as string[],
  permissionsLoaded: false,
  isRoot: false,
  menuCatalog: [] as AdminMenuItem[],
  menuCatalogLoaded: false,
  cdnBaseUrl: '',
  permFingerprint: '',
};

export const useAuthStore = create<AuthState>()(
  persist(
    (set) => ({
      ...INITIAL_STATE,
      login: (user, token) => set({ isAuthenticated: true, user, token }),
      setTokens: (token, refreshToken, sessionKey) => set({ token, refreshToken, sessionKey }),
      setPermissions: (permissions) => set({ permissions: Array.isArray(permissions) ? permissions : [] }),
      setPermissionsLoaded: (loaded) => set({ permissionsLoaded: !!loaded }),
      setIsRoot: (isRoot) => set({ isRoot: !!isRoot }),
      setMenuCatalog: (items) => set({ menuCatalog: Array.isArray(items) ? items : [], menuCatalogLoaded: true }),
      setMenuCatalogLoaded: (loaded) => set({ menuCatalogLoaded: !!loaded }),
      setCdnBaseUrl: (url) => set({ cdnBaseUrl: (url ?? '').trim().replace(/\/+$/, '') }),
      setPermFingerprint: (fp) => set({ permFingerprint: fp || '' }),
      patchUser: (patch) =>
        set((s) => (s.user ? { user: { ...s.user, ...patch } } : ({} as Partial<AuthState>))),
      logout: () => {
        sessionStorage.clear();
        set({ ...INITIAL_STATE });
      },
    }),
    {
      name: 'prd-admin-auth',
      storage: createJSONStorage(() => sessionStorage),
    }
  )
);
