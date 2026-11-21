import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  Bot, CalendarDays, Check, ChevronRight, Clock3, Copy, ExternalLink, FileText, Flag, Flame,
  Folder, GitBranch, GitPullRequest, Layers, ListChecks, Play, Plus, RotateCcw, Target, TriangleAlert, UserRound,
} from 'lucide-react';
import { Link } from 'react-router-dom';
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { DropdownItem, DropdownMenu } from '@/components/ui/dropdown-menu';
import { ContentLoading } from '@/components/skeletons/ContentLoading';
import type {
  PlanningBoard, PlanningDebt, PlanningDebtList, PlanningDecision, PlanningDesignLink, PlanningEvent, PlanningPlan, PlanningProposal, PlanningSource, PlanningStep,
} from '../../../../src/shared/engineering-planning';
import { ConfigurationTrail, provenanceLabels } from './PlanningCompanion';
import type { PlanningAction } from './PlanningDialogs';
import { DecisionDocumentBadge, PlanningDecisionLinks, PlanningPullRequestBadge, PlanningPullRequestLink, PlanningPullRequestList } from './PlanningPullRequests';
import { inactiveLabels, PlanningBadge, PlanningEmpty, type PlanningSelection } from './PlanningViews';
import { closedDebt, dateLabel, debtLabels, decisionLabels, events, kindLabels, planningPath, priorityLabels, shortId, sourceLabels,
  stepKindLabels, stepLabels, usePlanningRead } from './planning-ui';
import './planning-decision.css';

const DAY = 86_400_000;
const planningDay = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai' });
const calendarDay = new Intl.DateTimeFormat('zh-CN', { timeZone: 'UTC', month: 'long', day: 'numeric' });
const calendarDate = new Intl.DateTimeFormat('zh-CN', { timeZone: 'UTC', dateStyle: 'long' });
const onDay = (value: string) => value.length === 10 ? value : planningDay.format(new Date(value));
const monthDay = (value: string) => calendarDay.format(new Date(onDay(value)));
const fullDate = (value: string) => calendarDate.format(new Date(onDay(value)));

const lanes = {
  pending: { label: '待你确认', icon: Bot, empty: '没有等你确认的事', hint: '技能发现的决策和债务，以及到了复核时间的决策' },
  stuck: { label: '卡住了', icon: TriangleAlert, empty: '没有卡住的决策' },
  moving: { label: '推进中', icon: Play, empty: '没有正在推进的决策' },
  done: { label: '已完结', icon: Check, empty: '没有已完结的决策' },
} as const;
const stepIcons = { task: Check, decision: Flag, debt: FileText, review: RotateCcw, design: Layers };
const planLabels = { planned: '已排期', doing: '进行中', done: '已完成', cancelled: '步骤已取消' } as const;
const decisionKindLabels = { forward: '正向决策', debt: '债务决策' } as const;
const proposalApprovals = { debt: '记下这笔债', decision: '采纳为决策', plan: '采纳为落地计划' } as const;
const decisionChangeLabels = {
  accepted: '采纳决策', amended: '补充决策说明', reviewed: '完成复核', superseded: '取代决策', deprecated: '废弃决策',
} as const;
const decisionHistoryLabels: Partial<Record<PlanningEvent['type'], string>> = { accepted: '采纳', amended: '修订' };

type Branch = NonNullable<PlanningBoard['debtBranches']>[string];
type SelectRecord = (item: PlanningSelection) => void;
type OpenAction = (action: PlanningAction, returnFocusTo?: HTMLElement | null) => void;
type ConfirmProposal = (item: PlanningProposal, as?: 'hit' | 'new') => void;
type Progress = { state: 'stuck' | 'moving' | 'done'; reasons: { text: string; blocked?: boolean }[] };

function stepIsLate(step: PlanningStep, today: string) {
  return step.status !== 'done' && step.status !== 'cancelled' && Boolean(step.dueAt && step.dueAt < today);
}

function planProgress(plan: PlanningPlan, today: string) {
  const steps = plan.steps.filter(step => step.status !== 'cancelled');
  const done = steps.filter(step => step.status === 'done').length;
  const total = steps.length;
  const late = steps.filter(step => stepIsLate(step, today)).length;
  const active = plan.steps.length > 0 ? done < total : true;
  const state: keyof typeof planLabels = !active ? (total ? 'done' : 'cancelled')
    : done || steps.some(step => step.status === 'doing') ? 'doing' : 'planned';
  return { done, total, late, active, state, percent: total ? Math.round(done * 100 / total) : 0 };
}

function planLabel(plan: PlanningPlan, state: keyof typeof planLabels) {
  const scheduled = plan.startAt || plan.dueAt || plan.steps.some(step => step.dueAt);
  return state === 'planned' && !scheduled ? '待安排' : planLabels[state];
}

function branchTotal(branch: Branch) {
  return branch.unpaid + branch.repaid + branch.extinct + branch.other;
}

function activePullRequests(decision: PlanningDecision) {
  return decision.pullRequests?.filter(pull => pull.state === 'open' || pull.state === 'draft') ?? [];
}

function daysSince(value: string, today: string) {
  return Math.floor((Date.parse(today) - Date.parse(onDay(value))) / DAY);
}

function recentlyChanged(value: string, today: string) {
  const elapsed = daysSince(value, today);
  return elapsed >= 0 && elapsed < 14;
}

function decisionProgress(decision: PlanningDecision, plans: PlanningPlan[], today: string, branch?: Branch): Progress {
  if (decision.status === 'superseded') return { state: 'done', reasons: [{
    text: decision.supersededBy ? `已被 ${shortId(decision.supersededBy)} 取代` : '已被取代',
  }] };
  if (decision.status === 'deprecated') return { state: 'done', reasons: [{ text: '已废弃' }] };
  const reasons: Progress['reasons'] = [];
  const completed: Progress['reasons'] = [];
  const live = activePullRequests(decision);
  if (decision.pullRequest && !decision.pullRequests?.length) reasons.push({ text: '关联 PR 等待同步' });
  for (const pull of live) {
    const idle = daysSince(pull.updatedAt, today);
    if (pull.checks === 'fail') reasons.push({ text: `PR #${pull.number} 检查失败`, blocked: true });
    if (idle >= 7) reasons.push({ text: `PR #${pull.number} ${idle} 天未更新`, blocked: true });
    if (pull.checks !== 'fail' && idle < 7) reasons.push({ text: `PR #${pull.number} ${pull.state === 'draft' ? '草稿' : '评审中'}` });
  }
  const merged = decision.pullRequests?.filter(pull => pull.state === 'merged').length ?? 0;
  if (merged) completed.push({ text: `${merged} 个 PR 已合并` });
  for (const plan of plans) {
    const progress = planProgress(plan, today);
    if (progress.late) reasons.push({ text: `${shortId(plan.id)} 有 ${progress.late} 个落地步骤逾期`, blocked: true });
    else if (progress.active && plan.dueAt && plan.dueAt < today) reasons.push({ text: `${shortId(plan.id)} 计划已逾期`, blocked: true });
    else if (progress.state === 'doing') reasons.push({ text: `${shortId(plan.id)} 进行中 ${progress.done}/${progress.total} 步` });
    else if (progress.active && plan.startAt && plan.startAt >= today) reasons.push({ text: `${shortId(plan.id)} 已排期，${monthDay(plan.startAt)} 开始` });
    else if (progress.active) reasons.push({ text: `${shortId(plan.id)} ${plan.steps.length ? '等待执行' : '尚未拆分步骤'}` });
    else if (progress.state === 'done') completed.push({ text: `${shortId(plan.id)} 已完成` });
  }
  if (decision.status === 'proposed') {
    const idle = live.reduce((previous, pull) => Math.min(previous, daysSince(pull.updatedAt, today)), daysSince(decision.updatedAt, today));
    reasons.push(idle >= 14 ? { text: `提议 ${idle} 天未形成结论`, blocked: true } : { text: '提议评审中' });
  }
  if (reasons.length) {
    reasons.sort((first, second) => Number(Boolean(second.blocked)) - Number(Boolean(first.blocked)));
    return { state: reasons[0].blocked ? 'stuck' : 'moving', reasons };
  }
  return { state: 'done', reasons: [
    ...(completed.length ? completed : [{ text: '已采纳，暂无待推进的落地步骤' }]),
    ...(branch?.unpaid ? [{ text: `分支里还有 ${branch.unpaid} 笔未还` }] : []),
  ] };
}

