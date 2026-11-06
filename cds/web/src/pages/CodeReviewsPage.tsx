import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { useSearchParams, Link } from 'react-router-dom';
import { marked } from 'marked';
import { ArrowLeft, ArrowUpRight, Check, Download, FileArchive, FileCode2, GitBranch, Mail, RefreshCw, SearchCode, Upload, X } from 'lucide-react';
import { AppShell, Crumb, TopBar, Workspace } from '@/components/layout/AppShell';
import { Button } from '@/components/ui/button';
import { ContentLoading } from '@/components/skeletons/ContentLoading';
import { CodeReviewsSkeleton } from '@/components/skeletons/CodeReviewsSkeleton';
import { apiRequest } from '@/lib/api';
import { useTheme } from '@/lib/theme';
import { CODE_REVIEW_STATUS, codeReviewAction, codeReviewReportUrl, downloadCodeReviewReport, listCodeReviews, submitCodeReview, type CodeReviewTask } from '@/lib/codeReviews';

interface ProjectOption { id: string; name: string; aliasName?: string; }
interface Capabilities { engineConfigured: boolean; mailConfigured: boolean; }

const inputClass = 'h-9 w-full rounded-md border border-input bg-background px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring';
const deliveryLabels: Record<CodeReviewTask['delivery']['status'], string> = {
  not_requested: '仅报告中心', pending: '等待邮件投递', sending: '正在发送邮件', sent: '邮件已发送', failed: '邮件发送失败',
};
const isActive = (task: CodeReviewTask): boolean => CODE_REVIEW_STATUS[task.status]?.active ?? false;
const errorMessage = (error: unknown): string => error instanceof Error ? error.message : '请求失败，请稍后重试';

