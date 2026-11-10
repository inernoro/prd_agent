import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { NOTIFICATION_TEMPLATES, renderNotification, matchesClassification, notificationEnvironment, parseReportClassification,
  renderNotificationDigest, type NotificationFacts, type ReportClassification } from '../../src/shared/notification-templates.js';
import { NotificationReportRecorder } from '../../src/services/notification-report.js';
import { StateService } from '../../src/services/state.js';
import { renderAlarmMessage, type AlarmEvent } from '../../src/services/alarm-route.js';
import { buildNotificationPayload } from '../../src/services/map-notifier.js';
import { sendAlarm } from '../../src/services/alarm-dispatch.js';
import { flushAllJsonStateStores } from '../../src/infra/state-store/json-backing-store.js';
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-notification-'));
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));
afterEach(async () => { vi.restoreAllMocks(); await flushAllJsonStateStores(); });
const facts: NotificationFacts = { environment: 'production', system: 'map', function: '生图', provider: 'OpenAI', window: '5分钟', count: 3,
  modelCount: 20, version: 'v1', total: 22, failed: 2, blocked: 1, task: '视频', waitingFor: '素材', shortTitle: '分享问答', documentType: '方案', resource: '证书', days: 7, channel: 'Bark' };
const c: ReportClassification = { categories: ['result', 'upstream', 'billing'], primarySystem: 'map', relatedSystems: ['llmgw'], environments: ['production', 'test'] };
const event: AlarmEvent = { notificationFacts: { environment: 'test', system: 'map', function: '问答' }, kind: 'business-down', projectId: 'fixture', targetId: 'fixture-check', targetName: '问答检查',
  message: 'HTTP 500 sk-private-must-not-be-pushed', detectedAt: '2026-11-11T01:00:00.000Z', consecutiveFailures: 3 };

