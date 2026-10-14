import assert from 'node:assert/strict';
import os from 'node:os';
import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { StateService } from '../src/services/state.js';
import { ContainerService } from '../src/services/container.js';
import { ShellExecutor } from '../src/services/shell-executor.js';
import { reserveServiceReplacements, commitServiceReplacements } from '../src/services/service-replacement.js';
import { runtimeRef } from '../src/services/service-runtime.js';
import { resolveBranchUpstream } from '../src/services/proxy.js';
import { stopServiceForCooling } from '../src/services/scheduler-service-stop.js';
import { SchedulerService } from '../src/services/scheduler.js';
import { DeploymentPhaseBudget, deploymentPhaseBudget } from '../src/services/deployment-phase-budget.js';
import type { BranchEntry, CdsConfig, IShellExecutor, ServiceState } from '../src/types.js';

// Only exact, owned fixtures on a disposable GitHub runner. No production credentials or endpoints.
assert.equal(process.env.GITHUB_ACTIONS, 'true');
assert.equal(os.platform(), 'linux');
assert.match(process.env.GITHUB_RUN_ID || '', /^\d+$/);
const owner = `cds-memory-${randomBytes(8).toString('hex')}`;
const names: string[] = [], networks: string[] = [];
const ownedIds = new Set<string>();
const output = path.resolve('runtime-memory-output'); await fs.mkdir(output, { recursive: true });
const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'cds-memory-'));
const report: any = { owner, sourceHead: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  githubRunId: process.env.GITHUB_RUN_ID, startedAt: new Date().toISOString(), verdict: 'failed',
  scope: 'real runtime replacement, cleanup, cooling retry and reservation contention; not full platform load or 48h acceptance', checks: [] };
