import type { ReactNode } from 'react';
import { cn } from '@/lib/cn';

interface ResponsiveGridProps {
  children: ReactNode;
  /** 各断点列数, 例如 { xs: 1, sm: 2, lg: 3, xl: 4 } */
  cols?: { xs?: number; sm?: number; md?: number; lg?: number; xl?: number; '2xl'?: number };
  /** 间距, 默认 'gap-3' */
  gap?: string;
  /** 加载中 → 显示骨架屏 */
  loading?: boolean;
  /** 骨架屏数量 (默认 6) */
  skeletonCount?: number;
  /** 骨架屏单项高度 px (默认 120) */
  skeletonHeight?: number;
  className?: string;
}

const COL_MAP: Record<string, Record<number, string>> = {
  xs: { 1: 'grid-cols-1', 2: 'grid-cols-2', 3: 'grid-cols-3', 4: 'grid-cols-4', 5: 'grid-cols-5', 6: 'grid-cols-6' },
  sm: { 1: 'sm:grid-cols-1', 2: 'sm:grid-cols-2', 3: 'sm:grid-cols-3', 4: 'sm:grid-cols-4', 5: 'sm:grid-cols-5', 6: 'sm:grid-cols-6' },
  md: { 1: 'md:grid-cols-1', 2: 'md:grid-cols-2', 3: 'md:grid-cols-3', 4: 'md:grid-cols-4', 5: 'md:grid-cols-5', 6: 'md:grid-cols-6' },
  lg: { 1: 'lg:grid-cols-1', 2: 'lg:grid-cols-2', 3: 'lg:grid-cols-3', 4: 'lg:grid-cols-4', 5: 'lg:grid-cols-5', 6: 'lg:grid-cols-6' },
  xl: { 1: 'xl:grid-cols-1', 2: 'xl:grid-cols-2', 3: 'xl:grid-cols-3', 4: 'xl:grid-cols-4', 5: 'xl:grid-cols-5', 6: 'xl:grid-cols-6' },
  '2xl': { 1: '2xl:grid-cols-1', 2: '2xl:grid-cols-2', 3: '2xl:grid-cols-3', 4: '2xl:grid-cols-4', 5: '2xl:grid-cols-5', 6: '2xl:grid-cols-6' },
};

function colClasses(cols: NonNullable<ResponsiveGridProps['cols']>): string {
  return Object.entries(cols)
    .map(([bp, n]) => COL_MAP[bp]?.[n])
    .filter(Boolean)
    .join(' ');
}

/**
 * 响应式卡片网格 + 骨架屏加载态。
 *
 * ```tsx
 * <ResponsiveGrid cols={{ xs: 1, sm: 2, lg: 3, xl: 4 }} loading={loading}>
 *   {items.map(item => <GlassCard key={item.id} />)}
 * </ResponsiveGrid>
 * ```
 */
export function ResponsiveGrid({
  children,
  cols = { xs: 1, sm: 2, lg: 3, xl: 4 },
  gap = 'gap-3',
  loading = false,
  skeletonCount = 6,
  skeletonHeight = 120,
  className,
}: ResponsiveGridProps) {
  const gridCls = cn('grid', colClasses(cols), gap, className);

  if (loading) {
    return (
      <div className={gridCls}>
        {Array.from({ length: skeletonCount }, (_, i) => (
          <div
            key={i}
            className="rounded-xl animate-pulse"
            style={{ height: skeletonHeight, background: 'rgba(255,255,255,0.04)' }}
          />
        ))}
      </div>
    );
  }

  return <div className={gridCls}>{children}</div>;
}
