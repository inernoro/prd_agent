/**
 * 主题 CSS 变量注入器
 * 将主题配置应用到 DOM
 */

import type { ThemeConfig } from '@/types/theme';
import { DEFAULT_THEME_CONFIG } from '@/types/theme';
import { computeThemeVars } from './themeComputed';

/**
 * 检测当前平台是否为 Windows
 */
let _isWindows: boolean | null = null;
export function isWindowsPlatform(): boolean {
  if (_isWindows === null) {
    _isWindows = navigator.userAgent.includes('Windows');
  }
  return _isWindows;
}

/**
 * 系统是否开启「减少动态效果」偏好
 */
export function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    ? window.matchMedia('(prefers-reduced-motion: reduce)').matches
    : false;
}

/**
 * 根据配置判断是否应该启用性能模式（降低动画/过渡强度）。
 * 2026-07-17 起只影响 data-perf-mode（动画侧），不再参与「玻璃还是实底」的材质判定；
 * perf 模式的全局 backdrop-filter 清除也已限定在素色材质下（见 legacy.css）。
 */
export function shouldReduceEffects(config: ThemeConfig): boolean {
  if (prefersReducedMotion()) return true;
  if (config.performanceMode === 'performance') return true;
  if (config.performanceMode === 'quality') return false;
  // auto: Windows 自动启用性能模式
  return isWindowsPlatform();
}

/**
 * 界面材质是否为素色实底。这是「表面渲染走玻璃还是实底」的唯一判定入口——
 * GlassCard 与 CSS 都以它为准。
 *
 * 2026-07-17 修正（用户反馈「切换玻璃和非玻璃没有任何区别」）：
 * 旧实现 OR 了 shouldReduceEffects——性能模式 / Windows auto / 系统「减少动态效果」
 * 任意命中就把材质锁死在素色，开关形同虚设。材质是用户的决定，100% 跟随选择；
 * 性能模式与减少动态效果只管动画强度（data-perf-mode），不劫持材质
 * （blur 是静态效果，不属于「动态效果」的范畴）。
 */
export function isSolidMaterial(config: ThemeConfig): boolean {
  return (config.material ?? DEFAULT_THEME_CONFIG.material) === 'solid';
}

/**
 * 设计参数归一化（2026-07-17 用户定「不要让用户来决定这些」）：
 * 用户只保留两个决定——外观（深/浅）与界面材质（素色/玻璃）。
 * 色深、透明度、光晕、侧边栏玻璃是设计参数，一律回到系统预设；
 * 存量配置里的个性化值不再参与渲染（字段保留仅为前后端兼容）。
 * performanceMode 保留为内部性能保险丝（Windows auto / 减少动态效果），不再暴露 UI。
 */
export function normalizeThemeConfig(config: ThemeConfig): ThemeConfig {
  return {
    ...config,
    colorDepth: 'default',
    opacity: 'default',
    enableGlow: (config.material ?? DEFAULT_THEME_CONFIG.material) === 'glass',
    sidebarGlass: 'always',
  };
}

/**
 * 将主题配置应用到 :root
 */
export function applyThemeToDOM(rawConfig: ThemeConfig): void {
  // 渲染前先归一化：设计参数走系统预设，用户只保留 材质 + 外观 两个决定
  const config = normalizeThemeConfig(rawConfig);
  const reduceEffects = shouldReduceEffects(config);
  const solidMaterial = isSolidMaterial(config);
  // 表面 token 只由材质决定（素色 → 实底 token 集；玻璃 → 玻璃 token 集），
  // 性能模式不再参与表面判定，只通过 data-perf-mode 压动画。
  const vars = computeThemeVars(config, solidMaterial);
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
  // 界面材质：CSS 据此清除 backdrop-filter / 压平棱光高光（见 tokens.css [data-material="solid"]）
  root.dataset.material = solidMaterial ? 'solid' : 'glass';

  // 性能模式：设置 data 属性，全局 CSS 会根据此属性清除 backdrop-filter
  if (reduceEffects) {
    root.dataset.perfMode = 'performance';
  } else {
    delete root.dataset.perfMode;
  }
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
  delete root.dataset.material;
  delete root.dataset.perfMode;
}

/**
 * 检查主题是否已应用
 */
export function isThemeApplied(): boolean {
  return !!document.documentElement.dataset.themeDepth;
}
