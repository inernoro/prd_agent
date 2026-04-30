import { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertCircle, CheckCircle2, Clock, Copy, ExternalLink, Loader2, Play, RefreshCw, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { apiRequest, ApiError } from '@/lib/api';
import { ErrorBlock, LoadingBlock } from '@/pages/cds-settings/components';
import { ActiveDeployment } from '@/components/deployment/ActiveDeployment';
import { HistoryRow } from '@/components/deployment/HistoryRow';

/*
 * BranchDetailDrawer — right-side slide-in showing the most-used parts
 * of BranchDetailPage without leaving the current page.
 *
 * Why exists: user feedback — "能在一个页面完成的，切勿跳转页面"。
 * Clicking "详情" on a BranchCard now slides this drawer over the
 * branch list grid instead of router-pushing to /branch-panel/<id>.
 *
 * What it loads:
 *   - GET /api/branches/:id              → branch + services
 *   - GET /api/branches/:id/logs         → recent build/run logs (last 5)
 *
 * Escape hatch: header has "完整页面" link → /branch-panel/<id> for the
 * dedicated page when the user wants the full set of tabs.
 */

interface ServiceState {
  profileId: string;
  containerName: string;
  hostPort: number;
  status: 'idle' | 'building' | 'starting' | 'running' | 'restarting' | 'stopping' | 'stopped' | 'error';
  errorMessage?: string;
}

interface BranchDetailData {
  id: string;
  projectId: string;
  branch: string;
  status: string;
  services: Record<string, ServiceState>;
  commitSha?: string;
  subject?: string;
  lastDeployAt?: string;
  errorMessage?: string;
}

interface OperationLogEvent {
  step: string;
  status: string;
  title?: string;
  log?: string;
}

interface OperationLog {
  type: string;
  startedAt: string;
  finishedAt?: string;
  status: 'running' | 'completed' | 'error';
  events: OperationLogEvent[];
}

interface ServiceLogsState {
  status: 'idle' | 'loading' | 'ok' | 'error';
  profileId?: string;
  logs?: string;
  message?: string;
}

interface DrawerActivityEvent {
  id?: number;
  ts?: string;
  method?: string;
  path?: string;
  status?: number;
  duration?: number;
  type?: 'cds' | 'web';
  branchId?: string;
  profileId?: string;
  label?: string;
}

interface BuildLogSelection {
  title: string;
  status: string;
  commitSha?: string;
  startedAt?: number | string;
  message?: string;
  lines: string[];
}

export interface BranchDeploymentItem {
  key: string;
  branchId: string;
  branchName: string;
  commitSha?: string;
  kind: 'preview' | 'deploy' | 'pull' | 'stop' | 'create' | 'favorite' | 'reset' | 'delete';
  status: 'running' | 'success' | 'error';
  message: string;
  log: string[];
  startedAt: number;
  finishedAt?: number;
  lastStep?: string;
  phase?: string;
  suggestion?: string;
}

type DrawerTab = 'overview' | 'deployments' | 'services' | 'logs' | 'httpLogs' | 'variables' | 'metrics' | 'settings';
type LogsMode = 'build' | 'container';

const drawerTabs: Array<{ key: DrawerTab; label: string; planned?: boolean }> = [
  { key: 'overview', label: '详情' },
  { key: 'deployments', label: '部署' },
  { key: 'services', label: '服务' },
  { key: 'logs', label: '日志' },
  { key: 'httpLogs', label: 'HTTP' },
  { key: 'variables', label: '变量', planned: true },
  { key: 'metrics', label: '指标', planned: true },
  { key: 'settings', label: '设置', planned: true },
];

function plannedLabel(tab: DrawerTab): string {
  return ({
    variables: '变量面板',
    metrics: '指标面板',
    settings: '设置面板',
    deployments: '部署面板',
    logs: '日志面板',
    httpLogs: 'HTTP 日志',
    services: '服务面板',
    overview: '概览面板',
  } as Record<DrawerTab, string>)[tab];
}

function DrawerTabButton({
  tab,
  active,
  onClick,
}: {
  tab: { key: DrawerTab; label: string; planned?: boolean };
  active: boolean;
  onClick: () => void;
}): JSX.Element {
  return (
    <button
      type="button"
      className={`relative inline-flex h-11 shrink-0 items-center gap-2 px-3 text-sm transition-colors ${
        active ? 'text-foreground' : 'text-muted-foreground hover:text-foreground'
      }`}
      onClick={onClick}
    >
      {tab.label}
      {tab.planned ? <span className="rounded border border-[hsl(var(--hairline))] px-1.5 py-0.5 text-[10px] text-muted-foreground">计划</span> : null}
      {active ? <span className="absolute inset-x-2 bottom-0 h-px bg-primary" /> : null}
    </button>
  );
}

function statusLabel(s: string): string {
  return ({
    idle: '未运行', building: '构建中', starting: '启动中', running: '运行中',
    restarting: '重启中', stopping: '停止中', stopped: '已停止', error: '异常',
  } as Record<string, string>)[s] || s;
}

function statusClass(s: string): string {
  if (s === 'running') return 'border-emerald-500/30 bg-emerald-500/10 text-emerald-600';
  if (s === 'building' || s === 'starting' || s === 'restarting') return 'border-sky-500/30 bg-sky-500/10 text-sky-600';
  if (s === 'error') return 'border-destructive/30 bg-destructive/10 text-destructive';
  return 'border-[hsl(var(--hairline))] bg-muted/40 text-muted-foreground';
}

function deploymentStatusClass(status: BranchDeploymentItem['status']): string {
  if (status === 'running') return 'border-sky-500/30 bg-sky-500/10 text-sky-500';
  if (status === 'success') return 'border-emerald-500/30 bg-emerald-500/10 text-emerald-600';
  return 'border-destructive/30 bg-destructive/10 text-destructive';
}

function deploymentKindLabel(kind: BranchDeploymentItem['kind']): string {
  return ({
    preview: '预览部署',
    deploy: '部署',
    pull: '拉取',
    stop: '停止',
    create: '创建分支',
    favorite: '收藏',
    reset: '重置',
    delete: '删除',
  } as Record<BranchDeploymentItem['kind'], string>)[kind];
}

function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return rest ? `${minutes}m ${rest}s` : `${minutes}m`;
}

