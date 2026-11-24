/** 与真实控制台共用栏宽、窄屏顺序和边缘，修改布局从这里一起生效。 */
export const RELEASE_CONSOLE_LAYOUT_CLASS = 'flex h-full min-h-0 flex-col overflow-y-auto max-xl:gap-4 max-xl:p-4 xl:grid xl:grid-cols-[15rem_minmax(0,1fr)_18.75rem] xl:overflow-hidden wide:grid-cols-[16.5rem_minmax(0,1fr)_21.25rem] 2xl:grid-cols-[18rem_minmax(0,1fr)_23.75rem]';
export const RELEASE_CONSOLE_LEFT_CLASS = 'cds-surface-raised flex min-h-0 flex-col border-[hsl(var(--hairline))] max-xl:order-2 max-xl:shrink-0 max-xl:rounded-[0.875rem] max-xl:border xl:rounded-none xl:border-r xl:overflow-hidden';
export const RELEASE_CONSOLE_CENTER_CLASS = 'flex min-h-0 flex-col gap-3.5 max-xl:order-1 max-xl:shrink-0 xl:overflow-hidden xl:px-[1.375rem] xl:py-[1.125rem]';
export const RELEASE_CONSOLE_RIGHT_CLASS = 'cds-surface-raised flex min-h-0 flex-col border-[hsl(var(--hairline))] max-xl:order-3 max-xl:shrink-0 max-xl:rounded-[0.875rem] max-xl:border xl:rounded-none xl:border-l xl:overflow-hidden';
export const RELEASE_CONSOLE_NAV_CLASS = 'flex shrink-0 flex-wrap gap-2 border-b border-[hsl(var(--hairline))] px-6 py-3';
export const RELEASE_CONSOLE_BATCH_SCROLL_CLASS = 'h-full min-w-0 overflow-y-auto p-4 md:p-6';
export const RELEASE_BATCH_SECTION_CLASS = 'mx-auto min-w-0 max-w-[90rem] space-y-6';
export const RELEASE_BATCH_STEPS_CLASS = 'grid grid-cols-2 gap-3 md:grid-cols-4';
export const RELEASE_BATCH_ACTIONS_CLASS = 'cds-surface-raised cds-hairline flex flex-wrap items-center justify-between gap-4 rounded-lg border p-4 md:p-5';
export const RELEASE_BATCH_DETAIL_CLASS = 'grid min-w-0 items-start gap-5 xl:grid-cols-[minmax(0,1.8fr)_minmax(19rem,1fr)]';
export const RELEASE_CONSOLE_RUN_GRID_CLASS = 'grid min-h-0 flex-1 gap-3.5 xl:grid-cols-[14.5rem_minmax(0,1fr)] 2xl:grid-cols-[18.75rem_minmax(0,1fr)]';

export function isBatchReleaseMode(params: URLSearchParams): boolean {
  const mode = params.get('mode');
  return mode === 'batch' || (!mode && !params.has('target') && !params.has('intent'));
}

function BatchReleaseSkeleton(): JSX.Element {
  return <div className={RELEASE_CONSOLE_BATCH_SCROLL_CLASS} aria-hidden="true">
    <div className={RELEASE_BATCH_SECTION_CLASS}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 max-w-full">
          <div className="flex h-8 items-center"><div className="cds-loading-skeleton-line h-6 w-44" /></div>
          <div className="mt-2 flex h-5 items-center"><div className="cds-loading-skeleton-line h-3 w-80 max-w-full" /></div>
        </div>
        <div className="flex flex-wrap gap-2">{[0, 1].map(i => <div key={i} className="cds-loading-skeleton-panel h-8 w-24 rounded-md" />)}</div>
      </div>
      <div className={RELEASE_BATCH_STEPS_CLASS}>
        {[0, 1, 2, 3].map(i => <div key={i} className="flex min-w-0 items-center gap-2 rounded-md border border-[hsl(var(--hairline))] p-3">
          <div className="cds-loading-skeleton-panel size-7 shrink-0 rounded-full" /><div className="cds-loading-skeleton-line h-3 w-20 max-w-full" />
        </div>)}
      </div>
      <div className={RELEASE_BATCH_ACTIONS_CLASS}>
        <div className="cds-loading-skeleton-line h-3 w-24" /><div className="cds-loading-skeleton-panel h-9 w-36 rounded-md" />
      </div>
      <div className={RELEASE_BATCH_DETAIL_CLASS}>
        <div className="cds-surface-raised cds-hairline space-y-6 rounded-xl border p-5 md:p-6">
          <div className="space-y-3"><div className="cds-loading-skeleton-line h-4 w-24" /><div className="cds-loading-skeleton-panel h-11 rounded-md" /><div className="cds-loading-skeleton-line h-3 w-3/4" /></div>
          <div className="space-y-3"><div className="cds-loading-skeleton-line h-4 w-40" /><div className="grid gap-3 sm:grid-cols-2"><div className="flex items-start gap-3 rounded-lg border border-[hsl(var(--hairline))] p-4"><div className="cds-loading-skeleton-panel size-4 rounded" /><div className="flex-1 space-y-2"><div className="cds-loading-skeleton-line h-4 w-24 max-w-full" /><div className="cds-loading-skeleton-line h-3 w-4/5" /></div></div></div></div>
          <div className="cds-loading-skeleton-line h-3 w-3/4" />
        </div>
        <div className="cds-surface-raised cds-hairline min-w-0 space-y-5 rounded-xl border p-5 md:p-6">
          <div className="cds-loading-skeleton-line h-5 w-20" /><div className="cds-loading-skeleton-line h-3 w-4/5" /><div className="cds-loading-skeleton-line h-3 w-full" />
        </div>
      </div>
    </div>
  </div>;
}

