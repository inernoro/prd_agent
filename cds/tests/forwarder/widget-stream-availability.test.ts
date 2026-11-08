import { afterEach, expect, it, vi } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { ProxyHandler } from '../../src/forwarder/proxy-handler.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); });

function productionActivityRoute() {
  const source = readFileSync(new URL('../../src/server.ts', import.meta.url), 'utf8');
  const parsed = ts.createSourceFile('server.ts', source, ts.ScriptTarget.Latest, true);
  const registrations: ts.CallExpression[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node) && node.expression.getText(parsed) === 'app.get'
      && ts.isStringLiteral(node.arguments[0]) && node.arguments[0].text === '/api/activity-stream') registrations.push(node);
    if (!registrations.length) ts.forEachChild(node, visit);
  };
  visit(parsed);
  const registration = registrations[0];
  if (!registration) throw new Error('Missing production activity stream route');
  type Request = http.IncomingMessage & { query: Record<string, string> };
  let handler: ((req: Request, res: http.ServerResponse) => void) | undefined;
  const clients = new Set<http.ServerResponse>();
  const heartbeats: Array<{ tick: () => void; delay: number }> = [];
  vm.runInNewContext(ts.transpileModule(registration.getText(parsed), {}).outputText, {
    app: { get: (_path: string, route: typeof handler) => { handler = route; } },
    activityClients: clients, activityBuffer: [], clearInterval,
    setInterval: (tick: () => void, delay: number) => { heartbeats.push({ tick, delay }); return setInterval(tick, delay); },
  });
  return { clients, heartbeats, serve(req: http.IncomingMessage, res: http.ServerResponse) {
    (req as Request).query = Object.fromEntries(new URL(req.url || '/', 'http://localhost').searchParams);
    handler!(req as Request, res);
  } };
}