function deploymentStages(log: string[]): string[] {
  const stages = new Set<string>();
  for (const line of log) {
    if (/代码|clone|checkout|git|pull/i.test(line)) stages.add('代码');
    if (/容器|docker|image|镜像/i.test(line)) stages.add('容器');
    if (/构建|build|install|compile|tsc|npm|pnpm|dotnet/i.test(line)) stages.add('构建');
    if (/运行|启动|run|listen|health/i.test(line)) stages.add('执行');
  }
  return Array.from(stages);
}

function eventText(event: OperationLogEvent): string {
  return `[${event.status}] ${event.title || event.step}${event.log ? ` - ${event.log}` : ''}`;
}

function logFailureReason(log: OperationLog): string {
  const error = log.events.slice().reverse().find((event) => event.status === 'error' || event.log);
  return error ? eventText(error) : '';
}

function branchFailureReason(branch: BranchDetailData): string {
  if (branch.errorMessage) return branch.errorMessage;
  const failed = Object.values(branch.services || {}).filter((svc) => svc.status === 'error');
  if (failed.length === 0) return '';
  return failed.map((svc) => `${svc.profileId}: ${svc.errorMessage || '启动失败'}`).join('\n');
}

const ACTIVE_DEPLOYMENT_TAIL_MS = 60_000;

function legacyLogToDeploymentItem(log: OperationLog, branchId: string): BranchDeploymentItem {
  const events = log.events || [];
  const lines = events.map(eventText);
  const finishedAt = log.finishedAt ? new Date(log.finishedAt).getTime() : undefined;
  const startedAt = log.startedAt ? new Date(log.startedAt).getTime() : Date.now();
  const status: BranchDeploymentItem['status'] = log.status === 'completed'
    ? 'success'
    : log.status === 'error'
      ? 'error'
      : 'running';
  const lastStep = events.length > 0 ? eventText(events[events.length - 1]) : log.type;
  const message = logFailureReason(log) || lastStep;
  return {
    key: `legacy-${log.startedAt}-${log.type}`,
    branchId,
    branchName: '',
    kind: 'deploy',
    status,
    message,
    log: lines,
    startedAt,
    finishedAt,
    lastStep,
  };
}

/**
 * PreviewUrlChip — running 时显示 production URL,一键复制 + 在新窗口打开。
 * 用户 2026-04-30 反馈:成功后 URL 必须在显眼位置,不能让用户去 Drawer
 * 「部署」tab 才看到。Week 4.8 Round 4b 实现。
 */
function PreviewUrlChip({ url }: { url: string }): JSX.Element {
  const [copied, setCopied] = useState(false);
  // 显示用版本:去掉 protocol 前缀,更清爽
  const display = url.replace(/^https?:\/\//, '');
  const copy = () => {
    void navigator.clipboard.writeText(url).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    });
  };
  return (
    <div className="mt-3 flex items-center gap-2 rounded-md border border-emerald-500/30 bg-emerald-500/5 px-3 py-2">
      <ExternalLink className="h-3.5 w-3.5 shrink-0 text-emerald-600" />
      <a
        href={url}
        target="_blank"
        rel="noopener noreferrer"
        className="min-w-0 flex-1 truncate font-mono text-xs text-emerald-700 hover:underline dark:text-emerald-400"
        title={url}
      >
        {display}
      </a>
      <Button
        type="button"
        size="sm"
        variant="ghost"
        className="h-6 shrink-0 px-2 text-xs"
        onClick={copy}
        aria-label="复制预览地址"
      >
        {copied ? <CheckCircle2 className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
        {copied ? '已复制' : '复制'}
      </Button>
    </div>
  );
}

function pickActiveDeployment(items: BranchDeploymentItem[], now: number): BranchDeploymentItem | null {
  if (items.length === 0) return null;
  const sorted = items.slice().sort((left, right) => right.startedAt - left.startedAt);
  // running 优先
  const running = sorted.find((item) => item.status === 'running');
  if (running) return running;
  // 最近 60s 内结束的最近一条也当作 active
  const recent = sorted.find((item) => {
    if (!item.finishedAt) return false;
    return now - item.finishedAt <= ACTIVE_DEPLOYMENT_TAIL_MS;
  });
  if (recent) return recent;
  // 否则第一条（按时间倒序的最新）
  return sorted[0];
}

