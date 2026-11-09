import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { Archive, ChevronLeft, ChevronRight, GitBranch, MoreHorizontal, Plug, Plus, RefreshCw, Search } from 'lucide-react';
import { AppShell, Crumb, TopBar, Workspace } from '@/components/layout/AppShell';
import { CodeReviewsSkeleton } from '@/components/skeletons/CodeReviewsSkeleton';
import { apiRequest } from '@/lib/api';
import { codeReviewAction, getCodeReviewTask, listCodeReviewPage, type CodeReviewTask, type CodeReviewTaskPage, type ReviewListSource, type ReviewListStatus } from '@/lib/codeReviews';
import { isReviewActive, reviewCoverage } from '@/lib/codeReviewView';
import { REVIEW_LIST_SOURCES, REVIEW_LIST_STATUSES } from '../../../src/shared/code-review-list';
import { ReviewComposer, type ReviewCapabilities, type ReviewProjectOption } from './code-reviews/ReviewComposer';
import { ReviewMcpSetup } from './code-reviews/ReviewMcpSetup';
import { ReviewReportReader } from './code-reviews/ReviewReportReader';
import { ErrorNotice, TaskStatus, formatDate } from './code-reviews/ReviewTaskDetails';
import { ReviewButton, ReviewEmpty, ReviewPagination } from './code-reviews/ReviewUi';
import './code-reviews/review-design.css';

export { ReviewDetail } from './code-reviews/ReviewTaskDetails';
export { buildCodeReviewDocument } from './code-reviews/ReportDocument';
interface ReturnPosition { scroll: number; focusTaskId: string; snapshotAt?: string }
interface ReviewLocationState { reviewFromList?: boolean; reviewRestore?: ReturnPosition }
const mainElement = () => document.querySelector<HTMLElement>('.cds-main');
const positivePage = (raw: string | null) => { const n = Number(raw || 1); return Number.isSafeInteger(n) && n > 0 ? n - 1 : 0; };
const sourceLabels = { source: '源码审查', report: '导入文档', all: '全部' } as const;

