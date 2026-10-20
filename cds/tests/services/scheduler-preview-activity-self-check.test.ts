import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as selfCheck from '../../src/services/self-check.js';
import type { SelfCheckDeps } from '../../src/services/self-check.js';
import { SchedulerService } from '../../src/services/scheduler.js';
import { StateService } from '../../src/services/state.js';
import { PreviewActivityCollector } from '../../src/forwarder/preview-activity.js';
import { isTrustedProbeFingerprint } from '../../src/services/probe-marker.js';
import type { ServerEventLogSink, ServerEventRecord } from '../../src/services/server-event-log-store.js';
import { discoverMonitors } from '../../src/services/monitor-discovery.js';
import { selfCheckUrl } from '../../src/services/self-monitoring-bootstrap.js';
import { flushAllJsonStateStores } from '../../src/infra/state-store/json-backing-store.js';

const roots: string[] = [];
afterEach(async () => {
  await flushAllJsonStateStores();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

async function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-activity-self-check-')); roots.push(root);
  const state = new StateService(path.join(root, 'state.json')); state.load();
  let now = 1_790_000_000_000;
  const eventFile = path.join(root, 'events.json');
  const pending: Array<Parameters<ServerEventLogSink['record']>[0]> = [];
  let readable = true;
  let available = false;
  const store: ServerEventLogSink = {
    record: event => { pending.push(event); },
    findRecent: async filter => {
      const rows = fs.existsSync(eventFile) ? JSON.parse(fs.readFileSync(eventFile, 'utf8')) as ServerEventRecord[] : [];
      return rows.filter(row => row.source === filter?.source && row.action === filter?.action
        && Date.parse(String(row.ts)) >= Date.parse(String(filter?.since))).slice(0, filter?.limit ?? 1);
    },
  };
  const persist = () => {
    const old = fs.existsSync(eventFile) ? JSON.parse(fs.readFileSync(eventFile, 'utf8')) as unknown[] : [];
    fs.writeFileSync(eventFile, JSON.stringify([...old, ...pending.splice(0)]));
  };
  const collector = new PreviewActivityCollector(() => now);
  const create = () => {
    const scheduler = new SchedulerService(state, { enabled: true, maxHotBranches: 2,
      idleTTLSeconds: 86400, tickIntervalSeconds: 60, pinnedBranches: [] }, { now: () => now, monotonicNow: () => now });
    scheduler.setPreviewActivitySource(async () => {
      if (!available) throw new Error('不得写入事件的原始异常');
      return collector.snapshot();
    }, isTrustedProbeFingerprint, now - 1000);
    const reader = selfCheck.wireSchedulerPreviewActivitySelfCheck(scheduler, store, () => readable);
    const deps: SelfCheckDeps = {
      now: () => now, deploymentRuns: () => [], unresolvedWebhookDispatches: () => 0, webhookDeliveries: () => [],
      buildGate: () => ({ active: 0, queued: 0, max: 2, waiters: [] }),
      cycleHealth: () => ({ sinceLastCycleMs: 1, stale: false, running: true, watchdogResets: 0 }),
      processStartedAt: () => now - 3600_000, diskUsage: () => ({ totalBytes: 100, freeBytes: 60 }),
      dockerPing: async () => ({ ok: true, ms: 1 }),
      httpStats: async () => ({ requests: 1, serverErrors: 0, branchesP95Ms: 1, branchesRequests: 1 }),
      liveAlarmChannels: () => 1, selfStatus: () => ({ ready: true, bundleStale: false, headSha: 'fixed', currentBranch: 'main' }),
      storeBackend: () => 'test', previewActivity: reader,
    };
    return { scheduler, doc: () => selfCheck.buildSelfCheck(deps) };
  };
  return { create, pending, persist, store, setReadable: (value: boolean) => { readable = value; },
    setAvailable: (value: boolean) => { available = value; }, advance: (ms: number) => { now += ms; } };
}

describe('真实Scheduler事件到常设自检的有限闭环', () => {
  it('实际unknown只记一次，短暂恢复尚未落库也不能假绿；持久历史跨新实例保留6h', async () => {
    const f = await fixture(); const first = f.create();
    await first.scheduler.tick(); await first.scheduler.tick();
    expect(f.pending.map(event => event.action)).toEqual(['unknown']);
    expect(JSON.stringify(f.pending)).not.toContain('不得写入事件的原始异常');
    expect((await first.doc()).checks['scheduler.preview-activity']).toMatchObject({ status: 'fail', observedValue: 1 });
    f.setAvailable(true); f.advance(1000); await first.scheduler.tick();
    expect(f.pending.map(event => event.action)).toEqual(['unknown', 'recovered']);
    expect((await first.doc()).checks['scheduler.preview-activity']).toMatchObject({ status: 'fail', observedValue: 1 });
    f.persist();
    const restarted = f.create(); await restarted.scheduler.tick();
    expect(f.pending).toEqual([]); // 初次健康不伪造 recovered。
    expect((await restarted.doc()).checks['scheduler.preview-activity']).toMatchObject({ status: 'fail', observedValue: 1 });
    f.advance(6 * 3600_000 + 1);
    expect((await restarted.doc()).checks['scheduler.preview-activity']).toMatchObject({ status: 'pass', observedValue: 0 });
  });

  it('初次真实健康不写恢复事件，新声明由原解析器接收并固定6h/P1/一次失败', async () => {
    const f = await fixture(); f.setAvailable(true); const current = f.create();
    await current.scheduler.tick();
    expect(f.pending).toEqual([]);
    const doc = await current.doc();
    expect(doc.checks['scheduler.preview-activity']).toMatchObject({ status: 'pass', observedValue: 0 });
    const { monitors, rejected } = discoverMonitors(doc, selfCheckUrl(7000));
    expect(rejected).toEqual([]);
    expect(monitors.find(row => row.componentId === 'scheduler.preview-activity'))
      .toMatchObject({ intervalSeconds: 21600, failuresToAlarm: 1, severity: 'P1', environment: 'production' });
  });

  it.each(['uninitialized', 'throw', 'null'] as const)('事件历史%s不可读不能补0或判绿', async kind => {
    const f = await fixture(); f.setAvailable(true); const current = f.create();
    if (kind === 'uninitialized') f.setReadable(false);
    if (kind === 'throw') f.store.findRecent = async () => { throw new Error('不得输出的内部异常'); };
    if (kind === 'null') f.store.findRecent = async () => null as unknown as ServerEventRecord[];
    const doc = await current.doc();
    expect(doc.checks['scheduler.preview-activity']).toMatchObject({ status: 'fail', observedValue: null });
    expect(JSON.stringify(doc)).not.toContain('不得输出的内部异常');
  });

  it('调度禁用时自检仍真读活动源，但通知不假称已暂停自动停机', async () => {
    const f = await fixture(); const current = f.create();
    current.scheduler.setEnabled(false);
    const check = (await current.doc()).checks['scheduler.preview-activity'];
    expect(check).toMatchObject({ status: 'fail', observedValue: 1 });
    expect(check.publicMessage).toContain('自动停机当前未启用');
    expect(check.publicMessage).not.toContain('已暂停');
    expect(f.pending.map(event => event.action)).toEqual(['unknown']);
  });

  it('实际index在原init成功后确认日志可读，并将原sink与新依赖接到自检', () => {
    const index = fs.readFileSync(path.resolve(import.meta.dirname, '../../src/index.ts'), 'utf8');
    expect(index.indexOf('localServerEventLogReady = true')).toBeGreaterThan(index.indexOf('await localServerEventLogStore.init()'));
    expect(index).toContain('wireSchedulerPreviewActivitySelfCheck(schedulerService, activeServerEventLogStore, () => localServerEventLogReady)');
    expect(index).toContain('...(previewActivitySelfCheck ? { previewActivity: previewActivitySelfCheck } : {})');
  });
});
