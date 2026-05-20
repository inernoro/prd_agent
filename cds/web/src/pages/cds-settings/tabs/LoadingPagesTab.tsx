import { useMemo, useState } from 'react';
import { ExternalLink, Home, LogIn, Monitor, RefreshCw, ServerCrash, SplitSquareVertical } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Section } from '@/pages/cds-settings/components';
import { cn } from '@/lib/utils';

type LoadingScenario = {
  id: string;
  label: string;
  status: string;
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
  { id: 'stopping', label: '停止中', status: 'stopping' },
  { id: 'error', label: '异常', status: 'error' },
];

const loadingPages: LoadingPage[] = [
  {
    id: 'cds-waiting-room',
    name: '分支等待页',
    description: '预览域名访问到构建中、启动中、热重启或异常的分支时展示。',
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
    description: '控制台首页或项目列表首次加载时的品牌化等待状态。',
    icon: Home,
    kind: 'local',
  },
  {
    id: 'branch-gone',
    name: '预览已下线页',
    description: '访问已删除、未部署或不可路由的预览分支时展示。',
    icon: ServerCrash,
    kind: 'iframe',
    endpoint: '/api/loading-pages/branch-gone/preview',
  },
];

export function LoadingPagesTab(): JSX.Element {
  const [pageId, setPageId] = useState(loadingPages[0].id);
  const [scenarioId, setScenarioId] = useState(branchScenarios[0].id);
  const [reloadKey, setReloadKey] = useState(0);

  const page = loadingPages.find((item) => item.id === pageId) || loadingPages[0];
  const scenarios = page.scenarios || [];
  const scenario = scenarios.find((item) => item.id === scenarioId) || scenarios[0] || null;

  const previewUrl = useMemo(() => {
    if (page.kind !== 'iframe' || !page.endpoint) return '';
    const params = new URLSearchParams({ theme: 'dark', t: String(reloadKey) });
    if (page.id === 'cds-waiting-room') {
      params.set('status', scenario?.status || 'building');
      params.set('branch', 'reactbits-shape-grid-preview');
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
          <div className="relative aspect-[16/9] min-h-[520px] w-full overflow-hidden bg-[#08070d] text-white">
            {page.kind === 'iframe' ? (
              <iframe
                key={previewUrl}
                title={page.name}
                src={previewUrl}
                className="block h-full w-full border-0 bg-transparent"
              />
            ) : page.id === 'cds-home-loading' ? (
              <CdsHomeLoadingPreview theme="dark" />
            ) : (
              <BranchDetailLoadingPreview theme="dark" />
            )}
          </div>
        </div>
      </div>
    </Section>
  );
}

function PreviewRings({ theme }: { theme: 'dark' | 'light' }): JSX.Element {
  return (
    <div className="pointer-events-none absolute inset-0 overflow-hidden">
      <div
        className={cn(
          'absolute inset-[-16%] animate-[cds-preview-ring-drift_12s_ease-in-out_infinite_alternate] rounded-full opacity-80',
          theme === 'light' ? 'cds-loading-preview-rings-light' : 'cds-loading-preview-rings-dark',
        )}
      />
      <div className="absolute inset-0 bg-[radial-gradient(circle_at_54%_46%,transparent_0%,transparent_42%,hsl(var(--surface-base)/0.52)_100%)]" />
    </div>
  );
}

function BranchDetailLoadingPreview({ theme }: { theme: 'dark' | 'light' }): JSX.Element {
  return (
    <div className="relative h-full overflow-hidden bg-[hsl(var(--surface-base))] text-foreground">
      <PreviewRings theme={theme} />
      <div className="relative z-10 h-full px-10 py-8">
        <div className="mb-8 flex items-center justify-between">
          <div className="space-y-3">
            <SkeletonLine className="h-6 w-56" />
            <SkeletonLine className="h-4 w-80 opacity-70" />
          </div>
          <div className="flex gap-3">
            <SkeletonLine className="h-9 w-24 rounded-md opacity-75" />
            <SkeletonLine className="h-9 w-9 rounded-md opacity-65" />
          </div>
        </div>
        <div className="cds-loading-skeleton-panel mb-8 h-[58%] rounded-lg" />
        <div className="space-y-5">
          <SkeletonLine className="h-6 w-[18%]" />
          <SkeletonLine className="h-6 w-[28%] opacity-80" />
          <SkeletonLine className="h-6 w-[22%] opacity-65" />
        </div>
      </div>
    </div>
  );
}

function SkeletonLine({ className }: { className: string }): JSX.Element {
  return <div className={`cds-loading-skeleton-line ${className}`} />;
}

function CdsHomeLoadingPreview({ theme }: { theme: 'dark' | 'light' }): JSX.Element {
  return (
    <div className="relative h-full overflow-hidden bg-[hsl(var(--surface-base))] text-foreground">
      <PreviewRings theme={theme} />
      <div className="relative z-10 grid h-full grid-cols-[220px_minmax(0,1fr)]">
        <aside className="border-r border-[hsl(var(--hairline))] bg-[hsl(var(--surface-raised))]/42 px-5 py-6 backdrop-blur">
          <div className="mb-8 text-sm font-semibold">Cloud Dev Suite</div>
          <div className="space-y-3 text-sm text-muted-foreground">
            <div className="h-9 rounded bg-[hsl(var(--surface-sunken))]" />
            <div className="h-9 rounded bg-[hsl(var(--surface-sunken))]/70" />
            <div className="h-9 rounded bg-[hsl(var(--surface-sunken))]/70" />
          </div>
        </aside>
        <main className="p-8">
          <div className="mb-8 flex items-center justify-between">
            <div>
              <div className="mb-2 h-8 w-52 rounded bg-foreground/12" />
              <div className="h-4 w-72 rounded bg-foreground/8" />
            </div>
            <div className="inline-flex items-center gap-2 rounded-full border border-[hsl(var(--hairline))] bg-[hsl(var(--surface-raised))]/70 px-4 py-2 text-sm text-muted-foreground">
              <RefreshCw className="h-4 w-4 animate-spin" />
              同步项目状态
            </div>
          </div>
          <div className="grid grid-cols-3 gap-4">
            {Array.from({ length: 6 }).map((_, index) => (
              <div key={index} className="h-36 rounded-md border border-[hsl(var(--hairline))] bg-[hsl(var(--surface-raised))]/60 p-4 backdrop-blur">
                <div className="mb-5 h-5 w-2/3 rounded bg-foreground/12" />
                <div className="mb-3 h-4 w-1/2 rounded bg-foreground/8" />
                <div className="h-4 w-3/4 rounded bg-foreground/8" />
              </div>
            ))}
          </div>
        </main>
      </div>
    </div>
  );
}
