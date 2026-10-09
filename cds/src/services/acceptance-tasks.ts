import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import type { StateService } from './state.js';
import type {
  AcceptanceCase, AcceptanceEnvironment, AcceptanceEvidence, AcceptanceReportSource,
  AcceptanceSubmission, AcceptanceSummary, AcceptanceTask, AcceptanceTemplate, StoredAcceptanceTask,
} from '../acceptance-types.js';

export class AcceptanceError extends Error {
  constructor(public readonly status: number, public readonly code: string, message: string) { super(message); }
}

function reject(code: string, message: string, status = 400): never { throw new AcceptanceError(status, code, message); }
function text(value: unknown, label: string, optional = false, max = 8_000): string {
  if (optional && (value === undefined || value === '')) return '';
  if (typeof value !== 'string' || !value.trim() || value.length > max) reject('invalid_input', `${label}不能为空或超过长度限制`);
  return value.trim();
}
function list(value: unknown, label: string, max = 200): unknown[] {
  if (!Array.isArray(value) || value.length > max) reject('invalid_input', `${label}须为列表且不能超过 ${max} 项`);
  return value;
}
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) reject('invalid_input', '请提交结构化对象');
  return value as Record<string, unknown>;
}
function unique(values: string[], label: string): void {
  if (new Set(values).size !== values.length) reject('duplicate_id', `${label}不得重复`);
}
function safeId(value: unknown, label: string): string {
  const id = text(value, label, false, 120);
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/.test(id) || ['__proto__', 'constructor', 'prototype'].includes(id)) reject('invalid_id', `${label}仅允许字母数字及 . _ : -`);
  return id;
}
function environment(value: unknown): AcceptanceEnvironment {
  if (value !== 'production' && value !== 'cds') reject('invalid_environment', '请选择正式环境或 CDS');
  return value;
}
function onlineUrl(value: unknown): string {
  const raw = text(value, '线上证据链接', false, 2_000);
  let url: URL;
  try { url = new URL(raw); } catch { return reject('invalid_evidence', '证据须为可访问的线上 HTTP(S) 链接'); }
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password
    || !host.includes('.') || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')
    || /^(127\.|10\.|0\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.)/.test(host)
    || host.includes(':')) reject('invalid_evidence', '证据不能使用本机、内网、文件路径或带凭据的链接');
  return url.href;
}

function parseCase(value: unknown): AcceptanceCase {
  const c = record(value);
  const envs = list(c.environments, '环境', 2).map(environment);
  if (!envs.length) reject('invalid_input', '每条用例至少指定一个环境');
  unique(envs, '环境');
  const steps = list(c.steps, '步骤').map((v) => { const s = record(v); return { id: safeId(s.id, '步骤编号'), action: text(s.action, '操作'), expected: text(s.expected, '步骤预期') }; });
  const assertions = list(c.assertions, '断言').map((v) => { const a = record(v); return { id: safeId(a.id, '断言编号'), description: text(a.description, '断言描述') }; });
  if (!steps.length || !assertions.length) reject('invalid_input', '用例至少需要一个操作步骤和业务断言');
  unique(steps.map((s) => s.id), '步骤编号'); unique(assertions.map((a) => a.id), '断言编号');
  if (c.criticality !== 'core' && c.criticality !== 'standard') reject('invalid_input', '重要性仅允许 core 或 standard');
  if (typeof c.evidenceRequired !== 'boolean') reject('invalid_input', '必须明确是否需要证据');
  if (c.cleanup !== 'required' && c.cleanup !== 'none') reject('invalid_input', '必须明确清理要求');
  const entryPath = text(c.entryPath, '业务入口', false, 2_000);
  if (!entryPath.startsWith('/') || entryPath.startsWith('//') || /[\r\n]/.test(entryPath)) reject('invalid_input', '业务入口须为项目内绝对路由');
  return {
    caseId: safeId(c.caseId, '用例编号'), title: text(c.title, '功能标题', false, 200), module: text(c.module, '模块', false, 100),
    criticality: c.criticality, environments: envs, breadcrumb: list(c.breadcrumb, '面包屑', 20).map((v) => text(v, '导航名称', false, 100)), entryPath,
    preconditions: list(c.preconditions, '前置条件').map((v) => text(v, '前置条件')),
    inputs: list(c.inputs, '输入').map((v) => { const i = record(v); return { name: text(i.name, '输入名称', false, 100), value: text(i.value, '输入值') }; }),
    steps, assertions, evidenceRequired: c.evidenceRequired, cleanup: c.cleanup,
    cleanupInstructions: text(c.cleanupInstructions, '清理步骤', c.cleanup === 'none'), owner: text(c.owner, '负责人', false, 200),
  };
}

