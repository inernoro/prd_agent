import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  ClipboardCheck, FileCode2, FileText, Folder, FolderOpen, FolderPlus,
  Inbox, Layers, Link2, Pencil, Plus, RefreshCw, Share2, Trash2, Upload,
} from 'lucide-react';
import { marked } from 'marked';
import { AppShell, Crumb, PaletteHint, TopBar, Workspace } from '@/components/layout/AppShell';
import { Button } from '@/components/ui/button';
import { ConfirmAction } from '@/components/ui/confirm-action';
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
  deleteReportFolder,
  disableReportShare,
  enableReportShare,
  fetchReportRaw,
  listReportFolders,
  listReports,
  moveReportToFolder,
  renameReportFolder,
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

// 当前文件夹筛选：'all' 全部 / 'none' 仅未归类 / '<id>' 指定文件夹。
type FolderFilter = 'all' | 'none' | string;

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
  const [activeFolder, setActiveFolder] = useState<FolderFilter>('all');
  const [createOpen, setCreateOpen] = useState(false);
  const [selected, setSelected] = useState<AcceptanceReport | null>(null);
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
  const visibleReports = useMemo(() => {
    if (activeFolder === 'all') return allReports;
    if (activeFolder === 'none') return allReports.filter((r) => !r.folderId);
    return allReports.filter((r) => r.folderId === activeFolder);
  }, [allReports, activeFolder]);

  const folderCounts = useMemo(() => {
    const m = new Map<string, number>();
    let unfiled = 0;
    for (const r of allReports) {
      if (r.folderId) m.set(r.folderId, (m.get(r.folderId) ?? 0) + 1);
      else unfiled += 1;
    }
    return { byFolder: m, unfiled, total: allReports.length };
  }, [allReports]);

  // E2 验收看板：当前视图(已选文件夹/项目)下的 verdict 计数。
  const verdictStats = useMemo(() => {
    const s = { pass: 0, conditional: 0, fail: 0, unknown: 0, total: visibleReports.length };
    for (const r of visibleReports) {
      if (r.verdict === 'pass') s.pass += 1;
      else if (r.verdict === 'conditional') s.conditional += 1;
      else if (r.verdict === 'fail') s.fail += 1;
      else s.unknown += 1;
    }
    return s;
  }, [visibleReports]);

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

  const handleCreateFolder = useCallback(async (name: string) => {
    try {
      const folder = await createReportFolder(name, projectId || null);
      setFolders((cur) => [...cur, folder]);
      setActiveFolder(folder.id);
      setToast(`已新建文件夹「${folder.name}」`);
    } catch (err) {
      setToast(`新建文件夹失败：${err instanceof ApiError ? err.message : String(err)}`);
    }
  }, [projectId]);

  const handleRenameFolder = useCallback(async (id: string, name: string) => {
    try {
      const folder = await renameReportFolder(id, name);
      setFolders((cur) => cur.map((f) => (f.id === id ? folder : f)));
    } catch (err) {
      setToast(`重命名失败：${err instanceof ApiError ? err.message : String(err)}`);
    }
  }, []);

  const handleDeleteFolder = useCallback(async (id: string) => {
    try {
      await deleteReportFolder(id);
      setFolders((cur) => cur.filter((f) => f.id !== id));
      setState((cur) => (cur.status === 'ok'
        ? { status: 'ok', reports: cur.reports.map((r) => (r.folderId === id ? { ...r, folderId: null } : r)) }
        : cur));
      setActiveFolder((cur) => (cur === id ? 'all' : cur));
      setToast('已删除文件夹（其中报告改为未归类）');
    } catch (err) {
      setToast(`删除文件夹失败：${err instanceof ApiError ? err.message : String(err)}`);
    }
  }, []);

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
        <div className="flex h-full min-h-0 flex-col gap-5">
          <section className="cds-surface-raised cds-hairline p-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="min-w-0">
                <h1 className="text-lg font-semibold">
                  验收报告{projectId ? <span className="ml-2 text-sm font-normal text-muted-foreground">· {projectName || projectId}</span> : <span className="ml-2 text-sm font-normal text-muted-foreground">· 全局（CDS 自身）</span>}
                </h1>
                <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
                  把验收 / 视觉测试报告托管在 CDS 自身，挂在 CDS 登录态之后访问，无需单独的知识库。{projectId ? '当前按项目筛选；左侧文件夹可对验收项分类。' : '可建文件夹对验收项分类；从项目卡右上角「验收报告」进入可按项目查看。'}
                </p>
              </div>
            </div>
            {state.status === 'ok' && verdictStats.total > 0 ? (
              <VerdictSummary stats={verdictStats} />
            ) : null}
            {toast ? (
              <div className="mt-3 rounded-md border border-[hsl(var(--hairline))] bg-[hsl(var(--surface-sunken))] px-3 py-2 text-sm">{toast}</div>
            ) : null}
          </section>

          {state.status === 'loading' ? <LoadingBlock label="正在加载验收报告" /> : null}
          {state.status === 'error' ? <ErrorBlock message={state.message} transient={state.transient} /> : null}

          {state.status === 'ok' ? (
            <div className="flex min-h-0 flex-1 flex-col gap-4 lg:flex-row">
              <FolderRail
                folders={folders}
                counts={folderCounts}
                active={activeFolder}
                onSelect={setActiveFolder}
                onCreate={handleCreateFolder}
                onRename={handleRenameFolder}
                onDelete={handleDeleteFolder}
              />
              {visibleReports.length === 0 ? (
                <EmptyReportsState onCreate={() => setCreateOpen(true)} filtered={allReports.length > 0} />
              ) : (
                <>
                  <ReportList
                    reports={visibleReports}
                    folders={folders}
                    projects={projects}
                    selectedId={selected?.id ?? null}
                    onSelect={setSelected}
                    onDelete={handleDelete}
                    onMove={handleMove}
                    onCopy={handleCopyLink}
                  />
                  <ReportViewer report={selected} />
                </>
              )}
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
        defaultFolderId={typeof activeFolder === 'string' && activeFolder !== 'all' && activeFolder !== 'none' ? activeFolder : ''}
        onCreated={handleCreated}
      />
    </AppShell>
  );
}

