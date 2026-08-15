/**
 * 站点发布中心 v2 —— 环境是骨架，不是一堆等权重的配置方框。
 *
 * 这一版按用户三条意见重做：
 *  1. **多环境是一等公民**：顶部 main 版本流水轴画出每个环境停在哪个提交，
 *     左栏是环境列表（不是目标列表）。
 *  2. **删掉「发布候选」这个中间实体**：提升 = 把某环境正在跑的那一版原样发到
 *     另一个环境，一个按钮，走同一个发布接口 + expectedCommitSha 钳制。
 *  3. **页签只分流低频内容**（配置 / 日志与证据 / 自动发布 / 健康监测），
 *     概览页密度按需给足：三格摘要 + 带提交说明的时间线 + 失败行可就地展开诊断。
 *
 * 首屏回答的正好是用户真正关心的三个问题：线上跑哪一版、健不健康、坏了退哪。
 * 发布脚本原文这类低频内容搬进「配置」页签。
 *
 * 布局纪律：桌面 lg 起是 fill（左栏 + 详情各自滚动，产物区 flex-1 填满），
 * < lg 退回自然流（整页竖滚 + 左栏限高），见 cds/.claude/rules/mobile-layout-fallback.md。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { Plus, RefreshCw, Rocket } from 'lucide-react';
import { AppShell, Crumb, PaletteHint, TopBar, Workspace } from '@/components/layout/AppShell';
import { Button } from '@/components/ui/button';
import { ApiError, apiRequest } from '@/lib/api';
import { useNowTick } from '@/hooks/useNowTick';
import {
  initialReleaseCenterProject,
  releaseCenterDeepLink,
  releaseCenterSection,
  normalizeProductionOrigin,
  rememberReleaseCenterProject,
} from '@/lib/releaseCenter';
import type { ReleaseCenterSection } from '@/lib/releaseCenter';
import {
  buildEnvironmentSections,
  canonicalEnvironments,
  defaultIsCanonical,
  resolveSelectedTargetId,
  type EnvironmentSection,
} from '@/lib/releaseEnvironments';
import type { PreviewMode, PreviewUrlConfig } from '@/lib/previewUrl';
import { ErrorBlock, LoadingBlock } from '@/pages/cds-settings/components';
import { ConfigTab } from '@/pages/release-center/ConfigTab';
import {
  ArchiveTargetDialog,
  ReleaseLogDialog,
  RollbackDialog,
  type ArchiveState,
  type RollbackState,
} from '@/pages/release-center/dialogs';
import { EnvironmentSidebar } from '@/pages/release-center/EnvironmentSidebar';
import { OverviewTab } from '@/pages/release-center/OverviewTab';
import { FleetMatrix } from '@/pages/release-center/FleetMatrix';
import { AutoReleaseTab } from '@/pages/release-center/AutoReleaseTab';
import { AutoRulesSection } from '@/pages/release-center/AutoRulesSection';
import { EnvConfigSection } from '@/pages/release-center/EnvConfigSection';
import { HealthSection } from '@/pages/release-center/HealthSection';
import { EvidenceSection } from '@/pages/release-center/EvidenceSection';
import { buildFleetMetrics, buildFleetVerdict, toFleetEnv, type FleetSortKey } from '@/lib/releaseFleet';
import type { TimelineFilter } from '@/pages/release-center/ReleaseTimeline';
import { formatDateTime } from '@/pages/release-center/shared';
import {
  SiteWizardDialog,
  applyDiscoveredStrategy,
  buildHealthcheckUrl,
  emptySiteDraft,
  strategyFromDraft,
} from '@/pages/release-center/SiteWizardDialog';
import { StartReleaseDialog, type StartReleaseIntent } from '@/pages/release-center/StartReleaseDialog';
import type {
  BranchOption,
  CenterResponse,
  CenterRow,
  ProjectLite,
  ReleaseRun,
  ReleaseStrategyDiscovery,
  ReleaseTarget,
  RemoteHostOption,
  SiteDraft,
  TargetsResponse,
  WizardStep,
} from '@/pages/release-center/types';
import { isReleaseTerminal } from '@/pages/release-center/types';

type LoadState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ok'; center: CenterResponse; hosts: RemoteHostOption[] };

/**
 * 分区。照设计稿 design_handoff_release_center 的五段式——它与旧的六个 tab 不是
 * 换名字：旧结构是「先选一个目标，再看它的六个页签」（控制台视角），新结构第一屏
 * 是横着比所有环境的矩阵（治理视角），后四段才落到单个环境上。
 */
type CenterSection = ReleaseCenterSection;

const SECTIONS: Array<{ id: CenterSection; label: string }> = [
  { id: 'fleet', label: '全环境矩阵' },
  { id: 'config', label: '环境与配置' },
  { id: 'rules', label: '自动发布规则' },
  { id: 'health', label: '健康监测' },
  { id: 'evidence', label: '证据归档' },
];

/**
 * 宽屏判定走**实测宽度**而不是媒体查询：设计稿的阈值是 1264px，来源是
 * 「1280 视口减掉滚动条实测 1271」。媒体查询量的是视口，这里量的是内容区，
 * 左侧还有 72px 图标栏——两者对不上会在 1280 那一档抖动。
 */
function useMeasuredWide(threshold = 1264): [React.RefObject<HTMLDivElement>, boolean] {
  const ref = useRef<HTMLDivElement>(null);
  const [wide, setWide] = useState(true);
  useEffect(() => {
    const node = ref.current;
    if (!node) return undefined;
    const apply = (): void => setWide(node.offsetWidth >= threshold);
    apply();
    const observer = new ResizeObserver(apply);
    observer.observe(node);
    return () => observer.disconnect();
  }, [threshold]);
  return [ref, wide];
}

