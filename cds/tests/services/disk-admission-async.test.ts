import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { diskGuard, DISK_READING_TTL_MS } from '../../src/services/disk-guard.js';
const reading = (used: number) => ({ totalBytes: 100, freeBytes: 100 - used });
const deferred = <T>() => { let resolve!: (v: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; };
describe('fresh asynchronous disk admission', () => {
  beforeEach(() => diskGuard.reset());
  afterEach(() => { diskGuard.reset(); vi.useRealTimers(); });
  it('holds cold concurrent admissions until one actual worst-of result arrives', async () => {
    const held = deferred<any>(); let calls = 0; let completed = 0;
    diskGuard.setProbe((() => { calls++; return held.promise; }) as any);
    const a = Promise.resolve(diskGuard.blockReasonForDeploy()).then(v => { completed++; return v; });
    const b = Promise.resolve(diskGuard.blockReasonForDeploy()).then(v => { completed++; return v; });
    await Promise.resolve(); await Promise.resolve();
    expect(completed).toBe(0); expect(calls).toBe(1);
    held.resolve([reading(30), reading(97)]);
    expect(await a).toContain('97%'); expect(await b).toContain('97%');
    expect(await diskGuard.blockReasonForDeploy()).toContain('97%'); expect(calls).toBe(1);
  });
  it('awaits a new measurement when the previous good reading expires', async () => {
    vi.useFakeTimers(); let calls = 0; const held = deferred<any>();
    diskGuard.setProbe((() => ++calls === 1 ? reading(40) : held.promise) as any);
    expect(await diskGuard.blockReasonForDeploy()).toBeNull();
    vi.setSystemTime(Date.now() + DISK_READING_TTL_MS + 1);
    let done = false; const result = Promise.resolve(diskGuard.blockReasonForDeploy()).then(r => { done = true; return r; });
    await Promise.resolve(); expect(done).toBe(false);
    held.resolve(reading(95)); expect(await result).toContain('95%'); expect(calls).toBe(2);
  });
  it('failure and a partial low-pressure reading cannot unfreeze known pressure', async () => {
    diskGuard.update(96);
    diskGuard.setProbe((async () => [reading(30), null]) as any);
    expect(await diskGuard.refreshOrUpdate(30)).toBe('freeze');
    expect(diskGuard.get().usedPercent).toBe(96);
    diskGuard.setProbe((async () => { throw new Error('unavailable'); }) as any);
    expect(await diskGuard.blockReasonForDeploy()).toContain('96%');
  });
  it('a partial readable high-pressure target can still tighten the gate', async () => {
    diskGuard.setProbe((async () => [null, reading(98)]) as any);
    expect(await diskGuard.blockReasonForDeploy()).toContain('98%');
  });
  it('reset and a replacement probe fence out an old late result', async () => {
    const held = deferred<any>(); diskGuard.setProbe((() => held.promise) as any);
    const old = diskGuard.refreshNow(); await Promise.resolve();
    diskGuard.reset(); diskGuard.setProbe((async () => reading(40)) as any);
    expect(await diskGuard.blockReasonForDeploy()).toBeNull();
    held.resolve(reading(99)); await old;
    expect(diskGuard.get().usedPercent).toBe(40);
  });
  it('bounds an injected probe that ignores abort and retains the prior freeze', async () => {
    vi.useFakeTimers(); diskGuard.update(96); let signal: AbortSignal | undefined;
    diskGuard.setProbe(((s: AbortSignal) => { signal = s; return new Promise(() => {}); }) as any);
    let done = false; const result = Promise.resolve(diskGuard.blockReasonForDeploy()).then(r => { done = true; return r; });
    await Promise.resolve(); expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(3001);
    expect(await result).toContain('96%'); expect(signal?.aborted).toBe(true);
  });
  it('rejects nonfinite or impossible readings without clearing a known freeze', async () => {
    diskGuard.update(95);
    diskGuard.setProbe((async () => [{ totalBytes: Infinity, freeBytes: 50 }, { totalBytes: 100, freeBytes: 110 }]) as any);
    expect(await diskGuard.refreshNow()).toBe('freeze'); expect(diskGuard.get().usedPercent).toBe(95);
  });
});
