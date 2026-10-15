import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import cp from 'node:child_process';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createDockerPrune, createImageDocker, createJanitorDockerAdapters, JanitorService, defaultDockerPrune, defaultImageDocker, defaultOrphanWorktreeFs } from '../../src/services/janitor.js';

// Named ESM imports must be wrapped before janitor is imported; a late default-export
// spy does not observe its already-bound execFile reference.
vi.mock('node:child_process', async importOriginal => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  const wrapped = { ...actual, exec: vi.fn(actual.exec), execFile: vi.fn(actual.execFile), spawn: vi.fn(actual.spawn), fork: vi.fn(actual.fork) };
  return { ...wrapped, default: wrapped };
});
import { ShellExecutor } from '../../src/services/shell-executor.js';
import { PreviewInstanceShellExecutor } from '../../src/services/preview-instance.js';
import { StateService } from '../../src/services/state.js';
import type { ExecOptions, IShellExecutor } from '../../src/types.js';

let fixture: string;
const originalPath = process.env.PATH;
beforeAll(async () => {
  fixture = await mkdtemp(path.join(tmpdir(), 'cds-janitor-boundary-'));
  // Owned executable only. The fixture never invokes an installed Docker or touches a daemon.
  const executable = path.join(fixture, 'docker');
  await writeFile(executable, `#!/bin/sh
case "$1" in
  images) printf 'owned/image:sha-example\\n';;
  ps) if [ "$2" = '-aq' ]; then printf 'owned-container\\nvanished\\n'; fi;;
  inspect) printf '/owned/mounted-path\\n'; printf 'Error: No such object: vanished\\n' >&2; exit 1;;
  image|builder) printf 'Total reclaimed space: 1B\\n';;
  rmi) if [ -n "$CDS_JANITOR_ARG_FILE" ]; then printf '%s' "$2" > "$CDS_JANITOR_ARG_FILE"; fi; exit 0;;
  *) printf 'unexpected fixture command\\n' >&2; exit 1;;
esac
`);
  await chmod(executable, 0o700);
  process.env.PATH = `${fixture}:${originalPath || ''}`;
});
afterEach(() => vi.clearAllMocks());
afterAll(async () => {
  if (originalPath === undefined) delete process.env.PATH; else process.env.PATH = originalPath;
  await rm(fixture, { recursive: true, force: true });
});
function nativeCalls() {
  return [vi.mocked(cp.exec), vi.mocked(cp.execFile), vi.mocked(cp.spawn), vi.mocked(cp.fork)];
}

describe('P2: Janitor finite Docker commands run outside Master', () => {
  it('enumerates exact output without creating native command processes in Master', async () => {
    const calls = nativeCalls();
    expect(await defaultImageDocker.listImages()).toEqual(['owned/image:sha-example']);
    expect(calls.map(call => call.mock.calls.length)).toEqual([0, 0, 0, 0]);
  });
  it('keeps partial mount inventory unknown after inspect failure outside Master', async () => {
    const calls = nativeCalls();
    expect(await defaultOrphanWorktreeFs.listMountedHostPaths()).toBeNull();
    expect(calls.map(call => call.mock.calls.length)).toEqual([0, 0, 0, 0]);
  });
  it('preserves sequential prune result outside Master', async () => {
    const calls = nativeCalls();
    expect(await defaultDockerPrune()).toEqual({ ran: true, reclaimed: ['悬空镜像: Total reclaimed space: 1B', '构建缓存: Total reclaimed space: 1B'], errors: [] });
    expect(calls.map(call => call.mock.calls.length)).toEqual([0, 0, 0, 0]);
  });
});


