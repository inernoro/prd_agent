import { useEffect, useState, type RefObject } from 'react';

/**
 * Responsive waterfall column count driven by the actual container width
 * (ResizeObserver), not the viewport — this correctly handles ultrawide /
 * 带鱼屏 monitors and the homepage section's own padding/max-width.
 *
 * Standard desktop (~1280-1600px) anchors at 5 columns; ultrawide expands to
 * 6-7 so cards never grow oversized; narrow widths step down to 3/2.
 *
 * Pure-JS computation (mirrors the existing inline `isMobile ? 2 : 4` pattern)
 * because the project uses Tailwind v4 with no 3xl breakpoint.
 */
function columnsForWidth(width: number): number {
  if (width < 540) return 2;
  if (width < 900) return 3;
  if (width < 1280) return 4;
  if (width < 1728) return 5;
  if (width < 2200) return 6;
  return 7;
}

export interface WaterfallLayout {
  columnCount: number;
  gap: number;
}

export function useWaterfallColumns(
  containerRef: RefObject<HTMLElement | null>,
): WaterfallLayout {
  const [width, setWidth] = useState(0);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const measure = () => setWidth(el.clientWidth);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [containerRef]);

  // Before first measurement, fall back to viewport width so SSR-less first
  // paint still picks a sensible column count instead of flashing 2 columns.
  const effectiveWidth = width || (typeof window !== 'undefined' ? window.innerWidth : 1280);
  const columnCount = columnsForWidth(effectiveWidth);
  const gap = columnCount <= 2 ? 12 : 16;
  return { columnCount, gap };
}
