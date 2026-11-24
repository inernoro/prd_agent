import type { ReactNode } from 'react';
import { Check, ChevronDown, ChevronRight, Clock3, Flame, Ghost, Search, Signal, X } from 'lucide-react';
import {
  planningClosureDays, type DebtPriority, type PlanningDebt, type PlanningDebtList, type PlanningDebtView, type PlanningStats,
} from '../../../../src/shared/engineering-planning';
import { DebtHealthBadge } from './DebtHealth';
import { closedDebt, dateLabel, debtLabels, priorityLabels, shortId, sourceLabels } from './planning-ui';

export type PlanningSelection = { kind: 'debt' | 'decision' | 'plan'; id: string };
export const inactiveLabels = { cancelled: '已取消', superseded: '已替代', extinct: '随功能消失', merged: '已合并' };
export const debtState = (row: PlanningDebt) => row.outcome ? inactiveLabels[row.outcome.kind] : debtLabels[row.status];

export function PlanningEmpty({ children }: { children: ReactNode }) {
  return <div className="ep-empty">{children}</div>;
}

export function PlanningBadge({ tone = 'quiet', children }: { tone?: 'quiet' | 'warning' | 'success' | 'accent' | 'info'; children: ReactNode }) {
  return <span className="ep-badge" data-tone={tone}>{children}</span>;
}

export function DebtCoin({ debt }: { debt: PlanningDebt }) {
  if (!closedDebt(debt.status) && debt.anchor?.status === 'missing') {
    return <span className="ep-coin" data-status="pending-extinct" aria-hidden="true"><Ghost /></span>;
  }
  return <span className="ep-coin" data-status={debt.status} aria-hidden="true">
    {debt.status === 'repaid' ? <Check /> : debt.status === 'deferred' ? <Clock3 /> : null}
  </span>;
}

export function DebtPriorityBadge({ priority }: { priority: DebtPriority }) {
  return <span className="ep-priority" data-priority={priority}><Signal aria-hidden="true" />{priorityLabels[priority]}</span>;
}

export const debtFilters: readonly [PlanningDebtView, string][] = [
  ['unpaid', '未还'], ['review_due', '到期回看'], ['dup', '疑似重复'], ['pending_extinct', '疑似消灭'], ['overdue', '计划逾期'],
  ['in_progress', '处理中'], ['reopened', '重开过'], ['repaid', '已偿还'], ['all', '全部'],
];
const extraViews: readonly [PlanningDebtView, string][] = [
  ['extinct', '随功能消失'], ['merged', '合并'], ['void', '取消或替代'],
  ['collateral', '连带偿还'], ['direct_repaid', '主动偿还'], ['deferred', '已暂缓'],
];
const sorts = [
  ['deadline', '默认排序'], ['updated', '最近更新'], ['oldest', '最早登记'], ['interest', '被踩次数'], ['priority', '优先级'],
];
const week = 86_400_000;

export function DebtDeadline({ debt, today, large, at = Date.now() }: { debt: PlanningDebt; today: string; large?: boolean; at?: number }) {
  const review = debt.status === 'deferred';
  const date = review ? debt.reviewAt : debt.dueAt;
  if (closedDebt(debt.status)) return <span className="ep-deadline ep-deadline--muted">{large ? debtState(debt) : '—'}</span>;
  if (debt.anchor?.status === 'missing') {
    const cutoff = debt.anchor.closeAt;
    const remaining = planningClosureDays(cutoff, at);
    return <span className={large ? 'ep-deadline ep-deadline--large' : 'ep-deadline'}>
      <span className="ep-due-chip" data-tone="review">{remaining > 0 ? <>缓冲期还剩 <strong>{remaining}</strong> 天</> : '已到期待巡检'}</span>
      <time dateTime={cutoff}>{dateLabel(cutoff)}</time>
    </span>;
  }
  if (!date) return <span className="ep-deadline ep-deadline--muted">{debt.trigger ? '等待触发' : large ? '偿还日期待定' : '—'}</span>;
  const days = Math.round((Date.parse(date) - Date.parse(today)) / week);
  const tone = review ? 'review' : days < 0 ? 'bad' : days <= 7 ? 'soon' : 'calm';
  const label = review ? (days <= 0 ? '回看逾期' : '回看还剩') : days < 0 ? '逾期' : '还剩';
  const [, month, day] = date.split('-').map(Number);
  return <span className={`ep-deadline${large ? ' ep-deadline--large' : ''}`}>
    <span className="ep-due-chip" data-tone={tone}>{days === 0 ? (review ? '今日回看' : '今天到期') : <>{label} <strong>{Math.abs(days)}</strong> 天</>}</span>
    <time dateTime={date}>{review ? '回看' : '预计'} {month}月{day}日</time>
  </span>;
}

