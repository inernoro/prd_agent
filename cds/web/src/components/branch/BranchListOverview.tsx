import type { ReactNode } from 'react';

/** The loading and ready states reserve the same two rows/columns above the grid. */
export function BranchListOverview({ summary, children, loading = false }: {
  summary: ReactNode;
  children: ReactNode;
  loading?: boolean;
}): JSX.Element {
  return (
    <div
      className="mb-5 grid min-w-0 grid-cols-1 gap-2 xl:grid-cols-2 xl:gap-x-4"
      data-testid="branch-overview-bar"
      aria-hidden={loading || undefined}
    >
      <div
        className="h-20 min-w-0 overflow-auto [scrollbar-width:thin] xl:h-10"
        role={loading ? undefined : 'region'}
        aria-label={loading ? undefined : '分支统计'}
        tabIndex={loading ? undefined : 0}
        data-branch-summary-slot
      >
        <div className="flex min-h-full min-w-full items-center whitespace-normal xl:w-max xl:whitespace-nowrap">
          {summary}
        </div>
      </div>
      <div className="h-10 min-w-0 overflow-x-auto [scrollbar-width:thin]" data-branch-controls-slot>
        <div className="flex h-full w-max min-w-full items-center gap-2 whitespace-nowrap xl:justify-end">
          {children}
        </div>
      </div>
    </div>
  );
}
