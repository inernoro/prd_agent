import type { ReactNode } from 'react';
import { useInView } from '../hooks/useInView';

interface RevealProps {
  children: ReactNode;
  delay?: number;
  className?: string;
  /** 进入视口后的位移距离，默认 16px */
  offset?: number;
  /** 持续时间，默认 1100ms */
  duration?: number;
  /** 初始模糊度，默认 8px（0 = 禁用模糊） */
  blur?: number;
  /** 作为内联 span 而不是 div（避免破坏布局） */
  as?: 'div' | 'span';
  /** 调试标签，启用后在 console 打印时序日志 */
  debugLabel?: string;
}

/**
 * Reveal — 滚动进入视口时从朦胧到清晰，徐徐点亮（Linear.app 风格）
 *
 * 动效分解：
 *  1. opacity 0 → 1          让内容从黑暗中浮现
 *  2. filter blur → 0        制造"雾气散开"的朦胧感（仅大标题使用，小元素不要 blur）
 *  3. translateY → 0         极轻的上浮，不喧宾夺主
 *
 * 呼吸设计原则：
 *  · 主标题第一个亮起（它是焦点），用重 blur
 *  · 副标题/eyebrow 等辅助文字不用 blur，只做 opacity+translateY
 *  · 按钮/logo 等外围元素最后，更轻的动效
 *  → 从"焦点向外辐射"，不是"从上到下瀑布"
 */
export function Reveal({
  children,
  delay = 0,
  className,
  offset = 16,
  duration = 1100,
  blur = 8,
  as = 'div',
  debugLabel,
}: RevealProps) {
  const [ref, inView] = useInView<HTMLDivElement>(undefined, debugLabel);
  const Tag = as;

  const useBlur = blur > 0;
  const filterValue = useBlur
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
          useBlur ? `filter ${Math.round(duration * 0.85)}ms cubic-bezier(0.16, 1, 0.3, 1) ${delay}ms` : '',
          `transform ${duration}ms cubic-bezier(0.16, 1, 0.3, 1) ${delay}ms`,
        ].filter(Boolean).join(', '),
        willChange: 'opacity, transform, filter',
      }}
    >
      {children}
    </Tag>
  );
}
