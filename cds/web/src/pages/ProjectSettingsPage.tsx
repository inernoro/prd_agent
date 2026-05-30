import { FormEvent, useCallback, useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import {
  Activity,
  AlertTriangle,
  ArrowLeft,
  BarChart3,
  ChevronDown,
  ChevronRight,
  Copy,
  Database,
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
  Rocket,
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
import { apiRequest, apiUrl, ApiError } from '@/lib/api';
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
  defaultDeployModes?: Record<string, string>;
  /** 2026-05-14: 部署成 running 后 N 分钟自动切到发布版（0=关）。 */
  autoPublishAfterMinutes?: number;
  /** Deprecated: 项目级自动停止已收敛到系统调度器，保存生命周期时会清零。 */
  autoStopAfterMinutes?: number;
}

interface BuildProfileSummary {
  id: string;
  name: string;
  deployModes?: Record<string, { label?: string }>;
}

interface BuildProfilesResponse {
  profiles: BuildProfileSummary[];
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
  /** 自增 id(<projectId>:<seq>),前端 dedupe key */
  id?: string;
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
  | 'runtime-defaults'
  | 'compose'
  | 'infra'
  | 'storage'
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
      { value: 'runtime-defaults', label: '新分支默认', icon: Rocket },
      { value: 'compose', label: '项目配置', icon: FileText },
      { value: 'infra', label: '基础设施', icon: Plug },
      { value: 'storage', label: '存储', icon: Database },
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
  if (tabs.some((tab) => tab.value === hash)) return hash as TabValue;

  const queryTab = new URLSearchParams(window.location.search).get('tab') || '';
  return tabs.some((tab) => tab.value === queryTab) ? (queryTab as TabValue) : 'general';
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
                <Link to="/project-list">
                  <ArrowLeft />
                  项目
                </Link>
              </Button>
              <Button asChild variant="ghost" size="sm" title="分支控制台">
                <Link to={`/branches/${encodeURIComponent(projectId || '')}`}>
                  <GitBranch />
                </Link>
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
              <Link to="/project-list">
                <ArrowLeft />
                返回项目列表
              </Link>
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
                <TabsContent value="runtime-defaults">
                  <RuntimeDefaultsTab project={project} projectId={project.id} onSaved={setProject} onToast={setToast} />
                </TabsContent>
                <TabsContent value="compose">
                  <ProjectComposeTab projectId={project.id} onToast={setToast} />
                </TabsContent>
                <TabsContent value="infra">
                  <ProjectInfraTab projectId={project.id} onToast={setToast} />
                </TabsContent>
                <TabsContent value="storage">
                  <ProjectStorageTab projectId={project.id} onToast={setToast} />
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
            <Link className="text-primary underline-offset-4 hover:underline" to="/cds-settings#global-vars">
              CDS 全局变量
            </Link>
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

function RuntimeDefaultsTab({
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
  const [profiles, setProfiles] = useState<BuildProfileSummary[]>([]);
  const [modes, setModes] = useState<Record<string, string>>(project.defaultDeployModes || {});
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    setModes(project.defaultDeployModes || {});
  }, [project.defaultDeployModes]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError('');
    apiRequest<BuildProfilesResponse>(`/api/build-profiles?project=${encodeURIComponent(projectId)}`)
      .then((res) => {
        if (!cancelled) setProfiles(res.profiles || []);
      })
      .catch((err) => {
        if (!cancelled) setError(messageFromError(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, [projectId]);

  async function saveDefaults(): Promise<void> {
    setSaving(true);
    setError('');
    try {
      const cleaned: Record<string, string> = {};
      for (const profile of profiles) {
        cleaned[profile.id] = modes[profile.id] || '';
      }
      const result = await apiRequest<ProjectSaveResponse>(`/api/projects/${encodeURIComponent(projectId)}`, {
        method: 'PUT',
        body: { defaultDeployModes: cleaned },
      });
      onSaved(result.project);
      onToast('新分支默认运行模式已保存；只影响之后创建的分支');
    } catch (err) {
      setError(messageFromError(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-6">
      <Section
        title="新分支默认运行模式"
        description="这里只是项目模板。保存后不会改任何已有分支；新分支创建时会复制成该分支自己的容器覆盖。"
      >
        {loading ? <LoadingBlock label="加载构建配置" /> : null}
        {error ? <ErrorBlock message={error} /> : null}
        {!loading && profiles.length === 0 ? (
          <div className="rounded-md border border-dashed border-[hsl(var(--hairline))] px-4 py-6 text-sm text-muted-foreground">
            当前项目还没有 BuildProfile，先导入或创建构建配置后再设置默认模式。
          </div>
        ) : null}
        <div className="space-y-3">
          {profiles.map((profile) => {
            const entries = Object.entries(profile.deployModes || {});
            return (
              <div key={profile.id} className="flex flex-wrap items-center gap-3 rounded-md border border-[hsl(var(--hairline))] bg-[hsl(var(--surface-raised))] px-3 py-3">
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium">{profile.name || profile.id}</div>
                  <div className="mt-1 font-mono text-xs text-muted-foreground">{profile.id}</div>
                </div>
                <select
                  className="h-9 min-w-[180px] rounded-md border border-input bg-background px-3 text-sm"
                  value={modes[profile.id] || ''}
                  onChange={(event) => setModes((current) => ({ ...current, [profile.id]: event.target.value }))}
                  disabled={entries.length === 0}
                  title="只作为新分支模板，不影响已有分支"
                >
                  <option value="">热加载 / 源码默认</option>
                  {entries.map(([modeId, mode]) => (
                    <option key={modeId} value={modeId}>
                      {mode.label || modeId}
                    </option>
                  ))}
                </select>
              </div>
            );
          })}
        </div>
        <div className="mt-4 flex flex-wrap items-center gap-3">
          <Button type="button" onClick={() => void saveDefaults()} disabled={saving || loading}>
            {saving ? <Loader2 className="animate-spin" /> : <Save />}
            保存默认模式
          </Button>
          <span className="text-xs text-muted-foreground">已有分支请在分支详情抽屉里单独切换。</span>
        </div>
      </Section>

      <AutoLifecycleSection
        project={project}
        projectId={projectId}
        onSaved={onSaved}
        onToast={onToast}
      />
    </div>
  );
}

/**
 * 项目级自动生命周期策略：
 * 启动满 N 分钟自动切到发布版（用于"调试结束后就该切到 publish"场景）。
 *
 * 计时锚点 = BranchEntry.lastReadyAt（容器进入 running 时打戳）。
 * HTTP 流量不参与计时，避免长连接 / 健康检查永远刷新。
 */
function AutoLifecycleSection({
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
  const initialPublish = Number(project.autoPublishAfterMinutes) || 0;
  const [publishEnabled, setPublishEnabled] = useState(initialPublish > 0);
  const [publishMinutes, setPublishMinutes] = useState(initialPublish > 0 ? initialPublish : 3);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    const p = Number(project.autoPublishAfterMinutes) || 0;
    setPublishEnabled(p > 0);
    setPublishMinutes(p > 0 ? p : 3);
  }, [project.autoPublishAfterMinutes]);

  async function save(): Promise<void> {
    setSaving(true);
    setError('');
    try {
      const body: Record<string, number> = {
        autoPublishAfterMinutes: publishEnabled ? Math.max(1, Math.floor(publishMinutes)) : 0,
        // 旧版曾暴露第二个"自动停止"分钟值，和系统调度器职责重叠。
        // 现在项目生命周期只保留一个用户心智：运行 X 分钟后切发布版。
        autoStopAfterMinutes: 0,
      };
      const result = await apiRequest<ProjectSaveResponse>(
        `/api/projects/${encodeURIComponent(projectId)}`,
        // 后端只注册 PUT /api/projects/:id（无 PATCH 路由）；与本页其他
        // 保存（默认模式 / GitHub policy / 常规）保持一致用 PUT。
        { method: 'PUT', body },
      );
      onSaved(result.project);
      onToast('自动切发布版策略已保存；下一次容器进入运行状态时开始计时');
    } catch (err) {
      setError(messageFromError(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Section
      title="自动切发布版"
      description="按「部署成功（容器进入 running）后的存活时间」计时。到点后自动把分支切到发布版并重新部署；HTTP 流量不参与计时。"
    >
      <div className="space-y-3">
        <div className="rounded-md border border-[hsl(var(--hairline))] bg-[hsl(var(--surface-raised))] px-4 py-3">
          <label className="flex flex-wrap items-center gap-3 text-sm">
            <input
              type="checkbox"
              className="h-4 w-4"
              checked={publishEnabled}
              onChange={(e) => setPublishEnabled(e.target.checked)}
            />
            <span className="font-medium">运行满</span>
            <input
              type="number"
              min={1}
              max={1440}
              value={publishMinutes}
              disabled={!publishEnabled}
              onChange={(e) => setPublishMinutes(Number(e.target.value) || 1)}
              className="h-8 w-20 rounded-md border border-input bg-background px-2 text-sm"
            />
            <span className="font-medium">分钟后自动切到发布版</span>
          </label>
          <div className="mt-1.5 ml-7 text-xs leading-5 text-muted-foreground">
            把所有 profile 的 activeDeployMode 翻到 deployModes 里第一个匹配「发布/生产/release/publish」
            的模式，并立即重新部署为发布版。默认建议 3 分钟。
          </div>
        </div>

        {error ? <ErrorBlock message={error} /> : null}

        <div className="flex flex-wrap items-center gap-3">
          <Button type="button" onClick={() => void save()} disabled={saving}>
            {saving ? <Loader2 className="animate-spin" /> : <Save />}
            保存
          </Button>
          <span className="text-xs text-muted-foreground">
            本策略是<strong>项目级</strong>，对该项目下所有分支生效。需要空闲自动停止时，请使用 CDS 系统级「调度器」。
          </span>
        </div>
      </div>
    </Section>
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
      const data = await apiRequest<BranchesResponse>(`/api/branches?project=${encodeURIComponent(projectId)}&live=false`);
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

/**
 * 把 actor 字符串归类成显示标签 + chip 颜色 — 用户反馈 2026-05-07
 * "项目活动日志一律显示 user,看不出是 user 还是自动部署"。
 *
 * 来源(actor-resolver.ts 优先级):
 *   - 'system:webhook'        → GitHub webhook 自动触发(蓝色)
 *   - 'system:slash-command'  → PR 评论里 /cds 指令(蓝色)
 *   - 'system:<其他>'         → 其他内部系统调用(灰色)
 *   - 'ai:<name>' / 'ai'      → AI agent (紫色)
 *   - 'user'                  → 浏览器登录用户(默认色)
 *   - undefined               → '系统'(更早期数据)
 */
function classifyActor(raw: string | undefined): { label: string; tone: string } {
  if (!raw) return { label: '系统', tone: 'border-muted bg-muted/20 text-muted-foreground' };
  if (raw === 'system:webhook') {
    return { label: 'GitHub Webhook', tone: 'border-sky-500/40 bg-sky-500/10 text-sky-700 dark:text-sky-300' };
  }
  if (raw === 'system:slash-command') {
    return { label: 'PR 指令', tone: 'border-sky-500/40 bg-sky-500/10 text-sky-700 dark:text-sky-300' };
  }
  if (raw.startsWith('system:')) {
    return { label: raw.slice('system:'.length) || '系统', tone: 'border-muted bg-muted/30 text-muted-foreground' };
  }
  if (raw.startsWith('ai:')) {
    return { label: `AI · ${raw.slice('ai:'.length)}`, tone: 'border-purple-500/40 bg-purple-500/10 text-purple-700 dark:text-purple-300' };
  }
  if (raw === 'ai') {
    return { label: 'AI', tone: 'border-purple-500/40 bg-purple-500/10 text-purple-700 dark:text-purple-300' };
  }
  if (raw === 'user') {
    return { label: '用户', tone: 'border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300' };
  }
  // 兜底:可能是真实用户名
  return { label: raw, tone: 'border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300' };
}

function ActivityItem({ entry }: { entry: ActivityLogEntry }): JSX.Element {
  const typeLabel = activityTypeLabels[entry.type] || entry.type || '活动';
  const branch = entry.branchName || entry.branchId || '无分支';
  const actor = classifyActor(entry.actor);
  const [expanded, setExpanded] = useState(false);
  // 2026-05-07 wave 1.2:错误事件用 destructive 边框 + 浅红底高亮,
  // 让用户从一屏 50 条里一眼看出哪条失败 / 哪条中止。
  const isError = entry.type.includes('failed') || entry.type.includes('error');
  const isAborted = entry.type.includes('aborted');
  const rowTone = isError
    ? 'border border-destructive/40 bg-destructive/5'
    : isAborted
      ? 'border border-amber-500/40 bg-amber-500/5'
      : 'cds-surface-raised cds-hairline';

  return (
    <div className={`${rowTone}`}>
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="grid w-full gap-2 px-3 py-3 text-left text-sm md:grid-cols-[20px_160px_120px_minmax(0,1fr)_140px] md:items-center hover:bg-muted/10"
        aria-expanded={expanded}
      >
        {expanded ? <ChevronDown className="h-4 w-4 text-muted-foreground" /> : <ChevronRight className="h-4 w-4 text-muted-foreground" />}
        <div className="font-mono text-xs text-muted-foreground">{formatDate(entry.at)}</div>
        <div className={`font-medium ${isError ? 'text-destructive' : isAborted ? 'text-amber-700 dark:text-amber-300' : ''}`}>
          {typeLabel}
        </div>
        <div className="min-w-0 truncate text-muted-foreground">
          <GitBranch className="mr-1 inline h-4 w-4 align-[-3px]" />
          {branch}
          {entry.note ? <span className="ml-2">{entry.note}</span> : null}
        </div>
        <div className="flex justify-end">
          <span
            className={`inline-flex items-center rounded-md border px-2 py-0.5 text-[11px] ${actor.tone}`}
            title={entry.actor || '系统'}
          >
            {actor.label}
          </span>
        </div>
      </button>
      {expanded ? (
        <div className="border-t border-[hsl(var(--hairline))] bg-[hsl(var(--surface-sunken))] px-3 py-3 text-xs space-y-1">
          <DetailRow label="完整时间" value={entry.at} mono />
          <DetailRow label="事件类型" value={entry.type} mono />
          {entry.id ? <DetailRow label="事件 ID" value={entry.id} mono /> : null}
          {entry.branchId ? <DetailRow label="分支 ID" value={entry.branchId} mono /> : null}
          {entry.branchName ? <DetailRow label="分支名" value={entry.branchName} /> : null}
          <DetailRow label="actor 原值" value={entry.actor || '(空)'} mono />
          {entry.note ? <DetailRow label="备注" value={entry.note} /> : null}
        </div>
      ) : null}
    </div>
  );
}

function DetailRow({ label, value, mono }: { label: string; value: string; mono?: boolean }): JSX.Element {
  return (
    <div className="flex flex-wrap gap-x-3">
      <span className="text-muted-foreground">{label}:</span>
      <span className={mono ? 'font-mono break-all' : 'break-all'}>{value}</span>
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

// ─────────────────────────────────────────────────────────────
// 项目基础设施 Tab(2026-05-28 新增)
// 用户反馈:openvisual 的烂 minio infra 配置没法在 UI 里删,只能调
// `/api/infra/:id?project=<id>` DELETE。本 Tab 把列表 + 启停 + 删除做出来。
// ─────────────────────────────────────────────────────────────

interface ProjectInfraService {
  id: string;
  projectId: string;
  name: string;
  dockerImage: string;
  containerPort: number;
  hostPort: number;
  containerName: string;
  status: 'running' | 'stopped' | 'error';
  errorMessage?: string;
  command?: string | string[];
  entrypoint?: string | string[];
  restartPolicy?: string;
  createdAt: string;
}

// 项目配置 Tab — 虚拟 cds-compose.yml 读写 + 三级权威标注 (2026-05-29)
interface ComposeAuthorityEntry {
  path: string;
  authority: 'repo' | 'platform' | 'user';
  reason: string;
  known: boolean;
}
interface ProjectComposeResponse {
  yaml: string;
  hasPersisted: boolean;
  version: number;
  updatedAt: string | null;
  source: string | null;
  authority: ComposeAuthorityEntry[];
}

const AUTHORITY_META: Record<'repo' | 'platform' | 'user', { label: string; desc: string; cls: string }> = {
  repo: { label: 'repo 权威', desc: '构建/启动方式，由仓库结构决定，可改但应回写 repo', cls: 'bg-blue-500/10 text-blue-700 dark:text-blue-300' },
  platform: { label: 'platform 权威', desc: '端口/网络/域名，由 CDS 分配，只读', cls: 'bg-amber-500/10 text-amber-700 dark:text-amber-300' },
  user: { label: 'user 权威', desc: '环境变量等运营参数，用户可覆盖', cls: 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300' },
};

function ProjectComposeTab({
  projectId,
  onToast,
}: {
  projectId: string;
  onToast: (message: string) => void;
}): JSX.Element {
  const [data, setData] = useState<ProjectComposeResponse | null>(null);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [dirty, setDirty] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch(apiUrl(`/api/projects/${encodeURIComponent(projectId)}/compose`), { credentials: 'include' });
      const body = await res.json();
      if (!res.ok) { onToast(`加载失败:${body.error || res.status}`); return; }
      setData(body as ProjectComposeResponse);
      setDraft(body.yaml || '');
      setDirty(false);
    } catch (err) {
      onToast(`加载异常:${(err as Error).message}`);
    }
  }, [projectId, onToast]);

  useEffect(() => { void refresh(); }, [refresh]);

  const onSave = useCallback(async () => {
    if (!draft.trim()) { onToast('配置不能为空'); return; }
    setBusy(true);
    try {
      const res = await fetch(apiUrl(`/api/projects/${encodeURIComponent(projectId)}/compose`), {
        method: 'PUT',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ yaml: draft, actor: 'user', source: 'manual-edit' }),
      });
      const body = await res.json();
      if (!res.ok) {
        if (body.violations && body.violations.length > 0) {
          const paths = body.violations.map((v: { path: string }) => v.path).join('、');
          onToast(`保存被拒:${paths} 属于平台权威,不可修改`);
        } else {
          onToast(`保存失败:${body.error || res.status}`);
        }
        return;
      }
      onToast(`已保存为 v${body.version}(改动 ${(body.changedPaths || []).length} 个字段)`);
      await refresh();
    } catch (err) {
      onToast(`保存异常:${(err as Error).message}`);
    } finally {
      setBusy(false);
    }
  }, [draft, projectId, onToast, refresh]);

  if (!data) return <LoadingBlock label="加载项目配置…" />;

  // 按权威分组统计
  const counts = data.authority.reduce(
    (acc, a) => { acc[a.authority] = (acc[a.authority] || 0) + 1; return acc; },
    {} as Record<string, number>,
  );

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h3 className="text-base font-semibold">项目配置(cds-compose.yml)</h3>
        <p className="mt-1 text-sm text-muted-foreground">
          这是本项目的配置 SSOT。build profile / 基础设施都从它派生。
          {data.hasPersisted
            ? <> 当前 <span className="font-mono">v{data.version}</span>{data.updatedAt ? ` · ${new Date(data.updatedAt).toLocaleString()}` : ''}{data.source ? ` · 来源 ${data.source}` : ''}。</>
            : <> 该项目尚未固化配置,下方是从已落库 profile/infra 反向生成的<strong>只读起点</strong>,编辑保存后即成为正式 SSOT。</>}
        </p>
      </div>

      {/* 三级权威图例 */}
      <div className="flex flex-wrap gap-2 text-xs">
        {(['repo', 'platform', 'user'] as const).map((k) => (
          <span key={k} className={`inline-flex items-center gap-1 rounded px-2 py-1 ${AUTHORITY_META[k].cls}`} title={AUTHORITY_META[k].desc}>
            {AUTHORITY_META[k].label}{counts[k] ? ` · ${counts[k]}` : ''}
          </span>
        ))}
        <span className="self-center text-muted-foreground">platform 字段(端口/网络/域名)受保护,保存时若改动会被拒绝</span>
      </div>

      <div className="flex flex-wrap gap-2">
        <Button type="button" variant="outline" size="sm" asChild>
          <a href={apiUrl(`/api/projects/${encodeURIComponent(projectId)}/compose.yml`)} download="cds-compose.yml">
            <Download className="h-3.5 w-3.5" /> 下载 cds-compose.yml
          </a>
        </Button>
        <Button type="button" variant="outline" size="sm" onClick={() => { void navigator.clipboard?.writeText(draft); onToast('已复制到剪贴板'); }}>
          复制
        </Button>
        <Button type="button" variant="outline" size="sm" onClick={() => void refresh()} disabled={busy}>
          <RefreshCw className="h-3.5 w-3.5" /> 重新加载
        </Button>
        <Button type="button" variant="default" size="sm" onClick={() => void onSave()} disabled={busy || !dirty}>
          {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />} 保存配置
        </Button>
      </div>

      <textarea
        value={draft}
        onChange={(e) => { setDraft(e.target.value); setDirty(true); }}
        className="w-full rounded-md border border-[hsl(var(--hairline))] bg-[hsl(var(--surface-sunken))] p-3 font-mono text-xs"
        rows={20}
        spellCheck={false}
        disabled={busy}
        style={{ minHeight: 320, overflowY: 'auto' }}
      />

      {/* 字段权威明细 */}
      {data.authority.length > 0 ? (
        <details className="text-xs">
          <summary className="cursor-pointer text-muted-foreground">字段权威明细({data.authority.length})</summary>
          <div className="mt-2 space-y-1">
            {data.authority.map((a) => (
              <div key={a.path} className="flex items-center gap-2">
                <span className={`inline-flex shrink-0 rounded px-1.5 py-0.5 ${AUTHORITY_META[a.authority].cls}`}>{a.authority}</span>
                <code className="font-mono">{a.path}</code>
                <span className="truncate text-muted-foreground">{a.reason}</span>
              </div>
            ))}
          </div>
        </details>
      ) : null}
    </div>
  );
}

interface ProjectStorageVolumeRow {
  name: string;
  sizeBytes: number | null;
  sizeHuman: string;
  mountedBy: string[];
  containerPath: string;
  type: 'volume' | 'bind';
  note?: string;
}

interface ProjectStorageDiskInfo {
  filesystem?: string;
  totalBytes: number | null;
  usedBytes: number | null;
  availBytes: number | null;
  usePercent: number | null;
  mountedOn?: string;
}

interface ProjectStorageResponse {
  volumes: ProjectStorageVolumeRow[];
  totalBytes: number;
  totalHuman: string;
  diskInfo?: ProjectStorageDiskInfo;
  note?: string;
}

function ProjectStorageTab({
  projectId,
  onToast,
}: {
  projectId: string;
  onToast: (message: string) => void;
}): JSX.Element {
  const [data, setData] = useState<ProjectStorageResponse | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    setBusy(true);
    try {
      const res = await fetch(apiUrl(`/api/projects/${encodeURIComponent(projectId)}/storage`), { credentials: 'include' });
      const body = await res.json();
      if (!res.ok) { onToast(`加载失败：${body.error || res.status}`); return; }
      setData(body as ProjectStorageResponse);
    } catch (err) {
      onToast(`加载异常：${(err as Error).message}`);
    } finally {
      setBusy(false);
    }
  }, [projectId, onToast]);

  useEffect(() => { void refresh(); }, [refresh]);

  if (!data) return <LoadingBlock label="加载存储信息…" />;

  const disk = data.diskInfo;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="text-base font-semibold">项目存储</h3>
          <p className="mt-1 text-sm text-muted-foreground">
            本项目各基础设施服务的数据卷（docker named volume）大小与挂载关系。
            数据卷在重建容器时会保留，删除前请确认数据已备份。
          </p>
        </div>
        <Button type="button" variant="outline" size="sm" onClick={() => void refresh()} disabled={busy}>
          {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />} 刷新
        </Button>
      </div>

      {/* 概览：总占用 + 卷数量 + 可选磁盘信息 */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        <MetricTile
          icon={<Database className="h-3.5 w-3.5" />}
          label="数据卷总占用"
          value={data.totalHuman}
        />
        <MetricTile
          icon={<HardDrive className="h-3.5 w-3.5" />}
          label="数据卷数量"
          value={data.volumes.length}
        />
        {disk ? (
          <MetricTile
            icon={<HardDrive className="h-3.5 w-3.5" />}
            label="宿主机磁盘"
            value={
              disk.usePercent != null
                ? `已用 ${disk.usePercent}%`
                : '未知'
            }
            detail={
              disk.availBytes != null
                ? `剩余 ${formatBytes(disk.availBytes)}${disk.mountedOn ? ` · ${disk.mountedOn}` : ''}`
                : undefined
            }
          />
        ) : null}
      </div>

      {data.note ? (
        <div className="flex items-start gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>{data.note}</span>
        </div>
      ) : null}

      {/* 卷列表 / 空状态 */}
      {data.volumes.length === 0 ? (
        <div className="flex flex-col items-center gap-3 rounded-md border border-dashed border-border px-4 py-10 text-center">
          <Database className="h-8 w-8 text-muted-foreground" />
          <div className="text-sm font-medium">该项目还没有任何数据卷</div>
          <p className="max-w-md text-xs text-muted-foreground">
            数据卷由基础设施服务（如 MongoDB / Redis）声明。先到「基础设施」标签页添加带数据卷的服务，
            或在「项目配置」里给服务补上 volumes，重新同步后这里就会出现卷的占用情况。
          </p>
          <Button type="button" variant="outline" size="sm" asChild>
            <a href={`#infra`} onClick={(e) => { e.preventDefault(); window.location.hash = 'infra'; }}>
              前往基础设施
            </a>
          </Button>
        </div>
      ) : (
        <div className="overflow-hidden rounded-md border border-border">
          <table className="w-full text-sm">
            <thead className="bg-muted/40 text-xs text-muted-foreground">
              <tr>
                <th className="px-3 py-2 text-left font-medium">数据卷</th>
                <th className="px-3 py-2 text-right font-medium">大小</th>
                <th className="px-3 py-2 text-left font-medium">挂载服务</th>
                <th className="px-3 py-2 text-left font-medium">容器内路径</th>
                <th className="px-3 py-2 text-left font-medium">类型</th>
              </tr>
            </thead>
            <tbody>
              {data.volumes.map((vol) => (
                <tr key={vol.name} className="border-t border-border align-top">
                  <td className="px-3 py-2">
                    <code className="font-mono text-xs">{vol.name}</code>
                    {vol.note ? (
                      <div className="mt-0.5 text-xs text-muted-foreground">{vol.note}</div>
                    ) : null}
                  </td>
                  <td className="whitespace-nowrap px-3 py-2 text-right font-mono text-xs">
                    {vol.sizeHuman}
                  </td>
                  <td className="px-3 py-2">
                    <div className="flex flex-wrap gap-1">
                      {vol.mountedBy.map((svc) => (
                        <span key={svc} className="inline-flex rounded bg-muted px-1.5 py-0.5 font-mono text-xs">{svc}</span>
                      ))}
                    </div>
                  </td>
                  <td className="px-3 py-2">
                    <code className="font-mono text-xs text-muted-foreground">{vol.containerPath || '—'}</code>
                  </td>
                  <td className="px-3 py-2 text-xs">
                    {vol.type === 'bind' ? '目录挂载' : '数据卷'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function ProjectInfraTab({
  projectId,
  onToast,
}: {
  projectId: string;
  onToast: (message: string) => void;
}): JSX.Element {
  const [services, setServices] = useState<ProjectInfraService[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [resyncOpen, setResyncOpen] = useState(false);

  const refresh = useCallback(async () => {
    try {
      setError(null);
      const data = await apiRequest<{ services?: ProjectInfraService[] }>(
        `/api/infra?project=${encodeURIComponent(projectId)}&live=1`,
      );
      setServices(data.services || []);
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : (err as Error).message;
      setError(msg || '加载失败');
      setServices([]);
    }
  }, [projectId]);

  useEffect(() => { void refresh(); }, [refresh]);

  const doStart = useCallback(async (id: string) => {
    setBusy(id);
    try {
      await apiRequest(`/api/infra/${encodeURIComponent(id)}/start?project=${encodeURIComponent(projectId)}`, { method: 'POST' });
      onToast(`已启动 ${id}`);
      await refresh();
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : (err as Error).message;
      onToast(`启动失败:${msg}`);
    } finally {
      setBusy(null);
    }
  }, [projectId, refresh, onToast]);

  const doStop = useCallback(async (id: string) => {
    setBusy(id);
    try {
      await apiRequest(`/api/infra/${encodeURIComponent(id)}/stop?project=${encodeURIComponent(projectId)}`, { method: 'POST' });
      onToast(`已停止 ${id}`);
      await refresh();
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : (err as Error).message;
      onToast(`停止失败:${msg}`);
    } finally {
      setBusy(null);
    }
  }, [projectId, refresh, onToast]);

  const doDelete = useCallback(async (id: string) => {
    setBusy(id);
    try {
      await apiRequest(`/api/infra/${encodeURIComponent(id)}?project=${encodeURIComponent(projectId)}`, { method: 'DELETE' });
      onToast(`已删除 ${id}`);
      setConfirmDeleteId(null);
      await refresh();
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : (err as Error).message;
      onToast(`删除失败:${msg}`);
    } finally {
      setBusy(null);
    }
  }, [projectId, refresh, onToast]);

  if (services === null) return <LoadingBlock label="加载基础设施列表…" />;
  if (error && services.length === 0) return <ErrorBlock message={error} />;

  const runningCount = services.filter((s) => s.status === 'running').length;
  const stoppedCount = services.filter((s) => s.status !== 'running').length;

  const doStopAll = async (): Promise<void> => {
    if (busy) return;
    const running = services.filter((s) => s.status === 'running');
    if (running.length === 0) return;
    setBusy('__bulk__');
    try {
      for (const s of running) {
        try {
          await apiRequest(`/api/infra/${encodeURIComponent(s.id)}/stop?project=${encodeURIComponent(projectId)}`, { method: 'POST' });
        } catch { /* tolerate single failure */ }
      }
      onToast(`已停止 ${running.length} 个 infra 服务(数据卷保留)`);
      await refresh();
    } finally {
      setBusy(null);
    }
  };

  const doStartAll = async (): Promise<void> => {
    if (busy) return;
    const stopped = services.filter((s) => s.status !== 'running');
    if (stopped.length === 0) return;
    setBusy('__bulk__');
    try {
      for (const s of stopped) {
        try {
          await apiRequest(`/api/infra/${encodeURIComponent(s.id)}/start?project=${encodeURIComponent(projectId)}`, { method: 'POST' });
        } catch { /* tolerate */ }
      }
      onToast(`已启动 ${stopped.length} 个 infra 服务`);
      await refresh();
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="space-y-3">
      <div className="flex items-start justify-between gap-3">
        <div className="flex-1">
          <h3 className="text-base font-semibold">项目基础设施</h3>
          <p className="text-xs text-muted-foreground mt-1">
            mongodb / redis / postgres 等 infra 容器,跟随项目独立部署。审批 cds-compose.yml 时自动创建,这里可启停/删除。
          </p>
          <p className="text-[11px] text-muted-foreground/80 mt-1">
            <span className="font-medium text-foreground/80">数据卷不丢失</span>:删除/停止容器不影响 docker named volume,
            下次同名 infra 创建会自动挂回原数据。
          </p>
        </div>
        <div className="flex flex-wrap gap-2 shrink-0">
          <Button type="button" variant="outline" size="sm"
            onClick={doStartAll} disabled={busy !== null || stoppedCount === 0}
            title={stoppedCount === 0 ? '没有可启动的服务' : `启动 ${stoppedCount} 个已停止的服务`}>
            全部启动 {stoppedCount > 0 ? `(${stoppedCount})` : ''}
          </Button>
          <Button type="button" variant="outline" size="sm"
            onClick={doStopAll} disabled={busy !== null || runningCount === 0}
            title={runningCount === 0 ? '没有正在运行的服务' : `停止 ${runningCount} 个运行中的服务(数据保留)`}>
            全部停止 {runningCount > 0 ? `(${runningCount})` : ''}
          </Button>
          <Button type="button" variant="default" size="sm" onClick={() => setResyncOpen(true)} disabled={busy !== null}>
            重新同步配置
          </Button>
          <Button type="button" variant="outline" size="sm" onClick={refresh} disabled={busy !== null}>
            <RefreshCw className="h-3 w-3" /> 刷新
          </Button>
        </div>
      </div>

      <InfraResyncDialog
        open={resyncOpen}
        onOpenChange={(open) => { setResyncOpen(open); if (!open) void refresh(); }}
        projectId={projectId}
        onToast={onToast}
      />

      {services.length === 0 ? (
        <div className="rounded-md border border-dashed border-[hsl(var(--hairline))] bg-[hsl(var(--surface-sunken))] p-6 text-center text-sm text-muted-foreground">
          该项目尚无 infra 容器
        </div>
      ) : (
        <div className="space-y-2">
          {services.map((svc) => {
            const isBusy = busy === svc.id;
            const cmdText = svc.command === undefined ? null
              : Array.isArray(svc.command) ? svc.command.join(' ')
              : String(svc.command);
            return (
              <div
                key={svc.id}
                className="rounded-md border border-[hsl(var(--hairline))] bg-[hsl(var(--surface-raised))] p-3"
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 text-sm">
                      <span className="font-semibold text-foreground">{svc.name}</span>
                      <CodePill>{svc.id}</CodePill>
                      <span className={
                        `inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] ` +
                        (svc.status === 'running'
                          ? 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300'
                          : svc.status === 'error'
                            ? 'bg-red-500/10 text-red-700 dark:text-red-300'
                            : 'bg-muted text-muted-foreground')
                      }>
                        {svc.status === 'running' ? '运行中' : svc.status === 'error' ? '错误' : '已停止'}
                      </span>
                    </div>
                    <div className="mt-1 text-xs text-muted-foreground font-mono">
                      {svc.dockerImage}
                      {' · '}
                      :{svc.hostPort}→{svc.containerPort}
                    </div>
                    {cmdText ? (
                      <div className="mt-1 text-[11px] text-foreground/70 font-mono break-all">
                        cmd: {cmdText}
                      </div>
                    ) : null}
                    {svc.errorMessage ? (
                      <div className="mt-1.5 text-[11px] text-red-600 dark:text-red-400">
                        {svc.errorMessage}
                      </div>
                    ) : null}
                  </div>
                  <div className="flex shrink-0 flex-wrap gap-2">
                    {svc.status === 'running' ? (
                      <Button type="button" variant="outline" size="sm" onClick={() => doStop(svc.id)} disabled={isBusy}>
                        {isBusy ? <Loader2 className="h-3 w-3 animate-spin" /> : null}
                        停止
                      </Button>
                    ) : (
                      <Button type="button" variant="outline" size="sm" onClick={() => doStart(svc.id)} disabled={isBusy}>
                        {isBusy ? <Loader2 className="h-3 w-3 animate-spin" /> : null}
                        启动
                      </Button>
                    )}
                    <Button
                      type="button"
                      variant="destructive"
                      size="sm"
                      onClick={() => setConfirmDeleteId(svc.id)}
                      disabled={isBusy}
                    >
                      <Trash2 className="h-3 w-3" />
                      删除
                    </Button>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      <Dialog open={confirmDeleteId !== null} onOpenChange={(open) => { if (!open) setConfirmDeleteId(null); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <AlertTriangle className="h-4 w-4 text-destructive" />
              确认删除 infra 服务
            </DialogTitle>
            <DialogDescription>
              将停止并删除容器 <code className="font-mono">{confirmDeleteId}</code>,以及对应的持久卷映射记录。
              数据卷本身不会被删(volumes 由 docker 单独管理),但服务不会再启动。
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="gap-2">
            <Button type="button" variant="outline" onClick={() => setConfirmDeleteId(null)}>取消</Button>
            <Button
              type="button"
              variant="destructive"
              onClick={() => confirmDeleteId && doDelete(confirmDeleteId)}
              disabled={busy !== null}
            >
              {busy !== null ? <Loader2 className="h-3 w-3 animate-spin" /> : null}
              确认删除
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// 项目基础设施 重新同步对话框 (2026-05-29)
// 用户反馈:"我想重新初始化这个项目, 比如彻底重装这个数据库啊...
//   缺乏一个重新从 cds-compose.yml 初始化的功能...这是个断头应用了"
// ─────────────────────────────────────────────────────────────

interface ResyncDiff {
  adds: Array<{ id: string; name: string; dockerImage: string; containerPort: number }>;
  updates: Array<{ id: string; name: string; reasons: string[] }>;
  removes: Array<{ id: string; name: string; containerName: string; status: string }>;
  noChange: Array<{ id: string; name: string }>;
}

function InfraResyncDialog({
  open, onOpenChange, projectId, onToast,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectId: string;
  onToast: (message: string) => void;
}): JSX.Element {
  const [yamlText, setYamlText] = useState('');
  const [diff, setDiff] = useState<ResyncDiff | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [cmdError, setCmdError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmTextInput, setConfirmTextInput] = useState('');
  const [deleteVolumes, setDeleteVolumes] = useState(false);
  // yaml 来源:project-repo(默认) / approved-<importId> / manual
  const [sourceKind, setSourceKind] = useState<'repo' | 'approved' | 'manual'>('repo');
  const [sources, setSources] = useState<{
    repoCompose?: { found: boolean; fileName?: string; yaml?: string; error?: string };
    recentApproved?: Array<{ importId: string; agentName: string; decidedAt?: string; yaml: string }>;
  } | null>(null);

  // 重置时清空
  useEffect(() => {
    if (!open) {
      setYamlText('');
      setDiff(null);
      setPreviewError(null);
      setCmdError(null);
      setConfirmTextInput('');
      setDeleteVolumes(false);
      setSourceKind('repo');
      setSources(null);
    }
  }, [open]);

  // 打开时拉来源:项目根目录 cds-compose.yml + 最近审批记录
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    fetch(apiUrl(`/api/projects/${encodeURIComponent(projectId)}/infra/resync/sources`), { credentials: 'include' })
      .then((r) => r.json())
      .then((body) => {
        if (cancelled) return;
        setSources(body);
        // 默认用项目根目录的 yaml(若存在)
        if (body.repoCompose?.found && body.repoCompose.yaml) {
          setSourceKind('repo');
          setYamlText(body.repoCompose.yaml);
        } else if ((body.recentApproved || []).length > 0) {
          setSourceKind('approved');
          setYamlText(body.recentApproved[0].yaml);
        } else {
          setSourceKind('manual');
        }
      })
      .catch(() => { /* 静默,用户可手动粘贴 */ });
    return () => { cancelled = true; };
  }, [open, projectId]);

  const onPreview = useCallback(async () => {
    if (!yamlText.trim()) return;
    setBusy(true);
    setPreviewError(null);
    setCmdError(null);
    setDiff(null);
    try {
      const res = await fetch(
        apiUrl(`/api/projects/${encodeURIComponent(projectId)}/infra/resync/preview`),
        {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ composeYaml: yamlText }),
        },
      );
      const body = await res.json();
      if (!res.ok) {
        setPreviewError(body.error || `HTTP ${res.status}`);
        if (body.cmdValidationError) setCmdError(body.cmdValidationError);
        return;
      }
      setDiff(body as ResyncDiff);
    } catch (err) {
      setPreviewError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }, [projectId, yamlText]);

  const onExecute = useCallback(async () => {
    if (!diff) return;
    if (diff.removes.length > 0 && confirmTextInput.trim().toLowerCase() !== 'yes') {
      onToast('删除项需要输入 yes 确认');
      return;
    }
    setBusy(true);
    try {
      const res = await fetch(
        apiUrl(`/api/projects/${encodeURIComponent(projectId)}/infra/resync/execute`),
        {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ composeYaml: yamlText, confirmText: confirmTextInput || undefined, deleteVolumes }),
        },
      );
      const body = await res.json();
      if (!res.ok) {
        onToast(`执行失败:${body.error || res.status}`);
        return;
      }
      const a = body.applied || {};
      const errCount = (body.errors || []).length;
      const volCount = (body.volumeRemovals || []).filter((v: { ok: boolean }) => v.ok).length;
      onToast(`同步完成:新增 ${(a.added || []).length} · 更新 ${(a.updated || []).length} · 删除 ${(a.removed || []).length}${volCount > 0 ? ` · 删卷 ${volCount}` : ''}${errCount > 0 ? ` · 错误 ${errCount}` : ''}`);
      onOpenChange(false);
    } catch (err) {
      onToast(`执行异常:${(err as Error).message}`);
    } finally {
      setBusy(false);
    }
  }, [diff, confirmTextInput, deleteVolumes, projectId, yamlText, onToast, onOpenChange]);

  const pickSource = useCallback((kind: 'repo' | 'approved' | 'manual', yaml?: string) => {
    setSourceKind(kind);
    setDiff(null);
    setPreviewError(null);
    if (kind === 'manual') {
      setYamlText('');
    } else if (yaml !== undefined) {
      setYamlText(yaml);
    }
  }, []);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>重新同步项目基础设施</DialogTitle>
          <DialogDescription>
            粘贴 cds-compose.yml,先预览 diff,再执行。<strong>docker named volume 保留</strong>,
            被删/重建的容器其数据卷会被新容器自动接回。
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3" style={{ minHeight: 0 }}>
          {/* yaml 来源选择 */}
          <div className="flex flex-wrap gap-2 text-xs">
            <span className="text-muted-foreground self-center">来源:</span>
            <button type="button" disabled={busy || !sources?.repoCompose?.found}
              onClick={() => pickSource('repo', sources?.repoCompose?.yaml)}
              className={`rounded px-2 py-1 border ${sourceKind === 'repo' ? 'border-primary bg-primary/10 text-foreground' : 'border-[hsl(var(--hairline))] text-muted-foreground'} disabled:opacity-40`}>
              项目根目录{sources?.repoCompose?.found ? ` (${sources.repoCompose.fileName})` : ' (未找到)'}
            </button>
            {(sources?.recentApproved || []).length > 0 ? (
              <button type="button" disabled={busy}
                onClick={() => pickSource('approved', sources?.recentApproved?.[0]?.yaml)}
                className={`rounded px-2 py-1 border ${sourceKind === 'approved' ? 'border-primary bg-primary/10 text-foreground' : 'border-[hsl(var(--hairline))] text-muted-foreground'}`}>
                最近审批 ({sources?.recentApproved?.[0]?.agentName || 'agent'})
              </button>
            ) : null}
            <button type="button" disabled={busy}
              onClick={() => pickSource('manual')}
              className={`rounded px-2 py-1 border ${sourceKind === 'manual' ? 'border-primary bg-primary/10 text-foreground' : 'border-[hsl(var(--hairline))] text-muted-foreground'}`}>
              手动粘贴
            </button>
          </div>

          <div>
            <label className="text-xs font-medium text-foreground/80">cds-compose.yml</label>
            <textarea
              value={yamlText}
              onChange={(e) => { setYamlText(e.target.value); setDiff(null); setSourceKind('manual'); }}
              className="mt-1 w-full rounded-md border border-[hsl(var(--hairline))] bg-[hsl(var(--surface-sunken))] p-2 font-mono text-xs"
              rows={8}
              placeholder={`x-cds-project:\n  name: my-project\nservices:\n  mongodb:\n    image: mongo:7\n    ports: ["27017"]\n    volumes: [mongodb-data:/data/db]\n`}
              disabled={busy}
              style={{ minHeight: 160, maxHeight: 280, overflowY: 'auto' }}
            />
          </div>

          {previewError ? (
            <div className="rounded-md border border-red-500/30 bg-red-500/10 p-3 text-sm text-red-700 dark:text-red-300">
              <div className="font-semibold">预览失败</div>
              <div>{previewError}</div>
              {cmdError ? <div className="mt-2 font-mono text-xs">{cmdError}</div> : null}
            </div>
          ) : null}

          {!diff ? (
            <div className="flex justify-end">
              <Button type="button" onClick={onPreview} disabled={busy || !yamlText.trim()}>
                {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : null}
                预览 diff
              </Button>
            </div>
          ) : (
            <div className="space-y-3 max-h-[40vh] overflow-y-auto" style={{ overscrollBehavior: 'contain', minHeight: 0 }}>
              {diff.adds.length > 0 ? (
                <div>
                  <div className="text-xs font-semibold text-emerald-700 dark:text-emerald-300">
                    新增 {diff.adds.length}
                  </div>
                  {diff.adds.map((a) => (
                    <div key={`add-${a.id}`} className="mt-1 rounded border border-emerald-500/30 bg-emerald-500/5 px-2 py-1 text-xs">
                      <code className="font-mono">{a.id}</code> · {a.dockerImage}:{a.containerPort}
                    </div>
                  ))}
                </div>
              ) : null}
              {diff.updates.length > 0 ? (
                <div>
                  <div className="text-xs font-semibold text-sky-700 dark:text-sky-300">
                    更新 {diff.updates.length}(image/cmd/env/volumes/ports 任一变化即重建)
                  </div>
                  {diff.updates.map((u) => (
                    <div key={`upd-${u.id}`} className="mt-1 rounded border border-sky-500/30 bg-sky-500/5 px-2 py-1 text-xs">
                      <code className="font-mono">{u.id}</code>
                      <ul className="mt-0.5 list-disc pl-4 text-[11px] text-foreground/80">
                        {u.reasons.map((r, i) => <li key={i}>{r}</li>)}
                      </ul>
                    </div>
                  ))}
                </div>
              ) : null}
              {diff.removes.length > 0 ? (
                <div>
                  <div className="text-xs font-semibold text-red-700 dark:text-red-300">
                    删除 {diff.removes.length}(yaml 中已不存在 · 默认仅删容器,数据卷保留)
                  </div>
                  {diff.removes.map((r) => (
                    <div key={`rm-${r.id}`} className="mt-1 rounded border border-red-500/30 bg-red-500/5 px-2 py-1 text-xs">
                      <code className="font-mono">{r.id}</code> · {r.containerName} · {r.status}
                    </div>
                  ))}
                  <label className="mt-2 flex items-start gap-2 text-xs">
                    <input
                      type="checkbox"
                      checked={deleteVolumes}
                      onChange={(e) => setDeleteVolumes(e.target.checked)}
                      disabled={busy}
                      className="mt-0.5"
                    />
                    <span>
                      <span className="font-semibold text-red-700 dark:text-red-300">同时删除数据卷(不可恢复)</span>
                      <br />
                      <span className="text-muted-foreground">
                        默认不勾:只删容器,docker named volume 保留,数据安全。
                        勾选后被删服务的 named volume 会一并 <code className="font-mono">docker volume rm</code>,
                        相当于"彻底重装"。
                      </span>
                    </span>
                  </label>
                  <div className="mt-2">
                    <label className="text-xs">输入 <code className="font-mono">yes</code> 确认删除上述 {diff.removes.length} 个服务{deleteVolumes ? '(含数据卷)' : ''}:</label>
                    <input
                      type="text"
                      value={confirmTextInput}
                      onChange={(e) => setConfirmTextInput(e.target.value)}
                      className="mt-1 w-32 rounded border border-[hsl(var(--hairline))] bg-background px-2 py-1 font-mono text-xs"
                      placeholder="yes"
                      disabled={busy}
                    />
                  </div>
                </div>
              ) : null}
              {diff.noChange.length > 0 ? (
                <div className="text-xs text-muted-foreground">
                  无变化 {diff.noChange.length}:{diff.noChange.map((n) => n.id).join(', ')}
                </div>
              ) : null}
              {diff.adds.length === 0 && diff.updates.length === 0 && diff.removes.length === 0 ? (
                <div className="rounded-md border border-dashed border-[hsl(var(--hairline))] p-4 text-center text-sm text-muted-foreground">
                  完全一致,无需同步
                </div>
              ) : null}
            </div>
          )}
        </div>

        <DialogFooter>
          <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>取消</Button>
          {diff && (diff.adds.length + diff.updates.length + diff.removes.length) > 0 ? (
            <Button type="button" variant="default" onClick={onExecute}
              disabled={busy || (diff.removes.length > 0 && confirmTextInput.trim().toLowerCase() !== 'yes')}>
              {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : null}
              执行同步
            </Button>
          ) : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
