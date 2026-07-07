import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties, PointerEvent as ReactPointerEvent } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  ArrowLeft, Boxes, Check, ChevronRight, CircleAlert, CircleCheck, CircleX, ClipboardCheck, Clock3, FileCode2, FileText, FolderOpen,
  GitPullRequest, Inbox, Layers, Link2, Maximize2, Minimize2, MoreVertical, Plus, RefreshCw, Share2, SlidersHorizontal, Trash2, Upload,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { marked } from 'marked';
import { AppShell, Crumb, PaletteHint, TopBar, Workspace } from '@/components/layout/AppShell';
import { Button } from '@/components/ui/button';
import { ConfirmAction } from '@/components/ui/confirm-action';
import { DropdownDivider, DropdownItem, DropdownLabel, DropdownMenu } from '@/components/ui/dropdown-menu';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  ApiError,
  apiRequest,
  createReportFolder,
  createReportFromFile,
  createReportFromText,
  deleteReport,
  disableReportShare,
  enableReportShare,
  fetchReportRaw,
  listReportFolders,
  pushReportToPr,
  listReports,
  moveReportToFolder,
  reportRawUrl,
  type AcceptanceReport,
  type ReportFolder,
  type ReportFormat,
} from '@/lib/api';
import { ErrorBlock, LoadingBlock } from '@/pages/cds-settings/components';

interface ProjectLite {
  id: string;
  name: string;
  slug?: string;
}

type ListState =
  | { status: 'loading' }
  | { status: 'error'; message: string; transient: boolean }
  | { status: 'ok'; reports: AcceptanceReport[] };

type ReportSystemView = 'all' | 'none' | 'recent' | 'shared' | 'failed';
type ProjectFilter = 'all' | 'self' | string;

// 当前筛选：系统视图 / '<id>' 指定文件夹。
type FolderFilter = ReportSystemView | string;

type ReportCounts = {
  byFolder: Map<string, number>;
  unfiled: number;
  recent: number;
  shared: number;
  failed: number;
  total: number;
};

type ProjectCounts = {
  byProject: Map<string, number>;
  self: number;
  total: number;
};

const REPORT_SYSTEM_VIEW_DEFINITIONS: Array<{
  id: ReportSystemView;
  label: string;
  Icon: LucideIcon;
  count: (counts: ReportCounts) => number;
}> = [
  { id: 'all', label: '全部', Icon: Layers, count: (counts) => counts.total },
  { id: 'none', label: '未归类', Icon: Inbox, count: (counts) => counts.unfiled },
  { id: 'recent', label: '最近 7 天', Icon: Clock3, count: (counts) => counts.recent },
  { id: 'shared', label: '已分享', Icon: Share2, count: (counts) => counts.shared },
  { id: 'failed', label: '不通过', Icon: CircleAlert, count: (counts) => counts.failed },
];

const REPORT_SYSTEM_VIEWS: ReportSystemView[] = REPORT_SYSTEM_VIEW_DEFINITIONS.map((item) => item.id);

function isReportSystemView(value: FolderFilter): value is ReportSystemView {
  return REPORT_SYSTEM_VIEWS.includes(value as ReportSystemView);
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

function formatTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString();
}

