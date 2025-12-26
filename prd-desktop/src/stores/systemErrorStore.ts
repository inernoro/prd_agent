import { create } from 'zustand';

export interface SystemErrorPayload {
  title?: string;
  code?: string | null;
  message: string;
  details?: string | null;
}

interface SystemErrorState {
  isOpen: boolean;
  title: string;
  code: string | null;
  message: string;
  details: string | null;

  // 去重/节流
  lastSignature: string | null;
  lastOpenedAt: number;

  open: (payload: SystemErrorPayload) => void;
  close: () => void;
}

const DEFAULT_TITLE = '系统错误';
const DEDUPE_WINDOW_MS = 1500;

function signatureOf(payload: SystemErrorPayload): string {
  return `${payload.code ?? ''}::${payload.message ?? ''}`;
}

export const useSystemErrorStore = create<SystemErrorState>((set, get) => ({
  isOpen: false,
  title: DEFAULT_TITLE,
  code: null,
  message: '',
  details: null,
  lastSignature: null,
  lastOpenedAt: 0,

  open: (payload) => {
    const now = Date.now();
    const sig = signatureOf(payload);
    const { lastSignature, lastOpenedAt } = get();

    // 短时间内同一错误不重复弹窗（避免多请求同时失败刷屏）
    if (lastSignature === sig && now - lastOpenedAt < DEDUPE_WINDOW_MS) return;

    set({
      isOpen: true,
      title: (payload.title || DEFAULT_TITLE).trim(),
      code: payload.code ? String(payload.code) : null,
      message: String(payload.message || '').trim() || '请求失败',
      details: payload.details ? String(payload.details) : null,
      lastSignature: sig,
      lastOpenedAt: now,
    });
  },

  close: () => {
    set({ isOpen: false });
  },
}));



