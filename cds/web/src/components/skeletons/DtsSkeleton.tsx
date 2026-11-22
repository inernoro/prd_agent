import type { ReactNode } from 'react';
import { ArrowRight, Database } from 'lucide-react';

export const DTS_LAYOUT_CLASS = 'mx-auto max-w-5xl space-y-6 py-6';
export const DTS_PANEL_CLASS = 'rounded-lg border border-input bg-background p-5 space-y-4';
export const DTS_ENVIRONMENT_GRID_CLASS = 'grid items-end gap-4 md:grid-cols-[1fr_auto_1fr]';
export const DTS_PROJECT_LABEL_CLASS = 'min-w-56 max-w-full text-sm';

export function DtsHeading({ selector }: { selector: ReactNode }): JSX.Element {
  return <div className="flex flex-wrap items-start justify-between gap-4"><div><h1 className="text-2xl font-semibold flex items-center gap-2"><Database />数据同步</h1><p className="mt-2 text-sm text-muted-foreground">选择正式与备用环境，先比较，再按规则同步。</p></div>{selector}</div>;
}
export function DtsBodySkeleton(): JSX.Element {
  return <div className="space-y-6" role="status" aria-label="正在加载数据同步" aria-busy="true">
    <div aria-hidden className="space-y-6">
      <div className={DTS_PANEL_CLASS}>
        <div className="flex h-8 items-center justify-between">
          <div className="cds-loading-skeleton-line h-5 w-28" />
          <div className="cds-loading-skeleton-panel h-8 w-16 rounded-md" />
        </div>
        <div className={DTS_ENVIRONMENT_GRID_CLASS}>
          <div className="space-y-2">
            <div className="cds-loading-skeleton-line h-4 w-28" />
            <div className="cds-loading-skeleton-panel h-9 w-full rounded-md border border-input" />
          </div>
          <ArrowRight className="hidden opacity-30 md:block" />
          <div className="space-y-2">
            <div className="cds-loading-skeleton-line h-4 w-28" />
            <div className="cds-loading-skeleton-panel h-9 w-full rounded-md border border-input" />
          </div>
        </div>
        <div className="space-y-1">
          <div className="cds-loading-skeleton-line h-4 w-16" />
          <div className="cds-loading-skeleton-panel h-9 w-full rounded-md border border-input" />
        </div>
        <div className="pt-4"><div className="cds-loading-skeleton-line h-5 w-64 max-w-full" /></div>
        <div className="cds-loading-skeleton-panel h-9 w-24 rounded-md" />
      </div>
      <div className={DTS_PANEL_CLASS}>
        <div className="cds-loading-skeleton-line h-6 w-24" />
        <div className="cds-loading-skeleton-line h-5 w-[32rem] max-w-full" />
        <div className="cds-loading-skeleton-panel h-9 w-48 rounded-md" />
      </div>
      <div className={DTS_PANEL_CLASS}>
        <div className="cds-loading-skeleton-line h-6 w-20" />
        <div className="cds-loading-skeleton-line h-5 w-28" />
      </div>
    </div>
  </div>;
}

export function DtsEmptySelection(): JSX.Element {
  return <p className={DTS_PANEL_CLASS}>请选择项目，查看已批准的数据连接和同步任务。</p>;
}

export function DtsProjectSelectorSkeleton(): JSX.Element {
  return <div className={DTS_PROJECT_LABEL_CLASS} aria-hidden="true">
    所属项目
    <div className="cds-loading-skeleton-panel h-[2.375rem] rounded-md border border-input" />
  </div>;
}

export function DtsSkeleton({ hasProject = false }: { hasProject?: boolean }): JSX.Element {
  return <div className={DTS_LAYOUT_CLASS}>
    <DtsHeading selector={<DtsProjectSelectorSkeleton />} />
    {hasProject ? <DtsBodySkeleton /> : <DtsEmptySelection />}
  </div>;
}
