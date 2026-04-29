import type { ReactNode } from 'react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Navigate, useParams } from 'react-router-dom';
import {
  Activity,
  AlertCircle,
  ArrowLeft,
  CheckCircle2,
  Copy,
  Cpu,
  ExternalLink,
  Gauge,
  GitBranch,
  HardDrive,
  Lightbulb,
  Loader2,
  Network,
  Play,
  PowerOff,
  Plus,
  RefreshCw,
  RotateCw,
  Server,
  Settings,
  Square,
  Star,
  Tags,
  TerminalSquare,
  Trash2,
} from 'lucide-react';

import { AppShell, Crumb, PaletteHint, TopBar, Workspace } from '@/components/layout/AppShell';
import { Button } from '@/components/ui/button';
import { apiRequest, ApiError } from '@/lib/api';
import { CodePill, ErrorBlock, LoadingBlock, MetricTile } from '@/pages/cds-settings/components';

interface ProjectSummary {
  id: string;
  slug: string;
  name: string;
  aliasName?: string;
  description?: string;
  cloneStatus?: 'pending' | 'cloning' | 'ready' | 'error';
  cloneError?: string;
  githubRepoFullName?: string;
  gitRepoUrl?: string;
}

interface ServiceState {
  profileId: string;
  containerName: string;
  hostPort: number;
  status: 'idle' | 'building' | 'starting' | 'running' | 'restarting' | 'stopping' | 'stopped' | 'error';
  errorMessage?: string;
}

interface BranchSummary {
  id: string;
  projectId: string;
  branch: string;
  status: 'idle' | 'building' | 'starting' | 'running' | 'restarting' | 'stopping' | 'error';
  services: Record<string, ServiceState>;
  createdAt: string;
  lastAccessedAt?: string;
  lastDeployAt?: string;
  errorMessage?: string;
  commitSha?: string;
  subject?: string;
  previewSlug?: string;
  tags?: string[];
  isFavorite?: boolean;
  isColorMarked?: boolean;
  deployCount?: number;
  pullCount?: number;
  stopCount?: number;
}

interface BranchesResponse {
  branches: BranchSummary[];
  capacity?: {
    maxContainers: number;
    runningContainers: number;
    totalMemGB: number;
  };
}

interface RemoteBranch {
  name: string;
  date?: string;
  author?: string;
  subject?: string;
}

interface RemoteBranchesResponse {
  branches: RemoteBranch[];
}

interface PreviewModeResponse {
  mode: 'simple' | 'port' | 'multi';
}

interface CdsConfigResponse {
  workerPort?: number;
  mainDomain?: string;
  previewDomain?: string;
  rootDomains?: string[];
}

interface PreviewPortResponse {
  port: number;
}

interface ActivityEvent {
  id: number;
  ts: string;
  method: string;
  path: string;
  status: number;
  duration: number;
  type?: 'cds' | 'web';
  source?: 'user' | 'ai';
  agent?: string;
  label?: string;
  body?: string;
  query?: string;
  branchId?: string;
  branchTags?: string[];
  profileId?: string;
  remoteAddr?: string;
  referer?: string;
  userAgent?: string;
}

interface HostStatsResponse {
  mem: {
    totalMB: number;
    freeMB: number;
    usedPercent: number;
  };
  cpu: {
    cores: number;
    loadAvg1: number;
    loadAvg5: number;
    loadAvg15: number;
    loadPercent: number;
  };
  uptimeSeconds: number;
  timestamp: string;
}

interface ExecutorNodeSummary {
  id: string;
  role?: string;
  host?: string;
  port?: number;
  status: 'online' | 'offline' | string;
  capacity?: {
    maxBranches?: number;
    memoryMB?: number;
    cpuCores?: number;
  };
  load?: {
    memoryUsedMB?: number;
    cpuPercent?: number;
  };
  branchCount?: number;
  runningContainers?: number;
  lastHeartbeat?: string;
  labels?: string[];
}

interface ExecutorCapacityResponse {
  online: number;
  offline: number;
  total: {
    maxBranches: number;
    memoryMB: number;
    cpuCores: number;
  };
  used: {
    branches: number;
    memoryMB: number;
    cpuPercent: number;
  };
  freePercent: number;
  nodes: ExecutorNodeSummary[];
}

interface ClusterStatusResponse {
  mode: string;
  effectiveRole?: string;
  remoteExecutorCount?: number;
  strategy?: string;
  capacity?: ExecutorCapacityResponse;
}

type LoadState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | {
      status: 'ok';
      project: ProjectSummary;
      branches: BranchSummary[];
      remoteBranches: RemoteBranch[];
      previewMode: 'simple' | 'port' | 'multi';
      config: CdsConfigResponse;
      capacity?: BranchesResponse['capacity'];
    };

type OpsStatusState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ok'; capacity: ExecutorCapacityResponse; cluster: ClusterStatusResponse };

type BranchAction = {
  kind: 'preview' | 'deploy' | 'pull' | 'stop' | 'create' | 'favorite' | 'reset' | 'delete';
  status: 'running' | 'success' | 'error';
  message: string;
  log: string[];
  startedAt: number;
  finishedAt?: number;
  lastStep?: string;
  phase?: string;
  suggestion?: string;
};

type PreviewTarget = Window | null;
type StatusFilter = 'all' | 'running' | 'busy' | 'error' | 'favorite';
type SortMode = 'recent' | 'name' | 'status' | 'services';
type ActivityTypeFilter = 'all' | 'api' | 'web' | 'ai';

type HostStatsState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ok'; data: HostStatsResponse };

function createAction(kind: BranchAction['kind'], message: string): BranchAction {
  return {
    kind,
    status: 'running',
    message,
    log: [],
    startedAt: Date.now(),
    phase: actionPhaseFromText(message),
  };
}

function finishAction(
  current: BranchAction | undefined,
  kind: BranchAction['kind'],
  message: string,
  status: BranchAction['status'],
  suggestion?: string,
): BranchAction {
  return {
    ...(current || createAction(kind, message)),
    kind,
    status,
    message,
    phase: current?.phase || actionPhaseFromText(message),
    suggestion,
    finishedAt: Date.now(),
  };
}

function actionPhaseFromText(value: string): string {
  const text = value.toLowerCase();
  if (/clone|worktree|checkout|fetch|pull|拉取|检出|工作树|分支/.test(text)) return '代码';
  if (/detect|profile|配置|buildprofile|command|image|端口|路由/.test(text)) return '配置';
  if (/install|build|pnpm|npm|yarn|构建|依赖/.test(text)) return '构建';
  if (/container|docker|容器|启动|运行|端口/.test(text)) return '容器';
  if (/preview|proxy|预览|转发|域名/.test(text)) return '预览';
  if (/error|fail|失败|异常/.test(text)) return '失败';
  if (/done|complete|完成|就绪/.test(text)) return '完成';
  return '执行';
}

function actionStages(log: string[]): string[] {
  const stages: string[] = [];
  for (const line of log) {
    const stage = actionPhaseFromText(line);
    if (!stages.includes(stage)) stages.push(stage);
  }
  return stages.slice(-5);
}

function failureSuggestion(message: string, log: string[], branch?: BranchSummary): string {
  const failedServices = branch ? Object.values(branch.services || {}).filter((service) => service.status === 'error') : [];
  const text = [message, ...log, branch?.errorMessage || '', ...failedServices.map((service) => service.errorMessage || '')]
    .join('\n')
    .toLowerCase();

  if (/command|启动命令|no command|missing command|缺少.*命令/.test(text)) {
    return '先在分支详情的“有效配置”里补 command，然后重部署失败服务。';
  }
  if (/image|pull access denied|manifest|镜像|not found/.test(text)) {
    return '先确认 Docker 镜像名和权限；如果是项目自动识别错误，去项目设置或 BuildProfile 修正镜像后重部署。';
  }
  if (/eaddrinuse|bind|port|端口|address already in use/.test(text)) {
    return '优先检查端口冲突或 containerPort 配置；修正端口后重部署该服务。';
  }
  if (/clone|checkout|worktree|fetch|pull|仓库|repository|git/.test(text)) {
    return '先确认仓库已 clone 完成、远程分支存在且凭证有效，再重新部署或重新克隆项目。';
  }
  if (/capacity|no space|容器.*容量|内存|memory|disk/.test(text)) {
    return '先在右侧运维面板腾出容量或停止旧分支，再重新部署。';
  }
  if (failedServices.length) {
    return `先打开详情页查看 ${failedServices.map((service) => service.profileId).join(', ')} 的构建日志和容器日志。`;
  }
  return '打开分支详情查看构建日志；若配置无误，重置异常后重新部署。';
}

function actionDebugText(action: BranchAction, branch: BranchSummary): string {
  return [
    `branch=${branch.branch}`,
    `branchId=${branch.id}`,
    `status=${branch.status}`,
    `action=${action.kind}`,
    `result=${action.status}`,
    `message=${action.message}`,
    action.suggestion ? `next=${action.suggestion}` : '',
    `duration=${formatDuration((action.finishedAt || Date.now()) - action.startedAt)}`,
    '',
    '[recent steps]',
    action.log.length ? action.log.join('\n') : '(empty)',
  ].filter(Boolean).join('\n');
}

function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return rest ? `${minutes}m ${rest}s` : `${minutes}m`;
}

function formatShortTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '--:--';
  return date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
}

function activityLabel(event: ActivityEvent): string {
  if (event.label) return event.label;
  const trimmed = event.path.replace(/^\/api\//, '');
  return trimmed.length > 42 ? `${trimmed.slice(0, 39)}...` : trimmed;
}

function activityStatusClass(status: number): string {
  if (status >= 500) return 'border-destructive/30 bg-destructive/10 text-destructive';
  if (status >= 400) return 'border-amber-500/30 bg-amber-500/10 text-amber-600';
  return 'border-emerald-500/30 bg-emerald-500/10 text-emerald-600';
}

function activitySourceLabel(event: ActivityEvent): string {
  if (event.source === 'ai') return event.agent ? `AI ${event.agent}` : 'AI';
  return event.type === 'web' ? 'Web' : 'API';
}

function activityFilterMatches(event: ActivityEvent, filter: ActivityTypeFilter): boolean {
  if (filter === 'all') return true;
  if (filter === 'ai') return event.source === 'ai';
  if (filter === 'web') return event.type === 'web';
  return event.type !== 'web' && event.source !== 'ai';
}

function activityBranchMatches(event: ActivityEvent, branchId: string): boolean {
  if (!branchId) return true;
  return event.branchId === branchId || (event.branchTags || []).includes(branchId);
}

function activitySummary(event: ActivityEvent): string {
  return [
    `[${event.ts}] ${activitySourceLabel(event)}`,
    `${event.method} ${event.path}`,
    `status=${event.status}`,
    `duration=${event.duration}ms`,
    event.branchId ? `branch=${event.branchId}` : '',
    event.profileId ? `profile=${event.profileId}` : '',
  ].filter(Boolean).join(' ');
}

function estimatedNewContainers(branch: BranchSummary): number {
  if (branch.status === 'running') return 0;
  const knownServices = serviceCount(branch);
  if (knownServices === 0) return 1;
  return Math.max(0, knownServices - runningServiceCount(branch));
}

function capacityMessage(
  capacity: BranchesResponse['capacity'] | undefined,
  branchesToDeploy: BranchSummary[],
): string {
  if (!capacity || capacity.maxContainers <= 0) return '';
  const required = branchesToDeploy.reduce((sum, branch) => sum + estimatedNewContainers(branch), 0);
  if (required <= 0) return '';
  const remaining = Math.max(0, capacity.maxContainers - capacity.runningContainers);
  if (required <= remaining) return '';
  return `预计需要 ${required} 个新容器，但当前只剩 ${remaining} 个容量槽。`;
}

function sortOldestRunning(left: BranchSummary, right: BranchSummary): number {
  const leftTime = new Date(left.lastAccessedAt || left.lastDeployAt || left.createdAt || 0).getTime() || 0;
  const rightTime = new Date(right.lastAccessedAt || right.lastDeployAt || right.createdAt || 0).getTime() || 0;
  return leftTime - rightTime;
}

function formatBytesFromMB(value?: number): string {
  if (!value || value <= 0) return '未知';
  if (value >= 1024) return `${Math.round(value / 102.4) / 10} GB`;
  return `${value} MB`;
}

function formatUptime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return '未知';
  const hours = Math.floor(seconds / 3600);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  const restHours = hours % 24;
  return restHours ? `${days}d ${restHours}h` : `${days}d`;
}

