export function DtsSkeleton(): JSX.Element {
  return <div className="mx-auto max-w-5xl space-y-6 py-6" role="status" aria-label="正在加载数据同步">
    <div className="cds-loading-skeleton-line h-8 w-48" />
    {[200, 130, 180].map(h => <div key={h} className="space-y-4 rounded-lg border border-input p-5" style={{ minHeight: h }}><div className="cds-loading-skeleton-line h-5 w-40" /><div className="grid grid-cols-2 gap-4"><div className="cds-loading-skeleton-line h-9 w-full" /><div className="cds-loading-skeleton-line h-9 w-full" /></div></div>)}
    <span className="sr-only">正在加载连接和同步任务</span>
  </div>;
}
