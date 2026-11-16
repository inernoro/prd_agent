import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import express from 'express';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { StateService } from '../../src/services/state.js';
import { SchedulerService } from '../../src/services/scheduler.js';
import { ContainerService } from '../../src/services/container.js';
import { BranchOperationCoordinator } from '../../src/services/branch-operation-coordinator.js';
import { createBranchRouter } from '../../src/routes/branches.js';
import { flushAllJsonStateStores } from '../../src/infra/state-store/json-backing-store.js';

const commit = 'a'.repeat(40);
const containerId = 'b'.repeat(64);
const image = 'ghcr.io/example/synthetic@sha256:' + 'c'.repeat(64);
let root: string;
let state: StateService;
let scheduler: SchedulerService;
let server: http.Server;
let container: { inspectOwnedRuntime: ReturnType<typeof vi.fn>; assertStoppedStatelessImage: ReturnType<typeof vi.fn>; restartServiceInPlace: ReturnType<typeof vi.fn> };

async function call(method: string, route: string, body?: unknown) {
  return new Promise<{ status: number; body: any }>((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: (server.address() as { port: number }).port,
      path: route, method, headers: { 'content-type': 'application/json' } }, res => {
      let raw = '';
      res.on('data', chunk => { raw += chunk; });
      res.on('end', () => { try { resolve({ status: res.statusCode || 0, body: JSON.parse(raw) }); } catch (error) { reject(error); } });
    });
    req.on('error', reject);
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });
}

beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'guarded-capacity-'));
  state = new StateService(path.join(root, 'state.json'));
  state.load();
  state.addProject({ id: 'p', slug: 'p', name: 'Synthetic', kind: 'git', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
  for (const id of ['old-1', 'old-2']) state.addBranch({ id, projectId: 'p', branch: id, worktreePath: root,
    status: 'running', createdAt: new Date().toISOString(), services: {} });
  state.addBranch({ id: 'trial', projectId: 'p', branch: 'trial', worktreePath: root, status: 'idle',
    githubCommitSha: commit, createdAt: new Date().toISOString(), services: { api: {
      profileId: 'api', containerName: 'trial-api', containerId, hostPort: 12000, status: 'stopped',
      deployedImage: image,
    } } });
  scheduler = new SchedulerService(state, { enabled: true, maxHotBranches: 2,
    idleTTLSeconds: 900, tickIntervalSeconds: 600, pinnedBranches: [] });
  scheduler.setRuntimePresenceProvider(() => new Set(), () => true);
  container = { inspectOwnedRuntime: vi.fn(async (_entry, _profile, svc) => ({ ...svc, containerId })),
    assertStoppedStatelessImage: vi.fn(async () => undefined), restartServiceInPlace: vi.fn(async () => true) };
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { (req as any).cdsProjectKey = { projectId: 'p', keyId: 'synthetic' }; next(); });
  const shell = { exec: vi.fn(async () => ({ exitCode: 0, stdout: '', stderr: '' })) };
  app.use('/api', createBranchRouter({ stateService: state, schedulerService: scheduler,
    branchOperationCoordinator: new BranchOperationCoordinator(), containerService: container as any,
    worktreeService: {} as any, shell: shell as any,
    config: { repoRoot: root, worktreeBase: root, dockerNetwork: 'synthetic', portStart: 10000,
      masterPort: 9900, workerPort: 5500, sharedEnv: {}, jwt: { secret: 'synthetic', issuer: 'synthetic' } } as any }));
  server = await new Promise(resolve => { const running = app.listen(0, '127.0.0.1', () => resolve(running)); });
});

afterEach(async () => {
  scheduler.stop();
  await new Promise<void>(resolve => server.close(() => resolve()));
  await flushAllJsonStateStores();
  fs.rmSync(root, { recursive: true, force: true });
});

it('requires a conditional increase and rejects a stale cap without affecting peers', async () => {
  const updated = await call('PUT', '/api/scheduler/config', { expectedMaxHotBranches: 2, maxHotBranches: 3, preserveRunning: true });
  expect(updated.status).toBe(200);
  expect(updated.body.capacityUsage.max).toBe(3);
  const stale = await call('PUT', '/api/scheduler/config', { expectedMaxHotBranches: 2, maxHotBranches: 4, preserveRunning: true });
  expect(stale.status).toBe(409);
  expect(scheduler.getSnapshot().capacityUsage.max).toBe(3);
  expect(state.getBranch('old-1')?.status).toBe('running');
  expect(state.getBranch('old-2')?.status).toBe('running');
});

