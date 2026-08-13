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
 *   POST /api/releases/branches/:branchId/preflight 试跑（只检查不发布）
 *   POST /api/releases/branches/:branchId/runs      开始发布
 *   GET  /api/releases/runs/:id/stream              实时状态与输出（SSE）
 *   POST /api/releases/runs/:id/cancel              中止
 */

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useSearchParams } from 'react-router-dom';
import { AlertTriangle, Ban, CheckCircle2, Clipboard, Clock, Loader2, RefreshCw, Rocket, RotateCcw, Search, X, XCircle } from 'lucide-react';
import { AppShell, Crumb, TopBar, Workspace } from '@/components/layout/AppShell';
import { Button } from '@/components/ui/button';
import { useNowTick } from '@/hooks/useNowTick';
import { ApiError, apiRequest, apiUrl } from '@/lib/api';
import { buildReleaseAgentTask } from '@/lib/releaseAgentTask';
import { detectStall, resolveStepDetails, type ConsolePlanLike } from '@/lib/releaseConsoleView';
import { buildEnvironmentSections, resolveSelectedTargetId } from '@/lib/releaseEnvironments';
import { resolveReleaseSourceUrls } from '@/lib/releaseDialogAddress';
import { diagnoseReleaseFailure } from '@/lib/releaseDiagnosis';
import { releaseEtaText } from '@/lib/releaseEta';
import { resolveReleaseSteps } from '@/lib/releaseSteps';
import { Chip, formatClock, formatDateTime, formatDuration } from './release-center/shared';
// BranchOption 复用发布中心那一份：分支的展示名是 `branch` 不是 `name`，
// 自己再声明一个接口只会让 TS 对着一个不存在的字段点头（真实数据里下拉全是空的）。
import type { BranchOption, CenterResponse, ReleaseCommitMeta, ReleaseLogEntry, ReleaseRun } from './release-center/types';
import { isReleaseFailed, isReleaseTerminal } from './release-center/types';

interface ProjectLite { id: string; name?: string; githubRepoFullName?: string }
interface PreflightCheck { id?: string; label?: string; name?: string; status: string; blocking?: boolean; detail?: string }
interface PreflightResult { checks: PreflightCheck[] }

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
 * 结构与 shadcn Dialog 一致（遮罩 + 面板 + 头/体/脚），但这两处不需要
 * 表单语义，直接用 div 更轻；z-index 走 CDS 新栈的「全屏面板」档（100）。
 */
