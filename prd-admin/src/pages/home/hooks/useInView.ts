import { useEffect, useRef, useState } from 'react';

/**
 * useInView — 元素进入视口时触发一次（fade-up 滚动动效用）
 *
 * 注意：只触发一次（首次进入视口后 unobserve），滚回去再回来不会重复播放，
 * 避免"来回晃"的廉价感。
 *
 * 首屏优化：挂载时如果元素已在视口附近（1.15 倍窗口高度内），用 double-rAF
 * 延迟触发 inView，确保浏览器先绘制初始态（opacity:0 / blur），再切换到
 * 终态触发 CSS transition。同步 setState 会导致 React 18 批处理跳过初始帧。
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

    if (debugLabel) {
      console.log(
        `[Reveal:${debugLabel}] mount top=${Math.round(rect.top)} vh=${window.innerHeight} nearViewport=${nearViewport}`,
      );
    }

    if (nearViewport) {
      // 关键：double-rAF 保证浏览器先绘制 opacity:0 / blur 初始帧，
      // 再 setState 触发 CSS transition。直接 setState 会被 React 18
      // 批处理合并到同一帧，跳过初始态 → transition 不触发 → 元素直接跳到终态。
      const t0 = performance.now();
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          if (debugLabel) {
            console.log(
              `[Reveal:${debugLabel}] → inView=true (after ${Math.round(performance.now() - t0)}ms)`,
            );
          }
          setInView(true);
        });
      });
      return;
    }

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          if (debugLabel) {
            console.log(`[Reveal:${debugLabel}] → inView=true (intersected)`);
          }
          setInView(true);
          observer.unobserve(el);
        }
      },
      {
        threshold: 0.15,
        rootMargin: '0px 0px -8% 0px',
        ...options,
      },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [options, debugLabel]);

  return [ref, inView] as const;
}