export function CodeReviewsPage(): JSX.Element {
  const [params, setParams] = useSearchParams();
  const projectFilter = params.get('project') || '';
  const selectedId = params.get('task') || '';
  const [projects, setProjects] = useState<ProjectOption[]>([]);
  const [capabilities, setCapabilities] = useState<Capabilities | null>(null);
  const [setupError, setSetupError] = useState('');
  const [setupLoading, setSetupLoading] = useState(true);
  const [initialSettled, setInitialSettled] = useState(false);
  const [tasks, setTasks] = useState<CodeReviewTask[]>([]);
  const [loading, setLoading] = useState(true);
  const [listError, setListError] = useState('');
  const [actionError, setActionError] = useState('');
  const [refresh, setRefresh] = useState(0);
  const [pendingAction, setPendingAction] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [projectId, setProjectId] = useState(projectFilter);
  const [sourceType, setSourceType] = useState<'zip' | 'github'>('zip');
  const [file, setFile] = useState<File | null>(null);
  const [githubUrl, setGithubUrl] = useState('');
  const [ref, setRef] = useState('');
  const [exclude, setExclude] = useState('');
  const [sendEmail, setSendEmail] = useState(false);
  const [email, setEmail] = useState('');
  const [notice, setNotice] = useState('');
  const [now, setNow] = useState(Date.now());
  const fileInput = useRef<HTMLInputElement>(null);
  const requestEpoch = useRef(0);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void Promise.all([
      apiRequest<{ projects: ProjectOption[] }>('/api/projects', { signal: controller.signal }),
      apiRequest<Capabilities>('/api/code-reviews/capabilities', { signal: controller.signal }),
    ]).then(([projectResponse, capabilityResponse]) => {
      if (controller.signal.aborted) return;
      setProjects(projectResponse.projects);
      setCapabilities(capabilityResponse);
      setSetupError('');
      setProjectId((current) => projectResponse.projects.some((project) => project.id === current)
        ? current : projectResponse.projects[0]?.id || '');
    }).catch((error: unknown) => { if (!controller.signal.aborted) setSetupError(errorMessage(error)); })
      .finally(() => { if (!controller.signal.aborted) setSetupLoading(false); });
    return () => controller.abort();
  }, [refresh]);

  useEffect(() => {
    const controller = new AbortController();
    const epoch = ++requestEpoch.current;
    let timer: number | undefined;
    setLoading(true);
    setTasks([]);
    setListError('');
    const load = async (): Promise<void> => {
      try {
        const next = await listCodeReviews(projectFilter, controller.signal);
        if (controller.signal.aborted || epoch !== requestEpoch.current) return;
        setTasks(next);
        setListError('');
      } catch (error) {
        if (controller.signal.aborted || epoch !== requestEpoch.current) return;
        setListError(errorMessage(error));
      } finally {
        if (!controller.signal.aborted && epoch === requestEpoch.current) {
          setLoading(false);
          timer = window.setTimeout(() => { void load(); }, 4_000);
        }
      }
    };
    void load();
    return () => { controller.abort(); window.clearTimeout(timer); };
  }, [projectFilter, refresh]);

  useEffect(() => {
    if ((!setupLoading && !loading) || setupError || listError) setInitialSettled(true);
  }, [setupLoading, loading, setupError, listError]);

  const hasActive = submitting || tasks.some((task) => isActive(task) || task.delivery.status === 'sending');
  useEffect(() => {
    if (!hasActive) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [hasActive]);

  const selectTask = useCallback((task: CodeReviewTask): void => {
    setParams((current) => { const next = new URLSearchParams(current); next.set('task', task.id); next.delete('report'); return next; });
  }, [setParams]);

  const submit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (submitting) return;
    setActionError('');
    setNotice('');
    if (!projectId) { setActionError('请先选择归属项目'); return; }
    if (sourceType === 'zip' && !file) { setActionError('请选择 ZIP 压缩包'); return; }
    setSubmitting(true);
    try {
      const task = await submitCodeReview({
        projectId, sourceType, file: file || undefined, githubUrl: githubUrl.trim(), ref: ref.trim(),
        excludePatterns: exclude.split('\n').map((line) => line.trim()).filter(Boolean),
        email: sendEmail ? email.trim() : undefined,
      });
      if (!mounted.current) return;
      setParams({ project: task.projectId, task: task.id });
      setRefresh((value) => value + 1);
      setNotice('审查任务已提交。可离开此页面，任务会继续执行，完成后自动归档报告。');
    } catch (error) { if (mounted.current) setActionError(errorMessage(error)); }
    finally { if (mounted.current) setSubmitting(false); }
  };

  const act = async (task: CodeReviewTask, action: 'cancel' | 'retry' | 'delivery/retry'): Promise<void> => {
    if (pendingAction) return;
    setPendingAction(task.id);
    setActionError('');
    try {
      const result = await codeReviewAction(task.id, action);
      if (!mounted.current) return;
      setTasks((current) => current.map((item) => item.id === result.id ? result : item));
      selectTask(result);
      setRefresh((value) => value + 1);
      setNotice(action === 'delivery/retry' ? '已提交邮件重试，报告保持原样。' : action === 'cancel' ? '已请求取消审查。' : '已提交重新审查。');
    } catch (error) { if (mounted.current) setActionError(errorMessage(error)); }
    finally { if (mounted.current) setPendingAction(''); }
  };

  const selected = selectedId ? tasks.find((task) => task.id === selectedId) : tasks[0];
  const projectName = (id: string): string => {
    const project = projects.find((item) => item.id === id);
    return project?.aliasName || project?.name || id;
  };

  const topbar = <TopBar
    left={<Crumb items={[{ label: 'CDS', href: '/project-list' }, { label: '代码审查报告' }]} />}
    right={<Button variant="outline" size="sm" onClick={() => setRefresh((value) => value + 1)} disabled={loading}><RefreshCw />刷新</Button>}
  />;
  const initialLoading = !initialSettled && !setupError && !listError;
  if (initialLoading) return <AppShell active="code-reviews" topbar={topbar}>
    <Workspace fluid><CodeReviewsSkeleton /></Workspace>
  </AppShell>;

  return <AppShell active="code-reviews" wide topbar={topbar}>
    <Workspace wide className="min-h-0 space-y-6 pb-8">
      <header className="space-y-2">
        <div className="flex items-center gap-2"><SearchCode className="size-6 text-muted-foreground" aria-hidden="true" /><h1 className="text-2xl font-semibold tracking-tight">代码审查报告</h1></div>
        <p className="text-sm leading-6 text-muted-foreground">上传代码或提交 GitHub 地址，检查 Bug、安全、性能、风格与可维护性。报告自动归档，可额外发送至邮箱。</p>
      </header>

      {setupError ? <ErrorNotice message={`暂时无法读取审查配置：${setupError}`} /> : null}
      {capabilities && !capabilities.engineConfigured ? <div role="status" className="rounded-lg border border-border bg-muted/40 p-4 text-sm">审查引擎尚未配置。管理员接入 DeepAudit 后即可发起审查，已有报告仍可查看。</div> : null}
      {notice ? <div role="status" className="flex items-start gap-2 rounded-lg border border-border bg-muted/30 p-3 text-sm"><Check className="mt-0.5 size-4 shrink-0" aria-hidden="true" />{notice}</div> : null}
      {actionError ? <ErrorNotice message={actionError} /> : null}

      {params.get('report') === '1' && selected?.reportId ? <ReviewReportReader key={selected.id} task={selected} onBack={() => setParams((current) => { const next = new URLSearchParams(current); next.delete('report'); return next; })} /> : null}

      <section aria-labelledby="review-submit-heading" className="rounded-xl border border-border bg-card p-5">
        <h2 id="review-submit-heading" className="mb-4 text-base font-semibold">发起代码审查</h2>
        <form onSubmit={(event) => { void submit(event); }} className="space-y-4" aria-busy={submitting}>
          <fieldset disabled={submitting} className="space-y-4">
            <label className="block space-y-1.5 text-sm"><span>归属项目</span><select required className={inputClass} value={projectId} onChange={(event) => setProjectId(event.target.value)}><option value="">请选择项目</option>{projects.map((project) => <option key={project.id} value={project.id}>{project.aliasName || project.name}</option>)}</select></label>
            <div role="group" aria-label="源码提交方式" className="flex flex-wrap gap-2">
              <Button type="button" variant={sourceType === 'zip' ? 'default' : 'outline'} size="sm" aria-pressed={sourceType === 'zip'} onClick={() => setSourceType('zip')}><FileArchive />上传 ZIP</Button>
              <Button type="button" variant={sourceType === 'github' ? 'default' : 'outline'} size="sm" aria-pressed={sourceType === 'github'} onClick={() => { setSourceType('github'); setFile(null); }}><GitBranch />GitHub 地址</Button>
            </div>
            {sourceType === 'zip' ? <label className="block rounded-lg border border-dashed border-input bg-muted/20 p-4 text-sm">
              <span className="mb-2 flex items-center gap-2 font-medium"><Upload className="size-4" aria-hidden="true" />选择源码压缩包</span>
              <input ref={fileInput} aria-label="源码 ZIP 压缩包" type="file" accept=".zip,application/zip" required onChange={(event) => setFile(event.target.files?.[0] || null)} className="block w-full text-sm file:mr-3 file:rounded-md file:border-0 file:bg-secondary file:px-3 file:py-2 file:text-secondary-foreground" />
              <span className="mt-2 block text-xs text-muted-foreground">{file ? `${file.name} · ${(file.size / 1024 / 1024).toFixed(1)} MB` : '请选择 ZIP 文件。建议排除依赖目录、构建产物和凭据文件。'}</span>
            </label> : <div className="grid gap-4 md:grid-cols-[2fr_1fr]">
              <label className="block space-y-1.5 text-sm"><span>GitHub 仓库地址</span><input type="url" required value={githubUrl} onChange={(event) => setGithubUrl(event.target.value)} placeholder="https://github.com/owner/repository" className={inputClass} /><span className="block text-xs leading-5 text-muted-foreground">支持公开仓库和已通过 CDS GitHub App 授权的私有仓库。未授权时也可改用 ZIP。</span></label>
              <label className="block space-y-1.5 text-sm"><span>分支、标签或提交 <span className="text-muted-foreground">（可选）</span></span><input value={ref} onChange={(event) => setRef(event.target.value)} placeholder="留空使用默认分支" className={inputClass} /></label>
            </div>}
            <details className="rounded-lg border border-border px-3 py-2">
              <summary className="cursor-pointer text-sm">排除目录或文件（可选）</summary>
              <label className="mt-3 block space-y-1.5 text-sm"><span className="text-muted-foreground">每行填写一个排除规则</span><textarea value={exclude} onChange={(event) => setExclude(event.target.value)} rows={3} placeholder={'vendor\nthirdparty\n*.min.js'} className="w-full resize-y rounded-md border border-input bg-background p-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring" /></label>
            </details>
            <fieldset className="space-y-2"><legend className="mb-2 text-sm font-medium">报告接收方式</legend>
              <label className="flex cursor-pointer items-center gap-2 text-sm"><input type="radio" name="review-delivery" checked={!sendEmail} onChange={() => setSendEmail(false)} />仅报告中心</label>
              <label className="flex items-center gap-2 text-sm"><input type="radio" name="review-delivery" checked={sendEmail} disabled={!capabilities?.mailConfigured} onChange={() => setSendEmail(true)} />报告中心 + 邮箱{capabilities && !capabilities.mailConfigured ? <span className="text-xs text-muted-foreground">（邮件服务尚未配置）</span> : null}</label>
              {sendEmail ? <label className="block max-w-lg space-y-1.5 pt-1 text-sm"><span>收件邮箱</span><input type="email" required value={email} onChange={(event) => setEmail(event.target.value)} placeholder="you@example.com" className={inputClass} /></label> : null}
            </fieldset>
          </fieldset>
          <div className="flex flex-wrap items-center gap-3"><Button type="submit" disabled={submitting || !projectId || !capabilities?.engineConfigured}><SearchCode />{submitting ? '正在上传并创建任务' : '开始审查'}</Button>{submitting ? <ContentLoading label="正在提交代码审查" variant="inline" /> : <span className="text-xs text-muted-foreground">分析期间可离开页面，结果会持续保存在 CDS。</span>}</div>
        </form>
      </section>

      <section aria-labelledby="review-history-heading" className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-3"><h2 id="review-history-heading" className="text-base font-semibold">审查任务与报告</h2><label className="flex min-w-0 items-center gap-2 text-sm"><span className="shrink-0 whitespace-nowrap text-muted-foreground">项目</span><select aria-label="筛选审查项目" value={projectFilter} className={`${inputClass} max-w-60`} onChange={(event) => { const next = new URLSearchParams(); if (event.target.value) next.set('project', event.target.value); setParams(next); }}><option value="">全部可访问项目</option>{projects.map((project) => <option key={project.id} value={project.id}>{project.aliasName || project.name}</option>)}</select></label></div>
        {listError ? <ErrorNotice message={`任务列表刷新失败，保留最近一次结果：${listError}`} /> : null}
        {!loading && !listError && selectedId && !selected ? <ErrorNotice message="未找到该审查任务，或当前账号没有访问权限。请从下面的列表选择任务。" /> : null}
        {loading ? <ContentLoading label="正在读取审查任务" variant="rows" /> : tasks.length === 0 ? <div className="rounded-xl border border-dashed border-border p-8 text-center"><FileCode2 className="mx-auto mb-3 size-8 text-muted-foreground" aria-hidden="true" /><h3 className="text-sm font-medium">还没有代码审查报告</h3><p className="mt-2 text-sm text-muted-foreground">在上方选择项目并上传 ZIP，或提交 GitHub 地址，开始第一次审查。</p><Button variant="outline" className="mt-4" onClick={() => { setSourceType('zip'); window.requestAnimationFrame(() => fileInput.current?.click()); }}>选择 ZIP 文件</Button></div> : <div className="grid items-start gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
          <div className="overflow-hidden rounded-xl border border-border bg-card"><ul className="divide-y divide-border">{tasks.map((task) => <li key={task.id}><button type="button" onClick={() => selectTask(task)} aria-pressed={selected?.id === task.id} className={`w-full p-4 text-left transition-colors hover:bg-muted/50 ${selected?.id === task.id ? 'bg-muted/50' : ''}`}><div className="flex flex-wrap items-center justify-between gap-2"><span className="min-w-0 break-all text-sm font-medium">{task.title || task.sourceName}</span><TaskStatus task={task} /></div><p className="mt-1.5 truncate text-xs text-muted-foreground">{projectName(task.projectId)} · {task.sourceName}</p><div className="mt-2 flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground"><time dateTime={task.createdAt}>{formatDate(task.createdAt)}</time><span>{deliveryLabels[task.delivery.status]}</span></div>{isActive(task) ? <p className="mt-2 text-xs text-muted-foreground">{task.phase} · 已处理 {task.progress.scannedFiles} / {task.progress.totalFiles || '待统计'} 个文件</p> : null}</button></li>)}</ul></div>
          {selected ? <ReviewDetail task={selected} now={now} pending={Boolean(pendingAction)} onAction={(action) => { void act(selected, action); }} /> : null}
        </div>}
      </section>
    </Workspace>
  </AppShell>;
}

