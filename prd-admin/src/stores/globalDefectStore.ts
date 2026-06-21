import { create } from 'zustand';

/** 打开全局缺陷弹窗时可携带的预填草稿（行为洞察「转为缺陷」复用真实缺陷面板用） */
export interface GlobalDefectPrefill {
  /** 预填正文（第一行会被提取为标题，故通常把标题作为正文首行；也可单独给 title） */
  content?: string;
  /** 显式预填标题（不依赖正文首行提取时使用） */
  title?: string;
  /** 预填严重度 */
  severity?: 'critical' | 'major' | 'minor' | 'trivial';
  /** 预填指派人 userId */
  assigneeUserId?: string;
}

/** 创建成功后的回调入参：真实创建出的缺陷 */
export interface GlobalDefectCreatedPayload {
  id: string;
  title: string;
}

interface OpenDialogOptions {
  prefill?: GlobalDefectPrefill;
  /** 缺陷创建成功后回调（行为洞察用来回写洞察状态 confirmed + defectId） */
  onCreated?: (defect: GlobalDefectCreatedPayload) => void;
}

interface GlobalDefectState {
  /** 是否显示全局缺陷提交对话框 */
  showDialog: boolean;
  /** 本次打开携带的预填草稿（关闭后清空） */
  prefill: GlobalDefectPrefill | null;
  /** 本次打开的创建成功回调（关闭后清空） */
  onCreated: ((defect: GlobalDefectCreatedPayload) => void) | null;
  /** 打开对话框，可选携带预填草稿 + 创建回调 */
  openDialog: (opts?: OpenDialogOptions) => void;
  /** 关闭对话框（清空预填与回调） */
  closeDialog: () => void;
  /** 切换对话框（快捷键触发，不带预填） */
  toggleDialog: () => void;
}

export const useGlobalDefectStore = create<GlobalDefectState>((set) => ({
  showDialog: false,
  prefill: null,
  onCreated: null,
  openDialog: (opts) =>
    set({ showDialog: true, prefill: opts?.prefill ?? null, onCreated: opts?.onCreated ?? null }),
  closeDialog: () => set({ showDialog: false, prefill: null, onCreated: null }),
  toggleDialog: () =>
    set((state) =>
      state.showDialog
        ? { showDialog: false, prefill: null, onCreated: null }
        : { showDialog: true }
    ),
}));
