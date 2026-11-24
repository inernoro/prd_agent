export { ReleaseCenterSkeleton } from './ReleaseCenterSkeleton';
export const TOPOLOGY_CONTROLS_CLASS = 'cds-surface-raised cds-hairline mb-4 overflow-hidden';
export const TOPOLOGY_FILTER_GRID_CLASS = 'grid gap-3 lg:grid-cols-[13.75rem_minmax(16.25rem,1fr)_minmax(16.25rem,26.25rem)] lg:items-center';
export const TOPOLOGY_CONTROL_HEIGHT = 44;
export const TOPOLOGY_BODY_GRID_CLASS = 'xl:grid-cols-[minmax(0,1fr)_21.25rem]';
export const TOPOLOGY_NODE_GRID_CLASS = 'grid gap-3 md:grid-cols-2 2xl:grid-cols-3';
export const TOPOLOGY_BAND_CLASS = 'rounded-md border border-border bg-background/40 p-4';
export const BRANCH_RELATIONS_LAYOUT_CLASS = 'flex h-full min-h-0 flex-col gap-3';
export const BRANCH_RELATIONS_CANVAS_CLASS = 'cds-hairline flex min-h-0 flex-1 flex-col overflow-hidden rounded-lg bg-[hsl(var(--surface-base))]';

