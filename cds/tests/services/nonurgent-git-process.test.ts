import { afterEach, describe, expect, it, vi } from 'vitest';
import * as cp from 'node:child_process';
import { mkdtemp, rm, writeFile, readFile, chmod } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ReleaseCommitClock } from '../../src/services/release-commit-clock.js';
import { IsolatedShellExecutor } from '../../src/services/isolated-shell-executor.js';
import { ShellExecutor } from '../../src/services/shell-executor.js';
import { shellQuoteArg } from '../../src/services/secure-database-cli.js';
import { PreviewInstanceShellExecutor } from '../../src/services/preview-instance.js';
import type { IShellExecutor } from '../../src/types.js';
vi.mock('node:child_process', async original => {
  const actual = await original<typeof import('node:child_process')>();
  return { ...actual, exec: vi.fn(actual.exec), execFileSync: vi.fn(actual.execFileSync), spawn: vi.fn(actual.spawn) };
});
const pools: IsolatedShellExecutor[] = [];
const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(pools.splice(0).map(p => p.close()));
  await Promise.all(dirs.splice(0).map(d => rm(d, { recursive: true, force: true })));
  vi.restoreAllMocks();
});
async function untilFile(file: string): Promise<string> {
  for (let i = 0; i < 200; i++) {
    try { return await readFile(file, 'utf8'); } catch { await new Promise(resolve => setTimeout(resolve, 10)); }
  }
  throw new Error('Owned producer did not start');
}
describe('非紧急Git与健康容量', () => {
  it('慢Git占普通操作槽，健康查询和保留清理仍可执行', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'cds-nonurgent-git-owned-')); dirs.push(dir);
    const git = (...args: string[]) => cp.execFileSync('/usr/bin/git', ['-C', dir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    git('init', '-q'); git('config', 'user.name', 'Owned Git'); git('config', 'user.email', 'owned@example.test');
    await writeFile(path.join(dir, 'owned.txt'), 'owned'); git('add', '.'); git('commit', '-qm', '自有真实Git读取');
    const sha = git('rev-parse', 'HEAD').trim();
    const marker = path.join(dir, 'producer.json'); const release = path.join(dir, 'release');
    const shim = path.join(dir, 'git');
    await writeFile(shim, `#!${process.execPath}\nconst fs=require('fs'),cp=require('child_process');\nfs.writeFileSync(${JSON.stringify(marker)},JSON.stringify({pid:process.pid,ppid:process.ppid}));\nconst t=setInterval(()=>{if(!fs.existsSync(${JSON.stringify(release)}))return;clearInterval(t);const p=cp.spawn('/usr/bin/git',process.argv.slice(2),{stdio:'inherit'});p.on('error',()=>process.exit(1));p.on('close',c=>process.exit(c??1));},10);\n`);
    await chmod(shim, 0o700);
    const operation = new IsolatedShellExecutor(new ShellExecutor(), { isolatedLane: 'operation', concurrency: 2, reservedCleanup: 1 });
    const shell = new IsolatedShellExecutor(operation); pools.push(shell, operation);
    await Promise.all([shell.start(), operation.start()]);
    expect((await operation.execBackgroundObservation('printf warm', { timeout: 10000 })).exitCode).toBe(0);
    await Promise.all([shell.exec('printf warm', { executionLane: 'observation', timeout: 10000 }), shell.exec('printf warm', { executionLane: 'observation', timeout: 10000 }), shell.exec('printf warm', { executionPurpose: 'temporary-cleanup', timeout: 10000 })]);
    vi.mocked(cp.exec).mockClear(); vi.mocked(cp.execFileSync).mockClear(); vi.mocked(cp.spawn).mockClear();
    const executor = {
      exec: (command, options) => shell.exec(command, { ...options, env: { PATH: `${dir}${path.delimiter}${process.env.PATH}` }, timeout: 10000 }),
      execBackgroundObservation: (command, options) => shell.execBackgroundObservation(command, { ...options, env: { PATH: `${dir}${path.delimiter}${process.env.PATH}` }, timeout: 10000 }),
    } as IShellExecutor;
    const clock = new ReleaseCommitClock({ shell: executor });
    const pending = clock.remember('owned', sha, dir);
    let ownedProducerPid: number | undefined; let other: Promise<unknown> | undefined;
    try {
      const producer = JSON.parse(await untilFile(marker));
      ownedProducerPid = producer.pid;
      expect(shell.getStats().active).toBe(0);
      expect(operation.getStats().active).toBe(1);
      const healthCommand = ['exec', process.execPath, '-e', 'console.log(process.ppid)'].map(shellQuoteArg).join(' ');
      const health = await Promise.all([shell.exec(healthCommand, { executionLane: 'observation' }), shell.exec(healthCommand, { executionLane: 'observation' })]);
      expect(health.every(result => result.exitCode === 0 && shell.getStats().actors.some(a => a.pid === Number(result.stdout.trim())))).toBe(true);
      const group = await shell.exec(`ps -p ${Number(producer.pid)} -o pgid=`, { executionLane: 'observation' });
      expect(operation.getStats().actors.some(a => a.pid === Number(group.stdout.trim()))).toBe(true);
      other = clock.remember('owned-other', sha, dir);
      await new Promise(resolve => setImmediate(resolve));
      expect(operation.getStats().queued).toBe(0);
      await expect(shell.execBackgroundObservation('true', { executionPurpose: 'temporary-cleanup' })).rejects.toMatchObject({ code: 'capacity' });
      const cleanup = path.join(dir, 'cleanup-owned');
      expect((await shell.exec(`touch ${shellQuoteArg(cleanup)}`, { executionPurpose: 'temporary-cleanup', timeout: 3000 })).exitCode).toBe(0);
      expect(await readFile(cleanup, 'utf8')).toBe('');
      expect(operation.getStats().active).toBe(1);
      expect(cp.exec).not.toHaveBeenCalled(); expect(cp.spawn).not.toHaveBeenCalled(); expect(cp.execFileSync).not.toHaveBeenCalled();
    } finally { await writeFile(release, 'release'); await Promise.all([pending, other]); }
    expect(ownedProducerPid).toBeGreaterThan(0);
    expect(clock.getMeta('owned-other', sha)?.subject).toBe('自有真实Git读取');
    expect(clock.getMeta('owned', sha)?.subject).toBe('自有真实Git读取');
    expect(operation.getStats().active).toBe(0); expect(operation.getStats().bytes).toBe(0);
  }, 15000);
  it('普通Shell缺少隔离读取能力时保持未知，不从Master创建命令', async () => {
    vi.mocked(cp.exec).mockClear(); vi.mocked(cp.spawn).mockClear(); vi.mocked(cp.execFileSync).mockClear();
    const shell = new ShellExecutor();
    const executed = vi.spyOn(shell, 'exec');
    const clock = new ReleaseCommitClock({ shell });
    expect(await clock.remember('owned', 'a'.repeat(40), '/owned-missing')).toBeUndefined();
    expect(executed).not.toHaveBeenCalled();
    expect(cp.exec).not.toHaveBeenCalled(); expect(cp.spawn).not.toHaveBeenCalled(); expect(cp.execFileSync).not.toHaveBeenCalled();
  });
  it('单独健康执行器缺少操作池时拒绝非紧急读取，不占健康容量', async () => {
    const raw = new ShellExecutor();
    const executed = vi.spyOn(raw, 'exec');
    const shell = new IsolatedShellExecutor(raw); pools.push(shell);
    await shell.start();
    await expect(shell.execBackgroundObservation('true')).rejects.toMatchObject({ code: 'unavailable' });
    expect(shell.getStats().active).toBe(0); expect(shell.getStats().queued).toBe(0);
    expect(executed).not.toHaveBeenCalled();
  });
  it('预览实例非紧急读取保留宿主命令拦截，能力缺失不改走普通Shell', async () => {
    const ok = { stdout: 'owned', stderr: '', exitCode: 0 };
    const inner = { exec: vi.fn(async () => ok), execBackgroundObservation: vi.fn(async () => ok) };
    const shell = new PreviewInstanceShellExecutor(inner);
    expect((await shell.execBackgroundObservation('docker ps')).exitCode).toBe(1);
    expect(inner.exec).not.toHaveBeenCalled(); expect(inner.execBackgroundObservation).not.toHaveBeenCalled();
    expect(await shell.execBackgroundObservation("'git' status")).toEqual(ok);
    expect(inner.execBackgroundObservation).toHaveBeenCalledOnce();
    const legacy = { exec: vi.fn(async () => ok) };
    expect((await new PreviewInstanceShellExecutor(legacy).execBackgroundObservation('git status')).exitCode).toBe(1);
    expect(legacy.exec).not.toHaveBeenCalled();
  });
});
