import { useEffect, useMemo, useState } from 'react';
import { Bot, Check, Copy, Download, ExternalLink, Package, ShieldCheck, Sparkles } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import {
  buildCdsAgentPrompt,
  chooseAgentProjectId,
  PROJECT_SKILL_PATHS,
  type AgentPageContext,
  type CdsConnectTarget,
} from '@/lib/agent-onboarding';

const MARKETPLACE_URL = 'https://miduo.org/marketplace?type=skill&keyword=cds';

export interface AgentProjectOption {
  id: string;
  name: string;
  slug: string;
}

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projects: AgentProjectOption[];
  context?: AgentPageContext;
}

type TabKey = 'connect' | 'manual' | 'marketplace';

const TABS: Array<{ key: TabKey; label: string; icon: typeof Bot; recommended?: boolean }> = [
  { key: 'connect', label: '自动接入', icon: Bot, recommended: true },
  { key: 'manual', label: '手动安装', icon: Package },
  { key: 'marketplace', label: '海鲜市场', icon: ExternalLink },
];

export function SkillDownloadDialog({ open, onOpenChange, projects, context }: Props): JSX.Element {
  const [active, setActive] = useState<TabKey>('connect');
  const [targetKind, setTargetKind] = useState<'existing' | 'new'>(projects.length > 0 ? 'existing' : 'new');
  const [projectId, setProjectId] = useState(() => chooseAgentProjectId(projects, context));

  useEffect(() => {
    if (!open) return;
    if (projects.length === 0) {
      setTargetKind('new');
      setProjectId('');
      return;
    }
    setTargetKind('existing');
    setProjectId(chooseAgentProjectId(projects, context));
  }, [open, projects, context?.id, context?.pagePath]);

  const cdsOrigin = typeof window !== 'undefined' ? window.location.origin : 'https://<your-cds-host>';
  const target: CdsConnectTarget = targetKind === 'new'
    ? { kind: 'new' }
    : { kind: 'existing', projectId: projectId || '<project-id>' };
  const prompt = useMemo(
    () => buildCdsAgentPrompt({ cdsOrigin, target, context }),
    [cdsOrigin, target.kind, projectId, context?.id, context?.pagePath],
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>接入 Agent</DialogTitle>
          <DialogDescription>
            Agent 会同时获得当前页面的任务上下文和安全边界。授权仍在 CDS 页面完成，
            不需要学习底层参数，也不需要把密钥复制到对话中。
          </DialogDescription>
        </DialogHeader>

        {context ? (
          <div
            className="rounded-lg border border-primary/30 bg-primary/5 px-4 py-3"
            data-agent-context={context.id}
            data-agent-page={context.pagePath}
          >
            <div className="flex items-start gap-3">
              <div className="mt-0.5 rounded-md border border-primary/25 bg-primary/10 p-2 text-primary">
                <Sparkles className="h-4 w-4" />
              </div>
              <div className="min-w-0">
                <div className="text-xs font-medium uppercase tracking-wider text-primary">当前页面任务</div>
                <div className="mt-1 font-medium text-foreground">{context.title}</div>
                <p className="mt-1 text-sm leading-6 text-muted-foreground">{context.summary}</p>
              </div>
            </div>
          </div>
        ) : null}

        <div className="grid gap-2 sm:grid-cols-2">
          <button
            type="button"
            onClick={() => setTargetKind('existing')}
            disabled={projects.length === 0}
            className={`rounded-md border px-3 py-2 text-left text-sm transition-colors ${
              targetKind === 'existing'
                ? 'border-primary bg-primary/10 text-foreground'
                : 'border-[hsl(var(--hairline))] bg-[hsl(var(--surface-base))] text-muted-foreground'
            } disabled:cursor-not-allowed disabled:opacity-50`}
          >
            <div className="font-medium">连接已有项目</div>
            <div className="mt-0.5 text-xs">只获得所选项目的权限</div>
          </button>
          <button
            type="button"
            onClick={() => setTargetKind('new')}
            className={`rounded-md border px-3 py-2 text-left text-sm transition-colors ${
              targetKind === 'new'
                ? 'border-primary bg-primary/10 text-foreground'
                : 'border-[hsl(var(--hairline))] bg-[hsl(var(--surface-base))] text-muted-foreground'
            }`}
          >
            <div className="font-medium">创建一个新项目</div>
            <div className="mt-0.5 text-xs">一次性权限，创建后自动失效</div>
          </button>
        </div>

        {targetKind === 'existing' ? (
          <label className="space-y-1 text-sm">
            <span className="text-xs font-medium text-foreground">选择项目</span>
            <select
              value={projectId}
              onChange={(event) => setProjectId(event.target.value)}
              className="h-9 w-full rounded-md border border-[hsl(var(--hairline))] bg-[hsl(var(--surface-base))] px-3 text-sm text-foreground"
            >
              {projects.map((project) => (
                <option key={project.id} value={project.id}>{project.name} ({project.slug})</option>
              ))}
            </select>
          </label>
        ) : null}

        <nav className="flex gap-1 border-b border-[hsl(var(--hairline))]">
          {TABS.map((tab) => {
            const Icon = tab.icon;
            const selected = active === tab.key;
            return (
              <button
                key={tab.key}
                type="button"
                onClick={() => setActive(tab.key)}
                className={`relative inline-flex h-10 shrink-0 items-center gap-2 px-3 text-sm transition-colors ${
                  selected ? 'text-foreground' : 'text-muted-foreground hover:text-foreground'
                }`}
              >
                <Icon className="h-4 w-4" />
                <span>{tab.label}</span>
                {tab.recommended ? (
                  <span className="rounded border border-primary/40 bg-primary/10 px-1.5 py-0.5 text-[10px] font-medium text-primary">
                    推荐
                  </span>
                ) : null}
                {selected ? <span className="absolute inset-x-2 bottom-0 h-px bg-primary" /> : null}
              </button>
            );
          })}
        </nav>

        <div className="min-h-[260px]">
          {active === 'connect' ? <ConnectTab prompt={prompt} /> : null}
          {active === 'manual' ? <ManualTab /> : null}
          {active === 'marketplace' ? <MarketplaceTab /> : null}
        </div>
      </DialogContent>
    </Dialog>
  );
}