export function BranchDetailDrawer({
  branchId,
  projectId,
  open,
  onClose,
  deployments = [],
  activityEvents = [],
  now = Date.now(),
  previewUrl = '',
  branchStatus,
}: {
  branchId: string | null;
  projectId: string;
  open: boolean;
  onClose: () => void;
  deployments?: BranchDeploymentItem[];
  activityEvents?: DrawerActivityEvent[];
  now?: number;
  /**
   * Production preview URL precomputed at the caller (so the Drawer
   * doesn't have to load /api/config independently). Empty string =
   * no preview available (eg. running on simple mode without main
   * domain configured). Drawer 仅在 running 时显示 URL chip。
   */
  previewUrl?: string;
  /**
   * Branch status at the time of opening, used to decide whether to
   * actually render the URL chip (only running). The Drawer also has
   * its own `branch.status` after load — this prop covers the gap
   * between drawer-open and load completion.
   */
  branchStatus?: string;
}): JSX.Element | null {
  const [branch, setBranch] = useState<BranchDetailData | null>(null);
  const [logs, setLogs] = useState<OperationLog[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [activeTab, setActiveTab] = useState<DrawerTab>('deployments');
  const [logsMode, setLogsMode] = useState<LogsMode>('build');
  const [selectedBuildLog, setSelectedBuildLog] = useState<BuildLogSelection | null>(null);
  const [selectedServiceId, setSelectedServiceId] = useState<string | null>(null);
  const [serviceLogs, setServiceLogs] = useState<ServiceLogsState>({ status: 'idle' });
  const [logQuery, setLogQuery] = useState('');
  const [showAllHistory, setShowAllHistory] = useState(false);

  const load = useCallback(async () => {
    if (!branchId) return;
    setLoading(true);
    setError('');
    try {
      // The backend exposes /api/branches?project=<id> (list) but no
      // single-branch endpoint, mirroring how BranchDetailPage loads.
      const [branchesRes, logsRes] = await Promise.all([
        apiRequest<{ branches: BranchDetailData[] }>(`/api/branches?project=${encodeURIComponent(projectId)}`),
        apiRequest<{ logs: OperationLog[] }>(`/api/branches/${encodeURIComponent(branchId)}/logs`).catch(() => ({ logs: [] })),
      ]);
      const found = (branchesRes.branches || []).find((b) => b.id === branchId);
      if (!found) {
        setError('branch_not_found');
        setBranch(null);
      } else {
        setBranch(found);
      }
      setLogs(logsRes.logs || []);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [branchId, projectId]);

  useEffect(() => {
    if (!open || !branchId) return;
    setActiveTab('deployments');
    setLogsMode('build');
    setSelectedBuildLog(null);
    setSelectedServiceId(null);
    setServiceLogs({ status: 'idle' });
    setLogQuery('');
    setShowAllHistory(false);
    void load();
  }, [open, branchId, load]);

  const loadServiceLogs = useCallback(async (profileId: string) => {
    if (!branchId) return;
    setSelectedServiceId(profileId);
    setServiceLogs({ status: 'loading', profileId });
    try {
      const res = await apiRequest<{ logs: string }>(`/api/branches/${encodeURIComponent(branchId)}/container-logs`, {
        method: 'POST',
        body: { profileId },
      });
      setServiceLogs({ status: 'ok', profileId, logs: res.logs || '' });
    } catch (err) {
      const message = err instanceof ApiError ? err.message : String(err);
      setServiceLogs({ status: 'error', profileId, message });
    }
  }, [branchId]);

  const visibleDeployments = useMemo(() => {
    const scoped = deployments.filter((item) => item.branchId === branchId);
    return scoped.sort((left, right) => right.startedAt - left.startedAt);
  }, [branchId, deployments]);

  const combinedDeployments = useMemo<BranchDeploymentItem[]>(() => {
    if (!branchId) return visibleDeployments;
    const legacy = logs
      .slice()
      .reverse()
      .slice(0, 6)
      .map((log) => legacyLogToDeploymentItem(log, branchId));
    const all = [...visibleDeployments, ...legacy];
    return all.sort((left, right) => right.startedAt - left.startedAt);
  }, [branchId, visibleDeployments, logs]);

  const activeDeployment = useMemo(
    () => pickActiveDeployment(combinedDeployments, now),
    [combinedDeployments, now],
  );

  const historyDeployments = useMemo<BranchDeploymentItem[]>(() => {
    if (!activeDeployment) return combinedDeployments;
    return combinedDeployments.filter((item) => item.key !== activeDeployment.key);
  }, [activeDeployment, combinedDeployments]);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = previousOverflow;
    };
  }, [open, onClose]);

  const services = branch ? Object.values(branch.services || {}) : [];
  const selectedService = services.find((svc) => svc.profileId === selectedServiceId) || services[0] || null;
  const fullPageHref = `/branch-panel/${encodeURIComponent(branchId || '')}?project=${encodeURIComponent(projectId)}`;
  const currentFailureReason = branch ? branchFailureReason(branch) : '';
  const visibleActivityEvents = useMemo(() => {
    if (!branch) return [];
    return activityEvents
      .filter((event) => (
        event.type === 'web' &&
        (event.branchId === branch.id || (selectedService?.profileId && event.profileId === selectedService.profileId))
      ))
      .slice(-80)
      .reverse();
  }, [activityEvents, branch, selectedService?.profileId]);

  useEffect(() => {
    if (!open || (activeTab !== 'services' && (activeTab !== 'logs' || logsMode !== 'container')) || !selectedService || serviceLogs.profileId === selectedService.profileId) return;
    void loadServiceLogs(selectedService.profileId);
  }, [activeTab, loadServiceLogs, logsMode, open, selectedService, serviceLogs.profileId]);

  const openBuildLogs = useCallback((selection?: BuildLogSelection) => {
    setSelectedBuildLog(selection || null);
    setLogsMode('build');
    setActiveTab('logs');
  }, []);

  const openDeploymentBuildLogs = useCallback((deployment: BranchDeploymentItem) => {
    openBuildLogs({
      title: `${deployment.branchName} / ${deploymentKindLabel(deployment.kind)}`,
      status: deployment.status,
      commitSha: deployment.commitSha,
      startedAt: deployment.startedAt,
      message: deployment.message,
      lines: deployment.log.length > 0 ? deployment.log : [deployment.lastStep || deployment.message],
    });
  }, [openBuildLogs]);

  /*
   * Reset / retry CTAs for ActiveDeployment (Week 4.8 Round 4c).
   * 之前 ActiveDeployment 的 onResetError / onRetryDiagnosis 是 optional
   * 但从未传入 → deploy/verify 失败时按钮不渲染。这一刀把这两个 callback
   * 接到 Drawer,真实调用后端并 reload。
   */
  const resetBranchError = useCallback(async (_deployment: BranchDeploymentItem) => {
    if (!branchId) return;
    try {
      await apiRequest(`/api/branches/${encodeURIComponent(branchId)}/reset`, { method: 'POST' });
      await load();
    } catch (err) {
      // 失败时把错误吞回 error state,Drawer 顶部会显示
      setError(err instanceof ApiError ? err.message : String(err));
    }
  }, [branchId, load]);

  const retryRuntimeDiagnosis = useCallback(async (_deployment: BranchDeploymentItem) => {
    if (!branchId) return;
    // 优先使用当前选中服务,否则用第一个 error 状态服务,再不行用第一个服务
    const errorSvc = Object.values(branch?.services || {}).find((s) => s.status === 'error');
    const fallbackSvc = Object.values(branch?.services || {})[0];
    const target = selectedService?.profileId || errorSvc?.profileId || fallbackSvc?.profileId;
    if (!target) {
      setError('没有可诊断的服务');
      return;
    }
    try {
      await apiRequest(
        `/api/branches/${encodeURIComponent(branchId)}/verify-runtime/${encodeURIComponent(target)}`,
        { method: 'POST' },
      );
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    }
  }, [branchId, branch, load, selectedService]);

  const copyDeploymentDiagnosis = useCallback(async (deployment: BranchDeploymentItem) => {
    const lines = [
      `分支：${deployment.branchName || branch?.branch || ''}`,
      `状态：${deployment.status}`,
      deployment.commitSha ? `Commit：${deployment.commitSha.slice(0, 7)}` : '',
      deployment.message ? `摘要：${deployment.message}` : '',
      '',
      ...(deployment.log || []).slice(-40),
    ].filter(Boolean);
    try {
      await navigator.clipboard.writeText(lines.join('\n'));
    } catch {
      // ignore — clipboard 可能在沙箱环境下不可用
    }
  }, [branch]);

  const openContainerLogs = useCallback((profileId?: string) => {
    const target = profileId || selectedService?.profileId;
    setLogsMode('container');
    setActiveTab('logs');
    if (target) {
      void loadServiceLogs(target);
    }
  }, [loadServiceLogs, selectedService?.profileId]);

  if (!open || !branchId) return null;

  return (
    <div className="fixed inset-0 z-50 flex" role="dialog" aria-modal="true" aria-label="分支详情">
      <button
        type="button"
        className="absolute inset-0 z-0 bg-transparent"
        onClick={onClose}
        aria-label="关闭分支详情"
      />
      <div
        className="cds-drawer-anim relative z-10 ml-auto flex h-full w-full max-w-[640px] flex-col border-l border-[hsl(var(--hairline))] bg-[hsl(var(--surface-base))] shadow-2xl"
        style={{ minHeight: 0 }}
      >
        <header className="flex h-14 shrink-0 items-center justify-between gap-3 border-b border-[hsl(var(--hairline))] px-4">
          <div className="flex min-w-0 items-center gap-2">
            <span className="text-sm font-semibold">分支详情</span>
            {branch ? (
              <>
                <span className="text-muted-foreground/60">·</span>
                <span className="min-w-0 truncate font-mono text-xs">{branch.branch}</span>
              </>
            ) : null}
          </div>
          <div className="flex items-center gap-1">
            <Button asChild variant="ghost" size="sm" title="完整页面">
              <a href={fullPageHref}>
                <ExternalLink />
                完整页面
              </a>
            </Button>
            <Button variant="ghost" size="icon" onClick={() => void load()} title="刷新" aria-label="刷新">
              <RefreshCw />
            </Button>
            <Button variant="ghost" size="icon" onClick={onClose} title="关闭" aria-label="关闭">
              <X />
            </Button>
          </div>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto" style={{ overscrollBehavior: 'contain' }}>
          {loading && !branch ? <LoadingBlock label="加载分支详情" /> : null}
          {error ? <div className="p-5"><ErrorBlock message={error} /></div> : null}
          {branch ? (
            <>
              <section className="border-b border-[hsl(var(--hairline))] px-5 py-4">
                <div className="flex flex-wrap items-center gap-2">
                  <span className={`rounded border px-2 py-0.5 text-xs ${statusClass(branch.status)}`}>{statusLabel(branch.status)}</span>
                  {branch.commitSha ? <span className="font-mono text-xs text-muted-foreground">{branch.commitSha.slice(0, 7)}</span> : null}
                  <span className="text-xs text-muted-foreground">服务 {services.filter((svc) => svc.status === 'running').length}/{services.length}</span>
                </div>
                {/*
                  Production URL chip (Week 4.8 Round 4b, 用户主诉求"运行中
                  绿点旁边没有 URL"):running 时显眼显示 production 域名,
                  hover 出复制按钮,点击在新窗口打开。失败/未运行时不渲染。
                */}
                {(branch.status === 'running' || branchStatus === 'running') && previewUrl ? (
                  <PreviewUrlChip url={previewUrl} />
                ) : null}
                {branch.subject ? (
                  <p className="mt-2 line-clamp-2 text-sm leading-6 text-muted-foreground">{branch.subject}</p>
                ) : null}
                {currentFailureReason ? (
                  <div className="mt-3 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs leading-5 text-destructive">
                    <div className="font-semibold">最近失败原因</div>
                    <div className="mt-1 whitespace-pre-wrap text-destructive/90">{currentFailureReason}</div>
                  </div>
                ) : null}
              </section>

              <nav className="sticky top-0 z-10 flex gap-1 overflow-x-auto border-b border-[hsl(var(--hairline))] bg-[hsl(var(--surface-base))] px-3">
                {drawerTabs.map((tab) => (
                  <DrawerTabButton key={tab.key} tab={tab} active={activeTab === tab.key} onClick={() => setActiveTab(tab.key)} />
                ))}
              </nav>

              <div className="p-5">
                {activeTab === 'deployments' ? (
                  <div className="space-y-4">
                    {!activeDeployment && historyDeployments.length === 0 ? (
                      <section className="cds-surface-raised cds-hairline rounded-md border border-dashed border-[hsl(var(--hairline))] px-4 py-8 text-center text-sm text-muted-foreground">
                        还没有构建记录。点击部署后，构建计划和日志会出现在这里。
                      </section>
                    ) : null}

                    {activeDeployment ? (
                      <ActiveDeployment
                        deployment={activeDeployment}
                        projectId={projectId}
                        branchErrorMessage={currentFailureReason || undefined}
                        now={now}
                        onOpenLogs={openDeploymentBuildLogs}
                        onCopyDiagnosis={(item) => void copyDeploymentDiagnosis(item)}
                        onResetError={(item) => void resetBranchError(item)}
                        onRetryDiagnosis={(item) => void retryRuntimeDiagnosis(item)}
                      />
                    ) : null}

                    {historyDeployments.length > 0 ? (
                      <section>
                        <header className="mb-2 flex items-center justify-between gap-3 px-1">
                          <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                            历史 · {historyDeployments.length}
                          </h4>
                          {historyDeployments.length > 5 ? (
                            <button
                              type="button"
                              className="text-xs text-primary hover:underline"
                              onClick={() => setShowAllHistory((value) => !value)}
                            >
                              {showAllHistory ? '收起' : '显示全部'}
                            </button>
                          ) : null}
                        </header>
                        <div className="space-y-2">
                          {(showAllHistory ? historyDeployments : historyDeployments.slice(0, 5)).map((item) => (
                            <HistoryRow
                              key={item.key}
                              deployment={item}
                              onOpenLogs={openDeploymentBuildLogs}
                            />
                          ))}
                        </div>
                      </section>
                    ) : null}
                  </div>
                ) : null}

                {activeTab === 'logs' ? (
                  <section className="cds-surface-raised cds-hairline">
                    <header className="border-b border-[hsl(var(--hairline))] px-4 py-3">
                      <div className="flex flex-wrap items-center justify-between gap-3">
                        <div className="inline-flex rounded-md border border-[hsl(var(--hairline))] bg-[hsl(var(--surface-sunken))] p-1">
                          <button
                            type="button"
                            className={`h-8 rounded px-3 text-xs transition-colors ${logsMode === 'build' ? 'bg-[hsl(var(--surface-raised))] text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'}`}
                            onClick={() => {
                              setLogsMode('build');
                              setSelectedBuildLog(null);
                            }}
                          >
                            构建日志
                          </button>
                          <button
                            type="button"
                            className={`h-8 rounded px-3 text-xs transition-colors ${logsMode === 'container' ? 'bg-[hsl(var(--surface-raised))] text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'}`}
                            onClick={() => openContainerLogs()}
                          >
                            容器日志
                          </button>
                        </div>
                        <div className="flex min-w-0 items-center gap-2">
                          <input
                            className="h-8 w-52 rounded-md border border-[hsl(var(--hairline))] bg-[hsl(var(--surface-sunken))] px-3 text-xs outline-none placeholder:text-muted-foreground focus:border-primary"
                            value={logQuery}
                            onChange={(event) => setLogQuery(event.target.value)}
                            placeholder="Filter logs"
                          />
                          <Button
                            type="button"
                            size="sm"
                            variant="outline"
                            onClick={() => logsMode === 'build' ? void load() : selectedService ? void loadServiceLogs(selectedService.profileId) : undefined}
                          >
                            <RefreshCw />
                            刷新
                          </Button>
                        </div>
                      </div>
                    </header>
                    {logsMode === 'build' ? (
                      <BuildLogsPanel logs={logs} query={logQuery} selection={selectedBuildLog} />
                    ) : (
                      <>
                        {services.length > 1 ? (
                          <div className="flex gap-2 overflow-x-auto border-b border-[hsl(var(--hairline))] px-4 py-3">
                            {services.map((svc) => (
                              <button
                                key={svc.profileId}
                                type="button"
                                className={`inline-flex h-8 shrink-0 items-center gap-2 rounded-md border px-3 text-xs transition-colors ${
                                  selectedService?.profileId === svc.profileId
                                    ? 'border-primary bg-primary/10 text-foreground'
                                    : 'border-[hsl(var(--hairline))] bg-[hsl(var(--surface-sunken))]/45 text-muted-foreground hover:text-foreground'
                                }`}
                                onClick={() => openContainerLogs(svc.profileId)}
                              >
                                <span className={`h-1.5 w-1.5 rounded-full ${svc.status === 'running' ? 'bg-emerald-500' : svc.status === 'error' ? 'bg-destructive' : 'bg-muted-foreground/40'}`} />
                                {svc.profileId}
                                <span className="font-mono">:{svc.hostPort || '?'}</span>
                              </button>
                            ))}
                          </div>
                        ) : null}
                        <ServiceLogsPanel service={selectedService} state={filterServiceLogs(serviceLogs, logQuery)} />
                      </>
                    )}
                  </section>
                ) : null}

                {activeTab === 'httpLogs' ? (
                  <section className="cds-surface-raised cds-hairline">
                    <LogsHeader
                      title="HTTP Logs"
                      query={logQuery}
                      onQueryChange={setLogQuery}
                      onRefresh={() => void load()}
                    />
                    <HttpLogsPanel events={visibleActivityEvents} query={logQuery} />
                  </section>
                ) : null}

                {activeTab === 'services' ? (
                  <section className="cds-surface-raised cds-hairline">
                    <header className="border-b border-[hsl(var(--hairline))] px-5 py-3">
                      <div className="flex items-center justify-between gap-3">
                        <h3 className="text-sm font-semibold">服务（{services.length}）</h3>
                        {selectedService ? (
                          <Button
                            type="button"
                            size="sm"
                            variant="outline"
                            onClick={() => openContainerLogs(selectedService.profileId)}
                          >
                            查看日志
                          </Button>
                        ) : null}
                      </div>
                    </header>
                    <div className="grid min-h-[420px] grid-cols-[220px_minmax(0,1fr)] max-md:grid-cols-1">
                      {services.length === 0 ? (
                        <div className="px-5 py-6 text-sm text-muted-foreground">没有运行中的服务。</div>
                      ) : (
                        <>
                          <div className="border-r border-[hsl(var(--hairline))] p-3 max-md:border-b max-md:border-r-0">
                            <div className="space-y-2">
                              {services.map((svc) => (
                                <button
                                  key={svc.profileId}
                                  type="button"
                                  className={`w-full rounded-md border px-3 py-3 text-left transition-colors ${
                                    selectedService?.profileId === svc.profileId
                                      ? 'border-primary bg-primary/5'
                                      : 'border-[hsl(var(--hairline))] bg-[hsl(var(--surface-sunken))]/45 hover:bg-[hsl(var(--surface-sunken))]'
                                  }`}
                                  onClick={() => void loadServiceLogs(svc.profileId)}
                                >
                                  <div className="flex min-w-0 items-center justify-between gap-2">
                                    <span className="min-w-0 truncate text-sm font-medium">{svc.profileId}</span>
                                    <span className={`shrink-0 rounded border px-2 py-0.5 text-[11px] ${statusClass(svc.status)}`}>{statusLabel(svc.status)}</span>
                                  </div>
                                  <div className="mt-2 flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
                                    <span className="font-mono">:{svc.hostPort || '?'}</span>
                                    <span className="min-w-0 truncate font-mono">{svc.containerName}</span>
                                  </div>
                                  {svc.errorMessage ? (
                                    <div className="mt-2 line-clamp-2 text-xs leading-5 text-destructive">{svc.errorMessage}</div>
                                  ) : null}
                                </button>
                              ))}
                            </div>
                          </div>
                          <ServiceLogsPanel service={selectedService} state={serviceLogs} />
                        </>
                      )}
                    </div>
                  </section>
                ) : null}

                {activeTab === 'overview' ? (
                  <section className="cds-surface-raised cds-hairline px-5 py-4">
                    <div className="grid gap-3 text-sm">
                      <div className="flex justify-between gap-3">
                        <span className="text-muted-foreground">分支</span>
                        <span className="min-w-0 truncate font-mono">{branch.branch}</span>
                      </div>
                      <div className="flex justify-between gap-3">
                        <span className="text-muted-foreground">提交</span>
                        <span className="font-mono">{branch.commitSha?.slice(0, 7) || '-'}</span>
                      </div>
                      <div className="flex justify-between gap-3">
                        <span className="text-muted-foreground">状态</span>
                        <span>{statusLabel(branch.status)}</span>
                      </div>
                    </div>
                  </section>
                ) : null}

                {activeTab === 'variables' || activeTab === 'metrics' || activeTab === 'settings' ? (
                  <section className="rounded-md border border-dashed border-[hsl(var(--hairline))] px-5 py-8 text-sm leading-6 text-muted-foreground">
                    {plannedLabel(activeTab)}已进入开发计划。当前先把部署流从卡片迁移到抽屉，避免构建信息挤压主列表。
                  </section>
                ) : null}

                <div className="mt-5 text-center text-xs text-muted-foreground">
                  需要修改构建配置 / 环境变量 / 路由？打开
                  <a href={`/settings/${encodeURIComponent(projectId)}`} className="ml-1 text-primary hover:underline">项目设置</a>
                  。需要查看完整日志、Bridge、提交历史？打开
                  <a href={fullPageHref} className="ml-1 text-primary hover:underline">完整页面</a>
                </div>
              </div>
            </>
          ) : null}
        </div>

        {/* Quick action footer */}
        {branch ? (
          <footer className="flex items-center gap-2 border-t border-[hsl(var(--hairline))] px-4 py-3">
            <Button asChild className="flex-1">
              <a href={fullPageHref}>
                <Play />
                打开完整页面
              </a>
            </Button>
          </footer>
        ) : null}
      </div>
    </div>
  );
}

