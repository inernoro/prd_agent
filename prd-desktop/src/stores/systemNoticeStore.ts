import { create } from 'zustand';

export type SystemNoticeLevel = 'info' | 'warning' | 'error';

export type SystemNotice = {
  id: string;
  level: SystemNoticeLevel;
  message: string;
  createdAt: number;
  expiresAt: number;
  signature: string;
};

type PushArgs = {
  level?: SystemNoticeLevel;
  ttlMs?: number;
  signature?: string;
};

interface SystemNoticeState {
  notices: SystemNotice[];
  push: (message: string, args?: PushArgs) => void;
  remove: (id: string) => void;
  clear: () => void;
}

function signatureOf(level: SystemNoticeLevel, message: string, signature?: string) {
  const s = String(signature || '').trim();
  if (s) return s;
  return `${level}:${String(message || '').trim()}`;
}

export const useSystemNoticeStore = create<SystemNoticeState>((set, get) => ({
  notices: [],

  push: (message, args) => {
    const msg = String(message || '').trim();
    if (!msg) return;

    const level: SystemNoticeLevel = (args?.level ?? 'info') as any;
    const ttlMs = Math.max(800, Math.min(60_000, Number(args?.ttlMs ?? 6000)));
    const now = Date.now();
    const sig = signatureOf(level, msg, args?.signature);

    // 去重策略：
    // - 10s 内相同 signature 仅刷新过期时间，不重复堆叠
    const dedupeWindowMs = 10_000;
    const existing = get().notices.find((n) => n.signature === sig && now - n.createdAt < dedupeWindowMs);

    if (existing) {
      const next = get().notices.map((n) =>
        n.id === existing.id
          ? { ...n, message: msg, level, expiresAt: now + ttlMs }
          : n
      );
      set({ notices: next });
      return;
    }

    const notice: SystemNotice = {
      id: `notice-${now}-${Math.random().toString(16).slice(2)}`,
      level,
      message: msg,
      createdAt: now,
      expiresAt: now + ttlMs,
      signature: sig,
    };

    // 保留最近 3 条，避免 UI 过多遮挡
    const next = [...get().notices, notice].slice(-3);
    set({ notices: next });
  },

  remove: (id) => {
    const tid = String(id || '').trim();
    if (!tid) return;
    set((s) => ({ notices: (s.notices || []).filter((n) => n.id !== tid) }));
  },

  clear: () => set({ notices: [] }),
}));


