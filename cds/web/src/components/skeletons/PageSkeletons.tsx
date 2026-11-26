import { DtsSkeleton } from './DtsSkeleton';
import { CodeReviewsSkeleton } from './CodeReviewsSkeleton';
import { ContentLoading } from './ContentLoading';
import { useState } from 'react';
import { readProjectInventoryPreferences } from '@/lib/projectInventoryPreferences';
import { FolderGit2, KeyRound, LayoutGrid, List, Plus, Search } from 'lucide-react';
import { PROJECT_STATUS_FILTERS, ProjectInventoryLayout } from '@/components/project/ProjectInventoryHeader';
import { Button } from '@/components/ui/button';
import { AuthPageSkeleton } from './AuthPageSkeleton';
import { PublicStatusSkeleton } from './PublicStatusSkeleton';
import { AgentRequestsSkeleton, BranchRelationsSkeleton, TopologyPageSkeleton } from './WorkspaceSkeletons';
import { loadingSceneForPath } from './loadingScenes';
import { isBatchReleaseMode, ReleaseConsoleSkeleton } from './ReleaseConsoleSkeleton';
import { ReleaseApprovalSkeleton } from './ReleaseApprovalSkeleton';
import { ProjectStatusSkeleton } from './ProjectStatusSkeleton';
import { PersonalSettingsSkeleton, SettingsPageSkeleton } from './SettingsSkeleton';
import { BranchDetailLoadingSkeleton, LoadingBlock } from '@/pages/cds-settings/components';
import { MonitorCenterSkeleton } from '@/pages/status/primitives';
import { BranchListOverview } from '@/components/branch/BranchListOverview';
import { ACCEPTANCE_LAYOUT_CLASS, AcceptanceNavigation } from '@/components/reports/AcceptanceNavigation';
import { acceptanceView } from '@/lib/acceptance-api';
import { ReportsSkeleton } from './ReportsSkeleton';
import { TaskScheduleSkeleton } from './TaskScheduleSkeleton';
import { MonitorHomeSkeleton } from './MonitorHomeSkeleton';
import { readStatusLocation } from '@/lib/statusHome';
import { releaseCenterSection } from '@/lib/releaseCenter';
import { resolveProjectSettingsTab } from '@/lib/settingsSearchIndex';
import { ReleaseCenterSkeleton } from './ReleaseCenterSkeleton';

/**
 * 页面级加载骨架的 SSOT（2026-09-17）。
 *
 * 一个页面从「点导航」到「内容出现」要经过两段等待：先等它的代码块（lazy chunk）下载，
 * 再等它的数据。此前两段各画各的骨架——外壳的 Suspense fallback 是「标题 + 六块方块」的
 * 通用轮廓，页面自己等数据时又换成卡片网格——用户看见的就是「先出一幅老骨架，再出一幅
 * 更像真实的骨架」。每次部署都换 chunk 哈希，所以在 CDS 上这不是首次访问才有的偶发。
 *
 * 治法：**一个页面只有一副骨架**。骨架按路由形状选（pageSkeletonForPath），外壳在 chunk
 * 未到时画它，页面在数据未到时画同一个组件——两段等待之间没有任何轮廓变化。
 *
 * 加页面时：给它的骨架在这里登记，并在 pageSkeletonForPath 里挂上路由；没有专属形状的
 * 页面落到 ConsoleGenericSkeleton。守卫：tests/web/single-skeleton-contract.test.ts。
 */
/** 分支列表加载骨架:逐张镜像真实 BranchCard 的头部、端口/摘要/标签与尾部自然节奏,
 *  跑在 cds-branch-card-grid 上,加载完成时与真数据无缝接管。顶部保留统计和筛选槽位。取代旧的几行横条通用骨架(用户反馈"骨架不对")。 */
const BRANCH_SKELETON_TITLE_WIDTHS = ['52%', '38%', '60%', '44%', '56%', '46%'] as const;

/** 项目列表非管理者/身份未确认时，顶栏计数区域共用同一占位。 */
export function ProjectListSummarySkeleton(): JSX.Element {
  return <div className="cds-loading-skeleton-line h-4 w-44 max-w-full" aria-hidden />;
}