function groupBy<T>(rows: readonly T[], key: (row: T) => string | undefined) {
  const result = new Map<string, T[]>();
  for (const row of rows) {
    const value = key(row);
    if (!value) continue;
    const group = result.get(value);
    if (group) group.push(row);
    else result.set(value, [row]);
  }
  return result;
}

function advancement(data: PlanningBoard) {
  const plans = groupBy(data.plans, plan => plan.decisionId);
  const rows = data.decisions.map(decision => {
    const associated = plans.get(decision.id) ?? [];
    const progress = decisionProgress(decision, associated, data.today, data.debtBranches?.[decision.id]);
    return { decision, plans: associated, progress };
  });
  const review = rows.filter(({ decision }) => decision.status === 'accepted' && decision.reviewAt && decision.reviewAt <= data.today
    && (!decision.reviewedAt || onDay(decision.reviewedAt) < decision.reviewAt));
  const needsReview = new Set(review.map(({ decision }) => decision.id));
  const remaining = rows.filter(({ decision }) => !needsReview.has(decision.id));
  return {
    pending: data.proposals.filter(item => item.status === 'pending'), review,
    stuck: remaining.filter(({ progress }) => progress.state === 'stuck'),
    moving: remaining.filter(({ progress }) => progress.state === 'moving'),
    done: remaining.filter(({ progress }) => progress.state === 'done'),
  };
}

export function planningBoardSummary(data: PlanningBoard) {
  const grouped = advancement(data);
  const recentPulls = new Set(data.decisions.flatMap(decision => (decision.pullRequests ?? [])
    .filter(pull => recentlyChanged(pull.updatedAt, data.today)).map(pull => pull.url))).size;
  return { pending: grouped.pending.length + grouped.review.length, stuck: grouped.stuck.length, recentPulls };
}

function RecordId({ id }: { id: string }) {
  return <span className="ep-id" title={id}>{shortId(id)}</span>;
}

function DecisionStatus({ status }: { status: PlanningDecision['status'] }) {
  return <PlanningBadge tone={status === 'accepted' ? 'success' : status === 'proposed' ? 'info' : 'quiet'}>{decisionLabels[status]}</PlanningBadge>;
}

function DecisionKindBadge({ kind }: { kind?: PlanningDecision['decisionKind'] }) {
  return <PlanningBadge tone={kind === 'debt' ? 'accent' : 'info'}>{kind ? decisionKindLabels[kind] : '决策'}</PlanningBadge>;
}

function ProgressBadge({ state }: { state: Progress['state'] }) {
  const { icon: Icon, label } = lanes[state];
  return <span className="ep-decision-progress" data-progress={state}><Icon aria-hidden />{label}</span>;
}

function Reasons({ reasons }: Pick<Progress, 'reasons'>) {
  return <ul className="ep-decision-reasons">{reasons.map(({ text, blocked }) => <li key={text} data-blocked={blocked || undefined}>{text}</li>)}</ul>;
}

function Source({ source }: { source: PlanningSource }) {
  const label = source.ref.startsWith('web:') && source.type === 'manual' ? sourceLabels[source.type]
    : `${sourceLabels[source.type]} · ${source.ref}`;
  return source.url ? <a className="ep-decision-source" href={source.url} target="_blank" rel="noreferrer">
    <ExternalLink aria-hidden />{label}
  </a> : <span className="ep-decision-source">{label}</span>;
}

function Lane({ kind, count, children }: { kind: keyof typeof lanes; count: number; children: ReactNode }) {
  const lane = lanes[kind];
  const { label, icon: Icon, empty } = lane;
  return <section className="ep-advancement-lane" data-lane={kind} aria-label={label}>
    <header><Icon aria-hidden /><h2>{label}</h2><b>{count}</b></header>
    {'hint' in lane && <p className="ep-advancement-hint">{lane.hint}</p>}
    <ul className="ep-advancement-cards">{count ? children : <li className="ep-advancement-empty">{empty}</li>}</ul>
  </section>;
}

function DecisionCard({ decision, plans, progress, today, onSelect, review }: {
  decision: PlanningDecision; plans: PlanningPlan[]; progress: Progress; today: string; onSelect: SelectRecord; review?: boolean;
}) {
  const fresh = recentlyChanged(decision.updatedAt, today) || decision.pullRequests?.some(pull => recentlyChanged(pull.updatedAt, today));
  const active = activePullRequests(decision);
  const pulls = active.length ? active : progress.state === 'done' ? decision.pullRequests?.slice(0, 2) ?? [] : [];
  return <li className="ep-advancement-card" data-card={review ? 'review' : progress.state} data-fresh={fresh || undefined}>
    <div className="ep-decision-tags"><RecordId id={decision.id} /><DecisionKindBadge kind={decision.decisionKind} />
      {review ? <PlanningBadge tone="warning">该复核</PlanningBadge> : <DecisionStatus status={decision.status} />}
      {fresh && !review && <PlanningBadge tone="accent">有更新</PlanningBadge>}
    </div>
    <button type="button" className="ep-text-button ep-advancement-title" onClick={() => onSelect({ kind: 'decision', id: decision.id })}>{decision.title}</button>
    {review && decision.reviewAt ? <p className="ep-advancement-meta"><CalendarDays aria-hidden />
      <time dateTime={decision.reviewAt}>{monthDay(decision.reviewAt)}</time> 已到复核时间</p> : <Reasons reasons={progress.reasons} />}
    {plans.length > 0 && <p className="ep-advancement-meta"><ListChecks aria-hidden />{plans.length} 个落地计划</p>}
    {!review && pulls.length > 0 && <div className="ep-advancement-pull-requests">{pulls.map(pull => <PlanningPullRequestBadge key={pull.url} pullRequest={pull} />)}</div>}
    {!review && !decision.pullRequests?.length && decision.pullRequest && <PlanningPullRequestLink reference={decision.pullRequest} />}
    {decision.links?.length ? <PlanningDecisionLinks links={decision.links} limit={1} /> : decision.source.url && <Source source={decision.source} />}
  </li>;
}

