import { observePendingDeployDispatch } from '../../src/services/pending-deploy-dispatch.js';
import { ownedReadyArtifacts } from '../helpers/owned-ready-artifacts.js';
import { requestArtifactWaitRefresh } from '../../src/services/artifact-admission-wait.js';
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
    state.addProject({ id: 'default', slug: 'default', name: 'Owned fixture project', repoPath: root } as any);
    state.addBranch({ id: 'owned', projectId: 'default', branch: 'main', worktreePath: root, status: 'running', services: {}, githubCommitSha: 'a'.repeat(40), createdAt: new Date().toISOString() } as any);
    state.addBuildProfile({ id: 'api', projectId: 'default', name: 'api', workDir: '.', dockerImage: 'registry/own/api:sha-${CDS_COMMIT_SHA}', prebuiltImage: true, prebuiltCommitPolicy: 'exact', containerPort: 8080, command: '', activeDeployMode: 'express', deployModes: { express: { label: '极速', prebuilt: true, dockerImage: 'registry/own/api:sha-${CDS_COMMIT_SHA}' } } } as any);
    const config = { repoRoot: root, worktreeBase: root, masterPort: 9900, workerPort: 5500, dockerNetwork: 'owned', portStart: 10001, sharedEnv: {}, mode: 'standalone' } as any;
    save = vi.fn(async () => {}); journal = new PendingDeployJournal({ load: async () => null, save }); await journal.ready();
    coordinator = new BranchOperationCoordinator(undefined, undefined, journal); holder = coordinator.begin({ branchId: 'owned', projectId: 'default', kind: 'deploy', trigger: 'manual', commitSha: 'a'.repeat(40), commitPinned: true, configHash: '1'.repeat(64) }).lease!;
    scopedKey = { projectId: 'default', keyId: 'owned-test' }; runs = new DeploymentRunService(state); shell = new MockShellExecutor(); ownedReadyArtifacts(shell, () => 'b'.repeat(40)); const app = express(); app.use(express.json());
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
      }); q.on('error', reject); q.setTimeout(4500, () => q.destroy(Error('own request timeout'))); q.end(JSON.stringify(headers['x-cds-pending-operation-id'] ? { ...body, pendingReplay: { operationId: headers['x-cds-pending-operation-id'], generation: Number(headers['x-cds-pending-generation']) } } : body));
    });
  }

  async function pending(route: string) {
    await post({}, { commitSha: 'b'.repeat(40) }, route); await requestArtifactWaitRefresh(coordinator); const p = coordinator.complete(holder, 'completed')!;
    expect(await coordinator.claimPending(p)).toBe(true); expect(coordinator.markPendingSent(p)).toBe(true); shell.commands.length = 0; return p;
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
      expect(diskRun.operationId).toMatch(/^op_/); expect(diskRun.operationId).toBe(p.operationId);
      const url = '/api/deployment-runs?project=default&branch=owned&pendingOperationId=' + p.operationId + '&pendingGeneration=' + p.generation;
      const result = await get(url); expect(result.status).toBe(200); expect(result.data.runs).toHaveLength(1); expect(result.data.runs[0].id).toBe(diskRun.id);
      expect((await get(url.replace('&pendingGeneration=' + p.generation, '&pendingGeneration=' + (p.generation + 1)))).data.runs).toHaveLength(0);
      expect((await get(url, 'foreign')).status).toBe(403);
      expect(coordinator.getActive('owned')).toBeUndefined();
    });
  }
  it('actual rejected revoked replay persists original State terminal before journal erase and cannot restore a queued run', async () => {
    const p = await pending('/api/branches/owned/deploy');
    let releaseJournal!: () => void;
    save.mockImplementationOnce(() => new Promise<void>(resolve => releaseJournal = resolve));
    const force = coordinator.begin({ projectId: 'default', branchId: 'owned', kind: 'force-rebuild', profileId: 'api', trigger: 'manual', continueWith: 'deploy-profile' });
    expect(force.status).toBe('started'); await vi.waitFor(() => expect(releaseJournal).toBeDefined());
    const url = `http://127.0.0.1:${(server.address() as any).port}/api/branches/owned/deploy`;
    const result = await observePendingDeployDispatch(url, { method: 'POST', headers: { ...token(p), 'content-type': 'application/json' }, body: JSON.stringify({ commitSha: p.request.commitSha, pendingReplay: { operationId: p.operationId, generation: p.generation } }) });
    expect(result.outcome).toBe('failed');
    let releaseState!: () => void;
    const stateAck = new Promise<void>(resolve => releaseState = resolve);
    const settling = coordinator.settlePending(p, result, async () => { await stateAck; await runs.flush(); });
    try {
      await new Promise(resolve => setTimeout(resolve, 20));
      expect(runs.getForOperation(p.operationId, p.generation)?.status).toBe('cancelled');
      expect(journal.snapshot().claims).toHaveLength(1);
    } finally { releaseState(); releaseJournal(); await settling; }
    const reload = new StateService(path.join(root, 'state.json')); reload.load();
    expect(reload.getDeploymentRuns({ branchId: 'owned', status: 'queued' })).toEqual([]);
    expect(journal.snapshot().queued).toEqual([]); expect(journal.snapshot().claims).toEqual([]);
    expect(shell.commands.some(command => /docker (run|create|stop|rm)|git (fetch|pull)/.test(command))).toBe(false);
  });
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
  for (const route of ['/api/branches/owned/deploy', '/api/branches/owned/deploy/api']) {
    it('records actual pull boundary with open/failed facts and no guessed CI duration: ' + route, async () => {
      const p = await pending(route); let entered = false; let release!: () => void;
      const pull = vi.spyOn(WorktreeService.prototype, 'prepareDeploymentSource').mockImplementationOnce(() => new Promise((_resolve, reject) => {
        entered = true; release = () => reject(Error('OWNED_PULL_ERROR_NO_SECRETS'));
      }));
      const response = post(token(p), { commitSha: 'b'.repeat(40) }, route);
      let runId = '';
      try {
        await vi.waitFor(() => expect(entered).toBe(true));
        const list = await get('/api/deployment-runs?project=default&branch=owned');
        const actual = list.data.runs.find((run: any) => run.pendingOrigin?.operationId === p.operationId); runId = actual.id;
        expect(actual.timingSummary.stages.pull).toMatchObject({ status: 'incomplete', open: 1, completedWallMs: null });
        expect(actual.timing).toBeUndefined();
        expect(actual.timingSummary.stages['ci-runner'].completedWallMs).toBeNull();
        expect((await get('/api/deployment-runs/' + runId, 'foreign')).status).toBe(403);
      } finally { release(); await response; pull.mockRestore(); }
      const result = await get('/api/deployment-runs/' + runId); const run = result.data.run;
      expect(run.timing.intervals.find((x: any) => x.boundary === 'git-pull')).toMatchObject({ stage: 'pull', outcome: 'failed' });
      expect(run.timingSummary.stages.pull).toMatchObject({ status: 'observed', open: 0, unknown: 0 });
      expect(run.timingSummary.stages.pull.completedWallMs).toBeGreaterThanOrEqual(0);
      expect(JSON.stringify(run.timing)).not.toContain('OWNED_PULL_ERROR_NO_SECRETS');
      await state.flush(); const reload = new StateService(path.join(root, 'state.json')); reload.load();
      expect(reload.getDeploymentRun(runId)?.timing).toEqual(run.timing);
    });
    it('records exact artifact admission at its actual held Docker query: ' + route, async () => {
      const p = await pending(route); let entered = false; let release!: () => void;
      const pull = vi.spyOn(WorktreeService.prototype, 'prepareDeploymentSource').mockResolvedValueOnce({ head: 'b'.repeat(40), afterFull: 'b'.repeat(40), after: 'b'.repeat(7), sourcePath: root } as any);
      const original = shell.exec.bind(shell);
      const exec = vi.spyOn(shell, 'exec').mockImplementation((command, opts) => command.startsWith('docker version')
        ? new Promise(resolve => { entered = true; release = () => resolve({ stdout: '', stderr: 'OWNED_DOCKER_ERROR', exitCode: 1 }); })
        : original(command, opts));
      const response = post(token(p), { commitSha: 'b'.repeat(40) }, route); let runId = '';
      try {
        await vi.waitFor(() => expect(entered).toBe(true));
        const actual = runs.list().find(run => run.pendingOrigin?.operationId === p.operationId)!; runId = actual.id;
        const query = await get('/api/deployment-runs/' + runId);
        expect(query.data.run.timingSummary.stages.artifact).toMatchObject({ open: 1, completedWallMs: null });
        expect(exec.mock.calls.some(([command]) => /^docker (create|run|rm) /.test(command))).toBe(false);
      } finally { release(); await response; pull.mockRestore(); exec.mockRestore(); }
      const run = (await get('/api/deployment-runs/' + runId)).data.run;
      expect(run.timing.intervals.find((x: any) => x.boundary === 'exact-artifact')).toMatchObject({ stage: 'artifact', outcome: 'failed', commitShaAtStart: 'b'.repeat(40) });
      expect(run.timingSummary.stages.artifact.completedWallMs).toBeGreaterThanOrEqual(0);
      expect(run.timingSummary.stages.startup.completedWallMs).toBeNull();
    });
  }

});
