import { useMemo, useState } from 'react';
import { AlertCircle, ExternalLink, GitBranch, Home, Monitor, RefreshCw, ServerCrash, SplitSquareVertical } from 'lucide-react';

import { Button } from '@/components/ui/button';
import ShapeGrid from '@/components/effects/ShapeGrid';
import { CdsLogoLoader } from '@/components/brand/CdsMetallicLogo';
import { BranchDetailLoadingSkeleton, Section } from '@/pages/cds-settings/components';
import { PreviewPreparingSurface } from '@/pages/PreviewPreparingPage';
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
  scope: 'fullscreen' | 'partial';
  outcome: 'running' | 'failed';
  endpoint?: string;
  href?: string;
  scenarios?: LoadingScenario[];
};

type LoadingPageGroup = {
  id: 'fullscreen' | 'partial';
  label: string;
  description: string;
  sections: Array<{
    id: 'running' | 'failed';
    label: string;
    pages: LoadingPage[];
  }>;
};

const branchScenarios: LoadingScenario[] = [
  { id: 'building', label: '构建中', status: 'building' },
  { id: 'starting', label: '启动中', status: 'starting' },
  { id: 'restarting', label: '热重启', status: 'restarting' },
];

const failedBranchScenarios: LoadingScenario[] = [
  { id: 'error', label: '启动失败', status: 'error' },
  { id: 'idle', label: '分支当前未运行', status: 'idle' },
  { id: 'stopping', label: '正在停止 / 不可达', status: 'stopping' },
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
    scope: 'fullscreen',
    outcome: 'running',
    endpoint: '/api/loading-pages/cds-waiting-room/preview',
    scenarios: branchScenarios,
  },
  {
    id: 'branch-deploy-error',
    name: '分支部署异常',
    description: '分支已登记但部署失败、未运行、正在停止、服务异常或容器不可用时展示。只要不是等待会自然完成，就使用失败背景。',
    icon: ServerCrash,
    kind: 'iframe',
    scope: 'fullscreen',
    outcome: 'failed',
    endpoint: '/api/loading-pages/cds-waiting-room/preview',
    scenarios: failedBranchScenarios,
  },
  {
    id: 'branch-detail-loading',
    name: '分支详情加载态',
    description: '右侧分支详情抽屉读取数据时展示，避免用户误判为空白。',
    icon: SplitSquareVertical,
    kind: 'local',
    scope: 'partial',
    outcome: 'running',
  },
  {
    id: 'container-log-loading',
    name: '容器日志加载态',
    description: '部署页读取 docker logs 时展示，避免日志区域突然空白。',
    icon: GitBranch,
    kind: 'local',
    scope: 'partial',
    outcome: 'running',
  },
  {
    id: 'preview-preparing',
    name: '预览环境准备中',
    description: '点击预览后新窗口短暂出现的 CDS 全屏准备页，与真实新窗口共用 Hyperspeed 背景。',
    icon: ExternalLink,
    kind: 'local',
    scope: 'fullscreen',
    outcome: 'running',
  },
  {
    id: 'common-loading-block',
    name: '通用内容加载态',
    description: '复用 LoadingBlock 的列表、详情、日志与设置加载状态，统一纳入预览。',
    icon: GitBranch,
    kind: 'local',
    scope: 'partial',
    outcome: 'running',
    scenarios: commonLoadingScenarios,
  },
  {
    id: 'cds-home-loading',
    name: 'CDS 首页加载态',
    description: '控制台首页或项目列表首次读取项目状态时的内容加载态，不再误用预览分支等待页。',
    icon: Home,
    kind: 'local',
    scope: 'partial',
    outcome: 'running',
  },
  {
    id: 'common-error-block',
    name: '局部错误提示',
    description: '内容块请求失败时的轻量错误状态，保留网格背景和清晰前缀，不进入全屏故障页。',
    icon: AlertCircle,
    kind: 'local',
    scope: 'partial',
    outcome: 'failed',
  },
  {
    id: 'cds-waiting-room-legacy',
    name: '构建等待页（备用）',
    description: '保留上一版 ShapeGrid 构建等待页，用于备用方案对照。',
    icon: Monitor,
    kind: 'iframe',
    scope: 'fullscreen',
    outcome: 'running',
    endpoint: '/api/loading-pages/cds-waiting-room-legacy/preview',
    scenarios: branchScenarios,
  },
  {
    id: 'branch-gone',
    name: '启动失败页',
    description: '访问已删除、未部署或不可路由的预览分支时展示，属于不可自动恢复状态。',
    icon: ServerCrash,
    kind: 'iframe',
    scope: 'fullscreen',
    outcome: 'failed',
    endpoint: '/api/loading-pages/branch-gone/preview',
  },
];