// 保留旧版小卡片实现，供后续可能的页面引用（Week 4.7 抽屉部署 tab
// 已迁移到 ActiveDeployment + HistoryRow，不再渲染本组件）。
export function DeploymentCard({
  deployment,
  now,
  onOpenLogs,
}: {
  deployment: BranchDeploymentItem;
  now: number;
  onOpenLogs: (deployment: BranchDeploymentItem) => void;
}): JSX.Element {
  const stages = deploymentStages(deployment.log);
  const duration = formatDuration((deployment.finishedAt || now) - deployment.startedAt);
  const statusIcon = deployment.status === 'running'
    ? <Loader2 className="h-4 w-4 animate-spin" />
    : deployment.status === 'success'
      ? <CheckCircle2 className="h-4 w-4" />
      : <AlertCircle className="h-4 w-4" />;

  return (
    <div className={`overflow-hidden rounded-md border transition-colors hover:border-primary/45 ${deployment.status === 'error' ? 'border-destructive/35 bg-destructive/5' : 'border-[hsl(var(--hairline))] bg-[hsl(var(--surface-sunken))]/70'}`}>
      <button
        type="button"
        className="flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-[hsl(var(--surface-raised))]/60"
        onClick={() => onOpenLogs(deployment)}
      >
        <span className={`inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md border ${deploymentStatusClass(deployment.status)}`}>
          {statusIcon}
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-2">
            <span className="truncate text-sm font-semibold">{deploymentKindLabel(deployment.kind)}</span>
            {deployment.commitSha ? <span className="font-mono text-xs text-muted-foreground">{deployment.commitSha.slice(0, 7)}</span> : null}
          </span>
          <span className="mt-0.5 block truncate text-xs text-muted-foreground">{deployment.message}</span>
        </span>
        <span className="flex shrink-0 items-center gap-2 text-xs text-muted-foreground">
          <Clock className="h-3.5 w-3.5" />
          {duration}
        </span>
      </button>

      <div className="border-t border-[hsl(var(--hairline))] px-4 py-3">
        <div className="flex min-w-0 items-center justify-between gap-3">
          <div className="flex min-w-0 flex-wrap gap-1.5">
            {stages.length > 0 ? stages.map((stage) => (
              <span key={stage} className="rounded border border-[hsl(var(--hairline))] bg-[hsl(var(--surface-base))] px-2 py-0.5 text-[11px] text-muted-foreground">
                {stage}
              </span>
            )) : (
              <span className="truncate text-xs text-muted-foreground">{deployment.lastStep || '等待部署事件'}</span>
            )}
          </div>
          <span className="shrink-0 text-xs text-primary">查看日志</span>
        </div>
        {deployment.suggestion ? (
          <div className="mt-3 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs leading-5 text-amber-700 dark:text-amber-300">
            {deployment.suggestion}
          </div>
        ) : null}
      </div>
    </div>
  );
}

