import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { StateService } from '../src/services/state.js';
import { ContainerService } from '../src/services/container.js';
import { ShellExecutor } from '../src/services/shell-executor.js';
import { WorktreeService } from '../src/services/worktree.js';
import { BranchOperationCoordinator } from '../src/services/branch-operation-coordinator.js';
import { DeploymentRunService } from '../src/services/deployment-run.js';
import { captureDeploymentInput } from '../src/services/deployment-input.js';
import { createBranchRouter } from '../src/routes/branches.js';
import type { CdsConfig, IShellExecutor, ExecOptions } from '../src/types.js';

export const STOP_REFERENCE_HEAD = '1fd44e98489f312eee3fa0ff6fe47a6b0d44e4b8';
export const STOP_PROBE_PROGRAM = "require('http').createServer((q,r)=>{r.setHeader('Content-Type','application/json');r.end(JSON.stringify({service:process.env.SERVICE_NAME,version:'original'}));}).listen(3000,'0.0.0.0');";
const sourcePaths = ['src/services/container.ts', 'src/routes/branches.ts'];
export function readStopReferenceSource(name: string): Buffer {
  assert.ok(sourcePaths.includes(name));
  return execFileSync('/usr/bin/git', ['show', `${STOP_REFERENCE_HEAD}:cds/${name}`], { maxBuffer: 8 * 1024 * 1024, timeout: 30000 });
}
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
function assertCi(): void {
  assert.equal(process.env.GITHUB_ACTIONS, 'true'); assert.equal(os.platform(), 'linux');
  assert.match(process.env.GITHUB_RUN_ID || '', /^\d+$/);
}
function docker(args: string[]): string {
  return execFileSync('docker', ['--host', 'unix:///var/run/docker.sock', ...args], { encoding: 'utf8', timeout: 120000 }).trim();
}
export function assertOwnedStopContainer(view: any, owner: string, name: string): void {
  assert.match(owner, /^cds_stop_[a-f0-9]{16}$/);
  assert.ok(['api', 'web', 'other'].some((role) => name === `${owner}-${role}`));
  assert.match(view.Id, /^[a-f0-9]{64}$/); assert.equal(view.Name, `/${name}`);
  assert.equal(view.Config.Labels['cds.acceptance.owner'], owner); assert.equal(view.Config.Image, 'node:22-alpine');
  assert.equal(view.HostConfig.NetworkMode, 'bridge');
  assert.equal(view.HostConfig.NanoCpus, 250000000); assert.equal(view.HostConfig.Memory, 134217728);
  assert.deepEqual(view.Config.Cmd, ['node', '-e', STOP_PROBE_PROGRAM]);
  assert.equal(view.HostConfig.PortBindings['3000/tcp'][0].HostIp, '127.0.0.1');
  const binding = view.NetworkSettings.Ports?.['3000/tcp']?.[0];
  // 已停止的容器保留声明，实际发布端口可能在停止后清空。
  if (binding) { assert.equal(binding.HostIp, '127.0.0.1'); assert.match(binding.HostPort, /^\d+$/); assert.ok(Number(binding.HostPort) >= 1024 && Number(binding.HostPort) <= 65535); }
}
export function assertStopCommandTarget(command: string, names: string[]): string {
  for (const name of names) {
    assert.match(name, /^cds_stop_[a-f0-9]{16}-(api|web|other)$/);
    const regular = new RegExp(`^docker (?:stop|restart|inspect(?: --format="\\{\\{\\.State\\.(?:Status|Running)\\}\\}")?|logs --timestamps --tail [1-9][0-9]{0,2}) (?:${name}|'${name}')$`);
    if (regular.test(command) || command === `docker inspect --format="{{.State.Status}}|{{.State.ExitCode}}" ${name}`) return name;
    const prefix = `docker exec ${name} sh -c "echo '[CDS-STOP] reason=`;
    const suffix = "' > /proc/1/fd/1 2>/dev/null\"";
    if (command.startsWith(prefix) && command.endsWith(suffix)) {
      assert.match(command.slice(prefix.length, -suffix.length), /^[- a-zA-Z0-9_.:=一-龥　-〿＀-￯]+$/); return name;
    }
  }
  throw new Error('Only exact commands for owned stop-drill containers are allowed');
}
async function freePort(): Promise<number> {
  const listener = http.createServer();
  await new Promise<void>((resolve) => listener.listen(0, '127.0.0.1', resolve));
  const address = listener.address(); assert.ok(address && typeof address !== 'string');
  await new Promise<void>((resolve) => listener.close(() => resolve())); return address.port;
}
async function ready(check: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) { try { if (await check()) return; } catch { /* application startup */ } await new Promise((resolve) => setTimeout(resolve, 250)); }
  throw new Error('Owned application did not become ready');
}

