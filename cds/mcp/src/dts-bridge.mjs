import { z } from 'zod';
import { createProjectApiClient } from './bridge.mjs';
const id = z.string().trim().min(1).max(200);
const pair = { sourceId: id, targetId: id };
const schemas = {
  cds_dts_connections: z.object({}).strict(),
  cds_dts_plan: z.object({ ...pair, mode: z.enum(['append-only', 'account-authority']).default('append-only') }).strict(),
  cds_dts_start: z.object({ planId: id, idempotencyKey: z.string().min(1).max(120) }).strict(),
  cds_dts_runs: z.object({ runId: id.optional() }).strict(),
  cds_dts_control: z.object({ runId: id, action: z.enum(['pause', 'resume', 'cancel']) }).strict(),
  cds_dts_policies: z.object({ action: z.enum(['list', 'create', 'enable', 'disable']).default('list'), sourceId: id.optional(), targetId: id.optional(), policyId: id.optional() }).strict()
    .refine(a => a.action !== 'create' || (a.sourceId && a.targetId), { message: '创建账号规则需要源和目标连接' })
    .refine(a => !['enable', 'disable'].includes(a.action) || a.policyId, { message: '启停规则需要规则编号' }),
};
const descriptions = {
  cds_dts_connections: '列出当前项目管理员已批准的数据连接。不会返回数据库密码。',
  cds_dts_plan: '比较源和目标的容量、契约版本及记录差异。只追加跳过已有主键；账号校准仅更新已批准资料字段。不会执行写入。',
  cds_dts_start: '执行已比较的同步计划，必须提供稳定幂等编号。异步返回原任务；超时继续查询该任务，不能重新提交。',
  cds_dts_runs: '列出当前项目任务，或按 runId 核对原生任务和目标数据。completed 代表独立对账完成。',
  cds_dts_control: '暂停、取消或重新比较后续传。停止须确认后生效；已写入数据保留，不删除目标资料。',
  cds_dts_policies: '管理账号同步：新账号每 5 秒检查、已有账号每天上海时间 03 点按源校准白名单字段。不复制登录凭据或会话。',
};
export const DTS_TOOLS = Object.entries(schemas).map(([name, schema]) => ({ name, description: descriptions[name], inputSchema: z.toJSONSchema(schema, { unrepresentable: 'any' }), annotations: { readOnlyHint: ['cds_dts_connections', 'cds_dts_plan', 'cds_dts_runs'].includes(name), destructiveHint: false, openWorldHint: true } }));

export function createDtsBridge(credentials, options = {}) {
  const client = createProjectApiClient(credentials, options);
  const query = `?${new URLSearchParams({ projectId: credentials.projectId })}`;
  let allowed;
  const scope = resource => {
    if (!resource || resource.projectId !== credentials.projectId) throw new Error('CDS 数据同步返回了其他项目的资源');
    return resource;
  };
  const request = async (method, path, body) => client.request(method, `/api/dts${path}${query}`, body ? { ...body, projectId: credentials.projectId } : undefined);
  async function listTools() {
    allowed = undefined;
    const c = await request('GET', '/capabilities'); scope(c);
    if (c.protocolVersion !== 1 || !Array.isArray(c.tools) || new Set(c.tools).size !== c.tools.length
      || c.tools.some(name => !Object.hasOwn(schemas, name))) throw new Error('CDS 数据同步协议与当前 MCP 不兼容，请更新服务或桥接');
    allowed = new Set(c.tools); return DTS_TOOLS.filter(tool => allowed.has(tool.name));
  }
  return { listTools, close: () => client.close(), async call(name, input = {}) {
    if (!Object.hasOwn(schemas, name)) throw new Error('未知 CDS 数据同步工具');
    const a = schemas[name].parse(input);
    // Refresh admission instead of letting stale catalogs authorize a write.
    await listTools(); if (!allowed.has(name)) throw new Error('当前 CDS 未开放此同步操作');
    let result;
    if (name === 'cds_dts_connections') { result = await request('GET', '/connections'); result.connections.forEach(scope); (result.services ?? []).forEach(scope); }
    if (name === 'cds_dts_plan') { result = await request('POST', '/plans', a); scope(result.plan); }
    if (name === 'cds_dts_start') { result = await request('POST', '/runs', a); scope(result.run); if (result.run.plan.id !== a.planId) throw new Error('返回任务与比较计划不符'); }
    if (name === 'cds_dts_runs') {
      result = await request('GET', a.runId ? `/runs/${encodeURIComponent(a.runId)}` : '/runs');
      if (a.runId) { scope(result.run); if (result.run.id !== a.runId) throw new Error('返回任务编号与请求不符'); }
      else result.runs.forEach(scope);
    }
    if (name === 'cds_dts_control') {
      const original = await request('GET', `/runs/${encodeURIComponent(a.runId)}`); scope(original.run);
      if (original.run.id !== a.runId) throw new Error('返回任务编号与请求不符');
      result = await request('POST', `/runs/${encodeURIComponent(a.runId)}/${a.action}`, {}); scope(result.run);
    }
    if (name === 'cds_dts_policies') {
      if (a.action === 'list') { result = await request('GET', '/policies'); result.policies.forEach(scope); }
      else { result = a.action === 'create' ? await request('POST', '/policies', { sourceId: a.sourceId, targetId: a.targetId })
        : await request('PATCH', `/policies/${encodeURIComponent(a.policyId)}`, { enabled: a.action === 'enable' }); scope(result.policy); }
    }
    return result;
  } };
}
