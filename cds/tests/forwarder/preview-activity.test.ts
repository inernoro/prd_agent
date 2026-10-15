import { afterEach, describe, expect, it } from 'vitest';
import express from 'express';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ProxyHandler } from '../../src/forwarder/proxy-handler.js';
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
  const upstreamPort = await listen(upstream);
  const logs: string[] = [];
  const proxy = new ProxyHandler({ upstreamTimeoutMs: 5000, httpLogStore: {
    record: record => { logs.push(JSON.stringify(record)); },
    beginActive: record => { logs.push(JSON.stringify(record)); return 'active'; },
    completeActive: () => {},
  } });
  cleanup.push(async () => { proxy.destroy(); });
  const watcher = new RouteWatcher({ mongoConnect: async () => { throw new Error('本夹具不读取路由存储'); },
    jsonFallbackPath: '/dev/null', saveSnapshot: false, logger: {} });
  const app = express();
  app.use(createDiagnosticRouter({ watcher, proxy }));
  app.use((req, res) => { void proxy.handle(req, res, { _id: 'file-route', host: 'file.example.invalid',
    upstreamPort, branchId: 'file', profileId: 'api', weight: 100, healthState: 'running' }); });
  const port = await listen(http.createServer(app));
  const headers = probeRequestHeaders();
  const marker = headers[PROBE_MARKER_HEADER];
  scheduler.setPreviewActivitySource(() => readForwarderPreviewActivity(port), isTrustedProbeFingerprint, now - 1000);
  return { state, scheduler, cooled, port, headers, marker, proxy, logs, arrivals, waitForArrival,
    release: () => release?.(), access: (url: string, extra: Record<string, string> = {}, method?: string) =>
      request(port, url, { host: 'file.example.invalid', ...extra }, method) };
}

describe('真实forwarder访问到master调度时钟', () => {
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
