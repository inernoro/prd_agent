import { create } from 'zustand';
import { isTauri, rawInvoke } from '../lib/tauri';
import { useSystemNoticeStore } from './systemNoticeStore';

export type ConnectionStatus = 'unknown' | 'connected' | 'disconnected';

type ApiTestResult = {
  success: boolean;
  latencyMs: number | null;
  error: string | null;
  serverStatus: string | null;
};

type ConnectionState = {
  status: ConnectionStatus;
  lastChangedAt: number;
  lastReason: string | null;
  apiBaseUrl: string | null;
  isProbing: boolean;

  markConnected: () => void;
  markDisconnected: (reason?: string | null) => void;
  ensureApiBaseUrl: () => Promise<string | null>;
  probeOnce: () => Promise<boolean>;
};

let probeTimer: number | null = null;

function safeNow() {
  return Date.now();
}

function startAutoProbe() {
  if (probeTimer) return;
  // 轻量：仅在断连时开启；频率低，避免影响其他功能
  const intervalMs = 5000;
  probeTimer = window.setInterval(() => {
    void useConnectionStore.getState().probeOnce();
  }, intervalMs);
}

function stopAutoProbe() {
  if (!probeTimer) return;
  window.clearInterval(probeTimer);
  probeTimer = null;
}

export const useConnectionStore = create<ConnectionState>((set, get) => ({
  status: 'unknown',
  lastChangedAt: 0,
  lastReason: null,
  apiBaseUrl: null,
  isProbing: false,

  markConnected: () => {
    const prev = get().status;
    if (prev === 'connected') return;
    set({ status: 'connected', lastChangedAt: safeNow(), lastReason: null });
    stopAutoProbe();
    if (prev === 'disconnected') {
      useSystemNoticeStore.getState().push('连接已恢复', {
        level: 'info',
        ttlMs: 1800,
        signature: 'conn:connected',
      });
    }
  },

  markDisconnected: (reason) => {
    const prev = get().status;
    set({
      status: 'disconnected',
      lastChangedAt: safeNow(),
      lastReason: reason ? String(reason) : (prev === 'disconnected' ? get().lastReason : null),
    });
    startAutoProbe();
  },

  ensureApiBaseUrl: async () => {
    const existing = get().apiBaseUrl;
    if (existing) return existing;
    if (!isTauri()) return null;
    try {
      const cfg = await rawInvoke<{ apiBaseUrl: string }>('get_config');
      const url = String((cfg as any)?.apiBaseUrl ?? '').trim();
      if (url) {
        set({ apiBaseUrl: url });
        return url;
      }
      return null;
    } catch {
      return null;
    }
  },

  probeOnce: async () => {
    if (!isTauri()) return false;
    if (get().isProbing) return get().status !== 'disconnected';
    set({ isProbing: true });
    try {
      const apiUrl = (await get().ensureApiBaseUrl())?.trim();
      if (!apiUrl) return false;
      const res = await rawInvoke<ApiTestResult>('test_api_connection', { apiUrl });
      const ok = Boolean((res as any)?.success);
      if (ok) get().markConnected();
      else get().markDisconnected(String((res as any)?.error ?? '无法连接到服务器'));
      return ok;
    } catch (e) {
      get().markDisconnected(String(e));
      return false;
    } finally {
      set({ isProbing: false });
    }
  },
}));


