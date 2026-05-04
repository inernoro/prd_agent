import { FormEvent, useCallback, useEffect, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import {
  Activity,
  AlertTriangle,
  ArrowLeft,
  BarChart3,
  Copy,
  Download,
  Eye,
  FileText,
  GitBranch,
  Github,
  HardDrive,
  Link2,
  Loader2,
  Plug,
  RefreshCw,
  RotateCcw,
  Save,
  Settings,
  TerminalSquare,
  Trash2,
  Unlink,
  Upload,
  Wrench,
} from 'lucide-react';

import { AppShell, Crumb, TopBar, Workspace } from '@/components/layout/AppShell';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { apiRequest, ApiError } from '@/lib/api';
import { EnvEditor } from '@/pages/cds-settings/EnvEditor';
import { CodePill, ErrorBlock, LoadingBlock, MetricTile, Section } from '@/pages/cds-settings/components';
import { EnvSetupDialog } from '@/components/env/EnvSetupDialog';

interface ProjectSummary {
  id: string;
  slug: string;
  name: string;
  aliasName?: string;
  aliasSlug?: string;
  description?: string;
  kind?: string;
  gitRepoUrl?: string;
  dockerNetwork?: string;
  legacyFlag?: boolean;
  createdAt?: string;
  updatedAt?: string;
  autoSmokeEnabled?: boolean;
  branchCount?: number;
  runningBranchCount?: number;
  runningServiceCount?: number;
  lastDeployedAt?: string | null;
  deployCount?: number;
  pullCount?: number;
  stopCount?: number;
  aiOpCount?: number;
  debugCount?: number;
  lastDeployAt?: string | null;
  lastAiOccupantAt?: string | null;
  githubRepoFullName?: string;
  githubInstallationId?: number;
  githubAutoDeploy?: boolean;
  githubLinkedAt?: string;
  githubEventPolicy?: GithubEventPolicy;
}

interface ProjectSaveResponse {
  project: ProjectSummary;
}

interface BranchSummary {
  id?: string;
  branch?: string;
  deployCount?: number;
  pullCount?: number;
  stopCount?: number;
  aiOpCount?: number;
  debugCount?: number;
  lastDeployAt?: string | null;
}

interface BranchesResponse {
  branches: BranchSummary[];
}

interface ActivityLogEntry {
  at: string;
  type: string;
  actor?: string;
  branchName?: string;
  branchId?: string;
  note?: string;
}

interface ActivityLogsResponse {
  logs: ActivityLogEntry[];
  total: number;
}

interface TemplateVariableDef {
  key: string;
  label: string;
  example: string;
}

interface CommentTemplateResponse {
  ok: boolean;
  body: string;
  updatedAt: string | null;
  isDefault: boolean;
  defaultBody: string;
  variables: TemplateVariableDef[];
}

interface CommentTemplateSaveResponse {
  ok: boolean;
  body: string;
  updatedAt: string;
}

interface CommentTemplatePreviewResponse {
  ok: boolean;
  rendered: string;
}

interface GithubEventPolicy {
  push?: boolean;
  delete?: boolean;
  prOpen?: boolean;
  prClose?: boolean;
  slashCommand?: boolean;
}

interface GithubAppStatus {
  configured: boolean;
  appId?: string | number;
  appSlug?: string | null;
  installUrl?: string | null;
  publicBaseUrl?: string | null;
  webhookUrl?: string | null;
}

interface GithubInstallation {
  id: number;
  account: {
    login: string;
    type?: string;
    avatarUrl?: string;
  };
  repositorySelection?: string;
}

interface GithubRepo {
  fullName: string;
  private?: boolean;
  defaultBranch?: string;
}

interface GithubInstallationsResponse {
  installations: GithubInstallation[];
}

interface GithubReposResponse {
  repos: GithubRepo[];
}

interface GithubLinkResponse {
  project: ProjectSummary;
}

interface CacheDirInfo {
  name: string;
  hostPath: string;
  containerPath: string;
  exists: boolean;
  sizeBytes: number | null;
  fileCount: number | null;
  lastModified: string | null;
  usedByProfiles: string[];
}

interface CacheStatusResponse {
  cacheBase: string;
  projectSlug: string;
  caches: CacheDirInfo[];
  orphans: CacheDirInfo[];
  totalBytes: number;
  totalBytesHuman: string;
  warnings: string[];
}

interface CacheRepairResponse {
  repaired: boolean;
  actionsCount: number;
  message: string;
}

interface CacheImportResponse {
  imported: boolean;
  path: string;
  sizeBytes: number | null;
  sizeBytesHuman: string | null;
  fileCount: number | null;
  message: string;
}

type ProjectState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ok'; project: ProjectSummary };

/*
 * Project settings — flattened into 3 semantic groups (接入 / 运行时 / 危险区)
 * matching the CDS system settings page. The TabsList renders section headers
 * between TabsTrigger groups so users can find a setting in 3 seconds.
 */
type TabValue =
  | 'general'
  | 'github'
  | 'comment-template'
  | 'env'
  | 'cache'
  | 'stats'
  | 'activity'
  | 'danger';

interface TabItem {
  value: TabValue;
  label: string;
  icon: typeof Settings;
}

interface TabGroup {
  label: string;
  items: TabItem[];
}

const tabGroups: TabGroup[] = [
  {
    label: '接入',
    items: [
      { value: 'general', label: '基础信息', icon: Settings },
      { value: 'github', label: 'GitHub', icon: Github },
      { value: 'comment-template', label: '评论模板', icon: FileText },
    ],
  },
  {
    label: '运行时',
    items: [
      { value: 'env', label: '项目环境变量', icon: TerminalSquare },
      { value: 'cache', label: '缓存诊断', icon: HardDrive },
      { value: 'stats', label: '统计', icon: BarChart3 },
      { value: 'activity', label: '活动日志', icon: Activity },
    ],
  },
  {
    label: '危险区',
    items: [{ value: 'danger', label: '删除项目', icon: Trash2 }],
  },
];

const tabs: TabItem[] = tabGroups.flatMap((group) => group.items);

const inputClass =
  'h-10 w-full rounded-md border border-input bg-background px-3 text-sm outline-none ring-offset-background focus-visible:ring-2 focus-visible:ring-ring';
const monoInputClass = `${inputClass} font-mono`;
const textareaClass =
  'min-h-24 w-full resize-y rounded-md border border-input bg-background px-3 py-2 text-sm outline-none ring-offset-background focus-visible:ring-2 focus-visible:ring-ring';

function displayName(project: ProjectSummary): string {
  return project.aliasName || project.name || project.slug || project.id;
}

function getInitialTab(): TabValue {
  const hash = window.location.hash.replace(/^#/, '');
  return tabs.some((tab) => tab.value === hash) ? (hash as TabValue) : 'general';
}

function formatDate(value?: string | null): string {
  if (!value) return '暂无';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '暂无';
  return date.toLocaleString();
}

function formatBytes(value?: number | null): string {
  if (value == null) return '暂无';
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  if (value < 1024 * 1024 * 1024) return `${(value / 1024 / 1024).toFixed(1)} MB`;
  return `${(value / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function numberValue(value?: number): number {
  return Number.isFinite(value) ? Number(value) : 0;
}

function messageFromError(err: unknown): string {
  return err instanceof ApiError ? err.message : String(err);
}

function useProject(projectId: string | undefined): {
  state: ProjectState;
  refresh: () => Promise<void>;
  setProject: (project: ProjectSummary) => void;
} {
  const [state, setState] = useState<ProjectState>({ status: 'loading' });

  const refresh = useCallback(async () => {
    if (!projectId) {
      setState({ status: 'error', message: '缺少项目 ID' });
      return;
    }
    setState({ status: 'loading' });
    try {
      const project = await apiRequest<ProjectSummary>(`/api/projects/${encodeURIComponent(projectId)}`);
      setState({ status: 'ok', project });
    } catch (err) {
      setState({ status: 'error', message: messageFromError(err) });
    }
  }, [projectId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return {
    state,
    refresh,
    setProject: (project) => setState({ status: 'ok', project }),
  };
}

export function ProjectSettingsPage(): JSX.Element {
  const { projectId } = useParams<{ projectId: string }>();
  const { state, refresh, setProject } = useProject(projectId);
  const [activeTab, setActiveTab] = useState<TabValue>(() => getInitialTab());
  const [toast, setToast] = useState('');

  useEffect(() => {
    window.history.replaceState(null, '', `#${activeTab}`);
  }, [activeTab]);

  useEffect(() => {
    const syncFromHash = () => setActiveTab(getInitialTab());
    window.addEventListener('hashchange', syncFromHash);
    return () => window.removeEventListener('hashchange', syncFromHash);
  }, []);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(''), 3200);
    return () => window.clearTimeout(timer);
  }, [toast]);

  const project = state.status === 'ok' ? state.project : null;
  const title = project ? displayName(project) : projectId || '项目';

  /*
   * Render — Week 4.6 visual rebuild. AppShell + TopBar + Tabs.
   * Tab list and content surfaces upgrade to surface-raised tokens.
   */
  return (
    <AppShell
      active="projects"
      topbar={
        <TopBar
          left={
            <>
              <Crumb
                items={[
                  { label: 'CDS', href: '/project-list' },
                  { label: '项目', href: '/project-list' },
                  { label: title },
                ]}
              />
              {project ? (
                <div className="hidden items-center gap-4 border-l border-[hsl(var(--hairline))] pl-4 md:flex">
                  <span className="cds-stat">
                    <span className="cds-stat-value">{numberValue(project.branchCount)}</span>
                    <span className="cds-stat-label">分支</span>
                  </span>
                  <span className="cds-stat">
                    <span className="cds-stat-value">{numberValue(project.runningServiceCount)}</span>
                    <span className="cds-stat-label">运行</span>
                  </span>
                </div>
              ) : null}
            </>
          }
          right={
            <>
              <Button asChild variant="ghost" size="sm" title="项目列表">
                <a href="/project-list">
                  <ArrowLeft />
                  项目
                </a>
              </Button>
              <Button asChild variant="ghost" size="sm" title="分支控制台">
                <a href={`/branches/${encodeURIComponent(projectId || '')}`}>
                  <GitBranch />
                </a>
              </Button>
              <Button
                variant="ghost"
                size="icon"
                onClick={() => void refresh()}
                aria-label="刷新项目设置"
                title="刷新"
              >
                <RefreshCw />
              </Button>
            </>
          }
        />
      }
    >
      <Workspace>
        {state.status === 'loading' ? <LoadingBlock label="加载项目设置" /> : null}
        {state.status === 'error' ? (
          <div className="space-y-4">
            <ErrorBlock message={state.message} />
            <Button asChild variant="outline">
              <a href="/project-list">
                <ArrowLeft />
                返回项目列表
              </a>
            </Button>
          </div>
        ) : null}

        {project ? (
          <Tabs value={activeTab} onValueChange={(value) => setActiveTab(value as TabValue)}>
            <div className="grid gap-4 lg:grid-cols-[240px_minmax(0,1fr)]">
              <TabsList
                aria-label="项目设置分区"
                className="cds-surface-raised cds-hairline p-2 lg:sticky lg:top-[72px] lg:self-start"
              >
                {tabGroups.map((group, groupIdx) => (
                  <div key={group.label} className={groupIdx === 0 ? '' : 'mt-2'}>
                    <div className="px-2 pb-1.5 pt-1 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground/80">
                      {group.label}
                    </div>
                    {group.items.map((tab) => {
                      const Icon = tab.icon;
                      return (
                        <TabsTrigger key={tab.value} value={tab.value}>
                          <Icon className="h-4 w-4 shrink-0" />
                          <span className="truncate">{tab.label}</span>
                        </TabsTrigger>
                      );
                    })}
                  </div>
                ))}
              </TabsList>

              <div className="cds-surface-raised cds-hairline min-w-0 p-5">
                <TabsContent value="general">
                  <GeneralTab project={project} projectId={project.id} onSaved={setProject} onToast={setToast} />
                </TabsContent>
                <TabsContent value="github">
                  <GithubProjectTab project={project} onSaved={setProject} onToast={setToast} />
                </TabsContent>
                <TabsContent value="env">
                  <ProjectEnvTab project={project} onToast={setToast} />
                </TabsContent>
                <TabsContent value="comment-template">
                  <CommentTemplateTab projectId={project.id} onToast={setToast} />
                </TabsContent>
                <TabsContent value="cache">
                  <CacheDiagnosticTab onToast={setToast} />
                </TabsContent>
                <TabsContent value="stats">
                  <StatsTab project={project} projectId={project.id} />
                </TabsContent>
                <TabsContent value="activity">
                  <ActivityTab projectId={project.id} />
                </TabsContent>
                <TabsContent value="danger">
                  <DangerZoneTab project={project} onToast={setToast} />
                </TabsContent>
              </div>
            </div>
          </Tabs>
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

function ProjectEnvTab({
  project,
  onToast,
}: {
  project: ProjectSummary;
  onToast: (message: string) => void;
}): JSX.Element {
  const name = displayName(project);
  // Phase 9.3 — 重新打开 EnvSetupDialog 入口(必填项分类弹窗,比平铺 EnvEditor 友好)
  const [wizardOpen, setWizardOpen] = useState(false);
  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-3 rounded-md border border-[hsl(var(--hairline))] bg-[hsl(var(--surface-raised))] p-4">
        <div className="space-y-1 text-sm">
          <div className="font-semibold text-foreground">配置向导</div>
          <div className="text-xs text-muted-foreground">
            按"必填 / CDS 自动 / 推导"三色分组弹窗,适合一次性把缺失项填齐。
          </div>
        </div>
        <Button type="button" variant="outline" size="sm" onClick={() => setWizardOpen(true)}>
          打开向导
        </Button>
      </div>
      <EnvEditor
        scope={project.id}
        title="项目环境变量"
        description={
          <>
            只注入 <CodePill>{name}</CodePill> 的分支容器。CDS 系统级配置请放到{' '}
            <a className="text-primary underline-offset-4 hover:underline" href="/cds-settings#global-vars">
              CDS 全局变量
            </a>
            。
          </>
        }
        emptyDescription="当前项目没有独有环境变量。添加后重新部署分支即可生效。"
        onToast={onToast}
      />
      <EnvSetupDialog
        projectId={wizardOpen ? project.id : null}
        projectName={name}
        onOpenChange={(open) => !open && setWizardOpen(false)}
        onCompleted={({ autoDeploy }) => {
          onToast(
            autoDeploy
              ? '环境变量已保存。前往分支页可以触发部署。'
              : '环境变量已保存。',
          );
        }}
      />
    </div>
  );
}

function GeneralTab({
  project,
  projectId,
  onSaved,
  onToast,
}: {
  project: ProjectSummary;
  projectId: string;
  onSaved: (project: ProjectSummary) => void;
  onToast: (message: string) => void;
}): JSX.Element {
  const [name, setName] = useState(project.name || '');
  const [aliasName, setAliasName] = useState(project.aliasName || '');
  const [aliasSlug, setAliasSlug] = useState(project.aliasSlug || '');
  const [description, setDescription] = useState(project.description || '');
  const [gitRepoUrl, setGitRepoUrl] = useState(project.gitRepoUrl || '');
  const [autoSmokeEnabled, setAutoSmokeEnabled] = useState(Boolean(project.autoSmokeEnabled));
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [autoDeploySaving, setAutoDeploySaving] = useState(false);

  // Inline quick toggle for auto-deploy. The full event policy lives in the
  // GitHub tab — this is the "shortcut" surface so users can flip it without
  // tab-hopping after they hit the "did GitHub auto-deploy something I didn't
  // expect?" panic moment.
  const autoDeployEnabled = resolveGithubEvent(project, 'push');
  async function toggleAutoDeployFromGeneral(): Promise<void> {
    setAutoDeploySaving(true);
    try {
      const next = !autoDeployEnabled;
      const result = await apiRequest<ProjectSaveResponse>(
        `/api/projects/${encodeURIComponent(projectId)}`,
        { method: 'PUT', body: { githubEventPolicy: { push: next } } },
      );
      onSaved(result.project);
      onToast(next ? '自动部署已开启' : '自动部署已关闭');
    } catch (err) {
      onToast(messageFromError(err));
    } finally {
      setAutoDeploySaving(false);
    }
  }

  useEffect(() => {
    setName(project.name || '');
    setAliasName(project.aliasName || '');
    setAliasSlug(project.aliasSlug || '');
    setDescription(project.description || '');
    setGitRepoUrl(project.gitRepoUrl || '');
    setAutoSmokeEnabled(Boolean(project.autoSmokeEnabled));
  }, [project]);

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setError('');
    const trimmedName = name.trim();
    if (!trimmedName) {
      setError('项目名称不能为空');
      return;
    }
    setSaving(true);
    try {
      const result = await apiRequest<ProjectSaveResponse>(`/api/projects/${encodeURIComponent(projectId)}`, {
        method: 'PUT',
        body: {
          name: trimmedName,
          aliasName: aliasName.trim(),
          aliasSlug: aliasSlug.trim(),
          description: description.trim(),
          gitRepoUrl: gitRepoUrl.trim(),
          autoSmokeEnabled,
        },
      });
      onSaved(result.project);
      onToast('项目设置已保存');
    } catch (err) {
      setError(messageFromError(err));
    } finally {
      setSaving(false);
    }
  }

  async function copyProjectId(): Promise<void> {
    try {
      await navigator.clipboard.writeText(project.id);
      onToast('项目 ID 已复制');
    } catch {
      onToast(project.id);
    }
  }

  return (
    <div className="space-y-8">
      <Section
        title="项目基础信息"
        description="这些字段只影响项目展示、仓库来源和项目级自动冒烟测试，不会改写项目 ID 或 Docker 网络。"
      >
        <form className="max-w-3xl space-y-4" onSubmit={(event) => void handleSubmit(event)}>
          <label className="block space-y-1.5">
            <span className="text-sm font-medium">项目名称</span>
            <input className={inputClass} value={name} onChange={(event) => setName(event.target.value)} maxLength={60} />
          </label>
          <label className="block space-y-1.5">
            <span className="text-sm font-medium">显示别名</span>
            <input
              className={inputClass}
              value={aliasName}
              onChange={(event) => setAliasName(event.target.value)}
              maxLength={60}
              placeholder="留空则使用项目名称"
            />
          </label>
          <label className="block space-y-1.5">
            <span className="text-sm font-medium">别名 slug</span>
            <input
              className={monoInputClass}
              value={aliasSlug}
              onChange={(event) => setAliasSlug(event.target.value.toLowerCase())}
              maxLength={50}
              placeholder="留空则使用项目原 slug"
            />
          </label>
          <label className="block space-y-1.5">
            <span className="text-sm font-medium">描述</span>
            <textarea
              className={textareaClass}
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              maxLength={240}
            />
          </label>
          <label className="block space-y-1.5">
            <span className="text-sm font-medium">Git 仓库地址</span>
            <input
              className={monoInputClass}
              value={gitRepoUrl}
              onChange={(event) => setGitRepoUrl(event.target.value)}
              placeholder="https://github.com/your-org/repo.git"
            />
          </label>
          <label className="flex max-w-3xl items-start gap-3 cds-surface-raised cds-hairline px-3 py-3">
            <input
              className="mt-1 h-4 w-4"
              type="checkbox"
              checked={autoSmokeEnabled}
              onChange={(event) => setAutoSmokeEnabled(event.target.checked)}
            />
            <span className="text-sm leading-6">
              <span className="font-medium">部署成功后自动冒烟测试</span>
              <span className="block text-muted-foreground">需要项目可访问 AI access key 后才会执行。</span>
            </span>
          </label>
          {error ? (
            <div className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
              {error}
            </div>
          ) : null}
          <Button type="submit" disabled={saving}>
            {saving ? <Loader2 className="animate-spin" /> : <Save />}
            保存修改
          </Button>
        </form>
      </Section>

      <Section title="项目标识">
        <div className="grid max-w-4xl gap-3 md:grid-cols-2">
          <InfoRow label="项目 ID" value={project.id} action={<CopyButton onClick={() => void copyProjectId()} />} />
          <InfoRow label="项目 slug" value={project.slug} />
          <InfoRow label="Docker 网络" value={project.dockerNetwork || '暂无'} />
          <InfoRow label="项目类型" value={project.kind || 'git'} />
          <InfoRow label="创建时间" value={formatDate(project.createdAt)} />
          <InfoRow label="最近更新" value={formatDate(project.updatedAt)} />
        </div>
      </Section>

      <Section title="GitHub 关联">
        <div className="max-w-3xl cds-surface-raised cds-hairline px-4 py-4">
          <div className="flex items-start gap-3">
            <Github className="mt-0.5 h-5 w-5 shrink-0 text-muted-foreground" />
            <div className="min-w-0 flex-1 space-y-2 text-sm">
              <div className="font-medium">{project.githubRepoFullName ? '已关联仓库' : '尚未关联仓库'}</div>
              {project.githubRepoFullName ? (
                <>
                  <div className="flex flex-wrap items-center gap-2 text-muted-foreground">
                    <CodePill>{project.githubRepoFullName}</CodePill>
                    {project.githubInstallationId ? (
                      <CodePill>installation {project.githubInstallationId}</CodePill>
                    ) : null}
                    <span
                      className={`inline-flex items-center gap-1.5 rounded-md border px-2 py-0.5 text-xs ${
                        autoDeployEnabled
                          ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300'
                          : 'border-[hsl(var(--hairline))] bg-[hsl(var(--surface-sunken))] text-muted-foreground'
                      }`}
                    >
                      <span
                        className={`h-1.5 w-1.5 rounded-full ${autoDeployEnabled ? 'bg-emerald-500' : 'bg-muted-foreground'}`}
                        aria-hidden
                      />
                      {autoDeployEnabled ? '自动部署开启' : '自动部署关闭'}
                    </span>
                    <Button
                      type="button"
                      size="sm"
                      variant={autoDeployEnabled ? 'outline' : 'default'}
                      className="h-7"
                      onClick={() => void toggleAutoDeployFromGeneral()}
                      disabled={autoDeploySaving}
                    >
                      {autoDeploySaving ? <Loader2 className="animate-spin" /> : null}
                      {autoDeployEnabled ? '关闭自动部署' : '开启自动部署'}
                    </Button>
                  </div>
                  <div className="text-xs text-muted-foreground">
                    push 时自动建分支 + 构建。更细的事件策略(PR / 删分支 / 评论命令)在「GitHub」tab。
                  </div>
                  <RecentAutoDeploys projectId={project.id} />
                </>
              ) : (
                <div className="text-muted-foreground">
                  GitHub App 和 OAuth 属于 CDS 系统设置；仓库选择器会在后续小任务迁入 React。
                </div>
              )}
            </div>
          </div>
        </div>
      </Section>
    </div>
  );
}

function CopyButton({ onClick }: { onClick: () => void }): JSX.Element {
  return (
    <Button type="button" size="icon" variant="ghost" onClick={onClick} aria-label="复制">
      <Copy />
    </Button>
  );
}

/**
 * RecentAutoDeploys — GitHub 关联卡片下面内联的最近 5 次自动部署 mini-list。
 * 用户痛点(2026-05-04 UX 验证):"已关联 / 自动部署开启" 两个 chip 没有
 * "它真的在工作"的证据。这里证明 webhook 在工作 + 哪次 push 触发了哪次部署。
 */
function RecentAutoDeploys({ projectId }: { projectId: string }): JSX.Element | null {
  type Item = {
    branchId: string;
    branch: string;
    status: string;
    lastDeployAt: string;
    installationId?: number;
  };
  const [items, setItems] = useState<Item[] | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await apiRequest<{ items: Item[] }>(
          `/api/projects/${encodeURIComponent(projectId)}/recent-auto-deploys?limit=5`,
        );
        if (cancelled) return;
        setItems(Array.isArray(r?.items) ? r.items : []);
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof ApiError ? err.message : String(err));
      }
    })();
    return () => { cancelled = true; };
  }, [projectId]);

  if (error) return null; // 旧 CDS 没这个端点,静默不显示
  if (!items) {
    return <div className="text-xs text-muted-foreground">正在读取自动部署历史…</div>;
  }
  if (items.length === 0) {
    return (
      <div className="rounded-md border border-dashed border-[hsl(var(--hairline))] bg-[hsl(var(--surface-sunken))] px-3 py-2 text-xs text-muted-foreground">
        暂无自动部署记录 — push 后这里会出现 webhook 触发的分支(用作"自动部署是否在工作"的实际证据)。
      </div>
    );
  }
  return (
    <div className="space-y-1.5">
      <div className="text-xs font-medium text-muted-foreground">最近自动部署</div>
      <ul className="divide-y divide-[hsl(var(--hairline))] rounded-md border border-[hsl(var(--hairline))] bg-[hsl(var(--surface-sunken))]">
        {items.map((it) => (
          <li key={it.branchId} className="flex items-center justify-between gap-3 px-3 py-1.5 text-xs">
            <div className="min-w-0 flex-1">
              <a
                href={`/branches/${encodeURIComponent(projectId)}#${encodeURIComponent(it.branchId)}`}
                className="truncate font-mono text-foreground hover:underline"
                title={it.branch}
              >
                {it.branch}
              </a>
            </div>
            <span
              className={`rounded border px-1.5 py-0.5 text-[10px] ${
                it.status === 'running' ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300'
                : it.status === 'error' ? 'border-destructive/40 bg-destructive/10 text-destructive'
                : 'border-[hsl(var(--hairline))] text-muted-foreground'
              }`}
            >
              {it.status}
            </span>
            <span className="shrink-0 text-muted-foreground tabular-nums">
              {formatRelativeTime(it.lastDeployAt)}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function formatRelativeTime(iso: string): string {
  if (!iso) return '';
  const ms = Date.now() - new Date(iso).getTime();
  if (Number.isNaN(ms) || ms < 0) return '';
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return `${sec}s 前`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m 前`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h 前`;
  const d = Math.floor(hr / 24);
  if (d < 30) return `${d}d 前`;
  return new Date(iso).toLocaleDateString();
}

function InfoRow({
  label,
  value,
  action,
}: {
  label: string;
  value: string;
  action?: JSX.Element;
}): JSX.Element {
  return (
    <div className="flex min-h-14 items-center justify-between gap-3 cds-surface-raised cds-hairline px-3 py-2">
      <div className="min-w-0">
        <div className="text-xs text-muted-foreground">{label}</div>
        <div className="mt-1 truncate font-mono text-sm">{value}</div>
      </div>
      {action ? <div className="shrink-0">{action}</div> : null}
    </div>
  );
}

const githubEventDefs: Array<{
  key: keyof GithubEventPolicy;
  label: string;
  description: string;
}> = [
  { key: 'push', label: '推送代码', description: 'push 事件自动建分支并部署。' },
  { key: 'delete', label: '删除分支', description: 'delete 事件自动停止容器并清理。' },
  { key: 'prOpen', label: 'PR 打开或重开', description: 'pull_request opened/reopened 自动建分支并部署。' },
  { key: 'prClose', label: 'PR 关闭或合并', description: 'pull_request closed 自动停止容器。' },
  { key: 'slashCommand', label: 'PR 评论命令', description: '处理 PR 评论里的 /cds 斜杠命令。' },
];

function resolveGithubEvent(project: ProjectSummary, key: keyof GithubEventPolicy): boolean {
  const value = project.githubEventPolicy?.[key];
  if (value === true || value === false) return value;
  if (key === 'push') return project.githubAutoDeploy !== false;
  return true;
}

function GithubProjectTab({
  project,
  onSaved,
  onToast,
}: {
  project: ProjectSummary;
  onSaved: (project: ProjectSummary) => void;
  onToast: (message: string) => void;
}): JSX.Element {
  const [appState, setAppState] = useState<
    | { status: 'loading' }
    | { status: 'error'; message: string }
    | { status: 'ok'; app: GithubAppStatus }
  >({ status: 'loading' });
  const [repoPickerOpen, setRepoPickerOpen] = useState(false);
  const [unlinkOpen, setUnlinkOpen] = useState(false);
  const [savingKey, setSavingKey] = useState<string | null>(null);
  const [autoDeploySaving, setAutoDeploySaving] = useState(false);
  const [unlinking, setUnlinking] = useState(false);

  const loadApp = useCallback(async () => {
    setAppState({ status: 'loading' });
    try {
      const app = await apiRequest<GithubAppStatus>('/api/github/app');
      setAppState({ status: 'ok', app });
    } catch (err) {
      setAppState({ status: 'error', message: messageFromError(err) });
    }
  }, []);

  useEffect(() => {
    void loadApp();
  }, [loadApp]);

  async function setEventPolicy(key: keyof GithubEventPolicy, enabled: boolean): Promise<void> {
    setSavingKey(key);
    try {
      const result = await apiRequest<ProjectSaveResponse>(`/api/projects/${encodeURIComponent(project.id)}`, {
        method: 'PUT',
        body: { githubEventPolicy: { [key]: enabled } },
      });
      onSaved(result.project);
      onToast(enabled ? 'GitHub 事件已开启' : 'GitHub 事件已关闭');
    } catch (err) {
      onToast(messageFromError(err));
    } finally {
      setSavingKey(null);
    }
  }

  async function toggleAutoDeploy(enabled: boolean): Promise<void> {
    setAutoDeploySaving(true);
    try {
      const result = await apiRequest<ProjectSaveResponse>(`/api/projects/${encodeURIComponent(project.id)}`, {
        method: 'PUT',
        body: { githubEventPolicy: { push: enabled } },
      });
      onSaved(result.project);
      onToast(enabled ? '自动部署已开启' : '自动部署已关闭');
    } catch (err) {
      onToast(messageFromError(err));
    } finally {
      setAutoDeploySaving(false);
    }
  }

  async function unlinkRepo(): Promise<void> {
    setUnlinking(true);
    try {
      await apiRequest(`/api/projects/${encodeURIComponent(project.id)}/github/link`, { method: 'DELETE' });
      onSaved({
        ...project,
        githubInstallationId: undefined,
        githubRepoFullName: undefined,
        githubAutoDeploy: undefined,
        githubLinkedAt: undefined,
      });
      setUnlinkOpen(false);
      onToast('GitHub 仓库绑定已解除');
    } catch (err) {
      onToast(messageFromError(err));
    } finally {
      setUnlinking(false);
    }
  }

  const linked = Boolean(project.githubRepoFullName);
  const appConfigured = appState.status === 'ok' && appState.app.configured;

  return (
    <div className="space-y-8">
      <Section title="GitHub App" description="CDS 用 GitHub App 接收 webhook、写入 Check Run，并把仓库绑定到项目。">
        {appState.status === 'loading' ? <LoadingBlock label="加载 GitHub App 状态" /> : null}
        {appState.status === 'error' ? <ErrorBlock message={appState.message} /> : null}
        {appState.status === 'ok' ? <GithubAppCard app={appState.app} /> : null}
      </Section>

      <Section
        title="项目仓库绑定"
        description="绑定后，GitHub webhook 会把该仓库的事件路由到当前项目。"
      >
        {linked ? (
          <div className="max-w-3xl cds-surface-raised cds-hairline px-4 py-4">
            <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
              <div className="min-w-0 space-y-2">
                <div className="flex flex-wrap items-center gap-2">
                  <CodePill>{project.githubRepoFullName}</CodePill>
                  {project.githubInstallationId ? (
                    <CodePill>installation {project.githubInstallationId}</CodePill>
                  ) : (
                    <CodePill>installation 自动补齐</CodePill>
                  )}
                </div>
                <div className="text-sm text-muted-foreground">
                  {project.githubLinkedAt ? `绑定时间：${formatDate(project.githubLinkedAt)}` : '已绑定到当前项目。'}
                </div>
              </div>
              <div className="flex flex-wrap gap-2">
                <Button asChild variant="outline">
                  <a href={`https://github.com/${project.githubRepoFullName}`} target="_blank" rel="noreferrer">
                    <Github />
                    打开仓库
                  </a>
                </Button>
                <Button variant="outline" onClick={() => setRepoPickerOpen(true)} disabled={!appConfigured}>
                  <Link2 />
                  重新绑定
                </Button>
                <Button variant="outline" onClick={() => setUnlinkOpen(true)}>
                  <Unlink />
                  解除绑定
                </Button>
              </div>
            </div>
            <label className="mt-4 flex items-start gap-3 cds-surface-sunken cds-hairline px-3 py-3">
              <input
                className="mt-1 h-4 w-4"
                type="checkbox"
                checked={resolveGithubEvent(project, 'push')}
                disabled={autoDeploySaving}
                onChange={(event) => void toggleAutoDeploy(event.target.checked)}
              />
              <span className="text-sm leading-6">
                <span className="font-medium">自动部署</span>
                <span className="block text-muted-foreground">push 到该仓库时自动在 CDS 构建部署。</span>
              </span>
            </label>
          </div>
        ) : (
          <div className="max-w-3xl rounded-md border border-dashed border-border bg-card px-4 py-6">
            <div className="mb-4 flex items-start gap-3">
              <Plug className="mt-0.5 h-5 w-5 text-muted-foreground" />
              <div>
                <div className="font-medium">尚未绑定仓库</div>
                <div className="mt-1 text-sm leading-6 text-muted-foreground">
                  绑定仓库后，push、PR 和评论事件会按下方策略进入当前项目。
                </div>
              </div>
            </div>
            <Button onClick={() => setRepoPickerOpen(true)} disabled={!appConfigured}>
              <Link2 />
              绑定 GitHub 仓库
            </Button>
          </div>
        )}
      </Section>

      <Section title="GitHub 事件策略" description="这些开关只影响当前项目。未设置时，push 兼容旧自动部署字段，其它事件默认开启。">
        <div className="grid max-w-3xl gap-2">
          {githubEventDefs.map((def) => {
            const enabled = resolveGithubEvent(project, def.key);
            return (
              <label key={def.key} className="flex items-start gap-3 cds-surface-raised cds-hairline px-3 py-3">
                <input
                  className="mt-1 h-4 w-4"
                  type="checkbox"
                  checked={enabled}
                  disabled={savingKey === def.key}
                  onChange={(event) => void setEventPolicy(def.key, event.target.checked)}
                />
                <span className="min-w-0 text-sm leading-6">
                  <span className="font-medium">{def.label}</span>
                  <span className="block text-muted-foreground">{def.description}</span>
                </span>
                <span className="ml-auto shrink-0 text-xs text-muted-foreground">{enabled ? '开启' : '关闭'}</span>
              </label>
            );
          })}
        </div>
      </Section>

      <GithubRepoPickerDialog
        open={repoPickerOpen}
        onOpenChange={setRepoPickerOpen}
        projectId={project.id}
        onLinked={(updated) => {
          onSaved(updated);
          onToast('GitHub 仓库已绑定');
        }}
      />
      <Dialog open={unlinkOpen} onOpenChange={setUnlinkOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>解除 GitHub 仓库绑定</DialogTitle>
            <DialogDescription>
              解除后，GitHub webhook 不再把该仓库事件路由到此项目。已有分支和 Check Run 不会被删除。
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setUnlinkOpen(false)}>
              取消
            </Button>
            <Button type="button" variant="destructive" onClick={() => void unlinkRepo()} disabled={unlinking}>
              {unlinking ? <Loader2 className="animate-spin" /> : <Unlink />}
              解除绑定
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function GithubAppCard({ app }: { app: GithubAppStatus }): JSX.Element {
  if (!app.configured) {
    return (
      <div className="max-w-3xl rounded-md border border-amber-500/40 bg-amber-500/10 px-4 py-4">
        <div className="font-medium">GitHub App 尚未配置</div>
        <div className="mt-2 text-sm leading-6 text-muted-foreground">
          需要在 CDS 启动环境里配置 GitHub App ID、Private Key、Webhook Secret 和公开访问地址。
        </div>
        <pre className="mt-4 overflow-x-auto cds-surface-raised cds-hairline p-3 font-mono text-xs leading-5">
{`export CDS_GITHUB_APP_ID="<numeric-app-id>"
export CDS_GITHUB_APP_PRIVATE_KEY="$(cat private-key.pem)"
export CDS_GITHUB_WEBHOOK_SECRET="<random-string>"
export CDS_GITHUB_APP_SLUG="<lowercase-app-slug>"
export CDS_PUBLIC_BASE_URL="https://cds.your-domain.com"`}
        </pre>
      </div>
    );
  }

  return (
    <div className="grid max-w-4xl gap-3 md:grid-cols-2">
      <InfoRow label="App ID" value={String(app.appId || '暂无')} />
      <InfoRow label="App slug" value={app.appSlug || '暂无'} />
      <InfoRow label="Public Base URL" value={app.publicBaseUrl || '暂无'} />
      <InfoRow label="Webhook URL" value={app.webhookUrl || '暂无'} />
      {app.installUrl ? (
        <Button asChild variant="outline">
          <a href={app.installUrl} target="_blank" rel="noreferrer">
            <Github />
            在 GitHub 管理安装
          </a>
        </Button>
      ) : null}
    </div>
  );
}

function GithubRepoPickerDialog({
  open,
  onOpenChange,
  projectId,
  onLinked,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectId: string;
  onLinked: (project: ProjectSummary) => void;
}): JSX.Element {
  const [installationsState, setInstallationsState] = useState<
    | { status: 'idle' }
    | { status: 'loading' }
    | { status: 'error'; message: string }
    | { status: 'ok'; installations: GithubInstallation[] }
  >({ status: 'idle' });
  const [repoState, setRepoState] = useState<
    | { status: 'idle' }
    | { status: 'loading'; installation: GithubInstallation }
    | { status: 'error'; installation: GithubInstallation; message: string }
    | { status: 'ok'; installation: GithubInstallation; repos: GithubRepo[] }
  >({ status: 'idle' });
  const [selectedRepo, setSelectedRepo] = useState<GithubRepo | null>(null);
  const [autoDeploy, setAutoDeploy] = useState(true);
  const [linking, setLinking] = useState(false);

  const loadInstallations = useCallback(async () => {
    setInstallationsState({ status: 'loading' });
    setRepoState({ status: 'idle' });
    setSelectedRepo(null);
    try {
      const result = await apiRequest<GithubInstallationsResponse>('/api/github/installations');
      setInstallationsState({ status: 'ok', installations: result.installations || [] });
    } catch (err) {
      setInstallationsState({ status: 'error', message: messageFromError(err) });
    }
  }, []);

  useEffect(() => {
    if (open) void loadInstallations();
  }, [open, loadInstallations]);

  async function loadRepos(installation: GithubInstallation): Promise<void> {
    setRepoState({ status: 'loading', installation });
    setSelectedRepo(null);
    try {
      const result = await apiRequest<GithubReposResponse>(`/api/github/installations/${installation.id}/repos`);
      setRepoState({ status: 'ok', installation, repos: result.repos || [] });
    } catch (err) {
      setRepoState({ status: 'error', installation, message: messageFromError(err) });
    }
  }

  async function linkRepo(): Promise<void> {
    if (!selectedRepo || repoState.status !== 'ok') return;
    setLinking(true);
    try {
      const result = await apiRequest<GithubLinkResponse>(`/api/projects/${encodeURIComponent(projectId)}/github/link`, {
        method: 'POST',
        body: {
          installationId: repoState.installation.id,
          repoFullName: selectedRepo.fullName,
          autoDeploy,
        },
      });
      onLinked(result.project);
      onOpenChange(false);
    } finally {
      setLinking(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>绑定 GitHub 仓库</DialogTitle>
          <DialogDescription>先选择 GitHub App 安装，再选择仓库并确认绑定到当前项目。</DialogDescription>
        </DialogHeader>

        <div className="grid gap-5 md:grid-cols-[240px_minmax(0,1fr)]">
          <div className="space-y-2">
            <div className="text-sm font-medium">安装</div>
            {installationsState.status === 'loading' ? <LoadingBlock label="加载安装" /> : null}
            {installationsState.status === 'error' ? <ErrorBlock message={installationsState.message} /> : null}
            {installationsState.status === 'ok' && installationsState.installations.length === 0 ? (
              <div className="rounded-md border border-dashed border-border px-3 py-4 text-sm text-muted-foreground">
                还没有账号或组织安装此 GitHub App。
              </div>
            ) : null}
            {installationsState.status === 'ok'
              ? installationsState.installations.map((installation) => (
                  <button
                    key={installation.id}
                    type="button"
                    className="w-full cds-surface-raised cds-hairline px-3 py-2 text-left text-sm transition-colors hover:bg-accent hover:text-accent-foreground"
                    onClick={() => void loadRepos(installation)}
                  >
                    <div className="font-medium">{installation.account.login}</div>
                    <div className="text-xs text-muted-foreground">
                      {installation.account.type || 'GitHub'} · {installation.repositorySelection || 'selected'}
                    </div>
                  </button>
                ))
              : null}
          </div>

          <div className="space-y-2">
            <div className="text-sm font-medium">仓库</div>
            {repoState.status === 'idle' ? (
              <div className="rounded-md border border-dashed border-border px-3 py-4 text-sm text-muted-foreground">
                先从左侧选择一个安装。
              </div>
            ) : null}
            {repoState.status === 'loading' ? <LoadingBlock label="加载仓库" /> : null}
            {repoState.status === 'error' ? <ErrorBlock message={repoState.message} /> : null}
            {repoState.status === 'ok' && repoState.repos.length === 0 ? (
              <div className="rounded-md border border-dashed border-border px-3 py-4 text-sm text-muted-foreground">
                此安装没有授予 CDS 可访问的仓库。
              </div>
            ) : null}
            {repoState.status === 'ok'
              ? repoState.repos.map((repo) => (
                  <button
                    key={repo.fullName}
                    type="button"
                    className={
                      selectedRepo?.fullName === repo.fullName
                        ? 'w-full rounded-md border border-primary bg-primary/10 px-3 py-2 text-left text-sm'
                        : 'w-full cds-surface-raised cds-hairline px-3 py-2 text-left text-sm transition-colors hover:bg-accent hover:text-accent-foreground'
                    }
                    onClick={() => setSelectedRepo(repo)}
                  >
                    <div className="font-medium">{repo.fullName}</div>
                    <div className="text-xs text-muted-foreground">
                      {repo.private ? 'Private' : 'Public'}{repo.defaultBranch ? ` · 默认分支 ${repo.defaultBranch}` : ''}
                    </div>
                  </button>
                ))
              : null}
          </div>
        </div>

        <label className="flex items-start gap-3 cds-surface-sunken cds-hairline px-3 py-3">
          <input
            className="mt-1 h-4 w-4"
            type="checkbox"
            checked={autoDeploy}
            onChange={(event) => setAutoDeploy(event.target.checked)}
          />
          <span className="text-sm leading-6">
            <span className="font-medium">开启自动部署</span>
            <span className="block text-muted-foreground">绑定后 push 事件默认触发 CDS 部署。</span>
          </span>
        </label>

        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            取消
          </Button>
          <Button type="button" onClick={() => void linkRepo()} disabled={!selectedRepo || linking}>
            {linking ? <Loader2 className="animate-spin" /> : <Link2 />}
            确认绑定
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function CommentTemplateTab({
  projectId,
  onToast,
}: {
  projectId: string;
  onToast: (message: string) => void;
}): JSX.Element {
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const [state, setState] = useState<
    | { status: 'loading' }
    | { status: 'error'; message: string }
    | {
        status: 'ok';
        body: string;
        defaultBody: string;
        variables: TemplateVariableDef[];
        updatedAt: string | null;
        isDefault: boolean;
        preview: string;
      }
  >({ status: 'loading' });
  const [saving, setSaving] = useState(false);
  const [previewing, setPreviewing] = useState(false);

  const load = useCallback(async () => {
    setState({ status: 'loading' });
    try {
      const data = await apiRequest<CommentTemplateResponse>(
        `/api/comment-template?projectId=${encodeURIComponent(projectId)}`,
      );
      setState({
        status: 'ok',
        body: data.body || data.defaultBody || '',
        defaultBody: data.defaultBody || '',
        variables: data.variables || [],
        updatedAt: data.updatedAt || null,
        isDefault: Boolean(data.isDefault),
        preview: '',
      });
    } catch (err) {
      setState({ status: 'error', message: messageFromError(err) });
    }
  }, [projectId]);

  useEffect(() => {
    void load();
  }, [load]);

  function updateBody(body: string): void {
    setState((current) => (current.status === 'ok' ? { ...current, body } : current));
  }

  function insertVariable(key: string): void {
    if (state.status !== 'ok') return;
    const textarea = textareaRef.current;
    const token = `{{${key}}}`;
    if (!textarea) {
      updateBody(`${state.body}${token}`);
      return;
    }
    const start = textarea.selectionStart ?? state.body.length;
    const end = textarea.selectionEnd ?? state.body.length;
    const next = `${state.body.slice(0, start)}${token}${state.body.slice(end)}`;
    updateBody(next);
    window.requestAnimationFrame(() => {
      textarea.focus();
      const caret = start + token.length;
      textarea.setSelectionRange(caret, caret);
    });
  }

  async function save(): Promise<void> {
    if (state.status !== 'ok') return;
    setSaving(true);
    try {
      const result = await apiRequest<CommentTemplateSaveResponse>(
        `/api/projects/${encodeURIComponent(projectId)}/comment-template`,
        {
          method: 'PUT',
          body: { body: state.body },
        },
      );
      setState({ ...state, body: result.body || '', updatedAt: result.updatedAt, isDefault: !result.body });
      onToast(result.body ? '评论模板已保存' : '评论模板已恢复默认');
    } catch (err) {
      onToast(messageFromError(err));
    } finally {
      setSaving(false);
    }
  }

  async function preview(): Promise<void> {
    if (state.status !== 'ok') return;
    setPreviewing(true);
    try {
      const source = state.body.trim() ? state.body : state.defaultBody;
      const result = await apiRequest<CommentTemplatePreviewResponse>('/api/comment-template/preview', {
        method: 'POST',
        body: { body: source },
      });
      setState({ ...state, preview: result.rendered || '(空)' });
    } catch (err) {
      setState({ ...state, preview: `预览失败：${messageFromError(err)}` });
    } finally {
      setPreviewing(false);
    }
  }

  if (state.status === 'loading') return <LoadingBlock label="加载评论模板" />;
  if (state.status === 'error') return <ErrorBlock message={state.message} />;

  return (
    <div className="space-y-8">
      <Section
        title="GitHub PR 预览评论模板"
        description="每当 PR 打开或部署完成时，CDS 会在 PR 下发或刷新预览评论。这里编辑当前项目的 Markdown 模板，留空保存会回到默认模板。"
      >
        <div className="space-y-4">
          <label className="block space-y-1.5">
            <span className="text-sm font-medium">模板正文</span>
            <textarea
              ref={textareaRef}
              className="min-h-80 w-full resize-y rounded-md border border-input bg-background px-3 py-3 font-mono text-sm leading-6 outline-none ring-offset-background focus-visible:ring-2 focus-visible:ring-ring"
              value={state.body}
              onChange={(event) => updateBody(event.target.value)}
              spellCheck={false}
            />
          </label>
          <div className="text-xs text-muted-foreground">
            {state.isDefault ? '当前使用默认模板。' : `最近保存：${formatDate(state.updatedAt)}`}
          </div>
          <div className="flex flex-wrap gap-2">
            <Button type="button" onClick={() => void save()} disabled={saving}>
              {saving ? <Loader2 className="animate-spin" /> : <Save />}
              保存
            </Button>
            <Button type="button" variant="outline" onClick={() => void preview()} disabled={previewing}>
              {previewing ? <Loader2 className="animate-spin" /> : <Eye />}
              预览
            </Button>
            <Button type="button" variant="outline" onClick={() => updateBody(state.defaultBody)}>
              <RotateCcw />
              填入默认模板
            </Button>
            <Button type="button" variant="ghost" onClick={() => updateBody('')}>
              留空使用默认
            </Button>
          </div>
        </div>
      </Section>

      <Section title="可用变量" description="点击变量会插入到模板光标位置。未识别变量会原样保留，便于排查拼写。">
        <div className="grid gap-2">
          {state.variables.map((variable) => (
            <button
              key={variable.key}
              type="button"
              className="grid gap-2 cds-surface-raised cds-hairline px-3 py-3 text-left transition-colors hover:bg-accent hover:text-accent-foreground md:grid-cols-[180px_180px_minmax(0,1fr)] md:items-center"
              onClick={() => insertVariable(variable.key)}
            >
              <code className="rounded bg-muted px-2 py-1 font-mono text-xs text-foreground">{`{{${variable.key}}}`}</code>
              <span className="text-sm font-medium">{variable.label}</span>
              <span className="min-w-0 break-all font-mono text-xs text-muted-foreground">{variable.example}</span>
            </button>
          ))}
        </div>
      </Section>

      <Section title="示例预览" description="使用示例 PR 和分支数据渲染当前模板，保存前可先检查 Markdown 效果。">
        <div className="min-h-32 whitespace-pre-wrap break-words cds-surface-raised cds-hairline px-4 py-4 font-mono text-sm leading-6">
          {state.preview || '点击“预览”后显示渲染结果。'}
        </div>
      </Section>
    </div>
  );
}

type DisplayCacheDir = CacheDirInfo & { orphan: boolean };

function CacheDiagnosticTab({ onToast }: { onToast: (message: string) => void }): JSX.Element {
  const [state, setState] = useState<
    | { status: 'loading' }
    | { status: 'error'; message: string }
    | { status: 'ok'; data: CacheStatusResponse }
  >({ status: 'loading' });
  const [repairing, setRepairing] = useState(false);
  const [importName, setImportName] = useState('');
  const [importFile, setImportFile] = useState<File | null>(null);
  const [importInputKey, setImportInputKey] = useState(0);
  const [importing, setImporting] = useState(false);
  const [purgeTarget, setPurgeTarget] = useState<DisplayCacheDir | null>(null);
  const [purging, setPurging] = useState(false);

  const load = useCallback(async () => {
    setState({ status: 'loading' });
    try {
      const data = await apiRequest<CacheStatusResponse>('/api/cache/status');
      setState({ status: 'ok', data });
    } catch (err) {
      setState({ status: 'error', message: messageFromError(err) });
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function repair(): Promise<void> {
    setRepairing(true);
    try {
      const result = await apiRequest<CacheRepairResponse>('/api/cache/repair', { method: 'POST' });
      onToast(result.message || '缓存挂载已检查');
      await load();
    } catch (err) {
      onToast(messageFromError(err));
    } finally {
      setRepairing(false);
    }
  }

  async function importCache(): Promise<void> {
    const name = importName.trim();
    if (!name) {
      onToast('请填写缓存名称');
      return;
    }
    if (!/^[a-z0-9][a-z0-9-]*$/i.test(name)) {
      onToast('缓存名称只允许字母、数字和连字符');
      return;
    }
    if (!importFile) {
      onToast('请选择 tar.gz 文件');
      return;
    }

    setImporting(true);
    try {
      const res = await fetch(`/api/cache/import?name=${encodeURIComponent(name)}`, {
        method: 'POST',
        credentials: 'include',
        headers: { Accept: 'application/json', 'Content-Type': 'application/gzip' },
        body: importFile,
      });
      const text = await res.text();
      let parsed: unknown = {};
      if (text) {
        try {
          parsed = JSON.parse(text);
        } catch {
          parsed = text;
        }
      }
      if (!res.ok) {
        const message =
          typeof parsed === 'object' && parsed !== null && 'error' in parsed
            ? String((parsed as { error: unknown }).error)
            : `POST /api/cache/import → ${res.status}`;
        throw new Error(message);
      }
      const result = parsed as CacheImportResponse;
      onToast(result.message || '缓存已导入');
      setImportName('');
      setImportFile(null);
      setImportInputKey((current) => current + 1);
      await load();
    } catch (err) {
      onToast(messageFromError(err));
    } finally {
      setImporting(false);
    }
  }

  async function purgeCache(): Promise<void> {
    if (!purgeTarget) return;
    setPurging(true);
    try {
      await apiRequest(`/api/cache/purge?name=${encodeURIComponent(purgeTarget.name)}`, { method: 'POST' });
      onToast(`已清空缓存 ${purgeTarget.name}`);
      setPurgeTarget(null);
      await load();
    } catch (err) {
      onToast(messageFromError(err));
    } finally {
      setPurging(false);
    }
  }

  if (state.status === 'loading') return <LoadingBlock label="加载缓存诊断" />;
  if (state.status === 'error') return <ErrorBlock message={state.message} />;

  const data = state.data;
  const rows: DisplayCacheDir[] = [
    ...(data.caches || []).map((cache) => ({ ...cache, orphan: false })),
    ...(data.orphans || []).map((cache) => ({ ...cache, orphan: true })),
  ];

  return (
    <div className="space-y-8">
      <Section
        title="缓存诊断"
        description="检查 BuildProfile cacheMount 的宿主机目录、容器路径、目录大小和最近写入，定位 restore 或 install 反复冷下载的问题。"
      >
        <div className="space-y-5">
          <div className="grid gap-3 md:grid-cols-3">
            <InfoRow label="项目 slug" value={data.projectSlug || '暂无'} />
            <InfoRow label="缓存根目录" value={data.cacheBase || '暂无'} />
            <InfoRow label="总占用" value={data.totalBytesHuman || formatBytes(data.totalBytes)} />
          </div>

          {data.warnings?.length ? (
            <div className="rounded-md border border-amber-500/40 bg-amber-500/10 px-4 py-3">
              <div className="mb-2 flex items-center gap-2 text-sm font-medium text-amber-600 dark:text-amber-400">
                <AlertTriangle className="h-4 w-4" />
                发现 {data.warnings.length} 条告警
              </div>
              <ul className="space-y-1 pl-5 text-sm leading-6 text-muted-foreground">
                {data.warnings.map((warning) => (
                  <li key={warning} className="list-disc">
                    {warning}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          <div className="flex flex-wrap gap-2">
            <Button type="button" onClick={() => void repair()} disabled={repairing}>
              {repairing ? <Loader2 className="animate-spin" /> : <Wrench />}
              修复缓存挂载
            </Button>
            <Button type="button" variant="outline" onClick={() => void load()}>
              <RefreshCw />
              刷新
            </Button>
          </div>

          <CacheTable rows={rows} onExport={exportCache} onPurge={setPurgeTarget} />
        </div>
      </Section>

      <Section
        title="导入缓存包"
        description="迁移服务器时，可把旧 CDS 导出的 tar.gz 缓存包导入到当前缓存根目录。"
      >
        <div className="max-w-3xl cds-surface-raised cds-hairline px-4 py-4">
          <div className="grid gap-3 md:grid-cols-[180px_minmax(0,1fr)_auto] md:items-end">
            <label className="block space-y-1.5">
              <span className="text-sm font-medium">缓存名称</span>
              <input
                className={monoInputClass}
                value={importName}
                onChange={(event) => setImportName(event.target.value)}
                placeholder="nuget 或 pnpm"
              />
            </label>
            <label className="block space-y-1.5">
              <span className="text-sm font-medium">tar.gz 文件</span>
              <input
                key={importInputKey}
                className="block w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                type="file"
                accept=".tar.gz,.tgz,application/gzip"
                onChange={(event) => setImportFile(event.currentTarget.files?.[0] || null)}
              />
            </label>
            <Button type="button" onClick={() => void importCache()} disabled={importing}>
              {importing ? <Loader2 className="animate-spin" /> : <Upload />}
              导入
            </Button>
          </div>
          <div className="mt-3 text-xs text-muted-foreground">
            {importFile ? `${importFile.name}，${formatBytes(importFile.size)}` : '尚未选择文件。'}
          </div>
        </div>
      </Section>

      <Dialog open={Boolean(purgeTarget)} onOpenChange={(open) => !open && setPurgeTarget(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>清空缓存目录</DialogTitle>
            <DialogDescription>
              这会清空缓存 {purgeTarget?.name ? `“${purgeTarget.name}”` : ''}，下次 restore 或 install 会重新下载依赖。
            </DialogDescription>
          </DialogHeader>
          {purgeTarget ? (
            <div className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 font-mono text-xs text-destructive">
              {purgeTarget.hostPath}
            </div>
          ) : null}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setPurgeTarget(null)}>
              取消
            </Button>
            <Button type="button" variant="destructive" onClick={() => void purgeCache()} disabled={purging}>
              {purging ? <Loader2 className="animate-spin" /> : <Trash2 />}
              清空缓存
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function exportCache(name: string): void {
  window.location.href = `/api/cache/export?name=${encodeURIComponent(name)}`;
}

function CacheTable({
  rows,
  onExport,
  onPurge,
}: {
  rows: DisplayCacheDir[];
  onExport: (name: string) => void;
  onPurge: (cache: DisplayCacheDir) => void;
}): JSX.Element {
  if (rows.length === 0) {
    return (
      <div className="rounded-md border border-dashed border-border bg-card px-4 py-8 text-center text-sm text-muted-foreground">
        暂无缓存挂载。
      </div>
    );
  }

  return (
    <div className="overflow-x-auto rounded-md border border-border">
      <table className="w-full min-w-[920px] border-collapse text-sm">
        <thead className="bg-muted/40 text-left text-xs text-muted-foreground">
          <tr>
            <th className="px-3 py-2 font-medium">名称</th>
            <th className="px-3 py-2 font-medium">宿主机路径</th>
            <th className="px-3 py-2 font-medium">容器内路径</th>
            <th className="px-3 py-2 text-right font-medium">大小</th>
            <th className="px-3 py-2 text-right font-medium">文件数</th>
            <th className="px-3 py-2 font-medium">最近写入</th>
            <th className="px-3 py-2 font-medium">使用者</th>
            <th className="px-3 py-2 text-right font-medium">操作</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((cache) => (
            <CacheRow key={`${cache.hostPath}-${cache.containerPath}`} cache={cache} onExport={onExport} onPurge={onPurge} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function CacheRow({
  cache,
  onExport,
  onPurge,
}: {
  cache: DisplayCacheDir;
  onExport: (name: string) => void;
  onPurge: (cache: DisplayCacheDir) => void;
}): JSX.Element {
  const status = getCacheStatus(cache);
  return (
    <tr className={cache.orphan ? 'border-t border-border opacity-75' : 'border-t border-border'}>
      <td className="px-3 py-2">
        <div className="flex items-center gap-2">
          <span className={`h-2.5 w-2.5 rounded-full ${status.className}`} title={status.label} />
          <span className="font-medium">{cache.name}</span>
          {cache.orphan ? <span className="rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">孤儿</span> : null}
        </div>
      </td>
      <td className="max-w-[260px] truncate px-3 py-2 font-mono text-xs" title={cache.hostPath}>
        {cache.hostPath}
      </td>
      <td className="max-w-[180px] truncate px-3 py-2 font-mono text-xs" title={cache.containerPath}>
        {cache.containerPath}
      </td>
      <td className="px-3 py-2 text-right">{formatBytes(cache.sizeBytes)}</td>
      <td className="px-3 py-2 text-right">{cache.fileCount == null ? '暂无' : cache.fileCount.toLocaleString()}</td>
      <td className="px-3 py-2 text-muted-foreground">{formatDate(cache.lastModified)}</td>
      <td className="max-w-[180px] truncate px-3 py-2 text-muted-foreground" title={cache.usedByProfiles.join(', ')}>
        {cache.usedByProfiles.length ? cache.usedByProfiles.join(', ') : '暂无'}
      </td>
      <td className="px-3 py-2">
        <div className="flex justify-end gap-2">
          <Button type="button" variant="outline" size="sm" onClick={() => onExport(cache.name)} disabled={!cache.exists}>
            <Download />
            导出
          </Button>
          <Button type="button" variant="outline" size="sm" onClick={() => onPurge(cache)} disabled={!cache.exists}>
            <Trash2 />
            清空
          </Button>
        </div>
      </td>
    </tr>
  );
}

function getCacheStatus(cache: CacheDirInfo): { label: string; className: string } {
  if (!cache.exists) return { label: '目录不存在', className: 'bg-destructive' };
  if ((cache.sizeBytes || 0) === 0 && (cache.fileCount || 0) === 0) {
    return { label: '目录为空', className: 'bg-amber-500' };
  }
  return { label: '已有缓存', className: 'bg-emerald-500' };
}

function StatsTab({ project, projectId }: { project: ProjectSummary; projectId: string }): JSX.Element {
  return (
    <div className="space-y-8">
      <Section title="项目运营汇总" description="计数来自项目和分支状态，随 MongoDB split store 持久化。">
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <MetricTile
            label="分支数"
            value={numberValue(project.branchCount)}
            className="bg-card p-4"
            valueClassName="text-xl font-semibold"
          />
          <MetricTile
            label="运行分支"
            value={numberValue(project.runningBranchCount)}
            className="bg-card p-4"
            valueClassName="text-xl font-semibold"
          />
          <MetricTile
            label="运行服务"
            value={numberValue(project.runningServiceCount)}
            className="bg-card p-4"
            valueClassName="text-xl font-semibold"
          />
          <MetricTile
            label="最近部署"
            value={formatDate(project.lastDeployedAt)}
            className="bg-card p-4"
            valueClassName="text-xl font-semibold"
          />
          <MetricTile
            label="累计部署"
            value={numberValue(project.deployCount)}
            className="bg-card p-4"
            valueClassName="text-xl font-semibold"
          />
          <MetricTile
            label="累计拉取"
            value={numberValue(project.pullCount)}
            className="bg-card p-4"
            valueClassName="text-xl font-semibold"
          />
          <MetricTile
            label="停止容器"
            value={numberValue(project.stopCount)}
            className="bg-card p-4"
            valueClassName="text-xl font-semibold"
          />
          <MetricTile
            label="AI 占用"
            value={numberValue(project.aiOpCount)}
            className="bg-card p-4"
            valueClassName="text-xl font-semibold"
          />
        </div>
      </Section>
      <BranchStats projectId={projectId} />
    </div>
  );
}

function BranchStats({ projectId }: { projectId: string }): JSX.Element {
  const [state, setState] = useState<
    | { status: 'loading' }
    | { status: 'error'; message: string }
    | { status: 'ok'; branches: BranchSummary[] }
  >({ status: 'loading' });

  const load = useCallback(async () => {
    setState({ status: 'loading' });
    try {
      const data = await apiRequest<BranchesResponse>(`/api/branches?project=${encodeURIComponent(projectId)}`);
      setState({ status: 'ok', branches: data.branches || [] });
    } catch (err) {
      setState({ status: 'error', message: messageFromError(err) });
    }
  }, [projectId]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <Section title="分支详细计数">
      {state.status === 'loading' ? <LoadingBlock label="加载分支统计" /> : null}
      {state.status === 'error' ? <ErrorBlock message={state.message} /> : null}
      {state.status === 'ok' && state.branches.length === 0 ? (
        <div className="rounded-md border border-dashed border-border bg-card px-4 py-6 text-sm text-muted-foreground">
          当前项目还没有分支。
        </div>
      ) : null}
      {state.status === 'ok' && state.branches.length > 0 ? (
        <div className="overflow-x-auto rounded-md border border-border">
          <table className="w-full min-w-[720px] border-collapse text-sm">
            <thead className="bg-muted/40 text-left text-xs text-muted-foreground">
              <tr>
                <th className="px-3 py-2 font-medium">分支</th>
                <th className="px-3 py-2 font-medium">部署</th>
                <th className="px-3 py-2 font-medium">拉取</th>
                <th className="px-3 py-2 font-medium">停止</th>
                <th className="px-3 py-2 font-medium">AI 占用</th>
                <th className="px-3 py-2 font-medium">调试切换</th>
                <th className="px-3 py-2 font-medium">最近部署</th>
              </tr>
            </thead>
            <tbody>
              {state.branches.map((branch) => (
                <tr key={branch.id || branch.branch} className="border-t border-border">
                  <td className="px-3 py-2 font-medium">{branch.branch || branch.id || '未命名分支'}</td>
                  <td className="px-3 py-2">{numberValue(branch.deployCount)}</td>
                  <td className="px-3 py-2">{numberValue(branch.pullCount)}</td>
                  <td className="px-3 py-2">{numberValue(branch.stopCount)}</td>
                  <td className="px-3 py-2">{numberValue(branch.aiOpCount)}</td>
                  <td className="px-3 py-2">{numberValue(branch.debugCount)}</td>
                  <td className="px-3 py-2 text-muted-foreground">{formatDate(branch.lastDeployAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </Section>
  );
}

function ActivityTab({ projectId }: { projectId: string }): JSX.Element {
  const [state, setState] = useState<
    | { status: 'loading' }
    | { status: 'error'; message: string }
    | { status: 'ok'; logs: ActivityLogEntry[] }
  >({ status: 'loading' });

  const load = useCallback(async () => {
    setState({ status: 'loading' });
    try {
      const data = await apiRequest<ActivityLogsResponse>(
        `/api/projects/${encodeURIComponent(projectId)}/activity-logs?limit=50`,
      );
      setState({ status: 'ok', logs: data.logs || [] });
    } catch (err) {
      setState({ status: 'error', message: messageFromError(err) });
    }
  }, [projectId]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <Section
      title="最近活动日志"
      description="按时间倒序展示最近 50 条项目活动。"
    >
      <div className="mb-4">
        <Button variant="outline" size="sm" onClick={() => void load()}>
          <RefreshCw />
          刷新
        </Button>
      </div>
      {state.status === 'loading' ? <LoadingBlock label="加载活动日志" /> : null}
      {state.status === 'error' ? <ErrorBlock message={state.message} /> : null}
      {state.status === 'ok' && state.logs.length === 0 ? (
        <div className="rounded-md border border-dashed border-border bg-card px-4 py-6 text-sm text-muted-foreground">
          暂无活动记录。
        </div>
      ) : null}
      {state.status === 'ok' && state.logs.length > 0 ? (
        <div className="space-y-2">
          {state.logs.map((entry, index) => (
            <ActivityItem key={`${entry.at}-${entry.type}-${index}`} entry={entry} />
          ))}
        </div>
      ) : null}
    </Section>
  );
}

function ActivityItem({ entry }: { entry: ActivityLogEntry }): JSX.Element {
  const typeLabel = activityTypeLabels[entry.type] || entry.type || '活动';
  const branch = entry.branchName || entry.branchId || '无分支';
  const actor = entry.actor || '系统';

  return (
    <div className="grid gap-2 cds-surface-raised cds-hairline px-3 py-3 text-sm md:grid-cols-[160px_120px_minmax(0,1fr)_120px] md:items-center">
      <div className="font-mono text-xs text-muted-foreground">{formatDate(entry.at)}</div>
      <div className="font-medium">{typeLabel}</div>
      <div className="min-w-0 truncate text-muted-foreground">
        <GitBranch className="mr-1 inline h-4 w-4 align-[-3px]" />
        {branch}
        {entry.note ? <span className="ml-2">{entry.note}</span> : null}
      </div>
      <div className="truncate text-xs text-muted-foreground">{actor}</div>
    </div>
  );
}

function DangerZoneTab({
  project,
  onToast,
}: {
  project: ProjectSummary;
  onToast: (message: string) => void;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState('');
  const canDelete = !project.legacyFlag;
  const name = displayName(project);

  async function deleteProject(): Promise<void> {
    setDeleting(true);
    setError('');
    try {
      await apiRequest(`/api/projects/${encodeURIComponent(project.id)}`, { method: 'DELETE' });
      onToast('项目已删除，正在返回项目列表');
      window.setTimeout(() => {
        window.location.href = '/project-list';
      }, 600);
    } catch (err) {
      setError(messageFromError(err));
    } finally {
      setDeleting(false);
    }
  }

  return (
    <div className="space-y-8">
      <Section
        title="危险区"
        description="这些操作不可撤销。删除项目前请确认不再需要项目内分支、构建配置、基础设施和路由状态。"
        tone="danger"
      >
        <div className="max-w-3xl rounded-md border border-destructive/30 bg-destructive/10 px-4 py-4">
          <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
            <div className="min-w-0 space-y-2">
              <div className="font-medium text-destructive">删除项目</div>
              {canDelete ? (
                <div className="text-sm leading-6 text-muted-foreground">
                  将删除 <CodePill>{name}</CodePill> 的项目状态，并尝试移除 Docker 网络{' '}
                  <CodePill>{project.dockerNetwork || '暂无'}</CodePill>。
                </div>
              ) : (
                <div className="text-sm leading-6 text-muted-foreground">
                  legacy 默认项目受保护，必须先迁移到真实项目名后才能删除。
                </div>
              )}
            </div>
            <Button type="button" variant="destructive" onClick={() => setOpen(true)} disabled={!canDelete}>
              <Trash2 />
              删除此项目
            </Button>
          </div>
        </div>
      </Section>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>删除项目</DialogTitle>
            <DialogDescription>
              将永久删除项目 “{name}” 及其项目内状态。此操作不可撤销。
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2 cds-surface-raised cds-hairline px-3 py-3 text-sm">
            <InfoRow label="项目 ID" value={project.id} />
            <InfoRow label="Docker 网络" value={project.dockerNetwork || '暂无'} />
          </div>
          {error ? (
            <div className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
              {error}
            </div>
          ) : null}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setOpen(false)}>
              取消
            </Button>
            <Button type="button" variant="destructive" onClick={() => void deleteProject()} disabled={deleting}>
              {deleting ? <Loader2 className="animate-spin" /> : <Trash2 />}
              删除项目
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

const activityTypeLabels: Record<string, string> = {
  deploy: '部署完成',
  'deploy-failed': '部署失败',
  pull: '拉取代码',
  stop: '停止容器',
  'colormark-on': '标记调试中',
  'colormark-off': '取消调试中',
  'ai-occupy': 'AI 占用开始',
  'ai-release': 'AI 占用结束',
  'branch-deleted': '删除分支',
  'branch-created': '创建分支',
};