export function ReportsPage(): JSX.Element {
  const [searchParams] = useSearchParams();
  // 项目作用域：从 URL ?project= 取（项目卡右上角入口带）。空 = 全局（CDS 自身）报告。
  const projectId = searchParams.get('project') || '';
  // 直达深链：?report=<id> 自动打开该报告；?folder=<id> 自动激活该文件夹。
  const reportParam = searchParams.get('report') || '';
  const folderParam = searchParams.get('folder') || '';

  const [state, setState] = useState<ListState>({ status: 'loading' });
  const [projects, setProjects] = useState<ProjectLite[]>([]);
  const [folders, setFolders] = useState<ReportFolder[]>([]);
  const [activeProjectFilter, setActiveProjectFilter] = useState<ProjectFilter>('all');
  const [activeFolder, setActiveFolder] = useState<FolderFilter>('all');
  const [createOpen, setCreateOpen] = useState(false);
  const [folderCreateOpen, setFolderCreateOpen] = useState(false);
  const [selected, setSelected] = useState<AcceptanceReport | null>(null);
  const [navDrawerOpen, setNavDrawerOpen] = useState(false);
  const [toast, setToast] = useState('');

  const load = useCallback(async () => {
    setState({ status: 'loading' });
    try {
      const [reports, fldrs] = await Promise.all([
        listReports(projectId || undefined),
        listReportFolders(projectId || undefined).catch(() => [] as ReportFolder[]),
      ]);
      setFolders(fldrs);
      setState({ status: 'ok', reports });
    } catch (err) {
      const apiErr = err instanceof ApiError ? err : null;
      setState({
        status: 'error',
        message: apiErr?.message ?? String(err),
        transient: Boolean(apiErr?.transient),
      });
    }
  }, [projectId]);

  useEffect(() => {
    setActiveProjectFilter('all');
    setActiveFolder('all');
    setSelected(null);
    void load();
  }, [load]);

  // 直达深链：报告加载完成后，按 ?folder= / ?report= 自动激活文件夹并打开对应报告。
  // 用 identity-guard 的函数式 setState 避免重复触发（命中即稳定，不抖动）。
  useEffect(() => {
    if (state.status !== 'ok') return;
    if (folderParam && folders.some((f) => f.id === folderParam)) {
      setActiveFolder((prev) => (prev === folderParam ? prev : folderParam));
    }
    if (reportParam) {
      const r = state.reports.find((x) => x.id === reportParam);
      if (r) setSelected((prev) => (prev?.id === r.id ? prev : r));
    }
  }, [state, folders, folderParam, reportParam]);

  // 项目列表用于关联下拉 + 当前项目名展示（best-effort，失败不阻断）。
  useEffect(() => {
    let cancelled = false;
    apiRequest<{ projects?: ProjectLite[] }>('/api/projects')
      .then((res) => { if (!cancelled) setProjects(res.projects ?? []); })
      .catch(() => { if (!cancelled) setProjects([]); });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (!toast) return undefined;
    const t = window.setTimeout(() => setToast(''), 3000);
    return () => window.clearTimeout(t);
  }, [toast]);

  const projectName = useMemo(() => {
    if (!projectId) return '';
    const p = projects.find((x) => x.id === projectId);
    return p ? (p.name || p.slug || p.id) : projectId;
  }, [projectId, projects]);

  const allReports = state.status === 'ok' ? state.reports : [];
  const projectFilteredReports = useMemo(() => {
    if (activeProjectFilter === 'all') return allReports;
    if (activeProjectFilter === 'self') return allReports.filter((r) => !r.projectId);
    return allReports.filter((r) => r.projectId === activeProjectFilter);
  }, [allReports, activeProjectFilter]);

  const visibleReports = useMemo(() => {
    if (activeFolder === 'all') return projectFilteredReports;
    if (activeFolder === 'none') return projectFilteredReports.filter((r) => !r.folderId);
    if (activeFolder === 'recent') {
      const since = Date.now() - 7 * 24 * 60 * 60 * 1000;
      return projectFilteredReports.filter((r) => {
        const created = new Date(r.createdAt).getTime();
        return !Number.isNaN(created) && created >= since;
      });
    }
    if (activeFolder === 'shared') return projectFilteredReports.filter((r) => Boolean(r.shareToken));
    if (activeFolder === 'failed') return projectFilteredReports.filter((r) => r.verdict === 'fail');
    return projectFilteredReports.filter((r) => r.folderId === activeFolder);
  }, [projectFilteredReports, activeFolder]);

  const folderCounts = useMemo(() => {
    const m = new Map<string, number>();
    let unfiled = 0;
    let recent = 0;
    let shared = 0;
    let failed = 0;
    const since = Date.now() - 7 * 24 * 60 * 60 * 1000;
    for (const r of projectFilteredReports) {
      if (r.folderId) m.set(r.folderId, (m.get(r.folderId) ?? 0) + 1);
      else unfiled += 1;
      const created = new Date(r.createdAt).getTime();
      if (!Number.isNaN(created) && created >= since) recent += 1;
      if (r.shareToken) shared += 1;
      if (r.verdict === 'fail') failed += 1;
    }
    return { byFolder: m, unfiled, recent, shared, failed, total: projectFilteredReports.length };
  }, [projectFilteredReports]);

  const projectCounts = useMemo(() => {
    const m = new Map<string, number>();
    let self = 0;
    for (const r of allReports) {
      if (r.projectId) m.set(r.projectId, (m.get(r.projectId) ?? 0) + 1);
      else self += 1;
    }
    return { byProject: m, self, total: allReports.length };
  }, [allReports]);

  const handleProjectFilterChange = useCallback((next: ProjectFilter) => {
    setActiveProjectFilter(next);
    setActiveFolder((current) => (isReportSystemView(current) ? current : 'all'));
    setSelected(null);
  }, []);

  const handleSelectReport = useCallback((report: AcceptanceReport) => {
    setSelected(report);
    setNavDrawerOpen(false);
  }, []);

  const handleCreated = useCallback((report: AcceptanceReport) => {
    setCreateOpen(false);
    setToast(`已创建报告「${report.title}」`);
    setState((cur) => (cur.status === 'ok' ? { status: 'ok', reports: [report, ...cur.reports] } : cur));
    setSelected(report);
  }, []);

  const handleDelete = useCallback(async (report: AcceptanceReport) => {
    try {
      await deleteReport(report.id);
      setToast(`已删除报告「${report.title}」`);
      setState((cur) => (cur.status === 'ok' ? { status: 'ok', reports: cur.reports.filter((r) => r.id !== report.id) } : cur));
      setSelected((cur) => (cur?.id === report.id ? null : cur));
    } catch (err) {
      setToast(`删除失败：${err instanceof ApiError ? err.message : String(err)}`);
    }
  }, []);

  const handleMove = useCallback(async (report: AcceptanceReport, folderId: string | null) => {
    try {
      const updated = await moveReportToFolder(report.id, folderId);
      setState((cur) => (cur.status === 'ok'
        ? { status: 'ok', reports: cur.reports.map((r) => (r.id === report.id ? updated : r)) }
        : cur));
      setSelected((cur) => (cur?.id === report.id ? updated : cur));
      const fname = folderId ? folders.find((f) => f.id === folderId)?.name ?? '文件夹' : '未归类';
      setToast(`已移动「${report.title}」到「${fname}」`);
    } catch (err) {
      setToast(`移动失败：${err instanceof ApiError ? err.message : String(err)}`);
    }
  }, [folders]);

  // 复制「直达链接」：点了直接落到该报告（带 project/folder 上下文）。
  const handleCopyLink = useCallback(async (report: AcceptanceReport) => {
    const params = new URLSearchParams();
    if (projectId) params.set('project', projectId);
    if (report.folderId) params.set('folder', report.folderId);
    params.set('report', report.id);
    const url = `${window.location.origin}/reports?${params.toString()}`;
    try {
      await navigator.clipboard.writeText(url);
      setToast('已复制直达链接');
    } catch {
      // 剪贴板不可用时退化为把链接显示在 toast，便于手动复制。
      setToast(url);
    }
  }, [projectId]);

  const handleCreateFolder = useCallback(async (name: string): Promise<boolean> => {
    try {
      const folder = await createReportFolder(name, projectId || null);
      setFolders((cur) => [...cur, folder]);
      setActiveFolder((current) => (isReportSystemView(current) ? current : 'all'));
      setToast(`已新建文件夹「${folder.name}」`);
      return true;
    } catch (err) {
      setToast(`新建文件夹失败：${err instanceof ApiError ? err.message : String(err)}`);
      return false;
    }
  }, [projectId]);

  return (
    <AppShell
      active="reports"
      topbar={(
        <TopBar
          left={<Crumb items={[
            { label: 'CDS', href: '/project-list' },
            ...(projectId ? [{ label: projectName || projectId, href: `/branches/${encodeURIComponent(projectId)}` }] : []),
            { label: '验收报告' },
          ]} />}
          right={(
            <>
              <PaletteHint />
              <Button variant="outline" size="sm" onClick={() => void load()}><RefreshCw />刷新</Button>
              <Button size="sm" onClick={() => setCreateOpen(true)}><Plus />新建报告</Button>
            </>
          )}
        />
      )}
    >
      <Workspace wide className="cds-workspace--fill cds-workspace--fluid">
        <div className="flex h-full min-h-0 flex-col gap-3">
          {toast ? (
            <div className="shrink-0 rounded-md border border-[hsl(var(--hairline))] bg-[hsl(var(--surface-sunken))] px-3 py-2 text-sm">{toast}</div>
          ) : null}

          {state.status === 'loading' ? <LoadingBlock label="正在加载验收报告" /> : null}
          {state.status === 'error' ? <ErrorBlock message={state.message} transient={state.transient} /> : null}

          {state.status === 'ok' ? (
            <div className="flex min-h-0 flex-1 flex-col">
              <div className="flex min-h-0 flex-1 flex-col gap-4 lg:flex-row">
                {visibleReports.length === 0 ? (
                  <EmptyReportsState
                    onCreate={() => setCreateOpen(true)}
                    filtered={allReports.length > 0}
                    filterMenu={(
                      <div className="flex items-center gap-1">
                        {!projectId ? (
                          <ProjectFilterMenu
                            projects={projects}
                            counts={projectCounts}
                            active={activeProjectFilter}
                            onSelect={handleProjectFilterChange}
                          />
                        ) : null}
                        <ReportFilterMenu
                          folders={folders}
                          counts={folderCounts}
                          active={activeFolder}
                          onSelect={setActiveFolder}
                          onRequestCreate={() => setFolderCreateOpen(true)}
                        />
                      </div>
                    )}
                  />
                ) : (
                  <>
                    <ReportList
                      reports={visibleReports}
                      folders={folders}
                      projects={projects}
                      projectCounts={projectCounts}
                      activeProjectFilter={activeProjectFilter}
                      counts={folderCounts}
                      activeFilter={activeFolder}
                      selectedId={selected?.id ?? null}
                      onSelect={handleSelectReport}
                      onDelete={handleDelete}
                      onMove={handleMove}
                      onCopy={handleCopyLink}
                      onProjectFilterSelect={handleProjectFilterChange}
                      onFilterSelect={setActiveFolder}
                      onCreateFolder={() => setFolderCreateOpen(true)}
                      showProjectFilter={!projectId}
                      className={selected ? 'hidden lg:flex' : undefined}
                    />
                    <ReportViewer report={selected} onBack={() => setSelected(null)} onOpenNav={() => setNavDrawerOpen(true)} />
                  </>
                )}
              </div>
              {selected && navDrawerOpen ? (
                <div className="fixed inset-0 z-[11000] lg:hidden">
                  <button
                    type="button"
                    className="absolute inset-0 bg-black/30"
                    aria-label="关闭报告目录"
                    onClick={() => setNavDrawerOpen(false)}
                  />
                  <div className="absolute left-0 top-0 flex h-full w-[min(88vw,420px)] flex-col border-r border-[hsl(var(--hairline))] bg-[hsl(var(--background))] shadow-2xl">
                    <div className="flex h-11 shrink-0 items-center justify-between border-b border-[hsl(var(--hairline))] px-3 text-sm font-medium">
                      <span>报告目录</span>
                      <Button variant="ghost" size="sm" onClick={() => setNavDrawerOpen(false)}>关闭</Button>
                    </div>
                    <ReportList
                      reports={visibleReports}
                      folders={folders}
                      projects={projects}
                      projectCounts={projectCounts}
                      activeProjectFilter={activeProjectFilter}
                      counts={folderCounts}
                      activeFilter={activeFolder}
                      selectedId={selected?.id ?? null}
                      onSelect={handleSelectReport}
                      onDelete={handleDelete}
                      onMove={handleMove}
                      onCopy={handleCopyLink}
                      onProjectFilterSelect={handleProjectFilterChange}
                      onFilterSelect={setActiveFolder}
                      onCreateFolder={() => setFolderCreateOpen(true)}
                      showProjectFilter={!projectId}
                      resizable={false}
                      className="min-h-0 flex-1 rounded-none border-0"
                    />
                  </div>
                </div>
              ) : null}
            </div>
          ) : null}
        </div>
      </Workspace>

      <CreateReportDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        projects={projects}
        folders={folders}
        defaultProjectId={projectId}
        defaultFolderId={!isReportSystemView(activeFolder) ? activeFolder : ''}
        onCreated={handleCreated}
      />
      <CreateFolderDialog
        open={folderCreateOpen}
        onOpenChange={setFolderCreateOpen}
        onCreate={handleCreateFolder}
      />
    </AppShell>
  );
}

