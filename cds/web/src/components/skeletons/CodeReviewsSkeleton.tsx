/** Code and data waits share the filter/list silhouette, without a submission form. */
export function CodeReviewsSkeleton(): JSX.Element {
  return <div role="status" aria-label="正在读取代码审查" aria-busy="true" className="w-full space-y-5" data-code-reviews-skeleton>
    <header className="flex items-start justify-between gap-4" aria-hidden="true">
      <div className="min-w-0 flex-1 space-y-2"><div className="cds-loading-skeleton-line h-7 w-64 max-w-full" /><div className="cds-loading-skeleton-line h-4 w-full max-w-xl" /></div>
      <div className="cds-loading-skeleton-panel h-9 w-28 shrink-0 rounded-md" />
    </header>
    <section className="flex flex-wrap items-center justify-between gap-3" aria-hidden="true">
      <div className="cds-loading-skeleton-panel h-9 w-96 max-w-full rounded-md" />
      <div className="flex gap-3"><div className="cds-loading-skeleton-panel h-9 w-36 rounded-md" /><div className="cds-loading-skeleton-panel h-9 w-28 rounded-md" /></div>
    </section>
    <section className="space-y-3" aria-hidden="true">
      <div className="cds-loading-skeleton-line h-5 w-32" />
      <div className="flex flex-wrap gap-2"><div className="cds-loading-skeleton-panel h-8 w-52 rounded-md" /><div className="cds-loading-skeleton-panel h-8 w-60 max-w-full rounded-md" /></div>
      <div className="divide-y divide-border overflow-hidden rounded-xl border border-border bg-card">{[0, 1, 2, 3, 4].map((row) => <div key={row} className="flex justify-between gap-4 px-4 py-3"><div className="min-w-0 flex-1 space-y-2"><div className="cds-loading-skeleton-line h-4 w-64 max-w-full" /><div className="cds-loading-skeleton-line h-3 w-48 max-w-full" /></div><div className="cds-loading-skeleton-line h-4 w-16" /></div>)}</div>
    </section>
  </div>;
}