export function ReleaseCenterPage(): JSX.Element {
  const [searchParams, setSearchParams] = useSearchParams();
  const initialProject = initialReleaseCenterProject(
    searchParams,
    typeof window === 'undefined' ? undefined : window.localStorage,
  );
  const [projectId, setProjectId] = useState(initialProject);
  const [projects, setProjects] = useState<ProjectLite[]>([]);
  const [state, setState] = useState<LoadState>({ status: 'loading' });
  const [archivedTargets, setArchivedTargets] = useState<ReleaseTarget[]>([]);
  // 通知深链 `?target=&run=` 指名要看哪个目标的哪次发布。只在首次挂载时取一次：
  // 之后用户在页面里切目标不该被 URL 上的旧参数拽回去。
  const [deepLink] = useState(() => releaseCenterDeepLink(searchParams));
  const [selectedTargetId, setSelectedTargetId] = useState(deepLink.targetId || '');
  const [pendingRunId, setPendingRunId] = useState(deepLink.runId || '');
  // 只有三个参数都在才算一条完整的「批这一版」链接：缺 commit 就没有可钉的版本，
  // 缺 target 就不知道发到哪，此时退回普通深链行为（选中目标即可），不猜。
  const [pendingApproval, setPendingApproval] = useState<
    { targetId: string; branchId: string; commitSha: string } | null
  >(() => (deepLink.targetId && deepLink.branchId && deepLink.commitSha
    ? { targetId: deepLink.targetId, branchId: deepLink.branchId, commitSha: deepLink.commitSha }
    : null));
  const navigate = useNavigate();
  const [section, setSection] = useState<CenterSection>(() => releaseCenterSection(searchParams));
  const [fleetSort, setFleetSort] = useState<FleetSortKey>('severity');
  const [rootRef, wide] = useMeasuredWide();
  const configCardRef = useRef<HTMLDivElement>(null);
  const [historyFilter, setHistoryFilter] = useState<TimelineFilter>('all');
  const [toast, setToast] = useState('');

  const [draft, setDraft] = useState<SiteDraft>(() => emptySiteDraft(initialProject));
  const [wizardStep, setWizardStep] = useState<WizardStep>('server');
  const [wizardOpen, setWizardOpen] = useState(false);
  const [savingSite, setSavingSite] = useState(false);
  const [discovery, setDiscovery] = useState<ReleaseStrategyDiscovery | null>(null);
  const [discovering, setDiscovering] = useState(false);

  const [logRun, setLogRun] = useState<ReleaseRun | null>(null);
  const [rollbackState, setRollbackState] = useState<RollbackState | null>(null);
  const [archiveState, setArchiveState] = useState<ArchiveState | null>(null);
  const [archiving, setArchiving] = useState(false);
  const [retryingRunId, setRetryingRunId] = useState('');
  const [promoting, setPromoting] = useState(false);
  const [releaseIntent, setReleaseIntent] = useState<StartReleaseIntent | null>(null);

  const [branches, setBranches] = useState<BranchOption[]>([]);
  const [branchesLoading, setBranchesLoading] = useState(false);
  const [previewMode, setPreviewMode] = useState<PreviewMode | undefined>(undefined);
  const [previewConfig, setPreviewConfig] = useState<PreviewUrlConfig>({});

  const load = useCallback(async (opts?: { silent?: boolean }) => {
    // silent：后台轮询用——不闪 loading 骨架，数据到了原地替换（变化可感知但不清屏）。
    if (!opts?.silent) setState({ status: 'loading' });
    try {
      const [center, targets] = await Promise.all([
        apiRequest<CenterResponse>(`/api/releases/center?project=${encodeURIComponent(projectId)}`),
        apiRequest<TargetsResponse>(`/api/releases/targets?project=${encodeURIComponent(projectId)}`),
      ]);
      setState({ status: 'ok', center, hosts: targets.remoteHosts || [] });
      setArchivedTargets(targets.archivedTargets || []);
    } catch (err) {
      if (!opts?.silent) setState({ status: 'error', message: err instanceof ApiError ? err.message : String(err) });
    }
  }, [projectId]);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    rememberReleaseCenterProject(projectId, typeof window === 'undefined' ? undefined : window.localStorage);
  }, [projectId]);

  // 当前分区回写 URL，「我在看这一屏」就能整条链接发给别人（设计稿 Interactions）。
  // replace 而不是 push：切分区不是导航，不该在浏览器后退键上堆五层历史。
  useEffect(() => {
    setSearchParams((current) => {
      if (releaseCenterSection(current) === section) return current;
      const next = new URLSearchParams(current);
      if (section === 'fleet') next.delete('section');
      else next.set('section', section);
      return next;
    }, { replace: true });
  }, [section, setSearchParams]);

  // 项目列表用于「项目」下拉（best-effort，失败退回手输）。
  useEffect(() => {
    let cancelled = false;
    apiRequest<{ projects?: ProjectLite[] }>('/api/projects')
      .then((res) => {
        if (cancelled) return;
        const list = res.projects ?? [];
        setProjects(list);
        // 记忆值（localStorage）来自另一个 CDS 实例或已删除的项目时，它是个幽灵：
        // 拿它去打 /discover 只会换来一串 404，而用户什么也没做错。
        // 有真实项目就落到第一个，让页面直接可用；一个都没有才走空状态引导。
        if (list.length > 0 && !list.some((project) => project.id === projectId)) {
          setProjectId(list[0].id);
          setSelectedTargetId('');
          setDraft((current) => ({ ...current, projectId: list[0].id }));
        }
      })
      .catch(() => { if (!cancelled) setProjects([]); });
    return () => { cancelled = true; };
  }, []);

  // 就地发布需要分支与预览地址推导所需的配置。三个请求都是 best-effort：
  // 任何一个失败都不该拦住这一页——推导不出预览地址时交给发布前检查说话。
  useEffect(() => {
    let cancelled = false;
    setBranchesLoading(true);
    void Promise.allSettled([
      apiRequest<{ branches: BranchOption[] }>(`/api/branches?project=${encodeURIComponent(projectId)}&live=false`),
      apiRequest<{ mode?: PreviewMode }>(`/api/projects/${encodeURIComponent(projectId)}/preview-mode`),
      apiRequest<PreviewUrlConfig>('/api/config'),
    ]).then(([branchesResult, modeResult, configResult]) => {
      if (cancelled) return;
      setBranches(branchesResult.status === 'fulfilled' ? (branchesResult.value.branches || []) : []);
      setPreviewMode(modeResult.status === 'fulfilled' ? modeResult.value.mode : undefined);
      setPreviewConfig(configResult.status === 'fulfilled' ? configResult.value : {});
      setBranchesLoading(false);
    });
    return () => { cancelled = true; };
  }, [projectId]);

  const center = state.status === 'ok' ? state.center : undefined;
  const rows = useMemo(() => center?.rows ?? [], [center]);
  const runs = useMemo(() => center?.runs ?? [], [center]);
  const commitMeta = useMemo(() => center?.commitMeta ?? {}, [center]);
  const hosts = state.status === 'ok' ? state.hosts : [];
  const rail = center?.commitRail;
  const branchLabel = rail?.branch || 'main';

  const sections: Array<EnvironmentSection<CenterRow>> = useMemo(
    () => buildEnvironmentSections(center?.environments, rows),
    [center?.environments, rows],
  );

  const canonicalEnvs = useMemo(() => canonicalEnvironments(sections), [sections]);

  // 选中态收敛在一处：刷新后「选中的环境自己跳走」是最招人烦的一类闪烁。
  const effectiveTargetId = resolveSelectedTargetId(sections, selectedTargetId);
  useEffect(() => {
    if (effectiveTargetId && effectiveTargetId !== selectedTargetId) setSelectedTargetId(effectiveTargetId);
  }, [effectiveTargetId, selectedTargetId]);

  // 深链点名的那次发布：数据到位后打开它的日志弹窗，然后把 pending 清掉——
  // 只弹一次，用户关掉不该再被弹回来。查不到（run 已被回收）就静默放弃，
  // 不拿一句「找不到」把人挡在页面外。
  useEffect(() => {
    if (!pendingRunId || runs.length === 0) return;
    const target = runs.find((run) => run.releaseId === pendingRunId);
    setPendingRunId('');
    if (target) {
      setSelectedTargetId(target.targetId);
      setLogRun(target);
    }
  }, [pendingRunId, runs]);

  // 待人工确认的深链：`?target=&branch=&commit=`。定时规则跑完预检后不自动发布，
  // 只留一条通知；人点进来必须批准**当时过检的那一版**，所以 commit 钉死在链接里。
  // 不钉的话，几小时后分支已经前进，批准发出去的是另一个从没过检的版本。
  useEffect(() => {
    if (!pendingApproval || rows.length === 0) return;
    const row = rows.find((item) => item.target.id === pendingApproval.targetId);
    setPendingApproval(null);
    if (!row) return;
    setSelectedTargetId(row.target.id);
    setReleaseIntent({
      row,
      branchId: pendingApproval.branchId,
      expectedCommitSha: pendingApproval.commitSha,
      reason: `定时规则已对 ${pendingApproval.commitSha.slice(0, 7)} 跑完发布前检查并等待人工确认。commit 已钉死，即使分支之后又前进，批准发出的仍是通过检查的这一版。`,
    });
  }, [pendingApproval, rows]);

  const selectedRow = rows.find((row) => row.target.id === effectiveTargetId);
  const selectedRuns = useMemo(
    () => runs.filter((run) => run.targetId === effectiveTargetId),
    [runs, effectiveTargetId],
  );
  const otherRows = useMemo(
    () => rows.filter((row) => row.target.id !== effectiveTargetId && row.target.projectId === selectedRow?.target.projectId),
    [rows, effectiveTargetId, selectedRow],
  );

  // 存在非终态 run 时静默轮询到终态：关掉日志弹窗后页面也要自己跟进，
  // 否则环境卡会永远停在「发布中」，失败也无提示。
  const hasActiveRun = rows.some((row) => row.latestRun && !isReleaseTerminal(row.latestRun.status))
    || runs.some((run) => !isReleaseTerminal(run.status));
  useEffect(() => {
    if (!hasActiveRun) return undefined;
    const timer = window.setInterval(() => { void load({ silent: true }); }, 12_000);
    return () => window.clearInterval(timer);
  }, [hasActiveRun, load]);
  // 30 秒一跳，只为让「5 天前 / 距今 18 小时」这类相对时间自己往前走。
  // 秒级精度归各自组件的 useNowTick(inFlight)，不在这一层每秒重渲染整页。
  const nowMs = useNowTick(true, 30_000);

  const runStatusRef = useRef<Record<string, string>>({});
  useEffect(() => {
    if (state.status !== 'ok') return;
    const previous = runStatusRef.current;
    for (const run of runs) {
      const before = previous[run.releaseId];
      if (before && !isReleaseTerminal(before) && isReleaseTerminal(run.status)) {
        setToast(`发布 ${run.releaseId.slice(0, 12)} ${run.status === 'success' ? '成功' : run.status === 'failed' ? '失败' : run.status}`);
      }
    }
    runStatusRef.current = Object.fromEntries(runs.map((run) => [run.releaseId, run.status]));
  }, [state, runs]);

  const openCreateWizard = (): void => {
    const base = emptySiteDraft(projectId);
    const initial = {
      ...base,
      sitePath: `/opt/${projectId}`,
      // 该环境已有主目标就别默认勾主目标：后端会拒，而用户根本没碰过这个勾。
      isCanonical: defaultIsCanonical(base.environment, canonicalEnvs),
    };
    setDraft(initial);
    setWizardStep('server');
    setWizardOpen(true);
    setToast('');
    setDiscovery(null);
    setDiscovering(true);
    apiRequest<ReleaseStrategyDiscovery>(`/api/releases/projects/${encodeURIComponent(projectId)}/discover`, {
      method: 'POST',
      body: {},
    }).then((result) => {
      setDiscovery(result);
      const recommended = result.candidates.find((candidate) => candidate.mode === result.recommendedMode);
      if (recommended) setDraft((current) => applyDiscoveredStrategy(current, recommended.strategy));
    }).catch((err) => {
      // 探测只是「帮你猜发布方式」，猜不到不该变成一条挡在页面顶上的红字。
      // 尤其项目不存在时（换实例/项目已删），裸 404 对用户零信息量。
      const message = err instanceof ApiError ? err.message : String(err);
      setToast(/not found/i.test(message)
        ? `项目 ${projectId} 在这个 CDS 上不存在，发布方式需要手动填写。`
        : `没能自动识别发布方式，可手动填写。原因：${message}`);
    }).finally(() => setDiscovering(false));
  };

  const openConfigureWizard = (target: ReleaseTarget): void => {
    setDraft(draftFromTarget(target));
    setWizardStep('site');
    setWizardOpen(true);
    setToast('');
    setDiscovery(null);
  };

  /**
   * 就地新建服务器后的收尾：刷新列表 + 选中它，向导原地继续。
   *
   * 不能复用 selectHost：它从闭包里的 hosts 找主机，而这台刚创建的还没进列表，
   * 找不到就只写 privateKeyRef、host/user/port 三个字段仍是空的。
   */
  const handleHostCreated = (created: RemoteHostOption): void => {
    // 直接把创建接口返回的这台主机并进列表，**不能**改去重拉 /releases/targets：
    // 那个接口出于项目隔离只返回「已被本项目发布目标引用」的主机（releases.ts 的
    // referencedHostIds），刚建出来的主机还没被任何目标引用，重拉等于查无此人——
    // 于是界面继续说「还没有服务器」，再加一次又撞后端的全局重名校验 409。
    // 真人路径验收当场撞到的就是这条（2026-07-29）。
    setState((current) => (current.status === 'ok'
      ? { ...current, hosts: [...current.hosts.filter((item) => item.id !== created.id), created] }
      : current));
    setDraft((current) => ({
      ...current,
      privateKeyRef: created.id,
      host: created.host || current.host,
      port: String(created.sshPort || 22),
      user: created.sshUser || current.user,
    }));
  };

  const selectHost = (hostId: string): void => {
    const host = hosts.find((item) => item.id === hostId);
    setDraft((current) => ({
      ...current,
      privateKeyRef: hostId,
      host: host?.host || current.host,
      port: host ? String(host.sshPort || 22) : current.port,
      user: host?.sshUser || current.user,
    }));
  };

  const saveSite = async (): Promise<void> => {
    setSavingSite(true);
    setToast('');
    try {
      const body = buildTargetBody(draft, projectId);
      if (draft.id) {
        await apiRequest(`/api/releases/targets/${encodeURIComponent(draft.id)}`, { method: 'PATCH', body });
        setToast('环境配置已更新');
      } else {
        await apiRequest('/api/releases/targets', { method: 'POST', body });
        setToast('环境已添加');
      }
      setWizardOpen(false);
      setDraft(emptySiteDraft(projectId));
      await load();
    } catch (err) {
      setToast(err instanceof ApiError ? err.message : String(err));
    } finally {
      setSavingSite(false);
    }
  };

  const openRollback = (row: CenterRow, sourceRun?: ReleaseRun): void => {
    const run = sourceRun || row.latestRun;
    if (!run) {
      setToast('还没有可回滚的发布记录');
      return;
    }
    if ((row.successfulRuns || []).length === 0) {
      setToast('这个环境还没有可回滚的历史成功版本');
      return;
    }
    setLogRun(null);
    setRollbackState({ row, sourceRun: run });
  };

  const rollback = async (sourceRun: ReleaseRun, targetReleaseId: string): Promise<void> => {
    setToast('');
    try {
      const res = await apiRequest<{ run: ReleaseRun }>(
        `/api/releases/runs/${encodeURIComponent(sourceRun.releaseId)}/rollback`,
        { method: 'POST', body: { targetReleaseId } },
      );
      setLogRun(res.run);
      setRollbackState(null);
      setToast('回滚已开始');
      await load();
    } catch (err) {
      setToast(err instanceof ApiError ? err.message : String(err));
    }
  };

  const retryRelease = async (run: ReleaseRun): Promise<void> => {
    setRetryingRunId(run.releaseId);
    setToast('');
    try {
      const res = await apiRequest<{ run: ReleaseRun }>(`/api/releases/runs/${encodeURIComponent(run.releaseId)}/retry`, { method: 'POST' });
      setLogRun(res.run);
      setToast('重试发布已开始');
      await load();
    } catch (err) {
      setToast(err instanceof ApiError ? err.message : String(err));
    } finally {
      setRetryingRunId('');
    }
  };

  const archiveSite = async (): Promise<void> => {
    if (!archiveState || archiveState.reason.trim().length < 8) return;
    setArchiving(true);
    setToast('');
    try {
      await apiRequest(`/api/releases/targets/${encodeURIComponent(archiveState.row.target.id)}/archive`, {
        method: 'POST',
        body: { reason: archiveState.reason.trim() },
      });
      setArchiveState(null);
      setToast('发布目标已归档，历史发布记录仍然保留');
      await load();
    } catch (err) {
      setToast(err instanceof ApiError ? err.message : String(err));
    } finally {
      setArchiving(false);
    }
  };

  /**
   * 提升：把源环境正在跑的那一版原样发到当前环境。
   * 拿源 run 是为了两件事——它的 branchId（发布接口按分支挂载）和产物预览地址；
   * commit 则由 expectedCommitSha 钉死，杜绝「分支已前进 → 静默发出另一版」。
   */
  const startPromotion = async (row: CenterRow): Promise<void> => {
    if (!row.promotion) return;
    setPromoting(true);
    setToast('');
    try {
      const res = await apiRequest<{ run: ReleaseRun }>(
        `/api/releases/runs/${encodeURIComponent(row.promotion.releaseId)}`,
      );
      const sourceRun = res.run;
      setReleaseIntent({
        row,
        branchId: sourceRun.branchId,
        expectedCommitSha: row.promotion.commitSha,
        previewUrl: sourceRun.artifact?.previewUrl || '',
        reason: `把 ${row.promotion.fromTargetName} 正在跑的 ${row.promotion.commitSha.slice(0, 7)} 原样发到 ${row.target.name}。commit 已钉死，即使分支之后又前进，也不会发出别的版本。`,
      });
    } catch (err) {
      setToast(err instanceof ApiError ? err.message : String(err));
    } finally {
      setPromoting(false);
    }
  };

  /* ── 全环境矩阵的派生值 ─────────────────────────────────────────── */

  const fleetEnvs = useMemo(() => rows.map(toFleetEnv), [rows]);
  const verdict = useMemo(() => buildFleetVerdict(fleetEnvs, nowMs), [fleetEnvs, nowMs]);
  const metrics = useMemo(() => buildFleetMetrics(fleetEnvs), [fleetEnvs]);

  /** 分区角标：只显示能算出来的数，算不出就不显示这个角标。 */
  const sectionBadge = (id: CenterSection): string => {
    if (id === 'fleet') return `${rows.length} 个`;
    if (id === 'health') {
      const unmonitored = fleetEnvs.filter((env) => env.health === 'unmonitored').length;
      return unmonitored > 0 ? `${unmonitored} 未监测` : '';
    }
    return '';
  };

  /* ── 两页之间怎么跳 ─────────────────────────────────────────────────
   *
   * 发布中心「看」，发布控制台「做」。三条规则：
   *
   * 1. 顶栏主按钮进控制台，只带项目 —— 用户还没决定发哪个环境。
   * 2. 矩阵行上的发布 / 提升 / 回滚**带上目标**，控制台落地即选中，不用重选；
   *    回滚再带 intent，让控制台知道用户是来退版本的，由它承接二次确认。
   * 3. 下钻（点行、点判断句里的环境名）**不跳页**，只切到本页的「环境与配置」——
   *    看配置不该把人甩到另一个页面去。
   *
   * 参数一律走 query，不进路径：控制台是一个页面，不是每个环境一个路由。
   */
  const consoleHref = (targetId?: string, intent?: 'rollback'): string => {
    const params = new URLSearchParams();
    if (projectId) params.set('project', projectId);
    if (targetId) params.set('target', targetId);
    if (intent) params.set('intent', intent);
    const query = params.toString();
    return query ? `/release-console?${query}` : '/release-console';
  };

  const inspectEnv = (envId: string): void => {
    setSelectedTargetId(envId);
    setSection('config');
  };

  const executeInConsole = (envId: string, intent: 'deploy' | 'promote' | 'rollback'): void => {
    navigate(consoleHref(envId, intent === 'rollback' ? 'rollback' : undefined));
  };

  return (
    <AppShell
      active="release-center"
      wide
      topbar={(
        <TopBar
          left={(
            <span className="flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-1">
              <Crumb items={[{ label: 'CDS', href: '/project-list' }, { label: '发布中心' }]} />
              <span className="cds-ident text-[11.5px] text-muted-foreground">release center · 环境生命周期</span>
              {/* 项目胶囊：这一页所有数字都在某个项目的语境里，项目必须一眼可见可换。 */}
              {projects.length > 0 ? (
                <select
                  value={projectId}
                  aria-label="项目"
                  onChange={(event) => {
                    const next = event.target.value.trim() || 'default';
                    setProjectId(next);
                    setSelectedTargetId('');
                    setDraft((current) => ({ ...current, projectId: next }));
                  }}
                  className="h-7 max-w-[220px] rounded-full border border-[hsl(var(--hairline))] bg-[hsl(var(--surface-sunken))] px-3 text-[12.5px] outline-none focus:border-[hsl(var(--hairline-strong))]"
                >
                  {!projects.some((project) => project.id === projectId) ? (
                    <option value={projectId}>{projectId}（未知项目）</option>
                  ) : null}
                  {projects.map((project) => (
                    <option key={project.id} value={project.id}>
                      {project.name && project.name !== project.id ? `${project.name}（${project.id}）` : project.id}
                    </option>
                  ))}
                </select>
              ) : null}
            </span>
          )}
          right={(
            <>
              <PaletteHint />
              <Button variant="outline" size="sm" onClick={() => void load()}>
                <RefreshCw />
                刷新
              </Button>
              <Button variant="outline" size="sm" onClick={openCreateWizard}>
                <Plus />
                新建环境
              </Button>
              {/*
                去发布控制台的主入口。发布中心不执行发布——所有「真的要发了」的动作
                都在控制台完成，所以这个按钮是主按钮，不是一条不起眼的链接。
                带上当前项目，进去不用重选。
              */}
              <Button size="sm" asChild>
                <Link to={consoleHref()}>
                  <Rocket />
                  发布控制台
                </Link>
              </Button>
            </>
          )}
        />
      )}
    >
      <Workspace fluid className="cds-workspace--fill cds-workspace--bleed">
        <div ref={rootRef} className="flex h-full min-h-0 flex-col">
          {/* 分区导航。设计稿是 sticky；这一页在 CDS 里是固定外壳 + 内容区内滚，
              导航天然常驻，效果相同而且不会在滚动时抖。 */}
          <nav className="flex shrink-0 flex-wrap items-center gap-1.5 border-b border-[hsl(var(--hairline))] px-6 py-2.5">
            {SECTIONS.map((item) => {
              const badge = sectionBadge(item.id);
              return (
                <button
                  key={item.id}
                  type="button"
                  aria-pressed={section === item.id}
                  onClick={() => setSection(item.id)}
                  className={`flex h-8 items-center gap-1.5 rounded-lg px-3 text-[12.5px] transition-colors duration-150 ${
                    section === item.id
                      ? 'bg-primary/[0.12] font-semibold text-primary'
                      : 'text-muted-foreground hover:bg-[hsl(var(--surface-sunken))]'
                  }`}
                >
                  {item.label}
                  {badge ? <span className="cds-ident text-[10.5px] opacity-70">{badge}</span> : null}
                </button>
              );
            })}
          </nav>

          <div className="min-h-0 flex-1 overflow-y-auto px-6 pb-7 pt-5">
            {toast ? (
              <div className="mb-4 rounded-[10px] border border-[hsl(var(--hairline))] bg-[hsl(var(--surface-sunken))] px-3.5 py-2.5 text-sm">
                {toast}
              </div>
            ) : null}

            {state.status === 'loading' ? <LoadingBlock label="正在加载发布环境" /> : null}
            {state.status === 'error' ? <ErrorBlock message={state.message} /> : null}

            {state.status === 'ok' && rows.length === 0 ? (
              <EmptyEnvironmentsState hostCount={hosts.length} onAdd={openCreateWizard} />
            ) : null}

            {state.status === 'ok' && rows.length > 0 ? (
              <div className="flex flex-col gap-[18px]">
                {/* ══ 监控条：常驻所有分区，页面第一块 ══ */}
                <section className="cds-surface-raised cds-hairline flex flex-wrap items-start gap-4 rounded-[14px] border px-[26px] py-[22px] max-lg:px-4">
                  <div className="flex min-w-0 flex-1 basis-[320px] items-start gap-3">
                    <span
                      className={`mt-2 h-[9px] w-[9px] shrink-0 rounded-full ${
                        verdict.tone === 'bad' ? 'bg-bad cds-verdict-pulse'
                          : verdict.tone === 'warn' ? 'bg-warn cds-verdict-pulse' : 'bg-ok'
                      }`}
                    />
                    <div className="min-w-0">
                      <p className="text-[18px] font-bold leading-[1.45] max-2xl:text-[16.5px] max-lg:text-[15px]">
                        {verdict.segments.map((seg, index) => (seg.envId ? (
                          <button
                            key={`${seg.text}-${index}`}
                            type="button"
                            onClick={() => inspectEnv(seg.envId as string)}
                            className="text-primary underline decoration-dotted underline-offset-4"
                          >
                            {seg.text}
                          </button>
                        ) : (
                          <span key={`${seg.text}-${index}`}>{seg.text}</span>
                        )))}
                      </p>
                      <p className="mt-1.5 cds-ident text-xs text-muted-foreground">
                        数据截至 {formatDateTime(new Date(nowMs).toISOString())} · {verdict.gap}
                      </p>
                    </div>
                  </div>

                  {/* 四个归因指标。算不出的那一块不会出现在数组里，这里不占位。 */}
                  {metrics.length > 0 ? (
                    <div className="flex flex-wrap gap-2 max-lg:basis-full">
                      {metrics.map((metric) => (
                        <div
                          key={metric.key}
                          className="min-w-[132px] flex-1 rounded-[10px] border border-[hsl(var(--hairline))] bg-[hsl(var(--surface-sunken))] px-3 py-2 max-lg:basis-[120px]"
                        >
                          <div className="text-[10.5px] text-muted-foreground">{metric.label}</div>
                          <div className={`cds-ident text-base font-bold ${
                            metric.tone === 'bad' ? 'text-bad'
                              : metric.tone === 'warn' ? 'text-warn' : ''
                          }`}>
                            {metric.value}
                          </div>
                          {/* 名字可截、数字不可截：省略号从尾巴吃起，先吃掉的会是
                              「占 25 次」这半句——而那才是归因句里唯一有信息的部分。 */}
                          <div
                            className="flex items-baseline gap-1 text-[10.5px] text-muted-foreground"
                            title={`${metric.attributionName} ${metric.attributionDetail}`.trim()}
                          >
                            <span className="min-w-0 truncate">{metric.attributionName}</span>
                            {metric.attributionDetail
                              ? <span className="shrink-0">{metric.attributionDetail}</span>
                              : null}
                          </div>
                        </div>
                      ))}
                    </div>
                  ) : null}

                  {verdict.actionEnvId ? (
                    <Button
                      variant="outline"
                      onClick={() => inspectEnv(verdict.actionEnvId as string)}
                      className="h-9 shrink-0 border-bad/40 bg-bad-soft text-bad hover:bg-bad-soft max-lg:w-full"
                    >
                      去处理 {fleetEnvs.find((env) => env.id === verdict.actionEnvId)?.name || verdict.actionEnvId}
                    </Button>
                  ) : null}
                </section>

                {/* ══ 分区一：全环境矩阵 ══ */}
                {section === 'fleet' ? (
                  <FleetMatrix
                    envs={fleetEnvs}
                    sort={fleetSort}
                    onSort={setFleetSort}
                    nowMs={nowMs}
                    wide={wide}
                    onInspect={inspectEnv}
                    onExecute={executeInConsole}
                  />
                ) : null}

                {/* ══ 分区二~五：都落到单个环境上，左边一列选环境 ══ */}
                {section !== 'fleet' ? (
                  <div className={wide ? 'grid grid-cols-[260px_minmax(0,1fr)] items-start gap-4' : 'flex flex-col gap-4'}>
                    <EnvironmentSidebar
                      sections={sections}
                      selectedTargetId={effectiveTargetId}
                      branch={branchLabel}
                      archivedTargets={archivedTargets}
                      nowMs={nowMs}
                      onSelect={(id) => setSelectedTargetId(id)}
                      onAdd={openCreateWizard}
                    />

                    {selectedRow ? (
                      <div className="flex min-w-0 flex-col gap-4">
                        {section === 'config' ? (
                          <div ref={configCardRef} className="flex flex-col gap-4">
                            {/*
                              稿子 §3 只有这张策略表单。这里多留了下面两块，各有实打实的理由：
                              - ConfigTab：接入信息（主机 / 路径 / 脚本原文）与归档入口，
                                策略表单管「怎么发」，它管「这台机器是什么、不要了怎么归档」。
                              - OverviewTab：带 expectedCommitSha 钳制的「提升版本」目前只在这里。
                                矩阵那颗「提升版本」跳的是控制台，而控制台还没实现带钳制的提升——
                                在补上之前删掉它，等于把「分支已前进就拒绝发布」这道保护弄丢。
                              这两块要按稿子拿掉，前置条件是先把带钳制的提升搬进控制台。
                            */}
                            <EnvConfigSection
                              row={selectedRow}
                              onSaved={setToast}
                              onReload={() => void load()}
                            />
                            {/* 只读的接入信息与归档入口留在下面：策略表单管「怎么发」，
                                这一块管「这台机器是什么、不要了怎么归档」，两件事。 */}
                            <ConfigTab
                              row={selectedRow}
                              publicUrl={publicUrlOf(selectedRow)}
                              onConfigure={() => openConfigureWizard(selectedRow.target)}
                              onArchive={() => setArchiveState({ row: selectedRow, reason: '' })}
                            />
                            <OverviewTab
                              row={selectedRow}
                              runs={selectedRuns}
                              commitMeta={commitMeta}
                              branch={branchLabel}
                              nowMs={nowMs}
                              retryingRunId={retryingRunId}
                              promoting={promoting}
                              onPromote={() => void startPromotion(selectedRow)}
                              onOpenLogs={setLogRun}
                              onRetry={(run) => void retryRelease(run)}
                              onRollback={(run) => openRollback(selectedRow, run)}
                              onSeeAll={() => setSection('evidence')}
                              onOpenConfig={() => configCardRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })}
                            />
                          </div>
                        ) : null}

                        {/* 上：稿子 §4 的事件规则（分支 → 环境）。
                            下：既有的定时规则编辑器——定时发布是真实在用的功能，
                            稿子没画不等于可以删掉，它是另一种触发面。 */}
                        {section === 'rules' ? (
                          <div className="flex min-w-0 flex-col gap-4">
                            <AutoRulesSection projectId={projectId} rows={rows} onToast={setToast} />
                            <AutoReleaseTab
                              row={selectedRow}
                              otherRows={otherRows}
                              branches={branches}
                              onToast={setToast}
                            />
                          </div>
                        ) : null}

                        {section === 'health' ? (
                          <HealthSection envs={fleetEnvs} selected={fleetEnvs.find((env) => env.id === selectedRow.target.id)} />
                        ) : null}

                        {/* 稿子 §6 的六列表是唯一的证据表。这里曾经把旧的
                            ReleaseTimeline 也一起渲染，同一批 run 出现两遍——
                            两张表比任意一张都糟。时间线独有的能力（仅失败筛选、
                            看失败原因、回滚到此版本、提交说明）已折进这一张表。 */}
                        {section === 'evidence' ? (
                          <EvidenceSection
                            row={selectedRow}
                            rows={rows}
                            runs={runs}
                            commitMeta={commitMeta}
                            filter={historyFilter === 'failed' ? 'failed' : 'all'}
                            onFilter={setHistoryFilter}
                            retryingRunId={retryingRunId}
                            onRetry={(run) => void retryRelease(run)}
                            onRollback={(run) => openRollback(selectedRow, run)}
                          />
                        ) : null}
                      </div>
                    ) : null}
                  </div>
                ) : null}
              </div>
            ) : null}
          </div>
        </div>
      </Workspace>

      <SiteWizardDialog
        open={wizardOpen}
        draft={draft}
        step={wizardStep}
        hosts={hosts}
        discovery={discovery}
        discovering={discovering}
        saving={savingSite}
        onClose={() => setWizardOpen(false)}
        onStep={setWizardStep}
        onDraft={setDraft}
        onSelectHost={selectHost}
        onHostCreated={handleHostCreated}
        canonicalEnvironments={canonicalEnvs}
        onSave={() => void saveSite()}
      />
      <StartReleaseDialog
        intent={releaseIntent}
        branches={branches}
        branchesLoading={branchesLoading}
        previewMode={previewMode}
        previewConfig={previewConfig}
        commitMeta={commitMeta}
        onClose={() => { setReleaseIntent(null); void load({ silent: true }); }}
        onStarted={() => { void load({ silent: true }); }}
        onToast={setToast}
      />
      <RollbackDialog
        state={rollbackState}
        onClose={() => setRollbackState(null)}
        onConfirm={(sourceRun, targetReleaseId) => void rollback(sourceRun, targetReleaseId)}
      />
      <ReleaseLogDialog
        run={logRun}
        estimate={rows.find((row) => row.target.id === logRun?.targetId)?.releaseEstimate}
        retryingRunId={retryingRunId}
        canRollback={Boolean(logRun && rows.some((row) => row.target.id === logRun.targetId && (row.successfulRuns || []).length > 0))}
        onClose={() => setLogRun(null)}
        onRetry={(run) => void retryRelease(run)}
        onRollback={(run) => {
          const row = rows.find((item) => item.target.id === run.targetId);
          if (!row) {
            setToast('没有找到这条记录对应的环境');
            return;
          }
          openRollback(row, run);
        }}
      />
      <ArchiveTargetDialog
        state={archiveState}
        saving={archiving}
        onChange={(reason) => setArchiveState((current) => current ? { ...current, reason } : current)}
        onClose={() => setArchiveState(null)}
        onConfirm={() => void archiveSite()}
      />
    </AppShell>
  );
}

