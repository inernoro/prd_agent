import type { ReactNode } from 'react';

/** Summary and controls follow the available width; task counts never require a hidden horizontal scroll. */
export function BranchListOverview({ summary, children, loading = false }: {
  summary: ReactNode;
  children: ReactNode;
  loading?: boolean;
}): JSX.Element {
  return (
    <div
      className="mb-4 flex min-w-0 flex-wrap items-start justify-between gap-x-4 gap-y-3"
      data-testid="branch-overview-bar"
      aria-hidden={loading || undefined}
    >
      <div
        className="min-w-0 flex-[1_1_24rem]"
        role={loading ? undefined : 'region'}
        aria-label={loading ? undefined : '分支统计'}
        tabIndex={undefined}
        data-branch-summary-slot
      >
        <div className="flex min-w-0 items-start">
          {summary}
        </div>
      </div>
      <div className="min-w-0 max-w-full flex-[0_1_auto]" data-branch-controls-slot>
        <div className="flex min-h-10 max-w-full flex-wrap items-center gap-2">
          {children}
        </div>
      </div>
    </div>
  );
}
