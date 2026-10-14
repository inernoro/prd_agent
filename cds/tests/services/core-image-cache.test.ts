import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ExecOptions, ExecResult, IShellExecutor } from '../../src/types.js';
import { CoreImageCache, CORE_IMAGE_CACHE_IDLE_MS } from '../../src/services/core-image-cache.js';

const A = 'sha256:' + 'a'.repeat(64), B = 'sha256:' + 'b'.repeat(64), C = 'sha256:' + 'c'.repeat(64);
const answer = (stdout = '', stderr = '', exitCode = 0): ExecResult => ({ stdout, stderr, exitCode });
const absent = () => answer('', 'No such image', 1);
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

describe('finite core image ownership across acquisition and reclamation', () => {
  let root: string, cache: CoreImageCache, mutations: string[][], tags: Map<string, string>;
  let daemon: string, sizes: Map<string, number>, allowed: boolean;
  let intercept: ((args: string[]) => Promise<ExecResult | undefined>) | undefined;
  let instances: CoreImageCache[];
  beforeEach(async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-12T00:00:00Z'));
    root = path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'cds-core-cache-unit-')), 'receipt');
    mutations = []; tags = new Map(); sizes = new Map([[A, 4096], [B, 4096], [C, 4096]]);
    daemon = 'owned:daemon-1'; allowed = true; intercept = undefined; instances = [];
    const shell = { exec: async (command: string, options?: ExecOptions) => {
      options?.beforeStart?.();
      const args = [...command.matchAll(/'([^']*)'/g)].map(match => match[1]);
      const injected = await intercept?.(args); if (injected) return injected;
      if (args[1] === 'info') return answer(daemon);
      if (args[2] === 'inspect') {
        const id = sizes.has(args[3]) ? args[3] : tags.get(args[3]);
        return id ? answer(args.at(-1)?.includes('.Size') ? `${id} ${sizes.get(id)}` : id) : absent();
      }
      mutations.push(args);
      if (args[2] === 'tag') { tags.set(args[4], args[3]); return answer(); }
      if (args[2] === 'rm') { tags.delete(args.at(-1)!); return answer(); }
      throw new Error('Unexpected cache command');
    } } as IShellExecutor;
    const create = () => { const instance = new CoreImageCache(shell, root, 'owned-instance', () => allowed); instances.push(instance); return instance; };
    cache = create();
    // Keep the same executor/daemon while simulating a process restart.
    restart = create;
  });
  let restart: () => CoreImageCache;
  afterEach(async () => { instances.forEach(instance => instance.stop()); vi.useRealTimers(); await fs.rm(path.dirname(root), { recursive: true, force: true }); });
  const receipt = async () => JSON.parse(await fs.readFile(path.join(root, 'cache.json'), 'utf8'));
  const expired = () => vi.setSystemTime(Date.now() + CORE_IMAGE_CACHE_IDLE_MS + 1);
  const acquire = (image = A) => cache.acquire(image, new AbortController().signal);

  it('does not allocate references on an unused bootstrap', async () => {
    await cache.resume(); await cache.reclaimExpired();
    expect(mutations).toEqual([]); expect(tags.size).toBe(0);
    await expect(fs.stat(root)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('keeps two real users protected past expiry, then removes only its owned alias', async () => {
    tags.set('foreign:keep', B);
    const release1 = await acquire(), release2 = await acquire();
    const tag = (await receipt()).entries[0].id;
    expect(mutations.filter(args => args[2] === 'tag')).toHaveLength(1);
    expired(); release1(); release1(); await cache.reclaimExpired();
    expect(mutations.filter(args => args[2] === 'rm')).toHaveLength(0);
    release2(); allowed = false; await cache.reclaimExpired();
    expect(tags.size).toBe(2);
    allowed = true; await cache.reclaimExpired();
    expect(mutations.at(-1)).toEqual(['docker', 'image', 'rm', '--no-prune', expect.stringContaining(tag)]);
    expect([...tags.entries()]).toEqual([['foreign:keep', B]]);
    await expect(fs.stat(root)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('resumes private ownership without allocating and expires the previous process reference', async () => {
    (await acquire())(); cache.stop(); const before = [...mutations];
    cache = restart(); await cache.resume(); expect(mutations).toEqual(before);
    expired(); await cache.reclaimExpired(); expect(tags.size).toBe(0);
    await expect(fs.stat(path.join(root, 'cache.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('enforces both the two-record and total-byte budgets before a third tag mutation', async () => {
    (await acquire(A))(); (await acquire(B))();
    await expect(acquire(C)).rejects.toThrow('budget'); expect(tags.size).toBe(2);
    expired(); await cache.reclaimExpired();
    sizes.set(A, 16 * 1024 ** 3); (await acquire(A))();
    await expect(acquire(B)).rejects.toThrow('budget'); expect(tags.size).toBe(1);
  });

  it('refuses a foreign retag and preserves its receipt and every reference', async () => {
    (await acquire())(); const owned = [...tags.keys()][0]; tags.set(owned, B); tags.set('foreign:keep', A);
    expired(); await expect(cache.reclaimExpired()).rejects.toThrow('ownership changed');
    expect(mutations.filter(args => args[2] === 'rm')).toHaveLength(0);
    expect((await receipt()).entries).toHaveLength(1); expect(tags.get(owned)).toBe(B); expect(tags.get('foreign:keep')).toBe(A);
  });

  it('preserves an unknown late acquisition and reclaims it only after the alias is actually visible', async () => {
    const entered = deferred<void>(), response = deferred<ExecResult>(); let lateArgs: string[] = [];
    intercept = async args => { if (args[2] === 'tag') { lateArgs = args; entered.resolve(); return response.promise; } };
    const acquiring = expect(acquire()).rejects.toThrow('deadline'); await entered.promise;
    await vi.advanceTimersByTimeAsync(5000); await acquiring;
    response.resolve(answer('', 'transport result unknown', 1));
    await cache.resume(); expired();
    await expect(cache.reclaimExpired()).rejects.toThrow('still unconfirmed');
    await expect(acquire()).rejects.toThrow('still unconfirmed');
    expect((await receipt()).entries[0]).toMatchObject({ issued: true, confirmed: false });
    expect(mutations).toEqual([]);
    tags.set(lateArgs[4], A); intercept = undefined;
    await cache.reclaimExpired(); expect(tags.size).toBe(0);
  });

  it('does not reuse an alias after an unconfirmed removal, even if the old removal completes later', async () => {
    (await acquire())(); const old = [...tags.keys()][0]; expired();
    intercept = async args => args[2] === 'rm' ? answer('', 'transport result unknown', 1) : undefined;
    await expect(cache.reclaimExpired()).rejects.toThrow('release is unconfirmed');
    await expect(acquire()).rejects.toThrow('release is still unconfirmed');
    tags.delete(old); intercept = undefined; await cache.reclaimExpired();
    (await acquire())(); const fresh = [...tags.keys()][0]; expect(fresh).not.toBe(old);
    tags.delete(old); expect(tags.get(fresh)).toBe(A);
  });

  it('includes queue wait in the original five-second acquisition deadline', async () => {
    const entered = deferred<void>(), response = deferred<ExecResult>(); let calls = 0;
    intercept = async args => { if (args[2] === 'tag') { calls++; entered.resolve(); return response.promise; } };
    const first = expect(acquire(A)).rejects.toThrow('deadline'); await entered.promise;
    const queued = expect(acquire(B)).rejects.toThrow('deadline');
    await vi.advanceTimersByTimeAsync(5000); await Promise.all([first, queued]);
    response.resolve(answer('', 'unknown', 1)); await cache.resume(); expect(calls).toBe(1);
  });

  it('rejects cancellation and invalid content identity before any mutation', async () => {
    const controller = new AbortController(); controller.abort();
    await expect(cache.acquire(A, controller.signal)).rejects.toThrow('cancelled');
    await expect(acquire('registry/core@sha256:' + 'a'.repeat(64))).rejects.toThrow('content identity');
    expect(mutations).toEqual([]);
  });

  it('preserves the receipt when daemon identity changes', async () => {
    (await acquire())(); cache.stop(); daemon = 'other-daemon'; cache = restart(); expired();
    await expect(cache.reclaimExpired()).rejects.toThrow('daemon ownership changed');
    await expect(acquire()).rejects.toThrow('daemon ownership changed');
    expect(mutations.filter(args => args[2] === 'rm')).toHaveLength(0); expect((await receipt()).entries).toHaveLength(1);
  });

  it.each(['symlink', 'public', 'oversized', 'foreign-instance'] as const)('refuses an untrusted %s receipt without allocating', async kind => {
    await fs.mkdir(root, { mode: 0o700 }); const filename = path.join(root, 'cache.json');
    const data = JSON.stringify({ schema: 1, instanceId: 'other-instance', daemonId: 'owned:daemon-1', entries: [] });
    if (kind === 'symlink') {
      const target = path.join(path.dirname(root), 'foreign.json'); await fs.writeFile(target, data, { mode: 0o600 }); await fs.symlink(target, filename);
    } else await fs.writeFile(filename, kind === 'oversized' ? 'x'.repeat(8193) : data, { mode: kind === 'public' ? 0o644 : 0o600 });
    await expect(acquire()).rejects.toThrow(); expect(mutations).toEqual([]);
    expect((await fs.lstat(filename)).isSymbolicLink()).toBe(kind === 'symlink');
  });
});
