import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { MongoClient } from 'mongodb';
import { RealMongoSplitHandle } from '../src/infra/state-store/mongo-split-handle.js';
import { MongoSplitStateBackingStore } from '../src/infra/state-store/mongo-split-store.js';
import { StateService } from '../src/services/state.js';
import { DeploymentRunService } from '../src/services/deployment-run.js';
import { BranchOperationCoordinator } from '../src/services/branch-operation-coordinator.js';
import { captureDeploymentInput } from '../src/services/deployment-input.js';
import { assertIsolatedDatabase } from './deployment-recovery-drill.js';

/** 只有本次创建、带匹配身份和端口的隔离成员可被暂停或移除。 */
export function assertOwnedReplicaMember(container: any, owner: string, port: number): void {
  assert.match(owner, /^cds_acceptance_[a-f0-9]{16}$/);
  assert.ok([27901, 27902, 27903].includes(port));
  assert.match(container.Id, /^[a-f0-9]{64}$/);
  assert.equal(container.Config.Image, 'mongo:7.0');
  assert.equal(container.Config.Labels['cds.acceptance.owner'], owner);
  assert.equal(container.HostConfig.NetworkMode, 'host');
  assert.equal(container.HostConfig.NanoCpus, 1_000_000_000);
  assert.equal(container.HostConfig.Memory, 1_073_741_824);
  assert.deepEqual(container.Config.Cmd, ['mongod', '--replSet', owner, '--bind_ip', '127.0.0.1', '--port', String(port)]);
}

function docker(args: string[]): string {
  return execFileSync('docker', ['--host', 'unix:///var/run/docker.sock', ...args], { encoding: 'utf8', timeout: 120000 }).trim();
}
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
async function until(check: () => Promise<boolean>, label: string): Promise<void> {
  const deadline = performance.now() + 90000;
  while (performance.now() < deadline) { try { if (await check()) return; } catch { /* startup/election */ } await sleep(500); }
  throw new Error(`Isolated ${label} did not become ready`);
}

