import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import { getUserPreferences, updateNavLayout } from '@/services';
import { registerLogoutReset } from '@/stores/authStore';

export const NAV_DIVIDER_KEY = '---';

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
            const serverOrder = res.data.navOrder ?? [];
            const serverHidden = res.data.navHidden ?? [];
            const defaultNavOrder = res.data.defaultNavOrder ?? [];
            const defaultNavHidden = res.data.defaultNavHidden ?? [];
            const localOrder = get().navOrder;
            const localHidden = get().navHidden;

            if (serverOrder.length > 0 || serverHidden.length > 0) {
              set({
                navOrder: serverOrder,
                navHidden: serverHidden,
                defaultNavOrder,
                defaultNavHidden,
                loaded: true,
              });
            } else if (localOrder.length > 0 || localHidden.length > 0) {
              console.info('[navOrderStore] 后端无自定义导航，使用本地缓存并同步到后端');
              set({ defaultNavOrder, defaultNavHidden, loaded: true });
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