function parseSubmission(value: unknown, c: AcceptanceCase): AcceptanceSubmission {
  const s = record(value);
  if (!['pass', 'fail', 'blocked', 'not-run'].includes(String(s.status))) reject('invalid_result', '结果仅允许 pass、fail、blocked、not-run');
  const assertions = list(s.assertions, '断言结果').map((v) => {
    const a = record(v);
    if (typeof a.passed !== 'boolean') reject('invalid_result', '断言必须填写 passed');
    return { id: safeId(a.id, '断言编号'), passed: a.passed, actual: text(a.actual, '断言实际结果') };
  });
  unique(assertions.map((a) => a.id), '断言编号');
  if (assertions.some((a) => !c.assertions.some((expected) => expected.id === a.id))) reject('invalid_result', '不能回填模板未声明的断言');
  const evidence: AcceptanceEvidence[] = list(s.evidence, '证据', 30).map((v) => {
    const e = record(v);
    if (e.kind !== 'image' && e.kind !== 'artifact' && e.kind !== 'trace') reject('invalid_evidence', '证据类型仅允许 image、artifact、trace');
    return { kind: e.kind, url: onlineUrl(e.url), caption: text(e.caption, '证据说明', false, 1_000) };
  });
  const cleanup = record(s.cleanup);
  if (cleanup.status !== 'pass' && cleanup.status !== 'fail' && cleanup.status !== 'not-required') reject('invalid_cleanup', '清理结果无效');
  const result: AcceptanceSubmission = {
    submissionId: safeId(s.submissionId, '提交编号'), status: s.status as AcceptanceSubmission['status'], actual: text(s.actual, '实际结果或未执行原因'),
    assertions, evidence, cleanup: { status: cleanup.status, details: text(cleanup.details, '清理说明', cleanup.status === 'not-required') },
  };
  if (result.status === 'pass' && (assertions.length !== c.assertions.length || assertions.some((a) => !a.passed)
    || (c.evidenceRequired && !evidence.length) || (c.cleanup === 'required' && cleanup.status !== 'pass') || cleanup.status === 'fail')) {
    reject('incomplete_pass', '不能判通过：所有业务断言、线上证据和清理回读必须满足模板');
  }
  return result;
}

export function acceptanceSummary(cases: AcceptanceCase[], results: AcceptanceTask['results']): AcceptanceSummary {
  const summary: AcceptanceSummary = { planned: cases.length, executed: 0, pass: 0, fail: 0, blocked: 0, notRun: 0, flaky: 0, gate: 'fail' };
  for (const c of cases) {
    const result = results[c.caseId];
    if (!result || result.status === 'not-run') summary.notRun++;
    else if (result.status === 'blocked') summary.blocked++;
    else { summary.executed++; summary[result.status]++; }
    if (result?.flaky) summary.flaky++;
  }
  if (summary.planned > 0 && summary.pass === summary.planned && !summary.flaky) summary.gate = 'pass';
  return summary;
}

interface Slice { templates: AcceptanceTemplate[]; tasks: StoredAcceptanceTask[] }
interface Authority { queue: Promise<unknown>; committed: Slice; persistenceError: boolean; lastReconcileAt?: string; lastReconcileOk?: boolean; reaperStartedAt?: string; reconcileStaleMs?: number }
const authorities = new WeakMap<StateService, Authority>();