export function TopologyPageSkeleton(): JSX.Element {
  return <div role="status" aria-busy="true" aria-label="加载服务拓扑" data-topology-page-skeleton>
    <div aria-hidden className={TOPOLOGY_CONTROLS_CLASS}>
      <div className="space-y-2 px-4 py-3">
        <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
          {['w-44', 'w-36', 'w-40'].map(w => <div key={w} className={`flex h-5 items-center gap-2 ${w}`}>
            <div className="cds-loading-skeleton-line h-3 w-12" />
            <div className="cds-loading-skeleton-line h-3 flex-1" />
          </div>)}
        </div>
        <div className="flex h-5 items-center"><div className="cds-loading-skeleton-line h-3 w-[26rem] max-w-full" /></div>
      </div>
      <div className="space-y-3 border-t border-border px-4 py-3">
        <div className={TOPOLOGY_FILTER_GRID_CLASS}>
          <div className="cds-loading-skeleton-panel rounded-md border border-input" style={{ height: TOPOLOGY_CONTROL_HEIGHT }} />
          <div className="grid gap-1 sm:grid-cols-[3.25rem_minmax(0,1fr)] sm:items-center">
            <div className="flex h-4 items-center"><div className="cds-loading-skeleton-line h-3 w-8" /></div>
            <div className="cds-loading-skeleton-panel rounded-md border border-input" style={{ height: TOPOLOGY_CONTROL_HEIGHT }} />
          </div>
          <div className="flex items-center" style={{ height: TOPOLOGY_CONTROL_HEIGHT }}><div className="cds-loading-skeleton-line h-3.5 w-32" /></div>
        </div>
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex h-5 items-center"><div className="cds-loading-skeleton-line h-3 w-[26rem] max-w-full" /></div>
          <div className="cds-loading-skeleton-panel h-8 rounded-md sm:w-24" />
        </div>
      </div>
    </div>
    <div aria-hidden className={`grid gap-4 ${TOPOLOGY_BODY_GRID_CLASS}`}>
      <div className="cds-surface-raised cds-hairline min-w-0 space-y-8 p-4 xl:min-h-[38.75rem]">
        {['应用服务', '基础设施'].map((band, index) => <section key={band} className={TOPOLOGY_BAND_CLASS}>
          <div className="mb-4 flex flex-wrap items-center gap-3">
            <div className="cds-loading-skeleton-panel h-8 w-8 rounded-md" />
            <div className="space-y-1.5">
              <h2 className="text-sm font-semibold">{band}</h2>
              <div className="cds-loading-skeleton-line h-3 w-28" />
            </div>
            {index === 1 ? <div className="cds-loading-skeleton-panel ml-auto h-8 w-24 rounded-md" /> : null}
          </div>
          {index === 0 ? <div className={TOPOLOGY_NODE_GRID_CLASS}>
            {[0, 1].map(node => <div className="rounded-md border border-border bg-background px-4 py-3" key={node}>
              <div className="mb-3 flex min-h-11 items-start gap-3">
                <div className="cds-loading-skeleton-panel h-8 w-8 shrink-0 rounded-md" />
                <div className="flex-1 space-y-1.5">
                  <div className="cds-loading-skeleton-line h-4 w-16" />
                  <div className="cds-loading-skeleton-line h-3 w-12" />
                </div>
                <div className="cds-loading-skeleton-line h-4 w-12" />
              </div>
              <div className="grid grid-cols-3 gap-2">
                {[0, 1, 2].map(metric => <div key={metric} className="cds-surface-sunken cds-hairline space-y-0.5 px-2 py-2">
                  <div className="flex h-4 items-center"><div className="cds-loading-skeleton-line h-2.5 w-8" /></div>
                  <div className="flex h-4 items-center"><div className="cds-loading-skeleton-line h-3 w-6" /></div>
                </div>)}
              </div>
              <div className="mt-3 space-y-1.5">
                <div className="cds-loading-skeleton-line h-4 w-24" />
                <div className="cds-loading-skeleton-line h-5 w-16" />
              </div>
              <div className="cds-loading-skeleton-line mt-3 h-1.5 w-full" />
              <div className="cds-loading-skeleton-line mt-3 h-5 w-20" />
            </div>)}
          </div> : <div className="space-y-3 rounded-md border border-dashed border-border px-4 py-8">
            <div className="cds-loading-skeleton-line h-5 w-48 max-w-full" />
            <div className="cds-loading-skeleton-panel h-8 w-36 max-w-full rounded-md" />
          </div>}
        </section>)}
      </div>
      <div className="cds-surface-raised cds-hairline hidden min-h-[38.75rem] space-y-4 p-4 xl:block">
        <div className="flex gap-3">
          <div className="cds-loading-skeleton-panel h-9 w-9 rounded-md" />
          <div className="space-y-2"><div className="cds-loading-skeleton-line h-5 w-24" /><div className="cds-loading-skeleton-line h-3 w-32" /></div>
        </div>
        <div className="grid grid-cols-2 gap-3">{[0, 1, 2, 3].map(i => <div key={i} className="space-y-1.5">
          <div className="cds-loading-skeleton-line h-3 w-12" />
          <div className="cds-loading-skeleton-line h-4 w-20" />
        </div>)}</div>
        <div className="space-y-1.5 border-t border-border pt-4">
          <div className="cds-loading-skeleton-line h-3 w-8" />
          <div className="cds-loading-skeleton-line h-4 w-24" />
        </div>
        {[0, 1, 2, 3].map(i => <div key={i} className="space-y-1.5 rounded-md border border-border bg-background px-3 py-2.5">
          <div className="cds-loading-skeleton-line h-4 w-20" />
          <div className="cds-loading-skeleton-line h-3 w-28" />
        </div>)}
      </div>
    </div>
  </div>;
}

export function BranchRelationsSkeleton(): JSX.Element {
  return <div role="status" aria-busy="true" aria-label="读取服务关系" className={BRANCH_RELATIONS_LAYOUT_CLASS} data-branch-relations-skeleton>
    <div className="flex min-h-4 shrink-0 items-center" aria-hidden><div className="cds-loading-skeleton-line h-3 w-[42rem] max-w-full" /></div>
    <div className={BRANCH_RELATIONS_CANVAS_CLASS} aria-hidden>
      <div className="relative min-h-0 flex-1 overflow-hidden bg-[radial-gradient(hsl(var(--hairline))_1px,transparent_1px)] bg-[size:1.625rem_1.625rem] px-4 py-5 sm:px-6">
        <div className="mx-auto w-full max-w-[20rem] rounded-lg border border-border bg-background p-3 sm:w-60">
          <div className="cds-loading-skeleton-line h-4 w-16" />
          <div className="cds-loading-skeleton-line mt-1.5 h-3 w-32" />
        </div>
        <div className="mx-auto h-4 w-px bg-border" />
        <div className="mx-auto grid w-full max-w-[78rem] gap-3 rounded-lg border border-border bg-background/40 p-3 sm:grid-cols-3">
          {[0, 1, 2].map(i => <div key={i} className="mx-auto w-full max-w-[20rem] rounded-lg border border-border bg-background p-3">
            <div className="cds-loading-skeleton-line h-4 w-24" />
            <div className="cds-loading-skeleton-line mt-1.5 h-3 w-3/4" />
          </div>)}
        </div>
      </div>
      <div className="hidden h-10 shrink-0 items-center gap-5 border-t border-[hsl(var(--hairline))] px-[1.375rem] sm:flex">
        {[0, 1, 2, 3, 4, 5].map(i => <div className="cds-loading-skeleton-line h-3 w-24" key={i} />)}
      </div>
    </div>
  </div>;
}

