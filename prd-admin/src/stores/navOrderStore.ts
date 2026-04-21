import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import { getUserPreferences, updateNavLayout } from '@/services';

/**
 * 导航排序中的分隔横杆哨兵值。
 * 该字符串出现在 NavOrder 数组中代表一根"---"分隔线；
 * 可以出现多次，连续的分隔符在渲染时合并为一根。
 */
export const NAV_DIVIDER_KEY = '---';

type NavOrderState = {
  /** 用户自定义的导航顺序（key 列表，可能包含 NAV_DIVIDER_KEY 作为分隔符） */
  navOrder: string[];
  /** 用户隐藏的 appKey 列表（不在左侧导航展示，但保留访问权） */
  navHidden: string[];
  /** 是否已从后端加载过 */
  loaded: boolean;
  /** 是否正在保存 */
  saving: boolean;
  /** 加载用户偏好 */
  loadFromServer: () => Promise<void>;
  /** 设置导航顺序（本地 + 防抖保存到后端） */
  setNavOrder: (order: string[]) => void;
  /** 设置隐藏列表（本地 + 防抖保存到后端） */
  setNavHidden: (hidden: string[]) => void;
  /** 同时设置顺序 + 隐藏（本地 + 防抖保存到后端，仅一次网络往返） */
  setNavLayout: (payload: { navOrder: string[]; navHidden: string[] }) => void;
  /** 恢复默认（清空自定义顺序与隐藏 → 回退到系统默认） */
  restoreDefault: () => Promise<void>;
  /** 重置状态（登出时调用） */
  reset: () => void;
};

const STORAGE_KEY = 'prd-admin-nav-order';

let saveTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleSave(get: () => NavOrderState, set: (partial: Partial<NavOrderState>) => void) {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    const state = get();
    if (state.saving) return;
    set({ saving: true });
    try {
      const res = await updateNavLayout({ navOrder: state.navOrder, navHidden: state.navHidden });
      if (!res.success) {
        console.error('[navOrderStore] 保存导航布局失败:', res.error);
      }
    } catch (err) {
      console.error('[navOrderStore] 保存导航布局异常:', err);
    } finally {
      set({ saving: false });
    }
  }, 500);
}

export const useNavOrderStore = create<NavOrderState>()(
  persist(
    (set, get) => ({
      navOrder: [],
      navHidden: [],
      loaded: false,
      saving: false,

      loadFromServer: async () => {
        if (get().loaded) return;
        try {
          const res = await getUserPreferences();
          if (res.success && res.data) {
            const serverOrder = res.data.navOrder ?? [];
            const serverHidden = res.data.navHidden ?? [];
            const localOrder = get().navOrder;
            const localHidden = get().navHidden;

            // 服务端有任何自定义数据 → 以服务端为准
            if (serverOrder.length > 0 || serverHidden.length > 0) {
              set({ navOrder: serverOrder, navHidden: serverHidden, loaded: true });
            } else if (localOrder.length > 0 || localHidden.length > 0) {
              // 服务端为空但本地有缓存：保留本地并异步同步到后端
              console.info('[navOrderStore] 后端无自定义导航，使用本地缓存并同步到后端');
              set({ loaded: true });
              updateNavLayout({ navOrder: localOrder, navHidden: localHidden }).catch((err) => {
                console.error('[navOrderStore] 同步本地布局到后端失败:', err);
              });
            } else {
              set({ loaded: true });
            }
          } else {
            set({ loaded: true });
          }
        } catch (err) {
          console.error('[navOrderStore] 加载导航布局失败:', err);
          set({ loaded: true });
        }
      },

      setNavOrder: (order: string[]) => {
        set({ navOrder: order });
        scheduleSave(get, set);
      },

      setNavHidden: (hidden: string[]) => {
        set({ navHidden: hidden });
        scheduleSave(get, set);
      },

      setNavLayout: (payload) => {
        set({ navOrder: payload.navOrder, navHidden: payload.navHidden });
        scheduleSave(get, set);
      },

      restoreDefault: async () => {
        if (saveTimer) clearTimeout(saveTimer);
        set({ navOrder: [], navHidden: [], saving: true });
        try {
          await updateNavLayout({ navOrder: [], navHidden: [] });
        } catch (err) {
          console.error('[navOrderStore] 恢复默认失败:', err);
        } finally {
          set({ saving: false });
        }
      },

      reset: () => {
        if (saveTimer) clearTimeout(saveTimer);
        try {
          sessionStorage.removeItem(STORAGE_KEY);
        } catch {
          // sessionStorage 可能不可用（SSR / 隐私模式）
        }
        set({ navOrder: [], navHidden: [], loaded: false, saving: false });
      },
    }),
    {
      name: STORAGE_KEY,
      storage: createJSONStorage(() => sessionStorage),
      // 本地缓存顺序和隐藏列表，避免每次刷新都等后端
      partialize: (s) => ({ navOrder: s.navOrder, navHidden: s.navHidden }),
    }
  )
);

/**
 * 合并导航顺序与权限过滤（仅处理非分隔符项，分隔符原样透传）。
 * @param allItems 所有导航项（默认顺序）
 * @param userOrder 用户自定义顺序（可能包含 NAV_DIVIDER_KEY）
 * @param permissions 当前用户权限
 * @returns 排序后的可见导航项 key 列表；分隔符以 `{ divider: true }` 形式返回
 */
export function mergeNavOrder<T extends { key: string; perm?: string }>(
  allItems: T[],
  userOrder: string[],
  permissions: string[]
): T[] {
  const perms = new Set(permissions);

  const visibleItems = allItems.filter((it) => !it.perm || perms.has(it.perm));
  const visibleKeys = new Set(visibleItems.map((it) => it.key));

  const orderedKeys = userOrder.filter((k) => k !== NAV_DIVIDER_KEY && visibleKeys.has(k));
  const orderedSet = new Set(orderedKeys);

  const newItems = visibleItems.filter((it) => !orderedSet.has(it.key));

  const result: T[] = [];
  const itemMap = new Map(allItems.map((it) => [it.key, it]));

  for (const key of orderedKeys) {
    const item = itemMap.get(key);
    if (item) result.push(item);
  }

  result.push(...newItems);

  return result;
}
