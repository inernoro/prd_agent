import type { ReactNode } from 'react';
import { ArrowDownRight, ArrowRight, CalendarDays, Check, CircleDot, Clock3, GitBranch, Layers3, ListFilter, Search } from 'lucide-react';
import type {
  PlanningBoard, PlanningDebt, PlanningDebtList, PlanningDecision, PlanningPlan, PlanningProposal, PlanningStats,
} from '../../../../src/shared/engineering-planning';
import { closedDebt, dateLabel, debtLabels, decisionLabels, events, kindLabels, priorityLabels, shortId, sourceLabels, stepLabels } from './planning-ui';

export type PlanningSelection = { kind: 'debt' | 'decision' | 'plan'; id: string };
export const inactiveLabels = { cancelled: '已取消', superseded: '已替代', extinct: '随功能消失', merged: '已合并' };
export const debtState = (row: PlanningDebt) => row.outcome ? inactiveLabels[row.outcome.kind] : debtLabels[row.status];

export function PlanningEmpty({ children }: { children: ReactNode }) {
  return <div className="ep-empty">{children}</div>;
}
export function PlanningBadge({ tone = 'quiet', children }: { tone?: 'quiet' | 'warning' | 'success' | 'accent' | 'info'; children: ReactNode }) {
  return <span className="ep-badge" data-tone={tone}>{children}</span>;
}

function DecisionCard({ decision, plans, onSelect, reason }: {
  decision: PlanningDecision; plans: PlanningPlan[]; onSelect: (item: PlanningSelection) => void; reason?: string;
}) {
  const decisionsPlans = plans.filter(plan => plan.decisionId === decision.id);
  return <article className="ep-card">
    <div className="ep-card-info"><span className="ep-id" title={decision.id}>{shortId(decision.id)}</span><PlanningBadge>{decisionLabels[decision.status]}</PlanningBadge></div>
    <button type="button" className="ep-text-button ep-card-title" onClick={() => onSelect({ kind: 'decision', id: decision.id })}>{decision.title}</button>
    {reason ? <p className="ep-reason">{reason}</p> : decision.summary ? <p className="ep-clamp">{decision.summary}</p> : null}
    <footer>{decisionsPlans.length ? <span><Layers3 />{decisionsPlans.length} 个落地计划</span> : null}{decision.owner ? <span>{decision.owner}</span> : null}</footer>
  </article>;
}

