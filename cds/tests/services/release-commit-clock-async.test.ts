import { describe, expect, it } from 'vitest';
import { ReleaseCommitClock } from '../../src/services/release-commit-clock.js';

const SHA = 'a'.repeat(40);
const AT = '2026-01-02T03:04:05.000Z';

describe('P2 asynchronous commit metadata', () => {
  it('shares a pending metadata read, preserves the actual date, then uses the cache', async () => {
    let release!: () => void; const held = new Promise<void>(resolve => { release = resolve; });
    let calls = 0;
    const clock = new ReleaseCommitClock({ reader: (async () => {
      calls++; await held; return { at: AT, subject: '真实提交', author: '提交者' };
    }) as any });
    try {
      const reads = Array.from({ length: 8 }, () => clock.remember('p', SHA, '/repo'));
      await new Promise(resolve => setTimeout(resolve, 5));
      expect(clock.get('p', SHA)).toBeUndefined(); expect(calls).toBe(1);
      release(); expect(await Promise.all(reads)).toEqual(Array(8).fill(AT));
      expect(clock.getMeta('p', SHA)).toEqual({ at: AT, subject: '真实提交', author: '提交者' });
      expect(await clock.remember('p', SHA, '/repo')).toBe(AT); expect(calls).toBe(1);
    } finally { release(); }
  });

  it('rejects excess distinct pending metadata reads without starting more Git work', async () => {
    let release!: () => void; const held = new Promise<void>(resolve => { release = resolve; }); let calls = 0;
    const clock = new ReleaseCommitClock({ reader: (async () => { calls++; await held; return AT; }) as any });
    try {
      const reads = Array.from({ length: 32 }, (_, i) => clock.remember('p' + i, SHA, '/repo'));
      expect(await clock.remember('overflow', SHA, '/repo')).toBeUndefined();
      expect(calls).toBe(32); release();
      expect(await Promise.all(reads)).toEqual(Array(32).fill(AT));
    } finally { release(); }
  });

  it('uses one total deadline across worktree fallbacks and never caches a late result', async () => {
    let finish!: (value: string) => void; let signal: AbortSignal | undefined; let calls = 0;
    const clock = new ReleaseCommitClock({ timeoutMs: 20, reader: ((_root: string, _sha: string, current: AbortSignal) => {
      calls++; signal = current; return new Promise<string>(resolve => { finish = resolve; });
    }) as any } as any);
    const pending = clock.remember('p', SHA, '/gone', '/repo');
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(await pending).toBeUndefined(); expect(signal?.aborted).toBe(true); expect(calls).toBe(1);
    finish(AT); await new Promise(resolve => setTimeout(resolve, 0));
    expect(clock.get('p', SHA)).toBeUndefined();
  });
});
