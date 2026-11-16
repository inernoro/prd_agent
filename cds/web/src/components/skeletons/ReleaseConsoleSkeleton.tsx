import { ContentLoading } from './ContentLoading';

/** 与真实控制台共用栏宽、窄屏顺序和边缘，修改布局从这里一起生效。 */
export const RELEASE_CONSOLE_LAYOUT_CLASS = 'flex h-full min-h-0 flex-col overflow-y-auto max-xl:gap-4 max-xl:p-4 xl:grid xl:grid-cols-[15rem_minmax(0,1fr)_18.75rem] xl:overflow-hidden wide:grid-cols-[16.5rem_minmax(0,1fr)_21.25rem] 2xl:grid-cols-[18rem_minmax(0,1fr)_23.75rem]';
export const RELEASE_CONSOLE_LEFT_CLASS = 'cds-surface-raised flex min-h-0 flex-col border-[hsl(var(--hairline))] max-xl:order-2 max-xl:shrink-0 max-xl:rounded-[0.875rem] max-xl:border xl:rounded-none xl:border-r xl:overflow-hidden';
export const RELEASE_CONSOLE_CENTER_CLASS = 'flex min-h-0 flex-col gap-3.5 max-xl:order-1 max-xl:shrink-0 xl:overflow-hidden xl:px-[1.375rem] xl:py-[1.125rem]';
export const RELEASE_CONSOLE_RIGHT_CLASS = 'cds-surface-raised flex min-h-0 flex-col border-[hsl(var(--hairline))] max-xl:order-3 max-xl:shrink-0 max-xl:rounded-[0.875rem] max-xl:border xl:rounded-none xl:border-l xl:overflow-hidden';

export function ReleaseConsoleSkeleton(): JSX.Element {
  return <div className={RELEASE_CONSOLE_LAYOUT_CLASS} role="status" aria-label="加载发布控制台" aria-busy="true" data-release-console-skeleton>
    <aside className={RELEASE_CONSOLE_LEFT_CLASS} aria-hidden="true">
      <div className="space-y-4 p-4"><div className="cds-loading-skeleton-line h-3 w-24" /><div className="cds-loading-skeleton-panel h-8 w-full rounded-md" /></div>
      <div className="min-h-0 flex-1 p-3"><ContentLoading label="读取发布项目列表" /></div>
      <div className="border-t border-[hsl(var(--hairline))] p-4"><ContentLoading label="读取发布环境列表" /></div>
    </aside>
    <div className={RELEASE_CONSOLE_CENTER_CLASS}>
      <ContentLoading label="读取发布控制台" variant="panel" />
      <div className="cds-loading-skeleton-panel min-h-48 flex-1 rounded-lg" aria-hidden="true" />
    </div>
    <aside className={RELEASE_CONSOLE_RIGHT_CLASS} aria-hidden="true"><div className="p-4"><ContentLoading label="读取发布历史" variant="table" /></div></aside>
  </div>;
}
