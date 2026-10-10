import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fork, execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { MongoClient } from 'mongodb';
import { RealMongoSplitHandle } from '../src/infra/state-store/mongo-split-handle.js';
import { MongoSplitStateBackingStore } from '../src/infra/state-store/mongo-split-store.js';
import { StateService } from '../src/services/state.js';
import { DeploymentRunService } from '../src/services/deployment-run.js';
import { BranchOperationCoordinator, pendingDeployBody, type BranchOperationRequest } from '../src/services/branch-operation-coordinator.js';
import { captureDeploymentInput } from '../src/services/deployment-input.js';

/** 该演练只允许专用本机 Mongo 和新建隔离数据库，绝不读取生产配置。 */
export function assertIsolatedDatabase(uri: string, database: string): void {
  const parsed = new URL(uri);
  assert.equal(parsed.protocol, 'mongodb:'); assert.equal(parsed.hostname, '127.0.0.1');
  assert.equal(parsed.username, ''); assert.equal(parsed.password, ''); assert.equal(parsed.pathname, '/');
  for (const [key, value] of parsed.searchParams) assert.ok(key === 'directConnection' && value === 'true');
  assert.match(database, /^cds_acceptance_[a-z0-9_]{8,80}$/);
}

export function assertIsolatedCiContainer(uri: string, containerId: string, container: any, githubActions?: string): void {
  assert.equal(githubActions, 'true', 'Run this drill only in its dedicated CI job');
  assert.match(containerId, /^[a-f0-9]{12,64}$/);
  assert.equal(container.State.Running, true); assert.equal(container.Config.Image, 'mongo:7.0');
  const uriPort = new URL(uri).port || '27017';
  assert.ok(container.NetworkSettings.Ports['27017/tcp'].some((binding: any) => binding.HostIp === '127.0.0.1' && binding.HostPort === uriPort));
}

function arg(name: string): string {
  const i = process.argv.indexOf(name); return i < 0 ? '' : String(process.argv[i + 1] || '');
}

