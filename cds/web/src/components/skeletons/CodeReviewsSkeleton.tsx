/** Code download and initial API requests share the complete review-page outline. */
export function CodeReviewsSkeleton(): JSX.Element {
  return <div
    role="status"
    aria-label="正在读取代码审查"
    aria-busy="true"
    className="mx-auto max-w-[90rem] space-y-6"
    data-code-reviews-skeleton
  >
    <header className="space-y-2" aria-hidden="true">
      <div className="cds-loading-skeleton-line h-7 w-64 max-w-full" />
      <div className="cds-loading-skeleton-line h-4 w-full max-w-3xl" />
    </header>
    <section className="space-y-4 rounded-xl border border-border bg-card p-5" aria-hidden="true">
      <div className="cds-loading-skeleton-line h-5 w-40" />
      <div className="space-y-1.5">
        <div className="cds-loading-skeleton-line h-4 w-20" />
        <div className="cds-loading-skeleton-panel h-9 w-full rounded-md" />
      </div>
      <div className="flex gap-2">
        <div className="cds-loading-skeleton-panel h-8 w-24 rounded-md" />
        <div className="cds-loading-skeleton-panel h-8 w-28 rounded-md" />
      </div>
      <div className="cds-loading-skeleton-panel h-28 rounded-lg border border-dashed border-input" />
      <div className="cds-loading-skeleton-panel h-9 rounded-lg border border-border" />
      <div className="space-y-3">
        <div className="cds-loading-skeleton-line h-4 w-28" />
        <div className="cds-loading-skeleton-line h-4 w-32" />
        <div className="cds-loading-skeleton-line h-4 w-40" />
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <div className="cds-loading-skeleton-panel h-9 w-28 rounded-md" />
        <div className="cds-loading-skeleton-line h-3 w-72 max-w-full" />
      </div>
    </section>
    <section className="space-y-3" aria-hidden="true">
      <div className="cds-loading-skeleton-line h-5 w-40" />
      <div className="grid gap-4 xl:grid-cols-2">
        {[0, 1].map((row) => <div key={row} className="space-y-3 rounded-xl border border-border bg-card p-5">
          <div className="cds-loading-skeleton-line h-4 w-48 max-w-full" />
          <div className="cds-loading-skeleton-line h-3 w-3/4" />
          <div className="cds-loading-skeleton-line h-3 w-1/2" />
        </div>)}
      </div>
    </section>
  </div>;
}
