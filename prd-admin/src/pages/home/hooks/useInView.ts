import { useEffect, useRef, useState } from 'react';

/**
 * useInView — 元素进入视口时触发一次（fade-up 滚动动效用）
 *
 * 注意：只触发一次（首次进入视口后 unobserve），滚回去再回来不会重复播放，
 * 避免"来回晃"的廉价感。
 *
 * 首屏优化：挂载时如果元素已经在视口内或紧贴视口边缘（1.15 倍窗口高度内），
 * 直接触发 inView，确保折叠线附近的内容（如 ProductMockup）不会因
 * IntersectionObserver 阈值/rootMargin 不满足而永远隐藏。
 */
export function useInView<T extends HTMLElement>(
  options?: IntersectionObserverInit,
) {
  const ref = useRef<T | null>(null);
  const [inView, setInView] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    // 首屏快检：元素顶部在 1.15 倍视口高度内 → 直接触发（CSS transition delay 保留 stagger 效果）
    const rect = el.getBoundingClientRect();
    if (rect.top < window.innerHeight * 1.15 && rect.bottom > 0) {
      setInView(true);
      return;
    }

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
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
  }, [options]);

  return [ref, inView] as const;
}
