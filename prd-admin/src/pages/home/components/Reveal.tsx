import type { ReactNode } from 'react';
import { useInView } from '../hooks/useInView';

interface RevealProps {
  children: ReactNode;
  delay?: number;
  className?: string;
  /** 进入视口后的位移距离，默认 28px */
  offset?: number;
  /** 持续时间，默认 900ms */
  duration?: number;
  /** 作为内联 span 而不是 div（避免破坏布局） */
  as?: 'div' | 'span';
}

/**
 * Reveal — 滚动进入视口时 fade-up 一次
 *
 * 用法：
 *   <Reveal><h2>标题</h2></Reveal>
 *   <Reveal delay={100}>...</Reveal>
 *
 * 尊重 prefers-reduced-motion —— 用户禁用动效时立即显示，无过渡。
 */
export function Reveal({
  children,
  delay = 0,
  className,
  offset = 28,
  duration = 900,
  as = 'div',
}: RevealProps) {
  const [ref, inView] = useInView<HTMLDivElement>();
  const Tag = as;

  return (
    <Tag
      ref={ref as React.RefObject<HTMLDivElement>}
      className={className}
      style={{
        opacity: inView ? 1 : 0,
        transform: inView ? 'translateY(0)' : `translateY(${offset}px)`,
        transition: `opacity ${duration}ms cubic-bezier(0.2, 0.9, 0.2, 1) ${delay}ms, transform ${duration}ms cubic-bezier(0.2, 0.9, 0.2, 1) ${delay}ms`,
        willChange: 'opacity, transform',
      }}
    >
      {children}
    </Tag>
  );
}