it('refuses a guarded restart at full capacity before any container starts', async () => {
  const result = await call('POST', '/api/branches/trial/restart', { capacityGuard: {
    expectedMaxHotBranches: 2, yieldFirst: true, expectedCommitSha: commit,
    expectedImage: image, expectedContainers: { api: containerId },
  } });
  expect(result.status).toBe(409);
  expect(container.inspectOwnedRuntime).not.toHaveBeenCalled();
  expect(container.restartServiceInPlace).not.toHaveBeenCalled();
  expect(state.getBranch('trial')?.status).toBe('idle');
  expect(state.getBranch('trial')?.capacityYieldFirst).toBeUndefined();
  expect(state.getBranch('old-1')?.status).toBe('running');
  expect(state.getBranch('old-2')?.status).toBe('running');
});

it('checks entity, image and mounts before restarting the exact retained ID', async () => {
  expect((await call('PUT', '/api/scheduler/config', { expectedMaxHotBranches: 2, maxHotBranches: 3, preserveRunning: true })).status).toBe(200);
  const guard = { expectedMaxHotBranches: 3, yieldFirst: true, expectedCommitSha: commit,
    expectedImage: image, expectedContainers: { api: containerId } };
  const result = await call('POST', '/api/branches/trial/restart', { capacityGuard: guard });
  expect(result.status).toBe(200);
  expect(container.inspectOwnedRuntime).toHaveBeenCalledOnce();
  expect(container.assertStoppedStatelessImage).toHaveBeenCalledWith(containerId, image);
  expect(container.restartServiceInPlace.mock.calls[0][0]).toBe(containerId);
  expect(state.getBranch('trial')?.capacityYieldFirst).toBe(true);
  expect(state.getBranch('old-1')?.status).toBe('running');
  expect(state.getBranch('old-2')?.status).toBe('running');
});

it('will not restore the old cap while the trial still occupies its temporary slot', async () => {
  expect((await call('PUT', '/api/scheduler/config', { expectedMaxHotBranches: 2, maxHotBranches: 3, preserveRunning: true })).status).toBe(200);
  const guard = { expectedMaxHotBranches: 3, yieldFirst: true, expectedCommitSha: commit,
    expectedImage: image, expectedContainers: { api: containerId } };
  expect((await call('POST', '/api/branches/trial/restart', { capacityGuard: guard })).status).toBe(200);
  const denied = await call('PUT', '/api/scheduler/config', { expectedMaxHotBranches: 3, maxHotBranches: 2, preserveRunning: true });
  expect(denied.status).toBe(409);
  expect(scheduler.getSnapshot().capacityUsage.max).toBe(3);
  expect(state.getBranch('old-1')?.status).toBe('running');
  expect(state.getBranch('old-2')?.status).toBe('running');
});

it('does not idle-cool a different branch while it is still warming', async () => {
  const cooling = vi.fn(async () => undefined);
  scheduler.setCoolFn(cooling);
  state.addBranch({ id: 'warming-peer', projectId: 'p', branch: 'warming-peer', worktreePath: root,
    status: 'starting', heatState: 'warming', services: {}, createdAt: new Date(Date.now() - 3_600_000).toISOString(),
    lastAccessedAt: new Date(Date.now() - 3_600_000).toISOString() });
  await scheduler.tick();
  expect(cooling).not.toHaveBeenCalledWith('warming-peer');
  expect(state.getBranch('warming-peer')?.heatState).toBe('warming');
});

it('accepts the Docker inspect shape only for a stopped stateless exact image', async () => {
  const view = { id: containerId, running: false, image, mounts: [], tmpfs: null };
  const exec = vi.fn(async () => ({ exitCode: 0, stdout: JSON.stringify(view), stderr: '' }));
  const subject = Object.create(ContainerService.prototype) as ContainerService;
  (subject as any).shell = { exec };
  await expect(subject.assertStoppedStatelessImage(containerId, image)).resolves.toBeUndefined();
  expect(exec.mock.calls[0][0]).toContain('docker inspect --format');
  for (const unsafe of [
    { ...view, id: 'd'.repeat(64) },
    { ...view, running: true },
    { ...view, image: 'ghcr.io/example/other@sha256:' + 'c'.repeat(64) },
    { ...view, mounts: [{ Type: 'volume', Destination: '/data' }] },
    { ...view, tmpfs: { '/tmp': 'rw' } },
    { ...view, mounts: null },
  ]) {
    exec.mockResolvedValueOnce({ exitCode: 0, stdout: JSON.stringify(unsafe), stderr: '' });
    await expect(subject.assertStoppedStatelessImage(containerId, image)).rejects.toThrow();
  }
});
