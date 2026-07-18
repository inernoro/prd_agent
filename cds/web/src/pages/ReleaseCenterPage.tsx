import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Dispatch, ReactNode, SetStateAction } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import {
  Archive,
  CheckCircle2,
  Circle,
  ExternalLink,
  FileText,
  Loader2,
  Plus,
  RefreshCw,
  RotateCcw,
  Rocket,
  Server,
  Settings,
  Terminal,
  XCircle,
} from 'lucide-react';
import { AppShell, Crumb, PaletteHint, TopBar, Workspace } from '@/components/layout/AppShell';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { ApiError, apiRequest, apiUrl } from '@/lib/api';
import {
  buildReleaseHealthcheckUrl,
  initialReleaseCenterProject,
  normalizeProductionOrigin,
  rememberReleaseCenterProject,
} from '@/lib/releaseCenter';
import { ErrorBlock, LoadingBlock } from '@/pages/cds-settings/components';

interface ReleaseTarget {
  id: string;
  projectId: string;
  name: string;
  type: string;
  isEnabled: boolean;
  lifecycle?: 'active' | 'archived';
  archivedAt?: string;
  archivedBy?: string;
  archiveReason?: string;
  environment?: 'production' | 'staging' | 'other';
  isCanonical?: boolean;
  projectIdentity?: { projectId: string; projectSlug: string; repository?: string };
  strategy?: ReleaseStrategy;
  ssh?: {
    host: string;
    port: number;
    user: string;
    privateKeyRef: string;
    appPath: string;
    deployCommand: string;
    rollbackCommand?: string;
    healthcheckUrl: string;
  };
}

type ReleaseExecutionMode = 'existing-script' | 'generated-compose' | 'generated-static';

interface ReleaseStrategy {
  mode: ReleaseExecutionMode;
  command?: string;
  composeFile?: string;
  composeProject?: string;
  buildCommand?: string;
  artifactDirectory?: string;
  publicDirectory?: string;
  detectedFrom?: string[];
}

interface ReleaseStrategyCandidate {
  mode: ReleaseExecutionMode;
  label: string;
  description: string;
  confidence: 'high' | 'medium' | 'manual';
  strategy: ReleaseStrategy;
  requirements: string[];
}

interface ReleaseStrategyDiscovery {
  projectIdentity: { projectId: string; projectSlug: string; repository?: string };
  branchId: string;
  branchName: string;
  recommendedMode: ReleaseExecutionMode | null;
  candidates: ReleaseStrategyCandidate[];
  warnings: string[];
}

interface ProjectLite {
  id: string;
  name: string;
  slug?: string;
}

function isReleaseTerminal(status: string): boolean {
  return ['success', 'failed', 'rollback_success', 'rollback_failed'].includes(status);
}

interface ReleaseRun {
  releaseId: string;
  projectId: string;
  branchId: string;
  commitSha: string;
  artifact: {
    type: string;
    commitSha: string;
    branchId?: string;
    branchName?: string;
    previewUrl?: string;
    imageDigest?: string;
    artifactPath?: string;
  };
  targetId: string;
  status: string;
  startedAt: string;
  finishedAt?: string;
  operator?: string;
  previousReleaseId?: string;
  rollbackOf?: string;
  rollbackTargetReleaseId?: string;
  logs: ReleaseLogEntry[];
}

interface ReleaseLogEntry {
  seq: number;
  at: string;
  level: 'info' | 'warn' | 'error';
  message: string;
  phase?: string;
}

interface RemoteHostOption {
  id: string;
  name: string;
  host: string;
  sshPort: number;
  sshUser: string;
  fingerprint: string;
  isEnabled: boolean;
}

interface CenterRow {
  target: ReleaseTarget;
  currentVersion: string;
  currentCommit: string;
  latestRun?: ReleaseRun;
  lastReleasedAt?: string;
  health?: ReleaseHealthProbe;
  healthStatus: string;
  lastOperator?: string;
  canRollback: boolean;
  successfulRuns?: ReleaseRun[];
  rollbackDefaultReleaseId?: string;
}

interface CenterResponse {
  rows: CenterRow[];
  runs: ReleaseRun[];
}

interface TargetsResponse {
  targets: ReleaseTarget[];
  archivedTargets: ReleaseTarget[];
  remoteHosts: RemoteHostOption[];
}

interface ReleaseHealthProbe {
  status: 'healthy' | 'failed' | 'unknown';
  url: string;
  checkedAt: string;
  responseTimeMs?: number;
  message?: string;
}

type LoadState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ok'; center: CenterResponse; hosts: RemoteHostOption[] };

type WizardStep = 'server' | 'site' | 'scripts' | 'health';

interface SiteDraft {
  id?: string;
  projectId: string;
  name: string;
  privateKeyRef: string;
  host: string;
  port: string;
  user: string;
  sitePath: string;
  publicUrl: string;
  healthPath: string;
  rollbackCommand: string;
  deployCommand: string;
  healthcheckUrl: string;
  strategyMode: ReleaseExecutionMode;
  composeFile: string;
  composeProject: string;
  buildCommand: string;
  artifactDirectory: string;
  publicDirectory: string;
  detectedFrom: string[];
  isCanonical: boolean;
}

interface SiteView {
  id: string;
  target: ReleaseTarget;
  name: string;
  serverLabel: string;
  hostLabel: string;
  sitePath: string;
  publicUrl: string;
  healthUrl: string;
  deployScripts: string[];
  currentVersion: string;
  currentCommit: string;
  lastReleasedAt?: string;
  healthStatus: string;
  health?: ReleaseHealthProbe;
  responseTimeMs?: number;
  checkedAt?: string;
  healthMessage?: string;
  lastOperator?: string;
  latestRun?: ReleaseRun;
  canRollback: boolean;
  rollbackMethod: string;
  successfulRuns: ReleaseRun[];
  rollbackDefaultReleaseId: string;
  isEnabled: boolean;
  releaseMethod: string;
  projectLabel: string;
  isCanonical: boolean;
}

interface RollbackState {
  site: SiteView;
  sourceRun: ReleaseRun;
}

interface ArchiveState {
  site: SiteView;
  reason: string;
}

const DEFAULT_SITE_PATH = '/opt/{project}-prod';
const DEFAULT_DEPLOY_COMMAND = './fast.sh && ./exec_dep.sh';
const DEFAULT_HEALTH_PATH = '/api/health';
const SCRIPT_LABELS = ['./fast.sh', './exec_dep.sh'];

function emptyDraft(projectId: string): SiteDraft {
  return {
    projectId,
    name: '',
    privateKeyRef: '',
    host: '',
    port: '22',
    user: '',
    sitePath: '',
    publicUrl: '',
    healthPath: DEFAULT_HEALTH_PATH,
    rollbackCommand: '',
    deployCommand: DEFAULT_DEPLOY_COMMAND,
    healthcheckUrl: '',
    strategyMode: 'existing-script',
    composeFile: 'compose.yml',
    composeProject: `${projectId.replace(/[^a-z0-9_-]+/gi, '-').toLowerCase()}-prod`,
    buildCommand: 'pnpm install --frozen-lockfile && pnpm build',
    artifactDirectory: 'dist',
    publicDirectory: `/opt/${projectId}-web`,
    detectedFrom: [],
    isCanonical: true,
  };
}