async function fixture(options: { reject?: boolean; known?: boolean; partial?: boolean; idle?: boolean; activityRoute?: boolean; maxAttempts?: number; maxConnections?: number } = {}) {
  const requests: http.IncomingHttpHeaders[] = [];
  const responses: http.ServerResponse[] = [];
  const activity = options.activityRoute ? productionActivityRoute() : undefined;
  const upstream = http.createServer((req, res) => {
    requests.push(req.headers);
    responses.push(res);
    if (options.reject) { res.writeHead(403); res.end('denied'); return; }
    if (activity) { activity.serve(req, res); return; }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    if (options.idle) return; // 与没有历史活动的真实上游一样，等首个心跳才发送 headers。
    res.write('event: snapshot\ndata: {"branches":[{"id":"owned","status":"error"}]}\n\n');
    if (options.partial) res.write('event: branch.status\ndata: {"status":');
  });
  await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const upstreamPort = (upstream.address() as AddressInfo).port;
  await new Promise<void>(resolve => upstream.close(() => resolve()));
  cleanups.push(async () => { upstream.closeAllConnections(); if (upstream.listening) await new Promise<void>(resolve => upstream.close(() => resolve())); });
  const settings = { masterPassthroughHost: '127.0.0.1', masterPassthroughPort: upstreamPort,
    httpLogStore: { record: vi.fn() },
    widgetStreamRecovery: { retryIntervalMs: 20, recoveryTimeoutMs: 500, connectTimeoutMs: 50, maxAttempts: options.maxAttempts ?? 20, maxConnections: options.maxConnections ?? 128 } };
  const proxy = new ProxyHandler(settings);
  const server = http.createServer((req, res) => { void proxy.handle(req, res, options.known === false ? null : {
    _id: 'owned-route', host: 'owned.example.invalid', branchId: 'owned', upstreamPort: 1, weight: 100,
  }); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  cleanups.push(async () => { proxy.destroy(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  return { upstream, upstreamPort, requests, responses, proxy, activity, log: settings.httpLogStore.record,
    start: () => new Promise<void>(resolve => upstream.listen(upstreamPort, '127.0.0.1', resolve)),
    port: (server.address() as AddressInfo).port };
}

it('真实空活动路由在停机恢复后及时确认连接，不等首个30秒心跳耗尽恢复预算', async () => {
  const f = await fixture({ activityRoute: true });
  const s = await stream(f.port, '/_cds/api/activity-stream');
  await s.first;
  expect(s.chunks.join('')).toContain('reconnecting');
  const failures = f.proxy.getStats().widgetStreams!.upstreamFailures;
  expect(failures).toBeGreaterThanOrEqual(1);
  await f.start();
  await vi.waitFor(() => expect(f.requests).toHaveLength(1));
  expect(f.activity!.heartbeats.map(timer => timer.delay)).toEqual([30_000]);
  await new Promise(resolve => setTimeout(resolve, 600)); // 超过原夹具500ms恢复预算；生产预算与心跳不改。
  expect(s.chunks.join('')).toContain('"state":"connected"');
  expect(s.chunks.join('')).not.toContain('unavailable');
  expect(f.proxy.getStats().widgetStreams).toMatchObject({ active: 1, recovering: 0, upstreamFailures: failures });
  f.activity!.heartbeats[0].tick(); // 执行真实路由心跳回调，不等待30秒，也不改它的周期。
  await vi.waitFor(() => expect(s.chunks.join('')).toContain(': keepalive'));
  s.res.destroy(); s.req.destroy();
  await vi.waitFor(() => expect(f.activity!.clients.size).toBe(0));
}, 5000);

it('TCP已连接的空活动流允许等待首个心跳，不将首事件等待误记为连接失败', async () => {
  const f = await fixture({ idle: true });
  await f.start();
  const pending = stream(f.port, '/_cds/api/activity-stream');
  await vi.waitFor(() => expect(f.requests).toHaveLength(1));
  await new Promise(resolve => setTimeout(resolve, 120)); // 原连接预算50ms，未修改生产或用例期限。
  expect(f.requests).toHaveLength(1);
  expect(f.proxy.getStats().widgetStreams?.upstreamFailures).toBe(0);
  f.responses[0].write('event: heartbeat\ndata: {}\n\n');
  const s = await pending;
  await s.first;
  await vi.waitFor(() => expect(s.chunks.join('')).toContain('event: heartbeat'));
  expect(s.chunks.join('')).not.toContain('reconnecting');
  s.res.destroy(); s.req.destroy();
}, 5000);

async function stream(port: number, path = '/_cds/api/branches/stream') {
  return new Promise<{ req: http.ClientRequest; res: http.IncomingMessage; chunks: string[]; first: Promise<void>; ended: Promise<void> }>((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path,
      headers: { host: 'owned.example.invalid', accept: 'text/event-stream', authorization: 'Bearer isolated-test' } }, res => {
      const chunks: string[] = [];
      const first = new Promise<void>(ready => res.once('data', () => ready()));
      res.on('data', chunk => chunks.push(String(chunk)));
      const ended = new Promise<void>(ready => res.once('end', ready));
      resolve({ req, res, chunks, first, ended });
    });
    req.once('error', reject);
  });
}

it('停机期间先明确未知，原端口恢复后重新鉴权并透传原终态，保留故障日志', async () => {
  const f = await fixture();
  const s = await stream(f.port);
  await s.first;
  expect(s.chunks.join('')).toContain('reconnecting');
  expect(f.proxy.getStats().widgetStreams?.recovering).toBe(1);
  await f.start();
  await vi.waitFor(() => expect(s.chunks.join('')).toContain('snapshot'));
  expect(s.chunks.join('')).toContain('"status":"error"');
  expect(f.requests[0]).toMatchObject({ authorization: 'Bearer isolated-test', 'x-cds-source-branch-id': 'owned' });
  expect(f.log.mock.calls.some(([entry]) => entry.status === 503 && entry.outcome === 'upstream-error')).toBe(true);
  s.res.destroy(); s.req.destroy();
  await vi.waitFor(() => expect(f.proxy.getStats().widgetStreams?.active).toBe(0));
}, 5000);

it.each([false, true])('首次故障及时记账，恢复后长流关闭%s不扩大503耗时或重复计数', async longLived => {
  const f = await fixture();
  const s = await stream(f.port); await s.first;
  await f.start();
  await vi.waitFor(() => expect(s.chunks.join('')).toContain('snapshot'));
  const clock = longLived ? vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 7_200_000) : undefined;
  try {
    if (longLived) {
      s.res.destroy(); s.req.destroy();
      await vi.waitFor(() => expect(f.proxy.getStats().widgetStreams?.active).toBe(0));
    }
    expect(f.proxy.getStats()).toMatchObject({ error503Count: 1, statusCounts: { '503': 1 } });
    expect(f.proxy.getStats().p99LatencyMs).toBeLessThan(5000);
    expect(f.log.mock.calls.filter(([entry]) => entry.status === 503)).toHaveLength(1);
  } finally { clock?.mockRestore(); s.res.destroy(); s.req.destroy(); }
}, 5000);

it('原鉴权拒绝保留403，恢复中遇到拒绝只发forbidden，不泄漏快照', async () => {
  const f = await fixture({ reject: true });
  const s = await stream(f.port);
  await s.first;
  await f.start();
  await s.ended;
  expect(s.chunks.join('')).toContain('forbidden');
  expect(s.chunks.join('')).not.toContain('snapshot');
  const denied = await stream(f.port);
  await denied.ended;
  expect(denied.res.statusCode).toBe(403);
  expect(denied.chunks.join('')).toBe('denied');
}, 5000);

it('预算耗尽明确不可用并结束；未知来源仍用原503，不授予挂件恢复通道', async () => {
  const f = await fixture({ maxAttempts: 2 });
  const s = await stream(f.port, '/_cds/api/activity-stream');
  await s.ended;
  expect(s.chunks.join('')).toContain('unavailable');
  expect(f.proxy.getStats().widgetStreams).toMatchObject({ active: 0, recovering: 0, upstreamFailures: 2 });
  const unknown = await fixture({ known: false });
  const u = await stream(unknown.port);
  await u.ended;
  expect(u.res.statusCode).toBe(503);
  expect(u.chunks.join('')).not.toContain('reconnecting');
}, 5000);

it('连接上限有真实503，客户端离开后取消所有后续重试并释放名额', async () => {
  const f = await fixture({ maxConnections: 1 });
  const first = await stream(f.port); await first.first;
  const excess = await stream(f.port); await excess.ended;
  expect(excess.res.statusCode).toBe(503);
  first.res.destroy(); first.req.destroy();
  await vi.waitFor(() => expect(f.proxy.getStats().widgetStreams?.active).toBe(0));
  await f.start();
  await new Promise(resolve => setTimeout(resolve, 60));
  expect(f.requests).toHaveLength(0);
}, 5000);

it('已经透传真实帧后上游断开就结束旧连接，不在半帧后拼接新连接的数据', async () => {
  const f = await fixture({ partial: true });
  await f.start();
  const s = await stream(f.port); await s.first;
  await vi.waitFor(() => expect(s.chunks.join('')).toContain('snapshot'));
  f.upstream.closeAllConnections();
  await s.ended;
  expect(s.chunks.join('')).toContain('event: branch.status\ndata: {"status":');
  expect(s.chunks.join('')).not.toContain('reconnecting');
  await new Promise(resolve => setTimeout(resolve, 60));
  expect(f.requests).toHaveLength(1);
  expect(f.proxy.getStats().widgetStreams).toMatchObject({ active: 0, recovering: 0 });
}, 5000);

it('同一真实挂件路径在控制面暂不可达时明确恢复状态，不把状态未知冒称分支健康', async () => {
  const f = await fixture();
  const reply = await new Promise<{ req: http.ClientRequest; res: http.IncomingMessage; body: string }>((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port: f.port, path: '/_cds/api/branches/stream',
      headers: { host: 'owned.example.invalid', accept: 'text/event-stream' } }, res => {
      res.once('data', chunk => resolve({ req, res, body: String(chunk) }));
    });
    req.once('error', reject);
  });
  try {
    expect(reply.res.statusCode).toBe(200);
    expect(reply.res.headers['content-type']).toContain('text/event-stream');
    expect(reply.body).toContain('reconnecting');
    expect(reply.body).not.toContain('snapshot');
    expect(reply.body).not.toContain('running');
  } finally { reply.res.destroy(); reply.req.destroy(); }
}, 5000);
