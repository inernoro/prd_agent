import { afterEach, describe, expect, it } from 'vitest';
import express from 'express';
import http from 'node:http';
import { createHash } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ProxyHandler } from '../../src/forwarder/proxy-handler.js';
import { resolveRoute } from '../../src/forwarder/route-resolver.js';
import { createDiagnosticRouter } from '../../src/forwarder/diagnostic-routes.js';
import { RouteWatcher } from '../../src/forwarder/route-watcher.js';
import { SchedulerService } from '../../src/services/scheduler.js';
import { StateService } from '../../src/services/state.js';
import { probeRequestHeaders, PROBE_MARKER_HEADER, isTrustedProbeFingerprint } from '../../src/services/probe-marker.js';
import { readForwarderPreviewActivity } from '../../src/forwarder/preview-activity.js';
import { flushAllJsonStateStores } from '../../src/infra/state-store/json-backing-store.js';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const stop of cleanup.reverse()) await stop();
  cleanup.length = 0;
  await flushAllJsonStateStores();
});

async function listen(server: http.Server): Promise<number> {
  const sockets = new Set<import('node:net').Socket>();
  server.on('connection', socket => {
    sockets.add(socket); socket.once('close', () => sockets.delete(socket));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  cleanup.push(() => new Promise<void>(resolve => {
    for (const socket of sockets) socket.destroy();
    server.closeAllConnections(); server.close(() => resolve());
  }));
  return (server.address() as AddressInfo).port;
}

function request(port: number, url: string, headers: Record<string, string> = {}, method = 'GET') {
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: url, method, headers }, res => {
      let body = ''; res.setEncoding('utf8'); res.on('data', chunk => { body += chunk; });
      res.once('end', () => resolve({ status: res.statusCode || 0, body }));
    });
    req.once('error', reject); req.end();
  });
}

function upgrade(port: number, url = '/ws', headers: Record<string, string> = {}) {
  return new Promise<{ status: number; headers: http.IncomingHttpHeaders }>((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: url, headers: {
      host: 'file.example.invalid', connection: 'Upgrade', upgrade: 'websocket',
      'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==', 'sec-websocket-version': '13', ...headers,
    } });
    req.once('upgrade', (res, socket) => {
      socket.destroy();
      resolve({ status: res.statusCode || 0, headers: res.headers });
    });
    req.once('response', res => { res.resume(); resolve({ status: res.statusCode || 0, headers: res.headers }); });
    req.once('error', reject); req.end();
  });
}