export async function main(): Promise<void> {
  assertCi();
  const reference = process.env.CDS_ACCEPTANCE_REFERENCE;
  if (reference) assert.equal(reference, STOP_REFERENCE_HEAD);
  const output = path.resolve('stop-output', reference ? 'reference' : 'candidate'); await fs.mkdir(output, { recursive: true, mode: 0o700 });
  const head = execFileSync('/usr/bin/git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const owner = `cds_stop_${randomBytes(8).toString('hex')}`;
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'cds-stop-ci-')); await fs.chmod(temp, 0o700);
  const file = path.join(temp, 'state.json'); const state = new StateService(file); state.load();
  const config: CdsConfig = { repoRoot: temp, worktreeBase: path.join(temp, 'worktrees'), masterPort: 0, workerPort: 5500,
    dockerNetwork: 'bridge', mode: 'standalone', executorPort: 5501, portStart: 10001, rootDomains: ['invalid'], previewDomain: 'invalid', sharedEnv: {}, jwt: { secret: randomBytes(32).toString('hex'), issuer: 'isolated-drill' } };
  const members: Array<{ id: string; name: string; role: string; port: number }> = [];
  const report: any = { schema: 1, startedAt: new Date().toISOString(), head, stopReferenceRevision: reference || null,
    sourceHashes: Object.fromEntries(await Promise.all(sourcePaths.map(async (name) => [name, hash(await fs.readFile(name))]))),
    verdict: 'failed', scope: 'isolated real branch stop HTTP and container state; no build/deploy/storm acceptance',
    actualStopVerified: false, actualDeploymentVerified: false, performanceVerified: false,
    runner: { host: os.hostname(), cpus: os.cpus().length, totalMemoryBytes: os.totalmem(), githubRunId: process.env.GITHUB_RUN_ID },
    containers: [], checks: [], commands: [], commandFailures: [], containersRemoved: false, isolatedFilesRemoved: false };
  let server: http.Server | undefined, failedSocket = true, supersedeAfterStop = false;
  const coordinator = new BranchOperationCoordinator();
  function inspect(member: typeof members[number]): any {
    assert.ok(members.includes(member)); const view = JSON.parse(docker(['inspect', member.id]))[0];
    assert.equal(view.Id, member.id); assertOwnedStopContainer(view, owner, member.name); return view;
  }
  const realShell = new ShellExecutor();
  const shell: IShellExecutor = { exec: async (command: string, options?: ExecOptions) => {
    let stage = 'command-target';
    try {
    const name = assertStopCommandTarget(command, members.map((m) => m.name)); const member = members.find((m) => m.name === name)!;
    stage = 'owned-container'; inspect(member);
    stage = 'cancellation-on-disk';
    const isStop = command === `docker stop ${name}`;
    if (isStop) {
      const disk = JSON.parse(await fs.readFile(file, 'utf8'));
      report.checks.push({ phase: 'before-stop-disk', role: member.role, runStatus: disk.deploymentRuns?.dr_actual_stop?.status ?? null, intentPresent: Boolean(disk.deploymentIntents?.dr_actual_stop) });
      assert.equal(disk.deploymentRuns.dr_actual_stop.status, 'cancelled'); assert.equal(disk.deploymentIntents?.dr_actual_stop, undefined);
    }
    stage = 'owned-shell-command';
    const socket = failedSocket && isStop && member.role === 'api' ? `unix://${temp}/missing.sock` : 'unix:///var/run/docker.sock';
    const result = await realShell.exec(command.replace(/^docker /, `docker --host ${socket} `), { ...options, timeout: Math.min(options?.timeout || 30000, 30000) });
    report.commands.push({ kind: command.split(' ')[1], containerId: member.id, exitCode: result.exitCode, transportFault: socket.endsWith('missing.sock'), cancellationPersistedBeforeStop: isStop || undefined });
    if (supersedeAfterStop && isStop) {
      supersedeAfterStop = false; coordinator.begin({ projectId: 'p', branchId: 'b', kind: 'reset', trigger: 'manual' });
      const entry = state.getBranch('b')!; entry.status = 'error'; entry.services.web.errorMessage = 'newer-owned-operation'; state.save();
    }
    return result;
    } catch (error) {
      const detail = error as Error & { actual?: unknown; expected?: unknown };
      const scalar = (value: unknown) => typeof value === 'boolean' || typeof value === 'number' ? value : typeof value === 'string' ? value.slice(0, 120) : typeof value;
      report.commandFailures.push({ kind: command.split(' ')[1], stage, errorName: detail.name, actual: scalar(detail.actual), expected: scalar(detail.expected) });
      throw error;
    }
  } };
  async function probe(member: typeof members[number]): Promise<any> {
    const response = await fetch(`http://127.0.0.1:${member.port}/`, { signal: AbortSignal.timeout(3000) }); assert.equal(response.status, 200);
    const body = await response.json() as any; assert.equal(body.service, member.role); assert.equal(body.version, 'original'); return body;
  }
  async function request(route: string): Promise<{ status: number; body: any }> {
    const address = server!.address(); assert.ok(address && typeof address !== 'string');
    const response = await fetch(`http://127.0.0.1:${address.port}/api/branches/b/${route}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(60000) });
    return { status: response.status, body: await response.json() };
  }
  try {
    docker(['pull', 'node:22-alpine']);
    if (!reference) {
      const previous = JSON.parse(await fs.readFile(path.resolve('stop-output/reference/report.json'), 'utf8'));
      assert.equal(JSON.parse(docker(['image', 'inspect', 'node:22-alpine']))[0].Id, previous.containers[0].image);
    }
    for (const role of ['api', 'web', 'other']) {
      const name = `${owner}-${role}`, port = await freePort(); const id = docker(['run', '-d', '--network', 'bridge', '--name', name, '--cpus', '0.25', '--memory', '128m', '--label', `cds.acceptance.owner=${owner}`,
        '-p', `127.0.0.1:${port}:3000`, '-e', `SERVICE_NAME=${role}`, 'node:22-alpine', 'node', '-e', STOP_PROBE_PROGRAM]);
      assert.match(id, /^[a-f0-9]{64}$/); const member = { id, name, role, port }; members.push(member); const view = inspect(member);
      assert.equal(Number(view.NetworkSettings.Ports['3000/tcp'][0].HostPort), port);
      report.containers.push({ id, name, role, port, image: view.Image, cpuLimit: view.HostConfig.NanoCpus, memoryLimit: view.HostConfig.Memory });
      await ready(async () => { await probe(member); return true; });
    }
    const [api, web, other] = members;
    const now = new Date().toISOString(); state.addProject({ id: 'p', slug: owner, name: '隔离停止', kind: 'git', createdAt: now, updatedAt: now });
    state.addProject({ id: 'other', slug: `${owner}-other`, name: '隔离其他项目', kind: 'git', createdAt: now, updatedAt: now });
    state.addBranch({ id: 'b', projectId: 'p', branch: 'main', worktreePath: temp, status: 'running', createdAt: now, services: Object.fromEntries([api, web].map((m) => [m.role, { profileId: m.role, containerName: m.name, hostPort: m.port, status: 'running' as const }])) });
    state.addBranch({ id: 'other-b', projectId: 'other', branch: 'main', worktreePath: temp, status: 'running', createdAt: now, services: { other: { profileId: 'other', containerName: other.name, hostPort: other.port, status: 'running' } } });
    const runs = new DeploymentRunService(state, { idFactory: () => 'dr_actual_stop' }); coordinator.begin({ projectId: 'p', branchId: 'b', kind: 'deploy', trigger: 'manual' });
    const operation = coordinator.begin({ projectId: 'p', branchId: 'b', kind: 'deploy', trigger: 'webhook', commitSha: 'd'.repeat(40), commitPinned: true, configHash: 'stop-config' }); assert.equal(operation.status, 'merged');
    const queuedRequest = { projectId: 'p', branchId: 'b', kind: 'deploy' as const, trigger: 'webhook' as const, commitSha: 'd'.repeat(40), commitPinned: true, configHash: 'stop-config' };
    const input = captureDeploymentInput(state.getBranch('b')!, [], { TOKEN: 'synthetic-stop-input' }); input.configHash = 'stop-config';
    await runs.begin({ projectId: 'p', branchId: 'b', trigger: 'webhook', initialStatus: 'queued', operationId: operation.operationId, operationGeneration: operation.generation,
      commitSha: queuedRequest.commitSha, configHash: queuedRequest.configHash, executionInput: { request: queuedRequest, input } }); await state.flush();
    const containers = new ContainerService(shell, config); const app = express(); app.use(express.json());
    app.use('/api', createBranchRouter({ stateService: state, worktreeService: new WorktreeService(shell), containerService: containers, shell, config, branchOperationCoordinator: coordinator, deploymentRunService: runs }));
    server = await new Promise<http.Server>((resolve) => { const listener = app.listen(0, '127.0.0.1', () => resolve(listener)); });
    const failed = await request('stop'); const branch = state.getBranch('b')!;
    const first = { phase: 'stop-unconfirmed', httpStatus: failed.status, originalRunCancelled: runs.get('dr_actual_stop')?.status === 'cancelled',
      apiRunning: inspect(api).State.Running, webRunning: inspect(web).State.Running, unrelatedRunning: inspect(other).State.Running,
      apiResponse: await probe(api), unrelatedResponse: await probe(other), branchStatus: branch.status, apiState: branch.services.api.status, webState: branch.services.web.status, successfulStopCount: branch.stopCount || 0 };
    report.checks.push(first); assert.equal(failed.status, 503); assert.equal(first.apiRunning, true); assert.equal(first.webRunning, false); assert.equal(first.unrelatedRunning, true);
    assert.equal(branch.status, 'error'); assert.equal(branch.services.api.status, 'running'); assert.equal(branch.lastStoppedAt, undefined); assert.equal(branch.stopCount || 0, 0);
    const disk = JSON.parse(await fs.readFile(file, 'utf8')); assert.equal(disk.branches.b.services.api.status, 'running');
    const reopened = new StateService(file); reopened.load(); assert.equal(new DeploymentRunService(reopened).restoreQueued(new BranchOperationCoordinator()).length, 0);
    failedSocket = false; const confirmed = await request('stop');
    report.checks.push({ phase: 'retry-response', httpStatus: confirmed.status, failedServices: confirmed.body.failedServices ?? [] });
    assert.equal(confirmed.status, 200);
    assert.equal(inspect(api).State.Running, false); assert.equal(inspect(web).State.Running, false); await probe(other);
    assert.equal(branch.status, 'idle'); assert.equal(branch.stopCount, 1); assert.equal(JSON.parse(await fs.readFile(file, 'utf8')).branches.b.status, 'idle');
    report.checks.push({ phase: 'stop-confirmed', httpStatus: confirmed.status, originalContainerIdsPreserved: true, allTargetContainersStopped: true, unrelatedStillReady: true, cancelledQueueNotRestored: true, finalStatePersisted: true });
    const restarted = await request('restart'); assert.equal(restarted.status, 200);
    await ready(async () => { await probe(api); await probe(web); return true; }); await probe(other); assert.equal(inspect(api).Id, api.id); assert.equal(inspect(web).Id, web.id);
    report.checks.push({ phase: 'restart', httpStatus: restarted.status, sameOriginalContainerIds: true, originalVersionReady: true });
    const beforeStops = report.commands.filter((c: any) => c.kind === 'stop').length;
    const priorStoppedAt = branch.lastStoppedAt; supersedeAfterStop = true; const superseded = await request('stop'); assert.equal(superseded.status, 409);
    assert.equal(report.commands.filter((c: any) => c.kind === 'stop').length, beforeStops + 1);
    assert.equal(inspect(api).State.Running, false); assert.equal(inspect(web).State.Running, true); await probe(web); await probe(other);
    assert.equal(branch.status, 'error'); assert.equal(branch.services.web.errorMessage, 'newer-owned-operation'); assert.equal(branch.lastStoppedAt, priorStoppedAt);
    report.checks.push({ phase: 'superseded-stop', httpStatus: superseded.status, onlyFirstTargetStopped: true, nextTargetAndUnrelatedReady: true, newerStatePreserved: true });
    report.actualStopVerified = true; report.verdict = 'passed';
  } catch (error) { report.errorName = (error as Error).name; throw error; }
  finally {
    if (server) { server.closeAllConnections(); await new Promise<void>((resolve) => server!.close(() => resolve())); }
    try { await state.flush(); } catch { report.cleanupFailed = true; report.verdict = 'failed'; }
    let removed = 0;
    for (const member of members) { try { inspect(member); docker(['rm', '-fv', member.id]); removed++; } catch { report.cleanupFailed = true; report.verdict = 'failed'; } }
    report.containersRemoved = removed === members.length;
    await fs.rm(temp, { recursive: true, force: true }); report.isolatedFilesRemoved = true; report.finishedAt = new Date().toISOString();
    await fs.writeFile(path.join(output, 'report.json'), `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  }
  assert.equal(report.verdict, 'passed'); assert.equal(report.containersRemoved, true);
  process.stdout.write(`${JSON.stringify({ verdict: report.verdict, head, report: path.join(output, 'report.json') })}\n`);
}