function ProposalCard({ proposal, decision, relatedDebts, approve, busy, onSelect, onConfirm, onReject }: {
  proposal: PlanningProposal; decision?: PlanningDecision; relatedDebts: PlanningBoard['relatedDebts']; approve: boolean; busy: boolean;
  onSelect: SelectRecord; onConfirm: ConfirmProposal; onReject: (item: PlanningProposal) => void;
}) {
  const Actor = proposal.author.kind === 'agent' ? Bot : UserRound;
  const decisionKind = proposal.kind === 'decision' ? proposal.draft.decisionKind : undefined;
  const type = decisionKind ? decisionKindLabels[decisionKind] : kindLabels[proposal.kind];
  const change = proposal.kind === 'decision' ? proposal.decisionChange : undefined;
  const changeLabel = change?.change === 'amended' ? '修订 ADR' : change && '采纳决策';
  const outdated = Boolean(change && decision && change.expectedVersion !== decision.version);
  const suggestion = proposal.kind === 'debt' ? proposal.suggest : undefined;
  const excerpt = proposal.source.excerpt;
  const plannedDebts = proposal.kind === 'plan' ? proposal.draft.debtIds ?? [] : [];
  const unavailableDebt = plannedDebts.some(id => !relatedDebts?.[id] || closedDebt(relatedDebts[id].status));
  return <li className="ep-advancement-card ep-advancement-proposal" data-card="proposal">
    <div className="ep-decision-tags"><PlanningBadge tone={proposal.kind === 'debt' || decisionKind === 'debt' ? 'accent' : 'info'}>{changeLabel || `${type}提案`}</PlanningBadge></div>
    <p className="ep-advancement-meta"><Actor aria-hidden />{proposal.skill && `${proposal.skill} · `}{proposal.author.label} · <time dateTime={proposal.createdAt}>{monthDay(proposal.createdAt)}</time></p>
    {proposal.confidence !== undefined && <p className="ep-advancement-meta">把握 {Math.round(proposal.confidence * 100)}%</p>}
    <h3>{proposal.draft.title}</h3>
    {proposal.draft.summary && <p className="ep-advancement-summary">{proposal.draft.summary}</p>}
    {excerpt && excerpt !== proposal.draft.summary && <blockquote className="ep-proposal-excerpt">{excerpt}</blockquote>}
    <Source source={proposal.source} />
    {decision && <p className="ep-advancement-meta">关联决策 <button type="button" className="ep-text-button" title={decision.title}
      onClick={() => onSelect({ kind: 'decision', id: decision.id })}>{shortId(decision.id)}{change && ` ${decision.title}`}</button></p>}
    {change && decision && outdated && <p className="ep-proposal-match"><TriangleAlert aria-hidden />提案基于 v{change.expectedVersion}，当前决策为 v{decision.version}</p>}
    {suggestion && <p className="ep-proposal-match"><Copy aria-hidden /><span>可能与 <button type="button" className="ep-text-button"
      onClick={() => onSelect({ kind: 'debt', id: suggestion.dupOf })}>{shortId(suggestion.dupOf)} {suggestion.dupTitle}</button> 是同一个问题</span></p>}
    {!!plannedDebts.length && <details open={plannedDebts.length <= 3}>
      <summary className="ep-advancement-summary">拟排入 {plannedDebts.length} 笔债务</summary>
      <ul>{plannedDebts.map(id => {
        const debt = relatedDebts?.[id];
        return <li key={id} className="ep-advancement-meta">
          {debt ? <button type="button" className="ep-text-button" onClick={() => onSelect({ kind: 'debt', id })}>{shortId(id)} {debt.title}</button> : shortId(id)}
          <span>{debt ? debtLabels[debt.status] : '记录不可用'}</span>
        </li>;
      })}</ul>
    </details>}
    {unavailableDebt && <p className="ep-proposal-match"><TriangleAlert aria-hidden />拟排入的债务已关闭或不可用，请核对后重新提出。</p>}
    {approve ? <div className="ep-advancement-actions">
      {suggestion ? <>
        <button type="button" className="ep-button ep-button--primary" disabled={busy} onClick={() => onConfirm(proposal, 'hit')}>
          记为 {shortId(suggestion.dupOf)} 又踩到一次
        </button>
        <button type="button" className="ep-button" disabled={busy} onClick={() => onConfirm(proposal, 'new')}>仍然新记一笔</button>
      </> : <button type="button" className="ep-button ep-button--primary" disabled={busy || outdated || unavailableDebt} onClick={() => onConfirm(proposal)}>
        {change?.change === 'amended' ? '确认修订' : changeLabel || proposalApprovals[proposal.kind]}
      </button>}
      <button type="button" className="ep-button ep-planning-quiet" disabled={busy} onClick={() => onReject(proposal)}>驳回</button>
    </div> : <p className="ep-advancement-meta">由有审批权限的成员确认</p>}
  </li>;
}

export function PlanningBoardView({ data, busy, onSelect, onConfirm, onReject }: {
  data: PlanningBoard; busy: boolean; onSelect: SelectRecord;
  onConfirm: ConfirmProposal; onReject: (item: PlanningProposal) => void;
}) {
  const { pending, review, ...progress } = useMemo(() => advancement(data), [data]);
  const decisions = useMemo(() => new Map(data.decisions.map(decision => [decision.id, decision])), [data.decisions]);
  const approve = data.permissions.includes('approve');
  return <div className="ep-advancement"><div className="ep-advancement-board" role="region" aria-label="推进看板">
    <Lane kind="pending" count={pending.length + review.length}>
      {pending.map(proposal => {
        const decisionId = proposal.kind === 'decision' ? proposal.decisionChange?.decisionId : proposal.draft.decisionId;
        return <ProposalCard key={proposal.id} proposal={proposal} relatedDebts={data.relatedDebts} approve={approve} busy={busy} onSelect={onSelect}
          decision={decisionId ? decisions.get(decisionId) : undefined} onConfirm={onConfirm} onReject={onReject} />;
      })}
      {review.map(row => <DecisionCard key={row.decision.id} {...row} today={data.today} onSelect={onSelect} review />)}
    </Lane>
    {(['stuck', 'moving', 'done'] as const).map(kind => <Lane key={kind} kind={kind} count={progress[kind].length}>
      {progress[kind].map(row => <DecisionCard key={row.decision.id} {...row} today={data.today} onSelect={onSelect} />)}
    </Lane>)}
  </div></div>;
}

function stepSelection(step: PlanningStep, plan: PlanningPlan): PlanningSelection {
  return step.relatedId && step.kind !== 'design'
    ? { kind: step.kind === 'debt' ? 'debt' : 'decision', id: step.relatedId } : { kind: 'plan', id: plan.id };
}

function markerLabel(step: PlanningStep, date: string, today: string) {
  const status = stepIsLate(step, today) ? '已逾期' : stepLabels[step.status];
  return `${stepKindLabels[step.kind]} · ${step.title} · ${fullDate(date)} · ${status}`;
}

function StepMarkers({ steps, date, left, today, plan, onSelect }: {
  steps: PlanningStep[]; date: string; left: string; today: string; plan: PlanningPlan; onSelect: SelectRecord;
}) {
  const step = steps[0];
  const label = steps.length === 1 ? markerLabel(step, date, today) : `${fullDate(date)} · ${steps.length} 个步骤`;
  const status = steps.every(item => item.status === step.status) ? step.status : undefined;
  const marker = <button type="button" className="ep-road-marker" style={{ left }} data-kind={steps.length === 1 ? step.kind : 'group'}
    data-status={status} data-late={steps.some(item => stepIsLate(item, today)) || undefined}
    title={label} aria-label={label} onClick={steps.length === 1 ? () => onSelect(stepSelection(step, plan)) : undefined}>
    {steps.length > 1 ? steps.length : step.kind === 'debt' ? '欠' : null}
  </button>;
  if (steps.length === 1) return marker;
  return <DropdownMenu trigger={marker} align="start" width={310}>
    {steps.map(item => <DropdownItem key={item.id} onSelect={() => onSelect(stepSelection(item, plan))}>{markerLabel(item, date, today)}</DropdownItem>)}
  </DropdownMenu>;
}

