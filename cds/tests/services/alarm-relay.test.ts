import { it, expect, vi } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { AlarmRelay } from '../../src/services/alarm-relay.js';
import { AlarmLedger } from '../../src/services/alarm-channel.js';
import { withAlarmDeliveryHistory } from '../../src/services/alarm-delivery-history.js';
import type { AlarmChannelConfig, AlarmEvent, MonitorNotificationSettings } from '../../src/services/alarm-route.js';

it('只有持有私钥的接收端可获得投递配置；确认就绪后主站让出所有权，重启保留待投递事件', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'alarm-relay-'));
  const file = path.join(dir, 'relay.json');
  try {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    let relay = new AlarmRelay(file);
    relay.configure(publicKey.export({ type: 'spki', format: 'pem' }).toString(), ['phone']);
    expect(() => relay.activate(true)).toThrow('尚未解密');
    const channel = { id: 'phone', name: '测试', enabled: true, kind: 'bark', bark: { key: 'private-fixture' } } as AlarmChannelConfig;
    const sealed = relay.envelope([channel]);
    expect(JSON.stringify(sealed)).not.toContain('private-fixture');
    expect(JSON.stringify(relay.status())).not.toContain('private-fixture');
    const key = crypto.privateDecrypt({ key: privateKey, oaepHash: 'sha256' }, Buffer.from(sealed.key, 'base64'));
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(sealed.iv, 'base64'));
    decipher.setAuthTag(Buffer.from(sealed.tag, 'base64'));
    const payload = JSON.parse(Buffer.concat([decipher.update(Buffer.from(sealed.ciphertext, 'base64')), decipher.final()]).toString());
    expect(payload.channels[0].bark.key).toBe('private-fixture');
    relay.confirm(payload.challenge); relay.activate(true);
    expect(relay.owns('phone')).toBe(true); expect(relay.owns('another-phone')).toBe(false);
    const event = { targetId: 'metric', targetName: '图片生成', kind: 'business-down', detectedAt: '2026-10-14T00:00:00Z' } as AlarmEvent;
    const id = relay.enqueue('phone', event); relay.enqueue('phone', event);
    relay = new AlarmRelay(file);
    expect(relay.status().pending).toBe(1); expect(relay.owns('phone')).toBe(true);
    expect(() => relay.activate(false)).toThrow('待投递');
    expect(relay.acknowledge(id)?.event.targetId).toBe('metric');
    expect(relay.acknowledge(id)).toBeUndefined();
    expect(fs.statSync(file).mode & 0o077).toBe(0);
    relay.activate(false); expect(relay.owns('phone')).toBe(false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

it('系统接口拒绝项目凭据和错误回执，不提供明文通道秘密', async () => {
  const { default: express } = await import('express');
  const { registerAlarmRelayRoutes } = await import('../../src/services/alarm-relay.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'alarm-relay-api-'));
  const relay = new AlarmRelay(path.join(dir, 'relay.json'));
  const app = express(); app.use(express.json());
  app.use((req, _res, next) => { if (req.headers['x-fixture-project']) (req as unknown as {cdsProjectKey: unknown}).cdsProjectKey = {}; next(); });
  const router = express.Router();
  registerAlarmRelayRoutes(router, relay, { channels: () => [], acknowledged: async () => undefined });
  app.use('/api', router);
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(r => server.once('listening', r));
  const base = `http://127.0.0.1:${(server.address() as {port: number}).port}/api/cds-system/alarm-relay`;
  try {
    expect((await fetch(base, { headers: { 'x-fixture-project': 'yes' } })).status).toBe(403);
    expect((await fetch(base + '/poll', { method: 'POST', headers: { 'content-type': 'application/json', 'x-fixture-project': 'yes' }, body: '{}' })).status).toBe(403);
    const wrong = await fetch(base + '/poll', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ proof: 'wrong', acks: [{ id: 'test', ok: true }] }) });
    expect(wrong.status).toBe(400); expect(relay.status().readyAt).toBe(0);
    const status = await fetch(base); expect(status.headers.get('cache-control')).toBe('no-store');
    expect(await status.json()).toMatchObject({ enabled: false, pending: 0 });
  } finally { server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); fs.rmSync(dir, {recursive: true, force:true}); }
});

