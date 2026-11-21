import '@/pages/status/status-home.css';
import '@/pages/status/project-status.css';

export function ProjectStatusSkeleton(): JSX.Element {
  return <div className="status-home project-status-page" role="status" aria-busy="true" aria-label="加载项目检查与通知" data-project-status-skeleton>
    <header className="status-home-panel" aria-hidden="true">
      <div className="project-status-title">
        <div className="min-w-0">
          <p className="status-home-muted"><span className="cds-loading-skeleton-line inline-block h-3.5 w-24 align-middle" /></p>
          <h1><span className="cds-loading-skeleton-line inline-block h-6 w-56 max-w-full align-middle" /></h1>
        </div>
        <span className="cds-loading-skeleton-panel size-8 shrink-0 rounded" />
      </div>
      <p><span className="cds-loading-skeleton-line inline-block h-4 w-[32rem] max-w-full align-middle" /><span className="cds-loading-skeleton-line inline-block h-4 w-4/5 align-middle sm:hidden" /></p>
      <div className="project-status-stats">
        {['w-16', 'w-20', 'w-28', 'w-36'].map(width => <div key={width}>
          <strong><span className="cds-loading-skeleton-line inline-block h-6 w-8 align-middle" /></strong>
          <span className={`cds-loading-skeleton-line inline-block h-4 max-w-full align-middle ${width}`} />
        </div>)}
      </div>
      <div className="project-status-notice-summary">
        <span className="cds-loading-skeleton-line inline-block h-4 w-[42rem] max-w-full align-middle" />
        <span className="cds-loading-skeleton-line inline-block h-4 w-2/3 align-middle sm:hidden" />
      </div>
      <p className="status-home-muted"><span className="cds-loading-skeleton-line inline-block h-3.5 w-[32rem] max-w-full align-middle" /><span className="cds-loading-skeleton-line inline-block h-3.5 w-2/3 align-middle sm:hidden" /></p>
    </header>
    <div className="project-status-shortcuts" aria-hidden="true">
      {['w-[6.25rem]', 'w-[6.25rem]', 'w-[6.25rem]', 'w-[6.25rem]', 'w-[7.25rem]'].map((width, i) => <div className={width} key={i}>
        <span className="cds-loading-skeleton-line inline-block h-4 w-full align-middle" />
      </div>)}
    </div>
    <section className="status-home-panel" aria-hidden="true">
      <div className="status-home-section-heading"><h2><span className="cds-loading-skeleton-line inline-block h-5 w-28 align-middle" /></h2><span className="cds-loading-skeleton-panel h-[3.25rem] w-44 max-w-full rounded-md" /></div>
      <p><span className="cds-loading-skeleton-line inline-block h-4 w-[32rem] max-w-full align-middle" /></p>
      <div className="project-status-search h-[3.25rem]"><div className="cds-loading-skeleton-line h-4 w-1/2" /></div>
      <p><span className="cds-loading-skeleton-line inline-block h-4 w-48 max-w-full align-middle" /></p>
    </section>
    <section className="status-home-panel" aria-hidden="true">
      <h2><span className="cds-loading-skeleton-line inline-block h-5 w-48 align-middle" /></h2>
      <p><span className="cds-loading-skeleton-line inline-block h-4 w-[32rem] max-w-full align-middle" /></p>
      <p><span className="cds-loading-skeleton-line inline-block h-4 w-56 max-w-full align-middle" /></p>
    </section>
  </div>;
}
