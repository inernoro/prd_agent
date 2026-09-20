import { afterEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { summarizeAlarmDeliveries } from '../../src/services/alarm-delivery-history.js';
import { sendAlarm } from '../../src/services/alarm-dispatch.js';
import { AlarmLedger } from '../../src/services/alarm-channel.js';
import { registerAlarmChannelRoutes } from '../../src/routes/alarm-channels.js';
import type { ServerEventLogSink, ServerEventRecord } from '../../src/services/server-event-log-store.js';
import type { AlarmChannelConfig, AlarmEvent } from '../../src/services/alarm-route.js';

const event: AlarmEvent = {
  kind: 'business-down', projectId: 'cds-self-monitor', targetId: 'p95', targetName: '首屏接口 P95',
  message: '指标暂无样本', detectedAt: new Date().toISOString(), consecutiveFailures: 3,
};
const channel: AlarmChannelConfig = {
  id: 'phone', name: '我的手机', kind: 'bark', enabled: true, events: ['business-down'], projects: [],
  bark: { key: 'do-not-log-device-key' }, createdAt: 1, updatedAt: 1,
};
function journal() {
  const events: ServerEventRecord[] = [];
  const store: ServerEventLogSink = {
    record: vi.fn(),
    recordImmediate: async (row) => { events.unshift({ ...row, _id: String(events.length), ts: new Date() }); },
    findRecent: async () => events,
  };
  return { store, events };
}
let server: http.Server | undefined;
afterEach(async () => {
  vi.unstubAllGlobals(); vi.restoreAllMocks();
  if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
  server = undefined;
});
async function query(store?: ServerEventLogSink, scope = '', suffix = '') {
  const app = express();
  app.use((req, _res, next) => { if (scope) (req as any).cdsProjectKey = { projectId: scope }; next(); });
  const router = express.Router();
  registerAlarmChannelRoutes(router, { list: () => [channel], upsert: () => {}, remove: () => false, ledger: new AlarmLedger(), history: store });
  app.use('/api', router);
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server!.once('listening', resolve));
  return new Promise<{ status: number; data: any }>((resolve, reject) => {
    http.get(`http://127.0.0.1:${(server!.address() as any).port}/api/cds-system/alarm-deliveries${suffix}`, (res) => {
      let body = ''; res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode!, data: JSON.parse(body) }));
    }).on('error', reject);
  });
}

describe('通知逐次发送历史', () => {
  it('真实发送入口先记准备发送，再记结果；查询不会把两条日志算成两次通知', async () => {
    const { store, events } = journal();
    const transport = vi.fn(async () => {
      expect(events[0].status).toBe('started');
      return new Response('', { status: 200 });
    });
    vi.stubGlobal('fetch', transport);
    await sendAlarm(channel, event, { history: store });
    expect(transport).toHaveBeenCalledTimes(1);
    expect(events.map((r) => r.status)).toEqual(['sent', 'started']);
    expect(JSON.stringify(events)).not.toContain(channel.bark!.key);
    // A newly constructed route/ledger reads the persisted sink, not process counters.
    const result = await query(store);
    expect(result.status).toBe(200);
    expect(result.data.summary).toEqual({ total: 1, sent: 1, failed: 0, unknown: 0 });
    expect(result.data.deliveries[0]).toMatchObject({ targetId: 'p95', channelName: '我的手机', title: '首屏接口 P95 指标异常' });
  });
  it('发送失败保留原因，演练与实际告警分开，不追加重试', async () => {
    const { store, events } = journal();
    const transport = vi.fn(async () => new Response('API_KEY=hidden-key https://api.day.app/hidden-device', { status: 500 }));
    vi.stubGlobal('fetch', transport);
    await sendAlarm(channel, event, { history: store, deliveryKind: 'drill' });
    const result = summarizeAlarmDeliveries(events);
    expect(result.summary.total).toBe(0);
    expect(result.drills.failed).toBe(1);
    expect(JSON.stringify(result)).not.toContain('hidden-key');
    expect(JSON.stringify(result)).not.toContain('hidden-device');
    expect(transport).toHaveBeenCalledTimes(1);
  });
  it('记录失败不阻止真实报警，也不将失败原因里的凭据输出到日志', async () => {
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { store } = journal();
    store.recordImmediate = async () => { throw new Error('secret-value'); };
    const transport = vi.fn(async () => new Response('', { status: 200 })); vi.stubGlobal('fetch', transport);
    expect((await sendAlarm(channel, event, { history: store })).ok).toBe(true);
    expect(transport).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(warning.mock.calls)).not.toContain('secret-value');
  });
  it('重启打断后只有开始记录的发送，显示结果未知', () => {
    const result = summarizeAlarmDeliveries([{
      _id: '1', ts: new Date(), category: 'system', severity: 'info', source: 'alarm-delivery',
      action: 'alarm.delivery.started', status: 'started', operationId: 'interrupted',
      details: { kind: 'alert', startedAt: new Date().toISOString(), targetName: '接口' },
    }]);
    expect(result.summary).toEqual({ total: 1, sent: 0, failed: 0, unknown: 1 });
  });
  it('不同翻转、不同通道独立计数，恢复归入自己的事件类型', async () => {
    const { store, events } = journal(); vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 200 })));
    await sendAlarm(channel, event, { history: store });
    await sendAlarm({ ...channel, id: 'second' }, event, { history: store });
    await sendAlarm(channel, { ...event, kind: 'business-recovered' }, { history: store });
    const result = summarizeAlarmDeliveries(events);
    expect(result.summary.sent).toBe(3); expect(result.byTarget).toHaveLength(1);
    expect(result.byChannel).toHaveLength(2); expect(result.byEventKind).toHaveLength(2);
    expect(result.hourly[0].total).toBe(3);
  });
  it('项目 Key 不能读取全实例通知历史', async () => { expect((await query(journal().store, 'other-project')).status).toBe(403); });
  it('未启用记录时返回不可用，不能伪装成零通知', async () => { expect((await query()).status).toBe(503); });
  it('拒绝非法时间范围', async () => { expect((await query(journal().store, '', '?hours=999')).status).toBe(400); });
  it('查询达到存储上限时明确标记部分统计', async () => {
    const { store } = journal(); store.findRecent = async () => Array.from({ length: 1000 }, () => ({ source: 'other' } as ServerEventRecord));
    expect((await query(store)).data.truncated).toBe(true);
  });
  it('线上告警与人工演练都接上同一个持久化记录出口', () => {
    const index = readFileSync(new URL('../../src/index.ts', import.meta.url), 'utf8');
    expect(index).toContain('sendAlarm(channel, event, { boardUrl, history: activeServerEventLogStore })');
    expect(index).toContain('history: activeServerEventLogStore,');
    expect(index).toContain('withAlarmDeliveryHistory(activeServerEventLogStore,');
  });
});

 it('合并决策单列，不能算成实际发送或未知发送', () => {
   const result = summarizeAlarmDeliveries([{ _id: 'p', ts: new Date(), category: 'system', severity: 'info', source: 'alarm-delivery',
     action: 'alarm.suppressed', status: 'suppressed', operationId: 'policy', details: { kind: 'policy', reason: 'no-data' } }]);
   expect(result.summary.total).toBe(0); expect(result.deliveries).toHaveLength(0);
   expect(result.suppressed).toMatchObject([{ status: 'suppressed', reason: 'no-data' }]);
 });
