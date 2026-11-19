import { createHash } from 'node:crypto';
import {
  planningPermissions, type DebtStatus, type PlanningActor, type PlanningBoard, type PlanningCapabilities,
  type PlanningCounts, type PlanningDebt, type PlanningDebtDetail, type PlanningDebtList, type PlanningEvent,
  type PlanningPlan, type PlanningReceipt, type PlanningStats,
} from '../shared/engineering-planning.js';
import { PlanningMutation, planningToday, unpaid, type PlanningState } from './engineering-planning-domain.js';
import { buildDebtBrief } from './engineering-planning-brief.js';
import { parsePlanningCommand, planningDay, planningId, planningText, rejectPlanning } from './engineering-planning-input.js';
import type { EngineeringPlanningCommit, EngineeringPlanningStore } from './engineering-planning-store.js';
export { FileEngineeringPlanningStore, MongoEngineeringPlanningStore } from './engineering-planning-store.js';

const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const DAY = 86_400_000;

function empty(): PlanningState {
  return { revision: 0, debts: new Map(), decisions: new Map(), plans: new Map(), proposals: new Map(), events: [], receipts: new Map() };
}

function apply(base: PlanningState, commits: EngineeringPlanningCommit[], projectId: string): PlanningState {
  if (commits.length === 0) return base;
  const state = {
    revision: base.revision, debts: new Map(base.debts), decisions: new Map(base.decisions),
    plans: new Map(base.plans), proposals: new Map(base.proposals), events: [...base.events], receipts: new Map(base.receipts),
  };
  for (const commit of commits) {
    if (commit.projectId !== projectId || commit.revision !== state.revision + 1) throw new Error('Planning history is incomplete');
    for (const row of commit.debts) state.debts.set(row.id, row);
    for (const row of commit.decisions) state.decisions.set(row.id, row);
    for (const row of commit.plans) state.plans.set(row.id, row);
    for (const row of commit.proposals) state.proposals.set(row.id, row);
    state.events.push(...commit.events);
    state.receipts.set(commit.request.key, commit.request);
    state.revision = commit.revision;
  }
  return state;
}

type DebtQuery = { q?: unknown; cursor?: unknown; branch?: unknown; tag?: unknown; view?: unknown; limit?: unknown };
type StatsQuery = { from?: unknown; to?: unknown; branch?: unknown };
type Cursor = { revision: number; offset: number; filter: string };
const debtViews = ['unpaid', 'review_due', 'overdue', 'open', 'deferred', 'in_progress', 'repaid', 'dropped', 'all'];
const debtCentricView = (view: string, debt: PlanningDebt, today: string) => {
  switch (view) {
    case 'all': return true;
    case 'unpaid': return unpaid(debt);
    case 'review_due': return debt.status === 'deferred' && !!debt.reviewAt && debt.reviewAt <= today;
    case 'overdue': return unpaid(debt) && !!debt.dueAt && debt.dueAt < today;
    default: return debt.status === view;
  }
};

function pageCursor(value: unknown, fingerprint: string, revision: number): Cursor {
  if (value === undefined) return { revision, offset: 0, filter: fingerprint };
  const encoded = planningText(value, 'cursor', 300);
  let record: Partial<Cursor> | undefined;
  try { record = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')); } catch { /* invalid cursor */ }
  if (!record || record.filter !== fingerprint || typeof record.revision !== 'number' || !Number.isSafeInteger(record.revision)
    || record.revision < 0 || record.revision > revision || typeof record.offset !== 'number' || !Number.isSafeInteger(record.offset) || record.offset < 0) {
    rejectPlanning(400, 'invalid_cursor', '分页条件已变化，请从第一页重新查询');
  }
  return record as Cursor;
}

const order = <T extends { updatedAt: string; id: string }>(a: T, b: T) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id);
function planProjection(plan: PlanningPlan, debts: PlanningState['debts']): PlanningPlan {
  return { ...plan, steps: plan.steps.map(step => {
    const debt = step.kind === 'debt' && step.relatedId ? debts.get(step.relatedId) : undefined;
    if (!debt) return step;
    const status = { open: 'todo', deferred: 'todo', in_progress: 'doing', repaid: 'done', dropped: 'cancelled' } as const;
    return { ...step, status: status[debt.status] };
  }) };
}

const counts = (): PlanningCounts => ({
  created: 0, imported: 0, repaid: 0, reopened: 0, dropped: 0, extinct: 0, merged: 0, transferredIn: 0, transferredOut: 0,
});
const matchesBranch = (id: string | undefined, branch: string | undefined) => !branch || (branch === 'none' ? !id : id === branch);
const active = (status: DebtStatus | undefined) => Boolean(status && unpaid({ status }));