export async function runReference(): Promise<void> {
  assertCi(); const originals = new Map<string, Buffer>();
  try {
    execFileSync('/usr/bin/git', ['fetch', '--depth', '1', 'origin', STOP_REFERENCE_HEAD], { stdio: 'pipe', timeout: 120000 });
    for (const name of sourcePaths) { originals.set(name, await fs.readFile(name)); await fs.writeFile(name, readStopReferenceSource(name)); }
    let exitCode = 0;
    try { execFileSync(process.execPath, ['--import', 'tsx', fileURLToPath(import.meta.url)], { env: { ...process.env, CDS_ACCEPTANCE_REFERENCE: STOP_REFERENCE_HEAD }, timeout: 180000, stdio: 'pipe' }); }
    catch (error) { exitCode = Number((error as any).status); }
    assert.equal(exitCode, 1);
    const report = JSON.parse(await fs.readFile(path.resolve('stop-output/reference/report.json'), 'utf8'));
    assert.equal(report.stopReferenceRevision, STOP_REFERENCE_HEAD); assert.equal(report.verdict, 'failed'); assert.equal(report.errorName, 'AssertionError');
    const check = report.checks.find((c: any) => c.phase === 'stop-unconfirmed'); assert.equal(check.httpStatus, 200); assert.equal(check.apiRunning, true); assert.equal(check.webRunning, false); assert.equal(check.originalRunCancelled, true);
    assert.equal(report.containersRemoved, true); assert.equal(report.isolatedFilesRemoved, true);
    for (const name of sourcePaths) assert.equal(report.sourceHashes[name], hash(readStopReferenceSource(name)));
    await fs.writeFile(path.resolve('stop-output/reference-validation.json'), `${JSON.stringify({ verdict: 'passed', scope: 'expected old stop implementation failure only', referenceRevision: STOP_REFERENCE_HEAD, referenceReportSha256: hash(await fs.readFile(path.resolve('stop-output/reference/report.json'))) }, null, 2)}\n`, { mode: 0o600 });
  } finally { for (const [name, bytes] of originals) { await fs.writeFile(name, bytes); assert.equal(hash(await fs.readFile(name)), hash(bytes)); } }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv[2] === '--reference') await runReference(); else { assert.equal(process.argv.length, 2); await main(); }
}
