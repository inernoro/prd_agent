/** Shared waterfall (masonry) layout helpers for the showcase gallery. */

interface CoverDims {
  coverWidth: number;
  coverHeight: number;
}

/** Distribute items into columns by shortest-column-first for waterfall layout */
export function distributeToColumns<T extends CoverDims>(
  items: T[],
  columnCount: number,
): T[][] {
  const columns: T[][] = Array.from({ length: columnCount }, () => []);
  const heights = new Array(columnCount).fill(0);
  for (const item of items) {
    const ratio = item.coverWidth && item.coverHeight ? item.coverHeight / item.coverWidth : 0.625;
    const shortest = heights.indexOf(Math.min(...heights));
    columns[shortest].push(item);
    heights[shortest] += ratio;
  }
  return columns;
}

/** Get aspect ratio string for a cover (falls back to 16/10) */
export function getAspectRatio(item: CoverDims): string {
  if (item.coverWidth && item.coverHeight) {
    return `${item.coverWidth}/${item.coverHeight}`;
  }
  return '16/10';
}
