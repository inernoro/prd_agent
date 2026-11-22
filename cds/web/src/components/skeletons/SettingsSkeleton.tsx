import { createContext, useEffect, useState } from 'react';
import { ProjectGeneralSettingsSkeleton } from './ProjectGeneralSettingsSkeleton';
import { SettingsMaintenanceSkeleton } from './SettingsMaintenanceSkeleton';
import '../../pages/cds-settings/settings-directory.css';

/** 设置页签统一等待轮廓；预览区和独立弹窗显式退出此作用域。 */
export const SettingsLoadingContext = createContext(false);

export function PersonalSettingsSkeleton(): JSX.Element {
  return (
    <div className="max-w-xl space-y-5 py-5" role="status" aria-label="确认当前账号" aria-busy="true" data-personal-settings-skeleton>
      <div className="cds-loading-skeleton-line h-7 w-24" aria-hidden="true" />
      <div className="space-y-4" aria-hidden="true">
        <div className="cds-loading-skeleton-line h-6 w-24" />
        <div className="cds-loading-skeleton-line h-4 w-72 max-w-full" />
        <div className="max-w-md space-y-4">
          {[0, 1].map(field => <div key={field} className="space-y-1.5">
            <div className="cds-loading-skeleton-line h-4 w-24" />
            <div className="cds-loading-skeleton-panel h-11 rounded-md" />
          </div>)}
          <div className="cds-loading-skeleton-panel h-11 w-28 rounded-md" />
        </div>
      </div>
    </div>
  );
}

/** 设置内容轮廓；不渲染可交互控件或尚未确认的设置名称。 */
export function SettingsContentSkeleton({ label = '加载设置内容', auth = false, projectGeneral = false }: { label?: string; auth?: boolean; projectGeneral?: boolean }): JSX.Element {
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    setSlow(false);
    const timer = window.setTimeout(() => setSlow(true), 6_000);
    return () => window.clearTimeout(timer);
  }, [label]);
  const waitMessage = <p className="h-4 text-xs text-muted-foreground" aria-live="polite">{slow ? '仍在读取…' : null}</p>;
  if (projectGeneral) {
    return <div role="status" aria-label={label} aria-busy="true" data-settings-content-skeleton>
      <ProjectGeneralSettingsSkeleton />
      {waitMessage}
    </div>;
  }
  if (auth) {
    return <div role="status" aria-label={label} aria-busy="true" data-settings-content-skeleton>
      <div aria-hidden>
        <div className="flex h-7 items-center"><div className="cds-loading-skeleton-line h-4 w-28" /></div>
        <div className="cds-settings-skeleton-description mt-1 flex min-h-5 flex-col justify-center gap-2">
          <div className="cds-loading-skeleton-line h-3 w-[35rem] max-w-full" />
          <div className="cds-settings-skeleton-description-wrap cds-loading-skeleton-line h-3 w-40" />
        </div>
        <div className="mt-3 space-y-5">
          <div className="flex min-h-[5.375rem] items-start gap-3 rounded-md border border-border bg-card px-4 py-4">
            <div className="cds-loading-skeleton-line h-5 w-5 shrink-0" />
            <div className="min-w-0 flex-1 space-y-2">
              <div className="cds-loading-skeleton-line h-4 w-24" />
              <div className="cds-loading-skeleton-line h-3 w-72 max-w-full" />
            </div>
          </div>
          <div className="space-y-3 rounded-md border border-border bg-card px-4 py-4">
            <div className="cds-loading-skeleton-line h-4 w-32" />
            <div className="cds-loading-skeleton-line h-3 w-96 max-w-full" />
            <div className="cds-loading-skeleton-line h-3 w-24" />
            <div className="cds-loading-skeleton-panel h-8 w-32 rounded-md max-lg:h-[3.25rem]" />
            <div className="grid gap-4 sm:grid-cols-2">
              {[0, 1].map(field => <div key={field} className="space-y-2">
                <div className="cds-loading-skeleton-line h-3 w-24" />
                <div className="cds-loading-skeleton-panel h-10 rounded-md" />
              </div>)}
            </div>
          </div>
        </div>
      </div>
      {waitMessage}
    </div>;
  }
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
    {waitMessage}
  </div>;
}

const systemDirectoryGroups = [3, 8, 5, 2, 3, 1];
const projectDirectoryGroups = [3, 4, 6, 2, 1];
const personalDirectoryGroups = [1];

export function SystemSettingsContentSkeleton({ tab }: { tab: string }): JSX.Element {
  if (tab === 'maintenance') return <SettingsMaintenanceSkeleton />;
  return <SettingsContentSkeleton auth={tab === 'auth'} />;
}

/** 路由代码与身份能力加载共用设置目录在桌面和窄屏下的布局。 */
export function SettingsPageSkeleton({
  label = '加载系统设置', project = false, personal = false, systemTab = 'maintenance', projectTab = 'general',
}: { label?: string; project?: boolean; personal?: boolean; systemTab?: string; projectTab?: string }): JSX.Element {
  const groups = project ? projectDirectoryGroups : personal ? personalDirectoryGroups : systemDirectoryGroups;
  return <div className="cds-settings-shell" role="status" aria-label={label} aria-busy="true" data-settings-page-skeleton>
    <div className="cds-settings-layout">
      <div aria-hidden className="cds-settings-mobile-directory">
        {personal
          ? <div className="flex leading-5 items-center"><div className="cds-loading-skeleton-line h-3 w-28 my-1" /></div>
          : <div className="flex min-h-[3.25rem] w-full items-center justify-between rounded-md border border-input bg-background px-3">
            <div className="cds-loading-skeleton-line h-4 w-32" />
            <div className="cds-loading-skeleton-line h-2 w-2" />
          </div>}
      </div>
      <div aria-hidden className="cds-settings-desktop-directory">
        <div className="cds-settings-nav cds-settings-rail flex flex-col">
          <div className="cds-settings-rail-head">
            <div className="flex h-5 items-center"><div className="cds-loading-skeleton-line h-4 w-28" /></div>
            <div className="flex h-[1.03125rem] items-center"><div className="cds-loading-skeleton-line h-2 w-12" /></div>
          </div>
          {groups.map((size, group) => <div key={group} className={`cds-settings-nav-group ${group ? 'mt-3' : ''}`}>
            <div className="cds-settings-nav-group-label px-2 pb-1.5 pt-1">
              <div className="flex h-[1.03125rem] items-center"><div className="cds-loading-skeleton-line h-2 w-8" /></div>
            </div>
            {Array.from({ length: size }, (_, row) => <div key={row} className="cds-settings-nav-trigger flex min-h-11 shrink-0 items-center gap-3 px-3">
              <div className="cds-loading-skeleton-panel h-4 w-4 rounded" />
              <div className={`cds-loading-skeleton-line h-3 ${row % 3 === 0 ? 'w-20' : 'w-24'}`} />
            </div>)}
          </div>)}
        </div>
      </div>
      <div className="cds-settings-content min-w-0"><div className="cds-settings-section-body">
        {project
          ? <SettingsContentSkeleton projectGeneral={projectTab === 'general'} />
          : <SystemSettingsContentSkeleton tab={personal ? 'activity' : systemTab} />}
      </div></div>
    </div>
  </div>;
}
