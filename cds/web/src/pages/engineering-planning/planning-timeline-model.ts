import type { PlanningBoard, PlanningDecision, PlanningPlan, PlanningPullRequest, PlanningStep, PlanningTimelineDebt, PlanningTimelineEvent } from '../../../../src/shared/engineering-planning';
import { onDay, planProgress, proposalIdleDays, pullStallReasons, stepIsLate } from './planning-progress';

export type Lane = 'decision' | 'debt' | 'plan';
/* 一套状态色：neutral 进行中、warn 待定或高息、bad 逾期、ok 已完成、muted 已结束；info 只用于复核等提示点。颜色只留给要注意的状态 */
export type Tone = 'bad' | 'warn' | 'neutral' | 'ok' | 'muted' | 'info';
export type Mark = { at: string; kind: 'event' | 'step' | 'due' | 'review'; tone: Tone; label: string };
export type TimeItem = {
  key: string; lane: Lane; id: string; title: string; start: string; end: string;
  /** 还在进行：条为开放的右端（未还的债、生效的决策、没完成的计划） */
  open: boolean; due?: string; late: number; state: string; tone: Tone; marks: Mark[]; owner?: string;
};
export type Relation = { from: string; to: string; label: string; field: string };
export type Cause = { key: string; tone: Tone; text: string; keys: string[] };

const DAY = 86_400_000;
export const day = (value?: string) => value ? onDay(value) : '';
export const days = (from: string, to: string) => Math.round((Date.parse(day(to)) - Date.parse(day(from))) / DAY);
export const monthDay = (value: string) => `${Number(value.slice(5, 7))}月${Number(value.slice(8, 10))}日`;
export const keyOf = (lane: Lane, id: string) => `${lane}:${id}`;
const unpaid = (debt: Pick<PlanningTimelineDebt, 'status'>) => debt.status !== 'repaid' && debt.status !== 'dropped';
const stepDone = (step: PlanningStep) => step.status === 'done' || step.status === 'cancelled';

const decisionStates: Record<PlanningDecision['status'], [string, Tone]> = {
  proposed: ['待定', 'warn'], accepted: ['生效', 'neutral'], superseded: ['已取代', 'muted'], deprecated: ['已废弃', 'muted'],
};
const debtStates: Record<string, string> = { open: '未还', in_progress: '处理中', deferred: '已延期', reopened: '重新打开', repaid: '已还', dropped: '已放弃' };
const eventLabels: Record<string, string> = {
  proposed: '提出', accepted: '采纳', amended: '修订', reviewed: '复核', superseded: '被取代', deprecated: '废弃', created: '记下', repaid: '还清',
  deferred: '延期', reopened: '重新打开', progress: '进展', started: '开始处理', step_changed: '步骤变化', planned: '排进计划',
};

