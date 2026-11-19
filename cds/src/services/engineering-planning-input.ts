import {
  clearableDebtFields, debtApproachStates, debtPriorities, planningEvidenceTypes, planningSourceTypes, planningStepKinds,
  type CriterionResult, type DebtDirection, type DebtDraft, type DebtPatch, type DecisionDraft, type PlanDraft, type PlanningCommand,
  type PlanningEvidence, type PlanningSource, type ProposalDraft, type RootCause,
} from '../shared/engineering-planning.js';

export class PlanningError extends Error {
  constructor(public readonly status: number, public readonly code: string, message: string) { super(message); }
}

export function rejectPlanning(status: number, code: string, message: string): never {
  throw new PlanningError(status, code, message);
}

function invalid(field: string, rule = '填写有效值'): never {
  return rejectPlanning(400, 'invalid', `请检查 ${field}，${rule}`);
}

function object(value: unknown, field: string, fields?: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid(field, '应为对象');
  const input = value as Record<string, unknown>;
  if (fields && Object.keys(input).some(key => !fields.includes(key))) invalid(field, '包含不支持的字段');
  return input;
}

export function planningText(value: unknown, field: string, max: number): string {
  if (typeof value !== 'string') invalid(field, '应为文字');
  const text = value.trim();
  if (!text || text.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(text)) {
    invalid(field, `请填写 1 至 ${max} 个字符`);
  }
  return text;
}

export function planningId(value: unknown, field: string): string {
  const id = planningText(value, field, 160);
  if (!/^[\w.:@/+\-]+$/.test(id)) invalid(field, '请使用原样编号');
  return id;
}