export function CodeReviewsPage(): JSX.Element {
  const [params, setParams] = useSearchParams();
  const location = useLocation(), navigate = useNavigate();
  const locationState = location.state as ReviewLocationState | null;
  const projectId = params.get('project') || '', selectedId = params.get('task') || '', view = params.get('view') || '';
  const history = params.get('history') === '1';
  const source = REVIEW_LIST_SOURCES.includes(params.get('source') as ReviewListSource) ? params.get('source') as ReviewListSource : 'source';
  const status = REVIEW_LIST_STATUSES.includes(params.get('status') as ReviewListStatus) ? params.get('status') as ReviewListStatus : 'all';
  const query = params.get('q') || '', page = positivePage(params.get('page'));
  const [projects, setProjects] = useState<ReviewProjectOption[]>([]), [capabilities, setCapabilities] = useState<ReviewCapabilities | null>(null);
  const [data, setData] = useState<CodeReviewTaskPage | null>(null), [selected, setSelected] = useState<CodeReviewTask | null>(null);
  const [setupError, setSetupError] = useState(''), [listError, setListError] = useState(''), [actionError, setActionError] = useState('');
  const [notice, setNotice] = useState(''), [pending, setPending] = useState(false), [loading, setLoading] = useState(true);
  const [search, setSearch] = useState(query), [refresh, setRefresh] = useState(0);
  const requestScope = useMemo(() => JSON.stringify({ projectId, source, status, query, page, history }), [projectId, source, status, query, page, history]);
  const cutoff = useRef<{ scope: string; snapshotAt?: string }>({ scope: requestScope, snapshotAt: locationState?.reviewRestore?.snapshotAt });
  const alive = useRef(true), restored = useRef('');
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => {
    const controller = new AbortController(); setSetupError('');
    void Promise.all([apiRequest<{ projects: ReviewProjectOption[] }>('/api/projects', { signal: controller.signal }), apiRequest<ReviewCapabilities>('/api/code-reviews/capabilities', { signal: controller.signal })])
      .then(([result, caps]) => { if (!controller.signal.aborted) { setProjects(result.projects); setCapabilities(caps); } })
      .catch(() => { if (!controller.signal.aborted) setSetupError('项目与服务信息暂时无法读取，已有报告仍可查看。'); });
    return () => controller.abort();
  }, [refresh]);
  useEffect(() => { setSearch(query); }, [query]);
  const updateList = useCallback((changes: Record<string, string | undefined>) => {
    cutoff.current = { scope: '' }; mainElement()?.scrollTo({ top: 0 });
    setParams(current => { const next = new URLSearchParams(current); for (const [key, value] of Object.entries(changes)) { if (value) next.set(key, value); else next.delete(key); } if (!Object.hasOwn(changes, 'page')) next.delete('page'); return next; }, { replace: true, state: null });
  }, [setParams]);
  useEffect(() => {
    if (search === query || view || selectedId) return;
    const timer = window.setTimeout(() => updateList({ q: search || undefined }), 250);
    return () => window.clearTimeout(timer);
  }, [search, query, view, selectedId, updateList]);
  useEffect(() => {
    const controller = new AbortController(); let timer: number | undefined;
    if (view) { setLoading(false); return; }
    setLoading(true); setListError('');
    if (selectedId) setSelected(current => current?.id === selectedId ? current : null);
    else if (cutoff.current.scope !== requestScope) {
      cutoff.current = { scope: requestScope, snapshotAt: locationState?.reviewRestore?.snapshotAt }; setData(null);
    }
    const load = async (): Promise<void> => {
      try {
        if (selectedId) {
          const task = await getCodeReviewTask(selectedId, controller.signal);
          if (!controller.signal.aborted) setSelected(task);
        } else {
          const result = await listCodeReviewPage({ projectId, source, status, query, page, history, snapshotAt: cutoff.current.snapshotAt }, controller.signal);
          if (!controller.signal.aborted) { cutoff.current = { scope: requestScope, snapshotAt: result.snapshotAt }; setData(result); }
        }
        if (!controller.signal.aborted) setListError('');
      } catch { if (!controller.signal.aborted) setListError(selectedId ? '任务暂时无法读取，或当前账号没有访问权限。' : '任务列表暂时无法刷新，已保留上次结果。'); }
      finally { if (!controller.signal.aborted) { setLoading(false); timer = window.setTimeout(() => { void load(); }, 4000); } }
    };
    void load(); return () => { controller.abort(); window.clearTimeout(timer); };
  }, [requestScope, selectedId, view, refresh]); // requestScope binds the serialized list inputs.
  useEffect(() => {
    const restore = locationState?.reviewRestore;
    if (view || selectedId || loading || !data || !restore || restored.current === location.key) return;
    const frame = requestAnimationFrame(() => {
      mainElement()?.scrollTo({ top: restore.scroll });
      const desktop = document.getElementById(`review-record-${restore.focusTaskId}`);
      const target = desktop?.getClientRects().length ? desktop : document.getElementById(`review-mobile-record-${restore.focusTaskId}`);
      target?.focus({ preventScroll: true });
      restored.current = location.key;
    });
    return () => cancelAnimationFrame(frame);
  }, [location.key, locationState, view, selectedId, loading, data]);
  const rememberList = (focusTaskId = ''): void => {
    if (view || selectedId) return;
    navigate({ pathname: location.pathname, search: location.search }, { replace: true, state: { reviewRestore: { scroll: mainElement()?.scrollTop || 0, focusTaskId, snapshotAt: cutoff.current.snapshotAt } } satisfies ReviewLocationState });
  };
  const navigateView = (nextView: string): void => {
    rememberList(); setNotice(''); setActionError('');
    setParams(current => { const next = new URLSearchParams(current); next.delete('task'); next.delete('report'); next.delete('issue'); next.delete('tab'); next.set('view', nextView); return next; }, { state: { reviewFromList: !selectedId && !view || locationState?.reviewFromList } });
  };
  const select = (task: CodeReviewTask, saved = false): void => {
    rememberList(task.id); setActionError('');
    setParams(current => { const next = new URLSearchParams(current); next.delete('view'); next.delete('issue'); next.delete('tab'); next.set('task', task.id); if (task.reportId) next.set('report', '1'); else next.delete('report'); return next; }, { replace: saved, state: { reviewFromList: !view && !selectedId || locationState?.reviewFromList } });
  };
  const back = (): void => {
    setActionError(''); setNotice('');
    if (locationState?.reviewFromList) { navigate(-1); return; }
    setParams(current => { const next = new URLSearchParams(current); for (const key of ['task', 'report', 'issue', 'tab', 'view', 'severity', 'rq', 'issuePage', 'issueEdge']) next.delete(key); return next; }, { replace: true });
  };
  const act = async (task: CodeReviewTask, action: 'cancel' | 'retry' | 'delivery/retry'): Promise<void> => {
    if (pending) return; setPending(true); setActionError('');
    try {
      const next = await codeReviewAction(task.id, action);
      if (!alive.current) return;
      setSelected(next); setRefresh(n => n + 1);
      setNotice(action === 'cancel' ? '已请求取消审查。' : action === 'retry' ? '已提交重试，继续跟踪原任务。' : '已请求重试邮件，审查结果保持原样。');
    } catch { if (alive.current) setActionError('操作未完成，请检查当前任务状态后重试。'); }
    finally { if (alive.current) setPending(false); }
  };
  const projectName = (id: string): string => { const project = projects.find(p => p.id === id); return project?.aliasName || project?.name || id; };
  const requestRefresh = (): void => { setRefresh(n => n + 1); };
  const topbar = <TopBar left={<>{selectedId || view ? <button type="button" className="cr-topbar-back" aria-label="返回审查列表" onClick={back}><ChevronLeft /></button> : null}<Crumb items={[{ label: 'CDS', href: '/project-list' }, { label: '代码审查', href: selectedId || view ? '/code-reviews' : undefined }, ...(selectedId ? [{ label: selected?.title || '阅读报告' }] : view ? [{ label: view === 'mcp' ? 'MCP 接入' : view === 'import' ? '导入报告' : '发起审查' }] : [])]} /></>} right={<ReviewButton tone="ghost" disabled={loading} onClick={requestRefresh}><RefreshCw />刷新</ReviewButton>} />;
  const rowHref = (task: CodeReviewTask): string => { const next = new URLSearchParams(params); next.set('task', task.id); return `/code-reviews?${next}`; };
  if (!view && !selectedId && !data && loading) return <AppShell active="code-reviews" wide topbar={topbar}><Workspace fluid className="cr-ui"><CodeReviewsSkeleton /></Workspace></AppShell>;
  return <AppShell active="code-reviews" wide topbar={topbar}><Workspace fluid className="cr-ui"><div className="cr-stack cr-fade">
    {setupError ? <ErrorNotice message={setupError} /> : null}{notice ? <p role="status" className="cr-notice">{notice}</p> : null}{actionError ? <ErrorNotice message={actionError} /> : null}
    {view === 'source' || view === 'import' ? <ReviewComposer key={`${view}:${projectId}`} mode={view === 'source' ? 'source' : 'import'} projects={projects} projectId={projectId} capabilities={capabilities} onBack={back} onSaved={task => { setSelected(task); cutoff.current = { scope: '' }; select(task, true); setNotice(task.sourceType === 'report' ? '文档已保存。' : '任务已提交，可在此继续查看进度。'); }} />
      : view === 'mcp' ? <ReviewMcpSetup capabilities={capabilities} onBack={back} />
      : selectedId ? selected ? <ReviewReportReader key={selected.id} task={selected} projectName={projectName(selected.projectId)} onBack={back} pending={pending} onAction={action => { void act(selected, action); }} />
        : listError ? <div className="cr-stack"><ErrorNotice message={listError} /><ReviewButton onClick={back}>返回审查列表</ReviewButton></div> : <CodeReviewsSkeleton />
      : <>
        <header className="cr-page-header"><div><h1>代码审查</h1><p className="cr-subtitle">发现均为待验证结果；“已完成”只表示本次范围执行完毕，不代表代码质量通过。</p></div><div className="cr-page-actions">
          <span className="cr-desktop"><ReviewButton tone="ghost" onClick={() => navigateView('mcp')}><Plug />MCP 接入</ReviewButton></span>
          <span className="cr-desktop"><ReviewButton onClick={() => navigateView('import')}>导入报告</ReviewButton></span>
          <ReviewButton tone="primary" onClick={() => navigateView('source')}><Plus />发起审查</ReviewButton>
          <details className="cr-mobile"><summary className="cr-button cr-icon-button" aria-label="更多审查操作"><MoreHorizontal /></summary><div className="cr-overflow-menu"><ReviewButton tone="ghost" onClick={() => navigateView('import')}>导入报告</ReviewButton><ReviewButton tone="ghost" onClick={() => navigateView('mcp')}>MCP 接入</ReviewButton></div></details>
        </div></header>
        <div className="cr-filters"><div className="cr-segment" role="group" aria-label="记录来源">{REVIEW_LIST_SOURCES.map(key => <button type="button" key={key} aria-pressed={source === key} onClick={() => updateList({ source: key })}>{sourceLabels[key]}{data ? <span className="cr-muted cr-num">{data.totals[key]}</span> : null}</button>)}</div><span className="cr-filter-divider cr-desktop" aria-hidden="true" />
          <select aria-label="筛选审查项目" className="cr-input cr-filter-project" value={projectId} onChange={e => updateList({ project: e.target.value || undefined })}><option value="">全部项目</option>{projects.map(p => <option key={p.id} value={p.id}>{p.aliasName || p.name}</option>)}</select>
          <select aria-label="筛选任务状态" className="cr-input cr-filter-state" value={status} onChange={e => updateList({ status: e.target.value })}><option value="all">全部状态</option><option value="active">处理中</option><option value="partial">部分覆盖</option><option value="attention">需处理</option><option value="completed">已完成 / 已保存</option><option value="failed">失败</option><option value="cancelled">已取消</option><option value="queued">排队中</option></select>
          <label className="cr-search cr-filter-query"><Search aria-hidden="true" /><span className="sr-only">搜索审查任务</span><input type="search" className="cr-input" value={search} onChange={e => setSearch(e.target.value)} placeholder="搜索报告、分支、SHA" maxLength={300} /></label>
          <ReviewButton tone="ghost" className="cr-end" onClick={() => updateList({ history: history ? undefined : '1' })}>{history ? '最近审查' : '执行记录'}</ReviewButton>
        </div>
        {listError ? <div className="cr-row-inline"><ErrorNotice message={listError} /><ReviewButton onClick={requestRefresh}>重试读取</ReviewButton></div> : null}
        {data?.newCount ? <div className="cr-notice cr-row-inline" role="status">有 {data.newCount} 条新记录<ReviewButton tone="ghost" onClick={() => { cutoff.current = { scope: requestScope }; updateList({ page: '1' }); requestRefresh(); }}>显示</ReviewButton></div> : null}
        {history ? <p className="cr-form-note">历史执行保留各自的源码范围，不能将不同批次相加视为整仓完成。</p> : null}
        {!data && loading ? <CodeReviewsSkeleton /> : <div className="cr-surface">
          {data?.tasks.length ? <ReviewTaskList items={data.tasks} selectedId="" projectName={projectName} onSelect={task => select(task)} hrefFor={rowHref} /> : <ReviewEmpty title={query || status !== 'all' ? '没有匹配的记录' : source === 'report' ? '还没有导入文档' : '还没有代码审查记录'} action={<ReviewButton onClick={() => { if (query || status !== 'all') updateList({ q: undefined, status: undefined }); else navigateView(source === 'report' ? 'import' : 'source'); }}>{query || status !== 'all' ? '清空筛选' : source === 'report' ? '导入报告' : '发起审查'}</ReviewButton>}>{query || status !== 'all' ? '调整筛选条件后重试。' : '上传源码，或直接选择平台已连接的项目和分支。'}</ReviewEmpty>}
          {data ? <ReviewPagination {...data.page} onOffset={offset => updateList({ page: String(offset / 10 + 1) })} /> : null}
        </div>}
        {data ? <p className="cr-form-note" aria-live="polite">{loading ? '正在刷新 · ' : ''}{history ? '全部执行记录' : '每个项目的最近源码审查'}{data.historyCount ? ` · 另有 ${data.historyCount} 条历史执行可查看` : ''}</p> : null}
      </>}
  </div></Workspace></AppShell>;
}

