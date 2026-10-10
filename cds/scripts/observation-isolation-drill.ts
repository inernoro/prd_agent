import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { ShellExecutor } from '../src/services/shell-executor.js';
import { IsolatedShellExecutor } from '../src/services/isolated-shell-executor.js';
import { ContainerService } from '../src/services/container.js';
import { collectContainerDiagnostics } from '../src/services/container-diagnostics.js';
import type { CdsConfig } from '../src/types.js';

const sourcePaths = ['src/services/isolated-shell-executor.ts', 'src/services/shell-executor-worker.ts', 'src/services/shell-executor.ts', 'src/services/container.ts', 'src/services/container-diagnostics.ts', 'src/index.ts', 'src/types.ts'];
async function main(): Promise<void> {
  // 只允许本次 GitHub 隔离宿主，不能用于 SSH 或共享 CDS 宿主。
  assert.equal(process.env.GITHUB_ACTIONS, 'true');
  assert.equal(os.platform(), 'linux');
  assert.match(process.env.GITHUB_RUN_ID || '', /^\d+$/);
  const host = 'unix:///var/run/docker.sock';
  const docker = (args: string[]): string => execFileSync('docker', ['--host', host, ...args], { encoding: 'utf8', timeout: 120000 }).trim();
  const owner = `cds_observe_${randomBytes(8).toString('hex')}`;
  const name = `${owner}-app`;
  const output = path.resolve('observation-output');
  await fs.mkdir(output, { recursive: true, mode: 0o700 });
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'cds-observe-ci-'));
  await fs.chmod(temp, 0o700);
  const compiled = process.argv.includes('--compiled');
  const module = compiled ? await import(new URL('../dist/services/isolated-shell-executor.js', import.meta.url).href) as typeof import('../src/services/isolated-shell-executor.js') : { IsolatedShellExecutor };
  const previousHost = process.env.DOCKER_HOST;
  const previousContext = process.env.DOCKER_CONTEXT;
  delete process.env.DOCKER_CONTEXT;
  process.env.DOCKER_HOST = host;
  const shell = new module.IsolatedShellExecutor(new ShellExecutor(), { concurrency: 2, maxQueued: 16 });
  const container = new ContainerService(shell, { repoRoot: temp, worktreeBase: temp, dockerNetwork: 'bridge', sharedEnv: {}, jwt: { secret: randomBytes(32).toString('hex'), issuer: 'isolated' } } as CdsConfig);
  const report: Record<string, any> = {
    schema: 1, startedAt: new Date().toISOString(), head: execFileSync('/usr/bin/git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    sourceHashes: Object.fromEntries(await Promise.all(sourcePaths.map(async file => [file, createHash('sha256').update(await fs.readFile(file)).digest('hex')]))),
    mode: compiled ? 'compiled' : 'source', scope: 'bounded observation worker and real owned Docker reads; no application deployment or public performance acceptance',
    actualDockerReadVerified: false, actualDeploymentVerified: false, performanceVerified: false,
    verdict: 'failed', checks: [], ownedContainerRemoved: false, isolatedFilesRemoved: false,
  };
  let id: string | undefined;
  const owned = (): void => {
    assert.match(id || '', /^[a-f0-9]{64}$/);
    const view = JSON.parse(docker(['inspect', id!]))[0];
    assert.equal(view.Name, `/${name}`);
    assert.equal(view.Config.Labels['cds.acceptance.owner'], owner);
    assert.equal(view.Config.Image, 'alpine:3.20');
    assert.deepEqual(view.Config.Cmd, ['sh', '-c', 'echo owned-observation; sleep 300']);
    assert.equal(view.HostConfig.NanoCpus, 250000000);
    assert.equal(view.HostConfig.Memory, 67108864);
    assert.equal(view.HostConfig.NetworkMode, 'none');
  };
  try {
    report.stage = 'create-owned-container';
    docker(['pull', 'alpine:3.20']);
    id = docker(['run', '-d', '--name', name, '--label', `cds.acceptance.owner=${owner}`, '--network', 'none', '--cpus', '0.25', '--memory', '64m', 'alpine:3.20', 'sh', '-c', 'echo owned-observation; sleep 300']);
    owned();
    report.stage = 'real-container-reads';
    assert.equal(await container.isRunning(id), true);
    const diagnostics = await collectContainerDiagnostics(shell, id, 20);
    assert.equal((diagnostics.inspect?.state as Record<string, unknown>)?.running, true);
    assert.ok(JSON.stringify(diagnostics.logs).includes('owned-observation'));
    report.checks.push({ name: 'real-container-running-and-diagnostics', passed: true });
    report.stage = 'bounded-read-concurrency';
    const requests = Array.from({ length: 8 }, () => container.isRunning(id!));
    assert.ok(shell.getStats().active <= 2 && shell.getStats().queued >= 6);
    assert.ok((await Promise.all(requests)).every(Boolean));
    report.checks.push({ name: 'eight-real-reads-bounded-concurrency', passed: true });
    report.stage = 'queued-deadline-cancellation';
    const cancel = new AbortController();
    const sentinel = path.join(temp, 'must-not-start');
    const active = [shell.exec('sleep 0.5', { executionLane: 'observation' }), shell.exec('sleep 0.5', { executionLane: 'observation' })];
    const expired = assert.rejects(shell.exec(`touch '${sentinel}'`, { executionLane: 'observation', timeout: 50 }), { code: 'deadline' });
    const cancelled = assert.rejects(shell.exec(`touch '${sentinel}'`, { executionLane: 'observation', signal: cancel.signal }), { code: 'cancelled' });
    cancel.abort();
    await Promise.all([...active, expired, cancelled]);
    await assert.rejects(fs.access(sentinel), { code: 'ENOENT' });
    report.checks.push({ name: 'expired-and-cancelled-never-start', passed: true });
    report.stage = 'active-process-tree-cleanup';
    const pidFile = path.join(temp, 'child.pid');
    const deadline = assert.rejects(shell.exec(`sleep 30 & echo $! > '${pidFile}'; wait`, { executionLane: 'observation', timeout: 500 }), { code: 'deadline' });
    await deadline;
    const pid = Number((await fs.readFile(pidFile, 'utf8')).trim());
    assert.ok(Number.isSafeInteger(pid) && pid > 1);
    const state = await new ShellExecutor().exec(`ps -o stat= -p ${pid}`);
    assert.match(state.stdout.trim(), /^(Z.*)?$/);
    assert.equal(await container.isRunning(id), true);
    report.checks.push({ name: 'timeout-process-tree-cleaned-owned-container-retained', passed: true });
    report.workerStats = shell.getStats();
    report.actualDockerReadVerified = true;
    report.verdict = 'passed';
    report.stage = 'completed';
  } catch (error) {
    report.failure = { name: error instanceof Error ? error.name : 'Error',
      ...(error && typeof error === 'object' && 'code' in error ? { code: String(error.code).slice(0, 100) } : {}) };
    process.exitCode = 1;
  } finally {
    await shell.close();
    if (id) {
      try { owned(); docker(['rm', '-f', id]); report.ownedContainerRemoved = true; }
      catch { report.verdict = 'failed'; process.exitCode = 1; }
    }
    await fs.rm(temp, { recursive: true, force: true });
    report.isolatedFilesRemoved = true;
    if (previousHost === undefined) delete process.env.DOCKER_HOST; else process.env.DOCKER_HOST = previousHost;
    if (previousContext !== undefined) process.env.DOCKER_CONTEXT = previousContext;
    report.finishedAt = new Date().toISOString();
    await fs.writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2), { mode: 0o600 });
  }
}
void main().catch(() => { process.exitCode = 1; });
