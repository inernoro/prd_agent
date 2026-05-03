import type { ReactNode } from 'react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Navigate, useParams } from 'react-router-dom';
import {
  Activity,
  AlertCircle,
  ArrowLeft,
  ChevronDown,
  Copy,
  Cpu,
  Eye,
  ExternalLink,
  Gauge,
  GitBranch,
  HardDrive,
  Lightbulb,
  Loader2,
  MoreHorizontal,
  Network,
  Play,
  PowerOff,
  Plus,
  RefreshCw,
  RotateCw,
  Search,
  Server,
  Settings,
  Square,
  Star,
  Tags,
  TerminalSquare,
  Trash2,
} from 'lucide-react';

import { AppShell, Crumb, PaletteHint, TopBar, Workspace } from '@/components/layout/AppShell';
import { BranchDetailDrawer, type BranchDeploymentItem } from '@/components/BranchDetailDrawer';
import { Button } from '@/components/ui/button';
import { ConfirmAction } from '@/components/ui/confirm-action';
import { DropdownDivider, DropdownItem, DropdownLabel, DropdownMenu } from '@/components/ui/dropdown-menu';
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
  defaultBranch?: string | null;
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

function compactServiceLabel(profileId: string): string {
  const normalized = profileId.trim();
  if (!normalized) return 'service';
  if (/^api[-_]/i.test(normalized)) return 'api';
  if (/^admin[-_]/i.test(normalized)) return 'admin';
  return normalized.replace(/[-_]prd[-_]?agent$/i, '').replace(/[-_]agent$/i, '');
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
 * F17 fix (2026-05-02 onboarding UAT): the preview-tab pre-load placeholder
 * was a single flat line of text ("CDS is preparing the preview...") which
 * violates user contract #31 ("non-text / CDS-branded loading"). This is
 * the only opportunity to brand the transition since `about:blank` is
 * cross-origin (we can't render React into it) and we own the document for
 * exactly one frame before navigating away.
 *
 * Implementation strategy:
 *   - Inline SVG logo + CSS keyframes pulse animation (no external assets)
 *   - Theme-aware: read parent `data-theme` to pick light/dark palette so
 *     the pre-load tab matches what the user is looking at
 *   - Brand wordmark "CDS" + Chinese subtitle so the user instantly knows
 *     which tool opened the tab (avoids "wait, what's CDS again?")
 *   - Status text is small, secondary — the spinning animation carries the
 *     "we're working" signal, not the literal sentence
 *
 * Constraints we cannot work around:
 *   - `about:blank` has no CSS context — must inline literal colors, not
 *     CSS variables. We use the same hex values as our `--bg-base` /
 *     `--text-primary` token pairs (see cds/web/src/index.css).
 *   - No emojis (rule #0)
 *   - Cross-origin / cookie isolation: cannot use sessionStorage from the
 *     parent window to remember user theme preference here, so we read
 *     `parent.document.documentElement.dataset.theme` directly while we
 *     still have same-origin access to the parent.
 */
function openPreviewPlaceholder(): PreviewTarget {
  const target = window.open('about:blank', '_blank');
  if (!target) return null;
  try {
    target.opener = null;

    // Detect theme from the parent document so the pre-load page matches
    // the user's current CDS dashboard look. Default to dark when unknown.
    const parentTheme = document.documentElement.getAttribute('data-theme');
    const isLight = parentTheme === 'light';

    const palette = isLight
      ? { bg: '#f8f2ed', surface: '#ffffff', primary: '#2a1f19', muted: '#7c6f64', accent: '#d97706' }
      : { bg: '#0f1014', surface: '#131314', primary: '#e8e8ec', muted: '#9ca3af', accent: '#fbbf24' };

    target.document.title = 'CDS · 正在准备预览';

    // Replace the entire <head> + <body> in one shot — we own this document
    // for the time between window.open() and target.location.href = url.
    target.document.body.innerHTML = '';
    target.document.head.innerHTML = `
      <meta charset="utf-8">
      <meta name="viewport" content="width=device-width,initial-scale=1">
      <title>CDS · 正在准备预览</title>
      <style>
        html, body {
          margin: 0;
          padding: 0;
          height: 100%;
          background: ${palette.bg};
          color: ${palette.primary};
          font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", system-ui, sans-serif;
          overflow: hidden;
        }
        .stage {
          display: flex;
          flex-direction: column;
          align-items: center;
          justify-content: center;
          min-height: 100vh;
          gap: 32px;
        }
        .logo {
          width: 96px;
          height: 96px;
          position: relative;
        }
        .logo svg {
          width: 100%;
          height: 100%;
          display: block;
        }
        .ring-outer {
          fill: none;
          stroke: ${palette.accent};
          stroke-width: 3;
          stroke-linecap: round;
          stroke-dasharray: 60 220;
          transform-origin: center;
          animation: rotateRing 1.6s linear infinite;
        }
        .ring-inner {
          fill: none;
          stroke: ${palette.accent};
          stroke-width: 2;
          stroke-linecap: round;
          stroke-dasharray: 40 140;
          transform-origin: center;
          animation: rotateRing 2.4s linear infinite reverse;
          opacity: 0.55;
        }
        .wordmark {
          fill: ${palette.primary};
          font-size: 28px;
          font-weight: 700;
          font-family: "SF Mono", Menlo, ui-monospace, monospace;
          letter-spacing: 1px;
          dominant-baseline: central;
          text-anchor: middle;
        }
        @keyframes rotateRing {
          from { transform: rotate(0deg); }
          to { transform: rotate(360deg); }
        }
        .meta {
          display: flex;
          flex-direction: column;
          align-items: center;
          gap: 6px;
        }
        .title {
          font-size: 15px;
          font-weight: 500;
          color: ${palette.primary};
          letter-spacing: 2px;
        }
        .subtitle {
          font-size: 12px;
          color: ${palette.muted};
          letter-spacing: 0.5px;
        }
        .progress-track {
          width: 240px;
          height: 3px;
          border-radius: 999px;
          background: ${isLight ? '#efe7df' : 'rgba(255,255,255,0.08)'};
          overflow: hidden;
          position: relative;
        }
        .progress-fill {
          position: absolute;
          inset: 0;
          width: 30%;
          background: linear-gradient(90deg, transparent, ${palette.accent}, transparent);
          animation: slideTrack 1.8s ease-in-out infinite;
        }
        @keyframes slideTrack {
          0%   { transform: translateX(-110%); }
          100% { transform: translateX(380%); }
        }
        .footer {
          position: fixed;
          bottom: 24px;
          left: 0; right: 0;
          text-align: center;
          font-size: 11px;
          color: ${palette.muted};
          letter-spacing: 1px;
          opacity: 0.7;
        }
      </style>
    `;

    // Body: spinning ring + CDS wordmark + status row + branded footer.
    // Why all-SVG instead of <img>: avoids any external network request
    // racing the navigation that's about to happen on the next tick.
    const stage = target.document.createElement('div');
    stage.className = 'stage';
    stage.innerHTML = `
      <div class="logo" role="img" aria-label="CDS preparing preview">
        <svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg">
          <circle class="ring-outer" cx="50" cy="50" r="46" />
          <circle class="ring-inner" cx="50" cy="50" r="34" />
          <text class="wordmark" x="50" y="51">CDS</text>
        </svg>
      </div>
      <div class="meta">
        <div class="title">正在准备预览</div>
        <div class="subtitle">Cloud Dev Suite · preparing preview</div>
      </div>
      <div class="progress-track" aria-hidden="true">
        <div class="progress-fill"></div>
      </div>
      <div class="footer">CDS · cds.miduo.org</div>
    `;
    target.document.body.appendChild(stage);
  } catch {
    // The window still exists; navigation below can continue. Fall back to
    // the cheap text placeholder so something is on screen during the
    // hop in case the styled DOM injection failed (e.g. CSP weirdness).
    try {
      target.document.body.innerHTML
        = '<div style="padding:24px;font-family:system-ui,sans-serif">CDS · 正在准备预览…</div>';
    } catch {
      /* ignore */
    }
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
  const [remoteBranchesLoading, setRemoteBranchesLoading] = useState(false);
  // 项目切换器 — Week 4.8 Round 4d:Crumb 上的项目名变成 1 步切换的 dropdown
  // 不阻塞首屏加载;失败默默静默(降级到只显示项目列表入口)
  const [allProjects, setAllProjects] = useState<Array<{ id: string; name: string }>>([]);
  const [executorAction, setExecutorAction] = useState<Record<string, string>>({});
  const [selectedBranchId, setSelectedBranchId] = useState<string | null>(null);
  const [opsDrawerOpen, setOpsDrawerOpen] = useState(false);
  const [detailDrawerBranchId, setDetailDrawerBranchId] = useState<string | null>(null);
  const [branchSearchOpen, setBranchSearchOpen] = useState(false);
  const [pendingEnvKeys, setPendingEnvKeys] = useState<string[]>([]);
  const branchSearchRef = useRef<HTMLDivElement | null>(null);
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
  const refresh = useCallback(async (showLoading = false) => {
    if (!projectId) return;
    if (showLoading) setState({ status: 'loading' });
    try {
      const [project, branchesRes, previewModeRes, config] = await Promise.all([
        apiRequest<ProjectSummary>(`/api/projects/${encodeURIComponent(projectId)}`),
        apiRequest<BranchesResponse>(`/api/branches?project=${encodeURIComponent(projectId)}`),
        apiRequest<PreviewModeResponse>(`/api/projects/${encodeURIComponent(projectId)}/preview-mode`).catch(() => ({ mode: 'multi' as const })),
        apiRequest<CdsConfigResponse>('/api/config').catch(() => ({})),
      ]);
      setState((prev) => ({
        status: 'ok',
        project,
        branches: branchesRes.branches || [],
        // 保留之前已加载的远程分支(若有),避免主刷新时远程区闪空
        remoteBranches: prev.status === 'ok' ? prev.remoteBranches : [],
        previewMode: previewModeRes.mode || 'multi',
        config,
        capacity: branchesRes.capacity,
      }));
    } catch (err) {
      const message = err instanceof ApiError ? err.message : String(err);
      setState({ status: 'error', message });
    }
  }, [projectId]);

  const refreshRemoteBranches = useCallback(async (forceFetch = false) => {
    if (!projectId) return;
    setRemoteBranchesLoading(true);
    try {
      const url = forceFetch
        ? `/api/remote-branches?project=${encodeURIComponent(projectId)}`
        : `/api/remote-branches?project=${encodeURIComponent(projectId)}&nofetch=true`;
      const res = await apiRequest<RemoteBranchesResponse & { fetched?: boolean; cachedAt?: number | null }>(url);
      setState((prev) => prev.status === 'ok' ? { ...prev, remoteBranches: res.branches || [] } : prev);
      // 第一次走 nofetch 拿不到任何 ref(冷启动)时,触发一次 force fetch 兜底
      if (!forceFetch && (!res.branches || res.branches.length === 0)) {
        void refreshRemoteBranches(true);
        return;
      }
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

  // 一次性拉所有项目列表给 Crumb 上的项目切换 dropdown 用。
  // 失败静默降级到"无 dropdown,但 Crumb 项目名仍能跳 /project-list"。
  useEffect(() => {
    let cancelled = false;
    void apiRequest<{ projects: Array<{ id: string; name?: string }> }>('/api/projects')
      .then((res) => {
        if (cancelled) return;
        const list = (res.projects || []).map((p) => ({
          id: p.id,
          name: p.name || p.id,
        }));
        setAllProjects(list);
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
  // Branches displayed in the grid: favorites first, then by recent activity.
  // We no longer expose status filters or compact toggles in the list itself
  // (the search dropdown and per-card status pill cover those needs).
  const sortedBranches = useMemo(() => {
    const score = (branch: BranchSummary) => new Date(branch.lastAccessedAt || branch.lastDeployAt || branch.createdAt || 0).getTime() || 0;
    return branches.slice().sort((left, right) => {
      if (!!left.isFavorite !== !!right.isFavorite) return left.isFavorite ? -1 : 1;
      return score(right) - score(left);
    });
  }, [branches]);
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
  }, [appendActionLog, openRunningPreview, projectId, refresh, setAction]);

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
    const defaultBranchName = state.project?.defaultBranch;
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
      // Already tracked — defer to openPreview which only opens a tab
      // when the branch is actually running. If not running it kicks off
      // a deploy without auto-navigating.
      await openPreview(existing, true);
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
      await deployBranch(result.branch, false, null);
    } catch (err) {
      const message = err instanceof ApiError ? err.message : String(err);
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
      await deployBranch(result.branch, false, null);
    } catch (err) {
      const message = err instanceof ApiError ? err.message : String(err);
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
                    setBranchSearchOpen(false);
                    setManualBranchName('');
                    setSelectedBranchId(branch.id);
                    window.location.href = `/branch-panel/${encodeURIComponent(branch.id)}?project=${encodeURIComponent(branch.projectId)}`;
                  }}
                  onPickRemote={(remote) => {
                    setBranchSearchOpen(false);
                    setManualBranchName('');
                    void previewRemoteBranch(remote);
                  }}
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
        {/* Hero: search-or-paste branch with autocomplete dropdown — replaces
            the old left "tracked / remote" two-list panel which the user
            said wasn't useful. Daily flow: focus the input, see all branches,
            type a few characters, click a row OR press Enter to preview. */}
        {state.status === 'loading' ? (
          <div className="mt-6">
            <LoadingBlock label="加载分支与远程引用" />
          </div>
        ) : null}
        {state.status === 'error' ? (
          <div className="mt-6">
            <ErrorBlock message={state.message} />
          </div>
        ) : null}

        {state.status === 'ok' && state.project.cloneStatus && state.project.cloneStatus !== 'ready' ? (
          <div className="mt-6 rounded-md border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-sm text-amber-700 dark:text-amber-400">
            当前项目仓库状态为 {state.project.cloneStatus}，克隆完成前不能创建或部署分支。
            {state.project.cloneError ? <span className="ml-2">{state.project.cloneError}</span> : null}
          </div>
        ) : null}

        {/* Phase 9.6 — 缺失必填项 banner(envMeta.kind=required + value 空)。
            比 pendingEnvKeys 的"TODO 占位检测"更准 — 后端用 envMeta 直接告诉
            我们哪些 required key 还没填,deploy 会被 412 block。点按钮去填 */}
        {missingRequiredKeys.length > 0 ? (
          <div className="mt-6 flex flex-wrap items-start gap-3 rounded-md border border-rose-500/50 bg-rose-500/10 px-4 py-3 text-sm text-rose-700 dark:text-rose-300">
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
            <div className="min-w-0 flex-1">
              <div className="font-medium">必填环境变量缺失,deploy 会被 block</div>
              <div className="mt-0.5 text-xs leading-5">
                {missingRequiredKeys.length} 个必填项还没填:
                <code className="ml-1 break-all">
                  {missingRequiredKeys.slice(0, 6).join(', ')}
                  {missingRequiredKeys.length > 6 ? ` 等 ${missingRequiredKeys.length} 项` : ''}
                </code>
              </div>
            </div>
            <Button asChild size="sm">
              <a href={`/settings/${encodeURIComponent(projectId)}#env`}>
                <Settings />
                立刻填写
              </a>
            </Button>
          </div>
        ) : null}

        {/* Pending env vars banner — surfaces when a cds-compose import
            left TODO placeholders so the user knows where to fill them
            in. Without this, deploys fail silently with cryptic errors
            because services see literal "TODO: 请填写实际值" as their
            DB password / secret. */}
        {pendingEnvKeys.length > 0 ? (
          <div className="mt-6 flex flex-wrap items-start gap-3 rounded-md border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-sm text-amber-700 dark:text-amber-400">
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
            <div className="min-w-0 flex-1">
              <div className="font-medium">项目环境变量待补全</div>
              <div className="mt-0.5 text-xs leading-5 text-amber-700/80 dark:text-amber-400/80">
                {pendingEnvKeys.length} 个变量仍是 TODO 占位（{pendingEnvKeys.slice(0, 5).join(' · ')}
                {pendingEnvKeys.length > 5 ? ` 等 ${pendingEnvKeys.length} 项` : ''}），先去填好再部署。
              </div>
            </div>
            <Button asChild size="sm">
              <a href={`/settings/${encodeURIComponent(projectId)}#env`}>
                <Settings />
                前往填写
              </a>
            </Button>
          </div>
        ) : null}

        {/* Branch tile grid — built user mental model: cards in a 3-up
            grid, each with [预览] [部署] [详情] inline + kebab menu for low-frequency
            actions (拉取 / 停止 / 收藏 / 调试 / 标签 / 重置 / 删除). */}
        {state.status === 'ok' ? (
          <div className="mt-6">
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
              <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
                {sortedBranches.map((branch) => (
                  <BranchCard
                    key={branch.id}
                    branch={branch}
                    action={actions[branch.id]}
                    projectId={projectId}
                    capacityWarning={state.status === 'ok' ? capacityMessage(state.capacity, [branch]) : ''}
                    onPreview={() => void openPreview(branch, true)}
                    onDeploy={() => void deployBranch(branch, false)}
                    onDetail={() => setDetailDrawerBranchId(branch.id)}
                    onPull={() => void pullBranch(branch)}
                    onStop={() => void stopBranch(branch)}
                    onToggleFavorite={() => void patchBranch(branch, { isFavorite: !branch.isFavorite })}
                    onToggleDebug={() => void patchBranch(branch, { isColorMarked: !branch.isColorMarked })}
                    onReset={() => void resetBranch(branch)}
                    onDelete={() => void deleteBranch(branch)}
                    onEditTags={() => void editTags(branch)}
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
        />

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
  projects: Array<{ id: string; name: string }>;
}): JSX.Element {
  // 把当前项目排第一,其它按字母序;最多展示 8 个,有更多就给"查看全部"
  const ordered = useMemo(() => {
    const current = projects.find((p) => p.id === currentProjectId);
    const rest = projects
      .filter((p) => p.id !== currentProjectId)
      .sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'));
    const all = current ? [current, ...rest] : rest;
    return all.slice(0, 8);
  }, [projects, currentProjectId]);
  const hasMore = projects.length > ordered.length;

  return (
    <DropdownMenu
      align="start"
      width={240}
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
        return (
          <DropdownItem
            key={p.id}
            disabled={isCurrent}
            onSelect={() => {
              window.location.href = `/branches/${encodeURIComponent(p.id)}`;
            }}
          >
            <span className="flex w-full items-center gap-2">
              <span
                className={`h-1.5 w-1.5 rounded-full ${isCurrent ? 'bg-emerald-500' : 'bg-muted-foreground/40'}`}
                aria-hidden
              />
              <span className="min-w-0 flex-1 truncate">{p.name}</span>
              {isCurrent ? <span className="text-[10px] text-muted-foreground">当前</span> : null}
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
}: {
  query: string;
  tracked: BranchSummary[];
  remote: RemoteBranch[];
  remoteLoading: boolean;
  trackedByName: Map<string, BranchSummary>;
  actions: Record<string, BranchAction>;
  onPickTracked: (branch: BranchSummary) => void;
  onPickRemote: (remote: RemoteBranch) => void;
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
                      {statusLabel(branch.status)} · 服务 {runningServiceCount(branch)}/{serviceCount(branch)} · {formatRelativeTime(branch.lastDeployAt || branch.lastAccessedAt)}
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
                    <span className="block truncate text-sm font-medium">{remoteBranch.name}</span>
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
        <span>{visibleTracked.length + visibleRemote.length} 项</span>
      </div>
    </div>
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
        className="cds-overlay-anim absolute inset-0 bg-black/40"
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
  capacityWarning,
  onPreview,
  onDeploy,
  onDetail,
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
  capacityWarning?: string;
  // projectId is reserved for future inline modes; the call site already
  // passes it but BranchCard currently derives all routing data from
  // `branch.projectId`. Keeping the prop optional to avoid a churn of
  // callers when we later need it (e.g. cross-project routing tests).
  projectId?: string;
  selected?: boolean;
  onSelect?: () => void;
  onPreview: () => void;
  onDeploy: () => void;
  onDetail: () => void;
  onPull: () => void;
  onStop: () => void;
  onToggleFavorite: () => void;
  onToggleDebug: () => void;
  onReset: () => void;
  onDelete: () => void;
  onEditTags: () => void;
}): JSX.Element {
  /*
   * BranchTile — compact card sized for a 3-up grid (~360px wide). Mirrors
   * the legacy mental model: primary actions [预览] [部署] [详情] inline at
   * the bottom; low-frequency actions live in a kebab dropdown.
   */
  const busy = action?.status === 'running' || isBusy(branch);
  const runningCount = runningServiceCount(branch);
  const services = Object.values(branch.services || {});
  const visiblePorts = services
    .filter((service) => service.hostPort)
    .slice(0, 1);
  const hiddenPortCount = Math.max(0, services.filter((service) => service.hostPort).length - visiblePorts.length);
  const previewCapacityWarning = branch.status === 'running' ? '' : capacityWarning;

  return (
    <article
      className="group relative flex min-h-[158px] cursor-pointer flex-col overflow-hidden rounded-md border border-[hsl(var(--hairline))] bg-[hsl(var(--surface-raised))] transition-[border-color,box-shadow,transform] duration-150 hover:-translate-y-0.5 hover:border-[hsl(var(--hairline-strong))] hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60"
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
      {/* Header */}
      <header className="flex min-w-0 items-start justify-between gap-4 px-5 pt-5">
        <div className="flex min-w-0 items-start gap-3">
          <span
            className={`mt-2 inline-block h-2.5 w-2.5 shrink-0 rounded-full ${statusRailClass(branch.status)} ${
              branch.status === 'running' ? 'shadow-[0_0_8px_rgba(16,185,129,0.45)]' : ''
            }`}
            aria-hidden
          />
          <div className="min-w-0 flex-1">
            <div className="flex min-w-0 items-center gap-1.5">
              <h3 className="min-w-0 truncate text-[17px] font-semibold leading-7 tracking-tight">{branch.branch}</h3>
              {branch.isFavorite ? <Star className="h-3 w-3 shrink-0 fill-current text-amber-500" /> : null}
              {branch.isColorMarked ? <Lightbulb className="h-3 w-3 shrink-0 text-primary" /> : null}
            </div>
          </div>
        </div>

        <div className="flex shrink-0 items-start gap-1.5" onClick={(event) => event.stopPropagation()}>
          <span className="mt-2 whitespace-nowrap text-sm text-muted-foreground">
            {formatRelativeTime(branch.lastDeployAt || branch.lastAccessedAt)}
          </span>
          <BranchMoreMenu
            busy={busy}
            branch={branch}
            onPull={onPull}
            onStop={onStop}
            onReset={onReset}
            onToggleFavorite={onToggleFavorite}
            onToggleDebug={onToggleDebug}
            onEditTags={onEditTags}
            onDelete={onDelete}
          />
        </div>
      </header>

      <div className="flex max-w-full flex-nowrap items-center gap-2 overflow-hidden px-5 pt-3">
        <span className={`inline-flex h-6 shrink-0 items-center rounded-md border px-2 text-xs ${statusClass(branch.status)}`}>
          {statusLabel(branch.status)}
        </span>
        {visiblePorts.length > 0 ? visiblePorts.map((service) => (
          <span
            key={service.profileId}
            className={`inline-flex h-6 shrink-0 items-center gap-1.5 rounded-md border px-2 font-mono text-xs ${statusClass(service.status)}`}
            title={service.profileId}
          >
            <span className={`h-1.5 w-1.5 rounded-full ${statusRailClass(service.status)}`} aria-hidden />
            <span>{compactServiceLabel(service.profileId)}</span>
            <span>:{service.hostPort}</span>
          </span>
        )) : (
          <span className="inline-flex h-6 shrink-0 items-center rounded-md border border-[hsl(var(--hairline))] px-2 text-xs text-muted-foreground">
            服务 {runningCount}/{serviceCount(branch)}
          </span>
        )}
        {hiddenPortCount > 0 ? (
          <span className="inline-flex h-6 shrink-0 items-center rounded-md border border-[hsl(var(--hairline))] px-2 text-xs text-muted-foreground">
            +{hiddenPortCount}
          </span>
        ) : null}
      </div>

      <BranchFailureHint branch={branch} busy={busy} onDetail={onDetail} onReset={onReset} />

      <footer
        className="mt-auto grid grid-cols-[minmax(0,1fr)_auto] items-center gap-2 border-t border-[hsl(var(--hairline))] bg-[hsl(var(--surface-sunken))]/42 px-5 py-3"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex min-w-0 items-center gap-2 pr-2 text-muted-foreground">
          <GitBranch className="h-4 w-4 shrink-0 text-sky-500" />
          <span className="min-w-0 truncate text-sm">{branch.subject || branch.branch}</span>
          <span className="shrink-0 font-mono text-xs">{branch.commitSha ? branch.commitSha.slice(0, 7) : '未提交'}</span>
        </div>
        {/*
          Single contextual primary action (Week 4.8 Round 4a, 用户 2026-04-30 主诉求):
            - running           → 预览（用户最常做的事是打开 URL）
            - 中间态(building / starting / restarting / stopping)
                                → 显示 loading,disabled
            - 其它(idle / stopped / error / unknown)
                                → 部署
          整张卡片已经 onClick={onDetail},不再独立"详情"按钮。低频操作进 BranchMoreMenu。
        */}
        {branch.status === 'running' ? (
          previewCapacityWarning ? (
            <ConfirmAction
              title="容量不足，仍然预览部署？"
              description={previewCapacityWarning}
              confirmLabel="继续"
              disabled={busy}
              onConfirm={onPreview}
              trigger={(
                <Button size="icon" title="预览" aria-label="预览">
                  <Eye />
                </Button>
              )}
            />
          ) : (
            <Button size="icon" onClick={onPreview} disabled={busy} title="预览" aria-label="预览">
              {busy ? <Loader2 className="animate-spin" /> : <Eye />}
            </Button>
          )
        ) : busy ? (
          <Button size="icon" variant="outline" disabled title={statusLabel(branch.status)} aria-label={statusLabel(branch.status)}>
            <Loader2 className="animate-spin" />
          </Button>
        ) : capacityWarning ? (
          <ConfirmAction
            title="容量不足，仍然部署？"
            description={capacityWarning}
            confirmLabel="继续部署"
            disabled={busy}
            onConfirm={onDeploy}
            trigger={(
              <Button size="icon" title="部署" aria-label="部署">
                <Play />
              </Button>
            )}
          />
        ) : (
          <Button size="icon" onClick={onDeploy} disabled={busy} title="部署" aria-label="部署">
            <Play />
          </Button>
        )}
      </footer>
    </article>
  );
}

function BranchMoreMenu({
  busy,
  branch,
  onPull,
  onStop,
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
  onReset: () => void;
  onToggleFavorite: () => void;
  onToggleDebug: () => void;
  onEditTags: () => void;
  onDelete: () => void;
}): JSX.Element {
  return (
    <>
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
      <ConfirmAction
        title={`删除分支 ${branch.branch}？`}
        description="会停止服务并删除该分支工作区。"
        confirmLabel="删除"
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
    </>
  );
}

function BranchFailureHint({
  branch,
  busy,
  onDetail,
  onReset,
}: {
  branch: BranchSummary;
  busy: boolean;
  onDetail: () => void;
  onReset: () => void;
}): JSX.Element | null {
  const failedServices = Object.values(branch.services || {}).filter((service) => service.status === 'error');
  if (branch.status !== 'error' && failedServices.length === 0) return null;
  const message = deployFailureMessage(branch);

  // Special-case the "no build profile yet" failure: the only way out is
  // to add one in project settings, so make that the primary CTA.
  const noProfile = /尚未配置构建配置|未配置构建配置/.test(message);
  return (
    <div className="border-t border-destructive/30 bg-destructive/10 px-5 py-3 text-sm">
      <div className="flex items-center gap-3" onClick={(event) => event.stopPropagation()}>
        <AlertCircle className="h-4 w-4 shrink-0 text-destructive" />
        <div className="min-w-0 flex-1">
          <div className="truncate font-medium text-destructive">{message || '分支处于异常状态'}</div>
          <div className="mt-0.5 truncate text-xs text-muted-foreground">
            {noProfile
              ? '需要先添加构建配置'
              : failedServices.length
              ? `优先查看 ${failedServices.map((service) => service.profileId).join(', ')} 容器日志`
              : '打开详情查看部署日志后再重置异常'}
          </div>
        </div>
        <div className="flex shrink-0 gap-1.5">
          {noProfile ? (
            <Button asChild size="sm" className="h-8">
              <a href={`/settings/${encodeURIComponent(branch.projectId)}`}>
                <Settings />
                配置
              </a>
            </Button>
          ) : null}
          <Button type="button" size="sm" variant="outline" className="h-8" onClick={onDetail}>
            <TerminalSquare />
            详情
          </Button>
          <Button type="button" size="sm" variant="outline" className="h-8" disabled={busy} onClick={onReset}>
            <RotateCw />
            重置
          </Button>
        </div>
      </div>
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
