import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { StateService } from '../../src/services/state.js';
import { DeploymentRunService } from '../../src/services/deployment-run.js';
import { OwnedCandidateNetworkLifecycle } from '../../src/services/owned-candidate-network.js';
import { OwnedContainerLifecycle } from '../../src/services/owned-container-lifecycle.js';
import { BranchOperationCoordinator, BranchOperationSupersededError } from '../../src/services/branch-operation-coordinator.js';
import { CandidateDeploymentService } from '../../src/services/candidate-deployment.js';
import type { BranchEntry, BuildProfile, IShellExecutor } from '../../src/types.js';
const sha = 'a'.repeat(40); const image = 'sha256:' + 'a'.repeat(64);
let dir: string; let state: StateService; let entry: BranchEntry; let runId: string;
beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-candidate-deployment-'));
  state = new StateService(path.join(dir, 'state.json')); state.load();
  entry = { id: 'branch', projectId: 'project', branch: 'test', worktreePath: '/unused', githubCommitSha: sha, deploymentTargetSha: sha,
    status: 'running', createdAt: '2026-10-11', services: { api: { profileId: 'api', containerName: 'old', hostPort: 10001, status: 'running',
      deployedCommitSha: 'b'.repeat(40), deployedImage: 'sha256:' + 'b'.repeat(64) } } };
  state.addBranch(entry);
  entry.currentVersionId = 'dv-original';
  state.addDeploymentVersion({ id: 'dv-original', projectId: 'project', branchId: entry.id, commitSha: 'b'.repeat(40),
    configHash: 'old-config', createdByRunId: 'dr-original', createdAt: '2026-10-01', migrations: [], capabilities: [],
    profiles: [{ profileId: 'api', replacementContractVersion: 1, name: 'Original', artifactImage: entry.services.api.deployedImage!,
      artifactKind: 'prebuilt-image', reusable: true, containerPort: 8080, readinessProbe: { path: '/old-health', timeoutSeconds: 17 } }] });
  runId = (await new DeploymentRunService(state).begin({ projectId: 'project', branchId: entry.id, trigger: 'manual',
    commitSha: sha, operationId: 'operation', configHash: 'frozen' })).id;
});
afterEach(async () => { await state.flush(); fs.rmSync(dir, { recursive: true, force: true }); });
function fixture(role: 'api' | 'worker' = 'api', withNetwork = false) {
  const events: string[] = []; const objects = new Map<string, any>();
  const add = (name: string, port: number, candidate = false) => {
    const id = createHash('sha256').update(name).digest('hex');
    const info = { Id: id, Name: '/' + name, Image: candidate ? image : entry.services.api.deployedImage,
      State: { Running: true }, Config: { Labels: { 'cds.managed': 'true', 'cds.type': 'app', 'cds.instance': 'instance',
        'cds.project.id': 'project', 'cds.branch.id': 'branch', 'cds.profile.id': 'api',
        ...(candidate ? { 'cds.deployment.operation': 'operation', 'cds.deployment.kind': 'candidate' } : {}) } },
      HostConfig: { PortBindings: { '8080/tcp': [{ HostPort: String(port) }] } }, Mounts: [] };
    objects.set(id, info); return info;
  };
  const old = add('old', 10001);
  let network: any;
  let networkExists = false;
  const shell = { exec: async (command: string) => {
    const identity = command.split(' ').at(-1)!.replaceAll("'", '');
    if (command.startsWith('docker network inspect')) return networkExists ? { exitCode: 0, stdout: JSON.stringify(network), stderr: '' }
      : { exitCode: 1, stdout: '', stderr: 'network not found' };
    if (command.startsWith('docker network rm')) {
      events.push(command); networkExists = false; return { exitCode: 0, stdout: network.Id, stderr: '' };
    }
    const info = objects.get(identity) || [...objects.values()].find(object => object.Name === '/' + identity);
    if (command.startsWith('docker inspect')) return info ? { exitCode: 0, stdout: JSON.stringify(info), stderr: '' }
      : { exitCode: 1, stdout: '', stderr: 'No such object: ' + identity };
    events.push(command);
    if (!info) return { exitCode: 1, stdout: '', stderr: 'No such container' };
    if (command.startsWith('docker stop')) {
      const savedProof = new StateService(path.join(dir, 'state.json')); savedProof.load();
      expect((savedProof.getDeploymentRun(runId)!.candidate as any).recoveryProof).toMatchObject({ version: 1,
        serving: { api: { id: old.Id, name: 'old', image: old.Image, wasRunning: true, fingerprint: expect.stringMatching(/^sha256:[a-f0-9]{64}$/) } },
        artifacts: { api: { image, targetSha: sha } } });
      const saved = new StateService(path.join(dir, 'state.json')); saved.load();
      expect(saved.getDeploymentRun(runId)!.candidate!.stopBeforeStart).toContain('api');
      expect(saved.getDeploymentRun(runId)!.candidate!.serving.api.containerId).toBe(old.Id);
      info.State.Running = false;
    }
    if (command.startsWith('docker start')) info.State.Running = true;
    if (command.startsWith('docker rm')) objects.delete(info.Id);
    return { exitCode: 0, stdout: info.Id, stderr: '' };
  } } as unknown as IShellExecutor;
  const profile = { id: 'api', projectId: 'project', role, name: 'API', containerPort: 8080, workDir: '.', dockerImage: image,
    prebuiltImage: true, prebuiltCommitPolicy: 'exact', preparedCommitSha: sha, preparedArtifactId: image } as BuildProfile;
  let ready = true; let oldReady = true; let createFails = false; let wait: (() => Promise<boolean>) | undefined;
  const containers = { runService: async (graph: BranchEntry, p: BuildProfile, service: any, _output: any, _env: any, context: any) => {
    expect(graph).not.toBe(entry); expect(context.candidateRunId).toBe('operation');
    if (withNetwork) {
      await context.onCandidateNetworkIntent();
      network = { Id: '9'.repeat(64), Name: state.getDeploymentRun(runId)!.candidate!.networkName, Driver: 'bridge', Scope: 'local',
        Internal: false, Attachable: false, Ingress: false, EnableIPv6: false, Options: {}, IPAM: { Driver: 'default', Config: [] },
        Containers: {}, Labels: { 'cds.managed': 'true', 'cds.type': 'candidate-network', 'cds.instance': 'instance',
          'cds.project.id': 'project', 'cds.branch.id': 'branch', 'cds.deployment.operation': 'operation' } };
      networkExists = true; await context.onCandidateNetworkPrepared(network.Name);
    }
    events.push('create-candidate'); if (createFails) throw new Error('create-unknown');
    add(service.containerName, service.hostPort, true);
    Object.assign(service, { deployedPrebuilt: true, deployedCommitSha: sha, deployedImage: image, deployedMode: 'express' });
  }, waitForStartupSignal: async () => true, waitForReadiness: async (port: number) => port === 10001 ? oldReady : wait ? await wait() : ready };
  const options = { runId, entry, profiles: [profile], allocatePort: () => 10002, assertCurrent: () => {},
    admit: async () => {}, acknowledge: async () => { events.push('ack'); return true; }, customEnv: {} };
  const service = new CandidateDeploymentService(state, containers as any, new OwnedContainerLifecycle(shell, 'instance'), withNetwork ? new OwnedCandidateNetworkLifecycle(shell, 'instance') : undefined);
  return { service, options, containers, old, events, objects,
    getNetwork: () => network, networkExists: () => networkExists, setReady: (value: boolean) => { ready = value; },
    setOldReady: (value: boolean) => { oldReady = value; }, failCreate: () => { createFails = true; }, setWait: (value: () => Promise<boolean>) => { wait = value; } };
}
describe('P3 actual deployment candidate orchestration', () => {
  it('durably freezes the private network identity and removes it before restoring a failed candidate worker', async () => {
    const f = fixture('worker', true); f.setReady(false);
    const ready = f.containers.waitForReadiness;
    f.containers.waitForReadiness = async (port: number, ...args: any[]) => {
      if (port !== 10001) {
        const disk = new StateService(path.join(dir, 'state.json')); disk.load();
        expect(disk.getDeploymentRun(runId)!.candidate!.networkCreation).toMatchObject({ intent: true,
          identity: { id: '9'.repeat(64), fingerprint: expect.stringMatching(/^sha256:[a-f0-9]{64}$/) } });
      }
      return ready(port);
    };
    await expect(f.service.deploy(f.options)).rejects.toThrow('candidate_readiness');
    const remove = f.events.indexOf('docker network rm ' + '9'.repeat(64));
    const restore = f.events.indexOf('docker start ' + f.old.Id);
    expect(remove).toBeGreaterThan(-1); expect(restore).toBeGreaterThan(remove); expect(f.networkExists()).toBe(false);
  });
  it('preserves the stopped worker and both reservations if actual network endpoints prevent cleanup', async () => {
    const f = fixture('worker', true); f.setReady(false);
    const ready = f.containers.waitForReadiness;
    f.containers.waitForReadiness = async (port: number, ...args: any[]) => {
      if (port !== 10001) f.getNetwork().Containers['e'.repeat(64)] = { Name: 'unknown-consumer' };
      return ready(port);
    };
    await expect(f.service.deploy(f.options)).rejects.toThrow('candidate_readiness');
    expect(f.events.some(event => event.startsWith('docker network rm') || event.startsWith('docker start'))).toBe(false);
    expect(f.old.State.Running).toBe(false); expect(f.networkExists()).toBe(true);
    const disk = new StateService(path.join(dir, 'state.json')); disk.load();
    expect(disk.getDeploymentRun(runId)!.candidate).toMatchObject({ phase: 'reconciling',
      recoveryFailure: { stage: 'candidate-remove' }, networkCreation: { identity: { id: '9'.repeat(64) } } });
  });

  it('uses the frozen original version readiness instead of the incoming profile while restoring the old worker', async () => {
    const f = fixture('worker'); f.options.profiles[0].readinessProbe = { path: '/new-health', timeoutSeconds: 1 };
    f.setReady(false); const check = f.containers.waitForReadiness;
    let oldProbe: unknown;
    f.containers.waitForReadiness = async (port: number, ...args: any[]) => {
      if (port === 10001) oldProbe = args[0];
      return check(port);
    };
    await expect(f.service.deploy(f.options)).rejects.toThrow('candidate_readiness');
    expect(oldProbe).toEqual({ path: '/old-health', timeoutSeconds: 17 });
    const disk = new StateService(path.join(dir, 'state.json')); disk.load();
    expect((disk.getDeploymentRun(runId)!.candidate!.recoveryProof as any).servingVersion).toMatchObject({ id: 'dv-original', fingerprint: expect.stringMatching(/^sha256:[a-f0-9]{64}$/) });
  });
  it.each(['missing', 'unknown-contract', 'wrong-commit', 'wrong-image', 'wrong-project', 'wrong-probe', 'wrong-signal'])('refuses stopping the original consumer without matching frozen version readiness: %s', async variant => {
    const f = fixture('worker'); const version = state.getDeploymentVersion('dv-original')!;
    if (variant === 'missing') entry.currentVersionId = undefined;
    if (variant === 'unknown-contract') (version.profiles[0] as any).replacementContractVersion = 2;
    if (variant === 'wrong-commit') version.commitSha = 'e'.repeat(40);
    if (variant === 'wrong-image') version.profiles[0].artifactImage = image;
    if (variant === 'wrong-project') version.projectId = 'other';
    if (variant === 'wrong-probe') (version.profiles[0] as any).readinessProbe = { noHttp: 'false' };
    if (variant === 'wrong-signal') (version.profiles[0] as any).startupSignal = { value: 'READY' };
    await expect(f.service.deploy(f.options)).rejects.toThrow('candidate_serving_version');
    expect(f.events).toEqual([]); expect(f.old.State.Running).toBe(true);
    expect(state.getDeploymentRun(runId)!.candidate).toBeUndefined();
  });
  it('requires the original startup signal when restoring rather than borrowing the new version signal', async () => {
    const f = fixture('worker'); f.setReady(false); f.options.profiles[0].startupSignal = 'NEW_READY';
    state.getDeploymentVersion('dv-original')!.profiles[0].startupSignal = 'OLD_READY';
    const signals: string[] = [];
    f.containers.waitForStartupSignal = async (...args: any[]) => { signals.push(args[1]); return args[1] !== 'OLD_READY'; };
    await expect(f.service.deploy(f.options)).rejects.toThrow('candidate_readiness');
    expect(signals).toEqual(['NEW_READY', 'OLD_READY']);
    expect(entry.services.api.status).toBe('stopped');
    expect(state.getDeploymentRun(runId)!.candidate!.recoveryFailure?.stage).toBe('serving-readiness');
    expect(state.getDeploymentRun(runId)!.candidate!.phase).toBe('reconciling');
  });

  it('protects the original readiness version from pruning while a failed candidate still needs reconciliation', async () => {
    const f = fixture('worker'); f.failCreate();
    await expect(f.service.deploy(f.options)).rejects.toThrow('create-unknown');
    const original = structuredClone(state.getDeploymentVersion('dv-original')!);
    entry.currentVersionId = undefined;
    state.updateDeploymentRun(runId, current => { current.status = 'failed'; });
    for (let i = 0; i < 101; i++) state.addDeploymentVersion({ ...original, id: 'dv-prune-' + i,
      createdAt: '2026-10-11T00:00:' + String(i).padStart(3, '0') });
    await state.flush();
    const loaded = new StateService(path.join(dir, 'state.json')); loaded.load();
    expect(loaded.getDeploymentVersion('dv-original')!.profiles[0].readinessProbe!.path).toBe('/old-health');
    expect(loaded.getDeploymentVersions().length).toBeLessThanOrEqual(100);
    // Control: this test explicitly closes its own fixture ledger; released rows no longer reserve history.
    state.getDeploymentRun(runId)!.candidate!.phase = 'released';
    state.addDeploymentVersion({ ...original, id: 'dv-after-fixture-release', createdAt: '2026-10-12' });
    expect(state.getDeploymentVersion('dv-original')).toBeUndefined();
  });

  it('does not replace a frozen old readiness contract changed during candidate creation', async () => {
    const f = fixture('worker'); const create = f.containers.runService;
    f.containers.runService = async (...args: Parameters<typeof create>) => {
      await create(...args); state.getDeploymentVersion('dv-original')!.profiles[0].readinessProbe!.path = '/changed-health';
    };
    await expect(f.service.deploy(f.options)).rejects.toThrow('candidate_serving_version');
    expect(f.events).not.toContain('docker start ' + f.old.Id);
    expect(f.events).not.toContain('docker rm -f ' + f.old.Id);
    expect(state.getDeploymentRun(runId)!.candidate!.phase).not.toBe('released');
  });

  it('rejects a second candidate graph while a previous failed journal for the branch remains unreleased', async () => {
    const f = fixture('worker');
    const previous = (await new DeploymentRunService(state).begin({ projectId: 'project', branchId: entry.id, trigger: 'manual', commitSha: sha, operationId: 'previous', configHash: 'old' })).id;
    state.updateDeploymentRun(previous, current => { current.status = 'failed'; current.candidate = { operationId: 'previous', targetSha: sha, configHash: 'old', phase: 'reconciling', networkName: 'unknown', updatedAt: '2026-10-11', serving: {}, services: {} }; });
    await expect(f.service.deploy(f.options)).rejects.toThrow('candidate_reconciliation_required');
    expect(f.events).toEqual([]); expect(f.old.State.Running).toBe(true);
  });

  it.each(['old-readiness', 'old-final-ack'])('returns lease cancellation even when it arrives during recovery: %s', async phase => {
    const f = fixture('worker'); const coordinator = new BranchOperationCoordinator();
    const lease = coordinator.begin({ branchId: entry.id, kind: 'deploy', trigger: 'manual' }).lease!;
    const options = { ...f.options, signal: lease.signal, assertCurrent: (step: string) => lease.assertCurrent(step) };
    let acks = 0; options.acknowledge = async () => {
      acks += 1;
      if (phase === 'old-final-ack' && acks === 3) coordinator.cancelBranch(entry.id, 'cancel recovery');
      return acks !== 1;
    };
    if (phase === 'old-readiness') {
      const wait = f.containers.waitForReadiness;
      f.containers.waitForReadiness = async port => { if (port === 10001) coordinator.cancelBranch(entry.id, 'cancel recovery'); return wait(port); };
    }
    await expect(f.service.deploy(options)).rejects.toBeInstanceOf(BranchOperationSupersededError);
    expect(state.getDeploymentRun(runId)!.candidate!.phase).toBe('reconciling');
    expect(state.allocatePort(10002)).not.toBe(10002);
    expect(f.events).not.toContain('docker rm -f ' + f.old.Id);
  });
  it('persists the inspected created ID before a later network/start failure, then restores only after owned candidate cleanup', async () => {
    const f = fixture('worker'); const create = f.containers.runService;
    f.containers.runService = async (...args: Parameters<typeof create>) => {
      const context = args[5]; await context.onCandidateCreateIntent(); await create(...args);
      const created = [...f.objects.values()].find(info => info.Name !== '/old')!;
      created.State.Running = false; args[2].containerId = created.Id;
      await context.onCandidateCreated(created.Id);
      const disk = new StateService(path.join(dir, 'state.json')); disk.load();
      expect(disk.getDeploymentRun(runId)!.candidate!.createdContainers!.api.id).toBe(created.Id);
      expect(disk.getDeploymentRun(runId)!.candidate!.createIntents).toEqual(['api']);
      expect(f.old.State.Running).toBe(false);
      throw new Error('shared-network-failed');
    };
    await expect(f.service.deploy(f.options)).rejects.toThrow('shared-network-failed');
    expect(f.events.some(event => event.startsWith('docker rm -f '))).toBe(true);
    expect(f.events).toContain('docker start ' + f.old.Id);
    expect(f.old.State.Running).toBe(true); expect(f.objects.size).toBe(1);
    expect(state.getDeploymentRun(runId)!.candidate!.phase).toBe('reconciling');
  });

  it.each(['create', 'startup', 'readiness'] as const)('normalizes explicit cancellation during %s into the lease error without deleting either graph', async phase => {
    const f = fixture(); const coordinator = new BranchOperationCoordinator();
    const lease = coordinator.begin({ branchId: entry.id, kind: 'deploy', trigger: 'manual' }).lease!;
    const options = { ...f.options, signal: lease.signal, assertCurrent: (step: string) => lease.assertCurrent(step) };
    const cancel = () => coordinator.cancelBranch(entry.id, 'user cancelled');
    if (phase === 'create') {
      const create = f.containers.runService;
      f.containers.runService = async (...args: Parameters<typeof create>) => { await create(...args); cancel(); lease.signal!.throwIfAborted(); };
    } else if (phase === 'startup') {
      options.profiles[0].startupSignal = 'READY';
      f.containers.waitForStartupSignal = async () => { cancel(); return false; };
    } else f.setWait(async () => { cancel(); return false; });
    await expect(f.service.deploy(options)).rejects.toBeInstanceOf(BranchOperationSupersededError);
    expect(f.events).toEqual(['create-candidate']); expect(f.old.State.Running).toBe(true);
    expect(entry.services.api.containerName).toBe('old'); expect(f.objects.size).toBe(2);
    expect(state.getDeploymentRun(runId)!.candidate!.phase).toBe('reconciling');
  });

  it('leaves the serving graph untouched until all candidates are ready and consumer ACK is durable', async () => {
    const f = fixture(); let release!: () => void; let entered!: () => void;
    const gate = new Promise<boolean>(resolve => { release = () => resolve(true); });
    const reached = new Promise<void>(resolve => { entered = resolve; });
    f.setWait(async () => { entered(); return gate; });
    const pending = f.service.deploy(f.options);
    try { await reached; expect(entry.services.api.containerName).toBe('old'); expect(f.old.State.Running).toBe(true);
      expect(f.events).toEqual(['create-candidate']);
      const restored = new StateService(path.join(dir, 'state.json')); restored.load();
      expect(restored.getDeploymentRun(runId)!.candidate!.phase).toBe('starting');
      expect(restored.getBranch(entry.id)!.services.api.containerName).toBe('old');
    } finally { release(); }
    await pending;
    expect(f.events[1]).toBe('ack'); expect(f.events[2]).toBe('docker rm -f ' + f.old.Id);
    expect(entry.services.api.containerName).toMatch(/^cds-candidate-/);
    expect(state.getDeploymentRun(runId)!.candidate!.phase).toBe('released');
  });
  it('rejects incomplete artifacts and explicit unsafe worker parallel before any Docker mutation', async () => {
    for (const variant of ['missing-artifact', 'worker-parallel']) {
      const f = fixture(variant === 'worker-parallel' ? 'worker' : 'api');
      if (variant === 'missing-artifact') f.options.profiles[0].preparedArtifactId = undefined;
      else f.options.profiles[0].replacementStrategy = 'parallel';
      await expect(f.service.deploy(f.options)).rejects.toThrow('replacement_');
      expect(f.events).toEqual([]); expect(f.old.State.Running).toBe(true);
    }
  });
  it('keeps the original serving container on readiness failure and cleans only a confirmed owned candidate', async () => {
    const f = fixture(); f.setReady(false);
    await expect(f.service.deploy(f.options)).rejects.toThrow('candidate_readiness');
    expect(entry.services.api.containerName).toBe('old'); expect(f.old.State.Running).toBe(true);
    expect(f.events.some(event => event === 'docker rm -f ' + f.old.Id)).toBe(false);
  });

  it('has an immutable inspected recovery proof on actual disk before the first candidate create', async () => {
    const f = fixture(); const create = f.containers.runService;
    f.containers.runService = async (...args: Parameters<typeof create>) => {
      const saved = new StateService(path.join(dir, 'state.json')); saved.load();
      expect((saved.getDeploymentRun(runId)!.candidate as any).recoveryProof).toMatchObject({ version: 1,
        serving: { api: { id: f.old.Id, name: 'old', image: f.old.Image, fingerprint: expect.stringMatching(/^sha256:[a-f0-9]{64}$/) } },
        artifacts: { api: { image, targetSha: sha } } });
      await create(...args);
    };
    await f.service.deploy(f.options);
  });
  it('records stop intent before stopping a worker and starts the original ID after a confirmed candidate failure', async () => {
    const f = fixture('worker'); f.setReady(false);
    await expect(f.service.deploy(f.options)).rejects.toThrow('candidate_readiness');
    expect(f.events[0]).toBe('docker stop -t 10 ' + f.old.Id);
    expect(f.events[1]).toBe('create-candidate');
    expect(f.events).toContain('docker start ' + f.old.Id); expect(f.old.State.Running).toBe(true);
    expect(entry.services.api.containerName).toBe('old'); expect(entry.services.api.status).toBe('running');
    expect(state.getDeploymentRun(runId)!.candidate!.stopBeforeStart).toEqual(['api']);
  });
  it('does not restore a single consumer blindly after an unconfirmed Daemon create outcome', async () => {
    const f = fixture('worker'); f.failCreate();
    await expect(f.service.deploy(f.options)).rejects.toThrow('create-unknown');
    expect(f.old.State.Running).toBe(false); expect(f.events).not.toContain('docker start ' + f.old.Id);
    expect(state.getDeploymentRun(runId)!.candidate!.phase).toBe('reconciling');
    expect(state.allocatePort(10002)).not.toBe(10002);
  });
  it('does not create or stop before capacity admits the overlap, and releases a proven unstarted reservation on rejection', async () => {
    const f = fixture('worker');
    f.options.admit = async () => { throw new Error('capacity-denied'); };
    await expect(f.service.deploy(f.options)).rejects.toThrow('capacity-denied');
    expect(f.events).toEqual([]); expect(f.old.State.Running).toBe(true);
    expect(state.getDeploymentRun(runId)!.candidate!.phase).toBe('released');
    expect(state.allocatePort(10002)).toBe(10002);
  });
  it('does not erase a serving fact mutation during readiness', async () => {
    const f = fixture(); f.setWait(async () => { entry.services.api.deployedImage = 'foreign-new-version'; return true; });
    await expect(f.service.deploy(f.options)).rejects.toThrow('candidate_deploy_drift');
    expect(entry.services.api.deployedImage).toBe('foreign-new-version');
    expect(f.events).toEqual(['create-candidate']); expect(f.old.State.Running).toBe(true);
  });
  it('restores a stopped original worker only after a failed switch restores and acknowledges the old mapping', async () => {
    const f = fixture('worker');
    f.options.acknowledge = async () => { f.events.push('ack'); return entry.services.api.containerName === 'old'; };
    await expect(f.service.deploy(f.options)).rejects.toThrow('candidate_switch_ack');
    const removed = f.events.findIndex(event => event.startsWith('docker rm -f '));
    const restored = f.events.findIndex(event => event === 'docker start ' + f.old.Id);
    expect(f.events.slice(0, removed)).toContain('ack'); expect(restored).toBeGreaterThan(removed);
    expect(f.old.State.Running).toBe(true); expect(entry.services.api.status).toBe('running');
    expect(entry.services.api.containerName).toBe('old');
  });

  it.each(['readiness', 'route-ack'])('does not release rollback reservations before the restored worker %s is confirmed', async failure => {
    const f = fixture('worker'); let acknowledgements = 0;
    f.options.acknowledge = async () => {
      acknowledgements += 1;
      if (acknowledgements === 1) return false;
      const disk = new StateService(path.join(dir, 'state.json')); disk.load();
      expect(disk.getDeploymentRun(runId)!.candidate!.phase).not.toBe('released');
      return failure !== 'route-ack' || acknowledgements === 2;
    };
    if (failure === 'readiness') f.setOldReady(false);
    await expect(f.service.deploy(f.options)).rejects.toThrow('candidate_switch_ack');
    const loaded = new StateService(path.join(dir, 'state.json')); loaded.load();
    expect(loaded.getDeploymentRun(runId)!.candidate!.phase).toBe('reconciling');
    expect(loaded.getDeploymentRun(runId)!.candidate!.recoveryFailure?.stage).toBe(failure === 'readiness' ? 'serving-readiness' : 'route-ack');
    expect(state.allocatePort(10002)).not.toBe(10002);
    expect(f.objects.get(f.old.Id)).toBe(f.old);
    expect(f.events).not.toContain('docker rm -f ' + f.old.Id);
  });

  it('records an explicit recovery failure when the restored original instance is alive but not ready', async () => {
    const f = fixture('worker'); f.setReady(false); f.setOldReady(false);
    await expect(f.service.deploy(f.options)).rejects.toThrow('candidate_readiness');
    expect(f.old.State.Running).toBe(true); expect(entry.services.api.status).toBe('stopped');
    expect(state.getDeploymentRun(runId)!.candidate!.recoveryFailure).toMatchObject({ stage: 'serving-readiness' });
    expect(state.getDeploymentRun(runId)!.candidate!.phase).toBe('reconciling');
  });

});
