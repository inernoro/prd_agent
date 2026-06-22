import { useSyncExternalStore } from 'react';

const QUERY = '(prefers-reduced-motion: reduce)';

type LegacyMql = MediaQueryList & {
  addListener?: (cb: () => void) => void;
  removeListener?: (cb: () => void) => void;
};

function subscribe(cb: () => void): () => void {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return () => {};
  const mq = window.matchMedia(QUERY);
  if (typeof mq.addEventListener === 'function') {
    mq.addEventListener('change', cb);
    return () => mq.removeEventListener('change', cb);
  }
  // 老旧 Safari 回退
  const legacy = mq as LegacyMql;
  legacy.addListener?.(cb);
  return () => legacy.removeListener?.(cb);
}

function getSnapshot(): boolean {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    ? window.matchMedia(QUERY).matches
    : false;
}

/**
 * 响应式订阅系统「减少动态效果」偏好。
 * 与 themeApplier.prefersReducedMotion() 同源，但这是 React 钩子：
 * 偏好在运行中变化时会触发使用它的组件重渲染，消除「OS 切换后弹窗遮罩/徽章滞后」问题。
 */
export function useReducedMotion(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot, () => false);
}
