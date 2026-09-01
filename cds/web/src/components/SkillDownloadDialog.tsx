import { useEffect, useMemo, useState } from 'react';
import { Bot, Check, Copy, Download, ExternalLink, GraduationCap, Package, Rocket, ShieldCheck } from 'lucide-react';

import {
  AgentAccessMap,
  defaultMissionForMap,
  type AgentAccessMapSelection,
} from '@/components/AgentAccessMap';
import { AgentStarterTab } from '@/components/AgentStarterTab';
import { Button } from '@/components/ui/button';
import { AGENT_ROLE_PROFILES } from '@/lib/agent-starter';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import {
  buildCdsAgentPrompt,
  chooseAgentProjectId,
  createAgentMissionContext,
  getAgentMissionScope,
  PROJECT_SKILL_PATHS,
  resolveAgentConnectTarget,
  resolveAgentMissionContextForTarget,
  type AgentPageContext,
  type AgentPageContextId,
  type CdsConnectTarget,
} from '@/lib/agent-onboarding';

const MARKETPLACE_URL = String(import.meta.env.VITE_SKILL_MARKETPLACE_URL || '').trim();

export interface AgentProjectAgentProfile {
  role: string;
  experience: string;
  skills?: string[];
  cardTitle?: string;
  declaredAt?: string;
}

export interface AgentProjectOption {
  id: string;
  name: string;
  slug: string;
  branchCount?: number;
  runningBranchCount?: number;
  runningServiceCount?: number;
  /** 项目已声明的 Agent 角色。由 /api/projects 带出，仅作展示。 */
  agentProfile?: AgentProjectAgentProfile;
}

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projects: AgentProjectOption[];
  context?: AgentPageContext;
}

type TabKey = 'starter' | 'init' | 'connect' | 'manual' | 'marketplace';

