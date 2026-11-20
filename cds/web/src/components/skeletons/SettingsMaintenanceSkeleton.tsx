export function SettingsMaintenanceStatusSkeleton(): JSX.Element {
  return <div role="status" aria-label="读取自更新状态" aria-busy="true" className="rounded-md border border-border bg-card px-4 py-3">
    <div aria-hidden className="flex min-h-7 flex-wrap items-center gap-x-3 gap-y-2">
      <div className="cds-loading-skeleton-line h-4 w-16" />
      <div className="cds-loading-skeleton-line h-5 w-24" />
      <div className="cds-loading-skeleton-panel h-5 w-44 rounded-md" />
      <div className="cds-loading-skeleton-panel ml-auto h-8 w-[4.75rem] rounded-md" />
    </div>
  </div>;
}

export function SettingsMaintenanceControlsSkeleton(): JSX.Element {
  return <div role="status" aria-label="读取 CDS 源码分支" aria-busy="true" className="cds-update-controls rounded-md border border-border bg-card p-3">
    <div aria-hidden className="space-y-2">
      <div className="cds-loading-skeleton-line h-5 w-36" />
      <div className="cds-loading-skeleton-line h-4 w-64 max-w-full" />
    </div>
    <div aria-hidden className="mt-3 space-y-1.5">
      <div className="cds-loading-skeleton-line h-4 w-16" />
      <div className="flex gap-2">
        <div className="cds-loading-skeleton-panel h-8 min-w-0 flex-1 rounded-md" />
        <div className="cds-loading-skeleton-panel h-8 w-24 rounded-md" />
      </div>
    </div>
    <div aria-hidden className="mt-3 flex gap-2">
      <div className="cds-loading-skeleton-panel h-8 w-[4.5rem] rounded-md" />
      <div className="cds-loading-skeleton-panel h-8 w-24 rounded-md" />
    </div>
  </div>;
}

export function SettingsMaintenanceSkeleton(): JSX.Element {
  return <div role="status" aria-label="加载 CDS 更新设置" aria-busy="true" data-settings-content-skeleton>
    <div aria-hidden className="flex h-7 items-center"><div className="cds-loading-skeleton-line h-4 w-28" /></div>
    <div aria-hidden className="mt-1 flex min-h-5 items-center"><div className="cds-loading-skeleton-line h-3 w-96 max-w-full" /></div>
    <div className="mt-3 space-y-3">
      <SettingsMaintenanceStatusSkeleton />
      <SettingsMaintenanceControlsSkeleton />
    </div>
  </div>;
}