export function DebtLedger({ data, stats, label }: { data?: PlanningDebtList; stats?: PlanningStats; label: string }) {
  const ledger = data?.ledger ?? { unpaid: stats?.backlogEnd ?? 0, repaid: data?.counts?.repaid ?? 0, extinct: data?.counts?.extinct ?? 0, verified: undefined };
  return <div className="ep-ledger" aria-label="债务账本">
    <div className="ep-ledger-body">
      <h2 className="sr-only">债务清单</h2>
      <div className="ep-ledger-metrics">
        <span data-tone="owed">欠 <strong>{ledger.unpaid.toLocaleString()}</strong><small>笔</small></span>
        <span data-tone="paid">已还 <strong>{ledger.repaid.toLocaleString()}</strong><small>笔</small></span>
        <span data-tone="gone">随功能消灭 <strong>{ledger.extinct.toLocaleString()}</strong><small>笔</small></span>
      </div>
      <p>{label}{stats && <> · 近 30 天新增 {stats.created}、还掉 {stats.repaid}、消灭 {stats.extinct}</>}
        {ledger.verified !== undefined && <> · 已认证 {ledger.verified} 笔</>}</p>
    </div>
  </div>;
}

type DebtFilterFields = { priority: string; owner: string; source: string; tag: string; sort: string; status: string };

