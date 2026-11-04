import { AgentRequestsSkeleton, ReleaseCenterSkeleton, TopologyPageSkeleton } from './WorkspaceSkeletons';
import { loadingSceneForPath } from './loadingScenes';
import { ReleaseConsoleSkeleton } from './ReleaseConsoleSkeleton';
import { ContentLoading } from './ContentLoading';
import { SettingsPageSkeleton } from './SettingsSkeleton';
import { BranchDetailLoadingSkeleton, LoadingBlock } from '@/pages/cds-settings/components';
import { MonitorCenterSkeleton } from '@/pages/status/primitives';
import { BranchListOverview } from '@/components/branch/BranchListOverview';

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
/** 分支列表加载骨架:逐张镜像真实 BranchCard(固定 15.25rem + 头/身/尾三段,2026-09-29 等高改版),
 *  跑在 cds-branch-card-grid 上,加载完成时与真数据无缝接管。顶部保留统计和筛选槽位。取代旧的几行横条通用骨架(用户反馈"骨架不对")。 */
const BRANCH_SKELETON_TITLE_WIDTHS = ['52%', '38%', '60%', '44%', '56%', '46%'] as const;

export function BranchListSkeleton(): JSX.Element {
  return (
    <div className="mt-6" aria-busy="true" aria-live="polite" aria-label="加载项目与本地分支列表">
      <BranchListOverview loading summary={<div className="cds-loading-skeleton-line h-6 w-72 max-w-full" />}>
        <div className="cds-loading-skeleton-line h-7 w-52 shrink-0" />
        <div className="cds-loading-skeleton-line h-8 w-56 shrink-0" />
        <div className="cds-loading-skeleton-line h-8 w-24 shrink-0" />
      </BranchListOverview>
      <div className="cds-branch-card-grid">
        {BRANCH_SKELETON_TITLE_WIDTHS.map((width, index) => (
          <article
            key={index}
            className="flex h-[15.25rem] flex-col overflow-hidden rounded-md border border-[hsl(var(--hairline))] bg-[hsl(var(--surface-raised))]"
          >
            {/* 头部:分支名 + 状态徽标 */}
            <header className="flex min-w-0 items-start justify-between gap-3 px-5 pt-5">
              <div className="flex h-8 min-w-0 flex-1 items-center gap-3">
                <div className="cds-loading-skeleton-line h-4 w-4 shrink-0 rounded-full" />
                <div className="cds-loading-skeleton-line h-4" style={{ width }} />
              </div>
              <div className="cds-loading-skeleton-line h-8 w-8 shrink-0 rounded-md" />
            </header>
            {/* 身体:几行元信息 */}
            <div className="flex min-h-0 flex-1 flex-col gap-2.5 px-5 py-4">
              <div className="cds-loading-skeleton-line h-3 w-1/2" style={{ animationDelay: '0.1s' }} />
              <div className="cds-loading-skeleton-line h-3 w-3/4" style={{ animationDelay: '0.18s' }} />
              <div className="cds-loading-skeleton-line h-3 w-2/5" style={{ animationDelay: '0.26s' }} />
            </div>
            {/* 尾部:操作条 */}
            <footer className="mt-auto flex h-[3.5rem] shrink-0 items-center justify-between gap-2 border-t border-[hsl(var(--hairline))] bg-[hsl(var(--surface-sunken))]/42 px-5">
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
 * 骨架卡逐张镜像真实 ProjectCard(标题条 + 220px 点阵画布 + 底部状态行),
 * 加载完成时视觉无缝切换到真数据。节点使用共享轻呼吸,整片"活着"不发呆。
 * 与就绪页面保留同一张卡片的标题、画布和状态槽。
 */
const SKELETON_CARD_WIDTHS = ['58%', '44%', '66%', '38%', '52%', '47%'] as const;

export function ProjectListSkeleton(): JSX.Element {
  return (
    <div aria-busy="true" aria-live="polite" aria-label="加载项目列表">
      <div className="cds-card-grid">
        {SKELETON_CARD_WIDTHS.map((width, index) => (
          <article
            key={index}
            className="flex min-w-0 flex-col overflow-hidden rounded-lg border border-[hsl(var(--hairline))] bg-[hsl(var(--surface-raised))]"
          >
            <header className="flex items-start justify-between gap-3 px-5 pt-5">
              <div className="flex h-[1.59375rem] w-full items-center">
                <div className="cds-loading-skeleton-line h-[1.125rem]" style={{ width }} />
              </div>
            </header>
            <div
              className="relative mx-3 my-3 h-[13.75rem] overflow-hidden rounded-md border border-[hsl(var(--hairline))] bg-[hsl(var(--surface-sunken))]"
              style={{
                backgroundImage: 'radial-gradient(hsl(var(--hairline)) 1px, transparent 1px)',
                backgroundSize: '0.875rem 0.875rem',
              }}
            >
              <div className="absolute inset-0 flex items-center justify-center gap-2.5">
                {[0, 1, 2, 3].map((node) => (
                  <div
                    key={node}
                    className="cds-loading-skeleton-panel h-11 w-11 rounded-xl"
                    style={{ animationDelay: `${node * 0.14}s` }}
                  />
                ))}
              </div>
              <div className="absolute bottom-4 left-4 right-4 flex items-center gap-2">
                <div className="cds-loading-skeleton-line h-2.5 w-14" />
                <div className="cds-loading-skeleton-line h-2.5 w-24" />
              </div>
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

/** 路由 → 骨架形状。控制台外壳在 chunk 未到时按它画，和页面自己等数据时画的是同一副。 */
export function pageSkeletonForPath(pathname: string): JSX.Element {
  switch (loadingSceneForPath(pathname)?.kind) {
    case 'projects': return <ProjectListSkeleton />;
    case 'branches': return <BranchListSkeleton />;
    case 'relations': return <ContentLoading label="读取关系视图" variant="panel" />;
    case 'agent-table': return <AgentRequestsSkeleton />;
    case 'topology': return <TopologyPageSkeleton />;
    case 'release-center': return <ReleaseCenterSkeleton />;
    case 'monitor': return <MonitorCenterSkeleton />;
    case 'branch-detail': return <BranchDetailLoadingSkeleton />;
    case 'settings': return <SettingsPageSkeleton />;
    case 'project-settings': return <SettingsPageSkeleton label="加载项目设置" />;
    case 'release-console': return <ReleaseConsoleSkeleton />;
    case 'rows': return <LoadingBlock />;
    default: return <ConsoleGenericSkeleton />;
  }
}
