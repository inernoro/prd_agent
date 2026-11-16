import { ContentLoading } from './ContentLoading';
import { LoadingBlock } from '@/pages/cds-settings/components';

/** 保留发布中心分区导航槽；代码与数据等待共用整段，不在挂载后把横条向下推。 */
export function ReleaseCenterSkeleton(): JSX.Element {
  return <div className="flex h-full min-h-0 flex-col" data-release-center-skeleton>
    <div className="flex shrink-0 flex-wrap gap-1.5 border-b border-[hsl(var(--hairline))] px-6 py-2.5" aria-hidden="true">
      {[0, 1, 2, 3, 4].map(i => <div key={i} className="cds-loading-skeleton-panel h-8 w-28 rounded-lg" />)}
    </div>
    <div className="min-h-0 flex-1 p-6"><LoadingBlock label="正在加载发布环境" /></div>
  </div>;
}

/** 拓扑指标栏还没取到数据时不能先画零值，再把骨架推到指标栏下面。 */
export function TopologyPageSkeleton(): JSX.Element {
  return <div data-topology-page-skeleton>
    <div className="cds-surface-raised cds-hairline mb-4 grid gap-3 px-4 py-4 md:grid-cols-2 xl:grid-cols-5" aria-hidden="true">
      {[0, 1, 2, 3, 4].map(i => <div key={i} className="space-y-3 rounded-md border border-border bg-background px-3 py-3">
        <div className="cds-loading-skeleton-line h-3 w-20" /><div className="cds-loading-skeleton-line h-7 w-16" /><div className="cds-loading-skeleton-line h-3 w-28 max-w-full" />
      </div>)}
    </div>
    <LoadingBlock label="加载服务拓扑" />
  </div>;
}

export function AgentRequestsSkeleton(): JSX.Element {
  return <div className="flex flex-col gap-4" data-agent-requests-skeleton>
    <div className="cds-loading-skeleton-panel h-[3.125rem] rounded-lg border border-border" aria-hidden="true" />
    <ContentLoading label="加载 Agent 请求" variant="table" />
  </div>;
}
