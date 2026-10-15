import http from 'node:http';
import net from 'node:net';
import { describe, expect, it, vi } from 'vitest';
import { branchRoutesAcknowledged, ForwarderRouteAcknowledgement } from '../../src/services/forwarder-route-acknowledgement.js';
import type { RouteRecord } from '../../src/forwarder/types.js';
const route = (id = 'api', port = 10001): RouteRecord => ({ _id: id, branchId: 'branch', profileId: id,
  host: 'branch.example.test', pathPrefix: id === 'api' ? '/api/' : '/', upstreamPort: port, weight: 100, healthState: 'running' });
async function serve(handler: http.RequestListener, test: (port: number) => Promise<void>) {
  const server = http.createServer(handler); const sockets = new Set<net.Socket>();
  server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try { await test((server.address() as net.AddressInfo).port); }
  finally { for (const socket of sockets) socket.destroy(); await new Promise<void>(resolve => server.close(() => resolve())); }
}
describe('P3 actual forwarder acknowledgement', () => {
  it('proves withdrawal of a never-published branch through the actual consumer without accepting an empty readiness graph', async () => {
    let reads = 0;
    await serve((_req, res) => { reads++; res.end(JSON.stringify({ routes: [] })); }, async port => {
      const ack = new ForwarderRouteAcknowledgement({ getDesiredRoutes: () => [], publishNow: () => true }, port);
      expect(await ack.wait('branch')).toBe(false);
      expect(await ack.waitForWithdrawal('branch', { timeoutMs: 100 })).toBe(true);
      expect(reads).toBe(1);
    });
  });
  it.each(['candidate', 'foreign', 'changed-port', 'unavailable', 'desired-drift'])('rejects unconfirmed empty-graph withdrawal: %s', async variant => {
    const other = { ...route(), branchId: 'other', host: 'other.example.test' };
    let desired = [other];
    await serve((_req, res) => {
      if (variant === 'unavailable') { res.statusCode = 503; res.end(); return; }
      if (variant === 'desired-drift') desired = [];
      const actual = variant === 'candidate' ? [other, route()]
        : variant === 'foreign' ? [other, { ...route(), branchId: 'foreign' }]
        : variant === 'changed-port' ? [{ ...other, upstreamPort: 10003 }] : [other];
      res.end(JSON.stringify({ routes: actual }));
    }, async port => {
      const ack = new ForwarderRouteAcknowledgement({ getDesiredRoutes: () => desired, publishNow: () => true }, port);
      expect(await ack.waitForWithdrawal('branch', { timeoutMs: 50, intervalMs: 1 })).toBe(false);
    });
  });
  it('requires the unchanged complete global snapshot to withdraw an empty branch', async () => {
    const other = { ...route(), branchId: 'other', host: 'other.example.test' };
    await serve((_req, res) => res.end(JSON.stringify({ routes: [other] })), async port => {
      const ack = new ForwarderRouteAcknowledgement({ getDesiredRoutes: () => [other], publishNow: () => true }, port);
      expect(await ack.waitForWithdrawal('branch', { timeoutMs: 100 })).toBe(true);
      expect(await ack.waitForWithdrawal('other', { timeoutMs: 100 })).toBe(false);
    });
  });

  it('settles a non-200 HTTP response within its deadline even when destruction emits no later error', async () => {
    await serve((_req, res) => { res.statusCode = 503; res.end('not ready'); }, async port => {
      const ack = new ForwarderRouteAcknowledgement({ getDesiredRoutes: () => [route()], publishNow: () => true }, port);
      const start = Date.now();
      const result = await Promise.race([ack.wait('branch', { timeoutMs: 90, intervalMs: 5 }),
        new Promise<string>(resolve => { const timer = setTimeout(() => resolve('hung'), 500); timer.unref(); })]);
      expect(result).toBe(false); expect(Date.now() - start).toBeLessThan(300);
    });
  });
  it('requires the complete multiset, not equal counts, partial mappings or conflicting owners', () => {
    const expected = [route(), route('web', 10002)];
    expect(branchRoutesAcknowledged('branch', expected, [...expected].reverse())).toBe(true);
    expect(branchRoutesAcknowledged('branch', expected, [route('api', 10011), route('web', 10002)])).toBe(false);
    expect(branchRoutesAcknowledged('branch', expected, [route()])).toBe(false);
    expect(branchRoutesAcknowledged('branch', expected, [...expected, route()])).toBe(false);
    expect(branchRoutesAcknowledged('branch', expected, [...expected, { ...route('foreign'), branchId: 'other' }])).toBe(false);
    expect(branchRoutesAcknowledged('branch', [], [])).toBe(false);
  });
  it('does not accept a successful file write while the real HTTP consumer still serves old ports', async () => {
    const expected = [route()]; const publishNow = vi.fn(() => true);
    await serve((_req, res) => res.end(JSON.stringify({ count: 1, routes: [route('api', 10010)] })), async port => {
      const ack = new ForwarderRouteAcknowledgement({ getDesiredRoutes: () => expected, publishNow }, port);
      expect(await ack.wait('branch', { timeoutMs: 80, intervalMs: 5 })).toBe(false);
      expect(publishNow).toHaveBeenCalled();
    });
  });
  it('waits until the real HTTP consumer has adopted all expected ports', async () => {
    const expected = [route(), route('web', 10002)]; let published = 0; let reads = 0;
    await serve((req, res) => { expect(req.url).toBe('/__forwarder/routes'); reads++;
      res.end(JSON.stringify({ routes: published >= 2 ? expected : [route('api', 10010), route('web', 10002)] })); }, async port => {
      const ack = new ForwarderRouteAcknowledgement({ getDesiredRoutes: () => expected, publishNow: () => ++published >= 2 }, port);
      expect(await ack.wait('branch', { timeoutMs: 300, intervalMs: 5 })).toBe(true); expect(reads).toBeGreaterThanOrEqual(2);
    });
  });
  it('rejects target drift while waiting, rather than accepting a newly changed desired mapping', async () => {
    let desired = [route()];
    await serve((_req, res) => { desired = [route('api', 10003)]; res.end(JSON.stringify({ routes: desired })); }, async port => {
      const ack = new ForwarderRouteAcknowledgement({ getDesiredRoutes: () => desired, publishNow: () => true }, port);
      expect(await ack.wait('branch', { timeoutMs: 300, intervalMs: 5 })).toBe(false);
    });
  });
  it('freezes mapping values even if a provider mutates its existing objects in place', async () => {
    const desired = [route()];
    await serve((_req, res) => { desired[0].upstreamPort = 10003; res.end(JSON.stringify({ routes: desired })); }, async port => {
      const ack = new ForwarderRouteAcknowledgement({ getDesiredRoutes: () => desired, publishNow: () => true }, port);
      expect(await ack.wait('branch', { timeoutMs: 300, intervalMs: 5 })).toBe(false);
    });
  });
  it('cancels an in-flight HTTP request and bounds a trickling response by the total deadline', async () => {
    const expected = [route()]; const controller = new AbortController();
    await serve((_req, res) => { res.write(' '); const timer = setInterval(() => res.write(' '), 5); res.on('close', () => clearInterval(timer)); }, async port => {
      const ack = new ForwarderRouteAcknowledgement({ getDesiredRoutes: () => expected, publishNow: () => true }, port);
      const start = Date.now(); expect(await ack.wait('branch', { timeoutMs: 70, intervalMs: 1 })).toBe(false);
      expect(Date.now() - start).toBeLessThan(300);
      const waiting = ack.wait('branch', { signal: controller.signal, timeoutMs: 1000 }); setTimeout(() => controller.abort(), 20);
      const cancelledAt = Date.now(); expect(await waiting).toBe(false); expect(Date.now() - cancelledAt).toBeLessThan(300);
    });
  });
});
