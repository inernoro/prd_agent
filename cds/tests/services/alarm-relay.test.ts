import { it, expect, vi } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AlarmRelay } from '../../src/services/alarm-relay.js';
import type { AlarmChannelConfig, AlarmEvent } from '../../src/services/alarm-route.js';

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

async function retiredChannelFixture() {
  const { default: express } = await import('express');
  const { registerAlarmRelayRoutes } = await import('../../src/services/alarm-relay.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'alarm-relay-retire-'));
  const file = path.join(dir, 'relay.json');
  const relay = new AlarmRelay(file);
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const channels = ['phone', 'other'].map(id => ({ id, name: id, enabled: true, kind: 'bark', bark: { key: 'fixture-only' } }) as AlarmChannelConfig);
  const acknowledged = vi.fn(async () => undefined);
  const deps = { channels: () => channels, acknowledged };
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
  return { relay, file, channels, acknowledged, decrypt, proof, event, phoneId,
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
      ok: false, reason: '通知通道已停用或删除，本次投递已取消',
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