function Sheet({ title, subtitle, onClose, foot, children }: {
  title: string;
  subtitle?: string;
  onClose: () => void;
  foot?: ReactNode;
  children: ReactNode;
}): JSX.Element {
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => { if (event.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50 p-0 sm:p-6" role="presentation" onClick={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onClick={(event) => event.stopPropagation()}
        className="cds-surface-raised cds-hairline flex h-full w-full max-w-3xl flex-col overflow-hidden border shadow-2xl sm:h-[min(82vh,720px)] sm:rounded-xl"
      >
        <div className="flex shrink-0 items-start justify-between gap-3 border-b border-[hsl(var(--hairline))] px-4 py-3">
          <div className="min-w-0">
            <h3 className="truncate text-sm font-semibold">{title}</h3>
            {subtitle ? <p className="mt-0.5 truncate text-[11.5px] text-muted-foreground">{subtitle}</p> : null}
          </div>
          <Button variant="ghost" size="sm" onClick={onClose} aria-label="关闭">
            <X />
          </Button>
        </div>
        {/* 窄屏整体竖滚；桌面也是这一块滚，头脚不动 */}
        <div className="min-h-0 flex-1 overflow-y-auto" style={{ overscrollBehavior: 'contain' }}>
          {children}
        </div>
        {foot ? (
          <div className="flex shrink-0 items-center justify-between gap-3 border-t border-[hsl(var(--hairline))] px-4 py-2.5">
            {foot}
          </div>
        ) : null}
      </div>
    </div>
  );
}

export function ReleaseConsolePage(): JSX.Element {
  const [params, setParams] = useSearchParams();
  const [projects, setProjects] = useState<ProjectLite[]>([]);
  const [projectId, setProjectId] = useState(params.get('project') || '');
  const [search, setSearch] = useState('');
  const [center, setCenter] = useState<CenterResponse | null>(null);
  const [branches, setBranches] = useState<BranchOption[]>([]);
  const [branchId, setBranchId] = useState('');
  const [targetId, setTargetId] = useState('');
  const [pane, setPane] = useState<RailPane>('history');
  const [sheet, setSheet] = useState<SheetKind>(null);
  /** 受保护环境的二次确认：存住待确认的目标 id，null 表示没有待确认动作。 */
  const [confirmTargetId, setConfirmTargetId] = useState<string | null>(null);
  const [rowBusy, setRowBusy] = useState('');
  const [run, setRun] = useState<ReleaseRun | null>(null);
  const [logs, setLogs] = useState<ReleaseLogEntry[]>([]);
  const [preflight, setPreflight] = useState<PreflightResult | null>(null);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [toast, setToast] = useState('');
  const [following, setFollowing] = useState(true);
  const logRef = useRef<HTMLPreElement>(null);

  const say = useCallback((message: string) => {
    setToast(message);
    window.setTimeout(() => setToast((current) => (current === message ? '' : current)), 2600);
  }, []);

  /* ── 载入 ─────────────────────────────────────────────── */
  useEffect(() => {
    apiRequest<{ projects?: ProjectLite[] }>('/api/projects')
      .then((res) => {
        const list = res.projects || [];
        setProjects(list);
        setProjectId((current) => current || list[0]?.id || '');
      })
      .catch((err) => setError(err instanceof ApiError ? err.message : String(err)));
  }, []);

  const loadCenter = useCallback(async (): Promise<void> => {
    if (!projectId) return;
    try {
      const res = await apiRequest<CenterResponse>(`/api/releases/center?project=${encodeURIComponent(projectId)}`);
      setCenter(res);
      setError('');
      // 只在当前选中项消失时清空，让 resolveSelectedTargetId 去挑；这里别自己挑 rows[0]。
      setTargetId((current) => (res.rows.some((item) => item.target.id === current) ? current : ''));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    }
  }, [projectId]);

  useEffect(() => { void loadCenter(); }, [loadCenter]);

  useEffect(() => {
    if (!projectId) return;
    setParams((current) => {
      const next = new URLSearchParams(current);
      next.set('project', projectId);
      return next;
    }, { replace: true });
    apiRequest<{ branches: BranchOption[] }>(`/api/branches?project=${encodeURIComponent(projectId)}&live=false`)
      .then((res) => {
        const list = res.branches || [];
        setBranches(list);
        setBranchId((current) => (list.some((b) => b.id === current) ? current : list[0]?.id || ''));
      })
      .catch(() => setBranches([]));
  }, [projectId, setParams]);

  /* ── 实时：订阅当前 run 的 SSE ─────────────────────────── */
  useEffect(() => {
    if (!run || isReleaseTerminal(run.status)) return undefined;
    const source = new EventSource(
      apiUrl(`/api/releases/runs/${encodeURIComponent(run.releaseId)}/stream?afterSeq=${logs.at(-1)?.seq || 0}`),
    );
    source.addEventListener('snapshot', (event) => {
      const data = parseSse<{ run: ReleaseRun }>(event as MessageEvent);
      if (!data?.run) return;
      setRun(data.run);
      setLogs(dedupeLogs(data.run.logs || []));
    });
    source.addEventListener('release.log', (event) => {
      const data = parseSse<{ log: ReleaseLogEntry }>(event as MessageEvent);
      if (!data?.log) return;
      setLogs((current) => dedupeLogs([...current, data.log]));
    });
    source.addEventListener('release.status', (event) => {
      const data = parseSse<{ run: ReleaseRun }>(event as MessageEvent);
      if (!data?.run) return;
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
  const nowMs = useNowTick(inFlight);

  const shown = run || row?.latestRun;
  const shownLogs = run ? logs : (shown?.logs || []);
  const progress = resolveReleaseSteps(shown);
  const failed = shown ? isReleaseFailed(shown.status) : false;
  const running = Boolean(shown && !isReleaseTerminal(shown.status));
  const diagnosis = failed ? diagnoseReleaseFailure(shownLogs) : null;
  const branch = branches.find((item) => item.id === branchId);
  const commitSha = branch?.commitSha || branch?.githubCommitSha || '';
  /*
   * 发布来源地址：只认后端下发的 previewUrl / previewUrls，取不到就是空串。
   * 空串不是「随便填填」——它会被发布前检查的「可发布产物」那一项拦下；
   * 而编一个域名出来会一路传成部署脚本里的 CDS_PREVIEW_URL，指向没有东西监听的地方。
   */
  const sourceUrls = resolveReleaseSourceUrls({ branch });
  const previewUrl = sourceUrls[0] || '';
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
  const awaitingConfirm = Boolean(row && confirmTargetId === row.target.id);

  const filteredProjects = projects.filter((item) => {
    const q = search.trim().toLowerCase();
    if (!q) return true;
    return `${item.id} ${item.name || ''} ${item.githubRepoFullName || ''}`.toLowerCase().includes(q);
  });

  /* ── 动作 ─────────────────────────────────────────────── */
  const startRelease = async (): Promise<void> => {
    if (!row || !branchId) return;
    setBusy('deploy');
    setPreflight(null);
    try {
      const res = await apiRequest<{ run: ReleaseRun }>(
        `/api/releases/branches/${encodeURIComponent(branchId)}/runs`,
        { method: 'POST', body: { targetId: row.target.id, previewUrl } },
      );
      setRun(res.run);
      setLogs(dedupeLogs(res.run.logs || []));
      setFollowing(true);
      void loadCenter();
    } catch (err) {
      say(err instanceof ApiError ? err.message : String(err));
    } finally {
      setBusy('');
    }
  };

  const runPreflight = async (): Promise<void> => {
    if (!row || !branchId) return;
    setBusy('preflight');
    try {
      const res = await apiRequest<PreflightResult>(
        `/api/releases/branches/${encodeURIComponent(branchId)}/preflight`,
        { method: 'POST', body: { targetId: row.target.id, previewUrl } },
      );
      setPreflight(res);
    } catch (err) {
      say(err instanceof ApiError ? err.message : String(err));
    } finally {
      setBusy('');
    }
  };

  const cancelRun = async (): Promise<void> => {
    if (!shown) return;
    setBusy('cancel');
    try {
      await apiRequest(`/api/releases/runs/${encodeURIComponent(shown.releaseId)}/cancel`, { method: 'POST' });
      void loadCenter();
    } catch (err) {
      say(err instanceof ApiError ? err.message : String(err));
    } finally {
      setBusy('');
    }
  };

  /** 重发这一版：后端 retry 用源 run 的 branch/target/产物地址重开一次，前端不重算参数。 */
  const retryRun = async (item: ReleaseRun): Promise<void> => {
    setRowBusy(item.releaseId);
    try {
      const res = await apiRequest<{ run: ReleaseRun }>(
        `/api/releases/runs/${encodeURIComponent(item.releaseId)}/retry`,
        { method: 'POST' },
      );
      setRun(res.run);
      setLogs(dedupeLogs(res.run.logs || []));
      setTargetId(res.run.targetId);
      setFollowing(true);
      void loadCenter();
    } catch (err) {
      say(err instanceof ApiError ? err.message : String(err));
    } finally {
      setRowBusy('');
    }
  };

  /**
   * 回滚：不传 targetReleaseId，由后端选该目标上一个成功版本。
   * 这一页刻意不提供「回滚到任意一版」——那需要选版对话框与影响面说明，
   * 属于发布中心的职责，两处各做一半只会让人不知道该信哪个。
   */
  const rollbackRun = async (item: ReleaseRun): Promise<void> => {
    setRowBusy(item.releaseId);
    try {
      const res = await apiRequest<{ run: ReleaseRun }>(
        `/api/releases/runs/${encodeURIComponent(item.releaseId)}/rollback`,
        { method: 'POST' },
      );
      setRun(res.run);
      setLogs(dedupeLogs(res.run.logs || []));
      setTargetId(res.run.targetId);
      setFollowing(true);
      void loadCenter();
    } catch (err) {
      say(err instanceof ApiError ? err.message : String(err));
    } finally {
      setRowBusy('');
    }
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
  const statusTitle = !shown ? '待发布'
    : running ? '发布中'
    : failed ? '发布失败'
    : shown.status === 'success' || shown.status === 'rollback_success' ? '发布成功'
    : shown.status;

  const tone = !shown ? 'muted' : running ? 'warn' : failed ? 'bad' : 'ok';
  const toneRing = tone === 'bad'
    ? 'border-red-500/30 bg-red-500/[0.06]'
    : tone === 'ok'
      ? 'border-emerald-500/30 bg-emerald-500/[0.05]'
      : tone === 'warn'
        ? 'border-primary/30 bg-primary/[0.06]'
        : 'border-[hsl(var(--hairline))]';

  return (
    <AppShell
      active="release-center"
      wide
      topbar={(
        <TopBar
          left={<Crumb items={[{ label: 'CDS', href: '/project-list' }, { label: '发布中心', href: '/release-center' }, { label: '发布控制台' }]} />}
          right={(
            <>
              <span className="hidden items-center gap-2 rounded-full border border-[hsl(var(--hairline))] px-2.5 py-1 text-xs text-muted-foreground md:inline-flex">
                <span className={`h-1.5 w-1.5 rounded-full ${inFlight ? 'bg-primary' : 'bg-muted-foreground/60'}`} />
                {inFlight && liveRow
                  ? `发布中 · ${liveRow.target.name}`
                  : '发布通道空闲'}
              </span>
              <Button variant="outline" size="sm" onClick={() => void loadCenter()}>
                <RefreshCw />
                刷新
              </Button>
            </>
          )}
        />
      )}
    >
      <Workspace wide>
        {/* 移动端整页自然流；lg 起切回三栏填满，各栏自己滚 */}
        <div
          className="flex h-full min-h-0 flex-col gap-4 overflow-y-auto lg:grid lg:grid-cols-[264px_minmax(0,1fr)_348px] lg:gap-4 lg:overflow-hidden"
          style={{ overscrollBehavior: 'contain' }}
        >
          {/* ══ 左栏：项目 + 环境 ══ */}
          {/* 窄屏把顺序翻过来：用户来这一页第一眼要看的是「现在成没成」，
              不是项目列表。桌面三栏不受影响（order 只在 max-lg 生效）。 */}
          <aside className="cds-surface-raised cds-hairline flex min-h-0 flex-col rounded-lg max-lg:order-2 lg:overflow-hidden">
            <div className="shrink-0 border-b border-[hsl(var(--hairline))] p-3">
              <div className="mb-2 flex items-center justify-between">
                <span className="text-xs font-semibold uppercase tracking-normal text-muted-foreground">Projects</span>
                <span className="cds-ident text-[11px] text-muted-foreground">{projects.length} 个</span>
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

            {/* 项目列表按内容占高（多了才滚），环境块紧跟其后 —— 钉底会在项目少时
                在两块之间挖出一个大洞，看着像没做完。空白留在最下面才读作「还能长」。 */}
            <div className="min-h-0 shrink overflow-y-auto p-2 max-lg:max-h-[38vh] lg:max-h-[46%]" style={{ overscrollBehavior: 'contain' }}>
              {filteredProjects.length === 0 ? (
                <p className="p-3 text-xs text-muted-foreground">没有匹配的项目。</p>
              ) : filteredProjects.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  aria-pressed={item.id === projectId}
                  onClick={() => { setProjectId(item.id); setRun(null); setLogs([]); setPreflight(null); }}
                  className={`mb-1 flex w-full flex-col gap-1 rounded-md px-3 py-2.5 text-left transition-colors ${
                    item.id === projectId
                      ? 'border border-primary/40 bg-primary/[0.08]'
                      : 'border border-transparent hover:bg-[hsl(var(--surface-sunken))]'
                  }`}
                >
                  <span className={`truncate text-[13px] font-medium ${item.id === projectId ? 'text-primary' : ''}`}>
                    {item.name || item.id}
                  </span>
                  <span className="truncate cds-ident text-xs text-muted-foreground">
                    {item.githubRepoFullName || item.id}
                  </span>
                </button>
              ))}
            </div>

            <div className="min-h-0 shrink-0 border-t border-[hsl(var(--hairline))] p-3">
              <div className="mb-2 flex items-center justify-between gap-2">
                <span className="text-xs font-semibold uppercase tracking-normal text-muted-foreground">Environments</span>
                <span className="cds-ident text-[11px] text-muted-foreground">{rows.length} 个</span>
              </div>
              {rows.length === 0 ? (
                <p className="text-xs text-muted-foreground">这个项目还没有发布目标，去发布中心添加环境。</p>
              ) : (
                <div className="flex max-h-[34vh] flex-col gap-2 overflow-y-auto lg:max-h-[42vh]" style={{ overscrollBehavior: 'contain' }}>
                  {envSections.map((section) => (
                    <div key={section.environment} className="flex flex-col gap-1.5">
                      {/* 后端没下发分组时 buildEnvironmentSections 退化成单组，此时不画组标题 */}
                      {section.degraded ? null : (
                        <span className="px-0.5 text-[11.5px] text-muted-foreground">{section.label}</span>
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
                            onClick={() => {
                              setTargetId(item.target.id);
                              setRun(null); setLogs([]); setPreflight(null); setConfirmTargetId(null);
                            }}
                            className={`flex items-center gap-2.5 rounded-md border px-3 py-2 text-left ${
                              selected
                                ? 'border-primary/40 bg-primary/[0.08]'
                                : 'border-[hsl(var(--hairline))] bg-[hsl(var(--surface-sunken))]/50 hover:border-[hsl(var(--hairline-strong))]'
                            } ${item.target.isEnabled ? '' : 'opacity-60'}`}
                          >
                            <span
                              className={`h-1.5 w-1.5 shrink-0 rounded-full ${
                                item.healthStatus === 'healthy' ? 'bg-emerald-500'
                                  : item.healthStatus === 'failed' ? 'bg-red-500' : 'bg-muted-foreground/60'
                              }`}
                            />
                            <span className="min-w-0 flex-1">
                              <span
                                title={item.target.name}
                                className={`block truncate text-[12.5px] font-medium ${selected ? 'text-primary' : ''}`}
                              >
                                {item.target.name}
                                {entry.isCanonical && section.entries.length > 1 ? (
                                  <span className="ml-1.5 text-[11px] font-normal text-muted-foreground">主</span>
                                ) : null}
                              </span>
                              <span className="block truncate cds-ident text-xs text-muted-foreground">
                                {item.target.ssh?.host || item.target.type}
                                {item.currentCommit ? ` · ${item.currentCommit.slice(0, 7)}` : ' · 未发布'}
                              </span>
                            </span>
                            {/* 落后主干几个提交由后端 commitPosition 给；算不出时它缺席，这里就不显示 */}
                            {typeof behind === 'number' && behind > 0 ? (
                              <span className="shrink-0 rounded bg-amber-500/15 px-1.5 py-0.5 cds-ident text-[11px] font-medium text-amber-600 dark:text-amber-400">
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
          <main className="flex min-h-0 flex-col gap-3 max-lg:order-1 lg:overflow-hidden">
            {error ? (
              <div className="flex items-center gap-2 rounded-lg border border-red-500/30 bg-red-500/[0.07] px-3 py-2 text-sm text-red-600 dark:text-red-400">
                <AlertTriangle className="h-4 w-4 shrink-0" />
                <span className="min-w-0 break-words">{error}</span>
              </div>
            ) : null}

            {/* 版本选在状态之上：先定「发哪一版」，再看「发得怎么样」。 */}
            <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-2">
              <span className="shrink-0 text-xs font-semibold uppercase tracking-normal text-muted-foreground">要发布的版本</span>
              <select
                value={branchId}
                onChange={(event) => { setBranchId(event.target.value); setConfirmTargetId(null); }}
                className="cds-ident h-8 max-w-[min(560px,50vw)] rounded-md border border-[hsl(var(--hairline))] bg-[hsl(var(--surface-sunken))] px-2 text-[13px] outline-none"
              >
                {branches.length === 0 ? <option value="">没有可发布的分支</option> : null}
                {branches.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.branch}
                    {item.commitSha ? ` · ${item.commitSha.slice(0, 7)}` : ''}
                    {commitMeta[item.commitSha || '']?.subject ? ` · ${commitMeta[item.commitSha || ''].subject}` : ''}
                  </option>
                ))}
              </select>
              {/* 对照与来源都放第二行：跟 select 抢同一行的剩余宽度，窄屏必被截成「替换线上…」 */}
              <span className="min-w-0 basis-full text-[11.5px] text-muted-foreground">
                {row && commitSha
                  ? (commitSha.slice(0, 7) === (row.currentCommit || '').slice(0, 7)
                    ? '与线上同版'
                    : `替换线上的 ${row.currentCommit ? row.currentCommit.slice(0, 7) : '（未发布）'}`)
                  : ''}
                {isProtected ? ' · 受保护环境需二次确认' : ''}
                <span className="ml-2 cds-ident text-xs">
                  · 来源 {previewUrl || '取不到预览地址，试跑会拦下这一项'}
                  {sourceUrls.length > 1 ? ` 等 ${sourceUrls.length} 个入口` : ''}
                </span>
              </span>
            </div>

            <section className={`cds-surface-raised shrink-0 rounded-lg border p-4 ${toneRing}`}>
              <div className="flex flex-wrap items-center gap-4">
                <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl border border-[hsl(var(--hairline))] bg-[hsl(var(--surface-sunken))]">
                  {running ? <Loader2 className="h-5 w-5 animate-spin text-primary" />
                    : failed ? <XCircle className="h-5 w-5 text-red-500" />
                    : shown ? <CheckCircle2 className="h-5 w-5 text-emerald-500" />
                    : <Rocket className="h-5 w-5 text-muted-foreground" />}
                </div>

                <div className="min-w-0 flex-1 basis-[280px]">
                  <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                    <h2 className={`text-xl font-bold ${failed ? 'text-red-600 dark:text-red-400' : running ? 'text-primary' : ''}`}>
                      {statusTitle}
                    </h2>
                    <span className="min-w-0 truncate text-[13px] text-muted-foreground">
                      {row ? (
                        <>
                          <span className="cds-ident font-medium text-foreground/80">{row.target.name}</span>
                          {shown ? <span className="cds-ident font-medium"> · {shown.commitSha.slice(0, 7)}</span> : null}
                          {!shown && row.currentCommit ? <span className="cds-ident font-medium"> · 当前 {row.currentCommit.slice(0, 7)}</span> : null}
                          {typeof row.commitPosition?.behindCount === 'number' && row.commitPosition.behindCount > 0
                            ? `，落后主干 ${row.commitPosition.behindCount} 个提交`
                            : ''}
                        </>
                      ) : '选择一个环境'}
                    </span>
                  </div>
                  <div className="mt-2 h-0.5 w-full overflow-hidden rounded bg-[hsl(var(--hairline))]">
                    <div
                      className={`h-full transition-[width] duration-500 ${failed ? 'bg-red-500' : running ? 'bg-primary' : 'bg-emerald-500'}`}
                      style={{ width: `${progress.steps.length ? Math.round((progress.steps.filter((s) => s.state === 'done').length / progress.steps.length) * 100) : 0}%` }}
                    />
                  </div>
                  <div className="mt-2 flex flex-wrap justify-between gap-x-4 gap-y-1 cds-ident text-xs text-muted-foreground">
                    <span>
                      {progress.steps.filter((s) => s.state === 'done').length}/{progress.steps.length || 0} 步骤
                      {shown ? ` · ${formatDateTime(shown.startedAt)}` : row?.currentCommit ? ` · 线上 ${row.currentCommit.slice(0, 7)}` : ''}
                    </span>
                    <span>
                      {etaText || (shown ? formatDuration(shown.startedAt, shown.finishedAt) || '进行中' : '未开始')}
                    </span>
                  </div>
                </div>

                <div className="flex w-full flex-wrap gap-2 sm:w-auto sm:shrink-0">
                  {/* 受保护环境走两段式：第一下只是把按钮换成「确认发布到 X」，第二下才真发。
                      不用 window.confirm —— 那东西在窄屏和无障碍上都不好使，也没法说清发的是哪一版。 */}
                  <Button
                    onClick={() => {
                      if (!row) return;
                      if (isProtected && !awaitingConfirm) { setConfirmTargetId(row.target.id); return; }
                      setConfirmTargetId(null);
                      void startRelease();
                    }}
                    disabled={!row || !branchId || running || blockedByOther || busy === 'deploy'}
                    className={awaitingConfirm ? 'ring-2 ring-red-500/60' : undefined}
                  >
                    {busy === 'deploy' ? <Loader2 className="animate-spin" /> : <Rocket />}
                    {awaitingConfirm
                      ? `确认发布到 ${row?.target.name}`
                      : row ? `发布到 ${row.target.name}` : '开始发布'}
                  </Button>
                  {awaitingConfirm ? (
                    <Button variant="ghost" onClick={() => setConfirmTargetId(null)}>取消</Button>
                  ) : null}
                  <Button variant="outline" onClick={() => void runPreflight()} disabled={!row || !branchId || running || busy === 'preflight'}>
                    {busy === 'preflight' ? <Loader2 className="animate-spin" /> : null}
                    试跑
                  </Button>
                  <Button variant="outline" onClick={() => void cancelRun()} disabled={!running || busy === 'cancel'}>
                    <Ban />
                    中止
                  </Button>
                </div>
              </div>
            </section>

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
            {stall.stalled ? (
              <div className="flex shrink-0 flex-wrap items-center gap-2 rounded-lg border border-amber-500/40 bg-amber-500/[0.08] px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
                <Clock className="h-3.5 w-3.5 shrink-0" />
                <span className="min-w-0 flex-1 basis-full sm:basis-0">
                  已经 {Math.round(stall.silentMs / 1000)} 秒没有新输出了。
                  发布还没结束，可能是这一步本身慢，也可能是执行端卡住——可以先取证再决定要不要中止。
                </span>
                <Button variant="outline" size="sm" onClick={() => setSheet('agent')}>
                  <Clipboard />
                  取证给智能体
                </Button>
                <Button variant="outline" size="sm" onClick={() => void cancelRun()} disabled={busy === 'cancel'}>
                  <Ban />
                  中止
                </Button>
              </div>
            ) : null}

            {/* 终态结论条：跑完了给一句话 + 就地能做的下一步，不用去右栏翻记录。 */}
            {shown && !running ? (
              <div className={`flex shrink-0 flex-wrap items-center gap-2 rounded-lg border px-3 py-2 text-xs ${
                failed
                  ? 'border-red-500/30 bg-red-500/[0.06] text-red-600 dark:text-red-400'
                  : 'border-emerald-500/30 bg-emerald-500/[0.06] text-emerald-700 dark:text-emerald-400'
              }`}>
                {failed ? <XCircle className="h-3.5 w-3.5 shrink-0" /> : <CheckCircle2 className="h-3.5 w-3.5 shrink-0" />}
                <span className="min-w-0 flex-1 basis-full break-words sm:basis-0">
                  {failed
                    ? (diagnosis?.headline || '本次发布失败，日志里没能提取出结构化判据')
                    : `${row?.target.name || '目标'}已切到 ${shown.commitSha.slice(0, 7)}${
                      formatDuration(shown.startedAt, shown.finishedAt) ? `，用时 ${formatDuration(shown.startedAt, shown.finishedAt)}` : ''}`}
                </span>
                {failed ? (
                  <>
                    <Button variant="outline" size="sm" onClick={() => setSheet('agent')}>
                      <Clipboard />
                      交给智能体
                    </Button>
                    <Button variant="outline" size="sm" onClick={() => void retryRun(shown)} disabled={rowBusy === shown.releaseId}>
                      {rowBusy === shown.releaseId ? <Loader2 className="animate-spin" /> : <RotateCcw />}
                      重发这一版
                    </Button>
                  </>
                ) : null}
                {!failed && row?.canRollback ? (
                  <Button variant="outline" size="sm" onClick={() => void rollbackRun(shown)} disabled={rowBusy === shown.releaseId}>
                    {rowBusy === shown.releaseId ? <Loader2 className="animate-spin" /> : <RotateCcw />}
                    回滚
                  </Button>
                ) : null}
              </div>
            ) : null}

            {preflight ? (
              <div className="cds-surface-raised cds-hairline shrink-0 rounded-lg border p-3">
                <div className="mb-2 flex items-center justify-between gap-2">
                  <span className="text-xs font-semibold">试跑结果 · 只检查未发布</span>
                  <Chip tone={preflight.checks.some((c) => c.status === 'fail' && c.blocking) ? 'bad' : 'ok'}>
                    {preflight.checks.filter((c) => c.status === 'fail').length > 0
                      ? `${preflight.checks.filter((c) => c.status === 'fail').length} 项未通过`
                      : '全部通过'}
                  </Chip>
                </div>
                <ul className="flex flex-col gap-1">
                  {preflight.checks.map((check, index) => (
                    <li key={check.id || check.name || index} className="flex items-start gap-2 text-[11.5px]">
                      <span className={`mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full ${check.status === 'fail' ? 'bg-red-500' : check.status === 'warn' ? 'bg-amber-500' : 'bg-emerald-500'}`} />
                      <span className="min-w-0 break-words">
                        {check.label || check.name || check.id}
                        {check.detail ? <span className="text-muted-foreground"> · {check.detail}</span> : null}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}

            <div className="grid min-h-0 flex-1 gap-3 lg:grid-cols-[288px_minmax(0,1fr)]">
              {/* self-start：步骤条按内容收高，不撑成一个八成留白的高盒子 */}
              <section className="cds-surface-raised cds-hairline flex min-h-0 flex-col overflow-hidden rounded-lg border lg:max-h-full lg:self-start">
                <div className="flex shrink-0 items-center justify-between gap-2 border-b border-[hsl(var(--hairline))] px-3 py-2.5">
                  <span className="text-xs font-semibold uppercase tracking-normal text-muted-foreground">Pipeline</span>
                  <span className="flex items-center gap-2">
                    <span className="cds-ident text-[11px] text-muted-foreground">
                      {progress.steps.filter((s) => s.state === 'done').length}/{progress.steps.length} 步骤
                    </span>
                    <button
                      type="button"
                      onClick={() => setSheet('pipeline')}
                      className="cds-ident text-[11px] text-muted-foreground hover:text-primary"
                    >
                      看流水线
                    </button>
                  </span>
                </div>
                <div className="min-h-0 flex-1 overflow-y-auto p-1.5 max-lg:max-h-64" style={{ overscrollBehavior: 'contain' }}>
                  {progress.steps.map((step) => (
                    <div
                      key={step.id}
                      className={`flex items-start gap-2.5 rounded-md px-2.5 py-2.5 ${
                        step.state === 'failed' ? 'bg-red-500/[0.08]' : step.state === 'running' ? 'bg-primary/[0.08]' : ''
                      }`}
                    >
                      <span className="mt-0.5 shrink-0">
                        {step.state === 'done' ? <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500" />
                          : step.state === 'failed' ? <XCircle className="h-3.5 w-3.5 text-red-500" />
                          : step.state === 'running' ? <Loader2 className="h-3.5 w-3.5 animate-spin text-primary" />
                          : <span className="ml-0.5 block h-2.5 w-2.5 rounded-full border border-[hsl(var(--hairline-strong))]" />}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className={`block truncate text-xs ${step.state === 'pending' ? 'text-muted-foreground' : ''}`}>{step.label}</span>
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
                    <p className="px-2.5 pt-1 text-[11.5px] text-muted-foreground">历史记录，仅按日志还原大致阶段。</p>
                  ) : null}
                </div>
              </section>

              <section className="cds-hairline flex min-h-0 flex-col overflow-hidden rounded-lg border bg-[hsl(var(--surface-sunken))]">
                <div className="flex shrink-0 items-center justify-between gap-2 border-b border-[hsl(var(--hairline))] px-3 py-2">
                  <span className="text-xs font-semibold uppercase tracking-normal text-muted-foreground">Live output</span>
                  <span className="flex items-center gap-2">
                    <span className="cds-ident text-[11px] text-muted-foreground">{shownLogs.length} 行</span>
                    <Button variant="outline" size="sm" onClick={() => setFollowing((current) => !current)}>
                      {following ? '跟随最新' : '已暂停跟随'}
                    </Button>
                    {/* 现场就在这一屏，取证入口也该在这一屏，不用绕去右栏 */}
                    <Button variant="outline" size="sm" onClick={() => setSheet('agent')} disabled={!shown}>
                      <Clipboard />
                      交给智能体
                    </Button>
                  </span>
                </div>
                <pre
                  ref={logRef}
                  onScroll={(event) => {
                    const node = event.currentTarget;
                    const atBottom = node.scrollHeight - node.scrollTop - node.clientHeight < 40;
                    if (!atBottom && following) setFollowing(false);
                  }}
                  className="m-0 min-h-0 flex-1 overflow-auto whitespace-pre-wrap break-words p-3 cds-ident text-[12.5px] leading-relaxed max-lg:max-h-72"
                  style={{ overscrollBehavior: 'contain' }}
                >
                  {shownLogs.length === 0
                    ? '还没有输出。点「开始发布」后，这里会逐行滚动。'
                    : shownLogs.map((log) => `[${formatClock(log.at)}] ${log.level.toUpperCase()} ${log.message}`).join('\n')}
                </pre>
              </section>
            </div>
          </main>

          {/* ══ 右栏：只放「看记录」。配置与 Agent 走全屏浮层 ══ */}
          {/* 348px 的窄栏装不下发布流水线和一整段任务文本 —— 塞进来就是逼人在
              一条窄缝里横向读命令。这两块改成浮层，右栏专心做记录。 */}
          <aside className="cds-surface-raised cds-hairline flex min-h-0 flex-col rounded-lg max-lg:order-3 lg:overflow-hidden">
            <div className="flex shrink-0 items-center gap-1 border-b border-[hsl(var(--hairline))] px-2 pt-2">
              {([['history', '历史发布'], ['failed', '失败']] as Array<[RailPane, string]>).map(([key, label]) => (
                <button
                  key={key}
                  type="button"
                  role="tab"
                  aria-selected={pane === key}
                  onClick={() => setPane(key)}
                  className={`-mb-px flex items-center gap-1.5 border-b-2 px-2.5 pb-2.5 pt-1.5 text-xs ${
                    pane === key ? 'border-primary text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground'
                  }`}
                >
                  {label}
                  {key === 'failed' && failedRuns.length > 0 ? (
                    <span className="rounded bg-red-500/15 px-1 cds-ident text-[11px] text-red-600 dark:text-red-400">{failedRuns.length}</span>
                  ) : null}
                </button>
              ))}
              <span className="flex-1" />
              <button
                type="button"
                onClick={() => setSheet('pipeline')}
                className="mb-1.5 rounded px-2 py-1 text-[11px] text-muted-foreground hover:text-primary"
              >
                流水线
              </button>
              <button
                type="button"
                onClick={() => setSheet('agent')}
                className="mb-1.5 rounded px-2 py-1 text-[11px] text-muted-foreground hover:text-primary"
              >
                Agent
              </button>
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto p-3 max-lg:max-h-[420px]" style={{ overscrollBehavior: 'contain' }}>
              {(() => {
                const list = pane === 'failed' ? failedRuns : runsOfProject;
                if (list.length === 0) {
                  return <p className="p-2 text-xs text-muted-foreground">{pane === 'failed' ? '这个项目没有失败记录。' : '这个项目还没有发布记录。'}</p>;
                }
                return (
                  <div className="flex flex-col gap-2">
                    {list.slice(0, 30).map((item) => {
                      const itemRow = rows.find((r) => r.target.id === item.targetId);
                      const itemFailed = isReleaseFailed(item.status);
                      const live = itemRow?.currentVersion === item.releaseId;
                      const itemBusy = rowBusy === item.releaseId;
                      return (
                        <div
                          key={item.releaseId}
                          className={`flex min-w-0 flex-col gap-2 rounded-lg border p-3 ${
                            itemFailed ? 'border-red-500/30 bg-red-500/[0.05]' : 'border-[hsl(var(--hairline))] bg-[hsl(var(--surface-sunken))]/50'
                          }`}
                        >
                          <div className="flex min-w-0 items-baseline justify-between gap-2">
                            <span className="flex min-w-0 items-baseline gap-2">
                              <span className="shrink-0 cds-ident text-[12.5px] font-medium">{item.commitSha.slice(0, 7)}</span>
                              <span className="truncate text-[11.5px] text-muted-foreground">
                                {itemRow?.target.name || item.targetId}
                              </span>
                            </span>
                            <span className={`shrink-0 text-[11px] ${itemFailed ? 'text-red-600 dark:text-red-400' : live ? 'text-primary' : 'text-emerald-600 dark:text-emerald-400'}`}>
                              {itemFailed ? '失败' : live ? '线上' : '成功'}
                            </span>
                          </div>
                          <div className="min-w-0 truncate cds-ident text-xs text-muted-foreground">
                            {item.operator || '-'} · {formatDateTime(item.startedAt)}
                            {formatDuration(item.startedAt, item.finishedAt) ? ` · ${formatDuration(item.startedAt, item.finishedAt)}` : ''}
                          </div>
                          {/* 行内操作：每条记录当场能做的事都在这儿，不用先选中再去别处找按钮 */}
                          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11.5px]">
                            <button
                              type="button"
                              className="text-muted-foreground hover:text-primary"
                              onClick={() => {
                                setRun(item);
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
                                className="text-muted-foreground hover:text-primary"
                                onClick={() => {
                                  setRun(item);
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
                              disabled={itemBusy || inFlight}
                              className="text-muted-foreground hover:text-primary disabled:opacity-40 disabled:hover:text-muted-foreground"
                              onClick={() => void retryRun(item)}
                            >
                              {itemBusy ? '提交中' : '重发这一版'}
                            </button>
                            {!itemFailed && itemRow?.canRollback && !live ? (
                              <button
                                type="button"
                                disabled={itemBusy || inFlight}
                                className="text-muted-foreground hover:text-primary disabled:opacity-40 disabled:hover:text-muted-foreground"
                                onClick={() => void rollbackRun(item)}
                              >
                                回滚到此版本
                              </button>
                            ) : null}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                );
              })()}
            </div>
          </aside>
        </div>

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
                <a className="mx-1 text-primary hover:underline" href="/release-center">发布中心</a>
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
                        <span className="min-w-0 flex-1 truncate text-[12.5px] font-medium">{step.title}</span>
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
                        <p className="mt-1.5 text-[11px] text-muted-foreground">
                          计划模板没有登记这一步的命令。实际执行的脚本见下方「部署命令」与实时输出。
                        </p>
                      )}
                    </li>
                  ))}
                </ol>
              )}
              <dl className="grid grid-cols-[92px_minmax(0,1fr)] gap-x-3 gap-y-2 border-t border-[hsl(var(--hairline))] pt-3 text-xs">
                <dt className="text-[11px] font-semibold uppercase tracking-normal text-muted-foreground">方式</dt>
                <dd className="break-words">{row?.target.strategy?.mode || '项目现有脚本'}</dd>
                <dt className="text-[11px] font-semibold uppercase tracking-normal text-muted-foreground">部署命令</dt>
                <dd className="break-all cds-ident text-xs">{row?.target.strategy?.command || row?.target.ssh?.deployCommand || '未配置'}</dd>
                <dt className="text-[11px] font-semibold uppercase tracking-normal text-muted-foreground">站点目录</dt>
                <dd className="break-all cds-ident text-xs">{row?.target.ssh?.appPath || '未配置'}</dd>
                <dt className="text-[11px] font-semibold uppercase tracking-normal text-muted-foreground">健康检查</dt>
                <dd className="break-all cds-ident text-xs">{row?.target.ssh?.healthcheckUrl || '未配置'}</dd>
                <dt className="text-[11px] font-semibold uppercase tracking-normal text-muted-foreground">回滚</dt>
                <dd className="break-all cds-ident text-xs">{row?.target.ssh?.rollbackCommand || '重新发布上一个成功版本'}</dd>
                <dt className="text-[11px] font-semibold uppercase tracking-normal text-muted-foreground">并发</dt>
                <dd>服务端保证同一目标不并发（冲突返回 409）；跨目标那道锁是本页 UI 策略</dd>
                <dt className="text-[11px] font-semibold uppercase tracking-normal text-muted-foreground">卡住判定</dt>
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
              <pre className="whitespace-pre-wrap break-words rounded-md border border-[hsl(var(--hairline))] bg-[hsl(var(--surface-sunken))] p-3 cds-ident text-[12.5px] leading-relaxed">
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