function ProjectFilterMenu({
  projects, counts, active, onSelect,
}: {
  projects: ProjectLite[];
  counts: ProjectCounts;
  active: ProjectFilter;
  onSelect: (f: ProjectFilter) => void;
}): JSX.Element {
  const activeProject = active === 'all' || active === 'self' ? null : projects.find((p) => p.id === active);
  const label = active === 'all'
    ? '全部项目'
    : active === 'self'
      ? 'CDS 自身'
      : activeProject?.name || activeProject?.slug || '项目';

  return (
    <DropdownMenu
      align="end"
      width={268}
      trigger={(
        <Button variant="ghost" size="sm" className="h-7 min-w-0 shrink-0 gap-1.5 px-2" aria-label="打开项目筛选" title="项目筛选">
          <Boxes className="h-4 w-4" />
          <span className="max-w-[96px] truncate">{label}</span>
        </Button>
      )}
    >
      <DropdownLabel>项目</DropdownLabel>
      <DropdownItem onSelect={() => onSelect('all')}>
        <Layers className="h-4 w-4 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate">全部项目</span>
        <span className="text-xs text-muted-foreground">{counts.total}</span>
        {active === 'all' ? <Check className="h-4 w-4 shrink-0 text-primary" /> : null}
      </DropdownItem>
      <DropdownItem onSelect={() => onSelect('self')}>
        <Boxes className="h-4 w-4 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate">CDS 自身</span>
        <span className="text-xs text-muted-foreground">{counts.self}</span>
        {active === 'self' ? <Check className="h-4 w-4 shrink-0 text-primary" /> : null}
      </DropdownItem>
      <DropdownDivider />
      {projects.length === 0 ? (
        <DropdownItem disabled>
          <Boxes className="h-4 w-4 shrink-0 text-muted-foreground" />
          <span className="min-w-0 flex-1 truncate">暂无项目</span>
        </DropdownItem>
      ) : projects.map((project) => (
        <DropdownItem key={project.id} onSelect={() => onSelect(project.id)}>
          <Boxes className="h-4 w-4 shrink-0 text-muted-foreground" />
          <span className="min-w-0 flex-1 truncate" title={project.name || project.slug || project.id}>
            {project.name || project.slug || project.id}
          </span>
          <span className="text-xs text-muted-foreground">{counts.byProject.get(project.id) ?? 0}</span>
          {active === project.id ? <Check className="h-4 w-4 shrink-0 text-primary" /> : null}
        </DropdownItem>
      ))}
    </DropdownMenu>
  );
}

