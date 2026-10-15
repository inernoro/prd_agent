import { afterEach, afterAll, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import type { IsolatedShellExecutor as PoolType } from '../../src/services/isolated-shell-executor.js';
const compiledRoot = process.env.CDS_FS_REMOVAL_COMPILED_DIR;
const moduleUrl = (name: string) => compiledRoot ? pathToFileURL(path.join(compiledRoot, `services/${name}.js`)).href
  : new URL(`../../src/services/${name}.ts`, import.meta.url).href;
const { JanitorService, createJanitorDockerAdapters } = await import(moduleUrl('janitor')) as typeof import('../../src/services/janitor.js');
const { StateService } = await import(moduleUrl('state')) as typeof import('../../src/services/state.js');
const { IsolatedShellExecutor } = await import(moduleUrl('isolated-shell-executor')) as typeof import('../../src/services/isolated-shell-executor.js');
const { ShellExecutor } = await import(moduleUrl('shell-executor')) as typeof import('../../src/services/shell-executor.js');
const { worktreePathActivity } = await import(moduleUrl('worktree-path-activity')) as typeof import('../../src/services/worktree-path-activity.js');
import type { IShellExecutor } from '../../src/types.js';
import { shellQuoteArg } from '../../src/services/secure-database-cli.js';

const roots: string[] = [], pools: PoolType[] = [];
const nativeOutput = process.env.CDS_FS_REMOVAL_NATIVE_OUTPUT;
const poolPids = new Map<PoolType, number[]>();
const nativeClosures: Array<{ pid: number; state: string }> = [];
const nativeChecks: Array<Record<string, unknown>> = [];
if (nativeOutput && (process.env.GITHUB_ACTIONS !== 'true' || process.platform !== 'linux' || !compiledRoot))
  throw new Error('Native filesystem evidence requires actual Linux CI compiled runtime');
afterEach(async context => {
  const closed = pools.splice(0), pids = closed.flatMap(p => poolPids.get(p) || []);
  await Promise.all(closed.map(p => p.close()));
  const states = pids.map(pid => { let state='';try {state=execFileSync('/bin/ps',['-o','stat=','-p',String(pid)],{encoding:'utf8'}).trim();} catch {}
    return {pid,state}; });
  expect(states.every(row=>!row.state||row.state.startsWith('Z'))).toBe(true); nativeClosures.push(...states);
  nativeChecks.push({name:context.task.name,closedProcesses:states,poolZero:closed.every(p=>{const s=p.getStats();return s.active===0&&s.queued===0&&s.bytes===0;})});
  await Promise.all(roots.splice(0).map(p => fs.rm(p, { recursive: true, force: true })));
});
afterAll(async () => {
  if (nativeOutput) await fs.writeFile(nativeOutput, JSON.stringify({mode:'compiled',checks:nativeChecks,
    processClosures:nativeClosures,privateFilesRemoved:true,actualApplicationDeploymentVerified:false,performanceVerified:false,
    actualOsCleanupFailureVerified:false})+'\n');
});
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; };
async function fixture() {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'cds-fs-removal-'))); roots.push(root);
  const base = path.join(root, 'worktrees'), dir = path.join(base, 'proj', 'owned');
  await fs.mkdir(dir, { recursive: true }); await fs.writeFile(path.join(dir, 'marker'), 'must-survive-until-authorized');
  const old = new Date(Date.now() - 24 * 3600_000); await fs.utimes(dir, old, old);
  const state = new StateService(path.join(root, 'state.json'));
  const now = new Date().toISOString(); state.addProject({ id: 'proj', slug: 'proj', name: 'Private', kind: 'git', createdAt: now, updatedAt: now });
  const claim = (id: string, worktreePath = dir) => state.addBranch({ id, projectId: 'proj', branch: id,
    worktreePath, services: {}, status: 'idle', createdAt: now });
  const pool = new IsolatedShellExecutor(new ShellExecutor(), { isolatedLane: 'operation', concurrency: 2,
    maxQueued: 4, maxBytes: 256 * 1024, reservedCleanup: 1, reservedCleanupBytes: 64 * 1024 }); pools.push(pool); await pool.start();
  const actorDeadline=Date.now()+5000;
  while(pool.getStats().actors.filter(a=>a.heapLimit!==undefined).length!==2) {
    if(Date.now()>=actorDeadline)throw new Error('Owned actor metrics did not arrive within original startup budget');
    await new Promise(r=>setTimeout(r,5));
  }
  const metrics=pool.getStats();poolPids.set(pool,[metrics.supervisorPid!,metrics.factoryPid!,...metrics.actors.map(a=>a.pid)]);
  const janitor = (shell: IShellExecutor, wrap?: (remove: ReturnType<typeof createJanitorDockerAdapters>['orphanWorktreeFs']['removeDir']) => typeof remove) => {
    const files = createJanitorDockerAdapters(shell).orphanWorktreeFs;
    return new JanitorService(state, { enabled: true, worktreeTTLDays: 7, diskWarnPercent: 80,
      sweepIntervalSeconds: 3600, dockerPrune: false, imageRetention: false }, base,
      undefined, () => null, undefined, undefined, { ...files, listMountedHostPaths: async () => [],
        ...(wrap ? { removeDir: wrap(files.removeDir) } : {}) });
  };
  return { root, base, dir, old, state, claim, pool, janitor };
}

