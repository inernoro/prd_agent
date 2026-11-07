import { afterEach, describe, expect, it } from 'vitest';
import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';
import { createHash } from 'node:crypto';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { StateService } from '../../src/services/state.js';
import { flushAllJsonStateStores } from '../../src/infra/state-store/json-backing-store.js';
import { createProjectInspectionsRouter } from '../../src/routes/project-inspections.js';
import { parseProjectInspection, inspectionHealthDocument } from '../../src/services/project-inspections.js';
import * as inspectionService from '../../src/services/project-inspections.js';
import { discoverMonitors } from '../../src/services/monitor-discovery.js';
import { reconcileDiscoveredMonitors } from '../../src/services/monitor-reconcile.js';
import { classifyAlert } from '../../src/services/alarm-route.js';
import { createScheduledJobsRouter } from '../../src/routes/scheduled-jobs.js';
import { createProjectsRouter } from '../../src/routes/projects.js';
import { MockShellExecutor } from '../../src/services/shell-executor.js';
import type { Project } from '../../src/types.js';
import { checkPurpose, inspectionState, inspectionCheckState, inspectionCheckLabel, projectChannels } from '../../web/src/lib/projectStatus.js';

const now = Date.parse('2026-11-05T14:00:00Z');
const input = () => ({ name: '模型全量实测', executor: '外部巡检执行器', enabled: true, intervalSeconds: 172800, lastCompletedAt: '2026-11-05T14:00:00Z', runKind: 'manual', checks: [{ id: 'image-a', name: '生图甲', purpose: '确认可生成图片', outcome: 'pass', checkedAt: '2026-11-05T14:00:00Z', result: '图片已解码', evidenceUrl: '/reports?project=a&report=one' }], notification: { channel: 'MAP 站内通知', recipient: '巡检接收人', policy: '仅异常和恢复时通知', outcome: 'not-triggered' } });
const servers: Array<ReturnType<express.Express['listen']>> = [];
afterEach(() => { for (const server of servers.splice(0)) server.close(); });

describe('项目通用摘要不包含巡检私密详情', () => {
  it.each([
    { label: '仅创建项目的全局凭据', projects: [] as string[], allowed: false },
    { label: '其他项目全局凭据', projects: ['b'], allowed: false },
    { label: '本项目全局凭据', projects: ['a'], allowed: true },
    { label: '全项目全局凭据', projects: 'all' as const, allowed: true },
    { label: '本项目凭据', scope: 'a', allowed: true },
    { label: '所有者会话', owner: true, allowed: true },
  ])('$label只在获准的专用入口读取完整巡检', async persona => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-inspection-summary-'));
    const state = new StateService(path.join(dir, 'state.json'), dir);
    state.load();
    for (const id of ['a', 'b']) state.addProject({
      id, slug: id, name: `项目${id}`, kind: 'git', createdAt: new Date(now).toISOString(),
      updatedAt: new Date(now).toISOString(),
      monitoringInspections: [parseProjectInspection('models', input(), `project:${id}`, now)],
    });
    const before = JSON.stringify(state.getProjects()), shell = new MockShellExecutor();
    const app = express();
    app.use((req, _res, next) => {
      const context = req as unknown as { cdsAccess?: unknown; cdsProjectKey?: unknown; cdsUser?: unknown; cdsSession?: unknown };
      if ('projects' in persona) context.cdsAccess = { keyId: 'owned-test-global', access: { canCreateProjects: true, projects: persona.projects } };
      if ('scope' in persona) context.cdsProjectKey = { projectId: persona.scope, keyId: 'owned-test-project' };
      if ('owner' in persona) { context.cdsUser = { id: 'owner', isSystemOwner: true, authProvider: 'local' }; context.cdsSession = {}; }
      next();
    });
    app.use('/api', createProjectInspectionsRouter({ getProject: id => state.getProject(id), save: () => { throw new Error('只读请求不得写入'); } }));
    app.use('/api', createProjectsRouter({ stateService: state, shell }));
    const server = app.listen(0), port = (server.address() as { port: number }).port;
    const get = async (route: string) => {
      const response = await fetch(`http://127.0.0.1:${port}/api${route}`);
      return { status: response.status, data: await response.json() };
    };
    try {
      const list = await get('/projects');
      expect(list.status).toBe(200);
      expect(list.data.projects.map((p: Project) => p.id).sort()).toEqual('scope' in persona ? ['a'] : ['a', 'b']);
      for (const project of list.data.projects) expect(project).not.toHaveProperty('monitoringInspections');
      expect(JSON.stringify(list.data)).not.toMatch(/巡检接收人|reports\?project=a|图片已解码/);
      const detail = await get('/projects/a');
      expect(detail.status).toBe(persona.allowed ? 200 : 403);
      expect(JSON.stringify(detail.data)).not.toMatch(/monitoringInspections|巡检接收人|reports\?project=a|图片已解码/);
      const inspections = await get('/projects/a/inspection-checks');
      expect(inspections.status).toBe(persona.allowed ? 200 : 403);
      if (persona.allowed) expect(inspections.data.inspections).toEqual(state.getProject('a')!.monitoringInspections);
      else expect(JSON.stringify(inspections.data)).not.toMatch(/巡检接收人|reports\?project=a|图片已解码/);
      expect(JSON.stringify(state.getProjects())).toBe(before);
      expect(shell.commands).toEqual([]);
    } finally {
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      await flushAllJsonStateStores();
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });
});

