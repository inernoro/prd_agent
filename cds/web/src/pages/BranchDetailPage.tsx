import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Navigate, useParams } from 'react-router-dom';
import {
  AlertTriangle,
  ArrowLeft,
  CheckCircle2,
  Cloud,
  Code2,
  Copy,
  ExternalLink,
  FileText,
  GitCommitHorizontal,
  Home,
  Loader2,
  Moon,
  Play,
  RefreshCw,
  Settings,
  ShieldCheck,
  Sun,
  TerminalSquare,
  Trash2,
  Wrench,
} from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { DisclosurePanel } from '@/components/ui/disclosure-panel';
import { apiRequest, ApiError } from '@/lib/api';
import { useTheme } from '@/lib/theme';
import { CodePill, ErrorBlock, LoadingBlock, MetricTile } from '@/pages/cds-settings/components';

interface ProjectSummary {
  id: string;
  slug: string;
  name: string;
  aliasName?: string;
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
  deployCount?: number;
  pinnedCommit?: string;
}

interface BranchesResponse {
  branches: BranchSummary[];
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

interface OperationLogEvent {
  step: string;
  status: string;
  title?: string;
  log?: string;
  chunk?: string;
  timestamp?: string;
}

interface OperationLog {
  type: 'build' | 'run' | 'auto-build';
  startedAt: string;
  finishedAt?: string;
  status: 'running' | 'completed' | 'error';
  events: OperationLogEvent[];
}

interface LogsResponse {
  logs: OperationLog[];
}

interface ContainerLogsResponse {
  logs: string;
}

interface GitCommit {
  hash: string;
  subject: string;
  author: string;
  date: string;
}

interface GitLogResponse {
  commits: GitCommit[];
}

interface ProfileRow {
  profileId: string;
  profileName: string;
  hasOverride: boolean;
  override?: BuildProfileOverride | null;
  effective?: {
    dockerImage?: string;
    command?: string;
    containerPort?: number;
    pathPrefixes?: string[];
  };
}

interface BuildProfileOverride {
  dockerImage?: string;
  command?: string;
  containerWorkDir?: string;
  containerPort?: number;
  env?: Record<string, string>;
  pathPrefixes?: string[];
  activeDeployMode?: string;
  startupSignal?: string;
  notes?: string;
}

interface ProfileOverridesResponse {
  profiles: ProfileRow[];
}

interface AliasResponse {
  aliases: string[];
  defaultUrl?: string;
  previewUrls?: string[];
  rootDomain?: string;
}

interface ProxyLogEvent {
  id: number;
  ts: string;
  method: string;
  host: string;
  url: string;
  branchSlug: string | null;
  profileId: string | null;
  upstream: string | null;
  status: number;
  durationMs: number;
  outcome: 'ok' | 'client-error' | 'upstream-error' | 'no-branch-match' | 'branch-not-running' | 'timeout';
  errorCode?: string;
  errorMessage?: string;
  hint?: string;
}

interface ProxyLogResponse {
  events: ProxyLogEvent[];
}

interface BridgeCheckResponse {
  active: boolean;
}

interface BridgeConnection {
  branchId: string;
  url: string;
  connectedAt: string;
}

interface BridgeConnectionsResponse {
  connections: BridgeConnection[];
}

interface ForceRebuildResponse {
  message: string;
  steps?: Array<{ step: string; ok: boolean; detail?: string }>;
}

interface RuntimeVerifyResponse {
  branch: string;
  profile: string;
  container: string;
  processStart?: string;
  latestDll?: { ts: number | null; path: string };
  latestSource?: { ts: number | null; path: string };
  recentLogs?: string;
  warnings?: string[];
}

interface DiagnosticIssue {
  id: string;
  profileId?: string;
  severity: 'error' | 'warning';
  title: string;
  message: string;
  action?: 'command' | 'image' | 'port' | 'logs' | 'diagnose' | 'deploy';
}

type LoadState =
  | { status: 'loading' }
  | { status: 'error'; message: string; projectId?: string }
  | {
      status: 'select';
      project: ProjectSummary;
      branches: BranchSummary[];
    }
  | {
      status: 'ok';
      project?: ProjectSummary;
      branch: BranchSummary;
      operationLogs: OperationLog[];
      commits: GitCommit[];
      profiles: ProfileRow[];
      aliases: AliasResponse;
      proxyLogs: ProxyLogEvent[];
      bridgeActive: boolean;
      bridgeConnection?: BridgeConnection;
      bridgeState?: unknown;
      previewMode: 'simple' | 'port' | 'multi';
      config: CdsConfigResponse;
    };

type ActionState = {
  label: string;
  log: string[];
  status?: 'running' | 'done' | 'error';
};

type ContainerLogState =
  | { status: 'idle' }
  | { status: 'loading'; profileId: string }
  | { status: 'error'; profileId: string; message: string }
  | { status: 'ok'; profileId: string; logs: string };

function queryValue(name: string): string {
  return new URLSearchParams(window.location.search).get(name) || '';
}

function displayName(project?: ProjectSummary): string {
  if (!project) return '';
  return project.aliasName || project.name || project.slug || project.id;
}

function formatDate(value?: string | null): string {
  if (!value) return '暂无';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '暂无';
  return date.toLocaleString();
}

function shortCommit(value?: string | null): string {
  return (value || '').trim().slice(0, 7);
}

function sameCommit(a?: string | null, b?: string | null): boolean {
  const left = (a || '').trim().toLowerCase();
  const right = (b || '').trim().toLowerCase();
  if (!left || !right) return false;
  return left === right || left.startsWith(right) || right.startsWith(left);
}

function statusLabel(status: BranchSummary['status'] | ServiceState['status'] | OperationLog['status']): string {
  const labels: Record<string, string> = {
    idle: '未运行',
    building: '构建中',
    starting: '启动中',
    running: '运行中',
    restarting: '重启中',
    stopping: '停止中',
    stopped: '已停止',
    error: '异常',
    completed: '完成',
  };
  return labels[status] || status;
}

function statusClass(status: string): string {
  if (status === 'running' || status === 'completed' || status === 'done') {
    return 'border-emerald-500/30 bg-emerald-500/10 text-emerald-600';
  }
  if (status === 'building' || status === 'starting' || status === 'running' || status === 'restarting') {
    return 'border-sky-500/30 bg-sky-500/10 text-sky-600';
  }
  if (status === 'error') return 'border-destructive/30 bg-destructive/10 text-destructive';
  if (status === 'warning' || status === 'stopping') return 'border-amber-500/30 bg-amber-500/10 text-amber-600';
  return 'border-border bg-muted text-muted-foreground';
}

function proxyOutcomeClass(outcome: ProxyLogEvent['outcome']): string {
  if (outcome === 'ok') return 'border-emerald-500/30 bg-emerald-500/10 text-emerald-600';
  if (outcome === 'client-error' || outcome === 'branch-not-running') return 'border-amber-500/30 bg-amber-500/10 text-amber-600';
  return 'border-destructive/30 bg-destructive/10 text-destructive';
}

function httpStatusClass(status: number): string {
  if (status >= 500) return 'border-destructive/30 bg-destructive/10 text-destructive';
  if (status >= 400) return 'border-amber-500/30 bg-amber-500/10 text-amber-600';
  if (status >= 200) return 'border-emerald-500/30 bg-emerald-500/10 text-emerald-600';
  return 'border-border bg-muted text-muted-foreground';
}

function formatDurationMs(value: number): string {
  if (!Number.isFinite(value)) return '-';
  if (value < 1000) return `${Math.round(value)}ms`;
  return `${(value / 1000).toFixed(1)}s`;
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
  if (configured) return `${window.location.protocol}//${hostWithPort(configured, config.workerPort || 5500)}`;
  return `${window.location.protocol}//${window.location.hostname}:${config.workerPort || 5500}`;
}

function branchProxyLabels(branch: BranchSummary, aliases: AliasResponse): Set<string> {
  return new Set(
    [branch.id, branch.previewSlug || '', ...(aliases.aliases || [])]
      .filter(Boolean)
      .map((value) => value.toLowerCase()),
  );
}

function filterProxyLogsForBranch(events: ProxyLogEvent[], branch: BranchSummary, aliases: AliasResponse): ProxyLogEvent[] {
  const labels = branchProxyLabels(branch, aliases);
  return events
    .filter((event) => event.branchSlug && labels.has(event.branchSlug.toLowerCase()))
    .slice(-40)
    .reverse();
}

function compactOverride(override: BuildProfileOverride): BuildProfileOverride {
  const next: BuildProfileOverride = {};
  if (override.dockerImage?.trim()) next.dockerImage = override.dockerImage.trim();
  if (override.command?.trim()) next.command = override.command.trim();
  if (override.containerWorkDir?.trim()) next.containerWorkDir = override.containerWorkDir.trim();
  if (typeof override.containerPort === 'number' && override.containerPort > 0) next.containerPort = override.containerPort;
  if (override.env && Object.keys(override.env).length > 0) next.env = override.env;
  if (override.pathPrefixes && override.pathPrefixes.length > 0) next.pathPrefixes = override.pathPrefixes;
  if (override.activeDeployMode?.trim()) next.activeDeployMode = override.activeDeployMode.trim();
  if (override.startupSignal?.trim()) next.startupSignal = override.startupSignal.trim();
  if (override.notes?.trim()) next.notes = override.notes.trim();
  return next;
}

function overrideHasFields(override: BuildProfileOverride): boolean {
  return Object.keys(compactOverride(override)).length > 0;
}

function latestErrorEvents(logs: OperationLog[]): OperationLogEvent[] {
  return logs
    .flatMap((log) => log.events || [])
    .filter((event) => {
      const text = `${event.title || ''} ${event.log || ''} ${event.chunk || ''}`.toLowerCase();
      return event.status === 'error' || text.includes('失败') || text.includes('缺少') || text.includes('error');
    })
    .slice(-5)
    .reverse();
}

function buildDiagnosticIssues(
  branch: BranchSummary,
  services: ServiceState[],
  profiles: ProfileRow[],
  logs: OperationLog[],
): DiagnosticIssue[] {
  if (branch.status !== 'error' && !branch.errorMessage && !services.some((service) => service.status === 'error')) {
    return [];
  }

  const issues: DiagnosticIssue[] = [];
  const errorEvents = latestErrorEvents(logs);
  for (const service of services.filter((item) => item.status === 'error')) {
    const profile = profiles.find((item) => item.profileId === service.profileId);
    const relatedText = [
      service.errorMessage || '',
      branch.errorMessage || '',
      ...errorEvents
        .filter((event) => {
          const text = `${event.title || ''} ${event.log || ''} ${event.chunk || ''} ${event.step || ''}`;
          return text.includes(service.profileId) || !event.step;
        })
        .map((event) => `${event.title || ''} ${event.log || ''} ${event.chunk || ''} ${event.step || ''}`),
    ].join(' ').toLowerCase();
    const mentionsCommand = relatedText.includes('command') || relatedText.includes('命令');
    const mentionsImage = relatedText.includes('image') || relatedText.includes('镜像') || relatedText.includes('docker');
    const mentionsPort = relatedText.includes('port') || relatedText.includes('端口');
    const noSpecificConfigHint = !mentionsCommand && !mentionsImage && !mentionsPort && !service.errorMessage;

    if (!profile?.effective?.command && (mentionsCommand || noSpecificConfigHint)) {
      issues.push({
        id: `${service.profileId}:command`,
        profileId: service.profileId,
        severity: 'error',
        title: '缺少启动命令',
        message: `${service.profileId} 没有有效 command，容器无法启动。补充命令后重部署该服务。`,
        action: 'command',
      });
    }
    if (!profile?.effective?.dockerImage && (mentionsImage || noSpecificConfigHint)) {
      issues.push({
        id: `${service.profileId}:image`,
        profileId: service.profileId,
        severity: 'error',
        title: '缺少镜像',
        message: `${service.profileId} 没有有效 Docker 镜像。补充镜像后重部署该服务。`,
        action: 'image',
      });
    }
    if (!profile?.effective?.containerPort && mentionsPort) {
      issues.push({
        id: `${service.profileId}:port`,
        profileId: service.profileId,
        severity: 'warning',
        title: '端口未配置',
        message: `${service.profileId} 没有有效容器端口，预览代理可能无法转发。`,
        action: 'port',
      });
    }
    if (service.errorMessage) {
      issues.push({
        id: `${service.profileId}:service-error`,
        profileId: service.profileId,
        severity: 'error',
        title: `${service.profileId} 启动失败`,
        message: service.errorMessage,
        action: 'logs',
      });
    }
  }

  if (branch.errorMessage) {
    issues.push({
      id: 'branch:error',
      severity: 'error',
      title: '分支处于异常状态',
      message: branch.errorMessage,
      action: 'diagnose',
    });
  }

  for (const event of errorEvents) {
    const message = event.log || event.title || event.chunk || event.step;
    if (!message) continue;
    issues.push({
      id: `log:${event.timestamp || event.step}:${message}`,
      severity: 'warning',
      title: event.title || event.step || '最近错误步骤',
      message,
      action: 'diagnose',
    });
  }

  const unique = new Map<string, DiagnosticIssue>();
  for (const issue of issues) {
    const key = `${issue.profileId || 'branch'}:${issue.title}:${issue.message}`;
    if (!unique.has(key)) unique.set(key, issue);
  }
  return Array.from(unique.values()).slice(0, 8);
}

function cleanRuntimeWarning(value: string): string {
  return value
    .replace(/^⚠\s*/u, 'warning: ')
    .replace(/^✓\s*/u, 'ok: ')
    .replace(/「💥\s*/gu, '「')
    .trim();
}

function formatRuntimeVerifyResult(result: RuntimeVerifyResponse): string[] {
  const lines = [
    `profile: ${result.profile}`,
    `container: ${result.container}`,
    `process start: ${result.processStart || 'unknown'}`,
    `latest dll: ${result.latestDll?.path || 'not found'}`,
    `latest source: ${result.latestSource?.path || 'not found'}`,
  ];
  const warnings = result.warnings || [];
  if (warnings.length > 0) {
    lines.push('diagnosis:');
    for (const warning of warnings) lines.push(`- ${cleanRuntimeWarning(warning)}`);
  }
  const recentLogs = (result.recentLogs || '').trim().split('\n').filter(Boolean).slice(-8);
  if (recentLogs.length > 0) {
    lines.push('recent logs:');
    lines.push(...recentLogs);
  }
  return lines;
}

export function BranchDetailPage(): JSX.Element {
  const { branchId: branchIdParam } = useParams();
  const { theme, toggle } = useTheme();
  const branchId = branchIdParam || queryValue('branch') || queryValue('id');
  const projectId = queryValue('project');
  const [state, setState] = useState<LoadState>({ status: 'loading' });
  const [action, setAction] = useState<ActionState | null>(null);
  const [toast, setToast] = useState('');
  const [selectedProfileId, setSelectedProfileId] = useState('');
  const [containerLogs, setContainerLogs] = useState<ContainerLogState>({ status: 'idle' });
  const [commitQuery, setCommitQuery] = useState('');
  const [proxyLogQuery, setProxyLogQuery] = useState('');
  const actionRef = useRef<ActionState | null>(null);

  const updateAction = useCallback((next: ActionState | null) => {
    actionRef.current = next;
    setAction(next);
  }, []);

  const appendActionLog = useCallback((line: string) => {
    if (!line || !actionRef.current) return;
    updateAction({
      ...actionRef.current,
      log: [...actionRef.current.log.slice(-80), line],
    });
  }, [updateAction]);

  const load = useCallback(async (showLoading = false) => {
    if (showLoading) setState({ status: 'loading' });
    try {
      if (!branchId) {
        if (!projectId) {
          setState({ status: 'error', message: 'missing_branch_id' });
          return;
        }
        const [project, branchesRes] = await Promise.all([
          apiRequest<ProjectSummary>(`/api/projects/${encodeURIComponent(projectId)}`),
          apiRequest<BranchesResponse>(`/api/branches?project=${encodeURIComponent(projectId)}`),
        ]);
        setState({ status: 'select', project, branches: branchesRes.branches || [] });
        return;
      }

      const branchesPath = projectId
        ? `/api/branches?project=${encodeURIComponent(projectId)}`
        : '/api/branches';
      const branchesRes = await apiRequest<BranchesResponse>(branchesPath);
      const branch = (branchesRes.branches || []).find((item) => item.id === branchId);
      if (!branch) {
        setState({ status: 'error', message: 'branch_not_found', projectId });
        return;
      }

      const realProjectId = branch.projectId || projectId;
      const [project, operationLogs, commits, profiles, aliases, proxyLogs, bridgeCheck, bridgeConnections, previewMode, config] = await Promise.all([
        realProjectId
          ? apiRequest<ProjectSummary>(`/api/projects/${encodeURIComponent(realProjectId)}`).catch(() => undefined)
          : Promise.resolve(undefined),
        apiRequest<LogsResponse>(`/api/branches/${encodeURIComponent(branch.id)}/logs`).catch(() => ({ logs: [] })),
        apiRequest<GitLogResponse>(`/api/branches/${encodeURIComponent(branch.id)}/git-log?count=15`).catch(() => ({ commits: [] })),
        apiRequest<ProfileOverridesResponse>(`/api/branches/${encodeURIComponent(branch.id)}/profile-overrides`).catch(() => ({ profiles: [] })),
        apiRequest<AliasResponse>(`/api/branches/${encodeURIComponent(branch.id)}/subdomain-aliases`).catch(() => ({ aliases: [] })),
        apiRequest<ProxyLogResponse>('/api/proxy-log').catch(() => ({ events: [] })),
        apiRequest<BridgeCheckResponse>(`/api/bridge/check/${encodeURIComponent(branch.id)}`).catch(() => ({ active: false })),
        apiRequest<BridgeConnectionsResponse>('/api/bridge/connections').catch(() => ({ connections: [] })),
        realProjectId
          ? apiRequest<PreviewModeResponse>(`/api/projects/${encodeURIComponent(realProjectId)}/preview-mode`).catch(() => ({ mode: 'multi' as const }))
          : Promise.resolve({ mode: 'multi' as const }),
        apiRequest<CdsConfigResponse>('/api/config').catch(() => ({})),
      ]);
      setState({
        status: 'ok',
        project,
        branch,
        operationLogs: operationLogs.logs || [],
        commits: commits.commits || [],
        profiles: profiles.profiles || [],
        aliases,
        proxyLogs: filterProxyLogsForBranch(proxyLogs.events || [], branch, aliases),
        bridgeActive: !!bridgeCheck.active,
        bridgeConnection: (bridgeConnections.connections || []).find((item) => item.branchId === branch.id),
        previewMode: previewMode.mode || 'multi',
        config,
      });
      const firstService = Object.keys(branch.services || {})[0] || profiles.profiles?.[0]?.profileId || '';
      setSelectedProfileId((current) => current || firstService);
    } catch (err) {
      const message = err instanceof ApiError ? err.message : String(err);
      setState({ status: 'error', message, projectId });
    }
  }, [branchId, projectId]);

  useEffect(() => {
    void load(true);
  }, [load]);

  useEffect(() => {
    if (state.status !== 'ok') return;
    const source = new EventSource(`/api/branches/stream?project=${encodeURIComponent(state.branch.projectId)}`);
    source.addEventListener('branch.status', (ev) => {
      const data = JSON.parse((ev as MessageEvent).data) as { branchId?: string; status?: BranchSummary['status'] };
      if (data.branchId !== state.branch.id || !data.status) return;
      setState((current) => (
        current.status === 'ok'
          ? { ...current, branch: { ...current.branch, status: data.status as BranchSummary['status'] } }
          : current
      ));
    });
    source.addEventListener('branch.updated', (ev) => {
      const data = JSON.parse((ev as MessageEvent).data) as { branch?: BranchSummary };
      if (!data.branch || data.branch.id !== state.branch.id) return;
      setState((current) => (current.status === 'ok' ? { ...current, branch: { ...current.branch, ...data.branch } } : current));
    });
    return () => source.close();
  }, [state]);

  const proxyStreamKey = state.status === 'ok'
    ? `${state.branch.id}|${state.branch.previewSlug || ''}|${state.aliases.aliases.join(',')}`
    : '';

  useEffect(() => {
    if (state.status !== 'ok') return;
    const labels = branchProxyLabels(state.branch, state.aliases);
    const source = new EventSource('/api/proxy-log/stream');
    source.onmessage = (ev) => {
      try {
        const event = JSON.parse(ev.data) as ProxyLogEvent;
        if (!event.branchSlug || !labels.has(event.branchSlug.toLowerCase())) return;
        setState((currentState) => {
          if (currentState.status !== 'ok') return currentState;
          const next = [event, ...currentState.proxyLogs.filter((item) => item.id !== event.id)].slice(0, 40);
          return { ...currentState, proxyLogs: next };
        });
      } catch {
        // Ignore malformed stream frames; the next refresh can recover.
      }
    };
    return () => source.close();
  }, [proxyStreamKey]);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(''), 3200);
    return () => window.clearTimeout(timer);
  }, [toast]);

  const services = state.status === 'ok' ? Object.values(state.branch.services || {}) : [];
  const diagnosticIssues = useMemo(() => (
    state.status === 'ok' ? buildDiagnosticIssues(state.branch, services, state.profiles, state.operationLogs) : []
  ), [services, state]);
  const filteredCommits = useMemo(() => {
    if (state.status !== 'ok') return [];
    const query = commitQuery.trim().toLowerCase();
    if (!query) return state.commits;
    return state.commits.filter((commit) => (
      commit.hash.toLowerCase().includes(query)
      || commit.subject.toLowerCase().includes(query)
      || commit.author.toLowerCase().includes(query)
      || commit.date.toLowerCase().includes(query)
    ));
  }, [commitQuery, state]);
  const filteredProxyLogs = useMemo(() => {
    if (state.status !== 'ok') return [];
    const query = proxyLogQuery.trim().toLowerCase();
    if (!query) return state.proxyLogs;
    return state.proxyLogs.filter((event) => (
      event.method.toLowerCase().includes(query)
      || event.host.toLowerCase().includes(query)
      || event.url.toLowerCase().includes(query)
      || (event.profileId || '').toLowerCase().includes(query)
      || event.outcome.toLowerCase().includes(query)
      || String(event.status).includes(query)
      || (event.errorCode || '').toLowerCase().includes(query)
      || (event.errorMessage || '').toLowerCase().includes(query)
      || (event.hint || '').toLowerCase().includes(query)
    ));
  }, [proxyLogQuery, state]);
  const proxyLogStats = useMemo(() => {
    if (state.status !== 'ok') return { total: 0, issues: 0, slow: 0 };
    return {
      total: state.proxyLogs.length,
      issues: state.proxyLogs.filter((event) => event.outcome !== 'ok' || event.status >= 400).length,
      slow: state.proxyLogs.filter((event) => event.durationMs >= 1000).length,
    };
  }, [state]);
  const selectedService = services.find((svc) => svc.profileId === selectedProfileId) || services[0];
  const selectedProfile = useMemo(() => {
    if (state.status !== 'ok') return undefined;
    return state.profiles.find((profile) => profile.profileId === selectedProfileId) || state.profiles[0];
  }, [selectedProfileId, state]);

  const saveAliases = useCallback(async () => {
    if (state.status !== 'ok') return;
    const current = (state.aliases.aliases || []).join(', ');
    const input = window.prompt('输入预览别名，多个别名用逗号分隔；留空则清除别名', current);
    if (input === null) return;
    const aliases = Array.from(
      new Set(
        input
          .split(',')
          .map((item) => item.trim().toLowerCase())
          .filter(Boolean),
      ),
    );
    try {
      const next = await apiRequest<AliasResponse>(`/api/branches/${encodeURIComponent(state.branch.id)}/subdomain-aliases`, {
        method: 'PUT',
        body: { aliases },
      });
      setState((currentState) => (currentState.status === 'ok' ? { ...currentState, aliases: next } : currentState));
      setToast('预览别名已保存');
    } catch (err) {
      const message = err instanceof ApiError ? err.message : String(err);
      setToast(message);
    }
  }, [state]);

  const refreshProxyLogs = useCallback(async () => {
    if (state.status !== 'ok') return;
    try {
      const proxyLogs = await apiRequest<ProxyLogResponse>('/api/proxy-log');
      setState((currentState) => (
        currentState.status === 'ok'
          ? { ...currentState, proxyLogs: filterProxyLogsForBranch(proxyLogs.events || [], currentState.branch, currentState.aliases) }
          : currentState
      ));
    } catch (err) {
      const message = err instanceof ApiError ? err.message : String(err);
      setToast(message);
    }
  }, [state]);

  const checkoutCommit = useCallback(async (commit: GitCommit) => {
    if (state.status !== 'ok') return;
    const ok = window.confirm(`固定到提交 ${commit.hash}？这会把该分支 worktree 切到历史提交，通常需要重新部署。`);
    if (!ok) return;
    updateAction({ label: `正在固定 ${commit.hash}`, log: [], status: 'running' });
    try {
      const res = await apiRequest<{ message?: string; pinnedCommit?: string }>(
        `/api/branches/${encodeURIComponent(state.branch.id)}/checkout/${encodeURIComponent(commit.hash)}`,
        { method: 'POST' },
      );
      updateAction(null);
      setToast(res.message || `已固定 ${commit.hash}`);
      await load(false);
    } catch (err) {
      const message = err instanceof ApiError ? err.message : String(err);
      updateAction({ label: message, log: actionRef.current?.log || [], status: 'error' });
      setToast(message);
    }
  }, [load, state, updateAction]);

  const unpinCommit = useCallback(async () => {
    if (state.status !== 'ok') return;
    const ok = window.confirm('恢复到分支最新提交？这会切回远程分支 HEAD，通常需要重新部署。');
    if (!ok) return;
    updateAction({ label: '正在恢复到最新提交', log: [], status: 'running' });
    try {
      const res = await apiRequest<{ message?: string }>(`/api/branches/${encodeURIComponent(state.branch.id)}/unpin`, {
        method: 'POST',
      });
      updateAction(null);
      setToast(res.message || '已恢复到最新提交');
      await load(false);
    } catch (err) {
      const message = err instanceof ApiError ? err.message : String(err);
      updateAction({ label: message, log: actionRef.current?.log || [], status: 'error' });
      setToast(message);
    }
  }, [load, state, updateAction]);

  const saveProfileOverride = useCallback(async (profile: ProfileRow, override: BuildProfileOverride) => {
    if (state.status !== 'ok') return;
    const next = compactOverride(override);
    try {
      if (!overrideHasFields(next)) {
        await apiRequest(`/api/branches/${encodeURIComponent(state.branch.id)}/profile-overrides/${encodeURIComponent(profile.profileId)}`, {
          method: 'DELETE',
        });
      } else {
        await apiRequest(`/api/branches/${encodeURIComponent(state.branch.id)}/profile-overrides/${encodeURIComponent(profile.profileId)}`, {
          method: 'PUT',
          body: next,
        });
      }
      setToast('分支覆盖已保存，重新部署后生效');
      await load(false);
    } catch (err) {
      const message = err instanceof ApiError ? err.message : String(err);
      setToast(message);
    }
  }, [load, state]);

  const editProfileTextOverride = useCallback(async (profile: ProfileRow, field: 'command' | 'dockerImage') => {
    const label = field === 'command' ? '启动命令' : 'Docker 镜像';
    const current = (profile.override?.[field] || profile.effective?.[field] || '') as string;
    const input = window.prompt(`${label} 覆写；留空则继承公共配置`, current);
    if (input === null) return;
    const next = { ...(profile.override || {}) };
    if (input.trim()) next[field] = input.trim();
    else delete next[field];
    await saveProfileOverride(profile, next);
  }, [saveProfileOverride]);

  const editProfilePortOverride = useCallback(async (profile: ProfileRow) => {
    const current = profile.override?.containerPort || profile.effective?.containerPort || '';
    const input = window.prompt('容器端口覆写；留空则继承公共配置', String(current));
    if (input === null) return;
    const next = { ...(profile.override || {}) };
    if (input.trim()) {
      const port = Number.parseInt(input.trim(), 10);
      if (!Number.isFinite(port) || port <= 0) {
        setToast('端口必须是正整数');
        return;
      }
      next.containerPort = port;
    } else {
      delete next.containerPort;
    }
    await saveProfileOverride(profile, next);
  }, [saveProfileOverride]);

  const editProfilePathPrefixesOverride = useCallback(async (profile: ProfileRow) => {
    const current = profile.override?.pathPrefixes || profile.effective?.pathPrefixes || [];
    const input = window.prompt('路径前缀覆写，多个用逗号分隔；留空则继承公共配置', current.join(', '));
    if (input === null) return;
    const next = { ...(profile.override || {}) };
    const pathPrefixes = input
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean);
    if (pathPrefixes.length > 0) next.pathPrefixes = pathPrefixes;
    else delete next.pathPrefixes;
    await saveProfileOverride(profile, next);
  }, [saveProfileOverride]);

  const clearProfileOverride = useCallback(async (profile: ProfileRow) => {
    if (state.status !== 'ok') return;
    const ok = window.confirm(`恢复 ${profile.profileName || profile.profileId} 为公共 BuildProfile？重新部署后生效。`);
    if (!ok) return;
    try {
      await apiRequest(`/api/branches/${encodeURIComponent(state.branch.id)}/profile-overrides/${encodeURIComponent(profile.profileId)}`, {
        method: 'DELETE',
      });
      setToast('已恢复公共配置，重新部署后生效');
      await load(false);
    } catch (err) {
      const message = err instanceof ApiError ? err.message : String(err);
      setToast(message);
    }
  }, [load, state]);

  const startBridgeSession = useCallback(async () => {
    if (state.status !== 'ok') return;
    try {
      const res = await apiRequest<{ message?: string }>('/api/bridge/start-session', {
        method: 'POST',
        body: { branchId: state.branch.id },
      });
      setToast(res.message || 'Bridge 会话已激活');
      await load(false);
    } catch (err) {
      const message = err instanceof ApiError ? err.message : String(err);
      setToast(message);
    }
  }, [load, state]);

  const endBridgeSession = useCallback(async () => {
    if (state.status !== 'ok') return;
    try {
      await apiRequest('/api/bridge/end-session', {
        method: 'POST',
        body: { branchId: state.branch.id, summary: '从 CDS 分支详情页结束 Bridge 会话' },
      });
      setToast('Bridge 会话已结束');
      await load(false);
    } catch (err) {
      const message = err instanceof ApiError ? err.message : String(err);
      setToast(message);
    }
  }, [load, state]);

  const readBridgeState = useCallback(async () => {
    if (state.status !== 'ok') return;
    try {
      const bridgeState = await apiRequest<unknown>(`/api/bridge/state/${encodeURIComponent(state.branch.id)}`);
      setState((currentState) => (currentState.status === 'ok' ? { ...currentState, bridgeState } : currentState));
      setToast('Bridge 状态已读取');
    } catch (err) {
      const message = err instanceof ApiError ? err.message : String(err);
      setToast(message);
    }
  }, [state]);

  const deploy = useCallback(async (profileId?: string) => {
    if (state.status !== 'ok') return;
    const label = profileId ? `正在重部署 ${profileId}` : '正在部署全部服务';
    updateAction({ label, log: [], status: 'running' });
    try {
      const path = profileId
        ? `/api/branches/${encodeURIComponent(state.branch.id)}/deploy/${encodeURIComponent(profileId)}`
        : `/api/branches/${encodeURIComponent(state.branch.id)}/deploy`;
      await postSse(path, {}, (event, data) => appendActionLog(eventMessage(event, data)));
      updateAction(null);
      setToast(profileId ? `${profileId} 已部署` : '分支已部署');
      await load(false);
    } catch (err) {
      const message = err instanceof ApiError ? err.message : String(err);
      updateAction({ label: message, log: actionRef.current?.log || [], status: 'error' });
      setToast(message);
    }
  }, [appendActionLog, load, state, updateAction]);

  const loadContainerLogs = useCallback(async (profileId: string) => {
    if (state.status !== 'ok') return;
    setContainerLogs({ status: 'loading', profileId });
    try {
      const res = await apiRequest<ContainerLogsResponse>(`/api/branches/${encodeURIComponent(state.branch.id)}/container-logs`, {
        method: 'POST',
        body: { profileId },
      });
      setContainerLogs({ status: 'ok', profileId, logs: res.logs || '' });
    } catch (err) {
      const message = err instanceof ApiError ? err.message : String(err);
      setContainerLogs({ status: 'error', profileId, message });
    }
  }, [state]);

  const forceRebuild = useCallback(async (profileId: string) => {
    if (state.status !== 'ok') return;
    const ok = window.confirm(`强制干净重建会停止 ${profileId} 容器并删除 worktree 中的 bin/obj 构建缓存。继续?`);
    if (!ok) return;
    updateAction({ label: `正在清理 ${profileId}`, log: [], status: 'running' });
    try {
      const res = await apiRequest<ForceRebuildResponse>(
        `/api/branches/${encodeURIComponent(state.branch.id)}/force-rebuild/${encodeURIComponent(profileId)}`,
        { method: 'POST' },
      );
      const steps = res.steps || [];
      const failed = steps.some((step) => !step.ok);
      updateAction({
        label: failed ? `${profileId} 清理部分失败` : (res.message || '已清理构建缓存'),
        log: [
          ...steps.map((step) => `${step.ok ? 'ok' : 'fail'} ${step.step}${step.detail ? ` - ${step.detail}` : ''}`),
          ...(failed ? ['suggestion: 检查失败步骤后重试；如果只是容器已不存在，可直接重新部署该服务。'] : []),
        ],
        status: failed ? 'error' : 'done',
      });
      if (failed) setToast('清理部分失败，查看构建日志中的失败步骤');
      await load(false);
    } catch (err) {
      const message = err instanceof ApiError ? err.message : String(err);
      updateAction({ label: message, log: actionRef.current?.log || [], status: 'error' });
      setToast(message);
    }
  }, [load, state, updateAction]);

  const verifyRuntime = useCallback(async (profileId: string) => {
    if (state.status !== 'ok') return;
    updateAction({ label: `正在诊断 ${profileId}`, log: [], status: 'running' });
    try {
      const res = await apiRequest<RuntimeVerifyResponse>(
        `/api/branches/${encodeURIComponent(state.branch.id)}/verify-runtime/${encodeURIComponent(profileId)}`,
        { method: 'POST' },
      );
      updateAction({ label: `${profileId} 运行时诊断完成`, log: formatRuntimeVerifyResult(res), status: 'done' });
    } catch (err) {
      const message = err instanceof ApiError ? err.message : String(err);
      updateAction({ label: message, log: actionRef.current?.log || [], status: 'error' });
      setToast(message);
    }
  }, [state, updateAction]);

  const openPreview = useCallback(async () => {
    if (state.status !== 'ok') return;
    if (state.branch.status !== 'running') {
      setToast('分支未运行，先部署后再打开预览');
      return;
    }
    try {
      let url = '';
      if (state.previewMode === 'port') {
        const result = await apiRequest<{ port: number }>(`/api/branches/${encodeURIComponent(state.branch.id)}/preview-port`, {
          method: 'POST',
        });
        url = `${window.location.protocol}//${window.location.hostname}:${result.port}`;
      } else if (state.previewMode === 'simple') {
        await apiRequest(`/api/branches/${encodeURIComponent(state.branch.id)}/set-default`, { method: 'POST' });
        url = simplePreviewUrl(state.config);
      } else {
        url = multiPreviewUrl(state.branch, state.config);
      }
      if (!url) throw new Error('缺少预览域名配置');
      window.open(url, '_blank', 'noopener,noreferrer');
    } catch (err) {
      const message = err instanceof ApiError ? err.message : String(err);
      setToast(message);
    }
  }, [state]);

  if (!branchId && !projectId) return <Navigate to="/project-list" replace />;

  const heading =
    state.status === 'ok'
      ? state.branch.branch
      : state.status === 'select'
        ? displayName(state.project)
        : branchId || projectId || '分支详情';
  const listHref =
    state.status === 'ok'
      ? `/branches/${encodeURIComponent(state.branch.projectId)}`
      : projectId
        ? `/branches/${encodeURIComponent(projectId)}`
        : '/project-list';

  return (
    <div className="cds-app-shell">
      <nav className="sticky top-0 flex h-screen flex-col items-center gap-2 border-r border-border px-0 py-4">
        <a className="inline-flex h-11 w-11 items-center justify-center text-muted-foreground hover:text-foreground" href="/project-list" aria-label="项目列表">
          <Home className="h-5 w-5" />
        </a>
        <a className="inline-flex h-11 w-11 items-center justify-center rounded-md bg-accent text-accent-foreground" href={listHref} aria-label="分支列表">
          <TerminalSquare className="h-5 w-5" />
        </a>
        <a className="inline-flex h-11 w-11 items-center justify-center text-muted-foreground hover:text-foreground" href="/cds-settings" aria-label="CDS 系统设置">
          <Cloud className="h-5 w-5" />
        </a>
        <div className="flex-1" />
        <Button variant="ghost" size="icon" onClick={toggle} aria-label="切换主题">
          {theme === 'dark' ? <Sun /> : <Moon />}
        </Button>
      </nav>

      <main className="cds-main">
        <div className="cds-workspace cds-workspace-wide mb-4 flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <div className="cds-breadcrumb mb-4">
              <a className="font-medium text-foreground hover:underline" href="/project-list">CDS</a>
              <span>/</span>
              <a className="font-medium text-foreground hover:underline" href={listHref}>分支</a>
              <span>/</span>
              <span>{heading}</span>
            </div>
            <h1 className="cds-page-title">分支详情</h1>
            <div className="mt-3 flex flex-wrap gap-4 text-sm text-muted-foreground">
              {state.status === 'ok' ? <span>{state.branch.id}</span> : null}
              {state.status === 'ok' ? <span>{statusLabel(state.branch.status)}</span> : null}
              {state.status === 'ok' && state.project ? <span>{displayName(state.project)}</span> : null}
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button asChild variant="outline">
              <a href={listHref}>
                <ArrowLeft />
                分支列表
              </a>
            </Button>
            {state.status === 'ok' ? (
              <Button asChild variant="outline">
                <a href={`/settings/${encodeURIComponent(state.branch.projectId)}`}>
                  <Settings />
                  项目设置
                </a>
              </Button>
            ) : null}
            {state.status === 'ok' ? (
              <Button asChild variant="outline">
                <a href={`/branch-topology?project=${encodeURIComponent(state.branch.projectId)}`}>
                  <TerminalSquare />
                  拓扑
                </a>
              </Button>
            ) : null}
            <Button variant="outline" onClick={() => void load(false)}>
              <RefreshCw />
              刷新
            </Button>
          </div>
        </div>

        {state.status === 'loading' ? (
          <div className="cds-workspace cds-workspace-wide">
            <LoadingBlock label="加载分支详情" />
          </div>
        ) : null}
        {state.status === 'error' ? (
          <div className="cds-workspace cds-workspace-wide">
            <ErrorBlock message={state.message} />
          </div>
        ) : null}
        {state.status === 'select' ? (
          <div className="cds-workspace cds-workspace-wide">
            <BranchSelect project={state.project} branches={state.branches} />
          </div>
        ) : null}

        {state.status === 'ok' ? (
          <div className="cds-workspace cds-workspace-wide grid gap-4 xl:grid-cols-[minmax(0,1fr)_360px]">
            <section className="min-w-0 space-y-5">
              <Card className="rounded-md">
                <CardHeader className="p-5">
                  <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
                    <div className="min-w-0">
                      <CardTitle className="truncate text-lg">{state.branch.branch}</CardTitle>
                      <div className="mt-2 flex flex-wrap gap-2 text-xs">
                        <CodePill>{state.branch.id}</CodePill>
                        <span className={`rounded border px-2 py-0.5 ${statusClass(state.branch.status)}`}>
                          {statusLabel(state.branch.status)}
                        </span>
                        {state.branch.commitSha ? <CodePill>{state.branch.commitSha}</CodePill> : null}
                        {state.branch.pinnedCommit ? <CodePill>pinned {state.branch.pinnedCommit}</CodePill> : null}
                      </div>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      <Button onClick={openPreview} disabled={state.branch.status !== 'running'}>
                        <ExternalLink />
                        打开预览
                      </Button>
                      <Button variant="outline" onClick={() => void deploy()}>
                        <Play />
                        部署全部
                      </Button>
                      {state.branch.pinnedCommit ? (
                        <Button variant="outline" onClick={() => void unpinCommit()}>
                          <RefreshCw />
                          恢复最新
                        </Button>
                      ) : null}
                    </div>
                  </div>
                </CardHeader>
                <CardContent className="space-y-4 p-5 pt-0">
                  <p className="text-sm leading-6 text-muted-foreground">{state.branch.subject || '暂无提交摘要'}</p>
                  <div className="grid gap-3 md:grid-cols-3">
                    <MetricTile label="服务数" value={services.length} />
                    <MetricTile label="部署次数" value={state.branch.deployCount || 0} />
                    <MetricTile label="最近部署" value={formatDate(state.branch.lastDeployAt || state.branch.lastAccessedAt)} />
                  </div>
                  {state.branch.errorMessage ? (
                    <div className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
                      {state.branch.errorMessage}
                    </div>
                  ) : null}
                </CardContent>
              </Card>

              {diagnosticIssues.length > 0 ? (
                <FailureDiagnosticPanel
                  issues={diagnosticIssues}
                  onAction={(issue) => {
                    if (issue.profileId) setSelectedProfileId(issue.profileId);
                    const profile = issue.profileId
                      ? state.profiles.find((item) => item.profileId === issue.profileId)
                      : selectedProfile;
                    if (issue.action === 'command' && profile) {
                      void editProfileTextOverride(profile, 'command');
                    } else if (issue.action === 'image' && profile) {
                      void editProfileTextOverride(profile, 'dockerImage');
                    } else if (issue.action === 'port' && profile) {
                      void editProfilePortOverride(profile);
                    } else if (issue.action === 'logs' && issue.profileId) {
                      void loadContainerLogs(issue.profileId);
                    } else if (issue.profileId) {
                      void verifyRuntime(issue.profileId);
                    } else if (services[0]) {
                      void verifyRuntime(services[0].profileId);
                    }
                  }}
                  onDeploy={(profileId) => void deploy(profileId)}
                />
              ) : null}

              <Card className="rounded-md">
                <CardHeader className="p-5">
                  <CardTitle className="text-base">服务</CardTitle>
                </CardHeader>
                <CardContent className="space-y-3 p-5 pt-0">
                  {services.length === 0 ? (
                    <div className="rounded-md border border-dashed border-border px-4 py-6 text-sm text-muted-foreground">
                      还没有服务。先部署全部服务，CDS 会根据项目 BuildProfile 启动容器。
                    </div>
                  ) : null}
                  {services.map((service) => {
                    const profile = state.profiles.find((item) => item.profileId === service.profileId);
                    return (
                      <button
                        key={service.profileId}
                        type="button"
                        onClick={() => {
                          setSelectedProfileId(service.profileId);
                          void loadContainerLogs(service.profileId);
                        }}
                        className={`w-full rounded-md border p-4 text-left transition-colors ${
                          selectedProfileId === service.profileId ? 'border-primary bg-primary/5' : 'border-border bg-card hover:bg-accent/50'
                        }`}
                      >
                        <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
                          <div className="min-w-0">
                            <div className="flex items-center gap-2">
                              {service.status === 'running' ? <CheckCircle2 className="h-4 w-4 text-emerald-500" /> : <Code2 className="h-4 w-4 text-muted-foreground" />}
                              <span className="font-medium">{profile?.profileName || service.profileId}</span>
                            </div>
                            <div className="mt-2 flex flex-wrap gap-2 text-xs">
                              <CodePill>{service.profileId}</CodePill>
                              <span className={`rounded border px-2 py-0.5 ${statusClass(service.status)}`}>
                                {statusLabel(service.status)}
                              </span>
                              <CodePill>:{service.hostPort}</CodePill>
                              {profile?.hasOverride ? <CodePill>branch override</CodePill> : null}
                            </div>
                          </div>
                          <div className="flex flex-wrap gap-2">
                            <Button
                              type="button"
                              size="sm"
                              variant="outline"
                              onClick={(event) => {
                                event.stopPropagation();
                                void deploy(service.profileId);
                              }}
                            >
                              <Play />
                              重部署
                            </Button>
                            <Button
                              type="button"
                              size="sm"
                              variant="outline"
                              onClick={(event) => {
                                event.stopPropagation();
                                void verifyRuntime(service.profileId);
                              }}
                            >
                              <ShieldCheck />
                              诊断
                            </Button>
                            <Button
                              type="button"
                              size="sm"
                              variant="outline"
                              onClick={(event) => {
                                event.stopPropagation();
                                void forceRebuild(service.profileId);
                              }}
                            >
                              <Trash2 />
                              干净重建
                            </Button>
                          </div>
                        </div>
                        {service.errorMessage ? (
                          <div className="mt-3 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
                            {service.errorMessage}
                          </div>
                        ) : null}
                      </button>
                    );
                  })}
                </CardContent>
              </Card>

              <DisclosurePanel
                icon={<FileText className="h-4 w-4" />}
                title="构建日志"
                subtitle="部署过程和最近构建记录"
                contentClassName="space-y-3 p-5"
              >
                  {action ? (
                    <LogPanel title={action.label} lines={action.log} status={action.status} />
                  ) : state.operationLogs.length === 0 ? (
                    <div className="rounded-md border border-dashed border-border px-4 py-6 text-sm text-muted-foreground">
                      还没有构建记录。
                    </div>
                  ) : (
                    state.operationLogs.slice().reverse().slice(0, 5).map((log) => (
                      <div key={`${log.startedAt}-${log.type}`} className="rounded-md border border-border p-3">
                        <div className="flex flex-wrap items-center gap-2 text-xs">
                          <span className={`rounded border px-2 py-0.5 ${statusClass(log.status)}`}>{statusLabel(log.status)}</span>
                          <CodePill>{log.type}</CodePill>
                          <span className="text-muted-foreground">{formatDate(log.startedAt)}</span>
                        </div>
                        <pre className="mt-3 max-h-44 overflow-auto whitespace-pre-wrap rounded-md bg-muted p-3 font-mono text-xs leading-5">
                          {log.events.slice(-18).map((event) => `[${event.status}] ${event.title || event.step}${event.log ? ` - ${event.log}` : ''}`).join('\n') || '(no log lines)'}
                        </pre>
                      </div>
                    ))
                  )}
              </DisclosurePanel>
            </section>

            <aside className="min-w-0 space-y-5">
              <Card className="rounded-md">
                <CardHeader className="p-5">
                  <div className="flex items-center justify-between gap-3">
                    <CardTitle className="text-base">预览别名</CardTitle>
                    <Button size="sm" variant="outline" onClick={() => void saveAliases()}>
                      <Settings />
                      编辑
                    </Button>
                  </div>
                </CardHeader>
                <CardContent className="space-y-3 p-5 pt-0 text-sm">
                  <Field label="默认地址" value={state.aliases.defaultUrl || multiPreviewUrl(state.branch, state.config) || '未配置'} />
                  {state.aliases.aliases.length > 0 ? (
                    <div className="space-y-2">
                      <div className="text-xs font-semibold uppercase tracking-normal text-muted-foreground">别名</div>
                      {(state.aliases.previewUrls || state.aliases.aliases).map((url) => (
                        <div key={url} className="break-all rounded-md border border-border bg-muted/30 px-3 py-2">
                          {url}
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div className="rounded-md border border-dashed border-border px-3 py-3 text-muted-foreground">
                      暂无别名。别名保存后立即在代理层生效，不需要重部署。
                    </div>
                  )}
                </CardContent>
              </Card>

              <DisclosurePanel
                icon={<TerminalSquare className="h-4 w-4" />}
                title="容器日志"
                subtitle={selectedService?.profileId || '选择服务后查看'}
                contentClassName="p-5"
              >
                  {selectedService ? (
                    <div className="mb-3 flex justify-end">
                      <Button size="sm" variant="outline" onClick={() => void loadContainerLogs(selectedService.profileId)}>
                        <RefreshCw />
                        刷新
                      </Button>
                    </div>
                  ) : null}
                  {selectedService ? (
                    <div className="mb-3 flex flex-wrap gap-2 text-xs">
                      <CodePill>{selectedService.profileId}</CodePill>
                      <CodePill>{selectedService.containerName}</CodePill>
                    </div>
                  ) : null}
                  {containerLogs.status === 'loading' ? <LoadingBlock label="加载容器日志" /> : null}
                  {containerLogs.status === 'error' ? <ErrorBlock message={containerLogs.message} /> : null}
                  {containerLogs.status === 'ok' ? (
                    <pre className="max-h-[420px] overflow-auto whitespace-pre-wrap rounded-md bg-muted p-3 font-mono text-xs leading-5">
                      {containerLogs.logs.trim() || '还没有日志输出'}
                    </pre>
                  ) : null}
                  {containerLogs.status === 'idle' ? (
                    <div className="rounded-md border border-dashed border-border px-4 py-6 text-sm text-muted-foreground">
                      选择一个服务后显示最近容器日志。
                    </div>
                  ) : null}
              </DisclosurePanel>

              <DisclosurePanel
                icon={<Settings className="h-4 w-4" />}
                title="有效配置"
                subtitle="命令 / 镜像 / 端口"
                contentClassName="space-y-3 p-5 text-sm"
              >
                  {selectedProfile ? (
                    <>
                      <div className="flex flex-wrap gap-2">
                        <Button size="sm" variant="outline" onClick={() => void editProfileTextOverride(selectedProfile, 'command')}>
                          <TerminalSquare />
                          覆写命令
                        </Button>
                        <Button size="sm" variant="outline" onClick={() => void editProfileTextOverride(selectedProfile, 'dockerImage')}>
                          <Code2 />
                          覆写镜像
                        </Button>
                        <Button size="sm" variant="outline" onClick={() => void editProfilePortOverride(selectedProfile)}>
                          <Settings />
                          覆写端口
                        </Button>
                        <Button size="sm" variant="outline" onClick={() => void editProfilePathPrefixesOverride(selectedProfile)}>
                          <ExternalLink />
                          路径前缀
                        </Button>
                        {selectedProfile.hasOverride ? (
                          <Button size="sm" variant="outline" onClick={() => void clearProfileOverride(selectedProfile)}>
                            <RefreshCw />
                            恢复公共配置
                          </Button>
                        ) : null}
                      </div>
                      <Field label="镜像" value={selectedProfile.effective?.dockerImage || '未设置'} />
                      <Field label="端口" value={selectedProfile.effective?.containerPort || '未设置'} />
                      <Field label="路径前缀" value={(selectedProfile.effective?.pathPrefixes || []).join(', ') || '默认'} />
                      <div>
                        <div className="mb-1 text-xs font-semibold uppercase tracking-normal text-muted-foreground">命令</div>
                        <pre className="max-h-32 overflow-auto whitespace-pre-wrap rounded-md bg-muted p-3 font-mono text-xs leading-5">
                          {selectedProfile.effective?.command || '未设置'}
                        </pre>
                      </div>
                    </>
                  ) : (
                    <div className="text-muted-foreground">暂无 profile 信息。</div>
                  )}
              </DisclosurePanel>

              <DisclosurePanel
                icon={<ShieldCheck className="h-4 w-4" />}
                title="Bridge 操作"
                subtitle={state.bridgeConnection ? 'widget connected' : 'widget offline'}
                contentClassName="space-y-3 p-5 text-sm"
              >
                  <div className="flex flex-wrap gap-2 text-xs">
                    <span className={`rounded border px-2 py-0.5 ${state.bridgeActive ? statusClass('running') : statusClass('idle')}`}>
                      {state.bridgeActive ? 'session active' : 'session idle'}
                    </span>
                    <span className={`rounded border px-2 py-0.5 ${state.bridgeConnection ? statusClass('running') : statusClass('idle')}`}>
                      {state.bridgeConnection ? 'widget connected' : 'widget offline'}
                    </span>
                  </div>
                  {state.bridgeConnection ? (
                    <Field label="页面" value={state.bridgeConnection.url || '未上报'} />
                  ) : (
                    <div className="rounded-md border border-dashed border-border px-3 py-3 text-muted-foreground">
                      打开分支预览页后，Widget 会建立 Bridge 连接；这里可读取页面状态。
                    </div>
                  )}
                  <div className="flex flex-wrap gap-2">
                    <Button size="sm" variant="outline" onClick={() => void startBridgeSession()}>
                      <Play />
                      激活
                    </Button>
                    <Button size="sm" variant="outline" onClick={() => void readBridgeState()} disabled={!state.bridgeConnection}>
                      <ShieldCheck />
                      读取状态
                    </Button>
                    <Button size="sm" variant="outline" onClick={() => void endBridgeSession()} disabled={!state.bridgeActive && !state.bridgeConnection}>
                      <RefreshCw />
                      结束
                    </Button>
                  </div>
                  {state.bridgeState ? (
                    <pre className="max-h-48 overflow-auto whitespace-pre-wrap rounded-md bg-muted p-3 font-mono text-xs leading-5">
                      {JSON.stringify(state.bridgeState, null, 2)}
                    </pre>
                  ) : null}
              </DisclosurePanel>

              <DisclosurePanel
                icon={<GitCommitHorizontal className="h-4 w-4" />}
                title="最近提交"
                subtitle={`${state.commits.length} 条`}
                contentClassName="space-y-3 p-5"
              >
                  <input
                    value={commitQuery}
                    onChange={(event) => setCommitQuery(event.target.value)}
                    className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm outline-none ring-offset-background placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring"
                    placeholder="搜索提交"
                  />
                  {state.branch.pinnedCommit ? (
                    <div className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
                      当前固定在 {shortCommit(state.branch.pinnedCommit)}。下次部署会恢复到分支最新提交；也可以直接点最新提交旁的“恢复最新”。
                    </div>
                  ) : null}
                  {state.commits.length === 0 ? (
                    <div className="text-sm text-muted-foreground">暂无 git log。</div>
                  ) : null}
                  {state.commits.length > 0 && filteredCommits.length === 0 ? (
                    <div className="rounded-md border border-dashed border-border px-4 py-6 text-sm text-muted-foreground">
                      没有匹配的提交。
                    </div>
                  ) : null}
                  {filteredCommits.map((commit) => {
                    const latestHash = state.commits[0]?.hash;
                    const isActuallyLatest = sameCommit(commit.hash, latestHash);
                    const isPinned = sameCommit(commit.hash, state.branch.pinnedCommit);
                    const isCurrent = state.branch.pinnedCommit
                      ? isPinned
                      : sameCommit(commit.hash, state.branch.commitSha) || isActuallyLatest;
                    return (
                      <div key={commit.hash} className={`rounded-md border p-3 text-sm ${isCurrent ? 'border-primary/50 bg-primary/5' : 'border-border'}`}>
                        <div className="flex items-start justify-between gap-3">
                          <div className="min-w-0">
                            <div className="flex flex-wrap items-center gap-2">
                              {isCurrent ? <CheckCircle2 className="h-4 w-4 text-emerald-500" /> : <GitCommitHorizontal className="h-4 w-4 text-muted-foreground" />}
                              <CodePill>{commit.hash}</CodePill>
                              {isActuallyLatest ? <span className="rounded border border-emerald-500/40 bg-emerald-500/10 px-2 py-0.5 text-xs text-emerald-600 dark:text-emerald-300">最新</span> : null}
                              {isCurrent ? <span className="rounded border border-primary/40 bg-primary/10 px-2 py-0.5 text-xs text-primary">当前</span> : null}
                              {isPinned ? <span className="rounded border border-amber-500/40 bg-amber-500/10 px-2 py-0.5 text-xs text-amber-700 dark:text-amber-300">已固定</span> : null}
                              <span className="text-xs text-muted-foreground">{commit.date}</span>
                            </div>
                            <div className="mt-2 line-clamp-2">{commit.subject}</div>
                            <div className="mt-1 text-xs text-muted-foreground">{commit.author}</div>
                          </div>
                          {isActuallyLatest && state.branch.pinnedCommit ? (
                            <Button size="sm" variant="outline" onClick={() => void unpinCommit()}>
                              <RefreshCw />
                              恢复最新
                            </Button>
                          ) : (
                            <Button size="sm" variant="outline" disabled={isCurrent} onClick={() => void checkoutCommit(commit)}>
                              <GitCommitHorizontal />
                              {isCurrent ? '当前' : '固定'}
                            </Button>
                          )}
                        </div>
                      </div>
                    );
                  })}
              </DisclosurePanel>

              <DisclosurePanel
                icon={<ExternalLink className="h-4 w-4" />}
                title="HTTP 转发日志"
                subtitle={`${state.proxyLogs.length} 条，实时订阅`}
                contentClassName="space-y-3 p-5"
              >
                  <div className="flex gap-2">
                    <input
                      value={proxyLogQuery}
                      onChange={(event) => setProxyLogQuery(event.target.value)}
                      className="h-9 min-w-0 flex-1 rounded-md border border-input bg-background px-3 text-sm outline-none ring-offset-background placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring"
                      placeholder="筛 host / path / 状态"
                    />
                    <Button size="sm" variant="outline" onClick={() => void refreshProxyLogs()}>
                      <RefreshCw />
                      刷新
                    </Button>
                  </div>
                  <div className="grid grid-cols-3 gap-2 text-xs">
                    <MetricTile label="总数" value={proxyLogStats.total} />
                    <MetricTile label="异常" value={proxyLogStats.issues} />
                    <MetricTile label="慢请求" value={proxyLogStats.slow} />
                  </div>
                  {state.proxyLogs.length === 0 ? (
                    <div className="rounded-md border border-dashed border-border px-3 py-4 text-sm text-muted-foreground">
                      暂无该分支的 worker 转发记录。打开预览或访问接口后这里会自动出现。
                    </div>
                  ) : null}
                  {state.proxyLogs.length > 0 && filteredProxyLogs.length === 0 ? (
                    <div className="rounded-md border border-dashed border-border px-3 py-4 text-sm text-muted-foreground">
                      没有匹配的转发记录。
                    </div>
                  ) : null}
                  {filteredProxyLogs.map((event) => (
                    <div key={event.id} className="rounded-md border border-border p-3 text-xs">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className={`rounded border px-2 py-0.5 ${httpStatusClass(event.status)}`}>{event.status}</span>
                        <span className={`rounded border px-2 py-0.5 ${proxyOutcomeClass(event.outcome)}`}>{event.outcome}</span>
                        <CodePill>{event.method}</CodePill>
                        {event.profileId ? <CodePill>{event.profileId}</CodePill> : null}
                        <span className="text-muted-foreground">{formatDurationMs(event.durationMs)}</span>
                      </div>
                      <div className="mt-2 break-all text-sm">{event.host}{event.url}</div>
                      <div className="mt-1 text-muted-foreground">{formatDate(event.ts)}{event.upstream ? ` -> ${event.upstream}` : ''}</div>
                      {event.hint || event.errorMessage ? (
                        <div className="mt-2 text-muted-foreground">{event.hint || event.errorMessage}</div>
                      ) : null}
                    </div>
                  ))}
              </DisclosurePanel>
            </aside>
          </div>
        ) : null}

        {toast ? (
          <div className="fixed bottom-5 right-5 z-50 max-w-sm rounded-md border border-border bg-card px-4 py-3 text-sm shadow-lg" role="status">
            {toast}
          </div>
        ) : null}
      </main>
    </div>
  );
}

function BranchSelect({ project, branches }: { project: ProjectSummary; branches: BranchSummary[] }): JSX.Element {
  return (
    <div className="max-w-5xl space-y-4">
      <div className="rounded-md border border-border bg-card px-5 py-4">
        <h2 className="font-semibold">{displayName(project)}</h2>
        <p className="mt-2 text-sm text-muted-foreground">选择一个分支进入详情面板。</p>
      </div>
      {branches.length === 0 ? (
        <div className="rounded-md border border-dashed border-border px-5 py-8 text-sm text-muted-foreground">
          这个项目还没有跟踪分支。先到分支列表从远程分支创建并部署。
        </div>
      ) : (
        <div className="grid gap-3 md:grid-cols-2">
          {branches.map((branch) => (
            <a key={branch.id} href={`/branch-panel/${encodeURIComponent(branch.id)}?project=${encodeURIComponent(project.id)}`} className="rounded-md border border-border bg-card p-4 hover:bg-accent/50">
              <div className="font-medium">{branch.branch}</div>
              <div className="mt-2 flex flex-wrap gap-2 text-xs">
                <CodePill>{branch.id}</CodePill>
                <span className={`rounded border px-2 py-0.5 ${statusClass(branch.status)}`}>{statusLabel(branch.status)}</span>
              </div>
            </a>
          ))}
        </div>
      )}
      <Button asChild>
        <a href={`/branches/${encodeURIComponent(project.id)}`}>返回分支列表</a>
      </Button>
    </div>
  );
}

function diagnosticActionLabel(issue: DiagnosticIssue): string {
  if (issue.action === 'command') return '补命令';
  if (issue.action === 'image') return '补镜像';
  if (issue.action === 'port') return '补端口';
  if (issue.action === 'logs') return '看日志';
  if (issue.action === 'deploy') return '重部署';
  return '运行诊断';
}

function FailureDiagnosticPanel({
  issues,
  onAction,
  onDeploy,
}: {
  issues: DiagnosticIssue[];
  onAction: (issue: DiagnosticIssue) => void;
  onDeploy: (profileId?: string) => void;
}): JSX.Element {
  const primaryProfileId = issues.find((issue) => issue.profileId)?.profileId;
  return (
    <Card className="rounded-md border-destructive/30">
      <CardHeader className="p-5">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
          <div>
            <CardTitle className="flex items-center gap-2 text-base text-destructive">
              <AlertTriangle className="h-4 w-4" />
              失败诊断
            </CardTitle>
            <p className="mt-2 text-sm leading-6 text-muted-foreground">
              先修配置，再重部署失败服务；日志和运行时诊断作为第二层排查。
            </p>
          </div>
          <Button variant="outline" onClick={() => onDeploy(primaryProfileId)}>
            <Play />
            {primaryProfileId ? `重部署 ${primaryProfileId}` : '重部署全部'}
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-3 p-5 pt-0">
        {issues.map((issue) => (
          <div key={issue.id} className="rounded-md border border-border bg-card px-3 py-3">
            <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <span className={`rounded border px-2 py-0.5 text-xs ${issue.severity === 'error' ? statusClass('error') : statusClass('warning')}`}>
                    {issue.severity === 'error' ? 'error' : 'warning'}
                  </span>
                  {issue.profileId ? <CodePill>{issue.profileId}</CodePill> : null}
                  <span className="font-medium">{issue.title}</span>
                </div>
                <div className="mt-2 text-sm leading-6 text-muted-foreground">{issue.message}</div>
              </div>
              <Button size="sm" variant={issue.action === 'command' || issue.action === 'image' || issue.action === 'port' ? 'default' : 'outline'} onClick={() => onAction(issue)}>
                <Wrench />
                {diagnosticActionLabel(issue)}
              </Button>
            </div>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}

function Field({ label, value }: { label: string; value: string | number }): JSX.Element {
  return (
    <div>
      <div className="text-xs font-semibold uppercase tracking-normal text-muted-foreground">{label}</div>
      <div className="mt-1 break-all">{value}</div>
    </div>
  );
}

function LogPanel({ title, lines, status = 'running' }: { title: string; lines: string[]; status?: ActionState['status'] }): JSX.Element {
  const [copied, setCopied] = useState(false);
  const icon = status === 'done'
    ? <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500" />
    : status === 'error'
      ? <AlertTriangle className="h-3.5 w-3.5 text-destructive" />
      : <Loader2 className="h-3.5 w-3.5 animate-spin" />;
  const text = [title, ...lines].join('\n');
  const suggestion = status === 'error' ? actionLogSuggestion(title, lines) : '';
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      setCopied(false);
    }
  };

  return (
    <div className="rounded-md border border-border bg-muted/40 px-3 py-2 text-xs">
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2 text-muted-foreground">
          {icon}
          <span className="truncate">{title}</span>
        </div>
        <Button size="sm" variant="ghost" className="h-7 shrink-0 px-2 text-xs" onClick={() => void copy()}>
          <Copy className="h-3.5 w-3.5" />
          {copied ? '已复制' : '复制'}
        </Button>
      </div>
      {suggestion ? (
        <div className="mt-2 rounded-md border border-amber-500/30 bg-amber-500/10 px-2 py-1.5 text-amber-700 dark:text-amber-300">
          下一步：{suggestion}
        </div>
      ) : null}
      <pre className="mt-2 max-h-52 overflow-auto whitespace-pre-wrap font-mono text-[11px] leading-5 text-muted-foreground">
        {lines.slice(-24).join('\n') || '等待日志输出...'}
      </pre>
    </div>
  );
}

function actionLogSuggestion(title: string, lines: string[]): string {
  const text = [title, ...lines].join('\n').toLowerCase();
  if (/command|启动命令|no command|missing command|缺少.*命令/.test(text)) {
    return '在“有效配置”里补 command，保存后重部署失败服务。';
  }
  if (/image|pull access denied|manifest|镜像|not found/.test(text)) {
    return '检查 Docker 镜像名和拉取权限；修正镜像后重部署。';
  }
  if (/eaddrinuse|bind|port|端口|address already in use/.test(text)) {
    return '检查端口冲突或 containerPort 配置，修正后重部署。';
  }
  if (/clone|checkout|worktree|fetch|pull|repository|git/.test(text)) {
    return '确认仓库 clone、分支和凭证状态；必要时回项目页重新克隆。';
  }
  if (/capacity|no space|memory|disk|内存|容量/.test(text)) {
    return '先在分支列表右侧运维面板释放容量，再重试部署。';
  }
  return '先看失败服务的构建日志和容器日志；配置无误时重置异常后重部署。';
}
