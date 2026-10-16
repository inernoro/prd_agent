import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createBranchRouter } from '../../src/routes/branches.js';
import { StateService } from '../../src/services/state.js';
import { WorktreeService } from '../../src/services/worktree.js';
import { ContainerService } from '../../src/services/container.js';
import { MockShellExecutor } from '../../src/services/shell-executor.js';
import { BranchOperationCoordinator } from '../../src/services/branch-operation-coordinator.js';
import { endSelfUpdateDrain, isSelfUpdateDraining } from '../../src/services/deploy-drain.js';
import { selfStatusCache } from '../../src/services/self-status-cache.js';
import { getRestartWait, setRestartWait } from '../../src/services/self-restart-wait.js';
import type { CdsConfig } from '../../src/types.js';
import { flushAllJsonStateStores } from '../../src/infra/state-store/json-backing-store.js';

vi.mock('node:child_process', async original => ({ ...await original<typeof import('node:child_process')>(),
  spawn: vi.fn(() => ({ on: vi.fn(), unref: vi.fn() })) }));

describe('显式排空的真实重启路由', () => {
  let dir: string, state: StateService, coordinator: BranchOperationCoordinator, shell: MockShellExecutor;
  let handler: (req: any, res: any) => Promise<void>;
  beforeEach(() => {
    vi.useFakeTimers(); vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    vi.stubEnv('CDS_SELFUPDATE_DRAIN_TIMEOUT_MS', '1');
    selfStatusCache._resetForTests(); endSelfUpdateDrain(); setRestartWait(null);
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cbd-restart-safety-'));
    const config = { repoRoot: dir, worktreeBase: dir, masterPort: 9900, workerPort: 5500,
      dockerNetwork: 'test', portStart: 10001, sharedEnv: {}, jwt: { secret: 'test', issuer: 'test' } } as CdsConfig;
    state = new StateService(path.join(dir, 'state.json'));
    vi.spyOn(state, 'flush').mockResolvedValue();
    shell = new MockShellExecutor();
    shell.addResponsePattern(/git rev-parse --abbrev-ref HEAD/, () => ({ stdout: 'codex/test', stderr: '', exitCode: 0 }));
    shell.addResponsePattern(/git rev-parse HEAD/, () => ({ stdout: 'a'.repeat(40), stderr: '', exitCode: 0 }));
    coordinator = new BranchOperationCoordinator();
    const router = createBranchRouter({ stateService: state, config, shell, branchOperationCoordinator: coordinator,
      worktreeService: new WorktreeService(shell, dir), containerService: new ContainerService(shell, config) });
    handler = router.stack.find(layer => layer.route?.path === '/self-restart')!.route.stack[0].handle;
  });
  afterEach(async () => {
    vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); vi.clearAllMocks(); vi.unstubAllEnvs();
    endSelfUpdateDrain(); setRestartWait(null); selfStatusCache._resetForTests();
    await flushAllJsonStateStores();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  async function run(body: unknown = { drainTimeoutMs: 1 }) {
    const chunks: string[] = [];
    const res = Object.assign(new EventEmitter(), { locals: {}, writableEnded: false,
      writeHead: vi.fn(), write: (s: string) => { chunks.push(s); }, end() { this.writableEnded = true; } });
    const task = handler({ body, headers: {}, socket: {}, method: 'POST', path: '/self-restart' }, res);
    await vi.advanceTimersByTimeAsync(6000); await task;
    return chunks.join('');
  }
  it.each(['branch', 'deployment', 'release', 'flush-failed', 'flush-timeout'] as const)
  ('%s 未完成时拒绝重启，不产生成功回执或停止其他任务', async cause => {
    if (cause === 'branch') coordinator.begin({ projectId: 'p', branchId: 'b', kind: 'deploy', trigger: 'manual' });
    if (cause === 'deployment') vi.spyOn(state, 'getDeploymentRuns').mockReturnValue([{ id: 'active', status: 'starting', heartbeatAt: new Date().toISOString() }] as any);
    if (cause === 'release') vi.spyOn(state, 'getReleaseRuns').mockReturnValue([{ releaseId: 'release', status: 'running', startedAt: new Date().toISOString() }] as any);
    if (cause === 'flush-failed') vi.spyOn(state, 'flush').mockRejectedValue(new Error('test flush failed'));
    if (cause === 'flush-timeout') vi.spyOn(state, 'flush').mockImplementation(() => new Promise(() => {}));
    const interrupt = vi.spyOn(coordinator, 'interruptAll');
    const text = await run();
    expect(text).toContain('event: error'); expect(text).not.toContain('event: done');
    expect(spawn).not.toHaveBeenCalled(); expect(process.exit).not.toHaveBeenCalled();
    expect(interrupt).not.toHaveBeenCalled();
    expect(isSelfUpdateDraining(Date.now())).toBe(false); expect(getRestartWait()).toBeNull();
    expect(state.getSelfUpdateHistory(1)[0]?.status).not.toBe('success');
  });
  it('已确认排空且落盘成功才安排原版本重启', async () => {
    const text = await run();
    expect(text).toContain('event: done'); expect(text).not.toContain('event: error');
    expect(spawn).toHaveBeenCalledOnce();
    expect(shell.commands.some(command => /git (checkout|reset|pull)/.test(command))).toBe(false);
  });
  it('陈旧心跳不能作为任务已终结证明，全局禁用等待也不能绕过显式安全排空', async () => {
    vi.stubEnv('CDS_SELFUPDATE_DRAIN_TIMEOUT_MS', '0');
    vi.spyOn(state, 'getDeploymentRuns').mockReturnValue([{ id: 'old', status: 'starting',
      heartbeatAt: new Date(Date.now() - 600000).toISOString() }] as any);
    const text = await run();
    expect(text).toContain('最终复核仍有'); expect(text).not.toContain('event: done');
    expect(spawn).not.toHaveBeenCalled(); expect(process.exit).not.toHaveBeenCalled();
  });
  it('落盘期间新增操作也必须在最终复核中拒绝', async () => {
    vi.mocked(state.flush).mockImplementation(async () => {
      coordinator.begin({ projectId: 'p', branchId: 'late', kind: 'restart', trigger: 'manual' });
    });
    const text = await run();
    expect(text).toContain('已拒绝重启'); expect(text).not.toContain('event: done');
    expect(spawn).not.toHaveBeenCalled(); expect(process.exit).not.toHaveBeenCalled();
  });
});