function ConnectTab({ prompt }: { prompt: string }): JSX.Element {
  const [copied, setCopied] = useState(false);

  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(prompt);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    } catch {
      setCopied(false);
    }
  };

  return (
    <div className="space-y-3">
      <div className="flex items-start gap-2 rounded-md border border-primary/30 bg-primary/5 px-3 py-2 text-xs text-muted-foreground">
        <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
        <span>口令中不含密钥。Agent 发起申请后，你只需要在 CDS 右下角批准一次。</span>
      </div>
      <div className="cds-surface-raised cds-hairline relative rounded-md border border-[hsl(var(--hairline))] bg-[hsl(var(--surface-sunken))] p-3">
        <pre className="max-h-72 overflow-y-auto whitespace-pre-wrap break-words pr-12 font-mono text-xs leading-relaxed text-foreground" style={{ overscrollBehavior: 'contain' }}>
          {prompt}
        </pre>
        <Button size="sm" variant={copied ? 'default' : 'outline'} className="absolute right-2 top-2" onClick={() => void copy()}>
          {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
          {copied ? '已复制' : '复制接入口令'}
        </Button>
      </div>
    </div>
  );
}

function ManualTab(): JSX.Element {
  return (
    <div className="space-y-3 text-sm text-muted-foreground">
      <p>技能包采用通用的 SKILL.md 结构。下载后把 skills/ 下的三个目录复制到当前项目对应的技能目录。</p>
      <Button asChild>
        <a href="/api/export-skill" download>
          <Download className="h-4 w-4" />
          下载技能包
        </a>
      </Button>
      <div className="space-y-2 rounded-md border border-[hsl(var(--hairline))] bg-[hsl(var(--surface-base))] p-3">
        {PROJECT_SKILL_PATHS.map((item) => (
          <div key={item.agent} className="flex items-center justify-between gap-3 text-xs">
            <span>{item.agent}</span>
            <code className="rounded bg-[hsl(var(--surface-sunken))] px-1.5 py-0.5 text-foreground">{item.path}</code>
          </div>
        ))}
      </div>
      <p className="text-xs">默认使用项目级目录，不需要修改 PATH、终端启动文件或用户主目录。</p>
    </div>
  );
}

function MarketplaceTab(): JSX.Element {
  return (
    <div className="space-y-3 text-sm text-muted-foreground">
      <p>也可以从 PrdAgent 海鲜市场获取 CDS 技能。安装完成后仍使用“自动接入”中的页面批准流程。</p>
      <Button asChild>
        <a href={MARKETPLACE_URL} target="_blank" rel="noreferrer">
          <ExternalLink className="h-4 w-4" />
          打开海鲜市场
        </a>
      </Button>
    </div>
  );
}
