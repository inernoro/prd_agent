import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import express from 'express';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createBranchRouter } from '../../src/routes/branches.js';
import { createReplicaSetsRouter } from '../../src/routes/replica-sets.js';
import { StateService } from '../../src/services/state.js';
import { ContainerService } from '../../src/services/container.js';
import { WorktreeService } from '../../src/services/worktree.js';
import { MockShellExecutor } from '../../src/services/shell-executor.js';
import { JanitorService } from '../../src/services/janitor.js';
import { diskGuard } from '../../src/services/disk-guard.js';
import { selfStatusCache } from '../../src/services/self-status-cache.js';
import { flushAllJsonStateStores } from '../../src/infra/state-store/json-backing-store.js';
import type { CdsConfig } from '../../src/types.js';
const tick = () => new Promise(r => setImmediate(r));
describe('owned HTTP waits for fresh disk admission', () => {
  let root: string; let server: http.Server; let state: StateService; let shell: MockShellExecutor; let janitor: JanitorService; let failSnapshot: boolean;
  beforeEach(async () => {
    diskGuard.reset(); root = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-owned-disk-http-'));
    state = new StateService(path.join(root, 'state.json')); state.load();
    state.addBranch({ id: 'owned', projectId: 'default', branch: 'main', worktreePath: root, status: 'stopped', createdAt: new Date().toISOString() } as any);
    state.addBuildProfile({ id: 'api', projectId: 'default', name: 'api', runtime: 'docker', containerPort: 8080 } as any);
    const config = { repoRoot: root, worktreeBase: root, masterPort: 9900, workerPort: 5500, dockerNetwork: 'owned', portStart: 10001, sharedEnv: {}, jwt: { secret: 'owned', issuer: 'owned' }, mode: 'standalone', executorPort: 9901 } as CdsConfig;
    shell = new MockShellExecutor(); failSnapshot = false;
    janitor = new JanitorService(state, { enabled: false, worktreeTTLDays: 7, diskWarnPercent: 80 } as any, root, undefined, () => { if (failSnapshot) throw new Error('owned disk read failed'); return { totalBytes: 100, freeBytes: 80 }; });
    const app = express(); app.use(express.json());
    app.use('/api', createReplicaSetsRouter({ stateService: state, replicaSetService: {} as any, deploymentVersionService: {} as any, assertProjectAccess: () => null, dispatchVersion: async () => ({} as any), getDeploymentRunStatus: () => undefined }));
    app.use('/api', createBranchRouter({ stateService: state, worktreeService: new WorktreeService(shell, root), containerService: new ContainerService(shell, config), shell, config, janitorService: janitor }));
    app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => res.status(500).json({ error: err.message }));
    server = await new Promise(r => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  });
  afterEach(async () => {
    await new Promise<void>(r => server.close(() => r())); janitor.stop(); diskGuard.reset(); selfStatusCache._resetForTests();
    await flushAllJsonStateStores(); fs.rmSync(root, { recursive: true, force: true });
  });
  function request(route: string, body?: unknown, method?: string): Promise<{ status: number; body: any }> {
    return new Promise((resolve, reject) => {
      const data = body === undefined ? undefined : JSON.stringify(body);
      const req = http.request({ host: '127.0.0.1', port: (server.address() as any).port, path: '/api' + route, method: method ?? (data ? 'POST' : 'GET'), agent: false, headers: data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : undefined }, res => {
        let raw = ''; res.on('data', b => { raw += b; }); res.on('error', reject);
        res.on('end', () => resolve({ status: res.statusCode!, body: JSON.parse(raw) }));
      }); req.setTimeout(4500, () => req.destroy(new Error('owned request timeout'))); req.on('error', reject); req.end(data);
    });
  }
  it.each(['GET', 'PUT'])('forwards %s async snapshot errors to Express instead of hanging HTTP', async method => {
    failSnapshot = true;
    const response = await request(method === 'GET' ? '/janitor/state' : '/janitor/config', method === 'PUT' ? { enabled: false } : undefined, method);
    expect(response.status).toBe(500); expect(response.body.error).toBe('owned disk read failed');
  });
  it.each(['/branches/owned/deploy', '/branches/owned/deploy/api', '/branches/owned/force-rebuild/api', '/branches/owned/db-guard', '/branches/owned/replica-sets/api/isolate', '/branches/owned/replica-loadtests'])('holds %s while unrelated GET remains responsive, then returns actual 507', async route => {
    let finish!: (value: any) => void; let calls = 0; let completed = false;
    diskGuard.setProbe(() => { calls++; return new Promise(r => { finish = r; }); });
    const result = request(route, { profileId: 'api' }).then(r => { completed = true; return r; });
    try {
      for (let i = 0; i < 50 && !calls; i++) await tick();
      expect(calls).toBe(1); expect(completed).toBe(false);
      expect((await request('/janitor/state')).status).toBe(200); expect(completed).toBe(false);
      finish([{ totalBytes: 100, freeBytes: 70 }, { totalBytes: 100, freeBytes: 4 }]);
      const response = await result; expect(response.status).toBe(507); expect(JSON.stringify(response.body)).toContain('96%');
      expect(shell.commands).toHaveLength(0); expect(state.getDeploymentRuns()).toHaveLength(0);
    } finally { finish?.(null); await result; }
  });
});
