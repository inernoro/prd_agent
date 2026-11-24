import '@/pages/status/monitor-workspace.css';

const PLACEHOLDERS = [0, 1, 2, 3] as const;

/** 使用监控工作区现有控件和画布的布局，包含窄屏折叠的告警栏。 */
export function MonitorHomeSkeleton(): JSX.Element {
  return <div className="monitor-page-content" role="status" aria-busy="true" aria-label="正在读取监控数据" data-monitor-home-skeleton>
    <div className="monitor-workspace" aria-hidden="true">
      <div className="main">
        <div className="t2">
          <div className="search"><div className="cds-loading-skeleton-panel h-[2.5rem] w-full rounded-lg" /></div>
          <div className="source-filter cds-loading-skeleton-panel w-[7.35rem]" />
          <div className="tokens">{PLACEHOLDERS.map(index => <div key={index} className="tok"><span className="cds-loading-skeleton-line h-2 w-2 rounded-full" /><span className="cds-loading-skeleton-line h-3 w-3" /><span className="tkl cds-loading-skeleton-line h-3 w-6" /></div>)}</div>
          <span className="sp" /><span className="seg-l cds-loading-skeleton-line h-3 w-7" />
          <div className="seg vseg">{PLACEHOLDERS.map(index => <span key={index} className="cds-loading-skeleton-line h-7 w-[3.0875rem] rounded-md" />)}</div>
          <span className="rm-b cds-loading-skeleton-panel h-8 w-8 rounded-md" />
        </div>
        <div className="t2r"><div className="rail-tg"><span className="cds-loading-skeleton-line h-3.5 w-14" /><span className="cds-loading-skeleton-line h-5 w-12 rounded-full" /><span className="cds-loading-skeleton-line h-5 w-14 rounded-full" /></div></div>
        <section className="wsw">
          <div className="crumbs"><span className="cds-loading-skeleton-line mx-2 h-3 w-12" /><span className="cds-loading-skeleton-line h-3 w-16" /><span className="sp" /><span className="mode-l cds-loading-skeleton-line h-3 w-24" /></div>
          <div className="ws">
            <div className="layer Lg">
              <div className="cg">
                {[0, 1].map(index => <div key={index} className="category-slot" style={{ gridColumn: 'span 24' }}>
                  <div className="cat L1 min-h-0">
                    <div className="ch gap-2"><span className="cds-loading-skeleton-line h-4 w-20" /><span className="cds-loading-skeleton-line h-3 w-8" /><span className="cds-loading-skeleton-line h-4 w-12" /><span className="cds-loading-skeleton-line ml-auto h-3 w-8" /></div>
                    <div className="cgrid">
                      {PLACEHOLDERS.map(tile => <div key={tile} className="monitor-skeleton-tile flex h-[3.3824rem] min-w-0 flex-col justify-center gap-1 rounded-lg border border-[hsl(var(--hairline))] bg-[hsl(var(--surface-sunken))]/45 px-2.5">
                        <div className="flex items-center gap-1.5"><span className="cds-loading-skeleton-line h-2 w-2 shrink-0 rounded-full" /><span className="cds-loading-skeleton-line h-3 w-24 max-w-full" /></div>
                        <span className="cds-loading-skeleton-line ml-3.5 h-2.5 w-3/5" />
                        <span className="monitor-skeleton-tile-trend cds-loading-skeleton-line mb-2 mt-auto hidden h-2 w-full" />
                      </div>)}
                      <div className="cds-loading-skeleton-panel monitor-skeleton-tile h-[3.3824rem] rounded-lg" />
                    </div>
                  </div>
                </div>)}
              </div>
            </div>
          </div>
        </section>
        <aside className="alw closed">
          <div className="hm">
            <div className="hm-h"><span className="cds-loading-skeleton-line h-3.5 w-14" /><span className="cds-loading-skeleton-line h-3.5 w-10" /><span className="cds-loading-skeleton-line ml-auto h-3 w-20" /></div>
            <div className="grid grid-cols-[5.15rem_repeat(2,minmax(0,1fr))] gap-[3px]">{Array.from({ length: 9 }, (_, index) => <span key={index} className="cds-loading-skeleton-line h-4" />)}</div>
          </div>
          <div className="al">{Array.from({ length: 7 }, (_, index) => <div key={index} className="ai flex h-[7.794rem] shrink-0 flex-col justify-center gap-2 rounded-lg border border-[hsl(var(--hairline))] p-3">
            <span className="cds-loading-skeleton-line h-3.5 w-1/2" /><span className="cds-loading-skeleton-line h-3 w-3/4" /><span className="cds-loading-skeleton-line h-2.5 w-1/3" />
          </div>)}</div>
          <div className="al-foot"><div className="al-def"><span className="cds-loading-skeleton-line h-3 w-16" /><span className="cds-loading-skeleton-line h-3 w-3/4" /></div></div>
        </aside>
      </div>
    </div>
  </div>;
}
