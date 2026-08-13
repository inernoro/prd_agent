import { create } from 'zustand';

export type ToastType = 'success' | 'error' | 'info' | 'warning';

export type ToastAction = {
  /** 按钮文案，例如 "撤销" */
  label: string;
  /** 点击回调；点击后 toast 会自动关闭 */
  onClick: () => void;
};

export type Toast = {
  id: string;
  type: ToastType;
  title: string;
  message?: string;
  duration: number;
  action?: ToastAction;
  loading?: boolean;
};

type ToastState = {
  toasts: Toast[];
  addToast: (toast: Omit<Toast, 'id'>) => void;
  removeToast: (id: string) => void;
  /** 就地改写一条已存在的 toast（长任务推进度用，避免弹一串新条）。 */
  patchToast: (id: string, patch: Partial<Omit<Toast, 'id'>>) => void;
};

export const useToastStore = create<ToastState>((set) => ({
  toasts: [],
  addToast: (toast) => {
    const id = `toast-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
    const newToast = { ...toast, id };
    
    set((state) => ({
      toasts: [...state.toasts, newToast],
    }));

    // 自动移除
    setTimeout(() => {
      set((state) => ({
        toasts: state.toasts.filter((t) => t.id !== id),
      }));
    }, toast.duration);
  },
  removeToast: (id) => {
    set((state) => ({
      toasts: state.toasts.filter((t) => t.id !== id),
    }));
  },
  patchToast: (id, patch) => {
    set((state) => ({
      toasts: state.toasts.map((t) => (t.id === id ? { ...t, ...patch } : t)),
    }));
  },
}));

// Toast API
export const toast = {
  success: (title: string, message?: string, duration = 3000) => {
    useToastStore.getState().addToast({
      type: 'success',
      title,
      message,
      duration,
    });
  },

  error: (title: string, message?: string, duration = 4000) => {
    useToastStore.getState().addToast({
      type: 'error',
      title,
      message,
      duration,
    });
  },

  info: (title: string, message?: string, duration = 3000) => {
    useToastStore.getState().addToast({
      type: 'info',
      title,
      message,
      duration,
    });
  },

  warning: (title: string, message?: string, duration = 3000) => {
    useToastStore.getState().addToast({
      type: 'warning',
      title,
      message,
      duration,
    });
  },

  /**
   * 带操作按钮的 toast（撤销/重试等）。
   * 默认 duration 5000ms；点击 action.onClick 后会自动关闭 toast。
   */
  action: (
    title: string,
    options: { action: ToastAction; message?: string; duration?: number; type?: ToastType }
  ) => {
    useToastStore.getState().addToast({
      type: options.type ?? 'info',
      title,
      message: options.message,
      duration: options.duration ?? 5000,
      action: options.action,
    });
  },

  /** 显示持续加载提示，返回 toastId 用于后续 dismiss */
  loading: (title: string, message?: string): string => {
    const id = `toast-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
    const store = useToastStore.getState();
    store.addToast({ type: 'info' as ToastType, title, message, duration: 60_000, loading: true });
    // addToast 内部生成 id，这里用最新添加的 toast id
    const toasts = useToastStore.getState().toasts;
    return toasts[toasts.length - 1]?.id ?? id;
  },

  /**
   * 就地更新加载提示的文案。
   * 长任务（分层、批量生成）要让用户看见进度在动——静止的「加载中」超过 2 秒就是体验缺陷，
   * 而每推一步弹一条新 toast 又会刷屏，所以改写同一条。
   */
  update: (id: string, patch: { title?: string; message?: string }) => {
    useToastStore.getState().patchToast(id, patch);
  },

  /** 移除指定 toast */
  dismiss: (id: string) => {
    useToastStore.getState().removeToast(id);
  },
};
