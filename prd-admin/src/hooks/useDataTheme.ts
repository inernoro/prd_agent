import { useEffect, useState } from 'react';

/**
 * 监听 <html data-theme> 属性，返回当前色彩模式（通用版，供壳层组件用）。
 * report-agent 下有一份同逻辑的页面私有 hook；壳层组件（MobileTabBar 等）
 * 从这里取，避免跨页面目录引用。
 */
export function useDataTheme(): 'light' | 'dark' {
  const read = () => (document.documentElement.dataset.theme === 'light' ? 'light' : 'dark');
  const [theme, setTheme] = useState<'light' | 'dark'>(read);

  useEffect(() => {
    const observer = new MutationObserver(() => setTheme(read()));
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    return () => observer.disconnect();
  }, []);

  return theme;
}
