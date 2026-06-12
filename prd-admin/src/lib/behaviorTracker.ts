/**
 * 全局行为信号采集器（行为洞察面板的采集层）。
 * 在 App 根挂载一次，对全站路由生效：记录页面「可见停留时长」（标签页隐藏不计时）
 * 与路由跳转，批量上报到 POST /api/behavior/events。
 * 原则：只采路由级信号，不采输入内容；上报失败静默丢弃，绝不影响业务。
 */
import { useAuthStore } from '@/stores/authStore';

export type PendingBehaviorEvent = {
  type: 'route-dwell' | 'route-transition';
  route: string;
  fromRoute?: string;
  dwellMs?: number;
  occurredAt: string;
};

/** 归一化路由：数字段 / 长 hex / GUID 段替换为 :id，与后端 NormalizePath 口径一致 */
export function normalizeRoute(pathname: string): string {
  const normalized = pathname
    .split('/')
    .map((seg) => {
      if (!seg) return seg;
      if (/^\d+$/.test(seg)) return ':id';
      if (/^[0-9a-fA-F-]{16,}$/.test(seg)) return ':id';
      return seg;
    })
    .join('/');
  return normalized || '/';
}

const FLUSH_INTERVAL_MS = 20_000;
const MAX_QUEUE = 200;
const MIN_DWELL_MS = 1_000;
/** 登录页等无业务含义的路由不采集 */
const SKIP_ROUTES = new Set(['/login', '/']);

let started = false;
let queue: PendingBehaviorEvent[] = [];
let currentRoute: string | null = null;
let visibleSince = 0; // 0 = 当前不可见
let accumVisibleMs = 0;

function isTrackable(route: string | null): route is string {
  return !!route && !SKIP_ROUTES.has(route);
}

function push(event: PendingBehaviorEvent) {
  if (!useAuthStore.getState().isAuthenticated) return;
  queue.push(event);
  if (queue.length >= MAX_QUEUE) flush();
}

function flush(keepalive = false) {
  if (queue.length === 0) return;
  const token = useAuthStore.getState().token;
  if (!token) {
    queue = [];
    return;
  }
  const events = queue.splice(0, 100);
  // 不走 apiRequest：pagehide 场景需要 keepalive，且采集失败不需要任何错误处理链路
  void fetch('/api/behavior/events', {
    method: 'POST',
    keepalive,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
      'X-Client': 'admin',
    },
    body: JSON.stringify({ events }),
  }).catch(() => undefined);
}

function closeDwell(now: number) {
  if (!isTrackable(currentRoute)) return;
  const dwell = accumVisibleMs + (visibleSince > 0 ? now - visibleSince : 0);
  if (dwell >= MIN_DWELL_MS) {
    push({
      type: 'route-dwell',
      route: currentRoute,
      dwellMs: Math.round(dwell),
      occurredAt: new Date(now).toISOString(),
    });
  }
}

/** 路由变化入口（由 App 根的 useLocation effect 调用） */
export function trackRouteChange(pathname: string) {
  const next = normalizeRoute(pathname);
  if (next === currentRoute) return;
  const now = Date.now();
  closeDwell(now);
  if (isTrackable(currentRoute) && isTrackable(next)) {
    push({ type: 'route-transition', route: next, fromRoute: currentRoute, occurredAt: new Date(now).toISOString() });
  }
  currentRoute = next;
  accumVisibleMs = 0;
  visibleSince = typeof document !== 'undefined' && document.visibilityState === 'visible' ? now : 0;
}

/** 全局只初始化一次：可见性计时 + 定时冲刷 + 离开页面兜底上报 */
export function initBehaviorTracker() {
  if (started) return;
  started = true;
  document.addEventListener('visibilitychange', () => {
    const now = Date.now();
    if (document.visibilityState === 'hidden') {
      if (visibleSince > 0) {
        accumVisibleMs += now - visibleSince;
        visibleSince = 0;
      }
      flush(true);
    } else {
      visibleSince = now;
    }
  });
  window.addEventListener('pagehide', () => {
    closeDwell(Date.now());
    flush(true);
  });
  window.setInterval(() => flush(), FLUSH_INTERVAL_MS);
}
