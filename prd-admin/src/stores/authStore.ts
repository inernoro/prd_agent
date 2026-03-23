import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { AdminMenuItem } from '@/services/contracts/authz';
import type { UserRole } from '@/types/admin';

declare const __BUILD_HASH__: string;

/**
 * 构建哈希（每次部署变更）。
 * Zustand persist 的 version 字段基于此值：版本不匹配时自动清空 store，
 * 强制用户重新登录，彻底解决部署后 localStorage 残留导致的 token 串数据问题。
 */
const BUILD_HASH = typeof __BUILD_HASH__ === 'string' ? __BUILD_HASH__ : 'dev';

/**
 * 将构建哈希转为数字版本号（Zustand persist version 只接受 number）。
 * 每次部署产生不同的 hash → 不同的 version → 触发 migrate → 清空旧状态。
 */
function hashToVersion(hash: string): number {
  let n = 0;
  for (let i = 0; i < hash.length; i++) {
    n = ((n << 5) - n + hash.charCodeAt(i)) | 0;
  }
  return Math.abs(n);
}

const STORE_VERSION = hashToVersion(BUILD_HASH);

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
        // 清空所有本地存储，避免垃圾数据
        localStorage.clear();
        sessionStorage.clear();
        // 重置 store 状态
        set({ ...INITIAL_STATE });
      },
    }),
    {
      name: 'prd-admin-auth',
      version: STORE_VERSION,
      migrate: () => {
        // 版本不匹配（新部署）→ 返回干净的初始状态，强制重新登录
        // 这会丢弃旧的 token/refreshToken/permissions 等所有缓存数据
        return { ...INITIAL_STATE };
      },
    }
  )
);