/**
 * E2 验收看板：当前视图下 verdict 计数 + 通过率条。颜色为自包含状态胶囊
 * (绿/琥珀/红/灰 + 白字)，两个主题下均可读，不依赖暗色背景 fallback。
 */
function VerdictSummary({
  stats,
}: {
  stats: { pass: number; conditional: number; fail: number; unknown: number; total: number };
}): JSX.Element {
  const judged = stats.pass + stats.conditional + stats.fail;
  const passRate = judged > 0 ? Math.round((stats.pass / judged) * 100) : null;
  const chips: Array<{ label: string; n: number; bg: string }> = [
    { label: '通过', n: stats.pass, bg: '#1a7f37' },
    { label: '有条件', n: stats.conditional, bg: '#9a6700' },
    { label: '不通过', n: stats.fail, bg: '#b42318' },
    { label: '未判定', n: stats.unknown, bg: '#57606a' },
  ];
  return (
    <div className="mt-3 flex flex-wrap items-center gap-3">
      <span className="text-sm text-muted-foreground">本视图 {stats.total} 份</span>
      <div className="flex flex-wrap items-center gap-1.5">
        {chips.filter((c) => c.n > 0).map((c) => (
          <span
            key={c.label}
            className="inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-semibold text-white"
            style={{ background: c.bg }}
          >
            {c.label} {c.n}
          </span>
        ))}
      </div>
      {passRate !== null ? (
        <div className="flex items-center gap-2">
          <span className="text-sm font-semibold">通过率 {passRate}%</span>
          <div className="h-1.5 w-28 overflow-hidden rounded-full bg-[hsl(var(--surface-sunken))]">
            <div className="h-full rounded-full" style={{ width: `${passRate}%`, background: '#1a7f37' }} />
          </div>
        </div>
      ) : null}
    </div>
  );
}

