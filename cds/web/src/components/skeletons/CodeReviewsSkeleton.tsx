/** Code and data waits share the overview/list silhouette, without a submission form. */
export function CodeReviewsSkeleton(): JSX.Element {
  return <div role="status" aria-label="正在读取代码审查" aria-busy="true" className="mx-auto max-w-[90rem] space-y-5" data-code-reviews-skeleton>
    <header className="flex items-start justify-between gap-4" aria-hidden="true">
      <div className="min-w-0 flex-1 space-y-2"><div className="cds-loading-skeleton-line h-7 w-64 max-w-full" /><div className="cds-loading-skeleton-line h-4 w-full max-w-xl" /></div>
      <div className="cds-loading-skeleton-panel h-9 w-28 shrink-0 rounded-md" />
    </header>
    <section className="overflow-hidden rounded-xl border border-border bg-card" aria-hidden="true">
      <div className="space-y-2 border-b border-border px-5 py-4"><div className="cds-loading-skeleton-line h-5 w-80 max-w-full" /><div className="cds-loading-skeleton-line h-3 w-96 max-w-full" /></div>
      <div className="grid grid-cols-2 gap-3 p-4 sm:grid-cols-4">{[0, 1, 2, 3].map((item) => <div key={item} className="space-y-2"><div className="cds-loading-skeleton-line h-3 w-20" /><div className="cds-loading-skeleton-line h-7 w-12" /></div>)}</div>
    </section>
    <section className="space-y-3" aria-hidden="true">
      <div className="cds-loading-skeleton-line h-5 w-32" />
      <div className="flex flex-wrap gap-2"><div className="cds-loading-skeleton-panel h-8 w-52 rounded-md" /><div className="cds-loading-skeleton-panel h-8 w-60 max-w-full rounded-md" /></div>
      <div className="divide-y divide-border overflow-hidden rounded-xl border border-border bg-card">{[0, 1, 2, 3, 4].map((row) => <div key={row} className="flex justify-between gap-4 px-4 py-3"><div className="min-w-0 flex-1 space-y-2"><div className="cds-loading-skeleton-line h-4 w-64 max-w-full" /><div className="cds-loading-skeleton-line h-3 w-48 max-w-full" /></div><div className="cds-loading-skeleton-line h-4 w-16" /></div>)}</div>
    </section>
  </div>;
}
