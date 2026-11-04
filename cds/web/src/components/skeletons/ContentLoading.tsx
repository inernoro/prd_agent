import { useEffect, useState } from 'react';
import { cn } from '@/lib/utils';

export type ContentLoadingVariant = 'rows' | 'table' | 'panel' | 'log' | 'inline';

/** 数据区域的统一等待轮廓。只替换等待分支，不接管请求、错误或已有内容。 */
export function ContentLoading({
  label,
  variant = 'rows',
  className,
}: {
  label: string;
  variant?: ContentLoadingVariant;
  className?: string;
}): JSX.Element {
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    setSlow(false);
    const timer = window.setTimeout(() => setSlow(true), 6_000);
    return () => window.clearTimeout(timer);
  }, [label, variant]);

  if (variant === 'inline') {
    return <span role="status" aria-label={label} aria-busy="true" className={cn('inline-flex min-w-0 items-center', className)}>
      <span className="cds-loading-skeleton-line inline-block h-3 w-24 max-w-full" aria-hidden="true" />
      {slow ? <span className="sr-only">仍在读取</span> : null}
    </span>;
  }

  return (
    <div role="status" aria-label={label} aria-busy="true" className={cn(
      'w-full min-w-0',
      variant === 'rows' ? 'space-y-2.5 py-3' : 'space-y-3 p-3',
      className,
    )} data-content-loading={variant}>
      <div aria-hidden="true" className="space-y-2.5">
        {variant === 'panel' ? <div className="cds-loading-skeleton-panel h-48 w-full rounded-lg" /> : null}
        {Array.from({ length: variant === 'table' ? 4 : 3 }, (_, i) => (
          <div key={i} className="flex min-w-0 items-center gap-3">
            {variant === 'table' ? <span className="cds-loading-skeleton-panel h-7 w-7 shrink-0 rounded-md" /> : null}
            <span className={cn('cds-loading-skeleton-line', variant === 'log' ? 'h-3' : 'h-3.5')}
              style={{ width: ['72%', '92%', '56%', '80%'][i], animationDelay: `${i * 0.1}s` }} />
          </div>
        ))}
      </div>
      {slow ? <p className="text-xs text-muted-foreground" aria-live="polite">仍在读取…</p> : null}
    </div>
  );
}