describe('生产目录回收派发与真实独立操作', () => {
  it.each(['complete', 'cancel'] as const)('删除授权后的实际归属进程%s：阻止同路径认领，独立项目继续；确认后释放', async outcome => {
    const f = await fixture(), ready = path.join(f.root, 'worker-ready'), release = path.join(f.root, 'release-worker');
    const workerModule = moduleUrl('worktree-directory-removal-process');
    const script = `import fs from 'node:fs';import {removeOwnedDirectory} from ${JSON.stringify(workerModule)};
const chunks=[];for await(const chunk of process.stdin)chunks.push(chunk);const input=JSON.parse(Buffer.concat(chunks).toString());
fs.writeFileSync(${JSON.stringify(ready)},JSON.stringify({pid:process.pid,ppid:process.ppid}));
await new Promise(resolve=>{const t=setInterval(()=>{if(fs.existsSync(${JSON.stringify(release)})){clearInterval(t);resolve()}},10)});
process.stdout.write(JSON.stringify({status:await removeOwnedDirectory(input)}));`;
    const controlled: IShellExecutor = { exec: (...args) => f.pool.exec(...args),
      execOwnedOperation: (_command, options) => f.pool.execOwnedOperation(
        `${shellQuoteArg(process.execPath)} --max-old-space-size=128 ${compiledRoot ? '' : '--import tsx '}--input-type=module --eval ${shellQuoteArg(script)}`, options) };
    const sweep = f.janitor(controlled).runSweep();
    const deadline = Date.now() + 5000;
    while (!(await fs.access(ready).then(() => true, () => false))) {
      if (Date.now() >= deadline) throw new Error('Owned worker did not reach controlled barrier');
      await new Promise(r => setTimeout(r, 10));
    }
    const receipt = JSON.parse(await fs.readFile(ready, 'utf8')); expect(receipt.ppid).not.toBe(process.pid);
    f.claim('other', path.join(f.root, 'another-project', 'source'));
    expect(() => f.claim('unsafe')).toThrow('回收');
    expect(() => f.state.setBranchWorktreePath('other', f.dir)).toThrow('回收');
    if (outcome === 'cancel') await f.pool.close(); else await fs.writeFile(release, 'release');
    const result = await sweep;
    if (outcome === 'complete') {
      expect(result.orphanWorktrees?.removed).toContain(f.dir);
      await expect(fs.access(f.dir)).rejects.toMatchObject({ code: 'ENOENT' });
    } else {
      expect(result.orphanWorktrees?.failed).toHaveLength(1);
      expect(await fs.readFile(path.join(f.dir, 'marker'), 'utf8')).toBeTruthy();
    }
    expect(() => f.claim('after-confirmed-cleanup')).not.toThrow();
    await f.pool.close();
    let state = ''; try { state = execFileSync('/bin/ps', ['-o', 'stat=', '-p', String(receipt.pid)], { encoding: 'utf8' }).trim(); } catch {}
    expect(!state || state.startsWith('Z')).toBe(true);nativeClosures.push({pid:receipt.pid,state});
    expect(f.pool.getStats().active).toBe(0); expect(f.pool.getStats().queued).toBe(0);
  }, 20000);
  it('普通shell缺少派发清理契约时保留目录，不回退执行', async () => {
    const f = await fixture(); let ordinaryCalls = 0;
    const result = await f.janitor({ exec: async () => { ordinaryCalls++; throw new Error('must not execute'); } }).runSweep();
    expect(ordinaryCalls).toBe(0); expect(await fs.readFile(path.join(f.dir, 'marker'), 'utf8')).toBeTruthy();
    expect(result.orphanWorktrees?.removed).toEqual([]);
  });
  it('原生归属操作进程执行实际递归回收，期间控制面计时器能运行', async () => {
    const f = await fixture();
    for (let batch = 0; batch < 128; batch++) await Promise.all(Array.from({ length: 16 }, (_, i) =>
      fs.writeFile(path.join(f.dir, `file-${batch * 16 + i}`), 'owned-content')));
    await fs.utimes(f.dir, f.old, f.old);
    let ticks = 0; const timer = setInterval(() => ticks++, 1);
    try {
      const result = await f.janitor(f.pool).runSweep();
      expect(result.orphanWorktrees?.removed).toContain(f.dir); expect(ticks).toBeGreaterThan(0);
      await expect(fs.access(f.dir)).rejects.toMatchObject({ code: 'ENOENT' });
      expect(f.pool.getStats().active).toBe(0); expect(f.pool.getStats().queued).toBe(0);
      console.info(JSON.stringify({ actualOwnedRecursiveRemoval: true, files: 2049, ticksDuringRemoval: ticks }));
    } finally { clearInterval(timer); }
  }, 20000);
  it('操作排队期间新台账认领受理成功，实际派发复核取消删除', async () => {
    const f = await fixture(), busy = deferred(), queued = deferred();
    const release = path.join(f.root, 'release-blocker');
    const script = `console.log('busy');const fs=require('node:fs');const t=setInterval(()=>{if(fs.existsSync(${JSON.stringify(release)}))clearInterval(t)},10);`;
    const blocker = f.pool.execOwnedOperation(`${shellQuoteArg(process.execPath)} -e ${shellQuoteArg(script)}`,
      { beforeStart: () => {}, timeout: 5000, onData: chunk => { if (chunk.includes('busy')) busy.resolve(); } });
    await busy.promise;
    const sweep = f.janitor(f.pool, remove => async (...args) => { queued.resolve(); return remove(...args); }).runSweep();
    await queued.promise;
    const queueDeadline=Date.now()+5000;
    while(f.pool.getStats().queued!==1) {
      if(Date.now()>=queueDeadline)throw new Error('Removal did not enter the actual bounded operation queue');
      await new Promise(r=>setTimeout(r,5));
    }
    f.claim('late-claim'); await fs.writeFile(release, 'release');
    await blocker; const result = await sweep;
    expect(f.state.getBranch('late-claim')?.worktreePath).toBe(f.dir);
    expect(result.orphanWorktrees?.removed).toEqual([]);
    expect(await fs.readFile(path.join(f.dir, 'marker'), 'utf8')).toBe('must-survive-until-authorized');
    expect(f.pool.getStats().active).toBe(0); expect(f.pool.getStats().queued).toBe(0);
  }, 20000);
  it('清理未知回执不释放目录围栏，同路径受理失败而另一项目正常受理', async () => {
    const f = await fixture();
    const uncertain: IShellExecutor = { exec: async () => { throw new Error('forbidden fallback'); },
      execOwnedOperation: async (_command, options) => { options.beforeStart(); throw Object.assign(new Error('owned cleanup unknown'), { code: 'cleanup' }); } };
    const result = await f.janitor(uncertain).runSweep();
    expect(result.orphanWorktrees?.failed).toHaveLength(1);
    expect(() => f.claim('unsafe-late')).toThrow('清理'); expect(f.state.getBranch('unsafe-late')).toBeUndefined();
    expect(() => f.claim('unrelated', path.join(f.root, 'other-project', 'source'))).not.toThrow();
    expect(worktreePathActivity.tryAcquire([f.dir])).toBeNull();
    expect(await fs.readFile(path.join(f.dir, 'marker'), 'utf8')).toBeTruthy();
  });
  it('同年龄目录被替换后原生删除进程保留新对象', async () => {
    const f = await fixture(); let replaced = false;
    const shell: IShellExecutor = { exec: (...args) => f.pool.exec(...args),
      execOwnedOperation: async (command, options) => {
        if (!replaced) { replaced = true; await fs.rename(f.dir, path.join(f.root, 'previous'));
          await fs.mkdir(f.dir); await fs.writeFile(path.join(f.dir, 'marker'), 'replacement'); await fs.utimes(f.dir, f.old, f.old); }
        return f.pool.execOwnedOperation(command, options);
      } };
    const result = await f.janitor(shell).runSweep();
    expect(result.orphanWorktrees?.removed).toEqual([]);
    expect(await fs.readFile(path.join(f.dir, 'marker'), 'utf8')).toBe('replacement');
  }, 20000);
});