export async function main(): Promise<void> {
  assert.equal(process.env.GITHUB_ACTIONS, 'true'); assert.equal(os.platform(), 'linux');
  assert.match(process.env.GITHUB_RUN_ID || '', /^\d+$/);
  const owner = `cds_acceptance_${randomBytes(8).toString('hex')}`;
  const database = `${owner}_${Date.now()}`, ports = [27901, 27902, 27903];
  const uri = `mongodb://127.0.0.1:${ports[0]}/?directConnection=true`; assertIsolatedDatabase(uri, database);
  const output = path.resolve('replica-output'); await fs.mkdir(output, { recursive: true, mode: 0o700 });
  const head = execFileSync('/usr/bin/git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(); assert.match(head, /^[a-f0-9]{40}$/);
  const members: Array<{ id: string; port: number }> = [];
  const report: any = { schema: 1, startedAt: new Date().toISOString(), head, verdict: 'failed',
    scope: 'isolated three-member Mongo critical confirmation only', actualDeploymentVerified: false, performanceVerified: false,
    runner: { host: os.hostname(), platform: os.platform(), cpus: os.cpus().length, totalMemoryBytes: os.totalmem(), githubRunId: process.env.GITHUB_RUN_ID },
    containers: [], checks: [], isolatedDatabaseRemoved: false, containersRemoved: false };
  let ownsDatabase = false;
  const raw = new MongoClient(uri, { retryWrites: false, serverSelectionTimeoutMS: 3000, connectTimeoutMS: 3000 });
  let handle: RealMongoSplitHandle | undefined;
  function inspect(member: { id: string; port: number }): any {
    assert.ok(members.includes(member)); const result = JSON.parse(docker(['inspect', member.id]))[0];
    assert.equal(result.Id, member.id); assertOwnedReplicaMember(result, owner, member.port); return result;
  }
  function resumeAll(): void {
    for (const member of members) { const view = inspect(member); if (view.State.Paused) docker(['unpause', member.id]); }
  }
  try {
    docker(['pull', 'mongo:7.0']);
    for (const port of ports) {
      const id = docker(['run', '-d', '--network', 'host', '--cpus', '1', '--memory', '1g', '--label', `cds.acceptance.owner=${owner}`,
        'mongo:7.0', 'mongod', '--replSet', owner, '--bind_ip', '127.0.0.1', '--port', String(port)]);
      assert.match(id, /^[a-f0-9]{64}$/); const member = { id, port }; members.push(member);
      const view = inspect(member); assert.equal(view.State.Running, true);
      report.containers.push({ id, port, image: view.Image, cpuLimit: view.HostConfig.NanoCpus, memoryLimit: view.HostConfig.Memory });
    }
    // docker running不能证明mongod已经监听；初始化需要三个实际成员全部就绪。
    report.readyMembers = [];
    await Promise.all(members.map(async member => {
      inspect(member);
      const probe = new MongoClient(`mongodb://127.0.0.1:${member.port}/?directConnection=true`,
        { retryWrites: false, serverSelectionTimeoutMS: 3000, connectTimeoutMS: 3000 });
      try {
        await until(async () => { await probe.connect(); return Boolean((await probe.db('admin').command({ ping: 1 })).ok); }, `Mongo member ${member.port} startup`);
        assert.equal(inspect(member).State.Running, true);
        report.readyMembers.push({ id: member.id, port: member.port, pingConfirmed: true });
      } finally { await probe.close(); }
    }));
    assert.equal(report.readyMembers.length, members.length);
    await raw.connect();
    await raw.db('admin').command({ replSetInitiate: { _id: owner, members: ports.map((port, i) => ({ _id: i, host: `localhost:${port}`, priority: i === 0 ? 2 : 0 })),
      settings: { electionTimeoutMillis: 60000 } } });
    await until(async () => { const status = await raw.db('admin').command({ replSetGetStatus: 1 });
      return status.members.filter((member: any) => member.state === 1).length === 1 && status.members.filter((member: any) => member.state === 2).length === 2;
    }, 'replica election');
    assert.equal((await raw.db('admin').command({ hello: 1 })).isWritablePrimary, true);
    assert.equal((await raw.db(database).listCollections().toArray()).length, 0); ownsDatabase = true;
    report.mongoVersion = (await raw.db('admin').command({ buildInfo: 1 })).version;
    handle = new RealMongoSplitHandle({ uri, databaseName: database }); const store = new MongoSplitStateBackingStore(handle); await store.init();
    const state = new StateService('/tmp/cds-replica-drill-unused/state.json', undefined, store); state.load();
    state.addProject({ id: 'drill', slug: 'drill', name: '隔离副本确认' } as any);
    state.addBranch({ id: 'b', projectId: 'drill', branch: 'main', worktreePath: '/unused', status: 'idle', services: {}, createdAt: new Date().toISOString() }); await state.flush();
    const runs = new DeploymentRunService(state, { idFactory: () => 'dr_replica_original' }); const coordinator = new BranchOperationCoordinator();
    coordinator.begin({ projectId: 'drill', branchId: 'b', kind: 'deploy', trigger: 'manual' });
    const request = { projectId: 'drill', branchId: 'b', kind: 'deploy' as const, trigger: 'webhook' as const, commitSha: 'd'.repeat(40), commitPinned: true, configHash: 'replica-config' };
    const queued = coordinator.begin(request); assert.equal(queued.status, 'merged');
    const input = captureDeploymentInput(state.getBranch('b')!, [], { TOKEN: 'synthetic-replica-input' }); input.configHash = 'replica-config';
    const run = await runs.begin({ projectId: 'drill', branchId: 'b', trigger: 'webhook', initialStatus: 'queued', operationId: queued.operationId,
      operationGeneration: queued.generation, commitSha: request.commitSha, configHash: request.configHash, executionInput: { request, input } });
    await state.flush();
    const collection = handle.deploymentRunsCollection(); handle.deploymentRunsCollection = () => collection;
    const rawRuns = raw.db(database).collection<any>('cds_deployment_runs');
    // 明确使用较弱的普通确认；服务器默认强度不能被当成关键协议的保证。
    collection.bulkWrite = async (operations, options) => rawRuns.bulkWrite(operations as any[], { ...options, writeConcern: { w: 1 } });
    const original = collection.replaceOne.bind(collection); let criticalWrites = 0;
    collection.replaceOne = async (...args) => { assert.deepEqual(args[2]?.writeConcern, { w: 'majority', j: true, wtimeoutMS: 5000 }); criticalWrites++; return original(...args); };
    for (const member of members.slice(1)) { assert.equal(inspect(member).State.Running, true); docker(['pause', member.id]); assert.equal(inspect(member).State.Paused, true); }
    runs.cancel(run.id, 'isolated stop'); await state.flush();
    assert.equal((await rawRuns.findOne({ _id: run.id }, { readConcern: { level: 'local' } }))?.doc.status, 'cancelled');
    assert.equal((await rawRuns.findOne({ _id: run.id }, { readConcern: { level: 'majority' }, maxTimeMS: 5000 }))?.doc.status, 'queued');
    const stop = coordinator.begin({ projectId: 'drill', branchId: 'b', kind: 'stop', trigger: 'manual' }); assert.equal(stop.status, 'started');
    const began = performance.now(); const cancellation = runs.persistBranchCancellation('drill', 'b', stop.lease);
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      const bounded = Promise.race([cancellation, new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new Error('drill operation deadline exceeded')), 20000); })]);
      let failure: any;
      try { await bounded; } catch (error) { failure = error; }
      assert.ok(failure, 'Unavailable majority must not be reported as a confirmed cancellation');
      assert.notEqual(failure.message, 'drill operation deadline exceeded'); assert.ok(criticalWrites > 0);
      report.checks.push({ phase: 'quorum-unavailable', runId: run.id, localStatus: 'cancelled', majorityStatus: 'queued', cancellationConfirmed: false,
        durationMs: Math.round(performance.now() - began), criticalWrites, errorName: failure.name, actualPausedMembers: members.slice(1).map((member) => member.id) });
    } finally { if (timeout) clearTimeout(timeout); resumeAll(); await cancellation.catch(() => {}); }
    await until(async () => { await raw.db(database).collection<any>('__drill').updateOne({ _id: 'resume' }, { $set: { ready: true } },
      { upsert: true, writeConcern: { w: 'majority', j: true, wtimeoutMS: 1000 } }); return true; }, 'majority recovery');
    const beforeRetry = criticalWrites; await runs.persistBranchCancellation('drill', 'b', stop.lease); await state.flush();
    assert.ok(criticalWrites > beforeRetry);
    const confirmed = await rawRuns.findOne({ _id: run.id }, { readConcern: { level: 'majority' }, maxTimeMS: 5000 });
    assert.equal(confirmed?.doc.status, 'cancelled'); assert.equal(confirmed?.executionIntent, undefined);
    const beforeReuse = criticalWrites; await state.flushDeploymentRun(run.id); assert.equal(criticalWrites, beforeReuse);
    report.checks.push({ phase: 'quorum-restored', runId: run.id, cancellationConfirmed: true, majorityStatus: 'cancelled', privateInputCleared: true, repeatConfirmationReused: true });
    const reopened = new MongoSplitStateBackingStore(handle); await reopened.init();
    const cold = new StateService('/tmp/cds-replica-drill-unused/cold.json', undefined, reopened); cold.load();
    const beforeCold = criticalWrites; await cold.flushDeploymentRun(run.id); assert.ok(criticalWrites > beforeCold); await cold.flush();
    report.checks.push({ phase: 'cold-confirmation', sameOriginalRun: true, majorityUpgradeVerified: true });
    report.verdict = 'passed';
  } finally {
    try { resumeAll(); } catch { report.cleanupFailed = true; report.verdict = 'failed'; }
    if (ownsDatabase) { try { report.isolatedDatabaseRemoved = await raw.db(database).dropDatabase(); } catch { report.cleanupFailed = true; report.verdict = 'failed'; } }
    try { await handle?.close(); await raw.close(); } catch { report.cleanupFailed = true; report.verdict = 'failed'; }
    let removed = 0;
    for (const member of members) { try { inspect(member); docker(['rm', '-fv', member.id]); removed++; } catch { report.cleanupFailed = true; report.verdict = 'failed'; } }
    report.containersRemoved = removed === members.length; report.finishedAt = new Date().toISOString();
    await fs.writeFile(path.join(output, 'report.json'), `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  }
  assert.equal(report.verdict, 'passed'); assert.equal(report.isolatedDatabaseRemoved, true); assert.equal(report.containersRemoved, true);
  process.stdout.write(`${JSON.stringify({ verdict: report.verdict, head, report: path.join(output, 'report.json') })}\n`);
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