// 「项目初始化」排在第一位：从零建项目是新用户最常见的入口，
// 藏在第四个 tab 等于没有。详见 doc/design.cds.project-bootstrap.md。
const TABS: Array<{ key: TabKey; label: string; icon: typeof Bot; recommended?: boolean }> = [
  { key: 'starter', label: '上手助手', icon: GraduationCap, recommended: true },
  { key: 'init', label: '快速初始化', icon: Rocket },
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
  const [active, setActive] = useState<TabKey>('starter');
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
  // 目标解析（含「上手助手不许落到 system」那条）收在 agent-onboarding 里，
  // 由 agent-onboarding.test.ts 直接断言行为，避免这段判断只能靠扫源码验证。
  const target: CdsConnectTarget = resolveAgentConnectTarget({
    tab: active,
    selection: mapSelection,
    effectiveProjectId,
  });
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

        {active === 'connect' ? <AgentAccessMap
          projects={projects}
          selection={mapSelection}
          context={selectedContext}
          sourceContextId={sourceContext.id}
          onSelectionChange={handleMapSelection}
          onMissionChange={setMissionId}
        /> : null}

        {/* 目标选择在「上手助手」上同样要给：口令里嵌的是新建项目还是已有项目，
            决定了 Agent 走不走一次性创建授权，用户必须看得见、改得动。 */}
        {active === 'connect' || active === 'starter' ? <div className="grid gap-2 sm:grid-cols-2">
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
        </div> : null}

        {(active === 'connect' || active === 'starter') && targetKind === 'existing' ? (
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

        <nav className="grid grid-cols-2 gap-1 border-b border-[hsl(var(--hairline))] sm:grid-cols-5">
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
          {/*
           * 上手助手切走时只藏不卸：卸载会把用户在向导里选的技能、交付方式连同
           * 所在步骤一起丢掉，回来直接退回步骤 01。而「去技能市场」这个入口正好
           * 开在完成页——那一屏的状态最贵，用户可能还没把结果抄走。
           * starter 本来就是默认 tab、进弹窗即挂载，藏起来不额外产生开销。
           */}
          <div className={active === 'starter' ? undefined : 'hidden'}>
            <AgentStarterTab
              cdsPrompt={prompt}
              projectId={targetKind === 'existing' ? effectiveProjectId : ''}
              onOpenMarketplace={() => setActive('marketplace')}
            />
          </div>
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

/**
 * 技能市场：在 CDS 内直接浏览可安装的技能。
 *
 * 为什么不能只给一个跳 MAP 的外链：客户接不进 MAP（那是内部平台），
 * 点过去撞登录墙。CDS 是中介，得自己把「有什么技能」摆出来 —— 数据走
 * 代理端点，内容事实源仍在 MAP，不产生第二份。
 */
function MarketplaceTab(): JSX.Element {
  const [bundles, setBundles] = useState<BundleView[]>([]);
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');

  useEffect(() => {
    let alive = true;
    fetch('/api/skills/bundles')
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((payload: unknown) => {
        if (!alive) return;
        setBundles(normalizeBundleViews(payload));
        setState('ready');
      })
      .catch(() => { if (alive) setState('error'); });
    return () => { alive = false; };
  }, []);

  if (state === 'loading') {
    return <p className="text-sm text-muted-foreground">正在读取技能清单…</p>;
  }
  if (state === 'error') {
    return (
      <div className="space-y-3 text-sm text-muted-foreground">
        <p>技能来源当前不可达，清单暂时列不出来。「项目初始化」里的安装命令仍可使用（会走本地缓存）。</p>
        {MARKETPLACE_URL ? (
          <Button asChild variant="outline">
            <a href={MARKETPLACE_URL} target="_blank" rel="noreferrer">
              <ExternalLink className="h-4 w-4" />
              在浏览器打开来源站点
            </a>
          </Button>
        ) : null}
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <p className="text-sm text-muted-foreground">
        按角色打包的技能套装。选好之后到「项目初始化」拿安装命令，不需要注册账号。
      </p>
      <div className="space-y-2">
        {bundles.map((b) => (
          <div key={b.key} className="rounded-md border border-[hsl(var(--hairline))] bg-[hsl(var(--surface-base))] p-3">
            <div className="flex items-baseline justify-between gap-2">
              <span className="text-sm font-medium text-foreground">{b.title}</span>
              <span className="shrink-0 text-xs text-muted-foreground">
                {b.roleLabels.join('、')} · {b.skillCount} 个技能
              </span>
            </div>
            <ul className="mt-2 space-y-1">
              {b.skills.map((sk) => (
                <li key={sk.key} className="text-xs leading-relaxed">
                  <code className="text-foreground">{sk.key}</code>
                  <span className="text-muted-foreground"> — {sk.description}</span>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    </div>
  );
}

interface BundleSkillView { key: string; title: string; description: string }
interface BundleView {
  key: string;
  title: string;
  roleLabels: string[];
  skillCount: number;
  skills: BundleSkillView[];
}

/**
 * 把 `/api/skills/bundles` 的响应读成界面要的形状。
 *
 * 两处调用方原先各写一份 `data?.data?.items`，而这个端点从来返回的是
 * `{ bundles: [{ key, label, skills: [{ key, name, description }] }] }`——
 * 于是两处都恒定拿到空数组：技能市场 tab 渲染出一片空白、项目初始化里的
 * 「这套装里有什么」永远列不出来，全程无报错。收成一个函数，别再有第二份。
 */
export function normalizeBundleViews(payload: unknown): BundleView[] {
  const value = payload as any;
  const bundles = value?.data?.bundles ?? value?.bundles;
  if (!Array.isArray(bundles)) return [];
  const roleLabel = (id: unknown): string =>
    AGENT_ROLE_PROFILES.find((profile) => profile.id === id)?.label ?? String(id ?? '');
  return bundles.flatMap((bundle: any) => {
    const key = typeof bundle?.key === 'string' ? bundle.key : '';
    if (!key) return [];
    const rawSkills = Array.isArray(bundle?.skills) ? bundle.skills : [];
    const skills: BundleSkillView[] = rawSkills.flatMap((skill: any) => {
      const skillKey = typeof skill === 'string' ? skill : skill?.key;
      if (typeof skillKey !== 'string' || !skillKey) return [];
      return [{
        key: skillKey,
        title: typeof skill?.name === 'string' ? skill.name : skillKey,
        description: typeof skill?.description === 'string' ? skill.description : '',
      }];
    });
    return [{
      key,
      title: typeof bundle?.label === 'string' ? bundle.label : key,
      roleLabels: (Array.isArray(bundle?.roles) ? bundle.roles : []).map(roleLabel).filter(Boolean),
      skillCount: skills.length,
      skills,
    }];
  });
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
  // 技能清单实时从代理端点拉：客户接不进 MAP，CDS 必须自己能把「这套装里有什么」
  // 摆出来，而不是只显示一个套装名让人猜。
  const [bundles, setBundles] = useState<BundleView[]>([]);
  const [showSkills, setShowSkills] = useState(false);
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
    fetch('/api/skills/bundles')
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((payload: unknown) => {
        if (alive) setBundles(normalizeBundleViews(payload));
      })
      // 技能清单拉不到不阻塞安装：命令照给，只是列不出明细
      .catch(() => { if (alive) setBundles([]); });
    return () => { alive = false; };
  }, []);

  const origin = typeof window === 'undefined' ? '' : window.location.origin;
  const active = presets.find((p) => p.key === selected);
  const scriptUrl = active ? `${origin}/api/bootstrap/${active.key}` : '';
  // 两处都必须让失败可见：
  // - 两步版用 && 串起来，下载失败就不会去执行上一次留下的旧 cds-init.sh
  // - 单行版不能用 `curl | sh`：管道的退出码取自 sh，而 sh 读到空输入会成功退出，
  //   curl 失败反而被报成「初始化成功」。改为先落盘再执行，退出码如实反映失败。
  const twoStep = active
    ? `curl -fsSL -o cds-init.sh "${scriptUrl}" \\\n  && less cds-init.sh \\\n  && sh cds-init.sh`
    : '';
  const oneLine = active
    ? `curl -fsSL -o cds-init.sh "${scriptUrl}" && sh cds-init.sh`
    : '';
  const activeSkills = active
    ? bundles.filter((b) => active.marketplaceKeys.includes(b.key)).flatMap((b) => b.skills)
    : [];

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

          {activeSkills.length > 0 ? (
            <div className="rounded-md border border-[hsl(var(--hairline))] bg-[hsl(var(--surface-base))]">
              <button
                type="button"
                onClick={() => setShowSkills((v) => !v)}
                className="flex w-full items-center justify-between px-3 py-2 text-left text-xs"
              >
                <span className="text-foreground">
                  这套会装 {activeSkills.length + (active.includeCdsSkills ? 5 : 0)} 个技能
                </span>
                <span className="text-muted-foreground">{showSkills ? '收起' : '看看都有什么'}</span>
              </button>
              {showSkills ? (
                <div className="max-h-56 overflow-y-auto border-t border-[hsl(var(--hairline))] px-3 py-2">
                  <ul className="space-y-1.5">
                    {activeSkills.map((sk) => (
                      <li key={sk.key} className="text-xs leading-relaxed">
                        <code className="text-foreground">{sk.key}</code>
                        <span className="text-muted-foreground"> — {sk.description}</span>
                      </li>
                    ))}
                    {active.includeCdsSkills ? (
                      <li className="text-xs text-muted-foreground">
                        另含 CDS 的五个技能：部署、扫描、排障、发布、预览地址
                      </li>
                    ) : null}
                  </ul>
                </div>
              ) : null}
            </div>
          ) : null}

          <p className="text-xs text-muted-foreground">
            会装到当前项目的技能目录（自动识别 .claude / .cursor / .agents），跟着项目的版本库走，
            团队每个人拉下来都有。
          </p>
        </>
      ) : null}
    </div>
  );
}
