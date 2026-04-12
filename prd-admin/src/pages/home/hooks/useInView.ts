import { useEffect, useRef, useState } from 'react';

/**
 * useInView — 元素进入视口时触发一次
 *
 * 配合 Reveal 的 CSS @keyframes animation 使用：
 *  · inView=true 后 Reveal 设置 animation 属性，animation-delay 处理时序
 *  · 不再需要 double-rAF hack（@keyframes 的 from 态由 keyframes 定义，
 *    不依赖 "上一帧的 DOM 样式"）
 *
 * 首屏优化：视口内元素直接 inView=true。
 * 滚动区：IntersectionObserver 检测。
 */
export function useInView<T extends HTMLElement>(
  options?: IntersectionObserverInit,
  debugLabel?: string,
) {
  const ref = useRef<T | null>(null);
  const [inView, setInView] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    const rect = el.getBoundingClientRect();
    const nearViewport = rect.top < window.innerHeight * 1.15 && rect.bottom > 0;

    if (nearViewport) {
      if (debugLabel) console.log(`[Reveal:${debugLabel}] inView (on mount)`);
      setInView(true);
      return;
    }

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          if (debugLabel) console.log(`[Reveal:${debugLabel}] inView (scroll)`);
          setInView(true);
          observer.unobserve(el);
        }
      },
      { threshold: 0.15, rootMargin: '0px 0px -8% 0px', ...options },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [options, debugLabel]);

  return [ref, inView] as const;
}
