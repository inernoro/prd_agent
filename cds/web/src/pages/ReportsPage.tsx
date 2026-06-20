import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ClipboardCheck, FileCode2, FileText, Plus, RefreshCw, Trash2, Upload } from 'lucide-react';
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
  createReportFromFile,
  createReportFromText,
  deleteReport,
  fetchReportRaw,
  listReports,
  reportRawUrl,
  type AcceptanceReport,
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
  const [state, setState] = useState<ListState>({ status: 'loading' });
  const [projects, setProjects] = useState<ProjectLite[]>([]);
  const [createOpen, setCreateOpen] = useState(false);
  const [selected, setSelected] = useState<AcceptanceReport | null>(null);
  const [toast, setToast] = useState('');

  const load = useCallback(async () => {
    setState({ status: 'loading' });
    try {
      const reports = await listReports();
      setState({ status: 'ok', reports });
    } catch (err) {
      const apiErr = err instanceof ApiError ? err : null;
      setState({
        status: 'error',
        message: apiErr?.message ?? String(err),
        transient: Boolean(apiErr?.transient),
      });
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // Projects are best-effort — the association dropdown is optional, so a
  // failure here must not block the report list.
  useEffect(() => {
    let cancelled = false;
    apiRequest<{ projects?: ProjectLite[] }>('/api/projects')
      .then((res) => {
        if (!cancelled) setProjects(res.projects ?? []);
      })
      .catch(() => {
        if (!cancelled) setProjects([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!toast) return undefined;
    const t = window.setTimeout(() => setToast(''), 3000);
    return () => window.clearTimeout(t);
  }, [toast]);

  const handleCreated = useCallback(
    (report: AcceptanceReport) => {
      setCreateOpen(false);
      setToast(`已创建报告「${report.title}」`);
      setState((current) =>
        current.status === 'ok'
          ? { status: 'ok', reports: [report, ...current.reports] }
          : current,
      );
      setSelected(report);
    },
    [],
  );

  const handleDelete = useCallback(
    async (report: AcceptanceReport) => {
      try {
        await deleteReport(report.id);
        setToast(`已删除报告「${report.title}」`);
        setState((current) =>
          current.status === 'ok'
            ? { status: 'ok', reports: current.reports.filter((r) => r.id !== report.id) }
            : current,
        );
        setSelected((current) => (current?.id === report.id ? null : current));
      } catch (err) {
        const message = err instanceof ApiError ? err.message : String(err);
        setToast(`删除失败：${message}`);
      }
    },
    [],
  );

  return (
    <AppShell
      active="reports"
      topbar={(
        <TopBar
          left={<Crumb items={[{ label: 'CDS', href: '/project-list' }, { label: '验收报告' }]} />}
          right={(
            <>
              <PaletteHint />
              <Button variant="outline" size="sm" onClick={() => void load()}>
                <RefreshCw />
                刷新
              </Button>
              <Button size="sm" onClick={() => setCreateOpen(true)}>
                <Plus />
                新建报告
              </Button>
            </>
          )}
        />
      )}
    >
      <Workspace>
        <div className="flex h-full min-h-0 flex-col gap-5">
          <section className="cds-surface-raised cds-hairline p-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="min-w-0">
                <h1 className="text-lg font-semibold">验收报告</h1>
                <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
                  把验收 / 视觉测试报告托管在 CDS 自身，挂在 CDS 登录态之后访问，无需单独的知识库或额外权限配置。支持 HTML 与 Markdown 两种格式。
                </p>
              </div>
            </div>
            {toast ? (
              <div className="mt-3 rounded-md border border-[hsl(var(--hairline))] bg-[hsl(var(--surface-sunken))] px-3 py-2 text-sm">
                {toast}
              </div>
            ) : null}
          </section>

          {state.status === 'loading' ? <LoadingBlock label="正在加载验收报告" /> : null}
          {state.status === 'error' ? (
            <ErrorBlock message={state.message} transient={state.transient} />
          ) : null}

          {state.status === 'ok' ? (
            state.reports.length === 0 ? (
              <EmptyReportsState onCreate={() => setCreateOpen(true)} />
            ) : (
              <div className="flex min-h-0 flex-1 flex-col gap-4 lg:flex-row">
                <ReportList
                  reports={state.reports}
                  projects={projects}
                  selectedId={selected?.id ?? null}
                  onSelect={setSelected}
                  onDelete={handleDelete}
                />
                <ReportViewer report={selected} />
              </div>
            )
          ) : null}
        </div>
      </Workspace>

      <CreateReportDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        projects={projects}
        onCreated={handleCreated}
      />
    </AppShell>
  );
}

function EmptyReportsState({ onCreate }: { onCreate: () => void }): JSX.Element {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-4 rounded-md border border-dashed border-border px-6 py-16 text-center">
      <div className="flex h-14 w-14 items-center justify-center rounded-full bg-[hsl(var(--surface-sunken))] text-muted-foreground">
        <ClipboardCheck className="h-7 w-7" />
      </div>
      <div className="space-y-1">
        <h2 className="text-base font-semibold">还没有验收报告</h2>
        <p className="max-w-md text-sm text-muted-foreground">
          上传或粘贴一份 HTML / Markdown 报告，CDS 会托管它的内容并以沙箱安全渲染。不需要外部知识库，CDS 登录即可访问。
        </p>
      </div>
      <Button onClick={onCreate}>
        <Upload />
        上传 / 新建第一份验收报告
      </Button>
    </div>
  );
}

function FormatBadge({ format }: { format: ReportFormat }): JSX.Element {
  const Icon = format === 'html' ? FileCode2 : FileText;
  const label = format === 'html' ? 'HTML' : 'Markdown';
  return (
    <span className="inline-flex items-center gap-1 rounded border border-[hsl(var(--hairline))] bg-[hsl(var(--surface-sunken))] px-1.5 py-0.5 text-[11px] font-medium text-muted-foreground">
      <Icon className="h-3 w-3" />
      {label}
    </span>
  );
}

function ReportList({
  reports,
  projects,
  selectedId,
  onSelect,
  onDelete,
}: {
  reports: AcceptanceReport[];
  projects: ProjectLite[];
  selectedId: string | null;
  onSelect: (report: AcceptanceReport) => void;
  onDelete: (report: AcceptanceReport) => void;
}): JSX.Element {
  const projectName = useMemo(() => {
    const map = new Map<string, string>();
    for (const p of projects) map.set(p.id, p.name || p.slug || p.id);
    return map;
  }, [projects]);

  return (
    <div className="flex min-h-0 w-full flex-col overflow-hidden rounded-md border border-[hsl(var(--hairline))] lg:w-[360px] lg:shrink-0">
      <div className="border-b border-[hsl(var(--hairline))] bg-[hsl(var(--surface-sunken))] px-3 py-2 text-xs font-medium text-muted-foreground">
        共 {reports.length} 份报告
      </div>
      <div
        className="min-h-0 flex-1 overflow-y-auto"
        style={{ overscrollBehavior: 'contain' }}
      >
        {reports.map((report) => {
          const active = report.id === selectedId;
          return (
            <div
              key={report.id}
              className={`group flex cursor-pointer items-start gap-2 border-b border-[hsl(var(--hairline))] px-3 py-3 transition-colors ${active ? 'bg-primary/10' : 'hover:bg-[hsl(var(--surface-sunken))]'}`}
              onClick={() => onSelect(report)}
            >
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="truncate text-sm font-medium">{report.title}</span>
                </div>
                <div className="mt-1.5 flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
                  <FormatBadge format={report.format} />
                  <span>{formatBytes(report.sizeBytes)}</span>
                  {report.projectId ? (
                    <span className="truncate">项目：{projectName.get(report.projectId) ?? report.projectId}</span>
                  ) : null}
                </div>
                <div className="mt-1 text-[11px] text-muted-foreground/80">{formatTime(report.createdAt)}</div>
              </div>
              <div onClick={(e) => e.stopPropagation()}>
                <ConfirmAction
                  trigger={(
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100"
                      aria-label="删除报告"
                      title="删除报告"
                    >
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
 * Report viewer. HTML reports are embedded via iframe `src` pointing at the
 * /raw endpoint with `sandbox="allow-scripts"` (no allow-same-origin), so the
 * report cannot read CDS cookies/session even though scripts can run. Markdown
 * is fetched, converted to HTML with `marked`, and injected via `srcDoc` into
 * the SAME no-same-origin sandbox — so even malicious MD-embedded HTML can
 * never act with CDS-origin privileges. See .claude/rules + routes/reports.ts.
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
        // Wrap in a minimal document with theme-neutral defaults. Rendered
        // inside a no-same-origin sandbox, so this HTML is fully isolated.
        const doc = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>
          :root { color-scheme: light dark; }
          body { font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; line-height: 1.6; padding: 24px; max-width: 860px; margin: 0 auto; }
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
          <span className="truncate text-sm font-medium">{report.title}</span>
          <FormatBadge format={report.format} />
        </div>
        <span className="shrink-0 text-[11px] text-muted-foreground">{formatBytes(report.sizeBytes)}</span>
      </div>
      <div className="min-h-0 flex-1 bg-white">
        {report.format === 'html' ? (
          <iframe
            key={report.id}
            title={report.title}
            src={reportRawUrl(report.id)}
            sandbox="allow-scripts"
            className="h-full w-full border-0"
          />
        ) : mdError ? (
          <div className="p-4">
            <ErrorBlock message={mdError} />
          </div>
        ) : mdHtml === null ? (
          <div className="p-4">
            <LoadingBlock label="正在渲染 Markdown" />
          </div>
        ) : (
          <iframe
            key={report.id}
            title={report.title}
            srcDoc={mdHtml}
            sandbox="allow-scripts"
            className="h-full w-full border-0"
          />
        )}
      </div>
    </div>
  );
}

function CreateReportDialog({
  open,
  onOpenChange,
  projects,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projects: ProjectLite[];
  onCreated: (report: AcceptanceReport) => void;
}): JSX.Element {
  const [title, setTitle] = useState('');
  const [format, setFormat] = useState<ReportFormat>('html');
  const [content, setContent] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [projectId, setProjectId] = useState('');
  const [dragOver, setDragOver] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) {
      setTitle('');
      setFormat('html');
      setContent('');
      setFile(null);
      setProjectId('');
      setDragOver(false);
      setError('');
    }
  }, [open]);

  const applyFile = useCallback((picked: File) => {
    setFile(picked);
    const name = picked.name.toLowerCase();
    if (name.endsWith('.md') || name.endsWith('.markdown')) setFormat('md');
    else if (name.endsWith('.html') || name.endsWith('.htm')) setFormat('html');
    if (!title.trim()) setTitle(picked.name.replace(/\.(html?|md|markdown)$/i, ''));
    // Reading the file into the textarea keeps a single content source and lets
    // the user tweak before submit (anti-detour: paste + upload share one box).
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === 'string') setContent(reader.result);
    };
    reader.readAsText(picked);
  }, [title]);

  const submit = useCallback(async () => {
    setError('');
    const cleanTitle = title.trim();
    if (!cleanTitle) {
      setError('请填写报告标题');
      return;
    }
    if (!content.trim()) {
      setError('请粘贴报告内容或上传文件');
      return;
    }
    setSubmitting(true);
    try {
      let report: AcceptanceReport;
      if (file) {
        report = await createReportFromFile({
          title: cleanTitle,
          format,
          file,
          projectId: projectId || null,
        });
      } else {
        report = await createReportFromText({
          title: cleanTitle,
          format,
          content,
          projectId: projectId || null,
        });
      }
      onCreated(report);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  }, [title, content, file, format, projectId, onCreated]);

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
            <input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="例如：登录页视觉验收 2026-06-20"
              className="h-9 w-full rounded-md border border-[hsl(var(--hairline))] bg-[hsl(var(--surface-sunken))] px-3 text-sm outline-none focus:border-primary/60"
            />
          </label>

          <div className="space-y-1.5">
            <span className="text-sm font-medium">格式</span>
            <div className="flex gap-2">
              {(['html', 'md'] as ReportFormat[]).map((f) => (
                <button
                  key={f}
                  type="button"
                  onClick={() => setFormat(f)}
                  className={`inline-flex h-9 items-center gap-1.5 rounded-md border px-3 text-sm transition-colors ${format === f ? 'border-primary bg-primary/10 text-primary' : 'border-[hsl(var(--hairline))] text-muted-foreground hover:text-foreground'}`}
                >
                  {f === 'html' ? <FileCode2 className="h-4 w-4" /> : <FileText className="h-4 w-4" />}
                  {f === 'html' ? 'HTML' : 'Markdown'}
                </button>
              ))}
            </div>
          </div>

          {projects.length > 0 ? (
            <label className="block space-y-1.5">
              <span className="text-sm font-medium">关联项目（可选）</span>
              <select
                value={projectId}
                onChange={(e) => setProjectId(e.target.value)}
                className="h-9 w-full rounded-md border border-[hsl(var(--hairline))] bg-[hsl(var(--surface-sunken))] px-3 text-sm outline-none focus:border-primary/60"
              >
                <option value="">不关联</option>
                {projects.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name || p.slug || p.id}
                  </option>
                ))}
              </select>
            </label>
          ) : null}

          <div
            className={`rounded-md border border-dashed px-4 py-5 text-center text-sm transition-colors ${dragOver ? 'border-primary bg-primary/5' : 'border-[hsl(var(--hairline))]'}`}
            onDragOver={(e) => {
              e.preventDefault();
              setDragOver(true);
            }}
            onDragLeave={() => setDragOver(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDragOver(false);
              const dropped = e.dataTransfer.files?.[0];
              if (dropped) applyFile(dropped);
            }}
          >
            <input
              ref={fileInputRef}
              type="file"
              accept=".html,.htm,.md,.markdown,text/html,text/markdown"
              className="hidden"
              onChange={(e) => {
                const picked = e.target.files?.[0];
                if (picked) applyFile(picked);
              }}
            />
            <Upload className="mx-auto mb-2 h-5 w-5 text-muted-foreground" />
            <div className="text-muted-foreground">
              拖拽 .html / .md 文件到此处，或{' '}
              <button
                type="button"
                className="font-medium text-primary underline-offset-2 hover:underline"
                onClick={() => fileInputRef.current?.click()}
              >
                点击选择文件
              </button>
            </div>
            {file ? (
              <div className="mt-2 text-xs text-foreground">已选择：{file.name}（{formatBytes(file.size)}）</div>
            ) : null}
          </div>

          <label className="block space-y-1.5">
            <span className="text-sm font-medium">内容（粘贴或编辑）</span>
            <textarea
              value={content}
              onChange={(e) => {
                setContent(e.target.value);
                // Editing the textarea detaches from the picked file so the
                // edited text is what gets submitted.
                if (file) setFile(null);
              }}
              placeholder={format === 'html' ? '在此粘贴完整 HTML 报告…' : '在此粘贴 Markdown 报告…'}
              spellCheck={false}
              className="h-48 w-full resize-y rounded-md border border-[hsl(var(--hairline))] bg-[hsl(var(--surface-sunken))] px-3 py-2 font-mono text-xs outline-none focus:border-primary/60"
              style={{ minHeight: 0 }}
            />
          </label>

          {error ? (
            <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
              {error}
            </div>
          ) : null}

          <div className="flex justify-end gap-2 border-t border-[hsl(var(--hairline))] pt-4">
            <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={submitting}>
              取消
            </Button>
            <Button onClick={() => void submit()} disabled={submitting}>
              {submitting ? '创建中…' : '创建报告'}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
