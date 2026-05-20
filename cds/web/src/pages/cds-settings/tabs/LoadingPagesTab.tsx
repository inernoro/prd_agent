import { useMemo, useState } from 'react';
import { ExternalLink, Monitor, RefreshCw } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Section } from '@/pages/cds-settings/components';

type LoadingScenario = {
  id: string;
  label: string;
  status: string;
};

const loadingPages = [
  {
    id: 'cds-waiting-room',
    name: '分支等待页',
    description: '预览域名访问到构建中、启动中或热重启中的分支时展示。',
    endpoint: '/api/loading-pages/cds-waiting-room/preview',
    productionPath: 'ProxyService.serveStartingPageV2',
  },
];

const scenarios: LoadingScenario[] = [
  { id: 'building', label: '构建中', status: 'building' },
  { id: 'starting', label: '启动中', status: 'starting' },
  { id: 'restarting', label: '热重启', status: 'restarting' },
  { id: 'error', label: '异常', status: 'error' },
];

export function LoadingPagesTab(): JSX.Element {
  const [pageId, setPageId] = useState(loadingPages[0].id);
  const [scenarioId, setScenarioId] = useState(scenarios[0].id);
  const [reloadKey, setReloadKey] = useState(0);

  const page = loadingPages.find((item) => item.id === pageId) || loadingPages[0];
  const scenario = scenarios.find((item) => item.id === scenarioId) || scenarios[0];
  const previewUrl = useMemo(() => {
    const params = new URLSearchParams({
      status: scenario.status,
      branch: 'reactbits-shape-grid-preview',
      waitingProfile: 'api',
      t: String(reloadKey),
    });
    return `${page.endpoint}?${params.toString()}`;
  }, [page.endpoint, reloadKey, scenario.status]);

  return (
    <Section
      title="加载页预览"
      description="集中查看不容易稳定触发的 CDS 加载页。预览 iframe 直接加载生产端点，背景、透明度和动效与真实访问路径保持一致。"
    >
      <div className="space-y-3">
        <div className="flex flex-wrap items-center gap-2 border-b border-[hsl(var(--hairline))] pb-3">
          <div className="flex min-w-0 flex-1 flex-wrap gap-1.5">
            {loadingPages.map((item) => (
              <button
                key={item.id}
                type="button"
                onClick={() => setPageId(item.id)}
                className={`inline-flex h-9 items-center gap-2 rounded-md border px-3 text-sm font-semibold transition-colors ${
                  pageId === item.id
                    ? 'border-primary/45 bg-primary/10 text-foreground'
                    : 'border-[hsl(var(--hairline))] bg-[hsl(var(--surface-sunken))]/45 text-muted-foreground hover:border-[hsl(var(--hairline-strong))] hover:text-foreground'
                }`}
              >
                <Monitor className="h-4 w-4" />
                {item.name}
              </button>
            ))}
          </div>

          <Button type="button" size="sm" variant="outline" onClick={() => setReloadKey((value) => value + 1)}>
            <RefreshCw />刷新
          </Button>
          <Button asChild size="sm" variant="ghost">
            <a href={previewUrl} target="_blank" rel="noreferrer">
              <ExternalLink />新窗口
            </a>
          </Button>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-semibold">{page.name}</div>
            <div className="mt-1 text-xs text-muted-foreground">{page.description}</div>
          </div>
          <div className="flex flex-wrap gap-1.5">
            {scenarios.map((item) => (
              <button
                key={item.id}
                type="button"
                onClick={() => setScenarioId(item.id)}
                className={`h-8 rounded-md border px-3 text-xs transition-colors ${
                  scenarioId === item.id
                    ? 'border-primary/45 bg-primary/15 text-primary'
                    : 'border-[hsl(var(--hairline))] text-muted-foreground hover:border-primary/35 hover:text-primary'
                }`}
              >
                {item.label}
              </button>
            ))}
          </div>
        </div>

        <div className="flex justify-center bg-[#050407] p-0">
          <div className="aspect-[4/3] h-auto max-h-[min(760px,72vh)] w-full max-w-[calc(min(760px,72vh)*4/3)] overflow-hidden bg-[#050407]">
            <iframe
              key={previewUrl}
              title={`${page.name} ${scenario.label}`}
              src={previewUrl}
              className="block h-full w-full border-0"
            />
          </div>
        </div>
      </div>
    </Section>
  );
}