function textMatchesQuery(text: string, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return text.toLowerCase().includes(q);
}

function filterServiceLogs(state: ServiceLogsState, query: string): ServiceLogsState {
  if (state.status !== 'ok' || !query.trim()) return state;
  const lines = (state.logs || '').split(/\r?\n/).filter((line) => textMatchesQuery(line, query));
  return { ...state, logs: lines.join('\n') };
}

function LogsHeader({
  title,
  query,
  onQueryChange,
  onRefresh,
}: {
  title: string;
  query: string;
  onQueryChange: (value: string) => void;
  onRefresh: () => void;
}): JSX.Element {
  return (
    <header className="flex flex-wrap items-center justify-between gap-3 border-b border-[hsl(var(--hairline))] px-4 py-3">
      <h3 className="text-sm font-semibold">{title}</h3>
      <div className="flex min-w-0 items-center gap-2">
        <input
          className="h-8 w-52 rounded-md border border-[hsl(var(--hairline))] bg-[hsl(var(--surface-sunken))] px-3 text-xs outline-none placeholder:text-muted-foreground focus:border-primary"
          value={query}
          onChange={(event) => onQueryChange(event.target.value)}
          placeholder="Filter logs"
        />
        <Button type="button" size="sm" variant="outline" onClick={onRefresh}>
          <RefreshCw />
          刷新
        </Button>
      </div>
    </header>
  );
}

