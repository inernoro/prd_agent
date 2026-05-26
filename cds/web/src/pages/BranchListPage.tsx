import type { ReactNode } from 'react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Navigate, useParams } from 'react-router-dom';
import {
  Activity,
  AlertCircle,
  ArrowLeft,
  Bot,
  ChevronDown,
  Copy,
  Cpu,
  Eye,
  ExternalLink,
  Gauge,
  GitBranch,
  Github,
  HardDrive,
  Lightbulb,
  Loader2,
  Clock3,
  MoreHorizontal,
  Network,
  Play,
  PowerOff,
  Plus,
  RefreshCw,
  RotateCw,
  Rocket,
  Search,
  Server,
  Settings,
  Square,
  Star,
  Tags,
  Trash2,
  X,
} from 'lucide-react';

import { AppShell, Crumb, PaletteHint, TopBar, Workspace } from '@/components/layout/AppShell';
import { BranchDetailDrawer, type BranchDeploymentItem } from '@/components/BranchDetailDrawer';
import { CapacityFullDialog } from '@/components/CapacityFullDialog';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { ConfirmAction } from '@/components/ui/confirm-action';
import { DropdownDivider, DropdownItem, DropdownLabel, DropdownMenu } from '@/components/ui/dropdown-menu';
import { apiRequest, ApiError } from '@/lib/api';
import { reduceBranchListState, type BranchListAction, type BranchListSlice } from '@/lib/branch-list-state';
import { normalizeHostStats, type NormalizedHostStats } from '@/lib/host-stats';
import { statusClass, statusRailClass } from '@/lib/statusStyle';
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
  gitDefaultBranch?: string | null;
  defaultBranch?: string | null;
  branchCount?: number;
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
  lastPushAt?: string;
  lastAccessedAt?: string;
  lastPullAt?: string;
  lastDeployAt?: string;
  errorMessage?: string;
  commitSha?: string;
  subject?: string;
  builder?: {
    name: string;
    email?: string;
    login?: string;
    avatarUrl?: string;
  };
  previewSlug?: string;
  githubCommitSha?: string;
  githubRepoFullName?: string;
  githubPrNumber?: number;
  githubSenderLogin?: string;
  githubSenderAvatarUrl?: string;
  tags?: string[];
  isFavorite?: boolean;
  isColorMarked?: boolean;
  deployCount?: number;
  pullCount?: number;
  stopCount?: number;
  aiOpCount?: number;
  lastAiOccupantAt?: string;
  deployRuntime?: {
    kind: 'source' | 'release' | 'mixed';
    label: string;
    title: string;
    activeProfiles: number;
    releaseProfiles: number;
    sourceProfiles: number;
    modes: string[];
    pendingPublish?: boolean;
  };
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
  isDefault?: boolean;
}

interface RemoteBranchesResponse {
  branches: RemoteBranch[];
  defaultBranch?: string | null;
}

interface PreviewModeResponse {
  mode: 'simple' | 'port' | 'multi';
}

const AI_ACTIVE_TTL_MS = 5 * 60 * 1000;

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
  requestId?: string;
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
  errorSummary?: string;
  query?: string;
  branchId?: string;
  branchTags?: string[];
  profileId?: string;
  remoteAddr?: string;
  referer?: string;
  userAgent?: string;
}

interface FocusBranchEventDetail {
  projectId?: string;
  branchId?: string;
}

type HostStatsResponse = NormalizedHostStats;

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
      lastKnownGoodBranches: BranchSummary[];
      remoteBranches: RemoteBranch[];
      previewMode: 'simple' | 'port' | 'multi';
      config: CdsConfigResponse;
      capacity?: BranchesResponse['capacity'];
      projectWarning?: string;
      // Codex review(PR #590):banner 条件需要 infra service dockerImage,而非 branch.services 的 key。
      // 因为数据库通常作 infra service 部署(独立于 build-profile),首次 deploy 前 branch.services 为空,
      // 又或者 infra id 是 'db' 之类不含 mysql 关键字。fetch infra 接口取真实信号源。
      hasSchemafulInfra: boolean;
    };

type OkLoadState = Extract<LoadState, { status: 'ok' }>;

function applyBranchListAction(
  current: OkLoadState,
  action: BranchListAction<BranchSummary>,
): { state: OkLoadState; needsEmptyRecheck: boolean } {
  const slice: BranchListSlice<BranchSummary> = {
    branches: current.branches,
    lastKnownGoodBranches: current.lastKnownGoodBranches,
    projectWarning: current.projectWarning,
  };
  const result = reduceBranchListState(slice, action);
  return {
    state: {
      ...current,
      branches: result.state.branches,
      lastKnownGoodBranches: result.state.lastKnownGoodBranches,
      projectWarning: result.state.projectWarning,
    },
    needsEmptyRecheck: result.needsEmptyRecheck,
  };
}

function parseSseJson<T>(event: Event): T | null {
  try {
    return JSON.parse((event as MessageEvent).data) as T;
  } catch {
    return null;
  }
}

type OpsStatusState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ok'; capacity: ExecutorCapacityResponse; cluster: ClusterStatusResponse };

