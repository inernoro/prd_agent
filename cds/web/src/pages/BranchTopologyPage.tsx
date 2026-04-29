import { useCallback, useEffect, useMemo, useState } from 'react';
import { Navigate } from 'react-router-dom';
import {
  AlertCircle,
  ArrowLeft,
  Boxes,
  CheckCircle2,
  Clock3,
  Cloud,
  Copy,
  Database,
  ExternalLink,
  FileText,
  GitBranch,
  GitCommitHorizontal,
  Home,
  Layers3,
  Loader2,
  Moon,
  Network,
  RefreshCw,
  Search,
  Settings,
  Sun,
  TerminalSquare,
} from 'lucide-react';

import { Button } from '@/components/ui/button';
import { DisclosurePanel } from '@/components/ui/disclosure-panel';
import { apiRequest, ApiError } from '@/lib/api';
import { useTheme } from '@/lib/theme';
import { CodePill, ErrorBlock, LoadingBlock } from '@/pages/cds-settings/components';

interface ProjectSummary {
  id: string;
  slug: string;
  name: string;
  aliasName?: string;
  gitRepoUrl?: string;
  githubRepoFullName?: string;
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
  lastDeployAt?: string;
  previewSlug?: string;
}

interface BranchesResponse {
  branches: BranchSummary[];
}

interface BuildProfile {
  id: string;
  projectId: string;
  name: string;
  dockerImage: string;
  workDir: string;
  containerWorkDir?: string;
  command?: string;
  containerPort: number;
  pathPrefixes?: string[];
  dependsOn?: string[];
  activeDeployMode?: string;
  env?: Record<string, string>;
}

interface BuildProfilesResponse {
  profiles: BuildProfile[];
}

interface InfraService {
  id: string;
  projectId: string;
  name: string;
  dockerImage: string;
  containerPort: number;
  hostPort: number;
  containerName: string;
  status: 'running' | 'stopped' | 'error';
  errorMessage?: string;
}

interface InfraResponse {
  services: InfraService[];
}

interface PreviewModeResponse {
  mode: 'simple' | 'port' | 'multi';
}

interface RoutingRule {
  id: string;
  projectId: string;
  name: string;
  type: 'header' | 'domain' | 'pattern';
  match: string;
  branch: string;
  priority: number;
  enabled: boolean;
}