export function DebtSearch({ search, data, filters, onSearch, onFilter }: {
  search: string; data?: PlanningDebtList; filters: DebtFilterFields;
  onSearch: (text: string) => void; onFilter: (next: Partial<DebtFilterFields>) => void;
}) {
  const selectedPriorities = filters.priority.split(',').filter(Boolean);
  const extraCount = [filters.owner, filters.source, filters.tag].filter(Boolean).length;
  const categories = [...new Set((data?.filterOptions?.tags ?? []).flatMap(tag => [tag.split('/')[0], tag]))].sort();
  const options = [...debtFilters, ...extraViews.filter(([value]) => value === filters.status)];
  return <div className="ep-debt-controls">
    <div className="ep-filter ep-list-filters">
      <label className="ep-search"><Search aria-hidden="true" /><span className="sr-only">搜索债务</span>
        <input type="search" placeholder="搜索编号、标题、来源、根因、负责人" value={search} onChange={event => onSearch(event.target.value)} maxLength={200} /></label>
      <div className="ep-priority-pills" role="group" aria-label="优先级">{(['high', 'mid', 'low'] as const).map(priority => {
        const pressed = selectedPriorities.includes(priority);
        return <button type="button" key={priority} aria-pressed={pressed} aria-label={`${priorityLabels[priority]}优先级`}
          onClick={() => onFilter({ priority: (pressed ? selectedPriorities.filter(value => value !== priority) : [...selectedPriorities, priority]).join(',') })}>
          <DebtPriorityBadge priority={priority} />
        </button>;
      })}</div>
      <details className="ep-list-filter-menu">
        <summary className="ep-button">筛选{extraCount > 0 && <span className="ep-filter-count">{extraCount}</span>}<ChevronDown aria-hidden="true" /></summary>
        <div className="ep-list-filter-pop">
          <label className="ep-field"><span>负责人</span><select value={filters.owner} onChange={event => onFilter({ owner: event.target.value })}>
            <option value="">全部</option>{(data?.filterOptions?.owners ?? []).map(owner => <option key={owner}>{owner}</option>)}
          </select></label>
          <label className="ep-field"><span>标签</span><select value={filters.tag} onChange={event => onFilter({ tag: event.target.value })}>
            <option value="">全部</option>{[...(filters.tag && !categories.includes(filters.tag) ? [filters.tag] : []), ...categories].map(tag => <option key={tag}>{tag}</option>)}
          </select></label>
          <label className="ep-field"><span>来源</span><select value={filters.source} onChange={event => onFilter({ source: event.target.value })}>
            <option value="">全部</option>{Object.entries(sourceLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select></label>
          {extraCount > 0 && <button type="button" className="ep-button" onClick={() => onFilter({ owner: '', source: '', tag: '' })}>清空筛选</button>}
        </div>
      </details>
      {filters.tag && <button type="button" className="ep-button ep-clear-tag" onClick={() => onFilter({ tag: '' })}>
        {filters.tag}<X aria-label="清除标签筛选" />
      </button>}
    </div>
    <div className="ep-debt-list-bar">
      <div className="ep-debt-segments" role="group" aria-label="债务状态">
        {options.filter(([value]) => !['dup', 'pending_extinct'].includes(value) || !!data?.counts?.[value] || filters.status === value).map(([value, label]) =>
          <button type="button" key={value} data-view={value} aria-label={label} aria-pressed={filters.status === value} onClick={() => onFilter({ status: value })}>
            {label}{data?.counts?.[value] !== undefined && <span>{data.counts[value]}</span>}
          </button>)}
      </div>
      <div className="ep-debt-list-order">
        <span>共 {data?.total ?? data?.items.length ?? 0} 笔</span>
        <label><span className="sr-only">排序方式</span><select value={filters.sort} onChange={event => onFilter({ sort: event.target.value })}>
          {sorts.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </select></label>
      </div>
    </div>
  </div>;
}

export function DebtList({ data, previous, onPrevious, onNext, onSelect }: {
  data: PlanningDebtList; previous: boolean; onPrevious: () => void; onNext: (cursor: string) => void;
  onSelect: (item: PlanningSelection) => void;
}) {
  const at = data.asOf ? Date.parse(data.asOf) : Date.now();
  return <section className="ep-surface ep-debt-surface" aria-label="债务清单">
    {!data.items.length ? <PlanningEmpty>没有符合条件的债务</PlanningEmpty> : <>
      <div className="ep-debt-header" aria-hidden="true"><span /><span>债务</span><span>期限</span><span>状态</span><span>优先级</span><span>负责人</span><span /></div>
      <ul className="ep-debts">{data.items.map(debt => <li key={debt.id}>
        <button className="ep-debt-line" type="button" aria-label={debt.title} onClick={() => onSelect({ kind: 'debt', id: debt.id })}>
          <DebtCoin debt={debt} />
          <span className="ep-debt-title">
            <strong>{debt.title}<DebtHealthBadge debt={debt} at={at} />
              {debt.hitCount > 0 && <span className="ep-hit-count"><Flame aria-hidden="true" />{debt.hitCount}</span>}</strong>
            <small><span className="ep-id" title={debt.id}>{shortId(debt.id)}</span> · {sourceLabels[debt.source.type]} · {debt.source.ref}
              {debt.tags?.slice(0, 2).map(tag => <span className="ep-row-tag" key={tag}>{tag}</span>)}</small>
          </span>
          <DebtDeadline debt={debt} today={data.today} at={at} />
          <span className="ep-row-state" data-status={debt.status}><i />{debtState(debt)}</span>
          <DebtPriorityBadge priority={debt.priority} />
          <span className="ep-row-owner">{debt.owner || '待认领'}</span>
          <ChevronRight className="ep-row-open" aria-hidden="true" />
        </button>
      </li>)}</ul>
      {(previous || data.nextCursor) && <footer className="ep-pagination">
        <button type="button" className="ep-button" disabled={!previous} onClick={onPrevious}>上一页</button>
        <button type="button" className="ep-button" disabled={!data.nextCursor} onClick={() => data.nextCursor && onNext(data.nextCursor)}>下一页</button>
      </footer>}
    </>}
  </section>;
}
