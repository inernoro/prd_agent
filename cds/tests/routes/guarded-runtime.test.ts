import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type http from 'node:http';
import { createBranchRouter } from '../../src/routes/branches.js';
import { StateService } from '../../src/services/state.js';
import { SchedulerService } from '../../src/services/scheduler.js';
import { BranchOperationCoordinator } from '../../src/services/branch-operation-coordinator.js';
import { DeploymentRunService } from '../../src/services/deployment-run.js';
import { ContainerService } from '../../src/services/container.js';
import { WorktreeService } from '../../src/services/worktree.js';
import { MockShellExecutor } from '../../src/services/shell-executor.js';
import { selfStatusCache } from '../../src/services/self-status-cache.js';
import { flushAllJsonStateStores } from '../../src/infra/state-store/json-backing-store.js';
import { unitBindMountInspector } from '../helpers/storage-bind-fixture.js';
import type { BranchEntry, CdsConfig } from '../../src/types.js';

const sha = 'a'.repeat(40), image = 'registry.example/preview@sha256:' + 'b'.repeat(64);
describe('guarded runtime routes on the current platform', () => {
  let dir: string, state: StateService, scheduler: SchedulerService, coordinator: BranchOperationCoordinator;
  let entry: BranchEntry, container: ContainerService, server: http.Server, origin: string;
  let physical: Set<string>, observationKnown: boolean;
  let shell: MockShellExecutor;
  const events: any[] = [];
  const guard = () => ({ expectedMaxHotBranches: 2, expectedCommitSha: sha, yieldFirst: true,
    expectedImage: image, expectedContainers: Object.fromEntries(Object.values(entry.services).map(s => [s.profileId, s.containerId])) });
  async function post(action: string, body: unknown) {
    const response = await fetch(origin + '/api/branches/bounded/' + action, { method: 'POST',
      headers: { 'content-type': 'application/json', 'x-cds-request-id': 'guarded-fixture-' + action }, body: JSON.stringify(body) });
    const raw = await response.text();
    return { status: response.status, body: response.headers.get('content-type')?.includes('application/json') ? JSON.parse(raw) : { text: raw } };
  }
  beforeEach(async () => {
    selfStatusCache._resetForTests(); events.length = 0;
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-guarded-runtime-'));
    const config = { repoRoot: dir, worktreeBase: path.join(dir, 'worktrees'), masterPort: 9900,
      workerPort: 5500, dockerNetwork: 'test-network', portStart: 10001,
      rootDomains: ['example.test'], previewDomain: 'example.test', sharedEnv: {},
      jwt: { secret: 'isolated-test-fixture', issuer: 'test' } } as CdsConfig;
    state = new StateService(path.join(dir, 'state.json')); state.load();
    entry = { id: 'bounded', branch: 'feature/bounded', projectId: 'default', worktreePath: path.join(dir, 'wt'),
      githubCommitSha: sha, status: 'idle', createdAt: new Date().toISOString(), services: {} };
    for (let i = 0; i < 5; i++) {
      const id = 'service-' + i, cid = (i + 1).toString().repeat(64);
      state.addBuildProfile({ id, name: id, projectId: 'default', dockerImage: image,
        prebuiltImage: true, workDir: '.', containerPort: 8080 });
      entry.services[id] = { profileId: id, containerName: 'container-' + i, containerId: cid,
        hostPort: 10001 + i, status: 'stopped', deployedImage: image, sourceCommitSha: sha, networkName: 'own' };
    }
    state.addBranch(entry); entry = state.getBranch('bounded')!;
    physical = new Set(); observationKnown = true;
    coordinator = new BranchOperationCoordinator({ record: event => events.push(event) });
    scheduler = new SchedulerService(state, { enabled: true, maxHotBranches: 2,
      idleTTLSeconds: 86400, tickIntervalSeconds: 60, pinnedBranches: [] });
    scheduler.setRuntimePresenceProvider(() => observationKnown ? physical : null);
    scheduler.setOperationProtection(id => coordinator.getActiveOperations(id).length > 0);
    shell = new MockShellExecutor();
    container = new ContainerService(shell, config, undefined, undefined, undefined, undefined, unitBindMountInspector);
    vi.spyOn(container, 'inspectGuardedRuntime').mockImplementation(async (_e, _id, ref) => ({ ...ref }));
    vi.spyOn(container, 'stop').mockImplementation(async (cid, _reason, context) => {
      context?.assertCurrent?.('before physical stop fixture');
      const service = Object.values(entry.services).find(s => s.containerId === cid)!;
      physical.delete(service.containerName);
    });
    vi.spyOn(container, 'stopRuntimeGroup');
    vi.spyOn(container, 'restartServiceInPlace').mockImplementation(async (cid, _timeout, context) => {
      context?.assertCurrent?.('before physical restart fixture');
      const service = Object.values(entry.services).find(s => s.containerId === cid)!;
      physical.add(service.containerName); return true;
    });
    vi.spyOn(container, 'waitForReadiness').mockResolvedValue(true);
    vi.spyOn(container, 'runService');
    const app = express(); app.use(express.json());
    app.use('/api', createBranchRouter({ stateService: state, schedulerService: scheduler,
      branchOperationCoordinator: coordinator, deploymentRunService: new DeploymentRunService(state),
      worktreeService: new WorktreeService(shell, dir), containerService: container, shell, config }));
    server = await new Promise<http.Server>(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
    origin = 'http://127.0.0.1:' + (server.address() as { port: number }).port;
  });
  afterEach(async () => {
    await new Promise<void>(resolve => server.close(() => resolve()));
    scheduler.stop(); selfStatusCache._resetForTests(); vi.restoreAllMocks();
    await flushAllJsonStateStores(); fs.rmSync(dir, { recursive: true, force: true });
  });
  it('restores the same five CIDs and confirms readiness without creating replacement containers', async () => {
    const expected = guard(), result = await post('restart', { capacityGuard: expected });
    expect(result.status).toBe(200); expect(result.body.containers).toEqual(expected.expectedContainers);
    expect(container.restartServiceInPlace).toHaveBeenCalledTimes(5);
    expect(vi.mocked(container.restartServiceInPlace).mock.calls.map(c => c[0])).toEqual(Object.values(expected.expectedContainers));
    expect(container.waitForReadiness).toHaveBeenCalledTimes(5);
    expect(container.runService).not.toHaveBeenCalled(); expect(entry.capacityYieldFirst).toBe(true);
    expect(result.body.operationId).toBeTruthy();
  });
  it('stops only frozen CIDs and retains all source records without expanding to old runtime groups', async () => {
    entry.status = 'running'; entry.heatState = 'hot'; entry.capacityYieldFirst = true;
    for (const s of Object.values(entry.services)) { s.status = 'running'; physical.add(s.containerName); }
    const expected = guard(), result = await post('stop', { capacityGuard: expected });
    expect(result.status).toBe(200); expect(container.stop).toHaveBeenCalledTimes(5);
    expect(vi.mocked(container.stop).mock.calls.map(c => c[0])).toEqual(Object.values(expected.expectedContainers));
    expect(container.stopRuntimeGroup).not.toHaveBeenCalled(); expect(entry.heatState).toBe('cold');
    expect(entry.capacityYieldFirst).toBeUndefined(); expect(Object.keys(entry.services)).toHaveLength(5);
  });
  it('rejects a stale CID set or physical identity mismatch before any stop or restart', async () => {
    const wrong = guard(); wrong.expectedContainers['service-2'] = 'f'.repeat(64);
    expect((await post('restart', { capacityGuard: wrong })).status).toBe(409);
    vi.mocked(container.inspectGuardedRuntime).mockImplementation(async (_e, _p, ref) => ({ ...ref, containerId: 'e'.repeat(64) }));
    expect((await post('restart', { capacityGuard: guard() })).status).toBe(500);
    expect(container.stop).not.toHaveBeenCalled(); expect(container.restartServiceInPlace).not.toHaveBeenCalled();
  });
  it('fails closed on unknown occupancy and on a competing operation without cancelling the incumbent', async () => {
    observationKnown = false;
    expect((await post('restart', { capacityGuard: guard() })).status).toBe(500);
    expect(container.restartServiceInPlace).not.toHaveBeenCalled();
    observationKnown = true;
    const active = coordinator.begin({ branchId: entry.id, projectId: 'default', kind: 'deploy', source: 'fixture', trigger: 'manual' });
    expect(active.status).toBe('started');
    expect((await post('stop', { capacityGuard: guard() })).status).toBe(409);
    expect(() => active.lease!.assertCurrent('incumbent retained')).not.toThrow();
    coordinator.completeAll(active.lease!, 'cancelled');
  });
  it('refuses plain requests for a protected branch instead of silently dropping the guard', async () => {
    entry.capacityYieldFirst = true;
    expect((await post('restart', {})).status).toBe(409);
    expect((await post('stop', {})).status).toBe(409);
    expect(container.stop).not.toHaveBeenCalled(); expect(container.restartServiceInPlace).not.toHaveBeenCalled();
  });
  it('initial prebuilt deployment reaches the shared capacity gate and refuses a full pool without stopping peers', async () => {
    entry.services = {};
    vi.spyOn(container, 'inspectDeploymentArtifacts').mockImplementation(async profiles => ({
      state: 'ready', targetCommitSha: sha, checkedAt: new Date().toISOString(), artifacts: profiles.map(p => ({
        profileIds: [p.id], requestedImage: image, image, revision: sha, platform: 'linux/amd64', proof: { kind: 'exact-target' as const },
      })),
    }));
    shell.addResponsePattern(/docker info/, () => ({ stdout: JSON.stringify({ Architecture: 'x86_64', OSType: 'linux' }), stderr: '', exitCode: 0 }));
    shell.addResponsePattern(/docker pull/, () => ({ stdout: 'available', stderr: '', exitCode: 0 }));
    shell.addResponsePattern(/docker image inspect/, () => ({ stdout: JSON.stringify([{ Id: 'sha256:' + 'b'.repeat(64),
      RepoDigests: [image], Os: 'linux', Architecture: 'amd64', Config: { Labels: { 'org.opencontainers.image.revision': sha } } }]), stderr: '', exitCode: 0 }));
    for (const id of ['ordinary-a', 'ordinary-b']) state.addBranch({ id, branch: id, worktreePath: '/tmp/fixture',
      status: 'running', heatState: 'hot', services: {}, createdAt: new Date().toISOString() });
    const reserve = vi.spyOn(scheduler, 'reserveNoEviction');
    const response = await post('deploy/service-0', { commitSha: sha, capacityGuard: guard() });
    expect(response.status, JSON.stringify(response.body)).toBeGreaterThanOrEqual(400);
    expect(reserve).toHaveBeenCalledWith('bounded', 2, true);
    expect(container.runService).not.toHaveBeenCalled(); expect(container.stop).not.toHaveBeenCalled();
    expect(state.getBranch('ordinary-a')!.status).toBe('running');
    expect(state.getBranch('ordinary-b')!.status).toBe('running');
  });
  it.each(['digest', 'repository', 'revision'] as const)('rejects a fresh deployment with a different admitted %s before admission or capacity reservation', async mismatch => {
    entry.services = {};
    const tag = 'registry.example/preview:sha-' + sha;
    for (let i = 0; i < 5; i++) state.updateBuildProfile('service-' + i, { dockerImage: tag });
    const actual = mismatch === 'repository' ? 'registry.example/other@sha256:' + 'b'.repeat(64)
      : 'registry.example/preview@sha256:' + (mismatch === 'digest' ? 'd' : 'b').repeat(64);
    vi.spyOn(container, 'inspectDeploymentArtifacts').mockImplementation(async profiles => ({
      state: 'ready', targetCommitSha: sha, checkedAt: new Date().toISOString(), artifacts: profiles.map(p => ({
        profileIds: [p.id], requestedImage: p.dockerImage, image: actual,
        revision: mismatch === 'revision' ? 'c'.repeat(40) : sha, platform: 'linux/amd64', proof: { kind: 'exact-target' as const },
      })),
    }));
    const begin = vi.spyOn(coordinator, 'begin'), remember = vi.spyOn(coordinator, 'rememberDeploymentInput');
    const reserve = vi.spyOn(scheduler, 'reserveNoEviction');
    const result = await post('deploy/service-0', { commitSha: sha, capacityGuard: guard() });
    expect(result.status).toBe(409); expect(result.body.error).toBe('runtime_guard_rejected');
    expect(begin).not.toHaveBeenCalled(); expect(remember).not.toHaveBeenCalled(); expect(reserve).not.toHaveBeenCalled();
    expect(container.runService).not.toHaveBeenCalled(); expect(container.stop).not.toHaveBeenCalled();
    expect(entry.lastDeploymentRunId).toBeUndefined();
  });
  it('requires an immutable expected image for a fresh guarded deployment', async () => {
    entry.services = {};
    const expected = guard(); delete (expected as Partial<typeof expected>).expectedImage;
    const inspect = vi.spyOn(container, 'inspectDeploymentArtifacts'), begin = vi.spyOn(coordinator, 'begin');
    const result = await post('deploy/service-0', { commitSha: sha, capacityGuard: expected });
    expect(result.status).toBe(409); expect(result.body.error).toBe('runtime_guard_rejected');
    expect(inspect).not.toHaveBeenCalled(); expect(begin).not.toHaveBeenCalled();
    expect(container.runService).not.toHaveBeenCalled();
  });
  it('configuration cannot change the readiness criteria after the first restart has begun', async () => {
    vi.mocked(container.restartServiceInPlace).mockImplementationOnce(async (_cid, _timeout, context) => {
      context?.assertCurrent?.('first restart');
      state.updateBuildProfile('service-0', { readinessProbe: { noHttp: true } });
      return true;
    });
    const response = await post('restart', { capacityGuard: guard() });
    expect(response.status).toBe(500);
    expect(container.restartServiceInPlace).toHaveBeenCalledTimes(1);
    expect(container.waitForReadiness).not.toHaveBeenCalled();
  });
});
