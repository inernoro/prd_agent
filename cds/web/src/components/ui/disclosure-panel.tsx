import type { ReactNode } from 'react';
import { useState } from 'react';

import { cn } from '@/lib/utils';

export function DisclosurePanel({
  icon,
  title,
  subtitle,
  children,
  actionLabel,
  tone = 'default',
  className,
  summaryClassName,
  contentClassName,
  defaultOpen = false,
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
  /** 默认是否展开。缺省 false（保持原有「点开才展」行为）。 */
  defaultOpen?: boolean;
}): JSX.Element {
  // 用内部 state 跟随原生 <details> 的 toggle，既支持 defaultOpen 初始展开，
  // 又不与用户手动收/展打架（受控同步，不会被 React 重渲染强行翻回）。
  const [open, setOpen] = useState(defaultOpen);
  const resolvedActionLabel = actionLabel ?? (open ? '收起' : '展开');
  return (
    <details
      open={open}
      onToggle={(e) => setOpen((e.currentTarget as HTMLDetailsElement).open)}
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
        <span className="shrink-0 text-xs text-muted-foreground">{resolvedActionLabel}</span>
      </summary>
      <div className={cn('border-t border-border px-4 py-4', contentClassName)}>{children}</div>
    </details>
  );
}