function ReportFilterMenu({
  folders, counts, active, onSelect, onRequestCreate,
}: {
  folders: ReportFolder[];
  counts: ReportCounts;
  active: FolderFilter;
  onSelect: (f: FolderFilter) => void;
  onRequestCreate: () => void;
}): JSX.Element {
  return (
    <DropdownMenu
      align="end"
      width={268}
      trigger={(
        <Button variant="ghost" size="sm" className="h-7 shrink-0 gap-1.5 px-2" aria-label="打开报告库筛选" title="筛选报告">
          <SlidersHorizontal className="h-4 w-4" />
          <span className="hidden sm:inline">筛选</span>
        </Button>
      )}
    >
      <DropdownLabel>视图</DropdownLabel>
      {REPORT_SYSTEM_VIEW_DEFINITIONS.map(({ id, label, Icon, count }) => (
        <DropdownItem key={id} onSelect={() => onSelect(id)}>
          <Icon className="h-4 w-4 shrink-0 text-muted-foreground" />
          <span className="min-w-0 flex-1 truncate">{label}</span>
          <span className="text-xs text-muted-foreground">{count(counts)}</span>
          {active === id ? <Check className="h-4 w-4 shrink-0 text-primary" /> : null}
        </DropdownItem>
      ))}
      <DropdownDivider />
      <DropdownLabel>文件夹</DropdownLabel>
      <DropdownItem onSelect={onRequestCreate}>
        <Plus className="h-4 w-4 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate">新建文件夹</span>
      </DropdownItem>
      <DropdownDivider />
      {folders.length === 0 ? (
        <DropdownItem disabled>
          <FolderOpen className="h-4 w-4 shrink-0 text-muted-foreground" />
          <span className="min-w-0 flex-1 truncate">暂无文件夹</span>
        </DropdownItem>
      ) : folders.map((folder) => (
        <DropdownItem key={folder.id} onSelect={() => onSelect(folder.id)}>
          <FolderOpen className="h-4 w-4 shrink-0 text-muted-foreground" />
          <span className="min-w-0 flex-1 truncate" title={folder.name}>{folder.name}</span>
          <span className="text-xs text-muted-foreground">{counts.byFolder.get(folder.id) ?? 0}</span>
          {active === folder.id ? <Check className="h-4 w-4 shrink-0 text-primary" /> : null}
        </DropdownItem>
      ))}
    </DropdownMenu>
  );
}

function EmptyReportsState({ onCreate, filtered, filterMenu }: { onCreate: () => void; filtered: boolean; filterMenu?: JSX.Element }): JSX.Element {
  return (
    <div className="relative flex flex-1 flex-col items-center justify-center gap-4 rounded-md border border-dashed border-border px-6 py-16 text-center">
      {filterMenu ? <div className="absolute right-2 top-2">{filterMenu}</div> : null}
      <div className="flex h-14 w-14 items-center justify-center rounded-full bg-[hsl(var(--surface-sunken))] text-muted-foreground">
        <ClipboardCheck className="h-7 w-7" />
      </div>
      <div className="space-y-1">
        <h2 className="text-base font-semibold">{filtered ? '当前视图还没有报告' : '还没有验收报告'}</h2>
        <p className="max-w-md text-sm text-muted-foreground">
          {filtered
            ? '切换其它视图或文件夹，或在此处新建一份。'
            : '上传或粘贴一份 HTML / Markdown 报告，CDS 会托管它的内容并以沙箱安全渲染。不需要外部知识库，CDS 登录即可访问。'}
        </p>
      </div>
      <Button onClick={onCreate}><Upload />上传 / 新建验收报告</Button>
    </div>
  );
}

function FormatBadge({ format }: { format: ReportFormat }): JSX.Element {
  const Icon = format === 'html' ? FileCode2 : FileText;
  const label = format === 'html' ? 'HTML' : 'Markdown';
  return (
    <span className="inline-flex items-center gap-1 rounded border border-[hsl(var(--hairline))] bg-[hsl(var(--surface-sunken))] px-1.5 py-0.5 text-[11px] font-medium text-muted-foreground">
      <Icon className="h-3 w-3" />{label}
    </span>
  );
}

/** 单份报告的 verdict 胶囊（自包含状态色 + 白字，双主题可读）。 */
function VerdictBadge({ verdict }: { verdict: NonNullable<AcceptanceReport['verdict']> }): JSX.Element {
  const cfg: Record<string, { label: string; bg: string }> = {
    pass: { label: '通过', bg: '#1a7f37' },
    conditional: { label: '有条件', bg: '#9a6700' },
    fail: { label: '不通过', bg: '#b42318' },
  };
  const c = cfg[verdict];
  return (
    <span className="inline-flex shrink-0 items-center rounded-full px-2 py-0.5 text-[10px] font-semibold text-white" style={{ background: c.bg }}>
      {c.label}
    </span>
  );
}

function VerdictIcon({ verdict }: { verdict?: AcceptanceReport['verdict'] | null }): JSX.Element {
  if (verdict === 'pass') return <CircleCheck className="h-4 w-4 shrink-0 text-emerald-500" aria-label="通过" />;
  if (verdict === 'fail') return <CircleX className="h-4 w-4 shrink-0 text-red-500" aria-label="不通过" />;
  if (verdict === 'conditional') return <CircleAlert className="h-4 w-4 shrink-0 text-amber-500" aria-label="有条件" />;
  return <FileText className="h-4 w-4 shrink-0 text-muted-foreground" aria-label="无结论" />;
}

function reportTooltip(report: AcceptanceReport, projectName: string | undefined): string {
  return [
    report.title,
    report.verdict ? `结论：${report.verdict === 'pass' ? '通过' : report.verdict === 'fail' ? '不通过' : '有条件'}` : '结论：未标记',
    `格式：${report.format === 'html' ? 'HTML' : 'Markdown'}`,
    `大小：${formatBytes(report.sizeBytes)}`,
    projectName ? `项目：${projectName}` : null,
    report.commitSha ? `Commit：${report.commitSha}` : null,
    report.prNumber ? `PR：#${report.prNumber}` : null,
    `创建：${formatTime(report.createdAt)}`,
  ].filter(Boolean).join('\n');
}

