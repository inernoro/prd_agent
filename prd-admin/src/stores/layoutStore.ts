import { create } from 'zustand';
import { persist } from 'zustand/middleware';

type LayoutState = {
  navCollapsed: boolean;
  fullBleedMain: boolean;
  /** 移动端抽屉导航是否打开 */
  mobileDrawerOpen: boolean;
  setNavCollapsed: (v: boolean) => void;
  setFullBleedMain: (v: boolean) => void;
  toggleNavCollapsed: () => void;
  setMobileDrawerOpen: (v: boolean) => void;
};

export const useLayoutStore = create<LayoutState>()(
  persist(
    (set, get) => ({
      navCollapsed: false,
      fullBleedMain: false,
      mobileDrawerOpen: false,
      setNavCollapsed: (v) => set({ navCollapsed: Boolean(v) }),
      setFullBleedMain: (v) => set({ fullBleedMain: Boolean(v) }),
      toggleNavCollapsed: () => set({ navCollapsed: !get().navCollapsed }),
      setMobileDrawerOpen: (v) => set({ mobileDrawerOpen: Boolean(v) }),
    }),
    {
      name: 'prd-admin-layout',
      // 只持久化侧边栏折叠状态；fullBleed / mobileDrawerOpen 属于临时态
      partialize: (s) => ({ navCollapsed: s.navCollapsed }),
    }
  )
);