function EmptyEnvironmentsState({ hostCount, onAdd }: { hostCount: number; onAdd: () => void }): JSX.Element {
  return (
    <section className="cds-surface-raised cds-hairline rounded-lg px-5 py-12 text-center">
      <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-lg border border-[hsl(var(--hairline))] bg-[hsl(var(--surface-sunken))] text-primary">
        <Rocket className="h-5 w-5" />
      </div>
      <h2 className="mt-4 text-base font-semibold">还没有站点发布目标</h2>
      <p className="mx-auto mt-2 max-w-xl text-sm text-muted-foreground">
        添加一个环境后，CDS 会自动推断生产目录、发布脚本和健康检查地址，
        之后就能在这一页直接选分支发布，不用再去分支列表里找。
      </p>
      <div className="mt-5 flex flex-wrap justify-center gap-2">
        <Button onClick={onAdd}>
          <Plus />
          添加环境
        </Button>
        {/* 这里原本是一个跳去 CDS 系统设置的链接。没有服务器恰恰是最不该把人支走的时候——
            向导第一步已经能就地建服务器，空状态直接把人送进那一步即可。
            用户 2026-07-29 原话：不允许操作用户跳来跳去。 */}
        {hostCount === 0 ? (
          <Button variant="outline" onClick={onAdd}>
            还没有服务器？在向导第一步直接加
          </Button>
        ) : null}
      </div>
    </section>
  );
}

