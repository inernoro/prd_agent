import { cn } from '@/lib/cn';
import React, { createContext, useContext, useMemo, useRef, useEffect, useState } from 'react';
import { shouldReduceEffects } from '@/lib/themeApplier';
import { useThemeStore } from '@/stores/themeStore';
import { useDataTheme } from '@/pages/report-agent/hooks/useDataTheme';
import { useIsMobile } from '@/hooks/useBreakpoint';

/**
 * 卡片嵌套深度上下文（手机端去 chrome 用）。
 * 顶层卡片 depth=0；任意 GlassCard 给子树提供 depth+1。
 * 手机端 depth>0（卡套卡）时收紧内边距 + 缩小圆角 + 去重阴影，消除「卡中卡」框线浪费，
 * 桌面端完全不受影响。见 .claude/rules/mobile-first-density.md。
 */
const GlassCardDepthContext = createContext(0);

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
   * 手机端满铺：isMobile 时让这张顶层卡片也去掉边框/圆角/底色/投影（透明满铺到边），
   * 内容直接坐在页面底色上，营造手机原生「无卡框」观感。嵌套卡片(depth>0)手机端已自动满铺，无需传此参。
   */
  mobileFlush?: boolean;
  /**
   * 是否启用入场动画（进入视口时 fade-in + 上移）
   * 性能模式下自动禁用
   */
  animated?: boolean;
  /** 入场动画延迟（毫秒），用于同一区域多卡片错开 */
  animationDelay?: number;
  /** 是否可被拖拽（HTML5 DnD，已不推荐，新代码用 onPointerDown + useDockDrag） */
  draggable?: boolean;
  /** 拖拽开始回调 */
  onDragStart?: React.DragEventHandler<HTMLDivElement>;
  /** 拖拽结束回调 */
  onDragEnd?: React.DragEventHandler<HTMLDivElement>;
  /** Pointer down 回调（Pointer Events 自定义拖拽，见 useDockDrag） */
  onPointerDown?: React.PointerEventHandler<HTMLDivElement>;
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
  mobileFlush = false,
  animated = false,
  animationDelay = 0,
  draggable,
  onDragStart,
  onDragEnd,
  onPointerDown,
}: GlassCardProps) {
  const perfMode = useThemeStore((s) => s.config.performanceMode);
  const material = useThemeStore((s) => s.config.material ?? 'solid');
  const isPerf = shouldReduceEffects({ performanceMode: perfMode } as Parameters<typeof shouldReduceEffects>[0]);
  // 表面材质 100% 跟随用户选择（2026-07-17 修正：性能模式不再劫持材质，只管动画）
  const solidSurface = material === 'solid';
  const dataTheme = useDataTheme();
  const isLight = dataTheme === 'light';

  // 手机端密度：嵌套卡片(depth>0) 或显式 mobileFlush 的顶层卡，手机端去 chrome 满铺（桌面端零影响）
  const depth = useContext(GlassCardDepthContext);
  const isMobile = useIsMobile();
  const flush = isMobile && (depth > 0 || mobileFlush);

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
    // ── 素色材质 / 性能模式：Obsidian 实底暗色表面 ──
    if (solidSurface) {
      return buildObsidianStyle(variant, accentHue, glow, isLight, style);
    }
    // ── 液态玻璃材质 ──
    return buildGlassStyle(variant, accentHue, glow, isLight, style);
  }, [variant, accentHue, glow, solidSurface, isLight, style]);

  // 入场动画样式
  const animatedStyle: React.CSSProperties = animated && !isPerf
    ? {
        ...cardStyle,
        opacity: isVisible ? 1 : 0,
        transform: isVisible ? (cardStyle.transform || 'none') : `translateY(24px) ${cardStyle.transform || ''}`.trim(),
        transition: `opacity 0.5s cubic-bezier(0.25, 0.1, 0.25, 1) ${animationDelay}ms, transform 0.5s cubic-bezier(0.25, 0.1, 0.25, 1) ${animationDelay}ms, border-color 0.2s, box-shadow 0.2s`,
      }
    : cardStyle;

  // 内边距：桌面保持原值；手机端整体收紧一档；嵌套满铺卡再收紧一档；
  // 顶层 mobileFlush 卡手机端直接 p-0（满铺到边，交给内容自己控制间距）
  const topFlush = isMobile && mobileFlush;
  const paddingClass = topFlush
    ? ''
    : (
        flush
          ? { none: '', sm: 'p-2', md: 'p-2.5', lg: 'p-3' }
          : isMobile
            ? { none: '', sm: 'p-2.5', md: 'p-3', lg: 'p-4' }
            : { none: '', sm: 'p-3', md: 'p-4', lg: 'p-6' }
      )[padding];
  const overflowClass = { hidden: 'overflow-hidden', visible: 'overflow-visible', auto: 'overflow-auto' };
  // 满铺卡手机端缩小圆角，弱化「卡中卡」框感
  const radiusClass = flush ? 'rounded-[10px]' : 'rounded-[16px]';
  // 满铺卡手机端去掉底色/边框/投影，内容直接坐在页面底色上（手机原生无卡框观感）
  const finalStyle: React.CSSProperties = flush
    ? { ...animatedStyle, background: 'transparent', border: 'none', boxShadow: 'none' }
    : animatedStyle;

  return (
    <GlassCardDepthContext.Provider value={depth + 1}>
      <div
        ref={ref}
        className={cn(
          radiusClass,
          'relative no-focus-ring',
          !solidSurface && !flush && 'glass-blur-pseudo',
          !animated && 'transition-[border-color,box-shadow,opacity] duration-200',
          overflowClass[overflow],
          paddingClass,
          interactive && 'cursor-pointer glass-card-interactive',
          className
        )}
        style={finalStyle}
        onClick={onClick}
        tabIndex={interactive ? 0 : undefined}
        draggable={draggable}
        onDragStart={onDragStart}
        onDragEnd={onDragEnd}
        onPointerDown={onPointerDown}
      >
        {children}
      </div>
    </GlassCardDepthContext.Provider>
  );
}

