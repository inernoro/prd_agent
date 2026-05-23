import { useMemo, useState } from 'react';
import { ExternalLink, GitBranch, Home, LogIn, Monitor, RefreshCw, ServerCrash, SplitSquareVertical } from 'lucide-react';

import { Button } from '@/components/ui/button';
import ShapeGrid from '@/components/effects/ShapeGrid';
import { BranchDetailLoadingSkeleton, Section } from '@/pages/cds-settings/components';
import { cn } from '@/lib/utils';

type LoadingScenario = {
  id: string;
  label: string;
  status: string;
  loadingLabel?: string;
};

type LoadingPage = {
  id: string;
  name: string;
  description: string;
  icon: typeof Monitor;
  kind: 'iframe' | 'local';
  endpoint?: string;
  href?: string;
  scenarios?: LoadingScenario[];
};

const branchScenarios: LoadingScenario[] = [
  { id: 'building', label: '构建中', status: 'building' },
  { id: 'starting', label: '启动中', status: 'starting' },
  { id: 'restarting', label: '热重启', status: 'restarting' },
  { id: 'error', label: '启动失败', status: 'error' },
];

const commonLoadingScenarios: LoadingScenario[] = [
  { id: 'branch-list', label: '分支列表', status: 'loading', loadingLabel: '加载项目与本地分支列表' },
  { id: 'project-list', label: '项目列表', status: 'loading', loadingLabel: '加载项目列表' },
  { id: 'branch-detail', label: '分支详情', status: 'loading', loadingLabel: '加载分支详情' },
  { id: 'container-logs', label: '容器日志', status: 'loading', loadingLabel: '加载容器日志' },
  { id: 'webhook-logs', label: 'Webhook 日志', status: 'loading', loadingLabel: '加载 Webhook 日志' },
  { id: 'service-topology', label: '服务拓扑', status: 'loading', loadingLabel: '加载服务拓扑' },
  { id: 'github-repos', label: 'GitHub 仓库', status: 'loading', loadingLabel: '加载 GitHub 仓库' },
  { id: 'github-app', label: 'GitHub App', status: 'loading', loadingLabel: '加载 GitHub App 状态' },
  { id: 'github-installations', label: '安装列表', status: 'loading', loadingLabel: '加载安装' },
  { id: 'repo-select', label: '仓库选择', status: 'loading', loadingLabel: '加载仓库' },
  { id: 'device-flow', label: 'Device Flow', status: 'loading', loadingLabel: '加载 Device Flow 状态' },
  { id: 'project-settings', label: '项目设置', status: 'loading', loadingLabel: '加载项目设置' },
  { id: 'build-config', label: '构建配置', status: 'loading', loadingLabel: '加载构建配置' },
  { id: 'env-vars', label: '环境变量', status: 'loading', loadingLabel: '加载环境变量' },
  { id: 'agent-keys', label: 'Agent Keys', status: 'loading', loadingLabel: '加载 Agent Keys' },
  { id: 'global-agent-keys', label: '全局 Agent Keys', status: 'loading', loadingLabel: '加载全局 Agent Keys' },
  { id: 'comment-template', label: '评论模板', status: 'loading', loadingLabel: '加载评论模板' },
  { id: 'cache-diagnostics', label: '缓存诊断', status: 'loading', loadingLabel: '加载缓存诊断' },
  { id: 'branch-stats', label: '分支统计', status: 'loading', loadingLabel: '加载分支统计' },
  { id: 'activity-log', label: '活动日志', status: 'loading', loadingLabel: '加载活动日志' },
  { id: 'cds-source-branches', label: 'CDS 源码分支', status: 'loading', loadingLabel: '读取 CDS 源码分支' },
];

