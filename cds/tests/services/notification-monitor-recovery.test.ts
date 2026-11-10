import { it, expect } from 'vitest';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { UptimeMonitorService, uptimeConfigFromEnv } from '../../src/services/uptime-monitor.js';
import { StateService } from '../../src/services/state.js';
import { NotificationReportRecorder } from '../../src/services/notification-report.js';
import type { UptimeCustomMonitor } from '../../src/types.js';
import { flushAllJsonStateStores } from '../../src/infra/state-store/json-backing-store.js';

it('关闭发送通道仍在真实稳定10分钟后关闭原报告；冷却期间的新故障仍归档且不补发短信', async () => {
  let failed = true, now = 1_700_000_000_000;
  const server = http.createServer((_req, res) => { res.statusCode = failed ? 503 : 200; res.end('fixture'); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-notification-recovery-'));
  const state = new StateService(path.join(dir, 'state.json'), dir); state.load();
  const recorder = new NotificationReportRecorder(state);
  const pending: Promise<unknown>[] = [], sent: string[] = [];
  const archive = (type: string, data: any) => pending.push(recorder.record({ ...data,
    kind: type.endsWith('.down') ? 'business-down' : 'business-recovered',
    notificationFacts: { environment: data.notificationEnvironment, system: 'cds', function: '探针' } }));
  const monitor: UptimeCustomMonitor = { id: 'test', name: '关闭通道的演练', kind: 'http', projectId: 'fixture', enabled: true,
    url: `http://127.0.0.1:${(server.address() as { port: number }).port}`, environment: 'production', createdAt: '', updatedAt: '' };
  const service = new UptimeMonitorService({ state: { getAllBranches: () => [], getUptimeMonitors: () => [monitor] }, now: () => now,
    config: { ...uptimeConfigFromEnv(dir), enabled: true, storePath: path.join(dir, 'uptime.json'), intervalMs: 60_000, failureThreshold: 1, recoveryThreshold: 1 },
    onAlert: (type, data) => { sent.push(type); archive(type, data); }, onReportEvent: archive });
  const cycle = async () => { await service.runCycle(); await Promise.all(pending); now += 60_000; };
  try {
    await cycle();
    const original = state.listAcceptanceReports(null)[0]; expect(original.monitorEvent?.state).toBe('open');
    failed = false;
    for (let i = 0; i < 10; i++) await cycle();
    expect(state.getAcceptanceReport(original.id)!.monitorEvent?.state).toBe('open');
    await cycle();
    const recovered = state.getAcceptanceReport(original.id)!;
    expect(recovered.monitorEvent?.state).toBe('recovered'); expect(recovered.monitorEvent?.snapshots).toHaveLength(2);
    expect(sent).toEqual(['uptime.target.down']); // No delivered down: never invent a recovery SMS.
    failed = true; await cycle();
    expect(state.listAcceptanceReports(null)).toHaveLength(2);
    expect(sent).toEqual(['uptime.target.down']);
  } finally {
    await service.flush(); await flushAllJsonStateStores();
    await new Promise<void>(resolve => server.close(() => resolve())); fs.rmSync(dir, { recursive: true, force: true });
  }
});
