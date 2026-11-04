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

  it('完整snapshot之后其它writer清理分类未知时，不发布保留能力或释放原票', async () => {
    // 仅未知分类故障注入；真实snapshot不等于后续未知writer已物理停止。
    seedFiles();
    const operation = pool(), instance = runtime(operation);
    const ticket = instance.acquire({ source: 'self-update', actor: 'retention-unknown-classification' })!;
    const checkpoint = instance.prepareCheckpoint(ticket, { sha: 'a'.repeat(40), branch: 'fixture' });
    await instance.files(ticket, 'snapshot', checkpoint);
    const file = path.join(root, 'cds/.cds/checkpoint-retention.json'), before = fs.readFileSync(file, 'utf8');
    vi.spyOn(operation, 'execOwnedOperation').mockRejectedValueOnce(new OperationExecutionError('cleanup'));
    await expect(instance.exec(ticket, 'never-physically-executed-policy-fixture')).rejects.toMatchObject({ code: 'cleanup' });
    ticket.restartScheduled = true;
    expect(() => instance.retainCheckpoint(ticket, checkpoint)).toThrow('尚未具备完整终态');
    expect(fs.readFileSync(file, 'utf8')).toBe(before); expect(fs.existsSync(checkpoint.backupPath)).toBe(true);
    expect(instance.observe()).toMatchObject({ activeJobCount: 0, unconfirmedJobCount: 1 });
    expect(instance.finish(ticket)).toBe(false);
  });

  it('持续cleanup未知保留原五秒观察，但同态告警最多每分钟一次不淹没整日事件', async () => {
    // 仅分类与告警时钟，不把故障注入或虚拟一天冒充真实OS未知停止/稳定性验收。
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'performance'] });
    const warn = vi.fn();
    const instance = new SelfMaintenanceRuntime({ exec: vi.fn(),
      execOwnedOperation: async () => { throw new OperationExecutionError('cleanup'); },
    }, root, warn);
    runtimes.push(instance);
    const ticket = instance.acquire({ source: 'self-update', actor: 'warning-fixture' })!;
    try {
      await expect(instance.exec(ticket, 'private-command')).rejects.toMatchObject({ code: 'cleanup' });
      expect(instance.observe()).toMatchObject({ state: 'cleanup-unconfirmed', unconfirmedJobCount: 1 });
      vi.advanceTimersByTime(5000);
      expect(warn).toHaveBeenCalledTimes(1);
      vi.advanceTimersByTime(55_000);
      expect.soft(warn).toHaveBeenCalledTimes(1);
      vi.advanceTimersByTime(5000);
      expect.soft(warn).toHaveBeenCalledTimes(2);
      vi.advanceTimersByTime(24 * 60 * 60_000 - 65_000);
      expect.soft(warn).toHaveBeenCalledTimes(1440);
      expect(instance.observe()).toMatchObject({ state: 'cleanup-unconfirmed', unconfirmedJobCount: 1, stopRequested: true });
      expect(instance.isHealthy()).toBe(false);
      expect(instance.finish(ticket)).toBe(false);
    } finally {
      await instance.close();
      vi.useRealTimers();
    }
  });

  it('新维护票和取消转未知状态不受上一条同态提醒间隔压制', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'performance'] });
    let fail!: (error: Error) => void;
    const result = new Promise<never>((_resolve, reject) => { fail = reject; });
    const warn = vi.fn();
    const instance = new SelfMaintenanceRuntime({ exec: vi.fn(), execOwnedOperation: () => result }, root, warn);
    runtimes.push(instance);
    try {
      const first = instance.acquire({ source: 'self-restart', actor: 'first-warning-fixture' })!;
      instance.requestStop(first);
      vi.advanceTimersByTime(5000);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0][0]).toMatchObject({ id: first.id, state: 'cancelling' });
      expect(instance.finish(first)).toBe(true);
      const next = instance.acquire({ source: 'self-force-sync', actor: 'next-warning-fixture' })!;
      const pending = instance.exec(next, 'private-command');
      const rejected = expect(pending).rejects.toMatchObject({ code: 'cleanup' });
      instance.requestStop(next);
      vi.advanceTimersByTime(5000);
      expect(warn).toHaveBeenCalledTimes(2);
      expect(warn.mock.calls[1][0]).toMatchObject({ id: next.id, state: 'cancelling' });
      fail(new OperationExecutionError('cleanup'));
      await rejected;
      vi.advanceTimersByTime(5000);
      expect(warn).toHaveBeenCalledTimes(3);
      expect(warn.mock.calls[2][0]).toMatchObject({ id: next.id, state: 'cleanup-unconfirmed', unconfirmedJobCount: 1 });
      expect(instance.finish(next)).toBe(false);
    } finally {
      fail(new OperationExecutionError('cleanup'));
      await instance.close();
      vi.useRealTimers();
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
    await build({ entryPoints: ['self-maintenance-files-process.ts', 'self-maintenance-retention.ts', 'atomic-directory-replacement.ts'].map(file => path.join(sourceDir, file)),
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

  it.each(['restore', 'discard'] as const)('native dist换代移走新worker后，%s仍用同票完成且不借Master模块缓存', async action => {
    seedFiles();
    const source = fileURLToPath(new URL('../../src/', import.meta.url));
    const dist = path.join(root, 'cds/dist');
    const entries = [
      'services/self-maintenance-runtime.ts', 'services/self-maintenance-files-process.ts',
      'services/self-maintenance-retention.ts',
      'services/atomic-directory-replacement.ts', 'services/isolated-shell-executor.ts',
      'services/observation-process-launcher.ts', 'services/observation-process-group.ts',
      'services/sidecar/sidecar-deployer.ts', 'services/sidecar/remote-host-service.ts',
      'services/docker-log-policy.ts',
      'services/ssh-exec-failure.ts', 'infra/secret-seal.ts',
      'services/shell-executor.ts', 'services/observation-process.ts',
      'services/observation-executor-process.ts', 'services/observation-supervisor-process.ts',
    ];
    await build({ entryPoints: entries.map(file => path.join(source, file)), outdir: dist, outbase: source,
      format: 'esm', platform: 'node', target: 'node20', bundle: false, sourcemap: false, logLevel: 'silent' });
    fs.writeFileSync(path.join(root, 'cds/package.json'), '{"type":"module"}');
    // 只引导native import的真实ssh2依赖，不在五目录内，不冒充PNPM安装/整树验收。
    fs.symlinkSync(fs.realpathSync(new URL('../../node_modules/', import.meta.url)), path.join(root, 'node_modules'), 'dir');
    const worker = path.join(dist, 'services/self-maintenance-files-process.js');
    const atomic = path.join(dist, 'services/atomic-directory-replacement.js');
    const rawRelative = fs.readlinkSync(path.join(root, 'cds/node_modules/pkg'));
    const rawAbsolute = fs.readlinkSync(path.join(root, 'cds/node_modules/absolute-pkg'));
    const nativeRuntimeUrl = pathToFileURL(path.join(dist, 'services/self-maintenance-runtime.js')).href;
    const runner = path.join(root, 'native-dist-case.mjs');
    // d65的new Function import在Vitest VM缺callback；改由独立Node执行完整序列。
    // runner只是测试编排；真实runtime/worker/atomic及其池模块都在将被换代的dist内。
    fs.writeFileSync(runner, `
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { SelfMaintenanceRuntime } from ${JSON.stringify(nativeRuntimeUrl)};
import { IsolatedShellExecutor } from ${JSON.stringify(pathToFileURL(path.join(dist, 'services/isolated-shell-executor.js')).href)};
import { ShellExecutor } from ${JSON.stringify(pathToFileURL(path.join(dist, 'services/shell-executor.js')).href)};
import { replaceDirectoriesAtomically } from ${JSON.stringify(pathToFileURL(atomic).href)};
const root = ${JSON.stringify(root)}, dist = ${JSON.stringify(dist)}, action = ${JSON.stringify(action)};
const worker = ${JSON.stringify(worker)}, atomic = ${JSON.stringify(atomic)};
const directories = ${JSON.stringify(directories)};
const workerBytes = fs.readFileSync(worker), atomicBytes = fs.readFileSync(atomic);
const operation = new IsolatedShellExecutor(new ShellExecutor(), { isolatedLane: 'operation', concurrency: 1 });
const children = [];
const instance = new SelfMaintenanceRuntime({ exec: operation.exec.bind(operation),
  execOwnedOperation: async (command, options) => {
    const result = await operation.execOwnedOperation(command, options);
    children.push({ command, result }); return result;
  },
}, root, () => {});
let report;
try {
  const ticket = instance.acquire({ source: 'self-update', actor: 'native-dist-fixture' });
  const ownerBefore = instance.observe();
  const checkpoint = instance.prepareCheckpoint(ticket);
  const snapshot = await instance.files(ticket, 'snapshot', checkpoint);
  const snapshotChildren = children.map(child => ({ ...child }));
  const savedWorker = fs.readFileSync(path.join(checkpoint.backupPath, '0/services/self-maintenance-files-process.js')).equals(workerBytes);
  const savedAtomic = fs.readFileSync(path.join(checkpoint.backupPath, '0/services/atomic-directory-replacement.js')).equals(atomicBytes);
  // 合法旧代ESM夹具而非b547全量构建，原子换代清掉旧dist后只剩backup有worker。
  const candidate = path.join(root, 'cds/dist.next');
  fs.mkdirSync(candidate);
  fs.writeFileSync(path.join(candidate, 'index.js'), 'export const fixtureGeneration = "old-without-maintenance-worker";\\n');
  fs.writeFileSync(path.join(candidate, 'fixture'), 'new:dist');
  replaceDirectoriesAtomically([{ currentPath: dist, nextPath: candidate }]);
  const generation = (await import(pathToFileURL(path.join(dist, 'index.js')).href)).fixtureGeneration;
  const absentAfterSwap = { worker: !fs.existsSync(worker), atomic: !fs.existsSync(atomic) };
  for (const relative of directories.slice(1)) {
    const dir = path.join(root, 'cds', relative);
    fs.rmSync(dir, { recursive: true, force: true }); fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'fixture'), 'new:' + relative);
  }
  const terminal = await instance.files(ticket, action, checkpoint).then(receipt => ({ receipt }), error => ({
    error: String(error), childAfterSwap: children.at(-1),
  }));
  const childrenAtTerminal = children.map(child => ({ ...child }));
  let postRestoreDiscard = null;
  if (action === 'restore' && 'receipt' in terminal) {
    postRestoreDiscard = await instance.files(ticket, 'discard', checkpoint).then(receipt => ({ receipt }), error => ({
      error: String(error), childAfterRestore: children.at(-1),
    }));
  }
  const restoredPrograms = fs.existsSync(worker) && fs.existsSync(atomic)
    && fs.readFileSync(worker).equals(workerBytes) && fs.readFileSync(atomic).equals(atomicBytes);
  const relativeLink = path.join(root, 'cds/node_modules/pkg');
  const absoluteLink = path.join(root, 'cds/node_modules/absolute-pkg');
  report = { nativePid: process.pid, runtimeModule: ${JSON.stringify(nativeRuntimeUrl)}, ownerBefore,
    snapshot, snapshotChildren, savedWorker, savedAtomic, generation, absentAfterSwap, terminal, childrenAtTerminal, postRestoreDiscard, children,
    files: directories.map(relative => fs.readFileSync(path.join(root, 'cds', relative, 'fixture'), 'utf8')),
    workerPresent: fs.existsSync(worker), atomicPresent: fs.existsSync(atomic), restoredPrograms,
    relativeLink: fs.existsSync(relativeLink) ? fs.readlinkSync(relativeLink) : null,
    absoluteLink: fs.existsSync(absoluteLink) ? fs.readlinkSync(absoluteLink) : null,
    backupPresent: fs.existsSync(checkpoint.backupPath), ownerAfter: instance.observe(), finished: instance.finish(ticket) };
} finally {
  await instance.close(); await operation.close();
}
report.closed = true;
report.poolAfterClose = { active: operation.getStats().active, queued: operation.getStats().queued };
process.stdout.write(JSON.stringify(report));
`);
    // 外层也借真实owned池，原afterEach负责其回收；不是Vitest VM内native import。
    const result = await pool().execOwnedOperation(`${shellQuote(process.execPath)} ${shellQuote(runner)}`, {
      cwd: root, beforeStart: () => {},
    });
    expect(result.exitCode, result.stderr).toBe(0);
    const report = JSON.parse(result.stdout);
    expect(report.nativePid).toBeGreaterThan(1); expect(report.nativePid).not.toBe(process.pid);
    expect(report.runtimeModule).toBe(nativeRuntimeUrl);
    expect(report.ownerBefore).toMatchObject({ source: 'self-update', actor: 'native-dist-fixture', phase: 'prepare' });
    expect(report.snapshot).toMatchObject({ ownerId: report.ownerBefore.id, existed: [true, true, true, true, true] });
    expect(report.snapshotChildren).toHaveLength(1);
    expect(report.snapshotChildren[0].command).toContain(shellQuote(worker));
    expect(report.snapshotChildren[0].command).not.toContain('--import tsx');
    expect(report.snapshotChildren[0].result.exitCode).toBe(0);
    expect(report.savedWorker).toBe(true); expect(report.savedAtomic).toBe(true);
    expect(report.generation).toBe('old-without-maintenance-worker');
    expect(report.absentAfterSwap).toEqual({ worker: true, atomic: true });
    expect(report.closed).toBe(true); expect(report.poolAfterClose).toEqual({ active: 0, queued: 0 });
    expect.soft(report.childrenAtTerminal).toHaveLength(2);
    expect.soft(report.children[1]?.command).not.toContain('--import tsx');
    expect.soft(report.terminal).toMatchObject({ receipt: { action, ownerId: report.ownerBefore.id, artifactsRestored: action === 'restore' } });
    for (const relative of directories) {
      expect.soft(report.files[directories.indexOf(relative)])
        .toBe(`${action === 'restore' ? 'old' : 'new'}:${relative}`);
    }
    expect.soft(report.ownerAfter).toMatchObject({ id: report.ownerBefore.id, source: 'self-update', actor: 'native-dist-fixture' });
    if (action === 'restore') {
      expect.soft(report.children).toHaveLength(3);
      expect.soft(report.postRestoreDiscard).toMatchObject({ receipt: { action: 'discard', ownerId: report.ownerBefore.id, artifactsRestored: false } });
      const cleanupChild = report.children[2];
      expect.soft(cleanupChild?.command).toBe(`${shellQuote(process.execPath)} ${shellQuote(worker)}`);
      expect.soft(cleanupChild?.command ?? '').not.toContain(path.join(root, 'cds/.cds'));
      expect.soft(cleanupChild?.command ?? '').not.toContain('--import tsx');
      expect.soft(cleanupChild?.result.exitCode).toBe(0);
      expect.soft(report.workerPresent).toBe(true); expect.soft(report.atomicPresent).toBe(true);
      expect.soft(report.restoredPrograms).toBe(true);
      expect.soft(report.relativeLink).toBe(rawRelative); expect.soft(report.absoluteLink).toBe(rawAbsolute);
      expect.soft(report.backupPresent).toBe(false);
    } else {
      expect.soft(report.children).toHaveLength(2);
      expect.soft(report.workerPresent).toBe(false);
      expect.soft(report.backupPresent).toBe(false);
    }
    expect.soft(report.finished).toBe(true);
  });
});