function Roadmap({ data, projectLabel, onSelect, onCreatePlan }: {
  data: PlanningBoard; projectLabel: string; onSelect: SelectRecord; onCreatePlan?: () => void;
}) {
  const now = Date.parse(data.today);
  const rows = data.plans.map(plan => {
    const recorded = Date.parse(onDay(plan.createdAt));
    const deadlines = plan.steps.flatMap(step => step.dueAt ? [Date.parse(step.dueAt)] : []);
    const due = plan.dueAt ? Date.parse(plan.dueAt) : undefined;
    const start = plan.startAt ? Date.parse(plan.startAt) : Math.min(recorded, due ?? recorded, ...deadlines);
    const end = due === undefined && deadlines.length === 0 ? undefined : Math.max(start, due ?? Math.max(...deadlines));
    return { plan, start, end, earliest: Math.min(start, ...deadlines), latest: Math.max(end ?? start, ...deadlines) };
  }).sort((a, b) => a.start - b.start || (a.end ?? a.start) - (b.end ?? b.start));
  const first = new Date(rows.reduce((earliest, row) => Math.min(earliest, row.earliest), now - 30 * DAY));
  const last = new Date(rows.reduce((latest, row) => Math.max(latest, row.latest), now + 60 * DAY));
  first.setUTCDate(1);
  last.setUTCMonth(last.getUTCMonth() + 1, 1);
  const from = first.getTime();
  const to = last.getTime();
  const percent = (date: number) => 100 * (date - from) / (to - from);
  const ticks: { at: number; label: string }[] = [];
  const monthCount = (last.getUTCFullYear() - first.getUTCFullYear()) * 12 + last.getUTCMonth() - first.getUTCMonth();
  const interval = Math.max(1, Math.ceil(monthCount / 24));
  for (const month = new Date(first); month < last; month.setUTCMonth(month.getUTCMonth() + interval)) {
    const year = month.getTime() === from || month.getUTCMonth() === 0 || interval > 1 ? `${month.getUTCFullYear()} 年 ` : '';
    ticks.push({ at: month.getTime(), label: `${year}${month.getUTCMonth() + 1} 月` });
  }
  return <section className="ep-surface ep-roadmap" aria-labelledby="ep-roadmap-heading">
    <header className="ep-roadmap-header"><h2 id="ep-roadmap-heading">接下来 · 落地路线</h2>
      <p>已采纳的决策通过计划落地，偿还步骤随债务还清自动完成</p>
      {onCreatePlan && <button type="button" className="ep-button" onClick={onCreatePlan}><Plus aria-hidden />新建落地计划</button>}
    </header>
    {!rows.length ? <PlanningEmpty>这个项目还没有落地计划</PlanningEmpty> : <>
      <div className="ep-road-scroll" role="region" aria-label="落地路线日期轴" tabIndex={0}>
        <div className="ep-road-chart" style={{ minWidth: Math.max(680, 260 + ticks.length * 78) }}>
          <div className="ep-road-axis">
            {ticks.map(tick => <div key={tick.at} className="ep-road-month" style={{ left: `${percent(tick.at)}%` }}><span>{tick.label}</span></div>)}
            <div className="ep-road-today" style={{ left: `${percent(now)}%` }}><time dateTime={data.today}>今天</time></div>
          </div>
          <p className="ep-road-project">{projectLabel}</p>
          <ol className="ep-road-rows">{rows.map(({ plan, start, end }) => {
            const progress = planProgress(plan, data.today);
            const left = percent(start);
            const width = end === undefined ? 0 : percent(end) - left;
            const schedule = plan.startAt ? '开始' : '未排期';
            const datedSteps = groupBy(plan.steps, step => step.dueAt);
            return <li className="ep-road-row" key={plan.id}>
              <div className="ep-road-label"><button type="button" className="ep-text-button" title={plan.title} onClick={() => onSelect({ kind: 'plan', id: plan.id })}>{plan.title}</button>
                <p><RecordId id={plan.id} /> · {progress.done}/{progress.total} 步{progress.late > 0 && <strong> · {progress.late} 步逾期</strong>}</p>
              </div>
              <div className="ep-road-track">
                {end === undefined ? <button type="button" className="ep-road-unscheduled" style={{ left: `${left}%` }}
                  aria-label={`${plan.title} · ${plan.startAt ? `${fullDate(plan.startAt)} 开始` : schedule}`}
                  onClick={() => onSelect({ kind: 'plan', id: plan.id })}>{schedule}</button>
                  : <div className="ep-road-bar" data-status={progress.state} style={{ left: `${left}%`, width: `${width}%` }}>
                    <div className="ep-road-meter" role="progressbar" aria-label={`${plan.title}完成进度`}
                      aria-valuenow={progress.percent} aria-valuetext={`${progress.done}/${progress.total} 步完成`}>
                      <span className="ep-road-fill" style={{ width: `${progress.percent}%` }} />
                    </div>
                    <span className="ep-road-percent" aria-hidden>{progress.percent}%</span>
                    <button type="button" className="ep-road-bar-link" aria-label={`查看落地计划 ${plan.title}`} onClick={() => onSelect({ kind: 'plan', id: plan.id })} />
                  </div>}
                {[...datedSteps].map(([date, steps]) => <StepMarkers key={date} steps={steps} date={date} left={`${percent(Date.parse(date))}%`}
                  today={data.today} plan={plan} onSelect={onSelect} />)}
              </div>
            </li>;
          })}</ol>
        </div>
      </div>
      <ul className="ep-road-legend" aria-label="路线图例">
        <li><i data-kind="task" aria-hidden />任务</li><li><i data-kind="decision" aria-hidden />落地或复核决策</li>
        <li><i data-kind="debt" aria-hidden>欠</i>偿还债务（还清后自动完成）</li><li><i data-kind="late" aria-hidden />逾期</li>
      </ul>
    </>}
  </section>;
}

function BranchBar({ branch }: { branch: Branch }) {
  const parts = [
    ['unpaid', '未还', branch.unpaid], ['repaid', '已偿还', branch.repaid],
    ['extinct', '随功能消失', branch.extinct], ['other', '其他已关闭', branch.other],
  ] as const;
  const visible = parts.filter(([, , count]) => count > 0);
  const summary = visible.map(([, label, count]) => `${label} ${count}`).join('，');
  return <span className="ep-branch-meter" role="img" aria-label={summary} title={summary}>
    {visible.map(([key, , count]) => <i key={key} data-outcome={key} style={{ flexGrow: count }} />)}
  </span>;
}

function BranchCard({ branch, decisionId, onBranch }: { branch: Branch; decisionId: string; onBranch: (id: string) => void }) {
  const total = branchTotal(branch);
  return <button type="button" className="ep-trunk-branch" onClick={() => onBranch(decisionId)} title="在债务分支查看关联债务">
    <span className="ep-trunk-branch-title"><GitBranch aria-hidden /><strong>{total} 笔债</strong>
      <b data-unpaid={branch.unpaid > 0}>{branch.unpaid ? `未还 ${branch.unpaid}` : branch.repaid === total ? '全部还清' : '全部关闭'}</b>
      {branch.highInterest > 0 && <span className="ep-trunk-hot" title="近期频繁遇到"><Flame aria-hidden /><span className="sr-only">高利息 </span>{branch.highInterest}</span>}
    </span>
    <BranchBar branch={branch} />
    <span className="ep-trunk-branch-meta">近 30 天新增 {branch.created} · 关闭 {branch.closed}{branch.planned > 0 && ` · 已排计划 ${branch.planned}`}</span>
  </button>;
}

const trunkFilters = [
  { key: 'all', label: '全部', match: () => true },
  { key: 'live', label: '生效中', match: (row: PlanningDecision) => row.status === 'accepted' },
  { key: 'proposed', label: '提议中', match: (row: PlanningDecision) => row.status === 'proposed' },
  { key: 'closed', label: '已取代 / 废弃', match: (row: PlanningDecision) => row.status === 'superseded' || row.status === 'deprecated' },
] as const;

