import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { useSearchParams, Link } from 'react-router-dom';
import { marked } from 'marked';
import { ArrowLeft, ArrowUpRight, Check, ChevronLeft, ChevronRight, Download, FileArchive, FileCode2, GitBranch, Mail, Plus, RefreshCw, Search, SearchCode, Upload, X } from 'lucide-react';
import { AppShell, Crumb, TopBar, Workspace } from '@/components/layout/AppShell';
import { Button } from '@/components/ui/button';
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { ContentLoading } from '@/components/skeletons/ContentLoading';
import { CodeReviewsSkeleton } from '@/components/skeletons/CodeReviewsSkeleton';
import { apiRequest } from '@/lib/api';
import { useTheme } from '@/lib/theme';
import { codeReviewAction, codeReviewReportUrl, downloadCodeReviewReport, listCodeReviews, submitCodeReview, type CodeReviewTask } from '@/lib/codeReviews';

import { explainReviewError, isReviewActive, reviewCoverage, reviewPage, reviewTaskExplanation, reviewTaskLabel, selectReviewFocus, summarizeReviews, type ReviewFilter } from '@/lib/codeReviewView';

interface ProjectOption { id: string; name: string; aliasName?: string; }
interface Capabilities { engineConfigured: boolean; mailConfigured: boolean; }

const inputClass = 'h-9 w-full rounded-md border border-input bg-background px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring';
const deliveryLabels: Record<CodeReviewTask['delivery']['status'], string> = {
  not_requested: '仅报告中心', pending: '等待邮件投递', sending: '正在发送邮件', sent: '邮件已发送', failed: '邮件发送失败',
};
const isActive = isReviewActive;
const errorMessage = (error: unknown): string => error instanceof Error ? error.message : '请求失败，请稍后重试';