type BranchAction = {
  kind: 'preview' | 'deploy' | 'pull' | 'stop' | 'create' | 'favorite' | 'reset' | 'delete' | 'rebuild';
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
type ActivityTypeFilter = 'all' | 'api' | 'web' | 'ai';

type FailedDeployTarget = {
  branch: BranchSummary;
  profileId?: string;
  label: string;
};

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
  if (/mongoconfigurationexception|mongodb:\/\/[^/\s]+:\s|cds_mongodb_port|mongodb.*connection string/.test(text)) {
    return 'MongoDB 连接串缺少端口。检查项目环境变量中的 CDS_MONGODB_PORT / MongoDB__ConnectionString，或先启动/注册项目的 MongoDB 基础设施。';
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
    event.requestId ? `requestId=${event.requestId}` : '',
    event.errorSummary ? `error=${event.errorSummary}` : '',
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
  const leftTime = new Date(left.lastAccessedAt || left.lastDeployAt || left.lastPushAt || left.createdAt || 0).getTime() || 0;
  const rightTime = new Date(right.lastAccessedAt || right.lastDeployAt || right.lastPushAt || right.createdAt || 0).getTime() || 0;
  return leftTime - rightTime;
}

type BranchVisualRole = 'main' | 'master' | 'environment' | 'regular';

const ENVIRONMENT_BRANCH_ORDER = ['dev', 'develop', 'development', 'staging', 'stage', 'test', 'qa', 'prod', 'production'];

function normalizedBranchName(value: string): string {
  return value.trim().replace(/^refs\/heads\//, '').replace(/^origin\//, '').toLowerCase();
}

function branchVisualRole(branchName: string): BranchVisualRole {
  const name = normalizedBranchName(branchName);
  if (name === 'main') return 'main';
  if (name === 'master') return 'master';
  if (ENVIRONMENT_BRANCH_ORDER.includes(name)) return 'environment';
  return 'regular';
}

function branchSortRank(branchName: string): number {
  const name = normalizedBranchName(branchName);
  if (name === 'main') return 0;
  if (name === 'master') return 1;
  const envIndex = ENVIRONMENT_BRANCH_ORDER.indexOf(name);
  return envIndex >= 0 ? 10 + envIndex : 100;
}

function branchRoleCardClass(role: BranchVisualRole): string {
  switch (role) {
    case 'main':
      return 'border-emerald-400/55 shadow-[0_0_0_1px_rgba(52,211,153,0.16),0_16px_34px_-28px_rgba(52,211,153,0.85)]';
    case 'master':
      return 'border-cyan-400/55 shadow-[0_0_0_1px_rgba(34,211,238,0.15),0_16px_34px_-28px_rgba(34,211,238,0.8)]';
    case 'environment':
      return 'border-amber-400/42 shadow-[0_0_0_1px_rgba(251,191,36,0.12),0_16px_34px_-30px_rgba(251,191,36,0.72)]';
    default:
      return '';
  }
}

function shortCommitSha(branch: BranchSummary): string {
  const sha = branch.commitSha || branch.githubCommitSha || '';
  return /^[0-9a-f]{7,40}$/i.test(sha) ? sha.slice(0, 7) : '';
}

function builderHandle(branch: BranchSummary): string {
  const login = branch.builder?.login?.trim();
  if (login) return `@${login}`;
  const sender = branch.githubSenderLogin?.trim();
  if (sender) return `@${sender}`;
  const name = branch.builder?.name?.trim();
  return name ? `@${name}` : '';
}

function githubAvatarUrlFromHandle(value?: string): string {
  const handle = (value || '').trim().replace(/^@/, '');
  if (!/^[a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])?$/i.test(handle)) return '';
  return `https://github.com/${encodeURIComponent(handle)}.png?size=64`;
}

type AvatarLoadStatus = 'idle' | 'loading' | 'loaded' | 'failed';

const AVATAR_CACHE_STORAGE_KEY = 'cds.branch.avatarLoadStatus.v1';
const AVATAR_CACHE_MAX_ENTRIES = 160;
const avatarLoadStatusCache = new Map<string, AvatarLoadStatus>();

function readAvatarStorage(): Record<string, { status: 'loaded' | 'failed'; ts: number }> {
  if (typeof window === 'undefined') return {};
  try {
    const raw = window.localStorage.getItem(AVATAR_CACHE_STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : {};
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function writeAvatarStorage(
  url: string,
  status: 'loaded' | 'failed',
): void {
  if (typeof window === 'undefined') return;
  try {
    const next = readAvatarStorage();
    next[url] = { status, ts: Date.now() };
    const entries = Object.entries(next).sort((a, b) => b[1].ts - a[1].ts).slice(0, AVATAR_CACHE_MAX_ENTRIES);
    window.localStorage.setItem(AVATAR_CACHE_STORAGE_KEY, JSON.stringify(Object.fromEntries(entries)));
  } catch {
    // localStorage may be blocked or full; in-memory cache still avoids same-session flicker.
  }
}

function cachedAvatarStatus(url: string): AvatarLoadStatus {
  if (!url) return 'failed';
  const memory = avatarLoadStatusCache.get(url);
  if (memory) return memory;
  const stored = readAvatarStorage()[url]?.status;
  if (stored) {
    avatarLoadStatusCache.set(url, stored);
    return stored;
  }
  return 'idle';
}

function rememberAvatarStatus(url: string, status: 'loaded' | 'failed'): void {
  if (!url) return;
  avatarLoadStatusCache.set(url, status);
  writeAvatarStorage(url, status);
}

function circularActorText(value: string): string {
  const base = (value || '').trim() || 'CDS';
  const compact = base.replace(/\s+/g, '');
  const clipped = compact.length > 18 ? compact.slice(0, 18) : compact;
  return `${clipped} • ${clipped} •`;
}

function CircularActorText({ text }: { text: string }): JSX.Element {
  const chars = Array.from(circularActorText(text));
  return (
    <span className="cds-actor-orbit__ring" aria-hidden>
      {chars.map((char, index) => {
        const angle = (360 / chars.length) * index;
        return (
          <span
            // eslint-disable-next-line react/no-array-index-key
            key={`${char}-${index}`}
            className="cds-actor-orbit__char"
            style={{ transform: `rotate(${angle}deg) translateY(-23px) rotate(90deg)` }}
          >
            {char}
          </span>
        );
      })}
    </span>
  );
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
  const label = branchIssueLabel(branch);
  const serviceNames = failedServices.map((svc) => svc.profileId).join(', ');
  if (branch.errorMessage) return `${label}：${branch.errorMessage}`;
  const serviceErrors = failedServices
    .map((svc) => svc.errorMessage ? `${svc.profileId}: ${svc.errorMessage}` : '')
    .filter(Boolean);
  if (serviceErrors.length > 0) return `${label}：${serviceErrors.join('；')}`;
  if (serviceNames) return `${label}：${serviceNames} 启动失败`;
  return `${label}：分支进入异常状态`;
}

function projectIdFromQuery(): string {
  return new URLSearchParams(window.location.search).get('project') || '';
}

function displayName(project: ProjectSummary): string {
  return project.aliasName || project.name || project.slug || project.id;
}

function projectSwitcherMeta(project: ProjectSummary): string {
  const title = displayName(project);
  const candidates = [project.slug, project.githubRepoFullName, project.id].filter(Boolean) as string[];
  return candidates.find((value) => value !== title) || '';
}

function projectEnvSettingsHref(projectId: string): string {
  return `/settings/${encodeURIComponent(projectId)}?tab=env`;
}

function fallbackProjectSummary(projectId: string): ProjectSummary {
  return {
    id: projectId,
    slug: projectId,
    name: projectId,
  };
}

function readableError(err: unknown): string {
  return err instanceof ApiError ? err.message : String(err);
}

function formatRelativeTime(value?: string | null, fallback = '等待首次部署'): string {
  if (!value) return fallback;
  const ts = new Date(value).getTime();
  if (!Number.isFinite(ts)) return fallback;
  const diff = Date.now() - ts;
  if (diff < 0) return '刚刚';
  const minutes = Math.max(1, Math.round(diff / 60_000));
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  const days = Math.round(hours / 24);
  return `${days} 天前`;
}

function formatElapsedFrom(since: string | undefined | null, now: number): string {
  if (!since) return '00:00';
  const ts = new Date(since).getTime();
  if (!Number.isFinite(ts)) return '00:00';
  const seconds = Math.max(0, Math.floor((now - ts) / 1000));
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return `${String(minutes).padStart(2, '0')}:${String(rest).padStart(2, '0')}`;
}

function formatElapsedSecondsFrom(since: string | undefined | null, now: number): string {
  if (!since) return '0s';
  const ts = new Date(since).getTime();
  if (!Number.isFinite(ts)) return '0s';
  const seconds = Math.max(0, Math.floor((now - ts) / 1000));
  if (seconds < 3600) return `${seconds}s`;
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  return minutes ? `${hours}h ${minutes}m` : `${hours}h`;
}

type AiOperationStatus = 'none' | 'active' | 'timeout' | 'released';

function formatLocalDateTime(value?: string | null): string {
  if (!value) return '-';
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '-';
  return date.toLocaleString();
}

function aiOperationState(branch: BranchSummary, now: number): {
  active: boolean;
  visible: boolean;
  history: boolean;
  status: AiOperationStatus;
  label: string;
  title: string;
  lastAt?: string;
  timeoutAt?: string;
  relative: string;
} {
  const lastAt = branch.lastAiOccupantAt || null;
  const lastAtMs = lastAt ? new Date(lastAt).getTime() : Number.NaN;
  const hasValidLastAt = Number.isFinite(lastAtMs);
  const active = hasValidLastAt && now - lastAtMs <= AI_ACTIVE_TTL_MS;
  const visible = active;
  const history = active || (branch.aiOpCount || 0) > 0 || hasValidLastAt;
  const timeoutAt = hasValidLastAt ? new Date(lastAtMs + AI_ACTIVE_TTL_MS).toISOString() : undefined;
  const relative = hasValidLastAt ? formatRelativeTime(lastAt, '未知时间') : '';
  const status: AiOperationStatus = !history
    ? 'none'
    : active
      ? 'active'
      : branch.status === 'idle'
        ? 'released'
        : 'timeout';
  const label = status === 'active'
    ? 'AI 正在操作'
    : status === 'timeout'
      ? 'AI 已超时'
      : status === 'released'
        ? 'AI 已释放'
        : '无 AI 操作';
  const count = branch.aiOpCount ? ` · ${branch.aiOpCount} 次` : '';
  return {
    active,
    visible,
    history,
    status,
    label,
    title: history
      ? `${label}${relative ? ` · 最近 ${relative}` : ''}${count}`
      : '无 AI 操作记录',
    lastAt: lastAt || undefined,
    timeoutAt,
    relative,
  };
}

function aiBadgeClass(status: AiOperationStatus): string {
  switch (status) {
    case 'active':
      return 'border-sky-400/50 bg-sky-400/10 text-sky-300 hover:bg-sky-400/15';
    case 'timeout':
      return 'border-amber-400/45 bg-amber-400/10 text-amber-300 hover:bg-amber-400/15';
    case 'released':
      return 'border-[hsl(var(--hairline))] bg-[hsl(var(--surface-sunken))] text-muted-foreground hover:text-foreground';
    default:
      return 'border-[hsl(var(--hairline))] bg-[hsl(var(--surface-sunken))] text-muted-foreground';
  }
}

function branchBusySince(branch: BranchSummary, action?: BranchAction): string | undefined {
  if (action?.status === 'running') return new Date(action.startedAt).toISOString();
  return branch.lastAccessedAt || branch.lastDeployAt || branch.lastPushAt || branch.createdAt;
}

function branchTimeBadge(branch: BranchSummary, now = Date.now(), busySince?: string): { label: string; text: string; title: string } {
  if (isBusy(branch)) {
    const since = busySince || branchBusySince(branch);
    return {
      label: '部署',
      text: formatElapsedSecondsFrom(since, now),
      title: since
        ? `部署已持续 ${formatElapsedSecondsFrom(since, now)}；开始时间: ${since}`
        : '部署正在进行，完成后会写入最近部署时间',
    };
  }
  if (branch.status === 'error' || branch.errorMessage) {
    if (branch.lastAccessedAt) {
      return {
        label: '部署失败',
        text: formatRelativeTime(branch.lastAccessedAt),
        title: branch.errorMessage
          ? `最近一次部署失败: ${branch.lastAccessedAt} · ${branch.errorMessage}`
          : `最近一次部署失败: ${branch.lastAccessedAt}`,
      };
    }
    return {
      label: '部署',
      text: '未完成',
      title: branch.errorMessage || '最近一次部署未完成，详情见分支面板',
    };
  }
  const pushMs = branch.lastPushAt ? Date.parse(branch.lastPushAt) : 0;
  const deployAttemptMs = branch.lastAccessedAt ? Date.parse(branch.lastAccessedAt) : 0;
  const deploySuccessMs = branch.lastDeployAt ? Date.parse(branch.lastDeployAt) : 0;
  const deployedMs = Math.max(deployAttemptMs || 0, deploySuccessMs || 0);
  if (branch.lastPushAt && pushMs > deployedMs) {
    const deployPart = branch.lastDeployAt
      ? `；最近成功部署: ${branch.lastDeployAt}`
      : branch.lastAccessedAt
        ? `；最近部署尝试: ${branch.lastAccessedAt}`
        : '';
    return {
      label: '最近推送',
      text: formatRelativeTime(branch.lastPushAt),
      title: `GitHub push 到达 CDS: ${branch.lastPushAt}${deployPart}`,
    };
  }
  if (branch.lastAccessedAt) {
    return {
      label: '上次部署',
      text: formatRelativeTime(branch.lastAccessedAt),
      title: `最近一次部署尝试: ${branch.lastAccessedAt}`,
    };
  }
  if (branch.lastDeployAt) {
    return {
      label: '部署成功',
      text: formatRelativeTime(branch.lastDeployAt),
      title: `最近一次成功部署完成: ${branch.lastDeployAt}`,
    };
  }
  return {
    label: '部署',
    text: '等待首次完成',
    title: branch.createdAt ? `尚无成功部署；分支创建于 ${branch.createdAt}` : '尚无成功部署记录',
  };
}

// 错误归责分类(2026-05-21)
//   - cds-runtime: CDS 自己该擦的屁股,容器在 docker 层消失/镜像拉不到/forwarder 挂了/磁盘满了
//                  这些都不是应用代码的错,标红与应用代码错误区分开
//   - app-code:    应用启动后崩了/找不到依赖/健康检查不通过/进程 exit code 非零
//                  这是业务侧自查,CDS 不该自动 redeploy 替它擦
//   - deploy-config: 端口冲突/OOM/资源不足,介于两者之间,通常调配额可解决
//   - unknown:     未匹配到关键词
type BranchIssueCategory = 'cds-runtime' | 'app-code' | 'deploy-config' | 'unknown';

const BRANCH_ISSUE_LABELS: Record<BranchIssueCategory, string> = {
  'cds-runtime': 'CDS 运行时错误',
  'app-code': '应用代码错误',
  'deploy-config': '部署配置错误',
  'unknown': '未分类错误',
};

function branchIssueCategory(branch: BranchSummary): BranchIssueCategory {
  const text = [
    branch.errorMessage || '',
    ...Object.values(branch.services || {}).map((service) => service.errorMessage || ''),
  ].join('\n').toLowerCase();
  if (!text.trim()) return 'unknown';

  // CDS 运行时(容器丢失/CDS 重启中断/镜像拉取/调度器/forwarder/磁盘容量)
  if (
    /容器已丢失|cds 重启|cds重启|上一次部署|forwarder|proxy|调度|scheduler|docker daemon|no space|磁盘|capacity|容量|镜像.*(拉取|pull)|image.*(not found|pull access|manifest unknown|repository does not exist)|network.*(unreachable|超时)/.test(text)
  ) {
    return 'cds-runtime';
  }

  // 部署配置(端口冲突 / OOM / 资源不足)
  // 端口冲突文案与后端 isPortConflictError(src/routes/branches.ts) 对齐:
  // docker 报 'port is already allocated',内核报 'address already in use'/EADDRINUSE
  if (/eaddrinuse|address already in use|port is already allocated|端口被占用|端口.*(占用|冲突)|oomkilled|out of memory|cannot allocate memory|内存超限/.test(text)) {
    return 'deploy-config';
  }

  // 应用代码(异常退出/缺依赖/启动失败/健康检查)
  if (
    /容器异常退出|容器.*启动后退出|疑似崩溃|exit\s*(code|ed with code)?\s*[:=]?\s*\d+|cannot find module|module not found|module_not_found|启动信号超时|健康检查.*超时|health.*(check.*timeout|probe failed)|readiness probe failed/.test(text)
  ) {
    return 'app-code';
  }

  return 'unknown';
}

function branchIssueLabel(branch: BranchSummary): string {
  return BRANCH_ISSUE_LABELS[branchIssueCategory(branch)];
}

function branchIssueClass(branch: BranchSummary): string {
  const category = branchIssueCategory(branch);
  if (category === 'cds-runtime') {
    return 'border-destructive/40 bg-destructive/15 text-destructive font-semibold';
  }
  if (category === 'app-code') {
    return 'border-amber-500/45 bg-amber-500/10 text-amber-700 dark:text-amber-300 font-semibold';
  }
  if (category === 'deploy-config') {
    return 'border-orange-500/45 bg-orange-500/10 text-orange-700 dark:text-orange-300 font-semibold';
  }
  return 'border-muted-foreground/30 bg-muted/30 text-muted-foreground font-semibold';
}

function branchIssueRailClass(branch: BranchSummary): string {
  const category = branchIssueCategory(branch);
  if (category === 'cds-runtime') return 'bg-destructive';
  if (category === 'app-code') return 'bg-amber-500';
  if (category === 'deploy-config') return 'bg-orange-500';
  return 'bg-muted-foreground/40';
}

// 错误卡片整体描边/底色/光晕 —— 必须与 badge/rail 同一 category 配色,
// 否则胶囊显橙(deploy-config)/灰(unknown)而卡片边框还是琥珀,视觉割裂。
function branchIssueCardClass(branch: BranchSummary): string {
  const category = branchIssueCategory(branch);
  if (category === 'cds-runtime') {
    return 'border-destructive/60 bg-destructive/5 ring-1 ring-destructive/30 shadow-[0_0_0_1px_hsl(var(--destructive)/0.25),0_4px_16px_-4px_hsl(var(--destructive)/0.35)]';
  }
  if (category === 'app-code') {
    return 'border-amber-500/55 bg-amber-500/5 ring-1 ring-amber-500/20 shadow-[0_4px_16px_-4px_rgba(245,158,11,0.32)]';
  }
  if (category === 'deploy-config') {
    return 'border-orange-500/55 bg-orange-500/5 ring-1 ring-orange-500/20 shadow-[0_4px_16px_-4px_rgba(249,115,22,0.32)]';
  }
  return 'border-muted-foreground/40 bg-muted/20 ring-1 ring-muted-foreground/15 shadow-[0_4px_16px_-4px_rgba(100,116,139,0.28)]';
}

// 错误提示条文字色 —— 同样按 category 派发,与卡片/胶囊一致。
function branchIssueHintTextClass(branch: BranchSummary): string {
  const category = branchIssueCategory(branch);
  if (category === 'cds-runtime') return 'text-destructive/80';
  if (category === 'app-code') return 'text-amber-700/90 dark:text-amber-300/90';
  if (category === 'deploy-config') return 'text-orange-700/90 dark:text-orange-300/90';
  return 'text-muted-foreground';
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

// Bugbot fix(2026-05-04 PR #523):statusClass + statusRailClass 已抽到
// `cds/web/src/lib/statusStyle.ts` 共享模块,与 BranchDetailDrawer 等其它
// 组件共用单一 SSOT。改色 / 调字重 / 改 dot 形状 → 全部改那一个文件。

function serviceCount(branch: BranchSummary): number {
  return Object.keys(branch.services || {}).length;
}

function runningServiceCount(branch: BranchSummary): number {
  return Object.values(branch.services || {}).filter((svc) => svc.status === 'running').length;
}

function compactServiceLabel(profileId: string): string {
  const normalized = profileId.trim();
  if (!normalized) return 'service';
  const tokens = normalized.toLowerCase().split(/[-_]+/).filter(Boolean);

  if (tokens.includes('frontend')) return 'frontend';
  if (tokens.includes('backend')) return 'backend';
  if (tokens.includes('api')) return 'api';
  if (tokens.includes('admin')) return 'admin';
  if (tokens.includes('web')) return 'web';
  if (tokens.includes('bootstrap') || tokens.includes('server')) return 'backend';

  return normalized
    .replace(/[-_]prd[-_]?agent$/i, '')
    .replace(/[-_]agent$/i, '')
    .replace(/[-_]mytapd$/i, '');
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

/**
 * Opens the short-lived preview transition page in the new window before the
 * target preview URL is known. Keep this route-based so the real handoff and
 * the settings preview share the same ReactBits Hyperspeed surface.
 */
function openPreviewPlaceholder(branchName = 'preview-handoff'): PreviewTarget {
  const params = new URLSearchParams({ branch: branchName, t: String(Date.now()) });
  const target = window.open(`/preview-preparing?${params.toString()}`, '_blank');
  if (!target) return null;
  try {
    target.opener = null;
  } catch {
    // Some browsers can deny opener mutation after window creation.
  }
  return target;
}

function navigatePreview(target: PreviewTarget, url: string): void {
  if (target && !target.closed) {
    target.location.replace(url);
    return;
  }
  window.open(url, '_blank', 'noopener,noreferrer');
}

function closePreviewTarget(target: PreviewTarget): void {
  try {
    if (target && !target.closed && target.location.pathname === '/preview-preparing') target.close();
  } catch {
    // ignore cross-origin or already-closed windows
  }
}

export function BranchListPage(): JSX.Element {
  const { projectId: projectIdParam } = useParams();
  const projectId = projectIdParam || projectIdFromQuery();
  const [state, setState] = useState<LoadState>({ status: 'loading' });
  const [selectedBranchIds, setSelectedBranchIds] = useState<string[]>([]);
  const [manualBranchName, setManualBranchName] = useState('');
  // 用户从搜索下拉选中已有分支时,使用稳定选中态标记卡片。
  // 不再用短暂 pulse + 计时器,避免分支流刷新/列表重排时动画被吃掉。
  const [highlightedBranchId, setHighlightedBranchId] = useState<string | null>(null);
  const [highlightPulseBranchId, setHighlightPulseBranchId] = useState<string | null>(null);
  const [toast, setToast] = useState('');
  const [actions, setActions] = useState<Record<string, BranchAction>>({});
  const [actionClock, setActionClock] = useState(Date.now());
  const [activityEvents, setActivityEvents] = useState<ActivityEvent[]>([]);
  const [activityTypeFilter, setActivityTypeFilter] = useState<ActivityTypeFilter>('all');
  const [activityBranchFilter, setActivityBranchFilter] = useState('');
  const [selectedActivityId, setSelectedActivityId] = useState<number | null>(null);
  const [opsStatus, setOpsStatus] = useState<OpsStatusState>({ status: 'loading' });
  const [hostStats, setHostStats] = useState<HostStatsState>({ status: 'loading' });
  const [redeployFailedRunning, setRedeployFailedRunning] = useState(false);
  const [cleanupDamagedRunning, setCleanupDamagedRunning] = useState(false);
  const [remoteBranchesLoading, setRemoteBranchesLoading] = useState(false);
  // 项目切换器 — Week 4.8 Round 4d:Crumb 上的项目名变成 1 步切换的 dropdown
  // 不阻塞首屏加载;失败默默静默(降级到只显示项目列表入口)
  const [allProjects, setAllProjects] = useState<ProjectSummary[]>([]);
  const [executorAction, setExecutorAction] = useState<Record<string, string>>({});
  const [selectedBranchId, setSelectedBranchId] = useState<string | null>(null);
  const [opsDrawerOpen, setOpsDrawerOpen] = useState(false);
  const noticeProject = useMemo(() => (
    state.status === 'ok' ? state.project : projectId ? fallbackProjectSummary(projectId) : null
  ), [projectId, state.status, state.status === 'ok' ? state.project.id : null, state.status === 'ok' ? state.project.slug : null, state.status === 'ok' ? state.project.name : null, state.status === 'ok' ? state.project.aliasName : null]);
  // 2026-05-07 wave 1.3:容量超限交互式选择停哪个分支
  const [capacityDialog, setCapacityDialog] = useState<{
    branch: BranchSummary;
    needSlots: number;
  } | null>(null);
  const [detailDrawerBranchId, setDetailDrawerBranchId] = useState<string | null>(null);
  const [branchSearchOpen, setBranchSearchOpen] = useState(false);
  const [pendingEnvKeys, setPendingEnvKeys] = useState<string[]>([]);
  // 标签过滤:用户点击 BranchCard 上某个标签 chip 时切到只显示该标签的分支;
  // 顶部出现"正在过滤:#xxx ×"chip,点 × 清除。单标签过滤(对齐 legacy)。
  const [activeTagFilter, setActiveTagFilter] = useState<string | null>(null);
  const [bulkTagBranchId, setBulkTagBranchId] = useState<string | null>(null);
  const [bulkTagDraft, setBulkTagDraft] = useState('');
  const [bulkTagError, setBulkTagError] = useState('');
  const branchSearchRef = useRef<HTMLDivElement | null>(null);
  const actionRef = useRef<Record<string, BranchAction>>({});
  const highlightPulseTimerRef = useRef<number | null>(null);
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
    const hasRunningAction = Object.values(actions).some((action) => action.status === 'running');
    const hasInterimBranch = state.status === 'ok' && state.branches.some((branch) => isBusy(branch));
    if (!hasRunningAction && !hasInterimBranch) return;
    const timer = window.setInterval(() => setActionClock(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [actions, state]);

  // refresh 拆分(2026-04-30):远程分支独立 lazy load,不阻塞主区
  // ----------------------------------------------------------
  // 历史问题:`Promise.all` 5 API 全等,/api/remote-branches 后端
  // 同步跑 git fetch (timeout 30s),把整个首屏 loading 拖死。
  //
  // 现在:
  //   - 主 refresh 只 await 4 个核心 API(project / branches /
  //     preview-mode / config),首屏几十毫秒就进 ok 状态
  //   - 远程分支由独立 useEffect 触发,首次走 cache(后端 5 分钟内
  //     不再 git fetch),用户主动刷新时才 force refresh
  //   - UI 在远程区独立显示"加载远程分支..."chip,不阻塞主链路
  const confirmEmptyBranchList = useCallback(async (source: string) => {
    if (!projectId) return;
    try {
      const [projectResult, branchesResult] = await Promise.allSettled([
        apiRequest<ProjectSummary>(`/api/projects/${encodeURIComponent(projectId)}`),
        apiRequest<BranchesResponse>(`/api/branches?project=${encodeURIComponent(projectId)}&live=false`),
      ]);
      if (branchesResult.status === 'rejected') {
        const message = readableError(branchesResult.reason);
        setState((prev) => {
          if (prev.status !== 'ok') return prev;
          return applyBranchListAction(prev, {
            type: 'refreshFailed',
            message: `${source} 复核失败，已保留上次可用内容。${message}`,
          }).state;
        });
        return;
      }
      const project = projectResult.status === 'fulfilled' ? projectResult.value : undefined;
      const projectWarning = projectResult.status === 'rejected'
        ? `项目元信息复核失败，分支列表已保留当前可用内容。${readableError(projectResult.reason)}`
        : undefined;
      setState((prev) => {
        if (prev.status !== 'ok') return prev;
        const applied = applyBranchListAction(prev, {
          type: 'authoritativeLoaded',
          branches: branchesResult.value.branches || [],
          source,
          confirmedEmpty: true,
          projectBranchCount: project?.branchCount,
          warning: projectWarning,
        });
        return {
          ...applied.state,
          project: project || prev.project,
          capacity: branchesResult.value.capacity || prev.capacity,
          projectWarning: applied.state.projectWarning || projectWarning,
        };
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setState((prev) => {
        if (prev.status !== 'ok') return prev;
        return applyBranchListAction(prev, {
          type: 'refreshFailed',
          message: `${source} 复核失败，已保留上次可用内容。${message}`,
        }).state;
      });
    }
  }, [projectId]);

  const refreshLiveBranches = useCallback(async () => {
    if (!projectId) return;
    try {
      const branchesRes = await apiRequest<BranchesResponse>(`/api/branches?project=${encodeURIComponent(projectId)}&live=false`);
      let needsEmptyRecheck = false;
      setState((prev) => {
        if (prev.status !== 'ok') return prev;
        const applied = applyBranchListAction(prev, {
          type: 'authoritativeLoaded',
          branches: branchesRes.branches || [],
          source: '后台刷新',
          projectBranchCount: prev.project.branchCount,
        });
        needsEmptyRecheck = needsEmptyRecheck || applied.needsEmptyRecheck;
        return {
          ...applied.state,
          capacity: branchesRes.capacity,
        };
      });
      if (needsEmptyRecheck) void confirmEmptyBranchList('后台刷新');
    } catch (err) {
      const message = readableError(err);
      setState((prev) => {
        if (prev.status !== 'ok') return prev;
        return applyBranchListAction(prev, {
          type: 'refreshFailed',
          message: `后台刷新失败，已保留上次可用内容。${message}`,
        }).state;
      });
      // 首屏已显示缓存态;后台快照刷新失败时保留现状,让 SSE 和手动刷新兜底。
    }
  }, [confirmEmptyBranchList, projectId]);

  const refresh = useCallback(async (showLoading = false, forceLive = false) => {
    if (!projectId) return;
    if (showLoading) {
      setState((prev) => prev.status === 'ok' ? prev : { status: 'loading' });
    }
    try {
      const branchUrl = `/api/branches?project=${encodeURIComponent(projectId)}&live=${forceLive ? 'true' : 'false'}`;
      const infraUrl = `/api/infra?project=${encodeURIComponent(projectId)}&live=${forceLive ? 'true' : 'false'}`;
      const [projectResult, branchesResult, previewModeResult, configResult, infraResult] = await Promise.allSettled([
        apiRequest<ProjectSummary>(`/api/projects/${encodeURIComponent(projectId)}`),
        apiRequest<BranchesResponse>(branchUrl),
        apiRequest<PreviewModeResponse>(`/api/projects/${encodeURIComponent(projectId)}/preview-mode`),
        apiRequest<CdsConfigResponse>('/api/config'),
        apiRequest<{ services: Array<{ id: string; dockerImage?: string }> }>(
          infraUrl,
        ),
      ]);
      if (branchesResult.status === 'rejected') {
        const message = readableError(branchesResult.reason);
        setState((prev) => prev.status === 'ok'
          ? applyBranchListAction(prev, {
            type: 'refreshFailed',
            message: `分支列表刷新失败，已保留上次可用内容。${message}`,
          }).state
          : { status: 'error', message });
        return;
      }
      const branchesRes = branchesResult.value;
      const project = projectResult.status === 'fulfilled'
        ? projectResult.value
        : fallbackProjectSummary(projectId);
      const projectWarning = projectResult.status === 'rejected'
        ? `项目元信息暂时不可读，分支列表已降级继续显示。${readableError(projectResult.reason)}`
        : undefined;
      const previewModeRes = previewModeResult.status === 'fulfilled'
        ? previewModeResult.value
        : { mode: 'multi' as const };
      const config = configResult.status === 'fulfilled' ? configResult.value : {};
      const infraRes = infraResult.status === 'fulfilled' ? infraResult.value : { services: [] };
      // Codex review(PR #590):banner 显示条件来自 infra dockerImage,不是 branch.services key。
      // 兜底也看 id(用户用 'db' 等命名,但 image 字段是真实信号)。
      // Bugbot review(PR #590):**不**含 mongo。banner 文案专写 "schema.sql / mysql / postgres",
      // MongoDB 的 init 走 .js/.sh 不走 SQL,放进来会误导用户上传 SQL。
      const hasSchemafulInfra = (infraRes.services || []).some((s) =>
        /(mysql|mariadb|postgres)/i.test(`${s.dockerImage || ''} ${s.id || ''}`),
      );
      let needsEmptyRecheck = false;
      setState((prev) => {
        const base: OkLoadState = prev.status === 'ok'
          ? prev
          : {
            status: 'ok',
            project,
            branches: [],
            lastKnownGoodBranches: [],
            remoteBranches: [],
            previewMode: previewModeRes.mode || 'multi',
            config,
            capacity: branchesRes.capacity,
            projectWarning,
            hasSchemafulInfra,
          };
        const applied = applyBranchListAction(base, {
          type: 'authoritativeLoaded',
          branches: branchesRes.branches || [],
          source: '分支列表刷新',
          projectBranchCount: project.branchCount,
          warning: projectWarning,
        });
        needsEmptyRecheck = needsEmptyRecheck || applied.needsEmptyRecheck;
        return {
          ...applied.state,
          project,
          // 保留之前已加载的远程分支(若有),避免主刷新时远程区闪空
          remoteBranches: prev.status === 'ok' ? prev.remoteBranches : [],
          previewMode: previewModeRes.mode || 'multi',
          config,
          capacity: branchesRes.capacity,
          projectWarning: applied.state.projectWarning || projectWarning,
          hasSchemafulInfra,
        };
      });
      if (needsEmptyRecheck) void confirmEmptyBranchList('分支列表刷新');
      if (showLoading) window.setTimeout(() => { void refreshLiveBranches(); }, 0);
    } catch (err) {
      const message = err instanceof ApiError ? err.message : String(err);
      setState({ status: 'error', message });
    }
  }, [confirmEmptyBranchList, projectId, refreshLiveBranches]);

  const refreshRemoteBranches = useCallback(async (forceFetch = false) => {
    if (!projectId) return;
    setRemoteBranchesLoading(true);
    try {
      const url = forceFetch
        ? `/api/remote-branches?project=${encodeURIComponent(projectId)}`
        : `/api/remote-branches?project=${encodeURIComponent(projectId)}&nofetch=true`;
      const res = await apiRequest<RemoteBranchesResponse & { fetched?: boolean; cachedAt?: number | null }>(url);
      const remoteDefault = res.defaultBranch || null;
      const branches = (res.branches || [])
        .map((branch) => ({ ...branch, isDefault: branch.isDefault || branch.name === remoteDefault }))
        .sort((left, right) => Number(Boolean(right.isDefault)) - Number(Boolean(left.isDefault)));
      setState((prev) => prev.status === 'ok' ? { ...prev, remoteBranches: branches } : prev);
      // Bug A 修复(2026-05-03):取消冷启动 force-fetch 兜底。
      // 历史:`if (!forceFetch && empty) → refreshRemoteBranches(true)` 让冷启动
      // 用户必走一次 git fetch(30s 超时),前端 loading 显示"加载分支与远程引用"
      // 卡到天荒地老。现在只跑 nofetch — 远程区空时 UI 露一个"刷新远程分支"按钮,
      // 用户主动点才走 force fetch。冷启动首屏对应"无缓存的远程分支区"=空状态,
      // 不再阻塞用户操作主分支。
    } catch {
      // 远程分支拉取失败不影响主区;UI 显示空数组
      setState((prev) => prev.status === 'ok' ? { ...prev, remoteBranches: [] } : prev);
    } finally {
      setRemoteBranchesLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    void refresh(true);
  }, [refresh]);

  // 主 refresh 完成后再异步拉远程分支,首次用 ?nofetch=true 走 cache
  useEffect(() => {
    void refreshRemoteBranches(false);
  }, [refreshRemoteBranches]);

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
      const raw = await apiRequest<unknown>('/api/host-stats', {
        headers: { 'X-CDS-Poll': 'true' },
      });
      const data = normalizeHostStats(raw);
      if (!data) {
        setHostStats({ status: 'error', message: '主机状态返回格式异常，已阻止页面崩溃' });
        return;
      }
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

  // 一次性拉所有项目列表给 Crumb 上的项目切换 dropdown 用。
  // 失败静默降级到"无 dropdown,但 Crumb 项目名仍能跳 /project-list"。
  useEffect(() => {
    let cancelled = false;
    void apiRequest<{ projects: ProjectSummary[] }>('/api/projects')
      .then((res) => {
        if (cancelled) return;
        setAllProjects(res.projects || []);
      })
      .catch(() => { /* 静默降级 */ });
    return () => { cancelled = true; };
  }, []);

  /*
   * Detect TODO placeholders in project env vars after a cds-compose
   * import. Without this, the user has no signal that the imported
   * compose left TENCENT_COS_BUCKET / JWT_SECRET / AI_ACCESS_KEY etc.
   * unfilled — they would only find out when a deploy fails. Pull the
   * env map once on mount + when state refreshes.
   */
  // Phase 9.6 — 缺失必填 env 检测(独立于 TODO 占位符模式)
  const [missingRequiredKeys, setMissingRequiredKeys] = useState<string[]>([]);
  useEffect(() => {
    if (!projectId) return;
    let cancelled = false;
    void apiRequest<{
      env: Record<string, string>;
      envMeta?: Record<string, { kind: string; hint?: string }>;
      missingRequiredEnvKeys?: string[];
    }>(`/api/env?scope=${encodeURIComponent(projectId)}`)
      .then((res) => {
        if (cancelled) return;
        const todoRe = /^\s*(TODO|请填写|placeholder|<.+>|FILL[ _-]?ME|change[ _-]?me)/i;
        const pending = Object.entries(res.env || {})
          .filter(([, value]) => typeof value === 'string' && todoRe.test(value))
          .map(([key]) => key);
        setPendingEnvKeys(pending);
        // Phase 9.6 — 后端直接告诉我们哪些 required 没填
        setMissingRequiredKeys(res.missingRequiredEnvKeys || []);
      })
      .catch(() => {
        if (cancelled) return;
        setPendingEnvKeys([]);
        setMissingRequiredKeys([]);
      });
    return () => {
      cancelled = true;
    };
  }, [projectId, state.status]);

  useEffect(() => {
    if (!projectId || !noticeProject) return;
    if (missingRequiredKeys.length === 0) return;
    const keys = [...missingRequiredKeys].sort();
    window.dispatchEvent(new CustomEvent('cds:notice:upsert', {
      detail: {
        id: `branch:${projectId}:missing-required:${keys.join(',')}`,
        title: '必填环境变量缺失',
        body: `${keys.length} 个必填项还没填：${keys.slice(0, 6).join(', ')}${keys.length > 6 ? ` 等 ${keys.length} 项` : ''}。deploy 会被阻止，先去项目设置补齐。`,
        tone: 'danger',
        href: projectEnvSettingsHref(projectId),
        actionLabel: '立刻填写',
        source: 'env',
        projectId,
        projectName: displayName(noticeProject),
        projectSlug: noticeProject.slug,
      },
    }));
  }, [missingRequiredKeys, noticeProject, projectId]);

  useEffect(() => {
    if (!projectId || !noticeProject) return;
    if (pendingEnvKeys.length === 0) return;
    const keys = [...pendingEnvKeys].sort();
    window.dispatchEvent(new CustomEvent('cds:notice:upsert', {
      detail: {
        id: `branch:${projectId}:pending-env:${keys.join(',')}`,
        title: '项目环境变量待补全',
        body: `${keys.length} 个变量仍是 TODO 占位：${keys.slice(0, 5).join(' · ')}${keys.length > 5 ? ` 等 ${keys.length} 项` : ''}。先填好再部署。`,
        tone: 'warning',
        href: projectEnvSettingsHref(projectId),
        actionLabel: '前往填写',
        source: 'env',
        projectId,
        projectName: displayName(noticeProject),
        projectSlug: noticeProject.slug,
      },
    }));
  }, [noticeProject, pendingEnvKeys, projectId]);

  useEffect(() => {
    if (state.status !== 'ok' || !projectId || !state.hasSchemafulInfra) return;
    window.dispatchEvent(new CustomEvent('cds:notice:upsert', {
      detail: {
        id: `branch:${projectId}:schema-init`,
        title: '数据库初始化(schema.sql)',
        body: '检测到 mysql / postgres 类基础设施。需要初始化数据库时，进入环境变量配置向导上传 schema.sql，容器首次启动会自动执行。',
        tone: 'info',
        href: projectEnvSettingsHref(projectId),
        actionLabel: '上传初始化 SQL',
        source: 'schema',
        projectId,
        projectName: displayName(state.project),
        projectSlug: state.project.slug,
      },
    }));
  }, [projectId, state]);

  // SSE 连接状态只用于故障兜底。在线状态不再渲染绿点,避免无意义状态噪音。
  const [sseConnected, setSseConnected] = useState(true);
  useEffect(() => {
    if (!projectId) return;
    const source = new EventSource(`/api/branches/stream?project=${encodeURIComponent(projectId)}`);
    source.onopen = () => setSseConnected(true);
    source.onerror = () => setSseConnected(false);
    const applySseAction = (action: BranchListAction<BranchSummary>) => {
      let needsEmptyRecheck = false;
      setState((current) => {
        if (current.status !== 'ok') return current;
        const applied = applyBranchListAction(current, action);
        needsEmptyRecheck = needsEmptyRecheck || applied.needsEmptyRecheck;
        return applied.state;
      });
      if (needsEmptyRecheck) void confirmEmptyBranchList(action.type === 'sseSnapshot' ? action.source : '实时事件');
    };
    source.addEventListener('snapshot', (ev) => {
      const data = parseSseJson<{ branches?: BranchSummary[]; projectId?: string }>(ev);
      if (!data) {
        applySseAction({ type: 'sseMalformed', source: '实时快照' });
        return;
      }
      if (data.projectId && data.projectId !== projectId) return;
      applySseAction({ type: 'sseSnapshot', branches: data.branches, source: '实时快照' });
    });
    source.addEventListener('branch.created', (ev) => {
      const data = parseSseJson<{ branch?: BranchSummary }>(ev);
      if (!data) {
        applySseAction({ type: 'sseMalformed', source: 'branch.created' });
        return;
      }
      if (!data.branch || data.branch.projectId !== projectId) return;
      applySseAction({ type: 'sseBranchUpsert', branch: data.branch, projectId });
    });
    source.addEventListener('branch.updated', (ev) => {
      const data = parseSseJson<{ branch?: BranchSummary; projectId?: string }>(ev);
      if (!data) {
        applySseAction({ type: 'sseMalformed', source: 'branch.updated' });
        return;
      }
      if (!data.branch || data.branch.projectId !== projectId) return;
      applySseAction({ type: 'sseBranchUpsert', branch: data.branch, projectId });
    });
    source.addEventListener('branch.status', (ev) => {
      const data = parseSseJson<{
        branchId?: string;
        projectId?: string;
        status?: BranchSummary['status'];
        branch?: BranchSummary;
      }>(ev);
      if (!data) {
        applySseAction({ type: 'sseMalformed', source: 'branch.status' });
        return;
      }
      if (!data.branchId || !data.status) return;
      const eventProjectId = data.branch?.projectId || data.projectId;
      if (eventProjectId !== projectId) return;
      if (data.branch) {
        applySseAction({
          type: 'sseBranchUpsert',
          branch: { ...data.branch, status: data.status },
          projectId,
        });
        return;
      }
      applySseAction({
        type: 'sseBranchPatch',
        branchId: data.branchId,
        projectId,
        patch: { status: data.status } as Partial<BranchSummary>,
      });
    });
    source.addEventListener('branch.removed', (ev) => {
      const data = parseSseJson<{ branchId?: string; projectId?: string }>(ev);
      if (!data) {
        applySseAction({ type: 'sseMalformed', source: 'branch.removed' });
        return;
      }
      if (!data.branchId) return;
      if (data.projectId !== projectId) return;
      applySseAction({ type: 'sseBranchRemove', branchId: data.branchId, projectId });
    });
    return () => source.close();
  }, [confirmEmptyBranchList, projectId]);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(''), 3200);
    return () => window.clearTimeout(timer);
  }, [toast]);

  /*
   * Close the branch search popover on outside-click. Esc handled inline
   * on the input.
   */
  useEffect(() => {
    if (!branchSearchOpen) return;
    const onClick = (event: MouseEvent) => {
      if (!branchSearchRef.current) return;
      if (!branchSearchRef.current.contains(event.target as Node)) {
        setBranchSearchOpen(false);
      }
    };
    window.addEventListener('mousedown', onClick);
    return () => window.removeEventListener('mousedown', onClick);
  }, [branchSearchOpen]);

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
  const failedDeployTargets = useMemo<FailedDeployTarget[]>(() => {
    const targets: FailedDeployTarget[] = [];
    for (const branch of branches) {
      const failedServices = Object.values(branch.services || {}).filter((service) => service.status === 'error');
      if (failedServices.length > 0) {
        for (const service of failedServices) {
          targets.push({
            branch,
            profileId: service.profileId,
            label: `${branch.branch} / ${service.profileId}`,
          });
        }
        continue;
      }
      if (branch.status === 'error') {
        targets.push({
          branch,
          label: `${branch.branch} / 全部分支服务`,
        });
      }
    }
    return targets;
  }, [branches]);
  const damagedContainerCount = useMemo(() => branches.reduce((count, branch) => (
    count + Object.values(branch.services || {}).filter((service) => (
      Boolean(service.containerName)
      && service.status !== 'running'
      && service.status !== 'building'
      && service.status !== 'starting'
      && service.status !== 'restarting'
    )).length
  ), 0), [branches]);
  // Branches displayed in the grid: favorites first, then by recent activity.
  // We no longer expose status filters or compact toggles in the list itself
  // (the search dropdown and per-card status pill cover those needs).
  const sortedBranches = useMemo(() => {
    const score = (branch: BranchSummary) => Math.max(
      Date.parse(branch.lastPushAt || '') || 0,
      Date.parse(branch.lastAccessedAt || '') || 0,
      Date.parse(branch.lastDeployAt || '') || 0,
      Date.parse(branch.createdAt || '') || 0,
    );
    // 2026-05-04 排序优先级:失败/异常 > 收藏 > 最近活跃。失败分支必须置顶,
    // 否则 14 个分支卡均权重渲染,异常分支淹没,接班场景要肉眼扫一遍。
    const isErrored = (b: BranchSummary): boolean => b.status === 'error';
    // 标签过滤:activeTagFilter 不为空时,只保留 tags 包含该标签的分支
    const filtered = activeTagFilter
      ? branches.filter((b) => (b.tags || []).includes(activeTagFilter))
      : branches;
    return filtered.slice().sort((left, right) => {
      const leftRank = branchSortRank(left.branch);
      const rightRank = branchSortRank(right.branch);
      if (leftRank !== rightRank) return leftRank - rightRank;
      if (isErrored(left) !== isErrored(right)) return isErrored(left) ? -1 : 1;
      if (!!left.isFavorite !== !!right.isFavorite) return left.isFavorite ? -1 : 1;
      return score(right) - score(left);
    });
  }, [branches, activeTagFilter]);
  // 所有已存在的标签集合(去重 + 排序),用于过滤 chip 自动消失等逻辑
  const allTags = useMemo(() => {
    const set = new Set<string>();
    branches.forEach((b) => (b.tags || []).forEach((t) => set.add(t)));
    return Array.from(set).sort();
  }, [branches]);
  // 当前过滤的标签已被全部分支删除时,自动清除过滤
  useEffect(() => {
    if (activeTagFilter && !allTags.includes(activeTagFilter)) {
      setActiveTagFilter(null);
    }
  }, [activeTagFilter, allTags]);
  const activityBranchOptions = useMemo(
    () => branches.map((branch) => ({ id: branch.id, label: branch.branch || branch.id })),
    [branches],
  );
  const deployments = useMemo<BranchDeploymentItem[]>(() => (
    Object.entries(actions)
      .reduce<BranchDeploymentItem[]>((items, [key, action]) => {
        const branch = branches.find((item) => item.id === key);
        if (!branch) return items;
        items.push({
          key,
          branchId: branch.id,
          branchName: branch.branch,
          commitSha: branch.commitSha,
          kind: action.kind,
          status: action.status,
          message: action.message,
          log: action.log,
          startedAt: action.startedAt,
          finishedAt: action.finishedAt,
          lastStep: action.lastStep,
          phase: action.phase,
          suggestion: action.suggestion,
        });
        return items;
      }, [])
      .sort((left, right) => right.startedAt - left.startedAt)
  ), [actions, branches]);

  /*
   * Service-canvas selection model. The canvas shows a single "selected" branch
   * as the right-side master view. We auto-select the most relevant branch on
   * load (running > favorite > most-recent) and keep the selection valid as
   * branches stream in / out. selectedBranchId is kept for the search
   * dropdown's "pick tracked → navigate to detail" path; the main view
   * itself is now a tile grid, not a single master view.
   */
  useEffect(() => {
    if (branches.length === 0) {
      if (selectedBranchId) setSelectedBranchId(null);
      return;
    }
    if (selectedBranchId && branches.some((branch) => branch.id === selectedBranchId)) return;
    setSelectedBranchId(branches[0].id);
  }, [branches, selectedBranchId]);

  useEffect(() => {
    if (selectedBranchIds.length === 0) return;
    const liveIds = new Set(branches.map((branch) => branch.id));
    setSelectedBranchIds((current) => current.filter((id) => liveIds.has(id)));
  }, [branches, selectedBranchIds.length]);

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

  const deployBranch = useCallback(async (
    branch: BranchSummary,
    openAfterDeploy = false,
    previewTarget?: PreviewTarget,
  ): Promise<void> => {
    const key = branch.id;
    const kind = openAfterDeploy ? 'preview' : 'deploy';
    setAction(key, createAction(kind, '正在部署'));
    setDetailDrawerBranchId(branch.id);
    try {
      await postSse(`/api/branches/${encodeURIComponent(branch.id)}/deploy`, {}, (event, data) => {
        appendActionLog(key, eventMessage(event, data));
      });
      let latestBranch: BranchSummary | undefined;
      if (projectId) {
        const latest = await apiRequest<BranchesResponse>(`/api/branches?project=${encodeURIComponent(projectId)}&live=false`);
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
        // 2026-05-07 wave 1.3:capacity 超限 → 弹交互式选择 stop 列表 + 自动重试
        if (/capacity|no space|容器.*容量|内存|memory|disk/.test(failure)) {
          const newContainerCount = Object.keys(branch.services || {}).length || 1;
          setCapacityDialog({ branch, needSlots: newContainerCount });
        }
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
  }, [appendActionLog, openRunningPreview, projectId, refresh, setAction]);

  const openPreview = useCallback(async (branch: BranchSummary, deployWhenNeeded = true): Promise<void> => {
    if (state.status !== 'ok') return;
    if (branch.status !== 'running') {
      if (!deployWhenNeeded || isBusy(branch)) {
        setToast(`${branch.branch} 还未运行`);
        return;
      }
      const target = openPreviewPlaceholder(branch.branch);
      await deployBranch(branch, true, target);
      return;
    }

    const target = openPreviewPlaceholder(branch.branch);
    await openRunningPreview(branch, target);
  }, [deployBranch, openRunningPreview, state]);

  // Phase 8.6 — 行云流水部署:从 ProjectListPage 跳转过来时,如果 sessionStorage 里
  // 有 autoDeployOnArrival 标记,自动触发主分支(优先 default branch / fallback 第一个)
  // 部署。整个 import → env 配置 → 部署链路一气呵成,用户不需要再点任何按钮。
  const autoDeployTriggeredRef = useRef(false);
  useEffect(() => {
    if (!projectId) return;
    if (state.status !== 'ok') return;
    if (autoDeployTriggeredRef.current) return;
    const flagKey = `cds:autoDeployOnArrival:${projectId}`;
    if (sessionStorage.getItem(flagKey) !== '1') return;
    sessionStorage.removeItem(flagKey);
    autoDeployTriggeredRef.current = true;
    // 选要部署的分支:default → 第一个 → 都没有就跳过(用户得先创建分支)
    const defaultBranchName = state.project?.gitDefaultBranch || state.project?.defaultBranch;
    let target: BranchSummary | undefined;
    if (defaultBranchName) {
      target = state.branches.find((b) => b.branch === defaultBranchName);
    }
    if (!target) target = state.branches[0];
    if (!target) {
      setToast('环境变量已保存。请创建分支后再部署。');
      return;
    }
    setToast(`环境变量已保存,正在自动部署 ${target.branch}...`);
    void deployBranch(target, true);
  }, [deployBranch, projectId, state]);

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
    const { refreshAfter = true } = options;
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
      setState((current) => (
        current.status === 'ok'
          ? applyBranchListAction(current, {
            type: 'sseBranchRemove',
            branchId: branch.id,
            projectId: branch.projectId,
          }).state
          : current
      ));
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

  const editTags = useCallback((branch: BranchSummary): void => {
    setBulkTagBranchId(branch.id);
    setBulkTagDraft((branch.tags || []).join(', '));
    setBulkTagError('');
  }, []);

  const submitBulkTagEdit = useCallback(async (): Promise<void> => {
    if (!bulkTagBranchId || state.status !== 'ok') return;
    const branch = state.branches.find((item) => item.id === bulkTagBranchId);
    if (!branch) {
      setBulkTagBranchId(null);
      return;
    }
    const tags = Array.from(
      new Set(
        bulkTagDraft
          .split(',')
          .map((tag) => tag.trim())
          .filter(Boolean),
      ),
    );
    if (tags.length === 0 && (branch.tags || []).length > 0) {
      setBulkTagError('将清空全部标签，请再次点击保存确认');
      if (bulkTagError !== '将清空全部标签，请再次点击保存确认') return;
    }
    await patchBranch(branch, { tags });
    setBulkTagBranchId(null);
    setBulkTagDraft('');
    setBulkTagError('');
  }, [bulkTagBranchId, bulkTagDraft, bulkTagError, patchBranch, state]);

  // 单标签 add:由卡片内浮层输入新标签 → 去重 → PATCH /api/branches/:id
  // optimistic update:UI 立即出现新 chip,失败时回滚。对齐 legacy 行为。
  const addTagToBranch = useCallback(async (branch: BranchSummary, tag: string): Promise<void> => {
    const trimmed = tag.trim();
    if (!trimmed) return;
    const oldTags = branch.tags || [];
    if (oldTags.includes(trimmed)) {
      setToast('标签已存在');
      return;
    }
    const newTags = [...oldTags, trimmed];
    // 乐观更新
    setState((current) => {
      if (current.status !== 'ok') return current;
      return {
        ...current,
        branches: current.branches.map((item) => (item.id === branch.id ? { ...item, tags: newTags } : item)),
      };
    });
    try {
      await apiRequest(`/api/branches/${encodeURIComponent(branch.id)}`, {
        method: 'PATCH',
        body: { tags: newTags },
      });
    } catch (err) {
      // 回滚
      setState((current) => {
        if (current.status !== 'ok') return current;
        return {
          ...current,
          branches: current.branches.map((item) => (item.id === branch.id ? { ...item, tags: oldTags } : item)),
        };
      });
      const message = err instanceof ApiError ? err.message : String(err);
      setToast(message);
    }
  }, []);

  // 单标签 remove:确认入口由卡片内浮层负责。这里只执行乐观更新 + PATCH。
  const removeTagFromBranch = useCallback(async (branch: BranchSummary, tag: string): Promise<void> => {
    const oldTags = branch.tags || [];
    if (!oldTags.includes(tag)) return;
    const newTags = oldTags.filter((t) => t !== tag);
    setState((current) => {
      if (current.status !== 'ok') return current;
      return {
        ...current,
        branches: current.branches.map((item) => (item.id === branch.id ? { ...item, tags: newTags } : item)),
      };
    });
    try {
      await apiRequest(`/api/branches/${encodeURIComponent(branch.id)}`, {
        method: 'PATCH',
        body: { tags: newTags },
      });
    } catch (err) {
      setState((current) => {
        if (current.status !== 'ok') return current;
        return {
          ...current,
          branches: current.branches.map((item) => (item.id === branch.id ? { ...item, tags: oldTags } : item)),
        };
      });
      const message = err instanceof ApiError ? err.message : String(err);
      setToast(message);
    }
  }, []);

  // 点击 chip → toggle 过滤(已激活同标签则清除,否则切到该标签)
  const toggleTagFilter = useCallback((tag: string): void => {
    setActiveTagFilter((current) => (current === tag ? null : tag));
  }, []);

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

  // 2026-05-07 新增「重新生成」(force-rebuild):销毁容器 + 清构建产物 + 重新构建。
  // 调 force-rebuild 端点遍历该分支所有 profile(如 api + admin),依次重建。
  // 适用场景:vite re-optimize 卡死、容器陷入异常状态但 status 没标 error、
  // 想要彻底干净的重新部署(比 pull 更激进,比 reset 更彻底)。
  const forceRebuildBranch = useCallback(async (branch: BranchSummary): Promise<void> => {
    const profileIds = Object.keys(branch.services || {});
    if (profileIds.length === 0) {
      setToast(`${branch.branch} 没有配置任何 profile,无法重新生成`);
      return;
    }
    setAction(branch.id, createAction('rebuild', `正在重新生成 (${profileIds.length} 个服务)`));
    try {
      for (const profileId of profileIds) {
        await apiRequest(
          `/api/branches/${encodeURIComponent(branch.id)}/force-rebuild/${encodeURIComponent(profileId)}`,
          { method: 'POST' },
        );
      }
      setToast(`${branch.branch} 已清理构建缓存，正在重新部署`);
      await deployBranch(branch, false);
    } catch (err) {
      const message = err instanceof ApiError ? err.message : String(err);
      setAction(branch.id, finishAction(actionRef.current[branch.id], 'rebuild', message, 'error'));
      setToast(message);
    }
  }, [deployBranch, setAction]);

  const redeployFailedContainers = useCallback(async (): Promise<void> => {
    if (redeployFailedRunning) return;
    if (failedDeployTargets.length === 0) {
      setToast('当前项目没有失败容器');
      return;
    }

    setRedeployFailedRunning(true);
    try {
      const startedAt = Date.now();
      const startedIso = new Date().toISOString();
      const total = failedDeployTargets.length;
      let successCount = 0;
      let failedCount = 0;
      const failedLabels: string[] = [];

      setToast(`开始队列重部署失败容器：${total} 个`);

      for (let index = 0; index < failedDeployTargets.length; index += 1) {
        const target = failedDeployTargets[index];
        const { branch, profileId } = target;
        const label = `${index + 1}/${total} ${target.label}`;
        let ok = true;

        setAction(branch.id, createAction('deploy', `队列重部署 ${label}`));
        try {
          const endpoint = profileId
            ? `/api/branches/${encodeURIComponent(branch.id)}/deploy/${encodeURIComponent(profileId)}`
            : `/api/branches/${encodeURIComponent(branch.id)}/deploy`;
          await postSse(endpoint, {}, (event, data) => {
            appendActionLog(branch.id, eventMessage(event, data));
            if (event === 'complete' && typeof data === 'object' && data !== null && 'ok' in data) {
              ok = Boolean((data as { ok?: unknown }).ok);
            }
            if (event === 'error') ok = false;
          });

          if (ok) {
            successCount += 1;
            setAction(branch.id, finishAction(actionRef.current[branch.id], 'deploy', `队列重部署完成 ${label}`, 'success'));
          } else {
            failedCount += 1;
            failedLabels.push(target.label);
            setAction(branch.id, finishAction(actionRef.current[branch.id], 'deploy', `队列重部署仍失败 ${label}`, 'error'));
          }
        } catch (err) {
          failedCount += 1;
          const message = err instanceof ApiError ? err.message : String(err);
          failedLabels.push(`${target.label}: ${message}`);
          setAction(branch.id, finishAction(actionRef.current[branch.id], 'deploy', message, 'error'));
        }
      }

      try {
        await refresh(false);
      } catch {
        // The queue has already run; a transient list refresh failure should not
        // prevent the completion notice from being written.
      }

      const elapsedSec = Math.round((Date.now() - startedAt) / 1000);
      const noticeTone = failedCount > 0 ? 'warning' : 'info';
      const failedText = failedLabels.length > 0
        ? `；仍失败：${failedLabels.slice(0, 5).join('、')}${failedLabels.length > 5 ? ` 等 ${failedLabels.length} 个` : ''}`
        : '';
      const noticeId = `branch:${projectId}:redeploy-failed:${startedIso}`;
      window.dispatchEvent(new CustomEvent('cds:notice:upsert', {
        detail: {
          id: noticeId,
          title: '失败容器重部署队列已完成',
          body: `共 ${total} 个，成功 ${successCount} 个，失败 ${failedCount} 个，耗时 ${elapsedSec}s${failedText}`,
          tone: noticeTone,
          href: `/branches/${encodeURIComponent(projectId)}`,
          actionLabel: '查看分支',
          source: 'ops',
        },
      }));
      setToast(`失败容器重部署完成：成功 ${successCount}/${total}${failedCount ? `，失败 ${failedCount}` : ''}`);
    } finally {
      setRedeployFailedRunning(false);
    }
  }, [appendActionLog, failedDeployTargets, projectId, redeployFailedRunning, refresh, setAction]);

  const cleanupDamagedContainers = useCallback(async (): Promise<void> => {
    if (cleanupDamagedRunning) return;
    if (damagedContainerCount === 0) {
      setToast('当前项目没有未运行的损坏容器');
      return;
    }
    setCleanupDamagedRunning(true);
    try {
      const result = await apiRequest<{ removedCount?: number; skippedRunningCount?: number }>(
        `/api/branches/cleanup-damaged-containers?project=${encodeURIComponent(projectId)}`,
        { method: 'POST' },
      );
      const removed = result.removedCount || 0;
      setToast(removed > 0
        ? `已删除 ${removed} 个未运行的损坏容器`
        : '没有可删除的损坏容器，运行中的容器已保留');
      await refresh(false);
    } catch (err) {
      const message = err instanceof ApiError ? err.message : String(err);
      setToast(message);
    } finally {
      setCleanupDamagedRunning(false);
    }
  }, [cleanupDamagedRunning, damagedContainerCount, projectId, refresh]);

  const runBulkAction = useCallback(async (
    label: string,
    branchList: BranchSummary[],
    action: (branch: BranchSummary) => Promise<void>,
  ): Promise<void> => {
    if (branchList.length === 0) {
      setToast('先选择分支');
      return;
    }
    setToast(`${label}：${branchList.length} 个分支`);
    for (const branch of branchList) {
      await action(branch);
    }
    setSelectedBranchIds([]);
    await refresh(false);
  }, [refresh]);

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
    let deleted = 0;
    for (const branch of branchList) {
      if (await deleteBranchCore(branch, { confirmFirst: false, refreshAfter: false })) deleted += 1;
    }
    setSelectedBranchIds([]);
    setToast(`已删除 ${deleted}/${branchList.length} 个分支`);
    await refresh(false);
  }, [deleteBranchCore, refresh]);

  // 搜索命中后将卡片设为稳定选中态并滚动到视口中部。选中态保留到下一次
  // 选择其它分支,比临时动画更符合"这是你刚选中的面板"的用户心智。
  const focusBranchCard = useCallback((branchId: string): void => {
    setHighlightedBranchId(branchId);
    if (highlightPulseTimerRef.current) {
      window.clearTimeout(highlightPulseTimerRef.current);
      highlightPulseTimerRef.current = null;
    }
    setHighlightPulseBranchId(null);
    requestAnimationFrame(() => {
      const el = document.querySelector<HTMLElement>(`[data-branch-card-id="${CSS.escape(branchId)}"]`);
      if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      requestAnimationFrame(() => {
        setHighlightPulseBranchId(branchId);
        highlightPulseTimerRef.current = window.setTimeout(() => {
          setHighlightPulseBranchId((current) => (current === branchId ? null : current));
          highlightPulseTimerRef.current = null;
        }, 900);
      });
    });
  }, []);

  useEffect(() => () => {
    if (highlightPulseTimerRef.current) window.clearTimeout(highlightPulseTimerRef.current);
  }, []);

  useEffect(() => {
    const onFocusBranch = (event: Event): void => {
      const detail = (event as CustomEvent<FocusBranchEventDetail>).detail || {};
      if (!detail.branchId || detail.projectId !== projectId) return;
      const branch = branches.find((item) => item.id === detail.branchId);
      if (!branch) return;
      setActiveTagFilter(null);
      focusBranchCard(branch.id);
    };
    window.addEventListener('cds:focus-branch', onFocusBranch);
    return () => window.removeEventListener('cds:focus-branch', onFocusBranch);
  }, [branches, focusBranchCard, projectId]);

  /*
   * Add a remote branch and start its deployment WITHOUT opening a
   * preview tab.
   *
   * 2026-04-29 user feedback: pre-opening "CDS is preparing the preview"
   * in a new tab before the branch is even built is a confusing UX —
   * the user just wanted to add the branch. Now we stay on the grid;
   * the new BranchCard appears with a "构建中" status and the user can
   * click 预览 on the card once it's running.
   */
  const previewRemoteBranch = useCallback(async (remote: RemoteBranch): Promise<void> => {
    if (!projectId || state.status !== 'ok') return;
    const existing = trackedByName.get(remote.name);
    if (existing) {
      // 已跟踪分支:不开新 tab、不跳详情页,本页稳定选中卡片即可。
      // 用户反馈(2026-05-07):"我不希望跳转到新页面去"——和旧版的搜索框
      // 体验对齐。要查看预览/详情走卡片上的 [预览] [详情] 按钮。
      focusBranchCard(existing.id);
      return;
    }

    setAction(remote.name, createAction('create', '正在创建分支'));
    try {
      const result = await apiRequest<{ branch: BranchSummary }>('/api/branches', {
        method: 'POST',
        body: { branch: remote.name, projectId },
      });
      setAction(remote.name, null);
      await refresh(false);
      // Pass `null` as the preview target so deployBranch doesn't try to
      // navigate to a preview URL when the deploy finishes.
      setToast(`已添加 ${remote.name}，正在后台部署`);
      // 新卡片刚出现也设为选中,引导用户视线落到新加的位置。
      focusBranchCard(result.branch.id);
      await deployBranch(result.branch, false, null);
    } catch (err) {
      const message = err instanceof ApiError ? err.message : String(err);
      setAction(remote.name, finishAction(actionRef.current[remote.name], 'create', message, 'error'));
      setToast(message);
    }
  }, [deployBranch, focusBranchCard, projectId, refresh, setAction, state, trackedByName]);

  const previewBranchByName = useCallback(async (name: string): Promise<void> => {
    const branchName = name.trim();
    if (!branchName) {
      setToast('输入分支名');
      return;
    }
    if (!projectId || state.status !== 'ok') return;
    // 命中规则:branch name(完整 / 大小写敏感)→ branch.id → commitSha 前缀。
    // 后两个让"粘贴 commit / tag"也能落到本地已部署的卡片,不至于走创建分支兜底。
    const lower = branchName.toLowerCase();
    const existing =
      trackedByName.get(branchName) ||
      branches.find((branch) => branch.id === branchName) ||
      branches.find((branch) => branch.commitSha && branch.commitSha.toLowerCase().startsWith(lower) && lower.length >= 7);
    if (existing) {
      // 用户反馈:已有分支不要跳页,本页稳定选中即可。
      setManualBranchName('');
      setBranchSearchOpen(false);
      focusBranchCard(existing.id);
      return;
    }
    setAction(branchName, createAction('create', '正在创建分支'));
    try {
      const result = await apiRequest<{ branch: BranchSummary }>('/api/branches', {
        method: 'POST',
        body: { branch: branchName, projectId },
      });
      setManualBranchName('');
      setAction(branchName, null);
      await refresh(false);
      setToast(`已添加 ${branchName}，正在后台部署`);
      // 新加的卡片刚出现,设为选中让用户视线落到它身上,不跳页。
      focusBranchCard(result.branch.id);
      await deployBranch(result.branch, false, null);
    } catch (err) {
      const message = err instanceof ApiError ? err.message : String(err);
      setAction(branchName, finishAction(actionRef.current[branchName], 'create', message, 'error'));
      setToast(message);
    }
  }, [branches, deployBranch, focusBranchCard, projectId, refresh, setAction, state, trackedByName]);

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
    for (const branch of capacityAssist.candidates) {
      await stopBranch(branch);
    }
    await refresh(false);
  }, [capacityAssist, refresh, stopBranch]);

  const drainExecutor = useCallback(async (node: ExecutorNodeSummary): Promise<void> => {
    if (!node.id) return;
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
          centerWide
          center={
            <div ref={branchSearchRef} className="relative w-full">
              <form
                className="flex min-w-0 items-center gap-1.5"
                onSubmit={(event) => {
                  event.preventDefault();
                  if (manualBranchName.trim()) {
                    setBranchSearchOpen(false);
                    void previewBranchByName(manualBranchName);
                  }
                }}
              >
                <div className="flex h-9 min-w-0 flex-1 items-center gap-2 rounded-md border border-[hsl(var(--hairline))] bg-[hsl(var(--surface-sunken))] px-3">
                  <Search className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                  <input
                    value={manualBranchName}
                    onChange={(event) => {
                      setManualBranchName(event.target.value);
                      if (!branchSearchOpen) setBranchSearchOpen(true);
                    }}
                    onFocus={() => setBranchSearchOpen(true)}
                    onKeyDown={(event) => {
                      if (event.key === 'Escape') setBranchSearchOpen(false);
                    }}
                    className="h-full min-w-0 flex-1 border-0 bg-transparent font-mono text-xs outline-none placeholder:text-muted-foreground focus-visible:ring-0"
                    placeholder="搜索分支 · 粘贴 commit / tag · 回车预览"
                    autoComplete="off"
                    spellCheck={false}
                  />
                </div>
                <Button type="submit" size="sm" disabled={!manualBranchName.trim()}>
                  <ExternalLink />
                  预览
                </Button>
              </form>
              {branchSearchOpen ? (
                <BranchSearchDropdown
                  query={manualBranchName}
                  tracked={branches}
                  remote={remoteBranches}
                  remoteLoading={remoteBranchesLoading}
                  trackedByName={trackedByName}
                  actions={actions}
                  onPickTracked={(branch) => {
                    // 用户反馈(2026-05-07):点已跟踪的下拉条目不要跳详情页,
                    // 在本页选中卡片即可。要查看详情走卡片
                    // 上的「详情」按钮。
                    setBranchSearchOpen(false);
                    setManualBranchName('');
                    setSelectedBranchId(branch.id);
                    focusBranchCard(branch.id);
                  }}
                  onPickRemote={(remote) => {
                    setBranchSearchOpen(false);
                    setManualBranchName('');
                    void previewRemoteBranch(remote);
                  }}
                  onForceFetchRemote={() => void refreshRemoteBranches(true)}
                />
              ) : null}
            </div>
          }
          left={
            <>
              <Crumb
                items={[
                  { label: 'CDS', href: '/project-list' },
                  {
                    label: title,
                    href: `/branches/${encodeURIComponent(projectId)}`,
                    // 项目切换 dropdown(Round 4d):列出最近其它项目,1 步切换;
                    // 比之前"返回项目列表 → 找项目 → 进分支页"3 步短得多
                    dropdown: allProjects.length > 1 ? (
                      <ProjectSwitcher
                        currentProjectId={projectId}
                        projects={allProjects}
                      />
                    ) : null,
                  },
                  { label: '分支' },
                ]}
              />
              {/* 用户反馈(2026-05-07):左上角 "8 分支 · 8 运行 · 8/186 容器"
                  这种概览数字没有必要,占位且分散注意力,删除。容量数据仍可
                  在拓扑视图 / 项目设置看到。 */}
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
                variant={failedDeployTargets.length > 0 ? 'outline' : 'ghost'}
                size="sm"
                onClick={() => void redeployFailedContainers()}
                disabled={redeployFailedRunning || failedDeployTargets.length === 0}
                title={failedDeployTargets.length > 0 ? `按队列重新部署 ${failedDeployTargets.length} 个失败目标` : '当前没有失败目标'}
              >
                {redeployFailedRunning ? <Loader2 className="animate-spin" /> : <RotateCw />}
                一键重部署{failedDeployTargets.length > 0 ? ` ${failedDeployTargets.length}` : ''}
              </Button>
              <Button
                variant={damagedContainerCount > 0 ? 'outline' : 'ghost'}
                size="sm"
                onClick={() => void cleanupDamagedContainers()}
                disabled={cleanupDamagedRunning || damagedContainerCount === 0}
                title={damagedContainerCount > 0 ? `删除 ${damagedContainerCount} 个未运行的损坏容器；不会删除分支或工作区` : '当前没有未运行的损坏容器'}
              >
                {cleanupDamagedRunning ? <Loader2 className="animate-spin" /> : <Trash2 />}
                清理损坏{damagedContainerCount > 0 ? ` ${damagedContainerCount}` : ''}
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
              {!sseConnected ? (
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={() => void refresh(false, true)}
                  aria-label="重新拉取(SSE 已中断)"
                  title="实时连接中断,点击手动刷新"
                  className="text-amber-500 hover:text-amber-600"
                >
                  <RefreshCw />
                </Button>
              ) : null}
            </>
          }
        />
      }
    >
      <Workspace wide>
        {/* Hero: search-or-paste branch with autocomplete dropdown — replaces
            the old left "tracked / remote" two-list panel which the user
            said wasn't useful. Daily flow: focus the input, see all branches,
            type a few characters, click a row OR press Enter to preview. */}
        {state.status === 'loading' ? (
          <div className="mt-6">
            {/* Bug A:loading 文案不再说"远程引用",避免误导用户以为还在 git fetch。
                远程分支区独立 lazy load,主区只等 4 个轻 API。 */}
            <LoadingBlock label="加载项目与本地分支列表" />
          </div>
        ) : null}
        {state.status === 'error' ? (
          <div className="mt-6">
            <ErrorBlock message={state.message} />
          </div>
        ) : null}

        {state.status === 'ok' && state.projectWarning ? (
          <div className="mt-6 rounded-md border border-amber-500/35 bg-amber-500/10 px-4 py-3 text-sm text-amber-700 dark:text-amber-300">
            {state.projectWarning}
          </div>
        ) : null}

        {state.status === 'ok' && state.project.cloneStatus && state.project.cloneStatus !== 'ready' ? (
          <div className="mt-6 rounded-md border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-sm text-amber-700 dark:text-amber-400">
            当前项目仓库状态为 {state.project.cloneStatus}，克隆完成前不能创建或部署分支。
            {state.project.cloneError ? <span className="ml-2">{state.project.cloneError}</span> : null}
          </div>
        ) : null}

        {/* Branch tile grid — built user mental model: cards in a 3-up
            grid, each with [预览] [部署] [详情] inline + kebab menu for low-frequency
            actions (拉取 / 停止 / 收藏 / 调试 / 标签 / 重置 / 删除). */}
        {state.status === 'ok' ? (
          <div className="mt-6">
            {/* 标签过滤栏:仅在有激活过滤时出现。点 × 清除过滤,恢复显示全部分支。
                还原 legacy app.js:2778-2792 的 renderTagFilterBar 行为,但改为
                只在 active 时显示一行简单 chip(单标签过滤,不做 multi-select)。 */}
            {/* 2026-05-07 wave 2.4:Tag filter bar — 列出所有 tags 横排,
                点击 chip 切换过滤;再次点击清除。激活的 tag chip 高亮。 */}
            {allTags.length > 0 ? (
              <div className="mb-4 flex flex-wrap items-center gap-2">
                <span className="text-xs text-muted-foreground">标签:</span>
                {allTags.map((tag) => {
                  const active = activeTagFilter === tag;
                  return (
                    <button
                      key={tag}
                      type="button"
                      onClick={() => setActiveTagFilter(active ? null : tag)}
                      className={`inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-xs transition-colors ${
                        active
                          ? 'border-primary/40 bg-primary/10 text-primary hover:bg-primary/20'
                          : 'border-border bg-card text-muted-foreground hover:border-primary/40 hover:text-foreground'
                      }`}
                      title={active ? '清除过滤' : `按 #${tag} 过滤`}
                    >
                      <Tags className="h-3 w-3" />
                      <span>#{tag}</span>
                      {active ? <X className="h-3 w-3" /> : null}
                    </button>
                  );
                })}
                {activeTagFilter ? (
                  <span className="text-xs text-muted-foreground">
                    共 {sortedBranches.length} 个分支
                  </span>
                ) : null}
              </div>
            ) : null}
            {branches.length === 0 ? (
              <div className="cds-surface-raised cds-hairline px-8 py-16">
                <div className="mx-auto flex max-w-md flex-col items-center text-center">
                  <div className="flex h-14 w-14 items-center justify-center rounded-full bg-primary/10 text-primary">
                    <GitBranch className="h-6 w-6" />
                  </div>
                  <h2 className="mt-5 text-lg font-semibold">还没有分支</h2>
                  <p className="mt-2 max-w-sm text-sm leading-6 text-muted-foreground">
                    在顶部搜索框粘贴远程分支名，或在下拉中选择已有远程分支，CDS 会自动创建工作树并打开预览。
                  </p>
                </div>
              </div>
            ) : (
              <div className="grid gap-4 sm:grid-cols-2 2xl:grid-cols-3">
                {sortedBranches.map((branch) => (
                  <BranchCard
                    key={branch.id}
                    branch={branch}
                    action={actions[branch.id]}
                    now={actionClock}
                    projectId={projectId}
                    highlighted={highlightedBranchId === branch.id}
                    highlightPulse={highlightPulseBranchId === branch.id}
                    activityEvents={activityEvents
                      .filter((event) => event.source === 'ai' && activityBranchMatches(event, branch.id))
                      .slice(0, 5)}
                    capacityWarning={state.status === 'ok' ? capacityMessage(state.capacity, [branch]) : ''}
                    activeTagFilter={activeTagFilter}
                    onPreview={() => void openPreview(branch, true)}
                    onDeploy={() => void deployBranch(branch, false)}
                    onDetail={() => setDetailDrawerBranchId(branch.id)}
                    onPull={() => void pullBranch(branch)}
                    onStop={() => void stopBranch(branch)}
                    onForceRebuild={() => void forceRebuildBranch(branch)}
                    onToggleFavorite={() => void patchBranch(branch, { isFavorite: !branch.isFavorite })}
                    onToggleDebug={() => void patchBranch(branch, { isColorMarked: !branch.isColorMarked })}
                    onReset={() => void resetBranch(branch)}
                    onDelete={() => void deleteBranch(branch)}
                    onEditTags={() => void editTags(branch)}
                    onAddTag={(tag) => void addTagToBranch(branch, tag)}
                    onRemoveTag={(tag) => void removeTagFromBranch(branch, tag)}
                    onClickTag={toggleTagFilter}
                  />
                ))}
              </div>
            )}
          </div>
        ) : null}

        {/* Ops drawer — slide-in panel for capacity / hosts / executors /
            batch / activity. Triggered by the "运维" button in the topbar. */}
        {/* Branch detail drawer — opens when 详情 is clicked on a card.
            Avoids the page navigation the user explicitly asked us to skip
            ("能在一个页面完成的，切勿跳转页面"). */}
        <BranchDetailDrawer
          open={!!detailDrawerBranchId}
          branchId={detailDrawerBranchId}
          projectId={projectId}
          deployments={deployments}
          activityEvents={activityEvents}
          now={actionClock}
          previewUrl={(() => {
            // Compute preview URL once at the call site so the Drawer
            // doesn't need to load /api/config separately. running 时
            // 直接给 Drawer 顶部展示 URL chip(Week 4.8 Round 4b)。
            if (state.status !== 'ok' || !detailDrawerBranchId) return '';
            const target = state.branches.find((b) => b.id === detailDrawerBranchId);
            if (!target) return '';
            if (state.previewMode === 'simple') return simplePreviewUrl(state.config);
            return multiPreviewUrl(target, state.config);
          })()}
          branchStatus={(() => {
            if (state.status !== 'ok' || !detailDrawerBranchId) return undefined;
            const target = state.branches.find((b) => b.id === detailDrawerBranchId);
            return target?.status;
          })()}
          onClose={() => setDetailDrawerBranchId(null)}
          onToast={setToast}
          onActionComplete={() => void refresh()}
        />

        {state.status === 'ok' ? (
          <OpsDrawer open={opsDrawerOpen} onClose={() => setOpsDrawerOpen(false)}>
              

              {/* 2026-05-07 wave 1.1 v2 (用户反馈"还是灰色不响应"):彻底放弃
                  toggle 折叠 — 抽屉就是为了展示运维内容,折叠头多一步交互纯属
                  反人类。直接展示标题 + 内容,无任何 click handler,杜绝灰色
                  发呆。用户反馈"打开就一片灰"很可能是 useState toggle 路径上
                  某种 race condition,直接删掉。 */}
              {/* 2026-05-07:孤儿容器清理 — 用户反馈"删除分支后过时容器还在面板上,
                  不知怎么清"。后端 POST /api/cleanup-orphans 已存在,加 UI 入口。
                  扫描 origin remote → 找出本地有但远端已删的分支 entry → 停容器 + 删 entry。 */}
              <div className="overflow-hidden cds-surface-raised cds-hairline">
                <div className="flex w-full flex-wrap items-center justify-between gap-3 px-3 py-3 text-sm">
                  <span className="inline-flex items-center gap-2 font-semibold">
                    <Gauge className="h-4 w-4 text-muted-foreground" />
                    运维与日志
                  </span>
                  <div className="flex flex-wrap items-center gap-2">
                    <ConfirmAction
                      title="清理孤儿容器?"
                      description={`扫描 origin 远端,把本地有但远端已删除的分支 worktree + 容器 + entry 全部清掉(已勾选项目 ${projectId} 范围)。停止过的服务可恢复(重新部署),但 worktree 删了 git 历史不动。`}
                      confirmLabel="开始清理"
                      onConfirm={async () => {
                        try {
                          let lastMsg = '清理完成';
                          await postSse(`/api/cleanup-orphans?project=${encodeURIComponent(projectId)}`, {}, (event, data) => {
                            if (event === 'complete' && data && typeof data === 'object') {
                              const d = data as { message?: string; orphanCount?: number };
                              lastMsg = d.message || `清理完成,共处理 ${d.orphanCount || 0} 个孤儿`;
                            }
                          });
                          setToast(lastMsg);
                          await refresh(false);
                        } catch (e) {
                          setToast(`清理失败: ${(e as Error).message}`);
                        }
                      }}
                      trigger={(
                        <Button type="button" variant="outline" size="sm">
                          <Trash2 />
                          清理孤儿
                        </Button>
                      )}
                    />
                    <span className="text-xs text-muted-foreground">容量 / 主机 / 执行器 / 活动</span>
                  </div>
                </div>
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
                      <span>{selectedCapacityWarning} 点击部署时会在按钮旁确认。</span>
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
                    <ConfirmAction
                      title="停止较旧分支腾容量？"
                      description={`将停止 ${capacityAssist.candidates.length} 个较旧运行分支，预计腾出 ${capacityAssist.freed} 个容量槽。`}
                      confirmLabel="停止"
                      disabled={capacityAssist.candidates.length === 0}
                      onConfirm={() => void stopOldBranchesForCapacity()}
                      trigger={(
                        <Button type="button" size="sm" variant="outline">
                          <PowerOff />
                          腾容量
                        </Button>
                      )}
                    />
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
                  {selectedCapacityWarning ? (
                    <ConfirmAction
                      title="容量不足，仍然批量部署？"
                      description={selectedCapacityWarning}
                      confirmLabel="继续部署"
                      disabled={selectedBranches.length === 0}
                      onConfirm={() => void runBulkAction('批量部署', selectedBranches, (branch) => deployBranch(branch, false))}
                      trigger={(
                        <Button variant="outline" size="sm">
                          <Play />
                          部署
                        </Button>
                      )}
                    />
                  ) : (
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={selectedBranches.length === 0}
                      onClick={() => void runBulkAction('批量部署', selectedBranches, (branch) => deployBranch(branch, false))}
                    >
                      <Play />
                      部署
                    </Button>
                  )}
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
                  <ConfirmAction
                    title={`删除 ${selectedBranches.length} 个分支？`}
                    description="会停止服务并删除对应工作区。"
                    confirmLabel="删除"
                    disabled={selectedBranches.length === 0}
                    onConfirm={() => void bulkDeleteBranches(selectedBranches)}
                    trigger={(
                      <Button variant="destructive" size="sm">
                        <Trash2 />
                        删除
                      </Button>
                    )}
                  />
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
                        {selectedActivity.requestId ? <CodePill>requestId {selectedActivity.requestId}</CodePill> : null}
                        {selectedActivity.branchId ? (
                          <CodePill>{selectedActivity.branchTags?.[0] || selectedActivity.branchId}</CodePill>
                        ) : null}
                        {selectedActivity.profileId ? <CodePill>{selectedActivity.profileId}</CodePill> : null}
                      </div>
                      {selectedActivity.errorSummary ? (
                        <div className="grid gap-1">
                          <span className="font-medium text-foreground">错误摘要</span>
                          <code className="max-h-28 overflow-auto whitespace-pre-wrap break-words rounded bg-destructive/10 px-2 py-1 font-mono text-destructive">
                            {selectedActivity.errorSummary}
                          </code>
                        </div>
                      ) : null}
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
              </div>


          </OpsDrawer>
        ) : null}

        {/* 2026-05-07 wave 1.3:容量超限交互式选择停哪些分支 + 自动重试 */}
        {capacityDialog && state.status === 'ok' ? (
          <CapacityFullDialog
            open={true}
            onClose={() => setCapacityDialog(null)}
            selfBranchId={capacityDialog.branch.id}
            selfBranchName={capacityDialog.branch.branch}
            capacity={state.capacity ? {
              runningContainers: state.capacity.runningContainers,
              maxContainers: state.capacity.maxContainers,
            } : undefined}
            needSlots={capacityDialog.needSlots}
            candidates={branches
              .filter((b) => b.id !== capacityDialog.branch.id && b.status === 'running')
              .map((b) => ({
                id: b.id,
                branch: b.branch,
                serviceCount: Object.keys(b.services || {}).length,
                isPinned: !!b.isFavorite,
              }))}
            onConfirm={async (idsToStop) => {
              for (const id of idsToStop) {
                const target = branches.find((b) => b.id === id);
                if (target) await stopBranch(target);
              }
              await refresh(false);
              await deployBranch(capacityDialog.branch, false);
            }}
          />
        ) : null}

        {bulkTagBranchId && state.status === 'ok' ? (() => {
          const target = state.branches.find((branch) => branch.id === bulkTagBranchId);
          if (!target) return null;
          return (
            <Dialog open={true} onOpenChange={(open) => {
              if (!open) {
                setBulkTagBranchId(null);
                setBulkTagDraft('');
                setBulkTagError('');
              }
            }}>
              <DialogContent>
                <DialogHeader>
                  <DialogTitle>编辑标签</DialogTitle>
                  <DialogDescription>
                    分支 <span className="font-mono text-foreground">{target.branch}</span>，多个标签用逗号分隔。
                  </DialogDescription>
                </DialogHeader>
                <div className="grid gap-2">
                  <label className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
                    <Tags className="h-3.5 w-3.5" aria-hidden />
                    标签
                  </label>
                  <textarea
                    value={bulkTagDraft}
                    onChange={(event) => {
                      setBulkTagDraft(event.target.value);
                      if (bulkTagError) setBulkTagError('');
                    }}
                    className="min-h-24 rounded-md border border-[hsl(var(--hairline))] bg-[hsl(var(--surface-sunken))] px-3 py-2 text-sm outline-none transition-colors placeholder:text-muted-foreground/60 focus:border-primary/55 focus:ring-2 focus:ring-primary/20"
                    placeholder="例如: 周报Agent, 毒舌秘书"
                    autoFocus
                  />
                  {bulkTagError ? <div className="text-xs text-destructive">{bulkTagError}</div> : null}
                </div>
                <DialogFooter>
                  <Button
                    type="button"
                    variant="ghost"
                    onClick={() => {
                      setBulkTagBranchId(null);
                      setBulkTagDraft('');
                      setBulkTagError('');
                    }}
                  >
                    取消
                  </Button>
                  <Button type="button" onClick={() => void submitBulkTagEdit()}>
                    保存
                  </Button>
                </DialogFooter>
              </DialogContent>
            </Dialog>
          );
        })() : null}

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
 * BranchSearchDropdown — popover under the hero search input, listing
 * matching tracked + remote branches. Replaces the old left "分支 / 远程"
 * column the user said was useless.
 *
 * Pick rules:
 *   - Tracked row → set as selectedBranch (master view updates).
 *   - Remote row  → preview / deploy via remote create flow.
 */
/**
 * ProjectSwitcher — Crumb 上挂的项目切换器(Week 4.8 Round 4d)。
 * 用户:"多项目切换路径长,5 步" → 这里收敛到 1 次点击。
 *
 * 设计:
 *   - 触发器是一个细小的 ChevronDown,贴在项目名后面,不喧宾夺主
 *   - 列出最近 8 个项目;超过 8 个有"查看全部"链接到 /project-list
 *   - 当前项目高亮但不可点;其它项目点击 → /branches/<id> 直跳
 *   - 失败静默降级:Crumb 上根本不渲染这个 trigger(allProjects.length <= 1)
 */
function ProjectSwitcher({
  currentProjectId,
  projects,
}: {
  currentProjectId: string;
  projects: ProjectSummary[];
}): JSX.Element {
  // 把当前项目排第一,其它按字母序;最多展示 8 个,有更多就给"查看全部"
  const ordered = useMemo(() => {
    const current = projects.find((p) => p.id === currentProjectId);
    const rest = projects
      .filter((p) => p.id !== currentProjectId)
      .sort((a, b) => displayName(a).localeCompare(displayName(b), 'zh-Hans-CN'));
    const all = current ? [current, ...rest] : rest;
    return all.slice(0, 8);
  }, [projects, currentProjectId]);
  const hasMore = projects.length > ordered.length;

  return (
    <DropdownMenu
      align="start"
      width={360}
      trigger={
        <button
          type="button"
          className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-muted/40 hover:text-foreground"
          title="切换项目"
          aria-label="切换项目"
        >
          <ChevronDown className="h-3.5 w-3.5" />
        </button>
      }
    >
      <DropdownLabel>切换项目</DropdownLabel>
      {ordered.map((p) => {
        const isCurrent = p.id === currentProjectId;
        const meta = projectSwitcherMeta(p);
        return (
          <DropdownItem
            key={p.id}
            disabled={isCurrent}
            onSelect={() => {
              window.location.href = `/branches/${encodeURIComponent(p.id)}`;
            }}
          >
            <span className="flex w-full items-start gap-2">
              <span
                className={`mt-2 h-1.5 w-1.5 rounded-full ${isCurrent ? 'bg-emerald-500' : 'bg-muted-foreground/40'}`}
                aria-hidden
              />
              <span className="min-w-0 flex-1">
                <span className="block truncate font-medium">{displayName(p)}</span>
                {meta ? (
                  <span className="mt-0.5 block truncate font-mono text-[11px] text-muted-foreground">
                    {meta}
                  </span>
                ) : null}
              </span>
              {isCurrent ? <span className="mt-0.5 shrink-0 text-[10px] text-muted-foreground">当前</span> : null}
            </span>
          </DropdownItem>
        );
      })}
      {hasMore ? (
        <>
          <DropdownDivider />
          <DropdownItem onSelect={() => { window.location.href = '/project-list'; }}>
            查看全部项目 →
          </DropdownItem>
        </>
      ) : null}
    </DropdownMenu>
  );
}

function BranchSearchDropdown({
  query,
  tracked,
  remote,
  remoteLoading,
  trackedByName,
  actions,
  onPickTracked,
  onPickRemote,
  onForceFetchRemote,
}: {
  query: string;
  tracked: BranchSummary[];
  remote: RemoteBranch[];
  remoteLoading: boolean;
  trackedByName: Map<string, BranchSummary>;
  actions: Record<string, BranchAction>;
  onPickTracked: (branch: BranchSummary) => void;
  onPickRemote: (remote: RemoteBranch) => void;
  onForceFetchRemote: () => void;
}): JSX.Element {
  const trimmed = query.trim().toLowerCase();
  const matches = (text: string) => !trimmed || text.toLowerCase().includes(trimmed);

  const visibleTracked = tracked
    .filter((branch) => matches(branch.branch) || matches(branch.commitSha || '') || (branch.tags || []).some(matches))
    .slice(0, 12);
  const visibleRemote = remote.filter((row) => !trackedByName.get(row.name) && matches(row.name)).slice(0, 12);

  const empty = visibleTracked.length === 0 && visibleRemote.length === 0;

  return (
    <div
      className="cds-overlay-anim absolute left-0 right-0 top-full z-30 mt-2 max-h-[460px] overflow-hidden rounded-md border border-[hsl(var(--hairline))] bg-[hsl(var(--surface-raised))] shadow-2xl"
      role="listbox"
      aria-label="分支建议"
    >
      <div className="max-h-[420px] overflow-y-auto py-1">
        {empty ? (
          <div className="px-4 py-6 text-center text-sm text-muted-foreground">
            没有匹配的分支。按 Enter 直接尝试以「{query.trim() || '...'}」预览。
          </div>
        ) : null}

        {visibleTracked.length > 0 ? (
          <>
            <div className="px-4 pt-2 pb-1 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground/80">
              已跟踪 · {visibleTracked.length}
            </div>
            {visibleTracked.map((branch) => {
              const action = actions[branch.id];
              const busy = action?.status === 'running' || isBusy(branch);
              const timeBadge = branchTimeBadge(branch);
              return (
                <button
                  key={branch.id}
                  type="button"
                  onClick={() => onPickTracked(branch)}
                  className="flex w-full items-center gap-3 px-4 py-2.5 text-left transition-colors hover:bg-[hsl(var(--surface-sunken))]"
                >
                  <span
                    className={`h-2 w-2 shrink-0 rounded-full ${statusRailClass(branch.status)}`}
                    aria-hidden
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium">{branch.branch}</span>
                    <span className="block truncate text-[11px] text-muted-foreground">
                      {statusLabel(branch.status)} · 服务 {runningServiceCount(branch)}/{serviceCount(branch)} · {timeBadge.label} {timeBadge.text}
                    </span>
                  </span>
                  {busy ? <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-muted-foreground" /> : null}
                  {branch.isFavorite ? <Star className="h-3 w-3 shrink-0 fill-current text-amber-500" /> : null}
                </button>
              );
            })}
          </>
        ) : null}

        {remoteLoading && visibleRemote.length === 0 ? (
          <div className="px-4 py-3 text-[11px] text-muted-foreground/80">
            <Loader2 className="mr-1.5 inline h-3 w-3 animate-spin" />
            远程分支加载中…
          </div>
        ) : null}

        {/* Bug A:取消自动 force-fetch 兜底后,空 remote 时给个手动触发入口。
            5 分钟内点了 force-fetch 后端会真跑 git fetch(可能 30s)。
            Bugbot fix(2026-05-04):去掉 `tracked.length === 0` 限制 — 之前
            有任何本地分支 hint 就消失,用户无法发现新远程分支。footer 里的
            「刷新远程」永久按钮兜底 hint 可见性,这里只在空 remote 时给醒目提示。 */}
        {!remoteLoading && visibleRemote.length === 0 ? (
          <div className="flex items-center justify-between gap-2 border-t border-[hsl(var(--hairline))] px-4 py-2.5 text-[11px] text-muted-foreground">
            <span>远程分支缓存为空。</span>
            <button
              type="button"
              onClick={onForceFetchRemote}
              className="rounded px-2 py-1 text-[11px] font-medium text-foreground hover:bg-[hsl(var(--surface-sunken))]"
            >
              <RefreshCw className="mr-1 inline h-3 w-3" />
              拉取远程(可能 ~10s)
            </button>
          </div>
        ) : null}

        {visibleRemote.length > 0 ? (
          <>
            <div className="flex items-center gap-2 px-4 pb-1 pt-3 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground/80">
              <span>远程 · {visibleRemote.length}</span>
              {remoteLoading ? <Loader2 className="h-3 w-3 animate-spin" /> : null}
            </div>
            {visibleRemote.map((remoteBranch) => {
              const action = actions[remoteBranch.name];
              return (
                <button
                  key={remoteBranch.name}
                  type="button"
                  onClick={() => onPickRemote(remoteBranch)}
                  disabled={!!action}
                  className="flex w-full items-center gap-3 px-4 py-2.5 text-left transition-colors hover:bg-[hsl(var(--surface-sunken))] disabled:opacity-60"
                >
                  <Plus className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                  <span className="min-w-0 flex-1">
                    <span className="flex min-w-0 items-center gap-2">
                      <span className="truncate text-sm font-medium">{remoteBranch.name}</span>
                      {remoteBranch.isDefault ? (
                        <span className="shrink-0 rounded border border-sky-500/35 bg-sky-500/10 px-1.5 py-0.5 text-[10px] text-sky-700 dark:text-sky-300">
                          默认分支
                        </span>
                      ) : null}
                    </span>
                    <span className="block truncate text-[11px] text-muted-foreground">
                      {remoteBranch.subject || remoteBranch.author || '部署并预览'}
                    </span>
                  </span>
                  {action ? <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-muted-foreground" /> : null}
                </button>
              );
            })}
          </>
        ) : null}
      </div>
      <div className="flex items-center justify-between gap-3 border-t border-[hsl(var(--hairline))] bg-[hsl(var(--surface-sunken))]/50 px-4 py-2 text-[11px] text-muted-foreground">
        <span>↑↓ 浏览 · Enter 预览 · Esc 关闭</span>
        <div className="flex items-center gap-2">
          <span>{visibleTracked.length + visibleRemote.length} 项</span>
          {/* Bugbot fix(2026-05-04):永久暴露"刷新远程"入口,
              不再依赖空状态 hint。即使 tracked/remote 都有,缓存可能仍 stale。 */}
          <button
            type="button"
            onClick={onForceFetchRemote}
            disabled={remoteLoading}
            title="重新拉取 origin 远程分支(可能 ~10s)"
            className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] hover:bg-[hsl(var(--surface-raised))] disabled:opacity-50"
          >
            {remoteLoading ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : (
              <RefreshCw className="h-3 w-3" />
            )}
            刷新远程
          </button>
        </div>
      </div>
    </div>
  );
}

/*
 * OpsDrawer — right-side slide-in sidebar (NOT a modal) hosting low-frequency
 * operations (capacity / hosts / executors / batch / activity). Triggered by
 * the topbar "运维" button.
 *
 * 2026-05-10 重大修法:用户反复反馈"打开运维栏后 BG 按钮点不动"。根因是之前
 * 实现把抽屉做成 modal(role=dialog aria-modal=true + 全屏 black/40 overlay
 * + body.overflow=hidden),用户期望「侧栏开着仍能继续点 BG」,正确做法是
 * "non-modal sidebar":去掉 overlay、去掉 modal 语义、去掉 body 滚动锁定。
 *
 * 关闭方式保留:ESC 键 + header 的 X 按钮。
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
    // eslint-disable-next-line no-console
    console.log('[OpsDrawer] open at', new Date().toISOString());
    return () => {
      window.removeEventListener('keydown', onKey);
      // eslint-disable-next-line no-console
      console.log('[OpsDrawer] close at', new Date().toISOString());
    };
  }, [open, onClose]);

  if (!open) return null;

  // 关键差异 vs 旧版本:
  // - 不再外层包 fixed inset-0 flex(那个会撑满全屏,即使透明也夺走指针事件)
  // - 不再有 black/40 overlay 全屏 button(那个是真正挡 BG 的元凶)
  // - role=complementary 而非 dialog;移除 aria-modal(用户期望非模态)
  // - 不再 body.overflow=hidden(BG 仍可正常滚动)
  // 抽屉本体直接 fixed 在右侧,只占 460px,左侧 BG 全部仍可交互。
  return (
    <div
      className="cds-drawer-anim fixed top-0 right-0 bottom-0 z-50 flex h-screen w-full max-w-[460px] flex-col border-l border-[hsl(var(--hairline))] bg-[hsl(var(--surface-base))] shadow-2xl"
      role="complementary"
      aria-label="运维抽屉"
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
  );
}

function BranchCard({
  branch,
  action,
  now,
  capacityWarning,
  highlighted,
  highlightPulse,
  activityEvents = [],
  activeTagFilter,
  onPreview,
  // 2026-05-04 重设计:部署按钮从卡片右下移到「分支详情抽屉 → 设置 tab」。
  // onDeploy prop 保留是为了不打断父组件 ProjectListPage / 上层 BranchListPage
  // 的现有 wiring(它们仍会 pass 这个回调)。卡片本身不再使用。
  onDeploy: _onDeploy,
  onDetail,
  onPull,
  onStop,
  onForceRebuild,
  onToggleFavorite,
  onToggleDebug,
  onReset,
  onDelete,
  onEditTags,
  onAddTag,
  onRemoveTag,
  onClickTag,
}: {
  branch: BranchSummary;
  action?: BranchAction;
  now: number;
  capacityWarning?: string;
  activityEvents?: ActivityEvent[];
  // projectId is reserved for future inline modes; the call site already
  // passes it but BranchCard currently derives all routing data from
  // `branch.projectId`. Keeping the prop optional to avoid a churn of
  // callers when we later need it (e.g. cross-project routing tests).
  projectId?: string;
  selected?: boolean;
  // 搜索框命中"已粘贴的分支名/SHA"时,父组件 set 这个 prop = true,触发
  // 稳定选中态 + 自动滚到可视区。详见 focusBranchCard / index.css。
  highlighted?: boolean;
  highlightPulse?: boolean;
  // 当前激活的标签过滤(给 chip 高亮显示用)
  activeTagFilter?: string | null;
  onSelect?: () => void;
  onPreview: () => void;
  onDeploy: () => void;
  onDetail: () => void;
  onPull: () => void;
  onStop: () => void;
  onForceRebuild: () => void;
  onToggleFavorite: () => void;
  onToggleDebug: () => void;
  onReset: () => void;
  onDelete: () => void;
  onEditTags: () => void;
  // 单条标签操作(还原 legacy 卡片上的 chips + ×/+ 按钮)
  onAddTag?: (tag: string) => void | Promise<void>;
  onRemoveTag?: (tag: string) => void | Promise<void>;
  onClickTag?: (tag: string) => void;
}): JSX.Element {
  /*
   * BranchTile — compact card sized for a 3-up grid (~360px wide). Mirrors
   * the legacy mental model: primary actions [预览] [部署] [详情] inline at
   * the bottom; low-frequency actions live in a kebab dropdown.
   */
  const busy = action?.status === 'running' || isBusy(branch);
  const runningCount = runningServiceCount(branch);
  const services = Object.values(branch.services || {});
  // 用户反馈(2026-05-04):"+1 显得很多余,明明都可以显示" — 不再 slice(0,1) +
  // hiddenCount,所有有 hostPort 的 service 全部 inline 显示。卡片自动 wrap。
  const portChips = services.filter((service) => service.hostPort);
  const previewCapacityWarning = branch.status === 'running' ? '' : capacityWarning;

  // 新设计(2026-05-04 用户主诉求):
  //   1. 预览才是重点色(primary 橙) — running 态显示 Eye,主动作
  //   2. 部署不再放在卡片右下 — 走"打开抽屉 → 设置 tab → 重新部署"
  //      避免用户误点(部署=有副作用,需要确认上下文)
  //   3. 未运行/已停止 → 整卡 opacity-60 暗示,不再单独显示"未运行"chip
  //   4. 异常态保留 chip(因为是负面信号,需要醒目)
  const isRunning = branch.status === 'running';
  const isError = branch.status === 'error';
  const isInterim = busy || ['building', 'starting', 'stopping', 'restarting'].includes(branch.status);
  const busySince = isInterim ? branchBusySince(branch, action) : undefined;
  const timeBadge = branchTimeBadge(branch, now, busySince);
  const origin = branchOriginBadge(branch);
  const runtime = branchRuntimeBadge(branch);
  const role = branchVisualRole(branch.branch);
  const roleCardClass = branchRoleCardClass(role);
  const issueLabel = isError ? branchIssueLabel(branch) : '';
  const issueClass = isError ? branchIssueClass(branch) : '';
  const issueRailClass = isError ? branchIssueRailClass(branch) : '';
  const aiState = aiOperationState(branch, now);
  const isAiOperated = aiState.visible;
  const isAiActive = aiState.active;
  const recentAiAgent = activityEvents.find((event) => event.agent)?.agent || '';
  const aiTitle = recentAiAgent ? `${aiState.title}\n最近 Agent: ${recentAiAgent}` : aiState.title;
  const [tagEditorOpen, setTagEditorOpen] = useState(false);
  const [tagDraft, setTagDraft] = useState('');
  const [tagDraftError, setTagDraftError] = useState('');
  const [tagDeleteTarget, setTagDeleteTarget] = useState<string | null>(null);
  const [aiPanelOpen, setAiPanelOpen] = useState(false);
  const tagInputRef = useRef<HTMLInputElement | null>(null);
  // 整卡淡化:非 running 且非异常(异常需要醒目,不淡化)且非中间态。
  // 中间态保持正常亮度让 loading 动画清晰可见。
  const dimWholeCard = !isRunning && !isError && !isInterim;
  const builderLabel = branch.builder?.name || branch.builder?.login || branch.githubSenderLogin || '';
  const builderAvatarUrl = branch.builder?.avatarUrl
    || branch.githubSenderAvatarUrl
    || githubAvatarUrlFromHandle(branch.builder?.login || branch.githubSenderLogin || branch.builder?.name);
  const builderTitle = branch.builder
    ? `构建者: ${builderLabel}${branch.builder.email ? ` <${branch.builder.email}>` : ''}`
    : branch.githubSenderLogin
      ? `推送者: @${branch.githubSenderLogin}`
      : '推送者: 未知（暂无 webhook sender / commit author 元数据）';
  const builderInitial = builderLabel ? (builderLabel.trim().charAt(0) || '?').toUpperCase() : '?';
  const footerBuilder = builderHandle(branch);
  const footerSha = shortCommitSha(branch);
  const [builderAvatarStatus, setBuilderAvatarStatus] = useState<AvatarLoadStatus>(() => cachedAvatarStatus(builderAvatarUrl));
  const actorOrbitVisible = Boolean(footerBuilder) && (isInterim || action?.status === 'running' || isAiActive);
  const actorOrbitTone = isError || action?.status === 'error'
    ? 'danger'
    : isAiActive
      ? 'ai'
      : branch.status === 'stopping' || action?.kind === 'stop'
        ? 'warning'
        : 'build';
  useEffect(() => {
    if (!tagEditorOpen) return;
    const frame = window.requestAnimationFrame(() => tagInputRef.current?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, [tagEditorOpen]);
  useEffect(() => {
    if (!isAiOperated && aiPanelOpen) {
      setAiPanelOpen(false);
    }
  }, [aiPanelOpen, isAiOperated]);
  useEffect(() => {
    setBuilderAvatarStatus(cachedAvatarStatus(builderAvatarUrl));
  }, [builderAvatarUrl]);
  const submitTagDraft = async (): Promise<void> => {
    const trimmed = tagDraft.trim();
    if (!trimmed) {
      setTagDraftError('请输入标签名称');
      return;
    }
    if ((branch.tags || []).includes(trimmed)) {
      setTagDraftError('标签已存在');
      return;
    }
    await onAddTag?.(trimmed);
    setTagDraft('');
    setTagDraftError('');
    setTagEditorOpen(false);
    setTagDeleteTarget(null);
  };

  return (
    <article
      data-branch-card-id={branch.id}
      className={`group relative flex min-h-[158px] cursor-pointer flex-col ${tagEditorOpen || tagDeleteTarget || aiPanelOpen ? 'z-40 overflow-visible' : isError ? 'z-20 overflow-visible hover:z-50 focus-within:z-50' : 'overflow-hidden'} rounded-md border ${
        isError
          ? branchIssueCardClass(branch)
          : 'border-[hsl(var(--hairline))] bg-[hsl(var(--surface-raised))]'
      } transition-[border-color,box-shadow,transform,opacity] duration-150 hover:-translate-y-0.5 hover:border-[hsl(var(--hairline-strong))] hover:shadow-md hover:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60 ${
        dimWholeCard ? 'opacity-60' : ''
      } ${roleCardClass} ${isInterim ? 'cds-branch-card-busy' : ''} ${isAiActive ? 'cds-ai-active-card ring-1 ring-sky-400/45 shadow-[0_0_0_1px_rgba(56,189,248,0.22),0_12px_30px_-20px_rgba(56,189,248,0.75)]' : ''} ${highlighted ? 'cds-card-selected' : ''} ${highlightPulse ? 'cds-card-selected-flash' : ''}`}
      role="button"
      tabIndex={0}
      onClick={onDetail}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          onDetail();
        }
      }}
      aria-label={`打开 ${branch.branch} 详情`}
    >
      {highlighted ? (
        <div className="pointer-events-none absolute inset-y-0 left-0 w-1 bg-primary shadow-[0_0_18px_hsl(var(--primary)/0.45)]" aria-hidden />
      ) : null}
      {isAiActive ? (
        <div
          className="pointer-events-none absolute inset-y-0 left-0 w-1 bg-sky-400 shadow-[0_0_18px_rgba(56,189,248,0.65)]"
          aria-hidden
        />
      ) : null}
      {/* Header — 用户反馈 2026-05-06:
          - 时间和 ··· 不可挡住分支名 → 时间下沉到 chip 行右侧 / commit 行,
            顶行只保留 dot + 分支名 + ···(右上角缩到 6×6 容器,不挤标题)
          - 分支名给最大宽度,truncate(必要时 hover 显示完整) */}
      <header className="flex min-w-0 items-start justify-between gap-3 px-5 pt-5">
        <div className="flex min-w-0 flex-1 items-start gap-3">
          <Github
            className={`mt-1.5 h-4 w-4 shrink-0 text-sky-500 ${isAiActive ? 'cds-ai-kinetic-icon cds-ai-delay-0' : isInterim ? 'animate-pulse' : ''}`}
            aria-hidden
          />
          <div className="min-w-0 flex-1">
            <div className="flex min-w-0 flex-wrap items-center gap-1.5">
              <h3
                className="min-w-0 flex-[1_1_14rem] break-all text-[17px] font-semibold leading-7 tracking-tight"
                title={branch.branch}
              >
                {branch.branch}
              </h3>
              {branch.isFavorite ? <Star className="h-3 w-3 shrink-0 fill-current text-amber-500" /> : null}
              {branch.isColorMarked ? <Lightbulb className="h-3 w-3 shrink-0 text-primary" /> : null}
              {branch.githubPrNumber ? (
                <span
                  className="inline-flex h-5 shrink-0 items-center rounded border border-violet-400/35 bg-violet-400/10 px-1.5 text-[10px] font-semibold text-violet-300"
                  title={`关联 GitHub PR #${branch.githubPrNumber}`}
                >
                  PR #{branch.githubPrNumber}
                </span>
              ) : null}
              {isAiOperated ? (
                <button
                  type="button"
                  className={`inline-flex h-5 shrink-0 items-center gap-1 rounded border px-1.5 text-[10px] font-semibold transition-colors ${aiBadgeClass(aiState.status)}`}
                  title={aiTitle}
                  aria-expanded={aiPanelOpen}
                  onClick={(event) => {
                    event.stopPropagation();
                    setTagEditorOpen(false);
                    setTagDeleteTarget(null);
                    setAiPanelOpen((current) => !current);
                  }}
                >
                  <Bot className={isAiActive ? 'cds-ai-kinetic-icon cds-ai-delay-1 h-2.5 w-2.5' : 'h-2.5 w-2.5'} aria-hidden />
                  AI
                </button>
              ) : null}
              {/*
                2026-05-14：标题行的徽章从「Webhook / 手动」改为分支当前的「运行模式」
                （发布版 / 源码 / 混合）。用户更关心的是"这个分支跑的是热加载还是 publish"，
                而不是"来源是 webhook 还是手动"。来源信息降级到 title attribute（hover 看到）。
                发布相关运行模式带火箭图标；源码只保留普通文字，避免误导成发布态。
              */}
              {runtime ? (
                <span
                  className={`inline-flex h-5 shrink-0 items-center gap-1 rounded border px-1.5 text-[10px] font-medium ${runtime.className}`}
                  title={`${runtime.title}\n来源: ${origin.label} — ${origin.title}`}
                >
                  <Rocket className={isAiActive ? 'cds-ai-kinetic-icon cds-ai-delay-2 h-2.5 w-2.5' : 'h-2.5 w-2.5'} aria-hidden />
                  {runtime.label}
                </span>
              ) : (
                <span
                  className="inline-flex h-5 shrink-0 items-center gap-1 rounded border border-[hsl(var(--hairline))] px-1.5 text-[10px] font-medium text-muted-foreground"
                  title={`运行模式: 源码 / 热加载\n来源: ${origin.label} — ${origin.title}`}
                >
                  源码
                </span>
              )}
            </div>
          </div>
        </div>

        <div className="flex shrink-0 items-start" onClick={(event) => event.stopPropagation()}>
          <BranchMoreMenu
            busy={busy}
            branch={branch}
            onPull={onPull}
            onStop={onStop}
            onForceRebuild={onForceRebuild}
            onReset={onReset}
            onToggleFavorite={onToggleFavorite}
            onToggleDebug={onToggleDebug}
            onEditTags={onEditTags}
            onDelete={onDelete}
          />
        </div>
      </header>

      {aiPanelOpen && isAiOperated ? (
        <div
          className="absolute right-4 top-14 z-[130] w-[min(340px,calc(100%-32px))] rounded-md border border-[hsl(var(--hairline-strong))] bg-[hsl(var(--surface-raised))] p-3 text-xs shadow-2xl"
          role="dialog"
          aria-label={`${branch.branch} AI 操作记录`}
          onClick={(event) => event.stopPropagation()}
          onKeyDown={(event) => {
            event.stopPropagation();
            if (event.key === 'Escape') setAiPanelOpen(false);
          }}
        >
          <div className="mb-2 flex items-center justify-between gap-3">
            <div className="flex min-w-0 items-center gap-2 font-semibold">
              <Bot className={`h-4 w-4 ${isAiActive ? 'text-sky-300' : aiState.status === 'timeout' ? 'text-amber-300' : 'text-muted-foreground'}`} />
              <span className="truncate">{aiState.label}</span>
              {recentAiAgent ? (
                <span className="max-w-[120px] truncate rounded border border-sky-400/25 bg-sky-400/10 px-1.5 py-0.5 text-[10px] text-sky-300">
                  {recentAiAgent}
                </span>
              ) : null}
            </div>
            <button
              type="button"
              className="inline-flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground hover:bg-muted/40 hover:text-foreground"
              onClick={() => setAiPanelOpen(false)}
              aria-label="关闭 AI 操作面板"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
          <div className="grid gap-1.5 rounded-md border border-[hsl(var(--hairline))] bg-[hsl(var(--surface-sunken))]/55 px-3 py-2 text-muted-foreground">
            <div className="flex justify-between gap-3">
              <span>最近操作</span>
              <span className="text-foreground">{aiState.relative || '-'}</span>
            </div>
            <div className="flex justify-between gap-3">
              <span>最后时间</span>
              <span className="font-mono">{formatLocalDateTime(aiState.lastAt)}</span>
            </div>
            <div className="flex justify-between gap-3">
              <span>租约超时</span>
              <span className="font-mono">{formatLocalDateTime(aiState.timeoutAt)}</span>
            </div>
            <div className="flex justify-between gap-3">
              <span>结束判定</span>
              <span className="text-foreground">
                {aiState.status === 'active' ? '租约内' : aiState.status === 'timeout' ? '租约超时' : '已释放'}
              </span>
            </div>
            <div className="flex justify-between gap-3">
              <span>记录次数</span>
              <span className="text-foreground">{branch.aiOpCount || activityEvents.length || 1}</span>
            </div>
            <div className="flex justify-between gap-3">
              <span>最近 Agent</span>
              <span className="min-w-0 max-w-[180px] truncate text-foreground">{recentAiAgent || '-'}</span>
            </div>
          </div>
          <div className="mt-2 rounded-md border border-[hsl(var(--hairline))] bg-[hsl(var(--surface-sunken))]/35 px-3 py-2 leading-5 text-muted-foreground">
            {aiState.status === 'active'
              ? '当前仍在 AI 租约窗口内；如果超时前没有续租，会自动降级为已超时。'
              : aiState.status === 'timeout'
                ? '超过租约窗口后没有新的 AI 续租记录，按已超时处理。'
                : '当前分支未处于 AI 活跃窗口，视为 AI 已释放。'}
          </div>
          <div className="mt-3">
            <div className="mb-1.5 text-[11px] font-medium text-muted-foreground">最近 AI 记录</div>
            {activityEvents.length > 0 ? (
              <div className="max-h-32 space-y-1 overflow-auto pr-1">
                {activityEvents.map((event) => (
                  <div key={event.id} className="rounded border border-[hsl(var(--hairline))] bg-[hsl(var(--surface-sunken))]/45 px-2 py-1.5">
                    <div className="flex items-center gap-2">
                      <span className={`rounded border px-1 py-0.5 font-mono ${activityStatusClass(event.status)}`}>{event.status}</span>
                      <span className="min-w-0 flex-1 truncate text-foreground">{activityLabel(event)}</span>
                      <span className="font-mono text-muted-foreground">{formatDuration(event.duration)}</span>
                    </div>
                    <div className="mt-1 flex items-center gap-2 text-[11px] text-muted-foreground">
                      <span>{activitySourceLabel(event)}</span>
                      <span>{formatShortTime(event.ts)}</span>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="rounded border border-dashed border-[hsl(var(--hairline))] px-2 py-2 text-muted-foreground">
                暂无细分活动；当前只拿到分支级 AI 占用时间与次数。
              </div>
            )}
          </div>
          <div className="mt-3 flex flex-wrap justify-end gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => {
                setAiPanelOpen(false);
                onDetail();
              }}
            >
              打开详情
            </Button>
            {isRunning ? (
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => {
                  setAiPanelOpen(false);
                  onPreview();
                }}
              >
                <ExternalLink />
                人工预览
              </Button>
            ) : null}
          </div>
        </div>
      ) : null}

      {/* 状态/服务 chip 行 — wrap 不 nowrap,所有 port 全部显示(无 +N 折叠)。
          用户反馈 2026-05-06:
          - running 时端口 chip 已带绿点,"运行中"chip 完全冗余 → 删
          - 启动中 / 异常 时,端口 chip 色统一跟 branch 状态(以前是
            service.status,会出现"branch 启动中蓝 / 服务 chip 绿"割裂)
          - 时间挪到这一行最右,小号灰字,绝对不挡分支名 */}
      <div className="flex max-w-full flex-wrap items-center gap-2 px-5 pt-3">
        {/* status chip 仅在异常/中间态显示;running 删除(冗余)。
            中间态的已用时间合并在同一个 chip 内,避免"启动中"和"启动 01:34"重复。 */}
        {(isError || isInterim) ? (
          <span
            className={`${isInterim ? 'branch-build-elapsed ' : ''}inline-flex h-6 shrink-0 items-center gap-1.5 rounded-md border px-2 text-xs ${isError ? issueClass : statusClass(branch.status)}`}
            title={isInterim ? `${statusLabel(branch.status)}已持续时间` : undefined}
            data-since={isInterim ? busySince || '' : undefined}
          >
            <span className={`h-1.5 w-1.5 rounded-full ${isAiActive ? 'cds-ai-kinetic-dot ' : ''}${isError ? issueRailClass : statusRailClass(branch.status)}`} aria-hidden />
            {isError ? issueLabel : statusLabel(branch.status)}
            {isInterim ? (
              <>
                <Clock3 className={isAiActive ? 'cds-ai-kinetic-icon cds-ai-delay-3 h-3 w-3' : 'h-3 w-3'} aria-hidden />
                <span className="branch-deploy-timer-value font-mono">{formatElapsedFrom(busySince, now)}</span>
              </>
            ) : null}
          </span>
        ) : null}
        {portChips.length > 0 ? portChips.map((service) => {
          // 端口 chip 颜色优先跟 branch 整体态:isInterim/isError 时强制对齐
          // (端口监听了不代表流量已通,容易给用户"绿色=就绪"的错觉);
          // running 时才用 service 自身状态做精细化区分。
          const chipStatus = isInterim || isError ? branch.status : service.status;
          const chipClass = isError ? issueClass : statusClass(chipStatus);
          const chipRailClass = isError ? issueRailClass : statusRailClass(chipStatus);
          return (
            <span
              key={service.profileId}
              className={`inline-flex h-6 shrink-0 items-center gap-1.5 rounded-md border px-2 font-mono text-xs ${chipClass}`}
              title={service.profileId}
            >
              <span className={`h-1.5 w-1.5 rounded-full ${isAiActive ? 'cds-ai-kinetic-dot ' : ''}${chipRailClass}`} aria-hidden />
              <span>{compactServiceLabel(service.profileId)}</span>
              <span>:{service.hostPort}</span>
            </span>
          );
        }) : (
          // 没有 port 时显示概览(只有当至少有 service 才显示,否则啥都不显示)
          serviceCount(branch) > 0 ? (
            <span className="inline-flex h-6 shrink-0 items-center rounded-md border border-[hsl(var(--hairline))] px-2 text-xs text-muted-foreground">
              服务 {runningCount}/{serviceCount(branch)}
            </span>
          ) : null
        )}
        <span className="ml-auto whitespace-nowrap text-xs text-muted-foreground" title={timeBadge.title}>
          {timeBadge.label} {timeBadge.text}
        </span>
      </div>

      {/* 标签 chips 行(还原 legacy app.js:3868-3881):
          - 卡片内 tag chip 只展示；点击 chip/行空白处走卡片整体 onClick 打开详情
          - hover 时右侧出现 × 单删按钮(快速删除,无确认)
          - "+ 标签"按钮 → 原地浮层输入,单条新增(乐观更新 + 失败回滚)
          - 多于 3 个时折叠为"+N",避免撑爆卡片宽度。点击折叠按钮跳到批量编辑。
          - 只有 × / +N / +标签 这些明确按钮 stopPropagation。 */}
      {(onAddTag || onRemoveTag || onClickTag) ? (
        <div className="relative flex flex-wrap items-center gap-1.5 px-5 pt-2 pb-3">
          {(branch.tags || []).slice(0, 3).map((tag) => {
            const isActive = activeTagFilter === tag;
            return (
              <span
                key={tag}
                className={`group/tag inline-flex h-6 items-center gap-1 rounded-md border px-2 text-[11px] font-medium shadow-[inset_0_1px_0_rgba(255,255,255,0.06)] transition-colors ${
                  isActive
                    ? 'border-primary/45 bg-primary/15 text-primary'
                    : 'border-emerald-400/30 bg-emerald-400/10 text-emerald-300 hover:border-primary/40 hover:bg-primary/10 hover:text-primary'
                }`}
                title={`标签: ${tag}`}
              >
                <Tags className="h-3 w-3 shrink-0" aria-hidden />
                <span className="max-w-[120px] truncate">{tag}</span>
                {onRemoveTag ? (
                  <button
                    type="button"
                    onClick={(event) => {
                      event.stopPropagation();
                      setTagEditorOpen(false);
                      setTagDeleteTarget((current) => (current === tag ? null : tag));
                    }}
                    className="ml-0.5 inline-flex h-3.5 w-3.5 items-center justify-center rounded-sm opacity-0 transition-opacity hover:bg-destructive/20 hover:text-destructive group-hover/tag:opacity-100 focus:opacity-100"
                    title="删除标签"
                    aria-label={`删除标签 ${tag}`}
                  >
                    <X className="h-3 w-3" />
                  </button>
                ) : null}
              </span>
            );
          })}
          {(branch.tags || []).length > 3 ? (
            <button
              type="button"
              onClick={(event) => {
                event.stopPropagation();
                onEditTags();
              }}
              className="inline-flex h-6 items-center rounded-md border border-dashed border-emerald-400/30 bg-emerald-400/5 px-2 text-[11px] text-emerald-300/80 transition-colors hover:border-primary/40 hover:text-primary"
              title="编辑全部标签"
            >
              +{(branch.tags || []).length - 3}
            </button>
          ) : null}
          {onAddTag ? (
            <button
              type="button"
              onClick={(event) => {
                event.stopPropagation();
                setTagEditorOpen((current) => !current);
                setTagDeleteTarget(null);
                setTagDraftError('');
              }}
              className="inline-flex h-6 items-center gap-1 rounded-md border border-dashed border-emerald-400/35 bg-emerald-400/5 px-2 text-[11px] font-medium text-emerald-300/85 transition-colors hover:border-primary/45 hover:bg-primary/10 hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50"
              title="添加标签"
              aria-expanded={tagEditorOpen}
            >
              <Plus className="h-3 w-3" />
              <span>标签</span>
            </button>
          ) : null}
          {tagEditorOpen && onAddTag ? (
            <form
              className="absolute left-5 top-[calc(100%-4px)] z-30 w-[min(280px,calc(100%-40px))] rounded-md border border-[hsl(var(--hairline-strong))] bg-[hsl(var(--surface-raised))] p-2.5 shadow-xl"
              onClick={(event) => event.stopPropagation()}
              onKeyDown={(event) => {
                event.stopPropagation();
                if (event.key === 'Escape') {
                  setTagEditorOpen(false);
                  setTagDraft('');
                  setTagDraftError('');
                }
              }}
              onSubmit={(event) => {
                event.preventDefault();
                void submitTagDraft();
              }}
            >
              <label className="mb-1.5 flex items-center gap-1.5 text-[11px] font-medium text-muted-foreground">
                <Tags className="h-3 w-3" aria-hidden />
                新标签
              </label>
              <div className="flex items-center gap-2">
                <input
                  ref={tagInputRef}
                  value={tagDraft}
                  onChange={(event) => {
                    setTagDraft(event.target.value);
                    if (tagDraftError) setTagDraftError('');
                  }}
                  className="h-8 min-w-0 flex-1 rounded-md border border-[hsl(var(--hairline))] bg-[hsl(var(--surface-sunken))] px-2.5 text-sm text-foreground outline-none transition-colors placeholder:text-muted-foreground/60 focus:border-primary/55 focus:ring-2 focus:ring-primary/20"
                  placeholder="输入标签名称"
                />
                <button
                  type="submit"
                  className="inline-flex h-8 shrink-0 items-center rounded-md bg-primary px-3 text-xs font-semibold text-primary-foreground transition-colors hover:bg-primary/90"
                >
                  添加
                </button>
              </div>
              {tagDraftError ? <div className="mt-1.5 text-[11px] text-destructive">{tagDraftError}</div> : null}
            </form>
          ) : null}
          {tagDeleteTarget && onRemoveTag ? (
            <div
              className="absolute left-5 top-[calc(100%-4px)] z-[120] w-[min(300px,calc(100%-40px))] rounded-md border border-[hsl(var(--hairline-strong))] bg-[hsl(var(--surface-raised))] p-2.5 shadow-2xl"
              role="dialog"
              aria-label={`删除标签 ${tagDeleteTarget}`}
              onClick={(event) => event.stopPropagation()}
              onKeyDown={(event) => {
                event.stopPropagation();
                if (event.key === 'Escape') setTagDeleteTarget(null);
              }}
            >
              <div className="mb-1.5 flex items-center gap-1.5 text-[11px] font-medium text-muted-foreground">
                <Tags className="h-3 w-3" aria-hidden />
                删除标签
              </div>
              <div className="rounded-md border border-destructive/25 bg-destructive/10 px-2.5 py-2 text-xs leading-5 text-foreground">
                从 <span className="font-medium">{branch.branch}</span> 移除{' '}
                <span className="font-mono text-emerald-300">#{tagDeleteTarget}</span>
              </div>
              <div className="mt-2.5 flex justify-end gap-2">
                <button
                  type="button"
                  className="inline-flex h-8 items-center rounded-md border border-[hsl(var(--hairline))] px-3 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted/40 hover:text-foreground"
                  onClick={() => setTagDeleteTarget(null)}
                >
                  取消
                </button>
                <button
                  type="button"
                  className="inline-flex h-8 items-center rounded-md bg-destructive px-3 text-xs font-semibold text-destructive-foreground transition-colors hover:bg-destructive/90"
                  onClick={() => {
                    const target = tagDeleteTarget;
                    setTagDeleteTarget(null);
                    void onRemoveTag(target);
                  }}
                >
                  删除
                </button>
              </div>
            </div>
          ) : null}
        </div>
      ) : null}

      <BranchFailureHint branch={branch} />

      <footer
        className="mt-auto grid grid-cols-[minmax(0,1fr)_auto] items-center gap-2 border-t border-[hsl(var(--hairline))] bg-[hsl(var(--surface-sunken))]/42 px-5 py-3"
        onClick={(event) => {
          const target = event.target as HTMLElement;
          if (target.closest('button,a,input,textarea,select,[role="menuitem"]')) {
            event.stopPropagation();
          }
        }}
      >
        <div className="flex min-w-0 items-center gap-3 pr-2 text-muted-foreground">
          <div className="flex min-w-[54px] max-w-[94px] shrink-0 flex-col items-center gap-1" title={builderTitle}>
            <div className={`cds-actor-orbit ${actorOrbitVisible ? `cds-actor-orbit--active cds-actor-orbit--${actorOrbitTone}` : ''}`}>
              {actorOrbitVisible && footerBuilder ? <CircularActorText text={footerBuilder} /> : null}
              <div
                className="cds-actor-orbit__avatar relative flex h-7 w-7 items-center justify-center overflow-hidden rounded-full border border-[hsl(var(--hairline-strong))] bg-[hsl(var(--surface-raised))] text-[11px] font-semibold text-foreground shadow-[inset_0_1px_0_rgba(255,255,255,0.08)]"
                aria-label={builderTitle}
              >
                <span className="absolute inset-0 flex items-center justify-center" aria-hidden>
                  {builderInitial}
                </span>
                {builderAvatarUrl && builderAvatarStatus !== 'failed' ? (
                  <img
                    src={builderAvatarUrl}
                    alt=""
                    className="relative h-full w-full object-cover"
                    referrerPolicy="no-referrer"
                    onLoad={() => {
                      rememberAvatarStatus(builderAvatarUrl, 'loaded');
                      setBuilderAvatarStatus('loaded');
                    }}
                    onError={() => {
                      rememberAvatarStatus(builderAvatarUrl, 'failed');
                      setBuilderAvatarStatus('failed');
                    }}
                  />
                ) : null}
              </div>
            </div>
            {footerBuilder && !actorOrbitVisible ? (
              <span className="block max-w-full break-all text-center text-[10px] font-medium leading-tight text-foreground/70">
                {footerBuilder}
              </span>
            ) : null}
          </div>
          <div className="flex min-w-0 flex-1 items-center gap-2">
            {footerSha ? (
              <span className="shrink-0 rounded border border-[hsl(var(--hairline))] bg-[hsl(var(--surface-raised))]/70 px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground" title={`commit ${footerSha}`}>
                {footerSha}
              </span>
            ) : null}
            <span className="min-w-0 truncate text-sm">{branch.subject || branch.branch}</span>
          </div>
        </div>
        {/*
          重设计(2026-05-04 用户主诉求):
            - running 态:Eye 按钮(主橙 primary 色,**预览=重点色**)。点开预览页。
            - 中间态:loading 旋转图标(non-clickable)
            - **未运行/异常**:**不再放部署按钮**。需要部署 → 点开抽屉 →
              设置 tab → 「重新部署」。理由:部署有副作用,需要"打开上下文 → 看
              到当前服务状态/日志 → 确认后再点",直接卡片右下点 Play 容易误操作。
              卡片淡化暗示"这个分支没在跑",用户主动点开抽屉就能恢复。
        */}
        {isRunning ? (
          previewCapacityWarning ? (
	            <ConfirmAction
	              title="容量不足，仍然预览部署？"
	              description={previewCapacityWarning}
	              confirmLabel="继续"
	              disabled={busy}
	              onConfirm={onPreview}
              trigger={(
                <Button
                  size="icon"
                  variant="outline"
                  className={isAiActive
                    ? 'cds-ai-preview-beacon border-sky-400/45 bg-sky-400/10 text-sky-300 hover:bg-sky-400/15 hover:text-sky-200'
                    : isAiOperated
                      ? 'border-sky-400/30 bg-sky-400/5 text-sky-300/80 hover:bg-sky-400/10 hover:text-sky-200'
                    : 'border-primary/35 bg-primary/10 text-primary hover:bg-primary/15 hover:text-primary'}
                  title={isAiOperated ? `${aiTitle} · 打开 AI 操作面板` : '预览'}
                  aria-label={isAiOperated ? `${aiState.label}，打开 AI 操作面板` : '预览'}
                >
                  {isAiOperated ? <Bot /> : <Eye />}
                </Button>
              )}
            />
          ) : (
            <Button
              size="icon"
              variant="outline"
              className={isAiActive
                ? 'cds-ai-preview-beacon border-sky-400/45 bg-sky-400/10 text-sky-300 hover:bg-sky-400/15 hover:text-sky-200'
                : isAiOperated
                  ? 'border-sky-400/30 bg-sky-400/5 text-sky-300/80 hover:bg-sky-400/10 hover:text-sky-200'
                : 'border-primary/35 bg-primary/10 text-primary hover:bg-primary/15 hover:text-primary'}
              onClick={isAiOperated
                ? (event) => {
                  event.stopPropagation();
                  setAiPanelOpen((current) => !current);
                }
                : onPreview}
              disabled={busy}
              title={isAiOperated ? `${aiTitle} · 打开 AI 操作面板` : '预览'}
              aria-label={isAiOperated ? `${aiState.label}，打开 AI 操作面板` : '预览'}
            >
              {busy ? <Loader2 className="animate-spin" /> : isAiOperated ? <Bot /> : <Eye />}
            </Button>
          )
        ) : isInterim ? (
          <Button size="icon" variant="outline" disabled title={statusLabel(branch.status)} aria-label={statusLabel(branch.status)}>
            <Loader2 className="animate-spin" />
          </Button>
        ) : null}
      </footer>
    </article>
  );
}

function BranchMoreMenu({
  busy,
  branch,
  onPull,
  onStop,
  onForceRebuild,
  onReset,
  onToggleFavorite,
  onToggleDebug,
  onEditTags,
  onDelete,
}: {
  busy: boolean;
  branch: BranchSummary;
  onPull: () => void;
  onStop: () => void;
  onForceRebuild: () => void;
  onReset: () => void;
  onToggleFavorite: () => void;
  onToggleDebug: () => void;
  onEditTags: () => void;
  onDelete: () => void;
}): JSX.Element {
  return (
    <>
      <ConfirmAction
        title={`删除分支 ${branch.branch}？`}
        description={`将停止 ${Object.keys(branch.services || {}).length} 个服务,删除该分支工作区与构建产物 — 此操作不可撤销。git 历史不受影响(仅 CDS 端忘记这个分支),分支可重新部署但 CDS 内的部署历史/日志/指标会丢失。`}
        confirmLabel="确认删除(不可恢复)"
        disabled={busy}
        onConfirm={onDelete}
        trigger={(
          <button
            type="button"
            className="inline-flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground opacity-0 transition-opacity hover:bg-destructive/10 hover:text-destructive focus:opacity-100 group-hover:opacity-100"
            aria-label="删除分支"
            title="删除分支"
          >
            <Trash2 className="h-4 w-4" />
          </button>
        )}
      />
      <DropdownMenu
        width={200}
        trigger={
          <button
            type="button"
            className="-mr-1 inline-flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-[hsl(var(--surface-sunken))] hover:text-foreground"
            aria-label="更多操作"
            title="更多操作"
          >
            <MoreHorizontal className="h-4 w-4" />
          </button>
        }
      >
        <DropdownLabel>分支操作</DropdownLabel>
        <DropdownItem onSelect={onPull} disabled={busy}>
          <RotateCw className="h-4 w-4 shrink-0" />
          拉取最新
        </DropdownItem>
        <DropdownItem onSelect={onStop} disabled={busy || branch.status !== 'running'}>
          <Square className="h-4 w-4 shrink-0" />
          停止运行
        </DropdownItem>
        <DropdownItem onSelect={onForceRebuild} disabled={busy}>
          <RefreshCw className="h-4 w-4 shrink-0" />
          重新生成
        </DropdownItem>
        <DropdownItem onSelect={onReset} disabled={busy || branch.status !== 'error'}>
          <RotateCw className="h-4 w-4 shrink-0" />
          重置异常
        </DropdownItem>
        <DropdownDivider />
        <DropdownItem onSelect={onToggleFavorite} disabled={busy}>
          <Star className={`h-4 w-4 shrink-0 ${branch.isFavorite ? 'fill-current text-amber-500' : ''}`} />
          {branch.isFavorite ? '取消收藏' : '收藏'}
        </DropdownItem>
        <DropdownItem onSelect={onToggleDebug} disabled={busy}>
          <Lightbulb className={`h-4 w-4 shrink-0 ${branch.isColorMarked ? 'fill-current text-primary' : ''}`} />
          {branch.isColorMarked ? '取消调试' : '调试标记'}
        </DropdownItem>
        <DropdownItem onSelect={onEditTags} disabled={busy}>
          <Tags className="h-4 w-4 shrink-0" />
          编辑标签
        </DropdownItem>
      </DropdownMenu>
    </>
  );
}

function BranchFailureHint({
  branch,
}: {
  branch: BranchSummary;
}): JSX.Element | null {
  /*
   * 默认只占一条稳定高度的摘要，避免异常文案把整行 card 撑高。
   * hover / keyboard focus 时用绝对定位浮层展开完整原因；浮层盖在网格
   * 上方，不参与当前 card 的布局计算。
   */
  const failedServices = Object.values(branch.services || {}).filter((service) => service.status === 'error');
  if (branch.status !== 'error' && failedServices.length === 0) return null;
  const message = deployFailureMessage(branch) || '分支处于异常状态';
  const hintId = `branch-failure-hint-${branch.id}`;
  return (
    <div
      className={`group/failure relative mx-5 mb-3 mt-1 h-8 text-xs focus:outline-none focus-visible:ring-2 focus-visible:ring-current/35 ${branchIssueHintTextClass(branch)}`}
      title={message}
      tabIndex={0}
      aria-describedby={hintId}
      onClick={(event) => event.stopPropagation()}
      onKeyDown={(event) => event.stopPropagation()}
    >
      <div className="flex h-8 min-w-0 items-center gap-2 rounded-md border border-current/30 bg-[hsl(var(--surface-raised))]/70 px-2.5 shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]">
        <AlertCircle className="h-3.5 w-3.5 shrink-0" />
        <span className="min-w-0 flex-1 truncate">{message}</span>
      </div>
      <div
        id={hintId}
        className="pointer-events-auto absolute left-0 right-0 top-0 z-[120] hidden max-h-36 overflow-auto rounded-md border border-current/45 bg-[hsl(var(--surface-raised))] px-3 py-2.5 leading-5 shadow-2xl ring-1 ring-black/5 group-hover/failure:block group-focus/failure:block"
      >
        <div className="flex items-start gap-2">
          <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span className="min-w-0 whitespace-pre-wrap break-words">{message}</span>
        </div>
      </div>
    </div>
  );
}

function branchRuntimeBadge(branch: BranchSummary): { kind: 'release' | 'mixed' | 'pending'; label: string; title: string; className: string } | null {
  const runtime = branch.deployRuntime;
  if (runtime?.kind === 'release') {
    return {
      kind: 'release',
      label: runtime.label || '发布版',
      title: runtime.title || '当前分支使用发布版构建模式',
      className: 'border-emerald-400/35 bg-emerald-400/10 text-emerald-700 dark:text-emerald-300',
    };
  }
  // 2026-05-14 真实态徽章：配置已切发布版但容器还没真正以发布版跑起来
  // （重部署中 / 还停着 / 旧源码容器仍在跑）→ 橙色「发布版·待生效」，
  // 明确区分"配置意图"与"运行现状"，不再设了 override 就亮绿误导。
  if (runtime?.pendingPublish) {
    return {
      kind: 'pending',
      label: '发布版·待生效',
      title: runtime.title || '已配置发布版，等待重新部署后真正生效',
      className: 'border-amber-400/40 bg-amber-400/10 text-amber-700 dark:text-amber-300',
    };
  }
  if (runtime?.kind === 'mixed') {
    return {
      kind: 'mixed',
      label: runtime.label || '混合',
      title: runtime.title || '当前分支同时存在发布版和源码模式服务',
      className: 'border-violet-400/35 bg-violet-400/10 text-violet-700 dark:text-violet-300',
    };
  }
  return null;
}

function branchOriginBadge(branch: BranchSummary): { label: string; title: string; className: string } {
  if (branch.githubRepoFullName || branch.githubCommitSha) {
    return {
      label: 'Webhook',
      title: `GitHub webhook 关联${branch.githubRepoFullName ? `: ${branch.githubRepoFullName}` : ''}`,
      className: 'border-sky-500/35 bg-sky-500/10 text-sky-700 dark:text-sky-300',
    };
  }
  if ((branch.deployCount || 0) > 0 || (branch.pullCount || 0) > 0) {
    return {
      label: '手动',
      title: '由 CDS 页面或 API 手动创建/部署，没有关联 GitHub webhook 投递记录',
      className: 'border-[hsl(var(--hairline))] bg-[hsl(var(--surface-sunken))] text-muted-foreground',
    };
  }
  return {
    label: '待配置',
    title: '未检测到 webhook 元数据或部署记录。打开详情后可重新部署、拉取或检查项目设置',
    className: 'border-amber-500/35 bg-amber-500/10 text-amber-700 dark:text-amber-300',
  };
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
        <ConfirmAction
          title={`排空执行器 ${node.id}？`}
          description="它不会再接收新的分支部署，已有服务不会立即删除。"
          confirmLabel="排空"
          disabled={!canDrain}
          onConfirm={onDrain}
          trigger={(
            <Button type="button" size="sm" variant="outline">
              <PowerOff />
              排空
            </Button>
          )}
        />
        <ConfirmAction
          title={`移除执行器 ${node.id}？`}
          description="只会从主节点注册表移除该节点，不会 SSH 到远端机器停止进程。在线节点可能会在下一次心跳后重新出现。"
          confirmLabel="移除"
          disabled={!canRemove}
          onConfirm={onRemove}
          trigger={(
            <Button type="button" size="sm" variant="outline">
              <Trash2 />
              移除
            </Button>
          )}
        />
        {isEmbedded ? <span className="self-center text-muted-foreground">本机主执行器不可移除</span> : null}
      </div>
    </div>
  );
}
