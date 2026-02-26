import { cn } from '@/lib/cn';
import React, { useMemo, useRef, useEffect, useState } from 'react';
import { shouldReduceEffects } from '@/lib/themeApplier';
import { useThemeStore } from '@/stores/themeStore';

export type GlassCardVariant = 'default' | 'gold' | 'frost' | 'subtle';

export interface GlassCardProps {
  className?: string;
  children: React.ReactNode;
  /**
   * 预设变体：
   * - default: 标准液态玻璃 / Obsidian 暗色表面
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
  /**
   * 是否启用入场动画（进入视口时 fade-in + 上移）
   * 性能模式下自动禁用
   */
  animated?: boolean;
  /** 入场动画延迟（毫秒），用于同一区域多卡片错开 */
  animationDelay?: number;
}

/**
 * GlassCard - 液态玻璃 / Obsidian 暗色容器
 *
 * 双模式渲染：
 * - 质量模式：macOS 26 风格液态玻璃（backdrop-filter blur）
 * - 性能模式：Obsidian 实底暗色表面（无 blur，clean shadows）
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
  animated = false,
  animationDelay = 0,
}: GlassCardProps) {
  const perfMode = useThemeStore((s) => s.config.performanceMode);
  const isPerf = shouldReduceEffects({ performanceMode: perfMode } as Parameters<typeof shouldReduceEffects>[0]);

  // ── 入场动画：IntersectionObserver + CSS transition ──
  const ref = useRef<HTMLDivElement>(null);
  const [isVisible, setIsVisible] = useState(!animated || isPerf);

  useEffect(() => {
    if (!animated || isPerf || !ref.current) return;
    const el = ref.current;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setIsVisible(true);
          observer.unobserve(el);
        }
      },
      { threshold: 0.08 },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [animated, isPerf]);

  // 使用 useMemo 缓存样式计算
  const cardStyle = useMemo((): React.CSSProperties => {
    // ── 性能模式：Obsidian 实底暗色表面 ──
    if (isPerf) {
      return buildObsidianStyle(variant, accentHue, glow, style);
    }
    // ── 质量模式：液态玻璃 ──
    return buildGlassStyle(variant, accentHue, glow, style);
  }, [variant, accentHue, glow, isPerf, style]);

  // 入场动画样式
  const animatedStyle: React.CSSProperties = animated && !isPerf
    ? {
        ...cardStyle,
        opacity: isVisible ? 1 : 0,
        transform: isVisible ? (cardStyle.transform || 'none') : `translateY(24px) ${cardStyle.transform || ''}`.trim(),
        transition: `opacity 0.5s cubic-bezier(0.25, 0.1, 0.25, 1) ${animationDelay}ms, transform 0.5s cubic-bezier(0.25, 0.1, 0.25, 1) ${animationDelay}ms, border-color 0.2s, box-shadow 0.2s`,
      }
    : cardStyle;

  const paddingClass = { none: '', sm: 'p-3', md: 'p-4', lg: 'p-6' };
  const overflowClass = { hidden: 'overflow-hidden', visible: 'overflow-visible', auto: 'overflow-auto' };

  return (
    <div
      ref={ref}
      className={cn(
        'rounded-[16px] relative no-focus-ring',
        !animated && 'transition-[border-color,box-shadow,opacity] duration-200',
        overflowClass[overflow],
        paddingClass[padding],
        interactive && 'cursor-pointer',
        className
      )}
      style={animatedStyle}
      onClick={onClick}
      tabIndex={interactive ? 0 : undefined}
    >
      {children}
    </div>
  );
}

// ── Obsidian 实底暗色风格（性能模式）──

function buildObsidianStyle(
  variant: GlassCardVariant,
  accentHue: number | undefined,
  glow: boolean,
  extra?: React.CSSProperties,
): React.CSSProperties {
  // 背景：使用 CSS 变量（已在 themeComputed 中切换为实底值）
  let background = `linear-gradient(180deg, var(--glass-bg-start) 0%, var(--glass-bg-end) 100%)`;

  // 顶部微光：用 linear-gradient 模拟顶边高光，不用 blur
  const topHighlight = 'linear-gradient(180deg, rgba(255, 255, 255, 0.04) 0%, transparent 40%)';
  background = `${topHighlight}, ${background}`;

  // 光晕效果（radial-gradient，GPU-friendly，不需要 backdrop-filter）
  if (glow) {
    let glowColor = 'rgba(255, 255, 255, 0.08)';
    if (variant === 'gold') {
      glowColor = 'rgba(99, 102, 241, 0.18)';
    } else if (accentHue !== undefined) {
      glowColor = `hsla(${accentHue}, 60%, 60%, 0.14)`;
    }
    background = `radial-gradient(ellipse 100% 50% at 50% -5%, ${glowColor} 0%, transparent 55%), ${background}`;
  }

  // 边框：顶部略亮，模拟光照
  const borderColor = variant === 'gold'
    ? 'rgba(99, 102, 241, 0.18)'
    : 'var(--glass-border, rgba(255, 255, 255, 0.07))';

  // 阴影：干净的单层投影 + 顶部内高光
  let boxShadow = '0 2px 12px -2px rgba(0, 0, 0, 0.4), 0 1px 0 0 rgba(255, 255, 255, 0.04) inset';
  if (variant === 'gold') {
    boxShadow = '0 2px 16px -4px rgba(99, 102, 241, 0.15), 0 2px 12px -2px rgba(0, 0, 0, 0.4), 0 1px 0 0 rgba(99, 102, 241, 0.08) inset';
  } else if (accentHue !== undefined) {
    boxShadow = `0 2px 16px -4px hsla(${accentHue}, 60%, 50%, 0.12), 0 2px 12px -2px rgba(0, 0, 0, 0.4), 0 1px 0 0 rgba(255, 255, 255, 0.04) inset`;
  }

  return {
    background,
    border: `1px solid ${borderColor}`,
    boxShadow,
    isolation: 'isolate' as const,
    ...extra,
  };
}

// ── 液态玻璃风格（质量模式）──

function buildGlassStyle(
  variant: GlassCardVariant,
  accentHue: number | undefined,
  glow: boolean,
  extra?: React.CSSProperties,
): React.CSSProperties {
  const blurValues = {
    default: 'blur(40px) saturate(180%) brightness(1.1)',
    gold: 'blur(40px) saturate(200%) brightness(1.15)',
    frost: 'blur(60px) saturate(220%) brightness(1.12)',
    subtle: 'blur(24px) saturate(160%) brightness(1.05)',
  };

  const borderMultiplier = { default: 1, gold: 1.3, frost: 1.4, subtle: 0.7 };

  let glowColor = 'rgba(255, 255, 255, 0.05)';
  if (glow) {
    if (variant === 'gold') {
      glowColor = 'rgba(99, 102, 241, 0.25)';
    } else if (accentHue !== undefined) {
      glowColor = `hsla(${accentHue}, 70%, 65%, 0.2)`;
    } else {
      glowColor = 'rgba(255, 255, 255, 0.15)';
    }
  }

  const blur = blurValues[variant];
  const borderMult = borderMultiplier[variant];

  let background = `linear-gradient(180deg, var(--glass-bg-start, rgba(255, 255, 255, 0.08)) 0%, var(--glass-bg-end, rgba(255, 255, 255, 0.03)) 100%)`;

  if (glow) {
    background = `
      radial-gradient(ellipse 100% 50% at 50% -5%, ${glowColor} 0%, transparent 60%),
      ${background}
    `;
  }

  const shadowLayers = [
    '0 8px 32px -4px rgba(0, 0, 0, 0.35)',
    '0 4px 16px -2px rgba(0, 0, 0, 0.25)',
    `0 0 0 1px rgba(255, 255, 255, ${0.14 * borderMult * 0.6}) inset`,
    '0 1px 0 0 rgba(255, 255, 255, 0.15) inset',
    '0 -1px 0 0 rgba(0, 0, 0, 0.12) inset',
  ];
  if (variant === 'gold') {
    shadowLayers.push('0 6px 32px -8px rgba(99, 102, 241, 0.3)');
  } else if (accentHue !== undefined) {
    shadowLayers.push(`0 6px 32px -8px hsla(${accentHue}, 75%, 55%, 0.25)`);
  }

  return {
    background,
    border: `1px solid var(--glass-border, rgba(255, 255, 255, ${0.14 * borderMult}))`,
    backdropFilter: blur,
    WebkitBackdropFilter: blur,
    boxShadow: shadowLayers.join(', '),
    transform: 'translateZ(0)',
    willChange: 'transform' as const,
    isolation: 'isolate' as const,
    ...extra,
  };
}
