import type { ReactNode } from 'react';
import { useInView } from '../hooks/useInView';

interface RevealProps {
  children: ReactNode;
  delay?: number;
  className?: string;
  /** 进入视口后的位移距离，默认 16px（Linear 风格用更小的位移） */
  offset?: number;
  /** 持续时间，默认 1100ms */
  duration?: number;
  /** 初始模糊度，默认 8px（0 = 禁用模糊） */
  blur?: number;
  /** 作为内联 span 而不是 div（避免破坏布局） */
  as?: 'div' | 'span';
}

/**
 * Reveal — 滚动进入视口时从朦胧到清晰，徐徐点亮（Linear.app 风格）
 *
 * 动效分解：
 *  1. opacity 0 → 1          让内容从黑暗中浮现
 *  2. filter blur(8px) → 0   制造"雾气散开"的朦胧感
 *  3. translateY(16px) → 0   极轻的上浮，不喧宾夺主
 *  4. 缓动：ease-out 的加速版 cubic-bezier(0.16, 1, 0.3, 1)
 *     前 20% 快速破雾，后 80% 缓缓归位 —— 像灯光从远处渐近
 *
 * 用法：
 *   <Reveal><h2>标题</h2></Reveal>
 *   <Reveal delay={100} blur={12}>大标题（更浓的雾）</Reveal>
 *   <Reveal blur={0}>不需要模糊的元素</Reveal>
 *
 * 尊重 prefers-reduced-motion —— 用户禁用动效时立即显示，无过渡。
 */
export function Reveal({
  children,
  delay = 0,
  className,
  offset = 16,
  duration = 1100,
  blur = 8,
  as = 'div',
}: RevealProps) {
  const [ref, inView] = useInView<HTMLDivElement>();
  const Tag = as;

  const filterValue = blur > 0
    ? (inView ? 'blur(0px)' : `blur(${blur}px)`)
    : undefined;

  return (
    <Tag
      ref={ref as React.RefObject<HTMLDivElement>}
      className={className}
      style={{
        opacity: inView ? 1 : 0,
        filter: filterValue,
        transform: inView ? 'translateY(0)' : `translateY(${offset}px)`,
        transition: [
          `opacity ${duration}ms cubic-bezier(0.16, 1, 0.3, 1) ${delay}ms`,
          blur > 0 ? `filter ${duration * 0.85}ms cubic-bezier(0.16, 1, 0.3, 1) ${delay}ms` : '',
          `transform ${duration}ms cubic-bezier(0.16, 1, 0.3, 1) ${delay}ms`,
        ].filter(Boolean).join(', '),
        willChange: 'opacity, transform, filter',
      }}
    >
      {children}
    </Tag>
  );
}