export function BranchListSkeleton(): JSX.Element {
  return (
    <div className="mt-6" aria-busy="true" aria-live="polite" aria-label="加载项目与本地分支列表">
      <BranchListOverview loading summary={<div className="flex min-h-7 min-w-0 flex-wrap items-baseline gap-x-3 gap-y-1">
        <div className="cds-loading-skeleton-line h-6 w-24" />
        <div className="flex h-5 items-center gap-3">
          {[0, 1, 2].map(i => <div key={i} className="cds-loading-skeleton-line h-3 w-12" />)}
        </div>
      </div>}>
        <div className="inline-flex shrink-0 gap-0.5 rounded-lg border border-[hsl(var(--hairline))] bg-[hsl(var(--surface-sunken))]/50 p-[3px]">
          {['w-16', 'w-16', 'w-20'].map((width, i) => <div key={i} className={`cds-loading-skeleton-panel h-7 rounded-md ${width}`} />)}
        </div>
        <div className="cds-loading-skeleton-panel h-8 w-24 shrink-0 rounded-md" />
        <div className="flex h-[calc(1.25rem+2px)] basis-full items-center gap-2 sm:basis-auto">
          <div className="cds-loading-skeleton-line h-3 w-8" />
          <div className="cds-loading-skeleton-panel h-full w-12 rounded-md" />
        </div>
      </BranchListOverview>
      <div className="cds-branch-card-grid">
        {BRANCH_SKELETON_TITLE_WIDTHS.map((width, index) => (
          <article
            key={index}
            className="flex flex-col overflow-hidden rounded-md border border-[hsl(var(--hairline))] bg-[hsl(var(--surface-raised))]"
          >
            {/* 头部:分支名 + 状态徽标 */}
            <header className="flex min-w-0 items-start justify-between gap-3 px-5 pt-5">
              <div className="flex h-8 min-w-0 flex-1 items-center gap-3">
                <div className="cds-loading-skeleton-line h-4 w-4 shrink-0 rounded-full" />
                <div className="cds-loading-skeleton-line h-4" style={{ width }} />
              </div>
              <div className="cds-loading-skeleton-line h-8 w-8 shrink-0 rounded-md" />
            </header>
            {/* 镜像正文的端口、摘要、标签节奏，随内容自然排布，不再把页脚推到固定卡高。 */}
            <div className="mx-5 mt-3 flex h-7 items-center">
              <div className="cds-loading-skeleton-line h-3 w-1/2" style={{ animationDelay: '0.1s' }} />
            </div>
            <div className="mx-5 mt-2.5 mb-3 flex min-h-[1.125rem] items-center">
              <div className="cds-loading-skeleton-line h-3 w-3/4" style={{ animationDelay: '0.18s' }} />
            </div>
            <div className="mx-5 mt-2 mb-3 flex min-h-6 items-center">
              <div className="cds-loading-skeleton-line h-3 w-2/5" style={{ animationDelay: '0.26s' }} />
            </div>
            {/* 尾部:操作条 */}
            <footer className="flex h-[3.5rem] shrink-0 items-center justify-between gap-2 border-t border-[hsl(var(--hairline))] bg-[hsl(var(--surface-sunken))]/42 px-5">
              <div className="cds-loading-skeleton-line h-3 w-24" />
              <div className="cds-loading-skeleton-line h-7 w-20 rounded-md" />
            </footer>
          </article>
        ))}
      </div>
    </div>
  );
}

/**
 * 项目列表骨架屏 —— 用「即将出现的内容形状」占位,而不是一个孤零零的居中 logo。
 * 骨架卡逐张镜像真实 ProjectCard（项目标识 + 服务模块 + 运行指标 + 环境分支行），
 * 加载完成时视觉无缝切换到真数据。节点分片错相位 shimmer,整片"活着"不发呆。
 * 页头和工具条复用正文布局，代码和数据两段加载都保持相同垂直位置。
 */
const SKELETON_CARD_WIDTHS = ['58%', '44%', '66%', '38%', '52%', '47%'] as const;

function ProjectInventoryCountSkeleton(): JSX.Element {
  return <span className="cds-loading-skeleton-line border-0"><span className="invisible">0</span></span>;
}

