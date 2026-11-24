export const TASK_LAYOUT = {
  root: 'flex flex-col gap-3 xl:min-h-0 xl:flex-1',
  summary: 'flex min-w-0 flex-1 items-stretch overflow-hidden rounded-md border border-[hsl(var(--hairline))] bg-[hsl(var(--surface-raised))]',
  summaryText: 'flex min-w-0 flex-1 flex-col justify-center px-4 py-3',
  summaryStats: 'hidden shrink-0 items-stretch lg:flex',
  summaryStat: 'flex w-[5.375rem] flex-col justify-center border-l border-[hsl(var(--hairline))] px-3 py-2',
  nextStat: 'flex w-[11.75rem] flex-col justify-center border-l border-[hsl(var(--hairline))] bg-primary-soft/50 px-3 py-2',
  columns: 'grid flex-1 gap-3 xl:min-h-0 xl:grid-rows-[minmax(0,1fr)] xl:grid-cols-[18.75rem_minmax(0,1fr)]',
  panel: 'flex min-h-0 flex-col overflow-hidden rounded-md border border-[hsl(var(--hairline))] bg-[hsl(var(--surface-raised))]',
  indexHeader: 'flex shrink-0 items-center gap-2 border-b border-[hsl(var(--hairline))] px-3 py-2.5',
  timelineHeader: 'items-center justify-between border-b border-[hsl(var(--hairline))] px-4 py-2',
  runHeader: 'flex shrink-0 flex-wrap items-center justify-between gap-x-3 gap-y-1.5 border-b border-[hsl(var(--hairline))] px-4 py-2.5',
} as const;

export function TaskScheduleSkeleton(): JSX.Element {
  return <div className={TASK_LAYOUT.root} role="status" aria-busy="true" aria-label="加载任务调度配置" data-task-schedule-skeleton>
    <div className={TASK_LAYOUT.summary} aria-hidden="true">
      <div className={`${TASK_LAYOUT.summaryText} gap-1`}>
        <div className="flex h-6 items-center gap-2"><span className="cds-loading-skeleton-line h-1.5 w-1.5 rounded-full" /><span className="cds-loading-skeleton-line h-4 w-36" /></div>
        <div className="flex h-5 items-center"><span className="cds-loading-skeleton-line h-3 w-64 max-w-full" /></div>
      </div>
      <div className={TASK_LAYOUT.summaryStats}>
        {[0, 1, 2, 3, 4, 5].map((index) => <div key={index} className={`${index === 5 ? TASK_LAYOUT.nextStat : TASK_LAYOUT.summaryStat} gap-1`}>
          <span className="cds-loading-skeleton-line h-2 w-9" /><span className="cds-loading-skeleton-line h-4 w-7" />
        </div>)}
      </div>
    </div>
    <div className={TASK_LAYOUT.columns} aria-hidden="true">
      <section className={`${TASK_LAYOUT.panel} max-h-[52vh] xl:max-h-none`}>
        <div className={TASK_LAYOUT.indexHeader}>
          <span className="cds-loading-skeleton-line h-4 w-9" /><span className="cds-loading-skeleton-line h-3 w-3" />
          <span className="cds-loading-skeleton-panel ml-auto h-8 w-[5.25rem] rounded-md" />
        </div>
        <div className="overflow-hidden p-2">
          {[0, 1, 2].map((index) => <div key={index}>
            <div className="flex items-center gap-2 px-1 pb-1 pt-2"><span className="flex h-[0.9375rem] items-center"><span className="cds-loading-skeleton-line h-2.5 w-12" /></span><span className="h-px flex-1 bg-[hsl(var(--hairline))]" /></div>
            <div className="mb-1 flex min-h-[3.8125rem] flex-col justify-center gap-2 rounded-md border border-[hsl(var(--hairline))] bg-[hsl(var(--surface-sunken))]/45 px-2.5 py-2">
              <div className="flex h-4 items-center gap-2"><span className="cds-loading-skeleton-line h-1.5 w-1.5 rounded-full" /><span className="cds-loading-skeleton-line h-3 w-28" /><span className="cds-loading-skeleton-line ml-auto h-2.5 w-12" /></div>
              <div className="cds-loading-skeleton-line h-3 w-24" />
            </div>
          </div>)}
        </div>
      </section>
      <section className={TASK_LAYOUT.panel}>
        <div className={`${TASK_LAYOUT.timelineHeader} flex`}>
          <div className="flex h-5 items-center gap-3"><span className="cds-loading-skeleton-line h-3 w-[4.375rem]" /><span className="cds-loading-skeleton-line h-2.5 w-32" /></div>
          <span className="cds-loading-skeleton-line hidden h-3 w-36 sm:block" />
        </div>
        <div className="overflow-hidden px-4 pb-3 pt-2">
          <div className="min-w-[35rem]">
            <div className="ml-48 flex h-4 items-center justify-between pr-32">
              {Array.from({ length: 9 }, (_, index) => <span key={index} className="cds-loading-skeleton-line h-2 w-2" />)}
            </div>
            {[0, 1, 2].map((index) => <div key={index} className="flex h-7 items-center gap-6">
              <span className="cds-loading-skeleton-line h-3 w-28" /><span className="cds-loading-skeleton-line ml-16 h-4 flex-1" /><span className="cds-loading-skeleton-line h-3 w-24" />
            </div>)}
            <div className="flex h-5 items-center"><span className="cds-loading-skeleton-line ml-[48%] h-3 w-16" /></div>
          </div>
        </div>
        <div className="min-h-0 flex-1 border-t border-[hsl(var(--hairline))]">
          <div className={TASK_LAYOUT.runHeader}>
            <div className="flex min-w-0 items-center gap-2"><span className="cds-loading-skeleton-line h-4 w-11" /><span className="cds-loading-skeleton-line h-2.5 w-24" /></div>
            <div className="flex shrink-0 gap-1">{[0, 1, 2].map((index) => <span key={index} className="cds-loading-skeleton-panel h-7 w-11 rounded-md" />)}</div>
          </div>
          {[0, 1, 2, 3].map((index) => <div key={index} className="flex h-[2.375rem] items-center gap-3 border-b border-[hsl(var(--hairline))] px-4 last:border-b-0">
            <span className="cds-loading-skeleton-line h-5 w-0.5" /><span className="cds-loading-skeleton-line h-3 w-9" />
            <span className="cds-loading-skeleton-line h-3 w-28" /><span className="cds-loading-skeleton-line h-3 w-7" />
            <span className="cds-loading-skeleton-line ml-auto h-2.5 w-6" /><span className="cds-loading-skeleton-line h-2.5 w-6" />
          </div>)}
        </div>
      </section>
    </div>
  </div>;
}
