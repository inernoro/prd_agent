/**
 * 全局明暗（外观）偏好 SSOT（2026-07-17 升级：从移动端专属扩展到全站）：
 * 暗色默认，浅色可手动切换；桌面与移动共用本 store，
 * 入口有两个——首页移动端右上角切换、设置 → 皮肤设置「外观」。
 * 由 AppShell 统一把 mode 落到 <html data-theme="light">
 * （tokens.css 已有全量白天 token 覆盖；纸面身份页自管主题，壳层不插手）。
 *
 * 历史：2026-07-12 作为移动端偏好定稿（黑皮肤默认）；文件名保留避免无谓改动面。
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
