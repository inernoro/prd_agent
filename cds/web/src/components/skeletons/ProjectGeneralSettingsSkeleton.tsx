function FieldPlaceholder({ tall = false }: { tall?: boolean }): JSX.Element {
  return <div className="space-y-1.5">
    <div className="flex h-5 items-center"><span className="cds-loading-skeleton-line h-3 w-24" /></div>
    <div className={`cds-loading-skeleton-panel rounded-md border border-input ${tall ? 'min-h-24' : 'h-10'}`} />
  </div>;
}

export function ProjectGeneralSettingsSkeleton(): JSX.Element {
  return <div className="space-y-8" aria-hidden="true">
    <div className="border-b border-border pb-5">
      <div className="flex h-7 items-center"><div className="cds-loading-skeleton-line h-4 w-28" /></div>
      <div className="mt-1 flex min-h-5 max-w-3xl flex-col justify-center gap-2 max-sm:min-h-10">
        <div className="cds-loading-skeleton-line h-3 w-[27rem] max-w-full" />
        <div className="cds-loading-skeleton-line h-3 w-36 sm:hidden" />
      </div>
      <div className="cds-settings-columns mt-3">
        <div className="cds-settings-form-col space-y-4">
          <FieldPlaceholder />
          <div className="space-y-3 rounded-lg border border-border bg-muted/20 p-4">
            <FieldPlaceholder />
            <div className="flex min-h-4 flex-col justify-center gap-1.5 max-sm:min-h-8">
              <div className="cds-loading-skeleton-line h-2.5 w-4/5" />
              <div className="cds-loading-skeleton-line h-2.5 w-3/5 sm:hidden" />
            </div>
          </div>
          <div className="flex h-[2.625rem] items-center rounded-lg border border-border px-3"><div className="cds-loading-skeleton-line h-3 w-24" /></div>
          <FieldPlaceholder tall />
          <FieldPlaceholder />
          {[0, 1].map(i => <div key={i} className="cds-surface-raised cds-hairline flex max-w-3xl items-start gap-3 px-3 py-3">
            <span className="cds-loading-skeleton-panel mt-1 size-4 shrink-0 rounded" />
            <div className="grid min-w-0 flex-1 gap-1"><div className="flex h-5 items-center"><span className="cds-loading-skeleton-line h-3 w-40 max-w-full" /></div><div className="flex h-5 items-center"><span className="cds-loading-skeleton-line h-3 w-5/6" /></div></div>
          </div>)}
          <div className="cds-surface-raised cds-hairline max-w-3xl space-y-3 px-3 py-3">
            <div className="flex h-7 items-center justify-between"><span className="cds-loading-skeleton-line h-4 w-24" /><span className="cds-loading-skeleton-panel h-7 w-24 rounded-md" /></div>
            <div className="grid gap-2 sm:grid-cols-3">
              {[0, 1, 2].map(i => <div key={i} className="cds-loading-skeleton-panel h-[2.375rem] rounded-md" />)}
            </div>
          </div>
          <div className="cds-loading-skeleton-panel h-9 w-24 rounded-md" />
        </div>
        <div className="cds-settings-aside-col">
          <div className="cds-surface-raised cds-hairline rounded-lg p-4">
            <div className="mb-3 flex h-4 items-center"><span className="cds-loading-skeleton-line h-3 w-16" /></div>
            <div className="grid gap-2.5">{[0, 1, 2].map(i => <div key={i} className="flex h-4 items-center justify-between gap-3"><span className="cds-loading-skeleton-line h-3 w-16" /><span className="cds-loading-skeleton-line h-3 w-24" /></div>)}</div>
          </div>
          <div className="space-y-1.5 rounded-lg border border-warn/35 bg-warn-soft p-4">
            <div className="flex h-4 items-center"><span className="cds-loading-skeleton-line h-3 w-16" /></div>
            <div className="space-y-2.5 py-1"><div className="cds-loading-skeleton-line h-3 w-full" /><div className="cds-loading-skeleton-line h-3 w-3/4" /></div>
          </div>
        </div>
      </div>
    </div>
    <div className="space-y-3">
      <div className="cds-loading-skeleton-line h-4 w-24" />
      <div className="cds-loading-skeleton-line h-3 w-72 max-w-full" />
    </div>
  </div>;
}
