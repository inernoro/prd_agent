import { afterEach, describe, expect, it } from 'vitest';
import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { StateService } from '../../src/services/state.js';
import { flushAllJsonStateStores } from '../../src/infra/state-store/json-backing-store.js';
import { createProjectInspectionsRouter } from '../../src/routes/project-inspections.js';
import { parseProjectInspection, inspectionHealthDocument } from '../../src/services/project-inspections.js';
import type { Project } from '../../src/types.js';
import { inspectionState, inspectionCheckState, inspectionCheckLabel, projectChannels } from '../../web/src/lib/projectStatus.js';

const now = Date.parse('2026-11-05T14:00:00Z');
const input = () => ({ name: '模型全量实测', executor: '外部巡检执行器', enabled: true, intervalSeconds: 172800, lastCompletedAt: '2026-11-05T14:00:00Z', runKind: 'manual', checks: [{ id: 'image-a', name: '生图甲', purpose: '确认可生成图片', outcome: 'pass', checkedAt: '2026-11-05T14:00:00Z', result: '图片已解码', evidenceUrl: '/reports?project=a&report=one' }], notification: { channel: 'MAP 站内通知', recipient: '巡检接收人', policy: '仅异常和恢复时通知', outcome: 'not-triggered' } });
const servers: Array<ReturnType<express.Express['listen']>> = [];
afterEach(() => { for (const server of servers.splice(0)) server.close(); });
async function setup(scope?: string, globalProjects?: string[] | 'all') {
  const project = { id: 'a', slug: 'alias-a', name: '甲项目' } as Project;
  const app = express(); app.use(express.json());
  app.use((req, _res, next) => {
    if (scope) (req as unknown as { cdsProjectKey: unknown }).cdsProjectKey = { projectId: scope };
    if (globalProjects !== undefined) (req as unknown as { cdsAccess: unknown }).cdsAccess = { keyId: 'owned-test-global', access: { projects: globalProjects } };
    next();
  });
  app.use('/api', createProjectInspectionsRouter({ getProject: id => ['a', 'alias-a'].includes(id) ? project : undefined, save: (_id, entries) => { project.monitoringInspections = entries; } }));
  const server = app.listen(0); servers.push(server); const port = (server.address() as { port: number }).port;
  const request = async (method: string, path: string, body?: unknown) => { const response = await fetch(`http://127.0.0.1:${port}/api${path}`, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) }); return { status: response.status, data: await response.json() }; };
  return { project, request };
}
describe('项目定期实测与通知回填', () => {
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
