import type { ReactNode } from 'react';
import { Database } from 'lucide-react';

export function DtsHeading({ selector }: { selector: ReactNode }): JSX.Element {
  return <div className="flex flex-wrap items-start justify-between gap-4"><div><h1 className="text-2xl font-semibold flex items-center gap-2"><Database />数据同步</h1><p className="mt-2 text-sm text-muted-foreground">选择正式与备用环境，先比较，再按规则同步。</p></div>{selector}</div>;
}
export function DtsBodySkeleton(): JSX.Element {
  return <div className="space-y-6" role="status" aria-label="正在加载数据同步">
    {[200, 130, 180].map(h => <div key={h} className="space-y-4 rounded-lg border border-input p-5" style={{ minHeight: h }}><div className="cds-loading-skeleton-line h-5 w-40" /><div className="grid grid-cols-2 gap-4"><div className="cds-loading-skeleton-line h-9 w-full" /><div className="cds-loading-skeleton-line h-9 w-full" /></div></div>)}
    <span className="sr-only">正在加载连接和同步任务</span>
  </div>;
}
export function DtsSkeleton(): JSX.Element {
  return <div className="mx-auto max-w-5xl space-y-6 py-6"><DtsHeading selector={<label className="min-w-56 text-sm">所属项目<select aria-label="所属项目" disabled className="w-full rounded-md border border-input bg-background p-2 text-sm"><option>选择项目</option></select></label>} /><DtsBodySkeleton /></div>;
}
