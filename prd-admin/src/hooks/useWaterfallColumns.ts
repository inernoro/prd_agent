import { useEffect, useState, useCallback } from 'react';

/**
 * Responsive waterfall column count driven by the actual container content
 * width (ResizeObserver), not the viewport — this correctly handles ultrawide /
 * 带鱼屏 monitors and any container padding/max-width.
 *
 * Standard desktop (~1280-1600px) anchors at 5 columns; ultrawide expands to
 * 6-7 so cards never grow oversized; narrow widths step down to 3/2.
 *
 * Pure-JS computation (mirrors the existing inline `isMobile ? 2 : 4` pattern)
 * because the project uses Tailwind v4 with no 3xl breakpoint.
 *
 * Uses a callback ref (not a passed RefObject) so the observer is re-attached
 * whenever the measured node mounts/remounts — important because consumers may
 * conditionally render `null` and remount the container later.
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
  /** Attach to the element whose content width should drive the column count. */
  ref: (node: HTMLElement | null) => void;
}

export function useWaterfallColumns(): WaterfallLayout {
  const [node, setNode] = useState<HTMLElement | null>(null);
  const [width, setWidth] = useState(0);

  const ref = useCallback((el: HTMLElement | null) => setNode(el), []);

  useEffect(() => {
    if (!node) return;
    // Measure the content box (exclude horizontal padding) — the flex columns
    // are laid out inside the padding, so clientWidth would over-count and
    // bump an extra column near breakpoints.
    const measure = () => {
      const cs = getComputedStyle(node);
      const padX = parseFloat(cs.paddingLeft || '0') + parseFloat(cs.paddingRight || '0');
      setWidth(Math.max(0, node.clientWidth - padX));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(node);
    return () => ro.disconnect();
  }, [node]);

  // Before first measurement, fall back to viewport width so SSR-less first
  // paint still picks a sensible column count instead of flashing 2 columns.
  const effectiveWidth = width || (typeof window !== 'undefined' ? window.innerWidth : 1280);
  const columnCount = columnsForWidth(effectiveWidth);
  const gap = columnCount <= 2 ? 12 : 16;
  return { columnCount, gap, ref };
}
