import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';
import type { IsolatedShellExecutor } from '../src/services/isolated-shell-executor.js';
import { shellQuoteArg } from '../src/services/secure-database-cli.js';

export const FACTORY_REFERENCE_HEAD = 'e7fc2b30fb7de2e05d75c27aa774e7977009c281';

/** 原提交完整模块闭包独立编译，不覆写当前源码或绕过原执行类。仅供隔离CI。 */
export async function loadFactoryReference(root: string) {
  assert.equal(process.env.GITHUB_ACTIONS, 'true');
  execFileSync('/usr/bin/git', ['fetch', '--depth', '1', 'origin', FACTORY_REFERENCE_HEAD], { stdio: 'pipe', timeout: 120000 });
  await fs.mkdir(path.join(root, 'services'), { recursive: true, mode: 0o700 });
  await fs.writeFile(path.join(root, 'package.json'), '{"type":"module"}\n', { mode: 0o600 });
  const sourceHashes: Record<string, string> = {}, compiledFactoryHashes: Record<string, string> = {};
  for (const name of ['isolated-shell-executor', 'observation-supervisor-process', 'observation-executor-process',
    'observation-process-launcher', 'observation-process-group', 'observation-process', 'shell-executor']) {
    const sourcePath = `src/services/${name}.ts`;
    const source = execFileSync('/usr/bin/git', ['show', `${FACTORY_REFERENCE_HEAD}:cds/${sourcePath}`], { timeout: 30000 });
    sourceHashes[sourcePath] = createHash('sha256').update(source).digest('hex');
    const compiled = ts.transpileModule(source.toString('utf8'), { fileName: `${name}.ts`, reportDiagnostics: true,
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022, useDefineForClassFields: true,
        newLine: ts.NewLineKind.LineFeed, sourceMap: true, removeComments: false } });
    assert.equal(compiled.diagnostics?.filter(diagnostic => diagnostic.category === ts.DiagnosticCategory.Error).length ?? 0, 0);
    compiledFactoryHashes[name] = createHash('sha256').update(compiled.outputText).digest('hex');
    await fs.writeFile(path.join(root, 'services', `${name}.js`), compiled.outputText, { mode: 0o600 });
    if (compiled.sourceMapText) await fs.writeFile(path.join(root, 'services', `${name}.js.map`), compiled.sourceMapText, { mode: 0o600 });
  }
  const factory = await import(pathToFileURL(path.join(root, 'services/isolated-shell-executor.js')).href) as typeof import('../src/services/isolated-shell-executor.js');
  const shell = await import(pathToFileURL(path.join(root, 'services/shell-executor.js')).href) as typeof import('../src/services/shell-executor.js');
  return { factory, shell, head: FACTORY_REFERENCE_HEAD, sourceHashes, compiledFactoryHashes, compilerVersion: ts.version };
}

