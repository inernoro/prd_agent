import { create } from 'zustand';

type State = {
  isOpen: boolean;
  groupId: string | null;
  drawerWidth: number;
  open: (groupId: string) => void;
  close: () => void;
  setDrawerWidth: (w: number) => void;
};

export const useGroupInfoDrawerStore = create<State>((set) => ({
  isOpen: false,
  groupId: null,
  drawerWidth: 420,
  open: (groupId) => set({ isOpen: true, groupId: String(groupId || '').trim() || null }),
  close: () => set({ isOpen: false, groupId: null }),
  setDrawerWidth: (w) => set({ drawerWidth: Math.max(320, Math.min(Math.floor(window.innerWidth * 0.92), Math.round(w))) }),
}));


