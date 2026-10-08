import { useState } from 'react';
import { ArrowRight, AlertTriangle, CheckCircle2, Search, Settings2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { formatRelative, proberLiveness, SOURCE_META, type UptimeSummary, type UptimeTargetSummary } from '@/lib/monitorCenter';
import { businessProjects, catalogProjects, explainTarget, HOME_STATES, homeState, sortHomeTargets, type HomeState } from '@/lib/statusHome';

export function HomeStateBadge({ state }: { state: HomeState }): JSX.Element {
  return <span className={cn('status-home-badge', state === 'down' ? 'text-destructive bg-destructive/10' : state === 'up' ? 'text-ok bg-ok-soft' : 'text-muted-foreground bg-muted')}>{HOME_STATES[state]}</span>;
}

export function BusinessHome({ targets, now, summary, onOpen, onProject, onManage, onCoverage }: {
  targets: UptimeTargetSummary[]; now: number; summary: UptimeSummary;
  onOpen: (id: string) => void; onProject: (id: string) => void; onManage: () => void; onCoverage: () => void;
}): JSX.Element {
  const projects = businessProjects(targets, now);
  const business = sortHomeTargets(targets.filter((t) => t.source === 'custom'), now);
  const issues = business.filter((t) => homeState(t, now) === 'down');
  const uncertain = business.filter((t) => ['unknown', 'overdue'].includes(homeState(t, now)));
  const paused = business.filter((t) => homeState(t, now) === 'paused');
  const [showAll, setShowAll] = useState(false);
  return <div className="status-home-layout">
    <div className="status-home-primary">
      <section className={cn('status-home-panel status-home-conclusion', issues.length ? 'border-destructive/40' : 'border-[hsl(var(--hairline))]')}>
        <div className="flex items-start gap-3">
          {issues.length ? <AlertTriangle className="mt-1 h-6 w-6 shrink-0 text-destructive" /> : <CheckCircle2 className="mt-1 h-6 w-6 shrink-0 text-muted-foreground" />}
          <div><h1>{issues.length ? `${issues.length} 项业务检查需要处理` : business.length ? (!summary.enabled || proberLiveness(summary)?.stalled ? '检查未持续运行，当前状态待确认' : '当前未发现业务检查异常') : '还没有业务监控'} </h1>
            <p className="status-home-muted">{business.length ? `已接入 ${projects.length} 个项目、${business.length} 项业务检查。${uncertain.length ? `其中 ${uncertain.length} 项待确认，` : ''}${paused.length ? `${paused.length} 项已暂停，` : ''}结论仅覆盖已接入的检查。` : '添加关键业务检查后，这里会展示哪个项目出问题、下一步如何处理。'}</p>
          </div>
        </div>
        <div className="status-home-issues">
          {(showAll ? issues : issues.slice(0, 1)).map((target) => <button key={target.id} onClick={() => onOpen(target.id)} className="status-home-issue">
            <div className="flex flex-wrap items-center gap-2"><HomeStateBadge state="down" /><span className="status-home-muted">{target.projectName || target.projectId} · {target.environmentLabel}</span></div>
            <strong>{target.name}</strong><p>{explainTarget(target).impact}</p>
            <span className="status-home-link">查看原因与处理建议 <ArrowRight className="h-4 w-4" /></span>
          </button>)}
          {issues.length > 1 && <Button variant="outline" onClick={() => setShowAll(!showAll)}>{showAll ? '收起' : `查看全部 ${issues.length} 项异常`}</Button>}
        </div>
      </section>
      <section>
        <div className="status-home-section-heading"><h2>我的业务</h2><span className="status-home-muted">按项目查看，异常优先</span></div>
        <div className="status-home-projects">
          {projects.map((project) => <button key={project.id} className="status-home-panel status-home-project" onClick={() => onProject(project.id)}>
            <div className="flex items-start justify-between gap-3"><h3>{project.name}</h3><HomeStateBadge state={project.state} /></div>
            <p className="status-home-muted">{project.targets.length} 项检查 · {project.counts.up} 项正常</p>
            <p>{project.counts.down ? `${project.counts.down} 项待处理：${project.targets[0].name}` : project.counts.overdue + project.counts.unknown ? `${project.counts.overdue + project.counts.unknown} 项缺少足够的最新证据` : project.counts.paused ? `${project.counts.paused} 项暂停，不计为正常` : '已接入的检查均通过'}</p>
            <span className="status-home-link">查看监控 <ArrowRight className="h-4 w-4" /></span>
          </button>)}
        </div>
        {!projects.length && <div className="status-home-panel"><p>在监控管理中添加业务检查，或通过服务自检发现已有指标。</p><Button onClick={onManage}>配置业务监控</Button></div>}
      </section>
    </div>
    <aside className="status-home-aside">
      <section className="status-home-panel"><h2>监控覆盖</h2><p className="status-home-muted">没有接入、没有样本和暂停的业务，都不能当作正常。</p>
        <dl className="status-home-counts"><div><dt>有最新通过结果</dt><dd>{business.filter((t) => homeState(t, now) === 'up').length}</dd></div><div><dt>待确认 / 检查逾期</dt><dd>{uncertain.length}</dd></div><div><dt>暂停或排除</dt><dd>{paused.length}</dd></div></dl>
        <Button variant="outline" onClick={onCoverage}>查看探测覆盖</Button>
      </section>
      <section className="status-home-panel"><h2>数据与管理</h2><p className="status-home-muted">更新于 {new Date(summary.generatedAt).toLocaleTimeString('zh-CN')}，每 30 秒刷新。</p><p>配置、通知通道、自检发现与演练仍在监控管理中。</p><Button variant="outline" onClick={onManage}><Settings2 />监控管理</Button></section>
    </aside>
  </div>;
}

export function MonitorCatalog({ targets, now, projectId, onProject, onOpen }: {
  targets: UptimeTargetSummary[]; now: number; projectId: string | null; onProject: (id: string | null) => void; onOpen: (id: string) => void;
}): JSX.Element {
  const [query, setQuery] = useState('');
  const [state, setState] = useState<HomeState | 'all'>('all');
  const [source, setSource] = useState('custom');
  const [page, setPage] = useState(0);
  const projectOptions = catalogProjects(targets);
  const shown = sortHomeTargets(targets.filter((t) => (projectId === null || t.projectId === projectId) && (source === 'all' || t.source === source) && (state === 'all' || homeState(t, now) === state) && `${t.name} ${t.projectName || ''} ${t.projectId}`.toLowerCase().includes(query.toLowerCase().trim())), now);
  const maxPage = Math.max(0, Math.ceil(shown.length / 20) - 1);
  const currentPage = Math.min(page, maxPage);
  return <section className="status-home-panel status-home-catalog">
    <h1>监控列表</h1><p className="status-home-muted">每项保留独立的检查状态与故障记录，默认查看业务监控。</p>
    <div className="status-home-filters">
      <label className="status-home-search"><Search className="h-5 w-5" /><input aria-label="搜索监控" placeholder="搜索业务或项目" value={query} onChange={(e) => { setQuery(e.target.value); setPage(0); }} /></label>
      <select aria-label="项目" value={projectId ?? '*'} onChange={(e) => { onProject(e.target.value === '*' ? null : e.target.value); setPage(0); }}><option value="*">全部项目</option>{[...projectOptions].map(([id, name]) => <option key={id} value={id}>{name}</option>)}</select>
      <select aria-label="监控来源" value={source} onChange={(e) => { setSource(e.target.value); setPage(0); }}><option value="custom">业务监控</option><option value="release">生产发布目标</option><option value="branch">分支预览服务</option><option value="all">全部来源</option></select>
      <select aria-label="检查状态" value={state} onChange={(e) => { setState(e.target.value as HomeState | 'all'); setPage(0); }}><option value="all">全部状态</option>{Object.entries(HOME_STATES).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select>
    </div>
    <p className="status-home-muted" role="status">共 {shown.length} 项 · 第 {currentPage + 1} / {maxPage + 1} 页</p>
    <div className="status-home-rows">{shown.slice(currentPage * 20, (currentPage + 1) * 20).map((t) => <button key={t.id} className="status-home-row" onClick={() => onOpen(t.id)}>
      <HomeStateBadge state={homeState(t, now)} /><div className="min-w-0 flex-1"><strong>{t.name}</strong><p className="status-home-muted">{t.projectName || t.projectId || '未归属项目'} · {t.environmentLabel} · {SOURCE_META[t.source].label}</p><p>{homeState(t, now) === 'down' ? explainTarget(t).impact : homeState(t, now) === 'up' ? '最近检查通过' : homeState(t, now) === 'paused' ? '检查暂停或排除，无法提供当前结论' : '缺少足够的最新检查证据'}</p></div><span className="status-home-muted">{t.lastSample ? formatRelative(t.lastSample.t, now) : '尚无检查'}</span><ArrowRight className="h-5 w-5 shrink-0" />
    </button>)}</div>
    {!shown.length && <p className="py-8 text-center">没有符合条件的监控，请调整筛选或在监控管理中添加。</p>}
    <div className="status-home-pagination"><Button variant="outline" disabled={currentPage === 0} onClick={() => setPage(currentPage - 1)}>上一页</Button><Button variant="outline" disabled={currentPage === maxPage} onClick={() => setPage(currentPage + 1)}>下一页</Button></div>
  </section>;
}