function historyLabel(event: PlanningEvent) {
  return (event.entity === 'decision' && decisionHistoryLabels[event.type]) || events[event.type];
}

function HistoryBadge({ event, short = false, recent }: { event: PlanningEvent; short?: boolean; recent?: boolean }) {
  return <span className="ep-decision-history-badge" data-event={event.type} data-recent={recent || undefined}
    title={`${event.actor.label}${event.note ? ` · ${event.note}` : ''}`}>
    <i aria-hidden />{historyLabel(event)}{short && <time dateTime={event.at}>{monthDay(event.at)}</time>}
  </span>;
}

function Trunk({ data, onSelect, onBranch }: { data: PlanningBoard; onSelect: SelectRecord; onBranch: (id: string) => void }) {
  const [filter, setFilter] = useState<typeof trunkFilters[number]['key']>('all');
  const sourceDate = (row: PlanningDecision) => row.provenance?.occurredOn ?? row.createdAt;
  const decisions = useMemo(() => [...data.decisions].sort((a, b) => sourceDate(b).localeCompare(sourceDate(a))), [data.decisions]);
  const plans = useMemo(() => groupBy(data.plans, plan => plan.decisionId), [data.plans]);
  const history = useMemo(() => groupBy(data.events, event => event.entity === 'decision' ? event.entityId : undefined), [data.events]);
  const filtered = decisions.filter(trunkFilters.find(item => item.key === filter)!.match);
  const orphan = data.debtBranches?.none;
  const showOrphan = Boolean(orphan?.unpaid && (filter === 'all' || filter === 'live'));
  return <section className="ep-decision-trunk" aria-labelledby="ep-trunk-heading">
    <header className="ep-trunk-header"><h2 id="ep-trunk-heading">决策主线</h2>
      <p>每个决策的提出、采纳、修订、复核、取代都在主线上，右侧是它分出的债务</p>
      <div className="ep-planning-segment" role="group" aria-label="筛选决策">{trunkFilters.map(item => <button key={item.key} type="button"
        aria-pressed={filter === item.key} onClick={() => setFilter(item.key)}>{item.label} {decisions.filter(item.match).length}</button>)}</div>
    </header>
    {(filtered.length > 0 || showOrphan) ? <ol className="ep-trunk-nodes">
      {filtered.map(decision => {
        const associated = plans.get(decision.id) ?? [];
        const branch = data.debtBranches?.[decision.id];
        const changes = [...history.get(decision.id) ?? []].reverse();
        const fresh = changes.filter(event => recentlyChanged(event.at, data.today)).length;
        const progress = decisionProgress(decision, associated, data.today, branch);
        const live = activePullRequests(decision).length;
        const documentCount = decision.links?.filter(link => link.type === 'doc' || link.type === 'adr').length ?? 0;
        return <li className="ep-trunk-node" key={decision.id} data-state={decision.status} data-kind={decision.decisionKind} data-fresh={fresh > 0 || undefined}>
          <time className="ep-trunk-date" dateTime={sourceDate(decision)}>{monthDay(sourceDate(decision))}<small>{onDay(sourceDate(decision)).slice(0, 4)}</small></time>
          <span className="ep-trunk-dot" aria-hidden />
          <article className="ep-trunk-card" onClick={event => {
            if (event.target instanceof Element && !event.target.closest('button, a')) onSelect({ kind: 'decision', id: decision.id });
          }}>
            <div className="ep-decision-tags"><RecordId id={decision.id} /><DecisionKindBadge kind={decision.decisionKind} />
              <DecisionStatus status={decision.status} /><ProgressBadge state={progress.state} />
              {decision.provenance && <PlanningBadge>{provenanceLabels[decision.provenance.level]}</PlanningBadge>}{fresh > 0 && <PlanningBadge tone="accent">新变更 {fresh}</PlanningBadge>}
              {decision.pullRequests?.length ? <span className="ep-trunk-pull-requests"><GitPullRequest aria-hidden />PR {decision.pullRequests.length}
                {live > 0 && ` · ${live} 个进行中`}</span> : decision.pullRequest && <span className="ep-trunk-pull-requests"><GitPullRequest aria-hidden />PR 待同步</span>}
              {documentCount > 0 && <DecisionDocumentBadge count={documentCount} />}
            </div>
            <button type="button" className="ep-text-button ep-trunk-title" onClick={() => onSelect({ kind: 'decision', id: decision.id })}>{decision.title}</button>
            {decision.provenance && <p className="ep-caption"><a className="ep-link" href={decision.provenance.url} target="_blank" rel="noreferrer">依据 <ExternalLink /></a>
              {decision.provenance.level !== 'original' && ` · 记录于 ${dateLabel(decision.createdAt)}`}</p>}
            {changes.length > 0 && <div className="ep-trunk-history" aria-label="决策历程">{changes.map(event =>
              <HistoryBadge key={event.id} event={event} short recent={recentlyChanged(event.at, data.today)} />)}</div>}
            {associated.length > 0 && <div className="ep-trunk-plans">{associated.map(plan => {
              const progress = planProgress(plan, data.today);
              return <button type="button" key={plan.id} title={plan.title} className="ep-text-button" onClick={() => onSelect({ kind: 'plan', id: plan.id })}>
                <CalendarDays aria-hidden /><RecordId id={plan.id} /> {progress.done}/{progress.total} 步
              </button>;
            })}</div>}
          </article>
          {branch && branchTotal(branch) > 0 ? <BranchCard branch={branch} decisionId={decision.id} onBranch={onBranch} />
            : <p className="ep-trunk-branch ep-trunk-branch--empty">{decision.resolves?.length ? `计划解决 ${decision.resolves.length} 笔债`
              : data.debtBranches ? '还没有分出债务' : '暂无分支统计'}</p>}
        </li>;
      })}
      {orphan && showOrphan && <li className="ep-trunk-node" data-state="unassigned">
        <span className="ep-trunk-dot" aria-hidden /><div className="ep-trunk-card"><strong>未归属任何决策</strong><p>可在债务分支查看并补充决策归属</p></div>
        <button type="button" className="ep-trunk-branch" onClick={() => onBranch('none')}><span className="ep-trunk-branch-title"><GitBranch aria-hidden />
          <strong>{orphan.unpaid} 笔未还</strong><ChevronRight aria-hidden /></span></button>
      </li>}
    </ol> : <PlanningEmpty>没有符合条件的决策</PlanningEmpty>}
  </section>;
}

export function PlanningTimeline({ data, onSelect, projectLabel, onBranch, onCreatePlan }: {
  data: PlanningBoard; onSelect: SelectRecord; projectLabel: string; onBranch: (id: string) => void; onCreatePlan?: () => void;
}) {
  return <div className="ep-planning-timeline">
    <Roadmap data={data} projectLabel={projectLabel} onSelect={onSelect} onCreatePlan={onCreatePlan} />
    <div className="ep-planning-today" role="separator" aria-label={`今天 ${monthDay(data.today)}`}>
      <span><time dateTime={data.today}>今天 {monthDay(data.today)}</time> · 往下是走过的决策</span>
    </div>
    <Trunk data={data} onSelect={onSelect} onBranch={onBranch} />
  </div>;
}