const loadingPages: LoadingPage[] = [
  {
    id: 'cds-waiting-room',
    name: '构建 / 启动等待页',
    description: '预览域名访问到构建中、启动中、热重启或上游窗口期时展示。内部细节统一收敛到此页。',
    icon: Monitor,
    kind: 'iframe',
    endpoint: '/api/loading-pages/cds-waiting-room/preview',
    scenarios: branchScenarios,
  },
  {
    id: 'branch-detail-loading',
    name: '分支详情加载态',
    description: '右侧分支详情抽屉读取数据时展示，避免用户误判为空白。',
    icon: SplitSquareVertical,
    kind: 'local',
  },
  {
    id: 'container-log-loading',
    name: '容器日志加载态',
    description: '部署页读取 docker logs 时展示，避免日志区域突然空白。',
    icon: GitBranch,
    kind: 'local',
  },
  {
    id: 'preview-preparing',
    name: '预览环境准备中',
    description: '点击预览后新窗口短暂出现的 CDS 全屏准备页，和分支环境构建等待页使用同一视觉体系。',
    icon: ExternalLink,
    kind: 'local',
  },
  {
    id: 'common-loading-block',
    name: '通用内容加载态',
    description: '复用 LoadingBlock 的列表、详情、日志与设置加载状态，统一纳入预览。',
    icon: GitBranch,
    kind: 'local',
    scenarios: commonLoadingScenarios,
  },
  {
    id: 'github-login',
    name: 'GitHub 登录页',
    description: '未登录或会话失效时进入的系统登录页。',
    icon: LogIn,
    kind: 'iframe',
    endpoint: '/login.html',
  },
  {
    id: 'cds-home-loading',
    name: 'CDS 首页加载态',
    description: '控制台首页或项目列表首次加载时复用分支环境正在构建的 Magic Rings 等待状态。',
    icon: Home,
    kind: 'iframe',
    endpoint: '/api/loading-pages/cds-waiting-room/preview',
  },
  {
    id: 'cds-waiting-room-legacy',
    name: '构建等待页（备用）',
    description: '保留上一版 ShapeGrid 构建等待页，用于备用方案对照。',
    icon: Monitor,
    kind: 'iframe',
    endpoint: '/api/loading-pages/cds-waiting-room-legacy/preview',
    scenarios: branchScenarios,
  },
  {
    id: 'branch-gone',
    name: '启动失败页',
    description: '访问已删除、未部署或不可路由的预览分支时展示，属于不可自动恢复状态。',
    icon: ServerCrash,
    kind: 'iframe',
    endpoint: '/api/loading-pages/branch-gone/preview',
  },
];

export function LoadingPagesTab(): JSX.Element {
  const [pageId, setPageId] = useState('branch-detail-loading');
  const [scenarioId, setScenarioId] = useState(branchScenarios[0].id);
  const [reloadKey, setReloadKey] = useState(0);

  const page = loadingPages.find((item) => item.id === pageId) || loadingPages[0];
  const scenarios = page.scenarios || [];
  const scenario = scenarios.find((item) => item.id === scenarioId) || scenarios[0] || null;

  const previewUrl = useMemo(() => {
    if (page.kind !== 'iframe' || !page.endpoint) return '';
    const params = new URLSearchParams({ theme: 'dark', t: String(reloadKey) });
    if (page.id === 'cds-waiting-room' || page.id === 'cds-home-loading' || page.id === 'cds-waiting-room-legacy') {
      params.set('status', scenario?.status || 'building');
      params.set('branch', page.id === 'cds-home-loading' ? 'cds-home-loading' : page.id === 'cds-waiting-room-legacy' ? 'shape-grid-waiting-backup' : 'reactbits-magic-rings-preview');
      params.set('waitingProfile', 'api');
    } else if (page.id === 'branch-gone') {
      params.set('branch', 'claude/deleted-preview-branch-demo');
    }
    const separator = page.endpoint.includes('?') ? '&' : '?';
    return `${page.endpoint}${separator}${params.toString()}`;
  }, [page.endpoint, page.id, page.kind, reloadKey, scenario?.status]);

  return (
    <Section
      title="加载页预览"
      description="集中查看用户会实际遇到的 CDS 状态页。预览固定使用暗色画布，避免浅色主题下加载动效发虚。"
    >
      <div className="space-y-4">
        <div className="flex flex-wrap items-center gap-2 border-b border-[hsl(var(--hairline))] pb-3">
          <div className="flex min-w-0 flex-1 flex-wrap gap-1.5">
            {loadingPages.map((item) => {
              const Icon = item.icon;
              const active = pageId === item.id;
              return (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => {
                    setPageId(item.id);
                    if (item.scenarios && !item.scenarios.some((entry) => entry.id === scenarioId)) {
                      setScenarioId(item.scenarios[0]?.id || '');
                    }
                  }}
                  className={cn(
                    'inline-flex h-9 items-center gap-2 rounded-md border px-3 text-sm font-semibold transition-colors',
                    active
                      ? 'border-primary/45 bg-primary/10 text-foreground'
                      : 'border-[hsl(var(--hairline))] bg-[hsl(var(--surface-sunken))]/45 text-muted-foreground hover:border-[hsl(var(--hairline-strong))] hover:text-foreground',
                  )}
                >
                  <Icon className="h-4 w-4" />
                  {item.name}
                </button>
              );
            })}
          </div>

          <Button type="button" size="sm" variant="outline" onClick={() => setReloadKey((value) => value + 1)}>
            <RefreshCw />刷新
          </Button>
          {previewUrl ? (
            <Button asChild size="sm" variant="ghost">
              <a href={previewUrl} target="_blank" rel="noreferrer">
                <ExternalLink />新窗口
              </a>
            </Button>
          ) : null}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-semibold">{page.name}</div>
            <div className="mt-1 text-xs text-muted-foreground">{page.description}</div>
          </div>
          {scenarios.length > 0 ? (
            <div className="flex flex-wrap gap-1.5">
              {scenarios.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => setScenarioId(item.id)}
                  className={cn(
                    'h-8 rounded-md border px-3 text-xs transition-colors',
                    scenarioId === item.id
                      ? 'border-primary/45 bg-primary/15 text-primary'
                      : 'border-[hsl(var(--hairline))] text-muted-foreground hover:border-primary/35 hover:text-primary',
                  )}
                >
                  {item.label}
                </button>
              ))}
            </div>
          ) : null}
        </div>

        <div className="overflow-hidden rounded-none bg-transparent">
          <div data-theme="dark" className="relative aspect-[16/9] min-h-[520px] w-full overflow-hidden bg-[#08070d] text-white">
            {page.kind === 'iframe' ? (
              <iframe
                key={previewUrl}
                title={page.name}
                src={previewUrl}
                className="block h-full w-full border-0 bg-transparent"
              />
            ) : page.id === 'branch-detail-loading' ? (
              <BranchDetailLoadingSkeleton className="h-full min-h-0" />
            ) : page.id === 'preview-preparing' ? (
              <ShapeGridSkeletonPreview tone="compact" label="预览环境准备中" />
            ) : page.id === 'container-log-loading' ? (
              <ShapeGridSkeletonPreview tone="log" label="正在加载容器日志" />
            ) : page.id === 'cds-home-loading' ? (
              <ShapeGridSkeletonPreview tone="home" label="CDS 首页正在同步" />
            ) : page.id === 'common-loading-block' ? (
              <ShapeGridSkeletonPreview label={scenario?.loadingLabel || commonLoadingScenarios[0].loadingLabel || '加载中'} />
            ) : (
              <ShapeGridSkeletonPreview label="加载中" />
            )}
          </div>
        </div>
      </div>
    </Section>
  );
}

