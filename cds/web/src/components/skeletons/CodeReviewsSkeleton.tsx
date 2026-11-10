import '../../pages/code-reviews/review-design.css';

/** Code and data waits share the filter/list silhouette, without a submission form. */
export function CodeReviewsSkeleton(): JSX.Element {
  return <div role="status" aria-label="正在读取代码审查" aria-busy="true" className="cr-stack" data-code-reviews-skeleton>
    <header className="cr-page-header" aria-hidden="true">
      <div className="min-w-0 flex-1"><div className="cds-loading-skeleton-line cr-skeleton-title" /><div className="cds-loading-skeleton-line cr-skeleton-subtitle" /></div>
      <div className="cds-loading-skeleton-panel cr-skeleton-control cr-skeleton-action" />
    </header>
    <section className="cr-filters" aria-hidden="true">
      <div className="cds-loading-skeleton-panel cr-skeleton-control cr-skeleton-segment" />
      <div className="cds-loading-skeleton-panel cr-skeleton-control cr-filter-project" />
      <div className="cds-loading-skeleton-panel cr-skeleton-control cr-filter-state" />
      <div className="cds-loading-skeleton-panel cr-skeleton-control cr-filter-query" />
    </section>
    <section className="cr-surface" aria-hidden="true">
      <div className="cr-table-scroll cr-desktop"><div className="cr-table-grid cr-table-head">{Array.from({ length: 7 }, (_, i) => <div key={i} className="cds-loading-skeleton-line cr-skeleton-cell" />)}</div>
        {Array.from({ length: 5 }, (_, row) => <div key={row} className="cr-table-grid cr-task-row cr-skeleton-row">{Array.from({ length: 7 }, (_, column) => <div key={column} className="cds-loading-skeleton-line cr-skeleton-cell" />)}</div>)}
      </div>
      <div className="cr-mobile">{Array.from({ length: 3 }, (_, row) => <div key={row} className="cr-mobile-task"><div className="cds-loading-skeleton-line cr-skeleton-cell" /><div className="cds-loading-skeleton-line cr-skeleton-cell" /></div>)}</div>
    </section>
  </div>;
}
