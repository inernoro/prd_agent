import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { BoundedAuthorityReader } from '../../web/src/lib/bounded-authority-reader.js';
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
let reads: Array<{ signal: AbortSignal; resolve: (value: string) => void; reject: (error: Error) => void }>, apply: ReturnType<typeof vi.fn>, error: ReturnType<typeof vi.fn>, reader: BoundedAuthorityReader<string>;
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] }); reads = []; apply = vi.fn(); error = vi.fn();
  reader = new BoundedAuthorityReader(signal => new Promise((resolve, reject) => reads.push({ signal, resolve, reject })), apply, error);
});
afterEach(() => { reader.dispose(); vi.useRealTimers(); });
it('keeps one read and one demand for a hundred events, while showing completed same-generation snapshots', async () => {
  reader.start(); for (let n = 0; n < 100; n++) reader.refresh(); expect(reads).toHaveLength(1);
  reads[0].resolve('stale'); await tick(); expect(apply).toHaveBeenCalledWith('stale'); expect(reads).toHaveLength(2);
  reads[1].resolve('current'); await tick(); expect(apply).toHaveBeenCalledTimes(2); expect(apply).toHaveBeenLastCalledWith('current'); expect(vi.getTimerCount()).toBe(0);
});
it('each subsequent burst adds at most one followup', async () => {
  reader.start(); reader.refresh(); reads[0].resolve('old'); await tick();
  for (let n = 0; n < 100; n++) reader.refresh(); expect(reads).toHaveLength(2);
  reads[1].resolve('also-old'); await tick(); expect(reads).toHaveLength(3); reads[2].resolve('latest'); await tick();
  expect(apply).toHaveBeenCalledTimes(3); expect(apply).toHaveBeenLastCalledWith('latest');
});
it('reconnect aborts and replaces the old generation even if the reader ignores abort', async () => {
  reader.start(); reader.refresh(); reader.start(); expect(reads).toHaveLength(2); expect(reads[0].signal.aborted).toBe(true);
  reads[1].resolve('new'); await tick(); reads[0].resolve('old'); await tick(); expect(reads).toHaveLength(2);
  expect(apply).toHaveBeenCalledOnce(); expect(apply).toHaveBeenCalledWith('new'); expect(error).not.toHaveBeenCalled();
});
it('deadline releases an ignored-abort read and permits a single latest demand', async () => {
  reader.start(); reader.refresh(); await vi.advanceTimersByTimeAsync(5000); await tick();
  expect(reads[0].signal.aborted).toBe(true); expect(reads).toHaveLength(2); expect(error).toHaveBeenCalledOnce();
  reads[0].resolve('after-timeout'); reads[1].resolve('latest'); await tick(); expect(apply).toHaveBeenCalledOnce(); expect(apply).toHaveBeenCalledWith('latest');
});
it('reports a current timeout without manufacturing an empty successful value', async () => {
  reader.start(); await vi.advanceTimersByTimeAsync(5000); await tick(); expect(error).toHaveBeenCalledOnce(); expect(apply).not.toHaveBeenCalled();
  reads[0].resolve('too-late'); await tick(); expect(apply).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
});
it('dispose drops pending demand, clears deadline and prevents every late callback/read', async () => {
  reader.start(); reader.refresh(); reader.dispose(); reader.refresh();
  expect(reads[0].signal.aborted).toBe(true); expect(vi.getTimerCount()).toBe(0);
  reads[0].resolve('late'); await tick(); expect(reads).toHaveLength(1); expect(apply).not.toHaveBeenCalled(); expect(error).not.toHaveBeenCalled();
});
it('can restart after effect cleanup without inheriting an old generation', async () => {
  reader.start(); reader.dispose(); reader.start(); reads[0].resolve('old'); reads[1].resolve('new'); await tick();
  expect(apply).toHaveBeenCalledOnce(); expect(apply).toHaveBeenCalledWith('new');
});
it('command receipts invalidate both the old read and any queued demand', async () => {
  reader.start(); reader.refresh(); reader.invalidate(); reads[0].resolve('decided-item'); await tick();
  expect(reads).toHaveLength(1); expect(apply).not.toHaveBeenCalled(); reader.refresh(); reads[1].resolve('other-pending'); await tick();
  expect(apply).toHaveBeenCalledOnce(); expect(apply).toHaveBeenCalledWith('other-pending');
});
it('keeps the last valid value on failure and accepts a later authoritative read', async () => {
  reader.start(); reads[0].resolve('known'); await tick(); reader.refresh(); reads[1].reject(new Error('HTTP failed')); await tick();
  expect(apply).toHaveBeenCalledOnce(); expect(apply).toHaveBeenCalledWith('known'); expect(error).toHaveBeenCalledOnce();
  reader.refresh(); reads[2].resolve('new'); await tick(); expect(apply).toHaveBeenLastCalledWith('new');
});
it('contains synchronous reader and observer callback failures', async () => {
  reader.dispose(); const bad = new BoundedAuthorityReader(() => { throw new Error('read'); }, apply, () => { throw new Error('observer'); });
  bad.start(); await tick(); expect(apply).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0); bad.dispose();
});
it('late rejection of an abandoned read is consumed', async () => {
  reader.start(); reader.start(); reads[1].resolve('new'); await tick(); reads[0].reject(new Error('late rejection')); await tick();
  expect(error).not.toHaveBeenCalled(); expect(apply).toHaveBeenCalledOnce(); expect(apply).toHaveBeenCalledWith('new');
});
it('continuous event traffic still publishes each completed same-generation authoritative snapshot', async () => {
  reader.start();
  for (let n = 0; n < 10; n++) {
    for (let event = 0; event < 100; event++) reader.refresh();
    reads[n].resolve('snapshot-' + n); await tick();
    expect(apply).toHaveBeenLastCalledWith('snapshot-' + n); expect(reads).toHaveLength(n + 2);
  }
  expect(apply).toHaveBeenCalledTimes(10);
});
