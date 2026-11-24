export const REPORTS_LEDGER = {
  toolbar: 'shrink-0 flex flex-wrap items-center gap-3',
  viewSwitch: 'inline-flex gap-1 rounded-md border border-[hsl(var(--hairline))] p-1',
  frame: 'mt-1 overflow-hidden rounded-[0.625rem] border border-[hsl(var(--hairline))] bg-card',
  heading: 'flex flex-col gap-2 border-b border-[hsl(var(--hairline))] bg-[hsl(var(--surface-sunken))] px-3 py-2.5',
  table: 'block w-full table-fixed border-collapse text-base lg:table lg:min-w-[72rem]',
  columnWidths: ['w-[9%]', 'w-[30%]', 'w-[5%]', 'w-[10%]', 'w-[22%]', 'w-[18%]', 'w-[6%]'],
  row: 'group flex flex-col gap-2 border-t border-[hsl(var(--hairline))] p-3 align-top lg:table-row lg:p-0',
} as const;

export function ReportsSkeleton({ overview = false }: { overview?: boolean }): JSX.Element {
  return <div className="flex min-w-0 flex-col gap-3" role="status" aria-label="正在加载验收报告" aria-busy="true" data-reports-skeleton>
    <div className={REPORTS_LEDGER.toolbar} aria-hidden="true">
      <div className={REPORTS_LEDGER.viewSwitch}><span className="cds-loading-skeleton-panel h-8 w-12 rounded-md" /><span className="cds-loading-skeleton-panel h-8 w-[4.5rem] rounded-md" /></div>
      <span className="cds-loading-skeleton-line h-4 w-16" />
      <span className="cds-loading-skeleton-panel h-8 w-[4.625rem] rounded-md" />
    </div>
    {overview ? <div className="cds-loading-skeleton-panel h-44 rounded-lg" aria-hidden="true" /> : null}
    <section className={REPORTS_LEDGER.frame} aria-hidden="true">
      <header className={REPORTS_LEDGER.heading}>
        <div className="flex flex-wrap items-center gap-2">
          <span className="cds-loading-skeleton-line my-1.5 h-4 w-16" /><span className="flex-1" />
          <span className="cds-loading-skeleton-line h-4 w-[7.75rem]" />
          <span className="cds-loading-skeleton-panel h-7 w-[12.5rem] rounded-md" />
        </div>
        <div className="flex min-w-0 flex-wrap items-center gap-0.5">
          <span className="cds-loading-skeleton-panel h-[1.875rem] w-14 rounded-md" /><span className="cds-loading-skeleton-panel h-[1.875rem] w-20 rounded-md" />
        </div>
      </header>
      <div className="overflow-x-auto">
        <table className={REPORTS_LEDGER.table}>
          <thead className="hidden lg:table-header-group">
            <tr className="bg-[hsl(var(--surface-sunken))]">{REPORTS_LEDGER.columnWidths.map((width, index) => <th key={width} className={`${width} px-3 py-2.5`}><div className={`cds-loading-skeleton-line h-3 ${index === 1 ? 'w-40' : 'w-10'} max-w-full`} /></th>)}</tr>
          </thead>
          <tbody className="block lg:table-row-group">
            {Array.from({ length: 8 }, (_, index) => <tr key={index} className={`${REPORTS_LEDGER.row} min-h-[13.75rem] lg:min-h-0`}>
              <td className="hidden lg:table-cell lg:px-3 lg:py-3"><div className="cds-loading-skeleton-line h-4 w-14" /></td>
              <td className="order-first block min-w-0 lg:order-none lg:table-cell lg:px-3 lg:py-3"><div className="flex h-6 items-center"><div className="cds-loading-skeleton-line h-4 w-56 max-w-full" /></div><div className="cds-loading-skeleton-panel mt-0.5 h-6 w-[3.75rem] rounded" /></td>
              <td className="flex h-7 flex-wrap items-center gap-2 lg:hidden"><div className="cds-loading-skeleton-line h-4 w-14" /><div className="cds-loading-skeleton-panel h-5 w-12 rounded" /><div className="cds-loading-skeleton-panel h-5 w-24 rounded" /></td>
              <td className="hidden lg:table-cell lg:px-3 lg:py-3"><div className="cds-loading-skeleton-panel h-5 w-6 rounded" /></td>
              <td className="hidden lg:table-cell lg:px-3 lg:py-3"><div className="cds-loading-skeleton-line h-4 w-24 max-w-full" /></td>
              <td className="flex h-6 min-w-0 flex-wrap items-center gap-1 lg:hidden"><div className="cds-loading-skeleton-line h-3 w-16" /><div className="cds-loading-skeleton-panel h-5 w-28 rounded" /><div className="cds-loading-skeleton-panel h-5 w-16 rounded" /></td>
              <td className="hidden min-w-0 lg:table-cell lg:px-3 lg:py-3"><div className="flex gap-1"><div className="cds-loading-skeleton-panel h-6 w-28 rounded" /><div className="cds-loading-skeleton-panel h-6 w-16 rounded" /></div></td>
              <td className="mt-2 flex h-10 items-center justify-between gap-2 lg:hidden"><div className="cds-loading-skeleton-line h-3 w-36" /><div className="cds-loading-skeleton-panel mr-2 h-8 w-8 rounded" /></td>
              <td className="hidden lg:table-cell lg:px-3 lg:py-3"><div className="cds-loading-skeleton-line h-3 w-28" /></td>
              <td className="hidden lg:table-cell lg:px-2 lg:py-2"><div className="cds-loading-skeleton-panel ml-auto h-8 w-8 rounded" /></td>
            </tr>)}
          </tbody>
        </table>
      </div>
    </section>
  </div>;
}