function SingleReleaseSkeleton(): JSX.Element {
  return <div className={RELEASE_CONSOLE_LAYOUT_CLASS} aria-hidden="true">
    <aside className={RELEASE_CONSOLE_LEFT_CLASS}>
      <div className="shrink-0 space-y-2.5 px-4 pb-2.5 pt-4"><div className="cds-loading-skeleton-line h-3 w-20" /><div className="cds-loading-skeleton-panel h-8 rounded-md" /></div>
      <div className="min-h-0 flex-1 px-2.5 pb-3"><div className="space-y-1 rounded-[0.5625rem] border border-[hsl(var(--hairline))] px-3 py-2.5"><div className="cds-loading-skeleton-line h-4 w-32 max-w-full" /><div className="cds-loading-skeleton-line h-3 w-24" /></div></div>
      <div className="shrink-0 space-y-2.5 border-t border-[hsl(var(--hairline))] px-4 py-3.5"><div className="cds-loading-skeleton-line h-3 w-24" /><div className="cds-loading-skeleton-panel h-12 rounded-lg" /></div>
    </aside>
    <div className={RELEASE_CONSOLE_CENTER_CLASS}>
      <div className="cds-surface-raised shrink-0 space-y-3 rounded-[0.875rem] border border-[hsl(var(--hairline))] px-3 py-[1.125rem] sm:px-5">
        <div className="flex flex-wrap items-center gap-[1.125rem]">
          <div className="cds-loading-skeleton-panel size-[3.25rem] shrink-0 rounded-[0.875rem]" />
          <div className="min-w-0 flex-1 space-y-2 max-sm:basis-full"><div className="flex flex-wrap items-center gap-2"><div className="cds-loading-skeleton-line h-4 w-20" /><div className="cds-loading-skeleton-line h-3 w-36" /><div className="cds-loading-skeleton-panel h-11 w-40 rounded-lg" /></div><div className="cds-loading-skeleton-line h-2 w-full" /></div>
          <div className="flex flex-wrap gap-2 max-sm:w-full"><div className="cds-loading-skeleton-panel h-8 w-24 rounded-md" /><div className="cds-loading-skeleton-panel h-8 w-24 rounded-md max-sm:flex-1" /></div>
        </div>
      </div>
      <div className="cds-loading-skeleton-panel h-8 shrink-0 rounded-md" />
      <div className={RELEASE_CONSOLE_RUN_GRID_CLASS}>
        <div className="cds-surface-raised cds-hairline min-h-0 overflow-hidden rounded-[0.875rem] border"><div className="border-b border-[hsl(var(--hairline))] px-3.5 py-3"><div className="cds-loading-skeleton-line h-3 w-16" /></div><div className="h-7" /></div>
        <div className="cds-hairline min-h-0 overflow-hidden rounded-[0.875rem] border bg-[hsl(var(--surface-sunken))]"><div className="flex flex-wrap items-center justify-between gap-2 border-b border-[hsl(var(--hairline))] px-3.5 py-2.5"><div className="cds-loading-skeleton-line h-3 w-20" /><div className="flex gap-2">{[0, 1, 2].map(i => <div key={i} className="cds-loading-skeleton-panel h-6 w-14 rounded-md" />)}</div></div><div className="px-3.5 py-2.5"><div className="cds-loading-skeleton-line h-3 w-64 max-w-full" /></div></div>
      </div>
    </div>
    <aside className={RELEASE_CONSOLE_RIGHT_CLASS}>
      <div className="flex flex-wrap gap-3 border-b border-[hsl(var(--hairline))] px-2.5 py-3">{[0, 1, 2, 3].map(i => <div key={i} className="cds-loading-skeleton-line h-3 w-12" />)}</div>
      <div className="p-4"><div className="cds-loading-skeleton-line h-3 w-32" /></div>
    </aside>
  </div>;
}

export function ReleaseConsoleSkeleton({ navigation = true, batch = true }: { navigation?: boolean; batch?: boolean } = {}): JSX.Element {
  const body = <div className="h-full min-h-0" role="status" aria-label="加载发布控制台" aria-busy="true" data-release-console-skeleton>
    {batch ? <BatchReleaseSkeleton /> : <SingleReleaseSkeleton />}
  </div>;
  return navigation ? <div className="flex h-full min-h-0 flex-col">
    <div aria-hidden="true" className={RELEASE_CONSOLE_NAV_CLASS}>
      <span className={`rounded-md px-4 py-2 text-sm font-medium ${batch ? 'bg-primary/10 text-primary' : 'text-muted-foreground'}`}>批次发布</span>
      <span className={`rounded-md px-4 py-2 text-sm font-medium ${batch ? 'text-muted-foreground' : 'bg-primary/10 text-primary'}`}>逐目标发布</span>
    </div><div className="min-h-0 flex-1">{body}</div>
  </div> : body;
}
