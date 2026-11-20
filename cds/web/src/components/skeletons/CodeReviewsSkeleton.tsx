import '../../pages/code-reviews/review-design.css';

const reviewColumns = [true, true, true, true, true, false, false];

export function CodeReviewsSkeleton({ detail = false, listOnly = false }: { detail?: boolean; listOnly?: boolean }): JSX.Element {
  if (detail) {
    return <div role="status" aria-label="正在读取审查报告" aria-busy="true" className="cr-stack cr-reader" data-code-reviews-skeleton>
      <div className="cds-loading-skeleton-line cr-back w-28" aria-hidden />
      <header className="cr-page-header" aria-hidden>
        <div className="cr-page-title"><div className="cds-loading-skeleton-line cr-skeleton-title" /><div className="cds-loading-skeleton-line h-4 w-14" /></div>
        <div className="cr-page-actions"><div className="cds-loading-skeleton-panel cr-skeleton-control cr-skeleton-download" /></div>
      </header>
      <div className="cr-source-meta cr-skeleton-meta" aria-hidden>
        <div className="cds-loading-skeleton-line h-4 w-20" />
        <div className="cds-loading-skeleton-line h-4 w-52" />
        <div className="cr-skeleton-meta-date"><div className="cds-loading-skeleton-line h-4 w-32" /></div>
      </div>
      <div className="cr-coverage cr-skeleton-coverage" aria-hidden><div className="cds-loading-skeleton-line h-4 w-64 max-w-full" /><div className="cds-loading-skeleton-line h-3 w-96 max-w-full" /></div>
      <div className="cr-tabs cr-skeleton-tabs" aria-hidden>{[0, 1, 2].map(tab => <div key={tab} className="cds-loading-skeleton-line mx-2 h-4 w-16" />)}</div>
      <div className="cr-surface h-56 p-4" aria-hidden><div className="cds-loading-skeleton-line h-4 w-44" /></div>
    </div>;
  }
  return <div role="status" aria-label="正在读取代码审查" aria-busy="true" className="cr-stack" data-code-reviews-skeleton>
    {!listOnly && <>
      <header className="cr-page-header" aria-hidden>
        <div className="min-w-0 flex-1"><div className="cds-loading-skeleton-line cr-skeleton-title" /><div className="cds-loading-skeleton-line cr-skeleton-subtitle" /></div>
        <div className="cr-page-actions">
          <div className="cds-loading-skeleton-panel cr-skeleton-control cr-desktop w-[7.8rem]" />
          <div className="cds-loading-skeleton-panel cr-skeleton-control w-[5.75rem]" />
          <div className="cds-loading-skeleton-panel cr-skeleton-control w-[7.25rem]" />
          <div className="cds-loading-skeleton-panel cr-skeleton-control cr-mobile w-[3.235294rem]" />
        </div>
      </header>
      <section className="cr-filters" aria-hidden>
        <div className="cr-segment cr-skeleton-segment">
          {[0, 1, 2].map(source => <div key={source} className="cds-loading-skeleton-line flex-1 rounded" />)}
        </div>
        <span className="cr-filter-divider cr-desktop" />
        <div className="cds-loading-skeleton-panel cr-input cr-skeleton-control cr-filter-project" />
        <div className="cds-loading-skeleton-panel cr-input cr-skeleton-control cr-filter-state" />
        <div className="cds-loading-skeleton-panel cr-input cr-skeleton-control cr-filter-query" />
        <div className="cds-loading-skeleton-panel cr-skeleton-control cr-end w-[6.6rem]" />
      </section>
    </>}
    <section className="cr-surface" aria-hidden="true">
      <div className="cr-table-scroll cr-desktop"><div className="cr-table-grid cr-table-head">{Array.from({ length: 7 }, (_, i) => <div key={i} className="cds-loading-skeleton-line cr-skeleton-cell" />)}</div>
        {Array.from({ length: 5 }, (_, row) => <div key={row} className="cr-table-grid cr-task-row cr-skeleton-row">{reviewColumns.map((secondary, column) => <span key={column} className="space-y-2"><span className="cds-loading-skeleton-line block cr-skeleton-cell" />{secondary && <span className="cds-loading-skeleton-line block h-3 w-1/2" />}</span>)}</div>)}
      </div>
      <div className="cr-mobile">{Array.from({ length: 5 }, (_, row) => <div key={row} className="cr-mobile-task cr-skeleton-mobile-task">
        <div className="cr-mobile-task-title"><div className="cds-loading-skeleton-line cr-skeleton-cell" /><div className="cds-loading-skeleton-line h-4 w-14" /></div>
        <div className="cds-loading-skeleton-line h-5 w-40" />
        <div className="cds-loading-skeleton-line h-5 w-20" />
        <div className="cr-row-inline"><div className="cds-loading-skeleton-line h-5 w-24" /><div className="cds-loading-skeleton-line h-5 w-20" /></div>
        <div className="cr-row-inline"><div className="cds-loading-skeleton-line h-4 w-32" /><div className="cds-loading-skeleton-line cr-end h-5 w-16" /></div>
      </div>)}</div>
      <div className="cr-pagination"><div className="cds-loading-skeleton-line h-3 w-36" /></div>
    </section>
    <div className="cr-list-scope" aria-hidden><div className="cds-loading-skeleton-line h-4 w-80 max-w-full" /></div>
  </div>;
}