export const AGENT_REQUEST_FILTERS_CLASS = 'flex flex-wrap items-center gap-2 rounded-lg border border-border bg-card px-3 py-2';
export const AGENT_REQUEST_FILTER_CLASS = 'h-8 rounded-md border border-border bg-background px-2 text-xs';
export const AGENT_REQUEST_SEARCH_CLASS = 'relative min-w-[11.25rem] flex-1';
export const AGENT_REQUEST_ROW_CLASS = 'rounded-lg border bg-card';
export const AGENT_REQUEST_ROW_BODY_CLASS = 'w-full px-3 py-2.5 text-left';
export const AGENT_REQUEST_ROW_META_CLASS = 'flex flex-wrap items-center gap-2';
export const AGENT_REQUEST_ROW_PREVIEW_CLASS = 'mt-1.5 grid gap-1 text-[0.6875rem] md:grid-cols-2';

export function AgentRequestCardsSkeleton(): JSX.Element {
  return <div className="flex flex-col gap-2" role="status" aria-label="加载 Agent 请求" aria-busy="true" data-agent-request-cards-skeleton>
    {[0, 1, 2, 3, 4, 5].map(i => <div key={i} className={`${AGENT_REQUEST_ROW_CLASS} border-border`} aria-hidden="true">
      <div className={AGENT_REQUEST_ROW_BODY_CLASS}>
        <div className={AGENT_REQUEST_ROW_META_CLASS}>
          <span className="cds-loading-skeleton-line size-[0.8125rem]" />
          <span className="cds-loading-skeleton-line h-5 w-10 rounded-full" />
          <span className="cds-loading-skeleton-line h-4 w-20" />
          <span className="cds-loading-skeleton-line h-4 w-9" />
          <span className="cds-loading-skeleton-line h-4 w-9" />
          <span className="cds-loading-skeleton-line h-3 w-8" />
          <div className="flex h-4 items-center"><span className="cds-loading-skeleton-line h-3 w-28" /></div>
        </div>
        <div className={AGENT_REQUEST_ROW_PREVIEW_CLASS}>
          <div className="flex h-4 items-center"><span className="cds-loading-skeleton-line h-2.5 w-24" /></div>
          <div className="flex h-4 items-center"><span className="cds-loading-skeleton-line h-2.5 w-36" /></div>
        </div>
      </div>
    </div>)}
  </div>;
}

export function AgentRequestsSkeleton(): JSX.Element {
  return <div className="flex flex-col gap-4" data-agent-requests-skeleton>
    <div className={AGENT_REQUEST_FILTERS_CLASS} aria-hidden="true">
      {[0, 1, 2].map(i => <span key={i} className={`${AGENT_REQUEST_FILTER_CLASS} cds-loading-skeleton-panel w-[4.75rem]`} />)}
      <div className={AGENT_REQUEST_SEARCH_CLASS}><span className="cds-loading-skeleton-panel block h-8 w-full rounded-md border border-border" /></div>
      <span className="cds-loading-skeleton-panel h-8 w-14 rounded-md border border-border" />
      <span className="cds-loading-skeleton-line h-3 w-20" />
    </div>
    <AgentRequestCardsSkeleton />
  </div>;
}
