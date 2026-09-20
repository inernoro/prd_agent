import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { UptimeMonitorService } from '../../src/services/uptime-monitor.js';
import { probeCustomMonitor } from '../../src/services/uptime-custom-monitor.js';
import { decideSelfMonitorAlarm, type SelfMonitorAlarmState } from '../../src/services/self-monitor-alarm-policy.js';
import type { UptimeCustomMonitor } from '../../src/types.js';
import { renderAlarmMessage } from '../../src/services/alarm-route.js';

const MIN = 60_000;
afterEach(() => vi.unstubAllGlobals());

describe('零采样与真实故障的边界', () => {
  it('分支列表无样本不报故障；遥测丢失、组件缺失和有样本的超标仍是失败', async () => {
    let doc: any = { checks: { latency: { componentId: 'latency', observedValue: null }, samples: { componentId: 'samples', observedValue: 0 } } };
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(doc), { status: 200 })));
    const probe = () => probeCustomMonitor({ kind: 'health-json', url: 'http://localhost/self-check',
      healthComponentId: 'latency', healthField: 'observedValue', healthOp: 'lte', healthValue: '1500', observeMode: 'passive', sampleCountPath: 'samples' }, 500);
    expect(await probe()).toMatchObject({ noData: true, up: false });
    for (const invalid of [null, false, '', ' ', -1]) {
      doc.checks.samples.observedValue = invalid;
      expect(await probe()).not.toHaveProperty('noData');
    }
    doc.checks.samples.observedValue = 0; delete doc.checks.latency;
    expect(await probe()).toMatchObject({ up: false });
    expect(await probe()).not.toHaveProperty('noData');
    doc.checks.samples.observedValue = 12; doc.checks.latency = { componentId: 'latency', observedValue: 2000 };
    expect(await probe()).toMatchObject({ up: false });
    expect(await probe()).not.toHaveProperty('noData');
  });

  it('真实探测台账跨重启保留通知状态：无样本不计可用率、不恢复，连续健康 10 分钟仅向收到故障的通道恢复', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'alarm-noise-'));
    const monitor: UptimeCustomMonitor = { id: 'm', name: '首屏', kind: 'http', url: 'https://example.test',
      enabled: true, projectId: 'cds-self-monitor', createdAt: '', updatedAt: '', intervalSeconds: 300 };
    let at = 100 * MIN;
    let outcome = { up: false, ms: 1, noData: false };
    const alerts: Array<{ type: string; data: any }> = [];
    const create = () => new UptimeMonitorService({
      state: { getAllBranches: () => [], getProject: () => undefined, getUptimeMonitors: () => [monitor] },
      config: { enabled: true, intervalMs: MIN, timeoutMs: 1000, failureThreshold: 1, recoveryThreshold: 1,
        maxSamples: 100, excludePatterns: [], scope: 'all', storePath: path.join(dir, 'uptime.json'), userViewEnabled: false },
      now: () => at, probe: async () => outcome,
      onAlert: (type, data) => alerts.push({ type, data }),
    });
    try {
      let svc = create();
      await svc.probeNow('monitor@m');
      expect(alerts).toHaveLength(1);
      svc.markAlarmDelivered('monitor@m', 'phone', new Date(at).toISOString());
      svc = create();
      at += 5 * MIN; outcome = { up: false, noData: true, ms: 1 };
      expect(await svc.probeNow('monitor@m')).toMatchObject({ status: 'down', sample: { noData: true } });
      const disk = JSON.parse(fs.readFileSync(path.join(dir, 'uptime.json'), 'utf8'));
      expect(disk.targets[0].samples).toHaveLength(1);
      expect(alerts).toHaveLength(1);
      outcome = { up: true, noData: false, ms: 1 };
      for (let i = 0; i < 3; i++) { at += 5 * MIN; await svc.probeNow('monitor@m'); }
      expect(alerts).toHaveLength(2);
      expect(alerts[1]).toMatchObject({ type: 'uptime.target.recovered', data: { recoveryChannelIds: ['phone'] } });
      at += MIN; outcome = { up: false, noData: false, ms: 1 }; await svc.probeNow('monitor@m');
      expect(alerts).toHaveLength(2); // 30 分钟内同一指标重新抖动被合并。
      at = 131 * MIN; await svc.probeNow('monitor@m');
      expect(alerts).toHaveLength(3); // 冷却后仍异常必须通知，不能永久吞掉。
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
});

describe('通知恢复策略', () => {
  const sample = (state: SelfMonitorAlarmState, at: number, up: boolean, noData = false) =>
    decideSelfMonitorAlarm(state, { at: at * MIN, up, noData, down: !up, intervalMs: 5 * MIN });
  it('短暂恢复后再次失败仍为同一事件；断档与零样本不能凑够 10 分钟', () => {
    const s: SelfMonitorAlarmState = {};
    expect(sample(s, 0, false).emit).toBe('down'); s.acceptedChannels = ['p'];
    sample(s, 5, true); sample(s, 10, false);
    expect(sample(s, 15, false).emit).toBeUndefined();
    sample(s, 20, true); sample(s, 25, false, true); sample(s, 30, true);
    expect(sample(s, 45, true).emit).toBeUndefined();
    sample(s, 50, true); expect(sample(s, 55, true).emit).toBe('recovered');
  });
  it('首次健康和未实际发出的故障不产生恢复；不同指标互不限流', () => {
    const a: SelfMonitorAlarmState = {}, b: SelfMonitorAlarmState = {};
    expect(sample(a, 0, true).emit).toBeUndefined();
    expect(sample(a, 1, false).emit).toBe('down'); expect(sample(b, 1, false).emit).toBe('down');
    sample(a, 5, true); sample(a, 10, true);
    expect(sample(a, 15, true)).toEqual({ reason: 'no-delivered-down' });
  });
  it('内部指标异常不再声称业务挂掉', () => {
    const result = renderAlarmMessage({ projectId: 'cds-self-monitor', targetName: 'P95', kind: 'business-down', message: '观测超标', detectedAt: '', consecutiveFailures: 3 });
    expect(result.title).toBe('P95 指标异常'); expect(result.level).toBe('active');
    expect(result.body).not.toContain('用户现在用不了');
  });
});
