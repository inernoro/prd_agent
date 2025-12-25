import { create } from 'zustand';
import { persist } from 'zustand/middleware';

type LayoutState = {
  navCollapsed: boolean;
  setNavCollapsed: (v: boolean) => void;
  toggleNavCollapsed: () => void;
};

export const useLayoutStore = create<LayoutState>()(
  persist(
    (set, get) => ({
      navCollapsed: false,
      setNavCollapsed: (v) => set({ navCollapsed: Boolean(v) }),
      toggleNavCollapsed: () => set({ navCollapsed: !get().navCollapsed }),
    }),
    { name: 'prd-admin-layout' }
  )
);


