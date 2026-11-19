import { ReleaseConsoleSkeleton, RELEASE_CONSOLE_LAYOUT_CLASS, RELEASE_CONSOLE_LEFT_CLASS, RELEASE_CONSOLE_CENTER_CLASS, RELEASE_CONSOLE_RIGHT_CLASS } from '@/components/skeletons/ReleaseConsoleSkeleton';
import { ContentLoading } from '@/components/skeletons/ContentLoading';
import { MotionLink as Link } from '@/components/layout/RouteMotion';
/**
 * 发布控制台（三栏版）—— 设计稿 cds/web/demo/release-console-rail.html 的真接口实现。
 *
 * 三栏边缘结构：左「项目 + 环境」、中「状态 + 流水线 + 实时输出」、右「历史 / 失败 / 配置 / Agent」。
 * 与设计稿的三处出入，都是为了不对后端撒谎：
 *
 * 1. **并发口径**。设计稿写「同一时间只允许一处发布」。后端真正保证的是**按目标互斥**
 *    （release-service 的 assertTargetFree，冲突返回 409）。这里如实说明：其他目标的发布
 *    按钮由前端额外收一道口，属于 UI 策略；服务端只保证同目标不并发。
 * 2. **高级设置**。设计稿画了 release.yml 表单编辑器，后端没有这个接口。这里改成只读展示
 *    目标真实的发布策略（strategy / 健康检查 / 回滚命令），改配置去发布中心的配置页签。
 * 3. **字体**。设计稿内嵌了 Noto Sans SC；那是全站决策（影响每一页、增体积），不在这一页
 *    偷偷引入，沿用应用现有字体栈。
 *
 * 数据全部来自既有接口，没有新增任何路由：
 *   GET  /api/projects                              项目列表
 *   GET  /api/releases/center?project=<id>          目标 / 记录 / 提交说明
 *   GET  /api/branches?project=<id>&live=false      可发布的分支
 *   POST /api/releases/branches/:branchId/preflight 检查选定的版本与目标
 *   POST /api/releases/branches/:branchId/runs      开始发布
 *   GET  /api/releases/runs/:id/stream              实时状态与输出（SSE）
 *   POST /api/releases/runs/:id/cancel              中止
 */

import { useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useSearchParams } from 'react-router-dom';
import { chooseReleaseWorkbenchBranch, releaseApprovalInboxPath, releaseApprovalPath, releaseWorkbenchCommit } from '@/lib/releaseApproval';
import {
  AlertTriangle, Ban, Boxes, CheckCircle2, CircleDashed, Clipboard, Clock, Gauge, Github, History, Loader2,
  PauseCircle, Play, Plug, RefreshCw, Rocket, RotateCcw, Search, XCircle, Zap,
  type LucideIcon,
} from 'lucide-react';
import { AppShell, Crumb, TopBar, Workspace, ConsoleAuthContext } from '@/components/layout/AppShell';
import { Button } from '@/components/ui/button';
import { Dialog, DialogBody, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { MotionLink } from '@/components/layout/RouteMotion';
import { useReleaseRequests } from '@/hooks/useReleaseRequests';
import { correlateRelease, releaseAccountIdentity, releaseFailureReason, type ReleaseRequest } from '@/lib/releaseRequest';
import { createLatestWinsGate } from '@/lib/latest-wins';
import { useNowTick } from '@/hooks/useNowTick';
import { ApiError, apiRequest, apiUrl, isChildPreviewCdsInstance } from '@/lib/api';
import { buildReleaseAgentTask } from '@/lib/releaseAgentTask';
import { detectStall, resolveStepDetails, type ConsolePlanLike } from '@/lib/releaseConsoleView';
import { buildEnvironmentSections, resolveSelectedTargetId } from '@/lib/releaseEnvironments';
import { collapseCheckMessage, resolveReleaseSourceUrls } from '@/lib/releaseDialogAddress';
import { diagnoseReleaseFailure } from '@/lib/releaseDiagnosis';
import { buildConsoleStance, isShownRunCurrent, planRollbackToVersion, sameCommit } from '@/lib/releaseConsoleState';
import { PROJECT_TAG_TONE_CLASS, projectTags, type ProjectTagKey } from '@/lib/projectTags';
import { releaseEtaText } from '@/lib/releaseEta';
import { releaseActorLabel } from '@/lib/releaseProvenance';
import { resolveReleaseSteps } from '@/lib/releaseSteps';
import { initialReleaseCenterProject, rememberReleaseCenterProject, resolveReleaseProject, resolveInitialReleaseProject } from '@/lib/releaseCenter';
import { BatchReleasePanel } from './release-center/BatchReleasePanel';
import { ReleaseLogDialog } from './release-center/dialogs';
import { Chip, formatClock, formatDateTime, formatDuration, runTone, statusLabel } from './release-center/shared';
// BranchOption 复用发布中心那一份：分支的展示名是 `branch` 不是 `name`，
// 自己再声明一个接口只会让 TS 对着一个不存在的字段点头（真实数据里下拉全是空的）。
import type { BranchOption, CenterResponse, CenterRow, ReleaseCommitMeta, ReleaseLogEntry, ReleasePreflightResult, ReleaseRun } from './release-center/types';
import { isReleaseFailed, isReleaseTerminal } from './release-center/types';

interface ProjectLite { id: string; name?: string; githubRepoFullName?: string }

type RailPane = 'history' | 'failed';
/** 配置与 Agent 走全屏浮层，不塞进 348px 的窄栏（demo 修掉的就是这条结构问题）。 */
type SheetKind = 'pipeline' | 'agent' | null;

/** SSE 的 data 是外部输入，解析失败就当没收到，不让一条坏事件打断整条流。 */
function parseSse<T>(event: MessageEvent): T | null {
  try { return JSON.parse(event.data) as T; } catch { return null; }
}

function dedupeLogs(logs: ReleaseLogEntry[]): ReleaseLogEntry[] {
  const seen = new Set<number>();
  const out: ReleaseLogEntry[] = [];
  for (const log of logs) {
    if (seen.has(log.seq)) continue;
    seen.add(log.seq);
    out.push(log);
  }
  return out.sort((a, b) => a.seq - b.seq);
}

/**
 * 全屏浮层。发布流水线和 Agent 任务文本都是「宽内容」——命令要横着读、
 * 任务文本要成段读，塞进 348px 的窄栏就是逼人在缝里看。
 * 复用共享 Dialog 的 Portal、焦点约束、关闭行为和可视区域尺寸，
 * 内部保留头/体/脚，长输出只在主体中滚动。
 */
function Sheet({ title, subtitle, onClose, foot, children }: {
  title: string;
  subtitle?: string;
  onClose: () => void;
  foot?: ReactNode;
  children: ReactNode;
}): JSX.Element {
  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent frame aria-describedby={undefined} className="cds-surface-raised cds-hairline max-w-3xl" style={{ width: 'calc(100% - 1rem)', height: 'min(82dvh, 45rem)' }}>
        <div className="flex shrink-0 items-start justify-between gap-3 border-b border-[hsl(var(--hairline))] px-4 py-3 pr-12">
          <div className="min-w-0">
            <DialogTitle className="break-words text-sm font-semibold">{title}</DialogTitle>
            {subtitle ? <p className="mt-0.5 truncate text-[0.7188rem] text-muted-foreground">{subtitle}</p> : null}
          </div>
        </div>
        {/* 窄屏整体竖滚；桌面也是这一块滚，头脚不动 */}
        <DialogBody className="p-0">
          {children}
        </DialogBody>
        {foot ? (
          <div className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-t border-[hsl(var(--hairline))] px-4 py-2.5">
            {foot}
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

/**
 * 分区标签。参考稿的 PIPELINE / LIVE OUTPUT / PROJECTS / ENVIRONMENTS 是同一种：
 * 11px 等宽 + 0.14em 字距 + 弱化色。抽出来是为了四处只有一份定义——
 * 之前四处各写各的，改一处漏三处。
 */
function SectionLabel({ children }: { children: ReactNode }): JSX.Element {
  return <span className="cds-ident text-[0.6875rem] uppercase tracking-[0.14em] text-muted-foreground">{children}</span>;
}

/**
 * 每枚标签配一个图标。写成 Record<ProjectTagKey, …> 而不是 Record<string, …>：
 * lib 里新增一枚标签、这里忘了配图标，`pnpm tsc` 当场红——否则只会在页面上
 * 静默渲染成一个空框，没人发现。
 */
const PROJECT_TAG_ICON: Record<ProjectTagKey, LucideIcon> = {
  paused: PauseCircle,
  'clone-error': AlertTriangle,
  cloning: Loader2,
  'shared-service': Boxes,
  manual: Plug,
  github: Github,
  'auto-deploy': Zap,
  running: Play,
  idle: CircleDashed,
};

/**
 * 紧挨着项目名的那排标记。
 *
 * 用户要的是「名字旁边一个 icon」，所以这里是**同一行**的图标条，不是名字底下
 * 另起一行文字标签。名字 truncate、标记 shrink-0：名字再长也不会把标记挤没，
 * 标记也不会把名字撑出卡片。
 *
 * 没有可说的就什么都不出——空占位比不画更糟。
 */
function ProjectTagMarks({ project }: { project: ProjectLite }): JSX.Element | null {
  const tags = projectTags(project);
  if (tags.length === 0) return null;
  return (
    <span className="flex shrink-0 items-center gap-1">
      {tags.map((tag) => {
        const Icon = PROJECT_TAG_ICON[tag.key];
        return (
          <span
            key={tag.key}
            title={tag.title}
            // aria-label 而不是只靠 title：读屏用户拿不到 title，图标对他们就是空的
            aria-label={tag.label}
            className={`inline-flex h-[1.0625rem] items-center gap-[3px] rounded-[0.3125rem] border px-[3px] ${PROJECT_TAG_TONE_CLASS[tag.tone]}`}
          >
            <Icon className={`h-[0.6875rem] w-[0.6875rem] ${tag.key === 'cloning' ? 'animate-spin' : ''}`} />
            {tag.short ? <span className="cds-ident text-[0.625rem] leading-none">{tag.short}</span> : null}
          </span>
        );
      })}
    </span>
  );
}

/**
 * 一行日志该用什么颜色。
 *
 * 参考稿的实时输出不是一片灰——命令行、成功行、错误行各有各的颜色，扫一眼就知道
 * 「跑到哪了、哪一步炸了」。判据只看真实内容，不猜：
 *   - level=error/warn 由后端给，直接用
 *   - `$ ` 开头是正在执行的命令（发布脚本原样回显），提亮成正文色
 *   - 勾号（U+2713）/ ok / 发布完成 / 已生效 这类收尾行给成功色
 * 都不命中就是普通输出，弱化色。
 */
export function logLineTone(level: string, message: string): 'error' | 'warn' | 'command' | 'ok' | 'plain' {
  if (level === 'error') return 'error';
  if (level === 'warn') return 'warn';
  const text = message.trimStart();
  if (text.startsWith('$ ') || text.startsWith('# ')) return 'command';
  if (/^[+]?(\u2713|OK\b|ok\b)/.test(text) || /(发布完成|健康检查通过|已生效)/.test(text)) return 'ok';
  return 'plain';
}

const LOG_TONE_CLASS: Record<ReturnType<typeof logLineTone>, string> = {
  error: 'text-bad',
  warn: 'text-warn',
  command: 'text-foreground',
  ok: 'text-ok',
  plain: 'text-muted-foreground',
};

/** A status code alone cannot prove that no run was created. */
export function isConfirmedReleaseRejection(error: unknown, requestId: string): boolean {
  if (!(error instanceof ApiError) || error.status !== 409 || !error.body || typeof error.body !== 'object') return false;
  const body = error.body as Record<string, unknown>;
  return body.releaseOutcome === 'not-started' && body.requestId === requestId;
}

export function ReleaseConsolePage(): JSX.Element {
  const { status, pending, retry } = useContext(ConsoleAuthContext);
  const account = releaseAccountIdentity(status);
  if (pending) return <AppShell><Workspace><ContentLoading label="确认发布操作身份" /></Workspace></AppShell>;
  if (!account) return <AppShell><Workspace><div role="alert" className="space-y-3 py-4"><p>尚未确认发布操作身份，未读取保留的请求，也未开放发布命令。</p><Button variant="outline" onClick={retry}>重新确认身份</Button></div></Workspace></AppShell>;
  return <ReleaseConsoleWorkspace key={account} account={account} />;
}

function ReleaseConsoleWorkspace({ account }: { account: string }): JSX.Element {
  const recovery = useReleaseRequests(account);
  const [commandError, setCommandError] = useState('');
  const centerGate = useRef(createLatestWinsGate());
  const branchesGate = useRef(createLatestWinsGate());
  const [branchesError, setBranchesError] = useState('');
  const [params, setParams] = useSearchParams();
  const [projects, setProjects] = useState<ProjectLite[]>([]);
  const [projectsLoaded, setProjectsLoaded] = useState(false);
  const [projectListAttempt, setProjectListAttempt] = useState(0);
  const [initialSettled, setInitialSettled] = useState(false);
  const [projectId, setProjectId] = useState(() => initialReleaseCenterProject(params, window.localStorage));
  const [unavailableProject, setUnavailableProject] = useState(false);
  const projectAvailable = projectsLoaded && Boolean(resolveReleaseProject(projectId, projects));
  const batchMode = params.get('mode') === 'batch' || (!params.get('mode') && !params.has('target') && !params.has('intent'));
  const [batchLog, setBatchLog] = useState<ReleaseRun | null>(null);
  const [search, setSearch] = useState('');
  const [center, setCenter] = useState<CenterResponse | null>(null);
  const [branches, setBranches] = useState<BranchOption[]>([]);
  const linkedApprovalBranch = useRef(params.get('branch') || '');
  const [branchId, setBranchId] = useState(linkedApprovalBranch.current);
  // 从发布中心跳过来时带着 target（与可选的 intent=rollback）——落地即选中那个目标，
  // 不让用户在左栏里再找一遍。intent 只影响首屏提示，不代替回滚本身的二次确认。
  const [targetId, setTargetId] = useState(params.get('target') || '');
  const [arrivedIntent, setArrivedIntent] = useState(params.get('intent') || '');
  const [pane, setPane] = useState<RailPane>('history');
  const [sheet, setSheet] = useState<SheetKind>(null);
  const [confirmation, setConfirmation] = useState<{ key: string; force: boolean } | null>(null);
  const [rowBusy, setRowBusy] = useState('');
  const [run, setRun] = useState<ReleaseRun | null>(null);
  /**
   * 正在查看的**历史记录**，与 `run` 严格分开。
   *
   * 两者都会占据主屏，但语义相反：`run` 是「本次会话真的发起过的发布」，历史条目
   * 只是「翻出来看看的旧记录」。原来点历史条目的「看日志」直接 setRun(item)，于是
   * 它被当成 sessionRun 递给 buildConsoleStance——标题从「上次发布成功」变成现在时
   * 的「发布成功」，「这不是本次操作」那句提醒消失，成功的旧记录还会说成「已切到
   * 这一版」，而线上跑的其实是另一版。
   */
  const [historyRun, setHistoryRun] = useState<ReleaseRun | null>(null);
  const historyRunRef = useRef(historyRun);
  historyRunRef.current = historyRun;
  const [logs, setLogs] = useState<ReleaseLogEntry[]>([]);
  const [preflightState, setPreflight] = useState<{ key: string; result: ReleasePreflightResult } | null>(null);
  const [forceReason, setForceReason] = useState('');
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  useEffect(() => {
    if (error || projectsLoaded && (!projectId || center)) setInitialSettled(true);
  }, [error, projectsLoaded, projectId, center]);
  const initialLoading = !initialSettled && !error;
  const [toast, setToast] = useState('');
  const [following, setFollowing] = useState(true);
  const logRef = useRef<HTMLDivElement>(null);

  const say = useCallback((message: string) => {
    setToast(message);
    window.setTimeout(() => setToast((current) => (current === message ? '' : current)), 2600);
  }, []);

  /* ── 载入 ─────────────────────────────────────────────── */
  useEffect(() => {
    let alive = true;
    apiRequest<{ projects?: ProjectLite[] }>('/api/projects')
      .then((res) => {
        if (!alive) return;
        const list = res.projects || [];
        setProjects(list);
        const resolved = resolveInitialReleaseProject(params, window.localStorage, list);
        if (resolved !== currentProject.current) selectProject(resolved);
        setUnavailableProject(list.length > 0 && !resolved);
      })
      .catch((err) => { if (alive) setError(err instanceof ApiError ? err.message : String(err)); })
      .finally(() => { if (alive) setProjectsLoaded(true); });
    return () => { alive = false; };
  }, [projectListAttempt]);

  /**
   * 「这份响应还属于当前项目吗」——**所有**带 project 的请求都必须过这一关。
   *
   * 从 A 切到 B 时，A 的响应晚一步回来照样会写进 state：控制台挂在 B 名下、列的
   * 却是 A 的环境或 A 的分支。之后的重试、回滚、取消、发布都按那份 A 的 id 发出去
   * ——不是显示错位，是对着另一个项目动手；分支列表错配还会被后端的项目一致性
   * 预检直接拒掉，发布卡死到手动刷新为止。
   *
   * 判据只留这一份、放在这里，是因为前两轮 review 各抓到一处漏网的项目级请求：
   * 一处一处补必然还会漏第三处。新增任何 `?project=` 请求都从这里取判据。
   */
  const currentProject = useRef(projectId);
  useEffect(() => { currentProject.current = projectId; centerGate.current.newSession(); branchesGate.current.newSession(); }, [projectId]);
  const isStaleProject = useCallback((p: string): boolean => currentProject.current !== p, []);
  const selectProject = (id: string): void => {
    if (commandLock.current) return;
    activeRunId.current = undefined;
    setUnavailableProject(false);
    currentProject.current = id;
    linkedApprovalBranch.current = '';
    setBranchId('');
    setProjectId(id); setCenter(null); setBranches([]); setRun(null); setHistoryRun(null); setLogs([]); setPreflight(null); setBatchLog(null); setTargetId(''); setConfirmation(null);
    setParams((current) => {
      const next = new URLSearchParams(current); next.set('project', id);
      for (const key of ['target', 'intent', 'batch', 'batchView', 'branch']) next.delete(key);
      return next;
    }, { replace: true });
  };
  const workspaceHref = (mode: string): string => {
    const next = new URLSearchParams({ project: projectId, mode });
    for (const key of ['batch', 'batchView']) { const value = params.get(key); if (value) next.set(key, value); }
    return `/release-console?${next.toString()}`;
  };

  const loadCenter = useCallback(async (): Promise<void> => {
    if (!projectAvailable) return;
    const forProject = projectId;
    const ticket = centerGate.current.begin();
    try {
      const res = await apiRequest<CenterResponse>(`/api/releases/center?project=${encodeURIComponent(projectId)}`);
      if (isStaleProject(forProject) || !centerGate.current.accept(ticket)) return;
      setCenter(res);
      const historyId = historyRunRef.current?.releaseId;
      const refreshedHistory = historyId && res.runs?.find(item => item.releaseId === historyId);
      if (refreshedHistory) { setHistoryRun(refreshedHistory); setLogs(dedupeLogs(refreshedHistory.logs || [])); }
      setError('');
      // 只在当前选中项消失时清空，让 resolveSelectedTargetId 去挑；这里别自己挑 rows[0]。
      // 从发布中心带过来的 target 也走这条：它在就保留，不在（换了项目）就让默认逻辑接管。
      setTargetId((current) => (res.rows.some((item) => item.target.id === current) ? current : ''));
    } catch (err) {
      if (isStaleProject(forProject) || !centerGate.current.accept(ticket)) return;
      setError(err instanceof ApiError ? err.message : String(err));
    }
  }, [projectId, projectAvailable, isStaleProject]);

  const refreshProjectData = (): void => {
    if (!projectAvailable) {
      setError('');
      setProjectsLoaded(false);
      setProjectListAttempt(value => value + 1);
      return;
    }
    void loadCenter();
    void loadBranches();
  };

  useEffect(() => { void loadCenter(); }, [loadCenter]);

  const loadBranches = useCallback(async (): Promise<void> => {
    if (!projectAvailable) return;
    const forProject = projectId, ticket = branchesGate.current.begin();
    try {
      const response = await apiRequest<{ branches: BranchOption[] }>(`/api/branches?project=${encodeURIComponent(projectId)}&live=false`);
      if (isStaleProject(forProject) || !branchesGate.current.accept(ticket)) return;
      const list = response.branches || [];
      setBranches(list); setBranchesError('');
      setBranchId(current => chooseReleaseWorkbenchBranch(list, current, linkedApprovalBranch.current));
    } catch (error) {
      if (isStaleProject(forProject) || !branchesGate.current.accept(ticket)) return;
      setBranchesError(`来源分支读取失败：${releaseFailureReason(error)}；请刷新后再发起新发布。`);
    }
  }, [projectId, projectAvailable, isStaleProject]);
  useEffect(() => { void loadBranches(); }, [loadBranches]);
  useEffect(() => {
    if (!projectAvailable) return;
    rememberReleaseCenterProject(projectId, window.localStorage);
    // URL 写入不是可排队的 React state；恢复任务刚提交的 mode/target 不能被旧 render 的 params 覆盖。
    const next = new URLSearchParams(window.location.search);
    if (next.get('project') === projectId) return;
    next.set('project', projectId);
    setParams(next, { replace: true });
  }, [projectId, projectAvailable, setParams]);

  /**
   * 选中的目标同步进 URL。发布中心跳过来带的是 `?target=`，这里把用户之后手动切换的
   * 结果也写回去——否则刷新一下就跳回默认目标，分享的链接也指不到同一个环境。
   */
  useEffect(() => {
    if (!targetId || batchMode) return;
    const next = new URLSearchParams(window.location.search);
    if (next.get('target') === targetId) return;
    next.set('target', targetId);
    setParams(next, { replace: true });
  }, [targetId, batchMode, setParams]);

  const activeRunId = useRef(run?.releaseId);
  activeRunId.current = run?.releaseId;

  /* ── 实时：订阅当前 run 的 SSE ─────────────────────────── */
  useEffect(() => {
    if (!run || isReleaseTerminal(run.status)) return undefined;
    const forRelease = run.releaseId, forProject = run.projectId;
    const accepts = (): boolean => activeRunId.current === forRelease && !isStaleProject(forProject);
    const source = new EventSource(
      apiUrl(`/api/releases/runs/${encodeURIComponent(run.releaseId)}/stream?afterSeq=${logs.at(-1)?.seq || 0}`),
    );
    source.addEventListener('snapshot', (event) => {
      const data = parseSse<{ run: ReleaseRun }>(event as MessageEvent);
      if (!data?.run || !accepts() || data.run.releaseId !== forRelease) return;
      setRun(data.run);
      setLogs(dedupeLogs(data.run.logs || []));
    });
    source.addEventListener('release.log', (event) => {
      const data = parseSse<{ log: ReleaseLogEntry }>(event as MessageEvent);
      if (!data?.log || !accepts()) return;
      setLogs((current) => dedupeLogs([...current, data.log]));
    });
    source.addEventListener('release.status', (event) => {
      const data = parseSse<{ run: ReleaseRun }>(event as MessageEvent);
      if (!data?.run || !accepts() || data.run.releaseId !== forRelease) return;
      setRun(data.run);
      // 终态才回源刷新：中间态每来一条就拉一次 center，等于把 SSE 的省流优势又还回去
      if (isReleaseTerminal(data.run.status)) void loadCenter();
    });
    return () => source.close();
    // logs 只用于首次 afterSeq，故意不进依赖：进了会每来一条日志就重连一次
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [run?.releaseId, run?.status, loadCenter]);

  useEffect(() => {
    if (following && logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [logs, following]);

  /* ── 派生 ─────────────────────────────────────────────── */
  const rows = center?.rows || [];
  /*
   * 环境分组走后端下发的 environments（buildEnvironmentSections 是既有 SSOT）。
   * 后端没下发时它退化成一个不分组的列表 —— 刻意不按 environment 字段自己分组，
   * 那等于把归一判据抄第二份，同一个目标会在两个页面落进不同的组。
   *
   * 设计稿画了「客户」分组，后端的 environment 枚举只有 production / staging / other
   * 三档，客户环境实际落在 other。造一个后端不存在的分组，用户按它筛出来永远是空的。
   */
  const envSections = useMemo(
    () => buildEnvironmentSections(center?.environments, rows),
    [center?.environments, rows],
  );
  /*
   * 选中哪个环境交给既有的 resolveSelectedTargetId：用户选过的还在就保留，
   * 否则回到第一个**启用中**的目标。用 rows[0] 会落到已停用的临时目标上——
   * 真实数据里第一行正好是「MAP 正式环境 LLMGW 临时目标已关闭」。
   */
  const row = useMemo(() => {
    const id = resolveSelectedTargetId(envSections, targetId);
    return rows.find((item) => item.target.id === id) || rows[0];
  }, [envSections, rows, targetId]);
  const commitMeta: Record<string, ReleaseCommitMeta> = center?.commitMeta || {};
  const runsOfProject = center?.runs || [];
  const failedRuns = runsOfProject.filter((item) => isReleaseFailed(item.status));

  // 正在跑的发布：优先本页发起的，其次 center 里任何一个非终态 run。
  const liveRun = useMemo(() => {
    if (run && !isReleaseTerminal(run.status)) return run;
    return runsOfProject.find((item) => !isReleaseTerminal(item.status));
  }, [run, runsOfProject]);
  const liveRow = liveRun ? rows.find((item) => item.target.id === liveRun.targetId) : undefined;
  const blockedByOther = Boolean(liveRun && row && liveRun.targetId !== row.target.id);
  const inFlight = Boolean(liveRun);
  useEffect(() => {
    if (!inFlight || run && !isReleaseTerminal(run.status)) return;
    const timer = window.setInterval(() => void loadCenter(), 5000);
    return () => window.clearInterval(timer);
  }, [inFlight, run?.releaseId, run?.status, loadCenter]);
  const nowMs = useNowTick(inFlight);

  const shown = run || historyRun || row?.latestRun;
  const shownLogs = (run || historyRun) ? logs : (shown?.logs || []);
  const progress = resolveReleaseSteps(shown);
  const failed = shown ? isReleaseFailed(shown.status) : false;
  const running = Boolean(shown && !isReleaseTerminal(shown.status));
  // 现在看的这条是不是环境当前那一版。判据在 lib/releaseConsoleState，页面只负责渲染。
  const shownIsCurrent = isShownRunCurrent({
    shownReleaseId: shown?.releaseId,
    sessionReleaseId: run?.releaseId,
    latestReleaseId: row?.latestRun?.releaseId,
  });
  const diagnosis = failed ? diagnoseReleaseFailure(shownLogs) : null;
  const branch = branches.find((item) => item.id === branchId);
  const commitSha = releaseWorkbenchCommit(branch);
  /*
   * 发布来源地址：只认后端下发的 previewUrl / previewUrls，取不到就是空串。
   * 空串不是「随便填填」——它会被发布前检查的「可发布产物」那一项拦下；
   * 而编一个域名出来会一路传成部署脚本里的 CDS_PREVIEW_URL，指向没有东西监听的地方。
   */
  const sourceUrls = resolveReleaseSourceUrls({ branch });
  const previewUrl = sourceUrls[0] || '';
  const preflightKey = JSON.stringify([projectId, row?.target.id, row?.target.updatedAt, branchId, commitSha, previewUrl]);
  const preflight = preflightState?.key === preflightKey ? preflightState.result : null;
  const preflightMatchesCommit = Boolean(commitSha && preflight?.artifact?.commitSha === commitSha);
  const previewOnly = isChildPreviewCdsInstance();
  const etaText = running ? releaseEtaText(shown?.startedAt, row?.releaseEstimate, nowMs) : '';

  /**
   * 本次运行依据的计划。优先按 run.progress.planId 精确命中；没有运行记录时
   * 退回按 targetType 匹配的第一份，并且只用于「看流水线」的只读展示——
   * 它不参与任何执行判断，猜错也只是展示了一份同类型的计划，不会发错东西。
   */
  const activePlan = useMemo(() => {
    const plans = center?.plans || [];
    const planId = shown?.progress?.planId;
    if (planId) return plans.find((item) => item.id === planId);
    return plans.find((item) => item.targetType === row?.target.type) || plans[0];
  }, [center?.plans, shown?.progress?.planId, row?.target.type]);

  /** 步骤的真实命令与耗时；planId 对不上就没有命令，不拿别的计划顶上。 */
  const stepDetails = useMemo(
    () => resolveStepDetails(shown, center?.plans as ConsolePlanLike[] | undefined),
    [shown, center?.plans],
  );

  /** 卡住判定：还在跑但久无输出。用户原话「点击之后就卡住没后续了」。 */
  const stall = detectStall({
    running,
    lastLogAt: shownLogs.at(-1)?.at,
    startedAt: shown?.startedAt,
    nowMs,
  });

  /*
   * 受保护环境 = 后端标了 canonical 的正式环境。发这种目标要先点一次确认。
   * 这是本页的 UI 策略，不是服务端约束 —— 界面上按这个口径说话。
   */
  const isProtected = Boolean(row?.target.isCanonical && row.target.environment === 'production');
  const pendingConfirmation = confirmation?.key === preflightKey ? confirmation : null;
  const awaitingConfirm = Boolean(pendingConfirmation);

  const filteredProjects = projects.filter((item) => {
    const q = search.trim().toLowerCase();
    if (!q) return true;
    return `${item.id} ${item.name || ''} ${item.githubRepoFullName || ''}`.toLowerCase().includes(q);
  });

  /* ── 动作 ─────────────────────────────────────────────── */
  const commandLock = useRef(false);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const selection = useRef('');
  selection.current = `${projectId}:${row?.target.id || ''}`;
  const commandPending = Boolean(busy || rowBusy);
  const targetRequest = recovery.requests.find(request => request.projectId === projectId && request.targetId === row?.target.id);
  const targetUnconfirmed = Boolean(row && recovery.hasUnconfirmed(projectId, row.target.id));
  const canPreflight = Boolean(row && branchId && !branchesError && !running && !blockedByOther && !commandPending && !targetUnconfirmed);
  const canStart = canPreflight && !previewOnly && preflightMatchesCommit && preflight?.ok === true;
  const canForce = canPreflight && !previewOnly && preflightMatchesCommit && preflight?.forceAvailable === true && Boolean(forceReason.trim());
  const [cancelUnknown, setCancelUnknown] = useState<ReleaseRun | null>(null);
  const adoptRun = (next: ReleaseRun): void => {
    setHistoryRun(null); setRun(next); setLogs(dedupeLogs(next.logs || []));
    setTargetId(next.targetId); setFollowing(true);
    setPreflight(null); setConfirmation(null);
  };
  const beginCommand = (target: string): string | null => {
    if (commandLock.current || recovery.hasUnconfirmed(projectId, target)) return null;
    commandLock.current = true;
    const scope = `${projectId}:${target}`;
    selection.current = scope;
    setTargetId(target);
    setCommandError('');
    return scope;
  };
  const stillHere = (scope: string): boolean => mounted.current && selection.current === scope;
  const finishCommand = (): void => { commandLock.current = false; if (mounted.current) { setBusy(''); setRowBusy(''); } };
  const makeRequest = (kind: ReleaseRequest['kind'], target: string, sourceBranch: string, sha: string, sourceReleaseId?: string, rollbackTargetReleaseId?: string): ReleaseRequest => ({
    requestId: crypto.randomUUID(), projectId, projectLabel: projects.find(item => item.id === projectId)?.name, targetId: target, targetLabel: rows.find(item => item.target.id === target)?.target.name, branchId: sourceBranch, branchLabel: branches.find(item => item.id === sourceBranch)?.branch,
    commitSha: sha, kind, sourceReleaseId, rollbackTargetReleaseId, requestedAt: new Date().toISOString(),
  });
  const submitRelease = async (request: ReleaseRequest, url: string, scope: string, body?: unknown): Promise<void> => {
    // 浏览器只保存原请求对象以便核对；该编号不提供服务端幂等保证。
    if (!stillHere(scope) || !recovery.remember(request)) return;
    try {
      const response = await apiRequest<{ run: ReleaseRun }>(url, { method: 'POST', body, headers: { 'X-CDS-Request-Id': request.requestId } });
      const result = correlateRelease(request, response.run ? [response.run] : []);
      if (result.kind !== 'found') throw new Error('返回记录无法与本次请求的对象和版本对应');
      recovery.forget(request.requestId);
      if (stillHere(scope)) { adoptRun(result.run); void loadCenter(); }
    } catch (error) {
      if (isConfirmedReleaseRejection(error, request.requestId)) {
        if (recovery.forget(request.requestId) && stillHere(scope)) setCommandError(`发布请求被拒绝，未创建任务：${releaseFailureReason(error)}。请核对后重新选择版本或目标。`);
        return;
      }
      if (mounted.current) recovery.noteUnknown(request.requestId, error);
      if (mounted.current) await recovery.verify(request);
    }
  };
  const runPreflight = async (): Promise<void> => {
    if (!row || !canPreflight) return;
    const target = row.target.id;
    const scope = beginCommand(target); if (!scope) return;
    setBusy('preflight'); setPreflight(null); setConfirmation(null); setForceReason('');
    try {
      const result = await apiRequest<ReleasePreflightResult>(`/api/releases/branches/${encodeURIComponent(branchId)}/preflight`, { method: 'POST', body: { targetId: target, previewUrl } });
      if (!stillHere(scope)) return;
      setPreflight({ key: preflightKey, result });
      if (commitSha && result.artifact?.commitSha && result.artifact.commitSha !== commitSha) {
        setCommandError('检查到的版本已变化。请刷新分支，确认版本后重新检查。');
      }
    } catch (error) {
      if (stillHere(scope)) setCommandError(`发布前检查未完成，尚未发送发布命令。请重试检查。${releaseFailureReason(error)}`);
    } finally { finishCommand(); }
  };
  const startRelease = async (force: boolean): Promise<void> => {
    if (!row || !preflight || !(force ? canForce : canStart)) return;
    const target = row.target.id;
    const scope = beginCommand(target); if (!scope) return;
    setBusy('deploy'); setConfirmation(null);
    try {
      await submitRelease(makeRequest('deploy', target, branchId, commitSha), `/api/releases/branches/${encodeURIComponent(branchId)}/runs`, scope, {
        targetId: target, previewUrl, expectedCommitSha: commitSha, preflightId: preflight.preflightId,
        ...(force ? { forceReason: forceReason.trim() } : {}),
      });
    } finally { finishCommand(); }
  };
  const requestRelease = (force: boolean): void => {
    if ((isProtected || force) && pendingConfirmation?.force !== force) {
      setConfirmation({ key: preflightKey, force });
      return;
    }
    void startRelease(force);
  };
  const verifyCancellation = async (original: ReleaseRun): Promise<void> => {
    try {
      const response = await apiRequest<{ run: ReleaseRun }>(`/api/releases/runs/${encodeURIComponent(original.releaseId)}`);
      if (response.run?.releaseId !== original.releaseId || response.run.projectId !== original.projectId || response.run.targetId !== original.targetId) throw new Error('记录对象不一致');
      if (!mounted.current) return;
      if (isReleaseTerminal(response.run.status)) setCancelUnknown(null);
      if (selection.current === `${original.projectId}:${original.targetId}`) adoptRun(response.run);
    } catch (error) { if (mounted.current) setCommandError(`取消结果仍无法确认：${releaseFailureReason(error)}。请查看原任务记录。`); }
  };
  const cancelRun = async (): Promise<void> => {
    if (!shown || commandLock.current || cancelUnknown?.releaseId === shown.releaseId) return;
    const original = shown, scope = beginCommand(original.targetId); if (!scope) return;
    setBusy('cancel');
    // 同一任务确认终态前不再次取消；只读核对不会重发命令。
    setCancelUnknown(original);
    try { await apiRequest(`/api/releases/runs/${encodeURIComponent(original.releaseId)}/cancel`, { method: 'POST' }); }
    catch (error) { if (stillHere(scope)) setCommandError(`取消命令结果尚未确认：${releaseFailureReason(error)}。请核对原任务状态。`); }
    finally { await verifyCancellation(original); finishCommand(); }
  };
  const retryRun = async (item: ReleaseRun): Promise<void> => {
    if (!item.commitSha?.trim()) { setCommandError('这条记录没有可确认的来源版本，不能重发。请重新选择明确的分支版本。'); return; }
    const scope = beginCommand(item.targetId); if (!scope) return;
    setRowBusy(item.releaseId);
    try { await submitRelease(makeRequest('retry', item.targetId, item.branchId, item.commitSha, item.releaseId), `/api/releases/runs/${encodeURIComponent(item.releaseId)}/retry`, scope); }
    finally { finishCommand(); }
  };
  const rollbackToVersion = async (item: ReleaseRun, itemRow?: CenterRow): Promise<void> => {
    const plan = planRollbackToVersion({ targetReleaseId: item.releaseId, currentReleaseId: itemRow?.currentVersion, latestReleaseId: itemRow?.latestRun?.releaseId });
    if ('error' in plan) { setCommandError(plan.error); return; }
    if (!item.commitSha?.trim()) { setCommandError('此历史版本来源未确认，不能回滚；请核对原记录。'); return; }
    const scope = beginCommand(item.targetId); if (!scope) return;
    setRowBusy(item.releaseId);
    try { await submitRelease(makeRequest('rollback', item.targetId, item.branchId, item.commitSha, plan.from, plan.targetReleaseId), `/api/releases/runs/${encodeURIComponent(plan.from)}/rollback`, scope, { targetReleaseId: plan.targetReleaseId }); }
    finally { finishCommand(); }
  };
  const rollbackRun = async (item: ReleaseRun): Promise<void> => {
    const targetReleaseId = rows.find(candidate => candidate.target.id === item.targetId)?.rollbackDefaultReleaseId || item.previousReleaseId;
    if (!targetReleaseId) { setCommandError('尚未确认上一个可回滚版本，请从历史记录选择明确的版本。'); return; }
    const scope = beginCommand(item.targetId); if (!scope) return;
    setRowBusy(item.releaseId);
    try {
      const response = await apiRequest<{ run: ReleaseRun }>(`/api/releases/runs/${encodeURIComponent(targetReleaseId)}`);
      if (!stillHere(scope)) return;
      const previous = response.run;
      if (!previous?.commitSha?.trim() || previous.projectId !== item.projectId || previous.targetId !== item.targetId) throw new Error('上一个版本的对象或来源无法确认');
      await submitRelease(makeRequest('rollback', item.targetId, previous.branchId, previous.commitSha, item.releaseId, previous.releaseId), `/api/releases/runs/${encodeURIComponent(item.releaseId)}/rollback`, scope, { targetReleaseId: previous.releaseId });
    } catch (error) { if (stillHere(scope)) setCommandError(`回滚前读取目标版本失败，尚未发送回滚命令：${releaseFailureReason(error)}`); }
    finally { finishCommand(); }
  };
  const followRecoveredRun = (request: ReleaseRequest, result: ReleaseRun): void => {
    if (commandLock.current || !recovery.forget(request.requestId)) return;
    currentProject.current = request.projectId;
    activeRunId.current = undefined;
    if (projectId !== request.projectId) { setCenter(null); setBranches([]); }
    setProjectId(request.projectId); setBranchId(request.branchId);
    setTargetId(request.targetId); setBatchLog(null); setConfirmation(null);
    setParams(current => {
      const next = new URLSearchParams(current);
      next.set('project', request.projectId); next.set('target', request.targetId); next.set('mode', 'single');
      for (const key of ['batch', 'batchView', 'intent']) next.delete(key);
      return next;
    }, { replace: true });
    setCommandError(''); adoptRun(result);
  };

  /**
   * 交给 Agent 的任务文本。全部转述 buildReleaseAgentTask（它只转述 releaseDiagnosis
   * 从真实日志提取的内容），这一页不另起一套措辞——两份文案迟早会漂移成两种结论。
   */
  const agentTask = (): string => {
    if (!shown || !row) return '';
    return buildReleaseAgentTask({
      run: shown,
      target: { name: row.target.name, host: row.target.ssh?.host },
      currentCommit: row.currentCommit || '',
      logs: shownLogs,
      failed: isReleaseFailed(shown.status),
      formatDateTime,
      formatDuration,
    });
  };

  const copyLogs = async (): Promise<void> => {
    if (shownLogs.length === 0) { say('还没有输出'); return; }
    // 复制的是「时间 + 原文」，与屏幕上看到的一致——不带 level 前缀，
    // 那是渲染时的着色依据，不是日志内容。
    const text = shownLogs.map((log) => `${formatClock(log.at)} ${log.message}`).join('\n');
    try {
      await navigator.clipboard.writeText(text);
      say(`已复制 ${shownLogs.length} 行`);
    } catch {
      say('浏览器拦截了复制，请手动选中日志');
    }
  };

  const copyAgentTask = async (): Promise<void> => {
    const text = agentTask();
    if (!text) { say('当前没有可整理的现场'); return; }
    try {
      await navigator.clipboard.writeText(text);
      say('已复制，粘给智能体即可');
    } catch {
      say('浏览器拦截了复制，请手动选中下方文本');
    }
  };

  /* ── 渲染 ─────────────────────────────────────────────── */
  /*
   * 「我现在在哪」。从发布中心跳过来、本次什么都没做时，`shown` 退回该环境的
   * 上一次历史发布，于是标题「发布成功」+ 满格绿进度条 + 打勾的步骤，整屏都在说
   * 「你刚成功发布了一版」——用户的原话是「很有心智负担」。判定收在
   * lib/releaseConsoleState.ts，页面只负责渲染。
   */
  const stance = buildConsoleStance({
    sessionRun: run,
    latestRun: historyRun ?? row?.latestRun ?? null,
    liveCommit: row?.currentCommit || '',
    selectedCommit: commitSha,
    running,
    failed,
  });
  const projectUnconfirmed = recovery.requests.some(request => request.projectId === projectId) || cancelUnknown?.projectId === projectId;
  const statusTitle = targetUnconfirmed ? '本次结果待确认' : stance.title;

  const tone = targetUnconfirmed ? 'warn' : !shown ? 'muted' : running ? 'warn' : failed ? 'bad' : 'ok';
  const toneRing = tone === 'bad'
    ? 'border-bad/30 bg-bad-soft'
    : tone === 'ok'
      ? 'border-ok/30 bg-ok-soft'
      : tone === 'warn'
        ? 'border-primary/30 bg-primary/[0.06]'
        : 'border-[hsl(var(--hairline))]';

  return (
    <AppShell
      active="release-center"
      wide
      topbar={(
        <TopBar
          left={<div className="flex min-w-0 flex-wrap items-center gap-3">
            <Crumb items={[{ label: 'CDS', href: '/project-list' }, { label: '发布工作台' }]} />
            <label className="flex min-w-0 items-center gap-2 text-sm text-muted-foreground">当前项目
              <select aria-label="当前项目" disabled={commandPending} value={projectAvailable ? projectId : ''} className="h-9 min-w-0 max-w-[22rem] rounded-md border border-input bg-background px-3 text-sm text-foreground" onChange={(event) => selectProject(event.target.value)}><option value="" disabled>请选择当前实例中的项目</option>{projects.map((project) => <option key={project.id} value={project.id}>{project.name || project.id}</option>)}</select>
            </label>
          </div>}
          right={(
            <>
              {!batchMode ? <span className="hidden items-center gap-2 rounded-full border border-[hsl(var(--hairline))] px-2.5 py-1 text-xs text-muted-foreground md:inline-flex">
                <span className={`h-1.5 w-1.5 rounded-full ${projectUnconfirmed ? 'bg-warn' : inFlight ? 'bg-primary' : 'bg-muted-foreground/60'}`} />
                {projectUnconfirmed
                  ? inFlight && liveRow ? `已知运行 · ${liveRow.target.name}；另有请求待核对` : '当前项目有发布请求待核对'
                  : inFlight && liveRow ? `发布中 · ${liveRow.target.name}` : '当前项目暂无进行中记录'}
              </span> : null}
              {projectAvailable ? <Button variant="outline" size="sm" asChild><Link to={`/release-center?${new URLSearchParams({ project: projectId, ...(!batchMode && row ? { target: row.target.id } : {}) })}`}>环境管理</Link></Button> : <Button variant="outline" size="sm" disabled>环境管理</Button>}
              <Button variant="outline" size="sm" onClick={refreshProjectData} disabled={!projectsLoaded}>
                <RefreshCw />
                刷新
              </Button>
            </>
          )}
        />
      )}
    >
      {/* --fill 给高度，--bleed 抵消 .cds-main 的内边距：参考稿的左右两栏是**贴边的
          整块面板**，靠一条 1px 边框分隔，不是浮在底色上、四周留缝的圆角卡。
          这一条是这一页与参考稿观感差最远的地方，先把它对上。 */}
      <Workspace fluid className="cds-workspace--fill cds-workspace--bleed flex flex-col">
        <nav aria-label="发布方式" className="flex shrink-0 flex-wrap gap-2 border-b border-[hsl(var(--hairline))] px-6 py-3">
          {[{ mode: 'batch', label: '批次发布' }, { mode: 'single', label: '逐目标发布' }].map((item) => <Link key={item.mode}
            to={workspaceHref(item.mode)}
            aria-disabled={commandPending || undefined}
            tabIndex={commandPending ? -1 : undefined}
            onClick={event => { if (commandLock.current) event.preventDefault(); }}
            aria-current={(item.mode === 'batch') === batchMode ? 'page' : undefined}
            className={`rounded-md px-4 py-2 text-sm font-medium ${(item.mode === 'batch') === batchMode ? 'bg-primary/10 text-primary' : 'text-muted-foreground hover:bg-muted'}`}>{item.label}</Link>)}
        </nav>
        {!batchMode && row?.target.governance?.required ? <div className="flex shrink-0 flex-wrap items-center justify-between gap-x-4 gap-y-2 border-b border-[hsl(var(--hairline))] px-4 py-2 text-sm sm:px-6">
          <p><strong>{row.target.name}</strong><span className="ml-2 text-muted-foreground">发布前需要有效审批。已有批准时，选择获批分支再执行。</span></p>
          <Button asChild variant="outline" size="sm"><Link to={releaseApprovalInboxPath(projectId, row.target.id)}>查看此环境审批</Link></Button>
        </div> : null}
        {previewOnly ? <p role="note" className="border-b border-warn/30 bg-warn-soft px-6 py-3 text-sm">当前是隔离预览，可以查看发布前检查。真实发布请在有发布数据与权限的 CDS 实例中操作。</p> : null}
        {commandError || recovery.error || branchesError ? <div role="alert" className="mx-3 mt-3 shrink-0 rounded-md border border-warn/30 bg-warn-soft px-3 py-2 text-sm text-warn">{commandError || recovery.error || branchesError}</div> : null}
        {cancelUnknown ? <div className="mx-3 mt-3 flex shrink-0 flex-wrap items-center gap-3 rounded-md border border-warn/30 bg-warn-soft px-3 py-2 text-sm"><span>正在核对 {cancelUnknown.releaseId} 的取消结果，确认终态前不会再次取消。</span><Button size="sm" variant="outline" onClick={() => void verifyCancellation(cancelUnknown)}>核对原任务</Button></div> : null}
        {recovery.requests.length ? <section aria-label="结果未确认的发布请求" className="mx-3 mt-3 shrink-0 space-y-3 rounded-md border border-warn/30 bg-warn-soft p-3">
          <h2 className="text-sm font-semibold">发布请求需要核对</h2>
          {recovery.requests.map(request => <div key={request.requestId} className="space-y-2 text-sm">
            <p className="break-all">{request.projectLabel || request.projectId} / {request.targetLabel || request.targetId} · {request.branchLabel || request.branchId} · {request.commitSha.slice(0, 8)}</p>
            <p>{recovery.messages[request.requestId] || '命令结果尚未确认。请保留编号；查不到记录也不能证明没有执行，请勿重复提交。'}</p>
            <details className="text-xs text-muted-foreground"><summary className="cursor-pointer">请求编号与原操作</summary><p className="mt-1 break-all">{request.commitSha} · {request.requestId} · {{ deploy: '发布', retry: '重发', rollback: '回滚' }[request.kind]} · {request.requestedAt}{request.sourceReleaseId ? ` · 来源记录 ${request.sourceReleaseId}` : ''}</p>{recovery.failureReasons[request.requestId] ? <p className="mt-1">命令响应：{recovery.failureReasons[request.requestId]}</p> : null}</details>
            <div className="flex flex-wrap gap-2"><Button size="sm" variant="outline" disabled={commandPending || recovery.checking[request.requestId]} onClick={() => void recovery.verify(request)}>{recovery.checking[request.requestId] ? '核对中' : '核对状态'}</Button>{recovery.found[request.requestId] ? <Button size="sm" disabled={commandPending} onClick={() => followRecoveredRun(request, recovery.found[request.requestId])}>查看本次结果</Button> : null}<MotionLink className="inline-flex min-h-9 items-center rounded-md px-2 underline" to={`/release-center?project=${encodeURIComponent(request.projectId)}&target=${encodeURIComponent(request.targetId)}`}>查看原目标记录</MotionLink></div>
          </div>)}
        </section> : null}

        <div className="min-h-0 flex-1">
        {/* 桌面三栏无间距（分隔线由各栏自己的 border 画），窄屏回落自然流。
            列宽照参考稿 288/380，但参考稿是在宽画布上量的（它自己写死 min-width:1228
            并让页面横滚，本仓库不允许——见 cds/.claude/rules/mobile-layout-fallback.md）。
            所以：xl 收成 240/300，wide(1440) 回到 264/340，2xl 才是参考值 288/380。 */}
        {initialLoading ? <ReleaseConsoleSkeleton navigation={false} /> : !projectAvailable ? <div role="alert" className="m-6 rounded-md border border-warn/30 bg-warn-soft p-5 text-sm">{unavailableProject ? '当前链接或上次选择的项目不在此实例中，请从上方重新选择项目。' : error || '当前实例还没有可用项目，请先创建项目。'}</div> : batchMode ? <div className="h-full min-w-0 overflow-y-auto p-4 md:p-6">
          {error ? <div role="alert" className="mb-4 rounded-md border border-bad/30 bg-bad-soft p-4 text-sm text-bad">{error}<Button variant="outline" size="sm" onClick={refreshProjectData} disabled={!projectsLoaded}>重试读取项目</Button></div> : null}
          {center ? <BatchReleasePanel key={projectId} projectId={projectId} targets={center.rows.map((item) => item.target)} currentRows={center.rows} onOpenLogs={setBatchLog} isTargetUnconfirmed={target => recovery.hasUnconfirmed(projectId, target)} /> : !error ? <ContentLoading label="读取当前项目发布目标" /> : null}
        </div> : <div
          className={RELEASE_CONSOLE_LAYOUT_CLASS}
        >
          {/* ══ 左栏：项目 + 环境 ══ */}
          {/* 窄屏把顺序翻过来：用户来这一页第一眼要看的是「现在成没成」，
              不是项目列表。桌面三栏不受影响（order 只在 max-lg 生效）。 */}
          <aside className={RELEASE_CONSOLE_LEFT_CLASS}>
            <div className="shrink-0 px-4 pb-2.5 pt-4">
              <div className="mb-2.5 flex items-center justify-between">
                <SectionLabel>PROJECTS</SectionLabel>
                <span className="cds-ident text-[0.6875rem] text-muted-foreground">{projects.length} 个</span>
              </div>
              <div className="relative">
                <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
                <input
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                  placeholder="搜索项目 / 仓库名"
                  className="h-8 w-full rounded-md border border-[hsl(var(--hairline))] bg-[hsl(var(--surface-sunken))] pl-8 pr-2 text-xs outline-none focus:border-[hsl(var(--hairline-strong))]"
                />
              </div>
            </div>

            {/* 参考稿：项目列表 flex:1 吃掉中间所有高度，环境块 border-top 钉在底部。
                之前让列表按内容收高、环境紧随其后，空白就全落在最下面——那才是洞。 */}
            <div className="min-h-0 flex-1 overflow-y-auto px-2.5 pb-3 max-xl:max-h-[38vh]">
              {!projectsLoaded && !error ? <ContentLoading label="读取发布项目列表" /> : filteredProjects.length === 0 ? (
                <p className="p-3 text-xs text-muted-foreground">没有匹配的项目。</p>
              ) : filteredProjects.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  aria-pressed={item.id === projectId}
                  disabled={commandPending}
                  onClick={() => selectProject(item.id)}
                  className={`mb-1 flex w-full flex-col gap-1 rounded-[0.5625rem] border px-3 py-2.5 text-left transition-colors ${
                    item.id === projectId
                      ? 'border-primary/40 bg-primary/[0.08]'
                      : 'border-transparent hover:border-[hsl(var(--hairline-strong))] hover:bg-[hsl(var(--surface-sunken))]/60'
                  }`}
                >
                  {/* 名字那一行右边挂标记：标记全部从真实字段推出来（见 lib/projectTags.ts），
                      零维护。作用是让这一栏一眼读成「这是一个项目，它现在什么状态」，
                      而不是一串看不出是什么的名字。 */}
                  {/* 标记紧跟名字，不靠右对齐：贴着名字才读得出「这是这个项目的标签」，
                      甩到卡片最右边就变成另一列状态了。名字 min-w-0 truncate 负责让长名字
                      自己截断，标记 shrink-0 永远贴在它后面。 */}
                  <span className="flex w-full min-w-0 items-center gap-1.5">
                    <span className={`min-w-0 truncate text-[0.8125rem] font-medium ${item.id === projectId ? 'text-primary' : ''}`}>
                      {item.name || item.id}
                    </span>
                    <ProjectTagMarks project={item} />
                  </span>
                  <span className="truncate cds-ident text-xs text-muted-foreground">
                    {item.githubRepoFullName || item.id}
                  </span>
                </button>
              ))}
            </div>

            <div className="min-h-0 shrink-0 border-t border-[hsl(var(--hairline))] px-4 py-3.5">
              <div className="mb-2.5 flex items-center justify-between gap-2">
                <SectionLabel>ENVIRONMENTS</SectionLabel>
                <span className="cds-ident text-[0.6875rem] text-muted-foreground">{rows.length} 个</span>
              </div>
              {projectId && !center && !error ? <ContentLoading label="读取发布环境列表" /> : rows.length === 0 ? (
                <p className="text-xs text-muted-foreground">{projectUnconfirmed ? '暂未读到可选择的目标；已保留的请求仍需核对。' : '这个项目还没有发布目标，去发布中心添加环境。'}</p>
              ) : (
                <div className="flex max-h-[34vh] flex-col gap-2 overflow-y-auto xl:max-h-[38vh]">
                  {envSections.map((section) => (
                    <div key={section.environment} className="flex flex-col gap-1.5">
                      {/* 后端没下发分组时 buildEnvironmentSections 退化成单组，此时不画组标题 */}
                      {section.degraded ? null : (
                        <span className="px-0.5 text-[0.7188rem] text-muted-foreground">{section.label}</span>
                      )}
                      {[...section.entries, ...section.disabledEntries].map((entry) => {
                        const item = entry.row;
                        const behind = item.commitPosition?.behindCount;
                        const selected = item.target.id === row?.target.id;
                        return (
                          <button
                            key={item.target.id}
                            type="button"
                            aria-pressed={selected}
                            disabled={commandPending}
                            onClick={() => {
                              if (commandLock.current) return;
                              activeRunId.current = undefined;
                              setTargetId(item.target.id);
                              setRun(null); setHistoryRun(null); setLogs([]); setPreflight(null); setConfirmation(null);
                            }}
                            className={`flex items-center gap-2.5 rounded-[0.5625rem] border px-2.5 py-2 text-left transition-colors duration-150 ${
                              selected
                                ? 'border-primary/40 bg-primary/[0.08]'
                                : 'border-[hsl(var(--hairline))] bg-[hsl(var(--surface-sunken))]/50 hover:border-[hsl(var(--hairline-strong))]'
                            } ${item.target.isEnabled ? '' : 'opacity-60'}`}
                          >
                            <span
                              className={`h-1.5 w-1.5 shrink-0 rounded-full ${
                                recovery.hasUnconfirmed(projectId, item.target.id) ? 'bg-warn' : item.healthStatus === 'healthy' ? 'bg-ok'
                                  : item.healthStatus === 'failed' ? 'bg-bad' : 'bg-muted-foreground/60'
                              }`}
                            />
                            <span className="min-w-0 flex-1">
                              <span
                                title={item.target.name}
                                className={`block truncate text-[0.7812rem] font-medium ${selected ? 'text-primary' : ''}`}
                              >
                                {item.target.name}
                                {entry.isCanonical && section.entries.length > 1 ? (
                                  <span className="ml-1.5 text-[0.6875rem] font-normal text-muted-foreground">主</span>
                                ) : null}
                              </span>
                              <span className="block truncate cds-ident text-xs text-muted-foreground">
                                {item.target.ssh?.host || item.target.type}
                                {recovery.hasUnconfirmed(projectId, item.target.id) ? ' · 本次结果待确认' : item.currentCommit ? ` · ${item.currentCommit.slice(0, 7)}` : ' · 未发布'}
                              </span>
                            </span>
                            {/* 落后主干几个提交由后端 commitPosition 给；算不出时它缺席，这里就不显示 */}
                            {typeof behind === 'number' && behind > 0 ? (
                              <span className="shrink-0 rounded bg-warn-soft px-1.5 py-0.5 cds-ident text-[0.6875rem] font-medium text-warn">
                                落后 {behind}
                              </span>
                            ) : null}
                          </button>
                        );
                      })}
                    </div>
                  ))}
                </div>
              )}
            </div>
          </aside>

          {/* ══ 中栏：状态是主角 ══ */}
          <main className={RELEASE_CONSOLE_CENTER_CLASS}>
            {error ? (
              <div className="flex items-center gap-2 rounded-lg border border-bad/30 bg-bad-soft px-3 py-2 text-sm text-bad">
                <AlertTriangle className="h-4 w-4 shrink-0" />
                <span className="min-w-0 break-words">{error}</span>
              </div>
            ) : null}

            <section className={`cds-surface-raised shrink-0 rounded-[0.875rem] border px-3 py-[1.125rem] sm:px-5 ${toneRing}`}>
              <div className="flex flex-wrap items-center gap-[1.125rem]">
                {/* 进行中时向外扩一圈光晕（参考稿 pulseRing）。终态静止。 */}
                <div className={`flex h-[3.25rem] w-[3.25rem] shrink-0 items-center justify-center rounded-[0.875rem] border border-[hsl(var(--hairline))] bg-[hsl(var(--surface-sunken))] ${running ? 'cds-status-pulse' : ''}`}>
                  {targetUnconfirmed ? <AlertTriangle className="h-[1.375rem] w-[1.375rem] text-warn" /> : running ? <Loader2 className="h-[1.375rem] w-[1.375rem] animate-spin text-primary" />
                    : failed ? <XCircle className="h-[1.375rem] w-[1.375rem] text-bad" />
                    : shown ? <CheckCircle2 className="h-[1.375rem] w-[1.375rem] text-ok" />
                    : <Rocket className="h-[1.375rem] w-[1.375rem] text-muted-foreground" />}
                </div>

                {/* basis-0 + min-width：换行判据用的是各项的**假想主尺寸**（basis，中段被
                    min-width 兜住），不是 grow 之后的结果。1600 宽下内容行 764px，
                    52(图标) + 18 + 340 + 18 + 300(三个按钮) = 728，留得下一行。
                    版本选择挪进标题行之后操作组才收得到 300 —— 它在操作组里时是 480。 */}
                <div className="min-w-0 flex-1 basis-[21.25rem]">
                  <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                    <h2 className={`text-xl font-bold ${failed ? 'text-bad' : running ? 'text-primary' : ''}`}>
                      {statusTitle}
                    </h2>
                    {/* 「历史记录」这一枚是本次改动的核心：没有它，满格绿的进度条
                        会被读成「我刚发布成功了」，而用户其实什么都没做。 */}
                    {!targetUnconfirmed && stance.badge ? (
                      <span className="shrink-0 rounded-[0.375rem] border border-[hsl(var(--hairline-strong))] bg-[hsl(var(--surface-sunken))] px-1.5 py-0.5 text-[0.6562rem] text-muted-foreground">
                        {stance.badge}
                      </span>
                    ) : null}
                    {!targetUnconfirmed && stance.selectedIsLive ? (
                      <span className="shrink-0 rounded-[0.375rem] bg-ok-soft px-1.5 py-0.5 text-[0.6562rem] text-ok">
                        选中版本已在线上
                      </span>
                    ) : null}
                    {/* 参考稿的副标题就一句「项目 → 环境」。这里补一段「替换线上的 X」——
                        那是发布前唯一必须确认的事实，原来它单占一行挂在 banner 外面。 */}
                    <span className="min-w-0 truncate cds-ident text-xs text-muted-foreground">
                      {row ? (
                        <>
                          {projects.find((item) => item.id === projectId)?.name || projectId}
                          {' → '}
                          <span className="text-foreground/80">{row.target.name}</span>
                          {shown ? ` · ${targetUnconfirmed ? '上次记录 ' : run ? running ? '本次任务 ' : '已完成任务 ' : '历史记录 '}${shown.commitSha.slice(0, 7)}` : null}
                          {!targetUnconfirmed && !shown && commitSha
                            ? (commitSha.slice(0, 7) === (row.currentCommit || '').slice(0, 7)
                              ? ' · 与线上同版'
                              : ` · 替换线上的 ${row.currentCommit ? row.currentCommit.slice(0, 7) : '（未发布）'}`)
                            : null}
                        </>
                      ) : '选择一个环境'}
                    </span>
                    {/* 版本选择跟着标题走，不进右侧操作组。进操作组时那一行要装
                        「选择 + 三个按钮」约 480px，中段只剩 194px，进度条被压成一小截
                        ——参考稿的进度条是横贯整个中段的。原来它连同「来源 / 二次确认」
                        独占 banner 上方两行，那两行正是用户框出来的「过于丑陋」的一半；
                        来源地址收进 title 提示。 */}
                    {!targetRequest ? <label htmlFor="release-source-version" className="text-sm text-muted-foreground">{run && !running ? '下一次来源' : '发布来源'}</label> : null}
                    {targetRequest ? <p aria-label="原请求来源版本" className="break-all text-sm text-muted-foreground">原请求：{targetRequest.branchLabel || targetRequest.branchId} · <code>{targetRequest.commitSha.slice(0, 12)}</code></p> : (
                    <select
                      id="release-source-version"
                      value={branchId}
                      disabled={commandPending || !!branchesError || targetUnconfirmed}
                      onChange={(event) => { linkedApprovalBranch.current = ''; setBranchId(event.target.value); setPreflight(null); setConfirmation(null); }}
                      title={previewUrl ? `来源 ${previewUrl}${sourceUrls.length > 1 ? ` 等 ${sourceUrls.length} 个入口` : ''}` : '取不到预览地址，发布前检查会拦下这一项'}
                      aria-label="要发布的版本"
                      className="cds-ident min-h-11 min-w-0 max-w-full shrink-0 rounded-lg border border-[hsl(var(--hairline))] bg-[hsl(var(--surface-sunken))] px-2 text-sm outline-none focus:border-[hsl(var(--hairline-strong))] sm:max-w-[14rem]"
                    >
                      {!branchId ? <option value="">{branches.length === 0 ? '没有可发布的分支' : '请选择分支'}</option> : null}
                      {branches.map(item => {
                        const revision = releaseWorkbenchCommit(item);
                        const subject = commitMeta[revision]?.subject || (item.commitSha === revision ? item.subject : undefined);
                        return <option key={item.id} value={item.id}>
                          {item.branch}{revision ? ` · ${revision.slice(0, 7)}` : ' · 版本未确认'}
                          {!targetUnconfirmed && sameCommit(revision, row?.currentCommit) ? ' · 线上' : ''}
                          {subject ? ` · ${subject}` : ''}
                        </option>;
                      })}
                    </select>
                    )}
                    {!targetRequest && !branchId && linkedApprovalBranch.current && !branchesError ? <p role="status" className="text-sm text-warn">申请中的分支当前不可用。请返回审批记录核对，或明确选择另一分支。</p> : null}
                    {!targetRequest && branchId && !commitSha && !branchesError ? <p role="status" className="text-sm text-warn">来源版本未确认，请刷新分支后再发布。</p> : null}
                  </div>
                  {!targetUnconfirmed ? <>
                  <div className="mt-2.5 h-1.5 w-full overflow-hidden rounded bg-[hsl(var(--surface-sunken))]">
                    <div
                      className={`cds-progress-fill h-full rounded ${running ? 'cds-progress-fill--running' : ''} ${
                        failed ? 'bg-bad' : running ? 'bg-primary' : 'bg-ok'
                      }`}
                      style={{ width: `${progress.steps.length ? Math.round((progress.steps.filter((s) => s.state === 'done').length / progress.steps.length) * 100) : 0}%` }}
                    />
                  </div>
                  {/* 参考稿这一行只有两个值：左边步数、右边耗时。别再往里塞日期——
                      塞了就换行，换行就把 banner 顶高，就是「头大」。 */}
                  <div className="mt-2 flex items-center justify-between gap-4 cds-ident text-[0.6875rem] text-muted-foreground">
                    <span className="truncate">
                      {progress.steps.filter((s) => s.state === 'done').length}/{progress.steps.length || 0} 步骤
                    </span>
                    <span className="shrink-0">
                      {etaText || (shown ? formatDuration(shown.startedAt, shown.finishedAt) || '进行中' : '未开始')}
                    </span>
                  </div>
                  </> : null}
                </div>

                <div className="flex min-w-0 w-full max-w-full flex-wrap items-center justify-end gap-2 [&_button]:min-h-10 sm:w-auto sm:shrink-0">
                  {running ? (
                    <Button variant="outline" onClick={() => void cancelRun()} disabled={commandPending || cancelUnknown?.releaseId === shown?.releaseId}>
                      <Ban />
                      中止
                    </Button>
                  ) : null}
                  {awaitingConfirm ? (
                    <>
                      <div className="w-full min-w-0 rounded-md border border-warn/40 bg-warn-soft p-3">
                        <p className="mb-1 text-xs text-muted-foreground">本次发布目标</p>
                        <div id="release-confirm-target" role="region" aria-label="本次发布目标" tabIndex={0} className="max-h-[40dvh] overflow-y-auto break-all text-sm">
                          {row?.target.name}
                        </div>
                      </div>
                      <Button variant="ghost" onClick={() => setConfirmation(null)}>取消</Button>
                    </>
                  ) : null}
                  {!running && !awaitingConfirm ? (
                    <Button variant="outline" onClick={() => void runPreflight()} disabled={!canPreflight}>
                      {busy === 'preflight' ? <Loader2 className="animate-spin" /> : <Gauge />}
                      {busy === 'preflight' ? '正在检查' : preflight ? '重新检查' : '发布前检查'}
                    </Button>
                  ) : null}
                  {preflight?.forceAvailable && !pendingConfirmation ? (
                    <Button variant="outline" onClick={() => requestRelease(true)} disabled={!canForce}>强制发布</Button>
                  ) : null}
                  <Button
                    aria-label={awaitingConfirm ? `确认${pendingConfirmation?.force ? '强制' : ''}发布到 ${row?.target.name}` : undefined}
                    aria-describedby={awaitingConfirm ? 'release-confirm-target' : undefined}
                    onClick={() => requestRelease(Boolean(pendingConfirmation?.force))}
                    disabled={pendingConfirmation?.force ? !canForce : !canStart}
                    className={`h-auto min-h-10 w-full max-w-full whitespace-normal break-words px-2 py-2 text-left sm:w-auto sm:px-4 ${awaitingConfirm ? 'ring-2 ring-bad/60' : ''}`}
                  >
                    {busy === 'deploy' || running ? <Loader2 className="animate-spin" /> : <Rocket />}
                    <span className="min-w-0 w-full break-words sm:w-auto">
                      {awaitingConfirm
                        ? pendingConfirmation?.force ? '确认强制发布' : '确认发布'
                        : busy === 'deploy' ? '正在提交'
                        : targetUnconfirmed ? '等待核对结果' : stance.primaryLabel}
                    </span>
                  </Button>
                </div>
              </div>
            </section>

            {/*
              「你现在在哪」。历史态时这一条必须出现：屏幕上那套满格进度条 + 打勾步骤
              + 一屏日志全是上一次发布留下的，不说清楚，用户会以为是自己刚做的
              （用户原话：「很有心智负担」）。本次真发起了就不出——那时屏幕自己说得清。
            */}
            {shown?.governance && !targetUnconfirmed ? <div aria-label="本次发布审批与执行记录" className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-2 rounded-md border border-[hsl(var(--hairline))] px-3.5 py-2.5 text-xs">
              <strong>{shown.governance.kind === 'debug' ? '连续调试授权' : '独立批准'}</strong>
              <span>执行人 {releaseActorLabel(shown.operator)}</span>
              <span>批准人 {releaseActorLabel(shown.governance.approvedBy)}</span>
              <Link className="font-medium text-primary underline" to={releaseApprovalPath(shown.governance.authorizationId)}>查看这笔审批</Link>
            </div> : null}
            {shown?.forceReason && !targetUnconfirmed ? <p className="break-words text-sm text-warn">强制发布 · {shown.forceReason}</p> : null}
            {!targetUnconfirmed && stance.hint ? (
              <div className={`flex shrink-0 flex-wrap items-center gap-2 rounded-[0.625rem] border px-3.5 py-2.5 text-xs ${
                stance.selectedIsLive
                  ? 'border-ok/40 bg-ok-soft text-ok'
                  : 'border-[hsl(var(--hairline-strong))] bg-[hsl(var(--surface-sunken))] text-muted-foreground'
              }`}>
                <History className="h-3.5 w-3.5 shrink-0" />
                <span className="min-w-0 flex-1">{stance.hint}</span>
              </div>
            ) : null}

            {/*
              从发布中心点「回滚」跳过来。只做一件事：把人接住并指出下一步在哪。
              真正的回滚仍然走既有的二次确认，这里不代替它——带个 query 参数就直接
              退线上版本，那是把一个危险动作降级成一条链接。
            */}
            {arrivedIntent === 'rollback' && row && !targetUnconfirmed ? (
              <div className="flex shrink-0 flex-wrap items-center gap-2 rounded-[0.625rem] border border-warn/40 bg-warn-soft px-3.5 py-2.5 text-xs text-warn">
                <RotateCcw className="h-3.5 w-3.5 shrink-0" />
                <span className="min-w-0 flex-1 basis-full sm:basis-0">
                  从发布中心过来回滚 {row.target.name}
                  {row.canRollback
                    ? '：在下方历史记录里选一版，点「回滚到此版本」；回滚同样要确认。'
                    : '，但这个环境没有可回滚的历史版本。'}
                </span>
                <Button variant="ghost" size="sm" onClick={() => setArrivedIntent('')}>知道了</Button>
              </div>
            ) : null}

            {blockedByOther && liveRow ? (
              <div className="flex shrink-0 items-center gap-2 rounded-lg border border-primary/30 bg-primary/[0.07] px-3 py-2 text-xs text-primary">
                <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" />
                <span className="min-w-0">
                  {liveRow.target.name} 正在发布，这里的发布按钮先锁住。
                  服务端保证同一目标不并发（冲突返回 409），跨目标这一道是本页额外收的口。
                </span>
              </div>
            ) : null}

            {/* 卡住判定：还在跑但久无输出。用户原话——「点击之后就卡住没后续了，
                到底是否成功，我们不清楚」。这条就是回答它的。 */}
            {stall.stalled && !targetUnconfirmed ? (
              <div className="flex shrink-0 flex-wrap items-center gap-2 rounded-lg border border-warn/40 bg-warn-soft px-3 py-2 text-xs text-warn">
                <Clock className="h-3.5 w-3.5 shrink-0" />
                <span className="min-w-0 flex-1 basis-full sm:basis-0">
                  已经 {Math.round(stall.silentMs / 1000)} 秒没有新输出了。
                  发布还没结束，可能是这一步本身慢，也可能是执行端卡住——可以先取证再决定要不要中止。
                </span>
                <Button variant="outline" size="sm" onClick={() => setSheet('agent')}>
                  <Clipboard />
                  取证给智能体
                </Button>
                <Button variant="outline" size="sm" onClick={() => void cancelRun()} disabled={commandPending || cancelUnknown?.releaseId === shown?.releaseId}>
                  <Ban />
                  中止
                </Button>
              </div>
            ) : null}

            {/* 终态结论条：跑完了给一句话 + 就地能做的下一步，不用去右栏翻记录。 */}
            {shown && !running && !targetUnconfirmed ? (
              <div className={`flex shrink-0 flex-wrap items-center gap-2 rounded-lg border px-3 py-2 text-xs ${
                failed
                  ? 'border-bad/30 bg-bad-soft text-bad'
                  : 'border-ok/30 bg-ok-soft text-ok'
              }`}>
                {failed ? <XCircle className="h-3.5 w-3.5 shrink-0" /> : <CheckCircle2 className="h-3.5 w-3.5 shrink-0" />}
                <span className="min-w-0 flex-1 basis-full break-words sm:basis-0">
                  {failed
                    ? (diagnosis?.headline || '本次发布失败，日志里没能提取出结构化判据')
                    : `${shownIsCurrent
                      ? `${row?.target.name || '目标'}已切到 ${shown.commitSha.slice(0, 7)}`
                      : `这是一条历史记录：${shown.commitSha.slice(0, 7)} 曾发布成功，${row?.target.name || '该环境'}当前跑的不是这一版`}${
                      formatDuration(shown.startedAt, shown.finishedAt) ? `，用时 ${formatDuration(shown.startedAt, shown.finishedAt)}` : ''}`}
                </span>
                {shown.autoRestoreStartedAt ? <span className="basis-full font-medium">
                  {shown.autoRestoredAt ? '已恢复发布前的运行版本，公网复验通过。' : '自动回滚尚未验证，请查看发布日志。'}
                </span> : null}
                {failed ? (
                  <>
                    <Button variant="outline" size="sm" onClick={() => setSheet('agent')}>
                      <Clipboard />
                      交给智能体
                    </Button>
                    <Button variant="outline" size="sm" onClick={() => void retryRun(shown)} disabled={commandPending || targetUnconfirmed}>
                      {rowBusy === shown.releaseId ? <Loader2 className="animate-spin" /> : <RotateCcw />}
                      重发这一版
                    </Button>
                  </>
                ) : null}
                {!failed && shownIsCurrent && row?.canRollback ? (
                  <Button variant="outline" size="sm" onClick={() => void rollbackRun(shown)} disabled={commandPending || targetUnconfirmed}>
                    {rowBusy === shown.releaseId ? <Loader2 className="animate-spin" /> : <RotateCcw />}
                    回滚
                  </Button>
                ) : null}
              </div>
            ) : null}

            {preflight ? (
              <div aria-label="发布前检查结果" className="cds-surface-raised cds-hairline shrink-0 rounded-[0.625rem] border px-3.5 py-2.5">
                <div className="mb-2 flex items-center justify-between gap-2">
                  <span className="text-xs font-semibold">发布前检查结果</span>
                  <Chip tone={!preflight.ok ? 'bad' : preflightMatchesCommit ? 'ok' : 'warn'}>
                    {!preflight.ok ? `${preflight.checks.filter(item => item.blocking && item.status === 'fail').length} 项阻断`
                      : preflightMatchesCommit ? '检查通过' : '来源版本待确认'}
                  </Chip>
                </div>
                {preflight.checks.some(check => check.status !== 'pass') ? (
                  <ul className="flex flex-col gap-1">
                    {preflight.checks.filter(check => check.status !== 'pass').map(check => (
                      <li key={check.id} className="flex items-start gap-2 break-words text-xs">
                        <strong className={`shrink-0 ${check.blocking ? 'text-bad' : 'text-warn'}`}>{check.blocking ? '阻断' : '告警'}</strong>
                        <span className="min-w-0">{check.label} · {collapseCheckMessage(check.message).summary}</span>
                      </li>
                    ))}
                  </ul>
                ) : null}
                {preflight.forceAvailable ? (
                  <label className="mt-2 grid min-w-0 gap-1 text-xs">
                    强制发布原因
                    <input className="min-h-10 min-w-0 rounded-md border bg-background px-3 py-2"
                      value={forceReason} onChange={event => { setForceReason(event.target.value); setConfirmation(null); }}
                      maxLength={300} placeholder="将外部业务依赖故障记为告警" />
                  </label>
                ) : null}
              </div>
            ) : null}

            {/* 参考稿的流水线列是 300px，同样只在宽画布上成立：中栏 560 的时候
                300 会把实时输出压到 246px，日志头那一排按钮直接被卡片切掉。 */}
            {!targetUnconfirmed || shown ? (
            <div className="grid min-h-0 flex-1 gap-3.5 xl:grid-cols-[14.5rem_minmax(0,1fr)] 2xl:grid-cols-[18.75rem_minmax(0,1fr)]">
              {/* 与右侧日志等高（参考稿 grid 两列 stretch）。之前用 self-start 让它按内容收高，
                  结果卡片底边下面空出一大块底色 —— 悬空的短卡读起来是「洞」，不是「省地方」。 */}
              <section className="cds-surface-raised cds-hairline flex min-h-0 flex-col overflow-hidden rounded-[0.875rem] border">
                <div className="shrink-0 border-b border-[hsl(var(--hairline)/0.6)] px-3.5 py-3">
                  <SectionLabel>{targetUnconfirmed ? '上次已知流水线' : 'Pipeline'}</SectionLabel>
                </div>
                <div className="min-h-0 flex-1 overflow-y-auto p-1.5 max-xl:max-h-64">
                  {progress.steps.map((step) => (
                    <div
                      key={step.id}
                      className={`flex items-start gap-2.5 rounded-[0.5625rem] px-2.5 py-2.5 transition-colors duration-200 ${
                        step.state === 'failed' ? 'bg-bad-soft' : step.state === 'running' ? 'bg-primary/[0.08]' : ''
                      }`}
                    >
                      <span className="mt-0.5 shrink-0">
                        {step.state === 'done' ? <CheckCircle2 className="h-3.5 w-3.5 text-ok" />
                          : step.state === 'failed' ? <XCircle className="h-3.5 w-3.5 text-bad" />
                          : step.state === 'running' ? <Loader2 className="h-3.5 w-3.5 animate-spin text-primary" />
                          : <span className="ml-0.5 block h-2.5 w-2.5 rounded-full border border-[hsl(var(--hairline-strong))]" />}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="flex items-center gap-2">
                          <span className={`min-w-0 truncate text-xs ${step.state === 'pending' ? 'text-muted-foreground' : ''}`}>{step.label}</span>
                          {/* 「哪一步正在跑」要说出来，不能只靠一个转圈图标（参考稿有这枚标签） */}
                          {step.state === 'running' ? (
                            <span className="shrink-0 cds-ident text-[0.625rem] text-primary">运行中</span>
                          ) : null}
                        </span>
                        {/* 这一步实际跑的命令。计划里没有就不显示——不拿别的步骤的命令顶上。 */}
                        {stepDetails.get(step.id)?.command ? (
                          <span className="mt-0.5 block truncate cds-ident text-xs text-muted-foreground">
                            {stepDetails.get(step.id)?.command}
                          </span>
                        ) : null}
                      </span>
                      {/* 未执行的步骤给短横，不编一个预估值 */}
                      <span className="mt-0.5 shrink-0 cds-ident text-xs text-muted-foreground">
                        {typeof stepDetails.get(step.id)?.durationMs === 'number'
                          ? `${Math.max(1, Math.round((stepDetails.get(step.id)?.durationMs || 0) / 1000))}s`
                          : '-'}
                      </span>
                    </div>
                  ))}
                  {progress.degraded ? (
                    <p className="px-2.5 pt-1 text-[0.7188rem] text-muted-foreground">历史记录，仅按日志还原大致阶段。</p>
                  ) : null}
                </div>
              </section>

              <section className="cds-hairline flex min-h-0 flex-col overflow-hidden rounded-[0.875rem] border bg-[hsl(var(--surface-sunken))]">
                {/* 参考稿这一排是 24px 高的小按钮，不是常规 sm 按钮。
                    flex-wrap 保留：卡片 overflow-hidden，超宽会被直接裁掉
                    （实测过 scrollWidth 291 / clientWidth 244，半个按钮消失在卡外）。 */}
                <div className="flex shrink-0 flex-wrap items-center justify-between gap-x-2 gap-y-1.5 border-b border-[hsl(var(--hairline)/0.6)] px-3.5 py-2.5">
                  <SectionLabel>{targetUnconfirmed ? '上次已知输出' : 'Live output'}</SectionLabel>
                  <span className="flex flex-wrap items-center gap-2 [&>button]:h-6 [&>button]:rounded-md [&>button]:border [&>button]:border-[hsl(var(--hairline))] [&>button]:px-2.5 [&>button]:text-[0.6875rem]">
                    <button type="button" onClick={() => void copyLogs()} disabled={shownLogs.length === 0} className="text-muted-foreground hover:text-foreground disabled:opacity-40">
                      复制日志
                    </button>
                    <button type="button" onClick={() => setFollowing((current) => !current)} className={following ? 'text-foreground' : 'text-muted-foreground hover:text-foreground'}>
                      {following ? '跟随最新' : '已暂停跟随'}
                    </button>
                    {/* 现场就在这一屏，取证入口也该在这一屏，不用绕去右栏 */}
                    <button type="button" onClick={() => setSheet('agent')} disabled={!shown} className="border-primary/40 bg-primary/[0.08] text-primary disabled:opacity-40">
                      交给智能体
                    </button>
                  </span>
                </div>
                {/* 参考稿的日志是**终端**：左侧固定时间列 + 右侧按语义着色的正文，
                    命令行提亮、成功行绿、错误行红。原来这里是一整块同色 pre，
                    每行前缀还硬拼 `[时间] LEVEL`，扫读全靠自己找。 */}
                <div
                  ref={logRef}
                  onScroll={(event) => {
                    const node = event.currentTarget;
                    const atBottom = node.scrollHeight - node.scrollTop - node.clientHeight < 40;
                    if (!atBottom && following) setFollowing(false);
                  }}
                  className="min-h-0 flex-1 overflow-auto px-3.5 py-2.5 cds-ident text-[0.7188rem] leading-[1.75] max-xl:max-h-72"
                >
                  {shownLogs.length === 0 ? (
                    <p className="text-muted-foreground">还没有输出。点「开始发布」后，这里会逐行滚动。</p>
                  ) : shownLogs.map((log) => (
                    <div key={log.seq} className="cds-log-line flex gap-2.5">
                      <span className="shrink-0 text-muted-foreground">{formatClock(log.at)}</span>
                      <span className={`min-w-0 whitespace-pre-wrap break-words ${LOG_TONE_CLASS[logLineTone(log.level, log.message)]}`}>
                        {log.message}
                      </span>
                    </div>
                  ))}
                </div>
              </section>
            </div>
            ) : null}
          </main>

          {/* ══ 右栏：只放「看记录」。配置与 Agent 走全屏浮层 ══ */}
          {/* 348px 的窄栏装不下发布流水线和一整段任务文本 —— 塞进来就是逼人在
              一条窄缝里横向读命令。这两块改成浮层，右栏专心做记录。 */}
          <aside className={RELEASE_CONSOLE_RIGHT_CLASS}>
            {/* 参考稿是一条四格 tab（历史 / 失败 / 高级 / Agent），不是「左两个 tab
                右两个链接」。后两个在这里打开全屏浮层——348px 的窄栏装不下流水线
                与整段任务文本，这一条是对参考稿结构问题的有意修正，其余照抄。 */}
            <div className="flex shrink-0 flex-wrap gap-0.5 border-b border-[hsl(var(--hairline))] px-2.5 pt-2.5 [&>button]:shrink-0 [&>button]:whitespace-nowrap">
              {([['history', '历史发布'], ['failed', '失败']] as Array<[RailPane, string]>).map(([key, label]) => (
                <button
                  key={key}
                  type="button"
                  role="tab"
                  aria-selected={pane === key}
                  onClick={() => setPane(key)}
                  className={`-mb-px flex items-center gap-1.5 border-b-2 px-3 pb-2.5 pt-2 text-xs ${
                    pane === key ? 'border-primary text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground'
                  }`}
                >
                  {label}
                  {key === 'failed' && failedRuns.length > 0 ? (
                    <span className="rounded bg-bad-soft px-1.5 cds-ident text-[0.625rem] text-bad">{failedRuns.length}</span>
                  ) : null}
                </button>
              ))}
              {([['pipeline', '流水线'], ['agent', 'Agent']] as Array<['pipeline' | 'agent', string]>).map(([key, label]) => (
                <button
                  key={key}
                  type="button"
                  onClick={() => setSheet(key)}
                  className="-mb-px border-b-2 border-transparent px-3 pb-2.5 pt-2 text-xs text-muted-foreground hover:text-foreground"
                >
                  {label}
                </button>
              ))}
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto p-3.5 max-xl:max-h-[26.25rem]">
              {(() => {
                const list = pane === 'failed' ? failedRuns : runsOfProject;
                if (list.length === 0) {
                  return <p className="p-2 text-xs text-muted-foreground">{recovery.requests.some(request => request.projectId === projectId) ? '尚未读到本次请求的记录，请通过上方请求编号核对。' : pane === 'failed' ? '这个项目没有失败记录。' : '这个项目还没有发布记录。'}</p>;
                }
                return (
                  <div className="flex flex-col gap-2">
                    {list.slice(0, 30).map((item) => {
                      const itemRow = rows.find((r) => r.target.id === item.targetId);
                      const itemFailed = isReleaseFailed(item.status);
                      const live = !recovery.hasUnconfirmed(projectId, item.targetId) && itemRow?.currentVersion === item.releaseId;
                      // 「不是失败、也不是线上」不等于「成功」：queued / running /
                      // healthchecking / rollback_running 都落在这一档，原来一律绿点
                      // 加「成功」，还给出回滚入口——回滚到一个还没发完的版本。
                      // 状态判定复用 release-center/shared 那份唯一映射。
                      const itemTone = runTone(item.status);
                      const itemDone = item.status === 'success' || item.status === 'rollback_success';
                      const itemBusy = rowBusy === item.releaseId;
                      return (
                        <div
                          key={item.releaseId}
                          className={`flex min-w-0 flex-col gap-[0.4375rem] rounded-[0.625rem] border px-3 py-[0.6875rem] transition-colors duration-150 hover:border-[hsl(var(--hairline-strong))] ${
                            itemFailed ? 'border-bad/30 bg-bad-soft' : 'border-[hsl(var(--hairline))] bg-[hsl(var(--surface-sunken))]/50'
                          }`}
                        >
                          {/* 第一行：状态圆点 + 版本 + 环境，右端是结论。参考稿的圆点在最左，
                              一列扫下来就能数出「几次成功几次失败」。 */}
                          <div className="flex min-w-0 items-center justify-between gap-2">
                            <span className="flex min-w-0 items-center gap-2">
                              <span
                                className={`h-[0.4375rem] w-[0.4375rem] shrink-0 rounded-full ${
                                  itemFailed ? 'bg-bad' : live ? 'bg-primary' : itemTone === 'warn' ? 'bg-warn' : itemDone ? 'bg-ok' : 'bg-muted-foreground'
                                }`}
                              />
                              <span className="shrink-0 cds-ident text-xs font-medium">{item.commitSha.slice(0, 7)}</span>
                              <span className="truncate text-[0.6875rem] text-muted-foreground">
                                {itemRow?.target.name || item.targetId}
                              </span>
                            </span>
                            <span className={`shrink-0 cds-ident text-[0.6562rem] ${itemFailed ? 'text-bad' : live ? 'text-primary' : itemTone === 'warn' ? 'text-warn' : itemDone ? 'text-ok' : 'text-muted-foreground'}`}>
                              {itemFailed ? '失败' : live ? '线上' : statusLabel(item.status)}
                            </span>
                          </div>
                          {/* 第二行：左元信息右操作（参考稿同一行）。元信息不 truncate——
                              300px 栏里先被吃掉的正好是末尾的耗时（1m42s 截成 1m4…）。 */}
                          <div className="flex min-w-0 flex-wrap items-center justify-between gap-x-3 gap-y-1 cds-ident text-[0.6562rem] text-muted-foreground">
                            <span className="min-w-0">
                              {releaseActorLabel(item.operator)} · {formatDateTime(item.startedAt)}
                              {formatDuration(item.startedAt, item.finishedAt) ? ` · ${formatDuration(item.startedAt, item.finishedAt)}` : ''}
                            </span>
                            <span className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
                            <button
                              type="button"
                              className="text-muted-foreground hover:text-primary disabled:opacity-40"
                              disabled={commandPending}
                              onClick={() => {
                                setRun(null);
                                setHistoryRun(item);
                                setLogs(dedupeLogs(item.logs || []));
                                setTargetId(item.targetId);
                                setFollowing(false);
                              }}
                            >
                              看日志
                            </button>
                            {itemFailed ? (
                              <button
                                type="button"
                                className="text-muted-foreground hover:text-primary disabled:opacity-40"
                                disabled={commandPending}
                                onClick={() => {
                                  setRun(null);
                                  setHistoryRun(item);
                                  setLogs(dedupeLogs(item.logs || []));
                                  setTargetId(item.targetId);
                                  setSheet('agent');
                                }}
                              >
                                交给智能体
                              </button>
                            ) : null}
                            <button
                              type="button"
                              disabled={commandPending || inFlight || recovery.hasUnconfirmed(projectId, item.targetId)}
                              className="text-muted-foreground hover:text-primary disabled:opacity-40 disabled:hover:text-muted-foreground"
                              onClick={() => void retryRun(item)}
                            >
                              {itemBusy ? '提交中' : '重发这一版'}
                            </button>
                            {itemDone && itemRow?.canRollback && !live ? (
                              <button
                                type="button"
                                disabled={commandPending || inFlight || recovery.hasUnconfirmed(projectId, item.targetId)}
                                className="text-muted-foreground hover:text-primary disabled:opacity-40 disabled:hover:text-muted-foreground"
                                onClick={() => void rollbackToVersion(item, itemRow)}
                              >
                                回滚到此版本
                              </button>
                            ) : null}
                            </span>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                );
              })()}
            </div>
          </aside>
        </div>}
        </div>
        {batchLog ? <ReleaseLogDialog run={batchLog} readOnly retryingRunId="" canRollback={false} onRetry={() => {}} onRollback={() => {}} onClose={() => setBatchLog(null)} /> : null}

        {/* ══ 浮层：发布流水线（只读）══ */}
        {sheet === 'pipeline' ? (
          <Sheet
            title="发布流水线"
            subtitle={row ? `${row.target.name} · ${activePlan?.name || '按目标策略执行'}` : '选择一个环境'}
            onClose={() => setSheet(null)}
          >
            <div className="flex flex-col gap-3 p-4">
              <p className="text-xs leading-relaxed text-muted-foreground">
                这一页只读。当前后端的计划模板只登记步骤名，不登记每步命令，所以下面多数步骤看不到命令行——
                真正执行的脚本在「部署命令」一栏与实时输出里。要改步骤、命令、健康检查地址，去
                <Link className="mx-1 text-primary hover:underline" to={`/release-center?project=${encodeURIComponent(projectId)}&section=config`}>环境管理</Link>
                的配置页签——后端没有第二处可写入口，这里再放一个编辑器就是画一个存不下去的表单。
              </p>
              {(activePlan?.steps || []).length === 0 ? (
                <p className="rounded-md border border-[hsl(var(--hairline))] bg-[hsl(var(--surface-sunken))] p-3 text-xs text-muted-foreground">
                  这个目标没有结构化流水线，发布直接跑下面的部署命令。
                </p>
              ) : (
                <ol className="flex flex-col gap-2">
                  {(activePlan?.steps || []).map((step, index) => (
                    <li key={step.id} className="rounded-md border border-[hsl(var(--hairline))] bg-[hsl(var(--surface-sunken))] p-3">
                      <div className="flex items-baseline gap-2">
                        <span className="cds-ident text-xs text-muted-foreground">{String(index + 1).padStart(2, '0')}</span>
                        <span className="min-w-0 flex-1 truncate text-[0.7812rem] font-medium">{step.title}</span>
                        <span className="shrink-0 cds-ident text-xs text-muted-foreground">{step.kind}</span>
                      </div>
                      {step.command ? (
                        <pre className="mt-2 overflow-x-auto whitespace-pre-wrap break-all rounded bg-[hsl(var(--surface-base))] p-2 cds-ident text-xs leading-relaxed">
                          {step.command}
                        </pre>
                      ) : (
                        // 不要写成「这一步不执行命令」——那是在替后端圆场。当前三份计划模板
                        // 都没给 steps[].command 赋值（release-service.ts 建 plan 处），
                        // 所以这里如实说命令没登记，并指到真实脚本所在的地方。
                        <p className="mt-1.5 text-[0.6875rem] text-muted-foreground">
                          计划模板没有登记这一步的命令。实际执行的脚本见下方「部署命令」与实时输出。
                        </p>
                      )}
                    </li>
                  ))}
                </ol>
              )}
              <dl className="grid grid-cols-[5.75rem_minmax(0,1fr)] gap-x-3 gap-y-2 border-t border-[hsl(var(--hairline))] pt-3 text-xs">
                <dt className="text-[0.6875rem] font-semibold uppercase tracking-normal text-muted-foreground">方式</dt>
                <dd className="break-words">{row?.target.strategy?.mode || '项目现有脚本'}</dd>
                <dt className="text-[0.6875rem] font-semibold uppercase tracking-normal text-muted-foreground">部署命令</dt>
                <dd className="break-all cds-ident text-xs">{row?.target.strategy?.command || row?.target.ssh?.deployCommand || '未配置'}</dd>
                <dt className="text-[0.6875rem] font-semibold uppercase tracking-normal text-muted-foreground">站点目录</dt>
                <dd className="break-all cds-ident text-xs">{row?.target.ssh?.appPath || '未配置'}</dd>
                <dt className="text-[0.6875rem] font-semibold uppercase tracking-normal text-muted-foreground">健康检查</dt>
                <dd className="break-all cds-ident text-xs">{row?.target.ssh?.healthcheckUrl || '未配置'}</dd>
                <dt className="text-[0.6875rem] font-semibold uppercase tracking-normal text-muted-foreground">回滚</dt>
                <dd className="break-all cds-ident text-xs">{row?.target.ssh?.rollbackCommand || '重新发布上一个成功版本'}</dd>
                <dt className="text-[0.6875rem] font-semibold uppercase tracking-normal text-muted-foreground">并发</dt>
                <dd>服务端保证同一目标不并发（冲突返回 409）；跨目标那道锁是本页 UI 策略</dd>
                <dt className="text-[0.6875rem] font-semibold uppercase tracking-normal text-muted-foreground">卡住判定</dt>
                <dd>超过 45 秒没有新输出即在状态区提示，并给出取证与中止入口</dd>
              </dl>
            </div>
          </Sheet>
        ) : null}

        {/* ══ 浮层：交给智能体 ══ */}
        {sheet === 'agent' ? (
          <Sheet
            title="交给智能体"
            subtitle="现场已整理成可直接粘贴的任务"
            onClose={() => setSheet(null)}
            foot={(
              <>
                <span className="cds-ident text-xs text-muted-foreground">
                  {shown ? `${agentTask().length} 字 · ${shownLogs.length} 行日志` : '没有可整理的现场'}
                </span>
                <Button size="sm" onClick={() => void copyAgentTask()} disabled={!shown}>
                  <Clipboard />
                  复制
                </Button>
              </>
            )}
          >
            <div className="flex flex-col gap-3 p-4">
              <p className="text-xs leading-relaxed text-muted-foreground">
                结论与判据全部取自 releaseDiagnosis 从本次真实日志里提取的内容；提不出来会如实写「未能提取」，不编原因。
              </p>
              <pre className="whitespace-pre-wrap break-words rounded-md border border-[hsl(var(--hairline))] bg-[hsl(var(--surface-sunken))] p-3 cds-ident text-[0.7812rem] leading-relaxed">
                {shown ? agentTask() : '选中一次运行后，这里给出可直接粘贴的任务文本。'}
              </pre>
            </div>
          </Sheet>
        ) : null}

        {toast ? (
          <div className="fixed bottom-6 left-1/2 z-[220] -translate-x-1/2 rounded-full bg-foreground px-4 py-2 text-xs font-medium text-background shadow-lg">
            {toast}
          </div>
        ) : null}
      </Workspace>
    </AppShell>
  );
}

export default ReleaseConsolePage;