export function timelineItems(board: PlanningBoard, debts: readonly PlanningTimelineDebt[] = board.timeline?.debts ?? []): TimeItem[] {
  const today = board.today;
  const events = new Map<string, PlanningTimelineEvent[]>();
  for (const event of [...board.events, ...(board.timeline?.debtEvents ?? [])]) {
    const key = `${event.entity}:${event.entityId}`;
    let list = events.get(key);
    if (!list) { list = []; events.set(key, list); }
    list.push(event);
  }
  const eventsOf = (entity: string, id: string) => events.get(`${entity}:${id}`) ?? [];
  const decisionItems = board.decisions.map((row): TimeItem => {
    const start = day(row.provenance?.occurredOn ?? row.createdAt);
    const ended = eventsOf('decision', row.id).find(event => event.type === 'superseded' || event.type === 'deprecated');
    const [state, tone] = decisionStates[row.status];
    const marks: Mark[] = eventsOf('decision', row.id).filter(event => day(event.at) !== start || !['proposed', 'accepted'].includes(event.type))
      .map(event => ({ at: day(event.at), kind: 'event', tone: event.type === 'superseded' ? 'muted' : 'neutral', label: `${monthDay(day(event.at))} ${eventLabels[event.type] ?? event.type}${event.note ? '：' + event.note : ''}` }));
    if (row.reviewAt) marks.push({ at: day(row.reviewAt), kind: 'review', tone: day(row.reviewAt) < today ? 'bad' : 'info', label: `${monthDay(day(row.reviewAt))} 复核` });
    return { key: keyOf('decision', row.id), lane: 'decision', id: row.id, title: row.title, start, end: ended ? day(ended.at) : today,
      open: row.status === 'accepted' || row.status === 'proposed', late: 0, state: row.status === 'proposed' ? `待定 ${days(start, today)} 天` : state, tone, marks, owner: row.owner };
  });
  const debtItems = debts.map((row): TimeItem => {
    const start = day(row.discoveredAt ?? row.createdAt);
    const open = unpaid(row);
    const closed = open ? undefined : row.closedAt ?? row.updatedAt;
    const late = open && row.dueAt && day(row.dueAt) < today ? days(row.dueAt, today) : 0;
    const marks: Mark[] = eventsOf('debt', row.id).filter(event => event.type !== 'created')
      .map(event => ({ at: day(event.at), kind: 'event', tone: event.type === 'repaid' ? 'ok' : event.type === 'reopened' ? 'bad' : 'info', label: `${monthDay(day(event.at))} ${eventLabels[event.type] ?? event.type}${event.note ? '：' + event.note : ''}` }));
    if (row.dueAt) marks.push({ at: day(row.dueAt), kind: 'due', tone: late ? 'bad' : 'warn', label: `${monthDay(day(row.dueAt))} 到期${late ? `，已逾期 ${late} 天` : ''}` });
    if (row.reviewAt) marks.push({ at: day(row.reviewAt), kind: 'review', tone: 'info', label: `${monthDay(day(row.reviewAt))} 复核` });
    const state = late ? `逾期 ${late} 天` : debtStates[row.status] ?? row.status;
    const tone: Tone = row.status === 'dropped' ? 'muted' : !open ? 'ok' : late ? 'bad' : row.status === 'deferred' ? 'muted' : row.priority === 'high' ? 'warn' : 'neutral';
    return { key: keyOf('debt', row.id), lane: 'debt', id: row.id, title: row.title, start, end: closed ? day(closed) : today, open, due: row.dueAt ? day(row.dueAt) : undefined,
      late, state, tone, marks, owner: row.owner };
  });
  const planItems = board.plans.map((plan): TimeItem => {
    const start = day(plan.startAt ?? plan.createdAt);
    const progress = planProgress(plan, today);
    const late = progress.active && plan.dueAt && day(plan.dueAt) < today ? days(plan.dueAt, today) : 0;
    const marks: Mark[] = plan.steps.flatMap((step, index) => {
      if (!step.dueAt) return [];
      const stepLate = stepIsLate(step, today);
      return [{ at: day(step.dueAt), kind: 'step', tone: stepDone(step) ? 'ok' : stepLate ? 'bad' : step.status === 'doing' ? 'neutral' : 'muted',
        label: `第 ${index + 1} 步 ${step.title} · ${monthDay(day(step.dueAt))}${stepDone(step) ? ' 完成' : stepLate ? ` 逾期 ${days(step.dueAt, today)} 天` : ''}` }];
    });
    const closed = progress.state === 'cancelled' ? '步骤已取消' : '已完成';
    const state = !progress.active ? closed : late ? `逾期 ${late} 天` : progress.late ? `${progress.late} 步逾期`
      : start > today ? `${monthDay(start)} 开始` : `${progress.done}/${progress.total} 步`;
    const end = !progress.active ? day(plan.updatedAt) : late ? today : day(plan.dueAt) || today;
    return { key: keyOf('plan', plan.id), lane: 'plan', id: plan.id, title: plan.title, start, end, open: progress.active, due: plan.dueAt ? day(plan.dueAt) : undefined,
      late, state, tone: progress.state === 'cancelled' ? 'muted' : !progress.active ? 'ok' : late || progress.late ? 'bad' : 'neutral', marks, owner: plan.owner };
  });
  return [...decisionItems, ...debtItems, ...planItems];
}

