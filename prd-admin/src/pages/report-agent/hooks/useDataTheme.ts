import { useEffect, useState } from 'react';

/**
 * 监听 documentElement 上的 data-theme 属性变化，返回当前色彩模式。
 * 用于让 inline style 里的硬编码 rgba 能跟随浅色/暗色模式动态切换。
 *
 * 配合 ReportAgentPage.tsx 在 colorScheme 变化时 setAttribute 使用。
 */
export type DataTheme = 'light' | 'dark';

function readTheme(): DataTheme {
  if (typeof document === 'undefined') return 'dark';
  return document.documentElement.dataset.theme === 'light' ? 'light' : 'dark';
}

export function useDataTheme(): DataTheme {
  const [theme, setTheme] = useState<DataTheme>(readTheme);

  useEffect(() => {
    if (typeof document === 'undefined') return;
    const sync = () => setTheme(readTheme());
    sync(); // 首次同步,防止 SSR 与客户端不一致
    const obs = new MutationObserver(sync);
    obs.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme'],
    });
    return () => obs.disconnect();
  }, []);

  return theme;
}

/**
 * 根据当前主题挑选 alpha 值。常用于"暗色发光感、浅色淡底色"两套配色。
 * 用法:`pickAlpha(theme, { dark: 0.06, light: 0.03 })`
 */
export function pickAlpha(theme: DataTheme, values: { dark: number; light: number }): number {
  return theme === 'light' ? values.light : values.dark;
}

/**
 * 给一个 RGB 颜色生成"半透明背景"色。
 * `rgbColor` 形如 "59, 130, 246"(blue-500)。
 */
export function rgbaWithAlpha(rgbColor: string, alpha: number): string {
  return `rgba(${rgbColor}, ${alpha})`;
}