export function ProjectListSkeleton({ canManageProjects = false }: { canManageProjects?: boolean } = {}): JSX.Element {
  const [view] = useState(() => readProjectInventoryPreferences().view);
  return (
    <div aria-busy="true" aria-live="polite" aria-label="加载项目列表">
      <div aria-hidden>
        <ProjectInventoryLayout canManageProjects={canManageProjects} count={<ProjectInventoryCountSkeleton />}
          actions={<>
            <Button disabled variant="outline" size="sm" className="cds-loading-skeleton-panel"><KeyRound className="invisible" /><span className="invisible hidden sm:inline">Agent Key</span></Button>
            <Button disabled variant="outline" size="sm" className="cds-loading-skeleton-panel"><FolderGit2 className="invisible" /><span className="invisible">导入仓库</span></Button>
            <Button disabled size="sm" className="cds-loading-skeleton-panel"><Plus className="invisible" /><span className="invisible">新建项目</span></Button>
          </>}
          filters={PROJECT_STATUS_FILTERS.map(({ label, value }) => <button key={value} type="button" disabled aria-pressed={value === 'all'}>
            {label}<span><ProjectInventoryCountSkeleton /></span>
          </button>)}
          tools={<>
            <label className="cds-project-inventory-search cds-loading-skeleton-panel"><Search className="invisible" /><input type="search" disabled /><kbd className="invisible">/</kbd></label>
            <select disabled className="cds-loading-skeleton-panel"><option>全部环境</option><option>未配置发布环境</option></select>
            <select disabled className="cds-loading-skeleton-panel"><option>默认排序</option><option>最近更新</option><option>项目名称</option></select>
            <div className="cds-project-view-switch cds-loading-skeleton-panel">
              <button type="button" disabled aria-pressed={view === 'grid'}><LayoutGrid className="invisible" /></button>
              <button type="button" disabled aria-pressed={view === 'list'}><List className="invisible" /></button>
            </div>
          </>}
        />
      </div>
      <div className={`cds-card-grid cds-project-inventory-grid ${view === 'list' ? 'cds-project-inventory--list' : ''}`}>
        {SKELETON_CARD_WIDTHS.map((width, index) => (
          <article key={index} className="cds-project-card" aria-hidden>
            <div className="cds-project-card-link">
              <header className="cds-project-card-heading">
                <div className="cds-project-monogram cds-loading-skeleton-panel" />
                <div className="min-w-0 flex-1">
                  <div className="cds-loading-skeleton-line h-3" style={{ width }} />
                </div>
                <div className="cds-project-state">
                  <span className="cds-loading-skeleton-line size-[0.3125rem] rounded-full" />
                  <span className="relative">
                    <span className="invisible">运行中</span>
                    <span className="cds-loading-skeleton-line absolute inset-x-0 top-1/2 h-2 -translate-y-1/2" />
                  </span>
                </div>
              </header>
              <div className="cds-project-services cds-project-services--repository">
                <div className="cds-project-repository-mark">
                  <div className="cds-loading-skeleton-panel size-8 rounded" />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="cds-project-repository-label"><div className="cds-loading-skeleton-line h-2 w-12 max-w-full" /></div>
                  <div className="cds-project-repository-name"><div className="cds-loading-skeleton-line h-3 w-24 max-w-full" /></div>
                  <div className="cds-project-repository-provider"><div className="cds-loading-skeleton-line h-2 w-14 max-w-full" /></div>
                </div>
              </div>
              <div className="cds-project-metrics">
                <span className="cds-project-online"><span className="cds-loading-skeleton-line size-3.5" /><span className="cds-loading-skeleton-line h-2.5 w-8" /></span>
                <span className="cds-project-cpu"><span className="cds-loading-skeleton-line size-3.5" /><span className="cds-loading-skeleton-line h-2.5 w-4" /></span>
                <span className="cds-project-build-rate cds-loading-skeleton-line h-2.5 w-16" />
              </div>
              <footer className="cds-project-card-footer">
                <span className="cds-project-environment cds-loading-skeleton-line h-2.5 w-16" />
                <span className="cds-project-branch"><span className="cds-loading-skeleton-line size-3" /><span className="cds-loading-skeleton-line h-2.5 w-6" /></span>
                <span className="cds-project-branch-count cds-loading-skeleton-line h-2.5 w-8" />
                <time className="cds-loading-skeleton-line h-2.5 w-11" />
              </footer>
            </div>
            {canManageProjects ? <div className="cds-project-actions">
              <span className="cds-loading-skeleton-panel inline-block size-7 rounded-md align-middle" />
            </div> : null}
          </article>
        ))}
      </div>
      <div className="cds-project-inventory-footer min-h-[1.125rem] items-center" aria-hidden>
        <span className="cds-loading-skeleton-line h-3 w-40" />
        <span className="cds-loading-skeleton-line h-3 w-28" />
      </div>
    </div>
  );
}

/**
 * 没有专属形状的页面用的通用轮廓（标题行 + 六块内容）。
 * 它只该在 pageSkeletonForPath 找不到专属骨架时出现——专属骨架一律登记在上面。
 */
export function ConsoleGenericSkeleton(): JSX.Element {
  return (
    <div className="flex flex-col gap-4" aria-busy="true" aria-live="polite">
      <div className="cds-loading-skeleton-line h-7 w-64 max-w-[60vw]" />
      <div className="cds-loading-skeleton-line h-4 w-96 max-w-full" />
      <div className="mt-2 grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {Array.from({ length: 6 }, (_, i) => (
          <div key={i} className="cds-loading-skeleton-panel h-40 rounded-[0.625rem]" style={{ animationDelay: `${i * 0.08}s` }} />
        ))}
      </div>
    </div>
  );
}