function BuildLogsPanel({ logs, query, selection }: { logs: OperationLog[]; query: string; selection: BuildLogSelection | null }): JSX.Element {
  if (selection) {
    const rows = selection.lines
      .map((line, index) => ({ key: `${selection.startedAt || selection.title}-${index}`, text: line }))
      .filter((row) => textMatchesQuery(row.text, query));
    const time = selection.startedAt ? new Date(selection.startedAt).toLocaleString() : '';

    return (
      <div>
        <div className="border-b border-[hsl(var(--hairline))] px-4 py-4">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <span className={`rounded border px-2 py-0.5 text-xs ${statusClass(selection.status)}`}>{statusLabel(selection.status)}</span>
            <span className="min-w-0 truncate text-sm font-semibold">{selection.title}</span>
            {selection.commitSha ? <span className="font-mono text-xs text-muted-foreground">{selection.commitSha.slice(0, 7)}</span> : null}
          </div>
          <div className="mt-2 flex min-w-0 flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
            {time ? <span>{time}</span> : null}
            {selection.message ? <span className="min-w-0 truncate">{selection.message}</span> : null}
          </div>
        </div>
        <div className="max-h-[560px] overflow-auto">
          <div className="grid grid-cols-[150px_minmax(0,1fr)] border-b border-[hsl(var(--hairline))] px-4 py-2 text-xs font-medium text-muted-foreground">
            <span>Time</span>
            <span>Message</span>
          </div>
          {rows.length === 0 ? (
            <div className="px-5 py-8 text-sm text-muted-foreground">{query ? '没有匹配的构建日志。' : '这条部署还没有日志。'}</div>
          ) : (
            <div className="divide-y divide-[hsl(var(--hairline))]">
              {rows.map((row) => (
                <div key={row.key} className="grid grid-cols-[150px_minmax(0,1fr)] gap-3 px-4 py-2 text-xs">
                  <span className="font-mono text-muted-foreground">{time || '-'}</span>
                  <pre className="min-w-0 whitespace-pre-wrap break-words font-mono leading-5 text-muted-foreground">{row.text}</pre>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    );
  }

  const rows = logs
    .slice()
    .reverse()
    .flatMap((log) => {
      const timestamp = log.startedAt ? new Date(log.startedAt).toLocaleString() : '-';
      const events = (log.events || []).slice(-40);
      if (events.length === 0) {
        const line = `${timestamp} ${log.type} ${log.status}`;
        return textMatchesQuery(line, query) ? [{ key: `${log.startedAt}-${log.type}`, status: log.status, time: timestamp, text: line }] : [];
      }
      return events.map((event, index) => ({
        key: `${log.startedAt}-${log.type}-${index}`,
        status: event.status,
        time: timestamp,
        text: `[${event.status}] ${event.title || event.step}${event.log ? ` - ${event.log}` : ''}`,
      })).filter((row) => textMatchesQuery(`${row.time} ${row.text}`, query));
    });

  if (rows.length === 0) {
    return <div className="px-5 py-8 text-sm text-muted-foreground">{query ? '没有匹配的构建日志。' : '还没有构建记录。'}</div>;
  }

  return (
    <div className="max-h-[560px] overflow-auto p-3">
      <div className="space-y-2">
        {rows.map((row) => (
          <div key={row.key} className={`rounded-md border px-3 py-2 ${row.status === 'error' ? 'border-destructive/35 bg-destructive/5' : 'border-[hsl(var(--hairline))] bg-[hsl(var(--surface-sunken))]/45'}`}>
            <div className="mb-1 flex items-center gap-2 text-[11px] text-muted-foreground">
              <span className={`rounded border px-1.5 py-0.5 ${statusClass(row.status)}`}>{statusLabel(row.status)}</span>
              <span>{row.time}</span>
            </div>
            <pre className="whitespace-pre-wrap font-mono text-[11px] leading-5 text-muted-foreground">{row.text}</pre>
          </div>
        ))}
      </div>
    </div>
  );
}

function ServiceLogsPanel({
  service,
  state,
}: {
  service: ServiceState | null;
  state: ServiceLogsState;
}): JSX.Element {
  const [copied, setCopied] = useState(false);
  const logs = state.status === 'ok' ? (state.logs || '') : '';
  const isCurrent = service && state.profileId === service.profileId;
  const displayLogs = isCurrent ? logs : '';

  async function copyLogs(): Promise<void> {
    if (!service) return;
    const text = [
      `${service.profileId} ${statusLabel(service.status)} :${service.hostPort || '?'}`,
      service.containerName,
      service.errorMessage ? `error: ${service.errorMessage}` : '',
      '',
      displayLogs,
    ].filter(Boolean).join('\n');
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1400);
    } catch {
      setCopied(false);
    }
  }

  if (!service) {
    return <div className="p-5 text-sm text-muted-foreground">选择一个服务查看容器日志。</div>;
  }

  return (
    <div className="min-w-0 p-4">
      <div className="rounded-md border border-[hsl(var(--hairline))] bg-[hsl(var(--surface-sunken))]/45">
        <div className="border-b border-[hsl(var(--hairline))] px-4 py-3">
          <div className="flex min-w-0 items-center justify-between gap-3">
            <div className="min-w-0">
              <div className="flex min-w-0 items-center gap-2">
                <span className="min-w-0 truncate text-sm font-semibold">{service.profileId}</span>
                <span className={`shrink-0 rounded border px-2 py-0.5 text-[11px] ${statusClass(service.status)}`}>{statusLabel(service.status)}</span>
              </div>
              <div className="mt-1 flex min-w-0 flex-wrap gap-x-3 gap-y-1 font-mono text-[11px] text-muted-foreground">
                <span>:{service.hostPort || '?'}</span>
                <span className="min-w-0 truncate">{service.containerName}</span>
              </div>
            </div>
            <button
              type="button"
              className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md border border-[hsl(var(--hairline))] px-2 text-xs text-muted-foreground hover:text-foreground"
              onClick={() => void copyLogs()}
            >
              <Copy className="h-3.5 w-3.5" />
              {copied ? '已复制' : '复制'}
            </button>
          </div>
          {service.errorMessage ? (
            <div className="mt-3 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs leading-5 text-destructive">
              {service.errorMessage}
            </div>
          ) : null}
        </div>
        <div className="px-4 py-3">
          <div className="mb-2 flex items-center justify-between text-xs text-muted-foreground">
            <span>容器详情日志</span>
            {state.status === 'loading' && isCurrent ? <span>读取中...</span> : null}
          </div>
          {state.status === 'error' && isCurrent ? (
            <div className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs leading-5 text-destructive">
              {state.message}
            </div>
          ) : (
            <pre className="max-h-[420px] min-h-[260px] overflow-auto whitespace-pre-wrap rounded-md border border-[hsl(var(--hairline))] bg-black/35 p-3 font-mono text-[11px] leading-5 text-muted-foreground">
              {state.status === 'loading' && isCurrent
                ? '正在读取 docker logs...'
                : displayLogs || '暂无容器日志。若容器不存在或已被清理，请重新部署该服务。'}
            </pre>
          )}
        </div>
      </div>
    </div>
  );
}

function HttpLogsPanel({ events, query }: { events: DrawerActivityEvent[]; query: string }): JSX.Element {
  const rows = events.filter((event) => textMatchesQuery([
    event.method || '',
    event.path || '',
    String(event.status || ''),
    event.label || '',
    event.profileId || '',
  ].join(' '), query));

  if (rows.length === 0) {
    return (
      <div className="px-5 py-8 text-sm leading-6 text-muted-foreground">
        {query ? '没有匹配的 HTTP 访问日志。' : '还没有捕获到这个分支的 HTTP 请求。打开预览后，请求会出现在这里。'}
      </div>
    );
  }

  return (
    <div className="max-h-[560px] overflow-auto p-3">
      <div className="space-y-2">
        {rows.map((event, index) => {
          const ok = (event.status || 0) < 400;
          const duration = typeof event.duration === 'number'
            ? event.duration < 1000 ? `${event.duration}ms` : `${(event.duration / 1000).toFixed(1)}s`
            : '-';
          return (
            <div key={`${event.id || index}-${event.ts || ''}`} className="grid grid-cols-[auto_auto_minmax(0,1fr)_auto_auto] items-center gap-2 rounded-md border border-[hsl(var(--hairline))] bg-[hsl(var(--surface-sunken))]/45 px-3 py-2 text-xs">
              <span className="font-mono text-muted-foreground">{event.method || '-'}</span>
              <span className={`rounded border px-1.5 py-0.5 ${ok ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-600' : 'border-destructive/30 bg-destructive/10 text-destructive'}`}>
                {event.status || '-'}
              </span>
              <span className="min-w-0 truncate font-mono text-muted-foreground" title={event.path || event.label || ''}>
                {event.label || event.path || '-'}
              </span>
              <span className="font-mono text-muted-foreground">{duration}</span>
              <span className="text-muted-foreground">{event.ts ? new Date(event.ts).toLocaleTimeString() : ''}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// 同 DeploymentCard：保留供后续可能的引用，Week 4.7 起本抽屉
// 通过 legacyLogToDeploymentItem 把 OperationLog 投影成 BranchDeploymentItem
// 后再走 ActiveDeployment / HistoryRow 渲染。
export function LegacyDeploymentCard({ log, onOpenLogs }: { log: OperationLog; onOpenLogs: (log: OperationLog) => void }): JSX.Element {
  const failure = logFailureReason(log);
  const latest = log.events.slice(-2).map(eventText).join('\n') || '(no log lines)';
  return (
    <button
      type="button"
      className={`block w-full rounded-md border bg-[hsl(var(--surface-sunken))]/50 px-4 py-3 text-left transition-colors hover:border-primary/45 hover:bg-[hsl(var(--surface-raised))]/45 ${log.status === 'error' ? 'border-destructive/35' : 'border-[hsl(var(--hairline))]'}`}
      onClick={() => onOpenLogs(log)}
    >
      <div className="flex items-center gap-2 text-xs">
        <span className={`rounded border px-2 py-0.5 ${statusClass(log.status)}`}>{statusLabel(log.status)}</span>
        <span className="font-mono">{log.type}</span>
        <span className="min-w-0 flex-1 truncate text-muted-foreground">{failure || latest}</span>
        <span className="shrink-0 text-muted-foreground">{new Date(log.startedAt).toLocaleString()}</span>
        <span className="shrink-0 text-primary">查看日志</span>
      </div>
      {failure ? (
        <div className="mt-3 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs leading-5 text-destructive">
          {failure}
        </div>
      ) : null}
    </button>
  );
}