async function retiredChannelFixture(withNotifications = false) {
  const { default: express } = await import('express');
  const { registerAlarmRelayRoutes } = await import('../../src/services/alarm-relay.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'alarm-relay-retire-'));
  const file = path.join(dir, 'relay.json');
  const relay = new AlarmRelay(file);
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const channels = ['phone', 'other'].map(id => ({ id, name: id, enabled: true, kind: 'bark', bark: { key: 'fixture-only' } }) as AlarmChannelConfig);
  const acknowledged = vi.fn(async (_item: unknown, _result: { ok: boolean; reason?: string; merged?: boolean; cancelled?: boolean }) => undefined);
  const notifications = { current: {} as MonitorNotificationSettings };
  const deps = { channels: () => channels, acknowledged,
    ...(withNotifications ? { getNotifications: () => notifications.current } : {}) };
  const decrypt = (sealed: ReturnType<AlarmRelay['envelope']>) => {
    const key = crypto.privateDecrypt({ key: privateKey, oaepHash: 'sha256' }, Buffer.from(sealed.key, 'base64'));
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(sealed.iv, 'base64'));
    decipher.setAuthTag(Buffer.from(sealed.tag, 'base64'));
    return JSON.parse(Buffer.concat([decipher.update(Buffer.from(sealed.ciphertext, 'base64')), decipher.final()]).toString());
  };
  relay.configure(publicKey.export({ type: 'spki', format: 'pem' }).toString(), ['phone', 'other']);
  const proof = decrypt(relay.envelope(channels)).challenge;
  relay.confirm(proof); relay.activate(true);
  const event = { targetId: 'metric', targetName: '图片生成', kind: 'business-down', detectedAt: '2026-10-19T00:00:00Z' } as AlarmEvent;
  const phoneId = relay.enqueue('phone', event);
  const app = express(); app.use(express.json());
  registerAlarmRelayRoutes(app, relay, deps);
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(r => server.once('listening', r));
  const base = `http://127.0.0.1:${(server.address() as {port: number}).port}/cds-system/alarm-relay`;
  return { relay, file, channels, acknowledged, decrypt, proof, event, phoneId, notifications,
    request: (suffix: string, method: string, body: unknown) => fetch(base + suffix, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
    close: async () => { server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); fs.rmSync(dir, {recursive: true, force: true}); },
  };
}

it.each(['停用', '删除'])('%s通道后取消孤立待投递项，保留其它故障并可正常交回所有权', async mode => {
  const f = await retiredChannelFixture();
  try {
    const otherId = f.relay.enqueue('other', f.event);
    if (mode === '停用') f.channels[0].enabled = false;
    else f.channels.splice(0, 1);
    const response = await f.request('/poll', 'POST', { proof: f.proof });
    expect(response.status).toBe(200);
    const payload = f.decrypt(await response.json());
    expect(payload.items.map((item: {id: string}) => item.id)).toEqual([otherId]);
    expect(f.acknowledged).toHaveBeenCalledWith(expect.objectContaining({ id: f.phoneId }), {
      ok: false, cancelled: true, reason: '通知通道已停用或删除，本次投递已取消',
    });
    expect(new AlarmRelay(f.file).status().pending).toBe(1);
    expect(() => f.relay.activate(false)).toThrow('待投递');
    expect((await f.request('/poll', 'POST', { proof: f.proof, acks: [{ id: otherId, ok: true }] })).status).toBe(200);
    expect((await f.request('', 'PUT', { enabled: false })).status).toBe(200);
    expect(new AlarmRelay(f.file).status()).toMatchObject({ enabled: false, pending: 0 });
  } finally { await f.close(); }
});

it('接收端离线也能交回已停用通道；取消记录失败时保留队列供重试', async () => {
  const f = await retiredChannelFixture();
  try {
    f.channels.length = 0;
    f.acknowledged.mockRejectedValueOnce(new Error('fixture history unavailable'));
    expect((await f.request('', 'PUT', { enabled: false })).status).toBe(400);
    expect(new AlarmRelay(f.file).status()).toMatchObject({ enabled: true, pending: 1 });
    expect((await f.request('', 'PUT', { enabled: false })).status).toBe(200);
    expect(new AlarmRelay(f.file).status()).toMatchObject({ enabled: false, pending: 0 });
    expect(f.acknowledged).toHaveBeenLastCalledWith(expect.objectContaining({ id: f.phoneId }), expect.objectContaining({ ok: false }));
  } finally { await f.close(); }
});