describe('通知交叉分类与唯一模板目录', () => {
  it('30 个模板均产生一句完整短事实，非截断原始日志', () => {
    expect(Object.keys(NOTIFICATION_TEMPLATES)).toHaveLength(30);
    for (const id of Object.keys(NOTIFICATION_TEMPLATES) as Array<keyof typeof NOTIFICATION_TEMPLATES>) {
      const text = renderNotification(id, { ...facts, system: id === 'GW-06' || id === 'GW-07' ? 'llmgw' : facts.system }).sentence;
      expect(Array.from(text).length, id).toBeLessThanOrEqual(40);
      expect(text, id).not.toMatch(/\{|\}|\n|点击|管理员|HTTP|token/);
    }
    expect(renderNotification('TASK-02', facts).sentence).toBe('正式 MAP 生图 OpenAI 5分钟失败3次');
  });
  it('缺少窗口不捏造5分钟，缺少次数、未知枚举、零次数、地址或密钥均拒绝', () => {
    expect(renderNotification('TASK-02', { ...facts, window: undefined }).sentence).not.toContain('5分钟');
    for (const patch of [{ count: undefined }, { count: 0 }, { count: -1 }, { count: 1.2 }, { provider: 'https://private.invalid' }, { function: 'sk-secret' }]) expect(() => renderNotification('TASK-02', { ...facts, ...patch })).toThrow();
    expect(() => renderNotification('MON-01', { ...facts, environment: 'invented' } as unknown as NotificationFacts)).toThrow();
    expect(notificationEnvironment({ declared: 'production', previewBound: true })).toBe('preview');
    expect(notificationEnvironment({})).toBe('unknown');
    expect(notificationEnvironment({ declared: '生产' })).toBe('production');
  });
  it('同维度OR、不同维度AND、关联系统可查，未知不冒充正式', () => {
    expect(matchesClassification(c, { categories: ['billing', 'upstream'], systems: ['llmgw'], environments: ['test'] })).toBe(true);
    expect(matchesClassification(c, { categories: ['release'], systems: ['map'] })).toBe(false);
    expect(matchesClassification(undefined, { environments: ['production'] })).toBe(false);
    expect(matchesClassification(undefined, { environments: ['unknown'], systems: ['unknown'] })).toBe(true);
    expect(parseReportClassification({ ...c, categories: ['billing', 'billing'] }).categories).toEqual(['billing']);
    expect(() => parseReportClassification({ ...c, environments: [] })).toThrow();
  });
  it('监控采集失败主体为CDS、业务状态未知，真实业务故障仍为MAP', () => {
    const unknown = renderAlarmMessage({ ...event, assessment: 'observation-unavailable' });
    expect(unknown.title).toBe('测试 CDS'); expect(unknown.body).toBe('监控读取失败，MAP状态未知');
    expect(renderAlarmMessage(event).title).toBe('测试 MAP');
    expect(JSON.stringify(renderAlarmMessage(event))).not.toMatch(/sk-private|HTTP 500/);
    expect(renderAlarmMessage({ ...event, targetName: 'sk-token', notificationFacts: undefined }).body).toBe('监控检查异常，原因未明');
    expect(renderAlarmMessage({ ...event, kind: 'business-recovered', assessment: 'observation-unavailable' }).body).toBe('监控读取已恢复');
    expect(renderAlarmMessage({ ...event, notificationFacts: undefined }).title).toBe('环境待确认 系统待确认');
    const grouped = renderAlarmMessage({ ...event, notificationFacts: undefined, environmentLabel: '生产', identity: { observer: { id: 'observer', name: 'CDS', environment: '生产' }, subject: { id: 'subject', name: 'MAP', environment: '生产' } } });
    expect(grouped.group).toContain('环境待确认');
    expect(grouped.group).not.toContain('生产');
  });
  it('多环境摘要保持短句，不将测试与正式的变化合为正式故障', () => {
    expect(renderNotificationDigest([facts, { ...facts, environment: 'test', system: 'cds' }], 3)).toEqual({ title: '多环境 多系统', body: '新增3项消息' });
  });
  it('Bark和MAP都使用同一模板及对应报告链接', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{"code":200}', { status: 200 }));
    const url = 'https://sample.invalid/reports?report=fixture';
    const result = await sendAlarm({ id: 't', name: 't', enabled: true, kind: 'bark', bark: { key: 'fixture-only' }, events: ['business-down'], projects: [], createdAt: 0, updatedAt: 0 }, event, { boardUrl: url });
    expect(result.ok).toBe(true);
    const request = new URL(String(fetch.mock.calls[0][0]));
    expect(decodeURIComponent(request.pathname)).toBe('/fixture-only/测试 MAP/问答检查异常，原因未明');
    expect(request.searchParams.get('url')).toBe(url);
    const map = buildNotificationPayload({ ...event, targetId: event.targetId!, type: 'uptime.target.down', boardUrl: url });
    expect(map.title + ' ' + map.message).toBe('测试 MAP 问答检查异常，原因未明'); expect(map.actionUrl).toBe(url);
  });
  it('同一事件并发回调只归档一次，恢复追加原报告并可持久化重读', async () => {
    const state = new StateService(path.join(dir, crypto.randomUUID() + '.json'), dir); state.load();
    const recorder = new NotificationReportRecorder(state);
    const [a, b] = await Promise.all([recorder.record(event), recorder.record(event)]);
    expect(a).toEqual(b);
    const up = await recorder.record({ ...event, kind: 'business-recovered', detectedAt: '2026-11-11T01:05:00.000Z', consecutiveFailures: 0 });
    expect(up).toEqual(a);
    const report = state.getAcceptanceReport(a.reportId)!;
    expect(report.monitorEvent!.snapshots).toHaveLength(2);
    expect(report.monitorEvent!.state).toBe('recovered');
    const content = await state.readAcceptanceReportContentAsync(report.id);
    expect(content).toContain('检查异常'); expect(content).toContain('已恢复'); expect(content).toContain('连续失败检查 3 次');
    expect(content).not.toContain('sk-private');
    expect(state.listAcceptanceReports(null).filter(r => r.sourceId === `monitor:${a.eventId}`)).toHaveLength(1);
  });
  it('稳定恢复前的反复异常及冷却重报追加同一报告，稳定恢复后才开始新事件', async () => {
    const state = new StateService(path.join(dir, crypto.randomUUID() + '.json'), dir); state.load();
    const recorder = new NotificationReportRecorder(state);
    const first = await recorder.record({ ...event, incidentId: 'first-probe-incident' });
    const repeated = await recorder.record({ ...event, incidentId: 'flapping-probe-incident', detectedAt: '2026-11-11T01:30:00.000Z' });
    expect(repeated).toEqual(first);
    expect(state.listAcceptanceReports(null)).toHaveLength(1);
    expect(state.getAcceptanceReport(first.reportId)!.monitorEvent!.snapshots).toHaveLength(2);
    const recovered = await recorder.record({ ...event, kind: 'business-recovered', detectedAt: '2026-11-11T01:45:00.000Z' });
    expect(recovered).toEqual(first);
    expect(state.getAcceptanceReport(first.reportId)!.monitorEvent!.snapshots).toHaveLength(3);
    const next = await recorder.record({ ...event, detectedAt: '2026-11-11T02:00:00.000Z' });
    expect(next.reportId).not.toBe(first.reportId);
    expect(state.listAcceptanceReports(null)).toHaveLength(2);
  });

});
