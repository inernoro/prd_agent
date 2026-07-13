/**
 * 移动端全局明暗偏好（2026-07-12 定稿，同日用户改口：黑皮肤为默认）：
 * 暗色默认，浅色可手动切换。
 *
 * 与桌面端主题体系（themeStore 的 colorDepth 深浅档位）互不干扰：
 * 本 store 只在移动端（<768px）生效，由 AppShell 把 mode 落到
 * <html data-theme="light">（tokens.css 已有全量白天 token 覆盖）。
 *
 * 存储用 localStorage（.claude/rules/no-localstorage.md 例外清单：
 * 纯 UI 偏好、发版后旧值无害、用户期望关浏览器也记住）。
 */
import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';

export type MobileThemeMode = 'light' | 'dark';

interface MobileThemeState {
  mode: MobileThemeMode;
  setMode: (mode: MobileThemeMode) => void;
  toggle: () => void;
}

export const useMobileThemeStore = create<MobileThemeState>()(
  persist(
    (set, get) => ({
      mode: 'dark',
      setMode: (mode) => set({ mode }),
      toggle: () => set({ mode: get().mode === 'dark' ? 'light' : 'dark' }),
    }),
    {
      // v2:默认从 light 改为 dark,换 key 让所有人回到新默认(旧 key 弃用)
      name: 'map-mobile-theme-v2',
      storage: createJSONStorage(() => localStorage),
    },
  ),
);
