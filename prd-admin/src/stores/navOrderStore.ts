import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { getUserPreferences, updateNavOrder } from '@/services';

type NavOrderState = {
  /** 用户自定义的导航顺序（key 列表） */
  navOrder: string[];
  /** 是否已从后端加载 */
  loaded: boolean;
  /** 是否正在保存 */
  saving: boolean;
  /** 加载用户偏好 */
  loadFromServer: () => Promise<void>;
  /** 设置导航顺序（本地 + 防抖保存到后端） */
  setNavOrder: (order: string[]) => void;
  /** 重置状态 */
  reset: () => void;
};

let saveTimer: ReturnType<typeof setTimeout> | null = null;

export const useNavOrderStore = create<NavOrderState>()(
  persist(
    (set, get) => ({
      navOrder: [],
      loaded: false,
      saving: false,

      loadFromServer: async () => {
        try {
          const res = await getUserPreferences();
          if (res.success && res.data) {
            set({ navOrder: res.data.navOrder ?? [], loaded: true });
          } else {
            set({ loaded: true });
          }
        } catch {
          set({ loaded: true });
        }
      },

      setNavOrder: (order: string[]) => {
        set({ navOrder: order });
        
        // 防抖保存到后端
        if (saveTimer) clearTimeout(saveTimer);
        saveTimer = setTimeout(async () => {
          const state = get();
          if (state.saving) return;
          set({ saving: true });
          try {
            await updateNavOrder(state.navOrder);
          } catch {
            // 静默失败，本地顺序仍然生效
          } finally {
            set({ saving: false });
          }
        }, 500);
      },

      reset: () => {
        if (saveTimer) clearTimeout(saveTimer);
        set({ navOrder: [], loaded: false, saving: false });
      },
    }),
    {
      name: 'prd-admin-nav-order',
      // 本地缓存顺序，避免每次刷新都等后端
      partialize: (s) => ({ navOrder: s.navOrder }),
    }
  )
);

/**
 * 合并导航顺序与权限过滤
 * @param allItems 所有导航项（默认顺序）
 * @param userOrder 用户自定义顺序
 * @param permissions 当前用户权限
 * @returns 排序后的可见导航项 key 列表
 */
export function mergeNavOrder<T extends { key: string; perm?: string }>(
  allItems: T[],
  userOrder: string[],
  permissions: string[]
): T[] {
  const perms = new Set(permissions);
  
  // 过滤出有权限的项
  const visibleItems = allItems.filter((it) => !it.perm || perms.has(it.perm));
  const visibleKeys = new Set(visibleItems.map((it) => it.key));
  
  // 按用户顺序排列（仅包含有权限的项）
  const orderedKeys = userOrder.filter((k) => visibleKeys.has(k));
  const orderedSet = new Set(orderedKeys);
  
  // 追加新增权限项（不在用户顺序中的）
  const newItems = visibleItems.filter((it) => !orderedSet.has(it.key));
  
  // 构建最终列表
  const result: T[] = [];
  const itemMap = new Map(allItems.map((it) => [it.key, it]));
  
  for (const key of orderedKeys) {
    const item = itemMap.get(key);
    if (item) result.push(item);
  }
  
  result.push(...newItems);
  
  return result;
}
