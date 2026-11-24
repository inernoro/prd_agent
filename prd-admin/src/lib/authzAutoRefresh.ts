export const AUTHZ_AUTO_REFRESH_INTERVAL_MS = 30_000;

type EventListenerTarget = {
  addEventListener: (type: string, listener: () => void) => void;
  removeEventListener: (type: string, listener: () => void) => void;
};

type VisibilityTarget = EventListenerTarget & {
  visibilityState: string;
};

type TimerApi = {
  setInterval: (handler: () => void, timeout: number) => ReturnType<typeof setInterval>;
  clearInterval: (timer: ReturnType<typeof setInterval>) => void;
};

type InstallAuthzAutoRefreshOptions = {
  refresh: () => Promise<void> | void;
  windowTarget?: EventListenerTarget;
  documentTarget?: VisibilityTarget;
  timerApi?: TimerApi;
  intervalMs?: number;
};

/**
 * 已登录页面保持权限新鲜：回到标签页时立即同步，持续打开时定时同步。
 *
 * 用户级 allow/deny 不会改变全局角色指纹，因此不能只依赖响应头触发缓存失效。
 * 这里补齐最后一段，让管理员刚授予的权限在现有会话内生效，无需退出重登。
 */
export function installAuthzAutoRefresh({
  refresh,
  windowTarget = window,
  documentTarget = document,
  timerApi = window,
  intervalMs = AUTHZ_AUTO_REFRESH_INTERVAL_MS,
}: InstallAuthzAutoRefreshOptions): () => void {
  let refreshInFlight = false;

  const refreshWhenVisible = () => {
    if (documentTarget.visibilityState !== 'visible' || refreshInFlight) return;
    refreshInFlight = true;
    void Promise.resolve(refresh())
      .catch(() => undefined)
      .finally(() => {
        refreshInFlight = false;
      });
  };

  const onVisibilityChange = () => {
    if (documentTarget.visibilityState === 'visible') refreshWhenVisible();
  };

  windowTarget.addEventListener('focus', refreshWhenVisible);
  documentTarget.addEventListener('visibilitychange', onVisibilityChange);
  const timer = timerApi.setInterval(refreshWhenVisible, intervalMs);

  return () => {
    windowTarget.removeEventListener('focus', refreshWhenVisible);
    documentTarget.removeEventListener('visibilitychange', onVisibilityChange);
    timerApi.clearInterval(timer);
  };
}
