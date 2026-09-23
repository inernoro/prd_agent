import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import type { AdminMenuItem } from '@/services/contracts/authz';
import type { UserRole } from '@/types/admin';
// 这个模块自身零依赖，直接 import 不会造成上面那条注释里说的循环引用
import { clearAllOfflineEdits } from '@/pages/document-store/recordingOfflineQueue';
import { clearUserScopedStorage } from '@/lib/userScopedStorageKeys';

const AUTH_STORAGE_KEY = 'prd-admin-auth';

export type AuthUser = {
  userId: string;
  username: string;
  displayName: string;
  role: UserRole;
  userType?: 'Human' | 'Bot' | string;
  botKind?: 'PM' | 'DEV' | 'QA' | string;
  /** 后台系统角色，与 PM/DEV/QA 等业务角色相互独立。 */
  systemRoleKey?: string | null;
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

function migrateLegacyAuthToLocalStorage() {
  try {
    const existing = localStorage.getItem(AUTH_STORAGE_KEY);
    if (existing) return;
    const legacy = sessionStorage.getItem(AUTH_STORAGE_KEY);
    if (!legacy) return;
    localStorage.setItem(AUTH_STORAGE_KEY, legacy);
  } catch {
    /* ignore storage migration errors */
  }
}

// logout 时需要同步清理的 user-scoped store 回调；由各 store 在模块装载阶段自行注册。
// 用注册表避免 authStore 直接 import navOrderStore/agentSwitcherStore 造成
// authStore → navOrderStore → @/services → authStore 的循环引用。
const logoutResetCallbacks: Array<() => void> = [];

/** 注册一个 user-scoped 的重置回调，logout 时会同步执行。返回反注册函数。 */
export function registerLogoutReset(fn: () => void): () => void {
  logoutResetCallbacks.push(fn);
  return () => {
    const idx = logoutResetCallbacks.indexOf(fn);
    if (idx >= 0) logoutResetCallbacks.splice(idx, 1);
  };
}

/**
 * 把「这台设备上属于上一个人的东西」清干净。
 *
 * **登出与换号共用这一个**。只挂在 logout 上是不够的——换号不一定经过 logout：
 * `/synthetic-login` 这类入口直接调 `login()` 把当前用户换掉，于是上一个人的
 * 内存态与落盘数据原样留着，下一个人先看到的是别人的记录，一动手还会把别人的
 * 快照 PUT 进自己的账号。
 *
 * 跨账号串数据这件事在本 PR 里前后修了四次，每次都是「又发现一条没覆盖到的路径」。
 * 所以这一版把它收成咽喉：**凡是会让当前用户发生变化的地方，都走这里**，
 * 而不是逐条路径去补（配图生成闸也是同一个教训）。
 */
function runUserScopedCleanup(): void {
  // 同步执行所有已注册的 user-scoped 重置回调，确保 sessionStorage.clear 之前
  // navOrderStore.loaded / agentSwitcherStore.serverLoaded 等标志位已复位；
  // 否则同一浏览器切换账号时，下个用户的 loadFromServer() 会被 stale 标志 early-return，
  // 导致旧用户的自定义导航残留。
  for (const fn of logoutResetCallbacks) {
    try {
      fn();
    } catch (err) {
      console.error('[authStore] user-scoped reset callback 异常:', err);
    }
  }
  try { sessionStorage.clear(); } catch { /* 隐私模式下可能抛 */ }
  /*
   * 录音的离线校对草稿存在 localStorage 里（sessionStorage 兑现不了「关掉再回来还在」
   * 那句承诺）。键里带账号只决定恢复谁的草稿，挡不住同一台设备上的下一个人去翻，
   * 所以这一下必须把它们清掉——正文不该在人已经走了之后还留在盘上。
   */
  clearAllOfflineEdits();
  /*
   * 各 store 自己注册的那些回调只在它被求值过时才存在，而多数 store 挂在
   * 懒加载路由上——没进过那个页面就等于没注册。属于某个人的持久化数据
   * 不能靠那条路清，必须由这里（一定会被加载）动手。
   */
  clearUserScopedStorage();
}

export const useAuthStore = create<AuthState>()(
  persist(
    (set) => ({
      ...INITIAL_STATE,
      login: (user, token) => {
        // 换的是另一个人就先把上一个人的东西清干净。同一个人重新登录（续期、
        // 刷新令牌）不清，否则会把他自己没推上去的本地改动一并抹掉。
        const prev = useAuthStore.getState().user;
        if (prev && prev.userId !== user.userId) runUserScopedCleanup();
        set({ isAuthenticated: true, user, token });
      },
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
        // 清什么、为什么清，都在 runUserScopedCleanup 里。登出与换号共用同一段，
        // 别在这里再补一份——那正是这件事被修了四次的原因。
        runUserScopedCleanup();
        set({ ...INITIAL_STATE });
      },
    }),
    {
      name: AUTH_STORAGE_KEY,
      storage: createJSONStorage(() => {
        migrateLegacyAuthToLocalStorage();
        return localStorage;
      }),
    }
  )
);
