import { create } from 'zustand';

interface GlobalDefectState {
  /** 是否显示全局缺陷提交对话框 */
  showDialog: boolean;
  /** 打开对话框 */
  openDialog: () => void;
  /** 关闭对话框 */
  closeDialog: () => void;
  /** 切换对话框 */
  toggleDialog: () => void;
}

export const useGlobalDefectStore = create<GlobalDefectState>((set) => ({
  showDialog: false,
  openDialog: () => set({ showDialog: true }),
  closeDialog: () => set({ showDialog: false }),
  toggleDialog: () => set((state) => ({ showDialog: !state.showDialog })),
}));
