import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import express from 'express';
import http from 'node:http';
import { createCdsEventsRouter } from '../../src/routes/cds-events.js';
import { cdsEventsBus } from '../../src/services/cds-events-bus.js';
import { selfStatusCache } from '../../src/services/self-status-cache.js';
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
let server: http.Server, initial: number;
const responses = new Map<string, http.ServerResponse>(), frames = new Map<string, string[]>(), requests = new Set<http.ClientRequest>();
beforeEach(async () => {
  initial = cdsEventsBus.listenerCount();
  selfStatusCache.init({ computeSnapshot: async () => ({ currentBranch: 'owned', lastRefreshAt: '2026-10-11T00:00:00Z' } as any), scanRemoteBranches: async () => [] });
  selfStatusCache.enqueueRefresh('manual'); for (let i = 0; i < 8; i++) await tick();
  const app = express();
  app.use((req, res, next) => {
    const id = String(req.headers['x-owned-id']); responses.set(id, res); frames.set(id, []);
    if (id === 'scoped') (req as any).cdsProjectKey = { projectId: 'own-project' };
    const native = res.write.bind(res);
    res.write = ((chunk: string) => { frames.get(id)!.push(String(chunk)); const accepted = native(chunk); return id === 'slow' && frames.get(id)!.length === 1 ? false : accepted; }) as typeof res.write;
    next();
  });
  app.use('/api', createCdsEventsRouter());
  server = await new Promise(resolve => { const owned = app.listen(0, '127.0.0.1', () => resolve(owned)); });
});
afterEach(async () => {
  vi.useRealTimers(); for (const req of requests) req.destroy(); requests.clear(); server.closeAllConnections();
  await new Promise<void>(resolve => server.close(() => resolve()));
  for (let i = 0; i < 3; i++) await tick();
  selfStatusCache._resetForTests(); responses.clear(); frames.clear();
  expect(cdsEventsBus.listenerCount()).toBe(initial);
});
async function connect(id: string) {
  await new Promise<void>((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port: (server.address() as any).port, path: '/api/cds-events', headers: { 'x-owned-id': id }, agent: false }, res => {
      res.on('error', () => {}); res.resume(); resolve();
    }); req.on('error', reject); requests.add(req);
  }); await tick();
}
function publish(id: string) { cdsEventsBus.publish('operator.request.completed', { projectId: 'own-project', requestId: id }); }

it('retains mixed observations in order without more socket writes until drain', async () => {
  await connect('slow'); for (let i = 0; i < 4; i++) publish(String(i));
  expect(frames.get('slow')).toHaveLength(1);
  responses.get('slow')!.emit('drain'); expect(frames.get('slow')).toHaveLength(5);
  expect(frames.get('slow')!.slice(1).map(frame => JSON.parse(frame.split('data: ')[1]).data.requestId)).toEqual(['0', '1', '2', '3']);
});
it('disconnects on the 65th queued observation and unsubscribes immediately', async () => {
  await connect('slow'); for (let i = 0; i < 65; i++) publish(String(i));
  expect(responses.get('slow')!.destroyed).toBe(true); expect(cdsEventsBus.listenerCount()).toBe(initial);
});
it('rejects an oversized frame before native write and removes its observer', async () => {
  await connect('fast'); cdsEventsBus.publish('operator.request.log', { text: '中'.repeat(90000) });
  expect(frames.get('fast')).toHaveLength(1); expect(responses.get('fast')!.destroyed).toBe(true);
  expect(cdsEventsBus.listenerCount()).toBe(initial);
});
it('counts queued bytes and socket bytes together before evaluating an overflowing event', async () => {
  await connect('slow'); const peer = responses.get('slow')!;
  Object.defineProperty(peer, 'writableLength', { configurable: true, value: 512 * 1024 + 1 });
  const read = vi.fn(() => 'private'); const data = { get text() { return read(); } };
  cdsEventsBus.publish('operator.request.log', data);
  expect(read).not.toHaveBeenCalled(); expect(peer.destroyed).toBe(true); expect(cdsEventsBus.listenerCount()).toBe(initial);
});
it('terminates exactly at five seconds without cancelling the publisher job', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
  await connect('slow'); publish('running');
  vi.advanceTimersByTime(4999); expect(responses.get('slow')!.destroyed).toBe(false);
  vi.advanceTimersByTime(1); expect(responses.get('slow')!.destroyed).toBe(true);
  expect(cdsEventsBus.listenerCount()).toBe(initial); expect(() => publish('completed-after-disconnect')).not.toThrow();
});
it('filters project scope before payload serialization or queue admission', async () => {
  await connect('scoped'); const read = vi.fn(() => 'foreign');
  cdsEventsBus.publish('operator.request.log', { projectId: 'foreign-project', get text() { return read(); } });
  cdsEventsBus.publish('self.status', { get text() { return read(); } });
  expect(read).not.toHaveBeenCalled(); expect(frames.get('scoped')).toHaveLength(0);
  publish('own'); expect(frames.get('scoped')).toHaveLength(1);
});
it('restores a still-running refresh observation when a client joins late', async () => {
  let release!: (value: any) => void;
  selfStatusCache.init({ computeSnapshot: () => new Promise(resolve => { release = resolve; }), scanRemoteBranches: async () => [] });
  const job = selfStatusCache.enqueueRefresh('manual'); await tick();
  try {
    await connect('fast'); const observed = frames.get('fast')!.find(frame => frame.startsWith('event: self.refresh.started\n'));
    expect(observed).toBeDefined(); expect(JSON.parse(observed!.split('data: ')[1]).jobId).toBe(job.jobId);
  } finally { release({ currentBranch: 'completed-after-join' }); for (let i = 0; i < 5; i++) await tick(); }
});
it('serializes a shared bus envelope only once for multiple eligible peers', async () => {
  await connect('fast-one'); await connect('fast-two'); await connect('scoped');
  const read = vi.fn(() => 'one shared observation');
  cdsEventsBus.publish('operator.request.log', { projectId: 'own-project', get text() { return read(); } });
  expect(read).toHaveBeenCalledTimes(1);
  expect(frames.get('fast-one')!.at(-1)).toBe(frames.get('fast-two')!.at(-1));
  expect(frames.get('scoped')!.at(-1)).toBe(frames.get('fast-two')!.at(-1));
});
it('does not install a bus subscriber after an oversized initial snapshot closes its peer', async () => {
  selfStatusCache.init({ computeSnapshot: async () => ({ currentBranch: 'x'.repeat(256 * 1024), lastRefreshAt: '2026-10-11T00:00:00Z' } as any), scanRemoteBranches: async () => [] });
  selfStatusCache.enqueueRefresh('manual'); for (let i = 0; i < 8; i++) await tick();
  await connect('oversized').catch(() => {}); await tick();
  expect(responses.get('oversized')!.destroyed).toBe(true); expect(frames.get('oversized')).toHaveLength(0);
  expect(cdsEventsBus.listenerCount()).toBe(initial); publish('after-close'); expect(frames.get('oversized')).toHaveLength(0);
});