function executorMemPercent(node: ExecutorNodeSummary): number {
  const total = node.capacity?.memoryMB || 0;
  if (total <= 0) return 0;
  return Math.round(((node.load?.memoryUsedMB || 0) / total) * 100);
}

function deployFailureMessage(branch?: BranchSummary): string {
  if (!branch) return '';
  const failedServices = Object.values(branch.services || {}).filter((svc) => svc.status === 'error');
  if (branch.status !== 'error' && failedServices.length === 0) return '';
  const serviceNames = failedServices.map((svc) => svc.profileId).join(', ');
  if (branch.errorMessage) return `部署失败：${branch.errorMessage}`;
  if (serviceNames) return `部署失败：${serviceNames} 启动失败`;
  return '部署失败：分支进入异常状态';
}

function projectIdFromQuery(): string {
  return new URLSearchParams(window.location.search).get('project') || '';
}

function displayName(project: ProjectSummary): string {
  return project.aliasName || project.name || project.slug || project.id;
}

function formatRelativeTime(value?: string | null): string {
  if (!value) return '暂无';
  const ts = new Date(value).getTime();
  if (!Number.isFinite(ts)) return '暂无';
  const diff = Date.now() - ts;
  const minutes = Math.max(1, Math.round(diff / 60_000));
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  const days = Math.round(hours / 24);
  return `${days} 天前`;
}

function statusLabel(status: BranchSummary['status'] | ServiceState['status']): string {
  const labels: Record<string, string> = {
    idle: '未运行',
    building: '构建中',
    starting: '启动中',
    running: '运行中',
    restarting: '重启中',
    stopping: '停止中',
    stopped: '已停止',
    error: '异常',
  };
  return labels[status] || status;
}

function statusClass(status: BranchSummary['status'] | ServiceState['status']): string {
  if (status === 'running') return 'border-emerald-500/30 bg-emerald-500/10 text-emerald-600';
  if (status === 'building' || status === 'starting' || status === 'restarting') {
    return 'border-sky-500/30 bg-sky-500/10 text-sky-600';
  }
  if (status === 'error') return 'border-destructive/30 bg-destructive/10 text-destructive';
  if (status === 'stopping') return 'border-amber-500/30 bg-amber-500/10 text-amber-600';
  return 'border-border bg-muted text-muted-foreground';
}

function statusRailClass(status: BranchSummary['status'] | ServiceState['status']): string {
  if (status === 'running') return 'bg-emerald-500';
  if (status === 'building' || status === 'starting' || status === 'restarting') return 'bg-sky-500';
  if (status === 'error') return 'bg-destructive';
  if (status === 'stopping') return 'bg-amber-500';
  return 'bg-border';
}

function serviceCount(branch: BranchSummary): number {
  return Object.keys(branch.services || {}).length;
}

function runningServiceCount(branch: BranchSummary): number {
  return Object.values(branch.services || {}).filter((svc) => svc.status === 'running').length;
}

function isBusy(branch?: BranchSummary): boolean {
  if (!branch) return false;
  return branch.status === 'building' || branch.status === 'starting' || branch.status === 'restarting' || branch.status === 'stopping';
}

