import { create } from 'zustand';
import { persist } from 'zustand/middleware';

type LayoutState = {
  navCollapsed: boolean;
  fullBleedMain: boolean;
  setNavCollapsed: (v: boolean) => void;
  setFullBleedMain: (v: boolean) => void;
  toggleNavCollapsed: () => void;
};

export const useLayoutStore = create<LayoutState>()(
  persist(
    (set, get) => ({
      navCollapsed: false,
      fullBleedMain: false,
      setNavCollapsed: (v) => set({ navCollapsed: Boolean(v) }),
      setFullBleedMain: (v) => set({ fullBleedMain: Boolean(v) }),
      toggleNavCollapsed: () => set({ navCollapsed: !get().navCollapsed }),
    }),
    {
      name: 'prd-admin-layout',
      // 只持久化侧边栏折叠状态；fullBleed 属于临时“专注”态，避免刷新后影响其他页面布局
      partialize: (s) => ({ navCollapsed: s.navCollapsed }),
    }
  )
);


