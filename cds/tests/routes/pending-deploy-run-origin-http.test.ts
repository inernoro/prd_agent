import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createBranchRouter } from '../../src/routes/branches.js';
import { StateService } from '../../src/services/state.js';
import { ContainerService } from '../../src/services/container.js';
import { WorktreeService } from '../../src/services/worktree.js';
import { MockShellExecutor } from '../../src/services/shell-executor.js';
import { DeploymentVersionService } from '../../src/services/deployment-version.js';
import { DeploymentRunService } from '../../src/services/deployment-run.js';
import { PendingDeployJournal } from '../../src/services/pending-deploy-journal.js';
import { createDeploymentRunsRouter } from '../../src/routes/deployment-runs.js';
import { assertProjectAccess } from '../../src/routes/projects.js';
import { BranchOperationCoordinator, type BranchOperationLease } from '../../src/services/branch-operation-coordinator.js';
import { diskGuard } from '../../src/services/disk-guard.js';
import { selfStatusCache } from '../../src/services/self-status-cache.js';
import { flushAllJsonStateStores } from '../../src/infra/state-store/json-backing-store.js';
describe('actual own HTTP pending-to-run durable binding', () => {
  let root: string; let server: http.Server; let state: StateService; let shell: MockShellExecutor;
  let scopedKey: { projectId: string; keyId: string }; let holder: BranchOperationLease; let runs: DeploymentRunService;
  let journal: PendingDeployJournal; let coordinator: BranchOperationCoordinator; let save: ReturnType<typeof vi.fn>;
  beforeEach(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-owned-pending-http-')); state = new StateService(path.join(root, 'state.json')); state.load();
    state.addBranch({ id: 'owned', projectId: 'default', branch: 'main', worktreePath: root, status: 'running', services: {}, githubCommitSha: 'a'.repeat(40), createdAt: new Date().toISOString() } as any);
    state.addBuildProfile({ id: 'api', projectId: 'default', name: 'api', workDir: '.', dockerImage: 'registry/own/api:sha-${CDS_COMMIT_SHA}', prebuiltImage: true, prebuiltCommitPolicy: 'exact', containerPort: 8080, command: '', activeDeployMode: 'express', deployModes: { express: { label: '极速', prebuilt: true, dockerImage: 'registry/own/api:sha-${CDS_COMMIT_SHA}' } } } as any);
    const config = { repoRoot: root, worktreeBase: root, masterPort: 9900, workerPort: 5500, dockerNetwork: 'owned', portStart: 10001, sharedEnv: {}, mode: 'standalone' } as any;
    save = vi.fn(async () => {}); journal = new PendingDeployJournal({ load: async () => null, save }); await journal.ready();
    coordinator = new BranchOperationCoordinator(undefined, undefined, journal); holder = coordinator.begin({ branchId: 'owned', projectId: 'default', kind: 'deploy', trigger: 'manual', commitSha: 'a'.repeat(40), commitPinned: true, configHash: '1'.repeat(64) }).lease!;
    scopedKey = { projectId: 'default', keyId: 'owned-test' }; runs = new DeploymentRunService(state); shell = new MockShellExecutor(); const app = express(); app.use(express.json());
    app.use((req, _res, next) => { if (req.headers['x-owned-test-project']) (req as any).cdsProjectKey = req.headers['x-owned-test-project'] === 'default' ? scopedKey : { projectId: req.headers['x-owned-test-project'], keyId: 'owned-test' }; next(); });
    app.use('/api', createBranchRouter({ stateService: state, worktreeService: new WorktreeService(shell, root), containerService: new ContainerService(shell, config), shell, config, branchOperationCoordinator: coordinator, deploymentRunService: runs, deploymentVersionService: new DeploymentVersionService(state), registry: { getAll: () => [], getOnline: () => [] } as any }));
    app.use('/api', createDeploymentRunsRouter({ deploymentRunService: runs, assertProjectAccess }));
    server = await new Promise(r => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
    diskGuard.reset(); diskGuard.setProbe(async () => [{ totalBytes: 100, freeBytes: 80 }]); await diskGuard.refreshNow();
  });
  afterEach(async () => { server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); coordinator.clearForTest(); diskGuard.reset(); selfStatusCache._resetForTests(); await flushAllJsonStateStores(); fs.rmSync(root, { recursive: true, force: true }); });
  function post(headers: Record<string, string> = {}, body: Record<string, unknown> = { commitSha: 'b'.repeat(40) }, route = '/api/branches/owned/deploy/api') {
    return new Promise<{ status: number; body: string; headers: http.IncomingHttpHeaders }>((resolve, reject) => {
      const q = http.request({ host: '127.0.0.1', port: (server.address() as any).port, path: route, method: 'POST', agent: false, headers: { 'content-type': 'application/json', ...headers } }, res => {
        let body = ''; res.on('data', c => body += c); res.on('error', reject); res.on('end', () => resolve({ status: res.statusCode!, body, headers: res.headers }));
      }); q.on('error', reject); q.setTimeout(4500, () => q.destroy(Error('own request timeout'))); q.end(JSON.stringify(body));
    });
  }

  async function pending(route: string) {
    await post({}, { commitSha: 'b'.repeat(40) }, route); const p = coordinator.complete(holder, 'completed')!;
    expect(await coordinator.claimPending(p)).toBe(true); expect(coordinator.markPendingSent(p)).toBe(true); return p;
  }
  function token(p: { operationId: string; generation: number }) { return { 'x-owned-test-project': 'default', 'x-cds-internal': '1', 'x-cds-pending-operation-id': p.operationId, 'x-cds-pending-generation': String(p.generation) }; }
  function get(url: string, project = 'default') {
    return new Promise<{ status: number; data: any }>((resolve, reject) => {
      const q = http.get({ host: '127.0.0.1', port: (server.address() as any).port, path: url, agent: false, headers: { 'x-owned-test-project': project } }, res => {
        let body = ''; res.on('data', c => body += c); res.on('error', reject); res.on('end', () => resolve({ status: res.statusCode!, data: JSON.parse(body) }));
      }); q.on('error', reject); q.setTimeout(4500, () => q.destroy(Error('own query timeout')));
    });
  }
  for (const route of ['/api/branches/owned/deploy', '/api/branches/owned/deploy/api']) {
    it('reliably binds actual run before the first runtime action: ' + route, async () => {
      const p = await pending(route); let diskRun: any;
      vi.spyOn(shell, 'exec').mockImplementationOnce(async () => {
        const raw = JSON.parse(fs.readFileSync(path.join(root, 'state.json'), 'utf8'));
        diskRun = Object.values(raw.deploymentRuns).find((run: any) => run.pendingOrigin?.operationId === p.operationId);
        throw Error('owned runtime boundary');
      });
      await post(token(p), { commitSha: 'b'.repeat(40) }, route);
      expect(diskRun?.pendingOrigin).toEqual({ version: 1, operationId: p.operationId, generation: p.generation, profileId: route.endsWith('/api') ? 'api' : null });
      expect(diskRun.operationId).toMatch(/^op_/); expect(diskRun.operationId).not.toBe(p.operationId);
      const url = '/api/deployment-runs?project=default&branch=owned&pendingOperationId=' + p.operationId + '&pendingGeneration=' + p.generation;
      const result = await get(url); expect(result.status).toBe(200); expect(result.data.runs).toHaveLength(1); expect(result.data.runs[0].id).toBe(diskRun.id);
      expect((await get(url.replace('&pendingGeneration=' + p.generation, '&pendingGeneration=' + (p.generation + 1)))).data.runs).toHaveLength(0);
      expect((await get(url, 'foreign')).status).toBe(403);
      expect(coordinator.getActive('owned')).toBeUndefined();
    });
  }
  async function holdBinding() {
    const realBind = runs.bindPendingOrigin.bind(runs); let release!: () => Promise<void>; let entered = false;
    vi.spyOn(runs, 'bindPendingOrigin').mockImplementationOnce((id, lease, check) => {
      const realFlush = state.flush.bind(state); vi.spyOn(state, 'flush').mockImplementationOnce(() => new Promise<void>((resolve, reject) => {
        entered = true; release = () => realFlush().then(resolve, reject);
      })); return realBind(id, lease, check);
    });
    return { entered: () => entered, release: () => release() };
  }
  it('hides the run origin and makes no runtime action before reliable binding ACK', async () => {
    const p = await pending('/api/branches/owned/deploy/api'); const held = await holdBinding();
    const response = post(token(p));
    try {
      await vi.waitFor(() => expect(held.entered()).toBe(true)); expect(shell.commands).toHaveLength(0);
      expect(runs.list().some((run: any) => run.pendingOrigin)).toBe(false);
    } finally { await held.release(); await response; }
    expect(runs.list().some((run: any) => run.pendingOrigin?.operationId === p.operationId)).toBe(true);
  });
  it('binding failure releases its own lease and never touches runtime', async () => {
    const p = await pending('/api/branches/owned/deploy/api'); const realBind = runs.bindPendingOrigin.bind(runs);
    vi.spyOn(runs, 'bindPendingOrigin').mockImplementationOnce((id, lease, check) => {
      vi.spyOn(state, 'flush').mockRejectedValueOnce(Error('PRIVATE_FLUSH_ERROR')); return realBind(id, lease, check);
    });
    const response = await post(token(p)); expect(response.status).toBe(503); expect(response.body).toContain('pending_origin_unavailable'); expect(response.body).not.toContain('PRIVATE_FLUSH_ERROR');
    expect(shell.commands).toHaveLength(0); expect(coordinator.getActive('owned')).toBeUndefined(); expect(runs.list().some((run: any) => run.pendingOrigin)).toBe(false);
  });
  for (const change of ['successor', 'configuration', 'permission', 'cancel'] as const) {
    it('rechecks ' + change + ' after binding await without executing', async () => {
      const p = await pending('/api/branches/owned/deploy/api'); const held = await holdBinding(); const response = post(token(p), { commitSha: 'b'.repeat(40) });
      try {
        await vi.waitFor(() => expect(held.entered()).toBe(true));
        if (change === 'successor') state.getState().branches.owned = { ...state.getBranch('owned')! };
        if (change === 'configuration') state.getBuildProfile('api')!.containerPort = 8081;
        if (change === 'permission') scopedKey.projectId = 'foreign';
        if (change === 'cancel') coordinator.cancelBranch('owned', 'owned test cancellation');
      } finally { await held.release(); }
      const result = await response; expect(result.status).toBe(change === 'permission' ? 403 : 409); expect(result.body).toContain('pending_origin_stale'); expect(shell.commands).toHaveLength(0);
      expect(runs.list().some((run: any) => run.pendingOrigin)).toBe(false); expect(coordinator.getActive('owned')).toBeUndefined();
    });
  }
});
