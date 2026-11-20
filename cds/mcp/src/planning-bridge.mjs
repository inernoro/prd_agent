import { z } from 'zod';
import { createProjectApiClient } from './bridge.mjs';

const text = max => z.string().trim().min(1).max(max);
const id = text(160).regex(/^[\w.:@/+\-]+$/);
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const source = z.object({
  type: z.enum(['manual', 'review', 'test', 'incident', 'code', 'adr', 'import']),
  ref: text(300),
  url: text(2000).optional(),
}).strict();
const titleAndSummary = { title: text(120), summary: text(4000).optional() };
const debt = {
  ...titleAndSummary,
  module: text(80).optional(),
  whyDebt: text(4000).optional(),
  decisionId: id.optional(),
  priority: z.enum(['high', 'mid', 'low']).optional(),
  criteria: z.array(text(400)).max(32).optional(),
  impact: text(4000).optional(),
  owner: text(120).optional(),
  dueAt: day.optional(),
  trigger: text(4000).optional(),
  tags: z.array(text(80)).max(20).optional(),
  rootCause: z.object({ state: z.enum(['pending', 'suspected', 'confirmed']), text: text(4000).optional(), basis: text(4000).optional() }).strict().optional(),
};
const submit = { requestId: id, source };
const proposalSubmit = {
  ...submit, source: source.extend({ excerpt: text(1200).optional() }),
  skill: text(80).optional(), confidence: z.number().min(0).max(1).optional(),
};
const decisionLink = z.object({ type: z.enum(['doc', 'adr', 'issue']), title: text(200), url: text(2000) }).strict();
const pullRequest = z.object({
  url: text(2000), target: z.object({ label: text(160), path: text(2000) }).strict().optional(),
}).strict();
const decisionChange = z.object({
  decisionId: id, expectedVersion: z.number().int().min(1), change: z.enum(['amended', 'accepted']),
}).strict();
const decisionOption = z.object({ title: text(120), benefits: text(2000).optional(), drawbacks: text(2000).optional() }).strict();
const distinction = z.object({ debtIds: z.array(id).min(1).max(6), reason: text(2000) }).strict();
const schemas = {
  cds_planning_read: z.discriminatedUnion('view', [
    z.object({ view: z.literal('board') }).strict(),
    z.object({ view: z.literal('debts'), q: text(200).optional(), cursor: text(300).optional(), branch: id.optional(), module: text(80).optional(),
      status: z.enum(['unpaid', 'review_due', 'overdue', 'open', 'deferred', 'in_progress', 'repaid', 'dropped', 'all']).optional() }).strict(),
    z.object({ view: z.literal('debt'), debtId: id }).strict(),
    z.object({ view: z.literal('duplicates'), title: text(120) }).strict(),
    z.object({ view: z.literal('stats'), from: day.optional(), to: day.optional(), branch: id.optional() }).strict(),
  ]),
  cds_planning_propose: z.discriminatedUnion('kind', [
    z.object({ ...proposalSubmit, kind: z.literal('debt'), draft: z.object(debt).strict() }).strict(),
    z.object({ ...proposalSubmit, kind: z.literal('decision'), decisionChange: decisionChange.optional(), draft: z.object({
      ...titleAndSummary, rationale: text(6000).optional(), owner: text(120).optional(), reviewAt: day.optional(),
      decisionKind: z.enum(['forward', 'debt']).optional(), options: z.array(decisionOption).max(12).optional(),
      chosenOption: text(120).optional(), consequences: text(4000).optional(),
      resolves: z.array(id).max(32).optional(), links: z.array(decisionLink).max(16).optional(), pullRequest: pullRequest.optional(),
    }).strict() }).strict(),
    z.object({ ...proposalSubmit, kind: z.literal('plan'), draft: z.object({
      ...titleAndSummary, decisionId: id.optional(), owner: text(120).optional(), startAt: day.optional(), dueAt: day.optional(),
    }).strict() }).strict(),
  ]),
  cds_planning_record_debt: z.object({ ...submit, ...debt, distinction: distinction.optional() }).strict(),
};