it.each(['静默', '逐项目标覆盖', '默认通道移除'])('%s后不再导出主站仍排队的事件，取消不计送达且同通道其他目标保留', async mode => {
  const f = await retiredChannelFixture(true);
  try {
    const keepTarget = 'keep-metric';
    const keepId = f.relay.enqueue('phone', { ...f.event, targetId: keepTarget });
    if (mode === '静默') f.notifications.current = { mutedUntil: { metric: Date.now() + 60000 } };
    else if (mode === '逐项目标覆盖') f.notifications.current = { overrides: { metric: ['other'] } };
    else f.notifications.current = { defaultChannelIds: ['other'], overrides: { [keepTarget]: ['phone'] } };
    const response = await f.request('/poll', 'POST', { proof: f.proof });
    expect(response.status).toBe(200);
    const payload = f.decrypt(await response.json());
    expect(payload.items.map((item: { id: string }) => item.id)).toEqual([keepId]);
    expect(f.acknowledged).toHaveBeenCalledWith(expect.objectContaining({ id: f.phoneId }), { ok: false, cancelled: true, reason: expect.stringContaining('取消') });
    expect(f.acknowledged.mock.calls.every(call => (call as unknown as [unknown, { ok: boolean }])[1].ok === false)).toBe(true);
    const reloaded = new AlarmRelay(f.file);
    expect(reloaded.getItem(f.phoneId)).toBeUndefined(); expect(reloaded.getItem(keepId)).toBeDefined();
  } finally { await f.close(); }
});

it.each([false, true])('未提供通知getter或默认未设置时保持已有排队行为（getter=%s）', async withGetter => {
  const f = await retiredChannelFixture(withGetter);
  try {
    const response = await f.request('/poll', 'POST', { proof: f.proof });
    expect(response.status).toBe(200);
    expect(f.decrypt(await response.json()).items.map((item: { id: string }) => item.id)).toEqual([f.phoneId]);
    expect(f.acknowledged).not.toHaveBeenCalled();
  } finally { await f.close(); }
});

it.each(['停用', '删除'])('演练只豁免新增目标策略，不豁免通道%s', async mode => {
  const f = await retiredChannelFixture(true);
  try {
    const drillId = f.relay.enqueue('phone', { ...f.event, drill: true, detectedAt: '2026-10-19T00:01:00Z' });
    f.notifications.current = { defaultChannelIds: [], overrides: { metric: [] }, mutedUntil: { metric: Date.now() + 60000 } };
    const response = await f.request('/poll', 'POST', { proof: f.proof });
    expect(response.status).toBe(200);
    const payload = f.decrypt(await response.json());
    expect(payload.items.map((item: { id: string }) => item.id)).toEqual([drillId]);
    expect(payload.items[0].event.drill).toBe(true);
    expect(f.acknowledged).not.toHaveBeenCalledWith(expect.objectContaining({ id: drillId }), expect.anything());
    if (mode === '停用') f.channels[0].enabled = false;
    else f.channels.splice(0, 1);
    const disabled = await f.request('/poll', 'POST', { proof: f.proof });
    expect(disabled.status).toBe(200); expect(f.decrypt(await disabled.json()).items).toEqual([]);
    expect(f.acknowledged).toHaveBeenCalledWith(expect.objectContaining({ id: drillId }), { ok: false, cancelled: true, reason: '通知通道已停用或删除，本次投递已取消' });
    expect(new AlarmRelay(f.file).status().pending).toBe(0);
  } finally { await f.close(); }
});