function ShapeGridSkeletonPreview({
  label,
  tone = 'detail',
}: {
  label: string;
  tone?: 'detail' | 'compact' | 'log' | 'home';
}): JSX.Element {
  const showCenterLabel = tone === 'compact' || tone === 'log';

  return (
    <div className="relative h-full overflow-hidden bg-[#090a0f] text-white">
      <ShapeGrid
        className="absolute inset-0 h-full w-full"
        direction="diagonal"
        speed={0.39}
        squareSize={34}
        shape="hexagon"
        borderColor="rgba(255,255,255,0.052)"
        hoverFillColor="rgba(255,255,255,0.035)"
        hoverTrailAmount={0}
      />
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_55%_44%,rgba(255,255,255,0.035),transparent_36%),linear-gradient(90deg,rgba(9,10,15,0.96),rgba(9,10,15,0.62)_48%,rgba(9,10,15,0.93))]" />
      <div className="relative z-10 h-full px-[clamp(28px,4.2vw,64px)] py-[clamp(24px,3.6vw,52px)]">
        <div className="flex flex-wrap items-center gap-5">
          <div className="cds-loading-skeleton-line h-[74px] w-[194px] rounded-[20px]" />
          <div className="cds-loading-skeleton-line h-[74px] w-[194px] rounded-[20px] opacity-90" />
          <div className="cds-loading-skeleton-line h-[74px] w-[170px] rounded-[20px] opacity-80" />
        </div>

        <div
          className={cn(
            'cds-loading-skeleton-panel relative mt-12 rounded-[28px]',
            tone === 'log' ? 'h-[58%]' : 'h-[64%]',
            tone === 'home' ? 'max-w-[88%]' : 'w-full',
          )}
        >
          {showCenterLabel ? (
            <div className="absolute inset-0 flex items-center justify-center">
              <div className="inline-flex items-center gap-3 rounded-xl border border-white/8 bg-black/12 px-5 py-3 text-[clamp(15px,1.6vw,22px)] text-white/42 backdrop-blur-sm">
                <span className="h-5 w-5 rounded-full border-2 border-white/22 border-t-white/58 animate-spin" />
                {label}
              </div>
            </div>
          ) : null}
        </div>

        <div className="mt-12 space-y-7 pb-4">
          <div className="cds-loading-skeleton-line h-11 w-[28%] min-w-72 rounded-[18px]" />
          <div className="cds-loading-skeleton-line h-11 w-[38%] min-w-96 rounded-[18px] opacity-88" />
          <div className="cds-loading-skeleton-line h-11 w-[30%] min-w-80 rounded-[18px] opacity-74" />
        </div>

        {!showCenterLabel ? (
          <div className="sr-only" aria-live="polite">
            {label}
          </div>
        ) : null}
      </div>
    </div>
  );
}
