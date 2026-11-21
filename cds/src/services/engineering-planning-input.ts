import {
  planningAnchorTypes, planningVerificationMethods, planningVerificationPeriods, decisionProvenanceLevels, decisionSubjectKinds,
  clearableDebtFields, debtApproachStates, debtPriorities, legacyDebtStatuses, planningDecisionLinkTypes, planningEvidenceTypes, planningSourceTypes, planningStepKinds,
  type CriterionResult, type DebtDirection, type DebtDraft, type DebtPatch, type DecisionDraft, type DecisionProvenance, type DecisionStructure, type LegacyDebtOrigin, type PlanDraft, type PlanningCommand,
  type PlanningDecisionLink, type PlanningEvidence, type PlanningPullRequestReference, type PlanningRepaymentProof, type PlanningProposalSource, type PlanningStepDraft,
  type PlanningDuplicateCandidate, type PlanningImportRow, type ProposalDecisionChange, type ProposalDraft, type RootCause,
} from '../shared/engineering-planning.js';
import { normalizePlanningPreviewPath, planningGitHubPullRequest } from '../shared/engineering-planning-links.js';

export class PlanningError extends Error {
  constructor(public readonly status: number, public readonly code: string, message: string,
    public readonly candidates?: PlanningDuplicateCandidate[]) { super(message); }
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

function source(value: unknown, withExcerpt = false): PlanningProposalSource {
  const data = object(value, 'source', withExcerpt ? ['type', 'ref', 'url', 'excerpt'] : ['type', 'ref', 'url']);
  return {
    type: of(data.type, 'source.type', planningSourceTypes),
    ref: planningText(data.ref, 'source.ref', 300),
    ...(data.url === undefined ? {} : { url: location(data.url, 'source.url') }),
    ...(data.excerpt === undefined ? {} : { excerpt: planningText(data.excerpt, '触发来源摘要', 1200) }),
  };
}

function proposalConfidence(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
    invalid('把握度', '请填写 0 到 1 之间的数字');
  }
  return value;
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
    const data = object(entry, 'results', ['criterionId', 'verdict', 'note', 'evidence']);
    const verdict = of(data.verdict, 'results.verdict', ['met', 'na']);
    return {
      criterionId: planningId(data.criterionId, 'results.criterionId'),
      verdict,
      ...(data.note !== undefined || verdict === 'na' ? { note: planningText(data.note, 'results.note', 2000) } : {}),
      ...(data.evidence !== undefined ? { evidence: evidence(data.evidence) } : {}),
    };
  }, 32, 1);
}

function repaymentProofs(value: unknown): PlanningRepaymentProof[] {
  const proofs = collection(value, 'repaymentProofs', entry => {
    const data = object(entry, 'repaymentProofs', ['stage', 'label', 'dataUrl', 'mark']);
    const stage = of(data.stage, 'repaymentProofs.stage', ['before', 'after']);
    const mark = object(data.mark, 'repaymentProofs.mark', ['x', 'y', 'width', 'height']);
    const fraction = (name: string) => {
      const number = mark[name];
      if (typeof number !== 'number' || !Number.isFinite(number) || number < 0 || number > 1) {
        invalid('repaymentProofs.mark', '请在图片内标出证据位置');
      }
      return number;
    };
    const x = fraction('x'), y = fraction('y'), width = fraction('width'), height = fraction('height');
    if (width < .02 || height < .02 || x + width > 1.000001 || y + height > 1.000001) {
      invalid('repaymentProofs.mark', '标记过小或超出图片范围');
    }
    const dataUrl = data.dataUrl;
    if (typeof dataUrl !== 'string' || dataUrl.length > 820_000) invalid('repaymentProofs.dataUrl', '截图不得超过 600 KiB');
    const match = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/]+={0,2})$/.exec(dataUrl);
    if (!match) invalid('repaymentProofs.dataUrl', '请使用 PNG、JPEG 或 WebP 截图');
    const [, mime, encoded] = match;
    const bytes = Buffer.from(encoded, 'base64');
    if (bytes.length < 12 || bytes.length > 600 * 1024 || bytes.toString('base64') !== encoded) {
      invalid('repaymentProofs.dataUrl', '截图不完整或超出 600 KiB');
    }
    const valid = {
      'image/png': bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) && bytes.toString('ascii', 12, 16) === 'IHDR',
      'image/jpeg': bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff && bytes.at(-2) === 0xff && bytes.at(-1) === 0xd9,
      'image/webp': bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP',
    }[mime];
    if (!valid) invalid('repaymentProofs.dataUrl', '截图格式与文件内容不符');
    return { stage, dataUrl, label: planningText(data.label, 'repaymentProofs.label', 500),
      mark: { x, y, width: Math.min(width, 1 - x), height: Math.min(height, 1 - y) } };
  }, 2, 1);
  if (!proofs.some(proof => proof.stage === 'after') || new Set(proofs.map(proof => proof.stage)).size !== proofs.length) {
    invalid('repaymentProofs', '请上传一张标注完毕的还后截图');
  }
  return proofs;
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

