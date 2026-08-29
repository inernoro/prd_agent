import { useEffect } from 'react';

import { applyDocumentThemeMode } from '@/lib/themeTransition';
import { useMobileThemeStore, useResolvedThemeMode } from '@/stores/mobileThemeStore';

/**
 * 把全局明暗偏好落到 <html data-theme> 上，并且**跟着系统变化重新落一次**。
 *
 * 给 AppShell 之外的独立全屏页用（分享阅读页、数据同步授权/回调页……）。
 * 这些页面不在 AppShell 里，拿不到壳层的主题接线，各自写一个 effect 就会漏掉一件事：
 *
 *   偏好是 'system' 时，用户在系统里切深浅，store 里的 mode **没有变**。
 *   只把 mode 放进 deps 的 effect 于是不会重跑，DOM 停在旧主题，
 *   而页面上的主题图标（读的是解析后的值）已经变了 —— 图标和实际配色对不上。
 *
 * 所以这里把解析后的值一起放进 deps。新增独立全屏页一律用这个 hook，
 * 不要再自己写 applyDocumentThemeMode 的 effect（有守卫盯着，见
 * lib/__tests__/themeModeRegistry.test.ts）。
 */
export function useApplyDocumentTheme(pathname: string): void {
  const mode = useMobileThemeStore((state) => state.mode);
  const resolved = useResolvedThemeMode();

  useEffect(() => {
    applyDocumentThemeMode(mode, pathname);
    // resolved 必须在 deps 里：'system' 偏好下它是唯一会变的那个值。
  }, [mode, resolved, pathname]);
}
