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
import { Link, useSearchParams } from 'react-router-dom';
import { LayoutPanelLeft, Plus, RefreshCw, Rocket, RotateCcw } from 'lucide-react';
import { AppShell, Crumb, PaletteHint, TopBar, Workspace } from '@/components/layout/AppShell';
import { Button } from '@/components/ui/button';
import { ApiError, apiRequest } from '@/lib/api';
import { useNowTick } from '@/hooks/useNowTick';
import {
  initialReleaseCenterProject,
  releaseCenterDeepLink,
  normalizeProductionOrigin,
  rememberReleaseCenterProject,
} from '@/lib/releaseCenter';
import {
  buildEnvironmentSections,
  canonicalEnvironments,
  defaultIsCanonical,
  resolveSelectedTargetId,
  type EnvironmentSection,
} from '@/lib/releaseEnvironments';
import { railIsVisible, type RailMarker } from '@/lib/releaseRail';
import type { PreviewMode, PreviewUrlConfig } from '@/lib/previewUrl';
import { ErrorBlock, LoadingBlock } from '@/pages/cds-settings/components';
import { AutoReleaseTab } from '@/pages/release-center/AutoReleaseTab';
import { CommitRail } from '@/pages/release-center/CommitRail';
import { ConfigTab } from '@/pages/release-center/ConfigTab';
import {
  ArchiveTargetDialog,
  ReleaseLogDialog,
  RollbackDialog,
  type ArchiveState,
  type RollbackState,
} from '@/pages/release-center/dialogs';
import { EnvironmentSidebar } from '@/pages/release-center/EnvironmentSidebar';
import { EvidenceTab } from '@/pages/release-center/EvidenceTab';
import { HealthTab } from '@/pages/release-center/HealthTab';
import { OverviewTab } from '@/pages/release-center/OverviewTab';
import { ReleaseTimeline, type TimelineFilter } from '@/pages/release-center/ReleaseTimeline';
import { Chip, healthLabel, healthTone, formatResponseTime } from '@/pages/release-center/shared';
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

type DetailTab = 'overview' | 'history' | 'config' | 'evidence' | 'auto' | 'health';

const DETAIL_TABS: Array<{ id: DetailTab; label: string }> = [
  { id: 'overview', label: '概览' },
  { id: 'history', label: '发布历史' },
  { id: 'config', label: '配置' },
  { id: 'evidence', label: '日志与证据' },
  { id: 'auto', label: '自动发布' },
  { id: 'health', label: '健康监测' },
];

