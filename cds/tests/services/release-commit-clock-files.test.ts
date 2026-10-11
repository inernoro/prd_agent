import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ReleaseCommitClock } from '../../src/services/release-commit-clock.js';
let dir: string;
const SHA = 'a'.repeat(40), AT = '2026-01-02T03:04:05.000Z';
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-clock-file-')); });
afterEach(() => { vi.restoreAllMocks(); fs.rmSync(dir, { recursive: true, force: true }); });
const entry = { version: 1, entries: [['p::' + SHA, AT]] };

it('keeps getters cache-only while cold shared loading is outstanding', async () => {
  const storePath = path.join(dir, 'clock.json'); fs.writeFileSync(storePath, JSON.stringify(entry));
  let release!: () => void; const held = new Promise<void>(resolve => { release = resolve; });
  const fileIO = { load: vi.fn(async () => { await held; return entry; }), save: vi.fn(async () => {}) };
  const clock = new ReleaseCommitClock({ storePath, fileIO } as any);
  const native = vi.spyOn(fs, 'readFileSync');
  try {
    expect(clock.get('p', SHA)).toBeUndefined(); expect(native).not.toHaveBeenCalled();
    const loads = Array.from({ length: 10 }, () => (clock as any).ready()); await tick();
    expect(fileIO.load).toHaveBeenCalledTimes(1); release(); await Promise.all(loads);
    expect(clock.get('p', SHA)).toBe(AT); expect(native).not.toHaveBeenCalled();
  } finally { release(); }
});

it('does not finish remembering before its asynchronous write acknowledgement', async () => {
  let release!: () => void; const held = new Promise<void>(resolve => { release = resolve; });
  const fileIO = { load: vi.fn(async () => null), save: vi.fn(async () => { await held; }) };
  const clock = new ReleaseCommitClock({ storePath: path.join(dir, 'clock.json'), fileIO, reader: () => AT } as any);
  const native = vi.spyOn(fs, 'writeFileSync'); let settled = false;
  const pending = clock.remember('p', SHA, '/repo').then(value => { settled = true; return value; });
  try {
    await tick(); expect(settled).toBe(false); expect(fileIO.save).toHaveBeenCalledTimes(1); expect(native).not.toHaveBeenCalled();
  } finally { release(); await pending; }
  expect(await pending).toBe(AT);
});

it('never overwrites a file whose cold load failed', async () => {
  const file = path.join(dir, 'clock.json'); fs.writeFileSync(file, 'unreadable-original');
  const fileIO = { load: vi.fn(async () => { throw new Error('load unavailable'); }), save: vi.fn(async () => {}) };
  const clock = new ReleaseCommitClock({ storePath: file, fileIO, reader: () => AT } as any);
  expect(await clock.remember('p', SHA, '/repo')).toBe(AT);
  expect(fileIO.load).toHaveBeenCalledTimes(1); expect(fileIO.save).not.toHaveBeenCalled();
  expect(fs.readFileSync(file, 'utf8')).toBe('unreadable-original');
});

it('coalesces concurrent saves into one in-flight and one latest snapshot without reversing versions', async () => {
  let release!: () => void; const held = new Promise<void>(resolve => { release = resolve; });
  const written: string[] = []; let active = 0, max = 0;
  const fileIO = { load: vi.fn(async () => null), save: vi.fn(async (raw: string) => {
    max = Math.max(max, ++active); if (written.length === 0) await held; written.push(raw); active--;
  }) };
  const clock = new ReleaseCommitClock({ storePath: path.join(dir, 'clock.json'), fileIO, reader: () => AT } as any);
  const first = clock.remember('first', SHA, '/repo'); let later: Promise<string | undefined>[] = [];
  try {
    await tick(); expect(fileIO.save).toHaveBeenCalledTimes(1);
    later = Array.from({ length: 12 }, (_, i) => clock.remember('p' + i, SHA, '/repo'));
    await tick(); expect(fileIO.save).toHaveBeenCalledTimes(1); release(); await Promise.all([first, ...later]);
    expect(max).toBe(1); expect(fileIO.save).toHaveBeenCalledTimes(2);
    expect(JSON.parse(written[1]).entries).toHaveLength(13);
  } finally { release(); await Promise.all([first, ...later]); }
});

it('bounds distinct requests before a slow load and preserves their frozen roots', async () => {
  let release!: () => void; const held = new Promise<void>(resolve => { release = resolve; });
  const fileIO = { load: vi.fn(async () => { await held; return null; }), save: vi.fn(async () => {}) };
  const reader = vi.fn(async (_root: string, _sha: string, _signal?: AbortSignal) => AT);
  const options = { storePath: path.join(dir, 'clock.json'), fileIO, reader };
  const clock = new ReleaseCommitClock(options);
  const reads = Array.from({ length: 32 }, (_, i) => clock.remember('p' + i, SHA, '/frozen-repo'));
  options.reader = vi.fn(async () => '2000-01-01T00:00:00.000Z');
  try {
    expect(await clock.remember('overflow', SHA, '/other-repo')).toBeUndefined();
    expect(reader).not.toHaveBeenCalled(); expect(fileIO.load).toHaveBeenCalledTimes(1);
    release(); expect(await Promise.all(reads)).toEqual(Array(32).fill(AT));
    expect(reader).toHaveBeenCalledTimes(32); expect(reader.mock.calls.every(call => call[0] === '/frozen-repo')).toBe(true);
  } finally { release(); await Promise.all(reads); }
});

it('keeps failed loading and writing ancillary even if the diagnostic logger throws', async () => {
  const logger = { warn: () => { throw new Error('bad logger'); } };
  const failedRead = new ReleaseCommitClock({ fileIO: { load: async () => { throw new Error('read'); }, save: async () => { throw new Error('must not write'); } }, logger, reader: () => AT });
  await expect(failedRead.ready()).resolves.toBeUndefined();
  expect(await failedRead.remember('p', SHA, '/repo')).toBe(AT);
  const failedWrite = new ReleaseCommitClock({ fileIO: { load: async () => null, save: async () => { throw new Error('write'); } }, logger, reader: () => AT });
  expect(await failedWrite.remember('p', SHA, '/repo')).toBe(AT);
  expect(await failedWrite.remember('second', SHA, '/repo')).toBe(AT);
});