/** 条目之间的关联：只从编号字段推出。 */
export function timelineRelations(board: PlanningBoard, items: readonly TimeItem[], debts: readonly PlanningTimelineDebt[] = board.timeline?.debts ?? []): Relation[] {
  const has = new Set(items.map(item => item.key));
  const out: Relation[] = [];
  const pairs = new Set<string>();
  const add = (from: string, to: string, label: string, field: string) => {
    const pair = JSON.stringify([from, to]);
    if (!has.has(from) || !has.has(to) || from === to || pairs.has(pair)) return;
    pairs.add(pair);
    out.push({ from, to, label, field });
  };
  for (const debt of debts) {
    if (debt.decisionId) add(keyOf('debt', debt.id), keyOf('decision', debt.decisionId), '来自这个决策', 'debt.decisionId');
    if (debt.originDecisionId && debt.originDecisionId !== debt.decisionId) add(keyOf('debt', debt.id), keyOf('decision', debt.originDecisionId), '最初来自', 'debt.originDecisionId');
  }
  for (const plan of board.plans) {
    if (plan.decisionId) add(keyOf('plan', plan.id), keyOf('decision', plan.decisionId), '执行这个决策', 'plan.decisionId');
    plan.steps.forEach((step, index) => {
      if (!step.relatedId || (step.kind !== 'debt' && step.kind !== 'decision')) return;
      add(keyOf('plan', plan.id), keyOf(step.kind, step.relatedId), `第 ${index + 1} 步：${step.title}`, 'plan.steps[].relatedId');
    });
  }
  for (const decision of board.decisions) if (decision.supersededBy) add(keyOf('decision', decision.id), keyOf('decision', decision.supersededBy), '被它取代', 'decision.supersededBy');
  return out;
}

/** 与某个条目直接相连的条目和关系（两个方向都算）。 */
export function neighbours(key: string, relations: readonly Relation[]) {
  return relations.filter(row => row.from === key || row.to === key).map(row => ({ key: row.from === key ? row.to : row.from, label: row.label, field: row.field, outgoing: row.from === key }));
}

const list = (ids: string[]) => ids.length > 2 ? `${ids.slice(0, 2).join('、')} 等 ${ids.length} 项` : ids.join('、');

/** PR 卡住的判定和「推进」看板完全一样（PlanningDecisionViews 的 decisionProgress）：检查失败，或 7 天没更新。 */
export function stalledPull(pull: Pick<PlanningPullRequest, 'state' | 'checks' | 'updatedAt'>, today: string) {
  return pullStallReasons(pull, today).join('、') || null;
}

/** 要关注的原因，根因排第一：逾期的计划（卡在哪一步）→ 逾期的债（挡住哪一步）→ 卡住的 PR（和「推进」同一规则）→ 待定的决策（挡住哪些债）→ 一周内到期 → 待确认的提议。 */
export function timelineCauses(board: PlanningBoard, items: readonly TimeItem[], relations: readonly Relation[]): Cause[] {
  const today = board.today;
  const byKey = new Map(items.map(item => [item.key, item]));
  const out: Cause[] = [];
  const covered = new Set<string>();
  const stepOf = (plan: PlanningPlan, debtId: string) => plan.steps.findIndex(step => step.kind === 'debt' && step.relatedId === debtId && !stepDone(step));
  for (const plan of board.plans) {
    const item = byKey.get(keyOf('plan', plan.id));
    const progress = planProgress(plan, today);
    if (!item || (!item.late && !progress.late)) continue;
    const stuck = plan.steps.map((step, index) => ({ step, index }))
      .filter(({ step }) => item.late ? !stepDone(step) : stepIsLate(step, today));
    const first = stuck[0];
    const blocker = first?.step.relatedId && (first.step.kind === 'decision' || first.step.kind === 'debt')
      ? byKey.get(keyOf(first.step.kind, first.step.relatedId)) : undefined;
    out.push({ key: item.key, tone: 'bad', keys: [item.key, ...(blocker ? [blocker.key] : [])],
      text: `${plan.id} ${plan.title} ${item.late ? `逾期 ${item.late} 天` : `${progress.late} 个落地步骤逾期`}${first ? `，卡在第 ${first.index + 1} 步${blocker ? ` ${blocker.id}（${blocker.title}）` : `「${first.step.title}」`}` : ''}` });
    if (blocker) covered.add(blocker.key);
  }
  for (const item of items.filter(row => row.lane === 'debt' && row.late && !covered.has(row.key))) {
    const steps = board.plans.flatMap(plan => { const index = stepOf(plan, item.id); return index >= 0 ? [`${plan.id} 第 ${index + 1} 步`] : []; });
    out.push({ key: item.key, tone: 'bad', keys: [item.key], text: `${item.id} ${item.title} 逾期 ${item.late} 天${steps.length ? `，挡住 ${steps.join('、')}` : ''}` });
  }
  for (const decision of board.decisions.filter(row => row.status === 'accepted' || row.status === 'proposed')) for (const pull of decision.pullRequests ?? []) {
    const why = stalledPull(pull, today); if (!why) continue;
    const key = keyOf('decision', decision.id);
    out.push({ key, tone: 'bad', keys: [key], text: `PR #${pull.number} ${pull.title} ${why}，${decision.id} 的落地停在这里` });
  }
  for (const decision of board.decisions.filter(row => row.status === 'proposed')) {
    const key = keyOf('decision', decision.id);
    const blocked = relations.filter(row => row.to === key && row.field === 'debt.decisionId').map(row => byKey.get(row.from)!).filter(row => row.open);
    const waited = days(byKey.get(key)?.start ?? today, today);
    out.push({ key, tone: proposalIdleDays(decision, today) >= 14 ? 'bad' : blocked.length ? 'warn' : 'info', keys: [key, ...blocked.map(row => row.key)],
      text: `${decision.id} ${decision.title} 待定 ${waited} 天${blocked.length ? `，挡住 ${blocked.length} 笔债（${list(blocked.map(row => row.id))}）` : ''}` });
  }
  const soon = items.filter(row => row.open && row.due && !row.late && days(today, row.due) <= 7 && row.lane !== 'decision').sort((a, b) => a.due!.localeCompare(b.due!));
  if (soon.length) out.push({ key: soon[0].key, tone: 'info', keys: soon.map(row => row.key), text: `一周内到期 ${soon.length} 项：${soon.slice(0, 3).map(row => `${row.id}（${monthDay(row.due!)}）`).join('、')}` });
  const proposals = board.proposals.filter(row => row.status === 'pending').length;
  if (proposals) out.push({ key: 'proposals', tone: 'info', keys: [], text: `${proposals} 条提议等确认，在「推进」里处理` });
  return out;
}