function eventDelta(event: PlanningEvent, branch?: string): { kind: keyof PlanningCounts; delta: number } | undefined {
  if (event.entity !== 'debt') return;
  const before = active(event.fromStatus) && matchesBranch(event.fromDecisionId, branch);
  const after = active(event.toStatus) && matchesBranch(event.toDecisionId, branch);
  if (before === after) return;
  if (event.type === 'branch_moved') return after ? { kind: 'transferredIn', delta: 1 } : { kind: 'transferredOut', delta: -1 };
  switch (event.type) {
    case 'created':
    case 'imported':
    case 'reopened': return { kind: event.type, delta: 1 };
    case 'repaid':
    case 'dropped':
    case 'extinct': return { kind: event.type, delta: -1 };
    case 'merged_into': return { kind: 'merged', delta: -1 };
  }
}

const dayStamp = (date: string) => Date.parse(`${date}T00:00:00Z`);
const isoDay = (time: number) => new Date(time).toISOString().slice(0, 10);

export class EngineeringPlanningService {
  private readonly latest = new Map<string, PlanningState>();

  constructor(private readonly store: EngineeringPlanningStore, private readonly now = () => new Date()) {}

  private async load(projectId: string, revision?: number): Promise<PlanningState> {
    const base = this.latest.get(projectId) ?? empty();
    if (base.revision === revision) return base;
    if (revision !== undefined) {
      const commits = await this.store.read(projectId, 0);
      return apply(empty(), commits.filter(commit => commit.revision <= revision), projectId);
    }
    const commits = await this.store.read(projectId, base.revision);
    const state = apply(base, commits, projectId);
    const cached = this.latest.get(projectId);
    if (cached && cached.revision > state.revision) return cached;
    this.latest.set(projectId, state);
    return state;
  }

  capabilities(projectId: string, actor: PlanningActor): PlanningCapabilities {
    return { projectId, protocolVersion: 1,
      permissions: planningPermissions.filter(permission => actor.permissions.includes(permission) && (permission !== 'approve' || actor.kind === 'human')) };
  }

  async command(projectId: string, actor: PlanningActor, input: unknown): Promise<PlanningReceipt> {
    const command = parsePlanningCommand(input);
    const approval = command.type === 'proposal.accept' || command.type === 'proposal.reject';
    const need = approval ? 'approve' : command.type === 'proposal.submit' ? 'propose' : 'write';
    if (!actor.permissions.includes(need) || (actor.kind === 'agent' && command.type !== 'proposal.submit' && command.type !== 'debt.create')) {
      rejectPlanning(403, 'write_forbidden', approval ? '请由该项目有确认权限的成员处理提案' : '当前授权不允许此操作，请检查项目权限');
    }
    const key = hash([actor.kind, actor.id, command.requestId]);
    const fingerprint = hash(command);
    for (let attempts = 0; attempts < 10; attempts++) {
      const state = await this.load(projectId);
      const previous = state.receipts.get(key);
      if (previous) {
        if (previous.fingerprint !== fingerprint) rejectPlanning(409, 'idempotency_conflict', '该请求编号已用于其他内容，请检查原提交');
        return { ...previous.receipt, reused: true };
      }

      const mutation = new PlanningMutation(state, projectId, actor, this.now().toISOString());
      const result = mutation.run(command);
      const receipt = { projectId, result, reused: mutation.reused };
      const commit: EngineeringPlanningCommit = { projectId, revision: state.revision + 1,
        request: { key, fingerprint, receipt }, ...mutation.changes };
      if (await this.store.append(commit)) {
        if ((this.latest.get(projectId)?.revision ?? 0) <= state.revision) {
          this.latest.set(projectId, apply(state, [commit], projectId));
        }
        return receipt;
      }
    }
    return rejectPlanning(409, 'write_contention', '项目正在接收其他更新，请用相同请求编号重试');
  }

  async board(projectId: string, actor: PlanningActor): Promise<PlanningBoard> {
    const state = await this.load(projectId);
    const today = planningToday(this.now());
    return {
      ...this.capabilities(projectId, actor),
      today,
      proposals: [...state.proposals.values()].sort(order),
      decisions: [...state.decisions.values()].sort(order),
      plans: [...state.plans.values()].sort(order).map(plan => planProjection(plan, state.debts)),
      events: state.events.filter(event => event.entity !== 'debt').slice(-250).reverse(),
      pendingReviewCount: [...state.decisions.values()].filter(row => row.status === 'accepted' && row.reviewAt && row.reviewAt <= today
        && (!row.reviewedAt || planningToday(new Date(row.reviewedAt)) < row.reviewAt)).length,
    };
  }

