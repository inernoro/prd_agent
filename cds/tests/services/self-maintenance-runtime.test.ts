import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SelfMaintenanceRuntime, selfMaintenanceHealthy } from '../../src/services/self-maintenance-runtime.js';
import { maintenanceDirectoryIdentity, type MaintenanceFilesInput } from '../../src/services/self-maintenance-files-process.js';
import { IsolatedShellExecutor, OperationExecutionError } from '../../src/services/isolated-shell-executor.js';
import { ShellExecutor } from '../../src/services/shell-executor.js';
import { shellQuote } from '../../src/services/sidecar/sidecar-deployer.js';
import type { ExecAssignment, IShellExecutor } from '../../src/types.js';

const sources = ['self-update', 'self-force-sync', 'self-restart', 'self-update-dry-run'] as const;
const directories = ['dist', 'web/dist', 'web/dist.previous', 'node_modules', 'web/node_modules'];
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { resolve, promise };
}
function nodeCommand(source: string): string {
  return `${shellQuote(process.execPath)} --eval ${shellQuote(source)}`;
}

describe('四来源维护runtime与真实owned文件组件', () => {
  let root: string;
  const runtimes: SelfMaintenanceRuntime[] = [];
  const pools: IsolatedShellExecutor[] = [];
  function runtime(shell: IShellExecutor): SelfMaintenanceRuntime {
    const instance = new SelfMaintenanceRuntime(shell, root, () => {});
    runtimes.push(instance); return instance;
  }
  function pool(): IsolatedShellExecutor {
    const instance = new IsolatedShellExecutor(new ShellExecutor(), { isolatedLane: 'operation', concurrency: 1 });
    pools.push(instance); return instance;
  }
  function seedFiles(): void {
    for (const relative of directories) {
      const dir = path.join(root, 'cds', relative);
      fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, 'fixture'), `old:${relative}`);
    }
    const modules = path.join(root, 'cds/node_modules');
    fs.mkdirSync(path.join(modules, '.pnpm/pkg/node_modules/pkg'), { recursive: true });
    fs.writeFileSync(path.join(modules, '.pnpm/pkg/node_modules/pkg/index.js'), 'old-package');
    fs.symlinkSync('.pnpm/pkg/node_modules/pkg', path.join(modules, 'pkg'));
    fs.symlinkSync(path.join(modules, '.pnpm/pkg/node_modules/pkg'), path.join(modules, 'absolute-pkg'));
  }
  beforeEach(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cds-maintenance-runtime-')));
    fs.mkdirSync(path.join(root, 'cds/web'), { recursive: true });
  });
  afterEach(async () => {
    await Promise.allSettled(runtimes.splice(0).map(instance => instance.close()));
    await Promise.all(pools.splice(0).map(instance => instance.close()));
    fs.rmSync(root, { recursive: true, force: true }); vi.restoreAllMocks();
  });

  it.each(sources)('%s同步持票、同源身份、有限阶段与匹配释放，不按经过时间解锁', source => {
    const instance = runtime(new ShellExecutor());
    const ticket = instance.acquire({ source, actor: 'fixture-owner', requestId: 'request-fixture' })!;
    expect(ticket).not.toBeNull();
    expect(instance.observe()).toMatchObject({ source, actor: 'fixture-owner', phase: 'prepare', activeJobCount: 0 });
    for (const other of sources) expect(instance.acquire({ source: other, actor: 'other' })).toBeNull();
    expect(instance.release({ ...ticket })).toBe(false);
    const snapshot = instance.observe()!; snapshot.actor = 'mutated-snapshot';
    expect(instance.observe()!.actor).toBe('fixture-owner');
    instance.setPhase(ticket, 'drain'); instance.reconcile();
    expect(instance.isHealthy()).toBe(true);
    ticket.restartScheduled = true; instance.setPhase(ticket, 'restart-scheduled');
    expect(instance.finish(ticket)).toBe(false);
    expect(instance.observe()!.id).toBe(ticket.id);
    expect(instance.release(ticket)).toBe(true);
    expect(instance.observe()).toBeNull(); expect(selfMaintenanceHealthy(null)).toBe(true);
  });

  it('普通shell没有owned能力时改树前拒绝，不回落exec或创建backup', async () => {
    const shell = { exec: vi.fn(async () => ({ exitCode: 0, stdout: '', stderr: '' })) };
    const instance = runtime(shell), ticket = instance.acquire({ source: 'self-update', actor: 'fixture' })!;
    expect(() => instance.prepareCheckpoint(ticket)).toThrow('缺少受控维护文件能力');
    await expect(instance.exec(ticket, 'must-not-run')).rejects.toThrow('缺少受控维护执行能力');
    expect(shell.exec).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(root, 'cds/.cds'))).toBe(false);
    expect(instance.finish(ticket)).toBe(true);
  });

  it('真实在途与排队writer取消后先等原promise确认，才允许后继；无迟到写入', async () => {
    const operation = pool(); await operation.start();
    const instance = runtime(operation), ticket = instance.acquire({ source: 'self-update', actor: 'fixture' })!;
    const ready = deferred(), marker = path.join(root, 'writer'), queuedMarker = path.join(root, 'must-not-start');
    let assignment: ExecAssignment | undefined, queuedAssigned = false;
    const active = instance.exec(ticket, nodeCommand(`const fs=require('node:fs');fs.appendFileSync(${JSON.stringify(marker)},'x');process.stdout.write('writer-ready');setInterval(()=>fs.appendFileSync(${JSON.stringify(marker)},'x'),10);`), {
      onAssigned: value => { assignment = value; }, onData: chunk => { if (chunk.includes('writer-ready')) ready.resolve(); },
    });
    const activeRejected = expect(active).rejects.toMatchObject({ code: 'cancelled' });
    await ready.promise;
    expect(assignment).toMatchObject({ lane: 'operation', factoryPid: operation.getStats().factoryPid });
    expect(assignment!.actorPid).toBeGreaterThan(1);
    const queued = instance.exec(ticket, nodeCommand(`require('node:fs').writeFileSync(${JSON.stringify(queuedMarker)},'late')`), {
      onAssigned: () => { queuedAssigned = true; },
    });
    const queuedRejected = expect(queued).rejects.toMatchObject({ code: 'cancelled' });
    expect(operation.getStats().queued).toBe(1);
    expect(instance.observe()!.activeJobCount).toBe(2);
    instance.requestStop(ticket);
    expect(instance.finish(ticket)).toBe(false); expect(instance.isHealthy()).toBe(false);
    await activeRejected; await queuedRejected;
    expect(queuedAssigned).toBe(false); expect(fs.existsSync(queuedMarker)).toBe(false);
    expect(instance.observe()).toMatchObject({ activeJobCount: 0, unconfirmedJobCount: 0 });
    expect(instance.finish(ticket)).toBe(true);
    const size = fs.statSync(marker).size;
    const next = instance.acquire({ source: 'self-update-dry-run', actor: 'next' })!;
    expect((await instance.exec(next, 'printf successor')).stdout).toBe('successor');
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(fs.statSync(marker).size).toBe(size);
    expect(operation.getStats()).toMatchObject({ active: 0, queued: 0 });
    expect(instance.finish(next)).toBe(true);
  });

  it('真实assignment不等于已授权，beforeStart原异常等取消回执后返回且没有writer', async () => {
    const operation = pool(); await operation.start();
    const instance = runtime(operation), ticket = instance.acquire({ source: 'self-force-sync', actor: 'fixture' })!;
    const marker = path.join(root, 'forbidden'), failure = new Error('fixture资格拒绝');
    let assigned = false;
    await expect(instance.exec(ticket, nodeCommand(`require('node:fs').writeFileSync(${JSON.stringify(marker)},'forbidden')`), {
      onAssigned: () => { assigned = true; }, beforeStart: () => { throw failure; },
    })).rejects.toBe(failure);
    expect(assigned).toBe(true); expect(fs.existsSync(marker)).toBe(false);
    expect(instance.observe()).toMatchObject({ activeJobCount: 0, unconfirmedJobCount: 0 });
    expect(instance.finish(ticket)).toBe(true);
  });

  it.each(['cleanup', 'unknown'] as const)('%s终态注入只验证保守分类，不冒充物理停止', async code => {
    const error = code === 'cleanup' ? new OperationExecutionError('cleanup') : new Error('unclassified fixture failure');
    const instance = runtime({ exec: vi.fn(), execOwnedOperation: async () => { throw error; } });
    const ticket = instance.acquire({ source: 'self-restart', actor: 'fixture' })!;
    await expect(instance.exec(ticket, 'private-command')).rejects.toBe(error);
    expect(instance.observe()).toMatchObject({ state: 'cleanup-unconfirmed', unconfirmedJobCount: 1 });
    expect(instance.isHealthy()).toBe(false); expect(instance.finish(ticket)).toBe(false);
    for (const source of sources) expect(instance.acquire({ source, actor: 'must-not-enter' })).toBeNull();
    expect(JSON.stringify(instance.observe())).not.toContain('private-command');
  });

  it.each(['snapshot', 'discard'] as const)('%s原15分钟到期且promise仍未终态时，策略时钟必须停止可见但不释放', async action => {
    // 仅分类/时钟单元：fake owned promise故意不确认停止，不冒充真实FS或物理清理UAT。
    const bootstrap = fs.readFileSync(new URL('../../src/index.ts', import.meta.url), 'utf8');
    expect(bootstrap).toMatch(/isolatedLane:\s*'operation'[^}]*defaultTimeoutMs:\s*15\s*\*\s*60_000/);
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'performance'] });
    const entered = deferred(), terminal = deferred(), warn = vi.fn();
    let dispatched: { signal?: AbortSignal; timeout?: number } | undefined;
    const instance = new SelfMaintenanceRuntime({ exec: vi.fn(), execOwnedOperation: async (_command, options) => {
      dispatched = options; entered.resolve(); await terminal.promise;
      throw new OperationExecutionError('cancelled');
    } }, root, warn);
    runtimes.push(instance);
    const ticket = instance.acquire({ source: 'self-update', actor: 'policy-fixture' })!;
    const checkpoint = instance.prepareCheckpoint(ticket);
    const pending = instance.files(ticket, action, checkpoint);
    const rejected = expect(pending).rejects.toMatchObject({ code: 'cancelled' });
    try {
      await entered.promise;
      vi.advanceTimersByTime(15 * 60_000 - 5000);
      expect(instance.observe()).toMatchObject({ state: 'running', stopRequested: false, activeJobCount: 1 });
      expect(instance.isHealthy()).toBe(true);
      vi.advanceTimersByTime(5000);
      expect.soft(dispatched?.timeout).toBe(15 * 60_000);
      expect.soft(dispatched?.signal?.aborted).toBe(true);
      expect.soft(instance.observe()).toMatchObject({ state: 'cancelling', stopRequested: true, activeJobCount: 1 });
      expect.soft(instance.isHealthy()).toBe(false);
      expect.soft(warn).toHaveBeenCalled();
      expect(instance.finish(ticket)).toBe(false);
      for (const source of sources) expect(instance.acquire({ source, actor: 'must-stay-busy' })).toBeNull();
    } finally {
      terminal.resolve(); await rejected; await instance.close(); vi.useRealTimers();
    }
  });

  it('source worker真实保存/恢复/删除固定五目录，保留pnpm原始链接并防止已恢复FS重放', async () => {
    seedFiles();
    const instance = runtime(pool()), ticket = instance.acquire({ source: 'self-update', actor: 'fixture' })!;
    const checkpoint = instance.prepareCheckpoint(ticket);
    const snapshot = await instance.files(ticket, 'snapshot', checkpoint);
    expect(snapshot.existed).toEqual([true, true, true, true, true]);
    expect(fs.statSync(path.join(checkpoint.backupPath, '0/fixture')).ino)
      .not.toBe(fs.statSync(path.join(root, 'cds/dist/fixture')).ino);
    const rawRelative = fs.readlinkSync(path.join(root, 'cds/node_modules/pkg'));
    const rawAbsolute = fs.readlinkSync(path.join(root, 'cds/node_modules/absolute-pkg'));
    expect(fs.readlinkSync(path.join(checkpoint.backupPath, '3/pkg'))).toBe(rawRelative);
    expect(fs.readlinkSync(path.join(checkpoint.backupPath, '3/absolute-pkg'))).toBe(rawAbsolute);
    for (const relative of directories) {
      fs.rmSync(path.join(root, 'cds', relative), { recursive: true, force: true });
      fs.mkdirSync(path.join(root, 'cds', relative), { recursive: true });
      fs.writeFileSync(path.join(root, 'cds', relative, 'fixture'), 'new-generation');
    }
    expect((await instance.files(ticket, 'restore', checkpoint)).artifactsRestored).toBe(true);
    for (const relative of directories) expect(fs.readFileSync(path.join(root, 'cds', relative, 'fixture'), 'utf8')).toBe(`old:${relative}`);
    expect(fs.readlinkSync(path.join(root, 'cds/node_modules/pkg'))).toBe(rawRelative);
    expect(fs.readlinkSync(path.join(root, 'cds/node_modules/absolute-pkg'))).toBe(rawAbsolute);
    fs.writeFileSync(path.join(root, 'cds/dist/fixture'), 'post-restore-sentinel');
    expect((await instance.files(ticket, 'restore', checkpoint)).artifactsRestored).toBe(true);
    expect(fs.readFileSync(path.join(root, 'cds/dist/fixture'), 'utf8')).toBe('post-restore-sentinel');
    await instance.files(ticket, 'discard', checkpoint);
    expect(fs.existsSync(checkpoint.backupPath)).toBe(false);
    expect(instance.finish(ticket)).toBe(true);
  });

  it('真实cp后仍写partial的受控子进程取消确认前不释放，确认后以独立恢复signal删除本票backup', async () => {
    seedFiles();
    const operation = pool(); await operation.start();
    const ready = deferred(), preload = path.join(root, 'copy-hold.cjs');
    let copiedPath = '';
    const shell: IShellExecutor = { exec: operation.exec.bind(operation),
      execOwnedOperation: (command, options) => operation.execOwnedOperation(command, { ...options,
        env: { ...options.env, NODE_OPTIONS: `--require=${preload}` },
        onData: (chunk, channel) => { options.onData?.(chunk, channel); if (chunk.includes('fixture-copy-held')) ready.resolve(); },
      }) };
    const instance = runtime(shell), ticket = instance.acquire({ source: 'self-update', actor: 'fixture' })!;
    const checkpoint = instance.prepareCheckpoint(ticket);
    copiedPath = path.join(checkpoint.backupPath, '0/late-writer');
    // 先完成真正fs.cp，再让同一真实worker保留写者；不是Mock锁，也不声称模拟不可中断内核I/O。
    fs.writeFileSync(preload, `const fs=require('node:fs');const cp=fs.promises.cp.bind(fs.promises);fs.promises.cp=async(source,target,options)=>{await cp(source,target,options);if(target!==${JSON.stringify(path.join(checkpoint.backupPath, '0'))})return;fs.appendFileSync(${JSON.stringify(copiedPath)},'x');process.stderr.write('fixture-copy-held');await new Promise(()=>setInterval(()=>fs.appendFileSync(${JSON.stringify(copiedPath)},'x'),10));};`);
    const snapshot = instance.files(ticket, 'snapshot', checkpoint);
    const rejected = expect(snapshot).rejects.toMatchObject({ code: 'cancelled' });
    await ready.promise;
    expect(fs.readFileSync(path.join(checkpoint.backupPath, '0/fixture'), 'utf8')).toBe('old:dist');
    expect(instance.observe()).toMatchObject({ phase: 'checkpoint', activeJobCount: 1 });
    instance.requestStop(ticket);
    expect(instance.finish(ticket)).toBe(false);
    expect(instance.acquire({ source: 'self-restart', actor: 'other' })).toBeNull();
    await rejected;
    const size = fs.statSync(copiedPath).size;
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(fs.statSync(copiedPath).size).toBe(size);
    await instance.files(ticket, 'discard', checkpoint);
    expect(fs.existsSync(checkpoint.backupPath)).toBe(false);
    expect(instance.observe()!.unconfirmedJobCount).toBe(0);
    expect(instance.finish(ticket)).toBe(true);
  });

  it('同原逐文件esm转译的compiled worker完整执行三动作，import巡检不消费stdin或写树', async () => {
    seedFiles();
    const sourceDir = fileURLToPath(new URL('../../src/services/', import.meta.url));
    const compiled = path.join(root, 'compiled');
    await build({ entryPoints: ['self-maintenance-files-process.ts', 'atomic-directory-replacement.ts'].map(file => path.join(sourceDir, file)),
      outdir: compiled, outbase: sourceDir, format: 'esm', platform: 'node', target: 'node20', bundle: false, sourcemap: false, logLevel: 'silent' });
    fs.writeFileSync(path.join(compiled, 'package.json'), '{"type":"module"}');
    const instance = runtime(pool()), ticket = instance.acquire({ source: 'self-update', actor: 'fixture' })!;
    const checkpoint = instance.prepareCheckpoint(ticket);
    const worker = path.join(compiled, 'self-maintenance-files-process.js');
    const imported = await instance.exec(ticket, `${shellQuote(process.execPath)} --input-type=module --eval ${shellQuote(`await import(${JSON.stringify(pathToFileURL(worker).href)});console.log('import-only')`)}`);
    expect(imported.exitCode).toBe(0); expect(imported.stdout.trim()).toBe('import-only');
    expect(fs.readdirSync(checkpoint.backupPath)).toEqual([]);
    const input: MaintenanceFilesInput = { action: 'snapshot', ownerId: ticket.id,
      root: maintenanceDirectoryIdentity(root), backup: maintenanceDirectoryIdentity(checkpoint.backupPath) };
    const run = async (action: MaintenanceFilesInput['action']) => {
      const result = await instance.exec(ticket, `${shellQuote(process.execPath)} ${shellQuote(worker)}`, {
        stdin: JSON.stringify({ ...input, action }), cwd: root,
      });
      expect(result.exitCode).toBe(0); return JSON.parse(result.stdout);
    };
    const saved = await run('snapshot'); expect(saved.existed).toEqual([true, true, true, true, true]);
    input.existed = saved.existed;
    fs.writeFileSync(path.join(root, 'cds/dist/fixture'), 'new-compiled-generation');
    expect((await run('restore')).artifactsRestored).toBe(true);
    expect(fs.readFileSync(path.join(root, 'cds/dist/fixture'), 'utf8')).toBe('old:dist');
    expect((await run('discard')).action).toBe('discard');
    expect(fs.existsSync(checkpoint.backupPath)).toBe(false);
    expect(instance.finish(ticket)).toBe(true);
  });
});