function ReviewReportReader({ task, onBack }: { task: CodeReviewTask; onBack: () => void }): JSX.Element {
  const [payload, setPayload] = useState<{ report: { title: string; format: 'html' | 'md' }; content: string } | null>(null);
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  const [downloading, setDownloading] = useState(false);
  const [downloadError, setDownloadError] = useState('');
  const downloadRequest = useRef<AbortController | null>(null);
  const downloadLinks = useRef(new Map<string, number>());
  const container = useRef<HTMLElement>(null);
  const { theme } = useTheme();
  useEffect(() => { container.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }); }, []);
  useEffect(() => {
    const controller = new AbortController();
    setPayload(null);
    setError('');
    void apiRequest<{ report: { title: string; format: 'html' | 'md' }; content: string }>(`/api/code-reviews/${encodeURIComponent(task.id)}/report`, { signal: controller.signal })
      .then((response) => { if (!controller.signal.aborted) setPayload(response); })
      .catch((cause: unknown) => { if (!controller.signal.aborted) setError(errorMessage(cause)); });
    return () => controller.abort();
  }, [task.id, attempt]);
  useEffect(() => () => {
    downloadRequest.current?.abort();
    for (const [url, timer] of downloadLinks.current) {
      window.clearTimeout(timer);
      URL.revokeObjectURL(url);
    }
    downloadLinks.current.clear();
  }, []);
  const download = async (): Promise<void> => {
    if (downloadRequest.current || !payload) return;
    const controller = new AbortController();
    downloadRequest.current = controller;
    setDownloading(true);
    setDownloadError('');
    try {
      const blob = await downloadCodeReviewReport(task.id, controller.signal);
      if (controller.signal.aborted) return;
      const url = URL.createObjectURL(blob);
      // Keep the URL alive until the browser has started saving, then release it.
      const timer = window.setTimeout(() => {
        URL.revokeObjectURL(url);
        downloadLinks.current.delete(url);
      }, 1_000);
      downloadLinks.current.set(url, timer);
      const link = document.createElement('a');
      link.href = url;
      link.download = `code-review-${task.id}.${payload.report.format}`;
      document.body.append(link);
      try { link.click(); } finally { link.remove(); }
    } catch (cause) {
      if (!controller.signal.aborted) setDownloadError(errorMessage(cause));
    } finally {
      if (downloadRequest.current === controller) downloadRequest.current = null;
      if (!controller.signal.aborted) setDownloading(false);
    }
  };
  const html = payload ? buildCodeReviewDocument(payload.content, payload.report.format, theme) : '';
  return <section ref={container} aria-label="代码审查报告阅读器" className="scroll-mt-20 overflow-hidden rounded-xl border border-border bg-card">
    <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border p-3"><div className="flex min-w-0 items-center gap-3"><Button variant="ghost" size="sm" onClick={onBack}><ArrowLeft />返回任务</Button><h2 className="min-w-0 truncate text-sm font-medium">{payload?.report.title || task.title}</h2></div><Button variant="outline" size="sm" disabled={downloading || !payload} onClick={() => { void download(); }}><Download />{downloading ? '正在下载' : payload?.report.format === 'html' ? '下载 HTML' : '下载 Markdown'}</Button></div>
    {downloadError ? <div className="p-3"><ErrorNotice message={downloadError} /></div> : null}
    {error ? <div className="space-y-3 p-4"><ErrorNotice message={`报告正文读取失败：${error}`} /><Button variant="outline" onClick={() => setAttempt((value) => value + 1)}>重新加载报告</Button></div> : payload ? <iframe title={payload.report.title} srcDoc={html} sandbox="" className="h-[42rem] w-full border-0" /> : <ContentLoading label="正在读取审查报告正文" variant="panel" />}
  </section>;
}

