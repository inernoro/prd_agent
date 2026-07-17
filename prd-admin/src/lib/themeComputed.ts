/**
 * 根据主题配置计算 CSS 变量值
 */

import type { ThemeConfig } from '@/types/theme';
import { COLOR_DEPTH_MAP, OPACITY_MAP, NESTED_BLOCK_STYLES } from '@/types/theme';

/**
 * 计算后的 CSS 变量
 */
export interface ComputedThemeVars {
  // 背景色
  '--bg-base': string;
  '--bg-elevated': string;
  '--bg-card': string;

  // 玻璃效果参数
  '--glass-bg-start': string;
  '--glass-bg-end': string;
  '--glass-border': string;

  // 边框
  '--border-subtle': string;
  '--border-default': string;
  '--border-hover': string;
  '--border-faint': string;

  // 内嵌块样式（用于页面内的子容器）
  '--nested-block-bg': string;
  '--nested-block-border': string;
  '--list-item-bg': string;
  '--list-item-border': string;
  '--list-item-hover-bg': string;

  // 表格样式
  '--table-header-bg': string;
  '--table-row-border': string;
  '--table-row-hover-bg': string;
}

/**
 * 根据主题配置计算 CSS 变量值
 * @param reduceEffects 是否为性能模式（输出实底暗色替代玻璃透明）
 */
