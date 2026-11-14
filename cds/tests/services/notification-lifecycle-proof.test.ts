import { afterAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { NotificationReportRecorder } from '../../src/services/notification-report.js';
import { StateService } from '../../src/services/state.js';
import { flushAllJsonStateStores } from '../../src/infra/state-store/json-backing-store.js';
import { buildNotificationPayload } from '../../src/services/map-notifier.js';
import { decideSelfMonitorAlarm, SELF_ALARM_RECOVERY_MS, type SelfMonitorAlarmState } from '../../src/services/self-monitor-alarm-policy.js';
import { UptimeMonitorService } from '../../src/services/uptime-monitor.js';
import type { BranchEntry } from '../../src/types.js';
import type { AlarmEvent } from '../../src/services/alarm-route.js';
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-notification-proof-'));
afterAll(async () => { await flushAllJsonStateStores(); fs.rmSync(dir, { recursive: true, force: true }); });
const event: AlarmEvent = { kind: 'business-down', projectId: 'fixture', targetId: 'monitor@fixture', targetName: '问答',
  assessment: 'check-failed', message: '原始诊断 sk-private', detectedAt: '2026-11-13T01:00:00.000Z', consecutiveFailures: 3,
  notificationFacts: { environment: 'production', system: 'map', function: '问答' } };
function recorder() { const state = new StateService(path.join(dir, crypto.randomUUID() + '.json'), dir); state.load(); return { state, recorder: new NotificationReportRecorder(state) }; }

describe('通知故障身份和生命周期差分证明', () => {
  it('同目标采集失败与真实业务失败分开归档，采集恢复不会关闭业务故障', async () => {
    const { state, recorder: r } = recorder();
    const business = await r.record(event);
    const collection = await r.record({ ...event, assessment: 'observation-unavailable', detectedAt: '2026-11-13T01:01:00Z' });
    expect(collection.reportId).not.toBe(business.reportId);
    await r.record({ ...event, assessment: 'observation-unavailable', kind: 'business-recovered', detectedAt: '2026-11-13T01:12:00Z' });
    expect(state.getAcceptanceReport(business.reportId)!.monitorEvent!.state).toBe('open');
    expect(state.getAcceptanceReport(collection.reportId)!.monitorEvent!.state).toBe('recovered');
  });
  it('两个观察实例监控同一目标也不是同一故障', async () => {
    const { recorder: r } = recorder();
    const subject = { id: 'subject', name: 'MAP', environment: '正式' };
    const a = await r.record({ ...event, identity: { subject, observer: { ...subject, id: 'observer-a' } } });
    const b = await r.record({ ...event, identity: { subject, observer: { ...subject, id: 'observer-b' } } });
    expect(a.reportId).not.toBe(b.reportId);
  });
  it('旧恢复延迟重投不得关闭更晚复发的新故障', async () => {
    const { state, recorder: r } = recorder();
    const first = await r.record(event);
    await r.record({ ...event, kind: 'business-recovered', detectedAt: '2026-11-13T01:11:00Z' });
    const recurrence = await r.record({ ...event, detectedAt: '2026-11-13T01:12:00Z' });
    await r.record({ ...event, kind: 'business-recovered', detectedAt: '2026-11-13T01:10:59Z' });
    expect(recurrence.reportId).not.toBe(first.reportId);
    expect(state.getAcceptanceReport(recurrence.reportId)!.monitorEvent!.state).toBe('open');
  });
  it('已稳定恢复后的新严重故障不被30分钟冷却吞掉，未稳定抖动继续合并', () => {
    const state: SelfMonitorAlarmState = {};
    expect(decideSelfMonitorAlarm(state, { at: 0, up: false, down: true, intervalMs: 60_000 })).toEqual({ emit: 'down' });
    expect(decideSelfMonitorAlarm(state, { at: 1, up: false, down: true, intervalMs: 60_000 })).toEqual({ reason: 'same-incident' });
    for (let at = 60_000; at <= SELF_ALARM_RECOVERY_MS + 60_000; at += 60_000) decideSelfMonitorAlarm(state, { at, up: true, down: false, intervalMs: 60_000 });
    expect(state.reportOpen).toBe(false);
    expect(decideSelfMonitorAlarm(state, { at: SELF_ALARM_RECOVERY_MS + 120_000, up: false, down: true, intervalMs: 60_000, urgent: true } as Parameters<typeof decideSelfMonitorAlarm>[1])).toEqual({ emit: 'down' });
  });
  it('基础设施首次检查成功不伪造恢复，只有先失败再通过才发送恢复', async () => {
    let up = true;
    const seen: string[] = [];
    const branch = { id: 'fixture-branch', projectId: 'fixture', branch: 'main', status: 'running', services: { web: { profileId: 'web', containerName: 'fixture-only', hostPort: 10001, status: 'running' } } } as unknown as BranchEntry;
    const monitor = new UptimeMonitorService({ state: { getAllBranches: () => [branch] },
      config: { enabled: true, intervalMs: 60000, timeoutMs: 1000, failureThreshold: 1, recoveryThreshold: 1, maxSamples: 20, excludePatterns: [], scope: 'all', userViewEnabled: false },
      probe: async () => ({ up, ms: 1 }), onAlert: type => { seen.push(type); } });
    try {
      await monitor.probeNow('fixture-branch::web'); expect(seen).toEqual([]);
      up = false; await monitor.probeNow('fixture-branch::web');
      up = true; await monitor.probeNow('fixture-branch::web');
      expect(seen).toEqual(['uptime.target.down', 'uptime.target.recovered']);
    } finally { await monitor.stop(); }
  });
  it('站内通知保留长服务名称的主体，不让凭据或地址进入标题', () => {
    const name = 'CDS · Webhook 派发与处理服务';
    const notice = buildNotificationPayload({ ...event, targetId: event.targetId!, targetName: name, type: 'uptime.target.down' });
    expect(notice.title.startsWith(name)).toBe(true);
    const unsafe = buildNotificationPayload({ ...event, targetId: event.targetId!, targetName: 'Bearer sk-must-not-leak', type: 'uptime.target.down' });
    expect(JSON.stringify(unsafe)).not.toMatch(/Bearer|sk-must-not-leak/);
  });
  it('转发保留归档事件身份和发生时间；恢复更新同一项，不把检查数当请求失败数', () => {
    const facts = { ...event, eventId: 'stable-report-event', firstOccurredAt: event.detectedAt, lastOccurredAt: event.detectedAt, occurrenceCount: 2,
      type: 'uptime.target.down' as const, targetId: event.targetId! };
    const down = buildNotificationPayload(facts);
    const recovered = buildNotificationPayload({ ...facts, type: 'uptime.target.recovered', detectedAt: '2026-11-13T01:20:00Z' });
    expect(recovered.dedupKey).toBe(down.dedupKey);
    expect(down).toMatchObject({ incidentState: 'active', firstOccurredAt: event.detectedAt, lastOccurredAt: event.detectedAt, occurrenceCount: 2, requestOutcome: 'unknown' });
    expect(recovered).toMatchObject({ incidentId: down.incidentId, incidentState: 'recovered', lastOccurredAt: event.detectedAt, recoveredAt: '2026-11-13T01:20:00Z' });
    expect(buildNotificationPayload({ ...facts, lastOccurredAt: undefined, type: 'uptime.target.recovered', detectedAt: '2026-11-13T01:20:00Z' }).incidentState).toBeUndefined();
  });
});