function FolderRail({
  folders, counts, active, onSelect, onCreate, onRename, onDelete,
}: {
  folders: ReportFolder[];
  counts: { byFolder: Map<string, number>; unfiled: number; total: number };
  active: FolderFilter;
  onSelect: (f: FolderFilter) => void;
  onCreate: (name: string) => void;
  onRename: (id: string, name: string) => void;
  onDelete: (id: string) => void;
}): JSX.Element {
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState('');

  const rowCls = (on: boolean) =>
    `group flex cursor-pointer items-center gap-2 rounded-md px-2.5 py-2 text-sm transition-colors ${on ? 'bg-primary/10 text-primary' : 'hover:bg-[hsl(var(--surface-sunken))] text-foreground'}`;

  return (
    <div className="flex min-h-0 w-full flex-col overflow-hidden rounded-md border border-[hsl(var(--hairline))] lg:w-[224px] lg:shrink-0">
      <div className="flex items-center justify-between border-b border-[hsl(var(--hairline))] bg-[hsl(var(--surface-sunken))] px-3 py-2 text-xs font-medium text-muted-foreground">
        <span>文件夹</span>
        <Button variant="ghost" size="icon" className="h-6 w-6" title="新建文件夹" aria-label="新建文件夹"
          onClick={() => { setCreating(true); setNewName(''); }}>
          <FolderPlus className="h-4 w-4" />
        </Button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-2" style={{ overscrollBehavior: 'contain' }}>
        <div className={rowCls(active === 'all')} onClick={() => onSelect('all')}>
          <Layers className="h-4 w-4 shrink-0" />
          <span className="flex-1 truncate">全部</span>
          <span className="text-[11px] text-muted-foreground">{counts.total}</span>
        </div>
        <div className={rowCls(active === 'none')} onClick={() => onSelect('none')}>
          <Inbox className="h-4 w-4 shrink-0" />
          <span className="flex-1 truncate">未归类</span>
          <span className="text-[11px] text-muted-foreground">{counts.unfiled}</span>
        </div>
        <div className="my-1.5 border-t border-[hsl(var(--hairline))]" />
        {folders.map((f) => (
          editingId === f.id ? (
            <form key={f.id} className="flex items-center gap-1 px-1 py-1"
              onSubmit={(e) => { e.preventDefault(); const n = editName.trim(); if (n) onRename(f.id, n); setEditingId(null); }}>
              <input autoFocus value={editName} onChange={(e) => setEditName(e.target.value)}
                onBlur={() => setEditingId(null)}
                className="h-7 w-full rounded border border-[hsl(var(--hairline))] bg-[hsl(var(--surface-sunken))] px-2 text-sm outline-none focus:border-primary/60" />
            </form>
          ) : (
            <div key={f.id} className={rowCls(active === f.id)} onClick={() => onSelect(f.id)}>
              {active === f.id ? <FolderOpen className="h-4 w-4 shrink-0" /> : <Folder className="h-4 w-4 shrink-0" />}
              <span className="flex-1 truncate" title={f.name}>{f.name}</span>
              <span className="text-[11px] text-muted-foreground group-hover:hidden">{counts.byFolder.get(f.id) ?? 0}</span>
              <span className="hidden items-center gap-0.5 group-hover:flex" onClick={(e) => e.stopPropagation()}>
                <Button variant="ghost" size="icon" className="h-6 w-6" title="重命名" aria-label="重命名文件夹"
                  onClick={() => { setEditingId(f.id); setEditName(f.name); }}>
                  <Pencil className="h-3.5 w-3.5" />
                </Button>
                <ConfirmAction
                  trigger={<Button variant="ghost" size="icon" className="h-6 w-6 text-muted-foreground" title="删除文件夹" aria-label="删除文件夹"><Trash2 className="h-3.5 w-3.5" /></Button>}
                  title="删除这个文件夹？"
                  description="文件夹会被删除，其中的报告改为「未归类」（内容不会丢失）。"
                  confirmLabel="删除"
                  onConfirm={() => onDelete(f.id)}
                />
              </span>
            </div>
          )
        ))}
        {creating ? (
          <form className="mt-1 flex items-center gap-1 px-1"
            onSubmit={(e) => { e.preventDefault(); const n = newName.trim(); if (n) onCreate(n); setCreating(false); }}>
            <input autoFocus value={newName} onChange={(e) => setNewName(e.target.value)}
              onBlur={() => { const n = newName.trim(); if (n) onCreate(n); setCreating(false); }}
              placeholder="文件夹名称"
              className="h-7 w-full rounded border border-[hsl(var(--hairline))] bg-[hsl(var(--surface-sunken))] px-2 text-sm outline-none focus:border-primary/60" />
          </form>
        ) : folders.length === 0 ? (
          <p className="px-2 py-2 text-[11px] text-muted-foreground">还没有文件夹。点右上角 + 新建一个来分类验收项。</p>
        ) : null}
      </div>
    </div>
  );
}

