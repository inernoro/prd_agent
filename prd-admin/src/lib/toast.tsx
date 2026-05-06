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
};

type ToastState = {
  toasts: Toast[];
  addToast: (toast: Omit<Toast, 'id'>) => void;
  removeToast: (id: string) => void;
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
    store.addToast({ type: 'info' as ToastType, title, message, duration: 60_000 });
    // addToast 内部生成 id，这里用最新添加的 toast id
    const toasts = useToastStore.getState().toasts;
    return toasts[toasts.length - 1]?.id ?? id;
  },

  /** 移除指定 toast */
  dismiss: (id: string) => {
    useToastStore.getState().removeToast(id);
  },
};