export function ReviewTaskList({ items, selectedId, projectName, onSelect, hrefFor }: { items: CodeReviewTask[]; selectedId: string; projectName: (id: string) => string; onSelect: (task: CodeReviewTask) => void; hrefFor?: (task: CodeReviewTask) => string }): JSX.Element {
  const link = (task: CodeReviewTask) => hrefFor?.(task) || `/code-reviews?${new URLSearchParams({ project: task.projectId, task: task.id })}`;
  const click = (event: React.MouseEvent<HTMLAnchorElement>, task: CodeReviewTask) => { if (!event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey && event.button === 0) { event.preventDefault(); onSelect(task); } };
  return <><div className="cr-table-scroll cr-desktop"><div className="cr-table-grid cr-table-head" aria-hidden="true">{['报告', '版本', '执行状态', '已分析 / 候选', '待验证发现', '更新（UTC+8）', ''].map((title, i) => <span key={i}>{title}</span>)}</div>
    <ul aria-label="当前页审查任务">{items.map(task => {
      const coverage = reviewCoverage(task), findingCount = task.findingsSummary ? Object.values(task.findingsSummary).reduce((n, value) => n + value, 0) : undefined;
      const branch = task.branchName || task.ref || (task.sourceType === 'zip' || task.sourceType === 'report' ? task.sourceName : '仓库默认分支');
      const action = task.sourceType === 'report' ? '查看文档' : isReviewActive(task) ? '查看进度' : task.reportId ? '查看报告' : task.progress.scannedFiles > 0 ? '查看已审部分' : task.status === 'failed' ? '查看原因' : '查看进度';
      return <li key={task.id} className="cr-table-grid cr-task-row" data-code-review-row onClick={e => { if (!(e.target as HTMLElement).closest('a,button')) onSelect(task); }}>
        <span><a id={`review-record-${task.id}`} className="cr-row-name" href={link(task)} onClick={event => click(event, task)} aria-current={selectedId === task.id ? 'true' : undefined} title={task.title || task.sourceName}>{task.title && task.title !== '代码审查报告' ? task.title : task.sourceName}</a><span className="cr-row-sub cr-truncate">{projectName(task.projectId)} · {task.sourceType === 'report' ? '导入文档' : '源码审查'}</span></span>
        <span><span className="cr-row-inline cr-mono cr-truncate" title={branch}>{task.sourceType === 'zip' || task.sourceType === 'report' ? <Archive className="inline size-3" /> : <GitBranch className="inline size-3" />} {branch}</span><span className="cr-row-sub cr-mono cr-truncate">{task.commitSha?.slice(0, 8) || task.sourceHash && `sha256:${task.sourceHash.slice(0, 10)}` || (task.sourceType === 'report' ? '原文保存' : '提交待固定')}</span></span>
        <span><TaskStatus task={task} /><span className="cr-row-sub cr-truncate" title={task.error || task.phase}>{task.error || task.phase}</span></span>
        <span><span className="cr-num">{task.sourceType === 'report' ? '—' : task.progress.totalFiles > 0 ? `${task.progress.scannedFiles.toLocaleString()} / ${task.progress.totalFiles.toLocaleString()}` : '—'}</span><span className="cr-row-sub">{coverage.kind === 'partial' ? <span className="cr-tag cr-tag-warn">部分覆盖</span> : task.sourceType === 'report' ? '未执行源码审查' : task.progress.totalFiles <= 0 ? '尚未统计' : null}</span></span>
        <span><span className="cr-num">{findingCount === undefined ? '—' : findingCount.toLocaleString()}</span>{findingCount === undefined || !findingCount ? <span className="cr-row-sub">{task.sourceType === 'report' ? '以原文为准' : findingCount === 0 ? '已保存范围未返回发现' : '尚未提供'}</span> : null}</span>
        <span className="cr-small cr-num">{formatDate(task.updatedAt)}</span><a href={link(task)} onClick={event => click(event, task)} className="cr-task-action">{action}<ChevronRight aria-hidden="true" /></a>
      </li>;
    })}</ul></div>
    <ul className="cr-mobile" aria-label="手机审查任务">{items.map(task => { const count = task.findingsSummary ? Object.values(task.findingsSummary).reduce((n, value) => n + value, 0) : undefined; return <li key={task.id} className="cr-mobile-task" data-code-review-mobile-row><div className="cr-mobile-task-title"><a id={`review-mobile-record-${task.id}`} href={link(task)} onClick={e => click(e, task)} className="cr-row-name">{task.title === '代码审查报告' ? task.sourceName : task.title}</a><TaskStatus task={task} /></div><span className="cr-muted">{projectName(task.projectId)} · {task.sourceType === 'report' ? '导入文档' : '源码审查'}</span><span className="cr-mono cr-break">{task.branchName || task.ref || task.sourceName}</span><div className="cr-row-inline cr-num"><span>{task.sourceType === 'report' ? '原文已保存' : task.progress.totalFiles > 0 ? `${task.progress.scannedFiles.toLocaleString()} / ${task.progress.totalFiles.toLocaleString()} 已分析` : '尚未统计范围'}</span><span className="cr-muted">{task.sourceType === 'report' ? '以原文为准' : count === undefined ? '发现尚未提供' : `${count.toLocaleString()} 项待验证发现`}</span></div><div className="cr-row-inline"><span className="cr-muted cr-small">{formatDate(task.updatedAt)}（UTC+8）</span><a className="cr-task-action cr-end" href={link(task)} onClick={e => click(e, task)}>{task.sourceType === 'report' ? '查看文档' : isReviewActive(task) ? '查看进度' : task.reportId ? '查看报告' : task.progress.scannedFiles ? '查看已审部分' : '查看进度'}<ChevronRight /></a></div></li>; })}</ul></>;
}
