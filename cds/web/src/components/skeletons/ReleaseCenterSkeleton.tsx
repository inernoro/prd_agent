import type { ReleaseCenterSection } from '@/lib/releaseCenter';
import { LoadingBlock } from '@/pages/cds-settings/components';

const RELEASE_SECTIONS: ReadonlyArray<{ id: ReleaseCenterSection; label: string }> = [
  { id: 'fleet', label: '全环境矩阵' },
  { id: 'config', label: '环境与配置' },
  { id: 'rules', label: '自动发布规则' },
  { id: 'health', label: '健康监测' },
  { id: 'evidence', label: '证据归档' },
];

export const RELEASE_CENTER_BODY_CLASS = 'min-h-0 flex-1 overflow-y-auto px-6 pb-7 pt-5';
export const RELEASE_CENTER_SECTIONS_CLASS = 'flex flex-col gap-[1.125rem]';

export function ReleaseCenterNavigation({ section, badgeFor, onSelect }: {
  section: ReleaseCenterSection;
  badgeFor?: (id: ReleaseCenterSection) => string;
  onSelect?: (id: ReleaseCenterSection) => void;
}): JSX.Element {
  return <nav className="flex shrink-0 flex-wrap items-center gap-1.5 border-b border-[hsl(var(--hairline))] px-6 py-2.5">
    {RELEASE_SECTIONS.map(item => {
      const badge = badgeFor?.(item.id);
      return <button
        key={item.id}
        type="button"
        aria-pressed={section === item.id}
        onClick={() => onSelect?.(item.id)}
        disabled={!onSelect}
        className={`flex h-8 items-center gap-1.5 rounded-lg px-3 text-[0.7812rem] transition-colors duration-150 ${
          section === item.id ? 'bg-primary/[0.12] font-semibold text-primary' : 'text-muted-foreground hover:bg-[hsl(var(--surface-sunken))]'
        }`}
      >
        {item.label}
        {badge ? <span className="cds-ident text-[0.6562rem] opacity-70">{badge}</span> : null}
        {!onSelect && item.id === 'fleet' ? <span className="cds-loading-skeleton-line h-2 w-5" /> : null}
        {!onSelect && item.id === 'health' ? <span className="cds-loading-skeleton-line h-2 w-9" /> : null}
      </button>;
    })}
  </nav>;
}

