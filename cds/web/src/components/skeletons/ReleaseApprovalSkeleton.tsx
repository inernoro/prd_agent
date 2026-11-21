export const APPROVAL_INBOX_CLASS = 'mx-auto w-full max-w-6xl px-4 py-4 sm:px-6 sm:py-7';
export const APPROVAL_ROWS_CLASS = 'cds-surface-raised cds-hairline min-w-0 rounded-xl';
export const APPROVAL_FILTERS_CLASS = 'flex flex-wrap gap-1 border-b border-[hsl(var(--hairline))] px-3 py-2.5';
export const APPROVAL_ROW_CLASS = 'grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-2 px-4 py-3 sm:grid-cols-[minmax(0,1fr)_10rem_10rem_auto] sm:px-5';
export const APPROVAL_DIALOG_WIDTH = 'min(40rem, calc(100vw - 1rem))';
export const APPROVAL_DIALOG_HEADER_CLASS = 'shrink-0 border-b border-[hsl(var(--hairline))] px-4 py-3 pr-10 sm:px-6 sm:py-4 sm:pr-12';
export const APPROVAL_DIALOG_BODY_CLASS = 'min-h-0 flex-1 space-y-3 overflow-y-auto px-4 py-4 sm:px-6';
export const APPROVAL_DIALOG_FOOTER_CLASS = 'shrink-0 space-y-2 border-t border-[hsl(var(--hairline))] px-4 py-3 sm:px-6';

export function ReleaseApprovalSkeleton({ hasScope = false }: { hasScope?: boolean }): JSX.Element {
  return <div className={APPROVAL_INBOX_CLASS} role="status" aria-busy="true" aria-label="读取环境审批列表" data-release-approval-skeleton>
    <div aria-hidden="true">
      <div className="mb-4 flex justify-end"><span className="cds-loading-skeleton-panel h-8 w-24 rounded-md" /></div>
      <header className="mb-5">
        <div className="cds-loading-skeleton-line h-4 w-28" />
        <div className="mt-1 flex h-8 items-center"><div className="cds-loading-skeleton-line h-6 w-28" /></div>
        <div className="mt-1.5 flex h-5 items-center"><div className="cds-loading-skeleton-line h-3 w-80 max-w-full" /></div>
      </header>
      {hasScope ? <div className={APPROVAL_ROWS_CLASS}>
        <div className={APPROVAL_FILTERS_CLASS}>
          {[0, 1, 2].map(i => <span key={i} className="cds-loading-skeleton-panel h-8 w-[5.5rem] rounded-md" />)}
        </div>
        <div className="divide-y divide-[hsl(var(--hairline))]">
          {[0, 1, 2].map(i => <div className={APPROVAL_ROW_CLASS} key={i}>
            <div className="grid min-w-0 gap-1">
              <div className="flex h-6 items-center gap-2"><span className="cds-loading-skeleton-line h-4 w-24" /><span className="cds-loading-skeleton-line h-4 w-16 rounded-full" /></div>
              <div className="flex h-5 items-center"><span className="cds-loading-skeleton-line h-3 w-full max-w-64" /></div>
              <div className="flex h-4 items-center"><span className="cds-loading-skeleton-line h-2.5 w-40 max-w-full" /></div>
            </div>
            <div className="col-start-1 row-start-2 flex h-4 items-center sm:col-auto sm:row-auto"><span className="cds-loading-skeleton-line h-3 w-28 sm:w-20" /></div>
            <div className="hidden h-4 items-center sm:flex"><span className="cds-loading-skeleton-line h-3 w-24" /></div>
            <span className="cds-loading-skeleton-line col-start-2 row-start-1 h-4 w-4 sm:col-auto sm:row-auto sm:w-20" />
          </div>)}
        </div>
      </div> : <div className="cds-loading-skeleton-line h-4 w-80 max-w-full" />}
    </div>
  </div>;
}

export function ReleaseApprovalDetailSkeleton(): JSX.Element {
  return <div className="contents" role="status" aria-busy="true" aria-label="读取这笔发布审批" data-release-approval-detail-skeleton>
    <div className={APPROVAL_DIALOG_BODY_CLASS} aria-hidden="true">
      <div className="grid grid-cols-2 gap-x-3 gap-y-2.5">
        {[0, 1, 2, 3].map(i => <div key={i} className={i < 2 ? 'min-w-0' : 'col-span-2 min-w-0'}>
          <div className="flex h-4 items-center"><span className="cds-loading-skeleton-line h-2.5 w-20" /></div>
          <div className="flex h-5 items-center"><span className="cds-loading-skeleton-line h-3 w-36 max-w-full" /></div>
        </div>)}
      </div>
      <div className="cds-loading-skeleton-panel h-9 rounded-md border border-[hsl(var(--hairline))]" />
    </div>
    <div className={APPROVAL_DIALOG_FOOTER_CLASS} aria-hidden="true">
      <div className="flex h-5 items-center"><div className="cds-loading-skeleton-line h-3 w-64 max-w-full" /></div>
      <div className="flex flex-wrap justify-end gap-2">
        {[0, 1, 2].map(i => <div key={i} className="cds-loading-skeleton-panel h-9 w-[4.25rem] rounded-md" />)}
      </div>
    </div>
  </div>;
}
