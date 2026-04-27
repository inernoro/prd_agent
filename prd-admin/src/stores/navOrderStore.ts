import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import { getUserPreferences, updateNavLayout } from '@/services';
import { registerLogoutReset } from '@/stores/authStore';
import { migrateLegacyNavId } from '@/lib/launcherCatalog';

export const NAV_DIVIDER_KEY = '---';

/** 把 v7 之前的前缀 ID（agent:visual-agent 等）透明转换为新 ID */
function migrateOrder(arr: string[] | null | undefined): string[] {
  return (arr ?? []).map(migrateLegacyNavId);
}

type NavOrderState = {
  navOrder: string[];
  navHidden: string[];
  defaultNavOrder: string[];
  defaultNavHidden: string[];
  loaded: boolean;
  saving: boolean;
  loadFromServer: () => Promise<void>;
  setNavLayout: (payload: { navOrder: string[]; navHidden: string[] }) => void;
  setDefaultNavLayoutLocal: (payload: { navOrder: string[]; navHidden: string[] }) => void;
  restoreDefault: () => Promise<void>;
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
      defaultNavOrder: [],
      defaultNavHidden: [],
      loaded: false,
      saving: false,

      loadFromServer: async () => {
        if (get().loaded) return;
        try {
          const res = await getUserPreferences();
          if (res.success && res.data) {
            // v7 兼容：transparently 把旧前缀 ID 迁移到新格式
            const serverOrder = migrateOrder(res.data.navOrder);
            const serverHidden = migrateOrder(res.data.navHidden);
            const defaultNavOrder = migrateOrder(res.data.defaultNavOrder);
            const defaultNavHidden = migrateOrder(res.data.defaultNavHidden);
            const orderChanged =
              JSON.stringify(serverOrder) !== JSON.stringify(res.data.navOrder ?? []) ||
              JSON.stringify(serverHidden) !== JSON.stringify(res.data.navHidden ?? []);
            const localOrder = migrateOrder(get().navOrder);
            const localHidden = migrateOrder(get().navHidden);

            if (serverOrder.length > 0 || serverHidden.length > 0) {
              set({
                navOrder: serverOrder,
                navHidden: serverHidden,
                defaultNavOrder,
                defaultNavHidden,
                loaded: true,
              });
              // 服务器有旧 ID → 落库一次新 ID，避免每次加载都迁移
              if (orderChanged) {
                updateNavLayout({ navOrder: serverOrder, navHidden: serverHidden }).catch((err) => {
                  console.error('[navOrderStore] 持久化迁移后的导航布局失败:', err);
                });
              }
            } else if (localOrder.length > 0 || localHidden.length > 0) {
              console.info('[navOrderStore] 后端无自定义导航，使用本地缓存并同步到后端');
              set({
                navOrder: localOrder,
                navHidden: localHidden,
                defaultNavOrder,
                defaultNavHidden,
                loaded: true,
              });
              updateNavLayout({ navOrder: localOrder, navHidden: localHidden }).catch((err) => {
                console.error('[navOrderStore] 同步本地布局到后端失败:', err);
              });
            } else {
              set({ defaultNavOrder, defaultNavHidden, loaded: true });
            }
          } else {
            set({ loaded: true });
          }
        } catch (err) {
          console.error('[navOrderStore] 加载导航布局失败:', err);
          set({ loaded: true });
        }
      },

      setNavLayout: (payload) => {
        set({ navOrder: payload.navOrder, navHidden: payload.navHidden });
        scheduleSave(get, set);
      },

      setDefaultNavLayoutLocal: (payload) => {
        set({ defaultNavOrder: payload.navOrder, defaultNavHidden: payload.navHidden });
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
          // ignore sessionStorage failures
        }
        set({
          navOrder: [],
          navHidden: [],
          defaultNavOrder: [],
          defaultNavHidden: [],
          loaded: false,
          saving: false,
        });
      },
    }),
    {
      name: STORAGE_KEY,
      storage: createJSONStorage(() => sessionStorage),
      partialize: (s) => ({ navOrder: s.navOrder, navHidden: s.navHidden }),
    }
  )
);

registerLogoutReset(() => {
  useNavOrderStore.getState().reset();
});