export function ReleaseCenterPage(): JSX.Element {
  const [searchParams] = useSearchParams();
  const initialProject = initialReleaseCenterProject(
    searchParams,
    typeof window === 'undefined' ? undefined : window.localStorage,
  );
  const [projectId, setProjectId] = useState(initialProject);
  const [projects, setProjects] = useState<ProjectLite[]>([]);
  const [state, setState] = useState<LoadState>({ status: 'loading' });
  const [draft, setDraft] = useState<SiteDraft>(() => emptyDraft(initialProject));
  const [wizardStep, setWizardStep] = useState<WizardStep>('server');
  const [wizardOpen, setWizardOpen] = useState(false);
  const [savingSite, setSavingSite] = useState(false);
  const [toast, setToast] = useState('');
  const [logRun, setLogRun] = useState<ReleaseRun | null>(null);
  const [rollbackState, setRollbackState] = useState<RollbackState | null>(null);
  const [retryingRunId, setRetryingRunId] = useState('');
  const [discovery, setDiscovery] = useState<ReleaseStrategyDiscovery | null>(null);
  const [discovering, setDiscovering] = useState(false);
  const [archivedTargets, setArchivedTargets] = useState<ReleaseTarget[]>([]);
  const [archiveState, setArchiveState] = useState<ArchiveState | null>(null);
  const [archiving, setArchiving] = useState(false);

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

  // 项目列表用于「项目」下拉（照抄 ReportsPage 模式，best-effort，失败退回手输）。
  // 旧版是裸 font-mono 输入框，要求用户凭记忆敲 projectId——敲错只会看到
  // 「还没有站点发布目标」空状态，违反 zero-friction-input「能选择不手输」。
  useEffect(() => {
    let cancelled = false;
    apiRequest<{ projects?: ProjectLite[] }>('/api/projects')
      .then((res) => { if (!cancelled) setProjects(res.projects ?? []); })
      .catch(() => { if (!cancelled) setProjects([]); });
    return () => { cancelled = true; };
  }, []);

  const hosts = state.status === 'ok' ? state.hosts : [];
  const rows = state.status === 'ok' ? state.center.rows : [];
  const runs = state.status === 'ok' ? state.center.runs : [];
  const sites = useMemo(() => rows.map(toSiteView), [rows]);

  // 2026-07-09 兜住「白等」：发布运行中即使关掉日志弹窗，页面也要自己跟进
  // 到终态（旧版数据只在挂载/手动刷新时拉取，关弹窗后站点卡永远停在「发布中」，
  // 失败也无提示）。存在非终态 run 时 12s 静默轮询，终态翻转时 toast 告知。
  const hasActiveRun = state.status === 'ok'
    && (sites.some((site) => site.latestRun && !isReleaseTerminal(site.latestRun.status))
      || runs.some((run) => !isReleaseTerminal(run.status)));
  useEffect(() => {
    if (!hasActiveRun) return undefined;
    const timer = window.setInterval(() => { void load({ silent: true }); }, 12_000);
    return () => window.clearInterval(timer);
  }, [hasActiveRun, load]);
  const runStatusRef = useRef<Record<string, string>>({});
  useEffect(() => {
    if (state.status !== 'ok') return;
    const previous = runStatusRef.current;
    for (const run of runs) {
      const before = previous[run.releaseId];
      if (before && !isReleaseTerminal(before) && isReleaseTerminal(run.status)) {
        setToast(`发布 ${run.releaseId.slice(0, 12)} ${statusLabel(run.status)}`);
      }
    }
    runStatusRef.current = Object.fromEntries(runs.map((run) => [run.releaseId, run.status]));
  }, [state, runs]);

  const openCreateWizard = (): void => {
    const initial = {
      ...emptyDraft(projectId),
      sitePath: `/opt/${projectId}`,
      isCanonical: !sites.some((site) => site.isCanonical),
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
      setToast(err instanceof ApiError ? err.message : String(err));
    }).finally(() => setDiscovering(false));
  };

  const openConfigureWizard = (target: ReleaseTarget): void => {
    setDraft(draftFromTarget(target));
    setWizardStep('site');
    setWizardOpen(true);
    setToast('');
    setDiscovery(null);
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
      if (draft.id) {
        const body = buildTargetBody(draft, projectId);
        await apiRequest(`/api/releases/targets/${encodeURIComponent(draft.id)}`, { method: 'PATCH', body });
        setToast('站点发布目标已更新');
      } else {
        const body = buildTargetBody(draft, projectId);
        await apiRequest('/api/releases/targets', { method: 'POST', body });
        setToast('站点发布目标已添加');
      }
      setWizardOpen(false);
      setDraft(emptyDraft(projectId));
      await load();
    } catch (err) {
      setToast(err instanceof ApiError ? err.message : String(err));
    } finally {
      setSavingSite(false);
    }
  };

  const openRollback = (site: SiteView, sourceRun?: ReleaseRun): void => {
    const run = sourceRun || site.latestRun;
    if (!run) {
      setToast('还没有可回滚的发布记录');
      return;
    }
    setRollbackState({ site, sourceRun: run });
  };

  const rollback = async (sourceRun: ReleaseRun, targetReleaseId: string): Promise<void> => {
    setToast('');
    try {
      const res = await apiRequest<{ run: ReleaseRun }>(`/api/releases/runs/${encodeURIComponent(sourceRun.releaseId)}/rollback`, {
        method: 'POST',
        body: { targetReleaseId },
      });
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
      await apiRequest(`/api/releases/targets/${encodeURIComponent(archiveState.site.id)}/archive`, {
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

  const openRollbackForRun = (run: ReleaseRun): void => {
    const site = sites.find((item) => item.id === run.targetId);
    if (!site) {
      setToast('没有找到这条记录对应的站点');
      return;
    }
    setLogRun(null);
    openRollback(site, run);
  };

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
              <Button variant="outline" size="sm" onClick={() => void load()}>
                <RefreshCw />
                刷新
              </Button>
            </>
          )}
        />
      )}
    >
      <Workspace wide>
        <div className="flex h-full min-h-0 flex-col gap-5 overflow-y-auto" style={{ overscrollBehavior: 'contain' }}>
          <section className="cds-surface-raised cds-hairline p-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="min-w-0">
                <h1 className="text-lg font-semibold">站点发布</h1>
                <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
                  一个项目只展示自己的发布目标。CDS 可复用现有脚本，也能为没有发布脚本的 Compose 或静态项目动态生成可审计的发布计划。
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
                        setDraft((current) => ({ ...current, projectId: next }));
                      }}
                      className="h-9 w-56 rounded-md border border-[hsl(var(--hairline))] bg-[hsl(var(--surface-sunken))] px-3 text-sm outline-none focus:border-primary/60"
                    >
                      {/* 当前 id 不在项目列表里（历史记忆值/敲错的旧值）也保留成一项，
                          并明示"未知"，不再让用户面对莫名其妙的空列表 */}
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
                    // 项目列表拉取失败/为空时退回手输，不阻断使用
                    <input
                      value={projectId}
                      onChange={(event) => {
                        const next = event.target.value.trim() || 'default';
                        setProjectId(next);
                        setDraft((current) => ({ ...current, projectId: next }));
                      }}
                      className="h-9 w-48 rounded-md border border-[hsl(var(--hairline))] bg-[hsl(var(--surface-sunken))] px-3 font-mono text-sm outline-none focus:border-primary/60"
                    />
                  )}
                </label>
                <Button onClick={openCreateWizard}>
                  <Plus />
                  添加站点发布
                </Button>
              </div>
            </div>
            {toast ? <div className="mt-3 rounded-md border border-[hsl(var(--hairline))] bg-[hsl(var(--surface-sunken))] px-3 py-2 text-sm">{toast}</div> : null}
          </section>

          {state.status === 'loading' ? <LoadingBlock label="正在加载站点发布目标" /> : null}
          {state.status === 'error' ? <ErrorBlock message={state.message} /> : null}
          {state.status === 'ok' ? (
            <>
              {sites.length === 0 ? (
                <EmptySitesState hostCount={hosts.length} onAdd={openCreateWizard} />
              ) : (
                <section className="grid gap-4 xl:grid-cols-2">
                  {sites.map((site) => (
                    <SiteCard
                      key={site.id}
                      site={site}
                      onLogs={() => site.latestRun && setLogRun(site.latestRun)}
                      onRollback={() => openRollback(site)}
                      onConfigure={() => openConfigureWizard(site.target)}
                      onArchive={() => setArchiveState({ site, reason: '' })}
                    />
                  ))}
                </section>
              )}
              <ReleaseRecords runs={runs} onOpen={setLogRun} />
              <ArchivedTargets targets={archivedTargets} />
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
        onSave={() => void saveSite()}
      />
      <RollbackDialog
        state={rollbackState}
        onClose={() => setRollbackState(null)}
        onConfirm={(sourceRun, targetReleaseId) => void rollback(sourceRun, targetReleaseId)}
      />
      <ReleaseLogDialog
        run={logRun}
        retryingRunId={retryingRunId}
        canRollback={Boolean(logRun && sites.some((site) => site.id === logRun.targetId && site.successfulRuns.length > 0))}
        onClose={() => setLogRun(null)}
        onRetry={(run) => void retryRelease(run)}
        onRollback={openRollbackForRun}
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

function EmptySitesState({ hostCount, onAdd }: { hostCount: number; onAdd: () => void }): JSX.Element {
  return (
    <section className="cds-surface-raised cds-hairline px-5 py-12 text-center">
      <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-lg border border-[hsl(var(--hairline))] bg-[hsl(var(--surface-sunken))] text-primary">
        <Rocket className="h-5 w-5" />
      </div>
      <h2 className="mt-4 text-base font-semibold">还没有站点发布目标</h2>
      <p className="mx-auto mt-2 max-w-xl text-sm text-muted-foreground">
        添加一个站点后，CDS 会自动推断生产目录、发布脚本和健康检查地址，后续可以从成功运行的分支一键发布。
      </p>
      <div className="mt-5 flex flex-wrap justify-center gap-2">
        <Button onClick={onAdd}>
          <Plus />
          添加站点发布
        </Button>
        {hostCount === 0 ? (
          <Button asChild variant="outline">
            <Link to="/cds-settings#remote-hosts">先添加服务器</Link>
          </Button>
        ) : null}
      </div>
    </section>
  );
}

function SiteCard({
  site,
  onLogs,
  onRollback,
  onConfigure,
  onArchive,
}: {
  site: SiteView;
  onLogs: () => void;
  onRollback: () => void;
  onConfigure: () => void;
  onArchive: () => void;
}): JSX.Element {
  return (
    <article className="cds-surface-raised cds-hairline flex min-h-[360px] flex-col p-4">
      <header className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="truncate text-base font-semibold">{site.name}</h2>
            {site.isCanonical ? <span className="rounded-md border border-primary/30 bg-primary/10 px-2 py-0.5 text-xs text-primary">生产主目标</span> : null}
            {!site.isEnabled ? <span className="rounded-md border border-amber-500/30 px-2 py-0.5 text-xs text-amber-500">已停用</span> : null}
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <Server className="h-3.5 w-3.5" />
            <span>{site.serverLabel}</span>
            <span>·</span>
            <span className="font-mono">{site.sitePath}</span>
          </div>
        </div>
        <StatusPill status={site.healthStatus} />
      </header>

      <div className="mt-4 grid gap-3 md:grid-cols-2">
        <InfoBlock label="所属项目">{site.projectLabel}</InfoBlock>
        <InfoBlock label="发布方式">{site.releaseMethod}</InfoBlock>
        <InfoBlock label="上线地址">
          {site.publicUrl ? (
            <a href={site.publicUrl} target="_blank" rel="noreferrer" className="inline-flex min-w-0 items-center gap-1 text-primary hover:underline">
              <span className="truncate">{site.publicUrl}</span>
              <ExternalLink className="h-3.5 w-3.5 shrink-0" />
            </a>
          ) : '-'}
        </InfoBlock>
        <InfoBlock label="健康检查">{site.healthUrl || '-'}</InfoBlock>
        <InfoBlock label="当前版本"><CodeText>{site.currentVersion || '-'}</CodeText></InfoBlock>
        <InfoBlock label="当前 commit"><CodeText>{site.currentCommit ? site.currentCommit.slice(0, 12) : '-'}</CodeText></InfoBlock>
        <InfoBlock label="最近发布时间">{formatDate(site.lastReleasedAt)}</InfoBlock>
        <InfoBlock label="最近发布人">{site.lastOperator || '-'}</InfoBlock>
        <InfoBlock label="响应时间">{formatResponseTime(site.responseTimeMs)}</InfoBlock>
        <InfoBlock label="最近检查">{formatDate(site.checkedAt)}</InfoBlock>
      </div>
      {site.healthMessage ? (
        <div className="mt-3 rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-500">
          {site.healthMessage}
        </div>
      ) : null}

      <div className="mt-4 rounded-md border border-[hsl(var(--hairline))] bg-[hsl(var(--surface-sunken))]/55 p-3">
        <div className="mb-2 flex items-center gap-2 text-xs font-medium text-muted-foreground">
          <Terminal className="h-3.5 w-3.5" />
          {site.releaseMethod}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {site.deployScripts.map((script, index) => (
            <span key={`${script}-${index}`} className="inline-flex items-center gap-2 rounded-md border border-[hsl(var(--hairline))] bg-[hsl(var(--surface-raised))] px-2.5 py-1 text-xs">
              <span className="font-mono">{script}</span>
              {index < site.deployScripts.length - 1 ? <span className="text-muted-foreground">→</span> : null}
            </span>
          ))}
        </div>
        <div className="mt-2 text-xs text-muted-foreground">回滚策略：{site.rollbackMethod}</div>
      </div>

      <div className="mt-auto flex flex-wrap items-center justify-between gap-2 pt-4">
        <div className="text-xs text-muted-foreground">
          {site.latestRun ? `最近记录 ${site.latestRun.releaseId.slice(0, 12)} · ${statusLabel(site.latestRun.status)}` : '还没有发布记录'}
        </div>
        <div className="flex flex-wrap gap-2">
          <Button asChild size="sm">
            <Link to={`/branch-list?project=${encodeURIComponent(site.target.projectId)}`}>
              <Rocket />
              立即发布
            </Link>
          </Button>
          <Button variant="outline" size="sm" onClick={onLogs} disabled={!site.latestRun}>
            <FileText />
            查看日志
          </Button>
          <Button variant="outline" size="sm" onClick={onRollback} disabled={!site.canRollback || !site.latestRun}>
            <RotateCcw />
            回滚
          </Button>
          <Button variant="outline" size="sm" onClick={onConfigure}>
            <Settings />
            配置
          </Button>
          <Button variant="outline" size="sm" onClick={onArchive}>
            <Archive />
            归档
          </Button>
        </div>
      </div>
    </article>
  );
}

function SiteWizardDialog({
  open,
  draft,
  step,
  hosts,
  discovery,
  discovering,
  saving,
  onClose,
  onStep,
  onDraft,
  onSelectHost,
  onSave,
}: {
  open: boolean;
  draft: SiteDraft;
  step: WizardStep;
  hosts: RemoteHostOption[];
  discovery: ReleaseStrategyDiscovery | null;
  discovering: boolean;
  saving: boolean;
  onClose: () => void;
  onStep: (step: WizardStep) => void;
  onDraft: Dispatch<SetStateAction<SiteDraft>>;
  onSelectHost: (hostId: string) => void;
  onSave: () => void;
}): JSX.Element {
  const selectedHost = hosts.find((host) => host.id === draft.privateKeyRef);
  const canSave = Boolean(
    draft.name.trim()
    && draft.privateKeyRef
    && draft.sitePath.trim()
    && buildHealthcheckUrl(draft)
    && isDraftStrategyComplete(draft),
  );
  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) onClose(); }}>
      <DialogContent className="max-w-none" style={{ width: 'min(896px, calc(100vw - 32px))' }}>
        <DialogHeader>
          <DialogTitle>{draft.id ? '配置站点发布' : '添加站点发布'}</DialogTitle>
        </DialogHeader>
        <div className="grid gap-5 lg:grid-cols-[220px_minmax(0,1fr)]">
          <nav className="grid content-start gap-2">
            {wizardSteps.map((item, index) => (
              <button
                key={item.id}
                type="button"
                onClick={() => onStep(item.id)}
                className={`flex items-center gap-2 rounded-md border px-3 py-2 text-left text-sm ${
                  step === item.id
                    ? 'border-primary/45 bg-primary/10 text-primary'
                    : 'border-[hsl(var(--hairline))] bg-[hsl(var(--surface-sunken))]/45 text-muted-foreground hover:bg-[hsl(var(--surface-sunken))]'
                }`}
              >
                <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md border border-current/20 text-xs">{index + 1}</span>
                <span>{item.label}</span>
              </button>
            ))}
          </nav>
          <div className="min-h-[360px] space-y-4">
            {step === 'server' ? (
              <WizardPanel title="选择服务器" description="站点会发布到这台服务器的站点目录。凭据仍复用 Settings / Remote Hosts。">
                {hosts.length === 0 ? (
                  <div className="rounded-md border border-amber-500/30 bg-amber-500/10 p-3 text-sm text-amber-700 dark:text-amber-300">
                    还没有可用服务器。先到 <Link className="underline" to="/cds-settings#remote-hosts">Settings / Remote Hosts</Link> 添加 SSH 凭据。
                  </div>
                ) : (
                  <div className="grid gap-2">
                    {hosts.map((host) => (
                      <button
                        key={host.id}
                        type="button"
                        onClick={() => onSelectHost(host.id)}
                        className={`flex items-start justify-between gap-3 rounded-md border p-3 text-left ${
                          draft.privateKeyRef === host.id
                            ? 'border-primary/45 bg-primary/10'
                            : 'border-[hsl(var(--hairline))] bg-[hsl(var(--surface-sunken))]/45 hover:bg-[hsl(var(--surface-sunken))]'
                        }`}
                      >
                        <span>
                          <span className="block text-sm font-medium">{host.name}</span>
                          <span className="mt-1 block text-xs text-muted-foreground">{host.sshUser}@{host.host}:{host.sshPort}</span>
                        </span>
                        <StatusPill status={host.isEnabled ? '可用' : '已停用'} />
                      </button>
                    ))}
                  </div>
                )}
              </WizardPanel>
            ) : null}

            {step === 'site' ? (
              <WizardPanel title="确认项目与远端目录" description="远端目录必须是当前项目的 Git 仓库。项目身份由 CDS 服务端写入目标，后续不一致会阻断发布。">
                <div className="grid gap-3 md:grid-cols-3">
                  <Field label="站点名称" value={draft.name} onChange={(value) => onDraft((c) => ({ ...c, name: value }))} placeholder="生产站点" />
                  <Field label="远端项目仓库" value={draft.sitePath} onChange={(value) => onDraft((c) => ({ ...c, sitePath: value }))} placeholder="/opt/project" />
                  <Field label="生产域名" value={draft.publicUrl} onChange={(value) => onDraft((c) => ({ ...c, publicUrl: value }))} placeholder="www.example.com" />
                </div>
                <div className="rounded-md border border-[hsl(var(--hairline))] bg-[hsl(var(--surface-sunken))]/45 p-3 text-sm">
                  <div className="text-muted-foreground">服务器</div>
                  <div className="mt-1 font-mono">{selectedHost ? `${selectedHost.sshUser}@${selectedHost.host}:${selectedHost.sshPort}` : '尚未选择服务器'}</div>
                </div>
                <label className="flex items-start gap-2 rounded-md border border-[hsl(var(--hairline))] bg-[hsl(var(--surface-sunken))]/45 p-3 text-sm">
                  <input
                    type="checkbox"
                    checked={draft.isCanonical}
                    onChange={(event) => onDraft((current) => ({ ...current, isCanonical: event.target.checked }))}
                    className="mt-0.5"
                  />
                  <span>
                    <span className="block font-medium">设为生产主目标</span>
                    <span className="mt-1 block text-xs text-muted-foreground">同一项目和环境只能有一个启用的生产主目标；其他站点请取消勾选。</span>
                  </span>
                </label>
              </WizardPanel>
            ) : null}

            {step === 'scripts' ? (
              <WizardPanel title="确认发布方式" description="CDS 先扫描项目事实，再推荐发布方式；自动生成脚本会在每次发布时固化哈希，不写回项目仓库。">
                {discovering ? <LoadingBlock label="正在扫描项目发布能力" /> : null}
                {discovery ? (
                  <div className="rounded-md border border-[hsl(var(--hairline))] bg-[hsl(var(--surface-sunken))]/45 p-3 text-xs text-muted-foreground">
                    项目身份：{discovery.projectIdentity.projectSlug}
                    {discovery.projectIdentity.repository ? ` · ${discovery.projectIdentity.repository}` : ''}
                    <br />检测分支：{discovery.branchName}（{discovery.branchId}）
                  </div>
                ) : null}
                <div className="grid gap-2">
                  {releaseModeDefinitions(discovery, draft).map((item) => (
                    <button
                      key={item.mode}
                      type="button"
                      onClick={() => onDraft((current) => applyDiscoveredStrategy(current, item.strategy))}
                      className={`rounded-md border p-3 text-left ${draft.strategyMode === item.mode ? 'border-primary/45 bg-primary/10' : 'border-[hsl(var(--hairline))] bg-[hsl(var(--surface-sunken))]/45'}`}
                    >
                      <div className="flex items-center justify-between gap-2 text-sm font-medium">
                        <span>{item.label}</span>
                        <span className="text-xs text-muted-foreground">{item.confidence === 'high' ? '已检测' : item.confidence === 'medium' ? '建议复核' : '手动配置'}</span>
                      </div>
                      <p className="mt-1 text-xs text-muted-foreground">{item.description}</p>
                    </button>
                  ))}
                </div>
                {draft.strategyMode === 'existing-script' ? (
                  <Field label="项目发布命令" value={draft.deployCommand} onChange={(value) => onDraft((c) => ({ ...c, deployCommand: value }))} placeholder="./deploy.sh" />
                ) : null}
                {draft.strategyMode === 'generated-compose' ? (
                  <div className="grid gap-3 md:grid-cols-2">
                    <Field label="Compose 文件" value={draft.composeFile} onChange={(value) => onDraft((c) => ({ ...c, composeFile: value }))} placeholder="compose.yml" />
                    <Field label="Compose 项目名" value={draft.composeProject} onChange={(value) => onDraft((c) => ({ ...c, composeProject: value }))} placeholder="project-prod" />
                  </div>
                ) : null}
                {draft.strategyMode === 'generated-static' ? (
                  <div className="grid gap-3 md:grid-cols-2">
                    <Field label="构建命令" value={draft.buildCommand} onChange={(value) => onDraft((c) => ({ ...c, buildCommand: value }))} />
                    <Field label="产物目录" value={draft.artifactDirectory} onChange={(value) => onDraft((c) => ({ ...c, artifactDirectory: value }))} placeholder="dist" />
                    <div className="md:col-span-2">
                      <Field label="静态发布根目录" value={draft.publicDirectory} onChange={(value) => onDraft((c) => ({ ...c, publicDirectory: value }))} placeholder="/opt/project-web" />
                    </div>
                    <p className="md:col-span-2 text-xs text-muted-foreground">Web Server 根目录必须指向该目录下的 current。CDS 会保留 previous，并在入口探测失败时自动恢复。</p>
                  </div>
                ) : null}
              </WizardPanel>
            ) : null}

            {step === 'health' ? (
              <WizardPanel title="配置上线地址" description="上线地址用于发布后的健康检查，也会显示在站点卡片上。">
                <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_160px]">
                  {draft.id ? (
                    <Field label="上线地址" value={draft.publicUrl} onChange={(value) => onDraft((c) => ({ ...c, publicUrl: value }))} placeholder="https://xxx.miduo.org" />
                  ) : (
                    <Field label="生产域名" value={draft.publicUrl} onChange={(value) => onDraft((c) => ({ ...c, publicUrl: value }))} placeholder="www.example.com" />
                  )}
                  <Field label="健康检查路径" value={draft.healthPath} onChange={(value) => onDraft((c) => ({ ...c, healthPath: value || DEFAULT_HEALTH_PATH }))} placeholder="/api/health" />
                </div>
                <div className="rounded-md border border-[hsl(var(--hairline))] bg-[hsl(var(--surface-sunken))]/45 p-3 text-sm">
                  <div className="text-muted-foreground">健康检查</div>
                  <div className="mt-1 font-mono">{buildHealthcheckUrl(draft) || '填写上线地址后自动生成'}</div>
                </div>
                {draft.strategyMode === 'existing-script' ? (
                  <label className="flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      checked={Boolean(draft.rollbackCommand)}
                      onChange={(event) => onDraft((c) => ({ ...c, rollbackCommand: event.target.checked ? './rollback.sh' : '' }))}
                    />
                    项目提供独立回滚脚本
                  </label>
                ) : (
                  <div className="rounded-md border border-emerald-500/30 bg-emerald-500/10 p-3 text-sm text-emerald-700 dark:text-emerald-300">
                    动态发布会保留上一成功版本；最终入口探测失败时自动恢复，也可从发布记录手动回滚。
                  </div>
                )}
                {draft.strategyMode === 'existing-script' && draft.rollbackCommand ? (
                  <Field label="回滚脚本" value={draft.rollbackCommand} onChange={(value) => onDraft((c) => ({ ...c, rollbackCommand: value }))} />
                ) : null}
              </WizardPanel>
            ) : null}

            <div className="flex flex-wrap items-center justify-between gap-2 border-t border-[hsl(var(--hairline))] pt-4">
              <div className="text-xs text-muted-foreground">
                {draft.id ? '保存后不会自动发布，需要在分支卡片点击发布。' : '保存后即可从成功运行的分支发布到该站点。'}
              </div>
              <div className="flex gap-2">
                <Button variant="outline" onClick={onClose}>取消</Button>
                <Button onClick={onSave} disabled={saving || !canSave}>
                  {saving ? <Loader2 className="animate-spin" /> : <CheckCircle2 />}
                  保存站点发布
                </Button>
              </div>
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function ReleaseRecords({ runs, onOpen }: { runs: ReleaseRun[]; onOpen: (run: ReleaseRun) => void }): JSX.Element {
  return (
    <section className="cds-surface-raised cds-hairline overflow-hidden">
      <div className="border-b border-[hsl(var(--hairline))] px-4 py-3 text-sm font-semibold">发布记录</div>
      {runs.length === 0 ? (
        <div className="px-4 py-8 text-center text-sm text-muted-foreground">还没有发布记录。</div>
      ) : (
        <div className="divide-y divide-[hsl(var(--hairline))]">
          {runs.slice(0, 12).map((run) => (
            <button
              key={run.releaseId}
              type="button"
              onClick={() => onOpen(run)}
              className="grid w-full gap-3 px-4 py-3 text-left text-sm hover:bg-[hsl(var(--surface-sunken))]/60 md:grid-cols-[minmax(0,1fr)_120px_120px_160px]"
            >
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <Server className="h-4 w-4 text-muted-foreground" />
                  <span className="font-medium">发布记录</span>
                  <CodeText>{run.releaseId}</CodeText>
                  {run.rollbackOf ? <span className="rounded border border-amber-500/30 px-1.5 py-0.5 text-xs text-amber-500">回滚</span> : null}
                </div>
                <div className="mt-1 truncate text-xs text-muted-foreground">{run.branchId} · {run.commitSha}</div>
              </div>
              <StatusPill status={run.status} />
              <div className="text-muted-foreground">{run.operator || '-'}</div>
              <div className="text-muted-foreground">{formatDate(run.startedAt)}</div>
            </button>
          ))}
        </div>
      )}
    </section>
  );
}