function RecordHeading({ record, projectLabel, badges, action, metadata, children }: {
  record: PlanningDecision | PlanningPlan; projectLabel: string; badges: ReactNode; action?: ReactNode;
  metadata?: ReactNode; children?: ReactNode;
}) {
  const start = ('startAt' in record && record.startAt) || record.createdAt;
  return <DialogHeader className="ep-dialog-head ep-planning-record-head">
    <div className="ep-decision-tags">{badges}<DialogDescription className="ep-id" title={record.id}>{shortId(record.id)}</DialogDescription></div>
    <div className="ep-planning-record-heading"><DialogTitle>{record.title}</DialogTitle>{action}</div>
    <div className="ep-planning-record-meta">
      <span><Folder aria-hidden />{projectLabel}</span>
      {record.owner && <span><UserRound aria-hidden />{record.owner}</span>}
      <span><CalendarDays aria-hidden /><time dateTime={start}>{fullDate(start)}</time>
        {'dueAt' in record && record.dueAt && <>至 <time dateTime={record.dueAt}>{fullDate(record.dueAt)}</time></>}
      </span>
      {'reviewAt' in record && record.reviewAt && <span><Clock3 aria-hidden />复核 <time dateTime={record.reviewAt}>{fullDate(record.reviewAt)}</time></span>}
      {metadata}
    </div>
    {children}
  </DialogHeader>;
}

export function DecisionHeading({ row, projectLabel }: { row: PlanningDecision; projectLabel: string }) {
  return <RecordHeading record={row} projectLabel={projectLabel} badges={<><DecisionKindBadge kind={row.decisionKind} /><DecisionStatus status={row.status} /></>} />;
}

export function PlanHeading({ plan, projectLabel, options }: {
  plan: PlanningPlan; projectLabel: string; options?: Pick<DetailProps, 'board' | 'write' | 'actionsDisabled' | 'onAction'>;
}) {
  const progress = planProgress(plan, options?.board.today ?? onDay(plan.updatedAt));
  return <RecordHeading record={plan} projectLabel={projectLabel} action={options?.write && <PlanDebtPicker key={plan.id}
    plan={plan} board={options.board} disabled={options.actionsDisabled} onAction={options.onAction} />} badges={
    <PlanningBadge tone={progress.state === 'done' ? 'success' : progress.state === 'doing' ? 'accent' : 'quiet'}>
      {planLabel(plan, progress.state)}
    </PlanningBadge>} metadata={<>
      <span>{progress.done}/{progress.total} 步 · {progress.percent}%</span>
      {progress.late > 0 && <span className="ep-plan-late-tag">{progress.late} 步逾期</span>}
    </>}>
    <div className="ep-plan-detail-meter" role="progressbar" aria-label="落地计划完成进度" aria-valuenow={progress.percent}
      aria-valuetext={`${progress.done}/${progress.total} 步完成`} data-status={progress.state}><span style={{ width: `${progress.percent}%` }} /></div>
  </RecordHeading>;
}

function PlanDebtPicker({ plan, board, disabled, onAction }: { plan: PlanningPlan; board: PlanningBoard; disabled: boolean; onAction: OpenAction }) {
  const [open, setOpen] = useState(false);
  const [branch, setBranch] = useState(plan.decisionId);
  const [search, setSearch] = useState('');
  const [query, setQuery] = useState('');
  const [cursors, setCursors] = useState<string[]>([]);
  const [reload, setReload] = useState(0);
  const trigger = useRef<HTMLButtonElement>(null);
  const openingStep = useRef(false);
  const cursor = cursors.at(-1);
  const params = new URLSearchParams({ view: 'unpaid', limit: '20', ...(branch ? { branch } : {}), ...(query ? { q: query } : {}), ...(cursor ? { cursor } : {}) });
  const read = usePlanningRead<PlanningDebtList>(open ? `${planningPath(board.projectId)}/debts?${params}` : null, reload);
  const scheduled = new Set(plan.steps.flatMap(step => step.kind === 'debt' && step.relatedId ? [step.relatedId] : []));
  const candidates = read.data?.items.filter(debt => !scheduled.has(debt.id) && !closedDebt(debt.status)) ?? [];
  const loading = read.loading || search.trim() !== query;
  const next = read.data?.nextCursor;

  useEffect(() => {
    if (!open || search.trim() === query) return;
    const timer = window.setTimeout(() => {
      setQuery(search.trim());
      setCursors([]);
    }, 220);
    return () => window.clearTimeout(timer);
  }, [open, search, query]);

  function changeOpen(value: boolean) {
    setOpen(value);
    if (value) {
      setSearch('');
      setQuery('');
      setBranch(plan.decisionId);
      setCursors([]);
      setReload(previous => previous + 1);
    }
  }

  function changeBranch(value: string | undefined) {
    setBranch(value);
    setCursors([]);
  }

  function pick(debt: PlanningDebt) {
    openingStep.current = true;
    setOpen(false);
    onAction({ kind: 'step', plan, initialKind: 'debt', initialRelatedId: debt.id, initialTitle: debt.title }, trigger.current);
  }

  return <Dialog open={open} onOpenChange={changeOpen}>
    <DialogTrigger asChild><button ref={trigger} className="ep-button" type="button" disabled={disabled}>
      <FileText aria-hidden />把债排进来
    </button></DialogTrigger>
    <DialogContent frame className="ep-dialog ep-plan-debt-picker" overlayClassName="ep-dialog-overlay" onCloseAutoFocus={event => {
      if (openingStep.current) {
        event.preventDefault();
        openingStep.current = false;
      }
    }}>
      <DialogHeader className="ep-dialog-head"><DialogTitle>把债排进来</DialogTitle><DialogDescription>{plan.title}</DialogDescription></DialogHeader>
      <div className="ep-plan-debt-filters">
        {plan.decisionId && <div className="ep-planning-segment" role="group" aria-label="债务范围">
          <button type="button" aria-pressed={Boolean(branch)} onClick={() => changeBranch(plan.decisionId)}>本决策分支</button>
          <button type="button" aria-pressed={!branch} onClick={() => changeBranch(undefined)}>整个项目</button>
        </div>}
        <label className="ep-field"><span>搜索未还债务</span>
          <input type="search" maxLength={200} value={search} onChange={event => setSearch(event.target.value)} placeholder="标题、编号或来源" />
        </label>
      </div>
      <DialogBody className="ep-plan-debt-picker-body">
        {loading ? <ContentLoading variant="rows" label="读取可安排的未还债务" /> : read.error ? <div role="alert" className="ep-error">{read.error}
          <button type="button" className="ep-button" onClick={() => { setCursors([]); setReload(previous => previous + 1); }}>重新读取</button>
        </div> : candidates.length ? <ul className="ep-plan-debt-candidates">{candidates.map(debt => <li key={debt.id}>
          <button type="button" className="ep-record-link" onClick={() => pick(debt)} aria-label={`安排债务 ${debt.title}`}>
            <span><RecordId id={debt.id} /><strong>{debt.title}</strong></span>
            <span className="ep-record-muted">{debtLabels[debt.status]} · {priorityLabels[debt.priority]}优先级</span>
          </button>
        </li>)}</ul> : <PlanningEmpty>{next || cursor ? '本页没有可安排的未还债务' : '没有可安排的未还债务'}</PlanningEmpty>}
      </DialogBody>
      {!loading && !read.error && (cursor || next) && <nav className="ep-row ep-plan-debt-pages" aria-label="未还债务分页">
        <button type="button" className="ep-button" disabled={!cursor} onClick={() => setCursors(previous => previous.slice(0, -1))}>上一页</button>
        <button type="button" className="ep-button" disabled={!next} onClick={() => next && setCursors(previous => [...previous, next])}>下一页</button>
      </nav>}
    </DialogContent>
  </Dialog>;
}

function RecordSection({ title, children, action }: { title: string; children: ReactNode; action?: ReactNode }) {
  return <section className="ep-surface ep-planning-record-section"><header><h3>{title}</h3>{action}</header>{children}</section>;
}

function PlanningCliRead({ projectId }: { projectId: string }) {
  return <RecordSection title="在 CLI 中读取"><code className="ep-planning-record-cli">cdscli planning show --project {projectId}</code></RecordSection>;
}

