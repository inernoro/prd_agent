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
  /**
   * 标记"疑似断线"——默认走 2s 防抖：2s 内如果有任一成功响应（markConnected），
   * 则不会真正切到 disconnected 状态，避免瞬时抖动/单次 500/单次超时触发全局 UI 闪烁。
   * 传 immediate=true 表示已知确实断连（例如探活失败），直接切状态。
   */
  markDisconnected: (reason?: string | null, immediate?: boolean) => void;
  ensureApiBaseUrl: () => Promise<string | null>;
  probeOnce: () => Promise<boolean>;
};

let probeTimer: number | null = null;
let probeAttempts = 0;
let disconnectDebounceTimer: number | null = null;

// 防抖窗口：在该时长内任一成功响应会取消待生效的 disconnected 切换
const DISCONNECT_DEBOUNCE_MS = 2000;

function safeNow() {
  return Date.now();
}

function nextProbeDelay() {
  // 指数退避：5s → 10s → 20s → 40s → 60s（上限）
  const base = 5000;
  const delay = Math.min(60_000, base * Math.pow(2, Math.max(0, probeAttempts - 1)));
  return delay;
}

function scheduleAutoProbe() {
  if (probeTimer) return;
  probeAttempts += 1;
  const delay = nextProbeDelay();
  probeTimer = window.setTimeout(async () => {
    probeTimer = null;
    await useConnectionStore.getState().probeOnce();
    // 若仍断连，继续退避重试
    if (useConnectionStore.getState().status === 'disconnected') {
      scheduleAutoProbe();
    }
  }, delay) as unknown as number;
}

function stopAutoProbe() {
  if (probeTimer) {
    window.clearTimeout(probeTimer);
    probeTimer = null;
  }
  probeAttempts = 0;
}

function cancelDebounce() {
  if (disconnectDebounceTimer != null) {
    window.clearTimeout(disconnectDebounceTimer);
    disconnectDebounceTimer = null;
  }
}

export const useConnectionStore = create<ConnectionState>((set, get) => ({
  status: 'unknown',
  lastChangedAt: 0,
  lastReason: null,
  apiBaseUrl: null,
  isProbing: false,

  markConnected: () => {
    // 任一成功响应：取消待生效的 disconnected 切换（解决瞬时抖动误报）
    cancelDebounce();
    const prev = get().status;
    if (prev === 'connected') return;
    set({ status: 'connected', lastChangedAt: safeNow(), lastReason: null });
    stopAutoProbe();
    if (prev === 'disconnected') {
      // 恢复提示保留但更低调：1.2s 后自动消失
      useSystemNoticeStore.getState().push('连接已恢复', {
        level: 'info',
        ttlMs: 1200,
        signature: 'conn:connected',
      });
    }
  },

  markDisconnected: (reason, immediate = false) => {
    if (immediate) {
      cancelDebounce();
      const prev = get().status;
      set({
        status: 'disconnected',
        lastChangedAt: safeNow(),
        lastReason: reason ? String(reason) : (prev === 'disconnected' ? get().lastReason : null),
      });
      scheduleAutoProbe();
      return;
    }
    // 已经 disconnected 则仅刷新 reason（避免重复调度）
    if (get().status === 'disconnected') {
      if (reason) set({ lastReason: String(reason) });
      return;
    }
    // 2s 防抖：窗口内任一成功响应会取消该调度
    if (disconnectDebounceTimer != null) return;
    const pendingReason = reason ? String(reason) : null;
    disconnectDebounceTimer = window.setTimeout(() => {
      disconnectDebounceTimer = null;
      // 再次确认：窗口结束时若已被 markConnected 修复，就不切状态
      if (get().status === 'connected') return;
      set({
        status: 'disconnected',
        lastChangedAt: safeNow(),
        lastReason: pendingReason ?? get().lastReason,
      });
      scheduleAutoProbe();
    }, DISCONNECT_DEBOUNCE_MS) as unknown as number;
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
      // 探活明确失败：immediate=true，直接标记断连（不再走 2s 防抖）
      else get().markDisconnected(String((res as any)?.error ?? '无法连接到服务器'), true);
      return ok;
    } catch (e) {
      get().markDisconnected(String(e), true);
      return false;
    } finally {
      set({ isProbing: false });
    }
  },
}));