export function CodeReviewsPage(): JSX.Element {
  const [params, setParams] = useSearchParams();
  const projectFilter = params.get('project') || '';
  const selectedId = params.get('task') || '';
  const [composerOpen, setComposerOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<ReviewFilter>('all');
  const [page, setPage] = useState(0);
  const taskScope = useRef(projectFilter);
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
    if (taskScope.current !== projectFilter) { setTasks([]); taskScope.current = projectFilter; }
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
      setTasks((current) => [task, ...current.filter((item) => item.id !== task.id)]);
      setComposerOpen(false);
      setFile(null);
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
      setTasks((current) => current.some((item) => item.id === result.id) ? current.map((item) => item.id === result.id ? result : item) : [result, ...current]);
      selectTask(result);
      setRefresh((value) => value + 1);
      setNotice(action === 'delivery/retry' ? '已提交邮件重试，报告保持原样。' : action === 'cancel' ? '已请求取消审查。' : '已提交重新审查。');
    } catch (error) { if (mounted.current) setActionError(errorMessage(error)); }
    finally { if (mounted.current) setPendingAction(''); }
  };

  const scopedTasks = useMemo(() => tasks.filter((task) => !projectFilter || task.projectId === projectFilter), [tasks, projectFilter]);
  const summary = useMemo(() => summarizeReviews(scopedTasks), [scopedTasks]);
  const visible = useMemo(() => reviewPage(scopedTasks, query, filter, page), [scopedTasks, query, filter, page]);
  const selected = selectedId ? scopedTasks.find((task) => task.id === selectedId) : undefined;
  const focusedTask = selectReviewFocus(scopedTasks, selectedId);
  const reportMode = params.get('report') === '1';
  const projectName = (id: string): string => {
    const project = projects.find((item) => item.id === id);
    return project?.aliasName || project?.name || id;
  };
  const changeFilter = (value: ReviewFilter): void => { setFilter(value); setPage(0); };
  const returnToTasks = (): void => setParams((current) => { const next = new URLSearchParams(current); next.delete('report'); return next; });
  const topbar = <TopBar
    left={<Crumb items={[{ label: 'CDS', href: '/project-list' }, { label: '代码审查报告', href: reportMode ? '/code-reviews' : undefined }, ...(reportMode ? [{ label: '阅读报告' }] : [])]} />}
    right={<Button variant="outline" size="sm" onClick={() => setRefresh((value) => value + 1)} disabled={loading}><RefreshCw />刷新</Button>}
  />;
  const initialLoading = !initialSettled && !setupError && !listError;
  if (initialLoading) return <AppShell active="code-reviews" topbar={topbar}>
    <Workspace fluid><CodeReviewsSkeleton /></Workspace>
  </AppShell>;

  if (reportMode) return <AppShell active="code-reviews" wide topbar={topbar}>
    <Workspace wide className="min-h-0 pb-6">
      {selected?.reportId ? <ReviewReportReader key={selected.id} task={selected} onBack={returnToTasks} /> : <div className="space-y-4 rounded-xl border border-border bg-card p-6">
        <h1 className="text-lg font-semibold">这份报告暂时无法打开</h1>
        <p className="text-sm text-muted-foreground">报告可能尚未归档，或当前账号没有访问权限。返回任务列表查看最新状态。</p>
        {listError ? <ErrorNotice message={listError} /> : null}
        <Button variant="outline" onClick={returnToTasks}><ArrowLeft />返回任务</Button>
      </div>}
    </Workspace>
  </AppShell>;

  const filters: Array<{ value: ReviewFilter; label: string; count: number }> = [
    { value: 'all', label: '全部', count: scopedTasks.length },
    { value: 'active', label: '处理中', count: summary.active },
    { value: 'attention', label: '需处理', count: summary.attention },
    { value: 'reports', label: '审查报告', count: summary.reports },
    { value: 'archives', label: '上传归档', count: summary.archives },
  ];
  return <AppShell active="code-reviews" wide topbar={topbar}>
    <Workspace wide className="min-h-0 space-y-5 pb-8">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0 space-y-1.5">
          <h1 className="text-2xl font-semibold tracking-tight">整仓审查</h1>
          <p className="max-w-3xl text-sm leading-6 text-muted-foreground">一次提交完整仓库，跟踪本次审查并阅读报告。实际覆盖范围以报告为准，所有发现均需人工核实。</p>
        </div>
        <Button onClick={() => { setActionError(''); setComposerOpen(true); }} disabled={submitting}><Plus />发起整仓审查</Button>
      </header>
      {setupError ? <ErrorNotice message={setupError} title="审查配置读取失败" /> : null}
      {capabilities && !capabilities.engineConfigured ? <div role="status" className="rounded-lg border border-border bg-muted/40 p-3 text-sm">审查服务尚未接入，暂时无法发起新任务。已有报告仍可查阅，请管理员检查连接配置。</div> : null}
      {notice ? <div role="status" className="flex items-start gap-2 rounded-lg border border-border bg-muted/30 p-3 text-sm"><Check className="mt-0.5 size-4 shrink-0" aria-hidden="true" />{notice}</div> : null}
      {!composerOpen && actionError ? <ErrorNotice message={actionError} /> : null}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-base font-semibold">{selectedId ? '所选记录' : '最新审查'}</h2>
        <label className="flex min-w-0 items-center gap-2 text-sm"><span className="shrink-0 whitespace-nowrap text-muted-foreground">项目</span><select aria-label="筛选审查项目" value={projectFilter} className={`${inputClass} max-w-60`} onChange={(event) => { setPage(0); const next = new URLSearchParams(); if (event.target.value) next.set('project', event.target.value); setParams(next); }}><option value="">全部可访问项目</option>{projects.map((project) => <option key={project.id} value={project.id}>{project.aliasName || project.name}</option>)}</select></label>
      </div>
      {listError ? <ErrorNotice message={listError} title="任务列表刷新失败，当前保留上次结果" /> : null}
      {!loading && !listError && selectedId && !selected ? <ErrorNotice message="未找到该审查任务，或当前账号没有访问权限。" title="无法打开所选任务" /> : null}
      {focusedTask ? <ReviewDetail task={focusedTask} now={now} pending={Boolean(pendingAction)} onAction={(action) => { void act(focusedTask, action); }} /> : !selectedId ? <div className="rounded-xl border border-border bg-card p-6 text-sm leading-6 text-muted-foreground">还没有源码审查记录。上传完整仓库 ZIP，或提交 GitHub 仓库地址，即可开始。上传的外部报告可在历史记录中查看。</div> : null}
      <details className="rounded-xl border border-border bg-card">
        <summary id="review-history-heading" className="cursor-pointer px-5 py-4 text-sm font-medium">历史记录<span className="ml-2 text-xs font-normal text-muted-foreground">{scopedTasks.length} 项执行记录与报告</span></summary>
        <section aria-labelledby="review-history-heading" className="space-y-3 border-t border-border p-4">
          <p className="text-xs leading-5 text-muted-foreground">包含早期手工拆分的执行记录。每项保留原有进度和报告，未合并为一次整仓审查；这些记录可能尚未完成。</p>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex max-w-full flex-wrap gap-1" role="group" aria-label="筛选任务状态">{filters.map((item) => <button key={item.value} type="button" aria-pressed={filter === item.value} onClick={() => changeFilter(item.value)} className={`rounded-md px-3 py-1.5 text-xs font-medium ${filter === item.value ? 'bg-secondary text-secondary-foreground' : 'text-muted-foreground hover:bg-muted/50'}`}>{item.label}<span className="ml-1.5 tabular-nums opacity-70">{item.count}</span></button>)}</div>
          <label className="relative block min-w-0 flex-1 sm:max-w-xs"><Search className="pointer-events-none absolute left-3 top-2.5 size-4 text-muted-foreground" aria-hidden="true" /><span className="sr-only">搜索审查任务</span><input type="search" value={query} onChange={(event) => { setQuery(event.target.value); setPage(0); }} placeholder="搜索名称、来源或任务编号" className={`${inputClass} pl-9`} /></label>
        </div>
        <div>
          <div className="min-w-0 overflow-hidden rounded-xl border border-border bg-card">
            {loading && scopedTasks.length === 0 ? <ContentLoading label="正在读取审查任务" variant="rows" /> : visible.items.length ? <ReviewTaskList items={visible.items} selectedId={focusedTask?.id || ''} projectName={projectName} onSelect={selectTask} /> : <div className="px-6 py-10 text-center">
              <FileCode2 className="mx-auto mb-3 size-7 text-muted-foreground" aria-hidden="true" />
              <h3 className="text-sm font-medium">{scopedTasks.length ? '没有匹配的任务' : '还没有代码审查任务'}</h3>
              <p className="mt-2 text-sm text-muted-foreground">{scopedTasks.length ? '试试其他状态，或清空搜索条件。' : '上传 ZIP 或提交 GitHub 地址，开始第一项审查。'}</p>
              {scopedTasks.length ? <Button variant="outline" className="mt-4" onClick={() => { setQuery(''); changeFilter('all'); }}>清空筛选</Button> : <Button variant="outline" className="mt-4" onClick={() => setComposerOpen(true)}>发起审查</Button>}
            </div>}
            <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border px-4 py-3 text-xs text-muted-foreground">
              <span>{visible.total} 项匹配 · 每页最多 20 项{loading && scopedTasks.length ? ' · 正在刷新' : ''}</span>
              <div className="flex items-center gap-2"><Button variant="ghost" size="sm" aria-label="上一页任务" disabled={visible.page === 0} onClick={() => setPage(visible.page - 1)}><ChevronLeft /></Button><span className="tabular-nums">{visible.page + 1} / {visible.pages}</span><Button variant="ghost" size="sm" aria-label="下一页任务" disabled={visible.page + 1 >= visible.pages} onClick={() => setPage(visible.page + 1)}><ChevronRight /></Button></div>
            </div>
          </div>
        </div>
        </section>
      </details>
      <Dialog open={composerOpen} onOpenChange={(open) => { setComposerOpen(open); if (!open && !submitting) setFile(null); }}>
        <DialogContent frame className="max-w-2xl" style={{ width: 'min(42rem, calc(100vw - 2rem))', maxHeight: '90vh', animation: 'none' }}>
          <DialogHeader className="shrink-0 border-b border-border px-5 py-4"><DialogTitle>发起整仓审查</DialogTitle><DialogDescription>一次提交完整仓库，由同一个审查任务处理，无需手工拆分 ZIP。报告会保存到报告中心。</DialogDescription></DialogHeader>
          <form onSubmit={(event) => { void submit(event); }} className="flex min-h-0 flex-1 flex-col" aria-busy={submitting}>
            <DialogBody className="space-y-4">
              <p className="text-xs leading-5 text-muted-foreground">依赖目录、超大文件和不支持的文件会在报告覆盖说明中列出。提交整仓不表示每个文件均已分析，所有发现均需人工核实。</p>
              {actionError ? <ErrorNotice message={actionError} /> : null}
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
            </DialogBody>
            <DialogFooter className="shrink-0 items-center gap-3 border-t border-border px-5 py-4">
              {submitting ? <ContentLoading label="正在提交代码审查" variant="inline" /> : <span className="mr-auto text-xs text-muted-foreground">可离开页面，稍后回来查看结果。</span>}
              <Button type="submit" disabled={submitting || !projectId || !capabilities?.engineConfigured}><SearchCode />{submitting ? '正在上传并创建任务' : '开始审查'}</Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </Workspace>
  </AppShell>;
}

