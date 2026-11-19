import { useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { ArrowRight, GitBranch, LayoutGrid, Maximize2, Minimize2, Plus, RefreshCw, Timer } from 'lucide-react';
import { AppShell, Crumb, TopBar, Workspace } from '@/components/layout/AppShell';
import { ContentLoading } from '@/components/skeletons/ContentLoading';
import { EngineeringPlanningSkeleton } from '@/components/skeletons/PageSkeletons';
import { apiRequest } from '@/lib/api';
import type {
  PlanningBoard, PlanningDebtDetail, PlanningDebtList, PlanningReceipt, PlanningStats,
} from '../../../src/shared/engineering-planning';
import {
  type PlanningInput, type PlanningProject, type PlanningView, planningError, planningPath, shortId,
  usePlanningRead, viewLabels, views,
} from './engineering-planning/planning-ui';
import {
  DebtList, DebtSearch, PlanningBoardView, PlanningEmpty, PlanningEvolution, PlanningGraph, PlanningTimeline,
  type PlanningSelection,
} from './engineering-planning/PlanningViews';
import { PlanningActionDialog, PlanningDetailDialog, type PlanningAction } from './engineering-planning/PlanningDialogs';
import './engineering-planning/planning.css';

const DAY = 86_400_000;
const dateBefore = (date: string, days: number) => new Date(Date.parse(date) - (days - 1) * DAY).toISOString().slice(0, 10);

function ReadStatus({ loading, error, onRetry }: { loading: boolean; error?: string; onRetry: () => void }) {
  if (error) return <div className="ep-error ep-panel-status" role="alert">{error}
    <button type="button" className="ep-button" onClick={onRetry}>重试</button></div>;
  if (!loading) return null;
  return <ContentLoading variant="table" label="正在读取工程规划" />;
}

export function EngineeringPlanningPage() {
  const [params, setParams] = useSearchParams();
  const [reload, updateReload] = useState(0);
  const [search, setSearch] = useState(params.get('q') ?? '');
  const [pages, setPages] = useState<string[]>([]);
  const [range, setRange] = useState(30);
  const [screen, setScreen] = useState(false);
  const [action, setAction] = useState<PlanningAction>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const pending = useRef<{ projectId: string; input: string; requestId: string }>();
  const working = useRef(false);
  const projects = usePlanningRead<{ projects: PlanningProject[] }>('/api/projects', reload);
  const options = (projects.data?.projects ?? []).filter(row => !row.mirror);
  const activeProject = params.get('project') || options[0]?.id || '';
  const allowed = options.some(row => row.id === activeProject);
  const target = allowed ? planningPath(activeProject) : null;
  const board = usePlanningRead<PlanningBoard>(target, reload);

  const requestedView = params.get('view') as PlanningView | null;
  const view: PlanningView = requestedView && views.includes(requestedView) ? requestedView : 'plan';
  const debtLevel = ['debts', 'map', 'evolution'].includes(view);
  const status = params.get('status') || 'unpaid';
  const branch = params.get('branch') || '';
  const tag = params.get('tag') || '';
  const q = params.get('q') || '';
  const cursor = pages.at(-1);
  const itemId = params.get('item') || '';
  const itemKind = params.get('kind') || '';
  const selected: PlanningSelection | undefined =
    itemId && (itemKind === 'debt' || itemKind === 'decision' || itemKind === 'plan') ? { kind: itemKind, id: itemId } : undefined;
  const debtQuery = new URLSearchParams({ view: status, ...(q ? { q } : {}), ...(branch ? { branch } : {}), ...(tag ? { tag } : {}), ...(cursor ? { cursor } : {}) });
  const debts = usePlanningRead<PlanningDebtList>(target && view === 'debts' ? `${target}/debts?${debtQuery}` : null, reload);
  const debtDetail = usePlanningRead<PlanningDebtDetail>(target && selected?.kind === 'debt' ? `${target}/debts/${encodeURIComponent(selected.id)}` : null, reload);
  const statsQuery = new URLSearchParams({
    ...(board.data ? { from: dateBefore(board.data.today, range), to: board.data.today } : {}),
    ...(debtLevel && branch ? { branch } : {}),
  });
  const stats = usePlanningRead<PlanningStats>(target ? `${target}/stats?${statsQuery}` : null, reload);
  const change = (values: Record<string, string>, replace = false) => {
    setParams(current => {
      const next = new URLSearchParams(current);
      for (const [key, value] of Object.entries(values)) {
        if (value) next.set(key, value);
        else next.delete(key);
      }
      return next;
    }, { replace });
  };
  const refresh = () => updateReload(value => value + 1);
  useEffect(() => {
    if (params.get('project') || !activeProject) return;
    setParams(current => {
      const next = new URLSearchParams(current);
      next.set('project', activeProject);
      return next;
    }, { replace: true });
  }, [activeProject, params, setParams]);
  useEffect(() => { setSearch(q); }, [q]);
  useEffect(() => {
    if (view !== 'debts' || q === search.trim()) return;
    const timer = window.setTimeout(() => {
      setPages([]);
      setParams(current => {
        const next = new URLSearchParams(current);
        if (search.trim()) next.set('q', search.trim());
        else next.delete('q');
        return next;
      }, { replace: true });
    }, 220);
    return () => window.clearTimeout(timer);
  }, [q, search, setParams, view]);

  function selectProject(project: string) {
    setPages([]); setSearch(''); setNotice(''); setError(''); setAction(undefined);
    change({ project, branch: '', tag: '', q: '', item: '', kind: '' });
  }
  function selectView(next: PlanningView) {
    setPages([]); setScreen(false); setNotice(''); setError('');
    change({ view: next, item: '', kind: '' });
  }
  function selectItem(item: PlanningSelection) {
    setError('');
    change({ item: item.id, kind: item.kind });
  }
  function openAction(next: PlanningAction) {
    setError('');
    setAction(next);
  }
  async function submit(input: PlanningInput) {
    if (!target || working.current) return;
    working.current = true;
    setBusy(true); setError(''); setNotice('');
    const payload = JSON.stringify(input);
    if (pending.current?.input !== payload || pending.current.projectId !== activeProject) {
      pending.current = { projectId: activeProject, input: payload, requestId: crypto.randomUUID() };
    }
    try {
      const receipt = await apiRequest<PlanningReceipt>(`${target}/commands`, { method: 'POST', body: { ...input, requestId: pending.current.requestId } });
      if (receipt.projectId !== activeProject || receipt.result.projectId !== activeProject) throw new Error('invalid planning receipt');
      pending.current = undefined;
      setAction(undefined);
      if (input.type === 'proposal.accept') setNotice('提案已确认');
      else if (input.type === 'proposal.reject') setNotice('提案已驳回');
      else if (input.type === 'debt.repay') setNotice('已记录偿还证据');
      else if ('items' in receipt.result) {
        const imported = receipt.result.items.filter(item => item.status === 'created').length;
        setNotice(`已导入 ${imported} 笔 · 已存在 ${receipt.result.items.length - imported} 笔`);
      } else setNotice(`${receipt.reused ? '已存在' : '已保存'} · ${shortId(receipt.result.id)}`);
      setPages([]);
      refresh();
    } catch (failure) {
      setError(planningError(failure));
    } finally {
      working.current = false;
      setBusy(false);
    }
  }

  const data = board.data;
  const write = Boolean(data?.permissions.includes('write'));
  const activeLabel = options.find(row => row.id === activeProject);
  const tabs: PlanningView[] = debtLevel ? ['debts', 'map', 'evolution'] : ['plan', 'timeline'];
  const header = <TopBar left={<Crumb items={[{ label: 'CDS', href: '/project-list' }, { label: '工程规划' }, { label: debtLevel ? '债务分支' : '决策主线' }, { label: viewLabels[view] }]} />} />;
  const initialLoading = (projects.loading && !projects.data) || (allowed && board.loading && !data);
  if (initialLoading) return <AppShell active="engineering-planning" topbar={header} wide>
    <Workspace fluid><EngineeringPlanningSkeleton /></Workspace>
  </AppShell>;
  return <AppShell active="engineering-planning" topbar={header} wide>
    <Workspace fluid className={`ep-workspace${screen ? ' ep-screen' : ''}`}>
      <header className="ep-page-header">
        <div><h1>{screen ? '债务演进' : '工程规划'}</h1>{screen && activeLabel && <p>{activeLabel.aliasName || activeLabel.name}</p>}</div>
        <div className="ep-page-actions">
          {!screen && <><label className="ep-project-picker"><span className="sr-only">选择项目</span>
            <select aria-label="选择项目" value={activeProject} disabled={busy || !options.length} onChange={event => selectProject(event.target.value)}>
              {!allowed && <option value={activeProject}>{options.length ? '选择可访问的项目' : '暂无项目'}</option>}
              {options.map(row => <option value={row.id} key={row.id}>{row.aliasName || row.name}</option>)}
            </select></label>
            <button type="button" className="ep-button ep-icon-button" aria-label="刷新工程规划" onClick={refresh}><RefreshCw /></button></>}
          {screen && <button type="button" className="ep-button" onClick={() => setScreen(false)}><Minimize2 />退出投屏</button>}
          {!screen && write && <details className="ep-new"><summary className="ep-button ep-button--primary"><Plus />新建</summary>
            <div onClick={event => { const menu = event.currentTarget.closest('details'); if (menu) menu.open = false; }}>
              <button type="button" onClick={() => openAction({ kind: 'create', record: 'decision' })}>记一个决策</button>
              <button type="button" onClick={() => openAction({ kind: 'create', record: 'plan' })}>新建落地计划</button>
              <button type="button" onClick={() => openAction({ kind: 'create', record: 'debt' })}>记一笔债</button>
              <button type="button" onClick={() => openAction({ kind: 'import' })}>批量导入债务</button>
            </div>
          </details>}
        </div>
      </header>

      {!screen && <div className="ep-hierarchy">
        <button type="button" data-level="root" aria-pressed={!debtLevel} onClick={() => selectView('plan')}><LayoutGrid />
          <span><strong>决策主线</strong><small>{data ? `${data.decisions.filter(row => row.status === 'accepted').length} 个生效中的决策` : '推进与时间线'}</small></span>
        </button>
        <span className="ep-hierarchy-line" aria-hidden><ArrowRight /></span>
        <button type="button" data-level="branch" aria-pressed={debtLevel} onClick={() => selectView('debts')}><GitBranch />
          <span><strong>债务分支</strong><small>{stats.data ? `当前范围 ${stats.data.backlogEnd} 笔未还` : '清单、图谱和演进'}</small></span>
        </button>
      </div>}

      {notice && <p className="ep-message" role="status">{notice}</p>}
      {!action && error && <p className="ep-error" role="alert">{error}</p>}
      {projects.error ? <ReadStatus loading={false} error={projects.error} onRetry={refresh} />
        : !allowed ? projects.loading ? <ContentLoading variant="rows" label="加载授权项目" />
          : <PlanningEmpty>{activeProject ? '没有可访问的工程规划项目，请选择已授权的项目。' : '当前没有可查看的项目'}</PlanningEmpty>
          : board.error || !data ? <ReadStatus loading={board.loading} error={board.error} onRetry={refresh} />
            : <>
              {!screen && <div className="ep-toolbar">
                <nav className="ep-tabs" aria-label={debtLevel ? '债务视图' : '决策视图'}>{tabs.map(tab =>
                  <button type="button" key={tab} aria-pressed={tab === view} onClick={() => selectView(tab)}>{viewLabels[tab]}
                    {tab === 'plan' && data.proposals.some(row => row.status === 'pending') && <small>{data.proposals.filter(row => row.status === 'pending').length} 待确认</small>}</button>)}</nav>
                {debtLevel && <label className="ep-branch-picker"><span className="sr-only">决策分支</span><select aria-label="决策分支" value={branch} onChange={event => {
                  setPages([]); change({ branch: event.target.value, tag: '' }, true);
                }}><option value="">全部分支</option><option value="none">未归属决策</option>
                  {data.decisions.map(row => <option value={row.id} key={row.id}>{row.title}</option>)}</select></label>}
              </div>}

              {view === 'plan' && <PlanningBoardView data={data} busy={busy} onSelect={selectItem}
                onConfirm={proposal => { void submit({ type: 'proposal.accept', proposalId: proposal.id }); }}
                onReject={proposal => openAction({ kind: 'reject', proposal })} />}
              {view === 'timeline' && <PlanningTimeline data={data} onSelect={selectItem} />}
              {view === 'debts' && <>
                <div className="ep-debt-tools">
                  <DebtSearch status={status} search={search} onSearch={setSearch} onStatus={next => { setPages([]); change({ status: next }, true); }} />
                  {tag && <button type="button" className="ep-button" onClick={() => { setPages([]); change({ tag: '' }, true); }}>清除分类 {tag}</button>}
                  <button type="button" className="ep-button" onClick={() => { setPages([]); change({ status: 'review_due' }, true); }}><Timer />到期回看</button>
                </div>
                {debts.data ? <DebtList data={debts.data} previous={pages.length > 0} onSelect={selectItem}
                  onPrevious={() => setPages(values => values.slice(0, -1))} onNext={next => setPages(values => [...values, next])} />
                  : <ReadStatus loading={debts.loading} error={debts.error} onRetry={() => { setPages([]); refresh(); }} />}
              </>}
              {view === 'map' && (stats.data
                ? <PlanningGraph data={stats.data} onCategory={name => { setPages([]); setSearch(''); change({ view: 'debts', tag: name, q: '', status: 'all' }); }} />
                : <ReadStatus loading={stats.loading} error={stats.error} onRetry={refresh} />)}
              {view === 'evolution' && <>
                <div className="ep-evolution-actions">
                  <label className="ep-branch-picker"><span className="sr-only">统计时间范围</span><select aria-label="统计时间范围" value={range} onChange={event => setRange(Number(event.target.value))}>
                    {[30, 90, 180, 365].map(days => <option value={days} key={days}>最近 {days} 天</option>)}</select></label>
                  {!screen && <button type="button" className="ep-button" onClick={() => setScreen(true)}><Maximize2 />投屏</button>}
                </div>
                {stats.data ? <PlanningEvolution data={stats.data} screen={screen} /> : <ReadStatus loading={stats.loading} error={stats.error} onRetry={refresh} />}
              </>}

              {selected && !action && <PlanningDetailDialog item={selected} board={data} detail={debtDetail.data}
                loading={selected.kind === 'debt' && debtDetail.loading && !debtDetail.data} error={selected.kind === 'debt' ? debtDetail.error : undefined}
                onClose={() => change({ item: '', kind: '' }, true)} onRetry={refresh} onSelect={selectItem} onAction={openAction} />}
              {action && <PlanningActionDialog key={action.kind} action={action} board={data} busy={busy} error={error}
                onClose={() => { setError(''); setAction(undefined); }} onSubmit={input => { void submit(input); }} />}
            </>}
    </Workspace>
  </AppShell>;
}