interface RoutingRulesResponse {
  rules: RoutingRule[];
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

type SelectedNode =
  | { kind: 'profile'; id: string }
  | { kind: 'infra'; id: string }
  | null;

type LoadState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | {
      status: 'ok';
      project: ProjectSummary;
      branches: BranchSummary[];
      profiles: BuildProfile[];
      infra: InfraService[];
      routingRules: RoutingRule[];
      previewMode: 'simple' | 'port' | 'multi';
      config: CdsConfigResponse;
    };

function projectIdFromQuery(): string {
  return new URLSearchParams(window.location.search).get('project') || '';
}

function branchIdFromQuery(): string {
  return new URLSearchParams(window.location.search).get('branch') || '';
}

function displayName(project: ProjectSummary): string {
  return project.aliasName || project.name || project.slug || project.id;
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

function statusLabel(status: BranchSummary['status'] | ServiceState['status'] | InfraService['status']): string {
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

function statusTone(status: BranchSummary['status'] | ServiceState['status'] | InfraService['status']): string {
  if (status === 'running') return 'border-emerald-500/30 bg-emerald-500/10 text-emerald-600';
  if (status === 'building' || status === 'starting' || status === 'restarting') {
    return 'border-sky-500/30 bg-sky-500/10 text-sky-600';
  }
  if (status === 'stopping') return 'border-amber-500/30 bg-amber-500/10 text-amber-600';
  if (status === 'error') return 'border-destructive/30 bg-destructive/10 text-destructive';
  return 'border-border bg-muted text-muted-foreground';
}

function serviceForProfile(branch: BranchSummary | null, profileId: string): ServiceState | null {
  if (!branch) return null;
  return Object.values(branch.services || {}).find((service) => service.profileId === profileId) || null;
}

function deployedBranchCount(branches: BranchSummary[], profileId: string): number {
  return branches.filter((branch) => serviceForProfile(branch, profileId)).length;
}

function runningBranchCount(branches: BranchSummary[], profileId: string): number {
  return branches.filter((branch) => serviceForProfile(branch, profileId)?.status === 'running').length;
}

function profilePreviewUrl(
  branch: BranchSummary | null,
  previewMode: 'simple' | 'port' | 'multi',
  config: CdsConfigResponse,
): string {
  if (!branch || branch.status !== 'running') return '';
  if (previewMode === 'multi') return multiPreviewUrl(branch, config);
  if (previewMode === 'simple') return simplePreviewUrl(config);
  return '';
}

function ruleTargetsBranch(rule: RoutingRule, branch: BranchSummary): boolean {
  return rule.branch === branch.id || rule.branch === branch.branch || rule.branch === branch.previewSlug;
}

function serviceCount(branch: BranchSummary | null): number {
  if (!branch) return 0;
  return Object.keys(branch.services || {}).length;
}

function runningServiceCount(branch: BranchSummary | null): number {
  if (!branch) return 0;
  return Object.values(branch.services || {}).filter((service) => service.status === 'running').length;
}

export function BranchTopologyPage(): JSX.Element {
  const { theme, toggle } = useTheme();
  const projectId = projectIdFromQuery();
  const [state, setState] = useState<LoadState>({ status: 'loading' });
  const [selectedBranchId, setSelectedBranchId] = useState(branchIdFromQuery());
  const [selectedNode, setSelectedNode] = useState<SelectedNode>(null);
  const [branchFilter, setBranchFilter] = useState('');
  const [quickBranchName, setQuickBranchName] = useState('');
  const [toast, setToast] = useState('');

  const refresh = useCallback(async (showLoading = false) => {
    if (!projectId) return;
    if (showLoading) setState({ status: 'loading' });
    try {
      const [project, branchesRes, profilesRes, infraRes, routingRulesRes, previewModeRes, config] = await Promise.all([
        apiRequest<ProjectSummary>(`/api/projects/${encodeURIComponent(projectId)}`),
        apiRequest<BranchesResponse>(`/api/branches?project=${encodeURIComponent(projectId)}`),
        apiRequest<BuildProfilesResponse>(`/api/build-profiles?project=${encodeURIComponent(projectId)}`),
        apiRequest<InfraResponse>(`/api/infra?project=${encodeURIComponent(projectId)}`),
        apiRequest<RoutingRulesResponse>(`/api/routing-rules?project=${encodeURIComponent(projectId)}`),
        apiRequest<PreviewModeResponse>(`/api/projects/${encodeURIComponent(projectId)}/preview-mode`).catch(() => ({ mode: 'multi' as const })),
        apiRequest<CdsConfigResponse>('/api/config').catch(() => ({})),
      ]);
      setState({
        status: 'ok',
        project,
        branches: branchesRes.branches || [],
        profiles: profilesRes.profiles || [],
        infra: infraRes.services || [],
        routingRules: routingRulesRes.rules || [],
        previewMode: previewModeRes.mode || 'multi',
        config,
      });
    } catch (err) {
      setState({ status: 'error', message: err instanceof ApiError ? err.message : String(err) });
    }
  }, [projectId]);

  useEffect(() => {
    void refresh(true);
  }, [refresh]);

  useEffect(() => {
    if (!projectId) return;
    const source = new EventSource(`/api/branches/stream?project=${encodeURIComponent(projectId)}`);
    source.addEventListener('snapshot', (ev) => {
      const data = JSON.parse((ev as MessageEvent).data) as { branches?: BranchSummary[] };
      setState((current) => current.status === 'ok' ? { ...current, branches: data.branches || [] } : current);
    });
    source.addEventListener('branch.updated', (ev) => {
      const data = JSON.parse((ev as MessageEvent).data) as { branch?: BranchSummary };
      const nextBranch = data.branch;
      if (!nextBranch) return;
      setState((current) => {
        if (current.status !== 'ok') return current;
        const exists = current.branches.some((branch) => branch.id === nextBranch.id);
        return {
          ...current,
          branches: exists
            ? current.branches.map((branch) => branch.id === nextBranch.id ? { ...branch, ...nextBranch } : branch)
            : [nextBranch, ...current.branches],
        };
      });
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
    if (!projectId) return;
    const params = new URLSearchParams(window.location.search);
    const current = params.get('branch') || '';
    if (current === selectedBranchId) return;
    if (selectedBranchId) params.set('branch', selectedBranchId);
    else params.delete('branch');
    window.history.replaceState(null, '', `${window.location.pathname}?${params.toString()}`);
  }, [projectId, selectedBranchId]);

  const activeBranch = useMemo(() => {
    if (state.status !== 'ok' || !selectedBranchId) return null;
    return state.branches.find((branch) => branch.id === selectedBranchId) || null;
  }, [selectedBranchId, state]);
  const branchOptions = useMemo(() => {
    if (state.status !== 'ok') return [];
    const query = branchFilter.trim().toLowerCase();
    const matches = query
      ? state.branches.filter((branch) => (
        branch.branch.toLowerCase().includes(query)
        || branch.id.toLowerCase().includes(query)
        || branch.status.toLowerCase().includes(query)
      ))
      : state.branches;
    if (!selectedBranchId || matches.some((branch) => branch.id === selectedBranchId)) return matches;
    const selected = state.branches.find((branch) => branch.id === selectedBranchId);
    return selected ? [selected, ...matches] : matches;
  }, [branchFilter, selectedBranchId, state]);
  const branchFilterHasMatches = useMemo(() => {
    if (state.status !== 'ok') return false;
    const query = branchFilter.trim().toLowerCase();
    if (!query) return true;
    return state.branches.some((branch) => (
      branch.branch.toLowerCase().includes(query)
      || branch.id.toLowerCase().includes(query)
      || branch.status.toLowerCase().includes(query)
    ));
  }, [branchFilter, state]);

  const selectedProfile = state.status === 'ok' && selectedNode?.kind === 'profile'
    ? state.profiles.find((profile) => profile.id === selectedNode.id) || null
    : null;
  const selectedInfra = state.status === 'ok' && selectedNode?.kind === 'infra'
    ? state.infra.find((service) => service.id === selectedNode.id) || null
    : null;

  useEffect(() => {
    if (state.status !== 'ok') return;
    if (
      selectedNode
      && (
        (selectedNode.kind === 'profile' && state.profiles.some((profile) => profile.id === selectedNode.id))
        || (selectedNode.kind === 'infra' && state.infra.some((service) => service.id === selectedNode.id))
      )
    ) {
      return;
    }
    const firstProfile = state.profiles[0];
    if (firstProfile) {
      setSelectedNode({ kind: 'profile', id: firstProfile.id });
      return;
    }
    const firstInfra = state.infra[0];
    if (firstInfra) setSelectedNode({ kind: 'infra', id: firstInfra.id });
  }, [selectedNode, state]);

  if (!projectId) return <Navigate to="/project-list" replace />;

  const projectTitle = state.status === 'ok' ? displayName(state.project) : projectId;
  const totalProfiles = state.status === 'ok' ? state.profiles.length : 0;
  const totalInfra = state.status === 'ok' ? state.infra.length : 0;
  const runningBranches = state.status === 'ok' ? state.branches.filter((branch) => branch.status === 'running').length : 0;
  const totalBranches = state.status === 'ok' ? state.branches.length : 0;
  const errorBranches = state.status === 'ok' ? state.branches.filter((branch) => branch.status === 'error').length : 0;
  const runningServices = state.status === 'ok'
    ? state.branches.reduce((sum, branch) => (
      sum + Object.values(branch.services || {}).filter((service) => service.status === 'running').length
    ), 0)
    : 0;
  const activeBranchServiceTotal = serviceCount(activeBranch);
  const activeBranchRunningServices = runningServiceCount(activeBranch);
  const activePreviewUrl = state.status === 'ok' ? profilePreviewUrl(activeBranch, state.previewMode, state.config) : '';
  const openQuickPreview = (branchName: string): void => {
    const next = branchName.trim();
    if (!next) return;
    window.location.href = `/branches/${encodeURIComponent(projectId)}?preview=${encodeURIComponent(next)}`;
  };

  return (
    <div className="cds-app-shell">
      <nav className="sticky top-0 flex h-screen flex-col items-center gap-2 border-r border-border px-0 py-4">
        <a
          className="inline-flex h-11 w-11 items-center justify-center text-muted-foreground transition-colors hover:text-foreground"
          href="/project-list"
          aria-label="项目列表"
        >
          <Home className="h-5 w-5" />
        </a>
        <a
          className="inline-flex h-11 w-11 items-center justify-center rounded-md bg-accent text-accent-foreground"
          href={`/branch-topology?project=${encodeURIComponent(projectId)}`}
          aria-label="服务拓扑"
        >
          <Layers3 className="h-5 w-5" />
        </a>
        <a
          className="inline-flex h-11 w-11 items-center justify-center text-muted-foreground transition-colors hover:text-foreground"
          href={`/branches/${encodeURIComponent(projectId)}`}
          aria-label="分支列表"
        >
          <GitBranch className="h-5 w-5" />
        </a>
        <a
          className="inline-flex h-11 w-11 items-center justify-center text-muted-foreground transition-colors hover:text-foreground"
          href={`/settings/${encodeURIComponent(projectId)}`}
          aria-label="项目设置"
        >
          <Settings className="h-5 w-5" />
        </a>
        <div className="flex-1" />
        <Button variant="ghost" size="icon" onClick={toggle} aria-label="切换主题">
          {theme === 'dark' ? <Sun /> : <Moon />}
        </Button>
      </nav>

      <main className="cds-main">
        <div className="cds-workspace cds-workspace-wide mb-4 overflow-hidden rounded-md border border-border bg-card/75 shadow-sm">
          <div className="flex flex-col gap-4 border-b border-border px-4 py-4 xl:flex-row xl:items-start xl:justify-between">
            <div className="min-w-0">
              <div className="cds-breadcrumb mb-4 max-w-full">
                <a className="font-medium text-foreground hover:underline" href="/project-list">CDS</a>
                <span>/</span>
                <a className="truncate font-medium text-foreground hover:underline" href={`/branches/${encodeURIComponent(projectId)}`}>
                  {projectTitle}
                </a>
                <span>/</span>
                <span className="font-medium text-foreground">服务拓扑</span>
              </div>
              <h1 className="cds-page-title">服务拓扑</h1>
              <div className="cds-page-copy">
                按项目聚合应用服务、基础设施、分支运行态和路由关系。先选分支看当前环境，选共享视图看整体覆盖。
              </div>
            </div>
            <div className="flex shrink-0 flex-wrap gap-2">
              <Button variant="outline" onClick={() => void refresh(false)}>
                <RefreshCw />
                刷新
              </Button>
              <Button asChild variant="outline">
                <a href={`/branches/${encodeURIComponent(projectId)}`}>
                  <ArrowLeft />
                  分支列表
                </a>
              </Button>
            </div>
          </div>

          <div className="grid gap-3 px-4 py-4 md:grid-cols-2 xl:grid-cols-5">
            <TopologyMetric label="应用服务" value={totalProfiles} detail={`${runningServices} 个运行实例`} icon={<Cloud className="h-4 w-4" />} />
            <TopologyMetric label="基础设施" value={totalInfra} detail="项目共享容器" icon={<Database className="h-4 w-4" />} />
            <TopologyMetric label="运行分支" value={`${runningBranches}/${totalBranches}`} detail={errorBranches ? `${errorBranches} 个异常` : '状态正常'} icon={<GitBranch className="h-4 w-4" />} tone={errorBranches ? 'warning' : 'default'} />
            <TopologyMetric label="视图模式" value={activeBranch ? '单分支' : '共享'} detail={activeBranch?.branch || '全部分支'} icon={<Network className="h-4 w-4" />} />
            <TopologyMetric label="预览模式" value={state.status === 'ok' ? state.previewMode : '-'} detail={state.status === 'ok' ? (state.config.previewDomain || state.config.mainDomain || 'localhost') : '-'} icon={<TerminalSquare className="h-4 w-4" />} />
          </div>

          {state.status === 'ok' ? (
            <div className="border-t border-border px-4 py-3">
              <div className="space-y-3">
                <div className="grid gap-3 lg:grid-cols-[220px_minmax(260px,1fr)_minmax(260px,420px)] lg:items-center">
                  <label className="relative block">
                    <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                    <input
                      value={branchFilter}
                      onChange={(event) => setBranchFilter(event.target.value)}
                      className="h-9 w-full rounded-md border border-input bg-background pl-9 pr-3 text-sm outline-none ring-offset-background placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring"
                      placeholder="搜索分支"
                    />
                  </label>
                  <label className="grid gap-1 text-xs text-muted-foreground sm:grid-cols-[52px_minmax(0,1fr)] sm:items-center">
                    <span>分支</span>
                    <select
                      className="h-9 rounded-md border border-input bg-background px-3 text-sm text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      value={selectedBranchId}
                      onChange={(event) => setSelectedBranchId(event.target.value)}
                    >
                      <option value="">共享视图</option>
                      {branchOptions.map((branch) => (
                        <option key={branch.id} value={branch.id}>
                          {branch.branch || branch.id}
                        </option>
                      ))}
                    </select>
                  </label>
                  <form
                    className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto]"
                    onSubmit={(event) => {
                      event.preventDefault();
                      openQuickPreview(quickBranchName);
                    }}
                  >
                    <label className="sr-only" htmlFor="topology-quick-branch">预览分支</label>
                    <div className="flex min-w-0 items-center gap-2 rounded-md border border-input bg-background px-3">
                      <GitBranch className="h-4 w-4 shrink-0 text-muted-foreground" />
                      <input
                        id="topology-quick-branch"
                        value={quickBranchName}
                        onChange={(event) => setQuickBranchName(event.target.value)}
                        className="h-9 min-w-0 flex-1 border-0 bg-transparent font-mono text-sm outline-none placeholder:text-muted-foreground focus-visible:ring-0"
                        placeholder="粘贴分支并预览"
                      />
                    </div>
                    <Button type="submit" variant="outline" disabled={!quickBranchName.trim()}>
                      <ExternalLink />
                      预览
                    </Button>
                  </form>
                  {branchFilter.trim() && !branchFilterHasMatches ? (
                    <div className="text-xs text-muted-foreground lg:col-start-2 lg:col-span-2">
                      没有匹配的已跟踪分支，可直接粘贴分支名预览，或回分支列表处理批量运维。
                    </div>
                  ) : (
                    <div className="text-xs text-muted-foreground lg:col-start-2 lg:col-span-2">
                      {activeBranch ? `当前分支：${activeBranch.branch}` : '共享视图：按所有分支聚合'}
                    </div>
                  )}
                </div>
                <TopologyContextBar
                  projectId={projectId}
                  activeBranch={activeBranch}
                  previewUrl={activePreviewUrl}
                  runningServices={activeBranchRunningServices}
                  totalServices={activeBranchServiceTotal}
                  totalBranches={totalBranches}
                />
              </div>
            </div>
          ) : null}
        </div>

        {state.status === 'loading' ? (
          <div className="cds-workspace cds-workspace-wide">
            <LoadingBlock label="加载服务拓扑" />
          </div>
        ) : null}
        {state.status === 'error' ? (
          <div className="cds-workspace cds-workspace-wide">
            <ErrorBlock message={state.message} />
          </div>
        ) : null}

        {state.status === 'ok' ? (
          <div className="cds-workspace cds-workspace-wide grid gap-4 xl:grid-cols-[minmax(0,1fr)_340px]">
            <section className="min-h-[620px] rounded-md border border-border bg-card p-4">
              {state.profiles.length === 0 && state.infra.length === 0 ? (
                <div className="flex min-h-[540px] flex-col items-center justify-center gap-3 text-center text-sm text-muted-foreground">
                  <Layers3 className="h-10 w-10" />
                  <div className="text-base font-medium text-foreground">还没有服务节点</div>
                  <div>先完成 clone 自动识别，或到项目设置里添加构建配置和基础设施。</div>
                  <Button asChild className="mt-2">
                    <a href={`/settings/${encodeURIComponent(projectId)}`}>打开项目设置</a>
                  </Button>
                </div>
              ) : (
                <div className="space-y-8">
                  <TopologyBand
                    title="应用服务"
                    description={activeBranch ? `当前分支：${activeBranch.branch}` : '共享视图：聚合所有已跟踪分支'}
                    icon={<Cloud className="h-4 w-4" />}
                  >
                    <div className="grid gap-3 md:grid-cols-2 2xl:grid-cols-3">
                      {state.profiles.map((profile) => (
                        <ProfileNode
                          key={profile.id}
                          profile={profile}
                          branches={state.branches}
                          activeBranch={activeBranch}
                          selected={selectedNode?.kind === 'profile' && selectedNode.id === profile.id}
                          onClick={() => setSelectedNode({ kind: 'profile', id: profile.id })}
                        />
                      ))}
                    </div>
                  </TopologyBand>

                  <TopologyBand
                    title="基础设施"
                    description="项目级数据库、缓存和其他共享容器"
                    icon={<Database className="h-4 w-4" />}
                  >
                    {state.infra.length === 0 ? (
                      <div className="rounded-md border border-dashed border-border px-4 py-8 text-sm text-muted-foreground">
                        当前项目没有基础设施服务。
                      </div>
                    ) : (
                      <div className="grid gap-3 md:grid-cols-2 2xl:grid-cols-3">
                        {state.infra.map((service) => (
                          <InfraNode
                            key={service.id}
                            service={service}
                            selected={selectedNode?.kind === 'infra' && selectedNode.id === service.id}
                            onClick={() => setSelectedNode({ kind: 'infra', id: service.id })}
                          />
                        ))}
                      </div>
                    )}
                  </TopologyBand>
                </div>
              )}
            </section>

            <aside className="min-h-[620px] rounded-md border border-border bg-card p-4 xl:sticky xl:top-5 xl:max-h-[calc(100vh-40px)] xl:overflow-auto">
              <NodeDetails
                selectedProfile={selectedProfile}
                selectedInfra={selectedInfra}
                branches={state.branches}
                activeBranch={activeBranch}
                infra={state.infra}
                routingRules={state.routingRules}
                previewMode={state.previewMode}
                config={state.config}
                projectId={projectId}
                onToast={setToast}
              />
            </aside>
          </div>
        ) : null}

        {toast ? (
          <div
            className="fixed bottom-5 right-5 z-50 max-w-sm rounded-md border border-border bg-card px-4 py-3 text-sm shadow-lg"
            role="status"
          >
            {toast}
          </div>
        ) : null}
      </main>
    </div>
  );
}

function TopologyBand({
  title,
  description,
  icon,
  children,
}: {
  title: string;
  description: string;
  icon: JSX.Element;
  children: JSX.Element;
}): JSX.Element {
  return (
    <section className="rounded-md border border-border bg-background/40 p-4">
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <div className="flex h-8 w-8 items-center justify-center rounded-md border border-border bg-background text-muted-foreground">
          {icon}
        </div>
        <div>
          <h2 className="text-sm font-semibold">{title}</h2>
          <div className="text-xs text-muted-foreground">{description}</div>
        </div>
      </div>
      {children}
    </section>
  );
}

function TopologyMetric({
  label,
  value,
  detail,
  icon,
  tone = 'default',
}: {
  label: string;
  value: string | number;
  detail: string;
  icon: JSX.Element;
  tone?: 'default' | 'warning';
}): JSX.Element {
  return (
    <div className="rounded-md border border-border bg-background px-3 py-3">
      <div className="mb-2 flex items-center justify-between gap-3">
        <span className="text-xs font-medium text-muted-foreground">{label}</span>
        <span
          className={
            tone === 'warning'
              ? 'inline-flex h-7 w-7 items-center justify-center rounded-md border border-amber-500/30 bg-amber-500/10 text-amber-500'
              : 'inline-flex h-7 w-7 items-center justify-center rounded-md border border-border bg-muted/30 text-muted-foreground'
          }
        >
          {icon}
        </span>
      </div>
      <div className="truncate text-lg font-semibold">{value}</div>
      <div className="mt-1 truncate text-xs text-muted-foreground">{detail}</div>
    </div>
  );
}

function TopologyContextBar({
  projectId,
  activeBranch,
  previewUrl,
  runningServices,
  totalServices,
  totalBranches,
}: {
  projectId: string;
  activeBranch: BranchSummary | null;
  previewUrl: string;
  runningServices: number;
  totalServices: number;
  totalBranches: number;
}): JSX.Element {
  if (!activeBranch) {
    return (
      <div className="flex flex-col gap-3 rounded-md border border-border bg-background px-3 py-3 text-sm sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <div className="font-medium">共享视图</div>
          <div className="mt-1 text-xs text-muted-foreground">
            聚合 {totalBranches} 个分支的部署覆盖，适合检查服务与基础设施关系。
          </div>
        </div>
        <Button asChild variant="outline" size="sm">
          <a href={`/branches/${encodeURIComponent(projectId)}`}>
            <GitBranch />
            选择或部署分支
          </a>
        </Button>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3 rounded-md border border-border bg-background px-3 py-3 text-sm xl:flex-row xl:items-center xl:justify-between">
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <span className="font-medium">{activeBranch.branch}</span>
        <span className={`rounded-md border px-2 py-1 text-xs ${statusTone(activeBranch.status)}`}>
          {statusLabel(activeBranch.status)}
        </span>
        <CodePill>{runningServices}/{totalServices || 0} 服务运行</CodePill>
        {activeBranch.previewSlug ? <CodePill>{activeBranch.previewSlug}</CodePill> : null}
      </div>
      <div className="flex flex-wrap gap-2">
        {previewUrl ? (
          <Button asChild size="sm">
            <a href={previewUrl} target="_blank" rel="noreferrer">
              <ExternalLink />
              打开预览
            </a>
          </Button>
        ) : null}
        <Button asChild variant={previewUrl ? 'outline' : 'default'} size="sm">
          <a href={`/branch-panel/${encodeURIComponent(activeBranch.id)}?project=${encodeURIComponent(projectId)}`}>
            <TerminalSquare />
            分支详情
          </a>
        </Button>
      </div>
    </div>
  );
}

function ProfileNode({
  profile,
  branches,
  activeBranch,
  selected,
  onClick,
}: {
  profile: BuildProfile;
  branches: BranchSummary[];
  activeBranch: BranchSummary | null;
  selected: boolean;
  onClick: () => void;
}): JSX.Element {
  const activeService = serviceForProfile(activeBranch, profile.id);
  const status = activeBranch ? activeService?.status || 'stopped' : runningBranchCount(branches, profile.id) > 0 ? 'running' : 'stopped';
  const deployed = deployedBranchCount(branches, profile.id);
  const running = runningBranchCount(branches, profile.id);
  const pathPreview = profile.pathPrefixes?.slice(0, 2) || [];
  const coverage = deployed > 0 ? Math.round((running / deployed) * 100) : 0;

  return (
    <button
      type="button"
      onClick={onClick}
      className={[
        'group min-h-40 rounded-md border bg-background px-4 py-3 text-left transition-colors hover:border-primary/60 hover:bg-accent/20',
        selected ? 'border-primary ring-2 ring-primary/20' : 'border-border',
      ].join(' ')}
    >
      <div className="mb-3 flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-start gap-3">
          <StatusGlyph status={status} />
          <div className="min-w-0">
            <div className="truncate font-semibold">{profile.name || profile.id}</div>
            <div className="mt-1 truncate font-mono text-xs text-muted-foreground">{profile.id}</div>
          </div>
        </div>
        <span className={`rounded-md border px-2 py-1 text-xs ${statusTone(status)}`}>
          {statusLabel(status)}
        </span>
      </div>

      <div className="grid grid-cols-3 gap-2 text-xs">
        <NodeMiniStat label="端口" value={profile.containerPort} />
        <NodeMiniStat label="运行" value={activeBranch ? (activeService ? '1' : '0') : `${running}/${deployed}`} />
        <NodeMiniStat label="依赖" value={profile.dependsOn?.length || 0} />
      </div>

      <div className="mt-3 space-y-1.5 text-xs text-muted-foreground">
        <div className="truncate">镜像：{profile.dockerImage}</div>
        <div className="flex flex-wrap gap-1.5">
          {pathPreview.length ? pathPreview.map((path) => <CodePill key={path}>{path}</CodePill>) : <CodePill>默认路由</CodePill>}
          {(profile.pathPrefixes?.length || 0) > 2 ? <CodePill>+{(profile.pathPrefixes?.length || 0) - 2}</CodePill> : null}
        </div>
      </div>

      <div className="mt-3">
        <div className="h-1.5 rounded-full bg-muted">
          <div
            className={status === 'error' ? 'h-1.5 rounded-full bg-destructive' : 'h-1.5 rounded-full bg-primary'}
            style={{ width: `${activeBranch ? (activeService?.status === 'running' ? 100 : 0) : coverage}%` }}
          />
        </div>
      </div>

      <div className="mt-3 flex flex-wrap gap-1.5">
        {activeBranch ? (
          <CodePill>{activeService ? `端口 ${activeService.hostPort}` : '未部署'}</CodePill>
        ) : (
          <CodePill>{deployed} 分支部署过</CodePill>
        )}
      </div>
    </button>
  );
}

function InfraNode({
  service,
  selected,
  onClick,
}: {
  service: InfraService;
  selected: boolean;
  onClick: () => void;
}): JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      className={[
        'group min-h-36 rounded-md border bg-background px-4 py-3 text-left transition-colors hover:border-primary/60 hover:bg-accent/20',
        selected ? 'border-primary ring-2 ring-primary/20' : 'border-border',
      ].join(' ')}
    >
      <div className="mb-3 flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-start gap-3">
          <StatusGlyph status={service.status} />
          <div className="min-w-0">
            <div className="truncate font-semibold">{service.name || service.id}</div>
            <div className="mt-1 truncate font-mono text-xs text-muted-foreground">{service.id}</div>
          </div>
        </div>
        <span className={`rounded-md border px-2 py-1 text-xs ${statusTone(service.status)}`}>
          {statusLabel(service.status)}
        </span>
      </div>
      <div className="grid grid-cols-2 gap-2 text-xs">
        <NodeMiniStat label="宿主端口" value={service.hostPort} />
        <NodeMiniStat label="容器端口" value={service.containerPort} />
      </div>
      <div className="mt-3 space-y-1.5 text-xs text-muted-foreground">
        <div className="truncate">镜像：{service.dockerImage}</div>
        <div className="truncate">容器：{service.containerName}</div>
      </div>
    </button>
  );
}

function StatusGlyph({ status }: { status: BranchSummary['status'] | ServiceState['status'] | InfraService['status'] }): JSX.Element {
  if (status === 'running') {
    return (
      <span className="mt-0.5 inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-emerald-500/30 bg-emerald-500/10 text-emerald-500">
        <CheckCircle2 className="h-4 w-4" />
      </span>
    );
  }
  if (status === 'error') {
    return (
      <span className="mt-0.5 inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-destructive/30 bg-destructive/10 text-destructive">
        <AlertCircle className="h-4 w-4" />
      </span>
    );
  }
  if (status === 'building' || status === 'starting' || status === 'restarting' || status === 'stopping') {
    return (
      <span className="mt-0.5 inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-sky-500/30 bg-sky-500/10 text-sky-500">
        <Clock3 className="h-4 w-4" />
      </span>
    );
  }
  return (
    <span className="mt-0.5 inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-border bg-muted/30 text-muted-foreground">
      <TerminalSquare className="h-4 w-4" />
    </span>
  );
}

function NodeMiniStat({ label, value }: { label: string; value: string | number }): JSX.Element {
  return (
    <div className="rounded-md border border-border bg-muted/20 px-2 py-2">
      <div className="text-[11px] text-muted-foreground">{label}</div>
      <div className="mt-0.5 truncate text-xs font-medium">{value}</div>
    </div>
  );
}

type RuntimeState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | {
      status: 'ok';
      operationLogs: OperationLog[];
      containerLogs: string;
      commits: GitCommit[];
    };

function eventText(event: OperationLogEvent): string {
  return event.title || event.log || event.chunk || event.step || event.status;
}

function profileLogEvents(logs: OperationLog[], profileId: string): OperationLogEvent[] {
  return logs
    .flatMap((log) => log.events || [])
    .filter((event) => {
      const haystack = [event.step, event.title, event.log, event.chunk].filter(Boolean).join(' ');
      return haystack.includes(profileId);
    })
    .slice(-8)
    .reverse();
}

function lastLines(value: string, count = 18): string {
  return value
    .split('\n')
    .filter((line) => line.trim())
    .slice(-count)
    .join('\n');
}

function NodeDetails({
  selectedProfile,
  selectedInfra,
  branches,
  activeBranch,
  infra,
  routingRules,
  previewMode,
  config,
  projectId,
  onToast,
}: {
  selectedProfile: BuildProfile | null;
  selectedInfra: InfraService | null;
  branches: BranchSummary[];
  activeBranch: BranchSummary | null;
  infra: InfraService[];
  routingRules: RoutingRule[];
  previewMode: 'simple' | 'port' | 'multi';
  config: CdsConfigResponse;
  projectId: string;
  onToast: (message: string) => void;
}): JSX.Element {
  const [runtimeState, setRuntimeState] = useState<RuntimeState>({ status: 'idle' });
  const runtimeBranchId = activeBranch?.id || '';
  const runtimeProfileId = selectedProfile?.id || '';

  useEffect(() => {
    if (!runtimeBranchId || !runtimeProfileId) {
      setRuntimeState({ status: 'idle' });
      return;
    }
    const ctrl = new AbortController();
    setRuntimeState({ status: 'loading' });
    Promise.all([
      apiRequest<LogsResponse>(`/api/branches/${encodeURIComponent(runtimeBranchId)}/logs`, { signal: ctrl.signal }).catch(() => ({ logs: [] })),
      apiRequest<ContainerLogsResponse>(`/api/branches/${encodeURIComponent(runtimeBranchId)}/container-logs`, {
        method: 'POST',
        body: { profileId: runtimeProfileId },
        signal: ctrl.signal,
      }).catch(() => ({ logs: '' })),
      apiRequest<GitLogResponse>(`/api/branches/${encodeURIComponent(runtimeBranchId)}/git-log?count=8`, { signal: ctrl.signal }).catch(() => ({ commits: [] })),
    ])
      .then(([operationLogs, containerLogs, commits]) => {
        setRuntimeState({
          status: 'ok',
          operationLogs: operationLogs.logs || [],
          containerLogs: containerLogs.logs || '',
          commits: commits.commits || [],
        });
      })
      .catch((err: unknown) => {
        if ((err as DOMException)?.name === 'AbortError') return;
        setRuntimeState({ status: 'error', message: err instanceof ApiError ? err.message : String(err) });
      });
    return () => ctrl.abort();
  }, [runtimeBranchId, runtimeProfileId]);

  if (!selectedProfile && !selectedInfra) {
    return (
      <div className="flex h-full min-h-[540px] flex-col items-center justify-center gap-3 text-center text-sm text-muted-foreground">
        <Boxes className="h-10 w-10" />
        <div className="text-base font-medium text-foreground">选择一个节点</div>
        <div>点击左侧应用服务或基础设施节点查看运行状态、依赖和跳转入口。</div>
      </div>
    );
  }

  if (selectedInfra) {
    return (
      <div className="space-y-5">
        <DetailHeader icon={<Database className="h-5 w-5" />} title={selectedInfra.name || selectedInfra.id} subtitle="基础设施" />
        <DetailRows
          rows={[
            ['状态', statusLabel(selectedInfra.status)],
            ['镜像', selectedInfra.dockerImage],
            ['容器', selectedInfra.containerName],
            ['宿主端口', String(selectedInfra.hostPort)],
            ['容器端口', String(selectedInfra.containerPort)],
          ]}
        />
        {selectedInfra.errorMessage ? <ErrorBlock message={selectedInfra.errorMessage} /> : null}
        <Button asChild variant="outline">
          <a href={`/settings/${encodeURIComponent(projectId)}#cache`}>打开项目设置</a>
        </Button>
      </div>
    );
  }

  const profile = selectedProfile!;
  const previewUrl = profilePreviewUrl(activeBranch, previewMode, config);
  const branchesUsingProfile = branches.filter((branch) => serviceForProfile(branch, profile.id));
  const envEntries = Object.entries(profile.env || {});
  const profileRules = routingRules
    .filter((rule) => branchesUsingProfile.some((branch) => ruleTargetsBranch(rule, branch)))
    .sort((a, b) => a.priority - b.priority);
  const dependencyNames = (profile.dependsOn || []).map((dep) => {
    const infraMatch = infra.find((service) => service.id === dep);
    return infraMatch ? `${infraMatch.name || infraMatch.id} (${dep})` : dep;
  });
  const activeService = activeBranch ? serviceForProfile(activeBranch, profile.id) : null;
  const routeLabel = profile.pathPrefixes?.join(', ') || '默认路由';
  const serviceStateLabel = activeService ? statusLabel(activeService.status) : branchesUsingProfile.length ? '已部署' : '未部署';

  return (
    <div className="space-y-5">
      <DetailHeader icon={<TerminalSquare className="h-5 w-5" />} title={profile.name || profile.id} subtitle="应用服务" />

      <div className="grid gap-2 sm:grid-cols-4">
        <NodeMiniStat label="状态" value={serviceStateLabel} />
        <NodeMiniStat label="分支" value={branchesUsingProfile.length} />
        <NodeMiniStat label="端口" value={profile.containerPort || '-'} />
        <NodeMiniStat label="路由" value={routeLabel} />
      </div>

      <div className="rounded-md border border-border bg-muted/20 px-3 py-3 text-sm">
        <div className="flex flex-wrap items-center gap-2">
          <CodePill>{profile.id}</CodePill>
          {activeService ? <CodePill>:{activeService.hostPort}</CodePill> : null}
          {previewUrl ? <CodePill>可预览</CodePill> : null}
        </div>
        <div className="mt-2 break-words text-muted-foreground">
          {profile.dockerImage || '未配置镜像'} · {profile.command || '未配置启动命令'}
        </div>
      </div>

      <div className="flex flex-wrap gap-2">
        {activeBranch ? (
          <Button asChild>
            <a href={`/branch-panel/${encodeURIComponent(activeBranch.id)}?project=${encodeURIComponent(projectId)}`}>
              打开分支详情
            </a>
          </Button>
        ) : null}
        {previewUrl ? (
          <Button asChild variant="outline">
            <a href={previewUrl} target="_blank" rel="noreferrer">
              打开预览
            </a>
          </Button>
        ) : null}
        {!previewUrl && activeBranch ? (
          <Button type="button" variant="outline" onClick={() => onToast('当前预览模式需要在分支详情页打开')}>
            预览入口
          </Button>
        ) : null}
      </div>

      <DisclosurePanel icon={<Settings className="h-4 w-4" />} title="配置与依赖" subtitle="镜像、目录、命令和依赖">
        <div className="space-y-5">
          <DetailRows
            rows={[
              ['配置 ID', profile.id],
              ['镜像', profile.dockerImage],
              ['工作目录', profile.workDir || '.'],
              ['容器目录', profile.containerWorkDir || '/app'],
              ['容器端口', String(profile.containerPort)],
              ['路径前缀', routeLabel],
              ['部署模式', profile.activeDeployMode || '默认'],
            ]}
          />
          {profile.command ? (
            <div>
              <div className="mb-2 text-xs font-semibold uppercase tracking-normal text-muted-foreground">启动命令</div>
              <pre className="max-h-36 overflow-auto rounded-md border border-border bg-muted/30 p-3 font-mono text-xs leading-6">
                {profile.command}
              </pre>
            </div>
          ) : null}
          <div>
            <div className="mb-2 text-xs font-semibold uppercase tracking-normal text-muted-foreground">依赖</div>
            <div className="flex flex-wrap gap-1.5">
              {dependencyNames.length === 0 ? <span className="text-sm text-muted-foreground">无</span> : dependencyNames.map((dep) => <CodePill key={dep}>{dep}</CodePill>)}
            </div>
          </div>
        </div>
      </DisclosurePanel>

      <DisclosurePanel icon={<GitBranch className="h-4 w-4" />} title="分支与路由" subtitle={`${branchesUsingProfile.length} 个分支，${profileRules.length} 条规则`}>
        <div className="space-y-4">
          <section className="space-y-3">
            <div className="text-xs font-semibold uppercase tracking-normal text-muted-foreground">分支</div>
          {branchesUsingProfile.length === 0 ? (
            <div className="rounded-md border border-dashed border-border px-3 py-3 text-sm text-muted-foreground">
              还没有分支部署过该服务。
            </div>
          ) : (
            branchesUsingProfile.map((branch) => {
              const service = serviceForProfile(branch, profile.id);
              return (
                <a
                  key={branch.id}
                  href={`/branch-panel/${encodeURIComponent(branch.id)}?project=${encodeURIComponent(projectId)}`}
                  className="block rounded-md border border-border px-3 py-2 text-sm transition-colors hover:bg-accent hover:text-accent-foreground"
                >
                  <div className="flex items-center justify-between gap-3">
                    <span className="truncate">{branch.branch || branch.id}</span>
                    <span className={`shrink-0 rounded-md border px-2 py-1 text-xs ${statusTone(service?.status || branch.status)}`}>
                      {statusLabel(service?.status || branch.status)}
                    </span>
                  </div>
                  <div className="mt-1 flex flex-wrap gap-2 text-xs text-muted-foreground">
                    {service ? <span>:{service.hostPort}</span> : <span>未部署</span>}
                    {branch.lastDeployAt ? <span>{new Date(branch.lastDeployAt).toLocaleString()}</span> : null}
                  </div>
                </a>
              );
            })
          )}
          </section>

          <section className="space-y-3">
            <div className="text-xs font-semibold uppercase tracking-normal text-muted-foreground">路由</div>
          <div className="rounded-md border border-border bg-muted/30 px-3 py-2 text-xs">
            <div className="font-medium text-foreground">路径前缀</div>
            <div className="mt-1 break-words text-muted-foreground">{routeLabel}</div>
          </div>
          {profileRules.length === 0 ? (
            <div className="rounded-md border border-dashed border-border px-3 py-3 text-sm text-muted-foreground">
              暂无指向该服务所在分支的项目路由规则。
            </div>
          ) : (
            profileRules.map((rule) => (
              <div key={rule.id} className="rounded-md border border-border px-3 py-2 text-xs">
                <div className="flex flex-wrap items-center gap-2">
                  <CodePill>{rule.type}</CodePill>
                  <span className={`rounded border px-2 py-0.5 ${rule.enabled ? statusTone('running') : statusTone('stopped')}`}>
                    {rule.enabled ? 'enabled' : 'disabled'}
                  </span>
                  <span className="text-muted-foreground">priority {rule.priority}</span>
                </div>
                <div className="mt-2 break-all text-sm">{rule.name || rule.id}</div>
                <div className="mt-1 break-all text-muted-foreground">{rule.match} {'->'} {rule.branch}</div>
              </div>
            ))
          )}
          </section>
        </div>
      </DisclosurePanel>

      <DisclosurePanel icon={<FileText className="h-4 w-4" />} title="环境变量" subtitle={envEntries.length ? `${envEntries.length} 项显式变量` : '未配置显式变量'}>
        <div className="space-y-3">
          {envEntries.length === 0 ? (
            <div className="rounded-md border border-dashed border-border px-3 py-3 text-sm text-muted-foreground">
              该 BuildProfile 没有显式环境变量。容器运行时合并变量可在分支详情页查看。
            </div>
          ) : (
            envEntries.map(([key, value]) => (
              <div key={key} className="rounded-md border border-border px-3 py-2 text-xs">
                <div className="font-mono font-medium">{key}</div>
                <div className="mt-1 break-all font-mono text-muted-foreground">{value || '(empty)'}</div>
              </div>
            ))
          )}
        </div>
      </DisclosurePanel>

      <DisclosurePanel icon={<GitCommitHorizontal className="h-4 w-4" />} title="日志与提交" subtitle={activeBranch ? '当前分支运行记录' : '选择分支后可用'}>
        <div className="space-y-5">
          <section className="space-y-3">
            <div className="text-xs font-semibold uppercase tracking-normal text-muted-foreground">日志</div>
          {!activeBranch ? (
            <RuntimeEmpty
              icon={<FileText className="h-4 w-4" />}
              title="选择分支后查看运行日志"
              description="共享视图只展示拓扑关系；切到单分支视图后会读取该服务的构建事件和容器日志。"
              actionHref={`/branches/${encodeURIComponent(projectId)}`}
              actionLabel="回到分支列表"
            />
          ) : runtimeState.status === 'loading' ? (
            <div className="flex min-h-32 items-center justify-center rounded-md border border-dashed border-border text-sm text-muted-foreground">
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              加载日志
            </div>
          ) : runtimeState.status === 'error' ? (
            <ErrorBlock message={runtimeState.message} />
          ) : runtimeState.status === 'ok' ? (
            <RuntimeLogs
              branch={activeBranch}
              profile={profile}
              state={runtimeState}
              projectId={projectId}
              onToast={onToast}
            />
          ) : null}
          </section>

          <section className="space-y-3">
            <div className="text-xs font-semibold uppercase tracking-normal text-muted-foreground">提交</div>
          {!activeBranch ? (
            <RuntimeEmpty
              icon={<GitCommitHorizontal className="h-4 w-4" />}
              title="选择分支后查看提交"
              description="提交历史与固定/恢复操作仍由分支详情页承接，拓扑页只做快速定位。"
              actionHref={`/branches/${encodeURIComponent(projectId)}`}
              actionLabel="回到分支列表"
            />
          ) : runtimeState.status === 'loading' ? (
            <div className="flex min-h-32 items-center justify-center rounded-md border border-dashed border-border text-sm text-muted-foreground">
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              加载提交
            </div>
          ) : runtimeState.status === 'error' ? (
            <ErrorBlock message={runtimeState.message} />
          ) : runtimeState.status === 'ok' ? (
            <RuntimeCommits
              branch={activeBranch}
              commits={runtimeState.commits}
              projectId={projectId}
            />
          ) : null}
          </section>
        </div>
      </DisclosurePanel>
    </div>
  );
}

function DetailHeader({
  icon,
  title,
  subtitle,
}: {
  icon: JSX.Element;
  title: string;
  subtitle: string;
}): JSX.Element {
  return (
    <div className="flex items-start gap-3">
      <div className="flex h-10 w-10 items-center justify-center rounded-md border border-border bg-background text-muted-foreground">
        {icon}
      </div>
      <div className="min-w-0">
        <h2 className="truncate text-base font-semibold">{title}</h2>
        <div className="mt-1 text-sm text-muted-foreground">{subtitle}</div>
      </div>
    </div>
  );
}

function DetailRows({ rows }: { rows: Array<[string, string]> }): JSX.Element {
  return (
    <dl className="space-y-3">
      {rows.map(([label, value]) => (
        <div key={label}>
          <dt className="text-xs font-semibold uppercase tracking-normal text-muted-foreground">{label}</dt>
          <dd className="mt-1 break-words text-sm">{value || '-'}</dd>
        </div>
      ))}
    </dl>
  );
}

function RuntimeEmpty({
  icon,
  title,
  description,
  actionHref,
  actionLabel,
}: {
  icon: JSX.Element;
  title: string;
  description: string;
  actionHref: string;
  actionLabel: string;
}): JSX.Element {
  return (
    <div className="rounded-md border border-dashed border-border px-3 py-4">
      <div className="flex items-start gap-3">
        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-border bg-muted/20 text-muted-foreground">
          {icon}
        </div>
        <div className="min-w-0">
          <div className="text-sm font-semibold">{title}</div>
          <div className="mt-1 text-xs leading-5 text-muted-foreground">{description}</div>
          <Button asChild variant="outline" size="sm" className="mt-3">
            <a href={actionHref}>{actionLabel}</a>
          </Button>
        </div>
      </div>
    </div>
  );
}

function RuntimeLogs({
  branch,
  profile,
  state,
  projectId,
  onToast,
}: {
  branch: BranchSummary;
  profile: BuildProfile;
  state: Extract<RuntimeState, { status: 'ok' }>;
  projectId: string;
  onToast: (message: string) => void;
}): JSX.Element {
  const profileEvents = profileLogEvents(state.operationLogs, profile.id);
  const containerLog = lastLines(state.containerLogs);
  const copyText = [
    `branch=${branch.branch}`,
    `profile=${profile.id}`,
    '',
    '[operation events]',
    profileEvents.map((event) => `${event.timestamp || ''} ${event.status} ${eventText(event)}`).join('\n') || '(empty)',
    '',
    '[container logs]',
    containerLog || '(empty)',
  ].join('\n');

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="text-xs text-muted-foreground">
          {branch.branch} · {profile.id}
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => void navigator.clipboard.writeText(copyText).then(() => onToast('拓扑节点日志已复制'))}
        >
          <Copy />
          复制
        </Button>
      </div>

      <section className="rounded-md border border-border bg-muted/20 px-3 py-3">
        <div className="mb-2 text-xs font-semibold uppercase tracking-normal text-muted-foreground">构建事件</div>
        {profileEvents.length === 0 ? (
          <div className="text-sm text-muted-foreground">暂无该服务相关事件。</div>
        ) : (
          <div className="space-y-2">
            {profileEvents.map((event, index) => (
              <div key={`${event.step}-${index}`} className="rounded-md border border-border bg-background px-2 py-2 text-xs">
                <div className="flex flex-wrap items-center gap-2">
                  <CodePill>{event.status || 'event'}</CodePill>
                  {event.timestamp ? <span className="text-muted-foreground">{new Date(event.timestamp).toLocaleString()}</span> : null}
                </div>
                <div className="mt-1 break-words text-sm">{eventText(event)}</div>
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="rounded-md border border-border bg-muted/20 px-3 py-3">
        <div className="mb-2 flex items-center justify-between gap-2">
          <div className="text-xs font-semibold uppercase tracking-normal text-muted-foreground">容器日志</div>
          <a
            className="text-xs text-primary hover:underline"
            href={`/branch-panel/${encodeURIComponent(branch.id)}?project=${encodeURIComponent(projectId)}`}
          >
            详情页
          </a>
        </div>
        <pre className="max-h-56 overflow-auto whitespace-pre-wrap break-words rounded-md border border-border bg-background p-3 font-mono text-[11px] leading-5 text-muted-foreground">
          {containerLog || '还没有日志输出'}
        </pre>
      </section>
    </div>
  );
}

function RuntimeCommits({
  branch,
  commits,
  projectId,
}: {
  branch: BranchSummary;
  commits: GitCommit[];
  projectId: string;
}): JSX.Element {
  if (commits.length === 0) {
    return (
      <div className="rounded-md border border-dashed border-border px-3 py-4 text-sm text-muted-foreground">
        暂无提交历史。可到分支详情页刷新或重新拉取代码。
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="text-xs text-muted-foreground">{branch.branch} · 最近 {commits.length} 条提交</div>
        <Button asChild variant="outline" size="sm">
          <a href={`/branch-panel/${encodeURIComponent(branch.id)}?project=${encodeURIComponent(projectId)}`}>
            分支详情
          </a>
        </Button>
      </div>
      {commits.map((commit, index) => (
        <div key={commit.hash} className="rounded-md border border-border px-3 py-2 text-xs">
          <div className="flex flex-wrap items-center gap-2">
            <CodePill>{commit.hash.slice(0, 8)}</CodePill>
            {index === 0 ? <CodePill>最新</CodePill> : null}
            <span className="text-muted-foreground">{commit.author}</span>
          </div>
          <div className="mt-2 break-words text-sm">{commit.subject}</div>
          <div className="mt-1 text-muted-foreground">{commit.date}</div>
        </div>
      ))}
    </div>
  );
}