function docker(args: string[], timeout = 30000): string {
  return execFileSync('docker', args, { encoding: 'utf8', timeout, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}
function inspect(id: string): any { return JSON.parse(docker(['inspect', id]))[0]; }
function owned(id: string): any {
  const view = inspect(id); assert.equal(view.Config.Labels['cds.acceptance.owner'], owner);
  assert.ok(names.includes(view.Name.slice(1))); assert.equal(view.HostConfig.Memory, 134217728);
  assert.equal(view.HostConfig.NanoCpus, 250000000); return view;
}
const shell = new ShellExecutor(); let transportFault = false;
const checkedShell: IShellExecutor = { exec: async (command, options) => {
  // ContainerService commands may use names or CIDs. All references must be from this fixture set.
  for (const token of command.match(/\b[a-f0-9]{64}\b/g) || []) assert.ok(ownedIds.has(token));
  assert.ok(command.startsWith('docker '));
  return shell.exec(transportFault ? command.replace(/^docker /, `docker --host unix://${temp}/absent.sock `) : command, options);
} };
const state = new StateService(path.join(temp, 'state.json')); state.load();
const config = { repoRoot: temp, worktreeBase: temp, dockerNetwork: 'bridge', sharedEnv: {}, masterPort: 0,
  workerPort: 5500, portStart: 20000, jwt: { secret: 'private-fixture', issuer: owner } } as CdsConfig;
const container = new ContainerService(checkedShell, config);
const entry = { id: owner, projectId: owner, branch: 'feature-owned', worktreePath: temp,
  createdAt: new Date().toISOString(), status: 'running', heatState: 'cold', services: {} } as BranchEntry;
state.addBranch(entry);
async function freePort(): Promise<number> {
  const s = http.createServer(); await new Promise<void>(r => s.listen(0, '127.0.0.1', r));
  const a = s.address(); assert.ok(a && typeof a !== 'string'); await new Promise<void>(r => s.close(() => r())); return a.port;
}
function network(name: string): void {
  networks.push(name); docker(['network', 'create', '--label', `cds.acceptance.owner=${owner}`,
    '--label', 'cds.type=replacement-network', '--label', `cds.project.id=${owner}`, '--label', `cds.branch.id=${owner}`, name]);
}
async function launch(runtime: ServiceState, version: string, mode: 'ready' | 'exit' | 'unready' = 'ready'): Promise<void> {
  names.push(runtime.containerName); runtime.hostPort = await freePort();
  const program = mode === 'exit' ? 'process.exit(1)' :
    `require('http').createServer((q,r)=>{r.statusCode=${mode === 'unready' ? 503 : 200};r.setHeader('content-type','application/json');r.end(JSON.stringify({version:process.env.FIXTURE_VERSION}));}).listen(3000,'0.0.0.0');`;
  runtime.containerId = docker(['run', '-d', '--name', runtime.containerName, '--network', runtime.networkName!, '--network-alias', 'api',
    '--label', `cds.acceptance.owner=${owner}`, '--label', `cds.project.id=${owner}`, '--label', `cds.branch.id=${owner}`,
    '--label', 'cds.profile.id=api', '--memory', '128m', '--cpus', '.25', '--pids-limit', '64',
    '-p', `127.0.0.1:${runtime.hostPort}:3000`, '-e', `FIXTURE_VERSION=${version}`, 'node:22-alpine', 'node', '-e', program]);
  runtime.creationIssued = true; runtime.sourceCommitSha = version;
  owned(runtime.containerId); ownedIds.add(runtime.containerId);
  deploymentPhaseBudget.reserveKnownMemory(runtime.containerName, 512, { branchId: owner });
}
async function request(runtime: ServiceState, expected?: string): Promise<boolean> {
  try { const r = await fetch(`http://127.0.0.1:${runtime.hostPort}`, { signal: AbortSignal.timeout(1000) });
    return r.status === 200 && (!expected || (await r.json() as any).version === expected); } catch { return false; }
}
async function ready(runtime: ServiceState, version: string): Promise<void> {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) { if (await request(runtime, version)) return; await new Promise(r => setTimeout(r, 100)); }
  throw new Error('Owned HTTP readiness deadline exceeded');
}
async function served(expected: string): Promise<void> {
  const url = resolveBranchUpstream(entry, 'api'); assert.ok(url);
  const r = await fetch(url, { signal: AbortSignal.timeout(1500) }); assert.equal(r.status, 200);
  assert.equal((await r.json() as any).version, expected);
}
function candidate(): ServiceState {
  reserveServiceReplacements({ entry, profileIds: ['api'], state, portStart: 20000 });
  network(entry.replacementNetwork!);
  return { profileId: 'api', ...entry.services.api.pendingRuntime!, status: 'starting' };
}
async function publish(candidateService: ServiceState): Promise<void> {
  const old = entry.services.api.servingRuntime!;
  Object.assign(entry.services.api, runtimeRef(candidateService), candidateService, { servingRuntime: old, pendingRuntime: runtimeRef(candidateService) });
  await commitServiceReplacements({ entry, profileIds: ['api'], state, container });
}
try {
  docker(['info']); docker(['pull', 'node:22-alpine'], 120000);
  const oldNetwork = `${owner}-old`; network(oldNetwork);
  const old: ServiceState = { profileId: 'api', containerName: `${owner}-old`, hostPort: 0, networkName: oldNetwork, status: 'running' };
  await launch(old, 'old'); await ready(old, 'old'); const originalId = old.containerId!;
  old.servingRuntime = runtimeRef(old); entry.services.api = old;
  await served('old');
  const staleIdentity = candidate();
  Object.assign(staleIdentity, { containerId: originalId, creationIssued: true, status: 'error' });
  await publish(staleIdentity); await served('old'); assert.equal(owned(originalId).State.Running, true);
  report.checks.push({ case: 'stale-candidate-cid', confirmedServingCidProtected: true, actualOldHttpVersion: 'old' });
  const absent = candidate();
  assert.throws(() => docker(['create', '--pull=never', '--name', absent.containerName, `${owner}:missing`]), /Command failed/);
  absent.status = 'error'; absent.creationIssued = false; await publish(absent); await served('old');
  report.checks.push({ case: 'missing-image', oldVersion: 'old', oldRunning: owned(originalId).State.Running, noCutover: true });
  for (const mode of ['exit', 'unready'] as const) {
    const next = candidate(); await launch(next, mode, mode);
    await new Promise(r => setTimeout(r, 1000)); assert.equal(await request(next), false);
    if (mode === 'exit') assert.equal(owned(next.containerId!).State.ExitCode, 1);
    next.status = 'error'; next.errorMessage = mode; await publish(next); await served('old');
    assert.throws(() => inspect(next.containerId!));
    assert.equal(deploymentPhaseBudget.memorySnapshot().some(row => row.key === next.containerName), false);
    report.checks.push({ case: mode === 'exit' ? 'startup-failure' : 'readiness-failure', oldVersion: 'old', candidateRemoved: true, reservationReleased: true });
  }
  const budget = new DeploymentPhaseBudget(() => os.freemem() / 1048576);
  budget.reserveKnownMemory('owned-contention', os.totalmem() / 1048576, { branchId: owner });
  const deadline = new AbortController(); const timer = setTimeout(() => deadline.abort(), 60000);
  let admitted = false; const waiting = budget.acquire('start', { branchId: owner }, { memoryMB: 512, signal: deadline.signal }).then(release => { admitted = true; return release; });
  await new Promise(r => setTimeout(r, 100)); assert.equal(admitted, false); await served('old');
  assert.equal(budget.snapshot().start.queued[0].reason, 'memory-headroom');
  const releasedAt = Date.now(); budget.releaseMemory('owned-contention'); const release = await waiting; release(); clearTimeout(timer);
  assert.ok(Date.now() - releasedAt < 60000);
  report.checks.push({ case: 'reservation-contention', availableMemoryMB: os.freemem() / 1048576, recoveryMs: Date.now() - releasedAt,
    oldVersion: 'old', physicalPressureInjected: false });
  for (const version of ['new', 'old-rollback']) {
    const next = candidate(); await launch(next, version); await ready(next, version);
    await served(version === 'new' ? 'old' : 'new'); next.status = 'running'; await publish(next); await served(version);
    assert.equal(entry.services.api.servingRuntime!.sourceCommitSha, version);
    report.checks.push({ case: version === 'new' ? 'ready-cutover' : 'rollback-cutover', actualHttpVersion: version,
      actualCid: entry.services.api.containerId, persistedSourceVersion: entry.services.api.servingRuntime!.sourceCommitSha });
  }
  let live = new Set([entry.services.api.containerName]);
  const scheduler = new SchedulerService(state, { enabled: true, maxHotBranches: 14, idleTTLSeconds: 86400, tickIntervalSeconds: 60, pinnedBranches: [] });
  scheduler.setRuntimePresenceProvider(() => live); let inFlight = true;
  scheduler.setOperationProtection(() => inFlight);
  scheduler.setCoolFn(async () => { await stopServiceForCooling({ service: entry.services.api, container,
    context: { branchId: owner, projectId: owner }, confirmedStopped: stopped => { live = new Set([...live].filter(n => !stopped.includes(n))); } }); });
  await scheduler.markCold(owner); assert.equal(owned(entry.services.api.containerId!).State.Running, true);
  inFlight = false; entry.pinnedByUser = true; await scheduler.markCold(owner); assert.equal(owned(entry.services.api.containerId!).State.Running, true);
  entry.pinnedByUser = false; transportFault = true;
  await assert.rejects(scheduler.markCold(owner)); assert.equal(entry.heatState, 'hot');
  assert.equal(owned(entry.services.api.containerId!).State.Running, true); assert.equal(scheduler.getSnapshot().capacityUsage.current, 1);
  assert.ok(deploymentPhaseBudget.memorySnapshot().some(row => row.key === entry.services.api.containerName));
  transportFault = false; await scheduler.markCold(owner); assert.equal(owned(entry.services.api.containerId!).State.Running, false);
  assert.equal(entry.heatState, 'cold'); assert.equal(entry.services.api.status, 'stopped');
  assert.equal(scheduler.getSnapshot().capacityUsage.current, 0);
  assert.equal(deploymentPhaseBudget.memorySnapshot().some(row => row.key === entry.services.api.containerName), false);
  report.checks.push({ case: 'cooling-retry', fixedAndInFlightProtected: true, fault: 'owned missing Docker socket',
    failedStopRetainsActualOccupancy: true, confirmedStopReleasesReservation: true });
  await state.flush(); report.verdict = 'passed';
} catch (error) { report.error = String(error); throw error; }
finally {
  transportFault = false;
  for (const name of names) {
    try { const view = owned(name); docker(['rm', '-f', view.Id]); } catch (error) {
      // A container retired by the real implementation is already absent.
      try { inspect(name); report.cleanupError = String(error); } catch { /* absent */ }
    }
    deploymentPhaseBudget.releaseMemory(name);
  }
  for (const name of networks.reverse()) {
    try { const labels = JSON.parse(docker(['network', 'inspect', '--format', '{{json .Labels}}', name]));
      assert.equal(labels['cds.acceptance.owner'], owner); docker(['network', 'rm', name]); } catch { /* already retired */ }
  }
  await state.flush(); await fs.rm(temp, { recursive: true, force: true });
  report.remainingOwned = docker(['ps', '-a', '--filter', `label=cds.acceptance.owner=${owner}`, '--format', '{{.ID}}']);
  if (report.remainingOwned || report.cleanupError) report.verdict = 'failed';
  report.finishedAt = new Date().toISOString(); await fs.writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  assert.equal(report.verdict, 'passed');
}