/** 单 CDS 权威进程的互斥队列；不是跨进程/多副本分布式锁。 */
export class AcceptanceTaskService {
  private readonly authority: Authority;
  private readonly now: () => Date;
  private readonly leaseMs: number;
  constructor(private readonly state: StateService, options: { now?: () => Date; leaseMs?: number } = {}) {
    this.now = options.now ?? (() => new Date()); this.leaseMs = options.leaseMs ?? 5 * 60_000;
    let authority = authorities.get(state);
    if (!authority) {
      authority = { queue: Promise.resolve(), committed: structuredClone({ templates: state.getState().acceptanceTemplates ?? [], tasks: state.getState().acceptanceTasks ?? [] }), persistenceError: false };
      authorities.set(state, authority);
    }
    this.authority = authority;
  }
  private async mutate<T>(fn: (slice: Slice) => T | Promise<T>): Promise<T> {
    const work = this.authority.queue.then(async () => {
      const slice = structuredClone(this.authority.committed);
      const result = await fn(slice);
      if (!this.authority.persistenceError && JSON.stringify(slice) === JSON.stringify(this.authority.committed)) return structuredClone(result);
      if (Buffer.byteLength(JSON.stringify(slice)) > 4 * 1024 * 1024) reject('acceptance_capacity', '验收记录达到当前持久层容量，请由管理员扩容；历史不会自动删除', 503);
      try { await this.state.persistAcceptanceState(slice.templates, slice.tasks); this.authority.persistenceError = false; }
      catch { this.authority.persistenceError = true; reject('acceptance_storage', '验收状态未可靠保存，请恢复持久层后重试；本次未返回领取票据', 503); }
      this.authority.committed = slice;
      return structuredClone(result);
    });
    this.authority.queue = work.catch(() => {});
    return work;
  }
  private task(slice: Slice, id: string): StoredAcceptanceTask {
    const t = slice.tasks.find((t) => t.id === id);
    if (!t) reject('task_not_found', '验收任务不存在', 404);
    return t;
  }
  private publicTask(t: StoredAcceptanceTask): AcceptanceTask {
    const { leaseTokenHash: _hash, leaseGeneration: _generation, ...task } = structuredClone(t);
    return task;
  }
  private requireLease(t: StoredAcceptanceTask, token: unknown): void {
    if (t.status !== 'running') reject('task_not_running', '任务未执行或已冻结，不能继续回填', 409);
    const supplied = typeof token === 'string' ? createHash('sha256').update(token).digest('hex') : '';
    if (!t.lease || !t.leaseTokenHash || this.now().getTime() >= Date.parse(t.lease.expiresAt)
      || supplied.length !== t.leaseTokenHash.length || !timingSafeEqual(Buffer.from(supplied), Buffer.from(t.leaseTokenHash))) {
      reject('lease_invalid', '领取租约已失效，请重新领取；旧执行者不能覆盖新结果', 409);
    }
  }
  listTemplates(projectId: string): AcceptanceTemplate[] { return structuredClone(this.authority.committed.templates.filter((t) => t.projectId === projectId)); }
  getTemplate(id: string, version?: number): AcceptanceTemplate {
    const revisions = this.authority.committed.templates.filter((t) => t.id === id && (version === undefined || t.version === version));
    const t = revisions.sort((a, b) => b.version - a.version)[0];
    if (!t) reject('template_not_found', '测试清单不存在或版本无效', 404);
    return structuredClone(t);
  }
  listTasks(projectId: string): AcceptanceTask[] { return this.authority.committed.tasks.filter((t) => t.projectId === projectId).map((t) => this.publicTask(t)); }
  getTask(id: string): AcceptanceTask { return this.publicTask(this.task(this.authority.committed, id)); }
  async publishTemplate(value: unknown): Promise<AcceptanceTemplate> {
    const input = record(value), projectId = text(input.projectId, '项目', false, 120);
    if (!this.state.getProject(projectId)) reject('project_not_found', '项目不存在', 404);
    const cases = list(input.cases, '用例').map(parseCase);
    if (!cases.length) reject('invalid_input', '测试清单不能为空');
    unique(cases.map((c) => c.caseId), '用例编号');
    return this.mutate((slice) => {
      let id = `atpl_${randomUUID()}`, version = 1;
      if (input.templateId !== undefined) {
        id = safeId(input.templateId, '模板编号');
        const latest = slice.templates.filter((t) => t.id === id).sort((a, b) => b.version - a.version)[0];
        if (!latest || latest.projectId !== projectId) reject('template_not_found', '该项目内没有此模板', 404);
        if (input.expectedVersion !== latest.version) reject('version_conflict', '模板已有新版本，请重新读取后发布', 409);
        version = latest.version + 1;
      }
      const template: AcceptanceTemplate = { id, projectId, title: text(input.title, '清单名称', false, 200), description: text(input.description, '清单说明', true), version, cases, createdAt: this.now().toISOString() };
      slice.templates.push(template); return template;
    });
  }
  async createTask(value: unknown): Promise<AcceptanceTask> {
    const input = record(value), projectId = text(input.projectId, '项目', false, 120), env = environment(input.environment);
    if (!this.state.getProject(projectId)) reject('project_not_found', '项目不存在', 404);
    return this.mutate((slice) => {
      const template = slice.templates.filter((t) => t.id === input.templateId && t.projectId === projectId && (input.templateVersion === undefined || t.version === input.templateVersion)).sort((a, b) => b.version - a.version)[0];
      if (!template) reject('template_not_found', '该项目的测试清单或版本不存在', 404);
      const ids = input.caseIds === undefined ? undefined : list(input.caseIds, '执行用例').map((v) => safeId(v, '用例编号'));
      if (ids) unique(ids, '用例编号');
      const cases = template.cases.filter((c) => c.environments.includes(env) && (!ids || ids.includes(c.caseId)));
      if (!cases.length || (ids && cases.length !== ids.length)) reject('invalid_scope', '执行范围为空或包含不适用当前环境的用例');
      const now = this.now().toISOString();
      const task: StoredAcceptanceTask = {
        id: `atask_${randomUUID()}`, projectId, templateId: template.id, templateVersion: template.version,
        title: text(input.title, '任务名称', true, 200) || template.title, environment: env,
        ...(input.observedVersion ? { observedVersion: text(input.observedVersion, '实际观察版本', false, 200) } : {}),
        templateSnapshot: structuredClone(template), cases: structuredClone(cases), results: {}, status: 'pending', leaseGeneration: 0,
        summary: acceptanceSummary(cases, {}), createdAt: now, updatedAt: now,
      };
      slice.tasks.push(task); return this.publicTask(task);
    });
  }
  async claim(id: string, agentName: unknown): Promise<{ task: AcceptanceTask; leaseToken: string }> {
    const agent = text(agentName, '执行智能体', false, 200);
    return this.mutate((slice) => {
      const t = this.task(slice, id);
      if (t.status === 'completed' || t.status === 'cancelled') reject('task_frozen', '任务已结束，不能领取', 409);
      if (t.lease && Date.parse(t.lease.expiresAt) > this.now().getTime()) reject('task_claimed', '其他智能体仍在执行，请等待租约释放', 409);
      const token = randomBytes(32).toString('base64url');
      t.leaseGeneration++;
      t.lease = { agentName: agent, expiresAt: new Date(this.now().getTime() + this.leaseMs).toISOString(), generation: t.leaseGeneration };
      t.leaseTokenHash = createHash('sha256').update(token).digest('hex');
      t.status = 'running'; t.updatedAt = this.now().toISOString();
      return { task: this.publicTask(t), leaseToken: token };
    });
  }
  async heartbeat(id: string, token: unknown): Promise<AcceptanceTask> {
    return this.mutate((slice) => { const t = this.task(slice, id); this.requireLease(t, token); t.lease!.expiresAt = new Date(this.now().getTime() + this.leaseMs).toISOString(); t.updatedAt = this.now().toISOString(); return this.publicTask(t); });
  }
  async release(id: string, token: unknown): Promise<AcceptanceTask> {
    return this.mutate((slice) => { const t = this.task(slice, id); this.requireLease(t, token); delete t.lease; delete t.leaseTokenHash; t.status = 'pending'; t.updatedAt = this.now().toISOString(); return this.publicTask(t); });
  }
  async submit(id: string, caseId: string, token: unknown, value: unknown): Promise<AcceptanceTask> {
    return this.mutate((slice) => {
      const t = this.task(slice, id); this.requireLease(t, token);
      const c = t.cases.find((c) => c.caseId === caseId);
      if (!c) reject('case_not_found', '用例不在本任务执行范围', 404);
      const submission = parseSubmission(value, c), previous = t.results[caseId];
      const existing = Object.values(t.results).flatMap((r) => r.attempts.map((attempt) => ({ caseId: r.caseId, attempt }))).find((r) => r.attempt.submissionId === submission.submissionId);
      if (existing) {
        const { submittedAt: _time, ...original } = existing.attempt;
        if (existing.caseId !== caseId || JSON.stringify(original) !== JSON.stringify(submission)) reject('submission_conflict', '此提交编号已用于不同结果，请勿覆盖历史', 409);
        return this.publicTask(t);
      }
      if (previous && (previous.attempts.length >= 2 || previous.status === 'pass')) reject('retry_exhausted', '每条失败最多重试一次，通过结果不能改写', 409);
      const attempt = { ...submission, submittedAt: this.now().toISOString() }, attempts = [...(previous?.attempts ?? []), attempt];
      t.results[caseId] = { ...attempt, caseId, attempts, flaky: attempts.length === 2 && attempt.status === 'pass' };
      t.summary = acceptanceSummary(t.cases, t.results); t.updatedAt = this.now().toISOString();
      return this.publicTask(t);
    });
  }
  async complete(id: string, token: unknown): Promise<AcceptanceTask> {
    return this.mutate((slice) => { const t = this.task(slice, id); this.requireLease(t, token); t.summary = acceptanceSummary(t.cases, t.results); t.status = 'completed'; t.completedAt = this.now().toISOString(); t.updatedAt = t.completedAt; delete t.lease; delete t.leaseTokenHash; return this.publicTask(t); });
  }
  async cancel(id: string, token?: unknown): Promise<AcceptanceTask> {
    return this.mutate((slice) => {
      const t = this.task(slice, id);
      if (t.status === 'completed') reject('task_frozen', '已完成任务不可取消', 409);
      if (t.status === 'running') this.requireLease(t, token);
      t.status = 'cancelled'; t.updatedAt = this.now().toISOString(); delete t.lease; delete t.leaseTokenHash;
      return this.publicTask(t);
    });
  }
  async reconcileExpiredLeases(): Promise<number> {
    try {
      const count = await this.mutate((slice) => {
        let count = 0;
        for (const t of slice.tasks) if (t.status === 'running' && t.lease && Date.parse(t.lease.expiresAt) <= this.now().getTime()) {
          delete t.lease; delete t.leaseTokenHash; t.status = 'pending'; t.updatedAt = this.now().toISOString(); count++;
        }
        return count;
      });
      this.authority.lastReconcileOk = true; this.authority.lastReconcileAt = this.now().toISOString(); return count;
    } catch (error) { this.authority.lastReconcileOk = false; this.authority.lastReconcileAt = this.now().toISOString(); throw error; }
  }
  setReaperActive(active: boolean, intervalMs = 30_000): void {
    this.authority.reaperStartedAt = active ? this.now().toISOString() : undefined;
    this.authority.reconcileStaleMs = intervalMs * 3;
  }
  health(projectId?: string) {
    const expiredLeases = this.authority.committed.tasks.filter((t) => (!projectId || t.projectId === projectId) && t.lease && Date.parse(t.lease.expiresAt) <= this.now().getTime()).length;
    const last = this.authority.lastReconcileAt ?? this.authority.reaperStartedAt;
    const reconcileStale = Boolean(this.authority.reaperStartedAt && last && this.now().getTime() - Date.parse(last) > this.authority.reconcileStaleMs!);
    return { ok: !this.authority.persistenceError && this.authority.lastReconcileOk !== false && !reconcileStale, authority: 'single-process', persistenceOk: !this.authority.persistenceError, reaperRunning: Boolean(this.authority.reaperStartedAt), reconcileStale, lastReconcileAt: this.authority.lastReconcileAt, lastReconcileOk: this.authority.lastReconcileOk, expiredLeases };
  }
  matrix(projectId: string, templateId?: string, env?: AcceptanceEnvironment) {
    const tasks = this.listTasks(projectId).filter((t) => (!templateId || t.templateId === templateId) && (!env || t.environment === env)).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    const caseMap = new Map<string, { templateId: string; testcase: AcceptanceCase }>();
    for (const t of tasks) for (const c of t.cases) caseMap.set(JSON.stringify([t.templateId, c.caseId]), { templateId: t.templateId, testcase: c });
    return {
      tasks: tasks.map(({ id, title, environment, summary, createdAt, report, templateVersion, status }) => ({ id, title, environment, summary, createdAt, report, templateVersion, status })),
      rows: [...caseMap.values()].map(({ templateId, testcase: c }) => ({
        templateId, caseId: c.caseId, title: c.title, module: c.module, criticality: c.criticality,
        cells: tasks.map((t) => {
          const applicable = t.templateId === templateId && t.cases.some((entry) => entry.caseId === c.caseId);
          const result = applicable ? t.results[c.caseId] : undefined;
          return { taskId: t.id, status: result?.status ?? 'not-run', flaky: result?.flaky ?? false, evidence: result?.evidence ?? [], applicable };
        }),
      })),
    };
  }
  reportSource(id: string): AcceptanceReportSource {
    const task = this.getTask(id);
    if (task.status !== 'completed') reject('task_incomplete', '请先结束逐项验收，再生成报告', 409);
    const escape = (value: string) => value.replace(/[\\`*_{}\[\]<>#|]/g, '\\$&').replace(/[\r\n]+/g, ' ');
    const s = task.summary, verdict = s.fail ? 'fail' : s.blocked || s.notRun || s.flaky ? 'conditional' : 'pass';
    const evidence = task.cases.flatMap((c) => task.results[c.caseId]?.attempts.flatMap((a) => a.evidence) ?? []);
    const defectCounts = { p0: 0, p1: 0 };
    for (const c of task.cases) if (task.results[c.caseId]?.status === 'fail') defectCounts[c.criticality === 'core' ? 'p0' : 'p1']++;
    const title = `功能验收 · ${task.title} / ${task.environment} · ${task.completedAt!.slice(0, 10)}`;
    const lines = [
      `# ${escape(title)}`, '', '## 老板决策卡', '',
      `任务：${task.id}；清单：${task.templateId}；模板版本：${task.templateVersion}；环境：${task.environment}。`,
      `观察到的部署版本：${escape(task.observedVersion ?? '未记录；正式环境按当前线上执行，不要求特定分支或发布')}。`,
      `计划 ${s.planned}，执行 ${s.executed}，通过 ${s.pass}，失败 ${s.fail}，阻塞 ${s.blocked}，未执行 ${s.notRun}，不稳定 ${s.flaky}。`,
      `业务结论：${s.gate}。报告交付：pending，尚未完成线上归档与 verify-open；不得据此宣称允许发布。`, '',
      '## 验收结果矩阵', '', '以下评分表与执行明细使用同一编号、同一功能和同一标准。明细只展开本行，不是另一份清单。', '',
      '| 编号 | 重要功能 | 怎么验 | 通过标准 | 结果 | 证据 | 不稳定 | 清理 |', '|---|---|---|---|---|---|---|---|',
      ...task.cases.map((c) => {
        const r = task.results[c.caseId];
        const proof = r?.evidence.map((e) => `[${escape(e.caption)}](<${e.url}>)`).join('；') || '未提供';
        const method = `${escape(c.steps[0]?.action ?? '')}${c.steps.length > 1 ? `（另 ${c.steps.length - 1} 步，见同编号明细）` : ''}`;
        const standard = `${escape(c.assertions[0]?.description ?? '')}${c.assertions.length > 1 ? `（另 ${c.assertions.length - 1} 项标准，见同编号明细）` : ''}`;
        return `| ${c.caseId} | ${escape(c.title)} | ${method} | ${standard} | ${r?.status ?? 'not-run'} | ${proof} | ${r?.flaky ? '是' : '否'} | ${r?.cleanup.status ?? '未回填'} |`;
      }),
      '', '## 逐项执行与证据', '',
    ];
    for (const c of task.cases) {
      const result = task.results[c.caseId];
      lines.push(`### ${c.caseId} ${escape(c.title)}`, '', `模块：${escape(c.module)}；负责人：${escape(c.owner)}；面包屑：${c.breadcrumb.map(escape).join(' → ')}；业务路径：${escape(c.entryPath)}。`,
        `前置条件：${c.preconditions.map(escape).join('；') || '无'}。`, `输入：${c.inputs.map((i) => `${escape(i.name)}=${escape(i.value)}`).join('；') || '无'}。`,
        ...c.steps.map((step, i) => `${i + 1}. ${escape(step.action)}；预期：${escape(step.expected)}`), '',
        `当前结果：${result?.status ?? 'not-run'}；实际：${escape(result?.actual ?? '执行者未回填，不能认为功能通过')}。`,
        `清理要求：${escape(c.cleanupInstructions || '无需清理')}；回读：${escape(result?.cleanup.details ?? '未回填')}。`,
        ...c.assertions.map((assertion) => { const actual = result?.assertions.find((a) => a.id === assertion.id); return `- 断言 ${assertion.id}：${escape(assertion.description)}；${actual ? `${actual.passed ? 'pass' : 'fail'} / ${escape(actual.actual)}` : '未回填'}`; }), '',
      );
      for (const [index, attempt] of (result?.attempts ?? []).entries()) {
        lines.push(`尝试 ${index + 1}：${attempt.status}；${attempt.submittedAt}；${escape(attempt.actual)}。`,
          ...attempt.evidence.map((e) => `- [${escape(e.caption)}](${e.url})（${e.kind}）`));
      }
      if (c.evidenceRequired && !result?.evidence.length) lines.push('验收债务：本项没有线上证据，不得用入口可打开代替业务通过。');
      lines.push('');
    }
    lines.push('## 放行条件与下一步', '', '必测项全部有真实业务断言、符合模板的线上证据和清理回读，且没有失败、阻塞、未执行或不稳定；报告另需走既有归档准入与线上 verify-open。',
      '失败项按原 caseId 定向复验；根因未经诊断时为未知。本报告不自动发布，不授权超出测试身份与资源范围的操作。', '');
    return { title, format: 'md', content: lines.join('\n'), sourceId: task.id, verdict, defectCounts, evidence, verification: 'pending' };
  }
  async bindReport(id: string, reportId: unknown): Promise<AcceptanceTask> {
    const rid = text(reportId, '报告编号', false, 120);
    return this.mutate(async (slice) => {
      const t = this.task(slice, id);
      if (t.status !== 'completed') reject('task_incomplete', '任务未完成，不能关联报告', 409);
      if (t.report) { if (t.report.id !== rid) reject('report_conflict', '已绑定不可变报告，不能替换为另一份', 409); return this.publicTask(t); }
      const report = this.state.getAcceptanceReport(rid), source = this.reportSource(id);
      if (!report || report.projectId !== t.projectId || report.sourceId !== t.id) reject('report_mismatch', '报告须属于同项目、同验收任务', 409);
      if (report.storage !== 'object' || !report.objectKey) reject('report_not_durable', '报告未进入线上持久存储，请恢复对象存储后重新归档', 409);
      if (report.format !== 'md' || report.title !== source.title || report.verdict !== source.verdict
        || report.defectCounts?.p0 !== source.defectCounts.p0 || report.defectCounts?.p1 !== source.defectCounts.p1
        || await this.state.readAcceptanceReportContentAsync(rid) !== source.content) reject('report_mismatch', '报告正文或业务结论与冻结执行结果不一致', 409);
      t.report = { id: rid, url: `/reports?report=${encodeURIComponent(rid)}`, verification: 'pending' };
      return this.publicTask(t);
    });
  }
}

export function startAcceptanceLeaseReaper(service: AcceptanceTaskService, options: { intervalMs?: number; log?: (message: string) => void } = {}) {
  let busy = false;
  service.setReaperActive(true, options.intervalMs ?? 30_000);
  const reapNow = async () => {
    if (busy) return;
    busy = true;
    try { await service.reconcileExpiredLeases(); }
    catch { (options.log ?? console.warn)('[acceptance] 租约收敛失败，请恢复验收持久层；任务未可靠完成'); }
    finally { busy = false; }
  };
  void reapNow();
  const timer = setInterval(() => { void reapNow(); }, options.intervalMs ?? 30_000);
  timer.unref();
  return { reapNow, stop: () => { clearInterval(timer); service.setReaperActive(false); } };
}
