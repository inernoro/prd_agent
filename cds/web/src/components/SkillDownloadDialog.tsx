import { useEffect, useMemo, useState } from 'react';
import { Bot, Check, Copy, Download, ExternalLink, Package, Rocket, ShieldCheck } from 'lucide-react';

import {
  AgentAccessMap,
  defaultMissionForMap,
  type AgentAccessMapSelection,
} from '@/components/AgentAccessMap';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import {
  buildCdsAgentPrompt,
  chooseAgentProjectId,
  createAgentMissionContext,
  getAgentMissionScope,
  PROJECT_SKILL_PATHS,
  resolveAgentMissionContextForTarget,
  type AgentPageContext,
  type AgentPageContextId,
  type CdsConnectTarget,
} from '@/lib/agent-onboarding';

const MARKETPLACE_URL = 'https://miduo.org/marketplace?type=skill&keyword=cds';

export interface AgentProjectOption {
  id: string;
  name: string;
  slug: string;
  branchCount?: number;
  runningBranchCount?: number;
  runningServiceCount?: number;
}

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projects: AgentProjectOption[];
  context?: AgentPageContext;
}

type TabKey = 'init' | 'connect' | 'manual' | 'marketplace';

// 「项目初始化」排在第一位：从零建项目是新用户最常见的入口，
// 藏在第四个 tab 等于没有。详见 doc/design.cds.project-bootstrap.md。
const TABS: Array<{ key: TabKey; label: string; icon: typeof Bot; recommended?: boolean }> = [
  { key: 'init', label: '项目初始化', icon: Rocket, recommended: true },
  { key: 'connect', label: '自动接入', icon: Bot },
  { key: 'manual', label: '手动安装', icon: Package },
  { key: 'marketplace', label: '海鲜市场', icon: ExternalLink },
];

function initialMapSelection(
  projects: AgentProjectOption[],
  context: AgentPageContext,
): AgentAccessMapSelection {
  if (getAgentMissionScope(context.id) === 'system') return { kind: 'system' };
  const selectedProjectId = chooseAgentProjectId(projects, context);
  return selectedProjectId
    ? { kind: 'project', projectId: selectedProjectId }
    : { kind: 'new' };
}

