import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { ChevronLeft, ChevronRight, FileCode2, RefreshCw, Search } from 'lucide-react';
import { AppShell, Crumb, TopBar, Workspace } from '@/components/layout/AppShell';
import { Button } from '@/components/ui/button';
import { ContentLoading } from '@/components/skeletons/ContentLoading';
import { CodeReviewsSkeleton } from '@/components/skeletons/CodeReviewsSkeleton';
import { apiRequest } from '@/lib/api';
import { codeReviewAction, listCodeReviews, type CodeReviewTask } from '@/lib/codeReviews';
import { isReviewActive, latestReviewTasks, reviewCoverage, reviewPage, type ReviewFilter } from '@/lib/codeReviewView';
import { ReviewComposer, type ReviewCapabilities, type ReviewProjectOption } from './code-reviews/ReviewComposer';
import { ReviewMcpSetup } from './code-reviews/ReviewMcpSetup';
import { ReviewReportReader } from './code-reviews/ReviewReportReader';
import { ErrorNotice, TaskStatus, formatDate } from './code-reviews/ReviewTaskDetails';

export { ReviewDetail } from './code-reviews/ReviewTaskDetails';
export { buildCodeReviewDocument } from './code-reviews/ReportDocument';
const inputClass = 'h-9 rounded-md border border-input bg-[hsl(var(--surface-sunken))] px-3 text-base outline-none focus-visible:ring-2 focus-visible:ring-ring';

