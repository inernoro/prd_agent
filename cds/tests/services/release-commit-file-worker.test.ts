import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import childProcess, { execFileSync } from 'node:child_process';
import { commitClockFileIO } from '../../src/services/release-commit-file.js';
import { ReleaseCommitClock } from '../../src/services/release-commit-clock.js';
import { ShellExecutor, MockShellExecutor } from '../../src/services/shell-executor.js';

let dir: string, shell: ShellExecutor;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-commit-file-worker-')); shell = new ShellExecutor({ maxConcurrent: 1, maxQueued: 4 }); });
afterEach(async () => { vi.restoreAllMocks(); await shell.close(); fs.rmSync(dir, { recursive: true, force: true }); });
const SHA = 'a'.repeat(40), AT = '2026-01-02T03:04:05.000Z';

it('round-trips actual v1/v2 data through the shared worker with safe path quoting', async () => {
  const file = path.join(dir, "quote'$(touch NO_SIDE_EFFECT).json");
  fs.writeFileSync(file, JSON.stringify({ version: 1, entries: [['p::' + SHA, AT]] }));
  const io = commitClockFileIO(file, 500, { exec: (command, options) => shell.exec(command, { ...options, cwd: dir }) });
  const clock = new ReleaseCommitClock({ fileIO: io, reader: () => ({ at: AT, subject: '真实提交', author: '提交者' }) });
  const read = vi.spyOn(fs, 'readFileSync'); const write = vi.spyOn(fs, 'writeFileSync');
  const spawn = vi.spyOn(childProcess, 'spawn'); const sync = vi.spyOn(childProcess, 'execSync');
  await clock.ready(); expect(clock.get('p', SHA)).toBe(AT);
  expect(await clock.remember('other', SHA, '/repo')).toBe(AT);
  expect(read).not.toHaveBeenCalled(); expect(write).not.toHaveBeenCalled(); expect(spawn).not.toHaveBeenCalled(); expect(sync).not.toHaveBeenCalled();
  vi.restoreAllMocks();
  expect(fs.existsSync(path.join(dir, 'NO_SIDE_EFFECT'))).toBe(false);
  const saved = JSON.parse(fs.readFileSync(file, 'utf8')); expect(saved.version).toBe(2); expect(saved.entries).toHaveLength(2);
  const restored = new ReleaseCommitClock({ fileIO: commitClockFileIO(file, 500, shell) }); await restored.ready();
  expect(restored.getMeta('other', SHA)).toEqual({ at: AT, subject: '真实提交', author: '提交者' });
});

it('keeps payload off command lines and uses the shared scheduling and deadline contract', async () => {
  const fake = new MockShellExecutor(); fake.addResponsePattern(/release-commit-file-read/, async () => ({ stdout: 'null', stderr: '', exitCode: 0 }));
  let writeOptions: any;
  fake.addResponsePattern(/release-commit-file-write/, async (_match, options) => { writeOptions = options; return { stdout: '', stderr: '', exitCode: 0 }; });
  const io = commitClockFileIO(path.join(dir, 'private.json'), 500, fake);
  const privatePayload = JSON.stringify({ entries: [['p::' + SHA, { at: AT, subject: 'PRIVATE-SUBJECT' }]] });
  expect(await io.load()).toBeNull(); await io.save(privatePayload);
  expect(fake.commands.join('\n')).not.toContain('PRIVATE-SUBJECT'); expect(fake.stdins[1]).toBe(privatePayload);
  expect(writeOptions).toMatchObject({ timeout: 3000, priority: 'diagnostic', schedulingGroup: 'release-meta-file' });
  expect(fake.commands.every(command => command.startsWith("'" + process.execPath))).toBe(true);
});

it('leaves an existing file untouched on a real worker write failure', async () => {
  const file = path.join(dir, 'preserved.json'); fs.writeFileSync(file, 'original');
  // Renaming a file onto an existing directory fails without relying on host uid/permissions.
  const target = path.join(dir, 'target-directory'); fs.mkdirSync(target);
  const io = commitClockFileIO(target, 500, shell);
  await expect(io.save('replacement')).rejects.toThrow('commit clock write unavailable');
  expect(fs.readFileSync(file, 'utf8')).toBe('original'); expect(fs.statSync(target).isDirectory()).toBe(true);
  expect(fs.readdirSync(dir).some(name => name.startsWith('target-directory.tmp.'))).toBe(false);
});

it('times out a real blocked FIFO read outside Master while the local event loop keeps ticking', async () => {
  const fifo = path.join(dir, 'blocked-clock'); execFileSync('mkfifo', [fifo]);
  const io = commitClockFileIO(fifo, 500, shell); let ticks = 0;
  const timer = setInterval(() => { ticks++; }, 10); const start = Date.now();
  try {
    await expect(io.load()).rejects.toThrow('commit clock load unavailable');
    expect(Date.now() - start).toBeGreaterThanOrEqual(2900); expect(Date.now() - start).toBeLessThan(4500);
    expect(ticks).toBeGreaterThan(100); expect(fs.lstatSync(fifo).isFIFO()).toBe(true);
  } finally { clearInterval(timer); }
}, 6000);


it.each([3, '2', null])('preserves a real unknown-schema %s file through ready and remember', async version => {
  const file = path.join(dir, 'unknown.json');
  const original = JSON.stringify({ version, entries: [['p::' + SHA, AT]], extension: 'never discard' });
  fs.writeFileSync(file, original);
  const clock = new ReleaseCommitClock({ fileIO: commitClockFileIO(file, 500, shell), reader: () => AT });
  await clock.ready(); expect(clock.get('p', SHA)).toBeUndefined();
  expect(await clock.remember('new', SHA, '/repo')).toBe(AT);
  expect(fs.readFileSync(file, 'utf8')).toBe(original);
});
