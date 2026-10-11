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
describe('actual owned whole/Profile CI timing observation', () => {
  let root: string; let server: http.Server; let state: StateService; let shell: MockShellExecutor;
  let scopedKey: { projectId: string; keyId: string }; let holder: BranchOperationLease; let runs: DeploymentRunService;
  let ciFetch: ReturnType<typeof vi.fn>;
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
    state.addProject({ id: 'default', slug: 'default', name: 'Owned CI project', kind: 'git', legacyFlag: true, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
    const project = state.getProject('default')!; project.githubRepoFullName = 'owner/repo'; project.githubInstallationId = 1;
    ciFetch = vi.fn();
    const githubApp = { getCiTiming: ciFetch, createCheckRun: vi.fn(async () => ({ id: 1 })), updateCheckRun: vi.fn(async () => {}) } as any;
    app.use('/api', createBranchRouter({ githubApp, stateService: state, worktreeService: new WorktreeService(shell, root), containerService: new ContainerService(shell, config), shell, config, branchOperationCoordinator: coordinator, deploymentRunService: runs, deploymentVersionService: new DeploymentVersionService(state), registry: { getAll: () => [], getOnline: () => [] } as any }));
    app.use('/api', createDeploymentRunsRouter({ deploymentRunService: runs, assertProjectAccess }));
    server = await new Promise(r => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
    diskGuard.reset(); diskGuard.setProbe(async () => [{ totalBytes: 100, freeBytes: 80 }]); await diskGuard.refreshNow();
  });
  afterEach(async () => { if (server) { server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); } coordinator.clearForTest(); diskGuard.reset(); selfStatusCache._resetForTests(); await flushAllJsonStateStores(); fs.rmSync(root, { recursive: true, force: true }); });
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

  const ciRecord = () => ({ version: 1, provider: 'github', repository: 'owner/repo', headBranch: 'main', headSha: 'b'.repeat(40), workflowPath: '.github/workflows/branch-image.yml', event: 'push', runId: 123, runAttempt: 2, truncated: false, jobs: [{ id: 5, createdAt: '2026-10-11T00:00:00Z', startedAt: '2026-10-11T00:00:10Z', completedAt: '2026-10-11T00:00:30Z', outcome: 'completed' }] });
  for (const route of ['/api/branches/owned/deploy', '/api/branches/owned/deploy/api']) {
    for (const scenario of ['live', 'terminal', 'project-rebind'] as const) {
      it('keeps exact owned CI facts and nonblocking artifact admission: '+scenario+' '+route, async () => {
        const p = await pending(route); let entered = false; let releaseArtifact!: () => void; let releaseProvider!: (value: any) => void;
        ciFetch.mockImplementation(() => new Promise(resolve => { releaseProvider = resolve; }));
        const pull = vi.spyOn(WorktreeService.prototype, 'pull').mockResolvedValueOnce({ head: 'b'.repeat(40), afterFull: 'b'.repeat(40), after: 'b'.repeat(7) } as any);
        const original = shell.exec.bind(shell);
        const exec = vi.spyOn(shell, 'exec').mockImplementation((command, opts) => command.startsWith('docker version')
          ? new Promise(resolve => { entered = true; releaseArtifact = () => resolve({ stdout: '', stderr: 'OWNED_DOCKER_ERROR', exitCode: 1 }); }) : original(command, opts));
        const response = post(token(p), { commitSha: 'b'.repeat(40) }, route); let runId = '';
        try {
          await vi.waitFor(() => expect(entered).toBe(true)); // Provider pending must not stop real artifact admission.
          await vi.waitFor(() => expect(ciFetch).toHaveBeenCalledTimes(1));
          expect(ciFetch.mock.calls[0][0]).toEqual({ installationId: 1, repository: 'owner/repo', branch: 'main', headSha: 'b'.repeat(40) });
          const actual = runs.list().find(run => run.pendingOrigin?.operationId === p.operationId)!; runId = actual.id;
          expect(actual.ciTiming).toBeUndefined();
          if (scenario === 'terminal') { releaseArtifact(); await response; }
          if (scenario === 'project-rebind') state.getProject('default')!.githubRepoFullName = 'another/repo';
          releaseProvider(ciRecord());
          if (scenario === 'live') {
            await vi.waitFor(() => expect(actual.ciTiming?.runId).toBe(123));
            const detail = (await get('/api/deployment-runs/'+runId)).data.run;
            expect(detail.timingSummary.stages['ci-runner']).toMatchObject({ status: 'observed', completedWallMs: 10000 });
            expect(detail.timingSummary.stages['ci-build']).toMatchObject({ status: 'observed', completedWallMs: 20000 });
            expect(detail.timingSummary.ci).toMatchObject({ clock: 'github-provider', runnerMeaning: 'job-pre-start', buildMeaning: 'job-execution' });
            const list = (await get('/api/deployment-runs?branchId=owned')).data.runs.find((r: any) => r.id === runId);
            expect(list.ciTiming).toBeUndefined(); expect(list.timingSummary.ci.provenance.runAttempt).toBe(2);
            expect((await get('/api/deployment-runs/'+runId, 'foreign')).status).toBe(403);
            await state.flush(); const reload = new StateService(path.join(root, 'state.json')); reload.load(); expect(reload.getDeploymentRun(runId)?.ciTiming).toEqual(actual.ciTiming);
          } else {
            await new Promise(resolve => setImmediate(resolve)); expect(actual.ciTiming).toBeUndefined();
          }
        } finally { releaseProvider?.(null); releaseArtifact?.(); await response; pull.mockRestore(); exec.mockRestore(); }
      });
    }
  }
});
