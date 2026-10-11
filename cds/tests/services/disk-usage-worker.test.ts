import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readDiskUsage } from '../../src/services/disk-usage-worker.js';
import { ShellExecutor } from '../../src/services/shell-executor.js';

afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });
describe('isolated disk usage', () => {
  it('uses the real shared Worker and never statfs on Master, preserving missing targets', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-owned-statfs-'));
    const master = vi.spyOn(fs, 'statfsSync').mockImplementation(() => { throw new Error('Master statfs forbidden'); });
    const shell = new ShellExecutor({ maxConcurrent: 1, maxQueued: 2 });
    try {
      const readings = await readDiskUsage([dir, path.join(dir, 'absent')], shell);
      expect(master).not.toHaveBeenCalled();
      expect(readings[0]!.totalBytes).toBeGreaterThan(0);
      expect(readings[0]!.freeBytes).toBeLessThanOrEqual(readings[0]!.totalBytes);
      expect(readings[1]).toBeNull();
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
  it('freezes paths into stdin, shares diagnostic options and validates small result shape', async () => {
    const calls: any[] = [];
    const shell = { exec: async (cmd: string, options: any) => {
      calls.push({ cmd, options }); return { stdout: '[{"totalBytes":100,"freeBytes":4},null]', exitCode: 0, stderr: '' };
    } };
    const paths = ["/owned/quote' $value", '/owned/missing']; const result = readDiskUsage(paths, shell as any); paths[0] = '/changed';
    expect(await result).toEqual([{ totalBytes: 100, freeBytes: 4 }, null]);
    expect(calls[0].cmd).not.toContain('/owned');
    expect(calls[0].options).toMatchObject({ timeout: 3000, priority: 'diagnostic', schedulingGroup: 'disk-usage', stdin: JSON.stringify(["/owned/quote' $value", '/owned/missing']) });
  });
  it.each(['[]', '{"totalBytes":100,"freeBytes":10}', '[{"totalBytes":0,"freeBytes":0}]', '[{"totalBytes":100,"freeBytes":101}]', 'private invalid'])('unknown/malformed result stays null: %s', async stdout => {
    expect(await readDiskUsage(['/owned'], { exec: async () => ({ exitCode: 0, stdout, stderr: '' }) } as any)).toEqual([null]);
  });
  it('releases a timed-out observer even when an injected executor ignores its signal', async () => {
    vi.useFakeTimers(); let signal!: AbortSignal;
    const result = readDiskUsage(['/owned'], { exec: (_: string, opts: any) => { signal = opts.signal; return new Promise(() => {}); } } as any);
    await Promise.resolve(); await vi.advanceTimersByTimeAsync(3001);
    expect(await result).toEqual([null]); expect(signal.aborted).toBe(true);
  });
  it('abort releases waiting without accepting a late low-pressure reply', async () => {
    const controller = new AbortController(); let resolve!: (value: any) => void;
    const result = readDiskUsage(['/owned'], { exec: () => new Promise(r => { resolve = r; }) } as any, controller.signal);
    await Promise.resolve(); controller.abort(); expect(await result).toEqual([null]);
    resolve({ exitCode: 0, stdout: '[{"totalBytes":100,"freeBytes":99}]', stderr: '' });
    await Promise.resolve();
  });
  it('rejects excessive targets before execution and skips pre-aborted reads', async () => {
    let calls = 0; const shell = { exec: async () => { calls++; throw new Error('unexpected'); } } as any;
    await expect(readDiskUsage(['/a', '/b', '/c'], shell)).rejects.toThrow('invalid disk targets');
    const controller = new AbortController(); controller.abort();
    expect(await readDiskUsage(['/a'], shell, controller.signal)).toEqual([null]); expect(calls).toBe(0);
  });
});