export function EngineeringPlanningSkeleton(): JSX.Element {
  return <div className="space-y-4" role="status" aria-label="加载工程规划" aria-busy="true">
    <div className="cds-loading-skeleton-line h-7 w-32" aria-hidden="true" />
    <div className="flex gap-3" aria-hidden="true"><div className="cds-loading-skeleton-panel h-12 w-36" /><div className="cds-loading-skeleton-panel h-12 w-32" /></div>
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4" aria-hidden="true">
      {Array.from({ length: 4 }, (_, index) => <ContentLoading key={index} variant="panel" label="加载推进看板" />)}
    </div>
  </div>;
}

/** 路由 → 骨架形状。控制台外壳在 chunk 未到时按它画，和页面自己等数据时画的是同一副。 */
export function pageSkeletonForPath(pathname: string, capabilities: { canManageProjects?: boolean; canManageSettings?: boolean; monitoringHome?: boolean; search?: string; hash?: string } = {}): JSX.Element {
  const scene = loadingSceneForPath(pathname);
  if (scene?.route === '/reports') {
    const params = new URLSearchParams(capabilities.search);
    const report = params.get('report') || undefined;
    const view = acceptanceView(params.get('view'), report);
    return <div className={ACCEPTANCE_LAYOUT_CLASS}>
      <AcceptanceNavigation view={view} />
      {view === 'reports' && !report ? <ReportsSkeleton overview={params.get('view') === 'overview'} /> : <LoadingBlock label={report ? '正在打开验收报告' : '正在加载验收报告'} />}
    </div>;
  }
  if (scene?.route === '/task-schedule') return <TaskScheduleSkeleton />;
  switch (scene?.kind) {
    case 'auth': return <AuthPageSkeleton />;
    case 'public-status': return <PublicStatusSkeleton />;
    case 'projects': return <ProjectListSkeleton canManageProjects={capabilities.canManageProjects} />;
    case 'branches': return <BranchListSkeleton />;
    case 'relations': return <BranchRelationsSkeleton />;
    case 'agent-table': return <AgentRequestsSkeleton />;
    case 'topology': return <TopologyPageSkeleton />;
    case 'release-center': return <ReleaseCenterSkeleton section={releaseCenterSection(new URLSearchParams(capabilities.search))} />;
    case 'release-approval': {
      const params = new URLSearchParams(capabilities.search);
      const hasScope = Boolean((params.get('project') && params.get('target')) || params.get('request') || pathname.split('/')[3]);
      return <ReleaseApprovalSkeleton hasScope={hasScope} />;
    }
    case 'monitor': return scene.route === '/status' && readStatusLocation(new URLSearchParams(capabilities.search)).view === 'home' ? <MonitorHomeSkeleton /> : <MonitorCenterSkeleton />;
    case 'project-monitor': return <ProjectStatusSkeleton />;
    case 'branch-detail': {
      const params = new URLSearchParams(capabilities.search);
      const selectBranch = scene.route === '/branch-panel' && Boolean(params.get('project')) && !params.get('branch') && !params.get('id');
      return <BranchDetailLoadingSkeleton selectBranch={selectBranch} canManage={capabilities.canManageSettings} />;
    }
    case 'dts': return <DtsSkeleton hasProject={Boolean(new URLSearchParams(capabilities.search).get('project'))} />;
    case 'settings': {
      const personal = capabilities.canManageSettings === false;
      const tab = capabilities.hash?.slice(1) || new URLSearchParams(capabilities.search).get('tab') || undefined;
      return <SettingsPageSkeleton personal={personal} systemTab={tab} />;
    }
    case 'project-settings': return <SettingsPageSkeleton label="加载项目设置" project projectTab={resolveProjectSettingsTab(capabilities.search, capabilities.hash)} />;
    case 'personal-settings': return <PersonalSettingsSkeleton />;
    case 'release-console': return <ReleaseConsoleSkeleton batch={isBatchReleaseMode(new URLSearchParams(capabilities.search))} />;
    case 'rows': return <LoadingBlock />;
    case 'code-reviews': return <CodeReviewsSkeleton detail={new URLSearchParams(capabilities.search).has('task')} />;
    case 'engineering-planning': return <EngineeringPlanningSkeleton />;
    case 'design': return <ContentLoading variant="table" label="正在读取设计工作区" />;
    case 'preview-access': return <main className="grid min-h-screen place-items-center bg-background p-4">
      <ContentLoading label="正在核对预览访问权限" variant="panel" className="max-w-md" />
    </main>;
    default: return <ConsoleGenericSkeleton />;
  }
}
