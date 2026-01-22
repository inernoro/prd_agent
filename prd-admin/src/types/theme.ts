/**
 * 主题/皮肤系统类型定义
 */

/** 色深预设级别 */
export type ColorDepthLevel = 'darker' | 'default' | 'lighter';

/** 透明度预设级别 */
export type OpacityLevel = 'solid' | 'default' | 'translucent';

/** 侧边栏玻璃效果模式 */
export type SidebarGlassMode = 'auto' | 'always' | 'never';

/**
 * 完整皮肤配置
 */
export interface ThemeConfig {
  /** 版本号，用于数据迁移 */
  version: number;

  /** 色深级别 */
  colorDepth: ColorDepthLevel;

  /** 透明度级别 */
  opacity: OpacityLevel;

  /** 是否启用全局 glow 效果 */
  enableGlow: boolean;

  /** 侧边栏玻璃效果模式 */
  sidebarGlass: SidebarGlassMode;
}

/** 默认主题配置 */
export const DEFAULT_THEME_CONFIG: ThemeConfig = {
  version: 1,
  colorDepth: 'default',
  opacity: 'default',
  enableGlow: true,
  sidebarGlass: 'always',
};

/**
 * 色深配置映射
 */
export const COLOR_DEPTH_MAP: Record<
  ColorDepthLevel,
  {
    bgBase: string;
    bgElevated: string;
    bgCard: string;
    label: string;
  }
> = {
  darker: {
    bgBase: '#050507',
    bgElevated: '#0a0a0c',
    bgCard: 'rgba(255, 255, 255, 0.02)',
    label: '深色',
  },
  default: {
    bgBase: '#0b0b0d',
    bgElevated: '#121216',
    bgCard: 'rgba(255, 255, 255, 0.03)',
    label: '默认',
  },
  lighter: {
    bgBase: '#121216',
    bgElevated: '#1a1a1e',
    bgCard: 'rgba(255, 255, 255, 0.04)',
    label: '浅色',
  },
};

/**
 * 透明度配置映射
 */
export const OPACITY_MAP: Record<
  OpacityLevel,
  {
    glassStart: number;
    glassEnd: number;
    border: number;
    label: string;
  }
> = {
  solid: {
    glassStart: 0.12,
    glassEnd: 0.06,
    border: 0.18,
    label: '不透明',
  },
  default: {
    glassStart: 0.08,
    glassEnd: 0.03,
    border: 0.14,
    label: '默认',
  },
  translucent: {
    glassStart: 0.04,
    glassEnd: 0.015,
    border: 0.10,
    label: '半透明',
  },
};

/**
 * 侧边栏玻璃效果选项
 */
export const SIDEBAR_GLASS_OPTIONS: Array<{
  value: SidebarGlassMode;
  label: string;
  description: string;
}> = [
  { value: 'always', label: '始终启用', description: '所有页面都使用液态玻璃效果' },
  { value: 'auto', label: '自动', description: '仅在实验室等页面启用' },
  { value: 'never', label: '禁用', description: '使用传统深色侧边栏' },
];
