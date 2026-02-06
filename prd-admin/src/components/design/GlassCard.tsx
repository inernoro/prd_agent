import { cn } from '@/lib/cn';
import React from 'react';

export type GlassCardVariant = 'default' | 'gold' | 'frost' | 'subtle';

export interface GlassCardProps {
  className?: string;
  children: React.ReactNode;
  /**
   * 预设变体：
   * - default: 标准液态玻璃
   * - gold: 金色光晕
   * - frost: 更强的磨砂效果
   * - subtle: 更轻微的玻璃效果
   */
  variant?: GlassCardVariant;
  /** 自定义强调色（HSL 色相值 0-360，例如 210 是蓝色，30 是橙色） */
  accentHue?: number;
  /** 是否显示顶部光晕 */
  glow?: boolean;
  /** 自定义 padding（默认 p-4） */
  padding?: 'none' | 'sm' | 'md' | 'lg';
  /** 是否可交互（hover 效果） */
  interactive?: boolean;
  /** 点击事件 */
  onClick?: React.MouseEventHandler<HTMLDivElement>;
  /** 自定义样式 */
  style?: React.CSSProperties;
  /** 是否隐藏溢出内容（默认 false，不裁剪内容） */
  overflow?: 'hidden' | 'visible' | 'auto';
}

/**
 * GlassCard - 液态玻璃效果容器
 *
 * macOS 26 风格的液态玻璃效果，支持：
 * - 多种预设变体
 * - 自定义强调色
 * - 顶部光晕效果
 * - 交互动效
 *
 * 渲染架构：采用双层渲染——backdrop-filter 隔离到内部 overflow:hidden 子层，
 * 避免各浏览器 backdrop-filter + border-radius 合成时的边缘溢出与闪烁。
 */
export function GlassCard({
  className,
  children,
  variant = 'default',
  accentHue,
  glow = false,
  padding = 'md',
  interactive = false,
  onClick,
  style,
  overflow = 'visible',
}: GlassCardProps) {
  // 基础模糊参数
  const blurValues = {
    default: 'blur(40px) saturate(180%) brightness(1.1)',
    gold: 'blur(40px) saturate(200%) brightness(1.15)',
    frost: 'blur(60px) saturate(220%) brightness(1.12)',
    subtle: 'blur(24px) saturate(160%) brightness(1.05)',
  };

  // 边框透明度系数（相对于全局变量的倍数）
  const borderMultiplier = {
    default: 1,
    gold: 1.3,
    frost: 1.4,
    subtle: 0.7,
  };

  const blur = blurValues[variant];
  const borderMult = borderMultiplier[variant];

  // 计算光晕颜色 - 增强可见度的光晕效果
  let glowColor = 'rgba(255, 255, 255, 0.05)';
  if (glow) {
    if (variant === 'gold') {
      glowColor = 'rgba(214, 178, 106, 0.25)'; // 金色光晕，更明显
    } else if (accentHue !== undefined) {
      // 使用自定义色相，透明度提高到 0.2
      glowColor = `hsla(${accentHue}, 70%, 65%, 0.2)`;
    } else {
      glowColor = 'rgba(255, 255, 255, 0.15)'; // 白色光晕
    }
  }

  // 构建玻璃背景渐变（渲染在 backdrop 隔离层上）
  let background = `linear-gradient(180deg, var(--glass-bg-start, rgba(255, 255, 255, 0.08)) 0%, var(--glass-bg-end, rgba(255, 255, 255, 0.03)) 100%)`;

  if (glow) {
    // 更明显的光晕：椭圆更大、渐变更柔和
    background = `
      radial-gradient(ellipse 100% 50% at 50% -5%, ${glowColor} 0%, transparent 60%),
      ${background}
    `;
  }

  // 阴影层次 - 增强立体感
  const shadowLayers = [
    '0 8px 32px -4px rgba(0, 0, 0, 0.35)',
    '0 4px 16px -2px rgba(0, 0, 0, 0.25)',
    `0 0 0 1px rgba(255, 255, 255, ${0.14 * borderMult * 0.6}) inset`,
    '0 1px 0 0 rgba(255, 255, 255, 0.15) inset',
    '0 -1px 0 0 rgba(0, 0, 0, 0.12) inset',
  ];

  if (variant === 'gold') {
    shadowLayers.push('0 6px 32px -8px rgba(214, 178, 106, 0.3)');
  } else if (accentHue !== undefined) {
    shadowLayers.push(`0 6px 32px -8px hsla(${accentHue}, 75%, 55%, 0.25)`);
  }

  // 容器样式 — 仅保留边框、阴影和合成层控制，不含 background / backdropFilter
  const containerStyle: React.CSSProperties = {
    border: `1px solid var(--glass-border, rgba(255, 255, 255, ${0.14 * borderMult}))`,
    boxShadow: shadowLayers.join(', '),
    // 强制创建持久的 GPU 合成层，避免状态变化时频繁创建/销毁合成层导致闪烁
    transform: 'translateZ(0)',
    willChange: 'transform',
    // 创建独立的堆叠上下文，使 backdrop 层的 zIndex:-1 仅在此上下文内生效
    isolation: 'isolate',
    backfaceVisibility: 'hidden',
    ...style,
  };

  // padding 映射
  const paddingClass = {
    none: '',
    sm: 'p-3',
    md: 'p-4',
    lg: 'p-6',
  };

  // overflow 映射
  const overflowClass = {
    hidden: 'overflow-hidden',
    visible: 'overflow-visible',
    auto: 'overflow-auto',
  };

  return (
    <div
      className={cn(
        'rounded-[16px] transition-all duration-200 relative no-focus-ring',
        overflowClass[overflow],
        paddingClass[padding],
        interactive && 'cursor-pointer hover:scale-[1.01] active:scale-[0.99]',
        className
      )}
      style={containerStyle}
      onClick={onClick}
      tabIndex={interactive ? 0 : undefined}
    >
      {/* backdrop-filter 隔离层：独立 overflow:hidden 将模糊效果裁剪到圆角内，
          规避各浏览器 backdrop-filter + border-radius 合成时的边缘溢出问题 */}
      <div
        aria-hidden="true"
        style={{
          position: 'absolute',
          inset: 0,
          borderRadius: 'inherit',
          overflow: 'hidden',
          backdropFilter: blur,
          WebkitBackdropFilter: blur,
          background,
          pointerEvents: 'none',
          backfaceVisibility: 'hidden',
          zIndex: -1,
        }}
      />
      {children}
    </div>
  );
}
