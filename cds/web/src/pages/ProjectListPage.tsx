import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  ArrowRight,
  Bell,
  CheckCircle2,
  Copy,
  Download,
  ExternalLink,
  FileText,
  FolderGit2,
  GitBranch,
  Github,
  KeyRound,
  Loader2,
  Plus,
  RefreshCw,
  Settings,
  Trash2,
  XCircle,
} from 'lucide-react';

import { AppShell, Crumb, TopBar, Workspace } from '@/components/layout/AppShell';
import { Button } from '@/components/ui/button';
import { DisclosurePanel } from '@/components/ui/disclosure-panel';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { apiRequest, ApiError } from '@/lib/api';
import { CodePill, ErrorBlock, LoadingBlock } from '@/pages/cds-settings/components';

interface ProjectSummary {
  id: string;
  slug: string;
  name: string;
  aliasName?: string;
  description?: string;
  kind?: string;
  legacyFlag?: boolean;
  branchCount?: number;
  runningBranchCount?: number;
  runningServiceCount?: number;
  lastDeployedAt?: string | null;
  githubRepoFullName?: string;
  gitRepoUrl?: string;
  cloneStatus?: 'pending' | 'cloning' | 'ready' | 'error';
  cloneError?: string;
}

interface ProjectsResponse {
  projects: ProjectSummary[];
  total: number;
}

interface GithubRepo {
  id: number;
  name: string;
  fullName: string;
  description: string | null;
  isPrivate: boolean;
  cloneUrl: string;
  defaultBranch: string;
  updatedAt: string | null;
  language: string | null;
}

interface GithubReposResponse {
  repos: GithubRepo[];
  hasNext?: boolean;
  page?: number;
}

interface AgentKeySummary {
  id: string;
  label?: string;
  scope?: string;
  createdAt?: string;
  createdBy?: string;
  lastUsedAt?: string;
  revokedAt?: string;
  status?: 'active' | 'revoked';
}

interface AgentKeysResponse {
  keys: AgentKeySummary[];
}

interface AgentKeySignResponse {
  keyId: string;
  plaintext: string;
  preview?: string;
}

interface LegacyCleanupStatus {
  legacyInUse: boolean;
  needsMigration: boolean;
  residualOnly: boolean;
  recommendation?: string;
  counts?: {
    branches?: number;
    buildProfiles?: number;
    infraServices?: number;
    hasLegacyProject?: boolean;
    legacyWorktreeExists?: boolean;
    customEnvScopeExists?: boolean;
  };
}

interface PendingImportSummary {
  id: string;
  projectId: string;
  agentName?: string;
  purpose?: string;
  submittedAt: string;
  decidedAt?: string;
  status: 'pending' | 'approved' | 'rejected';
  rejectReason?: string;
  summary?: {
    addedProfiles?: string[];
    addedInfra?: string[];
    addedEnvKeys?: string[];
  };
}

interface PendingImportsResponse {
  imports: PendingImportSummary[];
  pendingCount: number;
}

interface PendingImportDetail extends PendingImportSummary {
  composeYaml: string;
}

interface PendingImportDetailResponse {
  import: PendingImportDetail;
}

interface PendingImportApproveResponse {
  applied: boolean;
  appliedProfiles?: string[];
  appliedInfra?: string[];
  appliedEnvKeys?: string[];
}

type PendingImportYamlState =
  | { status: 'loading' }
  | { status: 'ok'; yaml: string }
  | { status: 'error'; message: string };

type LoadState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ok'; projects: ProjectSummary[]; legacy: LegacyCleanupStatus | null };

function formatRelativeTime(value?: string | null): string {
  if (!value) return '尚未部署';
  const ts = new Date(value).getTime();
  if (!Number.isFinite(ts)) return '尚未部署';
  const diff = Date.now() - ts;
  const minutes = Math.max(1, Math.round(diff / 60_000));
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  const days = Math.round(hours / 24);
  return `${days} 天前`;
}

function projectHref(project: ProjectSummary): string {
  return `/branches/${encodeURIComponent(project.id)}`;
}

function settingsHref(project: ProjectSummary): string {
  return `/settings/${encodeURIComponent(project.id)}`;
}

function displayName(project: ProjectSummary): string {
  return project.aliasName || project.name || project.slug || project.id;
}