function ArchivedTargets({ targets }: { targets: ReleaseTarget[] }): JSX.Element | null {
  if (targets.length === 0) return null;
  return (
    <details className="cds-surface-raised cds-hairline overflow-hidden">
      <summary className="cursor-pointer px-4 py-3 text-sm font-semibold">已归档发布目标（{targets.length}）</summary>
      <div className="divide-y divide-[hsl(var(--hairline))] border-t border-[hsl(var(--hairline))]">
        {targets.map((target) => (
          <div key={target.id} className="grid gap-2 px-4 py-3 text-sm md:grid-cols-[minmax(0,1fr)_180px_180px]">
            <div className="min-w-0">
              <div className="font-medium">{target.name}</div>
              <div className="mt-1 text-xs text-muted-foreground">{target.archiveReason || '未记录归档原因'}</div>
            </div>
            <div className="font-mono text-xs text-muted-foreground">{target.projectIdentity?.projectSlug || target.projectId}</div>
            <div className="text-xs text-muted-foreground">{formatDate(target.archivedAt)} · {target.archivedBy || '-'}</div>
          </div>
        ))}
      </div>
    </details>
  );
}

function ArchiveTargetDialog({
  state,
  saving,
  onChange,
  onClose,
  onConfirm,
}: {
  state: ArchiveState | null;
  saving: boolean;
  onChange: (reason: string) => void;
  onClose: () => void;
  onConfirm: () => void;
}): JSX.Element {
  const valid = Boolean(state && state.reason.trim().length >= 8);
  return (
    <Dialog open={Boolean(state)} onOpenChange={(open) => { if (!open && !saving) onClose(); }}>
      <DialogContent className="max-w-none" style={{ width: 'min(620px, calc(100vw - 32px))' }}>
        <DialogHeader>
          <DialogTitle>归档发布目标</DialogTitle>
        </DialogHeader>
        {state ? (
          <div className="space-y-4">
            <div className="rounded-md border border-[hsl(var(--hairline))] bg-[hsl(var(--surface-sunken))]/45 p-3 text-sm">
              <div className="font-medium">{state.site.name}</div>
              <div className="mt-1 text-xs text-muted-foreground">{state.site.projectLabel} · {state.site.serverLabel}</div>
              <div className="mt-2 text-xs text-muted-foreground">归档会立即停用该目标并取消生产主目标标记，但会保留配置快照和全部发布记录。</div>
            </div>
            <label className="grid gap-1 text-sm">
              <span className="text-muted-foreground">归档原因</span>
              <textarea
                value={state.reason}
                onChange={(event) => onChange(event.target.value)}
                rows={3}
                placeholder="例如：该目标属于其他项目，错误挂载到当前项目"
                className="resize-none rounded-md border border-[hsl(var(--hairline))] bg-[hsl(var(--surface-sunken))] px-3 py-2 outline-none focus:border-primary/60"
              />
              <span className="text-xs text-muted-foreground">至少 8 个字符，原因会进入审计记录。</span>
            </label>
            <div className="flex justify-end gap-2 border-t border-[hsl(var(--hairline))] pt-4">
              <Button variant="outline" onClick={onClose} disabled={saving}>取消</Button>
              <Button onClick={onConfirm} disabled={!valid || saving}>
                {saving ? <Loader2 className="animate-spin" /> : <Archive />}
                确认归档
              </Button>
            </div>
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function RollbackDialog({
  state,
  onClose,
  onConfirm,
}: {
  state: RollbackState | null;
  onClose: () => void;
  onConfirm: (sourceRun: ReleaseRun, targetReleaseId: string) => void;
}): JSX.Element {
  const defaultVersionId = state ? defaultRollbackVersionId(state.site, state.sourceRun) : '';
  const [selectedVersionId, setSelectedVersionId] = useState(defaultVersionId);
  useEffect(() => setSelectedVersionId(defaultVersionId), [defaultVersionId]);
  const versions = state?.site.successfulRuns || [];
  const selected = versions.find((run) => run.releaseId === selectedVersionId);
  return (
    <Dialog open={!!state} onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="max-w-none" style={{ width: 'min(720px, calc(100vw - 32px))' }}>
        <DialogHeader>
          <DialogTitle>回滚站点版本</DialogTitle>
        </DialogHeader>
        {state ? (
          <div className="space-y-4">
            <div className="grid gap-3 md:grid-cols-2">
              <InfoBlock label="站点">{state.site.name}</InfoBlock>
              <InfoBlock label="当前记录"><CodeText>{state.sourceRun.releaseId}</CodeText></InfoBlock>
              <InfoBlock label="当前 commit"><CodeText>{state.sourceRun.commitSha.slice(0, 12)}</CodeText></InfoBlock>
              <InfoBlock label="回滚策略">{state.site.rollbackMethod}</InfoBlock>
            </div>
            <label className="grid gap-1 text-sm">
              <span className="text-muted-foreground">选择目标版本</span>
              <select
                value={selectedVersionId}
                onChange={(event) => setSelectedVersionId(event.target.value)}
                className="h-10 rounded-md border border-[hsl(var(--hairline))] bg-[hsl(var(--surface-sunken))] px-3 text-sm outline-none focus:border-primary/60"
              >
                {versions.map((run) => (
                  <option key={run.releaseId} value={run.releaseId}>
                    {run.releaseId} · {run.commitSha.slice(0, 12)} · {formatDate(run.finishedAt || run.startedAt)}
                  </option>
                ))}
              </select>
            </label>
            <div className="rounded-md border border-[hsl(var(--hairline))] bg-[hsl(var(--surface-sunken))]/45 p-3 text-sm">
              <div className="text-muted-foreground">确认后将执行</div>
              <div className="mt-1">
                回滚到 <CodeText>{selected?.releaseId || '-'}</CodeText>，执行脚本后会立即做健康检查，并生成新的回滚记录。
              </div>
            </div>
            <div className="flex justify-end gap-2 border-t border-[hsl(var(--hairline))] pt-4">
              <Button variant="outline" onClick={onClose}>取消</Button>
              <Button onClick={() => selectedVersionId && onConfirm(state.sourceRun, selectedVersionId)} disabled={!selectedVersionId}>
                <RotateCcw />
                确认回滚
              </Button>
            </div>
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function ReleaseLogDialog({
  run,
  retryingRunId,
  canRollback,
  onClose,
  onRetry,
  onRollback,
}: {
  run: ReleaseRun | null;
  retryingRunId: string;
  canRollback: boolean;
  onClose: () => void;
  onRetry: (run: ReleaseRun) => void;
  onRollback: (run: ReleaseRun) => void;
}): JSX.Element {
  const [current, setCurrent] = useState<ReleaseRun | null>(run);
  useEffect(() => setCurrent(run), [run]);
  useEffect(() => {
    if (!run || isTerminal(run.status)) return undefined;
    const source = new EventSource(apiUrl(`/api/releases/runs/${encodeURIComponent(run.releaseId)}/stream?afterSeq=${run.logs.at(-1)?.seq || 0}`));
    source.addEventListener('snapshot', (event) => {
      const data = parseSseJson<{ run: ReleaseRun; logs: ReleaseLogEntry[] }>(event);
      if (data?.run) setCurrent(data.run);
    });
    source.addEventListener('release.log', (event) => {
      const data = parseSseJson<{ log: ReleaseLogEntry }>(event);
      if (!data?.log) return;
      setCurrent((prev) => prev ? { ...prev, logs: dedupeLogs([...prev.logs, data.log]) } : prev);
    });
    source.addEventListener('release.status', (event) => {
      const data = parseSseJson<{ run: ReleaseRun }>(event);
      if (data?.run) setCurrent(data.run);
    });
    return () => source.close();
  }, [run]);
  const steps = current ? releaseSteps(current) : [];
  const canActOnFailure = Boolean(current && (current.status === 'failed' || current.status === 'rollback_failed'));
  return (
    <Dialog open={!!run} onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="max-w-none" style={{ width: 'min(768px, calc(100vw - 32px))' }}>
        <DialogHeader>
          <DialogTitle>发布记录 {current?.releaseId ? <span className="font-mono text-sm text-muted-foreground">{current.releaseId}</span> : null}</DialogTitle>
        </DialogHeader>
        <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
          <StatusPill status={current?.status || 'unknown'} />
          <span className="text-muted-foreground">{formatDate(current?.startedAt)}</span>
        </div>
        <div className="grid gap-2">
          {steps.map((step) => (
            <div key={step.id} className="flex items-center gap-3 rounded-md border border-[hsl(var(--hairline))] bg-[hsl(var(--surface-sunken))]/45 px-3 py-2 text-sm">
              {step.state === 'done' ? <CheckCircle2 className="h-4 w-4 text-emerald-500" /> : step.state === 'failed' ? <XCircle className="h-4 w-4 text-red-500" /> : step.state === 'running' ? <Loader2 className="h-4 w-4 animate-spin text-sky-500" /> : <Circle className="h-4 w-4 text-muted-foreground" />}
              <span className="font-medium">{step.label}</span>
              {step.detail ? <span className="min-w-0 truncate text-xs text-muted-foreground">{step.detail}</span> : null}
            </div>
          ))}
        </div>
        <pre className="max-h-[42vh] overflow-auto rounded-md border border-[hsl(var(--hairline))] bg-[hsl(var(--surface-sunken))] p-3 text-xs leading-5">
          {(current?.logs || []).map((log) => `[${formatTime(log.at)}] ${log.level.toUpperCase()} ${log.phase ? `${log.phase}: ` : ''}${log.message}`).join('\n') || '等待发布日志...'}
        </pre>
        {current && canActOnFailure ? (
          <div className="flex flex-wrap justify-end gap-2 border-t border-[hsl(var(--hairline))] pt-3">
            <Button variant="outline" onClick={() => onRollback(current)} disabled={!canRollback}>
              <RotateCcw />
              回滚到历史版本
            </Button>
            <Button onClick={() => onRetry(current)} disabled={retryingRunId === current.releaseId}>
              {retryingRunId === current.releaseId ? <Loader2 className="animate-spin" /> : <RefreshCw />}
              重试发布
            </Button>
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function WizardPanel({ title, description, children }: { title: string; description: string; children: ReactNode }): JSX.Element {
  return (
    <section className="space-y-4">
      <div>
        <h3 className="text-base font-semibold">{title}</h3>
        <p className="mt-1 text-sm text-muted-foreground">{description}</p>
      </div>
      {children}
    </section>
  );
}

function InfoBlock({ label, children }: { label: string; children: ReactNode }): JSX.Element {
  return (
    <div className="min-w-0 rounded-md border border-[hsl(var(--hairline))] bg-[hsl(var(--surface-sunken))]/35 p-3 text-sm">
      <div className="mb-1 text-xs text-muted-foreground">{label}</div>
      <div className="min-w-0 truncate">{children}</div>
    </div>
  );
}

function releaseModeDefinitions(
  discovery: ReleaseStrategyDiscovery | null,
  draft: Pick<SiteDraft, 'composeProject' | 'publicDirectory'>,
): ReleaseStrategyCandidate[] {
  const detected = new Map((discovery?.candidates || []).map((candidate) => [candidate.mode, candidate]));
  const fallbacks: ReleaseStrategyCandidate[] = [
    {
      mode: 'existing-script',
      label: '项目现有脚本',
      description: '执行仓库已经维护的发布命令，CDS 负责预检、日志、入口探测和版本记录。',
      confidence: 'manual',
      strategy: { mode: 'existing-script', command: './deploy.sh' },
      requirements: ['项目已有可执行发布脚本'],
    },
    {
      mode: 'generated-compose',
      label: 'CDS 动态 Compose 发布',
      description: '项目没有发布脚本也能发布；CDS 为指定 commit 建隔离 worktree，并动态生成 Compose 执行脚本。',
      confidence: 'manual',
      strategy: { mode: 'generated-compose', composeFile: 'compose.yml', composeProject: draft.composeProject },
      requirements: ['远端安装 Git、Docker、Docker Compose'],
    },
    {
      mode: 'generated-static',
      label: 'CDS 动态静态站发布',
      description: '动态构建、离线验证 HTML 与入口资源、归一权限、原子切换 current 并保留 previous。',
      confidence: 'manual',
      strategy: {
        mode: 'generated-static',
        buildCommand: 'pnpm install --frozen-lockfile && pnpm build',
        artifactDirectory: 'dist',
        publicDirectory: draft.publicDirectory,
      },
      requirements: ['远端安装 Git、Bash、Python 3 与项目构建依赖'],
    },
  ];
  return fallbacks.map((fallback) => detected.get(fallback.mode) || fallback);
}

function applyDiscoveredStrategy(draft: SiteDraft, strategy: ReleaseStrategy): SiteDraft {
  return {
    ...draft,
    strategyMode: strategy.mode,
    deployCommand: strategy.command || draft.deployCommand,
    composeFile: strategy.composeFile || draft.composeFile,
    composeProject: strategy.composeProject || draft.composeProject,
    buildCommand: strategy.buildCommand || draft.buildCommand,
    artifactDirectory: strategy.artifactDirectory || draft.artifactDirectory,
    publicDirectory: strategy.publicDirectory || draft.publicDirectory,
    detectedFrom: strategy.detectedFrom || [],
  };
}

function strategyFromDraft(draft: SiteDraft): ReleaseStrategy {
  if (draft.strategyMode === 'existing-script') {
    return { mode: 'existing-script', command: draft.deployCommand.trim(), detectedFrom: draft.detectedFrom };
  }
  if (draft.strategyMode === 'generated-compose') {
    return {
      mode: 'generated-compose',
      composeFile: draft.composeFile.trim(),
      composeProject: draft.composeProject.trim(),
      detectedFrom: draft.detectedFrom,
    };
  }
  return {
    mode: 'generated-static',
    buildCommand: draft.buildCommand.trim(),
    artifactDirectory: draft.artifactDirectory.trim(),
    publicDirectory: draft.publicDirectory.trim(),
    detectedFrom: draft.detectedFrom,
  };
}

function isDraftStrategyComplete(draft: SiteDraft): boolean {
  if (draft.strategyMode === 'existing-script') return Boolean(draft.deployCommand.trim());
  if (draft.strategyMode === 'generated-compose') return Boolean(draft.composeFile.trim() && draft.composeProject.trim());
  return Boolean(draft.buildCommand.trim() && draft.artifactDirectory.trim() && draft.publicDirectory.startsWith('/'));
}

function releaseModeLabel(mode: ReleaseExecutionMode): string {
  if (mode === 'generated-compose') return 'CDS 动态 Compose 发布';
  if (mode === 'generated-static') return 'CDS 动态静态站发布';
  return '项目现有脚本';
}

function Field({ label, value, onChange, placeholder }: { label: string; value: string; onChange: (value: string) => void; placeholder?: string }): JSX.Element {
  return (
    <label className="grid gap-1 text-sm">
      <span className="text-muted-foreground">{label}</span>
      <input
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        className="h-9 rounded-md border border-[hsl(var(--hairline))] bg-[hsl(var(--surface-sunken))] px-3 text-sm outline-none focus:border-primary/60"
      />
    </label>
  );
}

function StatusPill({ status }: { status: string }): JSX.Element {
  const label = statusLabel(status);
  const tone = status.includes('failed') || status === 'failed'
    ? 'border-red-500/35 bg-red-500/10 text-red-500'
    : status.includes('running') || status === 'queued' || status === 'healthchecking'
      ? 'border-sky-500/35 bg-sky-500/10 text-sky-500'
      : status === 'success' || status === 'healthy' || status === 'rollback_success' || status === '可用'
        ? 'border-emerald-500/35 bg-emerald-500/10 text-emerald-500'
        : 'border-[hsl(var(--hairline))] bg-[hsl(var(--surface-sunken))] text-muted-foreground';
  return <span className={`inline-flex h-7 items-center rounded-md border px-2 text-xs font-medium ${tone}`}>{label}</span>;
}

function CodeText({ children }: { children: string }): JSX.Element {
  return <span className="font-mono text-xs text-muted-foreground">{children}</span>;
}

function toSiteView(row: CenterRow): SiteView {
  const target = row.target;
  const ssh = target.ssh;
  const healthUrl = ssh?.healthcheckUrl || '';
  const successfulRuns = row.successfulRuns || [];
  const rollbackCommand = ssh?.rollbackCommand?.trim();
  return {
    id: target.id,
    target,
    name: target.name || '未命名站点',
    serverLabel: ssh ? `${ssh.user}@${ssh.host}:${ssh.port}` : '-',
    hostLabel: ssh?.host || '-',
    sitePath: ssh?.appPath || '-',
    publicUrl: publicUrlFromHealth(healthUrl),
    healthUrl,
    deployScripts: target.strategy?.mode === 'generated-compose'
      ? [`动态脚本 · ${target.strategy.composeFile || 'compose.yml'}`]
      : target.strategy?.mode === 'generated-static'
        ? [`动态脚本 · ${target.strategy.buildCommand || '静态构建'}`, `原子切换 · ${target.strategy.publicDirectory || '-'}/current`]
        : scriptsFromCommand(target.strategy?.command || ssh?.deployCommand || ''),
    currentVersion: row.currentVersion,
    currentCommit: row.currentCommit,
    lastReleasedAt: row.lastReleasedAt,
    healthStatus: row.healthStatus,
    health: row.health,
    responseTimeMs: row.health?.responseTimeMs,
    checkedAt: row.health?.checkedAt,
    healthMessage: row.health?.status === 'failed' ? row.health.message : '',
    lastOperator: row.lastOperator,
    latestRun: row.latestRun,
    canRollback: row.canRollback,
    rollbackMethod: rollbackCommand ? `执行 ${rollbackCommand}` : '重新发布历史成功版本',
    successfulRuns,
    rollbackDefaultReleaseId: row.rollbackDefaultReleaseId || successfulRuns[0]?.releaseId || '',
    isEnabled: target.isEnabled,
    releaseMethod: releaseModeLabel(target.strategy?.mode || 'existing-script'),
    projectLabel: target.projectIdentity?.repository
      ? `${target.projectIdentity.projectSlug} · ${target.projectIdentity.repository}`
      : target.projectIdentity?.projectSlug || target.projectId,
    isCanonical: target.isCanonical === true,
  };
}

function draftFromTarget(target: ReleaseTarget): SiteDraft {
  const ssh = target.ssh;
  const health = splitHealthUrl(ssh?.healthcheckUrl || '');
  const strategy = target.strategy || { mode: 'existing-script' as const, command: ssh?.deployCommand || DEFAULT_DEPLOY_COMMAND };
  return {
    id: target.id,
    projectId: target.projectId,
    name: target.name,
    privateKeyRef: ssh?.privateKeyRef || '',
    host: ssh?.host || '',
    port: String(ssh?.port || 22),
    user: ssh?.user || '',
    sitePath: ssh?.appPath || DEFAULT_SITE_PATH,
    publicUrl: health.publicUrl,
    healthPath: health.healthPath,
    rollbackCommand: ssh?.rollbackCommand || '',
    deployCommand: ssh?.deployCommand || DEFAULT_DEPLOY_COMMAND,
    healthcheckUrl: ssh?.healthcheckUrl || '',
    strategyMode: strategy.mode,
    composeFile: strategy.composeFile || 'compose.yml',
    composeProject: strategy.composeProject || `${target.projectId}-prod`,
    buildCommand: strategy.buildCommand || 'pnpm install --frozen-lockfile && pnpm build',
    artifactDirectory: strategy.artifactDirectory || 'dist',
    publicDirectory: strategy.publicDirectory || `/opt/${target.projectId}-web`,
    detectedFrom: strategy.detectedFrom || [],
    isCanonical: target.isCanonical === true,
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
    environment: 'production',
    isCanonical: draft.isCanonical,
    strategy: strategyFromDraft(draft),
  };
}

function buildHealthcheckUrl(draft: SiteDraft): string {
  return buildReleaseHealthcheckUrl(draft.publicUrl, draft.healthPath, draft.healthcheckUrl);
}

function publicUrlFromHealth(value: string): string {
  return normalizeProductionOrigin(value);
}

function splitHealthUrl(value: string): { publicUrl: string; healthPath: string } {
  if (!value) return { publicUrl: '', healthPath: DEFAULT_HEALTH_PATH };
  try {
    const url = new URL(value);
    return { publicUrl: `${url.protocol}//${url.host}`, healthPath: `${url.pathname || '/'}${url.search || ''}` };
  } catch {
    return { publicUrl: value, healthPath: DEFAULT_HEALTH_PATH };
  }
}

function scriptsFromCommand(command: string): string[] {
  if (!command.trim()) return SCRIPT_LABELS;
  if (command.includes('local-prod-release.sh')) return ['本机生产发布'];
  const normalized = command.replace(/&&/g, '\n').replace(/;/g, '\n');
  const found = normalized.split('\n').map((item) => item.trim()).filter(Boolean)
    .filter((item) => item.includes('fast.sh') || item.includes('exec_dep.sh'));
  if (found.length > 0) return found.map((item) => item.replace(/^\.?\//, './'));
  return [command.trim()];
}

interface StepState {
  id: string;
  label: string;
  state: 'pending' | 'running' | 'done' | 'failed';
  detail?: string;
}

function releaseSteps(run: ReleaseRun): StepState[] {
  const failed = run.status.includes('failed');
  const phaseSet = new Set(run.logs.map((log) => log.phase).filter(Boolean));
  const failedPhase = [...run.logs].reverse().find((log) => log.level === 'error')?.phase;
  const fastPhase = releaseScriptPhase('./fast.sh');
  const execPhase = releaseScriptPhase('./exec_dep.sh');
  const fastSeen = phaseSet.has(fastPhase);
  const execSeen = phaseSet.has(execPhase);
  const customDeploySeen = phaseSet.has('deploy') && !fastSeen && !execSeen;
  const healthSeen = phaseSet.has('healthcheck');
  const success = run.status === 'success' || run.status === 'rollback_success';
  const base: StepState[] = customDeploySeen ? [
    { id: 'connect', label: '连接服务器', state: phaseSet.has('connect') ? 'done' : 'pending' },
    { id: 'path', label: '进入站点目录', state: phaseSet.has('prepare') || customDeploySeen || healthSeen || success ? 'done' : 'pending' },
    { id: 'deploy', label: '执行本机生产发布', state: failedPhase === 'deploy' ? 'failed' : healthSeen || success ? 'done' : customDeploySeen ? 'running' : 'pending' },
    { id: 'health', label: '检查上线地址', state: failedPhase === 'healthcheck' ? 'failed' : healthSeen ? (failed ? 'failed' : 'done') : 'pending' },
    { id: 'record', label: '标记完成', state: success ? 'done' : 'pending' },
  ] : [
    { id: 'connect', label: '连接服务器', state: phaseSet.has('connect') ? 'done' : 'pending' },
    { id: 'path', label: '进入站点目录', state: phaseSet.has('prepare') || fastSeen || execSeen || healthSeen || success ? 'done' : 'pending' },
    { id: 'fast', label: '执行 fast.sh', state: failedPhase === fastPhase ? 'failed' : execSeen || healthSeen || success ? 'done' : fastSeen ? 'running' : 'pending' },
    { id: 'exec', label: '执行 exec_dep.sh', state: failedPhase === execPhase ? 'failed' : healthSeen || success ? 'done' : execSeen ? 'running' : 'pending' },
    { id: 'health', label: '检查上线地址', state: failedPhase === 'healthcheck' ? 'failed' : healthSeen ? (failed ? 'failed' : 'done') : 'pending' },
    { id: 'record', label: '标记完成', state: success ? 'done' : 'pending' },
  ];
  if (failed) {
    const hasLocatedFailure = base.some((step) => step.state === 'failed');
    if (!hasLocatedFailure) {
      const lastDone = [...base].reverse().find((step) => step.state === 'done');
      const next = base.find((step) => step.state === 'running' || step.state === 'pending');
      if (next) next.state = 'failed';
      if (!next && lastDone) lastDone.state = 'failed';
    }
  } else if (!isTerminal(run.status)) {
    const next = base.find((step) => step.state === 'running' || step.state === 'pending');
    if (next) next.state = 'running';
  }
  return base;
}

function releaseScriptPhase(script: string): string {
  return `script:${script.replace(/^\.\//, '').replace(/[^A-Za-z0-9._-]/g, '-')}`;
}

function dedupeLogs(items: ReleaseLogEntry[]): ReleaseLogEntry[] {
  const bySeq = new Map<number, ReleaseLogEntry>();
  for (const item of items) bySeq.set(item.seq, item);
  return [...bySeq.values()].sort((a, b) => a.seq - b.seq);
}

function formatDate(value?: string): string {
  if (!value) return '-';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
}

function formatResponseTime(value?: number): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '-';
  return `${value} ms`;
}

function formatTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleTimeString();
}

function defaultRollbackVersionId(site: SiteView, sourceRun: ReleaseRun): string {
  const versions = site.successfulRuns;
  if (versions.length === 0) return '';
  if (site.rollbackDefaultReleaseId && versions.some((run) => run.releaseId === site.rollbackDefaultReleaseId)) {
    return site.rollbackDefaultReleaseId;
  }
  const sourceTs = new Date(sourceRun.startedAt).getTime();
  const previous = versions.find((run) => run.releaseId !== sourceRun.releaseId && new Date(run.startedAt).getTime() < sourceTs);
  return previous?.releaseId || versions.find((run) => run.releaseId !== sourceRun.releaseId)?.releaseId || versions[0].releaseId;
}

function statusLabel(status: string): string {
  const map: Record<string, string> = {
    healthy: '健康',
    unknown: '未知',
    queued: '排队中',
    running: '发布中',
    healthchecking: '检查上线地址',
    success: '发布成功',
    failed: '发布失败',
    rollback_running: '回滚中',
    rollback_success: '回滚成功',
    rollback_failed: '回滚失败',
    可用: '可用',
    已停用: '已停用',
  };
  return map[status] || status;
}

function isTerminal(status: string): boolean {
  return ['success', 'failed', 'rollback_success', 'rollback_failed'].includes(status);
}

function parseSseJson<T>(event: Event): T | null {
  try {
    return JSON.parse((event as MessageEvent).data) as T;
  } catch {
    return null;
  }
}

const wizardSteps: Array<{ id: WizardStep; label: string }> = [
  { id: 'server', label: '选择服务器' },
  { id: 'site', label: '生产域名' },
  { id: 'scripts', label: '发布方式' },
  { id: 'health', label: '健康检查' },
];
