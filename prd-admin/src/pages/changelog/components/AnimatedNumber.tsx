import { useEffect, useRef, useState } from 'react';
import type { CSSProperties } from 'react';

/**
 * 数字滚动组件：value 变化时从旧值 ease-out 滚动到新值（含首次从 0 滚入）。
 * 用于更新中心统计 chip / 页签计数 / 热度徽章，让面板「活起来」。
 */
export function AnimatedNumber({
  value,
  duration = 800,
  className,
  style,
}: {
  value: number;
  duration?: number;
  className?: string;
  style?: CSSProperties;
}) {
  const [display, setDisplay] = useState(0);
  const fromRef = useRef(0);

  useEffect(() => {
    const from = fromRef.current;
    const to = value;
    if (from === to) return;
    fromRef.current = to;
    if (typeof window === 'undefined' || window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
      setDisplay(to);
      return;
    }
    let raf = 0;
    const start = performance.now();
    const tick = (now: number) => {
      const p = Math.min(1, (now - start) / duration);
      const eased = 1 - Math.pow(1 - p, 3);
      setDisplay(Math.round(from + (to - from) * eased));
      if (p < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [value, duration]);

  return (
    <span className={className} style={{ fontVariantNumeric: 'tabular-nums', ...style }}>
      {display.toLocaleString()}
    </span>
  );
}
