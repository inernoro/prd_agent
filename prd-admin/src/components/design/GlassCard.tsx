import { cn } from '@/lib/cn';
import React from 'react';
import { glassContainerStyle } from './GlassBackdrop';

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
  /** 溢出行为（默认 hidden，裁剪 backdrop-filter 到圆角区域内防止边缘渲染异常） */
  overflow?: 'hidden' | 'visible' | 'auto';
}

/**
 * GlassCard - 液态玻璃效果容器
 *
 * Apple Liquid Glass 风格，核心视觉要素：
 * 1. 高 brightness 增益 backdrop-filter — 在深色背景上放大模糊内容可见度
 * 2. 顶部高光弧线 (specular highlight) — 模拟光打在曲面玻璃上的反射
 * 3. 多层 inset shadow — 模拟玻璃厚度与边缘折射
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
  overflow = 'hidden',
}: GlassCardProps) {
  const getGlassStyle = (): React.CSSProperties => {
    // backdrop-filter — brightness 大幅提升以在深色背景上显现模糊质感
    const blurValues = {
      default: 'blur(40px) saturate(180%) brightness(1.4)',
      gold: 'blur(40px) saturate(200%) brightness(1.45)',
      frost: 'blur(60px) saturate(220%) brightness(1.5)',
      subtle: 'blur(24px) saturate(160%) brightness(1.2)',
    };

    const borderMultiplier = {
      default: 1,
      gold: 1.3,
      frost: 1.4,
      subtle: 0.7,
    };

    // 光晕颜色
    let glowColor = 'rgba(255, 255, 255, 0.05)';
    if (glow) {
      if (variant === 'gold') {
        glowColor = 'rgba(214, 178, 106, 0.25)';
      } else if (accentHue !== undefined) {
        glowColor = `hsla(${accentHue}, 70%, 65%, 0.2)`;
      } else {
        glowColor = 'rgba(255, 255, 255, 0.15)';
      }
    }

    const blur = blurValues[variant];
    const borderMult = borderMultiplier[variant];

    // --- Apple-style specular highlight (顶部高光弧线) ---
    // 薄亮条从顶部 0%→3% 快速衰减，模拟曲面玻璃反射
    const specular =
      'linear-gradient(180deg, rgba(255, 255, 255, 0.18) 0%, rgba(255, 255, 255, 0.04) 3%, transparent 45%)';

    // 玻璃本体渐变（使用主题系统 CSS 变量）
    const glassBody = `linear-gradient(180deg, var(--glass-bg-start, rgba(255, 255, 255, 0.10)) 0%, var(--glass-bg-end, rgba(255, 255, 255, 0.05)) 100%)`;

    // 组合背景层
    let background = `${specular}, ${glassBody}`;

    if (glow) {
      const glowGradient = `radial-gradient(ellipse 100% 50% at 50% -5%, ${glowColor} 0%, transparent 60%)`;
      background = `${glowGradient}, ${background}`;
    }

    // 阴影层次 — 增强浮起感与玻璃厚度
    const shadowLayers = [
      // 外阴影：浮起深度
      '0 8px 32px -4px rgba(0, 0, 0, 0.4)',
      '0 4px 16px -2px rgba(0, 0, 0, 0.3)',
      // 内边框光：模拟玻璃边缘折射
      `0 0 0 1px rgba(255, 255, 255, ${0.14 * borderMult * 0.7}) inset`,
      // 顶部高光线：Apple 风格的顶端亮线
      '0 1px 0 0 rgba(255, 255, 255, 0.28) inset',
      // 底部暗线：玻璃底面
      '0 -1px 0 0 rgba(0, 0, 0, 0.15) inset',
    ];

    if (variant === 'gold') {
      shadowLayers.push('0 6px 32px -8px rgba(214, 178, 106, 0.3)');
    } else if (accentHue !== undefined) {
      shadowLayers.push(`0 6px 32px -8px hsla(${accentHue}, 75%, 55%, 0.25)`);
    }

    return {
      ...glassContainerStyle(blur, background),
      border: `1px solid var(--glass-border, rgba(255, 255, 255, ${0.14 * borderMult}))`,
      boxShadow: shadowLayers.join(', '),
      ...style,
    };
  };

  const paddingClass = {
    none: '',
    sm: 'p-3',
    md: 'p-4',
    lg: 'p-6',
  };

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
      style={getGlassStyle()}
      onClick={onClick}
      tabIndex={interactive ? 0 : undefined}
    >
      {children}
    </div>
  );
}
