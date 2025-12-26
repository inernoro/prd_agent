import { create } from 'zustand';

export type SystemDialogTone = 'neutral' | 'danger';

type AlertRequest = {
  kind: 'alert';
  title: string;
  message: string;
  tone: SystemDialogTone;
  confirmText: string;
  resolve: () => void;
};

type ConfirmRequest = {
  kind: 'confirm';
  title: string;
  message: string;
  tone: SystemDialogTone;
  confirmText: string;
  cancelText: string;
  resolve: (ok: boolean) => void;
};

type PromptRequest = {
  kind: 'prompt';
  title: string;
  message: string;
  tone: SystemDialogTone;
  placeholder?: string;
  defaultValue?: string;
  confirmText: string;
  cancelText: string;
  resolve: (value: string | null) => void;
};

export type SystemDialogRequest = AlertRequest | ConfirmRequest | PromptRequest;

type SystemDialogState = {
  current: SystemDialogRequest | null;
  queue: SystemDialogRequest[];
  enqueue: (req: SystemDialogRequest) => void;
  popNext: () => void;
  closeAlert: () => void;
  closeConfirm: (ok: boolean) => void;
  closePrompt: (value: string | null) => void;
};

export const useSystemDialogStore = create<SystemDialogState>((set, get) => ({
  current: null,
  queue: [],
  enqueue: (req) => {
    const cur = get().current;
    if (!cur) {
      set({ current: req });
      return;
    }
    set((s) => ({ queue: s.queue.concat(req) }));
  },
  popNext: () => {
    const q = get().queue;
    if (q.length === 0) {
      set({ current: null, queue: [] });
      return;
    }
    const [next, ...rest] = q;
    set({ current: next, queue: rest });
  },
  closeAlert: () => {
    const cur = get().current;
    if (cur?.kind !== 'alert') {
      get().popNext();
      return;
    }
    try {
      cur.resolve();
    } finally {
      get().popNext();
    }
  },
  closeConfirm: (ok) => {
    const cur = get().current;
    if (cur?.kind !== 'confirm') {
      get().popNext();
      return;
    }
    try {
      cur.resolve(ok);
    } finally {
      get().popNext();
    }
  },
  closePrompt: (value) => {
    const cur = get().current;
    if (cur?.kind !== 'prompt') {
      get().popNext();
      return;
    }
    try {
      cur.resolve(value);
    } finally {
      get().popNext();
    }
  },
}));

type AlertInput =
  | string
  | {
      title?: string;
      message: string;
      tone?: SystemDialogTone;
      confirmText?: string;
    };

type ConfirmInput =
  | string
  | {
      title?: string;
      message: string;
      tone?: SystemDialogTone;
      confirmText?: string;
      cancelText?: string;
    };

type PromptInput =
  | string
  | {
      title?: string;
      message: string;
      tone?: SystemDialogTone;
      placeholder?: string;
      defaultValue?: string;
      confirmText?: string;
      cancelText?: string;
    };

function normalizeMessage(x: string) {
  return String(x ?? '').trim() || '（无内容）';
}

export const systemDialog = {
  alert: (input: AlertInput): Promise<void> => {
    const opts =
      typeof input === 'string'
        ? { title: '提示', message: input, tone: 'neutral' as const, confirmText: '知道了' }
        : {
            title: input.title ?? '提示',
            message: input.message,
            tone: input.tone ?? 'neutral',
            confirmText: input.confirmText ?? '知道了',
          };
    return new Promise<void>((resolve) => {
      useSystemDialogStore.getState().enqueue({
        kind: 'alert',
        title: opts.title,
        message: normalizeMessage(opts.message),
        tone: opts.tone,
        confirmText: opts.confirmText,
        resolve,
      });
    });
  },

  confirm: (input: ConfirmInput): Promise<boolean> => {
    const opts =
      typeof input === 'string'
        ? { title: '确认操作', message: input, tone: 'neutral' as const, confirmText: '确认', cancelText: '取消' }
        : {
            title: input.title ?? '确认操作',
            message: input.message,
            tone: input.tone ?? 'neutral',
            confirmText: input.confirmText ?? '确认',
            cancelText: input.cancelText ?? '取消',
          };
    return new Promise<boolean>((resolve) => {
      useSystemDialogStore.getState().enqueue({
        kind: 'confirm',
        title: opts.title,
        message: normalizeMessage(opts.message),
        tone: opts.tone,
        confirmText: opts.confirmText,
        cancelText: opts.cancelText,
        resolve,
      });
    });
  },

  prompt: (input: PromptInput): Promise<string | null> => {
    const opts =
      typeof input === 'string'
        ? {
            title: '请输入',
            message: input,
            tone: 'neutral' as const,
            placeholder: undefined,
            defaultValue: '',
            confirmText: '确认',
            cancelText: '取消',
          }
        : {
            title: input.title ?? '请输入',
            message: input.message,
            tone: input.tone ?? 'neutral',
            placeholder: input.placeholder,
            defaultValue: input.defaultValue ?? '',
            confirmText: input.confirmText ?? '确认',
            cancelText: input.cancelText ?? '取消',
          };
    return new Promise<string | null>((resolve) => {
      useSystemDialogStore.getState().enqueue({
        kind: 'prompt',
        title: opts.title,
        message: normalizeMessage(opts.message),
        tone: opts.tone,
        placeholder: opts.placeholder,
        defaultValue: opts.defaultValue,
        confirmText: opts.confirmText,
        cancelText: opts.cancelText,
        resolve,
      });
    });
  },
};