// ── Obsidian 实底暗色风格（性能模式）──

function buildObsidianStyle(
  variant: GlassCardVariant,
  accentHue: number | undefined,
  glow: boolean,
  isLight: boolean,
  extra?: React.CSSProperties,
): React.CSSProperties {
  // 背景：使用 CSS 变量（已在 tokens.css 的材质契约中切换为纯平实底值）。
  // 2026-07-16 现代化重做：去掉白色顶部镜面高光——那是「塑料亚克力感」的来源；
  // 素色的层级只靠 细描边 + 底色阶梯 表达（Linear/Vercel 式扁平）。
  // gold / accentHue 变体保留一层极轻的色彩顶部氛围（身份色，不是镜面反光）。
  let background = `linear-gradient(180deg, var(--glass-bg-start) 0%, var(--glass-bg-end) 100%)`;
  if (variant === 'gold') {
    background = `linear-gradient(180deg, rgba(99, 102, 241, 0.05) 0%, transparent 55%), ${background}`;
  } else if (accentHue !== undefined) {
    background = `linear-gradient(180deg, hsla(${accentHue}, 50%, 60%, 0.04) 0%, transparent 55%), ${background}`;
  }

  // 光晕效果（radial-gradient，GPU-friendly，不需要 backdrop-filter）
  if (glow) {
    let glowColor = 'rgba(255, 255, 255, 0.10)';
    if (variant === 'gold') {
      glowColor = 'rgba(99, 102, 241, 0.20)';
    } else if (accentHue !== undefined) {
      glowColor = `hsla(${accentHue}, 60%, 60%, 0.16)`;
    }
    background = `radial-gradient(ellipse 100% 50% at 50% -5%, ${glowColor} 0%, transparent 55%), ${background}`;
  }

  // 边框：顶部略亮，模拟光照
  const borderColor = variant === 'gold'
    ? 'rgba(99, 102, 241, 0.22)'
    : accentHue !== undefined
      ? `hsla(${accentHue}, 50%, 60%, 0.15)`
      : 'var(--glass-border, rgba(255, 255, 255, 0.09))';

  // 阴影：静息态近乎无影（现代扁平——分离靠描边），仅一条发丝级落影防止表面与底色粘连；
  // gold/accent 变体多一层极轻的彩色氛围，浮层类阴影由 surface-popover 等自己负责
  let boxShadow = '0 1px 2px rgba(0, 0, 0, 0.22)';
  if (variant === 'gold') {
    boxShadow = '0 8px 24px -12px rgba(99, 102, 241, 0.12), 0 1px 2px rgba(0, 0, 0, 0.22)';
  } else if (accentHue !== undefined) {
    boxShadow = `0 8px 24px -12px hsla(${accentHue}, 60%, 50%, 0.10), 0 1px 2px rgba(0, 0, 0, 0.22)`;
  }

  // 浅色"纸感"卡片:走 token 暖咖啡微影,无白色 inset 高光(在白底上无效)、无黑色 inset 暗边(违反纸感)。
  // 章节色 hint 由内容自己承担(数字徽章/彩色文字),卡片本身不背彩色阴影负担。
  if (isLight) {
    return {
      background,
      border: `1px solid ${borderColor}`,
      boxShadow: variant === 'subtle' ? 'var(--shadow-card-sm)' : 'var(--shadow-card)',
      isolation: 'isolate' as const,
      ...extra,
    };
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
  isLight: boolean,
  extra?: React.CSSProperties,
): React.CSSProperties {
  // B 方案（液态玻璃评估选定，2026-06-16）：清晰度优先，玻璃感靠饱和度与柔和顶光。
  // 2026-07-17 微调（用户：「边缘塑料感」）：blur 略升一档补材质厚度，
  // 玻璃感不再依赖强镜面棱光（那是塑料感来源，见下方 shadowLayers）。
  const blurValues = {
    default: 'blur(16px) saturate(180%) brightness(1.08)',
    gold: 'blur(18px) saturate(200%) brightness(1.12)',
    frost: 'blur(24px) saturate(220%) brightness(1.1)',
    subtle: 'blur(12px) saturate(160%) brightness(1.04)',
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

  // 2026-07-17 去斜面棱（用户：「越看越假、边缘塑料感」）：旧版 50% 白顶部内描边 +
  // 侧缘线 + 底部暗线组成了 2000 年代的「斜面塑料」。现代玻璃（macOS 材质）的边缘
  // 是发丝级柔光：顶光降到 0.16 且无扩散、去掉侧缘与底部明暗线，厚度感交给 blur 与投影。
  const shadowLayers = [
    '0 16px 32px -12px rgba(10, 10, 14, 0.45)',
    `inset 0 1px 0 rgba(255, 255, 255, ${0.16 * borderMult})`,
    'inset 0 -14px 28px -24px rgba(255, 255, 255, 0.10)',
  ];
  if (variant === 'gold') {
    shadowLayers.push('0 8px 32px -8px rgba(99, 102, 241, 0.35)');
  } else if (accentHue !== undefined) {
    shadowLayers.push(`0 8px 32px -8px hsla(${accentHue}, 75%, 55%, 0.3)`);
  }

  // 浅色"纸感"卡片:同 Obsidian 浅色路径,走 token 暖咖啡微影,去掉白色 inset 高光(在白底上无效)。
  if (isLight) {
    return {
      '--_gbl': blur,
      '--_gbg': background,
      border: `1px solid var(--glass-border, rgba(255, 255, 255, ${0.14 * borderMult}))`,
      boxShadow: variant === 'subtle' ? 'var(--shadow-card-sm)' : 'var(--shadow-card)',
      transform: 'translateZ(0)',
      willChange: 'transform' as const,
      isolation: 'isolate' as const,
      ...extra,
    } as React.CSSProperties;
  }

  // backdrop-filter + background 通过 CSS 自定义属性传递给 ::before 伪元素
  // （配合 .glass-blur-pseudo 类），避免 macOS 上相邻 blur 元素的合成器接缝伪影
  return {
    '--_gbl': blur,
    '--_gbg': background,
    border: `1px solid var(--glass-border, rgba(255, 255, 255, ${0.14 * borderMult}))`,
    boxShadow: shadowLayers.join(', '),
    transform: 'translateZ(0)',
    willChange: 'transform' as const,
    isolation: 'isolate' as const,
    ...extra,
  } as React.CSSProperties;
}