export function ReviewTaskList({ items, selectedId, projectName, onSelect }: {
  items: CodeReviewTask[]; selectedId: string; projectName: (id: string) => string; onSelect: (task: CodeReviewTask) => void;
}): JSX.Element {
  return <ul className="divide-y divide-border" aria-label="当前页审查任务">{items.map((task) => <li key={task.id} data-code-review-row>
    <button type="button" onClick={() => onSelect(task)} aria-pressed={selectedId === task.id} className={`flex w-full min-w-0 items-start gap-3 px-4 py-3 text-left transition-colors hover:bg-muted/50 ${selectedId === task.id ? 'bg-muted/50' : ''}`}>
      <div className="min-w-0 flex-1"><h3 className="truncate text-sm font-medium">{task.title || task.sourceName}</h3><p className="mt-1 truncate text-xs text-muted-foreground">{projectName(task.projectId)} · {task.sourceType === 'report' ? '上传档案' : task.sourceType === 'github' ? 'GitHub' : 'ZIP'} · {task.sourceName}</p></div>
      <div className="min-w-0 shrink-0 text-right"><TaskStatus task={task} /><p className="mt-1 text-xs text-muted-foreground">{formatDate(task.createdAt)}</p></div>
    </button>
  </li>)}</ul>;
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
    {task.sourceType === 'report' || ['partial', 'unknown'].includes(reviewCoverage(task).kind) ? <div role="status" className="border-b border-border bg-muted/30 px-4 py-3 text-sm leading-6">{reviewTaskExplanation(task)}</div> : null}
    {error ? <div className="space-y-3 p-4"><ErrorNotice message={`报告正文读取失败：${error}`} /><Button variant="outline" onClick={() => setAttempt((value) => value + 1)}>重新加载报告</Button></div> : payload ? <iframe title={payload.report.title} srcDoc={html} sandbox="" className="h-[42rem] w-full border-0" /> : <ContentLoading label="正在读取审查报告正文" variant="panel" />}
  </section>;
}

