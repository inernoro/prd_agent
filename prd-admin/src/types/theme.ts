/**
 * 主题/皮肤系统类型定义
 */

/** 色深预设级别 */
export type ColorDepthLevel = 'darker' | 'default' | 'lighter';

/** 透明度预设级别 */
export type OpacityLevel = 'solid' | 'default' | 'translucent';

/** 侧边栏玻璃效果模式 */
export type SidebarGlassMode = 'auto' | 'always' | 'never';

/** 性能模式 */
export type PerformanceMode = 'auto' | 'quality' | 'performance';

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

  /** 性能模式：auto 自动检测平台, quality 始终高质量, performance 始终性能优先 */
  performanceMode: PerformanceMode;
}

/** 默认主题配置 */
export const DEFAULT_THEME_CONFIG: ThemeConfig = {
  version: 1,
  colorDepth: 'default',
  opacity: 'default',
  enableGlow: true,
  sidebarGlass: 'always',
  performanceMode: 'performance',
};

/**
 * 内嵌 div 块样式配置（用于页面内的子容器）
 * 基于主题配置动态计算
 */
export const NESTED_BLOCK_STYLES = {
  /** 内嵌块背景透明度 */
  bgAlpha: {
    solid: 0.04,
    default: 0.02,
    translucent: 0.015,
  },
  /** 内嵌块边框透明度 */
  borderAlpha: {
    solid: 0.08,
    default: 0.06,
    translucent: 0.04,
  },
  /** 列表项背景透明度 */
  listItemBgAlpha: {
    solid: 0.05,
    default: 0.03,
    translucent: 0.02,
  },
  /** 列表项边框透明度 */
  listItemBorderAlpha: {
    solid: 0.08,
    default: 0.06,
    translucent: 0.04,
  },
  /** hover 状态背景透明度 */
  hoverBgAlpha: {
    solid: 0.1,
    default: 0.06,
    translucent: 0.04,
  },
} as const;

/**
 * 强调色样式配置（用于不同状态的色块）
 */
export const ACCENT_STYLES = {
  /** 蓝色强调 */
  blue: {
    bg: 'rgba(59, 130, 246, 0.04)',
    border: 'rgba(59, 130, 246, 0.1)',
    text: 'rgba(59, 130, 246, 0.95)',
  },
  /** 绿色强调 */
  green: {
    bg: 'rgba(34, 197, 94, 0.04)',
    border: 'rgba(34, 197, 94, 0.1)',
    text: 'rgba(34, 197, 94, 0.95)',
  },
  /** 金色强调 */
  gold: {
    bg: 'rgba(99, 102, 241, 0.04)',
    border: 'rgba(99, 102, 241, 0.1)',
    text: 'rgba(99, 102, 241, 0.95)',
  },
  /** 紫色强调 */
  purple: {
    bg: 'rgba(168, 85, 247, 0.04)',
    border: 'rgba(168, 85, 247, 0.1)',
    text: 'rgba(168, 85, 247, 0.95)',
  },
  /** 红色强调（危险操作） */
  red: {
    bg: 'rgba(239, 68, 68, 0.04)',
    border: 'rgba(239, 68, 68, 0.12)',
    text: 'rgba(239, 68, 68, 0.95)',
  },
} as const;

/**
 * 色深配置映射
 */
export const COLOR_DEPTH_MAP: Record<
  ColorDepthLevel,
  {
    bgBase: string;
    bgElevated: string;
    bgCard: string;
    /** 玻璃效果亮度倍数（影响玻璃的白色透明度） */
    glassBrightness: number;
    label: string;
  }
> = {
  darker: {
    bgBase: '#050507',
    bgElevated: '#0a0a0c',
    bgCard: 'rgba(255, 255, 255, 0.02)',
    glassBrightness: 0.7, // 深色：玻璃更暗
    label: '深色',
  },
  default: {
    bgBase: '#0b0b0d',
    bgElevated: '#121216',
    bgCard: 'rgba(255, 255, 255, 0.03)',
    glassBrightness: 1.0, // 默认
    label: '默认',
  },
  lighter: {
    bgBase: '#121216',
    bgElevated: '#1a1a1e',
    bgCard: 'rgba(255, 255, 255, 0.04)',
    glassBrightness: 1.4, // 浅色：玻璃更亮
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
/**
 * 性能模式选项
 */
export const PERFORMANCE_MODE_OPTIONS: Array<{
  value: PerformanceMode;
  label: string;
  description: string;
}> = [
  { value: 'auto', label: '自动', description: 'Windows 自动降低特效，macOS/Linux 保持高质量' },
  { value: 'quality', label: '高质量', description: '始终使用完整液态玻璃特效（可能影响性能）' },
  { value: 'performance', label: '性能优先', description: '降低模糊与特效强度，提升响应速度' },
];

export const SIDEBAR_GLASS_OPTIONS: Array<{
  value: SidebarGlassMode;
  label: string;
  description: string;
}> = [
  { value: 'always', label: '始终启用', description: '所有页面都使用液态玻璃效果' },
  { value: 'auto', label: '自动', description: '仅在实验室等页面启用' },
  { value: 'never', label: '禁用', description: '使用传统深色侧边栏' },
];