const permissions = { cds_planning_read: 'read', cds_planning_propose: 'propose', cds_planning_record_debt: 'write' };
const descriptions = {
  cds_planning_read: '读当前 CDS 项目的推进、债务、证据与历史或演进。duplicates 视图按标题查找疑似重复。项目随已授权凭据确定。',
  cds_planning_propose: '根据用户要求或已确认的工程取舍提交债务、决策和计划草稿，可附上技能、把握度及触发来源。由项目成员确认入账。',
  cds_planning_record_debt: '用户明确要求登记这笔债务时使用。用户确认另记且给出区别时，提交已核对的候选编号和说明。返回正式债务编号。重试沿用原 requestId 与内容。',
};
export const PLANNING_TOOLS = Object.entries(schemas).map(([name, schema]) => ({
  name, description: descriptions[name], inputSchema: { ...z.toJSONSchema(schema, { unrepresentable: 'any' }), type: 'object' },
  annotations: { readOnlyHint: permissions[name] === 'read', destructiveHint: false, idempotentHint: true, openWorldHint: false },
}));

export function createPlanningBridge(credentials, options = {}) {
  const client = createProjectApiClient(credentials, options);
  const path = `/api/projects/${encodeURIComponent(credentials.projectId)}/planning`;
  const request = (method, endpoint, body) => client.request(method, path + endpoint, body);
  function scope(resource) {
    if (!resource || resource.projectId !== credentials.projectId) throw new Error('CDS 规划结果与当前项目不符');
    return resource;
  }
  async function listTools() {
    const result = scope(await request('GET', '/capabilities'));
    const allowed = result.permissions;
    if (result.protocolVersion !== 1 || !Array.isArray(allowed) || new Set(allowed).size !== allowed.length
      || allowed.some(permission => !['read', 'propose', 'write', 'approve'].includes(permission))) {
      throw new Error('CDS 工程规划协议与当前 MCP 不兼容，请更新服务或桥接');
    }
    return PLANNING_TOOLS.filter(tool => allowed.includes(permissions[tool.name]));
  }
  async function read(input) {
    if (input.view === 'board') {
      const value = scope(await request('GET', ''));
      for (const field of ['decisions', 'plans', 'proposals', 'events', 'pullRequests']) value[field]?.forEach(scope);
      value.decisions?.forEach(decision => decision.pullRequests?.forEach(scope));
      return value;
    }
    if (input.view === 'debt') {
      const value = scope(await request('GET', '/debts/' + encodeURIComponent(input.debtId)));
      scope(value.debt);
      if (value.debt.id !== input.debtId) throw new Error('CDS 返回的债务与请求编号不符');
      value.events?.forEach(scope);
      return value;
    }
    const { view, status, ...filters } = input;
    if (status) filters.view = status;
    const query = new URLSearchParams(Object.entries(filters).filter(([, value]) => value !== undefined)).toString();
    const value = scope(await request('GET', '/' + view + (query ? '?' + query : '')));
    if (view === 'debts') value.items.forEach(scope);
    return value;
  }
  return {
    listTools,
    close: () => client.close(),
    async call(name, input = {}) {
      if (!Object.hasOwn(schemas, name)) throw new Error('未知 CDS 工程规划工具');
      const parsed = schemas[name].safeParse(input);
      if (!parsed.success) throw new Error('工程规划参数无效，请检查工具契约');
      if (!(await listTools()).some(tool => tool.name === name)) throw new Error('当前项目未授权这个工程规划操作');
      if (name === 'cds_planning_read') return read(parsed.data);
      const type = name === 'cds_planning_propose' ? 'proposal.submit' : 'debt.create';
      let result;
      try { result = scope(await request('POST', '/commands', { type, ...parsed.data })); } catch (error) {
        if (error instanceof Error && /请求失败或超时|返回非 JSON/.test(error.message)) {
          throw new Error('CDS 未返回可确认的提交结果；检查连接后使用相同 requestId 和内容重试');
        }
        throw error;
      }
      scope(result.result);
      if (typeof result.result.id !== 'string' || !result.result.id || typeof result.reused !== 'boolean') {
        throw new Error('CDS 返回的工程规划回执不完整');
      }
      return result;
    },
  };
}