function deriveProjectNameFromGitUrl(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return '';
  const withoutQuery = trimmed.split(/[?#]/)[0].replace(/\/+$/, '');
  const sshMatch = withoutQuery.match(/^git@[^:]+:(.+)$/);
  let pathPart = sshMatch?.[1] || withoutQuery;
  try {
    pathPart = new URL(withoutQuery).pathname;
  } catch {
    pathPart = pathPart.replace(/^ssh:\/\//, '').replace(/^https?:\/\//, '');
  }
  const name = pathPart.replace(/\\/g, '/').split('/').filter(Boolean).pop() || '';
  return name.replace(/\.git$/i, '').trim();
}

function formatDate(value?: string | null): string {
  if (!value) return '暂无';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '暂无';
  return date.toLocaleString();
}

function pendingImportStatusLabel(status: PendingImportSummary['status']): string {
  if (status === 'approved') return '已批准';
  if (status === 'rejected') return '已拒绝';
  return '待处理';
}

function compactList(values: string[] | undefined, empty = '无'): string {
  if (!values || values.length === 0) return empty;
  if (values.length <= 4) return values.join(', ');
  return `${values.slice(0, 4).join(', ')} 等 ${values.length} 项`;
}

export function ProjectListPage(): JSX.Element {
  const [state, setState] = useState<LoadState>({ status: 'loading' });
  const [toast, setToast] = useState('');
  const [createOpen, setCreateOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<ProjectSummary | null>(null);
  const [cloneTarget, setCloneTarget] = useState<ProjectSummary | null>(null);
  const [agentKeyProject, setAgentKeyProject] = useState<ProjectSummary | null>(null);
  const [globalAgentKeyOpen, setGlobalAgentKeyOpen] = useState(false);
  const [legacyDialogOpen, setLegacyDialogOpen] = useState(false);
  const [pendingImportOpen, setPendingImportOpen] = useState(false);
  const [pendingImportFocusId, setPendingImportFocusId] = useState<string | null>(null);
  const [pendingImportError, setPendingImportError] = useState('');
  const [quickRepoUrl, setQuickRepoUrl] = useState('');
  const [quickCreating, setQuickCreating] = useState(false);
  const [pendingImports, setPendingImports] = useState<PendingImportsResponse>({
    imports: [],
    pendingCount: 0,
  });

  const loadPendingImports = useCallback(async (): Promise<PendingImportsResponse | null> => {
    try {
      const data = await apiRequest<PendingImportsResponse>('/api/pending-imports');
      setPendingImports({
        imports: data.imports || [],
        pendingCount: data.pendingCount || 0,
      });
      setPendingImportError('');
      return data;
    } catch (err) {
      const message = err instanceof ApiError ? err.message : String(err);
      setPendingImportError(message);
      return null;
    }
  }, []);

  const refresh = useCallback(async (showLoading = false) => {
    if (showLoading) setState({ status: 'loading' });
    try {
      const [projectsRes, legacyRes] = await Promise.all([
        apiRequest<ProjectsResponse>('/api/projects'),
        apiRequest<LegacyCleanupStatus>('/api/legacy-cleanup/status').catch(() => null),
      ]);
      setState({
        status: 'ok',
        projects: projectsRes.projects || [],
        legacy: legacyRes,
      });
      void loadPendingImports();
    } catch (err) {
      const message = err instanceof ApiError ? err.message : String(err);
      setState({ status: 'error', message });
    }
  }, [loadPendingImports]);

  useEffect(() => {
    void refresh(true);
  }, [refresh]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      void loadPendingImports();
    }, 10000);
    return () => window.clearInterval(timer);
  }, [loadPendingImports]);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get('new') === 'git' || params.get('new') === '1') {
      setCreateOpen(true);
    }
    const pendingImportId = params.get('pendingImport');
    if (pendingImportId) {
      setPendingImportFocusId(pendingImportId);
      setPendingImportOpen(true);
    }
  }, []);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(''), 3200);
    return () => window.clearTimeout(timer);
  }, [toast]);

  const projects = state.status === 'ok' ? state.projects : [];
  const legacy = state.status === 'ok' ? state.legacy : null;
  const activeCount = useMemo(
    () => projects.reduce((sum, project) => sum + (project.runningServiceCount || 0), 0),
    [projects],
  );
  const pendingImportCount = pendingImports.pendingCount || 0;
  const cloneIssueCount = useMemo(
    () => projects.filter((project) => project.cloneStatus === 'pending' || project.cloneStatus === 'error').length,
    [projects],
  );

  async function createProjectFromRepoUrl(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const gitRepoUrl = quickRepoUrl.trim();
    if (!gitRepoUrl) {
      setToast('先粘贴 Git 仓库 URL');
      return;
    }
    const name = deriveProjectNameFromGitUrl(gitRepoUrl);
    if (!name) {
      setToast('无法从仓库 URL 推导项目名，请打开完整新建表单');
      setCreateOpen(true);
      return;
    }
    setQuickCreating(true);
    try {
      const res = await apiRequest<{ project: ProjectSummary }>('/api/projects', {
        method: 'POST',
        body: { name, gitRepoUrl },
      });
      setQuickRepoUrl('');
      setToast(`已创建 ${displayName(res.project)}`);
      if (res.project.cloneStatus === 'pending') setCloneTarget(res.project);
      await refresh(false);
    } catch (err) {
      setToast(err instanceof ApiError ? err.message : String(err));
    } finally {
      setQuickCreating(false);
    }
  }

  /*
   * Render. Layout follows Week 4.6 (Railway-style):
   *   - AppShell handles rail + topbar.
   *   - Topbar holds breadcrumb + inline stats + global actions.
   *   - Hero: single primary input — paste Git URL, press Enter, project created.
   *   - Project grid: minimal cards (title + repo + status + enter button).
   *   - Tools strip: skill pack, global key, agent records — collapsed.
   * Dialogs are unchanged below this function.
   */
  return (
    <AppShell
      active="projects"
      topbar={
        <TopBar
          left={
            <>
              <Crumb items={[{ label: 'CDS', href: '/project-list' }, { label: '项目' }]} />
              {state.status === 'ok' && projects.length > 0 ? (
                <div className="hidden items-center gap-4 border-l border-[hsl(var(--hairline))] pl-4 md:flex">
                  <span className="cds-stat">
                    <span className="cds-stat-value">{projects.length}</span>
                    <span className="cds-stat-label">项目</span>
                  </span>
                  <span className="cds-stat">
                    <span className="cds-stat-value">{activeCount}</span>
                    <span className="cds-stat-label">运行服务</span>
                  </span>
                  {cloneIssueCount + pendingImportCount > 0 ? (
                    <span className="cds-stat">
                      <span className="cds-stat-value text-amber-500">
                        {cloneIssueCount + pendingImportCount}
                      </span>
                      <span className="cds-stat-label">待处理</span>
                    </span>
                  ) : null}
                </div>
              ) : null}
            </>
          }
          right={
            <>
              {pendingImportCount > 0 ? (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setPendingImportOpen(true)}
                  aria-label="打开 Agent 导入记录"
                >
                  <Bell />
                  Agent 申请 {pendingImportCount}
                </Button>
              ) : null}
              <Button
                variant="ghost"
                size="icon"
                onClick={() => void refresh(false)}
                aria-label="刷新项目列表"
                title="刷新"
              >
                <RefreshCw />
              </Button>
              <Button variant="outline" size="sm" onClick={() => setCreateOpen(true)}>
                <Plus />
                新建项目
              </Button>
            </>
          }
        />
      }
    >
      <Workspace>
        {/* Hero: paste Git URL → create. The single most important action on
            this page; everything else is secondary. */}
        <section className="cds-hero">
          <div className="flex flex-wrap items-end justify-between gap-3">
            <div className="min-w-0">
              <h1 className="cds-hero-title">接入仓库</h1>
              <p className="cds-hero-hint">粘贴 Git 仓库 URL，CDS 自动创建项目、克隆代码、识别技术栈。</p>
            </div>
          </div>
          <form
            className="mt-4 grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto_auto] sm:items-center"
            onSubmit={(event) => void createProjectFromRepoUrl(event)}
          >
            <label className="sr-only" htmlFor="quick-git-repo-url">
              Git 仓库 URL
            </label>
            <input
              id="quick-git-repo-url"
              className="h-11 min-w-0 rounded-md border border-[hsl(var(--hairline))] bg-[hsl(var(--surface-sunken))] px-3.5 font-mono text-sm outline-none ring-offset-background placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring"
              value={quickRepoUrl}
              onChange={(event) => setQuickRepoUrl(event.target.value)}
              placeholder="https://github.com/owner/repo.git  或  git@github.com:owner/repo.git"
              autoComplete="off"
              spellCheck={false}
            />
            <Button type="submit" disabled={quickCreating || !quickRepoUrl.trim()}>
              {quickCreating ? <Loader2 className="animate-spin" /> : <ArrowRight />}
              创建并克隆
            </Button>
            <Button type="button" variant="outline" onClick={() => setCreateOpen(true)}>
              <Github />
              从 GitHub 选
            </Button>
          </form>
        </section>

        {legacy?.legacyInUse ? (
          <div className="mt-4">
            <LegacyBanner
              status={legacy}
              onMigrate={() => setLegacyDialogOpen(true)}
              onCleanup={async () => {
                try {
                  await apiRequest('/api/legacy-cleanup/cleanup-residual', { method: 'POST' });
                  setToast('已清理 default 残留');
                  await refresh(false);
                } catch (err) {
                  setToast(err instanceof ApiError ? err.message : String(err));
                }
              }}
            />
          </div>
        ) : null}

        {/* Projects */}
        <section className="mt-6">
          {state.status === 'loading' ? <LoadingBlock label="加载项目列表" /> : null}
          {state.status === 'error' ? <ErrorBlock message={state.message} /> : null}
          {state.status === 'ok' && projects.length === 0 ? (
            <EmptyProjects onCreate={() => setCreateOpen(true)} />
          ) : null}
          {state.status === 'ok' && projects.length > 0 ? (
            <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
              {projects.map((project) => (
                <ProjectCard
                  key={project.id}
                  project={project}
                  onClone={() => setCloneTarget(project)}
                  onAgentKeys={() => setAgentKeyProject(project)}
                  onDelete={() => setDeleteTarget(project)}
                />
              ))}
            </div>
          ) : null}
        </section>

        {/* Tools strip — secondary surface, collapsed by default. */}
        <section className="mt-6 cds-surface-raised cds-hairline">
          <DisclosurePanel
            title="自动化工具"
            subtitle="技能包、Agent 全局 Key、Agent 申请记录"
            summaryClassName="px-4 py-3"
            contentClassName="px-4 pb-4"
          >
            <div className="flex flex-wrap gap-2">
              <Button asChild variant="outline" size="sm">
                <a href="/api/export-skill" download>
                  <Download />
                  下载技能包
                </a>
              </Button>
              <Button variant="outline" size="sm" onClick={() => setGlobalAgentKeyOpen(true)}>
                <KeyRound />
                全局 Agent Key
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setPendingImportOpen(true)}
                aria-label="打开 Agent 导入记录"
              >
                <FileText />
                Agent 申请记录
              </Button>
            </div>
          </DisclosurePanel>
        </section>

        <CreateProjectDialog
          open={createOpen}
          onOpenChange={setCreateOpen}
          onCreated={async (project) => {
            setToast(`已创建 ${displayName(project)}`);
            if (project.cloneStatus === 'pending') setCloneTarget(project);
            await refresh(false);
          }}
        />
        <CloneProgressDialog
          project={cloneTarget}
          onOpenChange={(open) => {
            if (!open) setCloneTarget(null);
          }}
          onDone={async () => {
            await refresh(false);
          }}
        />
        <AgentKeyManagerDialog
          project={agentKeyProject}
          onOpenChange={(open) => {
            if (!open) setAgentKeyProject(null);
          }}
          onToast={setToast}
        />
        <GlobalAgentKeyManagerDialog
          open={globalAgentKeyOpen}
          onOpenChange={setGlobalAgentKeyOpen}
          onToast={setToast}
        />
        <PendingImportDialog
          open={pendingImportOpen}
          onOpenChange={(open) => {
            setPendingImportOpen(open);
            if (!open) setPendingImportFocusId(null);
          }}
          data={pendingImports}
          error={pendingImportError}
          focusId={pendingImportFocusId}
          projects={projects}
          onReload={loadPendingImports}
          onChanged={async () => {
            await refresh(false);
            await loadPendingImports();
          }}
          onToast={setToast}
        />
        <DeleteProjectDialog
          project={deleteTarget}
          onOpenChange={(open) => {
            if (!open) setDeleteTarget(null);
          }}
          onDeleted={async () => {
            setToast('项目已删除');
            setDeleteTarget(null);
            await refresh(false);
          }}
        />
        <LegacyMigrateDialog
          open={legacyDialogOpen}
          onOpenChange={setLegacyDialogOpen}
          onDone={async () => {
            setToast('default 项目已迁移');
            await refresh(false);
          }}
        />

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

