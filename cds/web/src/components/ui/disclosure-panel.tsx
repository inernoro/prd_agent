import type { ReactNode } from 'react';

import { cn } from '@/lib/utils';

export function DisclosurePanel({
  icon,
  title,
  subtitle,
  children,
  actionLabel = '展开',
  tone = 'default',
  className,
  summaryClassName,
  contentClassName,
}: {
  icon?: ReactNode;
  title: ReactNode;
  subtitle?: ReactNode;
  children: ReactNode;
  actionLabel?: ReactNode;
  tone?: 'default' | 'danger';
  className?: string;
  summaryClassName?: string;
  contentClassName?: string;
}): JSX.Element {
  return (
    <details
      className={cn(
        'overflow-hidden rounded-md border bg-card/70 shadow-sm',
        tone === 'danger' ? 'border-destructive/25' : 'border-border',
        className,
      )}
    >
      <summary
        className={cn(
          'flex cursor-pointer list-none items-center justify-between gap-3 px-4 py-3 text-sm transition-colors hover:bg-muted/20 [&::-webkit-details-marker]:hidden',
          summaryClassName,
        )}
      >
        <span className="flex min-w-0 items-center gap-2">
          {icon ? <span className={tone === 'danger' ? 'text-destructive' : 'text-muted-foreground'}>{icon}</span> : null}
          <span className="min-w-0">
            <span className={cn('block font-semibold', tone === 'danger' ? 'text-destructive' : undefined)}>{title}</span>
            {subtitle ? <span className="mt-1 block truncate text-xs text-muted-foreground">{subtitle}</span> : null}
          </span>
        </span>
        <span className="shrink-0 text-xs text-muted-foreground">{actionLabel}</span>
      </summary>
      <div className={cn('border-t border-border px-4 py-4', contentClassName)}>{children}</div>
    </details>
  );
}
