import { useEffect, useRef, useState } from 'react';

/**
 * useInView — 元素进入视口时触发一次（fade-up 滚动动效用）
 *
 * 注意：只触发一次（首次进入视口后 unobserve），滚回去再回来不会重复播放，
 * 避免"来回晃"的廉价感。
 */
export function useInView<T extends HTMLElement>(
  options?: IntersectionObserverInit,
) {
  const ref = useRef<T | null>(null);
  const [inView, setInView] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

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