export function ReleaseCenterPage(): JSX.Element {
  const [searchParams] = useSearchParams();
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
  const [tab, setTab] = useState<DetailTab>('overview');
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

  const railMarkers: RailMarker[] = useMemo(() => sections.flatMap((section) => (
    section.entries
      .filter((entry) => entry.row.currentCommit)
      .map((entry) => ({
        targetId: entry.targetId,
        label: section.degraded ? entry.row.target.name : section.label,
        environment: section.environment,
        commitSha: entry.row.currentCommit,
      }))
  )), [sections]);

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

  const historyRuns = historyFilter === 'failed'
    ? selectedRuns.filter((run) => run.status === 'failed' || run.status === 'rollback_failed')
    : selectedRuns;

  return (
    <AppShell
      active="release-center"
      wide
      topbar={(
        <TopBar
          left={<Crumb items={[{ label: 'CDS', href: '/project-list' }, { label: '发布中心' }]} />}
          right={(
            <>
              <PaletteHint />
              {/* 发布控制台：同一批数据的「专注发布」视图，带上当前项目免得进去重选。 */}
              <Button variant="outline" size="sm" asChild>
                <Link to={projectId ? `/release-console?project=${encodeURIComponent(projectId)}` : '/release-console'}>
                  <LayoutPanelLeft />
                  发布控制台
                </Link>
              </Button>
              <Button variant="outline" size="sm" onClick={() => void load()}>
                <RefreshCw />
                刷新
              </Button>
            </>
          )}
        />
      )}
    >
      <Workspace fluid>
        {/* 移动端整页自然流竖滚；lg 起切回填满视口、各窗格自己滚。 */}
        <div
          /*
           * 桌面端也允许整页滚动。此前是 lg:overflow-hidden + 顶部两块 shrink-0，
           * 于是「站点发布」头部与版本流水轴被永久钉在首屏，下面的详情再也推不上去
           * ——用户原话「像被焊死了一样，想低头看看裤子什么颜色都看不到」。
           * 详情区仍用 lg:min-h 拿到一个体面的首屏高度，超出部分整页滚。
           */
          className="flex min-h-0 flex-col gap-4 overflow-y-auto"
        >
          {/* 头部压成一行：标题与说明同排。原来说明独占一行 + p-4，
              两块顶部加起来吃掉近 40% 首屏，正是「头大的矮子」那个体感。 */}
          <header className="cds-surface-raised cds-hairline shrink-0 rounded-[14px] px-4 py-3">
            <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
              <div className="flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-1">
                <h1 className="text-base font-semibold">站点发布</h1>
                <p className="min-w-0 text-[12.5px] text-muted-foreground">
                  谁停在哪个提交、健不健康、坏了退哪一版。
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <label className="flex items-center gap-2 text-sm">
                  <span className="text-muted-foreground">项目</span>
                  {projects.length > 0 ? (
                    <select
                      value={projectId}
                      onChange={(event) => {
                        const next = event.target.value.trim() || 'default';
                        setProjectId(next);
                        setSelectedTargetId('');
                        setDraft((current) => ({ ...current, projectId: next }));
                      }}
                      className="h-9 w-56 rounded-md border border-[hsl(var(--hairline))] bg-[hsl(var(--surface-sunken))] px-3 text-sm outline-none focus:border-primary/60"
                    >
                      {/* 当前 id 不在项目列表里（历史记忆值/敲错的旧值）也保留成一项，
                          并明示「未知」，不再让用户面对莫名其妙的空列表 */}
                      {!projects.some((project) => project.id === projectId) ? (
                        <option value={projectId}>{projectId}（未知项目）</option>
                      ) : null}
                      {projects.map((project) => (
                        <option key={project.id} value={project.id}>
                          {project.name && project.name !== project.id ? `${project.name}（${project.id}）` : project.id}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <input
                      value={projectId}
                      onChange={(event) => {
                        const next = event.target.value.trim() || 'default';
                        setProjectId(next);
                        setSelectedTargetId('');
                        setDraft((current) => ({ ...current, projectId: next }));
                      }}
                      className="h-9 w-48 rounded-md border border-[hsl(var(--hairline))] bg-[hsl(var(--surface-sunken))] px-3 font-mono text-sm outline-none focus:border-primary/60"
                    />
                  )}
                </label>
                <Button onClick={openCreateWizard}>
                  <Plus />
                  添加环境
                </Button>
              </div>
            </div>
            {toast ? (
              <div className="mt-3 rounded-md border border-[hsl(var(--hairline))] bg-[hsl(var(--surface-sunken))] px-3 py-2 text-sm">{toast}</div>
            ) : null}
          </header>

          {state.status === 'loading' ? <LoadingBlock label="正在加载发布环境" /> : null}
          {state.status === 'error' ? <ErrorBlock message={state.message} /> : null}

          {state.status === 'ok' && rows.length === 0 ? (
            <EmptyEnvironmentsState hostCount={hosts.length} onAdd={openCreateWizard} />
          ) : null}

          {state.status === 'ok' && rows.length > 0 ? (
            <>
              {railIsVisible(rail) ? (
                <CommitRail
                  rail={rail}
                  markers={railMarkers}
                  selectedPosition={selectedRow?.commitPosition}
                  nowMs={nowMs}
                  onSelectMarker={setSelectedTargetId}
                />
              ) : null}

              {/* 手机：单列自然堆叠，高度由内容决定（flex-1 + basis 0 在无界高度里会塌成 0）。
                  lg 起才切回主从网格并填满剩余高度。 */}
              <div className="flex flex-col gap-4 lg:grid lg:min-h-[560px] lg:flex-1 lg:grid-cols-[288px_minmax(0,1fr)] lg:items-stretch">
                <EnvironmentSidebar
                  sections={sections}
                  selectedTargetId={effectiveTargetId}
                  branch={branchLabel}
                  archivedTargets={archivedTargets}
                  nowMs={nowMs}
                  onSelect={(id) => { setSelectedTargetId(id); setTab('overview'); }}
                  onAdd={openCreateWizard}
                />

                {selectedRow ? (
                  <section className="cds-surface-raised cds-hairline flex flex-col overflow-hidden rounded-lg lg:h-full lg:min-h-0">
                    <div className="flex shrink-0 flex-wrap items-start justify-between gap-3 px-4 pb-3 pt-4">
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                          <h2 className="truncate text-lg font-semibold">{selectedRow.target.name}</h2>
                          <Chip tone={healthTone(selectedRow.healthStatus)}>
                            {healthLabel(selectedRow.healthStatus)}
                            {selectedRow.health?.responseTimeMs ? ` · ${formatResponseTime(selectedRow.health.responseTimeMs)}` : ''}
                          </Chip>
                          {selectedRow.target.isCanonical !== false ? <Chip>主目标</Chip> : null}
                          {!selectedRow.target.isEnabled ? <Chip tone="warn">已停用</Chip> : null}
                        </div>
                        <div className="mt-1.5 truncate text-xs text-muted-foreground">
                          {publicUrlOf(selectedRow) || '未配置上线地址'}
                          {selectedRow.target.ssh ? ` · ${selectedRow.target.ssh.user}@${selectedRow.target.ssh.host} · ${selectedRow.target.ssh.appPath}` : ''}
                        </div>
                      </div>
                      <div className="flex flex-wrap gap-2">
                        <Button onClick={() => setReleaseIntent({ row: selectedRow })}>
                          <Rocket />
                          发布新版本
                        </Button>
                        <Button variant="outline" onClick={() => openRollback(selectedRow)} disabled={!selectedRow.canRollback}>
                          <RotateCcw />
                          回滚
                        </Button>
                      </div>
                    </div>

                    <nav className="flex shrink-0 gap-0.5 overflow-x-auto border-b border-[hsl(var(--hairline))] px-3">
                      {DETAIL_TABS.map((item) => (
                        <button
                          key={item.id}
                          type="button"
                          onClick={() => setTab(item.id)}
                          className={`shrink-0 whitespace-nowrap border-b-2 px-3 py-2.5 text-[13px] transition-colors ${
                            tab === item.id
                              ? 'border-primary font-semibold text-foreground'
                              : 'border-transparent text-muted-foreground hover:text-foreground'
                          }`}
                        >
                          {item.label}
                        </button>
                      ))}
                    </nav>

                    {/* 主产物区：移动端给最小高度避免塌成 0，lg 起 flex-1 填满整列。 */}
                    <div
                      className="min-h-[320px] p-4 lg:min-h-0 lg:flex-1 lg:overflow-y-auto"
                    >
                      {tab === 'overview' ? (
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
                          onSeeAll={() => setTab('history')}
                          onOpenConfig={() => setTab('config')}
                        />
                      ) : null}

                      {tab === 'history' ? (
                        <ReleaseTimeline
                          title="发布历史"
                          runs={historyRuns}
                          row={selectedRow}
                          commitMeta={commitMeta}
                          nowMs={nowMs}
                          liveReleaseId={selectedRow.currentVersion}
                          retryingRunId={retryingRunId}
                          filter={historyFilter}
                          onFilter={setHistoryFilter}
                          onOpenLogs={setLogRun}
                          onRetry={(run) => void retryRelease(run)}
                          onRollback={(run) => openRollback(selectedRow, run)}
                        />
                      ) : null}

                      {tab === 'config' ? (
                        <ConfigTab
                          row={selectedRow}
                          publicUrl={publicUrlOf(selectedRow)}
                          onConfigure={() => openConfigureWizard(selectedRow.target)}
                          onArchive={() => setArchiveState({ row: selectedRow, reason: '' })}
                        />
                      ) : null}

                      {tab === 'evidence' ? <EvidenceTab row={selectedRow} runs={selectedRuns} /> : null}

                      {tab === 'auto' ? (
                        <AutoReleaseTab
                          row={selectedRow}
                          otherRows={otherRows}
                          branches={branches}
                          onToast={setToast}
                        />
                      ) : null}

                      {tab === 'health' ? <HealthTab row={selectedRow} nowMs={nowMs} /> : null}
                    </div>
                  </section>
                ) : null}
              </div>
            </>
          ) : null}
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