const debtFields = ['title', 'summary', 'whyDebt', 'decisionId', 'priority', 'criteria', 'rootCause', 'impact', 'owner', 'module', 'dueAt', 'trigger', 'tags', 'direction'] as const;
const decisionStructureFields = ['decisionKind', 'options', 'chosenOption', 'consequences', 'aliases', 'appliesTo', 'provenance'] as const;
const decisionFields = ['title', 'summary', 'rationale', 'owner', 'reviewAt', 'resolves', 'links', 'pullRequest', ...decisionStructureFields] as const;
const planFields = ['title', 'summary', 'decisionId', 'owner', 'startAt', 'dueAt'] as const;
const stepFields = ['kind', 'title', 'relatedId', 'dueAt', 'owner'] as const;

function planningStepDraft(value: Record<string, unknown>): PlanningStepDraft {
  const kind = of(value.kind, 'kind', planningStepKinds);
  if (kind === 'task' && value.relatedId !== undefined) invalid('relatedId', '普通任务无需关联编号');
  return { kind, title: planningText(value.title, 'title', 120),
    ...(kind === 'task' ? {} : { relatedId: planningId(value.relatedId, 'relatedId') }),
    ...(value.dueAt === undefined ? {} : { dueAt: planningDay(value.dueAt, 'dueAt') }),
    ...(value.owner === undefined ? {} : { owner: planningText(value.owner, 'owner', 120) }),
  };
}

export function planningImportInputs(value: unknown): unknown[] {
  const data = object(value, '导入内容', ['items']);
  return collection(data.items, 'items', row => row, 100, 1);
}

function legacyDebtOrigin(value: unknown, sourceRef: string): LegacyDebtOrigin {
  const data = object(value, 'legacy', ['status', 'originalStatus', 'path', 'commit', 'line']);
  const path = planningText(data.path, 'legacy.path', 200);
  const module = /^doc\/debt\.([a-z0-9][a-z0-9.-]*)\.md$/i.exec(path)?.[1];
  const [refModule, refNumber, extra] = sourceRef.split('#');
  if (!module || refModule !== module || !refNumber || extra !== undefined || !/^[a-z0-9][a-z0-9._-]{0,159}$/i.test(refNumber)) {
    invalid('source.ref', '请使用与原台账路径对应的模块加原编号，例如 cds#1');
  }
  const commit = planningText(data.commit, 'legacy.commit', 40);
  if (!/^[a-f0-9]{40}$/.test(commit)) invalid('legacy.commit', '请使用完整的小写 Git 提交号');
  const line = data.line;
  if (typeof line !== 'number' || !Number.isSafeInteger(line) || line < 1) invalid('legacy.line', '请使用原记录的行号');
  return {
    path, commit, line, status: of(data.status, 'legacy.status', legacyDebtStatuses),
    originalStatus: planningText(data.originalStatus, 'legacy.originalStatus', 120),
  };
}

export function planningImportRow(value: unknown): PlanningImportRow {
  const row = object(value, 'items', [...debtFields, 'source', 'discoveredAt', 'legacy']);
  const origin = source(row.source);
  if (origin.type !== 'import') invalid('source.type', '批量录入应为 import');
  return { ...debtDraft(row), source: origin,
    ...(row.legacy === undefined ? {} : { legacy: legacyDebtOrigin(row.legacy, origin.ref) }),
    ...(row.discoveredAt === undefined ? {} : { discoveredAt: planningDay(row.discoveredAt, 'discoveredAt') }) };
}