function ReportList({
  reports, folders, projects, projectCounts, activeProjectFilter, counts, activeFilter, selectedId, onSelect, onDelete, onMove, onCopy,
  onProjectFilterSelect, onFilterSelect, onCreateFolder, showProjectFilter, resizable = true, className,
}: {
  reports: AcceptanceReport[];
  folders: ReportFolder[];
  projects: ProjectLite[];
  projectCounts: ProjectCounts;
  activeProjectFilter: ProjectFilter;
  counts: ReportCounts;
  activeFilter: FolderFilter;
  selectedId: string | null;
  onSelect: (report: AcceptanceReport) => void;
  onDelete: (report: AcceptanceReport) => void;
  onMove: (report: AcceptanceReport, folderId: string | null) => void;
  onCopy: (report: AcceptanceReport) => void;
  onProjectFilterSelect: (f: ProjectFilter) => void;
  onFilterSelect: (f: FolderFilter) => void;
  onCreateFolder: () => void;
  showProjectFilter: boolean;
  resizable?: boolean;
  className?: string;
}): JSX.Element {
  const [navWidth, setNavWidth] = useState(340);
  const [collapsedFolderIds, setCollapsedFolderIds] = useState<Set<string>>(() => new Set());

  const projectName = useMemo(() => {
    const map = new Map<string, string>();
    for (const p of projects) map.set(p.id, p.name || p.slug || p.id);
    return map;
  }, [projects]);

  const knownFolderIds = useMemo(() => new Set(folders.map((folder) => folder.id)), [folders]);

  const foldersByParent = useMemo(() => {
    const map = new Map<string | null, ReportFolder[]>();
    for (const folder of folders) {
      const parentId = folder.parentId ?? null;
      const siblings = map.get(parentId) ?? [];
      siblings.push(folder);
      map.set(parentId, siblings);
    }
    return map;
  }, [folders]);

  const reportsByFolder = useMemo(() => {
    const map = new Map<string, AcceptanceReport[]>();
    const root: AcceptanceReport[] = [];
    for (const report of reports) {
      if (report.folderId && knownFolderIds.has(report.folderId)) {
        const bucket = map.get(report.folderId) ?? [];
        bucket.push(report);
        map.set(report.folderId, bucket);
      } else {
        root.push(report);
      }
    }
    return { byFolder: map, root };
  }, [reports, knownFolderIds]);

  const folderVisibleReportCount = useMemo(() => {
    const cache = new Map<string, number>();
    const countFor = (folderId: string): number => {
      const cached = cache.get(folderId);
      if (cached !== undefined) return cached;
      let total = reportsByFolder.byFolder.get(folderId)?.length ?? 0;
      for (const child of foldersByParent.get(folderId) ?? []) total += countFor(child.id);
      cache.set(folderId, total);
      return total;
    };
    for (const folder of folders) countFor(folder.id);
    return cache;
  }, [folders, foldersByParent, reportsByFolder]);

  const showEmptyFolders = activeFilter === 'all';

  const toggleFolder = useCallback((folderId: string) => {
    setCollapsedFolderIds((current) => {
      const next = new Set(current);
      if (next.has(folderId)) next.delete(folderId);
      else next.add(folderId);
      return next;
    });
  }, []);

  const beginResize = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = navWidth;
    const onMove = (moveEvent: PointerEvent) => {
      const next = Math.max(260, Math.min(560, startWidth + moveEvent.clientX - startX));
      setNavWidth(next);
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      document.body.style.userSelect = '';
      document.body.style.cursor = '';
    };
    document.body.style.userSelect = 'none';
    document.body.style.cursor = 'col-resize';
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  }, [navWidth]);

  const renderReportRow = (report: AcceptanceReport, depth: number): JSX.Element => {
    const active = report.id === selectedId;
    const projectLabel = report.projectId ? projectName.get(report.projectId) ?? report.projectId : undefined;
    return (
      <div key={report.id}
        className={`group flex h-8 cursor-pointer items-center gap-2 rounded px-2 text-sm transition-colors ${active ? 'bg-primary/10 text-primary' : 'hover:bg-[hsl(var(--surface-sunken))]'}`}
        style={{ paddingLeft: 8 + depth * 16 }}
        onClick={() => onSelect(report)}
        onKeyDown={(event) => {
          if (event.key !== 'Enter' && event.key !== ' ') return;
          event.preventDefault();
          onSelect(report);
        }}
        role="button"
        tabIndex={0}
        title={reportTooltip(report, projectLabel)}
        aria-label={`打开报告：${report.title}`}>
        <VerdictIcon verdict={report.verdict} />
        <span className="min-w-0 flex-1 truncate">{report.title}</span>
        <div className="shrink-0 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100" onClick={(event) => event.stopPropagation()}>
          <ReportRowActions
            report={report}
            folders={folders}
            onOpen={() => onSelect(report)}
            onDelete={() => onDelete(report)}
            onMove={(folderId) => onMove(report, folderId)}
            onCopy={() => onCopy(report)}
          />
        </div>
      </div>
    );
  };

  const renderFolder = (folder: ReportFolder, depth: number): JSX.Element[] => {
    const count = folderVisibleReportCount.get(folder.id) ?? 0;
    if (!showEmptyFolders && count === 0) return [];
    const collapsed = collapsedFolderIds.has(folder.id);
    const rows: JSX.Element[] = [
      <div key={folder.id}
        className="group flex h-8 cursor-pointer items-center gap-1.5 rounded px-2 text-sm text-muted-foreground transition-colors hover:bg-[hsl(var(--surface-sunken))] hover:text-foreground"
        style={{ paddingLeft: 6 + depth * 16 }}
        title={`${folder.name}\n${count} 份报告`}
        onClick={() => toggleFolder(folder.id)}
        role="button"
        tabIndex={0}
        onKeyDown={(event) => {
          if (event.key !== 'Enter' && event.key !== ' ') return;
          event.preventDefault();
          toggleFolder(folder.id);
        }}>
        <ChevronRight className={`h-3.5 w-3.5 shrink-0 transition-transform ${collapsed ? '' : 'rotate-90'}`} />
        <FolderOpen className="h-4 w-4 shrink-0" />
        <span className="min-w-0 flex-1 truncate">{folder.name}</span>
        <span className="shrink-0 text-[11px] text-muted-foreground">{count}</span>
      </div>,
    ];
    if (!collapsed) {
      for (const child of foldersByParent.get(folder.id) ?? []) rows.push(...renderFolder(child, depth + 1));
      for (const report of reportsByFolder.byFolder.get(folder.id) ?? []) rows.push(renderReportRow(report, depth + 1));
    }
    return rows;
  };

  const treeRows = [
    ...(foldersByParent.get(null) ?? []).flatMap((folder) => renderFolder(folder, 0)),
    ...reportsByFolder.root.map((report) => renderReportRow(report, 0)),
  ];

  return (
    <div className={`relative flex min-h-0 w-full flex-1 flex-col overflow-hidden rounded-md border border-[hsl(var(--hairline))] lg:flex-none lg:shrink-0 lg:w-[var(--report-nav-width)] ${className ?? ''}`}
      style={{ '--report-nav-width': `${navWidth}px` } as CSSProperties}>
      <div className="flex items-center justify-between gap-2 border-b border-[hsl(var(--hairline))] bg-[hsl(var(--surface-sunken))] py-1.5 pl-3 pr-1 text-xs font-medium text-muted-foreground">
        <span>共 {reports.length} 份报告</span>
        <div className="flex min-w-0 items-center gap-1">
          {showProjectFilter ? (
            <ProjectFilterMenu
              projects={projects}
              counts={projectCounts}
              active={activeProjectFilter}
              onSelect={onProjectFilterSelect}
            />
          ) : null}
          <ReportFilterMenu
            folders={folders}
            counts={counts}
            active={activeFilter}
            onSelect={onFilterSelect}
            onRequestCreate={onCreateFolder}
          />
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-1.5 pb-24 sm:pb-1.5" style={{ overscrollBehavior: 'contain' }}>
        {treeRows.length > 0 ? treeRows : (
          <div className="px-2 py-8 text-center text-sm text-muted-foreground">当前筛选下没有报告</div>
        )}
      </div>
      {resizable ? (
        <div
          className="absolute right-0 top-0 hidden h-full w-1 cursor-col-resize bg-transparent transition-colors hover:bg-primary/40 lg:block"
          role="separator"
          aria-orientation="vertical"
          title="拖拽调整导航宽度"
          onPointerDown={beginResize}
        />
      ) : null}
    </div>
  );
}