  async debts(projectId: string, query: DebtQuery = {}): Promise<PlanningDebtList> {
    const live = await this.load(projectId);
    const q = query.q === undefined || query.q === '' ? '' : planningText(query.q, 'q', 200).toLocaleLowerCase();
    const branch = query.branch === undefined ? undefined : planningId(query.branch, 'branch');
    const tag = query.tag === undefined ? undefined : planningText(query.tag, 'tag', 80);
    const view = query.view === undefined ? 'unpaid' : planningText(query.view, 'view', 32).replaceAll('-', '_');
    const limitValue = query.limit ?? '50';
    if (!debtViews.includes(view) || typeof limitValue !== 'string' || !/^[1-9]\d{0,2}$/.test(limitValue) || Number(limitValue) > 100) {
      rejectPlanning(400, 'invalid', '请检查债务视图和分页范围');
    }
    const today = planningToday(this.now());
    const limit = Number(limitValue);
    const cursor = pageCursor(query.cursor, hash([projectId, view, q, branch, tag, limit, today]), live.revision);
    const state = cursor.revision === live.revision ? live : await this.load(projectId, cursor.revision);
    if (branch && branch !== 'none' && !state.decisions.has(branch)) rejectPlanning(404, 'not_found', '此项目没有这条决策');
    const terms = q ? q.split(/\s+/u) : [];
    const items = [...state.debts.values()].filter(debt => {
      if (!matchesBranch(debt.decisionId, branch) || !debtCentricView(view, debt, today)) return false;
      if (tag && !(debt.tags?.length ? debt.tags.some(value => value.split('/')[0] === tag) : tag === '未分类')) return false;
      if (!terms.length) return true;
      const text = [debt.id, debt.title, debt.summary, debt.whyDebt, debt.owner, debt.tags?.join(' '), debt.source.ref, debt.rootCause?.text].join(' ').toLocaleLowerCase();
      return terms.every(term => text.includes(term));
    }).sort((a, b) => Number(b.id.toLocaleLowerCase() === q) - Number(a.id.toLocaleLowerCase() === q) || order(a, b));
    const next = cursor.offset + limit;
    return { projectId, today, items: items.slice(cursor.offset, next),
      nextCursor: next < items.length ? Buffer.from(JSON.stringify({ ...cursor, offset: next })).toString('base64url') : null };
  }

  async debt(projectId: string, id: string): Promise<PlanningDebtDetail> {
    const state = await this.load(projectId);
    const debt = state.debts.get(id);
    if (!debt) rejectPlanning(404, 'not_found', '此项目没有这条债务');
    const events = state.events.filter(item => item.entity === 'debt' && item.entityId === id).reverse();
    const plans = [...state.plans.values()].filter(plan => plan.steps.some(step => step.kind === 'debt' && step.relatedId === id));
    const brief = buildDebtBrief(debt, events, {
      origin: debt.originDecisionId ? state.decisions.get(debt.originDecisionId) : undefined,
      current: debt.decisionId ? state.decisions.get(debt.decisionId) : undefined,
      plans,
    }, this.now());
    return { projectId, debt, events, brief };
  }

  async stats(projectId: string, query: StatsQuery = {}): Promise<PlanningStats> {
    const state = await this.load(projectId);
    const to = query.to === undefined ? planningToday(this.now()) : planningDay(query.to, 'to');
    const from = query.from === undefined ? isoDay(dayStamp(to) - 29 * DAY) : planningDay(query.from, 'from');
    const branch = query.branch === undefined ? undefined : planningId(query.branch, 'branch');
    if (branch && branch !== 'none' && !state.decisions.has(branch)) rejectPlanning(404, 'not_found', '此项目没有这条决策');
    const length = (dayStamp(to) - dayStamp(from)) / DAY + 1;
    if (length < 1 || length > 366) rejectPlanning(400, 'invalid', '请选择最长 366 天的统计区间');
    const totals = counts();
    let backlogStart = 0;
    const days = new Map<string, { counts: PlanningCounts; delta: number }>();
    for (const event of state.events) {
      const change = eventDelta(event, branch);
      if (!change) continue;
      const date = planningToday(new Date(event.at));
      if (date < from) { backlogStart += change.delta; continue; }
      if (date > to) continue;
      const day = days.get(date) ?? { counts: counts(), delta: 0 };
      day.delta += change.delta;
      day.counts[change.kind]++;
      totals[change.kind]++;
      days.set(date, day);
    }
    let backlogEnd = backlogStart;
    const buckets = Array.from({ length }, (_, offset) => {
      const day = isoDay(dayStamp(from) + offset * DAY);
      const entry = days.get(day);
      backlogEnd += entry?.delta ?? 0;
      return { day, backlog: backlogEnd, ...(entry?.counts ?? counts()) };
    });
    const categories = new Map<string, PlanningStats['categories'][number]>();
    for (const debt of state.debts.values()) {
      if (!matchesBranch(debt.decisionId, branch)) continue;
      const labels = new Set(debt.tags?.length ? debt.tags.map(tag => tag.split('/')[0]) : ['未分类']);
      for (const name of labels) {
        const entry = categories.get(name) ?? { name, unpaid: 0, repaid: 0, dropped: 0 };
        if (unpaid(debt)) entry.unpaid++;
        else if (debt.status === 'repaid') entry.repaid++;
        else entry.dropped++;
        categories.set(name, entry);
      }
    }
    return { projectId, from, to, backlogStart, backlogEnd, ...totals, buckets,
      categories: [...categories.values()].sort((a, b) => b.unpaid - a.unpaid || a.name.localeCompare(b.name)) };
  }
}