function publicUrlOf(row: CenterRow): string {
  return normalizeProductionOrigin(row.target.ssh?.healthcheckUrl || '');
}

function draftFromTarget(target: ReleaseTarget): SiteDraft {
  const ssh = target.ssh;
  const health = splitHealthUrl(ssh?.healthcheckUrl || '');
  const strategy = target.strategy || { mode: 'existing-script' as const, command: ssh?.deployCommand || '' };
  return {
    id: target.id,
    projectId: target.projectId,
    name: target.name,
    privateKeyRef: ssh?.privateKeyRef || '',
    host: ssh?.host || '',
    port: String(ssh?.port || 22),
    user: ssh?.user || '',
    sitePath: ssh?.appPath || '/opt/{project}-prod',
    publicUrl: health.publicUrl,
    healthPath: health.healthPath,
    rollbackCommand: ssh?.rollbackCommand || '',
    deployCommand: ssh?.deployCommand || '',
    healthcheckUrl: ssh?.healthcheckUrl || '',
    strategyMode: strategy.mode,
    composeFile: strategy.composeFile || 'compose.yml',
    composeProject: strategy.composeProject || `${target.projectId}-prod`,
    buildCommand: strategy.buildCommand || 'pnpm install --frozen-lockfile && pnpm build',
    artifactDirectory: strategy.artifactDirectory || 'dist',
    publicDirectory: strategy.publicDirectory || `/opt/${target.projectId}-web`,
    detectedFrom: strategy.detectedFrom || [],
    isCanonical: target.isCanonical === true,
    environment: target.environment || 'production',
  };
}

function buildTargetBody(draft: SiteDraft, projectId: string): Record<string, unknown> {
  return {
    projectId,
    name: draft.name.trim(),
    host: draft.host.trim(),
    port: Number(draft.port || 22),
    user: draft.user.trim(),
    privateKeyRef: draft.privateKeyRef.trim(),
    appPath: draft.sitePath.trim(),
    deployCommand: draft.strategyMode === 'existing-script' ? draft.deployCommand.trim() : '',
    rollbackCommand: draft.strategyMode === 'existing-script' ? draft.rollbackCommand.trim() : '',
    healthcheckUrl: buildHealthcheckUrl(draft),
    environment: draft.environment,
    isCanonical: draft.isCanonical,
    strategy: strategyFromDraft(draft),
  };
}

function splitHealthUrl(value: string): { publicUrl: string; healthPath: string } {
  if (!value) return { publicUrl: '', healthPath: '/api/health' };
  try {
    const url = new URL(value);
    return { publicUrl: `${url.protocol}//${url.host}`, healthPath: `${url.pathname || '/'}${url.search || ''}` };
  } catch {
    return { publicUrl: value, healthPath: '/api/health' };
  }
}