export function planningDay(value: unknown, field: string): string {
  const day = planningText(value, field, 10);
  const date = new Date(`${day}T00:00:00Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== day) {
    invalid(field, '请填写有效日期，格式 YYYY-MM-DD');
  }
  return day;
}

function of<const T extends string>(value: unknown, field: string, choices: readonly T[]): T {
  if (typeof value !== 'string' || !choices.includes(value as T)) invalid(field, '选项无效');
  return value as T;
}

function version(value: unknown, field = 'expectedVersion'): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) invalid(field, '请使用记录当前版本');
  return value;
}

function collection<T>(value: unknown, field: string, parse: (row: unknown) => T, max = 32, min = 0): T[] {
  if (!Array.isArray(value) || value.length < min || value.length > max) invalid(field, `应为 ${min} 至 ${max} 项`);
  return value.map(parse);
}

function location(value: unknown, field: string): string {
  const location = planningText(value, field, 2000);
  let parsed: URL;
  try { parsed = new URL(location); } catch { invalid(field, '应为 HTTP 或 HTTPS 链接'); }
  if (!['https:', 'http:'].includes(parsed.protocol) || parsed.username || parsed.password) {
    invalid(field, '应为不含用户凭据的 HTTP 或 HTTPS 链接');
  }
  return location;
}

function source(value: unknown): PlanningSource {
  const data = object(value, 'source', ['type', 'ref', 'url']);
  return {
    type: of(data.type, 'source.type', planningSourceTypes),
    ref: planningText(data.ref, 'source.ref', 300),
    ...(data.url === undefined ? {} : { url: location(data.url, 'source.url') }),
  };
}

function evidence(value: unknown, min = 0): PlanningEvidence[] {
  return collection(value, 'evidence', entry => {
    const data = object(entry, 'evidence', ['type', 'label', 'url']);
    return {
      type: of(data.type, 'evidence.type', planningEvidenceTypes),
      label: planningText(data.label, 'evidence.label', 500),
      ...(data.url === undefined ? {} : { url: location(data.url, 'evidence.url') }),
    };
  }, 24, min);
}

function criterionResults(value: unknown): CriterionResult[] {
  return collection(value, 'results', entry => {
    const data = object(entry, 'results', ['criterionId', 'verdict', 'note']);
    const verdict = of(data.verdict, 'results.verdict', ['met', 'na']);
    return {
      criterionId: planningId(data.criterionId, 'results.criterionId'),
      verdict,
      ...(data.note !== undefined || verdict === 'na' ? { note: planningText(data.note, 'results.note', 2000) } : {}),
    };
  }, 32, 1);
}

function rootCause(value: unknown): RootCause {
  const data = object(value, 'rootCause', ['state', 'text', 'basis']);
  const state = of(data.state, 'rootCause.state', ['pending', 'suspected', 'confirmed']);
  return {
    state,
    ...(data.text !== undefined || state !== 'pending' ? { text: planningText(data.text, 'rootCause.text', 4000) } : {}),
    ...(data.basis !== undefined || state === 'confirmed' ? { basis: planningText(data.basis, 'rootCause.basis', 4000) } : {}),
  };
}

function debtDirection(value: unknown): DebtDirection {
  const data = object(value, 'direction', ['target', 'approaches']);
  return {
    ...(data.target === undefined ? {} : { target: planningText(data.target, 'direction.target', 2000) }),
    ...(data.approaches === undefined ? {} : { approaches: collection(data.approaches, 'direction.approaches', value => {
      const entry = object(value, 'direction.approaches', ['title', 'status', 'note']);
      return {
        title: planningText(entry.title, 'direction.approaches.title', 120),
        status: of(entry.status, 'direction.approaches.status', debtApproachStates),
        ...(entry.note === undefined ? {} : { note: planningText(entry.note, 'direction.approaches.note', 2000) }),
      };
    }, 12) }),
  };
}

const debtFields = ['title', 'summary', 'whyDebt', 'decisionId', 'priority', 'criteria', 'rootCause', 'impact', 'owner', 'dueAt', 'trigger', 'tags', 'direction'] as const;
const decisionFields = ['title', 'summary', 'rationale', 'owner', 'reviewAt', 'resolves'] as const;
const planFields = ['title', 'summary', 'decisionId', 'owner', 'dueAt'] as const;

function debtDraft(data: Record<string, unknown>, partial: true): Partial<DebtDraft>;
function debtDraft(data: Record<string, unknown>, partial?: false): DebtDraft;
function debtDraft(data: Record<string, unknown>, partial = false): Partial<DebtDraft> {
  const result: Partial<DebtDraft> = {};
  if (!partial || data.title !== undefined) result.title = planningText(data.title, 'title', 120);
  for (const key of ['summary', 'whyDebt', 'impact', 'trigger', 'owner'] as const) {
    if (data[key] !== undefined) result[key] = planningText(data[key], key, key === 'owner' ? 120 : 4000);
  }
  if (data.decisionId !== undefined) result.decisionId = planningId(data.decisionId, 'decisionId');
  if (data.priority !== undefined) result.priority = of(data.priority, 'priority', debtPriorities);
  if (data.dueAt !== undefined) result.dueAt = planningDay(data.dueAt, 'dueAt');
  if (data.rootCause !== undefined) result.rootCause = rootCause(data.rootCause);
  if (data.direction !== undefined) result.direction = debtDirection(data.direction);
  if (data.criteria !== undefined) {
    result.criteria = [...new Set(collection(data.criteria, 'criteria', row => planningText(row, 'criteria', 400)))];
  }
  if (data.tags !== undefined) {
    result.tags = [...new Set(collection(data.tags, 'tags', row => {
      const tag = planningText(row, 'tags', 80).replaceAll('／', '/').split('/').map(part => part.trim());
      if (tag.length > 4 || tag.some(part => !part)) invalid('tags', '请填写有效的分类层级');
      return tag.join('/');
    }, 20))];
  }
  return result;
}

function decisionDraft(data: Record<string, unknown>): DecisionDraft {
  return {
    title: planningText(data.title, 'title', 120),
    ...(data.summary === undefined ? {} : { summary: planningText(data.summary, 'summary', 4000) }),
    ...(data.rationale === undefined ? {} : { rationale: planningText(data.rationale, 'rationale', 6000) }),
    ...(data.owner === undefined ? {} : { owner: planningText(data.owner, 'owner', 120) }),
    ...(data.reviewAt === undefined ? {} : { reviewAt: planningDay(data.reviewAt, 'reviewAt') }),
    ...(data.resolves === undefined ? {} : { resolves: [...new Set(collection(data.resolves, 'resolves', row => planningId(row, 'resolves')))] }),
  };
}

function planDraft(data: Record<string, unknown>): PlanDraft {
  return {
    title: planningText(data.title, 'title', 120),
    ...(data.summary === undefined ? {} : { summary: planningText(data.summary, 'summary', 4000) }),
    ...(data.owner === undefined ? {} : { owner: planningText(data.owner, 'owner', 120) }),
    ...(data.decisionId === undefined ? {} : { decisionId: planningId(data.decisionId, 'decisionId') }),
    ...(data.dueAt === undefined ? {} : { dueAt: planningDay(data.dueAt, 'dueAt') }),
  };
}

function proposal(kind: unknown, draft: unknown): ProposalDraft {
  switch (of(kind, 'kind', ['debt', 'decision', 'plan'])) {
    case 'debt': return { kind: 'debt', draft: debtDraft(object(draft, 'draft', debtFields)) };
    case 'decision': return { kind: 'decision', draft: decisionDraft(object(draft, 'draft', decisionFields)) };
    case 'plan': return { kind: 'plan', draft: planDraft(object(draft, 'draft', planFields)) };
  }
}

export function parsePlanningCommand(input: unknown): PlanningCommand {
  const value = object(input, 'command');
  const requestId = planningId(value.requestId, 'requestId');
  const fields = (...keys: string[]) => object(value, 'command', ['type', 'requestId', ...keys]);
  const debt = (...keys: string[]) => {
    fields('debtId', 'expectedVersion', ...keys);
    return { debtId: planningId(value.debtId, 'debtId'), expectedVersion: version(value.expectedVersion) };
  };
  const plan = (...keys: string[]) => {
    fields('planId', 'expectedVersion', ...keys);
    return { planId: planningId(value.planId, 'planId'), expectedVersion: version(value.expectedVersion) };
  };
  const reason = () => planningText(value.reason, 'reason', 2000);
  const note = () => planningText(value.note, 'note', 4000);
  const type = value.type;
  switch (type) {
    case 'proposal.submit':
      fields('source', 'kind', 'draft');
      return { type, requestId, source: source(value.source), ...proposal(value.kind, value.draft) };
    case 'proposal.accept':
      fields('proposalId');
      return { type, requestId, proposalId: planningId(value.proposalId, 'proposalId') };
    case 'proposal.reject':
      fields('proposalId', 'reason');
      return { type, requestId, proposalId: planningId(value.proposalId, 'proposalId'), reason: reason() };
    case 'debt.create':
      return { type, requestId, source: source(value.source), ...debtDraft(fields('source', ...debtFields)) };
    case 'debt.import':
      fields('items');
      return {
        type, requestId,
        items: collection(value.items, 'items', row => {
          const data = object(row, 'items', [...debtFields, 'source', 'discoveredAt']);
          const origin = source(data.source);
          if (origin.type !== 'import') invalid('source.type', '批量录入应为 import');
          return { ...debtDraft(data), source: origin,
            ...(data.discoveredAt === undefined ? {} : { discoveredAt: planningDay(data.discoveredAt, 'discoveredAt') }) };
        }, 100, 1),
      };
    case 'debt.update': {
      const target = debt('patch');
      const draft = { ...object(value.patch, 'patch', debtFields.filter(key => key !== 'decisionId')) };
      const clears: DebtPatch = {};
      for (const key of clearableDebtFields) {
        if (draft[key] !== null) continue;
        clears[key] = null;
        delete draft[key];
      }
      const patch = { ...debtDraft(draft, true), ...clears };
      if (!Object.keys(patch).length) invalid('patch', '请填写要修改的字段');
      return { type, requestId, ...target, patch };
    }
    case 'debt.branch':
      return { type, requestId, ...debt('decisionId', 'reason'), decisionId: value.decisionId === null ? null : planningId(value.decisionId, 'decisionId'), reason: reason() };
    case 'debt.defer':
      return { type, requestId, ...debt('reason', 'reviewAt'), reason: reason(), reviewAt: planningDay(value.reviewAt, 'reviewAt') };
    case 'debt.start':
    case 'debt.progress':
    case 'debt.hit':
      return { type, requestId, ...debt('note'), note: note() };
    case 'debt.repay':
      return { type, requestId, ...debt('summary', 'results', 'evidence'), summary: planningText(value.summary, 'summary', 6000), results: criterionResults(value.results), evidence: evidence(value.evidence, 1) };
    case 'debt.reopen':
      return { type, requestId, ...debt('reason'), reason: reason() };
    case 'debt.drop': {
      const target = debt('kind', 'reason', 'targetId', 'evidence');
      const kind = of(value.kind, 'kind', ['cancelled', 'superseded', 'extinct']);
      if (kind !== 'superseded' && value.targetId !== undefined) invalid('targetId', '只有替代操作可填承接编号');
      return {
        type, requestId, ...target, kind, reason: reason(),
        ...(kind === 'superseded' ? { targetId: planningId(value.targetId, 'targetId') } : {}),
        ...(value.evidence !== undefined || kind === 'extinct' ? { evidence: evidence(value.evidence, kind === 'extinct' ? 1 : 0) } : {}),
      };
    }
    case 'debt.merge':
      return { type, requestId, ...debt('fromId', 'fromVersion', 'reason'), fromId: planningId(value.fromId, 'fromId'), fromVersion: version(value.fromVersion, 'fromVersion'), reason: reason() };
    case 'decision.create':
      return { type, requestId, source: source(value.source), ...decisionDraft(fields('source', ...decisionFields)) };
    case 'decision.change': {
      fields('decisionId', 'expectedVersion', 'change', 'reason', 'successorId', 'transfer');
      const change = of(value.change, 'change', ['accepted', 'amended', 'reviewed', 'superseded', 'deprecated']);
      if (change !== 'superseded' && (value.successorId !== undefined || value.transfer !== undefined)) invalid('successorId', '只有取代决策可指定接替与转移');
      if (value.transfer !== undefined && typeof value.transfer !== 'boolean') invalid('transfer', '应为布尔值');
      return {
        type, requestId, decisionId: planningId(value.decisionId, 'decisionId'), expectedVersion: version(value.expectedVersion),
        change, reason: reason(),
        ...(change === 'superseded' ? { successorId: planningId(value.successorId, 'successorId'), transfer: value.transfer !== false } : {}),
      };
    }
    case 'plan.create':
      return { type, requestId, source: source(value.source), ...planDraft(fields('source', ...planFields)) };
    case 'plan.add-step': {
      const target = plan('kind', 'title', 'relatedId', 'dueAt');
      const kind = of(value.kind, 'kind', planningStepKinds);
      if (kind === 'task' && value.relatedId !== undefined) invalid('relatedId', '普通任务无需关联编号');
      return {
        type, requestId, ...target, kind, title: planningText(value.title, 'title', 120),
        ...(kind === 'task' ? {} : { relatedId: planningId(value.relatedId, 'relatedId') }),
        ...(value.dueAt === undefined ? {} : { dueAt: planningDay(value.dueAt, 'dueAt') }),
      };
    }
    case 'plan.step':
      return { type, requestId, ...plan('stepId', 'status', 'note'), stepId: planningId(value.stepId, 'stepId'), status: of(value.status, 'status', ['todo', 'doing', 'done']), note: note() };
    default:
      return invalid('type', '不是支持的工程规划操作');
  }
}