function EmptyReportsState({ onCreate, filtered }: { onCreate: () => void; filtered: boolean }): JSX.Element {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-4 rounded-md border border-dashed border-border px-6 py-16 text-center">
      <div className="flex h-14 w-14 items-center justify-center rounded-full bg-[hsl(var(--surface-sunken))] text-muted-foreground">
        <ClipboardCheck className="h-7 w-7" />
      </div>
      <div className="space-y-1">
        <h2 className="text-base font-semibold">{filtered ? '这个文件夹还没有报告' : '还没有验收报告'}</h2>
        <p className="max-w-md text-sm text-muted-foreground">
          {filtered
            ? '把报告移动到此文件夹，或在此处新建一份。'
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

function ReportList({
  reports, folders, projects, selectedId, onSelect, onDelete, onMove, onCopy,
}: {
  reports: AcceptanceReport[];
  folders: ReportFolder[];
  projects: ProjectLite[];
  selectedId: string | null;
  onSelect: (report: AcceptanceReport) => void;
  onDelete: (report: AcceptanceReport) => void;
  onMove: (report: AcceptanceReport, folderId: string | null) => void;
  onCopy: (report: AcceptanceReport) => void;
}): JSX.Element {
  const projectName = useMemo(() => {
    const map = new Map<string, string>();
    for (const p of projects) map.set(p.id, p.name || p.slug || p.id);
    return map;
  }, [projects]);

  return (
    <div className="flex min-h-0 w-full flex-col overflow-hidden rounded-md border border-[hsl(var(--hairline))] lg:w-[340px] lg:shrink-0">
      <div className="border-b border-[hsl(var(--hairline))] bg-[hsl(var(--surface-sunken))] px-3 py-2 text-xs font-medium text-muted-foreground">
        共 {reports.length} 份报告
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto" style={{ overscrollBehavior: 'contain' }}>
        {reports.map((report) => {
          const active = report.id === selectedId;
          return (
            <div key={report.id}
              className={`group flex cursor-pointer items-start gap-2 border-b border-[hsl(var(--hairline))] px-3 py-3 transition-colors ${active ? 'bg-primary/10' : 'hover:bg-[hsl(var(--surface-sunken))]'}`}
              onClick={() => onSelect(report)}>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  {report.verdict ? <VerdictBadge verdict={report.verdict} /> : null}
                  <span className="truncate text-sm font-medium">{report.title}</span>
                </div>
                <div className="mt-1.5 flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
                  <FormatBadge format={report.format} />
                  <span>{formatBytes(report.sizeBytes)}</span>
                  {report.projectId ? <span className="truncate">项目：{projectName.get(report.projectId) ?? report.projectId}</span> : null}
                  {report.commitSha ? <span className="font-mono">· {report.commitSha.slice(0, 7)}</span> : null}
                  {report.prNumber ? <span>· PR #{report.prNumber}</span> : null}
                </div>
                <div className="mt-1 flex items-center justify-between gap-2">
                  <span className="text-[11px] text-muted-foreground/80">{formatTime(report.createdAt)}</span>
                  <select
                    value={report.folderId ?? ''}
                    onClick={(e) => e.stopPropagation()}
                    onChange={(e) => onMove(report, e.target.value || null)}
                    title="移动到文件夹"
                    className="max-w-[120px] rounded border border-[hsl(var(--hairline))] bg-[hsl(var(--surface-sunken))] px-1.5 py-0.5 text-[11px] text-muted-foreground opacity-0 outline-none transition-opacity focus:opacity-100 group-hover:opacity-100"
                  >
                    <option value="">未归类</option>
                    {folders.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
                  </select>
                </div>
              </div>
              <div className="flex items-center" onClick={(e) => e.stopPropagation()}>
                <Button variant="ghost" size="icon"
                  className="h-7 w-7 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100"
                  aria-label="复制直达链接" title="复制直达链接"
                  onClick={() => onCopy(report)}>
                  <Link2 className="h-3.5 w-3.5" />
                </Button>
                <ConfirmAction
                  trigger={(
                    <Button variant="ghost" size="icon"
                      className="h-7 w-7 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100"
                      aria-label="删除报告" title="删除报告">
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  )}
                  title="删除这份验收报告？"
                  description="报告的元数据和内容文件都会被删除，无法恢复。"
                  confirmLabel="删除"
                  onConfirm={() => onDelete(report)}
                />
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/**
 * Report viewer. HTML via iframe `src` → /raw with sandbox (no allow-same-origin).
 * Markdown fetched, converted with `marked`, injected via srcDoc into the same
 * no-same-origin sandbox. See routes/reports.ts security note.
 */
function ReportViewer({ report }: { report: AcceptanceReport | null }): JSX.Element {
  const [mdHtml, setMdHtml] = useState<string | null>(null);
  const [mdError, setMdError] = useState<string | null>(null);
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

  if (!report) {
    return (
      <div className="hidden min-h-0 flex-1 items-center justify-center rounded-md border border-dashed border-border text-sm text-muted-foreground lg:flex">
        从左侧选择一份报告查看内容
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-md border border-[hsl(var(--hairline))]">
      <div className="flex items-center justify-between gap-2 border-b border-[hsl(var(--hairline))] bg-[hsl(var(--surface-sunken))] px-3 py-2">
        <div className="flex min-w-0 items-center gap-2">
          {report.verdict ? <VerdictBadge verdict={report.verdict} /> : null}
          <span className="truncate text-sm font-medium">{report.title}</span>
          <FormatBadge format={report.format} />
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <ShareControl report={report} />
          <span className="text-[11px] text-muted-foreground">{formatBytes(report.sizeBytes)}</span>
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
      const common = { projectId: projectId || null, folderId: folderId || null };
      const report = file
        ? await createReportFromFile({ title: cleanTitle, format, file, ...common })
        : await createReportFromText({ title: cleanTitle, format, content, ...common });
      onCreated(report);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  }, [title, content, file, format, projectId, folderId, onCreated]);

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
            {folders.length > 0 ? (
              <label className="block space-y-1.5">
                <span className="text-sm font-medium">文件夹（可选）</span>
                <select value={folderId} onChange={(e) => setFolderId(e.target.value)}
                  className="h-9 w-full rounded-md border border-[hsl(var(--hairline))] bg-[hsl(var(--surface-sunken))] px-3 text-sm outline-none focus:border-primary/60">
                  <option value="">未归类</option>
                  {folders.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
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
