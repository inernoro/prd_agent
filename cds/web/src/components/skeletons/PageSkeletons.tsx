import { DtsSkeleton } from './DtsSkeleton';
import { CodeReviewsSkeleton } from './CodeReviewsSkeleton';
import { useState } from 'react';
import { readProjectInventoryPreferences } from '@/lib/projectInventoryPreferences';
import { FolderGit2, LayoutGrid, List, Plus, Search } from 'lucide-react';
import { ProjectInventoryLayout } from '@/components/project/ProjectInventoryHeader';
import { Button } from '@/components/ui/button';
import { AuthPageSkeleton } from './AuthPageSkeleton';
import { PublicStatusSkeleton } from './PublicStatusSkeleton';
import { AgentRequestsSkeleton, ReleaseCenterSkeleton, TopologyPageSkeleton } from './WorkspaceSkeletons';
import { loadingSceneForPath } from './loadingScenes';
import { ReleaseConsoleSkeleton } from './ReleaseConsoleSkeleton';
import { ContentLoading } from './ContentLoading';
import { SettingsPageSkeleton } from './SettingsSkeleton';
import { BranchDetailLoadingSkeleton, LoadingBlock } from '@/pages/cds-settings/components';
import { MonitorCenterSkeleton } from '@/pages/status/primitives';
import { BranchListOverview } from '@/components/branch/BranchListOverview';
import { ACCEPTANCE_LAYOUT_CLASS, AcceptanceNavigation } from '@/components/reports/AcceptanceNavigation';
import { acceptanceView } from '@/lib/acceptance-api';

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
      <BranchListOverview loading summary={<div className="cds-loading-skeleton-line h-7 w-72 max-w-full" />}>
        <div className="cds-loading-skeleton-line h-7 w-52 shrink-0" />
        <div className="cds-loading-skeleton-line h-8 w-56 shrink-0" />
        <div className="cds-loading-skeleton-line h-8 w-24 shrink-0" />
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

export function ProjectListSkeleton({ canManageProjects = false }: { canManageProjects?: boolean } = {}): JSX.Element {
  const [view] = useState(() => readProjectInventoryPreferences().view);
  return (
    <div aria-busy="true" aria-live="polite" aria-label="加载项目列表">
      <div aria-hidden>
        <ProjectInventoryLayout canManageProjects={canManageProjects} count={<span className="cds-loading-skeleton-line inline-block h-3 w-3 align-middle" />}
          actions={<>
            <Button disabled variant="outline" size="sm" className="cds-loading-skeleton-panel"><FolderGit2 className="invisible" /><span className="invisible">导入仓库</span></Button>
            <Button disabled size="sm" className="cds-loading-skeleton-panel"><Plus className="invisible" /><span className="invisible">新建项目</span></Button>
          </>}
          filters={['全部项目', '运行中', '已暂停', '已就绪'].map(label => <button key={label} type="button" disabled>
            {label}<span><i className="cds-loading-skeleton-line inline-block h-2 w-2" /></span>
          </button>)}
          tools={<>
            <label className="cds-project-inventory-search cds-loading-skeleton-panel"><Search className="invisible" /><input type="search" disabled /><kbd className="invisible">/</kbd></label>
            <select disabled className="cds-loading-skeleton-panel"><option>全部环境</option><option>未配置发布环境</option></select>
            <select disabled className="cds-loading-skeleton-panel"><option>默认排序</option><option>最近更新</option><option>项目名称</option></select>
            <div className="cds-project-view-switch cds-loading-skeleton-panel">
              <button type="button" disabled><LayoutGrid className="invisible" /></button>
              <button type="button" disabled><List className="invisible" /></button>
            </div>
          </>}
        />
      </div>
      <div className={`cds-card-grid cds-project-inventory-grid ${view === 'list' ? 'cds-project-inventory--list' : ''}`}>
        {SKELETON_CARD_WIDTHS.map((width, index) => (
          <article key={index} className="cds-project-card">
            <div className="cds-project-card-link">
              <header className="cds-project-card-heading">
                <div className="cds-loading-skeleton-panel h-[2.125rem] w-[2.125rem] shrink-0 rounded" />
                <div className="cds-loading-skeleton-line h-3 flex-1" style={{ maxWidth: width }} />
                <div className="cds-loading-skeleton-line h-2 w-9" />
              </header>
              <div className="cds-project-services" aria-hidden>
                <div className="cds-loading-skeleton-panel rounded" />
                <div className="grid min-h-0 gap-1">
                  {[0, 1, 2].map((node) => (
                    <div key={node} className="cds-loading-skeleton-panel rounded" style={{ animationDelay: `${node * 0.14}s` }} />
                  ))}
                </div>
              </div>
              <div className="cds-project-metrics" aria-hidden>
                <div className="cds-loading-skeleton-line h-2 w-16" />
                <div className="cds-loading-skeleton-line h-2 w-10" />
                <div className="cds-loading-skeleton-line ml-auto h-2 w-16" />
              </div>
              <footer className="cds-project-card-footer" aria-hidden>
                <div className="cds-loading-skeleton-line h-2 w-14" />
                <div className="cds-loading-skeleton-line h-2 w-12" />
                <div className="cds-loading-skeleton-line h-2 w-9" />
                <div className="cds-loading-skeleton-line ml-auto h-2 w-14" />
              </footer>
            </div>
          </article>
        ))}
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
export function pageSkeletonForPath(pathname: string, capabilities: { canManageProjects?: boolean; monitoringHome?: boolean; search?: string } = {}): JSX.Element {
  const scene = loadingSceneForPath(pathname);
  if (scene?.route === '/reports') {
    const params = new URLSearchParams(capabilities.search);
    return <div className={ACCEPTANCE_LAYOUT_CLASS}>
      <AcceptanceNavigation view={acceptanceView(params.get('view'), params.get('report') || undefined)} />
      <LoadingBlock label="正在加载验收报告" />
    </div>;
  }
  switch (scene?.kind) {
    case 'auth': return <AuthPageSkeleton />;
    case 'public-status': return <PublicStatusSkeleton />;
    case 'projects': return <ProjectListSkeleton canManageProjects={capabilities.canManageProjects} />;
    case 'branches': return <BranchListSkeleton />;
    case 'relations': return <ContentLoading label="读取关系视图" variant="panel" />;
    case 'agent-table': return <AgentRequestsSkeleton />;
    case 'topology': return <TopologyPageSkeleton />;
    case 'release-center': return <ReleaseCenterSkeleton />;
    case 'monitor': return <MonitorCenterSkeleton />;
    case 'branch-detail': return <BranchDetailLoadingSkeleton />;
    case 'dts': return <DtsSkeleton />;
    case 'settings': return <SettingsPageSkeleton />;
    case 'project-settings': return <SettingsPageSkeleton label="加载项目设置" />;
    case 'release-console': return <ReleaseConsoleSkeleton />;
    case 'rows': return <LoadingBlock />;
    case 'code-reviews': return <CodeReviewsSkeleton />;
    case 'engineering-planning': return <EngineeringPlanningSkeleton />;
    default: return <ConsoleGenericSkeleton />;
  }
}
