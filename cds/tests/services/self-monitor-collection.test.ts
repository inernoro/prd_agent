import { afterEach, describe, expect, it, vi } from 'vitest';
import http from 'node:http';
import type { UptimeCustomMonitor } from '../../src/types.js';
import { UptimeMonitorService, uptimeConfigFromEnv } from '../../src/services/uptime-monitor.js';
import { probeHealthJsonBatch } from '../../src/services/uptime-custom-monitor.js';
import { independentIncidentUrl } from '../../src/services/alarm-dispatch.js';
import type { AlarmChannelConfig, AlarmEvent } from '../../src/services/alarm-route.js';

const monitors = Array.from({ length: 13 }, (_, i) => ({ id: `m${i}`, name: `检查 ${i}`, projectId: 'cds-self-monitor',
  kind: 'health-json', url: 'http://127.0.0.1:9900/api/self-check', enabled: true, intervalSeconds: 60, timeoutMs: 1000,
  healthComponentId: `metric-${i}`, healthField: 'observedValue', healthOp: 'eq', healthValue: '0',
  createdAt: '', updatedAt: '', environment: 'production' } as UptimeCustomMonitor));
const document = (bad = -1) => ({ checks: Object.fromEntries(monitors.map((m, i) => [m.healthComponentId!, [{ componentId: m.healthComponentId, observedValue: bad === i ? 1 : 0 }]])) });
afterEach(() => vi.unstubAllGlobals());

describe('自检采集故障合并', () => {
  it('13 项指标共享一个真实 HTTP 请求，指标越界保留', async () => {
    let calls = 0;
    const server = http.createServer((_req, res) => { calls++; res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(document(2))); });
    await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
    try {
      const address = server.address() as { port: number };
      const result = await probeHealthJsonBatch(monitors.map(m => ({ ...m, url: `http://127.0.0.1:${address.port}/api/self-check` })), 1000);
      expect(calls).toBe(1); expect(result.collection.up).toBe(true);
      expect(result.members[2]).toMatchObject({ up: false });
      expect(result.members.filter(m => m.up)).toHaveLength(12);
    } finally { server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); }
  });
  it('连续采集失败只建立一个采集事件，不伪造 13 个指标故障；恢复不刷 13 条', async () => {
    let now = 1_000_000;
    const fetch = vi.fn().mockRejectedValue(new Error('connection reset'));
    vi.stubGlobal('fetch', fetch);
    const alerts = vi.fn();
    const service = new UptimeMonitorService({
      state: { getAllBranches: () => [], getUptimeMonitors: () => monitors },
      config: { ...uptimeConfigFromEnv('/tmp'), storePath: '', failureThreshold: 3 }, now: () => now, onAlert: alerts,
    });
    for (let i = 0; i < 4; i++) { await service.runCycle(); now += 60_000; }
    expect(fetch).toHaveBeenCalledTimes(4);
    expect(alerts).toHaveBeenCalledTimes(1);
    expect(alerts.mock.calls[0][1].targetId).toMatch(/^monitor@self-collection-/);
    expect(service.getSummary().targets.filter(t => t.status === 'unknown')).toHaveLength(13);
    expect(service.getIncidents()).toHaveLength(1);
    fetch.mockImplementation(async () => new Response(JSON.stringify(document())));
    for (let i = 0; i < 12; i++) { await service.runCycle(); now += 60_000; }
    expect(alerts).toHaveBeenCalledTimes(1); // 未确认送达的故障不发送恢复通知
    expect(service.getSummary().targets.every(t => t.status === 'up')).toBe(true);
  });
  it('已有真实指标故障在采集中断后仍保留，读取成功不会伪造整体恢复', async () => {
    let now = 1_000_000;
    const fetch = vi.fn().mockImplementation(async () => new Response(JSON.stringify(document(2))));
    vi.stubGlobal('fetch', fetch);
    const service = new UptimeMonitorService({ state: { getAllBranches: () => [], getUptimeMonitors: () => monitors },
      config: { ...uptimeConfigFromEnv('/tmp'), storePath: '', failureThreshold: 1 }, now: () => now });
    await service.runCycle(); now += 60_000;
    fetch.mockRejectedValue(new Error('timeout'));
    await service.runCycle();
    expect(service.getRecord('monitor@m2')?.status).toBe('down');
    expect(service.getRecord('monitor@m2')?.incidents[0].endedAt).toBeNull();
    expect(service.getRecord('monitor@m0')?.lastSample?.noData).toBe(true);
  });
  it('独立通知链接只应用于 CDS 自身，保留具体目标与发现时间', () => {
    const c = { incidentPageUrl: 'https://status.example/index.html' } as AlarmChannelConfig;
    const event = { projectId: 'cds-self-monitor', targetId: 'monitor@test', detectedAt: '2026-09-30T10:00:00Z' } as AlarmEvent;
    expect(new URL(independentIncidentUrl(c, event)!).searchParams.get('target')).toBe('monitor@test');
    expect(independentIncidentUrl(c, { ...event, projectId: 'other' })).toBeUndefined();
  });
});