async function worker(uri: string, database: string, mode: string, scope: string): Promise<void> {
  assertIsolatedDatabase(uri, database);
  assert.ok(scope === 'full' || scope === 'profile');
  const runId = `dr_isolated_${scope}`, profileId = scope === 'profile' ? 'api' : undefined;
  const handle = new RealMongoSplitHandle({ uri, databaseName: database });
  const store = new MongoSplitStateBackingStore(handle); await store.init();
  const state = new StateService('/tmp/cds-isolated-drill-unused/state.json', undefined, store); state.load();
  const runs = new DeploymentRunService(state, { idFactory: () => runId });
  const coordinator = new BranchOperationCoordinator();
  if (mode === 'accept') {
    if (!state.getProject('drill')) state.addProject({ id: 'drill', name: '隔离演练', slug: 'drill' } as any);
    if (!state.getBranch('drill-b')) state.addBranch({ id: 'drill-b', projectId: 'drill', branch: 'main', worktreePath: '/unused', status: 'idle', services: {}, createdAt: new Date().toISOString() });
    await state.flush();
    assert.equal(runs.restoreQueued(coordinator).length, 0);
    const global = handle.globalCollection();
    const original = global.replaceOne.bind(global); let inject = true;
    global.replaceOne = async (...args) => {
      if (inject) { inject = false; throw new Error('synthetic unrelated global failure'); }
      return original(...args);
    };
    const runCollection = handle.deploymentRunsCollection();
    const originalWrite = runCollection.replaceOne.bind(runCollection), originalRead = runCollection.findOne.bind(runCollection);
    let loseAcknowledgement = true, receiptReads = 0;
    runCollection.replaceOne = async (...args) => {
      const result = await originalWrite(...args);
      if (loseAcknowledgement) { loseAcknowledgement = false; throw new Error('synthetic acknowledgement lost after real write'); }
      return result;
    };
    runCollection.findOne = async (...args) => {
      if (args[1]?.readPreference === 'primary' && args[1].readConcern.level === 'majority') receiptReads++;
      return originalRead(...args);
    };
    (state.getState() as any).nextPortIndex += 123; state.save([{ kind: 'global' }]);
    coordinator.begin({ projectId: 'drill', branchId: 'drill-b', kind: 'deploy', trigger: 'manual' });
    const request: BranchOperationRequest = { projectId: 'drill', branchId: 'drill-b', kind: profileId ? 'deploy-profile' : 'deploy', profileId,
      trigger: 'webhook', actor: 'isolated-original-agent', commitSha: 'b'.repeat(40), commitPinned: true, configHash: 'drill-config' };
    const decision = coordinator.begin(request);
    const input = captureDeploymentInput(state.getBranch('drill-b')!, [{ id: 'api', projectId: 'drill', name: 'API', dockerImage: 'node', workDir: '.', command: 'node original.js', containerPort: 3000 }], { TOKEN: 'synthetic-isolated-secret' });
    input.configHash = 'drill-config'; input.agentPrebuiltGated = true;
    const run = await runs.begin({ projectId: 'drill', branchId: 'drill-b', trigger: 'webhook', profileId, initialStatus: 'queued',
      operationId: decision.operationId, operationGeneration: decision.generation, commitSha: request.commitSha || undefined, configHash: 'drill-config', executionInput: { request, input } });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(await store.isHealthy(), false);
    assert.equal(receiptReads, 1);
    const persisted = await handle.deploymentRunsCollection().findOne({ _id: run.id });
    assert.equal(persisted?.executionIntent?.runId, run.id);
    assert.ok(typeof persisted?.executionIntent?.inputPayload === 'object' && persisted.executionIntent.inputPayload.__sealed);
    assert.ok(!JSON.stringify(persisted?.doc).includes('synthetic-isolated-secret'));
    process.send?.({ phase: 'accepted', scope, runId: run.id, operationId: run.operationId, generation: run.operationGeneration,
      privateInputSealed: true, unrelatedWriteFailureReported: true, lostAcknowledgementVerifiedByPrimaryMajorityRead: true });
  } else if (mode === 'claim') {
    const restored = runs.restoreQueued(coordinator); assert.equal(restored.length, 1);
    const pending = coordinator.drainReady()[0]; assert.ok(pending);
    const replay = { ...pending.request, pendingReplay: pendingDeployBody(pending).pendingReplay as BranchOperationRequest['pendingReplay'] };
    const input = coordinator.getDeploymentInputForReplay(replay)!;
    assert.equal(coordinator.begin(replay).status, 'started');
    assert.equal(input.configuredEnv.TOKEN, 'synthetic-isolated-secret'); assert.equal(input.agentPrebuiltGated, true);
    assert.equal(input.profiles[0].command, 'node original.js');
    await runs.claimQueued(restored[0].id);
    const persisted = await handle.deploymentRunsCollection().findOne({ _id: restored[0].id });
    assert.equal(persisted?.doc.status, 'preparing'); assert.equal(restored[0].id, runId);
    assert.equal(persisted?.doc.profileId, profileId);
    process.send?.({ phase: 'claimed', scope, runId: restored[0].id, operationId: pending.operationId, generation: pending.generation,
      originalInputPreserved: true, prebuiltGatePreserved: true, runCount: runs.list().length });
  } else if (mode === 'inspect') {
    assert.equal(runs.restoreQueued(coordinator).length, 0); assert.equal(coordinator.drainReady().length, 0);
    runs.reconcileOrphanedByRestart(new Date('2099-01-01T00:00:00Z')); await runs.flush();
    assert.equal(runs.get(runId)?.status, 'failed');
    assert.equal(state.getDeploymentIntents().length, 0);
    process.send?.({ phase: 'restarted', scope, restored: 0, runCount: runs.list().length, status: 'failed', privateInputCleared: true });
  } else throw new Error('Unknown isolated worker mode');
  setInterval(() => {}, 1000);
}

