import type { ReactNode } from 'react';
import { cn } from '@/lib/cn';
import BlurText from '@/components/reactbits/BlurText';

/**
 * SectionHeader — 设计系统层的区域标题组件
 *
 * 统一了 Landing Page 各 section 重复出现的 "badge + 标题 + 副标题" 模式。
 * 内置 BlurText 入场动画（可通过 animated=false 关闭）。
 *
 * @example
 * <SectionHeader
 *   badge="平台优势"
 *   badgeIcon={<Zap className="w-4 h-4" />}
 *   title="为什么选择 MAP"
 *   subtitle="企业级 AI 基础设施"
 *   animated
 * />
 */

export type SectionHeaderSize = 'sm' | 'md' | 'lg';

export interface SectionHeaderProps {
  /** 顶部徽标文字 */
  badge?: string;
  /** 徽标图标（渲染在文字左侧） */
  badgeIcon?: ReactNode;
  /** 主标题（string 时自动包裹 BlurText；ReactNode 时直接渲染） */
  title: string | ReactNode;
  /** 副标题（string 时自动包裹 BlurText；ReactNode 时直接渲染） */
  subtitle?: string | ReactNode;
  /** 是否启用 BlurText 入场动画 */
  animated?: boolean;
  /** 标题尺寸 */
  size?: SectionHeaderSize;
  /** 底部间距 */
  spacing?: 'sm' | 'md' | 'lg';
  /** 额外 className */
  className?: string;
  /** 是否居中（默认 true） */
  center?: boolean;
}

const sizeClasses: Record<SectionHeaderSize, { title: string; subtitle: string }> = {
  sm: {
    title: 'text-2xl sm:text-3xl font-bold text-white/90 mb-2',
    subtitle: 'text-base text-white/40',
  },
  md: {
    title: 'text-3xl sm:text-4xl md:text-5xl font-bold text-white/90 mb-4',
    subtitle: 'text-lg text-white/40 max-w-2xl',
  },
  lg: {
    title: 'text-4xl sm:text-5xl md:text-6xl font-bold text-white/90 mb-4',
    subtitle: 'text-xl text-white/40 max-w-3xl',
  },
};

const spacingMap = { sm: 'mb-8', md: 'mb-12', lg: 'mb-16' };

export function SectionHeader({
  badge,
  badgeIcon,
  title,
  subtitle,
  animated = true,
  size = 'md',
  spacing = 'lg',
  className,
  center = true,
}: SectionHeaderProps) {
  const sizes = sizeClasses[size];

  return (
    <div className={cn(center && 'text-center', spacingMap[spacing], className)}>
      {/* Badge */}
      {badge && (
        <div className="inline-flex items-center gap-2 px-4 py-2 mb-6 rounded-full border border-white/10 bg-white/[0.03]">
          {badgeIcon}
          <span className="text-sm text-white/50">{badge}</span>
        </div>
      )}

      {/* Title */}
      {typeof title === 'string' ? (
        animated ? (
          <BlurText
            text={title}
            delay={80}
            animateBy="letters"
            direction="top"
            className={cn(center && 'justify-center', sizes.title)}
          />
        ) : (
          <h2 className={sizes.title}>{title}</h2>
        )
      ) : (
        title
      )}

      {/* Subtitle */}
      {subtitle && (
        typeof subtitle === 'string' ? (
          animated ? (
            <BlurText
              text={subtitle}
              delay={30}
              animateBy="letters"
              direction="bottom"
              className={cn(center && 'justify-center mx-auto', sizes.subtitle)}
              stepDuration={0.3}
            />
          ) : (
            <p className={cn(center && 'mx-auto', sizes.subtitle)}>{subtitle}</p>
          )
        ) : (
          subtitle
        )
      )}
    </div>
  );
}
