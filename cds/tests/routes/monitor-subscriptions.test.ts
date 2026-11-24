import { afterEach, describe, expect, it } from 'vitest';
import express from 'express';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { StateService } from '../../src/services/state.js';
import { flushAllJsonStateStores } from '../../src/infra/state-store/json-backing-store.js';
import { createUptimeRouter } from '../../src/routes/uptime.js';

const dirs: string[] = [];
afterEach(async () => { await flushAllJsonStateStores(); dirs.splice(0).forEach(dir => rmSync(dir, { recursive: true, force: true })); });
function setup() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'monitor-subscriptions-')); dirs.push(dir);
  const file = path.join(dir, 'state.json'); const state = new StateService(file, dir); state.load();
  for (const id of ['prod', 'test']) state.upsertUptimeMonitor({ id, kind: 'http', name: id, enabled: true, environment: id === 'prod' ? 'production' : 'staging', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
  const targets = [
    { id: 'monitor@prod', monitorId: 'prod', projectId: 'p', source: 'custom', environment: 'production', environmentLabel: '生产', status: 'up', measured: true },
    { id: 'monitor@test', monitorId: 'test', projectId: 'p', source: 'custom', environment: 'staging', environmentLabel: '预发', status: 'unknown', measured: false },
    { id: 'branch::api', projectId: 'p', source: 'branch', status: 'paused', excluded: true, measured: false },
    { id: 'monitor@excluded', monitorId: 'prod', projectId: 'p', source: 'custom', status: 'paused', excluded: true, measured: false },
    { id: 'monitor@removed', monitorId: 'removed', projectId: 'p', source: 'custom', status: 'unknown', measured: false },
  ];
  const monitor = { getSummary: () => ({ targets, overall: {} }), getTargetProjectId: (id: string) => targets.find(target => target.id === id)?.projectId, getCoverage: () => ({}) } as unknown as Parameters<typeof createUptimeRouter>[0]['monitor'];
  const app = express(); app.use(express.json());
  app.use((req, _res, next) => { const scope = req.header('x-test-project'); if (scope) (req as any).cdsProjectKey = { projectId: scope }; next(); });
  app.use('/api', createUptimeRouter({ monitor, store: state }));
  return { app, state, file, dir, targets };
}
async function request(app: express.Express, route: string, options?: RequestInit) {
  const server = app.listen(0); const port = (server.address() as { port: number }).port;
  try { const response = await fetch(`http://127.0.0.1:${port}/api/uptime/${route}`, options); return { status: response.status, body: await response.json() }; }
  finally { server.close(); }
}
describe('真实持久订阅而非全量探测台账', () => {
  it('默认跨环境、仅已登记订阅；无观测订阅仍在，自动分支和已删定义不在', async () => {
    const { app } = setup(); const result = await request(app, 'summary?subscribed=true');
    expect(result.body.targets.map((target: any) => target.id)).toEqual(['monitor@prod', 'monitor@test']);
    expect(result.body.overall.total).toBe(2);
    expect(result.body.targets.map((target: any) => target.environment)).toEqual(['production', 'staging']);
    expect((await request(app, 'summary')).body.targets).toHaveLength(5);
  });
  it('取消订阅持久化跨重启，不停共享探测；自发现重复upsert不会重新订阅', async () => {
    const { app, state, file, dir } = setup();
    expect((await request(app, 'targets/monitor%40prod/subscription', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ subscribed: false }) })).status).toBe(200);
    state.upsertUptimeMonitor({ ...state.getUptimeMonitor('prod')!, name: 'rediscovered' });
    expect(state.getUptimeMonitor('prod')!.enabled).toBe(true);
    const definition = { ...state.getUptimeMonitor('prod')! }; state.removeUptimeMonitor('prod'); state.upsertUptimeMonitor(definition);
    expect(state.getMonitorSubscriptions()['monitor@prod'].subscribed).toBe(false);
    expect((await request(app, 'summary?subscribed=true')).body.targets.map((target: any) => target.id)).toEqual(['monitor@test']);
    await state.flush(); const cold = new StateService(file, dir); cold.load(); expect(cold.getMonitorSubscriptions()['monitor@prod'].subscribed).toBe(false);
  });
  it('项目凭据不能改他人的订阅，缺目标和非法布尔值不写入', async () => {
    const { app, state } = setup();
    const put = (id: string, value: unknown, project?: string) => request(app, `targets/${encodeURIComponent(id)}/subscription`, { method: 'PUT', headers: { 'content-type': 'application/json', ...(project ? { 'x-test-project': project } : {}) }, body: JSON.stringify({ subscribed: value }) });
    expect((await put('monitor@prod', false, 'other')).status).toBe(403);
    expect((await put('monitor@prod', false, 'p')).status).toBe(403);
    expect((await put('missing', true)).status).toBe(404);
    expect((await put('monitor@prod', 'true')).status).toBe(400);
    expect(state.getMonitorSubscriptions()['monitor@prod'].subscribed).toBe(true);
  });
  it('采集通道只随实际进入总览的指标展示，暂停订阅不会留下空采集器', async () => {
    const { app, state, targets } = setup();
    Object.assign(targets[0], { status: 'paused', excluded: true });
    state.setMonitorSubscription('monitor@test', false, 'fixture');
    targets.push({ id: 'monitor@collector', projectId: 'p', source: 'custom', status: 'up', measured: true, collectionMembers: [{ id: 'monitor@prod' }, { id: 'monitor@test' }] } as any);
    expect((await request(app, 'summary?subscribed=true')).body.targets).toEqual([]);
    state.setMonitorSubscription('monitor@test', true, 'fixture');
    expect((await request(app, 'summary?subscribed=true')).body.targets.map((target: any) => target.id)).toEqual(['monitor@test', 'monitor@collector']);
    expect((await request(app, 'targets/monitor%40collector/subscription', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ subscribed: false }) })).status).toBe(400);
  });

});
