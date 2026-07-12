import { AS_COLOR, AS_COLOR_LIGHT } from '@/lib/appStoreTokens';
import { useDataTheme } from '@/hooks/useDataTheme';

/**
 * App Store token 的主题反应层:跟随 <html data-theme> 返回 iOS 暗/浅色板。
 * 移动端页面/组件用它替代直接 import AS_COLOR,即可获得白天形态。
 */
export function useAppStoreColors(): Record<keyof typeof AS_COLOR, string> {
  return useDataTheme() === 'light' ? AS_COLOR_LIGHT : AS_COLOR;
}
