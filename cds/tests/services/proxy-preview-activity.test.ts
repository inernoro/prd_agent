import { afterEach, describe, expect, it } from 'vitest';
import http from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ProxyService } from '../../src/services/proxy.js';
import { StateService } from '../../src/services/state.js';
import { SchedulerService } from '../../src/services/scheduler.js';
import { PROBE_MARKER_HEADER, probeRequestHeaders } from '../../src/services/probe-marker.js';
import { flushAllJsonStateStores } from '../../src/infra/state-store/json-backing-store.js';
import type { CdsConfig } from '../../src/types.js';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const stop of cleanup.splice(0).reverse()) await stop();
});

async function listen(server: http.Server): Promise<number> {
  const sockets = new Set<Socket>();
  server.on('connection', socket => {
    sockets.add(socket); socket.once('close', () => sockets.delete(socket));
  });
  cleanup.push(() => new Promise<void>(resolve => {
    for (const socket of sockets) socket.destroy();
    server.closeAllConnections(); server.close(() => resolve());
  }));
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject); server.listen(0, '127.0.0.1', resolve);
  });
  return (server.address() as AddressInfo).port;
}

async function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-worker-activity-'));
  cleanup.push(async () => { await flushAllJsonStateStores(); fs.rmSync(root, { recursive: true, force: true }); });
  const state = new StateService(path.join(root, 'state.json')); state.load();
  const now = Date.now(), identity = randomUUID(), arrivals: http.IncomingHttpHeaders[] = [];
  state.addProject({ id: 'project-id', slug: 'project', name: '测试项目', kind: 'git', createdAt: new Date(now).toISOString() });
  for (const [id, age] of [['project-file', 3 * 3600_000], ['quiet', 3600_000]] as const) {
    state.addBranch({ id, projectId: 'project-id', branch: id === 'project-file' ? 'file' : id,
      status: 'running', heatState: 'hot', services: {}, worktreePath: path.join(root, id),
      createdAt: new Date(now - 86400_000).toISOString(), lastAccessedAt: new Date(now - age).toISOString() });
  }
  const upstream = http.createServer((req, res) => {
    arrivals.push(req.headers);
    res.writeHead(200, { 'content-type': 'application/json', 'x-fixture-id': identity });
    res.end(JSON.stringify({ identity }));
  });
  upstream.on('upgrade', (req, socket) => {
    arrivals.push(req.headers);
    const accept = createHash('sha1').update(`${req.headers['sec-websocket-key']}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\nx-fixture-id: ${identity}\r\n\r\n`);
  });
  const upstreamPort = await listen(upstream);
  const proxy = new ProxyService(state, { rootDomains: ['preview.invalid'] } as CdsConfig);
  const scheduler = new SchedulerService(state, { enabled: true, maxHotBranches: 1,
    idleTTLSeconds: 86400, tickIntervalSeconds: 60, pinnedBranches: [] });
  const cooled: string[] = [];
  scheduler.setCoolFn(async id => { cooled.push(id); }); proxy.setScheduler(scheduler);
  proxy.setResolveUpstream(branchId => branchId === 'project-file' ? `http://127.0.0.1:${upstreamPort}` : null);
  const server = http.createServer((req, res) => { void proxy.handleRequest(req, res); });
  server.on('upgrade', (req, socket, head) => proxy.handleUpgrade(req, socket, head));
  const port = await listen(server);
  return { state, scheduler, cooled, arrivals, identity, port };
}

function access(port: number, transport: 'HTTP' | 'WS', headers: Record<string, string>) {
  return new Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }>((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, agent: false, path: transport === 'WS' ? '/ws' : '/api/activity',
      headers: { host: 'file.preview.invalid', accept: 'application/json', ...headers, ...(transport === 'WS' ? {
        connection: 'Upgrade', upgrade: 'websocket', 'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==', 'sec-websocket-version': '13',
      } : {}) } });
    req.once('upgrade', (res, socket) => {
      socket.destroy(); resolve({ status: res.statusCode || 0, headers: res.headers, body: '' });
    });
    req.once('response', res => {
      let body = ''; res.setEncoding('utf8'); res.on('data', chunk => { body += chunk; });
      res.once('error', reject); res.once('end', () => resolve({ status: res.statusCode || 0, headers: res.headers, body }));
    });
    req.once('error', reject); req.end();
  });
}

describe.each(['HTTP', 'WS'] as const)('legacy worker %s 到真实调度时钟', transport => {
  it.each(['user', 'forged-probe', 'trusted-probe'] as const)('%s 按原探针身份隔离并保护 canonical 分支', async kind => {
    const f = await fixture(), original = f.state.getBranch('project-file')!.lastAccessedAt;
    const probe = probeRequestHeaders();
    const headers = kind === 'trusted-probe' ? probe : kind === 'forged-probe'
      ? { 'x-cds-poll': 'true', [PROBE_MARKER_HEADER]: `${probe[PROBE_MARKER_HEADER][0] === 'a' ? 'b' : 'a'}${probe[PROBE_MARKER_HEADER].slice(1)}` } : {};
    const before = Date.now(), response = await access(f.port, transport, headers);
    expect(response.status).toBe(transport === 'WS' ? 101 : 200);
    expect(response.headers['x-fixture-id']).toBe(f.identity);
    if (transport === 'WS') expect(response.headers['sec-websocket-accept']).toBe('s3pPLMBiTxaQ9kYGzzhZRbK+xOo=');
    else expect(JSON.parse(response.body)).toEqual({ identity: f.identity });
    expect(f.arrivals).toHaveLength(1);
    if (kind === 'trusted-probe') expect(f.state.getBranch('project-file')!.lastAccessedAt).toBe(original);
    else expect(Date.parse(f.state.getBranch('project-file')!.lastAccessedAt!)).toBeGreaterThanOrEqual(before);
    expect(f.arrivals[0][PROBE_MARKER_HEADER]).toBeUndefined();
    await f.scheduler.tick();
    expect(f.cooled).toEqual([kind === 'trusted-probe' ? 'project-file' : 'quiet']);
    expect(f.state.getBranch('quiet')!.lastAccessedAt).not.toBe(f.state.getBranch('project-file')!.lastAccessedAt);
  });
});
