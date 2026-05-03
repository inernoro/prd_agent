import { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertCircle, CheckCircle2, Clock, Copy, Eye, EyeOff, ExternalLink, Loader2, Play, RefreshCw, RotateCw, Search, Settings, Square, Trash2, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { apiRequest, ApiError } from '@/lib/api';
import { statusClass, statusRailClass } from '@/lib/statusStyle';
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
  { key: 'variables', label: '变量' },           // 2026-05-04 Phase A 落地
  { key: 'metrics', label: '指标' },             // 2026-05-04 Phase B 落地
  { key: 'settings', label: '设置' },            // 2026-05-04 Phase C 落地
];

// Phase A (2026-05-04):分支生效环境变量
type EnvSource = 'cds-builtin' | 'cds-derived' | 'mirror' | 'global' | 'project';
interface EffectiveEnvVar {
  key: string;
  value: string;
  source: EnvSource;
  isSecret: boolean;
}
interface EffectiveEnvResponse {
  branchId: string;
  projectId: string;
  projectSlug: string;
  total: number;
  bySource: Record<EnvSource, number>;
  variables: EffectiveEnvVar[];
}
type EffectiveEnvState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ok'; data: EffectiveEnvResponse };

// Phase B (2026-05-04):分支指标
interface ContainerStatsResponse {
  name: string;
  cpuPercent: number;
  memUsedBytes: number;
  memLimitBytes: number;
  memPercent: number;
  netRxBytes: number;
  netTxBytes: number;
  blockReadBytes: number;
  blockWriteBytes: number;
  pids: number;
}
interface MetricsResponse {
  branchId: string;
  ts: number;
  runningCount: number;
  totalCount: number;
  services: Array<{
    profileId: string;
    containerName: string;
    status: string;
    stats: ContainerStatsResponse | null;
  }>;
}
type MetricsState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ok'; data: MetricsResponse };

/** 5-min ring buffer (60 points × 5s 间隔) per service+metric — UI sparkline 用 */
interface MetricSeries {
  cpu: number[];        // %
  mem: number[];        // % of limit
  rxRate: number[];     // bytes/sec(由两次响应间 delta / dt 算出)
  txRate: number[];     // bytes/sec
}
const METRIC_RING_SIZE = 60;

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