export function CodeReviewsPage(): JSX.Element {
  const [params, setParams] = useSearchParams();
  const projectFilter = params.get('project') || '';
  const selectedId = params.get('task') || '';
  const view = params.get('view') || '';
  const history = params.get('history') === '1';
  const [projects, setProjects] = useState<ReviewProjectOption[]>([]);
  const [capabilities, setCapabilities] = useState<ReviewCapabilities | null>(null);
  const [tasks, setTasks] = useState<CodeReviewTask[]>([]);
  const [setupLoading, setSetupLoading] = useState(true);
  const [setupError, setSetupError] = useState('');
  const [loading, setLoading] = useState(true);
  const [settled, setSettled] = useState(false);
  const [listError, setListError] = useState('');
  const [actionError, setActionError] = useState('');
  const [notice, setNotice] = useState('');
  const [pendingAction, setPendingAction] = useState('');
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<ReviewFilter>('all');
  const [page, setPage] = useState(0);
  const [refresh, setRefresh] = useState(0);
  const scope = useRef(projectFilter);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    const controller = new AbortController(); setSetupError('');
    void Promise.all([apiRequest<{ projects: ReviewProjectOption[] }>('/api/projects', { signal: controller.signal }),
      apiRequest<ReviewCapabilities>('/api/code-reviews/capabilities', { signal: controller.signal })])
      .then(([projectData, caps]) => { if (!controller.signal.aborted) { setProjects(projectData.projects); setCapabilities(caps); } })
      .catch(() => { if (!controller.signal.aborted) setSetupError('项目与审查服务信息暂时无法读取，请刷新重试。已有报告仍可查看。'); })
      .finally(() => { if (!controller.signal.aborted) setSetupLoading(false); });
    return () => controller.abort();
  }, [refresh]);
  useEffect(() => {
    const controller = new AbortController(); let timer: number | undefined;
    setLoading(true);
    if (scope.current !== projectFilter) { setTasks([]); scope.current = projectFilter; }
    const load = async (): Promise<void> => {
      try {
        const next = await listCodeReviews(projectFilter, controller.signal);
        if (controller.signal.aborted) return;
        setTasks(next); setListError('');
      } catch { if (!controller.signal.aborted) setListError('任务列表暂时无法刷新，已保留上次结果，请重试。'); }
      finally { if (!controller.signal.aborted) { setLoading(false); timer = window.setTimeout(() => { void load(); }, 4000); } }
    };
    void load(); return () => { controller.abort(); window.clearTimeout(timer); };
  }, [projectFilter, refresh]);
  useEffect(() => { if ((!setupLoading && !loading) || setupError || listError) setSettled(true); }, [setupLoading, loading, setupError, listError]);
  const scoped = useMemo(() => tasks.filter(task => !projectFilter || task.projectId === projectFilter), [tasks, projectFilter]);
  const overview = useMemo(() => latestReviewTasks(scoped), [scoped]);
  const visible = useMemo(() => reviewPage(history || query.trim() || filter !== 'all' ? scoped : overview, query, filter, page), [history, query, scoped, overview, filter, page]);
  const selected = scoped.find(task => task.id === selectedId);
  const navigateView = (value: string): void => {
    setActionError(''); setNotice('');
    setParams(current => { const next = new URLSearchParams(current); next.delete('task'); next.delete('report'); next.delete('issue'); if (value) next.set('view', value); else next.delete('view'); return next; });
  };
  const select = useCallback((task: CodeReviewTask): void => {
    setActionError('');
    setParams(current => { const next = new URLSearchParams(current); next.delete('view'); next.delete('issue'); next.set('project', task.projectId); next.set('task', task.id); if (task.reportId) next.set('report', '1'); else next.delete('report'); return next; });
  }, [setParams]);
  const back = (): void => navigateView('');
  const act = async (task: CodeReviewTask, action: 'cancel' | 'retry' | 'delivery/retry'): Promise<void> => {
    if (pendingAction) return; setPendingAction(task.id); setActionError('');
    try {
      const next = await codeReviewAction(task.id, action);
      if (!mounted.current) return;
      setTasks(current => current.map(item => item.id === next.id ? next : item)); setRefresh(n => n + 1);
      setNotice(action === 'cancel' ? '已请求取消审查。' : action === 'retry' ? '已提交重新审查。' : '已请求重试邮件，报告保持原样。');
    } catch { if (mounted.current) setActionError('操作未完成，请刷新任务状态后重试。'); }
    finally { if (mounted.current) setPendingAction(''); }
  };
  const saved = (task: CodeReviewTask): void => {
    setTasks(current => [task, ...current.filter(item => item.id !== task.id)]); select(task); setRefresh(n => n + 1);
    setNotice(task.sourceType === 'report' ? '原始报告已保存。' : '任务已提交，可离开页面，稍后回来查看结果。');
  };
  const projectName = (id: string): string => { const item = projects.find(p => p.id === id); return item?.aliasName || item?.name || id; };
  const topbar = <TopBar left={<Crumb items={[{ label: 'CDS', href: '/project-list' }, { label: '代码审查报告', href: selectedId || view ? `/code-reviews${projectFilter ? `?project=${encodeURIComponent(projectFilter)}` : ''}` : undefined },
    ...(selectedId ? [{ label: '阅读报告' }] : view ? [{ label: view === 'mcp' ? 'MCP 接入' : view === 'import' ? '导入报告' : '发起审查' }] : [])]} />}
    right={<Button variant="outline" disabled={loading} onClick={() => setRefresh(n => n + 1)}><RefreshCw />刷新</Button>} />;
  return <AppShell active="code-reviews" wide topbar={topbar}><Workspace fluid className="min-h-0 space-y-5 pb-8">
    {!settled ? <CodeReviewsSkeleton /> : <>
      {setupError ? <ErrorNotice message={setupError} /> : null}
      {notice ? <p role="status" className="rounded-md bg-muted/40 px-4 py-3 text-base">{notice}</p> : null}
      {actionError ? <ErrorNotice message={actionError} /> : null}
      {view === 'source' || view === 'import' ? <ReviewComposer key={`${view}:${projectFilter}`} mode={view === 'source' ? 'source' : 'import'} projects={projects} projectId={projectFilter} capabilities={capabilities} onBack={back} onSaved={saved} />
        : view === 'mcp' ? <ReviewMcpSetup capabilities={capabilities} onBack={back} />
        : selectedId ? selected ? <ReviewReportReader key={selected.id} task={selected} projectName={projectName(selected.projectId)} onBack={back} pending={Boolean(pendingAction)} onAction={action => { void act(selected, action); }} />
          : <div className="space-y-4"><ErrorNotice message={listError || '未找到这份审查，或当前账号没有访问权限。请返回列表重新选择。'} /><Button variant="outline" onClick={back}>返回列表</Button></div>
        : <>
          <header className="flex flex-wrap items-start justify-between gap-4"><div className="space-y-2"><h1 className="text-[1.75rem] font-semibold tracking-tight">代码审查</h1><p className="text-base text-muted-foreground">提交代码，查看进度，处理发现的问题。</p></div>
            <div className="flex flex-wrap gap-3"><Button variant="outline" onClick={() => navigateView('mcp')}>MCP 接入</Button><Button variant="outline" onClick={() => navigateView('import')}>导入报告</Button><Button onClick={() => navigateView('source')}>发起审查</Button></div></header>
          {listError ? <ErrorNotice message={listError} /> : null}
          <div className="flex flex-wrap items-center justify-between gap-3"><label className="relative block w-full sm:max-w-sm"><Search aria-hidden="true" className="absolute left-3 top-2.5 size-4 text-muted-foreground" /><span className="sr-only">搜索审查任务</span><input type="search" className={`${inputClass} w-full pl-9`} value={query} onChange={e => { setQuery(e.target.value); setPage(0); }} placeholder="搜索仓库、报告或提交" /></label>
            <div className="flex max-w-full flex-wrap gap-3"><select aria-label="筛选审查项目" className={`${inputClass} max-w-60`} value={projectFilter} onChange={e => { setPage(0); setParams(current => { const next = new URLSearchParams(current); if (e.target.value) next.set('project', e.target.value); else next.delete('project'); return next; }); }}><option value="">全部项目</option>{projects.map(item => <option key={item.id} value={item.id}>{item.aliasName || item.name}</option>)}</select>
              <select aria-label="筛选任务状态" className={inputClass} value={filter} onChange={e => { setFilter(e.target.value as ReviewFilter); setPage(0); }}><option value="all">全部状态</option><option value="active">处理中</option><option value="attention">需处理</option><option value="reports">已有审查报告</option><option value="archives">导入报告</option></select></div></div>
          {history ? <p className="text-base text-muted-foreground">执行记录包含历史批次与流程测试，各自保留原有范围，不能合并视为整仓完成。</p> : null}
          <div className="min-w-0 overflow-hidden rounded-lg border border-border bg-card">
            {loading && !scoped.length ? <ContentLoading label="正在读取审查记录" variant="rows" /> : visible.items.length ? <ReviewTaskList items={visible.items} selectedId="" projectName={projectName} onSelect={select} /> : <div className="space-y-3 px-6 py-12 text-center"><FileCode2 className="mx-auto size-7 text-muted-foreground" aria-hidden="true" /><h2 className="text-base font-medium">{scoped.length ? '没有匹配的记录' : '还没有代码审查记录'}</h2><p className="text-base text-muted-foreground">{scoped.length ? '调整状态或清空搜索后重试。' : '上传 ZIP 或提交 GitHub 地址，开始第一项审查。'}</p><Button variant="outline" onClick={() => { if (scoped.length) { setQuery(''); setFilter('all'); } else navigateView('source'); }}>{scoped.length ? '清空筛选' : '发起审查'}</Button></div>}
            <footer className="flex flex-wrap items-center justify-between gap-3 border-t border-border px-4 py-3 text-sm text-muted-foreground"><span>{visible.total} 条记录{loading ? ' · 正在刷新' : ''}{!history && !query && scoped.length > overview.length ? ` · 另有 ${scoped.length - overview.length} 条历史执行` : ''}</span>
              <div className="flex items-center gap-2">{visible.pages > 1 ? <><Button variant="ghost" aria-label="上一页任务" disabled={!visible.page} onClick={() => setPage(visible.page - 1)}><ChevronLeft /></Button><span>{visible.page + 1} / {visible.pages}</span><Button variant="ghost" aria-label="下一页任务" disabled={visible.page + 1 >= visible.pages} onClick={() => setPage(visible.page + 1)}><ChevronRight /></Button></> : null}<Button variant="outline" onClick={() => { setPage(0); setParams(current => { const next = new URLSearchParams(current); if (history) next.delete('history'); else next.set('history', '1'); return next; }); }}>{history ? '返回最近审查' : '执行记录'}</Button></div></footer>
          </div>
          <p className="text-sm leading-5 text-muted-foreground">已审范围内的问题可先处理；其余文件尚未完成审查。发现数来自工具输出，需结合证据核实。</p>
        </>}
    </>}
  </Workspace></AppShell>;
}

