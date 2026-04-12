import { useEffect, useState, type ReactNode } from 'react';
import { useInView } from '../hooks/useInView';

const KEYFRAMES_ID = 'map-reveal-keyframes';

/** 注入一次全局 @keyframes（避免重复注入） */
function injectRevealKeyframes() {
  if (document.getElementById(KEYFRAMES_ID)) return;
  const style = document.createElement('style');
  style.id = KEYFRAMES_ID;
  style.textContent = `
@keyframes map-reveal {
  from {
    opacity: 0;
    transform: translateY(var(--reveal-y, 16px));
    filter: blur(var(--reveal-blur, 0px));
  }
  to {
    opacity: 1;
    transform: translateY(0);
    filter: blur(0px);
  }
}
@media (prefers-reduced-motion: reduce) {
  .map-reveal-active { animation: none !important; opacity: 1 !important; }
}
  `;
  document.head.appendChild(style);
}

interface RevealProps {
  children: ReactNode;
  /** animation-delay ms — 由 CSS 原生控制，可靠的时序保证 */
  delay?: number;
  className?: string;
  /** 初始位移 px，默认 16 */
  offset?: number;
  /** animation-duration ms，默认 1100 */
  duration?: number;
  /** 初始模糊度 px，默认 0 */
  blur?: number;
  as?: 'div' | 'span';
  debugLabel?: string;
}

/**
 * Reveal — CSS @keyframes animation 驱动的进场动效
 *
 * 学习 Linear.app 的做法：
 *  · 用 @keyframes animation + animation-delay，不用 CSS transition
 *  · animation-fill-mode: both 保证元素在 delay 期间保持 from 态（不可见）
 *  · animation-delay 是 CSS 动画规范的一部分，不依赖 "上一帧的样式"
 *  · 缓动曲线 cubic-bezier(0.19, 1, 0.22, 1) — 极端 ease-out，"冲进来然后漂浮归位"
 *
 * 按重要性编排：
 *  · 核心信息（标题+副标题+CTA）delay=0~350ms，几乎同时
 *  · 装饰元素（HUD、logos）delay=1200ms+，配角晚到
 *  · 视觉证据（产品 Mockup）delay=1800ms+，最后浮出
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
  const [ref, inView] = useInView<HTMLDivElement>(undefined, debugLabel);
  const [injected, setInjected] = useState(false);

  useEffect(() => {
    injectRevealKeyframes();
    setInjected(true);
  }, []);

  const Tag = as;
  const ready = injected && inView;

  return (
    <Tag
      ref={ref as React.RefObject<HTMLDivElement>}
      className={`${ready ? 'map-reveal-active' : ''} ${className ?? ''}`}
      style={{
        // 动画未就绪时：不可见
        opacity: ready ? undefined : 0,
        // 就绪后：用 CSS @keyframes animation 驱动全部进场
        animation: ready
          ? `map-reveal ${duration}ms cubic-bezier(0.19, 1, 0.22, 1) ${delay}ms both`
          : 'none',
        // CSS 变量传递给 @keyframes
        ['--reveal-y' as string]: `${offset}px`,
        ['--reveal-blur' as string]: `${blur}px`,
        willChange: 'opacity, transform, filter',
      }}
    >
      {children}
    </Tag>
  );
}