function debtDraft(data: Record<string, unknown>, partial: true): Partial<DebtDraft>;
function debtDraft(data: Record<string, unknown>, partial?: false): DebtDraft;
function debtDraft(data: Record<string, unknown>, partial = false): Partial<DebtDraft> {
  const result: Partial<DebtDraft> = {};
  if (!partial || data.title !== undefined) result.title = planningText(data.title, 'title', 120);
  for (const key of ['summary', 'whyDebt', 'impact', 'trigger', 'owner'] as const) {
    if (data[key] !== undefined) result[key] = planningText(data[key], key, key === 'owner' ? 120 : 4000);
  }
  if (data.decisionId !== undefined) result.decisionId = planningId(data.decisionId, 'decisionId');
  if (data.module !== undefined) result.module = planningText(data.module, 'module', 80);
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

function decisionLinks(value: unknown): PlanningDecisionLink[] {
  return collection(value, 'links', row => {
    const data = object(row, 'links', ['type', 'title', 'url']);
    return { type: of(data.type, 'links.type', planningDecisionLinkTypes), title: planningText(data.title, 'links.title', 200),
      url: location(data.url, 'links.url') };
  }, 16);
}

function pullRequestReference(value: unknown): PlanningPullRequestReference {
  const data = object(value, 'pullRequest', ['url', 'target']);
  const reference = planningGitHubPullRequest(data.url);
  if (!reference) invalid('pullRequest.url', '请填写 GitHub PR 链接');
  if (data.target === undefined) return { url: reference.url };
  const target = object(data.target, 'pullRequest.target', ['label', 'path']);
  const path = normalizePlanningPreviewPath(target.path);
  if (!path) invalid('pullRequest.target.path', '请填写以 / 开头的预览页面路径');
  return { url: reference.url, target: { label: planningText(target.label, 'pullRequest.target.label', 160), path } };
}

function decisionProvenance(input: unknown): DecisionProvenance {
  const data = object(input, 'provenance', ['level', 'url', 'occurredOn', 'decidedBy', 'basis']);
  const level = of(data.level, 'provenance.level', decisionProvenanceLevels);
  const basis = data.basis === undefined ? undefined : planningText(data.basis, 'provenance.basis', 2000);
  if (level === 'inferred' && !basis) invalid('provenance.basis', '写明推断依据');
  return {
    level, url: location(data.url, 'provenance.url'),
    ...(data.occurredOn === undefined ? {} : { occurredOn: planningDay(data.occurredOn, 'provenance.occurredOn') }),
    ...(data.decidedBy === undefined ? {} : { decidedBy: planningText(data.decidedBy, 'provenance.decidedBy', 120) }),
    ...(basis === undefined ? {} : { basis }),
  };
}

function decisionStructure(data: Record<string, unknown>): DecisionStructure {
  const options = data.options === undefined ? undefined : collection(data.options, 'options', row => {
    const value = object(row, 'options', ['title', 'benefits', 'drawbacks']);
    return {
      title: planningText(value.title, 'options.title', 120),
      ...(value.benefits === undefined ? {} : { benefits: planningText(value.benefits, 'options.benefits', 2000) }),
      ...(value.drawbacks === undefined ? {} : { drawbacks: planningText(value.drawbacks, 'options.drawbacks', 2000) }),
    };
  }, 12);
  const chosenOption = data.chosenOption === undefined ? undefined : planningText(data.chosenOption, 'chosenOption', 120);
  if (chosenOption && !options?.some(row => row.title === chosenOption)) invalid('chosenOption', '请从已列出的候选方案选择');
  if (options && new Set(options.map(row => row.title)).size !== options.length) invalid('options', '候选方案标题重复');
  const appliesTo = data.appliesTo === undefined ? undefined : collection(data.appliesTo, 'appliesTo', row => {
    const value = object(row, 'appliesTo', ['kind', 'ref']);
    return { kind: of(value.kind, 'appliesTo.kind', decisionSubjectKinds), ref: planningText(value.ref, 'appliesTo.ref', 200) };
  }, 16);
  return {
    ...(data.decisionKind === undefined ? {} : { decisionKind: of(data.decisionKind, 'decisionKind', ['forward', 'debt']) }),
    ...(options === undefined ? {} : { options }),
    ...(chosenOption === undefined ? {} : { chosenOption }),
    ...(data.consequences === undefined ? {} : { consequences: planningText(data.consequences, 'consequences', 4000) }),
    ...(data.aliases === undefined ? {} : { aliases: [...new Set(collection(data.aliases, 'aliases', row => planningText(row, 'aliases', 96), 16))] }),
    ...(appliesTo === undefined ? {} : { appliesTo }),
    ...(data.provenance === undefined ? {} : { provenance: decisionProvenance(data.provenance) }),
  };
}

function decisionDraft(data: Record<string, unknown>): DecisionDraft {
  return {
    title: planningText(data.title, 'title', 120),
    ...decisionStructure(data),
    ...(data.summary === undefined ? {} : { summary: planningText(data.summary, 'summary', 4000) }),
    ...(data.rationale === undefined ? {} : { rationale: planningText(data.rationale, 'rationale', 6000) }),
    ...(data.owner === undefined ? {} : { owner: planningText(data.owner, 'owner', 120) }),
    ...(data.reviewAt === undefined ? {} : { reviewAt: planningDay(data.reviewAt, 'reviewAt') }),
    ...(data.resolves === undefined ? {} : { resolves: [...new Set(collection(data.resolves, 'resolves', row => planningId(row, 'resolves')))] }),
    ...(data.links === undefined ? {} : { links: decisionLinks(data.links) }),
    ...(data.pullRequest === undefined ? {} : { pullRequest: pullRequestReference(data.pullRequest) }),
  };
}

function planDraft(data: Record<string, unknown>): PlanDraft {
  const startAt = data.startAt === undefined ? undefined : planningDay(data.startAt, 'startAt');
  const dueAt = data.dueAt === undefined ? undefined : planningDay(data.dueAt, 'dueAt');
  if (startAt && dueAt && startAt > dueAt) invalid('dueAt', '计划结束日期不能早于开始日期');
  return {
    title: planningText(data.title, 'title', 120),
    ...(data.summary === undefined ? {} : { summary: planningText(data.summary, 'summary', 4000) }),
    ...(data.owner === undefined ? {} : { owner: planningText(data.owner, 'owner', 120) }),
    ...(data.decisionId === undefined ? {} : { decisionId: planningId(data.decisionId, 'decisionId') }),
    ...(startAt ? { startAt } : {}),
    ...(dueAt ? { dueAt } : {}),
  };
}

function proposalDecisionChange(value: unknown): ProposalDecisionChange {
  const data = object(value, '决策变更', ['decisionId', 'expectedVersion', 'change']);
  return {
    decisionId: planningId(data.decisionId, '原决策'), expectedVersion: version(data.expectedVersion, '原决策版本'),
    change: of(data.change, '决策变更方式', ['amended', 'accepted']),
  };
}

function proposal(kind: unknown, draft: unknown, decisionChange: unknown): ProposalDraft {
  const proposalKind = of(kind, 'kind', ['debt', 'decision', 'plan']);
  if (decisionChange !== undefined && proposalKind !== 'decision') invalid('决策变更', '请提交决策提案');
  switch (proposalKind) {
    case 'debt': return { kind: 'debt', draft: debtDraft(object(draft, 'draft', debtFields)) };
    case 'decision': return { kind: 'decision', draft: decisionDraft(object(draft, 'draft', decisionFields)),
      ...(decisionChange === undefined ? {} : { decisionChange: proposalDecisionChange(decisionChange) }) };
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
      fields('source', 'kind', 'draft', 'skill', 'confidence', 'decisionChange');
      return {
        type, requestId, source: source(value.source, true), ...proposal(value.kind, value.draft, value.decisionChange),
        ...(value.skill === undefined ? {} : { skill: planningText(value.skill, '技能名称', 80) }),
        ...(value.confidence === undefined ? {} : { confidence: proposalConfidence(value.confidence) }),
      };
    case 'proposal.accept': {
      fields('proposalId', 'as', 'debtId');
      const as = value.as === undefined ? undefined : of(value.as, '提案确认方式', ['hit', 'new']);
      if (value.debtId !== undefined && as !== 'hit') invalid('原债务', '请先选择记一次踩坑');
      return { type, requestId, proposalId: planningId(value.proposalId, 'proposalId'),
        ...(as === undefined ? {} : { as }),
        ...(value.debtId === undefined ? {} : { debtId: planningId(value.debtId, '原债务') }),
      };
    }
    case 'proposal.reject':
      fields('proposalId', 'reason');
      return { type, requestId, proposalId: planningId(value.proposalId, 'proposalId'), reason: reason() };
    case 'debt.create': {
      const draft = debtDraft(fields('source', 'distinction', 'assignToSelf', ...debtFields));
      if (value.assignToSelf !== undefined && typeof value.assignToSelf !== 'boolean') invalid('assignToSelf', '应为布尔值');
      const distinction = value.distinction === undefined ? undefined : object(value.distinction, 'distinction', ['debtIds', 'reason']);
      return { type, requestId, source: source(value.source), ...draft,
        ...(value.assignToSelf === undefined ? {} : { assignToSelf: value.assignToSelf }), ...(distinction ? { distinction: {
        debtIds: [...new Set(collection(distinction.debtIds, 'distinction.debtIds', row => planningId(row, '候选债务'), 6, 1))],
        reason: planningText(distinction.reason, 'distinction.reason', 2000),
      } } : {}) };
    }
    case 'debt.import':
      fields('items');
      return { type, requestId, items: collection(value.items, 'items', planningImportRow, 100, 1) };
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
    case 'debt.review': {
      const target = debt('next', 'reason', 'reviewAt');
      const next = of(value.next, 'next', ['start', 'defer', 'drop']);
      if (next !== 'defer' && value.reviewAt !== undefined) invalid('reviewAt', '仅继续暂缓需要下次回看日期');
      return { type, requestId, ...target, next, reason: reason(),
        ...(next === 'defer' ? { reviewAt: planningDay(value.reviewAt, 'reviewAt') } : {}) };
    }
    case 'debt.start':
    case 'debt.progress':
      return { type, requestId, ...debt('note', 'evidence'), note: note(),
        ...(value.evidence === undefined ? {} : { evidence: evidence(value.evidence) }) };
    case 'debt.hit':
      return { type, requestId, ...debt('note'), note: note() };
    case 'debt.verify': {
      const target = debt('method', 'note', 'evidence', 'validDays');
      const validDays = value.validDays === undefined ? 30 : planningVerificationPeriods.find(period => period === value.validDays);
      if (validDays === undefined) invalid('validDays', '请选择 14、30 或 60 天');
      return { type, requestId, ...target, validDays, note: note(), method: of(value.method, 'method', planningVerificationMethods),
        evidence: value.evidence === undefined ? [] : evidence(value.evidence) };
    }
    case 'debt.anchor': {
      const target = debt('anchor', 'reason');
      if (value.anchor === null) return { type, requestId, ...target, anchor: null, reason: reason() };
      const input = object(value.anchor, 'anchor', ['type', 'ref']);
      const ref = planningText(input.ref, 'anchor.ref', 500);
      if (/[\r\n\t]/u.test(ref)) invalid('anchor.ref', '请填写一行功能位置');
      return { type, requestId, ...target, reason: reason(),
        anchor: { type: of(input.type, 'anchor.type', planningAnchorTypes), ref } };
    }
    case 'debt.anchor-missing': {
      const target = debt('note', 'evidence');
      const proof = evidence(value.evidence, 1);
      if (!proof.some(item => item.type === 'change' && item.url)) invalid('evidence', '请附上能证明功能消失的变更链接');
      return { type, requestId, ...target, note: note(), evidence: proof };
    }
    case 'debt.anchor-confirm':
      return { type, requestId, ...debt('note'), ...(value.note === undefined ? {} : { note: note() }) };
    case 'debt.sweep':
      fields('branch');
      return { type, requestId, ...(value.branch === undefined ? {} : { branch: planningId(value.branch, 'branch') }) };
    case 'debt.repay':
      return { type, requestId, ...debt('summary', 'results', 'evidence', 'repaymentProofs', 'collateral'),
        summary: planningText(value.summary, 'summary', 6000), results: criterionResults(value.results),
        evidence: value.evidence === undefined ? [] : evidence(value.evidence),
        ...(value.repaymentProofs === undefined ? {} : { repaymentProofs: repaymentProofs(value.repaymentProofs) }),
        ...(value.collateral === undefined ? {} : { collateral: collection(value.collateral, 'collateral', row => {
          const item = object(row, 'collateral', ['debtId', 'expectedVersion']);
          return { debtId: planningId(item.debtId, 'collateral.debtId'), expectedVersion: version(item.expectedVersion) };
        }, 10) }),
      };
    case 'debt.reopen':
      return { type, requestId, ...debt('reason', 'evidence'), reason: reason(),
        ...(value.evidence === undefined ? {} : { evidence: evidence(value.evidence) }) };
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
    case 'debt.merge': {
      const target = debt('fromId', 'fromVersion', 'reason', 'takeFrom');
      return { type, requestId, ...target, fromId: planningId(value.fromId, 'fromId'), fromVersion: version(value.fromVersion, 'fromVersion'), reason: reason(),
        ...(value.takeFrom === undefined ? {} : { takeFrom: [...new Set(collection(value.takeFrom, 'takeFrom', row => of(row, 'takeFrom', ['title', 'summary', 'owner']), 3))] }) };
    }
    case 'debt.not-duplicate':
      return { type, requestId, ...debt('fromId', 'fromVersion', 'reason'), fromId: planningId(value.fromId, 'fromId'),
        fromVersion: version(value.fromVersion, 'fromVersion'), reason: reason() };
    case 'decision.create':
      return { type, requestId, source: source(value.source), ...decisionDraft(fields('source', ...decisionFields)) };
    case 'decision.change': {
      fields('decisionId', 'expectedVersion', 'change', 'reason', 'successorId', 'transfer', 'links', 'pullRequest', 'structure');
      const change = of(value.change, 'change', ['accepted', 'amended', 'reviewed', 'superseded', 'deprecated']);
      if (change !== 'superseded' && (value.successorId !== undefined || value.transfer !== undefined)) invalid('successorId', '只有取代决策可指定接替与转移');
      if (change !== 'amended' && (value.links !== undefined || value.pullRequest !== undefined || value.structure !== undefined)) {
        invalid('change', '请通过补充决策说明更新候选方案与关联链接');
      }
      if (value.transfer !== undefined && typeof value.transfer !== 'boolean') invalid('transfer', '应为布尔值');
      return {
        type, requestId, decisionId: planningId(value.decisionId, 'decisionId'), expectedVersion: version(value.expectedVersion),
        change, reason: reason(),
        ...(change === 'superseded' ? { successorId: planningId(value.successorId, 'successorId'), transfer: value.transfer !== false } : {}),
        ...(value.links === undefined ? {} : { links: decisionLinks(value.links) }),
        ...(value.pullRequest === undefined ? {} : { pullRequest: value.pullRequest === null ? null : pullRequestReference(value.pullRequest) }),
        ...(value.structure === undefined ? {} : { structure: decisionStructure(object(value.structure, 'structure', decisionStructureFields)) }),
      };
    }
    case 'plan.create':
      return { type, requestId, source: source(value.source), ...planDraft(fields('source', 'initialSteps', ...planFields)),
        ...(value.initialSteps === undefined ? {} : { initialSteps: collection(value.initialSteps, 'initialSteps', item => planningStepDraft(object(item, '步骤', stepFields)), 100) }) };
    case 'plan.add-step': {
      const target = plan(...stepFields);
      return { type, requestId, ...target, ...planningStepDraft(value) };
    }
    case 'plan.step':
      return { type, requestId, ...plan('stepId', 'status', 'note'), stepId: planningId(value.stepId, 'stepId'), status: of(value.status, 'status', ['todo', 'doing', 'done']), note: note() };
    default:
      return invalid('type', '不是支持的工程规划操作');
  }
}
