import { create } from 'zustand';

type OpenPlatformState = {
  isOpen: boolean;
  open: () => void;
  close: () => void;
  setOpen: (v: boolean) => void;
};

export const useOpenPlatformStore = create<OpenPlatformState>((set) => ({
  isOpen: false,
  open: () => set({ isOpen: true }),
  close: () => set({ isOpen: false }),
  setOpen: (v) => set({ isOpen: Boolean(v) }),
}));