export function buildCodeReviewDocument(content: string, format: 'html' | 'md', theme: 'dark' | 'light'): string {
  // Reports are untrusted; the opaque iframe and CSP forbid scripts, external
  // requests and navigation regardless of embedded HTML or Markdown content.
  const csp = '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'unsafe-inline\'; img-src data:; form-action \'none\'; base-uri \'none\'">';
  const style = `<style>:root{color-scheme:${theme}}*{box-sizing:border-box}body{background:Canvas;color:CanvasText;font:.9375rem/1.75 system-ui,sans-serif;margin:0 auto;max-width:68rem;padding:1.5rem clamp(1rem,4vw,3rem);overflow-wrap:anywhere}h1,h2,h3{line-height:1.4;letter-spacing:-.02em}h1{font-size:1.75rem;margin:0 0 1.25rem}h2{font-size:1.25rem;margin:2rem 0 .75rem;padding-bottom:.5rem;border-bottom:1px solid color-mix(in srgb,CanvasText 15%,Canvas)}h3{font-size:1.0625rem;margin:1.5rem 0 .5rem}p,ul,ol{max-width:80ch}pre{padding:1rem;background:color-mix(in srgb,CanvasText 7%,Canvas);overflow:auto;border-radius:.5rem}code{font:.875em/1.6 ui-monospace,SFMono-Regular,monospace}table{display:block;max-width:100%;overflow:auto;border-collapse:collapse;font-size:.875rem}td,th{padding:.625rem .75rem;border:1px solid color-mix(in srgb,CanvasText 20%,Canvas);text-align:left;vertical-align:top}th{background:color-mix(in srgb,CanvasText 5%,Canvas)}img{max-width:100%;height:auto}a{color:LinkText}details{margin:1rem 0;padding:.75rem 1rem;border:1px solid color-mix(in srgb,CanvasText 15%,Canvas);border-radius:.5rem}summary{cursor:pointer;font-weight:600}</style>`;
  if (format === 'html') return `${csp}${style}${content}`;
  return `<!doctype html><html><head><meta charset="utf-8">${csp}${style}</head><body>${marked.parse(content, { async: false })}</body></html>`;
}

