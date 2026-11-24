/**
 * 全局明暗（外观）偏好 SSOT（2026-07-17 升级：从移动端专属扩展到全站）：
 * 暗色默认，浅色可手动切换；桌面与移动共用本 store，
 * 入口有两个——全局侧栏切换、设置 → 皮肤设置「外观」。
 * 由 AppShell 统一把 mode 落到 <html data-theme="light">
 * （tokens.css 已有全量白天 token 覆盖；仅独立纸面身份页自管主题，壳层不插手）。
 *
 * 历史：2026-07-12 作为移动端偏好定稿（黑皮肤默认）；文件名保留避免无谓改动面。
 *
 * 存储用 localStorage（.claude/rules/no-localstorage.md 例外清单：
 * 纯 UI 偏好、发版后旧值无害、用户期望关浏览器也记住）。
 */
import { useEffect, useState } from 'react';
import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';

import { subscribeMediaQuery } from '@/lib/mediaQuerySubscribe';

/**
 * 用户选的偏好。'system' 是偏好、不是最终值——落 DOM 前一律先过 resolveThemeMode()。
 * 存量用户存的是 'light' / 'dark'，仍然合法，不需要迁移。
 */
export type MobileThemeMode = 'light' | 'dark' | 'system';
/** 真正能落到 <html data-theme> 上的值。 */
export type ResolvedThemeMode = 'light' | 'dark';

const SYSTEM_DARK_QUERY = '(prefers-color-scheme: dark)';

/** 拿不到 matchMedia（SSR / 老环境）时按全站默认当暗色，不猜浅色。 */
export function systemPrefersDark(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return true;
  return window.matchMedia(SYSTEM_DARK_QUERY).matches;
}

export function resolveThemeMode(mode: MobileThemeMode): ResolvedThemeMode {
  if (mode === 'system') return systemPrefersDark() ? 'dark' : 'light';
  return mode;
}

/**
 * 订阅系统深浅变化。只有偏好是 'system' 时才需要——否则系统怎么变都不该动用户的选择。
 * 返回取消订阅函数。
 */
export function watchSystemThemeChange(onChange: () => void): () => void {
  // 走共享订阅：Safari 14 之前 MediaQueryList 只有 addListener，直接
  // addEventListener 会当场抛，「随系统」这一档在那些浏览器上整个用不了。
  return subscribeMediaQuery(SYSTEM_DARK_QUERY, onChange);
}

interface MobileThemeState {
  mode: MobileThemeMode;
  setMode: (mode: MobileThemeMode) => void;
}

export const useMobileThemeStore = create<MobileThemeState>()(
  persist(
    (set) => ({
      mode: 'dark',
      setMode: (mode) => set({ mode }),
    }),
    {
      // v2:默认从 light 改为 dark,换 key 让所有人回到新默认(旧 key 弃用)
      name: 'map-mobile-theme-v2',
      storage: createJSONStorage(() => localStorage),
    },
  ),
);

/**
 * 当前**真正生效**的明暗（把 'system' 解开之后的结果），并且跟着系统变化实时更新。
 *
 * 凡是要拿明暗做分支的地方（皮肤对象、图标、"点一下切到哪一边"）都必须用它，
 * 不能直接拿 store 里的 mode 去比 'dark' —— 用户选了「随系统」时那样比永远为 false，
 * 会出现「DOM 已经是暗色、组件却按浅色渲染」的错位。
 *
 * 只读 DOM 的组件（useDataTheme）不受影响，它们本来读的就是解析后的结果。
 */
export function useResolvedThemeMode(): ResolvedThemeMode {
  const mode = useMobileThemeStore((state) => state.mode);
  const [systemDark, setSystemDark] = useState(systemPrefersDark);

  useEffect(() => {
    if (mode !== 'system') return;
    setSystemDark(systemPrefersDark());
    return watchSystemThemeChange(() => setSystemDark(systemPrefersDark()));
  }, [mode]);

  if (mode !== 'system') return mode;
  return systemDark ? 'dark' : 'light';
}
