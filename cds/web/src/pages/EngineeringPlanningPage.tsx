import { useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { CalendarDays, ChartNoAxesColumn, ChevronDown, Clock3, List, Maximize2, Minimize2, Plus, RefreshCw, Target, Terminal, Triangle } from 'lucide-react';
import { AppShell, Crumb, TopBar, Workspace } from '@/components/layout/AppShell';
import { ContentLoading } from '@/components/skeletons/ContentLoading';
import { EngineeringPlanningSkeleton } from '@/components/skeletons/PageSkeletons';
import { apiRequest } from '@/lib/api';
import { planningDebtSorts, planningDebtViews, type PlanningDebtView } from '../../../src/shared/engineering-planning';
import type {
  PlanningBoard, PlanningDebtDetail, PlanningDebtList, PlanningReceipt, PlanningStats,
} from '../../../src/shared/engineering-planning';
import {
  type PlanningInput, type PlanningProject, type PlanningView, planningError, planningPath, shortId,
  usePlanningRead, viewLabels, views,
} from './engineering-planning/planning-ui';
import { DebtLedger, DebtList, DebtSearch, PlanningEmpty, type PlanningSelection } from './engineering-planning/PlanningViews';
import { PlanningBoardView, PlanningTimeline, planningBoardSummary } from './engineering-planning/PlanningDecisionViews';
import { PlanningEvolution, PlanningGraph, planningBucketLabel } from './engineering-planning/PlanningAnalytics';
import { PlanningActionDialog, PlanningDetailDialog, type PlanningAction } from './engineering-planning/PlanningDialogs';
import { ConfigurationTrail, DecisionSearch, PlanningUtilities } from './engineering-planning/PlanningCompanion';
import { PlanningCheckupMenu, usePlanningCheckup } from './engineering-planning/PlanningCheckup';
import './engineering-planning/planning.css';
import './engineering-planning/planning-shell.css';
import './engineering-planning/planning-debts.css';

const DAY = 86_400_000;
const dateBefore = (date: string, days: number) => new Date(Date.parse(date) - (days - 1) * DAY).toISOString().slice(0, 10);
const modes = { plan: Target, timeline: CalendarDays, debts: List, map: Triangle, evolution: ChartNoAxesColumn };
const ranges = [[30, '近 30 天'], [90, '近 90 天'], [182, '近半年'], [365, '近一年']] as const;
const monthDay = (value: string) => `${Number(value.slice(5, 7))}月${Number(value.slice(8))}日`;

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
  const [statsReload, setStatsReload] = useState(0);
  const [detailTrail, setDetailTrail] = useState<PlanningSelection[]>([]);
  const [actionEntry, setActionEntry] = useState<{ key: string; value: PlanningAction; returnFocusTo?: HTMLElement | null }>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [importBatch, setImportBatch] = useState('');
  const pending = useRef<{ projectId: string; input: string; requestId: string }>();
  const working = useRef(false);
  const previousEvolution = useRef<{ scope: string; data: PlanningStats }>();
  const projects = usePlanningRead<{ projects: PlanningProject[] }>('/api/projects', reload);
  const options = (projects.data?.projects ?? []).filter(row => !row.mirror);
  const activeProject = params.get('project') || options[0]?.id || '';
  const allowed = options.some(row => row.id === activeProject);
  const target = allowed ? planningPath(activeProject) : null;
  const board = usePlanningRead<PlanningBoard>(target, reload);
  const { checkup, refreshCheckup } = usePlanningCheckup(target, reload);

  const requestedView = params.get('view') as PlanningView | null;
  const requestedUtility = params.get('tools');
  const utility = requestedUtility === 'cli' || requestedUtility === 'spec' || requestedUtility === 'changes' ? requestedUtility : null;
  const selectUtility = (value: string) => change({ tools: value, item: '', kind: '' });
  const view: PlanningView = requestedView && views.includes(requestedView) ? requestedView : 'plan';
  const debtLevel = ['debts', 'map', 'evolution'].includes(view);
  const requestedStatus = params.get('status') as PlanningDebtView;
  const status = planningDebtViews.includes(requestedStatus) ? requestedStatus : 'unpaid';
  const requestedSort = params.get('sort') as typeof planningDebtSorts[number];
  const sort = planningDebtSorts.includes(requestedSort) ? requestedSort : 'deadline';
  const branch = params.get('branch') || '';
  const evolutionScope = JSON.stringify([activeProject, branch, range]);
  const tag = params.get('tag') || '';
  const tagMatch = params.get('tagMatch') === 'exact' && tag ? 'exact' : '';
  const priority = params.get('priority') || '';
  const owner = params.get('owner') || '';
  const source = params.get('source') || '';
  const batch = params.get('batch') || '';
  const q = params.get('q') || '';
  const cursor = pages.at(-1);
  const itemId = params.get('item') || '';
  const itemKind = params.get('kind') || '';
  const selected: PlanningSelection | undefined =
    itemId && (itemKind === 'debt' || itemKind === 'decision' || itemKind === 'plan') ? { kind: itemKind, id: itemId } : undefined;
  const actionKey = JSON.stringify([activeProject, view, itemKind, itemId]);
  const action = actionEntry?.key === actionKey ? actionEntry.value : undefined;
  const debtQuery = new URLSearchParams({ view: status, sort, ...(q ? { q } : {}), ...(branch ? { branch } : {}),
    ...(tag ? { tag } : {}), ...(tagMatch ? { tagMatch } : {}), ...(priority ? { priority } : {}), ...(owner ? { owner } : {}), ...(source ? { source } : {}),
    ...(batch ? { batch } : {}),
    ...(cursor ? { cursor } : {}) });
  const debts = usePlanningRead<PlanningDebtList>(target && view === 'debts' ? `${target}/debts?${debtQuery}` : null, reload);
  const debtDetail = usePlanningRead<PlanningDebtDetail>(target && selected?.kind === 'debt' ? `${target}/debts/${encodeURIComponent(selected.id)}` : null, reload);
  const statsQuery = new URLSearchParams({
    ...(board.data ? { from: dateBefore(board.data.today, view === 'evolution' ? range : 30), to: board.data.today } : {}),
    ...(debtLevel && branch ? { branch } : {}),
    ...(view === 'map' ? { analytics: 'graph' } : view === 'evolution' ? { analytics: screen ? 'projection' : 'evolution' } : {}),
  });
  const stats = usePlanningRead<PlanningStats>(target && board.data && debtLevel ? `${target}/stats?${statsQuery}` : null, reload + statsReload);
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
  function refreshStats() { setStatsReload(value => value + 1); }
  useEffect(() => {
    if (params.get('project') || !activeProject) return;
    setParams(current => {
      const next = new URLSearchParams(current);
      next.set('project', activeProject);
      return next;
    }, { replace: true });
  }, [activeProject, params, setParams]);
  useEffect(() => {
    if (actionEntry && actionEntry.key !== actionKey) setActionEntry(undefined);
  }, [actionEntry, actionKey]);
  useEffect(() => { setSearch(q); }, [q]);
  useEffect(() => { if (!itemId) setDetailTrail(current => current.length ? [] : current); }, [itemId]);
  useEffect(() => {
    if (!screen && view === 'evolution' && stats.data) previousEvolution.current = { scope: evolutionScope, data: stats.data };
  }, [evolutionScope, screen, stats.data, view]);
  useEffect(() => {
    if (!screen) return;
    const timer = window.setInterval(refreshStats, 60_000);
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') setScreen(false); };
    window.addEventListener('keydown', escape);
    return () => { window.clearInterval(timer); window.removeEventListener('keydown', escape); };
  }, [screen]);
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
    setPages([]); setSearch(''); setNotice(''); setImportBatch(''); setError(''); setActionEntry(undefined);
    change({ project, branch: '', tag: '', tagMatch: '', q: '', item: '', kind: '', priority: '', owner: '', source: '', status: '', sort: '', batch: '' });
  }
  function selectView(next: PlanningView) {
    setPages([]); setScreen(false); setNotice(''); setError('');
    change({ view: next, item: '', kind: '', tools: '' });
  }
  function selectItem(item: PlanningSelection) {
    if (selected && (selected.id !== item.id || selected.kind !== item.kind)) setDetailTrail(current => [...current, selected]);
    setError('');
    change({ item: item.id, kind: item.kind });
  }
  function backDetail() {
    const previous = detailTrail.at(-1);
    if (!previous) return;
    setDetailTrail(current => current.slice(0, -1));
    change({ item: previous.id, kind: previous.kind }, true);
  }
  function selectBranch(value: string) {
    setPages([]); setSearch(''); setScreen(false);
    change({ view: 'debts', branch: value, status: 'unpaid', tag: '', tagMatch: '', q: '', owner: '', source: '', priority: '', item: '', kind: '', batch: '' });
  }
  function openAction(next: PlanningAction, returnFocusTo?: HTMLElement | null) {
    setError('');
    setActionEntry({ key: actionKey, value: next, returnFocusTo });
  }
  async function submit(input: PlanningInput) {
    if (!target || working.current) return;
    working.current = true;
    setBusy(true); setError(''); setNotice(''); setImportBatch('');
    const payload = JSON.stringify(input);
    if (pending.current?.input !== payload || pending.current.projectId !== activeProject) {
      pending.current = { projectId: activeProject, input: payload, requestId: crypto.randomUUID() };
    }
    try {
      const receipt = await apiRequest<PlanningReceipt>(`${target}/commands`, { method: 'POST', body: { ...input, requestId: pending.current.requestId } });
      if (receipt.projectId !== activeProject || receipt.result.projectId !== activeProject) throw new Error('invalid planning receipt');
      pending.current = undefined;
      setActionEntry(undefined);
      if (input.type === 'proposal.accept') setNotice('提案已确认');
      else if (input.type === 'proposal.reject') setNotice('提案已驳回');
      else if (input.type === 'debt.repay') setNotice('已记录偿还证据');
      else if ('items' in receipt.result) {
        const imported = receipt.result.items.filter(item => item.status === 'created').length;
        setNotice(`已导入 ${imported} 笔 · 已存在 ${receipt.result.items.length - imported} 笔`);
        setImportBatch(receipt.result.batchId ?? '');
      } else if ('closed' in receipt.result) {
        setNotice(`巡检完成 · 关闭 ${receipt.result.closed.length} 笔 · 缓冲期内 ${receipt.result.pending.length} 笔`);
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
  const projectLabel = activeLabel?.aliasName || activeLabel?.name || activeProject;
  const tabs: PlanningView[] = debtLevel ? ['debts', 'map', 'evolution'] : ['plan', 'timeline'];
  const header = <TopBar left={<Crumb items={[{ label: 'CDS', href: '/project-list' }, { label: '工程规划' }, { label: '决策主线' },
    ...(debtLevel ? [{ label: '债务分支' }] : []), { label: viewLabels[view] }]} />}
    right={data && <span className="ep-top-date">今天 {monthDay(data.today)}</span>} />;
  const initialLoading = (projects.loading && !projects.data) || (allowed && board.loading && !data);
  if (initialLoading) return <AppShell active="engineering-planning" topbar={header} wide>
    <Workspace fluid><EngineeringPlanningSkeleton /></Workspace>
  </AppShell>;
  if (screen && view === 'evolution' && data) {
    const projected = stats.data ?? (previousEvolution.current?.scope === evolutionScope ? previousEvolution.current.data : undefined);
    return <main className="ep-workspace ep-screen">
      <header className="ep-projection-head">
        <div><h1>债务演进 · {projectLabel}</h1><p>{projected && `${monthDay(projected.from)} – ${monthDay(projected.to)} · `}
          {planningBucketLabel(range)} · 投屏模式不显示债务标题</p></div>
        <div className="ep-row">
          <button type="button" className="ep-button ep-icon-button" aria-label="刷新投屏数据" onClick={refreshStats}><RefreshCw /></button>
          <button type="button" className="ep-button" onClick={() => setScreen(false)}><Minimize2 />退出投屏</button>
        </div>
      </header>
      {stats.error && <ReadStatus loading={false} error={stats.error} onRetry={refreshStats} />}
      {projected ? <PlanningEvolution data={projected} screen projectLabel={projectLabel} onSelect={selectItem} />
        : <ReadStatus loading={stats.loading} onRetry={refreshStats} />}
    </main>;
  }
  const summary = data && planningBoardSummary(data);
  const branchLabel = branch === 'none' ? '未归属决策' : data?.decisions.find(row => row.id === branch)?.title;
  const since = data && dateBefore(data.today, 14);
  const changes = data?.events.filter(event => event.entity === 'decision' && since && event.at.slice(0, 10) >= since).length ?? 0;
  const unpaidCount = data?.debtBranches ? Object.values(data.debtBranches).reduce((sum, row) => sum + row.unpaid, 0) : stats.data?.backlogEnd;
  return <AppShell active="engineering-planning" topbar={header} wide>
    <Workspace fluid className={`ep-workspace ep-view-${view}`}>
      <header className="ep-workhead">
        <h1>工程规划</h1>
        <label className="ep-project-picker"><span className="sr-only">选择项目</span>
          <select aria-label="选择项目" value={activeProject} disabled={busy || !options.length} onChange={event => selectProject(event.target.value)}>
            {!allowed && <option value={activeProject}>{options.length ? '选择可访问的项目' : '暂无项目'}</option>}
            {options.map(row => <option value={row.id} key={row.id}>{row.aliasName || row.name}</option>)}
          </select>
        </label>
        <div className="ep-page-actions">
          {allowed && <DecisionSearch key={activeProject} projectId={activeProject} reload={reload} onDecision={id => selectItem({ kind: 'decision', id })} />}
          {allowed && <PlanningCheckupMenu key={activeProject} projectId={activeProject} data={checkup} onRefresh={refreshCheckup}
            onDebt={id => selectItem({ kind: 'debt', id })} />}
          {allowed && <details className="ep-new ep-cli"><summary className="ep-button"><Terminal aria-hidden="true" />CLI</summary>
            <div><code>{`cdscli ${debtLevel ? 'debt list' : 'planning show'} --project ${activeProject}`}</code>
              <button type="button" onClick={event => { event.currentTarget.closest('details')!.open = false; selectUtility('cli'); }}>CLI 协作</button>
              <button type="button" onClick={event => { event.currentTarget.closest('details')!.open = false; selectUtility('spec'); }}>数据与 CLI 规范</button>
              <button type="button" onClick={event => { event.currentTarget.closest('details')!.open = false; selectUtility('changes'); }}>配置变更记录</button>
              <button type="button" onClick={refresh}><RefreshCw aria-hidden="true" />刷新工程规划</button></div>
          </details>}
          {write && <details className="ep-new"><summary className="ep-button ep-button--primary"><Plus aria-hidden="true" />新建<ChevronDown aria-hidden="true" /></summary>
            <div onClick={event => { const menu = event.currentTarget.closest('details'); if (menu) menu.open = false; }}>
              <button type="button" onClick={() => openAction({ kind: 'create', record: 'decision' })}>记一个决策</button>
              <button type="button" onClick={() => openAction({ kind: 'create', record: 'plan' })}>新建落地计划</button>
              <button type="button" onClick={() => openAction({ kind: 'create', record: 'debt', decisionId: branch && branch !== 'none' ? branch : undefined })}>记一笔债</button>
              <button type="button" onClick={() => openAction({ kind: 'import' })}>批量导入债务</button>
            </div>
          </details>}
        </div>
      </header>

      {notice && <p className="ep-message" role="status">{notice}{importBatch && <> · <button type="button" className="ep-text-button" onClick={() => {
        setSearch(''); setPages([]); change({ view: 'debts', status: 'all', batch: importBatch, q: '', tag: '', tagMatch: '', priority: '', owner: '', source: '', branch: '', item: '', kind: '' });
      }}>查看此次导入</button></>}</p>}
      {!action && error && <p className="ep-error" role="alert">{error}</p>}
      {projects.error ? <ReadStatus loading={false} error={projects.error} onRetry={refresh} />
        : !allowed ? projects.loading ? <ContentLoading variant="rows" label="加载授权项目" />
          : <PlanningEmpty>{activeProject ? '没有可访问的工程规划项目，请选择已授权的项目。' : '当前没有可查看的项目'}</PlanningEmpty>
          : board.error || !data ? <ReadStatus loading={board.loading} error={board.error} onRetry={refresh} />
            : <>
              <div className="ep-toolbar">
                <nav className="ep-level-tabs" aria-label="工程规划层级">
                  <button type="button" aria-current={!debtLevel} onClick={() => selectView('plan')}>决策主线 <small>{data.decisions.filter(row => row.status === 'accepted').length} 生效</small></button>
                  <button type="button" aria-current={debtLevel} aria-label={`债务分支 未还 ${unpaidCount ?? 0} 笔`}
                    onClick={() => selectView('debts')}>债务分支 <small aria-hidden>{unpaidCount ?? 0} 未还</small></button>
                </nav>
                <div className="ep-toolbar-context">{debtLevel ? <>
                  <label className="ep-branch-picker"><span className="sr-only">决策分支</span><select aria-label="决策分支" value={branch} onChange={event => {
                    setPages([]); change({ branch: event.target.value, tag: '', tagMatch: '', owner: '', batch: '' }, true);
                  }}><option value="">全部分支</option><option value="none">未归属决策</option>
                    {data.decisions.map(row => <option value={row.id} key={row.id}>{row.title}</option>)}</select></label>
                </> : <span className="ep-activity-summary"><Clock3 aria-hidden="true" />自两周前{since && `（${monthDay(since)}）`} · 决策变更 {changes}
                  {` · PR 更新 ${summary?.recentPulls ?? 0}`}</span>}</div>
                <nav className="ep-tabs" aria-label={debtLevel ? '债务视图' : '决策视图'}>
                  {tabs.map(tab => {
                    const Icon = modes[tab];
                    return <button type="button" key={tab} aria-pressed={tab === view} onClick={() => selectView(tab)}>
                      <Icon aria-hidden="true" />{viewLabels[tab]}{tab === 'plan' && !!(summary?.stuck || summary?.pending)
                        && <small data-blocked={!!summary?.stuck}>{summary?.stuck ? `卡住 ${summary.stuck}` : `待确认 ${summary?.pending}`}</small>}
                    </button>;
                  })}
                </nav>
              </div>

              {(utility === 'cli' || utility === 'spec') && <PlanningUtilities projectId={activeProject} view={utility} onTab={selectUtility} />}
              {utility === 'changes' && <ConfigurationTrail projectId={activeProject} reload={reload} />}
              {!utility && view === 'plan' && <PlanningBoardView data={data} busy={busy} onSelect={selectItem}
                onConfirm={(proposal, as) => {
                  if (as === 'hit' && proposal.suggest) {
                    void submit({ type: 'proposal.accept', proposalId: proposal.id, as, debtId: proposal.suggest.dupOf });
                  } else if (as !== 'hit') void submit({ type: 'proposal.accept', proposalId: proposal.id, as });
                }}
                onReject={proposal => openAction({ kind: 'reject', proposal })} />}
              {!utility && view === 'timeline' && <PlanningTimeline data={data} onSelect={selectItem} onBranch={selectBranch} projectLabel={projectLabel}
                onCreatePlan={write ? () => openAction({ kind: 'create', record: 'plan' }) : undefined} />}
              {!utility && view === 'debts' && <>
                <DebtLedger data={debts.data} stats={stats.data} label={branchLabel ? `${projectLabel} · ${branchLabel}` : projectLabel} />
                {checkup?.summary && !!(checkup.summary.duplicates || checkup.summary.pending || checkup.summary.closed) &&
                  <div className="ep-row ep-checkup-summary" aria-label="今日巡检">
                    <strong>今日巡检</strong>
                    {checkup.summary.duplicates > 0 && <button type="button" className="ep-text-button" onClick={() => {
                      setPages([]); setSearch(''); change({ status: 'dup', q: '', branch: '', tag: '', tagMatch: '', priority: '', owner: '', source: '', batch: '' });
                    }}>疑似重复 {checkup.summary.duplicates} 组</button>}
                    {checkup.summary.pending > 0 && <button type="button" className="ep-text-button" onClick={() => {
                      setPages([]); setSearch(''); change({ status: 'pending_extinct', q: '', branch: '', tag: '', tagMatch: '', priority: '', owner: '', source: '', batch: '' });
                    }}>疑似消灭 {checkup.summary.pending} 笔</button>}
                    {!!checkup.summary.closed && <span>到期关闭 {checkup.summary.closed} 笔</span>}
                  </div>}
                {batch && <div className="ep-row ep-lifecycle-actions"><button type="button" className="ep-button" onClick={() => {
                  setPages([]); change({ batch: '' }, true);
                }}>清除导入批次筛选</button></div>}
                <DebtSearch data={debts.data} search={search} filters={{ status, sort, priority, tag, owner, source }} onSearch={setSearch}
                  onFilter={next => { setPages([]); change('tag' in next ? { ...next, tagMatch: '' } : next, true); }} />
                {write && status === 'pending_extinct' && <div className="ep-row ep-lifecycle-actions">
                  <button type="button" className="ep-button" disabled={busy} onClick={() => {
                    void submit({ type: 'debt.sweep', ...(branch ? { branch } : {}) });
                  }}><RefreshCw aria-hidden="true" />巡检到期债务</button>
                </div>}
                {debts.data ? <DebtList data={debts.data} previous={pages.length > 0} onSelect={selectItem}
                  onPrevious={() => setPages(values => values.slice(0, -1))} onNext={next => setPages(values => [...values, next])} />
                  : <ReadStatus loading={debts.loading} error={debts.error} onRetry={() => { setPages([]); refresh(); }} />}
              </>}
              {!utility && view === 'map' && (stats.data
                ? <PlanningGraph key={`${activeProject}:${branch}`} data={stats.data} onSelect={selectItem} scopeLabel={branchLabel || projectLabel} projectLabel={projectLabel}
                  onCategory={(name, outcome, exact) => {
                    setPages([]); setSearch('');
                    const next = outcome === 'repaid' ? 'direct_repaid' : outcome === 'cancelled' ? 'void' : outcome;
                    change({ view: 'debts', tag: name, tagMatch: exact ? 'exact' : '', q: '', status: next, owner: '', source: '', priority: '', batch: '' });
                  }} />
                : <ReadStatus loading={stats.loading} error={stats.error} onRetry={refresh} />)}
              {!utility && view === 'evolution' && <>
                <div className="ep-evolution-actions">
                  <div className="ep-range-tabs" role="group" aria-label="统计时间范围">{ranges.map(([days, label]) =>
                    <button type="button" key={days} aria-pressed={range === days} onClick={() => setRange(days)}>{label}</button>)}</div>
                  {stats.data && <span className="ep-range-caption">{monthDay(stats.data.from)} – {monthDay(stats.data.to)}</span>}
                  <button type="button" className="ep-button ep-projection-toggle" disabled={!stats.data} onClick={() => setScreen(true)}><Maximize2 aria-hidden="true" />投屏</button>
                </div>
                {stats.data ? <PlanningEvolution data={stats.data} screen={false} projectLabel={projectLabel} onSelect={selectItem}
                  onReviewDue={() => { setPages([]); setSearch(''); change({ view: 'debts', status: 'review_due', q: '', tag: '', tagMatch: '', owner: '', source: '', priority: '', batch: '' }); }} />
                  : <ReadStatus loading={stats.loading} error={stats.error} onRetry={refreshStats} />}
              </>}

              {selected && <PlanningDetailDialog item={selected} board={data} detail={debtDetail.data}
                projectLabel={projectLabel}
                loading={selected.kind === 'debt' && debtDetail.loading && !debtDetail.data} error={selected.kind === 'debt' ? debtDetail.error : undefined}
                actionsDisabled={busy || board.loading || (selected.kind === 'debt' && debtDetail.loading)}
                onClose={() => { if (!action) change({ item: '', kind: '' }, true); }} onRetry={refresh} onSelect={selectItem} onAction={openAction} onBranch={selectBranch}
                onBack={detailTrail.length && detailTrail.at(-1)?.id !== selected.id ? backDetail : undefined}
                onOpenList={id => { setPages([]); setSearch(id); change({ view: 'debts', status: 'all', q: id, priority: '', owner: '', source: '', tag: '', tagMatch: '', branch: '', item: '', kind: '', batch: '' }); }} />}
              {action && <PlanningActionDialog key={action.kind} action={action} board={data} busy={busy} error={error}
                returnFocusTo={actionEntry?.returnFocusTo}
                onClose={() => { setError(''); setActionEntry(undefined); }} onSubmit={input => { void submit(input); }} onOpenRecord={selectItem} />}
            </>}
    </Workspace>
  </AppShell>;
}
