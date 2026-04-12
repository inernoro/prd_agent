import { useEffect, useState, type ReactNode } from 'react';
import { useInView } from '../hooks/useInView';

interface RevealProps {
  children: ReactNode;
  /** JS 延迟 ms：控制元素何时"亮起"（不再依赖 CSS transition-delay） */
  delay?: number;
  className?: string;
  /** 进入视口后的位移距离，默认 16px */
  offset?: number;
  /** 持续时间，默认 1100ms */
  duration?: number;
  /** 初始模糊度，默认 0（只有大标题才用 blur，其他元素不需要） */
  blur?: number;
  /** 作为内联 span 而不是 div（避免破坏布局） */
  as?: 'div' | 'span';
  /** 调试标签 */
  debugLabel?: string;
}

/**
 * Reveal — 滚动进入视口时从朦胧到清晰，徐徐点亮
 *
 * 核心改动：
 *   delay 不再走 CSS transition-delay，而是用 JavaScript setTimeout 控制
 *   每个元素 "何时开始动"。这样每个元素的 CSS transition 是从真正不同的
 *   时间点启动的，而不是靠浏览器同帧处理 delay 值来区分。
 *
 * 呼吸设计：
 *  · 大标题 delay=0, blur=12 — 第一个从雾中亮起，它是焦点
 *  · 辅助文字 delay=大, blur=0 — 干净 fade，不和标题抢
 *  · 按钮/logo delay=更大, blur=0 — 纯 opacity+rise，最后出场
 */
export function Reveal({
  children,
  delay = 0,
  className,
  offset = 16,
  duration = 1100,
  blur = 0,
  as = 'div',
  debugLabel,
}: RevealProps) {
  const [ref, inViewRaw] = useInView<HTMLDivElement>(undefined, debugLabel);
  // JS 控制的延迟 — 真正的 stagger 入口
  const [active, setActive] = useState(false);

  useEffect(() => {
    if (!inViewRaw || active) return;
    if (delay <= 0) {
      setActive(true);
      if (debugLabel) console.log(`[Reveal:${debugLabel}] → active (immediate)`);
      return;
    }
    const timer = setTimeout(() => {
      setActive(true);
      if (debugLabel) console.log(`[Reveal:${debugLabel}] → active (after ${delay}ms JS delay)`);
    }, delay);
    return () => clearTimeout(timer);
  }, [inViewRaw, delay, active, debugLabel]);

  const Tag = as;
  const useBlur = blur > 0;

  return (
    <Tag
      ref={ref as React.RefObject<HTMLDivElement>}
      className={className}
      style={{
        opacity: active ? 1 : 0,
        filter: useBlur ? (active ? 'blur(0px)' : `blur(${blur}px)`) : undefined,
        transform: active ? 'translateY(0)' : `translateY(${offset}px)`,
        transition: [
          `opacity ${duration}ms cubic-bezier(0.16, 1, 0.3, 1)`,
          useBlur ? `filter ${Math.round(duration * 0.85)}ms cubic-bezier(0.16, 1, 0.3, 1)` : '',
          `transform ${duration}ms cubic-bezier(0.16, 1, 0.3, 1)`,
        ].filter(Boolean).join(', '),
        willChange: 'opacity, transform, filter',
      }}
    >
      {children}
    </Tag>
  );
}