function PendingImportDialog({
  open,
  onOpenChange,
  data,
  error,
  focusId,
  projects,
  onReload,
  onChanged,
  onToast,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  data: PendingImportsResponse;
  error: string;
  focusId: string | null;
  projects: ProjectSummary[];
  onReload: () => Promise<PendingImportsResponse | null>;
  onChanged: () => Promise<void>;
  onToast: (message: string) => void;
}): JSX.Element {
  const [expandedYaml, setExpandedYaml] = useState<Record<string, boolean>>({});
  const [yamlById, setYamlById] = useState<Record<string, PendingImportYamlState>>({});
  const [approveTarget, setApproveTarget] = useState<PendingImportSummary | null>(null);
  const [rejectTarget, setRejectTarget] = useState<PendingImportSummary | null>(null);
  const [rejectReason, setRejectReason] = useState('');
  const [acting, setActing] = useState(false);
  const [actionError, setActionError] = useState('');
  const focusedImportRef = useRef<HTMLDivElement | null>(null);

  const projectsById = useMemo(() => {
    return new Map(projects.map((project) => [project.id, displayName(project)]));
  }, [projects]);

  const imports = data.imports || [];
  const pending = imports.filter((item) => item.status === 'pending');
  const decided = imports.filter((item) => item.status !== 'pending');

  useEffect(() => {
    if (!open) return;
    void onReload();
  }, [onReload, open]);

  useEffect(() => {
    if (!open || !focusId) return;
    const timer = window.setTimeout(() => {
      focusedImportRef.current?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }, 120);
    return () => window.clearTimeout(timer);
  }, [focusId, imports.length, open]);

  useEffect(() => {
    if (!rejectTarget) {
      setRejectReason('');
      setActionError('');
    }
  }, [rejectTarget]);

  async function loadYaml(importId: string): Promise<void> {
    setYamlById((current) => ({ ...current, [importId]: { status: 'loading' } }));
    try {
      const detail = await apiRequest<PendingImportDetailResponse>(
        `/api/pending-imports/${encodeURIComponent(importId)}`,
      );
      setYamlById((current) => ({
        ...current,
        [importId]: { status: 'ok', yaml: detail.import.composeYaml || '' },
      }));
    } catch (err) {
      setYamlById((current) => ({
        ...current,
        [importId]: {
          status: 'error',
          message: err instanceof ApiError ? err.message : String(err),
        },
      }));
    }
  }

  function toggleYaml(importId: string): void {
    const willOpen = !expandedYaml[importId];
    setExpandedYaml((current) => ({ ...current, [importId]: willOpen }));
    if (willOpen && !yamlById[importId]) {
      void loadYaml(importId);
    }
  }

  async function approveImport(): Promise<void> {
    if (!approveTarget) return;
    setActing(true);
    setActionError('');
    try {
      const result = await apiRequest<PendingImportApproveResponse>(
        `/api/pending-imports/${encodeURIComponent(approveTarget.id)}/approve`,
        { method: 'POST' },
      );
      const profileCount = result.appliedProfiles?.length || 0;
      const infraCount = result.appliedInfra?.length || 0;
      const envCount = result.appliedEnvKeys?.length || 0;
      onToast(`已应用 Agent 配置：${profileCount} profiles / ${infraCount} infra / ${envCount} env`);
      setApproveTarget(null);
      await onChanged();
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setActing(false);
    }
  }

  async function rejectImport(): Promise<void> {
    if (!rejectTarget) return;
    setActing(true);
    setActionError('');
    try {
      await apiRequest(`/api/pending-imports/${encodeURIComponent(rejectTarget.id)}/reject`, {
        method: 'POST',
        body: { reason: rejectReason.trim() || undefined },
      });
      onToast('已拒绝 Agent 配置申请');
      setRejectTarget(null);
      await onChanged();
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setActing(false);
    }
  }

  function renderImport(item: PendingImportSummary): JSX.Element {
    const summary = item.summary || {};
    const projectName = projectsById.get(item.projectId) || `已删除或未知项目 ${item.projectId}`;
    const isPending = item.status === 'pending';
    const yamlState = yamlById[item.id];
    const yamlOpen = Boolean(expandedYaml[item.id]);
    const focused = focusId === item.id;

    return (
      <div
        key={item.id}
        ref={focused ? focusedImportRef : undefined}
        data-pending-import-id={item.id}
        className={[
          'rounded-md border bg-card px-4 py-4',
          focused ? 'border-primary ring-2 ring-primary/25' : 'border-border',
          isPending ? '' : 'opacity-80',
        ].join(' ')}
      >
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-semibold">{item.agentName || '未知 Agent'}</span>
              <CodePill>{pendingImportStatusLabel(item.status)}</CodePill>
              <CodePill>{formatRelativeTime(item.submittedAt)}</CodePill>
            </div>
            <div className="mt-2 text-sm text-muted-foreground">
              目标项目：<span className="font-medium text-foreground">{projectName}</span>
            </div>
          </div>
          {item.status === 'approved' ? (
            <CheckCircle2 className="h-5 w-5 shrink-0 text-emerald-500" />
          ) : item.status === 'rejected' ? (
            <XCircle className="h-5 w-5 shrink-0 text-destructive" />
          ) : (
            <Bell className="h-5 w-5 shrink-0 text-primary" />
          )}
        </div>

        {item.purpose ? (
          <p className="mt-3 text-sm leading-6 text-muted-foreground">{item.purpose}</p>
        ) : null}

        <div className="mt-3 grid gap-2 text-xs sm:grid-cols-3">
          <div className="cds-surface-sunken cds-hairline px-3 py-2">
            <div className="mb-1 font-medium text-muted-foreground">Profiles</div>
            <div className="break-words text-foreground">{compactList(summary.addedProfiles)}</div>
          </div>
          <div className="cds-surface-sunken cds-hairline px-3 py-2">
            <div className="mb-1 font-medium text-muted-foreground">Infra</div>
            <div className="break-words text-foreground">{compactList(summary.addedInfra)}</div>
          </div>
          <div className="cds-surface-sunken cds-hairline px-3 py-2">
            <div className="mb-1 font-medium text-muted-foreground">Env</div>
            <div className="break-words text-foreground">{compactList(summary.addedEnvKeys)}</div>
          </div>
        </div>

        <div className="mt-3">
          <Button type="button" variant="outline" size="sm" onClick={() => toggleYaml(item.id)}>
            <FileText />
            {yamlOpen ? '收起 YAML' : '预览 YAML'}
          </Button>
          {yamlOpen ? (
            <div className="mt-3 cds-surface-sunken cds-hairline">
              {yamlState?.status === 'ok' ? (
                <pre className="max-h-80 overflow-auto whitespace-pre-wrap break-words p-3 font-mono text-xs leading-6">
                  {yamlState.yaml}
                </pre>
              ) : yamlState?.status === 'error' ? (
                <div className="px-3 py-3 text-sm text-destructive">{yamlState.message}</div>
              ) : (
                <div className="flex items-center gap-2 px-3 py-3 text-sm text-muted-foreground">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  加载 YAML
                </div>
              )}
            </div>
          ) : null}
        </div>

        {item.status === 'rejected' && item.rejectReason ? (
          <div className="mt-3 rounded-md border border-destructive/20 bg-destructive/10 px-3 py-2 text-sm text-muted-foreground">
            拒绝理由：{item.rejectReason}
          </div>
        ) : null}

        {isPending ? (
          <div className="mt-4 flex flex-wrap gap-2">
            <Button type="button" size="sm" onClick={() => setApproveTarget(item)}>
              <CheckCircle2 />
              批准并应用
            </Button>
            <Button type="button" size="sm" variant="outline" onClick={() => setRejectTarget(item)}>
              <XCircle />
              拒绝
            </Button>
          </div>
        ) : null}
      </div>
    );
  }

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="max-h-[86vh] max-w-5xl overflow-hidden p-0">
          <DialogHeader className="border-b border-border px-6 py-5">
            <DialogTitle>Agent 导入记录</DialogTitle>
            <DialogDescription>
              Agent 提交的 CDS Compose 会在这里等待人工批准；批准后写入目标项目配置。
            </DialogDescription>
          </DialogHeader>

          <div className="min-h-0 space-y-4 overflow-y-auto px-6 pb-6">
            <div className="flex flex-wrap items-center justify-between gap-3 pt-1 text-sm text-muted-foreground">
              <div className="flex flex-wrap gap-3">
                <span>{pending.length} 个待处理</span>
                <span>{decided.length} 个最近处理</span>
              </div>
              <Button type="button" variant="outline" size="sm" onClick={() => void onReload()}>
                <RefreshCw />
                刷新
              </Button>
            </div>

            {error ? <ErrorBlock message={error} /> : null}

            {imports.length === 0 && !error ? (
              <div className="rounded-md border border-dashed border-border px-4 py-10 text-center text-sm text-muted-foreground">
                暂无 Agent 配置申请。Agent 调用 <CodePill>POST /api/projects/:id/pending-import</CodePill> 后会出现在这里。
              </div>
            ) : null}

            {pending.length > 0 ? (
              <section className="space-y-3">
                <h3 className="text-sm font-semibold">待处理</h3>
                {pending.map(renderImport)}
              </section>
            ) : null}

            {decided.length > 0 ? (
              <section className="space-y-3 border-t border-border pt-4">
                <h3 className="text-sm font-semibold">最近处理</h3>
                {decided.map(renderImport)}
              </section>
            ) : null}
          </div>
        </DialogContent>
      </Dialog>

      <Dialog
        open={Boolean(approveTarget)}
        onOpenChange={(nextOpen) => {
          if (!nextOpen) {
            setApproveTarget(null);
            setActionError('');
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>批准 Agent 配置</DialogTitle>
            <DialogDescription>
              {approveTarget
                ? `将把 ${approveTarget.agentName || 'Agent'} 提交的 profiles、infra 和 env 写入目标项目。`
                : ''}
            </DialogDescription>
          </DialogHeader>
          {approveTarget ? (
            <div className="space-y-2 cds-surface-sunken cds-hairline px-3 py-3 text-sm">
              <div>目标项目：{projectsById.get(approveTarget.projectId) || approveTarget.projectId}</div>
              <div>Profiles：{compactList(approveTarget.summary?.addedProfiles)}</div>
              <div>Infra：{compactList(approveTarget.summary?.addedInfra)}</div>
              <div>Env：{compactList(approveTarget.summary?.addedEnvKeys)}</div>
            </div>
          ) : null}
          {actionError ? (
            <div className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
              {actionError}
            </div>
          ) : null}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setApproveTarget(null)}>
              取消
            </Button>
            <Button type="button" onClick={() => void approveImport()} disabled={acting}>
              {acting ? <Loader2 className="animate-spin" /> : <CheckCircle2 />}
              确认应用
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={Boolean(rejectTarget)}
        onOpenChange={(nextOpen) => {
          if (!nextOpen) setRejectTarget(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>拒绝 Agent 配置</DialogTitle>
            <DialogDescription>拒绝只会记录原因，不会改动项目配置。</DialogDescription>
          </DialogHeader>
          <label className="block space-y-1.5">
            <span className="text-sm font-medium">拒绝理由</span>
            <textarea
              className="min-h-24 w-full resize-y rounded-md border border-input bg-background px-3 py-2 text-sm outline-none ring-offset-background focus-visible:ring-2 focus-visible:ring-ring"
              value={rejectReason}
              onChange={(event) => setRejectReason(event.target.value)}
              maxLength={500}
              placeholder="可选"
            />
          </label>
          {actionError ? (
            <div className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
              {actionError}
            </div>
          ) : null}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setRejectTarget(null)}>
              取消
            </Button>
            <Button type="button" variant="destructive" onClick={() => void rejectImport()} disabled={acting}>
              {acting ? <Loader2 className="animate-spin" /> : <XCircle />}
              确认拒绝
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

function LegacyBanner({
  status,
  onMigrate,
  onCleanup,
}: {
  status: LegacyCleanupStatus;
  onMigrate: () => void;
  onCleanup: () => void;
}): JSX.Element {
  const counts = status.counts || {};
  const countText = `${counts.branches || 0} 分支 / ${counts.buildProfiles || 0} profile / ${counts.infraServices || 0} infra`;

  return (
    <div className="mb-5 flex flex-col gap-3 rounded-md border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-sm lg:flex-row lg:items-center lg:justify-between">
      <div className="flex gap-3">
        <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-amber-500" />
        <div>
          <div className="font-semibold text-foreground">
            {status.needsMigration ? '检测到遗留 default 数据' : '检测到 default 残留'}
          </div>
          <div className="mt-1 text-muted-foreground">
            {status.needsMigration ? countText : status.recommendation || '只剩残留目录或空占位。'}
          </div>
        </div>
      </div>
      <Button size="sm" onClick={status.needsMigration ? onMigrate : onCleanup}>
        {status.needsMigration ? '迁移' : '清理残留'}
        <ArrowRight />
      </Button>
    </div>
  );
}

function EmptyProjects({ onCreate }: { onCreate: () => void }): JSX.Element {
  return (
    <div className="cds-surface-raised cds-hairline px-6 py-12">
      <div className="mx-auto flex max-w-xl flex-col items-center text-center">
        <div className="flex h-12 w-12 items-center justify-center rounded-full bg-primary/10 text-primary">
          <FolderGit2 />
        </div>
        <h2 className="mt-5 text-lg font-semibold">还没有项目</h2>
        <p className="mt-2 max-w-md text-sm leading-6 text-muted-foreground">
          粘贴上方仓库 URL 创建第一个项目，CDS 会自动 clone、识别栈并生成默认构建配置。
        </p>
        <div className="mt-5">
          <Button onClick={onCreate}>
            <Plus />
            新建项目
          </Button>
        </div>
      </div>
    </div>
  );
}

/*
 * ProjectCard — Railway-style minimal tile.
 *
 * Whole card is a navigation target (link). Status, repo and small metrics
 * sit inline; secondary actions hide in a corner button row that doesn't
 * compete with the primary "enter project" affordance.
 */
function ProjectCard({
  project,
  onClone,
  onAgentKeys,
  onDelete,
}: {
  project: ProjectSummary;
  onClone: () => void;
  onAgentKeys: () => void;
  onDelete: () => void;
}): JSX.Element {
  const title = displayName(project);
  const repo = project.githubRepoFullName || project.gitRepoUrl;
  const isReady = !project.cloneStatus || project.cloneStatus === 'ready';
  const cloneLabel =
    project.cloneStatus === 'pending'
      ? '待克隆'
      : project.cloneStatus === 'cloning'
        ? '克隆中'
        : project.cloneStatus === 'error'
          ? '克隆失败'
          : null;
  const dotTone = project.cloneStatus === 'error'
    ? 'bg-destructive'
    : project.cloneStatus === 'pending' || project.cloneStatus === 'cloning'
      ? 'bg-amber-500'
      : project.runningServiceCount && project.runningServiceCount > 0
        ? 'bg-emerald-500'
        : 'bg-muted-foreground/40';

  return (
    <article className="group relative min-w-0 rounded-md border border-[hsl(var(--hairline))] bg-[hsl(var(--surface-raised))] transition-[border-color,box-shadow,transform] duration-150 hover:-translate-y-0.5 hover:border-[hsl(var(--hairline-strong))] hover:shadow-md">
      <a
        href={isReady ? projectHref(project) : '#'}
        onClick={(event) => {
          if (!isReady) event.preventDefault();
        }}
        className="block px-4 py-4 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded-md"
      >
        <div className="flex items-start gap-3">
          <span className={`mt-1.5 inline-block h-2 w-2 shrink-0 rounded-full ${dotTone}`} aria-hidden />
          <div className="min-w-0 flex-1">
            <div className="flex items-start justify-between gap-3">
              <h2 className="truncate text-[15px] font-semibold tracking-tight">{title}</h2>
              {!isReady && cloneLabel ? (
                <span className="shrink-0 text-xs font-medium text-muted-foreground">{cloneLabel}</span>
              ) : null}
            </div>
            <div className="mt-1 flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
              {repo ? (
                <>
                  <Github className="h-3.5 w-3.5 shrink-0" />
                  <span className="truncate">{repo}</span>
                </>
              ) : (
                <span>未绑定仓库</span>
              )}
            </div>
          </div>
        </div>

        {project.cloneStatus === 'error' && project.cloneError ? (
          <div className="mt-3 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs leading-5 text-destructive">
            {project.cloneError}
          </div>
        ) : null}

        <div className="mt-4 flex items-center justify-between text-xs text-muted-foreground">
          <div className="flex items-center gap-4">
            <span className="inline-flex items-center gap-1">
              <GitBranch className="h-3.5 w-3.5" />
              <span className="font-medium tabular-nums text-foreground">{project.branchCount || 0}</span>
              分支
            </span>
            <span className="inline-flex items-center gap-1">
              <span className="font-medium tabular-nums text-foreground">{project.runningServiceCount || 0}</span>
              运行
            </span>
            <span className="hidden sm:inline">{formatRelativeTime(project.lastDeployedAt)}</span>
          </div>
          {isReady ? (
            <span className="inline-flex items-center gap-1 text-foreground/70 transition-colors group-hover:text-foreground">
              进入
              <ArrowRight className="h-4 w-4" />
            </span>
          ) : null}
        </div>
      </a>

      {/* Action row: secondary, never competes with the card link. */}
      <div className="flex items-center gap-1 border-t border-[hsl(var(--hairline))] px-2 py-1.5">
        {project.cloneStatus === 'pending' || project.cloneStatus === 'error' ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={(event) => {
              event.stopPropagation();
              onClone();
            }}
          >
            <FolderGit2 />
            {project.cloneStatus === 'error' ? '重新克隆' : '开始克隆'}
          </Button>
        ) : null}
        <Button asChild variant="ghost" size="sm" title="项目设置">
          <a href={settingsHref(project)}>
            <Settings />
            设置
          </a>
        </Button>
        <Button
          variant="ghost"
          size="sm"
          onClick={(event) => {
            event.stopPropagation();
            onAgentKeys();
          }}
          title="Agent Key"
        >
          <KeyRound />
          Key
        </Button>
        <div className="flex-1" />
        <Button
          variant="ghost"
          size="icon"
          onClick={(event) => {
            event.stopPropagation();
            onDelete();
          }}
          disabled={project.legacyFlag}
          aria-label={`删除 ${title}`}
          title={project.legacyFlag ? 'legacy 项目需要先迁移' : '删除项目'}
        >
          <Trash2 />
        </Button>
      </div>
    </article>
  );
}

type CloneLogEntry = { text: string; tone?: 'info' | 'error' | 'success' };

function CloneProgressDialog({
  project,
  onOpenChange,
  onDone,
}: {
  project: ProjectSummary | null;
  onOpenChange: (open: boolean) => void;
  onDone: () => Promise<void>;
}): JSX.Element {
  const [status, setStatus] = useState<'idle' | 'cloning' | 'ready' | 'error'>('idle');
  const [logs, setLogs] = useState<CloneLogEntry[]>([]);
  const [startedProjectId, setStartedProjectId] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const logRef = useRef<HTMLDivElement | null>(null);

  const appendLog = useCallback((text: string, tone?: CloneLogEntry['tone']) => {
    setLogs((current) => [...current, { text, tone }]);
  }, []);

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight });
  }, [logs]);

  const startClone = useCallback(async () => {
    if (!project) return;
    const activeProject = project;
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setStartedProjectId(activeProject.id);
    setStatus('cloning');
    setLogs([{ text: `POST /api/projects/${activeProject.id}/clone`, tone: 'info' }]);

    try {
      const res = await fetch(`/api/projects/${encodeURIComponent(activeProject.id)}/clone`, {
        method: 'POST',
        credentials: 'include',
        headers: { Accept: 'text/event-stream' },
        signal: controller.signal,
      });
      if (!res.ok) {
        const text = await res.text();
        let message = text || `HTTP ${res.status}`;
        try {
          const parsed = JSON.parse(text) as { message?: string; error?: string };
          message = parsed.message || parsed.error || message;
        } catch {
          // keep text
        }
        throw new Error(message);
      }
      if (!res.body) throw new Error('当前浏览器不支持流式读取 clone 日志');

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let sawTerminalEvent = false;

      function processBuffer(): void {
        let index = buffer.indexOf('\n\n');
        while (index >= 0) {
          const block = buffer.slice(0, index);
          buffer = buffer.slice(index + 2);
          const eventName = block.match(/^event: (.+)$/m)?.[1]?.trim();
          const dataText = block.match(/^data: (.+)$/m)?.[1]?.trim();
          if (!eventName || !dataText) {
            index = buffer.indexOf('\n\n');
            continue;
          }
          let data: { line?: string; message?: string; gitRepoUrl?: string; repoPath?: string } = {};
          try {
            data = JSON.parse(dataText) as typeof data;
          } catch {
            data = { line: dataText };
          }
          if (eventName === 'start') {
            appendLog(`${data.gitRepoUrl || activeProject.gitRepoUrl || ''} -> ${data.repoPath || ''}`.trim(), 'info');
          } else if (eventName === 'progress') {
            appendLog(data.line || '');
          } else if (eventName === 'complete') {
            sawTerminalEvent = true;
            setStatus('ready');
            appendLog(`项目已就绪: ${data.repoPath || ''}`, 'success');
          } else if (eventName === 'error') {
            sawTerminalEvent = true;
            setStatus('error');
            appendLog(data.message || 'clone failed', 'error');
          }
          index = buffer.indexOf('\n\n');
        }
      }

      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        buffer += decoder.decode(chunk.value, { stream: true });
        processBuffer();
      }
      if (!sawTerminalEvent) {
        setStatus('error');
        appendLog('clone stream ended unexpectedly', 'error');
      }
      await onDone();
    } catch (err) {
      if ((err as DOMException).name === 'AbortError') {
        appendLog('clone request aborted', 'error');
        return;
      }
      setStatus('error');
      appendLog(err instanceof Error ? err.message : String(err), 'error');
      await onDone();
    }
  }, [appendLog, onDone, project]);

  useEffect(() => {
    if (!project) return;
    setStatus('idle');
    setLogs([]);
    setStartedProjectId(null);
  }, [project]);

  useEffect(() => {
    if (project && startedProjectId !== project.id && status === 'idle') {
      void startClone();
    }
  }, [project, startedProjectId, startClone, status]);

  useEffect(() => {
    return () => {
      abortRef.current?.abort();
    };
  }, []);

  const title = project ? displayName(project) : '';
  const canRetry = project && status === 'error';

  return (
    <Dialog open={Boolean(project)} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>克隆项目仓库</DialogTitle>
          <DialogDescription>
            {project ? `${title} · ${project.gitRepoUrl || '未配置仓库 URL'}` : ''}
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-wrap items-center gap-2">
          <CodePill>
            {status === 'cloning' ? '克隆中' : status === 'ready' ? '已就绪' : status === 'error' ? '失败' : '等待'}
          </CodePill>
          {status === 'cloning' ? <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" /> : null}
        </div>
        <div
          ref={logRef}
          className="max-h-80 min-h-56 overflow-y-auto cds-surface-raised cds-hairline p-3 font-mono text-xs leading-6"
        >
          {logs.length === 0 ? (
            <div className="text-muted-foreground">等待 clone 日志。</div>
          ) : (
            logs.map((entry, index) => (
              <div
                key={`${entry.text}-${index}`}
                className={
                  entry.tone === 'error'
                    ? 'whitespace-pre-wrap break-words text-destructive'
                    : entry.tone === 'success'
                      ? 'whitespace-pre-wrap break-words text-emerald-500'
                      : 'whitespace-pre-wrap break-words text-muted-foreground'
                }
              >
                {entry.text}
              </div>
            ))
          )}
        </div>
        <DialogFooter>
          {canRetry ? (
            <Button type="button" variant="outline" onClick={() => void startClone()}>
              <RefreshCw />
              重试
            </Button>
          ) : null}
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            {status === 'cloning' ? '隐藏' : '关闭'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function AgentKeyManagerDialog({
  project,
  onOpenChange,
  onToast,
}: {
  project: ProjectSummary | null;
  onOpenChange: (open: boolean) => void;
  onToast: (message: string) => void;
}): JSX.Element {
  const [state, setState] = useState<
    | { status: 'idle' }
    | { status: 'loading' }
    | { status: 'error'; message: string }
    | { status: 'ok'; keys: AgentKeySummary[] }
  >({ status: 'idle' });
  const [signOpen, setSignOpen] = useState(false);
  const [revokeTarget, setRevokeTarget] = useState<AgentKeySummary | null>(null);

  const loadKeys = useCallback(async () => {
    if (!project) return;
    setState({ status: 'loading' });
    try {
      const data = await apiRequest<AgentKeysResponse>(`/api/projects/${encodeURIComponent(project.id)}/agent-keys`);
      setState({ status: 'ok', keys: data.keys || [] });
    } catch (err) {
      setState({ status: 'error', message: err instanceof ApiError ? err.message : String(err) });
    }
  }, [project]);

  useEffect(() => {
    if (project) void loadKeys();
    else setState({ status: 'idle' });
  }, [loadKeys, project]);

  return (
    <>
      <Dialog open={Boolean(project)} onOpenChange={onOpenChange}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Agent Key 管理</DialogTitle>
            <DialogDescription>
              {project ? `${displayName(project)} · 项目级 key 只能操作当前项目。` : ''}
            </DialogDescription>
          </DialogHeader>

          <div className="flex flex-wrap gap-2">
            <Button type="button" onClick={() => setSignOpen(true)}>
              <KeyRound />
              签发新 Key
            </Button>
            <Button type="button" variant="outline" onClick={() => void loadKeys()}>
              <RefreshCw />
              刷新
            </Button>
          </div>

          {state.status === 'loading' ? <LoadingBlock label="加载 Agent Keys" /> : null}
          {state.status === 'error' ? <ErrorBlock message={state.message} /> : null}
          {state.status === 'ok' && state.keys.length === 0 ? (
            <div className="rounded-md border border-dashed border-border px-4 py-8 text-center text-sm text-muted-foreground">
              还没有项目级 Agent Key。
            </div>
          ) : null}
          {state.status === 'ok' && state.keys.length > 0 ? (
            <div className="space-y-2">
              {state.keys.map((key) => (
                <div key={key.id} className="cds-surface-raised cds-hairline px-3 py-3">
                  <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-medium">{key.label || key.id}</span>
                        <CodePill>{key.revokedAt ? '已吊销' : '有效'}</CodePill>
                        <CodePill>{key.scope || 'rw'}</CodePill>
                      </div>
                      <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
                        <span>签发：{formatDate(key.createdAt)}</span>
                        <span>最近使用：{formatDate(key.lastUsedAt)}</span>
                        {key.createdBy ? <span>签发人：{key.createdBy}</span> : null}
                      </div>
                    </div>
                    {!key.revokedAt ? (
                      <Button type="button" variant="outline" size="sm" onClick={() => setRevokeTarget(key)}>
                        <Trash2 />
                        吊销
                      </Button>
                    ) : null}
                  </div>
                </div>
              ))}
            </div>
          ) : null}

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              关闭
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AgentKeySignDialog
        project={project}
        open={signOpen}
        onOpenChange={setSignOpen}
        onSigned={async () => {
          await loadKeys();
        }}
        onToast={onToast}
      />
      <AgentKeyRevokeDialog
        project={project}
        target={revokeTarget}
        onOpenChange={(open) => {
          if (!open) setRevokeTarget(null);
        }}
        onRevoked={async () => {
          setRevokeTarget(null);
          await loadKeys();
        }}
        onToast={onToast}
      />
    </>
  );
}

function GlobalAgentKeyManagerDialog({
  open,
  onOpenChange,
  onToast,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onToast: (message: string) => void;
}): JSX.Element {
  const [state, setState] = useState<
    | { status: 'idle' }
    | { status: 'loading' }
    | { status: 'error'; message: string }
    | { status: 'ok'; keys: AgentKeySummary[] }
  >({ status: 'idle' });
  const [signOpen, setSignOpen] = useState(false);
  const [revokeTarget, setRevokeTarget] = useState<AgentKeySummary | null>(null);

  const loadKeys = useCallback(async () => {
    setState({ status: 'loading' });
    try {
      const data = await apiRequest<AgentKeysResponse>('/api/global-agent-keys');
      setState({ status: 'ok', keys: data.keys || [] });
    } catch (err) {
      setState({ status: 'error', message: err instanceof ApiError ? err.message : String(err) });
    }
  }, []);

  useEffect(() => {
    if (open) void loadKeys();
    else setState({ status: 'idle' });
  }, [loadKeys, open]);

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Agent 全局通行证</DialogTitle>
            <DialogDescription>
              全局通行证可跨项目操作并创建新项目；优先给自动化引导 Agent 使用，单项目操作仍建议用项目级 Key。
            </DialogDescription>
          </DialogHeader>

          <div className="flex flex-wrap gap-2">
            <Button type="button" onClick={() => setSignOpen(true)}>
              <KeyRound />
              签发全局 Key
            </Button>
            <Button type="button" variant="outline" onClick={() => void loadKeys()}>
              <RefreshCw />
              刷新
            </Button>
          </div>

          {state.status === 'loading' ? <LoadingBlock label="加载全局 Agent Keys" /> : null}
          {state.status === 'error' ? <ErrorBlock message={state.message} /> : null}
          {state.status === 'ok' && state.keys.length === 0 ? (
            <div className="rounded-md border border-dashed border-border px-4 py-8 text-center text-sm text-muted-foreground">
              还没有全局 Agent Key。
            </div>
          ) : null}
          {state.status === 'ok' && state.keys.length > 0 ? (
            <div className="space-y-2">
              {state.keys.map((key) => (
                <div key={key.id} className="cds-surface-raised cds-hairline px-3 py-3">
                  <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-medium">{key.label || key.id}</span>
                        <CodePill>{key.revokedAt ? '已吊销' : '有效'}</CodePill>
                        <CodePill>{key.scope || 'rw'}</CodePill>
                      </div>
                      <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
                        <span>签发：{formatDate(key.createdAt)}</span>
                        <span>最近使用：{formatDate(key.lastUsedAt)}</span>
                        {key.createdBy ? <span>签发人：{key.createdBy}</span> : null}
                      </div>
                    </div>
                    {!key.revokedAt ? (
                      <Button type="button" variant="outline" size="sm" onClick={() => setRevokeTarget(key)}>
                        <Trash2 />
                        吊销
                      </Button>
                    ) : null}
                  </div>
                </div>
              ))}
            </div>
          ) : null}

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              关闭
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <GlobalAgentKeySignDialog
        open={signOpen}
        onOpenChange={setSignOpen}
        onSigned={async () => {
          await loadKeys();
        }}
        onToast={onToast}
      />
      <GlobalAgentKeyRevokeDialog
        target={revokeTarget}
        onOpenChange={(nextOpen) => {
          if (!nextOpen) setRevokeTarget(null);
        }}
        onRevoked={async () => {
          setRevokeTarget(null);
          await loadKeys();
        }}
        onToast={onToast}
      />
    </>
  );
}

function GlobalAgentKeySignDialog({
  open,
  onOpenChange,
  onSigned,
  onToast,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSigned: () => Promise<void>;
  onToast: (message: string) => void;
}): JSX.Element {
  const [label, setLabel] = useState('');
  const [signing, setSigning] = useState(false);
  const [error, setError] = useState('');
  const [signed, setSigned] = useState<AgentKeySignResponse | null>(null);

  useEffect(() => {
    if (!open) {
      setLabel('');
      setError('');
      setSigned(null);
      setSigning(false);
    }
  }, [open]);

  async function sign(): Promise<void> {
    setSigning(true);
    setError('');
    try {
      const data = await apiRequest<AgentKeySignResponse>('/api/global-agent-keys', {
        method: 'POST',
        body: { label: label.trim() || undefined },
      });
      setSigned(data);
      await onSigned();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setSigning(false);
    }
  }

  const codeText = signed
    ? [`CDS_HOST=${window.location.origin}`, `AI_ACCESS_KEY=${signed.plaintext}`].join('\n')
    : '';

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{signed ? '全局 Key 已签发' : '签发 Agent 全局 Key'}</DialogTitle>
          <DialogDescription>
            {signed
              ? '明文只显示一次。关闭后 CDS 只保留 sha256 摘要，无法再次查看。'
              : '这会创建一把跨项目访问密钥，可创建项目、提交配置申请和触发部署。'}
          </DialogDescription>
        </DialogHeader>

        {signed ? (
          <div className="space-y-4">
            <pre className="overflow-x-auto cds-surface-raised cds-hairline p-3 font-mono text-xs leading-6">
              {codeText}
            </pre>
            <Button
              type="button"
              onClick={() => {
                void navigator.clipboard.writeText(codeText).then(() => onToast('全局 Agent Key 已复制'));
              }}
            >
              <Copy />
              复制全部
            </Button>
          </div>
        ) : (
          <div className="space-y-4">
            <label className="block space-y-1.5">
              <span className="text-sm font-medium">标签</span>
              <input
                className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm outline-none ring-offset-background focus-visible:ring-2 focus-visible:ring-ring"
                value={label}
                onChange={(event) => setLabel(event.target.value)}
                maxLength={100}
                placeholder="例如 Codex 自动接入"
              />
            </label>
            <div className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm leading-6 text-muted-foreground">
              全局 Key 权限高于项目级 Key。只交给需要创建项目或跨项目自动化的 Agent，用完请吊销。
            </div>
            {error ? (
              <div className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
                {error}
              </div>
            ) : null}
          </div>
        )}

        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            {signed ? '关闭' : '取消'}
          </Button>
          {!signed ? (
            <Button type="button" onClick={() => void sign()} disabled={signing}>
              {signing ? <Loader2 className="animate-spin" /> : <KeyRound />}
              确认签发
            </Button>
          ) : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function GlobalAgentKeyRevokeDialog({
  target,
  onOpenChange,
  onRevoked,
  onToast,
}: {
  target: AgentKeySummary | null;
  onOpenChange: (open: boolean) => void;
  onRevoked: () => Promise<void>;
  onToast: (message: string) => void;
}): JSX.Element {
  const [revoking, setRevoking] = useState(false);

  async function revoke(): Promise<void> {
    if (!target) return;
    setRevoking(true);
    try {
      await apiRequest(`/api/global-agent-keys/${encodeURIComponent(target.id)}`, { method: 'DELETE' });
      onToast('全局 Agent Key 已吊销');
      await onRevoked();
    } catch (err) {
      onToast(err instanceof ApiError ? err.message : String(err));
    } finally {
      setRevoking(false);
    }
  }

  return (
    <Dialog open={Boolean(target)} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>吊销全局 Agent Key</DialogTitle>
          <DialogDescription>
            吊销后该 key 会立即失效，无法恢复。目标：{target?.label || target?.id || ''}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            取消
          </Button>
          <Button type="button" variant="destructive" onClick={() => void revoke()} disabled={revoking}>
            {revoking ? <Loader2 className="animate-spin" /> : <Trash2 />}
            确认吊销
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function AgentKeySignDialog({
  project,
  open,
  onOpenChange,
  onSigned,
  onToast,
}: {
  project: ProjectSummary | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSigned: () => Promise<void>;
  onToast: (message: string) => void;
}): JSX.Element {
  const [label, setLabel] = useState('');
  const [signing, setSigning] = useState(false);
  const [error, setError] = useState('');
  const [signed, setSigned] = useState<AgentKeySignResponse | null>(null);

  useEffect(() => {
    if (!open) {
      setLabel('');
      setError('');
      setSigned(null);
      setSigning(false);
    }
  }, [open]);

  async function sign(): Promise<void> {
    if (!project) return;
    setSigning(true);
    setError('');
    try {
      const data = await apiRequest<AgentKeySignResponse>(
        `/api/projects/${encodeURIComponent(project.id)}/agent-keys`,
        {
          method: 'POST',
          body: { label: label.trim() || undefined },
        },
      );
      setSigned(data);
      await onSigned();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setSigning(false);
    }
  }

  const codeText =
    project && signed
      ? [`CDS_HOST=${window.location.origin}`, `CDS_PROJECT_ID=${project.id}`, `CDS_PROJECT_KEY=${signed.plaintext}`].join('\n')
      : '';

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{signed ? 'Agent Key 已签发' : '签发项目级 Agent Key'}</DialogTitle>
          <DialogDescription>
            {signed
              ? '明文只显示一次。关闭后 CDS 只保留 sha256 摘要，无法再次查看。'
              : '这会创建一把新的项目级访问密钥，持有者可操作当前项目。'}
          </DialogDescription>
        </DialogHeader>

        {signed ? (
          <div className="space-y-4">
            <pre className="overflow-x-auto cds-surface-raised cds-hairline p-3 font-mono text-xs leading-6">
              {codeText}
            </pre>
            <Button
              type="button"
              onClick={() => {
                void navigator.clipboard.writeText(codeText).then(() => onToast('Agent Key 已复制'));
              }}
            >
              <Copy />
              复制全部
            </Button>
          </div>
        ) : (
          <div className="space-y-4">
            <label className="block space-y-1.5">
              <span className="text-sm font-medium">标签</span>
              <input
                className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm outline-none ring-offset-background focus-visible:ring-2 focus-visible:ring-ring"
                value={label}
                onChange={(event) => setLabel(event.target.value)}
                maxLength={100}
                placeholder="例如 Codex 本地调试"
              />
            </label>
            <div className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm text-muted-foreground">
              签发后请只交给需要操作此项目的 Agent。用完可在管理列表吊销。
            </div>
            {error ? (
              <div className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
                {error}
              </div>
            ) : null}
          </div>
        )}

        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            {signed ? '关闭' : '取消'}
          </Button>
          {!signed ? (
            <Button type="button" onClick={() => void sign()} disabled={signing}>
              {signing ? <Loader2 className="animate-spin" /> : <KeyRound />}
              确认签发
            </Button>
          ) : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function AgentKeyRevokeDialog({
  project,
  target,
  onOpenChange,
  onRevoked,
  onToast,
}: {
  project: ProjectSummary | null;
  target: AgentKeySummary | null;
  onOpenChange: (open: boolean) => void;
  onRevoked: () => Promise<void>;
  onToast: (message: string) => void;
}): JSX.Element {
  const [revoking, setRevoking] = useState(false);

  async function revoke(): Promise<void> {
    if (!project || !target) return;
    setRevoking(true);
    try {
      await apiRequest(
        `/api/projects/${encodeURIComponent(project.id)}/agent-keys/${encodeURIComponent(target.id)}`,
        { method: 'DELETE' },
      );
      onToast('Agent Key 已吊销');
      await onRevoked();
    } catch (err) {
      onToast(err instanceof ApiError ? err.message : String(err));
    } finally {
      setRevoking(false);
    }
  }

  return (
    <Dialog open={Boolean(target)} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>吊销 Agent Key</DialogTitle>
          <DialogDescription>
            吊销后该 key 会立即失效，无法恢复。目标：{target?.label || target?.id || ''}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            取消
          </Button>
          <Button type="button" variant="destructive" onClick={() => void revoke()} disabled={revoking}>
            {revoking ? <Loader2 className="animate-spin" /> : <Trash2 />}
            确认吊销
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function CreateProjectDialog({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: (project: ProjectSummary) => Promise<void>;
}): JSX.Element {
  const [name, setName] = useState('');
  const [gitRepoUrl, setGitRepoUrl] = useState('');
  const [description, setDescription] = useState('');
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [repoPickerOpen, setRepoPickerOpen] = useState(false);

  useEffect(() => {
    if (!open) setRepoPickerOpen(false);
  }, [open]);

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setError('');
    const trimmedRepoUrl = gitRepoUrl.trim();
    const trimmedName = name.trim() || deriveProjectNameFromGitUrl(trimmedRepoUrl);
    if (!trimmedName) {
      setError('项目名称或 Git 仓库 URL 至少填一个');
      return;
    }
    setSubmitting(true);
    try {
      const res = await apiRequest<{ project: ProjectSummary }>('/api/projects', {
        method: 'POST',
        body: {
          name: trimmedName,
          gitRepoUrl: trimmedRepoUrl || undefined,
          description: description.trim() || undefined,
        },
      });
      setName('');
      setGitRepoUrl('');
      setDescription('');
      onOpenChange(false);
      await onCreated(res.project);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>新建项目</DialogTitle>
            <DialogDescription>粘贴 Git 仓库 URL 即可创建；项目名称留空时会自动用仓库名。</DialogDescription>
          </DialogHeader>
          <form className="space-y-4" onSubmit={(event) => void handleSubmit(event)}>
            <label className="block space-y-1.5">
              <span className="text-sm font-medium">项目名称</span>
              <input
                className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm outline-none ring-offset-background focus-visible:ring-2 focus-visible:ring-ring"
                value={name}
                onChange={(event) => setName(event.target.value)}
                autoFocus
                maxLength={60}
                placeholder="可选，默认使用仓库名"
              />
            </label>
            <label className="block space-y-1.5">
              <span className="text-sm font-medium">Git 仓库 URL</span>
              <div className="flex flex-col gap-2 sm:flex-row">
                <input
                  className="h-10 min-w-0 flex-1 rounded-md border border-input bg-background px-3 font-mono text-sm outline-none ring-offset-background focus-visible:ring-2 focus-visible:ring-ring"
                  value={gitRepoUrl}
                  onChange={(event) => setGitRepoUrl(event.target.value)}
                  placeholder="https://github.com/org/repo.git"
                />
                <Button type="button" variant="outline" onClick={() => setRepoPickerOpen(true)}>
                  <Github />
                  从 GitHub 选择
                </Button>
              </div>
            </label>
            <label className="block space-y-1.5">
              <span className="text-sm font-medium">备注</span>
              <textarea
                className="min-h-20 w-full resize-y rounded-md border border-input bg-background px-3 py-2 text-sm outline-none ring-offset-background focus-visible:ring-2 focus-visible:ring-ring"
                value={description}
                onChange={(event) => setDescription(event.target.value)}
                maxLength={240}
              />
            </label>
            {error ? (
              <div className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
                {error}
              </div>
            ) : null}
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
                取消
              </Button>
              <Button type="submit" disabled={submitting}>
                {submitting ? <Loader2 className="animate-spin" /> : <Plus />}
                创建
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
      <GithubRepoPickerDialog
        open={repoPickerOpen}
        onOpenChange={setRepoPickerOpen}
        onPick={(repo) => {
          setGitRepoUrl(repo.cloneUrl);
          if (!name.trim()) setName(repo.name);
          setRepoPickerOpen(false);
        }}
      />
    </>
  );
}

function GithubRepoPickerDialog({
  open,
  onOpenChange,
  onPick,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onPick: (repo: GithubRepo) => void;
}): JSX.Element {
  const [state, setState] = useState<
    | { status: 'idle' }
    | { status: 'loading' }
    | { status: 'error'; message: string; action?: 'connect' | 'configure' }
    | { status: 'ok'; repos: GithubRepo[]; hasNext: boolean; nextPage: number }
  >({ status: 'idle' });
  const [query, setQuery] = useState('');
  const [loadingMore, setLoadingMore] = useState(false);

  const loadPage = useCallback(async (page: number) => {
    if (page === 1) setState({ status: 'loading' });
    else setLoadingMore(true);
    try {
      const data = await apiRequest<GithubReposResponse>(`/api/github/repos?page=${page}`);
      const repos = data.repos || [];
      setState((current) => {
        const existing = page === 1 || current.status !== 'ok' ? [] : current.repos;
        return {
          status: 'ok',
          repos: [...existing, ...repos],
          hasNext: Boolean(data.hasNext),
          nextPage: page + 1,
        };
      });
    } catch (err) {
      const message = err instanceof ApiError ? err.message : String(err);
      const action =
        err instanceof ApiError && err.status === 401
          ? 'connect'
          : err instanceof ApiError && err.status === 503
            ? 'configure'
            : undefined;
      setState({ status: 'error', message, action });
    } finally {
      setLoadingMore(false);
    }
  }, []);

  useEffect(() => {
    if (open) {
      setQuery('');
      void loadPage(1);
    } else {
      setState({ status: 'idle' });
    }
  }, [open, loadPage]);

  const visibleRepos =
    state.status === 'ok'
      ? state.repos.filter((repo) => {
          const needle = query.trim().toLowerCase();
          if (!needle) return true;
          return (
            repo.fullName.toLowerCase().includes(needle) ||
            repo.name.toLowerCase().includes(needle) ||
            (repo.description || '').toLowerCase().includes(needle)
          );
        })
      : [];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>选择 GitHub 仓库</DialogTitle>
          <DialogDescription>使用已连接的 GitHub Device Flow 账号读取仓库列表。</DialogDescription>
        </DialogHeader>

        {state.status === 'loading' ? <LoadingBlock label="加载 GitHub 仓库" /> : null}
        {state.status === 'error' ? (
          <div className="space-y-3 cds-surface-raised cds-hairline px-4 py-4">
            <ErrorBlock message={state.message} />
            {state.action === 'connect' || state.action === 'configure' ? (
              <Button asChild variant="outline">
                <a href="/cds-settings#github">
                  <ExternalLink />
                  打开 GitHub 设置
                </a>
              </Button>
            ) : (
              <Button type="button" variant="outline" onClick={() => void loadPage(1)}>
                <RefreshCw />
                重试
              </Button>
            )}
          </div>
        ) : null}

        {state.status === 'ok' ? (
          <div className="space-y-4">
            <input
              className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm outline-none ring-offset-background focus-visible:ring-2 focus-visible:ring-ring"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="搜索 owner/repo、名称或描述"
            />
            {visibleRepos.length === 0 ? (
              <div className="rounded-md border border-dashed border-border px-4 py-8 text-center text-sm text-muted-foreground">
                没有匹配的仓库。
              </div>
            ) : (
              <div className="max-h-[420px] space-y-2 overflow-y-auto pr-1">
                {visibleRepos.map((repo) => (
                  <button
                    key={repo.id}
                    type="button"
                    className="w-full cds-surface-raised cds-hairline px-3 py-3 text-left transition-colors hover:bg-accent hover:text-accent-foreground"
                    onClick={() => onPick(repo)}
                  >
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium">{repo.fullName}</span>
                      <CodePill>{repo.isPrivate ? 'private' : 'public'}</CodePill>
                      <CodePill>{repo.defaultBranch || 'main'}</CodePill>
                      {repo.language ? <CodePill>{repo.language}</CodePill> : null}
                    </div>
                    {repo.description ? (
                      <div className="mt-1 line-clamp-2 text-sm text-muted-foreground">{repo.description}</div>
                    ) : null}
                    <div className="mt-2 truncate font-mono text-xs text-muted-foreground">{repo.cloneUrl}</div>
                  </button>
                ))}
              </div>
            )}
            {state.hasNext ? (
              <Button type="button" variant="outline" onClick={() => void loadPage(state.nextPage)} disabled={loadingMore}>
                {loadingMore ? <Loader2 className="animate-spin" /> : <RefreshCw />}
                加载更多
              </Button>
            ) : null}
          </div>
        ) : null}

        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            关闭
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function DeleteProjectDialog({
  project,
  onOpenChange,
  onDeleted,
}: {
  project: ProjectSummary | null;
  onOpenChange: (open: boolean) => void;
  onDeleted: () => Promise<void>;
}): JSX.Element {
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (project) setError('');
  }, [project]);

  async function handleDelete(): Promise<void> {
    if (!project) return;
    setSubmitting(true);
    setError('');
    try {
      await apiRequest(`/api/projects/${encodeURIComponent(project.id)}`, { method: 'DELETE' });
      await onDeleted();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog open={Boolean(project)} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>删除项目</DialogTitle>
          <DialogDescription>
            {project ? `将删除 ${displayName(project)} 及其项目内状态。` : ''}
          </DialogDescription>
        </DialogHeader>
        {error ? (
          <div className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {error}
          </div>
        ) : null}
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            取消
          </Button>
          <Button type="button" variant="destructive" onClick={() => void handleDelete()} disabled={submitting}>
            {submitting ? <Loader2 className="animate-spin" /> : <Trash2 />}
            删除
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function LegacyMigrateDialog({
  open,
  onOpenChange,
  onDone,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onDone: () => Promise<void>;
}): JSX.Element {
  const [newId, setNewId] = useState('');
  const [newName, setNewName] = useState('');
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setError('');
    if (!newId.trim()) {
      setError('项目 ID 不能为空');
      return;
    }
    setSubmitting(true);
    try {
      await apiRequest('/api/legacy-cleanup/rename-default', {
        method: 'POST',
        body: {
          newId: newId.trim(),
          newName: newName.trim() || undefined,
        },
      });
      setNewId('');
      setNewName('');
      onOpenChange(false);
      await onDone();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>迁移 default</DialogTitle>
          <DialogDescription>把旧数据归到一个真实项目 ID 下。</DialogDescription>
        </DialogHeader>
        <form className="space-y-4" onSubmit={(event) => void handleSubmit(event)}>
          <label className="block space-y-1.5">
            <span className="text-sm font-medium">新项目 ID</span>
            <input
              className="h-10 w-full rounded-md border border-input bg-background px-3 font-mono text-sm outline-none ring-offset-background focus-visible:ring-2 focus-visible:ring-ring"
              value={newId}
              onChange={(event) => setNewId(event.target.value.toLowerCase())}
              placeholder="prd-agent"
            />
          </label>
          <label className="block space-y-1.5">
            <span className="text-sm font-medium">项目名称</span>
            <input
              className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm outline-none ring-offset-background focus-visible:ring-2 focus-visible:ring-ring"
              value={newName}
              onChange={(event) => setNewName(event.target.value)}
              placeholder="PRD Agent"
            />
          </label>
          {error ? (
            <div className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
              {error}
            </div>
          ) : null}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              取消
            </Button>
            <Button type="submit" disabled={submitting}>
              {submitting ? <Loader2 className="animate-spin" /> : <ArrowRight />}
              迁移
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