function DecisionOptions({ row }: { row: PlanningDecision }) {
  return <RecordSection title="考虑过的方案"><div className="ep-decision-options">
    <table>
      <thead><tr><th scope="col">方案</th><th scope="col">好处</th><th scope="col">代价</th></tr></thead>
      <tbody>{row.options?.map(option => <tr key={option.title} data-chosen={option.title === row.chosenOption || undefined}>
        <th scope="row"><span>{option.title}</span>
          {option.title === row.chosenOption && <PlanningBadge tone="success">已选</PlanningBadge>}</th>
        <td>{option.benefits || '—'}</td><td>{option.drawbacks || '—'}</td>
      </tr>)}</tbody>
    </table>
  </div></RecordSection>;
}

function RecordHistory({ history }: { history: PlanningEvent[] }) {
  return history.length > 0 ? <ol className="ep-planning-record-history">{history.map(event => <li key={event.id}>
    <HistoryBadge event={event} />
    <div>{event.note && <strong>{event.note}</strong>}<p>{event.actor.label} · <time dateTime={event.at}>{fullDate(event.at)} {dateLabel(event.at).slice(-5)}</time></p></div>
  </li>)}</ol> : <p className="ep-record-muted">暂无记录</p>;
}

function RecordLink({ item, title, status, onSelect, focusKey }: {
  item: PlanningSelection; title?: string; status?: ReactNode; onSelect: SelectRecord; focusKey?: string;
}) {
  return <button className="ep-record-link" type="button" data-planning-focus={focusKey} onClick={() => onSelect(item)}>
    <span><RecordId id={item.id} />{title && <strong>{title}</strong>}</span>
    {status && <span className="ep-record-muted">{status}</span>}
  </button>;
}

type DetailProps = { board: PlanningBoard; write: boolean; actionsDisabled: boolean; onSelect: SelectRecord; onAction: OpenAction };

function DesignRecordLink({ projectId, design, signed = false }: { projectId: string; design: PlanningDesignLink; signed?: boolean }) {
  const query = new URLSearchParams({ project: projectId, design: design.id });
  if (signed && design.signed && design.frozen) {
    query.set('version', String(design.frozen));
    query.set('tab', 'accept');
    query.set('run', design.signed.runId);
  }
  return <Link className="ep-record-link" to={`/design?${query}`}>
    <span><RecordId id={design.id} /><strong>{design.title}</strong></span>
    <span className="ep-record-muted">V{design.version} · {design.frozen === design.version ? '已定稿' : '待定稿'}</span>
  </Link>;
}

export function DecisionDetails({ row, board, write, actionsDisabled, onSelect, onAction, onBranch }: DetailProps & {
  row: PlanningDecision; onBranch?: (id: string) => void;
}) {
  const changeButton = useRef<HTMLButtonElement>(null);
  const available = row.status === 'proposed' || row.status === 'accepted';
  const associated = board.plans.filter(plan => plan.decisionId === row.id);
  const designs = board.designs?.filter(design => design.decisionIds.includes(row.id));
  const configurationKeys = row.appliesTo?.filter(subject => subject.kind === 'config').map(subject => subject.ref);
  const history = board.events.filter(event => event.entity === 'decision' && event.entityId === row.id);
  const branch = board.debtBranches?.[row.id];
  const total = branch ? branchTotal(branch) : 0;
  const progress = decisionProgress(row, associated, board.today, branch);
  const successor = row.supersededBy ? board.decisions.find(decision => decision.id === row.supersededBy) : undefined;
  return <div className="ep-planning-record ep-decision-record">
    {write && available && <div className="ep-planning-record-actions">
      <DropdownMenu align="start" trigger={<button ref={changeButton} type="button" className="ep-button ep-button--primary" disabled={actionsDisabled}><Flag aria-hidden />记一次变更</button>}>
        {(Object.keys(decisionChangeLabels) as (keyof typeof decisionChangeLabels)[]).filter(action => action !== 'accepted' || row.status === 'proposed')
          .map(action => <DropdownItem key={action} onSelect={() => onAction({ kind: 'decision', decision: row, action }, changeButton.current)}>{decisionChangeLabels[action]}</DropdownItem>)}
      </DropdownMenu>
      <button type="button" className="ep-button" disabled={actionsDisabled} onClick={event => onAction({ kind: 'create', record: 'debt', decisionId: row.id }, event.currentTarget)}>
        <FileText aria-hidden />在这个决策下记债
      </button>
    </div>}
    {branch && total > 0 && <div className="ep-decision-notice"><GitBranch aria-hidden />
      <div><strong>债务分支</strong><p>关联 {total} 笔债，未还 {branch.unpaid} 笔，已排进计划 {branch.planned} 笔。</p></div>
    </div>}
    <div className="ep-record-columns">
      <div className="ep-record-main">
        <RecordSection title="推进"><div className="ep-record-progress-summary"><ProgressBadge state={progress.state} /><Reasons reasons={progress.reasons} /></div>
          {row.pullRequests?.length ? <PlanningPullRequestList pullRequests={row.pullRequests} />
            : row.pullRequest ? <PlanningPullRequestLink reference={row.pullRequest} /> : row.source.url && <Source source={row.source} />}
        </RecordSection>
        <RecordSection title="变更历史"><RecordHistory history={history} /></RecordSection>
        <RecordSection title="背景"><p className={row.summary ? 'ep-record-prose' : 'ep-record-muted'}>{row.summary || '暂无背景记录'}</p></RecordSection>
        {row.options?.length ? <DecisionOptions row={row} /> : null}
        {row.chosenOption ? <RecordSection title="决定"><p className="ep-record-callout"><Flag aria-hidden /><span>{row.chosenOption}</span></p>
          {row.rationale && <p className="ep-record-prose">{row.rationale}</p>}
        </RecordSection> : row.rationale && <RecordSection title="决策与取舍">
          <p className="ep-record-callout"><Flag aria-hidden /><span>{row.rationale}</span></p>
        </RecordSection>}
        {row.consequences && <RecordSection title="预期后果"><p className="ep-record-prose">{row.consequences}</p></RecordSection>}
      </div>
      <aside className="ep-record-related">
        {row.links?.length ? <RecordSection title="决策文档"><PlanningDecisionLinks links={row.links} /></RecordSection> : null}
        {!!designs?.length && <RecordSection title="设计稿">{designs.map(design =>
          <DesignRecordLink key={design.id} projectId={board.projectId} design={design} />)}</RecordSection>}
        <RecordSection title="决策来源"><Source source={row.source} />
          {row.provenance && <div className="ep-record-provenance">
            <PlanningBadge>{provenanceLabels[row.provenance.level]}</PlanningBadge>
            <a className="ep-link" href={row.provenance.url} target="_blank" rel="noreferrer">查看原始依据</a>
            <p>原始日期 {row.provenance.occurredOn ?? '未知'} · 决定者 {row.provenance.decidedBy ?? '未知'}</p>
            {row.provenance.basis && <p>{row.provenance.basis}</p>}
          </div>}
          {!!row.aliases?.length && <p className="ep-caption">日常说法 · {row.aliases.join('、')}</p>}
          {!!row.appliesTo?.length && <p className="ep-caption">适用对象 · {row.appliesTo.map(value => value.ref).join('、')}</p>}
        </RecordSection>
        {row.supersededBy && <RecordSection title="接替决策"><RecordLink item={{ kind: 'decision', id: row.supersededBy }}
          title={successor?.title} status={successor && decisionLabels[successor.status]} onSelect={onSelect} /></RecordSection>}
        {!!configurationKeys?.length && <ConfigurationTrail projectId={board.projectId} keys={configurationKeys} compact />}
        <RecordSection title="债务分支">
          {branch && total > 0 ? <><BranchBar branch={branch} />
            <p className="ep-record-muted">{total} 笔 · 未还 {branch.unpaid} · 已偿还 {branch.repaid}
              {branch.extinct > 0 && ` · 随功能消失 ${branch.extinct}`}{branch.other > 0 && ` · 其他已关闭 ${branch.other}`}</p>
            {onBranch && <button type="button" className="ep-button" onClick={() => onBranch(row.id)}>在债务分支查看 <ChevronRight aria-hidden /></button>}
          </> : <p className="ep-record-muted">{board.debtBranches ? '还没有分出债务' : '暂无分支统计'}</p>}
        </RecordSection>
        {row.resolves?.length ? <RecordSection title="计划解决的债务">{row.resolves.map(id => {
          const debt = board.relatedDebts?.[id];
          return <RecordLink key={id} item={{ kind: 'debt', id }} title={debt?.title}
            status={debt && (debt.outcome ? inactiveLabels[debt.outcome.kind] : debtLabels[debt.status])} onSelect={onSelect} />;
        })}</RecordSection> : null}
        <RecordSection title="落地计划">{associated.length > 0 ? associated.map(plan => {
          const progress = planProgress(plan, board.today);
          return <RecordLink key={plan.id} item={{ kind: 'plan', id: plan.id }} title={plan.title}
            status={`${planLabel(plan, progress.state)} · ${progress.done}/${progress.total} 步`} onSelect={onSelect} />;
        }) : <p className="ep-record-muted">还没有排进计划</p>}
        </RecordSection>
        <PlanningCliRead projectId={board.projectId} />
      </aside>
    </div>
  </div>;
}