describe('shared scheduling and unchanged Janitor safety', () => {
  it('keeps shell metacharacters in a literal image argument with the real Worker', async () => {
    const shell = new ShellExecutor({ maxConcurrent: 1, maxQueued: 4 });
    const argumentFile = path.join(fixture, 'argument');
    const escapeMarker = path.join(fixture, 'must-not-exist');
    const calls: Array<{ command: string; options?: ExecOptions }> = [];
    const adapter: IShellExecutor = { exec: (command, options) => {
      calls.push({ command, options });
      return shell.exec(command, { ...options, env: { ...process.env, PATH: `${fixture}:${originalPath || ''}`, CDS_JANITOR_ARG_FILE: argumentFile } });
    } };
    const image = `owned/image:tag' ; touch '${escapeMarker}' #`;
    try {
      expect(await createImageDocker(adapter).removeImage(image)).toBe(null);
      expect(await readFile(argumentFile, 'utf8')).toBe(image);
      await expect(readFile(escapeMarker)).rejects.toMatchObject({ code: 'ENOENT' });
      expect(calls[0].options).toMatchObject({ timeout: 60_000, priority: 'diagnostic', schedulingGroup: 'janitor' });
      expect(nativeCalls().map(call => call.mock.calls.length)).toEqual([0, 0, 0, 0]);
    } finally { await shell.close(); }
  });
  it('does not force remove when the reference check cannot execute', async () => {
    const exec = vi.fn().mockResolvedValueOnce({ stdout: '', stderr: 'must be forced', exitCode: 1 })
      .mockResolvedValueOnce({ stdout: '', stderr: 'Shell execution capacity exhausted', exitCode: 75 });
    expect(await createImageDocker({ exec }).removeImage('owned/image')).toMatch(/^HELD:/);
    expect(exec).toHaveBeenCalledTimes(2);
    expect(exec.mock.calls.map(call => call[1])).toEqual([
      { timeout: 60_000, priority: 'diagnostic', schedulingGroup: 'janitor', executionLane: 'operation' },
      { timeout: 30_000, priority: 'diagnostic', schedulingGroup: 'janitor', executionLane: 'observation' },
    ]);
  });
  it('reports capacity refusal and thrown executor errors without false reclamation', async () => {
    const exec = vi.fn().mockResolvedValueOnce({ stdout: '', stderr: 'Shell execution capacity exhausted', exitCode: 75 })
      .mockRejectedValueOnce(new Error('owned executor closed'));
    const result = await createDockerPrune({ exec })();
    expect(result.reclaimed).toEqual([]);
    expect(result.errors).toEqual(['悬空镜像: Shell execution capacity exhausted', '构建缓存: owned executor closed']);
    expect(exec.mock.calls.every(call => call[1].timeout === 120_000 && call[1].priority === 'diagnostic')).toBe(true);
  });
  it('uses the injected shared runtime in an actual sweep, retaining explicit callbacks', async () => {
    const state = new StateService(path.join(fixture, 'state.json')); state.load();
    const shared = { exec: vi.fn().mockResolvedValue({ stdout: 'Total reclaimed space: 2B', stderr: '', exitCode: 0 }) };
    const config = { enabled: false, worktreeTTLDays: 7, diskWarnPercent: 80, sweepIntervalSeconds: 3600, imageRetention: false, orphanWorktrees: false };
    const disk = async () => ({ totalBytes: 10000, freeBytes: 5000 });
    const janitor = new JanitorService(state, config, fixture, undefined, disk, undefined, undefined, undefined, shared);
    expect((await janitor.sweep()).dockerPrune?.reclaimed).toHaveLength(2);
    expect(shared.exec).toHaveBeenCalledTimes(2);
    expect(shared.exec.mock.calls.every(call => call[1].schedulingGroup === 'janitor')).toBe(true);
    shared.exec.mockClear();
    const explicitPrune = vi.fn().mockResolvedValue({ ran: true, reclaimed: ['owned injected callback'], errors: [] });
    const injected = new JanitorService(state, config, fixture, undefined, disk, explicitPrune, undefined, undefined, shared);
    expect((await injected.sweep()).dockerPrune?.reclaimed).toEqual(['owned injected callback']);
    expect(explicitPrune).toHaveBeenCalledTimes(1);
    expect(shared.exec).not.toHaveBeenCalled();
  });
  it('passes the shared executor through the exact production startup constructor', async () => {
    const source = await readFile(new URL('../../src/index.ts', import.meta.url), 'utf8');
    const start = source.indexOf('const janitorDocker = createJanitorDockerAdapters(shell);');
    const end = source.indexOf('\n);', start) + 3;
    expect(start).toBeGreaterThan(0); expect(end).toBeGreaterThan(start);
    const state = new StateService(path.join(fixture, 'wiring-state.json')); state.load();
    const shared = { exec: vi.fn().mockResolvedValue({ stdout: 'Total reclaimed space: owned-shared', stderr: '', exitCode: 0 }) };
    const config = { worktreeBase: fixture, scheduler: { pinnedBranches: [] }, janitor: { enabled: false, worktreeTTLDays: 7, diskWarnPercent: 80, sweepIntervalSeconds: 3600, imageRetention: false, orphanWorktrees: false } };
    // Evaluate only the exact production construction expression, with owned dependencies;
    // the Master entry point and its shared services are never started.
    const create = new Function('JanitorService', 'createJanitorDockerAdapters', 'stateService', 'config', 'shell', 'readDiskUsage', source.slice(start, end) + '\nreturn janitorService;');
    const janitor = create(JanitorService, createJanitorDockerAdapters, state, config, shared, async () => [{ totalBytes: 10000, freeBytes: 5000 }]) as JanitorService;
    expect((await janitor.sweep()).dockerPrune?.reclaimed).toEqual(['悬空镜像: Total reclaimed space: owned-shared', '构建缓存: Total reclaimed space: owned-shared']);
    expect(shared.exec).toHaveBeenCalledTimes(2);
    expect(shared.exec.mock.calls.every(call => call[1].schedulingGroup === 'janitor')).toBe(true);
  });

  it('preserves the actual preview-instance host-operation blocker for all Docker defaults', async () => {
    const underlying = { exec: vi.fn().mockResolvedValue({ stdout: 'would execute', stderr: '', exitCode: 0 }) };
    const preview = new PreviewInstanceShellExecutor(underlying);
    const prune = await createDockerPrune(preview)();
    expect(prune.reclaimed).toEqual([]);
    expect(prune.errors).toHaveLength(2);
    expect(prune.errors.every(error => error.includes('[preview-instance]'))).toBe(true);
    await expect(createImageDocker(preview).listImages()).rejects.toThrow('镜像列表查询失败');
    expect(await createImageDocker(preview).removeImage('owned/image')).toContain('[preview-instance]');
    expect(underlying.exec).not.toHaveBeenCalled();
  });

  it('fails closed when partial mount output is followed by a real Worker timeout', async () => {
    const ownedDir = await mkdtemp(path.join(fixture, 'timeout-'));
    const executable = path.join(ownedDir, 'docker');
    await writeFile(executable, '#!/bin/sh\nif [ "$1" = ps ]; then printf "owned-a\\nowned-b\\n"; else printf "/owned/mounted-path\\n"; sleep 10; fi\n');
    await chmod(executable, 0o700);
    const shell = new ShellExecutor({ maxConcurrent: 1 });
    expect((await shell.exec('printf warm', { timeout: 5000 })).exitCode).toBe(0);
    const observed: Array<{ command: string; result: Awaited<ReturnType<IShellExecutor['exec']>> }> = [];
    const adapter: IShellExecutor = { exec: async (command, options) => {
      const result = await shell.exec(command, { ...options, timeout: command.includes("'inspect'") ? 1000 : 5000, env: { ...process.env, PATH: `${ownedDir}:${originalPath || ''}` } });
      observed.push({ command, result }); return result;
    } };
    const state = new StateService(path.join(ownedDir, 'state.json')); state.load();
    const janitor = new JanitorService(state, { enabled: false, worktreeTTLDays: 7, diskWarnPercent: 80, sweepIntervalSeconds: 3600 }, fixture, undefined, async () => null, undefined, undefined, undefined, adapter);
    try {
      // Use the exact bound callback used by sweep, without deleting any filesystem entries.
      const paths = await (janitor as unknown as { orphanWorktreeFs: typeof defaultOrphanWorktreeFs }).orphanWorktreeFs.listMountedHostPaths();
      expect(observed).toHaveLength(2);
      expect(observed[0].result.exitCode).toBe(0);
      expect(observed[1].result).toMatchObject({ exitCode: 124, stdout: '/owned/mounted-path\n' });
      expect(paths).toBe(null);
    } finally { await shell.close(); }
  });

  it.each([
    [124, 'Command timed out'], [130, 'Command cancelled'], [75, 'Shell execution capacity exhausted'],
    [1, 'permission denied'], [1, 'Error: No such object: foreign'],
    [1, 'Error: No such object: owned-b\npermission denied'], [1, ''],
  ])('keeps mount inventory unknown for partial failure %s/%s', async (exitCode, stderr) => {
    const exec = vi.fn().mockResolvedValueOnce({ stdout: 'owned-a\nowned-b\n', stderr: '', exitCode: 0 })
      .mockResolvedValueOnce({ stdout: '/owned/mounted-path\n', stderr, exitCode });
    const state = new StateService(path.join(fixture, 'unknown-state.json')); state.load();
    const janitor = new JanitorService(state, { enabled: false, worktreeTTLDays: 7, diskWarnPercent: 80, sweepIntervalSeconds: 3600 }, fixture, undefined, async () => null, undefined, undefined, undefined, { exec });
    expect(await (janitor as unknown as { orphanWorktreeFs: typeof defaultOrphanWorktreeFs }).orphanWorktreeFs.listMountedHostPaths()).toBe(null);
  });

});