describe('项目总览实际通知分类与调度请求', () => {
  it.each([
    { source: 'release' as const, event: 'business-down', covered: false },
    { source: 'release' as const, event: 'infra-down', covered: true },
    { source: 'custom' as const, event: 'business-down', covered: true },
    { source: 'custom' as const, event: 'infra-down', covered: false },
  ])('真实检查区块的$source来源和$event订阅与投递分类一致', ({ source, event, covered }) => {
    expect(event === classifyAlert('uptime.target.down', source)).toBe(covered);
    const page = path.resolve('web/src/pages/ProjectStatusPage.tsx');
    const text = fs.readFileSync(page, 'utf8'), block = text.match(/<section id="checks"[\s\S]*?<\/section>/)?.[0];
    expect(block).toBeTruthy();
    const file = ts.createSourceFile(page, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const classification = file.statements.find(node => ts.isImportDeclaration(node)
      && node.importClause?.namedBindings?.getText(file).includes('classifyAlert')) as ts.ImportDeclaration | undefined;
    let actualPageClassifier: unknown;
    if (classification) {
      const specifier = (classification.moduleSpecifier as ts.StringLiteral).text;
      const sharedPath = path.resolve(path.dirname(page), specifier.replace(/\.js$/, '') + '.ts');
      expect(sharedPath).toBe(path.resolve('src/shared/alarm-classification.ts'));
      const shared = { exports: {} as { classifyAlert?: unknown } };
      vm.runInNewContext(ts.transpileModule(fs.readFileSync(sharedPath, 'utf8'), {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
      }).outputText, shared);
      actualPageClassifier = shared.exports.classifyAlert;
    }
    const target = { id: 'release-a', source, name: '正式入口', environmentLabel: '正式环境', intervalSeconds: 60 };
    const context = { createElement, classifyAlert: actualPageClassifier, rows: [target], checks: [target],
      liveChannels: [{ events: [event] }], channels: [], data: { summary: {} }, now,
      onlyIssues: false, query: '', setOnlyIssues: () => {}, setQuery: () => {},
      homeState: () => 'up', checkTitle: () => '入口检查', checkPurpose: () => '确认入口可用', frequency: () => '每分钟',
      timestamp: String, detailUrl: (id: string) => `/status?target=${id}`,
      HomeStateBadge: () => createElement('span', null, '正常'),
      Button: (props: { children: unknown }) => createElement('button', null, props.children as never),
      Link: (props: { to: string; children: unknown }) => createElement('a', { href: props.to }, props.children as never), result: null };
    vm.runInNewContext(ts.transpileModule(`result = (${block});`, {
      compilerOptions: { jsx: ts.JsxEmit.React, jsxFactory: 'createElement' },
    }).outputText, context);
    const rendered = renderToStaticMarkup(context.result);
    expect(rendered.includes('异常时按下方规则通知')).toBe(covered);
    expect(rendered.includes('未发现已验证的异常通知通道')).toBe(!covered);
  });

  it.each(['a', '项目 &/x'])('真实页面调度请求通过实际HTTP路由只返回项目%s', async projectId => {
    const source = fs.readFileSync(path.resolve('web/src/pages/ProjectStatusPage.tsx'), 'utf8');
    const file = ts.createSourceFile('ProjectStatusPage.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const expressions: string[] = [];
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node) && node.expression.getText(file) === 'apiRequest'
        && node.arguments[0]?.getText(file).includes('/api/scheduled-jobs?')) expressions.push(node.arguments[0].getText(file));
      ts.forEachChild(node, visit);
    };
    visit(file); expect(expressions).toHaveLength(1);
    const page = { project: { id: projectId }, encodeURIComponent, url: '' };
    vm.runInNewContext(ts.transpileModule(`url = (${expressions[0]});`, {}).outputText, page);
    const allJobs = [{ id: 'mine', projectId, name: '本项目计划', enabled: false },
      { id: 'other', projectId: 'other-project', name: '其他项目计划', enabled: false }];
    let receivedScope: string | undefined;
    const app = express();
    app.use('/api', createScheduledJobsRouter({ stateService: { listScheduledJobs: (id?: string) => {
      receivedScope = id; return allJobs.filter(job => !id || job.projectId === id);
    } } as never, scheduledJobService: {} as never, assertProjectAccess: () => null }));
    const server = app.listen(0); servers.push(server); const port = (server.address() as { port: number }).port;
    const response = await fetch(`http://127.0.0.1:${port}${page.url}`);
    expect(response.status).toBe(200);
    expect((await response.json()).jobs.map((job: { id: string }) => job.id)).toEqual(['mine']);
    expect(receivedScope).toBe(projectId);
  });
});
async function setup(scope?: string, globalProjects?: string[] | 'all') {
  const project = { id: 'a', slug: 'alias-a', name: '甲项目' } as Project;
  const source = fs.readFileSync(path.resolve('src/server.ts'), 'utf8');
  const file = ts.createSourceFile('server.ts', source, ts.ScriptTarget.Latest, true);
  const stamp = file.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'stampSingleProjectScope');
  expect(stamp).toBeDefined();
  const context = { stamp: null as unknown as (request: unknown, match: unknown) => void };
  vm.runInNewContext(ts.transpileModule(`${stamp!.getText(file)}; stamp = stampSingleProjectScope;`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText, context);
  const app = express(); app.use(express.json());
  app.use((req, _res, next) => {
    if (scope) (req as unknown as { cdsProjectKey: unknown }).cdsProjectKey = { projectId: scope };
    if (globalProjects !== undefined) {
      const match = { keyId: 'owned-test-global', access: { projects: globalProjects } };
      (req as unknown as { cdsAccess: unknown }).cdsAccess = match;
      context.stamp(req, match);
    }
    next();
  });
  app.use('/api', createProjectInspectionsRouter({ getProject: id => ['a', 'alias-a'].includes(id) ? project : undefined, save: (_id, entries) => { project.monitoringInspections = entries; } }));
  const server = app.listen(0); servers.push(server); const port = (server.address() as { port: number }).port;
  const request = async (method: string, path: string, body?: unknown) => { const response = await fetch(`http://127.0.0.1:${port}/api${path}`, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) }); return { status: response.status, data: await response.json() }; };
  return { project, request };
}