it('目标策略取消记账失败时不丢队列或导出该项，重试成功后才移除', async () => {
  const f = await retiredChannelFixture(true);
  try {
    const keepId = f.relay.enqueue('phone', { ...f.event, targetId: 'keep-metric' });
    f.notifications.current = { mutedUntil: { metric: Date.now() + 60000 } };
    f.acknowledged.mockRejectedValueOnce(new Error('fixture history unavailable'));
    expect((await f.request('/poll', 'POST', { proof: f.proof })).status).toBe(400);
    expect(new AlarmRelay(f.file).status().pending).toBe(2);
    // The same export guard also protects a direct envelope read while the
    // failed cancellation remains queued; no receiver/protocol change is needed.
    expect(f.decrypt(f.relay.envelope(f.channels, f.notifications.current)).items.map((item: { id: string }) => item.id)).toEqual([keepId]);
    const retry = await f.request('/poll', 'POST', { proof: f.proof });
    expect(retry.status).toBe(200);
    expect(f.decrypt(await retry.json()).items.map((item: { id: string }) => item.id)).toEqual([keepId]);
    expect(new AlarmRelay(f.file).status().pending).toBe(1);
    expect(f.acknowledged).toHaveBeenLastCalledWith(expect.objectContaining({ id: f.phoneId }), { ok: false, cancelled: true, reason: expect.stringContaining('取消') });
  } finally { await f.close(); }
});

it('真实应用取消回调保留通道健康和冷读状态，真正投递失败仍记录失败', async () => {
  const f = await retiredChannelFixture(true);
  try {
    const source = fs.readFileSync(fileURLToPath(new URL('../../src/index.ts', import.meta.url)), 'utf8');
    const ast = ts.createSourceFile('index.ts', source, ts.ScriptTarget.Latest, true);
    let handler: ts.ArrowFunction | undefined;
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'registerAlarmRelayRoutes') {
        const options = node.arguments[2];
        if (options && ts.isObjectLiteralExpression(options)) {
          const property = options.properties.find(p => ts.isPropertyAssignment(p) && p.name.getText(ast) === 'acknowledged');
          if (property && ts.isPropertyAssignment(property) && ts.isArrowFunction(property.initializer)) handler = property.initializer;
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(ast);
    expect(handler, '执行应用真实注册回调，而不是另写一份策略').toBeDefined();
    const records: Array<{ status: string; details?: { reason?: string } }> = [];
    for (const channel of f.channels) { channel.events = ['business-down']; channel.projects = []; }
    const ledger = new AlarmLedger({ persist: (id, last) => {
      const channel = f.channels.find(c => c.id === id);
      if (channel) channel.lastDelivery = last;
    } });
    const markAlarmDelivered = vi.fn(async () => undefined);
    const callback = new Function('alarmLedger', 'activeServerEventLogStore', 'stateService', 'withAlarmDeliveryHistory', 'uptimeMonitor', `return (${handler!.getText(ast)})`)(
      ledger, { record: (row: typeof records[number]) => records.push(row) },
      { listAlarmChannels: () => f.channels }, withAlarmDeliveryHistory, { markAlarmDelivered },
    );
    f.acknowledged.mockImplementation(callback);
    ledger.record('phone', { ok: true, status: 200 }, 'drill', 123);
    const previous = ledger.view(f.channels[0], true);
    f.notifications.current = { mutedUntil: { metric: Date.now() + 60_000 } };
    expect((await f.request('/poll', 'POST', { proof: f.proof })).status).toBe(200);
    expect(ledger.view(f.channels[0], true)).toEqual(previous);
    expect(new AlarmLedger().view(f.channels[0], true).status).toBe('healthy');
    expect(records.some(row => row.status === 'failed' && row.details?.reason?.includes('取消'))).toBe(true);
    expect(markAlarmDelivered).not.toHaveBeenCalled();
    const actualId = f.relay.enqueue('phone', { ...f.event, targetId: 'another-service' });
    // 接收端无权把真实失败伪装成本机策略取消；此字段不能通过回执透传。
    expect((await f.request('/poll', 'POST', { proof: f.proof, acks: [{ id: actualId, ok: false, cancelled: true }] })).status).toBe(200);
    expect(ledger.view(f.channels[0], true)).toMatchObject({ status: 'failing', failed: 1 });
    expect(new AlarmLedger().view(f.channels[0], true).status).toBe('failing');
  } finally { await f.close(); }
});
