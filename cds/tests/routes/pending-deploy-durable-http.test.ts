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
import { BranchOperationCoordinator } from '../../src/services/branch-operation-coordinator.js';
import { diskGuard } from '../../src/services/disk-guard.js';
import { selfStatusCache } from '../../src/services/self-status-cache.js';
import { flushAllJsonStateStores } from '../../src/infra/state-store/json-backing-store.js';
describe('actual own HTTP durable pending acceptance', () => {
  let root: string; let server: http.Server; let state: StateService; let shell: MockShellExecutor;
  let journal: PendingDeployJournal; let coordinator: BranchOperationCoordinator; let save: ReturnType<typeof vi.fn>;
  beforeEach(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-owned-pending-http-')); state = new StateService(path.join(root, 'state.json')); state.load();
    state.addBranch({ id: 'owned', projectId: 'default', branch: 'main', worktreePath: root, status: 'running', services: {}, githubCommitSha: 'a'.repeat(40), createdAt: new Date().toISOString() } as any);
    state.addBuildProfile({ id: 'api', projectId: 'default', name: 'api', workDir: '.', dockerImage: 'registry/own/api:sha-${CDS_COMMIT_SHA}', prebuiltImage: true, prebuiltCommitPolicy: 'exact', containerPort: 8080, command: '', activeDeployMode: 'express', deployModes: { express: { label: '极速', prebuilt: true, dockerImage: 'registry/own/api:sha-${CDS_COMMIT_SHA}' } } } as any);
    const config = { repoRoot: root, worktreeBase: root, masterPort: 9900, workerPort: 5500, dockerNetwork: 'owned', portStart: 10001, sharedEnv: {}, mode: 'standalone' } as any;
    save = vi.fn(async () => {}); journal = new PendingDeployJournal({ load: async () => null, save }); await journal.ready();
    coordinator = new BranchOperationCoordinator(undefined, undefined, journal); coordinator.begin({ branchId: 'owned', projectId: 'default', kind: 'deploy', trigger: 'manual', commitSha: 'a'.repeat(40), commitPinned: true, configHash: '1'.repeat(64) });
    shell = new MockShellExecutor(); const app = express(); app.use(express.json());
    app.use('/api', createBranchRouter({ stateService: state, worktreeService: new WorktreeService(shell, root), containerService: new ContainerService(shell, config), shell, config, branchOperationCoordinator: coordinator, deploymentRunService: new DeploymentRunService(state), deploymentVersionService: new DeploymentVersionService(state), registry: { getAll: () => [], getOnline: () => [] } as any }));
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
  it('sends no successful response until the journal ACK; removes cancelled placeholder run header', async () => {
    let finish!: () => void; save.mockImplementationOnce(() => new Promise<void>(r => finish = r));
    let returned = false; const response = post().then(r => { returned = true; return r; });
    try {
      await vi.waitFor(() => expect(save).toHaveBeenCalledOnce(), { timeout: 1000, interval: 10 }); expect(returned).toBe(false); expect(shell.commands).toHaveLength(0);
      finish(); const result = await response; expect(result.status).toBe(200); expect(result.body).toContain('"operationStatus":"merged"'); expect(result.body).toContain('"generation":'); expect(result.headers['x-cds-deployment-run-id']).toBeUndefined();
      expect(journal.snapshot().queued[0].request.commitSha).toBe('b'.repeat(40)); expect(journal.snapshot().queued[0].request.profileId).toBe('api');
    } finally { finish?.(); await response; }
  });
  it('returns 503 on an uncertain journal write rather than accepted SSE', async () => {
    save.mockRejectedValueOnce(Error('private-IO-detail')); const result = await post(); expect(result.status).toBe(503); expect(result.body).toContain('pending_journal_unavailable'); expect(result.body).not.toContain('private-IO-detail'); expect(result.body).not.toContain('"ok":true'); expect(shell.commands).toHaveLength(0);
  });
  it('rejects a delayed internal token before pull/container actions even if branch and target still exist', async () => {
    const result = await post({ 'x-cds-internal': '1', 'x-cds-pending-operation-id': 'op_old', 'x-cds-pending-generation': '2' });
    expect(result.body).toContain('pending_dispatch_stale'); expect(result.body).toContain('"ok":false'); expect(shell.commands).toHaveLength(0); expect(save).not.toHaveBeenCalled();
  });
  it('durably captures a SHA-neutral configuration digest on actual unpinned whole acceptance', async () => {
    const route = '/api/branches/owned/deploy'; await post({}, {}, route);
    const first = journal.snapshot().queued[0].request as any; expect(first.commitPinned).toBe(false); expect(first.pendingConfigHash).toMatch(/^[0-9a-f]{64}$/);
    state.getBranch('owned')!.githubCommitSha = 'c'.repeat(40); state.getBranch('owned')!.ciTargetSha = 'c'.repeat(40);
    await post({}, {}, route); const advanced = journal.snapshot().queued[0].request as any;
    expect(advanced.configHash).not.toBe(first.configHash); expect(advanced.pendingConfigHash).toBe(first.pendingConfigHash);
    state.getBuildProfile('api')!.containerPort = 8081;
    await post({}, {}, route); expect((journal.snapshot().queued[0].request as any).pendingConfigHash).not.toBe(first.pendingConfigHash);
  });

});