/** 债务分支的原因：逾期 → 高息未还 → 一周内复核。 */
export function debtCauses(board: PlanningBoard, debts: readonly PlanningTimelineDebt[]): Cause[] {
  const today = board.today;
  const open = debts.filter(unpaid);
  const out: Cause[] = [];
  for (const debt of open.filter(row => row.dueAt && day(row.dueAt) < today)) {
    const steps = board.plans.flatMap(plan => { const index = plan.steps.findIndex(step => step.kind === 'debt' && step.relatedId === debt.id && !stepDone(step)); return index >= 0 ? [`${plan.id} 第 ${index + 1} 步`] : []; });
    out.push({ key: keyOf('debt', debt.id), tone: 'bad', keys: [keyOf('debt', debt.id)], text: `${debt.id} ${debt.title} 逾期 ${days(debt.dueAt!, today)} 天${steps.length ? `，挡住 ${steps.join('、')}` : ''}` });
  }
  const waiting = open.filter(row => row.decisionId && board.decisions.find(d => d.id === row.decisionId)?.status === 'proposed');
  if (waiting.length) out.push({ key: keyOf('debt', waiting[0].id), tone: 'warn', keys: waiting.map(row => keyOf('debt', row.id)), text: `${waiting.length} 笔债在等决策定下来：${list(waiting.map(row => `${row.id}（${row.decisionId}）`))}` });
  const high = open.filter(row => row.priority === 'high');
  out.push({ key: 'ledger', tone: 'info', keys: [], text: `未还 ${open.length} 笔，其中高息 ${high.length} 笔` });
  const review = open.filter(row => row.reviewAt && days(today, row.reviewAt) >= 0 && days(today, row.reviewAt) <= 7);
  if (review.length) out.push({ key: keyOf('debt', review[0].id), tone: 'info', keys: review.map(row => keyOf('debt', row.id)), text: `一周内复核 ${review.length} 笔：${list(review.map(row => `${row.id}（${monthDay(day(row.reviewAt))}）`))}` });
  return out;
}

/** 时间轴的范围：结束在今天之后三周（看得到到期），开始按周对齐到周一。 */
export function timelineRange(today: string, weeks: number) {
  const t = new Date(today + 'T00:00:00Z');
  const monday = new Date(t.getTime() - ((t.getUTCDay() + 6) % 7) * DAY);
  const start = new Date(monday.getTime() - (weeks - 1) * 7 * DAY);
  const end = new Date(monday.getTime() + 4 * 7 * DAY);
  const iso = (d: Date) => d.toISOString().slice(0, 10);
  const weekStarts = Array.from({ length: Math.round((end.getTime() - start.getTime()) / (7 * DAY)) }, (_, i) => iso(new Date(start.getTime() + i * 7 * DAY)));
  return { start: iso(start), end: iso(end), weekStarts, thisWeek: iso(monday) };
}
