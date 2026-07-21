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
 * 界面材质（2026-07-16 系统级统一，用户定）：
 * - solid：素色实底面板（默认）。无 backdrop-filter、无棱光高光，安静克制。
 * - glass：液态玻璃。保留为可选材质，不删除。
 * 一处切换全站生效：所有 .surface-* / GlassCard / 玻璃 token 消费方统一跟随，
 * 像苹果的 Material 一样集中调配，不必逐页更新。
 */
export type MaterialMode = 'solid' | 'glass';

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

  /**
   * 界面材质：solid 素色实底（默认）/ glass 液态玻璃。
   * 旧配置无此字段——所有消费处必须用 `config.material ?? DEFAULT_THEME_CONFIG.material` 兜底。
   */
  material?: MaterialMode;
}

/** 默认主题配置 */
export const DEFAULT_THEME_CONFIG: ThemeConfig = {
  version: 1,
  colorDepth: 'default',
  opacity: 'default',
  enableGlow: true,
  sidebarGlass: 'always',
  // 默认开液态玻璃（2026-06-16，用户定）：此前默认 'performance' 导致 GlassCard 全站走实底降级，
  // 液态玻璃从不渲染。改 'quality' 后未显式设置过性能模式的用户都将看到（已调优的 B 方案）玻璃。
  performanceMode: 'quality',
  // 默认素色（2026-07-16，用户定）：玻璃「浮肿」，素色实底成为系统的新默认气质；
  // 液态玻璃保留为可选材质（设置 → 皮肤设置 → 界面材质）。
  material: 'solid',
};

/** 界面材质选项（设置页用） */
export const MATERIAL_OPTIONS: Array<{
  value: MaterialMode;
  label: string;
  description: string;
}> = [
  { value: 'solid', label: '素色', description: '实底面板，安静克制，内容优先（推荐）' },
  { value: 'glass', label: '液态玻璃', description: '半透明模糊玻璃质感，视觉更华丽' },
];

/**
 * 强调色样式配置（用于不同状态的色块）
 */
export const ACCENT_STYLES = {
  /** 蓝色强调 */
  blue: {
    bg: 'rgba(59, 130, 246, 0.08)',
    border: 'rgba(59, 130, 246, 0.16)',
    text: 'rgba(59, 130, 246, 0.95)',
  },
  /** 绿色强调 */
  green: {
    bg: 'rgba(34, 197, 94, 0.08)',
    border: 'rgba(34, 197, 94, 0.16)',
    text: 'rgba(34, 197, 94, 0.95)',
  },
  /** 金色强调 */
  gold: {
    bg: 'rgba(99, 102, 241, 0.08)',
    border: 'rgba(99, 102, 241, 0.16)',
    text: 'rgba(99, 102, 241, 0.95)',
  },
  /** 紫色强调 */
  purple: {
    bg: 'rgba(168, 85, 247, 0.08)',
    border: 'rgba(168, 85, 247, 0.16)',
    text: 'rgba(168, 85, 247, 0.95)',
  },
  /** 红色强调（危险操作） */
  red: {
    bg: 'rgba(239, 68, 68, 0.08)',
    border: 'rgba(239, 68, 68, 0.18)',
    text: 'rgba(239, 68, 68, 0.95)',
  },
} as const;

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
