import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Server } from 'node:http';
import { spawn } from 'node:child_process';
import { createBranchRouter } from '../../src/routes/branches.js';
import { StateService } from '../../src/services/state.js';
import { WorktreeService } from '../../src/services/worktree.js';
import { ContainerService } from '../../src/services/container.js';
import { MockShellExecutor } from '../../src/services/shell-executor.js';
import { DeploymentRunService } from '../../src/services/deployment-run.js';
import { BranchOperationCoordinator } from '../../src/services/branch-operation-coordinator.js';
import { endSelfUpdateDrain, selfUpdateDrainBlockReason } from '../../src/services/deploy-drain.js';
import { getRestartWait, setRestartWait } from '../../src/services/self-restart-wait.js';
import { selfStatusCache } from '../../src/services/self-status-cache.js';
import type { CdsConfig, IShellExecutor } from '../../src/types.js';

vi.mock('node:child_process', async (original) => ({
  ...await original<typeof import('node:child_process')>(), spawn: vi.fn(),
}));

const sha = 'a'.repeat(40);
describe('self-update cancels before replacing code when other work is active', () => {
  let root: string, state: StateService, shell: MockShellExecutor, server: Server, url: string;
  let runs: DeploymentRunService, coordinator: BranchOperationCoordinator;
  beforeEach(async () => {
    vi.clearAllMocks(); endSelfUpdateDrain(); setRestartWait(null); selfStatusCache._resetForTests();
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-safe-update-'));
    for (const dir of ['cds/dist', 'cds/web/dist']) {
      fs.mkdirSync(path.join(root, dir), { recursive: true });
      fs.writeFileSync(path.join(root, dir, '.build-sha'), sha);
    }
    const config = { repoRoot: root, worktreeBase: path.join(root, 'worktrees'), masterPort: 9900,
      workerPort: 5500, dockerNetwork: 'test', portStart: 10001, rootDomains: ['example.test'],
      previewDomain: 'example.test', sharedEnv: {}, jwt: { secret: 'test', issuer: 'test' } } as CdsConfig;
    shell = new MockShellExecutor();
    shell.addResponsePattern(/git rev-parse --abbrev-ref HEAD/, () => ({ stdout: 'main', stderr: '', exitCode: 0 }));
    shell.addResponsePattern(/git rev-parse --short HEAD/, () => ({ stdout: sha.slice(0, 8), stderr: '', exitCode: 0 }));
    shell.addResponsePattern(/git rev-parse HEAD/, () => ({ stdout: sha, stderr: '', exitCode: 0 }));
    state = new StateService(path.join(root, 'state.json')); state.load();
    state.addBranch({ id: 'other-project', projectId: 'app02', branch: 'main', worktreePath: root,
      createdAt: new Date().toISOString(), status: 'building', services: {} });
    runs = new DeploymentRunService(state); coordinator = new BranchOperationCoordinator();
    // 这里只消费真实HTTP的排空控制流；Git读值仍是原Mock，不声称真实进程或Git验收。
    // 新同票入口要求受控接缝；只承接本夹具三条原只读命令，不运行或伪造改树命令。
    const controlledShell: IShellExecutor = {
      exec: shell.exec.bind(shell),
      async execOwnedOperation(command, options) {
        options.beforeStart();
        if (!/^git rev-parse (?:--abbrev-ref HEAD|--short HEAD|HEAD)$/.test(command)) {
          throw new Error('排空夹具拒绝非原只读Git命令');
        }
        return shell.exec(command, options);
      },
    };
    const app = express(); app.use(express.json());
    app.use('/api', createBranchRouter({ stateService: state, shell: controlledShell, config,
      worktreeService: new WorktreeService(shell, root), containerService: new ContainerService(shell, config),
      registry: { getAll: () => [], getOnline: () => [] } as any,
      deploymentRunService: runs, branchOperationCoordinator: coordinator }));
    server = await new Promise<Server>(resolve => { const instance = app.listen(0, '127.0.0.1', () => resolve(instance)); });
    url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  });
  afterEach(async () => {
    endSelfUpdateDrain(); setRestartWait(null); selfStatusCache._resetForTests();
    await state.flush(); await new Promise<void>(resolve => server.close(() => resolve()));
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });
  for (const endpoint of ['self-update', 'self-force-sync', 'self-restart']) {
    it(`${endpoint}: timeout keeps the other deployment, files and process intact`, async () => {
      const other = await runs.begin({ projectId: 'app02', branchId: 'other-project', trigger: 'manual', initialStatus: 'verifying' });
      const response = await fetch(`${url}/api/${endpoint}`, { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ branch: 'main', force: true, drainTimeoutMs: 5 }) });
      const stream = await response.text();
      expect(stream).toContain('self_update_restart_cancelled');
      expect(stream).not.toContain('event: done');
      expect(state.getDeploymentRun(other.id)?.status).toBe('verifying');
      expect(state.getDeploymentRun(other.id)?.seq).toBe(other.seq);
      expect(spawn).not.toHaveBeenCalled();
      expect(shell.commands.some(command => /git checkout|git reset|build-dist|pnpm/.test(command))).toBe(false);
      for (const dir of ['cds/dist', 'cds/web/dist']) expect(fs.readFileSync(path.join(root, dir, '.build-sha'), 'utf8')).toBe(sha);
      expect(state.getSelfUpdateHistory(1)[0]).toMatchObject({ status: 'aborted', failure: { stage: 'restart-drain' } });
      expect(state.getActiveSelfUpdate()).toBeFalsy(); expect(getRestartWait()).toBeNull();
      expect(selfUpdateDrainBlockReason(Date.now())).toBeNull();
    });
  }
  it('zero wait cannot bypass an active branch operation with no deployment record', async () => {
    const decision = coordinator.begin({ branchId: 'other', projectId: 'app02', kind: 'pull', trigger: 'manual' });
    expect(decision.status).toBe('started');
    const response = await fetch(`${url}/api/self-update`, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ branch: 'main', drain: false, drainTimeoutMs: 0 }) });
    expect(await response.text()).toContain('self_update_restart_cancelled');
    expect(coordinator.getActiveOperations()).toHaveLength(1); expect(spawn).not.toHaveBeenCalled();
    expect(selfUpdateDrainBlockReason(Date.now())).toBeNull();
  });
  it('a second update cannot release the first request’s admission gate', async () => {
    coordinator.begin({ branchId: 'other', projectId: 'app02', kind: 'pull', trigger: 'manual' });
    const first = fetch(`${url}/api/self-restart`, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ drainTimeoutMs: 100 }) });
    await vi.waitFor(() => expect(getRestartWait()).not.toBeNull(), { interval: 5, timeout: 500 });
    const second = await fetch(`${url}/api/self-update`, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ branch: 'main', drainTimeoutMs: 0 }) });
    expect(await second.text()).toContain('concurrency');
    expect(selfUpdateDrainBlockReason(Date.now())).not.toBeNull();
    expect(await (await first).text()).toContain('self_update_restart_cancelled');
    expect(selfUpdateDrainBlockReason(Date.now())).toBeNull();
    expect(coordinator.getActiveOperations()).toHaveLength(1);
  });
});