export function PlanningBoardView({ data, busy, onSelect, onConfirm, onReject }: {
  data: PlanningBoard; busy: boolean; onSelect: (item: PlanningSelection) => void;
  onConfirm: (item: PlanningProposal) => void; onReject: (item: PlanningProposal) => void;
}) {
  const pending = data.proposals.filter(item => item.status === 'pending');
  const review = data.decisions.filter(item => item.status === 'accepted' && item.reviewAt && item.reviewAt <= data.today
    && (!item.reviewedAt || item.reviewedAt.slice(0, 10) < item.reviewAt));
  const active = data.decisions.filter(item => item.status === 'proposed' || item.status === 'accepted');
  const done = data.decisions.filter(item => item.status === 'superseded' || item.status === 'deprecated');
  const stalled = active.flatMap(decision => {
    const late = data.plans.filter(plan => plan.decisionId === decision.id).flatMap(plan =>
      plan.steps.filter(step => step.dueAt && step.dueAt < data.today && step.status !== 'done' && step.status !== 'cancelled'));
    const idle = (Date.parse(data.today) - Date.parse(decision.updatedAt.slice(0, 10))) / 86_400_000;
    if (late.length) return [{ decision, reason: `${late.length} 个落地步骤逾期` }];
    if (decision.status === 'proposed' && idle >= 14) return [{ decision, reason: `提议 ${Math.floor(idle)} 天未形成结论` }];
    return [];
  });
  const advancing = active.filter(row => !stalled.some(item => item.decision.id === row.id) && !review.includes(row));
  const approval = data.permissions.includes('approve');
  return <div className="ep-board" aria-label="推进看板">
    <section className="ep-lane" data-lane="pending" aria-label="待你确认">
      <header><CircleDot /><h2>待你确认</h2><span>{pending.length + review.length}</span></header>
      <div className="ep-lane-items">
        {pending.map(proposal => <article className="ep-card" key={proposal.id}>
          <div className="ep-card-info"><span className="ep-id" title={proposal.id}>{shortId(proposal.id)}</span><PlanningBadge tone="accent">{kindLabels[proposal.kind]}提案</PlanningBadge></div>
          <h3>{proposal.draft.title}</h3>
          {proposal.draft.summary && <p className="ep-clamp">{proposal.draft.summary}</p>}
          <p className="ep-source">{proposal.author.label} · {sourceLabels[proposal.source.type]} · {proposal.source.ref}</p>
          {proposal.source.url && <a className="ep-link" href={proposal.source.url} target="_blank" rel="noreferrer">打开来源 <ArrowDownRight /></a>}
          {approval && <div className="ep-row"><button type="button" className="ep-button ep-button--primary" disabled={busy} onClick={() => onConfirm(proposal)}>确认提案</button>
            <button type="button" className="ep-button" disabled={busy} onClick={() => onReject(proposal)}>驳回</button></div>}
        </article>)}
        {review.map(decision => <DecisionCard key={decision.id} decision={decision} plans={data.plans} onSelect={onSelect} reason="已到复核时间" />)}
        {!pending.length && !review.length && <PlanningEmpty>暂无待确认提案</PlanningEmpty>}
      </div>
    </section>
    <section className="ep-lane" data-lane="stuck" aria-label="卡住了">
      <header><Clock3 /><h2>卡住了</h2><span>{stalled.length}</span></header>
      <div className="ep-lane-items">
        {stalled.map(({ decision, reason }) => <DecisionCard key={decision.id} decision={decision} plans={data.plans} onSelect={onSelect} reason={reason} />)}
        {!stalled.length && <PlanningEmpty>暂无卡住的决策</PlanningEmpty>}
      </div>
    </section>
    <section className="ep-lane" data-lane="moving" aria-label="推进中">
      <header><GitBranch /><h2>推进中</h2><span>{advancing.length}</span></header>
      <div className="ep-lane-items">
        {advancing.map(decision => <DecisionCard key={decision.id} decision={decision} plans={data.plans} onSelect={onSelect} />)}
        {!advancing.length && <PlanningEmpty>暂无正在推进的决策</PlanningEmpty>}
      </div>
    </section>
    <section className="ep-lane" data-lane="done" aria-label="已完结">
      <header><Check /><h2>已完结</h2><span>{done.length}</span></header>
      <div className="ep-lane-items">
        {done.map(decision => <DecisionCard key={decision.id} decision={decision} plans={data.plans} onSelect={onSelect} />)}
        {!done.length && <PlanningEmpty>暂无已完结决策</PlanningEmpty>}
      </div>
    </section>
  </div>;
}

export function PlanningTimeline({ data, onSelect }: { data: PlanningBoard; onSelect: (item: PlanningSelection) => void }) {
  return <div className="ep-timeline">
    <section className="ep-surface">
      <header className="ep-section-header"><div><h2>接下来 · 落地路线</h2></div><CalendarDays /></header>
      <div className="ep-plan-grid">
        {data.plans.map(plan => {
          const done = plan.steps.filter(step => step.status === 'done').length;
          const progress = plan.steps.length ? Math.round(done * 100 / plan.steps.length) : 0;
          return <article className="ep-card" key={plan.id}>
            <div className="ep-card-info"><span className="ep-id" title={plan.id}>{shortId(plan.id)}</span>{plan.dueAt && <PlanningBadge>{plan.dueAt}</PlanningBadge>}</div>
            <button type="button" className="ep-text-button ep-card-title" onClick={() => onSelect({ kind: 'plan', id: plan.id })}>{plan.title}</button>
            <div className="ep-meter"><span style={{ width: `${progress}%` }} /></div>
            <p>{done} / {plan.steps.length} 步完成</p>
            {plan.steps.length > 0 && <ol className="ep-steps-mini">{plan.steps.slice(0, 4).map(step => <li key={step.id}>{step.title}<span>{stepLabels[step.status]}</span></li>)}</ol>}
          </article>;
        })}
      </div>
      {!data.plans.length && <PlanningEmpty>暂无落地计划</PlanningEmpty>}
    </section>
    <div className="ep-today"><span>今天 · {data.today}</span></div>
    <section className="ep-surface">
      <header className="ep-section-header"><h2>决策记录</h2><GitBranch /></header>
      <ol className="ep-events">
        {data.events.filter(event => event.entity === 'decision' || event.entity === 'plan').map(event => {
          const list = event.entity === 'decision' ? data.decisions : data.plans;
          const record = list.find(row => row.id === event.entityId);
          return <li key={event.id}>
            <time dateTime={event.at}>{dateLabel(event.at)}</time>
            <div><PlanningBadge>{events[event.type]}</PlanningBadge> {record && <button type="button" className="ep-text-button" onClick={() => onSelect({ kind: event.entity === 'decision' ? 'decision' : 'plan', id: record.id })}>{record.title}</button>}
              {event.note && <p>{event.note}</p>}<span className="ep-caption">{event.actor.label}</span></div>
          </li>;
        })}
      </ol>
      {!data.events.some(event => event.entity === 'decision' || event.entity === 'plan') && <PlanningEmpty>暂无决策记录</PlanningEmpty>}
    </section>
  </div>;
}