const stateChoices = [['todo', '未开始'], ['doing', '进行中'], ['done', '完成']] as const;

function PlanStep({ step, plan, board, write, actionsDisabled, onSelect, onAction }: DetailProps & { step: PlanningStep; plan: PlanningPlan }) {
  const Icon = stepIcons[step.kind];
  const isDebt = step.kind === 'debt';
  const isDesign = step.kind === 'design';
  const link = step.relatedId && !isDesign ? stepSelection(step, plan) : undefined;
  const design = isDesign ? board.designs?.find(item => item.id === step.relatedId) : undefined;
  const debt = isDebt && step.relatedId ? board.relatedDebts?.[step.relatedId] : undefined;
  const decision = link?.kind === 'decision' ? board.decisions.find(item => item.id === link.id) : undefined;
  const late = stepIsLate(step, board.today);
  return <li className="ep-plan-step-card" data-step-status={step.status} data-late={late || undefined}>
    <span className="ep-plan-step-icon"><Icon aria-hidden /></span>
    <div className="ep-plan-step-body">
      <div className="ep-decision-tags"><strong>{step.title}</strong><PlanningBadge>{stepKindLabels[step.kind]}</PlanningBadge>
        {late && <span className="ep-plan-late-tag">逾期</span>}
      </div>
      {step.owner && <span className="ep-record-muted">负责人 {step.owner}</span>}
      {debt?.repaidAt && step.status === 'done' ? <span className="ep-record-muted">完成于 <time dateTime={debt.repaidAt}>{fullDate(debt.repaidAt)}</time></span>
        : step.dueAt && <span className="ep-record-muted">计划日期 <time dateTime={step.dueAt}>{fullDate(step.dueAt)}</time></span>}
      {link && <RecordLink item={link} title={debt?.title ?? decision?.title} onSelect={onSelect} focusKey={step.id}
        status={debt ? (debt.outcome ? inactiveLabels[debt.outcome.kind] : debtLabels[debt.status]) : decision && decisionLabels[decision.status]} />}
      {design && <DesignRecordLink projectId={board.projectId} design={design} signed={step.status === 'done'} />}
    </div>
    {isDebt ? <span className="ep-record-muted ep-plan-step-state">
      {!step.relatedId ? '未关联债务' : step.status === 'done' ? '已还清' : step.status === 'cancelled' ? '债务已关闭' : '还清后自动完成'}
    </span> : isDesign ? <span className="ep-record-muted ep-plan-step-state">{step.status === 'done' ? '已签收' : '签收后自动完成'}</span>
      : write ? <div className="ep-planning-segment ep-plan-step-state" role="group" aria-label={`步骤状态 ${step.title}`}>
      {stateChoices.map(([value, label]) => <button key={value} type="button" aria-pressed={value === step.status}
        disabled={actionsDisabled || value === step.status} onClick={event => onAction({ kind: 'step', plan, step, initialStatus: value }, event.currentTarget)}>{label}</button>)}
    </div> : <span className="ep-record-muted ep-plan-step-state">{stepLabels[step.status]}</span>}
  </li>;
}

export function PlanDetails({ plan, board, write, actionsDisabled, onSelect, onAction }: DetailProps & { plan: PlanningPlan }) {
  const progress = planProgress(plan, board.today);
  const decision = board.decisions.find(row => row.id === plan.decisionId);
  const debtSteps = plan.steps.filter(step => step.kind === 'debt' && step.relatedId);
  const open = debtSteps.filter(step => step.status === 'todo' || step.status === 'doing').length;
  const recentHits = debtSteps.map(step => board.relatedDebts?.[step.relatedId!]?.recentHits);
  const hitsAvailable = recentHits.every(hit => hit !== undefined);
  const history = board.events.filter(event => event.entity === 'plan' && event.entityId === plan.id);
  return <div className="ep-planning-record">
    <div className="ep-record-columns">
      <div className="ep-record-main">
        <RecordSection title="目标">{plan.summary ? <p className="ep-record-callout"><Target aria-hidden /><span>{plan.summary}</span></p>
          : <p className="ep-record-muted">暂无目标说明</p>}
        </RecordSection>
        <RecordSection title="步骤" action={write && <button type="button" className="ep-button" disabled={actionsDisabled}
          onClick={event => onAction({ kind: 'step', plan }, event.currentTarget)}><Plus aria-hidden />添加步骤</button>}>
          {plan.steps.length ? <ol className="ep-plan-step-cards">{plan.steps.map(step => <PlanStep key={step.id} step={step}
          plan={plan} board={board} write={write} actionsDisabled={actionsDisabled} onSelect={onSelect} onAction={onAction} />)}</ol>
          : <p className="ep-record-muted">暂无落地步骤</p>}
        </RecordSection>
      </div>
      <aside className="ep-record-related">
        <RecordSection title="为什么做">{plan.decisionId ? <RecordLink item={{ kind: 'decision', id: plan.decisionId }}
          title={decision?.title} status={decision && decisionLabels[decision.status]} onSelect={onSelect}
          focusKey={`plan-decision-${plan.decisionId}`} /> : <p className="ep-record-muted">没有关联决策</p>}
        </RecordSection>
        <RecordSection title="要还的债"><dl className="ep-plan-debt-totals">
          <div><dt>笔债</dt><dd>{debtSteps.length}</dd></div><div><dt>未还</dt><dd>{open}</dd></div>
          {hitsAvailable && <div><dt>近 30 天被踩</dt><dd>{recentHits.reduce<number>((sum, hit) => sum + (hit ?? 0), 0)}</dd></div>}
          <div><dt>逾期步骤</dt><dd>{progress.late}</dd></div>
        </dl></RecordSection>
        {history.length > 1 && <RecordSection title="记录"><RecordHistory history={history} /></RecordSection>}
        {plan.source.url && <RecordSection title="计划来源"><Source source={plan.source} /></RecordSection>}
        <PlanningCliRead projectId={board.projectId} />
      </aside>
    </div>
  </div>;
}
