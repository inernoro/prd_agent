import { create } from 'zustand';

export type ToastType = 'success' | 'error' | 'info' | 'warning';

export type Toast = {
  id: string;
  type: ToastType;
  title: string;
  message?: string;
  duration: number;
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
};