export function buildCodeReviewDocument(content: string, format: 'html' | 'md', theme: 'dark' | 'light'): string {
  // Reports are untrusted; the opaque iframe and CSP forbid scripts, external
  // requests and navigation regardless of embedded HTML or Markdown content.
  const csp = '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'unsafe-inline\'; img-src data:; form-action \'none\'; base-uri \'none\'">';
  const style = `<style>:root{color-scheme:${theme}}body{background:Canvas;color:CanvasText;font:1rem/1.7 system-ui,sans-serif;margin:0;padding:1.5rem;overflow-wrap:anywhere}pre{padding:1rem;background:color-mix(in srgb,CanvasText 7%,Canvas);overflow:auto;border-radius:.5rem}table{border-collapse:collapse}td,th{padding:.5rem;border:1px solid GrayText}img{max-width:100%}a{color:LinkText}</style>`;
  if (format === 'html') return `${csp}${style}${content}`;
  return `<!doctype html><html><head><meta charset="utf-8">${csp}${style}</head><body>${marked.parse(content, { async: false })}</body></html>`;
}

function ErrorNotice({ message }: { message: string }): JSX.Element {
  return <div role="alert" className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">{message}</div>;
}

function TaskStatus({ task }: { task: CodeReviewTask }): JSX.Element {
  return <span className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs ${task.status === 'failed' ? 'border-destructive/30 text-destructive' : 'border-border text-muted-foreground'}`}>{isActive(task) ? <span className="size-1.5 animate-pulse rounded-full bg-current" aria-hidden="true" /> : null}{CODE_REVIEW_STATUS[task.status]?.label || task.status}</span>;
}

function formatDate(value: string): string {
  return new Date(value).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}

export function ReviewDetail({ task, now, pending, onAction }: {
  task: CodeReviewTask; now: number; pending: boolean; onAction: (action: 'cancel' | 'retry' | 'delivery/retry') => void;
}): JSX.Element {
  const reportUrl = codeReviewReportUrl(task);
  const active = isActive(task);
  const percent = task.progress.totalFiles > 0 ? Math.min(100, Math.round(task.progress.scannedFiles / task.progress.totalFiles * 100)) : null;
  const elapsed = Math.max(0, Math.floor((now - new Date(task.createdAt).getTime()) / 1000));
  return <article aria-label="审查任务详情" className="min-w-0 space-y-4 rounded-xl border border-border bg-card p-5">
    <div className="flex flex-wrap items-center justify-between gap-2"><h3 className="min-w-0 break-all text-base font-semibold">{task.title || task.sourceName}</h3><TaskStatus task={task} /></div>
    <div aria-live="polite" className="space-y-2"><p className="text-sm">{task.phase}</p>{active ? <><progress className="h-2 w-full accent-primary" aria-label="审查文件进度" max={100} value={percent ?? undefined} /><p className="text-xs text-muted-foreground">已处理 {task.progress.scannedFiles} / {task.progress.totalFiles || '待统计'} 个文件 · 等待 {Math.floor(elapsed / 60)} 分 {elapsed % 60} 秒</p></> : null}</div>
    {task.error ? <ErrorNotice message={task.error} /> : null}
    <dl className="space-y-2 text-xs"><div className="flex gap-3"><dt className="shrink-0 text-muted-foreground">源码</dt><dd className="min-w-0 break-all">{task.sourceName}</dd></div>{task.commitSha ? <div className="flex gap-3"><dt className="shrink-0 text-muted-foreground">提交</dt><dd className="min-w-0 break-all font-mono">{task.commitSha}</dd></div> : null}{task.sourceHash ? <div className="flex gap-3"><dt className="shrink-0 text-muted-foreground">快照哈希</dt><dd className="min-w-0 break-all font-mono">{task.sourceHash}</dd></div> : null}<div className="flex gap-3"><dt className="shrink-0 text-muted-foreground">最近更新</dt><dd><time dateTime={task.updatedAt}>{formatDate(task.updatedAt)}</time></dd></div></dl>
    {task.findingsSummary ? <div className="flex flex-wrap gap-2" aria-label="审查发现摘要">{Object.entries(task.findingsSummary).map(([key, count]) => <span key={key} className="rounded-md bg-muted px-2 py-1 text-xs">{key}：{count}</span>)}</div> : null}
    <div className="flex items-start gap-2 rounded-lg bg-muted/30 p-3 text-sm"><Mail className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden="true" /><div className="min-w-0 space-y-1"><p>{deliveryLabels[task.delivery.status]}</p>{task.delivery.email ? <p className="break-all text-xs text-muted-foreground">{task.delivery.email}</p> : null}{task.delivery.error ? <p className="text-xs text-destructive">{task.delivery.error}</p> : null}</div></div>
    <div className="flex flex-wrap gap-2">{reportUrl ? <Button asChild size="sm"><Link to={reportUrl}>阅读审查报告<ArrowUpRight /></Link></Button> : null}{active ? <Button variant="outline" size="sm" disabled={pending} onClick={() => onAction('cancel')}><X />取消审查</Button> : null}{task.status === 'failed' || task.status === 'cancelled' ? <Button variant="outline" size="sm" disabled={pending} onClick={() => onAction('retry')}><RefreshCw />重新审查</Button> : null}{task.delivery.status === 'failed' && task.reportId ? <Button variant="outline" size="sm" disabled={pending} onClick={() => onAction('delivery/retry')}><Mail />重试邮件</Button> : null}{pending ? <ContentLoading label="正在处理审查操作" variant="inline" /> : null}</div>
    <p className="text-xs leading-5 text-muted-foreground">本次采用静态与 AI 分析。报告会注明覆盖范围和待验证发现，审查结论不替代发布验收。</p>
  </article>;
}