export const debtFilters = [
  ['unpaid', '未还'], ['review_due', '到期回看'], ['overdue', '计划逾期'],
  ['in_progress', '处理中'], ['repaid', '已偿还'], ['all', '全部'],
] as const;

export function DebtSearch({ search, status, onSearch, onStatus }: {
  search: string; status: string; onSearch: (text: string) => void; onStatus: (value: string) => void;
}) {
  return <div className="ep-filter">
    <label className="ep-search"><Search /><span className="sr-only">搜索债务</span>
      <input type="search" placeholder="搜索债务标题、编号或来源" value={search} onChange={event => onSearch(event.target.value)} maxLength={200} /></label>
    <label className="ep-input-with-icon"><ListFilter /><span className="sr-only">债务状态</span>
      <select value={status} onChange={event => onStatus(event.target.value)}>{debtFilters.map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select></label>
  </div>;
}

const deadline = (debt: PlanningDebt, today: string) => {
  const value = debt.status === 'deferred' ? debt.reviewAt : debt.dueAt;
  if (!value || closedDebt(debt.status)) return debt.trigger && !closedDebt(debt.status) ? '等待触发' : '—';
  const days = (Date.parse(value) - Date.parse(today)) / 86_400_000;
  if (debt.status === 'deferred') return days <= 0 ? '到期回看' : `${days} 天后回看`;
  return days < 0 ? `逾期 ${-days} 天` : days === 0 ? '今天到期' : `还剩 ${days} 天`;
};

export function DebtList({ data, previous, onPrevious, onNext, onSelect }: {
  data: PlanningDebtList; previous: boolean; onPrevious: () => void; onNext: (cursor: string) => void;
  onSelect: (item: PlanningSelection) => void;
}) {
  return <section className="ep-surface ep-debt-surface" aria-label="债务清单">
    {!data.items.length ? <PlanningEmpty>没有符合条件的债务</PlanningEmpty> : <>
      <div className="ep-debt-header" aria-hidden><span>债务</span><span>优先级</span><span>期限</span><span>状态</span></div>
      <ul className="ep-debts">{data.items.map(debt => <li key={debt.id}>
        <div className="ep-debt-title">
          <span className="ep-coin" data-status={debt.status} aria-hidden>{debt.status === 'repaid' ? <Check /> : closedDebt(debt.status) ? '结' : '欠'}</span>
          <div><button className="ep-text-button ep-card-title" type="button" onClick={() => onSelect({ kind: 'debt', id: debt.id })}>{debt.title}</button>
            <span className="ep-caption"><span className="ep-id" title={debt.id}>{shortId(debt.id)}</span> · {sourceLabels[debt.source.type]}{debt.owner ? ` · ${debt.owner}` : ''}{debt.hitCount ? ` · 被踩 ${debt.hitCount} 次` : ''}</span></div>
        </div>
        <span><PlanningBadge tone={debt.priority === 'high' ? 'warning' : debt.priority === 'mid' ? 'accent' : 'quiet'}>{priorityLabels[debt.priority]}</PlanningBadge></span>
        <span className="ep-deadline">{deadline(debt, data.today)}</span>
        <span><PlanningBadge tone={debt.status === 'repaid' ? 'success' : debt.status === 'deferred' ? 'warning' : 'quiet'}>{debtState(debt)}</PlanningBadge></span>
      </li>)}</ul>
      {(previous || data.nextCursor) && <footer className="ep-pagination">
        <button type="button" className="ep-button" disabled={!previous} onClick={onPrevious}>上一页</button>
        <button type="button" className="ep-button" disabled={!data.nextCursor} onClick={() => data.nextCursor && onNext(data.nextCursor)}>下一页</button>
      </footer>}
    </>}
  </section>;
}

export function PlanningGraph({ data, onCategory }: { data: PlanningStats; onCategory: (name: string) => void }) {
  const maximum = Math.max(1, ...data.categories.map(row => row.unpaid + row.repaid + row.dropped));
  return <section className="ep-surface ep-graph" aria-label="债务图谱">
    <header className="ep-section-header"><div><h2>债务分类图谱</h2><p>按当前标签组归类，多标签债务可出现在多个分类。</p></div><Layers3 /></header>
    {data.categories.length ? <><div className="ep-chart-key"><span data-tone="accent">未还</span><span data-tone="success">已偿还</span><span>已失效</span></div>
      <div className="ep-category-rows">{data.categories.map(row => <button type="button" className="ep-category" key={row.name} onClick={() => onCategory(row.name)}>
        <span>{row.name}</span><span className="ep-category-meter" role="img" aria-label={`未还 ${row.unpaid}，偿还 ${row.repaid}，失效 ${row.dropped}`}>
          <i data-tone="accent" style={{ width: `${row.unpaid * 100 / maximum}%` }} />
          <i data-tone="success" style={{ width: `${row.repaid * 100 / maximum}%` }} />
          <i style={{ width: `${row.dropped * 100 / maximum}%` }} />
        </span><span>{row.unpaid + row.repaid + row.dropped}</span><ArrowRight /></button>)}</div></> : <PlanningEmpty>暂无债务分类</PlanningEmpty>}
  </section>;
}

export function PlanningEvolution({ data, screen }: { data: PlanningStats; screen: boolean }) {
  const maximum = Math.max(1, data.backlogStart, ...data.buckets.map(row => row.backlog));
  const points = [data.backlogStart, ...data.buckets.map(row => row.backlog)];
  const line = points.map((value, index) => `${20 + index * 680 / (points.length - 1)},${155 - value / maximum * 125}`).join(' ');
  const peak = Math.max(1, ...data.buckets.map(row => Math.max(
    row.created + row.imported + row.reopened + row.transferredIn, row.repaid + row.dropped + row.extinct + row.merged + row.transferredOut,
  )));
  const metrics = [
    ['期末未还', data.backlogEnd, `期初 ${data.backlogStart}`],
    ['期间新增', data.created, `导入存量 ${data.imported}`],
    ['期间偿还', data.repaid, `重开 ${data.reopened}`],
    ['其他流出', data.dropped + data.extinct + data.merged, `失效 ${data.dropped} · 消失 ${data.extinct} · 合并 ${data.merged}`],
  ] as const;
  return <div className={`ep-evolution${screen ? ' ep-evolution--screen' : ''}`} aria-label="债务演进">
    <div className="ep-metrics">{metrics.map(([label, value, sub]) => <article className="ep-card" key={label}><h2>{label}</h2><strong>{value}</strong><p>{sub}</p></article>)}</div>
    <div className="ep-chart-grid">
      <section className="ep-surface">
        <header className="ep-section-header"><div><h2>未还存量</h2><p>{data.from} 至 {data.to} · 上海时间</p></div></header>
        <svg className="ep-trend" viewBox="0 0 720 175" preserveAspectRatio="none" role="img" aria-label={`未还存量从 ${data.backlogStart} 变为 ${data.backlogEnd} 笔`}>
          <path d="M20 30H700 M20 92.5H700 M20 155H700" className="ep-grid-lines" />
          <polygon points={`20,155 ${line} 700,155`} className="ep-trend-fill" />
          <polyline points={line} className="ep-trend-line" />
        </svg>
      </section>
      <section className="ep-surface">
        <header className="ep-section-header"><div><h2>流入与流出</h2><p>{data.transferredIn || data.transferredOut ? `转入 ${data.transferredIn} · 转出 ${data.transferredOut}` : '按日记录 · 笔数'}</p></div></header>
        <div className="ep-chart-key"><span data-tone="accent">流入</span><span data-tone="success">偿还</span><span>其他流出</span></div>
        <div className="ep-bar-chart" role="img" aria-label={`新增 ${data.created}，导入 ${data.imported}，重开 ${data.reopened}，已偿还 ${data.repaid}`}>
          {data.buckets.map(row => {
            const other = row.dropped + row.extinct + row.merged + row.transferredOut;
            const out = row.repaid + other;
            return <span className="ep-day-bar" key={row.day} title={`${row.day}：新增 ${row.created}、重开 ${row.reopened}、偿还 ${row.repaid}`}>
              <span className="ep-in-bar" style={{ height: `${(row.created + row.imported + row.reopened + row.transferredIn) / peak * 50}%` }} />
              <span className="ep-out-bar" style={{ height: `${out / peak * 50}%` }}>
                <i style={{ flex: row.repaid }} /><i style={{ flex: other }} />
              </span>
            </span>;
          })}
        </div>
      </section>
    </div>
  </div>;
}
