/**
 * 主题 CSS 变量注入器
 * 将主题配置应用到 DOM
 */

import type { ThemeConfig } from '@/types/theme';
import { computeThemeVars } from './themeComputed';

/**
 * 将主题配置应用到 :root
 */
export function applyThemeToDOM(config: ThemeConfig): void {
  const vars = computeThemeVars(config);
  const root = document.documentElement;

  // 注入计算后的 CSS 变量
  Object.entries(vars).forEach(([key, value]) => {
    root.style.setProperty(key, String(value));
  });

  // 设置 data 属性供 CSS 选择器使用
  root.dataset.themeDepth = config.colorDepth;
  root.dataset.themeOpacity = config.opacity;
  root.dataset.themeGlow = config.enableGlow ? 'on' : 'off';
  root.dataset.themeSidebarGlass = config.sidebarGlass;
}

/**
 * 清除主题相关的 CSS 变量和 data 属性
 */
export function clearThemeFromDOM(): void {
  const root = document.documentElement;

  // 清除 CSS 变量
  const varsToRemove = [
    '--bg-base',
    '--bg-elevated',
    '--bg-card',
    '--glass-bg-start',
    '--glass-bg-end',
    '--glass-border',
    '--border-subtle',
    '--border-default',
    '--border-hover',
    '--border-faint',
    // 内嵌块样式变量
    '--nested-block-bg',
    '--nested-block-border',
    '--list-item-bg',
    '--list-item-border',
    '--list-item-hover-bg',
    // 表格样式变量
    '--table-header-bg',
    '--table-row-border',
    '--table-row-hover-bg',
  ];

  varsToRemove.forEach((key) => {
    root.style.removeProperty(key);
  });

  // 清除 data 属性
  delete root.dataset.themeDepth;
  delete root.dataset.themeOpacity;
  delete root.dataset.themeGlow;
  delete root.dataset.themeSidebarGlass;
}

/**
 * 检查主题是否已应用
 */
export function isThemeApplied(): boolean {
  return !!document.documentElement.dataset.themeDepth;
}