function cleanHost(host?: string): string {
  if (!host) return '';
  return host.replace(/^https?:\/\//, '').replace(/\/.*$/, '').trim();
}

function isLocalHost(host: string): boolean {
  const clean = host.split(':')[0];
  return clean === 'localhost' || clean.endsWith('.localhost') || clean === '127.0.0.1' || clean === '::1';
}

function hostWithPort(host: string, port?: number): string {
  if (!port || host.includes(':')) return host;
  if (!isLocalHost(host)) return host;
  return `${host}:${port}`;
}

function multiPreviewUrl(branch: BranchSummary, config: CdsConfigResponse): string {
  const host = cleanHost(config.previewDomain || config.rootDomains?.[0]);
  if (!host) return '';
  const slug = branch.previewSlug || branch.id;
  return `${window.location.protocol}//${slug}.${hostWithPort(host, config.workerPort || 5500)}`;
}

function simplePreviewUrl(config: CdsConfigResponse): string {
  const configured = cleanHost(config.mainDomain);
  if (configured) {
    return `${window.location.protocol}//${hostWithPort(configured, config.workerPort || 5500)}`;
  }
  const port = config.workerPort || 5500;
  return `${window.location.protocol}//${window.location.hostname}:${port}`;
}

function parseSseBlock(raw: string): { event: string; data: unknown } | null {
  let event = 'message';
  let data = '';
  for (const line of raw.split('\n')) {
    if (line.startsWith('event: ')) event = line.slice(7).trim();
    if (line.startsWith('data: ')) data += line.slice(6);
  }
  if (!data) return { event, data: null };
  try {
    return { event, data: JSON.parse(data) };
  } catch {
    return { event, data };
  }
}

async function postSse(
  path: string,
  body: unknown,
  onEvent: (event: string, data: unknown) => void,
): Promise<void> {
  const res = await fetch(path, {
    method: 'POST',
    credentials: 'include',
    headers: { Accept: 'text/event-stream', 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
  });

  if (!res.ok) {
    const text = await res.text();
    let parsed: unknown = text;
    try { parsed = JSON.parse(text); } catch { /* keep text */ }
    const message =
      typeof parsed === 'object' && parsed !== null && 'error' in parsed
        ? String((parsed as { error: unknown }).error)
        : `${path} -> ${res.status}`;
    throw new ApiError(res.status, parsed, message);
  }

  if (!res.body) return;
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (value) {
      buffer += decoder.decode(value, { stream: !done });
      let index = buffer.indexOf('\n\n');
      while (index >= 0) {
        const block = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        if (block.trim() && !block.startsWith(':')) {
          const parsed = parseSseBlock(block);
          if (parsed) onEvent(parsed.event, parsed.data);
        }
        index = buffer.indexOf('\n\n');
      }
    }
    if (done) break;
  }
}

function eventMessage(event: string, data: unknown): string {
  if (typeof data === 'object' && data !== null) {
    const obj = data as Record<string, unknown>;
    if (typeof obj.title === 'string') return obj.title;
    if (typeof obj.message === 'string') return obj.message;
    if (typeof obj.chunk === 'string') return obj.chunk.trim();
    if (typeof obj.step === 'string') return obj.step;
  }
  if (typeof data === 'string') return data;
  return event;
}

function openPreviewPlaceholder(): PreviewTarget {
  const target = window.open('about:blank', '_blank');
  if (!target) return null;
  try {
    target.opener = null;
    target.document.title = 'CDS Preview';
    target.document.body.style.margin = '0';
    target.document.body.style.fontFamily = 'system-ui, sans-serif';
    target.document.body.style.background = '#0f1014';
    target.document.body.style.color = '#f4f4f5';
    target.document.body.innerHTML = '<div style="padding:24px">CDS is preparing the preview...</div>';
  } catch {
    // The window still exists; navigation below can continue.
  }
  return target;
}

function navigatePreview(target: PreviewTarget, url: string): void {
  if (target && !target.closed) {
    target.location.href = url;
    return;
  }
  window.open(url, '_blank', 'noopener,noreferrer');
}

function closePreviewTarget(target: PreviewTarget): void {
  try {
    if (target && !target.closed && target.location.href === 'about:blank') target.close();
  } catch {
    // ignore cross-origin or already-closed windows
  }
}

export function BranchListPage(): JSX.Element {
  const { projectId: projectIdParam } = useParams();
  const projectId = projectIdParam || projectIdFromQuery();
  const [state, setState] = useState<LoadState>({ status: 'loading' });
  const [filter, setFilter] = useState('');
  const [remoteFilter, setRemoteFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [sortMode, setSortMode] = useState<SortMode>('recent');
  const [selectedBranchIds, setSelectedBranchIds] = useState<string[]>([]);
  const [manualBranchName, setManualBranchName] = useState('');
  const [toast, setToast] = useState('');
  const [actions, setActions] = useState<Record<string, BranchAction>>({});
  const [actionClock, setActionClock] = useState(Date.now());
  const [activityEvents, setActivityEvents] = useState<ActivityEvent[]>([]);
  const [activityTypeFilter, setActivityTypeFilter] = useState<ActivityTypeFilter>('all');
  const [activityBranchFilter, setActivityBranchFilter] = useState('');
  const [selectedActivityId, setSelectedActivityId] = useState<number | null>(null);
  const [opsStatus, setOpsStatus] = useState<OpsStatusState>({ status: 'loading' });
  const [hostStats, setHostStats] = useState<HostStatsState>({ status: 'loading' });
  const [executorAction, setExecutorAction] = useState<Record<string, string>>({});
  const [selectedBranchId, setSelectedBranchId] = useState<string | null>(null);
  const [opsDrawerOpen, setOpsDrawerOpen] = useState(false);
  const actionRef = useRef<Record<string, BranchAction>>({});
  const previewQueryRef = useRef(new URLSearchParams(window.location.search).get('preview') || '');
  const previewQueryConsumedRef = useRef(false);

  const setAction = useCallback((key: string, next: BranchAction | null) => {
    actionRef.current = { ...actionRef.current };
    if (next) actionRef.current[key] = next;
    else delete actionRef.current[key];
    setActions(actionRef.current);
  }, []);

  const appendActionLog = useCallback((key: string, line: string) => {
    if (!line) return;
    const current = actionRef.current[key];
    if (!current) return;
    setAction(key, {
      ...current,
      phase: actionPhaseFromText(line),
      lastStep: line,
      log: [...current.log.slice(-60), line],
    });
  }, [setAction]);

  useEffect(() => {
    if (!Object.values(actions).some((action) => action.status === 'running')) return;
    const timer = window.setInterval(() => setActionClock(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [actions]);

  const refresh = useCallback(async (showLoading = false) => {
    if (!projectId) return;
    if (showLoading) setState({ status: 'loading' });
    try {
      const [project, branchesRes, remoteRes, previewModeRes, config] = await Promise.all([
        apiRequest<ProjectSummary>(`/api/projects/${encodeURIComponent(projectId)}`),
        apiRequest<BranchesResponse>(`/api/branches?project=${encodeURIComponent(projectId)}`),
        apiRequest<RemoteBranchesResponse>(`/api/remote-branches?project=${encodeURIComponent(projectId)}`).catch(() => ({ branches: [] })),
        apiRequest<PreviewModeResponse>(`/api/projects/${encodeURIComponent(projectId)}/preview-mode`).catch(() => ({ mode: 'multi' as const })),
        apiRequest<CdsConfigResponse>('/api/config').catch(() => ({})),
      ]);
      setState({
        status: 'ok',
        project,
        branches: branchesRes.branches || [],
        remoteBranches: remoteRes.branches || [],
        previewMode: previewModeRes.mode || 'multi',
        config,
        capacity: branchesRes.capacity,
      });
    } catch (err) {
      const message = err instanceof ApiError ? err.message : String(err);
      setState({ status: 'error', message });
    }
  }, [projectId]);

  useEffect(() => {
    void refresh(true);
  }, [refresh]);

  const refreshOpsStatus = useCallback(async () => {
    try {
      const headers = { 'X-CDS-Poll': 'true' };
      const [capacity, cluster] = await Promise.all([
        apiRequest<ExecutorCapacityResponse>('/api/executors/capacity', { headers }),
        apiRequest<ClusterStatusResponse>('/api/cluster/status', { headers }),
      ]);
      setOpsStatus({ status: 'ok', capacity, cluster });
    } catch (err) {
      const message = err instanceof ApiError ? err.message : String(err);
      setOpsStatus({ status: 'error', message });
    }
  }, []);

  useEffect(() => {
    void refreshOpsStatus();
    const timer = window.setInterval(() => void refreshOpsStatus(), 15_000);
    return () => window.clearInterval(timer);
  }, [refreshOpsStatus]);

  const refreshHostStats = useCallback(async () => {
    try {
      const data = await apiRequest<HostStatsResponse>('/api/host-stats', {
        headers: { 'X-CDS-Poll': 'true' },
      });
      setHostStats({ status: 'ok', data });
    } catch (err) {
      const message = err instanceof ApiError ? err.message : String(err);
      setHostStats({ status: 'error', message });
    }
  }, []);

  useEffect(() => {
    void refreshHostStats();
    const timer = window.setInterval(() => void refreshHostStats(), 8_000);
    return () => window.clearInterval(timer);
  }, [refreshHostStats]);

  useEffect(() => {
    if (!projectId) return;
    const source = new EventSource(`/api/branches/stream?project=${encodeURIComponent(projectId)}`);
    const upsert = (branch: BranchSummary) => {
      setState((current) => {
        if (current.status !== 'ok') return current;
        const existing = current.branches.find((item) => item.id === branch.id);
        const branches = existing
          ? current.branches.map((item) => (item.id === branch.id ? { ...item, ...branch } : item))
          : [branch, ...current.branches];
        return { ...current, branches };
      });
    };
    source.addEventListener('snapshot', (ev) => {
      const data = JSON.parse((ev as MessageEvent).data) as { branches?: BranchSummary[] };
      setState((current) => (current.status === 'ok' ? { ...current, branches: data.branches || [] } : current));
    });
    source.addEventListener('branch.created', (ev) => {
      const data = JSON.parse((ev as MessageEvent).data) as { branch?: BranchSummary };
      if (data.branch) upsert(data.branch);
    });
    source.addEventListener('branch.updated', (ev) => {
      const data = JSON.parse((ev as MessageEvent).data) as { branch?: BranchSummary };
      if (data.branch) upsert(data.branch);
    });
    source.addEventListener('branch.status', (ev) => {
      const data = JSON.parse((ev as MessageEvent).data) as { branchId?: string; status?: BranchSummary['status'] };
      if (!data.branchId || !data.status) return;
      setState((current) => {
        if (current.status !== 'ok') return current;
        return {
          ...current,
          branches: current.branches.map((branch) =>
            branch.id === data.branchId ? { ...branch, status: data.status as BranchSummary['status'] } : branch,
          ),
        };
      });
    });
    source.addEventListener('branch.removed', (ev) => {
      const data = JSON.parse((ev as MessageEvent).data) as { branchId?: string };
      if (!data.branchId) return;
      setState((current) => (
        current.status === 'ok'
          ? { ...current, branches: current.branches.filter((branch) => branch.id !== data.branchId) }
          : current
      ));
    });
    return () => source.close();
  }, [projectId]);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(''), 3200);
    return () => window.clearTimeout(timer);
  }, [toast]);

  useEffect(() => {
    const source = new EventSource('/api/activity-stream');
    source.onmessage = (event) => {
      try {
        const parsed = JSON.parse(event.data) as ActivityEvent;
        if (!parsed.id || !parsed.path) return;
        setActivityEvents((current) => {
          const next = current.some((item) => item.id === parsed.id) ? current : [parsed, ...current];
          return next.slice(0, 30);
        });
      } catch {
        // Keep the dashboard usable if a partial SSE chunk is malformed.
      }
    };
    source.onerror = () => {
      // Native EventSource will retry; do not surface transient disconnects as page errors.
    };
    return () => source.close();
  }, []);

  const branches = state.status === 'ok' ? state.branches : [];
  const remoteBranches = state.status === 'ok' ? state.remoteBranches : [];
  const trackedByName = useMemo(() => new Map(branches.map((branch) => [branch.branch, branch])), [branches]);
  const selectedBranches = useMemo(
    () => branches.filter((branch) => selectedBranchIds.includes(branch.id)),
    [branches, selectedBranchIds],
  );
  const filteredBranches = useMemo(() => {
    const query = filter.trim().toLowerCase();
    const matchesQuery = (branch: BranchSummary) => {
      if (!query) return true;
      return [
        branch.branch,
        branch.id,
        branch.subject || '',
        branch.commitSha || '',
        ...(branch.tags || []),
      ].some((value) => value.toLowerCase().includes(query));
    };

    const matchesStatus = (branch: BranchSummary) => {
      if (statusFilter === 'running') return branch.status === 'running';
      if (statusFilter === 'busy') return isBusy(branch);
      if (statusFilter === 'error') return branch.status === 'error';
      if (statusFilter === 'favorite') return !!branch.isFavorite;
      return true;
    };

    const score = (branch: BranchSummary) => new Date(branch.lastAccessedAt || branch.lastDeployAt || branch.createdAt || 0).getTime() || 0;

    return branches
      .filter((branch) => matchesQuery(branch) && matchesStatus(branch))
      .sort((left, right) => {
        if (!!left.isFavorite !== !!right.isFavorite) return left.isFavorite ? -1 : 1;
        if (sortMode === 'name') return left.branch.localeCompare(right.branch);
        if (sortMode === 'status') return statusLabel(left.status).localeCompare(statusLabel(right.status)) || left.branch.localeCompare(right.branch);
        if (sortMode === 'services') return runningServiceCount(right) - runningServiceCount(left) || serviceCount(right) - serviceCount(left);
        return score(right) - score(left);
      });
  }, [branches, filter, sortMode, statusFilter]);
  const visibleBranchIds = useMemo(() => new Set(filteredBranches.map((branch) => branch.id)), [filteredBranches]);
  const allVisibleSelected = filteredBranches.length > 0 && filteredBranches.every((branch) => selectedBranchIds.includes(branch.id));
  const visibleRemoteBranches = useMemo(() => {
    const query = remoteFilter.trim().toLowerCase();
    return remoteBranches
      .filter((branch) => !query || branch.name.toLowerCase().includes(query) || (branch.subject || '').toLowerCase().includes(query))
      .slice(0, 24);
  }, [remoteBranches, remoteFilter]);
  const activityBranchOptions = useMemo(
    () => branches.map((branch) => ({ id: branch.id, label: branch.branch || branch.id })),
    [branches],
  );

  /*
   * Service-canvas selection model. The canvas shows a single "selected" branch
   * as the right-side master view. We auto-select the most relevant branch on
   * load (running > favorite > most-recent) and keep the selection valid as
   * branches stream in / out.
   */
  const selectedBranch = useMemo(
    () => (selectedBranchId ? branches.find((branch) => branch.id === selectedBranchId) || null : null),
    [branches, selectedBranchId],
  );

  useEffect(() => {
    if (branches.length === 0) {
      if (selectedBranchId) setSelectedBranchId(null);
      return;
    }
    if (selectedBranchId && branches.some((branch) => branch.id === selectedBranchId)) return;
    const running = branches.find((branch) => branch.status === 'running');
    const favorite = branches.find((branch) => branch.isFavorite);
    const fallback = filteredBranches[0] || branches[0];
    setSelectedBranchId((running || favorite || fallback).id);
  }, [branches, filteredBranches, selectedBranchId]);

  useEffect(() => {
    if (selectedBranchIds.length === 0) return;
    const liveIds = new Set(branches.map((branch) => branch.id));
    setSelectedBranchIds((current) => current.filter((id) => liveIds.has(id)));
  }, [branches, selectedBranchIds.length]);

  const toggleSelectedBranch = useCallback((branchId: string) => {
    setSelectedBranchIds((current) => (
      current.includes(branchId) ? current.filter((id) => id !== branchId) : [...current, branchId]
    ));
  }, []);

  const toggleVisibleSelection = useCallback(() => {
    setSelectedBranchIds((current) => {
      if (filteredBranches.length === 0) return current;
      if (filteredBranches.every((branch) => current.includes(branch.id))) {
        return current.filter((id) => !visibleBranchIds.has(id));
      }
      return Array.from(new Set([...current, ...filteredBranches.map((branch) => branch.id)]));
    });
  }, [filteredBranches, visibleBranchIds]);

  const openRunningPreview = useCallback(async (branch: BranchSummary, target?: PreviewTarget): Promise<void> => {
    if (state.status !== 'ok') return;
    setAction(branch.id, createAction('preview', '正在打开预览'));
    try {
      let url = '';
      if (state.previewMode === 'port') {
        const result = await apiRequest<PreviewPortResponse>(`/api/branches/${encodeURIComponent(branch.id)}/preview-port`, {
          method: 'POST',
        });
        url = `${window.location.protocol}//${window.location.hostname}:${result.port}`;
      } else if (state.previewMode === 'simple') {
        await apiRequest(`/api/branches/${encodeURIComponent(branch.id)}/set-default`, { method: 'POST' });
        url = simplePreviewUrl(state.config);
      } else {
        url = multiPreviewUrl(branch, state.config);
      }

      if (!url) throw new Error('缺少预览域名配置');
      navigatePreview(target || null, url);
      setAction(branch.id, null);
    } catch (err) {
      const message = err instanceof ApiError ? err.message : String(err);
      closePreviewTarget(target || null);
      setAction(branch.id, finishAction(actionRef.current[branch.id], 'preview', message, 'error'));
      setToast(message);
    }
  }, [setAction, state]);

  const confirmCapacity = useCallback((branchList: BranchSummary[], label: string): boolean => {
    if (state.status !== 'ok') return true;
    const message = capacityMessage(state.capacity, branchList);
    if (!message) return true;
    return window.confirm(`${label} 可能超过当前容量。\n\n${message}\n\n仍然继续?`);
  }, [state]);

  const deployBranch = useCallback(async (
    branch: BranchSummary,
    openAfterDeploy = false,
    previewTarget?: PreviewTarget,
    options: { skipCapacityConfirm?: boolean } = {},
  ): Promise<void> => {
    if (!options.skipCapacityConfirm && !confirmCapacity([branch], openAfterDeploy ? '预览部署' : '部署')) return;
    const key = branch.id;
    const kind = openAfterDeploy ? 'preview' : 'deploy';
    setAction(key, createAction(kind, '正在部署'));
    try {
      await postSse(`/api/branches/${encodeURIComponent(branch.id)}/deploy`, {}, (event, data) => {
        appendActionLog(key, eventMessage(event, data));
      });
      let latestBranch: BranchSummary | undefined;
      if (projectId) {
        const latest = await apiRequest<BranchesResponse>(`/api/branches?project=${encodeURIComponent(projectId)}`);
        latestBranch = latest.branches.find((item) => item.id === branch.id);
      }
      const failure = deployFailureMessage(latestBranch);
      if (failure) {
        setAction(key, finishAction(
          actionRef.current[key],
          kind,
          failure,
          'error',
          failureSuggestion(failure, actionRef.current[key]?.log || [], latestBranch),
        ));
        await refresh(false);
        setToast(failure);
        return;
      }
      setAction(key, finishAction(actionRef.current[key], kind, '部署完成', 'success'));
      await refresh(false);
      if (openAfterDeploy) {
        await openRunningPreview(branch, previewTarget);
      } else {
        setToast(`${branch.branch} 部署完成`);
      }
    } catch (err) {
      const message = err instanceof ApiError ? err.message : String(err);
      closePreviewTarget(previewTarget || null);
      setAction(key, finishAction(
        actionRef.current[key],
        kind,
        message,
        'error',
        failureSuggestion(message, actionRef.current[key]?.log || [], branch),
      ));
      setToast(message);
    }
  }, [appendActionLog, confirmCapacity, openRunningPreview, projectId, refresh, setAction]);

  const openPreview = useCallback(async (branch: BranchSummary, deployWhenNeeded = true): Promise<void> => {
    if (state.status !== 'ok') return;
    if (branch.status !== 'running') {
      if (!deployWhenNeeded || isBusy(branch)) {
        setToast(`${branch.branch} 还未运行`);
        return;
      }
      const target = openPreviewPlaceholder();
      await deployBranch(branch, true, target);
      return;
    }

    const target = openPreviewPlaceholder();
    await openRunningPreview(branch, target);
  }, [deployBranch, openRunningPreview, state]);

  const stopBranch = useCallback(async (branch: BranchSummary): Promise<void> => {
    setAction(branch.id, createAction('stop', '正在停止'));
    try {
      await apiRequest(`/api/branches/${encodeURIComponent(branch.id)}/stop`, { method: 'POST' });
      setAction(branch.id, null);
      setToast(`${branch.branch} 已停止`);
      await refresh(false);
    } catch (err) {
      const message = err instanceof ApiError ? err.message : String(err);
      setAction(branch.id, finishAction(actionRef.current[branch.id], 'stop', message, 'error'));
      setToast(message);
    }
  }, [refresh, setAction]);

  const patchBranch = useCallback(async (
    branch: BranchSummary,
    body: Partial<Pick<BranchSummary, 'isFavorite' | 'isColorMarked' | 'tags'>>,
  ): Promise<void> => {
    try {
      await apiRequest(`/api/branches/${encodeURIComponent(branch.id)}`, {
        method: 'PATCH',
        body,
      });
      setState((current) => {
        if (current.status !== 'ok') return current;
        return {
          ...current,
          branches: current.branches.map((item) =>
            item.id === branch.id ? { ...item, ...body } : item,
          ),
        };
      });
    } catch (err) {
      const message = err instanceof ApiError ? err.message : String(err);
      setToast(message);
    }
  }, []);

  const resetBranch = useCallback(async (branch: BranchSummary): Promise<void> => {
    setAction(branch.id, createAction('reset', '正在重置状态'));
    try {
      await apiRequest(`/api/branches/${encodeURIComponent(branch.id)}/reset`, { method: 'POST' });
      setAction(branch.id, null);
      setToast(`${branch.branch} 状态已重置`);
      await refresh(false);
    } catch (err) {
      const message = err instanceof ApiError ? err.message : String(err);
      setAction(branch.id, finishAction(actionRef.current[branch.id], 'reset', message, 'error'));
      setToast(message);
    }
  }, [refresh, setAction]);

  const deleteBranchCore = useCallback(async (
    branch: BranchSummary,
    options: { confirmFirst?: boolean; refreshAfter?: boolean } = {},
  ): Promise<boolean> => {
    const { confirmFirst = true, refreshAfter = true } = options;
    if (confirmFirst) {
      const ok = window.confirm(`确定删除分支 "${branch.branch}"？这会停止服务并删除该分支工作区。`);
      if (!ok) return false;
    }
    setAction(branch.id, createAction('delete', '正在删除分支'));
    try {
      const res = await fetch(`/api/branches/${encodeURIComponent(branch.id)}`, {
        method: 'DELETE',
        credentials: 'include',
        headers: { Accept: 'text/event-stream' },
      });
      if (!res.ok) {
        const text = await res.text();
        throw new Error(text || `DELETE /api/branches/${branch.id} -> ${res.status}`);
      }
      if (res.body) {
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        for (;;) {
          const { value, done } = await reader.read();
          if (value) {
            buffer += decoder.decode(value, { stream: !done });
            let index = buffer.indexOf('\n\n');
            while (index >= 0) {
              const block = buffer.slice(0, index);
              buffer = buffer.slice(index + 2);
              const parsed = parseSseBlock(block);
              if (parsed) appendActionLog(branch.id, eventMessage(parsed.event, parsed.data));
              index = buffer.indexOf('\n\n');
            }
          }
          if (done) break;
        }
      }
      setAction(branch.id, null);
      setToast(`${branch.branch} 已删除`);
      if (refreshAfter) await refresh(false);
      return true;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setAction(branch.id, finishAction(actionRef.current[branch.id], 'delete', message, 'error'));
      setToast(message);
      return false;
    }
  }, [appendActionLog, refresh, setAction]);

  const deleteBranch = useCallback(async (branch: BranchSummary): Promise<void> => {
    await deleteBranchCore(branch);
  }, [deleteBranchCore]);

  const editTags = useCallback(async (branch: BranchSummary): Promise<void> => {
    const current = (branch.tags || []).join(', ');
    const input = window.prompt('输入标签，多个标签用逗号分隔', current);
    if (input === null) return;
    const tags = Array.from(
      new Set(
        input
          .split(',')
          .map((tag) => tag.trim())
          .filter(Boolean),
      ),
    );
    await patchBranch(branch, { tags });
  }, [patchBranch]);

  const pullBranch = useCallback(async (branch: BranchSummary): Promise<void> => {
    setAction(branch.id, createAction('pull', '正在拉取代码'));
    try {
      await apiRequest(`/api/branches/${encodeURIComponent(branch.id)}/pull`, { method: 'POST' });
      setAction(branch.id, null);
      setToast(`${branch.branch} 已更新`);
      await refresh(false);
    } catch (err) {
      const message = err instanceof ApiError ? err.message : String(err);
      setAction(branch.id, finishAction(actionRef.current[branch.id], 'pull', message, 'error'));
      setToast(message);
    }
  }, [refresh, setAction]);

  const runBulkAction = useCallback(async (
    label: string,
    branchList: BranchSummary[],
    action: (branch: BranchSummary) => Promise<void>,
  ): Promise<void> => {
    if (branchList.length === 0) {
      setToast('先选择分支');
      return;
    }
    if (label.includes('部署') && !confirmCapacity(branchList, label)) return;
    setToast(`${label}：${branchList.length} 个分支`);
    for (const branch of branchList) {
      await action(branch);
    }
    setSelectedBranchIds([]);
    await refresh(false);
  }, [confirmCapacity, refresh]);

  const bulkSetFavorite = useCallback(async (branchList: BranchSummary[], value: boolean): Promise<void> => {
    if (branchList.length === 0) {
      setToast('先选择分支');
      return;
    }
    setToast(`${value ? '收藏' : '取消收藏'}：${branchList.length} 个分支`);
    for (const branch of branchList) {
      setAction(branch.id, createAction('favorite', value ? '正在收藏' : '正在取消收藏'));
      try {
        await apiRequest(`/api/branches/${encodeURIComponent(branch.id)}`, {
          method: 'PATCH',
          body: { isFavorite: value },
        });
        setAction(branch.id, null);
      } catch (err) {
        const message = err instanceof ApiError ? err.message : String(err);
        setAction(branch.id, finishAction(actionRef.current[branch.id], 'favorite', message, 'error'));
        setToast(message);
      }
    }
    setSelectedBranchIds([]);
    await refresh(false);
  }, [refresh, setAction]);

  const bulkResetErrored = useCallback(async (branchList: BranchSummary[]): Promise<void> => {
    const errored = branchList.filter((branch) => branch.status === 'error');
    if (errored.length === 0) {
      setToast('所选分支没有异常状态');
      return;
    }
    await runBulkAction('批量重置异常', errored, resetBranch);
  }, [resetBranch, runBulkAction]);

  const bulkDeleteBranches = useCallback(async (branchList: BranchSummary[]): Promise<void> => {
    if (branchList.length === 0) {
      setToast('先选择分支');
      return;
    }
    const ok = window.confirm(`确定删除 ${branchList.length} 个分支？这会停止服务并删除对应工作区。`);
    if (!ok) return;
    let deleted = 0;
    for (const branch of branchList) {
      if (await deleteBranchCore(branch, { confirmFirst: false, refreshAfter: false })) deleted += 1;
    }
    setSelectedBranchIds([]);
    setToast(`已删除 ${deleted}/${branchList.length} 个分支`);
    await refresh(false);
  }, [deleteBranchCore, refresh]);

  const previewRemoteBranch = useCallback(async (remote: RemoteBranch): Promise<void> => {
    if (!projectId || state.status !== 'ok') return;
    const existing = trackedByName.get(remote.name);
    if (existing) {
      await openPreview(existing, true);
      return;
    }

    const target = openPreviewPlaceholder();
    setAction(remote.name, createAction('create', '正在创建分支'));
    try {
      const result = await apiRequest<{ branch: BranchSummary }>('/api/branches', {
        method: 'POST',
        body: { branch: remote.name, projectId },
      });
      setAction(remote.name, null);
      await refresh(false);
      await deployBranch(result.branch, true, target);
    } catch (err) {
      const message = err instanceof ApiError ? err.message : String(err);
      closePreviewTarget(target);
      setAction(remote.name, finishAction(actionRef.current[remote.name], 'create', message, 'error'));
      setToast(message);
    }
  }, [deployBranch, openPreview, projectId, refresh, setAction, state, trackedByName]);

  const previewBranchByName = useCallback(async (name: string): Promise<void> => {
    const branchName = name.trim();
    if (!branchName) {
      setToast('输入分支名');
      return;
    }
    if (!projectId || state.status !== 'ok') return;
    const existing = trackedByName.get(branchName) || branches.find((branch) => branch.id === branchName);
    if (existing) {
      await openPreview(existing, true);
      return;
    }
    const target = openPreviewPlaceholder();
    setAction(branchName, createAction('create', '正在创建分支'));
    try {
      const result = await apiRequest<{ branch: BranchSummary }>('/api/branches', {
        method: 'POST',
        body: { branch: branchName, projectId },
      });
      setManualBranchName('');
      setAction(branchName, null);
      await refresh(false);
      await deployBranch(result.branch, true, target);
    } catch (err) {
      const message = err instanceof ApiError ? err.message : String(err);
      closePreviewTarget(target);
      setAction(branchName, finishAction(actionRef.current[branchName], 'create', message, 'error'));
      setToast(message);
    }
  }, [branches, deployBranch, openPreview, projectId, refresh, setAction, state, trackedByName]);

  useEffect(() => {
    const requestedBranch = previewQueryRef.current.trim();
    if (previewQueryConsumedRef.current || !requestedBranch || state.status !== 'ok') return;
    previewQueryConsumedRef.current = true;
    setManualBranchName(requestedBranch);
    const params = new URLSearchParams(window.location.search);
    params.delete('preview');
    window.history.replaceState(null, '', `${window.location.pathname}${params.toString() ? `?${params.toString()}` : ''}`);
    void previewBranchByName(requestedBranch);
  }, [previewBranchByName, state.status]);

  const capacityAssist = useMemo(() => {
    if (state.status !== 'ok' || !state.capacity || selectedBranches.length === 0) {
      return { deficit: 0, candidates: [] as BranchSummary[], freed: 0 };
    }
    const required = selectedBranches.reduce((sum, branch) => sum + estimatedNewContainers(branch), 0);
    const remaining = Math.max(0, state.capacity.maxContainers - state.capacity.runningContainers);
    const deficit = Math.max(0, required - remaining);
    if (deficit === 0) return { deficit: 0, candidates: [] as BranchSummary[], freed: 0 };

    const selectedIds = new Set(selectedBranches.map((branch) => branch.id));
    const candidates: BranchSummary[] = [];
    let freed = 0;
    for (const branch of branches
      .filter((item) => item.status === 'running' && !selectedIds.has(item.id))
      .sort(sortOldestRunning)) {
      candidates.push(branch);
      freed += Math.max(1, runningServiceCount(branch));
      if (freed >= deficit) break;
    }
    return { deficit, candidates, freed };
  }, [branches, selectedBranches, state]);

  const stopOldBranchesForCapacity = useCallback(async (): Promise<void> => {
    if (capacityAssist.deficit <= 0 || capacityAssist.candidates.length === 0) {
      setToast('没有可停止的旧运行分支');
      return;
    }
    const list = capacityAssist.candidates.map((branch) => branch.branch).join('\n');
    const ok = window.confirm(
      `将停止 ${capacityAssist.candidates.length} 个较旧运行分支以腾出约 ${capacityAssist.freed} 个容量槽。\n\n${list}\n\n继续?`,
    );
    if (!ok) return;
    for (const branch of capacityAssist.candidates) {
      await stopBranch(branch);
    }
    await refresh(false);
  }, [capacityAssist, refresh, stopBranch]);

  const drainExecutor = useCallback(async (node: ExecutorNodeSummary): Promise<void> => {
    if (!node.id) return;
    const ok = window.confirm(`确认排空执行器 "${node.id}"？它不会再接收新的分支部署，已有服务不会立即删除。`);
    if (!ok) return;
    setExecutorAction((current) => ({ ...current, [node.id]: '排空中' }));
    try {
      await apiRequest(`/api/executors/${encodeURIComponent(node.id)}/drain`, { method: 'POST' });
      setToast(`执行器 ${node.id} 已进入排空状态`);
      await refreshOpsStatus();
    } catch (err) {
      setToast(err instanceof ApiError ? err.message : String(err));
    } finally {
      setExecutorAction((current) => {
        const next = { ...current };
        delete next[node.id];
        return next;
      });
    }
  }, [refreshOpsStatus]);

  const removeExecutor = useCallback(async (node: ExecutorNodeSummary): Promise<void> => {
    if (!node.id) return;
    const ok = window.confirm(
      `确认移除执行器 "${node.id}"？\n\n这只会从主节点注册表移除该节点，不会 SSH 到远端机器停止进程。在线节点可能会在下一次心跳后重新出现。`,
    );
    if (!ok) return;
    setExecutorAction((current) => ({ ...current, [node.id]: '移除中' }));
    try {
      await apiRequest(`/api/executors/${encodeURIComponent(node.id)}`, { method: 'DELETE' });
      setToast(`执行器 ${node.id} 已移除`);
      await refreshOpsStatus();
    } catch (err) {
      setToast(err instanceof ApiError ? err.message : String(err));
    } finally {
      setExecutorAction((current) => {
        const next = { ...current };
        delete next[node.id];
        return next;
      });
    }
  }, [refreshOpsStatus]);

  if (!projectId) return <Navigate to="/project-list" replace />;

  const title = state.status === 'ok' ? displayName(state.project) : projectId;
  const runningServices = branches.reduce((sum, branch) => sum + runningServiceCount(branch), 0);
  const selectedAllFavorite = selectedBranches.length > 0 && selectedBranches.every((branch) => branch.isFavorite);
  const selectedErroredCount = selectedBranches.filter((branch) => branch.status === 'error').length;
  const branchIdSet = new Set(branches.map((branch) => branch.id));
  const recentActivityEvents = activityEvents
    .filter((event) => !event.branchId || branchIdSet.has(event.branchId) || event.path.includes(`/projects/${projectId}`))
    .filter((event) => activityFilterMatches(event, activityTypeFilter))
    .filter((event) => activityBranchMatches(event, activityBranchFilter))
    .slice(0, 8);
  const selectedActivity = recentActivityEvents.find((event) => event.id === selectedActivityId) || null;
  const selectedNewContainers = selectedBranches.reduce((sum, branch) => sum + estimatedNewContainers(branch), 0);
  const capacityRemaining = state.status === 'ok' && state.capacity
    ? Math.max(0, state.capacity.maxContainers - state.capacity.runningContainers)
    : null;
  const selectedCapacityWarning = state.status === 'ok' ? capacityMessage(state.capacity, selectedBranches) : '';
  const onlineExecutors = opsStatus.status === 'ok' ? opsStatus.capacity.online : 0;
  const totalExecutors = opsStatus.status === 'ok' ? opsStatus.capacity.online + opsStatus.capacity.offline : 0;
  const executorFreePercent = opsStatus.status === 'ok' ? Math.round(opsStatus.capacity.freePercent) : 0;
  const clusterMode = opsStatus.status === 'ok' ? opsStatus.cluster.mode : 'unknown';

  /*
   * Render — Week 4.6 visual rebuild.
   *
   * AppShell carries the rail. TopBar carries breadcrumb + inline stats +
   * project switching actions. Hero collapses the legacy "一键预览控制台"
   * banner into a single primary input row matching ProjectListPage.
   *
   * Inner branch grid + right ops aside are kept as-is in this slice; the
   * Railway service-canvas reorganization (left list + right master view)
   * is the next slice once the visual surface is unified.
   */
  return (
    <AppShell
      active="projects"
      wide
      topbar={
        <TopBar
          left={
            <>
              <Crumb
                items={[
                  { label: 'CDS', href: '/project-list' },
                  { label: title, href: `/branches/${encodeURIComponent(projectId)}` },
                  { label: '分支' },
                ]}
              />
              {state.status === 'ok' ? (
                <div className="hidden items-center gap-4 border-l border-[hsl(var(--hairline))] pl-4 md:flex">
                  <span className="cds-stat">
                    <span className="cds-stat-value">{branches.length}</span>
                    <span className="cds-stat-label">分支</span>
                  </span>
                  <span className="cds-stat">
                    <span className="cds-stat-value">{runningServices}</span>
                    <span className="cds-stat-label">运行</span>
                  </span>
                  {state.capacity ? (
                    <span className="cds-stat">
                      <span className="cds-stat-value tabular-nums">
                        {state.capacity.runningContainers}/{state.capacity.maxContainers}
                      </span>
                      <span className="cds-stat-label">容量</span>
                    </span>
                  ) : null}
                </div>
              ) : null}
            </>
          }
          right={
            <>
              <PaletteHint />
              <Button asChild variant="ghost" size="sm" title="项目列表">
                <a href="/project-list">
                  <ArrowLeft />
                  项目
                </a>
              </Button>
              <Button asChild variant="ghost" size="sm" title="项目设置">
                <a href={`/settings/${encodeURIComponent(projectId)}`}>
                  <Settings />
                </a>
              </Button>
              <Button asChild variant="ghost" size="sm" title="服务拓扑">
                <a href={`/branch-topology?project=${encodeURIComponent(projectId)}`}>
                  <Network />
                </a>
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setOpsDrawerOpen(true)}
                title="运维抽屉"
              >
                <Activity />
                运维
              </Button>
              <Button
                variant="ghost"
                size="icon"
                onClick={() => void refresh(false)}
                aria-label="刷新"
                title="刷新"
              >
                <RefreshCw />
              </Button>
            </>
          }
        />
      }
    >
      <Workspace wide>
        {/* Hero: paste branch name → preview. Mirrors ProjectListPage hero. */}
        <section className="cds-hero">
          <div className="flex flex-wrap items-end justify-between gap-3">
            <div className="min-w-0">
              <h1 className="cds-hero-title">预览分支</h1>
              <p className="cds-hero-hint">粘贴分支名 / commit / tag，CDS 会自动创建、部署并打开预览。</p>
            </div>
          </div>
          <form
            className="mt-4 grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center"
            onSubmit={(event) => {
              event.preventDefault();
              void previewBranchByName(manualBranchName);
            }}
          >
            <label className="sr-only" htmlFor="manual-branch-name">
              分支名
            </label>
            <div className="flex min-w-0 items-center gap-2 rounded-md border border-[hsl(var(--hairline))] bg-[hsl(var(--surface-sunken))] px-3.5">
              <GitBranch className="h-4 w-4 shrink-0 text-muted-foreground" />
              <input
                id="manual-branch-name"
                value={manualBranchName}
                onChange={(event) => setManualBranchName(event.target.value)}
                className="h-11 min-w-0 flex-1 border-0 bg-transparent font-mono text-sm outline-none placeholder:text-muted-foreground focus-visible:ring-0"
                placeholder="main / feature/login / a1b2c3d"
                autoComplete="off"
                spellCheck={false}
              />
            </div>
            <Button type="submit" disabled={!manualBranchName.trim()}>
              <ExternalLink />
              预览
            </Button>
          </form>
          {actions[manualBranchName.trim()] ? (
            <div className="mt-3 rounded-md bg-[hsl(var(--surface-sunken))] px-3 py-2 text-xs text-muted-foreground">
              {actions[manualBranchName.trim()].message}
            </div>
          ) : null}
        </section>

        {state.status === 'loading' ? (
          <div className="mt-4">
            <LoadingBlock label="加载分支与远程引用" />
          </div>
        ) : null}
        {state.status === 'error' ? (
          <div className="mt-4">
            <ErrorBlock message={state.message} />
          </div>
        ) : null}

        {state.status === 'ok' && state.project.cloneStatus && state.project.cloneStatus !== 'ready' ? (
          <div className="mt-4 rounded-md border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-sm text-amber-700 dark:text-amber-400">
            当前项目仓库状态为 {state.project.cloneStatus}，克隆完成前不能创建或部署分支。
            {state.project.cloneError ? <span className="ml-2">{state.project.cloneError}</span> : null}
          </div>
        ) : null}

        {state.status === 'ok' ? (
          <div className="mt-4 grid gap-4 lg:grid-cols-[320px_minmax(0,1fr)] xl:grid-cols-[340px_minmax(0,1fr)]">
            {/* LEFT — Resource list. Tracked branches sit on top, remote
                branches below. Click a row to make it the master view. */}
            <aside className="min-w-0 lg:sticky lg:top-[68px] lg:max-h-[calc(100vh-88px)] lg:overflow-y-auto lg:pr-1">
              <div className="overflow-hidden cds-surface-raised cds-hairline">
                <div className="flex items-center justify-between gap-3 border-b border-[hsl(var(--hairline))] px-3 py-3">
                  <div className="min-w-0">
                    <h2 className="text-sm font-semibold">分支</h2>
                    <div className="mt-0.5 text-xs text-muted-foreground">
                      {filteredBranches.length}/{branches.length} 个跟踪 · {remoteBranches.length} 个远程
                    </div>
                  </div>
                  {selectedBranches.length > 0 ? (
                    <CodePill>已选 {selectedBranches.length}</CodePill>
                  ) : null}
                </div>

                <div className="border-b border-[hsl(var(--hairline))] p-2">
                  <input
                    value={filter}
                    onChange={(event) => setFilter(event.target.value)}
                    className="h-9 w-full rounded-md border border-[hsl(var(--hairline))] bg-[hsl(var(--surface-sunken))] px-3 text-sm outline-none ring-offset-background placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring"
                    placeholder="搜索 branch / commit / tag"
                  />
                </div>

                {filteredBranches.length === 0 ? (
                  <div className="px-3 py-6 text-xs text-muted-foreground">
                    {branches.length === 0 ? '没有跟踪分支。从下方远程分支选一个开始预览。' : '没有匹配当前筛选条件的分支。'}
                  </div>
                ) : (
                  <ul className="divide-y divide-[hsl(var(--hairline))]">
                    {filteredBranches.map((branch) => {
                      const action = actions[branch.id];
                      const busy = action?.status === 'running' || isBusy(branch);
                      const active = branch.id === selectedBranchId;
                      const checked = selectedBranchIds.includes(branch.id);
                      return (
                        <li key={branch.id}>
                          <button
                            type="button"
                            onClick={() => setSelectedBranchId(branch.id)}
                            data-active={active ? 'true' : 'false'}
                            className="group flex w-full items-start gap-2.5 px-3 py-2.5 text-left transition-colors hover:bg-[hsl(var(--surface-sunken))]/60 data-[active=true]:bg-[hsl(var(--surface-sunken))] data-[active=true]:shadow-[inset_3px_0_0_0_hsl(var(--primary))]"
                          >
                            <input
                              type="checkbox"
                              checked={checked}
                              onChange={(event) => {
                                event.stopPropagation();
                                toggleSelectedBranch(branch.id);
                              }}
                              onClick={(event) => event.stopPropagation()}
                              className="mt-1 h-3.5 w-3.5 shrink-0 rounded border-input accent-primary"
                              aria-label={`选择 ${branch.branch}`}
                            />
                            <span
                              className={`mt-1.5 inline-block h-2 w-2 shrink-0 rounded-full ${statusRailClass(branch.status)} ${
                                branch.status === 'running' ? 'shadow-[0_0_8px_rgba(16,185,129,0.45)]' : ''
                              }`}
                              aria-hidden
                            />
                            <span className="min-w-0 flex-1">
                              <span className="flex min-w-0 items-center gap-1.5">
                                <span className="min-w-0 flex-1 truncate text-sm font-medium">{branch.branch}</span>
                                {branch.isFavorite ? <Star className="h-3 w-3 shrink-0 fill-current text-amber-500" /> : null}
                                {branch.isColorMarked ? <Lightbulb className="h-3 w-3 shrink-0 text-primary" /> : null}
                              </span>
                              <span className="mt-0.5 flex items-center gap-2 text-[11px] text-muted-foreground">
                                <span>{statusLabel(branch.status)}</span>
                                <span>·</span>
                                <span className="tabular-nums">{runningServiceCount(branch)}/{serviceCount(branch)}</span>
                                <span>·</span>
                                <span className="truncate">{formatRelativeTime(branch.lastDeployAt || branch.lastAccessedAt)}</span>
                              </span>
                            </span>
                            {busy ? <Loader2 className="mt-1 h-3.5 w-3.5 shrink-0 animate-spin text-muted-foreground" /> : null}
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                )}

                <details className="border-t border-[hsl(var(--hairline))]">
                  <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-3 py-2 text-xs text-muted-foreground transition-colors hover:bg-[hsl(var(--surface-sunken))]/60 hover:text-foreground [&::-webkit-details-marker]:hidden">
                    <span className="inline-flex items-center gap-1.5">
                      <Settings className="h-3.5 w-3.5" />
                      筛选 / 排序 / 批量
                    </span>
                    <span>{statusFilter === 'all' ? '默认' : statusFilter}</span>
                  </summary>
                  <div className="space-y-2 border-t border-[hsl(var(--hairline))] p-2.5">
                    <div className="flex flex-wrap gap-1.5">
                      <QuickFilterButton active={statusFilter === 'all'} onClick={() => setStatusFilter('all')}>全部</QuickFilterButton>
                      <QuickFilterButton active={statusFilter === 'running'} onClick={() => setStatusFilter('running')}>
                        <CheckCircle2 className="h-3 w-3" />
                        运行
                      </QuickFilterButton>
                      <QuickFilterButton active={statusFilter === 'busy'} onClick={() => setStatusFilter('busy')}>忙碌</QuickFilterButton>
                      <QuickFilterButton active={statusFilter === 'error'} onClick={() => setStatusFilter('error')}>异常</QuickFilterButton>
                      <QuickFilterButton active={statusFilter === 'favorite'} onClick={() => setStatusFilter('favorite')}>
                        <Star className="h-3 w-3" />
                        收藏
                      </QuickFilterButton>
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      <select
                        value={sortMode}
                        onChange={(event) => setSortMode(event.target.value as SortMode)}
                        className="h-7 flex-1 rounded-md border border-[hsl(var(--hairline))] bg-[hsl(var(--surface-sunken))] px-2 text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        aria-label="排序"
                      >
                        <option value="recent">最近活跃</option>
                        <option value="name">分支名</option>
                        <option value="status">状态</option>
                        <option value="services">运行服务</option>
                      </select>
                      <Button variant="ghost" size="sm" onClick={toggleVisibleSelection}>
                        {allVisibleSelected ? '取消可见' : '选择可见'}
                      </Button>
                      {selectedBranches.length > 0 ? (
                        <Button variant="ghost" size="sm" onClick={() => setSelectedBranchIds([])}>
                          清空 {selectedBranches.length}
                        </Button>
                      ) : null}
                    </div>
                  </div>
                </details>
              </div>

              {/* Remote branches — hoisted from the old ops aside so the
                  most common zero-friction action (deploy a remote branch)
                  stays one click away. */}
              <div className="mt-3 overflow-hidden cds-surface-raised cds-hairline">
                <div className="flex items-center justify-between gap-3 border-b border-[hsl(var(--hairline))] px-3 py-2.5">
                  <div className="min-w-0">
                    <h2 className="text-sm font-semibold">远程</h2>
                    <div className="mt-0.5 text-[11px] text-muted-foreground">未跟踪分支可直接部署</div>
                  </div>
                  <CodePill>{remoteBranches.length}</CodePill>
                </div>
                <div className="border-b border-[hsl(var(--hairline))] p-2">
                  <input
                    value={remoteFilter}
                    onChange={(event) => setRemoteFilter(event.target.value)}
                    className="h-8 w-full rounded-md border border-[hsl(var(--hairline))] bg-[hsl(var(--surface-sunken))] px-3 text-xs outline-none ring-offset-background placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring"
                    placeholder="搜索远程分支"
                  />
                </div>
                <div className="max-h-72 overflow-y-auto">
                  {visibleRemoteBranches.length === 0 ? (
                    <div className="px-3 py-6 text-xs text-muted-foreground">没有可用远程分支。</div>
                  ) : null}
                  <ul className="divide-y divide-[hsl(var(--hairline))]">
                    {visibleRemoteBranches.map((remote) => {
                      const tracked = trackedByName.get(remote.name);
                      const key = tracked?.id || remote.name;
                      const action = actions[key];
                      return (
                        <li key={remote.name} className="flex items-start justify-between gap-2 px-3 py-2.5">
                          <div className="min-w-0 flex-1">
                            <div className="truncate text-sm font-medium">{remote.name}</div>
                            <div className="mt-0.5 line-clamp-1 text-[11px] text-muted-foreground">
                              {remote.subject || remote.author || '无提交摘要'}
                            </div>
                            {action ? <div className="mt-1 text-[11px] text-muted-foreground">{action.message}</div> : null}
                          </div>
                          <Button
                            size="sm"
                            variant={tracked ? 'ghost' : 'default'}
                            disabled={!!action}
                            onClick={() => void previewRemoteBranch(remote)}
                            title={tracked ? '预览已跟踪分支' : '部署并预览'}
                          >
                            {action ? <Loader2 className="animate-spin" /> : tracked ? <ExternalLink /> : <Plus />}
                            {tracked ? '预览' : '部署'}
                          </Button>
                        </li>
                      );
                    })}
                  </ul>
                </div>
              </div>
            </aside>

            {/* RIGHT — Master view of the selected branch. */}
            <main className="min-w-0">
              {selectedBranch ? (
                <BranchCard
                  key={selectedBranch.id}
                  branch={selectedBranch}
                  action={actions[selectedBranch.id]}
                  now={actionClock}
                  selected={selectedBranchIds.includes(selectedBranch.id)}
                  onSelect={() => toggleSelectedBranch(selectedBranch.id)}
                  onPreview={() => void openPreview(selectedBranch, true)}
                  onDeploy={() => void deployBranch(selectedBranch, false)}
                  onPull={() => void pullBranch(selectedBranch)}
                  onStop={() => void stopBranch(selectedBranch)}
                  onToggleFavorite={() => void patchBranch(selectedBranch, { isFavorite: !selectedBranch.isFavorite })}
                  onToggleDebug={() => void patchBranch(selectedBranch, { isColorMarked: !selectedBranch.isColorMarked })}
                  onReset={() => void resetBranch(selectedBranch)}
                  onDelete={() => void deleteBranch(selectedBranch)}
                  onEditTags={() => void editTags(selectedBranch)}
                />
              ) : (
                <div className="cds-surface-raised cds-hairline px-6 py-12">
                  <div className="mx-auto flex max-w-md flex-col items-center text-center">
                    <div className="flex h-12 w-12 items-center justify-center rounded-full bg-primary/10 text-primary">
                      <GitBranch />
                    </div>
                    <h2 className="mt-5 text-lg font-semibold">
                      {branches.length === 0 ? '还没有分支' : '选择左侧分支查看详情'}
                    </h2>
                    <p className="mt-2 max-w-sm text-sm leading-6 text-muted-foreground">
                      {branches.length === 0
                        ? '从左侧远程分支列表点击部署，或在顶部「预览分支」表单粘贴分支名，CDS 会自动创建工作树并打开预览。'
                        : '点击左侧任意分支查看状态、服务、部署日志和操作。'}
                    </p>
                  </div>
                </div>
              )}
            </main>
          </div>
        ) : null}

        {/* Ops drawer — slide-in panel for capacity / hosts / executors /
            batch / activity. Triggered by the "运维" button in the topbar. */}
        {state.status === 'ok' ? (
          <OpsDrawer open={opsDrawerOpen} onClose={() => setOpsDrawerOpen(false)}>
              

              <details className="overflow-hidden cds-surface-raised cds-hairline">
                <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-3 py-3 text-sm transition-colors hover:bg-muted/20 [&::-webkit-details-marker]:hidden">
                  <span className="inline-flex items-center gap-2 font-semibold">
                    <Gauge className="h-4 w-4 text-muted-foreground" />
                    运维与日志
                  </span>
                  <span className="text-xs text-muted-foreground">容量 / 主机 / 执行器 / 活动</span>
                </summary>
                <div className="divide-y divide-border border-t border-border">
              <div className="p-3">
                <div className="mb-3 flex items-center justify-between gap-3">
                  <h2 className="text-sm font-semibold">运维状态</h2>
                  <Gauge className="h-4 w-4 text-muted-foreground" />
                </div>
                <div className="grid grid-cols-3 gap-2">
                  <MetricTile label="运行服务" value={runningServices} />
                  <MetricTile label="容量槽" value={state.capacity ? `${state.capacity.runningContainers}/${state.capacity.maxContainers}` : '未知'} />
                  <MetricTile label="内存" value={state.capacity ? `${state.capacity.totalMemGB} GB` : '未知'} />
                </div>
                <div className={`mt-3 rounded-md border px-3 py-2 text-xs leading-5 ${
                  selectedCapacityWarning
                    ? 'border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300'
                    : 'border-border bg-muted/20 text-muted-foreground'
                }`}
                >
                  {selectedBranches.length ? (
                    selectedCapacityWarning ? (
                      <span>{selectedCapacityWarning} 批量部署会再次确认。</span>
                    ) : (
                      <span>
                        已选分支预计新增 {selectedNewContainers} 个容器
                        {capacityRemaining === null ? '' : `，剩余容量 ${capacityRemaining} 个槽`}。
                      </span>
                    )
                  ) : (
                    <span>勾选分支后会预估部署容量；运行中的分支不会重复占用容量槽。</span>
                  )}
                </div>
                {capacityAssist.deficit > 0 ? (
                  <div className="mt-3 flex flex-wrap items-center justify-between gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs">
                    <span className="text-amber-700 dark:text-amber-300">
                      还差 {capacityAssist.deficit} 个容量槽，可停止 {capacityAssist.candidates.length} 个较旧运行分支。
                    </span>
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      disabled={capacityAssist.candidates.length === 0}
                      onClick={() => void stopOldBranchesForCapacity()}
                    >
                      <PowerOff />
                      腾容量
                    </Button>
                  </div>
                ) : null}
              </div>

              <div className="p-3">
                <div className="mb-3 flex items-center justify-between gap-3">
                  <div>
                    <h2 className="text-sm font-semibold">主机健康</h2>
                    <div className="mt-1 text-xs text-muted-foreground">本机 CPU、内存和运行时长</div>
                  </div>
                  <Cpu className="h-4 w-4 text-muted-foreground" />
                </div>
                {hostStats.status === 'loading' ? (
                  <div className="rounded-md border border-dashed border-border px-3 py-3 text-xs text-muted-foreground">正在读取主机状态</div>
                ) : hostStats.status === 'error' ? (
                  <div className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-3 text-xs text-destructive">
                    {hostStats.message}
                  </div>
                ) : (
                  <div className="space-y-3">
                    <div className="grid grid-cols-3 gap-2">
                      <MetricTile label="CPU" value={`${hostStats.data.cpu.loadPercent}%`} />
                      <MetricTile label="内存" value={`${hostStats.data.mem.usedPercent}%`} />
                      <MetricTile label="运行" value={formatUptime(hostStats.data.uptimeSeconds)} />
                    </div>
                    <div className="grid gap-2 text-xs text-muted-foreground">
                      <HealthMeter
                        icon={<Cpu className="h-3.5 w-3.5" />}
                        label={`${hostStats.data.cpu.cores} 核 · load ${hostStats.data.cpu.loadAvg1}/${hostStats.data.cpu.loadAvg5}/${hostStats.data.cpu.loadAvg15}`}
                        value={Math.min(100, Math.max(0, hostStats.data.cpu.loadPercent))}
                      />
                      <HealthMeter
                        icon={<HardDrive className="h-3.5 w-3.5" />}
                        label={`${formatBytesFromMB(hostStats.data.mem.totalMB - hostStats.data.mem.freeMB)} / ${formatBytesFromMB(hostStats.data.mem.totalMB)}`}
                        value={Math.min(100, Math.max(0, hostStats.data.mem.usedPercent))}
                      />
                    </div>
                  </div>
                )}
              </div>

              <div className="p-3">
                <div className="mb-3 flex items-center justify-between gap-3">
                  <div>
                    <h2 className="text-sm font-semibold">执行器</h2>
                    <div className="mt-1 text-xs text-muted-foreground">集群模式与可用执行节点</div>
                  </div>
                  <Server className="h-4 w-4 text-muted-foreground" />
                </div>
                {opsStatus.status === 'loading' ? (
                  <div className="rounded-md border border-dashed border-border px-3 py-3 text-xs text-muted-foreground">正在读取执行器状态</div>
                ) : opsStatus.status === 'error' ? (
                  <div className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-3 text-xs text-destructive">
                    {opsStatus.message}
                  </div>
                ) : (
                  <div className="space-y-3">
                    <div className="grid grid-cols-3 gap-2">
                      <MetricTile label="模式" value={clusterMode} />
                      <MetricTile label="在线" value={`${onlineExecutors}/${totalExecutors}`} />
                      <MetricTile label="空闲" value={`${executorFreePercent}%`} />
                    </div>
                    <div className="space-y-2">
                      {opsStatus.capacity.nodes.length === 0 ? (
                        <div className="rounded-md border border-dashed border-border px-3 py-3 text-xs text-muted-foreground">暂无执行节点</div>
                      ) : null}
                      {opsStatus.capacity.nodes.map((node) => (
                        <ExecutorNodeRow
                          key={node.id}
                          node={node}
                          actionLabel={executorAction[node.id]}
                          onDrain={() => void drainExecutor(node)}
                          onRemove={() => void removeExecutor(node)}
                        />
                      ))}
                    </div>
                  </div>
                )}
              </div>

              <div className="p-3">
                <div className="mb-3 flex items-center justify-between gap-3">
                  <div>
                    <h2 className="text-sm font-semibold">批量运维</h2>
                    <div className="mt-1 text-xs text-muted-foreground">
                      {selectedBranches.length ? `已选择 ${selectedBranches.length} 个分支` : '先在左侧勾选分支'}
                    </div>
                  </div>
                  <Settings className="h-4 w-4 text-muted-foreground" />
                </div>
                <div className="flex flex-wrap gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={selectedBranches.length === 0}
                    onClick={() => void runBulkAction('批量部署', selectedBranches, (branch) => deployBranch(branch, false, undefined, { skipCapacityConfirm: true }))}
                  >
                    <Play />
                    部署
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={selectedBranches.length === 0}
                    onClick={() => void runBulkAction('批量拉取', selectedBranches, pullBranch)}
                  >
                    <RotateCw />
                    拉取
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={selectedBranches.length === 0}
                    onClick={() => void runBulkAction('批量停止', selectedBranches.filter((branch) => branch.status === 'running'), stopBranch)}
                  >
                    <Square />
                    停止
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={selectedBranches.length === 0}
                    onClick={() => void bulkSetFavorite(selectedBranches, !selectedAllFavorite)}
                  >
                    <Star />
                    {selectedAllFavorite ? '取消收藏' : '收藏'}
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={selectedErroredCount === 0}
                    onClick={() => void bulkResetErrored(selectedBranches)}
                  >
                    <RotateCw />
                    重置异常
                  </Button>
                  <Button
                    variant="destructive"
                    size="sm"
                    disabled={selectedBranches.length === 0}
                    onClick={() => void bulkDeleteBranches(selectedBranches)}
                  >
                    <Trash2 />
                    删除
                  </Button>
                </div>
              </div>

              <div className="p-3">
                <div className="mb-3 flex items-center justify-between gap-3">
                  <div>
                    <h2 className="text-sm font-semibold">最近活动</h2>
                    <div className="mt-1 text-xs text-muted-foreground">CDS API 与预览访问的实时事件</div>
                  </div>
                  <Activity className="h-4 w-4 text-muted-foreground" />
                </div>
                <div className="mb-3 space-y-2">
                  <div className="flex flex-wrap gap-2">
                    <QuickFilterButton active={activityTypeFilter === 'all'} onClick={() => setActivityTypeFilter('all')}>全部</QuickFilterButton>
                    <QuickFilterButton active={activityTypeFilter === 'api'} onClick={() => setActivityTypeFilter('api')}>API</QuickFilterButton>
                    <QuickFilterButton active={activityTypeFilter === 'web'} onClick={() => setActivityTypeFilter('web')}>Web</QuickFilterButton>
                    <QuickFilterButton active={activityTypeFilter === 'ai'} onClick={() => setActivityTypeFilter('ai')}>AI</QuickFilterButton>
                  </div>
                  <label className="sr-only" htmlFor="activity-branch-filter">活动分支筛选</label>
                  <select
                    id="activity-branch-filter"
                    value={activityBranchFilter}
                    onChange={(event) => {
                      setActivityBranchFilter(event.target.value);
                      setSelectedActivityId(null);
                    }}
                    className="h-8 w-full rounded-md border border-input bg-background px-2 text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    <option value="">全部分支</option>
                    {activityBranchOptions.map((branch) => (
                      <option key={branch.id} value={branch.id}>{branch.label}</option>
                    ))}
                  </select>
                </div>
                {recentActivityEvents.length === 0 ? (
                  <div className="rounded-md border border-dashed border-border px-3 py-3 text-xs text-muted-foreground">
                    暂无活动。部署、预览或自动化事件会显示在这里。
                  </div>
                ) : (
                  <div className="max-h-80 space-y-1.5 overflow-y-auto pr-1">
                    {recentActivityEvents.map((event) => (
                      <div
                        key={event.id}
                        className={`rounded-md border px-2.5 py-2 transition-colors ${
                          selectedActivityId === event.id ? 'border-primary/50 bg-primary/5' : 'border-border bg-muted/20'
                        }`}
                      >
                        <div className="flex items-center gap-2 text-xs">
                          <span className="rounded border border-border px-1.5 py-0.5 font-mono">{event.method}</span>
                          <span className={`rounded border px-1.5 py-0.5 ${activityStatusClass(event.status)}`}>{event.status}</span>
                          <span className="ml-auto font-mono text-muted-foreground">{formatDuration(event.duration)}</span>
                        </div>
                        <div className="mt-1 truncate text-sm font-medium">{activityLabel(event)}</div>
                        <div className="mt-1 flex items-center gap-2 text-xs text-muted-foreground">
                          <span>{activitySourceLabel(event)}</span>
                          {event.branchId ? <CodePill>{event.branchTags?.[0] || event.branchId}</CodePill> : null}
                          <span className="ml-auto">{formatShortTime(event.ts)}</span>
                        </div>
                        <div className="mt-1 flex justify-end gap-1">
                          <Button
                            type="button"
                            variant={selectedActivityId === event.id ? 'secondary' : 'ghost'}
                            size="sm"
                            onClick={() => setSelectedActivityId((current) => (current === event.id ? null : event.id))}
                          >
                            详情
                          </Button>
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            onClick={() => {
                              void navigator.clipboard.writeText(activitySummary(event)).then(() => setToast('活动摘要已复制'));
                            }}
                          >
                            <Copy />
                            复制
                          </Button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
                {selectedActivity ? (
                  <div className="mt-3 rounded-md border border-border bg-background px-3 py-3 text-xs">
                    <div className="mb-2 flex items-center justify-between gap-2">
                      <div className="font-semibold">活动详情</div>
                      <CodePill>{formatShortTime(selectedActivity.ts)}</CodePill>
                    </div>
                    <div className="grid gap-2 text-muted-foreground">
                      <div className="grid gap-1">
                        <span className="font-medium text-foreground">请求</span>
                        <code className="break-all rounded bg-muted px-2 py-1 font-mono">
                          {selectedActivity.method} {selectedActivity.path}
                          {selectedActivity.query ? `?${selectedActivity.query}` : ''}
                        </code>
                      </div>
                      <div className="grid grid-cols-2 gap-2">
                        <MetricTile label="状态" value={selectedActivity.status} />
                        <MetricTile label="耗时" value={formatDuration(selectedActivity.duration)} />
                      </div>
                      <div className="flex flex-wrap gap-2">
                        <CodePill>{activitySourceLabel(selectedActivity)}</CodePill>
                        {selectedActivity.branchId ? (
                          <CodePill>{selectedActivity.branchTags?.[0] || selectedActivity.branchId}</CodePill>
                        ) : null}
                        {selectedActivity.profileId ? <CodePill>{selectedActivity.profileId}</CodePill> : null}
                      </div>
                      {selectedActivity.referer ? (
                        <div className="break-all">
                          Referer：<code>{selectedActivity.referer}</code>
                        </div>
                      ) : null}
                      {selectedActivity.body ? (
                        <div className="grid gap-1">
                          <span className="font-medium text-foreground">Body</span>
                          <code className="max-h-24 overflow-auto rounded bg-muted px-2 py-1 font-mono">{selectedActivity.body}</code>
                        </div>
                      ) : null}
                    </div>
                  </div>
                ) : null}
              </div>
                </div>
              </details>

            
          </OpsDrawer>
        ) : null}

        {toast ? (
          <div
            className="fixed bottom-5 right-5 z-50 max-w-sm rounded-md border border-[hsl(var(--hairline))] bg-[hsl(var(--surface-raised))] px-4 py-3 text-sm shadow-lg"
            role="status"
          >
            {toast}
          </div>
        ) : null}
      </Workspace>
    </AppShell>
  );
}

/*
 * OpsDrawer — right-side slide-in panel hosting low-frequency operations
 * (capacity / hosts / executors / batch / activity). Triggered by the
 * topbar "运维" button. Closing on overlay click + ESC keeps the main
 * service-canvas free of operational noise.
 */
function OpsDrawer({
  open,
  onClose,
  children,
}: {
  open: boolean;
  onClose: () => void;
  children: ReactNode;
}): JSX.Element | null {
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

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex" role="dialog" aria-modal="true" aria-label="运维抽屉">
      <button
        type="button"
        className="cds-overlay-anim absolute inset-0 bg-black/40 backdrop-blur-[1px]"
        onClick={onClose}
        aria-label="关闭运维抽屉"
      />
      <div
        className="cds-drawer-anim ml-auto flex h-full w-full max-w-[460px] flex-col border-l border-[hsl(var(--hairline))] bg-[hsl(var(--surface-base))] shadow-2xl"
        style={{ minHeight: 0 }}
      >
        <header className="flex h-14 shrink-0 items-center justify-between gap-3 border-b border-[hsl(var(--hairline))] px-4">
          <div className="flex items-center gap-2 text-sm font-semibold">
            <Activity className="h-4 w-4 text-muted-foreground" />
            运维 · 容量 / 主机 / 执行器 / 活动
          </div>
          <Button variant="ghost" size="icon" onClick={onClose} aria-label="关闭" title="关闭">
            <Square />
          </Button>
        </header>
        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-4" style={{ overscrollBehavior: 'contain' }}>
          {children}
        </div>
      </div>
    </div>
  );
}

function BranchCard({
  branch,
  action,
  now,
  selected,
  onSelect,
  onPreview,
  onDeploy,
  onPull,
  onStop,
  onToggleFavorite,
  onToggleDebug,
  onReset,
  onDelete,
  onEditTags,
}: {
  branch: BranchSummary;
  action?: BranchAction;
  now: number;
  selected: boolean;
  onSelect: () => void;
  onPreview: () => void;
  onDeploy: () => void;
  onPull: () => void;
  onStop: () => void;
  onToggleFavorite: () => void;
  onToggleDebug: () => void;
  onReset: () => void;
  onDelete: () => void;
  onEditTags: () => void;
}): JSX.Element {
  const busy = action?.status === 'running' || isBusy(branch);
  const runningCount = runningServiceCount(branch);
  const services = Object.values(branch.services || {});

  /*
   * Master-view layout (Week 4.6 polish): vertical stack with breathing room.
   * Removed the chunky 1px left status rail — the single dot in the header
   * already communicates state. Action row is inline, "更多操作" lives in a
   * small ghost icon group at the bottom (no <details> jaw).
   */
  return (
    <article
      className={`group relative cds-surface-raised cds-hairline transition-shadow duration-150 hover:shadow-md ${
        selected ? 'ring-1 ring-primary/40' : ''
      }`}
    >
      {/* Header */}
      <header className="flex flex-wrap items-start justify-between gap-3 px-5 pt-4">
        <div className="flex min-w-0 items-start gap-3">
          <span
            className={`mt-1.5 inline-block h-2.5 w-2.5 shrink-0 rounded-full ${statusRailClass(branch.status)} ${
              branch.status === 'running' ? 'shadow-[0_0_10px_rgba(16,185,129,0.45)]' : ''
            }`}
            aria-hidden
          />
          <div className="min-w-0">
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              <h3 className="min-w-0 truncate text-lg font-semibold tracking-tight">{branch.branch}</h3>
              <span className={`rounded border px-2 py-0.5 text-[11px] ${statusClass(branch.status)}`}>
                {statusLabel(branch.status)}
              </span>
              {branch.isFavorite ? (
                <span className="inline-flex items-center gap-1 text-[11px] text-amber-500">
                  <Star className="h-3 w-3 fill-current" />
                  收藏
                </span>
              ) : null}
              {branch.isColorMarked ? (
                <span className="inline-flex items-center gap-1 text-[11px] text-primary">
                  <Lightbulb className="h-3 w-3" />
                  调试
                </span>
              ) : null}
            </div>
            {branch.subject || branch.commitSha ? (
              <p className="mt-1.5 line-clamp-1 text-sm leading-5 text-muted-foreground">
                {branch.subject || branch.commitSha}
              </p>
            ) : null}
            <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
              <span className="font-mono">{branch.id.slice(0, 8)}</span>
              {branch.commitSha ? <span className="font-mono">{branch.commitSha.slice(0, 7)}</span> : null}
              {(branch.tags || []).map((tag) => (
                <span key={tag} className="font-mono">#{tag}</span>
              ))}
              <span className="tabular-nums">服务 {runningCount}/{serviceCount(branch)}</span>
              <span className="tabular-nums">部署 {branch.deployCount || 0}</span>
              <span>{formatRelativeTime(branch.lastDeployAt || branch.lastAccessedAt)}</span>
            </div>
          </div>
        </div>
        <input
          type="checkbox"
          checked={selected}
          onChange={onSelect}
          className="mt-1 h-4 w-4 shrink-0 rounded border-input accent-primary"
          aria-label={`选择 ${branch.branch}`}
          title="加入批量选择"
        />
      </header>

      {/* Primary action row */}
      <div className="mt-4 flex flex-wrap items-center gap-2 px-5">
        <Button onClick={onPreview} disabled={busy}>
          {busy ? <Loader2 className="animate-spin" /> : <ExternalLink />}
          预览
        </Button>
        <Button variant="outline" onClick={onDeploy} disabled={busy}>
          <Play />
          {branch.status === 'running' ? '重部署' : '部署'}
        </Button>
        <Button asChild variant="outline">
          <a href={`/branch-panel/${encodeURIComponent(branch.id)}?project=${encodeURIComponent(branch.projectId)}`}>
            <TerminalSquare />
            详情
          </a>
        </Button>
      </div>

      {/* Services row */}
      {services.length > 0 ? (
        <div className="mt-4 flex flex-wrap gap-1.5 border-t border-[hsl(var(--hairline))] px-5 py-3">
          {services.map((svc) => (
            <span
              key={svc.profileId}
              className={`inline-flex items-center gap-1.5 rounded border px-2 py-0.5 text-[11px] ${statusClass(svc.status)}`}
            >
              <span className={`h-1.5 w-1.5 rounded-full ${statusRailClass(svc.status)}`} aria-hidden />
              {svc.profileId}
              <span className="opacity-70">·</span>
              <span className="opacity-70">{statusLabel(svc.status)}</span>
            </span>
          ))}
        </div>
      ) : (
        <div className="mt-4 border-t border-[hsl(var(--hairline))] px-5 py-3 text-xs text-muted-foreground">
          未部署服务。点击预览会自动部署并打开预览地址。
        </div>
      )}

      <BranchFailureHint branch={branch} busy={busy} onReset={onReset} />

      {action ? <BranchActionPanel action={action} branch={branch} now={now} /> : null}

      {/* Footer — secondary actions as ghost icon buttons. */}
      <footer className="flex flex-wrap items-center gap-1 border-t border-[hsl(var(--hairline))] px-3 py-2">
        <Button variant="ghost" size="sm" onClick={onPull} disabled={busy} title="拉取最新">
          <RotateCw />
          拉取
        </Button>
        <Button
          variant="ghost"
          size="sm"
          onClick={onStop}
          disabled={busy || branch.status !== 'running'}
          title="停止运行的服务"
        >
          <Square />
          停止
        </Button>
        <Button
          variant="ghost"
          size="sm"
          onClick={onToggleFavorite}
          disabled={busy}
          title={branch.isFavorite ? '取消收藏' : '收藏'}
        >
          <Star className={branch.isFavorite ? 'fill-current text-amber-500' : ''} />
        </Button>
        <Button
          variant="ghost"
          size="sm"
          onClick={onToggleDebug}
          disabled={busy}
          title={branch.isColorMarked ? '取消调试标记' : '调试标记'}
        >
          <Lightbulb className={branch.isColorMarked ? 'fill-current text-primary' : ''} />
        </Button>
        <Button variant="ghost" size="sm" onClick={onEditTags} disabled={busy} title="编辑标签">
          <Tags />
        </Button>
        <Button
          variant="ghost"
          size="sm"
          onClick={onReset}
          disabled={busy || branch.status !== 'error'}
          title="重置异常状态"
        >
          <RotateCw />
          重置
        </Button>
        <div className="flex-1" />
        <Button variant="ghost" size="sm" onClick={onDelete} disabled={busy} className="text-destructive hover:text-destructive">
          <Trash2 />
          删除
        </Button>
      </footer>
    </article>
  );
}

function BranchFailureHint({
  branch,
  busy,
  onReset,
}: {
  branch: BranchSummary;
  busy: boolean;
  onReset: () => void;
}): JSX.Element | null {
  const failedServices = Object.values(branch.services || {}).filter((service) => service.status === 'error');
  if (branch.status !== 'error' && failedServices.length === 0) return null;
  const message = deployFailureMessage(branch);

  return (
    <div className="border-t border-destructive/30 bg-destructive/10 px-4 py-3 text-sm">
      <div className="flex items-start gap-2">
        <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
        <div className="min-w-0 flex-1">
          <div className="font-medium text-destructive">{message || '分支处于异常状态'}</div>
          <div className="mt-1 text-xs leading-5 text-muted-foreground">
            {failedServices.length
              ? `优先查看 ${failedServices.map((service) => service.profileId).join(', ')} 的构建/容器日志。`
              : '优先进入详情页查看最近部署日志；确认配置后可重置异常再重新部署。'}
          </div>
          <div className="mt-3 flex flex-wrap gap-2">
            <Button asChild size="sm" variant="outline">
              <a href={`/branch-panel/${encodeURIComponent(branch.id)}?project=${encodeURIComponent(branch.projectId)}`}>
                <TerminalSquare />
                看详情
              </a>
            </Button>
            <Button type="button" size="sm" variant="outline" disabled={busy} onClick={onReset}>
              <RotateCw />
              重置异常
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

function BranchActionPanel({
  action,
  branch,
  now,
}: {
  action: BranchAction;
  branch: BranchSummary;
  now: number;
}): JSX.Element {
  const [copied, setCopied] = useState(false);
  const stages = actionStages(action.log);
  const duration = formatDuration((action.finishedAt || now) - action.startedAt);
  const suggestion = action.suggestion || (action.status === 'error' ? failureSuggestion(action.message, action.log, branch) : '');

  async function copyDebugInfo(): Promise<void> {
    try {
      await navigator.clipboard.writeText(actionDebugText({ ...action, suggestion }, branch));
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      setCopied(false);
    }
  }

  return (
    <div className="border-t border-border bg-muted/30 px-4 py-3 text-xs">
      <div className="flex flex-wrap items-center gap-2 text-muted-foreground">
        {action.status === 'running' ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
        ) : action.status === 'success' ? (
          <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500" />
        ) : (
          <AlertCircle className="h-3.5 w-3.5 text-destructive" />
        )}
        <span className="font-medium text-foreground">{action.phase || actionPhaseFromText(action.message)}</span>
        <span className="min-w-0 truncate">{action.message}</span>
        <span className="rounded border border-border px-1.5 py-0.5 font-mono text-[11px]">{duration}</span>
        <Button type="button" size="sm" variant="ghost" className="ml-auto h-7 px-2 text-xs" onClick={() => void copyDebugInfo()}>
          <Copy className="h-3.5 w-3.5" />
          {copied ? '已复制' : '复制'}
        </Button>
      </div>

      {stages.length > 0 ? (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {stages.map((stage) => (
            <span key={stage} className="rounded border border-border bg-background px-2 py-0.5 text-[11px] text-muted-foreground">
              {stage}
            </span>
          ))}
        </div>
      ) : null}

      {action.lastStep ? (
        <div className="mt-2 min-w-0 truncate text-muted-foreground">最近：{action.lastStep}</div>
      ) : null}

      {suggestion ? (
        <div className="mt-2 rounded-md border border-amber-500/30 bg-amber-500/10 px-2 py-1.5 text-amber-700 dark:text-amber-300">
          下一步：{suggestion}
        </div>
      ) : null}

      {action.log.length > 0 ? (
        <details className="mt-2 rounded-md border border-border bg-background/50">
          <summary className="flex h-8 cursor-pointer list-none items-center justify-between px-2 text-muted-foreground [&::-webkit-details-marker]:hidden">
            <span>最近日志</span>
            <span>{action.log.length} 行</span>
          </summary>
          <pre className="max-h-32 overflow-auto whitespace-pre-wrap border-t border-border p-2 font-mono text-[11px] leading-5 text-muted-foreground">
            {action.log.slice(-12).join('\n')}
          </pre>
        </details>
      ) : null}
    </div>
  );
}

function QuickFilterButton({
  active,
  children,
  onClick,
}: {
  active: boolean;
  children: React.ReactNode;
  onClick: () => void;
}): JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`inline-flex h-8 items-center gap-1.5 rounded-md border px-3 text-xs transition-colors ${
        active
          ? 'border-primary bg-primary text-primary-foreground'
          : 'border-border bg-background text-muted-foreground hover:text-foreground'
      }`}
    >
      {children}
    </button>
  );
}

function HealthMeter({
  icon,
  label,
  value,
}: {
  icon: JSX.Element;
  label: string;
  value: number;
}): JSX.Element {
  const tone =
    value >= 85
      ? 'bg-destructive'
      : value >= 70
        ? 'bg-amber-500'
        : 'bg-emerald-500';
  return (
    <div className="cds-surface-sunken cds-hairline px-3 py-2">
      <div className="mb-2 flex min-w-0 items-center gap-2">
        <span className="text-muted-foreground">{icon}</span>
        <span className="min-w-0 truncate">{label}</span>
        <span className="ml-auto font-mono text-foreground">{value}%</span>
      </div>
      <div className="h-1.5 overflow-hidden rounded-full bg-muted">
        <div className={`h-full rounded-full ${tone}`} style={{ width: `${Math.min(100, Math.max(0, value))}%` }} />
      </div>
    </div>
  );
}

function ExecutorNodeRow({
  node,
  actionLabel,
  onDrain,
  onRemove,
}: {
  node: ExecutorNodeSummary;
  actionLabel?: string;
  onDrain: () => void;
  onRemove: () => void;
}): JSX.Element {
  const isEmbedded = node.role === 'embedded';
  const memPercent = executorMemPercent(node);
  const canDrain = !isEmbedded && node.status === 'online' && !actionLabel;
  const canRemove = !isEmbedded && !actionLabel;
  return (
    <div className="cds-surface-sunken cds-hairline px-3 py-2 text-xs">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <Network className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            <span className="truncate font-medium text-foreground">{node.id}</span>
          </div>
          <div className="mt-1 truncate text-muted-foreground">
            {node.host || 'local'}{node.port ? `:${node.port}` : ''} · {node.role || 'remote'}
          </div>
        </div>
        <span className={`rounded border px-1.5 py-0.5 ${
          node.status === 'online'
            ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-600'
            : node.status === 'draining'
              ? 'border-amber-500/30 bg-amber-500/10 text-amber-600'
              : 'border-destructive/30 bg-destructive/10 text-destructive'
        }`}
        >
          {actionLabel || node.status}
        </span>
      </div>
      <div className="mt-2 grid grid-cols-3 gap-2">
        <MetricTile label="分支" value={node.branchCount || 0} />
        <MetricTile label="CPU" value={`${node.load?.cpuPercent ?? 0}%`} />
        <MetricTile label="内存" value={`${memPercent}%`} />
      </div>
      <div className="mt-2 flex flex-wrap gap-2">
        <Button type="button" size="sm" variant="outline" disabled={!canDrain} onClick={onDrain}>
          <PowerOff />
          排空
        </Button>
        <Button type="button" size="sm" variant="outline" disabled={!canRemove} onClick={onRemove}>
          <Trash2 />
          移除
        </Button>
        {isEmbedded ? <span className="self-center text-muted-foreground">本机主执行器不可移除</span> : null}
      </div>
    </div>
  );
}
