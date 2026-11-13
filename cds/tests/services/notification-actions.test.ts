import { afterEach, describe, expect, it, vi } from 'vitest';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { createUptimeRouter } from '../../src/routes/uptime.js';
import { StateService } from '../../src/services/state.js';
import { UptimeMonitorService } from '../../src/services/uptime-monitor.js';
import { flushAllJsonStateStores } from '../../src/infra/state-store/json-backing-store.js';
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { vi.restoreAllMocks(); for (const cleanup of cleanups.splice(0)) await cleanup(); });
async function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-notification-actions-'));
  const file = path.join(dir, 'state.json'); const store = new StateService(file, dir); store.load();
  store.upsertUptimeMonitor({ id: 'proof', name: '隔离探针', kind: 'http', url: 'http://127.0.0.1/fixture-never-called', enabled: true, createdAt: '', updatedAt: '' });
  const monitor = new UptimeMonitorService({ state: { getAllBranches: () => [], getUptimeMonitors: () => store.listUptimeMonitors() },
    config: { enabled: true, intervalMs: 60000, timeoutMs: 1000, failureThreshold: 1, recoveryThreshold: 1, maxSamples: 20, excludePatterns: [], scope: 'all', storePath: '' },
    probe: async () => ({ up: false, ms: 1 }) });
  await monitor.probeNow('monitor@proof');
  const app = express(); app.use(express.json());
  app.use((req, _res, next) => { if (req.headers['x-fixture-member']) (req as typeof req & { cdsUser: { isSystemOwner: boolean } }).cdsUser = { isSystemOwner: false }; if (req.headers['x-fixture-project']) (req as typeof req & { cdsProjectKey: { projectId: string } }).cdsProjectKey = { projectId: 'fixture' }; next(); });
  app.use('/api', createUptimeRouter({ monitor, store, getNotifications: () => store.getMonitorNotifications(), setNotifications: value => store.setMonitorNotifications(value), listNotificationChannelIds: () => [] }));
  const server = http.createServer(app); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const root = `http://127.0.0.1:${(server.address() as { port: number }).port}/api`;
  const put = (body: object, scoped: boolean | 'member' = false) => fetch(root + '/uptime/notifications', { method: 'PUT', headers: { 'content-type': 'application/json', ...(scoped === 'member' ? { 'x-fixture-member': 'yes' } : scoped ? { 'x-fixture-project': 'yes' } : {}) }, body: JSON.stringify(body) });
  const get = async () => (await (await fetch(root + '/uptime/notifications')).json()).settings;
  const reload = () => { const cold = new StateService(file, dir); cold.load(); return cold.getMonitorNotifications(); };
  cleanups.push(async () => { await monitor.stop(); await store.flush(); await flushAllJsonStateStores(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); fs.rmSync(dir, { recursive: true, force: true }); });
  return { store, monitor, put, get, reload };
}

describe('通知动作的实际路由、权限与持久化边界', () => {
  it('已知悉和免打扰独立于故障状态，保存后重读保持；无权项目身份不能执行', async () => {
    const f = await fixture(); const before = f.monitor.getSummary();
    expect((await f.put({ targetId: 'monitor@proof', acknowledged: true }, true)).status).toBe(403);
    expect((await f.put({ targetId: 'monitor@proof', acknowledged: true }, 'member')).status).toBe(403);
    expect(await f.get()).toEqual({});
    const muteUntil = Date.now() + 60_000;
    expect((await f.put({ targetId: 'monitor@proof', acknowledged: true, muteUntil })).status).toBe(200);
    expect(await f.get()).toMatchObject({ acknowledgedAt: { 'monitor@proof': expect.any(Number) }, mutedUntil: { 'monitor@proof': muteUntil } });
    expect(f.reload()).toEqual(await f.get());
    expect(f.monitor.getSummary().targets[0].status).toBe('down');
    expect(f.monitor.getSummary().targets[0].openIncidentSince).toBe(before.targets[0].openIncidentSince);
    expect((await f.put({ targetId: 'monitor@proof', acknowledged: false, muteUntil: null })).status).toBe(200);
    expect((await f.get()).acknowledgedAt?.['monitor@proof']).toBeUndefined();
    expect((await f.get()).mutedUntil?.['monitor@proof']).toBeUndefined();
    expect(f.monitor.getSummary().targets[0].status).toBe('down');
  });
  it('落盘失败反馈不可泄露内部异常，刷新与重启不得显示失败操作为成功，保留其它目标的并发变化', async () => {
    const f = await fixture(); const flush = f.store.flush.bind(f.store);
    vi.spyOn(f.store, 'flush').mockImplementationOnce(async () => {
      f.store.setMonitorNotifications({ ...f.store.getMonitorNotifications(), acknowledgedAt: { ...f.store.getMonitorNotifications().acknowledgedAt, other: 123 } });
      throw new Error('private-disk-path sk-must-not-leak');
    }).mockImplementation(flush);
    const response = await f.put({ targetId: 'monitor@proof', acknowledged: true, muteUntil: Date.now() + 60000 });
    expect(response.status).toBe(503); const body = await response.text();
    expect(body).toContain('刷新核对'); expect(body).not.toMatch(/private-disk|sk-must/);
    expect(await f.get()).toEqual({ acknowledgedAt: { other: 123 } });
    expect(f.reload()).toEqual(await f.get());
    expect(f.monitor.getSummary().targets[0].status).toBe('down');
  });
  it('同时确认与免打扰不覆盖彼此，响应后的持久化结果一致', async () => {
    const f = await fixture(); const muteUntil = Date.now() + 60000;
    const responses = await Promise.all([f.put({ targetId: 'monitor@proof', acknowledged: true }), f.put({ targetId: 'monitor@proof', muteUntil })]);
    expect(responses.map(response => response.status)).toEqual([200, 200]);
    expect(await f.get()).toMatchObject({ acknowledgedAt: { 'monitor@proof': expect.any(Number) }, mutedUntil: { 'monitor@proof': muteUntil } });
    expect(f.reload()).toEqual(await f.get());
  });
});