function ReportRowActions({
  report, folders, onOpen, onDelete, onMove, onCopy,
}: {
  report: AcceptanceReport;
  folders: ReportFolder[];
  onOpen: () => void;
  onDelete: () => void;
  onMove: (folderId: string | null) => void;
  onCopy: () => void;
}): JSX.Element {
  const confirmDelete = (): void => {
    if (window.confirm(`删除报告「${report.title}」？`)) onDelete();
  };

  return (
    <DropdownMenu
      align="end"
      width={220}
      trigger={(
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7 text-muted-foreground opacity-100 transition-opacity sm:opacity-0 sm:group-hover:opacity-100 sm:focus:opacity-100"
          aria-label="打开报告操作菜单"
          title="更多操作"
        >
          <MoreVertical className="h-4 w-4" />
        </Button>
      )}
    >
      <DropdownItem onSelect={onOpen}>
        <FileText className="h-4 w-4 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate">打开报告</span>
      </DropdownItem>
      <DropdownItem onSelect={onCopy}>
        <Link2 className="h-4 w-4 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate">复制直达链接</span>
      </DropdownItem>
      <DropdownDivider />
      <DropdownLabel>移动到文件夹</DropdownLabel>
      <DropdownItem onSelect={() => onMove(null)} disabled={!report.folderId}>
        <Inbox className="h-4 w-4 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate">未归类</span>
        {!report.folderId ? <Check className="h-4 w-4 shrink-0 text-primary" /> : null}
      </DropdownItem>
      {folders.length === 0 ? (
        <DropdownItem disabled>
          <FolderOpen className="h-4 w-4 shrink-0 text-muted-foreground" />
          <span className="min-w-0 flex-1 truncate">暂无文件夹</span>
        </DropdownItem>
      ) : folders.map((folder) => (
        <DropdownItem key={folder.id} onSelect={() => onMove(folder.id)} disabled={report.folderId === folder.id}>
          <FolderOpen className="h-4 w-4 shrink-0 text-muted-foreground" />
          <span className="min-w-0 flex-1 truncate" title={folder.name}>{folder.name}</span>
          {report.folderId === folder.id ? <Check className="h-4 w-4 shrink-0 text-primary" /> : null}
        </DropdownItem>
      ))}
      <DropdownDivider />
      <DropdownItem destructive onSelect={confirmDelete}>
        <Trash2 className="h-4 w-4 shrink-0" />
        <span className="min-w-0 flex-1 truncate">删除报告</span>
      </DropdownItem>
    </DropdownMenu>
  );
}