/** 保留发布中心分区和审批、版本追溯、矩阵的自然窄屏布局。 */
export function ReleaseCenterSkeleton({ section = 'fleet' }: { section?: ReleaseCenterSection }): JSX.Element {
  return <div className="flex h-full min-h-0 flex-col" role="status" aria-busy="true" aria-label="正在加载发布环境" data-release-center-skeleton>
    <ReleaseCenterNavigation section={section} />
    <div className={RELEASE_CENTER_BODY_CLASS} aria-hidden="true">
      <div className={RELEASE_CENTER_SECTIONS_CLASS}>
        {section === 'fleet' ? <>
          <section className="min-w-0 border-b border-[hsl(var(--hairline))] py-5">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="flex min-w-0 flex-col gap-2"><span className="cds-loading-skeleton-line my-1 h-5 w-24" /><span className="cds-loading-skeleton-line h-3 w-64 max-w-full" /><span className="cds-loading-skeleton-line my-1 h-3 w-36" /></div>
              <div className="flex flex-wrap gap-2">{['w-40', 'w-[7.25rem]', 'w-28', 'w-[7.25rem]'].map((width, index) => <span key={index} className={`cds-loading-skeleton-panel h-9 rounded-md ${width}`} />)}</div>
            </div>
            <div className="mt-3 flex h-4 items-center"><div className="cds-loading-skeleton-line h-3 w-32" /></div>
            <div className="mt-3 flex h-5 items-center"><div className="cds-loading-skeleton-line h-3 w-36" /></div>
            <div className="mt-5 grid min-w-0 gap-5 border-t border-[hsl(var(--hairline))] pt-4 lg:grid-cols-2">
              <div className="space-y-3"><div className="flex h-8 items-center justify-between gap-3"><span className="cds-loading-skeleton-line h-3 w-24" /><span className="cds-loading-skeleton-panel h-8 w-32 rounded-md" /></div><div className="cds-loading-skeleton-line h-3 w-72 max-w-full" /></div>
              <div className="space-y-3"><div className="cds-loading-skeleton-line h-3 w-16" /><div className="cds-loading-skeleton-line h-3 w-56" />
                <div className="flex gap-2"><span className="cds-loading-skeleton-panel h-10 flex-1 rounded-md" /><span className="cds-loading-skeleton-panel h-10 flex-1 rounded-md" /><span className="cds-loading-skeleton-panel h-8 w-[4.375rem] rounded-md" /></div>
              </div>
            </div>
          </section>
          <section className="min-w-0 border-b border-[hsl(var(--hairline))] pb-5">
            <div className="mb-5 flex flex-wrap items-center justify-between gap-3"><div className="space-y-2"><div className="cds-loading-skeleton-line h-6 w-28" /><div className="cds-loading-skeleton-line h-3 w-60 max-w-full" /></div><div className="flex h-10 items-center gap-2"><div className="cds-loading-skeleton-line h-3 w-7" /><div className="cds-loading-skeleton-panel h-10 w-48 rounded-md" /></div></div>
            <div className="grid min-w-0 gap-6 xl:grid-cols-[minmax(0,1fr)_20rem]">
              <div className="space-y-5">
                <div className="space-y-5 py-5">{[0, 1].map(index => <div key={index} className={`space-y-2 ${index ? 'ml-4 border-l-2 border-[hsl(var(--hairline))] pl-5' : ''}`}><div className="cds-loading-skeleton-line h-4 w-44" /><div className="cds-loading-skeleton-line h-3 w-32" /></div>)}</div>
                <div className="flex flex-wrap gap-x-5 gap-y-2 border-y border-[hsl(var(--hairline))] py-3">{[0, 1, 2].map(index => <div key={index} className="cds-loading-skeleton-line h-4 w-20" />)}</div>
                <div className="space-y-3"><div className="cds-loading-skeleton-line h-4 w-20" /><div className="cds-loading-skeleton-line h-3 w-72 max-w-full" /><div className="cds-loading-skeleton-panel h-12 w-full rounded-md" /></div>
              </div>
              <aside className="space-y-3 border-t border-[hsl(var(--hairline))] pt-5 xl:border-l xl:border-t-0 xl:pl-6 xl:pt-0">
                <div className="cds-loading-skeleton-line h-4 w-20" /><div className="cds-loading-skeleton-line h-8 w-full" /><div className="cds-loading-skeleton-line h-3 w-24" /><div className="cds-loading-skeleton-line h-5 w-28" />
                <div className="space-y-4 border-y border-[hsl(var(--hairline))] py-5">{[0, 1, 2].map(index => <div key={index} className="space-y-2"><div className="cds-loading-skeleton-line h-3 w-28" /><div className="cds-loading-skeleton-line h-4 w-36" /></div>)}</div>
                <div className="space-y-3 py-3"><div className="cds-loading-skeleton-line h-4 w-20" /><div className="cds-loading-skeleton-line h-3 w-full" /><div className="cds-loading-skeleton-line h-3 w-4/5" /></div>
                <div className="flex gap-2">{[0, 1, 2].map(index => <div key={index} className="cds-loading-skeleton-panel h-8 flex-1 rounded-md" />)}</div>
              </aside>
            </div>
          </section>
          <section className="cds-surface-raised cds-hairline overflow-hidden rounded-[0.875rem] border">
            <div className="flex flex-wrap items-center justify-between gap-3 px-[1.125rem] py-4"><div className="cds-loading-skeleton-line h-4 w-40" /><div className="cds-loading-skeleton-line h-7 w-44" /></div>
            <div className="grid grid-cols-2 gap-3 border-y border-[hsl(var(--hairline))] p-4 xl:grid-cols-10">{Array.from({ length: 10 }, (_, index) => <span key={index} className="cds-loading-skeleton-line h-3 w-full max-w-20" />)}</div>
          </section>
        </> : <>
          <div className="cds-loading-skeleton-panel h-24 rounded-[0.875rem]" />
          <div className="grid min-w-0 gap-4 xl:grid-cols-[16.25rem_minmax(0,1fr)]"><div className="cds-loading-skeleton-panel h-40 rounded-lg" /><LoadingBlock label="正在加载分区" /></div>
        </>}
      </div>
    </div>
  </div>;
}