// Bugbot fix(2026-05-04 PR #523):statusClass + statusRailClass 已抽到
// `cds/web/src/lib/statusStyle.ts` 共享模块,见顶部 import。

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
  onToast,
  onActionComplete,
}: {
  branchId: string | null;
  projectId: string;
  open: boolean;
  onClose: () => void;
  deployments?: BranchDeploymentItem[];
  activityEvents?: DrawerActivityEvent[];
  now?: number;
  /** 由父页面注入的 toast 函数 — 设置 tab 操作完成后用它反馈结果 */
  onToast?: (message: string) => void;
  /** 操作(deploy/pull/stop/reset/delete)完成后回调,父页面用来重拉 BranchList。
      delete 完成时本组件会自动 onClose,父页面无需特别处理。 */
  onActionComplete?: (action: 'deploy' | 'pull' | 'stop' | 'reset' | 'delete') => void;
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
  // Phase A — Variables tab(2026-05-04)
  const [envState, setEnvState] = useState<EffectiveEnvState>({ status: 'idle' });
  const [revealedKeys, setRevealedKeys] = useState<Set<string>>(new Set());
  const [envQuery, setEnvQuery] = useState('');
  // Phase B — Metrics tab(2026-05-04)
  const [metricsState, setMetricsState] = useState<MetricsState>({ status: 'idle' });
  // ring buffer keyed by profileId,内存级,关抽屉就丢(metrics 是观测,不是审计)
  const [metricSeries, setMetricSeries] = useState<Record<string, MetricSeries>>({});
  // 上次响应快照,用来算 rx/tx 速率(后端只给累计值,前端做 delta/dt)
  const [lastMetricsTs, setLastMetricsTs] = useState<number>(0);
  const [lastMetricsByService, setLastMetricsByService] = useState<Record<string, ContainerStatsResponse>>({});
  // Phase C — Settings tab(2026-05-04)
  const [actionBusy, setActionBusy] = useState<'deploy' | 'pull' | 'stop' | 'reset' | 'delete' | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
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
    setEnvState({ status: 'idle' });
    setRevealedKeys(new Set());
    setEnvQuery('');
    setMetricsState({ status: 'idle' });
    setMetricSeries({});
    setLastMetricsTs(0);
    setLastMetricsByService({});
    void load();
  }, [open, branchId, load]);

  // Phase A — lazy-load effective env when the variables tab is opened.
  // Single fetch per drawer-open + tab-switch, no polling(env doesn't
  // change without an explicit Save in 项目设置)。
  const loadEnv = useCallback(async () => {
    if (!branchId) return;
    setEnvState({ status: 'loading' });
    try {
      const data = await apiRequest<EffectiveEnvResponse>(
        `/api/branches/${encodeURIComponent(branchId)}/effective-env`,
      );
      setEnvState({ status: 'ok', data });
    } catch (err) {
      setEnvState({ status: 'error', message: err instanceof ApiError ? err.message : String(err) });
    }
  }, [branchId]);

  useEffect(() => {
    if (activeTab === 'variables' && envState.status === 'idle') {
      void loadEnv();
    }
  }, [activeTab, envState.status, loadEnv]);

  // Phase B — Metrics: 5s polling while metrics tab is active.
  // 关闭 tab 或抽屉就停止(useEffect 清理函数)。ring buffer 每点存:
  //   - cpu%(后端瞬时值,直接 push)
  //   - mem%(同上)
  //   - rxRate / txRate(后端给累计 bytes,前端 (curr - prev) / (ts - prevTs))
  // 第一次响应没有 prev,rxRate/txRate 入 0(占位避免锯齿状)。
  const loadMetrics = useCallback(async () => {
    if (!branchId) return;
    try {
      const data = await apiRequest<MetricsResponse>(
        `/api/branches/${encodeURIComponent(branchId)}/metrics`,
      );
      setMetricsState({ status: 'ok', data });
      // 算 rate + 推 ring buffer
      setMetricSeries((prev) => {
        const next = { ...prev };
        const dt = lastMetricsTs > 0 ? (data.ts - lastMetricsTs) / 1000 : 0;
        for (const svc of data.services) {
          const series = next[svc.profileId] || { cpu: [], mem: [], rxRate: [], txRate: [] };
          const stats = svc.stats;
          if (!stats) {
            // 容器没在跑,push 0 占位让 sparkline 有连续 60 点
            next[svc.profileId] = pushRing(series, 0, 0, 0, 0);
            continue;
          }
          const lastStats = lastMetricsByService[svc.profileId];
          let rxRate = 0;
          let txRate = 0;
          if (lastStats && dt > 0) {
            rxRate = Math.max(0, (stats.netRxBytes - lastStats.netRxBytes) / dt);
            txRate = Math.max(0, (stats.netTxBytes - lastStats.netTxBytes) / dt);
          }
          next[svc.profileId] = pushRing(series, stats.cpuPercent, stats.memPercent, rxRate, txRate);
        }
        return next;
      });
      setLastMetricsTs(data.ts);
      const lastMap: Record<string, ContainerStatsResponse> = {};
      for (const svc of data.services) {
        if (svc.stats) lastMap[svc.profileId] = svc.stats;
      }
      setLastMetricsByService(lastMap);
    } catch (err) {
      setMetricsState({ status: 'error', message: err instanceof ApiError ? err.message : String(err) });
    }
  }, [branchId, lastMetricsTs, lastMetricsByService]);

  useEffect(() => {
    if (activeTab !== 'metrics' || !branchId) return;
    // 立即拉一次,然后每 5s 轮询。docker stats 一次 ~300-800ms,5s 周期足够
    if (metricsState.status === 'idle') setMetricsState({ status: 'loading' });
    void loadMetrics();
    const timer = window.setInterval(() => void loadMetrics(), 5000);
    return () => window.clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab, branchId]);

  // Phase C — Settings tab actions(2026-05-04)
  // 直接 reuse 现有 endpoints,不引入新 backend 路径。delete 成功后自动关抽屉,
  // 其它操作完成后重新拉一次 branch 详情(让"运行中"状态及时更新)。
  const runBranchAction = useCallback(async (
    action: 'deploy' | 'pull' | 'stop' | 'reset' | 'delete',
    label: string,
  ): Promise<void> => {
    if (!branchId) return;
    setActionBusy(action);
    try {
      const path = `/api/branches/${encodeURIComponent(branchId)}` + (
        action === 'delete' ? '' : `/${action}`
      );
      const method = action === 'delete' ? 'DELETE' : 'POST';
      await apiRequest(path, { method });
      onToast?.(`${label} 已提交`);
      onActionComplete?.(action);
      if (action === 'delete') {
        onClose();
      } else {
        // 立刻重拉详情(deploy/pull 是异步的,状态会变成 building/pulling)
        void load();
      }
    } catch (err) {
      const message = err instanceof ApiError ? err.message : String(err);
      onToast?.(`${label} 失败:${message}`);
    } finally {
      setActionBusy(null);
    }
  }, [branchId, onToast, onActionComplete, onClose, load]);

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
                    {/* Bug C(2026-05-03)— 左右分栏改顶部 tab 横排,下方 log
                        全宽展示。原 220px 左栏挤占了 log 的横向空间,导致用户
                        要往右拖滚动条才能看完一行容器输出。 */}
                    <div className="flex min-h-[420px] flex-col">
                      {services.length === 0 ? (
                        <div className="px-5 py-6 text-sm text-muted-foreground">没有运行中的服务。</div>
                      ) : (
                        <>
                          {/* 顶部 tab 行 — 横向滚动避免服务多时撑破 */}
                          <div
                            role="tablist"
                            aria-label="服务列表"
                            className="flex shrink-0 gap-1 overflow-x-auto border-b border-[hsl(var(--hairline))] px-3 py-2"
                            style={{ overscrollBehavior: 'contain' }}
                          >
                            {services.map((svc) => {
                              const active = selectedService?.profileId === svc.profileId;
                              return (
                                <button
                                  key={svc.profileId}
                                  type="button"
                                  role="tab"
                                  aria-selected={active}
                                  className={`group inline-flex shrink-0 items-center gap-2 rounded-md border px-3 py-1.5 text-left transition-colors ${
                                    active
                                      ? 'border-primary bg-primary/10 shadow-[0_0_0_1px_hsl(var(--primary)/.4)]'
                                      : 'border-[hsl(var(--hairline))] bg-[hsl(var(--surface-sunken))]/45 hover:bg-[hsl(var(--surface-sunken))]'
                                  }`}
                                  onClick={() => void loadServiceLogs(svc.profileId)}
                                  title={`${svc.profileId} · :${svc.hostPort || '?'} · ${svc.containerName}`}
                                >
                                  <span className={`h-1.5 w-1.5 rounded-full ${statusRailClass(svc.status)}`} aria-hidden />
                                  <span className="text-sm font-medium">{svc.profileId}</span>
                                  <span className="font-mono text-[11px] text-muted-foreground">:{svc.hostPort || '?'}</span>
                                  {svc.errorMessage ? (
                                    <span className="rounded bg-destructive/15 px-1 text-[10px] font-semibold text-destructive">!</span>
                                  ) : null}
                                </button>
                              );
                            })}
                          </div>
                          {/* 下方 log 区 — 占 1fr,横向不再被左栏挤压 */}
                          <div className="flex-1 min-h-0">
                            <ServiceLogsPanel service={selectedService} state={serviceLogs} />
                          </div>
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

                {activeTab === 'variables' ? (
                  <VariablesPanel
                    state={envState}
                    revealedKeys={revealedKeys}
                    onToggleReveal={(k) => setRevealedKeys((cur) => {
                      const next = new Set(cur);
                      if (next.has(k)) next.delete(k);
                      else next.add(k);
                      return next;
                    })}
                    query={envQuery}
                    onQuery={setEnvQuery}
                    onRefresh={() => void loadEnv()}
                    projectId={projectId}
                  />
                ) : null}

                {activeTab === 'settings' ? (
                  <SettingsPanel
                    branch={branch}
                    projectId={projectId}
                    busy={actionBusy}
                    confirmDelete={confirmDelete}
                    onConfirmDelete={setConfirmDelete}
                    onRunAction={runBranchAction}
                  />
                ) : null}

                {activeTab === 'metrics' ? (
                  <MetricsPanel
                    state={metricsState}
                    series={metricSeries}
                    onRefresh={() => void loadMetrics()}
                  />
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

// ──────────────────────────────────────────────────────────────────────────
// Phase A — Variables panel(2026-05-04)
//
// 用户反馈:抽屉里「变量」tab 还是 placeholder。Railway / Vercel 都有这块,
// 是判断「我配的 env 有没有真的被 deploy 用上」最直接的视图。
//
// 设计选择:
//   - 只读(编辑入口仍然在「项目设置」,跳转一下不会让用户绕远)
//   - 默认 redact secret,单条「显示」按钮按需解锁(Vercel 同款)
//   - 来源 chip:project / global / mirror / cds-derived / cds-builtin
//   - 搜索框过滤 key
// ──────────────────────────────────────────────────────────────────────────

function VariablesPanel({
  state,
  revealedKeys,
  onToggleReveal,
  query,
  onQuery,
  onRefresh,
  projectId,
}: {
  state: EffectiveEnvState;
  revealedKeys: Set<string>;
  onToggleReveal: (key: string) => void;
  query: string;
  onQuery: (q: string) => void;
  onRefresh: () => void;
  projectId: string;
}): JSX.Element {
  if (state.status === 'idle' || state.status === 'loading') {
    return (
      <section className="rounded-md border border-[hsl(var(--hairline))] bg-card px-5 py-8 text-center text-sm text-muted-foreground">
        <Loader2 className="mx-auto mb-2 h-4 w-4 animate-spin" />
        正在读取该分支的生效环境变量…
      </section>
    );
  }
  if (state.status === 'error') {
    return (
      <section className="rounded-md border border-destructive/30 bg-destructive/10 px-5 py-4 text-sm text-destructive">
        <div className="flex items-center gap-2">
          <AlertCircle className="h-4 w-4 shrink-0" />
          <span>读取失败:{state.message}</span>
          <Button type="button" size="sm" variant="outline" className="ml-auto" onClick={onRefresh}>
            <RefreshCw />重试
          </Button>
        </div>
      </section>
    );
  }
  const data = state.data;
  const filtered = query.trim()
    ? data.variables.filter((v) => v.key.toLowerCase().includes(query.trim().toLowerCase()))
    : data.variables;

  return (
    <section className="rounded-md border border-[hsl(var(--hairline))] bg-card">
      <header className="flex flex-wrap items-center gap-2 border-b border-[hsl(var(--hairline))] px-4 py-3">
        <span className="text-sm font-medium">生效环境变量</span>
        <span className="text-xs text-muted-foreground">
          共 {data.total} 个 · 项目 {data.bySource.project} · 全局 {data.bySource.global} ·
          镜像 {data.bySource.mirror} · CDS 内置 {data.bySource['cds-builtin'] + data.bySource['cds-derived']}
        </span>
        <Button asChild size="sm" variant="ghost" className="ml-auto">
          <a href={`/settings/${encodeURIComponent(projectId)}?tab=env`}>
            <ExternalLink />编辑
          </a>
        </Button>
        <Button type="button" size="sm" variant="outline" onClick={onRefresh}>
          <RefreshCw />刷新
        </Button>
      </header>
      <div className="border-b border-[hsl(var(--hairline))] px-4 py-2">
        <div className="relative">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <input
            type="text"
            value={query}
            onChange={(e) => onQuery(e.target.value)}
            placeholder="过滤 key…"
            className="h-8 w-full rounded-md border border-input bg-background pl-8 pr-3 text-sm outline-none ring-offset-background focus-visible:ring-2 focus-visible:ring-ring"
            spellCheck={false}
          />
        </div>
      </div>

      {filtered.length === 0 ? (
        <div className="px-4 py-6 text-center text-sm text-muted-foreground">
          {data.total === 0 ? '没有任何变量(连 CDS_HOST 都没?这不太正常,联系管理员)' : '没有匹配的 key'}
        </div>
      ) : (
        <ul className="divide-y divide-[hsl(var(--hairline))]">
          {filtered.map((v) => (
            <EnvRow
              key={v.key}
              entry={v}
              revealed={revealedKeys.has(v.key)}
              onToggleReveal={() => onToggleReveal(v.key)}
            />
          ))}
        </ul>
      )}

      <footer className="border-t border-[hsl(var(--hairline))] px-4 py-2 text-[11px] leading-5 text-muted-foreground">
        优先级:project &gt; global &gt; mirror &gt; cds-derived &gt; cds-builtin。同名 key 后写覆盖前写。
        敏感值默认隐藏,点眼睛图标按条解锁。
      </footer>
    </section>
  );
}

function EnvRow({
  entry,
  revealed,
  onToggleReveal,
}: {
  entry: EffectiveEnvVar;
  revealed: boolean;
  onToggleReveal: () => void;
}): JSX.Element {
  const visible = revealed || !entry.isSecret;
  const displayValue = visible
    ? entry.value
    : entry.value.length > 4
      ? '••••' + entry.value.slice(-4)
      : '••••';
  return (
    <li className="flex items-center gap-3 px-4 py-2 text-sm">
      <span className={`inline-flex h-5 shrink-0 items-center rounded-md border px-1.5 text-[10px] font-medium ${envSourceClass(entry.source)}`}>
        {envSourceLabel(entry.source)}
      </span>
      <span className="min-w-0 max-w-[35%] shrink-0 truncate font-mono text-xs" title={entry.key}>
        {entry.key}
      </span>
      <span className="min-w-0 flex-1 truncate font-mono text-xs text-muted-foreground" title={visible ? entry.value : '点击右侧眼睛查看'}>
        {displayValue}
      </span>
      {entry.isSecret ? (
        <button
          type="button"
          onClick={onToggleReveal}
          className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-[hsl(var(--surface-sunken))] hover:text-foreground"
          title={revealed ? '隐藏' : '显示真实值'}
          aria-label={revealed ? '隐藏值' : '显示值'}
        >
          {revealed ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
        </button>
      ) : null}
      <button
        type="button"
        onClick={() => { void navigator.clipboard.writeText(entry.value); }}
        className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-[hsl(var(--surface-sunken))] hover:text-foreground"
        title="复制原值"
        aria-label="复制"
      >
        <Copy className="h-4 w-4" />
      </button>
    </li>
  );
}

function envSourceLabel(s: EnvSource): string {
  return ({
    project: '项目', global: '全局', mirror: '镜像',
    'cds-derived': 'CDS派生', 'cds-builtin': 'CDS内置',
  } as Record<EnvSource, string>)[s];
}

function envSourceClass(s: EnvSource): string {
  switch (s) {
    case 'project':
      return 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300';
    case 'global':
      return 'border-blue-500/30 bg-blue-500/10 text-blue-700 dark:text-blue-300';
    case 'mirror':
      return 'border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300';
    case 'cds-derived':
    case 'cds-builtin':
      return 'border-[hsl(var(--hairline))] bg-[hsl(var(--surface-sunken))] text-muted-foreground';
  }
}

// ──────────────────────────────────────────────────────────────────────────
// Phase C — Settings panel(2026-05-04)
//
// 把分散在卡片 hover / kebab 菜单 / 详情页脚部的 per-branch 操作收口到
// 这一个面板。所有 endpoint 都是已存在的(POST /deploy / /pull / /stop / /reset
// + DELETE /branches/:id),不引入新 API,只重新组织。
//
// 用户场景:进入分支抽屉看完日志/服务/部署后,直接在「设置」tab 点重新部署
// 或停止 — 不再需要关抽屉回卡片找按钮。
// ──────────────────────────────────────────────────────────────────────────

function SettingsPanel({
  branch,
  projectId,
  busy,
  confirmDelete,
  onConfirmDelete,
  onRunAction,
}: {
  branch: BranchDetailData | null;
  projectId: string;
  busy: 'deploy' | 'pull' | 'stop' | 'reset' | 'delete' | null;
  confirmDelete: boolean;
  onConfirmDelete: (next: boolean) => void;
  onRunAction: (
    action: 'deploy' | 'pull' | 'stop' | 'reset' | 'delete',
    label: string,
  ) => void;
}): JSX.Element {
  if (!branch) {
    return (
      <section className="rounded-md border border-[hsl(var(--hairline))] bg-card px-5 py-8 text-center text-sm text-muted-foreground">
        正在加载分支信息…
      </section>
    );
  }
  const isRunning = branch.status === 'running';
  const isError = branch.status === 'error';
  const isAnyBusy = busy !== null;

  return (
    <section className="space-y-4">
      {/* 主操作 */}
      <div className="rounded-md border border-[hsl(var(--hairline))] bg-card px-4 py-3">
        <div className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
          常用操作
        </div>
        <div className="grid grid-cols-3 gap-2">
          <SettingsActionButton
            icon={<Play />}
            label="重新部署"
            onClick={() => onRunAction('deploy', '重新部署')}
            busy={busy === 'deploy'}
            disabled={isAnyBusy}
            primary
          />
          <SettingsActionButton
            icon={<RefreshCw />}
            label="拉取最新"
            onClick={() => onRunAction('pull', '拉取最新')}
            busy={busy === 'pull'}
            disabled={isAnyBusy}
          />
          <SettingsActionButton
            icon={<Square />}
            label="停止运行"
            onClick={() => onRunAction('stop', '停止运行')}
            busy={busy === 'stop'}
            disabled={isAnyBusy || !isRunning}
            tooltip={!isRunning ? '当前未运行' : undefined}
          />
        </div>
      </div>

      {/* 异常恢复 */}
      {isError ? (
        <div className="rounded-md border border-amber-500/30 bg-amber-500/10 px-4 py-3">
          <div className="mb-2 flex items-center gap-2 text-sm text-amber-700 dark:text-amber-300">
            <AlertCircle className="h-4 w-4 shrink-0" />
            <span>分支处于异常状态。修代码后重新部署,或先重置异常清空错误标记。</span>
          </div>
          <SettingsActionButton
            icon={<RotateCw />}
            label="重置异常状态"
            onClick={() => onRunAction('reset', '重置异常')}
            busy={busy === 'reset'}
            disabled={isAnyBusy}
            inline
          />
        </div>
      ) : null}

      {/* 元信息 */}
      <div className="rounded-md border border-[hsl(var(--hairline))] bg-card px-4 py-3 text-sm">
        <div className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
          元信息
        </div>
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5">
          <dt className="text-muted-foreground">分支名</dt>
          <dd className="truncate font-mono text-xs">{branch.branch}</dd>
          <dt className="text-muted-foreground">CDS 分支 id</dt>
          <dd className="truncate font-mono text-xs">{branch.id}</dd>
          <dt className="text-muted-foreground">所属项目</dt>
          <dd className="truncate text-xs">{projectId}</dd>
          <dt className="text-muted-foreground">服务数</dt>
          <dd className="text-xs">{Object.keys(branch.services || {}).length}</dd>
        </dl>
      </div>

      {/* 跳转 */}
      <div className="rounded-md border border-[hsl(var(--hairline))] bg-card px-4 py-3">
        <div className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
          配置入口
        </div>
        <div className="flex flex-wrap gap-2">
          <Button asChild size="sm" variant="outline">
            <a href={`/settings/${encodeURIComponent(projectId)}`}>
              <Settings />
              项目设置
            </a>
          </Button>
          <Button asChild size="sm" variant="ghost" className="text-muted-foreground">
            <a href={`/settings/${encodeURIComponent(projectId)}?tab=env`}>
              环境变量
            </a>
          </Button>
          <Button asChild size="sm" variant="ghost" className="text-muted-foreground">
            <a href={`/settings/${encodeURIComponent(projectId)}?tab=build`}>
              构建配置
            </a>
          </Button>
          <Button asChild size="sm" variant="ghost" className="text-muted-foreground">
            <a href={`/settings/${encodeURIComponent(projectId)}?tab=routing`}>
              路由规则
            </a>
          </Button>
        </div>
      </div>

      {/* 危险操作 */}
      <div className="rounded-md border border-destructive/30 bg-destructive/5 px-4 py-3">
        <div className="mb-2 flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-destructive">
          <AlertCircle className="h-3.5 w-3.5" />
          危险操作
        </div>
        {confirmDelete ? (
          <div className="space-y-2">
            <div className="text-sm text-destructive">
              将停止 {Object.keys(branch.services || {}).length} 个服务并删除该分支的工作区。**git 历史不会被删**(只是 CDS 端忘记这个分支)。继续?
            </div>
            <div className="flex gap-2">
              <Button
                type="button"
                variant="destructive"
                size="sm"
                onClick={() => onRunAction('delete', '删除分支')}
                disabled={isAnyBusy}
              >
                {busy === 'delete' ? <Loader2 className="animate-spin" /> : <Trash2 />}
                确认删除
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => onConfirmDelete(false)}
                disabled={isAnyBusy}
              >
                取消
              </Button>
            </div>
          </div>
        ) : (
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="border-destructive/40 text-destructive hover:bg-destructive/10 hover:text-destructive"
            onClick={() => onConfirmDelete(true)}
            disabled={isAnyBusy}
          >
            <Trash2 />
            删除分支
          </Button>
        )}
      </div>
    </section>
  );
}

function SettingsActionButton({
  icon,
  label,
  onClick,
  busy,
  disabled,
  primary,
  inline,
  tooltip,
}: {
  icon: JSX.Element;
  label: string;
  onClick: () => void;
  busy: boolean;
  disabled: boolean;
  primary?: boolean;
  inline?: boolean;
  tooltip?: string;
}): JSX.Element {
  return (
    <Button
      type="button"
      variant={primary ? 'default' : 'outline'}
      size={inline ? 'sm' : 'default'}
      onClick={onClick}
      disabled={disabled}
      title={tooltip}
      className={inline ? '' : 'flex h-auto flex-col items-center justify-center gap-1.5 py-3'}
    >
      {busy ? <Loader2 className="animate-spin" /> : icon}
      <span className={inline ? '' : 'text-xs'}>{label}</span>
    </Button>
  );
}

// ──────────────────────────────────────────────────────────────────────────
// Phase B — Metrics panel(2026-05-04)
//
// 5s 轮询 docker stats,每 service 一行卡片:CPU% + Mem%(条形)+
// Net rx/tx rate(数字),最右一个 60 点 SVG sparkline(过去 5 分钟 CPU 趋势)。
// 内联 SVG sparkline = 30 行,不引入 recharts(~50KB gzip)。
// 不持久化(关抽屉就丢)— 这是观测视图,不是审计。
// ──────────────────────────────────────────────────────────────────────────

function pushRing(
  series: MetricSeries,
  cpu: number,
  mem: number,
  rxRate: number,
  txRate: number,
): MetricSeries {
  const trim = (arr: number[], v: number): number[] => {
    const next = [...arr, v];
    return next.length > METRIC_RING_SIZE ? next.slice(next.length - METRIC_RING_SIZE) : next;
  };
  return {
    cpu: trim(series.cpu, cpu),
    mem: trim(series.mem, mem),
    rxRate: trim(series.rxRate, rxRate),
    txRate: trim(series.txRate, txRate),
  };
}

function MetricsPanel({
  state,
  series,
  onRefresh,
}: {
  state: MetricsState;
  series: Record<string, MetricSeries>;
  onRefresh: () => void;
}): JSX.Element {
  if (state.status === 'idle' || state.status === 'loading') {
    return (
      <section className="rounded-md border border-[hsl(var(--hairline))] bg-card px-5 py-8 text-center text-sm text-muted-foreground">
        <Loader2 className="mx-auto mb-2 h-4 w-4 animate-spin" />
        正在采集 docker stats…
      </section>
    );
  }
  if (state.status === 'error') {
    return (
      <section className="rounded-md border border-destructive/30 bg-destructive/10 px-5 py-4 text-sm text-destructive">
        <div className="flex items-center gap-2">
          <AlertCircle className="h-4 w-4 shrink-0" />
          <span>读取失败:{state.message}</span>
          <Button type="button" size="sm" variant="outline" className="ml-auto" onClick={onRefresh}>
            <RefreshCw />重试
          </Button>
        </div>
      </section>
    );
  }
  const data = state.data;
  if (data.services.length === 0) {
    return (
      <section className="rounded-md border border-dashed border-[hsl(var(--hairline))] bg-card px-5 py-8 text-center text-sm text-muted-foreground">
        该分支没有任何 service。先去构建配置 / 部署。
      </section>
    );
  }

  return (
    <section className="space-y-3">
      <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <span>共 {data.totalCount} 个 service · 运行中 {data.runningCount} · 每 5s 自动刷新 · 5min 滚动窗口</span>
        <Button type="button" size="sm" variant="ghost" className="ml-auto" onClick={onRefresh}>
          <RefreshCw />立即刷新
        </Button>
      </div>
      {data.services.map((svc) => (
        <ServiceMetricCard
          key={svc.profileId}
          profileId={svc.profileId}
          containerName={svc.containerName}
          status={svc.status}
          stats={svc.stats}
          series={series[svc.profileId]}
        />
      ))}
    </section>
  );
}

function ServiceMetricCard({
  profileId,
  containerName,
  status,
  stats,
  series,
}: {
  profileId: string;
  containerName: string;
  status: string;
  stats: ContainerStatsResponse | null;
  series: MetricSeries | undefined;
}): JSX.Element {
  const isRunning = status === 'running' && stats !== null;
  return (
    <div className="rounded-md border border-[hsl(var(--hairline))] bg-card px-4 py-3">
      <div className="mb-3 flex items-center justify-between gap-2">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className={`h-1.5 w-1.5 rounded-full ${statusRailClass(status)}`} aria-hidden />
            <span className="font-mono text-sm font-medium">{profileId}</span>
            <span className={`inline-flex h-5 items-center rounded-md border px-1.5 text-[10px] ${statusClass(status)}`}>
              {status}
            </span>
          </div>
          <div className="mt-0.5 truncate font-mono text-[11px] text-muted-foreground" title={containerName}>
            {containerName}
          </div>
        </div>
      </div>

      {!isRunning ? (
        <div className="text-xs text-muted-foreground">服务未运行,无指标可读。</div>
      ) : (
        <div className="grid gap-3 md:grid-cols-2">
          <MetricBar label="CPU" value={stats!.cpuPercent} unit="%" max={100} />
          <MetricBar
            label="内存"
            value={stats!.memPercent}
            unit="%"
            max={100}
            sub={`${formatBytes(stats!.memUsedBytes)} / ${formatBytes(stats!.memLimitBytes)}`}
          />
          <MetricRate label="网络入站(rx)" rate={series?.rxRate.at(-1) || 0} />
          <MetricRate label="网络出站(tx)" rate={series?.txRate.at(-1) || 0} />
        </div>
      )}

      {/* CPU sparkline — 5min 滚动窗口 */}
      {isRunning && series && series.cpu.length >= 2 ? (
        <div className="mt-3 flex items-center gap-3">
          <span className="text-[11px] text-muted-foreground">CPU 5min 趋势</span>
          <Sparkline data={series.cpu} max={Math.max(100, ...series.cpu)} />
          <span className="text-[11px] text-muted-foreground">峰值 {Math.max(...series.cpu).toFixed(1)}%</span>
        </div>
      ) : null}
    </div>
  );
}

function MetricBar({
  label,
  value,
  unit,
  max,
  sub,
}: {
  label: string;
  value: number;
  unit: string;
  max: number;
  sub?: string;
}): JSX.Element {
  const pct = Math.min(100, Math.max(0, (value / max) * 100));
  const colorClass =
    pct > 85 ? 'bg-destructive'
      : pct > 65 ? 'bg-amber-500'
        : 'bg-emerald-500';
  return (
    <div>
      <div className="mb-1 flex items-baseline justify-between text-xs">
        <span className="text-muted-foreground">{label}</span>
        <span className="font-mono font-medium">{value.toFixed(1)}{unit}</span>
      </div>
      <div className="h-1.5 overflow-hidden rounded-full bg-[hsl(var(--surface-sunken))]">
        <div className={`h-full ${colorClass} transition-[width] duration-500`} style={{ width: `${pct}%` }} />
      </div>
      {sub ? <div className="mt-0.5 text-[10px] text-muted-foreground">{sub}</div> : null}
    </div>
  );
}

function MetricRate({ label, rate }: { label: string; rate: number }): JSX.Element {
  return (
    <div>
      <div className="mb-1 text-xs text-muted-foreground">{label}</div>
      <div className="font-mono text-sm font-medium">{formatBytes(rate)}/s</div>
    </div>
  );
}

/**
 * 极简内联 SVG sparkline。zero-dep,~30 行,viewBox 0..100 × 0..30,
 * 父容器用 className 控制实际像素尺寸。data 不足 2 点时不渲染。
 */
function Sparkline({ data, max, className }: { data: number[]; max: number; className?: string }): JSX.Element | null {
  if (data.length < 2) return null;
  const width = 100;
  const height = 30;
  const safeMax = max > 0 ? max : 1;
  const points = data
    .map((v, i) => {
      const x = (i / (data.length - 1)) * width;
      const y = height - (v / safeMax) * height;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(' ');
  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="none"
      className={`flex-1 h-6 ${className || ''}`}
      aria-label="趋势"
    >
      <polyline
        fill="none"
        stroke="currentColor"
        strokeWidth="1.25"
        strokeLinecap="round"
        strokeLinejoin="round"
        points={points}
        className="text-primary"
      />
    </svg>
  );
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  let v = bytes;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v >= 100 ? 0 : v >= 10 ? 1 : 2)} ${units[i]}`;
}
