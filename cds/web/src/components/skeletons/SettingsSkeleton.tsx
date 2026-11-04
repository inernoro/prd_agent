import { createContext, useEffect, useState } from 'react';

/** 设置页签统一等待轮廓；预览区和独立弹窗显式退出此作用域。 */
export const SettingsLoadingContext = createContext(false);

/** 设置内容轮廓；不渲染可交互控件或尚未确认的设置名称。 */
export function SettingsContentSkeleton({ label = '加载设置内容' }: { label?: string }): JSX.Element {
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    setSlow(false);
    const timer = window.setTimeout(() => setSlow(true), 6_000);
    return () => window.clearTimeout(timer);
  }, [label]);
  return <div role="status" aria-label={label} aria-busy="true" className="space-y-6" data-settings-content-skeleton>
    <div aria-hidden="true" className="space-y-3">
      <div className="cds-loading-skeleton-line h-6 w-40" />
      <div className="cds-loading-skeleton-line h-3 w-72 max-w-full" />
    </div>
    {[0, 1].map(section => <div key={section} aria-hidden="true" className="space-y-5 rounded-xl border border-[hsl(var(--hairline))] bg-card p-5">
      <div className="cds-loading-skeleton-line h-4 w-28" />
      <div className="grid gap-5 md:grid-cols-2">
        {[0, 1].map(field => <div key={field} className="min-w-0 space-y-2">
          <div className="cds-loading-skeleton-line h-3 w-20" />
          <div className="flex h-11 items-center rounded-md border border-[hsl(var(--hairline))] px-3">
            <div className="cds-loading-skeleton-line h-3 w-2/3" />
          </div>
        </div>)}
      </div>
      <div className="cds-loading-skeleton-panel h-8 w-20 rounded-md" />
    </div>)}
    <p className="h-4 text-xs text-muted-foreground" aria-live="polite">{slow ? '仍在读取…' : null}</p>
  </div>;
}

/** 路由代码与身份/能力加载共用同一个设置布局，窄屏导航收为横向占位。 */
export function SettingsPageSkeleton(): JSX.Element {
  return <div className="cds-settings-shell" role="status" aria-label="加载系统设置" aria-busy="true" data-settings-page-skeleton>
    <div className="cds-settings-layout">
      <div aria-hidden="true" className="cds-settings-nav cds-settings-rail flex min-w-0 gap-3 overflow-hidden max-[56.25rem]:p-4">
        <div className="cds-settings-rail-head"><div className="cds-loading-skeleton-line h-4 w-28" /></div>
        {Array.from({ length: 10 }, (_, i) => <div key={i} className="flex h-9 shrink-0 items-center gap-3 px-2">
          <div className="cds-loading-skeleton-panel h-4 w-4 rounded" />
          <div className="cds-loading-skeleton-line h-3" style={{ width: i % 3 === 0 ? '5rem' : '6.5rem' }} />
        </div>)}
      </div>
      <div className="cds-settings-content min-w-0"><div className="cds-settings-section-body"><SettingsContentSkeleton /></div></div>
    </div>
  </div>;
}