function CreateFolderDialog({
  open, onOpenChange, onCreate,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreate: (name: string) => Promise<boolean>;
}): JSX.Element {
  const [name, setName] = useState('');
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!open) return;
    setName('');
    setError('');
    setSubmitting(false);
  }, [open]);

  const submit = useCallback(async () => {
    const clean = name.trim();
    if (!clean) {
      setError('请填写文件夹名称');
      return;
    }
    setSubmitting(true);
    setError('');
    const ok = await onCreate(clean);
    setSubmitting(false);
    if (ok) onOpenChange(false);
  }, [name, onCreate, onOpenChange]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>新建文件夹</DialogTitle>
          <DialogDescription>用于把验收报告按项目、功能或批次归档。</DialogDescription>
        </DialogHeader>
        <form className="space-y-4" onSubmit={(event) => { event.preventDefault(); void submit(); }}>
          <label className="block space-y-1.5">
            <span className="text-sm font-medium">文件夹名称</span>
            <input
              autoFocus
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="例如：每日验收"
              className="h-9 w-full rounded-md border border-[hsl(var(--hairline))] bg-[hsl(var(--surface-sunken))] px-3 text-sm outline-none focus:border-primary/60"
            />
          </label>
          {error ? <div className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</div> : null}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={submitting}>取消</Button>
            <Button type="submit" disabled={submitting}>{submitting ? '创建中' : '创建'}</Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Report viewer. HTML via iframe `src` → /raw with sandbox (no allow-same-origin).
 * Markdown fetched, converted with `marked`, injected via srcDoc into the same
 * no-same-origin sandbox. See routes/reports.ts security note.
 */
function ReportViewer({ report, onBack, onOpenNav }: { report: AcceptanceReport | null; onBack?: () => void; onOpenNav?: () => void }): JSX.Element {
  const [mdHtml, setMdHtml] = useState<string | null>(null);
  const [mdError, setMdError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);
  const reqRef = useRef(0);

  useEffect(() => {
    setMdHtml(null);
    setMdError(null);
    if (!report || report.format !== 'md') return;
    const token = ++reqRef.current;
    fetchReportRaw(report.id)
      .then((raw) => {
        if (reqRef.current !== token) return;
        const parsed = marked.parse(raw, { async: false }) as string;
        const doc = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>
          :root { color-scheme: light dark; }
          body { font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; line-height: 1.6; padding: 28px clamp(28px, 6vw, 96px); max-width: 1100px; margin: 0 auto; }
          pre { background: rgba(127,127,127,0.12); padding: 12px; border-radius: 8px; overflow: auto; }
          code { background: rgba(127,127,127,0.12); padding: 1px 4px; border-radius: 4px; }
          pre code { background: transparent; padding: 0; }
          table { border-collapse: collapse; } th, td { border: 1px solid rgba(127,127,127,0.3); padding: 6px 10px; }
          img { max-width: 100%; height: auto; }
          a { color: #2563eb; }
        </style></head><body>${parsed}</body></html>`;
        setMdHtml(doc);
      })
      .catch((err) => {
        if (reqRef.current !== token) return;
        setMdError(err instanceof ApiError ? err.message : String(err));
      });
  }, [report]);

  useEffect(() => {
    if (!expanded) return undefined;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setExpanded(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [expanded]);

  if (!report) {
    return (
      <div className="hidden min-h-0 flex-1 items-center justify-center rounded-md border border-dashed border-border text-sm text-muted-foreground lg:flex">
        从左侧选择一份报告查看内容
      </div>
    );
  }

  return (
    <div className={`flex min-h-0 flex-1 flex-col overflow-hidden border border-[hsl(var(--hairline))] bg-[hsl(var(--background))] ${expanded ? 'fixed inset-0 z-[12000] rounded-none' : 'rounded-md'}`}>
      <div className="flex items-center justify-between gap-2 border-b border-[hsl(var(--hairline))] bg-[hsl(var(--surface-sunken))] px-3 py-2">
        <div className="flex min-w-0 items-center gap-2">
          {onBack ? (
            <Button variant="ghost" size="icon" className="-ml-1 h-8 w-8 shrink-0 lg:hidden" aria-label="返回报告列表" title="返回报告列表" onClick={onBack}>
              <ArrowLeft className="h-4 w-4" />
            </Button>
          ) : null}
          {onOpenNav ? (
            <Button variant="ghost" size="icon" className="h-8 w-8 shrink-0 lg:hidden" aria-label="打开报告目录" title="打开报告目录" onClick={onOpenNav}>
              <Layers className="h-4 w-4" />
            </Button>
          ) : null}
          {report.verdict ? <VerdictBadge verdict={report.verdict} /> : null}
          <span className="truncate text-sm font-medium">{report.title}</span>
          <FormatBadge format={report.format} />
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {report.prNumber && report.verdict ? <PushToPrControl report={report} /> : null}
          <ShareControl report={report} />
          <span className="text-[11px] text-muted-foreground">{formatBytes(report.sizeBytes)}</span>
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7 text-muted-foreground"
            aria-label={expanded ? '退出全屏查看' : '全屏查看报告'}
            title={expanded ? '退出全屏查看' : '全屏查看报告'}
            onClick={() => setExpanded((current) => !current)}
          >
            {expanded ? <Minimize2 className="h-3.5 w-3.5" /> : <Maximize2 className="h-3.5 w-3.5" />}
          </Button>
        </div>
      </div>
      <div className="min-h-0 flex-1 bg-white">
        {report.format === 'html' ? (
          <iframe key={report.id} title={report.title} src={reportRawUrl(report.id)} sandbox="allow-scripts" className="h-full w-full border-0" />
        ) : mdError ? (
          <div className="p-4"><ErrorBlock message={mdError} /></div>
        ) : mdHtml === null ? (
          <div className="p-4"><LoadingBlock label="正在渲染 Markdown" /></div>
        ) : (
          <iframe key={report.id} title={report.title} srcDoc={mdHtml} sandbox="allow-scripts" className="h-full w-full border-0" />
        )}
      </div>
    </div>
  );
}

/**
 * E6 匿名分享控件：生成/撤销报告的只读公开链接 /r/<token>。
 * 给未登录第三方看不必退回 MAP；headless verify-open 也用它直接断言。
 */
function ShareControl({ report }: { report: AcceptanceReport }): JSX.Element {
  const [token, setToken] = useState<string | null>(report.shareToken ?? null);
  const [busy, setBusy] = useState(false);
  const [hint, setHint] = useState('');

  // 切换报告时同步当前报告的分享状态。
  useEffect(() => { setToken(report.shareToken ?? null); setHint(''); }, [report.id, report.shareToken]);

  const shareUrl = token ? `${window.location.origin}/r/${token}` : '';

  const flash = (msg: string) => { setHint(msg); window.setTimeout(() => setHint(''), 2500); };

  const onEnableOrCopy = useCallback(async () => {
    if (busy) return;
    if (token) {
      try { await navigator.clipboard.writeText(shareUrl); flash('已复制公开链接'); }
      catch { flash(shareUrl); }
      return;
    }
    setBusy(true);
    try {
      const { report: updated } = await enableReportShare(report.id);
      const next = updated.shareToken ?? null;
      setToken(next);
      const url = next ? `${window.location.origin}/r/${next}` : '';
      try { await navigator.clipboard.writeText(url); flash('已生成并复制公开链接'); }
      catch { flash('已生成公开链接'); }
    } catch (e) {
      flash(e instanceof ApiError ? e.message : '生成失败');
    } finally { setBusy(false); }
  }, [busy, token, shareUrl, report.id]);

  const onRevoke = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    try { await disableReportShare(report.id); setToken(null); flash('已撤销，链接立即失效'); }
    catch (e) { flash(e instanceof ApiError ? e.message : '撤销失败'); }
    finally { setBusy(false); }
  }, [busy, report.id]);

  return (
    <div className="flex items-center gap-1.5">
      {hint ? <span className="text-[11px] text-muted-foreground">{hint}</span> : null}
      <Button
        variant={token ? 'secondary' : 'outline'}
        size="sm"
        className="h-7 gap-1 px-2 text-[11px]"
        disabled={busy}
        onClick={() => void onEnableOrCopy()}
        title={token ? '复制匿名公开链接 /r/<token>' : '生成匿名只读公开链接（无需登录即可查看）'}
      >
        <Share2 className="h-3.5 w-3.5" />{token ? '复制公开链接' : '匿名分享'}
      </Button>
      {token ? (
        <ConfirmAction
          trigger={(
            <Button variant="ghost" size="icon" className="h-7 w-7 text-muted-foreground" aria-label="撤销分享" title="撤销分享链接">
              <Trash2 className="h-3.5 w-3.5" />
            </Button>
          )}
          title="撤销这份报告的公开链接？"
          description="撤销后 /r/<token> 立即失效，任何已分享出去的链接都无法再打开。"
          confirmLabel="撤销"
          onConfirm={() => void onRevoke()}
        />
      ) : null}
    </div>
  );
}

/**
 * E4 验收回写 PR：把 verdict 作为 PR 评论 + check-run 推回关联 PR。
 * 仅当报告带 prNumber + verdict 时显示（所属项目须已 link GitHub）。
 */
function PushToPrControl({ report }: { report: AcceptanceReport }): JSX.Element {
  const [busy, setBusy] = useState(false);
  const [hint, setHint] = useState('');
  const flash = (msg: string) => { setHint(msg); window.setTimeout(() => setHint(''), 4000); };

  const onPush = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    try {
      const r = await pushReportToPr(report.id);
      if (r.commentUrl || r.checkRun) {
        flash(`已回写 PR #${r.prNumber}${r.warnings.length ? `（${r.warnings.length} 项告警）` : ''}`);
      } else {
        flash('回写失败');
      }
    } catch (e) {
      flash(e instanceof ApiError ? e.message : '回写失败');
    } finally { setBusy(false); }
  }, [busy, report.id]);

  return (
    <div className="flex items-center gap-1.5">
      {hint ? <span className="max-w-[180px] truncate text-[11px] text-muted-foreground">{hint}</span> : null}
      <Button
        variant="outline"
        size="sm"
        className="h-7 gap-1 px-2 text-[11px]"
        disabled={busy}
        onClick={() => void onPush()}
        title={`把验收结论回写到 PR #${report.prNumber}（PR 评论 + check-run）`}
      >
        <GitPullRequest className="h-3.5 w-3.5" />回写 PR #{report.prNumber}
      </Button>
    </div>
  );
}

function CreateReportDialog({
  open, onOpenChange, projects, folders, defaultProjectId, defaultFolderId, onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projects: ProjectLite[];
  folders: ReportFolder[];
  defaultProjectId: string;
  defaultFolderId: string;
  onCreated: (report: AcceptanceReport) => void;
}): JSX.Element {
  const [title, setTitle] = useState('');
  const [format, setFormat] = useState<ReportFormat>('html');
  const [content, setContent] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [projectId, setProjectId] = useState(defaultProjectId);
  const [folderId, setFolderId] = useState(defaultFolderId);
  const [dragOver, setDragOver] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) {
      setTitle(''); setFormat('html'); setContent(''); setFile(null);
      setProjectId(defaultProjectId); setFolderId(defaultFolderId); setDragOver(false); setError('');
    }
  }, [open, defaultProjectId, defaultFolderId]);

  // 文件夹下拉只列**当前所选项目**的文件夹。否则全局页（或切项目后）会列出此前加载过的
  // 其它项目的文件夹，选了跨项目 folderId 会随新 projectId 发出去，被服务端判为不匹配后
  // 静默存成「未归类」——用户看到创建成功却没归到所选文件夹（Codex P2）。
  const visibleFolders = useMemo(
    () => folders.filter((f) => (f.projectId || null) === (projectId || null)),
    [folders, projectId],
  );

  const applyFile = useCallback((picked: File) => {
    setFile(picked);
    const name = picked.name.toLowerCase();
    if (name.endsWith('.md') || name.endsWith('.markdown')) setFormat('md');
    else if (name.endsWith('.html') || name.endsWith('.htm')) setFormat('html');
    if (!title.trim()) setTitle(picked.name.replace(/\.(html?|md|markdown)$/i, ''));
    const reader = new FileReader();
    reader.onload = () => { if (typeof reader.result === 'string') setContent(reader.result); };
    reader.readAsText(picked);
  }, [title]);

  const submit = useCallback(async () => {
    setError('');
    const cleanTitle = title.trim();
    if (!cleanTitle) { setError('请填写报告标题'); return; }
    if (!content.trim()) { setError('请粘贴报告内容或上传文件'); return; }
    setSubmitting(true);
    try {
      // 防御：只在 folderId 属于当前项目时才带上，杜绝跨项目 folderId 被静默丢弃。
      const validFolderId = visibleFolders.some((f) => f.id === folderId) ? folderId : '';
      const common = { projectId: projectId || null, folderId: validFolderId || null };
      const report = file
        ? await createReportFromFile({ title: cleanTitle, format, file, ...common })
        : await createReportFromText({ title: cleanTitle, format, content, ...common });
      onCreated(report);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  }, [title, content, file, format, projectId, folderId, visibleFolders, onCreated]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>新建验收报告</DialogTitle>
          <DialogDescription>支持 HTML 与 Markdown。可直接粘贴内容，也可上传文件——两种方式都行。</DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <label className="block space-y-1.5">
            <span className="text-sm font-medium">标题</span>
            <input value={title} onChange={(e) => setTitle(e.target.value)}
              placeholder="例如：登录页视觉验收 2026-06-20"
              className="h-9 w-full rounded-md border border-[hsl(var(--hairline))] bg-[hsl(var(--surface-sunken))] px-3 text-sm outline-none focus:border-primary/60" />
          </label>

          <div className="space-y-1.5">
            <span className="text-sm font-medium">格式</span>
            <div className="flex gap-2">
              {(['html', 'md'] as ReportFormat[]).map((f) => (
                <button key={f} type="button" onClick={() => setFormat(f)}
                  className={`inline-flex h-9 items-center gap-1.5 rounded-md border px-3 text-sm transition-colors ${format === f ? 'border-primary bg-primary/10 text-primary' : 'border-[hsl(var(--hairline))] text-muted-foreground hover:text-foreground'}`}>
                  {f === 'html' ? <FileCode2 className="h-4 w-4" /> : <FileText className="h-4 w-4" />}
                  {f === 'html' ? 'HTML' : 'Markdown'}
                </button>
              ))}
            </div>
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            {projects.length > 0 ? (
              <label className="block space-y-1.5">
                <span className="text-sm font-medium">关联项目（可选）</span>
                <select value={projectId} onChange={(e) => { setProjectId(e.target.value); setFolderId(''); }}
                  className="h-9 w-full rounded-md border border-[hsl(var(--hairline))] bg-[hsl(var(--surface-sunken))] px-3 text-sm outline-none focus:border-primary/60">
                  <option value="">不关联（全局）</option>
                  {projects.map((p) => <option key={p.id} value={p.id}>{p.name || p.slug || p.id}</option>)}
                </select>
              </label>
            ) : null}
            {visibleFolders.length > 0 ? (
              <label className="block space-y-1.5">
                <span className="text-sm font-medium">文件夹（可选）</span>
                <select value={folderId} onChange={(e) => setFolderId(e.target.value)}
                  className="h-9 w-full rounded-md border border-[hsl(var(--hairline))] bg-[hsl(var(--surface-sunken))] px-3 text-sm outline-none focus:border-primary/60">
                  <option value="">未归类</option>
                  {visibleFolders.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
                </select>
              </label>
            ) : null}
          </div>

          <div
            className={`rounded-md border border-dashed px-4 py-5 text-center text-sm transition-colors ${dragOver ? 'border-primary bg-primary/5' : 'border-[hsl(var(--hairline))]'}`}
            onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
            onDragLeave={() => setDragOver(false)}
            onDrop={(e) => { e.preventDefault(); setDragOver(false); const dropped = e.dataTransfer.files?.[0]; if (dropped) applyFile(dropped); }}>
            <input ref={fileInputRef} type="file" accept=".html,.htm,.md,.markdown,text/html,text/markdown" className="hidden"
              onChange={(e) => { const picked = e.target.files?.[0]; if (picked) applyFile(picked); }} />
            <Upload className="mx-auto mb-2 h-5 w-5 text-muted-foreground" />
            <div className="text-muted-foreground">
              拖拽 .html / .md 文件到此处，或{' '}
              <button type="button" className="font-medium text-primary underline-offset-2 hover:underline" onClick={() => fileInputRef.current?.click()}>点击选择文件</button>
            </div>
            {file ? <div className="mt-2 text-xs text-foreground">已选择：{file.name}（{formatBytes(file.size)}）</div> : null}
          </div>

          <label className="block space-y-1.5">
            <span className="text-sm font-medium">内容（粘贴或编辑）</span>
            <textarea value={content}
              onChange={(e) => { setContent(e.target.value); if (file) setFile(null); }}
              placeholder={format === 'html' ? '在此粘贴完整 HTML 报告…' : '在此粘贴 Markdown 报告…'}
              spellCheck={false}
              className="h-48 w-full resize-y rounded-md border border-[hsl(var(--hairline))] bg-[hsl(var(--surface-sunken))] px-3 py-2 font-mono text-xs outline-none focus:border-primary/60"
              style={{ minHeight: 0 }} />
          </label>

          {error ? <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</div> : null}

          <div className="flex justify-end gap-2 border-t border-[hsl(var(--hairline))] pt-4">
            <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={submitting}>取消</Button>
            <Button onClick={() => void submit()} disabled={submitting}>{submitting ? '创建中…' : '创建报告'}</Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
