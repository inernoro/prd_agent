/**
 * 统一的面板/弹层玻璃样式预设
 *
 * 设计思路：
 * - 质量模式：液态玻璃 backdrop-filter blur，背景使用 CSS 变量中的半透明值
 * - 性能模式：globals.css 的 `html[data-perf-mode="performance"] *` 规则
 *   会用 !important 清除所有 backdrop-filter；themeComputed.ts 同时把
 *   --glass-bg-start / --glass-bg-end 切换为实底暗色值，因此引用 CSS 变量
 *   的组件自动得到 Obsidian 风格。
 *
 * 使用方式：
 *   import { glassPanel } from '@/lib/glassStyles';
 *   <div style={{ ...glassPanel, minWidth: 240 }}> ... </div>
 */

/**
 * 标准浮层面板（Dialog、ContextMenu、Select popup、ConfirmTip、Popover 等）
 * 大面积 blur(40px)，半透明渐变背景，精致阴影
 */
export const glassPanel: React.CSSProperties = {
  background:
    'linear-gradient(180deg, var(--glass-bg-start, rgba(255, 255, 255, 0.08)) 0%, var(--glass-bg-end, rgba(255, 255, 255, 0.03)) 100%)',
  border: '1px solid var(--glass-border, rgba(255, 255, 255, 0.14))',
  boxShadow:
    '0 18px 60px rgba(0,0,0,0.55), 0 0 0 1px rgba(255, 255, 255, 0.06) inset',
  backdropFilter: 'blur(40px) saturate(180%) brightness(1.1)',
  WebkitBackdropFilter: 'blur(40px) saturate(180%) brightness(1.1)',
};

/**
 * 横条面板（TabBar、PageHeader —— 较宽的条状容器）
 */
export const glassBar: React.CSSProperties = {
  background:
    'linear-gradient(180deg, var(--glass-bg-start, rgba(255, 255, 255, 0.06)) 0%, var(--glass-bg-end, rgba(255, 255, 255, 0.02)) 100%)',
  border: '1px solid var(--glass-border, rgba(255, 255, 255, 0.12))',
  backdropFilter: 'blur(40px) saturate(200%) brightness(1.1)',
  WebkitBackdropFilter: 'blur(40px) saturate(200%) brightness(1.1)',
  boxShadow:
    '0 8px 32px -4px rgba(0, 0, 0, 0.3), 0 0 0 1px rgba(255, 255, 255, 0.08) inset, 0 1px 0 0 rgba(255, 255, 255, 0.1) inset, 0 -1px 0 0 rgba(0, 0, 0, 0.08) inset',
};

/**
 * 金色变体横条（TabBar/PageHeader variant='gold'）
 */
export const glassBarGold: React.CSSProperties = {
  ...glassBar,
  background:
    'linear-gradient(180deg, var(--glass-bg-start, rgba(255, 255, 255, 0.08)) 0%, var(--glass-bg-end, rgba(255, 255, 255, 0.04)) 100%)',
  boxShadow:
    '0 8px 32px -4px rgba(0, 0, 0, 0.4), 0 0 0 1px rgba(255, 255, 255, 0.1) inset, 0 1px 0 0 rgba(255, 255, 255, 0.15) inset, 0 -1px 0 0 rgba(0, 0, 0, 0.1) inset',
};

/**
 * 侧边栏玻璃（AppShell 侧边栏启用玻璃模式时）
 */
export const glassSidebar: React.CSSProperties = {
  background:
    'linear-gradient(180deg, var(--glass-bg-start, rgba(255, 255, 255, 0.06)) 0%, var(--glass-bg-end, rgba(255, 255, 255, 0.02)) 100%)',
  border: '1px solid var(--glass-border, rgba(255, 255, 255, 0.12))',
  backdropFilter: 'blur(40px) saturate(200%) brightness(1.1)',
  WebkitBackdropFilter: 'blur(40px) saturate(200%) brightness(1.1)',
  boxShadow:
    '0 12px 48px -8px rgba(0, 0, 0, 0.5), 0 0 0 1px rgba(255, 255, 255, 0.15) inset, 0 2px 0 0 rgba(255, 255, 255, 0.2) inset, 0 -1px 0 0 rgba(0, 0, 0, 0.15) inset',
};

/**
 * Tooltip — 紧凑、高不透明度、小模糊
 */
export const glassTooltip: React.CSSProperties = {
  background: 'var(--glass-bg-end, rgba(20, 20, 24, 0.95))',
  border: '1px solid rgba(255,255,255,0.12)',
  boxShadow:
    '0 8px 32px rgba(0,0,0,0.6), 0 0 0 1px rgba(255, 255, 255, 0.08) inset',
  backdropFilter: 'blur(12px)',
  WebkitBackdropFilter: 'blur(12px)',
};

/**
 * 工具栏 — 紧凑高不透明度浮动面板（ImageQuickActionBar 等）
 */
export const glassToolbar: React.CSSProperties = {
  background: 'var(--glass-bg-end, rgba(32, 32, 38, 0.95))',
  border: '1px solid var(--glass-border, rgba(255, 255, 255, 0.14))',
  boxShadow:
    '0 8px 32px rgba(0,0,0,0.45), 0 0 0 1px rgba(255,255,255,0.06) inset',
  backdropFilter: 'blur(16px)',
  WebkitBackdropFilter: 'blur(16px)',
};

/**
 * 小弹层（ColorPicker 等小型 popover）
 */
export const glassPopoverCompact: React.CSSProperties = {
  background: 'var(--glass-bg-end, rgba(30, 30, 35, 0.95))',
  border: '1px solid rgba(255,255,255,0.1)',
  backdropFilter: 'blur(20px)',
  WebkitBackdropFilter: 'blur(20px)',
};

/**
 * 切换开关容器（GlassSwitch 外框）
 */
export const glassSwitchTrack: React.CSSProperties = {
  background: 'var(--nested-block-bg, rgba(255, 255, 255, 0.04))',
  border: '1px solid var(--glass-border, rgba(255, 255, 255, 0.1))',
  backdropFilter: 'blur(12px) saturate(150%)',
  WebkitBackdropFilter: 'blur(12px) saturate(150%)',
};

/**
 * 全屏遮罩（MaskPaintCanvas 等全屏遮罩层）
 */
export const glassOverlay: React.CSSProperties = {
  background: 'rgba(0,0,0,0.85)',
  backdropFilter: 'blur(8px)',
  WebkitBackdropFilter: 'blur(8px)',
};

/**
 * Tab 内嵌容器（PageHeader 中的 tab 按钮组）
 */
export const glassTabContainer: React.CSSProperties = {
  background: 'rgba(0, 0, 0, 0.32)',
  border: '1px solid var(--glass-border, rgba(255, 255, 255, 0.12))',
  boxShadow:
    '0 8px 20px rgba(0, 0, 0, 0.28), 0 1px 4px rgba(0, 0, 0, 0.20) inset',
  backdropFilter: 'blur(8px)',
  WebkitBackdropFilter: 'blur(8px)',
};

/**
 * Toast 通知（保留语义色彩背景，blur 辅助）
 */
export const glassToast = (bg: string, borderColor: string): React.CSSProperties => ({
  background: bg,
  border: `1px solid ${borderColor}`,
  backdropFilter: 'blur(12px)',
  WebkitBackdropFilter: 'blur(12px)',
});