export function ReviewTaskList({ items, selectedId, projectName, onSelect }: { items: CodeReviewTask[]; selectedId: string; projectName: (id: string) => string; onSelect: (task: CodeReviewTask) => void }): JSX.Element {
  const columns = 'lg:grid-cols-[minmax(12rem,2fr)_minmax(7rem,1fr)_7rem_minmax(9rem,1.2fr)_8rem_9rem_7rem]';
  return <div><div aria-hidden="true" className={`hidden gap-4 bg-muted/40 px-4 py-3 text-sm text-muted-foreground lg:grid ${columns}`}>{['仓库与报告', '审查版本', '状态', '已审范围', '待验证发现', '更新时间', '操作'].map(label => <span key={label}>{label}</span>)}</div>
    <ul className="divide-y divide-border" aria-label="当前页审查任务">{items.map(task => {
      const coverage = reviewCoverage(task);
      const counts = task.findingsSummary;
      const findingCount = counts ? Object.values(counts).reduce((sum, n) => sum + n, 0) : undefined;
      return <li key={task.id} data-code-review-row><button type="button" onClick={() => onSelect(task)} aria-pressed={selectedId === task.id} className={`grid w-full min-w-0 grid-cols-2 gap-x-4 gap-y-3 px-4 py-4 text-left hover:bg-muted/30 ${columns} ${selectedId === task.id ? 'bg-muted/30' : ''}`}>
        <span className="col-span-2 min-w-0 space-y-1.5 lg:col-span-1"><span className="block truncate text-base font-medium">{task.title && task.title !== '代码审查报告' ? task.title : task.sourceName}</span><span className="block truncate text-sm text-muted-foreground">{projectName(task.projectId)} · {task.sourceType === 'report' ? '上传档案' : task.sourceType === 'cds' ? `CDS · ${task.branchName || '项目分支'}` : task.sourceType === 'github' ? 'GitHub 源码' : 'ZIP 源码'}</span></span>
        <span className="min-w-0 space-y-1.5"><span className="block truncate font-mono text-sm">{task.commitSha?.slice(0, 12) || task.sourceHash?.slice(0, 12) || '—'}</span><span className="block text-sm text-muted-foreground">{task.commitSha ? '固定提交' : task.sourceHash ? 'ZIP 哈希' : task.sourceType === 'report' ? '原始文档' : '等待固定快照'}</span></span>
        <span className="min-w-0 text-right lg:text-left"><TaskStatus task={task} />{isReviewActive(task) ? <span className="mt-1 block truncate text-sm text-muted-foreground">{task.phase}</span> : null}</span>
        <span className="col-span-2 min-w-0 space-y-1.5 lg:col-span-1"><span className="block text-base">{task.sourceType === 'report' ? '原文件保存' : task.progress.totalFiles > 0 ? `${task.progress.scannedFiles.toLocaleString()} / ${task.progress.totalFiles.toLocaleString()}` : '等待统计'}</span><span className="block text-sm text-muted-foreground">{coverage.kind === 'partial' ? '部分覆盖 · 尚未完成' : coverage.kind === 'counted' ? '本次文件范围' : coverage.kind === 'external' ? '未在 CDS 执行 AI 审查' : isReviewActive(task) ? '审查进行中' : '覆盖待核实'}</span></span>
        <span className="col-span-2 space-y-1.5 lg:col-span-1"><span className="block text-base">{findingCount === undefined ? '—' : `${findingCount} 项`}</span><span className="block text-sm text-muted-foreground">{findingCount === undefined ? '尚无结构化统计' : '工具输出 · 未验证'}</span></span>
        <span className="hidden space-y-1.5 text-sm lg:block"><span className="block">{formatDate(task.updatedAt)}</span><span className="block text-muted-foreground">上海时间</span></span>
        <span className="col-span-2 rounded-md border border-input px-3 py-2 text-center text-base text-primary lg:col-span-1 lg:border-0 lg:p-0 lg:text-left">{task.reportId ? '查看报告' : task.progress.scannedFiles > 0 ? '查看已审部分' : '查看进度'}</span>
      </button></li>;
    })}</ul></div>;
}