export function SkillDownloadDialog({ open, onOpenChange, projects, context }: Props): JSX.Element {
  const [active, setActive] = useState<TabKey>('init');
  const sourceContext = context || createAgentMissionContext('projects');
  const [mapSelection, setMapSelection] = useState<AgentAccessMapSelection>(
    () => initialMapSelection(projects, sourceContext),
  );
  const [missionId, setMissionId] = useState<AgentPageContextId>(sourceContext.id);

  useEffect(() => {
    if (!open) return;
    setMapSelection(initialMapSelection(projects, sourceContext));
    setMissionId(sourceContext.id);
  }, [open, projects, context?.id, context?.pagePath]);

  const systemProjectId = chooseAgentProjectId(
    projects,
    createAgentMissionContext('auth'),
  );
  const effectiveProjectId = mapSelection.kind === 'system'
    ? systemProjectId
    : mapSelection.kind === 'project'
      ? mapSelection.projectId
      : '';
  const selectedContext = resolveAgentMissionContextForTarget(
    missionId,
    sourceContext,
    projects,
    effectiveProjectId,
  );
  const cdsOrigin = typeof window !== 'undefined' ? window.location.origin : 'https://<your-cds-host>';
  const target: CdsConnectTarget = mapSelection.kind === 'new'
    ? { kind: 'new' }
    : effectiveProjectId
      ? { kind: 'existing', projectId: effectiveProjectId }
      : { kind: 'system' };
  const targetKind = target.kind;
  const prompt = useMemo(
    () => buildCdsAgentPrompt({ cdsOrigin, target, context: selectedContext }),
    [cdsOrigin, target.kind, effectiveProjectId, selectedContext.id, selectedContext.pagePath],
  );
  const handleMapSelection = (selection: AgentAccessMapSelection): void => {
    setMapSelection(selection);
    const selectedScope = getAgentMissionScope(missionId);
    const nextScope = selection.kind === 'system' ? 'system' : selection.kind === 'project' ? 'project' : 'system';
    if (selection.kind === 'new' || selectedScope !== nextScope) {
      setMissionId(defaultMissionForMap(selection));
    }
  };
  const chooseExistingTarget = (): void => {
    const projectId = effectiveProjectId || projects[0]?.id;
    if (!projectId) return;
    handleMapSelection({ kind: 'project', projectId });
  };
  const chooseProject = (projectId: string): void => {
    handleMapSelection({ kind: 'project', projectId });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="max-w-none"
        style={{ width: 'min(1080px, calc(100vw - 32px))' }}
      >
        <DialogHeader>
          <DialogTitle>接入 Agent</DialogTitle>
          <DialogDescription>
            选择项目和任务后，Agent 会获得可执行步骤、安全边界与完成标准。
            已有项目权限会静默复用，只有缺少权限或明确提权时才需要批准。
          </DialogDescription>
        </DialogHeader>

        <AgentAccessMap
          projects={projects}
          selection={mapSelection}
          context={selectedContext}
          sourceContextId={sourceContext.id}
          onSelectionChange={handleMapSelection}
          onMissionChange={setMissionId}
        />

        <div className="grid gap-2 sm:grid-cols-2">
          <button
            type="button"
            onClick={chooseExistingTarget}
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
            onClick={() => handleMapSelection({ kind: 'new' })}
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
              value={effectiveProjectId}
              onChange={(event) => chooseProject(event.target.value)}
              className="h-9 w-full rounded-md border border-[hsl(var(--hairline))] bg-[hsl(var(--surface-base))] px-3 text-sm text-foreground"
            >
              {projects.map((project) => (
                <option key={project.id} value={project.id}>{project.name} ({project.slug})</option>
              ))}
            </select>
          </label>
        ) : null}

        <nav className="grid grid-cols-4 gap-1 border-b border-[hsl(var(--hairline))]">
          {TABS.map((tab) => {
            const Icon = tab.icon;
            const selected = active === tab.key;
            return (
              <button
                key={tab.key}
                type="button"
                onClick={() => setActive(tab.key)}
                className={`relative inline-flex h-10 min-w-0 items-center justify-center gap-1 px-1 text-sm transition-colors sm:gap-2 sm:px-3 ${
                  selected ? 'text-foreground' : 'text-muted-foreground hover:text-foreground'
                }`}
              >
                <Icon className="hidden h-4 w-4 sm:block" />
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
          {active === 'init' ? <ProjectInitTab /> : null}
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
        <span>口令不含密钥。Agent 会先静默检查当前项目权限；检查通过就直接工作，缺少权限才会在 CDS 右下角申请批准。</span>
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
      <p>技能包采用通用的 SKILL.md 结构。下载后把 skills/ 下的五个目录复制到当前项目对应的技能目录。</p>
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

interface BootstrapPresetView {
  key: string;
  label: string;
  audience: string;
  summary: string;
  marketplaceKeys: string[];
  includeCdsSkills: boolean;
  nextStep: string;
}

/**
 * 项目初始化：给对方「一条命令 + 一句话」，而不是一段让 AI 自己想办法的提示词。
 *
 * 默认展示两步版本（先下载、可阅读、再执行）——管道执行有供应链风险，
 * 给非技术用户的默认必须是安全的那个。详见 doc/design.cds.project-bootstrap.md。
 */
function ProjectInitTab(): JSX.Element {
  const [presets, setPresets] = useState<BootstrapPresetView[]>([]);
  const [selected, setSelected] = useState<string>('');
  const [loadError, setLoadError] = useState<string>('');
  const [showPipe, setShowPipe] = useState(false);
  const [copied, setCopied] = useState<string>('');

  useEffect(() => {
    let alive = true;
    fetch('/api/bootstrap/presets')
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((data: { presets?: BootstrapPresetView[] }) => {
        if (!alive) return;
        const list = data.presets || [];
        setPresets(list);
        setSelected((prev) => prev || list[0]?.key || '');
      })
      .catch(() => { if (alive) setLoadError('预设清单暂时读不到，请稍后重试。'); });
    return () => { alive = false; };
  }, []);

  const origin = typeof window === 'undefined' ? '' : window.location.origin;
  const active = presets.find((p) => p.key === selected);
  const scriptUrl = active ? `${origin}/api/bootstrap/${active.key}` : '';
  const twoStep = active
    ? `curl -fsSL -o cds-init.sh "${scriptUrl}"\nless cds-init.sh   # 先看一眼再执行\nsh cds-init.sh`
    : '';
  const oneLine = active ? `curl -fsSL "${scriptUrl}" | sh` : '';

  const copy = async (text: string, tag: string): Promise<void> => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(tag);
      window.setTimeout(() => setCopied(''), 1800);
    } catch {
      setCopied('');
    }
  };

  if (loadError) {
    return <p className="text-sm text-muted-foreground">{loadError}</p>;
  }

  return (
    <div className="space-y-3">
      <div className="flex items-start gap-2 rounded-md border border-primary/30 bg-primary/5 px-3 py-2 text-xs text-muted-foreground">
        <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
        <span>
          在目标项目根目录执行。脚本只往当前项目写技能文件，不含密钥，也不会改你的终端配置或用户主目录。
        </span>
      </div>

      <div className="grid gap-2 sm:grid-cols-2">
        {presets.map((p) => {
          const on = p.key === selected;
          return (
            <button
              key={p.key}
              type="button"
              onClick={() => setSelected(p.key)}
              className={`rounded-md border p-3 text-left transition-colors ${
                on
                  ? 'border-primary/60 bg-primary/5'
                  : 'border-[hsl(var(--hairline))] bg-[hsl(var(--surface-base))] hover:border-primary/40'
              }`}
            >
              <div className="text-sm font-medium text-foreground">{p.label}</div>
              <div className="mt-0.5 text-xs text-muted-foreground">{p.audience}</div>
              <div className="mt-1.5 text-xs leading-relaxed text-muted-foreground">{p.summary}</div>
            </button>
          );
        })}
      </div>

      {active ? (
        <>
          <div className="space-y-1.5">
            <div className="text-xs font-medium text-foreground">第一步：在项目目录执行</div>
            <div className="cds-surface-raised cds-hairline relative rounded-md border border-[hsl(var(--hairline))] bg-[hsl(var(--surface-sunken))] p-3">
              <pre className="overflow-x-auto whitespace-pre pr-12 font-mono text-xs leading-relaxed text-foreground">
                {twoStep}
              </pre>
              <Button
                size="sm"
                variant="ghost"
                className="absolute right-2 top-2"
                onClick={() => void copy(twoStep, 'two')}
              >
                {copied === 'two' ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
              </Button>
            </div>
            <button
              type="button"
              className="text-xs text-muted-foreground underline-offset-2 hover:underline"
              onClick={() => setShowPipe((v) => !v)}
            >
              {showPipe ? '收起一行版' : '我信任来源，给我一行命令'}
            </button>
            {showPipe ? (
              <div className="cds-surface-raised cds-hairline relative rounded-md border border-[hsl(var(--hairline))] bg-[hsl(var(--surface-sunken))] p-3">
                <pre className="overflow-x-auto whitespace-pre pr-12 font-mono text-xs text-foreground">{oneLine}</pre>
                <Button
                  size="sm"
                  variant="ghost"
                  className="absolute right-2 top-2"
                  onClick={() => void copy(oneLine, 'one')}
                >
                  {copied === 'one' ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
                </Button>
              </div>
            ) : null}
          </div>

          <div className="space-y-1.5">
            <div className="text-xs font-medium text-foreground">第二步：打开 AI 编程工具，说这一句</div>
            <div className="cds-surface-raised cds-hairline relative rounded-md border border-[hsl(var(--hairline))] bg-[hsl(var(--surface-sunken))] p-3">
              <pre className="font-mono text-xs text-foreground">{active.nextStep}</pre>
              <Button
                size="sm"
                variant="ghost"
                className="absolute right-2 top-2"
                onClick={() => void copy(active.nextStep, 'next')}
              >
                {copied === 'next' ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
              </Button>
            </div>
          </div>

          <p className="text-xs text-muted-foreground">
            会装到当前项目的技能目录（自动识别 .claude / .cursor / .agents），跟着项目的版本库走，
            团队每个人拉下来都有。
            {active.includeCdsSkills ? ' 包含 CDS 的五个技能。' : ''}
            {active.marketplaceKeys.length > 0
              ? ` 方法论套装：${active.marketplaceKeys.join('、')}。`
              : ''}
          </p>
        </>
      ) : null}
    </div>
  );
}