function ErrorNotice({ message, title }: { message: string; title?: string }): JSX.Element {
  const explained = explainReviewError(message);
  return <div role="alert" className="rounded-lg border border-destructive/25 bg-destructive/5 p-3 text-sm">
    <p className="font-medium text-destructive">{title || explained.title}</p>
    <p className="mt-1 text-xs leading-5 text-muted-foreground">{explained.next}</p>
    <details className="mt-2 text-xs"><summary className="cursor-pointer text-muted-foreground">技术详情</summary><pre className="mt-2 whitespace-pre-wrap break-all rounded-md bg-muted/50 p-2 font-mono">{message}</pre></details>
  </div>;
}

function TaskStatus({ task }: { task: CodeReviewTask }): JSX.Element {
  const view = reviewTaskLabel(task);
  const tone = view.tone === 'error' ? 'border-destructive/30 bg-destructive/5 text-destructive' : view.tone === 'warning' ? 'border-warn/30 bg-warn-soft text-warn' : 'border-border text-muted-foreground';
  return <span className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs ${tone}`}>{isActive(task) ? <span className="size-1.5 animate-pulse rounded-full bg-current" aria-hidden="true" /> : null}{view.label}</span>;
}

function formatDate(value: string): string {
  return new Date(value).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}

const findingLabels: Record<string, string> = { critical: '严重', high: '高风险', medium: '中风险', low: '低风险', info: '提示', p0: '阻断', p1: '高优先级', p2: '一般', p3: '建议' };
export function ReviewDetail({ task, now, pending, onAction, onClose }: {
  task: CodeReviewTask; now: number; pending: boolean; onAction: (action: 'cancel' | 'retry' | 'delivery/retry') => void; onClose?: () => void;
}): JSX.Element {
  const reportUrl = codeReviewReportUrl(task);
  const active = isActive(task);
  const coverage = reviewCoverage(task);
  const percent = task.progress.totalFiles > 0 && task.progress.scannedFiles <= task.progress.totalFiles ? Math.round(task.progress.scannedFiles / task.progress.totalFiles * 100) : undefined;
  const elapsed = Math.max(0, Math.floor((now - new Date(task.createdAt).getTime()) / 1000));
  return <article aria-label="审查任务详情" className="min-w-0 space-y-4 rounded-xl border border-border bg-card p-5">
    <div className="flex items-start justify-between gap-3"><div className="min-w-0 space-y-2"><TaskStatus task={task} /><h3 className="break-words text-base font-semibold leading-6">{task.title || task.sourceName}</h3></div>{onClose ? <Button variant="ghost" size="icon" aria-label="关闭任务详情" onClick={onClose}><X /></Button> : null}</div>
    <p className="text-sm leading-6">{reviewTaskExplanation(task)}</p>
    {task.sourceType !== 'report' ? <div aria-live="polite" className={`space-y-2 rounded-lg p-3 ${coverage.kind === 'partial' || coverage.kind === 'unknown' ? 'bg-warn-soft' : 'bg-muted/30'}`}>
      <p className="text-sm font-medium">{coverage.text}</p>
      {active ? <><progress className="h-2 w-full accent-primary" aria-label="审查文件进度" max={100} value={percent} /><p className="text-xs text-muted-foreground">创建后 {Math.floor(elapsed / 60)} 分 {elapsed % 60} 秒 · 排队时间也包含在内</p></> : null}
      {task.inputSkippedFiles ? <p className="text-xs leading-5 text-muted-foreground">另有 {task.inputSkippedFiles} 项未纳入本次分析，请在报告中核对跳过原因。</p> : null}
    </div> : null}
    {task.error ? <ErrorNotice message={task.error} title="本次审查失败" /> : null}
    {task.findingsSummary && Object.keys(task.findingsSummary).length ? <div><h4 className="mb-2 text-xs font-medium text-muted-foreground">报告中的发现</h4><div className="flex flex-wrap gap-2">{Object.entries(task.findingsSummary).map(([key, count]) => <span key={key} className="rounded-md bg-muted px-2 py-1 text-xs">{findingLabels[key] || key}：{count}</span>)}</div><p className="mt-2 text-xs text-muted-foreground">发现数为工具输出，需结合报告中的证据核实。</p></div> : null}
    <div className="flex flex-wrap gap-2">{reportUrl ? <Button asChild size="sm"><Link to={reportUrl}>{task.sourceType === 'report' ? '阅读上传档案' : '阅读审查报告'}<ArrowUpRight /></Link></Button> : null}{active ? <Button variant="outline" size="sm" disabled={pending} onClick={() => onAction('cancel')}><X />取消审查</Button> : null}{task.sourceType !== 'report' && (task.status === 'failed' || task.status === 'cancelled') ? <Button variant="outline" size="sm" disabled={pending} onClick={() => onAction('retry')}><RefreshCw />重新审查</Button> : null}{task.delivery.status === 'failed' && task.reportId ? <Button variant="outline" size="sm" disabled={pending} onClick={() => onAction('delivery/retry')}><Mail />重试邮件</Button> : null}{pending ? <ContentLoading label="正在处理审查操作" variant="inline" /> : null}</div>
    {task.delivery.status !== 'not_requested' ? <div className="rounded-lg border border-border p-3 text-xs"><p className="font-medium">{deliveryLabels[task.delivery.status]}</p>{task.delivery.email ? <p className="mt-1 break-all text-muted-foreground">{task.delivery.email}</p> : null}{task.delivery.error ? <div className="mt-2"><ErrorNotice message={task.delivery.error} title="报告已保存，邮件尚未送达" /></div> : null}</div> : null}
    <details className="border-t border-border pt-3 text-xs"><summary className="cursor-pointer text-muted-foreground">任务与技术详情</summary><dl className="mt-3 space-y-2"><div><dt className="text-muted-foreground">来源</dt><dd className="mt-1 break-all">{task.sourceName}</dd></div><div><dt className="text-muted-foreground">任务编号</dt><dd className="mt-1 break-all font-mono">{task.id}</dd></div><div><dt className="text-muted-foreground">原始阶段</dt><dd className="mt-1 break-all">{task.phase}</dd></div>{task.commitSha ? <div><dt className="text-muted-foreground">固定提交</dt><dd className="mt-1 break-all font-mono">{task.commitSha}</dd></div> : null}{task.sourceHash ? <div><dt className="text-muted-foreground">快照哈希</dt><dd className="mt-1 break-all font-mono">{task.sourceHash}</dd></div> : null}<div><dt className="text-muted-foreground">最近更新</dt><dd className="mt-1">{formatDate(task.updatedAt)}</dd></div></dl></details>
  </article>;
}