async function actualSelfCheck(authorized = true, paused = false) {
  const before = Date.now() - 86_400_000, at = new Date(before).toISOString();
  const inspection = parseProjectInspection('models', { ...input(), intervalSeconds: 60,
    lastCompletedAt: at, enabled: !paused, checks: [{ ...input().checks[0], checkedAt: at }] }, 'project:a', before);
  const projects = [{ id: 'a', name: '甲项目', monitoringInspections: [inspection] },
    { id: 'b', name: '乙项目', monitoringInspections: [inspection] }];
  const core = { status: 'warn', serviceId: 'cds', description: '原自检', releaseId: 'a'.repeat(40),
    checks: { 'core.keep': { componentId: 'core.keep', componentType: 'system', observedValue: 1, status: 'warn', time: at } } };
  const original = JSON.parse(JSON.stringify(core)), calls = { cache: 0, projects: 0 };
  const source = fs.readFileSync(path.resolve('src/index.ts'), 'utf8');
  const file = ts.createSourceFile('index.ts', source, ts.ScriptTarget.Latest, true), handlers: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && node.expression.getText(file) === 'app.get'
      && node.arguments[0]?.getText(file) === 'SELF_CHECK_PATH') handlers.push(node.arguments[1].getText(file));
    ts.forEachChild(node, visit);
  };
  visit(file); expect(handlers).toHaveLength(1);
  const context = { ...inspectionService, SELF_CHECK_HEADER: 'x-cds-self-check',
    selfCheckAuth: { verify: () => authorized },
    stateService: { getProject: (id: string) => projects.find(p => p.id === id), getProjects: () => { calls.projects++; return projects; } },
    cachedSelfCheck: async () => { calls.cache++; return core; }, handler: null as unknown };
  vm.runInNewContext(ts.transpileModule(`handler = (${handlers[0]});`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, context);
  const app = express(); app.get('/api/self-check', context.handler as express.RequestHandler);
  const server = app.listen(0); servers.push(server); const port = (server.address() as { port: number }).port;
  return { core, original, calls, inspection, get: async (suffix = '') => {
    const response = await fetch(`http://127.0.0.1:${port}/api/self-check${suffix}`);
    return { status: response.status, data: await response.json() };
  } };
}