export function ownedProcessStates(pids: number[]): Array<{ pid: number; state: string }> {
  return pids.map(pid => {
    assert.ok(Number.isSafeInteger(pid) && pid > 1);
    let state = '';
    try { state = execFileSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8' }).trim(); }
    catch (error: any) { assert.equal(error.status, 1); assert.equal(String(error.stdout || '').trim(), ''); }
    assert.match(state, /^(Z.*)?$/); return { pid, state };
  });
}

/** 只观察原IPC创建回执，并暂停本调用的真实替换进程；原消息处理保持。 */
export async function probeReplacementBoot(pool: IsolatedShellExecutor, temp: string, prefix: string,
  expectedUnavailable: boolean, receipt: Record<string, any>): Promise<void> {
  const before = pool.getStats(); receipt.before = before;
  const channel = (pool as unknown as { factory: import('node:child_process').ChildProcess }).factory;
  assert.equal(channel.pid, before.supervisorPid);
  const executions = path.join(temp, `${prefix}-once`), childFile = path.join(temp, `${prefix}-child`);
  let originalFailure: string | undefined;
  const previous = pool.exec(`echo once >> ${shellQuoteArg(executions)}; sleep 30 & echo $! > ${shellQuoteArg(childFile)}; wait`,
    { executionLane: 'observation', timeout: 15_000 }).catch(error => { originalFailure = error.code; });
  let childPid = 0;
  const producerDeadline = performance.now() + 5000;
  while (performance.now() < producerDeadline) {
    try { childPid = Number(await fs.readFile(childFile, 'utf8')); if (childPid > 1) break; } catch { /* 等本调用的生产者 */ }
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  receipt.originalTaskChildPid = childPid; assert.ok(childPid > 1);
  let pausedFactory = 0, pauseError: unknown;
  const created: number[] = [];
  const listener = (message: any): void => {
    if (message.type !== 'factory-started' || message.pid === before.factoryPid) return;
    created.push(message.pid);
    if (!pausedFactory) { pausedFactory = message.pid; try { process.kill(pausedFactory, 'SIGSTOP'); } catch (error) { pauseError = error; } }
  };
  channel.on('message', listener);
  try {
    process.kill(-before.factoryPid!, 'SIGKILL'); await previous;
    receipt.originalTaskError = originalFailure; assert.equal(originalFailure, 'unavailable');
    receipt.originalTaskExecutions = (await fs.readFile(executions, 'utf8')).trim().split('\n').length;
    assert.equal(receipt.originalTaskExecutions, 1);
    receipt.initialCleaned = ownedProcessStates([before.factoryPid!, ...before.actors.map(actor => actor.pid), childPid]);
    const creationDeadline = performance.now() + 5000;
    while (!pausedFactory && performance.now() < creationDeadline) await new Promise(resolve => setTimeout(resolve, 10));
    receipt.pausedFactory = pausedFactory; assert.ok(pausedFactory > 1); assert.equal(pauseError, undefined);
    assert.equal(pool.getStats().unavailable, true);
    receipt.pausedState = execFileSync('ps', ['-o', 'stat=', '-p', String(pausedFactory)], { encoding: 'utf8' }).trim();
    assert.match(receipt.pausedState, /^T/);
    const started = performance.now(), observedDeadline = started + 6500;
    while (pool.getStats().unavailable && performance.now() < observedDeadline) await new Promise(resolve => setTimeout(resolve, 20));
    receipt.after = pool.getStats(); receipt.elapsedMs = performance.now() - started;
    receipt.deadlineMs = 5000; receipt.observedDeadlineMs = 6500; receipt.createdFactoryPids = created;
    assert.equal(receipt.after.unavailable, expectedUnavailable);
    assert.equal(receipt.after.supervisorPid, before.supervisorPid);
    for (const key of ['maxQueued', 'maxBytes', 'reservedCleanup', 'reservedCleanupBytes']) assert.equal(receipt.after[key], before[key as keyof typeof before]);
    if (expectedUnavailable) {
      assert.equal(receipt.after.factoryPid, pausedFactory); assert.equal(created.length, 1);
      await assert.rejects(pool.exec('echo must-not-start', { executionLane: 'observation', timeout: 1000 }), { code: 'unavailable' });
      receipt.expectedOriginalFailureVerified = true;
    } else {
      assert.ok(receipt.after.factoryPid && receipt.after.factoryPid !== pausedFactory); assert.equal(created.length, 2);
      receipt.stoppedState = ownedProcessStates([pausedFactory])[0].state;
      assert.equal(Number(execFileSync('ps', ['-o', 'ppid=', '-p', String(receipt.after.factoryPid)], { encoding: 'utf8' }).trim()), before.supervisorPid);
      const resumed = await pool.exec('echo after-boot-timeout', { executionLane: 'observation', timeout: 5000 });
      assert.equal(resumed.stdout.trim(), 'after-boot-timeout'); receipt.newRequest = resumed.stdout.trim();
    }
    assert.equal((await fs.readFile(executions, 'utf8')).trim(), 'once');
  } finally { channel.off('message', listener); }
}