async function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-preview-activity-'));
  cleanup.unshift(async () => { await flushAllJsonStateStores(); fs.rmSync(root, { recursive: true, force: true }); });
  const state = new StateService(path.join(root, 'state.json')); state.load();
  const now = Date.now();
  for (const [id, age] of [['file', 3 * 3600_000], ['quiet', 3600_000]] as const) {
    state.addBranch({ id, projectId: 'default', branch: `codex/${id}`, status: 'running', heatState: 'hot',
      services: {}, worktreePath: path.join(root, id), createdAt: new Date(now - age).toISOString(),
      lastAccessedAt: new Date(now - age).toISOString() });
  }
  const cooled: string[] = [];
  const scheduler = new SchedulerService(state, { enabled: true, maxHotBranches: 1,
    idleTTLSeconds: 86400, tickIntervalSeconds: 60, pinnedBranches: [] });
  scheduler.setCoolFn(async id => { cooled.push(id); });
  const arrivals: http.IncomingHttpHeaders[] = [];
  let release: (() => void) | undefined;
  let arrived: (() => void) | undefined;
  const waitForArrival = new Promise<void>(resolve => { arrived = resolve; });
  const upstream = http.createServer((req, res) => {
    arrivals.push(req.headers); arrived?.();
    const finish = () => { res.writeHead(200, { 'content-type': 'text/plain' }); res.end('业务响应'); };
    if (req.url === '/api/long-generation') release = finish;
    else finish();
  });
  upstream.on('upgrade', (req, socket) => {
    arrivals.push(req.headers);
    const accept = createHash('sha1').update(`${req.headers['sec-websocket-key']}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
  });
  const upstreamPort = await listen(upstream);
  const logs: string[] = [];
  const proxy = new ProxyHandler({ upstreamTimeoutMs: 5000, masterPassthroughPort: upstreamPort, httpLogStore: {
    record: record => { logs.push(JSON.stringify(record)); },
    beginActive: record => { logs.push(JSON.stringify(record)); return 'active'; },
    completeActive: () => {},
  } });
  cleanup.push(async () => { proxy.destroy(); });
  const watcher = new RouteWatcher({ mongoConnect: async () => { throw new Error('本夹具不读取路由存储'); },
    jsonFallbackPath: '/dev/null', saveSnapshot: false, logger: {} });
  const app = express();
  app.use(createDiagnosticRouter({ watcher, proxy }));
  app.use((req, res) => { void proxy.handle(req, res, req.headers.host === 'file.example.invalid'
    ? { _id: 'file-route', host: 'file.example.invalid', upstreamPort, branchId: 'file',
      profileId: 'api', weight: 100, healthState: 'running' } : null); });
  const server = http.createServer(app);
  server.on('upgrade', (req, socket, head) => {
    const route = resolveRoute([{ _id: 'file-route', host: 'file.example.invalid', upstreamPort,
      branchId: 'file', profileId: 'api', weight: 100, healthState: 'running' }],
    (req.headers.host ?? '').split(':')[0], req.url ?? '/');
    void proxy.handleUpgrade(req, socket as import('node:net').Socket, head, route);
  });
  const port = await listen(server);
  const headers = probeRequestHeaders();
  const marker = headers[PROBE_MARKER_HEADER];
  scheduler.setPreviewActivitySource(() => readForwarderPreviewActivity(port), isTrustedProbeFingerprint, now - 1000);
  return { state, scheduler, cooled, port, headers, marker, proxy, logs, arrivals, waitForArrival,
    release: () => release?.(), access: (url: string, extra: Record<string, string> = {}, method?: string) =>
      request(port, url, { host: 'file.example.invalid', ...extra }, method) };
}

async function growHostStats(port: number): Promise<void> {
  // 真实无路由 HTTP 请求进入 StatsCollector；不修改统计字段或伪造响应体。
  for (let index = 0; index < 300; index++) {
    const result = await request(port, '/unknown', { host: `unknown-${index}.${'a'.repeat(7168)}.invalid` });
    expect(result.status).toBe(503);
  }
  const stats = await request(port, '/__forwarder/stats');
  expect(stats.status).toBe(200);
  expect(Buffer.byteLength(stats.body)).toBeGreaterThan(2 * 1024 * 1024);
  expect(Object.keys(JSON.parse(stats.body).requestsByHost)).toHaveLength(301);
}

describe('真实forwarder访问到master调度时钟', () => {
  it.each(['user', 'forged-probe'] as const)('WS-first %s真实101握手按原路由活动保护FILE', async kind => {
    const f = await fixture();
    const marker = `${f.marker[0] === 'a' ? 'b' : 'a'}${f.marker.slice(1)}`;
    const headers: Record<string, string> = kind === 'forged-probe'
      ? { [PROBE_MARKER_HEADER]: marker, 'x-cds-poll': 'true' } : {};
    const handshake = await upgrade(f.port, '/ws', headers);
    expect(handshake.status).toBe(101);
    expect(handshake.headers['sec-websocket-accept']).toBe('s3pPLMBiTxaQ9kYGzzhZRbK+xOo=');
    expect(f.arrivals).toHaveLength(1);
    expect(f.arrivals[0][PROBE_MARKER_HEADER]).toBeUndefined();
    await f.scheduler.tick();
    expect(f.scheduler.getSnapshot().previewActivity?.status).toBe('ready');
    expect(f.cooled).toEqual(['quiet']);
    const receipt = await request(f.port, '/__forwarder/stats?view=preview-activity');
    const branch = JSON.parse(receipt.body).previewActivity.branches[0];
    expect(branch.branchId).toBe('file');
    const observedAt = kind === 'user' ? branch.userAt : branch.markers[0].at;
    expect(Date.parse(f.state.getBranch('file')!.lastAccessedAt!)).toBe(observedAt);
  });

  it('WS真probe只留指纹，既不续用户时间也不把原令牌转给上游', async () => {
    const f = await fixture();
    const previous = f.state.getBranch('file')!.lastAccessedAt;
    expect((await upgrade(f.port, '/ws', f.headers)).status).toBe(101);
    const receipt = await request(f.port, '/__forwarder/stats?view=preview-activity');
    expect(receipt.body.includes(f.marker)).toBe(false);
    expect(JSON.parse(receipt.body).previewActivity.branches).toEqual([{ branchId: 'file',
      markers: [{ fingerprint: expect.any(String), at: expect.any(Number) }] }]);
    expect(f.arrivals).toHaveLength(1);
    expect(f.arrivals[0][PROBE_MARKER_HEADER]).toBeUndefined();
    await f.scheduler.tick();
    expect(f.cooled).toEqual(['file']);
    expect(f.state.getBranch('file')!.lastAccessedAt).toBe(previous);
  });

  it('未知路由与内置passthrough的Upgrade不造预览用户活动', async () => {
    const f = await fixture();
    expect((await upgrade(f.port, '/ws', { host: 'unknown.example.invalid' })).status).toBe(503);
    expect((await upgrade(f.port, '/_cds/api/stream')).status).toBe(101);
    expect(f.arrivals).toHaveLength(1);
    const receipt = await readForwarderPreviewActivity(f.port);
    expect(receipt).toMatchObject({ branches: [] });
    await f.scheduler.tick();
    expect(f.cooled).toEqual(['file']);
  });

  it('长业务响应尚未结束，开始转发的活动已经保护FILE不被LRU误选', async () => {
    const f = await fixture();
    let finished = false;
    const pending = f.access('/api/long-generation').then(result => { finished = true; return result; });
    try {
      await f.waitForArrival;
      await f.scheduler.tick();
      expect(finished).toBe(false);
      expect(f.cooled).toEqual(['quiet']);
      expect(Date.parse(f.state.getBranch('file')!.lastAccessedAt!)).toBeGreaterThan(Date.now() - 10_000);
    } finally { f.release(); await pending; }
  });

  it.each(['/documents', '/api/document-store/stores'])('SPA/API %s与公开poll伪头都照常刷新真实活动', async url => {
    const f = await fixture();
    expect((await f.access(url, { 'x-cds-poll': 'true' })).status).toBe(200);
    await f.scheduler.tick();
    expect(f.cooled).toEqual(['quiet']);
  });

  it('当前master真probe不计用户，原始令牌不进入stats或上游', async () => {
    const f = await fixture();
    await f.access('/api/version', f.headers);
    const result = await request(f.port, '/__forwarder/stats');
    expect(result.body.includes(f.marker)).toBe(false);
    expect(f.logs.some(log => log.includes(f.marker))).toBe(false);
    expect(f.arrivals.every(headers => headers[PROBE_MARKER_HEADER] === undefined)).toBe(true);
    await f.scheduler.tick();
    expect(f.cooled).toEqual(['file']);
  });

  it('同一分支后续probe不会覆盖先前真实用户时间', async () => {
    const f = await fixture();
    await f.access('/api/document-store/stores');
    for (let i = 0; i < 8; i++) await f.access('/api/version', f.headers);
    await f.scheduler.tick();
    expect(f.cooled).toEqual(['quiet']);
  });

  it.each(['tick', 'wake'] as const)('完整统计超过2MiB仍读取有限活动，%s按真实时间只降温闲置分支', async decision => {
    const f = await fixture();
    await f.access('/api/document-store/stores');
    const userAt = f.proxy.getStats().previewActivity.branches[0].userAt;
    await growHostStats(f.port);
    await f.access('/api/version', f.headers);
    const receipt = await readForwarderPreviewActivity(f.port);
    expect(receipt).toMatchObject({ version: 1, branches: [{ branchId: 'file', userAt }] });
    const projected = await request(f.port, '/__forwarder/stats?view=preview-activity');
    expect(projected.status).toBe(200);
    expect(Object.keys(JSON.parse(projected.body))).toEqual(['previewActivity']);
    expect(Buffer.byteLength(projected.body)).toBeLessThan(2 * 1024 * 1024);
    expect(projected.body.includes(f.marker)).toBe(false);
    if (decision === 'wake') {
      f.scheduler.setMaxHotBranches(2);
      f.state.addBranch({ id: 'new', projectId: 'default', branch: 'codex/new', services: {},
        status: 'idle', heatState: 'cold', worktreePath: '/unused', createdAt: new Date().toISOString() });
      const woken: string[] = [];
      f.scheduler.setWakeFn(async id => { woken.push(id); });
      await f.scheduler.wake('new');
      expect(woken).toEqual(['new']);
      expect(f.scheduler.getSnapshot().capacityUsage).toEqual({ current: 2, max: 2 });
    } else await f.scheduler.tick();
    expect(f.scheduler.getSnapshot().previewActivity?.status).toBe('ready');
    expect(f.cooled).toEqual(['quiet']);
    expect(Date.parse(f.state.getBranch('file')!.lastAccessedAt!)).toBe(userAt);
  });

  it('旧诊断忽略投影参数时仍读真实有限统计；旧统计过大则保持unknown并拒绝容量唤醒', async () => {
    const f = await fixture();
    await f.access('/api/document-store/stores');
    const userAt = f.proxy.getStats().previewActivity.branches[0].userAt;
    const legacyPort = await listen(http.createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(f.proxy.getStats()));
    }));
    f.scheduler.setPreviewActivitySource(() => readForwarderPreviewActivity(legacyPort), isTrustedProbeFingerprint);
    await f.scheduler.tick();
    expect(f.scheduler.getSnapshot().previewActivity?.status).toBe('ready');
    expect(f.cooled).toEqual(['quiet']);
    expect(Date.parse(f.state.getBranch('file')!.lastAccessedAt!)).toBe(userAt);
    await growHostStats(f.port);
    await f.scheduler.tick();
    expect(f.scheduler.getSnapshot().previewActivity).toMatchObject({ status: 'unknown', reason: 'read-failed' });
    f.state.addBranch({ id: 'new', projectId: 'default', branch: 'codex/new', services: {},
      status: 'idle', heatState: 'cold', worktreePath: '/unused', createdAt: new Date().toISOString() });
    const woken: string[] = [];
    f.scheduler.setWakeFn(async id => { woken.push(id); });
    await expect(f.scheduler.wake('new')).rejects.toThrow('预览访问状态暂不可确认');
    expect(woken).toEqual([]);
    expect(f.cooled).toEqual(['quiet']);
    expect(f.state.getBranch('new')!.heatState).toBe('cold');
    expect(Date.parse(f.state.getBranch('file')!.lastAccessedAt!)).toBe(userAt);
  });

  it('九个公开marker经真实HTTP收据不阻断其他分支调度，真probe仍不续用户时间', async () => {
    const f = await fixture();
    const markers = Array.from({ length: 10 }, (_, index) => index.toString(16).padStart(48, '0'))
      .filter(marker => marker !== f.marker).slice(0, 9);
    for (const marker of markers) {
      expect((await f.access('/api/version', { [PROBE_MARKER_HEADER]: marker, 'x-cds-poll': 'true' })).status).toBe(200);
    }
    const branch = () => f.proxy.getStats().previewActivity.branches.find(item => item.branchId === 'file')!;
    const observedAt = () => Math.max(branch().userAt ?? 0, ...branch().markers.map(item => item.at));
    const originalUserAt = observedAt();
    await f.scheduler.tick();
    expect(f.scheduler.getSnapshot().previewActivity?.status).toBe('ready');
    expect(f.cooled).toEqual(['quiet']);
    expect(Date.parse(f.state.getBranch('file')!.lastAccessedAt!)).toBe(originalUserAt);
    expect(branch().markers).toHaveLength(8);
    expect(branch().markerOverflowAt).toBeUndefined();

    await f.access('/api/document-store/stores');
    await f.access('/api/version', { [PROBE_MARKER_HEADER]: markers[8] });
    const latestUserAt = observedAt();
    await f.access('/api/version', f.headers);
    await f.scheduler.tick();
    expect(f.scheduler.getSnapshot().previewActivity?.status).toBe('ready');
    expect(f.cooled).toEqual(['quiet']);
    expect(Date.parse(f.state.getBranch('file')!.lastAccessedAt!)).toBe(latestUserAt);
    expect(f.arrivals.every(headers => headers[PROBE_MARKER_HEADER] === undefined)).toBe(true);
    expect(JSON.stringify(f.proxy.getStats()).includes(f.marker)).toBe(false);
  });

  it.each(['a'.repeat(48), '不是合法探针令牌'])('伪造或畸形probe令牌仍按真实用户访问记账：%#', async marker => {
    const f = await fixture();
    await f.access('/api/document-store/stores', { [PROBE_MARKER_HEADER]: marker.replace(/[^\x20-\x7e]/g, 'x') });
    await f.scheduler.tick();
    expect(f.cooled).toEqual(['quiet']);
  });

  it('公网Host即使经本机socket也读不到收据，healthz不投影活动指纹', async () => {
    const f = await fixture();
    await f.access('/api/version', f.headers);
    expect((await f.access('/__forwarder/stats')).status).toBe(403);
    expect((await f.access('/__forwarder/stats?view=preview-activity', { 'x-forwarded-for': '127.0.0.1' })).status).toBe(403);
    const health = await f.access('/__forwarder/healthz');
    expect(health.status).toBe(200);
    const fingerprints = f.proxy.getStats().previewActivity.branches.flatMap(branch => branch.markers.map(marker => marker.fingerprint));
    expect(fingerprints.every(fingerprint => !health.body.includes(fingerprint))).toBe(true);
    expect(health.body.includes(f.marker)).toBe(false);
  });

  it('master活动读取不可用不阻塞转发，也不调用调度读取直到决策开始', async () => {
    const f = await fixture();
    let reads = 0;
    f.scheduler.setPreviewActivitySource(async () => { reads++; throw new Error('诊断暂不可用'); }, isTrustedProbeFingerprint);
    expect((await f.access('/api/document-store/stores')).status).toBe(200);
    expect(reads).toBe(0);
    await f.scheduler.tick();
    expect(reads).toBe(1);
    expect(f.cooled).toEqual([]);
    expect(f.scheduler.getSnapshot().previewActivity?.status).toBe('unknown');
  });

  it('原回环GET诊断无响应时总时限结束，过大响应也不会无界读取', async () => {
    const stalled = await listen(http.createServer(() => {}));
    await expect(readForwarderPreviewActivity(stalled)).rejects.toThrow('预览活动收据读取超时');
    const oversized = await listen(http.createServer((_req, res) => {
      res.writeHead(200); res.end('x'.repeat(2 * 1024 * 1024 + 1));
    }));
    await expect(readForwarderPreviewActivity(oversized)).rejects.toThrow();
  });
});