describe('原常设自检实际HTTP接线', () => {
  it('原项目监督端点发现的标识在总览说明只监督回填期限，不再次调用付费模型', async () => {
    const f = await actualSelfCheck(), response = await f.get('?projectInspection=a');
    const discovered = discoverMonitors(response.data, 'https://cds.example.test/api/self-check?projectInspection=a');
    expect(discovered.rejected).toEqual([]); expect(discovered.monitors).toHaveLength(1);
    const purpose = (componentId: string) => checkPurpose({ healthCheck: { componentId } } as Parameters<typeof checkPurpose>[0]);
    expect(purpose('inspection.freshness.models')).toContain('监督巡检');
    for (const monitor of discovered.monitors) expect(purpose(monitor.componentId)).toBe(purpose('inspection.freshness.models'));
  });
  it('原裸端点保持核心检查及发现集合，不隐式登记项目监督或污染短缓存', async () => {
    const f = await actualSelfCheck(), response = await f.get();
    expect(response.status).toBe(200); expect(response.data).toEqual(f.core);
    expect(discoverMonitors(response.data, 'https://cds.example.test/api/self-check').monitors).toEqual([]);
    expect(f.core).toEqual(f.original); expect(f.calls).toEqual({ cache: 1, projects: 0 });
  });
  it('原项目诊断参数保持独立监督文档及发现标识，不运行宿主核心检查', async () => {
    const f = await actualSelfCheck(), response = await f.get('?projectInspection=a');
    expect(response.data.serviceId).toBe('project-inspection-supervision');
    expect(Object.keys(response.data.checks)).toEqual(['inspection.freshness.models']);
    expect(response.data.releaseId).toBeUndefined(); expect(f.core).toEqual(f.original);
    expect(f.calls).toEqual({ cache: 0, projects: 0 });
  });
  it('既有项目监督发现身份保持，不删除原监控或隐式生成替代项', async () => {
    const f = await actualSelfCheck(), response = await f.get('?projectInspection=a');
    const endpointUrl = 'https://cds.example.test/api/self-check?projectInspection=a';
    const legacy = discoverMonitors(inspectionHealthDocument([f.inspection]), endpointUrl);
    const args = { endpointUrl, projectId: 'a', hash: (s: string) => createHash('sha256').update(s).digest('hex'), now: () => '2026-11-06T00:00:00Z' };
    const existing = reconcileDiscoveredMonitors({ ...args, existing: [], discovered: legacy.monitors }).upsert;
    const current = discoverMonitors(response.data, endpointUrl);
    expect(current.monitors.map(m => m.key)).toEqual(legacy.monitors.map(m => m.key));
    const plan = reconcileDiscoveredMonitors({ ...args, existing, discovered: current.monitors });
    expect(plan.remove).toEqual([]); expect(plan.upsert).toEqual([]);
  });
  it.each([{ authorized: false, suffix: '', status: 401 }, { authorized: true, suffix: '?projectInspection=missing', status: 404 },
    { authorized: true, suffix: '?projectInspection=a&projectInspection=b', status: 400 }])('鉴权和无效参数先拒绝$status，不计算原宿主自检', async ({ authorized, suffix, status }) => {
    const f = await actualSelfCheck(authorized); expect((await f.get(suffix)).status).toBe(status);
    expect(f.calls).toEqual({ cache: 0, projects: 0 });
  });
  it('暂停的巡检不声明监督目标，也不清空原核心检查', async () => {
    const f = await actualSelfCheck(true, true); expect((await f.get()).data).toEqual(f.core); expect(f.core).toEqual(f.original);
    expect((await f.get('?projectInspection=a')).data.checks).toEqual({});
    expect(f.calls.cache).toBe(1);
  });
});
describe('项目定期实测与通知回填', () => {
  it.each([
    { label: '仅创建项目', projects: [] as string[], allowed: false },
    { label: '其他单项目', projects: ['b'], allowed: false },
    { label: '已授权单项目', projects: ['a'], allowed: true },
    { label: '全项目', projects: 'all' as const, allowed: true },
  ])('全局凭据$label范围的回写与专用回读遵守同一项目授权', async ({ projects, allowed }) => {
    const { request, project } = await setup(undefined, projects);
    project.monitoringInspections = [parseProjectInspection('models', input(), 'project:a', now)];
    const before = JSON.stringify(project), next = { ...input(), name: '本项目更新' };
    const written = await request('PUT', '/projects/alias-a/inspection-checks/models', next);
    expect(written.status).toBe(allowed ? 200 : 403);
    if (!allowed) { expect(JSON.stringify(project)).toBe(before); return; }
    const read = await request('GET', '/projects/a/inspection-checks');
    expect(read.status).toBe(200); expect(read.data.inspections).toHaveLength(1);
    expect(read.data.inspections[0]).toEqual(written.data.inspection);
    expect(read.data.inspections[0].name).toBe('本项目更新');
  });
  it.each(['b', 'missing'])('获准本项目的全局凭据仍不能回写%s，原数据保持', async target => {
    const { request, project } = await setup(undefined, ['a']);
    project.monitoringInspections = [parseProjectInspection('models', input(), 'project:a', now)];
    const before = JSON.stringify(project);
    expect((await request('PUT', `/projects/${target}/inspection-checks/models`, input())).status).toBe(403);
    expect(JSON.stringify(project)).toBe(before);
  });
  it.each([{ projects: [] as string[] }, { projects: ['b'] }, { projects: ['a'] }, { projects: 'all' as const }])('全局项目范围%j在真实读取入口遵守既有项目权限', async ({ projects }) => {
    const allowed = projects === 'all' || projects.includes('a');
    const { request, project } = await setup(undefined, projects === 'all' ? projects : [...projects]);
    project.monitoringInspections = [parseProjectInspection('models', input(), 'project:a', now)];
    const result = await request('GET', '/projects/alias-a/inspection-checks');
    expect(result.status).toBe(allowed ? 200 : 403);
    if (!allowed) expect(JSON.stringify(result.data)).not.toMatch(/巡检接收人|reports\?project=a|inspections/);
    else expect(result.data.inspections[0].notification.recipient).toBe('巡检接收人');
  });
  it.each([{ projects: [] as string[] }, { projects: ['b'] }])('全局范围%j也不能用未知项目绕过同一权限边界', async ({ projects }) => {
    const { request } = await setup(undefined, projects);
    expect((await request('GET', '/projects/missing/inspection-checks')).status).toBe(403);
  });
  it.each([true, false])('混合失败与旧通过时启用=%s仍保留逐项有效期和暂停事实', enabled => {
    const inspection = parseProjectInspection('models', input(), 'project:a', now);
    inspection.enabled = enabled;
    inspection.checks.push({ ...inspection.checks[0], id: 'failed', outcome: 'fail' });
    const later = now + 3 * 86400000;
    expect(inspectionState(inspection, later)).toBe(enabled ? 'down' : 'paused');
    expect(inspectionCheckState(inspection, inspection.checks[0], later)).toBe(enabled ? 'overdue' : 'paused');
    expect(inspectionCheckLabel(inspection, inspection.checks[0], later)).toContain(enabled ? '已过期' : '已暂停');
  });
  it.each([{ inspectionsResult: null }, { inspectionsResult: [] }])('真实覆盖区块渲染保留读取结果%j与确认为空的差别', ({ inspectionsResult }) => {
    const source = fs.readFileSync(path.resolve('web/src/pages/ProjectStatusPage.tsx'), 'utf8');
    const block = source.match(/<section id="coverage"[\s\S]*?<\/section>/)?.[0];
    expect(block).toBeTruthy();
    const code = ts.transpileModule(`result = (${block});`, { compilerOptions: { jsx: ts.JsxEmit.React, jsxFactory: 'createElement' } }).outputText;
    const context = { createElement, checks: [], inspections: [], previews: [],
      data: { project: { id: 'a' }, summary: null, inspections: inspectionsResult },
      Link: (props: { to: string; children: unknown }) => createElement('a', { href: props.to }, props.children as never), result: null };
    vm.runInNewContext(code, context);
    const text = renderToStaticMarkup(context.result).replace(/<[^>]*>/g, '').replace(/\s/g, '');
    if (inspectionsResult === null) {
      expect(text).not.toContain('定期实测尚未接入');
      expect(text).toContain('覆盖情况尚未确认');
      expect(text).toContain('外部定期实测未知项');
    } else expect(text).toContain('定期实测尚未接入');
  });

  it('按项目和计划幂等保存并回读，服务器盖来源时间，旧结果不能覆盖新结果', async () => {
    const { request, project } = await setup('a');
    expect((await request('PUT', '/projects/alias-a/inspection-checks/models', input())).status).toBe(200);
    expect((await request('PUT', '/projects/a/inspection-checks/models', input())).status).toBe(200);
    const read = await request('GET', '/projects/a/inspection-checks');
    expect(read.data.inspections).toHaveLength(1); expect(read.data.inspections[0].reportedBy).toBe('project:a');
    expect(read.data.inspections[0].checks[0].name).toBe('生图甲');
    const older = { ...input(), lastCompletedAt: '2026-11-04T14:00:00Z' };
    expect((await request('PUT', '/projects/a/inspection-checks/models', older)).status).toBe(409);
    expect(project.monitoringInspections?.[0].lastCompletedAt).toBe('2026-11-05T14:00:00.000Z');
  });
  it('项目凭据不能读取或写入其他项目，包括不存在的项目', async () => {
    const { request } = await setup('b');
    expect((await request('GET', '/projects/a/inspection-checks')).status).toBe(403);
    expect((await request('PUT', '/projects/a/inspection-checks/models', input())).status).toBe(403);
    expect((await request('GET', '/projects/missing/inspection-checks')).status).toBe(403);
  });
  it('未知项目明确404，不返回其他项目的数据', async () => { const { request } = await setup(); expect((await request('GET', '/projects/missing/inspection-checks')).status).toBe(404); });
  it('拒绝不安全证据链接、无完成时间的通过结果、重复检查和没有回执的已送出声明', () => {
    const i = input(); i.checks[0].evidenceUrl = 'javascript:alert(1)'; expect(() => parseProjectInspection('models', i, 'a', now)).toThrow();
    expect(() => parseProjectInspection('models', { ...input(), lastCompletedAt: null }, 'a', now)).toThrow();
    const duplicate = input(); duplicate.checks.push(duplicate.checks[0]); expect(() => parseProjectInspection('models', duplicate, 'a', now)).toThrow();
    expect(() => parseProjectInspection('models', { ...input(), notification: { ...input().notification, outcome: 'accepted' } }, 'a', now)).toThrow();
  });
  it('逾期、暂停和未执行都不能呈现为当前正常，失败不被逾期掩盖', () => {
    const i = parseProjectInspection('models', input(), 'a', now);
    expect(inspectionState(i, now)).toBe('up');
    const later = now + 3 * 86400000; expect(inspectionState(i, later)).toBe('overdue'); expect(inspectionCheckLabel(i, i.checks[0], later)).toContain('已过期');
    expect(inspectionState({ ...i, enabled: false }, now)).toBe('paused');
    expect(inspectionState({ ...i, lastCompletedAt: null }, now)).toBe('unknown');
    expect(inspectionState({ ...i, checks: [{ ...i.checks[0], outcome: 'fail' }] }, later)).toBe('down');
  });
  it('巡检结果经真实项目存储保存，重新载入后仍保留逐项结果与通知状态', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-inspection-persist-')), file = path.join(dir, 'state.json');
    try {
      fs.writeFileSync(file, JSON.stringify({ projects: [{ id: 'a', slug: 'a', name: '甲项目', createdAt: new Date(now).toISOString() }], branches: {}, logs: {}, routingRules: [], buildProfiles: [], nextPortIndex: 0, defaultBranch: null }));
      const state = new StateService(file); state.load();
      const inspection = parseProjectInspection('models', input(), 'project:a', now);
      state.updateProject('a', { monitoringInspections: [inspection] }); await state.flush();
      const restored = new StateService(file); restored.load();
      expect(restored.getProject('a')?.monitoringInspections?.[0].checks[0].outcome).toBe('pass');
      expect(restored.getProject('a')?.monitoringInspections?.[0].notification.outcome).toBe('not-triggered');
    } finally { await flushAllJsonStateStores(); fs.rmSync(dir, { recursive: true, force: true }); }
  });
  it('巡检漏跑和漏项在同一判据下变红，申报六小时常设监督且不会执行模型调用', () => {
    const i = parseProjectInspection('models', input(), 'project:a', now);
    const late = now + 172800000 + 300001;
    const doc = inspectionHealthDocument([i], late);
    expect(doc.status).toBe('fail');
    const check = doc.checks['inspection.freshness.models'][0];
    expect(check.observedValue).toBe(1); expect(check['cds:monitor'].intervalSeconds).toBe(21600);
    expect(inspectionState(i, late)).toBe('overdue');
    const refreshedWithoutChecks = { ...i, lastCompletedAt: new Date(late).toISOString(), receivedAt: new Date(late).toISOString() };
    expect(inspectionHealthDocument([refreshedWithoutChecks], late).status).toBe('fail');
    expect(inspectionHealthDocument([{ ...i, enabled: false }], late).checks).toEqual({});
  });
  it('只展示本项目和全项目通道，缺配置保持未知', () => {
    const base = { id: 'one', name: '设备', kind: 'bark', status: 'healthy', enabled: true, events: ['business-down'] };
    expect(projectChannels([{ ...base, projects: ['b'] }, { ...base, id: 'all', projects: [] }], 'a')?.map(c => c.id)).toEqual(['all']);
    expect(projectChannels(undefined, 'a')).toBeUndefined();
  });
});