export async function main(): Promise<void> {
  const uri = arg('--mongo-uri'), mode = arg('--worker');
  const database = arg('--database') || `cds_acceptance_${Date.now()}_${randomBytes(6).toString('hex')}`;
  assertIsolatedDatabase(uri, database);
  if (mode) {
    assert.ok(process.connected && typeof process.send === 'function', 'Internal worker requires parent IPC');
    await worker(uri, database, mode, arg('--scope')); return;
  }
  assert.equal(process.env.GITHUB_ACTIONS, 'true', 'Run this drill only in its dedicated CI job');
  const containerId = arg('--mongo-container-id'); assert.match(containerId, /^[a-f0-9]{12,64}$/);
  const mongoContainer = JSON.parse(execFileSync('docker', ['inspect', containerId], { encoding: 'utf8' }))[0];
  assertIsolatedCiContainer(uri, containerId, mongoContainer, process.env.GITHUB_ACTIONS);
  const output = path.resolve(arg('--output') || 'acceptance-output'); await fs.mkdir(output, { recursive: true, mode: 0o700 });
  const head = execFileSync('/usr/bin/git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(); assert.match(head, /^[a-f0-9]{40}$/);
  const client = new MongoClient(uri, { serverSelectionTimeoutMS: 5000, connectTimeoutMS: 5000 });
  const report: Record<string, unknown> = { schema: 1, startedAt: new Date().toISOString(), head, verdict: 'failed',
    scope: 'isolated real Mongo persistence and process recovery only', actualDeploymentVerified: false, performanceVerified: false,
    runner: { host: os.hostname(), platform: os.platform(), arch: os.arch(), cpus: os.cpus().length, totalMemoryBytes: os.totalmem(),
      githubRunId: process.env.GITHUB_RUN_ID || null },
    mongoContainer: { id: containerId, image: mongoContainer.Image, cpuLimit: mongoContainer.HostConfig.NanoCpus, memoryLimit: mongoContainer.HostConfig.Memory },
    checks: [], processExits: [] };
  let ownsDatabase = false;
  async function runWorker(workerMode: string, scope: string): Promise<any> {
    const child = fork(fileURLToPath(import.meta.url), ['--mongo-uri', uri, '--database', database, '--worker', workerMode, '--scope', scope],
      { execArgv: ['--import', 'tsx'], cwd: fileURLToPath(new URL('..', import.meta.url)),
        env: { ...process.env, CDS_SECRET_KEY: '17'.repeat(32) }, stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
    try {
      return await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`Isolated worker ${workerMode} timed out`)), 20000);
        child.once('message', (message) => { clearTimeout(timer); resolve(message); });
        child.once('error', (error) => { clearTimeout(timer); reject(error); });
        child.once('exit', (code) => { clearTimeout(timer); reject(new Error(`Isolated worker ${workerMode} exited ${code}`)); });
      });
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        const exited = new Promise<string | null>((resolve) => child.once('exit', (_code, signal) => resolve(signal)));
        child.kill('SIGKILL'); const signal = await exited; assert.equal(signal, 'SIGKILL');
        (report.processExits as unknown[]).push({ phase: workerMode, scope, pid: child.pid, signal });
      } else {
        (report.processExits as unknown[]).push({ phase: workerMode, scope, pid: child.pid, exitCode: child.exitCode, signal: child.signalCode });
      }
    }
  }
  try {
    await client.connect();
    assert.equal((await client.db(database).listCollections().toArray()).length, 0, 'Acceptance database must be new and empty');
    ownsDatabase = true;
    const version = await client.db(database).admin().command({ buildInfo: 1 }); report.mongoVersion = version.version;
    for (const scope of ['full', 'profile']) {
      const accepted = await runWorker('accept', scope); (report.checks as unknown[]).push(accepted);
      const claimed = await runWorker('claim', scope); (report.checks as unknown[]).push(claimed);
      const inspected = await runWorker('inspect', scope); (report.checks as unknown[]).push(inspected);
      assert.equal(accepted.runId, claimed.runId); assert.equal(accepted.operationId, claimed.operationId); assert.equal(accepted.generation, claimed.generation);
      assert.equal(inspected.runCount, scope === 'full' ? 1 : 2);
    }
    report.verdict = 'passed';
  } finally {
    report.isolatedDatabaseRemoved = false;
    if (ownsDatabase) {
      try { report.isolatedDatabaseRemoved = await client.db(database).dropDatabase(); }
      catch { report.cleanupFailed = true; report.verdict = 'failed'; }
    }
    await client.close(); report.finishedAt = new Date().toISOString();
    await fs.writeFile(path.join(output, 'report.json'), `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  }
  assert.equal(report.verdict, 'passed'); assert.equal(report.isolatedDatabaseRemoved, true);
  process.stdout.write(`${JSON.stringify({ verdict: report.verdict, head, report: path.join(output, 'report.json') })}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