export function computeThemeVars(config: ThemeConfig, reduceEffects = false): ComputedThemeVars {
  const depth = COLOR_DEPTH_MAP[config.colorDepth];
  const opacity = OPACITY_MAP[config.opacity];

  // 边框透明度基于 opacity 配置调整
  const borderMultiplier = opacity.border / 0.18; // 相对于默认值的倍数

  // 玻璃亮度倍数（受色深影响）
  const glassBrightness = depth.glassBrightness;

  // ── 素色材质 / 性能模式：纯平实底暗色表面，不依赖 backdrop-filter ──
  // 2026-07-16 重做（用户：「不要 2000 年的塑料亚克力风」）：
  // 半透明 + 渐变 + 白色高光 = 亚克力感的三个来源，素色一律砍掉——
  // 表面完全不透明、start/end 同值（渐变退化为纯平色）、层级靠细描边与底色阶梯表达。
  if (reduceEffects) {
    // 从 bgElevated hex 提取 RGB，构造实底表面
    const r = parseInt(depth.bgElevated.slice(1, 3), 16);
    const g = parseInt(depth.bgElevated.slice(3, 5), 16);
    const b = parseInt(depth.bgElevated.slice(5, 7), 16);

    // 基于色深的表面亮度微调（小步抬升：表面只比底色亮一档，现代扁平的层级来自描边而非亮度差）
    const lift = { darker: 4, default: 6, lighter: 10 }[config.colorDepth] ?? 6;
    const sr = Math.min(255, r + lift);
    const sg = Math.min(255, g + lift);
    const sb = Math.min(255, b + lift);

    return {
      '--bg-base': depth.bgBase,
      '--bg-elevated': depth.bgElevated,
      '--bg-card': depth.bgCard,

      // 纯平实底表面（同值 → linear-gradient 退化为平色；全不透明，杜绝亚克力感）
      '--glass-bg-start': `rgb(${sr}, ${sg}, ${sb})`,
      '--glass-bg-end': `rgb(${sr}, ${sg}, ${sb})`,
      '--glass-border': `rgba(255, 255, 255, ${(0.08 * glassBrightness).toFixed(4)})`,

      // 边框
      '--border-subtle': `rgba(255, 255, 255, ${(0.10 * borderMultiplier * glassBrightness).toFixed(4)})`,
      '--border-default': `rgba(255, 255, 255, ${(0.14 * borderMultiplier * glassBrightness).toFixed(4)})`,
      '--border-hover': `rgba(255, 255, 255, ${(0.20 * borderMultiplier * glassBrightness).toFixed(4)})`,
      '--border-faint': `rgba(255, 255, 255, ${(0.06 * borderMultiplier * glassBrightness).toFixed(4)})`,

      // 内嵌块样式
      '--nested-block-bg': `rgba(255, 255, 255, 0.05)`,
      '--nested-block-border': `rgba(255, 255, 255, 0.09)`,
      '--list-item-bg': `rgba(255, 255, 255, 0.045)`,
      '--list-item-border': `rgba(255, 255, 255, 0.08)`,
      '--list-item-hover-bg': `rgba(255, 255, 255, 0.08)`,

      // 表格样式
      '--table-header-bg': `rgba(255, 255, 255, 0.045)`,
      '--table-row-border': `rgba(255, 255, 255, 0.08)`,
      '--table-row-hover-bg': `rgba(255, 255, 255, 0.05)`,
    };
  }

  // ── 质量模式（液态玻璃）──

  // 计算最终的玻璃透明度值（透明度 × 亮度倍数）
  const glassStartAlpha = Math.min(1, opacity.glassStart * glassBrightness);
  const glassEndAlpha = Math.min(1, opacity.glassEnd * glassBrightness);
  const glassBorderAlpha = Math.min(1, opacity.border * glassBrightness);

  // 获取内嵌块样式配置（同样受亮度影响）
  const nestedBgAlpha = Math.min(1, NESTED_BLOCK_STYLES.bgAlpha[config.opacity] * glassBrightness);
  const nestedBorderAlpha = Math.min(1, NESTED_BLOCK_STYLES.borderAlpha[config.opacity] * glassBrightness);
  const listItemBgAlpha = Math.min(1, NESTED_BLOCK_STYLES.listItemBgAlpha[config.opacity] * glassBrightness);
  const listItemBorderAlpha = Math.min(1, NESTED_BLOCK_STYLES.listItemBorderAlpha[config.opacity] * glassBrightness);
  const hoverBgAlpha = Math.min(1, NESTED_BLOCK_STYLES.hoverBgAlpha[config.opacity] * glassBrightness);

  return {
    // 背景色
    '--bg-base': depth.bgBase,
    '--bg-elevated': depth.bgElevated,
    '--bg-card': depth.bgCard,

    // 玻璃效果参数（受色深和透明度双重影响）
    '--glass-bg-start': `rgba(255, 255, 255, ${glassStartAlpha.toFixed(4)})`,
    '--glass-bg-end': `rgba(255, 255, 255, ${glassEndAlpha.toFixed(4)})`,
    '--glass-border': `rgba(255, 255, 255, ${glassBorderAlpha.toFixed(4)})`,

    // 边框（受色深和透明度双重影响）
    '--border-subtle': `rgba(255, 255, 255, ${(0.12 * borderMultiplier * glassBrightness).toFixed(4)})`,
    '--border-default': `rgba(255, 255, 255, ${(0.18 * borderMultiplier * glassBrightness).toFixed(4)})`,
    '--border-hover': `rgba(255, 255, 255, ${(0.24 * borderMultiplier * glassBrightness).toFixed(4)})`,
    '--border-faint': `rgba(255, 255, 255, ${(0.08 * borderMultiplier * glassBrightness).toFixed(4)})`,

    // 内嵌块样式（用于页面内的子容器）
    '--nested-block-bg': `rgba(255, 255, 255, ${nestedBgAlpha})`,
    '--nested-block-border': `rgba(255, 255, 255, ${nestedBorderAlpha})`,
    '--list-item-bg': `rgba(255, 255, 255, ${listItemBgAlpha})`,
    '--list-item-border': `rgba(255, 255, 255, ${listItemBorderAlpha})`,
    '--list-item-hover-bg': `rgba(255, 255, 255, ${hoverBgAlpha})`,

    // 表格样式
    '--table-header-bg': `rgba(255, 255, 255, ${listItemBgAlpha})`,
    '--table-row-border': `rgba(255, 255, 255, ${nestedBorderAlpha})`,
    '--table-row-hover-bg': `rgba(255, 255, 255, ${hoverBgAlpha * 0.5})`,
  };
}

/**
 * 获取当前 CSS 变量值（用于 JS 中动态读取）
 */
export function getCSSVar(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

/**
 * 将 hex 颜色转换为 rgba
 */
/**
 * 将 hex 颜色转换为 rgba。支持 #RRGGBB / #RGB 简写；非法输入回退 TikTok 粉品牌色。
 */
export function hexToRgba(hex: string, alpha: number): string {
  if (!hex) return `rgba(255,0,80,${alpha})`;
  let h = hex.trim().replace('#', '');
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  if (h.length !== 6 || !/^[0-9a-fA-F]{6}$/.test(h)) return `rgba(255,0,80,${alpha})`;
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}