const loadingPageGroups: LoadingPageGroup[] = [
  {
    id: 'fullscreen',
    label: '全屏状态页',
    description: '预览访问、启动、构建、不可恢复错误等会占满浏览器窗口的状态。',
    sections: [
      { id: 'running', label: '进行中 / 可恢复', pages: loadingPages.filter((page) => page.scope === 'fullscreen' && page.outcome === 'running') },
      { id: 'failed', label: '失败 / 不可恢复', pages: loadingPages.filter((page) => page.scope === 'fullscreen' && page.outcome === 'failed') },
    ],
  },
  {
    id: 'partial',
    label: '局部加载块',
    description: '抽屉、列表、表单、日志等内容区域内的轻量等待或错误块。',
    sections: [
      { id: 'running', label: '读取中', pages: loadingPages.filter((page) => page.scope === 'partial' && page.outcome === 'running') },
      { id: 'failed', label: '失败提示', pages: loadingPages.filter((page) => page.scope === 'partial' && page.outcome === 'failed') },
    ],
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
    if (page.id === 'cds-waiting-room' || page.id === 'cds-waiting-room-legacy' || page.id === 'branch-deploy-error') {
      params.set('status', scenario?.status || (page.id === 'branch-deploy-error' ? 'error' : 'building'));
      params.set(
        'branch',
        page.id === 'cds-waiting-room-legacy'
          ? 'shape-grid-waiting-backup'
          : page.id === 'branch-deploy-error'
            ? 'claude/unreachable-preview'
            : 'reactbits-magic-rings-preview',
      );
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
      description="集中查看用户会实际遇到的 CDS 状态页。全屏状态页固定按真实暗色画布预览；局部加载块跟随当前主题。"
    >
      <div className="space-y-4">
        <div className="space-y-4 border-b border-[hsl(var(--hairline))] pb-4">
          <div className="flex items-center justify-end gap-2">
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
          {loadingPageGroups.map((group) => (
            <div key={group.id} className="space-y-2">
              <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                <div className="text-sm font-semibold">{group.label}</div>
                <div className="text-xs text-muted-foreground">{group.description}</div>
              </div>
              <div className="grid gap-2 lg:grid-cols-2">
                {group.sections.map((section) => (
                  <div key={`${group.id}-${section.id}`} className="rounded-md border border-[hsl(var(--hairline))] bg-[hsl(var(--surface-sunken))]/35 p-2">
                    <div className="mb-2 px-1 text-xs font-semibold text-muted-foreground">{section.label}</div>
                    <div className="flex flex-wrap gap-1.5">
                      {section.pages.map((item) => {
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
                                : 'border-[hsl(var(--hairline))] bg-[hsl(var(--surface-raised))]/65 text-muted-foreground hover:border-[hsl(var(--hairline-strong))] hover:text-foreground',
                            )}
                          >
                            <Icon className="h-4 w-4" />
                            {item.name}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ))}
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
          <div
            data-theme={page.scope === 'fullscreen' ? 'dark' : undefined}
            className={cn(
              'relative w-full overflow-hidden',
              page.scope === 'fullscreen'
                ? 'aspect-[16/9] min-h-[520px] bg-[#08070d] text-white'
                : 'min-h-[220px] bg-transparent text-foreground',
            )}
          >
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
              <PreviewPreparingSurface
                branch="preview-handoff"
                status="准备中"
              />
            ) : page.id === 'container-log-loading' ? (
              <ShapeGridSkeletonPreview tone="log" label="正在加载容器日志" />
            ) : page.id === 'cds-home-loading' ? (
              <ShapeGridWaitingPreview
                compact
                heading="CDS 首页加载中"
                subtitle="正在读取项目、分支与运行状态。"
                branch="project-list"
                status="同步中"
                services={['项目列表', '运行状态']}
              />
            ) : page.id === 'common-loading-block' ? (
              <ShapeGridSkeletonPreview
                label={scenario?.loadingLabel || commonLoadingScenarios[0].loadingLabel || '加载中'}
              />
            ) : page.id === 'common-error-block' ? (
              <PartialErrorPreview
                label="读取失败"
                detail="请求返回异常或会话过期时，在当前内容区域内给出明确提示。"
              />
            ) : (
              <ShapeGridSkeletonPreview label="加载中" />
            )}
          </div>
        </div>
      </div>
    </Section>
  );
}

function ShapeGridWaitingPreview({
  heading,
  subtitle,
  branch,
  status,
  services,
  compact = false,
}: {
  heading: string;
  subtitle: string;
  branch: string;
  status: string;
  services: string[];
  compact?: boolean;
}): JSX.Element {
  return (
    <div className="relative h-full overflow-hidden bg-[#120f17] text-[#f7f5ff]">
      <ShapeGrid
        className="absolute inset-0 h-full w-full"
        direction="diagonal"
        speed={0.39}
        squareSize={34}
        shape="hexagon"
        borderColor="rgba(255,255,255,0.09)"
        hoverFillColor="rgba(255,255,255,0.035)"
        hoverTrailAmount={0}
      />
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(900px_620px_at_52%_46%,rgba(255,255,255,0.08),transparent_36%,rgba(18,15,23,0.82)_100%),linear-gradient(90deg,rgba(18,15,23,0.9),rgba(18,15,23,0.22)_48%,rgba(18,15,23,0.84))]" />
      <main className="relative z-10 grid h-full grid-cols-1 items-center px-[clamp(20px,6vw,92px)] py-[clamp(32px,7vw,92px)] lg:grid-cols-[minmax(280px,720px)_minmax(0,1fr)]">
        <section className="max-w-[720px] [text-shadow:0_2px_30px_rgba(0,0,0,0.72)]">
          <div className="mb-7 inline-flex items-center gap-2.5 font-mono text-[11px] uppercase tracking-[0.28em] text-[#ded8ef]">
            <CdsLogoLoader size="sm" className="text-[#f7f5ff]" />
            CDS Waiting Room
          </div>
          <h1 className={cn('max-w-full leading-[0.96] tracking-normal', compact ? 'text-[clamp(34px,4.5vw,62px)]' : 'text-[clamp(42px,5.6vw,82px)]')}>
            <span className="inline-block bg-[linear-gradient(120deg,rgba(247,245,255,0.76)_0%,rgba(247,245,255,0.76)_38%,#fff_48%,rgba(255,255,255,0.96)_52%,rgba(247,245,255,0.76)_62%,rgba(247,245,255,0.76)_100%)] bg-[length:220%_100%] bg-clip-text text-transparent animate-[shiny-text_3.2s_linear_infinite]">
              {heading}
            </span>
          </h1>
          <p className="mt-6 max-w-[580px] text-[clamp(15px,1.45vw,20px)] leading-[1.75] text-white/62">{subtitle}</p>
          <div className="mt-7 flex flex-wrap gap-3">
            <span className="rounded-full border border-white/12 bg-white/[0.035] px-4 py-2 font-mono text-xs text-[#dde3ea] backdrop-blur-md">{branch}</span>
            <span className="rounded-full border border-white/12 bg-white/[0.035] px-4 py-2 text-xs text-[#dde3ea] backdrop-blur-md">状态 · {status}</span>
          </div>
          <div className="mt-8 flex max-w-[620px] flex-col gap-3">
            {services.map((service, index) => (
              <div key={service} className="relative flex items-center gap-3 overflow-hidden border-t border-white/10 py-3 text-[15px]">
                <span className="h-2 w-2 rounded-full bg-[#dbe4ee] shadow-[0_0_14px_#dbe4ee]" />
                <span>{service} · {index === 0 ? '进行中' : '等待中'}</span>
              </div>
            ))}
          </div>
          <div className="mt-7 w-[min(620px,100%)] rounded-[18px] border border-white/12 bg-white/[0.035] p-4 backdrop-blur-md">
            <div className="mb-2 flex items-center justify-between gap-3 text-xs text-white/70">
              <span>预计处理进度</span>
              <strong className="font-mono text-[15px] text-slate-50">{compact ? '42%' : '68%'}</strong>
            </div>
            <div className="h-1.5 overflow-hidden rounded-full bg-white/10">
              <span className={cn('block h-full rounded-full bg-[linear-gradient(90deg,#fff,#9f5050)] shadow-[0_0_18px_rgba(255,255,255,0.22)]', compact ? 'w-[42%]' : 'w-[68%]')} />
            </div>
          </div>
        </section>
      </main>
    </div>
  );
}

function ShapeGridSkeletonPreview({
  label,
  tone = 'compact',
}: {
  label: string;
  tone?: 'detail' | 'compact' | 'log' | 'home';
}): JSX.Element {
  const expanded = tone === 'detail' || tone === 'home';

  return (
    <div
      className={cn(
        'cds-shape-panel flex items-center justify-center rounded-md border border-dashed border-border text-muted-foreground',
        expanded ? 'min-h-[320px] px-8 py-10' : 'min-h-[168px] px-4 py-5',
      )}
    >
      <ShapeGrid
        className="cds-shape-backdrop"
        direction="diagonal"
        speed={0.1}
        squareSize={expanded ? 40 : 34}
        hoverTrailAmount={0}
      />
      <div className={cn('relative z-10 flex items-center', expanded ? 'max-w-xl flex-col gap-3 text-center' : 'gap-2')}>
        <CdsLogoLoader
          label={label}
          size={expanded ? 'md' : 'sm'}
          className="text-sm font-medium text-muted-foreground"
        />
        {expanded ? (
          <p className="max-w-lg text-sm leading-6 text-muted-foreground/75">
            CDS 正在读取当前区域所需的数据，完成后会在原位置替换为真实内容。
          </p>
        ) : null}
      </div>
    </div>
  );
}

function PartialErrorPreview({ label, detail }: { label: string; detail: string }): JSX.Element {
  return (
    <div className="cds-shape-panel flex min-h-[168px] items-center justify-center rounded-md border border-dashed border-destructive/35 px-4 py-5 text-destructive">
      <ShapeGrid
        className="cds-shape-backdrop"
        speed={0.08}
        squareSize={34}
        borderColor="hsl(var(--destructive) / 0.16)"
        hoverFillColor="hsl(var(--destructive) / 0.08)"
        hoverTrailAmount={0}
      />
      <div className="relative z-10 flex max-w-xl items-center gap-3">
        <AlertCircle className="h-5 w-5 shrink-0" />
        <div className="min-w-0">
          <div className="text-sm font-semibold">{label}</div>
          <div className="mt-1 text-sm leading-6 text-destructive/75">{detail}</div>
        </div>
      </div>
    </div>
  );
}
